/**
 * 公开页面抓取的安全抓取层（F1，Final Wave）：关闭 SSRF 与放大/类型闸门的
 * 连接期与读体期闭环。
 *
 * 闭环范围：
 * 1. 首 URL（manualRedirectFetch）：validatePublicFetchUrl（scheme/凭据/私网字面量）；
 * 2. DNS 连接前复检：hostIsDeniedAfterResolve 解析每个主机名（默认 node:dns 全部地址，
 *    测试可注入 fixture），任一私网/环回/链路本地/隧道私网 → 拒（dns_private_network）；
 * 3. 重定向逐跳（redirect:'manual'，不做自动 follow）：每跳对 Location 再走
 *    validateRedirectTarget + DNS 复检，上限 MAX_REDIRECT_HOPS 跳，超限拒；
 * 4. 读体期：checkFetchSize 以流式计数（超限即截断拒绝，不整读放大内存）+
 *    checkFetchContentType（header 给出的文本类白名单之外 → 拒）。
 *
 * defaultFetchHtml（search.ts / index.ts 生产挂接处）从此交由本层实现；FetchHtmlFn/
 * FetchedHtml 签名保持兼容（contentType 为可选新增字段）。
 */
import {
  FETCH_MAX_BYTES, checkFetchContentType, checkFetchSize, resolvePublicConnect,
  validatePublicFetchUrl, validateRedirectTarget, type LookupFn, type UrlSafetyDecision,
} from './governance/url-safety.js'
import type { FetchedHtml, FetchHtmlFn } from './search.js'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import { Readable } from 'node:stream'

/** 重定向逐跳上限（超限 ≙ 明显滥用/环路 → 拒，宁拒勿漏）。 */
export const MAX_REDIRECT_HOPS = 5
/** 单次抓取总体超时（覆盖全部跳 + 读体；超限中止，防止慢房拖住主流程）。 */
export const SAFE_FETCH_TIMEOUT_MS = 20_000

/** 抓取层校验拒绝（reasonCode 稳定，供上层转结构化错误码）。 */
export class FetchGateError extends Error {
  readonly reasonCode: string
  constructor(reasonCode: string, message: string) {
    super(message)
    this.name = 'FetchGateError'
    this.reasonCode = reasonCode
  }
}

function throwGate(decision: UrlSafetyDecision, prefix: string): never {
  throw new FetchGateError(decision.reasonCode ?? 'gated', `${prefix}：${decision.reason ?? ''}（${decision.reasonCode ?? ''}）`)
}

/** 结构性 fetch 依赖（可注入 stub；真实运行 = secureConnectFetch，按已校验地址建连）。 */
export interface HeadersLike {
  get(name: string): string | null
}
export interface FetchResponseLike {
  status: number
  headers: HeadersLike
  body?: ReadableStream<Uint8Array> | null
  /** 强制释放底层连接句柄：仅拒绝/放弃路径调用（成功路径不调用，不主动销毁
   *  已完成的连接）。生产实现 secureConnectFetch 提供 req.destroy 闭包；测试
   *  stub 可注入可观测计数器。 */
  destroy?(): void
}

/** 连接绑定信息：连接必须使用这里给出的**已校验公网地址**（而非二次解析），闭合 DNS rebinding TOCTOU。 */
export interface ConnectBinding {
  /** 已校验通过的公网连接地址（首个即默认建连目标；测试可断言绑定）。 */
  bindAddresses: string[]
  /** 原始主机名（建连后 Host/TLS servername 语义，避免用 IP 伪造 Host）。 */
  hostname: string
  /** URL scheme（http/https，决定端口默认与是否 TLS）。 */
  protocol: string
  /** 显式端口（空 = 协议默认）。 */
  port: string
}

export interface FetchConnectInit {
  headers?: Record<string, string>
  redirect: 'manual'
  signal?: AbortSignal
  /** F1c：已校验的绑定信息（非预检即连——连接必须用这些地址）。 */
  bind?: ConnectBinding
}
export type FetchImpl = (input: string, init?: FetchConnectInit) => Promise<FetchResponseLike>
export type FetchSignal = AbortSignal

/** 抓取选项（DNS/网络全可注入，离线测试零真实网络）。 */
export interface SafeFetchOptions {
  /** 每个主机名/重定向目标走一次 DNS 复检的解析器（缺省 node:dns 全部地址）。 */
  resolver?: LookupFn
  /** fetch 实现（缺省 globalThis.fetch；测试注入 stub）。 */
  fetchImpl?: FetchImpl
  /** 重定向跳数上限（缺省 MAX_REDIRECT_HOPS）。 */
  maxRedirects?: number
  /** 超时信号（缺省按 SAFE_FETCH_TIMEOUT_MS 自控整个抓取）。 */
  signal?: AbortSignal
  timeoutMs?: number
  /** 桌面 UA 等请求头（缺省按 search 缺省 UA）。 */
  userAgent?: string
}

/** search.ts L0.5 SSR 直抓也用同一桌面 UA/Accept（与旧 defaultFetchHtml 一致）。 */
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const DASH_ACCEPT = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'

/**
 * 带全部安全门的 manually-follow 抓取。过程：
 * 初始 URL → validatePublicFetchUrl + DNS → fetch(redirect:'manual')；若 3xx 且带
 * Location → 对 Location 目标重复 validateRedirectTarget + DNS（计跳），直到非跳转。
 * 终跳响应做 content-type + 流式大小闸门后返回（status/text/contentType/finalUrl）。
 */
export async function manualRedirectFetch(initialUrl: string, opts: SafeFetchOptions = {}): Promise<FetchedHtml> {
  const fetchImpl = opts.fetchImpl ?? secureConnectFetch as unknown as FetchImpl
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECT_HOPS
  const resolver: LookupFn | undefined = opts.resolver
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS

  let current = initialUrl
  let hops = 0
  // 当前活跃响应：类型拒绝/重定向超限等早期退出路径与统一 finally 用它主动放弃
  // （cancel body + destroy 底层连接），不依赖调用方未来 abort。
  let activeResponse: FetchResponseLike | null = null
  // 一次抓取的总体 abort（覆盖全部跳 + 读体）；用户给了 signal 则沿用，否则自建超时
  const controller = opts.signal !== undefined ? undefined : new AbortController()
  const outer = opts.signal ?? controller!.signal
  const timer = controller !== undefined
    ? setTimeout(() => controller.abort(new Error('safe-fetch timeout')), timeoutMs)
    : undefined

  const ua = opts.userAgent ?? DESKTOP_UA
  const commonHeaders: Record<string, string> = {
    'User-Agent': ua,
    'Accept': DASH_ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }

  try {
    for (;;) {
      const urlDecision = validatePublicFetchUrl(current)
      if (!urlDecision.ok) throwGate(urlDecision, `抓取 URL 未通过安全校验（${current}）`)
      const url = new URL(current)
      // F1c：解析一次 → 校验全部地址 → 连接绑定到已校验地址（闭合 rebinding TOCTOU）
      const resolved = await resolvePublicConnect(url.hostname, resolver)
      if (!resolved.ok) throwGate(resolved.decision, `URL 主机名复检未通过（${url.hostname}）`)

      let response: FetchResponseLike
      try {
        response = await fetchImpl(current, {
          headers: commonHeaders,
          redirect: 'manual',
          signal: outer,
          bind: {
            bindAddresses: resolved.addresses,
            hostname: url.hostname,
            protocol: url.protocol,
            port: url.port,
          },
        })
      } catch (err) {
        if (timer !== undefined) clearTimeout(timer)
        throw err
      }
      activeResponse = response

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location !== null && location !== '') {
          hops += 1
          if (hops > maxRedirects) {
            // F1g：超限那一跳的响应先主动放弃（cancel body + destroy 底层连接）再抛，
            // 修复前在此直接 throw，未读 body / 挂起连接泄漏。
            await abandonResponse(response)
            activeResponse = null
            if (timer !== undefined) clearTimeout(timer)
            throw new FetchGateError('too_many_redirects', `重定向超过 ${maxRedirects} 跳上限（从 ${initialUrl}），拒绝继续跟随`)
          }
          // 先放弃当前跳 body（释放资源），再做下一跳安全门
          await swallowBody(response)
          activeResponse = null
          let next: string
          try {
            next = new URL(location, current).toString()
          } catch {
            if (timer !== undefined) clearTimeout(timer)
            throwGate({ ok: false, reasonCode: 'bad_redirect', reason: `无效重定向 Location（${location}）` }, '重定向目标解析失败')
          }
          // 逐跳目标重校验（validateRedirectTarget 再走一次完整 URL 校验）
          const targetOk = validateRedirectTarget(next)
          if (!targetOk.ok) {
            if (timer !== undefined) clearTimeout(timer)
            throwGate(targetOk, `重定向目标未通过安全校验（${next}）`)
          }
          current = next
          continue
        }
        // 3xx 但无 Location → 视为终跳（罕见；交由后续 status 判定），不再跟随
      }

      // 终跳：读体期内闸门（type + 流式大小），再返回。
      // F1c：不在此提前清定时器——读体期仍在 outer 信号保护内（超时覆盖读体）；
      // 定时器统一在 finally 清理。
      try {
        return await settledRead(response, current, outer)
      } finally {
        // settledRead 成功 = body 已读完；类型拒绝 = 内部已 abandon。无论哪种，
        // 该响应不再活跃——统一 finally 不得对已完成/已放弃的连接再 destroy。
        activeResponse = null
      }
    }
  } finally {
    // F1g：统一 finally 兜底——任何早期退出路径残留的活跃响应主动放弃
    // （cancel body + destroy 底层连接），不依赖调用方未来 abort；同时绝不
    // abort 调用方外部 signal（controller 为 undefined 时不触发 abort）。
    if (activeResponse !== null) await abandonResponse(activeResponse)
    if (controller !== undefined && !controller.signal.aborted) controller.abort()
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 超时错误（读写期命中 abort → 明确标 timeout 而非静默成功）。 */
function timeoutError(): Error {
  const err = new Error('safe-fetch timeout（读体期命中）')
  err.name = 'TimeoutError'
  return err
}

/** 终跳：content-type 闸门 + 流式大小闸门 → {status,text,contentType,finalUrl}。 */
async function settledRead(
  response: FetchResponseLike,
  finalUrl: string,
  signal?: AbortSignal,
): Promise<FetchedHtml> {
  const rawType = response.headers.get('content-type')
  const typeOk = checkFetchContentTypeRaw(rawType, finalUrl)
  if (!typeOk.ok) {
    // F1g：类型闸门拒绝时主动放弃响应（cancel body + destroy 底层连接）再抛；
    // 修复前直接 throwGate，挂起 body 的 socket/句柄持续泄漏，且外部 signal 时
    // 无人替它取消。destroy 仅此拒绝路径调用——成功路径不由这里触碰连接。
    await abandonResponse(response)
    throwGate(typeOk.decision, `终跳响应内容类型不在允许白名单（${finalUrl}）`)
  }
  const limited = await readBodyCapped(response.body, signal)
  if (!limited.ok) {
    const sizeDecision = checkFetchSize(FETCH_MAX_BYTES + 1) // 恒 too_large；形态一致
    throwGate(sizeDecision, `终跳响应超过抓取大小上限 ${FETCH_MAX_BYTES} 字节（${finalUrl}）`)
  }
  return {
    status: response.status,
    text: limited.text,
    ...(rawType !== null && rawType !== '' ? { contentType: rawType } : {}),
    finalUrl,
  }
}

/**
 * 内容类型判定：无 header → content_type_missing（宁拒勿漏）；有 header → 白名单。
 */
type ContentTypeJudge = { ok: true } | { ok: false; decision: UrlSafetyDecision }
function checkFetchContentTypeRaw(rawType: string | null, _finalUrl: string): ContentTypeJudge {
  if (rawType === null || rawType === '') {
    return { ok: false, decision: { ok: false, reasonCode: 'content_type_missing', reason: '响应缺失 content-type 头' } }
  }
  const typeOk = checkFetchContentType(rawType)
  if (!typeOk.ok) return { ok: false, decision: typeOk }
  return { ok: true }
}

/**
 * 流式读体并计数；超上限即截断拒绝（不整读放大内存）。
 * F1c：读体期受 outer 信号保护——abort 时拒绝（超时覆盖读体），不静默返回成功。
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (body === null || body === undefined) return { ok: true, text: '' }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal)
      if (done) break
      if (value !== undefined && value.byteLength > 0) {
        size += value.byteLength
        if (size > FETCH_MAX_BYTES) return { ok: false }
        chunks.push(value)
      }
    }
  } finally {
    // fix-f1e B：读体退出（超限/abort/读完）统一以 cancel 释放挂起 body——仅
    // releaseLock 不会取消底层流，挂起 body 会一直持有 socket/句柄资源不释放。
    try {
      await reader.cancel()
    } catch {
      // 已 abort/已关闭：cancel 失败不掩盖读体期真实错误
    }
    reader.releaseLock()
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(merged) }
}

/** 单次读块（abort 感知）：信号已中止则拒绝；读块命中私有状态时拒绝。 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal?.aborted) throw timeoutError()
  if (signal === undefined) return reader.read()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(timeoutError())
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (r) => { signal.removeEventListener('abort', onAbort); resolve(r) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/** 放弃跳转响应 body（防未读 stream 泄漏句柄；cancel 有界，不做无界 drain）。 */
async function swallowBody(response: FetchResponseLike): Promise<void> {
  if (response.body !== null && response.body !== undefined) {
    try {
      const reader = response.body.getReader()
      // cancel() 直接释放未消费流：不逐块读空（无界 drain 可能在恶意/永不结束的
      // 响应体上无限挂起并耗尽句柄），对拒绝体只做有界放弃。
      await reader.cancel()
      reader.releaseLock()
    } catch { /* 已 abort/空体：忽略 */ }
  }
}

/**
 * F1g：放弃一个尚未读完的响应——取消 body 流 + 强制释放底层连接句柄。
 * 仅拒绝/早期退出路径（类型闸门拒绝、重定向超限、统一 finally 兜底）调用；
 * 成功路径不得调用（不主动 destroy 已完成的连接）。
 */
async function abandonResponse(response: FetchResponseLike): Promise<void> {
  try {
    response.destroy?.()
  } catch { /* 已结束/已销毁：忽略 */ }
  await swallowBody(response)
}

/**
 * F1c：生产安全建连（DNS 绑定消除 TOCTOU）。
 * 连接必须使用 manualRedirectFetch 解析并校验过的 `bind.bindAddresses` 中的地址
 * （默认首个），**绝不重新解析**——预检与连接之间没有二次 DNS，rebinding 窗口闭合。
 * 语义保真：凭据用原始 `bind.hostname` 设 Host 头与 TLS servername（SNI），端口按
 * scheme/显式 port；`redirect:'manual'` 不自动跟随，3xx 以首响应回传给逐跳循环。
 * 返回 body 为 Web ReadableStream（供 readBodyCapped 流式计数）。
 * 仅生产 default 使用；离线测试一律注入 stub（零真实网络）。
 */
function secureConnectFetch(input: string, init?: FetchConnectInit): Promise<FetchResponseLike> {
  const signal = init?.signal
  const bind = init?.bind
  return new Promise<FetchResponseLike>((resolve, reject) => {
    if (bind === undefined) {
      reject(new FetchGateError('bind_missing', '连接绑定信息缺失：必须用已校验地址建连'))
      return
    }
    const address = bind.bindAddresses[0]
    if (address === undefined) {
      reject(new FetchGateError('dns_private_network', '无已校验的可连接地址'))
      return
    }
    let url: URL
    try {
      url = new URL(input)
    } catch (err) {
      reject(new FetchGateError('bad_url', `URL 无法解析：${JSON.stringify(input)}`))
      return
    }
    const isHttps = url.protocol === 'https:'
    const port = url.port !== '' ? Number.parseInt(url.port, 10) : (isHttps ? 443 : 80)
    const headers: Record<string, string | string[]> = {
      ...(init?.headers ?? {}),
      Host: `${bind.hostname}${url.port !== '' ? `:${url.port}` : ''}`,
    }
    const commonOpts = {
      host: address,        // 绑定到已校验地址
      port,
      method: 'GET',
      headers,
      // fix-f1e A：保留原 URL 的 pathname+search（http.request 缺 path 默认请求 `/`，
      // 会把 /articles/42?q=qinggan 打成 /，正文来源错配）
      path: url.pathname + url.search,
      // 显示禁自动跟随；逐跳循环处理 3xx
      agent: false,
    }
    // 目标为主机名时用原始主机名做 TLS SNI/servername（IP 无须）
    const servernameNeeded = !/^[\d.]+$/.test(bind.hostname)
    const reqOpts: HttpsRequestOptions = isHttps && servernameNeeded
      ? { ...commonOpts, servername: bind.hostname }
      : commonOpts
    const abortHandler = () => { req.destroy(new Error('safe-fetch timeout')) }
    if (signal !== undefined) {
      if (signal.aborted) { reject(new Error('safe-fetch timeout')) ; return }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    const req = (isHttps ? httpsRequest : httpRequest)(reqOpts, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      const headersLike: HeadersLike = { get: (name) => res.headers[name.toLowerCase()] as string | undefined ?? null }
      // Node IncomingMessage is a Node Readable；包装为 Web ReadableStream 供读体闸门
      const bodyWeb = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
      // fix-f1e B：不再在收到 headers 时移除 abort 监听——读体期 abort 同样需要
      // 驱动 req.destroy 释放挂起连接（否则挂起 body 的 socket/句柄不释放）。
      // 监听改随响应流生命周期结束（end/close/error）统一清理。
      const releaseAbortHandler = () => {
        if (signal !== undefined) signal.removeEventListener('abort', abortHandler)
      }
      res.once('end', releaseAbortHandler)
      res.once('close', releaseAbortHandler)
      res.once('error', releaseAbortHandler)
      resolve({
        status,
        headers: headersLike,
        body: bodyWeb,
        // F1g：类型拒绝/早期退出路径主动释放底层连接的句柄——摘除 abort 监听后
        // 强制 req.destroy（挂起 body 的 socket/句柄不泄漏）。绝不 abort 调用方
        // signal（此处只 removeEventListener + destroy req，不动控制器本身）。
        destroy: () => {
          if (signal !== undefined) signal.removeEventListener('abort', abortHandler)
          req.destroy(new Error('safe-fetch timeout'))
        },
      })
    })
    req.once('error', (err) => {
      if (signal !== undefined) signal.removeEventListener('abort', abortHandler)
      reject(err)
    })
    req.end()
  })
}

/** 安全直抓（SearchAdapter / fetchBody 生产缺省）：接入全部安全门。 */
export const safeFetchHtml: FetchHtmlFn = async (url, signal) => {
  // safe-fetch 的校验失败以 FetchGateError（reasonCode 稳定）向上抛，由调用方转结构化错误
  return manualRedirectFetch(url, { signal })
}

/** 默认抓取语义的别名导出（search.ts 将 defaultFetchHtml 落回本实现，调用点签名/含义不变）。 */
export { safeFetchHtml as defaultFetchHtml }

/** 供 index/search/测试引用稳定 reasonCode（对外只读常量化，便于断言/结构化错误码）。 */
export const SAFE_FETCH_REASON = {
  TOO_MANY_REDIRECTS: 'too_many_redirects',
  BAD_REDIRECT: 'bad_redirect',
  CONTENT_TYPE: 'content_type',
  CONTENT_TYPE_MISSING: 'content_type_missing',
  TOO_LARGE: 'too_large',
  TIMEOUT: 'timeout',
  DNS_PRIVATE_NETWORK: 'dns_private_network',
  DNS_RESOLUTION_FAILED: 'dns_resolution_failed',
  PRIVATE_NETWORK: 'private_network',
} as const
