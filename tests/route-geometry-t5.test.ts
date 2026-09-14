import { describe, expect, it } from 'vitest'
import { AmapAdapter, gcj02ToWgs84, normalizeAmapDrivingRoute } from '../src/adapters/amap.js'
import { TencentMapAdapter, decodeTencentPolyline, normalizeTencentDrivingRoute } from '../src/adapters/tencent.js'
import { createAmapLegProvider, createTencentLegProvider } from '../src/tools/route-transport.js'
import type { GeoCoords } from '../src/models/types.js'

const origin: GeoCoords = { lng: 116.404, lat: 39.915, sys: 'GCJ02' }
const destination: GeoCoords = { lng: 116.405, lat: 39.916, sys: 'GCJ02' }

function response(body: unknown): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

describe('W3/T5 host route geometry normalization', () => {
  it('GCJ02 inverse keeps WGS84 [lng,lat] order and six-decimal precision', () => {
    const point = gcj02ToWgs84(origin.lng, origin.lat)
    expect(point).toHaveLength(2)
    expect(point[0]).not.toBe(origin.lng)
    expect(point[1]).not.toBe(origin.lat)
    expect(point.every((value) => Number(String(value).split('.')[1] ?? '').toString().length <= 6)).toBe(true)
  })

  it('AMap driving route converts step polylines and preserves meters/seconds conversion', () => {
    const route = normalizeAmapDrivingRoute({
      paths: [{ distance: '1234', duration: '601', steps: [
        { polyline: '116.404,39.915;116.4045,39.9155' },
        { polyline: '116.4045,39.9155;116.405,39.916' },
      ] }],
    })
    expect(route?.distanceMeters).toBe(1234)
    expect(route?.durationMinutes).toBe(10)
    expect(route?.geometry).toMatchObject({
      type: 'LineString', coordinateSystem: 'WGS84', pointOrder: 'lng,lat', source: 'amap-direction',
    })
    expect(route?.geometry?.coordinates[0]).toHaveLength(2)
    expect(route?.geometry?.coordinates[0]?.[0]).not.toBe(116.404)
  })

  it('Tencent decoder uses lat/lng 1e6 forward differences, not Google E5', () => {
    const raw = [36 * 1e6, 101 * 1e6, 123456, -234567, -34567, 45678]
    const points = decodeTencentPolyline(raw)
    expect(points).toHaveLength(3)
    expect(points[0]?.[0]).toBeCloseTo(gcj02ToWgs84(101, 36)[0], 6)
    expect(points[1]?.[0]).toBeCloseTo(gcj02ToWgs84(100.765433, 36.123456)[0], 6)
    expect(points[1]?.[1]).toBeCloseTo(gcj02ToWgs84(100.765433, 36.123456)[1], 6)
    expect(points[0]?.[0]).not.toBeCloseTo(101.000123, 3)
  })

  it('adapter providers expose geometry independently from queried metrics', async () => {
    const amap = new AmapAdapter({
      fetchFn: async () => response({ status: '1', route: { paths: [{ distance: '5000', duration: '600', steps: [{ polyline: '116.404,39.915;116.405,39.916' }] }] } }),
    })
    const amapResult = await createAmapLegProvider(amap).measure([{ id: 'amap-leg', fromCoords: origin, toCoords: destination }], { env: { amapWebservice: 'fixture-key' } })
    expect(amapResult[0]?.metricStatus).toBe('queried')
    expect(amapResult[0]?.geometryStatus).toBe('queried')
    expect(amapResult[0]?.geometry?.pointOrder).toBe('lng,lat')

    const tencent = new TencentMapAdapter({
      httpCall: async () => response({ status: 0, result: { routes: [{ distance: 5000, duration: 600, polyline: [36 * 1e6, 101 * 1e6, 1000, 1000] }] } }),
    })
    const tencentResult = await createTencentLegProvider(tencent).measure([{ id: 'tencent-leg', fromCoords: origin, toCoords: destination }])
    expect(tencentResult[0]?.metricStatus).toBe('queried')
    expect(tencentResult[0]?.geometryStatus).toBe('queried')
    expect(tencentResult[0]?.geometry?.coordinates).toHaveLength(2)
  })

  it('Tencent route normalization keeps metrics when polyline is absent', () => {
    const route = normalizeTencentDrivingRoute({ distance: 42, duration: 60 })
    expect(route).toEqual({ distanceMeters: 42, durationMinutes: 1 })
  })
})
