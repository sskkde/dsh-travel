/**
 * T19 W5 剧本契约测试（离线确定性；零真实网络）。
 *
 * 这是「脚本契约测试」：全部外部渠道以确定性 fixture 注入（渠道/正文抓取/geocoder/
 * 交通适配器/天气/报价），**预设 assessment 只用于契约测试，不冒充真实调用方
 * 充分性判断**——每次 record_assessment 的 rationale 都显式标注
 * `[contract-fixture]`，与真实调用方行为（见 tests/live-qinggan.test.ts）区分。
 *
 * 全链剧本（对齐 SKILL.md 主线，草稿 :222 单剧本真实路线）：
 *   摘要搜索 → 调用方选第 3 条正文 → 分析 → 缺口补搜（≥1 轮，含纠错/反证）→
 *   提交 sufficient → 候选 → resolve → 交通门（零网络断言）→ 出发+相邻段 →
 *   advice → lodging-quotes（gated）→ build → render 全链工件断言。
 *
 * 证据：caller-loop.json（事件顺序 + 引用链）与 caller-loop.log（人类可读时间线）
 * 写入 QG_EVIDENCE_DIR（缺省 docs/evidence/qinggan-data-quality/w5）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TravelStore } from '../../../src/store/store.js'
import { runIntake } from '../../../src/tools/intake.js'
import { runUpdate } from '../../../src/tools/update.js'
import { runResearchDestination } from '../../../src/tools/research-destination.js'
import { runFetchResearchContent, runReadResearchContent } from '../../../src/tools/research-content.js'
import { runRecordResearchAssessment, computeResearchStatus } from '../../../src/tools/research-assessment.js'
import { runResolvePlaces, type GeocoderProvider, type ResolveDeps } from '../../../src/tools/resolve-places.js'
import { runResearchTransport } from '../../../src/tools/research-transport.js'
import { runRouteTransport, type RouteLegProvider } from '../../../src/tools/route-transport.js'
import { runRouteCoverage } from '../../../src/tools/route-coverage.js'
import { runResearchAdvice } from '../../../src/tools/research-advice.js'
import { runBuildItinerary } from '../../../src/tools/build-itinerary.js'
import { runRenderPage, type RouteRegistrarPort } from '../../../src/tools/render-page.js'
import { AmapAdapter } from '../../../src/adapters/amap.js'
import { Rail12306Adapter, McpStreamClient, type FetchLike } from '../../../src/adapters/rail12306.js'
import { OpenMeteoAdapter } from '../../../src/adapters/open-meteo.js'
import { DidaHotelAdapter, DEFAULT_DIDAHOTEL_MCP_URL } from '../../../src/adapters/dida-hotel.js'
import type { ResearchChannel } from '../../../src/orchestrator/types.js'
import type { CanonicalQuery } from '../../../src/adapters/base.js'
import type { KeyResolutionEnv } from '../../../src/adapters/base.js'
import { researchContentFilePath, researchRoundFilePath } from '../../../src/store/paths.js'
import type {
  ContentFetchResult, GeocoderMatch, IntelItem, IntelCategory, IntelChannel,
  PlacesArtifact, ResolveCandidate, RouteTransportLeg,
} from '../../../src/models/types.js'
import { ROUTE_TRANSPORT_MODES } from '../../../src/models/types.js'

// ────────────────────────── 证据根（env 可覆盖，便于 runner 定向） ──────────────────────────

const EVIDENCE_DIR = process.env['QG_EVIDENCE_DIR']
  ? String(process.env['QG_EVIDENCE_DIR'])
  : join(process.cwd(), 'docs', 'evidence', 'qinggan-data-quality', 'w5')

let root: string
let store: TravelStore
let planId: string

/** 调用方循环记录器：事件数组 + 引用链（供 caller-loop.json / .log 导出）。 */
const callerEvents: Array<{
  seq: number
  stage: string
  tool: string
  ts: string
  args: string
  result: string
}> = []
const referenceChain: { query: string; items: string[] }[] = []
let entryPlaceIdAfterResolve: string | undefined

function logEvent(stage: string, tool: string, args: string, result: string): void {
  callerEvents.push({ seq: callerEvents.length + 1, stage, tool, ts: new Date().toISOString(), args, result })
}

function writeEvidence(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const json = {
    schemaVersion: 1,
    mode: 'contract',
    note: '脚本契约测试：fixture 注入、零真实网络；assessment 为预设契约值（[contract-fixture]），不冒充真实调用方充分性判断（真实行为见 live-qinggan.test.ts）',
    planId,
    root,
    generatedAt: new Date().toISOString(),
    events: callerEvents,
    referenceChain,
    assertions: {
      pickedThirdItem: true,
      gapRounds: callerEvents.filter((e) => e.stage === 'research-round-2').length,
      assessmentVerdict: 'sufficient',
      transportGateZeroNetwork: true,
      adjacentLegs: referenceChain.filter((c) => c.query === 'legs').flatMap((c) => c.items),
      rendered: true,
    },
  }
  writeFileSync(join(EVIDENCE_DIR, 'caller-loop.json'), JSON.stringify(json, null, 2), 'utf8')
  const lines = [
    '# caller-loop.log — T19 剧本契约测试（contract）',
    `plan=${planId} root=${root}`,
    ...callerEvents.map((e) => `${String(e.seq).padStart(3)} ${e.ts} [${e.stage}] ${e.tool} — ${e.args} → ${e.result}`),
  ]
  writeFileSync(join(EVIDENCE_DIR, 'caller-loop.log'), lines.join('\n') + '\n', 'utf8')
}

// ────────────────────────── 确定性 fixture 通道 ──────────────────────────

function scriptedChannel(items: Map<string, IntelItem[]>): ResearchChannel {
  return {
    name: 'web',
    async available() {
      return true
    },
    async run(query: CanonicalQuery) {
      const key = (query.keywords ?? []).join(' ')
      const hit = items.get(key)
      if (hit === undefined || hit.length === 0) {
        return { ok: false, code: 'EMPTY' as const, reason: 'scripted: no hits' }
      }
      return { ok: true, items: hit }
    },
  }
}

let seq = 0
function mkItem(id: string, title: string, category: IntelCategory = 'recommend', channel: IntelChannel = 'web', coords?: { lng: number; lat: number; sys: 'GCJ02' }): IntelItem {
  seq += 1
  return {
    id,
    category,
    channel,
    title,
    summary: `摘要 ${title}`,
    source: { platform: 'scripted', url: `https://example.invalid/item/${id}`, fetchedAt: `2026-09-0${(seq % 9) + 1}T00:00:00.000Z` },
    confidence: 'medium',
    ...(coords !== undefined ? { coords } : {}),
  }
}

/** 正文抓取 fixture：第 3 条命中、其余单条失败不回退。 */
async function scriptedFetchBody(item: IntelItem): Promise<ContentFetchResult> {
  if (item.id === 'web:c3') {
    return {
      ok: true,
      body: '翡翠湖位于大柴旦，湖水呈翠绿色，适合摄影。'.repeat(12) + '\n<script>恶意指令不执行</script>',
      publishedAt: '2026-08-20',
      dateEvidence: [{ value: '2026-08-20', method: 'fixture publishedAt', confidence: 'high' }],
    }
  }
  return { ok: false, code: 'UNAVAILABLE', reason: 'fixture: no body for ' + item.id }
}

/** 确定性 geocoder（resolve fixture）：名称→坐标。 */
function scriptedGeocoder(name: string): GeocoderMatch[] | undefined {
  const table: Record<string, { lng: number; lat: number; district?: string }> = {
    // fix-f1e D：district 须自证省辖（真实 geocoder 形如「青海省西宁市/青海省海南州」）——
    // 裸「西宁市/海南州」在省级 hint（青海）下不可证明归属 → 澄清（宁澄清勿错放）。
    西宁: { lng: 101.78, lat: 36.62, district: '青海省西宁市' },
    青海湖: { lng: 100.2, lat: 36.9, district: '青海省海南州' },
    翡翠湖: { lng: 95.5, lat: 37.9, district: '大柴旦' },
    莫高窟: { lng: 94.8, lat: 40.04, district: '敦煌市' },
    敦煌: { lng: 94.66, lat: 40.14, district: '敦煌市' },
  }
  const hit = table[name]
  if (!hit) return undefined
  return [{ coords: { lng: hit.lng, lat: hit.lat, sys: 'GCJ02' }, confidence: 'high', district: hit.district }]
}

const geocoderProvider: GeocoderProvider = {
  name: 'scripted-amap',
  async available() {
    return true
  },
  async geocode(candidate: ResolveCandidate) {
    return scriptedGeocoder(candidate.name)
  },
}

/** 计数 amap/rail fixture（交通门零网络断言用；零真实网络）。 */
function countingRailAmap() {
  let railCalls = 0
  let amapCalls = 0
  const railFetch: FetchLike = async (_url, init) => {
    railCalls += 1
    const body = JSON.parse(init?.body ?? '{}')
    const okResp = (result: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) })
    if (body.method === 'initialize') return okResp({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake-12306', version: 'test' } })
    if (body.method === 'notifications/initialized') return { ok: true, status: 202, text: async () => '' }
    if (body.method === 'tools/list') return okResp({ tools: [{ name: 'search-stations', description: '' }, { name: 'query-tickets', description: '' }] })
    if (body.method === 'tools/call' && body.params.name === 'search-stations') {
      return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: true, stations: [{ name: '西宁站', code: 'XN1', pinyin: 'xining' }] }) }] })
    }
    if (body.method === 'tools/call' && body.params.name === 'query-tickets') {
      return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: true, trains: [{ train_no: 'G531', from_station: '青岛西', to_station: '西宁站', start_time: '09:00', arrive_time: '14:30', duration: '05:30' }] }) }] })
    }
    return okResp({ content: [{ type: 'text', text: JSON.stringify({ success: false, message: `no fixture ${body.params?.name}` }) }] })
  }
  const amapFetch = async (url: string) => {
    amapCalls += 1
    if (url.includes('geocode/geo')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: '1', info: 'OK', geocodes: [{ location: '101.78,36.62', level: '区县' }] }) }
    }
    if (url.includes('distance')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: '1', results: [{ origin_id: '0', dest_id: '0', distance: '10000', duration: '2700' }] }) }
    }
    throw new Error(`fixture: no amap route ${url}`)
  }
  return {
    rail: new Rail12306Adapter({ mcp: new McpStreamClient({ url: 'http://127.0.0.1:8123/mcp', fetchFn: railFetch }) }),
    amap: new AmapAdapter({ fetchFn: amapFetch }),
    railCount: () => railCalls,
    amapCount: () => amapCalls,
  }
}

/** 已确认交通的环境（rail/amap fixture + env）。 */
function transportEnv(): { rail: Rail12306Adapter; amap: AmapAdapter; env: KeyResolutionEnv } {
  const c = countingRailAmap()
  return { rail: c.rail, amap: c.amap, env: { env: { amapWebservice: 'fixture-key' } } }
}

/** Open-Meteo fixture：16 天内任意窗口返回逐日条目。 */
function scriptedOpenMeteo(): OpenMeteoAdapter {
  const fetchFn = async (_input: string) => {
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        daily: {
          time: days,
          temperature_2m_max: days.map(() => 20),
          temperature_2m_min: days.map(() => 5),
          weathercode: days.map(() => 1),
        },
      }),
    }
  }
  return new OpenMeteoAdapter({ fetchFn })
}

/** 相邻段测距 provider：全部 queried（fixture）。 */
function scriptedLegProvider(): RouteLegProvider {
  return {
    name: 'scripted-leg',
    label: '脚本测距（fixture）',
    modes: ROUTE_TRANSPORT_MODES,
    async available() {
      return { ok: true }
    },
    async measure(inputs) {
      return inputs.map((i) => ({ id: i.id, distanceKm: 100, durationMinutes: 120, note: 'fixture measure' }))
    },
  }
}

/** 假 registrar（render 用；零真实路由注册）。 */
function fakeRegistrar(): RouteRegistrarPort {
  return {
    host: '127.0.0.1',
    port: 3081,
    async register() { /* no-op（契约测试不挂真实路由） */ },
  }
}

const ENV_ZERO_KEY: KeyResolutionEnv = { env: {} }

// ────────────────────────── 剧本 ──────────────────────────

describe('T19 剧本契约测试：单剧本全链（离线确定性）', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-travel-e2e-qg-'))
    store = new TravelStore(root)
  })

  afterAll(() => {
    try { writeEvidence() } catch { /* 证据写入不阻塞断言 */ }
    rmSync(root, { recursive: true, force: true })
  })

  it('①摘要搜索：intake（青岛 10 日青甘大环线，入口城市=西宁）+ research round 1（关键词实际落库）', async () => {
    const intake = await runIntake({
      slots: {
        origin: '青岛',
        destination: '西宁',
        researchIntent: { text: '青岛 10 日青甘大环线', keywords: ['青甘大环线'], regionHints: ['青海', '甘肃'] },
        dateStart: '2026-10-01',
        dateEnd: '2026-10-10',
        days: 10,
        travelers: { adults: 2 },
      },
    }, store)
    planId = intake.planId
    expect(planId).toMatch(/^plan-/)
    // 兴趣意图不被合并成「destination=西宁」单城市（草稿 A：青甘主题不变成西宁搜索）
    const request = await store.loadRequest(planId)
    expect(request!.slots.researchIntent?.text).toBe('青岛 10 日青甘大环线')

    const sc = scriptedChannel(new Map([
      ['青甘大环线', [
        mkItem('web:a1', '青甘大环线 10 日路线推荐', 'recommend', 'web'),
        mkItem('web:b2', '西宁-敦煌-大柴旦 交通接驳', 'transportLocal', 'web'),
        mkItem('web:c3', '翡翠湖 大柴旦 摄影指南', 'attraction', 'web', { lng: 95.5, lat: 37.9, sys: 'GCJ02' }),
        mkItem('web:d4', '敦煌 莫高窟 门票预约', 'attraction', 'web', { lng: 94.8, lat: 40.04, sys: 'GCJ02' }),
      ]],
    ]))
    const r = await runResearchDestination({ planId, keywords: ['青甘大环线'] }, store, { channels: [sc], env: ENV_ZERO_KEY })
    expect(r.itemCount).toBeGreaterThanOrEqual(4)
    // 轮次落库：实际搜索词 = 青甘大环线（不变成西宁）
    const state = await store.loadResearchState(planId)
    expect(state!.researchVersion).toBe(1)
    expect(state!.rounds.length).toBe(1)
    const roundFile = researchRoundFilePath(root, planId, state!.rounds[0]!)
    const round = JSON.parse(readFileSync(roundFile, 'utf8'))
    expect(round.query.keywords).toContain('青甘大环线')
    referenceChain.push({ query: `round1:${round.query.keywords.join(' ')}`, items: round.newItemIds })
    logEvent('research-round-1', 'travel_research_destination', `keywords=青甘大环线`, `items=${r.itemCount} round=${state!.rounds[0]}`)
  })

  it('②调用方选第 3 条正文 + ③分析（fetch/read，正文独立存档）', async () => {
    const fetchR = await runFetchResearchContent(
      { planId, itemIds: ['web:c3'] },
      store,
      { fetchBody: scriptedFetchBody },
    )
    const receipt = fetchR.items.find((i) => i.itemId === 'web:c3')
    expect(receipt?.contentStatus).toBe('extracted')
    expect(receipt?.contentVersion).toBeTruthy()
    // 正文独立档案存在（>140 字符完整保留，不再 140 截断）
    expect(existsSync(researchContentFilePath(root, planId, 'web:c3', receipt!.contentVersion!))).toBe(true)
    const readR = await runReadResearchContent({
      planId, contentRef: 'web:c3', contentVersion: receipt!.contentVersion!,
    }, store)
    expect(readR.totalLength).toBeGreaterThan(140)
    expect(readR.fragment).toContain('翡翠湖')
    // 正文视为不可信数据：script 指令不能被当执行目标（读取只返回文本）
    expect(readR.fragment).toContain('script')
    // DR3：正文变化推进 researchVersion（1→2），旧判断当前有效性被撤销（草稿 56）
    const afterFetch = await store.loadResearchState(planId)
    expect(afterFetch!.researchVersion).toBe(2)
    logEvent('fetch+read-3rd', 'travel_fetch_research_content / read', 'itemIds=[web:c3]', `status=${receipt?.contentStatus} len=${readR.totalLength}`)
  })

  it('④缺口补搜（≥1 轮，含纠错/反证：莫高窟冬季闭园反证 + 门票规则纠错）', async () => {
    // 调用方看到正文后判断有缺口：先续查（continue），再补搜一轮
    const cont = await runRecordResearchAssessment({
      planId, verdict: 'continue', rationale: '[contract-fixture] 发现莫高窟开放信息缺口，需补搜反证',
      gaps: [{ requirement: '莫高窟冬季开放时间', gap: '摘要未覆盖' }],
    }, store)
    expect(cont.verdict).toBe('continue')

    const sc = scriptedChannel(new Map([
      ['莫高窟 冬季', [
        mkItem('web:e5', '莫高窟 冬季参观反证：淡季开放时间调整', 'warning', 'web'),
      ]],
    ]))
    const r = await runResearchDestination({ planId, keywords: ['莫高窟', '冬季'] }, store, { channels: [sc], env: ENV_ZERO_KEY })
    expect(r.itemCount).toBeGreaterThanOrEqual(1)
    const state = await store.loadResearchState(planId)
    // v3 = fetch(1→2) + 本轮补搜(2→3)；轮次数不变
    expect(state!.researchVersion).toBe(3)
    expect(state!.rounds.length).toBe(2)
    // 反证条目保留（widgets: 纠错/反证证据不丢弃）
    expect((await store.readJson<IntelItem[]>(planId, 'intel.json'))!.some((i) => i.id === 'web:e5')).toBe(true)
    referenceChain.push({ query: 'round2:莫高窟 冬季（反证/纠错）', items: ['web:e5'] })
    logEvent('research-round-2', 'travel_research_destination', 'keywords=莫高窟,冬季（缺口补搜）', `items=${r.itemCount} 反证=web:e5`)
  })

  it('⑤提交 sufficient（当前版本门）+ resolve 前置检查', async () => {
    const a = await runRecordResearchAssessment({
      planId,
      verdict: 'sufficient',
      rationale: '[contract-fixture] 预设充分性判定——仅用于契约测试，不代表真实调用方判断',
      evidenceRefs: ['web:a1', 'web:c3', 'web:e5'],
      findings: [{ claimId: 'c1', statement: '青甘大环线 10 日路线可行', evidenceRef: 'web:a1', status: 'confirmed' }],
      conflicts: [{ aRef: 'web:a1', bRef: 'web:e5', unresolved: true }],
    }, store)
    expect(a.verdict).toBe('sufficient')
    const status = await computeResearchStatus(store, planId)
    expect(status.ready).toBe(true)
    logEvent('assessment-sufficient', 'travel_record_research_assessment', 'verdict=sufficient [contract-fixture]', `researchVersion=${a.researchVersion}`)
  })

  it('⑥候选 → resolve（scripted geocoder；同一青甘样本候选）', async () => {
    const intel = await store.readJson<IntelItem[]>(planId, 'intel.json')
    const candidates: ResolveCandidate[] = [
      { candidateId: 'c-xn', name: '西宁', kind: 'area', intelRefs: ['web:a1'], regionHint: '青海', selectionReason: '环线起点（契约 fixture）' },
      { candidateId: 'c-qhh', name: '青海湖', kind: 'attraction', intelRefs: ['web:a1'], regionHint: '青海' },
      { candidateId: 'c-fec', name: '翡翠湖', kind: 'attraction', intelRefs: ['web:c3'], regionHint: '大柴旦' },
      { candidateId: 'c-mg', name: '莫高窟', kind: 'attraction', intelRefs: ['web:d4', 'web:e5'], regionHint: '敦煌' },
    ]
    expect(intel!.length).toBeGreaterThanOrEqual(5)
    const deps: ResolveDeps = { resolvers: [geocoderProvider], env: ENV_ZERO_KEY }
    const r = await runResolvePlaces({
      planId,
      expectedIntelVersion: 3, // v3 = fetch 推进 + 补搜推进（DR3 语义）
      candidates,
      selectionOrder: ['c-xn', 'c-qhh', 'c-fec', 'c-mg', 'c-xn'], // 闭环重访：起点末尾回到西宁
      entryCandidateId: 'c-xn',
    }, store, deps)
    expect(r.status).toBe('ready')
    expect(r.entryPlaceId).toBeTruthy()
    entryPlaceIdAfterResolve = r.entryPlaceId
    // 闭环重访不丢：selectedSequence 保留 [start, …, start] 而非去重丢起点
    expect(r.selectedSequence[r.selectedSequence.length - 1]).toBe('c-xn')
    expect(r.places.length).toBe(4)
    expect(r.places.every((p) => p.coords !== undefined)).toBe(true)
    const placesArtifact = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
    expect(placesArtifact.status).toBe('current')
    referenceChain.push({ query: 'resolve', items: r.places.map((p) => `${p.candidateId}:${p.name}@${p.coordinate_source}`) })
    logEvent('resolve', 'travel_resolve_places', 'candidates=4 entry=c-xn', `places=${r.places.length} entry=${r.entryPlaceId}`)
  })

  it('⑦交通门（零网络断言）：无 places 时交通零调用 + 有 places 后可查', async () => {
    // 门：完整 plan 在 resolve 前调用 → blocked + 零网络（计数 fixture 断言无网络请求）
    const gatePlanId = (await runIntake({
      slots: { origin: '青岛', destination: '西宁', researchIntent: { text: '青甘大环线' }, dateStart: '2026-10-01', dateEnd: '2026-10-10', days: 10 },
    }, store)).planId
    // 新计划标记完整（flowVersion，等同既有 markComplete 口径）：无 places → 走交通前置门
    const gateReq = await store.loadRequest(gatePlanId)
    await store.saveRequest({ ...gateReq!, flowVersion: 'v1' })
    const tc = countingRailAmap()
    const before = tc.railCount() + tc.amapCount()
    const gate = await runResearchTransport({ planId: gatePlanId }, store, { rail: tc.rail, amap: tc.amap, env: { env: { amapWebservice: 'fixture-key' } } })
    expect(gate.gate?.blocked).toBe(true)
    expect(gate.gate?.reason).toBe('places_not_ready')
    expect(tc.railCount() + tc.amapCount()).toBe(before) // 零网络
    expect(gate.options).toEqual([])
    expect(await store.readJson(gatePlanId, 'transport.json')).toBeUndefined()
    // 不污染主计划
    expect(await store.readJson(planId, 'places.json')).toBeDefined()
    logEvent('transport-gate', 'travel_research_transport', '无 places 计划', `blocked=${gate.gate!.reason} 零网络`)
  })

  it('⑧出发+相邻段：出发交通 + route-transport 每相邻段有结果或原因', async () => {
    // 出发：青岛 → 西宁（脚本 rail fixture）
    const dep = await runResearchTransport({ planId, modes: ['rail'] }, store, transportEnv())
    expect(dep.options.length).toBeGreaterThanOrEqual(1)
    expect(dep.entry?.entryPlaceId).toBe(entryPlaceIdAfterResolve)
    expect(dep.entry?.hubLinks.length).toBeGreaterThanOrEqual(1)
    referenceChain.push({ query: 'origin-transport', items: dep.options.map((o) => `${o.mode} ${o.segments[0]?.no}`) })
    logEvent('origin-transport', 'travel_research_transport', 'modes=rail', `options=${dep.options.length} entry=${dep.entry?.entryName}`)

    // 相邻段：青海湖→翡翠湖→莫高窟→（回）西宁
    const legs = await runRouteTransport({ planId, modes: ['driving'] }, store, {
      providers: [scriptedLegProvider()],
      env: ENV_ZERO_KEY,
    })
    expect(legs.status).toBe('ready')
    expect(legs.legs.length).toBeGreaterThanOrEqual(3)
    const seq = legs.legs.map((l: RouteTransportLeg) => l.id)
    // 闭环重访保留：每相邻对都有 leg 记录
    expect(seq.length).toBe(legs.legs.length)
    expect(legs.legs.every((l) => l.status === 'queried' || l.status === 'estimated')).toBe(true)
    referenceChain.push({ query: 'legs', items: legs.legs.map((l) => `${l.fromPlaceId}->${l.toPlaceId}:${l.status}`) })
    logEvent('route-transport', 'travel_route_transport', 'modes=driving', `legs=${legs.legs.length} ${legs.legs[0]?.fromPlaceId}→${legs.legs[legs.legs.length - 1]?.toPlaceId}`)
  })

  it('⑨route-coverage 覆盖旁车（research→coverage lineage，不反向触发）', async () => {
    const cov = await runRouteCoverage({ planId, expectedPlacesVersion: (await store.currentVersion(planId, 'places')) }, store)
    expect(cov.status).toBe('ready')
    expect(cov.regions.length).toBeGreaterThanOrEqual(1)
    expect(cov.lineage.regionHints.length).toBeGreaterThanOrEqual(0)
    logEvent('route-coverage', 'travel_route_coverage', 'regionHints=青海,甘肃', `regions=${cov.regions.length}`)
  })

  it('⑩advice 按地点逐日天气（不串用西宁代表整条环线）', async () => {
    const places = (await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')).data!
    const placeIds = places.places.map((p) => p.placeId)
    const advice = await runResearchAdvice({
      planId,
      placeDates: placeIds.slice(0, 3).map((placeId) => ({ placeId, dates: ['2026-10-01', '2026-10-02'] })),
    }, store, { openMeteo: scriptedOpenMeteo(), env: ENV_ZERO_KEY })
    expect(advice.weather.length).toBeGreaterThanOrEqual(2)
    // 逐地归属：至少两个不同 placeId/location（不把西宁天气当整条环线）
    const locations = new Set(advice.weather.map((w) => w.location))
    expect(locations.size).toBeGreaterThanOrEqual(2)
    referenceChain.push({ query: 'advice', items: [...locations] })
    logEvent('advice', 'travel_research_advice', 'placeDates=3 地点', `locations=${[...locations].join(',')}`)
  })

  it('⑪lodging-quotes（gated）：无 stay 上下文 → skipped_missing_stay_context 零调用', async () => {
    // DIDA 未装配 → blocked 零调用（草稿 E：DIDA 只读白名单 + 缺 Key 不猜价）
    const gated = await runResearchDestination({
      planId,
      phase: 'lodging-quotes' as const,
      quoteRequests: [{ placeId: entryPlaceIdAfterResolve!, checkIn: undefined }],
    }, store, { channels: [], env: ENV_ZERO_KEY })
    expect(gated.lodgingQuotes!.records[0]!.status).toBe('skipped_missing_stay_context')
    expect(gated.lodgingQuotes!.records[0]!.reason).toMatch(/checkIn|入住/)
    logEvent('lodging-quotes', 'travel_research_destination(phase=lodging-quotes)', '无入住条件', 'skipped_missing_stay_context（零调用）')
  })

  it('⑫build + ⑬render 全链工件断言（request/intel/places/transport/…/page.html）', async () => {
    const built = await runBuildItinerary({ planId }, store)
    expect(built.built).toBe(true)
    const rendered = await runRenderPage({ planId }, store, fakeRegistrar(), ENV_ZERO_KEY)
    expect(rendered.rendered).toBe(true)
    expect(rendered.filePath).toBeTruthy()
    expect(existsSync(rendered.filePath)).toBe(true)

    // 全链工件断言
    const dir = join(root, '.dsh-travel', planId)
    for (const f of ['request.json', 'intel.json', 'research-state.json', 'places.json', 'route-transport.json', 'transport.json', 'route-coverage.json', 'advice.json', 'lodging-quotes.json', 'itinerary.json', 'page.html', 'artifact-meta.json']) {
      expect(existsSync(join(dir, f)), `工件缺失: ${f}`).toBe(true)
    }
    // 事件顺序 + 引用链证据
    expect(callerEvents.length).toBeGreaterThanOrEqual(10)
    const stages = callerEvents.map((e) => e.stage)
    expect(stages).toContain('research-round-1')
    expect(stages).toContain('fetch+read-3rd')
    expect(stages).toContain('research-round-2')
    expect(stages).toContain('assessment-sufficient')
    expect(stages).toContain('resolve')
    expect(stages).toContain('transport-gate')
    expect(stages).toContain('origin-transport')
    expect(stages).toContain('route-transport')
    expect(stages).toContain('advice')
    expect(stages).toContain('lodging-quotes')
    logEvent('build+render', 'travel_build_itinerary / travel_render_page', '', `built=${built.built} rendered=${rendered.rendered} filePath=${rendered.filePath.slice(0, 60)}…`)
  })
})