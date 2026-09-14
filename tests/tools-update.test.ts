/**
 * travel_update_request 单测（patch 合并 / 推荐回注 / 状态机约束 / rerunHints）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake, type IntakeArgs } from '../src/tools/intake.js'
import { runUpdate } from '../src/tools/update.js'
import { InvalidTransitionError, TravelValidationError } from '../src/errors.js'
import type { RequestStatus } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-update-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const base: IntakeArgs = {
  slots: {
    destination: '杭州',
    dateStart: '2026-10-01',
    dateEnd: '2026-10-03',
    days: 3,
    travelers: { adults: 2 },
    budget: { amount: 5000 },
  },
}

describe('patch 合并（未补字段保留原值）', () => {
  it('顶层未补字段保留；补丁字段覆盖', async () => {
    const created = await runIntake(base, store)
    const updated = await runUpdate({ planId: created.planId, patch: { slots: { destination: '苏州' } } }, store)
    expect(updated.found).toBe(true)
    expect(updated.confirmedSlots.destination).toBe('苏州')
    expect(updated.confirmedSlots.dateStart).toBe('2026-10-01')
    expect(updated.confirmedSlots.days).toBe(3)
    expect(updated.confirmedSlots.budget?.amount).toBe(5000)
  })

  it('travelers/budget 一级深合并（补子字段保留其余）', async () => {
    const created = await runIntake(base, store)
    const updated = await runUpdate({ planId: created.planId, patch: { slots: { travelers: { children: 1 } } } }, store)
    expect(updated.confirmedSlots.travelers?.adults).toBe(2) // 未补保留
    expect(updated.confirmedSlots.travelers?.children).toBe(1) // 补丁生效
    expect(updated.confirmedSlots.budget?.amount).toBe(5000)
  })

  it('补丁含非法值（days 与区间不一致）→ 校验错误且不覆盖落盘', async () => {
    const created = await runIntake(base, store)
    await expect(runUpdate({ planId: created.planId, patch: { slots: { days: 5 } } }, store))
      .rejects.toThrow(TravelValidationError)
    const after = await store.loadRequest(created.planId)
    expect(after?.slots.days).toBe(3)
  })
})

describe('推荐模式回注（§5.4）', () => {
  it('recommend → 回注 destination → collecting（补齐其余）→ confirmed（齐全）', async () => {
    const created = await runIntake({ mode: 'recommend', slots: { dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    expect(created.status).toBe('recommending')

    // 回注目的地的同时补齐其余槽位 → 直达 confirmed
    const backfilled = await runUpdate({ planId: created.planId, patch: { slots: { destination: '杭州' } } }, store)
    expect(backfilled.status).toBe('confirmed')
    expect(backfilled.missing).toEqual([])
    expect(backfilled.rerunHints).toContain('travel_research_destination')
  })

  it('recommend → 回注 destination 但日期仍缺 → collecting（collecting 补齐其余槽位）', async () => {
    const created = await runIntake({ mode: 'recommend', slots: { dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    const updated = await runUpdate({ planId: created.planId, patch: { slots: { destination: '杭州' } } }, store)
    expect(updated.status).toBe('confirmed') // 日期已齐
    // 新开一个只留推荐意图 + 日期缺的场景
    const partial = await runIntake({ mode: 'recommend', slots: {} }, store)
    const partialUpdate = await runUpdate({ planId: partial.planId, patch: { slots: { destination: '杭州' } } }, store)
    expect(partialUpdate.status).toBe('collecting')
    expect(partialUpdate.missing).toEqual(expect.arrayContaining(['dateStart', 'dateEnd', 'days']))
  })
})

describe('状态机约束（非法转换拒）', () => {
  async function planIn(status: RequestStatus): Promise<string> {
    const created = await runIntake(base, store)
    const request = await store.loadRequest(created.planId)
    if (request === undefined) throw new Error('missing request')
    await store.saveRequest({ ...request, status })
    return created.planId
  }

  it('delivered 修订入口 → revising；空补丁保持 delivered', async () => {
    const planId = await planIn('delivered')
    const revised = await runUpdate({ planId, patch: { slots: { destination: '南京' } } }, store)
    expect(revised.status).toBe('revising')

    const noopPlanId = await planIn('delivered')
    const noop = await runUpdate({ planId: noopPlanId, patch: { slots: {} } }, store)
    expect(noop.status).toBe('delivered')
  })

  it('researching 仍为锁定态；generating 无外部在途时可修订', async () => {
    const researchingPlanId = await planIn('researching')
    await expect(runUpdate({ planId: researchingPlanId, patch: { slots: { destination: '南京' } } }, store))
      .rejects.toThrow(InvalidTransitionError)
    await expect(runUpdate({ planId: researchingPlanId, patch: { slots: { destination: '南京' } } }, store))
      .rejects.toThrow(/锁定态/)

    const generatingPlanId = await planIn('generating')
    const revised = await runUpdate({ planId: generatingPlanId, patch: { slots: { destination: '南京' } } }, store)
    expect(revised.status).toBe('revising')
    expect((await store.loadRequest(generatingPlanId))?.status).toBe('revising')
  })

  it('confirmed 槽位完整刷新 → 保持 confirmed + rerunHints；空串等非法值被校验拒绝', async () => {
    const planId = await planIn('confirmed')
    const refreshed = await runUpdate({ planId, patch: { slots: { destination: '南京' } } }, store)
    expect(refreshed.status).toBe('confirmed')
    expect(refreshed.rerunHints).toContain('travel_research_destination')

    // 非法清空（空串目的地）→ 字段校验拒绝（confirmed→collecting 的缺失路径被校验闸门拦下）
    await expect(runUpdate({ planId, patch: { slots: { destination: '' } } }, store)).rejects.toThrow(TravelValidationError)
  })

  it('计划不存在 → not-found 结构化返回（不抛崩溃）', async () => {
    const result = await runUpdate({ planId: 'plan-does-not-exist', patch: { slots: { destination: '杭州' } } }, store)
    expect(result.found).toBe(false)
    expect(result.status).toBe('not_found')
    expect(result.rerunHints).toEqual([])
  })
})

describe('rerunHints（§7 项 7 只重跑受影响项）', () => {
  it('日期/人数/预算变更分别触发对应重跑项，去重保序', async () => {
    const created = await runIntake(base, store)
    const byDates = await runUpdate({ planId: created.planId, patch: { slots: { dateEnd: '2026-10-04', days: 4 } } }, store)
    expect(byDates.rerunHints).toContain('travel_research_transport')
    expect(byDates.rerunHints).toContain('travel_research_advice')
    expect(byDates.rerunHints).toContain('travel_build_itinerary')

    const byPeople = await runUpdate({ planId: created.planId, patch: { slots: { travelers: { children: 2 } } } }, store)
    expect(byPeople.rerunHints).toContain('travel_research_transport')
    expect(byPeople.rerunHints).not.toContain('travel_research_destination')

    const byPrefs = await runUpdate({ planId: created.planId, patch: { slots: { preferences: { themes: ['人文'] } } } }, store)
    expect(byPrefs.rerunHints).toContain('travel_research_destination')
  })

  it('无实质研究变更（仅 origin 补丁）→ rerunHints 空', async () => {
    const collecting = await runIntake({ slots: { destination: '杭州' } }, store) // 未齐 → collecting（可更新）
    const updated = await runUpdate({ planId: collecting.planId, patch: { slots: { origin: '上海' } } }, store)
    expect(updated.rerunHints).toEqual([])
  })
})