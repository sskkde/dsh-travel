/**
 * travel_render_page —— 行程页渲染交付（M1 T5/Wα Leaflet-only 基线 → T8/W5 双 loader 完整化）。
 *
 * - 渲染：render.renderItineraryPage —— Itinerary/Intel/Request（+可选 transport/advice）
 *   → 自包含 page.html（数据 JSON 内嵌 + 双 loader：amap JSAPI 2.0 方案 A/B / Leaflet 1.9
 *   + OSM；GCJ-02↔WGS-84 页面内转换）
 * - mapProvider（auto|amap|leaflet）：makeKeyEnv 热读判定（ADR-12 唯一真源）——
 *   auto= 有 amap key+jscode（且 settings mapAmap 开）→ amap 否则 leaflet；
 *   settings mapAmap/mapLeaflet 开关走 channelEnabled 语义；缺 key/jscode → 自动降级
 *   Leaflet + warning（§2.1 FR-7 零 key 行）；amapSecurityMode（advanced.amapSecurityMode）
 *   热读，B 模式 jscode 仅由 `/_AMapService` 服务端代理注入。
 * - 路由：`ctx.webServer.register({kind:'prefix', path:'/travel-plans/<planId>'})`
 *   **幂等注册**——同 planId 重复调用不重复注册/无报错（registrar 内判重；
 *   宿主重复注册本会抛错，见 spike-webserver）
 * - 双通道：① webserver 路由 URL；② 本地文件 filePath（离线打开）
 * - 依赖缺失（itinerary.json 缺失等）→ 结构化 {rendered:false} + warnings[]，
 *   不写 page.html、不注册路由（§9.3-6 不生成空行程页）
 */
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { channelEnabled, resolveKey, type KeyResolutionEnv } from '../adapters/base.js'
import { makeKeyEnv, type MakeKeyEnvHost } from '../adapters/env.js'
import { TravelStore } from '../store/store.js'
import { planFilePath } from '../store/paths.js'
import { assertTransition } from '../store/state.js'
import {
  renderItineraryPage, buildRenderData, type AmapSecurityMode, type PageMapConfig, type PageMapProvider,
} from '../render/render.js'
import {
  AMAP_SECURITY_CAPABILITY_COOKIE, AMAP_SECURITY_CAPABILITY_TTL_MS, AMAP_SECURITY_PROXY_PATH,
  makeAmapSecurityProxyHandler, type AmapSecurityCapability,
} from '../render/route-registrar.js'
import { cardLines, losslessJson, textCard } from './common.js'
import { TravelValidationError } from '../errors.js'

/** 薄版默认超时（§6：render 30s）。 */
export const RENDER_TIMEOUT_MS = 30_000

/** 路由注册端口（service 可能未就绪/测试替身；结构最小契约，不依赖宿主包类型）。 */
export interface RouteRegistrarPort {
  /** 监听地址（拼 URL 用）。 */
  readonly host: string
  /** 监听端口（拼 URL 用）。 */
  readonly port: number
  /** 注册 prefix 路由；同 (kind,path) 重复调用必须无副作用（幂等）。 */
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
}

/** 领域参数。 */
export interface RenderPageArgs {
  planId: string
  mapProvider?: 'auto' | 'amap' | 'leaflet'
}

/** 工具返回（§6 行 523）。 */
export interface RenderPageResult {
  url: string
  filePath: string
  mapProviderUsed: 'leaflet' | 'amap'
  warnings: string[]
  /** false = 依赖缺失未渲染（url/filePath 为空）。 */
  rendered: boolean
}

const RENDER_PARAMETERS = {
  planId: {
    type: 'string',
    required: true,
    description: '计划 ID（必填；须已有 itinerary.json）',
  } as const,
  mapProvider: {
    type: 'string',
    enum: ['auto', 'amap', 'leaflet'],
    description: '地图引擎（auto=有 amap key+jscode→amap 否则 leaflet；显式 amap 缺 key/jscode 自动降级 leaflet；settings mapAmap/mapLeaflet 开关走 channelEnabled 语义）',
  } as const,
} as const

type RenderParams = InferArgs<typeof RENDER_PARAMETERS>

export const RENDER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    filePath: { type: 'string', required: true },
    mapProviderUsed: { type: 'string', enum: ['leaflet', 'amap'], required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
    rendered: { type: 'boolean', required: true },
  },
} as const

type RenderOutput = InferValue<typeof RENDER_OUTPUT_SCHEMA>

/** 生成前缀路由 path（§8：/travel-plans/<planId>）。 */
export function travelPlanRoutePath(planId: string): string {
  return `/travel-plans/${planId}`
}

/**
 * B 模式 capability 持久化（store 根 `.amap-capability.json`，插件级非 plan 级）：
 * 代理 handler 与页面 handler 都经动态读取取 token——同 planId 幂等重渲染与进程
 * 重启后旧页面仍可用（同 token 复用）；过期由下次 B 渲染重新生成。文件仅含随机
 * token 与到期时间戳，非敏感（能力凭证，泄露面=本机文件）。
 */
export const AMAP_CAPABILITY_FILE = '.amap-capability.json'

async function readAmapCapability(root: string): Promise<AmapSecurityCapability | undefined> {
  try {
    const raw = JSON.parse(await readFile(`${root}/${AMAP_CAPABILITY_FILE}`, 'utf8')) as Partial<AmapSecurityCapability>
    if (typeof raw.token !== 'string' || raw.token.length === 0) return undefined
    if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)) return undefined
    return { token: raw.token, expiresAt: raw.expiresAt }
  } catch {
    return undefined
  }
}

/** 读或生成 capability：未过期复用；缺失/过期重新生成并落盘。 */
export async function ensureAmapCapability(root: string): Promise<AmapSecurityCapability> {
  const existing = await readAmapCapability(root)
  if (existing !== undefined && Date.now() < existing.expiresAt) return existing
  const fresh: AmapSecurityCapability = {
    token: randomBytes(24).toString('hex'),
    expiresAt: Date.now() + AMAP_SECURITY_CAPABILITY_TTL_MS,
  }
  await writeFile(`${root}/${AMAP_CAPABILITY_FILE}`, JSON.stringify(fresh), { encoding: 'utf8', mode: 0o600 })
  return fresh
}

/** 页面响应的 capability Set-Cookie 值（仅 Path=/_AMapService 域内发送；HttpOnly）。 */
export function amapCapabilitySetCookie(capability: AmapSecurityCapability): string {
  const maxAge = Math.max(0, Math.floor((capability.expiresAt - Date.now()) / 1000))
  return `${AMAP_SECURITY_CAPABILITY_COOKIE}=${capability.token}; HttpOnly; Path=${AMAP_SECURITY_PROXY_PATH}; Max-Age=${maxAge}; SameSite=Lax`
}

/** 路由 handler：读 page.html 返回（子路径一并送达；文件缺失 → 404）。
 * capabilityCookieProvider（B 模式）在页面响应上下发代理能力 cookie。 */
export function makePageHandler(
  store: TravelStore,
  planId: string,
  capabilityCookieProvider?: () => Promise<string | undefined>,
) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pagePath = planFilePath(store.root, planId, 'page.html')
    try {
      const html = await readFile(pagePath, 'utf8')
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
      const setCookie = await capabilityCookieProvider?.()
      if (setCookie !== undefined) headers['set-cookie'] = setCookie
      res.writeHead(200, headers)
      res.end(html)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('page.html not found（行程页未渲染或计划目录缺失）')
    }
  }
}

export interface MapProviderSelection {
  provider: PageMapProvider
  /** amap 安全密钥模式（advanced.amapSecurityMode，缺省 A）。 */
  amapSecurityMode: AmapSecurityMode
  /** amap Web 端 JSAPI key（仅 provider=amap 时有值）。 */
  amapKey?: string
  /** 服务端解析的安全密钥；B 模式不会复制进 PageMapConfig/HTML。 */
  amapJscode?: string
  warnings: string[]
}

/**
 * 地图引擎选择（design §8 双 loader + §2.1 FR-7 零 key 行；makeKeyEnv 热读判定）。
 *
 * 语义（settings mapAmap/mapLeaflet 走 channelEnabled）：
 * - amap 可用 = settings 开关 mapAmap 开 **且** amapJsapi 与 amapJscode 两 key 都配置（resolveKey 三段链）
 * - leaflet 可用 = settings 开关 mapLeaflet 开
 * - 显式 leaflet → mapLeaflet 停用且 amap 可用 → 改用 amap+warning；否则 leaflet
 * - 显式 amap / auto → amap 可用即 amap；否则降级 leaflet + 说明 warning（缺 key/jscode/开关停用）
 * - 渲染必须成功兜底：两开关全停/全缺 key 时仍以 leaflet 渲染并 warning
 */
export function selectAmapSecurityMode(env?: KeyResolutionEnv): AmapSecurityMode {
  return env?.readSettings?.('advanced.amapSecurityMode')?.trim().toUpperCase() === 'B' ? 'B' : 'A'
}

export async function selectMapProvider(
  requested: 'auto' | 'amap' | 'leaflet',
  env: KeyResolutionEnv,
): Promise<MapProviderSelection> {
  const warnings: string[] = []
  const amapSecurityMode = selectAmapSecurityMode(env)
  const amapChannelOn = channelEnabled('mapAmap', env)
  const leafletChannelOn = channelEnabled('mapLeaflet', env)
  const amapKey = (await resolveKey('amapJsapi', env))?.value
  const amapJscode = (await resolveKey('amapJscode', env))?.value
  const amapReady = amapChannelOn && amapKey !== undefined && amapJscode !== undefined

  if (requested === 'leaflet') {
    if (leafletChannelOn) return { provider: 'leaflet', amapSecurityMode, warnings }
    if (amapReady) {
      warnings.push('mapLeaflet 已停用（用户配置），改用 amap 渲染')
      return { provider: 'amap', amapSecurityMode, amapKey, amapJscode, warnings }
    }
    warnings.push('mapLeaflet 已停用（用户配置），仍以 Leaflet 渲染')
    return { provider: 'leaflet', amapSecurityMode, warnings }
  }

  if (requested === 'amap') {
    if (amapReady) return { provider: 'amap', amapSecurityMode, amapKey, amapJscode, warnings }
    if (!amapChannelOn) warnings.push('mapAmap 已停用（用户配置），自动降级 Leaflet')
    else if (amapKey === undefined) warnings.push('amap JSAPI key 未配置（零 key 流），自动降级 Leaflet')
    else warnings.push('amap 安全密钥（jscode）未配置，自动降级 Leaflet')
    return { provider: 'leaflet', amapSecurityMode, warnings }
  }

  // auto：有 amap key+jscode → amap；否则 Leaflet（warning 明示降级原因）
  if (amapReady) return { provider: 'amap', amapSecurityMode, amapKey, amapJscode, warnings }
  if (!amapChannelOn) warnings.push('mapAmap 已停用（用户配置），地图使用 Leaflet')
  else if (amapKey === undefined) warnings.push('amap JSAPI key 未配置（零 key 流），地图自动降级 Leaflet')
  else warnings.push('amap 安全密钥（jscode）未配置，地图自动降级 Leaflet')
  return { provider: 'leaflet', amapSecurityMode, warnings }
}

/** 纯逻辑（测试直调；registrar 注入便于隔离；keyEnv 缺省空环境=零 key 流）。 */
export async function runRenderPage(
  args: RenderPageArgs,
  store: TravelStore,
  registrar: RouteRegistrarPort,
  keyEnv?: KeyResolutionEnv,
): Promise<RenderPageResult> {
  const warnings: string[] = []

  // 地图引擎：makeKeyEnv 热读判定（缺 key/jscode → 自动降级 Leaflet + warning）
  const requested = args.mapProvider ?? 'auto'
  const selection = await selectMapProvider(requested, keyEnv ?? {})
  const mapProviderUsed = selection.provider
  warnings.push(...selection.warnings)

  const request = await store.loadRequest(args.planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
  }

  // 依赖预检（只读，先于状态机与写盘）：itinerary 缺失 → 结构化报告，
  // 不写 page.html、不注册路由、不推进状态（§9.3-6 全失败链路：research 空 → build built:false → 此处 rendered:false）
  const precheck = await buildRenderData(store, args.planId)
  if (precheck.data === undefined) {
    const reason = precheck.reason ?? '渲染数据缺失'
    warnings.push(reason)
    return { url: '', filePath: '', mapProviderUsed, warnings, rendered: false }
  }

  // 状态机 + 渲染写盘 + 请求推进：计划级在途锁内串行化（C5④）。渲染写路径与
  // 其他计划级写操作（build/resolve/route-transport 等 likewise withPlanLock）互斥，
  // 避免 page.html 与请求状态在并发写中交错；请求状态推进用锁内最新快照（不拿
  // 渲染前读取的旧 request 覆盖并发更新——「当前快照而非陈旧快照」）。
  const mapConfig: PageMapConfig = {
    provider: selection.provider,
    warnings: [...selection.warnings],
  }
  if (selection.provider === 'amap') {
    mapConfig.amapKey = selection.amapKey
    mapConfig.amapSecurityMode = selection.amapSecurityMode
    if (selection.amapSecurityMode === 'A') {
      mapConfig.amapJscode = selection.amapJscode
    } else {
      mapConfig.serviceHost = `http://${registrar.host}:${registrar.port}${AMAP_SECURITY_PROXY_PATH}`
    }
  }

  type RenderLocked =
    | { ok: true; outcome: Extract<Awaited<ReturnType<typeof renderItineraryPage>>, { ok: true }> }
    | { ok: false; reason: string }
  const locked: RenderLocked = await store.withPlanLock(args.planId, async () => {
    // 锁内重新载入请求（渲染期间并发更新不被旧快照覆盖）
    const freshRequest = await store.loadRequest(args.planId)
    if (freshRequest === undefined) {
      throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
    }
    // 状态机：生成/交付态可渲染（researching→delivered 非法；delivered self 幂等重渲染）。
    // 先于写盘断言：非法转换不留下半成品 page.html
    assertTransition(freshRequest.status, 'delivered')

    // 渲染写盘（依赖已确认存在；同类文件缺失时按 ok:false 兜底；map 配置注入页面）
    // W6 故障矩阵补强：本地文件通道失败（磁盘/权限）→ 结构化失败 + 人话原因 + 重试
    // 入口（§9.3-6），不向工具层抛裸异常——design §2.1 FR-7 双通道均败的最后出口。
    let outcome: Awaited<ReturnType<typeof renderItineraryPage>>
    try {
      outcome = await renderItineraryPage(store, args.planId, mapConfig)
    } catch (error) {
      return { ok: false, reason: `页面写盘失败（本地文件通道不可用）：${error instanceof Error ? error.message : String(error)}；请检查磁盘/权限后重试 travel_render_page` }
    }
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason ?? '渲染数据缺失' }
    }

    const now = new Date().toISOString()
    await store.saveRequest({ ...freshRequest, status: 'delivered', updatedAt: now })
    return { ok: true, outcome }
  })
  if (!locked.ok) {
    warnings.push(locked.reason)
    return { url: '', filePath: '', mapProviderUsed, warnings, rendered: false }
  }
  const outcome = locked.outcome

  // B 模式先挂安全代理（registrar 幂等：固定 _AMapService path 只注册一次）。
  // handler 每次请求重新解析 AMAP_JSCODE，设置/credentials 热更新无需重启；
  // capability/限流/超时/响应帽经动态读取与默认值生效（重渲染/重启后 token 复用一致）。
  // W6 补强：代理注册失败 → warning 记账不阻塞（页面路由与本地文件交付继续）。
  if (selection.provider === 'amap' && selection.amapSecurityMode === 'B') {
    await ensureAmapCapability(store.root)
    try {
      registrar.register({
        kind: 'prefix',
        path: AMAP_SECURITY_PROXY_PATH,
        handler: makeAmapSecurityProxyHandler({
          keyEnv: keyEnv ?? {},
          // capability 每次请求动态读盘：缺失/过期 → 403（下次 B 渲染重新生成）。
          capability: () => readAmapCapability(store.root),
        }),
      })
    } catch (error) {
      warnings.push(`高德安全代理路由注册失败（B 模式代理不可用，页面照常交付）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 行程页前缀路由注册（registrar 幂等：同 planId 重复调用无副作用）。
  // B 模式页面响应下发 capability cookie（Path 限代理域内）。
  // W6 补强（design §2.1 FR-7 页面交付降级链）：路由注册失败（webserver 通道不可
  // 用）→ warning 记账，本地文件交付仍可用（rendered:true + filePath），流程不中断。
  const routePath = travelPlanRoutePath(args.planId)
  const capabilityCookieProvider = selection.provider === 'amap' && selection.amapSecurityMode === 'B'
    ? async (): Promise<string | undefined> => {
        const capability = await readAmapCapability(store.root)
        return capability === undefined ? undefined : amapCapabilitySetCookie(capability)
      }
    : undefined
  let url = ''
  try {
    registrar.register({ kind: 'prefix', path: routePath, handler: makePageHandler(store, args.planId, capabilityCookieProvider) })
    url = `http://${registrar.host}:${registrar.port}${routePath}/`
  } catch (error) {
    warnings.push(`在线路由注册失败（webserver 通道不可用，本地文件交付仍可用）：${error instanceof Error ? error.message : String(error)}`)
  }

  const degraded = (await store.loadDegraded(args.planId)) ?? []
  if (degraded.length > 0) {
    warnings.push(`本次规划含 ${degraded.length} 条降级记录（见行程页底部与 travel_get_state）`)
  }
  return { url, filePath: outcome.filePath, mapProviderUsed, warnings, rendered: true }
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectRender(r: RenderPageResult): RenderOutput {
  return {
    url: r.url,
    filePath: r.filePath,
    mapProviderUsed: r.mapProviderUsed,
    warnings: [...r.warnings],
    rendered: r.rendered,
  }
}

function renderRender(args: RenderParams, value: RenderOutput): ContentBlock[] {
  if (!value.rendered) {
    return textCard(
      `**travel_render_page** · 未渲染\n${cardLines([
        ['planId', args.planId],
        ['说明', value.warnings.join('；') || '依赖缺失'],
        ['提示', '请先 travel_build_itinerary 生成行程；或全部检索失败时先重试 travel_research_destination'],
      ])}`,
    )
  }
  const lines: [string, string][] = [
    ['URL', value.url],
    ['文件', value.filePath],
    ['地图引擎', value.mapProviderUsed],
    ['降级/警告', value.warnings.length > 0 ? value.warnings.join('；') : '（无）'],
  ]
  return textCard(`**travel_render_page** · 行程页已交付\n${cardLines(lines)}`)
}

/** 工具定义工厂选项（store + 路由注册端口注入；ADR-12 热读判定）。 */
export interface TravelRenderPageToolOptions {
  /**
   * makeKeyEnv 宿主（ctx；production 传 ctx）——每次工具执行现造 `makeKeyEnv(ctx)` 热
   * env（N-9：装配期不再把一次性凭据快照注入 render；mapProvider 判定走**执行期** env，
   * 执行期 credentials 就绪即解析到 amap key）。测试直调 `runRenderPage`/`selectMapProvider`
   * 传自组 env，不经本工厂。
   */
  keyEnvHost?: MakeKeyEnvHost
  /** 备用静态 env（无 keyEnvHost 时；测试/兼容兜底，生产优先走执行期现造）。 */
  keyEnv?: KeyResolutionEnv
}

/** 工具定义工厂（store + 路由注册端口注入；index.ts 传 ctx.webServer 适配 + ctx 供执行期 makeKeyEnv 热读）。 */
export function createTravelRenderPageTool(
  store: TravelStore,
  registrar: RouteRegistrarPort,
  opts: TravelRenderPageToolOptions = {},
): ToolDefinition {
  return defineTool({
    name: 'travel_render_page',
    description: '渲染行程页为自包含单文件 HTML（数据 JSON 内嵌 + 双 loader：amap JSAPI 2.0 方案 A / Leaflet 1.9+OSM 自动降级，GCJ-02↔WGS-84 页面内转换）；写 page.html 并幂等注册 prefix 路由 /travel-plans/<planId>；返回可点 URL 与本地文件双通道。mapProvider=auto 时按 amap key+jscode 判定；缺 key/jscode 自动降级 Leaflet 并明示。itinerary 缺失时不生成空行程页。',
    parameters: RENDER_PARAMETERS,
    output: {
      schema: RENDER_OUTPUT_SCHEMA,
      render: renderRender,
    },
    timeoutMs: RENDER_TIMEOUT_MS,
    async execute(args) {
      // N-9：工具每次执行现造执行期 env（credentials/settings 热读取），不再使用装配期快照。
      const keyEnv = opts.keyEnvHost !== undefined ? makeKeyEnv(opts.keyEnvHost) : opts.keyEnv
      return losslessJson(projectRender(await runRenderPage({ planId: args.planId, mapProvider: args.mapProvider }, store, registrar, keyEnv)))
    },
  })
}