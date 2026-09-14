/**
 * B6 T26：租车咨询询价与 cost.json（全离线 fixture）。
 * 红线：咨询级/非实时/不可预订；无可靠金额时不写假区间，只在 cost 中显式未计入。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { parseRentalPrice, runResearchDestination } from '../src/tools/research-destination.js'
import { TravelValidationError } from '../src/errors.js'
import { WendaoAdapter } from '../src/adapters/wendao.js'
import { SearchAdapter } from '../src/adapters/search.js'
import type {
  CostArtifact, IntelItem, LodgingQuotesArtifact, PlacesArtifact, ResolvedPlace, TransportOption,
} from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-rental-cost-'))
  store = new TravelStore(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' }
}

function place(candidateId: string, name: string, kind: ResolvedPlace['kind']): ResolvedPlace {
  return {
    placeId: `place-${candidateId}`,
    candidateId,
    name,
    kind,
    pointKind: kind === 'area' ? 'areaCenter' : 'poi',
    coords: coords(116.4 + (candidateId === 'drop' ? 0.1 : 0), 39.9),
    source: 'amap',
    coordinate_source: 'amap',
    resolveConfidence: 'high',
  }
}

async function makePlan(): Promise<string> {
  const result = await runIntake({
    slots: {
      origin: '北京', destination: '北京周边', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      travelers: { adults: 2 }, budget: { amount: 1000, currency: 'CNY', scope: 'total' },
    },
  }, store)
  expect(result.status).toBe('confirmed')
  return result.planId
}

async function writePlaces(planId: string): Promise<void> {
  const places: ResolvedPlace[] = [place('pickup', '北京首都机场', 'hub'), place('drop', '古北水镇', 'area')]
  const artifact: PlacesArtifact = {
    schemaVersion: 1, intelVersion: 1, inputFingerprint: 'places-rental', generatedAt: '2026-09-09T00:00:00.000Z',
    candidates: [], places, selectedSequence: ['place-pickup', 'place-drop'],
    originResolution: { origin: '北京', resolved: true, coords: coords(116.4, 39.9), entryKind: 'city' },
    pendingClarifications: [], status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  await store.writeJson(planId, 'versions.json', { places: 1, intel: 1 })
}

function wendaoDeps(markdown: string, opts: { fail?: boolean } = {}) {
  let calls = 0
  const wendao = new WendaoAdapter({
    fetchFn: async () => {
      calls += 1
      if (opts.fail === true) throw new Error('wendao unavailable')
      return { ok: true, status: 200, text: async () => markdown }
    },
  })
  return { wendao, calls: () => calls }
}

function searchDeps() {
  let calls = 0
  const search = new SearchAdapter({
    hostSearch: async () => {
      calls += 1
      return {
        content: undefined, truncated: false,
        sources: [{ url: 'https://example.invalid/ddg-rental', title: '5座租车 日租 280-360元/天', snippet: '北京机场取车，咨询价 280-360 元/天' }],
      }
    },
  })
  return { search, calls: () => calls }
}

async function seedCostInputs(planId: string): Promise<void> {
  const lodging: LodgingQuotesArtifact = {
    schemaVersion: 1, placesVersion: 1, inputFingerprint: 'lodging', generatedAt: '2026-09-09T00:00:00.000Z',
    quotes: [{
      placeId: 'place-drop',
      quote: { range: [399, 499], currency: 'CNY', unit: 'roomNight', checkIn: '2026-10-01', checkOut: '2026-10-03', rooms: 1, observedAt: '2026-09-09T00:00:00.000Z', taxStatus: 'included' },
      source: { platform: 'dida-hotel', url: 'https://example.invalid/hotel', fetchedAt: '2026-09-09T00:00:00.000Z' },
    }], records: [], degraded: [],
  }
  await store.writeJson(planId, 'lodging-quotes.json', lodging)
  const transport: TransportOption[] = [{
    mode: 'rail', segments: [], totalPriceRange: [100, 200],
    source: { platform: 'wendao', url: 'https://example.invalid/rail', fetchedAt: '2026-09-09T00:00:00.000Z' },
  }]
  await store.writeJson(planId, 'transport.json', transport)
  const intel: IntelItem[] = [{
    id: 'ticket-1', category: 'attraction', channel: 'web', title: '景点', summary: '门票', avgPrice: 50,
    source: { platform: 'test', url: 'https://example.invalid/ticket', fetchedAt: '2026-09-09T00:00:00.000Z' }, confidence: 'medium',
  }, {
    id: 'food-1', category: 'food', channel: 'web', title: '餐厅', summary: '人均', avgPrice: 60,
    source: { platform: 'test', url: 'https://example.invalid/food', fetchedAt: '2026-09-09T00:00:00.000Z' }, confidence: 'medium',
  }]
  await store.writeJson(planId, 'intel.json', intel)
}

describe('T26 rental-quotes', () => {
  it('Wendao 命中 → 车型/日租区间/取还车点/咨询非预订语义落盘，并生成 cost.json', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    await seedCostInputs(planId)
    const d = wendaoDeps('## 租车咨询\n5座经济型：北京首都机场取车，古北水镇还车，日租 300-450 元/天。')
    const result = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'rental-1',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', dropoffPlaceId: 'place-drop', days: 3, seats: 5 }],
    }, store, { channels: [], wendao: d.wendao, env: { env: { wendao: 'test-token' } } })
    expect(result.rentalQuotes?.quotes[0]?.vehicleType).toContain('经济型')
    expect(result.rentalQuotes?.quotes[0]?.quote.range).toEqual([300, 450])
    expect(result.rentalQuotes?.quotes[0]?.pickupPlaceId).toBe('place-pickup')
    expect(result.rentalQuotes?.quotes[0]?.dropoffPlaceId).toBe('place-drop')
    expect(result.rentalQuotes?.consultationOnly).toBe(true)
    expect(d.calls()).toBe(1)
    const rental = await store.readJson<Record<string, unknown>>(planId, 'rental-quotes.json')
    expect(rental?.quotes).toBeDefined()
    const cost = await store.readJson<CostArtifact>(planId, 'cost.json')
    expect(cost?.components.rental.min).toBe(900)
    expect(cost?.components.rental.max).toBe(1350)
    expect(cost?.components.lodging.min).toBe(798)
    expect(cost?.total.min).toBeLessThanOrEqual(cost!.total.max)
    expect(cost?.warnings.some((warning) => warning.includes('预算'))).toBe(true)
  })

  it('Wendao 失败 → 既有 Search/DDG fallback；同 requestId 重放幂等且不重复调用', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    const w = wendaoDeps('', { fail: true })
    const s = searchDeps()
    const args = {
      planId, phase: 'rental-quotes' as const, expectedPlacesVersion: 1, requestId: 'rental-idem',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }
    const deps = { channels: [], wendao: w.wendao, search: s.search, env: { env: { wendao: 'test-token' } } }
    const first = await runResearchDestination(args, store, deps)
    expect(first.rentalQuotes?.quotes[0]?.source.platform).toBe('search-l0')
    const before = { w: w.calls(), s: s.calls() }
    const second = await runResearchDestination(args, store, deps)
    expect(second.idempotent?.requestId).toBe('rental-idem')
    expect(w.calls()).toBe(before.w)
    expect(s.calls()).toBe(before.s)
  })

  it('缺取车字段 → skipped_missing_stay_context 零渠道记录（不猜、不抛裸错）；全渠道无可靠金额 → degraded 且 rental 不填假区间', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    const w = wendaoDeps('5座租车请先咨询车型与价格，当前未提供金额。')
    // 批准契约 T26：「缺取车上下文 → skipped_missing_stay_context 同款记录（不猜）」
    // ——缺 pickupPlaceId 不是输入类型错误，不得硬拒绝，也不得访问任何渠道。
    const skipped = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ days: 3 }],
    }, store, { channels: [], wendao: w.wendao, env: { env: { wendao: 'test-token' } } })
    expect(skipped.rentalQuotes?.records).toHaveLength(1)
    expect(skipped.rentalQuotes?.records[0]?.status).toBe('skipped_missing_stay_context')
    expect(skipped.rentalQuotes?.records[0]?.reason).toMatch(/pickupPlaceId/)
    expect(skipped.rentalQuotes?.quotes).toHaveLength(0)
    expect(w.calls()).toBe(0) // 缺上下文绝不触发渠道

    const result = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 3 }],
    }, store, { channels: [], wendao: w.wendao, env: { env: { wendao: 'test-token' } } })
    expect(result.rentalQuotes?.records[0]?.status).toBe('blocked')
    expect(w.calls()).toBe(1) // 仅此有效项触发一次渠道调用
    expect(result.rentalQuotes?.quotes).toHaveLength(0)
    const cost = await store.readJson<CostArtifact>(planId, 'cost.json')
    expect(cost?.components.rental.status).toBe('unavailable')
    expect(cost?.components.rental.min).toBe(0)
    expect(cost?.components.rental.assumptions.join(' ')).toMatch(/未计入|可靠/)
  })

  it('价格解析把币种/金额/日单位绑定：押金与租期不误报，局部元表达式不被美元说明污染', () => {
    expect(parseRentalPrice('租车押金300元，最长可租30-60天')).toBeUndefined()
    expect(parseRentalPrice('每天1000元押金，租金面议')).toBeUndefined()
    expect(parseRentalPrice('押金每天300元')).toBeUndefined()
    expect(parseRentalPrice('租期30天，300元/天')).toBeUndefined()
    expect(parseRentalPrice('日租金 300 元')?.range).toEqual([300, 300])
    expect(parseRentalPrice('日租 300-450元/天，不收美元')?.currency).toBe('CNY')
    expect(parseRentalPrice('daily USD 30-40/day')?.currency).toBe('USD')
    expect(parseRentalPrice('EUR 20-30 per day')?.currency).toBe('EUR')
  })

  it('T26 空白 days 归「缺上下文」而非类型错误：skipped 零渠道，与批准契约一致', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    await seedCostInputs(planId)
    const w = wendaoDeps('日租 100元/天')
    // 空串 / 纯空白（表单空值、脚本 JSON 常见）都是「没给租期」，不是「给了非法租期」。
    for (const blank of ['', '   ', '\t']) {
      const result = await runResearchDestination({
        planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
        quoteRequests: [{ pickupPlaceId: 'place-pickup', days: blank as unknown as number }],
      }, store, { channels: [], wendao: w.wendao, env: { env: { wendao: 'test-token' } } })
      expect(result.rentalQuotes?.records[0]?.status).toBe('skipped_missing_stay_context')
      expect(result.rentalQuotes?.records[0]?.reason).toMatch(/days/)
      expect(result.rentalQuotes?.quotes).toHaveLength(0)
    }
    expect(w.calls()).toBe(0) // 缺上下文绝不触发渠道

    // 混合批：有效项照常执行（不被空白项整批覆盖成 skip），有效项仍恰好调用一次渠道。
    const mixed = wendaoDeps('日租 300-450元/天')
    const mixedResult = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [
        { pickupPlaceId: 'place-pickup', days: '  ' as unknown as number },
        { pickupPlaceId: 'place-pickup', days: 2 },
      ],
    }, store, { channels: [], wendao: mixed.wendao, env: { env: { wendao: 'test-token' } } })
    expect(mixed.calls()).toBe(1)
    expect((mixedResult.rentalQuotes?.records ?? []).map((r) => r.status).sort())
      .toEqual(['quoted', 'skipped_missing_stay_context'])
    expect(mixedResult.rentalQuotes?.quotes).toHaveLength(1)
  })

  it('T26 days 的「提供了值但非法」仍硬拒绝：null/非空字符串/NaN/Infinity/0/小数', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    const illegal: unknown[] = [null, '2', '兩個', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, true]
    for (const days of illegal) {
      await expect(runResearchDestination({
        planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
        quoteRequests: [{ pickupPlaceId: 'place-pickup', days }],
      }, store, { channels: [], wendao: wendaoDeps('日租 1-2元/天').wendao, env: { env: { wendao: 'test-token' } } }))
        .rejects.toBeInstanceOf(TravelValidationError)
    }
    // 未提供（undefined）仍是缺上下文路径，不抛。
    const omitted = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup' }],
    }, store, { channels: [], wendao: wendaoDeps('日租 1-2元/天').wendao, env: { env: { wendao: 'test-token' } } })
    expect(omitted.rentalQuotes?.records[0]?.status).toBe('skipped_missing_stay_context')
  })

  it('价格解析拒绝同表达式多币种冲突，正常单一币种仍通过', () => {
    // 同一表达式内出现互相冲突的币种 marker → 整条放弃（不得改用其它 pattern
    // 捞回成单一币种）；错标币种会让 cost 把外币金额当预算币种，比不报价危险。
    expect(parseRentalPrice('日租 USD 300 元')).toBeUndefined()
    expect(parseRentalPrice('USD 300元/天')).toBeUndefined()
    expect(parseRentalPrice('300元 USD/天')).toBeUndefined()
    // 正常单一币种不受影响。
    expect(parseRentalPrice('日租 300-450元/天')?.currency).toBe('CNY')
    expect(parseRentalPrice('日租金 300 元')?.currency).toBe('CNY')
    expect(parseRentalPrice('CNY 300-450/天')?.currency).toBe('CNY')
    expect(parseRentalPrice('daily USD 30-40/day')?.currency).toBe('USD')
    expect(parseRentalPrice('EUR 20-30 per day')?.currency).toBe('EUR')
    // 匹配跨度之外的币种说明不污染（既有语义保持）。
    expect(parseRentalPrice('日租 300 元，不收美元')?.currency).toBe('CNY')
    // 紧邻前置 marker 也算同一价格表达式：`USD 300 EUR/day` 的 USD 必须在
    // 匹配跨度之内被看见，否则 300 会被错标成 300 EUR。
    expect(parseRentalPrice('USD 300 EUR/day')).toBeUndefined()
    expect(parseRentalPrice('USD 300 欧元/天')).toBeUndefined()
    expect(parseRentalPrice('美元 300 EUR/day')).toBeUndefined()
  })

  it('紧邻前置币种 marker 只收紧同一价格表达式，不把远处说明误判为冲突', () => {
    // 正常单币种（前置 marker 与金额同币种）不受影响。
    expect(parseRentalPrice('USD 30-40/day')?.currency).toBe('USD')
    expect(parseRentalPrice('CNY 300-450/天')?.currency).toBe('CNY')
    expect(parseRentalPrice('EUR 20-30 per day')?.currency).toBe('EUR')
    // 说明性文字（相隔整句/超出紧邻窗口）不构成冲突。
    expect(parseRentalPrice('日租 300-450元/天，不收美元')?.currency).toBe('CNY')
    expect(parseRentalPrice('日租 300 元，不接受 USD 支付')?.currency).toBe('CNY')
    expect(parseRentalPrice('价格以人民币结算，可另付 USD 押金；日租 300 元/天')?.currency).toBe('CNY')
  })

  it('运行时输入闸门拒绝冲突数组、非数组、NaN、伪对象与错误 dropoff 类型', async () => {
    const planId = await makePlan()
    const deps = { channels: [] as const }
    const cases: unknown[] = [
      { quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 1 }], rentalQuoteRequests: [{ pickupPlaceId: 'place-pickup', days: 1 }] },
      { quoteRequests: { pickupPlaceId: 'place-pickup', days: 1 } },
      { quoteRequests: [{ pickupPlaceId: 'place-pickup', days: Number.NaN }] },
      { quoteRequests: [new Date()] },
      { quoteRequests: [{ pickupPlaceId: 'place-pickup', dropoffPlaceId: 123, days: 1 }] },
      { quoteRequests: [{ pickupPlaceId: 'place-pickup', days: Number.POSITIVE_INFINITY }] },
    ]
    for (const input of cases) {
      await expect(runResearchDestination({ planId, phase: 'rental-quotes', ...(input as object) }, store, deps))
        .rejects.toBeInstanceOf(TravelValidationError)
    }
  })

  it('未知 place 全批零渠道且不覆盖既有成功租车/成本工件', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    const firstDeps = wendaoDeps('5座经济型日租 300-450元/天')
    await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'known',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: firstDeps.wendao, env: { env: { wendao: 'test-token' } } })
    const beforeRental = await store.readJson(planId, 'rental-quotes.json')
    const beforeCost = await store.readJson(planId, 'cost.json')
    const blocked = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'unknown-place', days: 2 }],
    }, store, { channels: [], wendao: wendaoDeps('').wendao, env: { env: { wendao: 'test-token' } } })
    expect(blocked.rentalQuotes?.records[0]?.status).toBe('rejected')
    expect(await store.readJson(planId, 'rental-quotes.json')).toEqual(beforeRental)
    expect(await store.readJson(planId, 'cost.json')).toEqual(beforeCost)
  })

  it('健康/版本门在幂等前执行：expected stale、failed places、research stale 均零渠道不覆盖', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    const first = wendaoDeps('日租 300-450元/天')
    await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'health-idem',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: first.wendao, env: { env: { wendao: 'test-token' } } })
    const beforeRental = await store.readJson(planId, 'rental-quotes.json')
    const beforeCost = await store.readJson(planId, 'cost.json')
    const expectedResearchCalls = wendaoDeps('日租 1-2元/天')
    const expectedResearchStale = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, expectedResearchVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: expectedResearchCalls.wendao, env: { env: { wendao: 'test-token' } } })
    expect(expectedResearchStale.rentalQuotes?.records[0]?.reason).toMatch(/expectedResearchVersion/)
    expect(expectedResearchCalls.calls()).toBe(0)

    await store.writeJson(planId, 'versions.json', { places: 2, intel: 1 })
    const staleCalls = wendaoDeps('日租 1-2元/天')
    const stale = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'health-idem',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: staleCalls.wendao, env: { env: { wendao: 'test-token' } } })
    expect(stale.idempotent).toBeUndefined()
    expect(staleCalls.calls()).toBe(0)
    expect(await store.readJson(planId, 'rental-quotes.json')).toEqual(beforeRental)
    expect(await store.readJson(planId, 'cost.json')).toEqual(beforeCost)

    await store.writeJson(planId, 'versions.json', { places: 1, intel: 1 })
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'places', inputFingerprint: 'failed', upstreamVersions: {}, contentHash: {}, status: 'failed', generatedAt: new Date().toISOString(),
    })
    const failedCalls = wendaoDeps('日租 1-2元/天')
    const failed = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'health-idem',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: failedCalls.wendao, env: { env: { wendao: 'test-token' } } })
    expect(failed.idempotent).toBeUndefined()
    expect(failedCalls.calls()).toBe(0)

    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'other', inputFingerprint: 'legacy', upstreamVersions: {}, contentHash: {}, status: 'success', generatedAt: new Date().toISOString(),
    })
    await store.saveResearchState(planId, {
      schemaVersion: 1, researchVersion: 2, updatedAt: new Date().toISOString(), rounds: [],
      budget: { usedRounds: 1, maxRoundsPerPlan: 4, exhausted: false }, sources: [], itemIndex: [],
    })
    const researchCalls = wendaoDeps('日租 1-2元/天')
    const researchStale = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: researchCalls.wendao, env: { env: { wendao: 'test-token' } } })
    expect(researchStale.rentalQuotes?.records[0]?.reason).toMatch(/researchVersion/)
    expect(researchCalls.calls()).toBe(0)
  })

  it('places.json 被篡改（unknown/unaccounted）同样零渠道且不覆盖既有成功工件', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    const first = wendaoDeps('日租 300-450元/天')
    await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'tamper-idem',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: first.wendao, env: { env: { wendao: 'test-token' } } })
    const beforeRental = await store.readJson(planId, 'rental-quotes.json')
    const beforeCost = await store.readJson(planId, 'cost.json')
    // 篡改发生在 places 发布之后：places.json 由 writeJson 直写、从未经 publishArtifacts
    // 入账 → round3 manifest 中无该工件条目。round3 仲裁后该状态标签是
    // unknown/unaccounted（P2-2：未入账不得伪装 current/stale），但「无法验证完整性」
    // 的门控语义与旧的 not_in_commit 完全一致 —— 仍必须零渠道阻断、不覆盖既有工件。
    const meta = await store.readJson<Record<string, unknown>>(planId, 'artifact-meta.json')
    await store.writeJson(planId, 'artifact-meta.json', { ...meta!, stage: 'places' })
    const tamperState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
    expect(tamperState.status).toBe('unknown')
    expect(tamperState.staleReason).toBe('unaccounted')
    const tamperCalls = wendaoDeps('日租 1-2元/天')
    const tampered = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'tamper-idem',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: tamperCalls.wendao, env: { env: { wendao: 'test-token' } } })
    expect(tamperCalls.calls()).toBe(0)
    expect(tampered.idempotent).toBeUndefined()
    expect(tampered.rentalQuotes?.records[0]?.reason).toMatch(/places_stale/)
    expect(await store.readJson(planId, 'rental-quotes.json')).toEqual(beforeRental)
    expect(await store.readJson(planId, 'cost.json')).toEqual(beforeCost)
  })

  it('住宿按报价实际 1 晚，租车两条独立 days 求和，不取 envelope', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    await seedCostInputs(planId)
    const oneNightLodging = await store.readJson<LodgingQuotesArtifact>(planId, 'lodging-quotes.json')
    oneNightLodging!.quotes[0]!.quote.checkOut = '2026-10-02'
    await store.writeJson(planId, 'lodging-quotes.json', oneNightLodging)
    const w = wendaoDeps('日租 300-450元/天')
    const result = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [
        { pickupPlaceId: 'place-pickup', days: 2 },
        { pickupPlaceId: 'place-pickup', dropoffPlaceId: 'place-drop', days: 3 },
      ],
    }, store, { channels: [], wendao: w.wendao, env: { env: { wendao: 'test-token' } } })
    const cost = result.cost!
    expect(cost.components.lodging.min).toBe(399) // fixture patched to 2026-10-01→10-02 = 1 night
    expect(cost.components.rental.min).toBe(1500)
    expect(cost.components.rental.max).toBe(2250)
    expect(cost.total.min).toBe(Object.values(cost.components).reduce((sum, c) => sum + c.min, 0))
  })

  it('缺 days 仅报缺上下文；混合批（有效 + 缺上下文）各自记录且只调用一次渠道', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    await seedCostInputs(planId)
    const missingDays = wendaoDeps('日租 100元/天')
    const onlyMissing = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup' }],
    }, store, { channels: [], wendao: missingDays.wendao, env: { env: { wendao: 'test-token' } } })
    expect(onlyMissing.rentalQuotes?.records[0]?.status).toBe('skipped_missing_stay_context')
    expect(onlyMissing.rentalQuotes?.records[0]?.reason).toMatch(/days/)
    expect(onlyMissing.rentalQuotes?.quotes).toHaveLength(0)
    expect(missingDays.calls()).toBe(0)

    const mixed = wendaoDeps('日租 100-200元/天')
    const result = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }, { days: 3 }],
    }, store, { channels: [], wendao: mixed.wendao, env: { env: { wendao: 'test-token' } } })
    expect(mixed.calls()).toBe(1) // 只有有效项触发渠道
    const statuses = (result.rentalQuotes?.records ?? []).map((r) => r.status).sort()
    expect(statuses).toEqual(['quoted', 'skipped_missing_stay_context'])
    expect(result.rentalQuotes?.quotes).toHaveLength(1)
    // 缺上下文项不进 cost：租车只按有效项的 days 求和。
    expect(result.cost?.components.rental.min).toBe(200)
    expect(result.cost?.components.rental.max).toBe(400)
  })

  it('仅缺上下文批不覆盖既有成功 rental/cost 工件', async () => {
    const planId = await makePlan()
    await writePlaces(planId)
    await seedCostInputs(planId)
    await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1, requestId: 'seed-ok',
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 2 }],
    }, store, { channels: [], wendao: wendaoDeps('日租 300-450元/天').wendao, env: { env: { wendao: 'test-token' } } })
    const beforeRental = await store.readJson(planId, 'rental-quotes.json')
    const beforeCost = await store.readJson(planId, 'cost.json')
    const onlyMissing = wendaoDeps('日租 1-2元/天')
    const result = await runResearchDestination({
      planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ days: 5 }],
    }, store, { channels: [], wendao: onlyMissing.wendao, env: { env: { wendao: 'test-token' } } })
    expect(result.rentalQuotes?.records[0]?.status).toBe('skipped_missing_stay_context')
    expect(onlyMissing.calls()).toBe(0)
    // 仅缺上下文批不落盘（无有效询价证据），既有成功工件保持原样。
    expect(await store.readJson(planId, 'rental-quotes.json')).toEqual(beforeRental)
    expect(await store.readJson(planId, 'cost.json')).toEqual(beforeCost)
  })

  it('住宿币种严格闸门：USD 预算只收 USD 报价，混币/空币种绝不重标', async () => {
    const usd = await runIntake({ slots: {
      origin: '北京', destination: '北京周边', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      travelers: { adults: 2 }, budget: { amount: 5000, currency: 'USD', scope: 'total' },
    } }, store)
    await writePlaces(usd.planId)
    await store.writeJson(usd.planId, 'lodging-quotes.json', {
      schemaVersion: 1, placesVersion: 1, inputFingerprint: 'l-usd-only', generatedAt: '2026-09-09T00:00:00.000Z',
      quotes: [{
        placeId: 'place-drop',
        quote: { range: [100, 150], currency: 'USD', unit: 'roomNight', checkIn: '2026-10-01', checkOut: '2026-10-03', rooms: 1, observedAt: '2026-09-09T00:00:00.000Z', taxStatus: 'included' },
        source: { platform: 'dida-hotel', url: 'https://example.invalid/h', fetchedAt: '2026-09-09T00:00:00.000Z' },
      }], records: [], degraded: [],
    } satisfies LodgingQuotesArtifact)
    const usdOnly = await runResearchDestination({
      planId: usd.planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 1 }],
    }, store, { channels: [], wendao: wendaoDeps('日租 30-40 USD/day').wendao, env: { env: { wendao: 'test-token' } } })
    // 2 晚 × 1 间：100/150 → 200/300，币种保持 USD（未被重标）。
    expect(usdOnly.cost?.components.lodging.min).toBe(200)
    expect(usdOnly.cost?.components.lodging.max).toBe(300)
    expect(usdOnly.cost?.components.lodging.currency).toBe('USD')

    // 混币：CNY 报价不得被当成 USD 计入；只有 USD 那条进入 ranges。
    const mixedPlan = await runIntake({ slots: {
      origin: '北京', destination: '北京周边', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      travelers: { adults: 2 }, budget: { amount: 5000, currency: 'USD', scope: 'total' },
    } }, store)
    await writePlaces(mixedPlan.planId)
    await store.writeJson(mixedPlan.planId, 'lodging-quotes.json', {
      schemaVersion: 1, placesVersion: 1, inputFingerprint: 'l-mixed', generatedAt: '2026-09-09T00:00:00.000Z',
      quotes: [
        { placeId: 'place-drop', quote: { range: [100, 150], currency: 'USD', unit: 'roomNight', checkIn: '2026-10-01', checkOut: '2026-10-02', rooms: 1, observedAt: '2026-09-09T00:00:00.000Z', taxStatus: 'included' }, source: { platform: 'dida-hotel', url: 'https://example.invalid/h1', fetchedAt: '2026-09-09T00:00:00.000Z' } },
        { placeId: 'place-drop', quote: { range: [7000, 9000], currency: 'CNY', unit: 'roomNight', checkIn: '2026-10-01', checkOut: '2026-10-02', rooms: 1, observedAt: '2026-09-09T00:00:00.000Z', taxStatus: 'included' }, source: { platform: 'dida-hotel', url: 'https://example.invalid/h2', fetchedAt: '2026-09-09T00:00:00.000Z' } },
        { placeId: 'place-drop', quote: { range: [1, 2], currency: '   ', unit: 'roomNight', checkIn: '2026-10-01', checkOut: '2026-10-02', rooms: 1, observedAt: '2026-09-09T00:00:00.000Z', taxStatus: 'unknown' }, source: { platform: 'dida-hotel', url: 'https://example.invalid/h3', fetchedAt: '2026-09-09T00:00:00.000Z' } },
      ], records: [], degraded: [],
    } satisfies LodgingQuotesArtifact)
    const mixed = await runResearchDestination({
      planId: mixedPlan.planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 1 }],
    }, store, { channels: [], wendao: wendaoDeps('日租 30-40 USD/day').wendao, env: { env: { wendao: 'test-token' } } })
    // 只有 USD [100,150] × 1 晚计入；CNY 7000~9000 与空币种 1~2 均不得进入。
    expect(mixed.cost?.components.lodging.min).toBe(100)
    expect(mixed.cost?.components.lodging.max).toBe(150)
    expect(mixed.cost?.components.lodging.currency).toBe('USD')
    const warnings = mixed.cost?.warnings.join(' ') ?? ''
    expect(warnings).toMatch(/非 USD 币种/)
    expect(warnings).toMatch(/未明确币种/)
  })

  it('预算 USD 时未明确币种的 legacy transport 不被重标为 USD', async () => {
    const intake = await runIntake({ slots: {
      origin: '北京', destination: '北京周边', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      travelers: { adults: 1 }, budget: { amount: 5000, currency: 'USD', scope: 'total' },
    } }, store)
    await writePlaces(intake.planId)
    await store.writeJson(intake.planId, 'transport.json', [{
      mode: 'rail', segments: [], totalPriceRange: [100, 200],
      source: { platform: 'legacy', url: 'https://example.invalid/rail', fetchedAt: '2026-09-09T00:00:00.000Z' },
    } satisfies TransportOption])
    const w = wendaoDeps('日租 30-40 USD/day')
    const result = await runResearchDestination({
      planId: intake.planId, phase: 'rental-quotes', expectedPlacesVersion: 1,
      quoteRequests: [{ pickupPlaceId: 'place-pickup', days: 1 }],
    }, store, { channels: [], wendao: w.wendao, env: { env: { wendao: 'test-token' } } })
    expect(result.cost?.components.intercityTransport.status).toBe('unavailable')
    expect(result.cost?.components.intercityTransport.currency).toBe('USD')
    expect(result.cost?.warnings.join(' ')).toMatch(/未明确币种|无汇率/)
  })
})
