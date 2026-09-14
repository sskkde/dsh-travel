import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { autoProposeItinerary } from '../src/tools/build-itinerary.js'
import { canonicalRouteFromDays } from '../src/route-check.js'
import { validateItinerary } from '../src/models/validate.js'
import type { IntelItem, Itinerary, PlacesArtifact } from '../src/models/types.js'

function fixture(): PlacesArtifact {
  return JSON.parse(readFileSync(new URL('./fixtures/round3/t5-10day-route.json', import.meta.url), 'utf8')) as PlacesArtifact
}

function intelForFixture(places: PlacesArtifact): IntelItem[] {
  return places.places.filter((place) => place.kind === 'attraction').map((place) => ({
    id: `intel-${place.candidateId}`,
    category: 'attraction',
    channel: 'fixture',
    title: place.name,
    summary: `fixture ${place.name}`,
    source: { platform: 'fixture', url: 'https://example.invalid/t5', fetchedAt: '2026-09-12T00:00:00.000Z' },
    coords: place.coords,
    confidence: 'high',
  }))
}

describe('W3/T5 最终路线锚点', () => {
  it('10 天自动提案含 9 个连续零断点日界，且 canonical route 无 A→A 边', () => {
    const places = fixture()
    const result = autoProposeItinerary('t5-10day', {
      destination: 'fixture', dateStart: '2026-10-01', dateEnd: '2026-10-10', days: 10,
    }, intelForFixture(places), { places })
    expect(result.built).toBe(true)
    expect(result.days).toHaveLength(10)
    for (let i = 1; i < result.days.length; i++) {
      expect(result.days[i - 1]?.stops.at(-1)?.placeId)
        .toBe(result.days[i]?.stops[0]?.placeId)
    }
    expect(result.days[0]?.stops[0]?.anchorRole).toBe('arrival')
    expect(result.days.at(-1)?.stops.at(-1)?.anchorRole).toBe('departure')
    const route = canonicalRouteFromDays(result.days)
    expect(route.edges.every((edge) => edge.fromOccurrenceId !== edge.toOccurrenceId)).toBe(true)
    expect(validateItinerary({
      schemaVersion: 2, itineraryId: result.itineraryId, days: result.days,
      canonicalRoute: route, routeCheck: result.routeCheck,
    } as Itinerary)).toEqual([])
  })

  it('旧行程明确要求未解析的茶卡镇住宿时阻断，不用茶卡盐湖景区替代', () => {
    const places = fixture()
    const previous: Itinerary = {
      itineraryId: 'previous',
      days: Array.from({ length: 10 }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, '0')}`,
        stops: [], meals: [],
        ...(index === 1 ? { lodgingArea: '茶卡镇' } : {}),
      })),
    }
    const result = autoProposeItinerary('t5-missing-anchor', {
      destination: 'fixture', dateStart: '2026-10-01', dateEnd: '2026-10-10', days: 10,
    }, intelForFixture(places), { places, previous })
    expect(result.built).toBe(false)
    expect(result.blocked?.reason).toContain('茶卡镇')
    expect(result.blocked?.reason).toContain('不能用景区点位替代住宿')
    expect(result.blocked?.nextAction).toMatch(/resolve_places/)
  })
})
