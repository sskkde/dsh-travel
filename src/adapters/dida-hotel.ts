/**
 * dida-hotel 适配器（W3 T14）：酒店只读报价渠道（可选外部源；settings channels.fr3.didaHotel
 * 默认 off → 零调用；独立 key DIDA_HOTEL_API_KEY）。
 *
 * 只读红线（deploy.md §2.1 同口径，强制）：接入仅限只读查询三件——
 * searchHotels / getHotelDetail / getHotelSearchTags；**严禁价确/订单/支付**：
 * 白名单判定为 positive whitelist（白名单之外任意工具，含交易类标识符——本文件
 * 代码零出现交易名调用）一律 assertDidaReadOnly → EngineError.UNAVAILABLE 拒绝；
 * 闸门经 rail12306 McpStreamClient 的 readOnlyGate 注入位强制（xhs.ts/didi.ts 同款模式）。
 *
 * 传输：MCP Streamable HTTP（复用 rail12306 McpStreamClient——懒初始化会话 +
 * Mcp-Session-Id 复用 + 空闲超时回收 + SSE 解析）；fetchFn 包装合并 Bearer 与
 * session headers（key 经 ADR-12 链 settings keys.didaHotel → credentials ref
 * `DIDA_HOTEL_API_KEY` → env DIDA_HOTEL_API_KEY 解析后注入）。端点经 env
 * TRAVEL_DIDAHOTEL_MCP_URL 覆盖（缺省 http://127.0.0.1:8126/mcp）。
 *
 * 可用性门：channelEnabled('didaHotel') 且 Key 已配置；缺 Key → available()=false
 * → 工具层 blocked（缺 Key 不猜测、不发起任何调用）。实时/免费声明为非已验证承诺
 * （README 口径）：报价仅为渠道快照，非最终确认价。
 */
import { BaseAdapter, EngineError, channelEnabled, resolveKey, toDegraded, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import { McpStreamClient, type FetchLike } from './rail12306.js'
import type { LodgingUnit, PriceQuote, TaxStatus } from '../models/types.js'
import { LODGING_UNITS, TAX_STATUSES } from '../models/types.js'

/** Key 标识符（resolveKey 首参；credentials 层经 env.ts CREDENTIAL_REF_MAP → ref 恒等）。 */
export const DIDA_HOTEL_KEY = 'DIDA_HOTEL_API_KEY'
/** MCP 端点覆盖环境变量。 */
export const DIDAHOTEL_MCP_URL_ENV = 'TRAVEL_DIDAHOTEL_MCP_URL'
/** 缺省端点（部署后按实际注入器配置覆盖；仅渠道开启且 Key 就绪时连接）。 */
export const DEFAULT_DIDAHOTEL_MCP_URL = 'http://127.0.0.1:8126/mcp'
/** MCP 调用超时（查询类秒级响应；缺省 10s 同 McpStreamClient 默认）。 */
export const DEFAULT_DIDAHOTEL_TIMEOUT_MS = 10_000

/**
 * 只读白名单（红线语义核心：**只挂这三个只读查询件**；positive whitelist——
 * 不在白名单内的任意工具（含价确/订单/支付任何交易类）一律拒绝，代码零交易名调用）。
 */
export const DIDA_READONLY_TOOLS: readonly string[] = [
  'searchHotels',
  'getHotelDetail',
  'getHotelSearchTags',
]

/** 交易类关键字 deny 表（防御：白名单之外的调用一律拒绝；价确/订单/支付三禁区）。 */
const TRANSACTION_KEYWORDS = /buy|pay|order|price.?confirm|booking|wait(ing)?|确认价|订单|支付|下单|预订|cancel/i

/** 白名单判定 + 交易类 deny（测试断言白名单恰为 3 只读件且无交易标识符）。 */
export function isDidaReadOnlyTool(name: string): boolean {
  return DIDA_READONLY_TOOLS.includes(name) && !TRANSACTION_KEYWORDS.test(name)
}

/** 只读断言：非白名单/交易类工具 → EngineError.UNAVAILABLE（调用前强制闸门）。 */
export function assertDidaReadOnly(name: string): void {
  if (!isDidaReadOnlyTool(name)) {
    throw EngineError.unavailable(`工具 ${name} 不在 DIDA 只读白名单（价确/订单/支付被红线拒绝）`, 'dida-hotel')
  }
}

// ────────────────────────── 归一化纯函数 ──────────────────────────

/** 酒店搜索结果（searchHotels 归一）。 */
export interface DidaHotelItem {
  hotelId: string
  name: string
  address?: string
  /** 经纬度（GCJ-02；渠道原样，缺省 undefined）。 */
  coords?: { lng: number; lat: number; sys: 'GCJ02' }
  star?: string
}

/** 酒店详情（getHotelDetail 归一；价格字段仅在渠道真实数值时出现）。 */
export interface DidaHotelDetail {
  hotelId: string
  name: string
  address?: string
  coords?: { lng: number; lat: number; sys: 'GCJ02' }
  /** 渠道真实数值（缺 → 调用方不填假区间）。 */
  price?: { min: number; max: number; currency?: string; unit?: LodgingUnit; taxStatus?: TaxStatus; cancellationPolicy?: string; bookingUrl?: string }
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 搜索响应 → DidaHotelItem[]（缺关键字段丢弃；源字段原样透出）。 */
export function normalizeHotels(raw: unknown): DidaHotelItem[] {
  const list = Array.isArray(raw) ? raw : []
  const out: DidaHotelItem[] = []
  for (const item of list) {
    const r = rec(item)
    if (r === undefined) continue
    const hotelId = str(r.hotelId ?? r.id ?? r.hotel_id)
    const name = str(r.name ?? r.hotelName ?? r.hotel_name)
    if (hotelId === undefined || name === undefined) continue
    const outItem: DidaHotelItem = { hotelId, name }
    const address = str(r.address)
    if (address !== undefined) outItem.address = address
    const star = str(r.star ?? r.starLevel ?? r.star_level)
    if (star !== undefined) outItem.star = star
    const lng = num(r.lng ?? r.longitude)
    const lat = num(r.lat ?? r.latitude)
    if (lng !== undefined && lat !== undefined) outItem.coords = { lng, lat, sys: 'GCJ02' }
    out.push(outItem)
  }
  return out
}

function asLodgingUnit(value: unknown): LodgingUnit | undefined {
  const v = String(value ?? '').trim().toLowerCase()
  return LODGING_UNITS.includes(v as LodgingUnit) ? v as LodgingUnit : undefined
}

function asTaxStatus(value: unknown): TaxStatus | undefined {
  const v = String(value ?? '').trim().toLowerCase()
  if (TAX_STATUSES.includes(v as TaxStatus)) return v as TaxStatus
  if (v === 'in' || v === '含税') return 'included'
  if (v === 'ex' || v === '不含税') return 'excluded'
  return undefined
}

/** 详情响应 → DidaHotelDetail（价格仅在真实数值时出现；缺币种/单位 → price 为 undefined）。 */
export function normalizeHotelDetail(raw: unknown): DidaHotelDetail | undefined {
  const r = rec(raw)
  if (r === undefined) return undefined
  const hotelId = str(r.hotelId ?? r.id ?? r.hotel_id)
  const name = str(r.name ?? r.hotelName ?? r.hotel_name)
  if (hotelId === undefined || name === undefined) return undefined
  const out: DidaHotelDetail = { hotelId, name }
  const address = str(r.address)
  if (address !== undefined) out.address = address
  const lng = num(r.lng ?? r.longitude)
  const lat = num(r.lat ?? r.latitude)
  if (lng !== undefined && lat !== undefined) out.coords = { lng, lat, sys: 'GCJ02' }
  const priceRec = rec(r.price ?? r.priceQuote ?? r.quote)
  if (priceRec !== undefined) {
    const min = num(priceRec.min ?? priceRec.minPrice ?? priceRec.lowest)
    const max = num(priceRec.max ?? priceRec.maxPrice ?? priceRec.highest ?? min)
    const currency = str(priceRec.currency)
    // 缺条件/单位/币种/真实数值 → 不填假区间
    if (min !== undefined && max !== undefined && min >= 0 && max >= min && currency !== undefined) {
      out.price = {
        min,
        max,
        currency,
        ...(asLodgingUnit(priceRec.unit) !== undefined ? { unit: asLodgingUnit(priceRec.unit)! } : {}),
        ...(asTaxStatus(priceRec.taxStatus ?? priceRec.tax) !== undefined
          ? { taxStatus: asTaxStatus(priceRec.taxStatus ?? priceRec.tax)! } : {}),
        ...(str(priceRec.cancellationPolicy) !== undefined ? { cancellationPolicy: str(priceRec.cancellationPolicy)! } : {}),
        ...(str(priceRec.bookingUrl) !== undefined ? { bookingUrl: str(priceRec.bookingUrl)! } : {}),
      }
    }
  }
  return out
}

/** 标签响应（searchHotels 附带标签）。 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const t of raw) {
    const s = str(rec(t)?.name ?? t)
    if (s !== undefined && !out.includes(s)) out.push(s)
  }
  return out
}

// ────────────────────────── 适配器 ──────────────────────────

export interface DidaHotelOptions {
  /** MCP 客户端注入（测试 fake）；缺省按 url/fetchFn 构造并挂 assertDidaReadOnly 闸门。 */
  mcp?: McpStreamClient
  /** MCP 端点（缺省 DEFAULT_DIDAHOTEL_MCP_URL）。 */
  url?: string
  /** fetch 注入（测试替身；缺省 global fetch）。 */
  fetchFn?: FetchLike
  timeoutMs?: number
}

export interface DidaHotelSearchQuery {
  placeId?: string
  keywords?: string
  city?: string
  lat?: number
  lng?: number
  checkIn?: string
  checkOut?: string
  adults?: number
  rooms?: number
}

export class DidaHotelAdapter extends BaseAdapter {
  readonly mcp: McpStreamClient
  /** Bearer 令牌位（每次调用经 resolveKey 解析后写入；fetchFn 包装合并 Bearer 与 session headers）。 */
  private readonly auth: { token?: string } = {}

  constructor(opts: DidaHotelOptions = {}) {
    super('dida-hotel')
    const baseFetch: FetchLike = opts.fetchFn ?? (async (input, init) => {
      const res = await fetch(input, init as RequestInit)
      return { ok: res.ok, status: res.status, text: async () => await res.text() }
    })
    // fetchFn 包装：合并 Bearer（DIDA_HOTEL_API_KEY）与 McpStreamClient 的 session headers
    const fetchFn: FetchLike = async (input, init) => {
      const headers: Record<string, string> = { ...(init?.headers ?? {}) }
      if (this.auth.token !== undefined) headers['Authorization'] = `Bearer ${this.auth.token}`
      return baseFetch(input, { ...init, headers })
    }
    this.mcp = opts.mcp ?? new McpStreamClient({
      url: opts.url ?? DEFAULT_DIDAHOTEL_MCP_URL,
      fetchFn,
      timeoutMs: opts.timeoutMs ?? DEFAULT_DIDAHOTEL_TIMEOUT_MS,
      readOnlyGate: assertDidaReadOnly,
    })
  }

  /** 可用性门：渠道开关（默认 off → 零调用）+ Key 配置（DIDA_HOTEL_API_KEY）。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('didaHotel', env)) return false
    return (await resolveKey(DIDA_HOTEL_KEY, env)) !== undefined
  }

  /** 解析 Key 并注入 Bearer；未配置 → undefined（调用方记录 blocked，不发请求）。 */
  private async resolveKeyOrUndefined(env?: KeyResolutionEnv): Promise<string | undefined> {
    const resolved = await resolveKey(DIDA_HOTEL_KEY, env)
    if (resolved === undefined) return undefined
    this.auth.token = resolved.value
    return resolved.value
  }

  /** 酒店搜索（只读 searchHotels；归一化 DidaHotelItem[]）。 */
  async searchHotels(
    query: DidaHotelSearchQuery,
    env?: KeyResolutionEnv,
  ): Promise<{ hotels: DidaHotelItem[]; degraded: DegradedEntry[] }> {
    assertDidaReadOnly('searchHotels')
    const degraded: DegradedEntry[] = []
    if (await this.resolveKeyOrUndefined(env) === undefined) {
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', 'Key 未配置（DIDA_HOTEL_API_KEY）'))
      return { hotels: [], degraded }
    }
    try {
      const resp = (await this.mcp.callTool('searchHotels', {
        ...(query.keywords !== undefined ? { keywords: query.keywords } : {}),
        ...(query.city !== undefined ? { city: query.city } : {}),
        ...(query.lat !== undefined && query.lng !== undefined
          ? { latitude: query.lat, longitude: query.lng } : {}),
        ...(query.checkIn !== undefined ? { check_in: query.checkIn } : {}),
        ...(query.checkOut !== undefined ? { check_out: query.checkOut } : {}),
        ...(query.adults !== undefined ? { adults: query.adults } : {}),
        ...(query.rooms !== undefined ? { rooms: query.rooms } : {}),
      })) as Record<string, unknown>
      const hotels = normalizeHotels(resp.hotels ?? resp.data ?? resp.result)
      if (hotels.length === 0) degraded.push(toDegraded(this.name, 'EMPTY', 'searchHotels 无结果'))
      return { hotels, degraded }
    } catch (err) {
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      return { hotels: [], degraded }
    }
  }

  /** 酒店详情（只读 getHotelDetail；价格仅真实数值时填充）。 */
  async getHotelDetail(
    hotelId: string,
    env?: KeyResolutionEnv,
  ): Promise<{ hotel?: DidaHotelDetail; degraded: DegradedEntry[] }> {
    assertDidaReadOnly('getHotelDetail')
    const degraded: DegradedEntry[] = []
    if (await this.resolveKeyOrUndefined(env) === undefined) {
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', 'Key 未配置（DIDA_HOTEL_API_KEY）'))
      return { hotel: undefined, degraded }
    }
    try {
      const resp = (await this.mcp.callTool('getHotelDetail', { hotel_id: hotelId })) as Record<string, unknown>
      const hotel = normalizeHotelDetail(resp.hotel ?? resp.data ?? resp.result)
      if (hotel === undefined) degraded.push(toDegraded(this.name, 'EMPTY', 'getHotelDetail 无有效详情'))
      return { hotel, degraded }
    } catch (err) {
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      return { hotel: undefined, degraded }
    }
  }

  /** 搜索标签（只读 getHotelSearchTags；供发现词辅助）。 */
  async getHotelSearchTags(env?: KeyResolutionEnv): Promise<{ tags: string[]; degraded: DegradedEntry[] }> {
    assertDidaReadOnly('getHotelSearchTags')
    const degraded: DegradedEntry[] = []
    if (await this.resolveKeyOrUndefined(env) === undefined) {
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', 'Key 未配置（DIDA_HOTEL_API_KEY）'))
      return { tags: [], degraded }
    }
    try {
      const resp = (await this.mcp.callTool('getHotelSearchTags', {})) as Record<string, unknown>
      const tags = normalizeTags(resp.tags ?? resp.data ?? resp.result)
      return { tags, degraded }
    } catch (err) {
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      return { tags: [], degraded }
    }
  }

  /** 关闭底层 MCP 会话（长驻适配器生命周期收尾；幂等）。 */
  close(): Promise<void> {
    return this.mcp.close()
  }
}

/** 详情 → 契约 PriceQuote（缺条件/单位/币种/真实数值 → undefined 不填假区间）。 */
export function toPriceQuote(
  hotel: DidaHotelDetail,
  opts: { checkIn?: string; checkOut?: string; adults?: number; rooms?: number; observedAt: string },
): PriceQuote | undefined {
  if (hotel.price === undefined) return undefined
  const currency = hotel.price.currency
  if (currency === undefined || currency.trim() === '') return undefined
  const min = hotel.price.min
  const max = hotel.price.max
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return undefined
  return {
    range: [min, max],
    currency,
    unit: hotel.price.unit ?? 'roomNight',
    ...(opts.checkIn !== undefined ? { checkIn: opts.checkIn } : {}),
    ...(opts.checkOut !== undefined ? { checkOut: opts.checkOut } : {}),
    ...(opts.adults !== undefined ? { adults: opts.adults } : {}),
    ...(opts.rooms !== undefined ? { rooms: opts.rooms } : {}),
    observedAt: opts.observedAt,
    taxStatus: hotel.price.taxStatus ?? 'unknown',
    ...(hotel.price.cancellationPolicy !== undefined ? { cancellationPolicy: hotel.price.cancellationPolicy } : {}),
    ...(hotel.price.bookingUrl !== undefined ? { bookingUrl: hotel.price.bookingUrl } : {}),
  }
}