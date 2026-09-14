/**
 * xhs 适配器单测（W2/T3）：只读白名单红线（发布/评论/点赞/收藏/关注零注册）+
 * 授权双闸门（未授权→degraded 待授权零调用）+ 会话失效自动降级（L0+L0.5 不中断）+
 * 频控（W1 令牌桶，域=xiaohongshu.com）+ 归一化（xsecToken 绝不落盘）。
 * fixture = schema-derived synthetic（上游 Go struct 对齐；live 真录 gated-pending）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path, { join } from 'node:path'
import {
  XhsAdapter, assertXhsReadOnly, isXhsReadOnlyTool, isLoginRequiredText,
  isXhsAuthorized, normalizeXhsDetail, normalizeXhsFeed, normalizeXhsSearch,
  parseXhsCount, xhsFeedToIntelItem, XHS_AUTHORIZED_ENV,
  XHS_AUTH_GRANTED_REASON, XHS_LOGGED_OUT_REASON, XHS_UNVERIFIABLE_REASON,
  ensureXhsAuthMarker, removeXhsAuthMarker,
  XHS_READ_ONLY_TOOLS,
} from '../src/adapters/xhs.js'
import { McpStreamClient, READ_ONLY_TOOLS as RAIL_READ_ONLY_TOOLS, assertReadOnly } from '../src/adapters/rail12306.js'
import { EngineError, channelEnabled, type KeyResolutionEnv } from '../src/adapters/base.js'
import { createDomainTokenBucket } from '../src/adapters/governance/index.js'
import { SearchAdapter, type HostSearchFn } from '../src/adapters/search.js'
import { xhsMcpChannel } from '../src/orchestrator/channels.js'
import type { RateLimitDecision } from '../src/adapters/base.js'
import type { FetchLike } from '../src/adapters/rail12306.js'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xhs')
const searchFixture = (): unknown => JSON.parse(readFileSync(path.join(FIX, 'search-feeds.json'), 'utf8'))
const detailFixture = (): unknown => JSON.parse(readFileSync(path.join(FIX, 'feed-detail.json'), 'utf8'))

/** 上游实测工具面（2026-09-04 tools/list，18 个）：写端点 9 + 白名单外只读 5 + 白名单 4。 */
const UPSTREAM_ALL_TOOLS: readonly string[] = [
  'check_login_status', 'delete_cookies', 'favorite_feed', 'get_feed_detail',
  'get_login_qrcode', 'get_my_profile', 'get_unread_count', 'like_feed',
  'like_notification', 'list_feeds', 'list_notifications', 'post_comment_to_feed',
  'publish_content', 'publish_with_video', 'reply_comment_in_feed',
  'reply_notification', 'search_feeds', 'user_profile',
]

/** 记账型 fake MCP（记录 tools/call 调用；按名回 canned 响应）。 */
interface FakeMcpLog { calls: string[] }

function fakeXhsMcp(responses: Record<string, unknown>, log: FakeMcpLog): McpStreamClient {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string; params?: { name?: string }; id?: number }
    if (body.method === 'initialize') {
      return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }, 'fake-xhs-session')
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/call') {
      const tool = body.params?.name ?? ''
      log.calls.push(tool)
      const resp = responses[tool]
      if (resp === undefined) {
        return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'no fixture' }], isError: true } })
      }
      if (typeof resp === 'string') {
        return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: resp }] } })
      }
      // 多模态（get_login_qrcode：text+image 双块）或 JSON 面按原样展开
      const payload = resp as Record<string, unknown>
      if (Array.isArray(payload.content)) {
        return ok({ jsonrpc: '2.0', id: body.id, result: payload })
      }
      return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })
    }
    return ok({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } })
  }
  return new McpStreamClient({ url: 'http://127.0.0.1:18060/mcp', fetchFn, readOnlyGate: assertXhsReadOnly })
}

function ok(body: unknown, sessionId?: string): ReturnType<FetchLike> {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: sessionId ? { get: (n: string) => (n.toLowerCase() === 'mcp-session-id' ? sessionId : null) } : undefined,
  } as unknown as ReturnType<FetchLike>
}

const AUTHORIZED_ENV: KeyResolutionEnv = { env: { [XHS_AUTHORIZED_ENV]: '1' } }
const UNAUTHORIZED_ENV: KeyResolutionEnv = { env: {} }

/**
 * 独立高配令牌桶（每适配器注入）：默认 governance 频控是全局共享（xiaohongshu.com
 * 域 ≤10 req/min）——单文件多用例并发会共享耗尽导致后续请求在令牌窗口内阻塞（假死）。
 * 每个做 MCP 的测试适配器用独立 bucket（新鲜计数），隔离用例间频控串扰，也不污染
 * 生产语义（仅测试替身层，XhsAdapter.rateLimiter 结构面注入）。
 */
function isolatedBucket(): import('../src/adapters/governance/index.js').DomainTokenBucket {
  return createDomainTokenBucket()
}

/** 渠道执行上下文（预算 3 分钟；测试固定时钟面）。 */
const channelCtx = (env: KeyResolutionEnv | undefined) => ({
  deadlineMs: Date.now() + 180_000,
  budgetMs: 180_000,
  env,
})

describe('只读白名单红线（§5.6：发布/评论/点赞/收藏/关注零注册）', () => {
  it('白名单 4 工具全部放行，且不含任何写端点关键字', () => {
    expect(XHS_READ_ONLY_TOOLS).toContain('search_feeds')
    for (const name of XHS_READ_ONLY_TOOLS) {
      expect(isXhsReadOnlyTool(name)).toBe(true)
    }
    const writeKeywords = /publish|comment|reply|like|favorite|follow|delete|upload|post|block/i
    expect(XHS_READ_ONLY_TOOLS.some((n) => writeKeywords.test(n))).toBe(false)
  })

  it('上游全工具面 18 个：9 写端点 + 5 白名单外只读件一律 assertXhsReadOnly 拒绝', () => {
    const rejected = UPSTREAM_ALL_TOOLS.filter((name) => !XHS_READ_ONLY_TOOLS.includes(name))
    expect(rejected.length).toBe(14)
    for (const name of rejected) {
      expect(() => assertXhsReadOnly(name)).toThrow(EngineError)
      expect(() => assertXhsReadOnly(name)).toThrow(/只读白名单/)
    }
    // 红线 grep 等价断言：挂载面 grep 无 publish/comment/like/favorite/follow/reply/delete
    const mounted = XHS_READ_ONLY_TOOLS.join('\n')
    expect(mounted).not.toMatch(/publish|comment|reply|like|favorite|follow|delete/i)
  })

  it('rail12306 缺省闸门不受 xhs 注入影响（互不旁路）', () => {
    expect(() => assertReadOnly('query-tickets')).not.toThrow()
    expect(() => assertReadOnly('search_feeds')).toThrow(EngineError)
    expect(RAIL_READ_ONLY_TOOLS.some((n) => n === 'search_feeds')).toBe(false)
  })

  it('McpStreamClient 注入 xhs 闸门：写工具调用零网络（调用前拒绝）', async () => {
    let httpCalls = 0
    const fetchFn: FetchLike = async () => {
      httpCalls += 1
      return ok({ jsonrpc: '2.0', id: 1, result: {} })
    }
    const client = new McpStreamClient({ url: 'http://127.0.0.1:18060/mcp', fetchFn, readOnlyGate: assertXhsReadOnly })
    for (const bad of ['publish_content', 'post_comment_to_feed', 'like_feed', 'favorite_feed', 'delete_cookies', 'reply_notification']) {
      await expect(client.callTool(bad)).rejects.toThrow(EngineError)
    }
    expect(httpCalls).toBe(0)
  })
})

describe('归一化（上游 struct 对齐；xsecToken 绝不落盘）', () => {
  it('互动计数「1.2万」→ 12000；非法 undefined', () => {
    expect(parseXhsCount('1.2万')).toBe(12000)
    expect(parseXhsCount('860')).toBe(860)
    expect(parseXhsCount('2,300')).toBe(2300)
    expect(parseXhsCount('')).toBeUndefined()
    expect(parseXhsCount(undefined)).toBeUndefined()
  })

  it('search_feeds fixture → 规范形（直播卡过滤/作者/互动）', () => {
    const feeds = normalizeXhsSearch(searchFixture())
    expect(feeds.length).toBe(2)
    expect(feeds[0]?.noteId).toBe('65f1a2b3000000001234abcd')
    expect(feeds[0]?.title).toContain('杭州三日游')
    expect(feeds[0]?.author).toBe('旅行家小王')
    expect(feeds[0]?.likes).toBe(12000)
    expect(feeds[0]?.collects).toBe(23000)
    expect(normalizeXhsFeed({ id: 'x', modelType: 'live_v2' })).toBeUndefined()
  })

  it('feed → IntelItem：channel=xhs-mcp、id=xhs:<noteId>、URL 剥 token、正文富化贯通', () => {
    const feed = normalizeXhsSearch(searchFixture())[0]
    expect(feed).toBeDefined()
    const detail = normalizeXhsDetail(detailFixture())
    const item = xhsFeedToIntelItem(feed as NonNullable<ReturnType<typeof normalizeXhsSearch>[number]>, detail, '2026-09-04T00:00:00.000Z')
    expect(item.channel).toBe('xhs-mcp')
    expect(item.id).toBe('xhs:65f1a2b3000000001234abcd')
    expect(item.source.url).toBe('https://www.xiaohongshu.com/explore/65f1a2b3000000001234abcd')
    expect(item.summary).toContain('断桥')
    expect(item.summary).not.toMatch(/作者：|互动：|IP属地：/)
    expect(item.author).toBe('旅行家小王')
    expect(item.metrics).toMatchObject({ likes: 12000, collects: 23000 })
    expect(item.content).toContain('断桥')
    expect(item.publishedAt).toBe('2025-10-03')
    // 红线：整个条目序列化不含 xsecToken
    expect(JSON.stringify(item)).not.toContain('ABTOKENAAA111')
    expect(JSON.stringify(item)).not.toContain('xsecToken')
  })
})

describe('默认授权（N-10：登录态有效即授权；marker 惰性缓存）', () => {
  // 密闭化：isXhsAuthorized 缺省检查 cwd 的 .dsh-travel/xhs-session/.authorized——
  // 注入显式 markerPath（临时目录）锁定纯逻辑，与运行时授权状态解耦。
  const absentMarker = () => join(mkdtempSync(join(tmpdir(), 'xhs-auth-')), 'absent.auth')
  const presentMarker = (): string => {
    const p = join(mkdtempSync(join(tmpdir(), 'xhs-auth-')), 'present.auth')
    writeFileSync(p, '授权标记（测试）')
    return p
  }

  it('env 授权标记判定（truthy 值集 / 关闭态）', () => {
    expect(isXhsAuthorized({ env: { [XHS_AUTHORIZED_ENV]: 'true' } }, absentMarker())).toBe(true)
    expect(isXhsAuthorized({ env: { [XHS_AUTHORIZED_ENV]: '1' } }, absentMarker())).toBe(true)
    expect(isXhsAuthorized({ env: { [XHS_AUTHORIZED_ENV]: '0' } }, absentMarker())).toBe(false)
    expect(isXhsAuthorized({ env: {} }, absentMarker())).toBe(false)
  })

  it('标记惰性缓存面：存在即视为已授权（env 关闭态也放行）', () => {
    expect(isXhsAuthorized({ env: {} }, presentMarker())).toBe(true)
    expect(isXhsAuthorized({ env: { [XHS_AUTHORIZED_ENV]: '0' } }, presentMarker())).toBe(true)
  })

  it('marker 写/清幂等：重复 ensure 不重复写；remove 缺省即空操作', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'xhs-auth-')), '.authorized')
    ensureXhsAuthMarker(marker)
    expect(existsSync(marker)).toBe(true)
    const mtime = readFileSync(marker, 'utf8') // 读入内容占位（内容固定）
    expect(mtime.length).toBeGreaterThan(0)
    ensureXhsAuthMarker(marker) // 重复调用不抛、不覆写
    expect(existsSync(marker)).toBe(true)
    removeXhsAuthMarker(marker)
    expect(existsSync(marker)).toBe(false)
    removeXhsAuthMarker(marker) // 已缺省再清 → 幂等无异常
  })

  it('settings 渠道开关：off → channelEnabled false（唯一显式控制；fan-out 前置过滤）', () => {
    expect(channelEnabled('xhsMcp', { readSettings: (k) => (k === 'channels.xhsMcp' ? 'off' : undefined) })).toBe(false)
    expect(channelEnabled('xhsMcp', { readSettings: (k) => (k === 'channels.xhsMcp' ? 'on' : undefined) })).toBe(true)
  })

  it('登录态有效（首用无 marker）→ 默认授权：xhs-mcp 条目 + 幂等落 .authorized，无待授权降级', async () => {
    const travelRoot = join(mkdtempSync(join(tmpdir(), 'xhs-marker-')), 'root')
    const log: FakeMcpLog = { calls: [] }
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({
        search_feeds: searchFixture(),
        get_feed_detail: detailFixture(),
        check_login_status: '✅ 已登录\n用户名: 测试用户',
      }, log),
      rateLimiter: isolatedBucket(),
      travelRoot,
    })
    const channel = xhsMcpChannel(adapter)
    expect(await channel.available()).toBe(true)
    const outcome = await channel.run({ destination: '杭州' }, channelCtx({ env: {} }))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items.some((i) => i.channel === 'xhs-mcp')).toBe(true)
      // 回执不再显示「待授权」降级；登录态有效（默认授权）标注
      expect(outcome.items[0]?.summary).toContain(XHS_AUTH_GRANTED_REASON)
    }
    expect(log.calls).toContain('check_login_status')
    expect(log.calls).toContain('search_feeds')
    // 自动落授权标记（懒缓存）
    expect(existsSync(adapter.authMarkerPath())).toBe(true)
  })

  it('check_login_status 未登录（无 marker）→ 不授权：无 search_feeds、降级 + 扫码提示、不落 marker', async () => {
    const travelRoot = join(mkdtempSync(join(tmpdir(), 'xhs-marker-')), 'root')
    const log: FakeMcpLog = { calls: [] }
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({ check_login_status: '❌ 未登录\n\n请使用 get_login_qrcode …' }, log),
      rateLimiter: isolatedBucket(),
      travelRoot,
    })
    const channel = xhsMcpChannel(adapter) // 无 search 降级注入 → 直接 failed 记账
    const outcome = await channel.run({ destination: '杭州' }, channelCtx({ env: {} }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('未登录')
      expect(outcome.reason).toContain('扫码')
      expect(outcome.reason).not.toContain('仅用于本次旅行规划') // 不再走对话确认口吻
    }
    // 铁律：仅一次登录态预检，绝不伪装登录态调用 search_feeds
    expect(log.calls).toEqual(['check_login_status'])
    expect(existsSync(adapter.authMarkerPath())).toBe(false)
  })

  it('check_login_status 调用失败（MCP 不可达）→ 文案区分「无法验证登录态」，不冒充授权', async () => {
    const travelRoot = join(mkdtempSync(join(tmpdir(), 'xhs-marker-')), 'root')
    const log: FakeMcpLog = { calls: [] }
    // 只放 search_feeds（不放 check_login_status 响应）→ 预检出错 → unverifiable
    const adapter = new XhsAdapter({ mcp: fakeXhsMcp({ search_feeds: searchFixture() }, log), rateLimiter: isolatedBucket(), travelRoot })
    const channel = xhsMcpChannel(adapter)
    const outcome = await channel.run({ destination: '杭州' }, channelCtx({ env: {} }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('无法验证登录态')
      expect(outcome.reason).not.toContain(XHS_AUTH_GRANTED_REASON) // 不冒充授权成功
    }
    expect(log.calls).not.toContain('search_feeds') // 未知态绝不检索
    expect(existsSync(adapter.authMarkerPath())).toBe(false)
  })

  it('设置开关 off → 渠道停用：零 MCP 调用', async () => {
    const log: FakeMcpLog = { calls: [] }
    const adapter = new XhsAdapter({ mcp: fakeXhsMcp({ search_feeds: searchFixture() }, log), rateLimiter: isolatedBucket(), travelRoot: '/nonexistent-xhs-test' })
    const channel = xhsMcpChannel(adapter)
    const offEnv = { readSettings: (k: string) => (k === 'channels.xhsMcp' ? 'off' : undefined) }
    const outcome = await channel.run({ destination: '杭州' }, channelCtx(offEnv))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('已停用')
    }
    expect(log.calls).toEqual([]) // 开关唯一控制 → 零调用
  })

  it('.authorized 惰性缓存：marker 存在 → 短路冗余预检（重复判定不重复请求 check_login_status）', async () => {
    const travelRoot = join(mkdtempSync(join(tmpdir(), 'xhs-marker-')), 'root')
    const log: FakeMcpLog = { calls: [] }
    ensureXhsAuthMarker(join(travelRoot, '.dsh-travel', 'xhs-session', '.authorized')) // 曾验证过登录态
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({ search_feeds: searchFixture(), check_login_status: '✅ 已登录' }, log),
      rateLimiter: isolatedBucket(),
      travelRoot,
    })
    const channel = xhsMcpChannel(adapter)
    const outcome = await channel.run({ destination: '杭州' }, channelCtx({ env: {} }))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items.some((i) => i.channel === 'xhs-mcp')).toBe(true)
    }
    // 惰性缓存命中 → 不放重复的登录态预检
    expect(log.calls).not.toContain('check_login_status')
    expect(existsSync(adapter.authMarkerPath())).toBe(true)
  })
})

describe('登录态主路径 + 会话失效自动降级', () => {
  it('search_feeds 参数契约（上游 additionalProperties:false 实测）：只传 keyword，limit 客户端截取', async () => {
    const toolArgs: Array<Record<string, unknown>> = []
    const fetchFn: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { method: string; params?: { name?: string; arguments?: Record<string, unknown> }; id?: number }
      if (body.method === 'initialize') {
        return ok({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }, 'fake-xhs-session')
      }
      if (body.method === 'notifications/initialized') {
        return { ok: true, status: 202, text: async () => '' }
      }
      if (body.method === 'tools/call' && body.params?.name === 'search_feeds') {
        toolArgs.push(body.params.arguments ?? {})
        // 上游 fixture 3 条（含直播卡过滤后 2 条 note）→ limit=1 应客户端截为 1 条
        return ok({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(searchFixture()) }] } })
      }
      return ok({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } })
    }
    const adapter = new XhsAdapter({
      mcp: new McpStreamClient({ url: 'http://127.0.0.1:18060/mcp', fetchFn, readOnlyGate: assertXhsReadOnly }),
      travelRoot: '/nonexistent-xhs-test',
    })
    const { feeds } = await adapter.searchFeeds({ keyword: '杭州 旅游攻略', limit: 1 }, AUTHORIZED_ENV)
    // 红线回归（2026-09-04 live 实录 -32602）：多传未声明属性 limit → invalid params
    expect(toolArgs).toEqual([{ keyword: '杭州 旅游攻略' }])
    expect(feeds.length).toBe(1)
  })

  it('授权 + 登录态正常 → xhs-mcp 条目（前 2 条正文富化，预算内）', async () => {
    const log: FakeMcpLog = { calls: [] }
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({
        search_feeds: searchFixture(),
        get_feed_detail: detailFixture(),
        check_login_status: '✅ 已登录\n用户名: 测试用户',
      }, log),
      travelRoot: '/nonexistent-xhs-test',
    })
    const channel = xhsMcpChannel(adapter, fakeFallbackSearch())
    const outcome = await channel.run({ destination: '杭州' }, channelCtx(AUTHORIZED_ENV))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const xhsMcpItems = outcome.items.filter((i) => i.channel === 'xhs-mcp')
      expect(xhsMcpItems.length).toBe(2) // 直播卡已滤
      expect(xhsMcpItems[0]?.summary).toContain('断桥') // 富化正文贯通
      expect(xhsMcpItems[1]?.summary).not.toContain('IP属地：浙江')
      expect(String(xhsMcpItems[1]?.content ?? '')).not.toBe('') // 正文保留在 content，元信息不回摘要
    }
    expect(log.calls.filter((c) => c === 'search_feeds').length).toBe(1)
    expect(log.calls.filter((c) => c === 'get_feed_detail').length).toBe(2) // 前 2 条富化
  })

  it('会话失效特征（search_feeds 静默空 + check_login_status 未登录）→ 自动降级 L0+L0.5', async () => {
    const log: FakeMcpLog = { calls: [] }
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({
        search_feeds: { feeds: [], count: 0 },
        check_login_status: '❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。',
      }, log),
      travelRoot: '/nonexistent-xhs-test',
    })
    const channel = xhsMcpChannel(adapter, fakeFallbackSearch())
    const outcome = await channel.run({ destination: '杭州' }, channelCtx(AUTHORIZED_ENV))
    // 降级链产出（非登录态条目），流程不中断
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items.length).toBeGreaterThan(0)
      expect(outcome.items.every((i) => i.channel === 'xhs-l0')).toBe(true)
      expect(outcome.items[0]?.summary).toContain('登录态检索失败已自动降级')
      expect(outcome.items[0]?.summary).toContain('登录态失效')
      expect(outcome.items[0]?.summary).toContain('抽样语义')
    }
    expect(log.calls).toContain('check_login_status') // 失效检测发生过
  })

  it('容器停（连接拒绝）→ available=false；run 内降级链仍产出（不中断）', async () => {
    const refused: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18060')
    }
    const adapter = new XhsAdapter({
      mcp: new McpStreamClient({ url: 'http://127.0.0.1:18060/mcp', fetchFn: refused, readOnlyGate: assertXhsReadOnly, timeoutMs: 1000 }),
      travelRoot: '/nonexistent-xhs-test',
    })
    expect(await adapter.available(AUTHORIZED_ENV)).toBe(false)
    const channel = xhsMcpChannel(adapter, fakeFallbackSearch())
    // available=false 时 fan-out 跳过渠道；直接 run 验证降级链内部语义
    const outcome = await channel.run({ destination: '杭州' }, channelCtx(AUTHORIZED_ENV))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.items[0]?.summary).toContain('ECONNREFUSED')
    }
  })

  it('降级链也无结果（search 未注入）→ 原错误记账（ok:false）', async () => {
    const log: FakeMcpLog = { calls: [] }
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({
        search_feeds: { feeds: [], count: 0 },
        check_login_status: '❌ 未登录',
      }, log),
      travelRoot: '/nonexistent-xhs-test',
    })
    const channel = xhsMcpChannel(adapter, undefined)
    const outcome = await channel.run({ destination: '杭州' }, channelCtx(AUTHORIZED_ENV))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('登录态检索失败')
      expect(outcome.reason).toContain('降级链无条目')
    }
  })
})

describe('频控（W1 令牌桶生效；域=xiaohongshu.com）', () => {
  it('search_feeds 前经令牌桶占用 xiaohongshu.com 域', async () => {
    const acquired: string[] = []
    const recording = {
      tryAcquire(domain: string, _limit: number): RateLimitDecision {
        acquired.push(domain)
        return { ok: true, domain, remaining: 9, limit: 10, resetAtMs: Date.now() + 60_000 } as RateLimitDecision
      },
      async acquire(domain: string, _limit: number): Promise<void> {
        acquired.push(domain)
      },
    }
    const adapter = new XhsAdapter({
      mcp: fakeXhsMcp({ search_feeds: searchFixture() }, { calls: [] }),
      travelRoot: '/nonexistent-xhs-test',
      // 结构面注入（BaseAdapter governance.rateLimiter）
      rateLimiter: recording as unknown as import('../src/adapters/governance/index.js').DomainTokenBucket,
    })
    await adapter.searchFeeds({ keyword: '杭州 旅游攻略' }, AUTHORIZED_ENV)
    expect(acquired).toContain('xiaohongshu.com')
  })

  it('真实令牌桶 limit=1：窗口内第二请求拒绝（retryAfterMs>0），窗口滑出后放行', () => {
    const clock = { t: 1_000_000 }
    const bucket = createDomainTokenBucket({ now: () => clock.t })
    expect(bucket.tryAcquire('xiaohongshu.com', 1).ok).toBe(true)
    const second = bucket.tryAcquire('xiaohongshu.com', 1)
    expect(second.ok).toBe(false)
    expect(second.retryAfterMs).toBeGreaterThan(0)
    clock.t += 60_001
    expect(bucket.tryAcquire('xiaohongshu.com', 1).ok).toBe(true)
  })
})

describe('会话失效文本特征（check_login_status 实测口径）', () => {
  it('未登录/过期特征命中；已登录不命中', () => {
    expect(isLoginRequiredText('❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。')).toBe(true)
    expect(isLoginRequiredText('登录已过期，请重新扫码')).toBe(true)
    expect(isLoginRequiredText('✅ 已登录\n用户名: 测试用户')).toBe(false)
  })
})

// ────────────────────────── live smoke（TRAVEL_LIVE_SMOKE=1 执行；缺省跳过） ──────────────────────────

const liveEnabled = process.env.TRAVEL_LIVE_SMOKE === '1'
describe.skipIf(!liveEnabled)('xhs live smoke（真实 xiaohongshu-mcp，127.0.0.1:18060）', () => {
  it('容器存活 + 工具面红线（live tools/list）+ 会话失效检测/登录态检索二态', async () => {
    const adapter = new XhsAdapter()
    if (!(await adapter.mcp.ping())) {
      console.warn('[xhs live] 容器 18060 不可达——跳过（部署见 docs/deploy.md §5）')
      return
    }
    // 红线 live 核验：上游实测工具面含 9 写端点，全部不得通过 isXhsReadOnlyTool
    const upstream = await adapter.mcp.listTools()
    expect(upstream.length).toBeGreaterThanOrEqual(18)
    const writeKeywords = /publish|comment|reply|like|favorite|follow|delete|upload|post|block/i
    for (const tool of upstream) {
      if (writeKeywords.test(tool.name)) {
        expect(isXhsReadOnlyTool(tool.name)).toBe(false)
      }
    }
    // 白名单 4 件必须真实存在上游（防上游更名后白名单悬空）
    for (const name of XHS_READ_ONLY_TOOLS) {
      expect(upstream.some((t) => t.name === name)).toBe(true)
    }
    // 会话二态：未登录 → search_feeds 静默空被识别为失效（降级链接管）；
    // 已登录（扫码交割后）→ 登录态检索真跑出条目（gated-pending 回补路径）
    if (await adapter.sessionInvalid()) {
      await expect(adapter.searchFeeds({ keyword: '杭州 旅游攻略' })).rejects.toThrow(/登录态失效/)
      console.warn('[xhs live] 当前未登录——登录态检索 gated-pending，待扫码后回补')
    } else {
      const { feeds } = await adapter.searchFeeds({ keyword: '杭州 旅游攻略' })
      expect(feeds.length).toBeGreaterThan(0)
      console.log(`[xhs live] 登录态检索实测：${feeds.length} 条（channel=xhs-mcp 标注贯通）`)
    }
  }, 180_000)
})

// ────────────────────────── 测试助手 ──────────────────────────

/** 降级链 fake：宿主搜索回 2 条 xiaohongshu explore 命中；L0.5 直抓 404（保标题级条目）。 */
function fakeFallbackSearch(): SearchAdapter {
  const hostSearch: HostSearchFn = async (query) => ({
    sources: [
      {
        url: 'https://www.xiaohongshu.com/explore/65aabbcc0000000000111111?xsec_token=SHOULDNOTLEAK',
        title: `${query} 攻略帖（L0 标题级）`,
        snippet: '降级链命中',
      },
      {
        url: 'https://www.xiaohongshu.com/explore/65aabbcc0000000000222222',
        title: `${query} 另一篇`,
        snippet: '降级链命中2',
      },
    ],
    truncated: false,
  })
  return new SearchAdapter({
    hostSearch,
    fetchHtml: async () => ({ status: 404, text: '页面不见了' }),
  })
}
