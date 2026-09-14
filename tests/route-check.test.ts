/**
 * src/route-check 动线校验单测（M1 T7 / W4）。
 *
 * 覆盖（T7 必测 + FR-6 验收）：
 *  - Haversine 纯函数 / daySpanKm 几何
 *  - 跨城折返：两日间 A→B→A 必触发 issue（FR-6 验收①否用例）；同日跨城往返
 *  - 正常单城 draft → issues=[]、warnings 合理
 *  - 单日跨度告警（参数化阈值）
 *  - 三级降级链 mock：高德缺 key→腾讯→直线估算（§2.1 FR-6 行演练）
 *  - 渠道开关（routeCheckAmap 关 → 跳过 + degraded 标注）
 * live smoke（TRAVEL_LIVE_SMOKE=1）：真实 key + 真实网络留证；网络受限降级链登记。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AmapAdapter } from '../src/adapters/amap.js'
import { TencentMapAdapter, type HttpCallFn, type HttpResponseLike } from '../src/adapters/tencent.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'
import type { ItineraryDay, ItineraryStop, RouteTransportLeg } from '../src/models/types.js'
import {
  createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider,
  haversineKm, daySpanKm, runRouteCheck,
  type RouteMeasureProvider,
} from '../src/route-check.js'
import { liveCredentialsEnv } from './live-credentials.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/tencent/${name}`, import.meta.url), 'utf8')
}

function jsonpFixture(text: string): string {
  return `qq.maps.callback(${text});`
}

function okResponse(text: string, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

/** httpCall mock（腾讯通道）：按 URL 子串路由 fixture / 注入超时。 */
function mockTencentHttp(): { call: HttpCallFn; setResponse: (p: string, r: HttpResponseLike) => void; setThrow: (p: string, e: unknown) => void } {
  const responses = new Map<string, HttpResponseLike>()
  const throws = new Map<string, unknown>()
  const call: HttpCallFn = async (url) => {
    for (const [part, e] of throws) if (url.includes(part)) throw e
    for (const [part, r] of responses) if (url.includes(part)) return r
    throw new Error(`mockTencentHttp: no fixture for ${url}`)
  }
  return {
    call,
    setResponse: (p, r) => { responses.set(p, r) },
    setThrow: (p, e) => { throws.set(p, e) },
  }
}

/** amap fetchFn mock：返回 v3/distance 成功体（status=1；对角双段）。 */
function mockAmapFetch(): (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: '1',
      info: 'OK',
      results: [
        { origin_id: '0', dest_id: '0', distance: '175316', duration: '8832' },
        { origin_id: '1', dest_id: '1', distance: '2955', duration: '349' },
      ],
    }),
  })
}

/** 两日间 A→B→A 折返 draft（FR-6 验收①否用例）：D1 上午 A 城 → D1 下午 B 城 → D2 回 A 城。 */
const backtrackDays: ItineraryDay[] = [
  {
    date: '2026-10-01',
    stops: [
      { name: '外滩', category: 'attraction', coords: { lng: 121.49, lat: 31.24, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['a1'] },
      { name: '西湖', category: 'attraction', coords: { lng: 120.15, lat: 30.25, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['b1'] },
    ],
    meals: [],
  },
  {
    date: '2026-10-02',
    stops: [
      { name: '豫园', category: 'attraction', coords: { lng: 121.49, lat: 31.22, sys: 'GCJ02' }, durationHint: 90, intelRefs: ['a2'] },
    ],
    meals: [],
  },
]

/** 同日跨城往返：单日内 近→远→近。 */
const sameDayRoundTripDays: ItineraryDay[] = [
  {
    date: '2026-10-01',
    stops: [
      { name: '外滩', category: 'attraction', coords: { lng: 121.49, lat: 31.24, sys: 'GCJ02' }, durationHint: 60, intelRefs: ['a1'] },
      { name: '西湖', category: 'attraction', coords: { lng: 120.15, lat: 30.25, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['b1'] },
      { name: '豫园', category: 'attraction', coords: { lng: 121.49, lat: 31.22, sys: 'GCJ02' }, durationHint: 90, intelRefs: ['a2'] },
    ],
    meals: [],
  },
]

/** 正常单城（杭州一日）：就近成片，无折返。 */
const normalHangzhouDays: ItineraryDay[] = [
  {
    date: '2026-10-01',
    stops: [
      { name: '西湖', category: 'attraction', coords: { lng: 120.15, lat: 30.25, sys: 'GCJ02' }, durationHint: 180, intelRefs: ['h1'] },
      { name: '灵隐寺', category: 'attraction', coords: { lng: 120.10, lat: 30.24, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['h2'] },
      { name: '河坊街', category: 'food', coords: { lng: 120.17, lat: 30.24, sys: 'GCJ02' }, durationHint: 60, intelRefs: ['h3'] },
    ],
    meals: [{ name: '河坊街小吃', intelRefs: ['h3'] }],
  },
]

describe('纯几何：Haversine / daySpanKm', () => {
  it('haversineKm：杭州西湖→灵隐寺 ≈ 5km（GCJ-02 平面近似误差内）', () => {
    const d = haversineKm({ lng: 120.15, lat: 30.25, sys: 'GCJ02' }, { lng: 120.10, lat: 30.24, sys: 'GCJ02' })
    expect(d).toBeGreaterThan(4)
    expect(d).toBeLessThan(6)
  })

  it('haversineKm：跨城（上海→杭州）明显大于阈值', () => {
    const d = haversineKm({ lng: 121.49, lat: 31.24, sys: 'GCJ02' }, { lng: 120.15, lat: 30.25, sys: 'GCJ02' })
    expect(d).toBeGreaterThan(100)
  })

  it('daySpanKm：单站天 → undefined；多站天 → 最远两站距离', () => {
    const single: ItineraryDay = { date: '2026-10-01', stops: [{ name: 'x', category: 'attraction', coords: { lng: 1, lat: 1, sys: 'GCJ02' }, intelRefs: [] }], meals: [] }
    expect(daySpanKm(single)).toBeUndefined()
    expect(daySpanKm(normalHangzhouDays[0])).toBeGreaterThan(0)
  })
})

describe('跨城折返检测（FR-6 验收①）', () => {
  it('两日间 A→B→A 折返 draft → issues 必触发（否用例）', async () => {
    const detail = await runRouteCheck(backtrackDays, { providers: [createEstimateRouteProvider()] })
    expect(detail.issues.some((i) => i.includes('跨城折返'))).toBe(true)
    expect(detail.issues[0]).toContain('直线估算')
    expect(detail.reference?.name).toBe('外滩')
    expect(detail.channelsUsed).toEqual(['estimate'])
  })

  it('同日跨城往返（近→远→近）→ issues 必触发', async () => {
    const detail = await runRouteCheck(sameDayRoundTripDays, { providers: [createEstimateRouteProvider()] })
    expect(detail.issues.some((i) => i.includes('同日跨城往返'))).toBe(true)
  })

  it('正常单城行程（杭州一日）→ issues=[]、warnings 合理', async () => {
    const detail = await runRouteCheck(normalHangzhouDays, { providers: [createEstimateRouteProvider()] })
    expect(detail.issues).toEqual([])
    expect(detail.warnings).toEqual([]) // 就近成片：无折返/无跨度过大
    expect(detail.segments).toHaveLength(2) // 3 stops → 2 相邻段
    expect(detail.segments.every((s) => s.source === 'estimate')).toBe(true)
  })

  it('单日跨度告警：多站跨度超阈值 → warning（参数化）', async () => {
    const wide: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: 'k1', category: 'attraction', coords: { lng: 121.00, lat: 31.00, sys: 'GCJ02' }, intelRefs: ['k1'] },
        { name: 'k2', category: 'attraction', coords: { lng: 121.30, lat: 31.25, sys: 'GCJ02' }, intelRefs: ['k2'] },
      ],
      meals: [],
    }]
    const detail = await runRouteCheck(wide, { providers: [createEstimateRouteProvider()] })
    expect(detail.issues).toEqual([])
    expect(detail.warnings.some((w) => w.includes('超过阈值'))).toBe(true)
    expect(detail.daySpansKm[0].spanKm).toBeGreaterThan(20)
  })

  it('无坐标 stops → 动线校验未执行 warning（不崩）', async () => {
    const noCoord: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: 'x1', category: 'attraction', coords: { lng: 121.0, lat: 31.0, sys: 'GCJ02' }, intelRefs: [] },
        // 第二站缺 coords（draft 面允许）
        { name: 'x2', category: 'food', durationHint: 60, intelRefs: [] } as unknown as ItineraryDay['stops'][number],
      ],
      meals: [],
    }]
    const detail = await runRouteCheck(noCoord, { providers: [createEstimateRouteProvider()] })
    expect(detail.warnings.some((w) => w.includes('无坐标'))).toBe(true)
  })
})

describe('三级降级链（§2.1 FR-6 行：高德→腾讯→直线估算）', () => {
  const chainEnv = (env: Record<string, string>): KeyResolutionEnv => ({ env })

  it('高德缺 key → 自动降级腾讯（zero key 候补）→ 测量成功且标注腾讯', async () => {
    const tencentMock = mockTencentHttp()
    tencentMock.setResponse('distance/v1/matrix', okResponse(jsonpFixture(fixture('distance-matrix.json'))))
    const providers: RouteMeasureProvider[] = [
      createAmapRouteProvider(new AmapAdapter()),
      createTencentRouteProvider(new TencentMapAdapter({ httpCall: tencentMock.call })),
      createEstimateRouteProvider(),
    ]
    const detail = await runRouteCheck(normalHangzhouDays, { providers, keyEnv: chainEnv({}) })
    expect(detail.channelsUsed).toEqual(['tencent'])
    expect(detail.degraded[0]?.channel).toBe('amap')
    expect(detail.degraded[0]?.reason).toContain('Key 未配置')
    expect(detail.segments.every((s) => s.source === 'tencent')).toBe(true)
    expect(detail.segments[0]?.note).toContain('腾讯 distance_matrix')
  })

  it('高德缺 key + 腾讯超时 → 直线估算兜底（标注 estimate，degraded 两条）', async () => {
    const tencentMock = mockTencentHttp()
    tencentMock.setThrow('distance/v1/matrix', new Error('Timeout: connect ETIMEDOUT'))
    const providers: RouteMeasureProvider[] = [
      createAmapRouteProvider(new AmapAdapter()),
      createTencentRouteProvider(new TencentMapAdapter({ httpCall: tencentMock.call })),
      createEstimateRouteProvider(),
    ]
    const detail = await runRouteCheck(normalHangzhouDays, { providers, keyEnv: chainEnv({}) })
    expect(detail.channelsUsed).toEqual(['estimate'])
    expect(detail.degraded).toHaveLength(2)
    expect(detail.degraded[1]?.reason).toMatch(/超时|Timeout/i)
    expect(detail.segments.every((s) => s.source === 'estimate' && s.note.includes('直线估算'))).toBe(true)
    expect(detail.issues).toEqual([]) // 兜底仍完成检测
  })

  it('高德有 key（mock fetch）→ 高德定级测量（distance=175316m）', async () => {
    const amap = new AmapAdapter({ fetchFn: mockAmapFetch() })
    const providers: RouteMeasureProvider[] = [
      createAmapRouteProvider(amap),
      createEstimateRouteProvider(),
    ]
    const detail = await runRouteCheck(normalHangzhouDays, { providers, keyEnv: chainEnv({ amapWebservice: 'test-key' }) })
    expect(detail.channelsUsed).toEqual(['amap'])
    expect(detail.degraded).toEqual([])
    expect(detail.segments.every((s) => s.source === 'amap' && s.note.includes('高德 distance'))).toBe(true)
    expect(detail.segments[0]?.distanceKm).toBeGreaterThan(170)
  })

  it('渠道开关：routeCheckAmap=off → amap 跳过 + degraded 标注（用户配置停用）', async () => {
    const amap = new AmapAdapter({ fetchFn: mockAmapFetch() })
    const providers: RouteMeasureProvider[] = [
      createAmapRouteProvider(amap),
      createEstimateRouteProvider(),
    ]
    const detail = await runRouteCheck(normalHangzhouDays, {
      providers,
      keyEnv: { env: { TRAVEL_CHANNEL_ROUTECHECKAMAP: 'off' } },
    })
    expect(detail.channelsUsed).toEqual(['estimate'])
    expect(detail.degraded[0]?.reason).toContain('渠道停用')
  })
})

describe('T24 自适应动线告警', () => {
  /**
   * 几何跨度约 95km 的两站日（> relaxed 几何阈值 80km）：oracle T24 反例的载体。
   *
   * 为什么不用之前的两站 fixture：它的跨度只有约 57km，落在 80km 几何阈值内——
   * 于是「几何档」与「真实档」都不告警，「estimated 被当真实驾驶」这个口径错误
   * 会被「两档都不告警」的巧合完全掩盖（测试绿灯而缺陷仍在）。反例必须让两种
   * 口径给出**相反**结论：95km > 几何 80km 必告警，95km < 自驾 120km 不告警。
   */
  const span95Day: ItineraryDay[] = [{
    date: '2026-10-01',
    stops: [
      { name: '起点', category: 'attraction', coords: { lng: 121.00, lat: 31.00, sys: 'GCJ02' }, intelRefs: ['s1'] },
      { name: '远端景点', category: 'attraction', coords: { lng: 121.95, lat: 31.10, sys: 'GCJ02' }, intelRefs: ['s2'] },
    ],
    meals: [],
  }]
  const span95Stops = (): Map<ItineraryStop, string> => new Map([
    [span95Day[0].stops[0], 'p1'],
    [span95Day[0].stops[1], 'p2'],
  ])

  it('pace=relaxed 且已有 route-transport estimated（跨度约 95km）→ 仍是几何口径：不得当真实驾驶、不得吞掉跨度告警', async () => {
    // oracle T24 反例：匹配的 driving/estimated leg 曾被 bindDayDriving 当「可绑定真实距离」，
    // 于是约 95km 的几何跨度被贴上「数据=真实驾驶距离」（95 < relaxed 自驾阈值 120km → 不告警），
    // 既给几何量贴了真实渠道标签，又吞掉当天本应发出的跨度告警（95 > 几何阈值 80km）。
    const detail = await runRouteCheck(span95Day, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: span95Stops(),
      routeTransport: [{
        id: 'leg-0', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
        mode: 'driving', status: 'estimated', distanceKm: 95, estimateReason: '仅直线估算',
        observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    // 跨度确实超阈值（守住反例前提，避免测试因 fixture 失真而空转）。
    expect(detail.daySpansKm[0].spanKm).toBeGreaterThan(80)
    expect(detail.issues).toEqual([])
    // ① estimated 绝不进入「真实驾驶距离」口径。
    expect(detail.warnings.some((w) => w.includes('真实驾驶距离'))).toBe(false)
    // ② 有限几何阈值 80km 仍然生效：约 95km 跨度必须告警（不被 estimated 吞掉）。
    const spanWarn = detail.warnings.find((w) => w.includes('超过阈值'))
    expect(spanWarn).toBeDefined()
    expect(spanWarn).toContain('直线估算')
    expect(spanWarn).not.toContain('Infinity')
    expect(detail.segments[0]?.source).toBe('estimate')
  })

  it('同端点同距离：queried 走真实档（95km < 120km 不告警），estimated 走几何档（95km > 80km 必告警）', async () => {
    const base = {
      pace: 'relaxed' as const,
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: span95Stops(),
    }
    // 口径互斥的决定性对照：同一份 span95Day + 同一个 95km，仅 status 不同 → 结论必须不同。
    const queried = await runRouteCheck(span95Day, {
      ...base,
      routeTransport: [{
        id: 'leg-0', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
        mode: 'driving', status: 'queried', distanceKm: 95, observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    expect(queried.warnings.filter((w) => w.includes('超过'))).toEqual([]) // 真实档 95 < 120
    const estimated = await runRouteCheck(span95Day, {
      ...base,
      routeTransport: [{
        id: 'leg-0', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
        mode: 'driving', status: 'estimated', distanceKm: 95, estimateReason: '仅直线估算',
        observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    expect(estimated.warnings.filter((w) => w.includes('超过阈值'))).toHaveLength(1) // 几何档 95 > 80
    expect(estimated.warnings.some((w) => w.includes('真实驾驶距离'))).toBe(false)
  })

  it('route-transport blocked → 保留真实不可达 issue，不被自适应阈值吞掉', async () => {
    const detail = await runRouteCheck(normalHangzhouDays, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      routeTransport: [{
        id: 'leg-blocked', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
        mode: 'driving', status: 'blocked', estimateReason: '关键路段不可达',
        observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    expect(detail.issues.some((issue) => issue.includes('不可达'))).toBe(true)
  })

  it('无关 driving estimated 旁车不得吞掉极大跨度告警', async () => {
    const extreme: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: '近端', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: ['e1'] },
        { name: '极远端', category: 'attraction', coords: { lng: 130, lat: 36, sys: 'GCJ02' }, intelRefs: ['e2'] },
      ],
      meals: [],
    }]
    const detail = await runRouteCheck(extreme, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      routeTransport: [{
        id: 'unrelated-estimated', fromPlaceId: 'other-a', toPlaceId: 'other-b', orderIndex: 99,
        placesVersion: 1, mode: 'driving', status: 'estimated', estimateReason: '其他路线的直线估算',
        observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    const spanWarning = detail.warnings.find((warning) => warning.includes('超过阈值'))
    expect(spanWarning).toBeDefined()
    expect(spanWarning).not.toContain('Infinity')
  })

  it.each(['walking', 'transit'] as const)('%s 旁车即使 queried 也不得取消极大跨度告警', async (mode) => {
    const extreme: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: '近端', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: ['w1'] },
        { name: '极远端', category: 'attraction', coords: { lng: 130, lat: 36, sys: 'GCJ02' }, intelRefs: ['w2'] },
      ],
      meals: [],
    }]
    const detail = await runRouteCheck(extreme, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      routeTransport: [{
        id: `${mode}-leg`, fromPlaceId: `${mode}-a`, toPlaceId: `${mode}-b`, orderIndex: 0,
        placesVersion: 1, mode, status: 'queried', distanceKm: 1000,
        observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    expect(detail.warnings.some((warning) => warning.includes('超过阈值'))).toBe(true)
  })

  it('driving 旁车部分覆盖或合法距离无绑定时仍保留跨度告警', async () => {
    const extreme: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: '近端', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: ['p1'] },
        { name: '极远端', category: 'attraction', coords: { lng: 130, lat: 36, sys: 'GCJ02' }, intelRefs: ['p2'] },
      ],
      meals: [],
    }]
    const detail = await runRouteCheck(extreme, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      routeTransport: [
        {
          id: 'queried-unbound', fromPlaceId: 'other-a', toPlaceId: 'other-b', orderIndex: 0,
          placesVersion: 1, mode: 'driving', status: 'queried', distanceKm: 120,
          observedAt: '2026-09-09T00:00:00.000Z',
        },
        {
          id: 'unavailable-tail', fromPlaceId: 'other-b', toPlaceId: 'other-c', orderIndex: 1,
          placesVersion: 1, mode: 'driving', status: 'unavailable', estimateReason: '旁车渠道失败',
          observedAt: '2026-09-09T00:00:00.000Z',
        },
      ],
    })
    expect(detail.warnings.some((warning) => warning.includes('超过阈值'))).toBe(true)
    expect(detail.warnings.some((warning) => warning.includes('路线旁车不可用'))).toBe(true)
  })

  /**
   * T24 真实驾驶距离绑定：只有「明确 driving + queried/estimated + 有限非负
   * distanceKm + orderIndex 与当天段一致 + 两端 placeId 与 stop 归属一致 +
   * 当天相邻段全覆盖」才改用实际驾驶里程比较；否则回退有限放宽的几何阈值。
   */
  const boundDay: ItineraryDay[] = [{
    date: '2026-10-01',
    stops: [
      { name: '起点', category: 'attraction', coords: { lng: 121.00, lat: 31.00, sys: 'GCJ02' }, intelRefs: ['b1'] },
      { name: '终点', category: 'attraction', coords: { lng: 121.55, lat: 31.20, sys: 'GCJ02' }, intelRefs: ['b2'] },
    ],
    meals: [],
  }]

  const boundStops = (): Map<ItineraryStop, string> => new Map([
    [boundDay[0].stops[0], 'place-a'],
    [boundDay[0].stops[1], 'place-b'],
  ])

  const drivingLeg = (over: Partial<RouteTransportLeg> = {}): RouteTransportLeg => ({
    id: 'leg-0', fromPlaceId: 'place-a', toPlaceId: 'place-b', orderIndex: 0, placesVersion: 1,
    mode: 'driving', status: 'queried', distanceKm: 60, observedAt: '2026-09-09T00:00:00.000Z', ...over,
  })

  it('实际驾驶里程（可达长程，绑定完整）→ 无单日硬伤误报', async () => {
    const detail = await runRouteCheck(boundDay, {
      pace: 'balanced',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: boundStops(),
      // 直线约 57km > balanced 估算阈值 100? 否；故用 150km 真实里程验证「实距口径生效」。
      routeTransport: [drivingLeg({ distanceKm: 150 })],
    })
    expect(detail.issues).toEqual([])
    expect(detail.warnings.some((w) => w.includes('超过' ))).toBe(false)
  })

  it('实际驾驶里程超自驾阈值 → warning 且标注「真实驾驶距离」', async () => {
    const detail = await runRouteCheck(boundDay, {
      pace: 'balanced',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: boundStops(),
      routeTransport: [drivingLeg({ distanceKm: 400 })],
    })
    const warn = detail.warnings.find((w) => w.includes('超过'))
    expect(warn).toBeDefined()
    expect(warn).toContain('真实驾驶距离')
    expect(warn).toContain('400')
    expect(warn).not.toContain('Infinity')
  })

  it('实距口径按 pace 取阈值：relaxed 允许更大自驾里程', async () => {
    const legs = [drivingLeg({ distanceKm: 330 })]
    const relaxed = await runRouteCheck(boundDay, {
      pace: 'relaxed', providers: [createEstimateRouteProvider()], stopPlaceIds: boundStops(), routeTransport: legs,
    })
    // relaxed 自驾阈值 250km → 330km 应告警；balanced 阈值 350km → 不告警。
    expect(relaxed.warnings.some((w) => w.includes('真实驾驶距离'))).toBe(true)
    const balanced = await runRouteCheck(boundDay, {
      pace: 'balanced', providers: [createEstimateRouteProvider()], stopPlaceIds: boundStops(), routeTransport: legs,
    })
    expect(balanced.warnings.some((w) => w.includes('真实驾驶距离'))).toBe(false)
  })

  it('部分覆盖 → 回退几何阈值（不把部分旁车当完整驾驶证据）', async () => {
    const threeStop: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: 's1', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
        { name: 's2', category: 'attraction', coords: { lng: 130, lat: 36, sys: 'GCJ02' }, intelRefs: [] },
        { name: 's3', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
      ],
      meals: [],
    }]
    const stops = threeStop[0].stops
    const detail = await runRouteCheck(threeStop, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: new Map([[stops[0], 'p1'], [stops[1], 'p2'], [stops[2], 'p1']]),
      // 只覆盖第 0 段；第 1 段（p2→p1）无旁车 → 不得判定为完整覆盖。
      routeTransport: [drivingLeg({ id: 'leg-0', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, distanceKm: 900 })],
    })
    const warn = detail.warnings.find((w) => w.includes('超过'))
    expect(warn).toBeDefined()
    expect(warn).toContain('直线估算')
    expect(warn).not.toContain('真实驾驶距离')
  })

  it('orderIndex 错位 / 端点无法归属 → 回退几何阈值（有限值，绝不 Infinity）', async () => {
    const extreme: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: '近端', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
        { name: '极远端', category: 'attraction', coords: { lng: 130, lat: 36, sys: 'GCJ02' }, intelRefs: [] },
      ],
      meals: [],
    }]
    const stops = extreme[0].stops
    // T24 修订后 orderIndex 不再是「唯一候选」场景的否决条件（同一端点对只有一条
    // leg 时腿号由 leg 自身权威；见 bindDayDriving），故「错位」反例改为真正的
    // 不可绑定形态：端点无法归属（leg 端点与 stop 归属的 placeId 不一致）。
    for (const legs of [
      [drivingLeg({ fromPlaceId: 'other', toPlaceId: 'place-b', distanceKm: 5 })],
      [drivingLeg({ fromPlaceId: 'place-a', toPlaceId: 'thing', distanceKm: 5 })],
      [drivingLeg({ fromPlaceId: 'other', toPlaceId: 'thing', distanceKm: 5 })],
    ]) {
      const detail = await runRouteCheck(extreme, {
        pace: 'relaxed',
        providers: [createEstimateRouteProvider()],
        stopPlaceIds: new Map([[stops[0], 'place-a'], [stops[1], 'place-b']]),
        routeTransport: legs,
      })
      const warn = detail.warnings.find((w) => w.includes('超过'))
      expect(warn).toBeDefined()
      expect(warn).toContain('直线估算')
      expect(warn).not.toContain('真实驾驶距离')
      expect(warn).not.toContain('Infinity')
    }
  })

  /**
   * T24 跨日绑定回归（oracle P1）：selectedSequence 会把重访顶点折叠成一份，而
   * draft 按日拆分时同一地点会在多天重复出现——「当天第 i 段」无法由每日站数稳定
   * 推算，本地序号必然跨日偏移。此前的实现用这个本地序号否决权威腿号，导致正确
   * 的长程联程段被系统性拒绝、真实里程超限不告警（false acceptance）。
   */
  const crossDay: ItineraryDay[] = [
    {
      date: '2026-10-01',
      stops: [
        { name: 'A', category: 'attraction', coords: { lng: 116.40, lat: 39.90, sys: 'GCJ02' }, intelRefs: [] },
        { name: 'B', category: 'attraction', coords: { lng: 116.60, lat: 40.05, sys: 'GCJ02' }, intelRefs: [] },
      ],
      meals: [],
    },
    {
      date: '2026-10-02',
      stops: [
        { name: 'C', category: 'attraction', coords: { lng: 117.20, lat: 40.30, sys: 'GCJ02' }, intelRefs: [] },
        { name: 'D', category: 'attraction', coords: { lng: 118.80, lat: 41.60, sys: 'GCJ02' }, intelRefs: [] },
      ],
      meals: [],
    },
  ]
  const crossDayBindings = (): Map<ItineraryStop, string> => new Map([
    [crossDay[0].stops[0], 'pa'], [crossDay[0].stops[1], 'pb'],
    [crossDay[1].stops[0], 'pc'], [crossDay[1].stops[1], 'pd'],
  ])
  const crossDayLeg = (over: Partial<RouteTransportLeg> = {}): RouteTransportLeg => ({
    id: 'leg-2-pc-pd', fromPlaceId: 'pc', toPlaceId: 'pd', orderIndex: 2, placesVersion: 1,
    mode: 'driving', status: 'queried', distanceKm: 360, observedAt: '2026-09-09T00:00:00.000Z', ...over,
  })

  it('跨日绑定：D2=[C,D] 的 route leg orderIndex=2 不被本地序号偏移拒绝（balanced 真实里程超限必告警）', async () => {
    const detail = await runRouteCheck(crossDay, {
      pace: 'balanced',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: crossDayBindings(),
      routeTransport: [crossDayLeg()],
    })
    const warn = detail.warnings.find((w) => w.includes('超过'))
    expect(warn).toBeDefined()
    expect(warn).toContain('真实驾驶距离')
    expect(warn).toContain('360')
    expect(warn).toContain('覆盖 1/1 段')
    expect(warn).not.toContain('Infinity')
  })

  it('跨日绑定：两天全覆盖（leg 0 与 leg 2）→ 各自用真实里程口径，阈值内不误报', async () => {
    const detail = await runRouteCheck(crossDay, {
      pace: 'balanced',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: crossDayBindings(),
      routeTransport: [
        crossDayLeg({ id: 'leg-0-pa-pb', fromPlaceId: 'pa', toPlaceId: 'pb', orderIndex: 0, distanceKm: 300 }),
        crossDayLeg(),
      ],
    })
    // D1=300km 在 balanced 自驾阈值内 → 不告警；D2=360km 超限 → 告警且标注真实里程。
    const warns = detail.warnings.filter((w) => w.includes('超过'))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('第2天')
    expect(warns[0]).toContain('真实驾驶距离')
  })

  it('跨日部分覆盖（只有 D2 有旁车）→ D1 回退几何档，D2 仍走真实里程档', async () => {
    const detail = await runRouteCheck(crossDay, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: crossDayBindings(),
      routeTransport: [crossDayLeg({ distanceKm: 260 })],
    })
    const d1 = detail.warnings.find((w) => w.includes('第1天'))
    const d2 = detail.warnings.find((w) => w.includes('第2天'))
    // relaxed 几何阈值 80km：D1 直线约 21km 不告警；D2 真实 260km > relaxed 自驾 250km。
    expect(d1).toBeUndefined()
    expect(d2).toContain('真实驾驶距离')
  })

  it('重复访问/同一端点对多候选 → 仍须 orderIndex 精确匹配，指认不出即回退（不误绑）', async () => {
    // 同日三段：X→Y→X（重访），只有两条 X→Y 同端点候选，序号口径不同时不得猜。
    const loopDay: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: 'X', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
        { name: 'Y', category: 'attraction', coords: { lng: 122, lat: 32, sys: 'GCJ02' }, intelRefs: [] },
        { name: 'X2', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
      ],
      meals: [],
    }]
    const [x, y, x2] = loopDay[0].stops
    const bindings = new Map<ItineraryStop, string>([[x, 'px'], [y, 'py'], [x2, 'px']])
    const twoOutbound: RouteTransportLeg[] = [
      crossDayLeg({ id: 'leg-0-px-py', fromPlaceId: 'px', toPlaceId: 'py', orderIndex: 0, distanceKm: 900 }),
      crossDayLeg({ id: 'leg-2-px-py', fromPlaceId: 'px', toPlaceId: 'py', orderIndex: 2, distanceKm: 900 }),
    ]
    // 段 0（X→Y, 本地序 0）能精确指认 leg 0；段 1（Y→X2）无任何候选 → 整体不可绑定。
    const partial = await runRouteCheck(loopDay, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: bindings,
      routeTransport: [twoOutbound[0]],
    })
    const partialWarn = partial.warnings.find((w) => w.includes('超过'))
    expect(partialWarn).toContain('直线估算')
    expect(partialWarn).not.toContain('真实驾驶距离')

    // 段 0 的本地序被刻意设成 2（与候选 leg 的 0/2 都不同）→ 多候选下无法指认 → 回退。
    const shifted = await runRouteCheck(loopDay, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: bindings,
      routeTransport: [twoOutbound[1]],
    })
    const shiftedWarn = shifted.warnings.find((w) => w.includes('超过'))
    expect(shiftedWarn).toContain('直线估算')
    expect(shiftedWarn).not.toContain('真实驾驶距离')
    expect(shiftedWarn).not.toContain('Infinity')
  })

  it('跨日无关旁车（端点归属不到当天任一 stop）→ 不影响其它日的几何档判定', async () => {
    const unrelated: RouteTransportLeg[] = [
      crossDayLeg({ id: 'leg-9-px-py', fromPlaceId: 'other-a', toPlaceId: 'other-b', orderIndex: 9, distanceKm: 900 }),
    ]
    const detail = await runRouteCheck(crossDay, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: crossDayBindings(),
      routeTransport: unrelated,
    })
    // relaxed 几何阈值 80km：D2 直线约 197km → 几何档告警，且绝不采纳无关旁车里程。
    const warn = detail.warnings.find((w) => w.includes('第2天'))
    expect(warn).toContain('直线估算')
    expect(warn).not.toContain('真实驾驶距离')
    expect(warn).not.toContain('Infinity')
  })

  it('无绑定表（stop 未归属 places）→ 几何档；walking/unavailable/无距离 → 几何档', async () => {
    const stops = boundDay[0].stops
    const cases: Array<{ label: string; opts: Record<string, unknown> }> = [
      { label: '无绑定表', opts: { routeTransport: [drivingLeg({ distanceKm: 5 })] } },
      { label: 'walking', opts: { stopPlaceIds: boundStops(), routeTransport: [drivingLeg({ mode: 'walking', distanceKm: 5 })] } },
      { label: 'unavailable', opts: { stopPlaceIds: boundStops(), routeTransport: [drivingLeg({ status: 'unavailable', distanceKm: undefined })] } },
      { label: '距离非有限', opts: { stopPlaceIds: boundStops(), routeTransport: [drivingLeg({ distanceKm: Number.NaN })] } },
      { label: '距离为负', opts: { stopPlaceIds: boundStops(), routeTransport: [drivingLeg({ distanceKm: -3 })] } },
      { label: 'blocked', opts: { stopPlaceIds: boundStops(), routeTransport: [drivingLeg({ status: 'blocked', distanceKm: undefined })] } },
    ]
    const far: ItineraryDay[] = [{
      date: '2026-10-01',
      stops: [
        { name: '近端', category: 'attraction', coords: { lng: 121, lat: 31, sys: 'GCJ02' }, intelRefs: [] },
        { name: '极远端', category: 'attraction', coords: { lng: 130, lat: 36, sys: 'GCJ02' }, intelRefs: [] },
      ],
      meals: [],
    }]
    for (const { label, opts } of cases) {
      const useFar = label !== '无绑定表'
      const days = useFar ? far : boundDay
      const override = label === '无绑定表'
        ? opts
        : { ...opts, stopPlaceIds: new Map([[days[0].stops[0], 'place-a'], [days[0].stops[1], 'place-b']]) }
      const detail = await runRouteCheck(days, {
        pace: 'relaxed', providers: [createEstimateRouteProvider()], ...override,
      })
      if (useFar) {
        const warn = detail.warnings.find((w) => w.includes('超过'))
        expect(warn, label).toBeDefined()
        expect(warn, label).toContain('直线估算')
        expect(warn, label).not.toContain('真实驾驶距离')
        expect(warn, label).not.toContain('Infinity')
      } else {
        expect(detail.warnings.some((w) => w.includes('真实驾驶距离')), label).toBe(false)
      }
    }
    void stops
  })

  it('显式 daySpanWarnKm 保持几何口径（不被旁车改写成自驾阈值）', async () => {
    const detail = await runRouteCheck(boundDay, {
      daySpanWarnKm: 20,
      providers: [createEstimateRouteProvider()],
      stopPlaceIds: boundStops(),
      routeTransport: [drivingLeg({ distanceKm: 60 })],
    })
    expect(detail.warnings.some((w) => w.includes('超过阈值 20km'))).toBe(true)
    expect(detail.warnings.some((w) => w.includes('真实驾驶距离'))).toBe(false)
  })

  it('blocked 与 A→B→A 折返 issue 独立保留', async () => {
    const detail = await runRouteCheck(backtrackDays, {
      pace: 'relaxed',
      providers: [createEstimateRouteProvider()],
      routeTransport: [{
        id: 'blocked-return', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
        mode: 'driving', status: 'blocked', estimateReason: '关键路段不可达',
        observedAt: '2026-09-09T00:00:00.000Z',
      }],
    })
    expect(detail.issues.some((issue) => issue.includes('不可达'))).toBe(true)
    expect(detail.issues.some((issue) => issue.includes('跨城折返'))).toBe(true)
  })
})

// ────────────────────────── live smoke（真实 key + 网络；缺省 skip） ──────────────────────────

const liveEnabled = process.env.TRAVEL_LIVE_SMOKE === '1'

describe.skipIf(!liveEnabled)('route-check live smoke（TRAVEL_LIVE_SMOKE=1；真实 key/网络留证，网络受限登记降级链）', () => {
  it('杭州 3 日真实动线 → 渠道链/降级说明留证', async () => {
    const keyEnv = await liveCredentialsEnv(['amapWebservice'])
    const providers: RouteMeasureProvider[] = [
      createAmapRouteProvider(new AmapAdapter()),
      createTencentRouteProvider(new TencentMapAdapter()),
      createEstimateRouteProvider(),
    ]
    const days: ItineraryDay[] = [
      {
        date: '2026-10-01',
        stops: [
          { name: '西湖', category: 'attraction', coords: { lng: 120.15, lat: 30.25, sys: 'GCJ02' }, durationHint: 180, intelRefs: ['h1'] },
          { name: '灵隐寺', category: 'attraction', coords: { lng: 120.102, lat: 30.240, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['h2'] },
        ],
        meals: [],
      },
      {
        date: '2026-10-02',
        stops: [
          { name: '河坊街', category: 'food', coords: { lng: 120.176, lat: 30.241, sys: 'GCJ02' }, durationHint: 60, intelRefs: ['h3'] },
          { name: '西溪湿地', category: 'attraction', coords: { lng: 120.060, lat: 30.269, sys: 'GCJ02' }, durationHint: 150, intelRefs: ['h4'] },
        ],
        meals: [],
      },
      {
        date: '2026-10-03',
        stops: [
          { name: '宋城', category: 'attraction', coords: { lng: 120.117, lat: 30.185, sys: 'GCJ02' }, durationHint: 180, intelRefs: ['h5'] },
          { name: '九溪烟树', category: 'attraction', coords: { lng: 120.104, lat: 30.193, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['h6'] },
        ],
        meals: [],
      },
    ]
    const detail = await runRouteCheck(days, { providers, keyEnv })
    const summary = {
      channelsUsed: detail.channelsUsed,
      degraded: detail.degraded,
      issues: detail.issues,
      warnings: detail.warnings,
      daySpansKm: detail.daySpansKm,
      segments: detail.segments.map((s) => ({ distanceKm: s.distanceKm, durationMinutes: s.durationMinutes, source: s.source, note: s.note })),
    }
    // eslint-disable-next-line no-console
    console.log(`[route-check live] ${JSON.stringify(summary, null, 2)}`)
    expect(detail.channelsUsed.length).toBeGreaterThan(0)
    expect(detail.segments.length).toBeGreaterThan(0)
  })
})