import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { filterIntelNoise } from '../src/orchestrator/fanout.js'
import { l0HitToIntelItem } from '../src/adapters/search.js'
import type { L0Hit } from '../src/adapters/search.js'

interface QualityFixture {
  positive: Array<{ id: string; title: string; summary: string; url: string }>
  noise: Array<{ id: string; title: string; summary: string; url: string }>
}

const fixture = JSON.parse(readFileSync('tests/fixtures/qinggan-quality.json', 'utf8')) as QualityFixture

function hits(items: QualityFixture['positive'], platform: L0Hit['platform']): L0Hit[] {
  return items.map((item) => ({ ...item, platform, source: { platform, url: item.url, fetchedAt: '2026-09-12T00:00:00.000Z' } }))
}

describe('round3 intel quality golden', () => {
  it('keeps ≥90% de-identified Qinggan positives and drops all sampled noise', () => {
    const positive = hits(fixture.positive, 'web').map(l0HitToIntelItem)
    const noise = hits(fixture.noise, 'web').map(l0HitToIntelItem)
    const result = filterIntelNoise([...positive, ...noise], undefined, '2026-09-12T00:00:00.000Z', {
      destination: '青甘大环线', keywords: ['西宁', '敦煌'],
    })
    const ids = new Set(result.items.map((item) => item.id))
    const positiveKept = positive.filter((item) => ids.has(item.id)).length
    const noiseKept = noise.filter((item) => ids.has(item.id)).length
    expect(positiveKept / positive.length).toBeGreaterThanOrEqual(0.9)
    expect(noiseKept).toBe(0)
    expect(result.degraded.some((entry) => entry.code === 'NOISE')).toBe(true)
  })
})
