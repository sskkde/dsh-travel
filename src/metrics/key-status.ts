/**
 * 渠道 Key 配置状态只读同源路由（M3.6：设置页「已配置」判定补 credentials 层）。
 *
 * 背景：设置页 Key 徽章的 settings-only 判定（describe mirror secrets 边车）在生产
 * settings.yaml 无 travel.keys 时显示「未配置」，但运行时 resolveKey 链
 * （settings→credentials→env，ADR-12）实际可解析（AMAP_WEBSERVICE/AMAP_JSAPI/
 * AMAP_JSCODE/WENDAO_APIKEY/DIDI_MCPKEY 等 credentials refs）。本路由让 client
 * 在挂载后拉一次双面布尔的「已配置/渠道开关」状态，与 settings-only 判定合并显示。
 *
 * 形态与 /travel-metrics（usage.ts makeTravelMetricsHandler）同构：
 * - exact GET `/travel-key-status` → JSON
 *   `{ ns:'travel', keys:{ id:{configured:boolean,channelEnabled:boolean} } }`；
 * - 每 id 用 makeKeyEnv(ctx)**请求时热构造** + resolveKey(id, env) 全链判定
 *   （覆盖 settings→credentials→env；与运行时工具同口径），并单独投影对应渠道开关；
 * - 响应零 secret（只布尔；值绝不回显）；
 * - 非 GET → 405（allow: GET）；非本机回环/白名单来源 → 403（同 metrics 防护）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeKeyEnv, type MakeKeyEnvHost } from '../adapters/env.js'
import { channelEnabled, resolveKey } from '../adapters/base.js'
import { metricsSourceAllowed, type TravelMetricsRouteOptions } from './usage.js'
import type { TravelSettings } from '../settings/schema.js'

/** key-status 路由 path（exact；client 半以同字面量镜像）。 */
export const TRAVEL_KEY_STATUS_PATH = '/travel-key-status'
/** 响应 ns（= settings 命名空间 travel）。 */
export const TRAVEL_KEY_STATUS_NS = 'travel'

/**
 * 判定表（与 fields.ts KEY_FIELDS / CREDENTIAL_REF_MAP 同名标识符集合一致；
 * 顺序=设置页渲染顺序）。`configured` = resolveKey(id, env) 非空；
 * `channelEnabled` = 该 Key 主渠道的开关（多功能共享 Key 取其主用途，见映射表）。
 */
export const TRAVEL_KEY_STATUS_IDS = [
  'amapWebservice', 'amapJsapi', 'amapJscode', 'wendao',
  'flyai', 'didi', 'tmap', 'zhihu', 'cloakbrowser',
] as const
export type TravelKeyStatusId = (typeof TRAVEL_KEY_STATUS_IDS)[number]

/** 每个 Key 的双面投影（零 secret——只布尔）。 */
export interface TravelKeyStatusEntry {
  /** settings→credentials→env 全链是否解析到非空凭据。 */
  configured: boolean
  /** 对应主渠道是否按 settings/env 开启；不等同 configured。 */
  channelEnabled: boolean
}

/**
 * Key → 主渠道映射。共享 Key（如高德 Web Service）取设置页首要消费渠道；
 * 具体工具仍各自按其细粒度 channelEnabled 判定，status 只提供稳定的诊断投影。
 */
export const TRAVEL_KEY_STATUS_CHANNELS: Record<TravelKeyStatusId, string> = {
  amapWebservice: 'cityAmap',
  amapJsapi: 'mapAmap',
  amapJscode: 'mapAmap',
  wendao: 'wendao',
  flyai: 'flyai',
  didi: 'cityDidi',
  tmap: 'tencentPoi',
  zhihu: 'tier2',
  cloakbrowser: 'xhsCloak',
}

/** GET /travel-key-status 响应体。 */
export interface TravelKeyStatusProjection {
  ns: typeof TRAVEL_KEY_STATUS_NS
  keys: Record<TravelKeyStatusId, TravelKeyStatusEntry>
}

export interface TravelKeyStatusRouteOptions extends TravelMetricsRouteOptions {
  /** 判定 id 集合（测试注入；缺省 TRAVEL_KEY_STATUS_IDS）。 */
  ids?: readonly TravelKeyStatusId[]
  /** settings 快照覆盖（测试注入；缺省走已注册命名空间快照/未注册=undefined）。 */
  settings?: TravelSettings
  /** env 兜底覆盖（测试注入；缺省 process.env——resolveKey 内层兜底）。 */
  env?: Readonly<Record<string, string | undefined>>
}

function denyText(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(message)
}

function sendJson(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * GET /travel-key-status handler：每 id 用 makeKeyEnv(host)（请求时热构造，
 * 取当下 credentials/settings/env）+ resolveKey(id, env) 全链判定，并读取主渠道开关。
 * 全链任一解析异常按未配置处理（resolveKey 内置 catch；本 handler 不抛 500）。
 * 非 GET → 405（allow: GET）；来源非本机回环/白名单 → 403。
 */
export function makeTravelKeyStatusHandler(
  host: MakeKeyEnvHost,
  options: TravelKeyStatusRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      denyText(res, 405, 'travel-key-status 仅支持 GET（只读）', { allow: 'GET' })
      return
    }
    if (!metricsSourceAllowed(req, options)) {
      denyText(res, 403, 'travel-key-status 拒绝非本机来源')
      return
    }
    const ids = options.ids ?? TRAVEL_KEY_STATUS_IDS
    // 每个请求现造 env；credentials/settings 的当前值不在 handler 装配期快照。
    const env = makeKeyEnv(host, { settings: options.settings, env: options.env })
    const keys = {} as Record<TravelKeyStatusId, TravelKeyStatusEntry>
    for (const id of ids) {
      keys[id] = {
        configured: (await resolveKey(id, env)) !== undefined,
        channelEnabled: channelEnabled(TRAVEL_KEY_STATUS_CHANNELS[id], env),
      }
    }
    sendJson(res, JSON.stringify({ ns: TRAVEL_KEY_STATUS_NS, keys }))
  }
}