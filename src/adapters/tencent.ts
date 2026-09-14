/**
 * 腾讯 map-assistant 适配器（M1 T3 / W2a 适配器 α 双件之一）。
 *
 * 渠道（design §5.4 行 375-394「腾讯 POI 补充」+ docs/research/workbuddyskills.md
 * 深度核验节 tencentmap-map-assistant）：
 * - 体验通道 `h5gw.map.qq.com` 零 key 开箱即用（key=none + apptag + output=jsonp，
 *   响应为 JSONP 包裹，需解包）；官方声明额度和稳定性受限。
 * - 正式 TMAP key 切换位经 base.ts resolveKey 链（settings→credentials→env，
 *   ADR-12）：命中则走正式通道 `apis.map.qq.com`（key=已解析值）。
 *
 * 归一化（design §5.5 / base.ts）：
 * - poi_search/poi_nearby → IntelItem[]（star_level→rating、avg_price→avgPrice、
 *   opening_hours→openingHours；-1/空值按缺失丢弃；坐标原生 GCJ-02 直落）
 * - weather(future) → AdviceWeatherEntry[]（5 天预报；温度区间/昼夜文案）
 * - distance_matrix → 行元素 {distanceMeters, durationMinutes}（秒→分）
 * - travel_guide → A2A SSE 长连接（≤120s）→ 多日行程结构化条目（tips/坐标/poi_uid）
 *
 * 错误契约：一切异常统一 EngineError（UNALIVABLE/TIMEOUT/EMPTY），不抛裸异常；
 * 工具层（W3 fan-out）捕获后经 base.ts toDegraded 记账。
 */
import {
  BaseAdapter, CAP_ZERO_KEY, EngineError, toEngineError, toGcj02, toIsoTimestamp,
  secondsToMinutes,
  type CanonicalResult, type KeyResolutionEnv, type ResolvedKey,
} from './base.js'
import type { AdviceWeatherEntry, GeoCoords, IntelCategory, IntelItem, RouteGeometry, SourceRef } from '../models/types.js'
import { gcj02ToWgs84 } from './amap.js'

// ────────────────────────── 外部依赖注入面（离线可测） ──────────────────────────

export interface HttpResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

/** HTTP 调用注入（缺省足迹 global fetch + AbortSignal.timeout；单测注入 fixture）。 */
export interface HttpCallInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
}

export type HttpCallFn = (url: string, init: HttpCallInit, signal?: AbortSignal) => Promise<HttpResponseLike>

export const defaultHttpCall: HttpCallFn = (url, init, signal) => {
  return globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: signal ?? AbortSignal.timeout(init.timeoutMs),
  })
}

// ────────────────────────── 常量与原始响应形态 ──────────────────────────

const H5GW_BASE = 'https://h5gw.map.qq.com'      // 体验通道（零 key）
const WS_BASE = 'https://apis.map.qq.com'        // 正式 key 通道
const RICH_ADDED_FIELDS = 'star_level,avg_price,opening_hours'
const DEFAULT_TIMEOUT_MS = 20_000
const A2A_TIMEOUT_MS = 120_000
const A2A_URL = `${H5GW_BASE}/aichat/v1/a2a`

/** 体验通道每 path 的专用 apptag（来源：tmap_client.py _APPTAG_MAP）。 */
const APPTAG: Readonly<Record<string, string>> = {
  '/ws/place/v1/search': 'h5mutipos_place_search',
  '/ws/place/v1/detail': 'lbsplace_detail',
  '/ws/distance/v1/matrix': 'lbsdistance_matrix',
  '/ws/direction/v1/driving/': 'lbsdirection_driving',
  '/ws/weather/v1': 'lbs_weather',
}

/** JSONP 解包：已是 JSON 直通；否则取 `name&&callback({...});` 括号内正文。 */
export function unwrapJsonp(text: string): string {
  const t = text.trim().replace(/\r/g, '')
  try {
    JSON.parse(t)
    return t
  } catch {
    // 非纯 JSON → 尝试 JSONP 壳
  }
  const m = /^[a-zA-Z_$][\w$]*&&[a-zA-Z_$][\w$]*\((.*)\);?\s*$/s.exec(t)
  if (m) return m[1]
  const open = t.indexOf('(')
  const close = t.lastIndexOf(')')
  if (open >= 0 && close > open) return t.slice(open + 1, close)
  return t
}

/** 原始响应低层接口（字段名以实测为准；未知字段忽略，不做 any 化）。 */
export interface TencentRawResponse {
  status: number
  message?: string
  count?: number
  data?: unknown[]
  result?: unknown
}

// ────────────────────────── 窄化助手（无 any） ──────────────────────────

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

// ────────────────────────── Canonical 输出类型 ──────────────────────────

/** 距离矩阵行元素（duration 秒→分钟归一化；distance 保留米整型）。 */
export interface DistanceMatrixElement {
  toIndex: number
  distanceMeters: number
  durationMinutes: number
}

export interface DistanceMatrixRow {
  fromIndex: number
  elements: DistanceMatrixElement[]
}

export interface TencentDistanceMatrixResult {
  mode: string
  from: string[]
  to: string[]
  rows: DistanceMatrixRow[]
}

export interface TencentDrivingRoute {
  distanceMeters: number
  durationMinutes: number
  geometry?: RouteGeometry
}

/**
 * 腾讯路线 polyline：原始数组是 [lat1,lng1,…]，每一对从上一点做 1e6
 * 前向差分；polyline_idx 是数组下标元数据，不是点数，也不参与 E5/E6 解码。
 */
export function decodeTencentPolyline(value: unknown): Array<[number, number]> {
  const raw = Array.isArray(value) ? value : []
  const numbers: number[] = []
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      numbers.push(item)
    } else if (Array.isArray(item) && item.length >= 2) {
      const lat = Number(item[0])
      const lng = Number(item[1])
      if (Number.isFinite(lat) && Number.isFinite(lng)) numbers.push(lat * 1e6, lng * 1e6)
    }
  }
  const points: Array<[number, number]> = []
  let lat = 0
  let lng = 0
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    lat += numbers[i] / 1e6
    lng += numbers[i + 1] / 1e6
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    const [wgsLng, wgsLat] = gcj02ToWgs84(lng, lat)
    const point: [number, number] = [wgsLng, wgsLat]
    const prior = points.at(-1)
    if (prior === undefined || prior[0] !== point[0] || prior[1] !== point[1]) points.push(point)
  }
  return points
}

/** 腾讯 driving route → canonical WGS84 GeoJSON；缺 polyline 时保留 queried 指标。 */
export function normalizeTencentDrivingRoute(value: unknown): TencentDrivingRoute | undefined {
  const route = rec(value)
  if (route === undefined) return undefined
  const distance = num(route.distance)
  const duration = num(route.duration)
  if (distance === undefined || distance < 0 || duration === undefined || duration < 0) return undefined
  const points = decodeTencentPolyline(route.polyline)
  const geometry: RouteGeometry | undefined = points.length >= 2
    ? {
        type: 'LineString', coordinates: points, source: 'tencent-direction',
        coordinateSystem: 'WGS84', pointOrder: 'lng,lat',
      }
    : undefined
  return {
    distanceMeters: distance,
    durationMinutes: secondsToMinutes(duration),
    ...(geometry !== undefined ? { geometry } : {}),
  }
}

/** 天气（future）：region/updateTime + 逐日 AdviceWeatherEntry。 */
export interface TencentWeatherResult {
  region: string
  updateTime: string
  days: AdviceWeatherEntry[]
}

/** travel_guide 条目（image/深链已按脱敏纪律丢弃）。 */
export interface TravelGuideItem {
  name: string
  desc: string
  position?: string
  poiId?: string
  coords?: GeoCoords
  review?: string
  tips: string[]
  city?: string
}

export interface TravelGuideDay {
  day: number
  title: string
  desc?: string
  items: TravelGuideItem[]
}

export interface TencentTravelGuideResult {
  summaryTitle: string
  summaryDesc?: string
  days: TravelGuideDay[]
}

// ────────────────────────── 适配器 ──────────────────────────

export interface TencentMapAdapterOptions {
  /** HTTP 调用注入（测试用）。 */
  httpCall?: HttpCallFn
  /** Key 解析链环境（settings 位 W6 接线；credentials→env 立即可用）。 */
  keyEnv?: KeyResolutionEnv
  /** Key 名（缺省 TMAP_KEY，与 map-assistant 生态一致）。 */
  keyName?: string
}

/** POI 查询参数（Canonical：业务语义，无源特有参数）。 */
export interface TencentPoiQuery {
  keywords: string
  /** 城市/区域名（与 location 二选一）。 */
  region?: string
  /** 中心点坐标（"lat,lng"，与 region 二选一）。 */
  location?: string
  /** 周边半径（米；poiNearby 用，默认 1000，官方上限 1000）。 */
  radiusMeters?: number
  pageSize?: number
  pageIndex?: number
}

export class TencentMapAdapter extends BaseAdapter {
  private readonly httpCall: HttpCallFn
  private readonly keyEnv: KeyResolutionEnv | undefined
  private readonly keyName: string
  private readonly timeoutMs: number

  constructor(options: TencentMapAdapterOptions = {}) {
    super('tencent-map', { supports: new Set([CAP_ZERO_KEY]) })
    this.httpCall = options.httpCall ?? defaultHttpCall
    this.keyEnv = options.keyEnv
    this.keyName = options.keyName ?? 'TMAP_KEY'
    this.timeoutMs = DEFAULT_TIMEOUT_MS
  }

  /** 零 key 体验通道常开；正式 key 命中与否只影响稳定性/额度，不阻塞可用性。 */
  async available(_env?: KeyResolutionEnv): Promise<boolean> {
    return true
  }

  /**
   * 正式 TMAP key 切换位：settings→credentials→env 解析（ADR-12），未命中=体验通道。
   * **热读语义**（design §10.1 ADR-12 行 698）：每次调用即时解析，不做跨调用缓存——
   * 改 key（settings/credentials/env 任一）后下一次调用立刻生效。keyEnv 由
   * makeKeyEnv(ctx) 注入（settings 快照/credentials 服务/process.env 均热读取）。
   */
  async resolveKeyOnce(env?: KeyResolutionEnv): Promise<ResolvedKey | undefined> {
    return this.resolveChainKey(this.keyName, env ?? this.keyEnv)
  }

  // ── POI：poi_search / poi_nearby → IntelItem[] ──

  async poiSearch(query: TencentPoiQuery): Promise<CanonicalResult<IntelItem[]>> {
    return this.poiRequest({ ...query, radiusMeters: undefined })
  }

  async poiNearby(query: TencentPoiQuery): Promise<CanonicalResult<IntelItem[]>> {
    if (!query.location) {
      throw EngineError.unavailable('poi_nearby 需要 location（"lat,lng"）', this.name)
    }
    return this.poiRequest(query)
  }

  private async poiRequest(query: TencentPoiQuery): Promise<CanonicalResult<IntelItem[]>> {
    if (!query.keywords) {
      throw EngineError.unavailable('POI 搜索关键词为空', this.name)
    }
    try {
      const radius = query.radiusMeters === undefined ? 1000 : Math.min(1000, Math.max(10, query.radiusMeters))
      const boundary = query.location
        ? `nearby(${query.location},${radius},1)`
        : `region(${query.region ?? ''},0)`
      const params: Record<string, string> = {
        keyword: query.keywords,
        boundary,
        page_size: String(Math.min(query.pageSize ?? 10, 20)),
        page_index: String(query.pageIndex ?? 1),
        get_rich: '1',
        added_fields: RICH_ADDED_FIELDS,
      }
      const raw = await this.wsGet<TencentRawResponse>('/ws/place/v1/search', params)
      const items = (raw.data ?? [])
        .map((entry) => toPoiIntel(entry, this.name))
        .filter((item): item is IntelItem => item !== undefined)
      if (items.length === 0) {
        throw EngineError.empty(`POI 搜索「${query.keywords}」无结果`, this.name)
      }
      return { data: items, source: tencentSource(`place/search?keyword=${encodeURIComponent(query.keywords)}`) }
    } catch (err) {
      throw this.asEngineError(err, `POI 搜索「${query.keywords}」失败`)
    }
  }

  // ── weather：future 5 天预报 → TencentWeatherResult ──

  async weather(query: { adcode?: string; location?: string }): Promise<CanonicalResult<TencentWeatherResult>> {
    if (!query.adcode && !query.location) {
      throw EngineError.unavailable('weather 需要 adcode 或 location', this.name)
    }
    try {
      const params: Record<string, string> = { type: 'future' }
      if (query.adcode) params.adcode = query.adcode
      if (query.location) params.location = query.location
      const raw = await this.wsGet<TencentRawResponse>('/ws/weather/v1', params)
      const result = rec(raw.result)
      const forecast = arr(result?.forecast) ?? []
      const regionRow = rec(forecast[0])
      const region = [
        str(regionRow?.province), str(regionRow?.city), str(regionRow?.district),
      ].filter((v): v is string => v !== undefined).join('')
      const updateTime = str(regionRow?.update_time)
      const infos = arr(regionRow?.infos) ?? []
      const days = infos
        .map((info) => toWeatherEntry(info))
        .filter((entry): entry is AdviceWeatherEntry => entry !== undefined)
      if (days.length === 0) {
        throw EngineError.empty('天气预报为空', this.name)
      }
      const source = tencentSource(`weather?adcode=${query.adcode ?? ''}&type=future`)
      return {
        data: {
          region,
          updateTime: updateTime ? normalizeWeatherUpdateTime(updateTime) : '',
          days,
        },
        source,
      }
    } catch (err) {
      throw this.asEngineError(err, '天气查询失败')
    }
  }

  // ── direction/driving ──

  /** 腾讯方向备链：响应指标单位米/秒，polyline 在 host 侧还原并转 WGS84。 */
  async directionDriving(query: {
    from: GeoCoords
    to: GeoCoords
  }, env?: KeyResolutionEnv): Promise<CanonicalResult<TencentDrivingRoute>> {
    try {
      const raw = await this.wsGet<TencentRawResponse>('/ws/direction/v1/driving/', {
        from: `${query.from.lat},${query.from.lng}`,
        to: `${query.to.lat},${query.to.lng}`,
      }, env)
      const routeList = arr(rec(raw.result)?.routes) ?? []
      const route = normalizeTencentDrivingRoute(routeList[0])
      if (route === undefined) throw EngineError.empty('腾讯 direction/driving 无有效路线', this.name)
      return {
        data: route,
        source: tencentSource('direction/driving'),
      }
    } catch (err) {
      throw this.asEngineError(err, '腾讯方向路线查询失败')
    }
  }

  // ── distance_matrix ──

  async distanceMatrix(query: {
    from: string[]
    to: string[]
    mode?: 'driving' | 'walking' | 'bicycling'
  }, env?: KeyResolutionEnv): Promise<CanonicalResult<TencentDistanceMatrixResult>> {
    if (query.from.length === 0 || query.to.length === 0) {
      throw EngineError.unavailable('distance_matrix 需要非空的 from/to 坐标列表', this.name)
    }
    try {
      const mode = query.mode ?? 'driving'
      const raw = await this.wsGet<TencentRawResponse>('/ws/distance/v1/matrix', {
        mode,
        from: query.from.join(';'),
        to: query.to.join(';'),
      }, env)
      const result = rec(raw.result)
      const rawRows = arr(result?.rows) ?? []
      const rows: DistanceMatrixRow[] = rawRows.map((row, fromIndex) => {
        const elements = (arr(rec(row)?.elements) ?? []).map((el, toIndex) => {
          const distanceMeters = int(rec(el)?.distance) ?? 0
          const durationMinutes = secondsToMinutes(num(rec(el)?.duration) ?? 0)
          return { toIndex, distanceMeters, durationMinutes }
        })
        return { fromIndex, elements }
      })
      if (rows.length === 0) {
        throw EngineError.empty('距离矩阵为空', this.name)
      }
      return {
        data: { mode, from: query.from, to: query.to, rows },
        source: tencentSource(`distance/matrix?mode=${mode}`),
      }
    } catch (err) {
      throw this.asEngineError(err, '距离矩阵查询失败')
    }
  }

  // ── travel_guide：A2A SSE 长连接（≤120s） → 多日行程 ──

  async travelGuide(query: { text: string; lat?: number; lng?: number }): Promise<CanonicalResult<TencentTravelGuideResult>> {
    if (!query.text) {
      throw EngineError.unavailable('travel_guide 需要非空文本', this.name)
    }
    try {
      const nonce = randomHex(16)
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: query.text }],
            metadata: {
              brand: 'oppo',
              device_id: `skill-${nonce}`,
              latitude: query.lat ?? 30.572815,
              longitude: query.lng ?? 104.066801,
              osVersion: '16.1',
              theme: 'light',
              traceId: nonce,
            },
          },
        },
      }
      const url = `${A2A_URL}?key=none&apptag=lbs_ai_chat_a2a`
      const response = await this.httpCall(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        timeoutMs: A2A_TIMEOUT_MS,
      })
      const body = response.ok ? await response.text() : ''
      const data = parseA2aSse(body)
      if (data.days.length === 0) {
        throw EngineError.empty('travel_guide 未产出行程（A2A 无 plan_day 事件）', this.name)
      }
      return { data, source: tencentSource('aichat/v1/a2a?key=none') }
    } catch (err) {
      throw this.asEngineError(err, 'travel_guide 生成失败')
    }
  }

  // ── 底层：通道选择 + JSONP 解包 + status 校验 ──

  private async wsGet<T extends TencentRawResponse>(path: string, params: Record<string, string>, env?: KeyResolutionEnv): Promise<T> {
    const resolved = await this.resolveKeyOnce(env)
    if (resolved) {
      // 正式通道：apis.map.qq.com，key=已解析值（settings→credentials→env）
      const qs = new URLSearchParams({ ...params, key: resolved.value }).toString()
      const response = await this.httpCall(`${WS_BASE}${path}?${qs}`, { timeoutMs: this.timeoutMs })
      return parseRawResponse<T>(response, path, this.name)
    }
    // 体验通道：h5gw，key=none + apptag + jsonp
    const apptag = APPTAG[path] ?? 'lbs'
    const qs = new URLSearchParams({ ...params, key: 'none', apptag, output: 'jsonp', callback: 'cb' }).toString()
    const response = await this.httpCall(`${H5GW_BASE}${path}?${qs}`, { timeoutMs: this.timeoutMs })
    return parseRawResponse<T>(response, path, this.name)
  }

  /** 统一归一化错误：EngineError 直通；超时→TIMEOUT；其余→UNAVAILABLE。 */
  private asEngineError(err: unknown, fallback: string): EngineError {
    if (err instanceof EngineError) return err
    const message = err instanceof Error ? err.message : String(err)
    if (/Timeout|Abort/i.test(message)) {
      return EngineError.timeout(`${fallback}（超时：${message}）`, this.name)
    }
    return EngineError.unavailable(`${fallback}（${message}）`, this.name)
  }
}

// ────────────────────────── 归一化纯函数（可单测直连） ──────────────────────────

/** 低层响应 → 校验过的 {status,data,result}；HTTP 非 2xx / status≠0 → EngineError。 */
export async function parseRawResponse<T extends TencentRawResponse>(
  response: HttpResponseLike, path: string, source: string,
): Promise<T> {
  const raw = unwrapJsonp(await response.text())
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // 非 JSON（网关/风控页）→ UNAVAILABLE
    throw EngineError.unavailable(`腾讯地图 ${path} 响应非 JSON（HTTP ${response.status}）`, source)
  }
  const body = rec(data)
  if (!body) {
    throw EngineError.unavailable(`腾讯地图 ${path} 响应结构异常`, source)
  }
  const status = num(body.status)
  if (status !== 0) {
    const message = str(body.message) ?? 'unknown error'
    throw EngineError.unavailable(`腾讯地图 ${path} 返回 status=${String(status ?? '?')}：${message}`, source)
  }
  return data as T
}

/** POI 原始条目 → IntelItem（字段映射 + 空值清洗 + 坐标 GCJ-02 直落）。 */
export function toPoiIntel(raw: unknown, sourceName: string): IntelItem | undefined {
  const poi = rec(raw)
  if (!poi) return undefined
  const title = str(poi.title)
  if (!title) return undefined

  const location = rec(poi.location)
  const lat = num(location?.lat)
  const lng = num(location?.lng)
  const coords: GeoCoords | undefined =
    lat !== undefined && lng !== undefined ? { lng, lat, sys: 'GCJ02' } : undefined

  const rating = num(poi.star_level)
  const avgRaw = num(poi.avg_price)
  const avgPrice = avgRaw !== undefined && avgRaw >= 0 ? avgRaw : undefined // -1=未知，按缺失
  const openingHours = str(poi.opening_hours)
  const id = str(poi.id) ?? title
  const categoryRaw = str(poi.category)
  const address = str(poi.address)
  const category = classifyPoiCategory(categoryRaw, title)
  const adInfo = rec(poi.ad_info)
  const adcode = num(adInfo?.adcode)
  // P0-A R1：把 ad_info 的 province/city/district 组装成行政区串随条目返回，供 resolve
  // 地域一致性判定（与 weather region 拼接同构：源回报哪几级就拼接哪几级——有市无
  // 区时如「浙江省杭州市」，不凭空猜第三级；三级全缺 → undefined）。
  const district = [
    str(adInfo?.province), str(adInfo?.city), str(adInfo?.district),
  ].filter((v): v is string => v !== undefined).join('') || undefined

  const facts: string[] = []
  if (address) facts.push(`地址：${address}`)
  if (categoryRaw) facts.push(`分类：${categoryRaw}`)
  if (rating !== undefined) facts.push(`评分：${rating}`)
  if (avgPrice !== undefined) facts.push(`人均：${avgPrice} 元`)
  if (openingHours) facts.push(`营业时间：${openingHours}`)

  return {
    id: `tencent-poi:${id}`,
    category,
    channel: 'tencent-poi',
    title,
    summary: facts.length > 0 ? facts.join('；') : title,
    source: tencentSource(`place/search?id=${id}${adcode !== undefined ? `&adcode=${adcode}` : ''}`),
    coords,
    rating,
    avgPrice,
    openingHours,
    ...(district !== undefined ? { district } : {}),
    confidence: 'high',
  }
}

/** 分类启发：美食/景点/住宿/交通 → §5.5 category；无法判定归 recommend。 */
export function classifyPoiCategory(categoryRaw: string | undefined, title: string): IntelCategory {
  const hay = `${categoryRaw ?? ''} ${title}`
  if (/美食|餐厅|小吃|火锅|咖啡|面馆|外卖/.test(hay)) return 'food'
  if (/酒店|宾馆|民宿|客栈|住宿|青旅/.test(hay)) return 'lodging'
  if (/景点|风景|公园|博物馆|寺庙|名胜|景区|乐园/.test(hay)) return 'attraction'
  if (/交通|车站|地铁|公交|机场|码头|停车场/.test(hay)) return 'transportLocal'
  return 'recommend'
}

function toWeatherEntry(raw: unknown): AdviceWeatherEntry | undefined {
  const info = rec(raw)
  if (!info) return undefined
  const date = str(info.date)
  if (!date) return undefined
  const day = rec(info.day)
  const night = rec(info.night)
  const dayWeather = str(day?.weather)
  const nightWeather = str(night?.weather)
  const dayTemp = num(day?.temperature)
  const nightTemp = num(night?.temperature)
  const temps = ([dayTemp, nightTemp]).filter((t): t is number => t !== undefined)
  const dayForecast = [
    dayWeather ? `白天 ${dayWeather}` : undefined,
    dayTemp !== undefined ? `${dayTemp}℃` : undefined,
    nightWeather ? `夜间 ${nightWeather}` : undefined,
    nightTemp !== undefined ? `${nightTemp}℃` : undefined,
  ].filter((v): v is string => v !== undefined).join(' / ')
  const tempRange: [number, number] | undefined = temps.length >= 2
    ? [Math.min(...temps), Math.max(...temps)]
    : undefined
  return {
    date,
    dayForecast: dayForecast || undefined,
    tempRange,
    source: tencentSource(`weather?date=${date}`),
  }
}

/** 天气 update_time（"YYYY-MM-DD HH:mm"，东八区）→ UTC ISO8601。 */
export function normalizeWeatherUpdateTime(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const hasTz = /[Z+-]\d{2}:?\d{2}$/.test(normalized)
  if (hasTz) return new Date(normalized).toISOString()
  const hasSeconds = /:\d{2}$/.test(normalized)
  return new Date(`${normalized}${hasSeconds ? '' : ':00'}+08:00`).toISOString()
}

/** A2A SSE → 聚合 {summary, days}（plan_summary/plan_day artifacts）。 */
export function parseA2aSse(text: string): TencentTravelGuideResult {
  let summaryTitle = ''
  let summaryDesc: string | undefined
  const days: TravelGuideDay[] = []
  for (const block of text.split('\n\n')) {
    const dataLines = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(dataLines.join('\n'))
    } catch {
      continue // 非 JSON 事件（heartbeat 等）忽略
    }
    const result = rec(rec(event)?.result)
    if (result?.kind !== 'artifact-update') continue
    const artifact = rec(result.artifact)
    const name = str(artifact?.name)
    for (const partRaw of arr(artifact?.parts) ?? []) {
      const part = rec(partRaw)
      if (!part || !('data' in part)) continue
      if (name === 'plan_summary') {
        const summary = rec(part.data)
        summaryTitle = str(summary?.summary_title) ?? ''
        summaryDesc = str(summary?.summary_desc)
      } else if (name === 'plan_day') {
        const day = parseTravelGuideDay(part.data)
        if (day) days.push(day)
      }
    }
  }
  return { summaryTitle, summaryDesc, days }
}

function parseTravelGuideDay(raw: unknown): TravelGuideDay | undefined {
  const data = rec(raw)
  if (!data) return undefined
  const items = (arr(data.items) ?? [])
    .map((rawItem) => toTravelGuideItem(rawItem))
    .filter((item): item is TravelGuideItem => item !== undefined)
  const day = int(data.day)
  if (day === undefined) return undefined
  return {
    day,
    title: str(data.day_title) ?? `第${day}天`,
    desc: str(data.day_desc),
    items,
  }
}

function toTravelGuideItem(raw: unknown): TravelGuideItem | undefined {
  const item = rec(raw)
  if (!item) return undefined
  const name = str(item.location_name)
  if (!name) return undefined
  const lat = num(item.latitude)
  const lng = num(item.longitude)
  const coords = lat !== undefined && lng !== undefined ? toGcj02(lng, lat, 'GCJ02') : undefined
  const tips = (arr(item.tips) ?? [])
    .map((tip) => str(tip))
    .filter((tip): tip is string => tip !== undefined)
  return {
    name,
    desc: str(item.location_desc) ?? '',
    position: str(item.location_position),
    poiId: str(item.poi_uid),
    coords,
    review: str(item.review),
    tips,
    city: str(item.city_name),
  }
}

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2))
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n)
}

function tencentSource(queryPath: string): SourceRef {
  return {
    platform: 'tencent-map',
    url: `https://map.qq.com/?from=dsh-travel&q=${queryPath}`,
    fetchedAt: new Date().toISOString(),
  }
}