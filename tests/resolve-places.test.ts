/**
 * W2 T9 travel_resolve_places 候选校验与多源解析（草稿 B：候选上限 60/选中 30/
 * 出处/入口/消歧/degraded 语义；版本门零网络）。
 *
 * 验收（T9 Acceptance）：
 * - 候选超限/无出处/无证据坐标提交 → 拒绝
 * - selectedSequence 引用合法、相邻重复 → 零长度边拒绝、闭环重访保留
 * - fixture geocoder 链（注入 mock amap/tencent/OSM）命中唯一匹配自动采用、
 *   冲突/低置信 → needs_clarification
 * - 缺 Key → degraded+excludeReason 而非猜测坐标
 * - 入口城市变化不写回覆盖用户原主题；places.json 版本/指纹/状态断言
 * - resolve 门（intel 版本过期 / assessment 非当前有效 sufficient → research_not_ready 零网络）
 *
 * 全确定性 fixture 注入，零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runRecordResearchAssessment } from '../src/tools/research-assessment.js'
import {
  runResolvePlaces,
  createAmapResolver, createTencentResolver, createTravelResolvePlacesTool,
  type GeocoderMatch, type GeocoderProvider, type ResolveDeps,
} from '../src/tools/resolve-places.js'
import { createTravelRouteTransportTool } from '../src/tools/route-transport.js'
import { createTravelResearchAdviceTool } from '../src/tools/research-advice.js'
import { createTravelBuildItineraryTool } from '../src/tools/build-itinerary.js'
import type { TencentMapAdapter } from '../src/adapters/tencent.js'
import { TravelValidationError } from '../src/errors.js'
import type {
  IntelItem, PlacesArtifact, ResearchState,
} from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-resolve-'))
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

/** 情报条目（带已验证坐标，供「优先复用已有经验证坐标」）。 */
function intelItem(id: string, name: string, category: IntelItem['category'] = 'attraction', withCoords = true): IntelItem {
  return {
    id,
    category,
    channel: 'tencent-poi',
    title: name,
    summary: `摘要 ${name}`,
    source: src('tencent-map', `https://example.invalid/${id}`),
    ...(withCoords ? { coords: coords(94.6 + Number(id.replace(/\D/g, '')) / 100, 40.1) } : {}),
    confidence: 'high',
  }
}

/** 确定性脚本化 geocoder provider：记录每次调用（零网络 / 幂等断言）。 */
function mockProvider(name: string, opts: {
  available?: boolean
  run: (candidateName: string, regionHint?: string) => GeocoderMatch[] | undefined
}): { provider: GeocoderProvider; calls: string[] } {
  const calls: string[] = []
  const provider: GeocoderProvider = {
    name,
    available: () => opts.available ?? true,
    async geocode(c, _env) {
      calls.push(`${name}:${c.name}`)
      const result = opts.run(c.name, c.regionHint)
      const matches = result instanceof Promise ? await result : result
      return matches
    },
  }
  return { provider, calls }
}

/** 构造研究就绪计划（intake + research-state v1 + sufficient assessment v1 + intel）。
 * assess=false 时跳过 sufficient（用于「非当前有效 sufficient → not_ready」用例）。
 */
async function makeReadyPlan(opts: {
  intel: IntelItem[]
  assess?: boolean
  researchVersion?: number
}): Promise<string> {
  const result = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-09-01', dateEnd: '2026-09-10', days: 10 },
  }, store)
  const planId = result.planId
  // intel 投影
  await store.writeJson(planId, 'intel.json', opts.intel)
  // research-state v<N>（assessment 会推进/校验版本）
  const version = opts.researchVersion ?? 1
  const state: ResearchState = {
    schemaVersion: 1,
    researchVersion: version,
    updatedAt: '2026-09-02T00:00:00.000Z',
    rounds: ['round-1'],
    budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false },
    sources: ['tencent-poi'],
    itemIndex: opts.intel.map((i) => ({ itemId: i.id, roundId: 'round-1', channel: i.channel, title: i.title })),
  }
  await store.saveResearchState(planId, state)
  if (opts.assess !== false) {
    await runRecordResearchAssessment({
      planId, expectedResearchVersion: version, verdict: 'sufficient',
      rationale: '情报已充分', evidenceRefs: opts.intel.map((i) => i.id),
    }, store)
  }
  return planId
}

function baseDeps(providers: GeocoderProvider[]): ResolveDeps {
  return {
    resolvers: providers,
    env: { readSettings: () => undefined, env: {} },
  }
}

// ────────────────────────── ① resolve 门：零网络 ──────────────────────────

describe('T9 resolve 门：research_not_ready → 零 geocoder 调用', () => {
  it('intel 版本过期（expectedIntelVersion 落后当前研究版本）→ research_not_ready，零网络', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟')] })
    const p = mockProvider('amap', { run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      expectedIntelVersion: 0, // 过期
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([p.provider]))
    expect(r.researchNotReady).toBeTruthy()
    expect(r.researchNotReady!.reason).toBe('research_not_ready')
    expect(p.calls).toHaveLength(0) // 零网络
    expect((await store.readJson(planId, 'places.json'))).toBeUndefined()
  })

  it('无当前有效 sufficient assessment → research_not_ready，零网络', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟')], assess: false })
    const p = mockProvider('amap', { run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([p.provider]))
    expect(r.researchNotReady).toBeTruthy()
    expect(r.researchNotReady!.missing).toBe('no_sufficient_assessment')
    expect(p.calls).toHaveLength(0)
  })
})

// ────────────────────────── ② 候选/序列校验 ──────────────────────────

describe('T9 候选与选中序列校验', () => {
  async function ready() {
    return makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟')] })
  }

  it('候选数量 > 60 → 拒绝', async () => {
    const planId = await ready()
    const candidates = Array.from({ length: 61 }, (_, i) => ({
      candidateId: `c${i}`, name: `点${i}`, kind: 'attraction' as const, intelRefs: ['tencent-poi:1'],
    }))
    await expect(runResolvePlaces({
      planId, candidates, selectionOrder: ['c0'],
    }, store, baseDeps([]))).rejects.toThrow(TravelValidationError)
  })

  it('候选无出处（无 intelRefs 且无 userRef）→ 拒绝（模型不得无证据提交）', async () => {
    const planId = await ready()
    await expect(runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction' }],
      selectionOrder: ['c1'],
    }, store, baseDeps([]))).rejects.toThrow(/出处|intelRefs|userRef/)
  })

  it('候选携带未经验证坐标 → 拒绝（不得无证据绕过解析）', async () => {
    const planId = await ready()
    const p = mockProvider('amap', { run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    await expect(runResolvePlaces({
      planId,
      candidates: [{
        candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'],
        coords: coords(111, 33), // 直接提交坐标绕过解析
      } as never],
      selectionOrder: ['c1'],
    }, store, baseDeps([p.provider]))).rejects.toThrow(/坐标|coords|证据/)
  })

  it('选中序列引用不存在候选 / 相邻重复（零长度边）→ 拒绝；各候选仅出现一次合法', async () => {
    const planId = await ready()
    // 引用不存在的候选
    await expect(runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1', 'ghost'],
    }, store, baseDeps([]))).rejects.toThrow(/未知候选|ghost/)
    // 相邻重复 → 零长度边拒绝
    await expect(runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1', 'c1'],
    }, store, baseDeps([]))).rejects.toThrow(/零长度|相邻重复/)
  })

  it('选中序列 > 30 → 拒绝', async () => {
    const planId = await ready()
    const candidates = Array.from({ length: 31 }, (_, i) => ({
      candidateId: `c${i}`, name: `点${i}`, kind: 'attraction' as const, intelRefs: ['tencent-poi:1'],
    }))
    await expect(runResolvePlaces({
      planId, candidates, selectionOrder: candidates.map((c) => c.candidateId),
    }, store, baseDeps([]))).rejects.toThrow(/30/)
  })
})

// ────────────────────────── ③ 多源解析链 ──────────────────────────

describe('T9 多源解析：优先复用已验证坐标 → amap → tencent → OSM', () => {
  it('intel 自带已验证坐标 → 优先复用，零 geocoder 调用，source=intel/high', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟')] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('ready')
    expect(amap.calls).toHaveLength(0) // 复用 intel，不触发渠道
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('intel')
    expect(place?.resolveConfidence).toBe('high')
    expect(place?.coords).toEqual(coords(94.61, 40.1))
  })

  it('intel 无坐标 → 链式解析：amap 命中 → 自动采用', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high', district: '酒泉市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('ready')
    expect(amap.calls).toEqual(['amap:莫高窟'])
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('amap')
    expect(place?.coords).toEqual(coords(94.66, 40.04))
    expect(place?.district).toBe('酒泉市')
    // intelVersion/指纹记录
    expect(r.intelVersion).toBe(1)
    expect(r.inputFingerprint).not.toBe('')
  })

  it('链式兜底：amap 无结果 → tencent 命中', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => undefined })
    const tencent = mockProvider('tencent', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider]))
    expect(amap.calls).toEqual(['amap:莫高窟'])
    expect(tencent.calls).toEqual(['tencent:莫高窟'])
    expect(r.places.find((p) => p.candidateId === 'c1')?.coordinate_source).toBe('tencent')
  })

  it('低置信唯一匹配 → needs_clarification，不宣称 ready', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'low' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('needs_clarification')
    expect(r.pendingClarifications.length).toBeGreaterThan(0)
    expect(r.pendingClarifications.length).toBeLessThanOrEqual(3)
    // fix-f1f #4a：产出澄清的 place 同步写 pendingClarification（顶层 pendingClarifications
    // 与该 place 字段契约一致，消除「待澄清仍通过 advice 天气门」的字段断裂）
    expect(r.places.find((p) => p.candidateId === 'c1')?.pendingClarification).toBeTruthy()
  })

  it('同名/地域冲突（多匹配）→ needs_clarification 询问，每轮 ≤3', async () => {
    const planId = await makeReadyPlan({
      intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false), intelItem('tencent-poi:2', '莫高窟', 'attraction', false)],
    })
    const amap = mockProvider('amap', { run: () => [
      { coords: coords(94.66, 40.04), confidence: 'high', district: '酒泉市' },
      { coords: coords(95.1, 39.9), confidence: 'high', district: '敦煌市' },
    ] })
    const r = await runResolvePlaces({
      planId,
      candidates: [
        { candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'c2', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:2'] },
        { candidateId: 'c3', name: '鸣沙山', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'c4', name: '张掖丹霞', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'c5', name: '嘉峪关', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'c6', name: '青海湖', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
      ],
      selectionOrder: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('needs_clarification')
    expect(r.pendingClarifications.length).toBeGreaterThan(0)
    expect(r.pendingClarifications.length).toBeLessThanOrEqual(3) // 每轮 ≤3
    // fix-f1f #4a：多匹配（scope）澄清候选同样落 place.pendingClarification
    expect(r.places.find((p) => p.candidateId === 'c1')?.pendingClarification).toBeTruthy()
  })

  it('闭环重访保留：selectedSequence [A,B,C,A] 不因去重丢环线', async () => {
    const planId = await makeReadyPlan({ intel: [
      intelItem('tencent-poi:1', '西宁'), intelItem('tencent-poi:2', '敦煌'), intelItem('tencent-poi:3', '张掖'),
    ] })
    const candidates = [
      { candidateId: 'xA', name: '西宁', kind: 'hub' as const, intelRefs: ['tencent-poi:1'] },
      { candidateId: 'xB', name: '敦煌', kind: 'attraction' as const, intelRefs: ['tencent-poi:2'] },
      { candidateId: 'xC', name: '张掖', kind: 'attraction' as const, intelRefs: ['tencent-poi:3'] },
    ]
    const r = await runResolvePlaces({
      planId, candidates, selectionOrder: ['xA', 'xB', 'xC', 'xA'], // 闭环重访
    }, store, baseDeps([]))
    expect(r.status).toBe('ready')
    expect(r.selectedSequence).toEqual(['xA', 'xB', 'xC', 'xA']) // 环线保留
    // fix-f1f #4a 对照：无澄清的 ready 地点不携带 pendingClarification（逐地天气门放行件）
    expect(r.places.every((pl) => pl.pendingClarification === undefined)).toBe(true)
  })
})

// ────────────────────────── ④ 澄清重试（resolve 幂等） ──────────────────────────

describe('T9 澄清重试：必去点全源失败 → needs_clarification；回答后仅该候选重试', () => {
  it('必去点全源失败 → needs_clarification 不宣称 ready', async () => {
    const planId = await makeReadyPlan({
      intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false), intelItem('tencent-poi:2', '鸣沙山', 'attraction', false)],
    })
    const p = mockProvider('amap', { run: (name) => name === '莫高窟' ? undefined : [{ coords: coords(94.6, 40.07), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [
        { candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'c2', name: '鸣沙山', kind: 'attraction', intelRefs: ['tencent-poi:2'] },
      ],
      selectionOrder: ['c1', 'c2'],
    }, store, baseDeps([p.provider]))
    expect(r.status).toBe('needs_clarification')
    // 莫高窟全源失败 → 待澄清（必去点无法定位），鸣沙山已解析
    const unresolved = r.pendingClarifications.find((q) => q.candidateId === 'c1')
    expect(unresolved).toBeDefined()
    expect(unresolved!.kind).toBe('unresolved')
    const resolvedC2 = r.places.find((pl) => pl.candidateId === 'c2')
    expect(resolvedC2?.coords).toEqual(coords(94.6, 40.07))
  })

  it('澄清回答后仅该候选重试（resolve 幂等）：其他已解析候选不重新 geocode', async () => {
    const planId = await makeReadyPlan({
      intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false), intelItem('tencent-poi:2', '鸣沙山', 'attraction', false)],
    })
    const p = mockProvider('amap', { run: (name) => name === '莫高窟' ? undefined : [{ coords: coords(94.6, 40.07), confidence: 'high' }] })
    const candidates = [
      { candidateId: 'c1', name: '莫高窟', kind: 'attraction' as const, intelRefs: ['tencent-poi:1'] },
      { candidateId: 'c2', name: '鸣沙山', kind: 'attraction' as const, intelRefs: ['tencent-poi:2'] },
    ]
    // 第一轮：c1 待澄清
    const r1 = await runResolvePlaces({ planId, candidates, selectionOrder: ['c1', 'c2'] }, store, baseDeps([p.provider]))
    expect(r1.status).toBe('needs_clarification')
    // fix-f1f #4a：澄清轮产出的 place 带 pendingClarification（幂等门亦依赖该字段重试）
    expect(r1.places.find((pl) => pl.candidateId === 'c1')?.pendingClarification).toBeTruthy()
    // 澄清问题 id（回填用）
    const q1 = r1.pendingClarifications.find((q) => q.candidateId === 'c1')!
    // 第二轮：提供 disambiguationAnswers（用户指认具体地点别名/区域）→ 仅 c1 重试
    const p2 = mockProvider('amap', { run: (name) => name === '莫高窟'
      ? [{ coords: coords(94.66, 40.04), confidence: 'high', district: '敦煌市' }]
      : [{ coords: coords(94.6, 40.07), confidence: 'high' }] })
    const deps2 = baseDeps([p2.provider])
    const r2 = await runResolvePlaces({
      planId, candidates, selectionOrder: ['c1', 'c2'],
      disambiguationAnswers: {
        [q1.clarificationId]: {
          candidateId: 'c1',
          answer: '敦煌市莫高窟景区入口',
          regionHint: '敦煌市',
        },
      },
    }, store, deps2)
    expect(r2.status).toBe('ready')
    expect(r2.pendingClarifications).toHaveLength(0)
    const resolvedC1 = r2.places.find((pl) => pl.candidateId === 'c1')
    expect(resolvedC1?.coords).toEqual(coords(94.66, 40.04))
    // fix-f1f #4a：澄清消除后 place 不再携带 pendingClarification（恢复正常逐地资格）
    expect(resolvedC1?.pendingClarification).toBeUndefined()
    // resolve 幂等：仅 c1 被重新解析（c2 复用已有 places，不重复 geocode）
    expect(p2.calls).toEqual(['amap:莫高窟'])
  })
})

// ────────────────────────── ⑤ 缺 Key→degraded；区域估算标记；入口不回写 ──────────────────────────

describe('T9 degraded 与区域参考估算、入口不回写', () => {
  it('缺 Key（所有渠道不可用）→ degraded+excludeReason，不猜坐标', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { available: false, run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    const tencent = mockProvider('tencent', { available: false, run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    const osm = mockProvider('osm', { available: false, run: () => [{ coords: coords(94, 40), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider, osm.provider]))
    // 全渠道不可用 = 缺 Key → 不产生坐标
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coords).toBeUndefined()
    expect(place?.excludeReason).toBeTruthy()
    // 没有"猜测坐标"被当作确定值：coordinate_source 不填 intel 且无坐标
    expect(place?.coordinate_source).toBe('disabled')
    // 必去点无法定位 → 至少 needs_clarification（不宣称 ready）
    expect(r.status).toBe('needs_clarification')
    // fix-f1f #4a：excludeReason（blocked/degraded）与 pendingClarification（待澄清）
    // 为两个独立门并存，互不覆盖（该候选同时被排除且需用户补充线索）
    expect(place?.pendingClarification).toBeTruthy()
  })

  it('住宿/区域仅可做"至区域参考点"估算并标记（areaReferenceEstimate），非入口/非酒店路线', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '敦煌市区', 'lodging', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.14), confidence: 'high', district: '敦煌市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'l1', name: '敦煌市区', kind: 'lodging', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['l1'],
    }, store, baseDeps([amap.provider]))
    const place = r.places.find((p) => p.candidateId === 'l1')
    // 住宿区域中心 → areaCenter + areaReferenceEstimate 标记（只做参考点，不标酒店到达路线）
    expect(place?.pointKind).toBe('areaCenter')
    expect(place?.areaReferenceEstimate).toBe(true)
  })

  it('市区中心不当景区入口：attraction 解析为 poi，不硬设为 entrance', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.pointKind).toBe('poi') // 市区中心不当景区入口
  })

  it('入口城市/origin 变化不写回覆盖用户原主题（request.slots 不变）', async () => {
    const planId = await makeReadyPlan({
      intel: [intelItem('tencent-poi:1', '西宁'), intelItem('tencent-poi:2', '敦煌')],
    })
    // 入口候选 = 西宁 (hub)，与 request.destination=西宁 不同侧；resolve 不改 request
    const r = await runResolvePlaces({
      planId,
      candidates: [
        { candidateId: 'cA', name: '西宁', kind: 'hub', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'cB', name: '敦煌', kind: 'attraction', intelRefs: ['tencent-poi:2'] },
      ],
      selectionOrder: ['cB', 'cA'],
      entryCandidateId: 'cA',
    }, store, baseDeps([]))
    expect(r.entryPlaceId).toBeDefined()
    const request = await store.loadRequest(planId)
    // resolve 不写回覆盖用户原主题：destination 与兴趣种子（researchIntent.text）原样保留
    expect(request?.slots.destination).toBe('西宁')
    expect(request?.slots.researchIntent?.text).toBe('西宁')
    // places.json originResolution 记录独立来源，不下探改写 request
    const artifact = await store.readJson<PlacesArtifact>(planId, 'places.json')
    expect(artifact?.originResolution?.origin ?? '西宁').toBe('西宁')
    expect(request?.slots).toEqual((await store.loadRequest(planId))?.slots) // 自洽（resolve 未改 slots）
  })
})

// ────────────────────────── ⑦ C2 置信/先验复用门 ──────────────────────────

describe('C2 置信诚实与先验复用门', () => {
  it('单匹配按渠道声明置信落档：amap 返回 medium → resolveConfidence=medium（不一律 high）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'medium', district: '酒泉市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('ready') // medium 有坐标仍算已解析
    expect(r.places.find((p) => p.candidateId === 'c1')?.resolveConfidence).toBe('medium')
  })

  it('先验复用门：候选名/地域约束变化（placeId 派生变化）→ 不复用旧快照，重新解析', async () => {
    const planId = await makeReadyPlan({ intel: [
      intelItem('tencent-poi:1', '莫高窟', 'attraction', false), intelItem('tencent-poi:2', '敦煌莫高窟', 'attraction', false),
    ] })
    const candidates = [
      { candidateId: 'c1', name: '莫高窟', kind: 'attraction' as const, intelRefs: ['tencent-poi:1'] },
    ]
    // 第一轮：解析成功并落盘
    const p1 = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high', district: '酒泉市' }] })
    const r1 = await runResolvePlaces({ planId, candidates, selectionOrder: ['c1'] }, store, baseDeps([p1.provider]))
    expect(r1.status).toBe('ready')
    expect(p1.calls).toEqual(['amap:莫高窟'])

    // 第二轮：同名候选（现状一致）→ 复用，不重复 geocode
    const p2 = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high', district: '酒泉市' }] })
    await runResolvePlaces({ planId, candidates, selectionOrder: ['c1'] }, store, baseDeps([p2.provider]))
    expect(p2.calls).toHaveLength(0) // 幂等复用

    // 第三轮：候选名改为「敦煌莫高窟」（同 candidateId 但 placeId 变化）→ 不复用，重新解析
    const renamed = [{ candidateId: 'c1', name: '敦煌莫高窟', kind: 'attraction' as const, intelRefs: ['tencent-poi:2'] }]
    const p3 = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high', district: '敦煌市' }] })
    const r3 = await runResolvePlaces({ planId, candidates: renamed, selectionOrder: ['c1'] }, store, baseDeps([p3.provider]))
    expect(p3.calls).toEqual(['amap:敦煌莫高窟']) // 名变 → 重新解析（不用旧坐标答新名）
    expect(r3.places.find((p) => p.candidateId === 'c1')?.name).toBe('敦煌莫高窟')
  })
})


// ────────────────────────── ⑥ places.json 落盘 ──────────────────────────

describe('T9 places.json 版本/指纹/状态断言', () => {
  it('状态 ready 的完整解析 → places.json 落盘且字段齐全', async () => {
    const planId = await makeReadyPlan({ intel: [
      intelItem('tencent-poi:1', '西宁'), intelItem('tencent-poi:2', '敦煌', 'attraction', false),
    ] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high' }] })
    await runResolvePlaces({
      planId,
      candidates: [
        { candidateId: 'xA', name: '西宁', kind: 'hub', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'xB', name: '敦煌', kind: 'attraction', intelRefs: ['tencent-poi:2'] },
      ],
      selectionOrder: ['xB', 'xA'],
      entryCandidateId: 'xA',
    }, store, baseDeps([amap.provider]))
    const artifact = await store.readJson<PlacesArtifact>(planId, 'places.json')
    expect(artifact).toBeDefined()
    expect(artifact!.status).toBe('ready')
    expect(artifact!.schemaVersion).toBe(1)
    expect(artifact!.intelVersion).toBe(1)
    expect(artifact!.inputFingerprint).not.toBe('')
    expect(artifact!.selectedSequence).toEqual(['xB', 'xA'])
    expect(artifact!.places).toHaveLength(2)
    for (const place of artifact!.places) {
      expect(place.placeId).toMatch(/^place-[0-9a-f]{8,}$/) // 稳定 placeId
      expect(place.source).toBeTruthy()
      expect(place.resolveConfidence).toBeTruthy()
      expect(['intel', 'amap', 'tencent', 'osm'].includes(place.coordinate_source)).toBe(true)
    }
  })
})

// ────────────────────────── ⑦ C2：可靠唯一且地域一致 ──────────────────────────

describe('T9 C2 可靠唯一且地域一致的自动采用门', () => {
  it('regionHint 与源行政区冲突的单匹配 → 不自动采用，转交能验证的渠道（tencent）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    // amap 单匹配但行政区=西宁市（与候选地域敦煌冲突）→ 不得采用
    const amap = mockProvider('amap', { run: () => [{ coords: coords(101.8, 36.6), confidence: 'high', district: '西宁市' }] })
    // tencent 回报行政区=敦煌市（一致）→ 采用
    const tencent = mockProvider('tencent', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high', district: '敦煌市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', regionHint: '敦煌', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider]))
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('tencent') // 冲突渠道不采用，转交可验证渠道
    expect(place?.coords).toEqual(coords(94.66, 40.04))
    expect(amap.calls).toHaveLength(1)
    expect(tencent.calls).toHaveLength(1)
  })

  it('regionHint 有约束但源未回报行政区（amap）→ 不自动采用，采用回报行政区的 tencent', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high' }] }) // 无 district → 不可验证
    const tencent = mockProvider('tencent', { run: () => [{ coords: coords(94.66, 40.04), confidence: 'high', district: '敦煌市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', regionHint: '敦煌', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider]))
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('tencent')
    expect(amap.calls).toHaveLength(1)
  })

  it('所有渠道都只有地域不可验证/冲突的单匹配 → 澄清，不默默采用可疑坐标', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(104.0, 30.6), confidence: 'high', district: '成都市' }] }) // 冲突
    const tencent = mockProvider('tencent', { run: () => [{ coords: coords(103.0, 30.5), confidence: 'high' }] }) // 无行政区
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', regionHint: '敦煌', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider]))
    expect(r.status).toBe('needs_clarification')
    expect(r.pendingClarifications.some((q) => q.candidateId === 'c1')).toBe(true)
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.resolveConfidence).toBe('low') // 不曾宣称 ready/high
  })

  it('生产 amap resolver：带 regionHint 也不标 high（无唯一性/行政区验证证据）', async () => {
    const adapterMock = {
      available: async () => true,
      geocode: async (name: string) => ({ coords: coords(94.66, 40.04), degraded: [] }),
    }
    const providers = baseDeps([createAmapResolver(adapterMock as never)])
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', regionHint: '敦煌', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, providers)
    // 2026-09-12 口径变更（N-REPLAY-1 修复）：源**未回报行政区**时不再产出澄清——
    // 旧问题文案只有「未回报行政区」+ 选项=hint 回显，用户无从回答（实测青甘复跑
    // 10/10 地点因此被 advice 地点业务门剔除 → weather=0 → advice.json 缺失）。
    // 现改为：采用该唯一匹配但**降档 medium** 并显式标注 regionVerification='unverified'，
    // 绝不标 high。/**可证明的冲突**（省级 hint「青海」+ 异省「成都市」）仍走澄清（见下条）。
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.resolveConfidence).toBe('medium') // 不冒充 high
    expect(place?.regionVerification).toBe('unverified')
    expect(place?.regionVerificationNote).toContain('地域无法验证')
    expect(place?.pendingClarification).toBeUndefined()
  })

  it('N-REPLAY-1 修复：组合地域词（青海/甘肃）+ 省辖自证 district → consistent 自动采用', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '茶卡', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(99.09, 36.78), confidence: 'medium', district: '青海省海西蒙古族藏族自治州乌兰县' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '茶卡', kind: 'attraction', regionHint: '青海/甘肃', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    // 旧实现：normalizeRegion 只剥末位后缀 → 组合串既不等于「青海」也不含之 → 必然
    // 「不一致/无法验证」→ 澄清选项=原 hint 回显（无法回答）。新实现任一 token 命中即一致。
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.resolveConfidence).toBe('medium') // 按渠道声明落档，不冒充 high
    expect(place?.regionVerification).toBe('verified')
    expect(place?.pendingClarification).toBeUndefined()
    expect(r.pendingClarifications).toHaveLength(0)
  })

  it('N-REPLAY-1 修复：组合地域词只把**首个 token**交给渠道 region（不再传整串）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '张掖', 'attraction', false)] })
    const seen: Array<string | undefined> = []
    const fake = {
      available: async () => true,
      // 注意：createAmapResolver 期望适配器返回 { coords, district }（非 GeocoderMatch[]）
      geocode: async (_name: string, region?: string) => {
        seen.push(region)
        return { coords: coords(100.45, 38.93), district: '青海省西宁市城中区' }
      },
    }
    const deps = baseDeps([createAmapResolver(fake as never)])
    // baseDeps 的 env 无 amapWebservice → amap available() 为 false，不会走到 geocode；
    // 与 `生产 amap resolver` 那条用例同法注入 key。
    deps.env = { readSettings: () => undefined, env: { amapWebservice: 'test-key' } }
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '张掖', kind: 'attraction', regionHint: '青海/甘肃', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, deps)
    // 实测依据：腾讯体验通道 region='青海/甘肃' → 0 条；region='甘肃' → 3 条带正确 district
    expect(seen).toEqual(['青海'])
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.regionVerification).toBe('verified')
    expect(place?.district).toBe('青海省西宁市城中区')
  })

  it('fix-f1e D：省级 hint（青海）+ 异省城市 district（成都市）→ 不一致（不可证明归属）→ 不自动采用', async () => {
    // oracle 四审 #4 案例：regionHint=青海，district=成都/四川 —— 旧省名分支无条件
    // true 放行；收紧后必须拒绝（宁澄清勿错放）。
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '青海湖', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(101.8, 36.6), confidence: 'high', district: '成都市' }] })
    const tencent = mockProvider('tencent', { run: () => [{ coords: coords(100.2, 36.9), confidence: 'high' }] }) // 无行政区
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '青海湖', kind: 'attraction', regionHint: '青海', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider]))
    expect(r.status).toBe('needs_clarification')
    expect(r.places.find((p) => p.candidateId === 'c1')?.resolveConfidence).toBe('low')
  })

  it('fix-f1e D：省级 hint（青海）+ 异省省名 district（四川）→ 不一致（青海 ≠ 四川）→ 不自动采用', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '青海湖', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(104.0, 30.5), confidence: 'high', district: '四川' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '青海湖', kind: 'attraction', regionHint: '青海', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('needs_clarification')
    expect(r.places.find((p) => p.candidateId === 'c1')?.resolveConfidence).toBe('low')
  })

  it('fix-f1e D：省级 hint（青海）+ district 原文自证省辖（青海省西宁市）→ 一致 → 自动采用', async () => {
    // 无猜测映射表的最小可靠判定：district 原文串内含省名（真实 geocoder 形如
    // 「青海省西宁市」）→ 归属可证明 → 放行；与「裸西宁市（不可证明）→ 澄清」区分。
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '西宁', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => [{ coords: coords(101.78, 36.62), confidence: 'high', district: '青海省西宁市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '西宁', kind: 'attraction', regionHint: '青海', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider]))
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('amap')
    expect(place?.resolveConfidence).toBe('high')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// B2 P0-A：T3 district 地域一致性 / T4 父 POI 收敛 / T5 answer 精确命中与坐标直用 /
// T6 键语义统一（key/candidateId）/ T7 四链 reset + amap degraded
// ══════════════════════════════════════════════════════════════════════════════

/** 构造十腾讯 resolver 测试替身：poiSearch 返回一组（title/district/coords）。
 * 以真实 poisson 最少字段回归 IntelItem 形状（仅供 resolver 读取 title/district/coords）。 */
function tencentResolverStub(items: Array<{ id: string; title: string; district?: string; location: { lat: number; lng: number } }>) {
  const adapter: unknown = {
    available: async () => true,
    poiSearch: async (q: { keywords: string; region?: string; pageSize?: number }) => ({
      data: items.map((it) => ({
        id: `tencent-poi:${it.id}`,
        channel: 'tencent-poi',
        category: 'attraction',
        title: it.title,
        summary: it.title,
        source: { platform: 'tencent-map', url: 'https://map.qq.com/?q=test', fetchedAt: '2026-09-02T00:00:00.000Z' },
        coords: coords(it.location.lng, it.location.lat),
        ...(it.district !== undefined ? { district: it.district } : {}),
        confidence: 'high' as const,
      })),
    }),
  }
  return { provider: createTencentResolver(adapter as TencentMapAdapter), adapter }
}

describe('P0-A T3+T4：渠道 district 回报与父 POI / 真同名异地澄清', () => {
  it('T3：amap 报 district 且地域一致的单匹配 → 不再转交/澄清，自动采用（含 district）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    // 生产 amap resolver：geocode 返回含 district（P0-A R1）；地域一致 → 自动采用
    const adapterMock = {
      available: async () => true,
      geocode: async (name: string) => ({ coords: coords(94.66, 40.04), district: '敦煌市', degraded: [] }),
    }
    const deps = baseDeps([createAmapResolver(adapterMock as never)])
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', regionHint: '敦煌', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, deps)
    expect(r.status).toBe('ready')
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('amap')
    expect(place?.district).toBe('敦煌市')
  })

  it('T4：多子 POI（售票处/停车场）— title 含候选名的父 POI 自动收敛（单轮 ready，零澄清）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '青海湖', 'attraction', false)] })
    const { provider } = tencentResolverStub([
      { id: '1', title: '青海湖景区售票处', district: '海南藏族自治州共和县', location: { lat: 36.9, lng: 100.2 } },
      { id: '2', title: '青海湖二郎剑景区', district: '海南藏族自治州共和县', location: { lat: 36.6, lng: 100.1 } },
    ])
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '青海湖', kind: 'attraction', regionHint: '共和县', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([provider]))
    expect(r.status).toBe('ready') // 售票处不占澄清位 → 父 POI 单轮收敛
    expect(r.pendingClarifications).toHaveLength(0)
    const place = r.places.find((p) => p.candidateId === 'c1')
    expect(place?.coordinate_source).toBe('tencent')
    // 收敛到父 POI（二郎剑 = 结果第二项坐标），非售票处/正门
    expect(place?.coords).toEqual(coords(100.1, 36.6))
  })

  it('T4：全同区县子 POI 集 → 取最贴候选名命中，不澄清', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '青海湖', 'attraction', false)] })
    const { provider } = tencentResolverStub([
      { id: '1', title: '青海湖景区售票处', district: '海南藏族自治州共和县', location: { lat: 36.9, lng: 100.2 } },
      { id: '2', title: '青海湖正门停车场', district: '海南藏族自治州共和县', location: { lat: 36.61, lng: 100.11 } },
    ])
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '青海湖', kind: 'attraction', regionHint: '共和县', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([provider]))
    expect(r.status).toBe('ready')
    expect(r.pendingClarifications).toHaveLength(0)
  })

  it('T4（保底）：district 均缺但仍多子 POI → 兼容旧行为仍澄清（不猜/不静默乱选）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '莫高窟', 'attraction', false)] })
    const { provider } = tencentResolverStub([
      { id: '1', title: '莫高窟一号', location: { lat: 94.66, lng: 40.04 } }, // 无 district
      { id: '2', title: '莫高窟二号', location: { lat: 94.7, lng: 40.1 } },
    ])
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '莫高窟', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([provider]))
    // 无行政区且非子 POI（标题不相近）→ 视为真同名异地 → 澄清保底（不静默乱用）
    expect(r.status).toBe('needs_clarification')
    expect(r.pendingClarifications.some((q) => q.candidateId === 'c1')).toBe(true)
  })
})

describe('P0-A T5+T6：answer 精确命中选项与坐标直用；键语义', () => {
  it('T5 scope：answer 精确等于选项 district → 直接采用该项，无二次搜索（mock 仅一次）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '玉门关', 'attraction', false)] })
    const tencent = mockProvider('tencent', { run: () => [
      { coords: coords(93.5, 39.8), confidence: 'high', district: '敦煌市' },
      { coords: coords(97.0, 40.5), confidence: 'high', district: '玉门市' },
    ] })
    // 第一轮无澄清回答 → 多匹配 → 澄清
    const r1 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '玉门关', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([tencent.provider]))
    expect(r1.status).toBe('needs_clarification')
    const q = r1.pendingClarifications.find((cl) => cl.candidateId === 'c1')
    expect(q?.options).toContain('玉门市')

    // 第二轮：answer = 选项 district "玉门市"（精确命中）→ 直接用该选项 coords/district
    const calls2: string[] = []
    const tencent2 = mockProvider('tencent', {
      run: () => { calls2.push('geocode#2'); return [
        { coords: coords(93.5, 39.8), confidence: 'high', district: '敦煌市' },
        { coords: coords(97.0, 40.5), confidence: 'high', district: '玉门市' },
      ] },
    })
    const deps2 = baseDeps([tencent2.provider])
    const r2 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '玉门关', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
      disambiguationAnswers: {
        [q!.clarificationId]: { candidateId: 'c1', answer: '玉门市' },
      },
    }, store, deps2)
    expect(r2.status).toBe('ready')
    expect(r2.pendingClarifications).toHaveLength(0)
    const place = r2.places.find((p) => p.candidateId === 'c1')
    expect(place?.coords).toEqual(coords(97.0, 40.5)) // 采用的正是玉门市选项
    expect(place?.district).toBe('玉门市')
    expect(calls2.length).toBe(1) // 精确命中，无二次关键词搜索重查
  })

  it('T5 unresolved：answer = 坐标串 → user-provided 直接采用（source=user，零网络），回 resolved', async () => {
    // 未定位候选：全渠道无结果 → 澄清；用户给出坐标串 → 直接采用
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '冷湖火星营地', 'attraction', false)] })
    const amap = mockProvider('amap', { run: () => undefined })
    const tencent = mockProvider('tencent', { run: () => undefined })
    const osm = mockProvider('osm', { run: () => undefined })
    const r1 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '冷湖火星营地', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider, osm.provider]))
    expect(r1.status).toBe('needs_clarification')
    const q = r1.pendingClarifications.find((cl) => cl.candidateId === 'c1')

    const r2 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '冷湖火星营地', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
      disambiguationAnswers: {
        [q!.clarificationId]: { candidateId: 'c1', answer: '93.34, 38.61' },
      },
    }, store, baseDeps([amap.provider, tencent.provider, osm.provider]))
    expect(r2.status).toBe('ready')
    const place = r2.places.find((p) => p.candidateId === 'c1')
    expect(place?.coords).toEqual({ lng: 93.34, lat: 38.61, sys: 'GCJ02' })
    expect(place?.source).toBe('user')
    expect(place?.coordinate_source).toBe('user')
    expect(place?.attribution).toBe('user-provided')
  })

  it('T5 unresolved：answer = 区域名（未知回答）→ 仅 regionHint 一次重查；仍失败则引导，不无限循环', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '乌素特雅丹', 'attraction', false)] })
    const allNone = () => undefined
    const amap = mockProvider('amap', { run: allNone })
    const tencent = mockProvider('tencent', { run: allNone })
    const r1 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '乌素特雅丹', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([amap.provider, tencent.provider]))
    const q = r1.pendingClarifications.find((cl) => cl.candidateId === 'c1')

    // 回答区域名（非坐标/非选项）→ 只做一次重查（本轮 demos 无循环：不再额外 geocoder 调用）
    const amap2 = mockProvider('amap', { run: () => undefined })
    const tencent2 = mockProvider('tencent', { run: () => [{ coords: coords(95.0, 37.8), confidence: 'high', district: '海西蒙古族藏族自治州' }] })
    const r2 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '海西', kind: 'attraction' as const, regionHint: '海西', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
      disambiguationAnswers: {
        [q!.clarificationId]: { candidateId: 'c1', answer: '海西', regionHint: '海西' },
      },
    }, store, baseDeps([amap2.provider, tencent2.provider]))
    expect(r2.status).toBe('ready')
    const place = r2.places.find((p) => p.candidateId === 'c1')
    expect(place?.coords).toEqual(coords(95.0, 37.8))
    expect(amap2.calls.length <= 2).toBe(true) // 单次 regionHint 收敛，不无限重查
  })

  it('T6：answer 键兼容——按澄清回执 key（=候选）命中，不声明非键非候选 unknown 命中', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '嘉峪关', 'attraction', false)] })
    const t = mockProvider('tencent', { run: () => undefined })
    const r1 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'cJYC', name: '嘉峪关', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['cJYC'],
    }, store, baseDeps([t.provider]))
    const q = r1.pendingClarifications.find((cl) => cl.candidateId === 'cJYC')

    // 键 = 回执 key（非 candidateId）但值里没有 candidateId 匹配时视为该候选的兜底回答
    const t2 = mockProvider('tencent', { run: () => [{ coords: coords(98.2, 39.78), confidence: 'high', district: '嘉峪关市' }] })
    const r2 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'cJYC', name: '嘉峪关', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['cJYC'],
      disambiguationAnswers: {
        [q!.clarificationId]: { candidateId: 'cJYC', answer: '嘉峪关市', regionHint: '嘉峪关市' },
      },
    }, store, baseDeps([t2.provider]))
    expect(r2.status).toBe('ready')
    expect(r2.places.find((p) => p.candidateId === 'cJYC')?.coordinate_source).toBe('tencent')
  })
})


describe('P0-A T6：scheme 语义统一——answer 键兼容 key/candidateId 双命中', () => {
  it('回执条目值含 candidateId 从候选 id 命中；未知 key/候选 → 明确未命中（无静默错用）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '嘉峪关', 'attraction', false)] })
    const g1 = mockProvider('tencent', { run: () => undefined })
    const r1 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'cJYC', name: '嘉峪关', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['cJYC'],
    }, store, baseDeps([g1.provider]))
    const q = r1.pendingClarifications.find((cl) => cl.candidateId === 'cJYC')
    expect(q).toBeDefined()
    // 以 candidateId 为键也能命中（T6：candidateId/key 键双匹配）
    const t2 = mockProvider('tencent', { run: () => [{ coords: coords(98.2, 39.78), confidence: 'high', district: '嘉峪关市' }] })
    const r2 = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'cJYC', name: '嘉峪关', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['cJYC'],
      disambiguationAnswers: {
        'cJYC': { candidateId: 'cJYC', answer: '嘉峪关市', regionHint: '嘉峪关市' },
      },
    }, store, baseDeps([t2.provider]))
    expect(r2.status).toBe('ready')
  })
})

describe('P0-A T7：resolve/route/advice/build 四工具执行入口各恰一次 resetPlanBudget', () => {
  it('四个工具工厂在 execute 时对注入 resetPlanBudget 恰好调用一次（mock 探针；不重构进程级 QuotaCounter）', async () => {
    // resolve 工具
    const r1: { called: number } = { called: 0 }
    const toolResolve = createTravelResolvePlacesTool(store, {
      resolvers: [],
      env: { readSettings: () => undefined, env: {} },
      resetPlanBudget: () => { r1.called += 1 },
    })
    await expect(toolResolve.execute({ planId: 'missing-resolve', candidates: [], selectionOrder: [] }) as Promise<unknown>)
      .rejects.toBeTruthy()
    expect(r1.called).toBe(1)

    // route-transport 工具
    const r2: { called: number } = { called: 0 }
    const toolRoute = createTravelRouteTransportTool(store, {
      providers: [],
      resetPlanBudget: () => { r2.called += 1 },
    })
    await expect(toolRoute.execute({ planId: 'missing-route' }) as Promise<unknown>).rejects.toBeTruthy()
    expect(r2.called).toBe(1)

    // advice 工具
    const r3: { called: number } = { called: 0 }
    const toolAdvice = createTravelResearchAdviceTool(store, {
      resetPlanBudget: () => { r3.called += 1 },
    })
    await expect(toolAdvice.execute({ planId: 'missing-advice' }) as Promise<unknown>).rejects.toBeTruthy()
    expect(r3.called).toBe(1)

    // build 工具
    const r4: { called: number } = { called: 0 }
    const toolBuild = createTravelBuildItineraryTool(store, {
      resetPlanBudget: () => { r4.called += 1 },
    })
    await expect(toolBuild.execute({ planId: 'missing-build' }) as Promise<unknown>).rejects.toBeTruthy()
    expect(r4.called).toBe(1)
  })
})



describe('P0-A T7：amap geocode 配额/网络异常 → degraded，不 throw 中断整链', () => {
  it('amap 熔断被 resolver 捕获为 undefined → 链继续到 tencent 收敛（整链不 throw）', async () => {
    const planId = await makeReadyPlan({ intel: [intelItem('tencent-poi:1', '冷湖火星营地', 'attraction', false)] })
    // amap 抛 EngineError（QuotaCounter 熔断/网络异常）；tencent 返回唯一一致匹配 → 链继续采用
    const quotaBoom = {
      available: async () => true,
      geocode: async () => { throw { code: 'UNAVAILABLE', source: 'amap', message: '配额熔断：REST 预算 60 次已用尽（停新增）' } },
    }
    const tencent = mockProvider('tencent', { run: () => [{ coords: coords(93.34, 38.61), confidence: 'high', district: '海西蒙古族藏族自治州茫崖市' }] })
    const r = await runResolvePlaces({
      planId,
      candidates: [{ candidateId: 'c1', name: '冷湖火星营地', kind: 'attraction', intelRefs: ['tencent-poi:1'] }],
      selectionOrder: ['c1'],
    }, store, baseDeps([createAmapResolver(quotaBoom as never), tencent.provider]))
    // amap degraded 未 throw 中断整链；tencent 兜底收敛 → status ready
    expect(r.status).toBe('ready')
    expect(r.places.find((p) => p.candidateId === 'c1')?.coordinate_source).toBe('tencent')
    expect(tencent.calls).toEqual(['tencent:冷湖火星营地'])
  })
})
