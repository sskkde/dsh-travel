/**
 * dsh-travel — 旅行规划插件（hybrid：node 工具 + client 设置页）。
 *
 * W1（M1 T2）接线：travel_intake / travel_get_state / travel_update_request。
 * W2a+ 追加 research/build/render 工具与适配器；Wα（T5）接入 fan-out 编排器
 * （薄版双渠道：tencent-poi + search-l0）、自动提案 build、Leaflet 行程页渲染
 * 与 prefix 路由（/travel-plans/<planId>）。
 * W3（T6）检索三件套完整版：research_destination 七渠道 fan-out（xhsMcp 未挂载降级
 * 语义 + xhsFallback L0/L0.5 + 抖音/二层/三层 L0 + 腾讯 POI + 平台情报）、
 * research_transport（12306 MCP/降级链/市内衔接高德单方案 + 对比）、
 * research_advice（高德→腾讯→Open-Meteo 天气链 + 穿衣/物品）；统一超时预算/重试/
 * 进度（presentCall）/降级。**ADR-12 唯一真源 = makeKeyEnv(ctx)**（渠道开关热读 +
 * Key 链 + credentials refs），所有工具执行时热读取。
 *
 * 服务注入面（inject）：
 * - tools：工具注册（硬依赖）
 * - web：L0 宿主搜索 seam（ctx.web.search 适配进 SearchAdapter.hostSearch 与
 *   SocialAdapter.SearchFn）
 * - webServer：行程页 prefix 路由注册（幂等包装）+ 只读同源 /travel-metrics
 *   与 cloak profile 一键清除受控路由（M3.3；POST+confirm 防误触，不激活 hook）
 */
import type { Context } from 'cordis'
// dsh-web / dsh-host-webserver 类型导入：给 ctx.web.search 结果定型，
// 并载入各服务在 cordis Context 上的模块增强（web / webServer）
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
// 值导入以加载 cordis 模块增强（type-only import 不触发 declare module 增强——
// spike-webserver.ts 同款约定；否则 ctx.webServer 在 Context 类型上不存在）
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { TravelStore } from './store/store.js'
import { resolveTravelRoot } from './store/paths.js'
import { createTravelIntakeTool } from './tools/intake.js'
import { createTravelGetStateTool } from './tools/state.js'
import { createTravelUpdateTool } from './tools/update.js'
import { createTravelResearchDestinationTool } from './tools/research-destination.js'
import { createTravelResearchTransportTool } from './tools/research-transport.js'
import { createTravelResearchAdviceTool } from './tools/research-advice.js'
import { createTravelFetchResearchContentTool, createTravelReadResearchContentTool, createFetchBodyHandler } from './tools/research-content.js'
import { createTravelRecordResearchAssessmentTool, createTravelReadResearchAssessmentTool } from './tools/research-assessment.js'
import { createTravelRecordInsightsTool } from './tools/insights.js'
import { createTravelResolvePlacesTool, createAmapResolver, createTencentResolver } from './tools/resolve-places.js'
import { createTravelRouteTransportTool, createAmapLegProvider, createTencentLegProvider, createEstimateLegProvider } from './tools/route-transport.js'
import { createTravelRouteCoverageTool } from './tools/route-coverage.js'
import { createTravelBuildItineraryTool } from './tools/build-itinerary.js'
import { createTravelRenderPageTool } from './tools/render-page.js'
import { TencentMapAdapter } from './adapters/tencent.js'
import { SearchAdapter, type HostSearchFn, defaultFetchHtml } from './adapters/search.js'
import { SocialAdapter, type SearchHit } from './adapters/social.js'
import { AmapAdapter, AMAP_MONTHLY_QUOTA } from './adapters/amap.js'
import { DidiAdapter } from './adapters/didi.js'
import { DidaHotelAdapter } from './adapters/dida-hotel.js'
import { Rail12306Adapter } from './adapters/rail12306.js'
import { XhsAdapter, XhsTokenCache } from './adapters/xhs.js'
import { WendaoAdapter } from './adapters/wendao.js'
import { ZhihuAdapter } from './adapters/zhihu.js'
import { FlyaiAdapter } from './adapters/flyai.js'
import { IntercityAdapter } from './adapters/intercity.js'
import { OpenMeteoAdapter } from './adapters/open-meteo.js'
import { PlaywrightSocialAdapter } from './adapters/social-playwright.js'
import { clearCloakBrowserProfiles } from './adapters/cloak.js'
import { makeKeyEnv } from './adapters/env.js'
import { buildDestinationChannels } from './orchestrator/channels.js'
import { createDedupingRouteRegistrar } from './render/route-registrar.js'
import {
  UsageRecorder, setDefaultUsageRecorder,
  makeTravelMetricsHandler, makeCloakClearHandler,
  TRAVEL_METRICS_PATH, TRAVEL_METRICS_CLOAK_CLEAR_PATH,
} from './metrics/usage.js'
import { makeTravelKeyStatusHandler, TRAVEL_KEY_STATUS_PATH } from './metrics/key-status.js'
import { registerTravelSettings } from './settings/schema.js'
import { CompanionSupervisor, type CompanionServiceName } from './lifecycle/companion-supervisor.js'

export const name = 'dsh-travel'

/** 工具/检索/路由服务：tools 硬依赖；web（L0 宿主搜索）与 webServer（行程页路由）为渲染链路依赖。 */
export const inject: string[] = ['tools', 'web', 'webServer']

/** ctx.web.search → SearchAdapter.hostSearch 适配（dsh-web 类型导入同时载入 ctx.web 模块增强）。 */
const hostSearchViaWeb = (ctx: Context): HostSearchFn =>
  async (query, maxResults) => {
    const result: WebSearchResult = await ctx.web.search({ query, maxResults })
    return { content: result.content, sources: [...result.sources], truncated: result.truncated }
  }

/** ctx.web.search → SocialAdapter.SearchFn（L0 社媒搜索位；title/snippet/url 面）。 */
const socialSearchViaWeb = (ctx: Context): ((query: string) => Promise<SearchHit[]>) =>
  async (query) => {
    const result: WebSearchResult = await ctx.web.search({ query, maxResults: 6 })
    return result.sources.map((s: WebSearchSource) => ({
      title: s.title ?? s.url,
      url: s.url,
      snippet: s.snippet,
    }))
  }

/**
 * 伴随服务收尾 disposer（ctx.effect 注册位；导出供单测以 fake 验证 dispose 语义）：
 * supervisor.stopAll()（SIGTERM 进程组 → 宽限 → SIGKILL；docker 只 stop 本会话
 * 启动的容器；pid/log 清理）+ 各 MCP 适配器统一 close()（会话 DELETE；幂等，
 * 单个失败不阻塞其余收尾）。外部预存服务（非本插件启动）不受影响。
 */
export function createCompanionDisposer(deps: {
  supervisor: { stopAll(): Promise<void> }
  adapters: ReadonlyArray<{ name: string; close(): Promise<void> }>
  log?: (message: string) => void
}): () => Promise<void> {
  return async () => {
    await deps.supervisor.stopAll()
    for (const adapter of deps.adapters) {
      try {
        await adapter.close()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ;(deps.log ?? ((line) => { console.warn(`[dsh-travel] ${line}`) }))(`${adapter.name} 会话收尾失败（不影响卸载）：${message}`)
      }
    }
  }
}

export function apply(ctx: Context): void {
  // 契约与状态层三工具（store 根：explicit → env DSH_TRAVEL_ROOT → cwd）
  const store = new TravelStore(resolveTravelRoot())
  ctx.tools.register(createTravelIntakeTool(store))
  ctx.tools.register(createTravelGetStateTool(store))
  ctx.tools.register(createTravelUpdateTool(store))
  ctx.tools.register(createTravelRecordInsightsTool(store))

  // ADR-12 唯一真源：settings 热读（渠道开关 + Key 链）+ credentials refs + env 兜底
  const env = makeKeyEnv(ctx)

  // M3.3 用量统计（NFR-6 可视化底座）：插件根 .dsh-travel/usage.json 原子持久化。
  // recorder 设为模块级默认 → fanout/base 治理等埋点统一落同一快照；零 key/secret。
  const usageRecorder = new UsageRecorder()
  setDefaultUsageRecorder(usageRecorder)

  // M3.5 伴随服务 supervisor（默认关闭=companionAutostart off，行为与 M2 完全
  // 一致：直连已手动运行的服务，服务挂→既有降级链，零新进程）。开启后适配器
  // available()/ensurePing() 的 ping 失败路径会经 ensure 钩子按需拉起。
  const supervisor = new CompanionSupervisor()
  const ensureCompanion = (name: CompanionServiceName): Promise<boolean> =>
    supervisor.ensure(name).then((result) => result.ok)

  // 适配器装配（渠道可用性/Key 门控统一走 env）；tencent 传入 makeKeyEnv 热读环境：
  // TMAP key 链（settings keys.tmap → credentials tmap/key → env TMAP_KEY）经 ADR-12
  // 链接线生效（CLOSURE §三-⑥；resolveKeyOnce 每次调用即时解析，改 key 即下次生效）。
  const tencent = new TencentMapAdapter({ keyEnv: env })
  // XHS xsec_token 仅在本进程内短时存在，SearchAdapter 与 MCP 适配器共享同一
  // planId+noteId 通道；没有 URL/令牌持久化面。
  const xhsTokenCache = new XhsTokenCache()
  const search = new SearchAdapter({ hostSearch: hostSearchViaWeb(ctx), usage: usageRecorder, xhsTokenCache })
  const social = new SocialAdapter({ search: socialSearchViaWeb(ctx) })
  const amap = new AmapAdapter({ usage: usageRecorder })
  const rail = new Rail12306Adapter({ ensure: () => ensureCompanion('rail12306') })
  const wendao = new WendaoAdapter()
  const zhihu = new ZhihuAdapter({ usage: usageRecorder })
  // W4 机票三档 + 火车互备（M2.3）：intercity 接通 flyai（零 key 试用档，
  // @fly-ai/flyai-cli flag 映射+枚举翻译）与 L0 搜索兜底位（ctx.web seam 同款
  // socialSearchViaWeb 适配 SearchLike）——flight：wendao→flyai→搜索；rail12306
  // 不可用时 searchTrains 互备链同构复用。flyai 二进制缺失时 available()=false
  // 如实降级记账，不影响其余档位。
  const intercity = new IntercityAdapter({
    wendao,
    flyai: new FlyaiAdapter(),
    search: { name: 'web-l0', search: socialSearchViaWeb(ctx) },
  })
  const openMeteo = new OpenMeteoAdapter()
  // W3a L1/L2 协同：Playwright 社媒适配器（McpStreamClient 复用 + 只读白名单六件）
  // ——L1 登录态定向（三层三平台搜索页）+ 抖音 L2 正文渲染（socialDepth≥L2 富化）。
  // MCP 未部署（:8931 不可达）→ ping false → socialL1 渠道「渠道不可用」记账、
  // douyin 退 L0 形态，零阻塞（降级链语义与 xhs/didi 同构）。
  const playwright = new PlaywrightSocialAdapter({ ensure: () => ensureCompanion('playwright') })
  // M3.5：XhsAdapter 实例所有权上移至 index（原 channels.ts 内懒构造）——统一
  // 接线 ensure 钩子与 dispose 收尾；channels 侧仅收依赖注入（测试 fake 不变）。
  const xhs = new XhsAdapter({ ensure: () => ensureCompanion('xhs'), tokenCache: xhsTokenCache })
  // W5 市内衔接渠道二：前置地理编码链（design §5.1）——amap geocoder → 腾讯
  // map-assistant POI（零 key）；DIDI_MCP_KEY 未配 → available()=false → fan-out
  // 跳过 + degraded「Key 未配置」。key 由 mcporter 上游代管鉴权，适配器零传输。
  const didi = new DidiAdapter({
    geocoders: [
      { name: 'amap', geocode: (address, city, e) => amap.geocode(address, city, e) },
      {
        name: 'tencent-map',
        geocode: async (address, city) => {
          const result = await tencent.poiSearch({ keywords: address, region: city ?? undefined, pageSize: 1 })
          return { coords: result.data[0]?.coords, degraded: [] }
        },
      },
    ],
  })

  // W3 检索三件套（M1 完整版）
  ctx.tools.register(createTravelResearchDestinationTool(store, {
    channels: buildDestinationChannels({ search, social, tencent, amap, playwright, xhs, zhihu }),
    env,
    // W3 T14：DIDA 酒店只读报价适配器（默认 off/缺 Key → blocked 零调用）
    didaHotel: new DidaHotelAdapter(),
    // B6 T26：租车咨询主/降级链（Wendao → 既有 Search/DDG），不增加交易渠道。
    wendao,
    search,
    // 单次规划开始：重置 amap 规划预算（fan-out 入口调用；长驻进程多次规划后
    // 预算不跨规划累积、不熔断静默降级——CLOSURE §三-③）。
    resetPlanBudget: () => amap.resetPlanBudget(),
  }))
  ctx.tools.register(createTravelResearchTransportTool(store, {
    rail, intercity, amap, didi, wendao, env,
  }))
  ctx.tools.register(createTravelResearchAdviceTool(store, {
    amap, tencent, openMeteo, search, env,
    // P0-A R6：advice 工具每次调用重置 amap 规划预算（配额不跨链累积）
    resetPlanBudget: () => amap.resetPlanBudget(),
  }))

  // W4 T17 单一集成：W1-W3 新工具注册面（全部经 makeKeyEnv(ctx) 热读注入 env/settings）
  // ── DR2 指定正文：SSR 内建提取（fetchBody）为默认路径；URL 安全门在控制器内 ──
  ctx.tools.register(createTravelFetchResearchContentTool(store, {
    fetchBody: createFetchBodyHandler(defaultFetchHtml, { env, search, xhs }),
    env,
  }))
  ctx.tools.register(createTravelReadResearchContentTool(store))
  // ── DR3 调用方 assessment 充分性门 ──
  ctx.tools.register(createTravelRecordResearchAssessmentTool(store))
  // ── DR4 只读 assessment 详情读取（gaps/findings/conflicts 摘要；零正文全文）──
  ctx.tools.register(createTravelReadResearchAssessmentTool(store))
  // ── W2 地理解析：amap → tencent 生产 resolver 链（可选 OSM 默认不装配） ──
  ctx.tools.register(createTravelResolvePlacesTool(store, {
    resolvers: [createAmapResolver(amap), createTencentResolver(tencent)],
    env,
    // P0-A R6：resolve 工具每次调用重置 amap 规划预算（多次 resolve 不把配额拱到熔断）
    resetPlanBudget: () => amap.resetPlanBudget(),
  }))
  // ── W3 路线各段交通旁车：高德 → 腾讯 → 直线估算三级 provider ──
  ctx.tools.register(createTravelRouteTransportTool(store, {
    providers: [createAmapLegProvider(amap), createTencentLegProvider(tencent), createEstimateLegProvider()],
    env,
    resetPlanBudget: () => amap.resetPlanBudget(),
  }))
  // ── W2 路线覆盖旁车（纯派生，store only，零网络） ──
  ctx.tools.register(createTravelRouteCoverageTool(store))

  // 行程生成与渲染（W3 并行波注释留位：W4 在本次提交收口）
  // W4 完整版 build：动线校验三级降级链——高德（amapWebservice key）→ 腾讯（零 key）→
  // 直线估算兜底；key/渠道开关经 makeKeyEnv(ctx) 每次执行热读取（ADR-12 唯一真源）。
  ctx.tools.register(createTravelBuildItineraryTool(store, {
    amap,
    tencent,
    keyEnvHost: ctx,
    // P0-A R6：build 工具每次调用重置 amap 规划预算（动线测距配额不跨 build 累积）
    resetPlanBudget: () => amap.resetPlanBudget(),
  }))

  // 行程页路由：幂等注册（同 planId 重渲染不重复注册）+ 双 loader mapProvider 热读判定。
  // N-9：render 不再装配期注入一次性 makeKeyEnv 快照——工厂持 ctx（keyEnvHost），
  // 每次工具执行现造 makeKeyEnv(ctx)，credentials 执行期就绪即 mapProvider 判定走执行期 env。
  const server: WebServer = ctx.webServer
  const registrar = createDedupingRouteRegistrar(server)
  ctx.tools.register(createTravelRenderPageTool(store, registrar, { keyEnvHost: ctx }))

  // M3.3 只读同源 metrics 路由（exact）：GET /travel-metrics → redacted projection
  // （零 secret；非 GET → 405；非本机回环/白名单来源 → 403）+ cloak profile 一键清除
  // 受控位（POST + confirm 二次确认参数防误触；**不激活任何自动 hook**——只清
  // .dsh-travel/.profiles 文件，Cloak 通道本身保持默认 off、无消费方）。
  server.register({
    kind: 'exact',
    path: TRAVEL_METRICS_PATH,
    handler: makeTravelMetricsHandler(usageRecorder, {
      amapMonthlyLimit: AMAP_MONTHLY_QUOTA,
      allowSelfOrigin: true, // 只读统计：部署域名 GUI 同源 fetch 放行（非回环 Host + 同源 Origin）
    }),
  })
  server.register({
    kind: 'exact',
    path: TRAVEL_METRICS_CLOAK_CLEAR_PATH,
    handler: makeCloakClearHandler(() => clearCloakBrowserProfiles(resolveTravelRoot())),
  })

  // M3.6 渠道 Key 配置状态只读同源路由（exact）：GET /travel-key-status →
  // { ns:'travel', keys:{ id:{configured:boolean,channelEnabled:boolean} } }——每 id
  // 用 makeKeyEnv(ctx) 请求时热构造，分离凭据事实与渠道开关
  // + resolveKey(id, env) 全链判定（settings→credentials→env，与运行时工具同口径）。
  // 防护形态同 metrics（非 GET → 405；非本机回环/白名单 → 403）；响应零 secret。
  server.register({
    kind: 'exact',
    path: TRAVEL_KEY_STATUS_PATH,
    handler: makeTravelKeyStatusHandler(ctx, { allowSelfOrigin: true }), // 只读布尔面，同上
  })

  // M3.5 生命周期收尾（ctx.effect disposer）：插件卸载/重载时先 supervisor.stopAll()
  // （SIGTERM 进程组→宽限→SIGKILL；docker 只 stop 本会话启动的容器；pid/log 清理；
  // 默认关闭态=零启动资源时为空操作），再统一 close 各 MCP 适配器会话——外部
  // 预存伴随服务（12306:8123 / xhs 18060 容器 / playwright:8931）不受影响。
  ctx.effect(() => createCompanionDisposer({
    supervisor,
    adapters: [
      { name: 'rail12306', close: () => rail.close() },
      { name: 'xhs', close: () => xhs.close() },
      { name: 'social-playwright', close: () => playwright.close() },
      { name: 'didi', close: () => didi.close() },
      { name: 'zhihu', close: () => zhihu.close() },
    ],
  }), 'dsh-travel: companion supervisor 停止 + MCP 会话收尾')

  // W6 设置页 v1：settings 命名空间 travel 三组注册（§10.1；ADR-12 settings 位
  // 唯一真源=src/adapters/env.ts makeKeyEnv——W3/W4/W5 工具执行时热读取）。
  // settings 服务缺省时静默跳过（Key 链回落 credentials→env，行为不变）。
  registerTravelSettings(ctx)
}