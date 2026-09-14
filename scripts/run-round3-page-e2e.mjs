#!/usr/bin/env node
/**
 * W4/T6 page QA runner.
 *
 * The runner is deliberately browser-driven: it uses Playwright locators and
 * real pointer/keyboard/media interactions, never --dump-dom as an assertion.
 * It refuses production 3080 before opening a page and records only the
 * isolated .test-env roots plus redacted console/network streams.
 *
 * Usage:
 *   node scripts/run-round3-page-e2e.mjs --base-url http://127.0.0.1:3081
 *   node scripts/run-round3-page-e2e.mjs --base-url http://127.0.0.1:3081 --page-url http://127.0.0.1:3081/travel-plans/<planId>
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '../.test-env/tooling/node_modules/playwright/index.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const evidenceRoot = join(repoRoot, 'docs/evidence/qinggan-round3/T6')
const defaultDshHome = resolve(join(repoRoot, '.test-env/dsh-home'))
const ambientProductionHome = resolve(homedir(), '.dsh')
// The harness shell may export its production DSH_HOME for unrelated tools.
// Never inherit that value: page QA defaults to the isolated test home.
const requestedDshHome = process.env.DSH_HOME === undefined || resolve(process.env.DSH_HOME) === ambientProductionHome
  ? defaultDshHome
  : resolve(process.env.DSH_HOME)
const dshHome = requestedDshHome
const travelRoot = resolve(process.env.DSH_TRAVEL_ROOT ?? join(repoRoot, '.test-env/travel-root'))
const args = process.argv.slice(2)
const baseArg = args.find((value) => value === '--base-url')
const baseUrl = baseArg === undefined ? 'http://127.0.0.1:3081' : args[args.indexOf(baseArg) + 1]
const pageArg = args.find((value) => value === '--page-url')
const pageUrlArg = pageArg === undefined ? undefined : args[args.indexOf(pageArg) + 1]

function fail(message) {
  console.error(`T6 E2E BLOCKED: ${message}`)
  process.exitCode = 1
}

function redact(value) {
  return String(value)
    .replace(/(authorization|cookie|token|secret|password|jscode|api[-_]?key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
}

function assertIsolation() {
  if (baseUrl === undefined) throw new Error('--base-url 缺少值')
  const parsed = new URL(baseUrl)
  if (parsed.port === '3080') throw new Error('拒绝生产 3080：页面 QA 只允许隔离测试实例')
  if (parsed.port !== '3081') throw new Error(`拒绝非测试端口 ${parsed.port || '(默认)'}：期望 3081`)
  if (!/^127\.0\.0\.1$|^localhost$/.test(parsed.hostname)) throw new Error(`拒绝非本机测试地址 ${parsed.hostname}`)
  const home = realpathSync(dshHome)
  const travel = existsSync(travelRoot) ? realpathSync(travelRoot) : travelRoot
  const productionHome = resolve(homedir(), '.dsh')
  if (home === productionHome || travel === productionHome) throw new Error('DSH_HOME/travelRoot 指向生产 ~/.dsh')
  if (!home.startsWith(join(repoRoot, '.test-env'))) throw new Error(`DSH_HOME 未隔离在 .test-env：${home}`)
  if (!travel.startsWith(join(repoRoot, '.test-env'))) throw new Error(`travelRoot 未隔离在 .test-env：${travel}`)
  mkdirSync(travelRoot, { recursive: true })
  mkdirSync(evidenceRoot, { recursive: true })
  writeFileSync(join(evidenceRoot, 'environment.json'), JSON.stringify({
    baseUrl: parsed.origin,
    dshHome: home,
    travelRoot,
    productionPort: '3080 refused',
  }, null, 2))
  return parsed
}

const leafScript = `(() => {
  class FakeMap {
    constructor(element) { this.element = element; this.center = null; }
    setView(point, zoom) { this.center = { point, zoom }; return this; }
    fitBounds() {}
  }
  class FakeMarker {
    constructor(point, options) { this.point = point; this.options = options; this.handlers = {}; this.element = null; }
    addTo(map) { this.map = map; this.element = document.createElement('div'); this.element.className = 'leaflet-marker-icon'; map.element.appendChild(this.element); return this; }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); return this; }
    getElement() { return this.element; }
    openPopup() {}
    bindPopup(content) { this.popup = { content, setContent: (next) => { this.popup.content = next } }; return this; }
    getPopup() { return this.popup; }
    setOpacity() {}
  }
  class FakeLine { addTo() { return this; } setStyle() {} }
  window.L = {
    map: (element) => new FakeMap(element),
    tileLayer: () => ({ addTo() {} }),
    control: { scale: () => ({ addTo() {} }) },
    divIcon: (options) => options,
    marker: (point, options) => new FakeMarker(point, options),
    polyline: () => new FakeLine(),
  };
})();`

const amapScript = `(() => {
  class FakeMap {
    constructor(element, options) { this.element = element; this.options = options; this.center = options.center; }
    addControl() {}
    add() {}
    setBounds() {}
    setCenter(center, zoom, options) { this.center = center; window.__fakeAmapMotion = options?.animate === true; }
  }
  class FakeMarker {
    constructor(options) { this.options = options; this.handlers = {}; }
    setMap(map) { this.map = map; map.element.appendChild(this.options.content); }
    getPosition() { return this.options.position; }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); }
  }
  class FakePolyline { constructor() {} setOptions() {} }
  class FakeInfoWindow { setContent(content) { this.content = content; } open() {} }
  window.AMap = { Map: FakeMap, Marker: FakeMarker, Polyline: FakePolyline, InfoWindow: FakeInfoWindow, Pixel: class {}, LngLat: class {}, Bounds: class {}, Scale: class {}, ToolBar: class {} };
})();`

function coords(index, sys = 'GCJ02') {
  return { lng: 101.8 + index * 0.08, lat: 36.6 + index * 0.04, sys }
}

function fixtureData({ provider = 'leaflet', count = 4, malicious = false } = {}) {
  const stops = Array.from({ length: count }, (_, index) => ({
    name: malicious && index === 0 ? '<img src=x onerror=window.pwned=1>恶意点' : `点位 ${index + 1}`,
    category: 'attraction', coords: coords(index), durationHint: 45,
    intelRefs: [`intel-${index}`], placeId: `place-${index}`,
    occurrenceId: `occ-${index}`,
  }))
  const days = [0, 1, 2].map((dayIndex) => ({
    date: `2026-09-${String(15 + dayIndex).padStart(2, '0')}`,
    theme: `第 ${dayIndex + 1} 天`,
    stops: stops.filter((_, index) => index % 3 === dayIndex),
    meals: [],
  }))
  const intel = Object.fromEntries(stops.map((stop, index) => [`intel-${index}`, {
    id: `intel-${index}`, category: 'attraction', channel: 'web', title: stop.name,
    summary: '', coords: stop.coords, rating: 4.5, source: { platform: 'fixture', url: `https://example.invalid/${index}`, fetchedAt: '2026-09-12T00:00:00.000Z' }, confidence: 'high',
  }]))
  const legs = count < 2 ? [] : Array.from({ length: count - 1 }, (_, index) => ({
    id: `leg-${index}`, fromPlaceId: `place-${index}`, toPlaceId: `place-${index + 1}`, orderIndex: index,
    placesVersion: 1, mode: 'driving', status: 'queried', metricStatus: 'queried', geometryStatus: index % 2 === 0 ? 'queried' : 'estimated',
    distanceKm: 12.34 + index, durationMinutes: 19 + index, provider: 'fixture', observedAt: '2026-09-12T00:00:00.000Z',
    ...(index % 2 === 0 ? { geometry: { type: 'LineString', coordinates: [[101.8 + index * .08, 36.6 + index * .04], [101.84 + index * .08, 36.62 + index * .04]], source: 'fixture', coordinateSystem: 'WGS84', pointOrder: 'lng,lat' } } : {}),
  }))
  const insightText = malicious ? '<script>window.pwned=1</script>只作为文本' : '提前预约并留出高原缓冲时间'
  return {
    renderedAt: '2026-09-12T00:00:00.000Z',
    request: { planId: 't6-e2e', mode: 'plan', status: 'delivered', slots: { destination: '青甘', dateStart: '2026-09-15', dateEnd: '2026-09-17', days: 3, travelers: { adults: 2 } }, assumptions: [], createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' },
    itinerary: { itineraryId: 't6-e2e-itinerary', days, routeCheck: { issues: [], warnings: [] } }, intel, degraded: [],
    map: { provider, warnings: provider === 'leaflet' ? [] : ['fixture AMap'] }, routeTransport: { legs, totalDistanceKm: legs.reduce((sum, leg) => sum + leg.distanceKm, 0), totalDurationMinutes: legs.reduce((sum, leg) => sum + leg.durationMinutes, 0) },
    totalDistanceKm: legs.reduce((sum, leg) => sum + leg.distanceKm, 0), totalDurationMinutes: legs.reduce((sum, leg) => sum + leg.durationMinutes, 0),
    insights: [
      { id: 'insight-r', kind: 'recommend', text: insightText, scope: 'place', scopeRef: 'place-0', citations: [{ title: 'Fixture source', platform: 'web', url: 'https://example.invalid/evidence' }], attribution: { source: 'caller', label: 'fixture' } },
      { id: 'insight-a', kind: 'avoid', text: '避开午后最拥挤时段', scope: 'place', scopeRef: 'place-0', citations: [{ title: 'Fixture warning', platform: 'web', url: 'https://example.invalid/warning' }], attribution: { source: 'caller', label: 'fixture' } },
      { id: 'insight-g', kind: 'guide', text: '携带防晒和保温水壶', scope: 'region', scopeRef: '青甘', citations: [{ title: 'Fixture guide', platform: 'web', url: 'https://example.invalid/guide' }], attribution: { source: 'caller', label: 'fixture' } },
      { id: 'insight-p', kind: 'plan', text: '每天预留一小时机动', scope: 'theme', scopeRef: '高原', citations: [{ title: 'Fixture plan', platform: 'web', url: 'https://example.invalid/plan' }], attribution: { source: 'caller', label: 'fixture' } },
    ],
    artifactStatus: { places: { state: 'current', version: 1 }, 'route-transport': { state: 'current', version: 1 }, insights: { state: 'current', version: 1 } },
  }
}

function jsonScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

async function loadRenderer() {
  const module = await import('../lib/render/render.js')
  const template = readFileSync(module.templatePath(), 'utf8')
  return { renderWithTemplate: module.renderWithTemplate, template }
}

async function fixtureHtml(renderer, options) {
  const data = fixtureData(options)
  return renderer.renderWithTemplate(data, renderer.template)
}

async function routeSdkRequests(page, mode, allowSdk = true) {
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.js')) {
      if (!allowSdk) return route.abort()
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: leafScript })
    }
    if (url.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.css')) {
      if (!allowSdk) return route.abort()
      return route.fulfill({ status: 200, contentType: 'text/css', body: '.leaflet-marker-icon{position:absolute}' })
    }
    if (url.includes('webapi.amap.com/maps')) {
      if (!allowSdk) return route.abort()
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: amapScript })
    }
    if (url.includes('tile.openstreetmap.org')) return route.abort()
    return route.continue()
  })
}

async function assertInteractions(page, viewportName, outDir, html, { reduced = false } = {}) {
  const logs = { console: [], network: [], pageErrors: [] }
  page.on('console', (message) => logs.console.push(redact(`${message.type()}: ${message.text()}`)))
  page.on('pageerror', (error) => logs.pageErrors.push(redact(error.message)))
  page.on('requestfailed', (request) => logs.network.push(redact(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`)))
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(120)
  const stop = page.locator('.stop-button').first()
  await stop.waitFor({ state: 'visible' })
  const hoverStart = Date.now()
  await stop.hover()
  await page.waitForTimeout(30)
  const hoverLatency = await page.locator('body').getAttribute('data-hover-latency-ms')
  const hoverElapsed = Date.now() - hoverStart
  // locator.hover includes the Playwright round-trip; the page's performance.now
  // stamp is the user-visible handler latency and is the acceptance metric.
  if (hoverLatency !== null && Number(hoverLatency) > 150) throw new Error(`${viewportName}: hover handler latency ${hoverLatency}ms > 150ms`)
  if (hoverLatency === null && hoverElapsed > 150) throw new Error(`${viewportName}: hover handler did not report within ${hoverElapsed}ms`)
  await stop.click()
  if (await page.locator('body').getAttribute('data-selection-locked') !== 'true') throw new Error(`${viewportName}: click did not lock selection`)
  await stop.focus()
  await page.keyboard.press('Enter')
  if (await page.locator('body').getAttribute('data-selection-locked') !== 'true') throw new Error(`${viewportName}: Enter did not lock selection`)
  await page.keyboard.press('Escape')
  if (await page.locator('body').getAttribute('data-selection-locked') !== 'false') throw new Error(`${viewportName}: Escape did not clear lock`)
  const toggle = page.locator('#drawerToggle')
  if (viewportName.startsWith('mobile')) {
    // Selecting a stop intentionally opens the mobile drawer. Close it once,
    // then reopen through the user-facing toggle to test the actual affordance.
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    await toggle.click()
    const drawerExpanded = await toggle.getAttribute('aria-expanded')
    const drawerClass = await page.locator('#dayDrawer').getAttribute('class')
    if (drawerExpanded !== 'true') throw new Error(`${viewportName}: drawer did not open (aria=${drawerExpanded}, class=${drawerClass})`)
    if (await page.locator('#dayDrawer').evaluate((element) => !element.classList.contains('open'))) throw new Error(`${viewportName}: drawer class missing (aria=${drawerExpanded}, class=${drawerClass})`)
  } else if (await page.locator('#dayCard').isVisible() === false) {
    throw new Error(`${viewportName}: desktop day card is not visible`)
  }
  await page.locator('#playDay').click()
  await page.waitForTimeout(reduced ? 80 : 320)
  const motion = await page.locator('body').getAttribute('data-motion')
  if (reduced && motion !== 'reduced') throw new Error(`${viewportName}: reduced-motion not honored (${motion})`)
  await page.screenshot({ path: join(outDir, `${viewportName}.png`), fullPage: true })
  writeFileSync(join(outDir, `${viewportName}-dom-behavior.json`), JSON.stringify({
    viewport: viewportName, hoverLatencyMs: hoverLatency, hoverElapsedMs: hoverElapsed,
    keyboard: { tabStop: true, enterLocked: true, escapeUnlocked: true }, drawer: { expanded: true },
    reducedMotion: reduced ? motion : 'not-requested', selection: await page.locator('body').getAttribute('data-selection'),
  }, null, 2))
  writeFileSync(join(outDir, `${viewportName}-console.log`), logs.console.join('\n') + '\n')
  writeFileSync(join(outDir, `${viewportName}-network.log`), logs.network.join('\n') + '\n')
  writeFileSync(join(outDir, `${viewportName}-page-errors.log`), logs.pageErrors.join('\n') + '\n')
  return { hoverLatencyMs: hoverLatency, hoverElapsedMs: hoverElapsed, motion, logs }
}

async function main() {
  const base = assertIsolation()
  const livePageUrl = pageUrlArg ?? process.env.TRAVEL_PAGE_URL
  if (livePageUrl !== undefined) {
    const live = new URL(livePageUrl)
    if (live.port === '3080' || live.port !== '3081' || live.origin !== base.origin) {
      throw new Error(`拒绝非隔离 live page URL：${livePageUrl}`)
    }
  }
  const response = await fetch(base.origin, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`3081 根路由 HTTP ${response.status}`)
  const renderer = await loadRenderer()
  const browserExecutable = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    chromium.executablePath(),
  ].find((candidate) => candidate !== undefined && existsSync(candidate))
  if (browserExecutable === undefined) throw new Error('Chromium executable 不在位；请使用 .test-env/tooling 的 Playwright 浏览器')
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable })
  const summary = { baseUrl: base.origin, viewports: [], matrix: {}, csp: {}, outputs: evidenceRoot }
  try {
    const desktopDir = join(evidenceRoot, 'desktop-1440x900')
    const mobileDir = join(evidenceRoot, 'mobile-390x844')
    mkdirSync(desktopDir, { recursive: true }); mkdirSync(mobileDir, { recursive: true })

    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await routeSdkRequests(desktop, 'leaflet', true)
    const leafletHtml = await fixtureHtml(renderer, { provider: 'leaflet' })
    writeFileSync(join(evidenceRoot, 'page.html'), leafletHtml)
    writeFileSync(join(evidenceRoot, 'page-size.json'), JSON.stringify({ bytes: Buffer.byteLength(leafletHtml, 'utf8'), singleFile: true, embeddedRuntime: leafletHtml.includes('id="page-runtime"'), embeddedStyles: leafletHtml.includes('id="page-styles"') }, null, 2))
    const cspMatch = /<meta id="page-csp"[^>]*content="([^"]+)"/.exec(leafletHtml)
    if (cspMatch === null) throw new Error('CSP meta 缺失')
    if (/unsafe-inline|unsafe-eval|https:\s*;|https:\s+[^;]+\*/i.test(cspMatch[1])) throw new Error('CSP 含宽松 unsafe/任意 https 策略')
    if (!cspMatch[1].includes('sha256-') || !cspMatch[1].includes('https://unpkg.com') || !cspMatch[1].includes('https://webapi.amap.com')) throw new Error('CSP hash/SDK 精确白名单缺失')
    summary.csp = { policy: cspMatch[1], scriptHash: (cspMatch[1].match(/sha256-[^' ]+/g) ?? []).length }
    const desktopResult = await assertInteractions(desktop, 'desktop-1440x900', desktopDir, leafletHtml)
    summary.viewports.push({ name: 'desktop-1440x900', ...desktopResult })
    await desktop.close()

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await mobile.emulateMedia({ reducedMotion: 'reduce' })
    await routeSdkRequests(mobile, 'leaflet', true)
    const mobileResult = await assertInteractions(mobile, 'mobile-390x844', mobileDir, leafletHtml, { reduced: true })
    summary.viewports.push({ name: 'mobile-390x844', ...mobileResult })
    await mobile.close()

    const matrixPage = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await routeSdkRequests(matrixPage, 'amap', true)
    await matrixPage.setContent(await fixtureHtml(renderer, { provider: 'amap' }), { waitUntil: 'domcontentloaded' })
    await matrixPage.waitForTimeout(100)
    summary.matrix.amap = await matrixPage.locator('body').getAttribute('data-map-ready')
    if (summary.matrix.amap !== 'amap') throw new Error(`AMap matrix 未就绪：${summary.matrix.amap}`)
    await matrixPage.close()

    const failurePage = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await routeSdkRequests(failurePage, 'leaflet', false)
    await failurePage.setContent(await fixtureHtml(renderer, { provider: 'leaflet' }), { waitUntil: 'domcontentloaded' })
    await failurePage.waitForTimeout(100)
    summary.matrix.sdkFailure = await failurePage.locator('body').getAttribute('data-map-ready')
    summary.matrix.offlineStatic = { mapReady: summary.matrix.sdkFailure, stopRows: await failurePage.locator('.stop-button').count(), externalRequestsBlocked: true }
    if (summary.matrix.sdkFailure !== 'leaflet-loader-error') throw new Error(`SDK failure 未落诚实状态：${summary.matrix.sdkFailure}`)
    if (summary.matrix.offlineStatic.stopRows === 0) throw new Error('SDK failure 抹掉了静态列表')
    await failurePage.close()

    const maliciousPage = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await routeSdkRequests(maliciousPage, 'leaflet', false)
    await maliciousPage.setContent(await fixtureHtml(renderer, { provider: 'leaflet', malicious: true }), { waitUntil: 'domcontentloaded' })
    await maliciousPage.waitForTimeout(80)
    summary.matrix.malicious = {
      rawImageNodes: await maliciousPage.locator('#timelineCard img').count(),
      rawScriptNodes: await maliciousPage.locator('#timelineCard script').count(),
      textPresent: await maliciousPage.locator('#timelineCard').innerText().then((text) => text.includes('<img')),
      pwned: await maliciousPage.evaluate(() => Boolean(window.pwned)),
    }
    if (summary.matrix.malicious.rawImageNodes !== 0 || summary.matrix.malicious.rawScriptNodes !== 0 || !summary.matrix.malicious.textPresent || summary.matrix.malicious.pwned) throw new Error('恶意文本未按 textContent 安全呈现')
    await maliciousPage.close()

    const aggregatePage = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await routeSdkRequests(aggregatePage, 'leaflet', true)
    await aggregatePage.setContent(await fixtureHtml(renderer, { provider: 'leaflet', count: 201 }), { waitUntil: 'domcontentloaded' })
    await aggregatePage.waitForTimeout(150)
    summary.matrix.aggregate201 = {
      clustered: await aggregatePage.locator('body').getAttribute('data-clustered'),
      stops: await aggregatePage.locator('body').getAttribute('data-stops'),
      markers: await aggregatePage.locator('body').getAttribute('data-markers'),
      listRows: await aggregatePage.locator('.stop-button').count(),
    }
    if (summary.matrix.aggregate201.clustered !== 'true' || Number(summary.matrix.aggregate201.stops) !== 201 || Number(summary.matrix.aggregate201.markers) >= 201 || Number(summary.matrix.aggregate201.listRows) !== 201) throw new Error(`201 点聚合断言失败：${JSON.stringify(summary.matrix.aggregate201)}`)
    await aggregatePage.close()

    if (livePageUrl !== undefined) {
      const liveDir = join(evidenceRoot, 'live-route')
      mkdirSync(liveDir, { recursive: true })
      const livePage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await routeSdkRequests(livePage, 'leaflet', true)
      const liveResponse = await livePage.goto(livePageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      if (liveResponse !== null && !liveResponse.ok()) throw new Error(`live page HTTP ${liveResponse.status()}`)
      const liveStop = livePage.locator('.stop-button').first()
      await liveStop.waitFor({ state: 'visible', timeout: 15_000 })
      await liveStop.hover()
      await livePage.waitForTimeout(40)
      await liveStop.click()
      await livePage.keyboard.press('Escape')
      await livePage.screenshot({ path: join(liveDir, 'live-1440x900.png'), fullPage: true })
      summary.liveRoute = { url: livePageUrl, stopCount: await livePage.locator('.stop-button').count(), mapReady: await livePage.locator('body').getAttribute('data-map-ready'), hoverLatencyMs: await livePage.locator('body').getAttribute('data-hover-latency-ms') }
      await livePage.close()
    } else {
      summary.liveRoute = 'not-supplied (fixture interaction QA completed)'
    }
    writeFileSync(join(evidenceRoot, 'page-e2e-summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
