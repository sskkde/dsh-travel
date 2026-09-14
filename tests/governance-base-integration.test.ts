/**
 * M2.6 治理——base.ts 集成测试（roadmap M2.6 Acceptance 全三条：
 * ①频控超限→排队/熔断；②robots 禁抓→该源降级；③配置热读取生效）。
 *
 * 热读取真源 = makeKeyEnv（ADR-12 收口；settings 快照注入）；本文件以
 * 快照切换验证「改 advanced.rateLimitPerDomain 后下次调用按新值」（per-
 * invocation 先例 8d21724）。degraded 记账验证 use-case 拼接：L0.5 直抓域
 * 前置（频控熔断 + robots Disallow）→ DegradedEntry 并入 results.degraded。
 */
import { describe, expect, it } from 'vitest'
import {
  BaseAdapter, EngineError, RateLimitExceededError, governanceConfig,
  type AdapterGovernanceOptions, type DegradedEntry, type KeyResolutionEnv,
  type RateAcquireOptions, type RobotsDecision,
} from '../src/adapters/base.js'
import { makeKeyEnv } from '../src/adapters/env.js'
import { RobotsChecker, type RobotsFetchFn } from '../src/adapters/governance/robots.js'
import { createDomainTokenBucket } from '../src/adapters/governance/token-bucket.js'
import {
  TRAVEL_ADVANCED_DEFAULT, TRAVEL_CHANNELS_DEFAULT,
  type TravelAdvancedSettings, type TravelSettings,
} from '../src/settings/schema.js'

/** settings 快照构造（advanced 局部覆盖；channels 用默认全开）。 */
function settingsWith(overrides: Partial<TravelAdvancedSettings>): TravelSettings {
  return {
    channels: TRAVEL_CHANNELS_DEFAULT,
    keys: {},
    advanced: { ...TRAVEL_ADVANCED_DEFAULT, ...overrides },
  }
}

/** 测试替身适配器：暴露受保护治理方法。 */
class FakeAdapter extends BaseAdapter {
  constructor(governance?: AdapterGovernanceOptions) {
    super('fake-adapter', undefined, governance)
  }

  override async available(): Promise<boolean> {
    return true
  }

  rate(domain: string, env?: KeyResolutionEnv, opts: RateAcquireOptions = {}): Promise<void> {
    return this.acquireRate(domain, { ...opts, env })
  }

  win(domain: string, env?: KeyResolutionEnv) {
    return this.rateWindow(domain, { env })
  }

  robots(url: string, env?: KeyResolutionEnv): Promise<RobotsDecision> {
    return this.robotsCheck(url, { env })
  }

  peek(url: string): RobotsDecision | undefined {
    return this.robotsPeek(url)
  }

  limited(domain: string, err?: RateLimitExceededError): DegradedEntry {
    return this.rateLimited(domain, err)
  }

  blocked(url: string, decision: Extract<RobotsDecision, { allowed: false }>): DegradedEntry {
    return this.robotBlocked(url, decision)
  }
}

/** 小红书 robots（explore 禁抓）。 */
const XHS_ROBOTS = `User-agent: *
Disallow: /explore/
Disallow: /search_result/
Disallow: /api/
`
const XHS_URL = 'https://www.xiaohongshu.com/explore/abc123'

describe('governanceConfig（治理配置热读取：默认值 + advanced.* 位）', () => {
  it('默认：10 req/min/域 + robots 开（design.md:395 / §9.3-7）', () => {
    expect(governanceConfig(undefined)).toEqual({ rateLimitPerDomain: 10, robotsToSCheck: true })
    expect(governanceConfig({})).toEqual({ rateLimitPerDomain: 10, robotsToSCheck: true })
  })

  it('热读 advanced.*：rateLimitPerDomain 数值、robotsToSCheck 布尔', () => {
    const env: KeyResolutionEnv = {
      readSettings: (key) => key === 'advanced.rateLimitPerDomain'
        ? '20'
        : key === 'advanced.robotsToSCheck' ? 'false' : undefined,
    }
    expect(governanceConfig(env)).toEqual({ rateLimitPerDomain: 20, robotsToSCheck: false })
    expect(governanceConfig({
      readSettings: (key) => key === 'advanced.robotsToSCheck' ? 'off' : undefined,
    })).toEqual({ rateLimitPerDomain: 10, robotsToSCheck: false })
  })

  it('非法配置回落默认（NaN/负数/未知布尔不抛错）', () => {
    const env: KeyResolutionEnv = {
      readSettings: (key) => key === 'advanced.rateLimitPerDomain' ? 'abc' : '1e', // '1e' 非布尔
    }
    expect(governanceConfig(env)).toEqual({ rateLimitPerDomain: 10, robotsToSCheck: true })
    expect(governanceConfig({ readSettings: (key) => key === 'advanced.rateLimitPerDomain' ? '-5' : undefined }))
      .toEqual({ rateLimitPerDomain: 10, robotsToSCheck: true })
  })
})

describe('BaseAdapter 治理集成（makeKeyEnv 热读取 + degraded 记账）', () => {
  it('频控经 env 热读：limit=10 满窗后第 11 次熔断；改配置 20 → 下次调用按新值放行', async () => {
    const adapter = new FakeAdapter({ rateLimiter: createDomainTokenBucket() })
    const env10 = makeKeyEnv({}, { settings: settingsWith({ rateLimitPerDomain: 10 }) })
    for (let i = 0; i < 10; i++) {
      await adapter.rate('xiaohongshu.com', env10, { mode: 'reject' })
    }
    // 第 11 次（旧配置 limit=10）：reject 熔断
    await expect(adapter.rate('xiaohongshu.com', env10, { mode: 'reject' }))
      .rejects.toThrow(RateLimitExceededError)
    // 改配置 → 热读新值 20 → 同窗口立即放行（无需翻窗）
    const env20 = makeKeyEnv({}, { settings: settingsWith({ rateLimitPerDomain: 20 }) })
    await adapter.rate('xiaohongshu.com', env20, { mode: 'reject' })
    // 仍按 hot limit 计数：第 21 次再熔断（10+1 次占用后满 20）
    for (let i = 0; i < 9; i++) {
      await adapter.rate('xiaohongshu.com', env20, { mode: 'reject' })
    }
    await expect(adapter.rate('xiaohongshu.com', env20, { mode: 'reject' }))
      .rejects.toThrow(RateLimitExceededError)
  })

  it('rateWindow 非阻塞预检：先查后抓，ok=false 可跳过入队', async () => {
    const adapter = new FakeAdapter({ rateLimiter: createDomainTokenBucket() })
    // 直连桶占满窗口（模拟其他渠道已用）
    for (let i = 0; i < 10; i++) {
      void adapter.win('zhihu.com')
    }
    const denied = adapter.win('zhihu.com')
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.retryAfterMs).toBeGreaterThan(0)
    expect(adapter.win('weibo.com').ok).toBe(true)
  })

  it('robots 开关默认开：Disallow 路径 → 拒绝 + 降级标注（NFR-4）', async () => {
    const seen: Array<{ url: string }> = []
    const fetch: RobotsFetchFn = async (url, init) => {
      seen.push({ url })
      return { status: 200, text: async () => XHS_ROBOTS }
    }
    const checker = new RobotsChecker({ fetch, ua: 'dsh-travel-test' })
    const adapter = new FakeAdapter({ robotsChecker: checker })
    const env = makeKeyEnv({}, { settings: settingsWith({}) }) // robotsToSCheck 默认 true
    const decision = await adapter.robots(XHS_URL, env)
    expect(decision.allowed).toBe(false)
    const entry = decision.allowed ? undefined : adapter.blocked(XHS_URL, decision)
    expect(entry).toMatchObject({ source: 'fake-adapter', code: 'UNAVAILABLE' })
    expect(entry?.reason).toContain('robots.txt Disallow 禁抓')
    expect(entry?.reason).toContain(XHS_URL)
    expect(seen.some((s) => s.url === 'https://www.xiaohongshu.com/robots.txt')).toBe(true)
  })

  it('robots 开关热读关闭（advanced.robotsToSCheck=false）→ 跳过检查直接放行（不抓 robots.txt）', async () => {
    let fetchCount = 0
    const checker = new RobotsChecker({
      fetch: async (url, init) => { fetchCount += 1; return { status: 200, text: async () => XHS_ROBOTS } },
    })
    const adapter = new FakeAdapter({ robotsChecker: checker })
    const env = makeKeyEnv({}, { settings: settingsWith({ robotsToSCheck: false }) })
    const decision = await adapter.robots(XHS_URL, env)
    expect(decision.allowed).toBe(true) // 关掉检查 → 放行
    expect(fetchCount).toBe(0) // 未发起 robots.txt 抓取
  })

  it('robotsPeek：缓存命中同步预检', async () => {
    const checker = new RobotsChecker({
      fetch: async (url, init) => ({ status: 200, text: async () => XHS_ROBOTS }),
    })
    const adapter = new FakeAdapter({ robotsChecker: checker })
    expect(adapter.peek(XHS_URL)).toBeUndefined() // 未缓存 → undefined
    await adapter.robots(XHS_URL)
    const hit = adapter.peek('https://www.xiaohongshu.com/explore/other')
    expect(hit?.allowed).toBe(false)
  })

  it('use-case 拼接：L0.5 直抓域前置——频控熔断 + robots Disallow → 两条 degraded 标注', async () => {
    const adapter = new FakeAdapter({
      rateLimiter: createDomainTokenBucket(),
      robotsChecker: new RobotsChecker({
        fetch: async (url, init) => ({ status: 200, text: async () => XHS_ROBOTS }),
      }),
    })
    const results: { degraded: DegradedEntry[] } = { degraded: [] }
    const domain = 'xiaohongshu.com'

    // ① 频控（reject 熔断 → degraded）
    await adapter.rate(domain, undefined, { mode: 'reject', limit: 1 })
    try {
      await adapter.rate(domain, undefined, { mode: 'reject', limit: 1 })
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        results.degraded.push(adapter.limited(domain, err))
      } else {
        throw err
      }
    }

    // ② robots（Disallow → 跳过直抓 + degraded）
    const decision = await adapter.robots(XHS_URL)
    if (!decision.allowed) results.degraded.push(adapter.blocked(XHS_URL, decision))

    expect(results.degraded).toHaveLength(2)
    expect(results.degraded[0]).toMatchObject({ source: 'fake-adapter', code: 'UNAVAILABLE' })
    expect(results.degraded[0].reason).toContain('频控超限')
    expect(results.degraded[1].reason).toContain('robots.txt Disallow 禁抓')

    // degraded 条目与现有记账面相容（EngineError/toDegraded 链路）
    const viaError = EngineError.unavailable(results.degraded[0].reason, 'fake-adapter')
    expect(viaError).toBeInstanceOf(EngineError)
    expect(viaError.code).toBe('UNAVAILABLE')
  })

  it('BaseAdapter 兼容：不传治理参数（M1 现状）构造正常', async () => {
    const adapter = new FakeAdapter()
    await expect(adapter.available()).resolves.toBe(true)
    expect(governanceConfig(undefined).rateLimitPerDomain).toBe(10)
  })
})