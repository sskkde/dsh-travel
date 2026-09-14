/**
 * travel_research_destination 薄版单测（M1 T5 / Wα）：
 * golden POI → IntelItem 落盘 intel.json（validateIntelItem 闸门）；
 * L0 命中 → 条目；单渠道失败 → degraded 记账其余完成；全渠道失败 → 不产空 intel。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination, createTravelResearchDestinationTool, RESEARCH_TIMEOUT_MS } from '../src/tools/research-destination.js'
import { tencentPoiChannel, searchL0Channel } from '../src/orchestrator/channels.js'
import { TencentMapAdapter, type HttpCallFn, type HttpResponseLike } from '../src/adapters/tencent.js'
import { SearchAdapter, type HostSearchFn } from '../src/adapters/search.js'
import { validateIntelItem } from '../src/models/validate.js'
import { TravelValidationError } from '../src/errors.js'
import { AmapAdapter, QuotaCounter } from '../src/adapters/amap.js'
import { EngineError } from '../src/adapters/base.js'
import type { ResearchChannel } from '../src/orchestrator/types.js'
import type { IntelItem } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-research-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/tencent/${name}`, import.meta.url), 'utf8')
}

/** 真实响应（已脱敏）注入：返回 JSONP 包裹的 fixture 正文。 */
function jsonpFixture(text: string): string {
  return `qq.maps.callback(${text});`
}

function okResponse(text: string, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

function mockHttp(): { call: HttpCallFn; setResponse: (part: string, r: HttpResponseLike) => void; setThrow: (part: string, err: unknown) => void } {
  const responses = new Map<string, HttpResponseLike>()
  const throws = new Map<string, unknown>()
  const call: HttpCallFn = async (url) => {
    for (const [part, err] of throws) {
      if (url.includes(part)) throw err
    }
    for (const [part, r] of responses) {
      if (url.includes(part)) return r
    }
    throw new Error(`mockHttp: no fixture for ${url}`)
  }
  return { call, setResponse: (part, r) => { responses.set(part, r) }, setThrow: (part, err) => { throws.set(part, err) } }
}

/** 构造已确认计划（无可疑歧义：recommend 全空转 confirmed 亦可）。 */
async function makeConfirmedPlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      destination: '武汉',
      dateStart: '2026-10-01',
      dateEnd: '2026-10-03',
      ...slots,
    },
  }, store)
  expect(result.status).toBe('confirmed')
  return result.planId
}

function l0HostSearch(hits: Array<{ url: string; title: string; snippet?: string }>): HostSearchFn {
  return async () => ({ content: undefined, sources: hits, truncated: false })
}

/** 薄版装配：mock POI（golden fixture）+ L0（注入 hostSearch）。 */
function thinDeps(opts: { poiOk?: boolean; l0Hits?: Array<{ url: string; title: string; snippet?: string }> } = {}) {
  const mock = mockHttp()
  if (opts.poiOk !== false) {
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
  } else {
    mock.setThrow('place/v1/search', new Error('ECONNRESET'))
  }
  const tencent = new TencentMapAdapter({ httpCall: mock.call })
  const l0Hits = opts.l0Hits ?? []
  const search = new SearchAdapter({
    hostSearch: l0Hits.length > 0 ? l0HostSearch(l0Hits) : undefined,
  })
  return { channels: [tencentPoiChannel(tencent), searchL0Channel(search)], mock }
}

describe('薄版 research：golden POI 渠道', () => {
  it('POI golden → intel.json 落盘 + 条目级校验 + intelSummary + 状态 researching', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({ l0Hits: [] }) // L0 无 hostSearch → 跳过（degraded）
    const result = await runResearchDestination({ planId, categories: ['attraction'], depth: 'quick' }, store, deps)

    expect(result.itemCount).toBeGreaterThanOrEqual(3)
    expect(result.intelSummary['tencent-poi']).toBeGreaterThanOrEqual(3)
    expect(result.degraded.some((d) => d.source === 'search-l0')).toBe(true) // L0 未注入 → 前置过滤记账

    const intel = await store.readJson<IntelItem[]>(planId, 'intel.json')
    expect(intel).toBeDefined()
    expect(intel!.length).toBe(result.itemCount)
    for (const item of intel!) {
      expect(validateIntelItem(item)).toEqual([]) // §5.5 条目级闸门
    }
    expect(intel!.every((i) => i.channel === 'tencent-poi')).toBe(true)
    expect(intel!.every((i) => i.coords !== undefined)).toBe(true) // GCJ-02 直落

    const request = await store.loadRequest(planId)
    expect(request?.status).toBe('researching')
  })

  it('运行后再调用：researching self（幂等重检索）不抛错', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({})
    await runResearchDestination({ planId, depth: 'quick' }, store, deps)
    const again = await runResearchDestination({ planId, depth: 'quick' }, store, deps)
    expect(again.itemCount).toBeGreaterThan(0)
  })
})

describe('薄版 research：L0 渠道命中', () => {
  it('L0 命中（xhs/zhihu）→ 条目（标题级）+ 意类别过滤 + 中心过滤', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({
      l0Hits: [
        { url: 'https://www.xiaohongshu.com/explore/note123', title: '武汉 3 日游攻略 避开人流', snippet: '干货' },
        { url: 'https://zhuanlan.zhihu.com/p/8888', title: '武汉美食避雷指南', snippet: '避雷' },
      ],
    })
    const result = await runResearchDestination({ planId }, store, deps) // 缺省全 7 类

    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    const l0Items = intel.filter((i) => i.channel !== 'tencent-poi')
    expect(l0Items.length).toBeGreaterThanOrEqual(1)
    expect(l0Items.some((i) => i.channel === 'xhs-l0' && i.title.includes('武汉 3 日游攻略'))).toBe(true)
    // 避雷启发 → warning 类别
    expect(l0Items.some((i) => i.category === 'warning' && i.title.includes('避雷'))).toBe(true)
    // 详情页埋点：全部条目过闸门
    for (const item of intel) expect(validateIntelItem(item)).toEqual([])
  })

  it('categories 过滤：只保留请求类别（L0 recommend 条目被中心过滤）', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({
      l0Hits: [
        { url: 'https://www.xiaohongshu.com/explore/note456', title: '武汉旅游攻略', snippet: '综合' },
      ],
    })
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, deps)
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    expect(intel.length).toBe(result.itemCount)
    expect(intel.every((i) => i.category === 'attraction')).toBe(true) // 攻略→recommend 被过滤
  })
})

describe('T18：条目 dropped 按渠道+原因聚合', () => {
  it('相同渠道/原因合并并带 count，不同原因分条', async () => {
    const planId = await makeConfirmedPlan()
    const invalid = (id: string, patch: Partial<IntelItem> = {}): IntelItem => ({
      id, category: 'attraction', channel: 'tencent-poi', title: '', summary: '摘要',
      source: { platform: 'test', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-01T00:00:00.000Z' },
      confidence: 'medium', ...patch,
    })
    const channel: ResearchChannel = {
      name: 'dropped-fixture',
      available: async () => true,
      run: async () => ({ ok: true, items: [invalid('bad-1'), invalid('bad-2'), invalid('bad-3', { summary: '' })] }),
    }
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [channel], retryDelaysMs: [],
    })
    const dropped = result.degraded.filter((entry) => entry.source === 'tencent-poi' && entry.reason.includes('条目校验失败'))
    expect(dropped).toHaveLength(2)
    expect(dropped.map((entry) => entry.count).sort()).toEqual([1, 2])
    expect(await store.readJson<unknown>(planId, 'intel.json')).toBeUndefined()
  })
})

describe('薄版 research：单渠道失败 / 全渠道失败', () => {
  it('L0 渠道失败（搜索抛错）→ degraded 记账，POI 渠道照常完成', async () => {
    const planId = await makeConfirmedPlan()
    const data = thinDeps({ l0Hits: [{ url: 'https://www.xiaohongshu.com/explore/boom', title: 'x' }] })
    data.mock // POI ok
    // 让 L0 的宿主搜索抛错：覆盖 hostSearch 抛异常路径
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const tencent = new TencentMapAdapter({ httpCall: mock.call })
    const brokenSearch = new SearchAdapter({
      hostSearch: async () => { throw new Error('host search timeout') },
    })
    const result = await runResearchDestination(
      { planId, categories: ['attraction'] }, store,
      { channels: [tencentPoiChannel(tencent), searchL0Channel(brokenSearch)], retryDelaysMs: [] },
    )
    expect(result.itemCount).toBeGreaterThanOrEqual(3)
    expect(result.degraded.some((d) => d.source === 'search-l0' && d.code === 'UNAVAILABLE')).toBe(true)
  })

  it('全渠道失败 → 不产空 intel.json + degraded 明确报告 + 不抛裸异常', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({ poiOk: false, l0Hits: [] }) // POI 网络错误 + L0 未注入
    const result = await runResearchDestination(
      { planId, depth: 'quick' }, store,
      { ...deps, retryDelaysMs: [] },
    )

    expect(result.itemCount).toBe(0)
    expect(Object.keys(result.intelSummary)).toHaveLength(0)
    expect(result.degraded.length).toBeGreaterThanOrEqual(2)
    for (const d of result.degraded) {
      expect(['UNAVAILABLE', 'TIMEOUT', 'EMPTY']).toContain(d.code)
    }
    // 不产空 intel（§9.3-6）
    expect(await store.readJson<unknown>(planId, 'intel.json')).toBeUndefined()
    // degraded.json 已记账（get_state 可汇总）
    const degradedFile = await store.loadDegraded(planId)
    expect(degradedFile?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('M2 遗留修复 QA happy：连续两次 research 后 amap 配额计数器归零（预算重置，CLOSURE ③）', () => {
  /** amap POI 渠道（真实 AmapAdapter + 离线 fixture；配额 poiLimit=1 模拟单次规划预算用尽）。 */
  function amapPoiDeps(fixtureResponse: unknown) {
    const AMAP_KEYS = { env: { amapWebservice: 'test-key' } }
    const fetchFn = async (url: string) => {
      if (!url.includes('place/text')) throw new Error(`no fixture: ${url}`)
      return { ok: true, status: 200, text: async () => JSON.stringify(fixtureResponse) }
    }
    const adapter = new AmapAdapter({ fetchFn, quota: new QuotaCounter({ poiLimit: 1, restLimit: 10 }) })
    const channel: ResearchChannel = {
      name: 'amap-poi',
      async available() {
        return adapter.available(AMAP_KEYS)
      },
      async run() {
        try {
          const { items } = await adapter.poiSearch('西湖', '330100', { pageSize: 3 }, AMAP_KEYS)
          return { ok: true, items: [...items] }
        } catch (error) {
          const engine = error instanceof EngineError ? error : EngineError.unavailable(String(error))
          return { ok: false, code: engine.code, reason: engine.message }
        }
      },
    }
    return { adapter, deps: { channels: [channel], retryDelaysMs: [] } }
  }

  it('入口 resetPlanBudget 接线：第二次 research 预算重置，不跨规划累积熔断', async () => {
    const planId = await makeConfirmedPlan()
    const poiFixture = JSON.parse(readFileSync(new URL('./fixtures/amap/poi.json', import.meta.url), 'utf8'))
    const { adapter, deps } = amapPoiDeps(poiFixture.response)
    const wired = { ...deps, resetPlanBudget: () => adapter.resetPlanBudget() }

    // 第一次 research：POI 预算 1/1 用尽
    await runResearchDestination({ planId, categories: ['attraction'], depth: 'quick' }, store, wired)
    expect(adapter.quotaSnapshot().planPoiUsed).toBe(1)
    expect(adapter.quotaSnapshot().monthlyUsed).toBe(1)

    // 第二次 research：入口已重置 → 预算仍只按本次使用（1，而非累积 2）；无「停新增」熔断记账
    const again = await runResearchDestination({ planId, categories: ['attraction'], depth: 'quick' }, store, wired)
    expect(again.itemCount).toBeGreaterThan(0)
    expect(adapter.quotaSnapshot().planPoiUsed).toBe(1)
    expect(adapter.quotaSnapshot().monthlyUsed).toBe(2) // 月度配额不动（reset 不清月度）
    expect(again.degraded.some((d) => d.reason.includes('停新增'))).toBe(false)

    // 对照组：不接线 resetPlanBudget → 第二次 research 直接配额熔断（证明接线必要性）
    const plan2 = await makeConfirmedPlan()
    const { adapter: adapter2, deps: deps2 } = amapPoiDeps(poiFixture.response)
    await runResearchDestination({ planId: plan2, categories: ['attraction'], depth: 'quick' }, store, deps2)
    const withoutReset = await runResearchDestination({ planId: plan2, categories: ['attraction'], depth: 'quick' }, store, deps2)
    expect(withoutReset.itemCount).toBe(0)
    expect(withoutReset.degraded.some((d) => d.source === 'amap-poi' && d.reason.includes('停新增'))).toBe(true)
  })
})

describe('T25 腾讯 POI → 高德 POI 自适应降级', () => {
  function emptyTencent(): { adapter: TencentMapAdapter; mock: ReturnType<typeof mockHttp> } {
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(JSON.stringify({ status: 0, message: 'Success', count: 0, data: [] }))))
    return { adapter: new TencentMapAdapter({ httpCall: mock.call }), mock }
  }

  function amapFixtureAdapter(response: unknown, onFetch?: () => void): AmapAdapter {
    return new AmapAdapter({
      fetchFn: async () => {
        onFetch?.()
        return { ok: true, status: 200, text: async () => JSON.stringify(response) }
      },
    })
  }

  it('腾讯 EMPTY → 复用既有 Amap POI，条目 source.platform=amap 且不新增外部渠道', async () => {
    const planId = await makeConfirmedPlan()
    const { adapter: tencent } = emptyTencent()
    const amapResponse = JSON.parse(readFileSync(new URL('./fixtures/amap/poi.json', import.meta.url), 'utf8')).response
    const amap = amapFixtureAdapter(amapResponse)
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [tencentPoiChannel(tencent, amap)],
      env: { env: { amapWebservice: 'test-key' } },
      retryDelaysMs: [],
    })
    expect(result.itemCount).toBeGreaterThan(0)
    const intel = await store.readJson<IntelItem[]>(planId, 'intel.json')
    expect(intel?.every((item) => item.source.platform === 'amap')).toBe(true)
    expect(result.degraded.some((entry) => entry.source === 'tencent-poi' && entry.code === 'EMPTY')).toBe(true)
  })

  it('腾讯与高德均 EMPTY → 保留 degraded，且不产空 intel.json', async () => {
    const planId = await makeConfirmedPlan()
    const { adapter: tencent } = emptyTencent()
    const amap = amapFixtureAdapter({ status: '1', info: 'OK', pois: [] })
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [tencentPoiChannel(tencent, amap)],
      env: { env: { amapWebservice: 'test-key' } },
      retryDelaysMs: [],
    })
    expect(result.itemCount).toBe(0)
    expect(result.degraded.some((entry) => entry.source === 'tencent-poi')).toBe(true)
    expect(result.degraded.some((entry) => entry.source === 'amap')).toBe(true)
    expect(await store.readJson<unknown>(planId, 'intel.json')).toBeUndefined()
  })

  it('Amap fallback 遵守 off 开关：先 available，关闭时零 POI 请求', async () => {
    const planId = await makeConfirmedPlan()
    const { adapter: tencent } = emptyTencent()
    let amapAvailabilityCalls = 0
    let amapPoiCalls = 0
    const amap = amapFixtureAdapter(
      JSON.parse(readFileSync(new URL('./fixtures/amap/poi.json', import.meta.url), 'utf8')).response,
      () => { amapPoiCalls += 1 },
    )
    const originalAvailable = amap.available.bind(amap)
    amap.available = async (env) => {
      amapAvailabilityCalls += 1
      return originalAvailable(env)
    }
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [tencentPoiChannel(tencent, amap)],
      env: { env: { amapWebservice: 'test-key', TRAVEL_CHANNEL_AMAP: 'off' } },
      retryDelaysMs: [],
    })
    expect(result.itemCount).toBe(0)
    expect(amapAvailabilityCalls).toBe(1)
    expect(amapPoiCalls).toBe(0)
    expect(result.degraded.some((entry) => entry.source === 'amap' && /停用|不可用/.test(entry.reason))).toBe(true)
  })

  it('Amap fallback 缺 key：available=false 且零 POI 请求', async () => {
    const planId = await makeConfirmedPlan()
    const { adapter: tencent } = emptyTencent()
    let amapAvailabilityCalls = 0
    let amapPoiCalls = 0
    const amap = amapFixtureAdapter(
      JSON.parse(readFileSync(new URL('./fixtures/amap/poi.json', import.meta.url), 'utf8')).response,
      () => { amapPoiCalls += 1 },
    )
    const originalAvailable = amap.available.bind(amap)
    amap.available = async (env) => {
      amapAvailabilityCalls += 1
      return originalAvailable(env)
    }
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [tencentPoiChannel(tencent, amap)],
      env: { env: {} },
      retryDelaysMs: [],
    })
    expect(result.itemCount).toBe(0)
    expect(amapAvailabilityCalls).toBe(1)
    expect(amapPoiCalls).toBe(0)
    expect(result.degraded.some((entry) => entry.source === 'amap' && /Key 未配置|不可用/.test(entry.reason))).toBe(true)
  })

  it('Tencent available 抛错仍进入 run 并走 Amap fallback', async () => {
    const planId = await makeConfirmedPlan()
    const { adapter: tencent } = emptyTencent()
    tencent.available = async () => { throw new Error('Tencent availability probe failed') }
    let amapPoiCalls = 0
    const amapResponse = JSON.parse(readFileSync(new URL('./fixtures/amap/poi.json', import.meta.url), 'utf8')).response
    const amap = amapFixtureAdapter(amapResponse, () => { amapPoiCalls += 1 })
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [tencentPoiChannel(tencent, amap)],
      env: { env: { amapWebservice: 'test-key' } },
      retryDelaysMs: [],
    })
    expect(result.itemCount).toBeGreaterThan(0)
    expect(amapPoiCalls).toBeGreaterThan(0)
    expect(result.degraded.some((entry) => entry.source === 'tencent-poi')).toBe(true)
  })

  it('Amap available 抛错 → fallback 记 degraded 且零 POI 请求', async () => {
    const planId = await makeConfirmedPlan()
    const { adapter: tencent } = emptyTencent()
    let amapAvailabilityCalls = 0
    let amapPoiCalls = 0
    const amap = amapFixtureAdapter(
      JSON.parse(readFileSync(new URL('./fixtures/amap/poi.json', import.meta.url), 'utf8')).response,
      () => { amapPoiCalls += 1 },
    )
    amap.available = async () => {
      amapAvailabilityCalls += 1
      throw new Error('Amap availability probe failed')
    }
    const result = await runResearchDestination({ planId, categories: ['attraction'] }, store, {
      channels: [tencentPoiChannel(tencent, amap)],
      env: { env: { amapWebservice: 'test-key' } },
      retryDelaysMs: [],
    })
    expect(result.itemCount).toBe(0)
    expect(amapAvailabilityCalls).toBe(1)
    expect(amapPoiCalls).toBe(0)
    expect(result.degraded.some((entry) => entry.source === 'amap' && entry.code === 'UNAVAILABLE')).toBe(true)
  })
})

describe('薄版 research：参数与状态边界', () => {
  it('计划不存在 → TravelValidationError（明确提示）', async () => {
    const deps = thinDeps({})
    await expect(runResearchDestination({ planId: 'plan-nope' }, store, deps)).rejects.toThrow(TravelValidationError)
  })

  it('非法 categories 枚举 → TravelValidationError', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({})
    await expect(
      runResearchDestination({ planId, categories: ['hotel' as never] }, store, deps),
    ).rejects.toThrow(/categories 含非法类别/)
  })

  it('delivered 终态直接重检索被拒（须先 update → revising）', async () => {
    const planId = await makeConfirmedPlan()
    const deps = thinDeps({})
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const tencent = new TencentMapAdapter({ httpCall: mock.call })
    // 直接构造 delivered 状态
    const request = await store.loadRequest(planId)
    await store.saveRequest({ ...request!, status: 'delivered', updatedAt: new Date().toISOString() })
    await expect(
      runResearchDestination({ planId }, store, { channels: [tencentPoiChannel(tencent)] }),
    ).rejects.toThrow(/非法转换/)
  })

  it('工具定义可构建（defineTool 契约）+ 默认超时 = 180s', () => {
    const tool = createTravelResearchDestinationTool(store, thinDeps({}))
    expect(tool.name).toBe('travel_research_destination')
    expect(tool.timeoutMs).toBe(RESEARCH_TIMEOUT_MS)
  })
})

describe('发现种子（草稿 A/F4-C1）：researchIntent 可作缺省调用默认种子，不再强制 destination', () => {
  it('无 DR 参数 + 仅 researchIntent + 无 destination → 照常 discovery 轮（不抛「缺 destination」）', async () => {
    const result = await runIntake({
      slots: {
        researchIntent: { text: '青甘大环线 10 天自驾', keywords: ['敦煌', '大柴旦'], regionHints: ['甘肃', '青海'] },
        dateStart: '2026-09-01',
        dateEnd: '2026-09-10',
      },
    }, store)
    expect(result.status).toBe('confirmed')
    expect(result.confirmedSlots.destination).toBeUndefined()
    // 零渠道空 fanout：0 网络，仅验证「缺省调用不再因缺 destination 报错」且驱动来自 intent
    const out = await runResearchDestination({ planId: result.planId }, store, { channels: [] })
    expect(out.itemCount).toBe(0)
  })

  it('缺省调用 既无 destination 也无 researchIntent → 明确 missing receipt', async () => {
    const planId = await makeConfirmedPlan()
    const req = await store.loadRequest(planId)
    await store.saveRequest({
      ...req!,
      slots: { ...req!.slots, destination: undefined, researchIntent: undefined },
    })
    await expect(
      runResearchDestination({ planId }, store, { channels: [] }),
    ).rejects.toThrow(/缺少研究输入.*missing receipt/)
  })

  it('F1c-E 回归：legacy 计划（无 flowVersion）缺省调用不写轮次、不推进 researchVersion（单点兼容保留）', async () => {
    // 真正的 legacy 形态：请求文件无 flowVersion 信封（旧计划/未走新确认写入口）。
    const planId = await makeConfirmedPlan()
    const req = await store.loadRequest(planId)
    await store.saveRequest({ ...req!, flowVersion: undefined })
    // 缺省调用（无任何 DR 参数）→ 旧单点行为：执行检索但不写轮次不推进版本
    const out = await runResearchDestination({ planId, categories: ['attraction'], depth: 'quick' }, store, thinDeps({}))
    expect(out.itemCount).toBeGreaterThanOrEqual(1)
    expect(out.round).toBeUndefined()
    const state = await store.loadResearchState<{ rounds: string[]; researchVersion: number }>(planId)
    expect(state).toBeUndefined() // 无研究状态工件（未推进）
    const request = await store.loadRequest(planId)
    expect(request?.status).toBe('researching')
  })
})
