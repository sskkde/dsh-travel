/**
 * 适配器契约（design §5.1 行 253-276）：规范形 / EngineError / 归一化 /
 * 能力协商 / degraded 记账；Key 解析链按 ADR-12（§5.3 行 347）：
 * settings（设置页，W6 接线）→ credentials → env，本波 settings 位留
 * 接口函数（readSettings），credentials→env 两段立即可用。
 *
 * 本文件不含任何外部源调用（适配器实体 W2a/W2b）；只定义契约骨架与
 * 工具层/测试直接复用的纯函数。M2.6 起叠加适配器层治理组合（频控 +
 * robots/ToS，实现在 governance/，本文件仅接线与记账）。
 */
import {
  COORD_SYS, type CoordSys, type GeoCoords, type IntelCategory,
  type SourceRef, type TransportMode,
} from '../models/types.js'
import { isFiniteNumber, isIsoTimestamp } from '../models/validate.js'
// ── M2.6 治理（roadmap W1；governance barrel 对 base 零反向依赖——type-only 下行） ──
import {
  DomainTokenBucket, RateLimitExceededError, globalRateLimiter,
  rateLimitedEntry, robotsBlockedEntry,
  RobotsChecker,
  type RateLimitDecision, type RateLimitMode, type RobotsDecision,
} from './governance/index.js'
// ── M3.3 用量统计（只观测埋点；usage.ts 对适配器层零反向依赖，无环） ──
import { defaultUsageRecorder, type UsageRecorder } from '../metrics/usage.js'

// ────────────────────────── 规范形（Canonical Form） ──────────────────────────

/**
 * 规范形查询：LLM 只面对稳定工具面（travel_*），源差异封闭在适配器
 * 双向变换中（§5.1 项 1）。字段只含业务语义，不含任何源特有参数。
 */
export interface CanonicalQuery {
  /** 对应 TravelRequest.planId（跨修订复用）。 */
  planId?: string
  /** 城市=中文名。 */
  destination?: string
  /** YYYY-MM-DD。 */
  dateStart?: string
  dateEnd?: string
  days?: number
  /** 城际交通模式过滤（research_transport）。 */
  modes?: TransportMode[]
  /** 情报类别过滤（research_destination）。 */
  categories?: IntelCategory[]
  /** 适配器自组关键词时的额外种子（POI 补充等）。 */
  keywords?: string[]
  /** 调用方已校验的来源白名单（复合渠道按此决定是否允许 fallback）。 */
  sources?: string[]
}

/**
 * 规范形结果：数据已按 §5.5 统一模型 + §5.1 项 3 归一化（单位/时间戳/
 * 坐标 GCJ-02），并以 source 溯源。
 */
export interface CanonicalResult<TData> {
  data: TData
  source: SourceRef
}

// ────────────────────────── EngineError 与 degraded 记账 ──────────────────────────

export const ENGINE_ERROR_CODES = ['UNAVAILABLE', 'EMPTY', 'TIMEOUT'] as const
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number]

/** 源错误统一形态（§5.1 项 3）：适配器抛 EngineError，工具层转 degraded[]。 */
export class EngineError extends Error {
  readonly code: EngineErrorCode
  /** 出错的源名（degraded 记账的 source 字段）。 */
  readonly source?: string

  constructor(code: EngineErrorCode, message: string, source?: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.source = source
  }

  static unavailable(message: string, source?: string): EngineError {
    return new EngineError('UNAVAILABLE', message, source)
  }

  static empty(message: string, source?: string): EngineError {
    return new EngineError('EMPTY', message, source)
  }

  static timeout(message: string, source?: string): EngineError {
    return new EngineError('TIMEOUT', message, source)
  }
}

/** 判别：未知错误（网络/解析异常等）归一为 UNAVAILABLE，不吞细节。 */
export function toEngineError(err: unknown, source?: string): EngineError {
  if (err instanceof EngineError) return err
  const message = err instanceof Error ? err.message : String(err)
  return EngineError.unavailable(message, source)
}

/** 降级记账条目（§5.1 项 3 → tools 的 degraded[] / get_state 汇总）。 */
export type DegradedCode = EngineErrorCode | 'NOISE' | 'STALE'

export interface DegradedEntry {
  /** 源名（如 "tencent-poi" / "amap" / "search-l0"）。 */
  source: string
  code: DegradedCode
  /** 人类可读原因（如 "Key 未配置" / "超时" / "返回为空"）。 */
  reason: string
  /** ISO8601。 */
  at: string
  /** 可选业务对象定位（例如 advice 跳过地点）；不改变既有来源语义。 */
  candidateId?: string
  placeId?: string
  /** 多条同渠道同原因丢弃记录的聚合数量。 */
  count?: number
}

/** 从 EngineError（或裸 code+reason）生成记账条目。 */
export function toDegraded(source: string, error: EngineError, at?: string): DegradedEntry;
export function toDegraded(source: string, code: EngineErrorCode, reason: string, at?: string): DegradedEntry;
export function toDegraded(source: string, codeOrError: EngineErrorCode | EngineError, reason?: string, at?: string): DegradedEntry {
  const timestamp = at ?? new Date().toISOString()
  if (codeOrError instanceof EngineError) {
    return { source, code: codeOrError.code, reason: codeOrError.message, at: timestamp }
  }
  return { source, code: codeOrError, reason: reason ?? codeOrError, at: timestamp }
}

// ────────────────────────── Key 解析链（ADR-12：settings→credentials→env） ──────────────────────────

/**
 * Key 解析环境。settings 位（readSettings）为 W6 预留接口：settings 命名
 * 空间 `travel` 接通后由工具/适配器传入热读取快照；本波该位缺省 undefined
 * （等价“未配置”），credentials→env 两段立即可用。
 */
export interface KeyResolutionEnv {
  /** settings 命名空间 travel 的 Key 读取接口（W6 接线；signature 待 spike 确认）。 */
  readSettings?: (key: string) => string | undefined
  /** credentials 解析（宿主 ctx.credentials.resolve(CredentialRef) 的适配签名）。 */
  resolveCredential?: (ref: string) => Promise<string | undefined>
  /** 进程环境变量（缺省 process.env）。 */
  env?: Readonly<Record<string, string | undefined>>
}

export interface ResolvedKey {
  value: string
  /** 命中层（degraded 原因可引用："Key 未配置"）。 */
  layer: 'settings' | 'credentials' | 'env'
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 按 ADR-12 顺序解析 Key：settings → credentials → env。首次非空命中即
 * 返回；全链未配置返回 undefined。
 */
export async function resolveKey(key: string, env?: KeyResolutionEnv): Promise<ResolvedKey | undefined> {
  const readSettings = env?.readSettings
  if (readSettings !== undefined) {
    const fromSettings = nonEmpty(readSettings(key))
    if (fromSettings !== undefined) return { value: fromSettings, layer: 'settings' }
  }
  const resolveCredential = env?.resolveCredential
  if (resolveCredential !== undefined) {
    try {
      const fromCredential = nonEmpty(await resolveCredential(key))
      if (fromCredential !== undefined) return { value: fromCredential, layer: 'credentials' }
    } catch {
      // credentials 解析异常按未配置处理（不阻塞降级链）
    }
  }
  const fromEnv = nonEmpty((env?.env ?? process.env)[key])
  if (fromEnv !== undefined) return { value: fromEnv, layer: 'env' }
  return undefined
}

/** 便捷判定：适配器 available() 实现直接用它。 */
export async function isKeyConfigured(key: string, env?: KeyResolutionEnv): Promise<boolean> {
  return (await resolveKey(key, env)) !== undefined
}

// ────────────────────────── 渠道开关（ADR-12 热读取的前置过滤口） ──────────────────────────

/**
 * 渠道开关判定（工具层 fan-out 前置过滤与适配器 available() 共用）。
 * 读取顺序：env.readSettings(`channels.<name>`)（W6 settings 热读取快照）
 * → env.env[`TRAVEL_CHANNEL_<NAME>`] → 缺省开。
 * 值约定：'off'|'false'|'0'|'' = 关；其余（含缺省/on/true） = 开。
 * W6 接线前以 env/接口位验证逻辑；W6 后 readSettings 即真实 settings 路径。
 */
export function channelEnabled(name: string, env?: KeyResolutionEnv): boolean {
  const candidates: Array<string | undefined> = [
    env?.readSettings?.(`channels.${name}`),
    (env?.env ?? process.env)[`TRAVEL_CHANNEL_${name.toUpperCase()}`],
  ]
  for (const raw of candidates) {
    if (raw === undefined) continue
    const v = String(raw).trim().toLowerCase()
    if (v === 'off' || v === 'false' || v === '0' || v === '') return false
  }
  return true
}

// ────────────────────────── 治理配置热读取（M2.6：频控 + robots/ToS 开关） ──────────────────────────

/** 频控默认值：10 req/min/域（design.md:395「每层设频控（默认 10 次/分钟/域，
 * 可配）」与 §9.3-7 同值）。 */
export const DEFAULT_RATE_LIMIT_PER_DOMAIN = 10

/** 治理配置（每次调用热读，ADR-12 per-invocation 先例 8d21724）。 */
export interface GovernanceConfig {
  /** 每域每窗口允许请求数（advanced.rateLimitPerDomain；未配置回落默认 10）。 */
  rateLimitPerDomain: number
  /** robots/ToS 检查开关（advanced.robotsToSCheck；缺省开，NFR-4）。 */
  robotsToSCheck: boolean
}

/**
 * 从 KeyResolutionEnv 热读治理配置（settings 快照 advanced.* 位；T1 已立
 * per-invocation 先例——每次调用读最新值，改配置后下次调用即生效）。
 * 非法值（NaN/负数/未知布尔）回落默认，不阻塞调用（治理层不抛配置错）。
 */
export function governanceConfig(env?: KeyResolutionEnv): GovernanceConfig {
  const rateRaw = env?.readSettings?.('advanced.rateLimitPerDomain')
  const parsed = rateRaw === undefined ? Number.NaN : Number(rateRaw)
  const rateLimitPerDomain = Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_RATE_LIMIT_PER_DOMAIN
  let robotsToSCheck = true
  const robotsRaw = env?.readSettings?.('advanced.robotsToSCheck')
  if (robotsRaw !== undefined) {
    const v = robotsRaw.trim().toLowerCase()
    if (v === 'false' || v === 'off' || v === '0') robotsToSCheck = false
  }
  return { rateLimitPerDomain, robotsToSCheck }
}

// ────────────────────────── 归一化工具（§5.1 项 3） ──────────────────────────

/** 秒 → 分钟（取整；交通时长/等待时间适用）。 */
export function secondsToMinutes(value: number | string): number {
  const seconds = typeof value === 'string' ? Number(value) : value
  return Math.round(seconds / 60)
}

/** 分（货币最小单位）→ 元（保留两位；票价等适用）。 */
export function fenToYuan(value: number | string): number {
  const fen = typeof value === 'string' ? Number(value) : value
  return fen / 100
}

/**
 * 时间戳 → ISO8601（UTC）。
 * - number：<1e12 视为秒、否则毫秒；string 数字同理
 * - Date：toISOString()
 * - 已是 ISO8601 字符串：原样返回
 * 不可解析抛 RangeError（适配器归一化失败要响亮，不留脏数据）。
 */
export function toIsoTimestamp(value: number | string | Date): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string') {
    if (isIsoTimestamp(value)) return value
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return toIsoTimestamp(numeric) // 秒/毫秒数字串
    }
  }
  throw new RangeError(`toIsoTimestamp: 无法解析的时间戳 ${JSON.stringify(value)}`)
}

// ── WGS-84 → GCJ-02（落盘基准；腾讯/高德原生即 GCJ-02，外源统一转换） ──

const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function gcjTransformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0
  return ret
}

function gcjTransformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0
  return ret
}

/**
 * 统一坐标到 GCJ-02 落盘基准（§5.1 项 3 / §5.5 coords.sys）。
 * - 输入 GCJ02：原样返回（sys 归一为 GCJ02）
 * - 输入 WGS84：标准 wgs2gcj 变换（中国境外点原样透传，偏差 <1e-6）
 * 腾讯/高德适配器原生 GCJ-02 直落；外源（OSM/搜索）WGS84 经此归一化。
 */
export function toGcj02(lng: number, lat: number, sys: CoordSys = 'GCJ02'): GeoCoords {
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    throw new RangeError(`toGcj02: 非法坐标 (${lng}, ${lat})`)
  }
  if (sys === 'GCJ02' || outOfChina(lng, lat)) {
    return { lng, lat, sys: 'GCJ02' }
  }
  const dLat = gcjTransformLat(lng - 105.0, lat - 35.0)
  const dLng = gcjTransformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const normLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI)
  const normLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return { lng: lng + normLng, lat: lat + normLat, sys: 'GCJ02' }
}

// ────────────────────────── 能力协商骨架（§5.1 项 4） ──────────────────────────

/** 能力标识（枚举开放：适配器可自扩展字符串）。 */
export const CAP_SEAT_CLASS = 'seatClass'          // 支持座位等级参数（flyai）
export const CAP_MAX_PRICE = 'maxPrice'            // 支持最高价参数（flyai）
export const CAP_NATURAL_LANGUAGE = 'naturalLanguage' // 仅自然语言 query（携程问道）
export const CAP_STRUCTURED_RESULT = 'structuredResult' // 结构化响应可做字段映射
export const CAP_ZERO_KEY = 'zeroKey'              // 零 key 通道（腾讯 h5gw）

export interface AdapterCapabilities {
  /** 能力标识集合（能力协商：源不支持的参数三选一——直传/转译/后过滤）。 */
  readonly supports: ReadonlySet<string>
  /**
   * 后过滤策略（§5.1 项 4 的“全量取回后适配器内后过滤”）：源不支持
   * 的参数，由适配器按 query 裁剪/变换。缺省原样直传。
   */
  filter?(query: CanonicalQuery): CanonicalQuery
}

export function supportsCapability(capabilities: AdapterCapabilities | undefined, name: string): boolean {
  return capabilities?.supports.has(name) ?? false
}

/** 能力清单（调试/降级说明用）。 */
export function capabilityNames(capabilities: AdapterCapabilities | undefined): string[] {
  return capabilities ? [...capabilities.supports].sort() : []
}

/** 治理组合注入（构造第三参；测试/定制自建实例，缺省接全局共享件）。 */
export interface AdapterGovernanceOptions {
  /** 域级令牌桶（缺省 globalRateLimiter）。 */
  rateLimiter?: DomainTokenBucket
  /** robots 检查器（缺省新实例）。 */
  robotsChecker?: RobotsChecker
  /**
   * 用量记录器（M3.3 只观测；缺省回落模块级默认单例——index.ts 接线后
   * 全部埋点共享同一落盘快照）。埋点只读既有语义，不改变任何判定。
   */
  usage?: UsageRecorder
}

/** 频控占用选项。 */
export interface RateAcquireOptions {
  /** 治理配置热读环境（makeKeyEnv；缺省=回落默认 10/开）。 */
  env?: KeyResolutionEnv
  /** 显式覆盖每窗口 limit（缺省取 advanced.rateLimitPerDomain）。 */
  limit?: number
  /** queue=排队至预算窗（缺省，§9.3-7）；reject=熔断抛错。 */
  mode?: RateLimitMode
  /** queue 等待上限（缺省一个窗口；超时熔断抛错）。 */
  timeoutMs?: number
}

/**
 * 适配器基类：统一 degraded 记账与 Key 解析的骨架。
 * 实体适配器（W2a/W2b）extends 本类并实现 available() 与各自查询方法；
 * 规范形 → 源参数变换、源响应 → §5.5 归一化在实体中实现。
 *
 * ── M2.6 治理组合（W2/W3 交接段；roadmap.md:171-178） ──
 * 本类叠加上层治理（频控 + robots/ToS），以下为渠道适配器标准用法：
 *
 * 1) 频控（默认 10 req/min/域；advanced.rateLimitPerDomain 热读，改配置后
 *    下次调用按新值）：
 * ```
 *   // queue（§9.3-7 主口径）：请求排队至预算窗；超预算窗熔断抛错
 *   await this.acquireRate('xiaohongshu.com', { env })
 *   // reject（熔断）：超限立即抛 RateLimitExceededError → catch 记 degraded
 *   try {
 *     await this.acquireRate(domain, { env, mode: 'reject' })
 *   } catch (err) {
 *     if (err instanceof RateLimitExceededError) {
 *       const entry = this.rateLimited(domain, err)   // code UNAVAILABLE
 *       results.degraded.push(entry)                  // 渠道产出 degraded 标注
 *       return fallback(...)                          // 走降级链
 *     }
 *     throw err
 *   }
 *   // 非阻塞预检（先查后抓）：ok=false → 直接降级标注，不入队等待
 *   const win = this.rateWindow(domain, { env })
 *   if (!win.ok) { ... this.rateLimited(domain) ... }
 * ```
 *
 * 2) robots/ToS（advanced.robotsToSCheck 默认开；L0.5 直抓域
 *    xiaohongshu.com/zhihu.com 抓取前必查；Disallow → 跳过
 *    直抓并降级标注；robots.txt 4xx-非404/网络错误 → fail-closed，404 →
 *    fail-open——口径注释见 governance/robots.ts）：
 * ```
 *   const decision = await this.robotsCheck(url, { env })
 *   if (!decision.allowed) {
 *     const entry = this.robotBlocked(url, decision)  // code UNAVAILABLE
 *     results.degraded.push(entry)
 *     return // 该源跳过直抓（不违规抓取）
 *   }
 *   // 缓存命中同步预检（省一次 await；未命中返回 undefined）
 *   const peek = this.robotsPeek(url)
 *   if (peek && !peek.allowed) { ... skip ... }
 * ```
 *
 * 治理是**叠加层**：不替代渠道内配额（MAX_POI_CALLS/MAX_L05）预算语义。
 * 测试注入：构造第三参传自建 rateLimiter/robotsChecker（fake timers/mock
 * fetch 见 tests/governance-*.test.ts）。
 */
export abstract class BaseAdapter {
  /** 源名（degraded 记账 source；如 "tencent-poi"）。 */
  readonly name: string

  /** 域级令牌桶（缺省全局共享桶：同域跨渠道同一预算窗）。 */
  protected readonly rateLimiter: DomainTokenBucket
  /** robots 检查器（缺省新实例；fetch 惰性挂载）。 */
  protected readonly robotsChecker: RobotsChecker
  /** 用量记录器（M3.3 只观测埋点；缺省模块级默认单例）。 */
  protected readonly usage: UsageRecorder

  constructor(
    name: string,
    readonly capabilities: AdapterCapabilities = { supports: new Set<string>() },
    governance: AdapterGovernanceOptions = {},
  ) {
    this.name = name
    this.rateLimiter = governance.rateLimiter ?? globalRateLimiter
    this.robotsChecker = governance.robotsChecker ?? new RobotsChecker()
    this.usage = governance.usage ?? defaultUsageRecorder()
  }

  /** 渠道可用性（Key 解析链/部署位判定；tools fan-out 前置过滤用）。 */
  abstract available(env?: KeyResolutionEnv): Promise<boolean>

  /** 本适配器 Key 解析（settings→credentials→env）。 */
  protected async resolveChainKey(key: string, env?: KeyResolutionEnv): Promise<ResolvedKey | undefined> {
    return resolveKey(key, env)
  }

  /** 归一化错误 → EngineError（未知错误统一 UNAVAILABLE）。 */
  protected engineError(err: unknown): EngineError {
    return toEngineError(err, this.name)
  }

  /** 生成降级记账条目（来源自带本适配器名）。 */
  protected degraded(code: EngineErrorCode, reason: string): DegradedEntry {
    return { source: this.name, code, reason, at: new Date().toISOString() }
  }

  // ── M2.6 治理面 ──

  /** 治理配置热读（advanced.* 位；每次调用取最新快照）。 */
  protected governed(env?: KeyResolutionEnv): GovernanceConfig {
    return governanceConfig(env)
  }

  /** 域级频控占用（queue 排队至预算窗 / reject 熔断；limit 热读）。
   * M3.3 只观测：熔断拒绝时记 usage 计数后原样上抛（语义不变）。 */
  protected async acquireRate(domain: string, options: RateAcquireOptions = {}): Promise<void> {
    const limit = options.limit ?? governanceConfig(options.env).rateLimitPerDomain
    try {
      await this.rateLimiter.acquire(domain, limit, options.mode ?? 'queue', options.timeoutMs)
    } catch (error) {
      if (error instanceof RateLimitExceededError) this.usage.recordRateLimitReject(this.name)
      throw error
    }
  }

  /** 域级频控预检（非阻塞；ok=true 即占用）。 */
  protected rateWindow(domain: string, options: RateAcquireOptions = {}): RateLimitDecision {
    const limit = options.limit ?? governanceConfig(options.env).rateLimitPerDomain
    return this.rateLimiter.tryAcquire(domain, limit)
  }

  /** robots/ToS 检查（开关默认开；关闭=直接放行）。
   * M3.3 只观测：Disallow/不可达拦截时记 usage 计数，决策原样返回。 */
  protected async robotsCheck(rawUrl: string, options: { env?: KeyResolutionEnv } = {}): Promise<RobotsDecision> {
    if (!governanceConfig(options.env).robotsToSCheck) return { allowed: true }
    const decision = await this.robotsChecker.isPathAllowed(rawUrl)
    if (!decision.allowed) this.usage.recordRobotsBlocked(this.name)
    return decision
  }

  /** robots 缓存命中同步预检（未命中 undefined；不触发网络）。 */
  protected robotsPeek(rawUrl: string): RobotsDecision | undefined {
    return this.robotsChecker.peek(rawUrl)
  }

  /** 频控熔断 → degraded 记账（source=本适配器名）。 */
  protected rateLimited(domain: string, error?: RateLimitExceededError): DegradedEntry {
    return rateLimitedEntry(this.name, domain, error)
  }

  /** robots 禁抓 → degraded 记账（source=本适配器名）。 */
  protected robotBlocked(url: string, decision: Extract<RobotsDecision, { allowed: false }>): DegradedEntry {
    return robotsBlockedEntry(this.name, url, decision)
  }
}

export {
  DomainTokenBucket, RateLimitExceededError, globalRateLimiter,
  rateLimitedEntry, robotsBlockedEntry, RobotsChecker,
}
export type {
  RateLimitDecision, RateLimitMode, RobotsDecision,
} from './governance/index.js'

export { COORD_SYS }
export type { CoordSys }