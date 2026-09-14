/**
 * travel_intake —— 槽位收集入口（design §6 行 518 / §5.4）。
 *
 * 行为：
 * - 校验必填/日期合法/dateEnd≥dateStart/days 与日期区间一致（不一致拒）
 * - recommend 模式 destination 不计入 missing（候选推荐流程）
 * - 合理默认值 + assumptions 明示（currency=CNY/scope=total/adults=1/pace=balanced/按区间推导 days）
 * - 成功落盘 request.json（mode/status/assumptions/createdAt/updatedAt）
 * - nextQuestions 一次最多 2~3 问
 * - 带 planId 重入 = 更新既有计划（合并 + 保持 createdAt）
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RequestStatus, Slots, TravelMode, TravelRequest } from '../models/types.js'
import {
  assertValidIssues, computeRequiredMissing, detectSlotAmbiguities,
  validateDaysConsistency, validateSlotsFields,
} from '../models/validate.js'
import { TravelStore, generatePlanId } from '../store/store.js'
import { cardLines, pickSlots, summarizeSlots, textCard, toCanonicalJson, TOOL_TIMEOUT_MS } from './common.js'
import { applySlotDefaults, buildNextQuestions, ensureInterestSeed, mergeSlotPatch, resolveRequestStatus } from './slot-logic.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 领域参数（纯逻辑面）。 */
export interface IntakeArgs {
  planId?: string
  mode?: TravelMode
  slots: Slots
}

/** 工具返回（§6 行 518：…+assumptions（FR-2 详 6 的明示通道，兼容扩展））。 */
export interface IntakeResult {
  planId: string
  mode: TravelMode
  status: RequestStatus
  missing: string[]
  ambiguity: string[]
  confirmedSlots: Slots
  nextQuestions: string[]
  assumptions: string[]
}

/** 内部完整结果（含落盘请求体，供 get_state/update/测试复用）。 */
export interface IntakeOutcome extends IntakeResult {
  request: TravelRequest
  /** 是否新建计划（false = 更新既有）。 */
  created: boolean
}

/** 归一化 + 校验（默认值 → 字段校验 → 天数一致性；违规抛 TravelValidationError）。 */
export function normalizeAndValidateSlots(raw: Slots): { slots: Slots; assumptions: string[] } {
  const { slots, assumptions } = applySlotDefaults(raw)
  assertValidIssues([
    ...validateSlotsFields(slots),
    ...validateDaysConsistency(slots),
  ])
  return { slots, assumptions }
}

const INTAKE_PARAMETERS = {
  planId: {
    type: 'string',
    description: '已有计划 ID（缺省新建；提供则更新既有计划，未补槽位保留原值）',
  } as const,
  mode: {
    type: 'string',
    enum: ['plan', 'recommend'],
    description: 'plan=目的地已知规划；recommend=目的地推荐（destination 留空）',
  } as const,
  slots: {
    type: 'object',
    additionalProperties: true,
    properties: {
      origin: { type: 'string', description: '出发地（城市名）' },
      destination: { type: 'string', description: '目的地（plan 模式必填；recommend 模式留空）' },
      dateStart: { type: 'string', description: '出发日期 YYYY-MM-DD' },
      dateEnd: { type: 'string', description: '返程日期 YYYY-MM-DD（不得早于 dateStart）' },
      days: { type: 'integer', description: '行程天数（须与日期区间一致）' },
      travelers: {
        type: 'object', additionalProperties: true,
        properties: {
          adults: { type: 'integer', description: '成人（≥1，缺省 1）' },
          children: { type: 'integer', description: '儿童（≥0）' },
          seniors: { type: 'integer', description: '老人（≥0）' },
        },
      },
      budget: {
        type: 'object', additionalProperties: true,
        properties: {
          amount: { type: 'number', description: '预算金额' },
          currency: { type: 'string', description: '币种（缺省 CNY）' },
          scope: { type: 'string', enum: ['total', 'perPerson'], description: '预算口径（缺省 total）' },
        },
      },
      preferences: {
        type: 'object', additionalProperties: true,
        properties: {
          pace: { type: 'string', enum: ['relaxed', 'balanced', 'intensive'], description: '节奏（缺省 balanced）' },
          themes: { type: 'array', items: { type: 'string' }, description: '景点类型偏好' },
          diet: { type: 'array', items: { type: 'string' }, description: '饮食偏好' },
        },
      },
      constraints: { type: 'array', items: { type: 'string' }, description: '特殊约束' },
      researchIntent: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: '用户原始旅行主题（草稿 A：兴趣与地理分离；存在时 destination 可缺省）' },
          keywords: { type: 'array', items: { type: 'string' }, description: '发现词组（≤6 条，1-100 字符，去重保序）' },
          regionHints: { type: 'array', items: { type: 'string' }, description: '明确地域约束（≤20 个）' },
        },
        description: '兴趣主题与地理约束（W0 T1）',
      },
    },
    required: true,
  } as const,
} as const

type IntakeParams = InferArgs<typeof INTAKE_PARAMETERS>

export const INTAKE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    mode: { type: 'string', enum: ['plan', 'recommend'], required: true },
    status: { type: 'string', required: true, description: '七态之一（intake 只会到 collecting/recommending/confirmed）' },
    missing: { type: 'array', items: { type: 'string' }, required: true },
    ambiguity: { type: 'array', items: { type: 'string' }, required: true },
    confirmedSlots: { type: 'json', required: true },
    nextQuestions: { type: 'array', items: { type: 'string' }, required: true },
    assumptions: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

type IntakeOutput = InferValue<typeof INTAKE_OUTPUT_SCHEMA>

/** 纯逻辑（测试直调；store 注入便于隔离）。 */
export async function runIntake(args: IntakeArgs, store: TravelStore): Promise<IntakeOutcome> {
  // 计划级在途锁（C 期接线 F4-C5）：新建/更新写 request.json 须串行化，
  // 同一 planId 并发任务排队接替，杜绝读改写交错。
  const planId = args.planId ?? generatePlanId()
  return store.withPlanLock(planId, async () => {
    const mode: TravelMode = args.mode ?? 'plan'

    // 带 planId 重入 = 更新既有计划：新槽位与既有槽位合并（未补字段保留原值）
    const existing = args.planId !== undefined ? await store.loadRequest(args.planId) : undefined
    const rawSlots = existing !== undefined ? mergeSlotPatch(existing.slots, args.slots) : args.slots

    // W0 T1（草稿 A）：无 researchIntent 的 destination-only → 映射兼容兴趣种子并显式记录
    const seeded = ensureInterestSeed(rawSlots)
    const { slots, assumptions } = normalizeAndValidateSlots(seeded.slots)
    const seedAssumptions = seeded.assumptions.filter((a) => !assumptions.includes(a))

    const missing = computeRequiredMissing(slots, mode)
    const ambiguityIssues = detectSlotAmbiguities(slots)
    const ambiguity = ambiguityIssues.map((i) => `${i.path}: ${i.message}`)
    const status = resolveRequestStatus(slots, mode, missing)
    const nextQuestions = buildNextQuestions(missing, ambiguityIssues, mode)

    const now = new Date().toISOString()
    const allAssumptions = [...assumptions, ...seedAssumptions]
    // 新信封（草稿 F/F4-C1 + F1c-E 决策 5 修正）：新 mode=plan 由 destination 或
    // researchIntent 任一驱动（含 destination 映射的兴趣种子）达到 confirmed → 一律写
    // flowVersion='1' 供上游全文门读取（advice/transport 据此走逐地归属与 places 门）。
    // destination-only 映射种子同样受串行门约束（不再被当作 legacy 单点套轻量路径）；
    // recommend 模式不进入完整串行链（保持 legacy）；legacy 判定=缺 flowVersion——
    // 旧计划（已存在且无 flowVersion）不补写（update 分支保留原值，避免把既有轻量
    // 单点/旧计划浏览导出静默改造成受门对象）。
    const mappedSeed = rawSlots.researchIntent === undefined && seeded.slots.researchIntent !== undefined
    const desiredFlow = status === 'confirmed' && mode === 'plan' && seeded.slots.researchIntent !== undefined
      ? '1'
      : undefined
    // 映射种子走门的假设显式记录（决策 5：新 plan 一律受串行门约束）
    if (desiredFlow === '1' && mappedSeed) {
      allAssumptions.push(`destination「${slots.destination ?? ''}」映射的兴趣种子将受串行门约束（新 plan 一律走完整串行链）`)
    }
    let request: TravelRequest
    let created: boolean

    if (existing !== undefined) {
      created = false
      const mergedAssumptions = existing.assumptions
        .concat(allAssumptions.filter((a) => !existing.assumptions.includes(a)))
      request = {
        planId,
        mode,
        status,
        slots,
        assumptions: mergedAssumptions,
        createdAt: existing.createdAt,
        updatedAt: now,
        // 不补写旧计划：已存在的 confirmed legacy（无 flowVersion）保持原值；
        // 未成形（collecting/recommending）补全达 confirmed 时按 desiredFlow 落新信封
        flowVersion: existing.flowVersion ?? (existing.status === 'confirmed' ? undefined : desiredFlow),
      }
    } else {
      created = true
      request = {
        planId,
        mode,
        status,
        slots,
        assumptions: allAssumptions,
        createdAt: now,
        updatedAt: now,
        flowVersion: desiredFlow,
      }
    }

    await store.saveRequest(request)
    return {
      planId,
      mode,
      status,
      missing,
      ambiguity,
      confirmedSlots: slots,
      nextQuestions,
      assumptions: request.assumptions,
      request,
      created,
    }
  })
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectIntake(o: IntakeOutcome): IntakeOutput {
  return {
    planId: o.planId,
    mode: o.mode,
    status: o.status,
    missing: [...o.missing],
    ambiguity: [...o.ambiguity],
    confirmedSlots: toCanonicalJson(o.confirmedSlots),
    nextQuestions: [...o.nextQuestions],
    assumptions: [...o.assumptions],
  }
}

function renderIntake(args: IntakeParams, value: IntakeOutput): ContentBlock[] {
  const lines: [string, string][] = [
    ['planId', value.planId],
    ['模式', value.mode === 'recommend' ? '目的地推荐' : '行程规划'],
    ['状态', value.status],
    ['已确认槽位', summarizeSlots(value.confirmedSlots)],
  ]
  if (value.missing.length > 0) lines.push(['待补齐', value.missing.join(', ')])
  if (value.ambiguity.length > 0) lines.push(['需澄清', value.ambiguity.join('；')])
  if (value.assumptions.length > 0) lines.push(['默认假设', value.assumptions.join('；')])
  if (value.nextQuestions.length > 0) lines.push(['下步问题', value.nextQuestions.map((q, i) => `${i + 1}. ${q}`).join(' ')])

  let text = `**travel_intake** · 槽位收集\n${cardLines(lines)}`
  if (args.planId !== undefined) text += '\n> （更新既有计划）'
  return textCard(text)
}

/** 工具定义工厂（store 注入；index.ts 注册时传入默认根 store）。 */
export function createTravelIntakeTool(store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_intake',
    description: '旅行规划槽位收集：校验并落盘 TravelRequest（含默认值+assumptions、日期与天数一致性、recommend 模式目的地放宽）。返回缺失槽位与追问。',
    parameters: INTAKE_PARAMETERS,
    output: {
      schema: INTAKE_OUTPUT_SCHEMA,
      render: renderIntake,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args) {
      const outcome = await runIntake({
        planId: args.planId,
        mode: args.mode,
        slots: pickSlots(args.slots),
      }, store)
      return projectIntake(outcome)
    },
  })
}