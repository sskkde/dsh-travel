/**
 * store 层单测：读写往返 + 七态状态机（design §5.4 mermaid）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore, generatePlanId } from '../src/store/store.js'
import {
  TERMINAL_STATUS, TRANSITION_TABLE, assertTransition, canTransition,
  isTerminal, nextStatuses,
} from '../src/store/state.js'
import { REQUEST_STATUSES, type TravelRequest } from '../src/models/types.js'
import { InvalidTransitionError } from '../src/errors.js'

let root: string
let store: TravelStore
let dirs: string[]

beforeEach(() => {
  dirs = []
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-store-'))
  dirs.push(root)
  store = new TravelStore(root)
})

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeRequest(planId = generatePlanId(), over: Partial<TravelRequest> = {}): TravelRequest {
  const now = '2026-09-01T00:00:00.000Z'
  const request: TravelRequest = {
    planId,
    mode: 'plan',
    status: 'collecting',
    slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
    assumptions: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  }
  return request
}

describe('TravelStore 读写往返（ADR-6）', () => {
  it('save→load 往返保留全部字段；request.json 落盘于 .dsh-travel/<planId>/', async () => {
    const planId = generatePlanId()
    const request = makeRequest(planId)
    await expect(store.loadRequest(planId)).resolves.toBeUndefined()

    await store.saveRequest(request)
    const loaded = await store.loadRequest(planId)
    expect(loaded).toEqual(request)
    expect(planId).toMatch(/^plan-/)
  })

  it('缺失计划 → undefined（不抛）；不存在目录 listArtifacts → []', async () => {
    expect(await store.loadRequest('plan-nope')).toBeUndefined()
    expect(await store.listArtifacts('plan-nope')).toEqual([])
    expect(await store.loadDegraded('plan-nope')).toBeUndefined()
  })

  it('非法 planId 拒绝（路径安全）', async () => {
    await expect(store.saveRequest(makeRequest('../evil'))).rejects.toThrow(/非法 planId/)
    await expect(store.loadRequest('a/b')).rejects.toThrow(/非法 planId/)
  })

  it('写入先过契约闸门（validateRequest），脏数据被拒', async () => {
    await expect(store.saveRequest(makeRequest(generatePlanId(), { status: 'done' as never })))
      .rejects.toThrow(/status/)
  })

  it('listArtifacts 只列 request.json + 已知 artifacts', async () => {
    const planId = generatePlanId()
    await store.saveRequest(makeRequest(planId))
    await store.writeJson(planId, 'intel.json', [{ id: 'i1' }])
    await store.writeJson(planId, 'scrap.txt', 'x')
    const artifacts = await store.listArtifacts(planId)
    expect(artifacts).toContain('request.json')
    expect(artifacts).toContain('intel.json')
    expect(artifacts).not.toContain('scrap.txt')
  })

  it('degraded 记账：record→load 往返 + 同源同因去重', async () => {
    const planId = generatePlanId()
    await store.saveRequest(makeRequest(planId))
    const entry = { source: 'amap', code: 'UNAVAILABLE' as const, reason: 'Key 未配置', at: '2026-09-01T00:00:00.000Z' }
    await store.recordDegraded(planId, entry)
    await store.recordDegraded(planId, entry) // 重复 → 去重
    const degraded = await store.loadDegraded(planId)
    expect(degraded).toEqual([entry])
  })

  it('findLatestPlan 按 updatedAt 择优（get_state 无 planId 兜底）', async () => {
    await store.saveRequest(makeRequest(generatePlanId(), { updatedAt: '2026-09-01T00:00:00.000Z' }))
    const newer = makeRequest(generatePlanId(), { updatedAt: '2026-09-02T00:00:00.000Z' })
    await store.saveRequest(newer)
    await store.saveRequest(makeRequest(generatePlanId(), { updatedAt: '2026-09-01T12:00:00.000Z' }))
    const latest = await store.findLatestPlan()
    expect(latest?.planId).toBe(newer.planId)
  })
})

describe('七态状态机（§5.4 mermaid）', () => {
  it('转换表覆盖全部七态且仅含合法边', () => {
    expect(REQUEST_STATUSES).toHaveLength(7)
    expect(TRANSITION_TABLE.collecting).toEqual(['recommending', 'confirmed'])
    expect(TRANSITION_TABLE.recommending).toEqual(['collecting'])
    expect(TRANSITION_TABLE.confirmed).toEqual(['researching'])
    expect(TRANSITION_TABLE.researching).toEqual(['generating'])
    expect(TRANSITION_TABLE.generating).toEqual(['delivered'])
    expect(TRANSITION_TABLE.delivered).toEqual(['revising'])
    expect(TRANSITION_TABLE.revising).toEqual(['generating'])
  })

  it('合法转换（主线）通过', () => {
    expect(canTransition('collecting', 'recommending')).toBe(true)
    expect(canTransition('recommending', 'collecting')).toBe(true)
    expect(canTransition('collecting', 'confirmed')).toBe(true)
    expect(canTransition('confirmed', 'researching')).toBe(true)
    expect(canTransition('researching', 'generating')).toBe(true)
    expect(canTransition('generating', 'delivered')).toBe(true)
    expect(canTransition('delivered', 'revising')).toBe(true)
    expect(canTransition('revising', 'generating')).toBe(true)
    expect(canTransition('collecting', 'collecting')).toBe(true) // self 幂等
    expect(() => assertTransition('collecting', 'confirmed')).not.toThrow()
  })

  it('非法转换被拒（delivered→researching / confirmed→collecting 等）', () => {
    expect(canTransition('delivered', 'researching')).toBe(false)
    expect(canTransition('confirmed', 'collecting')).toBe(false)
    expect(canTransition('researching', 'collecting')).toBe(false)
    expect(canTransition('revising', 'collecting')).toBe(false)
    expect(canTransition('collecting', 'generating')).toBe(false)
    expect(canTransition('revising', 'confirmed')).toBe(false)
    expect(() => assertTransition('delivered', 'researching')).toThrow(InvalidTransitionError)
    expect(() => assertTransition('confirmed', 'collecting')).toThrow(/状态机非法转换/)
  })

  it('delivered 为休止/可交付终态（除 revising 外不可转出）', () => {
    expect(isTerminal('delivered')).toBe(true)
    expect(isTerminal('collecting')).toBe(false)
    const outgoing = nextStatuses('delivered')
    expect(outgoing).not.toContain('researching')
    expect(outgoing).toContain('revising')
    expect(outgoing).toContain(TERMINAL_STATUS)
  })

  it('nextStatuses 含 self 与可到达边', () => {
    expect(nextStatuses('collecting')).toEqual(['collecting', 'recommending', 'confirmed'])
    expect(nextStatuses('generating')).toEqual(['generating', 'delivered'])
  })
})