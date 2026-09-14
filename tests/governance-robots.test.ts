/**
 * M2.6 治理——robots/ToS 检查单测（NFR-4 requirements.md:179；design §5.4 L0.5
 * 直抓域表 / §9.3-7 开关默认开；roadmap M2.6 DoD：robots 禁抓路径→该源降级用例）。
 *
 * 注入面：`fetch` mock robots.txt 响应（status + body），断言 UA 头与缓存命中
 * 次数（fetchCountFor）；TTL 用 `now` 注入推进（短 ttlMs）。
 * 失败口径：404 → fail-open（无 robots = 无访问规则）；网络错误/5xx → fail-closed
 * （规则未知，合规保守——NFR-4 优先级注释见 governance/robots.ts 头部）。
 */
import { describe, expect, it } from 'vitest'
import {
  L05_SCRAPE_DOMAINS, ROBOTS_UA, RobotsChecker, disallowToRegExp,
  matchDisallow, parseRobotsTxt, robotsBlockedEntry, hostOf, pathOf,
  type RobotsFetchFn,
} from '../src/adapters/governance/robots.js'

/** 构造 robots.txt 响应 mock：routes 按 URL 精确命中，'*' 兜底；Error=网络错误。 */
function mockFetch(
  routes: Record<string, { status: number; body: string } | Error>,
  seen?: Array<{ url: string; headers: Record<string, string> }>,
): RobotsFetchFn {
  return async (url, init) => {
    seen?.push({ url, headers: init.headers })
    const hit = routes[url] ?? routes['*']
    if (hit instanceof Error) throw hit
    return { status: hit.status, text: async () => hit.body }
  }
}

/** 常见小红书 robots（L0 审计实测 explore 限抓）。 */
const XHS_ROBOTS = `# xiaohongshu robots
User-agent: *
Disallow: /explore/
Disallow: /search_result/
Disallow: /api/
Allow: /
`

describe('parseRobotsTxt / matchDisallow（robots 规则解析与匹配）', () => {
  it('解析分组：User-agent 组 + Disallow 收集；注释/空行/空 Disallow 忽略', () => {
    const groups = parseRobotsTxt(XHS_ROBOTS)
    expect(groups).toHaveLength(1)
    expect(groups[0].agents).toEqual(['*'])
    expect(groups[0].disallow).toEqual(['/explore/', '/search_result/', '/api/'])
    expect(parseRobotsTxt('Disallow: \nUser-agent: bot\n\n# comment')).toEqual([
      { agents: ['bot'], disallow: [] },
    ])
  })

  it('多 UA 组 + 具体 UA 优先于 * 兜底', () => {
    const groups = parseRobotsTxt(`User-agent: *
Disallow: /for-all
User-agent: dsh-travel-bot
Disallow: /for-bot
`)
    expect(matchDisallow(groups, 'dsh-travel-bot', '/for-bot/x')).toBe('/for-bot')
    expect(matchDisallow(groups, 'dsh-travel-bot', '/for-all')).toBeUndefined() // 具体组优先，* 组不生效
    expect(matchDisallow(groups, 'SomeOtherBot', '/for-all')).toBe('/for-all') // 无具体组 → * 兜底
  })

  it('Disallow 语义：robots 前缀匹配（RFC 9309）、* 通配、$ 锚定', () => {
    const groups = [{ agents: ['*'], disallow: ['/explore', '/user/*/fans', '/admin$'] }]
    expect(matchDisallow(groups, 'ua', '/explore/123')).toBe('/explore') // 前缀
    expect(matchDisallow(groups, 'ua', '/explore')).toBe('/explore')
    expect(matchDisallow(groups, 'ua', '/explored')).toBe('/explore') // robots 前缀语义：/explore 亦禁 /explored
    expect(matchDisallow(groups, 'ua', '/user/alice/fans')).toBe('/user/*/fans') // * 通配
    expect(matchDisallow(groups, 'ua', '/admin')).toBe('/admin$') // $ 锚定
    expect(matchDisallow(groups, 'ua', '/admin/extra')).toBeUndefined()
  })

  it('disallowToRegExp 转义：字面元字符不穿透', () => {
    expect(disallowToRegExp('/a.b').test('/axb')).toBe(false)
    expect(disallowToRegExp('/a.b').test('/a.b')).toBe(true)
    expect(disallowToRegExp('/q?x').test('/qax')).toBe(false)
  })

  it('hostOf / pathOf：URL 拆分与非法输入拒收', () => {
    expect(hostOf('https://www.xiaohongshu.com/explore/abc?x=1')).toBe('www.xiaohongshu.com')
    expect(pathOf('https://www.xiaohongshu.com/explore/abc?x=1')).toBe('/explore/abc')
    expect(hostOf('not a url')).toBeNull()
    expect(pathOf('not a url')).toBeUndefined()
  })

  it('L0.5 直抓域清单（小红书/知乎）', () => {
    expect([...L05_SCRAPE_DOMAINS].sort()).toEqual(['xiaohongshu.com', 'zhihu.com'])
  })
})

describe('RobotsChecker（抓取前查 robots.txt：Disallow → 降级；失败口径）', () => {
  it('Disallow 路径 → allowed:false + 命中规则；同域其他路径 allowed', async () => {
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 200, body: XHS_ROBOTS } }) })
    const blocked = await checker.isPathAllowed('https://www.xiaohongshu.com/explore/abc123')
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) expect(blocked.rule).toBe('/explore/')
    const ok = await checker.isPathAllowed('https://www.xiaohongshu.com/user/profile/42')
    expect(ok.allowed).toBe(true)
  })

  it('抓取请求带桌面 UA（NFR-4 同一身份）', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 200, body: '' } }, seen) })
    await checker.isPathAllowed('https://zhihu.com/column/c1')
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['User-Agent']).toBe(ROBOTS_UA)
    expect(seen[0].url).toBe('https://zhihu.com/robots.txt')
  })

  it('域级缓存：同域二次检查不重复抓取；不同域各抓一次', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 200, body: XHS_ROBOTS } }, seen) })
    await checker.isPathAllowed('https://www.xiaohongshu.com/explore/a')
    await checker.isPathAllowed('https://www.xiaohongshu.com/explore/b') // 缓存命中
    await checker.isPathAllowed('https://zhihu.com/column/c')
    expect(seen.map((s) => s.url)).toEqual([
      'https://www.xiaohongshu.com/robots.txt',
      'https://zhihu.com/robots.txt',
    ])
    expect(checker.fetchCountFor('www.xiaohongshu.com')).toBe(1)
  })

  it('缓存 TTL 过期后重新抓取（短 TTL + now 注入）', async () => {
    let now = 0
    const seen: string[] = []
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 200, body: XHS_ROBOTS } }, seen), ttlMs: 1_000, now: () => now })
    await checker.isPathAllowed('https://www.xiaohongshu.com/explore/a')
    now = 500
    await checker.isPathAllowed('https://www.xiaohongshu.com/explore/b') // TTL 内 → 缓存
    expect(checker.fetchCountFor('www.xiaohongshu.com')).toBe(1)
    now = 1_001
    await checker.isPathAllowed('https://www.xiaohongshu.com/explore/c') // 过期 → 重拉
    expect(checker.fetchCountFor('www.xiaohongshu.com')).toBe(2)
  })

  it('404 → fail-open（无 robots 文件 = 无访问规则）', async () => {
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 404, body: '' } }) })
    expect((await checker.isPathAllowed('https://zhihu.com/column/c')).allowed).toBe(true)
  })

  it('网络错误 → fail-closed（规则未知，合规保守）', async () => {
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': new Error('ECONNREFUSED') }) })
    const decision = await checker.isPathAllowed('https://zhihu.com/column/c')
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('fetch-error')
  })

  it('5xx → fail-closed（规则未知）', async () => {
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 500, body: '' } }) })
    const decision = await checker.isPathAllowed('https://zhihu.com/column/c')
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('fetch-error')
  })

  it('非 404 4xx（403）→ fail-closed（服务器明确存在但拒绝给规则）', async () => {
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 403, body: '' } }) })
    expect((await checker.isPathAllowed('https://zhihu.com/column/c')).allowed).toBe(false)
  })

  it('robotsBlockedEntry 记账：Disallow 与 fetch-error 两种 reason', () => {
    const disallow = robotsBlockedEntry('search-l0.5', 'https://www.xiaohongshu.com/explore/a', { allowed: false, rule: '/explore/', reason: 'robots' })
    expect(disallow).toMatchObject({ source: 'search-l0.5', code: 'UNAVAILABLE' })
    expect(disallow.reason).toContain('robots.txt Disallow 禁抓')
    expect(disallow.reason).toContain('/explore/')
    const fetchError = robotsBlockedEntry('search-l0.5', 'https://zhihu.com/c', { allowed: false, rule: 'robots.txt 不可达（规则未知，fail-closed）', reason: 'fetch-error' })
    expect(fetchError).toMatchObject({ source: 'search-l0.5', code: 'UNAVAILABLE' })
    expect(fetchError.reason).toContain('不可达')
  })

  it('peek：缓存命中同步判定，未命中返回 undefined（不触发网络）', async () => {
    const seen: string[] = []
    const checker = new RobotsChecker({ fetch: mockFetch({ '*': { status: 200, body: XHS_ROBOTS } }, seen) })
    expect(checker.peek('https://www.xiaohongshu.com/explore/a')).toBeUndefined()
    await checker.isPathAllowed('https://www.xiaohongshu.com/explore/a')
    const hit = checker.peek('https://www.xiaohongshu.com/explore/b')
    expect(hit).toBeDefined()
    expect(hit?.allowed).toBe(false)
    expect(seen).toHaveLength(1) // peek 未触发新抓取
  })
})