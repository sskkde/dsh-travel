import type {
  CanonicalRoute,
  ItineraryDay,
  RouteTransportLeg,
} from '../../models/types.js'

/**
 * 路线视图投影（地图优先 T1）：把 itinerary days + routeTransport legs 投影为
 * 展示层内部的「路线段视图」——每条 leg 的日归属（day|cross-day|unassigned）、
 * 每个 stop 的 canonical 锚点 alias、每日统计分组。
 *
 * 纪律：
 * - 纯展示层派生。不修改对外 RouteTransportLeg / canonicalRoute / 工具参数，
 *   不写回任何工件；调用方（runtime.ts）只读消费。
 * - 绑定只认「canonical 边 orderIndex 唯一匹配 + 方向 placeId 一致」——不按首
 *   placeId、不按 legs 数组位置猜测（runtime 旧 endpointPoint 回退的教训）。
 * - 锚点映射重放 canonicalRouteFromDays 的接纳/折叠规则；重放结果与现有
 *   canonicalRoute 不一致（或行程含非法重复 occurrence）时整体标记无效、不猜
 *   别名，全部 leg 落 unassigned（中性色），总览仍可继续画可信几何。
 * - legacy（无 canonical）只允许「方向端点对在行程出现链唯一且归属唯一」的
 *   绑定；其余 unassigned，不产生 cross-day 判定。
 */

export type RouteSegmentKind = 'day' | 'cross-day' | 'unassigned'

/** 单条 leg 的日归属记录（legId 与输入 leg.id 一致）。 */
export interface RouteViewLeg {
  legId: string
  orderIndex: number
  fromPlaceId: string
  toPlaceId: string
  kind: RouteSegmentKind
  /** kind='day' 时的日序（0 基）；其余 undefined。 */
  dayIndex?: number
  /** 绑定/放弃绑定的理由（页面「日归属未分配」等说明与审计用）。 */
  reason: string
  /** canonical 绑定成功时的有向 occurrence 端点（审计用）。 */
  fromOccurrenceId?: string
  toOccurrenceId?: string
}

/** 单个 stop 的锚点 alias 记录（key = `${dayIndex}-${stopIndex}`，与 runtime 一致）。 */
export interface RouteViewStop {
  key: string
  dayIndex: number
  stopIndex: number
  placeId?: string
  occurrenceId?: string
  /** 折叠 stop 指向此前接纳的 canonical occurrence；接纳节点为自身；无 round3 标识缺省。 */
  aliasOccurrenceId?: string
}

/** 每日统计：只统计 kind='day' 绑定到该日的 legs；跨日/未分配不重复计入。 */
export interface RouteViewDayStat {
  dayIndex: number
  /** 绑定到该日的 leg 数。 */
  legCount: number
  distanceKm?: number
  durationMinutes?: number
  /** false = 该日里程/时长部分数据或不可用（缺 leg、指标缺失或仅估算），不得冒充完整。 */
  complete: boolean
}

export interface RouteViewModel {
  /** true = 锚点重放与 canonical 一致（或 legacy 链可用）；false 时全部 leg unassigned。 */
  valid: boolean
  invalidReason?: string
  mode: 'canonical' | 'legacy'
  stops: RouteViewStop[]
  legs: RouteViewLeg[]
  dayStats: RouteViewDayStat[]
  crossDayCount: number
  unassignedCount: number
}

/** 重放产物（与 CanonicalRouteNode/Edge 同构；内部用，便于与现有 canonical 对比）。 */
export interface ReplayedNode {
  occurrenceId: string
  placeId: string
  dayIndex: number
  stopIndex: number
}

export interface ReplayedEdge {
  id: string
  fromOccurrenceId: string
  toOccurrenceId: string
  orderIndex: number
}

function hasAnchor(stop: ItineraryDay['stops'][number]): boolean {
  return typeof stop.placeId === 'string' && stop.placeId.length > 0
    && typeof stop.occurrenceId === 'string' && stop.occurrenceId.length > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

interface ReplayResult {
  stops: RouteViewStop[]
  nodes: ReplayedNode[]
  edges: ReplayedEdge[]
  invalid?: string
}

/**
 * 锚点重放：按 days 顺序只遍历具有 placeId/occurrenceId 的 stop，重放
 * canonicalRouteFromDays 的接纳/折叠规则（route-check.ts:170-203）：
 * - 接纳节点 → alias 为自身 occurrence；
 * - 相邻同 placeId 被跳过的 stop → alias 到此前接纳的 canonical occurrence
 *   （内部 alias，保留原 dayIndex/stopIndex）；
 * - 非相邻重复 occurrence / 同 occurrence 多 placeId → 标记映射无效（canonical
 *   侧静默跳过，视图侧必须如实无效——不猜别名）。
 */
function replayAnchors(days: readonly ItineraryDay[]): ReplayResult {
  const stops: RouteViewStop[] = []
  const nodes: ReplayedNode[] = []
  const edges: ReplayedEdge[] = []
  const seen = new Map<string, string>()
  let previous: ReplayedNode | undefined
  let orderIndex = 0
  let invalid: string | undefined
  days.forEach((day, dayIndex) => {
    day.stops.forEach((stop, stopIndex) => {
      const key = `${dayIndex}-${stopIndex}`
      if (!hasAnchor(stop)) {
        stops.push({ key, dayIndex, stopIndex })
        return
      }
      const placeId = stop.placeId as string
      const occurrenceId = stop.occurrenceId as string
      if (previous !== undefined && previous.placeId === placeId) {
        // 相邻同 placeId：折叠为 alias，不接纳新节点（canonicalRouteFromDays 同规则）。
        stops.push({ key, dayIndex, stopIndex, placeId, occurrenceId, aliasOccurrenceId: previous.occurrenceId })
        return
      }
      const seenPlace = seen.get(occurrenceId)
      if (seenPlace !== undefined) {
        // 非相邻重复 occurrence（含同 occurrence 多 placeId）：视图侧判定无效。
        invalid ??= seenPlace === placeId
          ? `occurrence ${occurrenceId} 非相邻重复出现`
          : `occurrence ${occurrenceId} 对应多个 placeId（${seenPlace}/${placeId}）`
        stops.push({ key, dayIndex, stopIndex, placeId, occurrenceId })
        return
      }
      const node: ReplayedNode = { occurrenceId, placeId, dayIndex, stopIndex }
      nodes.push(node)
      seen.set(occurrenceId, placeId)
      if (previous !== undefined) {
        edges.push({
          id: `edge-${orderIndex}`,
          fromOccurrenceId: previous.occurrenceId,
          toOccurrenceId: node.occurrenceId,
          orderIndex,
        })
        orderIndex += 1
      }
      previous = node
      stops.push({ key, dayIndex, stopIndex, placeId, occurrenceId, aliasOccurrenceId: occurrenceId })
    })
  })
  return { stops, nodes, edges, ...(invalid === undefined ? {} : { invalid }) }
}

function sameReplay(
  nodes: readonly ReplayedNode[],
  edges: readonly ReplayedEdge[],
  canonical: CanonicalRoute,
): boolean {
  const canonicalNodes = Array.isArray(canonical.nodes) ? canonical.nodes : []
  const canonicalEdges = Array.isArray(canonical.edges) ? canonical.edges : []
  if (canonicalNodes.length !== nodes.length || canonicalEdges.length !== edges.length) return false
  for (const [index, node] of nodes.entries()) {
    const other = canonicalNodes[index]
    if (other === undefined
      || other.occurrenceId !== node.occurrenceId
      || other.placeId !== node.placeId
      || other.dayIndex !== node.dayIndex
      || other.stopIndex !== node.stopIndex) return false
  }
  for (const [index, edge] of edges.entries()) {
    const other = canonicalEdges[index]
    if (other === undefined
      || other.fromOccurrenceId !== edge.fromOccurrenceId
      || other.toOccurrenceId !== edge.toOccurrenceId
      || other.orderIndex !== edge.orderIndex) return false
  }
  return true
}

/**
 * 每条 canonical 边的「日候选」：逐日取日内相邻有效 stop 的 alias，跳过相同
 * alias 的零长边，以有向 occurrence 对匹配边。
 *
 * 防御语义：有效重放下同一定向对至多出现一次（previous 单调前移）；该函数单独
 * 导出以锁定「多日候选 → unassigned」防御分支（绑定层不猜唯一日）。
 */
export function computeEdgeDayCandidates(
  stops: readonly RouteViewStop[],
  edges: readonly ReplayedEdge[],
): Map<string, Set<number>> {
  const candidates = new Map<string, Set<number>>()
  const byPair = new Map<string, number[]>()
  edges.forEach((edge, index) => {
    byPair.set(`${edge.fromOccurrenceId}\u0000${edge.toOccurrenceId}`, [...(byPair.get(`${edge.fromOccurrenceId}\u0000${edge.toOccurrenceId}`) ?? []), index])
  })
  // 逐日：日内相邻有效 stop 的 alias 对。
  const aliased = stops.filter((stop) => stop.aliasOccurrenceId !== undefined)
  let cursor = 0
  let currentDay = aliased.length > 0 ? aliased[0].dayIndex : -1
  for (let index = 0; index < aliased.length; index += 1) {
    const stop = aliased[index]
    if (stop.dayIndex !== currentDay) {
      currentDay = stop.dayIndex
      cursor = index
    }
    if (index === cursor) continue
    const from = aliased[index - 1].aliasOccurrenceId as string
    const to = stop.aliasOccurrenceId as string
    if (from === to) continue // 零长边（相邻同地折叠）不产生候选
    const key = `${from}\u0000${to}`
    const edgeIndexes = byPair.get(key)
    if (edgeIndexes === undefined) continue
    for (const edgeIndex of edgeIndexes) {
      const bucket = candidates.get(key) ?? new Set<number>()
      bucket.add(stop.dayIndex)
      candidates.set(key, bucket)
    }
  }
  return candidates
}

function legacyDayCandidates(days: readonly ItineraryDay[]): Map<string, number[]> {
  const pairs = new Map<string, number[]>()
  days.forEach((day, dayIndex) => {
    let previousPlaceId: string | undefined
    day.stops.forEach((stop) => {
      const placeId = typeof stop.placeId === 'string' && stop.placeId.length > 0 ? stop.placeId : undefined
      if (placeId === undefined) {
        previousPlaceId = undefined
        return
      }
      if (previousPlaceId !== undefined && previousPlaceId !== placeId) {
        const key = `${previousPlaceId}\u0000${placeId}`
        const bucket = pairs.get(key) ?? []
        bucket.push(dayIndex)
        pairs.set(key, bucket)
      }
      previousPlaceId = placeId
    })
  })
  return pairs
}

function dayStatsOf(days: readonly ItineraryDay[], legs: readonly RouteViewLeg[], rawLegs: readonly RouteTransportLeg[]): RouteViewDayStat[] {
  const byId = new Map(rawLegs.map((item) => [item.id, item]))
  return days.map((_day, dayIndex) => {
    const bound = legs.filter((item) => item.kind === 'day' && item.dayIndex === dayIndex)
    const raw = bound.map((item) => byId.get(item.legId)).filter((item): item is RouteTransportLeg => item !== undefined)
    const allFinite = raw.length > 0
      && raw.every((item) => finiteNumber(item.distanceKm) && finiteNumber(item.durationMinutes))
    // complete 只认全部 queried 实测；estimated 是几何事实（给数但 complete=false，
    // 页面标注「估算」）；unavailable/blocked/缺指标 → 无数，明确「部分数据/不可用」。
    const complete = raw.length > 0
      && raw.every((item) => (item.metricStatus ?? item.status) === 'queried')
      && allFinite
    return {
      dayIndex,
      legCount: bound.length,
      distanceKm: allFinite
        ? Math.round(raw.reduce((sum, item) => sum + (item.distanceKm as number), 0) * 10) / 10
        : undefined,
      durationMinutes: allFinite
        ? Math.round(raw.reduce((sum, item) => sum + (item.durationMinutes as number), 0))
        : undefined,
      complete,
    }
  })
}

/**
 * 主入口：days + legs（+ 可选 canonical）→ 路线视图。
 * canonical 缺失 → legacy 模式（唯一端点对绑定）；canonical 在场但重放不一致/
 * 行程含非法重复 occurrence → valid=false，全部 unassigned。
 */
export function buildRouteView(
  days: readonly ItineraryDay[],
  legs: readonly RouteTransportLeg[] | undefined,
  canonical: CanonicalRoute | undefined,
): RouteViewModel {
  const safeLegs = Array.isArray(legs) ? legs : []
  const replay = replayAnchors(days)
  const base: RouteViewModel = {
    valid: replay.invalid === undefined,
    ...(replay.invalid !== undefined ? { invalidReason: replay.invalid } : {}),
    mode: canonical === undefined ? 'legacy' : 'canonical',
    stops: replay.stops,
    legs: [],
    dayStats: [],
    crossDayCount: 0,
    unassignedCount: 0,
  }

  if (canonical !== undefined) {
    if (replay.invalid === undefined && !sameReplay(replay.nodes, replay.edges, canonical)) {
      base.valid = false
      base.invalidReason = '锚点重放与 canonicalRoute 不一致，放弃日归属绑定（不猜别名）'
    }
  }

  const viewLegs: RouteViewLeg[] = safeLegs.map((item) => ({
    legId: item.id,
    orderIndex: item.orderIndex,
    fromPlaceId: item.fromPlaceId,
    toPlaceId: item.toPlaceId,
    kind: 'unassigned' as const,
    reason: base.valid ? '尚未绑定' : (base.invalidReason ?? '日归属未分配'),
  }))

  if (base.valid && canonical !== undefined) {
    // canonical 模式：边 orderIndex 唯一匹配 + 方向 placeId 一致。
    const nodeByOccurrence = new Map(replay.nodes.map((node) => [node.occurrenceId, node]))
    const edgeDayCandidates = computeEdgeDayCandidates(replay.stops, replay.edges)
    for (const viewLeg of viewLegs) {
      const candidates = replay.edges
        .map((edge, index) => ({ edge, index }))
        .filter(({ edge }) => {
          const from = nodeByOccurrence.get(edge.fromOccurrenceId)
          const to = nodeByOccurrence.get(edge.toOccurrenceId)
          return from?.placeId === viewLeg.fromPlaceId && to?.placeId === viewLeg.toPlaceId
        })
      if (candidates.length === 0) {
        viewLeg.reason = 'canonical 中无该方向端点对，日归属未分配'
        continue
      }
      const exact = candidates.filter(({ edge }) => edge.orderIndex === viewLeg.orderIndex)
      if (exact.length !== 1) {
        viewLeg.reason = candidates.length > 1 && exact.length > 1
          ? 'canonical 边 orderIndex 重复，无法唯一指认'
          : 'leg orderIndex 与候选 canonical 边不匹配'
        continue
      }
      const { edge } = exact[0]
      const from = nodeByOccurrence.get(edge.fromOccurrenceId)
      const to = nodeByOccurrence.get(edge.toOccurrenceId)
      const dayCandidates = edgeDayCandidates.get(`${edge.fromOccurrenceId}\u0000${edge.toOccurrenceId}`) ?? new Set<number>()
      if (dayCandidates.size === 1) {
        const [dayIndex] = dayCandidates
        viewLeg.kind = 'day'
        viewLeg.dayIndex = dayIndex
        viewLeg.fromOccurrenceId = edge.fromOccurrenceId
        viewLeg.toOccurrenceId = edge.toOccurrenceId
        viewLeg.reason = `canonical 边 edge-${edge.orderIndex} 唯一匹配第 ${dayIndex + 1} 天日内锚点`
      } else if (dayCandidates.size > 1) {
        viewLeg.reason = '同一定向锚点对存在多日候选，日归属未分配'
      } else if (from !== undefined && to !== undefined && from.dayIndex !== to.dayIndex) {
        viewLeg.kind = 'cross-day'
        viewLeg.fromOccurrenceId = edge.fromOccurrenceId
        viewLeg.toOccurrenceId = edge.toOccurrenceId
        viewLeg.reason = `跨日衔接（第 ${from.dayIndex + 1} 天 → 第 ${to.dayIndex + 1} 天，无日内锚点对）`
      } else {
        viewLeg.reason = '无日候选且两端同日，日归属未分配'
      }
    }
  } else if (base.valid) {
    // legacy 模式：方向端点对在行程出现链唯一且归属唯一才绑定。
    const pairs = legacyDayCandidates(days)
    for (const viewLeg of viewLegs) {
      const bucket = pairs.get(`${viewLeg.fromPlaceId}\u0000${viewLeg.toPlaceId}`)
      if (bucket === undefined) {
        viewLeg.reason = '行程出现链中无该方向端点对，日归属未分配'
      } else if (bucket.length === 1) {
        viewLeg.kind = 'day'
        viewLeg.dayIndex = bucket[0]
        viewLeg.reason = `legacy 端点对唯一出现于第 ${bucket[0] + 1} 天`
      } else {
        viewLeg.reason = '方向端点对在行程出现链不唯一，日归属未分配'
      }
    }
  }

  base.legs = viewLegs
  base.dayStats = dayStatsOf(days, viewLegs, safeLegs)
  base.crossDayCount = viewLegs.filter((item) => item.kind === 'cross-day').length
  base.unassignedCount = viewLegs.filter((item) => item.kind === 'unassigned').length
  return base
}
