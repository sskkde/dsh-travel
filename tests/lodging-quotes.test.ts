/**
 * W3 T14 定向酒店报价（phase lodging-quotes）与 DIDA 只读适配器（草稿 E）。
 *
 * 验收（T14 Acceptance）：
 * - 无 stay 上下文 → 零调用 + skipped_missing_stay_context 记录
 * - 未校验 placeId / 版本过期 → 拒绝（rejected）
 * - 价格语义断言：币种/单位(roomNight|stay)/税态(included|excluded|unknown)/单值区间[min,min]
 * - 报价不触发 intel/places 失效（只 bump quotes）
 * - DIDA 渠道 off / 缺 Key → blocked + 零调用（fixture 全离线）
 * - DIDA 白名单恰为 3 只读件（searchHotels/getHotelDetail/getHotelSearchTags），严禁价确/订单/支付
 * - 既有携程问道/飞猪能力保留——discovery 默认 phase 回归不破
 *
 * 全确定性 fixture（假 MCP），零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import {
  DidaHotelAdapter, DIDA_READONLY_TOOLS, assertDidaReadOnly, isDidaReadOnlyTool,
  normalizeHotelDetail, normalizeHotels, DEFAULT_DIDAHOTEL_MCP_URL,
} from '../src/adapters/dida-hotel.js'
import { McpStreamClient, type FetchLike } from '../src/adapters/rail12306.js'
import { EngineError } from '../src/adapters/base.js'
import { TravelValidationError } from '../src/errors.js'
import type { PlacesArtifact, ResolvedPlace } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-quotes-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' as const }
}

function place(candidateId: string, name: string, kind: ResolvedPlace['kind'], opts: { coords?: { lng: number; lat: number; sys: 'GCJ02' } } = {}): ResolvedPlace {
  return {
    placeId: `place-${candidateId}`,
    candidateId,
    name,
    kind,
    pointKind: kind === 'lodging' || kind === 'area' ? 'areaCenter' : 'poi',
    ...(opts.coords ? { coords: opts.coords } : {}),
    source: opts.coords ? 'amap' : 'unresolved',
    coordinate_source: opts.coords ? 'amap' : 'unresolved',
    resolveConfidence: opts.coords ? 'high' : 'low',
  }
}

async function makePlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      origin: '北京',
      destination: '青甘环线',
      dateStart: '2026-09-04',
      dateEnd: '2026-09-10',
      days: 7,
      travelers: { adults: 2 },
      researchIntent: { text: '青甘环线（西宁-敦煌-大柴旦）' },
      ...slots,
    },
  }, store)
  return result.planId
}

async function writePlaces(planId: string, places: ResolvedPlace[], sequence: string[], opts: { placesVersion?: number; stale?: boolean } = {}): Promise<void> {
  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: 1,
    inputFingerprint: 'fp-quotes',
    generatedAt: '2026-09-02T01:00:00.000Z',
    candidates: [],
    places,
    selectedSequence: sequence,
    originResolution: { origin: '北京', resolved: true, coords: coords(101.8, 36.6), entryKind: 'city' },
    pendingClarifications: [],
    status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  await store.writeJson(planId, 'versions.json', { places: opts.placesVersion ?? 1, intel: 1 })
  if (opts.stale === true) {
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'places', inputFingerprint: 'fp-other', upstreamVersions: { intel: 1 },
      contentHash: {}, status: 'success', generatedAt: '2026-09-01T00:00:00.000Z',
    })
  }
}

// ────────────────────────── 假 DIDA MCP ──────────────────────────

function fakeDidaMcp(opts: { detailPrice?: Record<string, unknown>; noHotels?: boolean } = {}) {
  let calls = 0
  const fetchFn: FetchLike = async (_url, init) => {
    calls += 1
    const body = JSON.parse(init?.body ?? '{}')
    const okResp = (result: unknown) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    })
    if (body.method === 'initialize') {
      return okResp({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-dida', version: 'test' } })
    }
    if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' }
    if (body.method === 'tools/list') {
      return okResp({ tools: DIDA_READONLY_TOOLS.map((n) => ({ name: n, description: 'read-only' })) })
    }
    if (body.method === 'tools/call') {
      const name = body.params.name
      if (name === 'searchHotels') {
        if (opts.noHotels === true) return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: true, hotels: [] }) }] })
        return okResp({ content: [{ type: 'text', text: JSON.stringify({
          success: true, hotels: [{ hotelId: 'H1', name: '敦煌酒店', city: '敦煌', address: '鸣沙山景区旁' }],
        }) }] })
      }
      if (name === 'getHotelDetail') {
        return okResp({ content: [{ type: 'text', text: JSON.stringify({
          success: true, hotel: {
            hotelId: 'H1', name: '敦煌酒店', address: '鸣沙山景区旁',
            price: opts.detailPrice ?? { min: 399, max: 599, currency: 'CNY', unit: 'roomNight', taxStatus: 'included', cancellationPolicy: '免费取消', bookingUrl: 'https://example.invalid/book' },
          },
        }) }] })
      }
      if (name === 'getHotelSearchTags') {
        return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: true, tags: ['亲子', '海景'] }) }] })
      }
      return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: false, message: `no fixture ${name}` }) }] })
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601 } }) }
  }
  return { fetchFn, count: () => calls }
}

function didaDeps(opts: { detailPrice?: Record<string, unknown>; noHotels?: boolean; keyEnv?: Record<string, string | undefined>; channelOff?: boolean } = {}) {
  const moc = fakeDidaMcp({ detailPrice: opts.detailPrice, noHotels: opts.noHotels })
  // 适配器自建 MCP 客户端（挂 assertDidaReadOnly 闸门 + Bearer 包装）+ 注入 fetchFn
  const adapter = new DidaHotelAdapter({ url: DEFAULT_DIDAHOTEL_MCP_URL, fetchFn: moc.fetchFn })
  const env = {
    ...(opts.channelOff === true
      ? { readSettings: (key: string) => (key === 'channels.didaHotel' ? 'false' : undefined) }
      : {}),
    env: opts.keyEnv ?? { DIDA_HOTEL_API_KEY: 'test-key' },
  }
  return { deps: { channels: [] as never[], didaHotel: adapter, env }, count: moc.count }
}

// ────────────────────────── T14 定向报价 ──────────────────────────

describe('T14 无 stay 上下文 / 未校验 placeId / 版本过期 → 零调用或拒绝', () => {
  it('全部无入住条件 → skipped_missing_stay_context 记录 + DIDA 零调用', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const d = didaDeps()
    const before = d.count()
    const result = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh' }],
    }, store, d.deps)
    const records = result.lodgingQuotes!.records
    expect(records[0]!.status).toBe('skipped_missing_stay_context')
    expect(records[0]!.reason).toMatch(/checkIn|checkOut|入住/)
    expect(result.lodgingQuotes!.quotes).toEqual([])
    expect(d.count()).toBe(before) // 零调用
    // 不阻塞主线：工件照常发布（skipped 记录）
    expect(await store.readJson(planId, 'lodging-quotes.json')).toBeDefined()
  })

  it('未校验 placeId（未知/非住宿）→ rejected，零调用', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const d = didaDeps()
    const result = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [
        { placeId: 'place-ghost', checkIn: '2026-09-04', checkOut: '2026-09-06' },
        { placeId: 'place-mogao', checkIn: '2026-09-04', checkOut: '2026-09-06' }, // 未知
      ],
    }, store, d.deps)
    expect(result.lodgingQuotes!.records.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(result.lodgingQuotes!.records[0]!.reason).toMatch(/unknown_place|not_in/)
    expect(d.count()).toBe(0)
  })

  it('非住宿 placeId → rejected not_lodging', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('mh', '莫高窟', 'attraction', { coords: coords(94.8, 40.0) })], ['mh'])
    const d = didaDeps()
    const result = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-mh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d.deps)
    expect(result.lodgingQuotes!.records[0]!.status).toBe('rejected')
    expect(result.lodgingQuotes!.records[0]!.reason).toMatch(/not_lodging/)
    expect(d.count()).toBe(0)
  })

  it('places 缺失 → rejected places_not_ready 零调用；版本过期 → rejected places_stale', async () => {
    const planId = await makePlan()
    const d = didaDeps()
    const missing = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d.deps)
    expect(missing.lodgingQuotes!.records[0]!.status).toBe('rejected')
    expect(missing.lodgingQuotes!.records[0]!.reason).toMatch(/places_not_ready/)
    expect(d.count()).toBe(0)

    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'], { placesVersion: 3, stale: true })
    const stale = await runResearchDestination({
      planId, phase: 'lodging-quotes', expectedPlacesVersion: 2,
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d.deps)
    expect(stale.lodgingQuotes!.records[0]!.status).toBe('rejected')
    expect(stale.lodgingQuotes!.records[0]!.reason).toMatch(/places_stale/)
    expect(d.count()).toBe(0)
  })

  it('超过 20 项 / 空 quoteRequests → TravelValidationError', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const d = didaDeps()
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ placeId: `place-${i}` }))
    await expect(runResearchDestination({ planId, phase: 'lodging-quotes', quoteRequests: tooMany }, store, d.deps))
      .rejects.toThrow(/上限/)
    await expect(runResearchDestination({ planId, phase: 'lodging-quotes', quoteRequests: [] }, store, d.deps))
      .rejects.toThrow(/quoteRequests/)
  })
})

describe('T14 价格语义与工件', () => {
  it('quoted：priceQuote 含真实区间/币种/单位/税态/退改/地址 + 单值区间 [min,min]', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const d = didaDeps()
    const result = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06', adults: 2, rooms: 1 }],
    }, store, d.deps)
    const lq = result.lodgingQuotes!
    expect(lq.records[0]!.status).toBe('quoted')
    expect(lq.quotes.length).toBe(1)
    const q = lq.quotes[0]!
    expect(q.placeId).toBe('place-dh')
    expect(q.quote.range).toEqual([399, 599])
    expect(q.quote.currency).toBe('CNY')
    expect(q.quote.unit).toBe('roomNight')
    expect(q.quote.taxStatus).toBe('included')
    expect(q.quote.checkIn).toBe('2026-09-04')
    expect(q.quote.checkOut).toBe('2026-09-06')
    expect(q.quote.adults).toBe(2)
    expect(q.quote.rooms).toBe(1)
    expect(q.quote.cancellationPolicy).toMatch(/取消/)
    expect(q.quote.bookingUrl).toMatch(/^https:/)
    expect(q.source.platform).toBe('dida-hotel')
    expect(q.hotelName).toBe('敦煌酒店')

    // 单值区间：min===max → [min,min]
    const d2 = didaDeps({ detailPrice: { min: 888, max: 888, currency: 'CNY', unit: 'stay', taxStatus: 'excluded' } })
    const single = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d2.deps)
    const sq = single.lodgingQuotes!.quotes[0]!.quote
    expect(sq.range).toEqual([888, 888])
    expect(sq.unit).toBe('stay')
    expect(sq.taxStatus).toBe('excluded')
  })

  it('缺币种/真实数值 → 不填假区间（blocked 记录），零假报价', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const d = didaDeps({ detailPrice: { min: 399, max: 599 } }) // 缺 currency
    const result = await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d.deps)
    expect(result.lodgingQuotes!.records[0]!.status).toBe('blocked')
    expect(result.lodgingQuotes!.records[0]!.reason).toMatch(/币种|假区间|条件/)
    expect(result.lodgingQuotes!.quotes).toEqual([])
  })

  it('报价不触发 intel/places 失效：versions.intel/places 不变，quotes 单独推进', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const versionsBefore = await store.loadVersions(planId)
    expect(versionsBefore.intel).toBe(1)
    expect(versionsBefore.places).toBe(1)
    const d = didaDeps()
    await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d.deps)
    const versionsAfter = await store.loadVersions(planId)
    expect(versionsAfter.intel).toBe(1) // 不使 intel 失效
    expect(versionsAfter.places).toBe(1) // 不使 places 失效
    expect(versionsAfter.quotes).toBe(1) // quotes 版本推进
    // 工件 current
    const state = await store.readArtifactWithState(planId, 'lodging-quotes.json')
    expect(state.status).toBe('current')
  })

  it('intel 工件不被覆盖（不污染发现工件）', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const intelBefore = [{ id: 'tencent-poi:1', category: 'attraction', channel: 'tencent-poi', title: '莫高窟', summary: 's', source: { platform: 'tencent-map', url: 'https://example.invalid/1', fetchedAt: '2026-09-02T00:00:00.000Z' }, confidence: 'high' }]
    await store.writeJson(planId, 'intel.json', intelBefore)
    const d = didaDeps()
    await runResearchDestination({
      planId, phase: 'lodging-quotes',
      quoteRequests: [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }],
    }, store, d.deps)
    const intelAfter = await store.readJson(planId, 'intel.json')
    expect(intelAfter).toEqual(intelBefore) // 未覆盖
  })

  it('DIDA 渠道 off / 缺 Key → blocked + 零调用（fixture 全离线不触网）', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const items = [{ placeId: 'place-dh', checkIn: '2026-09-04', checkOut: '2026-09-06' }]

    const off = didaDeps({ channelOff: true })
    const offResult = await runResearchDestination({ planId, phase: 'lodging-quotes', quoteRequests: items }, store, off.deps)
    expect(offResult.lodgingQuotes!.records[0]!.status).toBe('blocked')
    expect(offResult.lodgingQuotes!.records[0]!.reason).toMatch(/off|关闭/)
    expect(off.count()).toBe(0) // 渠道 off 零调用

    const noKey = didaDeps({ keyEnv: {} })
    const noKeyResult = await runResearchDestination({ planId, phase: 'lodging-quotes', quoteRequests: items }, store, noKey.deps)
    expect(noKeyResult.lodgingQuotes!.records[0]!.status).toBe('blocked')
    expect(noKeyResult.lodgingQuotes!.records[0]!.reason).toMatch(/Key/)
    expect(noKey.count()).toBe(0) // 缺 Key 零调用
  })

  it('discovery 默认 phase 回归不破（无 lodgingQuotes 回执；dest 情报路径可用）', async () => {
    const planId = await makePlan()
    await writePlaces(planId, [place('dh', '敦煌酒店', 'lodging', { coords: coords(94.7, 40.1) })], ['dh'])
    const d = didaDeps()
    const result = await runResearchDestination({ planId }, store, { ...d.deps, channels: [], retryDelaysMs: [] })
    expect(result.lodgingQuotes).toBeUndefined()
    expect(result.itemCount).toBe(0) // 无渠道 → 无条目（不误走报价通路）
  })
})

describe('T14 DIDA 只读白名单', () => {
  it('白名单恰为 3 只读件且无价确/订单/支付', () => {
    expect([...DIDA_READONLY_TOOLS].sort()).toEqual(['getHotelDetail', 'getHotelSearchTags', 'searchHotels'])
    expect(isDidaReadOnlyTool('searchHotels')).toBe(true)
    expect(isDidaReadOnlyTool('confirmPrice')).toBe(false)
    expect(isDidaReadOnlyTool('createOrder')).toBe(false)
    expect(isDidaReadOnlyTool('pay')).toBe(false)
    expect(isDidaReadOnlyTool('bookRoom')).toBe(false)
    expect(isDidaReadOnlyTool('placeOrder')).toBe(false)
    expect(() => assertDidaReadOnly('createOrder')).toThrow(EngineError)
  })

  it('归一化：searchHotels/getHotelDetail 结构化（真实数值才出 price）', () => {
    const hotels = normalizeHotels([{ id: 'H2', hotelName: '西宁青旅', lng: 101.8, lat: 36.6 }])
    expect(hotels).toEqual([{ hotelId: 'H2', name: '西宁青旅', coords: { lng: 101.8, lat: 36.6, sys: 'GCJ02' } }])
    const detail = normalizeHotelDetail({ hotel_id: 'H1', hotel_name: '敦煌酒店', price: { minPrice: 300, maxPrice: 500, currency: 'CNY', tax: 'ex' } })
    expect(detail?.price).toEqual({ min: 300, max: 500, currency: 'CNY', taxStatus: 'excluded' })
    const noCurrency = normalizeHotelDetail({ hotel_id: 'H1', hotel_name: '敦煌酒店', price: { min: 1, max: 2 } })
    expect(noCurrency?.price).toBeUndefined() // 缺币种不填假区间
  })
})