/**
 * W4 机票链路三档 + 火车互备单测（M2.3）：
 * - 降级链编排：wendao 超时→flyai 接管；两档均挂→L0 搜索降级；三档全空→明示
 *   人工比价+官方渠道链接（§2.1 FR-4 城际行全链不中断出口）
 * - 火车互备：searchTrains（wendao→flyai→search）；12306 不可用→互备产出火车方案
 * - wendao 请求模板拼接（design §5.1 行 268）；flyai flag 映射+枚举翻译表（行 269）
 * - flyai 响应归一（直达/价格/时刻/jumpUrl）与二进制解析链
 * - rail12306 readOnlyGate/callToolRaw 契约锁形（xhs 820e6f3 运行依赖的接口面）：
 *   注入闸门优先、拒绝即拒网、callToolRaw 全 content 块、会话策略单点化
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError, type KeyResolutionEnv } from '../src/adapters/base.js'
import {
  IntercityAdapter, OFFICIAL_BOOKING_LINKS, optionsFromHits,
  parseFlightsFromMarkdown, type FlyaiLike, type SearchLike, type WendaoLike,
} from '../src/adapters/intercity.js'
import { buildWendaoQuery, extractJsonErrorPayload, parseWendaoMarkdown, WendaoAdapter, type WendaoResult } from '../src/adapters/wendao.js'
import {
  buildFlyaiArgs, flyaiItemToOption, hhmmOfDatetime, optionsFromFlyai,
  resolveFlyaiCommand, SEAT_CLASS_EN, translateSeatClass, FlyaiAdapter,
  type FlyaiApiResult,
} from '../src/adapters/flyai.js'
import {
  McpStreamClient, Rail12306Adapter, READ_ONLY_TOOLS, type FetchLike,
} from '../src/adapters/rail12306.js'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchTransport } from '../src/tools/research-transport.js'

// ────────────────────────── stub 工厂 ──────────────────────────

function wendaoStub(markdown: string, opts: { available?: boolean; throws?: Error } = {}): WendaoLike {
  return {
    name: 'wendao',
    async available() { return opts.available ?? true },
    async query(): Promise<WendaoResult> {
      if (opts.throws) throw opts.throws
      const { entries } = parseWendaoMarkdown(markdown)
      return { entries, raw: markdown, degraded: [] }
    },
  }
}

function flyaiStub(opts: { available?: boolean; flights?: never[]; trains?: never[]; flightsThrow?: Error; trainsThrow?: Error } = {}): FlyaiLike {
  return {
    name: 'flyai',
    async available() { return opts.available ?? true },
    async queryFlights() {
      if (opts.flightsThrow) throw opts.flightsThrow
      return opts.flights ?? []
    },
    async queryTrains() {
      if (opts.trainsThrow) throw opts.trainsThrow
      return opts.trains ?? []
    },
  }
}

const searchStub = (hits: { title: string; url: string; snippet?: string }[]): SearchLike =>
  ({ name: 'search-stub', async search() { return hits } })

const FLIGHTS_MD = `# 北京 → 上海 2026-09-20 机票\n\n1. 东航 MU5107 北京首都T2 08:00 → 上海虹桥T2 10:15 经济舱 ¥450 起\n   [查看](https://m.ctrip.com/webapp/flight/schedule?flightNo=MU5107&date=2026-09-20)\n2. 国航 CA1501 09:00 → 11:05 ¥520 起\n   [查看](https://m.ctrip.com/webapp/flight/schedule?flightNo=CA1501)\n`

const TRAINS_MD = `# 北京 → 上海 2026-09-20 火车票\n\n1. 高铁 G3 北京南 07:00 → 上海虹桥 11:35，二等座 ¥553 起\n   [查看](https://m.ctrip.com/webapp/train?no=G3)\n2. 高铁 G11 08:00 → 12:55，二等座 ¥662 起\n   [查看](https://m.ctrip.com/webapp/train?no=G11)\n`

const flyaiFlightOption = () => [{
  mode: 'flight' as const,
  segments: [{ from: '北京大兴', to: '上海浦东', no: 'CZ8888', depart: '07:00', arrive: '09:00' }],
  totalPriceRange: [410, 410] as [number, number],
  source: { platform: 'flyai', url: 'https://f.ly/ai', fetchedAt: new Date().toISOString() },
}]

const flyaiTrainOption = () => [{
  mode: 'rail' as const,
  segments: [{ from: '北京南', to: '上海虹桥', no: 'G547', depart: '06:18', arrive: '12:11' }],
  totalPriceRange: [553, 553] as [number, number],
  source: { platform: 'flyai', url: 'https://f.ly/train', fetchedAt: new Date().toISOString() },
}]

// ────────────────────────── ① 降级链编排 ──────────────────────────

describe('机票三档降级链（M2.3 编排）', () => {
  it('wendao 超时 → flyai 接管（degraded 留 TIMEOUT 账，产出 flyai 方案）', async () => {
    const adapter = new IntercityAdapter({
      wendao: wendaoStub('', { throws: EngineError.timeout('wendao 查询超时（20000ms）') }),
      flyai: flyaiStub({ flights: flyaiFlightOption() }),
    })
    const { options, degraded } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-20' })
    expect(options.length).toBe(1)
    expect(options[0].source.platform).toBe('flyai')
    expect(degraded.some((d) => d.source === 'intercity/wendao' && d.code === 'TIMEOUT')).toBe(true)
    expect(degraded.some((d) => d.source === 'intercity/flyai')).toBe(false)
  })

  it('两档均挂（wendao 休眠 + flyai 不可用）→ L0 搜索降级接管（结构化航段）', async () => {
    const adapter = new IntercityAdapter({
      wendao: wendaoStub('', { available: false }),
      flyai: flyaiStub({ available: false }),
      search: searchStub([
        { title: '国航CA1501 北京-上海 09:00起飞11:05到达 经济舱 ¥520', url: 'https://example.com/ca1501', snippet: 'CA1501 ¥520' },
      ]),
    })
    const { options, degraded } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-20' })
    expect(options.length).toBeGreaterThanOrEqual(1)
    expect(options[0].tags?.some((t) => t.includes('搜索降级'))).toBe(true)
    expect(options[0].segments[0]).toMatchObject({ no: 'CA1501', from: '北京', to: '上海' })
    expect(degraded.some((d) => d.source === 'intercity/wendao' && d.reason.includes('Key 未配置'))).toBe(true)
    expect(degraded.some((d) => d.source === 'intercity/flyai')).toBe(true)
  })

  it('三档全空 → 明示人工比价 + 官方渠道链接（§2.1 FR-4 最后出口）', async () => {
    const adapter = new IntercityAdapter({
      wendao: wendaoStub('', { available: false }),
      flyai: flyaiStub({ available: false }),
      search: searchStub([]),
    })
    const { options, degraded } = await adapter.searchFlights({ from: '北京', to: '上海', date: '2026-09-20' })
    expect(options).toEqual([])
    const manual = degraded.find((d) => d.source === 'intercity/manual')
    expect(manual).toBeDefined()
    expect(manual?.code).toBe('EMPTY')
    expect(manual?.reason).toContain('人工比价')
    expect(manual?.reason).toContain(OFFICIAL_BOOKING_LINKS.flight)
    expect(OFFICIAL_BOOKING_LINKS.flight).toContain('ctrip.com')
    expect(OFFICIAL_BOOKING_LINKS.flight).toContain('fliggy.com')
  })

  it('互备链第三段：rail 搜索降级官方链接指向 12306', () => {
    expect(OFFICIAL_BOOKING_LINKS.rail).toContain('12306.cn')
  })

  it('火车互备：searchTrains wendao 段命中（12306 不可用场景的适配器语义）', async () => {
    const adapter = new IntercityAdapter({ wendao: wendaoStub(TRAINS_MD) })
    const { options, degraded } = await adapter.searchTrains({ from: '北京', to: '上海', date: '2026-09-20' })
    expect(options.length).toBeGreaterThanOrEqual(2)
    expect(options[0].mode).toBe('rail')
    expect(options[0].segments[0]).toMatchObject({ no: 'G3', from: '北京', to: '上海' })
    expect(options[0].bookingTips?.some((t) => t.includes('12306'))).toBe(true)
    expect(degraded).toHaveLength(0)
  })

  it('火车互备：wendao 空 → flyai search-train 接管（queryTrains 位）', async () => {
    const trains = vi.fn(async () => flyaiTrainOption())
    const adapter = new IntercityAdapter({
      wendao: wendaoStub('（无结构化内容）'),
      flyai: { name: 'flyai', async available() { return true }, async queryFlights() { return [] }, queryTrains: trains },
    })
    const { options, degraded } = await adapter.searchTrains({ from: '北京', to: '上海', date: '2026-09-20' })
    expect(trains).toHaveBeenCalledTimes(1)
    expect(options[0].segments[0].no).toBe('G547')
    expect(degraded.some((d) => d.source === 'intercity/wendao' && d.code === 'EMPTY')).toBe(true)
  })

  it('bus 段不触 flyai 位（flyai 无汽车票命令）', async () => {
    const flights = vi.fn(async () => [])
    const trains = vi.fn(async () => [])
    const adapter = new IntercityAdapter({
      wendao: wendaoStub('（无）'),
      flyai: { name: 'flyai', async available() { return true }, queryFlights: flights, queryTrains: trains },
    })
    const { degraded } = await adapter.searchBuses({ from: '杭州', to: '乌镇', date: '2026-09-20' })
    expect(flights).not.toHaveBeenCalled()
    expect(trains).not.toHaveBeenCalled()
    expect(degraded.some((d) => d.source === 'intercity/flyai')).toBe(false)
  })
})

// ────────────────────────── 工具层互备切换 ──────────────────────────

describe('research_transport 火车互备切换（M2.3）', () => {
  let root: string
  let store: TravelStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-travel-w4-'))
    store = new TravelStore(root)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const makePlan = async (): Promise<string> => {
    const r = await runIntake({
      mode: 'plan',
      slots: {
        destination: '上海', origin: '北京', dateStart: '2026-09-20', dateEnd: '2026-09-22',
        travelers: { adults: 1 },
      },
    }, store)
    // F1c-E（决策 5）：destination-only 新 plan 自动 flowVersion → 完整链受门；本测试
    // 验证 legacy 轻量单点城际路径（SKILL §3 保留），模拟真正 legacy（无信封）。
    const req = await store.loadRequest(r.planId)
    await store.saveRequest({ ...req!, flowVersion: undefined })
    return r.planId
  }

  /** 12306 不可达（connection refused 注入）。 */
  const railDown = () => new Rail12306Adapter({
    mcp: new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp',
      fetchFn: async () => { throw new Error('ECONNREFUSED') },
    }),
  })

  it('12306 不可用 → intercity.searchTrains 互备产出火车方案（wendao 段）', async () => {
    const planId = await makePlan()
    const intercity = new IntercityAdapter({ wendao: wendaoStub(TRAINS_MD) })
    const result = await runResearchTransport(
      { planId, modes: ['rail'] }, store,
      { rail: railDown(), intercity, env: { env: { rail12306: '1' } } },
    )
    expect(result.degraded.some((d) => d.source === 'rail12306' && d.code === 'UNAVAILABLE')).toBe(true)
    const railOpts = result.options.filter((o) => o.mode === 'rail')
    expect(railOpts.length).toBeGreaterThanOrEqual(1)
    expect(railOpts[0].segments[0].no).toBe('G3')
    const persisted = await store.readJson(planId, 'transport.json')
    expect(persisted).toBeDefined()
  })

  it('互备两段全空 → 工具层 degraded 明示人工比价 + 12306 官方链接', async () => {
    const planId = await makePlan()
    const intercity = new IntercityAdapter({
      wendao: wendaoStub('', { available: false }),
      search: searchStub([]),
    })
    const result = await runResearchTransport(
      { planId, modes: ['rail'] }, store,
      { rail: railDown(), intercity, env: { env: { rail12306: '1' } } },
    )
    expect(result.options).toHaveLength(0)
    expect(result.degraded.some((d) => d.source === 'intercity/manual' && d.reason.includes('12306.cn'))).toBe(true)
  })
})

// ────────────────────────── ② wendao 模板 + flyai 变换 ──────────────────────────

describe('请求变换（design §5.1 行 268-269）', () => {
  it('wendao 模板拼接：查询{date}{origin}到{destination}的机票', () => {
    expect(buildWendaoQuery('flight', '杭州', '北京', '2026-09-20')).toBe('查询2026-09-20杭州到北京的机票')
    expect(buildWendaoQuery('rail', '杭州', '北京', '2026-09-20')).toBe('查询2026-09-20杭州到北京的火车票')
    expect(buildWendaoQuery('bus', '杭州', '乌镇', '2026-09-20')).toBe('查询2026-09-20杭州到乌镇的汽车票')
    expect(buildWendaoQuery('flight', '杭州', '北京')).toBe('查询杭州到北京的机票')
  })

  it('枚举翻译表（CLI --help 原文取值）：二等座→second class 等', () => {
    expect(translateSeatClass('二等座')).toBe('second class')
    expect(translateSeatClass('一等座')).toBe('first class')
    expect(translateSeatClass('商务座')).toBe('business class')
    expect(translateSeatClass('硬卧')).toBe('hard sleeper')
    expect(translateSeatClass('软卧')).toBe('soft sleeper')
    expect(translateSeatClass('经济舱')).toBe('economy')
    expect(translateSeatClass('商务舱')).toBe('business')
    expect(translateSeatClass('头等舱')).toBe('first')
    expect(translateSeatClass('豪华头等舱')).toBe('first')
    expect(translateSeatClass('超级经济舱')).toBe('economy')
    expect(translateSeatClass('全新的席别')).toBeUndefined()
    expect(translateSeatClass('  ')).toBeUndefined()
    expect(Object.keys(SEAT_CLASS_EN).length).toBeGreaterThanOrEqual(10)
  })

  it('flyai flag 映射：--origin/--destination/--dep-date/--seat-class-name/--sort-type', () => {
    expect(buildFlyaiArgs('search-flight', { from: '杭州', to: '北京', date: '2026-09-20', seatClass: '经济舱' })).toEqual([
      'search-flight', '--origin', '杭州', '--destination', '北京', '--dep-date', '2026-09-20',
      '--seat-class-name', 'economy', '--sort-type', '2',
    ])
    expect(buildFlyaiArgs('search-train', { from: '北京', to: '上海', date: '2026-09-20', seatClass: '二等座' })).toEqual([
      'search-train', '--origin', '北京', '--destination', '上海', '--dep-date', '2026-09-20',
      '--seat-class-name', 'second class', '--sort-type', '2',
    ])
    // 未收录席别 → 省略 flag（不传脏值）
    expect(buildFlyaiArgs('search-flight', { from: 'A', to: 'B', date: '2026-09-20' })).not.toContain('--seat-class-name')
  })
})

// ────────────────────────── ③ flyai 归一化 + 二进制解析链 ──────────────────────────

const FLYAI_FIXTURE: FlyaiApiResult = {
  status: 0,
  message: 'ok',
  data: {
    itemList: [
      {
        jumpUrl: 'https://h5.m.fliggy.com/booking?CA8341',
        ticketPrice: 370,
        totalDuration: 105,
        journeys: [{
          journeyType: '直达',
          totalDuration: 105,
          segments: [{
            depCityName: '北京', depStationName: '大兴机场', arrCityName: '上海', arrStationName: '浦东T2',
            depDateTime: '2026-09-20 22:00:00', arrDateTime: '2026-09-20 23:45:00',
            marketingTransportName: '国航', marketingTransportNo: 'CA8341', seatClassName: '经济舱',
          }],
        }],
      },
      // 中转组合（多段）→ 跳过
      {
        ticketPrice: 300,
        journeys: [{ journeyType: '中转', segments: [{ depStationName: 'A', arrStationName: 'B' }] }],
      },
    ],
  },
}

describe('flyai 响应归一（§5.1 项 3）', () => {
  it('直达条目 → TransportOption（元/分钟/HH:mm/jumpUrl→source.url）', () => {
    const got = optionsFromFlyai(FLYAI_FIXTURE, 'flight', false)
    expect(got).toHaveLength(1)
    const opt = got[0]
    expect(opt.mode).toBe('flight')
    expect(opt.segments[0]).toMatchObject({ no: 'CA8341', from: '大兴机场', to: '浦东T2', depart: '22:00', arrive: '23:45' })
    expect(opt.totalPriceRange).toEqual([370, 370])
    expect(opt.durationMinutes).toBe(105)
    expect(opt.source.url).toContain('fliggy.com')
    expect(opt.tags).toContain('飞猪 flyai（零 key 试用档）')
    expect(opt.tags).toContain('经济舱')
  })

  it('正式档标签（key 就位）+ 票价字符串容错', () => {
    const opt = flyaiItemToOption((FLYAI_FIXTURE.data?.itemList ?? [])[0]!, 'flight', true)
    expect(opt?.tags?.[0]).toBe('飞猪 flyai（正式档）')
    const strPrice = flyaiItemToOption({ ...(FLYAI_FIXTURE.data?.itemList ?? [])[0]!, ticketPrice: '460.5' }, 'flight', false)
    expect(strPrice?.totalPriceRange).toEqual([460.5, 460.5])
  })

  it('status=1（火车档间歇空）→ EngineError.EMPTY（不伪造，交降级链）', async () => {
    const empty: FlyaiApiResult = { status: 1, message: '智慧交通结果为空', data: { itemList: [] } }
    expect(optionsFromFlyai(empty, 'rail', false)).toHaveLength(0)
    const adapter = new FlyaiAdapter({ binPath: join(tmpdir(), 'definitely-missing-flyai') })
    // 二进制缺失 → UNAVAILABLE（available()=false 路径）
    await expect(adapter.available()).resolves.toBe(false)
  })

  it('hhmmOfDatetime：取 HH:mm 段并补零', () => {
    expect(hhmmOfDatetime('2026-09-20 6:08:00')).toBe('06:08')
    expect(hhmmOfDatetime('2026-09-20 22:00:00')).toBe('22:00')
    expect(hhmmOfDatetime(undefined)).toBeUndefined()
    expect(hhmmOfDatetime('无时刻')).toBeUndefined()
  })

  it('二进制解析链：显式 .cjs 走 node；缺失 binPath → undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flyai-bin-'))
    try {
      const cjs = join(dir, 'fake-flyai.cjs')
      writeFileSync(cjs, 'console.log("{}")')
      expect(resolveFlyaiCommand(cjs)).toEqual({ file: process.execPath, args: [cjs] })
      expect(resolveFlyaiCommand(join(dir, 'missing'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ────────────────────────── ④ rail12306 readOnlyGate/callToolRaw 契约锁形 ──────────────────────────

/** 最小 JSON-RPC 传输桩：按脚本应答；记录请求体。 */
function scriptedFetch(responses: Array<Record<string, unknown>>, calls: string[] = []): FetchLike {
  let i = 0
  return async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    calls.push(`${body.method ?? ''}`)
    const result = responses[Math.min(i, responses.length - 1)]
    i += 1
    if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }
  }
}

describe('McpStreamClient readOnlyGate/callToolRaw 契约锁形（xhs 820e6f3 运行依赖）', () => {
  it('注入闸门优先于 rail12306 缺省白名单（xhs 工具名过闸触网）', async () => {
    const gate = vi.fn((name: string) => {
      if (!name.startsWith('xhs_')) throw EngineError.unavailable(`工具 ${name} 不在 xhs 白名单`, 'xhs')
    })
    const calls: string[] = []
    const client = new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp',
      fetchFn: scriptedFetch([
        { protocolVersion: '2025-11-25', capabilities: {} },
        { content: [{ type: 'text', text: '{"ok":true}' }] },
      ], calls),
      readOnlyGate: gate,
    })
    const out = await client.callTool('xhs_search_feeds', { keyword: '断桥' })
    expect(gate).toHaveBeenCalledWith('xhs_search_feeds')
    expect(out).toEqual({ ok: true })
    expect(calls).toContain('tools/call')
  })

  it('注入闸门拒绝 → 抛错且零网络（rail12306 白名单不得旁路注入闸）', async () => {
    const gate = vi.fn(() => { throw EngineError.unavailable('交易类调用被拒绝', 'xhs') })
    const calls: string[] = []
    const client = new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp',
      fetchFn: scriptedFetch([], calls),
      readOnlyGate: gate,
    })
    await expect(client.callTool('xhs_search_feeds', {})).rejects.toThrow('交易类调用被拒绝')
    await expect(client.callToolRaw('xhs_search_feeds', {})).rejects.toThrow('交易类调用被拒绝')
    expect(gate).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(0) // 闸门先行：未发任何 JSON-RPC 请求
  })

  it('缺省闸门 = rail12306 白名单：白名单外工具拒绝', async () => {
    const client = new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp',
      fetchFn: scriptedFetch([
        { protocolVersion: '2025-11-25', capabilities: {} },
        { content: [{ type: 'text', text: '{"trains":[]}' }] },
      ]),
    })
    await expect(client.callTool('buy-ticket', {})).rejects.toThrow('只读白名单')
    await expect(client.callTool('query-tickets', {})).resolves.toBeDefined()
  })

  it('callToolRaw 返回全 content 块（xhs get_login_qrcode「文本+图片」双块形）', async () => {
    const imageBlock = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    const client = new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp',
      fetchFn: scriptedFetch([
        { protocolVersion: '2025-11-25', capabilities: {} },
        { content: [{ type: 'text', text: '请扫码' }, imageBlock], isError: false },
      ]),
    })
    const payload = await client.callToolRaw('get-current-time', {})
    expect(Object.keys(payload)).toContain('content')
    expect((payload.content as unknown[])).toHaveLength(2)
    expect((payload.content as Array<Record<string, unknown>>)[1]).toEqual(imageBlock)
    // 对照：callTool 只取首个 text 块解析（图片块不吞 JSON 解析）
    const parsed = await client.callTool('get-current-time', {})
    expect(parsed).toBe('请扫码')
  })

  it('会话策略单点化：callTool 委托 callToolRaw，无双重 initialize/DELETE', async () => {
    const calls: string[] = []
    const client = new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp',
      fetchFn: scriptedFetch([
        { protocolVersion: '2025-11-25', capabilities: {} },
        { content: [{ type: 'text', text: '{"ts":1}' }] },
      ], calls),
      idleTimeoutMs: 0, // 立即过期：若 callTool 重复 ensureSessionFresh 会产生多余 DELETE
    })
    await client.callTool('get-current-time', {})
    const initCount = calls.filter((m) => m === 'initialize').length
    expect(initCount).toBe(1)
    expect(calls[calls.length - 1]).toBe('tools/call')
  })

  it('接口锁形：READ_ONLY_TOOLS 白名单不含交易类（红线不随重构漂移）', () => {
    for (const name of READ_ONLY_TOOLS) expect(name).not.toMatch(/buy|pay|order|booking|候补|购票|抢票|代付|支付|下单|预订/i)
  })
})

// ────────────────────────── ⑤ wendao 深链提取（flight 档溯源面） ──────────────────────────

describe('wendao 上游 JSON 错误体加固（W4 live 实测：per-token 每日 30 次配额）', () => {
  it('HTTP 200 + {"error":...} → EngineError.UNAVAILABLE 原文透传（不进 markdown 解析）', async () => {
    const w = new WendaoAdapter({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => '{"error":"Per-token daily limit exceeded (30)."}' }),
    })
    await expect(w.query('查询2026-09-20杭州到北京的机票', { resolveCredential: async () => 'k' }))
      .rejects.toThrow('Per-token daily limit exceeded (30).')
  })

  it('extractJsonErrorPayload：错误体命中 / markdown 与非错误 JSON 不误伤', () => {
    expect(extractJsonErrorPayload('{"error":"Per-token daily limit exceeded (30)."}')).toBe('Per-token daily limit exceeded (30).')
    expect(extractJsonErrorPayload('{"ok":true}')).toBeUndefined()
    expect(extractJsonErrorPayload('# 机票查询结果\n1. 东航 MU5107 ¥450')).toBeUndefined()
    expect(extractJsonErrorPayload('{"error":残缺')).toBeUndefined()
  })
})

describe('wendao 机票 markdown → 方案（航司/时刻/价格/深链）', () => {
  it('parseFlightsFromMarkdown 注入起讫城市（占位「城市」消除）', () => {
    const { entries } = parseWendaoMarkdown(FLIGHTS_MD)
    const opts = parseFlightsFromMarkdown(entries, { from: '北京', to: '上海' })
    expect(opts.length).toBeGreaterThanOrEqual(2)
    expect(opts[0].segments[0]).toMatchObject({ no: 'MU5107', from: '北京', to: '上海', depart: '08:00', arrive: '10:15' })
    expect(opts[0].totalPriceRange).toEqual([450, 450])
    expect(opts[0].durationMinutes).toBe(135)
    expect(opts[0].source.url).toContain('m.ctrip.com')
  })

  it('L0 搜索降级 rail 段：车次结构化（TRAIN_NO）', () => {
    const got = optionsFromHits([
      { title: '京沪高铁G3次 北京南07:00开 上海虹桥11:35到 二等座¥553', url: 'https://example.com/g3' },
    ], 'rail', '北京', '上海')
    expect(got[0].segments[0]).toMatchObject({ no: 'G3', depart: '07:00', arrive: '11:35' })
    expect(got[0].totalPriceRange).toEqual([553, 553])
    expect(got[0].bookingTips?.[0]).toContain('12306')
  })
})

// 静默守卫：KeyResolutionEnv 形状引用（flyai 零 key 档 resolveKey 链类型面）
export type { KeyResolutionEnv }
