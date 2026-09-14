/**
 * W3 T13 advice 按已解析地点归属天气（草稿 E 段）。
 *
 * 验收（T13 Acceptance）：
 * - fixture 多地点（西宁/敦煌/大柴旦）→ 天气条目按 placeId/location 归属正确
 *   （不得以西宁代表整条环线；entries 逐地独立）
 * - 无逐地日期 → 按所选城市查询旅行窗口 + 显式标注（placeDateAssigned=false）
 * - 有逐地日期（placeDates）→ 查对应日（placeDateAssigned=true）
 * - 交通 degraded → advice 仍执行（独立于 transport，不取消天气研究）
 * - 某地无坐标/该地渠道不可用 → 该地明确未获取/气候概况（不挪用他地数据冒充）
 *
 * 全确定性 fixture（open-meteo 按 URL 经纬度返回逐地数据），零真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchAdvice, createTravelResearchAdviceTool, ADVICE_TIMEOUT_MS } from '../src/tools/research-advice.js'
import { runResolvePlaces, type GeocoderProvider } from '../src/tools/resolve-places.js'
import { runRecordResearchAssessment } from '../src/tools/research-assessment.js'
import { OpenMeteoAdapter } from '../src/adapters/open-meteo.js'
import { SearchAdapter, type HostSearchFn } from '../src/adapters/search.js'
import { validateAdvice } from '../src/models/validate.js'
import type { PlacesArtifact, ResolvedPlace } from '../src/models/types.js'

let root: string
let store: TravelStore

/**
 * 固定基准日期（仅测试时钟，生产语义不变）：
 * Open-Meteo 适配器按真实 UTC today 夹取预报窗口 today..today+15（P2-B 语义，正确行为）。
 * 本文件 fixture 的旅行窗口固定为 2026-09-10~2026-09-12，若真实系统日期晚于旅行首日，
 * 窗口被夹取后首日落到 climate-overview 兜底（三地同为 [10,25]）→ 逐地温度断言偶发相等。
 * 故把文件基准日期显式钉在旅行首日 2026-09-10，使三地坐标都经 Open-Meteo stub 产出
 * 各自不同的温度（确定性，不依赖运行机器日期）。
 */
const FIXTURE_NOW = new Date('2026-09-10T08:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXTURE_NOW)
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-advice-qg-'))
  store = new TravelStore(root)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function coords(lng: number, lat: number): { lng: number; lat: number; sys: 'GCJ02' } {
  return { lng, lat, sys: 'GCJ02' as const }
}

function place(candidateId: string, name: string, opts: { coords?: { lng: number; lat: number; sys: 'GCJ02' } } = {}): ResolvedPlace {
  return {
    placeId: `place-${candidateId}`,
    candidateId,
    name,
    kind: 'attraction',
    pointKind: 'poi',
    ...(opts.coords ? { coords: opts.coords } : {}),
    source: opts.coords ? 'amap' : 'unresolved',
    coordinate_source: opts.coords ? 'amap' : 'unresolved',
    resolveConfidence: opts.coords ? 'high' : 'low',
  }
}

/** open-meteo stub：从 URL 解析 lat/lng/窗口，返回逐地不同的温度（离线）。 */
function openMeteoStub(opts: { failFor?: (url: string) => boolean } = {}) {
  const calls: string[] = []
  const fetchFn = async (url: string) => {
    calls.push(url)
    if (opts.failFor?.(url) === true) throw new Error('Open-Meteo HTTP 400（窗口超限模拟）')
    const u = new URL(url)
    const lng = Number(u.searchParams.get('longitude') ?? '0')
    const start = u.searchParams.get('start_date') ?? ''
    const end = u.searchParams.get('end_date') ?? ''
    const dates: string[] = []
    const d = new Date(`${start}T00:00:00.000Z`)
    while (d.toISOString().slice(0, 10) <= end && dates.length < 16) {
      dates.push(d.toISOString().slice(0, 10))
      d.setUTCDate(d.getUTCDate() + 1)
    }
    const base = Math.round((Math.abs(lng) * 10) % 8)
    return { ok: true, status: 200, text: async () => JSON.stringify({
      daily: {
        time: dates,
        temperature_2m_max: dates.map((_, i) => base + i + 10),
        temperature_2m_min: dates.map((_, i) => base + i),
        weathercode: dates.map(() => 1),
      },
    }) }
  }
  return { adapter: new OpenMeteoAdapter({ fetchFn }), calls }
}

function l0HostSearch(hits: Array<{ url: string; title: string; snippet?: string }>): HostSearchFn {
  return async () => ({ content: undefined, sources: hits, truncated: false })
}

async function makePlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      destination: '青甘环线',
      dateStart: '2026-09-10',
      dateEnd: '2026-09-12',
      days: 3,
      researchIntent: { text: '青甘环线（西宁-敦煌-大柴旦）' },
      ...slots,
    },
  }, store)
  return result.planId
}

/** 装配 places.json（三地 + 可选无坐标地）。 */
async function writePlaces(planId: string, places: ResolvedPlace[], selectedSequence: string[]): Promise<void> {
  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: 1,
    inputFingerprint: 'fp-advice',
    generatedAt: '2026-09-02T01:00:00.000Z',
    candidates: [],
    places,
    selectedSequence,
    originResolution: { origin: '北京', resolved: true, coords: coords(101.8, 36.6), entryKind: 'city' },
    pendingClarifications: [],
    status: 'ready',
  }
  await store.writeJson(planId, 'places.json', artifact)
  await store.writeJson(planId, 'versions.json', { places: 1 })
}

function qingganPlaces(extra: ResolvedPlace[] = []): ResolvedPlace[] {
  return [
    place('xining', '西宁', { coords: coords(101.8, 36.6) }),
    place('dunhuang', '敦煌', { coords: coords(94.8, 40.0) }),
    place('dachaidan', '大柴旦', { coords: coords(95.3, 37.8) }),
    ...extra,
  ]
}

function deps(opts: { failForOpenMeteo?: (url: string) => boolean } = {}) {
  const om = openMeteoStub({ failFor: opts.failForOpenMeteo })
  return {
    openMeteo: om.adapter,
    search: new SearchAdapter({ hostSearch: l0HostSearch([
      { url: 'https://example.invalid/climate', title: '青甘 9月 平均气温 10~25℃', snippet: '历史同期' },
    ]) }),
    env: { env: {} },
    omCalls: om.calls,
  }
}

describe('T13 按已解析地点逐地归属天气', () => {
  it('三地（西宁/敦煌/大柴旦）→ 天气条目按 placeId/location 归属正确，不以西宁代表整条环线', async () => {
    const planId = await makePlan()
    await writePlaces(planId, qingganPlaces(), ['xining', 'dunhuang', 'dachaidan'])
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)

    // 每地各 3 天（旅行窗口）
    const byPlace = new Map<string, typeof result.weather>()
    for (const w of result.weather) {
      expect(w.placeId).toBeDefined()
      expect(w.location).toBeDefined()
      const list = byPlace.get(w.placeId!) ?? []
      list.push(w)
      byPlace.set(w.placeId!, list)
    }
    expect(byPlace.size).toBe(3)
    const nameByPid = { 'place-xining': '西宁', 'place-dunhuang': '敦煌', 'place-dachaidan': '大柴旦' } as Record<string, string>
    for (const [pid, entries] of byPlace) {
      expect(entries.length).toBe(3)
      expect(entries.every((e) => e.location === nameByPid[pid])).toBe(true)
    }
    const xining = byPlace.get('place-xining')!
    expect(xining.every((e) => e.location === '西宁')).toBe(true)
    // 天气条目逐地独立（tempRange 来自各自坐标 → 不同 base）
    const dunhuang = byPlace.get('place-dunhuang')!
    const dachaidan = byPlace.get('place-dachaidan')!
    expect(dunhuang[0]!.tempRange![0]).not.toBe(dachaidan[0]!.tempRange![0])
    // advice.json 落盘 + 校验通过
    const persisted = await store.readJson<{ weather: Array<{ placeId?: string }> }>(planId, 'advice.json')
    expect(persisted?.weather.every((w) => typeof w.placeId === 'string')).toBe(true)
  })

  it('无逐地日期 → 按旅行窗口查询 + placeDateAssigned=false 显式标注', async () => {
    const planId = await makePlan()
    await writePlaces(planId, qingganPlaces(), ['xining', 'dunhuang'])
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    expect(result.weather.length).toBe(6) // 2 地 × 3 天
    expect(result.weather.every((w) => w.placeDateAssigned === false)).toBe(true)
    const dates = new Set(result.weather.map((w) => w.date))
    expect([...dates].sort()).toEqual(['2026-09-10', '2026-09-11', '2026-09-12'])
    // 显式标注文本（无逐地日期）
    expect(validateAdvice({ weather: result.weather, clothing: result.clothing, packingList: result.packingList, extraTips: result.extraTips }).length).toBe(0)
  })

  it('有逐地日期（placeDates）→ 查对应日 + placeDateAssigned=true；其余地点仍窗口标注', async () => {
    const planId = await makePlan()
    await writePlaces(planId, qingganPlaces(), ['xining', 'dunhuang'])
    const d = deps()
    const result = await runResearchAdvice({
      planId,
      placeDates: [{ placeId: 'place-xining', dates: ['2026-09-11', '2026-09-13'] }],
    }, store, d)
    const xining = result.weather.filter((w) => w.placeId === 'place-xining')
    expect(xining.every((w) => w.placeDateAssigned === true)).toBe(true)
    expect(xining.map((w) => w.date).sort()).toEqual(['2026-09-11', '2026-09-13'])
    const dunhuang = result.weather.filter((w) => w.placeId === 'place-dunhuang')
    expect(dunhuang.every((w) => w.placeDateAssigned === false)).toBe(true)
    expect(dunhuang.length).toBe(3) // 窗口
  })

  it('交通 degraded（transport/route-transport 不可用）→ advice 仍执行且天气可用', async () => {
    const planId = await makePlan()
    await writePlaces(planId, qingganPlaces(), ['xining', 'dunhuang'])
    const now = new Date().toISOString()
    await store.recordDegraded(planId, { source: 'rail12306', code: 'UNAVAILABLE', reason: '12306 MCP 不可达（交通研究失败）', at: now })
    await store.writeJson(planId, 'route-transport.json', {
      schemaVersion: 1, placesVersion: 1, inputFingerprint: 'fp-rt', generatedAt: now,
      legs: [{ id: 'leg-0-a-b', fromPlaceId: 'place-xining', toPlaceId: 'place-dunhuang', orderIndex: 0, placesVersion: 1, mode: 'driving', status: 'unavailable', estimateReason: '全部渠道失败', observedAt: now }],
      degraded: [{ source: 'route/amap', code: 'UNAVAILABLE', reason: '渠道失败', at: now }],
    })
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    expect(result.weather.length).toBeGreaterThanOrEqual(6) // 交通失败不取消天气
    expect(result.weather.every((w) => w.placeId !== undefined)).toBe(true)
    const persisted = await store.readJson<unknown>(planId, 'advice.json')
    expect(persisted).toBeDefined()
  })

  it('某地无坐标且该地渠道不可用 → 该地明确气候概况（不挪用他地数据冒充）', async () => {
    const planId = await makePlan()
    const mangya = place('mangya', '茫崖') // 无坐标
    await writePlaces(planId, qingganPlaces([mangya]), ['xining', 'dunhuang', 'dachaidan', 'mangya'])
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    const mangyaEntries = result.weather.filter((w) => w.placeId === 'place-mangya')
    expect(mangyaEntries.length).toBe(3)
    // 无坐标 → 不能从腾讯/Open-Meteo（需坐标）取数 → 全部气候概况，来源非 open-meteo/tencent
    expect(mangyaEntries.every((w) => w.beyondForecastWindow === true)).toBe(true)
    expect(mangyaEntries.every((w) => w.source.platform === 'climate-overview')).toBe(true)
    // 不挪用他地数据：茫崖条目全部来自气候概况（非 open-meteo/tencent 坐标渠道）且 location 为茫崖自身
    expect(mangyaEntries.every((w) => w.location === '茫崖')).toBe(true)
    expect(mangyaEntries.every((w) => w.source.platform === 'climate-overview')).toBe(true)
    // 有坐标的其他地点照常产出预报（不受茫崖影响）
    const xining = result.weather.filter((w) => w.placeId === 'place-xining')
    expect(xining.length).toBe(3)
    expect(xining.some((w) => w.beyondForecastWindow !== true)).toBe(true) // 有坐标 → 真实预报而非气候概况
  })

  it('C4 研究已前进（places.intelVersion 落后当前研究版本）→ 不消费旧 places，结构化 blocked 且零网络', async () => {
    const planId = await makePlan()
    await writePlaces(planId, qingganPlaces(), ['xining', 'dunhuang', 'dachaidan'])
    // 研究前进到 v2：research-state.researchVersion=2（places.intelVersion=1）
    await store.saveResearchState(planId, {
      schemaVersion: 1,
      researchVersion: 2,
      updatedAt: '2026-09-02T00:00:00.000Z',
      rounds: ['round-2'],
      budget: { usedRounds: 2, maxRoundsPerPlan: 16, exhausted: false },
      sources: ['tencent-poi'],
      itemIndex: [],
    })
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe('places_not_ready')
    expect(result.weather).toHaveLength(0)
    // degraded 注明研究版本过期（而非默默消费旧坐标）
    expect(result.degraded.some((e) => /研究版本/.test(e.reason))).toBe(true)
    // 零网络：不产生任何逐地天气调用
    expect(d.omCalls).toHaveLength(0)
  })

  it('C4 业务状态过滤：needs_clarification/blocked 候选（带坐标）不参与逐地天气且不挪用他地数据', async () => {
    const planId = await makePlan()
    // pendingClarification（需澄清）与 excludeReason（blocked）候选即使带坐标也不做天气对象
    const pendingWithCoords: ResolvedPlace = {
      ...place('p1', '待确认景点', { coords: coords(96.0, 38.5) }),
      pendingClarification: '同名/地域冲突待澄清',
    }
    const blockedWithCoords: ResolvedPlace = {
      ...place('p2', '已排除景点', { coords: coords(97.0, 39.0) }),
      excludeReason: '解析渠道不可用（degraded）',
    }
    await writePlaces(planId,
      [place('xining', '西宁', { coords: coords(101.8, 36.6) }), place('dunhuang', '敦煌', { coords: coords(94.8, 40.0) }), pendingWithCoords, blockedWithCoords],
      ['xining', 'dunhuang', 'p1', 'p2'])
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    // 只有 ready 候选参与天气；pending/blocked 候选不产出任何条目（不借用其坐标/他地数据）
    const pids = new Set(result.weather.map((w) => w.placeId))
    expect(pids.has('place-p1')).toBe(false)
    expect(pids.has('place-p2')).toBe(false)
    expect(pids.has('place-xining')).toBe(true)
    expect(pids.has('place-dunhuang')).toBe(true)
    // degraded 注明被跳过的候选（诚实标注，非静默），且可机器读取 candidateId/placeId
    const skipped = result.degraded.filter((e) => e.source === 'advice/places')
    expect(skipped).toHaveLength(2)
    expect(skipped.map((e) => e.candidateId).sort()).toEqual(['p1', 'p2'])
    expect(skipped.map((e) => e.placeId).sort()).toEqual(['place-p1', 'place-p2'])
    expect(skipped.every((e) => e.reason.includes('不参与逐地天气'))).toBe(true)
  })

  it('仅有待澄清/排除地点（N=0）→ blocked 且 nextAction 列出 candidateId，不写空 advice', async () => {
    const planId = await makePlan()
    const pending = { ...place('pending', '待确认地', { coords: coords(96, 38) }), pendingClarification: '同名待确认' }
    const excluded = { ...place('excluded', '已排除地', { coords: coords(97, 39) }), excludeReason: '无法定位' }
    await writePlaces(planId, [pending, excluded], ['pending', 'excluded'])
    const result = await runResearchAdvice({ planId }, store, deps())

    expect(result.weather).toHaveLength(0)
    expect(result.blocked?.reason).toBe('places_not_ready')
    expect(result.blocked?.nextAction).toContain('pending')
    expect(result.blocked?.nextAction).toContain('excluded')
    expect(result.degraded.filter((e) => e.source === 'advice/places').map((e) => e.candidateId).sort())
      .toEqual(['excluded', 'pending'])
    expect(await store.readJson<unknown>(planId, 'advice.json')).toBeUndefined()
  })

  it('fix-f1f #4a 端到端：真实 resolve 澄清产物（place.pendingClarification 在位）→ advice 不入逐地天气（记 degraded）；ready 候选正常逐地', async () => {
    const planId = await makePlan()
    const req0 = await store.loadRequest(planId)
    await store.saveRequest({ ...req0!, status: 'researching', updatedAt: new Date().toISOString() })
    // 研究装配：researchVersion=1 + intel（候选出处）+ sufficient 评估（resolve 门放行件）
    await store.writeJson(planId, 'intel.json', [
      { id: 'tencent-poi:1', category: 'attraction', channel: 'tencent-poi', title: '待确认地',
        summary: 's1', source: { platform: 'tencent-map', url: 'https://example.invalid/1', fetchedAt: '2026-09-02T00:00:00.000Z' } },
      { id: 'tencent-poi:2', category: 'attraction', channel: 'tencent-poi', title: '已确认地',
        summary: 's2', source: { platform: 'tencent-map', url: 'https://example.invalid/2', fetchedAt: '2026-09-02T00:00:00.000Z' } },
    ])
    await store.saveResearchState(planId, {
      schemaVersion: 1, researchVersion: 1, updatedAt: '2026-09-02T00:00:00.000Z', rounds: ['r1'],
      budget: { usedRounds: 1, maxRoundsPerPlan: 16, exhausted: false }, sources: ['tencent-poi'], itemIndex: [],
    })
    await runRecordResearchAssessment({ planId, verdict: 'sufficient', rationale: '测试装配' }, store)

    // resolve：c1 低置信 → 澄清（place 带坐标但 pendingClarification 在位）；c2 高置信唯一 → ready
    const provider: GeocoderProvider = {
      name: 'amap',
      available: () => true,
      geocode: (c) => c.candidateId === 'c2'
        ? [{ coords: coords(98.0, 37.0), confidence: 'high', district: '酒泉市' }]
        : [{ coords: coords(99.5, 36.0), confidence: 'low' }],
    }
    const r = await runResolvePlaces({
      planId,
      candidates: [
        { candidateId: 'c1', name: '待确认地', kind: 'attraction', intelRefs: ['tencent-poi:1'] },
        { candidateId: 'c2', name: '已确认地', kind: 'attraction', intelRefs: ['tencent-poi:2'] },
      ],
      selectionOrder: ['c1', 'c2'],
    }, store, { resolvers: [provider], env: { readSettings: () => undefined, env: {} } })
    expect(r.status).toBe('needs_clarification')
    const clarPlace = r.places.find((p) => p.candidateId === 'c1')
    expect(clarPlace?.pendingClarification).toBeTruthy() // 契约接线：顶层澄清与 place 字段一致
    expect(r.places.find((p) => p.candidateId === 'c2')?.pendingClarification).toBeUndefined()

    // advice 消费真实 resolve 产物：澄清地点（即使带坐标）不入逐地天气 → degraded；
    // ready 候选正常逐地（对照：无澄清 + ready 正常入天气）
    const d = deps()
    const adv = await runResearchAdvice({ planId }, store, d)
    const pids = new Set(adv.weather.map((w) => w.placeId))
    expect(pids.has(clarPlace!.placeId)).toBe(false)
    expect(pids.has(r.places.find((p) => p.candidateId === 'c2')!.placeId)).toBe(true)
    expect(adv.degraded.some((e) => e.reason.includes('待确认地'))).toBe(true)
  })

  it('legacy 计划（无 flowVersion 信封）无 places → 单目的地天气兜底（无 placeId 条目）', async () => {
    // 真正 legacy 形态：请求文件无 flowVersion（旧计划/未走新确认写入口）。新语义下
    // destination-only 新计划已带 flowVersion（决策 5），此兜底仅对 legacy 保留——
    // 显式去信封后仍应单城市兜底（不改 legacy 行为，MUST NOT 轻量路径不误拦）。
    const planId = (await runIntake({
      slots: { destination: '西宁', dateStart: '2026-09-10', dateEnd: '2026-09-12', days: 3 },
    }, store)).planId
    const req = await store.loadRequest(planId)
    await store.saveRequest({ ...req!, flowVersion: undefined })
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    expect(result.blocked).toBeUndefined()
    expect(result.weather.length).toBeGreaterThanOrEqual(3)
    expect(result.weather.every((w) => w.placeId === undefined)).toBe(true)
  })

  it('完整 plan（researchIntent）无有效 places → 结构化 blocked + nextAction，不静默回落单城市（C4）', async () => {
    const planId = await makePlan() // 结构化 plan（researchIntent）→ flowVersion 信封
    const d = deps()
    const result = await runResearchAdvice({ planId }, store, d)
    expect(result.blocked).toBeDefined()
    expect(result.blocked!.reason).toBe('places_not_ready')
    expect(result.blocked!.nextAction).toMatch(/resolve_places/)
    expect(result.weather).toHaveLength(0)
    // 零网络：不产生单城市天气兜底
    const persisted = await store.readJson<unknown>(planId, 'advice.json')
    expect(persisted).toBeUndefined()
  })

  it('工具定义可构建（含 placeDates 参数）+ 默认超时', async () => {
    const planId = await makePlan()
    await writePlaces(planId, qingganPlaces(), ['xining'])
    const d = deps()
    const tool = createTravelResearchAdviceTool(store, d)
    expect(tool.name).toBe('travel_research_advice')
    expect(tool.timeoutMs).toBe(ADVICE_TIMEOUT_MS)
    const result = await runResearchAdvice({ planId, placeDates: [{ placeId: 'place-xining', dates: ['2026-09-11'] }] }, store, d)
    expect(result.weather.some((w) => w.placeId === 'place-xining' && w.placeDateAssigned === true)).toBe(true)
  })
})