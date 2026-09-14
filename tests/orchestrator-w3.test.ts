/**
 * fan-out 编排器 W3 加厚单测：单源重试（指数退避/预算计入/EMPTY 不重试）、
 * 渠道开关前置过滤（ADR-12 热读 →「已停用（用户配置）」）、聚合去重（跨渠道
 * L0/L0.5 同笔记折叠取富）、冲突标注（conflictsWith 互链）、时效降权（>12 个月）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IntelItem } from '../src/models/types.js'
import type { CanonicalQuery, KeyResolutionEnv } from '../src/adapters/base.js'
import type { ResearchChannel, ResearchChannelOutcome } from '../src/orchestrator/types.js'
import {
  aggregateIntelItemsWithReport, applyTimeliness, annotateConflicts, dedupeIntelItems,
  filterIntelNoise, intelDedupKey, runChannelFanout,
} from '../src/orchestrator/fanout.js'

function item(id: string, channel: IntelItem['channel'], category: IntelItem['category'] = 'attraction'): IntelItem {
  return {
    id, category, channel, title: `t-${id}`, summary: `s-${id}`,
    source: { platform: 'test', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-02T00:00:00.000Z' },
    confidence: 'low',
  }
}

const QUERY: CanonicalQuery = { destination: '武汉', categories: ['attraction', 'food'] }

describe('W3 单源重试（≤2 次指数退避，等待计入总预算）', () => {
  it('失败 2 次后第 3 次成功 → 重试 2 次（退避 5/10ms）+ 条目返回 + 无 degraded', async () => {
    let runs = 0
    const channel: ResearchChannel = {
      name: 'retry-ok',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => {
        runs += 1
        if (runs < 3) return { ok: false, code: 'UNAVAILABLE', reason: '瞬时网络抖动' }
        return { ok: true, items: [item('r1', 'xhs-l0')] }
      },
    }
    const result = await runChannelFanout({
      channels: [channel], query: QUERY, budgetMs: 5000, retryDelaysMs: [5, 10],
    })
    expect(runs).toBe(3)
    expect(result.items.map((i) => i.id)).toEqual(['r1'])
    expect(result.degraded).toEqual([])
  })

  it('重试等待计入总预算：预算装不下第二次退避 → 停止重试并返回最近一次失败', async () => {
    let runs = 0
    const channel: ResearchChannel = {
      name: 'retry-budget',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => {
        runs += 1
        return { ok: false, code: 'UNAVAILABLE', reason: '持续失败' }
      },
    }
    // 预算 40ms：首次失败后退避 50ms 装不下 → 不重试（runs=1）
    const result = await runChannelFanout({
      channels: [channel], query: QUERY, budgetMs: 40, retryDelaysMs: [50, 4000],
    })
    expect(runs).toBe(1)
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'retry-budget', code: 'UNAVAILABLE' })
  })

  it('EMPTY 属确定性无结果 → 不重试（runs=1）', async () => {
    let runs = 0
    const channel: ResearchChannel = {
      name: 'retry-empty',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => {
        runs += 1
        return { ok: false, code: 'EMPTY', reason: '渠道检索无结果' }
      },
    }
    const result = await runChannelFanout({
      channels: [channel], query: QUERY, budgetMs: 5000, retryDelaysMs: [5, 10],
    })
    expect(runs).toBe(1)
    expect(result.degraded[0]).toMatchObject({ source: 'retry-empty', code: 'EMPTY' })
  })
})

describe('W3 渠道开关前置过滤（ADR-12 热读）', () => {
  it('settings channels.douyin=false → 跳过 run + degraded「已停用（用户配置）」', async () => {
    let ran = false
    const channel: ResearchChannel = {
      name: 'douyin',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => {
        ran = true
        return { ok: true, items: [item('d1', 'douyin')] }
      },
    }
    const env: KeyResolutionEnv = {
      readSettings: (key) => (key === 'channels.douyin' ? 'false' : undefined),
      env: {},
    }
    const result = await runChannelFanout({ channels: [channel], query: QUERY, budgetMs: 1000, env })
    expect(ran).toBe(false)
    expect(result.items).toEqual([])
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'douyin', code: 'UNAVAILABLE', reason: '已停用（用户配置）' })
    expect(result.executed).toEqual(['douyin'])
  })

  it('settings 未配置该渠道 → 缺省开（不误杀）', async () => {
    let ran = false
    const channel: ResearchChannel = {
      name: 'mystery',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => {
        ran = true
        return { ok: true, items: [item('m1', 'web')] }
      },
    }
    const result = await runChannelFanout({
      channels: [channel], query: QUERY, budgetMs: 1000, retryDelaysMs: [],
      env: { readSettings: () => undefined, env: {} },
    })
    expect(ran).toBe(true)
    expect(result.items).toHaveLength(1)
  })
})

describe('W3 聚合：去重键（笔记 ID / POI ID）', () => {
  it('同笔记双 URL（l0:note1 与 xhs:note1）跨渠道折叠为 1 条，取更富者（L0.5 medium）', async () => {
    const l0 = {
      ...item('l0:note1', 'xhs-l0'), confidence: 'low' as const, summary: '标题级',
    }
    const l05 = {
      ...item('xhs:note1', 'xhs-l0'), confidence: 'medium' as const, summary: '正文全文 + 互动数据更长',
    }
    const out = dedupeIntelItems([l0, l05])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('xhs:note1')
    expect(out[0].confidence).toBe('medium')
  })

  it('intelDedupKey：社媒前缀剥离，POI id 原样', () => {
    expect(intelDedupKey({ id: 'l0:abc123' })).toBe('abc123')
    expect(intelDedupKey({ id: 'xhs:abc123' })).toBe('abc123')
    expect(intelDedupKey({ id: 'social-douyin-douyin-7321' })).toBe('douyin-7321')
    expect(intelDedupKey({ id: 'tencent-poi:16294309905749563320' })).toBe('tencent-poi:16294309905749563320')
  })

  it('fan-out 出口整体聚合：原始 counts 保留，items 去重后合并', async () => {
    const result = await runChannelFanout({
      channels: [
        { name: 'xhsFallback', available: async () => true, run: async () => ({ ok: true, items: [item('l0:note9', 'xhs-l0')] }) },
        { name: 'tier2', available: async () => true, run: async () => ({ ok: true, items: [item('xhs:note9', 'xhs-l0')] }) },
      ],
      query: QUERY,
      budgetMs: 1000,
      retryDelaysMs: [],
    })
    expect(result.counts).toMatchObject({ xhsFallback: 1, tier2: 1 }) // 去重前逐渠道计数
    expect(result.items).toHaveLength(1) // contentDedup 后 1 条
    expect(result.observations).toHaveLength(2) // 两条原始观察不被 suppression 抹掉
    expect(result.observations.map((observation) => observation.item.id)).toEqual(['l0:note9', 'xhs:note9'])
  })
})

describe('T21 L1 噪声门（可逆 deny-list + 强标题信号）', () => {
  it('安全操作提示含“立即”不误杀，真正下载/注册/推广/转换器标题仍过滤', () => {
    const safe = { ...item('safe-rise', 'web'), title: '高原不适应立即停止上升', summary: '出现不适及时下降海拔' }
    const noise = [
      { ...item('download', 'web'), title: '立即下载旅行客户端' },
      { ...item('register', 'web'), title: '立即注册领取优惠' },
      { ...item('promotion', 'web'), title: '青甘推广链接与广告推广' },
      { ...item('converter', 'web'), title: '在线文件转换器' },
    ]
    const result = filterIntelNoise([safe, ...noise])
    expect(result.items.map((entry) => entry.id)).toEqual(['safe-rise'])
    expect(result.degraded).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'web', code: 'NOISE', reason: 'title_signal:download' }),
      expect.objectContaining({ source: 'web', code: 'NOISE', reason: 'title_signal:register' }),
      expect.objectContaining({ source: 'web', code: 'NOISE', reason: 'title_signal:promotion' }),
      expect.objectContaining({ source: 'web', code: 'NOISE', reason: 'title_signal:converter' }),
    ]))
  })

  it('过滤 LinkedIn 两条与强转换标题，正常来源保留；dropped 按渠道+原因带 count', async () => {
    const linkedin = (id: string): IntelItem => ({
      ...item(id, 'web'),
      source: { platform: 'web', url: 'https://www.linkedin.com/jobs/view/1', fetchedAt: '2026-09-02T00:00:00.000Z' },
    })
    const converter = { ...item('converter', 'web'), title: '立即下载 Excel 文件转换器', summary: '安装工具' }
    const normal = { ...item('normal', 'web'), title: '武汉黄鹤楼游览攻略', summary: '开放时间与门票' }
    const result = await runChannelFanout({
      channels: [{ name: 'noise-fixture', available: async () => true, run: async () => ({ ok: true, items: [linkedin('li-1'), linkedin('li-2'), converter, normal] }) }],
      query: QUERY, budgetMs: 1000, retryDelaysMs: [],
    })
    expect(result.items.map((value) => value.id)).toEqual(['normal'])
    const noise = result.degraded.filter((entry) => entry.source === 'web')
    expect(noise).toHaveLength(2)
    expect(noise.map((entry) => entry.count).sort()).toEqual([1, 2])
    expect(filterIntelNoise([linkedin('li-3')], []).items).toHaveLength(1)
  })
})

describe('W3 冲突标注（conflictsWith 互链）', () => {
  it('同对象（同名 POI）评分矛盾（4.9 vs 3.9）→ 互链 conflictsWith', () => {
    const a = { ...item('p1', 'tencent-poi'), title: '黄鹤楼', rating: 4.9, confidence: 'high' as const }
    const b = { ...item('p2', 'tencent-poi'), title: '黄鹤楼', rating: 3.9, confidence: 'high' as const }
    const out = annotateConflicts([a, b])
    expect(out[0].conflictsWith).toEqual(['p2'])
    expect(out[1].conflictsWith).toEqual(['p1'])
  })

  it('类别极性矛盾（避雷 vs 推荐 同名对象）→ 互链', () => {
    const warn = { ...item('w1', 'xhs-l0'), title: '西湖游船避雷', category: 'warning' as const }
    const rec = { ...item('r1', 'xhs-l0'), title: '西湖游船推荐', category: 'recommend' as const }
    const out = annotateConflicts([warn, rec])
    expect(out[0].conflictsWith).toEqual(['r1'])
    expect(out[1].conflictsWith).toEqual(['w1'])
  })

  it('同名但无矛盾（评分相近）→ 不互链', () => {
    const a = { ...item('p1', 'tencent-poi'), title: '黄鹤楼', rating: 4.5 }
    const b = { ...item('p2', 'tencent-poi'), title: '黄鹤楼', rating: 4.3 }
    const out = annotateConflicts([a, b])
    expect(out[0].conflictsWith).toBeUndefined()
    expect(out[1].conflictsWith).toBeUndefined()
  })
})

describe('W3 时效降权（publishedAt >12 个月）', () => {
  it('2024-08 发布（now=2026-09）→ confidence high→medium + 标注', () => {
    const old = { ...item('o1', 'xhs-l0'), publishedAt: '2024-08-01', confidence: 'high' as const }
    const out = applyTimeliness([old], new Date('2026-09-01T00:00:00Z'))
    expect(out[0].confidence).toBe('medium')
    expect(out[0].summary).toContain('已超 12 个月')
    expect(out[0].summary).toContain('2024-08-01')
  })

  it('近 12 个月内容不降权', () => {
    const fresh = { ...item('f1', 'xhs-l0'), publishedAt: '2026-06-01', confidence: 'low' as const }
    const out = applyTimeliness([fresh], new Date('2026-09-01T00:00:00Z'))
    expect(out[0].confidence).toBe('low')
    expect(out[0].summary).not.toContain('已超 12 个月')
  })

  it('无 publishedAt → 保留但降权（不改原摘要结构）', () => {
    const plain = { ...item('p1', 'tencent-poi'), confidence: 'high' as const }
    const out = applyTimeliness([plain], new Date('2026-09-01T00:00:00Z'))
    expect(out[0].confidence).toBe('medium')
    expect(out[0].summary).toBe(plain.summary)
  })

  it('tip/recommend 超过 2 年降权标记，超过 5 年过滤并带 dropped count', async () => {
    const twoYears = { ...item('tip-old', 'web', 'recommend'), publishedAt: '2024-08-01T12:00:00+08:00', confidence: 'high' as const }
    const fiveYears = { ...item('tip-stale', 'web', 'recommend'), publishedAt: '2020-01-01', confidence: 'high' as const }
    const result = await runChannelFanout({
      channels: [{ name: 'timeliness-fixture', available: async () => true, run: async () => ({ ok: true, items: [twoYears, fiveYears] }) }],
      query: QUERY, budgetMs: 1000, retryDelaysMs: [],
    })
    expect(result.items.map((value) => value.id)).toEqual(['tip-old'])
    expect(result.items[0].confidence).toBe('medium')
    expect(result.items[0].summary).toContain('已超 2 年')
    expect(result.degraded).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'web', code: 'STALE', count: 1, reason: expect.stringContaining('超过 5 年') }),
    ]))
  })

  it('tip/recommend 缺失或非法发布时间 → 可见“时效性未知”标注并降权，不删除', () => {
    const missing = { ...item('missing-date', 'web', 'tip'), confidence: 'high' as const }
    const invalid = { ...item('invalid-date', 'web', 'recommend'), publishedAt: 'not-a-date', confidence: 'high' as const }
    const out = applyTimeliness([missing, invalid], new Date('2026-09-01T00:00:00Z'))
    expect(out).toHaveLength(2)
    for (const entry of out) {
      expect(entry.confidence).toBe('medium')
      expect(entry.summary).toContain('时效性未知')
    }
  })

  it('超过 5 年 dropped 按渠道+原因类别稳定聚合，不把不同日期放入分组键', () => {
    const first = { ...item('stale-1', 'web', 'recommend'), publishedAt: '2019-01-01', confidence: 'high' as const }
    const second = { ...item('stale-2', 'web', 'recommend'), publishedAt: '2020-02-02', confidence: 'high' as const }
    const result = aggregateIntelItemsWithReport([first, second], { now: new Date('2026-09-01T00:00:00Z') })
    expect(result.items).toEqual([])
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'web', code: 'STALE', count: 2 })
    expect(result.degraded[0]?.reason).toContain('超过 5 年')
    expect(result.degraded[0]?.reason).not.toContain('2019-01-01')
    expect(result.degraded[0]?.reason).not.toContain('2020-02-02')
  })
})

describe('W3 aggregate 管线串行（去重→冲突→降权）', () => {
  it('同笔记 L0/L0.5 + 同名冲突 + 过期 — 全链路合成', async () => {
    const l0 = { ...item('l0:noteX', 'xhs-l0'), title: '西湖游船避雷', category: 'warning' as const, publishedAt: '2024-08-01', confidence: 'low' as const, summary: '标题级' }
    const l05 = { ...item('xhs:noteX', 'xhs-l0'), title: '西湖游船避雷', category: 'warning' as const, publishedAt: '2024-08-01', confidence: 'medium' as const, summary: '正文全文很长很完整的内容摘要' }
    const rec = { ...item('web:guide', 'web'), title: '西湖游船推荐', category: 'recommend' as const, confidence: 'high' as const }
    const result = await runChannelFanout({
      channels: [
        { name: 'xhsFallback', available: async () => true, run: async () => ({ ok: true, items: [l0] }) },
        { name: 'tier2', available: async () => true, run: async () => ({ ok: true, items: [l05, rec] }) },
      ],
      query: QUERY,
      budgetMs: 1000,
      retryDelaysMs: [],
    })
    // 去重：noteX 折叠为 L0.5（medium）
    expect(result.items).toHaveLength(2)
    const keptNote = result.items.find((i) => i.id === 'xhs:noteX')!
    expect(keptNote).toBeDefined()
    // 降权：publishedAt 2024-08（>12 个月）→ medium→low + 标注
    expect(keptNote.confidence).toBe('low')
    expect(keptNote.summary).toContain('已超 12 个月')
    // 冲突：warning(避雷) vs recommend(推荐) 同名 → 互链
    const recItem = result.items.find((i) => i.id === 'web:guide')!
    expect(keptNote.conflictsWith).toContain('web:guide')
    expect(recItem.conflictsWith).toContain('xhs:noteX')
  })
})

describe('W3 编排器内部异常兜底', () => {
  it('编排器自身异常 → defensive degraded（渠道执行已被包装）', async () => {
    // 渠道 available 抛错 → 前置过滤可用性判定失败 → UNAVAILABLE 记账，不抛
    const channel: ResearchChannel = {
      name: 'boom',
      available: async () => { throw new Error('available 探测失败') },
      run: async () => ({ ok: true, items: [] }),
    }
    const result = await runChannelFanout({ channels: [channel], query: QUERY, budgetMs: 1000, retryDelaysMs: [] })
    expect(result.items).toEqual([])
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0].source).toBe('boom')
  })
})

describe('M2 遗留修复：fan-out 入口重置单次规划预算（CLOSURE ③）', () => {
  it('research 入口（runChannelFanout）调用 resetPlanBudget，先于渠道执行（mock 断言）', async () => {
    const reset = vi.fn()
    let channelRan = false
    const channel: ResearchChannel = {
      name: 'budget-reset',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => {
        channelRan = true
        return { ok: true, items: [item('b1', 'tencent-poi')] }
      },
    }
    const result = await runChannelFanout({
      channels: [channel], query: QUERY, budgetMs: 1000, retryDelaysMs: [], resetPlanBudget: reset,
    })
    expect(reset).toHaveBeenCalledTimes(1)
    expect(channelRan).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(result.degraded).toEqual([])
  })

  it('未注入 resetPlanBudget → 正常执行（缺省无重置，不抛）', async () => {
    const channel: ResearchChannel = {
      name: 'no-reset',
      available: async () => true,
      run: async (): Promise<ResearchChannelOutcome> => ({ ok: true, items: [item('n1', 'web')] }),
    }
    const result = await runChannelFanout({ channels: [channel], query: QUERY, budgetMs: 1000, retryDelaysMs: [] })
    expect(result.items.map((i) => i.id)).toEqual(['n1'])
  })
})

describe('W3 进度与超时（budget 截断）', () => {
  it('慢渠道超预算 → TIMEOUT 记账，其余渠道照常（重试不叠加）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const slow: ResearchChannel = {
        name: 'slow',
        available: async () => true,
        run: async () => {
          await new Promise((r) => setTimeout(r, 500))
          return { ok: true, items: [item('s1', 'xhs-l0')] }
        },
      }
      const fast: ResearchChannel = {
        name: 'fast',
        available: async () => true,
        run: async () => ({ ok: true, items: [item('f1', 'tencent-poi')] }),
      }
      const promise = runChannelFanout({ channels: [slow, fast], query: QUERY, budgetMs: 60, retryDelaysMs: [] })
      await vi.advanceTimersByTimeAsync(100)
      const result = await promise
      expect(result.items.map((i) => i.id)).toEqual(['f1'])
      expect(result.degraded).toHaveLength(1)
      expect(result.degraded[0]).toMatchObject({ source: 'slow', code: 'TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })
})