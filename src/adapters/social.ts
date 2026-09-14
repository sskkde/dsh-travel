/**
 * social 适配器（W2b 基础版）：社媒 L0 搜索（design §5.4 行 375-383 渠道方案）。
 *
 * 范围（M1 基础版）：
 * - 抖音（一层）：L0 搜 URL —— 命中 /video/<id>、/note/<id> 等可达良好，
 *   只产出摘要级条目，**如实标注「仅标题摘要」**（正文 JS 渲染需 L2，
 *   留 M2）。去重键=URL 路径段 ID（learnings 行 28：非 URL 全串）。
 * - 三层平台（微博/贴吧/快手）：L0 兜底。site: 为**尽力而为非硬过滤**
 *   （learnings 行 24/28：引擎索引抽样 + top-N 展示，贴吧/快手实测常为 0 条）。
 * - L1（dsh-web-search-pro 登录态定向）/ L2（Playwright 渲染）留 M2。
 *
 * 零 key 通道（CAP_ZERO_KEY）；available() 只受渠道开关（ADR-12）约束。
 * 渠道归属按实际 URL 域名识别（site: 尽力而为，防误标）；单平台失败不
 * 阻塞整批，记为 degraded 继续其余平台。
 */
import { BaseAdapter, CAP_ZERO_KEY, EngineError, toDegraded, channelEnabled, type CanonicalQuery, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import type { IntelChannel, IntelItem } from '../models/types.js'

/** L0 搜索命中（宿主 web_search / 工具层注入；W3 接线）。 */
export interface SearchHit {
  title: string
  url: string
  snippet?: string
}

/** 宿主搜索函数形态（与 W2a search.ts 的 SearchLike 对齐）。 */
export type SearchFn = (query: string) => Promise<SearchHit[]>

/** 本适配器覆盖的平台（一层抖音 + 三层三平台）。 */
export const SOCIAL_PLATFORMS = ['douyin', 'weibo', 'tieba', 'kuaishou'] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

/** 平台 → site: 域（尽力而为，非硬过滤）。 */
export const PLATFORM_SITE: Record<SocialPlatform, string> = {
  douyin: 'douyin.com',
  weibo: 'weibo.com',
  tieba: 'tieba.baidu.com',
  kuaishou: 'kuaishou.com',
}

/** 平台 → IntelChannel（INTEL_CHANNELS 枚举内同名）。 */
const PLATFORM_CHANNEL: Record<SocialPlatform, IntelChannel> = {
  douyin: 'douyin',
  weibo: 'weibo',
  tieba: 'tieba',
  kuaishou: 'kuaishou',
}

/** 域名 → 渠道 识别表（用于按实际 URL 归属，防 site: 误标）。 */
const HOST_CHANNEL: Array<[RegExp, IntelChannel]> = [
  [/(^|\.)douyin\.com$/i, 'douyin'],
  [/(^|\.)weibo\.com$/i, 'weibo'],
  [/tieba\.baidu\.com$/i, 'tieba'],
  [/(^|\.)kuaishou\.com$/i, 'kuaishou'],
]

/** 「仅标题摘要」如实标注（L2 渲染前不可达正文）。 */
export const TITLE_ONLY_MARK = '仅标题摘要'

/** 单平台 L0 超时（默认秒数）——超时记 TIMEOUT 不阻塞整批。 */
export const DEFAULT_SOCIAL_TIMEOUT_MS = 8000

/** 从 URL 提取去重键：路径段末段 ID（去 query/hash；非 URL 全串）。 */
export function urlDedupKey(url: string): string {
  const clean = url.split(/[?#]/)[0].replace(/\/+$/, '')
  const segments = clean.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? clean
}

/** 按实际 URL 域名识别渠道；无法识别回退请求平台。 */
export function channelForUrl(url: string, fallback: SocialPlatform): IntelChannel {
  const host = safeHost(url)
  for (const [re, ch] of HOST_CHANNEL) {
    if (re.test(host)) return ch
  }
  return PLATFORM_CHANNEL[fallback]
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 组装单平台查询：关键词 + site:（尽力而为，失败归零由降级记账）。 */
export function buildPlatformQuery(platform: SocialPlatform, keywords: string): string {
  const site = PLATFORM_SITE[platform]
  return `${keywords} site:${site}`
}

export interface SocialOptions {
  /** 宿主搜索函数（缺省则所有平台记 UNAVAILABLE「搜索函数未注入」）。 */
  search?: SearchFn
  /** 单平台超时（毫秒）。 */
  timeoutMs?: number
}

export interface SocialSearchOutcome {
  items: IntelItem[]
  degraded: DegradedEntry[]
}

/** 关键词种子：destination + keywords + 类别词兜底。 */
function seedKeywords(query: Pick<CanonicalQuery, 'destination' | 'keywords' | 'categories'>): string {
  const parts: string[] = []
  if (query.destination) parts.push(query.destination)
  if (query.keywords?.length) parts.push(...query.keywords)
  if (query.categories?.length) parts.push(...query.categories)
  return parts.filter(Boolean).join(' ').trim() || '旅游 攻略'
}

export class SocialAdapter extends BaseAdapter {
  private readonly search?: SearchFn
  private readonly timeoutMs: number

  constructor(opts: SocialOptions = {}) {
    super('social-l0', { supports: new Set([CAP_ZERO_KEY]) })
    this.search = opts.search
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_SOCIAL_TIMEOUT_MS
  }

  /** 零 key 通道：可用性只受渠道开关（ADR-12）约束。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    return channelEnabled('social', env)
  }

  /** 渠道开关关闭 → available()=false（fan-out 前置过滤单测依据）。 */
  channelState(env?: KeyResolutionEnv): boolean {
    return channelEnabled('social', env)
  }

  /**
   * L0 搜索（摘要级）。单平台失败/为空记 degraded，不阻塞整批；
   * 仅在搜索函数未注入（整批不可执行）时记出错并返回空。
   */
  async searchL0(
    query: Pick<CanonicalQuery, 'destination' | 'keywords' | 'categories'>,
    opts: { platforms?: SocialPlatform[] } = {},
    env?: KeyResolutionEnv,
  ): Promise<SocialSearchOutcome> {
    const outcome: SocialSearchOutcome = { items: [], degraded: [] }
    if (!this.search) {
      outcome.degraded.push(this.degraded('UNAVAILABLE', '宿主搜索函数未注入（W3 接线）'))
      return outcome
    }
    const platforms = opts.platforms ?? [...SOCIAL_PLATFORMS]
    const keywords = seedKeywords(query)
    const category = query.categories?.[0] ?? 'tip'

    for (const platform of platforms) {
      const siteSource = `${this.name}/${platform}`
      try {
        const hits = await this.withTimeout(
          this.search(buildPlatformQuery(platform, keywords)),
          siteSource,
        )
        if (!hits.length) {
          outcome.degraded.push(toDegraded(siteSource, 'EMPTY', '无 L0 结果（site: 尽力而为）'))
          continue
        }
        const seen = new Set<string>()
        for (const hit of hits) {
          const channel = channelForUrl(hit.url, platform)
          const key = `${channel}/${urlDedupKey(hit.url)}`
          if (!hit.url || seen.has(key)) continue
          seen.add(key)
          outcome.items.push({
            id: `social-${channel}-${key.replace('/', '-')}`,
            category,
            channel,
            title: hit.title || hit.url,
            summary: hit.snippet?.trim()
              ? hit.snippet.trim()
              : `（${TITLE_ONLY_MARK}：L0 仅返回标题，正文需 L2 渲染获取，M2 落地）`,
            source: {
              platform: channel,
              url: hit.url,
              fetchedAt: new Date().toISOString(),
            },
            confidence: 'low',
          })
        }
        if (!outcome.items.length) {
          outcome.degraded.push(toDegraded(siteSource, 'EMPTY', '命中均无有效 URL，已去重清空'))
        }
      } catch (err) {
        if (err instanceof EngineError) {
          outcome.degraded.push(toDegraded(siteSource, err))
        } else {
          outcome.degraded.push(toDegraded(siteSource, 'UNAVAILABLE', `搜索失败：${err instanceof Error ? err.message : String(err)}`))
        }
      }
    }
    return outcome
  }

  private async withTimeout<T>(promise: Promise<T>, source: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(EngineError.timeout(`L0 搜索超时（${this.timeoutMs}ms）`, source)), this.timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}