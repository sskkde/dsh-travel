/**
 * B3 P0-C 检索恢复（FIX R1 · plan fix-batches-2026-09-09 T8/T9/T10）单测：
 *
 * - T8 区域词进入真实渠道查询串：region 增量词（CanonicalQuery.keywords）须流进各
 *   渠道实际发起 query 的**裸主词位**（不再是「跨区域 R2 查询仍只有 destination → 增量 0」），
 *   且**无区域词**时主词查询串与旧模板逐字节一致（legacy 行为不回归）。
 * - T9 双键兼容：contentDedupKey 与 fanout 聚合键共用 helper（内容分母=笔记 ID），
 *   同轮/跨轮 suppression 不变；每条原始观察另留 round:channel:contentId provenance，
 *   l0:/xhs: 同笔记仍归一但各观察可核对，裸 itemId/newItemIds/contentRef 不变。
 * - T10 区域词 → 短引号短语（regionKeywordPhrase）：各词各自成对 `"…"`、目的地不硬拼、
 *  逐条委弃空白/重复/引号反斜杠注入/超长；数量与长度都有上限。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanonicalQuery } from '../src/adapters/base.js'
import type { IntelItem } from '../src/models/types.js'
import { TravelStore } from '../src/store/store.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { runIntake } from '../src/tools/intake.js'
import type { ResearchRound, ResearchState } from '../src/models/types.js'
import type { ResearchChannel, ResearchChannelOutcome } from '../src/orchestrator/types.js'
import { SearchAdapter, type HostSearchFn } from '../src/adapters/search.js'
import { TencentMapAdapter, type HttpCallFn } from '../src/adapters/tencent.js'
import {
  searchL0Channel, platformIntelChannel, xhsFallbackChannel, tencentPoiChannel,
  regionKeywordPhrase, destinationRegionHead, QUERY_REGION_KEYWORD_MAX, QUERY_REGION_KEYWORD_MAX_CHARS,
} from '../src/orchestrator/channels.js'

function recordingSearch() {
  const seenQueries: string[] = []
  const search = new SearchAdapter({
    hostSearch: (async (q: string) => {
      seenQueries.push(q)
      return { content: undefined, sources: [], truncated: false }
    }) as HostSearchFn,
  })
  return { search, seenQueries }
}

describe('T10 regionKeywordPhrase：短引号短语构造', () => {
  it('每个区域词独立成对短引号；destination 不重复硬拼', () => {
    const q: CanonicalQuery = { destination: '青甘大环线', keywords: ['敦煌', '张掖', '祁连'] }
    expect(regionKeywordPhrase(q)).toBe('"敦煌" "张掖" "祁连"')
    expect(destinationRegionHead(q)).toBe('青甘大环线 "敦煌" "张掖" "祁连"')
  })

  it('关键词含 destination 字面词 → region 丢弃该目的地 token（不重复硬拼）', () => {
    const q: CanonicalQuery = { destination: '武汉', keywords: ['武汉', '黄鹤楼'] }
    expect(regionKeywordPhrase(q)).toBe('"黄鹤楼"')
    expect(destinationRegionHead(q)).toBe('武汉 "黄鹤楼"')
  })

  it('无区域词 / 空关键词 / 全 destination → region 为空，head==destination（legacy 语义）', () => {
    expect(regionKeywordPhrase({ destination: '武汉' })).toBe('')
    expect(regionKeywordPhrase({ destination: '武汉', keywords: [] })).toBe('')
    expect(regionKeywordPhrase({ destination: '武汉', keywords: ['武汉 '] })).toBe('')
    expect(destinationRegionHead({ destination: '武汉' })).toBe('武汉')
    expect(destinationRegionHead({ destination: '武汉', keywords: [] })).toBe('武汉')
  })

  it('委弃 空白/重复/超长 词并去引号与反斜杠；数量&词长各自有上限', () => {
    const words = [
      '  敦煌  ', '  ', // 空白归一 / 纯空白丢弃
      '"quote"', 'back\\slash', // 引号/反斜杠剔除
      '敦煌', // 与首项去重
      `word${'A'.repeat(QUERY_REGION_KEYWORD_MAX_CHARS + 1)}`, // 超长丢弃
    ]
    const phrase = regionKeywordPhrase({ destination: '武汉', keywords: words })
    expect(phrase).toBe('"敦煌" "quote" "back slash"')

    // 数量封顶
    const capped = regionKeywordPhrase({
      destination: '武汉',
      keywords: Array.from({ length: QUERY_REGION_KEYWORD_MAX + 3 }, (_, i) => `k${i}`),
    })
    expect(capped.split(' ')).toHaveLength(QUERY_REGION_KEYWORD_MAX)
  })

  it('head 无关键词回退到裸 destination；含区词时 destination 主位 + 引号短语', () => {
    expect(destinationRegionHead({ destination: '西宁' })).toBe('西宁')
  })
})

describe('T8 渠道把区域词流进真实查询串（无区域词保持旧字节）', () => {
  const testContext = () => ({ deadlineMs: Date.now() + 1000, budgetMs: 1000 })
  it('searchL0：区词进入裸主词 `dest "<kw>" 旅行攻略`；无区词 `dest 旅行攻略`', async () => {
    const { search, seenQueries } = recordingSearch()
    const ch = searchL0Channel(search)
    await ch.run({ destination: '武汉' }, testContext())
    expect(seenQueries).toContain('武汉 旅行攻略')
    seenQueries.length = 0
    await ch.run({ destination: '武汉', keywords: ['黄鹤楼'] }, testContext())
    expect(seenQueries).toContain('武汉 "黄鹤楼" 旅行攻略')
  })

  it('platformIntel：区域词进入 3 条模板主词', async () => {
    const { search, seenQueries } = recordingSearch()
    const ch = platformIntelChannel(search)
    const bare = (): string[] => seenQueries.filter((q) => !/ site:[^ ]+$/.test(q))

    await ch.run({ destination: '西宁' }, testContext())
    expect(bare()).toContain('西宁 旅行 注意事项 证件 预约 限流')

    seenQueries.length = 0
    await ch.run({ destination: '西宁', keywords: ['门源', '祁连'] }, testContext())
    expect(bare().some((q) => q.startsWith('西宁 "门源" "祁连"'))).toBe(true)
  })

  it('xhsFallback：每条类别模板主词以 head 起头', async () => {
    const { search, seenQueries } = recordingSearch()
    const ch = xhsFallbackChannel(search)
    const bare = (): string[] => seenQueries.filter((q) => !/ site:[^ ]+$/.test(q))

    await ch.run({ destination: '西安' }, testContext())
    expect(bare()).toContain('西安 景点推荐')

    seenQueries.length = 0
    await ch.run({ destination: '西安', keywords: ['华清池'] }, testContext())
    expect(bare().some((q) => q.startsWith('西安 "华清池"'))).toBe(true)
  })

  it('tencentPoi：keywords 带短语 + region 字段仍是目的地（region 语义保留）', async () => {
    const urls: string[] = []
    const httpCall: HttpCallFn = async (url) => {
      urls.push(url)
      return { ok: true, status: 200, text: async () => 'qq.maps.callback({"status":0,"data":[]});' }
    }
    const tencent = new TencentMapAdapter({ httpCall })
    const ch = tencentPoiChannel(tencent)
    await ch.run({ destination: '长沙', categories: ['food'], keywords: ['火宫殿'] }, testContext())
    const url = urls.find((u) => u.includes('place/v1/search'))
    expect(url).toBeTruthy()
    const decoded = decodeURIComponent(url!)
    // 区域词经 head + 种子进入 keyword 参数（region 短语可见）
    expect(decoded).toContain('长沙')
    expect(decoded).toContain('"火宫殿"')
    expect(decoded).toContain('region(长沙,0)') // region 语义仍限定目的地
  })
})

describe('T9 双键兼容：contentDedup 与 per-observation provenance（内容分母=笔记 ID）', () => {
  function mkIntel(id: string, title: string, cat: IntelItem['category'] = 'recommend'): IntelItem {
    return {
      id, category: cat, channel: 'web', title, summary: `${title} 摘要`,
      source: { platform: 'test', url: 'https://example.invalid/note', fetchedAt: '2026-09-01T00:00:00.000Z' },
      confidence: 'low',
    }
  }

  it('同一笔记 l0:/xhs: 前缀跨轮归一；区域异的新内容才增量', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-b3-t9-'))
    try {
      const store = new TravelStore(root)
      const setup = await runIntake(
        { slots: { destination: '青甘大环线', dateStart: '2026-10-01', dateEnd: '2026-10-03' } },
        store,
      )
      const planId = setup.planId

      // 预置 R1 结果：一条内容 id=abc123（渠道前缀 l0:）
      await store.writeJson(planId, 'intel.json', [mkIntel('l0:abc123', '敦煌 鸣沙山 月牙泉 攻略')])

      // R2 渠道产出：同笔记 abc123 换 xhs: 前缀再现 + 区域异的新内容 new987
      const stubChannel = {
        name: 'l2-direct',
        available: async () => true,
        run: async (): Promise<ResearchChannelOutcome> => ({
          ok: true,
          items: [
            mkIntel('xhs:abc123', '敦煌 鸣沙山 月牙泉 详细'),
            mkIntel('xhs:new987', '祁连山草原 自驾 攻略'),
          ],
        }),
      }

      const r2 = await runResearchDestination(
        { planId, categories: ['recommend', 'attraction'], keywords: ['敦煌', '祁连'] },
        store,
        { channels: [stubChannel], retryDelaysMs: [] },
      )

      const newIds = (r2.round as { newItemIds: string[] }).newItemIds
      // abc123 跨轮（l0→xhs 前缀）归一 → 不重复计数；祁连新内容进增量
      expect(newIds).not.toContain('xhs:abc123')
      expect(newIds).toContain('xhs:new987')

      // intel 投影里 abc123 仅保留 1 条（内容分母，未因渠道前缀复制）
      const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) as IntelItem[]
      expect(intel.filter((i) => /:abc123$/.test(i.id))).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同轮 l0:/xhs: 内容归一为 1 条，但每个原始观察保留 provenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-b3-t9-same-round-'))
    try {
      const store = new TravelStore(root)
      const setup = await runIntake(
        { slots: { destination: '青甘大环线', dateStart: '2026-10-01', dateEnd: '2026-10-03' } },
        store,
      )
      const l0: IntelItem = { ...mkIntel('l0:abc123', 'L0 同笔记'), channel: 'xhs-l0' }
      const xhs: IntelItem = { ...mkIntel('xhs:abc123', '登录态同笔记'), channel: 'xhs-mcp' }
      const channels: ResearchChannel[] = [
        { name: 'l0-observer', available: async () => true, run: async () => ({ ok: true, items: [l0] }) },
        { name: 'xhs-observer', available: async () => true, run: async () => ({ ok: true, items: [xhs] }) },
      ]

      const result = await runResearchDestination(
        { planId: setup.planId, categories: ['recommend'], keywords: ['敦煌'] },
        store,
        { channels, retryDelaysMs: [] },
      )
      const round = result.round!
      const observations = round.channels.flatMap((entry) => entry.observations ?? [])

      expect(result.itemCount).toBe(1) // 同轮 contentDedup 后的聚合条目数
      expect(round.keptRawCount).toBe(2) // 两条 accepted 原始观察，独立于聚合数
      expect(round.newItemIds).toHaveLength(1)
      expect(observations).toHaveLength(2)
      expect(observations.map((observation) => observation.itemId).sort()).toEqual(['l0:abc123', 'xhs:abc123'])
      expect(new Set(observations.map((observation) => observation.contentId))).toEqual(new Set(['abc123']))
      expect(new Set(observations.map((observation) => observation.provenanceKey))).toHaveLength(2)
      for (const observation of observations) {
        expect(observation.provenanceKey).toBe(
          `${round.roundId}:${observation.channel}:${observation.contentId}`,
        )
      }
      const intel = (await store.readJson<IntelItem[]>(setup.planId, 'intel.json')) ?? []
      expect(intel).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('B3 T9/P0-C R2：双键兼容（query scope 审计 + per-observation provenance）', () => {
  /** 与 research-loop 一致的确定性脚本渠道（记录原始执行，防幂等误判）。 */
  function mkScopeItem(id: string, title: string, cat: IntelItem['category'] = 'recommend'): IntelItem {
    return {
      id, category: cat, channel: 'web', title, summary: `${title} 摘要`,
      source: { platform: 'test', url: `https://example.invalid/note/${id}`, fetchedAt: '2026-09-01T00:00:00.000Z' },
      confidence: 'medium',
    }
  }
  function scopeChannel(hits: Record<string, IntelItem[]>): ResearchChannel & { calls: string[] } {
    const calls: string[] = []
    const channel: ResearchChannel = {
      name: 'l2-direct',
      async available() { return true },
      async run(query: CanonicalQuery): Promise<ResearchChannelOutcome> {
        calls.push((query.keywords ?? []).join(' '))
        const items = hits[(query.keywords ?? [])[0] ?? ''] ?? []
        return items.length > 0 ? { ok: true, items } : { ok: false, code: 'EMPTY', reason: 'no hits' }
      },
    }
    return Object.assign(channel, { calls })
  }
  async function makeScopePlan(): Promise<{ store: TravelStore; planId: string; root: string }> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-b3-r2-'))
    const store = new TravelStore(root)
    const setup = await runIntake(
      { slots: { destination: '青甘大环线', dateStart: '2026-10-01', dateEnd: '2026-10-03' } },
      store,
    )
    return { store, planId: setup.planId, root }
  }

  it('同参 query scopeKey 确定相等；换关键词可由 query 审计追溯且 provenance 独立', async () => {
    const { store, planId, root } = await makeScopePlan()
    try {
      const ar = scopeChannel({ 敦煌: [mkScopeItem('web:a1', '敦煌A')] })
      const r1 = await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['敦煌'] }, store,
        { channels: [ar], retryDelaysMs: [] },
      )
      // 同参（缺 requestId → 新建轮次）第二次 → 不能生产新内容，仍按真实内容去重
      const br = scopeChannel({ 敦煌: [mkScopeItem('web:a2', '敦煌A2')] })
      const r2 = await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['敦煌'] }, store,
        { channels: [br], retryDelaysMs: [] },
      )
      const s1 = (r1.round!.query as { scopeKey: string }).scopeKey
      const s2 = (r2.round!.query as { scopeKey: string }).scopeKey
      // scopeKey 仅是 query 级确定性审计——同参必同、稳定复制，非时钟；不是 dedup。
      expect(typeof s1).toBe('string')
      expect(s1).toBeTruthy()
      expect(s2).toBe(s1)

      const cr = scopeChannel({ 祁连: [mkScopeItem('web:q', '祁连 甘南')] })
      const r3 = await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['祁连'] }, store,
        { channels: [cr], retryDelaysMs: [] },
      )
      const s3 = (r3.round!.query as { scopeKey: string }).scopeKey
      // 换关键词 → query scope 审计印记必不同；内容 dedup 仍不读取该印记。
      expect(s3).not.toBe(s1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('新并入 itemIndex 保留对应 provenance；query scope 仍仅在 round.query 可见', async () => {
    const { store, planId, root } = await makeScopePlan()
    try {
      const ch = scopeChannel({ 门源: [mkScopeItem('web:m1', '门源 油菜花')] })
      await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['门源'] }, store,
        { channels: [ch], retryDelaysMs: [] },
      )
      const state = await store.loadResearchState<ResearchState>(planId)
      expect(state).toBeDefined()
      expect(state!.itemIndex.length).toBe(1)
      const round = await store.readResearchRound<ResearchRound>(planId, state!.rounds[0])
      const observation = round!.channels.flatMap((entry) => entry.observations ?? [])
        .find((item) => item.itemId === 'web:m1')
      const indexItem = state!.itemIndex[0]

      expect(round!.query.scopeKey).toMatch(/^scope:/)
      expect(round!.query.scopeKey).not.toBe('') // query audit 绝非固定空串
      expect(observation).toBeDefined()
      expect(indexItem.itemId).toBe('web:m1') // 裸 itemId 仍供正文/行程引用
      expect(indexItem.provenanceKey).toBe(observation!.provenanceKey)
      expect(indexItem.provenanceKey).toBe(`${round!.roundId}:web:web:m1`)
      expect(indexItem.provenanceKey).not.toMatch(/^scope:/)
      expect(Object.prototype.hasOwnProperty.call(indexItem, 'scopeKey')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧 itemIndex.scopeKey 可读取并在下一轮迁移掉，不影响裸引用', async () => {
    const { store, planId, root } = await makeScopePlan()
    try {
      await store.saveResearchState(planId, {
        schemaVersion: 1,
        researchVersion: 0,
        updatedAt: new Date(0).toISOString(),
        rounds: [],
        budget: { usedRounds: 0, maxRoundsPerPlan: 16, exhausted: false },
        sources: [],
        itemIndex: [{
          itemId: 'web:legacy', roundId: 'old-round', channel: 'web', title: '旧条目',
          scopeKey: 'scope:legacy-only',
        }],
      })
      await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['门源'] }, store,
        { channels: [scopeChannel({ 门源: [mkScopeItem('web:new1', '门源 新')] })], retryDelaysMs: [] },
      )
      const state = await store.loadResearchState<ResearchState>(planId)
      expect(state!.itemIndex.map((item) => item.itemId)).toEqual(['web:legacy', 'web:new1'])
      expect(Object.prototype.hasOwnProperty.call(state!.itemIndex[0], 'scopeKey')).toBe(false)
      expect(state!.itemIndex[0]!.itemId).toBe('web:legacy')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('跨轮重复保留 round2 provenance；真新内容进 newItemIds 且 index 可追溯', async () => {
    const { store, planId, root } = await makeScopePlan()
    try {
      const r1ch = scopeChannel({ 敦煌: [mkScopeItem('web:d1', '敦煌 鸣沙山')] })
      const r1 = await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['敦煌'] }, store,
        { channels: [r1ch], retryDelaysMs: [] },
      )
      expect((r1.round as unknown as { newItemIds: string[] }).newItemIds).toEqual(['web:d1'])

      // 第二轮仅重复旧 note 内容 id → 跨轮归一，零 index 追加；round2 仍保留观察 provenance。
      const bch = scopeChannel({ 敦煌: [mkScopeItem('web:d1', '敦煌 鸣沙山 复现')] })
      const r2 = await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['敦煌'] }, store,
        { channels: [bch], retryDelaysMs: [] },
      )
      // 相同 query/关键词 → 内容已并入则不再翻倍 intel（round 仍记账，跨轮 union 单行）
      expect((r2.round as unknown as { newItemIds: string[] }).newItemIds).toEqual([])
      const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) as IntelItem[]
      expect(intel.length).toBe(1)
      const r1Observation = r1.round!.channels.flatMap((entry) => entry.observations ?? [])[0]
      const r2Observation = r2.round!.channels.flatMap((entry) => entry.observations ?? [])[0]
      expect(r1Observation).toMatchObject({ itemId: 'web:d1', contentId: 'web:d1' })
      expect(r2Observation).toMatchObject({ itemId: 'web:d1', contentId: 'web:d1' })
      expect(r2Observation!.provenanceKey).toBe(`${r2.round!.roundId}:web:web:d1`)
      expect(r2Observation!.provenanceKey).not.toBe(r1Observation!.provenanceKey)

      const r3ch = scopeChannel({ 祁连: [mkScopeItem('web:g1', '祁连 央隆 新')] })
      const r3 = await runResearchDestination(
        { planId, categories: ['recommend'], keywords: ['祁连'] }, store,
        { channels: [r3ch], retryDelaysMs: [] },
      )
      // 区域异新内容的第二轮 → 新条目进增量（round/query 携带不覆盖跨轮去重的“真新才并入”）
      expect((r3.round as unknown as { newItemIds: string[] }).newItemIds).toEqual(['web:g1'])
      const intel2 = (await store.readJson<IntelItem[]>(planId, 'intel.json')) as IntelItem[]
      // 被归一老条目不因 round/query 键重入；祁连真新内容并入
      const seen = intel2.map((i) => i.id).sort()
      expect(seen).toEqual(['web:d1', 'web:g1'])
      const state2 = await store.loadResearchState<ResearchState>(planId)
      expect(state2!.researchVersion).toBe(3)
      expect(state2!.budget.usedRounds).toBe(3)
      // 新并入条目（web:g1）的 index provenance 命中其并入轮；query scope 仍只在 round.query。
      const r3rounds = await store.readResearchRound<ResearchRound>(planId, state2!.rounds[2])
      const r3Observation = r3rounds!.channels.flatMap((entry) => entry.observations ?? [])
        .find((observation) => observation.itemId === 'web:g1')
      const idxG1 = state2!.itemIndex.find((it) => it.itemId === 'web:g1')
      expect(idxG1).toBeDefined()
      expect(r3Observation).toBeDefined()
      expect(idxG1!.provenanceKey).toBe(r3Observation!.provenanceKey)
      expect(idxG1!.provenanceKey).toBe(`${r3rounds!.roundId}:web:web:g1`)
      expect(Object.prototype.hasOwnProperty.call(idxG1, 'scopeKey')).toBe(false)
      expect(r3rounds!.query.scopeKey).toMatch(/^scope:/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
