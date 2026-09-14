import { describe, expect, it, vi } from 'vitest'
import {
  DomainTokenBucket,
  type KeyResolutionEnv,
} from '../src/adapters/base.js'
import {
  ZHIHU_ACCESS_SECRET,
  ZhihuAdapter,
  type ZhihuApiItem,
  type ZhihuFetchInit,
  type ZhihuFetchResponse,
} from '../src/adapters/zhihu.js'
import {
  SearchAdapter,
  type HostSearchSource,
} from '../src/adapters/search.js'
import { tier2Channel } from '../src/orchestrator/channels.js'
import type { ResearchChannelContext } from '../src/orchestrator/types.js'

const SECRET = 'ZH_SECRET_SENTINEL_xxx'

interface FetchCall {
  url: string
  init?: ZhihuFetchInit
}

function keyEnv(secret = SECRET): KeyResolutionEnv {
  return { env: { [ZHIHU_ACCESS_SECRET]: secret } }
}

function response(body: unknown, calls: FetchCall[], status = 200, ok = true): (url: string, init?: ZhihuFetchInit) => Promise<ZhihuFetchResponse> {
  return async (url, init) => {
    calls.push({ url, init })
    return { ok, status, text: async () => JSON.stringify(body) }
  }
}

function adapterWith(body: unknown, calls: FetchCall[] = []): { adapter: ZhihuAdapter; calls: FetchCall[] } {
  const actualCalls = calls
  return {
    adapter: new ZhihuAdapter({
      fetchFn: response(body, actualCalls),
      rateLimiter: new DomainTokenBucket(),
    }),
    calls: actualCalls,
  }
}

function item(overrides: Partial<ZhihuApiItem> = {}): ZhihuApiItem {
  return {
    Title: '青甘旅行条目',
    ContentType: 'Article',
    ContentID: 'article-1',
    ContentText: '正文内容',
    Url: 'https://zhuanlan.zhihu.com/p/123456?utm_medium=openapi_platform&utm_source=caller&ref=keep',
    CommentCount: 7,
    VoteUpCount: 42,
    AuthorName: '作者甲',
    EditTime: 1700000000,
    AuthorityLevel: 'high',
    RankingScore: 0.92,
    ...overrides,
  }
}

function context(env: KeyResolutionEnv): ResearchChannelContext {
  return { deadlineMs: Date.now() + 20_000, budgetMs: 20_000, env }
}

describe('ZhihuAdapter official OpenAPI', () => {
  it('maps two items with full正文, metadata, timestamp, confidence, and clean UTM URL', async () => {
    const bodyText = `门票与路况正文段落：${'青甘环线实用信息。'.repeat(80)}`
    const calls: FetchCall[] = []
    const { adapter } = adapterWith({
      Code: 0,
      Message: 'ok',
      Data: {
        HasMore: false,
        SearchHashId: 'hash-1',
        Items: [
          item({ ContentType: 'Answer', ContentID: 'answer-1', ContentText: bodyText, Url: 'https://www.zhihu.com/question/1/answer/2?utm_medium=openapi_platform&utm_source=caller&ref=keep' }),
          item({ ContentType: 'Article', ContentID: 'article-2', ContentText: '住宿与交通正文', AuthorName: '作者乙', CommentCount: 3, VoteUpCount: 9, AuthorityLevel: 'normal', RankingScore: 0.2, EditTime: 1700000100 }),
        ],
      },
    }, calls)

    const result = await adapter.search('青甘大环线', { count: 2, sortBy: 'VoteUpCount:desc:(0,100)' }, keyEnv())

    expect(result.degraded).toEqual([])
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      id: 'zhihu:answer-1',
      title: '青甘旅行条目',
      summary: bodyText,
      author: '作者甲',
      metrics: { likes: 42, comments: 7 },
      publishedAt: '2023-11-14',
      confidence: 'high',
      source: {
        platform: 'zhihu-openapi',
        url: 'https://www.zhihu.com/question/1/answer/2?ref=keep',
      },
    })
    expect(result.items[0].summary.length).toBeGreaterThan(140)
    expect(result.items[0].content).toBe(bodyText)
    expect(result.items[1]).toMatchObject({
      id: 'zhihu:article-2',
      metrics: { likes: 9, comments: 3 },
      confidence: 'medium',
      source: { platform: 'zhihu-openapi' },
    })

    expect(calls).toHaveLength(1)
    const request = calls[0]
    const requestUrl = new URL(request.url)
    expect(requestUrl.searchParams.get('Query')).toBe('青甘大环线')
    expect(requestUrl.searchParams.get('Count')).toBe('2')
    expect(requestUrl.searchParams.get('SortBy')).toBe('VoteUpCount:desc:(0,100)')
    expect(request.init?.method).toBe('GET')
    expect(request.init?.headers?.['Content-Type']).toBe('application/json')
    expect(request.init?.headers?.Accept).toBe('application/json')
    expect(request.init?.headers?.['X-Request-Timestamp']).toMatch(/^\d{10}$/)
    expect(Number(request.init?.headers?.['X-Request-Timestamp'])).toBeGreaterThan(1_500_000_000)
    expect(request.init?.headers?.Authorization).toBe(`Bearer ${SECRET}`)
  })

  it('uses the existing classifier for ticket/lodging/warning content without recommend fallback', async () => {
    const { adapter } = adapterWith({
      Code: 0,
      Data: {
        Items: [
          item({ ContentID: 'ticket', Title: '开放平台条目一', ContentText: '门票 120 元，景区预约后入园。' }),
          item({ ContentID: 'stay', Title: '开放平台条目二', ContentText: '住宿推荐：湖边民宿入住方便。' }),
          item({ ContentID: 'warning', Title: '开放平台条目三', ContentText: '避雷：不要相信临时加价的司机。' }),
        ],
      },
    })

    const result = await adapter.search('青甘', {}, keyEnv())
    expect(result.items.map((entry) => entry.category)).toEqual(['attraction', 'lodging', 'warning'])
    expect(result.items.every((entry) => entry.category !== 'recommend')).toBe(true)
  })

  it.each([
    [20001, '鉴权失败'],
    [30001, '频率限制'],
    [10001, '参数错误'],
  ])('maps Code=%s to a distinct degraded category (%s)', async (code, label) => {
    const { adapter } = adapterWith({ Code: code, Message: SECRET, Data: { Items: [] } })
    const result = await adapter.search('青甘', {}, keyEnv())
    expect(result.items).toEqual([])
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'zhihu', code: 'UNAVAILABLE' })
    expect(result.degraded[0].reason).toContain(label)
    expect(result.degraded[0].reason).toContain(`Code=${code}`)
    console.log(`Code=${code} => ${result.degraded[0].reason}`)
  })

  it('without a key available() is false and search performs zero network calls', async () => {
    let calls = 0
    const adapter = new ZhihuAdapter({
      fetchFn: async () => {
        calls += 1
        return { ok: true, status: 200, text: async () => JSON.stringify({ Code: 0, Data: { Items: [] } }) }
      },
      rateLimiter: new DomainTokenBucket(),
    })
    const env: KeyResolutionEnv = { env: {} }
    await expect(adapter.available(env)).resolves.toBe(false)
    const result = await adapter.search('青甘', {}, env)
    expect(result.items).toEqual([])
    expect(result.degraded[0]?.reason).toContain('Key 未配置')
    expect(calls).toBe(0)
  })

  it('normalizes Count > 10 and Count <= 0 to 10 on the request', async () => {
    const calls: FetchCall[] = []
    const { adapter } = adapterWith({ Code: 0, Data: { Items: [item({ ContentText: '结果' })] } }, calls)
    await adapter.search('大查询', { count: 99 }, keyEnv())
    await adapter.search('小查询', { count: 0 }, keyEnv())
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0].url).searchParams.get('Count')).toBe('10')
    expect(new URL(calls[1].url).searchParams.get('Count')).toBe('10')
  })

  it('uses a short-TTL cache keyed by query, Count, and SortBy', async () => {
    const calls: FetchCall[] = []
    const { adapter } = adapterWith({ Code: 0, Data: { Items: [item({ ContentText: '缓存正文' })] } }, calls)
    const env = keyEnv()
    await adapter.search('缓存查询', { count: 2, sortBy: 'VoteUpCount:desc:(0,100)' }, env)
    await adapter.search('缓存查询', { count: 2, sortBy: 'VoteUpCount:desc:(0,100)' }, env)
    await adapter.search('缓存查询', { count: 3, sortBy: 'VoteUpCount:desc:(0,100)' }, env)
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0].url).searchParams.get('Count')).toBe('2')
    expect(new URL(calls[1].url).searchParams.get('Count')).toBe('3')
  })

  it('keeps Answer and Article as normal zhihu IntelItems and does not leak the secret', async () => {
    const calls: FetchCall[] = []
    const { adapter } = adapterWith({
      Code: 0,
      Data: {
        Items: [
          item({ ContentType: 'Answer', ContentID: 'a-1', Url: 'https://www.zhihu.com/question/1/answer/1?utm_source=api' }),
          item({ ContentType: 'Article', ContentID: 'p-1', Url: 'https://zhuanlan.zhihu.com/p/1?utm_medium=api' }),
        ],
      },
    }, calls)
    const result = await adapter.search('正文检索', {}, keyEnv())
    expect(result.items.map((entry) => entry.id)).toEqual(['zhihu:a-1', 'zhihu:p-1'])
    expect(result.items.every((entry) => entry.channel === 'zhihu')).toBe(true)

    const request = calls[0]
    const headers = request.init?.headers ?? {}
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`)
    const publicHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'Authorization'))
    const publicMaterial = JSON.stringify({ url: request.url, headers: publicHeaders, result })
    expect(publicMaterial).not.toContain(SECRET)
    expect(JSON.stringify(result.degraded)).not.toContain(SECRET)
    expect(result.items.every((entry) => !entry.source.url.includes(SECRET))).toBe(true)
  })
})

describe('tier2Channel Zhihu API primary and L0 fallback', () => {
  const fallbackHit: HostSearchSource = {
    url: 'https://zhuanlan.zhihu.com/p/998877',
    title: '知乎 L0 兜底标题',
    snippet: '仅标题摘要',
  }

  function searchWithHost(hostCalls: string[], fetchHtmlCalls: string[] = []): SearchAdapter {
    return new SearchAdapter({
      hostSearch: async (query) => {
        hostCalls.push(query)
        return { sources: [fallbackHit], truncated: false }
      },
      fetchHtml: async (url) => {
        fetchHtmlCalls.push(url)
        throw new Error('知乎旧 L0.5 直抓不应被调用')
      },
    })
  }

  it('uses Zhihu API as the primary path and does not call Zhihu L0 when API returns items', async () => {
    const hostCalls: string[] = []
    const apiCalls: FetchCall[] = []
    const search = searchWithHost(hostCalls)
    const l0Search = vi.spyOn(search, 'searchL0')
    const { adapter } = adapterWith({ Code: 0, Data: { Items: [item({ ContentID: 'api-1', ContentText: 'API 正文证据' })] } }, apiCalls)
    const channel = tier2Channel(search, adapter)
    const result = await channel.run({ destination: '青甘大环线' }, context(keyEnv()))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.items.some((entry) => entry.id === 'zhihu:api-1' && entry.summary === 'API 正文证据')).toBe(true)
      expect(result.items.every((entry) => entry.channel === 'zhihu')).toBe(true)
    }
    expect(apiCalls).toHaveLength(1)
    expect(hostCalls).toEqual([])
    expect(l0Search).not.toHaveBeenCalled()
  })

  it('falls back to Zhihu L0 when the API is rate-limited and retains the classified degraded reason', async () => {
    const hostCalls: string[] = []
    const oldDirectFetches: string[] = []
    const apiCalls: FetchCall[] = []
    const search = searchWithHost(hostCalls, oldDirectFetches)
    const l0Search = vi.spyOn(search, 'searchL0')
    const { adapter } = adapterWith({ Code: 30001, Message: 'rate limited', Data: { Items: [] } }, apiCalls)
    const channel = tier2Channel(search, adapter)
    const result = await channel.run({ destination: '青甘大环线' }, context(keyEnv()))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.items.some((entry) => entry.id === 'l0:998877')).toBe(true)
      expect(result.items.every((entry) => entry.channel === 'zhihu')).toBe(true)
    }
    expect(result.degraded?.some((entry) => entry.reason.includes('频率限制'))).toBe(true)
    expect(apiCalls).toHaveLength(1)
    expect(hostCalls).toContain('青甘大环线 旅行 攻略 避雷 site:zhihu.com')
    expect(l0Search.mock.calls.every(([request]) => request.sites?.[0] === 'zhihu.com')).toBe(true)
    expect(oldDirectFetches).toEqual([])
  })

  it('falls back to Zhihu L0 without an API key and makes no API request', async () => {
    const hostCalls: string[] = []
    const apiCalls: FetchCall[] = []
    const search = searchWithHost(hostCalls)
    const l0Search = vi.spyOn(search, 'searchL0')
    const { adapter } = adapterWith({ Code: 0, Data: { Items: [] } }, apiCalls)
    const channel = tier2Channel(search, adapter)
    const result = await channel.run({ destination: '青甘大环线' }, context({ env: {} }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.items.some((entry) => entry.id === 'l0:998877')).toBe(true)
      expect(result.items.every((entry) => entry.channel === 'zhihu')).toBe(true)
    }
    expect(apiCalls).toEqual([])
    expect(hostCalls).toContain('青甘大环线 旅行 攻略 避雷 site:zhihu.com')
    expect(l0Search.mock.calls.every(([request]) => request.sites?.[0] === 'zhihu.com')).toBe(true)
  })
})
