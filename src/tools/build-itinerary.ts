/**
 * travel_build_itinerary —— 行程生成（M1 T5 / Wα 自动提案基线 + T7 / W4 完整版）。
 *
 * 自动提案（draft 缺省路径）：
 * - 基于 intel.json 条目自动编排每日 stops（景点 + 美食；intelRefs 溯源引用、
 *   coords{sys} 直落、按类别默认 durationHint）
 * - 依赖：request（dateStart/days/destination）+ intel（需带坐标条目）
 * - intel 缺失/为空/无坐标 → 结构化 {built:false, reason} 返回，**不落盘空
 *   itinerary.json**（下游 render 亦不产空页，§9.3-6）
 *
 * draft 路径（W4 完整校验链 §6 行 522：draft 由模型传入）：
 * - draft.days 结构过 validateItinerary 闸门（非法 → TravelValidationError）
 * - **intelRefs 引用存在性**：intel.json 存在且非空时，draft 每个 intelRef
 *   （stops+meals）必须存在于 intel.json，缺失列明报错（TravelValidationError）；
 *   intel.json 缺失/为空（检索未产出）→ 记 warning「引用存在性未校验」
 * - **修订保留**（FR-6 验收② + M3.1）：与既有 itinerary.json 比对，stops/meals/
 *   lodgingArea 逐项相等（名称/顺序/时长/来源引用/酒店区域）的未受影响天 →
 *   原样保留上一版结构
 * - **draft-only 修订**（M3.1 / design §9.2）：lodgingArea 修改 / 删减 stops /
 *   压缩某日只重建行程与页面（build/render），不触发任何研究；lodgingArea
 *   提供即须为非空字符串（确定性校验，零触网）
 * - **动线校验**：routeCheck 三级降级链（高德→腾讯→直线估算）结果写
 *   itinerary.json（issues/warnings；① 内只回摘要）
 *
 * 状态机：不扩展转换表（src/store/state.ts）——build 调用方=researching 态；
 * delivered→revising 需经真实 travel_update_request 修订入口。
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GeoCoords, IntelItem, Itinerary, ItineraryDay, ItineraryStop, PlacesArtifact, ResearchState, ResolvedPlace, RouteCheck, RouteTransportArtifact, Slots, TravelRequest } from '../models/types.js'
import { validateItinerary, isDateString, isNonEmptyString, daysBetweenInclusive, assertValidIssues } from '../models/validate.js'
import { TravelValidationError } from '../errors.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { assertTransition } from '../store/state.js'
import { cardLines, asRecord, losslessJson, textCard, toCanonicalJson } from './common.js'
import { computeResearchStatus } from './research-assessment.js'
import { canonicalRouteFromDays, runRouteCheck, createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider, estimateRouteProvider, type RouteCheckOptions, type RouteMeasureProvider } from '../route-check.js'
import { makeKeyEnv, type MakeKeyEnvHost } from '../adapters/env.js'
import { AmapAdapter } from '../adapters/amap.js'
import { TencentMapAdapter } from '../adapters/tencent.js'
import type { KeyResolutionEnv } from '../adapters/base.js'

/** 薄版默认超时（§6：build 60s）。 */
export const BUILD_TIMEOUT_MS = 60_000

/** 逐渠道降级记账 → warnings 面（W6 故障矩阵贯通；route-check degraded 明细透出）。 */
function routeDegradedWarnings(degraded: ReadonlyArray<{ channel: string; reason: string }>): string[] {
  return degraded.map((d) => `动线渠道降级（${d.channel}）：${d.reason}`)
}

async function publishItinerary(
  store: TravelStore,
  planId: string,
  request: TravelRequest,
  itinerary: Itinerary,
): Promise<void> {
  const expectedVersions = request.flowVersion !== undefined
    ? {
        research: await store.currentVersion(planId, 'research'),
        intel: await store.currentVersion(planId, 'intel'),
        places: await store.currentVersion(planId, 'places'),
      }
    : { intel: await store.currentVersion(planId, 'intel') }
  const files: Array<{ name: string; data: unknown }> = [{ name: 'itinerary.json', data: itinerary }]
  // One-time migration for clean legacy plans: if no manifest exists yet,
  // account for the legacy upstream snapshots in the same first publication.
  // A modern manifest with an unaccounted file is intentionally not adopted.
  if (await store.readArtifactManifest(planId) === undefined) {
    for (const name of ['intel.json', 'places.json', 'research-state.json'] as const) {
      const data = await store.readJson<unknown>(planId, name)
      if (data !== undefined) files.push({ name, data })
    }
  }
  await store.publishArtifacts(planId, {
    stage: 'itinerary',
    files,
    expectedVersions,
    bump: [],
    inputFingerprint: itinerary.canonicalRoute?.fingerprint ?? itinerary.itineraryId,
  })
}

/**
 * 消费读门（round3 仲裁口径）：`unknown`（未入账/版本不可知）＝**只读兼容**——
 * 数据可读并继续参与判定，但由状态投影如实标 unknown；仅「找不到 / 失败 / 空 /
 * 内容 hash 不符」不可消费（完整性/失败态，不得当最新数据用）。
 * 注意：places 的完整性阻断仍由 buildPlacesBlocked 单独负责（含未入账签名），
 * 本函数不改变其门控语义。
 */
function isSignedArtifactTamper<T>(name: string, state: ArtifactReadState<T>): boolean {
  const ownStage: Record<string, string> = {
    'itinerary.json': 'itinerary',
    'places.json': 'places',
    'transport.json': 'transport',
    'advice.json': 'advice',
    'rental-quotes.json': 'rental-quotes',
    'route-transport.json': 'route-transport',
    'route-coverage.json': 'coverage',
    'insights.json': 'insights',
  }
  return (state.status === 'unknown' || state.status === 'stale')
    && (state.staleReason === 'unaccounted' || state.staleReason === 'not_in_commit')
    && state.meta?.stage !== undefined
    && ownStage[name] === state.meta.stage
}

function consumableArtifact<T>(state: ArtifactReadState<T> | undefined, name?: string): T | undefined {
  if (state === undefined) return undefined
  if (name !== undefined && isSignedArtifactTamper(name, state)) return undefined
  if (!state.found || state.status === 'missing') return undefined
  if (state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

function artifactCompatibilityWarning<T>(name: string, state: ArtifactReadState<T> | undefined): string | undefined {
  if (state?.data === undefined || state.status === 'current' || (state !== undefined && isSignedArtifactTamper(name, state))) return undefined
  if (state.status === 'unknown') return `${name} 未入账或版本未知（unknown），仅按只读兼容消费`
  if (state.status === 'stale' && state.staleReason !== 'hash_mismatch') {
    return `${name} 依赖版本已变化（${state.staleReason ?? 'stale'}），仅按只读兼容消费`
  }
  return undefined
}

/**
 * places 工件非 ready → blocked 明细（C 门；缺/失败/为空/hash 失配都不复活）。
 * fix-f1f #4b：消费侧加研究版本门——places 引用的 intel 版本（places.intelVersion）
 * 落后于当前研究版本（research-state.researchVersion）→ 研究已前进但地理解析未
 * 重新执行，建造前必须先重新 resolve（旧 places 不消费，与 route-transport/advice
 * 已修的同类版本比较对齐）。
 */
function buildPlacesBlocked(
  placesState: ArtifactReadState<PlacesArtifact>,
  currentResearchVersion: number,
): { reason: string; detail: string; nextAction: string } | undefined {
  if (!placesState.found) {
    return {
      reason: 'places_not_ready',
      detail: '缺少 places.json：行程生成需要先完成地理解析与入口点确认',
      nextAction: '请先执行 travel_resolve_places（候选+入口点解析）后重试 travel_build_itinerary',
    }
  }
  if (isSignedArtifactTamper('places.json', placesState)) {
    return {
      reason: 'places_stale',
      detail: 'places manifest 声明最近提交为 places stage，但文件未入账（疑似篡改）：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布完整 places 工件后重试',
    }
  }
  if (placesState.status === 'failed' || placesState.meta?.status === 'failed') {
    return {
      reason: 'places_failed',
      detail: 'places 上次发布失败（不把失败当成功消费）',
      nextAction: '请重新执行 travel_resolve_places 修复解析后重试',
    }
  }
  if (placesState.status === 'empty' || placesState.meta?.status === 'empty') {
    return {
      reason: 'places_empty',
      detail: 'places 上次发布为空（零结果不复活）',
      nextAction: '请补足候选/澄清后重新执行 travel_resolve_places',
    }
  }
  if (placesState.status === 'stale' && placesState.staleReason === 'hash_mismatch') {
    return {
      reason: 'places_stale',
      detail: 'places 工件内容与最近提交 hash 不符（外部篡改/损坏）：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }
  // fix-f1f #4b：研究版本门——消费的 intel 版本落后当前研究版本 → 旧 places 不消费
  if (placesState.data !== undefined && placesState.data.intelVersion < currentResearchVersion) {
    return {
      reason: 'places_stale_intel',
      detail: `places 引用的 intel 证据版本（${placesState.data.intelVersion}）落后于当前研究版本（${currentResearchVersion}）：研究已前进但地理解析未重新执行，不得用旧坐标生成行程`,
      nextAction: '请基于当前研究版本重新执行 travel_resolve_places（重新解析候选）后重试 travel_build_itinerary',
    }
  }
  return undefined
}

/** 完整 plan 的研究/评估阶段门（C5①）：当前研究版本有效 + 评估为当前有效 sufficient。 */
async function buildResearchBlocked(
  store: TravelStore, planId: string,
): Promise<{ reason: string; nextAction: string } | undefined> {
  const status = await computeResearchStatus(store, planId)
  if (status.ready) return undefined
  return {
    reason: 'research_not_ready',
    nextAction: status.missing === 'stale_version'
      ? '研究版本已前进/评估过期：请基于当前研究版本重新 travel_record_research_assessment（verdict=sufficient）后再 build'
      : '请先完成研究（travel_research_destination）并提交 sufficient 评估（travel_record_research_assessment），再执行 travel_build_itinerary',
  }
}

/** 领域参数。 */
export interface BuildItineraryArgs {
  planId: string
  /** 模型传入的 draft 结构（同 §5.5 Itinerary.days；缺省 → 自动提案）。 */
  draft?: unknown
}

/** 工具返回（§6 行 522：itineraryId/days/routeCheck；built=false 表示依赖缺失）。 */
export interface BuildItineraryResult {
  itineraryId: string
  days: ItineraryDay[]
  routeCheck: RouteCheck
  /** false = 依赖缺失（intel 缺失/无坐标），未落盘 itinerary.json。 */
  built: boolean
  reason?: string
  /** C 门：完整 plan 依赖链（places 地理解析）未就绪 → 结构化 blocked + nextAction（零网络）。 */
  blocked?: { reason: string; nextAction: string }
}

/**
 * build 的动线校验依赖注入（测试/离线缺省 = 直线估算零触网；生产由工厂接线
 * 真实渠道 + makeKeyEnv 热快照——W6 src/adapters/env.ts）。
 */
export interface BuildRouteCheckDeps {
  /** 渠道测量源（有序候选；缺省 [直线估算]）。 */
  providers?: RouteMeasureProvider[]
  /** Key 解析环境（渠道开关/Key 门读取；缺省 undefined → 高德/腾讯不可用）。 */
  keyEnv?: KeyResolutionEnv
  /** 动线检测阈值（跨城/单日跨度等，参数化）。 */
  options?: RouteCheckOptions
  /** route-transport 旁车快照；仅在 final route fingerprint 相同时消费。 */
  routeTransportSnapshot?: RouteTransportArtifact
  /** 未入账/依赖版本过期的旁车兼容读取警告。 */
  routeTransportReadWarning?: string
}

const BUILD_PARAMETERS = {
  planId: {
    type: 'string',
    required: true,
    description: '计划 ID（必填）',
  } as const,
  draft: {
    type: 'object',
    additionalProperties: true,
    description: '可选：模型排好的行程草案（结构同 Itinerary.days，含 intelRefs）。缺省 → 基于 intel.json 自动提案。',
  } as const,
} as const

type BuildParams = InferArgs<typeof BUILD_PARAMETERS>

export const BUILD_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itineraryId: { type: 'string', required: true },
    days: { type: 'array', items: { type: 'json' }, required: true },
    routeCheck: {
      type: 'object',
      additionalProperties: false,
      properties: {
        issues: { type: 'array', items: { type: 'string' }, required: true },
        warnings: { type: 'array', items: { type: 'string' }, required: true },
      },
      required: true,
    },
    built: { type: 'boolean', required: true },
    reason: { type: 'string' },
    blocked: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true },
        nextAction: { type: 'string', required: true },
      },
    },
  },
} as const

type BuildOutput = InferValue<typeof BUILD_OUTPUT_SCHEMA>

// ────────────────────────── 自动提案纯逻辑 ──────────────────────────

/** 类别 → 建议停留时长（分钟）；W4 依据 intel 摘要/POI 字段细化。 */
const DEFAULT_DURATION_MINUTES: Partial<Record<ItineraryStop['category'], number>> = {
  attraction: 120,
  food: 60,
  transportLocal: 30,
}

/** YYYY-MM-DD 加 n 天（UTC；调用方保证 dateStart 合法）。 */
export function addDaysUtc(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d + n)
  return new Date(t).toISOString().slice(0, 10)
}

/** 带坐标条目的窄化类型（filter 后 keep 保证 coords 存在，免非空断言）。 */
type IntelWithCoords = IntelItem & { coords: NonNullable<IntelItem['coords']> }

function withCoords(item: IntelItem): item is IntelWithCoords {
  return item.coords !== undefined
}

/**
 * 已解析路线上下文。places 存在且有实际 selectedSequence 时，自动提案只使用
 * 已验证 placeId；缺住宿/抵达/离开锚点会结构化阻断，而不是用景区或虚构点位替代。
 */
export interface AutoProposeOptions {
  places?: PlacesArtifact
  previous?: Itinerary
}

/** 按 intel 自动提案行程（无 draft 路径；W4 在此扩展动线/偏好细化）。 */
export function autoProposeItinerary(
  planId: string,
  slots: Slots,
  intel: readonly IntelItem[],
  options: AutoProposeOptions = {},
): BuildItineraryResult {

  const destination = slots.destination
  const dateStart = slots.dateStart
  const dayCount = slots.days ?? (isDateString(dateStart) && isDateString(slots.dateEnd)
    ? daysBetweenInclusive(dateStart, slots.dateEnd)
    : 1)

  const coordsItems = intel.filter(withCoords)
  if (coordsItems.length === 0) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
      reason: 'intel.json 无带坐标条目（POI/L0 均未提供坐标位置），无法自动编排每日行程。可尝试重新检索或传入 draft。',
    }
  }
  if (!isNonEmptyString(dateStart)) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
      reason: '槽位缺少 dateStart（YYYY-MM-DD），无法生成按日行程。请先 travel_update_request 补齐日期。',
    }
  }

  if (options.places !== undefined && shouldUseResolvedRoute(options.places)) {
    return autoProposeResolvedRoute(planId, slots, intel, options.places, options.previous)
  }

  const attractions = coordsItems.filter((i) => i.category === 'attraction')
  const foods = coordsItems.filter((i) => i.category === 'food')
  const transportIntels = coordsItems.filter((i) => i.category === 'transportLocal')
  const perDay = Math.max(1, Math.ceil(attractions.length / dayCount))

  const days: ItineraryDay[] = []
  const legacyAnchor = coordsItems[0]
  const legacyPlaceId = `legacy-anchor-${planId}`
  const legacyOccurrence = (role: string, index: number): string => `${legacyPlaceId}-${role}-${index}`
  const makeLegacyAnchor = (role: NonNullable<ItineraryStop['anchorRole']>, occurrenceId: string): ItineraryStop => ({
    placeId: legacyPlaceId,
    occurrenceId,
    name: destination ?? '行程锚点',
    category: 'lodging',
    coords: legacyAnchor.coords,
    anchorRole: role,
    durationHint: 30,
    // 纯函数兼容路径没有 places 解析上下文，只使用真实 intel 坐标并保留来源引用；
    // 完整 plan 经过上面的 resolved-route 分支，不会把此派生 id 落盘。
    intelRefs: [legacyAnchor.id],
    note: 'legacy 自动提案锚点（完整 plan 请先完成 places 解析）',
  })
  for (let di = 0; di < dayCount; di++) {
    const dayAttractions = attractions.slice(di * perDay, (di + 1) * perDay)
    // 美食轮转：每日一餐（薄版）；住宿/市内交通不占 stops（W4 细化）
    const dayFood = foods.length > 0 ? [foods[di % foods.length]] : []
    const regularStops: ItineraryStop[] = [
      ...dayAttractions.map((a): ItineraryStop => toStop(a, 'attraction', 120)),
      ...dayFood.map((f): ItineraryStop => toStop(f, 'food', 60)),
    ]
    if (regularStops.length === 0 && transportIntels.length > 0 && di < transportIntels.length) {
      regularStops.push(toStop(transportIntels[di], 'transportLocal', 30))
    }
    const firstOccurrence = di === 0 ? legacyOccurrence('arrival', 1) : legacyOccurrence('lodging', di)
    const lastOccurrence = legacyOccurrence(di === dayCount - 1 ? 'departure' : 'lodging', di + 1)
    const stops: ItineraryStop[] = [
      makeLegacyAnchor(di === 0 ? 'arrival' : 'lodging', firstOccurrence),
      ...regularStops,
      makeLegacyAnchor(di === dayCount - 1 ? 'departure' : 'lodging', lastOccurrence),
    ]
    days.push({
      date: addDaysUtc(dateStart, di),
      theme: regularStops.length > 0 ? undefined : `第${di + 1}天`,
      stops,
      meals: dayFood.map((f) => ({ name: f.title, intelRefs: [f.id] })),
      lodgingArea: destination,
    })
  }

  const warnings: string[] = []
  if (attractions.length < dayCount) {
    warnings.push(`景点坐标线索（${attractions.length}）少于行程天数（${dayCount}），部分天以美食/机动为主`)
  }
  if (intel.length === 0) {
    warnings.push('intel 无条目，行程为占位提案（请先 travel_research_destination）')
  }
  const itinerary: Itinerary = {
    itineraryId: itineraryIdFor(planId),
    days,
    routeCheck: { issues: [], warnings },
  }
  assertValidIssues(validateItinerary(itinerary)) // 落盘前契约闸门
  return { itineraryId: itinerary.itineraryId, days, routeCheck: itinerary.routeCheck, built: true }
}

/** intel 条目 → ItineraryStop（name/coords/sys/intelRefs/note 摘要）。 */
function toStop(item: IntelWithCoords, category: ItineraryStop['category'], fallbackMinutes: number): ItineraryStop {
  const hint = DEFAULT_DURATION_MINUTES[category] ?? fallbackMinutes
  return {
    name: item.title,
    category,
    coords: item.coords,
    durationHint: hint,
    intelRefs: [item.id],
    // Keep page-facing itinerary data free of raw research summaries; intelRefs
    // remains the auditable pointer and正文详情 is read separately on demand.
    note: '已从检索条目归一化；详情请按 intelRefs 读取',
  }
}

function shouldUseResolvedRoute(places: PlacesArtifact): boolean {
  return (places.selectedSequence?.length ?? 0) > 1
    || places.places.some((place) => place.kind === 'lodging')
}

function compactName(value: string): string {
  return value.replace(/[\s·•,，。/\-()（）【】「」]/g, '').toLocaleLowerCase()
}

function placeMatchesName(place: ResolvedPlace, requested: string): boolean {
  const actual = compactName(place.name)
  const wanted = compactName(requested)
  return wanted.length > 0 && (actual === wanted || actual.includes(wanted) || wanted.includes(actual))
}

function isStayPlace(place: ResolvedPlace): boolean {
  return place.kind === 'lodging' || place.kind === 'area'
}

function isStayReason(place: ResolvedPlace): boolean {
  return place.kind === 'lodging' || /住宿|入住|酒店|旅馆|还车|返程/.test(place.selectionReason ?? '')
}

/** 从 selectionReason 的 D3/D3-D4 标签提取天号；仅作调用方已提供理由的确定性分桶。 */
function dayHints(reason: string | undefined, dayCount: number): number[] {
  const result = new Set<number>()
  const re = /D\s*(\d+)(?:\s*[-–—~至到]\s*D?\s*(\d+))?/gi
  for (const match of reason?.matchAll(re) ?? []) {
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue
    for (let day = Math.min(start, end); day <= Math.max(start, end); day++) {
      if (day >= 1 && day <= dayCount) result.add(day)
    }
  }
  return [...result].sort((a, b) => a - b)
}

function hasCoords(place: ResolvedPlace): place is ResolvedPlace & { coords: NonNullable<ResolvedPlace['coords']> } {
  return place.coords !== undefined
}

interface AnchorPlan {
  arrival: ResolvedPlace
  departure: ResolvedPlace
  lodging: Array<ResolvedPlace | undefined>
  blocked?: { reason: string; nextAction: string }
}

interface PlaceContext {
  places: PlacesArtifact
  byCandidate: Map<string, ResolvedPlace>
  byPlace: Map<string, ResolvedPlace>
  candidateById: Map<string, PlacesArtifact['candidates'][number]>
  sequence: ResolvedPlace[]
  sequenceRank: Map<string, number>
}

function createPlaceContext(artifact: PlacesArtifact): PlaceContext {
  const byCandidate = new Map(artifact.places.map((place) => [place.candidateId, place]))
  const byPlace = new Map(artifact.places.map((place) => [place.placeId, place]))
  const candidateById = new Map(artifact.candidates.map((candidate) => [candidate.candidateId, candidate]))
  const sequence: ResolvedPlace[] = []
  const seenAdjacent = new Set<string>()
  for (const id of artifact.selectedSequence ?? []) {
    const place = byCandidate.get(id) ?? byPlace.get(id)
    if (place === undefined) continue
    if (seenAdjacent.has(place.placeId)) continue
    seenAdjacent.clear()
    seenAdjacent.add(place.placeId)
    sequence.push(place)
  }
  const sequenceRank = new Map<string, number>()
  sequence.forEach((place, index) => {
    if (!sequenceRank.has(place.placeId)) sequenceRank.set(place.placeId, index)
    if (!sequenceRank.has(place.candidateId)) sequenceRank.set(place.candidateId, index)
  })
  return { places: artifact, byCandidate, byPlace, candidateById, sequence, sequenceRank }
}

function findDeparture(context: PlaceContext): ResolvedPlace | undefined {
  const explicit = context.sequence.filter((place) =>
    hasCoords(place) && (isHubPlaceForBuild(place) || /离开|返程|还车|departure/i.test(place.selectionReason ?? '')))
  return explicit.at(-1) ?? context.sequence.at(-1)
}

function isHubPlaceForBuild(place: ResolvedPlace): boolean {
  return place.kind === 'hub' || place.pointKind === 'hub'
}

function resolveAnchorByName(context: PlaceContext, name: string): ResolvedPlace | undefined {
  return context.places.places
    .filter((place) => isStayPlace(place) && hasCoords(place))
    .sort((a, b) => (context.sequenceRank.get(a.placeId) ?? Number.MAX_SAFE_INTEGER)
      - (context.sequenceRank.get(b.placeId) ?? Number.MAX_SAFE_INTEGER))
    .find((place) => placeMatchesName(place, name))
}

function deriveAnchorPlan(
  context: PlaceContext,
  dayCount: number,
  requestedLodging: readonly (string | undefined)[],
): AnchorPlan {
  const arrival = context.places.entryPlaceId !== undefined
    ? context.byPlace.get(context.places.entryPlaceId)
    : context.sequence.find((place) => isHubPlaceForBuild(place)) ?? context.sequence[0]
  const departure = findDeparture(context)
  if (arrival === undefined || !hasCoords(arrival)) {
    return {
      arrival: arrival ?? context.sequence[0] ?? context.places.places[0]!,
      departure: departure ?? arrival ?? context.sequence[0] ?? context.places.places[0]!,
      lodging: [],
      blocked: {
        reason: '缺少已解析抵达/入口锚点或其坐标',
        nextAction: '请先执行 travel_resolve_places 解析 entryPlaceId（车站/机场/取车点）后重试',
      },
    }
  }
  if (departure === undefined || !hasCoords(departure)) {
    return {
      arrival,
      departure: departure ?? arrival,
      lodging: [],
      blocked: {
        reason: '缺少已解析离开/返程锚点或其坐标',
        nextAction: '请先执行 travel_resolve_places 补充末日离开点/还车点后重试',
      },
    }
  }

  const candidates = context.places.places
    .filter((place) => isStayPlace(place) && hasCoords(place))
    .sort((a, b) => (context.sequenceRank.get(a.placeId) ?? Number.MAX_SAFE_INTEGER)
      - (context.sequenceRank.get(b.placeId) ?? Number.MAX_SAFE_INTEGER))
  const hinted = candidates.some((place) => dayHints(place.selectionReason, dayCount).length > 0)
  const sequentialCandidates = candidates.filter((place) => place.placeId !== departure.placeId)
  const lodging: Array<ResolvedPlace | undefined> = []
  let sequentialIndex = 0
  for (let day = 1; day < dayCount; day++) {
    const requested = requestedLodging[day]
    if (requested !== undefined) {
      const matched = resolveAnchorByName(context, requested)
      if (matched === undefined) {
        return {
          arrival, departure, lodging,
          blocked: {
            reason: `第${day}天住宿锚点「${requested}」未在 places.json 解析，不能用景区点位替代住宿`,
            nextAction: '请先执行 travel_resolve_places 解析该住宿区域/酒店并重试 travel_build_itinerary',
          },
        }
      }
      lodging.push(matched)
      continue
    }
    const hintedCandidate = hinted
      ? candidates.find((place) => dayHints(place.selectionReason, dayCount).includes(day) && isStayReason(place))
      : undefined
    if (hintedCandidate !== undefined) {
      lodging.push(hintedCandidate)
      continue
    }
    if (!hinted && sequentialIndex < sequentialCandidates.length) {
      const candidate = sequentialCandidates[sequentialIndex]
      sequentialIndex += 1
      lodging.push(candidate)
      continue
    }
    // A single resolved area is a valid continuous lodging anchor (for example,
    // a city-base itinerary); reuse it rather than treating a known area as missing.
    const reusable = candidates.find((place) => place.placeId !== departure.placeId) ?? candidates[0]
    if (!hinted && reusable !== undefined) {
      lodging.push(reusable)
      continue
    }
    return {
      arrival, departure, lodging,
      blocked: {
        reason: `第${day}天缺少已解析住宿锚点（lodging/area），不使用景区点位或虚构坐标补齐日界`,
        nextAction: '请先执行 travel_resolve_places 补充该日住宿区域/酒店的 placeId 后重试',
      },
    }
  }
  return { arrival, departure, lodging }
}

function refsForPlace(
  place: ResolvedPlace,
  context: PlaceContext,
  intel: readonly IntelItem[],
): string[] {
  const known = new Set(intel.map((item) => item.id))
  const declared = context.candidateById.get(place.candidateId)?.intelRefs ?? []
  const refs = declared.filter((ref) => known.has(ref))
  if (refs.length > 0) return refs
  return intel.filter((item) => item.coords !== undefined
    && item.title === place.name).map((item) => item.id)
}

function buildPlaceStop(
  place: ResolvedPlace & { coords: NonNullable<ResolvedPlace['coords']> },
  role: NonNullable<ItineraryStop['anchorRole']>,
  occurrenceId: string,
  context: PlaceContext,
  intel: readonly IntelItem[],
): ItineraryStop {
  const anchor = role !== 'stop'
  const category: ItineraryStop['category'] = anchor
    ? 'lodging'
    : place.kind === 'attraction' ? 'attraction' : place.kind === 'hub' ? 'transportLocal' : 'lodging'
  const refs = refsForPlace(place, context, intel)
  const note = place.areaReferenceEstimate
    ? '区域参考点：仅作为住宿/区域衔接参考，不代表具体酒店入口'
    : `已解析地点（${place.source}；坐标系=${place.coords.sys}）`
  return {
    placeId: place.placeId,
    occurrenceId,
    name: place.name,
    category,
    coords: place.coords,
    anchorRole: role,
    durationHint: DEFAULT_DURATION_MINUTES[category] ?? (anchor ? 30 : 120),
    intelRefs: refs,
    note,
  }
}

function autoProposeResolvedRoute(
  planId: string,
  slots: Slots,
  intel: readonly IntelItem[],
  artifact: PlacesArtifact,
  previous: Itinerary | undefined,
): BuildItineraryResult {
  const dateStart = slots.dateStart
  if (!isNonEmptyString(dateStart)) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
      reason: '槽位缺少 dateStart（YYYY-MM-DD），无法生成按日行程。',
    }
  }
  const dayCount = slots.days ?? (isDateString(dateStart) && isDateString(slots.dateEnd)
    ? daysBetweenInclusive(dateStart, slots.dateEnd) : 1)
  const context = createPlaceContext(artifact)
  if (context.places.places.length === 0 || context.sequence.length === 0) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
      blocked: { reason: 'places.json 没有可用于路线的已解析 selectedSequence', nextAction: '请先执行 travel_resolve_places 解析抵达点、住宿锚点和路线地点后重试' },
    }
  }
  const requested = previous?.days.map((day) => day.lodgingArea)
    ?? Array.from({ length: Math.max(0, dayCount - 1) }, () => undefined)
  const anchors = deriveAnchorPlan(context, dayCount, requested)
  if (anchors.blocked !== undefined) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] }, blocked: anchors.blocked,
    }
  }
  if (!hasCoords(anchors.arrival) || !hasCoords(anchors.departure)) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
      blocked: { reason: '抵达/离开锚点缺少坐标', nextAction: '请先 travel_resolve_places 补齐锚点坐标后重试' },
    }
  }
  const staySet = new Set(anchors.lodging.filter((place): place is ResolvedPlace => place !== undefined).map((place) => place.placeId))
  const regular = context.sequence.filter((place) => place.placeId !== anchors.arrival.placeId
    && place.placeId !== anchors.departure.placeId && !staySet.has(place.placeId) && hasCoords(place))
  const buckets: ResolvedPlace[][] = Array.from({ length: dayCount }, () => [])
  let unhinted = 0
  for (const place of regular) {
    const hints = dayHints(place.selectionReason, dayCount)
    const hintedDay = hints.find((day) => day <= dayCount)
    const dayIndex = hintedDay !== undefined
      ? hintedDay - 1
      : Math.min(dayCount - 1, Math.floor((unhinted++ * dayCount) / Math.max(1, regular.length)))
    buckets[dayIndex]?.push(place)
  }

  const occurrenceCounts = new Map<string, number>()
  const nextOccurrence = (place: ResolvedPlace, role: string): string => {
    const next = (occurrenceCounts.get(place.placeId) ?? 0) + 1
    occurrenceCounts.set(place.placeId, next)
    return `${place.placeId}-${role}-${next}`
  }
  const days: ItineraryDay[] = []
  let priorLodging: { place: ResolvedPlace; occurrenceId: string } | undefined
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const first = dayIndex === 0
      ? { place: anchors.arrival, occurrenceId: nextOccurrence(anchors.arrival, 'arrival') }
      : priorLodging
    if (first === undefined || !hasCoords(first.place)) {
      return {
        itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
        blocked: { reason: `第${dayIndex + 1}天缺少连续起点住宿锚点`, nextAction: '请先解析连续住宿区域后重试' },
      }
    }
    const stops: ItineraryStop[] = [buildPlaceStop(first.place, dayIndex === 0 ? 'arrival' : 'lodging', first.occurrenceId, context, intel)]
    for (const place of buckets[dayIndex] ?? []) {
      if (!hasCoords(place) || place.placeId === stops.at(-1)?.placeId) continue
      stops.push(buildPlaceStop(place, 'stop', nextOccurrence(place, 'stop'), context, intel))
    }
    const lastPlace = dayIndex === dayCount - 1 ? anchors.departure : anchors.lodging[dayIndex]
    if (lastPlace === undefined || !hasCoords(lastPlace)) {
      return {
        itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
        blocked: { reason: `第${dayIndex + 1}天缺少已解析住宿/离开锚点`, nextAction: '请先执行 travel_resolve_places 补充锚点后重试' },
      }
    }
    const sameAsLast = stops.at(-1)?.placeId === lastPlace.placeId
    if (sameAsLast && dayIndex > 0 && dayIndex < dayCount - 1) {
      const last = stops.at(-1)
      if (last !== undefined) last.anchorRole = 'lodging'
      priorLodging = { place: lastPlace, occurrenceId: last?.occurrenceId ?? nextOccurrence(lastPlace, 'lodging') }
    } else {
      const occurrenceId = nextOccurrence(lastPlace, dayIndex === dayCount - 1 ? 'departure' : 'lodging')
      stops.push(buildPlaceStop(lastPlace, dayIndex === dayCount - 1 ? 'departure' : 'lodging', occurrenceId, context, intel))
      if (dayIndex < dayCount - 1) priorLodging = { place: lastPlace, occurrenceId }
    }
    days.push({
      date: addDaysUtc(dateStart, dayIndex),
      theme: buckets[dayIndex]?.length === 0 ? `第${dayIndex + 1}天机动/衔接` : undefined,
      stops,
      meals: [],
      ...(dayIndex < dayCount - 1 ? { lodgingArea: lastPlace.name } : {}),
    })
  }
  const route = canonicalRouteFromDays(days)
  const warnings = regular.length < dayCount
    ? [`已解析路线停靠点（${regular.length}）少于行程天数（${dayCount}），部分天以住宿/衔接锚点为主`]
    : []
  const itinerary: Itinerary = { schemaVersion: 2, itineraryId: itineraryIdFor(planId), days, canonicalRoute: route, routeCheck: { issues: [], warnings } }
  assertValidIssues(validateItinerary(itinerary))
  return { itineraryId: itinerary.itineraryId, days, routeCheck: itinerary.routeCheck, built: true }
}

interface NormalizedDraftRoute {
  days?: ItineraryDay[]
  blocked?: { reason: string; nextAction: string }
}

function resolveDraftPlace(stop: ItineraryStop, context: PlaceContext): ResolvedPlace | undefined {
  if (stop.placeId !== undefined) {
    const byPlace = context.byPlace.get(stop.placeId) ?? context.byCandidate.get(stop.placeId)
    if (byPlace !== undefined) return byPlace
  }
  return context.places.places.find((place) => place.name.trim() === stop.name.trim()
    && place.coords !== undefined && coordsClose(place.coords, stop.coords))
}

function normalizeDraftResolvedRouteDays(
  rawDays: ItineraryDay[],
  artifact: PlacesArtifact,
): NormalizedDraftRoute {
  const context = createPlaceContext(artifact)
  if (context.sequence.length === 0) {
    return { blocked: { reason: 'draft 路线不在已解析 selectedSequence 中', nextAction: '请先 travel_resolve_places 补齐选中路线地点后重试' } }
  }
  const dayCount = rawDays.length
  const anchors = deriveAnchorPlan(context, dayCount, rawDays.map((day) => day.lodgingArea))
  if (anchors.blocked !== undefined) return { blocked: anchors.blocked }
  if (!hasCoords(anchors.arrival) || !hasCoords(anchors.departure)) {
    return { blocked: { reason: 'draft 的抵达/离开锚点缺少已解析坐标', nextAction: '请先 travel_resolve_places 补齐入口与离开点后重试' } }
  }
  const regularByDay: ResolvedPlace[][] = []
  const rawByDay: ItineraryStop[][] = []
  for (const [dayIndex, day] of rawDays.entries()) {
    const pair: Array<{ place: ResolvedPlace; stop: ItineraryStop; rank: number }> = []
    for (const stop of day.stops) {
      if (stop.anchorRole !== undefined && stop.anchorRole !== 'stop') continue
      const place = resolveDraftPlace(stop, context)
      if (place === undefined || !hasCoords(place)) {
        return {
          blocked: {
            reason: `draft 第${dayIndex + 1}天存在未在 places.json 解析的路线点「${stop.name}」`,
            nextAction: '请先执行 travel_resolve_places 解析该地点并纳入 selectedSequence 后重试',
          },
        }
      }
      const rank = context.sequenceRank.get(place.placeId)
      if (rank === undefined) {
        return {
          blocked: {
            reason: `draft 路线点「${place.name}」不在已验证 selectedSequence 中`,
            nextAction: '请调整 draft 顺序或先执行 travel_resolve_places 更新 selectedSequence',
          },
        }
      }
      pair.push({ place, stop, rank })
    }
    pair.sort((a, b) => a.rank - b.rank)
    regularByDay.push(pair.map((entry) => entry.place))
    rawByDay.push(pair.map((entry) => entry.stop))
  }

  const occurrenceCounts = new Map<string, number>()
  const nextOccurrence = (place: ResolvedPlace, role: string): string => {
    const next = (occurrenceCounts.get(place.placeId) ?? 0) + 1
    occurrenceCounts.set(place.placeId, next)
    return `${place.placeId}-${role}-${next}`
  }
  const days: ItineraryDay[] = []
  let priorLodging: { place: ResolvedPlace; occurrenceId: string } | undefined
  const staySet = new Set(anchors.lodging.filter((place): place is ResolvedPlace => place !== undefined).map((place) => place.placeId))
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const first = dayIndex === 0
      ? { place: anchors.arrival, occurrenceId: nextOccurrence(anchors.arrival, 'arrival') }
      : priorLodging
    if (first === undefined || !hasCoords(first.place)) {
      return { blocked: { reason: `draft 第${dayIndex + 1}天缺少连续住宿起点`, nextAction: '请补充已解析住宿锚点后重试' } }
    }
    const stops: ItineraryStop[] = [buildPlaceStop(first.place, dayIndex === 0 ? 'arrival' : 'lodging', first.occurrenceId, context, [])]
    const rawStops = rawByDay[dayIndex] ?? []
    const places = regularByDay[dayIndex] ?? []
    for (const [index, place] of places.entries()) {
      if (!hasCoords(place) || place.placeId === stops.at(-1)?.placeId || staySet.has(place.placeId)) continue
      const raw = rawStops[index]
      const base = raw ?? buildPlaceStop(place, 'stop', nextOccurrence(place, 'stop'), context, [])
      const occurrenceId = nextOccurrence(place, 'stop')
      stops.push({
        ...base,
        placeId: place.placeId,
        occurrenceId,
        name: place.name,
        coords: place.coords,
        anchorRole: 'stop',
      })
    }
    const lastPlace = dayIndex === dayCount - 1 ? anchors.departure : anchors.lodging[dayIndex]
    if (lastPlace === undefined || !hasCoords(lastPlace)) {
      return { blocked: { reason: `draft 第${dayIndex + 1}天缺少已解析日尾锚点`, nextAction: '请补充住宿/离开点 placeId 后重试' } }
    }
    if (dayIndex > 0 && dayIndex < dayCount - 1 && stops.at(-1)?.placeId === lastPlace.placeId) {
      const last = stops.at(-1)
      if (last !== undefined) last.anchorRole = 'lodging'
      priorLodging = { place: lastPlace, occurrenceId: last?.occurrenceId ?? nextOccurrence(lastPlace, 'lodging') }
    } else {
      const role = dayIndex === dayCount - 1 ? 'departure' : 'lodging'
      const occurrenceId = nextOccurrence(lastPlace, role)
      stops.push(buildPlaceStop(lastPlace, role, occurrenceId, context, []))
      if (dayIndex < dayCount - 1) priorLodging = { place: lastPlace, occurrenceId }
    }
    days.push({
      ...rawDays[dayIndex],
      stops,
      lodgingArea: dayIndex < dayCount - 1 ? lastPlace.name : rawDays[dayIndex]?.lodgingArea,
    })
  }
  return { days }
}

/** itineraryId：同 planId 稳定复用（修订重建变更策略归 W4）。 */
function itineraryIdFor(planId: string): string {
  return `itinerary-${planId}`
}

/**
 * draft lodgingArea 确定性校验（M3.1 失败分支）：提供即须为非空字符串（空/空白=
 * 「区域不存在」），离线零触网抛 TravelValidationError。
 */
function validateDraftLodgingAreas(days: ItineraryDay[]): string[] {
  const issues: string[] = []
  days.forEach((day, i) => {
    if (day.lodgingArea !== undefined && !isNonEmptyString(day.lodgingArea)) {
      issues.push(`draft.days[${i}].lodgingArea: 须为非空字符串（酒店区域不存在/为空；请给出有效区域或删除该字段）`)
    }
  })
  return issues
}

/** draft 校验 + 原样聚合（W4 在 assertValidIssues 后接 intelRefs 存在性/动线校验）。 */
function aggregateDraft(draft: unknown): { days: ItineraryDay[] } {
  const draftRec = asRecord(draft)
  const daysValue = draftRec.days
  if (!Array.isArray(daysValue) || daysValue.length === 0) {
    throw new TravelValidationError(['draft.days 必须为非空数组（结构同 Itinerary.days）'])
  }
  const skeleton: Itinerary = {
    itineraryId: 'draft',
    days: daysValue as ItineraryDay[],
    routeCheck: { issues: [], warnings: [] },
  }
  assertValidIssues(validateItinerary(skeleton), 'draft.')
  const lodgingIssues = validateDraftLodgingAreas(daysValue as ItineraryDay[])
  if (lodgingIssues.length > 0) throw new TravelValidationError(lodgingIssues)
  return { days: daysValue as ItineraryDay[] }
}

/** 旁车只绑定同一最终路线指纹；旧 selectedSequence 旁车不会污染新日程。 */
function routeOptionsForDays(
  base: RouteCheckOptions,
  days: readonly ItineraryDay[],
  snapshot: RouteTransportArtifact | undefined,
): RouteCheckOptions {
  if (base.routeTransport !== undefined) return base
  if (snapshot === undefined) return base
  const fingerprint = canonicalRouteFromDays(days).fingerprint
  return snapshot.inputFingerprint === fingerprint
    ? { ...base, routeTransport: snapshot.legs }
    : base
}

/** draft 校验 + intelRefs 引用存在性 + 修订保留 + 动线校验（W4 完整链路）。 */
async function buildFromDraft(
  args: BuildItineraryArgs,
  request: TravelRequest,
  store: TravelStore,
  deps: BuildRouteCheckDeps,
): Promise<BuildItineraryResult> {
  const now = new Date().toISOString()
  const { days: rawDays } = aggregateDraft(args.draft)

  // intelRefs 引用存在性校验（FR-6 spec / T7 必测）：unknown 允许只读兼容，
  // 失败/空/hash mismatch 不消费，并由 warnings 留下状态证据。
  const intelState = await store.readArtifactWithState<IntelItem[]>(args.planId, 'intel.json')
  const intelData = consumableArtifact(intelState, 'intel.json')
  const intel = Array.isArray(intelData) ? intelData : undefined
  const refWarnings: string[] = []
  const intelCompatibilityWarning = artifactCompatibilityWarning('intel.json', intelState)
  if (intelCompatibilityWarning !== undefined) refWarnings.push(intelCompatibilityWarning)
  if (deps.routeTransportReadWarning !== undefined) refWarnings.push(deps.routeTransportReadWarning)
  if (intel === undefined || intel.length === 0) {
    refWarnings.push('intel.json 缺失或为空（检索未产出条目/全渠道失败），draft intelRefs 引用存在性未校验')
  } else {
    const missing = collectMissingIntelRefs(rawDays, intel)
    if (missing.length > 0) {
      throw new TravelValidationError(missing) // 列明每个缺失引用
    }
  }

  // C5② R-2：不静默接受 draft 自带坐标。完整 plan（flowVersion）下每个带坐标 stop 的
  // 坐标必须可归属——匹配 places.json 已解析地点（同名且坐标一致）或经 intelRefs 归属到
  // 带坐标的 intel 条目；否则坐标来源未知 → 拒绝（列明），绝不用臆造坐标当解析结果。
  if (request.flowVersion !== undefined) {
    await rejectUnboundDraftCoords(args.planId, rawDays, intel, store)
  }

  // 修订保留（FR-6 验收②）：未受影响天（stops/meals 逐项相等）→ 原样保留上一版结构
  const previousState = await store.readArtifactWithState<Itinerary>(args.planId, 'itinerary.json')
  const prev = consumableArtifact(previousState, 'itinerary.json')
  const placesState = await store.readArtifactWithState<PlacesArtifact>(args.planId, 'places.json')
  const places = consumableArtifact(placesState, 'places.json')
  const placesCompatibilityWarning = artifactCompatibilityWarning('places.json', placesState)
  if (placesCompatibilityWarning !== undefined) refWarnings.push(placesCompatibilityWarning)
  const modernRoute = request.flowVersion !== undefined && places !== undefined && shouldUseResolvedRoute(places)
  const preserved = preserveUnchangedDays(prev, rawDays)
  let days = preserved
  if (modernRoute && places !== undefined) {
    const normalized = normalizeDraftResolvedRouteDays(preserved, places)
    if (normalized.blocked !== undefined) {
      return { itineraryId: '', days: [], routeCheck: { issues: [], warnings: [] }, built: false, blocked: normalized.blocked }
    }
    if (normalized.days === undefined) {
      return { itineraryId: '', days: [], routeCheck: { issues: [], warnings: [] }, built: false,
        reason: 'draft 规范化未产出行程日' }
    }
    days = normalized.days
  }

  const canonicalRoute = modernRoute ? canonicalRouteFromDays(days) : undefined
  // 动线校验（三级降级链）→ routeCheck 写 itinerary.json（§5.5 契约）
  // T24：附带 stop→placeId 绑定表（拿不到则省略键 → 回退有限估算阈值）。
  const draftBindings = await stopPlaceIdBindings(args.planId, days, store)
  const baseOptions = {
    ...(deps.options ?? {}),
    ...(draftBindings !== undefined ? { stopPlaceIds: draftBindings } : {}),
    providers: deps.providers,
    keyEnv: deps.keyEnv,
    ...(canonicalRoute !== undefined ? { routeFingerprint: canonicalRoute.fingerprint } : {}),
  }
  const routeOptions = routeOptionsForDays(baseOptions, days, deps.routeTransportSnapshot)
  const detail = await runRouteCheck(days, routeOptions)
  const itinerary: Itinerary = {
    ...(modernRoute ? { schemaVersion: 2 } : {}),
    itineraryId: itineraryIdFor(args.planId),
    days,
    ...(canonicalRoute !== undefined ? { canonicalRoute } : {}),
    routeCheck: { issues: detail.issues, warnings: [...refWarnings, ...detail.warnings, ...routeDegradedWarnings(detail.degraded)] },
  }
  assertValidIssues(validateItinerary(itinerary))
  await publishItinerary(store, args.planId, request, itinerary)
  await store.saveRequest({ ...request, status: 'generating', updatedAt: now })
  return { itineraryId: itinerary.itineraryId, days, routeCheck: itinerary.routeCheck, built: true }
}

/** 两坐标是否接近（Lng/Lat 各 ≤0.01°≈1km，容忍 GCJ/微差）。 */
function coordsClose(a: GeoCoords, b: GeoCoords): boolean {
  return Math.abs(a.lng - b.lng) <= 0.01 && Math.abs(a.lat - b.lat) <= 0.01
}

/**
 * T24：stop → 已解析 placeId 绑定表（route-check 用）。
 *
 * 绑定凭据与 R-2 的坐标归属同源同判据：stop 必须同名且坐标一致地匹配到
 * places.json 的已解析地点（coordsClose）才承认归属；经 intelRefs 归属的 stop
 * 只承认「所引 intel 与 places 同名地点坐标一致」的情形，否则不写绑定。
 * 拿不到可靠绑定就不要写表项——route-check 会因此回退有限估算阈值，而不是把
 * 某条无关 leg 的里程当成该段的驾驶距离。
 */
async function stopPlaceIdBindings(
  planId: string,
  days: readonly ItineraryDay[],
  store: TravelStore,
): Promise<Map<ItineraryStop, string> | undefined> {
  const placesState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  const places = consumableArtifact(placesState, 'places.json')
  const candidates = (places?.places ?? []).filter((p) => p.coords !== undefined
    && typeof p.placeId === 'string' && p.placeId.trim() !== '')
  if (candidates.length === 0) return undefined
  const bindings = new Map<ItineraryStop, string>()
  for (const day of days) {
    for (const stop of day.stops) {
      if (stop.placeId !== undefined) {
        const direct = candidates.find((place) => place.placeId === stop.placeId)
        if (direct !== undefined) {
          bindings.set(stop, direct.placeId)
          continue
        }
      }
      const match = candidates.find((place) => place.name.trim() === stop.name.trim()
        && place.coords !== undefined && coordsClose(place.coords, stop.coords))
      if (match !== undefined) bindings.set(stop, match.placeId)
    }
  }
  return bindings.size > 0 ? bindings : undefined
}

/**
 * C5② R-2：拒绝「坐标来源未知」的 draft stop（不静默接受模型臆造坐标）。
 * 完整 plan 下，每个带坐标 stop 的坐标必须可归属其一：
 * - 匹配 places.json 已解析地点（同名且坐标一致），或
 * - 经该 stop 的 intelRefs 归属到带已验证坐标的 intel 条目，**且该 intel 坐标
 *   与 stop.coords 一致（coordsClose）**——仅「带坐标」不足为凭（fix-f1e C：
 *   来源错配的坐标不得冒充归属）。
 * 两者皆无 → 该 stop 坐标来源未知 → TravelValidationError 逐条列明（不落盘半成品）。
 */
async function rejectUnboundDraftCoords(
  planId: string,
  days: ItineraryDay[],
  intel: readonly IntelItem[] | undefined,
  store: TravelStore,
): Promise<void> {
  const placesState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  const places = consumableArtifact(placesState, 'places.json')
  const byName = new Map<string, ResolvedPlace[]>()
  for (const p of places?.places ?? []) {
    const key = p.name.trim()
    const arr = byName.get(key) ?? []
    arr.push(p)
    byName.set(key, arr)
  }
  const intelById = new Map((intel ?? []).map((i) => [i.id, i]))
  const matchablePlaces = (places?.places ?? []).filter((place) => place.coords !== undefined)
  const matchableHint = matchablePlaces.length > 0
    ? `当前可匹配 place：${matchablePlaces.map((place) => `${place.name} [placeId=${place.placeId}, candidateId=${place.candidateId}]`).join('；')}`
    : '当前 places 快照无可匹配候选（无已解析坐标地点）'
  const unbound: string[] = []
  days.forEach((day, di) => {
    day.stops.forEach((stop, si) => {
      if (stop.coords === undefined) return
      // 归属①：places.json 同名已解析地点且坐标一致
      const matched = byName.get(stop.name.trim()) ?? []
      if (matched.some((p) => p.coords !== undefined && coordsClose(p.coords, stop.coords))) return
      // 归属②：intelRefs 指向带已验证坐标的 intel 条目，且该 intel 坐标与
      // stop.coords **一致**（fix-f1e C：仅「带坐标」即放行会让来源错配的坐标
      // 冒充归属——所引 intel 在异处也通过；必须 coordsClose 才承认出处）。
      if (stop.intelRefs.some((r) => {
        const c = intelById.get(r)?.coords
        return c !== undefined && coordsClose(c, stop.coords)
      })) return
      unbound.push(
        `draft.days[${di}].stops[${si}]「${stop.name}」坐标来源未知：未匹配 places.json 已解析地点且未归属到带坐标 intel 条目（不静默接受 draft 自带坐标）；${matchableHint}`,
      )
    })
  })
  if (unbound.length > 0) {
    throw new TravelValidationError(unbound)
  }
}

/** draft 中 intelRefs 引用存在性（stops + meals）：缺失 → 列明报错条目。 */
export function collectMissingIntelRefs(days: ItineraryDay[], intel: readonly IntelItem[]): string[] {
  const ids = new Set(intel.map((i) => i.id))
  const missing: string[] = []
  days.forEach((day, di) => {
    day.stops.forEach((stop, si) => {
      for (const ref of stop.intelRefs) {
        if (!ids.has(ref)) missing.push(`draft.days[${di}].stops[${si}].intelRefs 引用不存在于 intel.json：${ref}`)
      }
    })
    for (const [mi, meal] of (day.meals ?? []).entries()) {
      for (const ref of meal.intelRefs) {
        if (!ids.has(ref)) missing.push(`draft.days[${di}].meals[${mi}].intelRefs 引用不存在于 intel.json：${ref}`)
      }
    }
  })
  return missing
}

/**
 * 修订保留（FR-6 验收② + M3.1）：与上一版 itinerary 逐日比对——stops（名称/顺序/
 * durationHint/intelRefs）、meals 与 lodgingArea（M3.1：酒店区域修改=受影响天，
 * 采用 draft 新值）逐项相等的天视为「未受影响」，原样保留上一版
 * 天结构（含 note 等模型可能重排的字段）；有差异的天采用 draft 新值。
 */
export function preserveUnchangedDays(prev: Itinerary | undefined, draftDays: ItineraryDay[]): ItineraryDay[] {
  if (prev === undefined) return draftDays
  return draftDays.map((day, i) => {
    const prevDay = prev.days[i]
    return prevDay !== undefined && sameDaySchedule(prevDay, day) ? prevDay : day
  })
}

function sameDaySchedule(a: ItineraryDay, b: ItineraryDay): boolean {
  if (a.lodgingArea !== b.lodgingArea) return false // M3.1：酒店区域修改=受影响天
  if (a.stops.length !== b.stops.length) return false
  for (let i = 0; i < a.stops.length; i++) {
    if (!sameStop(a.stops[i], b.stops[i])) return false
  }
  const aMeals = a.meals ?? []
  const bMeals = b.meals ?? []
  if (aMeals.length !== bMeals.length) return false
  for (let i = 0; i < aMeals.length; i++) {
    if (aMeals[i].name !== bMeals[i].name) return false
    if (!sameRefs(aMeals[i].intelRefs, bMeals[i].intelRefs)) return false
  }
  return true
}

/** stops 逐项相等（名称/类别/坐标/时长/来源引用；note 等细枝不参与判定——判定键=FR-6 验收口径）。 */
function sameStop(a: ItineraryStop, b: ItineraryStop): boolean {
  return a.name === b.name
    && a.category === b.category
    && a.coords?.lng === b.coords?.lng
    && a.coords?.lat === b.coords?.lat
    && a.durationHint === b.durationHint
    && sameRefs(a.intelRefs, b.intelRefs)
}

function sameRefs(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** 纯逻辑（测试直调；deps 缺省 → 动线校验直线估算兜底，离线零触网）。 */
export async function runBuildItinerary(args: BuildItineraryArgs, store: TravelStore, deps: BuildRouteCheckDeps = {}): Promise<BuildItineraryResult> {
  // 计划级在途锁（C 期接线 F4-C5）：itinerary.json 写路径串行化。
  return store.withPlanLock(args.planId, () => runBuildItineraryUnlocked(args, store, deps))
}

async function runBuildItineraryUnlocked(args: BuildItineraryArgs, store: TravelStore, deps: BuildRouteCheckDeps = {}): Promise<BuildItineraryResult> {
  const now = new Date().toISOString()
  const request = await store.loadRequest(args.planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
  }

  // 状态机先进性校验（先于写盘：非法转换不留半成品 itinerary.json）。
  // research 后（researching → generating）为正常路径；delivered 修订需先 update → revising。
  assertTransition(request.status, 'generating')

  // route-transport 是可选旁车证据：unknown 只读兼容，真正绑定延后到 final route
  // fingerprint 生成后，避免旧 selectedSequence 污染新日程；hash mismatch/失败不消费。
  const routeTransportState = deps.options?.routeTransport !== undefined
    ? undefined
    : await store.readArtifactWithState<RouteTransportArtifact>(args.planId, 'route-transport.json')
  const routeTransportSnapshot = consumableArtifact(routeTransportState, 'route-transport.json')
  const routeTransportReadWarning = artifactCompatibilityWarning('route-transport.json', routeTransportState)
  const routeOpts: RouteCheckOptions = {
    ...(deps.options ?? {}),
    ...(deps.options?.pace === undefined && request.slots.preferences?.pace !== undefined
      ? { pace: request.slots.preferences.pace }
      : {}),
    providers: deps.providers,
    keyEnv: deps.keyEnv,
  }

  // ── 产品链门（C 期）：完整 plan（flowVersion）必须先完成地理解析（places）才能
  // 生成行程。places 缺失/发布失败/为空/hash 失配 → 结构化 blocked+nextAction 且
  // 零网络（不静默接受 draft 自带坐标绕过解析链——R-2；legacy 计划（请求文件无
  // flowVersion 信封的旧计划）轻量路径不套此门，保持现状）。F1c-E（决策 5）后
  // destination-only 新 plan（mapped 兴趣种子）同样带 flowVersion → 受此门。 ──
  const isFullPlan = request.flowVersion !== undefined
  if (isFullPlan) {
    const placesState = await store.readArtifactWithState<PlacesArtifact>(args.planId, 'places.json')
    // fix-f1f #4b：取当前研究版本供 places 消费侧版本比对（旧 places 不消费）
    const researchVersion = (await store.loadResearchState<ResearchState>(args.planId))?.researchVersion ?? 0
    const blocked = buildPlacesBlocked(placesState, researchVersion)
    if (blocked !== undefined) {
      return {
        itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
        reason: blocked.detail,
        blocked: { reason: blocked.reason, nextAction: blocked.nextAction },
      }
    }
    // C5① 研究/评估阶段门：完整 plan 需当前研究版本有效 + 评估为当前有效 sufficient。
    // research 未做（无版本）或评估非当前有效（过期/非 sufficient）→ 结构化 blocked，
    // 不消费旧研究/旧评估结果生成行程（零网络）。
    const researchBlocked = await buildResearchBlocked(store, args.planId)
    if (researchBlocked !== undefined) {
      return {
        itineraryId: '', days: [], built: false, routeCheck: { issues: [], warnings: [] },
        reason: '研究/评估未就绪：完整 plan 需当前研究版本有效且评估为当前有效 sufficient',
        blocked: { reason: researchBlocked.reason, nextAction: researchBlocked.nextAction },
      }
    }
  }

  if (args.draft !== undefined) {
    return buildFromDraft(args, request, store, {
      ...deps,
      options: routeOpts,
      routeTransportSnapshot,
      routeTransportReadWarning,
    })
  }

  // 自动提案：依赖可读 intel.json；unknown 只读兼容并在落盘 warnings 留证。
  const intelState = await store.readArtifactWithState<IntelItem[]>(args.planId, 'intel.json')
  const intelData = consumableArtifact(intelState, 'intel.json')
  const intel = Array.isArray(intelData) ? intelData : undefined
  if (intel === undefined || intel.length === 0) {
    return {
      itineraryId: '', days: [], built: false, routeCheck: { issues: ['intel.json 缺失或为空'], warnings: [] },
      reason: 'intel.json 缺失或为空：请先 travel_research_destination，或所有检索源失败后重试。',
    }
  }
  const placesState = await store.readArtifactWithState<PlacesArtifact>(args.planId, 'places.json')
  const places = consumableArtifact(placesState, 'places.json')
  const compatibilityWarnings = [
    artifactCompatibilityWarning('intel.json', intelState),
    artifactCompatibilityWarning('places.json', placesState),
    routeTransportReadWarning,
  ].filter((warning): warning is string => warning !== undefined)
  const previousState = await store.readArtifactWithState<Itinerary>(args.planId, 'itinerary.json')
  const previous = consumableArtifact(previousState, 'itinerary.json')
  const result = autoProposeItinerary(args.planId, request.slots, intel, { places, previous })
  if (!result.built) {
    return result // 不落盘：无坐标/缺日期/缺锚点（§9.3-6 不产空产物）
  }
  const canonicalRoute = places !== undefined && shouldUseResolvedRoute(places)
    ? canonicalRouteFromDays(result.days)
    : undefined
  // T24：routeOpts 已含 routeTransport 旁车；再补 stop→placeId 绑定表使旁车
  // 可被可靠归属到当天相邻段（未命中即不可绑定 → 几何档，不误报/不吞告警）。
  const autoBindings = await stopPlaceIdBindings(args.planId, result.days, store)
  const routeOptions = routeOptionsForDays({
    ...routeOpts,
    ...(autoBindings !== undefined ? { stopPlaceIds: autoBindings } : {}),
    ...(canonicalRoute !== undefined ? { routeFingerprint: canonicalRoute.fingerprint } : {}),
  }, result.days, routeTransportSnapshot)
  const detail = await runRouteCheck(result.days, routeOptions)
  const itinerary: Itinerary = {
    ...(canonicalRoute !== undefined ? { schemaVersion: 2, canonicalRoute } : {}),
    itineraryId: result.itineraryId,
    days: result.days,
    routeCheck: {
      issues: detail.issues,
      // W6 故障矩阵贯通：逐渠道降级记账（渠道停用/Key 未配置/测量失败）并入
      // warnings 面（itinerary.json 契约字段；degraded 明细此前仅存在于
      // RouteCheckDetail 内部，未随工具结果/落盘透出）。
      warnings: [...result.routeCheck.warnings, ...compatibilityWarnings, ...detail.warnings, ...routeDegradedWarnings(detail.degraded)],
    },
  }
  assertValidIssues(validateItinerary(itinerary))
  await publishItinerary(store, args.planId, request, itinerary)
  await store.saveRequest({ ...request, status: 'generating', updatedAt: now })
  return { itineraryId: itinerary.itineraryId, days: itinerary.days, routeCheck: itinerary.routeCheck, built: true }
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectBuild(r: BuildItineraryResult): BuildOutput {
  return {
    itineraryId: r.itineraryId,
    days: toCanonicalJson(r.days) as BuildOutput['days'],
    routeCheck: {
      issues: [...r.routeCheck.issues],
      warnings: [...r.routeCheck.warnings],
    },
    built: r.built,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.blocked !== undefined
      ? { blocked: { reason: r.blocked.reason, nextAction: r.blocked.nextAction } }
      : {}),
  }
}

function renderBuild(args: BuildParams, value: BuildOutput): ContentBlock[] {
  if (value.blocked !== undefined) {
    return textCard(
      `**travel_build_itinerary** · 门拦截（未落盘）\n${cardLines([
        ['planId', args.planId],
        ['blocked', value.blocked.reason],
        ['nextAction', value.blocked.nextAction],
      ])}`,
    )
  }
  if (!value.built) {
    return textCard(
      `**travel_build_itinerary** · 未生成\n${cardLines([
        ['planId', args.planId],
        ['说明', value.reason ?? '依赖缺失'],
        ['提示', '请先 travel_research_destination 并确认 intel.json 就绪；或传入修订 draft'],
      ])}`,
    )
  }
  const daysText = (value.days as unknown as ItineraryDay[]).map((d, i) => {
    const stops = d.stops.map((s) => `${s.name}(${s.durationHint ?? '?'}min)`).join(' → ')
    return `第${i + 1}天 ${d.date}：${stops || '（机动）'}`
  }).join('\n')
  const lines: [string, string][] = [
    ['itineraryId', value.itineraryId],
    ['天数', String(value.days.length)],
  ]
  if (value.routeCheck.issues.length > 0) {
    lines.push(['动线问题', value.routeCheck.issues.join('；')])
  }
  if (value.routeCheck.warnings.length > 0) {
    lines.push(['提醒', value.routeCheck.warnings.join('；')])
  }
  return textCard(`**travel_build_itinerary** · 行程提案\n${cardLines(lines)}\n${daysText}\n> 动线校验（route-check）已随行程落盘；修订 draft 时未受影响天结构原样保留`)
}

/** 工具定义工厂（store + 动线渠道注入；index.ts 传真实适配器 + ctx 供 makeKeyEnv）。 */
export function createTravelBuildItineraryTool(store: TravelStore, opts: BuildToolOptions = {}): ToolDefinition {
  // 渠道链：缺省直线估算兜底；工厂给了适配器则装配完整三级链（高德→腾讯→估算）
  const providers: RouteMeasureProvider[] = [
    ...(opts.amap !== undefined ? [createAmapRouteProvider(opts.amap)] : []),
    ...(opts.tencent !== undefined ? [createTencentRouteProvider(opts.tencent)] : []),
    ...(opts.providers ?? (opts.amap !== undefined || opts.tencent !== undefined ? [createEstimateRouteProvider()] : [estimateRouteProvider])),
  ]
  const keyEnv = opts.keyEnvHost !== undefined ? makeKeyEnv(opts.keyEnvHost) : undefined
  return defineTool({
    name: 'travel_build_itinerary',
    description: '行程生成（完整版）：draft 缺省 → 基于 intel.json 自动提案每日行程（stops 含 intelRefs/coords{sys}/durationHint）；draft 传入 → 结构校验 + intelRefs 引用存在性校验 + 修订时未受影响天结构原样保留，并按传入结构聚合。动线校验三级降级链（高德 distance→腾讯 distance_matrix→直线估算）随行程落盘 routeCheck{issues,warnings}。依赖缺失（intel 为空/无坐标）时返回 built=false 不生成空产物。',
    parameters: BUILD_PARAMETERS,
    output: {
      schema: BUILD_OUTPUT_SCHEMA,
      render: renderBuild,
    },
    timeoutMs: BUILD_TIMEOUT_MS,
    async execute(args) {
      // P0-A R6：工具执行入口恰一次重置规划预算（amap 配额不跨链累积）。
      if (opts.resetPlanBudget !== undefined) opts.resetPlanBudget()
      return losslessJson(projectBuild(await runBuildItinerary({
        planId: args.planId,
        draft: args.draft !== undefined ? (args.draft as unknown) : undefined,
      }, store, { providers, keyEnv })))
    },
  })
}

/** 工具工厂选项（渠道注入/测试替身）。 */
export interface BuildToolOptions {
  amap?: AmapAdapter
  tencent?: TencentMapAdapter
  /** 直供渠道源（测试专用；给出时覆盖缺省估算链）。 */
  providers?: RouteMeasureProvider[]
  /** makeKeyEnv 宿主（ctx；production 传 ctx 取 credentials 热快照）。 */
  keyEnvHost?: MakeKeyEnvHost
  /** 单次生成开始回调（P0-A R6：工具执行入口恰一次重置规划预算）。 */
  resetPlanBudget?: () => void
}