/**
 * travel_get_state —— 进度与产物查询（design §6 行 524 / NFR-9）。
 *
 * planId 缺省 → 定位最近更新计划；不存在/无计划 → 明确 not-found 返回
 * （不抛崩溃）：{ found:false, status:'not_found' }。
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { DegradedEntry } from '../adapters/base.js'
import type { CostArtifact, RentalQuotesArtifact, RequestStatus, ResearchRound, ResearchState, Slots } from '../models/types.js'
import { TravelStore } from '../store/store.js'
import { cardLines, summarizeSlots, textCard, toCanonicalJson, TOOL_TIMEOUT_MS } from './common.js'
import { computeResearchStatus, type ResearchStatus } from './research-assessment.js'
import { researchGate, type GateBlocked } from './gates.js'
import type { ArtifactReadState } from '../store/store.js'

/** unknown 只读兼容；失败/空结果/hash 失配不进入摘要消费。 */
function readableArtifact<T>(state: ArtifactReadState<T>): T | undefined {
  if (!state.found || state.data === undefined || state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

function isUnaccounted<T>(state: ArtifactReadState<T>): boolean {
  return state.status === 'unknown'
    || (state.status === 'stale' && state.staleReason === 'not_in_commit')
}

/** 领域参数。 */
/** 研究视图的正文条目摘要（W4 T16②：仅索引，不返回全文正文——正文经 read 分页）。 */
export interface ResearchViewItem {
  itemId: string
  roundId: string
  title: string
  /** 新并入条目对应的首个 raw observation provenance（保持裸 itemId/contentRef 不变）。 */
  provenanceKey?: string
  contentRef?: string
  contentVersion?: string
  /** 页面/展示分级：title(标题级)|fetched(已取正文)|partial(部分正文)|failed(抓取失败)。 */
  grade: 'title' | 'fetched' | 'partial' | 'failed'
}

/** 研究视图的轮次摘要（W4 T16②：仅摘要字段，不含整篇原文/正文）。 */
export interface ResearchViewRound {
  roundId: string
  initiator: ResearchRound['initiator']
  researchVersion: number
  observedAt: string
  keywords: string[]
  newItemIds: string[]
  failures: ResearchRound['failures']
}

/** research-state.json 的当前 assessment 摘要（W4 T16②：含过期状态；DR4 增补计数摘要）。 */
export interface ResearchViewAssessment {
  assessmentId: string
  status: 'sufficient' | 'continue' | 'insufficient'
  researchVersion: number
  recordedAt: string
  /** 过期：引用的研究版本 ≠ 当前 researchVersion（新证据已使旧判断失效）。 */
  stale: boolean
  /** DR4：gaps/findings/conflicts/requirements 计数摘要（不含正文全文；缺省未填时省略）。 */
  findingsCount?: number
  gapsCount?: number
  conflictsCount?: number
  requirementsCount?: number
}

/** 研究视图（W4 T16②：researchVersion/轮次/候选与正文索引/当前 assessment/失败与预算/恢复动作；不一次返回全部原文）。 */
export interface ResearchView {
  researchVersion: number
  /** 当前 research 是否就绪（sufficient 且当前版本且预算未耗尽）。 */
  ready: boolean
  /** 未就绪原因（no_sufficient_assessment|stale_version|budget_exhausted；就绪时无）。 */
  notReadyReason?: ResearchStatus['missing']
  /** 恢复动作（门未放行时的 nextAction）。 */
  nextAction?: string
  assessment?: ResearchViewAssessment
  budget: { usedRounds: number; maxRoundsPerPlan: number; remainingRounds: number; exhausted: boolean }
  rounds: ResearchViewRound[]
  /** 候选与正文索引（标题级/已取/部分/失败分级；不含正文全文）。 */
  items: ResearchViewItem[]
  /** 本计划的失败/降级明细（研究轮次失败 + 既有 degraded）。 */
  failures: Array<{ code: string; reason: string }>
  /**
   * DR2：research-state 抓取失败索引摘要（count/最近一条/恢复动作）。
   * 有持久化抓取失败时给出（重试成功的失败记录会被自动清除）；无失败时缺省。
   */
  fetchFailures?: { count: number; recent?: { itemId: string; code: string; reason: string; at: string }; recovery: string }
}

export interface GetStateArgs {
  planId?: string
}

export interface QuoteCostStateSummary {
  rentalQuotes?: { quoted: number; records: number; consultationOnly: true }
  cost?: { min: number; max: number; currency: string; warnings: string[] }
}

export interface GetStateResult extends QuoteCostStateSummary {
  planId: string
  /** false = 计划不存在（not-found，非崩溃）。 */
  found: boolean
  status: RequestStatus | 'not_found'
  slots?: Slots
  /** 计划目录内产物（request.json + known artifacts）。 */
  artifacts: string[]
  /** round3 manifest 对每个已知工件的只读状态投影。 */
  artifactStatus?: Record<string, {
    state: 'current' | 'stale' | 'unknown' | 'failed' | 'empty' | 'missing'
    staleReason?: string
  }>
  degraded: DegradedEntry[]
  updatedAt?: string
  /** W4 T16② 研究视图（研究计划时呈现；轻量/legacy 计划无此字段）。 */
  research?: ResearchView
}

const GET_STATE_PARAMETERS = {
  planId: {
    type: 'string',
    description: '计划 ID；缺省自动定位最近更新的计划',
  } as const,
} as const

type GetStateParams = InferArgs<typeof GET_STATE_PARAMETERS>

export const GET_STATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    found: { type: 'boolean', required: true },
    status: { type: 'string', required: true },
    slots: { type: 'json' },
    artifacts: { type: 'array', items: { type: 'string' }, required: true },
    /** map-shaped status is deliberately opaque JSON to preserve arbitrary artifact names. */
    artifactStatus: { type: 'json' },
    degraded: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          code: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          at: { type: 'string', required: true },
          candidateId: { type: 'string' },
          placeId: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    },
    updatedAt: { type: 'string' },
    rentalQuotes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoted: { type: 'integer', required: true },
        records: { type: 'integer', required: true },
        consultationOnly: { type: 'boolean', required: true },
      },
    },
    cost: {
      type: 'object',
      additionalProperties: false,
      properties: {
        min: { type: 'number', required: true },
        max: { type: 'number', required: true },
        currency: { type: 'string', required: true },
        warnings: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    research: {
      type: 'object',
      additionalProperties: false,
      properties: {
        researchVersion: { type: 'integer', required: true },
        ready: { type: 'boolean', required: true },
        notReadyReason: { type: 'string' },
        nextAction: { type: 'string' },
        assessment: {
          type: 'object',
          additionalProperties: false,
          properties: {
            assessmentId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            researchVersion: { type: 'integer', required: true },
            recordedAt: { type: 'string', required: true },
            stale: { type: 'boolean', required: true },
            findingsCount: { type: 'integer' },
            gapsCount: { type: 'integer' },
            conflictsCount: { type: 'integer' },
            requirementsCount: { type: 'integer' },
          },
        },
        budget: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usedRounds: { type: 'integer', required: true },
            maxRoundsPerPlan: { type: 'integer', required: true },
            remainingRounds: { type: 'integer', required: true },
            exhausted: { type: 'boolean', required: true },
          },
          required: true,
        },
        rounds: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              roundId: { type: 'string', required: true },
              initiator: { type: 'string', required: true },
              researchVersion: { type: 'integer', required: true },
              observedAt: { type: 'string', required: true },
              keywords: { type: 'array', items: { type: 'string' }, required: true },
              newItemIds: { type: 'array', items: { type: 'string' }, required: true },
              failures: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    code: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        },
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              itemId: { type: 'string', required: true },
              roundId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              provenanceKey: { type: 'string' },
              contentRef: { type: 'string' },
              contentVersion: { type: 'string' },
              grade: { type: 'string', enum: ['title', 'fetched', 'partial', 'failed'], required: true },
            },
          },
        },
        failures: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
        fetchFailures: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            recent: {
              type: 'object',
              additionalProperties: false,
              properties: {
                itemId: { type: 'string', required: true },
                code: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
            recovery: { type: 'string', required: true },
          },
        },
      },
    },
  },
} as const

type GetStateOutput = InferValue<typeof GET_STATE_OUTPUT_SCHEMA>

/** 正文分级：contentStatus → 展示 grade（草稿 G/177：标题级/已取正文/部分正文/失败）。 */
function gradeOf(status: string | undefined, truncated: boolean | undefined): ResearchViewItem['grade'] {
  switch (status) {
    case 'extracted': return truncated === true ? 'partial' : 'fetched'
    case 'partial': return 'partial'
    case 'unavailable': return 'failed'
    default: return 'title'
  }
}

/** 组装研究视图（W4 T16②：仅索引/摘要/门状态；正文全文经 travel_read_research_content 分页取）。 */
async function buildResearchView(store: TravelStore, planId: string, degraded: DegradedEntry[]): Promise<ResearchView | undefined> {
  const state = await store.loadResearchState<ResearchState>(planId)
  if (state === undefined) return undefined
  const researchStatus = await computeResearchStatus(store, planId)
  const gate: GateBlocked | undefined = await researchGate(store, planId)

  // 轮次摘要（只读 roundId 列表逐轮 load；摘要字段，不含正文）
  const rounds: ResearchViewRound[] = []
  for (const roundId of state.rounds) {
    const round = await store.readResearchRound<ResearchRound>(planId, roundId)
    if (round === undefined) continue
    rounds.push({
      roundId: round.roundId,
      initiator: round.initiator,
      researchVersion: round.researchVersion,
      observedAt: round.observedAt,
      keywords: [...round.query.keywords],
      newItemIds: [...round.newItemIds],
      failures: [...round.failures],
    })
  }

  // 候选与正文索引：research-state.itemIndex + 逐条正文状态（不读全文）
  const items: ResearchViewItem[] = []
  for (const idx of state.itemIndex ?? []) {
    let status: string | undefined
    let truncated: boolean | undefined
    if (idx.contentRef !== undefined && idx.contentVersion !== undefined) {
      const content = await store.readResearchContent<{ contentStatus?: string; truncated?: boolean }>(
        planId, idx.contentRef, idx.contentVersion,
      )
      status = content?.contentStatus
      truncated = content?.truncated
    }
    items.push({
      itemId: idx.itemId,
      roundId: idx.roundId,
      title: idx.title,
      ...(idx.provenanceKey !== undefined ? { provenanceKey: idx.provenanceKey } : {}),
      ...(idx.contentRef !== undefined ? { contentRef: idx.contentRef } : {}),
      ...(idx.contentVersion !== undefined ? { contentVersion: idx.contentVersion } : {}),
      grade: gradeOf(status, truncated),
    })
  }

  const failures: Array<{ code: string; reason: string }> = []
  for (const round of rounds) {
    for (const f of round.failures) failures.push({ code: f.code, reason: f.reason })
  }
  for (const d of degraded) failures.push({ code: d.code, reason: d.reason })

  // DR2：research-state 持久化抓取失败索引消费（count/最近一条/恢复动作）。
  // 重试成功（同 itemId 正文获取成功）会被 research-content 自动清除——此处如实投影
  // 仍存的失败；无失败 → 缺省（页面/编排不显示空失败面板）。
  const persistedFetchFailures = state.fetchFailures ?? []
  const fetchFailuresView: ResearchView['fetchFailures'] = persistedFetchFailures.length > 0
    ? {
        count: persistedFetchFailures.length,
        recent: persistedFetchFailures[persistedFetchFailures.length - 1],
        recovery: '对该条目重新调用 travel_research_content 抓取成功（同 itemId）后该失败记录自动清除；或调整网络/渠道后重试',
      }
    : undefined

  const assessment: ResearchViewAssessment | undefined = state.assessment === undefined
    ? undefined
    : await (async () => {
      const base: ResearchViewAssessment = {
        assessmentId: state.assessment!.assessmentId,
        status: state.assessment!.status,
        researchVersion: state.assessment!.researchVersion,
        recordedAt: state.assessment!.recordedAt,
        stale: state.assessment!.researchVersion !== state.researchVersion,
      }
      // DR4：从 assessment 快照取 gaps/findings/conflicts 计数摘要（不返回全文/正文），
      // 供页面/编排诚实呈现「上次充分性判定的覆盖与缺口规模」。
      const file = await store.readResearchAssessment<{
        findings?: unknown[]; gaps?: unknown[]; conflicts?: unknown[]; requirements?: unknown[]
      }>(planId, state.assessment!.assessmentId)
      if (file !== undefined) {
        return {
          ...base,
          ...(file.findings !== undefined ? { findingsCount: file.findings.length } : {}),
          ...(file.gaps !== undefined ? { gapsCount: file.gaps.length } : {}),
          ...(file.conflicts !== undefined ? { conflictsCount: file.conflicts.length } : {}),
          ...(file.requirements !== undefined ? { requirementsCount: file.requirements.length } : {}),
        }
      }
      return base
    })()

  return {
    researchVersion: state.researchVersion,
    ready: researchStatus.ready,
    ...(researchStatus.missing !== undefined ? { notReadyReason: researchStatus.missing } : {}),
    ...(gate !== undefined ? { nextAction: gate.nextAction } : {}),
    ...(assessment !== undefined ? { assessment } : {}),
    budget: {
      usedRounds: state.budget.usedRounds,
      maxRoundsPerPlan: state.budget.maxRoundsPerPlan,
      remainingRounds: Math.max(0, state.budget.maxRoundsPerPlan - state.budget.usedRounds),
      exhausted: state.budget.exhausted,
    },
    rounds,
    items,
    failures,
    ...(fetchFailuresView !== undefined ? { fetchFailures: fetchFailuresView } : {}),
  }
}

/** 纯逻辑（测试直调）。 */
export async function runGetState(args: GetStateArgs, store: TravelStore): Promise<GetStateResult> {
  let planId = args.planId
  if (planId === undefined || planId.trim() === '') {
    const latest = await store.findLatestPlan()
    if (latest === undefined) {
      return { planId: '', found: false, status: 'not_found', artifacts: [], degraded: [] }
    }
    planId = latest.planId
  }

  const request = await store.loadRequest(planId)
  if (request === undefined) {
    return { planId, found: false, status: 'not_found', artifacts: [], degraded: [] }
  }

  const artifacts = await store.listArtifacts(planId)
  const degraded = await store.loadDegraded(planId) ?? []
  const artifactStatus: NonNullable<GetStateResult['artifactStatus']> = {}
  for (const name of artifacts) {
    if (name === 'request.json') continue
    const state = await store.readArtifactWithState(planId, name)
    artifactStatus[name] = {
      state: state.status,
      ...(state.staleReason !== undefined ? { staleReason: state.staleReason } : {}),
    }
  }
  const rentalState = await store.readArtifactWithState<RentalQuotesArtifact>(planId, 'rental-quotes.json')
  const rental = readableArtifact(rentalState)
  const costState = await store.readArtifactWithState<CostArtifact>(planId, 'cost.json')
  const cost = readableArtifact(costState)
  if (isUnaccounted(rentalState) && rental !== undefined) {
    degraded.push({
      source: 'state/rental-quotes', code: 'UNAVAILABLE',
      reason: `rental-quotes.json 未入账（${rentalState.status}/${rentalState.staleReason ?? 'unknown'}），状态摘要仅只读兼容消费`, at: new Date().toISOString(),
    })
  }
  if (isUnaccounted(costState) && cost !== undefined) {
    degraded.push({
      source: 'state/cost', code: 'UNAVAILABLE',
      reason: `cost.json 未入账（${costState.status}/${costState.staleReason ?? 'unknown'}），状态摘要仅只读兼容消费`, at: new Date().toISOString(),
    })
  }
  const research = await buildResearchView(store, planId, degraded)
  return {
    planId: request.planId,
    found: true,
    status: request.status,
    slots: request.slots,
    artifacts,
    ...(Object.keys(artifactStatus).length > 0 ? { artifactStatus } : {}),
    degraded,
    updatedAt: request.updatedAt,
    ...(rental !== undefined ? { rentalQuotes: { quoted: rental.quotes.length, records: rental.records.length, consultationOnly: true as const } } : {}),
    ...(cost !== undefined ? { cost: { min: cost.total.min, max: cost.total.max, currency: cost.total.currency, warnings: [...cost.warnings] } } : {}),
    ...(research !== undefined ? { research } : {}),
  }
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转；可选字段缺失时整键省略以保证宿主 lossless-JSON 往返校验通过）。 */
export function projectState(r: GetStateResult): GetStateOutput {
  return {
    planId: r.planId,
    found: r.found,
    status: r.status,
    ...(r.slots !== undefined ? { slots: toCanonicalJson(r.slots) } : {}),
    artifacts: [...r.artifacts],
    ...(r.artifactStatus !== undefined ? { artifactStatus: toCanonicalJson(r.artifactStatus) } : {}),
    degraded: [...r.degraded],
    ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt } : {}),
    ...(r.rentalQuotes !== undefined ? { rentalQuotes: toCanonicalJson(r.rentalQuotes) as GetStateOutput['rentalQuotes'] } : {}),
    ...(r.cost !== undefined ? { cost: toCanonicalJson(r.cost) as GetStateOutput['cost'] } : {}),
    ...(r.research !== undefined ? { research: toCanonicalJson(r.research) as GetStateOutput['research'] } : {}),
  }
}

function renderState(args: GetStateParams, value: GetStateOutput): ContentBlock[] {
  if (!value.found) {
    return textCard(
      `**travel_get_state** · 计划未找到\n${cardLines([
        ['planId', value.planId || '（未提供，且无最近计划）'],
        ['状态', 'not_found'],
        ['提示', '请先 travel_intake 创建计划'],
      ])}`,
    )
  }
  const lines: [string, string][] = [
    ['planId', value.planId],
    ['状态', value.status],
    ['槽位', summarizeSlots(value.slots)],
    ['产物', value.artifacts.length > 0 ? value.artifacts.join(', ') : '（无）'],
  ]
  if (value.degraded.length > 0) {
    lines.push(['降级记录', value.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}`).join('；')])
  }
  if (value.rentalQuotes !== undefined) {
    lines.push(['租车报价', `${value.rentalQuotes.quoted}/${value.rentalQuotes.records} 条（咨询级、非实时、不可预订）`])
  }
  if (value.cost !== undefined) {
    lines.push(['成本摘要', `${value.cost.min}~${value.cost.max} ${value.cost.currency}`])
    if (value.cost.warnings.length > 0) lines.push(['成本提示', value.cost.warnings.join('；')])
  }
  if (value.research !== undefined) {
    const r = value.research
    const assess = r.assessment === undefined
      ? '无'
      : `${r.assessment.status}${r.assessment.stale ? '（过期）' : ''}@v${r.assessment.researchVersion}`
    const budget = `${r.budget.usedRounds}/${r.budget.maxRoundsPerPlan} 轮${r.budget.exhausted ? '（已耗尽）' : ''}`
    const gradeCount = r.items.reduce<Record<string, number>>((acc, it) => {
      acc[it.grade] = (acc[it.grade] ?? 0) + 1
      return acc
    }, {})
    const gradeText = ['title', 'fetched', 'partial', 'failed']
      .filter((g) => (gradeCount[g] ?? 0) > 0)
      .map((g) => `${g}:${gradeCount[g]}`)
      .join(' ')
    lines.push(['研究版本', `v${r.researchVersion}${r.ready ? '（就绪）' : '（未就绪）'}`])
    lines.push(['轮次', r.rounds.length > 0 ? `${r.rounds.length} 轮（${r.rounds.map((x) => x.roundId).join(', ')}）` : '（无）'])
    lines.push(['预算', budget])
    lines.push(['当前评估', assess])
    lines.push(['正文索引', r.items.length > 0 ? `${r.items.length} 条（${gradeText}）` : '（无）'])
    if (r.failures.length > 0) {
      lines.push(['失败/降级', `${r.failures.length} 条（${r.failures.slice(0, 3).map((f) => `[${f.code}]${f.reason}`).join('；')}${r.failures.length > 3 ? '…' : ''}）`])
    }
    // DR2：持久化抓取失败索引摘要（count/最近一条/恢复动作）
    if (r.fetchFailures !== undefined) {
      lines.push(['正文抓取失败', `${r.fetchFailures.count} 条${r.fetchFailures.recent !== undefined ? `（最近：${r.fetchFailures.recent.itemId} [${r.fetchFailures.recent.code}]）` : ''}`])
      lines.push(['抓取恢复', r.fetchFailures.recovery])
    }
    if (r.nextAction !== undefined) {
      lines.push(['恢复动作', r.nextAction])
    }
  }
  if (value.updatedAt !== undefined) lines.push(['更新时间', value.updatedAt])
  return textCard(`**travel_get_state** · 进度查询 (${args.planId ?? '最近计划'})\n${cardLines(lines)}`)
}

/** 工具定义工厂（只读：并发安全）。 */
export function createTravelGetStateTool(store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_get_state',
    description: '查询旅行规划进度与产物：status/slots/artifacts/degraded；计划不存在时明确返回 not_found（不崩溃）。',
    parameters: GET_STATE_PARAMETERS,
    output: {
      schema: GET_STATE_OUTPUT_SCHEMA,
      render: renderState,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await runGetState({ planId: args.planId }, store)
      return projectState(result)
    },
  })
}