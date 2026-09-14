/**
 * 检索适配器单测（M1 T3 / W2a）：L0 宿主搜索去重 + L0.5 直抓三源 + 铁律。
 *
 * 铁律（learnings 行 27/28）验证：
 * - 去重键 = URL 路径段笔记 ID，非 URL 全串（同笔记不同 xsec_token → 1 条）
 * - 命中即抓、缓存抓取结果而非 URL（同 ID 二次调用命中缓存，不发网络请求）
 * - 无 token explore URL → 404「页面不见了」→ UNAVAILABLE，单次尝试不重试
 * fixture：xhs-explore.html = 2026-09-02 真实录制（脱敏：token 置空/图链清空，
 *   含裸 undefined 分支验证容错解析）；zhihu = 环境风控下按平台公开 SSR
 *   形态构造（provenance 见 tests/fixtures/search/provenance.md）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EngineError, toDegraded } from '../src/adapters/base.js'
import {
  SearchAdapter, classifyIntelCategory, cleanUndefinedTokens, dedupeL0Hits,
  classifyPlatform, extractNoteId, l0HitToIntelItem, parseXhsExplore, redactSensitiveText,
  redactSensitiveUrl,
  toL0Hit,
  parseZhihuZhuanlan, socialPostToIntelItem, stripHtmlTags,
  type HostSearchFn, type HostSearchSource,
} from '../src/adapters/search.js'
import { validateIntelItem } from '../src/models/validate.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/search/${name}`, import.meta.url), 'utf8')
}

/** 构造 hostSearch mock：按查询返回 sources（记录调用）。 */
function mockHostSearch(byQuery: Record<string, HostSearchSource[]>): { fn: HostSearchFn; calls: string[] } {
  const calls: string[] = []
  const fn: HostSearchFn = async (query) => {
    calls.push(query)
    return { sources: byQuery[query] ?? [], truncated: false }
  }
  return { fn, calls }
}

function src(url: string, title?: string, snippet?: string): HostSearchSource {
  return { url, title, snippet }
}

describe('L0 宿主搜索：site: 构造 / 分类 / 去重（URL 路径笔记 ID ≠ URL 全串）', () => {
  it('多查询变体 + 笔记 ID 去重 → 无 URL 全串重复', async () => {
    const q = '杭州旅游攻略'
    const xhsA1 = src(`https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=TOKEN_A1&xsec_source=`, '西湖手划船秘籍', 'snippet A')
    const xhsA2 = src(`https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=TOKEN_A2&xsec_source=`, '西湖手划船秘籍（同笔记不同 token）')
    const xhsB = src(`https://www.xiaohongshu.com/explore/63f1f2f1000000001a000001?xsec_token=TOKEN_B&xsec_source=`, '夏天的西湖就是一幅油画')
    const zhihu = src('https://zhuanlan.zhihu.com/p/670415069', '杭州三日游全攻略')
    const douyin = src('https://www.douyin.com/note/7291486515627214882', '杭州旅行日记')
    const web = src('https://example.com/hangzhou-guide', '头条第三方攻略')

    const { fn, calls } = mockHostSearch({
      [`${q} site:xiaohongshu.com`]: [xhsA1, xhsA2, xhsB],
      [`${q} site:zhihu.com`]: [zhihu],
      [q]: [zhihu, douyin, web],
    })
    const adapter = new SearchAdapter({ hostSearch: fn })
    const result = await adapter.searchL0({ keywords: q, sites: ['xiaohongshu.com', 'zhihu.com'] })

    // 查询形态：每站 site: 变体 + 裸关键词（site: 尽力而为非硬过滤）
    expect(calls).toEqual([
      `${q} site:xiaohongshu.com`,
      `${q} site:zhihu.com`,
      q,
    ])
    // 去重后 hits
    const hits = result.data.hits
    const byId = new Map(hits.map((h) => [h.id, h]))
    // 同笔记不同 token → 仅 1 条（id=路径段笔记 ID）
    expect(hits.filter((h) => h.platform === 'xhs')).toHaveLength(2)
    expect(byId.get('644b887b0000000013012f14')?.url).toBe('https://www.xiaohongshu.com/explore/644b887b0000000013012f14')
    expect(byId.get('644b887b0000000013012f14')?.url).not.toContain('TOKEN_A1')
    expect(byId.get('63f1f2f1000000001a000001')).toBeDefined()
    // 无 URL 全串重复（铁律）
    const urls = hits.map((h) => h.url)
    expect(new Set(urls).size).toBe(urls.length)
    // 去重键 = 路径段：zhihu /p/<id>、douyin 数字
    expect(byId.get('670415069')?.platform).toBe('zhihu')
    expect(byId.get('7291486515627214882')?.platform).toBe('douyin')
    expect(hits.find((h) => h.platform === 'web')?.id).toMatch(/^web:[0-9a-f]{40}$/) // 无 ID → sha1 URL 键，无斜杠
    // 查询记录可追溯
    expect(result.data.queries).toEqual(calls)
  })

  it('L0 宿主未注入 → EngineError.UNAVAILABLE；无命中 → EMPTY', async () => {
    const noHost = new SearchAdapter()
    await expect(noHost.available()).resolves.toBe(false)
    await expect(noHost.searchL0({ keywords: '西湖' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    const { fn } = mockHostSearch({ '西湖': [] })
    const adapter = new SearchAdapter({ hostSearch: fn })
    await expect(adapter.searchL0({ keywords: '西湖' })).rejects.toMatchObject({ code: 'EMPTY' })
  })

  it('L0 → IntelItem：channel 映射 / confidence low / publishedAt 取日期', () => {
    const hit = dedupeL0Hits([{
      id: '644b887b0000000013012f14', platform: 'xhs', title: '西湖手划船秘籍',
      summary: '8个码头', url: 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=T',
      publishedAt: '2023-04-29T12:00:00.000Z',
      source: { platform: 'host-search:xhs', url: 'u', fetchedAt: '2026-09-02T00:00:00.000Z' },
    }])[0]
    const item = l0HitToIntelItem(hit)
    expect(item).toMatchObject({
      id: 'l0:644b887b0000000013012f14', channel: 'xhs-l0', confidence: 'low',
      publishedAt: '2023-04-29',
    })
    expect(validateIntelItem(item)).toEqual([])
  })

  it('去重/ID 工具纯函数', () => {
    expect(extractNoteId('https://www.xiaohongshu.com/explore/abc123?xsec_token=x')).toBe('abc123')
    expect(extractNoteId('https://www.xiaohongshu.com/discovery/item/abc123')).toBe('abc123')
    expect(extractNoteId('https://zhuanlan.zhihu.com/p/670415069')).toBe('670415069')
    expect(extractNoteId('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeUndefined()
    expect(extractNoteId('https://www.douyin.com/shipin/7291486515627214882')).toBe('7291486515627214882')
    expect(extractNoteId('https://example.com/x')).toBeUndefined()
    const deduped = dedupeL0Hits([
      { id: 'a', platform: 'xhs', title: 't', url: 'https://www.xiaohongshu.com/explore/AAA?xsec_token=1', source: { platform: 'p', url: 'u', fetchedAt: '2026-01-01T00:00:00.000Z' } },
      { id: 'a', platform: 'xhs', title: 't2', url: 'https://www.xiaohongshu.com/explore/AAA?xsec_token=2', source: { platform: 'p', url: 'u2', fetchedAt: '2026-01-01T00:00:00.000Z' } },
    ])
    expect(deduped).toHaveLength(1)
  })

  it('分类启发：避雷→warning / 美食→food / 攻略→recommend', () => {
    expect(classifyIntelCategory('杭州避雷贴', '全是坑')).toBe('warning')
    expect(classifyIntelCategory('西湖美食指南', '吃什么')).toBe('food')
    expect(classifyIntelCategory('西湖三日游攻略', '路线')).toBe('recommend')
  })
})

describe('L0.5 小红书 explore：SSR 解析 + 铁律', () => {
  it('真实录制 fixture → 正文结构化条目（desc/nickname/time/互动字段名固定）', async () => {
    const html = fixture('xhs-explore.html')
    const adapter = new SearchAdapter({
      fetchHtml: async () => ({ status: 200, text: html }),
    })
    const url = 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=LIVE_TOKEN&xsec_source='
    const result = await adapter.fetchXhsNote(url)
    expect(result.cached).toBe(false)
    const post = result.post
    expect(post.noteId).toBe('644b887b0000000013012f14')
    expect(post.platform).toBe('xhs')
    expect(post.title).toBe('五一畅游西湖 | 手划（摇橹）船乘坐秘籍来了～')
    expect(post.content).toContain('手划（摇橹）船')
    expect(post.content).toContain('8个码头')
    expect(post.content).toContain('150元每小时')
    expect(post.author).toBe('无忧掌上西湖')
    expect(post.publishedAt).toBe(new Date(1682739009000).toISOString())
    expect(post.interactions).toEqual({ likes: 40, collects: 59, comments: 22, shares: 31 })
    // 规范化 URL：xsec_token 剥除（token 零明文落库）
    expect(post.url).toBe('https://www.xiaohongshu.com/explore/644b887b0000000013012f14')
    expect(post.url).not.toContain('xsec_token')
    expect(post.fetchedAt).toMatch(/^20\d\d-\d\d-\d\dT/)
  })

  it('缓存抓取结果而非 URL：同笔记 ID 二次调用（不同 token URL）命中缓存不发网络', async () => {
    const html = fixture('xhs-explore.html')
    let networkCalls = 0
    const adapter = new SearchAdapter({
      fetchHtml: async () => { networkCalls++; return { status: 200, text: html } },
    })
    const url1 = 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=TOKEN_A'
    const url2 = 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=TOKEN_B'
    const first = await adapter.fetchXhsNote(url1)
    expect(first.cached).toBe(false)
    const second = await adapter.fetchXhsNote(url2)
    expect(second.cached).toBe(true)
    expect(second.post).toEqual(first.post)
    expect(networkCalls).toBe(1) // 缓存命中 → 无第二次抓取
    adapter.clearCache()
    await adapter.fetchXhsNote(url1)
    expect(networkCalls).toBe(2) // 清缓存后重新抓取
  })

  it('缓存命中前校验 XHS host/path 与敏感 query：canonical/valid token 可命中，恶意或占位 URL 不得绕过', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN_VALID`
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async () => ({ sources: [src(validUrl, 'fresh')], truncated: false }),
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    expect((await adapter.fetchXhsNote(validUrl)).cached).toBe(false)
    expect((await adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`)).cached).toBe(true)
    expect((await adapter.fetchXhsNote(validUrl)).cached).toBe(true)

    const bypassUrls = [
      `https://evil.example/explore/${noteId}?xsec_token=TOKEN_VALID`,
      `https://www.xiaohongshu.com/explore/${noteId}/extra?xsec_token=TOKEN_VALID`,
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=feed`,
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=`,
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=%5BREDACTED%5D`,
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=Bearer%20%5BREDACTED%5D`,
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=%255BREDACTED%255D`,
    ]
    for (const bypassUrl of bypassUrls) {
      const result = await adapter.fetchXhsNote(bypassUrl)
      expect(result.cached, bypassUrl).toBe(false)
    }
    expect(fetchedUrls).toHaveLength(1 + bypassUrls.length)
    expect(fetchedUrls.every((url) => url === validUrl)).toBe(true)
  })

  it('普通/unknown query 不得读取旧缓存，继续使用已有 resolver fresh URL', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN_VALID`
    const queryUrls = [
      `https://www.xiaohongshu.com/explore/${noteId}?utm_source=feed`,
      `https://www.xiaohongshu.com/explore/${noteId}?foo=tokenvalue`,
    ]
    const hostCalls: string[] = []
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async (query) => {
        hostCalls.push(query)
        return { sources: [src(validUrl, 'fresh')], truncated: false }
      },
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    await adapter.searchL0({ keywords: '西湖安全游记' })
    expect((await adapter.fetchXhsNote(validUrl)).cached).toBe(false)
    for (const queryUrl of queryUrls) {
      const result = await adapter.fetchXhsNote(queryUrl)
      expect(result.cached, queryUrl).toBe(false)
    }
    expect(hostCalls).toEqual(['西湖安全游记'])
    expect(fetchedUrls).toEqual([validUrl, validUrl, validUrl])
  })

  it('L0 discovery → canonical URL 经内存 resolver 使用 fresh token；随后缓存命中仍不暴露 token', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const secret = 'SYNTHETIC_SECRET'
    const rawUrl = `https://www.xiaohongshu.com/explore/${noteId}?access_token=${secret}&xsec_source=feed`
    const hostCalls: string[] = []
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async (query) => {
        hostCalls.push(query)
        return { sources: [src(rawUrl, '西湖安全游记', `摘要?refresh_token=${secret}`)], truncated: false }
      },
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    const discovery = await adapter.searchL0({ keywords: '西湖安全游记' })
    const discovered = discovery.data.hits[0]!
    expect(discovered.url).not.toContain(secret)
    expect(discovered.source.url).not.toContain(secret)
    expect(discovered.title).not.toContain(secret)
    expect(discovered.summary).not.toContain(secret)

    const fresh = await adapter.fetchXhsNote(discovered.url)
    expect(fresh.cached).toBe(false)
    expect(fetchedUrls).toEqual([rawUrl])
    expect(fresh.post.url).toBe(`https://www.xiaohongshu.com/explore/${noteId}`)
    expect(fresh.post.url).not.toContain(secret)

    const cached = await adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`)
    expect(cached.cached).toBe(true)
    expect(hostCalls).toEqual(['西湖安全游记'])
    expect(fetchedUrls).toHaveLength(1)
  })

  it('重启新 SearchAdapter：canonical URL resolver miss → 按 noteId 只搜一次并校验同 host/path', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const secret = 'SYNTHETIC_SECRET'
    const rawUrl = `https://www.xiaohongshu.com/explore/${noteId}?refresh_token=${secret}`
    const searchCalls: string[] = []
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async (query) => {
        searchCalls.push(query)
        return { sources: [src(rawUrl, 'fresh')], truncated: false }
      },
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })
    const result = await adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`)
    expect(result.cached).toBe(false)
    expect(searchCalls).toEqual([noteId])
    expect(fetchedUrls).toEqual([rawUrl])
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('direct source-only URL 复用已有 resolver credential，而不是直抓 source-only', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN_VALID&xsec_source=feed`
    const sourceOnlyUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=feed`
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async () => ({
        sources: [src(validUrl, 'valid'), src(sourceOnlyUrl, 'source-only')],
        truncated: false,
      }),
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    await adapter.searchL0({ keywords: '西湖安全游记' })
    await expect(adapter.fetchXhsNote(sourceOnlyUrl)).resolves.toMatchObject({ cached: false })
    expect(fetchedUrls).toEqual([validUrl])
  })

  it('direct redacted URL 不被当作 credential，fresh 补搜后抓有效 token', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const redactedUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=%5BREDACTED%5D`
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?access_token=SYNTHETIC_SECRET`
    const searchCalls: string[] = []
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async (query) => {
        searchCalls.push(query)
        return { sources: [src(validUrl, 'fresh')], truncated: false }
      },
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    const result = await adapter.fetchXhsNote(redactedUrl)
    expect(result.cached).toBe(false)
    expect(searchCalls).toEqual([noteId])
    expect(fetchedUrls).toEqual([validUrl])
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
  })

  it('direct/remember 都拒绝 Bearer 编码占位符并保留有效 resolver URL', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN_VALID&xsec_source=feed`
    const placeholderUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=Bearer%20%5BREDACTED%5D`

    const createAdapter = () => {
      const fetchedUrls: string[] = []
      const adapter = new SearchAdapter({
        hostSearch: async () => ({
          sources: [src(validUrl, 'valid'), src(placeholderUrl, 'redacted')],
          truncated: false,
        }),
        fetchHtml: async (url) => {
          fetchedUrls.push(url)
          return { status: 200, text: html }
        },
      })
      return { adapter, fetchedUrls }
    }

    const remembered = createAdapter()
    await remembered.adapter.searchL0({ keywords: '西湖安全游记' })
    await expect(remembered.adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`))
      .resolves.toMatchObject({ cached: false })
    expect(remembered.fetchedUrls).toEqual([validUrl])

    const direct = createAdapter()
    await direct.adapter.searchL0({ keywords: '西湖安全游记' })
    await expect(direct.adapter.fetchXhsNote(placeholderUrl)).resolves.toMatchObject({ cached: false })
    expect(direct.fetchedUrls).toEqual([validUrl])
  })

  it('direct source-only 无 resolver 时 honest UNAVAILABLE 且零直抓', async () => {
    const noteId = '644b887b0000000013012f14'
    const sourceOnlyUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=feed`
    let fetchCalls = 0
    const adapter = new SearchAdapter({
      fetchHtml: async () => {
        fetchCalls += 1
        return { status: 200, text: fixture('xhs-explore.html') }
      },
    })

    await expect(adapter.fetchXhsNote(sourceOnlyUrl)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(fetchCalls).toBe(0)
  })

  it('resolver 不把 source-only 结果覆盖已有 xsec_token URL', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN_VALID&xsec_source=feed`
    const sourceOnlyUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=feed`
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async () => ({
        sources: [src(validUrl, 'valid'), src(sourceOnlyUrl, 'source-only')],
        truncated: false,
      }),
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    await adapter.searchL0({ keywords: '西湖安全游记' })
    await expect(adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`)).resolves.toMatchObject({ cached: false })
    expect(fetchedUrls).toEqual([validUrl])
  })

  it('resolver 补搜跳过 source-only 与编码占位符，继续选择后续同 noteId 的 xsec_token URL', async () => {
    const html = fixture('xhs-explore.html')
    const noteId = '644b887b0000000013012f14'
    const sourceOnlyUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=feed`
    const redactedUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=Bearer%20%5BREDACTED%5D`
    const validUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN_VALID`
    const fetchedUrls: string[] = []
    const adapter = new SearchAdapter({
      hostSearch: async () => ({
        sources: [src(sourceOnlyUrl, 'source-only'), src(redactedUrl, 'redacted'), src(validUrl, 'valid')],
        truncated: false,
      }),
      fetchHtml: async (url) => {
        fetchedUrls.push(url)
        return { status: 200, text: html }
      },
    })

    await expect(adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`)).resolves.toMatchObject({ cached: false })
    expect(fetchedUrls).toEqual([validUrl])
  })

  it('resolver 仅有 source-only 或各类占位符时 honest UNAVAILABLE 且不直抓', async () => {
    const noteId = '644b887b0000000013012f14'
    const sourceOnlyUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_source=feed`
    const placeholderUrls = [
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=%20%20`,
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=Bearer%20%5BREDACTED%5D`,
      `https://www.xiaohongshu.com/explore/${noteId}?access_token=%3Credacted%3E`,
      `https://www.xiaohongshu.com/explore/${noteId}?refresh_token=%20Bearer%20ReDaCtEd%20`,
      `https://www.xiaohongshu.com/explore/${noteId}?token=%20%5Bredacted%5D%20`,
    ]

    for (const placeholderUrl of placeholderUrls) {
      let fetchCalls = 0
      const adapter = new SearchAdapter({
        hostSearch: async () => ({
          sources: [src(sourceOnlyUrl, 'source-only'), src(placeholderUrl, 'redacted')],
          truncated: false,
        }),
        fetchHtml: async () => {
          fetchCalls += 1
          return { status: 200, text: fixture('xhs-explore.html') }
        },
      })

      await expect(adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect(fetchCalls).toBe(0)
    }
  })

  it('resolver fresh URL 无同 noteId/受信 host → honest UNAVAILABLE 且不直抓', async () => {
    const noteId = '644b887b0000000013012f14'
    let fetchCalls = 0
    const adapter = new SearchAdapter({
      hostSearch: async () => ({
        sources: [
          src(`https://evil.example/explore/${noteId}?access_token=SYNTHETIC_SECRET`, 'evil'),
          src(`https://www.xiaohongshu.com/explore/other-note?access_token=SYNTHETIC_SECRET`, 'wrong'),
        ],
        truncated: false,
      }),
      fetchHtml: async () => {
        fetchCalls += 1
        return { status: 200, text: fixture('xhs-explore.html') }
      },
    })
    await expect(adapter.fetchXhsNote(`https://www.xiaohongshu.com/explore/${noteId}`))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(fetchCalls).toBe(0)
  })

  it('统一 sanitizer 覆盖普通/编码 query key、值分隔符与非法 id，且不破坏普通文本与 query', () => {
    const secret = 'SYNTHETIC_SECRET'
    const keys = [
      'access_token', 'refresh_token', 'xsec_token', 'xsec_source', 'token', 'secret', 'credential',
      'authorization', 'api_key', 'client_secret', 'accessToken', 'refreshToken', 'apiKey',
      'oauth_token', 'auth_token', 'secret_key', 'authToken', 'clientSecret', 'xsecSource',
      'oauth-token', 'auth-token', 'secret-key', 'x-api-key', 'x_api_key',
      'oauth%5Ftoken', 'auth%5Ftoken', 'secret%5Fkey', 'auth%54oken', 'client%53ecret',
      '%74oken', 'client%5Fsecret', 'access%54oken', 'refresh%54oken', 'api%4Bey',
    ]
    for (const key of keys) {
      const text = `keep ?${key}=${secret} and ?ordinary=visible`
      expect(redactSensitiveText(text)).not.toContain(secret)
      expect(redactSensitiveUrl(`https://example.com/a?${key}=${secret}&ordinary=visible`)).not.toContain(secret)
    }
    for (const text of [
      '?access_token=)SYNTHETIC_SECRET',
      '?authorization=Bearer SYNTHETIC_SECRET',
      'bad/id?xsec_token=)SYNTHETIC_SECRET&access_token=Bearer SYNTHETIC_SECRET',
    ]) {
      expect(redactSensitiveText(text)).not.toContain(secret)
      expect(redactSensitiveUrl(`https://example.com/a${text.slice(text.indexOf('?'))}`)).not.toContain(secret)
    }
    expect(redactSensitiveText('ordinary token-like sentence without a query remains')).toBe('ordinary token-like sentence without a query remains')
    expect(redactSensitiveText('ordinary id-like input bad/id remains')).toBe('ordinary id-like input bad/id remains')
    const ordinaryQuery = '?tokenizer=visible&secretary=visible&ordinary=visible&apiary=visible'
    expect(redactSensitiveText(ordinaryQuery)).toBe(ordinaryQuery)
    expect(redactSensitiveUrl(`https://example.com/a${ordinaryQuery}`)).toBe(`https://example.com/a${ordinaryQuery}`)
    expect(redactSensitiveUrl('https://example.com/a?ordinary=visible')).toBe('https://example.com/a?ordinary=visible')
    expect(redactSensitiveText('?%E0%A4%A=ordinary')).toBe('?%E0%A4%A=ordinary')
    const userInfo = 'https://' + 'user:pass@example.com/a?x-api-key=SECRET&ok=1#token=HASH'
    const redacted = redactSensitiveUrl(userInfo)
    expect(redacted).not.toContain('user:pass@')
    expect(redacted).not.toContain('SECRET')
    expect(redacted).not.toContain('HASH')
    expect(redactSensitiveUrl('https://example.com/a?ok=1;api_key=SECRET')).not.toContain('SECRET')
    expect(redactSensitiveUrl('//user:pass@evil.example/a?x-api-key=SECRET')).not.toContain('SECRET')
  })

  it('错误与正文持久化路径：复合/驼峰 query key 不泄漏 synthetic secret', async () => {
    const secret = 'SYNTHETIC_SECRET'
    const noteId = 'syntheticnote1'
    const state = {
      note: {
        noteDetailMap: {
          [noteId]: {
            note: {
              title: `标题?apiKey=${secret}`,
              desc: `正文?client_secret=${secret}&ordinary=visible`,
              user: { nickname: '测试用户' },
              interactInfo: { likedCount: '0' },
            },
          },
        },
      },
    }
    const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)}</script>`
    const adapter = new SearchAdapter({
      fetchHtml: async () => ({ status: 200, text: html }),
    })
    const result = await adapter.fetchXhsNote(
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN`,
    )
    expect(result.post.content).toContain('ordinary=visible')
    expect(result.post.content).not.toContain(secret)
    expect(result.post.title).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)

    const failing = new SearchAdapter({
      fetchHtml: async () => { throw new Error(`upstream failed ?accessToken=${secret}`) },
    })
    try {
      await failing.fetchXhsNote(
        `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=TOKEN`,
      )
      expect.unreachable('应当抛出已脱敏的 EngineError')
    } catch (err) {
      expect(String(err)).not.toContain(secret)
      expect(JSON.stringify(err)).not.toContain(secret)
    }
  })

  it('扩展公共 sanitizer 不扩大 XHS credential 白名单', async () => {
    const noteId = 'syntheticnote2'
    let fetchCalls = 0
    const adapter = new SearchAdapter({
      fetchHtml: async () => {
        fetchCalls += 1
        return { status: 200, text: fixture('xhs-explore.html') }
      },
    })
    for (const query of [
      'accessToken=SYNTHETIC_SECRET', 'oauth_token=SYNTHETIC_SECRET', 'auth_token=SYNTHETIC_SECRET',
      'secret_key=SYNTHETIC_SECRET', 'authToken=SYNTHETIC_SECRET', 'xsecSource=feed', 'xsec_source=feed',
    ]) {
      await expect(adapter.fetchXhsNote(
        `https://www.xiaohongshu.com/explore/${noteId}?${query}`,
      )).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
    expect(fetchCalls).toBe(0)
  })

  it('无 token / URL 失效 → 404 → EngineError.UNAVAILABLE，单次尝试不重试轰炸', async () => {
    let networkCalls = 0
    const adapter = new SearchAdapter({
      fetchHtml: async () => { networkCalls++; return { status: 404, text: '<html>404</html>' } },
    })
    try {
      await adapter.fetchXhsNote('https://www.xiaohongshu.com/explore/5f6f2f10000000001a000001?xsec_token=STALE')
      expect.unreachable('应当抛 EngineError')
    } catch (err) {
      const engine = err as EngineError
      expect(engine).toBeInstanceOf(EngineError)
      expect(engine.code).toBe('UNAVAILABLE')
      expect(engine.message).toContain('404')
      const entry = toDegraded('search-l0.5', engine)
      expect(entry).toMatchObject({ source: 'search-l0.5', code: 'UNAVAILABLE' })
    }
    expect(networkCalls).toBe(1) // 铁律：不重试
  })

  it('200 + 「页面不见了」404 shell → UNAVAILABLE（xsec_token 必需）', async () => {
    const adapter = new SearchAdapter({
      fetchHtml: async () => ({ status: 200, text: '小红书 - 你访问的页面不见了' }),
    })
    await expect(adapter.fetchXhsNote('https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=X'))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('mock 超时 → TIMEOUT → degraded', async () => {
    const adapter = new SearchAdapter({
      fetchHtml: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) },
    })
    try {
      await adapter.fetchXhsNote('https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=X')
      expect.unreachable()
    } catch (err) {
      const engine = err as EngineError
      expect(engine.code).toBe('TIMEOUT')
      expect(toDegraded('search-l0.5', engine).code).toBe('TIMEOUT')
    }
  })

  it('容错解析工具：裸 undefined → null；SSR 提取', () => {
    expect(JSON.parse(cleanUndefinedTokens('{"a":undefined,"b":1}'))).toEqual({ a: null, b: 1 })
    expect(JSON.parse(cleanUndefinedTokens('{"a":[undefined],"b":undefined}'))).toEqual({ a: [null], b: null })
  })

  it('持久化 URL 脱敏：xsec/token/secret 查询参数移除，普通 URL 保持', () => {
    const unsafe = redactSensitiveUrl('https://www.xiaohongshu.com/explore/n1?xsec_token=T&xsec_source=s&foo=1')
    expect(unsafe).not.toContain('xsec_token')
    expect(unsafe).not.toContain('xsec_source')
    expect(unsafe).toContain('foo=1')
    expect(redactSensitiveUrl('https://example.com/a?foo=1')).toBe('https://example.com/a?foo=1')
    expect(toL0Hit({ url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=SECRET_TOKEN' }).title)
      .not.toContain('SECRET_TOKEN')
  })

  it('toL0Hit 容忍宿主 seam 的非字符串字段（null/数字）不抛错（2026-09-12 复跑实测缺陷）', () => {
    // 回归：宿主 seam 属不受信外部 JSON。实测 SearXNG 桥接返回 title=null →
    // 旧实现 redactSensitiveText(null).replace 抛 TypeError → 整轮 L0 搜索失败（通道级降级）。
    const hostile = {
      url: 'https://example.invalid/a',
      title: null as unknown as string,
      snippet: 42 as unknown as string,
      publishedAt: null as unknown as string,
    }
    const hit = toL0Hit(hostile)
    expect(hit.id).toMatch(/^web:[0-9a-f]{40}$/)
    expect(hit.title).toBe('https://example.invalid/a') // 非字符串 → 按缺席处理，回落 safeUrl
    expect(hit.summary).toBeUndefined()
    expect(hit.publishedAt).toBeUndefined()
    // 正常字符串仍照常脱敏
    const ok = toL0Hit({ url: 'https://example.invalid/b', title: 't?token=SECRET', snippet: 's', publishedAt: '2026-09-01' })
    expect(ok.title).not.toContain('SECRET')
    expect(ok.publishedAt).toBe('2026-09-01')
  })

  it('L0.5 → IntelItem：channel/confidence/互动摘要/publishedAt（validateIntelItem 过）', () => {
    const html = fixture('xhs-explore.html')
    const post = parseXhsExplore(html, '644b887b0000000013012f14', 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=T')
    const item = socialPostToIntelItem(post)
    expect(item).toMatchObject({
      id: 'xhs:644b887b0000000013012f14', channel: 'xhs-l0', confidence: 'medium',
      publishedAt: '2023-04-29',
    })
    expect(item.summary).not.toMatch(/作者：|互动：/)
    expect(item.summary).toContain('荡荡悠悠')
    expect(item.author).toBe('无忧掌上西湖')
    expect(item.metrics).toMatchObject({ likes: 40, collects: 59 })
    expect(item.content).toContain('手划船')
    expect(item.source.url).not.toContain('xsec_token')
    expect(validateIntelItem(item)).toEqual([])
  })

  it('stripHtmlTags 工具（标签→空格折叠）', () => {
    expect(stripHtmlTags('<p>西湖<strong>手划船</strong></p>')).toBe('西湖 手划船')
  })
})

describe('L0.5 知乎专栏（SSR 块）', () => {
  it('知乎专栏 js-initialData → 结构化条目', () => {
    const post = parseZhihuZhuanlan(fixture('zhihu-zhuanlan.html'), '670415069', 'https://zhuanlan.zhihu.com/p/670415069')
    expect(post.platform).toBe('zhihu')
    expect(post.noteId).toBe('670415069')
    expect(post.title).toContain('杭州旅游全攻略')
    expect(post.content).toContain('西湖手划船')
    expect(post.content).toContain('凤起路')
    expect(post.author).toBe('杭漂老张')
    expect(post.publishedAt).toBe(new Date(1735689600000).toISOString())
    expect(post.interactions).toEqual({ likes: 128, comments: 36 })
    expect(post.url).toBe('https://zhuanlan.zhihu.com/p/670415069')
  })

  it('知乎无正文 → EngineError.EMPTY', () => {
    expect(() => parseZhihuZhuanlan('<html><body>验证</body></html>', '1', 'https://zhuanlan.zhihu.com/p/1'))
      .toThrowError(expect.objectContaining({ code: 'EMPTY' }))
  })

  it('退役视频平台 URL 不再识别为专用平台或笔记 ID', () => {
    const url = 'https://www.bilibili.com/video/BV1GJ411x7h7'
    expect(classifyPlatform(url)).toBe('web')
    expect(extractNoteId(url)).toBeUndefined()
  })

  it('退役视频平台不暴露 L0.5 专用抓取/解析入口', async () => {
    const adapter = new SearchAdapter()
    expect('fetchBilibiliVideo' in adapter).toBe(false)
    const searchModule: Record<string, unknown> = await import('../src/adapters/search.js')
    expect('parseBilibiliVideo' in searchModule).toBe(false)
  })

  it('知乎直抓 403 风控 → UNAVAILABLE（单次尝试）', async () => {
    let calls = 0
    const adapter = new SearchAdapter({
      fetchHtml: async () => { calls++; return { status: 403, text: 'forbidden' } },
    })
    await expect(adapter.fetchZhihuZhuanlan('https://zhuanlan.zhihu.com/p/670415069')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(calls).toBe(1)
  })
})

describe('R-6 日期诚实：SSR 无显式时间字段绝不拿抓取时刻冒充发布（E）', () => {
  /** 不带 time 的高仿 xhs explore SSR（noteMap/note 结构对齐生产；desc 非空）。 */
  function noDateXhsHtml(): string {
    const state = {
      user: { loggedIn: false },
      note: {
        currentNoteId: '644b887b0000000013012f14',
        noteDetailMap: {
          '644b887b0000000013012f14': {
            id: '644b887b0000000013012f14',
            note: {
              type: 'normal',
              title: '无发布时间的手记',
              desc: '这是一条真实抓取到的正文内容，用于验证 SSR 无显式 time 时的日期诚实。',
              user: { nickname: '匿名用户' },
              interactInfo: { likedCount: '1', collectedCount: '0', commentCount: '0', shareCount: '0' },
            },
          },
        },
      },
    }
    return `<html><head><title>无发布时间的手记 - 小红书</title></head><body><div id="app"><script>window.__INITIAL_STATE__ = ${JSON.stringify(state)}</script></div></body></html>`
  }

  it('parseXhsExplore：SSR 无 time → publishedAt 缺省（绝不等于抓取时刻）', () => {
    const post = parseXhsExplore(noDateXhsHtml(), '644b887b0000000013012f14', 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14')
    expect(post.publishedAt).toBeUndefined()
    const item = socialPostToIntelItem(post)
    expect(item.publishedAt).toBeUndefined()
  })

  it('parseZhihuZhuanlan：js-initialData 无 createdTime/updatedTime → publishedAt 缺省', () => {
    const state = {
      initialState: {
        entities: {
          articles: {
            '999999': {
              id: '999999',
              title: '无发布时间的攻略',
              content: '<p>正文仅含内容、无创建/更新时间字段。</p>',
              author: { name: 'b-单测' },
            },
          },
        },
      },
    }
    const html = `<html><body><script id="js-initialData" type="text/json">${JSON.stringify(state)}</script></body></html>`
    const post = parseZhihuZhuanlan(html, '999999', 'https://zhuanlan.zhihu.com/p/999999')
    expect(post.publishedAt).toBeUndefined()
  })

  it('退役视频平台命中按 web 归类，不进入专用 SSR 日期解析', () => {
    const hit = toL0Hit({
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
      title: '退役平台条目',
    })
    expect(hit.platform).toBe('web')
    expect(hit.id).toMatch(/^web:[0-9a-f]{40}$/)
    expect(hit.publishedAt).toBeUndefined()
  })
})

const live = LIVE ? describe : describe.skip

live('search live smoke（TRAVEL_LIVE_SMOKE=1；环境探针，如实记录）', () => {
  it('小红书 explore 实抓：带 token 命中即抓 → 结构化；404/token 失效 → UNAVAILABLE 如实报告', async () => {
    const adapter = new SearchAdapter()
    const token = process.env['TRAVEL_XHS_TOKEN']
    if (!token) {
      console.log('[live] 无 TRAVEL_XHS_TOKEN，跳过小红书实抓（登记 blocked）')
      return
    }
    const url = `https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=${token}&xsec_source=`
    try {
      const { post } = await adapter.fetchXhsNote(url)
      expect(post.content.length).toBeGreaterThan(20)
      console.log(`[live] xhs 实抓成功：${post.title}；作者 ${post.author}；赞 ${post.interactions?.likes}；正文 ${post.content.length} 字`)
    } catch (err) {
      const engine = err as EngineError
      expect(engine.code).toBe('UNAVAILABLE')
      console.log(`[live] xhs 实抓 blocked（UNAVAILABLE：${engine.message}）——token 时效/风控，登记 blocked 不阻塞`)
    }
  }, 30_000)

  it('知乎专栏实抓：可达 → 结构化；403 风控 → UNAVAILABLE 如实报告', async () => {
    const adapter = new SearchAdapter()
    try {
      const { post } = await adapter.fetchZhihuZhuanlan('https://zhuanlan.zhihu.com/p/670415069')
      expect(post.content.length).toBeGreaterThan(10)
      console.log(`[live] zhihu 实抓成功：${post.title}`)
    } catch (err) {
      const engine = err as EngineError
      expect(['UNAVAILABLE', 'TIMEOUT']).toContain(engine.code)
      console.log(`[live] zhihu 实抓 blocked（${engine.code}：${engine.message}）——登记 blocked`)
    }
  }, 30_000)
})