/**
 * social 适配器单测（W2b 基础版）：L0 摘要级 + 三层平台兜底 + 去重 + degraded。
 * fixture = 宿主 web_search 真实录制（tests/fixtures/social/）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  SocialAdapter, TITLE_ONLY_MARK, buildPlatformQuery, channelForUrl, urlDedupKey,
  type SearchHit, type SocialPlatform,
} from '../src/adapters/social.js'
import { tier3Channel } from '../src/orchestrator/channels.js'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'social')
function fixture(name: string): { hits: SearchHit[] } {
  return JSON.parse(readFileSync(path.join(FIX, name), 'utf8'))
}

/** 按 site: 域分发 fixture 命中的假宿主搜索。 */
function fixtureSearch(): (q: string, platform?: SocialPlatform) => Promise<SearchHit[]> {
  const bySite: Record<string, string> = {
    'douyin.com': 'douyin.json',
    'weibo.com': 'weibo.json',
    'tieba.baidu.com': 'tieba.json',
    'kuaishou.com': 'kuaishou.json',
  }
  const map = Object.fromEntries(
    Object.entries(bySite).map(([site, file]) => [site, fixture(file).hits]),
  )
  return async (q: string, platform?: SocialPlatform) => {
    const site = Object.keys(map).find((s) => q.includes(`site:${s}`)) ?? (platform ? bySiteFor(platform) : undefined)
    return site ? map[site] : []
  }
}

function bySiteFor(platform: SocialPlatform): string | undefined {
  return {
    douyin: 'douyin.com',
    weibo: 'weibo.com',
    tieba: 'tieba.baidu.com',
    kuaishou: 'kuaishou.com',
  }[platform]
}

describe('social L0 去重键与渠道识别', () => {
  it('去重键=URL 路径段末段 ID（非 URL 全串，query 剔除）', () => {
    expect(urlDedupKey('https://www.douyin.com/video/7533235307156802875?from=x')).toBe('7533235307156802875')
    expect(urlDedupKey('https://tieba.baidu.com/p/341182427/?_spm_id=x')).toBe('341182427')
    expect(urlDedupKey('https://weibo.com/2/detail/5338612212433898?utm_source=travel')).toBe('5338612212433898')
  })

  it('渠道按实际 URL 域名识别（overseas.weibo.com → weibo）', () => {
    expect(channelForUrl('https://www.douyin.com/video/1', 'douyin')).toBe('douyin')
    expect(channelForUrl('https://overseas.weibo.com/1997946033/PxZUKh0MC', 'douyin')).toBe('weibo')
    expect(channelForUrl('https://tieba.baidu.com/p/1', 'weibo')).toBe('tieba')
    expect(channelForUrl('https://example.com/x', 'weibo')).toBe('weibo')
  })

  it('site: 查询构造（尽力而为）', () => {
    expect(buildPlatformQuery('douyin', '杭州 西湖')).toBe('杭州 西湖 site:douyin.com')
    expect(buildPlatformQuery('tieba', '杭州')).toBe('杭州 site:tieba.baidu.com')
  })

  it('tier3Channel 平台登记不含豆瓣', async () => {
    const seen: SocialPlatform[] = []
    const social = {
      searchL0: async (_query: unknown, options: { platforms?: SocialPlatform[] }) => {
        seen.push(...(options.platforms ?? []))
        return { items: [], degraded: [] }
      },
    } as unknown as SocialAdapter
    const outcome = await tier3Channel(social).run(
      { destination: '杭州' } as never,
      { deadlineMs: Date.now() + 1_000, budgetMs: 1_000, env: undefined },
    )
    expect(outcome.ok).toBe(false)
    expect(seen).toEqual(['weibo', 'tieba', 'kuaishou'])
    expect(seen).not.toContain('douban')
  })
})

describe('social L0 golden（真实 fixture，离线）', () => {
  it('抖音命中 → 摘要级条目（渠道 douyin、URL 保留、snippet 缺失时如实标注「仅标题摘要」）', async () => {
    const search = fixtureSearch()
    const adapter = new SocialAdapter({ search })
    const out = await adapter.searchL0({ destination: '杭州', keywords: ['西湖 攻略'] }, { platforms: ['douyin'] })
    const douyin = out.items.filter((i) => i.channel === 'douyin')
    expect(douyin.length).toBeGreaterThan(0)
    expect(douyin.every((i) => i.source.url.includes('douyin.com'))).toBe(true)
    // 无 snippet → 如实标注仅标题摘要
    expect(out.items.some((i) => i.summary.includes(TITLE_ONLY_MARK))).toBe(true)
    expect(out.items.every((i) => i.confidence === 'low')).toBe(true)
    // 去重键=路径段 ID：同视频不同 query 不重复
    for (const i of out.items) {
      expect(out.items.filter((j) => j.source.url.split(/[?#]/)[0] === i.source.url.split(/[?#]/)[0]).length).toBe(1)
    }
  })

  it('三层平台兜底：微博命中、贴吧/快手 0 命中 → EMPTY degraded 记账不中断', async () => {
    const search = fixtureSearch()
    const adapter = new SocialAdapter({ search })
    const out = await adapter.searchL0({ destination: '杭州' })
    const channels = new Set(out.items.map((i) => i.channel))
    expect(channels.has('weibo')).toBe(true)
    expect(channels.has('douban')).toBe(false)
    // 真实录制：贴吧/快手 site 定向 0 命中
    const emptyEntries = out.degraded.filter((d) => d.code === 'EMPTY' && d.reason.includes('无 L0 结果'))
    expect(emptyEntries.some((d) => d.source.includes('tieba'))).toBe(true)
    expect(emptyEntries.some((d) => d.source.includes('kuaishou'))).toBe(true)
    // 全部条目零重复（URL 路径段去重）
    const keys = out.items.map((i) => `${i.channel}/${urlDedupKey(i.source.url)}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('去重跨查询：同视频 ID 两条命中（不同 query）→ 单条目', async () => {
    const adapter = new SocialAdapter({
      search: async () => [
        { title: 'A', url: 'https://www.douyin.com/video/123456789' },
        { title: 'B', url: 'https://www.douyin.com/video/123456789?from=dup' },
      ],
    })
    const out = await adapter.searchL0({ destination: '杭州' }, { platforms: ['douyin'] })
    expect(out.items.length).toBe(1)
  })

  it('单平台搜索异常 → UNAVAILABLE degraded，其余平台照常', async () => {
    const search = fixtureSearch()
    const adapter = new SocialAdapter({
      search: async (q) => {
        if (q.includes('site:douyin.com')) throw new Error('引擎 500')
        return search(q)
      },
    })
    const out = await adapter.searchL0({ destination: '杭州' })
    expect(out.degraded.some((d) => d.source === 'social-l0/douyin' && d.code === 'UNAVAILABLE')).toBe(true)
    expect(out.items.some((i) => i.channel === 'weibo')).toBe(true)
  })

  it('单平台超时 → TIMEOUT degraded（不阻塞整批）', async () => {
    const adapter = new SocialAdapter({
      search: async (q) => {
        if (q.includes('site:douyin.com')) return new Promise(() => { /* 永不返回 */ })
        return fixture('weibo.json').hits
      },
      timeoutMs: 50,
    })
    const out = await adapter.searchL0({ destination: '杭州' })
    expect(out.degraded.some((d) => d.code === 'TIMEOUT')).toBe(true)
    expect(out.items.length).toBeGreaterThan(0)
  })

  it('搜索函数未注入 → UNAVAILABLE「搜索函数未注入」', async () => {
    const adapter = new SocialAdapter()
    const out = await adapter.searchL0({ destination: '杭州' })
    expect(out.degraded[0]?.reason).toContain('未注入')
    expect(out.items).toEqual([])
  })
})

describe('social 渠道开关（ADR-12 前置过滤）', () => {
  it('available()：缺省 true；渠道 off → false（fan-out 跳过路径）', async () => {
    const adapter = new SocialAdapter({ search: async () => [] })
    await expect(adapter.available()).resolves.toBe(true)
    await expect(adapter.available({ env: { TRAVEL_CHANNEL_SOCIAL: 'off' } })).resolves.toBe(false)
    await expect(adapter.available({ env: { TRAVEL_CHANNEL_SOCIAL: '0' } })).resolves.toBe(false)
    // W6 settings 位（readSettings 接口验证）
    await expect(adapter.available({
      readSettings: (k) => (k === 'channels.social' ? 'false' : undefined),
    })).resolves.toBe(false)
    await expect(adapter.available({
      readSettings: (k) => (k === 'channels.social' ? 'on' : undefined),
    })).resolves.toBe(true)
  })
})