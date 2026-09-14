/**
 * M3.3 用量统计单测（UsageRecorder + 埋点 + /travel-metrics 路由 + UsagePanel 纯逻辑）。
 *
 * 覆盖（执行计划 T4 Acceptance）：
 * - AMap 每次调用精确计数（logical/quota/network/POI/REST 分别断言；配额熔断也计 logical）；
 * - 缓存 hit/miss 分母与 rate；search L0/L0.5 计数；
 * - fanout attempts/retries + degraded source×code 聚合 + plan 归因（ALS）；
 * - governance：rate-limit 拒绝 / robots 拦截（base 治理组合埋点）；
 * - 跨月自动 reset（内存 + 持久化装载两个口径）；
 * - 并发原子写不损坏（并发 flush 可解析、计数不丢）；
 * - 损坏文件恢复（备份改名 + 重建空 snapshot + warning，不抛、不使 research 失败）；
 * - HTTP projection 零 secret（字段白名单 + key 明文不落盘）+ 非 GET/未授权来源拒绝；
 * - UsagePanel：视图模型/状态机纯逻辑断言（参考 client-settings-form 的纯逻辑形态）
 *   + 组件元素冒烟 + client/node 路由字面量一致性。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createElement } from 'react'
import type { IncomingMessage } from 'node:http'
import {
  UsageRecorder, setDefaultUsageRecorder, projectUsage,
  makeTravelMetricsHandler, makeCloakClearHandler,
  TRAVEL_METRICS_PATH, TRAVEL_METRICS_CLOAK_CLEAR_PATH,
  USAGE_UNKNOWN_PLAN, usageEntryKey,
  type TravelMetricsProjection,
} from '../src/metrics/usage.js'
import { AmapAdapter, QuotaCounter } from '../src/adapters/amap.js'
import { SearchAdapter } from '../src/adapters/search.js'
import { runChannelFanout } from '../src/orchestrator/fanout.js'
import { BaseAdapter, EngineError, RateLimitExceededError, type RateLimitMode, type RobotsDecision } from '../src/adapters/base.js'
import { RobotsChecker } from '../src/adapters/governance/robots.js'
import type { CanonicalQuery, KeyResolutionEnv } from '../src/adapters/base.js'
import {
  UsagePanel, buildUsageViewModel, createUsagePanelState, applyUsagePanelAction,
  USAGE_METRICS_PATH, USAGE_CLOAK_CLEAR_PATH,
} from '../src/client/UsagePanel'

// ────────────────────────── 测试基建 ──────────────────────────

let tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  setDefaultUsageRecorder(undefined)
})

/** 独立临时目录（含 .dsh-travel 父目录）+ usage.json 路径。 */
function tempUsageFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-travel-usage-'))
  tempRoots.push(root)
  const filePath = join(root, '.dsh-travel', 'usage.json')
  mkdirSync(dirname(filePath), { recursive: true })
  return filePath
}

/** 离线 amap stub：geocode/place/text 两端点回最小合法响应（无网络）。 */
function stubAmapFetch(): { fetchFn: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>; urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetchFn: async (url) => {
      urls.push(url)
      const body = url.includes('place/text')
        ? { status: '1', pois: [{ id: 'p1', name: '西湖', location: '120.13,30.25', address: '杭州' }] }
        : { status: '1', geocodes: [{ location: '120.1,30.2' }] }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    },
  }
}

const ENV_KEY: KeyResolutionEnv = { env: { amapWebservice: 'SECRET-AMAP-KEY-XYZ' } }

/** render-proxy.test.ts 同款假响应/请求。 */
class FakeResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''
  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode
    this.headers = { ...headers }
    return this
  }
  end(chunk?: string | Uint8Array): void {
    this.body = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
}

function request(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage
}

function responseOf(fake: FakeResponse): import('node:http').ServerResponse {
  return fake as unknown as import('node:http').ServerResponse
}

// ────────────────────────── AMap 精确计数 ──────────────────────────

describe('UsageRecorder：AMap logical/quota/network 分别计数', () => {
  it('geocode×2（第二次缓存命中）+ poiSearch×1 → 各计数精确', async () => {
    const filePath = tempUsageFile()
    const rec = new UsageRecorder({ filePath })
    const stub = stubAmapFetch()
    const adapter = new AmapAdapter({ fetchFn: stub.fetchFn, usage: rec })
    await adapter.geocode('西湖', '330100', ENV_KEY)
    await adapter.geocode('西湖', '330100', ENV_KEY) // 同参 → 缓存命中（M2 语义：quota 先于 cache，仍消耗配额）
    await adapter.poiSearch('西湖', '杭州', {}, ENV_KEY)

    const entry = rec.snapshot().entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]
    expect(entry).toBeDefined()
    expect(entry?.logical).toBe(3) // 三次业务调用（含缓存命中）
    expect(entry?.quota).toBe(3) // quota-acquire-before-cache 语义保持：命中也算配额
    expect(entry?.rest).toBe(2) // geocode 是 REST 类
    expect(entry?.poi).toBe(1) // poiSearch 是 POI 类
    expect(entry?.network).toBe(2) // 仅两次真实网络（第二次 geocode 走缓存）
    expect(entry?.cacheHits).toBe(1)
    expect(entry?.cacheMisses).toBe(2)
    expect(stub.urls.filter((u) => u.includes('geocode/geo'))).toHaveLength(1)
  })

  it('quota-acquire 拒绝：logical 照计、quota 不计 + degraded 聚合 UNAVAILABLE', async () => {
    const filePath = tempUsageFile()
    const rec = new UsageRecorder({ filePath })
    const stub = stubAmapFetch()
    const quota = new QuotaCounter({ monthlyLimit: 10, poiLimit: 1 })
    const adapter = new AmapAdapter({ fetchFn: stub.fetchFn, quota, usage: rec })
    await adapter.poiSearch('西湖', '杭州', {}, ENV_KEY)
    await expect(adapter.poiSearch('灵隐寺', '杭州', {}, ENV_KEY)).rejects.toBeInstanceOf(EngineError)

    const entry = rec.snapshot().entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]
    expect(entry?.logical).toBe(2) // 被熔断的调用也算业务调用
    expect(entry?.quota).toBe(1) // 放行仅一次
    expect(entry?.poi).toBe(1)
    expect(entry?.degraded.UNAVAILABLE).toBe(1) // 熔断经 degraded 记账聚合
  })

  it('runWithPlan 作用域：链路内调用归属 planId（ALS）', async () => {
    const rec = new UsageRecorder({ persist: false })
    await rec.runWithPlan('plan-9', async () => {
      rec.recordAmapLogical()
      rec.recordAmapQuota('rest')
    })
    rec.recordAmapLogical() // 作用域外 → 兜底桶
    const entries = rec.snapshot().entries
    expect(entries[usageEntryKey('amap', 'plan-9')]?.quota).toBe(1)
    expect(entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]?.logical).toBe(1)
    expect(entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]?.quota).toBe(0)
  })

  it('零 secret：key 明文不进 usage.json 也不进 HTTP projection', async () => {
    const filePath = tempUsageFile()
    const rec = new UsageRecorder({ filePath })
    const stub = stubAmapFetch()
    const adapter = new AmapAdapter({ fetchFn: stub.fetchFn, usage: rec })
    await adapter.geocode('西湖', '330100', ENV_KEY)
    await rec.flush()
    const persisted = readFileSync(filePath, 'utf8')
    expect(persisted).not.toContain('SECRET-AMAP-KEY-XYZ')
    expect(persisted).not.toContain('key')
    const projection = JSON.stringify(rec.projection())
    expect(projection).not.toContain('SECRET-AMAP-KEY-XYZ')
  })
})

// ────────────────────────── 缓存 rate / search / fanout / governance ──────────────────────────

describe('UsageRecorder：缓存分母与 rate', () => {
  it('rate = hits/(hits+misses)，跨 source 聚合；分母 0 → null', () => {
    const rec = new UsageRecorder({ persist: false })
    rec.recordCache('amap', true)
    rec.recordCache('amap', false)
    rec.recordCache('search-l0.5', true)
    rec.recordCache('search-l0.5', true)
    const projection = rec.projection()
    expect(projection.cache.hits).toBe(3)
    expect(projection.cache.misses).toBe(1)
    expect(projection.cache.rate).toBeCloseTo(0.75, 10)
    expect(new UsageRecorder({ persist: false }).projection().cache.rate).toBeNull()
  })

  it('projectUsage：amap/search/fanout 聚合 + degraded source×code 排序稳定', () => {
    const rec = new UsageRecorder({ persist: false })
    rec.recordAmapLogical()
    rec.recordAmapQuota('poi')
    rec.recordSearchL0(2)
    rec.recordSearchL05Fetch()
    rec.recordFanout('attempt')
    rec.recordFanout('retry')
    rec.recordRateLimitReject('xhs')
    rec.recordRobotsBlocked('search-l0.5')
    rec.recordDegraded('search-l0', 'EMPTY')
    rec.recordDegraded('search-l0', 'UNAVAILABLE')
    rec.recordDegraded('amap', 'UNAVAILABLE')
    rec.recordDegraded('amap', 'UNAVAILABLE')
    const projection = projectUsage(rec.snapshot(), { amapMonthlyLimit: 1234, now: new Date('2026-09-05T00:00:00Z') })
    expect(projection.amap).toMatchObject({ logical: 1, quota: 1, poi: 1, rest: 0, monthlyLimit: 1234 })
    expect(projection.search).toEqual({ l0Queries: 2, l05Fetches: 1 })
    expect(projection.fanout).toEqual({ attempts: 1, retries: 1 })
    expect(projection.governance).toEqual({ rateLimitRejects: 1, robotsBlocked: 1 })
    expect(projection.degraded[0]).toEqual({ source: 'amap', code: 'UNAVAILABLE', count: 2 })
    expect(projection.degraded.map((d) => `${d.source}:${d.code}`)).toEqual(['amap:UNAVAILABLE', 'search-l0:EMPTY', 'search-l0:UNAVAILABLE'])
  })
})

describe('UsageRecorder：search L0/L0.5 计数（SearchAdapter 埋点）', () => {
  it('L0：site: 变体 + 裸关键词 → 每次 hostSearch 调用计 1', async () => {
    const rec = new UsageRecorder({ persist: false })
    let hostCalls = 0
    const search = new SearchAdapter({
      usage: rec,
      hostSearch: async () => {
        hostCalls += 1
        return { content: '', sources: [{ url: 'https://www.xiaohongshu.com/explore/abc?xsec_token=t' }], truncated: false }
      },
    })
    await search.searchL0({ keywords: '武汉 美食', sites: ['xiaohongshu.com'] })
    expect(hostCalls).toBe(2)
    expect(rec.snapshot().entries[usageEntryKey('search-l0', USAGE_UNKNOWN_PLAN)]?.searchL0Queries).toBe(2)
  })

  it('L0.5：未命中=直抓+network；命中=缓存（不重复计网络）', async () => {
    const rec = new UsageRecorder({ persist: false })
    let fetches = 0
    const ssr = JSON.stringify({
      note: { noteDetailMap: { abc123: { note: { title: '西湖一日游', desc: '正文内容', user: { nickname: 'n' }, interactInfo: { likedCount: '3' }, time: 1700000000000 } } } },
    })
    const search = new SearchAdapter({
      usage: rec,
      fetchHtml: async () => {
        fetches += 1
        return { status: 200, text: `<html><script>window.__INITIAL_STATE__=${ssr};</script></html>` }
      },
    })
    const url = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=t'
    const first = await search.fetchXhsNote(url)
    expect(first.cached).toBe(false)
    const second = await search.fetchXhsNote(url)
    expect(second.cached).toBe(true)

    const entry = rec.snapshot().entries[usageEntryKey('search-l0.5', USAGE_UNKNOWN_PLAN)]
    expect(entry?.searchL05Fetches).toBe(1)
    expect(entry?.network).toBe(1)
    expect(entry?.cacheMisses).toBe(1)
    expect(entry?.cacheHits).toBe(1)
    expect(fetches).toBe(1)
  })
})

describe('fanout 埋点：attempts/retries/degraded + plan 归因（只观测，编排语义不变）', () => {
  it('失败 2 次第 3 次成功 → attempts=3 retries=2；链路内 amap 调用归属 query.planId', async () => {
    const rec = new UsageRecorder({ persist: false })
    setDefaultUsageRecorder(rec)
    const stub = stubAmapFetch()
    const amap = new AmapAdapter({ fetchFn: stub.fetchFn, usage: rec })
    let runs = 0
    const channel = {
      name: 'metrics-ch',
      available: async () => true,
      run: async () => {
        runs += 1
        if (runs < 3) return { ok: false as const, code: 'UNAVAILABLE' as const, reason: '瞬时抖动' }
        await amap.geocode('西湖', '330100', ENV_KEY) // fan-out 链路内的适配器调用
        return { ok: true as const, items: [] }
      },
    }
    const query: CanonicalQuery = { planId: 'plan-77', destination: '杭州' }
    const result = await runChannelFanout({ channels: [channel], query, budgetMs: 5000, retryDelaysMs: [1, 1] })
    expect(runs).toBe(3)
    expect(result.degraded).toEqual([]) // 最终成功不产生 degraded（原语义）

    const entries = rec.snapshot().entries
    expect(entries[usageEntryKey('fanout', 'plan-77')]).toMatchObject({ fanoutAttempts: 3, fanoutRetries: 2 })
    // ALS plan 归因：fan-out 链路内 amap 调用落入 plan-77 而非兜底桶
    expect(entries[usageEntryKey('amap', 'plan-77')]).toMatchObject({ logical: 1, quota: 1, rest: 1, network: 1 })
    expect(entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]).toBeUndefined()
  })

  it('持续失败渠道 → 最终 outcome 记 degraded（不逐次膨胀）；复用计划 resetPlanBudget 回调照常触发', async () => {
    const rec = new UsageRecorder({ persist: false })
    setDefaultUsageRecorder(rec)
    let resets = 0
    const failing = {
      name: 'failing-ch',
      available: async () => true,
      run: async () => ({ ok: false as const, code: 'UNAVAILABLE' as const, reason: '持续失败' }),
    }
    const empty = {
      name: 'empty-ch',
      available: async () => true,
      run: async () => ({ ok: false as const, code: 'EMPTY' as const, reason: '无结果' }),
    }
    const result = await runChannelFanout({
      channels: [failing, empty],
      query: { planId: 'plan-8' },
      budgetMs: 5000,
      retryDelaysMs: [1, 1],
      resetPlanBudget: () => { resets += 1 },
    })
    expect(resets).toBe(1)
    expect(result.degraded).toHaveLength(2)
    const entries = rec.snapshot().entries
    expect(entries[usageEntryKey('failing-ch', 'plan-8')]?.degraded.UNAVAILABLE).toBe(1) // 只记最终失败一次
    expect(entries[usageEntryKey('empty-ch', 'plan-8')]?.degraded.EMPTY).toBe(1)
    expect(entries[usageEntryKey('fanout', 'plan-8')]).toMatchObject({ fanoutAttempts: 4, fanoutRetries: 2 }) // failing 3+empty 1
  })
})

describe('governance 埋点（base 治理组合：频控拒绝 / robots 拦截）', () => {
  /** 最小探针适配器：暴露受保护治理面（语义与生产适配器一致；recorder 显式注入便于断言）。 */
  class GovernedProbe extends BaseAdapter {
    constructor(usage?: UsageRecorder) {
      super('probe', { supports: new Set<string>() }, {
        usage,
        robotsChecker: new RobotsChecker({
          fetch: async () => ({ status: 200, text: async () => 'User-agent: *\nDisallow: /' }),
        }),
      })
    }
    override async available(): Promise<boolean> {
      return true
    }
    rate(domain: string, mode: RateLimitMode): Promise<void> {
      return this.acquireRate(domain, { limit: 1, mode })
    }
    robots(url: string): Promise<RobotsDecision> {
      return this.robotsCheck(url, { env: { env: {} } })
    }
  }

  it('robots Disallow → decision 原样返回 + robotsBlocked 计数', async () => {
    const rec = new UsageRecorder({ persist: false })
    const probe = new GovernedProbe(rec)
    const decision = await probe.robots('https://blocked.example.com/private')
    expect(decision.allowed).toBe(false)
    expect(rec.snapshot().entries[usageEntryKey('probe', USAGE_UNKNOWN_PLAN)]?.robotsBlocked).toBe(1)
  })

  it('reject 模式超限 → RateLimitExceededError 原样上抛 + rateLimitRejects 计数', async () => {
    const rec = new UsageRecorder({ persist: false })
    const probe = new GovernedProbe(rec)
    await probe.rate('probe-rl.example.com', 'reject')
    await expect(probe.rate('probe-rl.example.com', 'reject')).rejects.toBeInstanceOf(RateLimitExceededError)
    const entry = rec.snapshot().entries[usageEntryKey('probe', USAGE_UNKNOWN_PLAN)]
    expect(entry?.rateLimitRejects).toBe(1)
  })

  it('robotsToSCheck 关闭 → 直接放行且不计数（原语义）', async () => {
    const rec = new UsageRecorder({ persist: false })
    class OffSwitchProbe extends BaseAdapter {
      constructor() {
        super('probe-off', { supports: new Set<string>() }, { usage: rec })
      }
      override async available(): Promise<boolean> {
        return true
      }
      robots(): Promise<RobotsDecision> {
        return this.robotsCheck('https://off.example.com/x', { env: { readSettings: (key) => (key === 'advanced.robotsToSCheck' ? 'false' : undefined), env: {} } })
      }
    }
    const off = new OffSwitchProbe()
    const offDecision = await off.robots()
    expect(offDecision.allowed).toBe(true)
    expect(rec.snapshot().entries[usageEntryKey('probe-off', USAGE_UNKNOWN_PLAN)]?.robotsBlocked ?? 0).toBe(0)
  })
})

// ────────────────────────── 持久化：跨月 reset / 并发原子写 / 损坏恢复 ──────────────────────────

describe('UsageRecorder：跨月自动 reset', () => {
  it('月份变更 → 计数清零 + lastResetAt 刷新（内存口径）', async () => {
    const filePath = tempUsageFile()
    let now = new Date('2026-09-15T00:00:00Z')
    const rec = new UsageRecorder({ filePath, now: () => now })
    rec.recordAmapLogical()
    rec.recordAmapQuota('rest')
    await rec.flush()
    expect(JSON.parse(readFileSync(filePath, 'utf8')).month).toBe('2026-09')

    now = new Date('2026-10-01T00:00:00Z')
    rec.recordSearchL0()
    const snapshot = rec.snapshot()
    expect(snapshot.month).toBe('2026-10')
    expect(snapshot.lastResetAt).toBe('2026-10-01T00:00:00.000Z')
    expect(snapshot.entries[usageEntryKey('search-l0', USAGE_UNKNOWN_PLAN)]?.searchL0Queries).toBe(1)
    expect(snapshot.entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]).toBeUndefined()
  })

  it('装载历史月份文件 → 直接空快照启动（不判损坏、不备份）', async () => {
    const filePath = tempUsageFile()
    let now = new Date('2026-09-15T00:00:00Z')
    const first = new UsageRecorder({ filePath, now: () => now })
    first.recordAmapLogical()
    await first.flush()

    now = new Date('2026-10-02T00:00:00Z')
    const warnings: string[] = []
    const second = new UsageRecorder({ filePath, now: () => now, warn: (m) => warnings.push(m) })
    expect(second.snapshot().entries).toEqual({})
    expect(second.snapshot().month).toBe('2026-10')
    await second.flush()
    expect(JSON.parse(readFileSync(filePath, 'utf8')).entries).toEqual({})
    expect(readdirSync(dirname(filePath)).filter((f) => f.includes('.corrupt-'))).toEqual([])
  })
})

describe('UsageRecorder：并发原子写不损坏', () => {
  it('12 路并发 flush → 文件可解析且计数不丢', async () => {
    const filePath = tempUsageFile()
    const rec = new UsageRecorder({ filePath })
    for (let i = 0; i < 8; i += 1) rec.recordAmapLogical()
    await Promise.all(Array.from({ length: 12 }, () => rec.flush()))
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as UsageSnapshotLike
    expect(parsed.entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]?.logical).toBe(8)
  })

  it('并发记录 + 并发 flush 混流 → 文件始终可解析、最终计数收敛', async () => {
    const filePath = tempUsageFile()
    const rec = new UsageRecorder({ filePath })
    rec.recordAmapLogical()
    await Promise.all(Array.from({ length: 24 }, () => {
      rec.recordSearchL0()
      return rec.flush()
    }))
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as UsageSnapshotLike
    expect(parsed.entries[usageEntryKey('search-l0', USAGE_UNKNOWN_PLAN)]?.searchL0Queries).toBe(24)
    expect(parsed.entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]?.logical).toBe(1)
  })
})

interface UsageSnapshotLike {
  month: string
  entries: Record<string, Record<string, number | Record<string, number>> | undefined>
}

describe('UsageRecorder：损坏文件恢复（不使 research 失败）', () => {
  it('坏 JSON → 改名备份 + 重建空 snapshot + warning；flush 重建合法文件', async () => {
    const filePath = tempUsageFile()
    writeFileSync(filePath, '{"version":1,"month":"2026-09","entr', 'utf8')
    const warnings: string[] = []
    const rec = new UsageRecorder({ filePath, warn: (m) => warnings.push(m) }) // 构造不抛

    const backups = readdirSync(dirname(filePath)).filter((f) => f.startsWith('usage.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(filePath), backups[0] ?? ''), 'utf8')).toContain('"entr')
    expect(existsSync(filePath)).toBe(false)
    expect(rec.snapshot().entries).toEqual({})
    expect(warnings.some((w) => w.includes('usage.json'))).toBe(true)

    rec.recordAmapLogical()
    const outcome = await rec.flush()
    expect(outcome.ok).toBe(true)
    const revived = JSON.parse(readFileSync(filePath, 'utf8')) as UsageSnapshotLike
    expect(revived.entries[usageEntryKey('amap', USAGE_UNKNOWN_PLAN)]?.logical).toBe(1)
  })

  it('结构不合法的合法 JSON（version 缺失）→ 同样走备份重建分支', async () => {
    const filePath = tempUsageFile()
    writeFileSync(filePath, '{"hello":"world"}', 'utf8')
    const rec = new UsageRecorder({ filePath, warn: () => {} })
    expect(rec.snapshot().entries).toEqual({})
    expect(readdirSync(dirname(filePath)).filter((f) => f.startsWith('usage.json.corrupt-'))).toHaveLength(1)
  })
})

// ────────────────────────── HTTP：/travel-metrics 与 cloak 清除路由 ──────────────────────────

describe('GET /travel-metrics（只读同源）', () => {
  it('200 + redacted projection：字段白名单（零 secret 结构）', async () => {
    const rec = new UsageRecorder({ persist: false })
    rec.recordAmapLogical()
    rec.recordAmapQuota('rest')
    rec.recordDegraded('search-l0', 'EMPTY')
    const handler = makeTravelMetricsHandler(rec, { amapMonthlyLimit: 5000 })
    const res = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_PATH}?t=1`, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body) as TravelMetricsProjection
    expect(Object.keys(body).sort()).toEqual([
      'amap', 'cache', 'degraded', 'entries', 'fanout', 'generatedAt', 'governance', 'lastResetAt', 'month', 'search',
    ])
    expect(Object.keys(body.entries[0] ?? {}).sort()).toEqual([
      'cacheHits', 'cacheMisses', 'degraded', 'fanoutAttempts', 'fanoutRetries', 'logical', 'network',
      'planId', 'poi', 'quota', 'rateLimitRejects', 'rest', 'robotsBlocked', 'searchL05Fetches', 'searchL0Queries', 'source',
    ])
    expect(body.amap).toMatchObject({ quota: 1, rest: 1, monthlyLimit: 5000 })
    expect(body.degraded).toEqual([{ source: 'search-l0', code: 'EMPTY', count: 1 }])
  })

  it('非 GET → 405（allow: GET）', async () => {
    const handler = makeTravelMetricsHandler(new UsageRecorder({ persist: false }))
    const res = new FakeResponse()
    await handler(request(TRAVEL_METRICS_PATH, 'POST', { host: '127.0.0.1:3081' }), responseOf(res))
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('GET')
  })

  it('未授权来源 → 403：非回环 Host / 外站 Origin / 缺 Host', async () => {
    const handler = makeTravelMetricsHandler(new UsageRecorder({ persist: false }))
    for (const headers of [
      { host: 'evil.example.com:3081' }, // DNS rebinding 形态
      { host: '127.0.0.1:3081', origin: 'https://evil.example.com' }, // 外站页面 fetch
      { host: '127.0.0.1:3081', referer: 'https://evil.example.com/x' },
      {}, // 缺 Host
    ]) {
      const res = new FakeResponse()
      await handler(request(TRAVEL_METRICS_PATH, 'GET', headers), responseOf(res))
      expect(res.statusCode).toBe(403)
    }
  })

  it('本机 UI 跨端口 fetch（回环 Origin）→ 200', async () => {
    const handler = makeTravelMetricsHandler(new UsageRecorder({ persist: false }))
    const res = new FakeResponse()
    await handler(request(TRAVEL_METRICS_PATH, 'GET', { host: '127.0.0.1:3081', origin: 'http://localhost:3000' }), responseOf(res))
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /travel-metrics/cloak-clear（受控清除位；不激活 hook）', () => {
  it('GET → 405（防 GET 误触；allow: POST），不执行清除', async () => {
    let cleared = 0
    const handler = makeCloakClearHandler(() => { cleared += 1; return true })
    const res = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_CLOAK_CLEAR_PATH}?confirm=clear`, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('POST')
    expect(cleared).toBe(0)
  })

  it('缺/错 confirm → 400；正确 confirm → 200 {ok,cleared}', async () => {
    let cleared = 0
    const handler = makeCloakClearHandler(() => { cleared += 1; return true })
    const missing = new FakeResponse()
    await handler(request(TRAVEL_METRICS_CLOAK_CLEAR_PATH, 'POST', { host: '127.0.0.1:3081' }), responseOf(missing))
    expect(missing.statusCode).toBe(400)
    const wrong = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_CLOAK_CLEAR_PATH}?confirm=CLEAR`, 'POST', { host: '127.0.0.1:3081' }), responseOf(wrong))
    expect(wrong.statusCode).toBe(400)
    expect(cleared).toBe(0)

    const ok = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_CLOAK_CLEAR_PATH}?confirm=clear`, 'POST', { host: '127.0.0.1:3081' }), responseOf(ok))
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ ok: true, cleared: true })
    expect(cleared).toBe(1)
  })

  it('无残留 → cleared=false；清除抛错 → 500；外站 Origin → 403 不执行', async () => {
    let cleared = 0
    let fail = false
    const handler = makeCloakClearHandler(() => {
      cleared += 1
      if (fail) throw new Error('profile path must not be a symbolic link')
      return false
    })
    const none = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_CLOAK_CLEAR_PATH}?confirm=clear`, 'POST', { host: 'localhost:3081' }), responseOf(none))
    expect(JSON.parse(none.body)).toEqual({ ok: true, cleared: false })

    fail = true
    const boom = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_CLOAK_CLEAR_PATH}?confirm=clear`, 'POST', { host: 'localhost:3081' }), responseOf(boom))
    expect(boom.statusCode).toBe(500)

    fail = false
    const forbidden = new FakeResponse()
    await handler(request(`${TRAVEL_METRICS_CLOAK_CLEAR_PATH}?confirm=clear`, 'POST', { host: 'localhost:3081', origin: 'https://evil.example.com' }), responseOf(forbidden))
    expect(forbidden.statusCode).toBe(403)
    expect(cleared).toBe(2) // none + boom 各执行一次；forbidden 未执行
  })
})

// ────────────────────────── UsagePanel（视图模型/状态机纯逻辑 + 组件冒烟） ──────────────────────────

describe('UsagePanel 视图模型（纯函数）', () => {
  it('无数据 → 占位形态', () => {
    const view = buildUsageViewModel(undefined)
    expect(view.amapBudgetText).toBe('— / —')
    expect(view.cacheRateText).toBe('—')
    expect(view.degradedLines).toEqual([])
  })

  it('预算条百分比封顶 100 + 缓存率取整 + 行文案', () => {
    const metrics = projectUsage(
      (() => {
        const rec = new UsageRecorder({ persist: false })
        for (let i = 0; i < 120; i += 1) rec.recordAmapQuota('rest') // 120/100 → 封顶
        rec.recordCache('amap', true)
        rec.recordCache('amap', false)
        rec.recordDegraded('amap', 'TIMEOUT')
        return rec.snapshot()
      })(),
      { amapMonthlyLimit: 100 },
    )
    const view = buildUsageViewModel(metrics)
    expect(view.amapPercent).toBe(100)
    expect(view.amapBudgetText).toBe('120 / 100')
    expect(view.cacheRateText).toBe('50%')
    expect(view.cacheDetailText).toBe('命中 1 · 未命中 1')
    expect(view.degradedLines).toEqual(['amap · TIMEOUT × 1'])
    expect(view.monthLine).toContain(`统计月份 ${metrics.month}`)
  })
})

describe('UsagePanel 状态机（纯 reducer）', () => {
  it('refresh：idle → loading → ready；error 保留旧 metrics', () => {
    let state = createUsagePanelState()
    expect(state.status).toBe('idle')
    state = applyUsagePanelAction(state, { type: 'refresh-start' })
    expect(state.status).toBe('loading')
    const metrics = projectUsage(new UsageRecorder({ persist: false }).snapshot())
    state = applyUsagePanelAction(state, { type: 'refresh-ok', metrics, fetchedAt: '12:00:00' })
    expect(state.status).toBe('ready')
    expect(state.metrics?.month).toBe(metrics.month)
    expect(state.fetchedAt).toBe('12:00:00')
    state = applyUsagePanelAction(state, { type: 'refresh-start' })
    state = applyUsagePanelAction(state, { type: 'refresh-error', message: 'HTTP 503' })
    expect(state.status).toBe('error')
    expect(state.error).toBe('HTTP 503')
    expect(state.metrics?.month).toBe(metrics.month) // 旧数据保留
  })

  it('cloak：idle → confirm（二次确认）→ clearing → cleared/error', () => {
    let state = createUsagePanelState()
    state = applyUsagePanelAction(state, { type: 'cloak-arm' })
    expect(state.cloak).toBe('confirm')
    state = applyUsagePanelAction(state, { type: 'cloak-start' })
    expect(state.cloak).toBe('clearing')
    state = applyUsagePanelAction(state, { type: 'cloak-ok', cleared: true })
    expect(state.cloak).toBe('cleared')
    expect(state.cloakMessage).toContain('已清除')
    state = applyUsagePanelAction(state, { type: 'cloak-arm' })
    state = applyUsagePanelAction(state, { type: 'cloak-error', message: 'HTTP 500' })
    expect(state.cloak).toBe('error')
    expect(state.cloakMessage).toContain('清除失败')
    state = applyUsagePanelAction(state, { type: 'cloak-disarm' })
    expect(state.cloak).toBe('idle')
  })

  it('组件冒烟：元素类型即 UsagePanel（渲染形态由 3081 浏览器实测覆盖）', () => {
    const element = createElement(UsagePanel, { metricsPath: '/custom-metrics' })
    expect(element.type).toBe(UsagePanel)
    expect(element.props).toEqual({ metricsPath: '/custom-metrics' })
  })

  it('client/node 路由字面量一致（镜像约定）', () => {
    expect(USAGE_METRICS_PATH).toBe(TRAVEL_METRICS_PATH)
    expect(USAGE_CLOAK_CLEAR_PATH).toBe(TRAVEL_METRICS_CLOAK_CLEAR_PATH)
  })
})
