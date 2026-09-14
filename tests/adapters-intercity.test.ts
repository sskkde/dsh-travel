/**
 * intercity 适配器单测：机票降级链 + 汽车票咨询级 + wendao/flyai/search 位。
 * fixture：wendao markdown（query-flights.md / query-buses.md）+ L0 搜索真实命中。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  IntercityAdapter, optionsFromHits, parseBusesFromMarkdown,
  parseFlightsFromMarkdown, type FlyaiLike, type SearchLike, type WendaoLike,
} from '../src/adapters/intercity.js'
import { parseWendaoMarkdown, type WendaoResult } from '../src/adapters/wendao.js'
import { EngineError } from '../src/adapters/base.js'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const flightsMd = () => readFileSync(path.join(FIX, 'wendao', 'query-flights.md'), 'utf8')
const busesMd = () => readFileSync(path.join(FIX, 'wendao', 'query-buses.md'), 'utf8')

/** 假 wendao：返回 fixture markdown 解析结果。 */
function wendaoStub(markdown: string): WendaoLike {
  return {
    name: 'wendao',
    async available() { return true },
    async query(): Promise<WendaoResult> {
      const { entries } = parseWendaoMarkdown(markdown)
      return { entries, raw: markdown, degraded: [] }
    },
  }
}

/** 假搜索：命中固定条目。 */
function searchStub(hits: { title: string; url: string; snippet?: string }[]): SearchLike {
  return { name: 'search-stub', async search() { return hits } }
}

describe('纯解析：wendao markdown → TransportOption（§5.5）', () => {
  it('机票：航班号/时刻/价格/时长/深链', () => {
    const opt = parseFlightsFromMarkdown([
      {
        title: '东航 MU5107 北京首都T2 08:00 → 上海虹桥T2 10:15 飞行时长 2小时15分 经济舱 ¥450 起',
        section: '北京 → 上海 2026-09-04',
        summary: '东航 MU5107 08:00 → 10:15 ¥450',
        deepLinks: ['https://m.ctrip.com/webapp/flight/schedule?flightNo=MU5107'],
      },
      {
        title: '国航 CA1501 09:00 → 11:05 ¥520 起',
        section: '北京 → 上海 2026-09-04',
        summary: '国航 CA1501 09:00 → 11:05 ¥520',
        deepLinks: ['https://m.ctrip.com/webapp/flight/schedule?flightNo=CA1501'],
      },
    ])
    expect(opt.length).toBe(2)
    expect(opt[0].mode).toBe('flight')
    expect(opt[0].segments[0]).toMatchObject({ no: 'MU5107', depart: '08:00', arrive: '10:15' })
    expect(opt[0].totalPriceRange).toEqual([450, 450])
    expect(opt[0].durationMinutes).toBe(135)
    expect(opt[0].source.url).toContain('m.ctrip.com')
  })

  it('机票 v2 形态端到端：正文无航班号 → 深链 dfltno 兜底；bullet 聚合条目出完整方案（W4 实测录制）', () => {
    const md = readFileSync(path.join(FIX, 'wendao', 'query-flights-v2.md'), 'utf8')
    const { entries } = parseWendaoMarkdown(md)
    const opt = parseFlightsFromMarkdown(entries, { from: '杭州', to: '北京' })
    expect(opt.length).toBe(5)
    const top = opt[0]
    expect(top.mode).toBe('flight')
    // 正文（航司标题/bullet）无航班号，从标题深链 dfltno=JD5907 兜底提取
    expect(top.segments[0].no).toBe('JD5907')
    expect(top.segments[0]).toMatchObject({ from: '杭州', to: '北京', depart: '21:45', arrive: '00:05' })
    expect(top.totalPriceRange).toEqual([340, 340])
    expect(top.durationMinutes).toBe(140) // 2h20m（跨天 21:45→次日 00:05）
    expect(top.source.url).toContain('m.ctrip.com')
    expect(top.source.url).toContain('dfltno=JD5907')
    // 五个航班全量完整（dfltno 各自正确，互不串）
    expect(opt.map((o) => o.segments[0].no)).toEqual(['JD5907', 'MU5140', 'MU9688', 'CZ8790', 'MF8129'])
    expect(opt.every((o) => (o.totalPriceRange?.[0] ?? 0) > 0)).toBe(true)
  })

  it('汽车票咨询级：车站/票价区间/车程（无实时班次口径）', () => {
    const opt = parseBusesFromMarkdown([
      {
        title: '杭州汽车西站 → 乌镇汽车站，票价区间 ¥30-45，车程约 1.5 小时',
        summary: '杭州汽车西站 → 乌镇汽车站，票价区间 ¥30-45，车程约 1.5 小时',
        deepLinks: ['https://m.ctrip.com/trains/bus'],
      },
      {
        title: '杭州九堡客运中心 → 乌镇汽车站，票价区间 ¥28-40',
        summary: '杭州九堡客运中心 → 乌镇汽车站，票价区间 ¥28-40',
        deepLinks: [],
      },
    ])
    expect(opt.length).toBe(2)
    expect(opt.every((o) => o.mode === 'bus')).toBe(true)
    expect(opt[0].segments[0].from).toContain('杭州汽车西站')
    expect(opt[0].tags?.some((t) => t.includes('咨询级'))).toBe(true)
  })

  it('L0 搜索命中 → 结构化降级（真实录制命中如无航班号/价格则如实空降级）', () => {
    const realHits = JSON.parse(readFileSync(path.join(FIX, 'intercity', 'flight-search-hits.json'), 'utf8')).hits
    const got = optionsFromHits(realHits, 'flight', '北京', '上海')
    for (const o of got) {
      expect(o.mode).toBe('flight')
      expect(o.tags?.some((t) => t.includes('搜索降级'))).toBe(true)
      expect(o.source.platform).toBe('web')
      expect(o.source.url).toBeTruthy()
    }
  })

  it('L0 命中含航班号/价格/时刻 → 结构化解析（CA1501 / ¥520）', () => {
    const got = optionsFromHits([
      { title: '国航CA1501 北京-上海 09:00起飞11:05到达 经济舱 ¥520', url: 'https://example.com/1', snippet: 'CA1501 ¥520' },
    ], 'flight', '北京', '上海')
    expect(got[0].segments[0]).toMatchObject({ no: 'CA1501', from: '北京', to: '上海' })
    expect(got[0].totalPriceRange).toEqual([520, 520])
  })
})

describe('机票降级链（wendao → flyai → search）', () => {
  it('wendao 可用 → 仅 wendao 结果（P0 命中不再降级）', async () => {
    const adapter = new IntercityAdapter({ wendao: wendaoStub(flightsMd()), search: searchStub([]) })
    const { options, degraded } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-04' })
    expect(options.length).toBeGreaterThanOrEqual(3)
    expect(options.every((o) => o.tags?.some((t) => t.includes('wendao')))).toBe(true)
    expect(degraded.length).toBe(0)
  })

  it('wendao 不可用（无 key 休眠）→ degraded「Key 未配置」+ search 兜底（W2a 注入后）', async () => {
    // 默认 wendao 位 = 真实 WendaoAdapter（无 key → 休眠，零网络）
    const adapter = new IntercityAdapter({ search: searchStub([{ title: '国航 CA1501 ¥520', url: 'https://e.com/x' }]) })
    const { options, degraded } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-04' }, { env: {} })
    expect(degraded.some((d) => d.source === 'intercity/wendao' && d.code === 'UNAVAILABLE')).toBe(true)
    expect(degraded.some((d) => d.source === 'intercity/flyai' && d.reason.includes('M2.3'))).toBe(true)
    expect(options.some((o) => o.tags?.some((t) => t.includes('搜索降级')))).toBe(true)
  })

  it('wendao 抛错 → UNAVAILABLE degraded，不中断整链', async () => {
    const failing: WendaoLike = {
      name: 'wendao',
      async available() { return true },
      async query() { throw EngineError.unavailable('wendao 500', 'wendao') },
    }
    const adapter = new IntercityAdapter({ wendao: failing, search: searchStub([{ title: 'MU5107 ¥450', url: 'https://e.com/1' }]) })
    const { degraded, options } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-04' })
    expect(degraded.some((d) => d.source === 'intercity/wendao' && d.code === 'UNAVAILABLE')).toBe(true)
    expect(options.length).toBeGreaterThanOrEqual(1)
  })

  it('flyai 位：注入可用实现 → 直取（M2.3 语义验证）', async () => {
    const flyai: FlyaiLike = {
      name: 'flyai',
      async available() { return true },
      async queryFlights() {
        return [{
          mode: 'flight' as const,
          segments: [{ from: '北京', to: '上海', no: 'CZ8888', depart: '07:00', arrive: '09:00' }],
          source: { platform: 'flyai', url: 'https://f.ly/ai', fetchedAt: new Date().toISOString() },
        }]
      },
      async queryTrains() { return [] },
    }
    const adapter = new IntercityAdapter({ flyai, search: searchStub([]) })
    const { options } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-04' })
    expect(options[0].segments[0].no).toBe('CZ8888')
  })

  it('全链空 → 空 options + 逐源 degraded（wendao 休眠/flyai M2.3/search 未注入）', async () => {
    const adapter = new IntercityAdapter({}) // 默认 wendao（无 key）+ 无 search 注入
    const { options, degraded } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-04' }, { env: {} })
    expect(options).toEqual([])
    const sources = degraded.map((d) => d.source)
    expect(sources).toContain('intercity/wendao')
    expect(sources).toContain('intercity/flyai')
    expect(sources).toContain('intercity/search')
    // 无 key 时未触网（默认 wendao 休眠零调用）
  })
})

describe('汽车票（咨询级）', () => {
  it('wendao 咨询级解析 → bus options（车站/票价区间）', async () => {
    const adapter = new IntercityAdapter({ wendao: wendaoStub(busesMd()) })
    const { options } = await adapter.searchBuses({ from: '杭州', to: '乌镇', date: '2026-09-10' })
    expect(options.length).toBeGreaterThanOrEqual(1)
    expect(options.every((o) => o.mode === 'bus')).toBe(true)
  })
})

describe('intercity 渠道开关（ADR-12 前置过滤）', () => {
  it('wendao 渠道关闭与 Key 缺失分别给出可核对的 degraded 成因文案', async () => {
    const adapter = new IntercityAdapter({ search: searchStub([]) })

    const disabled = await adapter.searchFlights(
      { from: '北京', to: '上海', date: '2026-09-04' },
      { env: { TRAVEL_CHANNEL_WENDAO: 'off' } },
    )
    expect(disabled.degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('已停用（用户配置）'))).toBe(true)
    expect(disabled.degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('Key 未配置'))).toBe(false)

    const missingKey = await adapter.searchFlights(
      { from: '北京', to: '上海', date: '2026-09-04' },
      { env: {} },
    )
    expect(missingKey.degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('Key 未配置（休眠）'))).toBe(true)
    expect(missingKey.degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('已停用（用户配置）'))).toBe(false)
  })

  it('开关开启且 Key 已配置但适配器未就绪时，不冒充 Key 缺失', async () => {
    const unavailable: WendaoLike = {
      name: 'wendao',
      async available() { return false },
      async query() { return { entries: [], raw: '', degraded: [] } },
    }
    const adapter = new IntercityAdapter({ wendao: unavailable, search: searchStub([]) })
    const result = await adapter.searchFlights(
      { from: '北京', to: '上海', date: '2026-09-04' },
      { env: { wendao: 'configured' } },
    )
    expect(result.degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('Key 未配置'))).toBe(false)
    expect(result.degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('适配器未就绪'))).toBe(true)
  })

  it('available()：缺省 true；TRAVEL_CHANNEL_INTERCITY=off → false', async () => {
    const adapter = new IntercityAdapter({ wendao: wendaoStub(flightsMd()) })
    await expect(adapter.available()).resolves.toBe(true)
    await expect(adapter.available({ env: { TRAVEL_CHANNEL_INTERCITY: 'off' } })).resolves.toBe(false)
    await expect(adapter.available({ readSettings: (k) => (k === 'channels.intercity' ? 'false' : undefined) })).resolves.toBe(false)
  })
})