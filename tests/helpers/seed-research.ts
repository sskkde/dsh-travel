/**
 * 测试共享：以真实工具链驱动状态机（intake → research → build → render），不手写跳步。
 *
 * seedResearch：用 fixture 化适配器运行**真实** runResearchDestination，把计划
 * 合法推进到 researching 并落盘 intel.json（或按 opts 模拟全渠道失败 → no intel）。
 * 供 build/render 测试装配规范序列的前半程（confirmed→researching）。
 */
import { readFileSync } from 'node:fs'
import type { TravelStore } from '../../src/store/store.js'
import type { IntelItem } from '../../src/models/types.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { tencentPoiChannel, searchL0Channel } from '../../src/orchestrator/channels.js'
import { TencentMapAdapter, type HttpCallFn, type HttpResponseLike } from '../../src/adapters/tencent.js'
import { SearchAdapter, type HostSearchFn } from '../../src/adapters/search.js'

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/tencent/${name}`, import.meta.url), 'utf8')
}

function jsonpFixture(text: string): string {
  return `qq.maps.callback(${text});`
}

function okResponse(text: string, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

function mockHttp(): { call: HttpCallFn; setResponse: (p: string, r: HttpResponseLike) => void; setThrow: (p: string, e: unknown) => void } {
  const responses = new Map<string, HttpResponseLike>()
  const throws = new Map<string, unknown>()
  const call: HttpCallFn = async (url) => {
    for (const [part, e] of throws) if (url.includes(part)) throw e
    for (const [part, r] of responses) if (url.includes(part)) return r
    throw new Error(`mockHttp: no fixture for ${url}`)
  }
  return { call, setResponse: (p, r) => { responses.set(p, r) }, setThrow: (p, e) => { throws.set(p, e) } }
}

export interface SeedResearchOptions {
  /** tencent POI 渠道：'golden'=fixture 命中（带坐标）/ 'fail'=网络错误 / 'none'=不装 */
  poi?: 'golden' | 'fail' | 'none'
  /** search L0 渠道：'hits'=命中（无坐标，标题级）/ 'none'=未注入（不可用）/ 'fail'=搜索抛错 */
  l0?: 'hits' | 'none' | 'fail'
  /** 传给 research 的 categories（缺省全 7 类）。 */
  categories?: string[]
  /** fan-out 重试退避（离线测试默认关；live/重试用例显式给 [1000,4000] 或微延迟）。 */
  retryDelaysMs?: readonly number[]
}

/** L0 命中样本（小红书/知乎 URL，标题级——Intellect 归一化无坐标）。 */
const DEFAULT_L0_HITS = [
  { url: 'https://www.xiaohongshu.com/explore/note-seed1', title: '武汉 3 日游攻略', snippet: '标题级摘要' },
  { url: 'https://zhuanlan.zhihu.com/p/999001', title: '武汉美食避雷指南', snippet: '避雷清单' },
]

/**
 * 以真实 research 工具把计划推进到 researching：
 * - poi='golden' → intel.json 含坐标条目（fixture）；poi='fail' → POI 渠道 degraded
 * - l0='hits' → 追加无坐标 L0 条目；l0='none' → L0 渠道 degraded（未注入）
 * 返回 research 结果（含 degraded 汇总）。
 */
export async function seedResearch(store: TravelStore, planId: string, opts: SeedResearchOptions = {}) {
  const channels = []
  const poi = opts.poi ?? 'golden'
  const l0 = opts.l0 ?? 'hits'

  if (poi !== 'none') {
    const mock = mockHttp()
    if (poi === 'golden') {
      mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    } else {
      mock.setThrow('place/v1/search', new Error('模拟网络不可达'))
    }
    channels.push(tencentPoiChannel(new TencentMapAdapter({ httpCall: mock.call })))
  }

  if (l0 !== 'none') {
    const search = new SearchAdapter({
      hostSearch: (l0 === 'fail'
        ? (async () => { throw new Error('host search timeout') })
        : (async (): Promise<ReturnType<HostSearchFn>> => ({ content: undefined, sources: DEFAULT_L0_HITS, truncated: false }))),
    })
    channels.push(searchL0Channel(search))
  }

  return runResearchDestination(
    { planId, categories: opts.categories as IntelItem['category'][] | undefined, depth: 'quick' },
    store,
    { channels, retryDelaysMs: opts.retryDelaysMs ?? [] },
  )
}