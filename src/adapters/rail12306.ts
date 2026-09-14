/**
 * rail12306 适配器（W2b）：drfccv/mcp-server-12306 本地只读查询（ADR-5 行 340）。
 *
 * 只读红线（deploy.md §2.1，强制）：接入仅限只读查询——余票/车次/票价/车站；
 * 工具白名单 READ_ONLY_TOOLS（实测清单，2026-09-02 部署实录）：
 * query-tickets / query-ticket-price / search-stations / query-transfer /
 * get-train-route-stations / get-train-no-by-train-code / get-current-time；
 * 代码层 deny 交易类关键字（购票/抢票/候补/代付），绝不触达写端点
 * （2026-04 国铁禁自动化抢票，有刑事判例）。
 *
 * 传输：Streamable HTTP（POST {base}/mcp，initialize 握手 → tools/list →
 * tools/call，Mcp-Session-Id 会话头）。默认 http://127.0.0.1:8123/mcp，
 * env TRAVEL_RAIL_MCP_URL 覆盖（deploy.md §2.4 端口约定）。
 * 互备接口预留：wendao/flyai 位（携程问道/飞猪，M2.3 填充；backupSources()）。
 */
import { BaseAdapter, EngineError, toDegraded, toEngineError, channelEnabled, toIsoTimestamp, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import type { TransportOption } from '../models/types.js'

export const DEFAULT_RAIL_MCP_URL = 'http://127.0.0.1:8123/mcp'
/** env 覆盖键（deploy.md §2.4）。 */
export const RAIL_MCP_URL_ENV = 'TRAVEL_RAIL_MCP_URL'

/** 只读白名单（实测工具清单；内含任何交易类方法即编译期红线违背）。 */
export const READ_ONLY_TOOLS: readonly string[] = [
  'query-tickets',
  'query-ticket-price',
  'search-stations',
  'query-transfer',
  'get-train-route-stations',
  'get-train-no-by-train-code',
  'get-current-time',
]

/** 交易类关键字 deny 表（防御：白名单之外的调用一律拒绝）。 */
const TRANSACTION_KEYWORDS = /buy|pay|order|booking|wait(ing)?|候补|购票|抢票|代付|支付|下单|预订/i

/** 白名单判定 + 交易类 deny（测试断言白名单无交易类方法）。 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.includes(name) && !TRANSACTION_KEYWORDS.test(name)
}

/**
 * 只读断言：非白名单/交易类工具 → EngineError.UNAVAILABLE（调用前强制闸门）。
 * 任何 rail12306 查询方法进入网络前必经此闸。
 */
export function assertReadOnly(name: string): void {
  if (!isReadOnlyTool(name)) {
    throw EngineError.unavailable(`工具 ${name} 不在只读白名单（交易类调用被红线拒绝）`, 'rail12306')
  }
}

// ────────────────────────── 归一化纯函数 ──────────────────────────

/** "05:56" → 356 分钟。 */
export function durationToMinutes(hhmm: string): number | undefined {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

export interface NormalizedTrain {
  trainNo: string
  from: string
  to: string
  depart: string
  arrive: string
  durationMinutes?: number
  seats: Record<string, string>
}

/** query-tickets 单班次 → 规范形（时刻原样、时长→分钟、座席映射）。 */
export function normalizeTrain(raw: Record<string, unknown>): NormalizedTrain {
  const seats = (raw.seats ?? {}) as Record<string, unknown>
  const seatMap: Record<string, string> = {}
  for (const [k, v] of Object.entries(seats)) {
    seatMap[k] = v === null || v === undefined ? '' : String(v)
  }
  return {
    trainNo: String(raw.train_no ?? ''),
    from: String(raw.from_station ?? ''),
    to: String(raw.to_station ?? ''),
    depart: String(raw.start_time ?? ''),
    arrive: String(raw.arrive_time ?? ''),
    durationMinutes: durationToMinutes(String(raw.duration ?? '')),
    seats: seatMap,
  }
}

/** query-ticket-price prices 对象 {"二等座":"795.0"} → 元数组 [min,max]。 */
export function normalizePrices(prices: unknown): [number, number] | undefined {
  if (!prices || typeof prices !== 'object') return undefined
  const values: number[] = []
  for (const v of Object.values(prices as Record<string, unknown>)) {
    const n = Number(v)
    if (Number.isFinite(n)) values.push(n)
  }
  if (!values.length) return undefined
  return [Math.min(...values), Math.max(...values)]
}

/** 座席余票 → 标签（"二等座：有" 等，只读展示）。 */
export function seatTags(seats: Record<string, string>): string[] {
  const tags: string[] = []
  for (const [cls, avail] of Object.entries(seats)) {
    if (avail && avail !== '无') tags.push(`${cls}：${avail}`)
  }
  return tags.slice(0, 5)
}

// ────────────────────────── MCP Streamable HTTP 最小客户端 ──────────────────────────

export interface FetchLike {
  (input: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>
}

export interface McpClientOptions {
  url?: string
  fetchFn?: FetchLike
  timeoutMs?: number
  /**
   * 会话空闲超时（默认 10 分钟）：超过则自动 close()（DELETE，释放服务端活跃
   * 会话），下次调用懒初始化自愈——长驻宿主（index.ts 实例）会话收尾统一策略：
   * 活跃期复用、空闲期关闭回收，不破坏现有 live 复用行为（M1 W7 notes §5 遗留）。
   */
  idleTimeoutMs?: number
  /**
   * 只读闸门（W2 xhs 复用本客户端接入 xiaohongshu-mcp）：缺省 = rail12306
   * 白名单（本文件 assertReadOnly）；其他 MCP 源传各自只读白名单闸门
   * （如 xhs.ts assertXhsReadOnly）——白名单外/交易类调用一律编译期红线拒绝。
   */
  readOnlyGate?: (name: string) => void
}

export interface McpToolInfo {
  name: string
  description: string
}

/**
 * MCP Streamable HTTP 客户端（只覆盖本适配器需要的只读子集：
 * initialize / notifications/initialized / tools/list / tools/call）。
 */
export class McpStreamClient {
  readonly url: string
  private readonly fetchFn: FetchLike
  private readonly timeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly readOnlyGate: (name: string) => void
  private sessionId: string | undefined
  /** 最近一次成功通信时刻（epoch ms；空闲超时判据）。 */
  private lastActiveAt = 0

  constructor(opts: McpClientOptions = {}) {
    this.url = opts.url ?? DEFAULT_RAIL_MCP_URL
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike).bind(globalThis)
    this.timeoutMs = opts.timeoutMs ?? 10000
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000
    this.readOnlyGate = opts.readOnlyGate ?? assertReadOnly
  }

  /**
   * 会话空闲到期检查（统一策略：活跃期复用、超时关闭）：已有会话且空闲 ≥ 超时 → 
   * close()（清 sessionId）；继续走的懒初始化路径自愈重建会话（不破坏 live 复用）。
   * idleTimeoutMs≤0 语义=立即过期（测试/调试用）。
   */
  private async ensureSessionFresh(): Promise<void> {
    if (this.sessionId === undefined) return
    if (Date.now() - this.lastActiveAt < this.idleTimeoutMs) return
    await this.close()
  }

  /** 握手 + initialized 通知；成功返回协议版本。 */
  async initialize(): Promise<string> {
    const result = await this.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'dsh-travel-rail12306', version: '0.0.1' },
    } })
    const version = (result as Record<string, unknown>).result as Record<string, unknown> | undefined
    const protocol = String(version?.protocolVersion ?? '2025-11-25')
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return protocol
  }

  /** 存活探测（initialize 往返）。 */
  async ping(): Promise<boolean> {
    try {
      await this.initialize()
      return true
    } catch {
      return false
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (result as Record<string, unknown>).result as Record<string, unknown> | undefined
    return ((tools?.tools ?? []) as Array<Record<string, unknown>>).map((t) => ({
      name: String(t.name ?? ''),
      description: String(t.description ?? ''),
    }))
  }

  /** 只读工具调用：内容展开 + JSON 文本自动解析（返回业务 JSON）。 */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // 在途闸门（构造注入，缺省=rail12306 白名单）：xhs 等其他 MCP 源传各自
    // 白名单（readOnlyGate 选项），此处必须用实例闸门而非模块级缺省——否则
    // 注入的 xhs 白名单被旁路（W2/T3 收口）。
    this.readOnlyGate(name)
    // 会话策略（懒初始化 + 空闲回收）统一在 callToolRaw，此处不得重复——否则
    // 双重 ensureSessionFresh 在 idleTimeoutMs=0 下产生多余 DELETE/initialize。
    const payload = await this.callToolRaw(name, args)
    const content = (payload.content ?? []) as Array<Record<string, unknown>>
    const text = content.find((c) => c.type === 'text')?.text
    if (typeof text !== 'string') return payload
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * tools/call 原始 payload（全 content 块；首个 text 块会吞掉 image 块的
   * 多模态响应用——xhs get_login_qrcode「文本+图片」双块，W2/T3）。
   * 同闸门同会话策略（懒初始化 + 空闲回收）。
   */
  async callToolRaw(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.readOnlyGate(name)
    await this.ensureSessionFresh()
    if (!this.sessionId) await this.initialize()
    const resp = await this.post({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } })
    const payload = (resp as Record<string, unknown>).result as Record<string, unknown> | undefined
    if (!payload) throw new Error(`MCP tools/call 无 result：${JSON.stringify(resp).slice(0, 200)}`)
    if (payload.isError) throw new Error(`MCP 工具 ${name} 返回错误：${JSON.stringify(payload).slice(0, 200)}`)
    return payload
  }

  private async post(payload: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    let timer: ReturnType<typeof setTimeout> | undefined
    const res = await Promise.race([
      this.fetchFn(this.url, { method: 'POST', headers, body: JSON.stringify(payload) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(EngineError.timeout(`MCP ${this.url} 超时（${this.timeoutMs}ms）`, 'rail12306')), this.timeoutMs)
      }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}`)
    // 服务端已应答 → 刷新活跃时刻（空闲超时判据；会话保持期接口）。
    this.lastActiveAt = Date.now()
    const rawHeaders = (res as unknown as { headers?: { get?(n: string): string | null } }).headers
    const sid = typeof rawHeaders?.get === 'function' ? rawHeaders.get('mcp-session-id') : undefined
    if (sid) this.sessionId = sid
    const text = await res.text()
    if (!text) return null
    const lines = text.split('\n')
    const looksSse = lines.some((l) => l.startsWith('event:') || l.startsWith('data:'))
    if (looksSse) {
      // SSE 流：event:/data: 交错，取 data: 行 JSON（首个 JSON-RPC 本体）
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          // 忽略事件封装（event:/ping 等），取 JSON-RPC 本体
          if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed || 'method' in parsed)) return parsed
        } catch { /* 跳过非 JSON data 行 */ }
      }
      return null
    }
    return JSON.parse(text)
  }

  /**
   * 关闭会话（MCP Streamable HTTP DELETE；2025-11-25 协议）。重复/未初始化
   * 调用为空操作；失败静默（会话由服务端超时回收兜底，不阻塞降级链）。
   * 生命周期责任在调用方（宿主/脚本在长驻适配器用毕后调用）。
   */
  async close(): Promise<void> {
    if (!this.sessionId) return
    const sid = this.sessionId
    this.sessionId = undefined
    try {
      await this.fetchFn(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } })
    } catch {
      // 忽略：会话未 DELETE 只影响服务端活跃计数，不阻塞后续（懒初始化自愈）
    }
  }
}

// ────────────────────────── 适配器 ──────────────────────────

export interface Rail12306Options {
  mcp?: McpStreamClient
  /**
   * 伴随服务按需拉起钩子（M3.5 supervisor 接线位）：MCP ping 失败时调用，
   * 返回 true = 服务已就绪可重试一次。缺省无（M2 行为：ping 失败即不可用）。
   */
  ensure?: () => Promise<boolean>
}

export interface TrainQuery {
  from: string
  to: string
  /** YYYY-MM-DD。 */
  date: string
}

export class Rail12306Adapter extends BaseAdapter {
  readonly mcp: McpStreamClient
  private readonly ensure?: () => Promise<boolean>

  constructor(opts: Rail12306Options = {}) {
    super('rail12306')
    this.mcp = opts.mcp ?? new McpStreamClient()
    this.ensure = opts.ensure
  }

  /** 关闭底层 MCP 会话（长驻适配器生命周期收尾；幂等）。 */
  close(): Promise<void> {
    return this.mcp.close()
  }

  /** MCP 存活探测 + 渠道开关（ADR-12）。不可达 → false（走降级链）。
   *  M3.5：装配 ensure 钩子时，ping 失败 → 按需拉起一次 → 重试 ping。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('rail12306', env)) return false
    if (await this.mcp.ping()) return true
    if (this.ensure === undefined) return false
    if (!(await this.ensure())) return false
    return this.mcp.ping()
  }

  /** 互备源声明（wendao/flyai 位，M2.3 填充；供降级链/证据核对）。 */
  backupSources(): string[] {
    return [
      'wendao（携程问道：火车票实测源，M2.3 互备接入）',
      'flyai（飞猪：零 key 试用，M2.3 互备接入）',
    ]
  }

  /** 余票/车次查询（只读 query-tickets）→ §5.5 TransportOption[]。 */
  async queryTrains(query: TrainQuery, env?: KeyResolutionEnv): Promise<{ options: TransportOption[]; degraded: DegradedEntry[] }> {
    assertReadOnly('query-tickets')
    const degraded: DegradedEntry[] = []
    try {
      const resp = (await this.mcp.callTool('query-tickets', {
        from_station: query.from,
        to_station: query.to,
        train_date: query.date,
      })) as Record<string, unknown>
      if (resp.success === false) throw new Error(String(resp.message ?? 'query-tickets 查询失败'))
      const trains = (resp.trains ?? []) as Array<Record<string, unknown>>
      if (!trains.length) {
        degraded.push(toDegraded(this.name, 'EMPTY', `查询日期 ${query.date} 无班次`))
        return { options: [], degraded }
      }
      const options: TransportOption[] = trains.map((raw) => {
        const t = normalizeTrain(raw)
        return {
          mode: 'rail',
          segments: [{
            from: t.from,
            to: t.to,
            no: t.trainNo,
            depart: t.depart,
            arrive: t.arrive,
          }],
          durationMinutes: t.durationMinutes,
          tags: [...seatTags(t.seats)],
          bookingTips: ['班次/余票以 12306 官方为准'],
          source: {
            platform: 'rail12306',
            url: this.mcp.url,
            fetchedAt: new Date().toISOString(),
          },
        }
      })
      return { options, degraded }
    } catch (err) {
      const engineErr = toEngineError(err, this.name)
      degraded.push(toDegraded(this.name, engineErr))
      throw engineErr
    }
  }

  /** 票价查询（只读 query-ticket-price）→ 价格区间元 + 各席别价。 */
  async queryTicketPrice(
    params: TrainQuery & { trainCode?: string },
    env?: KeyResolutionEnv,
  ): Promise<{ trains: Array<{ trainCode: string; priceRange?: [number, number]; prices: Record<string, number> }>; degraded: DegradedEntry[] }> {
    assertReadOnly('query-ticket-price')
    const degraded: DegradedEntry[] = []
    try {
      const resp = (await this.mcp.callTool('query-ticket-price', {
        from_station: params.from,
        to_station: params.to,
        train_date: params.date,
        ...(params.trainCode ? { train_code: params.trainCode } : {}),
      })) as Record<string, unknown>
      if (resp.success === false) throw new Error(String(resp.message ?? 'query-ticket-price 查询失败'))
      const rows = (resp.data ?? []) as Array<Record<string, unknown>>
      const trains = rows.map((row) => {
        const prices = (row.prices ?? {}) as Record<string, unknown>
        const priceMap: Record<string, number> = {}
        for (const [k, v] of Object.entries(prices)) {
          const n = Number(v)
          if (Number.isFinite(n)) priceMap[k] = n
        }
        return {
          trainCode: String(row.train_code ?? row.train_no ?? ''),
          priceRange: normalizePrices(prices),
          prices: priceMap,
        }
      })
      if (!trains.length) degraded.push(toDegraded(this.name, 'EMPTY', '票价无结果'))
      return { trains, degraded }
    } catch (err) {
      const engineErr = toEngineError(err, this.name)
      degraded.push(toDegraded(this.name, engineErr))
      throw engineErr
    }
  }

  /** 车站搜索（只读 search-stations）。 */
  async searchStations(keyword: string, env?: KeyResolutionEnv): Promise<{ stations: Array<{ name: string; code: string; pinyin: string }>; degraded: DegradedEntry[] }> {
    assertReadOnly('search-stations')
    const degraded: DegradedEntry[] = []
    try {
      const resp = (await this.mcp.callTool('search-stations', { query: keyword, limit: 10 })) as Record<string, unknown>
      if (resp.success === false) throw new Error(String(resp.message ?? 'search-stations 查询失败'))
      const stations = ((resp.stations ?? []) as Array<Record<string, unknown>>).map((s) => ({
        name: String(s.name ?? ''),
        code: String(s.code ?? ''),
        pinyin: String(s.pinyin ?? ''),
      }))
      if (!stations.length) degraded.push(toDegraded(this.name, 'EMPTY', `车站搜索「${keyword}」无结果`))
      return { stations, degraded }
    } catch (err) {
      const engineErr = toEngineError(err, this.name)
      degraded.push(toDegraded(this.name, engineErr))
      throw engineErr
    }
  }

  /** 服务器时间（只读 get-current-time；timestamp 秒 → ISO8601 归一）。 */
  async serverTime(env?: KeyResolutionEnv): Promise<{ iso: string; date: string; time: string; timezone: string; degraded: DegradedEntry[] }> {
    assertReadOnly('get-current-time')
    const degraded: DegradedEntry[] = []
    try {
      const resp = (await this.mcp.callTool('get-current-time', {})) as Record<string, unknown>
      const iso = toIsoTimestamp(String(resp.timestamp ?? ''))
      return {
        iso,
        date: String(resp.date ?? ''),
        time: String(resp.time ?? ''),
        timezone: String(resp.timezone ?? ''),
        degraded,
      }
    } catch (err) {
      const engineErr = toEngineError(err, this.name)
      degraded.push(toDegraded(this.name, engineErr))
      throw engineErr
    }
  }

  private degradedEntry(err: unknown): DegradedEntry {
    if (err instanceof EngineError) return toDegraded(this.name, err)
    return toDegraded(this.name, 'UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}