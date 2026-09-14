/**
 * fan-out 编排核心（M1 T5 / Wα 骨架；W3 在同一函数内加厚，不重写）。
 *
 * 骨架阶段能力（Wα 已落实）：
 * 1. Promise.allSettled 并发执行全部渠道（单源失败不阻塞其余）
 * 2. 逐渠道按剩余预算截断（Promise.race vs 延时定时器 → TIMEOUT 记账）
 * 3. 失败/{ok:false} → toDegraded 记账；成功条目汇入 items
 * 4. 按条目 id 去重（Wα 骨架行为）
 *
 * W3 加厚点（本文件落实）：
 * a. 渠道开关前置过滤：env.readSettings(`channels.<name>`) 判「已停用（用户配置）」
 *    （ADR-12：settings 热读，关闭→跳过+专门记账；covered by available() 过滤之后）
 * b. 单源重试 ≤2 次指数退避（缺省 1s/4s，等待计入总预算）：UNAVAILABLE/TIMEOUT
 *    可重试；EMPTY 属确定性无结果不重试；预算耗尽即停
 * c. 聚合去重（intelDedupKey：笔记 ID / POI ID 语义键，跨渠道 L0/L0.5 合并取富）
 * d. 冲突标注 annotateConflicts：同对象多源矛盾互链 conflictsWith
 * e. 时效降权 applyTimeliness：publishedAt >12 个月 → confidence 降级 + 标注
 * f. 用量统计埋点（M3.3，只观测）：attempts/retries + degraded 聚合计数，
 *    并以 query.planId 开启用量 plan 归因作用域（不影响任何编排语义）
 */
import { channelEnabled, toDegraded, type DegradedEntry, type KeyResolutionEnv } from '../adapters/base.js'
import { defaultUsageRecorder, type UsageRecorder } from '../metrics/usage.js'
import type { Confidence, IntelItem } from '../models/types.js'
import { classifyIntelCategoryEvidence } from '../adapters/search.js'
import { normalizePublishedAt } from '../models/validate.js'
import type { FanoutOptions, FanoutResult, ResearchChannelContext, ResearchChannelOutcome } from './types.js'

/** 单源失败重试的默认退避序列（§9.3-1：≤2 次，1s/4s，等待计入总预算）。 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 4000]

/**
 * L1 噪声主机 deny-list：导出为可替换输入，便于按产品策略撤回某一类过滤，
 * 不把 deny-list 写死在渠道适配器里。默认只拦明确的职业/下载聚合噪声域。
 */
export const INTEL_NOISE_HOST_DENYLIST: readonly string[] = [
  'linkedin.com', 'naver.com', 'moe.edu',
]

const NOISE_TITLE_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  // 不使用裸“立即”：安全提示如“高原不适应立即停止上升”必须保留。
  { pattern: /(?:立即下载|免费下载|下载客户端|下载软件|download\s+(?:now|the\s+app))/i, reason: 'download' },
  { pattern: /(?:立即注册|免费注册|\bregister(?:\s+now)?\b|\bsign\s*up(?:\s+now)?\b)/i, reason: 'register' },
  { pattern: /(?:推广链接|广告推广|促销信息|推广|\bpromo(?:tion)?\b|\bsponsored\b)/i, reason: 'promotion' },
  { pattern: /(?:在线(?:文件|格式)?转换器?|(?:xls|xlsx|excel).*(?:转换|converter)|(?:转换|converter).*(?:xls|xlsx|excel))/i, reason: 'converter' },
  { pattern: /(?:成人|色情|裸聊|博彩|赌博|贷款|点击提交|领取优惠|手机号验证码|google\s*form)/i, reason: 'unsafe_promotion' },
]

export interface IntelNoiseGateResult {
  items: IntelItem[]
  degraded: DegradedEntry[]
}

function aggregateDegraded(entries: readonly DegradedEntry[]): DegradedEntry[] {
  const groups = new Map<string, { entry: DegradedEntry; count: number }>()
  for (const entry of entries) {
    const key = `${entry.source}\\u0000${entry.code}\\u0000${entry.reason}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { entry, count: 1 })
    else existing.count += 1
  }
  return [...groups.values()].map(({ entry, count }) => ({ ...entry, count }))
}

function deniedNoiseHost(url: string, denylist: readonly string[]): string | undefined {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  const match = denylist.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  return match
}

function noiseReason(
  item: IntelItem,
  denylist: readonly string[],
  relevance?: { destination?: string; keywords?: readonly string[] },
): string | undefined {
  const deniedHost = deniedNoiseHost(item.source.url, denylist)
  if (deniedHost !== undefined) return `host_denylist:${deniedHost}`
  const title = item.title.trim()
  const signal = NOISE_TITLE_PATTERNS.find(({ pattern }) => pattern.test(title))
  if (signal !== undefined) return `title_signal:${signal.reason}`
  if (relevance === undefined) return undefined

  const body = typeof item.content === 'string' ? item.content : ''
  const hay = `${item.title} ${item.summary} ${body}`.trim()
  const regionTerms = [relevance.destination, ...(relevance.keywords ?? [])]
    .filter((term): term is string => typeof term === 'string' && term.trim().length >= 2)
    .flatMap((term) => {
      const normalized = term.trim().toLowerCase()
      const variants = [normalized]
      // Match a compact regional stem such as 青甘 in 青甘大环线, while
      // retaining the full phrase to avoid broad host-based allow-listing.
      const stem = normalized.replace(/(?:大环线|环线|旅游区|景区|地区|旅游)$/u, '')
      if (stem.length >= 2 && stem !== normalized) variants.push(stem)
      return variants
    })
  const hasRegionMatch = regionTerms.some((term) => hay.toLowerCase().includes(term))
  // A generic tourism phrase is not enough: require either a requested region or
  // an explicit POI/service signal. This prevents a host (notably social/video
  // hosts) from becoming a relevance allow-list by itself.
  const hasExplicitPoiSignal = item.category === 'attraction' || item.category === 'lodging'
    || item.category === 'food' || item.category === 'transportLocal' || item.category === 'recommend'
    || /景点|景区|公园|古镇|丹霞|湖|寺|博物馆|雪山|峡谷|草原|沙漠|遗址|瀑布|花海|门票|酒店|宾馆|民宿|客栈|住宿|餐厅|饭店|小吃|火锅|交通|公交|地铁|打车|租车|自驾|公里|停车|机场|车站/i.test(hay)
  const hasTravelSignal = classifyIntelCategoryEvidence(item.title, `${item.summary} ${body}`).positive
  if (!hasRegionMatch && !hasExplicitPoiSignal) return 'irrelevant:no_region_or_poi'
  if (!hasTravelSignal && !hasExplicitPoiSignal) return 'irrelevant:no_travel_signal'
  return undefined
}

/**
 * L1 可逆噪声门：域名 deny-list + 强下载/注册/推广/转换标题信号，
 * 并在 fan-out 提供查询上下文时要求地域或明确 POI/服务证据。噪声不进入
 * items，并按 item.channel+reason 聚合回执。
 */
export function filterIntelNoise(
  items: readonly IntelItem[],
  denylist: readonly string[] = INTEL_NOISE_HOST_DENYLIST,
  now: string = new Date().toISOString(),
  relevance?: { destination?: string; keywords?: readonly string[] },
): IntelNoiseGateResult {
  const kept: IntelItem[] = []
  const dropped: DegradedEntry[] = []
  for (const item of items) {
    const reason = noiseReason(item, denylist, relevance)
    if (reason === undefined) kept.push(item)
    else dropped.push({ source: item.channel, code: 'NOISE', reason, at: now })
  }
  return { items: kept, degraded: aggregateDegraded(dropped) }
}

/** 可重试失败码（瞬时类）；EMPTY 属确定性无结果，重试无收益。 */
const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'TIMEOUT'])

/** 渠道任务包装：抛出的任何异常 → {ok:false}（EngineError 归一化兜底）。 */
async function runChannelTask(
  channel: FanoutOptions['channels'][number],
  query: FanoutOptions['query'],
  ctx: ResearchChannelContext,
): Promise<ResearchChannelOutcome> {
  try {
    return await channel.run(query, ctx)
  } catch (error) {
    // 契约要求渠道自归一化；此处兜底任何漏网异常（UNAVAILABLE，不吞细节）
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'UNAVAILABLE', reason: `渠道内部异常（未按契约归一化）：${message}` }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 在剩余预算内执行渠道，含单源重试：
 * - 每次尝试经 Promise.race 对剩余预算截断（超预算 → TIMEOUT 记账）
 * - 失败且可重试（UNAVAILABLE/TIMEOUT）→ 按退避序列重试（≤retries 次）；
 *   等待时长计入总预算（退避 > 剩余预算则不再重试）
 * - 最终失败返回最后一次尝试的 outcome（单条 degraded 记账，不逐次膨胀）
 */
async function withChannelBudget(
  channel: FanoutOptions['channels'][number],
  query: FanoutOptions['query'],
  deadlineMs: number,
  budgetMs: number,
  env: KeyResolutionEnv | undefined,
  retryDelays: readonly number[],
  usage: UsageRecorder,
): Promise<ResearchChannelOutcome> {
  let outcome: ResearchChannelOutcome = { ok: false, code: 'TIMEOUT', reason: '总超时预算已耗尽（渠道未启动）' }
  let attempt = 0
  for (;;) {
    const remaining = deadlineMs - Date.now()
    if (remaining <= 0) {
      if (attempt === 0) return outcome
      return outcome // 重试耗尽预算：保留最近一次失败结果
    }
    usage.recordFanout('attempt') // M3.3 只观测：每次执行尝试计数
    const task = runChannelTask(channel, query, { deadlineMs, budgetMs, env })
    const timeout = new Promise<ResearchChannelOutcome>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, code: 'TIMEOUT', reason: `超过统一时间预算（${budgetMs}ms 内未完成）` })
      }, remaining)
      if (typeof timer.unref === 'function') timer.unref()
    })
    outcome = await Promise.race([task, timeout])
    if (outcome.ok) return outcome
    if (!RETRYABLE_CODES.has(outcome.code) || attempt >= retryDelays.length) return outcome
    const delay = retryDelays[attempt]
    if (delay <= 0) {
      attempt += 1
      usage.recordFanout('retry')
      continue
    }
    // 退避等待计入总预算：预算装不下则放弃重试
    if (Date.now() + delay > deadlineMs) return outcome
    await sleep(delay)
    attempt += 1
    usage.recordFanout('retry')
  }
}

/**
 * 渠道清单驱动并发 fan-out（W3 完整版：开关过滤 + 重试 + 聚合三件套）。
 * 本体仍是「渠道清单驱动 + Promise.allSettled + 预算截断」——W3 只加厚不重写。
 * M3.3：以 query.planId 开启用量 plan 归因作用域（AsyncLocalStorage），链路内
 * 适配器/治理埋点自动归属该 plan；attempts/retries/degraded 就地聚合计数（只观测）。
 */
export async function runChannelFanout(options: FanoutOptions): Promise<FanoutResult> {
  const usage = defaultUsageRecorder()
  const planId = typeof options.query.planId === 'string' ? options.query.planId : undefined
  return usage.runWithPlan(planId, () => runChannelFanoutInstrumented(options, usage))
}

async function runChannelFanoutInstrumented(options: FanoutOptions, usage: UsageRecorder): Promise<FanoutResult> {
  const deadlineMs = options.deadlineMs ?? Date.now() + options.budgetMs
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const env = options.env
  // 单次规划开始：重置规划预算（每 research 入口调用一次——CLOSURE §三-③）。
  // 长驻进程多次规划后不重置 → amap 预算计数跨规划累积 → 永久熔断静默降级。
  options.resetPlanBudget?.()
  const executed: string[] = []
  const degraded: DegradedEntry[] = []
  const counts: Record<string, number> = {}
  const items: IntelItem[] = []
  const observations: Array<{ channel: string; item: IntelItem }> = []

  const settled = await Promise.allSettled(options.channels.map(async (channel) => {
    executed.push(channel.name)
    // a. 渠道开关前置过滤（ADR-12：settings 热读 →「已停用（用户配置）」）
    if (env !== undefined && !channelEnabled(channel.name, env)) {
      return { channel, outcome: { ok: false, code: 'UNAVAILABLE', reason: '已停用（用户配置）' } as ResearchChannelOutcome }
    }
    let available = true
    try {
      available = await channel.available()
    } catch {
      available = false
    }
    if (!available) {
      return { channel, outcome: { ok: false, code: 'UNAVAILABLE', reason: '渠道不可用（Key/注入缺失或未挂载）' } as ResearchChannelOutcome }
    }
    const outcome = await withChannelBudget(channel, options.query, deadlineMs, options.budgetMs, env, retryDelays, usage)
    return { channel, outcome }
  }))

  for (const entry of settled) {
    if (entry.status === 'rejected') {
      // allSettled 的拒绝只可能来自编排器自身异常（渠道执行已被包装）——防御性记账
      degraded.push(toDegraded('orchestrator', 'UNAVAILABLE', '编排器内部异常', new Date().toISOString()))
      usage.recordDegraded('orchestrator', 'UNAVAILABLE')
      continue
    }
    const { channel, outcome } = entry.value
    // 复合渠道（例如腾讯 POI→高德 POI）可返回内部降级；保留每一源的
    // 诚实回执，避免 fallback 成功后吞掉主源失败或双空原因。
    for (const nested of outcome.degraded ?? []) {
      degraded.push(nested)
      usage.recordDegraded(nested.source, nested.code)
    }
    if (outcome.ok) {
      items.push(...outcome.items)
      observations.push(...outcome.items.map((item) => ({ channel: channel.name, item })))
      counts[channel.name] = outcome.items.length
    } else {
      degraded.push(toDegraded(channel.name, outcome.code, outcome.reason, new Date().toISOString()))
      usage.recordDegraded(channel.name, outcome.code)
      counts[channel.name] = 0
    }
  }

  const noise = filterIntelNoise(items, INTEL_NOISE_HOST_DENYLIST, new Date().toISOString(), {
    destination: options.query.destination,
    keywords: options.query.keywords,
  })
  degraded.push(...noise.degraded)
  const acceptedObjects = new Set(noise.items)
  const acceptedObservations = observations.filter(({ item }) => acceptedObjects.has(item))
  const aggregated = aggregateIntelItemsWithReport(noise.items, { now: new Date() })
  degraded.push(...aggregated.degraded)

  // M3.3：research 收口即防抖落盘用量快照（fire-and-forget；失败只 warn 不影响结果）
  void usage.flush()

  return {
    items: aggregated.items,
    observations: acceptedObservations,
    degraded,
    counts,
    executed,
  }
}

// ────────────────────────── 聚合三件套（W3：去重/冲突/时效） ──────────────────────────

/**
 * 聚合去重键（§5.4 行 389 铁律：去重键=笔记 ID/POI ID，非 URL 全串）：
 * - 社媒条目 id 已按「平台:笔记ID」编码 → 剥前缀取内容 ID（l0: 与 xhs: 同笔记归一）
 * - tencent/amap POI id 自带 POI ID → 原样
 * 跨渠道 L0（`l0:<id>`）与 L0.5（`xhs:<id>` 等）同笔记折叠为一条。
 */
export function intelDedupKey(item: Pick<IntelItem, 'id'>): string {
  const id = item.id
  const social = /^(xhs|zhihu|douyin|l0):(.+)$/.exec(id)
  if (social) return social[2]
  const socialBatch = /^social-[a-z]+-(.+)$/.exec(id)
  if (socialBatch) return socialBatch[1]
  return id
}

/** 条目质量取富（去重合并时保留信息更全的一条）。 */
function richerIntel(a: IntelItem, b: IntelItem): IntelItem {
  const confidenceRank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }
  const rankA = confidenceRank[a.confidence]
  const rankB = confidenceRank[b.confidence]
  if (rankA !== rankB) return rankA > rankB ? a : b
  // 同置信度：摘要更长者信息更全
  return (a.summary?.length ?? 0) >= (b.summary?.length ?? 0) ? a : b
}

/** 交叉来源聚合并去重（保留首次出现顺序；重复取质量更富者）。 */
export function dedupeIntelItems(items: readonly IntelItem[]): IntelItem[] {
  const best = new Map<string, IntelItem>()
  for (const item of items) {
    const key = intelDedupKey(item)
    const existing = best.get(key)
    if (existing === undefined) {
      best.set(key, item)
    } else {
      best.set(key, richerIntel(existing, item))
    }
  }
  const seen = new Set<string>()
  const out: IntelItem[] = []
  for (const item of items) {
    const key = intelDedupKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(best.get(key) as IntelItem)
  }
  return out
}

/** 规范化对象名：去空白/标点/常见后缀，用于同对象判定。 */
function normalizeObjectName(title: string): string {
  return title
    .replace(/[\s·•、，,。.！!？?：:；;（）()【】[\]\-—/\\]+/g, '')
    .replace(/(推荐|攻略|避雷|踩坑|指南|游玩|怎么玩|点评|怎么样)$/i, '')
    .toLowerCase()
}

/** 结构化字段是否构成矛盾（评分差 ≥1 / 人均差 ≥30% / 营业时间不同）。 */
function structuredConflict(a: IntelItem, b: IntelItem): boolean {
  if (a.rating !== undefined && b.rating !== undefined && Math.abs(a.rating - b.rating) >= 1) return true
  if (a.avgPrice !== undefined && b.avgPrice !== undefined && a.avgPrice > 0 && b.avgPrice > 0
    && Math.abs(a.avgPrice - b.avgPrice) / Math.max(a.avgPrice, b.avgPrice) >= 0.3) return true
  if (a.openingHours !== undefined && b.openingHours !== undefined && a.openingHours !== b.openingHours) return true
  return false
}

/** 类别极性矛盾（同为某对象：warning vs recommend/attraction）。 */
function polarConflict(a: IntelItem, b: IntelItem): boolean {
  const warn = (i: IntelItem): boolean => i.category === 'warning'
  const praise = (i: IntelItem): boolean => i.category === 'recommend' || i.category === 'attraction'
  return (warn(a) && praise(b)) || (warn(b) && praise(a))
}

/**
 * 冲突标注（FR-3 详 2：同一对象多源矛盾时互链 conflictsWith）：
 * 同对象判定 = 规范化标题相等；矛盾判定 = 结构化字段冲突（评分/人均/营业时间）
 * 或类别极性冲突（避雷 vs 推荐）。互链（对称），链入全部冲突条目 id。
 */
export function annotateConflicts(items: readonly IntelItem[]): IntelItem[] {
  const out = items.map((i) => ({ ...i }))
  const byName = new Map<string, number[]>()
  out.forEach((item, idx) => {
    const key = normalizeObjectName(item.title)
    if (!key) return
    const list = byName.get(key) ?? []
    list.push(idx)
    byName.set(key, list)
  })
  for (const [key, idxs] of byName) {
    if (idxs.length < 2 || !key) continue
    for (let i = 0; i < idxs.length; i += 1) {
      for (let j = i + 1; j < idxs.length; j += 1) {
        const a = out[idxs[i]]
        const b = out[idxs[j]]
        if (!structuredConflict(a, b) && !polarConflict(a, b)) continue
        const link = (target: IntelItem, otherId: string): void => {
          const existing = target.conflictsWith ?? []
          if (!existing.includes(otherId)) target.conflictsWith = [...existing, otherId]
        }
        link(a, b.id)
        link(b, a.id)
      }
    }
  }
  return out
}

/** 12 个月时效窗口（FR-3 详 3：超过则降权并标注时间）。 */
export const STALENESS_DAYS = 365
export const TIMELINESS_DOWNRANK_DAYS = 730
export const TIMELINESS_FILTER_DAYS = 1825

export interface TimelinessResult {
  items: IntelItem[]
  degraded: DegradedEntry[]
}

function downgrade(item: IntelItem, mark?: string): IntelItem {
  const rank: Confidence[] = ['low', 'medium', 'high']
  const index = rank.indexOf(item.confidence)
  const confidence: Confidence = index > 0 ? rank[index - 1] : 'low'
  return {
    ...item,
    confidence,
    ...(mark === undefined ? {} : {
      summary: item.summary.includes(mark) ? item.summary : `${item.summary}${mark}`,
    }),
  }
}

function downgradeUnknownTimeliness(item: IntelItem): IntelItem {
  return downgrade(
    item,
    item.category === 'tip' || item.category === 'recommend'
      ? '（发布时间缺失或不可解析，时效性未知，已降权）'
      : undefined,
  )
}

function aggregateTimelinessDrops(entries: readonly DegradedEntry[]): DegradedEntry[] {
  const groups = new Map<string, { entry: DegradedEntry; count: number }>()
  for (const entry of entries) {
    const key = `${entry.source}\u0000${entry.code}\u0000${entry.reason}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { entry, count: 1 })
    else existing.count += 1
  }
  return [...groups.values()].map(({ entry, count }) => ({ ...entry, count }))
}

/**
 * 时效处理：统一使用调用方传入的 UTC now，便于生产与测试确定性一致。
 * - tip/recommend >5 年过滤；>2 年降权并标记；
 * - 其他类别沿用 >12 个月降权；
 * - 缺少/不可解析发布时间不删除，只降权并明确「时效未知」。
 */
export function applyTimelinessWithReport(items: readonly IntelItem[], now: Date = new Date()): TimelinessResult {
  const cutoff = now.getTime()
  const out: IntelItem[] = []
  const dropped: DegradedEntry[] = []
  for (const item of items) {
    if (item.publishedAt === undefined) {
      // 缺日期不删除；tip/recommend 必须显式标注未知时效，其他类别保持既有摘要语义。
      out.push(downgradeUnknownTimeliness(item))
      continue
    }
    const normalizedDate = normalizePublishedAt(item.publishedAt)
    const published = normalizedDate === undefined
      ? new Date(Number.NaN)
      : new Date(`${normalizedDate}T00:00:00.000Z`)
    if (Number.isNaN(published.getTime())) {
      out.push(downgradeUnknownTimeliness(item))
      continue
    }
    const ageDays = Math.floor((cutoff - published.getTime()) / 86_400_000)
    if (ageDays <= 0) {
      out.push(item)
      continue
    }
    if ((item.category === 'tip' || item.category === 'recommend') && ageDays > TIMELINESS_FILTER_DAYS) {
      dropped.push({
        source: item.channel,
        code: 'STALE',
        // reason 是稳定的原因类别；具体发布日期不进入聚合键，count 表示同类丢弃数。
        reason: '内容超过 5 年，已过滤',
        at: now.toISOString(),
      })
      continue
    }
    if (item.category === 'tip' || item.category === 'recommend') {
      if (ageDays > TIMELINESS_DOWNRANK_DAYS) {
        out.push(downgrade(item, `（内容发布于 ${item.publishedAt}，已超 2 年，降权标注）`))
        continue
      }
    }
    if (ageDays > STALENESS_DAYS) {
      out.push(downgrade(item, `（内容发布于 ${item.publishedAt}，已超 12 个月，降权标注）`))
      continue
    }
    out.push(item)
  }
  return { items: out, degraded: aggregateTimelinessDrops(dropped) }
}

/** 保持既有 API：调用方只需要聚合条目时不暴露 dropped 报告。 */
export function applyTimeliness(items: readonly IntelItem[], now: Date = new Date()): IntelItem[] {
  return applyTimelinessWithReport(items, now).items
}

/** 聚合管线报告（去重 → 冲突标注 → 时效降权），fan-out 出口统一调用。 */
export function aggregateIntelItemsWithReport(
  items: readonly IntelItem[], opts: { now?: Date } = {},
): TimelinessResult {
  return applyTimelinessWithReport(annotateConflicts(dedupeIntelItems(items)), opts.now)
}

/** 兼容既有 API：仅返回聚合后的条目。 */
export function aggregateIntelItems(items: readonly IntelItem[], opts: { now?: Date } = {}): IntelItem[] {
  return aggregateIntelItemsWithReport(items, opts).items
}
