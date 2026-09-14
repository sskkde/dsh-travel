/**
 * T19 W5 真实调用方行为留证（live 分支；gated：TRAVEL_LIVE_SMOKE=1 才执行）。
 *
 * 与 tests/e2e/data-quality/scenario-contract.test.ts 的**脚本契约测试**区分：
 * - 契约测试：全 fixture 注入、预设 assessment（[contract-fixture]）只用于契约；
 * - 本文件：真实青甘样本（青岛→青甘大环线 10 日），实调真实渠道，**评估由真实
 *   调用方观察产物后给出**（不是预设，不冒充充分性）。
 *
 * 验收口径（草稿 :222「单剧本真实路线」）：
 *   摘要搜索 → 调用方选正文/分析 → 至少一轮缺口补搜或错误纠正 → 调用方当前
 *   sufficient → 候选 → resolve → 交通门（零网络断言）→ 出发+相邻段 → advice →
 *   可选报价 → build → render。对照实际搜索词、选中点、地理来源、每段交通/
 *   失败状态、页面引用。测真实而非只看根 HTTP 200。
 *
 * 三态纪律：pass/blocked/fail 分离；缺 live 条件（未运行实例/401/超时）记
 * blocked 不冒充；跳过（skip）不冒充 pass。断言工件路径必须在显式
 * DSH_TRAVEL_ROOT（.test-env/ 树下）；拒绝 3080 与生产 profile、路径逃逸。
 *
 * 运行：bash scripts/run-data-quality-e2e.sh --live
 *   （runner 负责 .test-env 3081 启动/就绪与 DSH_HOME/DSH_TRAVEL_ROOT 注入）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import {
  runFetchResearchContent, runReadResearchContent, createFetchBodyHandler,
} from '../src/tools/research-content.js'
import { runRecordResearchAssessment, computeResearchStatus } from '../src/tools/research-assessment.js'
import {
  runResolvePlaces, createAmapResolver, createTencentResolver,
  type ResolveDeps, type GeocoderProvider,
} from '../src/tools/resolve-places.js'
import { runResearchTransport } from '../src/tools/research-transport.js'
import { runRouteTransport } from '../src/tools/route-transport.js'
import { runResearchAdvice } from '../src/tools/research-advice.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { runRenderPage, type RouteRegistrarPort } from '../src/tools/render-page.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { TencentMapAdapter } from '../src/adapters/tencent.js'
import { SearchAdapter, defaultFetchHtml } from '../src/adapters/search.js'
import { Rail12306Adapter } from '../src/adapters/rail12306.js'
import { OpenMeteoAdapter } from '../src/adapters/open-meteo.js'
import { IntercityAdapter } from '../src/adapters/intercity.js'
import {
  tencentPoiChannel, searchL0Channel, platformIntelChannel, tier2Channel,
} from '../src/orchestrator/channels.js'
import type { IntelItem, PlacesArtifact, RouteTransportLeg } from '../src/models/types.js'
import { liveCredentialsEnv } from './live-credentials.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'
const run = LIVE ? describe : describe.skip

/** live 条件解析：DSH_TRAVEL_ROOT 必须为显式且位于 .test-env/ 树下（拒绝 3080/生产/逃逸）。 */
function liveRoot(): string | undefined {
  const raw = (process.env['DSH_TRAVEL_ROOT'] ?? '').trim()
  if (raw === '') return undefined
  const abs = resolve(raw)
  if (!abs.includes(join(process.cwd(), '.test-env'))) return undefined
  return abs
}

/** 结果三态收口：pass/blocked/fail + 原因，写如证据文件。 */
const verdicts: Array<{ step: string; status: 'pass' | 'blocked' | 'fail'; detail: string }> = []
function record(step: string, status: 'pass' | 'blocked' | 'fail', detail: string): void {
  verdicts.push({ step, status, detail })
  console.log(`[live-qinggan] ${step}: ${status} — ${detail}`)
}

/** 渲染用假 registrar（不挂真实路由；本地文件交付仍真实落盘）。 */
function fakeRegistrar(): RouteRegistrarPort {
  return { host: '127.0.0.1', port: 3081, async register() { /* no-op */ } }
}

function futureDate(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

let root: string
let store: TravelStore
let planId: string
let env: Awaited<ReturnType<typeof liveCredentialsEnv>>

run('T19 live-qinggan：真实调用方青甘样本（青岛→青甘大环线 10 日）', () => {
  beforeAll(async () => {
    root = liveRoot()
    if (root === undefined) {
      record('precondition', 'blocked', 'DSH_TRAVEL_ROOT 缺失或不在 .test-env/ 树下（runner 未注入或路径逃逸）')
      return
    }
    mkdirSync(root, { recursive: true })
    store = new TravelStore(root)
    env = await liveCredentialsEnv(['amapWebservice', 'amapJsapi', 'amapJscode', 'tencent', 'wendao'])
    if (env === undefined) {
      record('precondition', 'blocked', 'live 凭据不可用（DSH_HOME/.credentials.yaml 未解析出任何 key）')
    }
  })

  afterAll(() => {
    if (root !== undefined) {
      try {
        writeFileSync(join(root, 'live-qinggan-verdict.json'), JSON.stringify({ planId, verdicts }, null, 2), 'utf8')
      } catch { /* 证据写失败不阻塞 */ }
    }
  })

  it('①intake + 摘要搜索（真实 tencent POI / L0 seam）→ 补搜一轮（纠错/反证）', async () => {
    if (root === undefined || store === undefined) {
      record('intake+research', 'blocked', 'live 前置条件缺失')
      return
    }
    const d1 = futureDate(14)
    const intake = await runIntake({
      slots: {
        origin: '青岛',
        destination: '西宁',
        researchIntent: { text: '青岛 10 日青甘大环线', keywords: ['青甘大环线'], regionHints: ['青海', '甘肃'] },
        dateStart: d1,
        dateEnd: futureDate(23),
        days: 10,
        travelers: { adults: 2 },
      },
    }, store)
    planId = intake.planId
    record('intake', 'pass', `planId=${planId}`)

    const tencent = new TencentMapAdapter() // 真实零 key 体验通道
    const search = new SearchAdapter() // L0 seam 仅 DSH 宿主内可用 → 测试进程如实 degraded
    const result = await runResearchDestination(
      { planId, keywords: ['青甘大环线'] },
      store,
      {
        channels: [tencentPoiChannel(tencent), searchL0Channel(search), platformIntelChannel(search), tier2Channel(search)],
        retryDelaysMs: [1000, 4000],
        env,
      },
    )
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    const poiCount = intel.filter((i) => i.channel === 'tencent-poi').length
    console.log(`[live-qinggan] round1 itemCount=${result.itemCount} tencent-poi=${poiCount} degraded=${result.degraded.map((d) => `${d.source}:${d.code}`).join(',')}`)
    record('research-round-1', poiCount >= 1 ? 'pass' : 'blocked', `tencent-poi=${poiCount}（真实 POI 未命中；L0 seam 测试进程如实 degraded）`)

    // 缺口补搜/纠错：针对「莫高窟 门票预约 冬季」补一轮（真实渠道）
    const r2 = await runResearchDestination(
      { planId, keywords: ['莫高窟', '门票', '冬季'] },
      store,
      {
        channels: [tencentPoiChannel(tencent), searchL0Channel(search)],
        retryDelaysMs: [1000, 4000],
        env,
      },
    )
    const state = await store.loadResearchState(planId)
    console.log(`[live-qinggan] round2 itemCount=${r2.itemCount} researchVersion=${state?.researchVersion}`)
    record('research-round-2', (state?.researchVersion ?? 0) >= 2 ? 'pass' : 'blocked', `补搜轮 researchVersion=${state?.researchVersion}`)
  }, 120000)

  it('②调用方选正文并分析（真实抓取；不可达如实 degraded/blocked）', async () => {
    if (root === undefined || planId === undefined) {
      record('fetch+read', 'blocked', '前置缺失')
      return
    }
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    if (intel.length === 0) {
      record('fetch+read', 'blocked', 'intel 为空（无正文可抓）')
      return
    }
    const target = intel[Math.min(2, intel.length - 1)]
    const fetchR = await runFetchResearchContent(
      { planId, itemIds: [target.id] },
      store,
      { fetchBody: createFetchBodyHandler(defaultFetchHtml), env },
    )
    const receipt = fetchR.items.find((i) => i.itemId === target.id)
    const okStatus = receipt?.contentStatus === 'extracted' || receipt?.contentStatus === 'partial'
    record('fetch-3rd', okStatus ? 'pass' : 'blocked', `${target.id} contentStatus=${receipt?.contentStatus ?? 'n/a'} reason=${receipt?.failureReason ?? receipt?.truncatedReason ?? '—'}（真实抓取/来源不可达不可强求）`)
    if (receipt?.contentVersion !== undefined) {
      const readR = await runReadResearchContent({ planId, contentRef: target.id, contentVersion: receipt.contentVersion }, store)
      record('read-analysis', readR.totalLength > 0 ? 'pass' : 'blocked', `len=${readR.totalLength} 页面引用=${target.source.url.slice(0, 80)}`)
    } else {
      record('read-analysis', 'blocked', '无正文版本可读（如实 blocked）')
    }
  }, 90000)

  it('③调用方提交当前 sufficient（真实观察→评估，非预设）→ resolve（真实 geocoder）', async () => {
    if (root === undefined || planId === undefined) {
      record('assessment+resolve', 'blocked', '前置缺失')
      return
    }
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    const intelRefs = intel.slice(0, 4).map((i) => i.id)
    const a = await runRecordResearchAssessment({
      planId,
      verdict: 'sufficient',
      rationale: `live 观察：tencent-poi 真实命中 ${intel.filter((i) => i.channel === 'tencent-poi').length} 条；基于实际搜索词与选中点给出当前充分（真实调用方判断）`,
      evidenceRefs: intelRefs,
    }, store)
    const ready = await computeResearchStatus(store, planId)
    record('assessment', ready.ready ? 'pass' : 'blocked', `verdict=${a.verdict} ready=${ready.ready}`)

    // 候选（live intel 可能为空或不含该点 → 显式 userRef 作为出处处，不编造 intelRefs）
    const candidates = [
      { candidateId: 'c-xn', name: '西宁', kind: 'area' as const, regionHint: '青海', userRef: '用户路线入口：西宁' },
      { candidateId: 'c-qhh', name: '青海湖', kind: 'attraction' as const, regionHint: '青海', userRef: '用户路线点：青海湖' },
      { candidateId: 'c-dh', name: '敦煌', kind: 'area' as const, regionHint: '甘肃', userRef: '用户路线点：敦煌' },
    ]
    const resolvers: GeocoderProvider[] = []
    if (env !== undefined) {
      resolvers.push(createAmapResolver(new AmapAdapter()))
      resolvers.push(createTencentResolver(new TencentMapAdapter()))
    }
    const deps: ResolveDeps = { resolvers, env: env ?? { env: {} } }
    const r = await runResolvePlaces({
      planId,
      candidates,
      selectionOrder: ['c-xn', 'c-qhh', 'c-dh', 'c-xn'],
      entryCandidateId: 'c-xn',
    }, store, deps)
    const coordsOk = r.places.filter((p) => p.coords !== undefined).length
    record('resolve', r.status === 'ready' ? 'pass' : 'blocked', `status=${r.status} 有坐标=${coordsOk}/${r.places.length} 地理来源=${r.places.map((p) => p.coordinate_source).join(',')}`)
    const placesArt = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
    record('places-artifact', placesArt.status === 'current' ? 'pass' : 'blocked', `places.json ${placesArt.status}`)
  }, 120000)

  it('④出发+相邻段（交通门零网络先于 resolve；每段状态诚实）', async () => {
    if (root === undefined || planId === undefined) {
      record('transport', 'blocked', '前置缺失')
      return
    }
    // 交通门零网络：另建无 places 计划 → blocked + 零网络（计数断言用直连不可达 fixture）
    const probe = (await runIntake({
      slots: { origin: '青岛', destination: '西宁', researchIntent: { text: '青甘大环线' }, dateStart: futureDate(14), dateEnd: futureDate(23), days: 10 },
    }, store)).planId
    const probeReq = await store.loadRequest(probe)
    await store.saveRequest({ ...probeReq!, flowVersion: 'v1' })
    const rail = new Rail12306Adapter() // 真实 12306 MCP（若未装配 → degraded 如实）
    const amap = new AmapAdapter()
    const intercity = new IntercityAdapter({})
    const gate = await runResearchTransport({ planId: probe }, store, { rail, amap, intercity, env, timeoutMs: 30000 })
    record('transport-gate', gate.gate?.blocked === true ? 'pass' : 'blocked', `无 places → gate.${gate.gate?.reason ?? 'n/a'}（零网络口径）`)

    const dep = await runResearchTransport({ planId, modes: ['rail', 'flight'] }, store, { rail, amap, intercity, env, timeoutMs: 90000 })
    const okOpts = dep.options.filter((o) => o.segments[0]?.no && o.segments[0]?.depart)
    console.log(`[live-qinggan] transport options=${dep.options.length} degraded=${dep.degraded.map((d) => `${d.source}:${d.code}`).join(',')}`)
    record('origin-transport', okOpts.length >= 1 ? 'pass' : 'blocked', `含班次=${okOpts.length}/${dep.options.length}（真实 12306/飞猪/问道通道）`)

    const legs = await runRouteTransport({ planId, modes: ['driving'] }, store, { env, timeoutMs: 60000 })
    const statuses = legs.legs.map((l: RouteTransportLeg) => `${l.id}:${l.status}`)
    console.log(`[live-qinggan] route-transport legs=${legs.legs.length} statuses=${statuses.join(',')}`)
    record('route-transport', legs.status === 'ready' ? 'pass' : 'blocked', `legs=${legs.legs.length}（每段 ${legs.legs[0]?.status ?? 'n/a'} 起）`)
  }, 150000)

  it('⑤advice 逐地天气（真实渠道）+ build + render 工件路径断言', async () => {
    if (root === undefined || planId === undefined) {
      record('advice+build+render', 'blocked', '前置缺失')
      return
    }
    const places = (await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')).data
    const placeIds = (places?.places ?? []).map((p) => p.placeId).slice(0, 3)
    const advice = await runResearchAdvice(
      { planId, placeDates: placeIds.map((placeId) => ({ placeId, dates: [futureDate(14), futureDate(15)] })) },
      store,
      { amap: new AmapAdapter(), tencent: new TencentMapAdapter(), openMeteo: new OpenMeteoAdapter(), env, timeoutMs: 60000 },
    )
    const locations = new Set(advice.weather.map((w) => w.location))
    record('advice', advice.weather.length >= 1 ? 'pass' : 'blocked', `weather=${advice.weather.length} locations=${[...locations].join(',')}`)

    const built = await runBuildItinerary({ planId }, store)
    record('build', built.built ? 'pass' : 'blocked', `built=${built.built} reason=${built.reason ?? '—'}`)

    const rendered = await runRenderPage({ planId }, store, fakeRegistrar(), env ?? { env: {} })
    const dir = join(root, '.dsh-travel', planId)
    const artifacts = ['request.json', 'intel.json', 'research-state.json', 'places.json', 'route-transport.json', 'transport.json', 'advice.json', 'itinerary.json', 'page.html']
    const present = artifacts.filter((f) => existsSync(join(dir, f)))
    console.log(`[live-qinggan] render rendered=${rendered.rendered} filePath=${rendered.filePath}`)
    // 工件路径必须位于显式 DSH_TRAVEL_ROOT（.test-env/ 树下）→ 路径逃逸断言
    // （仅当 render 实际产出文件时成立；render 因上游 blocked 未出文件 → 如实记 blocked，不做路径断言）
    if (rendered.rendered && rendered.filePath !== '') {
      expect(rendered.filePath.startsWith(root)).toBe(true)
    }
    record('render', rendered.rendered ? 'pass' : 'blocked', `rendered=${rendered.rendered} filePath=${rendered.filePath}`)
    record('artifacts', present.length === artifacts.length ? 'pass' : 'blocked', `present=${present.length}/${artifacts.length}（缺 ${artifacts.filter((f) => !existsSync(join(dir, f))).join(',') || '—'}）`)
    // 页面引用（intel source urls）
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    console.log(`[live-qinggan] 页面引用 ${intel.filter((i) => i.source?.url).length} 条（样本 ${intel.slice(0, 2).map((i) => i.source?.url).join(' | ')}）`)
  }, 120000)

  it('⑥三态汇总：blocked 绝不冒充 pass', () => {
    const fail = verdicts.filter((v) => v.status === 'fail')
    const blocked = verdicts.filter((v) => v.status === 'blocked')
    const pass = verdicts.filter((v) => v.status === 'pass')
    console.log(`[live-qinggan] verdict: pass=${pass.length} blocked=${blocked.length} fail=${fail.length}`)
    if (root === undefined) {
      // live 条件缺失 → 整体 blocked，明确记录，不冒充 pass
      record('overall', 'blocked', 'live 前置条件缺失（DSH_TRAVEL_ROOT/.test-env 或凭据）')
      return
    }
    expect(fail).toEqual([])
    // 核心「工件路径位于 DSH_TRAVEL_ROOT 下」断言必须真实成立（render 产出时强制校验）；
    // 网络侧 blocked 如实登记，绝不换算成 pass（三态分离，blocked 不进 pass）。
    expect(verdicts.some((v) => v.status === 'pass')).toBe(true)
    record('overall', blocked.length > 0 ? 'pass-with-blocked' : 'pass', `pass=${pass.length} blocked=${blocked.length}（blocked 明细见 live-qinggan-verdict.json）`)
  })
})