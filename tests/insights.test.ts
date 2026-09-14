import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelValidationError } from '../src/errors.js'
import type { IntelItem, PlacesArtifact, ResearchState, TravelInsight } from '../src/models/types.js'
import { runIntake } from '../src/tools/intake.js'
import { runRecordInsights } from '../src/tools/insights.js'
import { TravelStore } from '../src/store/store.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-insights-'))
  store = new TravelStore(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function intel(id: string): IntelItem {
  return {
    id,
    category: 'attraction',
    channel: 'tencent-poi',
    title: `地点 ${id}`,
    summary: `摘要 ${id}`,
    source: { platform: 'tencent-map', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-01T00:00:00.000Z' },
    confidence: 'high',
  }
}

async function readyPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
  }, store)
  const planId = intake.planId
  const research: ResearchState = {
    schemaVersion: 1,
    researchVersion: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    rounds: ['round-1'],
    budget: { usedRounds: 1, maxRoundsPerPlan: 8, exhausted: false },
    sources: ['tencent-poi'],
    itemIndex: [{ itemId: 'intel-a', roundId: 'round-1', channel: 'tencent-poi', title: '地点 intel-a' }],
  }
  await store.publishArtifacts(planId, {
    stage: 'research',
    files: [{ name: 'intel.json', data: [intel('intel-a')] }, { name: 'research-state.json', data: research }],
    bump: ['intel', 'research'],
  })
  const places: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: 1,
    inputFingerprint: 'places-test',
    generatedAt: '2026-09-01T00:00:00.000Z',
    candidates: [],
    places: [],
    selectedSequence: [],
    pendingClarifications: [],
    status: 'ready',
  }
  await store.publishArtifacts(planId, {
    stage: 'places',
    files: [{ name: 'places.json', data: places }],
    expectedVersions: { intel: 1 },
    bump: ['places'],
  })
  return planId
}

function insight(kind: TravelInsight['kind'], suffix = ''): TravelInsight {
  return {
    kind,
    text: `${kind}${suffix}`,
    scope: 'region',
    scopeRef: '西宁',
    citations: [{ title: '来源', platform: 'web', url: 'https://example.invalid/source', intelRef: 'intel-a' }],
    attribution: { source: 'caller', label: 'planner' },
  }
}

describe('travel_record_insights', () => {
  it('requires current versions/evidence, preserves conflicts, and removes exact duplicates', async () => {
    const planId = await readyPlan()
    const same = insight('recommend')
    const result = await runRecordInsights({
      planId,
      expectedResearchVersion: 1,
      expectedIntelVersion: 1,
      expectedPlacesVersion: 1,
      insights: [same, { ...same }, insight('recommend', '冲突'), insight('avoid'), insight('guide'), insight('plan')],
    }, store)
    expect(result.insightCount).toBe(6)
    expect(result.dedupedCount).toBe(5)
    expect(result.insights.filter((item) => item.kind === 'recommend')).toHaveLength(2)
    expect((await store.readArtifactWithState(planId, 'insights.json')).status).toBe('current')
  })

  it('rejects an unaccounted current-version intel overwrite', async () => {
    const planId = await readyPlan()
    await store.writeJson(planId, 'intel.json', [intel('intel-unaccounted')])
    await expect(runRecordInsights({
      planId,
      expectedResearchVersion: 1,
      expectedIntelVersion: 1,
      expectedPlacesVersion: 1,
      insights: [insight('recommend'), insight('avoid'), insight('guide'), insight('plan')],
    }, store)).rejects.toBeInstanceOf(TravelValidationError)
    expect(await store.readJson(planId, 'insights.json')).toBeUndefined()
  })

  it('rejects invalid citation/version as one batch without partial publication', async () => {
    const planId = await readyPlan()
    await expect(runRecordInsights({
      planId,
      expectedResearchVersion: 1,
      expectedIntelVersion: 1,
      expectedPlacesVersion: 1,
      insights: [
        insight('recommend'), insight('avoid'), insight('guide'),
        { ...insight('plan'), text: '<script>alert(1)</script>' },
      ],
    }, store)).rejects.toBeInstanceOf(TravelValidationError)
    expect(await store.readJson(planId, 'insights.json')).toBeUndefined()
  })

  it('rejects mixed-currency estimates before publication', async () => {
    const planId = await readyPlan()
    const base = { priceRange: [10, 20], unit: 'person', quantity: 1, quantityBasis: 'people', scope: 'total', source: 'caller', assumptions: ['fixture'], evidenceRefs: ['intel-a'] }
    await expect(runRecordInsights({
      planId,
      expectedResearchVersion: 1,
      expectedIntelVersion: 1,
      expectedPlacesVersion: 1,
      insights: [insight('recommend'), insight('avoid'), insight('guide'), insight('plan')],
      costEstimates: [
        { ...base, component: 'tickets', currency: 'CNY' },
        { ...base, component: 'food', currency: 'USD' },
      ],
    }, store)).rejects.toBeInstanceOf(TravelValidationError)
    expect(await store.readJson(planId, 'insights.json')).toBeUndefined()
  })

  it('accepts a fixed saved content version citation', async () => {
    const planId = await readyPlan()
    await store.writeResearchContent(planId, 'intel-a', 'v-body', {
      contentRef: 'intel-a', contentVersion: 'v-body', title: '正文',
      sourceUrl: 'https://example.invalid/source', channel: 'tencent-poi',
      contentStatus: 'extracted', fetchedAt: '2026-09-01T00:00:00.000Z', body: '正文', byteLength: 2,
    })
    const contentCitation = { title: '正文来源', platform: 'web', url: 'https://example.invalid/content', contentRef: 'intel-a', contentVersion: 'v-body', fragmentId: 'p1' }
    const result = await runRecordInsights({
      planId,
      expectedResearchVersion: 1,
      expectedIntelVersion: 1,
      expectedPlacesVersion: 1,
      insights: [
        { ...insight('recommend'), citations: [contentCitation] }, insight('avoid'), insight('guide'), insight('plan'),
      ],
    }, store)
    expect(result.published).toBe(true)
  })
})
