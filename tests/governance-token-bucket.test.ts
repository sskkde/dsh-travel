/**
 * M2.6 治理——per-domain 令牌桶单测（design §9.3-7 / design.md:395 默认 10 req/min/域；
 * roadmap M2.6 DoD：频控超限→排队/熔断用例）。
 *
 * 时钟口径：`vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','Date'] })` +
 * `vi.setSystemTime`——桶的 `now` 走 Date.now（被 fake），排队等待走 setTimeout
 * （被 fake）；`vi.advanceTimersByTimeAsync` 同步推进两者并 flush 微任务，
 * 使 queue 模式的放行在 await 语义下确定。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  DomainTokenBucket, RateLimitExceededError, createDomainTokenBucket,
  rateLimitedEntry, resetGlobalRateLimiter,
} from '../src/adapters/governance/token-bucket.js'

const T0 = new Date('2026-10-01T00:00:00.000Z')

describe('DomainTokenBucket（per-domain 令牌桶，默认 10 req/min/域）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(T0)
    resetGlobalRateLimiter()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('happy：正常速率（< limit）请求全过，无排队无熔断', () => {
    const bucket = createDomainTokenBucket()
    const decisions = Array.from({ length: 9 }, () => bucket.tryAcquire('xiaohongshu.com', 10))
    expect(decisions).toHaveLength(9)
    expect(decisions.every((d) => d.ok)).toBe(true)
  })

  it('同域第 11 次/分钟 → 窗口满拒绝（retryAfterMs=60s），窗口滑出后放行', () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryAcquire('xiaohongshu.com', 10).ok).toBe(true)
    }
    const denied = bucket.tryAcquire('xiaohongshu.com', 10)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterMs).toBe(60_000)
    // 60s 后最早时间戳滑出 → 空位出现
    vi.advanceTimersByTime(60_001)
    expect(bucket.tryAcquire('xiaohongshu.com', 10).ok).toBe(true)
  })

  it('queue 模式：第 11 次排队至预算窗，窗口滑出后放行（fake timers）', async () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      void bucket.acquire('zhihu.com', 10) // 前 10 个立即放行
    }
    const eleventh = bucket.acquire('zhihu.com', 10) // 第 11 个排队
    let settled = false
    void eleventh.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1_000) // 窗口内：仍未放行
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000) // 预算窗滑出
    await eleventh
    expect(settled).toBe(true)
  })

  it('滑动窗口最短等待：第 11 次在窗口过半处 → 只等余下 ~30s', async () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      void bucket.acquire('tieba.baidu.com', 10)
    }
    vi.advanceTimersByTime(30_000) // 窗口过半
    const eleventh = bucket.acquire('tieba.baidu.com', 10)
    let settled = false
    void eleventh.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(29_000) // 未到最早戳滑出
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000) // 共 31s → t0+60s 边界
    await eleventh
    expect(settled).toBe(true)
  })

  it('reject 模式：第 11 次立即抛 RateLimitExceededError（熔断）', async () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      void bucket.acquire('weibo.com', 10)
    }
    await expect(bucket.acquire('weibo.com', 10, 'reject')).rejects.toThrow(RateLimitExceededError)
  })

  it('熔断 → rateLimitedEntry 记账：code UNAVAILABLE + 域/等待期入 reason', async () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      void bucket.acquire('xiaohongshu.com', 10)
    }
    let caught: RateLimitExceededError | undefined
    try {
      await bucket.acquire('xiaohongshu.com', 10, 'reject')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExceededError)
      caught = err as RateLimitExceededError
    }
    expect(caught?.domain).toBe('xiaohongshu.com')
    const entry = rateLimitedEntry('search-l0.5', 'xiaohongshu.com', caught)
    expect(entry).toMatchObject({ source: 'search-l0.5', code: 'UNAVAILABLE' })
    expect(entry.reason).toContain('频控超限')
    expect(entry.reason).toContain('xiaohongshu.com')
    expect(caught?.retryAfterMs).toBeGreaterThan(0)
  })

  it('queue 排队超预算窗 → 熔断抛错（防饿死兜底）', async () => {
    const bucket = createDomainTokenBucket()
    void bucket.acquire('weibo.com', 1) // 唯一配额占用
    vi.advanceTimersByTime(1_000)
    // 第 2 个还需 ~59s，timeoutMs=100 → 超预算窗立即熔断
    await expect(bucket.acquire('weibo.com', 1, 'queue', 100)).rejects.toThrow(RateLimitExceededError)
  })

  it('热读取：limit 每次调用热传——放宽后同一窗口立即放行、收紧立即限流', () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryAcquire('tieba.baidu.com', 10).ok).toBe(true)
    }
    expect(bucket.tryAcquire('tieba.baidu.com', 10).ok).toBe(false) // 旧 limit 满
    expect(bucket.tryAcquire('tieba.baidu.com', 20).ok).toBe(true) // 配置放宽 → 立即放行（窗口未翻）
    expect(bucket.tryAcquire('tieba.baidu.com', 10).ok).toBe(false) // 回落旧 limit → 仍满
  })

  it('跨域隔离：A 域打满不影响 B 域', () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      void bucket.acquire('a.example.com', 10)
    }
    expect(bucket.tryAcquire('b.example.com', 10).ok).toBe(true)
    expect(bucket.tryAcquire('a.example.com', 10).ok).toBe(false)
  })

  it('reset：清空指定域或全窗', () => {
    const bucket = createDomainTokenBucket()
    for (let i = 0; i < 10; i++) {
      void bucket.acquire('a.example.com', 10)
      void bucket.acquire('b.example.com', 10)
    }
    bucket.reset('a.example.com')
    expect(bucket.tryAcquire('a.example.com', 10).ok).toBe(true)
    expect(bucket.tryAcquire('b.example.com', 10).ok).toBe(false)
    bucket.reset()
    expect(bucket.tryAcquire('b.example.com', 10).ok).toBe(true)
  })

  it('默认参数：windowMs 60s / 构造注入 now 时钟', () => {
    const bucket = new DomainTokenBucket()
    expect(bucket.tryAcquire('d', 1).ok).toBe(true)
    const controlled = createDomainTokenBucket({ windowMs: 10_000, now: () => 1_000 })
    expect(controlled.tryAcquire('d', 1).ok).toBe(true)
    expect(controlled.tryAcquire('d', 1).ok).toBe(false) // 容量 1 满
  })
})