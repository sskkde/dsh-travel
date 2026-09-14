/**
 * 动线校验（M1 T7 / W4；design §2.1 FR-6 行 + §9.3-4）。
 *
 * 三级降级链（FR-6 动线校验渠道一/二/兜底）：
 *   ① 高德 distance（v3/distance，driving）—— 需 amapWebservice key
 *      （makeKeyEnv 热快照；无 key → available()=false → 降级）
 *   ② 腾讯 distance_matrix（ws/distance/v1/matrix，driving）—— 零 key 体验通道
 *   ③ 直线距离估算（Haversine，GCJ-02 平面近似）—— 纯几何永可行，标注「直线估算」
 *
 * 检测项（FR-6 验收① + T7 QA）：
 *   - 跨城折返：同日跨城往返（单日内 近→远→近）与两日间 A→B→A
 *     （第 N 天远离出发地、第 N+1 天首站回到出发地附近）
 *   - 单日跨度告警（参数化阈值：最远两站直线距离超阈值 → warning）
 *
 * 降级标注：每项 issues/warnings 带数据来源说明（「数据=高德 distance」/
 * 「数据=腾讯 distance_matrix」/「数据=直线估算」）；渠道链与降级明细
 * （channelsUsed/degraded/segments/daySpansKm）供调用方留证——
 * itinerary.json 只落 issues/warnings（§5.5 routeCheck 契约）。
 *
 * 离线纪律：渠道源由调用方注入（build 工厂接真实适配器；测试注入 mock）；
 * 缺省 providers=[直线估算]，离线零触网。
 */
import { createHash } from 'node:crypto'
import { channelEnabled, EngineError, type KeyResolutionEnv } from './adapters/base.js'
import { AmapAdapter } from './adapters/amap.js'
import { TencentMapAdapter } from './adapters/tencent.js'
import type { CanonicalRoute, GeoCoords, ItineraryDay, ItineraryStop, RouteCheck, RouteTransportLeg } from './models/types.js'

// ────────────────────────── 类型 ──────────────────────────

/** 测量渠道标识（降级链级次）。 */
export type RouteCheckChannel = 'amap' | 'tencent' | 'estimate'

export interface RoutePoint {
  name: string
  coords: GeoCoords
}

export interface RouteSegment {
  dayIndex: number
  date: string
  from: RoutePoint
  to: RoutePoint
}

/**
 * 带旁车绑定线索的相邻段（T24 内部形态）：
 * - orderIndex = 该段在「选中序列」上的相邻边序号（leg.orderIndex 同构口径）；
 * - fromPlaceId/toPlaceId = 两端 stop 经 places 已归属的 placeId（未归属 → undefined）。
 * 二者共同构成 leg ↔ 当天相邻段的可靠绑定凭据；任缺一即视为不可绑定。
 */
interface BoundRouteSegment extends RouteSegment {
  orderIndex: number
  fromPlaceId: string | undefined
  toPlaceId: string | undefined
}

export interface RouteMeasurement {
  distanceKm: number
  durationMinutes: number
  source: RouteCheckChannel
  /** 降级路径标注（如「直线估算（Haversine，GCJ-02 平面近似…）」）。 */
  note: string
}

/** 动线距离测量源（渠道链的注入缝：适配器实体 / 直线估算 / 测试替身）。 */
export interface RouteMeasureProvider {
  readonly name: RouteCheckChannel
  /** 人类可读渠道名（说明文本用）。 */
  readonly label: string
  /** 可用性前置判定（渠道开关 / Key 门）；ok=false 给出 reason 计入 degraded。 */
  available(env?: KeyResolutionEnv): Promise<{ ok: boolean; reason?: string }>
  /** 测量一组相邻段；失败抛 EngineError（调用方降级到下一渠道）。 */
  measure(segments: RouteSegment[], env?: KeyResolutionEnv): Promise<RouteMeasurement[]>
}

export interface RouteCheckDegraded {
  channel: string
  reason: string
}

export interface DaySpan {
  dayIndex: number
  date: string
  spanKm: number
}

/** 动线校验完整明细（issues/warnings 进 itinerary.json；其余留证）。 */
export interface RouteCheckDetail extends RouteCheck {
  /** build 规范化后的最终路线指纹；页面/总计/route-transport 共用。 */
  routeFingerprint?: string
  /** 成功测量的最高级渠道（空 = 纯几何兜底）。 */
  channelsUsed: RouteCheckChannel[]
  /** 降级链逐项记录（渠道停用 / Key 未配置 / 超时等）。 */
  degraded: RouteCheckDegraded[]
  /** 相邻段测量（含来源标注）。 */
  segments: RouteMeasurement[]
  /** 每日地理跨度（直线，Haversine）。 */
  daySpansKm: DaySpan[]
  /** 跨城折返判定的出发地基准（行程首站）。 */
  reference?: RoutePoint
}

export interface RouteCheckOptions {
  /** 跨城判定阈值（km）：stops 距出发地超过此值视为「已跨城」。 */
  intercityKm?: number
  /** 出发地半径（km）：距基准 ≤ 此值视为「回到出发地附近」。 */
  homeRadiusKm?: number
  /** 单日跨度告警阈值（km）；显式提供时覆盖节奏/路线旁车自适应值。 */
  daySpanWarnKm?: number
  /** 行程节奏：未显式给阈值时用于放宽单日跨度告警。 */
  pace?: 'relaxed' | 'balanced' | 'intensive'
  /** 已有路线旁车结果；estimated 只作距离估算，不升级为不可达证据。 */
  routeTransport?: readonly RouteTransportLeg[]
  /**
   * stop → 已解析 placeId 绑定表（T24）：用于把 routeTransport 的某条 leg 可靠
   * 归属到当天相邻段。缺失/命中不到该 stop → 该段不可绑定，回退有限估算阈值。
   */
  stopPlaceIds?: ReadonlyMap<ItineraryStop, string>
  /** 直线估算折算车速（km/h，仅影响 estimate 时长）。 */
  estimateSpeedKmh?: number
  /** 渠道测量源（有序候选；缺省 [直线估算]——离线零触网）。 */
  providers?: RouteMeasureProvider[]
  /** Key 解析环境（makeKeyEnv 热快照；缺省 undefined）。 */
  keyEnv?: KeyResolutionEnv
  /** 由 build 传入的 canonical final route fingerprint。 */
  routeFingerprint?: string
}

// ────────────────────────── 纯几何（决策基准） ──────────────────────────

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * 两点直线距离（km）。GCJ-02 平面近似：同一坐标系内 Haversine 求球面距离，
 * 与真实地面距离误差 ≤2%，足以做折返/跨度判定（FR-6 「就近成片」）。
 */
export function haversineKm(a: GeoCoords, b: GeoCoords): number {
  const R = 6371
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** 运行时坐标判定（ItineraryStop.coords 类型面非可选、draft 面可缺失）。 */
function hasCoords(value: ItineraryStop): value is ItineraryStop & { coords: GeoCoords } {
  const c = value.coords as GeoCoords | undefined
  return c !== undefined && typeof c.lng === 'number' && typeof c.lat === 'number'
    && typeof c.sys === 'string' && c.sys.length > 0
}

function roundKm(value: number): number {
  return Math.round(value * 10) / 10
}

function routeHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * 将最终规范化日程投影为唯一节点/边真源。
 * - 同一 placeId 的相邻复用（尤其日界住宿锚点）不产生 A→A；
 * - 非相邻重访保留 occurrenceId；
 * - 缺少 round3 标识的 legacy 日程只跳过 canonical 节点，不伪造 placeId。
 */
export function canonicalRouteFromDays(days: readonly ItineraryDay[]): CanonicalRoute {
  const nodes: CanonicalRoute['nodes'] = []
  const edges: CanonicalRoute['edges'] = []
  const seenOccurrences = new Set<string>()
  let previous: CanonicalRoute['nodes'][number] | undefined
  let orderIndex = 0
  for (const [dayIndex, day] of days.entries()) {
    for (const [stopIndex, stop] of day.stops.entries()) {
      if (typeof stop.placeId !== 'string' || stop.placeId.length === 0
        || typeof stop.occurrenceId !== 'string' || stop.occurrenceId.length === 0) continue
      if (previous?.placeId === stop.placeId) continue
      if (seenOccurrences.has(stop.occurrenceId)) continue
      const node = { occurrenceId: stop.occurrenceId, placeId: stop.placeId, dayIndex, stopIndex }
      nodes.push(node)
      seenOccurrences.add(node.occurrenceId)
      if (previous !== undefined) {
        edges.push({
          id: `edge-${orderIndex}`,
          fromOccurrenceId: previous.occurrenceId,
          toOccurrenceId: node.occurrenceId,
          orderIndex,
        })
        orderIndex += 1
      }
      previous = node
    }
  }
  return {
    schemaVersion: 2,
    fingerprint: routeHash({ nodes, edges }),
    nodes,
    edges,
  }
}

// ────────────────────────── 渠道源 ──────────────────────────

/** FR-6 渠道开关门：settings routeCheckAmap/routeCheckTencent → TRAVEL_CHANNEL_* env。 */
function channelGate(name: RouteCheckChannel, env?: KeyResolutionEnv): boolean {
  if (name === 'amap') return channelEnabled('routeCheckAmap', env)
  if (name === 'tencent') return channelEnabled('routeCheckTencent', env)
  return true
}

const CHANNEL_LABELS: Record<RouteCheckChannel, string> = {
  amap: '高德 distance',
  tencent: '腾讯 distance_matrix',
  estimate: '直线估算',
}

/** 说明文本用的数据来源标注（最高级成功渠道；无则纯几何）。 */
export function sourceLabelFor(channel: RouteCheckChannel | undefined): string {
  return channel !== undefined ? CHANNEL_LABELS[channel] : '直线几何'
}

/** 高德渠道源：FR-6 开关 + amapWebservice key 门；distanceMatrix(driving) 逐日对角测量。 */
export function createAmapRouteProvider(adapter: AmapAdapter): RouteMeasureProvider {
  return {
    name: 'amap',
    label: CHANNEL_LABELS.amap,
    async available(env) {
      if (!channelGate('amap', env)) return { ok: false, reason: '渠道停用（routeCheckAmap 开关）' }
      const ok = await adapter.available(env)
      return ok ? { ok: true } : { ok: false, reason: 'Key 未配置（amapWebservice）' }
    },
    async measure(segments, env) {
      const result: RouteMeasurement[] = []
      for (const day of groupByDay(segments)) {
        const { pairs } = await adapter.distanceMatrix(
          day.segments.map((s) => s.from.coords),
          day.segments.map((s) => s.to.coords),
          { driving: true },
          env,
        )
        result.push(...day.segments.map((seg, i) => {
          const pair = pairs.find((p) => p.originIndex === i && p.destinationIndex === i)
          if (pair === undefined) {
            throw EngineError.unavailable(`高德 distance 缺对角元素（day ${i + 1}）`, 'amap')
          }
          return {
            distanceKm: pair.distanceMeters / 1000,
            durationMinutes: pair.durationMinutes,
            source: 'amap' as const,
            note: '高德 distance（driving）',
          }
        }))
      }
      return result
    },
  }
}

/** 腾讯渠道源：零 key 体验通道常开（仅受 FR-6 开关门）；distance_matrix(driving)。 */
export function createTencentRouteProvider(adapter: TencentMapAdapter): RouteMeasureProvider {
  return {
    name: 'tencent',
    label: CHANNEL_LABELS.tencent,
    async available(env) {
      if (!channelGate('tencent', env)) return { ok: false, reason: '渠道停用（routeCheckTencent 开关）' }
      return { ok: true } // 零 key 体验通道常开
    },
    async measure(segments, env) {
      const result: RouteMeasurement[] = []
      for (const day of groupByDay(segments)) {
        const { data } = await adapter.distanceMatrix({
          from: day.segments.map((s) => `${s.from.coords.lat},${s.from.coords.lng}`),
          to: day.segments.map((s) => `${s.to.coords.lat},${s.to.coords.lng}`),
          mode: 'driving',
        }, env)
        result.push(...day.segments.map((seg, i) => {
          const row = data.rows[i]
          const element = row?.elements.find((e) => e.toIndex === i)
          if (row === undefined || element === undefined) {
            throw EngineError.unavailable(`腾讯 distance_matrix 缺对角元素（day ${i + 1}）`, 'tencent-map')
          }
          return {
            distanceKm: element.distanceMeters / 1000,
            durationMinutes: element.durationMinutes,
            source: 'tencent' as const,
            note: '腾讯 distance_matrix（driving，零 key 体验通道）',
          }
        }))
      }
      return result
    },
  }
}

/** 直线估算兜底渠道源（纯几何，永可行；标注「直线估算」）。 */
export function createEstimateRouteProvider(speedKmh = 40): RouteMeasureProvider {
  return {
    name: 'estimate',
    label: CHANNEL_LABELS.estimate,
    async available() {
      return { ok: true }
    },
    async measure(segments) {
      return segments.map((s) => {
        const distanceKm = haversineKm(s.from.coords, s.to.coords)
        return {
          distanceKm,
          durationMinutes: Math.round((distanceKm / speedKmh) * 60),
          source: 'estimate' as const,
          note: `直线估算（Haversine，GCJ-02 平面近似；按 ${speedKmh}km/h 折算时长）`,
        }
      })
    },
  }
}

/** 缺省兜底渠道（离线零触网）。 */
export const estimateRouteProvider: RouteMeasureProvider = createEstimateRouteProvider()

interface DaySegments {
  dayIndex: number
  date: string
  segments: RouteSegment[]
}

function groupByDay(segments: RouteSegment[]): DaySegments[] {
  const out: DaySegments[] = []
  for (const seg of segments) {
    let day = out.find((d) => d.dayIndex === seg.dayIndex)
    if (day === undefined) {
      day = { dayIndex: seg.dayIndex, date: seg.date, segments: [] }
      out.push(day)
    }
    day.segments.push(seg)
  }
  return out
}

/**
 * 相邻 stops（同日内，两端均带坐标）收集；缺坐标日单独记账。
 *
 * 段自带旁车绑定线索（orderIndex/两端 placeId）：orderIndex 沿用「选中序列」
 * 相邻边口径，这里按「带坐标 stop 在行程中的出现次序」逐日累加——一次行程内不
 * 跨日重置，因为 route-transport 的 orderIndex 是 selectedSequence 上的全局边号。
 * 两端 placeId 由 stopPlaceIds 绑定表解析（未提供/未命中 → undefined，该段不可绑定）。
 *
 * T24 注意：这个本地序号**不是** routeTransport 全局边号的等价物（selectedSequence
 * 去重折叠重访顶点，行程 draft 又按日拆分重复写入同一地点），因此它只在
 * bindDayDriving 的「同端点对多候选」场景里作定序凭据，不作跨坐标系换算。
 */
function collectSegments(
  days: ItineraryDay[],
  stopPlaceIds?: ReadonlyMap<ItineraryStop, string>,
): { segments: BoundRouteSegment[]; noCoordDays: number[] } {
  const segments: BoundRouteSegment[] = []
  const noCoordDays: number[] = []
  let vertexCursor = 0
  days.forEach((day, dayIndex) => {
    const stops = day.stops.filter(hasCoords)
    if (stops.length < 2) {
      if (day.stops.length >= 2) noCoordDays.push(dayIndex)
      return
    }
    for (let i = 0; i < stops.length - 1; i++) {
      segments.push({
        dayIndex,
        date: day.date,
        // orderIndex 是「该段起点在选中序列上的顶点序号」，首段为上一日顶点数累加值。
        orderIndex: vertexCursor + i,
        fromPlaceId: stopPlaceIds?.get(stops[i]),
        toPlaceId: stopPlaceIds?.get(stops[i + 1]),
        from: { name: stops[i].name, coords: stops[i].coords },
        to: { name: stops[i + 1].name, coords: stops[i + 1].coords },
      })
    }
    // 中途重访日会重新经过前面的顶点，边数不能只按站数递增；下一日的序号按
    // 本日**最后一个已用序号 + 1** 继续（T24：跨日序号必须单调不回头）。
    vertexCursor += Math.max(0, stops.length - 1)
  })
  return { segments, noCoordDays }
}

/** 每日地理跨度（km）：最远两站直线距离；<2 站 → undefined。 */
export function daySpanKm(day: ItineraryDay): number | undefined {
  const points = day.stops.filter(hasCoords).map((s) => s.coords)
  if (points.length < 2) return undefined
  let max = 0
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(max, haversineKm(points[i], points[j]))
    }
  }
  return max
}

/** 行程出发地基准（首个带坐标 stop）。 */
function firstCoordStop(days: ItineraryDay[]): RoutePoint | undefined {
  for (const day of days) {
    const stop = day.stops.find(hasCoords)
    if (stop !== undefined) return { name: stop.name, coords: stop.coords }
  }
  return undefined
}

// ────────────────────────── 自适应告警 ──────────────────────────

/**
 * 单日「估算跨度」阈值（几何口径）：pace 放宽只影响提示强弱，不改变跨城折返判定。
 *
 * 这是没有可靠驾驶距离绑定时的有限放宽口径：estimated/无关/部分覆盖/walking/transit
 * 都落回这里，永远给有限值（绝不 Infinity），以免脏输入制造静默告警。
 * 若调用方显式给阈值，仅接受有限非负值。
 */
function adaptiveDaySpanWarnKm(options: RouteCheckOptions): number {
  const explicit = options.daySpanWarnKm
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit
  switch (options.pace) {
    case 'relaxed': return 80
    case 'intensive': return 140
    case 'balanced': return 100
    default: return 20
  }
}

/**
 * 单日「真实驾驶里程」阈值（km）：仅在当天相邻段全部由明确 driving 旁车覆盖、
 * 且该 leg 的 distanceKm 是有限非负真实驾驶距离时才使用。
 *
 * 为什么另立一档而不是复用估算阈值：真实驾驶距离（道路里程）系统性大于直线距离
 * （绕行系数通常 1.2~1.4），把同一阈值同时用于两种口径会把自驾环线的正常长程段
 * 误报成硬伤（P2-E/P2-9 的原始缺陷）。这里按 pace 给自驾日里程上限：真实里程
 * 口径本就比几何口径宽（几何档默认 20km 是「就近成片」口径，对自驾日不合理）。
 */
/** 自驾日道路里程阈值（km）；不与直线跨度阈值混用。 */
export const SELF_DRIVE_DAY_LIMIT_KM = {
  relaxed: 250,
  balanced: 350,
  intensive: 450,
} as const

export const SELF_DRIVE_ABNORMAL_KM = 600

function selfDriveDayLimitKm(options: RouteCheckOptions): number {
  switch (options.pace) {
    case 'relaxed': return SELF_DRIVE_DAY_LIMIT_KM.relaxed
    case 'intensive': return SELF_DRIVE_DAY_LIMIT_KM.intensive
    default: return SELF_DRIVE_DAY_LIMIT_KM.balanced
  }
}

/** 真实驾驶距离绑定结果：当天相邻段与旁车 leg 的可靠对应。 */
interface DayDriveBinding {
  /** 当天全部相邻段都有可绑定的真实驾驶距离（无缺口）。 */
  complete: boolean
  /** 当天实际驾驶里程合计（km）。 */
  driveKm: number
  /** 已绑定段数 / 当天相邻段总数（留证用）。 */
  matched: number
  segments: number
}

/**
 * 把「当天相邻段」与 route-transport 旁车 leg 做保守绑定（T24）。
 *
 * 绑定凭据只接受「明确且可判定」的证据，任一环失败即放弃绑定：
 * - leg.mode 必须是 driving（walking/transit 的距离不能当驾驶里程）；
 * - leg.status 必须是 queried（真实渠道实测）——**estimated 不接受**：直线估算是几何
 *   口径，不是道路里程，放进「真实驾驶距离」档会同时造成两处失真（给几何量贴真实渠道
 *   标签 + 吞掉当天几何跨度告警）；unavailable/blocked 也不提供里程；
 * - leg.distanceKm 必须是有限非负数值；
 * - seg 两端 placeId 必须都已归属；
 * - 端点双向确认：候选 leg 的 fromPlaceId/toPlaceId 必须与 seg 两个 placeId
 *   逐位一致（方向敏感），不靠名称或坐标近似——同名异地、坐标微差都不能冒充。
 *
 * 顺序同一性（本函数的核心）分两种**可判定**情形，二者都是充分凭据：
 *   ① 两端 placeId 在可绑定 leg 里**唯一对应**时，leg.orderIndex 就是权威腿号，
 *      直接采信。为什么不能再用本地推算的 seg.orderIndex 否决：selectedSequence
 *      里同一地点会被去重折叠（重访/闭环只保留一份），而行程 draft 的每日时段
 *      拆分往往把同一地点重复写入多天——于是「当天第 i 段」无法由每日站数稳定
 *      推算（跨日时前日末站 ≠ 次日首站），本地序号会单调偏移并系统性拒绝正确腿。
 *   ② 同一端点对出现多个候选 leg（重访/闭环/同端点多路径）时，改判要求
 *      leg.orderIndex === seg.orderIndex 精确匹配；两边序号口径不同则**放弃绑定**
 *      （complete=false → 调用方回退有限估算阈值），而不是猜一条里程。
 *
 * 序号口径：这里的 seg.orderIndex 是 collectSegments 的本地序（同日相邻边逐段
 * 递增），与 routeTransport 的全局 selectedSequence 边号**不是同一坐标系**；
 * 情形 ② 只用于「同端点多候选之间二选一」，不承担跨坐标系换算。
 *
 * 只有当天相邻段**全覆盖**才算绑定成功；部分覆盖/无法归属/端点不一致/多候选
 * 无法定序都返回 complete=false，调用方回退到有限放宽的估算阈值，绝不把部分
 * 覆盖或无关旁车当成完整驾驶证据（亦不得产生 Infinity）。
 */
function bindDayDriving(
  daySegments: readonly BoundRouteSegment[],
  legs: readonly RouteTransportLeg[] | undefined,
): DayDriveBinding {
  const segments = daySegments.length
  if (legs === undefined || segments === 0) return { complete: false, driveKm: 0, matched: 0, segments }
  // 只采信 queried：真实驾驶距离口径必须来自真实渠道。
  // estimated 是**直线估算**（models/types.ts 契约原话「直线估算不冒充道路长度/驾驶时长/
  // 可达性证据」），它进不了真实里程口径——否则同一条几何量会被贴上「数据=真实驾驶距离」
  // 的标签，并顺带吞掉当天本应发出的有限几何跨度告警（两处造假一次完成）。
  const usable = legs.filter((leg) => leg.mode === 'driving'
    && (leg.metricStatus ?? leg.status) === 'queried'
    && typeof leg.distanceKm === 'number' && Number.isFinite(leg.distanceKm) && leg.distanceKm >= 0)
  if (usable.length === 0) return { complete: false, driveKm: 0, matched: 0, segments }

  let driveKm = 0
  let matched = 0
  const claimed = new Set<number>()
  for (const seg of daySegments) {
    // 两端 placeId 必须都已归属，否则该段无从确认身份（不靠名称/坐标近似）。
    if (seg.fromPlaceId === undefined || seg.toPlaceId === undefined) {
      return { complete: false, driveKm: 0, matched, segments }
    }
    const candidates = usable
      .map((leg, k) => ({ leg, k }))
      .filter(({ leg, k }) => !claimed.has(k)
        && leg.fromPlaceId === seg.fromPlaceId
        && leg.toPlaceId === seg.toPlaceId)
    if (candidates.length === 0) return { complete: false, driveKm: 0, matched, segments }
    // 情形 ② ：同端点对多候选 → 必须 orderIndex 精确指认，指认不出就不绑定。
    const chosen = candidates.length === 1
      ? candidates[0]
      : candidates.find(({ leg }) => leg.orderIndex === seg.orderIndex)
    if (chosen === undefined) return { complete: false, driveKm: 0, matched, segments }
    claimed.add(chosen.k)
    matched += 1
    driveKm += chosen.leg.distanceKm as number
  }
  return { complete: matched === segments, driveKm, matched, segments }
}

/** route-transport 只在明确状态时影响告警：estimated 不冒充不可达，blocked 保留硬 issue。 */
function appendRouteTransportWarnings(
  routeTransport: readonly RouteTransportLeg[] | undefined,
  issues: string[],
  warnings: string[],
): void {
  for (const leg of routeTransport ?? []) {
    const segment = `路线第${leg.orderIndex + 1}段（${leg.fromPlaceId}→${leg.toPlaceId}）`
    const status = leg.metricStatus ?? leg.status
    if (status === 'blocked') {
      issues.push(`${segment}不可达：${leg.estimateReason ?? '路线旁车明确标记 blocked'}`)
    } else if (status === 'unavailable') {
      warnings.push(`${segment}路线旁车不可用：${leg.estimateReason ?? '渠道未返回可用结果'}；不据此判定真实不可达`)
    }
  }
}

// ────────────────────────── 主入口 ──────────────────────────

/**
 * 动线校验主入口：渠道链测量 + 几何检测（跨城折返 / 单日跨度）。
 * 返回完整明细（issues/warnings 供 itinerary.json 契约；渠道链留证）。
 * 纯函数可用性：渠道源由 options.providers 注入；缺省纯几何零触网。
 */
export async function runRouteCheck(
  days: ItineraryDay[],
  options: RouteCheckOptions = {},
): Promise<RouteCheckDetail> {
  const env = options.keyEnv
  const intercityKm = options.intercityKm ?? 25
  const homeRadiusKm = options.homeRadiusKm ?? 10
  const daySpanWarnKm = adaptiveDaySpanWarnKm(options)
  const providers = options.providers ?? [createEstimateRouteProvider(options.estimateSpeedKmh ?? 40)]

  const issues: string[] = []
  const warnings: string[] = []
  const degraded: RouteCheckDegraded[] = []
  const channelsUsed: RouteCheckChannel[] = []
  const segments: RouteMeasurement[] = []

  const reference = firstCoordStop(days)
  const { segments: rawSegments, noCoordDays } = collectSegments(days, options.stopPlaceIds)

  for (const dayIndex of noCoordDays) {
    warnings.push(`第${dayIndex + 1}天（${days[dayIndex].date}）stops 无坐标，动线距离校验跳过该日`)
  }

  if (rawSegments.length > 0) {
    // 三级降级链：逐渠道尝试——渠道开关 → 可用性（Key 门）→ 测量；成功即定级停止。
    for (const provider of providers) {
      if (!channelGate(provider.name, env)) {
        degraded.push({ channel: provider.name, reason: '渠道停用（用户配置）' })
        continue
      }
      const availability = await provider.available(env)
      if (!availability.ok) {
        degraded.push({ channel: provider.name, reason: availability.reason ?? '渠道不可用' })
        continue
      }
      try {
        const measured = await provider.measure(rawSegments, env)
        segments.push(...measured)
        channelsUsed.push(provider.name)
        break
      } catch (err) {
        degraded.push({
          channel: provider.name,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (channelsUsed.length === 0) {
      warnings.push('动线距离渠道全部失败，检测基于直线几何（估算）')
    }
  } else {
    warnings.push('行程各日可测量 stops 不足（单日 <2 个带坐标 stops），动线校验未执行')
  }

  const sourceLabel = sourceLabelFor(channelsUsed[0])
  // 几何跨度恒为 Haversine（daySpansKm 的语义不变）；阈值与比较口径按当天是否
  // 有可靠的 driving 旁车绑定分两档，见下。
  const spanSourceLabel = '直线估算（Haversine）'
  const selfDriveLimitKm = selfDriveDayLimitKm(options)

  // 单日跨度告警（逐日留证 daySpansKm）：默认按几何跨度比估算阈值；当天相邻段被
  // **queried 真实 driving 旁车**全覆盖且段段可绑定时，才改用「实际驾驶里程合计」比
  // 自驾日里程阈值（真实道路里程口径），两条硬 gate 互不冒充：
  //  - 绑定失败（无旁车/部分覆盖/端点无法归属/非 driving/estimated 直线估算/
  //    无有效距离）→ 几何档（有限 Haversine 阈值，告警不被吞）；
  //  - 显式 daySpanWarnKm → 始终几何档（调用方显式口径不被旁车改写）。
  const daySpansKm: DaySpan[] = []
  const explicitSpanLimit = options.daySpanWarnKm !== undefined
    && Number.isFinite(options.daySpanWarnKm) && options.daySpanWarnKm >= 0
  days.forEach((day, dayIndex) => {
    const span = daySpanKm(day)
    if (span === undefined) return
    daySpansKm.push({ dayIndex, date: day.date, spanKm: roundKm(span) })
    const daySegments = rawSegments.filter((seg) => seg.dayIndex === dayIndex)
    const binding = explicitSpanLimit
      ? { complete: false, driveKm: 0, matched: 0, segments: daySegments.length }
      : bindDayDriving(daySegments, options.routeTransport)
    if (binding.complete) {
      // 实际驾驶里程口径：来源标注真实驾驶距离，便于调用方区分两档证据。
      if (binding.driveKm > selfDriveLimitKm) {
        const abnormal = binding.driveKm >= SELF_DRIVE_ABNORMAL_KM ? '；异常告警：单日驾驶里程已达 600km 及以上' : ''
        warnings.push(
          `第${dayIndex + 1}天（${day.date}）实际驾驶里程约 ${roundKm(binding.driveKm)}km，`
          + `超过自驾日里程阈值 ${selfDriveLimitKm}km${abnormal}（数据=真实驾驶距离，覆盖 ${binding.matched}/${binding.segments} 段）`,
        )
      } else if (binding.driveKm >= SELF_DRIVE_ABNORMAL_KM) {
        // 防御：若未来某 pace 阈值被放宽到 600km，异常规则仍不可绕过。
        warnings.push(
          `第${dayIndex + 1}天（${day.date}）异常告警：实际驾驶里程约 ${roundKm(binding.driveKm)}km，`
          + '已达 600km 及以上（数据=真实驾驶距离）',
        )
      }
      return
    }
    if (span > daySpanWarnKm) {
      warnings.push(`第${dayIndex + 1}天（${day.date}）地理跨度约 ${roundKm(span)}km，超过阈值 ${daySpanWarnKm}km（数据=${spanSourceLabel}）`)
    }
  })

  // route-transport 的明确不可达/不可用状态独立记账；不与几何阈值混为一谈。
  appendRouteTransportWarnings(options.routeTransport, issues, warnings)

  // 跨城折返检测（FR-6 验收①；基准 = 出发地首站）
  if (reference !== undefined) {
    const dayFarthestKm = days.map((day) =>
      day.stops.filter(hasCoords)
        .reduce((max, s) => Math.max(max, haversineKm(reference.coords, s.coords)), 0))

    // 两日间 A→B→A：第 N 天已跨城（最远 > intercity），第 N+1 天首站回到出发地附近
    for (let d = 0; d < days.length - 1; d++) {
      if (dayFarthestKm[d] <= intercityKm) continue
      const firstNext = days[d + 1].stops.filter(hasCoords)[0]
      if (firstNext !== undefined && haversineKm(reference.coords, firstNext.coords) <= homeRadiusKm) {
        issues.push(
          `第${d + 1}天（${days[d].date}）已跨城出行（最远距出发地「${reference.name}」约 ${roundKm(dayFarthestKm[d])}km），`
          + `第${d + 2}天首站又回到其附近 —— A→B→A 跨城折返（数据=${sourceLabel}）`,
        )
      }
    }

    // 同日跨城往返：单日内 近(≤homeRadius) → 远(>intercity) → 近
    days.forEach((day, dayIndex) => {
      const dists = day.stops.filter(hasCoords).map((s) => haversineKm(reference.coords, s.coords))
      for (let i = 0; i < dists.length; i++) {
        if (dists[i] <= intercityKm) continue
        const nearBefore = dists.slice(0, i).some((d) => d <= homeRadiusKm)
        const nearAfter = dists.slice(i + 1).some((d) => d <= homeRadiusKm)
        if (nearBefore && nearAfter) {
          issues.push(
            `第${dayIndex + 1}天（${day.date}）同日跨城往返：行程先近出发地「${reference.name}」、`
            + `远行至约 ${roundKm(dists[i])}km 外、又回到出发地附近 —— 单日折返（数据=${sourceLabel}）`,
          )
          break
        }
      }
    })
  }

  return {
    issues,
    warnings,
    channelsUsed,
    degraded,
    segments,
    daySpansKm,
    reference,
    routeFingerprint: options.routeFingerprint ?? canonicalRouteFromDays(days).fingerprint,
  }
}

/** 契约投影：明细 → §5.5 routeCheck{issues,warnings}（itinerary.json 落盘形态）。 */
export function toRouteCheck(detail: RouteCheckDetail): RouteCheck {
  return { issues: [...detail.issues], warnings: [...detail.warnings] }
}