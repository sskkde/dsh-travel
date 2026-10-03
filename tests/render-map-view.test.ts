/**
 * render-map-view 单测（地图优先 T2，tests-after）。
 *
 * 被测对象：src/render/page/map-view.ts（可见性/取景/呈现规则纯逻辑）+
 * src/render/page/runtime.ts 的 createState（纯状态构建；浏览器 DOM 初始化已用
 * typeof document 守卫，node 导入安全）。
 * 锁定规则（.omo/drafts/map-first-output.md T2）：
 * - 归属/颜色来自 route-view 投影（不再 DAY_COLOR(leg.orderIndex)）；跨日/未分配中性色，
 *   线型只由几何状态决定（跨日≠估算）；
 * - 总览=全部可信点/段；单日=当天点 + 当天绑定段；跨日/未分配进单独列表（separateLegIds）；
 * - fitVisibleBounds 的遮挡 padding 纯函数可断言；
 * - amap→leaflet 降级必须整体重建坐标（GCJ-02↔WGS-84），且视图状态（总览/单日/选择）保留；
 * - 无坐标内容时 hasMappableContent=false → 地图让位静态列表。
 */
import { describe, expect, it } from 'vitest'
import { canonicalRouteFromDays } from '../src/route-check.js'
import { createState } from '../src/render/page/runtime.js'
import {
  CROSS_DAY_COLOR,
  UNASSIGNED_COLOR,
  computeMapVisibility,
  computeOcclusionPadding,
  hasMappableContent,
  segmentPresentation,
} from '../src/render/page/map-view.js'
import type { RenderPageData } from '../src/render/render.js'
import type { ItineraryDay, ItineraryStop, RouteTransportLeg } from '../src/models/types.js'

const DAY_COLORS = ['#e74c3c', '#f39c12', '#27ae60', '#2980b9', '#8e44ad', '#d35400', '#16a085', '#7f8c8d']

// ── 夹具 ──

function stop(name: string, placeId: string, occurrenceId: string, lng: number, lat: number): ItineraryStop {
  return { name, placeId, occurrenceId, category: 'attraction', coords: { lng, lat, sys: 'GCJ02' }, intelRefs: [] }
}

function day(date: string, stops: ItineraryStop[]): ItineraryDay {
  return { date, stops, meals: [] }
}

function legLeg(orderIndex: number, from: string, to: string, overrides: Partial<RouteTransportLeg> = {}): RouteTransportLeg {
  return {
    id: `leg-${orderIndex}`,
    fromPlaceId: from,
    toPlaceId: to,
    orderIndex,
    placesVersion: 1,
    mode: 'driving',
    status: 'queried',
    metricStatus: 'queried',
    geometryStatus: 'queried',
    distanceKm: 12 + orderIndex,
    durationMinutes: 20 + orderIndex,
    observedAt: '2026-10-01T00:00:00.000Z',
    geometry: {
      type: 'LineString',
      coordinates: [[100 + orderIndex * 0.1, 30 + orderIndex * 0.1], [100.05 + orderIndex * 0.1, 30.05 + orderIndex * 0.1]],
      source: 'fixture',
      coordinateSystem: 'WGS84',
      pointOrder: 'lng,lat',
    },
    ...overrides,
  }
}

/** day0=A,B；day1=B,C（日界共享住宿点 B）。 */
function fixtureData(provider: 'amap' | 'leaflet'): RenderPageData {
  const days = [
    day('2026-10-01', [stop('甲', 'A', 'a0', 100.0, 30.0), stop('乙', 'B', 'b0', 100.2, 30.2)]),
    day('2026-10-02', [stop('乙', 'B', 'b1', 100.2, 30.2), stop('丙', 'C', 'c1', 100.4, 30.4)]),
  ]
  const canonical = canonicalRouteFromDays(days)
  return {
    renderedAt: '2026-10-01T00:00:00.000Z',
    request: {
      planId: 'map-view-test', mode: 'plan', status: 'delivered',
      slots: { destination: '测试', dateStart: '2026-10-01', dateEnd: '2026-10-02', days: 2 },
      assumptions: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    },
    itinerary: { itineraryId: 'it', days, routeCheck: { issues: [], warnings: [] }, canonicalRoute: canonical },
    intel: {},
    degraded: [],
    map: { provider, warnings: [] },
    routeTransport: { legs: [legLeg(0, 'A', 'B'), legLeg(1, 'B', 'C', { geometryStatus: 'estimated', status: 'estimated', metricStatus: 'estimated', estimateReason: '直线估算' })] },
  }
}

/** 无共享锚点：B→C 为跨日衔接。 */
function crossDayFixture(): RenderPageData {
  const days = [
    day('2026-10-01', [stop('甲', 'A', 'a0', 100.0, 30.0), stop('乙', 'B', 'b0', 100.2, 30.2)]),
    day('2026-10-02', [stop('丙', 'C', 'c1', 100.4, 30.4), stop('丁', 'D', 'd1', 100.6, 30.6)]),
  ]
  const canonical = canonicalRouteFromDays(days)
  const data = fixtureData('leaflet')
  data.itinerary = { itineraryId: 'it-cross', days, routeCheck: { issues: [], warnings: [] }, canonicalRoute: canonical }
  data.routeTransport = { legs: [legLeg(0, 'A', 'B'), legLeg(1, 'B', 'C'), legLeg(2, 'C', 'D')] }
  return data
}

// ── 归属与颜色 ──

describe('map-view：归属与呈现', () => {
  it('route-view 投影驱动颜色：日界共享锚点的 B→C 归 day1（不是跨日中性色）', () => {
    const state = createState(fixtureData('leaflet'), 'leaflet')
    expect(state.segments).toHaveLength(2)
    expect(state.segments[0]).toMatchObject({ kind: 'day', dayIndex: 0, color: DAY_COLORS[0] })
    expect(state.segments[1]).toMatchObject({ kind: 'day', dayIndex: 1, color: DAY_COLORS[1] })
    // B→C 是估算几何 → 虚线；A→B 实线。跨日与估算两个维度互不冒充。
    expect(state.segments[0].dashed).toBe(false)
    expect(state.segments[1].dashed).toBe(true)
  })

  it('无共享锚点的 B→C → cross-day 中性色；未分配 → 另一中性色', () => {
    const state = createState(crossDayFixture(), 'leaflet')
    expect(state.segments[1]).toMatchObject({ kind: 'cross-day', color: CROSS_DAY_COLOR })
    expect(state.segments[1].dayIndex).toBeUndefined()
    const unassigned = segmentPresentation('unassigned', undefined, false, (index) => DAY_COLORS[index])
    expect(unassigned.color).toBe(UNASSIGNED_COLOR)
  })

  it('线型只由几何状态决定：cross-day 真实几何=实线，不把跨日误当估算', () => {
    const solid = segmentPresentation('cross-day', undefined, false, (index) => DAY_COLORS[index])
    const dashed = segmentPresentation('cross-day', undefined, true, (index) => DAY_COLORS[index])
    expect(solid.dashed).toBe(false)
    expect(dashed.dashed).toBe(true)
  })

  it('相同输入两 provider 得到一致的归属（kind/dayIndex），仅坐标投影不同', () => {
    const amap = createState(fixtureData('amap'), 'amap')
    const leaflet = createState(fixtureData('leaflet'), 'leaflet')
    expect(amap.segments.map((segment) => [segment.kind, segment.dayIndex, segment.color]))
      .toEqual(leaflet.segments.map((segment) => [segment.kind, segment.dayIndex, segment.color]))
    // GCJ-02（amap 显示位）与 WGS-84（Leaflet 显示位）必须不同——降级时整体重建坐标。
    const amapPoint = amap.stops[0].point!
    const leafPoint = leaflet.stops[0].point!
    expect(Math.abs(amapPoint.lng - leafPoint.lng)).toBeGreaterThan(0.001)
  })
})

// ── 可见性 ──

describe('map-view：总览/单日可见性', () => {
  const data = fixtureData('leaflet')
  const state = createState(data, 'leaflet')
  const markerDays = state.stops.filter((stopModel) => stopModel.point !== undefined)
    .map((stopModel) => ({ key: stopModel.key, dayIndex: stopModel.dayIndex }))
  const legs = state.routeView.legs.map((item) => ({ id: item.legId, kind: item.kind, dayIndex: item.dayIndex }))

  it('总览：全部点与段可见，无单独列表', () => {
    const visibility = computeMapVisibility({ markerDays, legs, viewMode: 'overview', dayIndex: 0 })
    expect(visibility.markerKeys.size).toBe(4)
    expect(visibility.legIds.size).toBe(2)
    expect(visibility.separateLegIds.size).toBe(0)
  })

  it('单日 day1：只有 day1 的点 + 归属 day1 的段；另一段进单独列表', () => {
    const visibility = computeMapVisibility({ markerDays, legs, viewMode: 'day', dayIndex: 1 })
    expect(visibility.markerKeys).toEqual(new Set(['1-0', '1-1']))
    expect(visibility.legIds).toEqual(new Set(['leg-1']))
    expect(visibility.separateLegIds).toEqual(new Set(['leg-0']))
  })

  it('重复计算 20 次结果一致（切日只翻转可见性，不累积状态）', () => {
    const first = computeMapVisibility({ markerDays, legs, viewMode: 'day', dayIndex: 0 })
    for (let index = 0; index < 20; index += 1) {
      expect(computeMapVisibility({ markerDays, legs, viewMode: 'day', dayIndex: 0 })).toEqual(first)
    }
  })
})

// ── 遮挡感知取景 padding ──

describe('map-view：遮挡取景 padding', () => {
  it('按浮层占用让位（margin 默认 18px）', () => {
    const padding = computeOcclusionPadding({
      viewportWidth: 1440, viewportHeight: 900,
      top: 60, left: 320, right: 340, bottom: 90,
    })
    expect(padding).toEqual({ top: 78, right: 358, bottom: 108, left: 338 })
  })

  it('padding 超过视口一半时夹紧，取景不会塌缩', () => {
    const padding = computeOcclusionPadding({
      viewportWidth: 800, viewportHeight: 600,
      top: 100, left: 900, right: 0, bottom: 0,
    })
    expect(padding.left).toBeLessThanOrEqual(800 / 2 - 24)
    expect(padding.top).toBeLessThanOrEqual(600 / 2 - 24)
    expect(padding.left).toBeGreaterThan(0)
  })

  it('无浮层时仍有安全边距', () => {
    const padding = computeOcclusionPadding({ viewportWidth: 1440, viewportHeight: 900 })
    expect(padding).toEqual({ top: 18, right: 18, bottom: 18, left: 18 })
  })
})

// ── 降级与回退 ──

describe('map-view：provider 降级与无坐标回退', () => {
  it('createState 保留视图状态（降级重建后日选择/总览恢复）', () => {
    const ui = { viewMode: 'day' as const, dayIndex: 1, selectedKey: '1-1', lockedKey: '1-1', drawerOpen: true }
    const state = createState(fixtureData('leaflet'), 'leaflet', ui)
    expect(state.viewMode).toBe('day')
    expect(state.dayIndex).toBe(1)
    expect(state.selectedKey).toBe('1-1')
    expect(state.lockedKey).toBe('1-1')
    expect(state.drawerOpen).toBe(true)
  })

  it('hasMappableContent=false → 地图让位静态列表（不显示空白无解释页面）', () => {
    expect(hasMappableContent(0)).toBe(false)
    expect(hasMappableContent(3)).toBe(true)
    const data = fixtureData('leaflet')
    data.itinerary.days.forEach((dayItem) => {
      dayItem.stops.forEach((stopItem) => { delete (stopItem as Partial<ItineraryStop>).coords })
    })
    const state = createState(data, 'leaflet')
    expect(state.markerModels).toHaveLength(0)
    expect(state.stops.length).toBeGreaterThan(0) // 静态列表仍有全部 stop
  })
})
