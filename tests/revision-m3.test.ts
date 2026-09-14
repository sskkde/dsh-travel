/**
 * M3.1 修订流程打磨单测（T2/W1）：
 * - src/tools/revision.ts 纯模块：固定影响表 / draft-only 检出 / classifyRevision /
 *   selectiveRerunPlan（确定性：同输入必得同输出，零网络零 IO）
 * - travel_update_request 的 lossless revisionPlan 投影 + 旧 rerunHints 兼容
 * - draft-only 修订端到端（换酒店区域 / 删减压缩 stops）：只 build/render，
 *   未受影响天 JSON 结构全等（itinerary.json 与重渲染页面双断言），
 *   旧研究 artifact（intel/transport/advice）原样保留
 * - failure 分支：不存在 lodgingArea / 非法 draft refs → 确定性校验错误
 *   （TravelValidationError），全程离线（build deps 缺省=直线估算，零触网）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runUpdate } from '../src/tools/update.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { runRenderPage } from '../src/tools/render-page.js'
import {
  classifyRevision, detectDraftOnlyChanges, REVISION_ACTIONS, selectiveRerunPlan,
  type DraftOnlyChange, type RevisionAction, type RevisionSlotKey,
} from '../src/tools/revision.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedPlaces } from './helpers/seed-places.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'
import { TravelValidationError } from '../src/errors.js'
import type { Advice, IntelItem, ItineraryDay, Slots, TransportOption } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-revision-m3-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────── 共享夹具 ──────────────────────────

/** golden fixture 的三个坐标条目 id（tests/fixtures/tencent/poi-search-huanghelou.json）。 */
const ID_HUANGHELOU = 'tencent-poi:16294309905749563320'
const ID_HUANGHELOU_SCENIC = 'tencent-poi:2738900478225601695'
const ID_NIGHT_HUANGHELOU = 'tencent-poi:2323422242271982152'

const ALL_FIVE: readonly RevisionAction[] = [...REVISION_ACTIONS]
const RESEARCH_THREE: readonly RevisionAction[] = [
  'travel_research_destination', 'travel_research_transport', 'travel_research_advice',
]

/** 规范序列前置：intake（confirmed）→ research（真实工具，离线 fixture）→ places（决策 5）→ researching。 */
async function makeResearchDonePlan(): Promise<string> {
  const created = await runIntake({
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
  }, store)
  expect(created.status).toBe('confirmed')
  await seedResearch(store, created.planId, { poi: 'golden', l0: 'hits' })
  await seedSufficientAssessment(store, created.planId) // C5① 门放行件
  await seedPlaces(store, created.planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
  const request = await store.loadRequest(created.planId)
  expect(request?.status).toBe('researching')
  return created.planId
}

/** golden fixture 中该 id 的真实坐标（fix-f1e C：draft stop 坐标须与所引 intel 一致——原 lat=30.5 属来源错配，收紧后会被拒）。 */
const INTEL_COORDS: Record<string, { lng: number; lat: number }> = {
  [ID_HUANGHELOU]: { lng: 114.302539, lat: 30.544624 },
  [ID_HUANGHELOU_SCENIC]: { lng: 114.304774, lat: 30.543888 },
  [ID_NIGHT_HUANGHELOU]: { lng: 114.302414, lat: 30.544660 },
}

function stop(name: string, intelId: string, durationHint: number, lng: number, note?: string): ItineraryDay['stops'][number] {
  const cited = INTEL_COORDS[intelId]
  return {
    name,
    category: 'attraction',
    coords: { lng, lat: cited?.lat ?? 30.5446, sys: 'GCJ02' },
    durationHint,
    intelRefs: [intelId],
    ...(note !== undefined ? { note } : {}),
  }
}

/** v1 三日 draft（day0 带 note 以便观察「原样保留上一版结构」；day2 无 lodgingArea）。 */
function v1Draft(): ItineraryDay[] {
  return [
    {
      date: '2026-10-01',
      stops: [stop('黄鹤楼', ID_HUANGHELOU, 120, 114.302539, '第一版 note'), stop('黄鹤楼景区', ID_HUANGHELOU_SCENIC, 150, 114.304774)],
      meals: [{ name: '热干面', intelRefs: [ID_HUANGHELOU] }],
      lodgingArea: '武昌',
    },
    {
      date: '2026-10-02',
      stops: [stop('夜上黄鹤楼', ID_NIGHT_HUANGHELOU, 90, 114.302414)],
      meals: [],
      lodgingArea: '武昌',
    },
    {
      date: '2026-10-03',
      stops: [stop('黄鹤楼景区', ID_HUANGHELOU_SCENIC, 150, 114.304774)],
      meals: [],
    },
  ]
}

/** 预置旧研究 artifact（transport/advice 最小合法形），供「不被删除」断言。 */
async function seedLegacyArtifacts(planId: string): Promise<{ transport: TransportOption[]; advice: Advice }> {
  const transport: TransportOption[] = [{
    mode: 'rail',
    segments: [],
    source: { platform: 'fixture', url: 'https://example.invalid/rail', fetchedAt: '2026-09-05T00:00:00.000Z' },
  }]
  const advice: Advice = { weather: [], clothing: [], packingList: [], extraTips: [] }
  await store.writeJson(planId, 'transport.json', transport)
  await store.writeJson(planId, 'advice.json', advice)
  return { transport, advice }
}

/** 断言三类旧研究 artifact 内容原样保留（M3.1：plan 只声明重跑，不删除产物）。 */
async function expectArtifactsPreserved(planId: string, transport: TransportOption[], advice: Advice): Promise<void> {
  expect(await store.readJson<IntelItem[]>(planId, 'intel.json')).toBeDefined()
  expect(await store.readJson<TransportOption[]>(planId, 'transport.json')).toEqual(transport)
  expect(await store.readJson<Advice>(planId, 'advice.json')).toEqual(advice)
}

/** 渲染页内嵌 travel-data 的每日行程（同 tests/e2e/helpers.mjs embeddedData 口径）。 */
function embeddedDays(htmlPath: string): ItineraryDay[] {
  const html = readFileSync(htmlPath, 'utf8')
  const m = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('travel-data 数据块缺失')
  const data = JSON.parse(m[1]) as { itinerary: { days: ItineraryDay[] } }
  return data.itinerary.days
}

// ────────────────────────── ① ② draft-only 修订分类 ──────────────────────────

describe('draft-only 修订（revision.ts 纯函数）：lodgingArea / 删减 / 压缩 → 仅 build/render', () => {
  const slots: Slots = {
    destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
    travelers: { adults: 2 }, budget: { amount: 5000, currency: 'CNY', scope: 'total' },
  }

  it('换酒店区域（lodgingArea 修改）→ draftOnly，affected=[build,render]，research 全部不受影响', () => {
    const prev = v1Draft()
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[1].lodgingArea = '光谷' // 仅第二天换酒店区域

    const changes: DraftOnlyChange[] = detectDraftOnlyChanges(prev, next)
    expect(changes).toEqual([{ kind: 'lodgingArea', dayIndexes: [1] }])

    const impact = classifyRevision(slots, slots, changes)
    expect(impact.changedSlots).toEqual([])
    expect(impact.draftOnly).toBe(true)
    expect(impact.affected).toEqual(['travel_build_itinerary', 'travel_render_page'])
    expect(impact.affectedDays).toEqual([1])

    const plan = selectiveRerunPlan('plan-x', impact)
    expect(plan.planId).toBe('plan-x')
    expect(plan.draftOnly).toBe(true)
    expect(plan.bySlot).toEqual([
      { slot: 'draft', actions: ['travel_build_itinerary', 'travel_render_page'], dayIndexes: [1] },
    ])
    expect(plan.affected).toEqual(['travel_build_itinerary', 'travel_render_page'])
    expect(plan.unaffected).toEqual([...RESEARCH_THREE])
  })

  it('删减 stops（子序列）与压缩某日（缩时长/删 meals）→ draftOnly，仅 build/render', () => {
    const prev = v1Draft()
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[0].stops = next[0].stops.slice(0, 1) // day0 删减 1 个 stop（保序子序列）
    next[2].stops[0].durationHint = 60 // day2 压缩：时长 150→60

    const changes = detectDraftOnlyChanges(prev, next)
    expect(changes).toEqual([
      { kind: 'stopsTrimmed', dayIndexes: [0] },
      { kind: 'dayCompressed', dayIndexes: [2] },
    ])

    const impact = classifyRevision(slots, slots, changes)
    expect(impact.draftOnly).toBe(true)
    expect(impact.affected).toEqual(['travel_build_itinerary', 'travel_render_page'])
    expect(impact.affectedDays).toEqual([0, 2])
    expect(selectiveRerunPlan('plan-x', impact).unaffected).toEqual([...RESEARCH_THREE])
  })

  it('删 meals 也判为压缩某日；未变化天不出现', () => {
    const prev = v1Draft()
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[0].meals = [] // 仅删 day0 一餐
    expect(detectDraftOnlyChanges(prev, next)).toEqual([{ kind: 'dayCompressed', dayIndexes: [0] }])
    expect(detectDraftOnlyChanges(prev, prev)).toEqual([])
  })

  it('确定性：同输入（不同对象实例）重复分类/生成 plan 结果全等', () => {
    const prev = v1Draft()
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[1].lodgingArea = '光谷'
    const changes = detectDraftOnlyChanges(prev, next)

    const impact1 = classifyRevision(slots, { ...slots }, JSON.parse(JSON.stringify(changes)) as DraftOnlyChange[])
    const impact2 = classifyRevision(slots, { ...slots }, JSON.parse(JSON.stringify(changes)) as DraftOnlyChange[])
    expect(impact1).toEqual(impact2)
    expect(selectiveRerunPlan('plan-x', impact1)).toEqual(selectiveRerunPlan('plan-x', impact2))
  })
})

// ────────────────────────── ④ 七组槽位影响表映射 ──────────────────────────

describe('固定影响表：origin/destination/dates/people/budget/preferences/constraints 逐一断言', () => {
  const before: Slots = {
    destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
    travelers: { adults: 2 }, budget: { amount: 5000, currency: 'CNY', scope: 'total' },
  }

  const CASES: ReadonlyArray<{
    name: RevisionSlotKey
    patch: Partial<Slots>
    affected: readonly RevisionAction[]
  }> = [
    {
      name: 'origin', patch: { origin: '上海' },
      affected: ['travel_research_transport', 'travel_build_itinerary', 'travel_render_page'],
    },
    {
      name: 'destination', patch: { destination: '南京' },
      affected: ALL_FIVE,
    },
    {
      name: 'dates', patch: { dateEnd: '2026-10-04', days: 4 },
      affected: ['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'],
    },
    {
      name: 'people', patch: { travelers: { adults: 3 } },
      affected: ['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'],
    },
    {
      name: 'budget', patch: { budget: { amount: 8000 } },
      affected: ['travel_research_destination', 'travel_research_transport', 'travel_build_itinerary', 'travel_render_page'],
    },
    {
      name: 'preferences', patch: { preferences: { themes: ['人文'] } },
      affected: ['travel_research_destination', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'],
    },
    {
      name: 'constraints', patch: { constraints: ['无障碍出行'] },
      affected: ALL_FIVE,
    },
  ]

  it.each(CASES)('$name 变更 → 影响表映射准确', ({ name, patch, affected }) => {
    const after: Slots = { ...before, ...patch }
    const impact = classifyRevision(before, after)
    expect(impact.changedSlots).toEqual([name])
    expect(impact.affected).toEqual(affected)
    expect(impact.draftOnly).toBe(false)
    expect(impact.affectedDays).toEqual([])

    const plan = selectiveRerunPlan('plan-y', impact)
    expect(plan.draftOnly).toBe(false)
    expect(plan.bySlot).toEqual([{ slot: name, actions: [...affected] }])
    expect(plan.affected).toEqual(affected)
    expect(plan.unaffected).toEqual(REVISION_ACTIONS.filter((a) => !affected.includes(a)))
  })

  it('多组同时变化 → 影响表并集（research→build→render 保序去重）', () => {
    const after: Slots = { ...before, origin: '上海', budget: { amount: 8000 } }
    const impact = classifyRevision(before, after)
    expect(impact.changedSlots).toEqual(['origin', 'budget'])
    expect(impact.affected).toEqual([
      'travel_research_destination', 'travel_research_transport',
      'travel_build_itinerary', 'travel_render_page',
    ])
    expect(selectiveRerunPlan('plan-y', impact).bySlot).toEqual([
      { slot: 'origin', actions: ['travel_research_transport', 'travel_build_itinerary', 'travel_render_page'] },
      { slot: 'budget', actions: ['travel_research_destination', 'travel_research_transport', 'travel_build_itinerary', 'travel_render_page'] },
    ])
  })

  it('无变化且无 draft 修订 → affected 空、unaffected=全集', () => {
    const impact = classifyRevision(before, { ...before })
    expect(impact.changedSlots).toEqual([])
    expect(impact.affected).toEqual([])
    const plan = selectiveRerunPlan('plan-y', impact)
    expect(plan.affected).toEqual([])
    expect(plan.unaffected).toEqual(ALL_FIVE)
    expect(plan.bySlot).toEqual([])
  })
})

// ────────────────────────── ⑥ rerunHints 兼容 + revisionPlan 投影 ──────────────────────────

describe('travel_update_request：旧 rerunHints 语义不破坏 + revisionPlan lossless 投影', () => {
  const base = {
    slots: {
      destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      travelers: { adults: 2 }, budget: { amount: 5000 },
    },
  }

  it('dates：rerunHints 保持旧表（transport/advice/build，无 render）；revisionPlan 为新四项', async () => {
    const created = await runIntake(base, store)
    const updated = await runUpdate({ planId: created.planId, patch: { slots: { dateEnd: '2026-10-04', days: 4 } } }, store)
    // 旧字段：M2 语义逐项相等（旧调用方只读它不破坏）
    expect(updated.rerunHints).toEqual(['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary'])
    // 新投影：lossless（含 render + unaffected 集合）
    expect(updated.revisionPlan.planId).toBe(created.planId)
    expect(updated.revisionPlan.draftOnly).toBe(false)
    expect(updated.revisionPlan.affected).toEqual([
      'travel_research_transport', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page',
    ])
    expect(updated.revisionPlan.unaffected).toEqual(['travel_research_destination'])
    expect(updated.revisionPlan.bySlot).toEqual([
      { slot: 'dates', actions: ['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'] },
    ])
  })

  it('budget：rerunHints 仍旧两研究项；revisionPlan 按新表含 destination/build/render', async () => {
    const created = await runIntake(base, store)
    const updated = await runUpdate({ planId: created.planId, patch: { slots: { budget: { amount: 8000 } } } }, store)
    expect(updated.rerunHints).toEqual(['travel_research_transport', 'travel_research_advice'])
    expect(updated.revisionPlan.affected).toEqual([
      'travel_research_destination', 'travel_research_transport', 'travel_build_itinerary', 'travel_render_page',
    ])
  })

  it('people/destination：rerunHints 保持旧表；revisionPlan 不丢 render', async () => {
    const created = await runIntake(base, store)
    const byPeople = await runUpdate({ planId: created.planId, patch: { slots: { travelers: { children: 1 } } } }, store)
    expect(byPeople.rerunHints).toEqual(['travel_research_transport', 'travel_build_itinerary'])
    expect(byPeople.revisionPlan.affected).toContain('travel_render_page')
    expect(byPeople.revisionPlan.affected).not.toContain('travel_research_destination')

    const byDest = await runUpdate({ planId: created.planId, patch: { slots: { destination: '南京' } } }, store)
    expect(byDest.rerunHints).toEqual(['travel_research_destination', 'travel_build_itinerary'])
    expect(byDest.revisionPlan.affected).toEqual(ALL_FIVE)
    expect(byDest.revisionPlan.unaffected).toEqual([])
  })

  it('origin-only：rerunHints 仍为空（旧语义），revisionPlan 按新表给出 transport/build/render', async () => {
    const created = await runIntake({ slots: { destination: '杭州' } }, store) // collecting（可更新）
    const updated = await runUpdate({ planId: created.planId, patch: { slots: { origin: '上海' } } }, store)
    expect(updated.rerunHints).toEqual([])
    expect(updated.revisionPlan.affected).toEqual([
      'travel_research_transport', 'travel_build_itinerary', 'travel_render_page',
    ])
    expect(updated.revisionPlan.unaffected).toEqual([
      'travel_research_destination', 'travel_research_advice',
    ])
  })

  it('空补丁（无实质变更）→ rerunHints 与 revisionPlan.affected 均空', async () => {
    const created = await runIntake(base, store)
    const updated = await runUpdate({ planId: created.planId, patch: { slots: {} } }, store)
    expect(updated.rerunHints).toEqual([])
    expect(updated.revisionPlan.affected).toEqual([])
    expect(updated.revisionPlan.bySlot).toEqual([])
    expect(updated.revisionPlan.unaffected).toEqual(ALL_FIVE)
  })

  it('计划不存在 → not-found：rerunHints=[] 且 revisionPlan 为空计划（不抛崩溃）', async () => {
    const result = await runUpdate({ planId: 'plan-does-not-exist', patch: { slots: { destination: '杭州' } } }, store)
    expect(result.found).toBe(false)
    expect(result.rerunHints).toEqual([])
    expect(result.revisionPlan).toEqual({
      planId: 'plan-does-not-exist', bySlot: [], draftOnly: false, affected: [], unaffected: [...ALL_FIVE],
    })
  })
})

// ────────────────────────── ⑤ draft-only 端到端：未受影响天 JSON 全等 ──────────────────────────

describe('draft-only 修订端到端（build + 同 planId 重渲染）', () => {
  it('换酒店区域：只重建受影响天，未受影响天 JSON 全等（itinerary.json + 页面数据）', async () => {
    const planId = await makeResearchDonePlan()
    const { transport, advice } = await seedLegacyArtifacts(planId)

    const v1 = await runBuildItinerary({ planId, draft: { days: v1Draft() } }, store)
    expect(v1.built).toBe(true)
    const rendered1 = await runRenderPage({ planId }, store, { host: '127.0.0.1', port: 0, register() {} })
    expect(rendered1.rendered).toBe(true) // generating → delivered
    expect((await store.loadRequest(planId))?.status).toBe('delivered')

    // 修订入口（delivered → revising）：反馈落 constraints；行程层执行走 draft-only
    const upd = await runUpdate({ planId, patch: { slots: { constraints: ['换个酒店区域：第二天改住光谷'] } } }, store)
    expect(upd.status).toBe('revising')

    const v1Days = v1.days
    const draftV2 = JSON.parse(JSON.stringify(v1Days)) as ItineraryDay[]
    draftV2[1].lodgingArea = '光谷' // 仅第二天换酒店区域；day0/day3 结构原样

    // 纯分类：槽位未再变化 + draft 天级修订 → 只 build/render，不 research
    const slotsNow = (await store.loadRequest(planId))!.slots
    const changes = detectDraftOnlyChanges(v1Days, draftV2)
    const impact = classifyRevision(slotsNow, slotsNow, changes)
    expect(impact.draftOnly).toBe(true)
    expect(impact.affected).toEqual(['travel_build_itinerary', 'travel_render_page'])
    expect(selectiveRerunPlan(planId, impact).unaffected).toEqual([...RESEARCH_THREE])

    const v2 = await runBuildItinerary({ planId, draft: { days: draftV2 } }, store)
    expect(v2.built).toBe(true)
    // 受影响天采用新值；未受影响天 JSON 结构全等（含 note/lodgingArea 等全部字段）
    expect(v2.days[1].lodgingArea).toBe('光谷')
    expect(v2.days[0]).toEqual(v1Days[0])
    expect(v2.days[2]).toEqual(v1Days[2])
    // 上一版结构原样保留（draft 未带 note → 保留自上一版，非 draft 新值）
    expect(v2.days[0].stops[0].note).toBe('第一版 note')
    // 落盘产物一致
    const stored = await store.readJson<{ days: ItineraryDay[] }>(planId, 'itinerary.json')
    expect(stored?.days).toEqual(v2.days)
    // 旧研究 artifact 不被删除/改写
    await expectArtifactsPreserved(planId, transport, advice)

    // 同 planId 幂等重渲染：页面内嵌数据未受影响天 JSON 全等、受影响天为新值
    const rendered2 = await runRenderPage({ planId }, store, { host: '127.0.0.1', port: 0, register() {} })
    expect(rendered2.rendered).toBe(true)
    const page1 = embeddedDays(rendered1.filePath)
    const page2 = embeddedDays(rendered2.filePath)
    expect(page2[0]).toEqual(page1[0])
    expect(page2[2]).toEqual(page1[2])
    expect(page2[1].lodgingArea).toBe('光谷')
  })

  it('删减/压缩某日 stops：只重建受影响天，其余天与旧研究 artifact 全保留', async () => {
    const planId = await makeResearchDonePlan()
    const { transport, advice } = await seedLegacyArtifacts(planId)

    const v1 = await runBuildItinerary({ planId, draft: { days: v1Draft() } }, store)
    expect(v1.built).toBe(true)
    await runRenderPage({ planId }, store, { host: '127.0.0.1', port: 0, register() {} }) // → delivered
    const upd = await runUpdate({ planId, patch: { slots: { constraints: ['第一天太满删一个点，第三天轻松些'] } } }, store)
    expect(upd.status).toBe('revising')

    const draftV2 = JSON.parse(JSON.stringify(v1.days)) as ItineraryDay[]
    draftV2[0].stops = draftV2[0].stops.slice(0, 1) // day0 删减 1 个 stop
    draftV2[2].stops[0].durationHint = 60 // day2 压缩时长

    const changes = detectDraftOnlyChanges(v1.days, draftV2)
    expect(changes).toEqual([
      { kind: 'stopsTrimmed', dayIndexes: [0] },
      { kind: 'dayCompressed', dayIndexes: [2] },
    ])
    const impact = classifyRevision((await store.loadRequest(planId))!.slots, (await store.loadRequest(planId))!.slots, changes)
    expect(impact.draftOnly).toBe(true)
    expect(impact.affected).toEqual(['travel_build_itinerary', 'travel_render_page'])

    const v2 = await runBuildItinerary({ planId, draft: { days: draftV2 } }, store)
    expect(v2.built).toBe(true)
    expect(v2.days[0].stops).toHaveLength(1)
    expect(v2.days[0].stops[0].name).toBe('黄鹤楼')
    expect(v2.days[2].stops[0].durationHint).toBe(60)
    // 未受影响天（day1）JSON 结构全等
    expect(v2.days[1]).toEqual(v1.days[1])
    await expectArtifactsPreserved(planId, transport, advice)
  })
})

// ────────────────────────── ⑦ failure 分支：确定性校验错误，零网络 ──────────────────────────

describe('failure：不存在 lodgingArea / 非法 draft refs → TravelValidationError，绝不触发网络', () => {
  it('lodgingArea 为空串/空白（区域不存在）→ 确定性校验错误；产物保留、状态不变', async () => {
    const planId = await makeResearchDonePlan()
    const { transport, advice } = await seedLegacyArtifacts(planId)
    const intelBefore = await store.readJson<IntelItem[]>(planId, 'intel.json')

    const badEmpty = v1Draft()
    badEmpty[1].lodgingArea = ''
    await expect(runBuildItinerary({ planId, draft: { days: badEmpty } }, store))
      .rejects.toThrow(TravelValidationError)
    await expect(runBuildItinerary({ planId, draft: { days: badEmpty } }, store))
      .rejects.toThrow(/lodgingArea/)

    const badBlank = v1Draft()
    badBlank[0].lodgingArea = '   '
    await expect(runBuildItinerary({ planId, draft: { days: badBlank } }, store))
      .rejects.toThrow(/draft\.days\[0\]\.lodgingArea/)

    // 校验失败不写盘、不删除旧研究 artifact、状态机不推进（全程离线 deps=直线估算）
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
    expect((await store.loadRequest(planId))?.status).toBe('researching')
    expect(await store.readJson<IntelItem[]>(planId, 'intel.json')).toEqual(intelBefore)
    await expectArtifactsPreserved(planId, transport, advice)
  })

  it('非法 draft refs（intel 引用不存在）→ 列明缺失；旧 artifact 保留、零网络', async () => {
    const planId = await makeResearchDonePlan()
    const { transport, advice } = await seedLegacyArtifacts(planId)
    const intelBefore = await store.readJson<IntelItem[]>(planId, 'intel.json')

    const badRefs = v1Draft()
    badRefs[1].stops[0].intelRefs = ['ghost-1']
    badRefs[2].stops[0].intelRefs = ['ghost-2']
    await expect(runBuildItinerary({ planId, draft: { days: badRefs } }, store))
      .rejects.toThrow(TravelValidationError)
    await expect(runBuildItinerary({ planId, draft: { days: badRefs } }, store))
      .rejects.toThrow(/ghost-1/)
    await expect(runBuildItinerary({ planId, draft: { days: badRefs } }, store))
      .rejects.toThrow(/ghost-2/)

    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
    expect((await store.loadRequest(planId))?.status).toBe('researching')
    expect(await store.readJson<IntelItem[]>(planId, 'intel.json')).toEqual(intelBefore)
    await expectArtifactsPreserved(planId, transport, advice)
  })
})
