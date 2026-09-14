/**
 * W1/T3 定向回归：正文抓取令牌通道、退役社媒兼容路径与 AMap HTTP 参数。
 * 所有上游均为内存 fake；令牌只在测试运行期变量/调用参数中出现，不写入工件或日志。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AmapAdapter, QuotaCounter } from '../src/adapters/amap.js'
import { assertXhsReadOnly, XhsAdapter, XhsTokenCache } from '../src/adapters/xhs.js'
import { McpStreamClient, type FetchLike } from '../src/adapters/rail12306.js'
import { SearchAdapter, type FetchHtmlFn, type HostSearchFn } from '../src/adapters/search.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { createFetchBodyHandler, runFetchResearchContent } from '../src/tools/research-content.js'
import type { IntelItem } from '../src/models/types.js'
import type { CanonicalQuery } from '../src/adapters/base.js'
import type { ResearchChannel } from '../src/orchestrator/types.js'
import { runResearchDestination } from '../src/tools/research-destination.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-round3-w1-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ENV: KeyResolutionEnv = { env: { amapWebservice: 'fixture-key' } }

function transientToken(seed: string): string {
  // 运行时组合，避免把任何可用凭据字面量写入测试源码/录制。
  return ['xsec', seed, 'ephemeral'].join('-')
}

function xhsItem(noteId: string): IntelItem {
  return {
    id: `xhs:${noteId}`,
    category: 'recommend',
    channel: 'xhs-mcp',
    title: `小红书 ${noteId}`,
    summary: '正文摘要',
    source: {
      platform: 'xiaohongshu-mcp',
      url: `https://www.xiaohongshu.com/explore/${noteId}`,
      fetchedAt: '2026-09-12T00:00:00.000Z',
    },
    confidence: 'medium',
  }
}

function webItem(id: string, url: string): IntelItem {
  return {
    id,
    category: 'recommend',
    channel: 'web',
    title: id,
    summary: '网页摘要',
    source: { platform: 'web', url, fetchedAt: '2026-09-12T00:00:00.000Z' },
    confidence: 'medium',
  }
}

function scriptedChannel(items: IntelItem[]): ResearchChannel {
  return {
    name: 'fixture',
    async available() { return true },
    async run(_query: CanonicalQuery) { return { ok: true, items } },
  }
}

async function makePlan(item: IntelItem): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-10-01', dateEnd: '2026-10-01', days: 1 },
  }, store)
  await runResearchDestination({
    planId: intake.planId,
    keywords: ['西宁'],
    requestId: `w1-${item.id}`,
  }, store, { channels: [scriptedChannel([item])], retryDelaysMs: [] })
  return intake.planId
}

interface FakeMcpLog {
  calls: string[]
  detailTokens: string[]
}

function jsonRpc(body: unknown, sessionId?: string): ReturnType<FetchLike> {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: sessionId ? { get: (name: string) => name.toLowerCase() === 'mcp-session-id' ? sessionId : null } : undefined,
  } as unknown as ReturnType<FetchLike>
}

function fakeXhsMcp(
  token: string,
  bodyFactory: () => string,
  log: FakeMcpLog,
  searchFactory?: (keyword: string) => unknown,
): McpStreamClient {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as {
      method?: string
      id?: number
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    if (body.method === 'initialize') return jsonRpc({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } }, 'w1-session')
    if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' }
    if (body.method !== 'tools/call') return jsonRpc({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } })
    const name = body.params?.name ?? ''
    log.calls.push(name)
    if (name === 'search_feeds') {
      const keyword = String(body.params?.arguments?.keyword ?? '')
      const supplied = searchFactory?.(keyword) ?? {
        feeds: [{
          modelType: 'note', id: 'notea1', xsecToken: token,
          noteCard: { displayTitle: '青甘正文', user: { nickname: '测试作者' }, interactInfo: { likedCount: '2' } },
        }], count: 1,
      }
      return jsonRpc({
        jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(supplied) }] },
      })
    }
    if (name === 'get_feed_detail') {
      const supplied = body.params?.arguments?.xsec_token
      if (typeof supplied === 'string') log.detailTokens.push(supplied)
      return jsonRpc({
        jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({
          note: { desc: bodyFactory(), time: 1780000000000, ipLocation: '青海', interactInfo: { likedCount: '3' } },
        }) }] },
      })
    }
    return jsonRpc({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '✅ 已登录' }] } })
  }
  return new McpStreamClient({ url: 'http://127.0.0.1:18060/mcp', fetchFn, readOnlyGate: assertXhsReadOnly })
}

function allPersistedText(dir: string): string {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(allPersistedText(path))
    else out.push(readFileSync(path, 'utf8'))
  }
  return out.join('\n')
}

async function runXhsFetch(
  planId: string,
  xhs: XhsAdapter,
  refresh = false,
): Promise<Awaited<ReturnType<typeof runFetchResearchContent>>> {
  const fetchBody = createFetchBodyHandler(async () => ({ status: 500, text: 'not used' }), { xhs })
  return runFetchResearchContent({ planId, itemIds: ['xhs:notea1'], refresh }, store, {
    fetchBody,
    env: { env: {} },
  })
}

describe('P0-3：XHS 会话 token 通道', () => {
  it('检索 token 命中正文，且 token 不进工件/回执/持久化日志', async () => {
    const token = transientToken('hit')
    const log: FakeMcpLog = { calls: [], detailTokens: [] }
    const cache = new XhsTokenCache()
    const xhs = new XhsAdapter({
      tokenCache: cache,
      mcp: fakeXhsMcp(token, () => '这是同一笔记的完整正文，包含路线、费用与安全提示。', log),
      travelRoot: join(root, 'xhs'),
    })
    const planId = await makePlan(xhsItem('notea1'))
    await xhs.searchFeeds({ planId, keyword: '青甘 旅游攻略', limit: 1 }, { env: {} })
    const result = await runXhsFetch(planId, xhs)
    expect(result.items[0]?.contentStatus).toBe('extracted')
    expect(result.items[0]?.ok).toBe(true)
    expect(log.detailTokens).toEqual([token])
    const receiptText = JSON.stringify(result)
    expect(receiptText).not.toContain(token)
    expect(allPersistedText(root)).not.toContain(token)
    expect(log.calls).toEqual(['search_feeds', 'get_feed_detail'])
  })

  it('相同 noteId 的另一 planId 不复用原计划 token', async () => {
    const token = transientToken('isolated')
    const log: FakeMcpLog = { calls: [], detailTokens: [] }
    const cache = new XhsTokenCache()
    const xhs = new XhsAdapter({
      tokenCache: cache,
      mcp: fakeXhsMcp(token, () => '计划 A 正文', log, (keyword) => keyword === 'notea1'
        ? { feeds: [{ modelType: 'note', id: 'othernote', xsecToken: token }], count: 1 }
        : undefined),
      travelRoot: join(root, 'xhs'),
    })
    const planA = await makePlan(xhsItem('notea1'))
    const planB = await makePlan(xhsItem('notea1'))
    await xhs.searchFeeds({ planId: planA, keyword: '青甘', limit: 1 }, { env: {} })
    const result = await runXhsFetch(planB, xhs)
    expect(result.items[0]?.contentStatus).toBe('unavailable')
    expect(log.detailTokens).toEqual([])
    expect(cache.get(planA, 'notea1')?.token).toBe(token)
    expect(cache.get(planB, 'notea1')).toBeUndefined()
    expect(allPersistedText(root)).not.toContain(token)
  })

  it('TTL 过期且新实例只做一次同 noteId 回源', async () => {
    let now = 1_000
    const token = transientToken('expired')
    const cache = new XhsTokenCache({ ttlMs: 10, now: () => now })
    const initialCalls: string[] = []
    const initialHost: HostSearchFn = async () => {
      initialCalls.push('initial')
      return { sources: [{ url: `https://www.xiaohongshu.com/explore/notea1?xsec_token=${encodeURIComponent(token)}` }], truncated: false }
    }
    const initial = new SearchAdapter({ hostSearch: initialHost, xhsTokenCache: cache })
    await initial.searchL0({ planId: 'plan-expired', keywords: '青甘', sites: ['xiaohongshu.com'] })
    now = 2_000
    const replayCalls: string[] = []
    const wrongNoteToken = ['wrong', 'note'].join('-')
    const replayHost: HostSearchFn = async () => {
      replayCalls.push('re-source')
      return {
        sources: [
          { url: `https://www.xiaohongshu.com/explore/othernote?xsec_token=${encodeURIComponent(wrongNoteToken)}` },
          { url: `https://www.xiaohongshu.com/explore/notea1?xsec_token=${encodeURIComponent(token)}` },
        ],
        truncated: false,
      }
    }
    const fetchCalls: string[] = []
    const fetchHtml: FetchHtmlFn = async (url) => {
      fetchCalls.push(url)
      const xhsHtml = readFileSync(new URL('./fixtures/search/xhs-explore.html', import.meta.url), 'utf8')
      return { status: 200, contentType: 'text/html', finalUrl: url, text: xhsHtml }
    }
    const restarted = new SearchAdapter({ hostSearch: replayHost, fetchHtml, xhsTokenCache: new XhsTokenCache({ now: () => now }) })
    const planId = await makePlan(xhsItem('notea1'))
    const handler = createFetchBodyHandler(async () => ({ status: 500, text: 'not used' }), { search: restarted })
    const result = await runFetchResearchContent({ planId, itemIds: ['xhs:notea1'] }, store, { fetchBody: handler })
    expect(result.items[0]?.contentStatus).toBe('extracted')
    expect(replayCalls).toHaveLength(1)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toContain('/explore/notea1?')
    expect(initialCalls).toHaveLength(2) // site: 变体 + 裸查询各一次
  })

  it('refresh 绕过正文缓存，但仍使用有效计划 token 并重新取正文', async () => {
    const token = transientToken('refresh')
    const bodies = ['第一次正文，带有足够的内容用于存档。', '刷新后的正文，内容已经发生变化并重新存档。']
    let detailCount = 0
    const log: FakeMcpLog = { calls: [], detailTokens: [] }
    const xhs = new XhsAdapter({
      tokenCache: new XhsTokenCache(),
      mcp: fakeXhsMcp(token, () => bodies[detailCount++], log),
      travelRoot: join(root, 'xhs'),
    })
    const planId = await makePlan(xhsItem('notea1'))
    await xhs.searchFeeds({ planId, keyword: '青甘', limit: 1 }, { env: {} })
    const first = await runXhsFetch(planId, xhs)
    const second = await runXhsFetch(planId, xhs, true)
    expect(first.items[0]?.contentStatus).toBe('extracted')
    expect(second.items[0]?.contentStatus).toBe('extracted')
    expect(detailCount).toBe(2)
    expect(log.detailTokens).toEqual([token, token])
    expect(allPersistedText(root)).not.toContain(token)
  })
})

describe('P0-3：退役社媒域名兼容路径', () => {
  it('旧豆瓣 URL 不触发专用 SSR/安全分支，按通用抽取路径如实处理', async () => {
    const url = 'https://www.douban.com/note/legacy'
    const planId = await makePlan(webItem('legacy:douban', url))
    const fetchCalls: string[] = []
    const handler = createFetchBodyHandler(async (requestedUrl) => {
      fetchCalls.push(requestedUrl)
      return {
        status: 200,
        contentType: 'text/html',
        finalUrl: requestedUrl,
        text: '<html><article>退役平台旧正文只按通用抽取保存。这里包含路线说明、住宿体验和注意事项，长度足够完成正文校验。</article></html>',
      }
    })
    const result = await runFetchResearchContent({ planId, itemIds: ['legacy:douban'] }, store, { fetchBody: handler })
    expect(result.items[0]?.contentStatus).toBe('extracted')
    expect(result.items[0]?.ok).toBe(true)
    expect(fetchCalls).toEqual([url])
  })
})

describe('P1-5：AMap 参数与失败分类', () => {
  it('distance 单 destination 请求并按原始索引重映射，POI URL 无引号编码', async () => {
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url)
      if (url.includes('/distance?')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: '1', results: [{ origin_id: '0', dest_id: '0', distance: '1000', duration: '60' }] }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: '1', pois: [] }) }
    }
    const adapter = new AmapAdapter({ fetchFn })
    const destinations = [
      { lng: 101.123456789, lat: 36.123456789, sys: 'GCJ02' as const },
      { lng: 102.987654321, lat: 37.987654321, sys: 'GCJ02' as const },
    ]
    const matrix = await adapter.distanceMatrix(
      [{ lng: 100.000000001, lat: 35.000000001, sys: 'GCJ02' }], destinations, { driving: true }, ENV,
    )
    const distanceUrls = urls.filter((url) => url.includes('/distance?'))
    expect(distanceUrls).toHaveLength(2)
    expect(distanceUrls.every((url) => new URL(url).searchParams.get('destination') !== null)).toBe(true)
    expect(distanceUrls.every((url) => !url.includes('destinations=') && !url.includes('%22'))).toBe(true)
    expect(matrix.pairs.map((pair) => pair.destinationIndex)).toEqual([0, 1])
    expect(new URL(distanceUrls[0]).searchParams.get('destination')).toBe('101.123457,36.123457')

    await adapter.poiSearch('“西湖” "断桥" 旅游', '330100', {}, ENV)
    const poiUrl = urls.find((url) => url.includes('/place/text?'))
    expect(poiUrl).toBeDefined()
    expect(poiUrl).not.toContain('%22')
    expect(new URL(poiUrl!).searchParams.get('keywords')).toBe('西湖 断桥 旅游')
  })

  it('缺 key、超配额、参数错误分别给出可读分类', async () => {
    const noKeyCalls: string[] = []
    const noKey = new AmapAdapter({ fetchFn: async (url) => { noKeyCalls.push(url); return { ok: true, status: 200, text: async () => '{}' } } })
    await expect(noKey.distanceMatrix([{ lng: 1, lat: 1, sys: 'GCJ02' }], [{ lng: 2, lat: 2, sys: 'GCJ02' }])).rejects.toMatchObject({ message: expect.stringContaining('Key 未配置') })
    expect(noKeyCalls).toHaveLength(0)

    const quota = new AmapAdapter({ quota: new QuotaCounter({ restLimit: 0 }), fetchFn: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
    await expect(quota.distanceMatrix([{ lng: 1, lat: 1, sys: 'GCJ02' }], [{ lng: 2, lat: 2, sys: 'GCJ02' }], {}, ENV)).rejects.toMatchObject({ message: expect.stringContaining('权限/配额') })

    const invalid = new AmapAdapter({ fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: '0', info: 'MISSING_REQUIRED_PARAMS', infocode: '20000' }) }) })
    await expect(invalid.distanceMatrix([{ lng: 1, lat: 1, sys: 'GCJ02' }], [{ lng: 2, lat: 2, sys: 'GCJ02' }], {}, ENV)).rejects.toMatchObject({
      message: expect.stringContaining('参数错误'),
    })
  })
})
