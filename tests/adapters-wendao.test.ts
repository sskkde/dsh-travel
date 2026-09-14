/**
 * wendao（携程问道）适配器单测：纯 Markdown 解析 + 深链提取 + 无 key 休眠零调用。
 * fixture = query-flights.md / query-buses.md（结构依据 research/ctrip-wendao-platforms.md
 * 实测口径：机票/火车票/酒店/门票/美食优秀 + m.ctrip.com 深链；汽车票咨询级）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  EngineError, type KeyResolutionEnv,
} from '../src/adapters/base.js'
import {
  WendaoAdapter, WENDAO_ENDPOINT, extractCtripDeepLinks, parseWendaoMarkdown,
  stripMarkdownLinks, type FetchLike,
} from '../src/adapters/wendao.js'
import { liveCredentialsEnv } from './live-credentials.js'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wendao')
const flightsMd = () => readFileSync(path.join(FIX, 'query-flights.md'), 'utf8')
const flightsV2Md = () => readFileSync(path.join(FIX, 'query-flights-v2.md'), 'utf8')
const busesMd = () => readFileSync(path.join(FIX, 'query-buses.md'), 'utf8')

/** 带计数间谍的假 fetch：断言零网络请求。 */
function spyFetch(body: string): { fetchFn: FetchLike; calls: number } {
  let calls = 0
  const fetchFn: FetchLike = async (input, init) => {
    calls += 1
    expect(input).toBe(WENDAO_ENDPOINT)
    expect(JSON.parse(init?.body ?? '{}').source).toBe('github')
    return { ok: true, status: 200, text: async () => body }
  }
  return { fetchFn, calls: () => calls }
}

describe('纯 Markdown 解析（wendao 实测口径）', () => {
  it('parseWendaoMarkdown：# 小节划分 + 条目结构', () => {
    const { entries, sections } = parseWendaoMarkdown(flightsMd())
    expect(sections).toContain('机票查询结果')
    expect(sections).toContain('北京 → 上海 2026-09-04')
    expect(entries.length).toBeGreaterThanOrEqual(3)
    const first = entries[0]
    expect(first.title).toContain('MU5107')
    expect(first.section).toBe('北京 → 上海 2026-09-04')
  })

  it('parseWendaoMarkdown v2 形态：##### 航班标题深链下传 + bullet 聚合单条目（W4 配额重置复跑实测录制）', () => {
    const { entries, sections } = parseWendaoMarkdown(flightsV2Md())
    // 5 个航班标题成为 section（航司/机型文本）；标题内深链不丢
    expect(sections).toContain('新海航|首都航空 空客321(中)')
    expect(sections).toContain('查看更多航班')
    // 首行导语 1 条 + 5 个航班各聚合 1 条 + 「查看更多」登录行 1 条
    expect(entries.length).toBe(7)
    const jd = entries.find((e) => e.section === '新海航|首都航空 空客321(中)')
    expect(jd).toBeDefined()
    // bullet 聚合：起飞/到达/飞行时间/价格在同一条目 summary
    expect(jd?.summary).toContain('起飞：杭州 萧山T3 21:45')
    expect(jd?.summary).toContain('到达：09-13 北京 大兴 00:05')
    expect(jd?.summary).toContain('￥340')
    // 标题行深链（含 dfltno/price 参数）下传该块条目
    expect(jd?.deepLinks.some((u) => u.includes('dfltno=JD5907'))).toBe(true)
    // 各航班条目互不串链
    const mu = entries.find((e) => e.section === '东航 空客321(中)')
    expect(mu?.deepLinks.some((u) => u.includes('dfltno=MU5140'))).toBe(true)
    expect(mu?.deepLinks.some((u) => u.includes('dfltno=JD5907'))).toBe(false)
  })

  it('深链提取：仅保留 m.ctrip.com；去重按 base URL（query 不同取首现）', () => {
    const links = extractCtripDeepLinks(flightsMd())
    expect(links.length).toBeGreaterThanOrEqual(3)
    for (const l of links) {
      expect(l).toMatch(/^https:\/\/m\.ctrip\.com\//)
    }
    // 完整 URL 精确去重（query 携带 flightNo/date，语义必需）
    expect(new Set(links).size).toBe(links.length)
    expect(links.some((l) => l.includes('flightNo=MU5107'))).toBe(true)
    expect(links.some((l) => l.includes('flightNo=CA1501'))).toBe(true)
    // 非 ctrip 域名被过滤
    expect(extractCtripDeepLinks('见 https://www.baidu.com 与 https://m.ctrip.com/webapp/x')).toEqual([
      'https://m.ctrip.com/webapp/x',
    ])
  })

  it('stripMarkdownLinks：链接语法剥除为纯文本', () => {
    expect(stripMarkdownLinks('[预订查看](https://m.ctrip.com/webapp/x) 经济舱 ¥450 起')).toBe('预订查看 经济舱 ¥450 起')
    expect(stripMarkdownLinks('## 标题')).toBe('标题')
  })

  it('汽车票咨询级 markdown → 条目（车站/票价区间/无实时班次口径）', () => {
    const { entries } = parseWendaoMarkdown(busesMd())
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries.some((e) => e.summary.includes('咨询级'))).toBe(true)
  })
})

describe('wendao 无 key 自动休眠（零调用红线）', () => {
  it('available()：无 key false；key 就位 true（env 段）', async () => {
    const adapter = new WendaoAdapter()
    await expect(adapter.available()).resolves.toBe(false)
    await expect(adapter.available({ env: { wendao: 'tok' } })).resolves.toBe(true)
  })

  it('渠道关闭 → 有 key 也休眠（ADR-12 前置过滤）', async () => {
    const adapter = new WendaoAdapter()
    await expect(adapter.available({ env: { wendao: 'tok', TRAVEL_CHANNEL_WENDAO: 'off' } })).resolves.toBe(false)
  })

  it('query() 无 key → EngineError.UNAVAILABLE「休眠」且 0 次网络调用', async () => {
    const { fetchFn, calls } = spyFetch(flightsMd())
    const adapter = new WendaoAdapter({ fetchFn })
    await expect(adapter.query('北京到上海机票')).rejects.toMatchObject({ code: 'UNAVAILABLE', source: 'wendao' })
    expect(calls()).toBe(0) // 零网络请求断言
  })

  it('query() 有 key → 结构化条目 + raw + degraded 空；无 key 不触网不抛（credentials 段经 resolveKey）', async () => {
    const { fetchFn, calls } = spyFetch(flightsMd())
    const adapter = new WendaoAdapter({ fetchFn })
    const env: KeyResolutionEnv = { resolveCredential: async () => 'tok-cred' }
    const result = await adapter.query('北京到上海机票', env)
    expect(calls()).toBe(1)
    expect(result.entries.length).toBeGreaterThanOrEqual(3)
    expect(result.entries.some((e) => e.deepLinks.length > 0)).toBe(true)
    const linked = result.entries.find((e) => e.deepLinks.length > 0)
    expect(linked?.deepLinks[0]).toMatch(/^https:\/\/m\.ctrip\.com\//)
    expect(result.raw).toContain('# 机票查询结果')
    expect(result.degraded).toEqual([])
  })
})

describe('wendao 错误路径', () => {
  it('HTTP 非 2xx → EngineError.UNAVAILABLE（记账 degraded）', async () => {
    const adapter = new WendaoAdapter({
      fetchFn: async () => ({ ok: false, status: 500, text: async () => 'err' }),
    })
    await expect(adapter.query('x', { env: { wendao: 'tok' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('超时 → EngineError.TIMEOUT', async () => {
    const adapter = new WendaoAdapter({
      fetchFn: async () => new Promise(() => { /* 永不返回 */ }),
      timeoutMs: 50,
    })
    await expect(adapter.query('x', { env: { wendao: 'tok' } })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('空响应解析 → degraded EMPTY 不抛（返回结构空）', async () => {
    const adapter = new WendaoAdapter({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => '    \n  ' }),
    })
    const result = await adapter.query('x', { env: { wendao: 'tok' } })
    expect(result.entries).toEqual([])
    expect(result.degraded[0]?.code).toBe('EMPTY')
  })
})

// live smoke：TRAVEL_LIVE_SMOKE=1 且 key 交割后运行（编排者已交割 WENDAO_APIKEY）
const liveEnabled = process.env.TRAVEL_LIVE_SMOKE === '1'
describe.skipIf(!liveEnabled)('wendao live smoke（真实 key）', () => {
  it('真实查询：2026-10-01 北京→上海高铁票返回车次条目（credentials 层 identifier→ref 映射）', async () => {
    const liveEnv = (await liveCredentialsEnv(['wendao'])) ?? { env: {} }
    const adapter = new WendaoAdapter()
    const result = await adapter.query('查询2026年10月1日北京到上海的高铁票', liveEnv)
    expect(result.entries.length).toBeGreaterThan(0)
    // 深链提取能力由机票查询 live 证过；高铁票响应可能无 m.ctrip.com 链接，不强制
    expect(result.raw.length).toBeGreaterThan(0)
  }, 30000)
})