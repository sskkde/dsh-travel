/**
 * render-route-view 单测（地图优先 T1，TDD 先红后绿）。
 *
 * 被测对象：src/render/page/route-view.ts —— 展示层路线日归属投影（纯逻辑，无 DOM）。
 * 锁定规则（.omo/drafts/map-first-output.md T1）：
 * - 只按 canonical 边 orderIndex 唯一匹配 + 方向 placeId 一致绑定，不按首 placeId
 *   或 legs 数组位置猜测；
 * - 锚点重放 canonicalRouteFromDays 的接纳/折叠规则；相邻同 placeId 折叠为 alias；
 *   非相邻重复 occurrence / 同 occurrence 多 placeId / 重放≠canonical → 映射无效；
 * - 日界共享住宿点：折叠 alias 使跨日相邻边归入次日（不是 cross-day）；
 * - 无共享锚点的日间边 → cross-day；多日候选/歧义 → unassigned（中性色）；
 * - legacy 无 canonical：方向端点对在行程出现链唯一且归属唯一才绑定；
 * - 日内/跨日/未分配统计分组，不重复计入；不完整当日里程不冒充完整。
 */
import { describe, expect, it } from 'vitest'
import { canonicalRouteFromDays } from '../src/route-check.js'
import {
  buildRouteView,
  computeEdgeDayCandidates,
  type ReplayedEdge,
  type RouteViewStop,
} from '../src/render/page/route-view.js'
import type { CanonicalRoute, ItineraryDay, ItineraryStop, RouteTransportLeg } from '../src/models/types.js'

// ── 夹具构造 ──

let coordCursor = 0
function stop(name: string, placeId: string, occurrenceId: string, opts: { noCoords?: boolean } = {}): ItineraryStop {
  coordCursor += 1
  return {
    name,
    placeId,
    occurrenceId,
    category: 'attraction',
    ...(opts.noCoords === true ? {} : { coords: { lng: 90 + coordCursor * 0.1, lat: 30 + coordCursor * 0.1, sys: 'GCJ02' as const } }),
    intelRefs: [],
  }
}

function day(date: string, stops: ItineraryStop[]): ItineraryDay {
  return { date, stops, meals: [] }
}

function leg(orderIndex: number, fromPlaceId: string, toPlaceId: string, overrides: Partial<RouteTransportLeg> = {}): RouteTransportLeg {
  return {
    id: `leg-${orderIndex}-${fromPlaceId}-${toPlaceId}`,
    fromPlaceId,
    toPlaceId,
    orderIndex,
    placesVersion: 1,
    mode: 'driving',
    status: 'queried',
    metricStatus: 'queried',
    geometryStatus: 'queried',
    distanceKm: 10 + orderIndex,
    durationMinutes: 20 + orderIndex,
    observedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function kindOf(view: ReturnType<typeof buildRouteView>, orderIndex: number) {
  const bound = view.legs.find((item) => item.orderIndex === orderIndex)
  expect(bound, `orderIndex=${orderIndex} 的 leg 缺失`).toBeTruthy()
  return bound!
}

// ── canonical 模式：日归属 ──

describe('route-view：canonical 模式日归属', () => {
  it('单日 A→B：leg 按方向端点对 + orderIndex 归入该日', () => {
    const days = [day('2026-10-01', [stop('甲', 'A', 'a0'), stop('乙', 'B', 'b0')])]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'B')], canonical)
    expect(view.valid).toBe(true)
    expect(view.mode).toBe('canonical')
    const bound = kindOf(view, 0)
    expect(bound.kind).toBe('day')
    expect(bound.dayIndex).toBe(0)
    expect(bound.fromOccurrenceId).toBe('a0')
    expect(bound.toOccurrenceId).toBe('b0')
  })

  it('计划夹具：日界共享住宿点 alias b1→b0 —— e0 归 DAY01、e1 归 DAY02（不是跨日）', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('B', 'B', 'b1'), stop('C', 'C', 'c1')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    // canonical 锚点：a0(day0/0)、b0(day0/1)、c1(day1/1)；b1 被折叠 alias 到 b0。
    expect(canonical.nodes.map((node) => node.occurrenceId)).toEqual(['a0', 'b0', 'c1'])
    const view = buildRouteView(days, [leg(0, 'A', 'B'), leg(1, 'B', 'C')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 1)).toMatchObject({ kind: 'day', dayIndex: 1 })
    // alias 记录：day1/stop0 的 b1 折叠到 b0；保留原 dayIndex/stopIndex。
    const b1 = view.stops.find((item) => item.dayIndex === 1 && item.stopIndex === 0)
    expect(b1?.aliasOccurrenceId).toBe('b0')
    expect(b1?.occurrenceId).toBe('b1')
  })

  it('10 日动态链式：每条 leg 归入对应日，无跨日误判', () => {
    const days: ItineraryDay[] = []
    for (let index = 0; index < 10; index += 1) {
      days.push(day(`2026-10-${String(index + 1).padStart(2, '0')}`, [
        stop(`P${index}`, `P${index}`, `p${index}-a`),
        stop(`P${index + 1}`, `P${index + 1}`, `p${index + 1}-a`),
      ]))
    }
    const canonical = canonicalRouteFromDays(days)
    const legs = Array.from({ length: 10 }, (_, index) => leg(index, `P${index}`, `P${index + 1}`))
    const view = buildRouteView(days, legs, canonical)
    expect(view.valid).toBe(true)
    for (let index = 0; index < 10; index += 1) {
      expect(kindOf(view, index)).toMatchObject({ kind: 'day', dayIndex: index })
    }
    expect(view.crossDayCount).toBe(0)
    expect(view.unassignedCount).toBe(0)
  })

  it('无共享锚点的日间边 → cross-day（单独标识，不混入日统计）', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('C', 'C', 'c1'), stop('D', 'D', 'd1')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'B'), leg(1, 'B', 'C'), leg(2, 'C', 'D')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 1)).toMatchObject({ kind: 'cross-day' })
    expect(kindOf(view, 1).dayIndex).toBeUndefined()
    expect(kindOf(view, 2)).toMatchObject({ kind: 'day', dayIndex: 1 })
    expect(view.crossDayCount).toBe(1)
  })

  it('非相邻重访使用独立节点 b2，不合并进 b0；其后的边正常归属', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0'), stop('C', 'C', 'c0')]),
      day('2026-10-02', [stop('B', 'B', 'b2'), stop('D', 'D', 'd2')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    // b2 是新接纳节点（非相邻重访），与 b0 独立。
    expect(canonical.nodes.some((node) => node.occurrenceId === 'b2' && node.dayIndex === 1)).toBe(true)
    const view = buildRouteView(days, [leg(0, 'A', 'B'), leg(1, 'B', 'C'), leg(2, 'C', 'B'), leg(3, 'B', 'D')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 1)).toMatchObject({ kind: 'day', dayIndex: 0 })
    // C→B 是跨日衔接（c0 day0 → b2 day1，无日内锚点对）。
    expect(kindOf(view, 2)).toMatchObject({ kind: 'cross-day' })
    expect(kindOf(view, 3)).toMatchObject({ kind: 'day', dayIndex: 1 })
    // 独立性：day1/stop0 alias 是自身 b2，不是 b0。
    const b2 = view.stops.find((item) => item.dayIndex === 1 && item.stopIndex === 0)
    expect(b2?.aliasOccurrenceId).toBe('b2')
  })

  it('闭环 A→B→A：两条边都归入同一日', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0'), stop('A', 'A', 'a1')])]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'B'), leg(1, 'B', 'A')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 1)).toMatchObject({ kind: 'day', dayIndex: 0 })
  })

  it('重复端点对按 orderIndex 消歧；错 orderIndex / 错方向 → unassigned', () => {
    const days = [day('2026-10-01', [
      stop('A', 'A', 'a0'), stop('B', 'B', 'b0'), stop('A', 'A', 'a1'), stop('B', 'B', 'b2'),
    ])]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [
      leg(0, 'A', 'B'), leg(1, 'B', 'A'), leg(2, 'A', 'B'),
      leg(1, 'A', 'B'), // 错 orderIndex：A→B 只有 order0/order2
      leg(0, 'B', 'A'), // 错方向：order0 的边是 A→B
    ], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 1)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 2)).toMatchObject({ kind: 'day', dayIndex: 0 })
    // 两条 A→B 的未匹配 leg：view.legs 按传入顺序保留 5 条，后两条 unassigned。
    const unmatched = view.legs.filter((item) => item.kind === 'unassigned')
    expect(unmatched).toHaveLength(2)
    for (const item of unmatched) {
      expect(item.reason.length).toBeGreaterThan(0)
    }
  })

  it('legs 打乱仍按 orderIndex 绑定；缺失的 leg 不影响其余', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('B', 'B', 'b1'), stop('C', 'C', 'c1')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(1, 'B', 'C'), leg(0, 'A', 'B')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
    expect(kindOf(view, 1)).toMatchObject({ kind: 'day', dayIndex: 1 })
    // 只给 order1：正常绑定，不因缺 order0 而整体放弃。
    const partial = buildRouteView(days, [leg(1, 'B', 'C')], canonical)
    expect(kindOf(partial, 1)).toMatchObject({ kind: 'day', dayIndex: 1 })
  })

  it('canonical 中 orderIndex 重复（两条同候选边）→ 该 leg unassigned', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')])]
    const canonical = canonicalRouteFromDays(days)
    const corrupt: CanonicalRoute = {
      ...canonical,
      edges: [
        ...canonical.edges,
        { id: 'edge-dup', fromOccurrenceId: 'a0', toOccurrenceId: 'b0', orderIndex: 0 },
      ],
    }
    const view = buildRouteView(days, [leg(0, 'A', 'B')], corrupt)
    expect(kindOf(view, 0).kind).toBe('unassigned')
  })

  it('缺坐标的 stop 不影响按 placeId/occurrence 绑定', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0', { noCoords: true }), stop('B', 'B', 'b0', { noCoords: true })])]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'B')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
  })

  it('零长度假边：相邻同 placeId 不产生边，B→B 的 leg 不误绑', () => {
    const days = [day('2026-10-01', [stop('B', 'B', 'b0'), stop('B住宿', 'B', 'b1')])]
    const canonical = canonicalRouteFromDays(days)
    expect(canonical.edges).toHaveLength(0)
    const view = buildRouteView(days, [leg(0, 'B', 'B')], canonical)
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0).kind).toBe('unassigned')
  })
})

// ── canonical 模式：映射无效（不猜别名） ──

describe('route-view：映射无效防御', () => {
  it('非相邻重复 occurrence → 映射无效，全部 unassigned 且不阻断原因说明', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('C', 'C', 'a0')]), // occurrenceId a0 非相邻重复
    ]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'B'), leg(1, 'B', 'C')], canonical)
    expect(view.valid).toBe(false)
    expect(view.invalidReason).toContain('a0')
    expect(view.legs.every((item) => item.kind === 'unassigned')).toBe(true)
  })

  it('同 occurrence 多 placeId → 映射无效', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'x0'), stop('C', 'C', 'x0')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'C')], canonical)
    expect(view.valid).toBe(false)
    expect(view.legs.every((item) => item.kind === 'unassigned')).toBe(true)
  })

  it('重放 nodes/edges 与现有 canonical 不一致 → 无效（不猜别名）', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')])]
    const canonical = canonicalRouteFromDays(days)
    const tampered: CanonicalRoute = {
      ...canonical,
      nodes: [...canonical.nodes, { occurrenceId: 'ghost', placeId: 'G', dayIndex: 0, stopIndex: 9 }],
    }
    const view = buildRouteView(days, [leg(0, 'A', 'B')], tampered)
    expect(view.valid).toBe(false)
    expect(view.invalidReason).toBeTruthy()
    expect(kindOf(view, 0).kind).toBe('unassigned')
  })

  it('映射无效时仍给出全部 leg 的中性 unassigned 记录（总览可继续画可信几何）', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('C', 'C', 'a0')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [leg(0, 'A', 'B'), leg(1, 'B', 'C')], canonical)
    expect(view.legs.map((item) => item.legId)).toEqual(['leg-0-A-B', 'leg-1-B-C'])
    expect(view.legs.every((item) => item.kind === 'unassigned' && item.dayIndex === undefined)).toBe(true)
  })
})

// ── legacy 模式（无 canonical） ──

describe('route-view：legacy 模式', () => {
  it('方向端点对唯一且归属唯一 → 绑定该日', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')])]
    const view = buildRouteView(days, [leg(0, 'A', 'B')], undefined)
    expect(view.mode).toBe('legacy')
    expect(view.valid).toBe(true)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'day', dayIndex: 0 })
  })

  it('端点对出现在多日 → 不唯一 → unassigned（不做首日猜测）', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('A', 'A', 'a1'), stop('B', 'B', 'b1')]),
    ]
    const view = buildRouteView(days, [leg(0, 'A', 'B')], undefined)
    expect(kindOf(view, 0)).toMatchObject({ kind: 'unassigned' })
  })

  it('同日重复端点对 → 不唯一 → unassigned', () => {
    const days = [day('2026-10-01', [
      stop('A', 'A', 'a0'), stop('B', 'B', 'b0'), stop('A', 'A', 'a1'), stop('B', 'B', 'b2'),
    ])]
    const view = buildRouteView(days, [leg(0, 'A', 'B')], undefined)
    expect(kindOf(view, 0).kind).toBe('unassigned')
  })

  it('端点不在行程出现链（首 placeId 回退被禁止）→ unassigned', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')])]
    const view = buildRouteView(days, [leg(0, 'A', 'C')], undefined)
    expect(kindOf(view, 0).kind).toBe('unassigned')
    // 无 placeId 的 legacy stop 不参与链；端点无法解析 → unassigned，不误绑。
    const noPlaceDays = [day('2026-10-01', [
      { name: '无名一', category: 'attraction', coords: { lng: 100, lat: 30, sys: 'GCJ02' }, intelRefs: [] },
      { name: '无名二', category: 'attraction', coords: { lng: 101, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
    ])]
    const legacyView = buildRouteView(noPlaceDays, [leg(0, 'A', 'B')], undefined)
    expect(kindOf(legacyView, 0).kind).toBe('unassigned')
  })

  it('legacy 不产生 cross-day 判定（无 canonical 两端日属证据）', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('C', 'C', 'c1'), stop('D', 'D', 'd1')]),
    ]
    const view = buildRouteView(days, [leg(1, 'B', 'C')], undefined)
    expect(kindOf(view, 1).kind).toBe('unassigned')
    expect(kindOf(view, 1).kind).not.toBe('cross-day')
  })
})

// ── 统计分组 ──

describe('route-view：日统计分组', () => {
  it('日内/跨日/未分配分组，不重复计入总计；不完整当日里程显式不可用', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('B', 'B', 'b1'), stop('C', 'C', 'c1')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    const legs = [
      leg(0, 'A', 'B', { distanceKm: 30, durationMinutes: 40, metricStatus: 'queried' }),
      leg(1, 'B', 'C', { metricStatus: 'unavailable', status: 'unavailable', distanceKm: undefined, durationMinutes: undefined, geometryStatus: 'unavailable' }),
    ]
    const view = buildRouteView(days, legs, canonical)
    expect(view.dayStats).toEqual([
      expect.objectContaining({ dayIndex: 0, legCount: 1, distanceKm: 30, durationMinutes: 40, complete: true }),
      // 第 2 天的 leg 里程不可用 → 该日部分数据/不可用，不得报 0。
      expect.objectContaining({ dayIndex: 1, legCount: 1, distanceKm: undefined, durationMinutes: undefined, complete: false }),
    ])
    expect(view.crossDayCount).toBe(0)
    expect(view.unassignedCount).toBe(0)
  })

  it('跨日与未分配 leg 不进入任何 dayStats；估算不升格为真实道路', () => {
    const days = [
      day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')]),
      day('2026-10-02', [stop('C', 'C', 'c1'), stop('D', 'D', 'd1')]),
    ]
    const canonical = canonicalRouteFromDays(days)
    const legs = [
      leg(0, 'A', 'B', { metricStatus: 'estimated', status: 'estimated', estimateReason: '直线估算' }),
      leg(1, 'B', 'C'),
      leg(2, 'C', 'D', { metricStatus: 'blocked', status: 'blocked', distanceKm: undefined, durationMinutes: undefined }),
    ]
    const view = buildRouteView(days, legs, canonical)
    // 日 0 只有估算 leg：距离仍是几何事实（直线估算），但标注不完整（估算≠实测）。
    expect(view.dayStats[0]).toMatchObject({ dayIndex: 0, legCount: 1, complete: false })
    expect(view.dayStats[0].distanceKm).toBe(10)
    // 跨日 leg（B→C）不计入任何一日：两日合计只统计 A→B 与 C→D。
    expect(kindOf(view, 1).kind).toBe('cross-day')
    expect(view.dayStats[0]).toMatchObject({ dayIndex: 0, legCount: 1, complete: false })
    // 日 1 的 C→D 是 blocked（无指标）→ 该日无可用里程。
    expect(view.dayStats[1]).toMatchObject({ dayIndex: 1, legCount: 1, complete: false })
    expect(view.dayStats[1].distanceKm).toBeUndefined()
    expect(view.crossDayCount).toBe(1)
    expect(view.unassignedCount).toBe(0)
    expect(view.dayStats.reduce((sum, stat) => sum + stat.legCount, 0)).toBe(2)
  })

  it('无任何 legs → 全部日统计为空且不完整', () => {
    const days = [day('2026-10-01', [stop('A', 'A', 'a0'), stop('B', 'B', 'b0')])]
    const canonical = canonicalRouteFromDays(days)
    const view = buildRouteView(days, [], canonical)
    expect(view.legs).toHaveLength(0)
    expect(view.dayStats[0]).toMatchObject({ dayIndex: 0, legCount: 0, complete: false })
  })
})

// ── 防御分支：多日候选（直接测纯函数） ──

describe('route-view：多日候选防御（computeEdgeDayCandidates）', () => {
  it('同一定向 occurrence 对出现在两日 → 两日候选（绑定层据此 unassigned）', () => {
    const stops: RouteViewStop[] = [
      { key: '0-0', dayIndex: 0, stopIndex: 0, placeId: 'A', occurrenceId: 'a0', aliasOccurrenceId: 'a0' },
      { key: '0-1', dayIndex: 0, stopIndex: 1, placeId: 'B', occurrenceId: 'b0', aliasOccurrenceId: 'b0' },
      { key: '1-0', dayIndex: 1, stopIndex: 0, placeId: 'A', occurrenceId: 'a1', aliasOccurrenceId: 'a0' },
      { key: '1-1', dayIndex: 1, stopIndex: 1, placeId: 'B', occurrenceId: 'b1', aliasOccurrenceId: 'b0' },
    ]
    const edges: ReplayedEdge[] = [{ id: 'edge-0', fromOccurrenceId: 'a0', toOccurrenceId: 'b0', orderIndex: 0 }]
    const candidates = computeEdgeDayCandidates(stops, edges)
    expect(candidates.get('a0\u0000b0')).toEqual(new Set([0, 1]))
  })

  it('相同 alias 的相邻 stop（零长边）不产生候选', () => {
    const stops: RouteViewStop[] = [
      { key: '0-0', dayIndex: 0, stopIndex: 0, placeId: 'B', occurrenceId: 'b0', aliasOccurrenceId: 'b0' },
      { key: '0-1', dayIndex: 0, stopIndex: 1, placeId: 'B', occurrenceId: 'b1', aliasOccurrenceId: 'b0' },
    ]
    const candidates = computeEdgeDayCandidates(stops, [])
    expect(candidates.size).toBe(0)
  })
})
