/**
 * 适配器层治理——per-domain 令牌桶（design §9.3-7 / §5.4「每层设频控（默认 10
 * 次/分钟/域，可配）」design.md:395；roadmap M2.6）。
 *
 * 口径取舍（design.md:646 §9.3-7 只有一句：「频控：适配器层令牌桶（默认 10
 * req/min/域），robots/ToS 检查开关默认开」）——按蓝图 T2·W1 展开：
 * - **主口径 = queue**：请求排队至预算窗（滑动窗口最早时间戳滑出即放行），
 *   与 §9.3-7 字面「请求排队至预算窗」一致；等待有窗口级超时兜底（缺省
 *   一个窗口），超时按熔断抛错——防活锁饿死。
 * - **可配口径 = reject（熔断）**：超限立即抛 `RateLimitExceededError`，调用方
 *   catch 后记 degraded 条目（渠道产出 degraded 标注，NFR-4 请求频率控制）。
 *   供高损/硬约束场景（如登录态抓取）选型。
 *
 * 热读取（ADR-12 per-invocation 先例，T1 8d21724）：**limit 每次调用热传**——桶
 * 内不保存 limit（只存窗口时间戳），判定时按传入 limit 计算。配置源
 * （advanced.rateLimitPerDomain）在 base.ts 治理层每次调用读取；改配置后
 * 下一次调用即按新值（窗口内旧时间戳自然兼容：limit 放宽立即放行、收紧
 * 立即限流，无需翻窗）。
 *
 * 与渠道内配额（MAX_POI_CALLS / MAX_L05）的关系：**叠加**。渠道内配额是预算
 * 语义（整个计划/会话的总额），本桶是速率语义（每分钟每域）；互不替代。
 *
 * 供 W2/W3 直抓域（xiaohongshu.com 等）直接调用：`globalRateLimiter` 是跨适配器
 * 同域共享的默认实例（同一域跨渠道也只计一次），测试/定制用
 * `createDomainTokenBucket` 自建实例。
 */
// 只对 base.ts 做 type-only 依赖（运行时方向：base → governance 单向），
// 避免 ESM 循环初始化；degraded 条目按 base.DegradedEntry 契约就地构造。
import type { DegradedEntry } from '../base.js'

/** 预算窗：design.md:395「10 次/分钟/域」→ 固定 60s 窗口。 */
export const RATE_WINDOW_MS = 60_000

/** 频控模式：queue=排队至预算窗（§9.3-7 主口径）；reject=熔断抛错（记 degraded）。 */
export type RateLimitMode = 'queue' | 'reject'

/** 一次预检的决策（非阻塞；调用方自行选择等待或降级）。 */
export interface RateLimitDecision {
  ok: boolean
  /** 触发限流的域。 */
  domain: string
  /** 本次判定使用的 limit（热传值）。 */
  limit: number
  /** ok=false 时：预计等待多久后窗口可放行（毫秒；0 = 立即重试）。 */
  retryAfterMs?: number
}

/**
 * 频控熔断错误：reject 模式超限 / queue 模式等待超预算窗。
 * 调用方 catch 后以 `toDegraded(source, err)` 记 degraded（code UNAVAILABLE，
 * reason 含域与等待期）。
 */
export class RateLimitExceededError extends Error {
  readonly domain: string
  readonly retryAfterMs: number | undefined

  constructor(domain: string, retryAfterMs: number | undefined, message?: string) {
    super(message ?? `频控超限（${domain}${retryAfterMs !== undefined ? `，约 ${Math.ceil(retryAfterMs / 1000)}s 后重试` : ''}）`)
    this.name = 'RateLimitExceededError'
    this.domain = domain
    this.retryAfterMs = retryAfterMs
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * per-domain 滑动窗口令牌桶。
 *
 * 实现：每域维护到达时间戳数组（升序）；判定时先淘汰窗口外的旧戳，窗口内
 * 活跃戳数 < limit 即放行并记戳，否则拒绝/等待。滑动窗口语义=「过去
 * windowMs 内的请求数 ≤ limit」，与「10 req/min」字面一致；时钟经 `now`
 * 注入（测试用 fake timers / setSystemTime 控制）。
 */
export class DomainTokenBucket {
  private readonly windowMs: number
  private readonly now: () => number
  /** domain → 到达时间戳（升序；无压缩——窗口上限=limit，长驻进程内存有界）。 */
  private readonly stamps = new Map<string, number[]>()

  constructor(options: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? RATE_WINDOW_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** 窗口内活跃时间戳（淘汰窗口外旧戳后的新数组；未回写）。 */
  private activeStamps(domain: string, at: number): number[] {
    const cutoff = at - this.windowMs
    const list = this.stamps.get(domain) ?? []
    const active = list.filter((t) => t > cutoff)
    // 主动清理已全失效的域键（防空数组长驻膨胀）
    if (active.length === 0 && list.length > 0) this.stamps.delete(domain)
    return active
  }

  /**
   * 预检 + 占用（非阻塞）。ok=true 表示本次占用成功（已记戳）；
   * ok=false 给出 retryAfterMs 供等待或降级。**limit 每次热传**（热读取）。
   */
  tryAcquire(domain: string, limit: number): RateLimitDecision {
    const at = this.now()
    const active = this.activeStamps(domain, at)
    if (active.length < limit) {
      active.push(at)
      this.stamps.set(domain, active)
      return { ok: true, domain, limit }
    }
    // 窗口满：最早戳滑出即有空位（滑动窗口最短等待）
    const oldest = active[0]
    const retryAfterMs = Math.max(0, oldest + this.windowMs - at)
    return { ok: false, domain, limit, retryAfterMs }
  }

  /**
   * 占用（可等待）：queue 模式等待至预算窗滑出（超 `timeoutMs` 熔断抛错，
   * 缺省 = 一个窗口）；reject 模式超限立即抛 `RateLimitExceededError`。
   * 放行后返回 undefined；失败抛错（不吞）。
   */
  async acquire(
    domain: string,
    limit: number,
    mode: RateLimitMode = 'queue',
    timeoutMs?: number,
  ): Promise<void> {
    const budgetMs = timeoutMs ?? this.windowMs // 「排队至预算窗」= 最多等一个窗口
    const started = this.now()
    for (;;) {
      const decision = this.tryAcquire(domain, limit)
      if (decision.ok) return
      if (mode === 'reject') {
        throw new RateLimitExceededError(domain, decision.retryAfterMs)
      }
      const elapsed = this.now() - started
      const retryAfterMs = decision.retryAfterMs ?? 0
      if (elapsed + retryAfterMs > budgetMs) {
        // 预算窗内仍无法放行（窗口不停被填满）→ 熔断兜底，避免无限等待
        throw new RateLimitExceededError(domain, retryAfterMs, `频控排队超预算窗（${domain}）`)
      }
      await delay(retryAfterMs)
    }
  }

  /** 清空全部（或指定域）窗口时间戳（测试/配置重置用）。 */
  reset(domain?: string): void {
    if (domain !== undefined) {
      this.stamps.delete(domain)
      return
    }
    this.stamps.clear()
  }
}

/** 独立实例工厂（定制/测试）。 */
export function createDomainTokenBucket(options: { windowMs?: number; now?: () => number } = {}): DomainTokenBucket {
  return new DomainTokenBucket(options)
}

/**
 * 跨适配器共享的默认实例：同一域跨渠道共用同一预算窗（「per-domain」语义，
 * 而非 per-渠道）。W2/W3 直抓域（xiaohongshu.com/zhihu.com）直接
 * `await globalRateLimiter.acquire(domain, limit)`。
 */
export const globalRateLimiter = new DomainTokenBucket()

/** 测试/重置入口（防跨用例窗口串扰）。 */
export function resetGlobalRateLimiter(): void {
  globalRateLimiter.reset()
}

/** 快捷记账：频控熔断 → degraded 条目（code UNAVAILABLE；源名由调用方给）。 */
export function rateLimitedEntry(source: string, domain: string, error?: RateLimitExceededError): DegradedEntry {
  const reason = error
    ? `频控超限（${domain}，${Math.ceil((error.retryAfterMs ?? 0) / 1000)}s 后重试）`
    : `频控超限（${domain}）`
  return { source, code: 'UNAVAILABLE', reason, at: new Date().toISOString() }
}