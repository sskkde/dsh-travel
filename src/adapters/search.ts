/**
 * 检索适配器（M1 T3 / W2a 适配器 α 双件之二）：L0 宿主搜索 + L0.5 HTTP 直抓。
 *
 * L0（design §5.4 五层降级链）——宿主 web 搜索：
 * - 宿主调用形态 = dsh-web 服务可编程 seam（docs/research/dsh-plugin-api.md Q3/Q5 +
 *   宿主包 dsh-web 源码核实）：`ctx.web.search({query, maxResults}, signal)`
 *   → {content?, sources[{url,title?,snippet?,publishedAt?}], truncated}。
 *   本适配器不依赖 ctx（保持纯模块可测），经构造注入 `hostSearch(query,maxResults)`
 *   抽象；W3 接线层把 `ctx.web.search` 适配进该签名。
 * - site: 构造为**尽力而为非硬过滤**（learnings 行 28）：结果不按域名硬丢弃，
 *   按 hostname 分类平台；多查询变体；去重键 = URL 路径笔记 ID（非 URL 全串，
 *   xsec_token 会话相关）。
 *
 * L0.5（learnings 行 24/27/28）——HTTP 直抓命中 URL：
 * - 小红书 explore：SSR `window.__INITIAL_STATE__` 块固定字段
 *   desc/nickname/time/likedCount/collectedCount/commentCount/shareCount；
 *   互动数为字符串需转数字；时间戳 ms → ISO8601。
 * - 知乎专栏：SSR `js-initialData` 块。
 * - 硬约束：xsec_token 必需且可能时效 → **命中即抓、缓存抓取结果而非 URL**
 *   （缓存键=笔记 ID；同 ID 不同 token URL 二次调用直接命中缓存）；
 *   无 token → 404「页面不见了」→ EngineError.UNAVAILABLE，**单次尝试不重试轰炸**。
 */
import { createHash } from 'node:crypto'
import {
  BaseAdapter, EngineError, toEngineError, toIsoTimestamp, type CanonicalResult,
} from './base.js'
import { SEARCH_L05_USAGE_SOURCE, type UsageRecorder } from '../metrics/usage.js'
import type { IntelChannel, IntelItem, SourceRef } from '../models/types.js'
import type { XhsContentFailureReason, XhsSessionToken, XhsTokenCache } from './xhs.js'
import { normalizePublishedAt } from '../models/validate.js'
import { safeFetchHtml } from './safe-fetch.js'

// L0.5 缺省直抓 = 安全抓取层（F1：逐跳 URL/DNS 门 + content-type + 流式大小门）。
// 兼容既有导入点（index.ts / research-content handler / SearchAdapter 内部缺省），
// 签名（FetchHtmlFn 语义）与调用点含义不变，仅实现换成安全门闭环后的抓取。
export { safeFetchHtml as defaultFetchHtml } from './safe-fetch.js'

// ────────────────────────── 宿主/直抓注入面 ──────────────────────────

/** 宿主搜索源（dsh-web `ctx.web.search` 的规范化投影；与 WebSearchSource 同构）。 */
export interface HostSearchSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export interface HostSearchResult {
  content?: string
  sources: readonly HostSearchSource[]
  truncated: boolean
}

export type HostSearchFn =
  (query: string, maxResults?: number, signal?: AbortSignal) => Promise<HostSearchResult>

/** 直抓结果（HTTP 层；非 2xx 也是结果，由适配器判定）。 */
export interface FetchedHtml {
  status: number
  text: string
  /** 终跳响应正确的 content-type（可能缺）；缺则由上层文本闸门兜底。 */
  contentType?: string
  /** 跟随重定向后的最终 URL（无重定向 == 首 URL）。 */
  finalUrl?: string
}

export type FetchHtmlFn = (url: string, signal?: AbortSignal) => Promise<FetchedHtml>

const CACHE_CAP = 128

// ────────────────────────── Canonical 输出类型 ──────────────────────────

export type L0Platform = 'xhs' | 'zhihu' | 'douyin' | 'web'

/** L0 命中（种子发现层：标题/摘要/URL；小红书=带 token 的 explore URL）。 */
export interface L0Hit {
  /** 去重键：xhs=URL 路径笔记 ID；其余平台同（zhihu /p/<id>、douyin 数字 ID）；无 ID 用 URL 全串。 */
  id: string
  platform: L0Platform
  title: string
  summary?: string
  url: string
  /** ISO8601（宿主返回即带）。 */
  publishedAt?: string
  source: SourceRef
}

export interface L0SearchResult {
  hits: L0Hit[]
  /** 实际发出的查询（调试/降级说明用）。 */
  queries: string[]
}

/** L0.5 结构化条目（正文全文 + 作者 + 时间 + 互动数据）。 */
export interface SocialInteractions {
  likes: number
  collects?: number
  comments?: number
  shares?: number
}

export interface SocialPost {
  /** 已从 URL 剥除 xsec_token 等会话参数的规范化 URL。 */
  url: string
  /** 去重键（URL 路径段；xhs 笔记 ID / zhihu 文章 ID）。 */
  noteId: string
  platform: 'xhs' | 'zhihu'
  title: string
  /** 正文全文（HTML 已剥标签）。 */
  content: string
  author?: string
  /**
   * 发布时间（ISO8601，R-6 诚实）：仅当来源 SSR 显式给出时间字段才记；
   * 缺失（无 createdTime/pubdate/time）时留空——绝不拿抓取时刻冒充发布日期。
   */
  publishedAt?: string
  interactions?: SocialInteractions
  fetchedAt: string
}

export interface FetchedPostResult {
  post: SocialPost
  /** 命中缓存（同笔记 ID 二次调用未发网络请求）。 */
  cached: boolean
}

// ────────────────────────── URL 工具 ──────────────────────────

/** 只识别查询键，不把普通正文中的 token/secret 单词误当成凭据。 */
const SENSITIVE_QUERY_SEGMENTS = new Set(['token', 'secret', 'credential', 'authorization'])
const QUERY_PARAMETER_RE = /([?&#;])([^?&#;=\s"'<>]+)=([^?&#;"'<>]*)/g

function decodeQueryKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '))
  } catch {
    // 畸形百分号编码按原文判定；不能解码时不猜测普通键。
    return rawKey
  }
}

function normalizeQueryKey(rawKey: string): string {
  return decodeQueryKey(rawKey)
    // 先拆 acronym→Word，再拆 lower/digit→Upper，覆盖 APIKey、authToken 等写法。
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
}

function isSensitiveQueryKey(rawKey: string): boolean {
  const normalized = normalizeQueryKey(rawKey)
  const segments = normalized.split('_').filter(Boolean)
  return segments.some((segment) => SENSITIVE_QUERY_SEGMENTS.has(segment))
    || (segments[0] === 'xsec' && segments.length > 1)
    || normalized === 'api_key'
    || normalized === 'apikey'
    || (segments.includes('api') && segments.includes('key'))
}

/** Resolver 凭据：xsec_source 是来源标记，不是可抓取 token；保留既有 token 键兼容。 */
const XHS_CREDENTIAL_QUERY_KEY_RE = /^(?:access_token|refresh_token|xsec_token|token)$/i
const XHS_REDACTED_VALUE_RE = /(?:\[redacted\]|<redacted>|redacted)/i

function hasUsableXhsCredential(rawUrl: string): boolean {
  return extractXhsSessionToken(rawUrl) !== undefined
}

/** 从受信 XHS URL 提取单个凭据；只返回令牌值/键，不保存 URL。 */
function extractXhsSessionToken(rawUrl: string): XhsSessionToken | undefined {
  try {
    const parsed = new URL(rawUrl)
    for (const [rawKey, rawValue] of parsed.searchParams) {
      if (!XHS_CREDENTIAL_QUERY_KEY_RE.test(rawKey)) continue
      let value = rawValue.trim()
      // URLSearchParams 已解码一层；再解少量包装层，避免双编码的 [REDACTED]
      // 被误当成可用凭据而绕过缓存/直抓门。
      for (let depth = 0; depth < 3; depth++) {
        if (XHS_REDACTED_VALUE_RE.test(value)) break
        try {
          const decoded = decodeURIComponent(value.replace(/\+/g, ' ')).trim()
          if (decoded === value) break
          value = decoded
        } catch {
          break
        }
      }
      if (value !== '' && !XHS_REDACTED_VALUE_RE.test(value)) {
        const queryKey = rawKey.toLowerCase() as XhsSessionToken['queryKey']
        return { token: value, queryKey }
      }
    }
  } catch {
    // trustedXhsUrl 已先做 URL 解析；解析失败时按无凭据处理。
  }
  return undefined
}

function xhsUrlFromSessionToken(noteId: string, token: XhsSessionToken): string {
  const query = new URLSearchParams([[token.queryKey, token.token]])
  return `${canonicalXhsUrl(noteId)}?${query.toString()}`
}

function trustedXhsHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'xiaohongshu.com' || host === 'www.xiaohongshu.com'
}

/** raw token URL 仅允许官方 host + 精确 noteId 路径进入受控内存 resolver。 */
function trustedXhsUrl(rawUrl: string, noteId: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' || parsed.port !== '' || !trustedXhsHost(parsed.hostname)) return undefined
    const pathId = /^\/(?:explore|discovery\/item)\/([0-9A-Za-z]+)\/?$/.exec(parsed.pathname)?.[1]
    if (pathId !== noteId) return undefined
    return rawUrl
  } catch {
    return undefined
  }
}

/** 直接命中缓存前仍须通过请求 URL 的 host/path/敏感 query 门。 */
function cacheEligibleXhsUrl(rawUrl: string, noteId: string): boolean {
  const trusted = trustedXhsUrl(rawUrl, noteId)
  if (trusted === undefined) return false
  try {
    const parsed = new URL(trusted)
    return parsed.search === '' || hasUsableXhsCredential(trusted)
  } catch {
    return false
  }
}

/** 平台分类（hostname 判定，尽力而为：非目标域同样保留，归 web）。 */
export function classifyPlatform(url: string): L0Platform {
  const lower = url.toLowerCase()
  if (/xiaohongshu\.com/.test(lower)) return 'xhs'
  if (/zhihu\.com/.test(lower)) return 'zhihu'
  if (/douyin\.com/.test(lower)) return 'douyin'
  return 'web'
}

/** 去重键 = URL 路径段笔记 ID（铁律：非 URL 全串；xsec_token 会话相关）。 */
export function extractNoteId(url: string): string | undefined {
  const xhs = /\/(?:explore|discovery\/item)\/([0-9A-Za-z]+)/.exec(url)
  if (xhs) return xhs[1]
  const zhihu = /zhuanlan\.zhihu\.com\/p\/(\d+)/.exec(url)
  if (zhihu) return zhihu[1]
  const douyin = /\/(?:shipin|note)\/(\d+)/.exec(url)
  if (douyin) return douyin[1]
  return undefined
}

/** 小红书规范化 URL（剥 xsec_token/xsec_source 等会话参数，防 token 落盘泄漏）。 */
export function canonicalXhsUrl(noteId: string): string {
  return `https://www.xiaohongshu.com/explore/${noteId}`
}

/** 剥 HTML 标签 → 空白折叠（知乎正文等富文本）。 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// ────────────────────────── SSR 解析工具 ──────────────────────────

/**
 * 平衡大括号提取 `window.__INITIAL_STATE__ = {...}` 原始文本（容忍裸 `undefined`，
 * 字符串内引号/转义正确跳过；结束于 `}`，不限 `;`/`</script>` 跟随）。
 */
export function extractInitialState(html: string): string | undefined {
  const marker = 'window.__INITIAL_STATE__'
  const idx = html.indexOf(marker)
  if (idx < 0) return undefined
  const eq = html.indexOf('=', idx)
  if (eq < 0) return undefined
  let i = eq + 1
  while (i < html.length && /\s/.test(html[i])) i++
  if (html[i] !== '{') return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let k = i; k < html.length; k++) {
    const ch = html[k]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return html.slice(i, k + 1)
    }
  }
  return undefined
}

/** 提取 `<script id="js-initialData" type="text/json">…</script>` 正文（知乎）。 */
export function extractJsInitialData(html: string): string | undefined {
  const m = /<script[^>]*id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
  return m ? m[1].trim() : undefined
}

/** 容错解析：裸 `undefined` token → null（INITIAL_STATE 常见；只替换值位置）。 */
export function cleanUndefinedTokens(text: string): string {
  return text.replace(/\bundefined\b(?=\s*[,}\]])/g, 'null')
}

export function parseInitialStateJson(html: string): Record<string, unknown> | undefined {
  const raw = extractInitialState(html)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(cleanUndefinedTokens(raw))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

// ────────────────────────── 窄化助手 ──────────────────────────

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function intNum(value: unknown): number | undefined {
  // xhs 互动数为字符串（"40"）；容忍数字串与原生数字
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function objValues(root: unknown): unknown[] {
  const obj = rec(root)
  if (!obj) return []
  return Object.values(obj)
}

// ────────────────────────── 适配器 ──────────────────────────

export interface SearchAdapterOptions {
  /** L0 宿主搜索注入（W3 接线层传 `ctx.web.search` 适配签名；缺省=无 → L0 unavailable）。 */
  hostSearch?: HostSearchFn
  /** 与 XhsAdapter 共享的 planId+noteId 短时 token 通道。 */
  xhsTokenCache?: XhsTokenCache
  /** L0.5 直抓注入（缺省 global fetch + 桌面 UA）。 */
  fetchHtml?: FetchHtmlFn
  /** 用量记录器（M3.3 只观测；缺省回落模块级默认单例，index.ts 注入落盘实例）。 */
  usage?: UsageRecorder
}

export interface L0SearchQuery {
  /** 计划作用域；XHS 临时凭据只按 planId+noteId 进入内存缓存。 */
  planId?: string
  keywords: string
  /** 目标站（构造 `keywords site:<site>`，尽力而为非硬过滤）。 */
  sites?: string[]
  maxResultsPerQuery?: number
}

export class SearchAdapter extends BaseAdapter {
  private readonly hostSearch: HostSearchFn | undefined
  private readonly fetchHtml: FetchHtmlFn
  readonly xhsTokenCache: XhsTokenCache | undefined
  /** 缓存抓取结果（默认键=笔记 ID；带 planId 时按计划隔离）而非 URL。 */
  private readonly cache = new Map<string, { post: SocialPost; at: string }>()
  /** L0 命中的 raw URL 临时 resolver；永不返回/序列化，仅供本实例后续 fetch 使用。 */
  private readonly xhsUrlResolver = new Map<string, string>()

  constructor(options: SearchAdapterOptions = {}) {
    super('search-l0', { supports: new Set<string>() }, { usage: options.usage })
    this.hostSearch = options.hostSearch
    this.xhsTokenCache = options.xhsTokenCache
    this.fetchHtml = options.fetchHtml ?? safeFetchHtml
  }

  /** L0 需要宿主搜索注入；L0.5 只要有直抓能力即可用。 */
  async available(): Promise<boolean> {
    return this.hostSearch !== undefined
  }

  /** L0.5 独立可用性（直抓通道常开；供 W3 前置过滤区分 L0/L0.5）。 */
  l05Available(): boolean {
    return true
  }

  /** 清空直抓缓存（测试/开关用）。 */
  clearCache(): void {
    this.cache.clear()
    this.xhsUrlResolver.clear()
  }

  // ── L0：宿主 web 搜索（site: 构造 → 分类 → 笔记 ID 去重） ──

  async searchL0(query: L0SearchQuery): Promise<CanonicalResult<L0SearchResult>> {
    if (!query.keywords) {
      throw EngineError.unavailable('L0 搜索关键词为空', 'search-l0')
    }
    if (!this.hostSearch) {
      throw EngineError.unavailable('宿主 web 搜索未注入（L0 不可用；走 L0.5 直抓或降级）', 'search-l0')
    }
    try {
      // site: 尽力而为：每目标站一查询变体 + 裸关键词变体；不硬过滤结果
      const queries: string[] = []
      for (const site of query.sites ?? []) queries.push(`${query.keywords} site:${site}`)
      queries.push(query.keywords)
      const maxResults = query.maxResultsPerQuery ?? 8
      const hits: L0Hit[] = []
      for (const q of queries) {
        // M3.3 只观测：每次宿主搜索调用 = 1 次 L0 query（含 site: 变体）
        this.usage.recordSearchL0()
        const result = await this.hostSearch(q, maxResults)
        for (const source of result.sources) {
          const hit = toL0Hit(source)
          if (hit.platform === 'xhs') this.rememberXhsUrl(hit.id, source.url, query.planId)
          hits.push(hit)
        }
      }
      const deduped = dedupeL0Hits(hits)
      if (deduped.length === 0) {
        throw EngineError.empty('L0 搜索无命中', 'search-l0')
      }
      const safeQueries = queries.map((value) => redactSensitiveText(value))
      const source = {
        platform: 'host-web-search',
        url: `https://example.invalid/l0?q=${encodeURIComponent(redactSensitiveText(query.keywords))}`,
        fetchedAt: new Date().toISOString(),
      }
      return { data: { hits: deduped, queries: safeQueries }, source }
    } catch (err) {
      throw this.asEngineError(err, 'search-l0', 'L0 搜索失败')
    }
  }

  // ── L0.5：小红书 explore SSR 直抓 ──

  /** 命中即抓；带 planId 时正文缓存与令牌均按计划隔离；无 fresh URL/404 不重试轰炸。 */
  async fetchXhsNote(url: string, signal?: AbortSignal, planId?: string): Promise<FetchedPostResult> {
    const noteId = extractXhsNoteId(url)
    if (!noteId) {
      throw EngineError.unavailable(`小红书 explore URL 无笔记 ID：${redactSensitiveUrl(url)}`, 'search-l0.5')
    }
    const cacheKey = this.xhsPostCacheKey(noteId, planId)
    const cached = cacheEligibleXhsUrl(url, noteId) ? this.cache.get(cacheKey) : undefined
    if (cached !== undefined) {
      this.recordL05Usage(true)
      return { post: cached.post, cached: true }
    }
    this.recordL05Usage(false)
    let activeCredential: string | undefined
    let freshFailureReason: XhsContentFailureReason | undefined
    try {
      // raw token URL 只在受信 host/path 且调用者确实提供凭据时直抓。
      // 带 planId 的 canonical URL 只能消费该计划的短时 token，禁止借用另一计划
      // 的无作用域 resolver；缓存未命中后仅允许一次同 noteId 宿主回源。
      const direct = trustedXhsUrl(url, noteId)
      let fetchUrl: string | undefined
      if (direct !== undefined && hasUsableXhsCredential(direct)) {
        fetchUrl = direct
      } else if (planId !== undefined) {
        const session = this.xhsTokenCache?.get(planId, noteId)
        fetchUrl = session === undefined ? undefined : xhsUrlFromSessionToken(noteId, session)
      } else {
        fetchUrl = this.xhsUrlResolver.get(noteId)
      }
      if (fetchUrl === undefined) {
        const resolved = await this.resolveFreshXhsUrl(noteId, planId)
        fetchUrl = resolved.url
        freshFailureReason = resolved.failureReason
      }
      if (fetchUrl === undefined) {
        const reason = freshFailureReason ?? 'token_unusable'
        throw EngineError.unavailable(
          `[${reason}] 小红书 noteId=${noteId} 无可用 fresh URL，无法安全抓取`,
          'search-l0.5',
        )
      }
      const trustedFetchUrl = trustedXhsUrl(fetchUrl, noteId)
      if (trustedFetchUrl === undefined || !hasUsableXhsCredential(trustedFetchUrl)) {
        throw EngineError.unavailable(`[token_unusable] 小红书 noteId=${noteId} fresh URL 未通过 host/path/credential 校验`, 'search-l0.5')
      }
      activeCredential = extractXhsSessionToken(trustedFetchUrl)?.token
      const { status, text } = await this.fetchHtml(trustedFetchUrl, signal)
      if (status === 404 || /页面不见了|你访问的页面不存在/.test(text)) {
        // 无 xsec_token / token 失效 → 404 shell；不重试轰炸。
        throw EngineError.unavailable(`[token_unusable] 小红书 explore 404（URL 失效或无 xsec_token）：${noteId}`, 'search-l0.5')
      }
      if (status < 200 || status >= 300) {
        throw EngineError.unavailable(`小红书 explore HTTP ${status}`, 'search-l0.5')
      }
      const post = redactSocialPost(parseXhsExplore(text, noteId, trustedFetchUrl))
      this.putCache(cacheKey, post)
      return { post, cached: false }
    } catch (err) {
      throw this.asEngineError(err, 'search-l0.5', `小红书直抓失败（${noteId}）`, activeCredential)
    }
  }

  // ── L0.5：知乎专栏 ──

  async fetchZhihuZhuanlan(url: string, signal?: AbortSignal): Promise<FetchedPostResult> {
    const m = /zhuanlan\.zhihu\.com\/p\/(\d+)/.exec(url)
    const articleId = m ? m[1] : undefined
    if (!articleId) {
      throw EngineError.unavailable(`知乎专栏 URL 无文章 ID：${redactSensitiveUrl(url)}`, 'search-l0.5')
    }
    const cached = this.cache.get(articleId)
    if (cached !== undefined) {
      this.recordL05Usage(true)
      return { post: cached.post, cached: true }
    }
    this.recordL05Usage(false)
    try {
      const { status, text } = await this.fetchHtml(url, signal)
      if (status === 403 || status === 404 || status >= 500) {
        throw EngineError.unavailable(`知乎专栏 HTTP ${status}（风控或不可达）`, 'search-l0.5')
      }
      if (status < 200 || status >= 300) {
        throw EngineError.unavailable(`知乎专栏 HTTP ${status}`, 'search-l0.5')
      }
      const post = redactSocialPost(parseZhihuZhuanlan(text, articleId, url))
      this.putCache(articleId, post)
      return { post, cached: false }
    } catch (err) {
      throw this.asEngineError(err, 'search-l0.5', `知乎专栏直抓失败（${articleId}）`)
    }
  }

  // ── 内部 ──

  private xhsPostCacheKey(noteId: string, planId?: string): string {
    return planId === undefined ? noteId : `${planId}\u0000${noteId}`
  }

  /** M3.3 只观测：L0.5 缓存命中/未命中 + 直抓/网络计数（不改「命中即抓、缓存抓取结果」语义）。 */
  private recordL05Usage(cacheHit: boolean): void {
    this.usage.recordCache(SEARCH_L05_USAGE_SOURCE, cacheHit)
    if (!cacheHit) {
      this.usage.recordNetwork(SEARCH_L05_USAGE_SOURCE)
      this.usage.recordSearchL05Fetch()
    }
  }

  private rememberXhsUrl(noteId: string, rawUrl: string, planId?: string): void {
    const trusted = trustedXhsUrl(rawUrl, noteId)
    if (trusted === undefined || !hasUsableXhsCredential(trusted)) return
    const session = extractXhsSessionToken(trusted)
    if (planId !== undefined && session !== undefined) {
      this.xhsTokenCache?.remember(planId, noteId, session.token, session.queryKey)
      return
    }
    if (this.xhsUrlResolver.size >= CACHE_CAP && !this.xhsUrlResolver.has(noteId)) {
      const oldest = this.xhsUrlResolver.keys().next().value
      if (oldest !== undefined) this.xhsUrlResolver.delete(oldest)
    }
    this.xhsUrlResolver.set(noteId, trusted)
  }

  private async resolveFreshXhsUrl(
    noteId: string,
    planId?: string,
  ): Promise<{ url?: string; failureReason?: XhsContentFailureReason }> {
    const hostSearch = this.hostSearch
    if (hostSearch === undefined) return { failureReason: 'no_host_search' }
    // 这是 canonical URL 丢失 token 后唯一的一次补搜，不调用 searchL0 以免展开多查询变体。
    try {
      this.usage.recordSearchL0()
      const result = await hostSearch(noteId, 8)
      let sameNoteFound = false
      for (const source of result.sources) {
        const candidateId = extractXhsNoteId(source.url)
        if (candidateId !== noteId) continue
        sameNoteFound = true
        const trusted = trustedXhsUrl(source.url, noteId)
        if (trusted === undefined || !hasUsableXhsCredential(trusted)) continue
        this.rememberXhsUrl(noteId, trusted, planId)
        return { url: trusted }
      }
      return { failureReason: sameNoteFound ? 'token_unusable' : 'note_not_found' }
    } catch {
      // 宿主搜索调用失败：通道存在但无法提供可用凭据，归入续期失败。
      return { failureReason: 'token_unusable' }
    }
  }

  private putCache(noteId: string, post: SocialPost): void {
    if (this.cache.size >= CACHE_CAP) {
      // LRU 近似：淘汰最早插入键（Map 迭代序）
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(noteId, { post, at: post.fetchedAt })
  }

  private asEngineError(err: unknown, source: string, fallback: string, sensitiveValue?: string): EngineError {
    const sanitize = (raw: string): string => {
      const redacted = redactSensitiveText(raw)
      return sensitiveValue === undefined || sensitiveValue === ''
        ? redacted
        : redacted.split(sensitiveValue).join('[REDACTED]')
    }
    if (err instanceof EngineError) {
      return new EngineError(err.code, sanitize(err.message), err.source ?? source)
    }
    const message = sanitize(err instanceof Error ? err.message : String(err))
    if (err instanceof Error && /Timeout|Abort/i.test(err.name)) {
      return EngineError.timeout(`${fallback}（${message}）`, source)
    }
    return toEngineError(new Error(`${fallback}（${message}）`), source)
  }
}

// ────────────────────────── L0 归一化纯函数 ──────────────────────────

/**
 * 自由文本中的 URL 凭据前缀（userinfo）：`scheme://user[:pass]@host` 与
 * 协议相对形式 `//user[:pass]@host`。
 *
 * 只吃 authority 段（遇 `/`、空白、引号、尖括号即停），因此 host/path/query 全部
 * 保留；没有 `@` 的正常 URL 不匹配。scheme 限 http(s)：其它 scheme（如 mailto:）
 * 的 `@` 是地址分隔符而非凭据，误删会破坏文本语义。
 */
const TEXT_URL_USERINFO_RE = /(https?:\/\/|\/\/)[^\s/?#@"'<>]+(?::[^\s/?#@"'<>]*)?@/gi

/** 文本持久化前移除 URL userinfo 与 query 中 token/secret 类凭据（含畸形/百分号编码 URL）。 */
export function redactSensitiveText(text: string): string {
  // ① 先清 userinfo（保留 scheme/`//` 前缀与 host/path/query）；
  // ② 再按 query 键脱敏（含仅存于文本中的 URL）。
  const withoutUserInfo = text.replace(TEXT_URL_USERINFO_RE, (_match, prefix: string) => prefix)
  return withoutUserInfo.replace(QUERY_PARAMETER_RE, (match, prefix: string, rawKey: string) => {
    return isSensitiveQueryKey(rawKey) ? `${prefix}${rawKey}=[REDACTED]` : match
  })
}

/** 持久化前移除 URL 查询中的敏感凭据；抓取时仍使用受控内存中的原 URL。 */
function redactQuery(rawQuery: string): string {
  const parts = rawQuery === '' ? [] : rawQuery.split(/[&;]/)
  return parts.filter((part) => {
    const equals = part.indexOf('=')
    return equals < 0 || !isSensitiveQueryKey(part.slice(0, equals))
  }).join('&')
}

export function redactSensitiveUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const safeQuery = redactQuery(url.search.slice(1))
    const safeHash = redactSensitiveText(url.hash)
    const hadUserInfo = url.username !== '' || url.password !== ''
    if (hadUserInfo) {
      // URL.username/password setters are deliberately used instead of string
      // slicing so percent-encoded credentials cannot survive in the authority.
      url.username = ''
      url.password = ''
    }
    const queryChanged = safeQuery !== url.search.slice(1)
    const hashChanged = safeHash !== url.hash
    if (queryChanged) url.search = safeQuery.length > 0 ? `?${safeQuery}` : ''
    if (hashChanged) url.hash = safeHash.startsWith('#') ? safeHash : `#${safeHash}`
    return hadUserInfo || queryChanged || hashChanged ? url.toString() : rawUrl
  } catch {
    // A malformed URL cannot be parsed for authority/query structure, but the
    // text sanitizer still removes known sensitive query values.  Also strip
    // conventional http(s) and protocol-relative userinfo prefixes.
    const withoutUserInfo = rawUrl.replace(/^(?:(?:https?:)?\/\/)[^\s/@]+(?::[^\s/@]*)?@/i, (match) => match.startsWith('//') ? '//' : `${match.match(/^https?:\/\//i)?.[0] ?? '//'}`)
    return redactSensitiveText(withoutUserInfo)
  }
}

function redactSocialPost(post: SocialPost): SocialPost {
  return {
    ...post,
    url: redactSensitiveUrl(post.url),
    noteId: redactSensitiveText(post.noteId),
    title: redactSensitiveText(post.title),
    content: redactSensitiveText(post.content),
    ...(post.author !== undefined ? { author: redactSensitiveText(post.author) } : {}),
    ...(post.publishedAt !== undefined ? { publishedAt: redactSensitiveText(post.publishedAt) } : {}),
  }
}

export function toL0Hit(source: HostSearchSource): L0Hit {
  const safeUrl = redactSensitiveUrl(source.url)
  const platform = classifyPlatform(source.url)
  // P1-C R2：无平台 noteId 的 URL 不能直接成为路径 id；保持稳定、无斜杠的 web 哈希。
  const id = extractNoteId(source.url) ?? `web:${createHash('sha1').update(safeUrl).digest('hex')}`
  // 宿主 seam 的字段是不受信外部 JSON：非字符串（null/数字/对象）一律按缺席处理，
  // 否则 redact* 的 .replace 会抛 TypeError 使整轮 L0 搜索失败（2026-09-12 复跑实测：
  // SearXNG 桥接返回 title=null → L0 搜索失败 → 整条 L0 通道降级）。
  const asText = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  const title = asText(source.title)
  const snippet = asText(source.snippet)
  const publishedAt = asText(source.publishedAt)
  return {
    id,
    platform,
    title: title === undefined ? safeUrl : redactSensitiveText(title),
    summary: snippet === undefined ? undefined : redactSensitiveText(snippet),
    url: safeUrl,
    publishedAt: publishedAt === undefined ? undefined : redactSensitiveText(publishedAt),
    source: {
      platform: `host-search:${platform}`,
      url: safeUrl,
      fetchedAt: new Date().toISOString(),
    },
  }
}

/** 跨查询去重：键=笔记 ID（xhs/zhihu/douyin 路径段），无 ID 回落 URL 全串。 */
export function dedupeL0Hits(hits: L0Hit[]): L0Hit[] {
  const seen = new Map<string, L0Hit>()
  for (const hit of hits) {
    const key = extractNoteId(hit.url) ?? hit.url
    if (seen.has(key)) continue
    seen.set(key, hit)
  }
  return [...seen.values()]
}

function extractXhsNoteId(url: string): string | undefined {
  const m = /\/(?:explore|discovery\/item)\/([0-9A-Za-z]+)/.exec(url)
  return m ? m[1] : undefined
}

// ────────────────────────── 平台解析纯函数（可单测直连） ──────────────────────────

/** 小红书 explore SSR → SocialPost（字段名固定：desc/nickname/time/liked…）。 */
export function parseXhsExplore(html: string, noteId: string, _originalUrl: string): SocialPost {
  const state = parseInitialStateJson(html)
  const noteMap = rec(rec(state)?.note)?.noteDetailMap
  let note: Record<string, unknown> | undefined
  if (noteMap !== undefined) {
    for (const entry of objValues(noteMap)) {
      const candidate = rec(rec(entry)?.note)
      if (candidate !== undefined && str(candidate.desc) !== undefined) {
        note = candidate
        break
      }
    }
  }
  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)
  const title = str(note?.title) ?? (ogTitle ? ogTitle[1] : undefined) ?? `小红书笔记 ${noteId}`
  const content = str(note?.desc) ?? ''
  if (!content) {
    throw EngineError.unavailable('[token_unusable] 小红书 explore 无正文（页面结构异常或无 token）', 'search-l0.5')
  }
  const user = rec(note?.user)
  const interact = rec(note?.interactInfo)
  const timeMs = intNum(note?.time)
  return {
    url: canonicalXhsUrl(noteId),
    noteId,
    platform: 'xhs',
    title,
    content,
    author: str(user?.nickname),
    ...(timeMs !== undefined && timeMs > 0 ? { publishedAt: toIsoTimestamp(timeMs) } : {}),
    interactions: {
      likes: intNum(interact?.likedCount) ?? 0,
      collects: intNum(interact?.collectedCount),
      comments: intNum(interact?.commentCount),
      shares: intNum(interact?.shareCount),
    },
    fetchedAt: new Date().toISOString(),
  }
}

/** 知乎专栏 → SocialPost（js-initialData 优先，__INITIAL_STATE__ 兜底）。 */
export function parseZhihuZhuanlan(html: string, articleId: string, _originalUrl: string): SocialPost {
  const initialJson = extractJsInitialData(html)
  const fromState = (() => {
    if (initialJson !== undefined) {
      try {
        return JSON.parse(initialJson) as Record<string, unknown>
      } catch {
        return undefined
      }
    }
    return parseInitialStateJson(html)
  })()

  let article: Record<string, unknown> | undefined
  const articlesRaw = rec(rec(rec(fromState)?.initialState)?.entities)?.articles
  const articles = rec(articlesRaw)
  if (articles !== undefined) {
    const matched = rec(articles[articleId])
    if (matched !== undefined) {
      article = matched
    } else {
      // 找不到 ID 键：取第一个含 title+content 的文章条目
      for (const entry of objValues(articles)) {
        const candidate = rec(entry)
        if (candidate !== undefined && str(candidate.content) !== undefined) {
          article = candidate
          break
        }
      }
    }
  }
  const contentHtml = str(article?.content)
  const content = contentHtml !== undefined ? stripHtmlTags(contentHtml) : ''
  if (!content) {
    throw EngineError.empty('知乎专栏正文为空（未命中 SSR 文章块）', 'search-l0.5')
  }
  const author = rec(article?.author)
  const createdSeconds = intNum(article?.createdTime)
  const updatedSeconds = intNum(article?.updatedTime)
  const zhihuPublishedEpoch = createdSeconds ?? updatedSeconds
  return {
    url: `https://zhuanlan.zhihu.com/p/${articleId}`,
    noteId: articleId,
    platform: 'zhihu',
    title: str(article?.title) ?? `知乎专栏 ${articleId}`,
    content,
    author: str(author?.name),
    ...(zhihuPublishedEpoch !== undefined && zhihuPublishedEpoch > 0
      ? { publishedAt: toIsoTimestamp(zhihuPublishedEpoch) }
      : {}),
    interactions: {
      likes: intNum(article?.voteupCount) ?? 0,
      comments: intNum(article?.commentCount),
    },
    fetchedAt: new Date().toISOString(),
  }
}

// ────────────────────────── IntelItem 映射（W3 fan-out 复用） ──────────────────────────

/** L0 命中 → IntelItem（标题级摘要，confidence low）。 */
export function l0HitToIntelItem(hit: L0Hit): IntelItem {
  const title = redactSensitiveText(hit.title)
  const summary = hit.summary === undefined ? '（标题级摘要，正文待直抓）' : redactSensitiveText(hit.summary)
  const url = redactSensitiveUrl(hit.url)
  return {
    id: `l0:${redactSensitiveText(hit.id)}`,
    category: classifyIntelCategory(title, summary),
    channel: l0Channel(hit.platform),
    title,
    summary,
    source: { platform: `host-search:${hit.platform}`, url, fetchedAt: hit.source.fetchedAt },
    confidence: 'low',
    ...(normalizePublishedAt(hit.publishedAt) !== undefined
      ? { publishedAt: normalizePublishedAt(hit.publishedAt) } : {}),
  }
}


/** L0.5 结构化条目 → IntelItem（正文摘要 + 结构化社媒元信息，confidence medium）。 */
export function socialPostToIntelItem(post: SocialPost): IntelItem {
  const title = redactSensitiveText(post.title)
  const content = redactSensitiveText(post.content)
  const author = post.author === undefined ? undefined : redactSensitiveText(post.author)
  const interactions = post.interactions
  const metrics = {
    likes: interactions?.likes,
    collects: interactions?.collects,
    comments: interactions?.comments,
    shares: interactions?.shares,
  }
  const hasMetrics = Object.values(metrics).some((value) => value !== undefined)
  return {
    id: `${post.platform}:${redactSensitiveText(post.noteId)}`,
    category: classifyIntelCategory(title, content),
    channel: l05Channel(post.platform),
    title,
    // summary 只承载正文语义；作者/互动数等元信息进入冻结结构化字段。
    summary: content !== '' ? content.slice(0, 140) : '（社媒命中，正文待详情抓取）',
    ...(author !== undefined ? { author } : {}),
    ...(hasMetrics ? { metrics } : {}),
    ...(content !== '' ? { content } : {}),
    source: { platform: post.platform, url: redactSensitiveUrl(post.url), fetchedAt: post.fetchedAt },
    confidence: 'medium',
    ...(normalizePublishedAt(post.publishedAt) !== undefined
      ? { publishedAt: normalizePublishedAt(post.publishedAt) } : {}),
  }
}

function l0Channel(platform: L0Platform): IntelChannel {
  switch (platform) {
    case 'xhs': return 'xhs-l0'
    case 'zhihu': return 'zhihu'
    case 'douyin': return 'douyin'
    default: return 'web'
  }
}

function l05Channel(platform: SocialPost['platform']): IntelChannel {
  return platform === 'xhs' ? 'xhs-l0' : 'zhihu'
}

/** 标题/正文关键词 → IntelCategory（避雷/美食/住宿/攻略启发式；默认 recommend）。 */
export interface IntelClassificationEvidence {
  category: IntelItem['category']
  signals: string[]
  positive: boolean
}

const INTEL_CATEGORY_SIGNALS: ReadonlyArray<{
  category: IntelItem['category']
  signal: string
  pattern: RegExp
}> = [
  { category: 'warning', signal: 'safety_or_scam', pattern: /避雷|踩坑|避坑|踩雷|骗局|教训|别去|后悔|危险|诈骗|成人|色情|裸聊|博彩|赌博|贷款|手机号|验证码|点击提交|表单|领取优惠|\bwarning\b/i },
  { category: 'lodging', signal: 'lodging', pattern: /酒店|宾馆|民宿|客栈|住宿|青旅|住哪|入住|房间|旅店|\blodging\b|\bhotel\b/i },
  { category: 'food', signal: 'food', pattern: /美食|餐厅|小吃|火锅|咖啡|面馆|吃什么|饭店|烧烤|牛肉面|菜馆|\bfood\b|\brestaurant\b/i },
  { category: 'attraction', signal: 'attraction_or_ticket', pattern: /景点|景区|公园|古镇|丹霞|湖|寺|博物馆|雪山|峡谷|草原|沙漠|遗址|瀑布|花海|门票|游览|预约|\battraction\b|\bpoi\b/i },
  { category: 'transportLocal', signal: 'local_transport', pattern: /交通|公交|地铁|打车|租车|自驾|公里|停车|导航|机场|车站|路况|\btransport\b/i },
  { category: 'tip', signal: 'travel_preparation', pattern: /注意|证件|限流|准备|行李|必备|清单|防疫|安全|高反|防晒|天气|开放时间|\btip\b|\bnotice\b/i },
  { category: 'recommend', signal: 'travel_recommendation', pattern: /攻略|行程|旅游|旅行|游玩|路线|一日游|两日游|三日游|必去|必看|值得|推荐|好玩|打卡|\brecommend(?:ation)?\b/i },
]

/** 标题/正文关键词 → IntelCategory；无领域信号时不伪造 recommend。 */
export function classifyIntelCategoryEvidence(title: string, content: string): IntelClassificationEvidence {
  const hay = `${title} ${content}`
  const signals: string[] = []
  for (const rule of INTEL_CATEGORY_SIGNALS) {
    if (rule.pattern.test(hay)) signals.push(rule.signal)
  }
  // 风险/表单类信号优先，避免把恶意推广误标为旅行推荐。
  if (signals.includes('safety_or_scam')) return { category: 'warning', signals, positive: true }
  // Domain-specific signals beat incidental place words: e.g. 西湖三日游攻略
  // is a recommendation, while 西湖美食指南 remains food. This keeps the
  // recommendation class from being swallowed by the attraction `湖` signal.
  const domainOrdered: IntelItem['category'][] = ['lodging', 'food', 'transportLocal']
  for (const category of domainOrdered) {
    const signal = INTEL_CATEGORY_SIGNALS.find((rule) => rule.category === category)?.signal
    if (signal !== undefined && signals.includes(signal)) return { category, signals, positive: true }
  }
  if (signals.includes('travel_recommendation')) return { category: 'recommend', signals, positive: true }
  const ordered: IntelItem['category'][] = ['attraction', 'tip']
  for (const category of ordered) {
    const signal = INTEL_CATEGORY_SIGNALS.find((rule) => rule.category === category)?.signal
    if (signal !== undefined && signals.includes(signal)) return { category, signals, positive: true }
  }
  // tip 是无领域默认的保守落点；它不会被路线覆盖误当 attraction/lodging，
  // 也不会向页面制造没有依据的 recommend。
  return { category: 'tip', signals, positive: false }
}

export function classifyIntelCategory(title: string, content: string): IntelItem['category'] {
  return classifyIntelCategoryEvidence(title, content).category
}