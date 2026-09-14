/**
 * render.ts —— Itinerary/Intel/Request（+可选 transport/advice）JSON → 自包含 HTML（M1 T5/Wα 加厚，T8/W5 完整化）。
 *
 * 交付形态（design §8）：单文件 HTML，数据 JSON 内嵌（`<script id="travel-data">`，
 * `</` 转义防 script 闭合）+ 双 loader（amap JSAPI 2.0 方案 A/B / Leaflet 1.9 + OSM 自动降级）
 * + 页面内 GCJ-02↔WGS-84 转换（腾讯/高德 REST 原生 GCJ-02 落盘；Leaflet/OSM 为 WGS-84，
 * amap JSAPI 原生 GCJ-02）。
 *
 * 模板文件：src/render/template.html（构建时经 build.sh 拷贝至 lib/render/，
 * 运行时以 import.meta.url 邻接解析，src/lib 两棵树同构可用）。
 *
 * W5 加厚点（本波实现）：amap 双 loader 分支（方案 A：key+jscode 明文注入；方案 B：
 * serviceHost 代理）、八区页面、transport/advice 可选注入（缺省卡片优雅隐藏）；登录态条目标注位
 * （M2 xhsMcp 挂载后启用）。
 *
 * M3.2 导出（T3/W2）：渲染时以同一 RenderPageData 生成导出 bundle（canonical JSON +
 * 固定章节 Markdown，src/export/itinerary-export.ts）并内嵌
 * `<script id="travel-export">`；页面头部「下载 JSON / 下载 Markdown / 打印/PDF」按钮
 * 逐字节取用该 bundle（下载不经二次序列化，与 embedded data 同源一致）。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactSensitiveText, redactSensitiveUrl } from '../adapters/search.js'
import type { Advice, CostArtifact, IntelItem, Itinerary, RentalQuoteEntry, RentalQuoteRecord, RentalQuotesArtifact, RenderRouteTransport, RouteTransportArtifact, RouteTransportLeg, TravelInsight, TransportOption, TravelRequest } from '../models/types.js'
import { TravelStore } from '../store/store.js'
import type { ArtifactReadState } from '../store/store.js'
import { planFilePath } from '../store/paths.js'
import type { DegradedEntry } from '../adapters/base.js'
import { buildExportBundle } from '../export/itinerary-export.js'
import { isValidRouteGeometry } from '../models/validate.js'

/** 地图引擎配置（render-page 工具决定 → 注入页内）。 */
export type PageMapProvider = 'leaflet' | 'amap'
export type AmapSecurityMode = 'A' | 'B'

export interface PageMapConfig {
  provider: PageMapProvider
  /** amap 安全密钥模式；缺省 A 以保持 M1 行为。 */
  amapSecurityMode?: AmapSecurityMode
  /** amap 方案 A：Web 端 JSAPI key（仅 provider=amap 时有值；经用户交割的 env/credentials 传入）。 */
  amapKey?: string
  /** amap 方案 A：安全密钥 jscode（B 模式严禁进入页内 JSON）。 */
  amapJscode?: string
  /** amap 方案 B：插件 webserver 的固定安全代理地址。 */
  serviceHost?: string
  /** 地图引擎降级/停用说明（页面 warning 条 + 工具 warnings[]）。 */
  warnings: string[]
}

/** 页面研究视图（W4 T16③：正文分级展示；不内嵌正文全文——正文经 read 工具分页）。 */
export interface PageResearchView {
  /** 条目 id → 分级（title=标题级 / fetched=已取正文 / partial=部分正文 / failed=抓取失败）。 */
  grades: Record<string, 'title' | 'fetched' | 'partial' | 'failed'>
  /** 当前 researchVersion（无研究状态时缺省）。 */
  researchVersion?: number
}

/** 页内嵌入数据（render.ts 装配 → template.html 注入）。 */
export interface RenderPageData {
  renderedAt: string
  request: TravelRequest
  itinerary: Itinerary
  /** intel 条目按 id 索引（弹窗/卡片溯源用）。 */
  intel: Record<string, IntelItem>
  degraded: DegradedEntry[]
  /** 交通方案（W3 transport.json；缺失 → 页面卡片隐藏）。 */
  transport?: TransportOption[]
  /** round3 路线旁车：逐段 legs（每 leg 可带 WGS84 geometry）与总计。 */
  routeTransport?: RenderRouteTransport
  /** round3 调用方归纳（页面不得回退展示 raw summary）。 */
  insights?: TravelInsight[]
  /** 路线总里程（km，保留对外单位）。 */
  totalDistanceKm?: number
  /** 路线总时长（分钟，保留对外单位）。 */
  totalDurationMinutes?: number
  /** 出行建议（W3 advice.json；缺失 → 页面卡片隐藏）。 */
  advice?: Advice
  /** B6 租车咨询（非实时/不可预订；缺失 → 页面卡片隐藏）。 */
  rentalQuotes?: RentalQuotesArtifact
  /** B6 成本摘要（缺失 → 页面卡片隐藏）。 */
  cost?: CostArtifact
  /** 地图引擎配置（双 loader 分支 + 降级 warning 条）。 */
  map: PageMapConfig
  /** 研究正文分级（W4 T16③；无研究状态 → 缺省空 map，页面不显示分级徽标）。 */
  research?: PageResearchView
  /**
   * 上游工件版本/健康度（C 期接线）：places/transport/route-transport/coverage/
   * lodging-quotes/advice 的当前版本与 readArtifactWithState 状态——页面与导出
   * 据此诚实展示（stale 旧数据 / failed 失败 / empty 零结果 / missing 缺失），
   * 不把旧版本当最新消费。
   */
  artifactStatus?: Record<string, { version: number; state: 'current' | 'stale' | 'unknown' | 'failed' | 'empty' | 'missing' }>
}

export type RenderOutcome =
  | { ok: true; filePath: string; html: string }
  | { ok: false; reason: string }

/**
 * 模板路径解析链（邻接 import.meta.url 为源码/lib 同构树主路径）：
 * 1. import.meta.url 邻接 template.html（src/render、lib/render、或将 bundle
 *    与模板同放的场景）
 * 2. 环境变量 DSH_TRAVEL_TEMPLATE 显式覆盖（demo 脚本 bundle 化的场景：
 *    esbuild 改变 import.meta.url 指向 .tmp/，由脚本显式指向源模板）
 */
const TEMPLATE_URL = new URL('./template.html', import.meta.url)

/** 读取模板；失败（未拷贝等）抛清晰错误（W5 将改为内置默认模板兜底）。 */
export function templatePath(): string {
  const envOverride = process.env['DSH_TRAVEL_TEMPLATE']
  if (envOverride !== undefined && envOverride.trim().length > 0) {
    return envOverride.trim()
  }
  return fileURLToPath(TEMPLATE_URL)
}

/**
 * degraded 条目脱敏（自由文本闸门）。
 *
 * reason 来自上游错误消息，最可能夹带带 userinfo / 敏感 query 的 URL；source/code/at
 * 同样是外部可注入的自由文本。**每个字段**都要过 redactSensitiveText：只清 reason
 * 会让凭据从 source/code 里溜进页面内嵌 JSON 与 __TRAVEL_DATA__。
 */
export function redactDegradedEntry<T extends DegradedEntry>(entry: T): T {
  return {
    ...entry,
    source: redactSensitiveText(entry.source),
    code: redactSensitiveText(entry.code),
    reason: redactSensitiveText(entry.reason),
    ...(typeof entry.at === 'string' ? { at: redactSensitiveText(entry.at) } : {}),
  }
}

/** 页面仍保留完整咨询卡片，但旧工件的 URL/文本也先过脱敏与结构闸门。 */
function safeRentalQuotesForPage(artifact: RentalQuotesArtifact): RentalQuotesArtifact {
  const quotes: RentalQuoteEntry[] = []
  for (const candidate of Array.isArray(artifact.quotes) ? artifact.quotes : []) {
    if (candidate === null || typeof candidate !== 'object') continue
    const entry = candidate as RentalQuoteEntry
    if (entry.quote === null || typeof entry.quote !== 'object' || entry.source === null || typeof entry.source !== 'object') continue
    quotes.push({
      ...entry,
      pickupPlaceId: redactSensitiveText(entry.pickupPlaceId),
      ...(entry.dropoffPlaceId !== undefined ? { dropoffPlaceId: redactSensitiveText(entry.dropoffPlaceId) } : {}),
      vehicleType: redactSensitiveText(entry.vehicleType),
      quote: {
        ...entry.quote,
        ...(entry.quote.referenceUrl !== undefined ? { referenceUrl: redactSensitiveUrl(entry.quote.referenceUrl) } : {}),
      },
      source: { ...entry.source, platform: redactSensitiveText(entry.source.platform), url: redactSensitiveUrl(entry.source.url) },
    })
  }
  const records: RentalQuoteRecord[] = []
  for (const candidate of Array.isArray(artifact.records) ? artifact.records : []) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as RentalQuoteRecord
    records.push({
      ...record,
      ...(record.pickupPlaceId !== undefined ? { pickupPlaceId: redactSensitiveText(record.pickupPlaceId) } : {}),
      ...(record.dropoffPlaceId !== undefined ? { dropoffPlaceId: redactSensitiveText(record.dropoffPlaceId) } : {}),
      ...(record.reason !== undefined ? { reason: redactSensitiveText(record.reason) } : {}),
    })
  }
  // 旧工件（本仓库改名/更早版本产出的 rental-quotes.json）可能**没有** degraded
  // 字段或它不是数组：`...(artifact)` 会把原值原样带进页内 JSON，自由文本里的
  // 凭据就绕过了上面的逐条脱敏。
  const artifactDegraded = Array.isArray(artifact.degraded) ? artifact.degraded : []
  const degraded = artifactDegraded
    .filter((entry): entry is DegradedEntry => entry !== null && typeof entry === 'object')
    .map((entry) => redactDegradedEntry(entry))
  return {
    ...artifact,
    quotes,
    records,
    degraded,
    disclaimer: redactSensitiveText(typeof artifact.disclaimer === 'string' ? artifact.disclaimer : '租车信息为咨询级、非实时、不可预订'),
  }
}

/** route-transport → 页面消费面；只有完整指标才发布总计，不把缺段当零。 */
function routeTransportForPage(
  artifact: RouteTransportArtifact,
  itinerary: Itinerary,
): RenderRouteTransport | undefined {
  const fingerprint = itinerary.canonicalRoute?.fingerprint
  if (fingerprint !== undefined && artifact.inputFingerprint !== fingerprint) return undefined
  const rawLegs = Array.isArray(artifact.legs) ? artifact.legs : []
  const legs: RouteTransportLeg[] = rawLegs
    .filter((leg): leg is RouteTransportLeg => leg !== undefined && typeof leg === 'object')
    .map((leg) => {
      if (leg.geometry === undefined || isValidRouteGeometry(leg.geometry)) return leg
      const { geometry: _geometry, ...withoutGeometry } = leg
      return withoutGeometry
    })
  const usable = legs.length > 0 && legs.every((leg) => (leg.metricStatus ?? leg.status) !== 'blocked'
    && (leg.metricStatus ?? leg.status) !== 'unavailable'
    && typeof leg.distanceKm === 'number' && Number.isFinite(leg.distanceKm)
    && typeof leg.durationMinutes === 'number' && Number.isFinite(leg.durationMinutes))
  const stored = artifact as RouteTransportArtifact & { totalDistanceKm?: number; totalDurationMinutes?: number }
  const totalDistanceKm = typeof stored.totalDistanceKm === 'number' && Number.isFinite(stored.totalDistanceKm)
    ? stored.totalDistanceKm
    : usable ? Math.round(legs.reduce((sum, leg) => sum + (leg.distanceKm ?? 0), 0) * 10) / 10 : undefined
  const totalDurationMinutes = typeof stored.totalDurationMinutes === 'number' && Number.isFinite(stored.totalDurationMinutes)
    ? stored.totalDurationMinutes
    : usable ? Math.round(legs.reduce((sum, leg) => sum + (leg.durationMinutes ?? 0), 0)) : undefined
  const geometry = legs.flatMap((leg) => leg.geometry === undefined ? [] : [leg.geometry])
  return {
    legs,
    ...(geometry.length > 0 ? { geometry } : {}),
    ...(totalDistanceKm !== undefined ? { totalDistanceKm } : {}),
    ...(totalDurationMinutes !== undefined ? { totalDurationMinutes } : {}),
    fingerprint: artifact.inputFingerprint,
  }
}

/**
 * 消费门（round3 仲裁口径）：`unknown`（未入账/版本不可知）＝**只读兼容**，
 * 数据照常可读并进入页面，但由 collectArtifactStatus 如实投影为 unknown（不伪造 current）。
 * 仅「失败 / 空 / 内容 hash 不符（篡改或半写）/ 缺失」才拒绝消费 —— 这四类无法验证完整性，
 * 渲染它们等于把不可信数据当最新交付。legacy 无 manifest 的旧文件按 current 兼容读取。
 */
function consumable<T>(state: ArtifactReadState<T>, name?: string): T | undefined {
  if (name !== undefined && isSignedArtifactTamper(name, state)) return undefined
  if (state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'missing' || !state.found) return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

/** 现代 manifest 明确声明正在提交某 stage，却没有把该文件纳入提交时，拒绝复活。 */
function isSignedArtifactTamper<T>(name: string, state: ArtifactReadState<T>): boolean {
  const ownStage: Record<string, string> = {
    'itinerary.json': 'itinerary',
    'places.json': 'places',
    'transport.json': 'transport',
    'advice.json': 'advice',
    'rental-quotes.json': 'rental-quotes',
    'route-transport.json': 'route-transport',
    'route-coverage.json': 'coverage',
    'insights.json': 'insights',
  }
  return (state.status === 'unknown' || state.status === 'stale')
    && (state.staleReason === 'unaccounted' || state.staleReason === 'not_in_commit')
    && state.meta?.stage !== undefined
    && ownStage[name] === state.meta.stage
}

/** 未入账/仅依赖版本过期的数据可读，但页面必须留下显式降级证据。 */
function artifactReadWarning<T>(name: string, state: ArtifactReadState<T>): DegradedEntry | undefined {
  if (state.data === undefined || state.status === 'current') return undefined
  if (isSignedArtifactTamper(name, state)) {
    return { source: `artifact:${name}`, code: 'STALE', reason: `${name} 的 manifest stage 签名与未入账文件冲突，已阻断消费`, at: new Date().toISOString() }
  }
  if (state.status === 'unknown') {
    return { source: `artifact:${name}`, code: 'STALE', reason: `${name} 未入账或版本未知（unknown），仅按只读兼容消费`, at: new Date().toISOString() }
  }
  if (state.status === 'stale' && state.staleReason !== 'hash_mismatch') {
    return { source: `artifact:${name}`, code: 'STALE', reason: `${name} 依赖版本已变化（${state.staleReason ?? 'stale'}），页面仅作兼容读取`, at: new Date().toISOString() }
  }
  return undefined
}

/** 组装渲染数据：
 * - itinerary.json 缺失/为空 → {ok:false}（不写 page.html——§9.3-6 不产空页）
 * - intel.json 可选（缺失 → 空 map，页面卡片自动隐藏）
 * - transport.json / advice.json 可选（W3 产物；缺失 → 页面卡片自动隐藏）
 * - map：地图引擎配置（缺省 Leaflet 零 key；amap 需 render-page 工具判定 key/jscode）
 */
export async function buildRenderData(
  store: TravelStore,
  planId: string,
  map?: PageMapConfig,
): Promise<{ data?: RenderPageData; reason?: string }> {
  const request = await store.loadRequest(planId)
  if (request === undefined) {
    return { reason: `计划 ${planId} 不存在：请先 travel_intake 创建` }
  }
  const itineraryState = await store.readArtifactWithState<Itinerary>(planId, 'itinerary.json')
  const itinerary = consumable(itineraryState, 'itinerary.json')
  if (itinerary === undefined || itinerary.days.length === 0) {
    return { reason: 'itinerary.json 缺失、未入账或为空：请先 travel_build_itinerary 生成行程（不生成空行程页）' }
  }
  const intelState = await store.readArtifactWithState<IntelItem[]>(planId, 'intel.json')
  const intelData = consumable(intelState, 'intel.json')
  const intel = Array.isArray(intelData) ? intelData : []
  const intelMap: Record<string, IntelItem> = {}
  for (const item of intel) {
    if (item && typeof item.id === 'string') {
      // Page data is an index, not a raw-content transport. Keep hard fields and
      // source identity for attribution, but never embed social/raw summaries or
      // ContentTrace bodies into page.html.
      const { content: _content, ...withoutContent } = item
      intelMap[item.id] = { ...withoutContent, summary: '' }
    }
  }
  // 顶层降级记账同样是外部自由文本（上游错误消息），进页面内嵌数据前逐条脱敏。
  const degraded = ((await store.loadDegraded(planId)) ?? []).map((entry) => redactDegradedEntry(entry))
  const transportState = await store.readArtifactWithState<TransportOption[]>(planId, 'transport.json')
  const transport = consumable(transportState, 'transport.json')
  const adviceState = await store.readArtifactWithState<Advice>(planId, 'advice.json')
  const advice = consumable(adviceState, 'advice.json')
  const rentalState = await store.readArtifactWithState<RentalQuotesArtifact>(planId, 'rental-quotes.json')
  const rentalQuotesRaw = consumable(rentalState, 'rental-quotes.json')
  const rentalQuotes = rentalQuotesRaw === undefined ? undefined : safeRentalQuotesForPage(rentalQuotesRaw)
  const costState = await store.readArtifactWithState<CostArtifact>(planId, 'cost.json')
  const cost = consumable(costState, 'cost.json')
  const routeTransportState = await store.readArtifactWithState<RouteTransportArtifact>(planId, 'route-transport.json')
  const routeTransportRaw = consumable(routeTransportState, 'route-transport.json')
  const routeTransport = routeTransportRaw === undefined ? undefined : routeTransportForPage(routeTransportRaw, itinerary)
  const insightsState = await store.readArtifactWithState<TravelInsight[]>(planId, 'insights.json')
  const insightsData = consumable(insightsState, 'insights.json')
  const insights = Array.isArray(insightsData) ? insightsData : undefined
  const research = await buildPageResearchView(store, planId)
  const artifactStatus = await collectArtifactStatus(store, planId)
  const artifactWarnings = [
    artifactReadWarning('itinerary.json', itineraryState),
    artifactReadWarning('intel.json', intelState),
    artifactReadWarning('transport.json', transportState),
    artifactReadWarning('advice.json', adviceState),
    artifactReadWarning('rental-quotes.json', rentalState),
    artifactReadWarning('cost.json', costState),
    artifactReadWarning('route-transport.json', routeTransportState),
    artifactReadWarning('insights.json', insightsState),
  ].filter((entry): entry is DegradedEntry => entry !== undefined)
  const degradedWithReadWarnings = [...degraded, ...artifactWarnings]
  return {
    data: {
      renderedAt: new Date().toISOString(),
      request,
      itinerary,
      intel: intelMap,
      degraded: degradedWithReadWarnings,
      map: map ?? { provider: 'leaflet', warnings: [] },
      // 条件展开：缺失字段不落 undefined（JSON 往返丢键；页面端 shows 缺失 → 卡片隐藏）
       ...(transport !== undefined ? { transport } : {}),
       ...(routeTransport !== undefined ? {
         routeTransport,
         ...(routeTransport.totalDistanceKm !== undefined ? { totalDistanceKm: routeTransport.totalDistanceKm } : {}),
         ...(routeTransport.totalDurationMinutes !== undefined ? { totalDurationMinutes: routeTransport.totalDurationMinutes } : {}),
       } : {}),
       ...(insights !== undefined ? { insights } : {}),
       ...(advice !== undefined ? { advice } : {}),
       ...(rentalQuotes !== undefined ? { rentalQuotes } : {}),
       ...(cost !== undefined ? { cost } : {}),
       ...(research !== undefined ? { research } : {}),
       ...(artifactStatus !== undefined ? { artifactStatus } : {}),
    },
  }
}

/**
 * 上游工件版本/健康度（C 期/C5③）：对全部产物工件做带状态读取并汇总。
 * - 账本键（ARTIFACT_VERSION_KEYS：intel/research/places/transport/advice/quotes）为权威
 *   版本源；文件→键映射修正：places/transport/advice/intel 直读、research 读 research-state、
 *   lodging-quotes → 账本 quotes；rental-quotes/cost → 独立账本 rental/cost。
 * - 非账本站（route-transport/coverage）：无账本版本，版本取工件自身 inputs
 *   （placesVersion）诚实标注（不冒充账本 0/缺失），状态由 readArtifactWithState 如实投影
 *   （stale/unknown/failed/empty/missing 均不冒充 current）。
 * 读取本身不校验 hash 失败（readArtifactWithState 负责）——这里如实投影状态。
 */
async function collectArtifactStatus(
  store: TravelStore,
  planId: string,
): Promise<Record<string, { version: number; state: 'current' | 'stale' | 'unknown' | 'failed' | 'empty' | 'missing' }> | undefined> {
  const versions = await store.loadVersions(planId)
  const out: Record<string, { version: number; state: 'current' | 'stale' | 'unknown' | 'failed' | 'empty' | 'missing' }> = {}

  const read = async (key: string, file: string, fallbackVersion?: number): Promise<void> => {
    const state = await store.readArtifactWithState<unknown>(planId, file)
    let s: 'current' | 'stale' | 'unknown' | 'failed' | 'empty' | 'missing'
    if (!state.found) s = 'missing'
    else if (state.status === 'failed') s = 'failed'
    else if (state.status === 'empty') s = 'empty'
    else if (state.status === 'stale') s = 'stale'
    else if (state.status === 'unknown') s = 'unknown'
    else s = 'current'
    const version = versions[key as keyof typeof versions] ?? fallbackVersion ?? 0
    out[key] = { version, state: s }
  }

  // 账本键（ARTIFACT_VERSION_KEYS 权威），含文件→键映射修正
  await read('itinerary', 'itinerary.json')
  await read('research', 'research-state.json')
  await read('intel', 'intel.json')
  await read('places', 'places.json')
  await read('transport', 'transport.json')
  await read('advice', 'advice.json')
  await read('insights', 'insights.json')
  await read('quotes', 'lodging-quotes.json')
  await read('rental', 'rental-quotes.json')
  await read('cost', 'cost.json')
  // 非账本站：文件用真实名（route-coverage.json 而非 coverage.json）；版本取工件自身 inputs
  const routeTransportState = await store.readArtifactWithState<{ placesVersion?: number }>(planId, 'route-transport.json')
  const coverageState = await store.readArtifactWithState<{ placesVersion?: number }>(planId, 'route-coverage.json')
  const routeTransportVersion = consumable(routeTransportState, 'route-transport.json')?.placesVersion
  const coverageVersion = consumable(coverageState, 'route-coverage.json')?.placesVersion
  await read('route-transport', 'route-transport.json', routeTransportVersion)
  await read('coverage', 'route-coverage.json', coverageVersion)
  return out
}

/**
 * 页面研究正文分级（W4 T16③）：从 research-state.itemIndex + 正文状态派生
 * 「标题级/已取正文/部分正文/失败」徽标映射；不读正文全文（页面零全文正文）。
 * 无 research-state → undefined（页面不显示分级）。
 */
async function buildPageResearchView(store: TravelStore, planId: string): Promise<PageResearchView | undefined> {
  const stateRead = await store.readArtifactWithState<{ researchVersion: number; itemIndex?: Array<{ itemId: string; contentRef?: string; contentVersion?: string }> }>(planId, 'research-state.json')
  const state = consumable(stateRead, 'research-state.json')
  if (state === undefined) return undefined
  const grades: Record<string, PageResearchView['grades'][string]> = {}
  for (const idx of state.itemIndex ?? []) {
    let grade: PageResearchView['grades'][string] = 'title' // 标题级（未取正文）
    if (idx.contentRef !== undefined && idx.contentVersion !== undefined) {
      const content = await store.readResearchContent<{ contentStatus?: string; truncated?: boolean }>(
        planId, idx.contentRef, idx.contentVersion,
      )
      if (content?.contentStatus === 'extracted') grade = content.truncated === true ? 'partial' : 'fetched'
      else if (content?.contentStatus === 'partial') grade = 'partial'
      else if (content?.contentStatus === 'unavailable') grade = 'failed'
    }
    grades[idx.itemId] = grade
  }
  return { grades, researchVersion: state.researchVersion }
}

/**
 * T6 页面 bundle/CSS 资产：源码树与 lib 树保持同构，模板始终邻接最终 bundle。
 * Vitest/源码直渲时优先读 src/render/page.bundle.js；发布后读 lib/render/page.bundle.js。
 * 缺失时保留一个可审计的降级脚本，真实构建由 scripts/build.sh 闸门阻断。
 */
function readPageAsset(relative: string, fallback: string): string {
  const candidates = [
    join(dirname(templatePath()), relative),
    fileURLToPath(new URL(`./${relative}`, import.meta.url)),
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      // 继续尝试源码/lib 的另一棵同构树。
    }
  }
  return fallback
}

const FALLBACK_PAGE_BUNDLE = `(() => {
  function gcj02ToWgs84(lng, lat) { return { lng: lng, lat: lat }; }
  function renderRouteTransport() { return undefined; }
  function activateDay() { return undefined; }
  document.body.dataset.mapReady = 'fallback';
})();`

const FALLBACK_PAGE_STYLES = `body{margin:0;font-family:sans-serif}.mobile-drawer{display:block}@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto!important}}`

function pageCspPolicy(style: string, script: string): string {
  const styleHash = createHash('sha256').update(style, 'utf8').digest('base64')
  const scriptHash = createHash('sha256').update(script, 'utf8').digest('base64')
  // SDK/地图域逐个列出；仅使用最终 bundle/style hash，不放开任意远端脚本或样式。
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `script-src 'self' 'sha256-${scriptHash}' https://webapi.amap.com https://unpkg.com`,
    `style-src 'self' 'sha256-${styleHash}' https://webapi.amap.com https://unpkg.com`,
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://webapi.amap.com",
    "connect-src 'self' https://webapi.amap.com https://restapi.amap.com https://tile.openstreetmap.org",
    "worker-src 'self' blob:",
  ].join('; ')
}

/** 数据 → 自包含 HTML（模板 + JSON 内嵌；`</` 转义防 script 闭合 + 同源导出 bundle 内嵌）。 */
export function renderWithTemplate(data: RenderPageData, template: string): string {
  const title = `${data.itinerary.days.length} 日 · ${data.request.slots.destination ?? '旅行'}`
  const safeTitle = title.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
  // 顶层降级记账无条件重脱敏：renderWithTemplate 是公开/直接入口，调用方可能不经过
  // buildRenderData 就带着旧工件（或手工构造的数据）直渲。只清 rentalQuotes 会让顶层
  // degraded 的 source/code/reason/at 自由文本绕过闸门进 HTML 与 __TRAVEL_DATA__。
  const pageIntel: Record<string, IntelItem> = {}
  for (const [id, item] of Object.entries(data.intel ?? {})) {
    if (item === null || typeof item !== 'object') continue
    const { content: _content, ...withoutContent } = item
    pageIntel[id] = { ...withoutContent, summary: '' }
  }
  const pageData = { ...data, intel: pageIntel }
  const degradedSafeData = {
    ...pageData,
    degraded: (Array.isArray(pageData.degraded) ? pageData.degraded : [])
      .filter((entry): entry is DegradedEntry => entry !== null && typeof entry === 'object')
      .map((entry) => redactDegradedEntry(entry)),
  }
  const rentalSafeData = degradedSafeData.rentalQuotes === undefined
    ? degradedSafeData
    : { ...degradedSafeData, rentalQuotes: safeRentalQuotesForPage(degradedSafeData.rentalQuotes) }
  // B 模式的 jscode 只在服务端代理 handler 中解析；即使调用方误带该字段，
  // 也在进入 HTML 前剥离，形成产物级最后一道零明文闸门。
  const safeData = rentalSafeData.map?.amapSecurityMode === 'B'
    ? (() => {
        const { amapJscode: _serverOnlyJscode, ...safeMap } = rentalSafeData.map
        return { ...rentalSafeData, map: safeMap }
      })()
    : rentalSafeData
  const json = JSON.stringify(safeData).replace(/</g, '\\u003c')
  // M3.2 导出 bundle：与页面内嵌数据同源（同一 safeData）生成，页面下载按钮逐字节取用；
  // 导出面剔除 map（amapKey/jscode 随之排除），零 secret。
  const exportBlock = JSON.stringify(buildExportBundle(safeData)).replace(/</g, '\\u003c')
  const pageStyles = readPageAsset('page/styles.css', FALLBACK_PAGE_STYLES)
  const pageBundle = readPageAsset('page.bundle.js', FALLBACK_PAGE_BUNDLE)
  const csp = pageCspPolicy(pageStyles, pageBundle)
  // 单遍替换：占位符一次扫描全部展开，注入内容若含占位符字面量也不会被二次展开。
  return template.replace(/__PAGE_TITLE__|__TRAVEL_DATA__|__TRAVEL_EXPORT__|__PAGE_STYLES__|__PAGE_BUNDLE__|__CSP_POLICY__/g, (match) => {
    if (match === '__TRAVEL_DATA__') return json
    if (match === '__TRAVEL_EXPORT__') return exportBlock
    if (match === '__PAGE_STYLES__') return pageStyles
    if (match === '__PAGE_BUNDLE__') return pageBundle
    if (match === '__CSP_POLICY__') return csp
    return safeTitle
  })
}

/**
 * 端到端渲染：读产物 → 套模板 → 原子写 page.html。
 * map：地图引擎配置（render-page 工具传入；缺省 Leaflet 零 key）。
 * 任一步骤依赖缺失 → {ok:false}（不写任何空产物）。
 */
export async function renderItineraryPage(store: TravelStore, planId: string, map?: PageMapConfig): Promise<RenderOutcome> {
  const built = await buildRenderData(store, planId, map)
  if (built.data === undefined) {
    return { ok: false, reason: built.reason ?? '渲染数据缺失' }
  }
  let template: string
  try {
    template = await readFile(templatePath(), 'utf8')
  } catch (error) {
    return { ok: false, reason: `模板读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const html = renderWithTemplate(built.data, template)
  const filePath = planFilePath(store.root, planId, 'page.html')
  // 原子写：同目录 tmp + rename（与 store.writeJson 同策略）
  const tmp = join(store.planDir(planId), `.page.html.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
  await writeFile(tmp, html, 'utf8')
  await rename(tmp, filePath)
  return { ok: true, filePath, html }
}