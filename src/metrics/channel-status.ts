/**
 * dsh-travel 渠道三层状态只读同源路由（FR-3~FR-7）。
 *
 * 三层严格分离：
 * - config：settings snapshot + TRAVEL_CHANNEL_* env，经 channelEnabled() 判定；
 * - readiness：settings→credentials→env 的 Key 链、FlyAI 二进制与端点覆盖静态判定；
 * - runtime：只有显式 probe=health/full 时才执行，health 仅探 cheap-health，
 *   full 才允许消耗 AMap/Wendao 配额。
 *
 * 本模块不调用适配器 available()：部分 available() 实现包含真实 MCP ping，
 * 因而缺省请求可以保持严格零网络。响应只投影布尔/枚举/已脱敏 URL，绝不返回 secret。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeKeyEnv, type MakeKeyEnvHost } from '../adapters/env.js'
import { channelEnabled, resolveKey, type KeyResolutionEnv } from '../adapters/base.js'
import {
  DEFAULT_RAIL_MCP_URL,
  RAIL_MCP_URL_ENV,
  type Rail12306Adapter,
} from '../adapters/rail12306.js'
import {
  DEFAULT_XHS_MCP_URL,
  XHS_MCP_URL_ENV,
  type XhsAdapter,
} from '../adapters/xhs.js'
import {
  DEFAULT_PLAYWRIGHT_MCP_URL,
  PLAYWRIGHT_MCP_URL_ENV,
  type PlaywrightSocialAdapter,
} from '../adapters/social-playwright.js'
import {
  DEFAULT_DIDI_MCP_URL,
  DIDI_MCP_URL_ENV,
  type DidiAdapter,
} from '../adapters/didi.js'
import { WENDAO_ENDPOINT, WENDAO_ENDPOINT_ENV, type WendaoAdapter } from '../adapters/wendao.js'
import { AMAP_API_BASE, AMAP_JSAPI_BASE, AMAP_MONTHLY_QUOTA, type AmapAdapter } from '../adapters/amap.js'
import { DEFAULT_DIDAHOTEL_MCP_URL, DIDAHOTEL_MCP_URL_ENV } from '../adapters/dida-hotel.js'
import { OPEN_METEO_ENDPOINT, type OpenMeteoAdapter } from '../adapters/open-meteo.js'
import { ZHIHU_ENDPOINT, type ZhihuAdapter } from '../adapters/zhihu.js'
import { TENCENT_H5GW_BASE, type TencentMapAdapter } from '../adapters/tencent.js'
import { resolveFlyaiCommand, type FlyaiAdapter } from '../adapters/flyai.js'
import {
  COMPANION_MANIFESTS,
  type CompanionManifest,
  type CompanionServiceName,
} from '../lifecycle/manifests.js'
import { probeHealthOnce, type HealthFetchFn } from '../lifecycle/health.js'
import { metricsSourceAllowed, type TravelMetricsRouteOptions } from './usage.js'
import type { TravelSettings } from '../settings/schema.js'
import type { IntercityAdapter } from '../adapters/intercity.js'

/** channel-status 路由 path（exact；client 半以同字面量镜像）。 */
export const TRAVEL_CHANNEL_STATUS_PATH = '/travel-channel-status'
/** 响应 ns（= loader entry / settings 命名空间 dsh-travel）。 */
export const TRAVEL_CHANNEL_STATUS_NS = 'dsh-travel'

/** 渠道 id（顺序同时是设置页/响应稳定顺序）。 */
export const TRAVEL_CHANNEL_STATUS_IDS = [
  // FR-3
  'xhsMcp', 'xhsFallback', 'xhsCloak', 'didaHotel', 'douyin', 'tier2', 'tier3', 'socialL1', 'tencentPoi', 'platformIntel',
  // FR-4（八项均为强制覆盖）
  'rail12306', 'railWendao', 'railFlyai', 'flightWendao', 'flightFlyai', 'busConsult', 'cityAmap', 'cityDidi',
  // FR-5
  'weatherAmap', 'weatherTencent', 'weatherOpenMeteo', 'adviceSearch',
  // FR-6
  'routeCheckAmap', 'routeCheckTencent', 'travelGuideTencent',
  // FR-7
  'mapAmap', 'mapLeaflet', 'deliveryRoute', 'deliveryFile',
] as const
export type TravelChannelStatusId = (typeof TRAVEL_CHANNEL_STATUS_IDS)[number]

export type TravelChannelProbe = 'none' | 'health' | 'full'
export type TravelChannelReadinessState = 'ready' | 'missing-key' | 'missing-binary' | 'no-key-required'
export type TravelChannelRuntimeState = 'reachable' | 'unreachable' | 'not-probed' | 'not-applicable'

export interface TravelChannelStatusConfigEntry {
  enabled: boolean
}

export interface TravelChannelStatusReadinessEntry {
  state: TravelChannelReadinessState
  keyId?: string
  keyConfigured?: boolean
  /** Endpoint override environment variable; key env names are exposed separately as keyEnvVar. */
  envVar?: string
  /** Key environment variable(s), when the channel has a credential requirement. */
  keyEnvVar?: string
  endpoint: string
  endpointSource: 'env-override' | 'default'
}

export interface TravelChannelStatusRuntimeEntry {
  state: TravelChannelRuntimeState
  detail?: string
  latencyMs?: number
  cost: 'free' | 'metered'
  reason?: 'quota_guarded'
  costLabel?: string
}

/** supervisor.statusSnapshot() 的零 secret 投影。 */
export interface TravelCompanionStatusEntry {
  service: CompanionServiceName
  mode: CompanionManifest['mode']
  managedBySession: boolean
  childAlive: boolean
  pid?: number
  startsInWindow: number
}

export interface TravelChannelStatusProjection {
  ns: typeof TRAVEL_CHANNEL_STATUS_NS
  generatedAt: string
  probe: TravelChannelProbe
  config: Record<string, TravelChannelStatusConfigEntry>
  readiness: Record<string, TravelChannelStatusReadinessEntry>
  runtime?: Record<string, TravelChannelStatusRuntimeEntry>
  /** 可选：index.ts 传 supervisor 时投影伴随服务 live 状态。 */
  companions?: TravelCompanionStatusEntry[]
  notes: string[]
}

/** 只使用到的适配器结构面；其余适配器仍由依赖注入保留，避免创建第二份实例。 */
export interface TravelChannelStatusAdapters {
  rail?: Rail12306Adapter | object
  amap?: Pick<AmapAdapter, 'directionTransit'>
  wendao?: Pick<WendaoAdapter, 'query'>
  intercity?: IntercityAdapter | object
  flyai?: FlyaiAdapter | object
  didi?: DidiAdapter | object
  xhs?: XhsAdapter | object
  playwright?: PlaywrightSocialAdapter | object
  tencent?: TencentMapAdapter | object
  openMeteo?: OpenMeteoAdapter | object
  zhihu?: ZhihuAdapter | object
}

export interface TravelChannelStatusRouteOptions extends TravelMetricsRouteOptions {
  /** 适配器实例（必须复用 index.ts apply() 内已装配实例）。 */
  adapters?: TravelChannelStatusAdapters
  /** 兼容测试/定制接线的顶层别名；adapters 优先。 */
  rail?: TravelChannelStatusAdapters['rail']
  amap?: TravelChannelStatusAdapters['amap']
  wendao?: TravelChannelStatusAdapters['wendao']
  intercity?: TravelChannelStatusAdapters['intercity']
  flyai?: TravelChannelStatusAdapters['flyai']
  didi?: TravelChannelStatusAdapters['didi']
  xhs?: TravelChannelStatusAdapters['xhs']
  playwright?: TravelChannelStatusAdapters['playwright']
  tencent?: TravelChannelStatusAdapters['tencent']
  openMeteo?: TravelChannelStatusAdapters['openMeteo']
  zhihu?: TravelChannelStatusAdapters['zhihu']
  /** supervisor.statusSnapshot() 只读结构面。 */
  supervisor?: { statusSnapshot(): readonly TravelCompanionStatusEntry[] }
  /** settings 快照 / env 覆盖注入（测试；缺省真实 makeKeyEnv 热读）。 */
  settings?: TravelSettings
  env?: Readonly<Record<string, string | undefined>>
  /** cheap-health 探活 fetch 注入（测试；缺省 globalThis.fetch）。 */
  fetchFn?: HealthFetchFn
  /** 测试注入 binary 判定；缺省调用 resolveFlyaiCommand()。 */
  flyaiBinaryReady?: boolean
  /** 判定/响应 id 子集（测试注入；缺省全部 FR-3~FR-7）。 */
  ids?: readonly TravelChannelStatusId[]
}

interface ChannelDescriptor {
  readonly id: TravelChannelStatusId
  readonly keyIds?: readonly string[]
  readonly keyEnvVars?: readonly string[]
  readonly endpoint: string
  readonly endpointEnv?: string
  readonly runtime: 'none' | 'rail12306' | 'xhs' | 'playwright' | 'didi' | 'amap' | 'wendao' | 'flyai'
  readonly companion?: CompanionServiceName
  /**
   * cheap-health 探活路径覆盖：仅当端点本身带**_专用健康子路径**（≠ MCP 端点本身）时设置。
   *
   * 语义：`endpoint` 字段=**适配器真实连接端点**（含 TRAVEL_*_MCP_URL 覆盖）——这是页面
   * 必须展示的事实；而探活 URL 在多数情况下就等于该端点（MCP 端点自身 accept='any-response'，
   * 4xx 也算活），**唯独 12306 例外**：适配器连 `/mcp`，但健康口径是 `GET /health`（accept='http-ok'）。
   * 故 rail12306 单独声明 healthPath='/health'，由探活侧拼成 `origin + /health`。
   */
  readonly healthPath?: string
}

/** 密钥标识符 →实际部署常用 env 名（仅用于静态投影，值永不进入响应）。 */
const KEY_ENV_VARS: Readonly<Record<string, string>> = {
  amapWebservice: 'AMAP_WEBSERVICE',
  amapJsapi: 'AMAP_JSAPI',
  amapJscode: 'AMAP_JSCODE',
  wendao: 'WENDAO_APIKEY',
  flyai: 'FLYAI_APIKEY',
  didi: 'DIDI_MCP_KEY',
  zhihu: 'ZHIHU_ACCESS_SECRET',
  tmap: 'TMAP_KEY',
  cloakbrowser: 'CLOAKBROWSER_LICENSE',
  didaHotel: 'DIDA_HOTEL_API_KEY',
}

const DESCRIPTORS: readonly ChannelDescriptor[] = [
  // FR-3
  { id: 'xhsMcp', endpoint: COMPANION_MANIFESTS.xhs.url || DEFAULT_XHS_MCP_URL, endpointEnv: XHS_MCP_URL_ENV, runtime: 'xhs', companion: 'xhs' },
  { id: 'xhsFallback', endpoint: '', runtime: 'none' },
  { id: 'xhsCloak', keyIds: ['cloakbrowser'], keyEnvVars: ['CLOAKBROWSER_LICENSE'], endpoint: '', runtime: 'none' },
  { id: 'didaHotel', keyIds: ['didaHotel'], keyEnvVars: ['DIDA_HOTEL_API_KEY'], endpoint: DEFAULT_DIDAHOTEL_MCP_URL, endpointEnv: DIDAHOTEL_MCP_URL_ENV, runtime: 'none' },
  { id: 'douyin', endpoint: '', runtime: 'none' },
  { id: 'tier2', keyIds: ['zhihu'], keyEnvVars: ['ZHIHU_ACCESS_SECRET'], endpoint: ZHIHU_ENDPOINT, runtime: 'none' },
  { id: 'tier3', endpoint: '', runtime: 'none' },
  { id: 'socialL1', endpoint: COMPANION_MANIFESTS.playwright.url || DEFAULT_PLAYWRIGHT_MCP_URL, endpointEnv: PLAYWRIGHT_MCP_URL_ENV, runtime: 'playwright', companion: 'playwright' },
  { id: 'tencentPoi', endpoint: TENCENT_H5GW_BASE, runtime: 'none' },
  { id: 'platformIntel', keyIds: ['wendao'], keyEnvVars: ['WENDAO_APIKEY'], endpoint: WENDAO_ENDPOINT, endpointEnv: WENDAO_ENDPOINT_ENV, runtime: 'wendao' },
  // FR-4
  { id: 'rail12306', endpoint: COMPANION_MANIFESTS.rail12306.url || DEFAULT_RAIL_MCP_URL, endpointEnv: RAIL_MCP_URL_ENV, runtime: 'rail12306', companion: 'rail12306', healthPath: '/health' },
  { id: 'railWendao', keyIds: ['wendao'], keyEnvVars: ['WENDAO_APIKEY'], endpoint: WENDAO_ENDPOINT, endpointEnv: WENDAO_ENDPOINT_ENV, runtime: 'wendao' },
  { id: 'railFlyai', keyIds: ['flyai'], keyEnvVars: ['FLYAI_APIKEY'], endpoint: '', runtime: 'flyai' },
  { id: 'flightWendao', keyIds: ['wendao'], keyEnvVars: ['WENDAO_APIKEY'], endpoint: WENDAO_ENDPOINT, endpointEnv: WENDAO_ENDPOINT_ENV, runtime: 'wendao' },
  { id: 'flightFlyai', keyIds: ['flyai'], keyEnvVars: ['FLYAI_APIKEY'], endpoint: '', runtime: 'flyai' },
  // busConsult deliberately remains keyless: its public contract includes the L0 search fallback.
  { id: 'busConsult', endpoint: '', runtime: 'none' },
  { id: 'cityAmap', keyIds: ['amapWebservice'], keyEnvVars: ['AMAP_WEBSERVICE'], endpoint: AMAP_API_BASE, runtime: 'amap' },
  // endpoint 必须取**适配器真实缺省**（DEFAULT_DIDI_MCP_URL=127.0.0.1:8124），而不是
  // companion manifest 的远程基址（mcp.didichuxing.com）：两者是不同东西——manifest.url
  // 供 supervisor 远程探活用，适配器在无 TRAVEL_DIDI_MCP_URL 时连接的是 8124。
  // 取 manifest 会让页面展示一个适配器根本不会使用的端点（已实测复现）。
  { id: 'cityDidi', keyIds: ['didi'], keyEnvVars: ['DIDI_MCP_KEY'], endpoint: DEFAULT_DIDI_MCP_URL, endpointEnv: DIDI_MCP_URL_ENV, runtime: 'didi', companion: 'didi' },
  // FR-5
  { id: 'weatherAmap', keyIds: ['amapWebservice'], keyEnvVars: ['AMAP_WEBSERVICE'], endpoint: AMAP_API_BASE, runtime: 'amap' },
  { id: 'weatherTencent', endpoint: TENCENT_H5GW_BASE, runtime: 'none' },
  { id: 'weatherOpenMeteo', endpoint: OPEN_METEO_ENDPOINT, runtime: 'none' },
  { id: 'adviceSearch', endpoint: '', runtime: 'none' },
  // FR-6
  { id: 'routeCheckAmap', keyIds: ['amapWebservice'], keyEnvVars: ['AMAP_WEBSERVICE'], endpoint: AMAP_API_BASE, runtime: 'amap' },
  { id: 'routeCheckTencent', endpoint: TENCENT_H5GW_BASE, runtime: 'none' },
  { id: 'travelGuideTencent', endpoint: TENCENT_H5GW_BASE, runtime: 'none' },
  // FR-7
  { id: 'mapAmap', keyIds: ['amapJsapi', 'amapJscode'], keyEnvVars: ['AMAP_JSAPI', 'AMAP_JSCODE'], endpoint: AMAP_JSAPI_BASE, runtime: 'none' },
  { id: 'mapLeaflet', endpoint: '', runtime: 'none' },
  { id: 'deliveryRoute', endpoint: '', runtime: 'none' },
  { id: 'deliveryFile', endpoint: '', runtime: 'none' },
]

function denyText(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(message)
}

function sendJson(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/** 删除 URL query 中常见 secret 参数，并对已知 secret 做最后一道替换。 */
function safeEndpoint(value: string, secrets: readonly string[]): string {
  const raw = value.trim()
  if (raw === '') return ''
  let sanitized = raw
  try {
    const parsed = new URL(raw)
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(key|token|secret|password|passwd|authorization|api[-_]?key|access[-_]?token)$/i.test(key)) {
        parsed.searchParams.delete(key)
      }
    }
    parsed.username = ''
    parsed.password = ''
    sanitized = parsed.toString()
  } catch {
    // 非法 env 端点也不能原样透出可能携带的 secret；下面的 secret 替换仍生效。
  }
  for (const secret of secrets) {
    if (secret.trim() !== '') sanitized = sanitized.split(secret).join('<redacted>')
  }
  return sanitized
}

function safeDetail(value: string, secrets: readonly string[]): string {
  let sanitized = value
    .replace(/([?&](?:key|token|secret|password|passwd|authorization|api[-_]?key)=)[^&\s]+/gi, '$1<redacted>')
  for (const secret of secrets) {
    if (secret.trim() !== '') sanitized = sanitized.split(secret).join('<redacted>')
  }
  return sanitized.slice(0, 240)
}

/** 序列化 projection 的最后一道脱敏，不截断合法 JSON 响应。 */
function safeProjectionJson(value: string, secrets: readonly string[]): string {
  let sanitized = value
    .replace(/([?&](?:key|token|secret|password|passwd|authorization|api[-_]?key)=)[^&\s"}]+/gi, '$1<redacted>')
  for (const secret of secrets) {
    if (secret.trim() !== '') sanitized = sanitized.split(secret).join('<redacted>')
  }
  return sanitized
}

function endpointFor(descriptor: ChannelDescriptor, env: Readonly<Record<string, string | undefined>>, secrets: readonly string[]): {
  endpoint: string
  endpointSource: 'env-override' | 'default'
} {
  const override = descriptor.endpointEnv === undefined ? undefined : env[descriptor.endpointEnv]
  if (isNonEmpty(override)) return { endpoint: safeEndpoint(override, secrets), endpointSource: 'env-override' }
  return { endpoint: safeEndpoint(descriptor.endpoint, secrets), endpointSource: 'default' }
}

function adapterSet(options: TravelChannelStatusRouteOptions): TravelChannelStatusAdapters {
  return options.adapters ?? {
    rail: options.rail,
    amap: options.amap,
    wendao: options.wendao,
    intercity: options.intercity,
    flyai: options.flyai,
    didi: options.didi,
    xhs: options.xhs,
    playwright: options.playwright,
    tencent: options.tencent,
    openMeteo: options.openMeteo,
    zhihu: options.zhihu,
  }
}

function healthManifest(runtime: ChannelDescriptor['runtime']): CompanionManifest | undefined {
  if (runtime === 'rail12306' || runtime === 'xhs' || runtime === 'playwright' || runtime === 'didi') {
    return COMPANION_MANIFESTS[runtime]
  }
  return undefined
}

function runtimeUnavailable(cost: 'free' | 'metered', detail: string): TravelChannelStatusRuntimeEntry {
  return { state: 'unreachable', cost, detail }
}

function runtimeSkipped(cost: 'free' | 'metered', detail: string): TravelChannelStatusRuntimeEntry {
  return { state: 'not-probed', cost, detail }
}

function runtimeNotApplicable(detail?: string): TravelChannelStatusRuntimeEntry {
  return detail === undefined
    ? { state: 'not-applicable', cost: 'free' }
    : { state: 'not-applicable', cost: 'free', detail }
}

function runtimeNotProbed(costLabel: string): TravelChannelStatusRuntimeEntry {
  return { state: 'not-probed', cost: 'metered', reason: 'quota_guarded', costLabel }
}

/**
 * 解析 settings/credentials/env 全链并额外兼容适配器文档使用的大写 env ref。
 * 返回值只在本请求内用于布尔判定与脱敏，不进入 projection。
 */
async function resolveStatusKey(
  id: string,
  env: KeyResolutionEnv,
  envRecord: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  if (id === 'didi') {
    const direct = envRecord.DIDI_MCP_KEY
    if (isNonEmpty(direct)) return direct.trim()
  }
  const resolved = await resolveKey(id, env)
  if (resolved !== undefined) return resolved.value
  const aliases = [KEY_ENV_VARS[id]]
  for (const alias of aliases) {
    const value = envRecord[alias]
    if (isNonEmpty(value)) return value.trim()
  }
  return undefined
}

async function keyState(
  descriptor: ChannelDescriptor,
  env: KeyResolutionEnv,
  envRecord: Readonly<Record<string, string | undefined>>,
): Promise<{ configured: boolean; secrets: string[] }> {
  const secrets: string[] = []
  for (const id of descriptor.keyIds ?? []) {
    const value = await resolveStatusKey(id, env, envRecord)
    if (value === undefined) return { configured: false, secrets }
    secrets.push(value)
  }
  return { configured: true, secrets }
}

function binaryReady(options: TravelChannelStatusRouteOptions, adapters: TravelChannelStatusAdapters): boolean {
  if (options.flyaiBinaryReady !== undefined) return options.flyaiBinaryReady
  const candidate = adapters.flyai
  if (candidate !== undefined && typeof candidate === 'object' && candidate !== null) {
    const method = (candidate as { isBinaryReady?: unknown }).isBinaryReady
    if (typeof method === 'function') return method.call(candidate)
  }
  return resolveFlyaiCommand() !== undefined
}

function statusForReadiness(
  descriptor: ChannelDescriptor,
  configured: boolean,
  flyaiIsReady: boolean,
): TravelChannelReadinessState {
  if (descriptor.runtime === 'flyai') return flyaiIsReady ? 'ready' : 'missing-binary'
  if ((descriptor.keyIds?.length ?? 0) > 0) return configured ? 'ready' : 'missing-key'
  return 'no-key-required'
}

function costLabelFor(runtime: ChannelDescriptor['runtime']): string | undefined {
  if (runtime === 'amap') return `消耗 1 次高德月度配额（${AMAP_MONTHLY_QUOTA}/月）`
  if (runtime === 'wendao') return '消耗 1 次问道日额度（30/日）'
  return undefined
}

function statusDetailFromHealth(result: Awaited<ReturnType<typeof probeHealthOnce>>): string {
  if (result.status !== undefined) return `HTTP ${result.status}`
  return result.error === undefined ? '无响应' : safeDetail(result.error, [])
}

/** 探活 URL：适配器真实端点，仅当声明 healthPath 时换成该专用健康子路径。 */
function healthUrlFor(
  endpoint: { endpoint: string; endpointSource: 'env-override' | 'default' },
  healthPath: string | undefined,
): string {
  if (healthPath === undefined) return endpoint.endpoint
  try {
    return `${new URL(endpoint.endpoint).origin}${healthPath}`
  } catch {
    // 端点非合法 URL（配置写错）：保持原样，让探活如实失败而不是伪造可达。
    return endpoint.endpoint
  }
}

async function runCheapHealth(
  descriptor: ChannelDescriptor,
  fetchFn: HealthFetchFn | undefined,
  endpoint: { endpoint: string; endpointSource: 'env-override' | 'default' },
): Promise<TravelChannelStatusRuntimeEntry> {
  const manifest = healthManifest(descriptor.runtime)
  if (manifest === undefined) return runtimeNotApplicable()
  // 探活必须打**适配器真实端点**（含 TRAVEL_*_MCP_URL 覆盖），而不是 manifest 的固定
  // health URL：didi 的 manifest.url 是远程基址 https://mcp.didichuxing.com/mcp-servers，
  // 而适配器在无 env 覆盖时连接的是 DEFAULT_DIDI_MCP_URL(127.0.0.1:8124)。若照 manifest 探活，
  // 会出现「页面显示端点为 8124 且不可达，探活却报远程基址可达」的自相矛盾（已实测复现）。
  // accept 口径仍沿用 manifest（'http-ok' / 'any-response'）。
  const probe = { ...manifest.health, url: healthUrlFor(endpoint, descriptor.healthPath) }
  const started = Date.now()
  const result = await probeHealthOnce(probe, fetchFn)
  const latencyMs = Math.max(0, Date.now() - started)
  return result.healthy
    ? { state: 'reachable', cost: 'free', detail: statusDetailFromHealth(result), latencyMs }
    : { state: 'unreachable', cost: 'free', detail: statusDetailFromHealth(result), latencyMs }
}

async function runAmapProbe(
  adapter: TravelChannelStatusAdapters['amap'],
  env: KeyResolutionEnv,
): Promise<TravelChannelStatusRuntimeEntry> {
  if (adapter === undefined) return runtimeUnavailable('metered', 'AMap 适配器未装配')
  const started = Date.now()
  try {
    // 坐标串绕过 geocode，严格只触发一次 transit REST 调用。
    await adapter.directionTransit('120.100000,30.200000', '120.110000,30.210000', { city: '杭州' }, env)
    return { state: 'reachable', cost: 'metered', detail: 'transit HTTP 调用成功', latencyMs: Math.max(0, Date.now() - started) }
  } catch {
    return { state: 'unreachable', cost: 'metered', detail: '高德 transit 探活失败', latencyMs: Math.max(0, Date.now() - started) }
  }
}

async function runWendaoProbe(
  adapter: TravelChannelStatusAdapters['wendao'],
  env: KeyResolutionEnv,
): Promise<TravelChannelStatusRuntimeEntry> {
  if (adapter === undefined) return runtimeUnavailable('metered', '问道适配器未装配')
  const started = Date.now()
  try {
    // 只探一次；rail/flight/platformIntel 三个展示行共享同一个 per-token 成本。
    await adapter.query('查询杭州到上海的火车票', env)
    return { state: 'reachable', cost: 'metered', detail: '问道 HTTP 调用成功', latencyMs: Math.max(0, Date.now() - started) }
  } catch {
    return { state: 'unreachable', cost: 'metered', detail: '问道探活失败', latencyMs: Math.max(0, Date.now() - started) }
  }
}

async function runtimeForDescriptor(
  descriptor: ChannelDescriptor,
  probe: Exclude<TravelChannelProbe, 'none'>,
  enabled: boolean,
  readiness: TravelChannelStatusReadinessEntry,
  adapters: TravelChannelStatusAdapters,
  env: KeyResolutionEnv,
  fetchFn: HealthFetchFn | undefined,
  secrets: readonly string[],
  shared: Map<string, Promise<TravelChannelStatusRuntimeEntry>>,
  endpoint: { endpoint: string; endpointSource: 'env-override' | 'default' },
): Promise<TravelChannelStatusRuntimeEntry> {
  if (!enabled) return runtimeNotApplicable('渠道已关闭')
  if (descriptor.runtime === 'none') return runtimeNotApplicable()
  if (descriptor.runtime === 'flyai') {
    // flyai 没有远程运行态；二进制位置已在 readiness 层表达，runtime 保持不适用。
    return readiness.state === 'ready'
      ? { state: 'not-applicable', cost: 'free', detail: '本地 flyai 二进制已就位（无远程探活）' }
      : { state: 'not-applicable', cost: 'free', detail: '本地 flyai 二进制未就位（无远程探活）' }
  }
  if (descriptor.runtime === 'amap' || descriptor.runtime === 'wendao') {
    if (probe === 'health') {
      return runtimeNotProbed(costLabelFor(descriptor.runtime) ?? '需显式 full 探活')
    }
    if (readiness.state === 'missing-key') return runtimeSkipped('metered', 'Key 未配置，未执行探活')
    const sharedKey = descriptor.runtime
    const prior = shared.get(sharedKey)
    if (prior !== undefined) return prior
    const task = descriptor.runtime === 'amap'
      ? runAmapProbe(adapters.amap, env)
      : runWendaoProbe(adapters.wendao, env)
    shared.set(sharedKey, task)
    return task
  }
  // cheap-health 的 adapter readiness 不参与远程 accept 口径：例如 Didi 401
  // 仍按 manifest accept=any-response 记为 reachable，不能误报 Key 失效。
  const result = await runCheapHealth(descriptor, fetchFn, endpoint)
  return {
    ...result,
    detail: result.detail === undefined ? undefined : safeDetail(result.detail, secrets),
  }
}

function selectedDescriptors(ids?: readonly TravelChannelStatusId[]): ChannelDescriptor[] {
  if (ids === undefined) return [...DESCRIPTORS]
  const selected = new Set(ids)
  return DESCRIPTORS.filter((descriptor) => selected.has(descriptor.id))
}

/**
 * GET /travel-channel-status handler。
 * 非 GET → 405；来源防护与 /travel-key-status 完全同款；非法 probe → 400。
 */
export function makeTravelChannelStatusHandler(
  host: MakeKeyEnvHost,
  options: TravelChannelStatusRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      denyText(res, 405, 'travel-channel-status 仅支持 GET（只读）', { allow: 'GET' })
      return
    }
    if (!metricsSourceAllowed(req, options)) {
      denyText(res, 403, 'travel-channel-status 拒绝非本机来源')
      return
    }

    let probe: TravelChannelProbe = 'none'
    try {
      const requested = new URL(req.url ?? '/', 'http://dsh-travel.local').searchParams.get('probe')
      if (requested !== null && requested !== '' && requested !== 'none' && requested !== 'health' && requested !== 'full') {
        denyText(res, 400, 'probe 仅支持 health 或 full')
        return
      }
      if (requested === 'health' || requested === 'full') probe = requested
    } catch {
      denyText(res, 400, '无效的请求 URL')
      return
    }

    const envRecord = options.env ?? process.env
    const keyEnv = makeKeyEnv(host, { settings: options.settings, env: options.env })
    const descriptors = selectedDescriptors(options.ids)
    const adapters = adapterSet(options)
    const config: Record<string, TravelChannelStatusConfigEntry> = {}
    const readiness: Record<string, TravelChannelStatusReadinessEntry> = {}
    const allSecrets: string[] = []
    const readinessStates = new Map<string, { state: TravelChannelReadinessState; configured: boolean; secrets: string[] }>()
    const flyaiIsReady = binaryReady(options, adapters)

    // 静态判定仅触碰设置/credentials/env 与本地二进制解析，不调用 fetch。
    await Promise.all(descriptors.map(async (descriptor) => {
      const enabled = channelEnabled(descriptor.id, keyEnv)
      config[descriptor.id] = { enabled }
      const key = await keyState(descriptor, keyEnv, envRecord)
      allSecrets.push(...key.secrets)
      readinessStates.set(descriptor.id, { state: statusForReadiness(descriptor, key.configured, flyaiIsReady), configured: key.configured, secrets: key.secrets })
    }))

    for (const descriptor of descriptors) {
      const key = readinessStates.get(descriptor.id) ?? { state: 'no-key-required' as const, configured: false, secrets: [] }
      const endpoint = endpointFor(descriptor, envRecord, allSecrets)
      readiness[descriptor.id] = {
        state: key.state,
        ...(descriptor.keyIds?.length ? { keyId: descriptor.keyIds.join(',') } : {}),
        ...(descriptor.keyIds?.length ? { keyConfigured: key.configured } : {}),
        ...(descriptor.endpointEnv !== undefined ? { envVar: descriptor.endpointEnv } : {}),
        ...(descriptor.keyEnvVars?.length ? { keyEnvVar: descriptor.keyEnvVars.join(',') } : {}),
        endpoint: endpoint.endpoint,
        endpointSource: endpoint.endpointSource,
      }
    }

    const projection: TravelChannelStatusProjection = {
      ns: TRAVEL_CHANNEL_STATUS_NS,
      generatedAt: new Date().toISOString(),
      probe,
      config,
      readiness,
      notes: [
        '运行态仅在显式 probe=health/full 时探活；缺省请求不发起任何外部 fetch。',
        'health 只探免费 cheap-health；高德与问道需显式 probe=full，分别消耗月度/日额度。',
      ],
    }

    if (options.supervisor !== undefined) {
      try {
        projection.companions = options.supervisor.statusSnapshot().map((entry) => ({
          service: entry.service,
          mode: entry.mode,
          managedBySession: entry.managedBySession,
          childAlive: entry.childAlive,
          ...(entry.pid === undefined ? {} : { pid: entry.pid }),
          startsInWindow: entry.startsInWindow,
        }))
      } catch {
        projection.notes.push('伴随服务 live 状态暂不可读取。')
      }
    }

    if (probe !== 'none') {
      const runtime: Record<string, TravelChannelStatusRuntimeEntry> = {}
      const shared = new Map<string, Promise<TravelChannelStatusRuntimeEntry>>()
      await Promise.all(descriptors.map(async (descriptor) => {
        const readinessEntry = readiness[descriptor.id]
        const endpointEntry = endpointFor(descriptor, envRecord, allSecrets)
        const entry = await runtimeForDescriptor(
          descriptor,
          probe as Exclude<TravelChannelProbe, 'none'>,
          config[descriptor.id]?.enabled === true,
          readinessEntry,
          adapters,
          keyEnv,
          options.fetchFn,
          readinessStates.get(descriptor.id)?.secrets ?? allSecrets,
          shared,
          endpointEntry,
        )
        runtime[descriptor.id] = entry
      }))
      projection.runtime = runtime
    }

    // 仅用于此请求内最后一道 secret 防线；allSecrets 不会出现在 projection。
    const payload = JSON.stringify(projection)
    sendJson(res, safeProjectionJson(payload, allSecrets))
  }
}
