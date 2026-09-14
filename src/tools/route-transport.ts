/**
 * W3 T12 travel_route_transport（新增旁车工具）——路线各段交通与逐段诚实降级（草稿 D）。
 *
 * - 按 selectedSequence 相邻地点逐段查询（route-transport.json 旁车；transport.json 原
 *   TransportOption[] 形态保留承载出发选项）。
 * - 每 leg 含 id/fromPlaceId/toPlaceId/orderIndex/placesVersion/mode/status
 *   (queried|estimated|unavailable|blocked)/estimateReason/provider/source/observedAt/
 *   可选几何日期；status 逐段独立——某段失败不抹其他段。
 * - 驾驶/步行/公交按用户明确方式及可用渠道查询；无方式时提出默认（driving）并**回显
 *   假设**（assumedMode；不悄悄全部当自驾）。
 * - 仅直线估算 → estimated + estimateReason（不当道路长度/驾驶时长/可达性证据）；
 *   测距渠道仅返回距离/时长则如实输出、几何缺省（不把测距说成完整路线指引）。
 * - 缺班次日期 → 可查非时刻表路线（距离/时长），不返回假装实时可乘的班次（无 no/时刻）。
 * - 非必需段缺失 → degraded（每轮可见）可继续到 build 且显式标未核实（unavailable 段）；
 *   关键不可达/必去点冲突 → resolutionHint 指明受影响段并回 resolve 调整候选再查——
 *   禁止无限自动重排（本轮停止，原因+影响范围可见）。
 * - 缺枢纽坐标衔接标未知（hub/枢纽无坐标 → blocked，不猜测）。
 * - 接口复用 src/adapters/{amap,tencent}.ts 测距与 src/route-check.ts provider 形态
 *   （仅距离/时长则如实输出；几何缺省）；缺省 provider=[直线估算]——离线零触网。
 */
import { createHash } from 'node:crypto'
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { DegradedEntry, EngineErrorCode, KeyResolutionEnv } from '../adapters/base.js'
import { canonicalRouteFromDays, haversineKm } from '../route-check.js'
import { TravelStore } from '../store/store.js'
import { TravelValidationError } from '../errors.js'
import { cardLines, losslessJson, textCard } from './common.js'
import type {
  GeoCoords, Itinerary, PlacesArtifact, ResearchState, ResolvedPlace, RouteGeometry,
  RouteTransportArtifact, RouteTransportLeg, RouteTransportMode, SourceRef,
} from '../models/types.js'
import { ROUTE_TRANSPORT_MODES, ROUTE_TRANSPORT_STATUSES } from '../models/types.js'
import { assertValidIssues, isOneOf, isValidRouteGeometry, validateRouteTransportArtifact } from '../models/validate.js'

/** 路线段上限（resolve 选中序列 ≤30；防御放大）。 */
export const ROUTE_LEGS_MAX = 60

/** 当前研究版本 = intel 证据版本（研究 provider 以 research-state.researchVersion 演进）。 */
async function currentIntelVersion(store: TravelStore, planId: string): Promise<number> {
  const state = await store.loadResearchState<ResearchState>(planId)
  return state?.researchVersion ?? 0
}

function isSignedRouteArtifactTamper<T>(name: string, state: {
  status: string
  staleReason?: string
  meta?: { stage?: string }
}): boolean {
  const ownStage: Record<string, string> = {
    'places.json': 'places',
    'itinerary.json': 'itinerary',
    'route-transport.json': 'route-transport',
  }
  return (state.status === 'unknown' || state.status === 'stale')
    && (state.staleReason === 'unaccounted' || state.staleReason === 'not_in_commit')
    && ownStage[name] === state.meta?.stage
}

/** unknown 只读兼容；失败/空/缺失/hash mismatch 仍不可消费。 */
function consumableRouteArtifact<T>(state: {
  found: boolean
  status: string
  staleReason?: string
  meta?: { stage?: string }
  data?: T
}, name?: string): T | undefined {
  if (name !== undefined && isSignedRouteArtifactTamper(name, state)) return undefined
  if (!state.found || state.status === 'missing' || state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

// ────────────────────────── 类型 ──────────────────────────

/** 单段测量输入（route-transport 专用段；复用 route-check 测距语义）。 */
export interface RouteTransportLegInput {
  id: string
  fromCoords: GeoCoords
  toCoords: GeoCoords
}

/** 单段测量输出。 */
export interface RouteTransportMeasure {
  id: string
  distanceKm: number
  durationMinutes: number
  /** 渠道说明（如「高德 direction/driving」/「直线估算…」）。 */
  note: string
  /** host 归一化后的完整 WGS84 geometry；测距矩阵没有该字段。 */
  geometry?: RouteGeometry
  /** 指标/几何状态分别记录，不能由一个 status 互相推断。 */
  metricStatus?: RouteTransportLeg['metricStatus']
  geometryStatus?: RouteTransportLeg['geometryStatus']
  source?: SourceRef
}

/** 可注入的段级测距/路线 provider（形态对齐 src/route-check.ts RouteMeasureProvider）。 */
export interface RouteLegProvider {
  name: string
  label: string
  /** 该 provider 可服务的出行方式（driving/walking/transit）。 */
  modes: readonly RouteTransportMode[]
  available(env?: KeyResolutionEnv): Promise<{ ok: boolean; reason?: string }>
  measure(inputs: RouteTransportLegInput[], env?: KeyResolutionEnv): Promise<RouteTransportMeasure[]>
}

/** 工具输入。 */
export interface RouteTransportArgs {
  planId: string
  /** 出行方式（缺省 → 默认 driving + assumedMode 回显假设）。 */
  modes?: RouteTransportMode[]
  /** 调用方所依据 places 版本（过期 → places_stale 零网络）。 */
  expectedPlacesVersion?: number
}

/** 工具返回。 */
export interface RouteTransportResult {
  planId: string
  status: 'ready' | 'places_not_ready' | 'places_stale'
  placesVersion: number
  inputFingerprint: string
  legs: RouteTransportLeg[]
  assumedMode?: { mode: RouteTransportMode; reason: string }
  totalDistanceKm?: number
  totalDurationMinutes?: number
  degraded: DegradedEntry[]
  /** 关键不可达/必去点冲突影响范围（回 resolve 调整候选再查，禁止无限自动重排）。 */
  resolutionHint?: string
  placesNotReady?: { reason: 'places_not_ready' | 'places_stale'; detail?: string }
}

/** 装配依赖（provider 链注入；缺省 [直线估算] 零触网）。 */
export interface RouteTransportDeps {
  providers?: RouteLegProvider[]
  env?: KeyResolutionEnv
  timeoutMs?: number
  /** 单次路线旁车开始回调（P0-A R6：工具执行入口恰一次重置规划预算）。 */
  resetPlanBudget?: () => void
}

const ROUTE_TRANSPORT_PARAMETERS = {
  planId: { type: 'string', required: true, description: '计划 ID' },
  modes: {
    type: 'array',
    items: { type: 'string', enum: [...ROUTE_TRANSPORT_MODES] },
    description: '路线段出行方式（缺省默认 driving 并回显假设；不悄悄全部当自驾）',
  },
  expectedPlacesVersion: { type: 'integer', description: '调用方所依据 places 版本（过期 → places_stale 零网络）' },
} as const
type RouteTransportParams = InferArgs<typeof ROUTE_TRANSPORT_PARAMETERS>

const LEG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    fromPlaceId: { type: 'string', required: true },
    toPlaceId: { type: 'string', required: true },
    orderIndex: { type: 'integer', required: true },
    placesVersion: { type: 'integer', required: true },
    mode: { type: 'string', enum: [...ROUTE_TRANSPORT_MODES], required: true },
    status: { type: 'string', enum: [...ROUTE_TRANSPORT_STATUSES], required: true },
    metricStatus: { type: 'string', enum: [...ROUTE_TRANSPORT_STATUSES] },
    geometryStatus: { type: 'string', enum: [...ROUTE_TRANSPORT_STATUSES] },
    estimateReason: { type: 'string' },
    provider: { type: 'string' },
    source: { type: 'json' },
    observedAt: { type: 'string', required: true },
    distanceKm: { type: 'number' },
    durationMinutes: { type: 'integer' },
    geometry: { type: 'json' },
    date: { type: 'string' },
  },
} as const

export const ROUTE_TRANSPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    placesVersion: { type: 'integer', required: true },
    inputFingerprint: { type: 'string', required: true },
    legs: { type: 'array', required: true, items: { ...LEG_SCHEMA } },
    totalDistanceKm: { type: 'number' },
    totalDurationMinutes: { type: 'number' },
    assumedMode: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: [...ROUTE_TRANSPORT_MODES], required: true },
        reason: { type: 'string', required: true },
      },
    },
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
        },
      },
    },
    resolutionHint: { type: 'string' },
    placesNotReady: { type: 'json' },
  },
} as const
type RouteTransportOutput = InferValue<typeof ROUTE_TRANSPORT_OUTPUT_SCHEMA>

// ────────────────────────── 直线估算兜底 provider ──────────────────────────

/** 直线估算 provider（纯几何，永可行；标注「直线估算」；可服务全部方式）。 */
export function createEstimateLegProvider(speedKmh = 40): RouteLegProvider {
  return {
    name: 'estimate',
    label: '直线估算',
    modes: [...ROUTE_TRANSPORT_MODES],
    async available() {
      return { ok: true }
    },
    async measure(inputs) {
      return inputs.map((seg) => {
        const distanceKm = haversineKm(seg.fromCoords, seg.toCoords)
        return {
          id: seg.id,
          distanceKm,
          durationMinutes: Math.round((distanceKm / speedKmh) * 60),
          metricStatus: 'estimated',
          geometryStatus: 'estimated',
          note: `直线估算（Haversine，GCJ-02 平面近似；按 ${speedKmh}km/h 折算时长，非道路长度/驾驶时长/可达性证据）`,
        }
      })
    },
  }
}

/** 高德主路线渠道（direction/driving；几何已在 host 归一化为 WGS84）。 */
export function createAmapLegProvider(adapter: import('../adapters/amap.js').AmapAdapter): RouteLegProvider {
  return {
    name: 'amap',
    label: '高德 direction/driving',
    modes: ['driving'],
    async available(env) {
      const ok = await adapter.available(env)
      return ok ? { ok: true } : { ok: false, reason: '高德不可用（Key/开关）' }
    },
    async measure(inputs, env) {
      const result: RouteTransportMeasure[] = []
      for (const seg of inputs) {
        const { route } = await adapter.directionDriving(seg.fromCoords, seg.toCoords, env)
        result.push({
          id: seg.id,
          distanceKm: route.distanceMeters / 1000,
          durationMinutes: route.durationMinutes,
          ...(route.geometry !== undefined ? { geometry: route.geometry, geometryStatus: 'queried' as const } : { geometryStatus: 'unavailable' as const }),
          metricStatus: 'queried',
          note: route.geometry === undefined
            ? '高德 direction/driving（指标实测；未返回道路几何）'
            : '高德 direction/driving（指标与道路几何实测）',
          source: { platform: 'amap-direction', url: 'https://restapi.amap.com/v3/direction/driving', fetchedAt: new Date().toISOString() },
        })
      }
      return result
    },
  }
}

/** 腾讯备路线渠道：direction/driving 失败后复用 distance_matrix 指标兜底。 */
export function createTencentLegProvider(adapter: import('../adapters/tencent.js').TencentMapAdapter): RouteLegProvider {
  return {
    name: 'tencent',
    label: '腾讯 direction/driving',
    modes: ['driving'],
    async available() {
      return { ok: true } // 零 key 体验通道常开（开关由编排层过滤）
    },
    async measure(inputs, env) {
      const result: RouteTransportMeasure[] = []
      for (const seg of inputs) {
        try {
          const { data, source } = await adapter.directionDriving({ from: seg.fromCoords, to: seg.toCoords }, env)
          result.push({
            id: seg.id,
            distanceKm: data.distanceMeters / 1000,
            durationMinutes: data.durationMinutes,
            ...(data.geometry !== undefined ? { geometry: data.geometry, geometryStatus: 'queried' as const } : { geometryStatus: 'unavailable' as const }),
            metricStatus: 'queried',
            note: data.geometry === undefined
              ? '腾讯 direction/driving（指标实测；未返回道路几何）'
              : '腾讯 direction/driving（指标与道路几何实测）',
            source,
          })
        } catch (directionError) {
          // 方向接口无结果时只能保留矩阵指标；geometryStatus 明确为 unavailable，
          // 不把距离矩阵冒充成道路轨迹。
          const { data } = await adapter.distanceMatrix({
            from: [`${seg.fromCoords.lat},${seg.fromCoords.lng}`],
            to: [`${seg.toCoords.lat},${seg.toCoords.lng}`],
            mode: 'driving',
          }, env)
          const element = data.rows[0]?.elements.find((candidate) => candidate.toIndex === 0)
          if (element === undefined) throw directionError
          result.push({
            id: seg.id,
            distanceKm: element.distanceMeters / 1000,
            durationMinutes: element.durationMinutes,
            metricStatus: 'queried',
            geometryStatus: 'unavailable',
            note: '腾讯 distance_matrix（指标实测；未返回道路几何）',
            source: { platform: 'tencent-distance-matrix', url: 'https://apis.map.qq.com/ws/distance/v1/matrix', fetchedAt: new Date().toISOString() },
          })
        }
      }
      return result
    },
  }
}

// ────────────────────────── 域逻辑 ──────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 稳定腿 id：leg-<orderIndex>-<fromCandidateId>-<toCandidateId>。 */
function legIdOf(orderIndex: number, from: ResolvedPlace, to: ResolvedPlace): string {
  return `leg-${orderIndex}-${from.candidateId}-${to.candidateId}`
}

function computeInputFingerprint(placesVersion: number, sequence: string[]): string {
  return sha256(JSON.stringify({ placesVersion, sequence })).slice(0, 24)
}

function isHubPlace(p: ResolvedPlace): boolean {
  return p.kind === 'hub' || p.pointKind === 'hub'
}

interface RouteTotals {
  totalDistanceKm: number
  totalDurationMinutes: number
}

/** 只有全部路段都有指标时才发布总计，避免把 unavailable/blocked 当成零。 */
function completeRouteTotals(legs: readonly RouteTransportLeg[]): RouteTotals | undefined {
  if (legs.length === 0) return undefined
  if (legs.some((leg) => (leg.metricStatus ?? leg.status) === 'blocked'
    || (leg.metricStatus ?? leg.status) === 'unavailable'
    || typeof leg.distanceKm !== 'number' || !Number.isFinite(leg.distanceKm)
    || typeof leg.durationMinutes !== 'number' || !Number.isFinite(leg.durationMinutes))) return undefined
  return {
    totalDistanceKm: Math.round(legs.reduce((sum, leg) => sum + (leg.distanceKm ?? 0), 0) * 10) / 10,
    totalDurationMinutes: Math.round(legs.reduce((sum, leg) => sum + (leg.durationMinutes ?? 0), 0)),
  }
}

/** 关键段/枢纽缺坐标 → blocked（不猜测）。 */
function blockedLeg(
  id: string, orderIndex: number, from: ResolvedPlace, to: ResolvedPlace,
  placesVersion: number, mode: RouteTransportMode, now: string, date: string | undefined,
): RouteTransportLeg {
  const missingHub = [from, to].find(isHubPlace)
  const missingNoCoord = [from, to].find((p) => p.coords === undefined)
  const reason = missingHub !== undefined
    ? `枢纽「${missingHub.name}」缺坐标：衔接未知（不猜测坐标）`
    : `地点「${missingNoCoord?.name ?? '?'}」未解析坐标，无法查询/估算（请经 travel_resolve_places 补解析）`
  return {
    id,
    fromPlaceId: from.placeId,
    toPlaceId: to.placeId,
    orderIndex,
    placesVersion,
    mode,
    status: 'blocked',
    metricStatus: 'blocked',
    geometryStatus: 'blocked',
    estimateReason: reason,
    observedAt: now,
    ...(date !== undefined ? { date } : {}),
  }
}

/** 直线估算 provider 判定：provider.name==='estimate' → 几何估算渠道（estimated 不冒充真实）。 */
function isEstimateProvider(provider: RouteLegProvider): boolean {
  return provider.name === 'estimate'
}

/**
 * 单段解析：按 requested modes 逐方式、逐 provider 尝试——
 * - 真实渠道成功且产出 → queried（mode=该方式，provider=渠道名）
 * - 直线估算渠道（name='estimate'）成功 → estimated（原因含「直线估算」，不冒充真实）
 * - 全源失败（含 estimate）→ unavailable（原因可见，不抹其他段）
 * 逐段独立：某段失败不影响他段（每次只喂本段输入）。
 */
async function resolveLeg(
  orderIndex: number,
  from: ResolvedPlace,
  to: ResolvedPlace,
  placesVersion: number,
  modes: readonly RouteTransportMode[],
  providers: readonly RouteLegProvider[],
  env: KeyResolutionEnv | undefined,
  degraded: DegradedEntry[],
  now: string,
  date: string | undefined,
): Promise<RouteTransportLeg> {
  const id = legIdOf(orderIndex, from, to)
  const base = {
    id,
    fromPlaceId: from.placeId,
    toPlaceId: to.placeId,
    orderIndex,
    placesVersion,
    observedAt: now,
    ...(date !== undefined ? { date } : {}),
  }

  for (const mode of modes) {
    for (const provider of providers) {
      if (!provider.modes.includes(mode)) continue
      let availability: { ok: boolean; reason?: string }
      try {
        availability = await provider.available(env)
      } catch (err) {
        availability = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      if (!availability.ok) {
        degraded.push({
          source: `route/${provider.name}`, code: 'UNAVAILABLE' as EngineErrorCode,
          reason: `段 ${id}：${mode} 渠道不可用（${availability.reason ?? '未知'}）`, at: now,
        })
        continue
      }
      try {
        const measured = await provider.measure([{ id, fromCoords: from.coords!, toCoords: to.coords! }], env)
        const hit = measured.find((m) => m.id === id)
        if (hit === undefined) {
          degraded.push({
            source: `route/${provider.name}`, code: 'UNAVAILABLE' as EngineErrorCode,
            reason: `段 ${id}：${mode} 渠道无结果`, at: now,
          })
          continue
        }
        if (!Number.isFinite(hit.distanceKm) || hit.distanceKm < 0
          || !Number.isInteger(hit.durationMinutes) || hit.durationMinutes < 0) {
          degraded.push({
            source: `route/${provider.name}`, code: 'UNAVAILABLE' as EngineErrorCode,
            reason: `段 ${id}：${mode} 渠道返回非法距离/时长，已转下一降级源`, at: now,
          })
          continue
        }
        const geometry = hit.geometry !== undefined && isValidRouteGeometry(hit.geometry)
          ? hit.geometry
          : undefined
        // 测距渠道仅返回距离/时长 → 指标仍 queried，但 geometryStatus=unavailable；
        // 不把测距说成完整路线指引。直线 provider 的两个状态均 estimated。
        if (isEstimateProvider(provider)) {
          return {
            ...base,
            mode,
            status: 'estimated',
            metricStatus: 'estimated',
            geometryStatus: 'estimated',
            estimateReason: `直线估算（Haversine 几何，非道路长度/驾驶时长/可达性证据）：${hit.note}`,
            provider: 'estimate',
            distanceKm: hit.distanceKm,
            durationMinutes: hit.durationMinutes,
            ...(geometry !== undefined ? { geometry } : {}),
          }
        }
        const metricStatus = hit.metricStatus ?? 'queried'
        const geometryStatus = geometry === undefined && hit.geometryStatus === 'queried'
          ? 'unavailable'
          : hit.geometryStatus ?? (geometry !== undefined ? 'queried' : 'unavailable')
        return {
          ...base,
          mode,
          status: metricStatus,
          metricStatus,
          geometryStatus,
          provider: provider.name,
          source: hit.source ?? { platform: provider.label, url: `https://example.invalid/route/${provider.name}`, fetchedAt: now },
          distanceKm: hit.distanceKm,
          durationMinutes: hit.durationMinutes,
          ...(geometry !== undefined && geometryStatus !== 'blocked' && geometryStatus !== 'unavailable' ? { geometry } : {}),
        }
      } catch (err) {
        degraded.push({
          source: `route/${provider.name}`, code: 'UNAVAILABLE' as EngineErrorCode,
          reason: `段 ${id}：${mode} 渠道失败（${err instanceof Error ? err.message : String(err)}）`, at: now,
        })
      }
    }
  }

  return {
    ...base,
    mode: modes[0],
    status: 'unavailable',
    metricStatus: 'unavailable',
    geometryStatus: 'unavailable',
    estimateReason: `全部渠道失败（${modes.join('/')}），未核实：请检查渠道配置或经 travel_resolve_places 调整候选后重查`,
  }
}

export async function runRouteTransport(
  args: RouteTransportArgs,
  store: TravelStore,
  deps: RouteTransportDeps,
): Promise<RouteTransportResult> {
  // 计划级在途锁（C 期接线 F4-C5）：route-transport.json 落盘与 coverage 串行化。
  return store.withPlanLock(args.planId, () => runRouteTransportUnlocked(args, store, deps))
}

async function runRouteTransportUnlocked(
  args: RouteTransportArgs,
  store: TravelStore,
  deps: RouteTransportDeps,
): Promise<RouteTransportResult> {
  const planId = args.planId
  const request = await store.loadRequest(planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${planId} 不存在：请先 travel_intake 创建`])
  }
  const modes = args.modes ?? [...ROUTE_TRANSPORT_MODES]
  const unknown = modes.filter((m) => !isOneOf(m, ROUTE_TRANSPORT_MODES))
  if (unknown.length > 0) {
    throw new TravelValidationError([`modes 含非法方式：${unknown.join(', ')}（允许 ${ROUTE_TRANSPORT_MODES.join('|')}）`])
  }

  const placesState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  const placesVersion = await store.currentVersion(planId, 'places')
  if (!placesState.found) {
    return {
      planId, status: 'places_not_ready', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: { reason: 'places_not_ready', detail: '缺少 places.json：请先 travel_resolve_places 完成地理解析' },
    }
  }
  // C3 读门：unknown/依赖版本 stale 可只读兼容；failed/empty/hash_mismatch
  // 与 signed-unaccounted 仍不复活。
  if (placesState.status === 'failed' || placesState.meta?.status === 'failed') {
    return {
      planId, status: 'places_not_ready', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: { reason: 'places_not_ready', detail: 'places 上次发布失败（不把失败当成功消费）：请重新执行 travel_resolve_places' },
    }
  }
  if (placesState.status === 'empty' || placesState.meta?.status === 'empty') {
    return {
      planId, status: 'places_not_ready', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: { reason: 'places_not_ready', detail: 'places 上次发布为空（零结果不复活）：请补足候选后重新解析' },
    }
  }
  if (placesState.status === 'stale' && placesState.staleReason === 'hash_mismatch') {
    return {
      planId, status: 'places_stale', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: { reason: 'places_stale', detail: 'places 工件内容与最近提交 hash 不符（外部篡改/损坏）：不复活旧数据，请重新解析发布新版本' },
    }
  }
  if (args.expectedPlacesVersion !== undefined && args.expectedPlacesVersion !== placesVersion) {
    return {
      planId, status: 'places_stale', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: { reason: 'places_stale', detail: `places 版本过期（expected=${args.expectedPlacesVersion}，current=${placesVersion}）：请基于当前解析重查路线` },
    }
  }
  if (isSignedRouteArtifactTamper('places.json', placesState)) {
    return {
      planId, status: 'places_stale', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: { reason: 'places_stale', detail: 'places manifest 声明最近提交为 places stage，但文件未入账（疑似篡改）：不复活旧数据' },
    }
  }
  // C3 研究前进门：places 位置消费的 intel 证据版本（places.intelVersion）落后于当前研究
  // 版本（research-state.researchVersion）→ 即使 places 文件 hash 未变、readArtifactWithState
  // 判 current，按研究内容它也已过期——不得消费旧坐标答新问题。零网络。
  const currentResearch = await currentIntelVersion(store, planId)
  if (placesState.data !== undefined && placesState.data.intelVersion < currentResearch) {
    return {
      planId, status: 'places_stale', placesVersion, inputFingerprint: '', legs: [], degraded: [],
      placesNotReady: {
        reason: 'places_stale',
        detail: `places 消费的 intel 证据版本（${placesState.data.intelVersion}）落后于当前研究版本（${currentResearch}）：研究已前进，请重新执行 travel_resolve_places 后再查路线`,
      },
    }
  }

  const artifact = placesState.data!
  // selectedSequence 存候选 id（resolve 口径）；同时容忍 placeId 直引用
  const byCandidate = new Map(artifact.places.map((p) => [p.candidateId, p]))
  const byPlace = new Map(artifact.places.map((p) => [p.placeId, p]))
  const placeOf = (id: string): ResolvedPlace | undefined => byCandidate.get(id) ?? byPlace.get(id)
  // itinerary.canonicalRoute 是 build 后的最终路线真源；没有它时才兼容
  // places.selectedSequence。这样方向几何、指标和页面不会各自消费不同顺序。
  const itineraryState = await store.readArtifactWithState<Itinerary>(planId, 'itinerary.json')
  const currentItinerary = consumableRouteArtifact(itineraryState, 'itinerary.json')
  const canonical = currentItinerary?.canonicalRoute
  const sequence = canonical !== undefined
    ? canonical.nodes.map((node) => node.placeId)
    : (artifact.selectedSequence ?? [])
  const sequenceDates = canonical !== undefined
    ? canonical.nodes.map((node) => currentItinerary?.days[node.dayIndex]?.date)
    : []
  const now = new Date().toISOString()
  const date = request.slots.dateStart

  // mode 默认与假设回显（不悄悄全部当自驾）
  const assumedMode = args.modes === undefined || args.modes.length === 0
    ? { mode: 'driving' as const, reason: '未指定出行方式：默认使用驾驶（driving）并显式回显假设，不悄悄将所有段当自驾' }
    : undefined
  const effectiveModes: readonly RouteTransportMode[] = assumedMode !== undefined ? [assumedMode.mode] : modes

  const providers = deps.providers ?? [createEstimateLegProvider()]
  const degraded: DegradedEntry[] = []
  if (placesState.status === 'unknown') {
    degraded.push({ source: 'artifact:places.json', code: 'STALE', reason: 'places.json 未入账或版本未知（unknown），本次路线仅按只读兼容消费', at: now })
  } else if (placesState.status === 'stale' && placesState.staleReason !== 'hash_mismatch') {
    degraded.push({ source: 'artifact:places.json', code: 'STALE', reason: `places.json 依赖版本已变化（${placesState.staleReason ?? 'stale'}），本次路线仅按只读兼容消费`, at: now })
  }
  if (itineraryState.status === 'unknown') {
    degraded.push({ source: 'artifact:itinerary.json', code: 'STALE', reason: 'itinerary.json 未入账或版本未知（unknown），canonical route 仅按只读兼容消费', at: now })
  } else if (itineraryState.status === 'stale' && itineraryState.staleReason !== 'hash_mismatch') {
    degraded.push({ source: 'artifact:itinerary.json', code: 'STALE', reason: `itinerary.json 依赖版本已变化（${itineraryState.staleReason ?? 'stale'}），canonical route 仅按只读兼容消费`, at: now })
  }
  const legs: RouteTransportLeg[] = []

  // selectedSequence 相邻段（含闭环/重访；相邻重复=零长度边防御性跳过）
  for (let i = 0; i < sequence.length - 1; i++) {
    const from = placeOf(sequence[i])
    const to = placeOf(sequence[i + 1])
    if (from === undefined || to === undefined) {
      degraded.push({
        source: 'route/places', code: 'UNAVAILABLE' as EngineErrorCode,
        reason: `选中序列引用未知 placeId：${sequence[i]}/${sequence[i + 1]}（零长度/缺失地点跳过）`, at: now,
      })
      continue
    }
    if (from.placeId === to.placeId) continue // 零长度边不产生（防御）
    if (from.coords === undefined || to.coords === undefined) {
      legs.push(blockedLeg(legIdOf(i, from, to), i, from, to, placesVersion, effectiveModes[0], now, sequenceDates[i] ?? date))
      continue
    }
    legs.push(await resolveLeg(i, from, to, placesVersion, effectiveModes, providers, deps.env, degraded, now, sequenceDates[i] ?? date))
  }
  if (legs.length > ROUTE_LEGS_MAX) {
    throw new TravelValidationError([`路线段数 ${legs.length} 超过上限 ${ROUTE_LEGS_MAX}`])
  }

  // 关键不可达/必去点冲突 → 影响范围 + 回 resolve（禁止无限自动重排）
  const unsettled = legs.filter((l) => {
    const status = l.metricStatus ?? l.status
    return status === 'blocked' || status === 'unavailable'
  })
  const resolutionHint = unsettled.length > 0
    ? `关键段不可达/未核实（${unsettled.map((l) => `${l.orderIndex}:${l.metricStatus ?? l.status}`).join('，')}）：`
      + `本轮停止自动重排；请在 travel_resolve_places 调整候选/顺序后只重查受影响段`
    : undefined

  const inputFingerprint = canonical?.fingerprint ?? computeInputFingerprint(placesVersion, sequence)
  const totals = completeRouteTotals(legs)
  const artifactData: RouteTransportArtifact & Partial<RouteTotals> = {
    schemaVersion: 2,
    placesVersion,
    inputFingerprint,
    generatedAt: now,
    legs,
    ...(totals !== undefined ? totals : {}),
    ...(assumedMode !== undefined ? { assumedMode } : {}),
    degraded: degraded.map((d) => ({ source: d.source, code: d.code, reason: d.reason, at: d.at })),
    ...(resolutionHint !== undefined ? { resolutionHint } : {}),
  }
  assertValidIssues(validateRouteTransportArtifact(artifactData))

  await store.publishArtifacts(planId, {
    stage: 'route-transport',
    files: [{ name: 'route-transport.json', data: artifactData }],
    expectedVersions: { places: placesVersion },
    bump: [],
    inputFingerprint,
  })

  return {
    planId,
    status: 'ready',
    placesVersion,
    inputFingerprint,
    legs,
    ...(totals !== undefined ? totals : {}),
    ...(assumedMode !== undefined ? { assumedMode } : {}),
    degraded,
    ...(resolutionHint !== undefined ? { resolutionHint } : {}),
  }
}

// ────────────────────────── 工具定义（W4 T17 单一集成者在 index.ts 注册） ──────────────────────────

type OutputLeg = { orderIndex: number; status: string; metricStatus?: string; mode: string; fromPlaceId: string; toPlaceId: string }

function render(_args: RouteTransportParams, value: RouteTransportOutput): ContentBlock[] {
  const notReady = value.placesNotReady as { reason: string; detail?: string } | undefined
  if (notReady !== undefined) {
    return textCard(`**travel_route_transport** · 路线段未就绪（zero network）\n${cardLines([
      ['reason', notReady.reason],
      ['detail', notReady.detail ?? ''],
    ])}`)
  }
  const legs = (value.legs as unknown as OutputLeg[]) ?? []
  const byStatus = new Map<string, number>()
  for (const l of legs) byStatus.set(l.status, (byStatus.get(l.status) ?? 0) + 1)
  const lines: [string, string][] = [
    ['placesVersion', String(value.placesVersion)],
    ['inputFingerprint', value.inputFingerprint.slice(0, 16)],
    ['段数', String(legs.length)],
    ['状态分布', [...byStatus.entries()].map(([k, n]) => `${k}=${n}`).join('，')],
  ]
  const assumed = value.assumedMode as { mode: string; reason: string } | undefined
  if (assumed !== undefined) {
    lines.push(['方式假设', `${assumed.mode}：${assumed.reason}`])
  }
  const unsettled = legs.filter((l) => (l.metricStatus ?? l.status) === 'blocked' || (l.metricStatus ?? l.status) === 'unavailable')
  if (unsettled.length > 0) {
    lines.push(['未核实段', unsettled.map((l) => `${l.orderIndex}:${l.metricStatus ?? l.status}`).join('，')])
  }
  if (value.resolutionHint !== undefined) {
    lines.push(['调整指引', value.resolutionHint])
  }
  if (value.degraded.length > 0) {
    lines.push(['降级记录', value.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}`).join('；')])
  }
  return textCard(`**travel_route_transport** · 路线各段交通旁车\n${cardLines(lines)}\n> 详情已写入 route-transport.json（transport.json 原形态保留出发选项）`)
}

/** 工具定义工厂（W4 T17 由单一集成者在 index.ts 注册并注入生产 provider 链）。 */
export function createTravelRouteTransportTool(store: TravelStore, deps: RouteTransportDeps): ToolDefinition {
  return defineTool({
    name: 'travel_route_transport',
    description: `路线各段交通旁车（W3 T12）：按 selectedSequence 相邻地点逐段查询 route-transport.json——每段独立状态 queried|estimated|unavailable|blocked 与原因；驾驶/步行/公交按明确方式（无方式默认 driving 并回显假设）；仅直线估算标 estimated（不冒充道路长度/驾驶时长/可达性证据）；测距渠道仅返回距离/时长、几何缺省；缺班次日期不返回假装实时可乘的班次；闭环重访段保留、零长度边不产生；某段失败不抹其他段；关键不可达 → resolutionHint 回 resolve 调整候选再查受影响段（禁止无限自动重排）。`,
    parameters: ROUTE_TRANSPORT_PARAMETERS,
    output: { schema: ROUTE_TRANSPORT_OUTPUT_SCHEMA, render },
    timeoutMs: deps.timeoutMs ?? 60_000,
    async execute(args) {
      // P0-A R6：工具入口恰一次重置规划预算（amap 配额不跨链累积）。
      if (deps.resetPlanBudget !== undefined) deps.resetPlanBudget()
      const result = await runRouteTransport({
        planId: args.planId,
        modes: args.modes as RouteTransportMode[] | undefined,
        expectedPlacesVersion: args.expectedPlacesVersion,
      }, store, deps)
      return losslessJson(projectRouteTransport(result))
    },
  })
}

function projectRouteTransport(o: RouteTransportResult): RouteTransportOutput {
  return {
    planId: o.planId,
    status: o.status,
    placesVersion: o.placesVersion,
    inputFingerprint: o.inputFingerprint,
    legs: JSON.parse(JSON.stringify(o.legs)) as RouteTransportOutput['legs'],
    ...(o.totalDistanceKm !== undefined ? { totalDistanceKm: o.totalDistanceKm } : {}),
    ...(o.totalDurationMinutes !== undefined ? { totalDurationMinutes: o.totalDurationMinutes } : {}),
    ...(o.assumedMode !== undefined ? { assumedMode: { ...o.assumedMode } } : {}),
    degraded: [...o.degraded],
    ...(o.resolutionHint !== undefined ? { resolutionHint: o.resolutionHint } : {}),
    ...(o.placesNotReady !== undefined
      ? { placesNotReady: JSON.parse(JSON.stringify(o.placesNotReady)) as RouteTransportOutput['placesNotReady'] } : {}),
  }
}