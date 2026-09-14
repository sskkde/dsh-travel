/**
 * W0/T1 round3 contract tests：schema/validator/versioned manifest 的冻结闸门。
 * 这些测试只覆盖本轮允许落地的契约与存储层，不要求 W1–W5 业务行为。
 */
import * as fsPromises from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyVersion,
  isValidRouteGeometry,
  validateCostArtifact,
  validateInsights,
  validateIntelItem,
  validateItinerary,
  validateRouteGeometry,
  validateRouteTransportArtifact,
  validateRouteTransportLeg,
} from '../src/models/validate.js'
import { COST_COMPONENT_KEYS, type CostArtifact, type IntelItem, type Itinerary, type RouteGeometry } from '../src/models/types.js'
import { TravelStore } from '../src/store/store.js'
import { GET_STATE_OUTPUT_SCHEMA, projectState, type GetStateResult } from '../src/tools/state.js'
import { valueSchemaSpecToJsonSchema, validateJsonSchemaValue, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-round3-contract-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const source = { platform: 'fixture', url: 'https://example.invalid/source', fetchedAt: '2026-09-12T00:00:00.000Z' }
const geometry: RouteGeometry = {
  type: 'LineString', coordinates: [[101, 36], [102, 37]], source: 'fixture',
  coordinateSystem: 'WGS84', pointOrder: 'lng,lat',
}

function stop(placeId: string, occurrenceId: string, anchorRole: 'arrival' | 'lodging' | 'stop' | 'departure', name = placeId) {
  return {
    placeId, occurrenceId, anchorRole, name, category: 'attraction' as const,
    coords: { lng: 101, lat: 36, sys: 'GCJ02' as const }, durationHint: 30, intelRefs: [`intel-${placeId}`],
  }
}

function modernItinerary(): Itinerary {
  return {
    schemaVersion: 2,
    itineraryId: 'it-round3',
    days: [
      {
        date: '2026-09-15',
        stops: [
          stop('stay', 'stay-start', 'arrival', '住宿'),
          stop('poi-a', 'poi-a-1', 'stop', '景点 A'),
          stop('stay', 'stay-end-1', 'lodging', '住宿'),
        ],
        meals: [],
      },
      {
        date: '2026-09-16',
        stops: [
          stop('stay', 'stay-end-1', 'lodging', '住宿'),
          stop('poi-b', 'poi-b-1', 'stop', '景点 B'),
          stop('depart', 'depart-1', 'departure', '返程'),
        ],
        meals: [],
      },
    ],
    routeCheck: { issues: [], warnings: [] },
    canonicalRoute: {
      schemaVersion: 2,
      fingerprint: 'route-fingerprint',
      nodes: [
        { occurrenceId: 'stay-start', placeId: 'stay', dayIndex: 0, stopIndex: 0 },
        { occurrenceId: 'poi-a-1', placeId: 'poi-a', dayIndex: 0, stopIndex: 1 },
      ],
      edges: [{ id: 'edge-0', fromOccurrenceId: 'stay-start', toOccurrenceId: 'poi-a-1', orderIndex: 0 }],
    },
  }
}

function modernCost(): CostArtifact {
  const component = {
    min: 100, max: 200, currency: 'CNY', unit: 'person', priceRange: [50, 100] as [number, number],
    quantity: 2, quantityBasis: 'people' as const, scope: 'total' as const,
    source: 'fixture', status: 'quoted' as const, assumptions: ['fixture quote'],
  }
  return {
    schemaVersion: 2, placesVersion: 1, inputFingerprint: 'cost-round3', generatedAt: '2026-09-12T00:00:00.000Z',
    currency: 'CNY', components: Object.fromEntries(COST_COMPONENT_KEYS.map((key) => [key, component])) as CostArtifact['components'],
    total: { min: 600, max: 1200, currency: 'CNY' },
    budget: { amount: 2000, scope: 'total', currency: 'CNY' }, warnings: [], assumptions: ['fixture data'],
  }
}

describe('round3 version and geometry contracts', () => {
  it('legacy/missing, supported current, and future versions are classified explicitly', () => {
    expect(classifyVersion({}).compatibility).toBe('legacy')
    expect(classifyVersion({}).readOnly).toBe(true)
    expect(classifyVersion({ schemaVersion: 2 }).compatibility).toBe('current')
    expect(classifyVersion({ schemaVersion: 999 }).compatibility).toBe('unknown')
    expect(classifyVersion({ schemaVersion: '2' }).compatibility).toBe('unknown')
  })

  it('accepts canonical WGS84 LineString and rejects malformed/reversed coordinates', () => {
    expect(isValidRouteGeometry(geometry)).toBe(true)
    expect(validateRouteGeometry(geometry)).toEqual([])
    expect(validateRouteGeometry({ ...geometry, pointOrder: 'lat,lng' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'geometry.pointOrder' }),
    ]))
    expect(validateRouteGeometry({ ...geometry, coordinates: [[36, 101], [37, 102]] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'geometry.coordinates[0]' }),
    ]))
    expect(validateRouteGeometry({ ...geometry, coordinates: [[101, Number.NaN], [102, 37]] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'geometry.coordinates[0]' }),
    ]))
  })

  it('route leg keeps metricStatus and geometryStatus independent', () => {
    const leg = {
      id: 'leg-0', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
      mode: 'driving' as const, status: 'queried' as const, metricStatus: 'queried' as const,
      geometryStatus: 'unavailable' as const, distanceKm: 321.4, durationMinutes: 245,
      observedAt: '2026-09-12T00:00:00.000Z',
    }
    expect(validateRouteTransportLeg(leg, 'leg', true)).toEqual([])
    expect(validateRouteTransportLeg({ ...leg, geometryStatus: 'queried', geometry }, 'leg', true)).toEqual([])
    expect(validateRouteTransportArtifact({
      schemaVersion: 2, placesVersion: 1, inputFingerprint: 'route-round3', generatedAt: '2026-09-12T00:00:00.000Z',
      legs: [leg], degraded: [],
    })).toEqual([])
    expect(validateRouteTransportLeg({ ...leg, geometryStatus: 'queried' }, 'leg', true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'leg.geometry' }),
    ]))
  })
})

describe('round3 state schema contracts', () => {
  it('declares degraded count/placeId/candidateId and preserves them in the projected payload', () => {
    const degraded = Array.from({ length: 21 }, (_, index) => ({
      source: 'fixture', code: 'NOISE' as const, reason: '聚合噪音', at: '2026-09-12T00:00:00.000Z',
      ...(index === 0 ? { count: 20 } : {}),
      ...(index === 20 ? { placeId: 'place-20' } : {}),
      candidateId: `candidate-${index}`,
    }))
    const result: GetStateResult = {
      planId: 'plan-state-schema', found: true, status: 'researching', artifacts: [], degraded,
    }
    const value = projectState(result)
    const degradedSchema = GET_STATE_OUTPUT_SCHEMA.properties.degraded as {
      items: { properties: Record<string, unknown> }
    }
    for (const key of ['count', 'placeId', 'candidateId']) {
      expect(degradedSchema.items.properties[key]).toBeDefined()
    }
    const compiledSchema = valueSchemaSpecToJsonSchema(GET_STATE_OUTPUT_SCHEMA as unknown as ValueSchemaSpec)
    expect(validateJsonSchemaValue(compiledSchema, value)).toEqual([])
    expect(value.degraded[0]).toMatchObject({ count: 20, candidateId: 'candidate-0' })
    expect(value.degraded[20]).toMatchObject({ placeId: 'place-20', candidateId: 'candidate-20' })
  })
})

describe('round3 itinerary/insight/cost contracts', () => {
  it('IntelItem splits social author/metrics from direct body while accepting legacy trace', () => {
    const item = {
      id: 'intel-social', category: 'recommend' as const, channel: 'xhs-l0' as const,
      title: '青甘攻略', summary: '正文摘要', author: '作者 A',
      metrics: { likes: 12, collects: 4, comments: 2, shares: 1 }, content: '正文内容',
      source, confidence: 'medium' as const,
    }
    expect(validateIntelItem(item)).toEqual([])
    expect(validateIntelItem({ ...item, author: 42 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'author' }),
    ]))
    expect(validateIntelItem({ ...item, metrics: { likes: -1 } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'metrics.likes' }),
    ]))
    expect(validateIntelItem({ ...item, summary: '作者：旧工件 互动：9', content: {
      contentRef: 'intel-social', contentVersion: 'v1', contentStatus: 'extracted' as const,
    } })).toEqual([])
  })

  it('requires itinerary placeId/anchorRole/occurrenceId and preserves day-boundary anchor', () => {
    expect(validateItinerary(modernItinerary())).toEqual([])
    const broken = modernItinerary()
    broken.days[1]!.stops[0] = stop('other-stay', 'stay-end-1', 'lodging', '错误住宿')
    expect(validateItinerary(broken)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'days[1].stops[0].placeId' }),
    ]))
    const reused = modernItinerary()
    reused.days[0]!.stops[2]!.occurrenceId = 'stay-start'
    expect(validateItinerary(reused)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'days[0].stops[2].occurrenceId' }),
    ]))
  })

  it('insights require four typed kinds, Unicode ≤60 text, safe citations, and caller attribution', () => {
    const insights = ['recommend', 'avoid', 'guide', 'plan'].map((kind) => ({
      kind, text: `${kind} 建议`, scope: 'place', scopeRef: 'place-a',
      citations: [{ title: '证据', platform: 'web', url: 'https://example.invalid/evidence' }],
      attribution: { source: 'caller' as const, label: 'caller-model' },
    }))
    expect(validateInsights(insights)).toEqual([])
    expect(validateInsights(insights.slice(0, 3))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'insights', message: expect.stringContaining('四类') }),
    ]))
    expect(validateInsights(insights.map((item, index) => index === 0
      ? { ...item, text: '🙂'.repeat(61) }
      : item))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'insights[0].text' }),
    ]))
    expect(validateInsights(insights.map((item, index) => index === 1
      ? { ...item, citations: [{ title: 'bad', platform: 'web', url: 'javascript:alert(1)' }] }
      : item))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'insights[1].citations[0].url' }),
    ]))
    expect(validateInsights(insights.map((item, index) => index === 2
      ? { ...item, attribution: undefined }
      : item))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'insights[2].attribution' }),
    ]))
  })

  it('cost schema v2 requires unit/priceRange/quantity/basis/scope and assumptions for estimates', () => {
    expect(validateCostArtifact(modernCost())).toEqual([])
    const missing = modernCost()
    delete (missing.components.tickets as unknown as Record<string, unknown>).priceRange
    expect(validateCostArtifact(missing)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'components.tickets.priceRange' }),
    ]))
    const estimated = modernCost()
    estimated.components.food = { ...estimated.components.food, status: 'estimated', assumptions: [] }
    expect(validateCostArtifact(estimated)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'components.food.assumptions' }),
    ]))
  })
})

describe('round3 versioned manifest transaction', () => {
  it('publishes nested research artifacts beside their target file', async () => {
    const planId = 'plan-round3-nested-publish'
    const data = { roundId: 'round-1', observations: [{ itemId: 'intel-1' }] }
    const contentData = { contentRef: 'intel-1', contentVersion: 'v1', body: '正文' }
    const assessmentData = { assessmentId: 'assessment-1', verdict: 'sufficient' }
    const renames: Array<{ from: string; to: string }> = []
    const trackingStore = new TravelStore(root, {
      rename: async (from, to) => {
        renames.push({ from, to })
        return fsPromises.rename(from, to)
      },
    })
    const meta = await trackingStore.publishArtifacts(planId, {
      stage: 'research-round',
      files: [
        { name: 'research-rounds/round-1.json', data },
        { name: 'research-content/intel-1/v1.json', data: contentData },
        { name: 'research-assessments/assessment-1.json', data: assessmentData },
      ],
      inputFingerprint: 'nested-publish',
    })

    expect(renames.some(({ from }) => from.includes('/research-rounds/.round-1.json.tmp-'))).toBe(true)
    expect(renames.some(({ from }) => from.includes('/.research-rounds/'))).toBe(false)

    expect(await store.readJson(planId, 'research-rounds/round-1.json')).toEqual(data)
    expect(await store.readJson(planId, 'research-content/intel-1/v1.json')).toEqual(contentData)
    expect(await store.readJson(planId, 'research-assessments/assessment-1.json')).toEqual(assessmentData)
    for (const name of [
      'research-rounds/round-1.json',
      'research-content/intel-1/v1.json',
      'research-assessments/assessment-1.json',
    ]) {
      expect((await store.readArtifactWithState(planId, name)).status).toBe('current')
      expect(meta.artifacts[name]).toBeDefined()
    }
    expect(await fsPromises.readdir(join(store.planDir(planId), 'research-rounds'))).toEqual(['round-1.json'])
    expect(await fsPromises.readdir(join(store.planDir(planId), 'research-content', 'intel-1'))).toEqual(['v1.json'])
    expect(await fsPromises.readdir(join(store.planDir(planId), 'research-assessments'))).toEqual(['assessment-1.json'])
  })

  it('rolls back nested targets and same-directory temporary files after rename failure', async () => {
    const planId = 'plan-round3-nested-rollback'
    const oldData = { version: 1 }
    await store.publishArtifacts(planId, {
      stage: 'research-round',
      files: [{ name: 'research-rounds/round-1.json', data: oldData }],
      inputFingerprint: 'nested-old',
    })
    const beforeMeta = await store.readArtifactManifest(planId)
    const beforeVersions = await store.loadVersions(planId)
    let failOnce = true
    const nestedRenames: Array<{ from: string; to: string }> = []
    const failureStore = new TravelStore(root, {
      rename: async (from, to) => {
        nestedRenames.push({ from, to })
        if (failOnce && to.endsWith('/research-rounds/round-1.json')) {
          failOnce = false
          throw new Error('INJECTED_NESTED_RENAME_FAILURE')
        }
        return fsPromises.rename(from, to)
      },
    })

    await expect(failureStore.publishArtifacts(planId, {
      stage: 'research-round',
      files: [{ name: 'research-rounds/round-1.json', data: { version: 2 } }],
      inputFingerprint: 'nested-new',
    })).rejects.toThrow('INJECTED_NESTED_RENAME_FAILURE')

    expect(nestedRenames.some(({ from, to }) =>
      from.endsWith('/research-rounds/round-1.json')
      && to.includes('/research-rounds/.round-1.json.rollback-'))).toBe(true)
    expect(nestedRenames.some(({ from }) => from.includes('/.research-rounds/'))).toBe(false)
    expect(await store.readJson(planId, 'research-rounds/round-1.json')).toEqual(oldData)
    expect(await store.readArtifactManifest(planId)).toEqual(beforeMeta)
    expect(await store.loadVersions(planId)).toEqual(beforeVersions)
    const entries = await fsPromises.readdir(join(store.planDir(planId), 'research-rounds'))
    expect(entries).toEqual(['round-1.json'])
  })

  it('rejects traversal, absolute, empty-segment, and backslash artifact paths', async () => {
    const planId = 'plan-round3-nested-path-guard'
    for (const name of [
      'research-content/../escape.json',
      '/tmp/escape.json',
      'research-rounds//round.json',
      'research-rounds\\\\round.json',
    ]) {
      await expect(store.publishArtifacts(planId, {
        stage: 'research-path-guard',
        files: [{ name, data: { name } }],
      })).rejects.toThrow()
    }
    expect(await store.readArtifactManifest(planId)).toBeUndefined()
    expect(await store.readJson(planId, 'escape.json')).toBeUndefined()
  })

  it('retains per-artifact entries without staling an untouched artifact', async () => {
    const planId = 'plan-round3-manifest'
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }], bump: ['intel'],
    })
    const first = await store.readArtifactManifest(planId)
    expect(first?.schemaVersion).toBe(2)
    expect(first?.artifacts['intel.json']).toBeDefined()
    const firstCommit = first!.commitId

    await store.publishArtifacts(planId, {
      stage: 'places', files: [{ name: 'places.json', data: { places: ['p1'] } }], bump: ['places'],
    })
    const second = await store.readArtifactManifest(planId)
    expect(Object.keys(second!.artifacts).sort()).toEqual(['intel.json', 'places.json'])
    expect(second!.artifacts['intel.json']?.commitId).toBe(firstCommit)
    expect(second!.artifacts['places.json']?.commitId).toBe(second!.commitId)
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('current')
    expect((await store.readArtifactWithState(planId, 'places.json')).status).toBe('current')
    await store.writeJson(planId, 'advice.json', { raw: 'unaccounted' })
    expect((await store.readArtifactWithState(planId, 'advice.json')).status).toBe('unknown')
    expect(second!.versions.intel).toBe(1)
    expect(second!.versions.places).toBe(1)
  })

  it('marks an accounted artifact stale only when its upstream version advances', async () => {
    const planId = 'plan-round3-dependency'
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'v1' }] }], bump: ['intel'],
    })
    await store.publishArtifacts(planId, {
      stage: 'places', files: [{ name: 'places.json', data: { places: ['p1'] } }],
      expectedVersions: { intel: 1 }, bump: ['places'],
    })
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'v2' }] }],
      bump: ['intel'],
    })
    const places = await store.readArtifactWithState(planId, 'places.json')
    expect(places.status).toBe('stale')
    expect(places.staleReason).toBe('dependency_version')
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('current')
  })

  it('rolls back files, versions, and manifest after a mid-rename failure', async () => {
    const planId = 'plan-round3-rollback'
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'old' }] }], bump: ['intel'],
    })
    const beforeMeta = await store.readArtifactManifest(planId)
    const beforeVersions = await store.loadVersions(planId)
    let failOnce = true
    const failureStore = new TravelStore(root, {
      rename: async (from, to) => {
        if (failOnce && String(from).includes('.rollback-') === false && String(to).endsWith('places.json')) {
          failOnce = false
          throw new Error('INJECTED_MID_RENAME_FAILURE')
        }
        return fsPromises.rename(from, to)
      },
    })

    await expect(failureStore.publishArtifacts(planId, {
      stage: 'places', files: [
        { name: 'intel.json', data: [{ id: 'new' }] },
        { name: 'places.json', data: { places: ['p-new'] } },
      ], bump: ['places'],
    })).rejects.toThrow('INJECTED_MID_RENAME_FAILURE')

    expect(await store.readJson(planId, 'intel.json')).toEqual([{ id: 'old' }])
    expect(await store.readJson(planId, 'places.json')).toBeUndefined()
    const afterMeta = await store.readArtifactManifest(planId)
    expect(afterMeta?.commitId).toBe(beforeMeta?.commitId)
    expect(await store.loadVersions(planId)).toEqual(beforeVersions)
    const names = await fsPromises.readdir(store.planDir(planId))
    expect(names.some((name) => name.includes('.tmp-') || name.includes('.rollback-'))).toBe(false)
  })

  it('future manifest version reads as unknown without mutating its file', async () => {
    const planId = 'plan-round3-future'
    await store.writeJson(planId, 'intel.json', [{ id: 'future' }])
    const futureMeta = {
      schemaVersion: 999, commitId: 'future-commit', releaseVersion: 99,
      stage: 'future', inputFingerprint: 'future', upstreamVersions: {},
      contentHash: { 'intel.json': 'not-used' }, status: 'success', generatedAt: '2026-09-12T00:00:00.000Z',
    }
    await store.writeJson(planId, 'artifact-meta.json', futureMeta)
    const state = await store.readArtifactWithState(planId, 'intel.json')
    expect(state.status).toBe('unknown')
    expect(state.staleReason).toBe('unknown_version')
    expect(await store.readJson(planId, 'artifact-meta.json')).toEqual(futureMeta)
  })
})

// Keep an imported model symbol in the contract fixture so future additions do not silently erase model coverage.
const _modelContractSentinel: IntelItem = {
  id: 'sentinel', category: 'recommend', channel: 'web', title: 'sentinel', summary: 'body',
  content: { contentRef: 'sentinel', contentVersion: 'v1', contentStatus: 'not_fetched' }, source, confidence: 'medium',
}
void _modelContractSentinel
