import type { RouteSegmentKind } from './route-view.js'

/**
 * 地图视图呈现规则（地图优先 T2）：总览/单日可见性、遮挡感知取景 padding、
 * 日色/中性色归属。纯逻辑、无 DOM——runtime.ts 的双适配器（AMap/Leaflet）与
 * 单测（tests/render-map-view.test.ts）共同消费，保证两 provider 行为一致。
 */

export type MapViewMode = 'overview' | 'day'

/** 跨日衔接（总览展示、单日单独入口，不混入当天线路）。 */
export const CROSS_DAY_COLOR = '#47566b'
/** 日归属未分配/映射无效（可信映射不足时的中性降级色）。 */
export const UNASSIGNED_COLOR = '#93a1b3'
/** 地点标记色（仍按 stop 自身所在日取 8 色调色板；runtime 持有 DAY_COLORS）。 */
export type OcclusionPadding = { top: number; right: number; bottom: number; left: number }

/** 路线段展示归属（route-view 的 kind + 展示色/线型决策）。 */
export interface SegmentPresentation {
  kind: RouteSegmentKind
  dayIndex?: number
  color: string
  /** 线型只由几何状态决定：真实几何实线、估算/回退虚线——跨日不改线型。 */
  dashed: boolean
}

export function segmentPresentation(kind: RouteSegmentKind, dayIndex: number | undefined, dashed: boolean, dayColor: (dayIndex: number) => string): SegmentPresentation {
  if (kind === 'day' && dayIndex !== undefined) {
    return { kind, dayIndex, color: dayColor(dayIndex), dashed }
  }
  return {
    kind,
    dayIndex: undefined,
    color: kind === 'cross-day' ? CROSS_DAY_COLOR : UNASSIGNED_COLOR,
    dashed,
  }
}

export interface VisibilityInput {
  /** 全部 marker key → 日序（cluster 的 key 以成员日判定）。 */
  markerDays: ReadonlyArray<{ key: string; dayIndex: number }>
  /** 全部路线段的展示归属。 */
  legs: ReadonlyArray<{ id: string; kind: RouteSegmentKind; dayIndex?: number }>
  viewMode: MapViewMode
  dayIndex: number
}

export interface MapVisibility {
  markerKeys: Set<string>
  /** 当前视图可见的路线段 id。 */
  legIds: Set<string>
  /** 单日模式下不显示、需在「单独列表」说明的段（跨日+未分配）。 */
  separateLegIds: Set<string>
}

/**
 * 可见性规则：
 * - overview：全部可信点/段可见；
 * - day：只保留该日的点与绑定到该日的段；跨日/未分配段落入 separateLegIds
 *   （单日只显示单独入口，不混入当天线路或日统计）。
 */
export function computeMapVisibility(input: VisibilityInput): MapVisibility {
  if (input.viewMode === 'overview') {
    return {
      markerKeys: new Set(input.markerDays.map((marker) => marker.key)),
      legIds: new Set(input.legs.map((leg) => leg.id)),
      separateLegIds: new Set<string>(),
    }
  }
  const markerKeys = new Set(input.markerDays.filter((marker) => marker.dayIndex === input.dayIndex).map((marker) => marker.key))
  const legIds = new Set<string>()
  const separateLegIds = new Set<string>()
  for (const leg of input.legs) {
    if (leg.kind === 'day' && leg.dayIndex === input.dayIndex) legIds.add(leg.id)
    else separateLegIds.add(leg.id)
  }
  return { markerKeys, legIds, separateLegIds }
}

/**
 * 遮挡感知取景 padding（px）：把浮动面板占用的面积让出来，避免适配视野后
 * 地点被面板盖住。输入为各面板在视口内的占用（0 = 不存在/收起）。
 */
export function computeOcclusionPadding(rects: {
  viewportWidth: number
  viewportHeight: number
  /** 顶部条（标题/日tabs）占用高。 */
  top?: number
  /** 左侧面板占用宽。 */
  left?: number
  /** 右侧详情面板占用宽。 */
  right?: number
  /** 底部 dock 占用高。 */
  bottom?: number
  /** 安全边距（默认 18px）。 */
  margin?: number
}): OcclusionPadding {
  const margin = rects.margin ?? 18
  const halfW = Math.max(0, rects.viewportWidth / 2 - 24)
  const halfH = Math.max(0, rects.viewportHeight / 2 - 24)
  const clamp = (value: number, half: number): number => Math.min(Math.max(0, Math.round(value)), half)
  return {
    top: clamp((rects.top ?? 0) + margin, halfH),
    left: clamp((rects.left ?? 0) + margin, halfW),
    right: clamp((rects.right ?? 0) + margin, halfW),
    bottom: clamp((rects.bottom ?? 0) + margin, halfH),
  }
}

/** 无任何可绘制坐标 → 地图让位给静态列表（不显示空白无解释页面）。 */
export function hasMappableContent(markerCount: number): boolean {
  return markerCount > 0
}
