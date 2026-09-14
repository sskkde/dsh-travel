/**
 * W2 T10 route-coverage v2 与 lineage 引用链（草稿 C）。
 *
 * 验收（T10 Acceptance）：
 * - 由 fixture intel+places 派生各区域状态与原因码
 * - 多主题游记不整体绑定单城市（地点归属可验证，非仅字符串包含）
 * - OSM 坐标 + OSM 查询不计独立互证
 * - stale 版本显示
 * - coverage 不反向触发 intel/places
 *
 * 语义（草稿 C §131-138）：
 * - 有效研究区域 = 明确 regionHints ∪ 情报发现地点 ∪ 选中序列派生（不依赖旧 route.waypoints）
 * - covered = attraction/lodging 均有 ≥1 条合格情报 且 attraction 有可信坐标（且非仅 OSM 单源互证）
 * - 旧版本文件显示 stale；coverage 依赖 intel/places，不反向触发。
 *
 * 全确定性 fixture 注入，零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import {
  runRouteCoverage, computeRouteCoverageStale,
} from '../src/tools/route-coverage.js'
import { TravelValidationError } from '../src/errors.js'
import type {
  IntelItem, PlacesArtifact, ResolveCandidate, ResolvedPlace, ResearchState,
} from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-coverage-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' as const }
}

function src(platform: string, url: string): { platform: string; url: string; fetchedAt: string } {
  return { platform, url, fetchedAt: '2026-09-02T00:00:00.000Z' }
}

/** 情报条目。source.platform 含 'osm' 视为 OSM 派生（OSM 查询）；否则常规渠道。 */
function intelItem(id: string, name: string, category: IntelItem['category'], opts: {
  platform?: string
  withCoords?: boolean
  noProvenance?: boolean
} = {}): IntelItem {
  const platform = opts.platform ?? 'tencent-map'
  return {
    id,
    category,
    channel: platform === 'osm' ? 'web' as const : 'tencent-poi' as const,
    title: name,
    summary: `摘要 ${name}`,
    source: opts.noProvenance !== true ? src(platform, `https://example.invalid/${id}`) : { platform: '', url: '', fetchedAt: '' },
    ...(opts.withCoords ?? true ? { coords: coords(94.6 + Number(id.replace(/\D/g, '')) / 100, 40.1) } : {}),
    confidence: 'high',
  }
}

function candidate(id: string, name: string, kind: ResolveCandidate['kind'], regionHint: string, opts: {
  intelRefs?: string[]
  userRef?: string
} = {}): ResolveCandidate {
  return {
    candidateId: id,
    name,
    kind,
    ...(regionHint !== '' ? { regionHint } : {}),
    ...(opts.intelRefs ? { intelRefs: opts.intelRefs } : {}),
    ...(opts.userRef ? { userRef: opts.userRef } : {}),
  }
}

function place(candidateId: string, name: string, kind: ResolvedPlace['kind'], opts: {
  coords?: { lng: number; lat: number; sys: 'GCJ02' }
  coordinate_source?: ResolvedPlace['coordinate_source']
} = {}): ResolvedPlace {
  return {
    placeId: `place-${candidateId}`,
    candidateId,
    name,
    kind,
    pointKind: kind === 'lodging' ? 'areaCenter' : 'poi',
    ...(opts.coords ? { coords: opts.coords } : {}),
    source: opts.coordinate_source === undefined ? 'intel' : opts.coordinate_source,
    coordinate_source: opts.coordinate_source ?? (opts.coords ? 'intel' : 'unresolved'),
    resolveConfidence: opts.coords ? 'high' : 'low',
  }
}

/** 装配「研究就绪 + places 已解析」计划。
 * 直接写 intel/places 工件并设版本账本（coverage 只读 intel/places，不反向触发）。
 * intelVersion = researchVersion（research-state）；placesVersion = versions.places。
 */
async function makePlanWithPlaces(opts: {
  intel: IntelItem[]
  candidates: ResolveCandidate[]
  places: ResolvedPlace[]
  selectedSequence: string[]
  intelVersion?: number
  placesVersion?: number
}): Promise<string> {
  const result = await runIntake({
    slots: { destination: '青甘环线', dateStart: '2026-09-01', dateEnd: '2026-09-10', days: 10 },
  }, store)
  const planId = result.planId
  const intelVersion = opts.intelVersion ?? 1
  const state: ResearchState = {
    schemaVersion: 1,
    researchVersion: intelVersion,
    updatedAt: '2026-09-02T00:00:00.000Z',
    rounds: ['round-1'],
    budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false },
    sources: ['tencent-poi'],
    itemIndex: opts.intel.map((i) => ({ itemId: i.id, roundId: 'round-1', channel: i.channel, title: i.title })),
  }
  await store.saveResearchState(planId, state)
  await store.writeJson(planId, 'intel.json', opts.intel)
  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion,
    inputFingerprint: 'fp-places',
    generatedAt: '2026-09-02T01:00:00.000Z',
    candidates: opts.candidates,
    places: opts.places,
    selectedSequence: opts.selectedSequence,
    originResolution: { origin: '西宁', resolved: true, coords: coords(101.8, 36.6), entryKind: 'city' },
    pendingClarifications: [],
    status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  const placesVersion = opts.placesVersion ?? 1
  await store.writeJson(planId, 'versions.json', { intel: intelVersion, places: placesVersion })
  return planId
}

/** 标准青甘 fixture：西宁（塔/湖）与敦煌（莫高窟），各自 attraction+lodging。 */
function qingganFixture(overrides: {
  dunhuangLodging?: boolean
  dunhuangIntelMissing?: boolean
} = {}): {
  intel: IntelItem[]
  candidates: ResolveCandidate[]
  places: ResolvedPlace[]
  selectedSequence: string[]
} {
  const intel: IntelItem[] = [
    intelItem('xn:ta', '塔尔寺', 'attraction'),
    intelItem('xn:hotel', '西宁青旅', 'lodging'),
    intelItem('dh:mogao', '莫高窟', 'attraction'),
  ]
  if (overrides.dunhuangLodging !== false) {
    intel.push(intelItem('dh:hotel', '敦煌酒店', 'lodging'))
  }
  const candidates: ResolveCandidate[] = [
    candidate('xn:ta', '塔尔寺', 'attraction', '西宁', { intelRefs: ['xn:ta'] }),
    candidate('xn:hotel', '西宁青旅', 'lodging', '西宁', { intelRefs: ['xn:hotel'] }),
    candidate('dh:mogao', '莫高窟', 'attraction', '敦煌', { intelRefs: ['dh:mogao'] }),
  ]
  if (overrides.dunhuangLodging !== false) {
    candidates.push(candidate('dh:hotel', '敦煌酒店', 'lodging', '敦煌', { intelRefs: ['dh:hotel'] }))
  }
  const places: ResolvedPlace[] = [
    place('xn:ta', '塔尔寺', 'attraction', { coords: coords(101.8, 36.5) }),
    place('xn:hotel', '西宁青旅', 'lodging', { coords: coords(101.9, 36.6) }),
    place('dh:mogao', '莫高窟', 'attraction', { coords: coords(94.8, 40.0) }),
  ]
  if (overrides.dunhuangLodging !== false) {
    places.push(place('dh:hotel', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) }))
  }
  return {
    intel,
    candidates,
    places,
    selectedSequence: candidates.map((c) => c.candidateId),
  }
}

describe('runRouteCoverage — 版本门与零网络', () => {
  it('计划不存在 → TravelValidationError', async () => {
    await expect(runRouteCoverage({ planId: 'nope' }, store))
      .rejects.toThrow(TravelValidationError)
  })

  it('无 places.json → places_not_ready 零网络', async () => {
    const result = await runIntake({
      slots: { destination: '西宁', dateStart: '2026-09-01', dateEnd: '2026-09-10', days: 10 },
    }, store)
    const { planId } = result
    const out = await runRouteCoverage({ planId }, store)
    expect(out.status).toBe('places_not_ready')
    expect(out.placesNotReady?.reason).toBe('places_not_ready')
    expect(out.regions).toEqual([])
  })

  it('expectedPlacesVersion 过期 → places_stale 不计算', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({ intel, candidates, places, selectedSequence, placesVersion: 3 })
    const out = await runRouteCoverage({ planId, expectedPlacesVersion: 2 }, store)
    expect(out.status).toBe('places_stale')
    expect(out.placesNotReady?.reason).toBe('places_stale')
    expect(out.regions).toEqual([])
  })
})

describe('runRouteCoverage — 区域派生与状态', () => {
  it('covered：attraction/lodging 均有情报且 attraction 可信坐标', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({ intel, candidates, places, selectedSequence })
    const out = await runRouteCoverage({ planId }, store)
    expect(out.status).toBe('ready')
    const byName = new Map(out.regions.map((r) => [r.name, r]))
    for (const name of ['西宁', '敦煌']) {
      const r = byName.get(name)
      expect(r).toBeDefined()
      expect(r!.status).toBe('covered')
      expect(r!.missingCategories).toEqual([])
      expect(r!.reasonCodes).toEqual([])
      expect(r!.coordsCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('QA happy：敦煌段 lodging 无条目 → 该区域 partial + missingCategories=[lodging]', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture({ dunhuangLodging: false })
    const planId = await makePlanWithPlaces({ intel, candidates, places, selectedSequence })
    const out = await runRouteCoverage({ planId }, store)
    const dunhuang = out.regions.find((r) => r.name === '敦煌')
    expect(dunhuang).toBeDefined()
    expect(dunhuang!.status).toBe('partial')
    expect(dunhuang!.missingCategories).toContain('lodging')
    // 西宁仍 covered
    const xining = out.regions.find((r) => r.name === '西宁')
    expect(xining!.status).toBe('covered')
  })

  it('QA failure：某区域零结果 → missing + reasonCode no_results（不报 covered）', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    // 大柴旦区域没有任何 intel/候选/地点 → 零结果
    const planId = await makePlanWithPlaces({
      intel,
      candidates: [...candidates, candidate('dcd:spot', '大柴旦翡翠湖', 'attraction', '大柴旦', { intelRefs: ['none:missing'] })],
      places: [...places, place('dcd:spot', '大柴旦翡翠湖', 'attraction')],
      selectedSequence: [...selectedSequence, 'dcd:spot'],
    })
    const out = await runRouteCoverage({ planId, regionHints: ['大柴旦'] }, store)
    const dcd = out.regions.find((r) => r.name === '大柴旦')
    expect(dcd).toBeDefined()
    expect(dcd!.status).toBe('missing')
    expect(dcd!.reasonCodes).toContain('no_results')
    expect(dcd!.missingCategories).toEqual(['attraction', 'lodging'])
    // covered 区域不受影响
    const dunhuang = out.regions.find((r) => r.name === '敦煌')
    expect(dunhuang!.status).toBe('covered')
  })

  it('filtered_quality：情报全无出处 → missing + filtered_quality', async () => {
    const { candidates, places, selectedSequence } = qingganFixture()
    const intel = [
      intelItem('xn:ta', '塔尔寺', 'attraction', { noProvenance: true }),
      intelItem('xn:hotel', '西宁青旅', 'lodging', { noProvenance: true }),
    ]
    // 只有西宁候选且其 intel 全部无出处
    const planId = await makePlanWithPlaces({
      intel,
      candidates: candidates.slice(0, 2),
      places: places.slice(0, 2),
      selectedSequence: selectedSequence.slice(0, 2),
    })
    const out = await runRouteCoverage({ planId }, store)
    const xining = out.regions.find((r) => r.name === '西宁')
    expect(xining).toBeDefined()
    expect(xining!.status).toBe('missing')
    expect(xining!.reasonCodes).toContain('filtered_quality')
  })

  it('unresolved_geo：两类情报齐但 attraction 无可信坐标 → partial（不 covered）', async () => {
    const { intel, candidates, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({
      intel,
      candidates,
      // 莫高窟 attraction 无 coords（unresolved），lodging 有坐标
      places: [
        place('xn:ta', '塔尔寺', 'attraction', { coords: coords(101.8, 36.5) }),
        place('xn:hotel', '西宁青旅', 'lodging', { coords: coords(101.9, 36.6) }),
        place('dh:mogao', '莫高窟', 'attraction'),
        place('dh:hotel', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) }),
      ],
      selectedSequence,
    })
    const out = await runRouteCoverage({ planId }, store)
    const dunhuang = out.regions.find((r) => r.name === '敦煌')
    expect(dunhuang!.status).toBe('partial')
    expect(dunhuang!.reasonCodes).toContain('unresolved_geo')
  })

  it('区域 = 显式 regionHints ∪ 候选 regionHint（不依赖 route.waypoints）', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    // 显式给一个空 regionHint 的候选、无其它数据 → 该区域零结果走 missing，但仍出现在区域集
    const planId = await makePlanWithPlaces({
      intel,
      candidates: [...candidates, candidate('mh:spot', '茫崖', 'attraction', '茫崖', { intelRefs: ['nope'] })],
      places: [...places, place('mh:spot', '茫崖', 'attraction')],
      selectedSequence,
    })
    const out = await runRouteCoverage({ planId, regionHints: ['茫崖'] }, store)
    const names = out.regions.map((r) => r.name)
    expect(names).toContain('茫崖')
    expect(names).toContain('西宁')
    expect(names).toContain('敦煌')
    // lineage 记录显式 hints
    expect(out.lineage.regionHints).toEqual(['茫崖'])
  })
})

describe('runRouteCoverage — lineage 与归属可验证', () => {
  it('lineage：regionHints/discoveredCandidates/selectedSequence 齐全', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({ intel, candidates, places, selectedSequence })
    const out = await runRouteCoverage({ planId, regionHints: ['西宁', '敦煌'] }, store)
    expect(out.lineage.discoveredCandidates).toEqual(
      expect.arrayContaining(['xn:ta', 'dh:mogao']),
    )
    expect(out.lineage.selectedSequence).toEqual(selectedSequence)
    // discoveredCandidates 派生自 intelRefs（情报发现）
    for (const id of ['xn:ta', 'xn:hotel', 'dh:mogao', 'dh:hotel']) {
      expect(out.lineage.discoveredCandidates).toContain(id)
    }
  })

  it('多主题游记不整体绑定单城市：仅被西宁候选引用的游记不上报为敦煌证据', async () => {
    // 一篇多主题游记 xn:multi 同时描述西宁与敦煌，但只被西宁「塔尔寺」候选引用
    const intel: IntelItem[] = [
      intelItem('xn:multi', '青甘环线多主题游记（含敦煌莫高窟段落）', 'attraction'),
      intelItem('xn:ta', '塔尔寺', 'attraction'),
      intelItem('xn:hotel', '西宁青旅', 'lodging'),
      intelItem('dh:hotel', '敦煌酒店', 'lodging'),
    ]
    const candidates: ResolveCandidate[] = [
      candidate('xn:ta', '塔尔寺', 'attraction', '西宁', { intelRefs: ['xn:ta', 'xn:multi'] }),
      candidate('xn:hotel', '西宁青旅', 'lodging', '西宁', { intelRefs: ['xn:hotel'] }),
      candidate('dh:hotel', '敦煌酒店', 'lodging', '敦煌', { intelRefs: ['dh:hotel'] }),
    ]
    const places: ResolvedPlace[] = [
      place('xn:ta', '塔尔寺', 'attraction', { coords: coords(101.8, 36.5) }),
      place('xn:hotel', '西宁青旅', 'lodging', { coords: coords(101.9, 36.6) }),
      place('dh:hotel', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) }),
    ]
    const planId = await makePlanWithPlaces({
      intel, candidates, places,
      selectedSequence: candidates.map((c) => c.candidateId),
    })
    const out = await runRouteCoverage({ planId }, store)
    const dunhuang = out.regions.find((r) => r.name === '敦煌')
    // 敦煌无 attraction 情报（xn:multi 仅被西宁候选引用，不因摘要含敦煌而归入）
    expect(dunhuang!.missingCategories).toContain('attraction')
    expect(dunhuang!.intelRefs).not.toContain('xn:multi')
    // 西宁引用了它 → 计入西宁 intelRefs 与 categoryCounts
    const xining = out.regions.find((r) => r.name === '西宁')
    expect(xining!.intelRefs).toContain('xn:multi')
    const attrCount = xining!.categoryCounts['attraction'] ?? 0
    expect(attrCount).toBeGreaterThanOrEqual(2)
  })

  it('OSM 坐标 + OSM 查询不计独立互证：仅 OSM 单源 attraction 不支撑 covered', async () => {
    // 敦煌 attraction「莫高窟」coords 来自 OSM（coordinate_source='osm'），且其唯一情报也是 OSM 派生
    const intel: IntelItem[] = [
      intelItem('xn:ta', '塔尔寺', 'attraction'),
      intelItem('xn:hotel', '西宁青旅', 'lodging'),
      intelItem('dh:mogao', '莫高窟', 'attraction', { platform: 'osm' }),
      intelItem('dh:hotel', '敦煌酒店', 'lodging'),
    ]
    const candidates: ResolveCandidate[] = [
      candidate('xn:ta', '塔尔寺', 'attraction', '西宁', { intelRefs: ['xn:ta'] }),
      candidate('xn:hotel', '西宁青旅', 'lodging', '西宁', { intelRefs: ['xn:hotel'] }),
      candidate('dh:mogao', '莫高窟', 'attraction', '敦煌', { intelRefs: ['dh:mogao'] }),
      candidate('dh:hotel', '敦煌酒店', 'lodging', '敦煌', { intelRefs: ['dh:hotel'] }),
    ]
    const places: ResolvedPlace[] = [
      place('xn:ta', '塔尔寺', 'attraction', { coords: coords(101.8, 36.5) }),
      place('xn:hotel', '西宁青旅', 'lodging', { coords: coords(101.9, 36.6) }),
      place('dh:mogao', '莫高窟', 'attraction', { coords: coords(94.8, 40.0), coordinate_source: 'osm' }),
      place('dh:hotel', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) }),
    ]
    const planId = await makePlanWithPlaces({
      intel, candidates, places,
      selectedSequence: candidates.map((c) => c.candidateId),
    })
    const out = await runRouteCoverage({ planId }, store)
    const dunhuang = out.regions.find((r) => r.name === '敦煌')
    // OSM 单源互证不足 → 不 covered，partial + unresolved_geo
    expect(dunhuang!.status).not.toBe('covered')
    expect(dunhuang!.status).toBe('partial')
    expect(dunhuang!.reasonCodes).toContain('unresolved_geo')
    // coordsCount 仍如实统计可信坐标数（保留 coordinate_source，不因互证不足抹掉计数）
    expect(dunhuang!.coordsCount).toBe(2)

    // 对照组：西宁独立互证（tencent coords + tencent intel）→ covered
    const xining = out.regions.find((r) => r.name === '西宁')
    expect(xining!.status).toBe('covered')
  })

  it('coverage 不反向触发 intel/places：仅读不写，版本不推进', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({
      intel, candidates, places, selectedSequence,
      intelVersion: 4, placesVersion: 7,
    })
    await runRouteCoverage({ planId }, store)
    const versions = await store.loadVersions(planId)
    expect(versions.intel).toBe(4)
    expect(versions.places).toBe(7)
    // intel/places 工件未被改写
    const intelNow = await store.readJson<IntelItem[]>(planId, 'intel.json')
    const placesNow = await store.readJson<PlacesArtifact>(planId, 'places.json')
    expect(intelNow).toEqual(intel)
    expect(placesNow?.inputFingerprint).toBe('fp-places')
  })
})

describe('computeRouteCoverageStale / 工件发布', () => {
  it('发布 route-coverage.json 且 versions/fingerprint 一致；读取状态 current', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({ intel, candidates, places, selectedSequence })
    const out = await runRouteCoverage({ planId }, store)
    expect(out.status).toBe('ready')
    expect(out.intelVersion).toBe(1)
    expect(out.placesVersion).toBe(1)
    expect(out.inputFingerprint).toMatch(/^[0-9a-f]{24}$/)

    const file = await store.readJson<import('../src/models/types.js').RouteCoverageArtifact>(planId, 'route-coverage.json')
    expect(file).toBeDefined()
    expect(file!.schemaVersion).toBe(1)
    expect(file!.intelVersion).toBe(1)
    expect(file!.placesVersion).toBe(1)
    expect(file!.regions.length).toBeGreaterThanOrEqual(2)

    const state = await store.readArtifactWithState(planId, 'route-coverage.json')
    expect(state.status).toBe('current')
  })

  it('stale：已发布的旧 route-coverage 版本落后于当前 places → computeRouteCoverageStale=true', async () => {
    const { intel, candidates, places, selectedSequence } = qingganFixture()
    const planId = await makePlanWithPlaces({
      intel, candidates, places, selectedSequence,
      intelVersion: 1, placesVersion: 1,
    })
    await runRouteCoverage({ planId }, store)
    expect(await computeRouteCoverageStale(store, planId)).toBe(false)

    // 下游推进 places（新解析）→ 旧 coverage 变 stale
    await store.bumpVersion(planId, 'places')
    expect(await computeRouteCoverageStale(store, planId)).toBe(true)
    // intel 推进同样使 stale
    await store.bumpVersion(planId, 'intel')
    expect(await computeRouteCoverageStale(store, planId)).toBe(true)
  })

  it('unknown 未入账 route-coverage 保持 unknown，computeRouteCoverageStale=false', async () => {
    const result = await runIntake({
      slots: { destination: '西宁', dateStart: '2026-09-01', dateEnd: '2026-09-10', days: 10 },
    }, store)
    const artifact = {
      schemaVersion: 1,
      intelVersion: 0,
      placesVersion: 0,
      inputFingerprint: 'unknown-coverage',
      generatedAt: '2026-09-02T00:00:00.000Z',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
    }
    await store.writeJson(result.planId, 'route-coverage.json', artifact)
    await store.publishArtifacts(result.planId, {
      stage: 'research-state',
      files: [{ name: 'research-state.json', data: { researchVersion: 0 } }],
      bump: [],
    })
    const state = await store.readArtifactWithState(result.planId, 'route-coverage.json')
    expect(state.status).toBe('unknown')
    expect(await computeRouteCoverageStale(store, result.planId)).toBe(false)
  })

  it('无 route-coverage 工件 → computeRouteCoverageStale=false（缺失非 stale）', async () => {
    const result = await runIntake({
      slots: { destination: '西宁', dateStart: '2026-09-01', dateEnd: '2026-09-10', days: 10 },
    }, store)
    expect(await computeRouteCoverageStale(store, result.planId)).toBe(false)
  })
})
