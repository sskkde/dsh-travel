/**
 * W3 T11 交通前置门与出发入口检索（草稿 D）。
 *
 * 验收（T11 Acceptance）：
 * - 无 places / 版本过期 / 入口未解析 → 返回结构化 blocked+nextAction，**下游网络请求数=0**
 * - 完整 plan（flowVersion 新计划或已解析 places）不得回落到 slots.destination 绕过门
 * - 入口城市变化不回写覆盖主题（destination/researchIntent 原样保留）
 * - 轻量请求行为与现状一致（legacy 无 flowVersion/无 places → 照常查询）
 * - searchStations 命中多站时按真实到达枢纽匹配，而非默认第一站
 * - 不同到达枢纽方案 ID 不串用；缺枢纽坐标 → 衔接未知
 * - 返程不自动新增（dateStart 单程）
 *
 * 全确定性 fixture 注入，零真实网络；网络调用计数用包装 fetchFn 统计。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchTransport } from '../src/tools/research-transport.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { Rail12306Adapter, McpStreamClient, type FetchLike } from '../src/adapters/rail12306.js'
import { TravelValidationError } from '../src/errors.js'
import type { PlacesArtifact, ResolvedPlace, TravelRequest } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-gate-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' as const }
}

function src(platform: string, url: string): { platform: string; url: string; fetchedAt: string } {
  return { platform, url, fetchedAt: '2026-09-02T00:00:00.000Z' }
}

// ────────────────────────── fixture 装配 ──────────────────────────

interface ScriptedStation { name: string; code: string; pinyin: string }
interface ScriptedTrain {
  train_no: string
  from_station: string
  to_station: string
  start_time: string
  arrive_time: string
  duration: string
}

/** 可控假 MCP：search-stations / query-tickets 脚本化；fetchFn 计数。 */
function fakeMcp(opts: { stations?: ScriptedStation[]; trains?: ScriptedTrain[] }) {
  let calls = 0
  const fetchFn: FetchLike = async (_url, init) => {
    calls += 1
    const body = JSON.parse(init?.body ?? '{}')
    const okResp = (result: unknown) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    })
    if (body.method === 'initialize') {
      return okResp({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-12306', version: 'test' } })
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, text: async () => '' }
    }
    if (body.method === 'tools/list') {
      return okResp({ tools: [{ name: 'search-stations', description: '' }, { name: 'query-tickets', description: '' }] })
    }
    if (body.method === 'tools/call') {
      const name = body.params.name
      if (name === 'search-stations') {
        return okResp({ content: [{ type: 'text', text: JSON.stringify({
          success: true, stations: opts.stations ?? [],
        }) }] })
      }
      if (name === 'query-tickets') {
        return okResp({ content: [{ type: 'text', text: JSON.stringify({
          success: true, trains: opts.trains ?? [],
        }) }] })
      }
      return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: false, message: `no fixture ${name}` }) }] })
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601 } }) }
  }
  return {
    client: new McpStreamClient({ url: 'http://127.0.0.1:8123/mcp', fetchFn }),
    count: () => calls,
  }
}

/** 计数 amap stub：geocode/direction-transit/distance 路由 fixture 或脚本化失败。 */
function amapStub(opts: { geocodeMode?: 'ok' | 'fail' | 'none' } = {}) {
  let calls = 0
  const geocodeMode = opts.geocodeMode ?? 'ok'
  const fetchFn = async (url: string) => {
    calls += 1
    if (url.includes('geocode/geo')) {
      if (geocodeMode === 'fail') throw new Error('ENGINE_RESPONSE_DATA_ERROR')
      if (geocodeMode === 'none') throw new Error('no fixture')
      return { ok: true, status: 200, text: async () => JSON.stringify({
        status: '1', info: 'OK', geocodes: [{ location: '101.8,36.6', level: '区县' }],
      }) }
    }
    if (url.includes('direction/transit/integrated')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        status: '1', info: 'OK', route: { distance: '11000', transits: [{
          cost: '2.0', duration: '1800', walking_distance: '500', distance: '10500',
          segments: [{ walking: { distance: '500' }, bus: { transit_mode: '8' } }],
        }] },
      }) }
    }
    if (url.includes('distance')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        status: '1', results: [{ origin_id: '0', dest_id: '0', distance: '10000', duration: '2700' }],
      }) }
    }
    throw new Error(`amapStub: no fixture ${url}`)
  }
  return { adapter: new AmapAdapter({ fetchFn }), count: () => calls }
}

const QINGGAN_STATIONS: ScriptedStation[] = [
  { name: '西宁站', code: 'XN1', pinyin: 'xining' },
  { name: '西宁东站', code: 'XN2', pinyin: 'xiningdong' },
  { name: '西宁南站', code: 'XN3', pinyin: 'xiningnan' },
]

function train(to: string, no = 'G531'): ScriptedTrain {
  return { train_no: no, from_station: '北京西', to_station: to, start_time: '09:00', arrive_time: '14:30', duration: '05:30' }
}

const ENV = { env: { amapWebservice: 'test-key' } }

function deps(opts: {
  trains?: ScriptedTrain[]
  stations?: ScriptedStation[]
  geocodeMode?: 'ok' | 'fail' | 'none'
  railUnavailable?: boolean
} = {}) {
  const railMoc = fakeMcp({ stations: opts.stations ?? QINGGAN_STATIONS, trains: opts.trains ?? [train('西宁东站')] })
  const amap = amapStub({ geocodeMode: opts.geocodeMode })
  const rail = opts.railUnavailable === true
    ? new Rail12306Adapter({ mcp: new McpStreamClient({
      url: 'http://127.0.0.1:8123/mcp', fetchFn: async () => { throw new Error('ECONNREFUSED') },
    }) })
    : new Rail12306Adapter({ mcp: railMoc.client })
  return { rail, amap: amap.adapter, env: ENV, railCount: railMoc.count, amapCount: amap.count }
}

/** 新建计划（legacy：无 flowVersion）并返回 planId。 */
async function makePlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      origin: '北京',
      destination: '青甘环线',
      dateStart: '2026-09-04',
      dateEnd: '2026-09-10',
      days: 7,
      researchIntent: { text: '青甘环线（西宁-敦煌-大柴旦）' },
      ...slots,
    },
  }, store)
  return result.planId
}

/** 升级为完整 plan（写 flowVersion）。 */
async function markComplete(planId: string, flowVersion = 'v1'): Promise<void> {
  const request = await store.loadRequest(planId)
  expect(request).toBeDefined()
  await store.saveRequest({ ...request!, flowVersion })
}

/** 装配 places.json（含入口）与版本账本。 */
async function writePlaces(planId: string, opts: {
  entry?: ResolvedPlace
  places?: ResolvedPlace[]
  entryPlaceId?: string
  originResolved?: boolean
  placesVersion?: number
  stale?: boolean
} = {}): Promise<void> {
  const entry = opts.entry ?? {
    placeId: 'place-xining', candidateId: 'xn', name: '西宁', kind: 'area' as const,
    pointKind: 'areaCenter' as const, coords: coords(101.8, 36.6), source: 'amap',
    coordinate_source: 'amap' as const, resolveConfidence: 'high' as const,
  }
  const places = opts.places ?? [entry]
  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: 1,
    inputFingerprint: 'fp-qinggan',
    generatedAt: '2026-09-02T01:00:00.000Z',
    candidates: [],
    places,
    selectedSequence: ['xn'],
    entryPlaceId: opts.entryPlaceId !== undefined ? opts.entryPlaceId : entry.placeId,
    originResolution: {
      origin: '北京',
      resolved: opts.originResolved ?? true,
      ...(entry.coords !== undefined ? { coords: entry.coords } : {}),
      entryKind: 'city',
    },
    pendingClarifications: [],
    status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  const placesVersion = opts.placesVersion ?? 1
  await store.writeJson(planId, 'versions.json', { places: placesVersion })
  if (opts.stale === true) {
    // contentHash 与 places.json 实际内容不符 → hash_mismatch stale（版本过期/篡改，零网络拦截）
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'places',
      inputFingerprint: 'fp-other',
      upstreamVersions: { intel: 1 },
      contentHash: { 'places.json': 'deadbeef' },
      status: 'success',
      generatedAt: '2026-09-01T00:00:00.000Z',
    })
  }
}

// ────────────────────────── T11 前置门：零网络 ──────────────────────────

describe('T11 前置门：完整 plan 缺 places/过期/入口未解析 → blocked + 零网络', () => {
  it('无 places.json → blocked places_not_ready + nextAction，网络调用数=0，不落 transport.json', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    const d = deps()
    const before = d.railCount() + d.amapCount()
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate).toBeDefined()
    expect(result.gate!.blocked).toBe(true)
    expect(result.gate!.reason).toBe('places_not_ready')
    expect(result.gate!.nextAction).toMatch(/resolve_places|resolve/i)
    expect(result.options).toEqual([])
    expect(d.railCount() + d.amapCount()).toBe(before) // 零网络
    expect(await store.readJson(planId, 'transport.json')).toBeUndefined()
  })

  it('places 版本过期（stale）→ blocked places_stale + 零网络', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId, { stale: true })
    const d = deps()
    const before = d.railCount() + d.amapCount()
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate?.reason).toBe('places_stale')
    expect(result.gate!.nextAction).toMatch(/resolve|places/i)
    expect(d.railCount() + d.amapCount()).toBe(before)
  })

  it('入口未解析（无 entryPlaceId）→ blocked entry_not_resolved + 零网络', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId, { entryPlaceId: undefined, originResolved: false })
    const d = deps()
    const before = d.railCount() + d.amapCount()
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate?.reason).toBe('entry_not_resolved')
    expect(result.gate!.nextAction).toMatch(/resolve/i)
    expect(d.railCount() + d.amapCount()).toBe(before)
  })

  it('入口引用未知地点 → blocked entry_place_missing + 零网络', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId, { entryPlaceId: 'place-ghost' })
    const d = deps()
    const before = d.railCount() + d.amapCount()
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate?.reason).toBe('entry_place_missing')
    expect(d.railCount() + d.amapCount()).toBe(before)
  })

  it('完整 plan 不得伪装单点查询绕过门：有 flowVersion + destination 也无回落到 slots.destination', async () => {
    const planId = await makePlan({ destination: '上海' }) // destination 存在，但完整 plan 仍走门
    await markComplete(planId)
    const d = deps()
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate).toBeDefined()
    expect(result.options).toEqual([])
    const request = await store.loadRequest(planId)
    expect(request!.slots.destination).toBe('上海') // 门没把 destination 当作隐式出口
  })

  it('F1c-E：destination-only 新 plan（无显式 researchIntent，confirmed → flowVersion 自动写）同样受前置门', async () => {
    // 决策 5：destination 映射兴趣种子的新 plan 一律受串行门（不再当 legacy 轻量单点）
    const intake = await runIntake({
      slots: { origin: '北京', destination: '青甘环线', dateStart: '2026-09-04', dateEnd: '2026-09-10', days: 7 },
    }, store)
    expect(intake.status).toBe('confirmed')
    expect(intake.request.flowVersion).toBe('1') // 自动套新信封
    expect(intake.request.slots.researchIntent?.text).toBe('青甘环线') // 映射种子
    const d = deps()
    const before = d.railCount() + d.amapCount()
    const result = await runResearchTransport({ planId: intake.planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate).toBeDefined()
    expect(result.gate!.reason).toBe('places_not_ready')
    expect(d.railCount() + d.amapCount()).toBe(before) // 零网络
    expect(result.options).toEqual([])
  })
})

// ────────────────────────── T11 完整计划出发入口 ──────────────────────────

describe('T11 完整计划出发入口与枢纽衔接', () => {
  it('places ready → 出发腿查询成功，回执含 entry 与枢纽衔接；返回不自动新增', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId)
    const d = deps()
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })

    expect(result.gate).toBeUndefined()
    expect(result.options.length).toBeGreaterThanOrEqual(1)
    expect(result.entry).toBeDefined()
    expect(result.entry!.entryPlaceId).toBe('place-xining')
    expect(result.entry!.entryName).toBe('西宁')
    expect(result.entry!.origin).toBe('北京')
    expect(result.entry!.hubLinks.length).toBeGreaterThanOrEqual(1)
    // 只查出发腿：单段去向入口，无返程段（不自动新增 entry→origin 段）
    for (const opt of result.options) {
      expect(opt.segments.length).toBe(1) // 只产出发腿
      expect(opt.segments[0].from).toContain('北京') // 车站级（如 北京西）亦可
      expect(opt.segments[0].to).not.toContain('北京') // 无返程（不自动新增 entry→origin）
    }
    // transport.json 落盘 + 状态 researching
    expect(await store.readJson(planId, 'transport.json')).toBeDefined()
    const request = await store.loadRequest(planId)
    expect(request!.status).toBe('researching')
  })

  it('入口城市解析不回写覆盖主题：destination/researchIntent 原样保留', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId, { entry: {
      placeId: 'place-xining', candidateId: 'xn', name: '西宁', kind: 'area' as const,
      pointKind: 'areaCenter' as const, coords: coords(101.8, 36.6), source: 'amap',
      coordinate_source: 'amap' as const, resolveConfidence: 'high' as const,
    } })
    const d = deps()
    await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    const request = await store.loadRequest(planId)
    expect(request!.slots.destination).toBe('青甘环线')
    expect(request!.slots.researchIntent?.text).toBe('青甘环线（西宁-敦煌-大柴旦）')
  })

  it('searchStations 命中多站 → 按真实到达枢纽匹配，而非默认第一站', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId)
    const d = deps({ trains: [train('西宁东站')] }) // 实际到达 = 西宁东站（候选第二项）
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.entry).toBeDefined()
    expect(result.entry!.hubLinks[0].arrivalStation).toBe('西宁东站')
    expect(result.entry!.hubLinks[0].matchedStation).toBe('西宁东站')
    expect(result.entry!.hubLinks[0].matchedStation).not.toBe('西宁站') // 不把第一站默认为正确站
    expect(result.options[0].cityTransfer?.from).toContain('西宁东站')
  })

  it('不同到达枢纽方案 ID 不串用：各方案衔接自己的到达站', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId)
    const d = deps({ trains: [train('西宁东站', 'G111'), train('西宁站', 'D222')] })
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.entry!.hubLinks.length).toBe(2)
    const ids = result.entry!.hubLinks.map((h) => h.schemeId)
    expect(new Set(ids).size).toBe(2) // 方案 ID 唯一
    const byArrival = new Map(result.entry!.hubLinks.map((h) => [h.arrivalStation, h]))
    expect(byArrival.get('西宁东站')!.schemeId).toBe(ids[0])
    expect(byArrival.get('西宁站')!.schemeId).toBe(ids[1])
    // 各 option 挂自己的衔接（不串用）
    const east = result.options.find((o) => o.segments[0]?.to === '西宁东站')
    const west = result.options.find((o) => o.segments[0]?.to === '西宁站')
    expect(east?.cityTransfer?.from).toContain('西宁东站')
    expect(west?.cityTransfer?.from).toContain('西宁站')
  })

  it('缺枢纽坐标 → 衔接未知（不把城市中心错用成终点）', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    // 入口无坐标 + 地理编码失败 → 枢纽坐标未知
    await writePlaces(planId, { entry: {
      placeId: 'place-xining', candidateId: 'xn', name: '西宁', kind: 'area' as const,
      pointKind: 'areaCenter' as const, source: 'amap', coordinate_source: 'amap' as const,
      resolveConfidence: 'medium' as const,
    } })
    const d = deps({ geocodeMode: 'fail' })
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.entry!.hubLinks[0].linked).toBe(false)
    expect(result.entry!.hubLinks[0].unknown).toBe(true)
    expect(result.entry!.hubLinks[0].reason ?? '').toMatch(/未知|坐标/i)
    // 出发腿本身仍成功（rail 班次不依赖坐标）
    expect(result.options.length).toBeGreaterThanOrEqual(1)
  })

  it('rail 不可用（互备未装配）→ 非 success 状态 + 原因，旧 transport 只标 stale 不复活', async () => {
    const planId = await makePlan()
    await markComplete(planId)
    await writePlaces(planId)
    const d = deps({ railUnavailable: true })
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.options.length).toBe(0)
    expect(result.degraded.some((x) => x.source === 'rail12306')).toBe(true)
    expect(result.entry).toBeDefined()
    expect(await store.readJson(planId, 'transport.json')).toBeUndefined()
  })
})

// ────────────────────────── T11 legacy 轻量路径 ──────────────────────────

describe('T11 legacy 轻量路径保持现状', () => {
  it('无 flowVersion 且无 places → 照常查询（legacy 轻量路径行为与现状一致，无 gate/entry）', async () => {
    // 真正的 legacy 形态：请求文件里没有 flowVersion 信封（旧计划/未走新确认写入口）。
    // 只有这类才走轻量单点票务路径 —— 已确认的新 plan 一律带 flowVersion（F4-C1），
    // 不再静默回落到 destination 绕过门。
    const planId = await makePlan({ destination: '上海' })
    const plan = await store.loadRequest(planId)
    expect(plan).toBeDefined()
    await store.saveRequest({ ...plan!, flowVersion: undefined })
    const d = deps({ trains: [train('上海虹桥')] })
    const result = await runResearchTransport({ planId }, store, { rail: d.rail, amap: d.amap, env: d.env })
    expect(result.gate).toBeUndefined()
    expect(result.entry).toBeUndefined()
    expect(result.options.length).toBeGreaterThanOrEqual(1)
    expect(result.options[0].cityTransfer).toBeDefined()
  })

  it('既有校验保持：缺 origin/dateStart → TravelValidationError（legacy 与完整统一）', async () => {
    const planId = await runIntake({
      slots: { destination: '上海', dateStart: '2026-09-04', dateEnd: '2026-09-06', days: 3 },
    }, store)
    const plan = await store.loadRequest(planId.planId)
    await store.saveRequest({ ...plan!, flowVersion: 'v1' })
    // 完整 plan 也要求 origin/dateStart
    await expect(runResearchTransport({ planId: planId.planId }, store, { rail: deps().rail, amap: deps().amap, env: deps().env }))
      .rejects.toThrow(/origin/)
  })

  it('计划不存在 → TravelValidationError', async () => {
    const d = deps()
    await expect(runResearchTransport({ planId: 'plan-nope' }, store, { rail: d.rail, amap: d.amap, env: d.env }))
      .rejects.toThrow(TravelValidationError)
  })
})