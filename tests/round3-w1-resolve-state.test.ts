/**
 * W1/T2 定向回归：P0-1 消歧快照消费与 P0-2 状态恢复。
 *
 * 所有状态断言都通过真实工具入口；resolver/weather 使用确定性 fixture，零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import type { GeocoderMatch, GeocoderProvider } from '../src/tools/resolve-places.js'
import { runResolvePlaces } from '../src/tools/resolve-places.js'
import { runIntake } from '../src/tools/intake.js'
import { runUpdate } from '../src/tools/update.js'
import { runResearchAdvice } from '../src/tools/research-advice.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { runRenderPage, type RouteRegistrarPort } from '../src/tools/render-page.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'
import { seedPlaces } from './helpers/seed-places.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-round3-w1-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' }
}

async function makeResolveReadyPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 },
  }, store)
  await seedResearch(store, intake.planId, { poi: 'golden', l0: 'none' })
  await seedSufficientAssessment(store, intake.planId)
  return intake.planId
}

function providerFor(run: (candidateName: string) => GeocoderMatch[] | undefined): { provider: GeocoderProvider; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    provider: {
      name: 'fixture-geocoder',
      available: () => true,
      geocode: (candidate) => {
        calls.push(candidate.name)
        return run(candidate.name)
      },
    },
  }
}

async function makeGeneratingPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 },
  }, store)
  const request = await store.loadRequest(intake.planId)
  if (request === undefined) throw new Error('request fixture missing')
  // 仅为工具回路装配 build 后状态；advice/update 本身仍走真实入口。
  await store.saveRequest({ ...request, flowVersion: undefined, status: 'generating' })
  return intake.planId
}

async function makeBuiltGeneratingPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-01', days: 1 },
  }, store)
  await seedResearch(store, intake.planId, { poi: 'golden', l0: 'none' })
  await seedSufficientAssessment(store, intake.planId)
  await seedPlaces(store, intake.planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
  const built = await runBuildItinerary({ planId: intake.planId }, store)
  expect(built.built).toBe(true)
  return intake.planId
}

describe('P0-1 resolve 消歧回答', () => {
  it('先消费旧 conflict 快照：district 精确命中时零重查并保持候选身份', async () => {
    const planId = await makeResolveReadyPlan()
    const fixed = coords(101, 36)
    const candidate = {
      candidateId: 'station', name: '西宁站', kind: 'hub' as const,
      regionHint: '青海 西宁', userRef: '用户必去点',
    }
    const fixture = providerFor(() => [{ coords: fixed, confidence: 'high', district: '城东区' }])

    const first = await runResolvePlaces({ planId, candidates: [candidate], selectionOrder: ['station'] }, store, {
      env: { env: {} }, resolvers: [fixture.provider],
    })
    const clarification = first.pendingClarifications[0]
    expect(clarification).toBeDefined()

    const second = await runResolvePlaces({
      planId, candidates: [candidate], selectionOrder: ['station'],
      disambiguationAnswers: {
        [clarification!.clarificationId]: { candidateId: 'station', answer: ' 城东区 ' },
      },
    }, store, { env: { env: {} }, resolvers: [fixture.provider] })

    expect(second.status).toBe('ready')
    expect(second.places[0]?.name).toBe('西宁站')
    expect(second.places[0]?.placeId).toBe(first.places[0]?.placeId)
    expect(second.places[0]?.coords).toEqual(fixed)
    expect(second.places[0]?.regionVerification).toBe('verified')
    expect(second.places[0]?.pendingClarification).toBeUndefined()
    expect(fixture.calls).toHaveLength(1)
  })

  it('单匹配 conflict 消费 scopePicker：唯一 district 命中时不改名且不二次别名重查', async () => {
    const planId = await makeResolveReadyPlan()
    const candidate = {
      candidateId: 'lake', name: '茶卡盐湖', kind: 'attraction' as const,
      regionHint: '青海 海西州', userRef: '用户必去点',
    }
    const oldCoords = coords(99, 36)
    const newCoords = coords(99.1, 36.1)
    let round = 0
    const fixture = providerFor(() => {
      round += 1
      return [{ coords: round === 1 ? oldCoords : newCoords, confidence: 'high', district: round === 1 ? '旧区' : '乌兰县' }]
    })

    const first = await runResolvePlaces({ planId, candidates: [candidate], selectionOrder: ['lake'] }, store, {
      env: { env: {} }, resolvers: [fixture.provider],
    })
    const clarification = first.pendingClarifications[0]
    expect(clarification).toBeDefined()
    const second = await runResolvePlaces({
      planId, candidates: [candidate], selectionOrder: ['lake'],
      disambiguationAnswers: {
        [clarification!.clarificationId]: { candidateId: 'lake', answer: '乌兰县' },
      },
    }, store, { env: { env: {} }, resolvers: [fixture.provider] })

    expect(second.status).toBe('ready')
    expect(second.places[0]?.name).toBe('茶卡盐湖')
    expect(second.places[0]?.placeId).toBe(first.places[0]?.placeId)
    expect(second.places[0]?.coords).toEqual(newCoords)
    expect(second.places[0]?.regionVerification).toBe('verified')
    expect(fixture.calls).toHaveLength(2)
  })

  it('未知回答不静默采用：保留候选 name 并明确未命中重答', async () => {
    const planId = await makeResolveReadyPlan()
    const fixed = coords(101, 36)
    const candidate = {
      candidateId: 'station', name: '西宁站', kind: 'hub' as const,
      regionHint: '青海 西宁', userRef: '用户必去点',
    }
    const fixture = providerFor((name) => name === '西宁站'
      ? [{ coords: fixed, confidence: 'high', district: '城东区' }]
      : undefined)
    const first = await runResolvePlaces({ planId, candidates: [candidate], selectionOrder: ['station'] }, store, {
      env: { env: {} }, resolvers: [fixture.provider],
    })
    const clarification = first.pendingClarifications[0]
    const second = await runResolvePlaces({
      planId, candidates: [candidate], selectionOrder: ['station'],
      disambiguationAnswers: {
        [clarification!.clarificationId]: { candidateId: 'station', answer: '火星基地' },
      },
    }, store, { env: { env: {} }, resolvers: [fixture.provider] })

    expect(second.status).toBe('needs_clarification')
    expect(second.places[0]?.name).toBe('西宁站')
    expect(second.places[0]?.pendingClarification).toMatch(/未命中.*重?新?回答|未命中.*重答/)
    expect(second.pendingClarifications[0]?.question).toContain('未命中')
    expect(fixture.calls).toEqual(['西宁站', '西宁站', '火星基地'])
  })

  it('真实别名仍保留一次重查语义', async () => {
    const planId = await makeResolveReadyPlan()
    const aliasCoords = coords(94.66, 40.04)
    const candidate = {
      candidateId: 'mogao', name: '莫高窟', kind: 'attraction' as const,
      regionHint: '甘肃 敦煌', userRef: '用户必去点',
    }
    const fixture = providerFor((name) => name === '敦煌莫高窟'
      ? [{ coords: aliasCoords, confidence: 'high', district: '敦煌市' }]
      : undefined)
    const first = await runResolvePlaces({ planId, candidates: [candidate], selectionOrder: ['mogao'] }, store, {
      env: { env: {} }, resolvers: [fixture.provider],
    })
    const clarification = first.pendingClarifications[0]
    const second = await runResolvePlaces({
      planId, candidates: [candidate], selectionOrder: ['mogao'],
      disambiguationAnswers: {
        [clarification!.clarificationId]: { candidateId: 'mogao', answer: '敦煌莫高窟' },
      },
    }, store, { env: { env: {} }, resolvers: [fixture.provider] })

    expect(second.status).toBe('ready')
    expect(second.places[0]?.name).toBe('敦煌莫高窟')
    expect(second.places[0]?.coords).toEqual(aliasCoords)
    expect(fixture.calls).toEqual(['莫高窟', '莫高窟', '敦煌莫高窟'])
  })
})

describe('P0-2 状态恢复与在途门', () => {
  it('无外部在途：update generating→revising，advice generating→revising→researching 且逐边落盘', async () => {
    const updatePlanId = await makeGeneratingPlan()
    const updated = await runUpdate({
      planId: updatePlanId,
      patch: { slots: { constraints: ['减少折返'] } },
    }, store)
    expect(updated.status).toBe('revising')
    expect((await store.loadRequest(updatePlanId))?.status).toBe('revising')

    const advicePlanId = await makeGeneratingPlan()
    const request = await store.loadRequest(advicePlanId)
    if (request === undefined) throw new Error('request fixture missing')
    const statuses: string[] = []
    const originalSave = store.saveRequest.bind(store)
    const saveSpy = vi.spyOn(store, 'saveRequest').mockImplementation(async (next) => {
      statuses.push(next.status)
      await originalSave(next)
    })
    try {
      const advice = await runResearchAdvice({ planId: advicePlanId }, store, {})
      expect(advice.blocked).toBeUndefined()
      expect(advice.weather).toHaveLength(1)
      expect(statuses.slice(0, 2)).toEqual(['revising', 'researching'])
      expect((await store.loadRequest(advicePlanId))?.status).toBe('researching')
      expect(await store.readJson(advicePlanId, 'advice.json')).toBeDefined()
    } finally {
      saveSpy.mockRestore()
    }
  })

  it('外部在途：update 维持拒绝，advice 返回结构化 blocked/nextAction', async () => {
    const updatePlanId = await makeGeneratingPlan()
    const updateRelease = await store.acquirePlanLock(updatePlanId)
    const updatePromise = runUpdate({
      planId: updatePlanId, patch: { slots: { constraints: ['减少折返'] } },
    }, store)
    updateRelease()
    await expect(updatePromise).rejects.toThrow(/在途/)

    const advicePlanId = await makeGeneratingPlan()
    const adviceRelease = await store.acquirePlanLock(advicePlanId)
    const advicePromise = runResearchAdvice({ planId: advicePlanId }, store, {})
    adviceRelease()
    const result = await advicePromise
    expect(result.blocked).toBeDefined()
    expect(result.blocked?.nextAction).toMatch(/完成|取消|重.*travel_research_advice/)
    expect((await store.loadRequest(advicePlanId))?.status).toBe('generating')
    expect(await store.readJson(advicePlanId, 'advice.json')).toBeUndefined()
  })

  it('advice 写入失败后锁释放且可重试', async () => {
    const planId = await makeGeneratingPlan()
    const originalWrite = store.publishArtifacts.bind(store)
    // round3：advice.json 已迁到 publishArtifacts 原子发布（P2-2），故障注入必须落在
    // 真实写入路径上；只对 advice.json 注入，其它工件照常发布。
    const writeSpy = vi.spyOn(store, 'publishArtifacts').mockImplementation(async (publishPlanId, options) => {
      if (options.files.some((file) => file.name === 'advice.json')) throw new Error('fixture advice write failure')
      return originalWrite(publishPlanId, options)
    })
    await expect(runResearchAdvice({ planId }, store, {})).rejects.toThrow('fixture advice write failure')
    expect(store.isPlanLocked(planId)).toBe(false)
    expect((await store.loadRequest(planId))?.status).toBe('researching')
    writeSpy.mockRestore()

    const retried = await runResearchAdvice({ planId }, store, {})
    expect(retried.blocked).toBeUndefined()
    expect(await store.readJson(planId, 'advice.json')).toBeDefined()
  })

  it('advice 后 places 版本不变，build→render 仍可达', async () => {
    const planId = await makeBuiltGeneratingPlan()
    const before = await store.currentVersion(planId, 'places')
    const advice = await runResearchAdvice({ planId }, store, {})
    expect(advice.blocked).toBeUndefined()
    expect(await store.currentVersion(planId, 'places')).toBe(before)

    const rebuilt = await runBuildItinerary({ planId }, store)
    expect(rebuilt.built).toBe(true)
    const registered: string[] = []
    const registrar: RouteRegistrarPort = {
      host: '127.0.0.1',
      port: 3081,
      register(route) {
        registered.push(route.path)
      },
    }
    const rendered = await runRenderPage({ planId, mapProvider: 'leaflet' }, store, registrar)
    expect(rendered.rendered).toBe(true)
    expect(registered).toContain(`/travel-plans/${planId}`)
  })
})
