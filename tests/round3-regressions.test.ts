/**
 * W0/T1 round3 RED 基线：13 项生产回归的最小、可编译行为断言。
 *
 * 纪律：这些用例不通过 import 不存在的符号制造失败；失败必须来自当前行为
 * 尚未达到 round3 冻结目标。W0 只冻结契约/manifest，W1–W5 负责把这些红线变绿。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AmapAdapter } from '../src/adapters/amap.js'
import { socialPostToIntelItem } from '../src/adapters/search.js'
import { xhsFeedToIntelItem } from '../src/adapters/xhs.js'
import type { ItineraryDay, IntelItem, TravelRequest } from '../src/models/types.js'
import { classifyIntelCategory } from '../src/adapters/search.js'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runUpdate } from '../src/tools/update.js'
import { runResearchAdvice } from '../src/tools/research-advice.js'
import { runResolvePlaces } from '../src/tools/resolve-places.js'
import { autoProposeItinerary } from '../src/tools/build-itinerary.js'
import { buildRenderData, renderWithTemplate, templatePath, type RenderPageData } from '../src/render/render.js'
import { runRouteCheck, createEstimateRouteProvider } from '../src/route-check.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'
import { seedPlaces } from './helpers/seed-places.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { WendaoAdapter } from '../src/adapters/wendao.js'
import type { CostArtifact, LodgingQuotesArtifact, TransportOption } from '../src/models/types.js'
import { validateIntelItem } from '../src/models/validate.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-round3-red-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' }
}

function source(platform = 'test') {
  return { platform, url: 'https://example.invalid/evidence', fetchedAt: '2026-09-12T00:00:00.000Z' }
}

function pageData(intel: Record<string, IntelItem> = {}): RenderPageData {
  const request: TravelRequest = {
    planId: 'plan-red', mode: 'plan', status: 'delivered',
    slots: { destination: '青甘', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 },
    assumptions: [], createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
  }
  return {
    renderedAt: '2026-09-12T00:00:00.000Z', request,
    itinerary: {
      itineraryId: 'it-red', days: [{ date: '2026-09-15', stops: [], meals: [] }],
      routeCheck: { issues: [], warnings: [] },
    },
    intel, degraded: [], map: { provider: 'leaflet', warnings: [] },
  }
}

async function makeResolveReadyPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 },
  }, store)
  await seedResearch(store, intake.planId, { poi: 'golden', l0: 'none' })
  await seedSufficientAssessment(store, intake.planId)
  return intake.planId
}

function attraction(id: string, lng: number, lat: number): IntelItem {
  return {
    id, category: 'attraction', channel: 'web', title: id, summary: `${id} summary`,
    coords: coords(lng, lat), source: source('fixture'), confidence: 'high',
  }
}

/** P0-1：单匹配地域冲突确认必须消费旧匹配，而非把回答当别名二次重查。 */
it('P0-1 resolve 单匹配 district 确认后 name/placeId/坐标不变且零别名重查', async () => {
  const planId = await makeResolveReadyPlan()
  let calls = 0
  const fixed = coords(101.0, 36.0)
  const candidate = {
    candidateId: 'xining-station', name: '西宁站', kind: 'hub' as const,
    regionHint: '青海 西宁', userRef: '用户必去点',
  }
  const deps = {
    env: { env: {} },
    resolvers: [{
      name: 'fixture-geocoder',
      available: () => true,
      geocode: () => { calls += 1; return [{ coords: fixed, confidence: 'high' as const, district: '城东区' }] },
    }],
  }
  const first = await runResolvePlaces({ planId, candidates: [candidate], selectionOrder: ['xining-station'] }, store, deps)
  const clarification = first.pendingClarifications[0]
  expect(clarification).toBeDefined()
  const second = await runResolvePlaces({
    planId, candidates: [candidate], selectionOrder: ['xining-station'],
    disambiguationAnswers: { [clarification!.clarificationId]: { candidateId: 'xining-station', answer: '城东区' } },
  }, store, deps)
  expect(second.status).toBe('ready')
  expect(second.places[0]?.name).toBe('西宁站')
  expect(second.places[0]?.placeId).toBe(first.places[0]?.placeId)
  expect(second.places[0]?.coords).toEqual(fixed)
  expect(calls).toBe(1)
})

/** P0-2：build 后补 advice 需要真实状态恢复边。 */
it('P0-2 build 后 advice 可达：generating→revising→researching 恢复回路', async () => {
  const makeGeneratingPlan = async (): Promise<string> => {
    const intake = await runIntake({
      slots: { destination: '西宁', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 },
    }, store)
    const request = await store.loadRequest(intake.planId)
    await store.saveRequest({ ...request!, flowVersion: undefined, status: 'generating' })
    return intake.planId
  }

  const updatePlanId = await makeGeneratingPlan()
  const updated = await runUpdate({
    planId: updatePlanId,
    patch: { slots: { constraints: ['减少折返'] } },
  }, store)
  expect(updated.status).toBe('revising')
  expect((await store.loadRequest(updatePlanId))?.status).toBe('revising')

  const advicePlanId = await makeGeneratingPlan()
  const advice = await runResearchAdvice({ planId: advicePlanId }, store, {})
  expect(advice.blocked).toBeUndefined()
  expect(advice.weather.length).toBe(1)
  expect((await store.loadRequest(advicePlanId))?.status).toBe('researching')
  expect(await store.readJson(advicePlanId, 'advice.json')).toBeDefined()
})

/** P0-3：正文归一化不能把小红书社交面字段当正文摘要持久化。 */
it('P0-3 正文抓取 8/10 成功且 token 零落盘：归一化摘要不得含作者/互动直出', () => {
  const item = xhsFeedToIntelItem({
    noteId: 'n-red', xsecToken: 'secret-token', title: '青甘攻略', author: '作者A',
    likes: 120, comments: 9, collects: 3,
  }, { desc: '正文内容', ipLocation: '青海' }, '2026-09-12T00:00:00.000Z')
  expect(item.source.url).not.toContain('secret-token')
  expect(item.summary).not.toMatch(/作者：|互动：/)
})

/** 旧生产工件兼容：退役 channel 只读可解释，不阻断整条 intel 校验。 */
it('legacy bilibili/douban channel → validateIntelItem 零 issue', () => {
  const base = {
    id: 'legacy-channel', category: 'recommend', title: '旧工件条目', summary: '历史摘要',
    source: source('legacy'), confidence: 'low',
  }
  for (const channel of ['bilibili', 'douban']) {
    expect(validateIntelItem({ ...base, channel })).toEqual([])
  }
})

/** P1-1：路段几何与逐段指标必须进入页面消费面。 */
it('P1-1 leg 级道路几何与逐段 km/min 上页', () => {
  const data = pageData()
  const routeTransport = {
    legs: [{
      id: 'leg-0', fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
      mode: 'driving', status: 'queried', metricStatus: 'queried', geometryStatus: 'queried',
      distanceKm: 321.4, durationMinutes: 245, observedAt: '2026-09-12T00:00:00.000Z',
      geometry: {
        type: 'LineString', coordinates: [[101, 36], [102, 37]], source: 'fixture',
        coordinateSystem: 'WGS84', pointOrder: 'lng,lat',
      },
    }], totalDistanceKm: 321.4, totalDurationMinutes: 245,
  }
  ;(data as unknown as Record<string, unknown>).routeTransport = routeTransport
  const html = renderWithTemplate(data, readFileSync(templatePath(), 'utf8'))
  expect(html).toMatch(/id=["']route-transport|renderRouteTransport/)
})

/** P1-2：上游 summary 与社媒元信息拆分，页面只消费正文/四类归纳。 */
it('P1-2 页面零 raw summary（无「作者：/互动：」直出）+ 四类归纳', () => {
  const item = socialPostToIntelItem({
    platform: 'xhs', noteId: 'raw-red', title: '青甘攻略', content: '正文建议', author: '作者A',
    interactions: { likes: 3, comments: 2 }, url: 'https://example.invalid/raw',
    fetchedAt: '2026-09-12T00:00:00.000Z',
  })
  // ① 既有适配器 fixture 当前仍把 author/interactions 拼进 summary；W2/T4 清理后转绿。
  console.info('P1-2 actual adapter summary:', JSON.stringify(item.summary))
  expect(item.summary).not.toMatch(/作者：|互动：|IP属地：/)

  const insightTexts = ['推荐结论：清晨出发', '避雷结论：高峰拥堵', '指南：带好防晒', '规划：安排两晚']
  const data = pageData({ [item.id]: item })
  ;(data as unknown as Record<string, unknown>).insights = [
    { kind: 'recommend', text: insightTexts[0], scope: 'place', citations: [] },
    { kind: 'avoid', text: insightTexts[1], scope: 'place', citations: [] },
    { kind: 'guide', text: insightTexts[2], scope: 'region', citations: [] },
    { kind: 'plan', text: insightTexts[3], scope: 'theme', citations: [] },
  ]
  const html = renderWithTemplate(data, readFileSync(templatePath(), 'utf8'))
  // ② 不用标签出现次数伪造可见性：页面 artifact 不得携带这条完整 raw summary，
  // 同时必须携带四类可见归纳文本，供后续模板消费。
  expect(html).not.toContain(item.summary)
  for (const text of insightTexts) expect(html).toContain(text)
})

/** P1-3：自动日程需要住宿锚点把相邻日首尾接成一条路线。 */
it('P1-3 日界 placeId 相同（零断点）', () => {
  const result = autoProposeItinerary('plan-route-red', {
    destination: '青甘', dateStart: '2026-09-15', dateEnd: '2026-09-16', days: 2,
  }, [attraction('a', 101, 36), attraction('b', 102, 37)])
  expect(result.built).toBe(true)
  expect(result.days[0]?.stops[0]?.placeId).toBeTruthy()
  expect(result.days[0]?.stops.at(-1)?.placeId).toBe(result.days[1]?.stops[0]?.placeId)
})

/** P1-4：地图页需要统一的 hover/click/keyboard/mobile/reduced-motion 交互。 */
it('P1-4 前端交互契约（hover≤150ms/点击锁定/键盘/移动抽屉/reduced-motion）', () => {
  const template = readFileSync(templatePath(), 'utf8')
  expect(template).toMatch(/mouseenter|mouseover/)
  expect(template).toMatch(/prefers-reduced-motion/)
  expect(template).toMatch(/Escape|keydown/)
  expect(template).toMatch(/drawer|抽屉|mobile/i)
})

/** P1-5：HTTP 边界应拆单 destination，POI 专用查询不得带长引号。 */
it('P1-5 amap distance 单 destination 与 place/text POI 去引号分批', async () => {
  const urls: string[] = []
  const adapter = new AmapAdapter({
    fetchFn: async (url) => {
      urls.push(url)
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: '1', info: 'OK', results: [], pois: [] }) }
    },
  })
  const env = { env: { amapWebservice: 'fixture-key' } }
  await adapter.distanceMatrix([coords(101, 36)], [coords(102, 37), coords(103, 38)], { driving: true }, env)
  await adapter.poiSearch('"茶卡盐湖" 景区', '海西', {}, env)
  expect(urls.filter((url) => url.includes('/distance')).length).toBe(2)
  expect(urls.find((url) => url.includes('/place/text'))).not.toContain('%22')
})

/** P1-6：get_state schema 修复之外，未入账数据仍需显式 unknown 投影。 */
it('P1-6 get_state schema：degraded 扩展字段与未入账 unknown 投影一致', async () => {
  const created = await runIntake({ slots: { destination: '青甘', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 } }, store)
  await store.writeJson(created.planId, 'itinerary.json', {
    itineraryId: 'legacy-it', days: [{ date: '2026-09-15', stops: [], meals: [] }], routeCheck: { issues: [], warnings: [] },
  })
  // Establish a current manifest, then write intel outside its entries: this is the
  // exact unaccounted-file shape, not the legacy no-manifest compatibility path.
  await store.publishArtifacts(created.planId, {
    stage: 'contract', files: [{ name: 'itinerary.json', data: await store.readJson(created.planId, 'itinerary.json') }],
  })
  await store.writeJson(created.planId, 'intel.json', [{ id: 'legacy-intel' }])
  const built = await buildRenderData(store, created.planId)
  const status = built.data?.artifactStatus as Record<string, { state: string }> | undefined
  expect(status?.intel?.state).toBe('unknown')
})

/** P2-1：明显噪音不可凭默认分支落 recommend。 */
it('P2-1 噪音过滤 + 分类不兜底 recommend', () => {
  expect(classifyIntelCategory('成人表单推广', '点击提交手机号领取优惠')).not.toBe('recommend')
})

/** P2-2：未入账工件不可被版本投影当作 stale/current。 */
it('P2-2 未入账=unknown 而非 stale', async () => {
  const created = await runIntake({ slots: { destination: '青甘', dateStart: '2026-09-15', dateEnd: '2026-09-15', days: 1 } }, store)
  await store.writeJson(created.planId, 'itinerary.json', {
    itineraryId: 'it-p2-2', days: [{ date: '2026-09-15', stops: [], meals: [] }], routeCheck: { issues: [], warnings: [] },
  })
  // Keep the manifest modern while deliberately omitting intel.json from its entries.
  await store.publishArtifacts(created.planId, {
    stage: 'contract', files: [{ name: 'itinerary.json', data: await store.readJson(created.planId, 'itinerary.json') }],
  })
  await store.writeJson(created.planId, 'intel.json', [{ id: 'unbooked' }])
  const read = await store.readArtifactWithState<unknown>(created.planId, 'intel.json')
  expect(read.status).toBe('unknown')
  expect(read.status).not.toBe('stale')
})

/** P2-3：自驾日阈值应按 pace=250/350/450，≥600 必告警。 */
it('P2-3 自驾 pace 阈值（250/350/450，≥600 必告警）', async () => {
  const day: ItineraryDay = {
    date: '2026-09-15', stops: [
      { name: 'A', category: 'attraction', coords: coords(100, 35), intelRefs: ['a'] },
      { name: 'B', category: 'attraction', coords: coords(103, 35), intelRefs: ['b'] },
    ], meals: [],
  }
  const stopPlaceIds = new Map([[day.stops[0], 'p1'], [day.stops[1], 'p2']])
  const makeLeg = (distanceKm: number) => ({
    id: `leg-${distanceKm}`, fromPlaceId: 'p1', toPlaceId: 'p2', orderIndex: 0, placesVersion: 1,
    mode: 'driving' as const, status: 'queried' as const, distanceKm,
    observedAt: '2026-09-12T00:00:00.000Z',
  })
  const at350 = await runRouteCheck([day], {
    pace: 'balanced', providers: [createEstimateRouteProvider()], stopPlaceIds,
    routeTransport: [makeLeg(300)],
  })
  const at600 = await runRouteCheck([day], {
    pace: 'balanced', providers: [createEstimateRouteProvider()], stopPlaceIds,
    routeTransport: [makeLeg(600)],
  })
  expect(at350.warnings.filter((warning) => warning.includes('实际驾驶里程'))).toHaveLength(0)
  expect(at600.warnings.some((warning) => warning.includes('超过自驾日里程阈值'))).toBe(true)
})

/** P2-4：成本不得只有 rental/intercity，四个有据组件才算完成。 */
it('P2-4 cost ≥4 组件有据 + estimated 必带 assumptions', async () => {
  const intake = await runIntake({
    slots: { origin: '西宁', destination: '青甘', dateStart: '2026-09-15', dateEnd: '2026-09-17', days: 3,
      travelers: { adults: 2 }, budget: { amount: 10000, currency: 'CNY', scope: 'total' } },
  }, store)
  await seedPlaces(store, intake.planId, { destination: '青甘', origin: '西宁' })
  const lodging: LodgingQuotesArtifact = {
    schemaVersion: 1, placesVersion: 1, inputFingerprint: 'lodging-red', generatedAt: '2026-09-12T00:00:00.000Z',
    quotes: [{ placeId: 'place-entry', quote: {
      range: [300, 400], currency: 'CNY', unit: 'roomNight', checkIn: '2026-09-15', checkOut: '2026-09-17', rooms: 1,
      observedAt: '2026-09-12T00:00:00.000Z', taxStatus: 'included',
    }, source: source('lodging') }], records: [], degraded: [],
  }
  await store.writeJson(intake.planId, 'lodging-quotes.json', lodging)
  const transport: TransportOption[] = [{ mode: 'rail', segments: [], totalPriceRange: [500, 600], currency: 'CNY', source: source('rail') }]
  await store.writeJson(intake.planId, 'transport.json', transport)
  const intel: IntelItem[] = [
    { ...attraction('ticket', 101, 36), avgPrice: 120 },
    { id: 'food', category: 'food', channel: 'web', title: '餐厅', summary: '人均 80 元', avgPrice: 80, source: source('food'), confidence: 'high' },
  ]
  await store.writeJson(intake.planId, 'intel.json', intel)
  const wendao = new WendaoAdapter({ fetchFn: async () => ({ ok: true, status: 200, text: async () => '日租 300-400 元/天' }) })
  const result = await runResearchDestination({
    planId: intake.planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
    quoteRequests: [{ pickupPlaceId: 'place-entry', days: 3 }],
    costEstimates: [
      { component: 'tickets', priceRange: [100, 120], currency: 'CNY', unit: 'person', quantity: 2, quantityBasis: 'people', scope: 'total', source: 'caller fixture', assumptions: ['按两名成人、每人一张门票估算'], evidenceRefs: ['ticket'] },
      { component: 'food', priceRange: [60, 80], currency: 'CNY', unit: 'personDay', quantity: 6, quantityBasis: 'people', scope: 'total', source: 'caller fixture', assumptions: ['按两名成人、三天餐食估算'], evidenceRefs: ['food'] },
    ],
  }, store, { channels: [], wendao, env: { env: { wendao: 'fixture-key' } } })
  const cost = result.cost as CostArtifact | undefined
  const evidenced = Object.values(cost?.components ?? {}).filter((component) => component.status !== 'unavailable')
  expect(evidenced.length).toBeGreaterThanOrEqual(4)
  expect(Object.values(cost?.components ?? {}).filter((component) => component.status === 'estimated')
    .every((component) => component.assumptions.length > 0)).toBe(true)
})
