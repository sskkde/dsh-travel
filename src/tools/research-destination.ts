/**
 * travel_research_destination —— 目的地情报检索（M1 T5/Wα 薄版 → W3 完整版加厚 → W1 DR1 多轮增量）。
 *
 * 完整版（W3）：
 * - 七渠道 fan-out（design §5.4 行 375-383）：小红书 xhsMcp（未挂载→降级语义标注）+
 *   xhsFallback（L0 种子 + L0.5 直抓）/ 抖音 L0 / 二层（zhihu OpenAPI+L0）/
 *   三层（微博/贴吧/快手 L0）/ 腾讯 POI（poi_search+poi_nearby 种子词）/
 *   平台情报（web L0）
 * - 统一机制（§9.3/node 面）：单源重试 ≤2 指数退避（1s/4s 计入总预算）、渠道开关
 *   前置过滤（ADR-12 settings 热读 →「已停用（用户配置）」）、聚合去重（笔记 ID/POI
 *   ID）、冲突标注（conflictsWith 互链）、时效降权（>12 个月）
 * - 180s 预算；presentCall 进度反馈；条目过 validateIntelItem 闸门后落 intel.json
 *   （条目级 source{platform,url,fetchedAt}）；对话内只回摘要卡片
 * - 全部渠道失败 → 不落盘空 intel.json + degraded[] 明确报告（§9.3-6 人工重试入口）
 *
 * W1 DR1（草稿 34-60「外部调用方主导深度研究」）：
 * - 调用方可控多轮增量：输入 keywords?/sources?/categories?/requestId?/
 *   expectedResearchVersion?/continuation?；读 request.researchIntent 作缺省兴趣种子；
 *   每轮追加合并而非覆盖（保留 round/query/source/candidate 引用链，跨轮 contentDedup），
 *   写 research-rounds/<roundId>.json 并推进 research-state.json（版本/轮次/预算/索引）；
 *   每个成功渠道的原始观察另留 `roundId:IntelItem.channel:contentId` provenance，
 *   不改变裸 itemId/newItemIds/contentRef 引用语义。
 * - discovery-only：仅 interest 种子无 destination 也可先做情报发现；两者皆缺 →
 *   明确 missing 回执（草稿 115）。
 * - requestId 幂等：同 ID 同参回显原回执 + 原 observedAt，不重复执行；异参拒绝（草稿 46）。
 * - 分页能力诚实：适配器无分页 → 显式 capability，不反复第一页声称已翻页（草稿 45）。
 * - 研究额度（research.deep.maxRoundsPerPlan，热读）：达边界 → budget_exhausted 回执
 *   含 used/remaining/恢复动作，不标 sufficient（草稿 60）。
 * - DR 模式判定（F1c-E）：新计划（request.flowVersion 存在）或任一显式 DR 参数 →
 *   写轮次 + 推进研究版本（DR3 失效链触发，「每次新检索可新增/更新情报、发起下一轮
 *   即撤销旧 assessment」——草稿 56）；legacy 计划（无 flowVersion）无显式参数保持旧
 *   单点兼容行为（不写轮次不推进，草稿 118）；intel 仍可跨次追加去重。
 */
import { createHash } from 'node:crypto'
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { EngineError, toEngineError, type DegradedEntry, type KeyResolutionEnv } from '../adapters/base.js'
import { SearchAdapter } from '../adapters/search.js'
import { WendaoAdapter } from '../adapters/wendao.js'
import { DidaHotelAdapter, toPriceQuote, type DidaHotelSearchQuery } from '../adapters/dida-hotel.js'
import { redactSensitiveText, redactSensitiveUrl } from '../adapters/search.js'
import type {
  BudgetScope, CostArtifact, CostComponent, CostComponentKey, CostEstimate, CostEstimateInput, IntelCategory, IntelChannel, IntelItem,
  LodgingQuoteEntry, LodgingQuoteRecord, PriceQuote, LodgingQuotesArtifact, PlacesArtifact,
  RentalPriceQuote, RentalQuoteEntry, RentalQuoteRecord, RentalQuoteRequest, RentalQuotesArtifact,
  ResearchContentArtifact, ResearchRound, ResearchRoundObservation, ResearchState, ResearchStateIndexItem, ResolvedPlace,
  TravelRequest, TransportOption,
} from '../models/types.js'
import { INTEL_CATEGORIES } from '../models/types.js'
import { assertValidIssues, isOneOf, isDateString, daysBetweenInclusive, normalizePublishedAt, validateCostArtifact, validateIntelItem, validateRentalQuotes } from '../models/validate.js'
import { TravelValidationError } from '../errors.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { assertTransition } from '../store/state.js'
import { intelDedupKey, runChannelFanout } from '../orchestrator/fanout.js'
import { ALL_INTEL_CATEGORIES, type ResearchChannel } from '../orchestrator/types.js'
import { assertSourcesAllowed } from '../adapters/governance/sources.js'
import { assertSafeResearchId } from '../store/paths.js'
import { cardLines, losslessJson, textCard } from './common.js'
import { aggregateCostComponent, aggregateSummedCostComponent, applyCostEstimates, normalizeCostEstimates, unavailableCostComponent } from './cost.js'

/** 渠道统一执行预算（fanout 内部；低于工具声明帽，保证回执早于宿主截止返回）。 */
export const RESEARCH_CHANNEL_BUDGET_MS = 165_000

/** 工具声明超时（§6 行 519：research 180s；宿主按此截止，渠道预算须留余量）。 */
export const RESEARCH_TIMEOUT_MS = 180_000

/** 发现词上限（草稿 A：最多 6 条，每条 trim 后 1-100 字符）。 */
export const RESEARCH_KEYWORDS_MAX = 6
export const RESEARCH_KEYWORDS_MAX_CHARS = 100

/** 定向报价阶段（草稿 E/B6：缺省 discovery；住宿/租车均为独立补充通路）。 */
export type ResearchDestinationPhase = 'discovery' | 'lodging-quotes' | 'rental-quotes'
/** 单次报价项上限（住宿/租车均 ≤20）。 */
export const LODGING_QUOTES_MAX_ITEMS = 20
export const RENTAL_QUOTES_MAX_ITEMS = 20

/** lodging-quotes phase 的报价输入项（placeId + 明确入住安排）。 */
export interface LodgingQuoteRequest {
  placeId: string
  /** 明确入住条件（草稿 E：缺 checkIn/checkOut 任一 → skipped_missing_stay_context，不猜每城住满）。 */
  checkIn?: string
  checkOut?: string
  adults?: number
  rooms?: number
}

/** 领域参数。 */
export interface ResearchDestinationArgs {
  planId: string
  categories?: IntelCategory[]
  depth?: 'quick' | 'full'
  /** 调用方指定发现词（草稿 38；缺省读 request.researchIntent 种子）。 */
  keywords?: string[]
  /** 已登记来源白名单键（草稿 44：只接受已登记渠道；不在白名单拒绝）。 */
  sources?: string[]
  /** 调用方幂等请求 id（同 ID 同参回显原回执；异参拒绝，草稿 46）。 */
  requestId?: string
  /** 调用方所依据的研究版本（过期 → 拒绝迟到写，草稿 56）。 */
  expectedResearchVersion?: number
  /** 续查上下文（草稿 45：仅适配器真实 cursor）。 */
  continuation?: { source: string; cursor?: string }
  /**
   * T14/B6：执行阶段。缺省 discovery；住宿/租车均为定向补充，不覆盖 intel，
   * 不做全渠道 fanout，也不阻塞主线。
   */
  phase?: ResearchDestinationPhase
  /** phase=lodging-quotes 的住宿项；phase=rental-quotes 时可传 RentalQuoteRequest。 */
  quoteRequests?: Array<LodgingQuoteRequest | RentalQuoteRequest>
  /** phase=rental-quotes 的显式租车项别名；与 quoteRequests 二选一，便于调用方自描述。 */
  rentalQuoteRequests?: RentalQuoteRequest[]
  /** 定向报价调用方所依据 places 版本（过期 → 拒绝）。 */
  expectedPlacesVersion?: number
  /** 可选 caller-supplied 成本估价；仅带完整口径/assumptions/证据者可进入 cost.json。 */
  costEstimates?: readonly CostEstimateInput[]
}

/** 工具返回（§6 行 519 摘要卡片；详情在 intel.json）。 */
export interface ResearchDestinationResult {
  planId: string
  intelSummary: Record<IntelChannel, number>
  itemCount: number
  degraded: DegradedEntry[]
  /** DR 模式（有 DR 参数）下的本轮回执；legacy 调用无此字段。 */
  round?: ResearchRound
  /** DR 模式预算耗尽回执（草稿 60：含 used/remaining/恢复动作）。 */
  budgetExhausted?: { usedRounds: number; maxRoundsPerPlan: number; remainingRounds: number; recovery: string }
  /** 幂等命中回执（同 ID 同参重放，original 回显原 observedAt）。 */
  idempotent?: { requestId: string; roundId: string; observedAt: string }
  /** T14（草稿 E）：phase='lodging-quotes' 的定向报价回执（不覆盖 intel，不阻塞主线）。 */
  lodgingQuotes?: {
    quotes: LodgingQuoteEntry[]
    records: LodgingQuoteRecord[]
    placesVersion: number
  }
  /** B6：phase='rental-quotes' 咨询级租车回执（非实时、不可预订）。 */
  rentalQuotes?: {
    quotes: RentalQuoteEntry[]
    records: RentalQuoteRecord[]
    placesVersion: number
    consultationOnly: true
  }
  /** B6：与租车/住宿/交通等现有工件聚合的预算摘要。 */
  cost?: CostArtifact
}

/** 装配依赖：渠道清单（W3 在此追加渠道实例）。 */
export interface ResearchToolDeps {
  channels: readonly ResearchChannel[]
  /** T14：DIDA 酒店只读报价适配器（可选注入；默认 off/缺 Key → blocked 零调用）。 */
  didaHotel?: DidaHotelAdapter
  /** B6：携程问道咨询级租车主渠道（可选；无 Key 自动休眠）。 */
  wendao?: WendaoAdapter
  /** B6：既有宿主搜索/DDG fallback（可选；仅解析明确日租数值）。 */
  search?: SearchAdapter
  /** 统一超时预算（缺省 180s）。 */
  timeoutMs?: number
  /** ADR-12 热读取环境（渠道开关前置过滤；由 index.ts makeKeyEnv(ctx) 注入）。 */
  env?: KeyResolutionEnv
  /** 单源失败重试退避序列（fan-out 透传；缺省 [1000,4000]，测试可注入空/微延迟）。 */
  retryDelaysMs?: readonly number[]
  /**
   * 单次规划开始回调（fan-out 入口调用；生产接线=amap.resetPlanBudget()，
   * 消除长驻进程多次规划后 amap 配额累积熔断——CLOSURE §三-③）。
   */
  resetPlanBudget?: () => void
}

const RESEARCH_PARAMETERS = {
  planId: {
    type: 'string',
    required: true,
    description: '计划 ID（必填；须先 travel_intake 建立计划且状态非终态锁定）',
  } as const,
  categories: {
    type: 'array',
    items: { type: 'string', enum: [...INTEL_CATEGORIES] },
    description: '情报类别过滤（缺省全 7 类：attraction/lodging/food/transportLocal/tip/warning/recommend）',
  } as const,
  depth: {
    type: 'string',
    enum: ['quick', 'full'],
    description: '检索深度（M1：quick 与 full 同源同集；full 预留加厚配额，W3 波后同口径）',
  } as const,
  keywords: {
    type: 'array',
    items: { type: 'string' },
    description: `调用方指定发现词（≤${RESEARCH_KEYWORDS_MAX} 条，各 1-100 字符；缺省读 request.researchIntent 种子）`,
  } as const,
  sources: {
    type: 'array',
    items: { type: 'string' },
    description: '已登记来源白名单键（不在白名单拒绝；缺省=全部渠道）',
  } as const,
  requestId: {
    type: 'string',
    description: '调用方幂等请求 id（同 ID 同参回显原回执；异参拒绝）',
  } as const,
  expectedResearchVersion: {
    type: 'integer',
    description: '调用方所依据的研究版本（过期 → 迟到写拒绝）',
  } as const,
  continuation: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string', required: true },
      cursor: { type: 'string' },
    },
    description: '续查上下文（仅适配器真实 cursor；无分页源不伪造翻页）',
  } as const,
  phase: {
    type: 'string',
    enum: ['discovery', 'lodging-quotes', 'rental-quotes'],
    description: 'T14/B6 执行阶段（缺省 discovery；住宿/租车定向报价不覆盖 intel、不做全渠道 fanout）',
  } as const,
  quoteRequests: {
    type: 'array',
    items: { type: 'json' },
    description: `定向报价项（≤${LODGING_QUOTES_MAX_ITEMS}）：住宿 {placeId,checkIn?,checkOut?,adults?,rooms?}；租车 {pickupPlaceId,dropoffPlaceId?,days,seats?}；仅接受 resolve 已校验 placeId`,
  } as const,
  rentalQuoteRequests: {
    type: 'array',
    items: { type: 'json' },
    description: `B6 phase=rental-quotes 租车咨询项别名（≤${RENTAL_QUOTES_MAX_ITEMS}）：{pickupPlaceId,dropoffPlaceId?,days,seats?}`,
  } as const,
  expectedPlacesVersion: {
    type: 'integer',
    description: 'T14 phase=lodging-quotes 时调用方所依据 places 版本（过期 → 拒绝）',
  } as const,
  costEstimates: {
    type: 'array',
    items: { type: 'json' },
    description: '可选有证据成本估价：component/priceRange/currency/unit/quantity/quantityBasis/scope/source/assumptions/evidenceRefs',
  } as const,
} as const

type ResearchParams = InferArgs<typeof RESEARCH_PARAMETERS>

export const RESEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    intelSummary: { type: 'json', required: true, description: '按 IntelItem.channel 的条目计数（{channel: count}）' },
    itemCount: { type: 'integer', required: true },
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
    round: {
      type: 'json',
      description: 'DR 模式本轮回执（roundId/查询词/渠道回执/增量/预算）；legacy 调用无此字段',
    },
    budgetExhausted: {
      type: 'json',
      description: 'DR 模式预算耗尽回执（used/remaining/恢复动作）',
    },
    idempotent: {
      type: 'json',
      description: '幂等命中回执（同 requestId 同参重放原回执）',
    },
    lodgingQuotes: {
      type: 'json',
      description: 'T14 phase=lodging-quotes 定向报价回执（quotes/records/placesVersion；不写 intel，不触发失效）',
    },
    rentalQuotes: {
      type: 'json',
      description: 'B6 phase=rental-quotes 租车咨询回执（非实时/不可预订；quotes/records/placesVersion）',
    },
    cost: {
      type: 'json',
      description: 'B6 cost.json 预算构成与总额（缺数据项显式 unavailable，不填假价）',
    },
  },
} as const

type ResearchOutput = InferValue<typeof RESEARCH_OUTPUT_SCHEMA>

/** fan-out 渠道内部名 → 可产出的已登记来源键（sources 过滤映射；确定可测）。 */
const CHANNEL_TO_SOURCES: Readonly<Record<string, readonly string[]>> = {
  'xhsMcp': ['xhs-mcp', 'xhs-l0'],
  'xhsFallback': ['xhs-l0'],
  'douyin': ['douyin'],
  'tier2': ['zhihu'],
  'tier3': ['weibo', 'tieba', 'kuaishou'],
  'socialL1': ['weibo', 'zhihu', 'tieba', 'kuaishou'],
  'tencent-poi': ['tencent-poi', 'amap'],
  'platformIntel': ['web'],
  'search-l0': ['search-l0'],
}

/** 按请求来源过滤渠道；未装配渠道的请求来源记入后置 degraded（诚实）。 */
function filterChannelsBySources(
  channels: readonly ResearchChannel[],
  sources: readonly string[] | undefined,
): { keep: ResearchChannel[]; missingSources: string[] } {
  if (sources === undefined || sources.length === 0 || sources.length === 1 && sources[0] === '*') {
    return { keep: [...channels], missingSources: [] }
  }
  const requested = new Set(sources)
  const keep: ResearchChannel[] = []
  const covered = new Set<string>()
  for (const ch of channels) {
    const keys = CHANNEL_TO_SOURCES[ch.name] ?? []
    if (keys.some((k) => requested.has(k))) {
      keep.push(ch)
      for (const k of keys) if (requested.has(k)) covered.add(k)
    }
  }
  const missingSources = sources.filter((s) => s !== '*' && !covered.has(s))
  return { keep, missingSources }
}

/** 规范化发现词：显式 keywords > intent.keywords > [intent.text] > [destination]。 */
function normalizeKeywords(args: ResearchDestinationArgs, requestDest: string | undefined, intentText: string | undefined, intentKeywords: string[] | undefined): string[] {
  if (args.keywords !== undefined && args.keywords.length > 0) {
    const words = dedupeTrim(args.keywords, RESEARCH_KEYWORDS_MAX)
    if (words.length === 0) throw new TravelValidationError(['keywords 全为空白'])
    return words
  }
  if (intentKeywords !== undefined && intentKeywords.length > 0) {
    return dedupeTrim(intentKeywords, RESEARCH_KEYWORDS_MAX)
  }
  if (isNonEmpty(intentText)) return [intentText.trim()]
  if (isNonEmpty(requestDest)) return [requestDest.trim()]
  return []
}

function dedupeTrim(words: readonly string[], max: number): string[] {
  const out: string[] = []
  for (const raw of words) {
    const w = (raw ?? '').trim()
    if (w === '' || w.length > RESEARCH_KEYWORDS_MAX_CHARS) continue
    if (out.includes(w)) continue
    out.push(w)
    if (out.length >= max) break
  }
  return out
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function redactDegradedEntry(entry: DegradedEntry): DegradedEntry {
  return {
    ...entry,
    source: redactSensitiveText(entry.source),
    reason: redactSensitiveText(entry.reason),
    ...(entry.candidateId !== undefined ? { candidateId: redactSensitiveText(entry.candidateId) } : {}),
    ...(entry.placeId !== undefined ? { placeId: redactSensitiveText(entry.placeId) } : {}),
  }
}

function redactIntelItem(item: IntelItem): IntelItem {
  const content = item.content === undefined
    ? undefined
    : typeof item.content === 'string'
      ? redactSensitiveText(item.content)
      : {
          ...item.content,
          contentRef: redactSensitiveText(item.content.contentRef),
          contentVersion: redactSensitiveText(item.content.contentVersion),
          ...(item.content.truncatedReason !== undefined
            ? { truncatedReason: redactSensitiveText(item.content.truncatedReason) } : {}),
        }
  return {
    ...item,
    id: redactSensitiveText(item.id),
    title: redactSensitiveText(item.title),
    summary: redactSensitiveText(item.summary),
    source: {
      ...item.source,
      platform: redactSensitiveText(item.source.platform),
      url: redactSensitiveUrl(item.source.url),
    },
    ...(item.conflictsWith !== undefined
      ? { conflictsWith: item.conflictsWith.map((id) => redactSensitiveText(id)) } : {}),
    ...(content !== undefined ? { content } : {}),
  }
}

function redactResearchRound(round: ResearchRound): ResearchRound {
  return {
    ...round,
    roundId: redactSensitiveText(round.roundId),
    query: {
      ...round.query,
      keywords: round.query.keywords.map((keyword) => redactSensitiveText(keyword)),
      sources: round.query.sources.map((source) => redactSensitiveText(source)),
      ...(round.query.requestId !== undefined ? { requestId: redactSensitiveText(round.query.requestId) } : {}),
      ...(round.query.continuation !== undefined ? {
        continuation: {
          source: redactSensitiveText(round.query.continuation.source),
          ...(round.query.continuation.cursor !== undefined
            ? { cursor: redactSensitiveText(round.query.continuation.cursor) } : {}),
        },
      } : {}),
    },
    channels: round.channels.map((channel) => ({
      ...channel,
      query: redactSensitiveText(channel.query),
      source: redactSensitiveText(channel.source),
      itemIds: channel.itemIds.map((id) => redactSensitiveText(id)),
      ...(channel.observations !== undefined ? {
        observations: channel.observations.map((observation) => ({
          ...observation,
          itemId: redactSensitiveText(observation.itemId),
          contentId: redactSensitiveText(observation.contentId),
          provenanceKey: redactSensitiveText(observation.provenanceKey),
        })),
      } : {}),
      ...(channel.error !== undefined ? {
        error: { ...channel.error, reason: redactSensitiveText(channel.error.reason) },
      } : {}),
    })),
    newItemIds: round.newItemIds.map((id) => redactSensitiveText(id)),
    failures: round.failures.map((failure) => ({ ...failure, reason: redactSensitiveText(failure.reason) })),
  }
}

function redactPriceQuote(quote: PriceQuote): PriceQuote {
  return {
    ...quote,
    currency: redactSensitiveText(quote.currency),
    ...(quote.checkIn !== undefined ? { checkIn: redactSensitiveText(quote.checkIn) } : {}),
    ...(quote.checkOut !== undefined ? { checkOut: redactSensitiveText(quote.checkOut) } : {}),
    ...(quote.cancellationPolicy !== undefined ? { cancellationPolicy: redactSensitiveText(quote.cancellationPolicy) } : {}),
    ...(quote.bookingUrl !== undefined ? { bookingUrl: redactSensitiveUrl(quote.bookingUrl) } : {}),
  }
}

function redactLodgingQuote(entry: LodgingQuoteEntry): LodgingQuoteEntry {
  return {
    ...entry,
    placeId: redactSensitiveText(entry.placeId),
    quote: redactPriceQuote(entry.quote),
    source: { ...entry.source, platform: redactSensitiveText(entry.source.platform), url: redactSensitiveUrl(entry.source.url) },
    ...(entry.hotelId !== undefined ? { hotelId: redactSensitiveText(entry.hotelId) } : {}),
    ...(entry.hotelName !== undefined ? { hotelName: redactSensitiveText(entry.hotelName) } : {}),
  }
}

function redactLodgingRecord(record: LodgingQuoteRecord): LodgingQuoteRecord {
  return {
    ...record,
    placeId: redactSensitiveText(record.placeId),
    ...(record.reason !== undefined ? { reason: redactSensitiveText(record.reason) } : {}),
  }
}

function redactResearchState(state: ResearchState): ResearchState {
  return {
    ...state,
    rounds: state.rounds.map((roundId) => redactSensitiveText(roundId)),
    sources: state.sources.map((source) => redactSensitiveText(source)),
    itemIndex: state.itemIndex.map((entry) => ({
      ...entry,
      itemId: redactSensitiveText(entry.itemId),
      roundId: redactSensitiveText(entry.roundId),
      title: redactSensitiveText(entry.title),
      ...(entry.provenanceKey !== undefined ? { provenanceKey: redactSensitiveText(entry.provenanceKey) } : {}),
      ...(entry.contentRef !== undefined ? { contentRef: redactSensitiveText(entry.contentRef) } : {}),
      ...(entry.contentVersion !== undefined ? { contentVersion: redactSensitiveText(entry.contentVersion) } : {}),
    })),
    ...(state.fetchFailures !== undefined ? {
      fetchFailures: state.fetchFailures.map((failure) => ({
        ...failure,
        itemId: redactSensitiveText(failure.itemId),
        code: redactSensitiveText(failure.code),
        reason: redactSensitiveText(failure.reason),
      })),
    } : {}),
  }
}

/** 缺省研究状态（新计划首轮）。 */
export function emptyResearchState(planId: string, maxRounds: number): ResearchState {
  void planId
  return {
    schemaVersion: 1,
    researchVersion: 0,
    updatedAt: new Date(0).toISOString(),
    rounds: [],
    budget: { usedRounds: 0, maxRoundsPerPlan: maxRounds, exhausted: false },
    sources: [],
    itemIndex: [],
  }
}

/** 纯逻辑（测试直调；store/渠道注入便于隔离）。 */
export async function runResearchDestination(
  args: ResearchDestinationArgs,
  store: TravelStore,
  deps: ResearchToolDeps,
): Promise<ResearchDestinationResult> {
  // 计划级在途锁（C 期接线 F4-C5）：intel/rounds/state/request 写路径串行化。
  return store.withPlanLock(args.planId, () => runResearchDestinationUnlocked(args, store, deps))
}

async function runResearchDestinationUnlocked(
  args: ResearchDestinationArgs,
  store: TravelStore,
  deps: ResearchToolDeps,
): Promise<ResearchDestinationResult> {
  const now = new Date().toISOString()
  if (args.requestId !== undefined) assertSafeResearchId(args.requestId, 'requestId')
  const request = await store.loadRequest(args.planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
  }

  // ── T14：定向报价 phase（草稿 E）——独立通路，不走情报 fanout ──
  const phase = args.phase ?? 'discovery'
  if (phase === 'lodging-quotes') {
    return runLodgingQuotes(args, request, store, deps)
  }
  if (phase === 'rental-quotes') {
    return runRentalQuotes(args, request, store, deps)
  }

  const destination = request.slots.destination
  const intent = request.slots.researchIntent
  // DR 模式判定（F1c-E 决策 5 修正）：新计划（request.flowVersion 存在）或任一显式
  // DR 参数（keywords/requestId/sources/continuation）→ 本轮写 research-rounds 并推进
  // researchVersion（触发 DR3 失效链）；legacy 计划（无 flowVersion）无显式参数 →
  // 保留旧单点兼容行为（不写轮次不推进，草稿 118）。由此「新计划下的默认调用」也
  // 记录轮次——每次新检索可新增/更新情报、发起下一轮即撤销旧 assessment（草稿 56）。
  const drMode = request.flowVersion !== undefined || args.keywords !== undefined
    || args.requestId !== undefined || args.sources !== undefined || args.continuation !== undefined

  // destination / researchIntent 驱动判定（草稿 A/115）。
  // 缺省调用（非 DR 参数）也接受 researchIntent 作发现种子：request.researchIntent
  // 存在且 destination 为空 = 纯发现轮（不要求 destination）。两者皆缺 → 明确 missing
  // receipt（不给空主题静默研究）。DR 轮同上判断（F1c-E：新计划下缺省调用亦属 DR 轮）。
  const hasDriver = destination !== undefined || intent !== undefined
  if (!hasDriver) {
    throw new TravelValidationError([
      '缺少研究输入（missing receipt）：既无 slots.destination 也无 slots.researchIntent；'
      + (drMode
        ? 'discovery-only 需至少其一作为发现主题'
        : '请先 travel_intake 补齐目的地或兴趣主题（researchIntent.text）'),
    ])
  }

  // categories 参数校验（枚举成员；非法参数明确报错）
  const categories = args.categories ?? [...ALL_INTEL_CATEGORIES]
  if (categories.length === 0) {
    throw new TravelValidationError(['categories 不能为空数组'])
  }
  const unknown = categories.filter((c) => !isOneOf(c, INTEL_CATEGORIES))
  if (unknown.length > 0) {
    throw new TravelValidationError([`categories 含非法类别：${unknown.join(', ')}（允许 ${INTEL_CATEGORIES.join('|')}）`])
  }

  // sources 白名单校验（草稿 44：只接受已登记渠道集；未知源明确拒绝）
  assertSourcesAllowed(args.sources)

  // 状态机：进入 researching（confirmed→researching / researching self；delivered 需先 update 转 revising）
  assertTransition(request.status, 'researching')

  // 预算上限（DR 模式热读 research.deep.maxRoundsPerPlan；缺省 16）
  const rawMax = deps.env?.readSettings?.('research.deep.maxRoundsPerPlan')
  const maxRounds = (rawMax !== undefined ? Number.parseInt(String(rawMax), 10) : 16) || 16
  const state = await loadStateOrInit(store, args.planId, maxRounds)

  // DR 模式：幂等 + 版本门 + 预算边界（均在执行前判定）
  if (drMode) {
    if (args.expectedResearchVersion !== undefined && state.researchVersion !== args.expectedResearchVersion) {
      throw new TravelValidationError([
        `研究版本过期（expected=${args.expectedResearchVersion}，current=${state.researchVersion}）；`
        + '请返回当前 researchVersion 再发起',
      ])
    }
    if (args.requestId !== undefined) {
      const prior = await findIdempotentRound(store, args.planId, args.requestId, args)
      if (prior !== undefined) {
        return {
          planId: args.planId,
          intelSummary: {} as Record<IntelChannel, number>,
          itemCount: 0,
          degraded: [],
          idempotent: { requestId: args.requestId, roundId: prior.roundId, observedAt: prior.observedAt },
        }
      }
    }
    if (state.budget.usedRounds >= maxRounds) {
      const remainingRounds = Math.max(0, maxRounds - state.budget.usedRounds)
      return {
        planId: args.planId,
        intelSummary: {} as Record<IntelChannel, number>,
        itemCount: 0,
        degraded: [],
        budgetExhausted: {
          usedRounds: state.budget.usedRounds,
          maxRoundsPerPlan: maxRounds,
          remainingRounds,
          recovery: '研究额度已用尽（暂停，非完成）：请调整 research.deep.maxRoundsPerPlan 或核查已完成轮次后再续查',
        },
      }
    }
  }

  // 规范化查询词 + 来源过滤
  const keywords = normalizeKeywords(args, destination, intent?.text, intent?.keywords)
  const sources = args.sources ?? ['*']
  const { keep: channels, missingSources } = filterChannelsBySources(deps.channels, sources)
  const missingSourceDegraded: DegradedEntry[] = missingSources.map((s) => ({
    source: s,
    code: 'UNAVAILABLE',
    reason: '来源已登记但当前未装配对应渠道（未执行其网络请求）',
    at: now,
  }))

  // B3 T9/P0-C R2：scopeKey 仅为查询级审计印记（确定性、可复现），不参与
  // fanout 内容聚合、跨轮 union/newItemIds 抑制，也不替代 per-observation provenanceKey。
  const queryScopeKey = scopeKeyOf({
    planId: args.planId,
    destination,
    intentText: intent?.text,
    keywords,
    categories,
    sources,
  })

  const fanout = await runChannelFanout({
    channels,
    query: { planId: args.planId, destination, categories, sources, keywords: keywords.length > 0 ? keywords : undefined },
    budgetMs: deps.timeoutMs ?? RESEARCH_CHANNEL_BUDGET_MS,
    env: deps.env,
    retryDelaysMs: deps.retryDelaysMs,
    resetPlanBudget: deps.resetPlanBudget,
  })

  // 中心类别过滤 + 条目级闸门
  const unknownTimeliness = new Set<string>()
  const categoryFiltered = fanout.items
    .filter((item) => categories.includes(item.category))
    .map((item) => {
      if (item.publishedAt === undefined) {
        unknownTimeliness.add(item.id)
        return item
      }
      const normalized = normalizePublishedAt(item.publishedAt)
      if (normalized === undefined) {
        unknownTimeliness.add(item.id)
        const { publishedAt: _invalidPublishedAt, ...withoutPublishedAt } = item
        return withoutPublishedAt
      }
      return { ...item, publishedAt: normalized }
    })
  const kept: IntelItem[] = []
  const droppedRaw: DegradedEntry[] = []
  for (const item of categoryFiltered) {
    const issues = validateIntelItem(item)
    if (issues.length > 0) {
      droppedRaw.push({
        source: item.channel,
        code: 'UNAVAILABLE',
        reason: `条目校验失败已丢弃：${issues.map((i) => i.message).join('；')}`,
        at: now,
      })
      continue
    }
    const persistedItem = unknownTimeliness.has(item.id)
      ? {
        ...item,
        summary: item.summary.includes('时效性未知')
          ? item.summary
          : `${item.summary}（缺少或无法解析发布时间，时效性未知，已降权）`,
      }
      : item
    kept.push(redactIntelItem(persistedItem))
  }

  // P2-A：相同渠道+原因只保留一条 dropped，并显式保留计数；不同原因分组。
  const dropped = aggregateDegraded(droppedRaw)
  const degraded: DegradedEntry[] = [...fanout.degraded, ...dropped, ...missingSourceDegraded]
    .map(redactDegradedEntry)

  // intel 追加合并（跨轮去重）：unknown 是只读兼容输入，不能伪装为 current；
  // 失败/空结果/hash 失配仍不复活。若最近发布阶段正是 research 且工件未入账，
  // 这是完整性签名：本轮不消费旧内容，只用新检索结果修复该工件。
  const existingState = await store.readArtifactWithState<IntelItem[]>(args.planId, 'intel.json')
  const existingStageOwnedUnaccounted = isUnaccounted(existingState) && existingState.meta?.stage === 'research'
  const existingReadable = !existingStageOwnedUnaccounted && existingState.found && existingState.data !== undefined
    && existingState.status !== 'failed' && existingState.status !== 'empty'
    && !(existingState.status === 'stale' && existingState.staleReason === 'hash_mismatch')
    ? existingState.data : undefined
  const existing = Array.isArray(existingReadable)
    ? existingReadable.map(redactIntelItem)
    : []
  if (isUnaccounted(existingState)) {
    degraded.push(redactDegradedEntry({
      source: 'research/intel', code: 'UNAVAILABLE',
      reason: existingStageOwnedUnaccounted
        ? `intel.json 未入账（${existingState.status}/${existingState.staleReason ?? 'unknown'}），最近一次为 research 阶段，无法验证完整性：本轮不消费旧内容`
        : `intel.json 未入账（${existingState.status}/${existingState.staleReason ?? 'unknown'}），本轮仅只读兼容合并`, at: now,
    }))
  }
  const existingKeys = new Set(existing.map(intelDedupKeyOf))
  const newItems: IntelItem[] = kept.filter((item) => !existingKeys.has(intelDedupKeyOf(item)))
  const union = [...existing, ...newItems]
  for (const entry of degraded) {
    await store.recordDegraded(args.planId, entry)
  }

  // 状态推进（researching；即使全失败也记录已执行检索）
  await store.saveRequest({ ...request, status: 'researching', updatedAt: now })

  // DR 模式：写轮次 + 推进研究版本 + 保存研究状态。
  // roundId 只在已通过幂等/版本/预算门且 fanout 完成后于内存生成；失败或幂等命中
  // 不会先占用 roundId/写任何 round 工件。
  let round: ResearchRound | undefined
  let nextState: ResearchState | undefined
  if (drMode) {
    const roundId = roundIdOf(args, state, now)
    const nextVersion = state.researchVersion + 1
    const keptContentIds = new Set(kept.map(intelDedupKeyOf))
    /**
     * 所有成功渠道的原始观察都留在 round JSON；accepted 只说明该内容键对应的
     * fanout 聚合条目通过了中心类别/条目校验。观察记录的 provenanceKey 独立于
     * contentId 抑制，故同轮 l0:/xhs: 等归一观察仍逐条可核对。
     */
    const roundObservations = fanout.observations.map((entry) => {
      const contentDedupKey = intelDedupKeyOf(entry.item)
      const observation: ResearchRoundObservation = {
        itemId: entry.item.id,
        contentId: contentDedupKey,
        channel: entry.item.channel,
        provenanceKey: provenanceKeyOf(roundId, entry.item.channel, contentDedupKey),
        accepted: keptContentIds.has(contentDedupKey),
      }
      return { fanoutChannel: entry.channel, observation }
    })
    const firstProvenanceByContent = new Map<string, string>()
    const provenanceByItemId = new Map<string, string>()
    for (const { observation } of roundObservations) {
      if (!firstProvenanceByContent.has(observation.contentId)) {
        firstProvenanceByContent.set(observation.contentId, observation.provenanceKey)
      }
      if (!provenanceByItemId.has(observation.itemId)) {
        provenanceByItemId.set(observation.itemId, observation.provenanceKey)
      }
    }
    const channelEntries = fanout.executed.map((name) => {
      const observations = roundObservations
        .filter((entry) => entry.fanoutChannel === name)
        .map((entry) => entry.observation)
      const err = fanout.degraded.find((d) => d.source === name)
      return {
        query: keywords.join(' '),
        source: name,
        pagination: ('none') as const,
        // itemIds 保持原始裸 ID；它与 observations 一一对应，不改 DR1/正文引用语义。
        itemIds: observations.map((observation) => observation.itemId),
        observations,
        ...(err !== undefined ? { error: { code: err.code, reason: err.reason } } : {}),
      }
    })
    const failures = fanout.degraded.map((d) => ({ code: d.code, reason: d.reason }))
    const rawRound: ResearchRound = {
      roundId,
      researchVersion: nextVersion,
      requestedAt: now,
      observedAt: now,
      initiator: continuationOf(args) !== undefined ? 'continuation' : (destination ? 'destination' : 'discovery'),
      query: {
        keywords,
        sources: sources.slice(),
        categories: [...categories],
        // scopeKey 是查询级审计；provenanceKey 才是每条观察的 round/channel/contentId 链。
        scopeKey: queryScopeKey,
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
        ...(args.continuation !== undefined ? { continuation: { ...args.continuation } } : {}),
      },
      channels: channelEntries,
      newItemIds: newItems.map((it) => it.id),
      // keptRawCount 是 accepted 原始观察数；同轮聚合后的条目数仍由 itemCount/newItemIds
      // 与 observations.contentId 的去重集合表示，二者不混作 suppression key。
      keptRawCount: roundObservations.filter((entry) => entry.observation.accepted === true).length,
      budget: {
        usedRounds: state.budget.usedRounds + 1,
        maxRoundsPerPlan: maxRounds,
        exhausted: state.budget.usedRounds + 1 >= maxRounds,
      },
      failures,
    }
    round = redactResearchRound(rawRound)
    nextState = {
      ...redactResearchState(state),
      researchVersion: nextVersion,
      updatedAt: now,
      rounds: [...state.rounds, roundId],
      budget: round.budget,
      sources: [...new Set([...state.sources, ...sources.filter((s) => s !== '*')])],
      // 旧尝试可能留下 itemIndex[].scopeKey；新写入只保留 query.scopeKey，避免把
      // scope:<hash> 继续冒充条目 provenance（读取旧文件仍兼容）。
      itemIndex: [
        ...redactResearchState(state).itemIndex.map(dropLegacyScopeKey),
        ...newItems.map((it) => {
          // 优先选择与保留的 IntelItem 裸 ID 相同的观察；没有时退回同 contentId
          // 的首个观察。其余同轮观察完整留在 round.channels[].observations[].
          const provenanceKey = provenanceByItemId.get(it.id)
            ?? firstProvenanceByContent.get(intelDedupKeyOf(it))
          return {
            itemId: it.id,
            roundId,
            channel: it.channel,
            title: it.title,
            ...(provenanceKey !== undefined ? { provenanceKey } : {}),
          }
        }),
      ],
    }
    await store.writeResearchRound(args.planId, roundId, round)
  }

  // 统一经 manifest 发布 intel/research-state，确保下游看到的版本与文件
  // 属于同一次提交；round 子工件仍独立留存作审计链。
  const versionExpectation: Partial<Record<'intel' | 'research', number>> = {}
  const publishFiles: Array<{ name: string; data: unknown }> = []
  const bump: Array<'intel' | 'research'> = []
  if (kept.length > 0) {
    publishFiles.push({ name: 'intel.json', data: union })
    // Do not record the pre-bump value as this artifact's own dependency:
    // intel must remain current after its version is advanced.
    bump.push('intel')
  }
  if (nextState !== undefined) {
    publishFiles.push({ name: 'research-state.json', data: nextState })
    bump.push('research')
  }
  if (publishFiles.length > 0) {
    await store.publishArtifacts(args.planId, {
      stage: 'research',
      files: publishFiles,
      expectedVersions: versionExpectation,
      bump,
      inputFingerprint: queryScopeKey,
    })
  }

  // 动态计数：仅记录出现的通道
  const summary = {} as Record<IntelChannel, number>
  for (const item of kept) {
    summary[item.channel] = (summary[item.channel] ?? 0) + 1
  }
  return {
    planId: args.planId,
    intelSummary: summary,
    itemCount: kept.length,
    degraded: [...degraded],
    ...(round !== undefined ? { round } : {}),
  }
}

/**
 * roundId 生成只发生在 fanout 完成后的内存阶段：requestId 轮次保持旧幂等回执兼容，
 * 无 requestId 时用请求快照时间+下一轮序号；幂等/校验/失败早退都不会预写工件。
 */
function roundIdOf(args: ResearchDestinationArgs, state: ResearchState, now: string): string {
  return args.requestId ?? `round-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${state.budget.usedRounds + 1}`
}

/** per-observation provenance：内容段严格来自 fanout.intelDedupKey，不参与 suppression。 */
export function provenanceKeyOf(roundId: string, channel: IntelChannel, contentId: string): string {
  return `${roundId}:${channel}:${contentId}`
}

// ────────────────────────── T14 定向酒店报价（草稿 E） ──────────────────────────

function quoteFingerprint(placesVersion: number, items: readonly LodgingQuoteRequest[]): string {
  const payload = JSON.stringify({ placesVersion, items })
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

/**
 * T14（草稿 E）：phase='lodging-quotes' 定向报价纯逻辑。
 * - 输入 ≤20 项 {placeId,checkIn,checkOut,adults,rooms}；只接受 resolve 已校验住宿
 *   候选/区域的 placeId（其他 → rejected）。
 * - 缺入住条件（checkIn/checkOut）→ skipped_missing_stay_context：不猜每城住满、
 *   不阻塞主线。
 * - DIDA 渠道默认 off / 缺 Key → blocked + 零调用（不猜测报价）。
 * - 缺条件/单位/币种/真实数值 → 不填假区间（blocked 记录）。
 * - 独立 lodging-quotes.json 工件；报价不使 intel/places 失效（只 bump quotes）；
 *   房型/税费/退改差异不直接当跨源价格冲突（各报价独立并列，无冲突判定）。
 */
async function runLodgingQuotes(
  args: ResearchDestinationArgs,
  request: TravelRequest,
  store: TravelStore,
  deps: ResearchToolDeps,
): Promise<ResearchDestinationResult> {
  const now = new Date().toISOString()
  const planId = args.planId
  assertTransition(request.status, 'researching')

  const degraded: DegradedEntry[] = []
  // phase 已决定输入形态；保留 T14 旧契约的 lodging 字段访问，租车形态走下方独立分支。
  const items = (args.quoteRequests ?? []) as LodgingQuoteRequest[]
  if (items.length === 0) {
    throw new TravelValidationError([`phase=lodging-quotes 需要 quoteRequests（≤${LODGING_QUOTES_MAX_ITEMS} 项）`])
  }
  if (items.length > LODGING_QUOTES_MAX_ITEMS) {
    throw new TravelValidationError([`quoteRequests ${items.length} 项超过上限 ${LODGING_QUOTES_MAX_ITEMS}`])
  }

  const placesVersion = await store.currentVersion(planId, 'places')
  const placesState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  // 多发布批次下 not_in_commit 不误杀：真正不可用=缺工件/发布失败/空/hash 失配
  const placesStageOwnedUnaccounted = placesState.status === 'unknown'
    && placesState.staleReason === 'unaccounted' && placesState.meta?.stage === 'places'
  const placesStageOwnedUnverifiable = placesState.status === 'stale'
    && placesState.staleReason === 'not_in_commit' && placesState.meta?.stage === 'places'
  const placesIntegrityBlocked = placesStageOwnedUnaccounted || placesStageOwnedUnverifiable
    || (placesState.status === 'stale' && placesState.staleReason === 'hash_mismatch')
  if (placesState.status === 'unknown' && !placesStageOwnedUnaccounted) {
    degraded.push({
      source: 'lodging-quotes/places', code: 'UNAVAILABLE',
      reason: `places.json 未入账（${placesState.staleReason ?? 'unknown'}），住宿报价仅只读兼容消费，完整性无法证明`, at: now,
    })
  }
  const placesReady = placesState.found && placesState.data !== undefined
    && placesState.status !== 'failed' && placesState.meta?.status !== 'failed'
    && placesState.status !== 'empty' && placesState.meta?.status !== 'empty'
    && !(placesState.status === 'stale' && placesState.staleReason === 'hash_mismatch')
    && !placesStageOwnedUnaccounted && !placesStageOwnedUnverifiable
  const versionOk = args.expectedPlacesVersion === undefined || args.expectedPlacesVersion === placesVersion

  const quotes: LodgingQuoteEntry[] = []
  const records: LodgingQuoteRecord[] = []
  const placeById = new Map<string, ResolvedPlace>()
  if (placesReady) {
    for (const p of placesState.data!.places) placeById.set(p.placeId, p)
  }

  for (const item of items) {
    const rid = item.placeId
    if (typeof rid !== 'string' || rid.trim() === '') {
      records.push({ placeId: String(rid ?? ''), status: 'rejected', reason: 'placeId 必填' })
      continue
    }
    // ① 工件/版本门（拒绝，零网络）
    if (!placesReady) {
      records.push({
        placeId: rid,
        status: 'rejected',
        reason: placesIntegrityBlocked ? 'places_stale（工件完整性无法验证，不复活旧地点）' : 'places_not_ready（请先 travel_resolve_places）',
      })
      continue
    }
    if (!versionOk) {
      records.push({ placeId: rid, status: 'rejected', reason: `places_stale（expected=${args.expectedPlacesVersion}，current=${placesVersion}）` })
      continue
    }
    // ② 仅接受 resolve 已校验住宿候选/区域
    const place = placeById.get(rid)
    if (place === undefined) {
      records.push({ placeId: rid, status: 'rejected', reason: 'unknown_place（不在当前 places 解析结果）' })
      continue
    }
    if (place.kind !== 'lodging' && place.kind !== 'area') {
      records.push({ placeId: rid, status: 'rejected', reason: 'not_lodging（仅接受 resolve 校验的住宿候选/区域 placeId）' })
      continue
    }
    // ③ 入住条件（缺 → skipped_missing_stay_context，不猜每城住满）
    const checkIn = item.checkIn
    const checkOut = item.checkOut
    if (checkIn === undefined || checkOut === undefined || !isDateString(checkIn) || !isDateString(checkOut)) {
      records.push({ placeId: rid, status: 'skipped_missing_stay_context', reason: '缺明确入住条件（checkIn/checkOut），不猜每城住满全程' })
      continue
    }
    const adults = item.adults ?? request.slots.travelers?.adults
    const rooms = item.rooms
    // ④ DIDA 只读渠道（默认 off / 缺 Key → blocked + 零调用）
    const dida = deps.didaHotel
    if (dida === undefined) {
      records.push({ placeId: rid, status: 'blocked', reason: 'DIDA 渠道未装配（channels.fr3.didaHotel 默认 off）' })
      continue
    }
    if (!(await dida.available(deps.env))) {
      degraded.push({
        source: 'didahotel', code: 'UNAVAILABLE',
        reason: 'DIDA 不可用（渠道 off 或 Key 未配置 DIDA_HOTEL_API_KEY）：报价未取得，不猜测', at: now,
      })
      records.push({ placeId: rid, status: 'blocked', reason: 'DIDA 渠道 off / 缺 Key（DIDA_HOTEL_API_KEY）' })
      continue
    }
    const query: DidaHotelSearchQuery = {
      placeId: rid,
      city: place.district ?? place.name,
      ...(place.coords !== undefined ? { lat: place.coords.lat, lng: place.coords.lng } : {}),
      checkIn,
      checkOut,
      ...(adults !== undefined ? { adults } : {}),
      ...(rooms !== undefined ? { rooms } : {}),
    }
    try {
      const { hotels, degraded: hd } = await dida.searchHotels(query, deps.env)
      degraded.push(...hd)
      const hotel = hotels[0]
      if (hotel === undefined) {
        records.push({ placeId: rid, status: 'blocked', reason: 'searchHotels 无结果（可稍后重试）' })
        continue
      }
      const { hotel: detail, degraded: dd } = await dida.getHotelDetail(hotel.hotelId, deps.env)
      degraded.push(...dd)
      if (detail === undefined) {
        records.push({ placeId: rid, status: 'blocked', reason: 'getHotelDetail 无有效详情' })
        continue
      }
      const quote = toPriceQuote(detail, { checkIn, checkOut, ...(adults !== undefined ? { adults } : {}), ...(rooms !== undefined ? { rooms } : {}), observedAt: now })
      if (quote === undefined) {
        records.push({ placeId: rid, status: 'blocked', reason: '报价缺条件/单位/币种/真实数值：不填假区间' })
        continue
      }
      quotes.push({
        placeId: rid,
        quote,
        source: { platform: 'dida-hotel', url: dida.mcp.url, fetchedAt: now },
        ...(hotel.hotelId !== undefined ? { hotelId: hotel.hotelId } : {}),
        hotelName: detail.name,
      })
      records.push({ placeId: rid, status: 'quoted' })
    } catch (err) {
      degraded.push({
        source: 'didahotel', code: 'UNAVAILABLE',
        reason: `DIDA 查询失败：${err instanceof Error ? err.message : String(err)}`, at: now,
      })
      records.push({ placeId: rid, status: 'blocked', reason: `DIDA 查询失败（${err instanceof Error ? err.message : String(err)}）` })
    }
  }

  const inputFingerprint = quoteFingerprint(placesVersion, items)
  const safeQuotes = quotes.map(redactLodgingQuote)
  const safeRecords = records.map(redactLodgingRecord)
  const safeDegraded = degraded.map(redactDegradedEntry)
  const artifact: LodgingQuotesArtifact = {
    schemaVersion: 1,
    placesVersion,
    inputFingerprint,
    generatedAt: now,
    quotes: safeQuotes,
    records: safeRecords,
    degraded: safeDegraded.map(({ source, code, reason, at }) => ({ source, code, reason, at })),
  }

  // 独立版本工件：报价不使 intel/places 失效（只 bump quotes；日期/住宿候选改变才失效）
  await store.publishArtifacts(planId, {
    stage: 'lodging-quotes',
    files: [{ name: 'lodging-quotes.json', data: artifact }],
    expectedVersions: { places: placesVersion },
    bump: ['quotes'],
    inputFingerprint,
  })
  for (const d of safeDegraded) await store.recordDegraded(planId, d)
  await store.saveRequest({ ...request, status: 'researching', updatedAt: now })

  return {
    planId,
    intelSummary: {} as Record<IntelChannel, number>,
    itemCount: 0,
    degraded: safeDegraded,
    lodgingQuotes: { quotes: safeQuotes, records: safeRecords, placesVersion },
  }
}

// ────────────────────────── B6 租车咨询询价与 cost ──────────────────────────

const RENTAL_DISCLAIMER = '租车信息为咨询级、非实时、不可预订；请以租车服务商/官方渠道最终确认，不代表可用库存或成交价。'
const RENTAL_PRIMARY_SOURCE = 'wendao'
const RENTAL_FALLBACK_SOURCE = 'search-l0'

export type RentalPriceCandidate = {
  range: [number, number]
  currency: string
  taxStatus: RentalPriceQuote['taxStatus']
  vehicleType: string
  referenceUrl?: string
  source?: 'wendao' | 'search-l0'
}

const RENTAL_AMOUNT = '(\\d{1,9}(?:\\.\\d+)?)'
const RENTAL_CURRENCY = '(?:¥|￥|CNY|人民币|USD|美元|EUR|欧元|元)'
const RENTAL_RANGE = '(?:-|~|～|至|到|—)'
const RENTAL_DAY_SUFFIX = '(?:\\/\\s*(?:天|日|day|days)|每\\s*(?:天|日)|per\\s*(?:day|days))'
/**
 * 与价格表达式**紧邻**的前置币种 marker（表达式前最多 8 个非空白字符）。
 *
 * 为什么需要：「USD 300 EUR/day」这类文本里，币种写在金额前、日单位写在金额后，
 * 金额后的 pattern 只看到 `EUR/day`，会把美元金额标成欧元。币种在**同一价格
 * 表达式内**冲突时必须整条放弃，不能让 pattern 的匹配跨度决定「谁被看不见」。
 * 上限 8 个字符是为了只收紧同一表达式（`USD 300`、`$ 300`），不接受隔着一句
 * 话的远处 marker——否则「日租 300 元，不收美元」这类说明会被误判成冲突。
 */
const RENTAL_LEADING_CURRENCY_WINDOW = 8
const RENTAL_LEADING_CURRENCY_RE = new RegExp(`${RENTAL_CURRENCY}\\s*$`, 'i')

function rentalCurrency(marker: string | undefined): string | undefined {
  if (marker === undefined) return undefined
  if (/USD|美元/i.test(marker)) return 'USD'
  if (/EUR|欧元/i.test(marker)) return 'EUR'
  if (/¥|￥|CNY|人民币|元/i.test(marker)) return 'CNY'
  return undefined
}

/**
 * 只从同一价格表达式提取「金额 + 币种 + 日单位」：
 * - 押金/租期中的金额没有同时绑定币种与日单位时不会被当成日租；
 * - 货币只取表达式内的 marker，不被整段文本中的「不收美元」等说明污染；
 * - 支持 ¥/￥/CNY/人民币/元 与明确的 USD/EUR marker。
 */
export function parseRentalPrice(text: string, referenceUrl?: string): RentalPriceCandidate | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return undefined

  /** markers：同一价格表达式内出现的全部币种 marker（冲突判定用，保序去重前）。 */
  type RentalMatch = { match: RegExpExecArray; min: number; max: number; markers: string[] }
  const isFalseRentalContext = (candidate: RentalMatch): boolean => {
    const start = candidate.match.index ?? 0
    const matched = candidate.match[0].trim()
    const before = normalized.slice(Math.max(0, start - 24), start)
    const after = normalized.slice(start + candidate.match[0].length, start + candidate.match[0].length + 16)
    // A deposit immediately before/after the matched expression is not a daily
    // rental quote.  A separate "另收押金" clause remains valid.
    if (/(?:押金|保证金|定金)\s*$/.test(before) || /^(?:\s*)(?:押金|保证金|定金)/.test(after)) return true
    // Lease-duration amounts such as "租期30天，300元/天" are not prices
    // unless the candidate itself has an explicit daily-rental prefix.
    const hasDailyPrefix = /^(?:日租金?|每天|每日|daily|per\s*day)/i.test(matched)
    if (!hasDailyPrefix && /(?:租期|租赁期|最长可租|起租)\s*\d{0,6}\s*(?:天|日)?\s*[，,、:：;；]?\s*$/.test(before)) return true
    return false
  }
  const patterns: Array<(normalizedText: string) => RentalMatch | undefined> = [
    // 「日租 300 元」：前置日单位已经与金额表达式绑定。
    (normalizedText) => {
      const match = new RegExp(`(?:日租金?|每天|每日|daily|per\\s*day)\\s*(?:(${RENTAL_CURRENCY})\\s*)?${RENTAL_AMOUNT}(?:\\s*${RENTAL_RANGE}\\s*${RENTAL_AMOUNT})?\\s*(?:(${RENTAL_CURRENCY})\\s*)?`, 'i').exec(normalizedText)
      if (match === null) return undefined
      return {
        match,
        min: Number(match[2]),
        max: match[3] === undefined ? Number(match[2]) : Number(match[3]),
        markers: [match[1], match[4]].filter((m): m is string => m !== undefined),
      }
    },
    // 「¥300-450/天」「CNY 300-450/天」。
    (normalizedText) => {
      const match = new RegExp(`(${RENTAL_CURRENCY})\\s*${RENTAL_AMOUNT}(?:\\s*${RENTAL_RANGE}\\s*${RENTAL_AMOUNT})?\\s*(?:元\\s*)?${RENTAL_DAY_SUFFIX}`, 'i').exec(normalizedText)
      if (match === null) return undefined
      return {
        match,
        min: Number(match[2]),
        max: match[3] === undefined ? Number(match[2]) : Number(match[3]),
        markers: [match[1]].filter((m): m is string => m !== undefined),
      }
    },
    // 「300-450元/天」「300-450 USD/day」。
    (normalizedText) => {
      const match = new RegExp(`${RENTAL_AMOUNT}(?:\\s*${RENTAL_RANGE}\\s*${RENTAL_AMOUNT})?\\s*(${RENTAL_CURRENCY})\\s*${RENTAL_DAY_SUFFIX}`, 'i').exec(normalizedText)
      if (match === null) return undefined
      return {
        match,
        min: Number(match[1]),
        max: match[2] === undefined ? Number(match[1]) : Number(match[2]),
        markers: [match[3]].filter((m): m is string => m !== undefined),
      }
    },
  ]

  let parsed: RentalMatch | undefined
  for (const pattern of patterns) {
    const candidate = pattern(normalized)
    if (candidate !== undefined && !isFalseRentalContext(candidate)) {
      parsed = candidate
      break
    }
  }
  if (parsed === undefined) return undefined
  // 同一表达式内出现多个币种 marker（如「日租 USD 300 元」「USD 300元/天」）：
  // 规范化后若币种冲突则整条放弃，不得改用其它 pattern 把它「捞回」成单一币种
  // ——错标币种会让 cost 聚合把外币金额当成预算币种，比不报价危险得多。
  //
  // marker 采集覆盖**整个匹配跨度**（含 pattern 未显式分组的 `元` 等字面量），
  // 而不是只看分组：否则「USD 300元/天」里跟在金额后的 `元` 会被漏掉，
  // 冲突判定失效。
  //
  // 再向前取**紧邻**的币种 marker：`USD 300 EUR/day` 的 `USD` 落在匹配跨度之外，
  // 只按跨度采集会漏掉它，pattern2/3 便把 300 当成 300EUR。窗口限 8 个非空白
  // 字符 → 仍只覆盖同一价格表达式，「日租 300 元，不收美元」的远处说明不受影响。
  const matchStart = parsed.match.index ?? 0
  const leadingWindow = normalized.slice(Math.max(0, matchStart - RENTAL_LEADING_CURRENCY_WINDOW), matchStart)
  const leadingCurrency = RENTAL_LEADING_CURRENCY_RE.exec(leadingWindow)?.[0]
  const expressionMarkers = [
    ...parsed.markers,
    ...parsed.match[0].match(new RegExp(RENTAL_CURRENCY, 'gi')) ?? [],
    ...(leadingCurrency !== undefined ? [leadingCurrency] : []),
  ]
  const expressionCurrencies = Array.from(new Set(
    expressionMarkers.map((marker) => rentalCurrency(marker)).filter((c): c is string => c !== undefined),
  ))
  if (expressionCurrencies.length > 1) return undefined
  const currency = expressionCurrencies[0]
  if (currency === undefined) return undefined
  const { min, max } = parsed
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 1_000_000) return undefined

  const taxStatus: RentalPriceQuote['taxStatus'] = /不含税|未含税/i.test(normalized)
    ? 'excluded'
    : /含税/i.test(normalized) ? 'included' : 'unknown'
  const vehicleMatch = /([^，,。；;：:]{0,24}(?:经济型|舒适型|豪华型|SUV|MPV|商务车|轿车|越野车|\d+座))/i.exec(normalized)
  return {
    range: [min, max],
    currency,
    taxStatus,
    vehicleType: vehicleMatch?.[1]?.trim() || '车型未标明',
    ...(referenceUrl !== undefined ? { referenceUrl } : {}),
  }
}

function rentalQueryText(pickup: ResolvedPlace, dropoff: ResolvedPlace | undefined, item: RentalQuoteRequest): string {
  return `查询${item.days}天${pickup.name}取车${dropoff === undefined ? '' : `${dropoff.name}还车`}的租车日租价格${item.seats === undefined ? '' : ` ${item.seats}座`}`
}

function rentalArtifactFingerprint(
  placesVersion: number,
  items: readonly RentalQuoteRequest[],
  sources: readonly string[] | undefined,
  request: TravelRequest,
): string {
  return createHash('sha256').update(JSON.stringify({
    placesVersion,
    items,
    sources: sources ?? ['*'],
    costContext: {
      dateStart: request.slots.dateStart,
      dateEnd: request.slots.dateEnd,
      days: request.slots.days,
      travelers: request.slots.travelers,
      budget: request.slots.budget,
    },
  })).digest('hex').slice(0, 24)
}

function redactRentalQuote(entry: RentalQuoteEntry): RentalQuoteEntry {
  return {
    ...entry,
    pickupPlaceId: redactSensitiveText(entry.pickupPlaceId),
    ...(entry.dropoffPlaceId !== undefined ? { dropoffPlaceId: redactSensitiveText(entry.dropoffPlaceId) } : {}),
    vehicleType: redactSensitiveText(entry.vehicleType),
    quote: {
      ...entry.quote,
      ...(entry.quote.referenceUrl !== undefined ? { referenceUrl: redactSensitiveUrl(entry.quote.referenceUrl) } : {}),
    },
    source: {
      ...entry.source,
      platform: redactSensitiveText(entry.source.platform),
      url: redactSensitiveUrl(entry.source.url),
    },
  }
}

function rentalDegradedEntries(artifact: RentalQuotesArtifact): DegradedEntry[] {
  return artifact.degraded.map((entry) => {
    const code: DegradedEntry['code'] = entry.code === 'UNAVAILABLE' || entry.code === 'EMPTY' || entry.code === 'TIMEOUT'
      || entry.code === 'NOISE' || entry.code === 'STALE' ? entry.code : 'UNAVAILABLE'
    return { source: entry.source, code, reason: entry.reason, at: entry.at }
  })
}

function redactRentalRecord(record: RentalQuoteRecord): RentalQuoteRecord {
  return {
    ...record,
    ...(record.pickupPlaceId !== undefined ? { pickupPlaceId: redactSensitiveText(record.pickupPlaceId) } : {}),
    ...(record.dropoffPlaceId !== undefined ? { dropoffPlaceId: redactSensitiveText(record.dropoffPlaceId) } : {}),
    ...(record.reason !== undefined ? { reason: redactSensitiveText(record.reason) } : {}),
  }
}

function rentalFailure(source: string, error: unknown, at: string): DegradedEntry {
  const engine = error instanceof EngineError ? error : toEngineError(error, source)
  return { source, code: engine.code, reason: redactSensitiveText(engine.message), at }
}

function requestedSource(sources: readonly string[] | undefined, source: string): boolean {
  return sources === undefined || sources.length === 0 || sources.includes('*') || sources.includes(source)
}

function isPlainRuntimeObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function isSafePositiveRuntimeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * 内部租车询价项：可执行项（pickup + days 齐备）与「缺上下文」项分开表达。
 *
 * 为什么不用 `days: 1` 之类的占位值：缺 days/pickup 时**根本不该询价**，用虚拟
 * 1 天会把「未提供租期」伪装成「租 1 天」，进而在 cost 里生成假区间。这里用显式
 * 缺失标志承载缺失事实，只有 executable=true 的项才会走到渠道。
 */
interface RentalQuoteInput {
  /** 原始输入项（保留用于记录投影的 placeId 回显）。 */
  pickupPlaceId?: string
  dropoffPlaceId?: string
  days?: number
  seats?: number
  /** pickupPlaceId 与 days 均有效 → 可询价。 */
  executable: boolean
  /** 不可询价的原因（executable=false 时必填）。 */
  missingContextReason?: string
}

/** 租车输入闸门结果：可执行项 + 需落 skipped 记录的缺上下文项。 */
interface RentalRequestGate {
  /** 可执行项（已剔除缺上下文项）。 */
  executable: RentalQuoteRequest[]
  /** 缺上下文项（pickup/days 缺失或空）——按批准契约落 skipped_missing_stay_context。 */
  skipped: RentalQuoteInput[]
  /** 字段所在入参名（错误文案与记录口径）。 */
  field: string
}

/**
 * 租车 phase 的运行时输入闸门；不让 InferArgs 的静态类型掩盖宿主 JSON/脚本调用。
 *
 * 硬拒绝（TravelValidationError，与既有 contract 一致）：两数组并存、非数组、
 * 空数组、超上限、元素非普通 object、pickup/dropoff 类型错误、days/seats 非有限
 * 正安全整数（含 NaN/Infinity）、dropoff 显式空串。
 *
 * 不硬拒绝而是落 skipped_missing_stay_context（批准契约 T26：「缺取车上下文 →
 * skipped_missing_stay_context 同款记录（不猜）」）：pickupPlaceId 缺失/空白，
 * days **缺失/纯空白字符串**。它们不访问任何渠道、不生成 fallback 假值，也不抛
 * 裸 TypeError。分类顺序是先判「缺」再判「非法」——空白 days 被当非法值硬拒绝，
 * 就等于把「没给租期」升级成输入错误，与批准契约相矛盾。
 */
function validateRentalRequests(args: ResearchDestinationArgs): RentalRequestGate {
  const quoteValue = args.quoteRequests as unknown
  const rentalValue = args.rentalQuoteRequests as unknown
  const hasQuoteRequests = quoteValue !== undefined
  const hasRentalQuoteRequests = rentalValue !== undefined
  if (hasQuoteRequests && hasRentalQuoteRequests) {
    throw new TravelValidationError(['phase=rental-quotes 的 quoteRequests 与 rentalQuoteRequests 互斥，不能同时提供'])
  }
  const field = hasRentalQuoteRequests ? 'rentalQuoteRequests' : 'quoteRequests'
  const value = hasRentalQuoteRequests ? rentalValue : quoteValue
  if (!Array.isArray(value)) {
    throw new TravelValidationError([`phase=rental-quotes 的 ${field} 必须为数组`])
  }
  if (value.length === 0) throw new TravelValidationError([`phase=rental-quotes 的 ${field} 不能为空数组`])
  if (value.length > RENTAL_QUOTES_MAX_ITEMS) {
    throw new TravelValidationError([`${field} ${value.length} 项超过上限 ${RENTAL_QUOTES_MAX_ITEMS}`])
  }

  const issues: string[] = []
  const executable: RentalQuoteRequest[] = []
  const skipped: RentalQuoteInput[] = []
  const isBlankString = (v: unknown): boolean => typeof v !== 'string' || v.trim() === ''
  value.forEach((raw, index) => {
    const path = `${field}[${index}]`
    if (!isPlainRuntimeObject(raw)) {
      issues.push(`${path} 必须为普通 object`)
      return
    }
    const pickup = raw['pickupPlaceId']
    const dropoff = raw['dropoffPlaceId']
    const days = raw['days']
    const seats = raw['seats']
    // T26 缺上下文判定必须先于类型校验：`days === undefined` 与「纯空白字符串」
    // 都是「没给租期」而不是「给了非法租期」。空串会被 JSON/脚本调用轻易带进来
    // （表单空值、CSV 列），若先当类型错误硬拒绝，就与「缺取车上下文 →
    // skipped_missing_stay_context（不猜、零渠道）」的批准契约相矛盾。
    // 其它「提供了值」的形态（null、非空字符串、NaN/Infinity/0/小数/负数）仍是
    // 实打实的输入错误 → TravelValidationError，不静默降级成 skipped。
    const daysMissingContext = days === undefined || (typeof days === 'string' && days.trim() === '')
    // 类型错误（提供但形状非法）仍硬拒绝；「缺失/空白」属缺上下文 → skipped。
    if (pickup !== undefined && typeof pickup !== 'string') issues.push(`${path}.pickupPlaceId 必须为非空 string`)
    if (dropoff !== undefined && (typeof dropoff !== 'string' || dropoff.trim() === '')) {
      issues.push(`${path}.dropoffPlaceId 若提供必须为非空 string`)
    }
    if (!daysMissingContext && !isSafePositiveRuntimeInteger(days)) issues.push(`${path}.days 必须为有限的正安全整数`)
    if (seats !== undefined && !isSafePositiveRuntimeInteger(seats)) issues.push(`${path}.seats 若提供必须为有限的正安全整数`)
    if (pickup !== undefined && typeof pickup !== 'string') return
    if (!daysMissingContext && !isSafePositiveRuntimeInteger(days)) return
    if (dropoff !== undefined && (typeof dropoff !== 'string' || dropoff.trim() === '')) return
    if (seats !== undefined && !isSafePositiveRuntimeInteger(seats)) return

    const pickupMissing = isBlankString(pickup)
    const daysMissing = daysMissingContext
    if (pickupMissing || daysMissing) {
      const missing: string[] = []
      if (pickupMissing) missing.push('pickupPlaceId')
      if (daysMissing) missing.push('days')
      skipped.push({
        ...(!pickupMissing ? { pickupPlaceId: (pickup as string).trim() } : {}),
        ...(dropoff !== undefined && typeof dropoff === 'string' ? { dropoffPlaceId: dropoff.trim() } : {}),
        ...(daysMissing ? {} : { days: days as number }),
        ...(seats !== undefined ? { seats: seats as number } : {}),
        executable: false,
        missingContextReason: `缺取车上下文（${missing.join('/')}），不猜取车点或租期，未发起询价`,
      })
      return
    }
    executable.push({
      pickupPlaceId: (pickup as string).trim(),
      ...(dropoff !== undefined ? { dropoffPlaceId: (dropoff as string).trim() } : {}),
      days: days as number,
      ...(seats !== undefined ? { seats: seats as number } : {}),
    })
  })
  if (issues.length > 0) throw new TravelValidationError(issues)
  return { executable, skipped, field }
}

interface RentalPlacesGate {
  placesVersion: number
  artifact?: PlacesArtifact
  blockedReason?: string
}

/** T26 专用 places/研究版本门：在幂等复用与任何渠道调用前执行。 */
async function rentalPlacesGate(
  args: ResearchDestinationArgs,
  store: TravelStore,
  planId: string,
): Promise<RentalPlacesGate> {
  const placesVersion = await store.currentVersion(planId, 'places')
  if (args.expectedResearchVersion !== undefined
    && (!Number.isSafeInteger(args.expectedResearchVersion) || args.expectedResearchVersion < 0)) {
    throw new TravelValidationError(['expectedResearchVersion 必须为非负安全整数'])
  }
  const state = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  if (!state.found) return { placesVersion, blockedReason: 'places_not_ready（缺少 places.json，请先 travel_resolve_places）' }
  if (state.status === 'failed' || state.meta?.status === 'failed') {
    return { placesVersion, blockedReason: 'places_failed（places 上次发布失败，不复活旧数据）' }
  }
  if (state.status === 'empty' || state.meta?.status === 'empty') {
    return { placesVersion, blockedReason: 'places_empty（places 上次发布为空，不复活旧数据）' }
  }
  // T26：places.json 的读状态只在「最近一次提交就是 places 发布」时才有校验力
  // （contentHash 仅覆盖最近 stage 的文件）。此时 places.json 缺席 contentHash
  // 即意味着工件被改写/替换，必须与 hash_mismatch 同等判 stale 并零渠道阻断。
  // 而最近提交属于其它 stage（如 rental-quotes）时，not_in_commit 是正常的
  // 「已被后续 stage 取代」，不构成篡改证据，不能据此阻断。
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') {
    return { placesVersion, blockedReason: 'places_stale（places 工件 hash mismatch，不复活旧数据）' }
  }
  if (state.status === 'stale' && state.staleReason === 'not_in_commit' && state.meta?.stage === 'places') {
    return { placesVersion, blockedReason: 'places_stale（places 工件不在最近 places 提交中，无法验证完整性，不复活旧数据）' }
  }
  // round3 仲裁（P2-2 与 T26 篡改门的口径合并）：未入账（manifest 中无该工件条目）
  // 的正确标签是 unknown/unaccounted（不得伪装 current/stale），但「无法验证完整性」
  // 的结论与 hash_mismatch 一致 —— 因此**篡改签名成立时**必须同等阻断：manifest 声称
  // 最近一次提交就是 places 发布，而 places.json 却不在其中，即工件被绕过发布流程直写
  // （writeJson）或替换。仅当最近提交属于其它 stage（尚未入账的正常中间态）时不阻断，
  // 与既有 not_in_commit 门控的判别口径保持一致。
  if (state.status === 'unknown' && state.staleReason === 'unaccounted' && state.meta?.stage === 'places') {
    return { placesVersion, blockedReason: 'places_stale（places 工件未入账（unaccounted），无法验证完整性，不复活旧数据）' }
  }
  const artifact = state.data
  if (placesVersion <= 0) {
    return { placesVersion, blockedReason: 'places_not_ready（缺少有效 places 版本账本，请先 travel_resolve_places）' }
  }
  if (artifact === undefined || !Array.isArray(artifact.places) || artifact.places.length === 0) {
    return { placesVersion, blockedReason: 'places_not_ready（当前 places 没有已解析 placeId）' }
  }
  if (artifact.status !== 'ready' || !Array.isArray(artifact.pendingClarifications) || artifact.pendingClarifications.length > 0) {
    return { placesVersion, blockedReason: 'places_not_ready（places 尚未完成解析或仍有待澄清地点）' }
  }
  if (artifact.places.some((place) => place.coordinate_source === 'unresolved' || place.coordinate_source === 'disabled'
    || place.pendingClarification !== undefined || place.excludeReason !== undefined)) {
    return { placesVersion, blockedReason: 'places_not_ready（places 含未解析、待澄清或已排除地点）' }
  }
  if (!Number.isSafeInteger(artifact.intelVersion) || artifact.intelVersion < 0) {
    return { placesVersion, blockedReason: 'places_stale（places.intelVersion 无效）' }
  }
  const researchStateRead = await store.readArtifactWithState<{ researchVersion?: unknown }>(planId, 'research-state.json')
  const researchState = readableArtifact(researchStateRead)
  const hasResearchVersion = typeof researchState?.researchVersion === 'number'
    && Number.isSafeInteger(researchState.researchVersion) && researchState.researchVersion >= 0
  const currentResearchVersion = hasResearchVersion ? researchState.researchVersion as number : 0
  if (args.expectedResearchVersion !== undefined && args.expectedResearchVersion !== currentResearchVersion) {
    return {
      placesVersion,
      blockedReason: `places_stale（expectedResearchVersion=${args.expectedResearchVersion}，current=${currentResearchVersion}）`,
    }
  }
  if (hasResearchVersion && artifact.intelVersion !== currentResearchVersion) {
    return {
      placesVersion,
      blockedReason: `places_stale（places.intelVersion=${artifact.intelVersion} 与当前 researchVersion=${currentResearchVersion} 不一致，请重新解析）`,
    }
  }
  if (args.expectedPlacesVersion !== undefined
    && (!Number.isSafeInteger(args.expectedPlacesVersion) || args.expectedPlacesVersion < 0)) {
    throw new TravelValidationError(['expectedPlacesVersion 必须为非负安全整数'])
  }
  if (args.expectedPlacesVersion !== undefined && args.expectedPlacesVersion !== placesVersion) {
    return {
      placesVersion,
      blockedReason: `places_stale（expectedPlacesVersion=${args.expectedPlacesVersion}，current=${placesVersion}）`,
    }
  }
  return { placesVersion, artifact }
}

function rentalBlockedResult(
  planId: string,
  placesVersion: number,
  items: readonly RentalQuoteRequest[],
  reason: string,
  now: string,
  skipped: readonly RentalQuoteInput[] = [],
): ResearchDestinationResult {
  const records: RentalQuoteRecord[] = [
    ...items.map((item) => ({
      pickupPlaceId: item.pickupPlaceId,
      ...(item.dropoffPlaceId !== undefined ? { dropoffPlaceId: item.dropoffPlaceId } : {}),
      status: 'rejected' as const,
      reason,
    })),
    // 缺上下文项在阻塞批里也如实回执（不因受阻而丢失缺上下文事实）。
    ...skipped.map((item) => rentalSkippedRecord(item)),
  ]
  return {
    planId,
    intelSummary: {} as Record<IntelChannel, number>,
    itemCount: 0,
    degraded: [{ source: 'rental-quotes', code: 'STALE', reason, at: now }],
    rentalQuotes: { quotes: [], records, placesVersion, consultationOnly: true },
  }
}

/** 缺上下文项 → skipped_missing_stay_context 记录（与 lodging 同款语义：不猜）。 */
function rentalSkippedRecord(item: RentalQuoteInput): RentalQuoteRecord {
  return {
    ...(item.pickupPlaceId !== undefined ? { pickupPlaceId: item.pickupPlaceId } : {}),
    ...(item.dropoffPlaceId !== undefined ? { dropoffPlaceId: item.dropoffPlaceId } : {}),
    status: 'skipped_missing_stay_context',
    reason: item.missingContextReason ?? '缺取车上下文，不猜取车点或租期，未发起询价',
  }
}

function safeRentalArtifact(artifact: RentalQuotesArtifact): RentalQuotesArtifact {
  return {
    ...artifact,
    quotes: (artifact.quotes ?? []).map(redactRentalQuote),
    records: (artifact.records ?? []).map(redactRentalRecord),
    degraded: (artifact.degraded ?? []).map((entry) => ({
      source: redactSensitiveText(entry.source),
      code: entry.code,
      reason: redactSensitiveText(entry.reason),
      at: entry.at,
    })),
    ...(artifact.requestId !== undefined ? { requestId: redactSensitiveText(artifact.requestId) } : {}),
    disclaimer: redactSensitiveText(artifact.disclaimer ?? RENTAL_DISCLAIMER),
  }
}

function unavailableCost(currency: string, assumption: string): CostComponent {
  return unavailableCostComponent(currency, assumption)
}

function costFromRanges(
  currency: string,
  ranges: readonly [number, number][],
  source: string,
  status: CostComponent['status'],
  assumptions: string[],
): CostComponent {
  return aggregateCostComponent(currency, ranges, source, status, assumptions)
}

function costFromSummedRanges(
  currency: string,
  ranges: readonly [number, number][],
  source: string,
  status: CostComponent['status'],
  assumptions: string[],
): CostComponent {
  return aggregateSummedCostComponent(currency, ranges, source, status, assumptions)
}

function lodgingNightsOfQuote(quote: PriceQuote): { nights: number; assumption?: string } {
  if (quote.unit !== 'roomNight') return { nights: 1 }
  if (quote.checkIn !== undefined && quote.checkOut !== undefined
    && isDateString(quote.checkIn) && isDateString(quote.checkOut)
    && quote.checkOut >= quote.checkIn) {
    return {
      nights: Math.max(1, daysBetweenInclusive(quote.checkIn, quote.checkOut) - 1),
    }
  }
  return { nights: 1, assumption: '住宿报价缺少明确入住上下文，最多按单晚计入，不按全程夜数猜测' }
}

function participantsOf(request: TravelRequest): number {
  const travelers = request.slots.travelers
  const total = (travelers?.adults ?? 0) + (travelers?.children ?? 0) + (travelers?.seniors ?? 0)
  return total > 0 ? total : 1
}

function aggregateCostComponents(components: Record<CostComponentKey, CostComponent>, currency: string): CostArtifact['total'] {
  let min = 0
  let max = 0
  for (const component of Object.values(components)) {
    // Every generated component is projected to artifact.currency.  Unavailable
    // entries are represented as the explicit [0, 0] component and remain in
    // this exact sum, rather than being silently skipped by currency.
    min += component.min
    max += component.max
  }
  return { min: Math.round(min * 100) / 100, max: Math.round(max * 100) / 100, currency }
}

/** unknown/未入账可读兼容；失败/空结果/hash 失配不可消费。 */
function readableArtifact<T>(state: ArtifactReadState<T>): T | undefined {
  if (!state.found || state.data === undefined || state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

function trustedCostInput<T>(state: ArtifactReadState<T>, owningStages: readonly string[] = []): T | undefined {
  // unknown/unaccounted is read-compatible but must remain visibly unknown;
  // failed, empty, and hash-mismatched inputs cannot be consumed. A manifest
  // that names this input's own stage while omitting the input is an integrity
  // signature, so do not revive that stage-owned snapshot either.
  if (!state.found || state.data === undefined || state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  if (isUnaccounted(state) && owningStages.includes(state.meta?.stage ?? '')) return undefined
  return state.data
}

function isUnaccounted<T>(state: ArtifactReadState<T>): boolean {
  return state.status === 'unknown'
    || (state.status === 'stale' && state.staleReason === 'not_in_commit')
}

export async function buildCostArtifact(
  planId: string,
  request: TravelRequest,
  store: TravelStore,
  placesVersion: number,
  rental: RentalQuotesArtifact | undefined,
  now: string,
  suppliedEstimates: readonly CostEstimate[] = [],
): Promise<CostArtifact> {
  const currency = (request.slots.budget?.currency ?? 'CNY').trim() || 'CNY'
  const lodgingState = await store.readArtifactWithState<LodgingQuotesArtifact>(planId, 'lodging-quotes.json')
  const transportState = await store.readArtifactWithState<TransportOption[]>(planId, 'transport.json')
  const intelState = await store.readArtifactWithState<IntelItem[]>(planId, 'intel.json')
  const priorCostState = await store.readArtifactWithState<CostArtifact>(planId, 'cost.json')
  const lodging = trustedCostInput(lodgingState, ['lodging-quotes'])
  const transport = trustedCostInput(transportState, ['transport'])
  const intel = trustedCostInput(intelState, ['research'])
  const priorCost = trustedCostInput(priorCostState, ['insights', 'rental-quotes'])
  const people = participantsOf(request)
  const components = {} as Record<CostComponentKey, CostComponent>
  const warnings: string[] = []
  const costInputs: Array<[string, ArtifactReadState<unknown>, readonly string[]]> = [
    ['住宿', lodgingState as ArtifactReadState<unknown>, ['lodging-quotes']],
    ['交通', transportState as ArtifactReadState<unknown>, ['transport']],
    ['情报', intelState as ArtifactReadState<unknown>, ['research']],
  ]
  for (const [label, state, owningStages] of costInputs) {
    if (isUnaccounted(state) && state.data !== undefined) {
      const ownStage = owningStages.includes(state.meta?.stage ?? '')
      warnings.push(ownStage
        ? `${label}上游工件未入账（${state.status}/${state.staleReason ?? 'unknown'}），最近一次为其所属阶段，无法验证完整性，相关成本未计入`
        : `${label}上游工件未入账（${state.status}/${state.staleReason ?? 'unknown'}），本次仅只读兼容消费，完整性无法证明`)
    } else if (state.status !== 'current' && state.status !== 'missing') {
      warnings.push(`${label}上游工件 ${state.status}/${state.staleReason ?? 'unavailable'} 不可信，相关成本未计入`)
    }
  }
  if (isUnaccounted(priorCostState) && priorCost !== undefined) {
    const ownStage = ['insights', 'rental-quotes'].includes(priorCostState.meta?.stage ?? '')
    warnings.push(ownStage
      ? `既有 cost.json 未入账（${priorCostState.status}/${priorCostState.staleReason ?? 'unknown'}），最近一次为成本所属阶段，无法验证完整性，成本估价不继承`
      : `既有 cost.json 未入账（${priorCostState.status}/${priorCostState.staleReason ?? 'unknown'}），成本估价仅只读兼容继承`)
  }

  const lodgingCurrent = lodging?.placesVersion === placesVersion ? lodging : undefined
  const lodgingEntries = lodgingCurrent !== undefined && Array.isArray(lodgingCurrent.quotes) ? lodgingCurrent.quotes : []
  const transportItems = Array.isArray(transport) ? transport : []
  const lodgingAssumptions: string[] = []
  if (lodging !== undefined && lodgingCurrent === undefined) {
    lodgingAssumptions.push(`住宿报价 placesVersion=${lodging.placesVersion} 已过期（当前 ${placesVersion}），未计入总额`)
    warnings.push(`住宿报价版本过期（placesVersion=${lodging.placesVersion}，当前=${placesVersion}），未计入总额`)
  }
  const lodgingRanges: [number, number][] = []
  // 币种闸门在换算之前：只有明确等于预算币种（trim 后逐字相等）的报价才允许进入
  // ranges。外币/空币种/未明确币种绝不重标为预算币种（无汇率即不换算、不猜）。
  const lodgingCurrencyOf = (entry: unknown): string | undefined => {
    if (!isPlainRuntimeObject(entry) || !isPlainRuntimeObject(entry['quote'])) return undefined
    const raw = entry['quote']['currency']
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    // 空串/纯空白是「未明确币种」而不是某个币种：必须归入 unknown 计数，
    // 绝不能当成「等于预算币种」而放行（空 != 预算币种）。
    return trimmed === '' ? undefined : trimmed
  }
  for (const entry of lodgingEntries) {
    if (!isPlainRuntimeObject(entry) || !isPlainRuntimeObject(entry['quote'])) continue
    const quote = entry['quote'] as unknown as PriceQuote
    if (lodgingCurrencyOf(entry) !== currency) continue
    if (!Array.isArray(quote.range) || quote.range.length !== 2) continue
    if (!Number.isFinite(quote.range[0]) || !Number.isFinite(quote.range[1])
      || quote.range[0] < 0 || quote.range[1] < quote.range[0]) continue
    const nightInfo = lodgingNightsOfQuote(quote)
    if (nightInfo.assumption !== undefined) lodgingAssumptions.push(nightInfo.assumption)
    const rooms = Number.isSafeInteger(quote.rooms) && (quote.rooms as number) > 0 ? quote.rooms as number : 1
    const multiplier = quote.unit === 'roomNight' ? nightInfo.nights * rooms : 1
    lodgingRanges.push([quote.range[0] * multiplier, quote.range[1] * multiplier])
  }
  // 未计入的两种情形分别如实记账：外币（明确但不同）与币种缺失/空值（无法判定）。
  const lodgingEntriesWithCurrency = lodgingEntries.filter((entry) => lodgingCurrencyOf(entry) !== undefined)
  const lodgingCurrencyMismatches = lodgingEntriesWithCurrency
    .filter((entry) => lodgingCurrencyOf(entry) !== currency).length
  const lodgingCurrencyUnknown = lodgingEntries.length - lodgingEntriesWithCurrency.length
  if (lodgingCurrencyMismatches > 0) {
    const message = `住宿报价存在 ${lodgingCurrencyMismatches} 条非 ${currency} 币种，无汇率，未计入`
    lodgingAssumptions.push(message)
    warnings.push(message)
  }
  if (lodgingCurrencyUnknown > 0) {
    const message = `住宿报价存在 ${lodgingCurrencyUnknown} 条未明确币种，无法判定是否与预算 ${currency} 一致，未计入`
    lodgingAssumptions.push(message)
    warnings.push(message)
  }
  components.lodging = costFromRanges(currency, lodgingRanges, 'lodging-quotes', 'quoted', [
    ...lodgingAssumptions,
    lodgingRanges.length > 0 ? '按每条 PriceQuote 的明确 checkIn/checkOut 实际晚数及房间数换算；不按全程 nights 猜测' : '未取得币种匹配且版本有效的住宿实价，未计入总额',
  ])

  const rentalQuotes = rental?.quotes ?? []
  const rentalRanges: [number, number][] = []
  for (const entry of rentalQuotes) {
    if (entry.quote.currency !== currency) continue
    if (!Number.isFinite(entry.quote.range[0]) || !Number.isFinite(entry.quote.range[1])
      || entry.quote.range[0] < 0 || entry.quote.range[1] < entry.quote.range[0]
      || !Number.isSafeInteger(entry.days) || entry.days <= 0) continue
    rentalRanges.push([entry.quote.range[0] * entry.days, entry.quote.range[1] * entry.days])
  }
  const rentalCurrencyMismatches = rentalQuotes.filter((entry) => entry.quote.currency !== currency).length
  if (rentalCurrencyMismatches > 0) {
    const message = `租车报价存在 ${rentalCurrencyMismatches} 条非 ${currency} 币种，无汇率，未计入`
    warnings.push(message)
  }
  components.rental = costFromSummedRanges(currency, rentalRanges, 'rental-quotes', 'quoted', [
    rentalRanges.length > 0 ? '每条租车请求独立按日租区间 × 该条 days 后求和；咨询级/非实时/不可预订' : '未取得可靠且币种匹配的租车日租金额，未计入总额',
  ])

  const transportRanges: [number, number][] = []
  let transportUnknownCurrency = 0
  let transportCurrencyMismatch = 0
  for (const option of transportItems) {
    if (!isPlainRuntimeObject(option)) continue
    const range = option['totalPriceRange']
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      || range[0] > range[1]) continue
    const optionCurrency = option['currency']
    if (typeof optionCurrency !== 'string' || optionCurrency.trim() === '') {
      transportUnknownCurrency += 1
    } else if (optionCurrency !== currency) {
      transportCurrencyMismatch += 1
    } else {
      transportRanges.push([range[0], range[1]])
    }
  }
  if (transportUnknownCurrency > 0) {
    const message = `城际交通有 ${transportUnknownCurrency} 条价格未明确币种，未计入（无汇率）`
    warnings.push(message)
  }
  if (transportCurrencyMismatch > 0) {
    const message = `城际交通有 ${transportCurrencyMismatch} 条价格币种与预算 ${currency} 不一致，无汇率，未计入`
    warnings.push(message)
  }
  components.intercityTransport = costFromRanges(currency, transportRanges, 'transport.json', 'quoted', [
    transportRanges.length > 0 ? '仅计入明确币种且与预算一致的城际交通价格，未进行汇率换算' : '未取得明确币种且与预算一致的城际交通价格，未计入总额',
  ])

  const intelItems = Array.isArray(intel) ? intel : []
  const hasUnqualifiedTicketPrice = intelItems.some((item) => isPlainRuntimeObject(item) && item.category === 'attraction'
    && item.avgPrice !== undefined && Number.isFinite(item.avgPrice) && item.avgPrice >= 0)
  components.tickets = unavailableCost(currency, hasUnqualifiedTicketPrice
    ? '景点 avgPrice 未显式携带币种，未推断为预算币种，未计入总额'
    : '未取得带明确币种的景点门票金额，未计入总额')

  const hasUnqualifiedFoodPrice = intelItems.some((item) => isPlainRuntimeObject(item) && item.category === 'food'
    && item.avgPrice !== undefined && Number.isFinite(item.avgPrice) && item.avgPrice >= 0)
  components.food = unavailableCost(currency, hasUnqualifiedFoodPrice
    ? '美食 avgPrice 未显式携带币种，未推断为预算币种，未计入总额'
    : '未取得带明确币种的餐饮金额，未计入总额')
  components.misc = unavailableCost(currency, '未提供杂项金额，未计入总额')

  // UGC/外部汇总只能经调用方显式 costEstimates 进入；先前已验证估价
  // 从 cost.json 继承，确保后续租车/住宿重算不会丢失，也不会重复消费。
  const estimates: CostEstimate[] = suppliedEstimates.length > 0
    ? [...suppliedEstimates]
    : [...(priorCost?.costEstimates ?? [])]
  applyCostEstimates(components, estimates, currency, warnings)
  const total = aggregateCostComponents(components, currency)
  for (const [key, component] of Object.entries(components) as Array<[CostComponentKey, CostComponent]>) {
    if (component.status === 'unavailable') warnings.push(`成本项 ${key} 未取得可靠金额，未计入总额`)
  }
  const budgetAmount = request.slots.budget?.amount
  const budgetScope: BudgetScope = request.slots.budget?.scope ?? 'total'
  const budget = budgetAmount !== undefined && Number.isFinite(budgetAmount) && budgetAmount >= 0
    ? { amount: budgetAmount, scope: budgetScope, currency }
    : undefined
  if (budget !== undefined && budget.currency === currency) {
    const comparable = budget.scope === 'perPerson' ? total.max / people : total.max
    if (comparable > budget.amount) {
      warnings.push(`预算可能超支：估算上限 ${comparable.toFixed(2)} ${currency} 超过预算 ${budget.amount.toFixed(2)} ${currency}（口径=${budget.scope}）`)
    }
  }
  const assumptions = Array.from(new Set([
    'cost.json 仅聚合已有报价或明确标注的估算，不补填缺失价格，不做汇率换算。',
    ...Object.values(components).flatMap((component) => component.assumptions),
  ]))
  const sourceFingerprint = {
    placesVersion,
    lodging: lodging?.inputFingerprint,
    transport: transport === undefined ? undefined : JSON.stringify(transport),
    intel: intel === undefined ? undefined : JSON.stringify(intel),
    rental: rental?.inputFingerprint,
    costEstimates: estimates,
    currency,
    request: {
      dateStart: request.slots.dateStart,
      dateEnd: request.slots.dateEnd,
      days: request.slots.days,
      travelers: request.slots.travelers,
      budget: request.slots.budget,
    },
  }
  const inputFingerprint = createHash('sha256').update(JSON.stringify(sourceFingerprint)).digest('hex').slice(0, 24)
  return {
    schemaVersion: 2,
    placesVersion,
    inputFingerprint,
    generatedAt: now,
    currency,
    components,
    total,
    ...(budget !== undefined ? { budget } : {}),
    ...(estimates.length > 0 ? { costEstimates: estimates } : {}),
    warnings,
    assumptions,
  }
}

async function runRentalQuotes(
  args: ResearchDestinationArgs,
  request: TravelRequest,
  store: TravelStore,
  deps: ResearchToolDeps,
): Promise<ResearchDestinationResult> {
  const now = new Date().toISOString()
  const planId = args.planId
  assertTransition(request.status, 'researching')
  const gate = validateRentalRequests(args)
  const items = gate.executable
  assertSourcesAllowed(args.sources)

  // The health/version gate deliberately precedes requestId reuse and all adapters.
  // A stale snapshot must neither replay old data nor overwrite a successful artifact.
  const placesGate = await rentalPlacesGate(args, store, planId)
  if (placesGate.blockedReason !== undefined) {
    return rentalBlockedResult(planId, placesGate.placesVersion, items, placesGate.blockedReason, now, gate.skipped)
  }
  const placesVersion = placesGate.placesVersion
  let suppliedEstimates: CostEstimate[] = []
  const unknownCostInputWarnings: string[] = []
  if (args.costEstimates !== undefined) {
    const normalized = normalizeCostEstimates(args.costEstimates)
    if (normalized.issues.length > 0) {
      throw new TravelValidationError(normalized.issues.map((issue) => `${issue.path}: ${issue.message}`))
    }
    const intelState = await store.readArtifactWithState<IntelItem[]>(planId, 'intel.json')
    const intelData = trustedCostInput(intelState)
    if (intelState.status === 'unknown' && intelData !== undefined) {
      unknownCostInputWarnings.push(`intel.json 未入账（${intelState.staleReason ?? 'unknown'}），costEstimates 证据仅只读兼容校验`)
    }
    const intelIds = new Set(Array.isArray(intelData) ? intelData.map((item) => item.id) : [])
    const missingEvidence: string[] = []
    for (const estimate of normalized.estimates) {
      for (const ref of estimate.evidenceRefs) {
        if (intelIds.has(ref)) continue
        const separator = ref.lastIndexOf('@')
        if (separator <= 0) {
          missingEvidence.push(ref)
          continue
        }
        const contentRef = ref.slice(0, separator)
        const contentVersion = ref.slice(separator + 1)
        if (!intelIds.has(contentRef)) {
          missingEvidence.push(ref)
          continue
        }
        const content = await store.readResearchContent<ResearchContentArtifact>(planId, contentRef, contentVersion)
        if (content === undefined || content.contentVersion !== contentVersion
          || (content.contentStatus !== 'extracted' && content.contentStatus !== 'partial')) missingEvidence.push(ref)
      }
    }
    if (missingEvidence.length > 0) {
      throw new TravelValidationError([`costEstimates 证据不存在于当前 intel/正文版本：${[...new Set(missingEvidence)].join(', ')}`])
    }
    suppliedEstimates = normalized.estimates
  }
  const placeById = new Map<string, ResolvedPlace>()
  for (const place of placesGate.artifact!.places) {
    if (typeof place.placeId === 'string' && place.placeId.trim() !== '') placeById.set(place.placeId, place)
  }
  const inputFingerprint = rentalArtifactFingerprint(placesVersion, items, args.sources, request)
  const previousState = await store.readArtifactWithState<RentalQuotesArtifact>(planId, 'rental-quotes.json')
  const previous = previousState.data
  if (args.requestId !== undefined && previous?.requestId === args.requestId) {
    if (previousState.status === 'failed' || previousState.status === 'empty' || previousState.status === 'stale' && previousState.staleReason === 'hash_mismatch') {
      return rentalBlockedResult(planId, placesVersion, items, `rental-quotes_stale（不能复用 ${previousState.status}/${previousState.staleReason ?? 'failed'} 工件）`, now, gate.skipped)
    }
    if (previous.inputFingerprint !== inputFingerprint || previous.placesVersion !== placesVersion) {
      throw new TravelValidationError([`requestId=${args.requestId} 已用于不同租车询价/成本参数，拒绝复用`])
    }
    const previousIssues = validateRentalQuotes(previous)
    if (previousIssues.length > 0) {
      return rentalBlockedResult(planId, placesVersion, items, 'rental-quotes_stale（既有工件校验失败，不能幂等复用）', now, gate.skipped)
    }
    const safePrevious = safeRentalArtifact(previous)
    const priorCostState = await store.readArtifactWithState<CostArtifact>(planId, 'cost.json')
    const priorCost = priorCostState.status === 'failed' || priorCostState.status === 'empty'
      || priorCostState.status === 'stale' && priorCostState.staleReason === 'hash_mismatch'
      ? undefined : priorCostState.data
    return {
      planId, intelSummary: {} as Record<IntelChannel, number>, itemCount: safePrevious.quotes.length,
      degraded: rentalDegradedEntries(safePrevious),
      idempotent: { requestId: args.requestId, roundId: 'rental-quotes', observedAt: safePrevious.generatedAt },
      rentalQuotes: { quotes: safePrevious.quotes, records: safePrevious.records, placesVersion, consultationOnly: true },
      ...(priorCost !== undefined ? { cost: priorCost } : {}),
    }
  }
  const quotes: RentalQuoteEntry[] = []
  const records: RentalQuoteRecord[] = []
  const degraded: DegradedEntry[] = []
  for (const reason of unknownCostInputWarnings) {
    degraded.push({ source: 'rental-quotes/cost', code: 'UNAVAILABLE', reason, at: now })
  }
  let usableInputCount = 0
  let wendaoAvailable: boolean | undefined
  let searchAvailable: boolean | undefined
  const sources = args.sources

  const queryWendao = async (query: string): Promise<RentalPriceCandidate | undefined> => {
    const adapter = deps.wendao
    if (!requestedSource(sources, RENTAL_PRIMARY_SOURCE) || adapter === undefined) return undefined
    if (wendaoAvailable === undefined) {
      try { wendaoAvailable = await adapter.available(deps.env) } catch { wendaoAvailable = false }
      if (!wendaoAvailable) degraded.push({ source: RENTAL_PRIMARY_SOURCE, code: 'UNAVAILABLE', reason: '问道渠道不可用（Key/开关缺失），尝试既有搜索 fallback', at: now })
    }
    if (!wendaoAvailable) return undefined
    try {
      const result = await adapter.query(query, deps.env)
      degraded.push(...result.degraded)
      for (const entry of result.entries) {
        const parsed = parseRentalPrice(`${entry.title} ${entry.summary}`, entry.deepLinks[0])
        if (parsed !== undefined) return { ...parsed, source: RENTAL_PRIMARY_SOURCE }
      }
    } catch (error) {
      degraded.push(rentalFailure(RENTAL_PRIMARY_SOURCE, error, now))
    }
    return undefined
  }

  const querySearch = async (query: string): Promise<RentalPriceCandidate | undefined> => {
    const adapter = deps.search
    if (!requestedSource(sources, RENTAL_FALLBACK_SOURCE) || adapter === undefined) return undefined
    if (searchAvailable === undefined) {
      try { searchAvailable = await adapter.available() } catch { searchAvailable = false }
      if (!searchAvailable) degraded.push({ source: RENTAL_FALLBACK_SOURCE, code: 'UNAVAILABLE', reason: '既有搜索/DDG fallback 未装配', at: now })
    }
    if (!searchAvailable) return undefined
    try {
      const result = await adapter.searchL0({ keywords: query, sites: ['duckduckgo.com'], maxResultsPerQuery: 8 })
      for (const hit of result.data.hits) {
        const parsed = parseRentalPrice(`${hit.title} ${hit.summary ?? ''}`, hit.url)
        if (parsed !== undefined) return { ...parsed, source: RENTAL_FALLBACK_SOURCE }
      }
      degraded.push({ source: RENTAL_FALLBACK_SOURCE, code: 'EMPTY', reason: '搜索 fallback 无可验证日租金额', at: now })
    } catch (error) {
      degraded.push(rentalFailure(RENTAL_FALLBACK_SOURCE, error, now))
    }
    return undefined
  }

  // 缺上下文项先落 skipped 记录：它们既不访问渠道，也不生成任何 fallback 金额。
  for (const item of gate.skipped) {
    records.push(rentalSkippedRecord(item))
  }

  for (const item of items) {
    const pickupId = item.pickupPlaceId
    const dropoffId = item.dropoffPlaceId
    const pickup = placeById.get(pickupId)
    const dropoff = dropoffId === undefined ? undefined : placeById.get(dropoffId)
    if (pickup === undefined || (dropoffId !== undefined && dropoff === undefined)) {
      records.push({ pickupPlaceId: pickupId, ...(dropoffId !== undefined ? { dropoffPlaceId: dropoffId } : {}), status: 'rejected', reason: 'unknown_place（取还车地点必须来自当前 places 解析结果）' })
      continue
    }
    // Only a request whose pickup and optional dropoff both resolve is allowed
    // to reach Wendao/search; unknown-place batches must never trigger channels.
    usableInputCount += 1
    const query = rentalQueryText(pickup, dropoff, item)
    const parsed = await queryWendao(query) ?? await querySearch(query)
    if (parsed === undefined) {
      if (requestedSource(sources, RENTAL_PRIMARY_SOURCE) || requestedSource(sources, RENTAL_FALLBACK_SOURCE)) {
        degraded.push({ source: 'rental-quotes', code: 'EMPTY', reason: `取车地点 ${pickupId} 未取得含货币与日单位的可靠租车咨询金额`, at: now, placeId: pickupId })
      }
      records.push({ pickupPlaceId: pickupId, ...(dropoffId !== undefined ? { dropoffPlaceId: dropoffId } : {}), status: 'blocked', reason: '渠道无可验证日租金额，不填假区间' })
      continue
    }
    const quote: RentalPriceQuote = {
      range: parsed.range, currency: parsed.currency, unit: 'day', observedAt: now, taxStatus: parsed.taxStatus,
      ...(parsed.referenceUrl !== undefined ? { referenceUrl: parsed.referenceUrl } : {}),
    }
    quotes.push({
      pickupPlaceId: pickupId, ...(dropoffId !== undefined ? { dropoffPlaceId: dropoffId } : {}), days: item.days,
      ...(item.seats !== undefined ? { seats: item.seats } : {}), vehicleType: parsed.vehicleType, quote,
      source: { platform: parsed.source ?? RENTAL_PRIMARY_SOURCE, url: parsed.referenceUrl ?? 'https://wendao-skill-prod.ctrip.com/skill/query', fetchedAt: now },
    })
    records.push({ pickupPlaceId: pickupId, ...(dropoffId !== undefined ? { dropoffPlaceId: dropoffId } : {}), status: 'quoted' })
  }

  const safeQuotes = quotes.map(redactRentalQuote)
  const safeRecords = records.map(redactRentalRecord)
  if (usableInputCount === 0) {
    // 没有任何询价证据（全 unknown place / 全缺上下文）的批不是成功产物：它既
    // 不得用空数据覆盖既有成功工件，也不得凭空生成 cost（缺上下文不是报价）。
    // 记录仍如实回执（skipped/rejected 计数对调用方可见）。
    return {
      planId,
      intelSummary: {} as Record<IntelChannel, number>,
      itemCount: 0,
      degraded: degraded.map(redactDegradedEntry),
      rentalQuotes: { quotes: safeQuotes, records: safeRecords, placesVersion, consultationOnly: true },
    }
  }
  const safeDegraded = degraded.map(redactDegradedEntry)
  const rentalArtifact: RentalQuotesArtifact = {
    schemaVersion: 1, placesVersion, inputFingerprint, generatedAt: now,
    quotes: safeQuotes, records: safeRecords,
    degraded: safeDegraded.map(({ source, code, reason, at }) => ({ source, code, reason, at })),
    ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
    consultationOnly: true,
    disclaimer: RENTAL_DISCLAIMER,
  }
  const cost = await buildCostArtifact(planId, request, store, placesVersion, rentalArtifact, now, suppliedEstimates)
  assertValidIssues(validateRentalQuotes(rentalArtifact), 'rental-quotes.')
  assertValidIssues(validateCostArtifact(cost), 'cost.')
  await store.publishArtifacts(planId, {
    stage: 'rental-quotes',
    files: [{ name: 'rental-quotes.json', data: rentalArtifact }, { name: 'cost.json', data: cost }],
    expectedVersions: { places: placesVersion },
    bump: ['rental', 'cost'],
    inputFingerprint,
  })
  for (const entry of safeDegraded) await store.recordDegraded(planId, entry)
  await store.saveRequest({ ...request, status: 'researching', updatedAt: now })
  return {
    planId, intelSummary: {} as Record<IntelChannel, number>, itemCount: safeQuotes.length, degraded: safeDegraded,
    rentalQuotes: { quotes: safeQuotes, records: safeRecords, placesVersion, consultationOnly: true }, cost,
  }
}

function continuationOf(args: ResearchDestinationArgs): { source: string; cursor?: string } | undefined {
  return args.continuation
}

/**
 * 内容抑制键（同轮/跨轮 union 与 newItemIds）；与 fanout 聚合键共用同一 helper。
 * B3 T9 双键语义：provenanceKey 另行记录 round/channel/contentId，绝不混入这里。
 */
function intelDedupKeyOf(item: IntelItem): string {
  return intelDedupKey(item)
}

/**
 * 稳定可复现的查询级审计印记（兼容此前 scope:<hash> 形态；不是 R2 dedup key）。
 * 由研究流标识 + 规范化本轮回执参数确定性派生：同参（计划 + 目的地/兴趣 +
 * keywords + categories + sources）必得同值，不含时钟/roundId。它只写入
 * round.query.scopeKey，便于查询变化追溯；每条观察的 round/channel/contentId 追溯必须
 * 使用 provenanceKeyOf，内容抑制仍使用 intelDedupKeyOf。
 */
type LegacyResearchStateIndexItem = ResearchStateIndexItem & { scopeKey?: string }

/** 迁移旧 T9 尝试的 index scopeKey；查询审计只留在 round.query.scopeKey。 */
function dropLegacyScopeKey(item: ResearchStateIndexItem): ResearchStateIndexItem {
  const legacy = item as LegacyResearchStateIndexItem
  const { scopeKey: _scopeKey, ...clean } = legacy
  return clean
}

function aggregateDegraded(entries: readonly DegradedEntry[]): DegradedEntry[] {
  const groups = new Map<string, { entry: DegradedEntry; count: number }>()
  for (const entry of entries) {
    const key = `${entry.source}\u0000${entry.code}\u0000${entry.reason}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { entry, count: 1 })
    else group.count += 1
  }
  return [...groups.values()].map(({ entry, count }) => ({ ...entry, count }))
}

function scopeKeyOf(inputs: {
  planId: string
  destination: string | undefined
  intentText: string | undefined
  keywords: string[]
  categories: readonly IntelCategory[]
  sources: string[]
}): string {
  const payload = JSON.stringify([
    inputs.planId,
    inputs.destination ?? inputs.intentText ?? '',
    inputs.keywords,
    [...inputs.categories].sort(),
    inputs.sources.filter((s) => s !== '*').sort(),
  ])
  return `scope:${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`
}

async function loadStateOrInit(store: TravelStore, planId: string, maxRounds: number): Promise<ResearchState> {
  const existing = await store.loadResearchState<ResearchState>(planId)
  if (existing !== undefined) return existing
  return emptyResearchState(planId, maxRounds)
}

/** 同 requestId 同参幂等查找：命中返回原轮次回执（回显原 observedAt）。 */
async function findIdempotentRound(
  store: TravelStore,
  planId: string,
  requestId: string,
  args: ResearchDestinationArgs,
): Promise<{ roundId: string; observedAt: string } | undefined> {
  const state = await store.loadResearchState<ResearchState>(planId)
  if (state === undefined) return undefined
  for (const roundId of [...state.rounds].reverse()) {
    const round = await store.readResearchRound<ResearchRound>(planId, roundId)
    if (round?.query.requestId === requestId) {
      // 同 ID 不同参 → 拒绝（幂等边界：仅完全同参重放）
      if (!sameParam(requestId, round, args)) {
        throw new TravelValidationError([`requestId ${requestId} 复用但参数不同：幂等仅允许同参重放`])
      }
      return { roundId, observedAt: round.observedAt }
    }
  }
  return undefined
}

/** requestId 幂等参数归一化比对（keywords/sources/categories/continuation）。 */
function sameParam(requestId: string, round: ResearchRound, args: ResearchDestinationArgs): boolean {
  void requestId
  const kwSame = keywordsMatch(round.query.keywords, args.keywords)
  if (!kwSame) return false
  const srcSame = sourcesMatch(round.query.sources, args.sources)
  if (!srcSame) return false
  const catSame = categoriesMatch(round.query.categories, args.categories)
  if (!catSame) return false
  const contSame = continuationMatch(round.query.continuation, args.continuation)
  return contSame
}

function keywordsMatch(prev: string[], next: string[] | undefined): boolean {
  const key = JSON.stringify(prev)
  const nextKw = next ?? []
  return key === JSON.stringify([...nextKw]) || key === JSON.stringify(dedupeTrim(next ?? [], RESEARCH_KEYWORDS_MAX))
}

function sourcesMatch(prev: string[], next: string[] | undefined): boolean {
  const a = [...(prev ?? [])].sort()
  const b = [...(next ?? ['*'])].sort()
  return JSON.stringify(a) === JSON.stringify(b)
}

function categoriesMatch(prev: IntelCategory[], next: IntelCategory[] | undefined): boolean {
  return JSON.stringify([...(prev ?? [])].sort()) === JSON.stringify([...(next ?? [...ALL_INTEL_CATEGORIES])].sort())
}

function continuationMatch(prev: { source: string; cursor?: string } | undefined, next: { source: string; cursor?: string } | undefined): boolean {
  return JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectResearch(r: ResearchDestinationResult): ResearchOutput {
  return {
    planId: r.planId,
    intelSummary: JSON.parse(JSON.stringify(r.intelSummary)) as ResearchOutput['intelSummary'],
    itemCount: r.itemCount,
    degraded: [...r.degraded],
    ...(r.round !== undefined ? { round: JSON.parse(JSON.stringify(r.round)) as ResearchOutput['round'] } : {}),
    ...(r.budgetExhausted !== undefined
      ? { budgetExhausted: JSON.parse(JSON.stringify(r.budgetExhausted)) as ResearchOutput['budgetExhausted'] } : {}),
    ...(r.idempotent !== undefined
      ? { idempotent: JSON.parse(JSON.stringify(r.idempotent)) as ResearchOutput['idempotent'] } : {}),
    ...(r.lodgingQuotes !== undefined
      ? { lodgingQuotes: JSON.parse(JSON.stringify(r.lodgingQuotes)) as ResearchOutput['lodgingQuotes'] } : {}),
    ...(r.rentalQuotes !== undefined
      ? { rentalQuotes: JSON.parse(JSON.stringify(r.rentalQuotes)) as ResearchOutput['rentalQuotes'] } : {}),
    ...(r.cost !== undefined
      ? { cost: JSON.parse(JSON.stringify(r.cost)) as ResearchOutput['cost'] } : {}),
  }
}

function escapeMarkdownInline(value: unknown): string {
  return String(value ?? '').replace(/[\\`*_[\]{}()#+.!|>~-]/g, '\\$&')
}

function renderResearch(_args: ResearchParams, value: ResearchOutput): ContentBlock[] {
  const idempotent = value.idempotent as { requestId: string; roundId: string; observedAt: string } | undefined
  const budgetExhausted = value.budgetExhausted as
    { usedRounds: number; maxRoundsPerPlan: number; remainingRounds: number; recovery: string } | undefined
  const round = value.round as { roundId: string; newItemIds: string[]; budget: { usedRounds: number; maxRoundsPerPlan: number } } | undefined
  const lq = value.lodgingQuotes as
    { quotes: Array<{ placeId: string; quote: { range: number[]; currency: string } }>; records: Array<{ placeId: string; status: string; reason?: string }> } | undefined
  const rq = value.rentalQuotes as
    { quotes: Array<{ pickupPlaceId: string; dropoffPlaceId?: string; days: number; vehicleType: string; quote: { range: number[]; currency: string; unit: string } }>; records: Array<{ pickupPlaceId?: string; status: string; reason?: string }>; consultationOnly: boolean } | undefined
  if (rq !== undefined) {
    const quoted = rq.records.filter((r) => r.status === 'quoted')
    const skipped = rq.records.filter((r) => r.status === 'skipped_missing_stay_context')
    const blocked = rq.records.filter((r) => r.status === 'blocked')
    const rejected = rq.records.filter((r) => r.status === 'rejected')
    const summary = rq.quotes.map((q) => `${escapeMarkdownInline(q.vehicleType)} ${q.quote.range[0]}~${q.quote.range[1]} ${escapeMarkdownInline(q.quote.currency)}/${escapeMarkdownInline(q.quote.unit)} ×${q.days}天`).join('；')
    const lines: [string, string][] = [
      ['planId', escapeMarkdownInline(value.planId)],
      ['记录', `${rq.records.length} 项（quoted=${quoted.length} / skipped=${skipped.length} / blocked=${blocked.length} / rejected=${rejected.length}）`],
      ['语义', rq.consultationOnly ? '咨询级、非实时、不可预订' : '未知'],
    ]
    if (summary !== '') lines.push(['租车咨询', summary])
    if (blocked.length > 0) lines.push(['blocked', blocked.map((b) => `${escapeMarkdownInline(b.pickupPlaceId ?? '')}:${escapeMarkdownInline(b.reason ?? '')}`).join('；')])
    if (value.cost !== undefined) {
      const cost = value.cost as { total: { min: number; max: number; currency: string }; warnings: string[] }
      lines.push(['成本摘要', `${cost.total.min}~${cost.total.max} ${cost.total.currency}`])
      if (cost.warnings.length > 0) lines.push(['成本提示', cost.warnings.map(escapeMarkdownInline).join('；')])
    }
    if (value.degraded.length > 0) lines.push(['降级记录', value.degraded.map((d) => `${escapeMarkdownInline(d.source)}[${escapeMarkdownInline(d.code)}]：${escapeMarkdownInline(d.reason)}`).join('；')])
    return textCard(`**travel_research_destination** · 租车咨询报价（B6）\n${cardLines(lines)}\n> 详情已写入 rental-quotes.json；cost.json 为预算摘要。报价仅供咨询，不能预订`)
  }
  if (lq !== undefined) {
    const quoted = lq.records.filter((r) => r.status === 'quoted')
    const skipped = lq.records.filter((r) => r.status === 'skipped_missing_stay_context')
    const blocked = lq.records.filter((r) => r.status === 'blocked')
    const rejected = lq.records.filter((r) => r.status === 'rejected')
    const summary = lq.quotes.map((q) => `¥${q.quote.range[0]}~${q.quote.range[1]} ${q.quote.currency}`).join('；')
    const lines: [string, string][] = [
      ['planId', value.planId],
      ['记录', `${lq.records.length} 项（quoted=${quoted.length} / skipped=${skipped.length} / blocked=${blocked.length} / rejected=${rejected.length}）`],
    ]
    if (summary !== '') lines.push(['报价', summary])
    if (blocked.length > 0) {
      lines.push(['blocked', blocked.map((b) => `${b.placeId}:${b.reason ?? ''}`).join('；')])
    }
    if (value.degraded.length > 0) {
      lines.push(['降级记录', value.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}${d.count !== undefined ? `（count=${d.count}）` : ''}`).join('；')])
    }
    return textCard(`**travel_research_destination** · 定向酒店报价（T14）\n${cardLines(lines)}\n> 详情已写入 lodging-quotes.json（独立版本工件；报价不使 intel/places 失效）`)
  }
  const lines: [string, string][] = [
    ['planId', value.planId],
    ['条目总数', String(value.itemCount)],
  ]
  const summary = value.intelSummary as Record<string, number>
  const entries = Object.entries(summary)
  if (entries.length > 0) {
    lines.push(['渠道分布', entries.map(([ch, n]) => `${ch}=${n}`).join('，')])
  } else {
    lines.push(['渠道分布', '（无条目）'])
  }
  if (idempotent !== undefined) {
    lines.push(['幂等重放', `requestId=${idempotent.requestId}，原轮次 ${idempotent.roundId}（observedAt ${idempotent.observedAt}）`])
  }
  if (budgetExhausted !== undefined) {
    lines.push(['额度耗尽', `used=${budgetExhausted.usedRounds}/${budgetExhausted.maxRoundsPerPlan}，恢复：${budgetExhausted.recovery}`])
  }
  if (round !== undefined) {
    lines.push(['本轮轮次', round.roundId])
    lines.push(['增量条目', String(round.newItemIds.length)])
    lines.push(['预算', `${round.budget.usedRounds}/${round.budget.maxRoundsPerPlan}`])
  }
  if (value.degraded.length > 0) {
    lines.push(['降级记录', value.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}${d.count !== undefined ? `（count=${d.count}）` : ''}`).join('；')])
  }
  let text = `**travel_research_destination** · 情报检索\n${cardLines(lines)}\n> 详情条目已写入 intel.json（对话内仅摘要）`
  if (value.itemCount === 0 && round === undefined && budgetExhausted === undefined && idempotent === undefined) {
    text += '\n> ⚠ 全部检索渠道失败/无结果，未生成 intel.json（§9.3-6）。请检查网络与配置后重试 travel_research_destination，或降低 categories 范围。'
  }
  return textCard(text)
}

/** 工具定义工厂（store + 渠道清单注入）。 */
export function createTravelResearchDestinationTool(store: TravelStore, deps: ResearchToolDeps): ToolDefinition {
  return defineTool({
    name: 'travel_research_destination',
    description: '目的地情报检索（七渠道 fan-out + W1 DR1 调用方可控多轮增量：keywords?/sources?/requestId?/expectedResearchVersion?/continuation?；每轮追加合并+跨轮去重，写 research-rounds 并推进 research-state；requestId 幂等回显原回执；研究额度达边界 → budget_exhausted 不标 sufficient；discovery-only 仅兴趣种子可先发现）。T14 住宿定向报价与 B6 租车咨询报价：phase=lodging-quotes/rental-quotes 均≤20项；租车走 Wendao→Search/DDG 降级链，仅解析明确日租金额，非实时且不可预订，仅接受 resolve 校验住宿候选/区域；无入住条件 → skipped_missing_stay_context 不猜每城住满；DIDA 默认 off/缺 Key → blocked 零调用；报价落独立 lodging-quotes.json/rental-quotes.json，不使 intel/places 失效；租车阶段另生成 cost.json，缺数据项显式 unavailable，不填假价。详情可落 intel.json / lodging-quotes.json，对话内只回摘要卡片；单渠道失败计入 degraded 不阻塞其余渠道；全渠道失败不产空产物。',
    parameters: RESEARCH_PARAMETERS,
    output: {
      schema: RESEARCH_OUTPUT_SCHEMA,
      render: renderResearch,
    },
    timeoutMs: deps.timeoutMs ?? RESEARCH_TIMEOUT_MS,
    // 进度反馈（docs/research/dsh-plugin-api.md：defineTool presentCall 宿主面可用）：
    // 调用即呈现「正在检索 X 类信息」的 pending 卡，直至 execute 返回
    presentCall(args) {
      const phase = args?.phase === 'lodging-quotes'
        ? '（定向酒店报价）'
        : args?.phase === 'rental-quotes' ? '（租车咨询报价）' : ''
      const categories = Array.isArray(args?.categories) ? (args.categories as string[]).join('/') : '7 类'
      return {
        card: 'generic',
        title: `正在检索目的地情报${phase}（类别：${categories}）`,
        kind: 'search',
      }
    },
    async execute(args) {
      const result = await runResearchDestination({
        planId: args.planId,
        categories: args.categories as IntelCategory[] | undefined,
        depth: args.depth,
        keywords: args.keywords,
        sources: args.sources,
        requestId: args.requestId,
        expectedResearchVersion: args.expectedResearchVersion,
        continuation: args.continuation,
        phase: args.phase as ResearchDestinationPhase | undefined,
        quoteRequests: args.quoteRequests as Array<LodgingQuoteRequest | RentalQuoteRequest> | undefined,
        rentalQuoteRequests: args.rentalQuoteRequests as RentalQuoteRequest[] | undefined,
        expectedPlacesVersion: args.expectedPlacesVersion,
         costEstimates: args.costEstimates as CostEstimateInput[] | undefined,
      }, store, deps)
      return losslessJson(projectResearch(result))
    },
  })
}
