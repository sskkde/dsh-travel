/**
 * 检索渠道全集（W3 完整版；M1 T5/Wα 骨架工厂 + W3 追加五渠道）。
 *
 * 渠道清单（design §5.4 行 375-383，M1 形态）：
 * | 渠道 | name（=settings 开关路径，ADR-12） | 方案 | 产出 IntelChannel |
 * |---|---|---|---|
 * | 小红书 | xhsMcp | xiaohongshu-mcp 登录态主路径（W2/T3 实装：授权双闸门+会话失效降级） | xhs-mcp |
 * | 小红书降级 | xhsFallback | L0 种子 + L0.5 直抓（SSR 正文/互动） | xhs-l0 |
 * | 抖音 | douyin | L0 搜 URL（仅标题摘要标注） | douyin |
 * | 二层 | tier2 | 知乎 OpenAPI + L0 兜底 | zhihu |
 * | 三层 | tier3 | 微博/贴吧/快手 L0 兜底 | weibo/tieba/kuaishou |
 * | 腾讯 POI 补充 | tencent-poi | poi_search + poi_nearby（零 key） | tencent-poi |
 * | 平台情报 | platformIntel | web_search（L0 泛搜索） | web |
 *
 * 顶层约束（与 design §5.4 行 373 渠道优先级一致）：清单按「一层→二层→三层→
 * 结构化轨→平台」排序；budget 受限时低层级先降级（fan-out 预算截断天然按
 * 渠道执行顺序倾斜，但并发下以预算耗尽为准）。
 *
 * fan-out 的渠道开关前置过滤（fanout.ts）按 channel.name 查
 * src/adapters/env.ts CHANNEL_SETTINGS_PATHS —— 本文件所有 name 已对齐。
 */
import type { CanonicalQuery } from '../adapters/base.js'
import {
  EngineError, toEngineError, channelEnabled, toDegraded, type DegradedEntry,
} from '../adapters/base.js'
import {
  SearchAdapter,
  classifyPlatform, extractNoteId,
  l0HitToIntelItem, socialPostToIntelItem,
  type L0Hit,
} from '../adapters/search.js'
import { SocialAdapter, TITLE_ONLY_MARK, urlDedupKey } from '../adapters/social.js'
import { PLAYWRIGHT_L1_PLATFORMS, PlaywrightSocialAdapter } from '../adapters/social-playwright.js'
import { TencentMapAdapter } from '../adapters/tencent.js'
import { AmapAdapter } from '../adapters/amap.js'
import { ZhihuAdapter } from '../adapters/zhihu.js'
import {
  XhsAdapter, isXhsAuthorized, xhsFeedToIntelItem,
  XHS_AUTH_GRANTED_REASON, XHS_LOGGED_OUT_REASON, XHS_UNVERIFIABLE_REASON,
  type XhsFeedDetail,
} from '../adapters/xhs.js'
import { INTEL_CATEGORIES, type IntelCategory, type IntelItem } from '../models/types.js'
import type { ResearchChannel, ResearchChannelContext, ResearchChannelOutcome } from './types.js'

// ────────────────────────── 每类别查询模板（FR-3 七类全覆盖） ──────────────────────────

/** 每类别的种子词（xhsFallback 逐类查询 + POI 种子共用；查询模板语义）。 */
export const CATEGORY_SEEDS: Readonly<Record<IntelCategory, readonly string[]>> = {
  attraction: ['景点推荐', '必去景点', '游玩攻略'],
  lodging: ['住宿推荐', '酒店民宿', '住哪儿'],
  food: ['美食推荐', '必吃餐厅', '小吃'],
  transportLocal: ['市内交通', '地铁攻略', '机场车站交通'],
  tip: ['注意事项', '证件预约', '出行准备'],
  warning: ['避雷', '踩坑', '别去'],
  recommend: ['旅行攻略', '行程推荐', '好吃好玩'],
}

function requestedCategories(query: CanonicalQuery): readonly IntelCategory[] {
  return query.categories ?? [...INTEL_CATEGORIES]
}

// ────────────────────────── 查询构造（B3 T8/T10 · P0-C R1/R3 N-4/P3-12） ──────────────────────────

/** 区域关键词单条归一上限（与 RESEARCH_KEYWORDS_MAX_CHARS 对齐，防超长破坏 URL/参数）。 */
export const QUERY_REGION_KEYWORD_MAX_CHARS = 100
/** 区域词掺入查询的数量上限（≤6，与 RESEARCH_KEYWORDS_MAX 对齐；不超长拼接）。 */
export const QUERY_REGION_KEYWORD_MAX = 6

/**
 * 区域关键词 → 短引号短语（T10 R3，治宿主 CJK 分词噪声）。
 * query.keywords 中「destination 之外的区域增量词」各自独立成对短引号短语，
 * 如 `"敦煌" "张掖" "祁连"`，避免长整句经宿主分词被拆成噪声（P3-12）。不会把整句
 * 当短语硬拼：每个原始词只 trim/去引号反斜杠并归一内空白后作为一个带引号的词条。
 *
 * 兼容性 / 安全：
 * - destination 本身（与任一字面词 trim 后相等）不重复硬拼 —— 模板已有 destination，
 *   xhs 主路径等不重复叠 destination；
 * - keywords 缺省 / 空数组 / 全部 == destination → 返回空串 → 渠道模板回到旧查询字节
 *   （legacy 单点行为逐字节不变）；
 * - 逐条丢弃空词与超长词，不产生引号/参数注入（引号、反斜杠均被剔除）。
 */
export function regionKeywordPhrase(query: { destination?: string; keywords?: readonly string[] }): string {
  const dest = (query.destination ?? '').trim()
  if (query.keywords === undefined || query.keywords.length === 0) return ''
  const picked: string[] = []
  for (const raw of query.keywords) {
    const safe = sanitizeRegionKeyword(raw)
    if (safe === '') continue
    if (dest !== '' && safe === dest) continue // destination 已由模板含入，不硬拼重复
    if (picked.includes(safe)) continue
    picked.push(safe)
    if (picked.length >= QUERY_REGION_KEYWORD_MAX) break
  }
  if (picked.length === 0) return ''
  return picked.map((k) => `"${k}"`).join(' ')
}

/** 词条安全归一：trim / 去引号与反斜杠 / 内空白折叠；空或超长 → ''（丢弃）。 */
function sanitizeRegionKeyword(raw: string): string {
  const collapsed = (raw ?? '').trim().replace(/[\\"]+/g, ' ').replace(/\s+/g, ' ').trim()
  return collapsed === '' || collapsed.length > QUERY_REGION_KEYWORD_MAX_CHARS ? '' : collapsed
}

/**
 * 统一「目的地 + 区域限定词」查询头（各渠道模板同源消费）。
 * head = destination（若存在）；区域短语只在有额外区域词时追加 —— 无区域词时与旧模板
 * 的 destination 逐字节一致。例：dest=青甘大环线、区域词 敦煌 → `青甘大环线 "敦煌"`。
 */
export function destinationRegionHead(query: { destination?: string; keywords?: readonly string[] }): string {
  const dest = (query.destination ?? '').trim()
  const region = regionKeywordPhrase(query)
  return [dest, region].filter(Boolean).join(' ')
}

/**
 * 渠道执行安全包装：EngineError 直通归一化；其他异常 → UNAVAILABLE；
 * 结果为空 → EMPTY。渠道契约：失败必须返回 {ok:false}，不抛裸异常。
 */
async function channelRunSafe(fn: () => Promise<readonly IntelItem[]>): Promise<ResearchChannelOutcome> {
  try {
    const items = await fn()
    if (items.length === 0) return { ok: false, code: 'EMPTY', reason: '渠道检索无结果' }
    return { ok: true, items: [...items] }
  } catch (error) {
    const engine = error instanceof EngineError ? error : toEngineError(error)
    return { ok: false, code: engine.code, reason: engine.message }
  }
}

// ────────────────────────── 第一层：小红书 ──────────────────────────

/**
 * xhsMcp 渠道（W2/T3 实装 → N-10 默认授权修订 2026-09-09）。
 *
 * 授权语义（SKILL.md §6.1 / design §5.6 / fix-plan §八）：
 * - settings channels.fr3.xhsMcp 开（fan-out 前置过滤；run 内守卫 double-check）——
 *   关闭 →「已停用（用户配置）」，零 MCP 调用；
 * - **默认授权 = 登录态有效**：先查惰性授权缓存（isXhsAuthorized：曾被登录态有效验证过
 *   自动落的 `.authorized` 或宿主 env TRAVEL_XHS_AUTHORIZED=1）——命中即放行发起登录态
 *   检索（会话失效仍走 ④ 静默空回查 + L0 降级）；缓存缺 → 预检 check_login_status：
 *   - signed-in → 幂等落 `.authorized`，放行登录态检索（回执不降级，文案=默认授权）；
 *   - logged-out → 不落/移除 marker，降级 L0/L0.5 抽样 + 扫码提示（不冒充授权）；
 *   - unverifiable（MCP 不可达）→ 按未授权降级，**文案区分「无法验证登录态」**。
 *
 * 会话失效自动降级（④）：search_feeds 抛错（登录态失效/容器不可用/超时）→
 * 委托 xhsFallbackChannel 既有 L0 种子 + L0.5 直抓链（抽样语义标注 + 失效原因
 * 首条标注），流程不中断；降级链也无结果 → 原错误记账（fan-out 重试判定接管）。
 *
 * 标注贯通（⑤）：登录态条目 channel='xhs-mcp' → render 模板「登录态获取」badge
 * （M1 已留位）；降级条目 channel='xhs-l0'（不点亮 badge，语义如实）。
 */
export function xhsMcpChannel(xhs?: XhsAdapter, search?: SearchAdapter): ResearchChannel {
  const adapter = xhs ?? new XhsAdapter()
  const markerPath = (): string => adapter.authMarkerPath()
  return {
    name: 'xhsMcp',
    async available(): Promise<boolean> {
      // 容器存活探测（MCP initialize 往返；M3.5：装配 ensure 钩子时 ping 失败
      // 会先按需拉起一次再重试——未装配时与 mcp.ping() 等价）；不可达 → false
      // → fan-out 记「渠道不可用」。login 授权不在本步判定（run 预检承载）。
      return adapter.ensurePing()
    },
    run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，小红书登录态检索未执行' })
      }
      const head = destinationRegionHead(query) // destination + 区域短引号词（T8/T10；dest 已在模板，区域词不重复硬拼）
      return channelRunSafe(async () => {
        // 设置开关守卫（run 内 double-check；fan-out 前置过滤已覆盖——off 时零 MCP）
        if (!channelEnabled('xhsMcp', ctx.env)) {
          throw EngineError.unavailable('已停用（用户配置）', 'xhsMcp')
        }

        // 惰性授权缓存（曾验证登录态有效自动落的 marker / 宿主 env 显式授权）：
        // 命中 → 直接走登录态主路径（会话失效由 ④ search_feeds 静默空回查兜底）。
        // 缺省 → 先做登录态预检（N-10 默认授权依据 = 登录态有效）。
        const preflight = isXhsAuthorized(ctx.env, markerPath())
          ? { state: 'signed-in' as const, fromCache: true }
          : { state: (await adapter.loginStateCheck(ctx.env)).state, fromCache: false }

        if (preflight.state === 'logged-out') {
          // 未登录：不落 marker（清掉陈旧缓存），走 L0/L0.5 降级 + 扫码提示（不冒充授权）
          adapter.dropAuthMarker()
          const got = await loginBlockedFallback(search, query, ctx, XHS_LOGGED_OUT_REASON, XHS_LOGGED_OUT_REASON)
          if (got !== undefined) return got
          throw EngineError.unavailable(XHS_LOGGED_OUT_REASON, 'xhsMcp')
        }
        if (preflight.state === 'unverifiable') {
          // MCP 不可达：无法验证登录态 → 按未授权降级（文案区分，不冒充授权）
          adapter.dropAuthMarker()
          const got = await loginBlockedFallback(search, query, ctx, XHS_UNVERIFIABLE_REASON, XHS_UNVERIFIABLE_REASON)
          if (got !== undefined) return got
          throw EngineError.unavailable(XHS_UNVERIFIABLE_REASON, 'xhsMcp')
        }

        // signed-in（含缓存命中）：登录态有效 = 默认授权——首次判定则幂等落 marker（惰性缓存）
        if (!preflight.fromCache) adapter.ensureAuthMarker()
        try {
          const items = await xhsLoginStateItems(adapter, head, query.planId, ctx)
          // 默认授权回执标注（登录态有效，非降级）
          if (items.length > 0) {
            items[0] = { ...items[0], summary: `${items[0].summary}\n（${XHS_AUTH_GRANTED_REASON}）` }
          }
          return items
        } catch (err) {
          // ④已授权但执行中容器停/会话失效 → 自动降级 L0+L0.5（reason 保留原错误语义）
          const reason = err instanceof Error ? err.message : String(err)
          const got = await loginBlockedFallback(search, query, ctx, reason)
          if (got !== undefined) return got
          throw EngineError.unavailable(`小红书登录态检索失败（容器不可用/会话失效），降级链无条目：${reason}`, 'xhsMcp')
        }
      })
    },
  }
}

/**
 * 登录态不可用时的降级出口：委托 xhsFallbackChannel 既有 L0/L0.5 链；首条标注
 * reason（按路径区分「已授权执行中会话失效」「未登录需扫码」「无法验证登录态」）与
 * 抽样语义。search 未装配/不可用/降级也无结果 → undefined（调用方据此记账 failed）。
 */
async function loginBlockedFallback(
  search: SearchAdapter | undefined,
  query: CanonicalQuery,
  ctx: ResearchChannelContext,
  reason: string,
  note?: string,
): Promise<IntelItem[] | undefined> {
  if (search === undefined) return undefined
  const fallback = xhsFallbackChannel(search)
  if (!(await fallback.available())) return undefined
  const outcome = await fallback.run(query, ctx)
  if (!outcome.ok) return undefined
  const lead = note ?? `登录态检索失败已自动降级：${reason}`
  return outcome.items.map((item, i) => i === 0
    ? { ...item, summary: `${item.summary}\n（${lead}；小红书 L0+L0.5 抽样语义）` }
    : item)
}

/** 登录态检索主体：search_feeds + 前 2 条 get_feed_detail 正文富化（预算内）。
 *  keyword = destinationRegionHead(query)（白 cards：destination 主词 + 区域短引号词
 *  B3 T8/T10 —— xhs 主路径不重复硬拼 destination；无区域词时 == destination 旧字节）。 */
async function xhsLoginStateItems(
  adapter: XhsAdapter,
  head: string,
  planId: string | undefined,
  ctx: ResearchChannelContext,
): Promise<IntelItem[]> {
  const { feeds } = await adapter.searchFeeds({ planId, keyword: `${head} 旅游攻略`, limit: 10 }, ctx.env)
  const items: IntelItem[] = []
  const seen = new Set<string>()
  for (const [index, feed] of feeds.entries()) {
    if (seen.has(feed.noteId)) continue
    seen.add(feed.noteId)
    // 正文级富化（详情为浏览器逐页操作 ~10-30s/条：仅前 2 条且预算剩余 >45s 时）
    let detail: XhsFeedDetail | undefined
    if (index < 2 && feed.xsecToken !== '' && ctx.deadlineMs - Date.now() > 45_000) {
      try {
        detail = await adapter.fetchFeedDetail(feed.noteId, feed.xsecToken, ctx.env)
      } catch {
        // 详情失败 → 保留标题+互动级条目，不阻塞
      }
    }
    items.push(xhsFeedToIntelItem(feed, detail))
  }
  return items
}

/** L0 命中容错：种子查询失败/无命中 → null（单类失败不拖垮整渠道）。 */
async function l0HitsFor(search: SearchAdapter, keywords: string, sites: readonly string[], planId?: string): Promise<L0Hit[] | undefined> {
  try {
    // 采样深度 8（M1 收口实测：3 条截断使 tip/warning 类 SERP 命中落在截断外，
    // 造成 FR-3 七类覆盖缺口；同一查询请求数不变，仅放宽每查询切片）
    const result = await search.searchL0({ planId, keywords, sites: [...sites], maxResultsPerQuery: 8 })
    return result.data.hits
  } catch {
    return undefined
  }
}

/**
 * 小红书降级渠道（L0 种子 + L0.5 直抓；FR-3 验收④ 抽样语义标注）：
 * 逐类别按 CATEGORY_SEEDS 查询模板跑 L0（site:xiaohongshu.com），每类命中
 * 顶部 1 条 explore URL 做 L0.5 直抓（SSR 正文全文+赞藏评转，缓存按笔记 ID）；
 * 条目类别=查询模板类别（该查询本身就是类别定向召回）。
 */
export function xhsFallbackChannel(search: SearchAdapter): ResearchChannel {
  return {
    name: 'xhsFallback',
    async available(): Promise<boolean> {
      return search.l05Available() || search.available()
    },
    run(query: CanonicalQuery, _ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，小红书检索未执行' })
      }
      const head = destinationRegionHead(query) // destination + 区域短引号词（B3 T8/T10）
      const categories = requestedCategories(query)
      return channelRunSafe(async () => {
        const items: IntelItem[] = []
        const seenNote = new Set<string>()
        let l05Fetches = 0
        const MAX_L05_FETCHES = 6
        for (const cat of categories) {
          for (const seed of CATEGORY_SEEDS[cat]) {
            const hits = await l0HitsFor(search, `${head} ${seed}`, ['xiaohongshu.com'], query.planId)
            if (!hits || hits.length === 0) continue
            for (const hit of hits) {
              // 类别语义：site: 命中（真小红书 URL）→ 用查询模板种子类别（类别定向召回）；
              // 非小红书 URL（搜索后端未 honor site: 的降级命中）→ 保留分类器判定
              // （强制贴种子类别会顶掉平台情报/分类器的正确类别，并压掉 tip/warning 覆盖）
              const hitItem = l0HitToIntelItem(hit)
              items.push({ ...hitItem, category: classifyPlatform(hit.url) === 'xhs' ? cat : hitItem.category })
              // L0.5 直抓（仅 explore URL；已抓/超预算跳过）
              const noteId = extractNoteId(hit.url)
              if (noteId === undefined || seenNote.has(noteId) || l05Fetches >= MAX_L05_FETCHES) continue
              if (classifyPlatform(hit.url) !== 'xhs') continue
              seenNote.add(noteId)
              try {
                const { post } = await search.fetchXhsNote(hit.url, undefined, query.planId)
                l05Fetches += 1
                items.push({ ...socialPostToIntelItem(post), category: cat })
              } catch {
                // 直抓失败（404/风控）→ 保留 L0 标题级条目，不阻塞
              }
            }
          }
        }
        if (items.length === 0) {
          return items
        }
        // 抽样语义标注（FR-3 验收④：以 L0+L0.5 抽样满足，非登录态全量）
        items[0] = { ...items[0], summary: `${items[0].summary}\n（小红书 L0+L0.5 抽样语义，非平台全量）` }
        return items
      })
    },
  }
}

// ────────────────────────── 第一层：抖音 / 二层：知乎 / 三层 ──────────────────────────

/**
 * socialDepth 语义（advanced.socialDepth 热读，ADR-12；schema 默认 L1）：
 * - L0：纯搜索摘要（三层社媒渠道退化为 L0 兜底形态）；
 * - L1（默认）：L0 + socialL1 登录态定向渠道（Playwright MCP 三平台搜索页）；
 * - L2：L1 + 抖音详情页正文渲染富化（JS-SPA 必须 L2，§5.4）。
 * 「一层优先配额与深度，预算受限低层先降级」由渠道顺序 + fan-out 预算截断承担。
 */
export type SocialDepth = 'L0' | 'L1' | 'L2'

export function socialDepthOf(env?: { readSettings?: (key: string) => string | undefined }): SocialDepth {
  const raw = env?.readSettings?.('advanced.socialDepth')?.trim().toUpperCase()
  return raw === 'L0' || raw === 'L1' || raw === 'L2' ? raw : 'L1'
}

/** 抖音 L0（仅标题摘要）+ L2 正文富化（socialDepth≥L2 且 Playwright MCP 可达）。 */
export function douyinChannel(social: SocialAdapter, playwright?: PlaywrightSocialAdapter): ResearchChannel {
  return {
    name: 'douyin',
    async available(): Promise<boolean> {
      return true
    },
    run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，抖音检索未执行' })
      }
      // B3 T8：社媒 L0 位转发 canonical keywords（区域增量词），不再硬编码仅 [destination]。
      // 宿主拼词（social.seedKeywords）= destination + keywords + categories —— 区域词由此进入真实查询串。
      const kw = query.keywords !== undefined && query.keywords.length > 0 ? query.keywords : [destination]
      return channelRunSafe(async () => {
        const collected: IntelItem[] = []
        const degraded: string[] = []
        const queries = [
          // 每查询按主题定向类别（social 适配器单次调用只归一类；真实词条经 categories + kw 透传）
          { categories: ['recommend'] as IntelCategory[] },
          { categories: ['warning'] as IntelCategory[] },
          { categories: ['tip'] as IntelCategory[] },
        ]
        for (const q of queries) {
          const outcome = await social.searchL0(
            { destination, keywords: [...kw], categories: q.categories },
            { platforms: ['douyin'] },
            ctx.env,
          )
          collected.push(...outcome.items)
          degraded.push(...outcome.degraded.map((d) => d.reason))
        }
        // 首条目标注「仅标题摘要」副注（social.ts 已按条目标注；此处汇总层再点明抽样语义）
        if (collected.length === 0) {
          return collected
        }
        const first = collected[0]
        collected[0] = {
          ...first,
          summary: first.summary.includes(TITLE_ONLY_MARK)
            ? first.summary
            : `${first.summary}\n（${TITLE_ONLY_MARK}：抖音正文需 JS 渲染，M2 落地）`,
        }
        // L2 正文富化（socialDepth≥L2；前 2 条且预算剩余 >30s；失败保留标题级+降级注明）
        const depth = socialDepthOf(ctx.env)
        if (depth === 'L2' && playwright !== undefined && await playwright.mcp.ping()) {
          let enriched = 0
          for (const item of collected) {
            if (enriched >= 2 || ctx.deadlineMs - Date.now() < 30_000) break
            if (item.channel !== 'douyin') continue
            try {
              const { title, text } = await playwright.renderPageText(item.source.url)
              enriched += 1
              collected[collected.indexOf(item)] = {
                ...item,
                title: title || item.title,
                summary: text.slice(0, 600),
              }
            } catch (err) {
              degraded.push(`L2 正文渲染失败（${item.source.url.slice(0, 60)}）：${err instanceof Error ? err.message : String(err)}`)
            }
          }
          if (enriched === 0 && degraded.some((d) => d.startsWith('L2'))) {
            collected[0] = {
              ...collected[0],
              summary: `${collected[0].summary}\n（L2 渲染不可用，全部条目仅标题摘要）`,
            }
          }
        }
        return collected
      })
    },
  }
}

/**
 * 二层渠道（知乎）：知乎开放平台正文级主通道，L0 宿主搜索兜底。
 */
export function tier2Channel(search: SearchAdapter, zhihu?: ZhihuAdapter): ResearchChannel {
  return {
    name: 'tier2',
    async available(): Promise<boolean> {
      // ResearchChannel.available 无 env 参数；宿主搜索能力仍保证旧部署可进入 run，
      // 知乎 API 的 key/开关门在 run(ctx.env) 中按热读取环境判定。
      return search.l05Available() || search.available()
    },
    run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，二层检索未执行' })
      }
      const head = destinationRegionHead(query) // destination + 区域短引号词（B3 T8/T10）
      const nestedDegraded: DegradedEntry[] = []
      return channelRunSafe(async () => {
        const items: IntelItem[] = []
        let zhihuHits: L0Hit[] | undefined
        const seen = new Set<string>()
        const push = (item: IntelItem): void => {
          if (seen.has(item.id)) return
          seen.add(item.id)
          items.push(item)
        }

        // 知乎 API 是主通道：成功返回正文级 ContentText 时不再触发知乎 L0；
        // 缺 key、业务失败、限流或空结果都保留 L0 兜底，并记主源细分原因。
        if (zhihu !== undefined) {
          let apiAvailable = false
          try {
            apiAvailable = await zhihu.available(ctx.env)
          } catch {
            nestedDegraded.push(toDegraded('zhihu', 'UNAVAILABLE', '知乎开放平台可用性检查失败'))
          }
          if (apiAvailable) {
            try {
              const api = await zhihu.search(`${head} 旅行 攻略 避雷`, { count: 10 }, ctx.env)
              nestedDegraded.push(...api.degraded)
              for (const item of api.items) push(item)
              if (api.items.length === 0) {
                zhihuHits = await l0HitsFor(search, `${head} 旅行 攻略 避雷`, ['zhihu.com'], query.planId)
              }
            } catch {
              nestedDegraded.push(toDegraded('zhihu', 'UNAVAILABLE', '知乎开放平台请求失败'))
              zhihuHits = await l0HitsFor(search, `${head} 旅行 攻略 避雷`, ['zhihu.com'], query.planId)
            }
          } else {
            nestedDegraded.push(toDegraded('zhihu', 'UNAVAILABLE', '知乎开放平台未配置 Key 或渠道未启用'))
            zhihuHits = await l0HitsFor(search, `${head} 旅行 攻略 避雷`, ['zhihu.com'], query.planId)
          }
        } else {
          // 兼容未装配 ZhihuAdapter 的测试/旧依赖：知乎仍走原 L0 路径。
          zhihuHits = await l0HitsFor(search, `${head} 旅行 攻略 避雷`, ['zhihu.com'], query.planId)
        }

        for (const hit of zhihuHits ?? []) push({ ...l0HitToIntelItem(hit), channel: 'zhihu' })
        return items
      }).then((outcome) => nestedDegraded.length > 0
        ? { ...outcome, degraded: nestedDegraded }
        : outcome)
    },
  }
}

/** 三层渠道（微博/贴吧/快手）：L0 兜底（§5.4 行 382；site: 尽力而为）。 */
export function tier3Channel(social: SocialAdapter): ResearchChannel {
  return {
    name: 'tier3',
    async available(): Promise<boolean> {
      return true
    },
    run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，三层检索未执行' })
      }
      return channelRunSafe(async () => {
        // B3 T8：转发 canonical keywords（区域增量词）进入真实拼词位。
        const kw = query.keywords !== undefined && query.keywords.length > 0 ? query.keywords : [destination]
        const outcome = await social.searchL0(
          // 三层平台 L0 兜底（social 适配器单次调用只归一类；区域词经 kw 透传）
          { destination, keywords: [...kw], categories: ['recommend'] },
          { platforms: ['weibo', 'tieba', 'kuaishou'] },
          ctx.env,
        )
        if (outcome.items.length > 0) return outcome.items
        // 命中全空 → 以该源自身的 degraded 明细作为失败原因（抽样语义透明）
        const reasons = outcome.degraded.map((d) => d.reason).join('；')
        throw EngineError.empty(reasons || '三层平台 L0 全部无结果（索引抽样，非全量）')
      })
    },
  }
}

// ────────────────────────── 三层：L1 登录态定向（W3a Playwright MCP） ──────────────────────────

/** 登录态条目副注（贯通行程页来源语义；与 xhs-mcp「登录态获取」同口径）。 */
export const SOCIAL_L1_MARK = '登录态获取（Playwright 渲染）'

/**
 * socialL1 渠道（M2.2 L1）：三层平台登录态定向搜索（Playwright MCP + storageState）。
 *
 * available 三重门：渠道开关（channelEnabled('socialL1')，ADR-12）+ socialDepth≥L1
 * （advanced.socialDepth 热读，L0 语义=不启用登录态检索）+ MCP 存活探测（ping）。
 * run：三平台逐个 searchPlatform（登录墙/空结果 → 源级 degraded 走 L0 兜底语义），
 * 全空 → EMPTY（fan-out 记账）；命中条目 channel=平台、confidence=medium、首条
 * 副注登录态标注。单平台失败不阻塞整批（三层 L0 兜底仍在渠道清单后位）。
 */
export function socialL1Channel(playwright: PlaywrightSocialAdapter): ResearchChannel {
  return {
    name: 'socialL1',
    // ResearchChannel.available 无参（fan-out 契约）：depth 判定在 run 内
    // （socialDepth=L0 → run 记「socialDepth=L0（用户配置）」UNAVAILABLE）。
    async available(): Promise<boolean> {
      return playwright.available()
    },
    run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，L1 登录态检索未执行' })
      }
      if (socialDepthOf(ctx.env) === 'L0') {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: 'socialDepth=L0（用户配置），登录态检索未启用' })
      }
      const head = destinationRegionHead(query) // destination + 区域短引号词（B3 T8/T10）
      return channelRunSafe(async () => {
        const items: IntelItem[] = []
        const notes: string[] = []
        for (const platform of PLAYWRIGHT_L1_PLATFORMS) {
          try {
            const { hits, degraded } = await playwright.searchPlatform(platform, `${head} 旅游 攻略`, ctx.env)
            notes.push(...degraded.map((d) => `${platform}: ${d.reason}`))
            for (const hit of hits) {
              items.push({
                id: `sociall1-${platform}-${urlDedupKey(hit.url).slice(0, 40)}`,
                category: 'recommend',
                channel: platform,
                title: hit.title,
                summary: hit.title,
                source: {
                  platform,
                  url: hit.url,
                  fetchedAt: new Date().toISOString(),
                },
                confidence: 'medium',
              })
            }
          } catch (err) {
            notes.push(`${platform}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (items.length === 0) {
          throw EngineError.empty(
            notes.length > 0
              ? `L1 登录态检索全平台无条目（走三层 L0 兜底）：${notes.slice(0, 4).join('；')}`
              : 'L1 登录态检索全平台无条目（走三层 L0 兜底）',
          )
        }
        items[0] = { ...items[0], summary: `${items[0].summary}\n（${SOCIAL_L1_MARK}）` }
        return items
      })
    },
  }
}

// ────────────────────────── 腾讯 POI 补充（含 poi_nearby 种子词） ──────────────────────────

/** 每类别的 POI 种子词（结构化轨可表达的类别）。 */
const POI_SEEDS: Readonly<Record<IntelCategory, readonly string[]>> = {
  attraction: ['景点', '公园', '博物馆'],
  food: ['美食', '餐厅', '小吃'],
  lodging: ['酒店', '民宿'],
  transportLocal: ['地铁', '车站', '机场'],
  tip: [],
  warning: [],
  recommend: ['标志性景点', '网红打卡'],
}

/** poi_nearby 第二轮种子词（目的地坐标中心 1500m 半径补充）。 */
const POI_NEARBY_SEEDS: Readonly<Record<IntelCategory, readonly string[]>> = {
  attraction: ['景点', '公园'],
  food: ['美食', '小吃'],
  lodging: ['酒店'],
  transportLocal: ['地铁站'],
  tip: [],
  warning: [],
  recommend: ['打卡'],
}

/** 单渠道一次执行的最大 HTTP 调用数（W3 配额：7 类×1 搜索 + nearby 补漏）。 */
const MAX_POI_CALLS = 9
const POI_PAGE_SIZE = 8
const NEARBY_RADIUS_METERS = 1500

/**
 * 腾讯 POI 渠道（W2a TencentMapAdapter 薄适配；W3 加厚：种子上限 + nearby 种子词）：
 * 第一轮按请求类别种子逐词 poi_search（region=目的地）；第二轮以首条带坐标条目为
 * 中心，对未覆盖类别补 poi_nearby（POI_NEARBY_SEEDS 种子词）。
 */
/** 请求来源是否允许某个结构化 POI 源；空/未传 = 使用默认降级链。 */
function poiSourceAllowed(query: CanonicalQuery, source: 'tencent-poi' | 'amap'): boolean {
  const sources = query.sources
  return sources === undefined || sources.length === 0 || sources.includes('*') || sources.includes(source)
}

/** 将复合 POI 渠道的失败转成可并入 fan-out 的独立回执。 */
function poiFailure(source: string, outcome: ResearchChannelOutcome): DegradedEntry | undefined {
  return outcome.ok ? undefined : toDegraded(source, outcome.code, outcome.reason)
}

/** 高德 POI 结果投影：source.platform 明示 amap，不伪装为 Tencent。 */
async function amapPoiOutcome(
  adapter: AmapAdapter,
  query: CanonicalQuery,
  ctx: ResearchChannelContext,
): Promise<ResearchChannelOutcome> {
  const destination = query.destination
  if (!destination) {
    return { ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，Amap POI 检索未执行' }
  }
  let available: boolean
  try {
    // Fallback 前置门：Amap 自身同时检查渠道开关与 amapWebservice key；未通过时
    // 不能进入 poiSearch（避免 off/缺 key 仍产生 REST 请求）。
    available = await adapter.available(ctx.env)
  } catch (error) {
    const engine = toEngineError(error, 'amap')
    return {
      ok: false,
      code: engine.code,
      reason: `Amap POI 可用性检查失败：${engine.message}`,
    }
  }
  if (!available) {
    const reason = !channelEnabled('amap', ctx.env)
      ? 'Amap POI 渠道停用（用户配置）'
      : 'Amap POI 渠道不可用（Key 未配置或适配器未就绪）'
    return { ok: false, code: 'UNAVAILABLE', reason }
  }

  const categories = requestedCategories(query)
  const head = destinationRegionHead(query)
  const seeds = categories.flatMap((cat) => POI_SEEDS[cat])
  if (seeds.length === 0) {
    return { ok: false, code: 'EMPTY', reason: '请求类别无 POI 种子（tip/warning 由 L0 渠道覆盖）' }
  }
  return channelRunSafe(async () => {
    const collected: IntelItem[] = []
    const seen = new Set<string>()
    let calls = 0
    for (const cat of categories) {
      for (const seed of POI_SEEDS[cat]) {
        if (calls >= MAX_POI_CALLS) break
        calls += 1
        const result = await adapter.poiSearch(`${head} ${seed}`.trim(), destination, {
          category: cat,
          pageSize: POI_PAGE_SIZE,
        }, ctx.env)
        for (const item of result.items) {
          if (!categories.includes(item.category) || seen.has(intelLocalKey(item))) continue
          seen.add(intelLocalKey(item))
          collected.push({ ...item, source: { ...item.source, platform: 'amap' } })
        }
      }
    }
    return collected
  })
}

/**
 * 腾讯 POI 渠道；腾讯 EMPTY/失败时复用既有 AmapAdapter POI 作为 fallback。
 * 复合结果通过 outcome.degraded 保留主源与 fallback 的逐源回执，fan-out 统一落盘。
 */
export function tencentPoiChannel(adapter: TencentMapAdapter, amap?: AmapAdapter): ResearchChannel {
  return {
    name: 'tencent-poi',
    async available() {
      // 复合渠道必须让 run 看见 Tencent 的失败，才能执行 Amap fallback；若在这里
      // 直接 await Tencent.available()，其异常会被 fan-out 预检当作 false 并跳过 run。
      // 有 Amap fallback 时不做 Tencent 预检（也保证 sources=['amap'] 不触发 Tencent），
      // run 内按白名单决定是否调用 Tencent。无 fallback 时保留原有可用性语义。
      if (amap !== undefined) return true
      try {
        return await adapter.available()
      } catch {
        return false
      }
    },
    async run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return { ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，POI 检索未执行' }
      }
      const tencentAllowed = poiSourceAllowed(query, 'tencent-poi')
      const amapAllowed = amap !== undefined && poiSourceAllowed(query, 'amap')
      if (!tencentAllowed && !amapAllowed) {
        return { ok: false, code: 'UNAVAILABLE', reason: 'POI 来源均未被请求白名单允许' }
      }

      const categories = requestedCategories(query)
      const head = destinationRegionHead(query)
      const seeds = categories.flatMap((cat) => POI_SEEDS[cat])
      if (seeds.length === 0) {
        return { ok: false, code: 'EMPTY', reason: '请求类别无 POI 种子（tip/warning 由 L0 渠道覆盖）' }
      }

      const runTencent = (): Promise<ResearchChannelOutcome> => channelRunSafe(async () => {
        const collected: IntelItem[] = []
        const seen = new Set<string>()
        const pushUnique = (item: IntelItem): void => {
          if (seen.has(intelLocalKey(item))) return
          seen.add(intelLocalKey(item))
          collected.push(item)
        }
        let calls = 0
        for (const cat of categories) {
          for (const seed of POI_SEEDS[cat]) {
            if (calls >= MAX_POI_CALLS) break
            calls += 1
            const result = await adapter.poiSearch({
              keywords: `${head} ${seed}`.trim(),
              region: destination,
              pageSize: POI_PAGE_SIZE,
            })
            for (const item of result.data) {
              if (categories.includes(item.category)) pushUnique(item)
            }
          }
        }
        if (collected.length > 0 && calls < MAX_POI_CALLS) {
          const center = collected.find((i) => i.coords !== undefined)?.coords
          const uncovered = categories.filter(
            (cat) => POI_NEARBY_SEEDS[cat].length > 0 && !collected.some((i) => i.category === cat),
          )
          if (center !== undefined) {
            for (const cat of uncovered) {
              if (calls >= MAX_POI_CALLS) break
              calls += 1
              try {
                const result = await adapter.poiNearby({
                  keywords: POI_NEARBY_SEEDS[cat][0],
                  location: `${center.lat},${center.lng}`,
                  radiusMeters: NEARBY_RADIUS_METERS,
                  pageSize: POI_PAGE_SIZE,
                })
                for (const item of result.data) {
                  if (categories.includes(item.category)) pushUnique(item)
                }
              } catch {
                // nearby 补漏失败不抹掉已取得的腾讯条目。
              }
            }
          }
        }
        return collected
      })

      if (tencentAllowed) {
        const tencentOutcome = await runTencent()
        if (tencentOutcome.ok || !amapAllowed) return tencentOutcome
        const fallback = await amapPoiOutcome(amap!, query, ctx)
        const primaryFailure = poiFailure('tencent-poi', tencentOutcome)
        const fallbackFailure = poiFailure('amap', fallback)
        const nested = [primaryFailure, fallbackFailure].filter((entry): entry is DegradedEntry => entry !== undefined)
        if (fallback.ok) return { ...fallback, degraded: nested }
        return {
          ok: false,
          code: fallback.code,
          reason: `腾讯 POI ${tencentOutcome.reason}；Amap POI ${fallback.reason}`,
          degraded: nested,
        }
      }
      // sources=['amap']：不触发 Tencent，直接复用同一 Amap 实现。
      return amapPoiOutcome(amap!, query, ctx)
    },
  }
}

/** POI 条目去重键（tencent-poi id 即 POI ID；与 fan-out 聚合键口径一致）。 */
function intelLocalKey(item: IntelItem): string {
  return item.id
}

// ────────────────────────── 平台情报（web L0 泛搜索） ──────────────────────────

/**
 * 平台情报渠道（§5.4 行 383 平台情报/web_search；IntelChannel=web）：
 * 泛搜索（无 site:）按三类主题查询模板召回 tip/warning/recommend 情报；
 * 类别由 classifyIntelCategory 自动判定（标题级，confidence low）。
 */
export function platformIntelChannel(search: SearchAdapter): ResearchChannel {
  return {
    name: 'platformIntel',
    async available(): Promise<boolean> {
      return search.available()
    },
    run(query: CanonicalQuery, _ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，平台情报检索未执行' })
      }
      return channelRunSafe(async () => {
        const head = destinationRegionHead(query) // destination + 区域短引号词（B3 T8/T10）
        const items: IntelItem[] = []
        const queries = [
          `${head} 旅行 注意事项 证件 预约 限流`,
          `${head} 旅游 避雷 踩坑 攻略`,
          `${head} 必去景点 美食 住宿 推荐`,
        ]
        for (const q of queries) {
          const hits = await l0HitsFor(search, q, [])
          for (const hit of hits ?? []) {
            items.push(l0HitToIntelItem(hit))
          }
        }
        return items
      })
    },
  }
}

// ────────────────────────── 装配（index.ts 注入） ──────────────────────────

/** M1 完整渠道清单（顺序=design 渠道优先级：一层→二层→三层→结构化轨→平台）。
 * W3a：socialL1（登录态定向）插在三层 L0 兜底之后（三层升级轨，同位预算截断时
 * L0 兜底条目优先保留）；抖音 L2 富化经 deps.playwright 注入启用。 */
export function buildDestinationChannels(deps: {
  search: SearchAdapter
  social: SocialAdapter
  tencent: TencentMapAdapter
  /** 知乎官方开放平台正文级主通道；缺省时保留知乎 L0 兼容路径。 */
  zhihu?: ZhihuAdapter
  /** T25：腾讯 POI 失败/EMPTY 后复用的既有高德 POI 适配器（可选）。 */
  amap?: AmapAdapter
  /** W2/T3：xiaohongshu-mcp 适配器（缺省默认构造——MCP 直连 127.0.0.1:18060；测试注入 fake）。 */
  xhs?: XhsAdapter
  /** W3a：Playwright 社媒适配器（L1 登录态定向 + 抖音 L2 正文；缺省不启用该轨）。 */
  playwright?: PlaywrightSocialAdapter
}): ResearchChannel[] {
  return [
    xhsMcpChannel(deps.xhs, deps.search),
    xhsFallbackChannel(deps.search),
    douyinChannel(deps.social, deps.playwright),
    tier2Channel(deps.search, deps.zhihu),
    tier3Channel(deps.social),
    ...(deps.playwright !== undefined ? [socialL1Channel(deps.playwright)] : []),
    tencentPoiChannel(deps.tencent, deps.amap),
    platformIntelChannel(deps.search),
  ]
}

/**
 * L0 宿主搜索渠道（Wα 薄版入口；seed-research 测试助手与旧用例复用）。
 * 单查询聚合：站点限定 xhs/zhihu/douyin + 裸关键词，标题级条目。
 */
export function searchL0Channel(adapter: SearchAdapter): ResearchChannel {
  return {
    name: 'search-l0',
    async available() {
      return adapter.available()
    },
    run(query: CanonicalQuery, _ctx: ResearchChannelContext): Promise<ResearchChannelOutcome> {
      const destination = query.destination
      if (!destination) {
        return Promise.resolve({ ok: false, code: 'UNAVAILABLE', reason: '目的地缺失，L0 检索未执行' })
      }
      return channelRunSafe(async () => {
        const head = destinationRegionHead(query) // destination + 区域短引号词（B3 T8/T10）
        const result = await adapter.searchL0({
          keywords: `${head} 旅行攻略`,
          sites: ['xiaohongshu.com', 'zhihu.com', 'douyin.com'],
          maxResultsPerQuery: 6,
        })
        return result.data.hits.map((hit) => l0HitToIntelItem(hit))
      })
    },
  }
}