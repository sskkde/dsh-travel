/**
 * fan-out 编排器骨架单测（M1 T5 / Wα）：
 * 并发执行 / 单源失败→degraded 其余完成 / 统一超时预算截断 / available 前置过滤 / 条目去重。
 */
import { describe, expect, it } from 'vitest'
import type { IntelItem } from '../src/models/types.js'
import type { CanonicalQuery } from '../src/adapters/base.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { TencentMapAdapter, type HttpCallFn } from '../src/adapters/tencent.js'
import { tencentPoiChannel } from '../src/orchestrator/channels.js'
import type { ResearchChannel, ResearchChannelOutcome } from '../src/orchestrator/types.js'
import { dedupeIntelItems, runChannelFanout } from '../src/orchestrator/fanout.js'

function item(id: string, channel: IntelItem['channel'], category: IntelItem['category'] = 'attraction'): IntelItem {
  return {
    id, category, channel, title: `t-${id}`, summary: `s-${id}`,
    source: { platform: 'test', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-02T00:00:00.000Z' },
    confidence: 'low',
  }
}

function okChannel(name: string, items: IntelItem[], delayMs = 0): ResearchChannel {
  return {
    name,
    available: async () => true,
    run: async (): Promise<ResearchChannelOutcome> => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return { ok: true, items }
    },
  }
}

function failChannel(name: string, code: 'UNAVAILABLE' | 'EMPTY' | 'TIMEOUT', reason: string): ResearchChannel {
  return {
    name,
    available: async () => true,
    run: async (): Promise<ResearchChannelOutcome> => ({ ok: false, code, reason }),
  }
}

const QUERY: CanonicalQuery = { destination: '武汉', categories: ['attraction', 'food'] }

describe('runChannelFanout 骨架', () => {
  it('两渠道成功 → items 汇总 + counts 逐渠道 + degraded 空', async () => {
    const result = await runChannelFanout({
      channels: [okChannel('tencent-poi', [item('p1', 'tencent-poi', 'attraction')]), okChannel('search-l0', [item('l1', 'xhs-l0', 'food')])],
      query: QUERY,
      budgetMs: 1000,
    })
    expect(result.items.map((i) => i.id).sort()).toEqual(['l1', 'p1'])
    expect(result.counts).toMatchObject({ 'tencent-poi': 1, 'search-l0': 1 })
    expect(result.degraded).toEqual([])
    expect(result.executed.sort()).toEqual(['search-l0', 'tencent-poi'])
  })

  it('单源失败 → 该源 degraded 记账，其余渠道条目照常返回（不抛裸异常）', async () => {
    const result = await runChannelFanout({
      channels: [
        okChannel('tencent-poi', [item('p1', 'tencent-poi', 'attraction')]),
        failChannel('search-l0', 'UNAVAILABLE', '宿主 web 搜索未注入'),
      ],
      query: QUERY,
      budgetMs: 1000,
      retryDelaysMs: [],
    })
    expect(result.items.map((i) => i.id)).toEqual(['p1'])
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'search-l0', code: 'UNAVAILABLE', reason: '宿主 web 搜索未注入' })
    expect(result.degraded[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.counts['search-l0']).toBe(0)
  })

  it('全渠道失败 → 全 degraded 记账 + items 空（工具层据此不产空 intel）', async () => {
    const result = await runChannelFanout({
      channels: [
        failChannel('tencent-poi', 'TIMEOUT', 'POI 超时'),
        failChannel('search-l0', 'UNAVAILABLE', '宿主 web 搜索未注入'),
      ],
      query: QUERY,
      budgetMs: 1000,
      retryDelaysMs: [],
    })
    expect(result.items).toEqual([])
    expect(result.degraded.map((d) => d.source).sort()).toEqual(['search-l0', 'tencent-poi'])
  })

  it('渠道内部抛裸异常 → 编排器归一化 UNAVAILABLE 记账（兜底）', async () => {
    const channel: ResearchChannel = {
      name: 'search-l0',
      available: async () => true,
      run: async () => { throw new Error('network down') },
    }
    const result = await runChannelFanout({ channels: [channel], query: QUERY, budgetMs: 1000, retryDelaysMs: [] })
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'search-l0', code: 'UNAVAILABLE' })
    expect(result.degraded[0].reason).toContain('network down')
  })

  it('available()=false（Key/注入缺失）→ 前置过滤：不执行 run，计入 UNAVAILABLE degraded', async () => {
    let ran = false
    const channel: ResearchChannel = {
      name: 'search-l0',
      available: async () => false,
      run: async () => { ran = true; return { ok: true, items: [item('x', 'xhs-l0')] } },
    }
    const result = await runChannelFanout({ channels: [channel], query: QUERY, budgetMs: 1000, retryDelaysMs: [] })
    expect(ran).toBe(false)
    expect(result.items).toEqual([])
    expect(result.degraded[0]).toMatchObject({ source: 'search-l0', code: 'UNAVAILABLE' })
  })

  it('统一超时预算：超时渠道 → TIMEOUT 记账，按时渠道照常完成', async () => {
    const result = await runChannelFanout({
      channels: [
        okChannel('fast', [item('f1', 'tencent-poi')], 10),
        okChannel('slow', [item('s1', 'xhs-l0')], 500), // 超预算（budget 60ms）
      ],
      query: QUERY,
      budgetMs: 60,
    })
    expect(result.items.map((i) => i.id)).toEqual(['f1'])
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ source: 'slow', code: 'TIMEOUT' })
  })

  it('同条目 id 跨渠道去重（W3 升级为聚合去重前的骨架行为）', async () => {
    const result = await runChannelFanout({
      channels: [okChannel('a', [item('dup1', 'xhs-l0')]), okChannel('b', [item('dup1', 'xhs-l0')])],
      query: QUERY,
      budgetMs: 1000,
    })
    expect(result.items).toHaveLength(1)
    expect(result.counts).toMatchObject({ a: 1, b: 1 })
  })

  it('T25 Tencent available 抛错时，复合 POI 仍进入 run 并由 Amap 补位', async () => {
    let tencentHttpCalls = 0
    const tencentHttp: HttpCallFn = async () => {
      tencentHttpCalls += 1
      return {
        ok: true,
        status: 200,
        text: async () => 'qq.maps.callback({"status":0,"message":"Success","count":0,"data":[]});',
      }
    }
    const tencent = new TencentMapAdapter({ httpCall: tencentHttp })
    tencent.available = async () => { throw new Error('Tencent availability probe failed') }
    let amapHttpCalls = 0
    const amap = new AmapAdapter({
      fetchFn: async () => {
        amapHttpCalls += 1
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: '1', info: 'OK', pois: [{ id: 'a1', name: '补位景点', location: '121,31', address: '地址', type: '景点' }],
          }),
        }
      },
    })
    const result = await runChannelFanout({
      channels: [tencentPoiChannel(tencent, amap)],
      query: { ...QUERY, categories: ['attraction'] },
      budgetMs: 1000,
      retryDelaysMs: [],
      env: { env: { amapWebservice: 'test-key' } },
    })
    expect(tencentHttpCalls).toBeGreaterThan(0)
    expect(amapHttpCalls).toBeGreaterThan(0)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.every((entry) => entry.source.platform === 'amap')).toBe(true)
    expect(result.degraded.some((entry) => entry.source === 'tencent-poi')).toBe(true)
  })

  it('T25 sources=[amap] 时不触发 Tencent，仍经 Amap available 门', async () => {
    let tencentHttpCalls = 0
    const tencent = new TencentMapAdapter({
      httpCall: async () => {
        tencentHttpCalls += 1
        return { ok: true, status: 200, text: async () => 'qq.maps.callback({"status":0,"data":[]});' }
      },
    })
    tencent.available = async () => { throw new Error('Tencent availability probe failed') }
    let amapAvailableCalls = 0
    let amapHttpCalls = 0
    const amap = new AmapAdapter({
      fetchFn: async () => {
        amapHttpCalls += 1
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: '1', info: 'OK', pois: [{ id: 'a2', name: '白名单景点', location: '121,31', address: '地址', type: '景点' }],
          }),
        }
      },
    })
    const originalAvailable = amap.available.bind(amap)
    amap.available = async (env) => {
      amapAvailableCalls += 1
      return originalAvailable(env)
    }
    const result = await runChannelFanout({
      channels: [tencentPoiChannel(tencent, amap)],
      query: { ...QUERY, categories: ['attraction'], sources: ['amap'] },
      budgetMs: 1000,
      retryDelaysMs: [],
      env: { env: { amapWebservice: 'test-key' } },
    })
    expect(tencentHttpCalls).toBe(0)
    expect(amapAvailableCalls).toBe(1)
    expect(amapHttpCalls).toBeGreaterThan(0)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.every((entry) => entry.source.platform === 'amap')).toBe(true)
  })
})

describe('dedupeIntelItems', () => {
  it('按 id 去重保序', () => {
    const out = dedupeIntelItems([item('a', 'xhs-l0'), item('b', 'tencent-poi'), item('a', 'xhs-l0')])
    expect(out.map((i) => i.id)).toEqual(['a', 'b'])
  })
})