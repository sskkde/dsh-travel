/**
 * didi 适配器单测（M2.4 W5）：
 * 查询白名单红线（只挂 maps_direction_transit/taxi_estimate，白名单外一律拒绝——
 * 断言白名单恒等于查询双件）、城市名补"市"、transit/taxi 归一化、
 * 前置地理编码链（地名→"lng,lat"，源失败降级）、Key 门控（未配→false）、
 * MCP 会话与白名单闸门（复用 rail12306 McpStreamClient + readOnlyGate 注入）、
 * queryTransfer 全链路（坐标直传/失败注入/空结果）、
 * cityTransfer 双方案聚合（research-transport 工具层：高德+滴滴合并、未配静默降级、
 * 滴滴失败高德单方案不阻塞、滴滴 only、双渠道失败、渠道开关）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DIDI_KEY_MISSING_REASON, DIDI_QUERY_TOOLS, DEFAULT_DIDI_MCP_URL,
  DidiAdapter, assertDidiQueryOnly, ensureFullCityName, isDidiKeyConfigured,
  isDidiQueryTool, parseTaxiEstimate, parseTransitOptions, parseTransitText,
} from '../src/adapters/didi.js'
import { EngineError, type DegradedEntry, type KeyResolutionEnv } from '../src/adapters/base.js'
import { AmapAdapter, type AmapTransitRoute } from '../src/adapters/amap.js'
import { McpStreamClient, Rail12306Adapter, type FetchLike, type TrainQuery } from '../src/adapters/rail12306.js'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchTransport, type ResearchTransportDeps } from '../src/tools/research-transport.js'
import type { CityTransferOption, GeoCoords, TransportOption } from '../src/models/types.js'

/** 假 MCP 服务端 result 形状（result 根可含 structuredContent / content[].text）。 */
interface FakeToolResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
}

/** 统一假 MCP（McpStreamClient + assertDidiQueryOnly 闸门，镜像适配器真实构造）：
 * fixtures[name] 作为 tools/call 的 result 直返；fail 集合内工具抛错。 */
function fakeMcp(fixtures: Record<string, FakeToolResult>, options: { fail?: string[]; sessionHeader?: string[]; url?: string } = {}): McpStreamClient {
  const fail = new Set(options.fail ?? [])
  const headersSeen = options.sessionHeader
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    if (headersSeen && init?.headers?.['Mcp-Session-Id']) headersSeen.push(init.headers['Mcp-Session-Id'])
    const okResp = (result: unknown, sessionId?: string) => {
      const headers = sessionId
        ? { 'mcp-session-id': sessionId, get: (name: string) => (name === 'mcp-session-id' ? sessionId : null) } as unknown
        : undefined
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
        ...(headers ? { headers } : {}),
      }
    }
    if (body.method === 'initialize') {
      return okResp({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-didi', version: 'test' } }, 'dd-session')
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/call') {
      const name = (body.params as Record<string, unknown>).name as string
      if (fail.has(name)) throw new Error(`${name} 服务不可达`)
      const result = fixtures[name]
      if (result === undefined) return okResp({ content: [{ type: 'text', text: 'no fixture' }] })
      return okResp(result)
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601 } }) }
  }
  return new McpStreamClient({ url: options.url ?? 'http://127.0.0.1:8124/mcp', fetchFn, readOnlyGate: assertDidiQueryOnly })
}

/** 结构化 transit result。 */
const TRANSIT_FIXTURE: FakeToolResult = {
  structuredContent: {
    routes: [
      { scheme: '地铁 1号线 → 公交 100路', duration: 45, price: 3 },
      { scheme: '地铁 1号线 → 地铁 2号线', duration: 50, price: 4 },
    ],
  },
}

/** 结构化估价 result。 */
const ESTIMATE_FIXTURE: FakeToolResult = { structuredContent: { price: 35.5, duration: 32 } }

describe('查询白名单红线（design §3.5：只挂查询类，交易四件零挂载零出现）', () => {
  it('白名单恒等于查询双件（长度 2，精确集合）', () => {
    expect(DIDI_QUERY_TOOLS).toEqual(['maps_direction_transit', 'taxi_estimate'])
  })

  it('白名单内工具放行；白名单外任意工具（含未挂载查询类/未知）一律拒绝', () => {
    expect(isDidiQueryTool('maps_direction_transit')).toBe(true)
    expect(isDidiQueryTool('taxi_estimate')).toBe(true)
    expect(isDidiQueryTool('maps_direction_driving')).toBe(false)
    expect(isDidiQueryTool('maps_place_around')).toBe(false)
    expect(isDidiQueryTool('unknown_tool')).toBe(false)
    expect(isDidiQueryTool('')).toBe(false)
  })

  it('assertDidiQueryOnly：白名单外调用前强制闸门（EngineError UNAVAILABLE）', () => {
    expect(() => assertDidiQueryOnly('maps_direction_transit')).not.toThrow()
    expect(() => assertDidiQueryOnly('taxi_estimate')).not.toThrow()
    for (const name of ['maps_direction_driving', 'maps_textsearch', 'some_write_like_tool', '']) {
      try {
        assertDidiQueryOnly(name)
        expect.unreachable(`应拒绝 ${name}`)
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError)
        expect((err as EngineError).code).toBe('UNAVAILABLE')
        expect((err as EngineError).message).toContain('不在查询白名单')
      }
    }
  })

  it('白名单无交易语义关键字（create/order/cancel/driver/location 零命中）', () => {
    for (const kw of ['create', 'order', 'cancel', 'driver', 'location']) {
      expect(DIDI_QUERY_TOOLS.filter((t) => t.includes(kw))).toEqual([])
    }
  })

  it('红线即闸门：McpStreamClient 注入 assertDidiQueryOnly，白名单外在进网络前拒绝（零 HTTP）', async () => {
    let httpCalls = 0
    const fetchFn: FetchLike = async () => {
      httpCalls += 1
      throw new Error('不应触网')
    }
    const mcp = new McpStreamClient({ url: DEFAULT_DIDI_MCP_URL, fetchFn, readOnlyGate: assertDidiQueryOnly })
    await expect(mcp.callToolRaw('maps_direction_driving', {})).rejects.toThrow(/不在查询白名单/)
    await expect(mcp.callToolRaw('create_order', {})).rejects.toThrow(/不在查询白名单/)
    expect(httpCalls).toBe(0)
  })
})

describe('城市名补"市"（transit 需完整城市名"杭州市"，design §5.1）', () => {
  it('无行政区后缀 → 补"市"；已含后缀 → 原样；"州"结尾仍需补（杭州/广州）', () => {
    expect(ensureFullCityName('杭州')).toBe('杭州市')
    expect(ensureFullCityName('北京')).toBe('北京市')
    expect(ensureFullCityName('重庆')).toBe('重庆市')
    expect(ensureFullCityName('广州')).toBe('广州市')
    expect(ensureFullCityName('杭州市')).toBe('杭州市')
    expect(ensureFullCityName('北京市')).toBe('北京市')
    expect(ensureFullCityName('内蒙古自治区')).toBe('内蒙古自治区')
    expect(ensureFullCityName('')).toBe('')
  })
})

describe('transit 响应归一化（结构化优先 / 自然语言兜底）', () => {
  it('structuredContent.routes → 选项（时长分钟/价格 hint）', () => {
    const options = parseTransitOptions({
      structuredContent: {
        routes: [
          { scheme: '地铁 1号线 → 公交 100路', duration: 45, price: 3 },
          { scheme: '地铁 1号线 → 地铁 2号线', duration: 50, price: 4 },
          { scheme: '步行直达', duration: 20 }, // 无价格 → priceHint 省略
        ],
      },
    })
    expect(options).toHaveLength(3)
    expect(options[0]).toEqual({ mode: '地铁 1号线 → 公交 100路', durationMinutes: 45, priceHint: '3 元' })
    expect(options[1]).toEqual({ mode: '地铁 1号线 → 地铁 2号线', durationMinutes: 50, priceHint: '4 元' })
    expect(options[2]).toEqual({ mode: '步行直达', durationMinutes: 20, priceHint: undefined })
  })

  it('callToolRaw 全 payload 形态（content 与 structuredContent 并存）', () => {
    const options = parseTransitOptions({
      content: [{ type: 'text', text: '（原文略）' }],
      structuredContent: { routes: [{ scheme: '公交 519 路', duration: 60, price: 2 }] },
    })
    expect(options).toEqual([{ mode: '公交 519 路', durationMinutes: 60, priceHint: '2 元' }])
  })

  it('routes 平铺形态（text JSON 已解析）', () => {
    const options = parseTransitOptions({ routes: [{ mode: '公交 519 路', duration: 60, price: 2 }] })
    expect(options).toEqual([{ mode: '公交 519 路', durationMinutes: 60, priceHint: '2 元' }])
  })

  it('自然语言 text 兜底（N 分钟 / N 元 提取，方案行保留）', () => {
    const options = parseTransitOptions({
      text: '方案1：地铁 1号线 → 公交 100路，预计 45 分钟，票价 3 元\n方案2：公交 100路直达，60分钟，2元',
    })
    expect(options).toHaveLength(2)
    expect(options[0].mode).toEqual('方案1：地铁 1号线 → 公交 100路')
    expect(options[0].durationMinutes).toBe(45)
    expect(options[0].priceHint).toBe('3 元')
    expect(options[1].mode).toEqual('方案2：公交 100路直达')
    expect(options[1].durationMinutes).toBe(60)
  })

  it('parseTransitText 行级提取；纯信息行/空行跳过', () => {
    const options = parseTransitText('地铁 1号线 45分钟 3元\n起点：西湖\n\n终点：杭州东站\n耗时约 60 分钟\n')
    expect(options).toHaveLength(1)
    expect(options[0]).toEqual({ mode: '地铁 1号线', durationMinutes: 45, priceHint: '3 元' })
  })

  it('无数据 → 空数组（不抛）', () => {
    expect(parseTransitOptions(null)).toEqual([])
    expect(parseTransitOptions(undefined)).toEqual([])
    expect(parseTransitOptions({})).toEqual([])
    expect(parseTransitOptions({ text: '起点 西湖' })).toEqual([])
  })
})

describe('taxi_estimate 估价参考归一化（§2.1：估价不可用省略字段）', () => {
  it('结构化 price/duration → 出租车估价选项', () => {
    expect(parseTaxiEstimate({ price: 35.5, duration: 32 }))
      .toEqual({ mode: '出租车（滴滴估价）', durationMinutes: 32, priceHint: '约 35.5 元' })
  })

  it('structuredContent 嵌套形态', () => {
    const est = parseTaxiEstimate({ structuredContent: { price: 26, durationMinutes: 28 } })
    expect(est?.priceHint).toBe('约 26 元')
    expect(est?.durationMinutes).toBe(28)
  })

  it('自然语言 text 兜底', () => {
    const est = parseTaxiEstimate({ text: '预估费用约 40 元，预计 30 分钟' })
    expect(est?.priceHint).toBe('约 40 元')
    expect(est?.durationMinutes).toBe(30)
  })

  it('价格/时长都无 → undefined（省略估价字段）', () => {
    expect(parseTaxiEstimate(null)).toBeUndefined()
    expect(parseTaxiEstimate({})).toBeUndefined()
    expect(parseTaxiEstimate({ text: '暂无数据' })).toBeUndefined()
  })
})

describe('Key 门控（DIDI_MCP_KEY；resolveKey 链 settings→credentials→env）', () => {
  it('env DIDI_MCP_KEY 直配 → configured', async () => {
    expect(await isDidiKeyConfigured({ env: { DIDI_MCP_KEY: 'k' } })).toBe(true)
    expect(await isDidiKeyConfigured({ env: { DIDI_MCP_KEY: '  ' } })).toBe(false)
  })

  it('credentials 层（ref DIDI_MCPKEY，合法标识符无斜杠）→ configured', async () => {
    const env = {
      resolveCredential: async (id: string) => (id === 'didi' ? 'cred-key' : undefined),
      env: {} as Record<string, string | undefined>,
    }
    expect(await isDidiKeyConfigured(env)).toBe(true)
  })

  it('全链未配置 → false', async () => {
    expect(await isDidiKeyConfigured({ env: {} })).toBe(false)
    expect(await isDidiKeyConfigured()).toBe(false)
  })

  it('available()：渠道开关 + key 双门', async () => {
    const adapter = new DidiAdapter()
    expect(await adapter.available({ env: {} })).toBe(false) // 未配
    expect(await adapter.available({ env: { DIDI_MCP_KEY: 'k' } })).toBe(true)
    expect(await adapter.available({
      readSettings: (key) => (key === 'channels.cityDidi' ? 'false' : undefined),
      env: { DIDI_MCP_KEY: 'k' },
    })).toBe(false) // 渠道停用
  })
})

describe('MCP 客户端（McpStreamClient 复用：会话 + 白名单闸门 + payload 面）', () => {
  it('callToolRaw：structuredContent 随全 payload 返回（适配器解析面）', async () => {
    const mcp = fakeMcp({ maps_direction_transit: TRANSIT_FIXTURE })
    const payload = await mcp.callToolRaw('maps_direction_transit', { origin: '120.1,30.2', destination: '120.2,30.3', city: '杭州市' })
    expect(payload.structuredContent).toEqual(TRANSIT_FIXTURE.structuredContent)
  })

  it('text JSON 面：content[].text JSON 自动解析（rail12306 callTool 同款语义）', async () => {
    const adapter = new DidiAdapter({
      mcp: fakeMcp({
        maps_direction_transit: { structuredContent: { routes: [{ scheme: '地铁 2号线', duration: 25, price: 4 }] } },
        taxi_estimate: { content: [{ type: 'text', text: '{"price": 32, "duration": 30}' }] },
      }),
    })
    const { options } = await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(options).toContainEqual({ mode: '出租车（滴滴估价）', durationMinutes: 30, priceHint: '约 32 元' })
    expect(options).toContainEqual({ mode: '滴滴·地铁 2号线', durationMinutes: 25, priceHint: '4 元' })
  })

  it('callToolRaw：白名单外工具在进网络前被闸门拒绝', async () => {
    const mcp = fakeMcp({})
    await expect(mcp.callToolRaw('maps_direction_driving', {})).rejects.toThrow(/不在查询白名单/)
  })

  it('会话：懒初始化 + Mcp-Session-Id 复用 + close 幂等', async () => {
    const sessionHeader: string[] = []
    const mcp = fakeMcp({ taxi_estimate: { structuredContent: { price: 20, duration: 18 } } }, { sessionHeader })
    await mcp.callToolRaw('taxi_estimate', {})
    await mcp.callToolRaw('taxi_estimate', {})
    // initialized 通知 + 2 次 tools/call 均携带会话头
    expect(sessionHeader.length).toBe(3)
    expect(sessionHeader.slice(0, 3).every((s) => s === 'dd-session')).toBe(true)
    await mcp.close()
    await mcp.close()
  })
})

describe('前置地理编码链（地名→"lng,lat"；源失败降级）', () => {
  const coordSrc = (name: string, coords: GeoCoords) => ({
    name,
    async geocode() { return { coords, degraded: [] } },
  })
  const failSrc = (name: string) => ({
    name,
    async geocode(): Promise<{ coords?: GeoCoords; degraded: DegradedEntry[] }> { throw new Error(`${name} 服务不可用`) },
  })
  const emptySrc = (name: string) => ({
    name,
    async geocode() { return { coords: undefined as GeoCoords | undefined, degraded: [] } },
  })

  const OK_FIXTURES: Record<string, FakeToolResult> = {
    maps_direction_transit: TRANSIT_FIXTURE,
    taxi_estimate: ESTIMATE_FIXTURE,
  }

  it('链式降级：源 1 失败 → 源 2 成功取坐标；degraded 记源 1 失败', async () => {
    const adapter = new DidiAdapter({
      mcp: fakeMcp(OK_FIXTURES),
      geocoders: [failSrc('amap'), coordSrc('tencent-map', { lng: 121.4737, lat: 31.2304, sys: 'GCJ02' })],
    })
    const { options, degraded } = await adapter.queryTransfer('杭州东站', '西湖', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(degraded.some((d) => d.source === 'amap' && d.code === 'UNAVAILABLE')).toBe(true)
    expect(options.filter((o) => o.mode.startsWith('滴滴·')).length).toBeGreaterThanOrEqual(1)
  })

  it('链全失败 → EngineError + degraded 记账（源失败 + 链终 EMPTY）', async () => {
    const adapter = new DidiAdapter({
      mcp: fakeMcp(OK_FIXTURES),
      geocoders: [failSrc('amap'), emptySrc('tencent-map')],
    })
    try {
      await adapter.queryTransfer('不存在的地址xyz', '西湖', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
      expect.unreachable('应抛 EngineError')
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).message).toContain('前置地理编码失败')
    }
  })

  it('坐标串直传：geocoders 零调用（坐标不经地理编码）', async () => {
    let called = 0
    const adapter = new DidiAdapter({
      mcp: fakeMcp(OK_FIXTURES),
      geocoders: [{ name: 'amap', async geocode() { called += 1; return { coords: undefined, degraded: [] } } }],
    })
    const { options } = await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(called).toBe(0)
    expect(options.length).toBeGreaterThanOrEqual(2) // transit + 出租车估价
  })

  it('城市名补"市"贯通：transit 入参 city=完整名"上海市"（模型侧仍传"上海"）', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchFn: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { method: string; params?: { name: string; arguments?: Record<string, unknown> } }
      if (body.method === 'initialize') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } }) }
      }
      if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' }
      if (body.method === 'tools/call' && body.params?.name === 'maps_direction_transit') {
        seen.push(body.params.arguments ?? {})
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { structuredContent: { routes: [{ scheme: '地铁 2号线', duration: 25, price: 4 }] } } }),
        }
      }
      throw new Error(`unexpected ${body.method}`)
    }
    const adapter = new DidiAdapter({ mcp: new McpStreamClient({ url: DEFAULT_DIDI_MCP_URL, fetchFn, readOnlyGate: assertDidiQueryOnly }) })
    const { options } = await adapter.queryTransfer('120.1,30.2', '120.15,30.25', '上海', { env: { DIDI_MCP_KEY: 'k' } })
    expect(seen[0].city).toBe('上海市')
    expect(options.map((o) => o.mode)).toEqual(['滴滴·地铁 2号线'])
  })
})

describe('queryTransfer 全链路', () => {
  it('happy：transit 公共交通选项（滴滴·前缀）+ taxi_estimate 估价参考', async () => {
    const adapter = new DidiAdapter({ mcp: fakeMcp({ maps_direction_transit: TRANSIT_FIXTURE, taxi_estimate: ESTIMATE_FIXTURE }) })
    const { options, degraded } = await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(degraded).toHaveLength(0)
    expect(options.map((o) => o.mode)).toEqual([
      '滴滴·地铁 1号线 → 公交 100路',
      '滴滴·地铁 1号线 → 地铁 2号线',
      '出租车（滴滴估价）',
    ])
    expect(options[0].durationMinutes).toBe(45)
    expect(options[0].priceHint).toBe('3 元')
    expect(options[2].priceHint).toBe('约 35.5 元')
    expect(options[2].durationMinutes).toBe(32)
  })

  it('估价失败（估价不可用省略字段，不阻塞）→ 仅公共交通选项 + degraded 记账', async () => {
    const adapter = new DidiAdapter({
      mcp: fakeMcp({ maps_direction_transit: TRANSIT_FIXTURE }, { fail: ['taxi_estimate'] }),
    })
    const { options, degraded } = await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(options).toHaveLength(2)
    expect(degraded.some((d) => d.source === 'didi' && d.code === 'UNAVAILABLE')).toBe(true)
  })

  it('transit 失败 = 渠道失败（抛 EngineError；工具层回退高德单方案）', async () => {
    const mcp = new McpStreamClient({
      url: DEFAULT_DIDI_MCP_URL,
      fetchFn: async () => { throw new Error('ECONNREFUSED') },
      readOnlyGate: assertDidiQueryOnly,
    })
    const adapter = new DidiAdapter({ mcp })
    try {
      await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'fake-key' } })
      expect.unreachable('应抛 EngineError')
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).code).toBe('UNAVAILABLE')
    }
  })

  it('Key 未配直调 → EngineError（渠道未配即跳过，工具层先查 available）', async () => {
    const adapter = new DidiAdapter({ mcp: fakeMcp({ maps_direction_transit: TRANSIT_FIXTURE, taxi_estimate: ESTIMATE_FIXTURE }) })
    await expect(adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: {} }))
      .rejects.toThrow(DIDI_KEY_MISSING_REASON)
  })

  it('transit 空 + 估价可用 → 仅出租车估价参考位', async () => {
    const adapter = new DidiAdapter({
      mcp: fakeMcp({ maps_direction_transit: { structuredContent: { routes: [] } }, taxi_estimate: ESTIMATE_FIXTURE }),
    })
    const { options } = await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(options).toHaveLength(1)
    expect(options[0].mode).toBe('出租车（滴滴估价）')
  })

  it('transit 空 + 估价不可用 → 空选项 + EMPTY 记账（不抛，工具层走高德单方案）', async () => {
    const adapter = new DidiAdapter({
      mcp: fakeMcp({ maps_direction_transit: { structuredContent: { routes: [] } } }, { fail: ['taxi_estimate'] }),
    })
    const { options, degraded } = await adapter.queryTransfer('120.1,30.2', '120.2,30.3', '杭州市', { env: { DIDI_MCP_KEY: 'k' } })
    expect(options).toHaveLength(0)
    expect(degraded.some((d) => d.code === 'EMPTY' && d.reason.includes('无市内公共交通方案'))).toBe(true)
  })
})

// ────────────────────────── cityTransfer 双方案聚合（research-transport 工具层） ──────────────────────────

/** amap 测试桩：不触网；up=false 模拟 Key 未配置门。 */
class FakeAmap extends AmapAdapter {
  private readonly up: boolean
  private readonly options: CityTransferOption[]

  constructor(opts: { up?: boolean; options?: CityTransferOption[] } = {}) {
    super({ fetchFn: async () => { throw new Error('离线测试桩不应触网') } })
    this.up = opts.up ?? true
    this.options = opts.options ?? [
      { mode: '地铁 1号线', durationMinutes: 30, priceHint: '3 元' },
      { mode: '公交 100路', durationMinutes: 50, priceHint: '2 元' },
    ]
  }

  override async available(_env?: KeyResolutionEnv): Promise<boolean> {
    return this.up
  }

  override async directionTransit(): Promise<{ routes: AmapTransitRoute[]; options: CityTransferOption[]; degraded: DegradedEntry[] }> {
    return { routes: [], options: this.options, degraded: [] }
  }
}

/** rail 测试桩：固定一班 G815 北京南→上海虹桥（市内衔接接入其到达站）。 */
class FakeRail extends Rail12306Adapter {
  override async available(_env?: KeyResolutionEnv): Promise<boolean> {
    return true
  }

  override async queryTrains(_query: TrainQuery, _env?: KeyResolutionEnv): Promise<{ options: TransportOption[]; degraded: DegradedEntry[] }> {
    return {
      options: [{
        mode: 'rail',
        segments: [{ from: '北京南', to: '上海虹桥', no: 'G815', depart: '08:00', arrive: '09:32' }],
        durationMinutes: 92,
        tags: ['二等座：有'],
        bookingTips: ['班次/余票以 12306 官方为准'],
        source: { platform: 'rail12306', url: 'fake://rail12306', fetchedAt: new Date().toISOString() },
      }],
      degraded: [],
    }
  }

  override async queryTicketPrice(_params: TrainQuery & { trainCode?: string }, _env?: KeyResolutionEnv): Promise<{ trains: Array<{ trainCode: string; priceRange?: [number, number]; prices: Record<string, number> }>; degraded: DegradedEntry[] }> {
    return { trains: [{ trainCode: 'G815', priceRange: [553, 1876], prices: { 二等座: 553 } }], degraded: [] }
  }
}

/** 聚合用 didi 桩：geocoder 链恒成功（地名→坐标），MCP 走 fakeMcp。 */
function didiForAggregation(opts: { fixtures?: Record<string, FakeToolResult>; fail?: string[]; unreachable?: boolean } = {}): DidiAdapter {
  const mcp = opts.unreachable
    ? new McpStreamClient({
        url: 'http://127.0.0.1:9/mcp',
        fetchFn: async () => { throw new Error('ECONNREFUSED 127.0.0.1:9（失败注入）') },
        readOnlyGate: assertDidiQueryOnly,
        timeoutMs: 2000,
      })
    : fakeMcp(opts.fixtures ?? { maps_direction_transit: TRANSIT_FIXTURE, taxi_estimate: ESTIMATE_FIXTURE }, { fail: opts.fail })
  return new DidiAdapter({
    mcp,
    geocoders: [{
      name: 'stub-geocode',
      async geocode(_address: string) {
        return { coords: { lng: 121.4737, lat: 31.2304, sys: 'GCJ02' }, degraded: [] }
      },
    }],
  })
}

describe('cityTransfer 双方案聚合（research-transport 工具层；FR-4 市内衔接验收）', () => {
  let root: string
  let store: TravelStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-travel-didi-agg-'))
    store = new TravelStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const KEYED_ENV: KeyResolutionEnv = { env: { DIDI_MCP_KEY: 'k' } }

  async function makePlan(): Promise<string> {
    const start = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const end = new Date(Date.now() + 12 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const result = await runIntake({
      slots: {
        origin: '北京',
        destination: '上海',
        dateStart: start,
        dateEnd: end,
        days: 3,
        travelers: { adults: 2 },
      },
    }, store)
    // F1c-E（决策 5）：destination-only 新 plan 自动 flowVersion → 完整链受门；本测试
    // 验证 legacy 轻量单点市内衔接路径（SKILL §3 保留），模拟真正 legacy（无信封）。
    const req = await store.loadRequest(result.planId)
    await store.saveRequest({ ...req!, flowVersion: undefined })
    return result.planId
  }

  function depsWith(didi: DidiAdapter, opts: { amapUp?: boolean; env?: KeyResolutionEnv } = {}): ResearchTransportDeps {
    return {
      rail: new FakeRail(),
      amap: new FakeAmap({ up: opts.amapUp ?? true }),
      didi,
      env: opts.env ?? KEYED_ENV,
    }
  }

  it('双方案聚合：rail 到达站 → 高德 transit + 滴滴（滴滴·前缀+估价参考）→ provider amap', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, depsWith(didiForAggregation()))
    const ct = result.cityTransfer
    expect(ct).toBeDefined()
    expect(ct!.from).toBe('上海虹桥') // rail 到达站（高德消歧后的 fromLabel 同源）
    expect(ct!.to).toBe('上海')
    expect(ct!.provider).toBe('amap')
    expect(ct!.source.platform).toBe('amap')
    expect(ct!.options.map((o) => o.mode)).toEqual([
      '地铁 1号线',
      '公交 100路',
      '滴滴·地铁 1号线 → 公交 100路',
      '滴滴·地铁 1号线 → 地铁 2号线',
      '出租车（滴滴估价）',
    ])
    expect(ct!.options[0].durationMinutes).toBe(30)
    expect(ct!.options[2].durationMinutes).toBe(45)
    expect(ct!.options[4].priceHint).toBe('约 35.5 元')
    // 推荐方案挂载 cityTransfer
    expect(result.options[0].cityTransfer).toBeDefined()
    expect(result.options[0].cityTransfer!.options.length).toBe(5)
    expect(result.degraded.filter((d) => d.source === 'cityDidi' || d.source === 'cityAmap')).toEqual([])
  })

  it('未配态（DIDI_MCP_KEY 未配）→ 静默降级：cityDidi degraded「Key 未配置」+ 高德单方案不阻塞', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, depsWith(didiForAggregation(), { env: { env: {} } }))
    const ct = result.cityTransfer
    expect(ct).toBeDefined()
    expect(ct!.provider).toBe('amap')
    expect(ct!.options.map((o) => o.mode)).toEqual(['地铁 1号线', '公交 100路']) // 仅高德
    const entry = result.degraded.find((d) => d.source === 'cityDidi')
    expect(entry).toBeDefined()
    expect(entry!.code).toBe('UNAVAILABLE')
    expect(entry!.reason).toBe(DIDI_KEY_MISSING_REASON)
  })

  it('滴滴失败注入（假 key + 服务不可达）→ degraded 记账 + 高德单方案不阻塞', async () => {
    const planId = await makePlan()
    const env: KeyResolutionEnv = { env: { DIDI_MCP_KEY: 'fake-key' } }
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, depsWith(didiForAggregation({ unreachable: true }), { env }))
    const ct = result.cityTransfer
    expect(ct).toBeDefined()
    expect(ct!.provider).toBe('amap')
    expect(ct!.options.map((o) => o.mode)).toEqual(['地铁 1号线', '公交 100路'])
    const entry = result.degraded.find((d) => d.source === 'cityDidi')
    expect(entry).toBeDefined()
    expect(entry!.code).toBe('UNAVAILABLE')
    expect(entry!.reason).toContain('ECONNREFUSED')
  })

  it('滴滴 only（高德无 key）→ provider didi + source.platform didi + 滴滴·选项', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, depsWith(didiForAggregation(), { amapUp: false }))
    const ct = result.cityTransfer
    expect(ct).toBeDefined()
    expect(ct!.from).toBe('上海虹桥') // amap 消歧缺席 → 直用 rail 到达站
    expect(ct!.provider).toBe('didi')
    expect(ct!.source.platform).toBe('didi')
    expect(ct!.options.map((o) => o.mode)).toEqual([
      '滴滴·地铁 1号线 → 公交 100路',
      '滴滴·地铁 1号线 → 地铁 2号线',
      '出租车（滴滴估价）',
    ])
    expect(result.degraded.some((d) => d.source === 'cityAmap' && d.reason.includes('Key 未配置'))).toBe(true)
  })

  it('双渠道均失败 → 无 cityTransfer + 双渠道 degraded 记账', async () => {
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, depsWith(didiForAggregation(), { amapUp: false, env: { env: {} } }))
    expect(result.cityTransfer).toBeUndefined()
    expect(result.degraded.some((d) => d.source === 'cityAmap' && d.reason.includes('Key 未配置'))).toBe(true)
    expect(result.degraded.some((d) => d.source === 'cityDidi' && d.reason.includes('Key 未配置'))).toBe(true)
    expect(result.options.length).toBeGreaterThanOrEqual(1) // rail 不阻塞
  })

  it('cityDidi 渠道开关关闭 → degraded「已停用（用户配置）」+ 仅高德（W6 QA 抽样同款）', async () => {
    const planId = await makePlan()
    const env: KeyResolutionEnv = {
      readSettings: (key) => (key === 'channels.cityDidi' ? 'false' : undefined),
      env: { DIDI_MCP_KEY: 'k' },
    }
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, depsWith(didiForAggregation(), { env }))
    expect(result.cityTransfer).toBeDefined()
    expect(result.cityTransfer!.options.map((o) => o.mode)).toEqual(['地铁 1号线', '公交 100路'])
    const entry = result.degraded.find((d) => d.source === 'cityDidi')
    expect(entry?.reason).toBe('已停用（用户配置）')
  })
})
