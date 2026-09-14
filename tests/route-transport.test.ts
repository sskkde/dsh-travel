/**
 * W3 T12 路线各段 route-transport 旁车与逐段诚实降级（草稿 D）。
 *
 * 验收（T12 Acceptance）：
 * - 青甘相邻段 fixture 每段 queried/estimated/unavailable/blocked 与原因齐全
 * - 闭环重访段存在（fromPlaceId/toPlaceId 反转仍产 leg）
 * - 零长度边不产生（相邻重复同 placeId → 防御性跳过）
 * - mode 默认回显（无方式时默认 driving + 假设回显，不悄悄全部当自驾）
 * - 某段全源失败不影响他段（逐段独立成功/失败）
 * - 直线估算标 estimated 不冒充真实（原因含「直线估算」，非道路长度/时长/可达性证据）
 * - 缺枢纽坐标衔接标未知（hub 无坐标 → blocked + estimateReason 衔接未知）
 * - 缺 places/版本过期 → places_not_ready/places_stale 零网络
 *
 * 全确定性 fixture 注入（脚本化 provider），零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runRouteTransport } from '../src/tools/route-transport.js'
import { TravelValidationError } from '../src/errors.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'
import type { PlacesArtifact, ResolvedPlace, RouteTransportMode } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-route-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' as const }
}

function place(id: string, name: string, opts: {
  kind?: ResolvedPlace['kind']
  pointKind?: ResolvedPlace['pointKind']
  coords?: { lng: number; lat: number; sys: 'GCJ02' }
} = {}): ResolvedPlace {
  return {
    placeId: `place-${id}`,
    candidateId: id,
    name,
    kind: opts.kind ?? 'attraction',
    pointKind: opts.pointKind ?? 'poi',
    ...(opts.coords ? { coords: opts.coords } : {}),
    source: opts.coords ? 'amap' : 'unresolved',
    coordinate_source: opts.coords ? 'amap' : 'unresolved',
    resolveConfidence: opts.coords ? 'high' : 'low',
  }
}

async function makePlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      origin: '北京',
      destination: '青甘环线',
      dateStart: '2026-09-04',
      dateEnd: '2026-09-10',
      days: 7,
      researchIntent: { text: '青甘环线（西宁-敦煌-大柴旦）' },
      ...slots,
    },
  }, store)
  return result.planId
}

/** 装配 places.json（selectedSequence 可含手工相邻重复以测试零长度边防御）。 */
async function writePlaces(planId: string, opts: {
  places: ResolvedPlace[]
  selectedSequence: string[]
  placesVersion?: number
  stale?: boolean
}): Promise<void> {
  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: 1,
    inputFingerprint: 'fp-route',
    generatedAt: '2026-09-02T01:00:00.000Z',
    candidates: [],
    places: opts.places,
    selectedSequence: opts.selectedSequence,
    originResolution: { origin: '北京', resolved: true, coords: coords(101.8, 36.6), entryKind: 'city' },
    pendingClarifications: [],
    status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  await store.writeJson(planId, 'versions.json', { places: opts.placesVersion ?? 1 })
  if (opts.stale === true) {
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'places', inputFingerprint: 'fp-other', upstreamVersions: { intel: 1 },
      contentHash: {}, status: 'success', generatedAt: '2026-09-01T00:00:00.000Z',
    })
  }
}

// ────────────────────────── 脚本化 provider ──────────────────────────

interface ScriptedLeg { id: string }
interface MeasureInput { id: string; fromCoords: { lng: number; lat: number; sys: string }; toCoords: { lng: number; lat: number; sys: string } }

function haversine(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * 脚本化 provider：指定 legs 成功/失败（throw）/空。estimate 变体对失败 legs 抛错
 * （模拟 estimate 不可用），其余返回直线距离。
 * leg id 约定：leg-<orderIndex>-<fromCandidateId>-<toCandidateId>。 */
function scriptedProvider(name: string, modes: RouteTransportMode[], failIds: string[], emptyIds: string[], opts: { estimate?: boolean } = {}) {
  const measured = new Map<string, { id: string; distanceKm: number; durationMinutes: number }>()
  return {
    name,
    label: name,
    modes,
    availableCount: 0,
    measureCount: 0,
    async available() { this.availableCount += 1; return { ok: true } },
    async measure(inputs: MeasureInput[]) {
      this.measureCount += 1
      const out: Array<ScriptedLeg & { distanceKm: number; durationMinutes: number; note: string }> = []
      for (const seg of inputs) {
        if (failIds.includes(seg.id)) throw new Error(`${name} 模拟渠道失败`)
        if (emptyIds.includes(seg.id)) return []
        const distanceKm = opts.estimate === true
          ? haversine({ lng: seg.fromCoords.lng, lat: seg.fromCoords.lat }, { lng: seg.toCoords.lng, lat: seg.toCoords.lat })
          : 42 + seg.id.length
        measured.set(seg.id, { id: seg.id, distanceKm, durationMinutes: Math.round(distanceKm / 0.6) })
        out.push({ id: seg.id, distanceKm, durationMinutes: Math.round(distanceKm / 0.6), note: `${name} 测量` })
      }
      return out
    },
  }
}

const ENV: KeyResolutionEnv = { env: {} }

/** 默认 provider 链：amap-like(driving) → tencent-like(driving) → estimate-like(driving)。 */
function scriptedDeps() {
  const amap = scriptedProvider('amap-like', ['driving'], ['leg-2-xnta-dh', 'leg-5-dcd-mh'], [])
  const tencent = scriptedProvider('tencent-like', ['driving'], ['leg-5-dcd-mh', 'leg-2-xnta-dh'], [])
  const estimate = scriptedProvider('estimate', ['driving', 'walking', 'transit'], ['leg-5-dcd-mh'], [], { estimate: true })
  return { providers: [amap, tencent, estimate], amap, tencent, estimate }
}

// ────────────────────────── T12 逐段状态与诚实降级 ──────────────────────────

describe('T12 逐段 queried/estimated/unavailable/blocked 与原因', () => {
  it('青甘相邻段 fixture 全状态齐全：blocked(hub缺坐标)/queried/estimated/unavailable + 闭环重访段存在 + 零长度边不产生', async () => {
    const planId = await makePlan()
    const places = [
      place('hub', '西宁站', { kind: 'hub', pointKind: 'hub' }), // hub 无坐标
      place('dcd', '大柴旦翡翠湖', { coords: coords(95.3, 37.8) }),
      place('xnta', '塔尔寺', { coords: coords(101.8, 36.5) }),
      place('dh', '敦煌莫高窟', { coords: coords(94.8, 40.0) }),
      place('mh', '茫崖', { coords: coords(90.8, 38.2) }),
    ]
    // 闭环重访：dcd 出现两次（闭环 dcd→xnta→dh→xnta→dcd），dh→xnta 为 xnta→dh 的反转边
    const selectedSequence = ['hub', 'dcd', 'xnta', 'dh', 'xnta', 'dcd', 'mh']
    await writePlaces(planId, { places, selectedSequence })
    const s = scriptedDeps()
    const result = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })

    expect(result.status).toBe('ready')
    // 防御零长度边：相邻同 placeId 不产生 leg；hub 重复（末尾 hub 与前面 hub 非同相邻——此处相邻重复在 'hub','dcd' 无；legs 终态无 from==to）
    expect(result.legs.some((l) => l.fromPlaceId === l.toPlaceId)).toBe(false)

    const byOrder = new Map(result.legs.map((l) => [l.orderIndex, l]))
    // leg0: hub→dcd：hub 缺坐标 → blocked + 衔接未知
    expect(byOrder.get(0)!.status).toBe('blocked')
    expect(byOrder.get(0)!.estimateReason).toMatch(/枢纽|衔接未知/)
    // leg1: dcd→xnta → queried（amap-like）
    expect(byOrder.get(1)!.status).toBe('queried')
    expect(byOrder.get(1)!.provider).toBe('amap-like')
    // leg2: xnta→dh：amap-like/tencent-like 均失败 → estimated（直线估算）
    expect(byOrder.get(2)!.status).toBe('estimated')
    expect(byOrder.get(2)!.estimateReason).toMatch(/直线估算/)
    // leg3: dh→xnta（反转边，闭环重访）→ queried
    expect(byOrder.get(3)!.status).toBe('queried')
    expect(byOrder.get(3)!.fromPlaceId).toBe('place-dh')
    expect(byOrder.get(3)!.toPlaceId).toBe('place-xnta')
    // leg4: xnta→dcd → queried
    expect(byOrder.get(4)!.status).toBe('queried')
    // leg5: dcd→mh：全部渠道失败（含 estimate）→ unavailable + 原因
    expect(byOrder.get(5)!.status).toBe('unavailable')
    expect(byOrder.get(5)!.estimateReason).toMatch(/失败|不可用/)

    // 闭环重访段存在：同一对地点正反方向都产 leg
    const pairs = result.legs.map((l) => `${l.fromPlaceId}->${l.toPlaceId}`)
    expect(pairs).toContain('place-xnta->place-dh')
    expect(pairs).toContain('place-dh->place-xnta')

    // 某段全源失败不影响他段：unavailable 段存在，其他 queried 段依旧
    expect(result.legs.filter((l) => l.status === 'queried').length).toBe(3)
    expect(result.legs.filter((l) => l.status === 'blocked').length).toBe(1)
    // 每段含 id/orderIndex/placesVersion/observedAt
    for (const l of result.legs) {
      expect(l.id).toMatch(/^leg-/)
      expect(typeof l.orderIndex).toBe('number')
      expect(l.placesVersion).toBe(1)
      expect(l.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('零长度边防御：相邻重复 placeId 直接跳过且不报错', async () => {
    const planId = await makePlan()
    const places = [
      place('a', 'A地', { coords: coords(101.8, 36.5) }),
      place('b', 'B地', { coords: coords(94.8, 40.0) }),
    ]
    // 手工塞相邻重复（resolve 会拒，工具层防御）
    const selectedSequence = ['a', 'a', 'b', 'a']
    await writePlaces(planId, { places, selectedSequence })
    const s = scriptedDeps()
    const result = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })
    expect(result.legs.some((l) => l.fromPlaceId === l.toPlaceId)).toBe(false)
    // a→a 零长度边不产生；其余正常
    const pairs = result.legs.map((l) => `${l.fromPlaceId}->${l.toPlaceId}`)
    expect(pairs).not.toContain('place-a->place-a')
    expect(pairs).toContain('place-a->place-b')
  })

  it('mode 默认回显：无方式 → assumedMode driving + 原因（不悄悄全部当自驾）；显式方式 → 无假设', async () => {
    const planId = await makePlan()
    const places = [
      place('a', 'A地', { coords: coords(101.8, 36.5) }),
      place('b', 'B地', { coords: coords(94.8, 40.0) }),
    ]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'] })
    const s = scriptedDeps()
    const noMode = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })
    expect(noMode.assumedMode).toBeDefined()
    expect(noMode.assumedMode!.mode).toBe('driving')
    expect(noMode.assumedMode!.reason).toMatch(/默认|假设|回显/i)

    // 显式方式 → 无默认假设
    const explicit = await runRouteTransport({ planId, modes: ['driving'] }, store, { providers: s.providers, env: ENV })
    expect(explicit.assumedMode).toBeUndefined()
  })

  it('显式 walking 无真实渠道 → estimate 兜底标 estimated（不冒充真实步行路线）', async () => {
    const planId = await makePlan()
    const places = [
      place('a', 'A地', { coords: coords(101.8, 36.5) }),
      place('b', 'B地', { coords: coords(94.8, 40.0) }),
    ]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'] })
    const s = scriptedDeps()
    const result = await runRouteTransport({ planId, modes: ['walking'] }, store, { providers: s.providers, env: ENV })
    expect(result.assumedMode).toBeUndefined()
    const leg = result.legs[0]
    expect(leg.mode).toBe('walking')
    expect(leg.status).toBe('estimated')
    expect(leg.estimateReason).toMatch(/直线估算/)
  })

  it('直线估算不冒充真实：estimated 腿 distanceKm 仅几何、无 geometry 冒充、原因明确', async () => {
    const planId = await makePlan()
    const places = [
      place('a', 'A地', { coords: coords(101.8, 36.5) }),
      place('b', 'B地', { coords: coords(94.8, 40.0) }),
    ]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'] })
    const s = scriptedDeps()
    // 让 all real providers fail → estimate
    const failAll = scriptedProvider('fail-all', ['driving'], ['leg-0-a-b'], [])
    const est = scriptedProvider('estimate', ['driving'], [], [], { estimate: true })
    const result = await runRouteTransport({ planId }, store, { providers: [failAll, est], env: ENV })
    const leg = result.legs[0]
    expect(leg.status).toBe('estimated')
    expect(leg.estimateReason ?? '').not.toMatch(/^queried/)
    expect(leg.estimateReason).toMatch(/直线估算/)
    expect(leg.geometry).toBeUndefined() // 测距不冒充完整路线指引
  })

  it('缺 places / 版本过期 → places_not_ready / places_stale 零网络', async () => {
    const planId = await makePlan()
    const s = scriptedDeps()
    const notReady = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })
    expect(notReady.status).toBe('places_not_ready')
    expect(notReady.legs).toEqual([])
    expect(s.amap.measureCount).toBe(0)
    expect(s.estimate.measureCount).toBe(0)

    const places = [place('a', 'A地', { coords: coords(101.8, 36.5) }), place('b', 'B地', { coords: coords(94.8, 40.0) })]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'], placesVersion: 3, stale: true })
    const stale = await runRouteTransport({ planId, expectedPlacesVersion: 2 }, store, { providers: s.providers, env: ENV })
    expect(stale.status).toBe('places_stale')
    expect(stale.legs).toEqual([])
    expect(s.amap.measureCount).toBe(0)
  })

  it('计划不存在 → TravelValidationError', async () => {
    const s = scriptedDeps()
    await expect(runRouteTransport({ planId: 'plan-nope' }, store, { providers: s.providers, env: ENV }))
      .rejects.toThrow(TravelValidationError)
  })
})

// ────────────────────────── C3 门闭合：failed/empty/hash_mismatch 不复活 ──────────────────────────

describe('C3 places 工件非 ready 状态一律门拦截（零网络）', () => {
  it('places 上次发布 failed → places_not_ready，不把失败当成功消费', async () => {
    const planId = await makePlan()
    const places = [place('a', 'A地', { coords: coords(101.8, 36.5) }), place('b', 'B地', { coords: coords(94.8, 40.0) })]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'] })
    // 标记上次发布失败：artifact-meta.status=failed（readArtifactWithState → failed）
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'places', inputFingerprint: 'fp-route', upstreamVersions: { intel: 1 },
      contentHash: {}, status: 'failed', generatedAt: '2026-09-02T00:00:00.000Z',
    })
    const s = scriptedDeps()
    const result = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })
    expect(result.status).toBe('places_not_ready')
    expect(result.legs).toEqual([])
    expect(result.placesNotReady?.detail).toMatch(/失败/)
    expect(s.amap.measureCount).toBe(0) // 零网络
  })

  it('places 内容 hash 失配（hash_mismatch）→ places_stale，不复活旧数据', async () => {
    const planId = await makePlan()
    const places = [place('a', 'A地', { coords: coords(101.8, 36.5) }), place('b', 'B地', { coords: coords(94.8, 40.0) })]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'] })
    // contentHash 指向一个不存在的 hash → readArtifactWithState 判 hash_mismatch stale
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'places', inputFingerprint: 'fp-other', upstreamVersions: { intel: 1 },
      contentHash: { 'places.json': 'deadbeef' }, status: 'success', generatedAt: '2026-09-02T00:00:00.000Z',
    })
    const s = scriptedDeps()
    const result = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })
    expect(result.status).toBe('places_stale')
    expect(result.legs).toEqual([])
    expect(result.placesNotReady?.detail).toMatch(/hash 不符/)
    expect(s.amap.measureCount).toBe(0) // 零网络
  })

  it('places intelVersion 落后于当前研究版本（研究已前进但 places 未重发布）→ places_stale 零网络', async () => {
    const planId = await makePlan()
    // 研究已前进到 v3：research-state.researchVersion=3
    await store.saveResearchState(planId, {
      schemaVersion: 1,
      researchVersion: 3,
      updatedAt: '2026-09-02T00:00:00.000Z',
      rounds: ['round-3'],
      budget: { usedRounds: 3, maxRoundsPerPlan: 16, exhausted: false },
      sources: ['tencent-poi'],
      itemIndex: [],
    })
    // places 仍消费旧 intel（intelVersion=1）：文件 hash 未变、readArtifactWithState 判 current，
    // 但按研究版本它已过期——不得被当作最新消费
    const places = [place('a', 'A地', { coords: coords(101.8, 36.5) }), place('b', 'B地', { coords: coords(94.8, 40.0) })]
    await writePlaces(planId, { places, selectedSequence: ['a', 'b'] })
    const s = scriptedDeps()
    const result = await runRouteTransport({ planId }, store, { providers: s.providers, env: ENV })
    expect(result.status).toBe('places_stale')
    expect(result.legs).toEqual([])
    expect(result.placesNotReady?.reason).toBe('places_stale')
    expect(result.placesNotReady?.detail).toMatch(/研究版本/)
    expect(s.amap.measureCount).toBe(0) // 零网络
    expect(s.estimate.measureCount).toBe(0) // 零网络
  })
})
