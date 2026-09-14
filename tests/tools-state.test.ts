/**
 * travel_get_state 单测（进度/产物/NFR-9 + 明确 not-found 不崩）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { projectState, runGetState } from '../src/tools/state.js'
import { runIntake } from '../src/tools/intake.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-state-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('get_state 主路径', () => {
  it('intake 后查询：status/slots/artifacts 齐备', async () => {
    const created = await runIntake({
      slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
    }, store)
    const state = await runGetState({ planId: created.planId }, store)
    expect(state.found).toBe(true)
    expect(state.status).toBe('confirmed')
    expect(state.slots?.destination).toBe('杭州')
    expect(state.artifacts).toContain('request.json')
    expect(state.degraded).toEqual([])
    expect(state.updatedAt).toBeDefined()
  })

  it('计划不存在 → 明确 not_found（不抛崩溃）', async () => {
    const state = await runGetState({ planId: 'plan-no-such' }, store)
    expect(state.found).toBe(false)
    expect(state.status).toBe('not_found')
    expect(state.artifacts).toEqual([])
    expect(state.updatedAt).toBeUndefined()
    // 宿主 lossless-JSON 回归：投影输出须 JSON 往返无损（无显式 undefined 键）
    const projected = projectState(state) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(projected))).toEqual(projected)
    expect(Object.keys(projected)).not.toContain('slots')
    expect(Object.keys(projected)).not.toContain('updatedAt')
  })

  it('无 planId → 定位最近计划', async () => {
    await runIntake({ slots: { destination: '北京' } }, store)
    await new Promise((r) => setTimeout(r, 10)) // 保证 updatedAt 顺序
    const newer = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    const state = await runGetState({}, store)
    expect(state.found).toBe(true)
    expect(state.planId).toBe(newer.planId)
    expect(state.slots?.destination).toBe('杭州')
  })

  it('无任何计划 → not_found（不崩）', async () => {
    const state = await runGetState({}, store)
    expect(state.found).toBe(false)
    expect(state.status).toBe('not_found')
  })

  it('degraded 记账在 get_state 汇总', async () => {
    const created = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    await store.recordDegraded(created.planId, { source: 'amap', code: 'UNAVAILABLE', reason: 'Key 未配置', at: '2026-09-01T00:00:00.000Z' })
    const state = await runGetState({ planId: created.planId }, store)
    expect(state.degraded).toHaveLength(1)
    expect(state.degraded[0]?.reason).toBe('Key 未配置')
  })
})

// ────────────────────────── DR2：research 视图消费抓取失败索引 ──────────────────────────

describe('DR2：research 视图消费 fetchFailures（count/最近一条/恢复动作）', () => {
  it('research-state 有持久化抓取失败 → view 含 count/recent/recovery', async () => {
    const created = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    await store.saveResearchState(created.planId, {
      schemaVersion: 1,
      researchVersion: 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
      rounds: ['round-1'],
      budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false },
      sources: ['tencent-poi'],
      itemIndex: [{
        itemId: 'web:a', roundId: 'round-1', channel: 'web', title: '西宁 A',
        provenanceKey: 'round-1:web:web:a',
      }],
      fetchFailures: [
        { itemId: 'web:a', code: 'UNAVAILABLE', reason: '抓取失败：HTTP 403 风控', at: '2026-09-02T01:00:00.000Z' },
        { itemId: 'web:b', code: 'TIMEOUT', reason: '抓取失败：超时', at: '2026-09-02T02:00:00.000Z' },
      ],
    })
    const state = await runGetState({ planId: created.planId }, store)
    const r = state.research
    expect(r).toBeDefined()
    expect(r!.fetchFailures).toBeDefined()
    expect(r!.fetchFailures!.count).toBe(2)
    expect(r!.fetchFailures!.recent?.itemId).toBe('web:b')
    expect(r!.fetchFailures!.recent?.code).toBe('TIMEOUT')
    expect(r!.fetchFailures!.recovery).toMatch(/清除/)
    expect(r!.items[0]?.provenanceKey).toBe('round-1:web:web:a')
    expect(r!.items[0]?.itemId).toBe('web:a')
  })

  it('无 fetchFailures → research 视图不输出 fetchFailures 键（空面板不出现）', async () => {
    const created = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    await store.saveResearchState(created.planId, {
      schemaVersion: 1,
      researchVersion: 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
      rounds: [],
      budget: { usedRounds: 0, maxRoundsPerPlan: 16, exhausted: false },
      sources: [],
      itemIndex: [],
    })
    const state = await runGetState({ planId: created.planId }, store)
    expect(state.research?.fetchFailures).toBeUndefined()
  })
})