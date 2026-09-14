/**
 * travel_update_request —— 槽位修订 / 推荐模式选定目的地回注（design §6 行 525 / §5.4）。
 *
 * - patch 合并（未补字段保留原值；travelers/budget/preferences 一级深合并）
 * - 状态推进受七态状态机约束（§5.4）：recommending 回注目的地 → collecting →
 *   confirmed；delivered 修订入口 → revising；researching 仍为锁定态；generating
 *   在无外部在途任务时允许修订 → revising，有在途任务则拒绝（抛 InvalidTransitionError，
 *   非法转换明确报错）
 * - rerunHints：按变更维度推导需重跑的研究/生成项（§7 项 7；旧字段，语义不变）
 * - revisionPlan：M3.1 lossless 选择性重跑计划（固定影响表 + draft-only 标记 +
 *   不受影响集合；update 本身确定性、零网络研究，仅产出计划供编排层执行）
 * - 计划不存在 → 明确 not-found 返回（不抛崩溃）
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { RequestStatus, Slots, TravelRequest } from '../models/types.js'
import { computeRequiredMissing, detectSlotAmbiguities, isNonEmptyString } from '../models/validate.js'
import { InvalidTransitionError } from '../errors.js'
import { TravelStore } from '../store/store.js'
import { assertTransition, assertTransitionEx } from '../store/state.js'
import { cardLines, asRecord, pickSlots, summarizeSlots, textCard, toCanonicalJson, TOOL_TIMEOUT_MS } from './common.js'
import {
  buildNextQuestions, mergeSlotPatch, rerunHintsFor, resolveRequestStatus, slotsChanged,
} from './slot-logic.js'
import { classifyRevision, REVISION_ACTIONS, selectiveRerunPlan, type RevisionPlan } from './revision.js'
import { normalizeAndValidateSlots } from './intake.js'

/** 领域参数。 */
export interface UpdateArgs {
  planId: string
  patch: { slots: Partial<Slots> }
}

/** 工具返回（同 intake + rerunHints + revisionPlan；found=false 为 not-found）。 */
export interface UpdateResult {
  planId: string
  mode: 'plan' | 'recommend'
  status: RequestStatus | 'not_found'
  missing: string[]
  ambiguity: string[]
  confirmedSlots: Slots
  nextQuestions: string[]
  assumptions: string[]
  /** 旧字段（向后兼容）：按变更维度推导的重跑提示，语义同 M2（slot-logic.rerunHintsFor）。 */
  rerunHints: string[]
  /** M3.1 选择性重跑计划（lossless 投影；编排层只执行 affected 内 action）。 */
  revisionPlan: RevisionPlan
  /** false = 计划不存在（not-found，非崩溃）。 */
  found: boolean
}

const UPDATE_PARAMETERS = {
  planId: {
    type: 'string',
    required: true,
    description: '计划 ID（必填；不存在时明确返回 not_found）',
  } as const,
  patch: {
    type: 'object',
    additionalProperties: true,
    properties: {
      slots: {
        type: 'object',
        additionalProperties: true,
        properties: {
          origin: { type: 'string' },
          destination: { type: 'string', description: '推荐模式选定候选后回注' },
          dateStart: { type: 'string' },
          dateEnd: { type: 'string' },
          days: { type: 'integer' },
          travelers: { type: 'object', additionalProperties: true, properties: { adults: { type: 'integer' }, children: { type: 'integer' }, seniors: { type: 'integer' } } },
          budget: { type: 'object', additionalProperties: true, properties: { amount: { type: 'number' }, currency: { type: 'string' }, scope: { type: 'string' } } },
          preferences: { type: 'object', additionalProperties: true, properties: { pace: { type: 'string' }, themes: { type: 'array', items: { type: 'string' } }, diet: { type: 'array', items: { type: 'string' } } } },
          constraints: { type: 'array', items: { type: 'string' } },
        },
        required: true,
        description: '槽位补丁（未补字段保留原值）',
      },
    },
    required: true,
  } as const,
} as const

type UpdateParams = InferArgs<typeof UPDATE_PARAMETERS>

export const UPDATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    mode: { type: 'string', required: true },
    status: { type: 'string', required: true },
    found: { type: 'boolean', required: true },
    missing: { type: 'array', items: { type: 'string' }, required: true },
    ambiguity: { type: 'array', items: { type: 'string' }, required: true },
    confirmedSlots: { type: 'json', required: true },
    nextQuestions: { type: 'array', items: { type: 'string' }, required: true },
    assumptions: { type: 'array', items: { type: 'string' }, required: true },
    rerunHints: { type: 'array', items: { type: 'string' }, required: true },
    revisionPlan: { type: 'json', required: true },
  },
} as const

type UpdateOutput = InferValue<typeof UPDATE_OUTPUT_SCHEMA>

/** 锁定态（researching 始终拒绝；generating 仅在外部在途任务占用时拒绝）。 */
export const LOCKED_STATUSES: readonly RequestStatus[] = ['researching', 'generating']

function notFoundResult(planId: string): UpdateResult {
  return {
    planId,
    found: false,
    mode: 'plan',
    status: 'not_found',
    missing: [],
    ambiguity: [],
    confirmedSlots: {},
    nextQuestions: [],
    assumptions: [],
    rerunHints: [],
    revisionPlan: { planId, bySlot: [], draftOnly: false, affected: [], unaffected: [...REVISION_ACTIONS] },
  }
}

/** 纯逻辑（测试直调）。 */
export async function runUpdate(args: UpdateArgs, store: TravelStore): Promise<UpdateResult> {
  // 计划级在途锁（C 期接线 F4-C5）：request.json 修改写串行化。
  // isLocked 分支的 inFlight 语义须反映「进入本工具前」的真实在途占用（外部并发任务、
  // 而非本工具自己刚取的锁），故在加锁前取快照传入。
  const inFlightSnapshot = store.isPlanLocked(args.planId)
  return store.withPlanLock(args.planId, () => runUpdateUnlocked(args, store, inFlightSnapshot))
}

async function runUpdateUnlocked(args: UpdateArgs, store: TravelStore, inFlightSnapshot: boolean): Promise<UpdateResult> {
  const existing = await store.loadRequest(args.planId)
  if (existing === undefined) return notFoundResult(args.planId)

  const rawMerged = mergeSlotPatch(existing.slots, args.patch.slots)
  const { slots, assumptions } = normalizeAndValidateSlots(rawMerged)
  const missing = computeRequiredMissing(slots, existing.mode)
  const ambiguityIssues = detectSlotAmbiguities(slots)
  const ambiguity = ambiguityIssues.map((i) => `${i.path}: ${i.message}`)
  const computed = resolveRequestStatus(slots, existing.mode, missing)
  const nextQuestions = buildNextQuestions(missing, ambiguityIssues, existing.mode)

  const changes = slotsChanged(existing.slots, slots)

  // ── 状态推进（状态机约束） ──
  // W0 T3（草稿 F）：researching 始终拒绝修改；generating 仅在进入工具前已有
  // 外部计划锁时拒绝。无外部在途时由 assertTransitionEx 接通 generating→revising，
  // 不把本工具自己刚取得的锁误判为在途。
  if (isLocked(existing.status, inFlightSnapshot)) {
    const detail = inFlightSnapshot
      ? `${existing.status} 为锁定态（在途任务占用），拒绝修改输入；请等待完成，或待取消/完成后可改`
      : `${existing.status} 为锁定态（检索中），拒绝槽位变更；请等待该阶段完成，或重新 travel_intake 规划`
    throw new InvalidTransitionError(existing.status, computed, detail)
  }

  let status: RequestStatus
  if (existing.status === 'generating') {
    if (changes.some((c) => c !== 'none')) {
      assertTransitionEx('generating', 'revising', inFlightSnapshot)
      status = 'revising'
    } else {
      status = 'generating'
    }
  } else if (existing.status === 'delivered') {
    const material = changes.some((c) => c !== 'none')
    if (material) {
      assertTransition('delivered', 'revising')
      status = 'revising'
    } else {
      status = 'delivered' // 空补丁：无变更
    }
  } else if (existing.status === 'revising') {
    status = 'revising' // 修订中：槽位刷新，等待 research/build 驱动 → generating
  } else if (existing.status === 'confirmed') {
    // confirmed：已确认（可检索）状态。槽位完整刷新 → self 保持 + rerunHints
    // 指引重跑受影响项；出现缺失 → 拒绝回退（confirmed→collecting 非法）
    if (missing.length > 0) {
      throw new InvalidTransitionError(
        'confirmed',
        'collecting',
        'confirmed 为已确认状态，不允许回退补齐（confirmed→collecting 非法）；请直接更新完整的取值',
      )
    }
    status = 'confirmed'
  } else {
    // collecting / recommending
    if (existing.status === 'recommending' && isNonEmptyString(slots.destination)) {
      assertTransition('recommending', 'collecting') // 选定候选回注 → 补齐其余槽位
      status = 'collecting'
    } else {
      status = existing.status
    }
    if (missing.length === 0 && status !== 'recommending') {
      assertTransition(status, 'confirmed')
      status = 'confirmed'
    }
  }

  const now = new Date().toISOString()
  const request: TravelRequest = {
    ...existing,
    status,
    slots,
    assumptions: existing.assumptions.concat(assumptions.filter((a) => !existing.assumptions.includes(a))),
    updatedAt: now,
  }
  await store.saveRequest(request)

  // M3.1 选择性重跑计划（纯派生）：固定影响表 + draft-only 标记 + 不受影响集合。
  // update 本身零网络研究——编排层只执行 plan.affected 中的 action。
  const impact = classifyRevision(existing.slots, slots)
  const revisionPlan = selectiveRerunPlan(request.planId, impact)

  return {
    planId: request.planId,
    mode: request.mode,
    status,
    missing,
    ambiguity,
    confirmedSlots: slots,
    nextQuestions,
    assumptions: request.assumptions,
    rerunHints: rerunHintsFor(changes),
    revisionPlan,
    found: true,
  }
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectUpdate(r: UpdateResult): UpdateOutput {
  return {
    planId: r.planId,
    mode: r.mode,
    status: r.status,
    found: r.found,
    missing: [...r.missing],
    ambiguity: [...r.ambiguity],
    confirmedSlots: toCanonicalJson(r.confirmedSlots),
    nextQuestions: [...r.nextQuestions],
    assumptions: [...r.assumptions],
    rerunHints: [...r.rerunHints],
    revisionPlan: toCanonicalJson(r.revisionPlan),
  }
}

function isLocked(status: RequestStatus, inFlightSnapshot: boolean): boolean {
  if (status === 'generating') return inFlightSnapshot
  return (LOCKED_STATUSES as readonly RequestStatus[]).includes(status)
}

/** revisionPlan（canonical JsonValue）→ 卡片摘要行（运行时窄化，零强转）。 */
function revisionPlanLines(plan: unknown): [string, string][] {
  const rec = asRecord(plan)
  const affected = Array.isArray(rec.affected) ? rec.affected.filter((v): v is string => typeof v === 'string') : []
  const unaffected = Array.isArray(rec.unaffected) ? rec.unaffected.filter((v): v is string => typeof v === 'string') : []
  const lines: [string, string][] = [
    ['修订计划', rec.draftOnly === true ? 'draft-only（仅 build/render，不触发研究）' : affected.join(' → ') || '（无）'],
  ]
  if (unaffected.length > 0) lines.push(['保留不动', unaffected.join(', ')])
  return lines
}

function renderUpdate(args: UpdateParams, value: UpdateOutput): ContentBlock[] {
  if (!value.found) {
    return textCard(
      `**travel_update_request** · 计划未找到\n${cardLines([
        ['planId', args.planId],
        ['状态', 'not_found'],
        ['提示', '请先 travel_intake 创建计划'],
      ])}`,
    )
  }
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
  if (value.rerunHints.length > 0) lines.push(['需重跑', value.rerunHints.join(', ')])
  lines.push(...revisionPlanLines(value.revisionPlan))
  return textCard(`**travel_update_request** · 槽位修订\n${cardLines(lines)}`)
}

/** 工具定义工厂。 */
export function createTravelUpdateTool(store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_update_request',
    description: '修订旅行计划槽位（patch 合并，未补字段保留原值）：推荐模式回注候选目的地、修订日期/人数/预算等；返回缺失槽位、追问、需重跑的研究项（rerunHints，旧字段）与选择性重跑计划 revisionPlan（M3.1：按固定影响表列出受影响 action 与不受影响集合；draft-only 修订仅 build/render）。本工具不发起网络研究，编排层按 revisionPlan.affected 执行。',
    parameters: UPDATE_PARAMETERS,
    output: {
      schema: UPDATE_OUTPUT_SCHEMA,
      render: renderUpdate,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args) {
      const result = await runUpdate({
        planId: args.planId,
        patch: { slots: pickSlots(args.patch.slots) },
      }, store)
      return projectUpdate(result)
    },
  })
}