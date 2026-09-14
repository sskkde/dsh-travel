/**
 * XHS 正文 token 通道回归：60min TTL、单次 MCP 续期、宿主次级回源与失败分类。
 * 所有 token 仅由运行时合成，测试输出/回执只保留分类与计数，不打印令牌值。
 */
import { describe, expect, it } from 'vitest'
import { createDomainTokenBucket } from '../src/adapters/governance/index.js'
import { EngineError, toDegraded, type KeyResolutionEnv } from '../src/adapters/base.js'
import {
  assertXhsReadOnly,
  XhsAdapter,
  XhsTokenCache,
} from '../src/adapters/xhs.js'
import { McpStreamClient, type FetchLike } from '../src/adapters/rail12306.js'
import {
  SearchAdapter,
  type FetchHtmlFn,
  type HostSearchFn,
} from '../src/adapters/search.js'
import { createFetchBodyHandler } from '../src/tools/research-content.js'
import type { IntelItem } from '../src/models/types.js'

const ENV: KeyResolutionEnv = { env: {} }
const NOTE_ID = 'notea1'
const NOTE_TITLE = '此生必驾🔥青甘大环线旅游地图攻略'
const SEARCHABLE_TITLE = '青甘大环线旅游地图攻略'

function syntheticToken(seed: string): string {
  // 合成值只存在于本测试进程内；不作为日志/工件预期内容。
  return ['runtime', 'xsec', seed, 'token'].join('-')
}

function feed(noteId: string, xsecToken: string, title = `测试笔记 ${noteId}`): Record<string, unknown> {
  return {
    modelType: 'note',
    id: noteId,
    xsecToken,
    noteCard: { displayTitle: title, user: { nickname: '测试作者' } },
  }
}

function searchPayload(feeds: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { feeds, count: feeds.length }
}

interface FakeMcpLog {
  calls: string[]
  searchKeywords: string[]
  detailTokens: string[]
}

interface FakeMcpOptions {
  searchResult: (callIndex: number, keyword: string) => unknown
  detailBody?: (token: string) => string
  failSearch?: boolean
  failDetail?: boolean
}

function jsonRpc(body: unknown, sessionId?: string): ReturnType<FetchLike> {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: sessionId
      ? { get: (name: string) => name.toLowerCase() === 'mcp-session-id' ? sessionId : null }
      : undefined,
  } as unknown as ReturnType<FetchLike>
}

function fakeXhsMcp(options: FakeMcpOptions, log: FakeMcpLog): McpStreamClient {
  let searchCount = 0
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as {
      method?: string
      id?: number
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    if (body.method === 'initialize') {
      return jsonRpc({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }, 'ttl-session')
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method !== 'tools/call') {
      return jsonRpc({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } })
    }
    const name = body.params?.name ?? ''
    log.calls.push(name)
    if (name === 'search_feeds') {
      const keyword = String(body.params?.arguments?.keyword ?? '')
      log.searchKeywords.push(keyword)
      searchCount += 1
      if (options.failSearch) throw new Error('MCP search unavailable')
      return jsonRpc({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify(options.searchResult(searchCount, keyword)) }] },
      })
    }
    if (name === 'get_feed_detail') {
      const supplied = body.params?.arguments?.xsec_token
      const token = typeof supplied === 'string' ? supplied : ''
      if (typeof supplied === 'string') log.detailTokens.push(supplied)
      if (options.failDetail) throw new Error('MCP detail unavailable')
      return jsonRpc({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({
          note: { desc: options.detailBody?.(token) ?? '这是可存档的 XHS 正文。', time: 1780000000000 },
        }) }] },
      })
    }
    return jsonRpc({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '✅ 已登录' }] } })
  }
  return new McpStreamClient({
    url: 'http://127.0.0.1:18060/mcp',
    fetchFn,
    readOnlyGate: assertXhsReadOnly,
  })
}

function unavailableMcp(log: FakeMcpLog): McpStreamClient {
  return fakeXhsMcp({
    failSearch: true,
    searchResult: () => searchPayload([]),
  }, log)
}

function makeAdapter(options: FakeMcpOptions, log: FakeMcpLog, tokenCache?: XhsTokenCache): XhsAdapter {
  return new XhsAdapter({
    mcp: fakeXhsMcp(options, log),
    tokenCache,
    rateLimiter: createDomainTokenBucket(),
  })
}

function xhsItem(noteId: string, title = `测试笔记 ${noteId}`): IntelItem {
  return {
    id: `xhs:${noteId}`,
    category: 'recommend',
    channel: 'xhs-mcp',
    title,
    summary: '标题级摘要',
    source: {
      platform: 'xiaohongshu-mcp',
      url: `https://www.xiaohongshu.com/explore/${noteId}`,
      fetchedAt: '2026-09-15T00:00:00.000Z',
    },
    confidence: 'medium',
  }
}

function xhsHtml(noteId: string, body: string): string {
  const state = {
    note: {
      noteDetailMap: {
        [noteId]: { note: { title: `测试笔记 ${noteId}`, desc: body } },
      },
    },
  }
  return `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)}</script>`
}

async function fetchBody(
  item: IntelItem,
  xhs: XhsAdapter,
  search: SearchAdapter | undefined,
  renewalKeyword?: string,
) {
  if (renewalKeyword !== undefined) {
    const noteId = item.id.startsWith('xhs:') ? item.id.slice('xhs:'.length) : ''
    // 只保留标题线索，模拟 token 到期后 cache entry 被移除但 hint 仍可续期。
    xhs.tokenCache.remember('plan-content', noteId, syntheticToken('expired-hint'), 'xsec_token', renewalKeyword)
    xhs.tokenCache.delete('plan-content', noteId)
  }
  const handler = createFetchBodyHandler(async () => ({ status: 500, text: 'not used' }), { xhs, search })
  return handler(item, { planId: 'plan-content', refresh: false })
}

describe('XHS content token TTL + renewal', () => {
  it('T+6min 与 T+59min 仍命中 60min token 通道', async () => {
    let now = 0
    const token = syntheticToken('ttl')
    const log: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const cache = new XhsTokenCache({ now: () => now })
    const adapter = makeAdapter({
      searchResult: () => searchPayload([feed(NOTE_ID, token)]),
    }, log, cache)

    await adapter.searchFeeds({ planId: 'plan-ttl', keyword: '初始检索', limit: 1 }, ENV)
    now = 6 * 60 * 1000
    const at6 = await adapter.fetchFeedDetailForPlan('plan-ttl', NOTE_ID, ENV)
    now = 59 * 60 * 1000
    const at59 = await adapter.fetchFeedDetailForPlan('plan-ttl', NOTE_ID, ENV)

    expect(at6?.desc).toBe('这是可存档的 XHS 正文。')
    expect(at59?.desc).toBe('这是可存档的 XHS 正文。')
    expect(log.searchKeywords).toHaveLength(1)
    expect(log.detailTokens).toHaveLength(2)
    console.log('[xhs-ttl] T+6min=hit; T+59min=hit; renewalSearches=0; detailCalls=2')
  })

  it('T+61min 缓存过期后只做一次同 noteId MCP 续期并只抓一次详情', async () => {
    let now = 0
    const initialToken = syntheticToken('initial')
    const renewedToken = syntheticToken('renewed')
    const log: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const cache = new XhsTokenCache({ now: () => now })
    const adapter = makeAdapter({
      // 真实行为形状：任意非标题关键词只返回无关笔记，标题关键词返回
      // 无关首条 + 目标笔记；目标必须逐条按 noteId 精确比对。
      searchResult: (callIndex, keyword) => keyword === SEARCHABLE_TITLE
        ? searchPayload([
          feed('unrelated1', syntheticToken('unrelated'), '照片'),
          feed(NOTE_ID, callIndex === 1 ? initialToken : renewedToken, NOTE_TITLE),
        ])
        : searchPayload([feed('unrelated1', syntheticToken('unrelated'), '照片')]),
    }, log, cache)

    await adapter.searchFeeds({ planId: 'plan-renew', keyword: SEARCHABLE_TITLE, limit: 20 }, ENV)
    now = 61 * 60 * 1000
    const result = await adapter.fetchFeedDetailForPlanResult('plan-renew', NOTE_ID, ENV)

    expect(result.detail?.desc).toBe('这是可存档的 XHS 正文。')
    expect(result.failureReason).toBeUndefined()
    expect(log.searchKeywords).toEqual([SEARCHABLE_TITLE, SEARCHABLE_TITLE])
    expect(log.searchKeywords[1]).not.toBe(NOTE_ID)
    expect(log.detailTokens).toEqual([renewedToken])
    expect(cache.get('plan-renew', NOTE_ID)?.token).toBe(renewedToken)
    expect(cache.getSearchKeyword('plan-renew', NOTE_ID)).toBe(SEARCHABLE_TITLE)
    console.log('[xhs-ttl] T+61min=renewed; renewalSearches=1; renewalKeyword=title; comparedNoteId=notea1; detailCalls=1')
  })

  it('noteId 不是可检索关键词：即使被误用也只能返回 note_not_found', async () => {
    let now = 0
    const log: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const cache = new XhsTokenCache({ now: () => now })
    // 故意把错误的 noteId 作为缓存线索，模拟旧实现的错误关键词；真实形状 fake
    // 对 noteId 只返回无关笔记，因此不能误判续期成功。
    cache.remember('plan-negative', NOTE_ID, syntheticToken('negative'), 'xsec_token', NOTE_ID)
    now = 61 * 60 * 1000
    const adapter = makeAdapter({
      searchResult: (_callIndex, keyword) => keyword === NOTE_TITLE
        ? searchPayload([feed('unrelated1', syntheticToken('unrelated'), '照片'), feed(NOTE_ID, syntheticToken('never'), NOTE_TITLE)])
        : searchPayload([feed('unrelated1', syntheticToken('unrelated'), '照片')]),
    }, log, cache)

    const result = await adapter.fetchFeedDetailForPlanResult('plan-negative', NOTE_ID, ENV)

    expect(result.detail).toBeUndefined()
    expect(result.failureReason).toBe('note_not_found')
    expect(log.searchKeywords).toEqual([NOTE_ID])
    expect(log.detailTokens).toEqual([])
    console.log('[xhs-ttl] noteIdKeyword=not_accepted; reason=note_not_found; detailCalls=0')
  })

  it('MCP 续期不可用时回退宿主；两者都不可用时报告 no_host_search', async () => {
    const noteId = 'notehost'
    const hostToken = syntheticToken('host')
    const mcpLog: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const hostCalls: string[] = []
    const hostSearch: HostSearchFn = async (query) => {
      hostCalls.push(query)
      return {
        sources: [{ url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(hostToken)}` }],
        truncated: false,
      }
    }
    const fetchHtml: FetchHtmlFn = async () => ({ status: 200, text: xhsHtml(noteId, '宿主次级回源正文。') })
    const mcpUnavailable = new XhsAdapter({
      mcp: unavailableMcp(mcpLog),
      tokenCache: new XhsTokenCache(),
      rateLimiter: createDomainTokenBucket(),
    })
    const search = new SearchAdapter({ hostSearch, fetchHtml })
    const item = xhsItem(noteId, '宿主回源目标')
    const recovered = await fetchBody(item, mcpUnavailable, search, '宿主回源目标')

    expect(recovered.ok).toBe(true)
    expect(hostCalls).toEqual([noteId])
    expect(mcpLog.searchKeywords).toEqual(['宿主回源目标'])

    const noHostLog: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const noHost = await fetchBody(
      item,
      new XhsAdapter({
        mcp: unavailableMcp(noHostLog),
        tokenCache: new XhsTokenCache(),
        rateLimiter: createDomainTokenBucket(),
      }),
      new SearchAdapter(),
      '宿主回源目标',
    )
    expect(noHost.ok).toBe(false)
    if (!noHost.ok) {
      expect(noHost.reason).toContain('[no_host_search]')
      const degraded = toDegraded('search-l0.5', new EngineError('UNAVAILABLE', noHost.reason, 'search-l0.5'))
      expect(degraded.reason).toContain('no_host_search')
      console.log(`[xhs-ttl] raw no_host_search=${noHost.reason}`)
    }
    console.log('[xhs-ttl] MCP=unavailable → host=fallback; host=missing → reason=no_host_search')
  })

  it('回源未命中与命中无 token 分别报告 note_not_found / token_unusable', async () => {
    const noMatchLog: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const noMatch = await fetchBody(
      xhsItem('notfound1', '未命中标题'),
      makeAdapter({ searchResult: () => searchPayload([feed('othernote', syntheticToken('other'))]) }, noMatchLog),
      new SearchAdapter(),
      '未命中标题',
    )
    expect(noMatch.ok).toBe(false)
    if (!noMatch.ok) expect(noMatch.reason).toContain('[note_not_found]')

    const noTokenLog: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const noToken = await fetchBody(
      xhsItem('notoken1', '无 token 标题'),
      makeAdapter({ searchResult: () => searchPayload([feed('notoken1', '')]) }, noTokenLog),
      new SearchAdapter(),
      '无 token 标题',
    )
    expect(noToken.ok).toBe(false)
    if (!noToken.ok) expect(noToken.reason).toContain('[token_unusable]')

    // 同样验证宿主次级回源的两个分类：同 noteId 无 token ≠ 完全未命中。
    const hostNoMatch = await fetchBody(
      xhsItem('hostmissing1', '宿主未命中标题'),
      new XhsAdapter({
        mcp: unavailableMcp({ calls: [], searchKeywords: [], detailTokens: [] }),
        rateLimiter: createDomainTokenBucket(),
      }),
      new SearchAdapter({
        hostSearch: async () => ({ sources: [{ url: 'https://www.xiaohongshu.com/explore/othernote' }], truncated: false }),
      }),
      '宿主未命中标题',
    )
    expect(hostNoMatch.ok).toBe(false)
    if (!hostNoMatch.ok) expect(hostNoMatch.reason).toContain('[note_not_found]')

    const hostNoToken = await fetchBody(
      xhsItem('hostnotoken1', '宿主无 token 标题'),
      new XhsAdapter({
        mcp: unavailableMcp({ calls: [], searchKeywords: [], detailTokens: [] }),
        rateLimiter: createDomainTokenBucket(),
      }),
      new SearchAdapter({
        hostSearch: async () => ({ sources: [{ url: 'https://www.xiaohongshu.com/explore/hostnotoken1' }], truncated: false }),
      }),
      '宿主无 token 标题',
    )
    expect(hostNoToken.ok).toBe(false)
    if (!hostNoToken.ok) expect(hostNoToken.reason).toContain('[token_unusable]')

    console.log(`[xhs-ttl] raw note_not_found=${noMatch.ok ? 'unexpected-success' : noMatch.reason}`)
    console.log(`[xhs-ttl] raw token_unusable=${noToken.ok ? 'unexpected-success' : noToken.reason}`)
    console.log('[xhs-ttl] failureReasons: note_not_found=1; token_unusable=1')
  })

  it('跨计划隔离：另一 planId 不借用原计划 token', async () => {
    const tokenA = syntheticToken('plan-a')
    const log: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const cache = new XhsTokenCache()
    const adapter = makeAdapter({
      searchResult: (callIndex) => callIndex === 1
        ? searchPayload([feed(NOTE_ID, tokenA)])
        : searchPayload([feed('differentnote', syntheticToken('different'))]),
    }, log, cache)

    await adapter.searchFeeds({ planId: 'plan-a', keyword: '计划 A', limit: 1 }, ENV)
    cache.remember('plan-b', NOTE_ID, syntheticToken('expired-plan-b'), 'xsec_token', '计划 B 标题')
    cache.delete('plan-b', NOTE_ID)
    const result = await adapter.fetchFeedDetailForPlanResult('plan-b', NOTE_ID, ENV)

    expect(result.detail).toBeUndefined()
    expect(result.failureReason).toBe('note_not_found')
    expect(log.detailTokens).toEqual([])
    expect(cache.get('plan-a', NOTE_ID)?.token).toBe(tokenA)
    expect(cache.get('plan-b', NOTE_ID)).toBeUndefined()
    console.log('[xhs-ttl] crossPlanReuse=false; planBDetailCalls=0')
  })

  it('运行期 token 不进入正文回执或 degraded 错误面', async () => {
    const token = syntheticToken('leak-scan')
    const log: FakeMcpLog = { calls: [], searchKeywords: [], detailTokens: [] }
    const cache = new XhsTokenCache()
    cache.remember('plan-leak', NOTE_ID, syntheticToken('expired-leak'), 'xsec_token', NOTE_TITLE)
    cache.delete('plan-leak', NOTE_ID)
    const adapter = makeAdapter({
      searchResult: () => searchPayload([feed(NOTE_ID, token, NOTE_TITLE)]),
      detailBody: () => '安全正文，不包含运行期凭据。',
    }, log, cache)
    const planResult = await adapter.fetchFeedDetailForPlanResult('plan-leak', NOTE_ID, ENV)
    const safeError = new EngineError('UNAVAILABLE', '[token_unusable] 续期失败', 'xhs')
    const visible = JSON.stringify({ planResult, degraded: toDegraded('xhs', safeError) })

    expect(visible).not.toContain(token)
    expect(visible).not.toContain('xsec_token=')
    expect(planResult.detail?.desc).toBe('安全正文，不包含运行期凭据。')
    console.log('[xhs-ttl] token-leak-scan=0 (runtime synthetic values absent from visible output)')
  })
})
