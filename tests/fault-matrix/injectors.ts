/**
 * 四类安全注入原语（M3.6 / W6；m3-execution-plan T7 规格 2）。
 *
 * 安全纪律（Must-Not-Have / 铁律）：
 * - **零持久化**：所有注入发生在进程内对象面（KeyResolutionEnv / 适配器传输
 *   注入位 / 私有令牌桶 / runner 自有 tmpdir 的 fs 权限），不写 settings、
 *   不写生产 profile、不触碰 credentials 存储；
 * - **零凭据破坏**：env 面用「空 env 映射」而非 process.env 抑制 key——生产
 *   key 永不进入矩阵的解析链，也永不被改写；本模块不打印任何 key/值；
 * - **零真实服务停起**：12306(:8123)/xhs 容器(:18060)/Playwright(:8931) 的
 *   「服务停」一律用进程内 mock（fake MCP fetch / 假 registrar / 只读目录）
 *   等价演练（M2 script-d 先例：真实服务注入须 backup/restore guard，本矩阵
 *   优先进程内 mock，规格 b 明示「如需真实服务注入须 guard」——本波不用）；
 * - 伴随服务探活只读（GET probe），runner 前后各探一次作恢复 guard 基线。
 */
import { createHash } from 'node:crypto'
import { DEFAULT_RATE_LIMIT_PER_DOMAIN } from '../../src/adapters/base.js'
import { DomainTokenBucket } from '../../src/adapters/governance/token-bucket.js'
import { probeHealthOnce } from '../../src/lifecycle/health.js'
import { CHANNEL_SETTINGS_PATHS } from '../../src/adapters/env.js'
import type { FetchLike } from '../../src/adapters/rail12306.js'
import type { HostSearchFn } from '../../src/adapters/search.js'
import type { HttpCallFn } from '../../src/adapters/tencent.js'
import type { KeyResolutionEnv } from '../../src/adapters/base.js'
import type { ChannelGroup } from '../../src/client/fields.js'
import type { FAULT_MATRIX_ROWS, FaultKind } from './manifest.js'

/** 渠道逻辑名 → 行（runner 查表用）。 */
export type RowIndex = Record<string, (typeof FAULT_MATRIX_ROWS)[number]>

// ────────────────────────── 注入 a：KeyResolutionEnv 缺失 / 渠道关 ──────────────────────────

export interface FaultEnvOptions {
  /** settings 层可解析的 key（测试值，非生产凭据；如 amapWebservice→'matrix-key'）。 */
  keys?: Record<string, string>
  /** 显式关闭的渠道（settings 通道面 channels.<id>='false'；纯内存）。 */
  offChannels?: readonly string[]
  /** 进程 env 面覆盖（**缺省空映射**——绝不回落 process.env，防生产 key 泄入解析链）。 */
  extraEnv?: Readonly<Record<string, string | undefined>>
}

/**
 * 构造矩阵用 KeyResolutionEnv：
 * - keys：settings 层（`keys.<id>` 与裸标识符均可解析，走 makeKeyEnv 同款路径）；
 * - offChannels：渠道逻辑名（fields.ts 渠道 id，如 'tencentPoi'）→ 经
 *   CHANNEL_SETTINGS_PATHS 映射后 channelEnabled 判 false（ADR-12 同判定路径；
 *   fanout 传来的 'tencent-poi' 等语义名同样命中映射表）；
 * - env 面**缺省空**：resolveKey 第三段不回落 process.env —— missing-key 注入
 *   不受宿主真实 env 污染，生产凭据零接触。
 */
export function faultEnv(options: FaultEnvOptions = {}): KeyResolutionEnv {
  const keys = options.keys ?? {}
  const off = new Set(options.offChannels ?? [])
  return {
    readSettings(key: string): string | undefined {
      if (key.startsWith('channels.')) {
        const logical = key.slice('channels.'.length)
        // 逻辑名 → settings 路径（与 makeKeyEnv 同表）；再以字段 id（path[1]）
        // 对 off 清单判定——offChannels 用 fields.ts 渠道 id 口径。
        const path = CHANNEL_SETTINGS_PATHS[logical]
        if (path === undefined) return undefined
        return off.has(path[1]) ? 'false' : undefined
      }
      if (key.startsWith('advanced.')) return undefined // 治理/高级参数走缺省
      const id = key.startsWith('keys.') ? key.slice('keys.'.length) : key
      return keys[id]
    },
    resolveCredential: async () => undefined, // credentials 位显式空（等价未配置）
    env: options.extraEnv ?? {}, // 不回落 process.env（生产 key 零接触）
  }
}

/** 渠道开关全开 + 常用 key 就位（测试值）的健康 env。 */
export function healthyEnv(keys: Record<string, string> = {}): KeyResolutionEnv {
  return faultEnv({ keys })
}

// ────────────────────────── 注入 b：进程内服务停（mock 抛错） ──────────────────────────

/** 立即抛错的 fetch 形态（ECONNREFUSED 等价语义；消息自述 mock 来源）。 */
export function throwingFetch(message = 'mock ECONNREFUSED（fault-matrix 服务停注入）'): FetchLike {
  return async () => {
    throw new Error(message)
  }
}

/** 抛错的宿主搜索注入（SearchAdapter hostSearch 位）。 */
export function throwingHostSearch(message = 'mock host search down（fault-matrix 服务停注入）'): HostSearchFn {
  return async () => {
    throw new Error(message)
  }
}

/** 抛错的腾讯 httpCall 注入（poi/weather/distance 全域）。 */
export function throwingHttpCall(message = 'mock tencent http down（fault-matrix 服务停注入）'): HttpCallFn {
  return async () => {
    throw new Error(message)
  }
}

// ────────────────────────── 注入 c：超时（挂起 > 适配器闸/编排预算） ──────────────────────────

/**
 * 挂起 fetch：hangMs 内不 settle；**必须响应 abort**（适配器超时闸经
 * Promise.race 先行，本 promise 之后自行 resolve 释放，不遗留长挂计时器）。
 * 与适配器内建 timeoutMs 组合 = 真实 EngineError.timeout 面（非伪造错误码）。
 */
export function hangingFetch(hangMs = 2_000): FetchLike {
  return async (_input, init) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, hangMs)
      if (typeof timer.unref === 'function') timer.unref()
      // McpStreamClient/AmapAdapter 的超时闸独立计时，不依赖此处的 abort；
      // init.signal 存在时提前释放（幂等）。
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); resolve() }
        else signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      }
    })
    throw new Error(`mock fetch hang released after ${hangMs}ms（fault-matrix 超时注入）`)
  }
}

/** 挂起的宿主搜索注入（> fanout 预算 → 编排级 Promise.race TIMEOUT 记账）。 */
export function hangingHostSearch(hangMs = 2_000): HostSearchFn {
  return async () => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, hangMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return { sources: [], truncated: false }
  }
}

/** 挂起的腾讯 httpCall 注入（> fanout 预算 → 编排级 TIMEOUT）。 */
export function hangingHttpCall(hangMs = 2_000): HttpCallFn {
  return async () => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, hangMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    throw new Error(`mock http hang released after ${hangMs}ms（fault-matrix 超时注入）`)
  }
}

// ────────────────────────── 注入 d：token-bucket 限流（内存灌满） ──────────────────────────

/**
 * 持续饱和的私有令牌桶（**不触 globalRateLimiter**——桶状态限定在单 case 的
 * 适配器实例内，零跨 case/零跨套件泄漏）。
 *
 * 机制：xhs.acquireRate 走 queue 模式（排队至预算窗），单次灌满会被滑动窗口
 * 自然排空放行——须在窗口内**持续补戳**维持饱和密度，队列才会按「频控排队
 * 超预算窗」熔断抛 RateLimitExceededError（真实限流熔断面，非伪造错误码）。
 * 小窗口（200ms）+ 2ms 高密度补戳 interval → 熔断 ~200ms 内触发；
 * interval 自限时 5s 自动停止（unref，零计时器残留进套件收尾）。
 * 补戳用放大 limit（戳=时间戳，limit 每次热传；适配器判定仍用其自身 limit）。
 */
export function saturatingBucket(
  domain = 'xiaohongshu.com',
  limit = DEFAULT_RATE_LIMIT_PER_DOMAIN,
  windowMs = 200,
): DomainTokenBucket {
  const bucket = new DomainTokenBucket({ windowMs })
  // 预灌：创建即向窗口注入高密度时间戳（否则首次 acquire 时窗口未满 → 直接放行）
  for (let i = 0; i < 100; i += 1) bucket.tryAcquire(domain, limit * 100)
  const refill = setInterval(() => {
    bucket.tryAcquire(domain, limit * 100) // 高密度注戳（维持窗口饱和）
  }, 2)
  if (typeof refill.unref === 'function') refill.unref()
  const stop = setTimeout(() => {
    clearInterval(refill)
  }, 5_000)
  if (typeof stop.unref === 'function') stop.unref()
  return bucket
}

// ────────────────────────── 恢复 guard：env 指纹 + 服务基线（只读） ──────────────────────────

/**
 * process.env 指纹（sha256；键值参与哈希但**永不输出原文**）。
 * runner 前后各算一次，assert 相等 = 注入零改写进程 env（零凭据破坏证据）。
 */
export function envFingerprint(): string {
  const entries = Object.entries(process.env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v as string}`)
    .sort()
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

/** 伴随服务基线探针定义（URL 零 key；判定口径与 lifecycle manifests 一致）。 */
export interface ServiceBaselineProbe {
  service: string
  url: string
  accept: 'http-ok' | 'any-response'
  timeoutMs: number
}

export const SERVICE_BASELINE_PROBES: readonly ServiceBaselineProbe[] = [
  { service: 'rail12306', url: 'http://127.0.0.1:8123/health', accept: 'http-ok', timeoutMs: 5_000 },
  { service: 'xhs', url: 'http://127.0.0.1:18060/mcp', accept: 'any-response', timeoutMs: 5_000 },
  { service: 'playwright', url: 'http://localhost:8931/mcp', accept: 'any-response', timeoutMs: 5_000 },
  { service: 'test-env', url: 'http://127.0.0.1:3081/', accept: 'http-ok', timeoutMs: 5_000 },
]

export interface ServiceProbeResult {
  service: string
  url: string
  alive: boolean
  /** HTTP 状态码（any-response 口径下 4xx 也算活；连接失败为 'unreachable'）。 */
  detail: string
}

/** 只读探活（GET；W5 lifecycle probeHealthOnce 同判定路径；零 stop/start）。 */
export async function probeBaseline(probe: ServiceBaselineProbe): Promise<ServiceProbeResult> {
  const result = await probeHealthOnce(
    { url: probe.url, method: 'GET', accept: probe.accept, timeoutMs: probe.timeoutMs },
  )
  const detail = result.error ?? (result.status !== undefined ? `HTTP ${result.status}` : 'no response')
  return { service: probe.service, url: probe.url, alive: result.healthy, detail }
}

export async function probeAllBaselines(): Promise<ServiceProbeResult[]> {
  return Promise.all(SERVICE_BASELINE_PROBES.map(probeBaseline))
}

/** 基线前后对比（恢复 guard 断言数据；alive 类不变=无残留）。 */
export function diffBaselines(
  before: readonly ServiceProbeResult[],
  after: readonly ServiceProbeResult[],
): { unchanged: boolean; changes: string[] } {
  const changes: string[] = []
  for (const b of before) {
    const a = after.find((x) => x.service === b.service)
    if (a === undefined) { changes.push(`${b.service}: after 缺失`); continue }
    if (a.alive !== b.alive) changes.push(`${b.service}: before=${b.alive ? 'alive' : 'down'} after=${a.alive ? 'alive' : 'down'}（${a.detail}）`)
  }
  return { unchanged: changes.length === 0, changes }
}

// ────────────────────────── case 记账（报告数据面） ──────────────────────────

/** 单个 fault case 的执行结果（报告数据面）。 */
export interface FaultCaseResult {
  rowId: string
  group: ChannelGroup
  kind: FaultKind
  /** tool=工具级演练；adapter=适配器面演练（无工具消费位的行）；registered=登记不演练。 */
  scope: 'tool' | 'adapter' | 'registered'
  status: 'pass' | 'fail'
  /** 断言明细：成功=观测到的 degraded/fallback 证据摘要；失败=根因。 */
  evidence: string
  /** 失败根因（status=fail 时非空；零 secret）。 */
  rootCause?: string
  /** 重跑命令（失败行修复后局部重跑用）。 */
  rerun: string
  durationMs: number
}

/** case 成功定义（T7 固定）：无裸异常 + degraded 含 source/code + 不生成空 artifact
 *  + fallback/人工渠道声明兑现（controlled-empty 时人话原因 + 重试入口）。
 *  断言在 runner 内实现，FaultCaseResult 承载结论。 */
export type { FaultKind } from './manifest.js'

