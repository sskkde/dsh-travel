/**
 * didi 适配器（M2.4 W5）：滴滴 MCP 市内衔接渠道二（design §2.1 行 51 / §3.5 行 124）。
 *
 * 红线（design §3.5 + roadmap M2.4 DoD）：**查询白名单只挂
 * maps_direction_transit / taxi_estimate 两个查询类工具**——交易四件
 * （下单/订单/司机位置/取消）零挂载。白名单判定为 positive whitelist：
 * 白名单之外任意工具（含交易类，标识符不做枚举、代码零出现）一律
 * assertDidiQueryOnly → EngineError.UNAVAILABLE 拒绝；闸门经 rail12306
 * McpStreamClient 的 readOnlyGate 注入位强制（W4 收编增补，xhs.ts 同款模式）。
 *
 * 传输：MCP Streamable HTTP（mcporter 通道）——**复用 rail12306 McpStreamClient**
 * （懒初始化会话 + Mcp-Session-Id 复用 + 空闲超时回收 + SSE 解析，契约锁形用例
 * tests/adapters-w4-flight.test.ts）。端点经 env TRAVEL_DIDI_MCP_URL 覆盖
 * （缺省 http://127.0.0.1:8124/mcp，部署后按实际 mcporter 桥接端点配置）。
 * DIDI_MCP_KEY 由 mcporter 上游代管鉴权——本适配器不传输 key，key 只做可用性门控。
 * Key 解析链（ADR-12）：settings keys.didi → credentials ref `DIDI_MCPKEY`
 * （合法标识符 ^[A-Za-z_][A-Za-z0-9_]*$，无斜杠——dcd01e1 宿主更名口径，
 * 斜杠 ref 曾致宿主崩溃）→ env DIDI_MCP_KEY（App 扫码获取，
 * mcp.didichuxing.com/claw，gated 交割）。Key 未配 → available()=false →
 * 工具层渠道跳过 + degraded「Key 未配置」（静默降级态）。
 *
 * 前置地理编码链（design §5.1 行 271）：模型无感——地名经注入的 geocoders
 * 链（amap geocoder → 腾讯 map-assistant POI 零 key）解析为 "lng,lat"
 * （坐标串直传，amap isCoordinateString 同款判定）；maps_direction_transit
 * 的 city 参数补"市"（"杭州市" 非 "杭州"，实测口径）。
 *
 * 输出（§5.5 cityTransfer）：transit 公共交通选项（「滴滴·」前缀）+
 * taxi_estimate 估价参考（估价不可用则省略该字段，§2.1）。响应结构化优先：
 * callToolRaw 全 payload → structuredContent → content[].text（JSON 直接解析 /
 * 自然语言正则兜底）→ 归一化。
 */
import { BaseAdapter, EngineError, channelEnabled, resolveKey, toDegraded, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import { isCoordinateString } from './amap.js'
import { McpStreamClient, type FetchLike } from './rail12306.js'
import type { CityTransferOption, GeoCoords } from '../models/types.js'

/** Key 标识符（resolveKey 首参；credentials 层经 env.ts CREDENTIAL_REF_MAP → ref `DIDI_MCPKEY`）。 */
export const DIDI_KEY = 'didi'
/** DIDI_MCP_KEY 环境名（design §3.5 / research 档案：App 扫码获取）。 */
export const DIDI_MCP_KEY_ENV = 'DIDI_MCP_KEY'
/** MCP 端点覆盖环境变量。 */
export const DIDI_MCP_URL_ENV = 'TRAVEL_DIDI_MCP_URL'
/** 缺省端点：mcporter 桥接本地口（部署后按实际配置覆盖）。 */
export const DEFAULT_DIDI_MCP_URL = 'http://127.0.0.1:8124/mcp'
/** MCP 调用超时（地图查询类秒级响应；缺省 10s 同 McpStreamClient 默认）。 */
export const DEFAULT_DIDI_TIMEOUT_MS = 10_000

/**
 * 查询白名单（红线语义核心：**只挂这两个查询类工具**；白名单判定为
 * positive——不在白名单内的任意工具（含交易类）一律拒绝，代码零交易名）。
 */
export const DIDI_QUERY_TOOLS: readonly string[] = [
  'maps_direction_transit',
  'taxi_estimate',
]

/** 白名单判定（测试断言：白名单恒等于查询双件，长度=2）。 */
export function isDidiQueryTool(name: string): boolean {
  return DIDI_QUERY_TOOLS.includes(name)
}

/** 查询白名单断言：非白名单工具 → EngineError.UNAVAILABLE（调用前强制闸门）。 */
export function assertDidiQueryOnly(name: string): void {
  if (!isDidiQueryTool(name)) {
    throw EngineError.unavailable(`工具 ${name} 不在查询白名单（非查询类调用被红线拒绝）`, 'didi')
  }
}

/** 未配原因（工具层与适配器共用同一文案）。 */
export const DIDI_KEY_MISSING_REASON = 'Key 未配置（DIDI_MCP_KEY）'

// ────────────────────────── 归一化纯函数 ──────────────────────────

/** 完整行政区后缀（城市名补"市"判定；transit 需完整城市名"杭州市"）。
 *  注意排除"州"（杭州/广州/苏州本身结尾即"州"但仍是市名，需补"市"）。 */
const ADMIN_SUFFIX = /(市|省|自治区|特别行政区|地区|盟|自治州)$/

/** 城市名补"市"：'杭州' -> '杭州市'；已含行政区后缀（'北京市'）原样返回。 */
export function ensureFullCityName(city: string): string {
  const trimmed = city.trim()
  if (trimmed.length === 0) return trimmed
  return ADMIN_SUFFIX.test(trimmed) ? trimmed : `${trimmed}市`
}

/** 结构化 transit 单方案（§5.5 CityTransferOption 前身）。 */
export interface DidiTransitOption {
  mode: string
  durationMinutes?: number
  priceHint?: string
}

/** 滴滴估价（taxi_estimate 归一：价格参考省略即缺省）。 */
export interface DidiTaxiEstimate {
  mode: string
  durationMinutes?: number
  priceHint?: string
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

function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/** 响应取文本面：content[].text 拼接，兜底裸 text 字段。 */
function extractText(structured: Record<string, unknown>): string | undefined {
  const content = arr(structured.content)
  if (content) {
    const parts: string[] = []
    for (const c of content) {
      const row = rec(c)
      const text = str(row?.text)
      if (text) parts.push(text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return str(structured.text)
}

/**
 * callToolRaw 全 payload → 业务载荷（结构化优先，research 档案实测口径）：
 * - payload.structuredContent（对象）直用——结构化面
 * - payload.content[].text：可 JSON.parse 且为对象 → 解析结果（text JSON 面，
 *   rail12306 callTool 同款语义）；否则拼接为自然语言文本包 {text}（正则兜底面）
 * - 其余原样透传（parse 函数自身也有 payload 形态兼容）
 */
function resolveToolPayload(payload: Record<string, unknown>): unknown {
  const structured = rec(payload.structuredContent)
  if (structured) return structured
  const content = arr(payload.content)
  if (content) {
    const texts: string[] = []
    for (const c of content) {
      const text = str(rec(c)?.text)
      if (text !== undefined) texts.push(text)
    }
    const joined = texts.join('\n')
    if (joined) {
      try {
        const parsed: unknown = JSON.parse(joined)
        if (rec(parsed)) return parsed
      } catch { /* 自然语言文本面 */ }
      return { text: joined }
    }
  }
  return payload
}

/**
 * maps_direction_transit 响应 → 公共交通选项（结构化优先）。入参为
 * resolveToolPayload 之后的载荷（亦兼容全 payload 形态）：
 * - structuredContent.routes[]（{scheme,duration?,price?}）
 * - routes[]（text JSON 已解析的平铺形态）
 * - 自然语言 text（正则：N 分钟 / N 元）
 */
export function parseTransitOptions(raw: unknown): DidiTransitOption[] {
  const structured = rec(raw)
  if (!structured) return []
  let routes: unknown = structured.routes
  if (routes === undefined) {
    const sc = rec(structured.structuredContent)
    if (sc) routes = sc.routes
  }
  const rows = arr(routes)
  if (rows !== undefined) {
    const out: DidiTransitOption[] = []
    for (const r of rows) {
      const row = rec(r)
      if (!row) continue
      const mode = str(row.scheme ?? row.mode ?? row.name)
      if (!mode) continue
      const duration = num(row.duration ?? row.durationMinutes ?? row.duration_minutes)
      const price = num(row.price ?? row.fee)
      out.push({
        mode,
        durationMinutes: duration !== undefined && duration >= 0 ? Math.round(duration) : undefined,
        priceHint: price !== undefined && price >= 0 ? `${price} 元` : undefined,
      })
    }
    return out.filter((o) => o.mode.length > 0)
  }
  return parseTransitText(extractText(structured) ?? '')
}

/** 自然语言 transit 文本兜底（逐行：去掉 时长/费用 数字后的行文本为方式）。 */
export function parseTransitText(text: string): DidiTransitOption[] {
  const out: DidiTransitOption[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const durationMatch = /(\d+(?:\.\d+)?)\s*分钟/.exec(line)
    const priceMatch = /(\d+(?:\.\d+)?)\s*元/.exec(line)
    const mode = line
      .replace(/(预计|约|大约|全程|耗时|票价|费用)/g, '')
      .replace(/(\d+(?:\.\d+)?)\s*分钟/g, '')
      .replace(/(\d+(?:\.\d+)?)\s*元/g, '')
      .replace(/[，。、,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!mode || /^(起点|终点|耗时|费用|时长|预计|路线|价格|票价|说明|提示)/.test(mode)) continue
    const duration = durationMatch ? Number(durationMatch[1]) : undefined
    const price = priceMatch ? Number(priceMatch[1]) : undefined
    out.push({
      mode,
      durationMinutes: duration !== undefined && duration >= 0 ? Math.round(duration) : undefined,
      priceHint: price !== undefined && price >= 0 ? `${price} 元` : undefined,
    })
  }
  return out
}

/**
 * taxi_estimate 响应 → 估价参考（结构化优先；价格/时长都无 → undefined=省略
 * 估价字段，§2.1「估价不可用则省略该字段」）。
 */
export function parseTaxiEstimate(raw: unknown): DidiTaxiEstimate | undefined {
  const structured = rec(raw)
  if (!structured) return undefined
  let price = num(structured.price ?? structured.estimate ?? structured.fee)
  let duration = num(structured.duration ?? structured.durationMinutes ?? structured.duration_minutes)
  if (price === undefined) {
    const sc = rec(structured.structuredContent)
    if (sc) {
      price = num(sc.price ?? sc.estimate ?? sc.fee)
      duration = num(sc.duration ?? sc.durationMinutes) ?? duration
    }
  }
  if (price === undefined || duration === undefined) {
    const text = extractText(structured)
    if (text) {
      const priceMatch = /(\d+(?:\.\d+)?)\s*元/.exec(text)
      const durMatch = /(\d+(?:\.\d+)?)\s*分钟/.exec(text)
      if (price === undefined && priceMatch) price = Number(priceMatch[1])
      if (duration === undefined && durMatch) duration = Number(durMatch[1])
    }
  }
  if (price === undefined && duration === undefined) return undefined
  const out: DidiTaxiEstimate = { mode: '出租车（滴滴估价）' }
  if (duration !== undefined && duration >= 0) out.durationMinutes = Math.round(duration)
  if (price !== undefined && price >= 0) out.priceHint = `约 ${price} 元`
  return out
}

// ────────────────────────── 前置地理编码链 ──────────────────────────

/** geocoder 源（链式消歧：amap geocoder → 腾讯 map-assistant；模型无感）。 */
export interface GeoCodeSource {
  name: string
  geocode(address: string, city?: string, env?: KeyResolutionEnv): Promise<{ coords?: GeoCoords; degraded: DegradedEntry[] }>
}

// ────────────────────────── Key 门控 ──────────────────────────

/**
 * DIDI_MCP_KEY 已配判定：env 专门名直查 + resolveKey 链（settings keys.didi →
 * credentials ref DIDI_MCPKEY → env 兜底）。
 */
export async function isDidiKeyConfigured(env?: KeyResolutionEnv): Promise<boolean> {
  const direct = (env?.env ?? process.env)[DIDI_MCP_KEY_ENV]
  if (direct !== undefined && direct.trim().length > 0) return true
  return (await resolveKey(DIDI_KEY, env)) !== undefined
}

// ────────────────────────── 适配器 ──────────────────────────

export interface DidiAdapterOptions {
  /** MCP 客户端注入（测试 fake；缺省按 url/fetchFn 构造并挂 assertDidiQueryOnly 闸门）。 */
  mcp?: McpStreamClient
  geocoders?: GeoCodeSource[]
  url?: string
  fetchFn?: FetchLike
  timeoutMs?: number
}

export interface DidiTransferResult {
  options: CityTransferOption[]
  degraded: DegradedEntry[]
}

export class DidiAdapter extends BaseAdapter {
  readonly mcp: McpStreamClient
  private readonly geocoders: GeoCodeSource[]

  constructor(opts: DidiAdapterOptions = {}) {
    super('didi')
    this.mcp = opts.mcp ?? new McpStreamClient({
      url: opts.url ?? process.env[DIDI_MCP_URL_ENV] ?? DEFAULT_DIDI_MCP_URL,
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs ?? DEFAULT_DIDI_TIMEOUT_MS,
      // 只读闸门注入（rail12306.ts McpClientOptions.readOnlyGate 在途位，W4 收编）：
      // 白名单外/交易类调用在进网络前一律拒绝（positive whitelist）。
      readOnlyGate: assertDidiQueryOnly,
    })
    this.geocoders = opts.geocoders ?? []
  }

  /** 关闭底层 MCP 会话（长驻适配器生命周期收尾；幂等）。 */
  close(): Promise<void> {
    return this.mcp.close()
  }

  /**
   * Key 门控（渠道开关 + DIDI_MCP_KEY 已配；MCP 可达性在查询期暴露——
   * 与 amap key 门同款：未配 → false → 工具层渠道跳过 + degraded「Key 未配置」；
   * 区别于 rail12306 的 ping()——未配态不做无谓网络探测，保持静默降级）。
   */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('cityDidi', env)) return false
    return isDidiKeyConfigured(env)
  }

  /**
   * 市内衔接（滴滴侧）：前置地理编码链（地名→"lng,lat"）→ maps_direction_transit
   * 公共交通选项 + taxi_estimate 估价参考。transit 失败 = 渠道失败（抛 EngineError，
   * 工具层回退高德单方案）；估价失败不阻塞（省略估价字段）。
   */
  async queryTransfer(
    origin: string,
    destination: string,
    city: string,
    env?: KeyResolutionEnv,
  ): Promise<DidiTransferResult> {
    const degraded: DegradedEntry[] = []
    if (!(await isDidiKeyConfigured(env))) {
      throw EngineError.unavailable(DIDI_KEY_MISSING_REASON, this.name)
    }
    const originCoord = await this.resolveCoord(origin, city, env, degraded)
    const destCoord = await this.resolveCoord(destination, city, env, degraded)
    if (!originCoord || !destCoord) {
      throw EngineError.unavailable('前置地理编码失败：地名无法解析为坐标', this.name)
    }
    const options: CityTransferOption[] = []
    try {
      // 调用点显式断言 + 客户端 readOnlyGate 双闸（rail12306 queryTrains 同款）
      assertDidiQueryOnly('maps_direction_transit')
      const transit = await this.mcp.callToolRaw('maps_direction_transit', {
        origin: originCoord,
        destination: destCoord,
        city: ensureFullCityName(city),
      })
      options.push(...parseTransitOptions(resolveToolPayload(transit)).map((o) => ({ ...o, mode: `滴滴·${o.mode}` })))
    } catch (err) {
      // 错误契约：统一 EngineError（网络/解析/工具错归一 UNAVAILABLE），渠道失败抛给工具层
      const engineErr = this.engineError(err)
      degraded.push(toDegraded(this.name, engineErr))
      throw engineErr
    }
    try {
      assertDidiQueryOnly('taxi_estimate')
      const estimate = await this.mcp.callToolRaw('taxi_estimate', { origin: originCoord, destination: destCoord })
      const parsed = parseTaxiEstimate(resolveToolPayload(estimate))
      if (parsed) options.push(parsed)
    } catch (err) {
      degraded.push(this.toDegradedEntry(err, env))
    }
    if (options.length === 0) {
      degraded.push(toDegraded(this.name, 'EMPTY', '滴滴 MCP 无市内公共交通方案'))
    }
    return { options, degraded }
  }

  /** 地名/坐标 → "lng,lat"：坐标串直传；地名走 geocoders 链（每源失败记账，链全失败 EMPTY）。 */
  private async resolveCoord(
    value: string,
    city: string | undefined,
    env: KeyResolutionEnv | undefined,
    degraded: DegradedEntry[],
  ): Promise<string | undefined> {
    if (isCoordinateString(value)) return value.trim()
    for (const source of this.geocoders) {
      try {
        const { coords, degraded: srcDegraded } = await source.geocode(value, city, env)
        degraded.push(...srcDegraded)
        if (coords !== undefined) return `${coords.lng},${coords.lat}`
      } catch (err) {
        degraded.push(toDegraded(source.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      }
    }
    degraded.push(toDegraded(this.name, 'EMPTY', `地名「${value}」地理编码无结果（geocoder 链全失败）`))
    return undefined
  }

  private toDegradedEntry(err: unknown, env: KeyResolutionEnv | undefined): DegradedEntry {
    if (err instanceof EngineError) return toDegraded(this.name, err)
    return toDegraded(this.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}
