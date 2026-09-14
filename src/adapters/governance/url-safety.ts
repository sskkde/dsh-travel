/**
 * 适配器层治理——公开页面抓取 URL 安全与正文不可信处理（W0 T4，草稿 H）。
 *
 * URL 校验（新公开页面抓取）：scheme 仅 http/https、拒私网与危险 URL
 * （环回/私网/链路本地/元数据/本地解析名）、重定向目标逐跳重校验、大小与
 * 内容类型闸门。已明确配置的本机伴随服务走独立受控适配器（rail12306/xhs
 * 伴随服务），不被公网抓取规则混淆（草稿 H：184）。
 *
 * 正文安全：页面正文视为不可信资料——正文里的指令不改变工具权限/研究目标；
 * 入库前按数据转义（HTML 转义 + 伪指令检测标记），界面按文本渲染。
 *
 * F1（Final Wave 补漏）：IPv4-mapped / IPv4-compatible IPv6 与 NAT64 嵌入私网
 * IPv4 一并拒绝（按语义解码末 32 位判私网，不靠字符串前缀漏判）；新增
 * hostIsDeniedAfterResolve 在连接建立前对 DNS 解析出的全部地址复检（域名解析
 * 到私网/环回/链路本地/映射 → 拒）。
 */
import { lookup as dnsLookup } from 'node:dns/promises'
/** 抓取大小上限（单次正文/页面，字节）。 */
export const FETCH_MAX_BYTES = 5 * 1024 * 1024

/** 内容类型白名单（公开页面抓取只接受文本类；二进制/未知 → 拒绝）。 */
export const FETCH_ALLOWED_CONTENT_TYPES = [
  'text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json',
] as const

/** URL/大小/类型判定（reasonCode 稳定供调方作结构化错误码）。 */
export interface UrlSafetyDecision {
  ok: boolean
  reasonCode?: string
  reason?: string
}

/** 判定帮助（ok=false 时收敛 reasonCode）。 */
function deny(reasonCode: string, reason: string): UrlSafetyDecision {
  return { ok: false, reasonCode, reason }
}
function allow(): UrlSafetyDecision {
  return { ok: true }
}

// ────────────────────────── IP/主机分类 ──────────────────────────

function isIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}

/**
 * IPv4 私网/环回/链路本地/保留分类。
 * 闭集覆盖（宁拒勿漏）：0/8（本机源地址，oracle F1c 补漏）、10/8、127/8、
 * 169.254/16（含元数据 169.254.169.254）、168.192/16、172.16-31/12、
 * 100.64/10（CGN，运营商级 NAT）。
 */
function ipv4Octets(literal: string): number[] | undefined {
  const parts = literal.split('.')
  if (parts.length !== 4) return undefined
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return undefined
  const octets = parts.map(Number)
  if (!octets.every((n) => n >= 0 && n <= 255)) return undefined
  return octets
}

/** IPv4 私网/环回/链路本地（含元数据地址 169.254.169.254 / CGN 100.64/10）。 */
function ipv4IsPrivate(literal: string): boolean {
  const parts = ipv4Octets(literal)
  if (parts === undefined) return false
  // 0.0.0.0/8：本机源地址（含 0.1.2.3 等保留），公网不可达 → 拒（oracle F1c 补漏）
  if (parts[0] === 0) return true
  if (parts[0] === 10) return true
  if (parts[0] === 127) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  // 100.64.0.0/10 CGNa（电信级运营商 NAT；公网不可达，视为私网边界）
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
  return false
}

/**
 * 展开 IPv6 地址为 8 个 16 位 hextet（处理 `::` 零压缩；返回 8 个 hextet 数值）。
 * 输入应已去方括号；仅处理纯十六进制段（不做 v4-embedded 紧缩语法，因 URL(WHATWG)
 * hostname 会把地址统一成 8 段十六进制）。解析失败返回 undefined。
 */
function expandIpv6Hextets(addrRaw: string): number[] | undefined {
  const addr = addrRaw.startsWith('[') && addrRaw.endsWith(']') ? addrRaw.slice(1, -1) : addrRaw
  const doubleColonAt = addr.indexOf('::')
  if (doubleColonAt < 0) {
    // 无零压缩：须为恰好 8 段
    const parts = addr.split(':')
    if (parts.length !== 8) return undefined
    return parseHexList(parts)
  }
  if (addr.indexOf('::', doubleColonAt + 2) >= 0) return undefined // 只允许一个 ::
  const leftRaw = addr.slice(0, doubleColonAt)
  const rightRaw = addr.slice(doubleColonAt + 2)
  const left = leftRaw === '' ? [] : leftRaw.split(':')
  const right = rightRaw === '' ? [] : rightRaw.split(':')
  const present = left.length + right.length
  if (present >= 8) return undefined
  const zeroCount = 8 - present
  return parseHexList([...left, ...Array.from({ length: zeroCount }, () => '0'), ...right])
}

function parseHexList(parts: string[]): number[] | undefined {
  const out: number[] = []
  for (const p of parts) {
    if (p === '' || !/^[0-9a-fA-F]{1,4}$/.test(p)) return undefined
    out.push(Number.parseInt(p, 16))
  }
  return out
}

/**
 * 由 IPv6 末 32 位（hextet[6]/hextet[7]）解出嵌入的 IPv4（若该地址按语义携带）。
 * 仅对确系 IPv4-mapped / IPv4-compatible 隧道形态调用（见 ipv6EmbedsV4Private）。
 * 返回解码后的 IPv4 点分串，或 undefined。
 */
function decodeLow32AsIpv4(hextets: number[]): string {
  const h6h = hextets[6]
  const h7h = hextets[7]
  return [h6h >> 8, h6h & 0xff, h7h >> 8, h7h & 0xff].join('.')
}

/**
 * 判定 IPv6 是否为「私网/环回/链路本地」或「隧道形态嵌入私网 IPv4」。
 * 地址先扩成数值 hextet 再按语义归类：既覆盖 ::/::1、fe80::/10、fc00::/7，
 * 也修正 oracle F1 指出的漏判——URL(WHATWG) 会把 ::ffff:dotted / ::dotted 归一为
 * 纯十六进制（如 ::ffff:127.0.0.1 → hextets[5]=ffff、[6..7]=7f00:0001），旧版仅按
 * 字符串前缀 fe/ fc 判断，IPv4-mapped 命中 0 而被放行（真实 SSRF 洞）。
 */
function ipv6IsPrivate(host: string): boolean {
  const lower = host.toLowerCase()
  // 显式常见简写走一次展开（统一处理 dotted / hex / 缺段形态）
  const hextets = expandIpv6Hextets(lower)
  if (hextets === undefined) {
    // 无法判定的畸形 v6 → 拒绝（宁拒勿漏）
    return true
  }
  // ::  全零
  if (hextets.every((h) => h === 0)) return true
  // ::1 环回
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true
  // fe80::/10 链路本地（0xfe80 <= hextet[0] <= 0xfebf，前 10 位 1111111010）
  const top = hextets[0]
  if (top >= 0xfe80 && top <= 0xfebf) return true
  // fc00::/7 ULA（0xfc00 <= hextet[0] <= 0xfdff）
  if (top >= 0xfc00 && top <= 0xfdff) return true
  // 2001:db8::/32 文档地址（RFC 3849；公开页面抓取无意义，拒）
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true

  // 隧道形态（IPv4-mapped / IPv4-compatible / NAT64）把真实 v4 放末 32 位：
  //   若该 v4 为私网/环回 → v6 是私网回程（SSRF 洞）。各类前缀布局各异
  //   （::ffff:x 的 ffff 在第 6 hextet；::ffff:0:x 在第 5；::x 全部置零；NAT64 见下），
  //   统一判「高位段属隧道信号」再解末 32 位做私网判定，避免字符串定式漏网。
  const upperSixAllZero = hextets.slice(0, 6).every((h) => h === 0)
  const ffffInLeading = hextets.slice(0, 6).some((h) => h === 0xffff)
  const nat64 = hextets[0] === 0x0064 && hextets[1] === 0xff9b
  // 普通公网 v6 高位不会全零/带 ffff/显式 64:ff9b，故该谓词对真实 v6 无副作用；
  // 仅对「确实按隧道语义嵌入 IPv4」的形态生效（宁拒勿漏，不伤正常 v6）。
  if (upperSixAllZero || ffffInLeading || nat64) {
    const embedded = decodeLow32AsIpv4(hextets)
    if (embedded !== undefined && ipv4IsPrivate(embedded)) return true
  }
  return false
}

function isIpLiteral(host: string): boolean {
  return isIpv4(host) || host.includes(':')
}

/** 单条实 IP 地址是否危险（供 DNS 解析后逐条复检复用同一定义）。 */
function addressIsDeniedLiteral(addr: string): boolean {
  const stripped = addr.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIpv4(stripped)) return ipv4IsPrivate(stripped)
  if (stripped.includes(':')) return ipv6IsPrivate(stripped)
  // 理论上 DNS 解析不返回域名；出现则宽判（宁拒勿漏）
  return stripped === 'localhost' || stripped.endsWith('.local')
}

/**
 * 域名主机私网/本地判定（URL.hostname 已去方括号；IP 字面量按网段分类）。
 * 返回 deny 决策或 undefined（＝需进一步层判定；非字面量不在此拒绝）。
 */
function hostIsDenied(hostname: string): UrlSafetyDecision | undefined {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local')) {
    return deny('private_network', `目标为本地解析名（${hostname}），拒绝公网抓取`)
  }
  const literal = host.replace(/^\[|\]$/g, '') // WHATWG hostname 对 IPv6 保留方括号
  if (addressIsDeniedLiteral(literal)) {
    return deny('private_network', `目标为私网/环回/链路本地/隧道私网地址（${hostname}），拒绝公网抓取`)
  }
  return undefined
}

/**
 * 连接目标解析（F1c：DNS 绑定消除 TOCTOU）：解析 host 的全部地址并校验，任一为
 * 私网/环回/链路本地/v6 隧道嵌入私网 → 拒绝。成功时返回**已校验通过的连接地址**
 * （调用方必须用它建立连接，而不是另起二次解析——否则预检与连接之间的 DNS
 * rebinding 窗口未闭合）。lookupFn 可由调用方注入（离线测试注入 fixture；生产
 * 缺省 node:dns promises lookup all）。
 */
export type ResolvedConnect =
  | { ok: true; addresses: string[] }
  | { ok: false; decision: UrlSafetyDecision }

export async function resolvePublicConnect(
  hostname: string,
  lookupFn?: LookupFn,
): Promise<ResolvedConnect> {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local')) {
    return { ok: false, decision: deny('private_network', `目标为本地解析名（${hostname}），拒绝公网抓取`) }
  }
  // IP 字面量无需 DNS：直接静态网段分类（mapped/v4 早已在其中）
  const stripped = host.replace(/^\[|\]$/g, '')
  if (isIpLiteral(stripped)) {
    if (addressIsDeniedLiteral(stripped)) {
      return { ok: false, decision: deny('private_network', `目标为字面私网地址（${hostname}），拒绝公网抓取`) }
    }
    return { ok: true, addresses: [stripped] }
  }
  const resolver = lookupFn ?? defaultLookupFn
  let addresses: string[]
  try {
    addresses = await resolver(host)
  } catch (error) {
    // 解析失败本身不可连接，视为「不可达」级拒绝（宁拒勿漏；reasonCode 区分网络异常）
    return {
      ok: false,
      decision: deny(
        'dns_resolution_failed',
        `DNS 解析失败，无法核验目标非私网（${hostname}）：${error instanceof Error ? error.message : String(error)}`,
      ),
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, decision: deny('dns_resolution_failed', `DNS 解析无结果（${hostname})`) }
  }
  for (const addr of addresses) {
    if (addressIsDeniedLiteral(addr)) {
      return { ok: false, decision: deny('dns_private_network', `目标 ${hostname} 解析到私网/环回/链路本地地址（${addr}），拒绝公网抓取`) }
    }
  }
  return { ok: true, addresses }
}

/**
 * 连接前 DNS 解析复检（F1）：解析 host 的全部地址，任一为私网/环回/链路本地/
 * v6 隧道嵌入私网 → 拒绝（稳定 reasonCode=dns_private_network）。lookupFn 可由
 * 调用方注入（离线测试注入 fixture；生产缺省 node:dns promises lookup all）。
 * 防止「域名公网 → CNAME/解析到内网」的 DNS 重绑定/内网回程式 SSRF。
 * （F1c：本函数只做「判」；要真正闭合 rebinding 窗口需连同抓取层一起把连接
 * 绑定到 resolvePublicConnect 返回的已校验地址，而非二次解析。）
 */
export type LookupFn = (host: string) => Promise<string[]>

export async function hostIsDeniedAfterResolve(
  hostname: string,
  lookupFn?: LookupFn,
): Promise<UrlSafetyDecision> {
  const resolved = await resolvePublicConnect(hostname, lookupFn)
  return resolved.ok ? { ok: true } : resolved.decision
}

/** 缺省 DNS 解析器（全地址；node:dns promises lookup）。 */
const defaultLookupFn: LookupFn = async (host) => {
  const result = await dnsLookup(host, { all: true })
  const addrs = result as unknown as Array<{ address: string }>
  return addrs.map((r) => r.address)
}

// ────────────────────────── 校验入口 ──────────────────────────

/**
 * 公开页面抓取 URL 校验：scheme 仅 http/https；无内嵌凭据；目标非私网/
 * 环回/链路本地/元数据；host 非 localhost/*.local。DNS 解析后指向私网的
 * 情形由抓取层在连接建立前复检（本模块为离线确定性部分，network 部分见 W1）。
 */
export function validatePublicFetchUrl(rawUrl: string): UrlSafetyDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return deny('bad_url', `URL 无法解析：${JSON.stringify(rawUrl)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return deny('bad_scheme', `仅允许 http/https（收到 ${url.protocol}）`)
  }
  if (url.username !== '' || url.password !== '') {
    return deny('embedded_credentials', 'URL 不得内嵌用户名/密码凭据')
  }
  const denied = hostIsDenied(url.hostname)
  if (denied !== undefined) return denied
  return allow()
}

/** 重定向目标逐跳重校验（防 http→私网 跳转拿取内网资源）。 */
export function validateRedirectTarget(rawUrl: string): UrlSafetyDecision {
  return validatePublicFetchUrl(rawUrl)
}

/** 抓取大小闸门（超过 FETCH_MAX_BYTES 拒收，防内存放大）。 */
export function checkFetchSize(bytes: number): UrlSafetyDecision {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return deny('invalid_size', `非法大小：${JSON.stringify(bytes)}`)
  }
  if (bytes > FETCH_MAX_BYTES) {
    return deny('too_large', `响应超过抓取大小上限 ${FETCH_MAX_BYTES} 字节（收到 ${bytes}）`)
  }
  return allow()
}

/** 内容类型闸门（只收文本类；未知/二进制类型拒收并记录）。 */
export function checkFetchContentType(contentType: string): UrlSafetyDecision {
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  if ((FETCH_ALLOWED_CONTENT_TYPES as readonly string[]).includes(mediaType)) return allow()
  return deny('content_type', `内容类型不在白名单（${contentType}）；仅接受 ${FETCH_ALLOWED_CONTENT_TYPES.join('/')}`)
}

// ────────────────────────── 正文不可信处理 ──────────────────────────

/** 伪指令特征（正文视为数据，不执行；检测用于打标/恢复展示）。 */
const INSTRUCTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'ignore-previous', re: /ignore\s+(all\s+|any\s+|previous\s+)?instructions?/i },
  { id: 'system-prompt', re: /system\s+prompt/i },
  { id: 'reveal-prompt', re: /reveal\s+(your\s+)?(system\s+)?prompt/i },
  { id: 'ignore-cn', re: /忽略(之前|前面|以上)(的)?(所有)?(指令|提示)/i },
  { id: 'you-are', re: /you\s+are\s+(now\s+)?(an?|a)\s+/i },
]

/** HTML 转义（正文按文本渲染，防 HTML/脚本注入）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 转义后正文（untrusted=true：只作数据展示，不影响工具权限/研究目标）。 */
export interface SanitizedContent {
  safeText: string
  /** 命中的伪指令形态 id（保序去重；供恢复展示/审计）。 */
  directivesDetected: string[]
  untrusted: true
}

/**
 * 正文入库/展示前的安全转义 + 伪指令标记。指令文本以数据保留（不静默删除
 * 内容/反证），绝不改变工具权限或研究目标。
 */
export function sanitizeUntrustedContent(text: string): SanitizedContent {
  const detected: string[] = []
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.re.test(text) && !detected.includes(pattern.id)) detected.push(pattern.id)
  }
  return { safeText: escapeHtml(text), directivesDetected: detected, untrusted: true }
}