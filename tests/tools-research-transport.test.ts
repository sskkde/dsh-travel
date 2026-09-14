/**
 * travel_research_transport 单测（M1 建，M2 W4 扩）：
 * rail=12306 MCP golden（真实班次+票价档 → FR-4 验收①）、rail 降级链（wendao 咨询）、
 * flight 降级链、bus 咨询级、市内衔接=高德 transit 单方案路径（本文件不注入 didi 渠道；
 * didi 聚合与双方案出口另见 tests/adapters-didi.test.ts、tests/live-w5-smoke.test.ts）、
 * ≥2 方案对比四维度、契约闸门/状态机/全链路失败不产空 transport.json。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchTransport, createTravelResearchTransportTool, TRANSPORT_TIMEOUT_MS } from '../src/tools/research-transport.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { Rail12306Adapter, McpStreamClient, READ_ONLY_TOOLS, type FetchLike } from '../src/adapters/rail12306.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'
import { IntercityAdapter, type WendaoLike } from '../src/adapters/intercity.js'
import { parseWendaoMarkdown, type WendaoResult } from '../src/adapters/wendao.js'
import { TravelValidationError } from '../src/errors.js'
import { validateTransportOption } from '../src/models/validate.js'
import type { TransportOption } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-transport-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const FIX = join('tests', 'fixtures')
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'))
}
function fixText(name: string): string {
  return readFileSync(join(FIX, name), 'utf8')
}

/** 假 MCP：按工具名回放 fixture（initialize/notifications/tools/list/call 全协议）。 */
function fakeMcp(fixtures: Record<string, unknown>): McpStreamClient {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    const okResp = (result: unknown, sessionId?: string) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      ...(sessionId ? { headers: { 'mcp-session-id': sessionId } } : {}),
    })
    if (body.method === 'initialize') {
      return okResp({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-12306', version: 'test' } }, 'fake-session')
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/list') {
      return okResp({ tools: READ_ONLY_TOOLS.map((n) => ({ name: n, description: 'read-only', inputSchema: { type: 'object' } })) })
    }
    if (body.method === 'tools/call') {
      const result = fixtures[body.params.name]
      if (result === undefined) return okResp({ content: [{ type: 'text', text: 'no fixture' }] })
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      return okResp({ content: [{ type: 'text', text }] })
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601 } }) }
  }
  return new McpStreamClient({ url: 'http://127.0.0.1:8123/mcp', fetchFn })
}

/** 假 wendao（WendaoLike 位）：解析 markdown fixture 文本。 */
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

/** amap stub fetch：按端点回放 fixture（离线）。 */
function amapStub(): { fetchFn: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> } {
  const files: Record<string, { response: Record<string, unknown> }> = {
    'direction/transit/integrated': fixture('amap/transit.json') as { response: Record<string, unknown> },
    'geocode/geo': fixture('amap/geocode.json') as { response: Record<string, unknown> },
    distance: fixture('amap/distance.json') as { response: Record<string, unknown> },
  }
  return {
    fetchFn: async (url) => {
      const hit = Object.entries(files).find(([ep]) => url.includes(ep))
      if (!hit) throw new Error(`no fixture for ${url}`)
      return { ok: true, status: 200, text: async () => JSON.stringify(hit[1].response) }
    },
  }
}

const RAIL_ENV_KEY: KeyResolutionEnv = { env: { rail12306: '1', amapWebservice: 'test-key' } }

/** 构造已确认计划（北京→上海，日期与 rail 录制 fixture 一致）。
 *  F1c-E（决策 5）：destination-only 新 plan 自动 flowVersion → 完整链受门。本测试
 *  验证的是 legacy 轻量单点交通路径（SKILL §3 保留），故模拟真正 legacy 形态
 *  （请求文件无 flowVersion 信封），保持既有 rail/市内衔接断言不变。 */
async function makePlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      origin: '北京',
      destination: '上海',
      dateStart: '2026-09-04',
      dateEnd: '2026-09-06',
      days: 3,
      travelers: { adults: 2, seniors: 1 },
      ...slots,
    },
  }, store)
  const req = await store.loadRequest(result.planId)
  await store.saveRequest({ ...req!, flowVersion: undefined })
  return result.planId
}

function railFixtureDeps() {
  return {
    rail: new Rail12306Adapter({
      mcp: fakeMcp({
        'query-tickets': (fixture('rail12306/query-tickets.json') as { result: unknown }).result,
        'query-ticket-price': (fixture('rail12306/query-ticket-price.json') as { result: unknown }).result,
      }),
    }),
    intercity: new IntercityAdapter({ wendao: wendaoStub(fixText('wendao/query-flights.md')) }),
    amap: new AmapAdapter({ fetchFn: amapStub().fetchFn }),
    env: RAIL_ENV_KEY,
  }
}

describe('rail：12306 MCP golden（FR-4 验收①）', () => {
  it('≥2 方案且 ≥1 含班次时间与价格档 + transport.json 落盘 + 状态 researching', async () => {
    const planId = await makePlan()
    // rail+flight（bus 咨询级需专用 bus fixture，独立用例覆盖）
    const result = await runResearchTransport({ planId, modes: ['rail', 'flight'] }, store, railFixtureDeps())

    expect(result.options.length).toBeGreaterThanOrEqual(2)
    const withSchedule = result.options.filter((o) =>
      o.segments[0]?.no !== undefined && o.segments[0]?.depart !== undefined && o.segments[0]?.arrive !== undefined)
    expect(withSchedule.length).toBeGreaterThanOrEqual(1)
    const withPrice = result.options.filter((o) => o.totalPriceRange !== undefined)
    expect(withPrice.length).toBeGreaterThanOrEqual(1)
    expect(result.options.every((o) => validateTransportOption(o).length === 0)).toBe(true)

    const persisted = await store.readJson<TransportOption[]>(planId, 'transport.json')
    expect(persisted).toBeDefined()
    expect(persisted!.length).toBe(result.options.length)
    for (const opt of persisted!) expect(validateTransportOption(opt)).toEqual([])

    const request = await store.loadRequest(planId)
    expect(request?.status).toBe('researching')
    expect(result.degraded.length).toBe(0)
  })

  it('rail 首班车次 = 录制 G531（06:08→12:04，票价档来自 query-ticket-price）', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, railFixtureDeps())
    const top = result.options[0]
    expect(top.mode).toBe('rail')
    expect(top.segments[0]).toMatchObject({ no: 'G531', depart: '06:08', arrive: '12:04' })
    expect(top.totalPriceRange).toBeDefined()
    expect(top.segments[0].priceRange).toEqual(top.totalPriceRange)
  })

  it('rail 查询成功但空班次 → searchTrains 只触发一次且互备方案并入', async () => {
    const planId = await makePlan()
    const rail = new Rail12306Adapter({
      mcp: fakeMcp({ 'query-tickets': { success: true, trains: [] } }),
    })
    let fallbackCalls = 0
    const fallbackWendao: WendaoLike = {
      name: 'wendao',
      async available() { return true },
      async query() {
        fallbackCalls += 1
        const { entries } = parseWendaoMarkdown(
          '## 北京 → 上海 2026-09-04\n\n高铁 G3 北京南 07:00 → 上海虹桥 11:35，二等座 ¥553 起',
        )
        return { entries, raw: '', degraded: [] }
      },
    }
    const intercity = new IntercityAdapter({ wendao: fallbackWendao })
    const result = await runResearchTransport(
      { planId, modes: ['rail'] }, store,
      { rail, intercity, env: RAIL_ENV_KEY },
    )
    expect(fallbackCalls).toBe(1)
    expect(result.options.some((o) => o.mode === 'rail' && o.segments[0]?.no === 'G3')).toBe(true)
    expect(result.degraded.some((d) => d.source === 'rail12306' && d.code === 'EMPTY')).toBe(true)
  })

  it('rail 空班次且互备也空 → 明确 backup EMPTY，不静默空结果', async () => {
    const planId = await makePlan()
    const rail = new Rail12306Adapter({
      mcp: fakeMcp({ 'query-tickets': { success: true, trains: [] } }),
    })
    let fallbackCalls = 0
    const emptyWendao: WendaoLike = {
      name: 'wendao',
      async available() { return true },
      async query() {
        fallbackCalls += 1
        return { entries: [], raw: '', degraded: [] }
      },
    }
    const intercity = new IntercityAdapter({ wendao: emptyWendao })
    const result = await runResearchTransport(
      { planId, modes: ['rail'] }, store,
      { rail, intercity, env: RAIL_ENV_KEY },
    )
    expect(fallbackCalls).toBe(1)
    expect(result.options).toEqual([])
    expect(result.degraded.some((d) => d.source === 'rail12306/backup' && d.code === 'EMPTY' && d.reason.includes('互备'))).toBe(true)
  })

  it('rail 空班次且互备抛错 → 明确 backup UNAVAILABLE，不静默空结果', async () => {
    const planId = await makePlan()
    const rail = new Rail12306Adapter({
      mcp: fakeMcp({ 'query-tickets': { success: true, trains: [] } }),
    })
    let fallbackCalls = 0
    const intercity = new IntercityAdapter({})
    intercity.searchTrains = async () => {
      fallbackCalls += 1
      throw new Error('backup down')
    }
    const result = await runResearchTransport(
      { planId, modes: ['rail'] }, store,
      { rail, intercity, env: RAIL_ENV_KEY },
    )
    expect(fallbackCalls).toBe(1)
    expect(result.options).toEqual([])
    expect(result.degraded.some((d) => d.source === 'rail12306/backup' && d.code === 'UNAVAILABLE' && d.reason.includes('backup down'))).toBe(true)
  })

  it('rail 不可达 → degraded rail12306 + wendao 火车咨询降级链（§9.3-3）', async () => {
    const planId = await makePlan()
    // MCP fetch 抛错（不可达）→ available()=false
    const rail = new Rail12306Adapter({
      mcp: new McpStreamClient({
        url: 'http://127.0.0.1:8123/mcp',
        fetchFn: async () => { throw new Error('ECONNREFUSED') },
      }),
    })
    // wendao 火车咨询 fixture（G 字头班次）
    const trainsMd = `# 火车票查询结果\n\n## 北京 → 上海 2026-09-04\n\n1. 高铁 G3 北京南 07:00 → 上海虹桥 11:35，二等座 ¥553 起\n   [查看](https://m.ctrip.com/webapp/train?no=G3)\n2. 高铁 G11 08:00 → 12:55，二等座 ¥662 起\n   [查看](https://m.ctrip.com/webapp/train?no=G11)\n`
    const intercity = new IntercityAdapter({ wendao: wendaoStub(trainsMd) })
    const result = await runResearchTransport(
      { planId, modes: ['rail'] }, store,
      { rail, intercity, env: RAIL_ENV_KEY },
    )
    expect(result.degraded.some((d) => d.source === 'rail12306' && d.code === 'UNAVAILABLE')).toBe(true)
    const wendaoOpts = result.options.filter((o) => o.mode === 'rail')
    expect(wendaoOpts.length).toBeGreaterThanOrEqual(1)
    expect(wendaoOpts[0].bookingTips?.some((t) => t.includes('12306'))).toBe(true)
    const persisted = await store.readJson<TransportOption[]>(planId, 'transport.json')
    expect(persisted).toBeDefined()
  })
})

describe('flight / bus', () => {
  it('flight：wendao 降级链 → ≥1 航班方案（航班号/时刻/价格档）', async () => {
    const planId = await makePlan()
    const tail = railFixtureDeps()
    tail.intercity = new IntercityAdapter({ wendao: wendaoStub(fixText('wendao/query-flights.md')) })
    const result = await runResearchTransport({ planId, modes: ['flight'] }, store, tail)
    const flights = result.options.filter((o) => o.mode === 'flight')
    expect(flights.length).toBeGreaterThanOrEqual(1)
    expect(flights[0].segments[0].no).toMatch(/^[A-Z]{2}\d{3,4}$/)
    expect(flights[0].segments[0].depart).toBeDefined()
    expect(flights[0].totalPriceRange).toBeDefined()
  })

  it('bus：wendao 咨询级（P1）→ ≥1 汽车方案', async () => {
    const planId = await makePlan()
    const tail = railFixtureDeps()
    tail.intercity = new IntercityAdapter({ wendao: wendaoStub(fixText('wendao/query-buses.md')) })
    const result = await runResearchTransport({ planId, modes: ['bus'] }, store, tail)
    expect(result.options.some((o) => o.mode === 'bus')).toBe(true)
    expect(result.options[0].tags?.some((t) => t.includes('咨询级'))).toBe(true)
  })
})

describe('市内衔接（高德 transit 单方案路径；未注入 didi 渠道）', () => {
  it('rail 到达站 → 目的地城市：cityTransfer{provider:amap, options[]} + 挂推荐方案', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, railFixtureDeps())
    expect(result.cityTransfer).toBeDefined()
    expect(result.cityTransfer!.provider).toBe('amap')
    expect(result.cityTransfer!.from).toBe('上海虹桥') // 首条 rail 方案到达站
    expect(result.cityTransfer!.to).toBe('上海')
    expect(result.cityTransfer!.options.length).toBeGreaterThanOrEqual(1)
    expect(result.cityTransfer!.source.platform).toBe('amap')
    // 推荐方案挂载 cityTransfer
    expect(result.options[0].cityTransfer).toBeDefined()
    expect(result.options[0].cityTransfer!.provider).toBe('amap')
  })

  it('到达站名不含「站」且首次地理编码失败 → 追加「站」重试成功（消歧回退）', async () => {
    const planId = await makePlan()
    const fixtureTransit = fixture('amap/transit.json') as { response: Record<string, unknown> }
    const geocodeFixture = fixture('amap/geocode.json') as { response: Record<string, unknown> }
    const amap = new AmapAdapter({
      fetchFn: async (url: string) => {
        // 首次（address=上海虹桥，无「站」）→ 抛地理编码错误；重试（上海虹桥站）→ 成功
        // 首次地址（上海虹桥，无「站」）→ 高德 geocode 抛数据错误；带「站」重试成功
        // 仅源地（address=上海虹桥=URL 编码 %E4%B8%8A%E6%B5%B7%E8%99%B9%E6%A1%A5）无「站」时抛错
        if (url.includes('geocode/geo') && url.includes('%E4%B8%8A%E6%B5%B7%E8%99%B9%E6%A1%A5') && !url.includes('%E7%AB%99')) {
          throw new Error('ENGINE_RESPONSE_DATA_ERROR')
        }
        if (url.includes('direction/transit/integrated')) {
          return { ok: true, status: 200, text: async () => JSON.stringify(fixtureTransit.response) }
        }
        if (url.includes('geocode/geo')) {
          return { ok: true, status: 200, text: async () => JSON.stringify(geocodeFixture.response) }
        }
        throw new Error(`no fixture ${url}`)
      },
    })
    const deps = railFixtureDeps()
    deps.amap = amap
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, deps)
    expect(result.cityTransfer).toBeDefined()
    expect(result.cityTransfer!.from).toBe('上海虹桥站') // 消歧后到达站
  })

  it('cityAmap 渠道开关关闭 → degraded「已停用（用户配置）」+ 无 cityTransfer', async () => {
    const planId = await makePlan()
    const deps = railFixtureDeps()
    deps.env = {
      readSettings: (key) => (key === 'channels.cityAmap' ? 'false' : undefined),
      env: {},
    }
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, deps)
    expect(result.cityTransfer).toBeUndefined()
    expect(result.degraded.some((d) => d.source === 'cityAmap' && d.reason.includes('已停用'))).toBe(true)
  })

  it('高德无 key（rest 抛 Key 未配置）→ degraded + 无 cityTransfer，rail 不阻塞', async () => {
    const planId = await makePlan()
    const tail = railFixtureDeps()
    tail.amap = new AmapAdapter({ fetchFn: async () => { throw new Error('Key 未配置') } })
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, tail)
    expect(result.cityTransfer).toBeUndefined()
    expect(result.degraded.some((d) => d.source === 'cityAmap' && d.code === 'UNAVAILABLE')).toBe(true)
    expect(result.options.length).toBeGreaterThanOrEqual(2) // rail 照常
  })
})

describe('≥2 方案对比（FR-4 详 2 四维度）', () => {
  it('rail+flight 并存 → comparison 含时间/价格/舒适度/带娃老人适配', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId }, store, railFixtureDeps())
    expect(result.comparison).toBeDefined()
    const c = result.comparison!
    expect(c.time).toContain('最快')
    expect(c.price).toContain('最省')
    expect(c.comfort).toContain('高铁')
    expect(c.suitability).toContain('高铁') // 老人同行画像 → 高铁舱内平稳
  })

  it('单方案不产出 comparison', async () => {
    const planId = await makePlan()
    const tail = railFixtureDeps()
    tail.intercity = new IntercityAdapter({ wendao: undefined, search: undefined })
    const result = await runResearchTransport({ planId, modes: ['flight'] }, store, tail)
    // flight 无可用源 → 0 方案 → 无比较（全失败也须不抛裸异常）
    expect(result.comparison).toBeUndefined()
  })
})

describe('参数/状态/契约边界', () => {
  it('计划不存在 → TravelValidationError', async () => {
    const deps = railFixtureDeps()
    await expect(runResearchTransport({ planId: 'plan-nope' }, store, deps)).rejects.toThrow(TravelValidationError)
  })

  it('缺 origin/destination/dateStart → TravelValidationError', async () => {
    const planId = await runIntake({ slots: { destination: '上海', dateStart: '2026-09-04', dateEnd: '2026-09-06', days: 3 } }, store)
    const deps = railFixtureDeps()
    // plan 模式缺 origin → confirmed 无法成立？intake 校验允许缺失但状态 collecting
    await expect(runResearchTransport({ planId: planId.planId }, store, deps)).rejects.toThrow(/origin|destination/)
  })

  it('非法 modes 枚举 → TravelValidationError', async () => {
    const planId = await makePlan()
    const deps = railFixtureDeps()
    await expect(
      runResearchTransport({ planId, modes: ['ship' as never] }, store, deps),
    ).rejects.toThrow(/modes 含非法模式/)
  })

  it('全链路失败 → 不产空 transport.json + degraded 明确报告', async () => {
    const planId = await makePlan()
    const rail = new Rail12306Adapter({
      mcp: new McpStreamClient({ url: 'http://127.0.0.1:8123/mcp', fetchFn: async () => { throw new Error('ECONNREFUSED') } }),
    })
    // 无 wendao/intercity（intercity 内部 wendao 缺省 new WendaoAdapter 无 key → 休眠）
    const result = await runResearchTransport(
      { planId }, store,
      { rail, intercity: new IntercityAdapter({ wendao: undefined, search: undefined }) },
    )
    expect(result.options.length).toBe(0)
    expect(result.degraded.length).toBeGreaterThanOrEqual(1)
    expect(await store.readJson<unknown>(planId, 'transport.json')).toBeUndefined()
  })

  it('工具定义可构建 + 默认超时 120s + 状态推进 self 幂等', async () => {
    const planId = await makePlan()
    const tool = createTravelResearchTransportTool(store, railFixtureDeps())
    expect(tool.name).toBe('travel_research_transport')
    expect(tool.timeoutMs).toBe(TRANSPORT_TIMEOUT_MS)
    await runResearchTransport({ planId }, store, railFixtureDeps())
    const again = await runResearchTransport({ planId }, store, railFixtureDeps()) // researching self
    expect(again.options.length).toBeGreaterThanOrEqual(2)
  })
})