/**
 * 适配器层治理——robots/ToS 检查（design §5.4 三层渠道 / §9.3-7；NFR-4
 * requirements.md:179「抓取行为遵守目标站点 robots 与服务条款，控制请求频率」；
 * roadmap M2.6）。开关位 `advanced.robotsToSCheck`（默认开），base.ts 治理层热读取。
 *
 * 覆盖域：L0.5 直抓域（design.md:373 五层机制表 L0.5 行；三层渠道定义
 * design.md:360-383）——`L05_SCRAPE_DOMAINS`：
 * - xiaohongshu.com（小红书 explore SSR 直抓）
 * - zhihu.com（知乎专栏直抓）
 * 抓取命中 URL 前查 `https://<host>/robots.txt`（桌面 UA），目标路径被
 * Disallow → 该源跳过直抓并降级标注（NFR-4）。解析结果域级缓存（短 TTL，
 * 复用 T1 `amap.TtlCache` 条目级 TTL 模式 8d21724）。
 *
 * robots.txt 获取失败口径（design §9.3 robots 段仅「开关默认开」一句，按
 * NFR-4 合规语义取舍并注释）：
 * - **404 → fail-open**：站点明确无 robots 文件 = 无访问规则（RFC 9309
 *   §2.3），不误伤正常站点，允许抓。
 * - **网络错误 / 5xx / 其他非 200 → fail-closed**：访问规则未知时合规优先
 *   （NFR-4：宁可降级标注也不违规抓取），拒绝直抓并记 degraded。
 * 两者都缓存（短 TTL），避免每次抓取前重复拉取 robots.txt 自身成新频控源。
 *
 * 解析器为最小集（设计只要求 Disallow 语义）：User-agent 分组（`*` 兜底 +
 * 具体 UA 前缀优先）、`Disallow` 路径模板（`*` 通配 + `$` 锚定，前缀匹配）。
 * Allow/Sitemap 等不在本轮范围（W2/W3 若需再扩展）。
 */
import type { DegradedEntry } from '../base.js'

/** L0.5 直抓域（design.md:373 三层渠道定义；W2/W3 直抓前置检查即遍历此表）。 */
export const L05_SCRAPE_DOMAINS = ['xiaohongshu.com', 'zhihu.com'] as const

/** 桌面 UA（robots 请求与直抓同一身份，遵守 NFR-4「同一身份不规避」）。 */
export const ROBOTS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 解析结果缓存 TTL（短 TTL：robots 规则变更不必长滞；也控制 robots 自身请求频率）。 */
export const ROBOTS_CACHE_TTL_MS = 10 * 60_000

/** robots.txt 抓取函数面（缺省 global fetch；测试注入 mock）。 */
export type RobotsFetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number
  text(): Promise<string>
}>

/** 检查决策。 */
export type RobotsDecision =
  | { allowed: true }
  /** 禁止直抓：rule=命中的 Disallow 模板；reason=robots（命中规则）/ fetch-error（规则未知，fail-closed）。 */
  | { allowed: false; rule: string; reason: 'robots' | 'fetch-error' }

/** 一组 User-agent 的 Disallow 规则（解析中间态）。 */
interface RobotsGroup {
  agents: string[]
  /** Disallow 路径模板（原文；空值=允许全部，解析时跳过）。 */
  disallow: string[]
}

/**
 * 解析 robots.txt 文本 → 分组规则。
 * 空模板（`Disallow:`）在 robots 语义中=无规则，忽略；注释/空行跳过。
 * 显式 User-agent 组（即使无 Disallow=该 UA 不限）保留，语义忠实。
 */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep < 0) continue
    const field = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (field === 'user-agent') {
      if (value.length === 0) continue
      // 新 UA 组：前组已收集 Disallow → 开新组；否则视为同组多 UA 行合并
      if (!current || current.disallow.length > 0) {
        current = { agents: [value], disallow: [] }
        groups.push(current)
      } else if (!current.agents.includes(value)) {
        current.agents.push(value)
      }
    } else if (field === 'disallow') {
      if (!current) continue
      if (value.length > 0) current.disallow.push(value)
    }
  }
  return groups
}

/**
 * 选出对给定 UA 生效的分组：存在具体 UA（前缀/包含，大小写不敏感）匹配组
 * 时只用它们（robots 惯例最具体优先）；否则 `*` 组兜底。
 */
export function groupsForUa(groups: RobotsGroup[], ua: string): RobotsGroup[] {
  const uaLower = ua.toLowerCase()
  const specific = groups.filter(
    (g) => !g.agents.includes('*') && g.agents.some((agent) => {
      const a = agent.toLowerCase()
      return uaLower.includes(a) || a.includes(uaLower)
    }),
  )
  if (specific.length > 0) return specific
  return groups.filter((g) => g.agents.includes('*'))
}

/**
 * Disallow 路径模板 → 正则（`*` → `.*`，`$` 锚定，其余字面转义；robots
 * 语义为路径前缀匹配：`/explore` 亦禁 `/explore/xxx`）。
 */
export function disallowToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') source += '.*'
    else if (ch === '$') source += '$'
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) source += `\\${ch}`
    else source += ch
  }
  return new RegExp(source)
}

/** 给定 UA 与路径，返回命中的 Disallow 模板（无则 undefined）。 */
export function matchDisallow(groups: RobotsGroup[], ua: string, pathname: string): string | undefined {
  for (const group of groupsForUa(groups, ua)) {
    for (const pattern of group.disallow) {
      const re = disallowToRegExp(pattern)
      if (re.test(pathname)) return pattern
    }
  }
  return undefined
}

/** URL → host（含端口剥离；非法 URL 返回 null）。 */
export function hostOf(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.hostname
  } catch {
    return null
  }
}

/** URL → pathname（含前导 `/`；非法 URL 返回 undefined）。 */
export function pathOf(raw: string): string | undefined {
  try {
    return new URL(raw).pathname
  } catch {
    return undefined
  }
}

/** 条目级 TTL 缓存（复用 T1 amap.TtlCache 8d21724 模式；governance 内嵌免耦合）。 */
class TtlCache<T> {
  private readonly store = new Map<string, { ts: number; data: T }>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs
    this.now = now
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (this.now() - entry.ts > this.ttlMs) {
      this.store.delete(key)
      return undefined
    }
    return entry.data
  }

  set(key: string, data: T): void {
    this.store.set(key, { ts: this.now(), data })
  }

  size(): number {
    return this.store.size
  }
}

/** 域级解析缓存条目。 */
type DomainRobotsRules =
  | { ok: true; groups: RobotsGroup[] }
  | { ok: false; reason: 'not-found' | 'error' }

export interface RobotsCheckerOptions {
  /** robots.txt 抓取注入（缺省 global fetch + UA 头；测试传 mock）。 */
  fetch?: RobotsFetchFn
  /** 请求 UA（缺省 ROBOTS_UA 桌面 UA）。 */
  ua?: string
  /** 解析缓存 TTL（缺省 ROBOTS_CACHE_TTL_MS 10 分钟）。 */
  ttlMs?: number
  /** 时钟注入（fake timers 测试用；缺省 Date.now）。 */
  now?: () => number
}

export class RobotsChecker {
  private readonly fetchFn: RobotsFetchFn
  private readonly ua: string
  private readonly now: () => number
  private readonly ttlMs: number
  private cache: TtlCache<DomainRobotsRules>
  private readonly fetchCount = new Map<string, number>()

  constructor(options: RobotsCheckerOptions = {}) {
    this.fetchFn = options.fetch ?? defaultRobotsFetch
    this.ua = options.ua ?? ROBOTS_UA
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? ROBOTS_CACHE_TTL_MS
    this.cache = new TtlCache<DomainRobotsRules>(this.ttlMs, this.now)
  }

  /** 域 robots.txt 抓取次数（测试断言缓存命中用）。 */
  fetchCountFor(host: string): number {
    return this.fetchCount.get(host) ?? 0
  }

  /** 清空缓存与计数（测试/开关重置）。 */
  reset(): void {
    this.cache = new TtlCache<DomainRobotsRules>(this.ttlMs, this.now)
    this.fetchCount.clear()
  }

  /** 拉取并解析域 robots 规则（404→not-found fail-open；其余失败→error fail-closed）。 */
  private async fetchRules(host: string): Promise<DomainRobotsRules> {
    this.fetchCount.set(host, (this.fetchCount.get(host) ?? 0) + 1)
    let response: Awaited<ReturnType<RobotsFetchFn>>
    try {
      response = await this.fetchFn(`https://${host}/robots.txt`, {
        headers: { 'User-Agent': this.ua, Accept: 'text/plain,*/*;q=0.1' },
      })
    } catch {
      return { ok: false, reason: 'error' } // 网络错误 → 规则未知 → fail-closed
    }
    if (response.status === 200) {
      const text = await response.text()
      return { ok: true, groups: parseRobotsTxt(text) }
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not-found' } // 无 robots 文件 = 无访问规则 → fail-open
    }
    return { ok: false, reason: 'error' } // 5xx/403 等 → 规则未知 → fail-closed
  }

  /**
   * 路径级 robots 判定（带域级 TTL 缓存）。开关（robotsToSCheck）不在本层
   * 判定——开关热读在 base.ts `governanceConfig`；关掉时调用方直接跳过本方法。
   */
  async isPathAllowed(rawUrl: string): Promise<RobotsDecision> {
    const host = hostOf(rawUrl)
    const path = pathOf(rawUrl)
    if (host === null || path === undefined) return { allowed: false, rule: 'URL 非法', reason: 'fetch-error' }
    const hit = this.cache.get(host)
    if (hit === undefined) {
      const rules = await this.fetchRules(host)
      this.cache.set(host, rules)
      if (rules.ok) {
        const matched = matchDisallow(rules.groups, this.ua, path)
        return matched !== undefined
          ? { allowed: false, rule: matched, reason: 'robots' }
          : { allowed: true }
      }
      if (rules.reason === 'not-found') return { allowed: true } // fail-open
      return { allowed: false, rule: 'robots.txt 不可达（规则未知，fail-closed）', reason: 'fetch-error' }
    }
    if (hit.ok) {
      const matched = matchDisallow(hit.groups, this.ua, path)
      return matched !== undefined
        ? { allowed: false, rule: matched, reason: 'robots' }
        : { allowed: true }
    }
    if (hit.reason === 'not-found') return { allowed: true }
    return { allowed: false, rule: 'robots.txt 不可达（规则未知，fail-closed）', reason: 'fetch-error' }
  }

  /** 预检（非异步）：缓存命中时同步决策，未命中返回 undefined（调用方决定
   *  是否等异步拉取）。W2/W3 高频预筛可用。 */
  peek(rawUrl: string): RobotsDecision | undefined {
    const host = hostOf(rawUrl)
    const path = pathOf(rawUrl)
    if (host === null || path === undefined) return { allowed: false, rule: 'URL 非法', reason: 'fetch-error' }
    const hit = this.cache.get(host)
    if (hit === undefined) return undefined
    if (hit.ok) {
      const matched = matchDisallow(hit.groups, this.ua, path)
      return matched !== undefined ? { allowed: false, rule: matched, reason: 'robots' } : { allowed: true }
    }
    return hit.reason === 'not-found' ? { allowed: true } : { allowed: false, rule: 'robots.txt 不可达（fail-closed）', reason: 'fetch-error' }
  }
}

/** 缺省 robots.txt 抓取（global fetch + 桌面 UA；非 2xx 也返回响应体，由调用方判定）。 */
export const defaultRobotsFetch: RobotsFetchFn = async (url, init) => {
  const res = await fetch(url, {
    headers: init.headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  })
  return {
    status: res.status,
    text: () => res.text(),
  }
}

/** 快捷记账：robots 禁抓 → degraded 条目（code UNAVAILABLE；源名由调用方给）。 */
export function robotsBlockedEntry(source: string, url: string, decision: Extract<RobotsDecision, { allowed: false }>): DegradedEntry {
  return {
    source,
    code: 'UNAVAILABLE',
    reason: decision.reason === 'robots'
      ? `robots.txt Disallow 禁抓（${url}；规则 ${decision.rule}）`
      : `robots.txt 不可达，保守拒绝直抓（${url}）`,
    at: new Date().toISOString(),
  }
}