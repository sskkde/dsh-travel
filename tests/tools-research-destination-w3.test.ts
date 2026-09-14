/**
 * travel_research_destination 完整版单测（W3 加厚）：
 * FR-3 验收①（fixture 渠道集 7 类 ≥6/7）、渠道开关前置过滤（ADR-12 热读 →「已停用
 * （用户配置）」）、单源超时注入 → 其余源完成 + degraded[] 含该源、同笔记双 URL
 * 去重 → 1 条、全渠道失败不产空 intel（延用）。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import {
  xhsFallbackChannel, douyinChannel, tier2Channel, tier3Channel,
  platformIntelChannel, tencentPoiChannel,
} from '../src/orchestrator/channels.js'
import type { ResearchChannel } from '../src/orchestrator/types.js'
import { TencentMapAdapter, type HttpCallFn, type HttpResponseLike } from '../src/adapters/tencent.js'
import { SearchAdapter, type HostSearchFn, defaultFetchHtml } from '../src/adapters/search.js'
import { SocialAdapter, type SearchHit } from '../src/adapters/social.js'
import type { IntelItem } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-dest-w3-'))
  store = new TravelStore(root)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const FIX = join('tests', 'fixtures')
function fixture(name: string): string {
  return readFileSync(join(FIX, name), 'utf8')
}
function jsonpFixture(text: string): string {
  return `qq.maps.callback(${text});`
}
function okResponse(text: string, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

/** 腾讯 POI mock（attraction fixture）。 */
function tencentPoiMock(): HttpCallFn {
  return async (url: string) => {
    if (!url.includes('place/v1/search')) throw new Error(`no tencent fixture for ${url}`)
    return okResponse(jsonpFixture(fixture('tencent/poi-search-huanghelou.json')))
  }
}

type SeedHits = Array<{ url: string; title: string; snippet?: string }>

/** 每类别独立命中的 L0 宿主搜索 mock（按查询种子词路由，保证类别多样性）。 */
function categoryHostSearch(
  xhsByCat: Record<string, SeedHits>,
  other: { zhihu?: SeedHits; web?: SeedHits },
): HostSearchFn {
  const findSeed = (query: string, map: Record<string, SeedHits>): SeedHits | undefined => {
    for (const [seed, hits] of Object.entries(map)) {
      if (query.includes(seed)) return hits
    }
    return undefined
  }
  return async (query) => {
    if (query.includes('site:xiaohongshu.com')) {
      const hits = findSeed(query, xhsByCat)
      return { content: undefined, sources: hits ?? [], truncated: false }
    }
    if (query.includes('site:zhihu.com')) {
      return { content: undefined, sources: other.zhihu ?? [], truncated: false }
    }
    return { content: undefined, sources: other.web ?? [], truncated: false }
  }
}

/** 全 7 类 fixture 渠道集（离线；L0.5 直抓用 xhs-explore fixture 注入）。 */
function fullChannelSet(opts: { hangChannel?: string } = {}): ResearchChannel[] {
  const categories: Array<{ seed: string; cat: string }> = [
    { seed: '景点推荐', cat: 'attraction' },
    { seed: '住宿推荐', cat: 'lodging' },
    { seed: '美食推荐', cat: 'food' },
    { seed: '市内交通', cat: 'transportLocal' },
    { seed: '注意事项', cat: 'tip' },
    { seed: '避雷', cat: 'warning' },
    { seed: '旅行攻略', cat: 'recommend' },
  ]
  const xhsByCat: Record<string, SeedHits> = {}
  categories.forEach((c, i) => {
    xhsByCat[c.seed] = [{ url: `https://www.xiaohongshu.com/explore/noteW3${i}`, title: `杭州 ${c.cat} 笔记`, snippet: '摘要' }]
  })
  const search = new SearchAdapter({
    hostSearch: categoryHostSearch(xhsByCat, {
      zhihu: [{ url: 'https://zhuanlan.zhihu.com/p/990001', title: '杭州 2 日游 攻略', snippet: '值得去' }],
      web: [{ url: 'https://example.invalid/plan', title: '杭州 10月 旅行 注意事项', snippet: '证件 预约' }],
    }),
    fetchHtml: async (url) => ({ status: 200, text: fixture('search/xhs-explore.html') }),
  })
  const social = new SocialAdapter({ search: async (): Promise<SearchHit[]> => [
    { url: 'https://www.douyin.com/video/73210001', title: '杭州 避雷 攻略', snippet: '别踩坑' },
    { url: 'https://www.douyin.com/note/73210002', title: '杭州 美食 推荐', snippet: '推荐' },
    { url: 'http://weibo.com/note/991', title: '杭州 旅游 攻略', snippet: '微博摘要' },
  ] })
  const tencent = new TencentMapAdapter({ httpCall: tencentPoiMock() })
  const channels: ResearchChannel[] = [
    xhsFallbackChannel(search),
    douyinChannel(social),
    tier2Channel(search),
    tier3Channel(social),
    tencentPoiChannel(tencent),
    platformIntelChannel(search),
  ]
  if (opts.hangChannel) {
    channels.forEach((ch, i) => {
      if (ch.name === opts.hangChannel) {
        channels[i] = { ...ch, run: async () => await new Promise<never>(() => {}) } // 永挂 → 预算截断 TIMEOUT
        channels[i] = {
          ...channels[i], name: ch.name,
          available: async () => true,
          run: async () => await new Promise<never>(() => {}),
        }
      }
    })
  }
  return channels
}

async function makeConfirmedPlan(): Promise<string> {
  const result = await runIntake({
    slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
  }, store)
  expect(result.status).toBe('confirmed')
  return result.planId
}

describe('W3 完整版：FR-3 验收①（7 类 ≥6/7，fixture 渠道集）', () => {
  it('全渠道集 fixture → 覆盖 ≥6/7 类别 + intelSummary 渠道计数 + itemCount', async () => {
    const planId = await makeConfirmedPlan()
    const result = await runResearchDestination(
      { planId, depth: 'quick' }, store,
      { channels: fullChannelSet(), retryDelaysMs: [], env: { env: {} } },
    )
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    expect(intel.length).toBe(result.itemCount)
    const categories = new Set(intel.map((i) => i.category))
    expect(categories.size).toBeGreaterThanOrEqual(6) // FR-3 验收①：≥6/7
    for (const item of intel) expect(item.source.url).toBeTruthy()
    // 渠道计数（intelSummary 非空）
    expect(Object.keys(result.intelSummary).length).toBeGreaterThanOrEqual(3)
    expect(result.intelSummary['xhs-l0'] ?? 0).toBeGreaterThanOrEqual(7)
    expect(result.intelSummary['tencent-poi'] ?? 0).toBeGreaterThanOrEqual(1)
    expect(result.intelSummary['web'] ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('categories 过滤生效：只请求 food/warning → 楼层收敛', async () => {
    const planId = await makeConfirmedPlan()
    const result = await runResearchDestination(
      { planId, categories: ['food', 'warning'], depth: 'quick' }, store,
      { channels: fullChannelSet(), retryDelaysMs: [], env: { env: {} } },
    )
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    expect(intel.length).toBeGreaterThanOrEqual(1)
    expect(intel.every((i) => i.category === 'food' || i.category === 'warning')).toBe(true)
    expect(result.itemCount).toBe(intel.length)
  })
})

describe('W3 渠道开关前置过滤（ADR-12 热读）', () => {
  it('tencent-poi 开关关闭 → 无 POI 条目 + degraded「已停用（用户配置）」+ 社媒照常', async () => {
    const planId = await makeConfirmedPlan()
    const env = {
      readSettings: (key: string) => (key === 'channels.tencent-poi' ? 'false' : undefined),
      env: {},
    }
    const result = await runResearchDestination(
      { planId }, store,
      { channels: fullChannelSet(), retryDelaysMs: [], env },
    )
    expect(result.degraded.some((d) => d.source === 'tencent-poi' && d.reason.includes('已停用'))).toBe(true)
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    expect(intel.some((i) => i.channel === 'tencent-poi')).toBe(false)
    expect(intel.some((i) => i.channel === 'xhs-l0')).toBe(true) // 其余渠道不阻塞
  })
})

describe('W3 单源超时注入 → 其余源完成 + degraded[] 含该源', () => {
  it('xhs-l0 渠道永挂（预算截断 TIMEOUT）→ 其余渠道条目照常 + degraded 含 xhsFallback', async () => {
    const planId = await makeConfirmedPlan()
    const result = await runResearchDestination(
      { planId }, store,
      { channels: fullChannelSet({ hangChannel: 'xhsFallback' }), retryDelaysMs: [], env: { env: {} }, timeoutMs: 2000 },
    )
    expect(result.degraded.some((d) => d.source === 'xhsFallback' && d.code === 'TIMEOUT')).toBe(true)
    expect(result.itemCount).toBeGreaterThanOrEqual(2) // douyin/tier2/tencent/… 照常完成
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    expect(intel.some((i) => i.channel !== 'xhs-l0' && i.channel !== 'zhihu')).toBe(true)
  })
})

describe('W3 同笔记双 URL → 1 条（跨渠道聚合去重）', () => {
  it('l0:note 与 xhs:note 同笔记折叠为 1 条（L0.5 富条目胜出）', async () => {
    const l0 = {
      id: 'l0:noteDupe', category: 'recommend' as const, channel: 'xhs-l0' as const,
      title: '杭州攻略', summary: '标题级', confidence: 'low' as const,
      source: { platform: 'host-search:xhs', url: 'https://www.xiaohongshu.com/explore/noteDupe?xsec_token=tok1', fetchedAt: '2026-09-02T00:00:00.000Z' },
    }
    const l05 = {
      id: 'xhs:noteDupe', category: 'recommend' as const, channel: 'xhs-l0' as const,
      title: '杭州攻略（全文）', summary: '正文详细内容与互动数据', confidence: 'medium' as const,
      source: { platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/noteDupe?xsec_token=tok2', fetchedAt: '2026-09-02T00:00:01.000Z' },
    }
    const channels: ResearchChannel[] = [
      { name: 'a', available: async () => true, run: async () => ({ ok: true, items: [l0] }) },
      { name: 'b', available: async () => true, run: async () => ({ ok: true, items: [l05] }) },
    ]
    const planId = await makeConfirmedPlan()
    // 直接经 fan-out 验证（不经完整渠道集，避免其他渠道干扰）
    const { runChannelFanout } = await import('../src/orchestrator/fanout.js')
    const fanout = await runChannelFanout({ channels, query: { destination: '杭州' }, budgetMs: 1000, retryDelaysMs: [] })
    expect(fanout.items).toHaveLength(1)
    expect(fanout.items[0].id).toBe('xhs:noteDupe')
    // T23：缺少发布时间保留条目但降权。
    expect(fanout.items[0].confidence).toBe('low')
    void planId
  })
})

describe('W3 全渠道失败不产空 intel（延用语义）', () => {
  it('全部渠道可用但零命中 → 不落盘 intel.json + degraded 明确报告', async () => {
    const planId = await makeConfirmedPlan()
    const emptySearch = new SearchAdapter({
      hostSearch: async () => ({ content: undefined, sources: [], truncated: false }),
      fetchHtml: async (url) => ({ status: 200, text: '' }),
    })
    const emptySocial = new SocialAdapter({ search: async () => [] })
    const tencent = new TencentMapAdapter({
      httpCall: async (url) => { throw new Error(`no fixture ${url}`) }, // POI 失败
    })
    const channels: ResearchChannel[] = [
      xhsFallbackChannel(emptySearch),
      douyinChannel(emptySocial),
      tier2Channel(emptySearch),
      tier3Channel(emptySocial),
      tencentPoiChannel(tencent),
      platformIntelChannel(emptySearch),
    ]
    const result = await runResearchDestination(
      { planId }, store,
      { channels, retryDelaysMs: [], env: { env: {} } },
    )
    expect(result.itemCount).toBe(0)
    expect(await store.readJson<unknown>(planId, 'intel.json')).toBeUndefined()
    expect(result.degraded.length).toBeGreaterThanOrEqual(3)
  })
})

/** 防未用导入告警：defaultFetchHtml 仅作类型参照（离线注入 mock）。 */
void defaultFetchHtml