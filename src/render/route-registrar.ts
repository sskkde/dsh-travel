/**
 * 幂等路由注册器（M1 T5 / Wα render_page 依赖）。
 *
 * 宿主 `ctx.webServer.register({kind,path,handler})` 对重复 (kind,path) 直接抛错
 * （spike-webserver 已验证）——而 §9.2 要求同 planId 重渲染路由幂等。本注册器以
 * 模块内 Set 判重：同 path 重复 register 直接跳过（无副作用、无报错）。
 *
 * 独立成模块：测试与端到端演示脚本可直接用真实 WebServer 服务实例装配
 * （demo 脚本 boot 真实 WebServer + 本注册器 → curl 路由 200 留证）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveKey, type KeyResolutionEnv } from '../adapters/base.js'

/** 高德官方安全代理固定前缀（serviceHost 必须保留 `_AMapService`）。 */
export const AMAP_SECURITY_PROXY_PATH = '/_AMapService'
/** B 页面服务端下发的 HttpOnly capability cookie 名；不含 jscode。 */
export const AMAP_SECURITY_CAPABILITY_COOKIE = 'dsh-travel-amap-capability'
export const AMAP_SECURITY_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000
export const AMAP_SECURITY_TIMEOUT_MS = 10_000
export const AMAP_SECURITY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const AMAP_SECURITY_MAX_REQUESTS_PER_MINUTE = 60

/** 代理只接受 JSAPI 发起的只读请求，避免把插件路由变成通用转发器。 */
const AMAP_SECURITY_ALLOWED_METHODS = new Set(['GET', 'HEAD'])
const AMAP_WEBAPI_STYLES_PREFIX = '/v4/map/styles'
const AMAP_REST_PREFIX = '/v3/'

/** 可替换的 fetch 面：单测可隔离上游，不触网。 */
export type AmapSecurityFetch = (url: string, init: RequestInit) => Promise<Response>

/** B 页面能力凭证（防代理端点被页面外客户端白嫖转发；不含 jscode）。 */
export interface AmapSecurityCapability {
  token: string
  expiresAt: number
}

/** capability 直给（单测）或读取函数（生产：每次请求动态取，重渲染/重启后仍一致；可异步）。 */
export type AmapSecurityCapabilityProvider =
  | AmapSecurityCapability
  | (() => AmapSecurityCapability | undefined | Promise<AmapSecurityCapability | undefined>)

export interface AmapSecurityProxyOptions {
  /** 每次代理请求热解析 jscode（settings → credentials ref AMAP_JSCODE → env）。 */
  keyEnv: KeyResolutionEnv
  fetchImpl?: AmapSecurityFetch
  /** B 页面 capability；缺省仅用于直接单测 handler，生产 B 路由必须提供。 */
  capability?: AmapSecurityCapabilityProvider
  maxRequestsPerMinute?: number
  timeoutMs?: number
  maxResponseBytes?: number
}

function proxyResponse(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

async function hasCapabilityCookie(
  req: IncomingMessage,
  capability: AmapSecurityCapabilityProvider | undefined,
): Promise<boolean> {
  if (capability === undefined) return true
  const resolved = typeof capability === 'function' ? await capability() : capability
  if (resolved === undefined) return false
  if (Date.now() >= resolved.expiresAt) return false
  const expected = `${AMAP_SECURITY_CAPABILITY_COOKIE}=${resolved.token}`
  return (req.headers?.cookie ?? '').split(';').some((part) => part.trim() === expected)
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      throw new Error('AMap security proxy response exceeds size limit')
    }
  }
  if (response.body === null) return new Uint8Array(await response.arrayBuffer())

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('AMap security proxy response exceeds size limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function isAllowedAmapPath(pathname: string): boolean {
  return pathname.startsWith(AMAP_REST_PREFIX)
    || pathname === AMAP_WEBAPI_STYLES_PREFIX
    || pathname.startsWith(`${AMAP_WEBAPI_STYLES_PREFIX}/`)
}

/**
 * 构造高德 JSAPI 安全代理 handler。
 *
 * 官方约定：`/_AMapService/v4/map/styles*` 转发到 webapi.amap.com，其余
 * `/v3/*` 转发到 restapi.amap.com；jscode 由服务端覆盖注入，客户端 query
 * 中即使携带同名参数也不会被信任。仅固定上游 origin/path，禁止开放代理。
 * B 路由另受每页 HttpOnly capability、限流、超时和响应大小闸门保护。
 */
export function makeAmapSecurityProxyHandler(options: AmapSecurityProxyOptions) {
  const maxRequestsPerMinute = Math.max(
    1,
    Math.floor(options.maxRequestsPerMinute ?? AMAP_SECURITY_MAX_REQUESTS_PER_MINUTE),
  )
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? AMAP_SECURITY_TIMEOUT_MS))
  const maxResponseBytes = Math.max(1, Math.floor(options.maxResponseBytes ?? AMAP_SECURITY_MAX_RESPONSE_BYTES))
  let windowStartedAt = Date.now()
  let requestCount = 0

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (!AMAP_SECURITY_ALLOWED_METHODS.has(method)) {
      res.writeHead(405, {
        allow: 'GET, HEAD',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end('AMap security proxy only supports GET and HEAD')
      return
    }

    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? AMAP_SECURITY_PROXY_PATH, 'http://dsh-travel.local')
    } catch {
      proxyResponse(res, 400, 'invalid proxy request URL')
      return
    }
    const upstreamPath = requestUrl.pathname.slice(AMAP_SECURITY_PROXY_PATH.length)
    if (!upstreamPath.startsWith('/') || !isAllowedAmapPath(upstreamPath)) {
      proxyResponse(res, 404, 'unsupported AMap security proxy path')
      return
    }
    if (!await hasCapabilityCookie(req, options.capability)) {
      proxyResponse(res, 403, 'AMap security proxy capability missing or expired')
      return
    }

    const now = Date.now()
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now
      requestCount = 0
    }
    if (requestCount >= maxRequestsPerMinute) {
      proxyResponse(res, 429, 'AMap security proxy rate limit exceeded', { 'retry-after': '60' })
      return
    }
    requestCount += 1

    let jscode: string | undefined
    try {
      jscode = (await resolveKey('amapJscode', options.keyEnv))?.value
    } catch {
      // Settings/credentials errors are intentionally opaque at the HTTP boundary.
    }
    if (jscode === undefined) {
      proxyResponse(res, 503, 'AMap security jscode is not configured')
      return
    }

    const upstreamOrigin = upstreamPath.startsWith(AMAP_WEBAPI_STYLES_PREFIX)
      ? 'https://webapi.amap.com'
      : 'https://restapi.amap.com'
    const query = new URLSearchParams(requestUrl.search)
    query.delete('jscode')
    query.set('jscode', jscode)
    const upstreamUrl = `${upstreamOrigin}${upstreamPath}?${query.toString()}`
    const headers: Record<string, string> = {}
    const accept = req.headers?.accept
    if (typeof accept === 'string') headers.accept = accept

    let upstream: Response
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch
      if (fetchImpl === undefined) {
        proxyResponse(res, 502, 'AMap security proxy upstream unavailable')
        return
      }
      upstream = await fetchImpl(upstreamUrl, { method, headers, signal: controller.signal })
      const body = method === 'HEAD' ? new Uint8Array() : await readResponseBody(upstream, maxResponseBytes)
      const responseHeaders: Record<string, string> = {
        'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
      }
      const contentType = upstream.headers.get('content-type')
      if (contentType !== null) responseHeaders['content-type'] = contentType
      if (method === 'HEAD') {
        const declaredLength = upstream.headers.get('content-length')
        if (declaredLength !== null) responseHeaders['content-length'] = declaredLength
      } else {
        responseHeaders['content-length'] = String(body.byteLength)
      }
      res.writeHead(upstream.status, responseHeaders)
      res.end(body)
    } catch {
      proxyResponse(res, 502, 'AMap security proxy upstream unavailable')
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** 宿主 webserver 服务的最小结构面（avoid 硬依赖宿主包类型，结构兼容）。 */
export interface WebServerLike {
  readonly host: string
  readonly port: number
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

export interface IdempotentRegistrar {
  readonly host: string
  readonly port: number
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
}

/** 包装宿主 webserver：同 (kind,path) 重复注册跳过（幂等）；记录 disposer 供清理。 */
export function createDedupingRouteRegistrar(server: WebServerLike): IdempotentRegistrar {
  const registered = new Set<string>()
  const disposers: Array<() => void> = []
  return {
    host: server.host,
    port: server.port,
    register(route) {
      const key = `${route.kind}:${route.path}`
      if (registered.has(key)) return // 幂等：不重复注册、不报错（§9.2）
      // 宿主重复注册防御（如宿主侧已存在同路径）：吞掉注册冲突，保持无副作用
      try {
        const disposer = server.register(route)
        if (typeof disposer === 'function') disposers.push(disposer)
        registered.add(key)
      } catch {
        registered.add(key) // 已注册视同幂等命中（不抛错）
      }
    },
  }
}