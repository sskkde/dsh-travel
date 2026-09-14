/**
 * amap 适配器（W2b）：高德 Web 服务 REST（design ADR-7 行 344-346、§8 市内衔接）。
 *
 * 四件套：direction(transit) / weather / distance_matrix / geocoder
 * （+ POI 补充位——ADR-3 降级角色，收敛服务端配额）。
 *
 * Key 门控：无 key → available()=false → fan-out 前置过滤跳过 + degraded
 * 「Key 未配置」；Key 只经 base.ts resolveKey（settings→credentials→env）。
 * 配额：个人 5000/月口径由 QuotaCounter 收敛服务端（月初滚动）+ 单次规划预算
 * （POI≤40 / REST≤60，超预算停新增+告警）。
 * 缓存：POI/geocoder 类 30 天 TTL；direction/weather 短 TTL（30 分钟）。
 * 坐标：高德原生 GCJ-02 直落（§5.1 项 3）；金额统一元、时长统一分钟。
 */
import { BaseAdapter, EngineError, toDegraded, channelEnabled, isKeyConfigured, secondsToMinutes, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import type { UsageRecorder } from '../metrics/usage.js'
import type { AdviceWeatherEntry, CityTransferOption, GeoCoords, IntelItem, RouteGeometry } from '../models/types.js'

/** Key 标识符（design §10.2 / 编排者约定）：resolveKey 首参，环境兜底名=标识符本身
 * （process.env.amapWebservice）；credentials 层 resolveCredential 回调把标识符
 * 映射为 ref `AMAP_WEBSERVICE` 再调 ctx.credentials.resolve(ref)（W6 接线）。
 */
export const AMAP_KEY = 'amapWebservice'
/** JSAPI 侧标识符（ref `AMAP_JSAPI`+`AMAP_JSCODE`；地图加载 W5 用，REST 不消费）。 */
export const AMAP_JSAPI_KEY = 'amapJsapi'
export const AMAP_JSCODE_KEY = 'amapJscode'
export const AMAP_API_BASE = 'https://restapi.amap.com/v3'

/** 个人搜索配额 5000/月口径（learnings 行 13；收敛服务端）。 */
export const AMAP_MONTHLY_QUOTA = 5000
/** 单次规划预算：POI 检索 ≤40、其余 REST ≤60（NFR-6）。 */
export const AMAP_BUDGET_POI = 40
export const AMAP_BUDGET_REST = 60
/** POI/geocoder 响应缓存 30 天；direction/weather 短缓存 30 分钟。 */
export const CACHE_TTL_LONG_MS = 30 * 24 * 3600 * 1000
export const CACHE_TTL_SHORT_MS = 30 * 60 * 1000

// ────────────────────────── 配额计数器（熔断核心） ──────────────────────────

export interface QuotaSnapshot {
  monthlyUsed: number
  monthlyLimit: number
  /** 当前所属月份 YYYY-MM（月初滚动）。 */
  month: string
  planPoiUsed: number
  planPoiLimit: number
  planRestUsed: number
  planRestLimit: number
  alarms: string[]
}

export interface QuotaOptions {
  monthlyLimit?: number
  poiLimit?: number
  restLimit?: number
  now?: () => Date
}

/**
 * 配额计数器：月度配额（5000/月，月初滚动）+ 单次规划预算（POI≤40/REST≤60）。
 * acquire 返回是否放行；熔断（超限）置告警（去重）并拒发新请求。
 */
export class QuotaCounter {
  monthlyUsed = 0
  planPoiUsed = 0
  planRestUsed = 0
  private readonly monthlyLimit: number
  private readonly poiLimit: number
  private readonly restLimit: number
  private readonly now: () => Date
  private month: string
  readonly alarms: string[] = []

  constructor(opts: QuotaOptions = {}) {
    this.monthlyLimit = opts.monthlyLimit ?? AMAP_MONTHLY_QUOTA
    this.poiLimit = opts.poiLimit ?? AMAP_BUDGET_POI
    this.restLimit = opts.restLimit ?? AMAP_BUDGET_REST
    this.now = opts.now ?? (() => new Date())
    this.month = this.currentMonth()
  }

  private currentMonth(): string {
    const d = this.now()
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }

  private rollMonthIfNeeded(): void {
    const cur = this.currentMonth()
    if (cur !== this.month) {
      this.month = cur
      this.monthlyUsed = 0
    }
  }

  /** 尝试放行一次调用；ok=false 时 reason 即熔断原因（已告警）。 */
  acquire(kind: 'poi' | 'rest'): { ok: boolean; reason?: string } {
    this.rollMonthIfNeeded()
    if (this.monthlyUsed >= this.monthlyLimit) {
      const reason = `配额熔断：月度 ${this.monthlyLimit} 次已用尽`
      this.alarm(reason)
      return { ok: false, reason }
    }
    const planUsed = kind === 'poi' ? this.planPoiUsed : this.planRestUsed
    const planLimit = kind === 'poi' ? this.poiLimit : this.restLimit
    if (planUsed >= planLimit) {
      const reason = `配额熔断：单次规划 ${kind === 'poi' ? 'POI' : 'REST'} 预算 ${planLimit} 次已用尽（停新增）`
      this.alarm(reason)
      return { ok: false, reason }
    }
    if (kind === 'poi') this.planPoiUsed += 1
    else this.planRestUsed += 1
    this.monthlyUsed += 1
    return { ok: true }
  }

  /** 单次规划开始：清零规划预算（月度配额不动）。 */
  resetPlanBudget(): void {
    this.planPoiUsed = 0
    this.planRestUsed = 0
  }

  /** 计数快照（供 get_state / 调试；无任何明文 key）。 */
  snapshot(): QuotaSnapshot {
    this.rollMonthIfNeeded()
    return {
      monthlyUsed: this.monthlyUsed,
      monthlyLimit: this.monthlyLimit,
      month: this.month,
      planPoiUsed: this.planPoiUsed,
      planPoiLimit: this.poiLimit,
      planRestUsed: this.planRestUsed,
      planRestLimit: this.restLimit,
      alarms: [...this.alarms],
    }
  }

  private alarm(reason: string): void {
    if (!this.alarms.includes(reason)) this.alarms.push(reason)
  }
}

// ────────────────────────── TTL 响应缓存 ──────────────────────────

interface CacheEntry {
  ts: number
  /** 条目级 TTL（set 显式传参时覆盖实例缺省；缺省=实例 ttlMs）。 */
  ttlMs: number
  data: unknown
}

/** 内存 TTL 缓存：支持实例级缺省 TTL + 条目级 TTL（POI/geocoder 30 天、weather/direction 短 TTL）。 */
export class TtlCache {
  private readonly store = new Map<string, CacheEntry>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get(key: string): unknown | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.ts > entry.ttlMs) {
      this.store.delete(key)
      return undefined
    }
    return entry.data
  }

  /** 显式 ttlMs 覆盖实例缺省：同一缓存实例可混存 30 天长 TTL 与短 TTL 条目。 */
  set(key: string, data: unknown, ttlMs?: number): void {
    this.store.set(key, { ts: Date.now(), ttlMs: ttlMs ?? this.ttlMs, data })
  }

  size(): number {
    return this.store.size
  }
}

/** 缓存键：endpoint + 参数（**剔除 key 及易变参数**，键不含明文）。 */
export function cacheKey(endpoint: string, params: Record<string, string>, exclude: string[] = ['key']): string {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (exclude.includes(k)) continue
    clean[k] = v
  }
  return `${endpoint}|${JSON.stringify(Object.entries(clean).sort(([a], [b]) => (a < b ? -1 : 1)))}`
}

const AMAP_COORD_DECIMALS = 6
/** 高德 HTTP 坐标格式：GCJ-02 原值保留，最多 6 位小数，避免过长参数/浮点噪声。 */
function formatAmapCoord(value: number): string {
  return Number(value.toFixed(AMAP_COORD_DECIMALS)).toString()
}

export const AMAP_POI_MAX_QUERY_CHARS = 80

/**
 * POI 专用关键词清洗：去掉成对/孤立中英文引号，并按空白词组分批；不改变通用
 * L0 搜索的关键词语义。每个 HTTP 请求的 keywords 总长度受限，避免 `%22` 与过长
 * query 触发高德 INVALID_PARAMS。
 */
export function splitAmapPoiKeywordBatches(raw: string, maxChars = AMAP_POI_MAX_QUERY_CHARS): string[] {
  const cleaned = raw
    .replace(/["“”‘’'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return []
  const groups = cleaned.split(' ').filter(Boolean)
  const batches: string[] = []
  let current = ''
  for (const group of groups) {
    const chunks = group.length <= maxChars
      ? [group]
      : Array.from({ length: Math.ceil(group.length / maxChars) }, (_, i) => group.slice(i * maxChars, (i + 1) * maxChars))
    for (const chunk of chunks) {
      if (current === '') {
        current = chunk
      } else if (current.length + 1 + chunk.length <= maxChars) {
        current = `${current} ${chunk}`
      } else {
        batches.push(current)
        current = chunk
      }
    }
  }
  if (current !== '') batches.push(current)
  return batches
}

/** 单批 POI 关键词清洗便捷函数（调用方需要展示/断言时使用）。 */
export function cleanAmapPoiKeywords(raw: string): string {
  return splitAmapPoiKeywordBatches(raw).join(' ')
}

// ────────────────────────── 归一化纯函数（可单测） ──────────────────────────

/** 公交/地铁方案归一化：RouteOption{cost 元/duration 分钟/walking 米/segments}。 */
export interface AmapTransitRoute {
  cost: number
  durationMinutes: number
  walkingDistance: number
  distanceMeters: number
  segments: {
    mode: 'walking' | 'bus' | 'metro'
    from?: string
    to?: string
    line?: string
    departTime?: string
    arriveTime?: string
  }[]
}

export interface AmapWeather {
  entries: AdviceWeatherEntry[]
  degraded: DegradedEntry[]
}

/** v3 direction/transit/integrated route → AmapTransitRoute（时长秒→分钟，金额元）。 */
export function normalizeTransitRoute(rawRoute: Record<string, unknown>): AmapTransitRoute {
  const segments = extractSegments(rawRoute.segments)
  return {
    cost: numberOr(rawRoute.cost, 0),
    durationMinutes: secondsToMinutes(numberOr(rawRoute.duration, 0)),
    walkingDistance: numberOr(rawRoute.walking_distance, 0),
    distanceMeters: numberOr(rawRoute.distance, 0),
    segments,
  }
}

function extractSegments(raw: unknown): AmapTransitRoute['segments'] {
  const out: AmapTransitRoute['segments'] = []
  if (!Array.isArray(raw)) return out
  for (const seg of raw as Array<Record<string, unknown>>) {
    const walking = seg.walking as Record<string, unknown> | undefined
    if (walking) {
      out.push({ mode: 'walking', from: walking.origin as string | undefined, to: walking.destination as string | undefined })
    }
    const metro = seg.metro as Record<string, unknown> | undefined
    const metroLines = metro?.metro_lines as Array<Record<string, unknown>> | undefined
    if (Array.isArray(metroLines) && metroLines[0]) {
      const line = metroLines[0]
      const dep = (line.departure_stop as Record<string, unknown> | undefined)?.name as string | undefined
      const arr = (line.arrival_stop as Record<string, unknown> | undefined)?.name as string | undefined
      out.push({
        mode: 'metro',
        from: dep,
        to: arr,
        line: line.name as string | undefined,
        departTime: line.departure_time as string | undefined,
        arriveTime: line.arrival_time as string | undefined,
      })
    }
    const bus = seg.bus as Record<string, unknown> | undefined
    const busLines = bus?.buslines as Array<Record<string, unknown>> | undefined
    if (Array.isArray(busLines) && busLines[0]) {
      const line = busLines[0]
      const dep = (line.departure_stop as Record<string, unknown> | undefined)?.name as string | undefined
      const arr = (line.arrival_stop as Record<string, unknown> | undefined)?.name as string | undefined
      out.push({
        mode: 'bus',
        from: dep,
        to: arr,
        line: line.name as string | undefined,
        departTime: line.departure_time as string | undefined,
        arriveTime: line.arrival_time as string | undefined,
      })
    }
  }
  return out
}

/** §5.5 CityTransferOption 映射（咨询级价格 hint 原样透传）。 */
export function toCityTransferOptions(routes: AmapTransitRoute[]): CityTransferOption[] {
  return routes.map((r, i) => ({
    mode: `方案${i + 1}：${r.segments.filter((s) => s.mode !== 'walking').map((s) => (s.line ? `${s.mode}·${s.line}` : s.mode)).join('+') || '步行'}`,
    durationMinutes: r.durationMinutes,
    priceHint: r.cost > 0 ? `${r.cost} 元` : '免票/未知',
  }))
}

/** v3/weather forecasts.casts → AdviceWeatherEntry（day/night 合并 + 温度区间）。 */
export function normalizeWeatherCasts(casts: unknown): AdviceWeatherEntry[] {
  const out: AdviceWeatherEntry[] = []
  if (!Array.isArray(casts)) return out
  for (const cast of casts as Array<Record<string, unknown>>) {
    const dayTemp = Number(cast.daytemp)
    const nightTemp = Number(cast.nighttemp)
    out.push({
      date: String(cast.date ?? ''),
      dayForecast: `${String(cast.dayweather ?? '')} 转 ${String(cast.nightweather ?? '')}`,
      tempRange: Number.isFinite(dayTemp) && Number.isFinite(nightTemp) ? [nightTemp, dayTemp] : undefined,
      source: {
        platform: 'amap-weather',
        url: `${AMAP_API_BASE}/weather/weatherInfo`,
        fetchedAt: new Date().toISOString(),
      },
    })
  }
  return out
}

/** v3/geocode/geo geocodes[0] → GCJ-02（高德原生坐标系直落）。 */
export function normalizeGeocode(geocodes: unknown): GeoCoords | undefined {
  if (!Array.isArray(geocodes) || !geocodes[0]) return undefined
  const loc = (geocodes[0] as Record<string, unknown>).location as string | undefined
  if (!loc) return undefined
  const [lng, lat] = loc.split(',').map(Number)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined
  return { lng, lat, sys: 'GCJ02' }
}

/** v3/distance results[] → {distanceMeters, durationMinutes} 对。 */
export function normalizeDistanceMatrix(results: unknown): Array<{ originIndex: number; destinationIndex: number; distanceMeters: number; durationMinutes: number }> {
  const out: Array<{ originIndex: number; destinationIndex: number; distanceMeters: number; durationMinutes: number }> = []
  if (!Array.isArray(results)) return out
  for (const r of results as Array<Record<string, unknown>>) {
    out.push({
      originIndex: Number(r.origin_id ?? r.origin ?? 0),
      destinationIndex: Number(r.dest_id ?? r.destination ?? 0),
      distanceMeters: Number(r.distance ?? 0),
      durationMinutes: secondsToMinutes(Number(r.duration ?? 0)),
    })
  }
  return out
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6))
}

/** 中国境外坐标不做 GCJ-02 逆变换；与 base.ts 的正向口径保持一致。 */
function isOutsideChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return ret
}

/** GCJ-02 → WGS-84：迭代反解，输出最多 6 位小数的 [lng,lat]。 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    throw new RangeError(`gcj02ToWgs84: 非法坐标 (${lng}, ${lat})`)
  }
  if (isOutsideChina(lng, lat)) return [roundCoordinate(lng), roundCoordinate(lat)]
  const a = 6378245
  const ee = 0.006693421622965943
  let candidateLng = lng
  let candidateLat = lat
  for (let i = 0; i < 6; i++) {
    const x = candidateLng - 105
    const y = candidateLat - 35
    const radLat = candidateLat / 180 * Math.PI
    let magic = Math.sin(radLat)
    magic = 1 - ee * magic * magic
    const sqrtMagic = Math.sqrt(magic)
    const deltaLat = transformLat(x, y) * 180 / ((a * (1 - ee) / (magic * sqrtMagic)) * Math.PI)
    const deltaLng = transformLng(x, y) * 180 / ((a / sqrtMagic * Math.cos(radLat)) * Math.PI)
    candidateLng = lng - deltaLng
    candidateLat = lat - deltaLat
  }
  return [roundCoordinate(candidateLng), roundCoordinate(candidateLat)]
}

/** 高德 direction 的步骤 polyline（GCJ-02 lon,lat）→ canonical WGS84 geometry。 */
export function normalizeAmapDrivingGeometry(value: unknown): RouteGeometry | undefined {
  const points: Array<[number, number]> = []
  const append = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    for (const part of raw.split(/[;|]/)) {
      const [lng, lat] = part.split(',').map((item) => Number(item.trim()))
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      const point = gcj02ToWgs84(lng, lat)
      const prior = points.at(-1)
      if (prior === undefined || prior[0] !== point[0] || prior[1] !== point[1]) points.push(point)
    }
  }
  const route = recordOf(value)
  const paths = Array.isArray(route?.paths) ? route.paths : []
  const path = recordOf(paths[0])
  // Prefer one complete route/path polyline. Step polylines are only a fallback;
  // appending them after a complete path would replay the route and create false
  // backtracking geometry.
  const completePolyline = typeof route?.polyline === 'string'
    ? route.polyline
    : typeof path?.polyline === 'string' ? path.polyline : undefined
  if (completePolyline !== undefined) append(completePolyline)
  else {
    const steps = Array.isArray(path?.steps) ? path.steps : []
    for (const step of steps) append(recordOf(step)?.polyline)
  }
  if (points.length < 2) return undefined
  return {
    type: 'LineString',
    coordinates: points,
    source: 'amap-direction',
    coordinateSystem: 'WGS84',
    pointOrder: 'lng,lat',
  }
}

export interface AmapDrivingRoute {
  distanceMeters: number
  durationMinutes: number
  geometry?: RouteGeometry
}

/** 高德 v3/direction/driving route → 指标 + WGS84 geometry；无 polyline 仍保留实测指标。 */
export function normalizeAmapDrivingRoute(value: unknown): AmapDrivingRoute | undefined {
  const route = recordOf(value)
  const paths = Array.isArray(route?.paths) ? route.paths : []
  const path = recordOf(paths[0])
  if (path === undefined) return undefined
  const distance = Number(path.distance)
  const duration = Number(path.duration)
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(duration) || duration < 0) return undefined
  const geometry = normalizeAmapDrivingGeometry(route)
  return {
    distanceMeters: distance,
    durationMinutes: secondsToMinutes(duration),
    ...(geometry !== undefined ? { geometry } : {}),
  }
}

/**
 * 坐标串判定："lng,lat" 数字模式（transit 接口入参形态）。
 * 非坐标串（中文地名等）走内部 geocode 前置。容忍空白与多段（取前两位）。
 */
export function isCoordinateString(value: string): boolean {
  const parts = value.trim().split(',').map((p) => Number(p.trim()))
  if (parts.length < 2) return false
  return parts.slice(0, 2).every(Number.isFinite)
}

// ────────────────────────── 适配器 ──────────────────────────

function classifyAmapApiFailure(info: string): '参数错误' | '权限/配额' | '服务错误' {
  if (/MISSING_REQUIRED_PARAMS|INVALID_PARAMS|PARAM(?:ETER)?_ERROR|请求参数|参数错误/i.test(info)) return '参数错误'
  if (/INVALID_USER_KEY|USER_KEY|ACCESS|PERMISSION|AUTH|QUOTA|OVER_LIMIT|DAILY_QUERY|服务不存在|权限|配额/i.test(info)) return '权限/配额'
  return '服务错误'
}

export interface AmapOptions {
  fetchFn?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  quota?: QuotaCounter
  cache?: TtlCache
  timeoutMs?: number
  /** 用量记录器（M3.3 只观测；缺省回落模块级默认单例，index.ts 注入落盘实例）。 */
  usage?: UsageRecorder
}

export class AmapAdapter extends BaseAdapter {
  private readonly fetchFn: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  /** 配额计数器（熔断/预算；可注入做确定性单测）。 */
  readonly quota: QuotaCounter
  private readonly cache: TtlCache
  private readonly timeoutMs: number

  constructor(opts: AmapOptions = {}) {
    super('amap', { supports: new Set<string>() }, { usage: opts.usage })
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url))
    this.quota = opts.quota ?? new QuotaCounter()
    this.cache = opts.cache ?? new TtlCache(CACHE_TTL_LONG_MS)
    this.timeoutMs = opts.timeoutMs ?? 10000
  }

  /** Key 门控：无 key → false（fan-out 跳过 + degraded「Key 未配置」）。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('amap', env)) return false
    return isKeyConfigured(AMAP_KEY, env)
  }

  /** 单次规划开始：重置规划预算（编排者/W3 在 research 启动时调用）。 */
  resetPlanBudget(): void {
    this.quota.resetPlanBudget()
  }

  /** 配额快照（get_state 汇总用）。 */
  quotaSnapshot(): QuotaSnapshot {
    return this.quota.snapshot()
  }

  /**
   * 主路线：WebService direction/driving。高德返回 GCJ-02 lon,lat polyline；
   * 在 host 端归一化为 WGS84 GeoJSON，页面不再自行算路。
   */
  async directionDriving(
    origin: GeoCoords,
    destination: GeoCoords,
    env?: KeyResolutionEnv,
  ): Promise<{ route: AmapDrivingRoute; degraded: DegradedEntry[] }> {
    const degraded: DegradedEntry[] = []
    try {
      const data = await this.rest<{ route?: unknown }>(
        'direction/driving',
        {
          origin: `${formatAmapCoord(origin.lng)},${formatAmapCoord(origin.lat)}`,
          destination: `${formatAmapCoord(destination.lng)},${formatAmapCoord(destination.lat)}`,
          extensions: 'all',
        },
        'rest',
        env,
        CACHE_TTL_SHORT_MS,
      )
      const route = normalizeAmapDrivingRoute(data.route)
      if (route === undefined) throw EngineError.empty('高德 direction/driving 无有效路线', 'amap')
      return { route, degraded }
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      throw err
    }
  }

  /**
   * 市内衔接：direction(transit)（§8 双方案之高德侧）。
   *
   * **地名前置地理编码**（design §5.1 变换规则：transit 接口要求经纬度坐标，
   * 地名经 INVALID_PARAMS 拒绝——live 实测修复）：origin/destination 若为
   * 坐标串（"lng,lat" 数字模式）直传；否则内部链式 geocode（带上 city/cityd
   * 提示做消歧），成功 → 用坐标调 transit，失败 → EngineError.UNAVAILABLE +
   * degraded 记账（不裸抛原始错误）。geocode 走同一配额/缓存体系（30 天缓存，
   * 重复地名不再产生额外调用）。
   */
  async directionTransit(
    origin: string,
    destination: string,
    opts: { city?: string; cityd?: string; kind?: 'poi' | 'rest' } = {},
    env?: KeyResolutionEnv,
  ): Promise<{ routes: AmapTransitRoute[]; options: CityTransferOption[]; degraded: DegradedEntry[] }> {
    const degraded: DegradedEntry[] = []
    try {
      const originCoord = await this.resolveCoord(origin, opts.city, env, degraded)
      const destCoord = await this.resolveCoord(destination, opts.cityd ?? opts.city, env, degraded)
      if (!originCoord || !destCoord) {
        throw EngineError.unavailable('directionTransit 需要经纬度坐标：地名前置地理编码失败', 'amap')
      }
      const data = await this.rest<{ route?: unknown }>(
        'direction/transit/integrated',
        {
          origin: originCoord,
          destination: destCoord,
          extensions: 'all',
        },
        opts.kind ?? 'rest',
        env,
        CACHE_TTL_SHORT_MS,
      )
      const transits = ((data as Record<string, unknown>).route as Record<string, unknown> | undefined)?.transits ?? []
      const normalized = (transits as Array<Record<string, unknown>>).map(normalizeTransitRoute)
      return { routes: normalized, options: toCityTransferOptions(normalized), degraded }
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      throw err
    }
  }

  /**
   * 地名/坐标 → "lng,lat"（transit 入参形态）：坐标串直传；地名经内部
   * geocode（city 消歧提示）解析。失败记 degraded 并返回 undefined（不抛）。
   */
  private async resolveCoord(
    value: string,
    city: string | undefined,
    env: KeyResolutionEnv | undefined,
    degraded: DegradedEntry[],
  ): Promise<string | undefined> {
    if (isCoordinateString(value)) return value.trim()
    try {
      const { coords } = await this.geocode(value, city, env)
      if (!coords) {
        degraded.push(this.emptyDegraded(`地名「${value}」地理编码无结果`))
        return undefined
      }
      return `${coords.lng},${coords.lat}`
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      return undefined
    }
  }

  /** 天气（forecast 4 天 → AdviceWeatherEntry[]）。 */
  async weather(city: string, env?: KeyResolutionEnv): Promise<{ entries: AdviceWeatherEntry[]; degraded: DegradedEntry[] }> {
    const degraded: DegradedEntry[] = []
    try {
      const data = await this.rest<{ forecasts?: unknown }>('weather/weatherInfo', { city, extensions: 'all' }, 'rest', env, CACHE_TTL_SHORT_MS)
      const casts = (data.forecasts as Array<Record<string, unknown>> | undefined)?.[0]?.casts
      const entries = normalizeWeatherCasts(casts)
      if (!entries.length) degraded.push(this.emptyDegraded('天气无预报数据'))
      return { entries, degraded }
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      throw err
    }
  }

  /** 距离矩阵（驾车 type=2 / 直线 type=1，官方口径：1=直线、2=驾车导航；时长秒→分钟）。 */
  async distanceMatrix(
    origins: GeoCoords[],
    destinations: GeoCoords[],
    opts: { driving?: boolean } = {},
    env?: KeyResolutionEnv,
  ): Promise<{ pairs: Array<{ originIndex: number; destinationIndex: number; distanceMeters: number; durationMinutes: number }>; degraded: DegradedEntry[] }> {
    const degraded: DegradedEntry[] = []
    if (origins.length === 0 || destinations.length === 0) return { pairs: [], degraded }
    try {
      const pairs: Array<{ originIndex: number; destinationIndex: number; distanceMeters: number; durationMinutes: number }> = []
      // 高德 distance 的 HTTP 边界要求单数 destination；内部仍接受多 destination，
      // 每次请求后把本地 dest_id=0 重映射回调用方原始索引。
      for (const [destinationIndex, destination] of destinations.entries()) {
        const data = await this.rest<{ results?: unknown }>(
          'distance',
          {
            origins: origins.map((c) => `${formatAmapCoord(c.lng)},${formatAmapCoord(c.lat)}`).join('|'),
            destination: `${formatAmapCoord(destination.lng)},${formatAmapCoord(destination.lat)}`,
            type: opts.driving ? '2' : '1',
          },
          'rest',
          env,
          CACHE_TTL_SHORT_MS,
        )
        for (const pair of normalizeDistanceMatrix(data.results)) {
          pairs.push({ ...pair, destinationIndex })
        }
      }
      return { pairs, degraded }
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      throw err
    }
  }

  /** 地理编码 → GCJ-02 + district（P0-A R1；district 缺失 = undefined 不猜行政区），30 天缓存。 */
  async geocode(address: string, city?: string, env?: KeyResolutionEnv): Promise<{ coords?: GeoCoords; district?: string; degraded: DegradedEntry[] }> {
    const degraded: DegradedEntry[] = []
    try {
      const data = await this.rest<{ geocodes?: unknown }>(
        'geocode/geo',
        { address, city: city ?? '', output: 'JSON' },
        'rest',
        env,
        CACHE_TTL_LONG_MS,
      )
      const coords = normalizeGeocode(data.geocodes)
      // geocodes[0].district 可选回报：上级缺失 → undefined，绝不猜测行政区。
      const geocodes = Array.isArray(data.geocodes) ? data.geocodes as Array<Record<string, unknown>> : []
      const district = typeof geocodes[0]?.district === 'string' && geocodes[0].district.length > 0
        ? geocodes[0].district
        : undefined
      if (!coords) degraded.push(this.emptyDegraded('地理编码无结果'))
      return district !== undefined ? { coords, district, degraded } : { coords, degraded }
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      throw err
    }
  }

  /** POI 补充位（ADR-3 降级角色；POI 预算 ≤40；30 天缓存）。 */
  async poiSearch(
    keywords: string,
    city: string,
    opts: { category?: IntelItem['category']; pageSize?: number } = {},
    env?: KeyResolutionEnv,
  ): Promise<{ items: IntelItem[]; degraded: DegradedEntry[] }> {
    const degraded: DegradedEntry[] = []
    try {
      const batches = splitAmapPoiKeywordBatches(keywords)
      if (batches.length === 0) throw EngineError.unavailable('参数错误：POI keywords 为空', 'amap')
      const pageSize = opts.pageSize ?? 10
      const poisByKey = new Map<string, Record<string, unknown>>()
      for (const batch of batches) {
        const data = await this.rest<{ pois?: unknown }>(
          'place/text',
          { keywords: batch, city, citylimit: 'true', offset: String(pageSize), page: '1', extensions: 'base' },
          'poi',
          env,
          CACHE_TTL_LONG_MS,
        )
        const pois = (data.pois ?? []) as Array<Record<string, unknown>>
        for (const poi of pois) {
          const key = String(poi.id ?? `${String(poi.name ?? '')}|${String(poi.location ?? '')}`)
          if (!poisByKey.has(key)) poisByKey.set(key, poi)
        }
      }
      const items: IntelItem[] = [...poisByKey.values()].slice(0, pageSize).map((poi, i) => {
        const loc = String(poi.location ?? '').split(',')
        const lng = Number(loc[0])
        const lat = Number(loc[1])
        return {
          id: `amap-poi-${String(poi.id ?? i)}`,
          category: opts.category ?? 'attraction',
          channel: 'web',
          title: String(poi.name ?? ''),
          summary: [poi.address, poi.type, poi.business_area].filter(Boolean).join('；'),
          coords: Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat, sys: 'GCJ02' } : undefined,
          confidence: 'medium',
          source: {
            platform: 'amap-poi',
            url: `${AMAP_API_BASE}/place/text`,
            fetchedAt: new Date().toISOString(),
          },
        }
      })
      return { items, degraded }
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
      throw err
    }
  }

  // ────────────────────────── 内部 ──────────────────────────

  private async rest<T>(
    endpoint: string,
    params: Record<string, string>,
    kind: 'poi' | 'rest',
    env: KeyResolutionEnv | undefined,
    ttlMs: number,
  ): Promise<T> {
    // M3.3 只观测埋点：logical=业务调用（quota 门控前计；quota-acquire-before-cache 语义原样）
    this.usage.recordAmapLogical()
    const key = await this.resolveChainKey(AMAP_KEY, env)
    if (!key) throw EngineError.unavailable('Key 未配置', 'amap')
    const quota = this.quota.acquire(kind)
    if (!quota.ok) throw EngineError.unavailable(`权限/配额：${quota.reason ?? '配额熔断'}`, 'amap')
    this.usage.recordAmapQuota(kind)

    const ckey = cacheKey(endpoint, params)
    const cached = this.cache.get(ckey)
    if (cached !== undefined) {
      this.usage.recordCache(this.name, true)
      return cached as T
    }
    this.usage.recordCache(this.name, false)
    this.usage.recordNetwork(this.name)

    const qs = new URLSearchParams({ ...params, key: key.value }).toString()
    const url = `${AMAP_API_BASE}/${endpoint}?${qs}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const res = await Promise.race([
      this.fetchFn(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(EngineError.timeout(`amap ${endpoint} 超时（${this.timeoutMs}ms）`, 'amap')), this.timeoutMs)
      }),
    ]).finally(() => { if (timer) clearTimeout(timer) })

    if (!res.ok) {
      const kindLabel = res.status === 401 || res.status === 403 || res.status === 429 ? '权限/配额' : '服务错误'
      throw EngineError.unavailable(`${kindLabel}：amap HTTP ${res.status}`, 'amap')
    }
    const body = JSON.parse(await res.text()) as Record<string, unknown>
    if (body.status !== '1') {
      const info = String(body.info ?? body.infocode ?? '未知')
      const kindLabel = classifyAmapApiFailure(info)
      throw EngineError.unavailable(`${kindLabel}：amap ${endpoint} 拒绝：${info}`, 'amap')
    }
    this.cache.set(ckey, body, ttlMs)
    return body as T
  }

  private toDegradedEntry(err: unknown, env: KeyResolutionEnv | undefined): DegradedEntry {
    const entry = err instanceof EngineError
      ? toDegraded(this.name, err)
      : toDegraded(this.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err))
    // M3.3 只观测：degraded 按 source × code 聚合进 usage（不改记账语义）
    this.usage.recordDegraded(this.name, entry.code)
    return entry
  }

  /** EMPTY 降级记账 + usage 聚合（本适配器内的确定性无结果分支）。 */
  private emptyDegraded(reason: string): DegradedEntry {
    this.usage.recordDegraded(this.name, 'EMPTY')
    return toDegraded(this.name, 'EMPTY', reason)
  }
}