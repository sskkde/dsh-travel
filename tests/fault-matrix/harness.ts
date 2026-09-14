/**
 * 故障矩阵工具装配（M3.6 / W6 harness）。
 *
 * 装配原则（与 M2 script-d / tests/tools-research-*.test.ts 同款先例）：
 * - **真实工具层 + 真实适配器**（工具降级链/fanout/契约闸门/状态机全部真实执行），
 *   仅在**适配器传输位**注入 mock（fetchFn/httpCall/hostSearch/MCP fetch）——
 *   进程内、零网络、零持久化（injectors.ts 安全纪律）；
 * - 健康（非故障行）装配 = fixture 回放（离线确定性）；故障行装配 = 四类注入
 *   原语（missing-key=env 面 / service-down=mock 抛错 / timeout=挂起+内建闸 /
 *   rate-limit=私有令牌桶灌满）；
 * - 每行独立装配实例，故障只作用于目标行，其余渠道保持健康——单行故障下
 *   断言「降级链产出 + 流程不中断」。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelEnabled, EngineError, isKeyConfigured, type KeyResolutionEnv } from '../../src/adapters/base.js'
import { AmapAdapter } from '../../src/adapters/amap.js'
import { assertDidiQueryOnly, DidiAdapter, type GeoCodeSource } from '../../src/adapters/didi.js'
import { IntercityAdapter, type FlyaiLike, type WendaoLike } from '../../src/adapters/intercity.js'
import { OpenMeteoAdapter } from '../../src/adapters/open-meteo.js'
import { McpStreamClient, READ_ONLY_TOOLS, Rail12306Adapter, type FetchLike } from '../../src/adapters/rail12306.js'
import { SearchAdapter, type HostSearchFn } from '../../src/adapters/search.js'
import { SocialAdapter } from '../../src/adapters/social.js'
import { PlaywrightSocialAdapter } from '../../src/adapters/social-playwright.js'
import { TencentMapAdapter, type HttpCallFn } from '../../src/adapters/tencent.js'
import { WendaoAdapter, WENDAO_KEY } from '../../src/adapters/wendao.js'
import { assertXhsReadOnly, XhsAdapter } from '../../src/adapters/xhs.js'
import {
  douyinChannel, platformIntelChannel, socialL1Channel, tencentPoiChannel,
  tier2Channel, tier3Channel, xhsFallbackChannel, xhsMcpChannel,
} from '../../src/orchestrator/channels.js'
import type { TransportOption } from '../../src/models/types.js'
import type { ResearchToolDeps } from '../../src/tools/research-destination.js'
import type { ResearchTransportDeps } from '../../src/tools/research-transport.js'
import type { ResearchAdviceDeps } from '../../src/tools/research-advice.js'
import type { RouteRegistrarPort } from '../../src/tools/render-page.js'
import {
  createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider,
  type RouteMeasureProvider,
} from '../../src/route-check.js'
import type { FaultKind } from './manifest.js'
import {
  faultEnv, hangingFetch, hangingHostSearch, hangingHttpCall,
  saturatingBucket, throwingFetch, throwingHostSearch, throwingHttpCall,
} from './injectors.js'

const FIX = join('tests', 'fixtures')
function fixtureText(name: string): string {
  return readFileSync(join(FIX, name), 'utf8')
}
function fixtureJson<T>(name: string): T {
  return JSON.parse(fixtureText(name)) as T
}

/** 行故障描述（row=fields.ts 渠道 id）。 */
export interface RowFault {
  row: string
  kind: FaultKind
}

/** 渠道 id → 降级记账 source 名（fanout/工具层的 degraded[].source 对齐）。 */
export const ROW_DEGRADED_SOURCES: Record<string, readonly string[]> = {
  xhsMcp: ['xhsMcp'],
  xhsFallback: ['xhsFallback'],
  douyin: ['douyin'],
  tier2: ['tier2'],
  tier3: ['tier3'],
  socialL1: ['socialL1'],
  tencentPoi: ['tencent-poi'],
  platformIntel: ['platformIntel'],
  rail12306: ['rail12306'],
  railWendao: ['intercity/wendao'],
  railFlyai: ['intercity/flyai'],
  flightWendao: ['intercity/wendao'],
  flightFlyai: ['intercity/flyai'],
  busConsult: ['intercity/wendao'],
  cityAmap: ['cityAmap'],
  cityDidi: ['cityDidi'],
  weatherAmap: ['weatherAmap'],
  weatherTencent: ['weatherTencent'],
  weatherOpenMeteo: ['weatherOpenMeteo', 'open-meteo'], // 适配器内 degraded 以 source='open-meteo' 记账
  adviceSearch: ['adviceSearch'],
  routeCheckAmap: ['amap'],
  routeCheckTencent: ['tencent'],
  travelGuideTencent: ['tencent-map'],
  mapAmap: ['render-warning'],
  mapLeaflet: ['render-warning'],
  deliveryRoute: ['render-warning'],
  deliveryFile: ['render-warning'],
}

// ────────────────────────── 通用 MCP 假传输 ──────────────────────────

interface McpBehavior {
  /** 工具名 → MCP result 对象（**原样直传**，与各适配器测试 fake 同款）。 */
  tools?: Record<string, unknown>
  /** 指定工具挂起（超时注入位；hangMs 后释放，不遗留长计时器）。 */
  hangTools?: readonly string[]
  hangMs?: number
  /** 全部请求抛错（服务停注入位）。 */
  alwaysThrow?: boolean
}

/** MCP 假传输（initialize/notifications/tools/list/call 全协议；行为表驱动）。 */
function mcpFetch(behavior: McpBehavior): FetchLike {
  let initialized = false
  return async (_url, init) => {
    if (behavior.alwaysThrow === true) throw new Error('mock MCP unreachable（fault-matrix 服务停注入）')
    const body = JSON.parse(init?.body ?? '{}') as {
      method: string; id?: number; params?: { name?: string }
    }
    const ok = (result: unknown, sessionId?: string) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      ...(sessionId !== undefined
        ? { headers: { get: (n: string) => (n === 'mcp-session-id' ? sessionId : null) } }
        : {}),
    })
    if (body.method === 'initialize') {
      initialized = true
      return ok({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-mcp', version: 'matrix' } }, 'matrix-session')
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/list') {
      return ok({ tools: [...READ_ONLY_TOOLS].map((n) => ({ name: n, description: 'read-only', inputSchema: { type: 'object' } })) })
    }
    if (body.method === 'tools/call') {
      if (!initialized) throw new Error('mock MCP not initialized（装配错误）')
      const tool = body.params?.name ?? ''
      if (behavior.hangTools?.includes(tool) === true) {
        return await hangingFetch(behavior.hangMs ?? 2_000)('http://mock/mcp')
      }
      const resp = behavior.tools?.[tool]
      if (resp === undefined) {
        return ok({ content: [{ type: 'text', text: 'no fixture' }], isError: true })
      }
      if (typeof resp === 'string') {
        return ok({ content: [{ type: 'text', text: resp }] })
      }
      return ok(resp)
    }
    return ok({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } })
  }
}

/** MCP text 结果包装（xhs normalizeXhsFeeds 解析 content[].text 面）。 */
function mcpTextResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

// ────────────────────────── FR-3：travel_research_destination 装配 ──────────────────────────

/** 健康宿主搜索（按 site: 变体路由回放；各站点命中）。 */
function healthyHostSearch(): HostSearchFn {
  return async (query: string) => {
    const hit = (url: string, title: string): { url: string; title: string; snippet: string } =>
      ({ url, title, snippet: '摘要（fixture 回放）' })
    if (query.includes('site:xiaohongshu.com')) {
      return { sources: [hit('https://www.xiaohongshu.com/explore/matrixXhs1', '杭州 景点推荐 攻略')], truncated: false }
    }
    if (query.includes('site:zhihu.com')) {
      return { sources: [hit('https://zhuanlan.zhihu.com/p/matrix1', '杭州 旅行 攻略 避雷')], truncated: false }
    }
    return { sources: [hit('https://example.invalid/matrix-web', '杭州 旅行 注意事项 证件 预约')], truncated: false }
  }
}

const noopFetchHtml = async (): Promise<{ status: number; text: string }> => ({ status: 404, text: '' })

/** 健康社媒 L0（抖音/微博/快手命中）。 */
function healthySocialSearch(): (query: string) => Promise<Array<{ url: string; title: string; snippet?: string }>> {
  return async () => [
    { url: 'https://www.douyin.com/video/matrix1', title: '杭州 旅游 攻略 推荐', snippet: '必去' },
    { url: 'http://weibo.com/matrix2', title: '杭州 避雷 注意事项', snippet: '别踩坑' },
    { url: 'https://www.kuaishou.com/matrixL1', title: '杭州 美食 小吃', snippet: '好吃' },
  ]
}

/** 健康腾讯 POI（fixture 回放；JSONP 包装）。 */
function healthyTencentPoiHttp(): HttpCallFn {
  const poi = fixtureJson<{ response: Record<string, unknown> }>('tencent/poi-search-huanghelou.json').response
  return async (url) => {
    if (!url.includes('place/v1/search')) throw new Error(`no tencent fixture for ${url}`)
    return { ok: true, status: 200, text: async () => `qq.maps.callback(${JSON.stringify(poi)});` }
  }
}

/** 健康小红书 MCP（search_feeds fixture 回放）。 */
function healthyXhsMcp(): McpStreamClient {
  const feeds = fixtureJson<Record<string, unknown>>('xhs/search-feeds.json')
  return new McpStreamClient({
    url: 'http://127.0.0.1:18060/mcp',
    fetchFn: mcpFetch({ tools: { search_feeds: mcpTextResult(feeds) } }),
    readOnlyGate: assertXhsReadOnly,
  })
}

/** 健康 Playwright MCP（三平台搜索页链接提取回放）。 */
function healthyPlaywrightFetch(): FetchLike {
  const links = [
    { href: 'https://weibo.com/matrixL1', text: '杭州 旅游 攻略' },
    { href: 'https://tieba.baidu.com/p/matrixL1', text: '杭州 旅游' },
    { href: 'https://www.kuaishou.com/matrixL1', text: '杭州 攻略' },
  ]
  return mcpFetch({
    tools: {
      browser_navigate: { content: [{ type: 'text', text: 'page loaded' }] },
      // extractLinks 期望 ExtractedLink[]（JSON 数组；unwrapPlaywrightResult 直解）
      browser_evaluate: { content: [{ type: 'text', text: JSON.stringify(links) }] },
    },
  })
}

/** FR-3 装配：目标行注入故障，其余渠道健康（fixture 回放）。 */
export function destinationDeps(fault?: RowFault): ResearchToolDeps {
  const kind = fault?.kind
  const row = fault?.row
  // missing-key 注入（零 key 行=channel-off 形态）：env 面显式关断目标渠道
  const off = kind === 'missing-key' && row !== undefined ? [row] : []
  const env = faultEnv({
    extraEnv: { TRAVEL_XHS_AUTHORIZED: '1' }, // 健康路径授权位（env 面，非持久化）
    offChannels: off,
  })

  let search = new SearchAdapter({ hostSearch: healthyHostSearch(), fetchHtml: noopFetchHtml })
  let social = new SocialAdapter({ search: healthySocialSearch() })
  let tencent = new TencentMapAdapter({ httpCall: healthyTencentPoiHttp() })
  let xhs = new XhsAdapter({ mcp: healthyXhsMcp(), timeoutMs: 2_000 })
  let playwright = new PlaywrightSocialAdapter({ fetchFn: healthyPlaywrightFetch(), timeoutMs: 2_000 })

  if (row !== undefined && kind !== undefined) {
    switch (row) {
      case 'xhsMcp':
        if (kind === 'service-down') {
          xhs = new XhsAdapter({ mcp: new McpStreamClient({ fetchFn: throwingFetch(), readOnlyGate: assertXhsReadOnly, timeoutMs: 500 }) })
        } else if (kind === 'timeout') {
          xhs = new XhsAdapter({
            mcp: new McpStreamClient({
              fetchFn: mcpFetch({ tools: { search_feeds: mcpTextResult(fixtureJson<Record<string, unknown>>('xhs/search-feeds.json')) }, hangTools: ['search_feeds'], hangMs: 1_500 }),
              readOnlyGate: assertXhsReadOnly,
            }),
            timeoutMs: 120,
          })
        } else if (kind === 'rate-limit') {
          xhs = new XhsAdapter({ mcp: healthyXhsMcp(), rateLimiter: saturatingBucket(), timeoutMs: 1_000 })
        }
        break
      case 'xhsFallback':
      case 'tier2':
      case 'platformIntel':
        if (kind === 'service-down') search = new SearchAdapter({ hostSearch: throwingHostSearch(), fetchHtml: noopFetchHtml })
        if (kind === 'timeout') search = new SearchAdapter({ hostSearch: hangingHostSearch(1_500), fetchHtml: noopFetchHtml })
        break
      case 'douyin':
      case 'tier3':
        if (kind === 'service-down') {
          social = new SocialAdapter({ search: async () => { throw new Error('mock social search down（fault-matrix 服务停注入）') } })
        }
        if (kind === 'timeout') {
          social = new SocialAdapter({
            search: async () => { await hangingDelay(1_500); return [] },
          })
        }
        break
      case 'socialL1':
        if (kind === 'service-down') playwright = new PlaywrightSocialAdapter({ fetchFn: throwingFetch(), timeoutMs: 500 })
        if (kind === 'timeout') {
          playwright = new PlaywrightSocialAdapter({
            fetchFn: mcpFetch({ tools: { browser_navigate: { content: [{ type: 'text', text: 'page loaded' }] } }, hangTools: ['browser_navigate'], hangMs: 1_500 }),
            timeoutMs: 5_000,
          })
        }
        break
      case 'tencentPoi':
        if (kind === 'service-down') tencent = new TencentMapAdapter({ httpCall: throwingHttpCall() })
        if (kind === 'timeout') tencent = new TencentMapAdapter({ httpCall: hangingHttpCall(1_500) })
        break
      default:
        break
    }
  }

  // 渠道清单与 buildDestinationChannels 同序同参（index.ts 生产装配形态）
  return {
    channels: [
      xhsMcpChannel(xhs, search),
      xhsFallbackChannel(search),
      douyinChannel(social, playwright),
      tier2Channel(search),
      tier3Channel(social),
      socialL1Channel(playwright),
      tencentPoiChannel(tencent),
      platformIntelChannel(search),
    ],
    env,
    timeoutMs: 400, // fanout 预算（编排级 TIMEOUT 截断的注入窗）
    retryDelaysMs: [1, 1], // 微退避（重试语义保持，测试不拖时）
  }
}

/** 可释放的挂起等待（测试无长计时器残留）。 */
async function hangingDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

// ────────────────────────── FR-4：travel_research_transport 装配 ──────────────────────────

/** 健康键面（测试值；missing-key 注入按行剔除——纯 env 面，零生产凭据）。 */
const TRANSPORT_KEYS: Record<string, string> = {
  amapWebservice: 'matrix-amap-key',
  didi: 'matrix-didi-key',
  wendao: 'matrix-wendao-key',
  flyai: 'matrix-flyai-key',
}

/** 高德 fixture 传输（geocode/direction/distance/weather 端点回放 + 行为注入）。 */
function amapFixtureFetch(behavior: { throw?: boolean; hang?: boolean } = {}): AmapAdapter {
  const files: Array<[string, Record<string, unknown>]> = [
    ['direction/transit/integrated', fixtureJson<{ response: Record<string, unknown> }>('amap/transit.json').response],
    ['geocode/geo', fixtureJson<{ response: Record<string, unknown> }>('amap/geocode.json').response],
    ['distance', fixtureJson<{ response: Record<string, unknown> }>('amap/distance.json').response],
    ['weather/weatherInfo', fixtureJson<{ response: Record<string, unknown> }>('amap/weather.json').response],
  ]
  return new AmapAdapter({
    timeoutMs: 120,
    fetchFn: async (url) => {
      if (behavior.throw === true) throw new Error('mock amap down（fault-matrix 服务停注入）')
      if (behavior.hang === true) return await hangingFetch(1_500)(url)
      const hit = files.find(([ep]) => url.includes(ep))
      if (hit === undefined) throw new Error(`no amap fixture for ${url}`)
      return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) }
    },
  })
}

/** wendao 位（WendaoLike 结构桩）：available 走真实 ADR-12 链（开关+key 解析）。 */
function wendaoStub(behavior: { up: boolean }): WendaoLike {
  return {
    name: 'wendao',
    async available(env?: KeyResolutionEnv): Promise<boolean> {
      // 与 WendaoAdapter.available 同判定路径：channelEnabled('wendao') + key 链
      return behavior.up && channelEnabled('wendao', env) && await isKeyConfigured(WENDAO_KEY, env)
    },
    async query() {
      // 健康态返回空 entries：chain 记 EMPTY 后落 flyai/搜索位（互备链语义照常演练）
      return { entries: [], raw: '', degraded: [] }
    },
  }
}

/** wendao 真实超时位：真实适配器 + 挂起 fetch + 内建 timeoutMs 闸（EngineError.timeout 面）。 */
function hangingWendao(): WendaoAdapter {
  return new WendaoAdapter({
    endpoint: 'http://mock/wendao',
    fetchFn: hangingFetch(1_500),
    timeoutMs: 100,
  })
}

/** flyai 位（FlyaiLike 结构桩）：零 key 试用档语义 + 注入行为。 */
function flyaiStub(behavior: { mode: 'healthy' | 'throw' | 'timeout' }): FlyaiLike {
  const option = (mode: 'rail' | 'flight'): TransportOption => ({
    mode,
    segments: [{
      from: '北京南', to: '上海虹桥',
      ...(mode === 'rail' ? { no: 'G5', depart: '06:08', arrive: '12:04' } : { no: 'MU5100', depart: '08:00', arrive: '10:15' }),
      priceRange: [500, 620], channel: 'flyai-stub',
    }],
    totalPriceRange: [500, 620],
    durationMinutes: mode === 'rail' ? 356 : 135,
    source: { platform: 'flyai', url: 'https://example.invalid/flyai-matrix', fetchedAt: new Date().toISOString() },
  })
  return {
    name: 'flyai',
    async available(env?: KeyResolutionEnv): Promise<boolean> {
      // 零 key 试用档：缺 key 不阻塞（设计语义）；仅渠道开关门控
      return channelEnabled('flyai', env)
    },
    async queryFlights() {
      if (behavior.mode === 'throw') throw new Error('mock flyai CLI down（fault-matrix 服务停注入）')
      if (behavior.mode === 'timeout') throw EngineError.timeout('flyai search-flight 超时（CLI 45s 闸，fault-matrix 注入等价面）', 'flyai')
      return [option('flight')]
    },
    async queryTrains() {
      if (behavior.mode === 'throw') throw new Error('mock flyai CLI down（fault-matrix 服务停注入）')
      if (behavior.mode === 'timeout') throw EngineError.timeout('flyai search-train 超时（CLI 45s 闸，fault-matrix 注入等价面）', 'flyai')
      return [option('rail')]
    },
  }
}

/** intercity 搜索位（L0 结构化兜底；命中可被 optionsFromHits 解析）。 */
function intercitySearchStub(up: boolean): { name: string; search(): Promise<Array<{ url: string; title: string; snippet?: string }>> } {
  const hits = [
    { url: 'https://www.12306.cn/matrix', title: '2026-09-04 北京到上海 G5 06:08 12:04 ¥550元', snippet: '二等座' },
    { url: 'https://www.ctrip.com/matrix', title: '2026-09-04 北京到上海 MU5100 08:00 10:15 ¥900元', snippet: '经济舱' },
    { url: 'https://example.invalid/bus', title: '上海客运中心-虹桥客运站 08:00 ¥60元', snippet: '高速' },
  ]
  return {
    name: 'search',
    async search() {
      if (!up) throw new Error('mock intercity search down（fault-matrix 服务停注入）')
      return hits
    },
  }
}

/** 滴滴坐标解析桩（地名→固定 GCJ-02 坐标；真实 resolveCoord 链在 adapter 内执行）。 */
const fakeGeocoder: GeoCodeSource = {
  name: 'matrix-geocoder',
  async geocode() {
    return { coords: { lng: 121.4737, lat: 31.2304, sys: 'GCJ02' }, degraded: [] }
  },
}

/** 滴滴 MCP 假传输（transit 路由回放/故障注入；只读白名单闸与生产同款）。 */
function didiMcp(behavior: { mode: 'healthy' | 'throw' | 'hang' | 'service-state' }): McpStreamClient {
  const transit = behavior.mode === 'service-state'
    // 上游服务态：transit 有应答但无 routes（M2 w0 复跑同款「无 result」形态）
    ? { structuredContent: {} }
    : { structuredContent: { routes: [{ scheme: '地铁 2号线', duration: 25, price: 4 }] } }
  return new McpStreamClient({
    url: 'http://127.0.0.1:8124/mcp',
    fetchFn: mcpFetch({
      tools: { maps_direction_transit: transit, taxi_estimate: { structuredContent: {} } },
      alwaysThrow: behavior.mode === 'throw',
      hangTools: behavior.mode === 'hang' ? ['maps_direction_transit', 'taxi_estimate'] : undefined,
      hangMs: 1_500,
    }),
    timeoutMs: 120,
    readOnlyGate: assertDidiQueryOnly,
  })
}

/** FR-4 装配：目标行注入故障，其余渠道健康。 */
export function transportDeps(fault?: RowFault): ResearchTransportDeps {
  const kind = fault?.kind
  const row = fault?.row
  const off: string[] = []
  const keys: Record<string, string> = { ...TRANSPORT_KEYS }
  const dropKey = (keyId: string): void => { delete keys[keyId] }

  let rail = new Rail12306Adapter({
    mcp: new McpStreamClient({
      fetchFn: mcpFetch({
        tools: {
          'query-tickets': fixtureJson<{ result: unknown }>('rail12306/query-tickets.json').result,
          'query-ticket-price': fixtureJson<{ result: unknown }>('rail12306/query-ticket-price.json').result,
        },
      }),
    }),
  })
  let amap = amapFixtureFetch()
  let didi = new DidiAdapter({ mcp: didiMcp({ mode: 'healthy' }), geocoders: [fakeGeocoder], timeoutMs: 500 })
  let wendao: WendaoLike = wendaoStub({ up: true })
  let flyaiMode: 'healthy' | 'throw' | 'timeout' = 'healthy'
  let intercitySearchUp = true

  if (row !== undefined && kind !== undefined) {
    switch (row) {
      case 'rail12306':
        if (kind === 'missing-key') off.push('rail12306')
        if (kind === 'service-down') {
          rail = new Rail12306Adapter({ mcp: new McpStreamClient({ fetchFn: throwingFetch(), timeoutMs: 300 }) })
        }
        if (kind === 'timeout') {
          rail = new Rail12306Adapter({
            mcp: new McpStreamClient({ fetchFn: mcpFetch({ hangTools: [...READ_ONLY_TOOLS], hangMs: 1_500 }), timeoutMs: 100 }),
          })
        }
        break
      case 'railWendao':
      case 'flightWendao':
      case 'busConsult':
        // 三行共用 wendao 位（一个问道 key 承接 rail/flight/bus 三段的实际代码语义）
        if (kind === 'missing-key') dropKey('wendao')
        if (kind === 'service-down') wendao = wendaoStub({ up: false })
        if (kind === 'timeout') wendao = hangingWendao()
        break
      case 'railFlyai':
      case 'flightFlyai':
        // 链位语义（manifest note）：flyai 段故障 case 需上游 wendao 段同故障
        if (kind === 'missing-key') { dropKey('wendao'); dropKey('flyai') }
        if (kind === 'service-down') { dropKey('wendao'); flyaiMode = 'throw' }
        if (kind === 'timeout') { dropKey('wendao'); flyaiMode = 'timeout' }
        break
      case 'cityAmap':
        if (kind === 'missing-key') dropKey('amapWebservice')
        if (kind === 'service-down') amap = amapFixtureFetch({ throw: true })
        if (kind === 'timeout') amap = amapFixtureFetch({ hang: true })
        break
      case 'cityDidi':
        if (kind === 'missing-key') dropKey('didi')
        if (kind === 'service-down') didi = new DidiAdapter({ mcp: didiMcp({ mode: 'throw' }), geocoders: [fakeGeocoder], timeoutMs: 500 })
        if (kind === 'timeout') didi = new DidiAdapter({ mcp: didiMcp({ mode: 'hang' }), geocoders: [fakeGeocoder], timeoutMs: 120 })
        break
      default:
        break
    }
  }

  return {
    rail,
    intercity: new IntercityAdapter({
      wendao,
      flyai: flyaiStub({ mode: flyaiMode }),
      search: intercitySearchStub(intercitySearchUp),
    }),
    amap,
    didi,
    env: faultEnv({ keys, offChannels: off }),
    timeoutMs: 30_000,
  }
}

/** 滴滴 service-state 装配（上游 transit 无 result；代码链全健康）。 */
export function transportDepsDidiServiceState(): ResearchTransportDeps {
  return {
    ...transportDeps(),
    didi: new DidiAdapter({ mcp: didiMcp({ mode: 'service-state' }), geocoders: [fakeGeocoder], timeoutMs: 500 }),
  }
}

// ────────────────────────── 「全部主渠道失败」组演练装配（FR-3~7 各一） ──────────────────────────

/** FR-3 全主渠道失败：destination 全部渠道服务停（healthy 面全换注入实例）。 */
export function destinationDepsAllDown(): ResearchToolDeps {
  return {
    channels: [
      xhsMcpChannel(new XhsAdapter({ mcp: new McpStreamClient({ fetchFn: throwingFetch(), readOnlyGate: assertXhsReadOnly, timeoutMs: 500 }) }), emptySearch()),
      xhsFallbackChannel(emptySearch()),
      douyinChannel(downSocial()),
      tier2Channel(emptySearch()),
      tier3Channel(downSocial()),
      socialL1Channel(new PlaywrightSocialAdapter({ fetchFn: throwingFetch(), timeoutMs: 500 })),
      tencentPoiChannel(new TencentMapAdapter({ httpCall: throwingHttpCall() })),
      platformIntelChannel(emptySearch()),
    ],
    env: faultEnv({ extraEnv: { TRAVEL_XHS_AUTHORIZED: '1' } }),
    timeoutMs: 400,
    retryDelaysMs: [1, 1],
  }
}

/** FR-4 全主渠道失败：rail/wendao/flyai/搜索/amap/didi 全故障。 */
export function transportDepsAllDown(): ResearchTransportDeps {
  return {
    rail: new Rail12306Adapter({ mcp: new McpStreamClient({ fetchFn: throwingFetch(), timeoutMs: 300 }) }),
    intercity: new IntercityAdapter({
      wendao: wendaoStub({ up: false }),
      flyai: flyaiStub({ mode: 'throw' }),
      search: intercitySearchStub(false),
    }),
    amap: amapFixtureFetch({ throw: true }),
    didi: new DidiAdapter({ mcp: didiMcp({ mode: 'throw' }), geocoders: [fakeGeocoder], timeoutMs: 500 }),
    env: faultEnv({ keys: { ...TRANSPORT_KEYS } }),
    timeoutMs: 30_000,
  }
}

/** FR-5 全主渠道失败：amap/tencent/open-meteo/search 全故障。 */
export function adviceDepsAllDown(): ResearchAdviceDeps {
  return {
    amap: amapFixtureFetch({ throw: true }),
    tencent: new TencentMapAdapter({ httpCall: throwingHttpCall() }),
    openMeteo: openMeteoFixture({ throw: true }),
    search: new SearchAdapter({ hostSearch: throwingHostSearch(), fetchHtml: noopFetchHtml }),
    env: faultEnv({ keys: { amapWebservice: 'matrix-amap-key' } }),
    timeoutMs: 30_000,
  }
}

/** FR-6 全主渠道失败：routeCheck amap/tencent 双故障（estimate 兜底）。 */
export function buildDepsAllDown(): BuildHarnessDeps {
  return {
    providers: [
      createAmapRouteProvider(amapFixtureFetch({ throw: true })),
      createTencentRouteProvider(new TencentMapAdapter({ httpCall: throwingHttpCall() })),
      createEstimateRouteProvider(),
    ],
    keyEnv: faultEnv({ keys: { amapWebservice: 'matrix-amap-key' } }),
  }
}

/** FR-7 双地图通道停用 + 在线路由注册失败（渲染仍须产出，W6 补强路径）。 */
export const RENDER_FR7_OFF = ['mapAmap', 'mapLeaflet'] as const

function emptySearch(): SearchAdapter {
  return new SearchAdapter({
    hostSearch: async () => ({ sources: [], truncated: false }),
    fetchHtml: noopFetchHtml,
  })
}
function downSocial(): SocialAdapter {
  return new SocialAdapter({ search: async () => { throw new Error('mock social search down（fault-matrix 服务停注入）') } })
}

// ────────────────────────── FR-5：travel_research_advice 装配 ──────────────────────────

/** 健康腾讯（poi 坐标 + weather 回放；weather fixture 为裸 API 响应面）。 */
function healthyTencentAdviceHttp(): HttpCallFn {
  const weather = fixtureJson<Record<string, unknown>>('tencent/weather-hangzhou.json')
  const poi = fixtureJson<{ response: Record<string, unknown> }>('tencent/poi-search-huanghelou.json').response
  return async (url) => {
    if (url.includes('/ws/weather/')) return { ok: true, status: 200, text: async () => JSON.stringify(weather) }
    if (url.includes('place/v1/search')) return { ok: true, status: 200, text: async () => `qq.maps.callback(${JSON.stringify(poi)});` }
    throw new Error(`no tencent fixture for ${url}`)
  }
}

/** Open-Meteo（daily 面回放 + 行为注入）。 */
function openMeteoFixture(behavior: { throw?: boolean; hang?: boolean } = {}): OpenMeteoAdapter {
  return new OpenMeteoAdapter({
    timeoutMs: 100,
    fetchFn: async (input: string) => {
      if (behavior.throw === true) throw new Error('mock open-meteo down（fault-matrix 服务停注入）')
      if (behavior.hang === true) return await hangingFetch(1_500)(input)
      const url = new URL(input)
      const start = url.searchParams.get('start_date') ?? '2026-09-02'
      const end = url.searchParams.get('end_date') ?? '2026-09-04'
      const dates: string[] = []
      const tmax: number[] = []
      const tmin: number[] = []
      const codes: number[] = []
      const cursor = new Date(`${start}T00:00:00.000Z`)
      const last = new Date(`${end}T00:00:00.000Z`)
      for (let i = 0; cursor.getTime() + i * 86_400_000 <= last.getTime(); i += 1) {
        dates.push(new Date(cursor.getTime() + i * 86_400_000).toISOString().slice(0, 10))
        tmax.push(28 + (i % 3))
        tmin.push(20 + (i % 2))
        codes.push(i % 2)
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ daily: { time: dates, temperature_2m_max: tmax, temperature_2m_min: tmin, weathercode: codes } }),
      }
    },
  })
}

/** FR-5 装配。 */
export function adviceDeps(fault?: RowFault): ResearchAdviceDeps {
  const kind = fault?.kind
  const row = fault?.row
  const off = kind === 'missing-key' && row !== undefined ? [row] : []
  const keys: Record<string, string> = { amapWebservice: 'matrix-amap-key' }

  let amap = amapFixtureFetch()
  let tencent = new TencentMapAdapter({ httpCall: healthyTencentAdviceHttp() })
  let openMeteo = openMeteoFixture()
  let search = new SearchAdapter({ hostSearch: healthyHostSearch(), fetchHtml: noopFetchHtml })

  if (row !== undefined && kind !== undefined) {
    switch (row) {
      case 'weatherAmap':
        if (kind === 'missing-key') dropKeyAmap()
        if (kind === 'service-down') amap = amapFixtureFetch({ throw: true })
        if (kind === 'timeout') amap = amapFixtureFetch({ hang: true })
        break
      case 'weatherTencent':
        if (kind === 'service-down') tencent = new TencentMapAdapter({ httpCall: throwingHttpCall() })
        break
      case 'weatherOpenMeteo':
        if (kind === 'service-down') openMeteo = openMeteoFixture({ throw: true })
        if (kind === 'timeout') openMeteo = openMeteoFixture({ hang: true })
        break
      case 'adviceSearch':
        if (kind === 'service-down') search = new SearchAdapter({ hostSearch: throwingHostSearch(), fetchHtml: noopFetchHtml })
        break
      default:
        break
    }
  }

  function dropKeyAmap(): void { delete keys.amapWebservice }

  return { amap, tencent, openMeteo, search, env: faultEnv({ keys, offChannels: off }), timeoutMs: 30_000 }
}

// ────────────────────────── FR-6：travel_build_itinerary 装配 ──────────────────────────

/** 健康腾讯（distance_matrix 回放；POI 端点同回放保底）。 */
function healthyTencentDistanceHttp(): HttpCallFn {
  const distance = fixtureJson<{ response: Record<string, unknown> }>('tencent/distance-matrix.json').response
  const poi = fixtureJson<{ response: Record<string, unknown> }>('tencent/poi-search-huanghelou.json').response
  return async (url) => {
    if (url.includes('distance')) return { ok: true, status: 200, text: async () => JSON.stringify(distance) }
    if (url.includes('place/v1/search')) return { ok: true, status: 200, text: async () => `qq.maps.callback(${JSON.stringify(poi)});` }
    throw new Error(`no tencent fixture for ${url}`)
  }
}

export interface BuildHarnessDeps {
  providers: readonly RouteMeasureProvider[]
  keyEnv: KeyResolutionEnv
}

/** FR-6 装配（provider 链 amap→tencent→estimate；目标行注入）。 */
export function buildDeps(fault?: RowFault): BuildHarnessDeps {
  const kind = fault?.kind
  const row = fault?.row
  const off = kind === 'missing-key' && row !== undefined ? [row] : []
  const keys: Record<string, string> = { amapWebservice: 'matrix-amap-key' }

  let amap = amapFixtureFetch()
  let tencent = new TencentMapAdapter({ httpCall: healthyTencentDistanceHttp() })

  if (row !== undefined && kind !== undefined) {
    switch (row) {
      case 'routeCheckAmap':
        if (kind === 'missing-key') delete keys.amapWebservice
        if (kind === 'service-down') amap = amapFixtureFetch({ throw: true })
        if (kind === 'timeout') amap = amapFixtureFetch({ hang: true })
        break
      case 'routeCheckTencent':
        // 链位语义（manifest note）：tencent 段在 amap 之后——故障 case 需 amap
        // 同故障，链才会推进到 tencent（否则 amap 成功即 break）
        if (kind === 'missing-key') { delete keys.amapWebservice; off.push('routeCheckTencent') }
        if (kind === 'service-down') { amap = amapFixtureFetch({ throw: true }) }
        break
      default:
        break
    }
  }

  return {
    providers: [createAmapRouteProvider(amap), createTencentRouteProvider(tencent), createEstimateRouteProvider()],
    keyEnv: faultEnv({ keys, offChannels: off }),
  }
}

/** FR-6 adapter 面演练：travel_guide 端点故障（TencentMapAdapter A2A 位；无工具消费位）。 */
export function tencentTravelGuideFaulted(mode: 'throw' | 'no-plan'): TencentMapAdapter {
  return new TencentMapAdapter({
    httpCall: async (_url) => {
      if (mode === 'throw') throw new Error('mock travel_guide A2A down（fault-matrix 服务停注入）')
      return { ok: true, status: 200, text: async () => 'event: message\ndata: {}\n\n' } // 无 plan_day 事件
    },
  })
}

// ────────────────────────── FR-7：travel_render_page 装配 ──────────────────────────

export interface FakeRegistrar extends RouteRegistrarPort {
  readonly registeredPaths: readonly string[]
}

/** 假 registrar（记录注册；可注入「注册失败」=deliveryRoute 服务停）。 */
export function fakeRegistrar(options: { throwOnRegister?: boolean } = {}): FakeRegistrar {
  const registeredPaths: string[] = []
  return {
    host: '127.0.0.1',
    port: 41230,
    registeredPaths,
    register(route: { kind: 'prefix'; path: string; handler: unknown }): void {
      if (options.throwOnRegister === true) {
        throw new Error('mock webserver route registration failed（fault-matrix 服务停注入）')
      }
      registeredPaths.push(route.path)
    },
  }
}

/** FR-7 env 面（mapAmap/mapLeaflet 开关 + amapJsapi/jscode 键；零生产凭据）。 */
export function renderEnv(options: { off?: readonly string[]; amapReady?: boolean } = {}): KeyResolutionEnv {
  return faultEnv({
    keys: options.amapReady === true
      ? { amapJsapi: 'matrix-jsapi-key', amapJscode: 'matrix-jscode-key' }
      : {},
    offChannels: options.off ?? [],
  })
}
