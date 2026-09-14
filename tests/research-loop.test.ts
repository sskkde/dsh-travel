/**
 * W1 DR1（T5）+ DR3（T7）研究闭环单测：
 * - D1 可控搜索多轮增量：两轮累积 + 跨轮 contentDedup 去重，观察 provenance 与轮次/研究状态落盘；
 * - D1 idempotent：requestId 同参重放零重复执行、回显原 observedAt；同 ID 异参拒绝；
 * - D1 分页能力诚实：无分页适配器如实标注（不伪造翻页）；
 * - D1 discovery-only：仅兴趣种子无 destination 可先做发现；两者皆缺 → missing 回执；
 * - D1 研究额度：注入小额度 fixture → budget_exhausted 而非 sufficient；
 * - D1 sources 白名单：未知源拒绝。
 * 全确定性 fixture 注入，零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { runFetchResearchContent } from '../src/tools/research-content.js'
import {
  runRecordResearchAssessment, computeResearchStatus,
} from '../src/tools/research-assessment.js'
import type { ResearchChannel, ResearchChannelOutcome } from '../src/orchestrator/types.js'
import type { CanonicalQuery } from '../src/adapters/base.js'
import { SourceGovernanceError } from '../src/errors.js'
import type { IntelCategory, IntelItem, IntelChannel, ResearchRound, ResearchState } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-loop-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 确定性脚本渠道：记录每次执行（幂等 → 零重复执行断言用）。 */
interface ScriptedChannel {
  channel: ResearchChannel
  /** 每次 run 的查询快照（幂等零重复执行断言）。 */
  calls: string[]
}

function scriptedChannel(opts: {
  name: string
  run: (query: CanonicalQuery) => IntelItem[] | undefined | Promise<IntelItem[] | undefined>
}): ScriptedChannel {
  const calls: string[] = []
  const channel = {
    name: opts.name,
    async available() {
      return true
    },
    async run(query: CanonicalQuery): Promise<ResearchChannelOutcome> {
      calls.push(JSON.stringify({ keywords: query.keywords ?? null, destination: query.destination ?? null }))
      const items = await opts.run(query)
      if (items === undefined || items.length === 0) {
        return { ok: false, code: 'EMPTY' as const, reason: 'scripted no hits' }
      }
      return { ok: true, items }
    },
  }
  return { channel, calls }
}

let seq = 0
function mkItem(id: string, channel: IntelChannel, title: string, category: IntelCategory = 'recommend'): IntelItem {
  seq += 1
  return {
    id,
    category,
    channel,
    title,
    summary: `摘要 ${title}`,
    source: { platform: 'scripted', url: `https://example.invalid/item/${id}`, fetchedAt: `2026-09-0${(seq % 9) + 1}T00:00:00.000Z` },
    confidence: 'medium',
  }
}

async function makePlan(opts: {
  destination?: string
  researchIntent?: { text: string; keywords?: string[] }
  rawSlotsOnly?: boolean
} = {}): Promise<string> {
  const slots: Record<string, unknown> = {
    dateStart: '2026-10-01',
    dateEnd: '2026-10-03',
  }
  if (opts.destination) slots.destination = opts.destination
  if (opts.researchIntent) slots.researchIntent = opts.researchIntent
  const result = await runIntake({ slots }, store)
  return result.planId
}

function deps(channels: ResearchChannel[], env?: Record<string, string>): { channels: ResearchChannel[]; env: { readSettings: (k: string) => string | undefined; env: Record<string, string> } } {
  const readSettings = (key: string): string | undefined => env?.[key]
  return { channels, env: { readSettings, env: env ?? {} } }
}

function chanOf(sc: ScriptedChannel): ResearchChannel {
  return sc.channel
}

describe('DR1：可控搜索多轮增量（两轮累积 + 跨轮去重 + 轮次/状态落盘）', () => {
  it('F1c-E：新计划默认调用（无 DR 参数）也写轮次 + 推进 researchVersion（DR3 失效链触发）', async () => {
    // 新计划（destination-only，confirmed → flowVersion='1'）→ 缺省调用即 DR 轮
    const planId = await makePlan({ destination: '西宁' })
    expect((await store.loadRequest(planId))?.flowVersion).toBe('1')
    const sc = scriptedChannel({ name: 'web', run: () => [mkItem('web:def1', 'web', '西宁 默认轮')] })
    const d = deps([chanOf(sc)])
    const r1 = await runResearchDestination({ planId }, store, d) // 缺省调用：无 keywords/requestId
    expect(r1.round).toBeDefined()
    expect(r1.round!.query.keywords).toEqual(['西宁']) // 种子词（destination 映射）规范化
    expect(r1.round!.budget.usedRounds).toBe(1)

    // 再跑一次 → 第二轮，版本推进（每次新检索可新增/更新情报；DR3 失效链随版本推进）
    const r2 = await runResearchDestination({ planId }, store, d)
    expect(r2.round).toBeDefined()
    const state = await store.loadResearchState<ResearchState>(planId)
    expect(state!.rounds).toHaveLength(2)
    expect(state!.researchVersion).toBe(2)
    expect(state!.budget.usedRounds).toBe(2)
  })

  it('第一轮"西宁"、第二轮"青甘大环线/敦煌"：两轮记录均存在、跨轮去重保留、研究状态版本推进', async () => {
    const planId = await makePlan({ destination: '西宁', researchIntent: { text: '青甘大环线攻略' } })
    // 脚本渠道按查询命中返回稳定 id：round1 = a,b；round2 重复 b + 新增 c
    const sc = scriptedChannel({
      name: 'web',
      run: (q) => {
        const words = q.keywords ?? []
        if (words.some((w) => w.includes('西宁'))) {
          return [mkItem('web:a', 'web', '西宁 攻略 A'), mkItem('web:b', 'web', '西宁 景点 B')]
        }
        if (words.some((w) => w.includes('敦煌'))) {
          return [mkItem('web:b', 'web', '西宁 景点 B'), mkItem('web:c', 'web', '敦煌 鸣沙山 C')]
        }
        return undefined
      },
    })
    const d = deps([chanOf(sc)])

    const r1 = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'req-1' }, store, d)
    expect(r1.round).toBeDefined()
    expect(r1.round!.newItemIds).toEqual(['web:a', 'web:b'])

    const r2 = await runResearchDestination({ planId, keywords: ['敦煌'], requestId: 'req-2' }, store, d)
    expect(r2.round).toBeDefined()
    // 跨轮去重：b 已存在 → 本轮仅新增 c
    expect(r2.round!.newItemIds).toEqual(['web:c'])
    // itemCount = 本轮 fanout contentDedup 后条数；跨轮重复 b 不进入 union/newItemIds。
    expect(r2.itemCount).toBe(2)

    const state = await store.loadResearchState<ResearchState>(planId)
    expect(state).toBeDefined()
    expect(state!.rounds).toHaveLength(2)
    expect(state!.researchVersion).toBe(2)
    expect(state!.budget.usedRounds).toBe(2)

    // 轮次记录存在且各自携带轮内关键词/来源/ID
    const round1 = await store.readResearchRound<ResearchRound>(planId, state!.rounds[0])
    const round2 = await store.readResearchRound<ResearchRound>(planId, state!.rounds[1])
    expect(round1!.query.keywords).toEqual(['西宁'])
    expect(round2!.query.keywords).toEqual(['敦煌'])
    expect(round1!.roundId !== round2!.roundId).toBe(true)
    const round1Observations = round1!.channels.flatMap((entry) => entry.observations ?? [])
    const round2Observations = round2!.channels.flatMap((entry) => entry.observations ?? [])
    expect(round1Observations.map((observation) => observation.itemId)).toEqual(['web:a', 'web:b'])
    expect(round2Observations.map((observation) => observation.itemId)).toEqual(['web:b', 'web:c'])
    expect(round2Observations.find((observation) => observation.itemId === 'web:b')!.provenanceKey)
      .toBe(`${round2!.roundId}:web:web:b`)

    // intel 投影 = contentDedup 后的 union（a,b,c 各一条）；provenance 不改变裸引用。
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    const ids = intel.map((i) => i.id).sort()
    expect(ids).toEqual(['web:a', 'web:b', 'web:c'])
    expect(intel.length).toBe(3)
  })

  it('分页能力诚实：无分页适配器翻页能力 → pagination="none"（不伪造翻页）', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:p', 'web', '单一页'),
        { ...mkItem('web:q', 'web', '第二项'), id: 'web:q' }],
    })
    const r = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'req-p' }, store, deps([chanOf(sc)]))
    const round = r.round!
    // 适配器未实现分页 → 渠道回执声明 pagination:'none'（草稿 45：不反复第一页声称已翻页）
    expect(round.channels.length).toBeGreaterThanOrEqual(1)
    for (const entry of round.channels) {
      expect(entry.pagination).toBe('none')
    }
  })
})

describe('DR1：requestId 幂等（同参重放零重复执行 + 回显原 observedAt；异参拒绝）', () => {
  it('同 requestId 同参 → 回显原 observedAt，渠道零重复执行', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:x', 'web', '西宁 X')],
    })
    const d = deps([chanOf(sc)])

    const r1 = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'idem-1' }, store, d)
    const firstCalls = sc.calls.length
    expect(firstCalls).toBe(1)
    const r1ObservedAt = r1.round!.observedAt

    // 同 ID 同参：不重新执行（渠道零重复），回显原轮次 observedAt
    const r2 = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'idem-1' }, store, d)
    expect(sc.calls.length).toBe(firstCalls) // 零重复执行
    expect(r2.idempotent).toBeDefined()
    expect(r2.idempotent!.requestId).toBe('idem-1')
    expect(r2.idempotent!.observedAt).toBe(r1ObservedAt) // 原 observedAt，不伪装新采集
    // 幂等命中不新建轮次、不推进版本
    const state = await store.loadResearchState<ResearchState>(planId)
    expect(state!.rounds).toHaveLength(1)
    expect(state!.researchVersion).toBe(1)
  })

  it('同 requestId 异参 → 拒绝（幂等仅允许同参重放）', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:y', 'web', '西宁 Y')],
    })
    const d = deps([chanOf(sc)])
    await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'idem-2' }, store, d)
    await expect(
      runResearchDestination({ planId, keywords: ['敦煌'], requestId: 'idem-2' }, store, d),
    ).rejects.toThrow(/幂等仅允许同参重放/)
  })
})

describe('DR1：discovery-only 与 missing 回执', () => {
  it('仅 researchIntent 无 destination → discovery-only 可先做情报发现', async () => {
    const planId = await makePlan({ researchIntent: { text: '青甘大环线', keywords: ['青甘大环线攻略'] } })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:disc', 'web', '青甘大环线攻略')],
    })
    const r = await runResearchDestination({ planId, keywords: ['青甘大环线'] }, store, deps([chanOf(sc)]))
    expect(r.round).toBeDefined()
    expect(r.round!.initiator).toBe('discovery') // 无 destination → discovery 触发
    expect(r.round!.query.keywords).toEqual(['青甘大环线'])
  })

  it('无 destination 且无 researchIntent 的发现请求 → 明确 missing 回执', async () => {
    const planId = await makePlan({ rawSlotsOnly: true }) // 只有日期，无 destination / researchIntent
    await expect(
      runResearchDestination({ planId, keywords: ['x'] }, store, deps([])),
    ).rejects.toThrow(/missing receipt/)
  })
})

describe('DR1：研究额度（deep.maxRoundsPerPlan）边界 → budget_exhausted 而非 sufficient', () => {
  it('小额度 fixture（maxRoundsPerPlan=1）：第二轮到边界 → budget_exhausted 含 used/remaining/恢复动作', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:b1', 'web', '西宁')],
    })
    const d = deps([chanOf(sc)], { 'research.deep.maxRoundsPerPlan': '1' })

    const r1 = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'budget-1' }, store, d)
    expect(r1.round).toBeDefined()
    expect(r1.round!.budget.exhausted).toBe(true) // 1/1 已用尽

    const r2 = await runResearchDestination({ planId, keywords: ['敦煌'], requestId: 'budget-2' }, store, d)
    expect(r2.budgetExhausted).toBeDefined()
    expect(r2.budgetExhausted!.usedRounds).toBe(1)
    expect(r2.budgetExhausted!.maxRoundsPerPlan).toBe(1)
    expect(r2.budgetExhausted!.remainingRounds).toBe(0)
    expect(r2.budgetExhausted!.recovery.length).toBeGreaterThan(0)
    // 不标 sufficient：与 sufficient 字段互斥
    expect(r2.round).toBeUndefined()
    // 未执行新一轮（非完成、不可自动加额）
    const state = await store.loadResearchState<ResearchState>(planId)
    expect(state!.rounds).toHaveLength(1)
  })
})

describe('DR1：sources 白名单', () => {
  it('未知来源 → 明确拒绝（SourceGovernanceError）', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:z', 'web', '西宁 Z')],
    })
    await expect(
      runResearchDestination({ planId, keywords: ['西宁'], sources: ['not-a-source'] }, store, deps([chanOf(sc)])),
    ).rejects.toThrow(SourceGovernanceError)
  })

  it('DR 版本过期（expectedResearchVersion 不符）→ 迟到写拒绝', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({
      name: 'web',
      run: () => [mkItem('web:v', 'web', '西宁 V')],
    })
    const d = deps([chanOf(sc)])
    await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'ver-1' }, store, d)
    // 当前版本=1；按过期版本 0 发起 → 迟到写拒绝（草稿 56）
    await expect(
      runResearchDestination({ planId, keywords: ['敦煌'], requestId: 'ver-2', expectedResearchVersion: 0 }, store, d),
    ).rejects.toThrow(/研究版本过期/)
  })
})

describe('DR3（T7）：调用方 assessment 与充分性版本门（完整串联）', () => {
  function assessmentDeps() {
    const sc = scriptedChannel({ name: 'web', run: (q) => {
      const words = q.keywords ?? []
      if (words.includes('反证')) return [mkItem('web:ref', 'web', '反证条目 F')]
      return [mkItem('web:a', 'web', '西宁景点 A'), mkItem('web:b', 'web', '西宁住宿 B')]
    } })
    return { channels: [chanOf(sc)], calls: sc.calls }
  }

  it('摘要→选正文→continue→补搜反证→纠错→sufficient→resolve 全串联', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const d = assessmentDeps()

    // ① 搜索（摘要）
    const r1 = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'chain-1' }, store, d)
    expect(r1.round).toBeDefined()

    // ② 选正文（对 web:a 取正文）
    const fetch = await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, {
      fetchBody: async () => ({ ok: true, body: 'A 正文：莫高窟参观需预约' }),
      env: { readSettings: () => undefined, env: {} },
    })
    expect(fetch.items[0].ok).toBe(true)
    const fetchedState = await store.loadResearchState<ResearchState>(planId)
    const fetchedIndex = fetchedState!.itemIndex.find((entry) => entry.itemId === 'web:a')
    expect(fetchedIndex?.provenanceKey).toBe(`${r1.round!.roundId}:web:web:a`)
    expect(fetchedIndex?.contentRef).toBe('web:a')
    expect(fetchedIndex?.contentRef).not.toBe(fetchedIndex?.provenanceKey) // 不把 provenance 复合键当正文引用

    // ③ continue：信息不足，需补搜反证
    const c1 = await runRecordResearchAssessment({
      planId, verdict: 'continue', rationale: '需核实门票预约', evidenceRefs: ['web:a'],
    }, store)
    expect(c1.verdict).toBe('continue')
    expect((await computeResearchStatus(store, planId)).ready).toBe(false)

    // ④ 补搜反证（第二轮 → 版本推进，旧的 continue 不复活）
    const r2 = await runResearchDestination({ planId, keywords: ['反证'], requestId: 'chain-2' }, store, d)
    expect(r2.round!.newItemIds).toContain('web:ref')

    // ⑤ 纠错：质疑并基于新证据提交 sufficient
    const s1 = await runRecordResearchAssessment({
      planId, verdict: 'sufficient', rationale: '已核实预约与反证', evidenceRefs: ['web:a', 'web:ref'],
    }, store)
    expect(s1.verdict).toBe('sufficient')
    // 新 assessment 取代旧 continue（保留历史）
    expect(s1.supersededAssessmentId).toBe(c1.assessmentId)
    const prior = await store.readResearchAssessment(planId, c1.assessmentId)
    expect(prior).toBeDefined() // 历史保留不删除
    expect((prior as { supersededBy?: string }).supersededBy).toBe(s1.assessmentId)

    // ⑥ resolve 门：当前 sufficient 引用当前版本 → ready
    const status = await computeResearchStatus(store, planId)
    expect(status.ready).toBe(true)
    expect(status.reason).toBe('ready')

    // ⑦ 新证据使旧 sufficient 失效：再补一轮 → stale_version，不复活
    await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'chain-3' }, store, d)
    const afterNewRound = await computeResearchStatus(store, planId)
    expect(afterNewRound.ready).toBe(false)
    expect(afterNewRound.missing).toBe('stale_version')
    // 旧 sufficient 仍保留在历史（不删除）
    const saved = await store.readResearchAssessment(planId, s1.assessmentId)
    expect(saved).toBeDefined()
  })

  it('evidenceRefs 引用不存在的证据 → 拒绝', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const d = assessmentDeps()
    await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'ev-1' }, store, d)
    await expect(
      runRecordResearchAssessment({ planId, verdict: 'sufficient', rationale: 'x', evidenceRefs: ['nope-item'] }, store),
    ).rejects.toThrow(/不存在的证据/)
  })

  it('expectedResearchVersion 过期（迟到写）→ 拒绝', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const d = assessmentDeps()
    await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'late-1' }, store, d)
    await expect(
      runRecordResearchAssessment({ planId, expectedResearchVersion: 99, verdict: 'sufficient', rationale: 'x' }, store),
    ).rejects.toThrow(/研究版本过期/)
  })

  it('预算耗尽不产生 sufficient → 拒绝', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const sc = scriptedChannel({ name: 'web', run: () => [mkItem('web:bd', 'web', '西宁')] })
    const d = deps([chanOf(sc)], { 'research.deep.maxRoundsPerPlan': '1' })
    await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'bd-1' }, store, d) // 1/1 用尽
    await expect(
      runRecordResearchAssessment({ planId, verdict: 'sufficient', rationale: 'x' }, store),
    ).rejects.toThrow(/不能提交 sufficient/)
  })
})
