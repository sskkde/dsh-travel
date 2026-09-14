/**
 * 五数据模型 TS 类型（字段级契约唯一样本 = docs/design.md §5.5 行 397-493）。
 *
 * 记法约定（与 §5.5 一致）：所有时间字段 ISO8601（createdAt/updatedAt/
 * fetchedAt/publishedAt 之外，coords 无时间字段）；日期 YYYY-MM-DD（dateStart/
 * dateEnd/Itinerary day.date/WeatherEntry.date）。坐标统一 GCJ-02 落盘基准
 * （§5.1 行 274 归一化原则），`sys` 保留原始坐标系以便渲染层做 GCJ→WGS 反算
 * （§8）。
 */

// ────────────────────────── 共享枚举与基础类型 ──────────────────────────

/** 坐标系（§5.5 coords.sys 枚举）。 */
export const COORD_SYS = ['GCJ02', 'WGS84'] as const
export type CoordSys = (typeof COORD_SYS)[number]

/** 坐标（腾讯/高德原生 GCJ-02；外源 WGS84 经 toGcj02 归一化落盘）。 */
export interface GeoCoords {
  lng: number
  lat: number
  sys: CoordSys
}

/**
 * round3 canonical route geometry：GeoJSON 坐标始终是 WGS84 的 [lng, lat]。
 * provider 只作为归因字符串保留；页面若使用 AMap，负责显示侧坐标转换。
 */
export const ROUTE_GEOMETRY_COORDINATE_SYSTEMS = ['WGS84'] as const
export type RouteGeometryCoordinateSystem = (typeof ROUTE_GEOMETRY_COORDINATE_SYSTEMS)[number]
export const ROUTE_GEOMETRY_POINT_ORDERS = ['lng,lat'] as const
export type RouteGeometryPointOrder = (typeof ROUTE_GEOMETRY_POINT_ORDERS)[number]
export type RouteGeometryPoint = [number, number]
export interface RouteGeometry {
  type: 'LineString'
  coordinates: RouteGeometryPoint[]
  source: string
  coordinateSystem: RouteGeometryCoordinateSystem
  pointOrder: RouteGeometryPointOrder
}

/** 版本化读取状态：legacy/未知版本只读时必须显式落 unknown。 */
export const ARTIFACT_STATES = ['current', 'stale', 'unknown'] as const
export type ArtifactState = (typeof ARTIFACT_STATES)[number]
export const LEGACY_SCHEMA_VERSION = 1
export const ROUND3_SCHEMA_VERSION = 2
export const SUPPORTED_SCHEMA_VERSIONS = [LEGACY_SCHEMA_VERSION, ROUND3_SCHEMA_VERSION] as const
export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number]

/** 条目来源（§5.5 source{platform,url,fetchedAt}；fetchedAt 为 ISO8601）。 */
export interface SourceRef {
  platform: string
  url: string
  fetchedAt: string
}

/** intel.category 枚举（§5.5）。 */
export const INTEL_CATEGORIES = [
  'attraction', 'lodging', 'food', 'transportLocal', 'tip', 'warning', 'recommend',
] as const
export type IntelCategory = (typeof INTEL_CATEGORIES)[number]

/** intel.channel 枚举（§5.5，M1 渠道全集）。 */
export const INTEL_CHANNELS = [
  'xhs-mcp', 'xhs-l0', 'douyin', 'zhihu', 'weibo',
  'tieba', 'kuaishou', 'tencent-poi', 'wendao', 'web',
] as const
export type IntelChannel = (typeof INTEL_CHANNELS)[number]

/** 置信度（FR-3 溯源与降权）。 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

/** 城际交通模式（transport.json mode 枚举）。 */
export const TRANSPORT_MODES = ['rail', 'flight', 'bus'] as const
export type TransportMode = (typeof TRANSPORT_MODES)[number]

/** 行程 day.stops[].category 枚举。 */
export const STOP_CATEGORIES = ['attraction', 'lodging', 'food', 'transportLocal'] as const
export type StopCategory = (typeof STOP_CATEGORIES)[number]

/** 市内衔接 provider 枚举（§5.5 cityTransfer.provider）。 */
export const CITY_TRANSFER_PROVIDERS = ['amap', 'didi', 'search'] as const
export type CityTransferProvider = (typeof CITY_TRANSFER_PROVIDERS)[number]

// ────────────────────────── T1 青甘契约扩展（W0；草稿 A/B/F） ──────────────────────────

/** researchIntent.keywords 上限（草稿 A：最多 6 条）。 */
export const RESEARCH_KEYWORDS_MAX = 6

/** 单条 keyword trim 后长度上限（草稿 A：1-100 字符）。 */
export const RESEARCH_KEYWORDS_MAX_CHARS = 100

/** researchIntent.regionHints 上限（草稿 A：最多 20 个明确地域约束）。 */
export const RESEARCH_REGION_HINTS_MAX = 20

/**
 * 兴趣主题与地理约束（草稿 A：兴趣与地理信息分离）。
 * text 保存用户原始旅行主题（原话，非城市断言）；keywords/regionHints 为
 * 明确约束——不凭模型常识静默编造行政区；destination 不再自动充当交通终点。
 */
export interface ResearchIntent {
  /** 用户原始旅行主题（必填非空）。 */
  text: string
  /** 发现词组（≤6，trim 后 1-100 字符，去重保序）。 */
  keywords?: string[]
  /** 明确地域约束（≤20）。 */
  regionHints?: string[]
}

/** 正文获取状态（research-content 工件；草稿 B/H：诚实抽样与截断标记）。 */
export const CONTENT_STATUSES = ['extracted', 'partial', 'unavailable', 'not_fetched'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/**
 * 条目正文追踪（草稿 H：摘要继续作轻量索引，正文经
 * research-content/<itemId>/<contentVersion>.json 独立存档、分块读取）。
 *
 * round3 的直接正文字符串由 IntelItem/validator 的兼容读取层接受；这里
 * 保留旧的 contentRef/contentVersion 工件追踪形态，令旧工件仍可只读消费。
 * 写入新社媒条目时应优先使用直接正文形态，正文不得放回 summary。
 */
export interface ContentTrace {
  /** research-content 工件引用（<itemId>，路径安全字符校验后拼接）。 */
  contentRef: string
  /** 正文内容版本（固定版本分页防混合版本）。 */
  contentVersion: string
  contentStatus: ContentStatus
  /** 截断标记（超出正文上限 100_000 字符等）；true 时 truncatedReason 必填。 */
  truncated?: boolean
  truncatedReason?: string
  /** 媒体/图片文字/视频字幕/评论未覆盖明确标记（草稿 G）。 */
  mediaUnresolved?: boolean
}

// ────────────────────────── request.json — TravelRequest ──────────────────────────

/** 规划模式。recommend = 目的地推荐（destination 允许为空）。 */
export const TRAVEL_MODES = ['plan', 'recommend'] as const
export type TravelMode = (typeof TRAVEL_MODES)[number]

/** TravelRequest 七态（§5.4 mermaid）。 */
export const REQUEST_STATUSES = [
  'collecting', 'recommending', 'confirmed', 'researching',
  'generating', 'delivered', 'revising',
] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/** 行程节奏（preferences.pace 枚举）。 */
export const PACE_LEVELS = ['relaxed', 'balanced', 'intensive'] as const
export type Pace = (typeof PACE_LEVELS)[number]

/** 预算口径（budget.scope 枚举）。 */
export const BUDGET_SCOPES = ['total', 'perPerson'] as const
export type BudgetScope = (typeof BUDGET_SCOPES)[number]

export interface Travelers {
  /** 成人（≥1，缺省 intake 默认 1 并记 assumption）。 */
  adults?: number
  children?: number
  seniors?: number
}

/** 预算。currency 缺省 CNY、scope 缺省 total（intake 落默认+assumption）。 */
export interface Budget {
  amount?: number
  currency?: string
  scope?: BudgetScope
}

export interface Preferences {
  pace?: Pace
  /** 景点类型偏好（自然/人文/亲子/美食…）。 */
  themes?: string[]
  diet?: string[]
}

/** 槽位（§5.5 slots；字段级类型与可选性）。 */
export interface Slots {
  origin?: string
  destination?: string
  /** YYYY-MM-DD，dateEnd>=dateStart。 */
  dateStart?: string
  dateEnd?: string
  /** 行程天数（须与日期区间一致，intake 校验）。 */
  days?: number
  travelers?: Travelers
  budget?: Budget
  preferences?: Preferences
  /** 特殊约束（无障碍/素食/携带宠物…）。 */
  constraints?: string[]
  /**
   * 兴趣主题（草稿 A；plan 模式存在且 text 非空时 destination 可缺省，
   * 允许先做情报发现；无此字段的 destination-only 旧请求由 intake 映射为
   * 兼容兴趣种子并显式记录）。
   */
  researchIntent?: ResearchIntent
}

/** request.json 顶层（一行落盘；createdAt/updatedAt ISO8601）。 */
export interface TravelRequest {
  /** 一次旅行规划会话的持久化 ID（首次 intake 生成，跨修订复用）。 */
  planId: string
  mode: TravelMode
  status: RequestStatus
  slots: Slots
  /** 采用默认值时明示的假设（FR-2 详 6）。 */
  assumptions: string[]
  createdAt: string
  updatedAt: string
  /**
   * 流程版本（草稿 F：缺失按 legacy 读取——旧计划无字段沿用现行工具行为；
   * 新 plan 与 destination 映射种子一律受串行门约束）。
   */
  flowVersion?: string
}

// ────────────────────────── intel.json — IntelItem[] ──────────────────────────

/** 社媒互动指标；所有字段出现时必须是非负有限数值。 */
export interface IntelSocialMetrics {
  likes?: number
  collects?: number
  comments?: number
  shares?: number
}

/** 情报条目（FR-3 产物；conflictsWith=多源矛盾时并列展示的条目 id 列表）。 */
export interface IntelItem {
  /** 条目 ID（itinerary.intelRefs 引用）。 */
  id: string
  category: IntelCategory
  channel: IntelChannel
  title: string
  /**
   * 轻量摘要，仅承载正文语义/关键事实；不得拼入「作者：…」「互动：…」
   * 「IP属地：…」等社媒元信息。旧工件若已拼入这些字段仍可只读解释，
   * validateIntelItem 不以摘要文字硬拒绝（清理属于 W2/T4 适配器行为）。
   */
  summary: string
  /** 社媒作者元信息，与正文摘要分离。 */
  author?: string
  /** 社媒互动元信息，与正文摘要分离。 */
  metrics?: IntelSocialMetrics
  /**
   * round3 新社媒形态为直接正文字符串；旧工件仍可用 ContentTrace 对象
   * 指向 research-content/<itemId>/<contentVersion>.json。两种形态都不把
   * 正文元信息重新写回 summary。
   */
  content?: string | ContentTrace
  source: SourceRef
  /** 腾讯/高德原生 GCJ-02；缺省时无坐标。 */
  coords?: GeoCoords
  /** 腾讯 POI：star_level（如 4.3）。 */
  rating?: number
  /** 腾讯 POI：人均（如 117）。 */
  avgPrice?: number
  /** 腾讯 POI（如 "17:00-20:00"）。 */
  openingHours?: string
  /** 行政区（geocoder 回报；P0-A R1：tencent ad_info / amap 可带，缺失 undefined 不猜）。 */
  district?: string
  confidence: Confidence
  /** 冲突条目 id（多源矛盾时并列展示，FR-3 详 2）。 */
  conflictsWith?: string[]
  /** 内容发布时间（>12 个月降权，FR-3 详 3）；YYYY-MM-DD。 */
  publishedAt?: string
}

// ────────────────────────── transport.json — TransportOption[] ──────────────────────────

export interface TransportSegment {
  from: string
  to: string
  /** 车次/航班号。 */
  no?: string
  /** HH:mm。 */
  depart?: string
  /** HH:mm。 */
  arrive?: string
  priceRange?: [number, number]
  channel?: string
}

export interface CityTransferOption {
  mode: string
  durationMinutes?: number
  priceHint?: string
}

/** 市内衔接（FR-4；高德/滴滴双方案互为降级，还有 search 兜底）。 */
export interface CityTransfer {
  from: string
  to: string
  provider: CityTransferProvider
  options: CityTransferOption[]
  source: SourceRef
}

export interface TransportOption {
  mode: TransportMode
  segments: TransportSegment[]
  totalPriceRange?: [number, number]
  /** 价格币种；缺省表示来源未明确说明，成本聚合不得臆测。 */
  currency?: string
  durationMinutes?: number
  cityTransfer?: CityTransfer
  /** 适合带娃/老人、中转少、性价比… */
  tags?: string[]
  bookingTips?: string[]
  source: SourceRef
}

// ────────────────────────── advice.json ──────────────────────────

/** 温度来源证据等级；seasonal-template 仅作通用规划参考，不驱动精确穿衣。 */
export const TEMPERATURE_BASES = ['seasonal-template', 'historical', 'forecast'] as const
export type TemperatureBasis = (typeof TEMPERATURE_BASES)[number]

export interface AdviceWeatherEntry {
  /** YYYY-MM-DD。 */
  date: string
  dayForecast?: string
  tempRange?: [number, number]
  /** 温度依据；seasonal-template 数值不作为精确穿衣决策输入。 */
  temperatureBasis?: TemperatureBasis
  /** 超预报窗口 → 气候概况标注（渠道三 Open-Meteo 兜底）。 */
  beyondForecastWindow?: boolean
  source: SourceRef
  /** 已解析地点归属（W0 T1：按 placeId 逐地归属，不得以单城代表环线）。 */
  placeId?: string
  /** 地点名（如 "敦煌"；与 placeId 配套）。 */
  location?: string
  /** T13（草稿 E）：false=该地无逐地日期，按旅行窗口查询（显式标注「未分配逐地日期」）；true=按逐地日期查对应日。 */
  placeDateAssigned?: boolean
}

export interface Advice {
  weather: AdviceWeatherEntry[]
  clothing: string[]
  packingList: string[]
  extraTips: string[]
}

// ────────────────────────── round3 insights（调用方归纳回写） ──────────────────────────

export const INSIGHT_MAX_CHARS = 60
export const INSIGHT_KINDS = ['recommend', 'avoid', 'guide', 'plan'] as const
export type InsightKind = (typeof INSIGHT_KINDS)[number]
export const INSIGHT_SCOPES = ['place', 'region', 'theme'] as const
export type InsightScope = (typeof INSIGHT_SCOPES)[number]

/** 归纳引用只保留可审计的轻量来源字段，不嵌入原文。 */
export interface InsightCitation {
  title: string
  platform: string
  url: string
  /** 可选的当前 intel / 固定正文片段引用（由调用方按当前版本提供）。 */
  intelRef?: string
  contentRef?: string
  contentVersion?: string
  fragmentId?: string
}

/** 明示由调用方提供的归因；插件只校验结构与引用存在性。 */
export interface CallerAttribution {
  source: 'caller'
  label?: string
  note?: string
}
export type InsightAttribution = CallerAttribution | string

/** 一条 ≤60 Unicode 字符的调用方归纳。 */
export interface TravelInsight {
  id?: string
  kind: InsightKind
  text: string
  scope: InsightScope
  /** place/region/theme 的稳定业务引用。 */
  scopeRef?: string
  citations: InsightCitation[]
  attribution: InsightAttribution
}

// ────────────────────────── itinerary.json — Itinerary ──────────────────────────

/** 日程锚点角色：arrival/lodging/stop/departure。旧日程缺省时按 legacy 读取。 */
export const ITINERARY_ANCHOR_ROLES = ['arrival', 'lodging', 'stop', 'departure'] as const
export type ItineraryAnchorRole = (typeof ITINERARY_ANCHOR_ROLES)[number]

export interface ItineraryStop {
  /** round3 中稳定解析地点；旧文件缺省，不能据名称猜 placeId。 */
  placeId?: string
  /** 同一 placeId 的非相邻重访必须拥有不同 occurrenceId。 */
  occurrenceId?: string
  name: string
  category: StopCategory
  coords: GeoCoords
  /** round3 日首/日尾住宿衔接锚点角色；旧文件缺省。 */
  anchorRole?: ItineraryAnchorRole
  /** 建议时长（分钟）。 */
  durationHint?: number
  /** 溯源引用（intel 条目 id）。 */
  intelRefs: string[]
  note?: string
}

export interface ItineraryMeal {
  name: string
  intelRefs: string[]
}

export interface ItineraryDay {
  /** YYYY-MM-DD。 */
  date: string
  theme?: string
  stops: ItineraryStop[]
  meals: ItineraryMeal[]
  lodgingArea?: string
}

/** canonical 路线节点：occurrenceId 使闭环/重访不因同 placeId 被折叠。 */
export interface CanonicalRouteNode {
  occurrenceId: string
  placeId: string
  dayIndex: number
  stopIndex: number
}

/** canonical 路线边：端点引用 occurrence，而不是仅引用 placeId。 */
export interface CanonicalRouteEdge {
  id: string
  fromOccurrenceId: string
  toOccurrenceId: string
  orderIndex: number
}

export interface CanonicalRoute {
  schemaVersion: number
  fingerprint: string
  nodes: CanonicalRouteNode[]
  edges: CanonicalRouteEdge[]
}

export interface RouteCheck {
  issues: string[]
  warnings: string[]
}

export interface Itinerary {
  /** legacy=缺省；round3 新写入使用 schemaVersion=2。 */
  schemaVersion?: number
  itineraryId: string
  days: ItineraryDay[]
  routeCheck: RouteCheck
  /** build 规范化后的唯一节点/边真源；旧文件缺省。 */
  canonicalRoute?: CanonicalRoute
}

// ────────────────────────── W1 research artifacts（rounds/state；草稿 52-60） ──────────────────────────

/**
 * 单渠道这一轮的执行回执（research-rounds/<roundId>.json channels[]）。
 * 每条保留查询词 + 渠道 + 稳定 itemId + 分页能力诚实 + 失败明细；
 * 供调用方从摘要索引反查候选，保持 round/query/source/candidate 引用链。
 */
export interface ResearchRoundChannelEntry {
  /** 实际执行的规范化查询词（调用方/interest 种子 → 渠道实际消费）。 */
  query: string
  /** fan-out 渠道内部名（如 'tencent-poi'/'search-l0'；与 degraded 记账 source 同口径）。 */
  source: string
  /** 上游分页能力诚实（草稿 45：无分页不伪造翻页）。 */
  pagination: 'paginated' | 'none'
  /** 本渠道本轮产出的稳定条目 id（去重前原始集合；保持裸 itemId）。 */
  itemIds: string[]
  /**
   * 本渠道的原始观察（新写入轮次提供；旧 round 文件可缺省）。
   * observations 只记录 provenance，不参与 content suppression；同一内容的多次观察
   * 仍各自保留 raw itemId/provenanceKey，供审计反查。
   */
  observations?: ResearchRoundObservation[]
  /** 单渠道失败明细（ok:false 时记录；成功渠道无此字段）。 */
  error?: { code: string; reason: string }
}

/**
 * 单条原始观察的双键回执（round JSON）。
 * contentId = fanout.intelDedupKey(item)，只用于说明内容聚合身份；
 * provenanceKey = `${roundId}:${channel}:${contentId}`，只用于轮次/审计/引用链。
 * channel 使用稳定的 IntelItem.channel；itemId 保留适配器原始裸 ID，绝不替换 DR1
 * 的 itemId/newItemIds/contentRef。重复观察的 raw itemId 与所在 channel entry 保留其可核对性。
 */
export interface ResearchRoundObservation {
  /** 适配器原始裸条目 id（不是 provenanceKey）。 */
  itemId: string
  /** fanout.intelDedupKey(item) 的规范内容 ID（同笔记 l0:/xhs: 前缀归一）。 */
  contentId: string
  /** IntelItem.channel，作为 provenanceKey 的稳定 channel 段。 */
  channel: IntelChannel
  /** 精确文字形态为 `round:channel:id`，实际值为 roundId:channel:contentId。 */
  provenanceKey: string
  /** 是否通过本轮中心类别/条目校验；旧 round 文件无此旁车字段。 */
  accepted?: boolean
}

/** continuation 续查上下文（草稿 45：仅适配器真实 cursor / 插件排队进度）。 */
export interface ResearchContinuation {
  source: string
  cursor?: string
}

/** 单轮研究日志（research-rounds/<roundId>.json）。 */
export interface ResearchRound {
  roundId: string
  /** 本轮完成时研究版本（research-state.researchVersion）。 */
  researchVersion: number
  /** 本轮请求提交时刻（ISO，调用方发起）。 */
  requestedAt: string
  /** 本轮实际执行时刻（ISO；≠ 条目发布时间，T8 日期诚实）。 */
  observedAt: string
  /** 触发方式：destination（有地理，旧单点兼容）| discovery（仅兴趣种子）| continuation。 */
  initiator: 'destination' | 'discovery' | 'continuation'
  query: {
    /** 实际规范化查询词（去重保序；缺省为 interest 种子词/目的地）。 */
    keywords: string[]
    /** 请求来源白名单键（'*' 表示未指定=全部渠道）。 */
    sources: string[]
    categories: IntelCategory[]
    requestId?: string
    continuation?: ResearchContinuation
    /**
     * 查询级审计印记（兼容旧 round 文件；不是 contentDedupKey，也不是 provenanceKey）：
     * planId + destination/intent + 规范化 keywords/categories/sources 的确定性摘要；
     * 同参可复现，供跨轮 query 对照。内容抑制仍只用 fanout.intelDedupKey。
     */
    scopeKey?: string
  }
  /** 各渠道执行回执。 */
  channels: ResearchRoundChannelEntry[]
  /** 本轮新并入 intel 投影的稳定 itemId（跨轮去重后）。 */
  newItemIds: string[]
  /** 本轮原始观察中通过中心类别/条目校验的条数（同轮 contentId 聚合前）。 */
  keptRawCount: number
  /** 本轮预算使用快照。 */
  budget: { usedRounds: number; maxRoundsPerPlan: number; exhausted: boolean }
  /** 本轮失败明细（全渠道都可为部分的）。 */
  failures: Array<{ code: string; reason: string }>
}

/** 研究索引中的条目摘要（research-state.itemIndex[]；草稿 42：不回传全部原文）。 */
export interface ResearchStateIndexItem {
  itemId: string
  roundId: string
  channel: IntelChannel
  title: string
  /**
   * 新并入条目的首个原始观察 provenance（roundId:channel:contentId）；
   * 仅用于轮次/审计/引用链，不参与内容抑制。itemId 仍是供正文与行程引用的裸 ID。
   */
  provenanceKey?: string
  contentRef?: string
  contentVersion?: string
}

/** research-state.json（草稿 52-60：当前版本 / 轮次·预算 / 源与正文索引 / 当前 assessment）。 */
export interface ResearchState {
  schemaVersion: number
  /** 随新研究请求 / 正文变化 / 证据纠错 / 需求变化更新；幂等与只读分页不更新（草稿 56）。 */
  researchVersion: number
  updatedAt: string
  /** 轮次 id（升序）。 */
  rounds: string[]
  /** 预算状态（草稿 60：耗尽=暂停非完成）。 */
  budget: { usedRounds: number; maxRoundsPerPlan: number; exhausted: boolean }
  /** 已咨询过的注册来源键。 */
  sources: string[]
  /** 当前 intel 投影的摘要索引。 */
  itemIndex: ResearchStateIndexItem[]
  /**
   * 正文抓取失败索引（DR2 持久化；按 itemId+失败原因幂等累计，供 state/重试
   * 如实展示。上限 FETCH_FAILURES_MAX，超限丢最旧）。
   */
  fetchFailures?: Array<{ itemId: string; code: string; reason: string; at: string }>
  /** 当前 assessment（T7 填）。 */
  assessment?: {
    assessmentId: string
    status: 'sufficient' | 'continue' | 'insufficient'
    researchVersion: number
    recordedAt: string
  }
}

// ────────────────────────── W1 research-content 工件（草稿 39-50，DR2） ──────────────────────────

/**
 * research-content/<itemId>/<contentVersion>.json。
 * contentStatus 区分 extracted|partial|unavailable|not_fetched；extracted 只指本次
 * 合法获取页面中提取到的正文，不保证图片文字/视频字幕/评论已覆盖（媒体未解析明确标记）。
 */
export interface ResearchContentArtifact {
  /** = 条目 itemId（与 intel 条目对应，路径安全校验后拼接）。 */
  contentRef: string
  /** 固定内容版本（哈希派生：同正文同版本，正文变 → 新版本；防分页读到混合版本）。 */
  contentVersion: string
  title: string
  sourceUrl: string
  channel: IntelChannel
  contentStatus: ContentStatus
  /** 超出正文上限等截断标记；true 时 truncatedReason 必填。 */
  truncated?: boolean
  truncatedReason?: string
  /** 媒体/图片文字/视频字幕/评论未覆盖明确标记（草稿 G/48）。 */
  mediaUnresolved?: boolean
  /** 发布日期（仅来源明确字段；启发式候选分离到 dateEvidence，草稿 183）。 */
  publishedAt?: string
  /** 启发式日期候选（值/方法/确定性；抓取时间不当发布时间、季节词不当日期）。 */
  dateEvidence?: Array<{ value: string; method: string; confidence: 'high' | 'medium' | 'low' }>
  /** 抓取时刻（≠ 发布时间；缓存命中回显原值，不伪装新采集）。 */
  fetchedAt: string
  /** 完整正文（>140 字符全部存储，不再 140 截断）。 */
  body: string
  /** 正文字符长度。 */
  byteLength: number
}

// ────────────────────────── W1 research assessment（草稿 27-30,56-60，DR3） ──────────────────────────

/** assessment 判定（草稿 28：仅 schema/版本/引用/权限校验，不做模型语义判定）。 */
export const RESEARCH_VERDICTS = ['sufficient', 'continue', 'insufficient'] as const
export type ResearchVerdict = (typeof RESEARCH_VERDICTS)[number]

/** 发现项（草稿 57：claimId/陈述/证据片段引用/状态）。 */
export interface ResearchFinding {
  claimId: string
  statement: string
  evidenceRef?: string
  status: 'confirmed' | 'refuted' | 'uncertain'
}

/** 缺口项（草稿 57：需求项 + 缺口）。 */
export interface ResearchGap {
  requirement: string
  gap: string
}

/** 冲突项（草稿 57：矛盾双方引用 + 调用方结论或未决状态）。 */
export interface ResearchConflict {
  aRef: string
  bRef: string
  conclusion?: string
  unresolved?: boolean
}

/** research-assessments/<assessmentId>.json（调用方充分性判断快照）。 */
export interface ResearchAssessment {
  assessmentId: string
  planId: string
  /** 本 assessment 所引用的研究版本（当前有效 sufficient 必须引用当前版本）。 */
  researchVersion: number
  verdict: ResearchVerdict
  rationale: string
  requirements: string[]
  findings: ResearchFinding[]
  gaps: ResearchGap[]
  conflicts: ResearchConflict[]
  /** 引用的证据（条目 id / contentRef）。 */
  evidenceRefs: string[]
  recordedAt: string
  /** 被新证据/新判断替代时的旁车标记（保留历史，不静默删反证）。 */
  supersededBy?: string
  supersededAt?: string
}

// ────────────────────────── W2 places（草稿 B；T9） ──────────────────────────

/** 候选/地点种类（草稿 B：attraction|lodging|area|hub）。 */
export const RESOLVE_KINDS = ['attraction', 'lodging', 'area', 'hub'] as const
export type ResolveKind = (typeof RESOLVE_KINDS)[number]

/** 地点点位种类（草稿 B：entrance 入口 | poi 兴趣点 | areaCenter 区域中心 | hub 枢纽）。 */
export const POINT_KINDS = ['entrance', 'poi', 'areaCenter', 'hub'] as const
export type PointKind = (typeof POINT_KINDS)[number]

/** places.json 整体状态（草稿 B：ready|partial|needs_clarification|blocked）。 */
export const RESOLVE_STATUSES = ['ready', 'partial', 'needs_clarification', 'blocked'] as const
export type ResolveStatus = (typeof RESOLVE_STATUSES)[number]

/** 解析置信度。 */
export const RESOLVE_CONFIDENCES = ['high', 'medium', 'low'] as const
export type ResolveConfidence = (typeof RESOLVE_CONFIDENCES)[number]

/**
 * 坐标出处（coordinate_source；草稿 C：保留上游 attribution 与 coordinate_source）。
 * - intel：情报条目自带已验证坐标（优先复用）
 * - amap / tencent / osm：本次解析渠道产出
 * - area-reference：住宿/区域仅能做"至区域参考点"估算（非入口/非酒店路线），须标记
 * - disabled：渠道未启用/缺 Key（未解析，绝不给"确认"的猜测坐标）
 * - unresolved：全源尝试后仍未定位（排除/待澄清）
 * - user：用户澄清回答直接提供坐标（user-provided，P0-A R4；source=user 标注）
 */
export const COORDINATE_SOURCES = [
  'intel', 'amap', 'tencent', 'osm', 'area-reference', 'disabled', 'unresolved', 'user',
] as const
export type CoordinateSource = (typeof COORDINATE_SOURCES)[number]

/**
 * 地点解析候选（草稿 B：模型/调用方据 intel 提出；不可无证据直接提交坐标）。
 * candidateId 仅字母/数字/._:+-（路径安全，防目录穿越）。
 */
export interface ResolveCandidate {
  /** 稳定候选 id（selectionOrder 引用）。 */
  candidateId: string
  name: string
  kind: ResolveKind
  /** 情报引用（intel 条目 id 或 contentRef）；无则用 userRef（用户输入引用）。 */
  intelRefs?: string[]
  /** 用户输入/自由文本引用（intelRefs 缺失时的出处处）。 */
  userRef?: string
  /** 明确地域约束（不凭常识静默编造行政区）。 */
  regionHint?: string
  /** 调用方选择理由（选中/排除依据，供页面/lineage 追溯）。 */
  selectionReason?: string
}

/** 单个地点的解析结果（places.json places[]）。 */
export interface ResolvedPlace {
  /** 稳定 placeId（规范化名+kind+region 派生，多次解析不变）。 */
  placeId: string
  /** 对应候选 id。 */
  candidateId: string
  /** 规范名。 */
  name: string
  /** 行政区（解析渠道回报；缺省 undefined）。 */
  district?: string
  kind: ResolveKind
  pointKind: PointKind
  /** 坐标；缺省 = 未定位。 */
  coords?: GeoCoords
  /** 渠道产出（intel/amap/tencent/osm/area-reference 语义见 COORDINATE_SOURCES）。 */
  source: string
  coordinate_source: CoordinateSource
  resolveConfidence: ResolveConfidence
  /** 区域参考估算标记（草稿 B：住宿区域中心仅可做"至区域参考点"估算，不能标酒店到达路线）。 */
  areaReferenceEstimate?: boolean
  /** 采用/排除理由（草稿 B：候选选择与排除理由）。 */
  selectionReason?: string
  /** 排除原因码（未定位/降级时给；缺省 undefined）。 */
  excludeReason?: string
  /** 坐标来源附加标注（P0-A R4：coordinate_source='user' 时为 'user-provided'）。 */
  attribution?: string
  /** 需澄清项（草稿 B：同名/地域冲突/低置信/必去点无法定位）。 */
  pendingClarification?: string
  /**
   * 地域一致性判定结果（2026-09-12 N-REPLAY-1 修复）：
   * `verified`=可证明与候选 regionHint 一致；`conflict`=可证明冲突（走澄清）；
   * `unverified`=证据不足（源未回报行政区，或行政区层级看不出归属）→ **仍采用但降档 medium**
   * 并在回执标注，不再产出无法回答的澄清。
   */
  regionVerification?: 'verified' | 'conflict' | 'unverified'
  /** `regionVerification='unverified'` 时的说明（供回执/页面标注）。 */
  regionVerificationNote?: string
}

/** 待澄清问题（每轮 ≤3，先必去点与关键冲突；disambiguationAnswers 回填）。 */
export interface ResolveClarification {
  /** 稳定问题 id（回填 disambiguationAnswers 引用）。 */
  clarificationId: string
  candidateId: string
  /** 问题类型：scope=同名/地域冲突；confidence=低置信；unresolved=必去点无法定位。 */
  kind: 'scope' | 'confidence' | 'unresolved'
  question: string
  /** 可选选项。 */
  options?: string[]
}

/** 入口城市/origin 解析（草稿 B：独立来源；不写回覆盖用户原主题）。 */
export interface OriginResolution {
  /** 出发地原文（来自 request.slots.origin，不修改）。 */
  origin?: string
  /** 入口候选是否已解析（车站/机场/城市坐标）。 */
  resolved: boolean
  /** 入口地图坐标（若解析）。 */
  coords?: GeoCoords
  /** 入口城市/站名代码/机场/地点坐标区分（草稿 D：city|station|airport|place）。 */
  entryKind?: 'city' | 'station' | 'airport' | 'place'
  source?: string
}

/** places.json（草稿 B：候选/selectedSequence/entryPlaceId/originResolution/status）。 */
export interface PlacesArtifact {
  schemaVersion: number
  /** 本次消费的 intel 证据版本（= research-state.researchVersion 当前值）。 */
  intelVersion: number
  /** 研究输入指纹（调用方/计划研究输入快照）。 */
  inputFingerprint: string
  generatedAt: string
  /** 全部候选（含选择/排除理由与排除原因码）。 */
  candidates: ResolveCandidate[]
  /** 已解析地点（按 candidateId 稳定）。 */
  places: ResolvedPlace[]
  /** 选中序列（保留闭环/重访重复；相邻重复=零长度边已在输入拒绝）。 */
  selectedSequence: string[]
  /** 入口地点 id（entryCandidateId 解析后）。 */
  entryPlaceId?: string
  /** 入口/origin 解析（不写回覆盖用户原主题）。 */
  originResolution?: OriginResolution
  /** 待澄清问题（每轮 ≤3）。 */
  pendingClarifications: ResolveClarification[]
  /** ready|partial|needs_clarification|blocked。 */
  status: ResolveStatus
}

// ────────────────────────── W2 route-coverage（草稿 C；T10） ──────────────────────────

/** 覆盖状态（草稿 C：covered|partial|missing）。 */
export const COVERAGE_STATUSES = ['covered', 'partial', 'missing'] as const
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number]

/** 未达 covered 的原因码（草稿 C：budget_exhausted|disabled|unavailable|no_results|filtered_quality|unresolved_geo）。 */
export const COVERAGE_REASON_CODES = [
  'budget_exhausted', 'disabled', 'unavailable', 'no_results', 'filtered_quality', 'unresolved_geo',
] as const
export type CoverageReasonCode = (typeof COVERAGE_REASON_CODES)[number]

/** route-coverage 单区域覆盖（草稿 C）。 */
export interface CoverageRegion {
  name: string
  status: CoverageStatus
  /** 支撑该区域状态的情报条目 id（query→item→candidate→place 链的 intel 锚点）。 */
  intelRefs: string[]
  categoryCounts: Record<string, number>
  /** 该区域有可信坐标的地点数（attr 的 attraction 至少 1 才算 covered 的地理支撑）。 */
  coordsCount: number
  /** 缺失类别（covered 时为 []）。 */
  missingCategories: string[]
  /** 零/失败归因原因码（covered 时为 []）。 */
  reasonCodes: CoverageReasonCode[]
}

/** route-coverage.json（草稿 C：由 regionHints+情报发现地点+选中序列派生，不依赖旧 route.waypoints）。 */
export interface RouteCoverageArtifact {
  schemaVersion: number
  intelVersion: number
  placesVersion: number
  inputFingerprint: string
  generatedAt: string
  regions: CoverageRegion[]
  /** 显示用计算来源快照（覆盖从何处派生——不写回触发 intel/places）。 */
  lineage: {
    /** 显式 regionHints。 */
    regionHints: string[]
    /** 情报发现且纳入区域的地点候选 id。 */
    discoveredCandidates: string[]
    /** 选中序列（as-is，含闭环/重访）。 */
    selectedSequence: string[]
  }
}

// ────────────────────────── W3 route-transport（草稿 D 段逐段契约；T12） ──────────────────────────

/** 路线段出行方式（草稿 D：驾驶/步行/公交按用户明确方式；无方式时默认+回显假设）。 */
export const ROUTE_TRANSPORT_MODES = ['driving', 'walking', 'transit'] as const
export type RouteTransportMode = (typeof ROUTE_TRANSPORT_MODES)[number]

/** 每段状态（草稿 D：queried|estimated|unavailable|blocked）。 */
export const ROUTE_TRANSPORT_STATUSES = ['queried', 'estimated', 'unavailable', 'blocked'] as const
export type RouteTransportStatus = (typeof ROUTE_TRANSPORT_STATUSES)[number]

/** round3 指标状态与道路几何状态各自独立，避免“有里程”被误读成“有道路轨迹”。 */
export const ROUTE_METRIC_STATUSES = ROUTE_TRANSPORT_STATUSES
export type RouteMetricStatus = (typeof ROUTE_METRIC_STATUSES)[number]
export const ROUTE_GEOMETRY_STATUSES = ROUTE_TRANSPORT_STATUSES
export type RouteGeometryStatus = (typeof ROUTE_GEOMETRY_STATUSES)[number]

/**
 * 路线各段单腿（草稿 D 契约：id/fromPlaceId/toPlaceId/orderIndex/placesVersion/mode/
 * status/estimateReason/provider/source/observedAt/可选几何日期）。
 * - status 保留为 legacy 兼容字段；新发布同时写 metricStatus/geometryStatus
 * - status=estimated → estimateReason 必填（直线估算不冒充道路长度/驾驶时长/可达性证据）
 * - 缺班次日期时只查非时刻表路线（距离/时长），不返回假装实时可乘的班次（无 no/时刻字段）
 * - 测距渠道仅返回距离/时长则如实输出、geometryStatus=unavailable（不把测距说成完整路线指引）
 */
export interface RouteTransportLeg {
  /** 稳定腿 id（leg-<orderIndex>-<from>-<to>-<hash>；跨发布可重放）。 */
  id: string
  fromPlaceId: string
  toPlaceId: string
  /** 在选中序列中的相邻边序号（0 基）。 */
  orderIndex: number
  placesVersion: number
  mode: RouteTransportMode
  /** legacy 综合状态；round3 消费者优先看 metricStatus/geometryStatus。 */
  status: RouteTransportStatus
  /** 指标（距离/时长）状态；旧 leg 缺省时由读取层映射为 unknown。 */
  metricStatus?: RouteMetricStatus
  /** 道路几何状态；有指标但无轨迹时可为 unavailable。 */
  geometryStatus?: RouteGeometryStatus
  /** estimated/unavailable/blocked 的诚实原因（直线估算/全源失败/枢纽缺坐标等）。 */
  estimateReason?: string
  /** 渠道名（amap/tencent/estimate…；legacy 语义位）。 */
  provider?: string
  source?: SourceRef
  /** ISO8601。 */
  observedAt: string
  /** 对外兼容单位：千米；provider 边界换算米后再回写。 */
  distanceKm?: number
  /** 对外兼容单位：分钟；provider 边界秒后再回写。 */
  durationMinutes?: number
  /** canonical WGS84 GeoJSON LineString；旧 leg 可缺省。 */
  geometry?: RouteGeometry
  /** 可选出行日期（YYYY-MM-DD；非时刻表路线不承诺实时可乘）。 */
  date?: string
}

/** 页面消费的路线旁车摘要；full geometry 仍挂在各 leg，geometry 为可选聚合视图。 */
export interface RenderRouteTransport {
  legs: RouteTransportLeg[]
  geometry?: RouteGeometry[]
  totalDistanceKm?: number
  totalDurationMinutes?: number
  fingerprint?: string
}

/** route-transport.json（草稿 D：路线各段旁车；transport.json 原 TransportOption[] 形态保留承载出发选项）。 */
export interface RouteTransportArtifact {
  schemaVersion: number
  placesVersion: number
  inputFingerprint: string
  generatedAt: string
  legs: RouteTransportLeg[]
  /** 无方式时提出的默认方式假设回显（不悄悄全部当自驾）。 */
  assumedMode?: { mode: RouteTransportMode; reason: string }
  /** 每轮可见的降级/失败明细（某段失败不抹其他段）。 */
  degraded: Array<{ source: string; code: string; reason: string; at: string }>
  /** 关键不可达/必去点冲突影响范围（回 resolve 调整候选再查受影响段，禁止无限自动重排）。 */
  resolutionHint?: string
}

// ────────────────────────── W3 lodging-quotes（草稿 E 段；T14） ──────────────────────────

/** 报价单位（草稿 E：roomNight|stay）。 */
export const LODGING_UNITS = ['roomNight', 'stay'] as const
export type LodgingUnit = (typeof LODGING_UNITS)[number]

/** 税费状态（草稿 E：included|excluded|unknown）。 */
export const TAX_STATUSES = ['included', 'excluded', 'unknown'] as const
export type TaxStatus = (typeof TAX_STATUSES)[number]

/**
 * 价格语义（草稿 E：不填假区间；明确单价可 [min,min]；avgPrice 继续仅人均语义）。
 * range 为真实渠道返回数值（缺条件/单位/币种/真实数值 → 不出报价）。
 */
export interface PriceQuote {
  /** 真实数值区间（[min,max] 或单值 [min,min]）。 */
  range: [number, number]
  /** 币种（如 CNY）。 */
  currency: string
  /** 单位：roomNight=每房每晚 / stay=整段入住。 */
  unit: LodgingUnit
  /** YYYY-MM-DD（明确入住安排才给）。 */
  checkIn?: string
  checkOut?: string
  adults?: number
  rooms?: number
  /** ISO8601 报价观察时刻。 */
  observedAt: string
  taxStatus: TaxStatus
  cancellationPolicy?: string
  bookingUrl?: string
}

/** 单条报价（含来源/酒店标识）。 */
export interface LodgingQuoteEntry {
  placeId: string
  quote: PriceQuote
  source: SourceRef
  /** 酒店标识（渠道返回）。 */
  hotelId?: string
  hotelName?: string
}

/** 逐项处理回执（草稿 E：quoted|skipped_missing_stay_context|blocked|rejected）。 */
export interface LodgingQuoteRecord {
  placeId: string
  status: 'quoted' | 'skipped_missing_stay_context' | 'blocked' | 'rejected'
  reason?: string
}

/** lodging-quotes.json（草稿 E：独立版本工件；报价不使 intel/places 失效）。 */
export interface LodgingQuotesArtifact {
  schemaVersion: number
  placesVersion: number
  inputFingerprint: string
  generatedAt: string
  quotes: LodgingQuoteEntry[]
  records: LodgingQuoteRecord[]
  /** 渠道不可用/缺 Key 等降级明细（零调用如实记账）。 */
  degraded: Array<{ source: string; code: string; reason: string; at: string }>
}

// ────────────────────────── B6 rental-quotes / cost ──────────────────────────

/** 租车咨询输入：仅引用已 resolve 的取车地点，可选还车地点。 */
export interface RentalQuoteRequest {
  pickupPlaceId: string
  dropoffPlaceId?: string
  /** 租用天数（正整数；用于把日租咨询价换算为行程区间）。 */
  days: number
  seats?: number
}

export const RENTAL_UNITS = ['day'] as const
export type RentalUnit = (typeof RENTAL_UNITS)[number]

/** 租车价格只允许真实咨询文本解析出的数值；不表示实时可订/最终成交价。 */
export interface RentalPriceQuote {
  range: [number, number]
  currency: string
  unit: RentalUnit
  observedAt: string
  taxStatus: TaxStatus
  /** 原始渠道深链仅作核查线索，不代表可预订。 */
  referenceUrl?: string
}

export interface RentalQuoteEntry {
  pickupPlaceId: string
  dropoffPlaceId?: string
  days: number
  seats?: number
  /** 渠道未说明车型时固定为「车型未标明」，不凭空推断。 */
  vehicleType: string
  quote: RentalPriceQuote
  source: SourceRef
}

export const RENTAL_QUOTE_RECORD_STATUSES = [
  'quoted', 'skipped_missing_stay_context', 'blocked', 'rejected',
] as const
export type RentalQuoteRecordStatus = (typeof RENTAL_QUOTE_RECORD_STATUSES)[number]

export interface RentalQuoteRecord {
  pickupPlaceId?: string
  dropoffPlaceId?: string
  status: RentalQuoteRecordStatus
  reason?: string
}

/** rental-quotes.json：咨询级、非实时、不可预订；独立于 intel/places。 */
export interface RentalQuotesArtifact {
  schemaVersion: number
  placesVersion: number
  inputFingerprint: string
  generatedAt: string
  quotes: RentalQuoteEntry[]
  records: RentalQuoteRecord[]
  degraded: Array<{ source: string; code: string; reason: string; at: string }>
  /** requestId 幂等回执所依据的请求标识（不含凭据）。 */
  requestId?: string
  /** 固定产品语义，页面/导出不得将其渲染成 booking。 */
  consultationOnly: true
  disclaimer: string
}

export const COST_COMPONENT_KEYS = [
  'intercityTransport', 'lodging', 'rental', 'tickets', 'food', 'misc',
] as const
export type CostComponentKey = (typeof COST_COMPONENT_KEYS)[number]

export const COST_COMPONENT_STATUSES = ['quoted', 'estimated', 'unavailable'] as const
export type CostComponentStatus = (typeof COST_COMPONENT_STATUSES)[number]
export const COST_QUANTITY_BASES = ['people', 'days', 'roomNights'] as const
export type CostQuantityBasis = (typeof COST_QUANTITY_BASES)[number]
export const COST_SCOPES = ['total', 'perPerson'] as const
export type CostScope = (typeof COST_SCOPES)[number]

/**
 * cost.json 单项。旧 schemaVersion=1 仍只读兼容原 min/max 形态；round3
 * schemaVersion=2 的 caller-supplied 估价必须补齐 unit/priceRange/quantity/
 * quantityBasis/scope/source/assumptions，且 estimated assumptions 非空。
 */
export interface CostComponent {
  /** legacy 聚合后的总区间，保留对外接口。 */
  min: number
  max: number
  currency: string
  /** round3 单价单位（如 person/day/roomNight）。 */
  unit?: string
  /** round3 原始单价区间。 */
  priceRange?: [number, number]
  /** round3 数量。 */
  quantity?: number
  /** round3 数量口径。 */
  quantityBasis?: CostQuantityBasis
  /** round3 适用范围。 */
  scope?: CostScope
  source: string
  status: CostComponentStatus
  assumptions: string[]
}

/** 调用方回写的一条有证据估价；插件只负责校验、归一与聚合。 */
export interface CostEstimate {
  component: CostComponentKey
  priceRange: [number, number]
  currency: string
  unit: string
  quantity: number
  quantityBasis: CostQuantityBasis
  scope: CostScope
  source: string
  assumptions: string[]
  /** 当前 intel 条目或正文版本引用；至少一条。 */
  evidenceRefs: string[]
  /** 同一消费的稳定键；相同键只计一次，quoted 优先。 */
  consumptionKey?: string
  status?: Extract<CostComponentStatus, 'quoted' | 'estimated'>
}

/** 工具边界接受的成本估价输入；min/max 是 priceRange 的兼容写法。 */
export interface CostEstimateInput {
  component?: CostComponentKey | string
  key?: CostComponentKey | string
  priceRange?: [number, number]
  min?: number
  max?: number
  currency?: string
  unit?: string
  quantity?: number
  quantityBasis?: CostQuantityBasis | string
  scope?: CostScope | string
  source?: string
  assumptions?: string[]
  evidenceRefs?: string[]
  citations?: string[]
  consumptionKey?: string
  status?: Extract<CostComponentStatus, 'quoted' | 'estimated'> | string
}

export interface CostTotal {
  min: number
  max: number
  currency: string
}

/** 预算汇总：只聚合已有真实/明确估算证据，不做汇率或缺失数据臆测。 */
export interface CostArtifact {
  schemaVersion: number
  placesVersion: number
  inputFingerprint: string
  generatedAt: string
  currency: string
  components: Record<CostComponentKey, CostComponent>
  total: CostTotal
  budget?: { amount: number; scope: BudgetScope; currency: string }
  /** 已验证的调用方估价，供后续报价重算时避免丢失且不重复消费。 */
  costEstimates?: CostEstimate[]
  warnings: string[]
  assumptions: string[]
}