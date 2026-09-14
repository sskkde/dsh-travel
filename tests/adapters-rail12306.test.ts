/**
 * rail12306 适配器单测：只读白名单红线 + 归一化 + 离线 golden（真实录制 fixture）。
 * fixture = 2026-09-02 真实录制（MCP HTTP 8123 → kyfw.12306.cn），见
 * tests/fixtures/rail12306/。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  Rail12306Adapter, McpStreamClient, READ_ONLY_TOOLS, assertReadOnly,
  durationToMinutes, isReadOnlyTool, normalizePrices, normalizeTrain, seatTags,
  type FetchLike,
} from '../src/adapters/rail12306.js'
import { EngineError } from '../src/adapters/base.js'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rail12306')
function fixtureResult(name: string): unknown {
  const f = JSON.parse(readFileSync(path.join(FIX, name), 'utf8'))
  return f.result
}

describe('只读白名单红线（deploy.md §2.1）', () => {
  it('白名单工具全部放行，且无任何交易类方法', () => {
    expect(READ_ONLY_TOOLS.length).toBeGreaterThanOrEqual(7)
    for (const name of READ_ONLY_TOOLS) {
      expect(isReadOnlyTool(name)).toBe(true)
    }
    // 调用清单中无交易类方法（购票/抢票/候补/代付/支付/下单）
    const transactional = /buy|pay|order|booking|wait(ing)?|候补|购票|抢票|代付|支付|下单|预订/i
    expect(READ_ONLY_TOOLS.some((n) => transactional.test(n))).toBe(false)
  })

  it('交易类工具名被 assertReadOnly 拒绝（EngineError.UNAVAILABLE）', () => {
    for (const bad of ['buy-ticket', 'query-waiting-list', 'create-order', 'pay-order', 'submit-order']) {
      expect(() => assertReadOnly(bad)).toThrow(EngineError)
    }
  })

  it('互备源预留位声明（wendao/flyai，M2.3）', () => {
    const adapter = new Rail12306Adapter({ mcp: fakeMcp({}) })
    const backups = adapter.backupSources()
    expect(backups.some((s) => s.includes('wendao'))).toBe(true)
    expect(backups.some((s) => s.includes('flyai'))).toBe(true)
  })
})

describe('归一化（§5.1 项 3）', () => {
  it('时长 HH:MM → 分钟', () => {
    expect(durationToMinutes('05:56')).toBe(356)
    expect(durationToMinutes('0:30')).toBe(30)
    expect(durationToMinutes('bad')).toBeUndefined()
  })

  it('班次归一：车次/时刻/座席', () => {
    const t = normalizeTrain({
      train_no: 'G531', from_station: '北京南', to_station: '上海虹桥',
      start_time: '06:08', arrive_time: '12:04', duration: '05:56',
      seats: { business: '10', first_class: '有', second_class: '有', no_seat: '有' },
    })
    expect(t.trainNo).toBe('G531')
    expect(t.durationMinutes).toBe(356)
    expect(t.seats.second_class).toBe('有')
    expect(seatTags(t.seats).some((s) => s.startsWith('second_class'))).toBe(true)
  })

  it('价格对象 → 元区间 [min,max]（fen→元口径外：12306 价为元字符串）', () => {
    expect(normalizePrices({ '二等座': '795.0', '一等座': '1272.0', '商务座': '2782.0' })).toEqual([795, 2782])
    expect(normalizePrices(null)).toBeUndefined()
  })
})

describe('rail12306 golden（真实录制 fixture，离线）', () => {
  it('余票查询 → TransportOption[]（rail/时长分钟/座席标签/溯源）', async () => {
    const adapter = new Rail12306Adapter({ mcp: fakeMcp({ 'query-tickets': fixtureResult('query-tickets.json') }) })
    const { options, degraded } = await adapter.queryTrains({ from: '北京', to: '上海', date: '2026-09-04' })
    expect(degraded).toEqual([])
    expect(options.length).toBeGreaterThan(0)
    const g1 = options.find((o) => o.segments[0]?.no === 'G531')
    expect(g1).toBeDefined()
    expect(g1!.mode).toBe('rail')
    expect(g1!.durationMinutes).toBe(356)
    expect(g1!.segments[0]).toMatchObject({ from: '北京南', to: '上海虹桥', depart: '06:08', arrive: '12:04' })
    expect(g1!.source.platform).toBe('rail12306')
    expect(g1!.bookingTips?.some((t) => t.includes('12306'))).toBe(true)
  })

  it('票价查询 → 价格区间 + 各席别价（元）', async () => {
    const adapter = new Rail12306Adapter({ mcp: fakeMcp({ 'query-ticket-price': fixtureResult('query-ticket-price.json') }) })
    const { trains } = await adapter.queryTicketPrice({ from: '北京', to: '上海', date: '2026-09-04', trainCode: 'G531' })
    expect(trains[0]).toMatchObject({ trainCode: 'G531', priceRange: [795, 2782] })
    expect(trains[0].prices['二等座']).toBe(795)
  })

  it('车站搜索 / 服务器时间（timestamp 秒 → ISO8601）', async () => {
    const mcp = fakeMcp({
      'search-stations': fixtureResult('search-stations.json'),
      'get-current-time': fixtureResult('get-current-time.json'),
    })
    const adapter = new Rail12306Adapter({ mcp })
    const { stations } = await adapter.searchStations('杭州东')
    expect(stations[0]).toMatchObject({ name: '杭州东', code: 'HGH' })
    const time = await adapter.serverTime()
    expect(time.iso).toMatch(/^20\d\d-\d\d-\d\dT/)
    expect(Date.parse(time.iso)).toBeGreaterThan(0)
    expect(time.timezone).toBe('Asia/Shanghai')
  })

  it('MCP 不可达 → available() false（fan-out 跳过）；渠道关闭 → false', async () => {
    const dead = new Rail12306Adapter({
      mcp: new McpStreamClient({ fetchFn: async () => { throw new Error('ECONNREFUSED') } }),
    })
    await expect(dead.available()).resolves.toBe(false)
    const alive = new Rail12306Adapter({ mcp: fakeMcp({}) })
    await expect(alive.available()).resolves.toBe(true)
    await expect(alive.available({ env: { TRAVEL_CHANNEL_RAIL12306: 'off' } })).resolves.toBe(false)
  })

  it('query-tickets 成功但空班次 → 返回空 options 并明确 EMPTY（互备由工具层触发）', async () => {
    const adapter = new Rail12306Adapter({
      mcp: fakeMcp({ 'query-tickets': { success: true, trains: [] } }),
    })
    const result = await adapter.queryTrains({ from: '北京', to: '上海', date: '2026-09-04' })
    expect(result.options).toEqual([])
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'rail12306', code: 'EMPTY' })
    expect(result.degraded[0].reason).toContain('无班次')
  })

  it('查询异常 → degraded 记账并抛 EngineError', async () => {
    const mcp = fakeMcp({
      'query-tickets': { success: false, message: '网络异常' },
    })
    const adapter = new Rail12306Adapter({ mcp })
    await expect(adapter.queryTrains({ from: '北京', to: '上海', date: '2026-09-04' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

/** fake MCP：按工具名回放 fixture（真实握手流程由 McpStreamClient 执行）。 */
function fakeMcp(fixtures: Record<string, unknown>): McpStreamClient {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    if (body.method === 'initialize') {
      return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-12306', version: 'test' } } }, 'fake-session')
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/list') {
      return ok({ jsonrpc: '2.0', id: body.id, result: { tools: READ_ONLY_TOOLS.map((name) => ({ name, description: 'read-only', inputSchema: { type: 'object' } })) } })
    }
    if (body.method === 'tools/call') {
      const tool = body.params.name
      const result = fixtures[tool]
      if (result === undefined) return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'no fixture' }] } })
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } })
    }
    return ok({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } })
  }
  return new McpStreamClient({ url: 'http://127.0.0.1:8123/mcp', fetchFn })
}

function ok(body: unknown, sessionId?: string): ReturnType<FetchLike> {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: sessionId ? { get: (n: string) => (n.toLowerCase() === 'mcp-session-id' ? sessionId : null) } : undefined,
  } as unknown as ReturnType<FetchLike>
}

describe('McpStreamClient 会话生命周期（懒初始化 + close delete）', () => {
  it('未先 available/initialize 直调 callTool → 先 initialize 再 tools/call（自愈 400 根因）', async () => {
    const calls: string[] = []
    const fetchFn: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}')
      if (init?.method !== 'POST') return { ok: true, status: 200, text: async () => '' } as unknown as ReturnType<FetchLike>
      calls.push(body.method)
      if (body.method === 'initialize') return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, 's1')
      if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' } as unknown as ReturnType<FetchLike>
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"success":true}' }] } })
    }
    const client = new McpStreamClient({ url: 'http://x/mcp', fetchFn })
    await client.callTool('query-tickets', { from_station: 'a', to_station: 'b', train_date: '2026-09-04' })
    expect(calls[0]).toBe('initialize')
    expect(calls[1]).toBe('notifications/initialized')
    expect(calls[2]).toBe('tools/call')
  })

  it('close() 发送 DELETE（带 Mcp-Session-Id）；重复/未初始化调用为空操作', async () => {
    const calls: Array<{ method?: string; sid?: string }> = []
    const fetchFn: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}')
      if (init?.method === 'DELETE') {
        calls.push({ method: init.method, sid: (init.headers ?? {})['Mcp-Session-Id'] })
        return { ok: true, status: 200, text: async () => '' } as unknown as ReturnType<FetchLike>
      }
      calls.push({ method: init?.method })
      if (body.method === 'initialize') return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, 'sess-close')
      if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' } as unknown as ReturnType<FetchLike>
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"success":true}' }] } })
    }
    const client = new McpStreamClient({ url: 'http://x/mcp', fetchFn })
    await client.close() // 未初始化：空操作
    await client.callTool('query-tickets', { from_station: 'a', to_station: 'b', train_date: '2026-09-04' })
    await client.close()
    await client.close() // 幂等
    expect(calls).toEqual([
      { method: 'POST' }, // callTool → initialize
      { method: 'POST' }, // notifications/initialized
      { method: 'POST' }, // tools/call
      { method: 'DELETE', sid: 'sess-close' },
    ])
  })

  it('Rail12306Adapter.close() 透传底层会话关闭', async () => {
    const deletes: string[] = []
    const fetchFn: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}')
      if (init?.method === 'DELETE') { deletes.push('del'); return { ok: true, status: 200, text: async () => '' } as unknown as ReturnType<FetchLike> }
      if (body.method === 'initialize') return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, 's2')
      if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' } as unknown as ReturnType<FetchLike>
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"success":true}' }] } })
    }
    const adapter = new Rail12306Adapter({ mcp: new McpStreamClient({ url: 'http://x/mcp', fetchFn }) })
    await adapter.available()
    await adapter.close()
    expect(deletes).toEqual(['del'])
  })
})

describe('M2 遗留修复：会话空闲超时统一策略（CLOSURE ⑧ / W7 notes §5）', () => {
  function idleFetch(events: string[], sessionId = 'idle-sess'): FetchLike {
    return async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}')
      if (init?.method === 'DELETE') {
        events.push('DELETE')
        return { ok: true, status: 200, text: async () => '' } as unknown as ReturnType<FetchLike>
      }
      events.push(String(init?.method ?? '?') + (body.method ? `:${body.method}` : ''))
      if (body.method === 'initialize') return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, sessionId)
      if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' } as unknown as ReturnType<FetchLike>
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"success":true}' }] } })
    }
  }

  const CALL_ARGS = { from_station: 'a', to_station: 'b', train_date: '2026-09-04' }

  it('空闲超时（idleTimeoutMs=0 立即过期）→ 自动 close() 释放会话，下次调用懒初始化重建', async () => {
    const events: string[] = []
    const client = new McpStreamClient({ url: 'http://x/mcp', fetchFn: idleFetch(events), idleTimeoutMs: 0 })
    await client.callTool('query-tickets', CALL_ARGS)
    await client.callTool('query-tickets', CALL_ARGS)
    expect(events).toEqual([
      'POST:initialize', 'POST:notifications/initialized', 'POST:tools/call',
      'DELETE', // 空闲超时自动收尾（释放服务端活跃会话）
      'POST:initialize', 'POST:notifications/initialized', 'POST:tools/call',
    ])
  })

  it('活跃期内会话复用：空闲未超时 → 不重复初始化、不 DELETE（现有 live 复用行为不被破坏）', async () => {
    const events: string[] = []
    const client = new McpStreamClient({ url: 'http://x/mcp', fetchFn: idleFetch(events), idleTimeoutMs: 10 * 60 * 1000 })
    await client.callTool('query-tickets', CALL_ARGS)
    await client.callTool('query-tickets', CALL_ARGS)
    await client.close() // 显式收尾仍可用（统一策略的主动侧）
    expect(events).toEqual([
      'POST:initialize', 'POST:notifications/initialized', 'POST:tools/call', 'POST:tools/call',
      'DELETE',
    ])
  })
})

// live smoke：TRAVEL_LIVE_SMOKE=1 才打网络（默认离线）；需本机 8123 MCP 存活
const liveEnabled = process.env.TRAVEL_LIVE_SMOKE === '1'
describe.skipIf(!liveEnabled)('rail12306 live smoke（真实 MCP，127.0.0.1:8123）', () => {
  it('真实余票查询返回班次，且 tools/list 全在白名单', async () => {
    const adapter = new Rail12306Adapter()
    expect(await adapter.available()).toBe(true)
    const tools = await adapter.mcp.listTools()
    for (const t of tools) {
      expect(READ_ONLY_TOOLS).toContain(t.name)
    }
    const date = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10)
    const { options } = await adapter.queryTrains({ from: '北京', to: '上海', date })
    expect(options.length).toBeGreaterThan(0)
  }, 45000)
})