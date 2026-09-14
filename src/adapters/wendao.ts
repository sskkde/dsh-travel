/**
 * wendao（携程问道）适配器（W2b）：按需增强的查询型结构化源（design §3.3 行 88-97）。
 *
 * 实测口径（learnings 行 22；research/ctrip-wendao-platforms.md 行 53）：
 * `POST https://wendao-skill-prod.ctrip.com/skill/query`，payload
 * `{token, query, source:"github"}`，**响应为纯 Markdown**（非 JSON）；
 * 机票/火车票/酒店/门票/美食实测优秀（含价格与 m.ctrip.com 深链）；汽车票
 * 咨询级（车站/票价区间/车程，无实时班次）；行程规划返回空壳不可用；
 * 无预订交易（多处明示"无法完成预订"）。
 *
 * 配额实测（W4 live）：**per-token 每日 30 次上限**——超限响应为 HTTP 200 +
 * JSON 错误体 `{"error":"Per-token daily limit exceeded (30)."}`（非 Markdown）。
 * 适配器对该形态显式抛 EngineError.UNAVAILABLE（上游错误原文透传），杜绝把
 * 错误体误当 Markdown 解析成垃圾条目污染降级链（W4 前行为：错误行被吸成 1 条目）。
 *
 * 无 key → **自动休眠**：available()=false 且 query() 零网络调用（防御性
 * 断言见单测）；Key 读取只经 base.ts resolveKey（settings→credentials→env，
 * ADR-12），代码/fixture/日志零明文。fixture 录制器强制清洗 key/链接参数。
 */
import { BaseAdapter, CAP_NATURAL_LANGUAGE, CAP_STRUCTURED_RESULT, EngineError, toDegraded, toEngineError, channelEnabled, isKeyConfigured, type DegradedEntry, type KeyResolutionEnv } from './base.js'

/** 携程问道官方端点（实测，learnings 行 22）。 */
export const WENDAO_ENDPOINT = 'https://wendao-skill-prod.ctrip.com/skill/query'

/** Key 标识符（编排者约定）：resolveKey 首参，环境兜底名=标识符本身
 * （process.env.wendao）；credentials 层 resolveCredential 回调把标识符映射为
 * ref `WENDAO_APIKEY` 再调 ctx.credentials.resolve(ref)（W6 接线）。
 */
export const WENDAO_KEY = 'wendao'

export const WENDAO_SOURCE = 'github'
/** credentials ref 映射（编排者交割：identifier → ref；供 W6 resolveCredential 回调）。 */
export const WENDAO_CRED_REF = 'WENDAO_APIKEY'

/** 票种 → 模板票名词（design §5.1 行 268：`查询{date}{origin}到{destination}的{mode}票`）。 */
export type WendaoTicketMode = 'flight' | 'rail' | 'bus'

const TICKET_NOUN: Record<WendaoTicketMode, string> = {
  flight: '机票',
  rail: '火车票',
  bus: '汽车票',
}

/**
 * 请求模板拼接（design §5.1 行 268 实测口径）：规范形（城市中文名 + YYYY-MM-DD）
 * → 携程问道自然语言问句。例：`查询2026-09-20杭州到北京的机票`。
 * 日期缺省时省略日期段（开放日期咨询；research-transport 恒传 dateStart）。
 */
export function buildWendaoQuery(mode: WendaoTicketMode, origin: string, destination: string, date?: string): string {
  const ticket = TICKET_NOUN[mode]
  return date && date.trim() !== ''
    ? `查询${date.trim()}${origin}到${destination}的${ticket}`
    : `查询${origin}到${destination}的${ticket}`
}

/** m.ctrip.com 深链域名（提取过滤）。 */
const CTRIP_M_HOST = /(^|\.)m\.ctrip\.com$/i

export interface WendaoEntry {
  /** 条目标题（小节下首个有效行缩略）。 */
  title: string
  /** 所属小节（markdown 标题文本，如「机票」「火车票」）。 */
  section?: string
  /** 摘要（markdown 链接内文本已剥除，纯文本行）。 */
  summary: string
  /** m.ctrip.com 深链（markdown [t](url) 与裸 URL 提取；参数原文保留由调用方脱敏）。 */
  deepLinks: string[]
}

export interface WendaoResult {
  entries: WendaoEntry[]
  /** 原始 markdown（调试/降级展示用；不落盘）。 */
  raw: string
  degraded: DegradedEntry[]
}

/** 最小 fetch 形态（tsconfig lib=ES2023 无 DOM；node 全局 fetch 运行时兼容）。 */
export interface FetchLike {
  (input: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>
}

export interface WendaoOptions {
  /** 注入 fetch（单测/离线 fixture 用；缺省全局 fetch）。 */
  fetchFn?: FetchLike
  endpoint?: string
  timeoutMs?: number
}

/** 剥除 markdown 链接语法，返回纯文本。 */
export function stripMarkdownLinks(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)\s]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)\s]+\)/g, '')
    .replace(/[#*`>_~]/g, '')
    .trim()
}

/**
 * 上游 JSON 错误体探测：HTTP 200 + `{"error":"..."}`（如 per-token 每日配额
 * 超限）。命中返回 error 原文；普通 Markdown / 非错误 JSON 返回 undefined。
 */
export function extractJsonErrorPayload(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const err = (parsed as Record<string, unknown>).error
      if (typeof err === 'string' && err.trim() !== '') return err.trim()
    }
  } catch {
    // 非 JSON（残缺体）→ 按 Markdown 走原路径
  }
  return undefined
}

/** 提取 markdown 文本中的深链：仅保留 m.ctrip.com 域。 */
export function extractCtripDeepLinks(markdown: string): string[] {
  const out = new Set<string>()
  const markdownLinks = markdown.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)
  for (const m of markdownLinks) out.add(m[1])
  const bare = markdown.matchAll(/https?:\/\/[^\s)\]》>，,]+/g)
  for (const m of bare) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    out.add(url)
  }
  const filtered = [...out].filter((u) => {
    try {
      return CTRIP_M_HOST.test(new URL(u).hostname)
    } catch {
      return false
    }
  })
  // 稳定排序 + 精确去重（query 携带 flightNo/date 等语义参数，不能按 path 折叠）
  return [...new Set(filtered)].sort()
}

/**
 * 纯 Markdown → 结构化条目：`# 小节` → section；有效行 → entry；
 * 链接行并入条目 summary/deepLinks。空行/分隔线/纯链接跳章忽略。
 *
 * 实测形态 v2（W4 配额重置复跑 2026-09-05 留证 .tmp → fixture query-flights-v2.md）：
 * 一个航班 = `##### [航司 机型](<m.ctrip.com 深链含 dfltno/price 参数>)` 标题 +
 * 起飞/到达/飞行时间/价格多行 bullet。两处适配：①标题行内的 ctrip 深链暂存，
 * 并入该标题块下产生的首个条目（标题降 section 不能丢航班号/价格参数）；
 * ②连续 bullet 行聚合为单条目（逐行成条会把单时刻/单价格拆成残缺 option，
 * parseFlightsFromMarkdown 拼不出完整方案）。旧形态（编号行全信息）不受影响。
 */
export function parseWendaoMarkdown(markdown: string): { entries: WendaoEntry[]; sections: string[] } {
  const entries: WendaoEntry[] = []
  const sections: string[] = []
  let currentSection: string | undefined
  let pendingSectionLinks: string[] = []
  let bulletBuffer: string[] = []
  let bulletLinks: string[] = []

  const flushBulletBuffer = (): void => {
    if (!bulletBuffer.length) return
    const summary = bulletBuffer.join(' ')
    const deepLinks = [...new Set([...pendingSectionLinks, ...bulletLinks])].sort()
    entries.push({
      title: (currentSection ?? summary).length > 80 ? `${(currentSection ?? summary).slice(0, 80)}…` : currentSection ?? summary,
      section: currentSection,
      summary,
      deepLinks,
    })
    pendingSectionLinks = []
    bulletBuffer = []
    bulletLinks = []
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      flushBulletBuffer()
      const text = stripMarkdownLinks(heading[1])
      const headingLinks = extractCtripDeepLinks(heading[1])
      if (text) {
        currentSection = text
        sections.push(text)
      }
      if (headingLinks.length) pendingSectionLinks = headingLinks
      continue
    }
    const trimmed = rawLine.trim()
    if (!trimmed || /^[-*_=]{3,}$/.test(trimmed)) continue
    if (/^[-*+]\s+/.test(trimmed)) {
      const text = stripMarkdownLinks(trimmed.replace(/^[-*+]\s+/, ''))
      if (text) bulletBuffer.push(text)
      bulletLinks.push(...extractCtripDeepLinks(trimmed))
      continue
    }
    flushBulletBuffer()
    const text = stripMarkdownLinks(trimmed.replace(/^\d+[.、]\s*/, ''))
    if (!text) continue
    if (/^https?:\/\//.test(trimmed) && !extractCtripDeepLinks(trimmed).length) continue
    const deepLinks = extractCtripDeepLinks(trimmed)
    entries.push({
      title: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      section: currentSection,
      summary: text,
      deepLinks: [...new Set([...pendingSectionLinks, ...deepLinks])].sort(),
    })
    pendingSectionLinks = []
  }
  flushBulletBuffer()
  return { entries: mergeLinkLines(entries), sections }
}

/** 合并：无深链条目吸收紧随其后的短链接行（链接并入上一条目，避免孤立「查看详情」条目）。 */
export function mergeLinkLines(entries: WendaoEntry[]): WendaoEntry[] {
  const merged: WendaoEntry[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    if (e.deepLinks.length) {
      merged.push(e)
      continue
    }
    const next = entries[i + 1]
    if (next && next.deepLinks.length && next.title.length <= 16 && !next.summary.includes('：')) {
      merged.push({ ...e, deepLinks: next.deepLinks, summary: `${e.summary} ${next.summary}` })
      i += 1
      continue
    }
    merged.push(e)
  }
  return merged
}

export class WendaoAdapter extends BaseAdapter {
  private readonly fetchFn: FetchLike
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(opts: WendaoOptions = {}) {
    super('wendao', {
      supports: new Set([CAP_NATURAL_LANGUAGE, CAP_STRUCTURED_RESULT]),
    })
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike).bind(globalThis)
    this.endpoint = opts.endpoint ?? WENDAO_ENDPOINT
    this.timeoutMs = opts.timeoutMs ?? 20000
  }

  /** 无 key / 渠道关闭 → 休眠（fan-out 前置过滤跳过）。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('wendao', env)) return false
    return isKeyConfigured(WENDAO_KEY, env)
  }

  /**
   * 查询（纯 Markdown 响应 → 结构化条目 + 深链）。
   * 无 key → 抛 EngineError.UNAVAILABLE「Key 未配置（休眠）」——**且不发起
   * 任何网络调用**（零调用保证由单测以注入 fetch 间谍断言）。
   */
  async query(text: string, env?: KeyResolutionEnv): Promise<WendaoResult> {
    const key = await this.resolveChainKey(WENDAO_KEY, env)
    if (!key) {
      throw EngineError.unavailable('Key 未配置（休眠，零调用）', 'wendao')
    }
    const degraded: DegradedEntry[] = []
    let raw = ''
    try {
      raw = await this.postQuery(key.value, text)
    } catch (err) {
      const engineErr = toEngineError(err, 'wendao')
      degraded.push(toDegraded(this.name, engineErr))
      throw engineErr
    }
    // 上游 JSON 错误体（HTTP 200 + {"error": ...}，如每日配额超限）→ 显式抛
    // EngineError（原文透传），不进 Markdown 解析（否则错误行被吸成垃圾条目）。
    const errorPayload = extractJsonErrorPayload(raw)
    if (errorPayload !== undefined) {
      throw EngineError.unavailable(`wendao 上游错误：${errorPayload}`, 'wendao')
    }
    const { entries } = parseWendaoMarkdown(raw)
    if (!entries.length) {
      degraded.push(toDegraded(this.name, 'EMPTY', '响应无结构化内容（纯 Markdown 解析为空）'))
    }
    return { entries, raw, degraded }
  }

  private async postQuery(token: string, query: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = await Promise.race([
        this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/plain, text/markdown, */*' },
          body: JSON.stringify({ token, query, source: WENDAO_SOURCE }),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(EngineError.timeout(`wendao 查询超时（${this.timeoutMs}ms）`)), this.timeoutMs)
        }),
      ])
      if (!res.ok) {
        throw new Error(`wendao HTTP ${res.status}`)
      }
      return await res.text()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}