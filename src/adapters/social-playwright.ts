/**
 * Playwright 社媒适配器（W3a：L1 登录态定向搜索 + L2 JS 渲染正文的共用载体）。
 *
 * 伴随服务=microsoft/playwright-mcp（Apache-2.0，免 key，Streamable HTTP :8931，
 * 部署/登录态挂载见 docs/deploy.md 与 .test-env/playwright-mcp.sh）：
 * - L1（M2.2）：登录态搜索页定向（微博/贴吧/快手）——storageState 挂载后
 *   browser_navigate 搜索 URL + browser_evaluate 提取结果链接；
 * - L2（M2.2）：抖音详情页正文渲染（JS-SPA，L0/L0.5 不可达，必须浏览器渲染）。
 * 传输复用 rail12306.ts 的 McpStreamClient（W2/W5 同款注入模式）：
 * - 只读白名单闸门（readOnlyGate）：仅浏览器只读原语（navigate/evaluate/snapshot/
 *   wait_for/console_messages/close），点击/输入/表单/上传等交互类与下载类一律
 *   编译期拒绝（§5.6 工具收敛同款红线）；
 * - 无 key（CAP_ZERO_KEY）；频控/robots 走治理基座（W1）。
 *
 * 与 dsh-web-search-pro 的协同边界：web-search-pro 提供宿主 ctx.web provider
 * （L0 泛搜索自动增强，配置驱动，见 deploy.md）与本适配器零代码耦合；
 * dsh-travel 侧 L1/L2 不依赖其编程面（router 未暴露 ctx 服务，M2.2 探明）。
 */
import {
  BaseAdapter, CAP_ZERO_KEY, channelEnabled, toDegraded,
  type DegradedEntry, type DomainTokenBucket, type KeyResolutionEnv,
} from './base.js'
import { McpStreamClient, type FetchLike } from './rail12306.js'

/** Playwright MCP Streamable HTTP 端点（.test-env/playwright-mcp.sh 默认 :8931）。
 * 须用 localhost：服务端 Host 校验拒绝 127.0.0.1 字面量（实测 403，部署脚本同款口径）。 */
export const DEFAULT_PLAYWRIGHT_MCP_URL = 'http://localhost:8931/mcp'
/** 端点环境变量覆盖（部署端口漂移时）。 */
export const PLAYWRIGHT_MCP_URL_ENV = 'TRAVEL_PLAYWRIGHT_MCP_URL'

/** 只读白名单：浏览器只读原语。白名单外（click/type/fill/press/drag/hover/
 * select_option/file_upload/tabs/截图/网络读取等）一律拒绝。 */
export const PLAYWRIGHT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate',
  'browser_evaluate',
  'browser_snapshot',
  'browser_wait_for',
  'browser_console_messages',
  'browser_close',
])

/** 只读闸门（McpClientOptions.readOnlyGate 注入；白名单外编译期拒绝）。 */
export function assertPlaywrightReadOnly(name: string): void {
  if (!PLAYWRIGHT_READONLY_TOOLS.has(name)) {
    throw new Error(`playwright-mcp 只读白名单拒绝工具：${name}（仅 ${[...PLAYWRIGHT_READONLY_TOOLS].join('/')}；交互/写类一律不挂载）`)
  }
}

/** L1 覆盖的平台（三层三平台；登录态 storageState 共用一份）。 */
export const PLAYWRIGHT_L1_PLATFORMS = ['weibo', 'tieba', 'kuaishou'] as const
export type PlaywrightL1Platform = (typeof PLAYWRIGHT_L1_PLATFORMS)[number]

/** 平台 → 登录态搜索页 URL 模板（{q}=URL 编码关键词）。 */
export const L1_SEARCH_URL: Record<PlaywrightL1Platform, string> = {
  weibo: 'https://s.weibo.com/weibo?q={q}',
  tieba: 'https://tieba.baidu.com/f/search/res?ie=utf-8&qw={q}',
  kuaishou: 'https://www.kuaishou.com/search/video?searchKey={q}',
}

/** 平台结果域名过滤（防搜索页广告/外链误收；子域命中即可）。 */
const L1_RESULT_HOST: Record<PlaywrightL1Platform, RegExp> = {
  weibo: /(^|\.)weibo\.(com|cn)$/i,
  tieba: /(^|\.)tieba\.baidu\.com$/i,
  kuaishou: /(^|\.)kuaishou\.com$/i,
}

/** 登录墙/风控页特征（命中 → UNAVAILABLE degraded，走 L0 兜底）。 */
const LOGIN_WALL_RE = /(passport\.|signin|sign_in|\/login[?/"']|需要登录|扫码登录|请登录|verify|captcha)/i

/**
 * playwright-mcp 工具结果解包（实测 2026-09-05）：tools/call 的 text 块为
 * `### Ran Playwright code … ### Result\n<JSON>` 包装（snapshot 引用等），
 * 非「### Result」形态则按原样 JSON.parse。返回解包后的 JSON 值或 undefined。
 */
export function unwrapPlaywrightResult(text: string): unknown {
  const attempt = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate)
    } catch {
      return undefined
    }
  }
  const direct = attempt(text)
  if (direct !== undefined) return direct
  const marker = text.indexOf('### Result')
  if (marker >= 0) {
    const segment = text.slice(marker + '### Result'.length)
    // 以「文本中首个出现的开括号」决定配对类型——数组形态 `[{...},{...}]` 若先试
    // `{` 会错误配对到首个元素的单对象（实测 2026-09-05 交割后 L1 提取）
    const firstBrace = segment.search(/[[{]/)
    if (firstBrace >= 0) {
      const open = segment[firstBrace]
      const close = open === '[' ? ']' : '}'
      const payload = matchBracket(segment.slice(firstBrace), open, close)
      if (payload !== undefined) return attempt(payload)
    }
  }
  return undefined
}

/** 括号配对扫描（字符串/转义感知）；未闭合返回 undefined。 */
function matchBracket(segment: string, open: string, close: string): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return segment.slice(0, i + 1)
    }
  }
  return undefined
}

/** L1 搜索命中（标题/链接；摘要多数平台在列表页不可得，如实缺省）。 */
export interface PlaywrightSearchHit {
  title: string
  url: string
}

/** 结果提取脚本（browser_evaluate 注入；通用链接收集 + adapter 侧域名过滤，
 * 不依赖易变的 per-platform CSS 选择器）。 */
export const L1_EXTRACT_SNIPPET = `() => Array.from(document.querySelectorAll('a[href]'))
  .map(a => ({ href: a.href, text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ') }))
  .filter(x => x.href.startsWith('http') && x.text.length >= 6 && x.text.length <= 120)
  .slice(0, 40)`

/** 正文提取脚本（L2 抖音详情页；容器类文本聚合兜底）。 */
export const L2_EXTRACT_SNIPPET = `() => {
  const text = (document.body?.innerText || '').trim();
  return { title: (document.title || '').trim(), text: text.slice(0, 4000) };
}`

export interface PlaywrightSocialOptions {
  url?: string
  fetchFn?: FetchLike
  timeoutMs?: number
  /** 测试注入位（缺省 globalRateLimiter；治理基座 W1）。 */
  rateLimiter?: DomainTokenBucket
  /**
   * 伴随服务按需拉起钩子（M3.5 supervisor 接线位）：ping 失败时调用，
   * 返回 true = 服务已就绪可重试一次。缺省无（M2 行为：ping 失败即不可用）。
   */
  ensure?: () => Promise<boolean>
}

/** 单页提取结果（evaluate JSON 文本 → 结构化）。 */
interface ExtractedLink {
  href: string
  text: string
}

export class PlaywrightSocialAdapter extends BaseAdapter {
  readonly mcp: McpStreamClient
  private readonly ensure?: () => Promise<boolean>

  constructor(opts: PlaywrightSocialOptions = {}) {
    super('social-playwright', { supports: new Set([CAP_ZERO_KEY]) }, { rateLimiter: opts.rateLimiter })
    this.ensure = opts.ensure
    this.mcp = new McpStreamClient({
      url: opts.url ?? process.env[PLAYWRIGHT_MCP_URL_ENV] ?? DEFAULT_PLAYWRIGHT_MCP_URL,
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs ?? 45_000,
      readOnlyGate: assertPlaywrightReadOnly,
    })
  }

  /** 关闭底层 MCP 会话（长驻适配器生命周期收尾；幂等）。 */
  close(): Promise<void> {
    return this.mcp.close()
  }

  /**
   * MCP 存活探测；渠道开关（ADR-12 热读）+ 频控基座共用 available 语义。
   *
   * playwright-mcp 实测（2026-09-05 交割后）：**有状态会话服务**——同一会话上的
   * 重复 initialize 被拒（MCP 协议语义；rail12306/xhs 服务端允许重复 initialize，
   * 本服务不允许），而 McpStreamClient.ping() 每次发 initialize。故首验失败时
   * close 残留会话重建再试（真实调用 navigate 不受影响——实测会话活着时 navigate
   * 正常）；存活结果缓存于实例（fan-out 多渠道多次预检不反复重建），服务真死时
   * 由调用方失败记账兜底（降级契约）。
   */
  private pingVerified = false

  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('socialL1', env)) return false
    if (this.pingVerified) return true
    if (await this.mcp.ping()) {
      this.pingVerified = true
      return true
    }
    try {
      await this.mcp.close()
    } catch {
      // 忽略：残留会话 DELETE 失败不阻塞重建（懒初始化自愈）
    }
    if (await this.mcp.ping()) {
      this.pingVerified = true
      return true
    }
    // M3.5：仍不可达 → 伴随服务按需拉起（默认关闭时为一次快速健康探测的空操作），
    // 成功再重试 ping；失败保持 false（既有降级语义）。
    if (this.ensure !== undefined && await this.ensure()) {
      if (await this.mcp.ping()) {
        this.pingVerified = true
        return true
      }
    }
    return false
  }

  /**
   * L1 登录态定向搜索：navigate 搜索页 → evaluate 通用链接提取 → 平台域名过滤
   * +去重。登录墙/风控（标题或空结果特征）→ EngineError.UNAVAILABLE（渠道层
   * 记账后走 L0 兜底，不伪造条目）。
   */
  async searchPlatform(
    platform: PlaywrightL1Platform,
    keywords: string,
    env?: KeyResolutionEnv,
  ): Promise<{ hits: PlaywrightSearchHit[]; degraded: DegradedEntry[] }> {
    const source = `${this.name}/l1/${platform}`
    const degraded: DegradedEntry[] = []
    if (!(await this.available(env))) {
      throw new Error('渠道不可用（MCP 未就绪或开关关闭）——由渠道层预检，此处不应到达')
    }
    const url = L1_SEARCH_URL[platform].replace('{q}', encodeURIComponent(keywords))
    const nav = await this.mcp.callTool('browser_navigate', { url })
    const navText = typeof nav === 'string' ? nav : JSON.stringify(nav)
    if (LOGIN_WALL_RE.test(navText)) {
      degraded.push(toDegraded(source, 'UNAVAILABLE', '搜索页命中登录墙/风控特征（无登录态），降级 L0 兜底'))
      return { hits: [], degraded }
    }
    const links = await this.extractLinks(source)
    const seen = new Set<string>()
    const hits: PlaywrightSearchHit[] = []
    for (const link of links) {
      let host: string
      try {
        host = new URL(link.href).hostname
      } catch {
        continue
      }
      if (!L1_RESULT_HOST[platform].test(host)) continue
      if (seen.has(link.href)) continue
      seen.add(link.href)
      hits.push({ title: link.text, url: link.href })
      if (hits.length >= 8) break
    }
    if (hits.length === 0) {
      degraded.push(toDegraded(source, 'EMPTY', '登录态搜索页无可提取结果（登录态缺失或页改版），降级 L0 兜底'))
    }
    return { hits, degraded }
  }

  /**
   * L2 正文渲染：navigate 详情页 → evaluate 容器文本聚合。返回 title+正文文本
   * （4000 字帽）；导航失败/正文为空 → EngineError（渠道层保留 L0 标题级条目）。
   */
  async renderPageText(url: string): Promise<{ title: string; text: string }> {
    await this.mcp.callTool('browser_navigate', { url })
    const result = await this.mcp.callTool('browser_evaluate', { function: L2_EXTRACT_SNIPPET })
    const parsed = unwrapPlaywrightResult(typeof result === 'string' ? result : JSON.stringify(result))
    const page = (parsed ?? {}) as { title?: unknown; text?: unknown }
    const text = typeof page.text === 'string' ? page.text.trim() : ''
    const title = typeof page.title === 'string' ? page.title.trim() : ''
    if (text.length === 0) {
      throw new Error(`L2 渲染正文为空（页改版/风控/未加载完）：${url.slice(0, 80)}`)
    }
    return { title, text }
  }

  /** evaluate 链接提取 + 解包（playwright-mcp `### Result` 包装形态兼容）。 */
  private async extractLinks(source: string): Promise<ExtractedLink[]> {
    const result = await this.mcp.callTool('browser_evaluate', { function: L1_EXTRACT_SNIPPET })
    const parsed = unwrapPlaywrightResult(typeof result === 'string' ? result : JSON.stringify(result))
    if (!Array.isArray(parsed)) {
      throw new Error(`L1 链接提取结果非数组（页改版/登录墙）：${source}`)
    }
    return parsed
      .filter((x): x is { href: string; text: string } =>
        typeof x === 'object' && x !== null
        && typeof (x as Record<string, unknown>).href === 'string'
        && typeof (x as Record<string, unknown>).text === 'string')
      .map((x) => ({ href: x.href, text: x.text }))
  }
}
