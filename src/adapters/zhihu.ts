/**
 * 知乎官方开放平台适配器：`zhihu_search` 正文级检索。
 *
 * API 是 GET JSON 接口；认证只从 BaseAdapter 的 settings → credentials → env
 * 链解析，绝不把 secret 放入 URL、缓存键、错误或结构化结果。ContentText
 * 是开放平台返回的正文段落，因此按正文语义完整写入 IntelItem.summary。
 */
import {
  BaseAdapter,
  EngineError,
  RateLimitExceededError,
  channelEnabled,
  isKeyConfigured,
  toDegraded,
  type DegradedEntry,
  type KeyResolutionEnv,
} from './base.js'
import { CACHE_TTL_SHORT_MS, TtlCache } from './amap.js'
import type { UsageRecorder } from '../metrics/usage.js'
import type { Confidence, IntelItem } from '../models/types.js'
import { classifyIntelCategory } from './search.js'

/** 知乎开放平台搜索接口。 */
export const ZHIHU_ENDPOINT = 'https://developer.zhihu.com/api/v1/content/zhihu_search'
/** BaseAdapter key 标识；env 位使用同名环境变量。 */
export const ZHIHU_ACCESS_SECRET = 'ZHIHU_ACCESS_SECRET'
/** 兼容调用方按渠道名引用 key 的别名。 */
export const ZHIHU_KEY = ZHIHU_ACCESS_SECRET
export const ZHIHU_DOMAIN = 'developer.zhihu.com'
export const DEFAULT_ZHIHU_TIMEOUT_MS = 10_000
export const ZHIHU_MAX_COUNT = 10

/** 最小 HTTP 响应面，供单测注入 fake fetch。 */
export interface ZhihuFetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export interface ZhihuFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export type ZhihuFetch = (url: string, init?: ZhihuFetchInit) => Promise<ZhihuFetchResponse>

export interface ZhihuSearchOptions {
  /** API Count；服务端允许 1–10，越界值在本地归一化。 */
  count?: number
  /** API SortBy 原格式：字段:方向:(最小值,最大值)。 */
  sortBy?: string
}

export interface ZhihuAdapterOptions {
  /** fake fetch 注入；缺省使用全局 fetch。 */
  fetchFn?: ZhihuFetch
  /** 端点覆盖（测试/部署代理）；默认知乎官方端点。 */
  endpoint?: string
  /** 单次 HTTP 请求超时。 */
  timeoutMs?: number
  /** TTL 缓存注入；默认短 TTL。 */
  cache?: TtlCache
  /** 缓存 TTL（仅在未注入 cache 时使用）。 */
  cacheTtlMs?: number
  /** 域令牌桶与既有适配器一致，供隔离测试/定制部署注入。 */
  rateLimiter?: import('./base.js').DomainTokenBucket
  /** 用量记录器。 */
  usage?: UsageRecorder
}

export interface ZhihuApiItem {
  Title?: unknown
  ContentType?: unknown
  ContentID?: unknown
  ContentText?: unknown
  Url?: unknown
  CommentCount?: unknown
  VoteUpCount?: unknown
  AuthorName?: unknown
  AuthorAvatar?: unknown
  AuthorBadge?: unknown
  AuthorBadgeText?: unknown
  EditTime?: unknown
  CommentInfoList?: unknown
  AuthorityLevel?: unknown
  RankingScore?: unknown
}

export interface ZhihuApiResponse {
  Code?: unknown
  Message?: unknown
  Data?: {
    HasMore?: unknown
    SearchHashId?: unknown
    Items?: unknown
  }
}

export interface ZhihuSearchResult {
  items: IntelItem[]
  degraded: DegradedEntry[]
}

/** Count 归一化：API 只接受 1–10；非正数按默认 10。 */
export function normalizeZhihuCount(count?: number): number {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return ZHIHU_MAX_COUNT
  return Math.min(ZHIHU_MAX_COUNT, Math.max(1, Math.floor(count)))
}

/**
 * 去掉开放平台回传链接上的全部 UTM 参数，同时保留其他查询参数与 hash，
 * 以便仍可回溯到同一条知乎内容。
 */
export function cleanZhihuUrl(rawUrl: string): string {
  const input = rawUrl.trim()
  try {
    const url = new URL(input)
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm(?:_|$)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    // 上游 URL 异常时不凭空改写来源；调用方仍可看到原始可溯源字符串。
    return input
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function contentIdValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return nonEmptyString(value)
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function apiCode(value: unknown): number | undefined {
  const parsed = numberValue(value)
  return parsed === undefined || !Number.isInteger(parsed) ? undefined : parsed
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = numberValue(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function dateFromEditTime(value: unknown): string | undefined {
  const seconds = numberValue(value)
  if (seconds === undefined) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

function highAuthority(value: unknown): boolean {
  const numeric = numberValue(value)
  if (numeric !== undefined) return numeric >= 1
  const text = nonEmptyString(value)?.toLowerCase() ?? ''
  return /high|official|verified|expert|trusted|权威|认证|官方|高/.test(text)
}

function highRanking(value: unknown): boolean {
  const numeric = numberValue(value)
  if (numeric === undefined) return false
  // 兼容常见的 0–1 与 0–100 排名分数口径。
  return (numeric >= 0 && numeric <= 1 && numeric >= 0.8) || numeric >= 80
}

/** AuthorityLevel / RankingScore → 统一 confidence；任一高质量信号即 high。 */
export function zhihuConfidence(item: Pick<ZhihuApiItem, 'AuthorityLevel' | 'RankingScore'>): Confidence {
  return highAuthority(item.AuthorityLevel) || highRanking(item.RankingScore) ? 'high' : 'medium'
}

/** 单条开放平台 Item → IntelItem；ContentText 全量保留，不截断。 */
export function zhihuItemToIntelItem(raw: ZhihuApiItem, fetchedAt: string): IntelItem | undefined {
  const contentId = contentIdValue(raw.ContentID)
  if (contentId === undefined) return undefined
  const title = nonEmptyString(raw.Title) ?? `知乎内容 ${contentId}`
  // ContentText 是正文段落，不能 trim 或 slice，否则会破坏实质证据。
  const contentText = typeof raw.ContentText === 'string' ? raw.ContentText : ''
  if (contentText.trim() === '') return undefined
  const url = nonEmptyString(raw.Url)
  if (url === undefined) return undefined
  const likes = nonNegativeNumber(raw.VoteUpCount) ?? 0
  const comments = nonNegativeNumber(raw.CommentCount) ?? 0
  const item: IntelItem = {
    id: `zhihu:${contentId}`,
    category: classifyIntelCategory(title, contentText),
    channel: 'zhihu',
    title,
    // 开放平台 ContentText 是正文级内容；不得截断、不得拼元信息。
    summary: contentText,
    author: nonEmptyString(raw.AuthorName),
    metrics: { likes, comments },
    source: { platform: 'zhihu-openapi', url: cleanZhihuUrl(url), fetchedAt },
    confidence: zhihuConfidence(raw),
    publishedAt: dateFromEditTime(raw.EditTime),
    // 保留正文直读面；summary 仍是同一份正文语义，不写入作者/互动元信息。
    ...(contentText !== '' ? { content: contentText } : {}),
  }
  // Optional 属性不应以 undefined 形式污染落盘 JSON。
  if (item.author === undefined) delete item.author
  if (item.publishedAt === undefined) delete item.publishedAt
  return item
}

function responseItems(value: unknown): ZhihuApiItem[] {
  const root = recordOf(value)
  const data = recordOf(root?.Data)
  const items = data?.Items
  if (!Array.isArray(items)) return []
  return items.filter((item): item is ZhihuApiItem => recordOf(item) !== undefined)
}

function responseCode(value: unknown): number | undefined {
  return apiCode(recordOf(value)?.Code)
}

function codeReason(code: number): string {
  switch (code) {
    case 20001: return '知乎开放平台鉴权失败（Code=20001）'
    case 30001: return '知乎开放平台频率限制（Code=30001）'
    case 10001: return '知乎开放平台参数错误（Code=10001）'
    case 90001: return '知乎开放平台内部错误（Code=90001）'
    default: return `知乎开放平台业务错误（Code=${code}）`
  }
}

function safeCacheItems(value: unknown): IntelItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => recordOf(item) !== undefined) ? value as IntelItem[] : undefined
}

/** 防御性清洗：上游若意外回显认证值，不让它进入结果/缓存/落盘链。 */
function redactSecretInItem(item: IntelItem, secret: string): IntelItem {
  const redact = (value: string): string => secret === '' ? value : value.split(secret).join('[REDACTED]')
  return {
    ...item,
    id: redact(item.id),
    title: redact(item.title),
    summary: redact(item.summary),
    ...(item.author === undefined ? {} : { author: redact(item.author) }),
    ...(typeof item.content === 'string' ? { content: redact(item.content) } : {}),
    source: { ...item.source, url: redact(item.source.url) },
  }
}

/**
 * settings/config 侧通常把 key 命名为 `zhihu`，env 侧则使用用户交割的
 * `ZHIHU_ACCESS_SECRET`。适配器仍委托 BaseAdapter 的 resolveKey，只在注入
 * 环境上提供兼容别名，保持 settings → credentials → env 顺序。
 */
function withZhihuKeyAliases(env?: KeyResolutionEnv): KeyResolutionEnv | undefined {
  if (env === undefined) return undefined
  const originalEnv = env.env
  const configuredUpper = originalEnv?.[ZHIHU_ACCESS_SECRET]
  const envValue = typeof configuredUpper === 'string' && configuredUpper.trim() !== ''
    ? configuredUpper
    : originalEnv?.zhihu
  return {
    ...env,
    readSettings: (key: string) => {
      const direct = env.readSettings?.(key)
      if (key !== ZHIHU_ACCESS_SECRET || (direct !== undefined && direct.trim() !== '')) return direct
      return env.readSettings?.('zhihu')
    },
    resolveCredential: async (ref: string) => {
      const direct = await env.resolveCredential?.(ref)
      if (ref !== ZHIHU_ACCESS_SECRET || (direct !== undefined && direct.trim() !== '')) return direct
      return env.resolveCredential?.('zhihu')
    },
    env: originalEnv === undefined
      ? undefined
      : { ...originalEnv, [ZHIHU_ACCESS_SECRET]: envValue },
  }
}

export class ZhihuAdapter extends BaseAdapter {
  private readonly fetchFn: ZhihuFetch
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly cache: TtlCache

  constructor(opts: ZhihuAdapterOptions = {}) {
    super('zhihu', { supports: new Set<string>() }, { rateLimiter: opts.rateLimiter, usage: opts.usage })
    this.fetchFn = opts.fetchFn ?? (async (url, init) => {
      const response = await fetch(url, init as RequestInit)
      return { ok: response.ok, status: response.status, text: async () => await response.text() }
    })
    this.endpoint = opts.endpoint ?? ZHIHU_ENDPOINT
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_ZHIHU_TIMEOUT_MS
    this.cache = opts.cache ?? new TtlCache(opts.cacheTtlMs ?? CACHE_TTL_SHORT_MS)
  }

  /** 渠道开关 + settings → credentials → env Key 链；缺 key 时不触网。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    const keyEnv = withZhihuKeyAliases(env)
    if (!channelEnabled('zhihu', keyEnv)) return false
    return isKeyConfigured(ZHIHU_ACCESS_SECRET, keyEnv)
  }

  /**
   * 正文级知乎检索。所有上游失败都归一为本方法返回的 degraded[]，不把
   * Authorization、secret 或开放平台原始错误体带出适配器。
   */
  async search(query: string, options: ZhihuSearchOptions = {}, env?: KeyResolutionEnv): Promise<ZhihuSearchResult> {
    const count = normalizeZhihuCount(options.count)
    const sortBy = options.sortBy?.trim() || undefined
    const keyEnv = withZhihuKeyAliases(env)
    const key = await this.resolveChainKey(ZHIHU_ACCESS_SECRET, keyEnv)
    if (key === undefined) {
      return {
        items: [],
        degraded: [toDegraded(this.name, 'UNAVAILABLE', 'Key 未配置（ZHIHU_ACCESS_SECRET）')],
      }
    }

    const cacheKey = this.searchCacheKey(query, count, sortBy)
    const cached = safeCacheItems(this.cache.get(cacheKey))
    if (cached !== undefined) {
      this.usage.recordCache('zhihu-openapi', true)
      return { items: [...cached], degraded: [] }
    }
    this.usage.recordCache('zhihu-openapi', false)

    try {
      await this.acquireRate(ZHIHU_DOMAIN, { env })
      const requestUrl = this.buildRequestUrl(query, count, sortBy)
      const timestamp = String(Math.floor(Date.now() / 1000))
      const response = await this.withTimeout(this.fetchFn(requestUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key.value}`,
          'X-Request-Timestamp': timestamp,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }))
      this.usage.recordNetwork('zhihu-openapi')
      if (!response.ok || response.status < 200 || response.status >= 300) {
        throw EngineError.unavailable(`知乎开放平台 HTTP ${response.status}`, this.name)
      }
      let payload: unknown
      try {
        payload = JSON.parse(await response.text()) as unknown
      } catch {
        throw EngineError.unavailable('知乎开放平台响应格式无效', this.name)
      }
      const code = responseCode(payload)
      if (code === undefined) {
        throw EngineError.unavailable('知乎开放平台响应缺少 Code', this.name)
      }
      if (code !== 0) throw EngineError.unavailable(codeReason(code), this.name)

      const fetchedAt = new Date().toISOString()
      const items = responseItems(payload)
        .slice(0, count)
        .map((item) => zhihuItemToIntelItem(item, fetchedAt))
        .filter((item): item is IntelItem => item !== undefined)
        .map((item) => redactSecretInItem(item, key.value))
      if (items.length === 0) {
        return { items, degraded: [toDegraded(this.name, 'EMPTY', '知乎开放平台查询无有效结果')] }
      }
      this.cache.set(cacheKey, items)
      return { items, degraded: [] }
    } catch (error) {
      const safeError = this.safeError(error)
      if (safeError instanceof RateLimitExceededError) {
        return { items: [], degraded: [this.rateLimited(ZHIHU_DOMAIN, safeError)] }
      }
      const engine = safeError instanceof EngineError
        ? safeError
        : EngineError.unavailable('知乎开放平台请求失败', this.name)
      return { items: [], degraded: [toDegraded(this.name, engine)] }
    }
  }

  /** HTTP 适配器无持久会话；保留统一生命周期 close() 面。 */
  async close(): Promise<void> {
    // no-op：每次请求均为无状态 HTTP，未持有需要释放的连接/会话。
  }

  private searchCacheKey(query: string, count: number, sortBy?: string): string {
    return `zhihu-openapi|${JSON.stringify({ query, count, sortBy: sortBy ?? null })}`
  }

  private buildRequestUrl(query: string, count: number, sortBy?: string): string {
    const url = new URL(this.endpoint)
    url.searchParams.set('Query', query)
    url.searchParams.set('Count', String(count))
    if (sortBy !== undefined) url.searchParams.set('SortBy', sortBy)
    return url.toString()
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(EngineError.timeout(`知乎开放平台请求超时（${this.timeoutMs}ms）`, this.name)), this.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 只保留错误类别，不透传可能含 secret/Authorization 的第三方错误文本。 */
  private safeError(error: unknown): unknown {
    if (error instanceof RateLimitExceededError) return error
    if (error instanceof EngineError) {
      if (error.code === 'TIMEOUT') return EngineError.timeout('知乎开放平台请求超时', this.name)
      // 业务码/HTTP 状态由上游构造的安全消息保留；未知 EngineError 统一泛化。
      if (/^知乎开放平台(?: HTTP \d+|鉴权失败|频率限制|参数错误|内部错误|业务错误|响应)/.test(error.message)) return error
      return EngineError.unavailable('知乎开放平台请求失败', this.name)
    }
    return EngineError.unavailable('知乎开放平台请求失败', this.name)
  }
}
