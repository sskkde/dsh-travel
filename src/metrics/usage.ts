/**
 * 用量统计（M3.3 / W3，roadmap.md:214-216 + requirements.md:181 NFR-6 可视化底座）。
 *
 * UsageRecorder 按 **source × plan × month** 记录外部调用用量（内存先行，原子落盘）：
 * - AMap：logical（业务调用）/ quota（配额放行）/ network（网络实调）/ POI / REST；
 * - search：L0 宿主查询 / L0.5 直抓；
 * - cache：hit / miss（rate 分母 = hit+miss）；
 * - fanout：attempts / retries；
 * - governance：rate-limit 拒绝 / robots 拦截；
 * - degraded：按 source × code 聚合计数；
 * - last reset：月份变更（UTC 口径，与 amap QuotaCounter 一致）自动重置。
 *
 * 铁律：
 * - **只观测**：所有 record* 永不抛错、永不改写 M2 的 quota-acquire-before-cache
 *   等既有语义；统计失败最多丢计数，不影响主流程。
 * - **零 secret**：快照/持久化/HTTP projection 只含计数与 source/planId 标识，
 *   不落任何 key/cookie/license。
 * - **原子持久化**：`.dsh-travel/usage.json` 经 temp + rename 写入（POSIX 原子
 *   语义 + 进程内 flush 串行队列，并发 flush 不损坏）；文件损坏 → 改名备份
 *   `usage.json.corrupt-<ts>` + 重建空 snapshot + warning，绝不使 research 失败。
 *
 * plan 维度归因：research fan-out 入口（fanout.ts）以 `runWithPlan(query.planId)`
 * 开启 AsyncLocalStorage 作用域，其异步链路上的适配器调用自动归属该 plan；
 * fan-out 之外的直连调用（transport/advice 直接调适配器）落 `USAGE_UNKNOWN_PLAN`
 * 兜底桶（记录语义不丢，plan 归因留待后续接线）。
 */
import { rename, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveTravelRoot, travelDirectory } from '../store/paths.js'

// ────────────────────────── 常量与类型 ──────────────────────────

/** 持久化文件名（插件根 `.dsh-travel/usage.json`）。 */
export const USAGE_FILE_NAME = 'usage.json'

/** source 维度：AMap 适配器（= AmapAdapter.name）。 */
export const AMAP_USAGE_SOURCE = 'amap'
/** source 维度：L0 宿主搜索（= SearchAdapter.name）。 */
export const SEARCH_L0_USAGE_SOURCE = 'search-l0'
/** source 维度：L0.5 直抓（= search.ts degraded 用的 source 名）。 */
export const SEARCH_L05_USAGE_SOURCE = 'search-l0.5'
/** source 维度：fan-out 编排器（attempts/retries 计数归属）。 */
export const FANOUT_USAGE_SOURCE = 'fanout'
/** fan-out 作用域之外直连调用的 planId 兜底。 */
export const USAGE_UNKNOWN_PLAN = '-'

/** 单条计数记录（source × plan 维度内；degraded 再按 code 细分）。 */
export interface UsageRecord {
  /** 业务逻辑调用次数（含被 Key 门控/配额熔断拒绝的调用）。 */
  logical: number
  /** 配额 acquire 放行次数（AMap）。 */
  quota: number
  /** 实际发出的网络请求次数（缓存未命中后）。 */
  network: number
  /** AMap POI 类配额放行次数。 */
  poi: number
  /** AMap REST 类配额放行次数。 */
  rest: number
  /** L0 宿主搜索查询次数（每次 hostSearch 调用 = 1）。 */
  searchL0Queries: number
  /** L0.5 直抓次数（缓存命中不计）。 */
  searchL05Fetches: number
  /** 缓存命中次数。 */
  cacheHits: number
  /** 缓存未命中次数。 */
  cacheMisses: number
  /** fan-out 渠道执行尝试次数（含首次与重试）。 */
  fanoutAttempts: number
  /** fan-out 单源重试次数（不含首次）。 */
  fanoutRetries: number
  /** 治理：频控熔断拒绝次数（RateLimitExceededError）。 */
  rateLimitRejects: number
  /** 治理：robots 禁抓拦截次数。 */
  robotsBlocked: number
  /** 降级聚合：EngineErrorCode → 次数（本 source 内）。 */
  degraded: Record<string, number>
}

/** 快照（持久化/装载的磁盘形态；零 secret——只有计数与标识）。 */
export interface UsageSnapshot {
  version: 1
  /** 统计月份 YYYY-MM（UTC 口径；跨月自动重置）。 */
  month: string
  /** 上次重置时刻（ISO8601）。 */
  lastResetAt: string
  /** 最近一次计数变更时刻（ISO8601）。 */
  updatedAt: string
  /** 键 = `${source}|${planId}`（键成分经 sanitize，不含 '|'）。 */
  entries: Record<string, UsageRecord>
}

/** 计数维度字段（装载校验/复制用）。 */
const NUMERIC_FIELDS = [
  'logical', 'quota', 'network', 'poi', 'rest',
  'searchL0Queries', 'searchL05Fetches',
  'cacheHits', 'cacheMisses',
  'fanoutAttempts', 'fanoutRetries',
  'rateLimitRejects', 'robotsBlocked',
] as const

function zeroRecord(): UsageRecord {
  return {
    logical: 0, quota: 0, network: 0, poi: 0, rest: 0,
    searchL0Queries: 0, searchL05Fetches: 0,
    cacheHits: 0, cacheMisses: 0,
    fanoutAttempts: 0, fanoutRetries: 0,
    rateLimitRejects: 0, robotsBlocked: 0,
    degraded: {},
  }
}

function cloneRecord(record: UsageRecord): UsageRecord {
  return { ...record, degraded: { ...record.degraded } }
}

/** 月份口径（UTC，与 amap QuotaCounter.currentMonth 一致）。 */
export function usageMonthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 快照键（键成分禁 '|' 与控制符，保证可逆 split）。 */
export function usageEntryKey(source: string, planId: string): string {
  return `${sanitizeKeyPart(source)}|${sanitizeKeyPart(planId)}`
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[|\u0000-\u001f]/g, '_')
}

// ────────────────────────── 装载校验（宽容计数、严格结构） ──────────────────────────

/** 磁盘快照结构校验：整体形态非法 → undefined（走损坏备份分支）；单条计数非法 → 跳过该条。 */
function coerceSnapshot(raw: unknown): UsageSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) return undefined
  if (typeof obj.month !== 'string' || !/^\d{4}-\d{2}$/.test(obj.month)) return undefined
  if (typeof obj.lastResetAt !== 'string' || typeof obj.updatedAt !== 'string') return undefined
  if (typeof obj.entries !== 'object' || obj.entries === null || Array.isArray(obj.entries)) return undefined
  const entries: Record<string, UsageRecord> = {}
  for (const [key, value] of Object.entries(obj.entries)) {
    const record = coerceRecord(value)
    if (record !== undefined) entries[key] = record
  }
  return { version: 1, month: obj.month, lastResetAt: obj.lastResetAt, updatedAt: obj.updatedAt, entries }
}

function coerceRecord(raw: unknown): UsageRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const out = zeroRecord()
  for (const field of NUMERIC_FIELDS) {
    const value = Number(obj[field])
    if (!Number.isFinite(value) || value < 0) return undefined
    out[field] = value
  }
  if (obj.degraded !== undefined) {
    if (typeof obj.degraded !== 'object' || obj.degraded === null || Array.isArray(obj.degraded)) return undefined
    for (const [code, count] of Object.entries(obj.degraded)) {
      const n = Number(count)
      if (!Number.isFinite(n) || n < 0) return undefined
      out.degraded[code] = n
    }
  }
  return out
}

// ────────────────────────── UsageRecorder ──────────────────────────

/** flush 结果（永不 reject；失败经 ok=false + warn 上报，调用方无需捕获）。 */
export interface UsageFlushOutcome {
  ok: boolean
  /** 未接线持久化（persist=false）时的空操作。 */
  skipped?: boolean
  error?: string
}

export interface UsageRecorderOptions {
  /** usage.json 绝对路径（测试直给）；缺省 = `<travelRoot>/.dsh-travel/usage.json`。 */
  filePath?: string
  /** 工作区根（缺省 resolveTravelRoot()；仅当未显式给 filePath 时使用）。 */
  root?: string
  /** 是否落盘（缺省 true；模块级默认单例传 false——测试/未接线时零磁盘副作用）。 */
  persist?: boolean
  /** 时钟注入（跨月 reset 测试用）。 */
  now?: () => Date
  /** warning 上报（缺省 console.warn）。 */
  warn?: (message: string) => void
  /** 记录后防抖落盘延迟 ms（缺省 500；unref 不阻塞退出）。 */
  flushDebounceMs?: number
}

/**
 * 用量记录器：内存计数 + 跨月自动重置 + 原子落盘。
 * record* 只改内存并防抖调度落盘；flush() 串行队列 + temp/rename 原子写；
 * 一切失败路径只 warn 不抛（「统计失败不得影响主流程」）。
 */
export class UsageRecorder {
  private state: UsageSnapshot
  private readonly persistFlag: boolean
  private readonly filePath: string | undefined
  private readonly now: () => Date
  private readonly warn: (message: string) => void
  private readonly flushDebounceMs: number
  /** 进程内 flush 串行队列（并发 flush 不交错写）。 */
  private flushQueue: Promise<void> = Promise.resolve()
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  /** plan 归因作用域（fan-out 入口 runWithPlan 开启；适配器在链路内自动归属）。 */
  private readonly planScope = new AsyncLocalStorage<string>()

  constructor(options: UsageRecorderOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.warn = options.warn ?? ((message) => { console.warn(`[dsh-travel] ${message}`) })
    this.persistFlag = options.persist ?? true
    this.flushDebounceMs = Math.max(0, options.flushDebounceMs ?? 500)
    this.filePath = options.filePath
      ?? (this.persistFlag ? join(travelDirectory(options.root ?? resolveTravelRoot()), USAGE_FILE_NAME) : undefined)
    this.state = this.loadInitialState()
  }

  // ── 记录面（只观测；全部永不抛错） ──

  /** AMap 业务逻辑调用 +1（rest() 入口即计，含随后被配额熔断拒绝的调用）。 */
  recordAmapLogical(): void {
    this.mutate(AMAP_USAGE_SOURCE, (record) => { record.logical += 1 })
  }

  /** AMap 配额放行 +1（kind 分解 POI/REST；仅在 acquire ok 后计——保持 M2 语义原样）。 */
  recordAmapQuota(kind: 'poi' | 'rest'): void {
    this.mutate(AMAP_USAGE_SOURCE, (record) => {
      record.quota += 1
      if (kind === 'poi') record.poi += 1
      else record.rest += 1
    })
  }

  /** 网络实调 +1（发出请求时计；与 HTTP 状态无关）。 */
  recordNetwork(source: string): void {
    this.mutate(source, (record) => { record.network += 1 })
  }

  /** 缓存命中/未命中（rate 分母 = hit+miss）。 */
  recordCache(source: string, hit: boolean): void {
    this.mutate(source, (record) => {
      if (hit) record.cacheHits += 1
      else record.cacheMisses += 1
    })
  }

  /** L0 宿主搜索查询 +queries（每次 hostSearch 调用 = 1，含 site: 变体）。 */
  recordSearchL0(queries = 1): void {
    this.mutate(SEARCH_L0_USAGE_SOURCE, (record) => { record.searchL0Queries += queries })
  }

  /** L0.5 直抓 +1（缓存命中不计）。 */
  recordSearchL05Fetch(): void {
    this.mutate(SEARCH_L05_USAGE_SOURCE, (record) => { record.searchL05Fetches += 1 })
  }

  /** fan-out 尝试/重试 +1（source 固定 fanout；plan 取当前作用域）。 */
  recordFanout(kind: 'attempt' | 'retry'): void {
    this.mutate(FANOUT_USAGE_SOURCE, (record) => {
      if (kind === 'attempt') record.fanoutAttempts += 1
      else record.fanoutRetries += 1
    })
  }

  /** 治理：频控熔断拒绝 +1（source = 触发的适配器名）。 */
  recordRateLimitReject(source: string): void {
    this.mutate(source, (record) => { record.rateLimitRejects += 1 })
  }

  /** 治理：robots 禁抓拦截 +1（source = 触发的适配器名）。 */
  recordRobotsBlocked(source: string): void {
    this.mutate(source, (record) => { record.robotsBlocked += 1 })
  }

  /** 降级记账聚合 +1（source × code；与 degraded.json 同源口径，只做聚合观测）。 */
  recordDegraded(source: string, code: string): void {
    this.mutate(source, (record) => {
      record.degraded[code] = (record.degraded[code] ?? 0) + 1
    })
  }

  /**
   * 在 plan 作用域内执行异步任务：作用域内所有 record* 自动归属该 planId
   * （AsyncLocalStorage 随异步链路传播；嵌套 runWithPlan 以最内层为准）。
   */
  async runWithPlan<T>(planId: string | undefined, task: () => Promise<T>): Promise<T> {
    return this.planScope.run(planId ?? USAGE_UNKNOWN_PLAN, task)
  }

  /** 当前 plan 归因（诊断用；无作用域 → undefined）。 */
  currentPlan(): string | undefined {
    return this.planScope.getStore()
  }

  // ── 快照与投影 ──

  /** 快照深拷贝（跨月先滚动；调用方可安全改写返回值）。 */
  snapshot(): UsageSnapshot {
    this.rollMonthIfNeeded()
    const entries: Record<string, UsageRecord> = {}
    for (const [key, record] of Object.entries(this.state.entries)) {
      entries[key] = cloneRecord(record)
    }
    return { ...this.state, entries }
  }

  /** redacted projection（HTTP /travel-metrics 响应体；零 secret——结构即证明）。 */
  projection(options: UsageProjectionOptions = {}): TravelMetricsProjection {
    return projectUsage(this.snapshot(), options)
  }

  // ── 持久化（原子写 + 串行队列；失败只 warn） ──

  /**
   * 落盘快照（temp + rename 原子写）。并发调用经进程内队列串行执行；
   * 每次写入序列化「该次写入开始时」的快照——最后一次 flush 收敛到最新计数。
   * 未接线持久化（persist=false）时空操作。
   */
  flush(): Promise<UsageFlushOutcome> {
    if (!this.persistFlag || this.filePath === undefined) {
      return Promise.resolve({ ok: true, skipped: true })
    }
    const run = this.flushQueue.then(() => this.writeSnapshot())
    this.flushQueue = run.then(() => {}, () => {})
    return run
  }

  private async writeSnapshot(): Promise<UsageFlushOutcome> {
    const filePath = this.filePath
    if (filePath === undefined) return { ok: true, skipped: true }
    try {
      // 同步取深拷贝后再 await：写入期间的增量记录留待下一次 flush（不丢、不脏写）
      const payload = JSON.stringify(this.snapshot(), null, 2)
      await mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, filePath)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`usage.json 写入失败（不影响主流程）：${message}`)
      return { ok: false, error: message }
    }
  }

  // ── 内部 ──

  private entry(source: string, planId?: string): UsageRecord {
    this.rollMonthIfNeeded()
    const key = usageEntryKey(source, planId ?? this.planScope.getStore() ?? USAGE_UNKNOWN_PLAN)
    let record = this.state.entries[key]
    if (record === undefined) {
      record = zeroRecord()
      this.state.entries[key] = record
    }
    return record
  }

  private mutate(source: string, fn: (record: UsageRecord) => void): void {
    try {
      fn(this.entry(source))
      this.state.updatedAt = this.now().toISOString()
      this.scheduleFlush()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`用量计数失败（不影响主流程）：${message}`)
    }
  }

  /** 跨月自动重置（UTC 月口径；重置即换新空快照并刷新 lastResetAt）。 */
  private rollMonthIfNeeded(): void {
    const current = usageMonthOf(this.now())
    if (current !== this.state.month) {
      this.state = emptyState(current, this.now().toISOString())
    }
  }

  private scheduleFlush(): void {
    if (!this.persistFlag || this.filePath === undefined || this.debounceTimer !== undefined) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.flush()
    }, this.flushDebounceMs)
    if (typeof this.debounceTimer.unref === 'function') this.debounceTimer.unref()
  }

  /** 启动装载：缺文件 → 空快照；损坏 → 备份改名 + 重建空快照 + warning（不抛）。 */
  private loadInitialState(): UsageSnapshot {
    const now = this.now()
    const fresh = emptyState(usageMonthOf(now), now.toISOString())
    if (!this.persistFlag || this.filePath === undefined) return fresh
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error)
        this.warn(`usage.json 读取失败，按空快照启动：${message}`)
      }
      return fresh
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const snapshot = coerceSnapshot(parsed)
      if (snapshot === undefined) throw new Error('快照结构不合法')
      // 历史月份的持久化快照：跨月自动重置（不备份——原文件保留到下次 flush 覆盖）
      const current = usageMonthOf(now)
      if (snapshot.month !== current) return emptyState(current, now.toISOString())
      return snapshot
    } catch (error) {
      this.backupCorruptFile()
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`usage.json 损坏，已备份并重建空快照（解析原因：${message}）`)
      return fresh
    }
  }

  /** 坏文件改名备份 `usage.json.corrupt-<ts>`；备份失败也只 warn（绝不抛）。 */
  private backupCorruptFile(): void {
    const filePath = this.filePath
    if (filePath === undefined) return
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
    try {
      renameSync(filePath, `${filePath}.corrupt-${stamp}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`usage.json 损坏文件备份失败：${message}`)
      return
    }
    this.warn(`usage.json 损坏文件已备份：${filePath}.corrupt-${stamp}`)
  }
}

function emptyState(month: string, at: string): UsageSnapshot {
  return { version: 1, month, lastResetAt: at, updatedAt: at, entries: {} }
}

// ────────────────────────── 模块级默认单例（未显式注入时的兜底） ──────────────────────────

let defaultRecorder: UsageRecorder | undefined

/**
 * 默认记录器：埋点面（base 治理/fanout）在未显式注入时回落到此单例。
 * 未接线时为**内存态非持久化**实例（零磁盘副作用）；生产 index.ts 用
 * setDefaultUsageRecorder 把真实落盘实例接入，使全部埋点共享同一快照。
 */
export function defaultUsageRecorder(): UsageRecorder {
  if (defaultRecorder === undefined) {
    defaultRecorder = new UsageRecorder({ persist: false })
  }
  return defaultRecorder
}

/** 接线入口（index.ts 调用；传 undefined 恢复内存态兜底，测试清理用）。 */
export function setDefaultUsageRecorder(recorder: UsageRecorder | undefined): void {
  defaultRecorder = recorder
}

// ────────────────────────── redacted projection（HTTP 形态） ──────────────────────────

export interface UsageProjectionOptions {
  /** 预算条分母：AMap 月度配额（缺省 5000；index.ts 传 AMAP_MONTHLY_QUOTA 同源值）。 */
  amapMonthlyLimit?: number
  /** 投影生成时刻（测试注入）。 */
  now?: Date
}

/** 跨 plan 聚合后的 redacted 投影（/travel-metrics 响应体；只含计数与标识）。 */
export interface TravelMetricsProjection {
  month: string
  lastResetAt: string
  generatedAt: string
  amap: { logical: number; quota: number; network: number; poi: number; rest: number; monthlyLimit: number }
  search: { l0Queries: number; l05Fetches: number }
  /** rate 分母 = hit+miss；分母为 0 → null（面板显示「暂无」）。 */
  cache: { hits: number; misses: number; rate: number | null }
  fanout: { attempts: number; retries: number }
  governance: { rateLimitRejects: number; robotsBlocked: number }
  /** 按 source × code 聚合（count 降序 + 字典序，输出稳定）。 */
  degraded: Array<{ source: string; code: string; count: number }>
  /** source × plan 明细（字典序稳定）。 */
  entries: Array<{ source: string; planId: string } & UsageRecord>
}

export function projectUsage(
  snapshot: UsageSnapshot,
  options: UsageProjectionOptions = {},
): TravelMetricsProjection {
  const amap = { logical: 0, quota: 0, network: 0, poi: 0, rest: 0, monthlyLimit: Math.max(1, Math.floor(options.amapMonthlyLimit ?? 5000)) }
  const search = { l0Queries: 0, l05Fetches: 0 }
  const cache = { hits: 0, misses: 0, rate: null as number | null }
  const fanout = { attempts: 0, retries: 0 }
  const governance = { rateLimitRejects: 0, robotsBlocked: 0 }
  const degradedTotals = new Map<string, { source: string; code: string; count: number }>()
  const entries: TravelMetricsProjection['entries'] = []

  for (const [key, record] of Object.entries(snapshot.entries)) {
    const separator = key.lastIndexOf('|')
    const source = separator >= 0 ? key.slice(0, separator) : key
    const planId = separator >= 0 ? key.slice(separator + 1) : USAGE_UNKNOWN_PLAN
    entries.push({ source, planId, ...cloneRecord(record) })
    // 跨 plan 聚合
    if (source === AMAP_USAGE_SOURCE) {
      amap.logical += record.logical
      amap.quota += record.quota
      amap.network += record.network
      amap.poi += record.poi
      amap.rest += record.rest
    }
    if (source === SEARCH_L0_USAGE_SOURCE) search.l0Queries += record.searchL0Queries
    if (source === SEARCH_L05_USAGE_SOURCE) search.l05Fetches += record.searchL05Fetches
    cache.hits += record.cacheHits
    cache.misses += record.cacheMisses
    if (source === FANOUT_USAGE_SOURCE) {
      fanout.attempts += record.fanoutAttempts
      fanout.retries += record.fanoutRetries
    }
    governance.rateLimitRejects += record.rateLimitRejects
    governance.robotsBlocked += record.robotsBlocked
    for (const [code, count] of Object.entries(record.degraded)) {
      const bucketKey = `${source}|${code}`
      const bucket = degradedTotals.get(bucketKey) ?? { source, code, count: 0 }
      bucket.count += count
      degradedTotals.set(bucketKey, bucket)
    }
  }

  const denominator = cache.hits + cache.misses
  cache.rate = denominator > 0 ? cache.hits / denominator : null
  entries.sort((a, b) => (a.source === b.source ? (a.planId < b.planId ? -1 : 1) : a.source < b.source ? -1 : 1))
  const degraded = [...degradedTotals.values()].sort((a, b) =>
    b.count - a.count || (a.source === b.source ? (a.code < b.code ? -1 : 1) : a.source < b.source ? -1 : 1))

  return {
    month: snapshot.month,
    lastResetAt: snapshot.lastResetAt,
    generatedAt: (options.now ?? new Date()).toISOString(),
    amap, search, cache, fanout, governance, degraded, entries,
  }
}

// ────────────────────────── 只读同源 HTTP 路由（/travel-metrics） ──────────────────────────

/** metrics 路由 path（exact；GET 只读投影）。 */
export const TRAVEL_METRICS_PATH = '/travel-metrics'
/** cloak profile 一键清除路由 path（exact；POST + confirm 二次确认参数）。 */
export const TRAVEL_METRICS_CLOAK_CLEAR_PATH = '/travel-metrics/cloak-clear'
/** 二次确认参数名/值（缺省/错值 → 400；防误触）。 */
export const CLOAK_CLEAR_CONFIRM_PARAM = 'confirm'
export const CLOAK_CLEAR_CONFIRM_VALUE = 'clear'

/** 回环主机名（Host/Origin/Referer 授权白名单；跨域浏览器请求须回环来源）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export interface TravelMetricsRouteOptions {
  /** 投影分母：AMap 月度配额（透传 projection）。 */
  amapMonthlyLimit?: number
  /** 除回环外放行的 Host 名（自定义部署兜底；缺省仅回环）。 */
  allowHosts?: readonly string[]
  /**
   * 只读路由（metrics/key-status）同源自洽放行：Host 非回环/白名单时，若请求
   * 携带 Origin/Referer 且其主机名 == Host 主机名（浏览器打开该域 GUI 页的同源
   * fetch）则放行；无 Origin/Referer（curl/外部服务端）仍拒绝。**不得用于写路由**
   * （cloak POST 保持仅回环/白名单）——残余 DNS-rebinding 暴露面仅限只读布尔/
   * 统计面，无 secret 值。
   */
  allowSelfOrigin?: boolean
}

function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

function hostAllowed(hostname: string, options: TravelMetricsRouteOptions | undefined): boolean {
  const lower = hostname.toLowerCase()
  if (LOOPBACK_HOSTNAMES.has(lower)) return true
  return options?.allowHosts?.some((allowed) => allowed.toLowerCase() === lower) ?? false
}

/**
 * 同源/回环来源判定（NFR-5：只读面不外泄给任意外站页面）：
 * - Host 头必需且必须是回环（或显式 allowHosts）——天然防 DNS rebinding；
 * - 携带 Origin/Referer 时其主机名同样必须回环/白名单（本机 UI 跨端口 fetch 放行，
 *   外站页面 fetch 一律 403）；未携带（curl/服务端同机调用）放行；
 * - allowSelfOrigin（仅只读路由）：Host 非回环时改走「同源自洽」——请求必须携带
 *   Origin/Referer 且主机名 == Host 主机名（用户在部署域名 GUI 页上的同源 fetch）；
 *   无来源头的服务端调用仍拒绝。写路由禁用该旗标。
 */
export function metricsSourceAllowed(
  req: Pick<IncomingMessage, 'headers'>,
  options?: TravelMetricsRouteOptions,
): boolean {
  const headers = req.headers ?? {}
  const host = typeof headers.host === 'string' ? headers.host : undefined
  if (host === undefined || host.trim() === '') return false
  const hostName = hostnameOf(host)
  const explicitlyAllowed = hostAllowed(hostName, options)
  if (!explicitlyAllowed && options?.allowSelfOrigin !== true) return false
  const origins = [headers.origin, headers.referer]
    .filter((raw): raw is string => typeof raw === 'string' && raw.trim() !== '')
  if (!explicitlyAllowed && origins.length === 0) return false
  for (const raw of origins) {
    let parsed: URL
    try {
      parsed = new URL(raw, `http://${host}`)
    } catch {
      return false
    }
    if (explicitlyAllowed) {
      if (!hostAllowed(parsed.hostname, options)) return false
    } else if (parsed.hostname.toLowerCase() !== hostName.toLowerCase()) {
      return false
    }
  }
  return true
}

function denyText(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(message)
}

function sendJson(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * GET /travel-metrics handler：返回 redacted projection（零 secret）。
 * 非 GET → 405（allow: GET）；来源非本机回环/白名单 → 403（metricsSourceAllowed）。
 */
export function makeTravelMetricsHandler(
  recorder: UsageRecorder,
  options: TravelMetricsRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      denyText(res, 405, 'travel-metrics 仅支持 GET（只读）', { allow: 'GET' })
      return
    }
    if (!metricsSourceAllowed(req, options)) {
      denyText(res, 403, 'travel-metrics 拒绝非本机来源')
      return
    }
    sendJson(res, JSON.stringify(recorder.projection(options)))
  }
}

/**
 * POST /travel-metrics/cloak-clear handler：一键清除 CloakBrowser profiles
 * （clearProfile/clearAllProfiles 的受控 HTTP 位；**不激活任何自动 hook**）。
 * 非 POST → 405（防 GET 误触；allow: POST）；来源非本机 → 403；
 * 缺少/错配 confirm 二次确认参数 → 400。clearProfiles 由接线方注入
 * （index.ts 传 clearCloakBrowserProfiles），本模块不反向依赖 cloak。
 */
export function makeCloakClearHandler(
  clearProfiles: () => boolean,
  options: TravelMetricsRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'POST') {
      denyText(res, 405, 'cloak profile 清除仅支持 POST（防 GET 误触）', { allow: 'POST' })
      return
    }
    if (!metricsSourceAllowed(req, options)) {
      denyText(res, 403, 'cloak profile 清除拒绝非本机来源')
      return
    }
    let confirm: string | null = null
    try {
      confirm = new URL(req.url ?? '/', 'http://dsh-travel.local').searchParams.get(CLOAK_CLEAR_CONFIRM_PARAM)
    } catch {
      confirm = null
    }
    if (confirm !== CLOAK_CLEAR_CONFIRM_VALUE) {
      denyText(res, 400, `缺少二次确认参数（需 ?${CLOAK_CLEAR_CONFIRM_PARAM}=${CLOAK_CLEAR_CONFIRM_VALUE}）`)
      return
    }
    let cleared = false
    try {
      cleared = clearProfiles()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      denyText(res, 500, `清除失败：${message}`)
      return
    }
    sendJson(res, JSON.stringify({ ok: true, cleared }))
  }
}
