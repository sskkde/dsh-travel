/**
 * W0 T3 状态通路修补与失效 DAG（草稿 F：必要状态通路 / 失效规则 / DAG 顺序）。
 *
 * 验收（T3 Acceptance）：
 * - 每类变更只失效规定工件集（文件级断言）
 * - researching/generating→revising 与 revising→researching 在无在途任务时可达、
 *   有在途任务拒绝
 * - draft-only 变更（T3 既有检测）不被误失效
 * - 更新类任务提交前后版本复核（走 T2 publishArtifacts expectedVersions）
 *
 * 说明：既有 travel_update_request 对 researching/generating 的状态门保持
 * （tests/tools-update.test.ts「锁定态」回归不破）；草稿 F 的「无在途任务时
 * 允许 revising 回路」由 canTransitionEx/assertTransitionEx（inFlight 判定）
 * 编码，供编排层/W1+ 工具消费。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runUpdate } from '../src/tools/update.js'
import {
  QINGGAN_ARTIFACT_UPSTREAMS, QINGGAN_DAG_ORDER, classifyRevision,
  detectDraftOnlyChanges, REVISION_ACTIONS,
  type DraftOnlyChange, type QingganChangeKind,
} from '../src/tools/revision.js'
import {
  REVISE_LOOP, assertTransitionEx, canTransition, canTransitionEx,
} from '../src/store/state.js'
import { InvalidTransitionError } from '../src/errors.js'
import type { ItineraryDay, Slots } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-revision-qinggan-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function stop(name: string, note?: string): ItineraryDay['stops'][number] {
  return {
    name,
    category: 'attraction',
    coords: { lng: 100.5, lat: 36.2, sys: 'GCJ02' },
    intelRefs: ['i1'],
    ...(note !== undefined ? { note } : {}),
  }
}

function day(over: Partial<ItineraryDay> & { index: number }): ItineraryDay {
  return {
    date: `2026-09-0${over.index + 1}`,
    stops: [stop('莫高窟', `note-${over.index}`)],
    meals: [],
    theme: `theme-${over.index}`,
    ...over,
  }
}

const slots: Slots = {
  destination: '敦煌', dateStart: '2026-09-01', dateEnd: '2026-09-05', days: 5,
}

const ALL_FIVE = [...REVISION_ACTIONS]

// ────────────────────────── ① 状态通路（无在途任务可达 / 有在途拒绝） ──────────────────────────

describe('T3 状态通路修补（state.ts：revising 回路按 inFlight 判定）', () => {
  it('无在途任务：researching/generating→revising、revising→researching 可达', () => {
    expect(canTransitionEx('researching', 'revising', false)).toBe(true)
    expect(canTransitionEx('generating', 'revising', false)).toBe(true)
    expect(canTransitionEx('revising', 'researching', false)).toBe(true)
  })

  it('有在途任务：researching/generating→revising、revising→researching 拒绝', () => {
    expect(canTransitionEx('researching', 'revising', true)).toBe(false)
    expect(canTransitionEx('generating', 'revising', true)).toBe(false)
    expect(canTransitionEx('revising', 'researching', true)).toBe(false)
    expect(() => assertTransitionEx('researching', 'revising', true)).toThrow(InvalidTransitionError)
    expect(() => assertTransitionEx('researching', 'revising', true)).toThrow(/在途任务/)
  })

  it('无在途守卫放行时 assert 不抛；既有状态机主线边不受影响', () => {
    expect(() => assertTransitionEx('researching', 'revising', false)).not.toThrow()
    expect(() => assertTransitionEx('revising', 'researching', false)).not.toThrow()
    // 既有表不破（回归）
    expect(canTransition('researching', 'generating')).toBe(true)
    expect(canTransition('generating', 'delivered')).toBe(true)
    expect(canTransition('delivered', 'revising')).toBe(true)
    expect(canTransition('revising', 'generating')).toBe(true)
  })

  it('REVISE_LOOP 只含三条修订回路边', () => {
    expect(REVISE_LOOP).toEqual([
      ['researching', 'revising'],
      ['generating', 'revising'],
      ['revising', 'researching'],
    ])
  })
})

// ────────────────────────── ② 失效 DAG：文件级失效集 ──────────────────────────

describe('T3 失效 DAG（classifyRevision 文件级断言）', () => {
  it('改 researchIntent → research-input 链：intel→places→下游 全失效', () => {
    const withIntent: Slots = {
      ...slots,
      researchIntent: { text: '青甘大环线', keywords: ['敦煌'] },
    }
    const impact = classifyRevision(slots, withIntent)
    expect(impact.changedSlots).toEqual(['researchIntent'])
    expect(impact.changeKinds).toEqual(['research-input'])
    expect(impact.affected).toEqual(ALL_FIVE)
    expect(impact.invalidatedArtifacts).toEqual([
      'intel.json', 'places.json', 'transport.json', 'route-transport.json',
      'advice.json', 'lodging-quotes.json', 'itinerary.json', 'page.html',
    ])
  })

  it('改选点顺序（selection）→ places/transport/route-transport/advice/报价/build/render 全失效而 intel 保留', () => {
    const impact = classifyRevision(slots, { ...slots }, [], ['selection'])
    expect(impact.changeKinds).toEqual(['selection'])
    expect(impact.invalidatedArtifacts).toEqual([
      'places.json', 'transport.json', 'route-transport.json',
      'advice.json', 'lodging-quotes.json', 'itinerary.json', 'page.html',
    ])
    expect(impact.invalidatedArtifacts).not.toContain('intel.json')
  })

  it('改日期 → 带日期研究与日程失效（intel + 交通/advice/报价/日程/render）', () => {
    const impact = classifyRevision(slots, { ...slots, dateEnd: '2026-09-06', days: 6 })
    expect(impact.changeKinds).toEqual(['dates'])
    expect(impact.invalidatedArtifacts).toEqual([
      'intel.json', 'transport.json', 'route-transport.json',
      'advice.json', 'lodging-quotes.json', 'itinerary.json', 'page.html',
    ])
  })

  it('改住宿/入住安排（lodging）→ 仅报价失效', () => {
    const impact = classifyRevision(slots, { ...slots }, [], ['lodging'])
    expect(impact.changeKinds).toEqual(['lodging'])
    expect(impact.invalidatedArtifacts).toEqual(['lodging-quotes.json'])
  })

  it('仅展示文案（copyOnly draft）→ 只 render 不重查网络', () => {
    const prev = [day({ index: 0 })]
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[0].stops[0].note = '修正文案'
    const changes = detectDraftOnlyChanges(prev, next)
    expect(changes).toEqual([{ kind: 'copyOnly', dayIndexes: [0] }])
    const impact = classifyRevision(slots, { ...slots }, changes)
    expect(impact.draftOnly).toBe(true)
    expect(impact.affected).toEqual(['travel_render_page'])
    expect(impact.invalidatedArtifacts).toEqual(['page.html'])
    expect(impact.invalidatedArtifacts).not.toContain('intel.json')
  })

  it('draft-only 结构性变更（既有检测）不被误失效：仅 itinerary+page，研究工件保留', () => {
    const prev = [day({ index: 0 }), day({ index: 1 })]
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[1].lodgingArea = '莫高窟附近'
    const changes = detectDraftOnlyChanges(prev, next)
    expect(changes).toEqual([{ kind: 'lodgingArea', dayIndexes: [1] }])
    const impact = classifyRevision(slots, { ...slots }, changes)
    expect(impact.draftOnly).toBe(true)
    expect(impact.affected).toEqual(['travel_build_itinerary', 'travel_render_page'])
    expect(impact.invalidatedArtifacts).toEqual(['itinerary.json', 'page.html'])
    for (const name of ['intel.json', 'transport.json', 'advice.json', 'places.json']) {
      expect(impact.invalidatedArtifacts).not.toContain(name)
    }
  })

  it('无变化 → 无失效工件', () => {
    const impact = classifyRevision(slots, { ...slots })
    expect(impact.changedSlots).toEqual([])
    expect(impact.invalidatedArtifacts).toEqual([])
    expect(impact.changeKinds).toEqual([])
  })

  it('改 destination → research-input 链（intel 含在内）', () => {
    const impact = classifyRevision(slots, { ...slots, destination: '西宁' })
    expect(impact.changeKinds).toEqual(['research-input'])
    expect(impact.invalidatedArtifacts).toContain('intel.json')
    expect(impact.invalidatedArtifacts).toContain('places.json')
  })

  it('仅改 origin → 只失效交通链（intel/places 保留）', () => {
    const impact = classifyRevision(slots, { ...slots, origin: '西宁' })
    expect(impact.invalidatedArtifacts).toEqual([
      'transport.json', 'route-transport.json', 'itinerary.json', 'page.html',
    ])
    expect(impact.invalidatedArtifacts).not.toContain('intel.json')
    expect(impact.invalidatedArtifacts).not.toContain('places.json')
  })
})

// ────────────────────────── ③ copyOnly 检出 ──────────────────────────

describe('T3 copyOnly 文案检出（detectDraftOnlyChanges）', () => {
  it('仅改 day.theme / stop.note / meal.name 文本 → copyOnly', () => {
    const prev = [day({ index: 0 })]
    const byTheme = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    byTheme[0].theme = '换个主题词'
    expect(detectDraftOnlyChanges(prev, byTheme)).toEqual([{ kind: 'copyOnly', dayIndexes: [0] }])

    const byNote = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    byNote[0].stops[0].note = '修正文案'
    byNote[0].stops[0].durationHint = 90
    expect(detectDraftOnlyChanges(prev, byNote)).toEqual([{ kind: 'copyOnly', dayIndexes: [0] }])

    // 新增一餐（非删减）→ copyOnly（不触发网络研究）
    const byMeal = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    byMeal[0].meals = [{ name: '驴肉黄面', intelRefs: ['i1'] }]
    expect(detectDraftOnlyChanges(prev, byMeal)).toEqual([{ kind: 'copyOnly', dayIndexes: [0] }])
  })

  it('结构变更（删减 stops/换住宿区/压缩）不误报 copyOnly', () => {
    const twoStops = (i: number): ItineraryDay => ({
      date: `2026-09-0${i + 1}`,
      stops: [stop('莫高窟', `n-${i}`), stop('鸣沙山', `n-${i}`)],
      meals: [],
      theme: `theme-${i}`,
    })
    const prev = [twoStops(0), twoStops(1)]
    const next = JSON.parse(JSON.stringify(prev)) as ItineraryDay[]
    next[0].stops = next[0].stops.slice(0, 1) // 删 1 个 stop（保序子序列）
    next[1].lodgingArea = '市区'
    const changes = detectDraftOnlyChanges(prev, next)
    expect(changes).toEqual([
      { kind: 'lodgingArea', dayIndexes: [1] },
      { kind: 'stopsTrimmed', dayIndexes: [0] },
    ])
    expect(changes.some((c) => c.kind === 'copyOnly')).toBe(false)
  })
})

// ────────────────────────── ④ update 接线 ──────────────────────────

describe('T3 update 接线：researchIntent 分组入 revisionPlan', () => {
  it('researchIntent 补丁 → revisionPlan.affected=全五、bySlot 含 researchIntent 组', async () => {
    const created = await runIntake({ slots }, store)
    const before = (await store.loadRequest(created.planId))!.slots
    const updated = await runUpdate({
      planId: created.planId,
      patch: { slots: { researchIntent: { text: '青甘大环线', keywords: ['敦煌'] } } },
    }, store)
    expect(updated.revisionPlan.affected).toEqual(ALL_FIVE)
    expect(updated.revisionPlan.bySlot).toEqual([
      { slot: 'researchIntent', actions: [...ALL_FIVE] },
    ])
    const impact = classifyRevision(before, updated.confirmedSlots)
    expect(impact.changeKinds).toEqual(['research-input'])
    expect(impact.changedSlots).toEqual(['researchIntent'])
  })

  it('legacy 日期修订不影响 researchIntent 分组（既有影响表回归）', async () => {
    const created = await runIntake({ slots }, store)
    const updated = await runUpdate({
      planId: created.planId, patch: { slots: { dateEnd: '2026-09-06', days: 6 } },
    }, store)
    expect(updated.revisionPlan.affected).toEqual([
      'travel_research_transport', 'travel_research_advice',
      'travel_build_itinerary', 'travel_render_page',
    ])
  })

  it('既有锁定态门保持（regression）：researching 槽位变更仍被拒', async () => {
    const created = await runIntake({ slots }, store)
    const request = await store.loadRequest(created.planId)
    await store.saveRequest({ ...request!, status: 'researching' })
    await expect(runUpdate({ planId: created.planId, patch: { slots: { destination: '西宁' } } }, store))
      .rejects.toThrow(/锁定态/)
  })

  it('更新类任务提交走版本复核（T2 机制接线）：当前版本放行、过期版本拒绝', async () => {
    const created = await runIntake({ slots }, store)
    // 模拟研究更新任务：提交附带当前 intel 版本
    await store.publishArtifacts(created.planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }],
      expectedVersions: { research: 0, intel: 0 }, bump: ['intel'],
    })
    // 过期版本（期望 0 但当前 1）→ 迟到写拒绝
    await expect(store.publishArtifacts(created.planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'late' }] }],
      expectedVersions: { intel: 0 },
    })).rejects.toThrow(/迟到写拒绝/)
  })
})

// ────────────────────────── ⑤ DAG 顺序编码 ──────────────────────────

describe('T3 DAG 顺序与上游依赖编码（前置门数据，T16 落执行）', () => {
  it('顺序：request → research → intel → places → transport/advice → 报价 → itinerary → page', () => {
    const order = QINGGAN_DAG_ORDER
    expect(order.indexOf('request.json')).toBeLessThan(order.indexOf('intel.json'))
    expect(order.indexOf('intel.json')).toBeLessThan(order.indexOf('places.json'))
    expect(order.indexOf('places.json')).toBeLessThan(order.indexOf('transport.json'))
    expect(order.indexOf('places.json')).toBeLessThan(order.indexOf('route-transport.json'))
    expect(order.indexOf('places.json')).toBeLessThan(order.indexOf('advice.json'))
    expect(order.indexOf('advice.json')).toBeLessThan(order.indexOf('lodging-quotes.json'))
    expect(order.indexOf('transport.json')).toBeLessThan(order.indexOf('itinerary.json'))
    expect(order.indexOf('itinerary.json')).toBeLessThan(order.indexOf('page.html'))
    expect(order.indexOf('route-coverage.json')).toBeGreaterThan(order.indexOf('intel.json'))
    expect(order.indexOf('route-coverage.json')).toBeGreaterThan(order.indexOf('places.json'))
  })

  it('上游依赖图：places 依赖 intel；transport/advice 依赖 places；coverage 只读不反向触发', () => {
    expect(QINGGAN_ARTIFACT_UPSTREAMS['places.json']).toEqual(['intel.json'])
    expect(QINGGAN_ARTIFACT_UPSTREAMS['transport.json']).toEqual(['places.json'])
    expect(QINGGAN_ARTIFACT_UPSTREAMS['route-transport.json']).toEqual(['places.json'])
    expect(QINGGAN_ARTIFACT_UPSTREAMS['advice.json']).toEqual(['places.json'])
    expect(QINGGAN_ARTIFACT_UPSTREAMS['lodging-quotes.json']).toEqual(['places.json'])
    expect(QINGGAN_ARTIFACT_UPSTREAMS['route-coverage.json']).toEqual(['intel.json', 'places.json'])
    expect(QINGGAN_ARTIFACT_UPSTREAMS['page.html']).toContain('itinerary.json')
    // coverage 不反向触发 intel/places（上游图无环）
    expect(QINGGAN_ARTIFACT_UPSTREAMS['intel.json']).not.toContain('route-coverage.json')
    expect(QINGGAN_ARTIFACT_UPSTREAMS['places.json']).not.toContain('route-coverage.json')
  })
})