/**
 * travel_intake 单测（design §6 行 518 校验规则 + §5.4 状态 + 落盘契约）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake, createTravelIntakeTool, type IntakeArgs } from '../src/tools/intake.js'
import { TravelValidationError } from '../src/errors.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-intake-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const completePlan: IntakeArgs = {
  slots: {
    destination: '杭州',
    origin: '上海',
    dateStart: '2026-10-01',
    dateEnd: '2026-10-03',
    days: 3,
    travelers: { adults: 2, children: 1 },
    budget: { amount: 5000 },
    preferences: { themes: ['自然'] },
  },
}

describe('intake 主路径', () => {
  it('完整 plan → confirmed + missing 空 + 落盘 request.json 契约完整', async () => {
    const result = await runIntake(completePlan, store)
    expect(result.status).toBe('confirmed')
    expect(result.missing).toEqual([])
    expect(result.planId).toMatch(/^plan-/)
    expect(result.ambiguity).toEqual([])

    // 落盘验证：request.json 字段契约（mode/status/assumptions/createdAt/updatedAt）
    const request = await store.loadRequest(result.planId)
    expect(request).toBeDefined()
    expect(request?.mode).toBe('plan')
    expect(request?.status).toBe('confirmed')
    expect(request?.slots.destination).toBe('杭州')
    expect(request?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(request?.updatedAt).toBe(request?.createdAt)
    expect(Array.isArray(request?.assumptions)).toBe(true)
  })

  it('默认值 + assumptions 明示（currency=CNY/scope=total/adults=1/pace=balanced/按区间推导 days）', async () => {
    const result = await runIntake({
      slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', budget: {} },
    }, store)
    expect(result.confirmedSlots.budget?.currency).toBe('CNY')
    expect(result.confirmedSlots.budget?.scope).toBe('total')
    expect(result.confirmedSlots.travelers?.adults).toBe(1)
    expect(result.confirmedSlots.days).toBe(3) // 区间推导
    expect(result.assumptions.join('|')).toContain('CNY')
    expect(result.assumptions.join('|')).toContain('total')
    expect(result.assumptions.join('|')).toContain('1 名成人')
    expect(result.assumptions.join('|')).toContain('3 天')
  })

  it('preferences 存在时补 pace=balanced 并记 assumption', async () => {
    const result = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3, preferences: { themes: ['美食'] } } }, store)
    expect(result.confirmedSlots.preferences?.pace).toBe('balanced')
    expect(result.assumptions.join('|')).toContain('balanced')
  })
})

describe('intake 校验规则（QA 用例）', () => {
  it('plan 模式缺 destination → missing 含 destination，状态 collecting，追问含目的地', async () => {
    const result = await runIntake({ slots: { dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    expect(result.missing).toContain('destination')
    expect(result.status).toBe('collecting')
    expect(result.nextQuestions[0]).toContain('目的地')
    expect(result.nextQuestions.length).toBeLessThanOrEqual(3)
  })

  it('recommend 模式 destination 不计入 missing（候选推荐流程）', async () => {
    const result = await runIntake({ mode: 'recommend', slots: { dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    expect(result.missing).not.toContain('destination')
    expect(result.status).toBe('recommending')
    // 日期齐全时 recommend 的 missing 为空 → 只差候选选择
    expect(result.missing).toEqual([])
    expect(result.nextQuestions.length).toBe(0)
  })

  it('days≠区间 拒（days=3 但区间 4 天 → 校验错误）', async () => {
    const args: IntakeArgs = {
      slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-04', days: 3 },
    }
    await expect(runIntake(args, store)).rejects.toThrow(TravelValidationError)
    await expect(runIntake(args, store)).rejects.toThrow(/天数与日期区间不一致/)
    await expect(store.findLatestPlan()).resolves.toBeUndefined() // 拒时不落盘
  })

  it('dateEnd<dateStart 拒', async () => {
    const args: IntakeArgs = {
      slots: { destination: '杭州', dateStart: '2026-10-03', dateEnd: '2026-10-01', days: 3 },
    }
    await expect(runIntake(args, store)).rejects.toThrow(TravelValidationError)
    await expect(runIntake(args, store)).rejects.toThrow(/不得早于/)
  })

  it('dateEnd==dateStart 合法（单日行程）', async () => {
    const result = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-01', days: 1 } }, store)
    expect(result.status).toBe('confirmed')
    expect(result.confirmedSlots.days).toBe(1)
  })

  it('日期格式非法拒', async () => {
    await expect(runIntake({ slots: { destination: '杭州', dateStart: '2026/10/01' } }, store))
      .rejects.toThrow(TravelValidationError)
  })

  it('ambiguity：多候选 destination 计入需澄清', async () => {
    const result = await runIntake({ slots: { destination: '杭州、苏州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)
    expect(result.ambiguity.length).toBeGreaterThan(0)
  })
})

describe('intake 更新与持久化', () => {
  it('结构化多地点 plan（显式 researchIntent）confirmed → 写 flowVersion；destination-only 新 plan 同样受串行门（F1c-E 决策 5）', async () => {
    // 显式 researchIntent 的结构化 plan（confirmed）→ flowVersion='1'（上游全文门据此走逐地归属）
    const full = await runIntake({
      slots: {
        researchIntent: { text: '青甘大环线 8 天自驾', keywords: ['敦煌', '大柴旦'] },
        dateStart: '2026-10-01', dateEnd: '2026-10-08',
      },
    }, store)
    expect(full.status).toBe('confirmed')
    expect(full.request.flowVersion).toBe('1')
    expect((await store.loadRequest(full.planId))?.flowVersion).toBe('1')

    // destination-only 新 plan（单点，经 seed 映射兴趣种子）confirmed → 同样写 flowVersion='1'
    // 并显式记录「受串行门约束」（决策 5：新 plan 一律受门，不再当 legacy 轻量单点）
    const d = await runIntake({ slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    expect(d.status).toBe('confirmed')
    expect(d.request.flowVersion).toBe('1')
    expect(d.assumptions.join('|')).toContain('受串行门约束')
    expect((await store.loadRequest(d.planId))?.flowVersion).toBe('1')

    // 仍处 collecting 的轻量单点（仅 destination、缺日期）→ 不套新信封（未成形不提前套门）
    const point = await runIntake({ slots: { destination: '西宁' } }, store)
    expect(point.status).toBe('collecting')
    expect(point.request.flowVersion).toBeUndefined()
    expect((await store.loadRequest(point.planId))?.flowVersion).toBeUndefined()
  })

  it('既存 confirmed legacy plan（无 flowVersion）经 intake 非结构化更新 → 不补写（保持 legacy 轻量路径）', async () => {
    // 模拟旧计划：直接落盘 confirmed 但无 flowVersion 的请求（真正的 legacy 形态）
    const legacy = await runIntake({ slots: { destination: '西宁', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const req = await store.loadRequest(legacy.planId)
    await store.saveRequest({ ...req!, flowVersion: undefined })
    // 无关字段更新（origin）→ 不因新语义补写 flowVersion（旧 plan 浏览/导出不强制改门）
    const update = await runIntake({ planId: legacy.planId, slots: { origin: '北京' } }, store)
    expect(update.status).toBe('confirmed')
    expect(update.request.flowVersion).toBeUndefined()
    expect((await store.loadRequest(legacy.planId))?.flowVersion).toBeUndefined()
  })

  it('既有 legacy 计划经 intake 补齐为结构化 confirmed → 补写 flowVersion（不覆盖既有值）', async () => {
    // 先建成 destination-only 轻量单点（无信封）
    const point = await runIntake({ slots: { destination: '西宁' } }, store)
    expect(point.request.flowVersion).toBeUndefined()
    // 补显式 researchIntent → 汇聚为结构化 confirmed → 补写 '1'
    const full = await runIntake({
      planId: point.planId,
      slots: { researchIntent: { text: '西宁-敦煌 7 天环线' }, dateStart: '2026-10-01', dateEnd: '2026-10-07' },
    }, store)
    expect(full.status).toBe('confirmed')
    expect(full.request.flowVersion).toBe('1')
    // 已是 confirmed 的既有 v1 计划再更新 → 保留原信封
    const stay = await runIntake({ planId: point.planId, slots: { origin: '北京' } }, store)
    expect(stay.request.flowVersion).toBe('1')
  })

  it('带 planId 重入 = 更新既有计划（保持 createdAt，更新 updatedAt）', async () => {
    const first = await runIntake(completePlan, store)
    const before = await store.loadRequest(first.planId)
    await new Promise((r) => setTimeout(r, 5)) // 保证 updatedAt 前进
    const second = await runIntake({ planId: first.planId, slots: { origin: '北京' } }, store)
    expect(second.planId).toBe(first.planId)
    expect(second.created).toBe(false)
    const after = await store.loadRequest(first.planId)
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.updatedAt).not.toBe(before?.updatedAt)
    expect(after?.slots.destination).toBe('杭州') // 未补字段保留
    expect(after?.slots.origin).toBe('北京')
  })

  it('defineTool 参数 schema 兼容（validateArgs 面）', () => {
    const def = createTravelIntakeTool(store)
    expect(def.name).toBe('travel_intake')
    expect((def as { timeoutMs?: number }).timeoutMs).toBe(10_000)
    expect(def.output.schema).toBeDefined()
  })
})