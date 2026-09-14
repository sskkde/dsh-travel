/**
 * travel_build_itinerary 自动提案基线单测（M1 T5 / Wα）+ 完整版（M1 T7 / W4）。
 *
 * Wα 12 例保持全绿（draft 合法例的 intelRefs 对齐全量校验：W4 起 draft 引用
 * 必须存在于 intel.json——fixture 数据改为 seedResearch golden 的真实条目 id）。
 * W4 新增：draft intelRefs 引用存在性校验（缺失列明报错）、修订保留（FR-6 验收②
 * 未受影响天 stops 逐项相等）、正常 draft routeCheck.issues=[]、动线校验结果落盘、
 * intel 缺失时引用校验降级为 warning。
 *
 * 状态机纪律（编排者裁定，design §5.4 转换表不扩展）：测试**驱动完整规范序列**
 * intake → research（seedResearch 真实工具）→ build，不手写跳步；
 * 非法序列（confirmed 直接 build / delivered 直接 build）走真实前置态构造。
 * production 转换断言在各工具内（assertTransition：confirmed→researching /
 * researching→generating / generating→delivered / delivered→revising→generating）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runUpdate } from '../src/tools/update.js'
import { runRecordResearchAssessment } from '../src/tools/research-assessment.js'
import { runBuildItinerary, autoProposeItinerary, addDaysUtc, preserveUnchangedDays } from '../src/tools/build-itinerary.js'
import { runRenderPage } from '../src/tools/render-page.js'
import { validateItinerary } from '../src/models/validate.js'
import { TravelValidationError } from '../src/errors.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedPlaces } from './helpers/seed-places.js'
import type { IntelItem, Itinerary, ItineraryDay, PlacesArtifact, ResearchState, ResolvedPlace } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-build-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function intelItem(id: string, opts: { category?: IntelItem['category']; coords?: boolean; title?: string } = {}): IntelItem {
  return {
    id,
    category: opts.category ?? 'attraction',
    channel: 'tencent-poi',
    title: opts.title ?? `intel-${id}`,
    summary: `summary-${id}`,
    source: { platform: 'tencent-map', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-02T00:00:00.000Z' },
    ...(opts.coords !== false ? { coords: { lng: 114.3 + Number(id.replace(/\D/g, '') ?? 0) / 1000, lat: 30.5, sys: 'GCJ02' as const } } : {}),
    confidence: 'high',
  }
}

/** 为完整 plan 装配当前 sufficient 评估（C5① 门放行件：完整 plan build 需研究版本有效 + 当前 sufficient 评估）。 */
async function seedSufficientAssessment(planId: string): Promise<void> {
  await runRecordResearchAssessment({ planId, verdict: 'sufficient', rationale: '测试装配：研究已充分（供 build 门放行）' }, store)
}

/** 追加已解析地点到 places.json（C5② 门放行件：draft stop 坐标须可归属到 places.json/带坐标 intel）。 */
async function appendPlaces(planId: string, places: ResolvedPlace[]): Promise<void> {
  const artifact = await store.readJson<PlacesArtifact>(planId, 'places.json')
  await store.writeJson(planId, 'places.json', {
    ...(artifact as PlacesArtifact),
    places: [...(artifact?.places ?? []), ...places],
  })
}

/** 规范序列前置：intake（confirmed）→ research（真实工具，POI golden + L0 hits）→ 评估 → places（决策 5：受串行门）。 */
async function makeResearchDonePlan(): Promise<string> {
  const result = await runIntake({
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
  }, store)
  expect(result.status).toBe('confirmed')
  await seedResearch(store, result.planId, { poi: 'golden', l0: 'hits' })
  await seedSufficientAssessment(result.planId)
  await seedPlaces(store, result.planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
  const request = await store.loadRequest(result.planId)
  expect(request?.status).toBe('researching') // research 工具合法推进
  return result.planId
}

describe('自动提案（无 draft）：规范序列 intake→research→build', () => {
  it('research 后 build → itinerary.json：days/stops/intelRefs/coords{sys}/durationHint + 契约闸门 + generating', async () => {
    const planId = await makeResearchDonePlan()
    const result = await runBuildItinerary({ planId }, store)
    expect(result.built).toBe(true)
    expect(result.itineraryId).toBe(`itinerary-${planId}`)
    expect(result.days).toHaveLength(3)

    const saved = await store.readJson<Itinerary>(planId, 'itinerary.json')
    expect(saved).toBeDefined()
    expect(validateItinerary(saved)).toEqual([]) // §5.5 落盘闸门
    expect(saved!.days[0].date).toBe('2026-10-01')
    expect(saved!.days[2].date).toBe('2026-10-03')
    for (const day of saved!.days) {
      for (const stop of day.stops) {
        expect(stop.intelRefs.length).toBeGreaterThan(0)
        expect(stop.coords.sys).toBe('GCJ02')
        expect(stop.durationHint).toBeGreaterThan(0)
        expect(stop.name.length).toBeGreaterThan(0)
      }
    }
    const allStops = saved!.days.flatMap((d) => d.stops)
    expect(allStops.some((s) => s.category === 'attraction')).toBe(true)
    // 引用存在性（W4 全量校验前的最低口径：id 落在 research 产出的 intel 内）
    const intelIds = new Set(((await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []).map((i) => i.id))
    expect(allStops.flatMap((s) => s.intelRefs).every((ref) => intelIds.has(ref))).toBe(true)

    const request = await store.loadRequest(planId)
    expect(request?.status).toBe('generating') // researching→generating 由 build 推进
  })

  // fanout 单源退避重试（1s/4s，§9.3-1，见 src/orchestrator/fanout.ts）现为默认行为：
  // 全渠道失败路径预期 >5s，故本组三例显式放宽超时以覆盖该退避预算。
  it('research 全渠道失败（无 intel）→ build built=false + 不落盘 itinerary.json', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 决策 5：门放行件；验证 intel 缺失语义
    const research = await seedResearch(store, planId, { poi: 'fail', l0: 'none' })
    expect(research.itemCount).toBe(0) // 全渠道失败
    expect((await store.loadRequest(planId))?.status).toBe('researching')
    await seedSufficientAssessment(planId) // C5① 门放行：研究版本有效 + 评估 sufficient；验证 intel 缺失语义

    const result = await runBuildItinerary({ planId }, store)
    expect(result.built).toBe(false)
    expect(result.reason).toContain('intel.json')
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
  }, 20_000)

  it('research 产出无坐标条目 → build built=false（不产空/无坐标行程）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 决策 5：门放行件；验证无坐标语义
    // 仅 L0 渠道命中：标题级摘要条目无坐标（l0HitToIntelItem 不含 coords）
    const research = await seedResearch(store, planId, { poi: 'none', l0: 'hits' })
    expect(research.itemCount).toBeGreaterThan(0)
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    expect(intel.every((i) => i.coords === undefined)).toBe(true)
    await seedSufficientAssessment(planId) // C5① 门放行：验证无坐标整绘语义

    const result = await runBuildItinerary({ planId }, store)
    expect(result.built).toBe(false)
    expect(result.reason).toContain('无带坐标条目')
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
  })

  it('autoProposeItinerary 纯函数：景点少于天数 → warnings 提醒（不阻塞）', () => {
    const result = autoProposeItinerary('plan-x', {
      destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-05',
    }, [intelItem('a1')])
    expect(result.built).toBe(true)
    expect(result.days).toHaveLength(5)
    expect(result.routeCheck.warnings.some((w) => w.includes('少于行程天数'))).toBe(true)
  })

  it('addDaysUtc：跨月/跨年正确', () => {
    expect(addDaysUtc('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDaysUtc('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('draft 路径：结构校验 + intelRefs 引用存在性 + 修订保留 + 动线校验', () => {
  // seedResearch golden fixture 的真实条目 id（W4 起 draft intelRefs 必须存在）
  const ID_HUANGHELOU = 'tencent-poi:16294309905749563320'       // 黄鹤楼
  const ID_HUANGHELOU_SCENIC = 'tencent-poi:2738900478225601695' // 黄鹤楼景区
  const ID_NIGHT_HUANGHELOU = 'tencent-poi:2323422242271982152'  // 夜上黄鹤楼
  const validDraftDays: ItineraryDay[] = [
    {
      date: '2026-10-01',
      stops: [{ name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: [ID_HUANGHELOU] }],
      meals: [],
    },
    {
      date: '2026-10-02',
      // fix-f1e C：draft stop 坐标须与所引 intel 坐标一致（coordsClose）——原 东湖
      // (114.4,30.6) 引用黄鹤楼景区 intel (114.304774,30.543888) 属来源错配，收紧
      // 后会拒绝；fixture 改为与 intel 坐标一致的 夜上黄鹤楼（归属② 可验证放行）。
      stops: [{ name: '夜上黄鹤楼', category: 'attraction', coords: { lng: 114.302414, lat: 30.544660, sys: 'GCJ02' }, durationHint: 90, intelRefs: [ID_NIGHT_HUANGHELOU] }],
      meals: [],
    },
  ]

  it('合法 draft（research 后）→ 结构校验通过 + 原样聚合（不重排不补全）', async () => {
    const planId = await makeResearchDonePlan()
    const result = await runBuildItinerary({ planId, draft: { days: validDraftDays } }, store)
    expect(result.built).toBe(true)
    expect(result.days).toEqual(validDraftDays) // 原样
    const saved = await store.readJson<Itinerary>(planId, 'itinerary.json')
    expect(saved?.days).toEqual(validDraftDays)
    expect(validateItinerary(saved!)).toEqual([])
  })

  it('非法 draft（days 非数组）→ TravelValidationError', async () => {
    const planId = await makeResearchDonePlan()
    await expect(runBuildItinerary({ planId, draft: { days: 'nope' } }, store)).rejects.toThrow(TravelValidationError)
    await expect(runBuildItinerary({ planId, draft: {} }, store)).rejects.toThrow(/draft\.days/)
  })

  it('非法 draft（stop 缺 intelRefs）→ TravelValidationError', async () => {
    const planId = await makeResearchDonePlan()
    const badDays = [{
      date: '2026-10-01',
      stops: [{ name: 'x', category: 'attraction', coords: { lng: 1, lat: 1, sys: 'GCJ02' } }], // 无 intelRefs
      meals: [],
    }]
    await expect(runBuildItinerary({ planId, draft: { days: badDays } }, store)).rejects.toThrow(TravelValidationError)
  })

  it('draft 引用不存在 intelId（intel.json 存在）→ 校验错误逐条列明，不落盘半成品', async () => {
    const planId = await makeResearchDonePlan()
    const draft = {
      days: [{
        date: '2026-10-01',
        stops: [
          { name: '幽灵站', category: 'attraction', coords: { lng: 114.3, lat: 30.5, sys: 'GCJ02' }, durationHint: 60, intelRefs: ['ghost-1'] },
          { name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: [ID_HUANGHELOU] },
        ],
        meals: [{ name: '黄鹤楼团餐', intelRefs: ['ghost-2'] }],
      }],
    }
    await expect(runBuildItinerary({ planId, draft }, store)).rejects.toThrow(TravelValidationError)
    await expect(runBuildItinerary({ planId, draft }, store)).rejects.toThrow(/ghost-1/)
    await expect(runBuildItinerary({ planId, draft }, store)).rejects.toThrow(/ghost-2/) // stops+meals 均校验
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined() // 校验失败不写盘
  })

  it('修订场景（FR-6 验收②）：未受影响天原样保留逐项相等，受影响天采用新 draft', async () => {
    const planId = await makeResearchDonePlan()
    const d1: ItineraryDay[] = [
      {
        date: '2026-10-01', theme: '初识江城',
        stops: [{ name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: [ID_HUANGHELOU], note: '第一版 note' }],
        meals: [{ name: '热干面', intelRefs: [ID_HUANGHELOU] }], lodgingArea: '武昌',
      },
      {
        date: '2026-10-02',
        stops: [{ name: '夜上黄鹤楼', category: 'attraction', coords: { lng: 114.302414, lat: 30.544660, sys: 'GCJ02' }, durationHint: 90, intelRefs: [ID_NIGHT_HUANGHELOU] }],
        meals: [],
      },
      {
        date: '2026-10-03',
        stops: [{ name: '黄鹤楼景区', category: 'attraction', coords: { lng: 114.304774, lat: 30.543888, sys: 'GCJ02' }, durationHint: 150, intelRefs: [ID_HUANGHELOU_SCENIC] }],
        meals: [],
      },
    ]
    const built1 = await runBuildItinerary({ planId, draft: { days: d1 } }, store)
    expect(built1.built).toBe(true)
    expect((await store.loadRequest(planId))?.status).toBe('generating')

    // 规范序列：render → delivered → update（真实修订入口）→ revising
    await runRenderPage({ planId }, store, { host: '127.0.0.1', port: 0, register() {} })
    expect((await store.loadRequest(planId))?.status).toBe('delivered')
    const updated = await runUpdate({ planId, patch: { slots: { constraints: ['少走路'] } } }, store)
    expect(updated.status).toBe('revising')

    // 修订 draft：仅第 2 天变化（名称/时长/引用）；第 1、3 天未受影响
    const d2: ItineraryDay[] = [
      { ...d1[0] }, // 同 d1 第 1 天（未受影响）
      {
        date: '2026-10-02',
        stops: [{ name: '黄鹤楼景区', category: 'attraction', coords: { lng: 114.304774, lat: 30.543888, sys: 'GCJ02' }, durationHint: 180, intelRefs: [ID_HUANGHELOU_SCENIC] }],
        meals: [],
      },
      { ...d1[2] }, // 同 d1 第 3 天（未受影响）
    ]
    const built2 = await runBuildItinerary({ planId, draft: { days: d2 } }, store)
    expect(built2.built).toBe(true)
    expect((await store.loadRequest(planId))?.status).toBe('generating')

    // FR-6 验收②：未受影响日 stops 名称/顺序/时长/来源引用 逐项相等（整体 deep equal 含 note）
    expect(built2.days[0]).toEqual(d1[0])
    expect(built2.days[2]).toEqual(d1[2])
    // 受影响日采用新 draft
    expect(built2.days[1].stops[0].name).toBe('黄鹤楼景区')
    expect(built2.days[1].stops[0].durationHint).toBe(180)
    expect(built2.days[1].stops[0].intelRefs).toEqual([ID_HUANGHELOU_SCENIC])
  })

  it('修订保留纯函数：stops 逐项相等 → 保留上一版；任一字段差异 → 采用 draft', () => {
    const prev: Itinerary = {
      itineraryId: 'it',
      days: [{
        date: '2026-10-01',
        stops: [{ name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: [ID_HUANGHELOU], note: 'prev-note' }],
        meals: [{ name: '热干面', intelRefs: [ID_HUANGHELOU] }],
      }],
      routeCheck: { issues: [], warnings: [] },
    }
    const sameDraft: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [{ name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: [ID_HUANGHELOU], note: '改写后的 note' }],
      meals: [{ name: '热干面', intelRefs: [ID_HUANGHELOU] }],
    }]
    // note 不参与判定（FR 口径=名称/顺序/时长/引用）→ 判定未受影响 → 保留 prev 结构（含原 note）
    expect(preserveUnchangedDays(prev, sameDraft)[0]).toEqual(prev.days[0])
    const changedDraft: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [{ name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 90, intelRefs: [ID_HUANGHELOU] }], // durationHint 变
      meals: [],
    }]
    expect(preserveUnchangedDays(prev, changedDraft)[0]).toEqual(changedDraft[0])
  })

  it('正常 draft → routeCheck.issues=[]、warnings 合理；动线校验结果落盘 itinerary.json', async () => {
    const planId = await makeResearchDonePlan()
    const days: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: [ID_HUANGHELOU] },
        { name: '黄鹤楼景区', category: 'attraction', coords: { lng: 114.304774, lat: 30.543888, sys: 'GCJ02' }, durationHint: 150, intelRefs: [ID_HUANGHELOU_SCENIC] },
      ],
      meals: [],
    }]
    const result = await runBuildItinerary({ planId, draft: { days } }, store)
    expect(result.built).toBe(true)
    expect(result.routeCheck.issues).toEqual([]) // 就近成片无折返
    const saved = await store.readJson<Itinerary>(planId, 'itinerary.json')
    expect(saved?.routeCheck).toBeDefined()
    expect(saved?.routeCheck.issues).toEqual([])
    expect(Array.isArray(saved?.routeCheck.warnings)).toBe(true)
    expect(validateItinerary(saved!)).toEqual([])
  })

  it('intel.json 缺失（检索全失败）→ draft 照常聚合 + warning「引用存在性未校验」', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 决策 5：门放行件
    await seedResearch(store, planId, { poi: 'fail', l0: 'none' }) // researching + 无 intel.json（W3 退避重试慢，见文件头注释）
    await seedSufficientAssessment(planId) // C5① 门放行：验证 intel 缺失下 draft 聚合语义
    // C5② 门放行：draft stop 坐标须可归属——补 places.json 同名同坐标地点（intel 缺失仍可走 draft 聚合）
    await appendPlaces(planId, [{
      placeId: 'place-x', candidateId: 'x', name: 'x', kind: 'attraction', pointKind: 'poi',
      coords: { lng: 114.3, lat: 30.5, sys: 'GCJ02' }, source: 'amap', coordinate_source: 'amap', resolveConfidence: 'high',
    }])
    const draft = {
      days: [{
        date: '2026-10-01',
        stops: [{ name: 'x', category: 'attraction', coords: { lng: 114.3, lat: 30.5, sys: 'GCJ02' }, intelRefs: ['ghost-ref'] }],
        meals: [],
      }],
    }
    const result = await runBuildItinerary({ planId, draft }, store)
    expect(result.built).toBe(true)
    expect(result.routeCheck.warnings.some((w) => w.includes('引用存在性未校验'))).toBe(true)
  }, 20_000)

  it('draft 路径不依赖 intel.json（原样聚合优先），状态仍须合法（researching）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 决策 5：门放行件
    await seedResearch(store, planId, { poi: 'fail', l0: 'none' }) // researching + 无 intel（W3 退避重试慢，见文件头注释）
    await seedSufficientAssessment(planId) // C5① 门放行：验证 draft 原样聚合不依赖 intel
    // C5② 门放行：validDraftDays 的 stop 坐标须可归属——补 places.json 同名同坐标地点
    await appendPlaces(planId, [
      { placeId: 'place-hhl', candidateId: 'hhl', name: '黄鹤楼', kind: 'attraction', pointKind: 'poi',
        coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, source: 'amap', coordinate_source: 'amap', resolveConfidence: 'high' },
      { placeId: 'place-nhhl', candidateId: 'nhhl', name: '夜上黄鹤楼', kind: 'attraction', pointKind: 'poi',
        coords: { lng: 114.302414, lat: 30.544660, sys: 'GCJ02' }, source: 'amap', coordinate_source: 'amap', resolveConfidence: 'high' },
    ])
    const result = await runBuildItinerary({ planId, draft: { days: validDraftDays } }, store)
    expect(result.built).toBe(true)
  }, 20_000)

  it('C5②：完整 plan 下 draft stop 坐标来源未知（未匹配 places.json 且未归属带坐标 intel）→ 拒绝（不静默接受）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    const req0 = await store.loadRequest(planId)
    await store.saveRequest({ ...req0!, status: 'researching', updatedAt: new Date().toISOString() })
    await store.saveResearchState(planId, {
      schemaVersion: 1, researchVersion: 1, updatedAt: '2026-09-02T00:00:00.000Z', rounds: ['r1'],
      budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false }, sources: ['tencent-poi'], itemIndex: [],
    })
    await seedSufficientAssessment(planId)
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 仅入口 '武汉'，无 '神秘景点'
    // intel 条目存在但不带坐标（无法经 intelRefs 归属坐标）
    await store.writeJson(planId, 'intel.json', [{
      id: 'item-nocoords', category: 'attraction', channel: 'tencent-poi', title: '神秘景点',
      summary: '无坐标', source: { platform: 'tencent-map', url: 'https://example.invalid/x', fetchedAt: '2026-09-02T00:00:00.000Z' },
      confidence: 'high',
    }])
    const draft = {
      days: [{
        date: '2026-10-01',
        stops: [{ name: '神秘景点', category: 'attraction', coords: { lng: 1.0, lat: 1.0, sys: 'GCJ02' }, intelRefs: ['item-nocoords'] }],
        meals: [],
      }],
    }
    await expect(runBuildItinerary({ planId, draft }, store)).rejects.toThrow(TravelValidationError)
    await expect(runBuildItinerary({ planId, draft }, store))
      .rejects.toThrow(/坐标来源未知/)
    await expect(runBuildItinerary({ planId, draft }, store))
      .rejects.toThrow(/可匹配 place.*武汉.*place-entry/)
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined() // 不落盘半成品
  })

  it('fix-f1e C：intelRefs 带坐标但与 stop.coords 不一致（来源错配）→ 拒绝（不静默接受）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    const req0 = await store.loadRequest(planId)
    await store.saveRequest({ ...req0!, status: 'researching', updatedAt: new Date().toISOString() })
    await store.saveResearchState(planId, {
      schemaVersion: 1, researchVersion: 1, updatedAt: '2026-09-02T00:00:00.000Z', rounds: ['r1'],
      budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false }, sources: ['tencent-poi'], itemIndex: [],
    })
    await seedSufficientAssessment(planId)
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
    // intel 条目带坐标，但坐标在遥远异处（来源 A）；draft stop 声称坐标 B——来源错配
    await store.writeJson(planId, 'intel.json', [{
      id: 'item-far', category: 'attraction', channel: 'tencent-poi', title: '遥远处',
      summary: '远', source: { platform: 'tencent-map', url: 'https://example.invalid/far', fetchedAt: '2026-09-02T00:00:00.000Z' },
      coords: { lng: 114.9, lat: 31.2, sys: 'GCJ02' }, confidence: 'high',
    }])
    const draft = {
      days: [{
        date: '2026-10-01',
        stops: [{ name: '遥远处', category: 'attraction', coords: { lng: 114.3, lat: 30.5, sys: 'GCJ02' }, intelRefs: ['item-far'] }],
        meals: [],
      }],
    }
    // 归属② 收紧：intel 必须与 stop.coords 一致（coordsClose）才放行；异处坐标 → unbound
    await expect(runBuildItinerary({ planId, draft }, store)).rejects.toThrow(/坐标来源未知/)
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
  })

  it('fix-f1e C：intelRefs 带坐标且与 stop.coords 一致（coordsClose）→ 放行', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    const req0 = await store.loadRequest(planId)
    await store.saveRequest({ ...req0!, status: 'researching', updatedAt: new Date().toISOString() })
    await store.saveResearchState(planId, {
      schemaVersion: 1, researchVersion: 1, updatedAt: '2026-09-02T00:00:00.000Z', rounds: ['r1'],
      budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false }, sources: ['tencent-poi'], itemIndex: [],
    })
    await seedSufficientAssessment(planId)
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 无 '登黄鹤楼' 同名地点
    // intel 条目带坐标，且与 draft stop 坐标一致（≤0.01°）→ 归属② 可验证
    await store.writeJson(planId, 'intel.json', [{
      id: 'item-hhl2', category: 'attraction', channel: 'tencent-poi', title: '黄鹤楼（新版）',
      summary: '近', source: { platform: 'tencent-map', url: 'https://example.invalid/hhl2', fetchedAt: '2026-09-02T00:00:00.000Z' },
      coords: { lng: 114.3026, lat: 30.5447, sys: 'GCJ02' }, confidence: 'high',
    }])
    const draft = {
      days: [{
        date: '2026-10-01',
        stops: [{ name: '黄鹤楼（新版）', category: 'attraction', coords: { lng: 114.3025, lat: 30.5446, sys: 'GCJ02' }, intelRefs: ['item-hhl2'] }],
        meals: [],
      }],
    }
    const result = await runBuildItinerary({ planId, draft }, store)
    expect(result.built).toBe(true)
  })
})

describe('build 状态机边界（转换表不扩展）', () => {
  it('计划不存在 → TravelValidationError', async () => {
    await expect(runBuildItinerary({ planId: 'plan-nope' }, store)).rejects.toThrow(TravelValidationError)
  })

  it('confirmed 直接 build（未 research）→ 非法转换被拒（confirmed 仅允许→researching）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    expect(intake.status).toBe('confirmed')
    await expect(runBuildItinerary({ planId: intake.planId }, store)).rejects.toThrow(/非法转换/)
    expect(await store.readJson<unknown>(intake.planId, 'itinerary.json')).toBeUndefined() // 未留半成品
  })

  it('delivered 直接 build → 被拒；走 update(→revising) 后 build 合法（delivered→revising→generating）', async () => {
    // 规范序列到 delivered：intake → research → build → render
    const planId = await makeResearchDonePlan()
    await runBuildItinerary({ planId }, store)
    await runRenderPage({ planId }, store, { host: '127.0.0.1', port: 0, register() {} })
    const delivered = await store.loadRequest(planId)
    expect(delivered?.status).toBe('delivered')

    // delivered 直接 build → 被拒（须先 update 修订入口）
    await expect(runBuildItinerary({ planId }, store)).rejects.toThrow(/非法转换/)

    // update（修订槽位）→ delivered→revising
    const updated = await runUpdate({ planId, patch: { slots: { constraints: ['少走路'] } } }, store)
    expect(updated.status).toBe('revising')
    // revising→generating 合法重建
    const revised = await runBuildItinerary({ planId }, store)
    expect(revised.built).toBe(true)
    expect((await store.loadRequest(planId))?.status).toBe('generating')
  })
})

// ────────────────────────── C 期产品链门：完整 plan 需 places（R-2） ──────────────────────────

describe('C 产品链门：完整 plan（flowVersion）无 places → blocked 零网络；legacy 不套门', () => {
  // 局部合法 draft（须含 intelRefs；legacy 路径验证「不套门照常聚合」用）
  const LEGACY_DRAFT = {
    days: [{
      date: '2026-10-01',
      stops: [{ name: '黄鹤楼', category: 'attraction', coords: { lng: 114.302539, lat: 30.544624, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['tencent-poi:16294309905749563320'] }],
      meals: [],
    }],
  }
  it('T24 集成：build 的 routeCheck 在旁车可绑定时用真实驾驶里程比较（真实 wiring）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
    await seedSufficientAssessment(planId)
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 })

    // 两天各两站（同日相邻段存在）→ 走真实 build 路径（draft 面），坐标经 places 归属。
    const draftDays: ItineraryDay[] = [
      {
        date: '2026-10-01',
        stops: [
          { name: '武汉·甲', category: 'attraction', coords: { lng: 114.30, lat: 30.50, sys: 'GCJ02' }, intelRefs: [], durationHint: 90 },
          { name: '武汉·乙', category: 'attraction', coords: { lng: 114.36, lat: 30.55, sys: 'GCJ02' }, intelRefs: [], durationHint: 90 },
        ],
        meals: [],
      },
      {
        date: '2026-10-02',
        stops: [
          { name: '武汉·丙', category: 'attraction', coords: { lng: 114.32, lat: 30.52, sys: 'GCJ02' }, intelRefs: [], durationHint: 90 },
          { name: '武汉·丁', category: 'attraction', coords: { lng: 114.38, lat: 30.57, sys: 'GCJ02' }, intelRefs: [], durationHint: 90 },
        ],
        meals: [],
      },
    ]
    // places 覆盖 4 站（同名 + 坐标一致）→ stopPlaceIdBindings 可命中。
    const places = await store.readJson<PlacesArtifact>(planId, 'places.json')
    const enriched: PlacesArtifact = {
      ...places!,
      places: [
        ...places!.places,
        ...draftDays.flatMap((d) => d.stops).map((stop, i): ResolvedPlace => ({
          placeId: `place-${i}`, candidateId: `c-${i}`, name: stop.name, kind: 'area',
          pointKind: 'poi', coords: stop.coords, source: 'amap', coordinate_source: 'amap', resolveConfidence: 'high',
        })),
      ],
      status: 'ready',
    }
    await store.writeJson(planId, 'places.json', enriched)

    // 旁车按「选中序列相邻边」口径给 orderIndex：D1 边 0、D2 边 1（与 route-transport
    // 一致，跨日累加不重置）。真实驾驶里程远超几何距离 → 只有真绑定才可能告警。
    const legs = [
      { id: 'leg-0', fromPlaceId: 'place-0', toPlaceId: 'place-1', orderIndex: 0, placesVersion: 1, mode: 'driving' as const, status: 'queried' as const, distanceKm: 360, observedAt: '2026-09-09T00:00:00.000Z' },
      { id: 'leg-1', fromPlaceId: 'place-2', toPlaceId: 'place-3', orderIndex: 1, placesVersion: 1, mode: 'driving' as const, status: 'queried' as const, distanceKm: 370, observedAt: '2026-09-09T00:00:00.000Z' },
    ]
    const built = await runBuildItinerary({ planId, draft: { days: draftDays } }, store, {
      options: { pace: 'balanced', routeTransport: legs },
    })
    expect(built.built).toBe(true)
    // 两天都被真实里程绑定 → 均按 balanced 自驾阈值 350km 告警（若绑定失败则几何 ~7km 不告警）。
    const realDriving = built.routeCheck.warnings.filter((w) => w.includes('真实驾驶距离'))
    expect(realDriving).toHaveLength(2)
    expect(realDriving[0]).toContain('覆盖 1/1 段')
    expect(built.routeCheck.warnings.every((w) => !w.includes('Infinity'))).toBe(true)
  })

  it('结构化完整 plan（researchIntent→flowVersion）researching 态无 places → blocked+nextAction，不落盘、零动线网络', async () => {
    const result = await runIntake({
      slots: {
        researchIntent: { text: '青甘大环线 8 天自驾' },
        dateStart: '2026-10-01', dateEnd: '2026-10-08',
      },
    }, store)
    expect(result.request.flowVersion).toBe('1')
    const planId = result.planId
    const req = await store.loadRequest(planId)
    await store.saveRequest({ ...req!, status: 'researching', updatedAt: new Date().toISOString() })

    // 带会爆炸的 provider：若门未拦（走动线校验）必然报错 → 证明零网络
    const boomProvider = {
      name: 'boom', label: 'boom', modes: ['driving'] as const,
      async available() { throw new Error('should not be called') },
      async measure() { throw new Error('should not be called') },
    }
    const out = await runBuildItinerary({ planId, draft: { days: LEGACY_DRAFT.days } }, store, {
      providers: [boomProvider],
    })
    expect(out.built).toBe(false)
    expect(out.blocked).toBeDefined()
    expect(out.blocked!.reason).toBe('places_not_ready')
    expect(out.blocked!.nextAction).toMatch(/resolve_places/)
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
  })

  it('destination-only 新 plan（决策 5：自动 flowVersion）→ 同样受产品链门；真正 legacy（去信封）不套门（轻量路径保留）', async () => {
    // F1c-E：destination-only 新 plan（mapped 种子）confirmed → flowVersion='1' → 受串行门。
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    expect(intake.request.flowVersion).toBe('1')
    const planId = intake.planId
    const req = await store.loadRequest(planId)
    await store.saveRequest({ ...req!, status: 'researching', updatedAt: new Date().toISOString() })
    const gated = await runBuildItinerary({ planId, draft: { days: LEGACY_DRAFT.days } }, store)
    expect(gated.built).toBe(false)
    expect(gated.blocked).toBeDefined()
    expect(gated.blocked!.reason).toBe('places_not_ready')
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()

    // 真正 legacy 形态（请求文件无 flowVersion 信封 → 旧计划/未走新写入口）→ 不套门（轻量路径保留）
    await store.saveRequest({ ...req!, flowVersion: undefined, status: 'researching', updatedAt: new Date().toISOString() })
    const legacy = await runBuildItinerary({ planId, draft: { days: LEGACY_DRAFT.days } }, store)
    expect(legacy.blocked).toBeUndefined()
    expect(legacy.built).toBe(true)
  })

  it('C5①：完整 plan 研究后无 sufficient 评估（或有 places）→ research_not_ready blocked + nextAction，零网络', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    // research 已做（researchVersion=1）+ places 就绪，但未提交 sufficient 评估
    await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
    const boomProvider = {
      name: 'boom', label: 'boom', modes: ['driving'] as const,
      async available() { throw new Error('should not be called') },
      async measure() { throw new Error('should not be called') },
    }
    const out = await runBuildItinerary({ planId, draft: { days: LEGACY_DRAFT.days } }, store, { providers: [boomProvider] })
    expect(out.built).toBe(false)
    expect(out.blocked).toBeDefined()
    expect(out.blocked!.reason).toBe('research_not_ready')
    expect(out.blocked!.nextAction).toMatch(/assessment|sufficient/)
    expect(await store.readJson<unknown>(planId, 'itinerary.json')).toBeUndefined()
  })

  it('fix-f1f #4b：研究前进但 places 未重 resolve（places.intelVersion 落后当前研究版本）→ blocked places_stale_intel 引导重新 resolve；当前版放行', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    // 研究 v1 + 当前 sufficient + places（intelVersion=1）→ 对照：版本一致放行
    await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
    await seedSufficientAssessment(planId)
    await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
    const ok = await runBuildItinerary({ planId }, store) // auto 提案（intel 有坐标）
    expect(ok.built).toBe(true)

    // 研究前进到 v2（模拟第二轮研究完成），但 places 未重新 travel_resolve_places
    const st = await store.loadResearchState<ResearchState>(planId)
    expect(st).toBeDefined()
    await store.saveResearchState(planId, {
      ...st!,
      researchVersion: st!.researchVersion + 1,
      updatedAt: new Date().toISOString(),
      rounds: [...(st!.rounds ?? []), 'round-2'],
    })

    // 带会爆炸的 provider：若门未拦（走动线校验）必然报错 → 证明零网络
    const boomProvider = {
      name: 'boom', label: 'boom', modes: ['driving'] as const,
      async available() { throw new Error('should not be called') },
      async measure() { throw new Error('should not be called') },
    }
    const out = await runBuildItinerary({ planId }, store, { providers: [boomProvider] })
    expect(out.built).toBe(false)
    expect(out.blocked).toBeDefined()
    expect(out.blocked!.reason).toBe('places_stale_intel')
    expect(out.blocked!.nextAction).toMatch(/resolve_places/)
    expect(out.reason).toContain('研究已前进') // 门文案透出（不静默消费旧 places）
    // 本次 blocked 调用未改写 itinerary.json（对照：首个 build 已落盘，此处验证内容仍合法）
    const saved = await store.readJson<Itinerary>(planId, 'itinerary.json')
    expect(saved).toBeDefined()
    expect(validateItinerary(saved)).toEqual([])
  })
})