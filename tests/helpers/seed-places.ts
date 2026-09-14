/**
 * 测试共享：为计划装配最小可用 places.json（ready 全链门通过件）。
 *
 * F1c-E（决策 5）后，destination-only 新 plan（confirmed）同样写 flowVersion='1'
 * 受串行门约束——build（R-2）/transport（T11）/advice（C4）等下游在无 places 时
 * 结构化 blocked 且零网络。测试若验证的是「门之后的工具逻辑」而非门本身，须先
 * 装配 ready 的 places（真实链 = travel_resolve_places 的产物），门才放行。
 *
 * 说明：readArtifactWithState 在无 artifact-meta 时把存在文件判为 current（legacy
 * 兼容），故本 helper 只写 places.json + versions.json（版本账本供 currentVersion）。
 */
import type { TravelStore } from '../../src/store/store.js'
import type { PlacesArtifact, ResolvedPlace } from '../../src/models/types.js'

export interface SeedPlacesOptions {
  /** 目的地（生成 entry 地点用；缺省 '武汉'）。 */
  destination?: string
  /** 出发地（originResolution.origin；缺省 '北京'）。 */
  origin?: string
  /** 入口 kind（areaCenter → city 语义；缺省 area）。 */
  kind?: ResolvedPlace['kind']
  /** intel 证据版本（places.intelVersion；缺省 0——无研究状态时门里 currentIntelVersion=0）。 */
  intelVersion?: number
  /** 是否解析入口坐标（缺省 true；false → 无坐标仍算 resolved）。 */
  withCoords?: boolean
}

/** 装配 ready places（零网络、纯落盘；门放行用）。 */
export async function seedPlaces(store: TravelStore, planId: string, opts: SeedPlacesOptions = {}): Promise<void> {
  const destination = opts.destination ?? '武汉'
  const origin = opts.origin ?? '北京'
  const entry: ResolvedPlace = {
    placeId: 'place-entry',
    candidateId: 'entry',
    name: destination,
    kind: opts.kind ?? 'area',
    pointKind: 'areaCenter',
    ...(opts.withCoords !== false ? { coords: { lng: 114.3, lat: 30.5, sys: 'GCJ02' as const } } : {}),
    source: 'amap',
    coordinate_source: 'amap',
    resolveConfidence: 'high',
  }
  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: opts.intelVersion ?? 0,
    inputFingerprint: 'fp-seed-places',
    generatedAt: '2026-09-02T00:00:00.000Z',
    candidates: [{ candidateId: 'entry', name: destination, kind: opts.kind ?? 'area' }],
    places: [entry],
    selectedSequence: ['entry'],
    entryPlaceId: 'place-entry',
    originResolution: { origin, resolved: true, entryKind: 'city' },
    pendingClarifications: [],
    status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  await store.writeJson(planId, 'versions.json', { places: 1 })
}