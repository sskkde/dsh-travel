/**
 * render 单测（M1 T5 / Wα Leaflet-only）。
 *
 * 状态机纪律：规范序列 intake→research→build→render 由真实工具驱动
 * （seedResearch 推进到 researching、build 推进到 generating、render→delivered）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { buildRenderData, renderItineraryPage, renderWithTemplate, templatePath, type RenderPageData } from '../src/render/render.js'
import { createDedupingRouteRegistrar } from '../src/render/route-registrar.js'
import { runRenderPage, travelPlanRoutePath, type RouteRegistrarPort } from '../src/tools/render-page.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedPlaces } from './helpers/seed-places.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'
import type { IntelItem, TravelRequest } from '../src/models/types.js'
import { InvalidTransitionError } from '../src/errors.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-render-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function intelItem(id: string, opts: { category?: IntelItem['category']; coords?: boolean; rating?: number; avgPrice?: number; summary?: string } = {}): IntelItem {
  return {
    id,
    category: opts.category ?? 'attraction',
    channel: 'tencent-poi',
    title: `intel-${id}`,
    summary: opts.summary ?? `summary-${id}`,
    source: { platform: 'tencent-map', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-02T00:00:00.000Z' },
    ...(opts.coords !== false ? { coords: { lng: 114.3, lat: 30.5, sys: 'GCJ02' as const } } : {}),
    ...(opts.rating !== undefined ? { rating: opts.rating } : {}),
    ...(opts.avgPrice !== undefined ? { avgPrice: opts.avgPrice } : {}),
    confidence: 'high',
  }
}

/** 规范序列前置（不跳步）：intake → research → places（决策 5：新 plan 受串行门）→ build，终态 generating（render 的前置态）。 */
async function makeGeneratingPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
  }, store)
  const planId = intake.planId
  expect(intake.status).toBe('confirmed')
  await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
  await seedSufficientAssessment(store, planId) // C5① 门放行件
  await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 }) // 门放行件（等价 resolve 产物）
  // 该 helper 保留旧 fixtures 的构造便利；真实流水线仍须用 publishArtifacts，
  // 否则 modern manifest 会诚实将直写 places 标为 unknown。
  const places = await store.readJson(planId, 'places.json')
  await store.publishArtifacts(planId, {
    stage: 'places', files: [{ name: 'places.json', data: places }],
    expectedVersions: { intel: 1 }, bump: [], inputFingerprint: 'render-test-places',
  })
  const built = await runBuildItinerary({ planId }, store)
  expect(built.built).toBe(true)
  expect((await store.loadRequest(planId))?.status).toBe('generating')
  return planId
}

function fakeRequest(): TravelRequest {
  return {
    planId: 'p1', mode: 'plan', status: 'delivered',
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
    assumptions: [], createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  }
}

/** 抽取内嵌数据 JSON 块并断言无裸 `</script`（防闭合；模板自身的收尾 </script> 标签除外）。 */
function dataBlockOf(html: string): string {
  const m = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  expect(m, 'travel-data 数据块缺失').toBeTruthy()
  return m![1]
}

describe('render 模板', () => {
  it('模板文件存在（src 树邻接 import.meta.url）', () => {
    expect(templatePath()).toContain('template.html')
  })

  it('renderWithTemplate：标题替换 + 数据 JSON 内嵌 + `</` 转义防 script 闭合', () => {
    const template = `__PAGE_TITLE__#{__TRAVEL_DATA__}#`
    const data: RenderPageData = {
      renderedAt: '2026-09-02T00:00:00.000Z',
      request: fakeRequest(),
      itinerary: {
        itineraryId: 'it',
        days: [{ date: '2026-10-01', stops: [], meals: [] }],
        routeCheck: { issues: [], warnings: [] },
      },
      intel: { a1: { ...intelItem('a1'), title: '含 <b>标记</b> 的标题' } },
      degraded: [],
    }
    const html = renderWithTemplate(data, template)
    expect(html).toContain('1 日 · 武汉')
    expect(html).toContain('"renderedAt"')
    expect(html).toContain('\\u003cb>') // 内嵌 JSON 中 < → \u003c（防 </script> 闭合；> 保持字面）
    expect(html).toContain('\\u003c/b>')
    expect(html).not.toContain('</script')
  })

  it('真实模板自带 GCJ→WGS 算法与 Leaflet/OSM 装配（§8）', () => {
    const template = readFileSync(templatePath(), 'utf8')
    expect(template).toContain('function gcj02ToWgs84')
    expect(template).toContain('gcjTransformLat')
    expect(template).toContain('tile.openstreetmap.org')
    expect(template).toContain('leaflet@1.9.4')
    expect(template).toContain('L.marker')
    expect(template).toContain("'[dsh-travel] stops='")
    expect(template).toContain('__TRAVEL_DATA__')
    expect(template).toContain('coords.sys')
  })

  it('真实模板含双 loader 分支（W5：amap JSAPI 2.0 方案 A + Leaflet 自动降级 + 坐标系双向）', () => {
    const template = readFileSync(templatePath(), 'utf8')
    // amap 方案 A：securityJsCode 明文注入 + loader URL 含 key（域名白名单注释）
    expect(template).toContain('webapi.amap.com/maps?v=2.0')
    expect(template).toContain('_AMapSecurityConfig')
    expect(template).toContain('securityJsCode')
    // amap 渲染原语（markers/polyline/InfoWindow 官方 API）
    expect(template).toContain('AMap.Map')
    expect(template).toContain('AMap.Marker')
    expect(template).toContain('AMap.Polyline')
    expect(template).toContain('AMap.InfoWindow')
    // 坐标系双向（GCJ→WGS 供 Leaflet；WGS→GCJ 近似供 amap 原生 GCJ-02）
    expect(template).toContain('function wgs84ToGcj02')
    // 按日高亮联动 + 地图失败列表视图兜底（§2.1 FR-7 渠道二降级）
    expect(template).toContain('function activateDay')
    expect(template).toContain('showMapNotice')
    // 八区：总览/地图/时间轴/交通/美食/住宿/避雷/建议 + 降级条
    for (const id of ['overviewCard', 'mapCard', 'timelineCard', 'transportCard', 'foodCard', 'lodgingCard', 'warningCard', 'adviceCard', 'degradedStrip']) {
      expect(template, `八区缺 ${id}`).toContain(`id="${id}"`)
    }
    // 前端零 POI 检索调用（纯渲染后端坐标）：无 fetch/XMLHttpRequest 检索面
    expect(template).not.toContain('place/v1/search')
  })

  it('T6 map-first 结构契约：地图核心/日程轨道/移动抽屉/逐段列表八区保留', () => {
    const template = readFileSync(templatePath(), 'utf8')
    const styles = readFileSync(join(dirname(templatePath()), 'page', 'styles.css'), 'utf8')
    for (const id of ['mainGrid', 'mapCard', 'timelineCard', 'dayDrawer', 'drawerToggle', 'legList', 'insightsCard', 'degradedStrip']) {
      expect(template, `T6 新结构缺 ${id}`).toContain(`id="${id}"`)
    }
    // 结构断言从旧的一次性长列表迁移到模块化 bundle/CSS：不弱化八区，
    // 另外锁住 65% 地图主面、移动抽屉及 reduced-motion 样式入口。
    expect(styles).toContain('grid-template-columns: minmax(210px, 250px) minmax(0, 1fr)')
    expect(styles).toContain('.drawer-toggle')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(template).toContain('__PAGE_BUNDLE__')
    expect(template).toContain('__PAGE_STYLES__')
    expect(template).toContain('__CSP_POLICY__')
    expect(template).not.toContain('innerHTML')
  })

  it('T6 render 产物契约：最终 bundle hash CSP + routeTransport 数据仍可消费', () => {
    const data: RenderPageData = {
      renderedAt: '2026-09-02T00:00:00.000Z', request: fakeRequest(),
      itinerary: { itineraryId: 'it', days: [{ date: '2026-10-01', stops: [], meals: [] }], routeCheck: { issues: [], warnings: [] } },
      intel: {}, degraded: [], map: { provider: 'leaflet', warnings: [] },
      routeTransport: {
        legs: [{ id: 'leg-0', fromPlaceId: 'a', toPlaceId: 'b', orderIndex: 0, placesVersion: 1, mode: 'driving', status: 'queried', metricStatus: 'queried', geometryStatus: 'queried', distanceKm: 12.3, durationMinutes: 20, observedAt: '2026-09-02T00:00:00.000Z', geometry: { type: 'LineString', coordinates: [[101, 36], [101.1, 36.1]], source: 'fixture', coordinateSystem: 'WGS84', pointOrder: 'lng,lat' } }],
        totalDistanceKm: 12.3, totalDurationMinutes: 20,
      }, totalDistanceKm: 12.3, totalDurationMinutes: 20,
    }
    const html = renderWithTemplate(data, readFileSync(templatePath(), 'utf8'))
    expect(html).toContain('sha256-')
    expect(html).not.toContain('unsafe-inline')
    expect(html).not.toContain('unsafe-eval')
    expect(html).toContain('routeTransport')
    expect(html).toContain('geometryStatus')
    expect(html).toContain('12.3')
  })

  it('renderWithTemplate：transport/advice 可选注入（缺失卡片隐藏由页面端判空）', () => {
    const template = `__PAGE_TITLE__#{__TRAVEL_DATA__}#`
    const data: RenderPageData = {
      renderedAt: '2026-09-02T00:00:00.000Z',
      request: fakeRequest(),
      itinerary: {
        itineraryId: 'it',
        days: [{ date: '2026-10-01', stops: [], meals: [] }],
        routeCheck: { issues: [], warnings: [] },
      },
      intel: {},
      degraded: [],
      map: { provider: 'leaflet', warnings: [] },
      transport: [{
        mode: 'rail',
        segments: [{ from: '武汉', to: '上海', no: 'G123', depart: '08:00', arrive: '12:00' }],
        totalPriceRange: [200, 400],
        durationMinutes: 240,
        source: { platform: 'test', url: 'https://example.invalid/t', fetchedAt: '2026-09-02T00:00:00.000Z' },
      }],
      advice: { weather: [], clothing: ['轻便外套'], packingList: [], extraTips: [] },
    }
    const html = renderWithTemplate(data, template)
    expect(html).toContain('"transport"')
    expect(html).toContain('"advice"')
    expect(html).toContain('轻便外套')
    expect(html).not.toContain('</script')
  })

  it('renderWithTemplate：map 配置注入（amap key+jscode 经 \\u003c 转义进 JSON，页面=方案 A 明文注入载体）', () => {
    const template = `#{__TRAVEL_DATA__}#`
    const data: RenderPageData = {
      renderedAt: '2026-09-02T00:00:00.000Z',
      request: fakeRequest(),
      itinerary: {
        itineraryId: 'it',
        days: [{ date: '2026-10-01', stops: [], meals: [] }],
        routeCheck: { issues: [], warnings: [] },
      },
      intel: {},
      degraded: [],
      map: { provider: 'amap', amapKey: 'TEST-KEY', amapJscode: '<MASK>', warnings: [] },
    }
    const html = renderWithTemplate(data, template)
    expect(html).toContain('"provider":"amap"')
    expect(html).toContain('"amapKey":"TEST-KEY"')
    expect(html).toContain('"amapJscode":"\\u003cMASK>"')
    expect(html).not.toContain('</script')
  })
})

describe('render 旧工件降级自由文本闸门（T26）', () => {
  const USER_INFO = 'https://' + 'u:p@example.invalid/legacy?token=synthetic'

  it('buildRenderData：顶层 degraded 的 source/code/at/reason 与内嵌 __TRAVEL_DATA__ 均无 userinfo/token', async () => {
    const intake = await runIntake({
      slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
    }, store)
    const planId = intake.planId
    await store.saveRequest({ ...intake.request, status: 'generating' })
    await store.writeJson(planId, 'itinerary.json', {
      itineraryId: 'it-legacy',
      days: [{ date: '2026-10-01', stops: [], meals: [] }],
      routeCheck: { issues: [], warnings: [] },
    })
    // 旧 degraded.json：自由文本字段本身夹带凭据（非本轮写入路径）。
    await store.writeJson(planId, 'degraded.json', [{
      source: `probe ${USER_INFO}`, code: 'UNAVAILABLE',
      reason: `上游失败 ${USER_INFO}`, at: `2026-09-02T00:00:00.000Z ${USER_INFO}`,
    }])
    const built = await buildRenderData(store, planId)
    expect(built.data).toBeDefined()
    expect(built.data!.degraded[0].source).not.toContain('u:p@')
    expect(built.data!.degraded[0].reason).not.toContain('token=synthetic')
    expect(built.data!.degraded[0].reason).toContain('token=[REDACTED]')

    const html = renderWithTemplate(built.data!, '#{__TRAVEL_DATA__}#|#{__TRAVEL_EXPORT__}#')
    expect(html).not.toContain('u:p@')
    expect(html).not.toContain('token=synthetic')
    expect(html).toContain('token=[REDACTED]')
    expect(html).toContain('example.invalid/legacy')
  })

  /**
   * renderWithTemplate 是**公开/直接入口**（不止 buildRenderData 一条来路）：调用方可以直接
   * 构造 RenderPageData 渲染，此时顶层 degraded 从未经过 buildRenderData 的脱敏。若脱敏只
   * 挂在 buildRenderData 上，直渲路径的原样自由文本会直接进 HTML 与 __TRAVEL_DATA__。
   */
  it('renderWithTemplate 直接入口：未经 buildRenderData 的顶层 degraded 也必须脱敏（source/code/reason/at 四字段）', () => {
    const data: RenderPageData = {
      renderedAt: '2026-09-02T00:00:00.000Z',
      request: fakeRequest(),
      itinerary: {
        itineraryId: 'it-direct',
        days: [{ date: '2026-10-01', stops: [], meals: [] }],
        routeCheck: { issues: [], warnings: [] },
      },
      intel: {},
      map: { provider: 'leaflet', warnings: [] },
      // 直渲传入：每个自由文本字段都夹带 userinfo / 敏感 query。
      degraded: [{
        source: `route/amap ${USER_INFO}`,
        code: `UNAVAILABLE ${USER_INFO}`,
        reason: `上游失败 ${USER_INFO}`,
        at: `2026-09-01T00:00:00.000Z ${USER_INFO}`,
      }],
    }
    // 用**真实模板**直渲（最贴近真实产物的路径）：断言直接落在落盘形态的 HTML 上。
    const html = renderWithTemplate(data, readFileSync(templatePath(), 'utf8'))
    expect(html).not.toContain('u:p@')
    expect(html).not.toContain('token=synthetic')
    expect(html).toContain('token=[REDACTED]')
    expect(html).toContain('example.invalid/legacy')
    // 逐字段落地（source/code/reason/at 都要被清，不能只清 reason）。
    const embedded = JSON.parse(dataBlockOf(html)) as { degraded: Array<Record<string, string>> }
    expect(embedded.degraded).toHaveLength(1)
    for (const field of ['source', 'code', 'reason', 'at']) {
      expect(embedded.degraded[0][field], field).not.toContain('u:p@')
      expect(embedded.degraded[0][field], field).toContain('token=[REDACTED]')
    }
    // 导出 bundle 与页面内嵌同源（同一 safeData）→ 同样不泄漏。
    const exportBlock = /<script id="travel-export" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
    expect(exportBlock, 'travel-export 数据块缺失').toBeTruthy()
    expect(exportBlock![1]).not.toContain('u:p@')
    expect(exportBlock![1]).not.toContain('token=synthetic')
  })

  it('renderWithTemplate 直接入口：B 模式 map jscode 剥离逻辑不因顶层脱敏而回归', () => {
    const data: RenderPageData = {
      renderedAt: '2026-09-02T00:00:00.000Z',
      request: fakeRequest(),
      itinerary: {
        itineraryId: 'it-direct-b',
        days: [{ date: '2026-10-01', stops: [], meals: [] }],
        routeCheck: { issues: [], warnings: [] },
      },
      intel: {},
      degraded: [{ source: `probe ${USER_INFO}`, code: 'UNAVAILABLE', reason: 'OK' }],
      map: { provider: 'amap', amapSecurityMode: 'B', amapKey: 'TEST-KEY', amapJscode: 'SERVER-ONLY-JSCODE', serviceHost: 'http://127.0.0.1:3080', warnings: [] },
    }
    const html = renderWithTemplate(data, readFileSync(templatePath(), 'utf8'))
    expect(html).not.toContain('SERVER-ONLY-JSCODE') // B 模式 jscode 零明文（原逻辑保持）
    expect(html).toContain('"serviceHost"')
    expect(html).not.toContain('u:p@') // 顶层 degraded 同轮脱敏
  })

  it('buildRenderData：旧 rental-quotes.json 的 degraded/disclaimer 自由文本同样在页内数据里被脱敏', async () => {
    const intake = await runIntake({
      slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
    }, store)
    const planId = intake.planId
    await store.saveRequest({ ...intake.request, status: 'generating' })
    await store.writeJson(planId, 'itinerary.json', {
      itineraryId: 'it-legacy-rental',
      days: [{ date: '2026-10-01', stops: [], meals: [] }],
      routeCheck: { issues: [], warnings: [] },
    })
    await store.writeJson(planId, 'rental-quotes.json', {
      schemaVersion: 1, placesVersion: 1, inputFingerprint: 'legacy', generatedAt: '2026-09-01T00:00:00.000Z',
      quotes: [], records: [],
      degraded: [{ source: `route/amap ${USER_INFO}`, code: 'UNAVAILABLE', reason: `旧渠道失败 ${USER_INFO}`, at: `2026-09-01T00:00:00.000Z ${USER_INFO}` }],
      consultationOnly: true,
      disclaimer: `咨询级、非实时、不可预订（来源 ${USER_INFO}）`,
    })
    const built = await buildRenderData(store, planId)
    expect(built.data?.rentalQuotes).toBeDefined()
    const rental = built.data!.rentalQuotes!
    expect(rental.disclaimer).not.toContain('u:p@')
    expect(rental.disclaimer).toContain('token=[REDACTED]')
    expect(rental.degraded?.[0]?.reason).not.toContain('u:p@')
    expect(rental.degraded?.[0]?.reason).toContain('token=[REDACTED]')

    const html = renderWithTemplate(built.data!, '#{__TRAVEL_DATA__}#|#{__TRAVEL_EXPORT__}#')
    expect(html).not.toContain('u:p@')
    expect(html).not.toContain('token=synthetic')
  })
})

describe('renderItineraryPage', () => {
  it('完整产物（generating）→ ok + page.html 落盘（内嵌数据 + 标题）', async () => {
    const planId = await makeGeneratingPlan()
    const outcome = await renderItineraryPage(store, planId)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.filePath).toContain(join('.dsh-travel', planId, 'page.html'))
      expect(outcome.html).toContain('gcj02ToWgs84')
      expect(outcome.html).toContain('3 日 · 武汉')
      expect(outcome.html).toContain('intel-') // 内嵌 intel 条目（research 产出）
    }
  })

  it('transport/advice 产物在盘 → 注入页面 JSON（八区卡片数据面；缺省卡片隐藏）', async () => {
    const planId = await makeGeneratingPlan()
    await store.publishArtifacts(planId, {
      stage: 'transport', bump: ['transport'], inputFingerprint: 'render-test-transport',
      files: [{ name: 'transport.json', data: [{
        mode: 'rail',
        segments: [{ from: '武汉', to: '上海', no: 'G1', depart: '07:00', arrive: '11:30' }],
        totalPriceRange: [200, 400],
        durationMinutes: 270,
        source: { platform: 'test', url: 'https://example.invalid/t', fetchedAt: '2026-09-02T00:00:00.000Z' },
      }] }],
    })
    await store.publishArtifacts(planId, {
      stage: 'advice', bump: ['advice'], inputFingerprint: 'render-test-advice',
      files: [{ name: 'advice.json', data: {
        weather: [{ date: '2026-10-01', dayForecast: '晴', tempRange: [18, 26], source: { platform: 'test', url: 'https://example.invalid/w', fetchedAt: '2026-09-02T00:00:00.000Z' } }],
        clothing: ['薄外套'],
        packingList: ['雨伞'],
        extraTips: [],
      } }],
    })
    const outcome = await renderItineraryPage(store, planId)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.html).toContain('"transport"')
      expect(outcome.html).toContain('"advice"')
      expect(outcome.html).toContain('"map"')
      expect(dataBlockOf(outcome.html)).not.toContain('</script')
    }
  })

  it('itinerary 缺失（research 后未 build）→ ok:false + 不生成 page.html', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedResearch(store, planId, { poi: 'golden', l0: 'hits' }) // researching，无 itinerary
    const outcome = await renderItineraryPage(store, planId)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('itinerary.json')
    const pagePath = join(root, '.dsh-travel', planId, 'page.html')
    expect(existsSync(pagePath)).toBe(false) // 不产空行程页（§9.3-6）
  })
})

describe('travel_render_page 工具', () => {
  function fakeRegistrar(): { registrar: RouteRegistrarPort; calls: () => number } {
    let registers = 0
    const registrar: RouteRegistrarPort = {
      host: '127.0.0.1',
      port: 3080,
      register() { registers += 1 },
    }
    return { registrar, calls: () => registers }
  }

  it('正常渲染（generating→delivered）→ url/filePath/mapProviderUsed=leaflet + 状态推进', async () => {
    const planId = await makeGeneratingPlan()
    const { registrar, calls } = fakeRegistrar()
    const result = await runRenderPage({ planId }, store, registrar)
    expect(result.rendered).toBe(true)
    expect(result.url).toBe(`http://127.0.0.1:3080${travelPlanRoutePath(planId)}/`)
    expect(result.filePath).toContain('page.html')
    expect(result.mapProviderUsed).toBe('leaflet')
    expect(calls()).toBe(1)
    const request = await store.loadRequest(planId)
    expect(request?.status).toBe('delivered')
    // C 期：页面内嵌上游工件版本/健康度（F1c-E 决策 5 后 plan 走完整链，places 已就绪 → current/1 如实展示）
    const html = readFileSync(result.filePath, 'utf8')
    const data = JSON.parse(dataBlockOf(html)) as Record<string, unknown>
    const status = data.artifactStatus as Record<string, { version: number; state: string }>
    expect(status).toBeDefined()
    expect(status['places']).toEqual({ version: 1, state: 'current' })
    expect(status['advice']?.version).toBeGreaterThanOrEqual(0)
  })

  it('C5⑤：页面消费 artifactStatus（模板含徽标渲染逻辑 + 数据面 JSON 如实含状态）', async () => {
    const planId = await makeGeneratingPlan()
    const { registrar } = fakeRegistrar()
    const result = await runRenderPage({ planId }, store, registrar)
    expect(result.rendered).toBe(true)
    const html = readFileSync(result.filePath, 'utf8')
    // 模板含徽标渲染逻辑（运行时 DOM 生成 .artifact-badge；静态 HTML 只含 JS 源码）
    expect(html).toContain('renderArtifactStatus')
    expect(html).toContain('artifact-badge badge-')
    expect(html).toContain('上游工件状态')
    // 数据面 JSON 如实含 artifactStatus（页面渲染据此驱动徽标）
    const data = JSON.parse(dataBlockOf(html)) as Record<string, unknown>
    const status = (data.artifactStatus as Record<string, { state: string }>) ?? {}
    expect(status['places']?.state).toBe('current')
    expect(Object.keys(status).length).toBeGreaterThanOrEqual(4) // research/intel/places/advice… 全链工件
  })

  it('同 planId 二次 render → 路由幂等（delivered self；registrar 判重，无重复注册）', async () => {
    const planId = await makeGeneratingPlan()
    const server = { host: '127.0.0.1', port: 3080, register: vi.fn(() => () => {}) }
    const registrar = createDedupingRouteRegistrar(server)
    const first = await runRenderPage({ planId }, store, registrar)
    expect(first.rendered).toBe(true)
    expect(server.register).toHaveBeenCalledTimes(1)

    const second = await runRenderPage({ planId }, store, registrar) // delivered self → 幂等重渲染
    expect(second.rendered).toBe(true)
    expect(server.register).toHaveBeenCalledTimes(1) // 未重复注册
  })

  it('mapProvider=amap → 自动降级 leaflet + warning（双 loader 属 W5）', async () => {
    const planId = await makeGeneratingPlan()
    const { registrar } = fakeRegistrar()
    const result = await runRenderPage({ planId, mapProvider: 'amap' }, store, registrar)
    expect(result.mapProviderUsed).toBe('leaflet')
    expect(result.warnings.some((w) => w.includes('amap'))).toBe(true)
  })

  it('itinerary 缺失（research 后）→ rendered:false + 不注册路由', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
    const { registrar, calls } = fakeRegistrar()
    const result = await runRenderPage({ planId }, store, registrar)
    expect(result.rendered).toBe(false)
    expect(result.url).toBe('')
    expect(result.filePath).toBe('')
    expect(calls()).toBe(0)
    expect(result.warnings.some((w) => w.includes('itinerary.json'))).toBe(true)
  })

  it('全渠道失败链路：research 全挂 → build built:false → render rendered:false（不产空行程页）', async () => {
    const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
    const planId = intake.planId
    await seedResearch(store, planId, { poi: 'fail', l0: 'none' }) // researching + 无 intel
    const built = await runBuildItinerary({ planId }, store)
    expect(built.built).toBe(false)
    expect((await store.loadRequest(planId))?.status).toBe('researching') // build 不推进失败态

    const { registrar, calls } = fakeRegistrar()
    const result = await runRenderPage({ planId }, store, registrar)
    expect(result.rendered).toBe(false)
    expect((await store.loadRequest(planId))?.status).toBe('researching')
    expect(calls()).toBe(0)
  })

  it('状态非法（confirmed 且已有 itinerary——仅手术构造可达）→ InvalidTransitionError 且无半成品', async () => {
    const planId = await makeGeneratingPlan()
    // confirmed 态 + itinerary 并存不可由规范序列到达；作为 assertTransition 守卫用例手术构造
    const req = await store.loadRequest(planId)
    await store.saveRequest({ ...req!, status: 'confirmed', updatedAt: new Date().toISOString() })
    const { registrar } = fakeRegistrar()
    await expect(runRenderPage({ planId }, store, registrar)).rejects.toThrow(InvalidTransitionError)
  })
})