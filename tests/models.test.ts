/**
 * 模型层校验器单测（design §5.5 字段级契约 + §6 行 518 校验语义）。
 */
import { describe, expect, it } from 'vitest'
import {
  assertValidIssues, computeRequiredMissing, daysBetweenInclusive,
  detectSlotAmbiguities, isDateString, isIsoTimestamp, isValidCoords, isValidSourceRef,
  validateAdvice, validateDaysConsistency, validateIntelItem, validateItinerary,
  validateRequest, validateSlotsFields, validateTransportOption, normalizePublishedAt,
  validateRentalQuotes, validateCostArtifact,
} from '../src/models/validate.js'
import { TravelValidationError } from '../src/errors.js'

describe('基础谓词', () => {
  it('isDateString：YYY-MM-DD 与真实日历（闰年）', () => {
    expect(isDateString('2026-10-01')).toBe(true)
    expect(isDateString('2024-02-29')).toBe(true) // 闰年
    expect(isDateString('2025-02-29')).toBe(false) // 非闰年
    expect(isDateString('2026-13-01')).toBe(false)
    expect(isDateString('2026-10-32')).toBe(false)
    expect(isDateString('2026-10-1')).toBe(false)
    expect(isDateString('20261001')).toBe(false)
    expect(isDateString(20261001)).toBe(false)
  })

  it('isIsoTimestamp：ISO8601（含 T 与偏移）', () => {
    expect(isIsoTimestamp('2026-10-01T08:00:00.000Z')).toBe(true)
    expect(isIsoTimestamp('2026-10-01T16:00:00+08:00')).toBe(true)
    expect(isIsoTimestamp('2026-10-01')).toBe(false)
    expect(isIsoTimestamp('not-a-time')).toBe(false)
  })

  it('isValidCoords / isValidSourceRef', () => {
    expect(isValidCoords({ lng: 120.1, lat: 30.2, sys: 'GCJ02' })).toBe(true)
    expect(isValidCoords({ lng: 200, lat: 30.2, sys: 'GCJ02' })).toBe(false)
    expect(isValidCoords({ lng: 120.1, lat: 30.2, sys: 'WGS84' })).toBe(true)
    expect(isValidCoords({ lng: 120.1, lat: 30.2, sys: 'EPSG:4326' })).toBe(false)
    expect(isValidSourceRef({ platform: 'tencent-poi', url: 'https://x', fetchedAt: '2026-09-01T00:00:00.000Z' })).toBe(true)
    expect(isValidSourceRef({ platform: '', url: 'https://x', fetchedAt: '2026-09-01T00:00:00.000Z' })).toBe(false)
  })

  it('daysBetweenInclusive：含首尾日差', () => {
    expect(daysBetweenInclusive('2026-10-01', '2026-10-01')).toBe(1)
    expect(daysBetweenInclusive('2026-10-01', '2026-10-03')).toBe(3)
    expect(daysBetweenInclusive('2026-12-31', '2027-01-02')).toBe(3)
  })
})

describe('槽位级校验（intake 规则）', () => {
  it('dateEnd<dateStart 拒；dateEnd==dateStart 合法（单日行程）', () => {
    expect(validateSlotsFields({ dateStart: '2026-10-03', dateEnd: '2026-10-01' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.dateEnd' })]))
    expect(validateSlotsFields({ dateStart: '2026-10-01', dateEnd: '2026-10-01' })).toEqual([])
    expect(validateSlotsFields({ dateStart: '2026-10-01', dateEnd: '2026-10-03' })).toEqual([])
  })

  it('日期格式非法拒；days 非正整数拒', () => {
    const issues = validateSlotsFields({ dateStart: '2026/10/01', days: 0 })
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['slots.dateStart', 'slots.days']))
    expect(validateSlotsFields({ days: 3 })).toEqual([])
  })

  it('days 与日期区间不一致拒（QA failure 用例：days=3 但区间 4 天）', () => {
    expect(validateDaysConsistency({ dateStart: '2026-10-01', dateEnd: '2026-10-04', days: 3 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.days' })]))
    expect(validateDaysConsistency({ dateStart: '2026-10-01', dateEnd: '2026-10-04', days: 4 })).toEqual([])
    // 区间缺一半时不算不一致（缺口归 missing）
    expect(validateDaysConsistency({ dateStart: '2026-10-01', days: 3 })).toEqual([])
  })

  it('travelers/budget/preferences 字段级规则', () => {
    expect(validateSlotsFields({ travelers: { adults: 0 } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.travelers.adults' })]))
    expect(validateSlotsFields({ budget: { amount: -5 } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.budget.amount' })]))
    expect(validateSlotsFields(JSON.parse('{"preferences":{"pace":"sprint"}}')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.preferences.pace' })]))
    expect(validateSlotsFields({ travelers: { adults: 2, children: 1 }, budget: { amount: 3000, scope: 'perPerson' }, preferences: { pace: 'relaxed', themes: ['自然'] } })).toEqual([])
  })

  it('plan 模式 destination 必填计入 missing；recommend 模式 destination 不计入 missing', () => {
    const partial: Parameters<typeof computeRequiredMissing>[0] = {}
    expect(computeRequiredMissing(partial, 'plan')).toContain('destination')
    expect(computeRequiredMissing(partial, 'recommend')).not.toContain('destination')
    // 完整 plan 无 missing
    expect(computeRequiredMissing(
      { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 }, 'plan',
    )).toEqual([])
    // recommend 仅缺日期/天数
    expect(computeRequiredMissing({}, 'recommend')).toEqual(['dateStart', 'dateEnd', 'days'])
  })

  it('歧义检测：多候选分隔符', () => {
    expect(detectSlotAmbiguities({ destination: '杭州、苏州' })).toHaveLength(1)
    expect(detectSlotAmbiguities({ destination: '杭州' })).toHaveLength(0)
  })
})

describe('模型级结构校验（§5.5 契约闸门）', () => {
  const validRequest = {
    planId: 'plan-1',
    mode: 'plan',
    status: 'collecting',
    slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
    assumptions: ['未指定预算币种，默认 CNY'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }

  it('validateRequest：完整请求零 issue；坏枚举/坏时间戳/坏日期有 issue', () => {
    expect(validateRequest(validRequest)).toEqual([])
    expect(validateRequest({ ...validRequest, status: 'done' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'status' })]))
    expect(validateRequest({ ...validRequest, createdAt: '2026-09-01' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'createdAt' })]))
    expect(validateRequest({ ...validRequest, slots: { ...validRequest.slots, dateEnd: '2026-10-01' } })).toHaveLength(1)
  })

  it('validateIntelItem：channel/coords/conflictsWith/confidence 字段级', () => {
    const base = {
      id: 'i1', category: 'attraction', channel: 'tencent-poi', title: '西湖',
      summary: '免费，5A', source: { platform: 'x', url: 'https://x', fetchedAt: '2026-09-01T00:00:00.000Z' },
      confidence: 'high',
    }
    expect(validateIntelItem({ ...base, coords: { lng: 120.15, lat: 30.24, sys: 'GCJ02' }, rating: 4.3, conflictsWith: ['i2'] })).toEqual([])
    expect(validateIntelItem({ ...base, channel: 'xhs' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'channel' })]))
    expect(validateIntelItem({ ...base, source: { ...base.source, url: 'javascript:alert(1)' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'source' })]))
    expect(validateIntelItem({ ...base, coords: { lng: 120.15, lat: 30.24, sys: 'GCJ02' }, rating: 9 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'rating' })]))
    expect(validateIntelItem({ ...base, publishedAt: '2026-09-01T08:30:00+08:00' })).toEqual([])
    expect(validateIntelItem({ ...base, publishedAt: '2026-09-01T08:30:00+08:00-nope' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'publishedAt' })]))
    expect(normalizePublishedAt('2026-09-01T08:30:00+08:00')).toBe('2026-09-01')
    expect(normalizePublishedAt('2026-09-01')).toBe('2026-09-01')
    expect(normalizePublishedAt('2026-09-31')).toBeUndefined()
  })

  it('validateTransportOption / validateAdvice / validateItinerary', () => {
    const src = { platform: 'x', url: 'https://x', fetchedAt: '2026-09-01T00:00:00.000Z' }
    expect(validateTransportOption({ mode: 'rail', segments: [{ from: '杭州', to: '上海' }], source: src })).toEqual([])
    expect(validateTransportOption({ mode: 'flight', segments: [], source: src }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'segments' })]))

    expect(validateAdvice({ weather: [{ date: '2026-10-02', source: src, temperatureBasis: 'seasonal-template' }], clothing: ['薄外套'], packingList: [], extraTips: [] })).toEqual([])
    expect(validateAdvice({ weather: [{ date: '2026-10-02', source: src, temperatureBasis: 'untrusted' }], clothing: ['薄外套'], packingList: [], extraTips: [] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'weather[0].temperatureBasis' })]))
    expect(validateAdvice({ weather: [{ date: '10-02', source: src }], clothing: ['薄外套'], packingList: [], extraTips: [] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'weather[0].date' })]))

    const itinerary = {
      itineraryId: 'it-1',
      days: [{
        date: '2026-10-01',
        stops: [{ name: '西湖', category: 'attraction', coords: { lng: 120.15, lat: 30.24, sys: 'GCJ02' }, intelRefs: ['i1'] }],
        meals: [],
      }],
      routeCheck: { issues: [], warnings: ['单日跨度较大'] },
    }
    expect(validateItinerary(itinerary)).toEqual([])
    expect(validateItinerary({ ...itinerary, days: [] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'days' })]))
  })

  it('assertValidIssues 抛 TravelValidationError（路径限定）', () => {
    expect(() => assertValidIssues([{ path: 'slots.days', message: 'bad' }], 'req: '))
      .toThrow(TravelValidationError)
    try {
      assertValidIssues([{ path: 'slots.days', message: '不一致' }])
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('slots.days: 不一致')
    }
  })

  it('T26 validators 拒绝负/混合金额、错误总额与带 userinfo 的租车来源', () => {
    const src = { platform: 'rental', url: 'https://' + 'user:pass@example.invalid/quote', fetchedAt: '2026-09-01T00:00:00.000Z' }
    const rental = {
      schemaVersion: 1, placesVersion: 1, inputFingerprint: 'rental', generatedAt: '2026-09-01T00:00:00.000Z',
      quotes: [{ pickupPlaceId: 'place-a', days: 1, vehicleType: '车型未标明', source: src,
        quote: { range: [10, 20], currency: 'CNY', unit: 'day', observedAt: '2026-09-01T00:00:00.000Z', taxStatus: 'unknown', referenceUrl: 'https://' + 'user:pass@example.invalid/x' } }],
      records: [{ pickupPlaceId: 'place-a', status: 'quoted' }], degraded: [], consultationOnly: true,
      disclaimer: '咨询级、非实时、不可预订',
    }
    const rentalIssues = validateRentalQuotes(rental)
    expect(rentalIssues.some((issue) => issue.path.includes('source'))).toBe(true)
    expect(rentalIssues.some((issue) => issue.path.includes('referenceUrl'))).toBe(true)
    expect(validateRentalQuotes({ ...rental, quotes: [{ ...rental.quotes[0], quote: { ...rental.quotes[0].quote, range: [-1, 20] }, source: { ...src, url: 'https://example.invalid/quote' } }] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'quotes[0].quote.range' })]))

    const component = { min: 0, max: 0, currency: 'CNY', source: 'none', status: 'unavailable' as const, assumptions: ['未计入'] }
    const cost = {
      schemaVersion: 1, placesVersion: 1, inputFingerprint: 'cost', generatedAt: '2026-09-01T00:00:00.000Z', currency: 'CNY',
      components: { intercityTransport: component, lodging: component, rental: component, tickets: component, food: component, misc: component },
      total: { min: 0, max: 0, currency: 'CNY' }, budget: { amount: 0, scope: 'total' as const, currency: 'CNY' }, warnings: [], assumptions: ['未计入'],
    }
    expect(validateCostArtifact({ ...cost, components: { ...cost.components, rental: { ...component, min: -1 } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'components.rental' })]))
    expect(validateCostArtifact({ ...cost, components: { ...cost.components, rental: { ...component, min: 1, max: 1 } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'components.rental' })]))
    expect(validateCostArtifact({ ...cost, components: { ...cost.components, food: { ...component, currency: 'USD' } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'components.food.currency' })]))
    expect(validateCostArtifact({ ...cost, total: { min: 1, max: 1, currency: 'CNY' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'total' })]))
  })

})