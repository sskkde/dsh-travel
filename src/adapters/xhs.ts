/**
 * xhs 适配器（W2/T3）：xiaohongshu-mcp 登录态主路径（M2.1，关键路径）。
 *
 * 部署事实（docs/deploy.md §xiaohongshu-mcp；docs/research/cloakbrowser.md:46/56）：
 * xpzouying/xiaohongshu-mcp Docker 分发，Streamable HTTP POST {base}/mcp，
 * 端口约定 18060；会话卷挂载 `<root>/.dsh-travel/xhs-session/` → /data/cookies
 * （单会话约束：一份登录态，多渠道共享同一 cookie 文件）。
 *
 * 只读红线（design §5.6 合规边界，强制）：
 * - 上游工具面 18 个，其中写端点 9 个（publish_content/publish_with_video/
 *   post_comment_to_feed/reply_comment_in_feed/like_feed/like_notification/
 *   favorite_feed/reply_notification/delete_cookies）——**零注册**：白名单
 *   XHS_READ_ONLY_TOOLS 之外一律 assertXhsReadOnly 拒绝（经 McpStreamClient
 *   readOnlyGate 注入，rail12306.ts 同款在途闸门模式）。
 * - xsecToken 为会话级访问令牌：仅用于 get_feed_detail 调用参数，**绝不落盘**
 *   （IntelItem.source.url 一律 canonicalXhsUrl 剥 token，防泄漏）。
 *
 * 授权（N-10 默认授权，design §5.6 / SKILL.md §6.1；2026-09-09 用户策略修订）：
 * - 设置开关 channels.fr3.xhsMcp 为**唯一显式控制**（fan-out 前置过滤；
 *   run 内再加守卫 → 关闭时零 MCP 调用）。
 * - 默认授权判定 = **登录态有效**（只读 check_login_status 成功且非「未登录」文本
 *   特征）：有效即放行并发起登录态检索，自动幂等落 `.authorized`（惰性缓存，保留
 *   同步 available()/isXhsAuthorized 面）；未登录 → 不落/移除 marker 并走既有 L0/
 *   L0.5 降级 + get_login_qrcode 扫码提示；MCP 不可达 → 按未授权降级并区分
 *   「无法验证登录态」文案，**不冒充授权**。
 * - 兼容保持：授权标记/env（TRAVEL_XHS_AUTHORIZED=1，宿主部署自管）存在时视为已
 *   由有效登录态/宿主鉴权过，可短路冗余的每次预检测（惰性缓存单一事实）。
 *
 * 会话失效检测（④）：上游未登录时 search_feeds **静默返回空**（实测
 * {"feeds":[],"count":0}，非错误）——空结果必须回查 check_login_status；
 * 「未登录」文本特征（❌/未登录/登录已过期）→ 会话失效 → 渠道层自动降级
 * L0 种子 + L0.5 直抓（search.ts 既有链，抽样语义标注）。
 *
 * 会话失效检测（④）：上游未登录时 search_feeds **静默返回空**（实测
 * {"feeds":[],"count":0}，非错误）——空结果必须回查 check_login_status；
 * 「未登录」文本特征（❌/未登录/登录已过期）→ 会话失效 → 渠道层自动降级
 * L0 种子 + L0.5 直抓（search.ts 既有链，抽样语义标注）。
 *
 * 频控（⑥ W1 令牌桶）：所有 MCP 调用前 acquireRate('xiaohongshu.com')——
 * 域语义取上游站点（MCP 只是本机代理，被打爆的是 xiaohongshu.com 配额）。
 */
import { existsSync } from 'node:fs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BaseAdapter, EngineError, channelEnabled,
  type DegradedEntry, type DomainTokenBucket, type KeyResolutionEnv,
} from './base.js'
import { McpStreamClient, type FetchLike } from './rail12306.js'
import { canonicalXhsUrl, classifyIntelCategory, redactSensitiveText } from './search.js'
import { TRAVEL_DIR_NAME } from '../store/paths.js'
import type { IntelItem } from '../models/types.js'

export const DEFAULT_XHS_MCP_URL = 'http://127.0.0.1:18060/mcp'
/** env 覆盖键（deploy.md §2.4 端口约定同款）。 */
export const XHS_MCP_URL_ENV = 'TRAVEL_XHS_MCP_URL'

/**
 * 只读白名单（实测 2026-09-04 tools/list；上游 18 工具中仅挂 4 个只读件）：
 * - search_feeds：登录态搜索（主路径）
 * - get_feed_detail：笔记详情（正文全文+互动数据；搜索结果只有标题，正文级需此件）
 * - check_login_status：登录状态检测（会话失效判据）
 * - get_login_qrcode：登录二维码出示（gated 扫码交割，只读件）
 * 发布/评论/点赞/收藏/关注/通知回复/cookie 删除类一律零注册。
 */
export const XHS_READ_ONLY_TOOLS: readonly string[] = [
  'search_feeds',
  'get_feed_detail',
  'check_login_status',
  'get_login_qrcode',
]

/**
 * 写端点关键字 deny 表（防御纵深：白名单命中 + 关键字负向校验双条件）。
 * 覆盖上游全部 9 个写工具名：publish_*、post_comment_*、reply_*、like_*、
 * favorite_*、delete_cookies。
 */
const XHS_WRITE_TOOL_KEYWORDS = /publish|comment|reply|like|favorite|follow|delete|upload|post|block/i

/** 白名单判定（白名单内 且 无写端点关键字）。 */
export function isXhsReadOnlyTool(name: string): boolean {
  return XHS_READ_ONLY_TOOLS.includes(name) && !XHS_WRITE_TOOL_KEYWORDS.test(name)
}

/**
 * 只读断言：非白名单/写端点关键字命中 → EngineError.UNAVAILABLE（调用前强制闸门）。
 * 任何 xhs MCP 工具调用进入网络前必经此闸（McpStreamClient readOnlyGate 注入点）。
 */
export function assertXhsReadOnly(name: string): void {
  if (!isXhsReadOnlyTool(name)) {
    throw EngineError.unavailable(
      `工具 ${name} 不在 xhs 只读白名单（发布/评论/点赞/收藏/关注类调用被红线拒绝，零注册）`,
      'xhs',
    )
  }
}

// ────────────────────────── 默认授权（N-10：登录态有效即授权） ──────────────────────────

/** env 部署兜底（宿主自管形态；truthy 值集同 channelEnabled 语义——兼容保持）。 */
export const XHS_AUTHORIZED_ENV = 'TRAVEL_XHS_AUTHORIZED'

/** 授权标记文件（登录态有效时自动幂等创建；.dsh-travel/ 已 gitignore 不入库）。 */
export function xhsAuthMarkerPath(root?: string): string {
  const base = root?.trim() || process.env.DSH_TRAVEL_ROOT || process.cwd()
  return join(base, TRAVEL_DIR_NAME, 'xhs-session', '.authorized')
}

/** 授权标记内容（仅标识位，无会话凭据/token）。 */
const XHS_AUTH_MARKER_TEXT = 'xiaohongshu 登录态有效 · .authorized（默认授权惰性缓存）'

/**
 * 幂等创建授权标记（登录态有效时自动落盘；仅当不存在时写入=重复判定不再重复写）。
 * 不删除 xhs-session 目录（该目录含登录会话 cookie，属容器自管）。
 */
export function ensureXhsAuthMarker(markerPath: string): void {
  try {
    if (existsSync(markerPath)) return
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, XHS_AUTH_MARKER_TEXT, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 标记写失败不阻塞检索（惰性缓存尽力而为）
  }
}

/** 移除授权标记（登录态失效/未知时调用；缺失即空操作，幂等）。 */
export function removeXhsAuthMarker(markerPath: string): void {
  try {
    if (!existsSync(markerPath)) return
    rmSync(markerPath, { force: true })
  } catch {
    // 标记清理失败不阻塞降级
  }
}

/** env 标记 truthy 判定（'1'/'true'/'yes'/'on'）。 */
function envFlagOn(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 授权惰性缓存面（同步，供 available()/短路判定；兼容保持）：env TRAVEL_XHS_AUTHORIZED
 * truthy 或授权标记文件存在。
 * - 标记在登录态有效时**幂等自动落盘**（本文件惰性缓存唯一事实），存在=曾验证过登录态
 *   有效（或宿主部署显式授权）→ 可短路冗余的每次预检。
 * - 会话失效（标记陈旧）由 search_feeds 静默空 + check_login_status 回查兜底（④）。
 * - 设置开关 channels.fr3.xhsMcp 是唯一显式控制（不在此判定；run/fan-out 前置过滤）。
 */
export function isXhsAuthorized(env?: KeyResolutionEnv, markerPath?: string): boolean {
  if (envFlagOn((env?.env ?? process.env)[XHS_AUTHORIZED_ENV])) return true
  try {
    return existsSync(markerPath ?? xhsAuthMarkerPath())
  } catch {
    return false
  }
}

/**
 * 登录态三态判定结果（N-10 默认授权依据）：
 * - signed-in：check_login_status 成功且非「未登录」文本特征 → 登录态有效 → 授权放行。
 * - logged-out：check_login_status 成功但检出未登录/过期 → 未授权，不落 marker，走降级+扫码。
 * - unverifiable：check_login_status 调用失败（容器停/超时等）→ **无法验证登录态**，
 *   按未授权降级，不冒充授权（文案区分）。
 */
export type XhsLoginState =
  | { readonly state: 'signed-in' }
  | { readonly state: 'logged-out' }
  | { readonly state: 'unverifiable'; readonly error: string }

/** 渠道「登录后已授权」回执（N-10：不再展示为降级「待授权」）。 */
export const XHS_AUTH_GRANTED_REASON = '登录态有效（默认授权）'

/**
 * 渠道「未登录」降级文案（§④降级提示复用位）：不表示通用「未授权」，而是登录态缺失需
 * 扫码交割；走既有 L0/L0.5 降级 + get_login_qrcode（只读件出示二维码）。
 */
export const XHS_LOGGED_OUT_REASON =
  '小红书登录态未就绪（check_login_status 未登录）：已自动降级 L0/L0.5 抽样；' +
  '如需登录态全量检索，可经 get_login_qrcode（只读件）出示二维码完成扫码登录后重试。'

/** 渠道「无法验证登录态」降级文案（MCP 不可达分支；不冒充授权）。 */
export const XHS_UNVERIFIABLE_REASON =
  '无法验证登录态（xiaohongshu-mcp 不可达）：check_login_status 调用失败，暂按未授权降级，' +
  '不冒充已登录状态；请确认渠道容器可访问后重试。'

// ────────────────────────── 归一化纯函数（上游 struct 对齐） ──────────────────────────

/** 上游 Feed（xiaohongshu/types.go Feed/NoteCard/InteractInfo）业务面。 */
export interface XhsFeed {
  noteId: string
  /** 会话级令牌：仅透传 get_feed_detail 参数，不落 IntelItem。 */
  xsecToken: string
  title: string
  author?: string
  likes?: number
  collects?: number
  comments?: number
  shares?: number
}

/** 上游 FeedDetail（feed_detail.go FeedDetail）业务面。 */
export interface XhsFeedDetail {
  title?: string
  /** 正文全文。 */
  desc?: string
  /** 发布时间（ms；搜索结果无此字段，详情才有）。 */
  time?: number
  ipLocation?: string
  likes?: number
  collects?: number
  comments?: number
  shares?: number
}

/** XHS xsec_token 的会话级内存记录；永不序列化为 URL/工件。 */
export interface XhsSessionToken {
  readonly token: string
  readonly queryKey: 'xsec_token' | 'access_token' | 'refresh_token' | 'token'
  /** 检索期标题线索；只留在进程内供 token 续期，不进入 URL/工件。 */
  readonly title?: string
  /** 从标题/初始查询归一出的可检索关键词；同样只留在进程内。 */
  readonly searchKeyword?: string
}

export interface XhsTokenCacheOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

/** 正文回源失败的可排障分类；原始令牌不属于错误面。 */
export const XHS_CONTENT_FAILURE_REASONS = ['no_host_search', 'note_not_found', 'token_unusable'] as const
export type XhsContentFailureReason = (typeof XHS_CONTENT_FAILURE_REASONS)[number]

/** 计划级详情通道结果；仅暴露安全正文与分类，不暴露会话令牌。 */
export interface XhsFeedDetailForPlanResult {
  detail?: XhsFeedDetail
  failureReason?: XhsContentFailureReason
  /** 本次 MCP 续期搜索是否得到可用响应；不代表 token 已命中。 */
  mcpAvailable: boolean
}

export interface XhsTokenRefreshResult {
  refreshed: boolean
  failureReason?: XhsContentFailureReason
  /** MCP 搜索是否成功返回可解析响应。 */
  mcpAvailable: boolean
}

/**
 * 按 planId + noteId 隔离的短时令牌缓存。
 *
 * 这个类只暴露受控取用面，缓存键不含 URL；调用方不得将返回的 token 写入持久化
 * 数据、日志或错误。默认 TTL 覆盖多轮检索→挑选→正文抓取窗口，实例销毁即清空。
 */
export class XhsTokenCache {
  static readonly DEFAULT_TTL_MS = 60 * 60 * 1000
  static readonly DEFAULT_MAX_ENTRIES = 256
  private readonly entries = new Map<string, { value: XhsSessionToken; expiresAt: number }>()
  /** token 到期后仍保留的安全标题/关键词线索，供一次按需续期；同样按计划隔离且有上限。 */
  private readonly searchHints = new Map<string, { title?: string; searchKeyword?: string }>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: XhsTokenCacheOptions = {}) {
    this.ttlMs = Math.max(1, Math.trunc(options.ttlMs ?? XhsTokenCache.DEFAULT_TTL_MS))
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? XhsTokenCache.DEFAULT_MAX_ENTRIES))
    this.now = options.now ?? Date.now
  }

  private rememberSearchHint(
    key: string,
    title?: string,
    searchKeyword?: string,
  ): void {
    const normalizedTitle = title?.trim()
    const normalizedKeyword = searchKeyword?.trim()
    if (!normalizedTitle && !normalizedKeyword) return
    if (this.searchHints.size >= this.maxEntries && !this.searchHints.has(key)) {
      const oldest = this.searchHints.keys().next().value
      if (oldest !== undefined) this.searchHints.delete(oldest)
    }
    this.searchHints.delete(key)
    this.searchHints.set(key, {
      ...(normalizedTitle ? { title: normalizedTitle } : {}),
      ...(normalizedKeyword ? { searchKeyword: normalizedKeyword } : {}),
    })
  }

  remember(
    planId: string,
    noteId: string,
    token: string,
    queryKey: XhsSessionToken['queryKey'] = 'xsec_token',
    title?: string,
    searchKeyword?: string,
  ): void {
    if (planId.trim() === '' || noteId.trim() === '' || token.trim() === '') return
    const key = `${planId}\u0000${noteId}`
    const previous = this.searchHints.get(key)
    const rememberedTitle = title?.trim() || previous?.title
    const rememberedKeyword = searchKeyword?.trim() || previous?.searchKeyword
    this.rememberSearchHint(key, rememberedTitle, rememberedKeyword)
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.delete(key)
    this.entries.set(key, {
      value: {
        token,
        queryKey,
        ...(rememberedTitle !== undefined ? { title: rememberedTitle } : {}),
        ...(rememberedKeyword !== undefined ? { searchKeyword: rememberedKeyword } : {}),
      },
      expiresAt: this.now() + this.ttlMs,
    })
  }

  get(planId: string, noteId: string): XhsSessionToken | undefined {
    const key = `${planId}\u0000${noteId}`
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() >= entry.expiresAt) {
      this.rememberSearchHint(key, entry.value.title, entry.value.searchKeyword)
      this.entries.delete(key)
      return undefined
    }
    // Refresh insertion order without extending TTL: this is an LRU touch only.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** 获取 token 到期后仍可用于一次 MCP 搜索的关键词；不返回 token。 */
  getSearchKeyword(planId: string, noteId: string): string | undefined {
    const key = `${planId}\u0000${noteId}`
    const value = this.entries.get(key)?.value
    return value?.searchKeyword ?? value?.title ?? this.searchHints.get(key)?.searchKeyword ?? this.searchHints.get(key)?.title
  }

  delete(planId: string, noteId: string): void {
    const key = `${planId}\u0000${noteId}`
    const value = this.entries.get(key)?.value
    if (value !== undefined) this.rememberSearchHint(key, value.title, value.searchKeyword)
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.searchHints.clear()
  }

  size(): number {
    return this.entries.size
  }
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 规范形缺少真实标题时的占位文本不能成为续期关键词。 */
function cacheableXhsTitle(title: string, noteId: string): string | undefined {
  const normalized = title.trim()
  return normalized !== '' && normalized !== `笔记 ${noteId}` ? normalized : undefined
}

/**
 * 生成一次续期所用的可检索标题词：若原始查询出现在标题中，则从该片段开始
 * 搜索，去掉“此生必驾🔥”这类标题前缀；否则保留去除前导噪声后的标题。
 * noteId 永不作为缺省关键词。
 */
function deriveXhsSearchKeyword(title: string, sourceKeyword?: string, noteId?: string): string | undefined {
  const normalizedTitle = title.trim()
  const normalizedSource = sourceKeyword?.trim()
  const safeSource = normalizedSource !== undefined && normalizedSource !== '' && normalizedSource !== noteId
    ? normalizedSource
    : undefined
  if (normalizedTitle === '' || normalizedTitle === `笔记 ${noteId}`) return safeSource
  if (safeSource !== undefined) {
    const start = normalizedTitle.toLocaleLowerCase().indexOf(safeSource.toLocaleLowerCase())
    if (start >= 0) return normalizedTitle.slice(start).trim()
  }
  return normalizedTitle.replace(/^[^\p{L}\p{N}]+/u, '').trim() || safeSource
}

/** 小红书互动计数字符串 → 数值（"1.2万"→12000，"860"→860；空/非法 undefined）。 */
export function parseXhsCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return undefined
  const wan = /^([\d.]+)\s*万$/.exec(raw)
  if (wan) {
    const n = Number(wan[1])
    return Number.isFinite(n) ? Math.round(n * 10000) : undefined
  }
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/** 上游单条 feed → 规范形（modelType 非 note 的直播卡/热词卡已在服务端过滤，此处再滤）。 */
export function normalizeXhsFeed(raw: Record<string, unknown>): XhsFeed | undefined {
  if (str(raw.modelType) !== 'note') return undefined
  const noteId = str(raw.id)
  if (noteId === undefined) return undefined
  const card = rec(raw.noteCard)
  const interact = rec(card?.interactInfo)
  const user = rec(card?.user)
  return {
    noteId,
    xsecToken: str(raw.xsecToken) ?? '',
    title: str(card?.displayTitle) ?? str(card?.title) ?? `笔记 ${noteId}`,
    author: str(user?.nickname) ?? str(user?.nickName),
    likes: parseXhsCount(interact?.likedCount),
    collects: parseXhsCount(interact?.collectedCount),
    comments: parseXhsCount(interact?.commentCount),
    shares: parseXhsCount(interact?.sharedCount),
  }
}

/** search_feeds 响应 {feeds:[...], count} → 规范形列表。 */
export function normalizeXhsSearch(payload: unknown): XhsFeed[] {
  const root = rec(payload)
  const feeds = Array.isArray(root?.feeds) ? root.feeds : []
  const out: XhsFeed[] = []
  for (const raw of feeds) {
    const item = rec(raw) === undefined ? undefined : normalizeXhsFeed(rec(raw) as Record<string, unknown>)
    if (item !== undefined) out.push(item)
  }
  return out
}

/**
 * get_feed_detail 响应 → 正文面（实测 2026-09-04 live 外层为 {feed_id, data:{note}}；
 * 兼容 note 直挂形态——单测 fixture/schema 推导口径）。fresh xsecToken 等非业务
 * 字段一律不透出（返回值仅 title/desc/time/ipLocation/互动计数）。
 */
export function normalizeXhsDetail(payload: unknown): XhsFeedDetail {
  const root = rec(payload)
  const note = rec(rec(root?.data)?.note) ?? rec(root?.note)
  const interact = rec(note?.interactInfo)
  const time = note?.time
  return {
    title: str(note?.title),
    desc: str(note?.desc),
    time: typeof time === 'number' && Number.isFinite(time) ? time : undefined,
    ipLocation: str(note?.ipLocation),
    likes: parseXhsCount(interact?.likedCount),
    collects: parseXhsCount(interact?.collectedCount),
    comments: parseXhsCount(interact?.commentCount),
    shares: parseXhsCount(interact?.sharedCount),
  }
}

/** 登录态失效文本特征（check_login_status 实测：「❌ 未登录\n\n请使用 get_login_qrcode …」）。 */
export function isLoginRequiredText(text: string): boolean {
  return /未登录|登录已过期|登录态失效|not\s+logged\s*in|please\s+login|get_login_qrcode/i.test(text)
}

/**
 * 规范形 feed（可选详情富化）→ IntelItem（channel='xhs-mcp'——render 模板
 * 「登录态获取」badge 标注位按此值点亮，M1 已留位不动）。
 * source.url 一律 canonicalXhsUrl（剥 xsec_token，防会话令牌落盘）。
 */
export function xhsFeedToIntelItem(feed: XhsFeed, detail?: XhsFeedDetail, fetchedAt = new Date().toISOString()): IntelItem {
  const body = redactSensitiveText(detail?.desc ?? '')
  const likes = detail?.likes ?? feed.likes
  const collects = detail?.collects ?? feed.collects
  const comments = detail?.comments ?? feed.comments
  const shares = detail?.shares ?? feed.shares
  const metrics = { likes, collects, comments, shares }
  const hasMetrics = Object.values(metrics).some((value) => value !== undefined)
  return {
    id: `xhs:${feed.noteId}`,
    category: classifyIntelCategory(feed.title, body),
    channel: 'xhs-mcp',
    title: redactSensitiveText(feed.title),
    // summary 只承载正文语义；作者/互动/IP 属地不得拼回摘要。
    summary: body !== '' ? body.slice(0, 140) : '（登录态检索命中，正文待详情抓取）',
    ...(feed.author !== undefined ? { author: redactSensitiveText(feed.author) } : {}),
    ...(hasMetrics ? { metrics } : {}),
    // IntelItem 类型保留旧 trace 兼容面，同时校验器接受字符串正文形态。
    ...(body !== '' ? { content: body } : {}),
    source: { platform: 'xiaohongshu-mcp', url: canonicalXhsUrl(feed.noteId), fetchedAt },
    confidence: 'medium',
    publishedAt: detail?.time !== undefined && detail.time > 0
      ? new Date(detail.time).toISOString().slice(0, 10)
      : undefined,
  }
}

// ────────────────────────── 适配器 ──────────────────────────

export interface XhsAdapterOptions {
  /** MCP 客户端注入（测试 fake；缺省按 url/fetchFn 构造并挂 assertXhsReadOnly 闸门）。 */
  mcp?: McpStreamClient
  url?: string
  fetchFn?: FetchLike
  /** MCP 调用超时（浏览器操作 6-60s/次；缺省 90s，勿用 McpStreamClient 默认 10s）。 */
  timeoutMs?: number
  /** 授权标记根目录覆盖（测试注入；缺省 DSH_TRAVEL_ROOT → cwd）。 */
  travelRoot?: string
  /** 域级令牌桶注入（测试/定制隔离；缺省 globalRateLimiter 同域跨渠道共享）。 */
  rateLimiter?: DomainTokenBucket
  /** 检索期 xsec_token 的会话级内存通道（按 planId+noteId 隔离）。 */
  tokenCache?: XhsTokenCache
  /**
   * 伴随服务按需拉起钩子（M3.5 supervisor 接线位）：MCP ping 失败时调用，
   * 返回 true = 服务已就绪可重试一次。缺省无（M2 行为：ping 失败即不可用）。
   */
  ensure?: () => Promise<boolean>
}

export interface XhsSearchQuery {
  /** 计划作用域；令牌只进入该 planId+noteId 的短时内存缓存。 */
  planId?: string
  /** 搜索关键词（如「杭州 旅游攻略」）。 */
  keyword: string
  /** 保留条数上限（**客户端截取**——上游 search_feeds 实测 inputSchema 仅
   * {keyword, filters?} 且 additionalProperties:false，多传 limit 报 -32602
   * invalid params；缺省 10）。 */
  limit?: number
}

export class XhsAdapter extends BaseAdapter {
  readonly mcp: McpStreamClient
  readonly tokenCache: XhsTokenCache
  private readonly travelRoot?: string
  private readonly ensure?: () => Promise<boolean>

  constructor(opts: XhsAdapterOptions = {}) {
    super('xhs', { supports: new Set<string>() }, { rateLimiter: opts.rateLimiter })
    this.travelRoot = opts.travelRoot
    this.tokenCache = opts.tokenCache ?? new XhsTokenCache()
    this.ensure = opts.ensure
    this.mcp = opts.mcp ?? new McpStreamClient({
      url: opts.url ?? (process.env[XHS_MCP_URL_ENV] || DEFAULT_XHS_MCP_URL),
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs ?? 90_000,
      // 只读闸门注入（rail12306.ts McpClientOptions.readOnlyGate 在途位）：
      // 白名单外/写端点关键字一律编译期拒绝。
      readOnlyGate: assertXhsReadOnly,
    })
  }

  /** 授权标记路径（travelRoot 覆盖透传；测试注入位）。 */
  authMarkerPath(): string {
    return xhsAuthMarkerPath(this.travelRoot)
  }

  /**
   * MCP 存活探测（伴随服务 ensure 钩子接线位）：ping 失败且装配了 ensure →
   * 按需拉起后重试一次；未装配 ensure 时与 mcp.ping() 等价（M2 行为不变）。
   */
  async ensurePing(): Promise<boolean> {
    if (await this.mcp.ping()) return true
    if (this.ensure === undefined) return false
    if (!(await this.ensure())) return false
    return this.mcp.ping()
  }

  /** MCP 存活探测 + 渠道开关（①闸门；ADR-12 热读）。不可达 → false（fan-out 跳过）。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('xhsMcp', env)) return false
    return this.ensurePing()
  }

  /**
   * 登录态搜索（只读 search_feeds）→ 规范形 feed 列表。
   * 未登录/会话失效时上游静默返回空（非错误）——空结果回查 check_login_status，
   * 失效 → EngineError.UNAVAILABLE「登录态失效」（渠道层据此自动降级 L0+L0.5）。
   */
  async searchFeeds(query: XhsSearchQuery, env?: KeyResolutionEnv): Promise<{ feeds: XhsFeed[]; degraded: DegradedEntry[] }> {
    assertXhsReadOnly('search_feeds')
    const degraded: DegradedEntry[] = []
    // 频控（W1 令牌桶）：域=上游站点语义，非本机 MCP 端口
    await this.acquireRate('xiaohongshu.com', { env })
    // 实测 inputSchema（2026-09-04）：{keyword, filters?}，additionalProperties:false
    // ——只传 keyword（limit 客户端截取，见 XhsSearchQuery 注）。
    const payload = await this.mcp.callTool('search_feeds', { keyword: query.keyword })
    const all = normalizeXhsSearch(payload)
    const feeds = query.limit !== undefined ? all.slice(0, query.limit) : all
    if (query.planId !== undefined) {
      for (const feed of feeds) {
        if (feed.xsecToken !== '') {
          this.tokenCache.remember(
            query.planId,
            feed.noteId,
            feed.xsecToken,
            'xsec_token',
            cacheableXhsTitle(feed.title, feed.noteId),
            deriveXhsSearchKeyword(feed.title, query.keyword, feed.noteId),
          )
        }
      }
    }
    if (feeds.length === 0) {
      // 空结果二段判据：真无结果（EMPTY） vs 未登录静默空（会话失效）
      if (await this.sessionInvalid(env)) {
        throw EngineError.unavailable('小红书登录态失效（未登录/会话过期，search_feeds 静默空）', 'xhs')
      }
      degraded.push({ source: this.name, code: 'EMPTY', reason: `登录态搜索「${query.keyword}」无结果`, at: new Date().toISOString() })
    }
    return { feeds, degraded }
  }

  /**
   * 登录态三态判定（N-10 默认授权依据 + 会话失效检测同源）：
   * check_login_status（只读件）成功且非「未登录」特征 → signed-in；成功但未登录 →
   * logged-out；调用失败（容器停/超时）→ unverifiable（无法验证登录态）。
   */
  async loginStateCheck(env?: KeyResolutionEnv): Promise<XhsLoginState> {
    try {
      await this.acquireRate('xiaohongshu.com', { env })
      const payload = await this.mcp.callTool('check_login_status', {})
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
      return isLoginRequiredText(text) ? { state: 'logged-out' } : { state: 'signed-in' }
    } catch (error) {
      return { state: 'unverifiable', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 会话失效检测（④兼容面）：登录态三态判定收敛为布尔——signed-in → false；
   * logged-out / unverifiable → true（fail-safe 指向降级链，语义与旧实现等价）。
   */
  async sessionInvalid(env?: KeyResolutionEnv): Promise<boolean> {
    const result = await this.loginStateCheck(env)
    return result.state !== 'signed-in'
  }

  /** 登录态有效 → 幂等落授权标记（惰性缓存）。 */
  ensureAuthMarker(): void {
    ensureXhsAuthMarker(this.authMarkerPath())
  }

  /** 移除授权标记（未登录/未知态），幂等。 */
  dropAuthMarker(): void {
    removeXhsAuthMarker(this.authMarkerPath())
  }

  /**
   * 笔记详情（只读 get_feed_detail）→ 正文全文 + 互动数据（搜索结果仅标题，
   * 正文级富化经此件）。xsecToken 只作调用参数透传，返回值不含令牌。
   */
  async fetchFeedDetail(noteId: string, xsecToken: string, env?: KeyResolutionEnv): Promise<XhsFeedDetail> {
    assertXhsReadOnly('get_feed_detail')
    await this.acquireRate('xiaohongshu.com', { env })
    try {
      const payload = await this.mcp.callTool('get_feed_detail', { feed_id: noteId, xsec_token: xsecToken })
      return normalizeXhsDetail(payload)
    } catch (error) {
      // 上游错误可能回显调用参数；令牌必须在离开适配器前被字面替换，不能进入
      // research-state、回执、日志或宿主错误面。
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
        .split(xsecToken).join('[REDACTED]')
      const code = error instanceof EngineError ? error.code : 'UNAVAILABLE'
      const source = error instanceof EngineError ? (error.source ?? 'xhs') : 'xhs'
      throw new EngineError(code, message, source)
    }
  }

  /**
   * 计划级 token 按需续期：以检索期保存的标题线索做一次 MCP search_feeds，逐条
   * 精确比对 noteId 后写回同一 planId+noteId 缓存；不返回令牌，也不循环重试。
   */
  async refreshTokenForPlan(
    planId: string,
    noteId: string,
    env?: KeyResolutionEnv,
  ): Promise<XhsTokenRefreshResult> {
    if (planId.trim() === '' || noteId.trim() === '') {
      return { refreshed: false, mcpAvailable: false, failureReason: 'token_unusable' }
    }
    const keyword = this.tokenCache.getSearchKeyword(planId, noteId)
    if (keyword === undefined) {
      // 没有检索期标题线索时不退回 noteId（它不是可检索文本）；交由宿主次级
      // 回源或最终分类处理，避免伪造 MCP 续期成功。
      return { refreshed: false, mcpAvailable: false, failureReason: 'token_unusable' }
    }
    try {
      assertXhsReadOnly('search_feeds')
      await this.acquireRate('xiaohongshu.com', { env })
      // 续期是受控的单次补搜：只使用检索期标题线索，不展开查询变体。
      const payload = await this.mcp.callTool('search_feeds', { keyword })
      const feeds = normalizeXhsSearch(payload)
      let sameNoteFound = false
      for (const feed of feeds) {
        // MCP 返回的 noteId 是唯一可信的路径 ID；绝不借用相似标题或其他笔记 token。
        if (feed.noteId !== noteId) continue
        sameNoteFound = true
        if (feed.xsecToken.trim() === '') continue
        this.tokenCache.remember(
          planId,
          noteId,
          feed.xsecToken,
          'xsec_token',
          cacheableXhsTitle(feed.title, feed.noteId),
          deriveXhsSearchKeyword(feed.title, keyword, feed.noteId),
        )
        return { refreshed: true, mcpAvailable: true }
      }
      return {
        refreshed: false,
        mcpAvailable: true,
        failureReason: sameNoteFound ? 'token_unusable' : 'note_not_found',
      }
    } catch {
      // 失败只返回分类，不携带上游错误文本，避免 MCP 错误回显任何令牌。
      return { refreshed: false, mcpAvailable: false, failureReason: 'token_unusable' }
    }
  }

  /**
   * 按计划消费详情 token；缓存未命中/过期时先按需续期一次再抓详情。
   * 结果只暴露安全详情与失败分类，令牌始终留在适配器内存。
   */
  async fetchFeedDetailForPlanResult(
    planId: string,
    noteId: string,
    env?: KeyResolutionEnv,
  ): Promise<XhsFeedDetailForPlanResult> {
    const record = this.tokenCache.get(planId, noteId)
    if (record !== undefined) {
      try {
        return { detail: await this.fetchFeedDetail(noteId, record.token, env), mcpAvailable: true }
      } catch {
        this.tokenCache.delete(planId, noteId)
        return { mcpAvailable: true, failureReason: 'token_unusable' }
      }
    }

    const renewal = await this.refreshTokenForPlan(planId, noteId, env)
    if (!renewal.refreshed) {
      return {
        mcpAvailable: renewal.mcpAvailable,
        failureReason: renewal.failureReason ?? 'token_unusable',
      }
    }
    const refreshed = this.tokenCache.get(planId, noteId)
    if (refreshed === undefined) {
      return { mcpAvailable: true, failureReason: 'token_unusable' }
    }
    try {
      return { detail: await this.fetchFeedDetail(noteId, refreshed.token, env), mcpAvailable: true }
    } catch {
      this.tokenCache.delete(planId, noteId)
      return { mcpAvailable: true, failureReason: 'token_unusable' }
    }
  }

  /**
   * 兼容旧调用面：详情通道失败仍返回 undefined；需要可排障分类的调用方使用
   * fetchFeedDetailForPlanResult。
   */
  async fetchFeedDetailForPlan(planId: string, noteId: string, env?: KeyResolutionEnv): Promise<XhsFeedDetail | undefined> {
    return (await this.fetchFeedDetailForPlanResult(planId, noteId, env)).detail
  }

  /**
   * 登录二维码（只读 get_login_qrcode）→ base64 PNG + 超时秒（gated 扫码交割）。
   * 上游响应为「文本 + image/png」双 content 块（callToolRaw 取全块）；
   * 已登录态返回纯文本「你当前已处于登录状态」。仅透出数据，不落盘不做验证码求解。
   */
  async loginQrcode(env?: KeyResolutionEnv): Promise<{ imageBase64: string; timeoutHint?: string }> {
    assertXhsReadOnly('get_login_qrcode')
    await this.acquireRate('xiaohongshu.com', { env })
    const payload = await this.mcp.callToolRaw('get_login_qrcode', {})
    const contents = (Array.isArray(payload.content) ? payload.content : []) as Array<Record<string, unknown>>
    const text = contents.find((c) => c.type === 'text')?.text
    if (typeof text === 'string' && /已处于登录状态/.test(text)) {
      throw EngineError.unavailable('小红书已处于登录状态（无需扫码）', 'xhs')
    }
    const image = contents.find((c) => c.type === 'image')
    const imageBase64 = str(image?.data)
    if (imageBase64 === undefined) {
      throw EngineError.unavailable(`get_login_qrcode 响应无 image 块：${JSON.stringify(payload).slice(0, 200)}`, 'xhs')
    }
    return { imageBase64, timeoutHint: typeof text === 'string' ? text : undefined }
  }

  /** 关闭底层 MCP 会话（长驻适配器生命周期收尾；幂等）。 */
  close(): Promise<void> {
    return this.mcp.close()
  }
}
