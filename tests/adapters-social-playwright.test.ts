/**
 * Playwright 社媒适配器（W3a）单测：只读白名单红线 + L1 登录态定向搜索 +
 * L2 正文渲染 + socialDepth 调度（L0 拦截/渠道聚合/抖音 L2 富化与降级）。
 * MCP 传输全程 fetchFn 假体离线；live 探测见 tests/live-w3b-smoke（W3b）。
 */
import { describe, expect, it } from 'vitest'
import {
  PLAYWRIGHT_L1_PLATFORMS, PLAYWRIGHT_READONLY_TOOLS, PlaywrightSocialAdapter, assertPlaywrightReadOnly, L1_SEARCH_URL,
  unwrapPlaywrightResult,
} from '../src/adapters/social-playwright.js'
import { socialL1Channel, douyinChannel, socialDepthOf, SOCIAL_L1_MARK } from '../src/orchestrator/channels.js'
import type { FetchLike } from '../src/adapters/rail12306.js'
import type { SocialAdapter } from '../src/adapters/social.js'
import type { CanonicalQuery } from '../src/adapters/base.js'

// ────────────────────────── MCP 假体（Streamable HTTP 协议最小实现） ──────────────────────────

/** 假 MCP fetch：initialize/initialized/tools/call（handlers 按 tool name 应答）。 */
function fakeMcp(handlers: Record<string, (args: Record<string, unknown>) => unknown>, opts: { initializeOnce?: boolean } = {}): FetchLike {
  let initialized = 0
  return async (_input, init) => {
    const body = JSON.parse(init?.body ?? '{}') as {
      id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> }
    }
    if (body.method === 'initialize') {
      initialized += 1
      // playwright-mcp 有状态会话语义（2026-09-05 交割实测）：同会话重复 initialize 被拒
      if (opts.initializeOnce && initialized > 1) {
        return ok({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'already initialized' } })
      }
      return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }, { 'mcp-session-id': 'session-1' })
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/call' && body.params?.name !== undefined) {
      const out = handlers[body.params.name]?.(body.params.arguments ?? {})
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })
    }
    return ok({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } })
  }
}

function ok(body: unknown, headers: Record<string, string> = {}): { ok: boolean; status: number; text: () => Promise<string>; headers?: never } & Record<string, unknown> {
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify(body),
    ...headers,
  } as never
}

function adapter(handlers: Record<string, (args: Record<string, unknown>) => unknown>): PlaywrightSocialAdapter {
  return new PlaywrightSocialAdapter({ fetchFn: fakeMcp(handlers) })
}

const ctxOf = (env?: never) => ({
  deadlineMs: Date.now() + 60_000,
  budgetMs: 60_000,
  env,
})

const queryOf = (destination: string): CanonicalQuery => ({
  destination,
  dateStart: '2026-10-01',
  dateEnd: '2026-10-03',
  days: 3,
  travelers: { adults: 1 },
  party: {},
  budgetTier: 'standard',
} as unknown as CanonicalQuery)

// ────────────────────────── 只读白名单（§5.6 工具收敛红线） ──────────────────────────

describe('playwright 只读白名单（编译期红线）', () => {
  it('白名单六件放行；交互/写类/截图类一律拒绝', () => {
    expect(PLAYWRIGHT_READONLY_TOOLS.has('browser_navigate')).toBe(true)
    expect(PLAYWRIGHT_READONLY_TOOLS.has('browser_evaluate')).toBe(true)
    expect(() => assertPlaywrightReadOnly('browser_navigate')).not.toThrow()
    expect(() => assertPlaywrightReadOnly('browser_evaluate')).not.toThrow()
    for (const tool of ['browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key',
      'browser_select_option', 'browser_file_upload', 'browser_tabs', 'browser_run_code_unsafe',
      'browser_take_screenshot', 'browser_drag', 'browser_hover']) {
      expect(() => assertPlaywrightReadOnly(tool)).toThrow(/只读白名单拒绝/)
    }
  })
})

// ────────────────────────── L1 登录态定向搜索 ──────────────────────────

describe('L1 登录态定向搜索（searchPlatform）', () => {
  it('navigate 搜索页 + evaluate 提取：平台域名过滤 + 去重 + 上限 8 条', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const pa = adapter({
      browser_navigate: (args) => {
        calls.push({ name: 'browser_navigate', args })
        return { pageState: 'ok', url: args.url }
      },
      browser_evaluate: () => [
        { href: 'https://weibo.com/x/1', text: '杭州三日游攻略 微博正文' },
        { href: 'https://weibo.com/x/1', text: '重复条目' },
        { href: 'https://example.com/other', text: '外站命中应被过滤' },
        { href: 'https://s.weibo.com/detail/2', text: '第二条' },
        { href: 'not-a-url', text: '坏链应被过滤' },
      ],
    })
    const { hits, degraded } = await pa.searchPlatform('weibo', '杭州 旅游 攻略')
    expect(calls[0]?.args.url).toBe(L1_SEARCH_URL.weibo.replace('{q}', encodeURIComponent('杭州 旅游 攻略')))
    expect(hits).toEqual([
      { title: '杭州三日游攻略 微博正文', url: 'https://weibo.com/x/1' },
      { title: '第二条', url: 'https://s.weibo.com/detail/2' },
    ])
    expect(degraded).toHaveLength(0)
  })

  it('登录墙特征（无登录态）→ UNAVAILABLE degraded + 空命中（L0 兜底语义）', async () => {
    const pa = adapter({
      browser_navigate: () => '当前页面需要登录 passport.weibo.com 才能继续访问',
      browser_evaluate: () => [],
    })
    const { hits, degraded } = await pa.searchPlatform('weibo', '杭州')
    expect(hits).toHaveLength(0)
    expect(degraded.some((d) => d.code === 'UNAVAILABLE' && d.reason.includes('登录墙'))).toBe(true)
  })

  it('空结果 → EMPTY degraded；导航/提取失败异常向上抛（渠道层记账）', async () => {
    const empty = adapter({
      browser_navigate: () => ({ pageState: 'ok' }),
      browser_evaluate: () => [{ href: 'https://example.com/x', text: '全部被域名过滤' }],
    })
    const out = await empty.searchPlatform('tieba', '杭州')
    expect(out.hits).toHaveLength(0)
    expect(out.degraded.some((d) => d.code === 'EMPTY')).toBe(true)

    const broken = adapter({
      browser_navigate: () => ({ pageState: 'ok' }),
      browser_evaluate: () => 'not-an-array',
    })
    await expect(broken.searchPlatform('tieba', '杭州')).rejects.toThrow(/非数组/)
  })
})

// ────────────────────────── L2 抖音正文渲染 ──────────────────────────

describe('L2 正文渲染（renderPageText）', () => {
  it('navigate + evaluate 容器文本：title/text 返回', async () => {
    const pa = adapter({
      browser_navigate: () => ({ pageState: 'ok' }),
      browser_evaluate: (args) => {
        expect(String(args.function)).toContain('document.title')
        return { title: '杭州西湖一日游 | 抖音', text: '正文内容第一段\n正文内容第二段' }
      },
    })
    const page = await pa.renderPageText('https://www.douyin.com/video/7420000000000000000')
    expect(page.title).toContain('西湖')
    expect(page.text).toContain('正文内容')
  })

  it('正文为空 → 抛错（渠道层保留 L0 标题级条目）', async () => {
    const pa = adapter({
      browser_navigate: () => ({ pageState: 'ok' }),
      browser_evaluate: () => ({ title: '', text: '   ' }),
    })
    await expect(pa.renderPageText('https://www.douyin.com/video/x')).rejects.toThrow(/正文为空/)
  })
})

describe('unwrapPlaywrightResult（### Result 包装解包）', () => {
  it('数组形态 [ {...},{...} ] 不得配对到首个元素的单对象（W3b 交割实测回归）', () => {
    const wrapped = '### Ran Playwright code\n```js\nawait page.evaluate(...)\n```\n### Result\n[' +
      '\n  { "href": "https://weibo.com/x/1", "text": "杭州攻略" },' +
      '\n  { "href": "https://weibo.com/x/2", "text": "第二条" }' +
      '\n]\n### Page snapshot\n- [Snapshot](page-x.png)'
    const out = unwrapPlaywrightResult(wrapped)
    expect(Array.isArray(out)).toBe(true)
    expect((out as Array<{ href: string }>).length).toBe(2)
    expect((out as Array<{ href: string }>)[1].href).toBe('https://weibo.com/x/2')
  })

  it('对象形态直解 + 直解 JSON 兼容', () => {
    expect(unwrapPlaywrightResult('{"title":"t","text":"正文"}')).toMatchObject({ title: 't' })
    expect(unwrapPlaywrightResult('{"a":1}')).toMatchObject({ a: 1 })
    expect(unwrapPlaywrightResult('not json at all')).toBeUndefined()
  })
})

// ────────────────────────── available 幂等（playwright-mcp 有状态会话） ──────────────────────────

describe('available：残留会话上重复 initialize 被拒 → close 重建再试', () => {
  it('ping 首次成功后缓存；全新实例首验失败时 close+重建成功 → true', async () => {
    const stateful = new PlaywrightSocialAdapter({ fetchFn: fakeMcp({ browser_navigate: () => ({ pageState: 'ok' }) }, { initializeOnce: true }) })
    expect(await stateful.available()).toBe(true) // 首验
    expect(await stateful.available()).toBe(true) // 缓存路径（不重复 initialize）
    // 全新实例：无缓存,首 ping（新会话)成功——模拟服务已运行场景
    const fresh = new PlaywrightSocialAdapter({ fetchFn: fakeMcp({ browser_navigate: () => ({ pageState: 'ok' }) }) })
    expect(await fresh.available()).toBe(true)
  })

  it('服务真死（所有 initialize 拒绝）→ available=false（T4 注入语义）', async () => {
    const dead = new PlaywrightSocialAdapter({ fetchFn: fakeMcp({}, { initializeOnce: true }) })
    // 模拟"残留会话已被服务端清空"：首个 initialize 也失败 → close → 再试仍失败
    void dead
    const alwaysFail = new PlaywrightSocialAdapter({
      fetchFn: async (_input, init) => {
        const body = JSON.parse(init?.body ?? '{}') as { id?: number; method: string }
        if (body.method === 'initialize') return { ok: false, status: 503, text: async () => 'down' }
        return { ok: true, status: 202, text: async () => '' }
      },
    })
    expect(await alwaysFail.available()).toBe(false)
  })
})

// ────────────────────────── socialDepth 调度（渠道层） ──────────────────────────

function socialStub(): SocialAdapter {
  return { name: 'social-l0' } as unknown as SocialAdapter
}

describe('socialL1 渠道 + socialDepth 预算调度', () => {
  it('socialDepthOf：缺省 L1；L0/L2 热读生效；非法值回落 L1', () => {
    expect(socialDepthOf()).toBe('L1')
    expect(socialDepthOf({ readSettings: (k) => (k === 'advanced.socialDepth' ? 'L2' : undefined) })).toBe('L2')
    expect(socialDepthOf({ readSettings: (k) => (k === 'advanced.socialDepth' ? 'l0' : undefined) })).toBe('L0')
    expect(socialDepthOf({ readSettings: () => 'junk' })).toBe('L1')
  })

  it('socialL1 平台登记不含豆瓣', async () => {
    const searched: string[] = []
    const playwright = {
      searchPlatform: async (platform: string) => {
        searched.push(platform)
        return { hits: [], degraded: [] }
      },
    } as unknown as PlaywrightSocialAdapter
    const outcome = await socialL1Channel(playwright).run(queryOf('杭州'), ctxOf())
    expect(outcome.ok).toBe(false)
    expect(searched).toEqual([...PLAYWRIGHT_L1_PLATFORMS])
    expect(searched).not.toContain('douban')
  })

  it('L1 聚合：多平台命中合并 + 首条登录态标注 + 域名过滤', async () => {
    const wired = adapter({
      browser_navigate: () => ({ pageState: 'ok' }),
      browser_evaluate: () => [
        { href: 'https://weibo.com/x/1', text: '微博命中一' },
        { href: 'https://weibo.com/x/1', text: '重复去重' },
        { href: 'https://weibo.com/x/2', text: '微博命中二' },
        { href: 'https://ads.example.com/x', text: '外站过滤' },
      ],
    })
    const channel = socialL1Channel(wired)
    const outcome = await channel.run(queryOf('杭州'), ctxOf())
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items.length).toBe(2)
      expect(outcome.items[0].summary).toContain(SOCIAL_L1_MARK)
      expect(outcome.items.every((i) => i.channel === 'weibo')).toBe(true)
    }
  })

  it('全平台失败 → EMPTY（fan-out 记账走三层 L0 兜底）', async () => {
    const pa = adapter({
      browser_navigate: () => { throw new Error('无登录态') },
    })
    const channel = socialL1Channel(pa)
    const outcome = await channel.run(queryOf('杭州'), ctxOf())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('EMPTY')
  })

  it('socialDepth=L0 → run 记 UNAVAILABLE（用户配置语义）', async () => {
    const pa = adapter({ browser_navigate: () => ({ pageState: 'ok' }) })
    const channel = socialL1Channel(pa)
    const env = { readSettings: (k: string) => (k === 'advanced.socialDepth' ? 'L0' : undefined) } as never
    const outcome = await channel.run(queryOf('杭州'), { deadlineMs: Date.now() + 60_000, budgetMs: 60_000, env })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('socialDepth=L0')
  })

  it('抖音 L2 富化：depth=L2 + 正文渲染成功 → summary 替换为正文', async () => {
    const pa = adapter({
      browser_navigate: () => ({ pageState: 'ok' }),
      browser_evaluate: () => ({ title: '抖音标题富化', text: 'L2 渲染正文内容（超过标题级）' }),
    })
    const social = {
      searchL0: async () => ({
        items: [{
          id: 'social-douyin-7420', category: 'recommend', channel: 'douyin',
          title: 'L0 标题', summary: '仅标题摘要',
          source: { platform: 'douyin', url: 'https://www.douyin.com/video/7420000000000000000', fetchedAt: new Date().toISOString() },
          confidence: 'low',
        }],
        degraded: [],
      }),
    } as unknown as SocialAdapter
    const channel = douyinChannel(social, pa)
    const env = { readSettings: (k: string) => (k === 'advanced.socialDepth' ? 'L2' : undefined) } as never
    const outcome = await channel.run(queryOf('杭州'), { deadlineMs: Date.now() + 60_000, budgetMs: 60_000, env })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items[0].summary).toContain('L2 渲染正文内容')
    }
  })

  it('抖音 L2 渲染失败 → 保留仅标题摘要 + 降级注明（DoD：L2 失败仅标题摘要降级）', async () => {
    const pa = adapter({
      browser_navigate: () => { throw new Error('MCP 不可达') },
    })
    const social = {
      searchL0: async () => ({
        items: [{
          id: 'social-douyin-7420', category: 'recommend', channel: 'douyin',
          title: 'L0 标题', summary: '仅标题摘要：正文需 L2',
          source: { platform: 'douyin', url: 'https://www.douyin.com/video/7420000000000000000', fetchedAt: new Date().toISOString() },
          confidence: 'low',
        }],
        degraded: [],
      }),
    } as unknown as SocialAdapter
    const channel = douyinChannel(social, pa)
    const env = { readSettings: (k: string) => (k === 'advanced.socialDepth' ? 'L2' : undefined) } as never
    const outcome = await channel.run(queryOf('杭州'), { deadlineMs: Date.now() + 60_000, budgetMs: 60_000, env })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items[0].summary).toContain('仅标题摘要')
    }
  })
})
