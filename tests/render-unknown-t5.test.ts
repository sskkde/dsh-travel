import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { buildRenderData } from '../src/render/render.js'
import { canonicalRouteFromDays } from '../src/route-check.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-render-unknown-'))
  store = new TravelStore(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function plan(): Promise<string> {
  const result = await runIntake({
    slots: { origin: '北京', destination: '测试地', dateStart: '2026-10-01', dateEnd: '2026-10-01', days: 1 },
  }, store)
  return result.planId
}

const itinerary = {
  itineraryId: 'unknown-itinerary',
  days: [{ date: '2026-10-01', stops: [{ name: '测试点', category: 'attraction', coords: { lng: 100, lat: 30, sys: 'GCJ02' }, intelRefs: ['intel-1'] }], meals: [] }],
  routeCheck: { issues: [], warnings: [] },
}

describe('W3/T5 unknown artifact read compatibility', () => {
  it('consumes unaccounted itinerary/intel and emits unknown degradation evidence', async () => {
    const planId = await plan()
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'research-state.json', data: { researchVersion: 1 } }], inputFingerprint: 'research',
    })
    await store.writeJson(planId, 'itinerary.json', itinerary)
    await store.writeJson(planId, 'intel.json', [{
      id: 'intel-1', category: 'attraction', channel: 'fixture', title: '测试点', summary: 'must be redacted',
      source: { platform: 'fixture', url: 'https://example.invalid', fetchedAt: '2026-10-01T00:00:00.000Z' }, confidence: 'high',
    }])
    const result = await buildRenderData(store, planId)
    expect(result.data).toBeDefined()
    expect(result.data?.intel['intel-1']).toBeDefined()
    expect(result.data?.artifactStatus?.itinerary?.state).toBe('unknown')
    expect(result.data?.degraded.some((entry) => entry.source === 'artifact:itinerary.json' && entry.reason.includes('unknown'))).toBe(true)
    expect(result.data?.degraded.some((entry) => entry.source === 'artifact:intel.json' && entry.reason.includes('unknown'))).toBe(true)
  })

  it('blocks an unaccounted file when the manifest signs the same artifact stage', async () => {
    const planId = await plan()
    await store.publishArtifacts(planId, {
      stage: 'itinerary', files: [{ name: 'other.json', data: { ok: true } }], inputFingerprint: 'itinerary',
    })
    await store.writeJson(planId, 'itinerary.json', itinerary)
    const result = await buildRenderData(store, planId)
    expect(result.data).toBeUndefined()
    expect(result.reason).toContain('itinerary.json')
  })

  it('attaches only a route artifact matching the final canonical fingerprint and exposes totals', async () => {
    const planId = await plan()
    const day = {
      date: '2026-10-01',
      stops: [
        { name: 'A', category: 'attraction' as const, placeId: 'place-a', occurrenceId: 'occ-a', anchorRole: 'arrival' as const, intelRefs: [] },
        { name: 'B', category: 'attraction' as const, placeId: 'place-b', occurrenceId: 'occ-b', anchorRole: 'departure' as const, intelRefs: [] },
      ],
      meals: [],
    }
    const canonical = canonicalRouteFromDays([day])
    const currentItinerary = { itineraryId: 'final', schemaVersion: 2, days: [day], canonicalRoute: canonical, routeCheck: { issues: [], warnings: [] } }
    const route = {
      schemaVersion: 2, placesVersion: 1, inputFingerprint: canonical.fingerprint, generatedAt: '2026-10-01T00:00:00.000Z',
      legs: [{
        id: 'leg-0', fromPlaceId: 'place-a', toPlaceId: 'place-b', orderIndex: 0, placesVersion: 1, mode: 'driving' as const,
        status: 'queried' as const, metricStatus: 'queried' as const, geometryStatus: 'queried' as const,
        distanceKm: 10, durationMinutes: 20, observedAt: '2026-10-01T00:00:00.000Z',
        geometry: { type: 'LineString' as const, coordinates: [[100, 30], [100.1, 30.1]] as [number, number][], source: 'fixture', coordinateSystem: 'WGS84' as const, pointOrder: 'lng,lat' as const },
        source: { platform: 'fixture', url: 'https://example.invalid/route', fetchedAt: '2026-10-01T00:00:00.000Z' },
      }],
      totalDistanceKm: 10, totalDurationMinutes: 20, degraded: [],
    }
    await store.publishArtifacts(planId, {
      stage: 'itinerary', files: [{ name: 'itinerary.json', data: currentItinerary }, { name: 'route-transport.json', data: route }], inputFingerprint: canonical.fingerprint,
    })
    const result = await buildRenderData(store, planId)
    expect(result.data?.routeTransport?.fingerprint).toBe(canonical.fingerprint)
    expect(result.data?.routeTransport?.legs).toHaveLength(1)
    expect(result.data?.totalDistanceKm).toBe(10)
    expect(result.data?.totalDurationMinutes).toBe(20)
  })
})
