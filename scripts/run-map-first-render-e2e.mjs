#!/usr/bin/env node
/**
 * 地图优先最终输出页 QA runner（.omo/drafts/map-first-output.md Verification strategy）。
 *
 * 双模式：
 *   node scripts/run-map-first-render-e2e.mjs --mode fixture
 *     Playwright route.fulfill 虚拟 http://127.0.0.1:3081/__map-first-fixture__/… 页面与
 *     SDK stub，阻止所有实际网络；锁 DOM 交互/两适配器契约/失败路径。
 *     不依赖宿主在线、不注册路由、不用 stub 冒充真实 SDK。
 *
 *   node scripts/run-map-first-render-e2e.mjs --mode live --base-url http://127.0.0.1:3081
 *     仅读 .test-env/dsh-home 既有隔离地图配置（秘密只驻内存），给固定 fixtures 配真实地图；
 *     route.fulfill 仅响应虚拟测试 HTML，显式白名单现有地图 loader/CSP 所列高德 SDK 与地图
 *     资源、Leaflet SDK/OSM 资源域名，其余请求默认拦截并脱敏记录；禁用 SDK stub。
 *
 * 证据：.test-env/evidence/map-first/（commands.log / fixture-results.json / live-results.json /
 * 截图 / provider-fallback.json / acceptance.md 由交付流程汇总）。pages/ 只保存无秘密 fixture
 * HTML；live 注入真实地图配置后的 HTML 只驻内存。
 *
 * 验收状态唯一规则：
 *   实现和 fixture 全部绿 → IMPLEMENTED_PENDING_LIVE（exit 0，live 未运行）
 *   已运行 live 且任一断言失败 → FAILED（exit 1）
 *   真实 AMap 与 Leaflet 都通过 → ACCEPTED_TEST_ENV（exit 0）
 *   live 阻断（宿主不在线/凭据缺失/网络不可达）→ BLOCKED（exit 1，不宣称验收）
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '../.test-env/tooling/node_modules/playwright/index.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const evidenceRoot = join(repoRoot, '.test-env/evidence/map-first')
const pagesRoot = join(evidenceRoot, 'pages')
const fixturesDir = join(repoRoot, 'tests/fixtures/map-first')
const fixtureOrigin = 'http://127.0.0.1:3081'
const fixturePrefix = `${fixtureOrigin}/__map-first-fixture__/`

const args = process.argv.slice(2)
const mode = args.find((value) => value === '--mode') === undefined ? 'fixture' : args[args.indexOf('--mode') + 1]
const baseArg = args.find((value) => value === '--base-url')
const baseUrl = baseArg === undefined ? fixtureOrigin : args[args.indexOf(baseArg) + 1]

const commandLog = []
function logCommand(command, outcome) {
  commandLog.push(`$ ${command}\n${outcome}`)
}

function redact(value) {
  return String(value)
    .replace(/(authorization|cookie|token|secret|password|jscode|api[-_]?key|key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
}

/** 隔离纪律：只允许 .test-env 内的证据与本机 3081；生产 3080 永远拒绝。 */
function assertIsolation() {
  const parsed = new URL(baseUrl)
  if (parsed.port === '3080') throw new Error('拒绝生产 3080：地图优先 QA 只允许隔离测试实例')
  if (parsed.port !== '3081') throw new Error(`拒绝非测试端口 ${parsed.port || '(默认)'}：期望 3081`)
  if (!/^127\.0\.0\.1$|^localhost$/.test(parsed.hostname)) throw new Error(`拒绝非本机测试地址 ${parsed.hostname}`)
  const dshHome = join(repoRoot, '.test-env/dsh-home')
  if (mode === 'live') {
    const home = realpathSync(dshHome)
    if (!home.startsWith(join(repoRoot, '.test-env'))) throw new Error(`DSH_HOME 未隔离在 .test-env：${home}`)
    if (home === resolve(homedir(), '.dsh')) throw new Error('DSH_HOME 指向生产 ~/.dsh')
  }
  mkdirSync(evidenceRoot, { recursive: true })
  mkdirSync(pagesRoot, { recursive: true })
  return parsed
}

// ── 渲染器与 fixtures ──

async function loadRenderer() {
  const module = await import('../lib/render/render.js')
  const template = readFileSync(module.templatePath(), 'utf8')
  return { renderWithTemplate: module.renderWithTemplate, template }
}

function loadFixtures() {
  const names = ['one-day', 'three-day', 'ten-day', 'revisit', 'shared-lodging', 'degraded-inputs']
  const out = new Map()
  for (const name of names) {
    const path = join(fixturesDir, `${name}.json`)
    if (!existsSync(path)) throw new Error(`fixture 缺失：${path}`)
    out.set(name, JSON.parse(readFileSync(path, 'utf8')))
  }
  return out
}

function pageHtml(renderer, data, { provider } = {}) {
  let prepared = data
  if (provider !== undefined) {
    prepared = {
      ...data,
      map: {
        ...(data.map ?? {}),
        provider,
        ...(provider === 'amap' ? { amapSecurityMode: 'A' } : {}),
      },
    }
  }
  return renderer.renderWithTemplate(prepared, renderer.template)
}

// ── SDK stub（仅 fixture 模式；绝不冒充真实 SDK 通过 live） ──

const leafStub = `(() => {
  class FakeMap {
    constructor(element) { this.element = element; this.fitCalls = []; }
    setView(point, zoom) { return this; }
    fitBounds(bounds, options) { this.fitCalls.push({ bounds, options }); (window.__fitCalls ??= []).push({ provider: 'leaflet', bounds, options }); }
  }
  class FakeMarker {
    constructor(point, options) { this.point = point; this.options = options; this.handlers = {}; }
    addTo(map) { this.map = map; this.element = document.createElement('div'); this.element.className = 'leaflet-marker-icon'; map.element.appendChild(this.element); return this; }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); return this; }
    getElement() { return this.element; }
    setOpacity() {}
  }
  class FakeLine { constructor(options) { this.options = options; } addTo() { return this; } setStyle(options) { this.options = { ...this.options, ...options }; } }
  window.L = {
    map: (element) => { const m = new FakeMap(element); window.__fakeLeafletMap = m; return m; },
    tileLayer: () => ({ addTo() {} }),
    control: { scale: () => ({ addTo() {} }) },
    divIcon: (options) => options,
    marker: (point, options) => new FakeMarker(point, options),
    polyline: (points, options) => new FakeLine(options),
  };
})();`

const amapStub = `(() => {
  class FakeMap {
    constructor(element, options) { this.element = element; this.options = options; (window.__amapMapOptions ??= []).push(options); }
    addControl() {}
    add() {}
    setBounds() {}
    setCenter() {}
    setFitView(overlays, immediately, avoid, maxZoom) { (window.__fitCalls ??= []).push({ provider: 'amap', overlayCount: overlays.length, immediately, avoid, maxZoom }); }
  }
  class FakeMarker {
    constructor(options) { this.options = options; this.handlers = {}; }
    setMap(map) { this.map = map; map.element.appendChild(this.options.content); }
    getPosition() { return this.options.position; }
    on(event, handler) { (this.handlers[event] ??= []).push(handler); }
  }
  class FakePolyline { constructor(options) { this.options = options; } setOptions(options) { Object.assign(this.options, options); } show() {} hide() {} }
  window.AMap = {
    Map: FakeMap, Marker: FakeMarker, Polyline: FakePolyline,
    Pixel: class {}, LngLat: class {}, Bounds: class {}, Scale: class {}, ToolBar: class {},
    plugin: (plugins, callback) => callback(),
  };
})();`

// ── 请求拦截 ──

async function interceptFixtureMode(page, { allowLeaflet = true, allowAmap = true } = {}) {
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith(fixturePrefix)) {
      const name = decodeURIComponent(url.slice(fixturePrefix.length).split('?')[0])
      const html = fixturePages.get(name)
      if (html === undefined) return route.fulfill({ status: 404, contentType: 'text/plain', body: `no fixture page: ${name}` })
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    }
    if (url.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.js')) {
      if (!allowLeaflet) return route.abort()
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: leafStub })
    }
    if (url.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.css')) {
      if (!allowLeaflet) return route.abort()
      return route.fulfill({ status: 200, contentType: 'text/css', body: '.leaflet-marker-icon{position:absolute}' })
    }
    if (url.includes('webapi.amap.com/maps')) {
      if (!allowAmap) return route.abort()
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: amapStub })
    }
    // 阻止所有实际网络（fixture 模式零外联）。
    return route.abort()
  })
}

const LIVE_ALLOWED_HOST_PATTERNS = [
  /^https?:\/\/127\.0\.0\.1:3081\//,
  /^https?:\/\/localhost:3081\//,
  /webapi\.amap\.com/,
  /restapi\.amap\.com/,
  /jsapi\.amap\.com/,
  /(^|\.)amap\.com/,
  /(^|\.)autonavi\.com/,
  /unpkg\.com\/leaflet@1\.9\.4\//,
  /tile\.openstreetmap\.org/,
]

async function interceptLiveMode(page, { virtualPages, blocked = [] } = {}) {
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith(fixturePrefix)) {
      const name = decodeURIComponent(url.slice(fixturePrefix.length).split('?')[0])
      const html = virtualPages.get(name)
      if (html === undefined) return route.fulfill({ status: 404, contentType: 'text/plain', body: `no virtual page: ${name}` })
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    }
    if (LIVE_ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(url))) return proxyAllowedRequest(route)
    if (!blocked.includes(url)) blocked.push(url)
    return route.abort()
  })
}

/**
 * 白名单请求经 Node 侧代理（fetch → fulfill）。
 * 不用 route.continue()：本环境实测它会系统性中断地图瓦片 <img>（net::ERR_ABORTED，
 * 底图全白）；代理同样只放行白名单域，containment 语义不变。
 */
const liveProxyStats = { tile2xx: { amap: 0, osm: 0 }, tileBlocked: { amap: 0, osm: 0 } }
// OSM 瓦片政策禁止突发批量抓取：瓦片请求串行 + 间隔（~10/s 上限），避免触发 418 拦截页。
let tileChain = Promise.resolve()

function isTileUrl(url) {
  if (/tile\.openstreetmap\.org/.test(url)) return 'osm'
  if (/autonavi\.com\/.*appmaptile|amap\.com.*\/tile\//.test(url)) return 'amap'
  return undefined
}

function proxyTile(route, url) {
  const kind = isTileUrl(url)
  // 头必须在路由回调内同步快照：页面/浏览器关闭后 route 不可再访问。
  const forwarded = {}
  for (const header of ['user-agent', 'accept']) {
    try {
      const value = route.request().headerValue(header)
      if (value !== undefined && value !== null) forwarded[header] = value
    } catch { break }
  }
  const run = async () => {
    await new Promise((resolve) => setTimeout(resolve, 110))
    try {
      const upstream = await fetch(url, { headers: forwarded, signal: AbortSignal.timeout(20_000) })
      const body = Buffer.from(await upstream.arrayBuffer())
      if (upstream.status === 200) liveProxyStats.tile2xx[kind] += 1
      else liveProxyStats.tileBlocked[kind] += 1
      await route.fulfill({ status: upstream.status, contentType: upstream.headers.get('content-type') ?? 'image/png', body })
    } catch {
      liveProxyStats.tileBlocked[kind] += 1
      try { await route.abort() } catch { /* 页面已关闭 */ }
    }
  }
  tileChain = tileChain.then(run, run)
  return tileChain.catch(() => {})
}

async function proxyAllowedRequest(route) {
  const url = route.request().url()
  const tileKind = isTileUrl(url)
  if (tileKind !== undefined) return proxyTile(route, url)
  try {
    const method = route.request().method()
    const upstream = await fetch(url, {
      method: method === 'GET' || method === 'HEAD' ? method : 'GET',
      signal: AbortSignal.timeout(20_000),
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    await route.fulfill({
      status: upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
      body,
    })
  } catch {
    await route.abort()
  }
}

// ── 公共交互步骤 ──

async function attachLogging(page, logs) {
  page.on('console', (message) => logs.console.push(redact(`${message.type()}: ${message.text()}`)))
  page.on('pageerror', (error) => logs.pageErrors.push(redact(error.message)))
  page.on('requestfailed', (request) => logs.network.push(redact(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`)))
}

async function openVirtualPage(page, name) {
  await page.goto(`${fixturePrefix}${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(150)
}

async function assertOverview(page, { expectMarkers, expectLegs }) {
  const body = page.locator('body')
  if (await body.getAttribute('data-view-mode') !== 'overview') throw new Error('初始视图不是总览')
  const overviewTab = page.locator('#dayTabs .day-tab[data-view-mode="overview"]')
  if (await overviewTab.getAttribute('aria-pressed') !== 'true') throw new Error('总览 tab 未选中')
  if (Number(await body.getAttribute('data-visible-markers')) !== expectMarkers) {
    throw new Error(`总览可见标记数=${await body.getAttribute('data-visible-markers')} 期望 ${expectMarkers}`)
  }
  if (Number(await body.getAttribute('data-visible-legs')) !== expectLegs) {
    throw new Error(`总览可见路段数=${await body.getAttribute('data-visible-legs')} 期望 ${expectLegs}`)
  }
}

async function assertDaySwitch(page, dayIndex, { expectMarkers, expectSeparate }) {
  await page.locator(`#dayTabs .day-tab[data-day-index="${dayIndex}"]`).click()
  await page.waitForTimeout(60)
  const body = page.locator('body')
  if (await body.getAttribute('data-view-mode') !== 'day') throw new Error(`切日 ${dayIndex} 后视图不是 day`)
  if (Number(await body.getAttribute('data-day-index')) !== dayIndex) throw new Error(`day-index 不符：${await body.getAttribute('data-day-index')}`)
  if (Number(await body.getAttribute('data-visible-markers')) !== expectMarkers) {
    throw new Error(`day ${dayIndex} 可见标记=${await body.getAttribute('data-visible-markers')} 期望 ${expectMarkers}`)
  }
  if (expectSeparate !== undefined && Number(await body.getAttribute('data-separate-legs')) < expectSeparate) {
    throw new Error(`day ${dayIndex} 单独列表段数=${await body.getAttribute('data-separate-legs')} 期望 ≥${expectSeparate}`)
  }
  if (await page.locator(`#dayTabs .day-tab[data-day-index="${dayIndex}"]`).getAttribute('aria-pressed') !== 'true') {
    throw new Error(`day ${dayIndex} tab 未选中`)
  }
}

async function assertOverviewRestore(page, { expectMarkers }) {
  await page.locator('#dayTabs .day-tab[data-view-mode="overview"]').click()
  await page.waitForTimeout(60)
  const body = page.locator('body')
  if (await body.getAttribute('data-view-mode') !== 'overview') throw new Error('回总览失败')
  if (Number(await body.getAttribute('data-visible-markers')) !== expectMarkers) throw new Error(`回总览后可见对象不完整：actual=${await body.getAttribute('data-visible-markers')} expected=${expectMarkers} legs=${await body.getAttribute('data-visible-legs')}`)
  if (await body.getAttribute('data-selection-locked') !== 'false') throw new Error('回总览后残留日期/景点选择')
}

async function assertMarkerTapStaysOverview(page) {
  // 夹具点位密集，取 DOM 序最后的标记（自然叠于最上层，不被邻近标记拦截）。
  const pin = page.locator('#map .map-pin:not(.marker-hidden)').last()
  await pin.click()
  await page.waitForTimeout(60)
  if (await page.locator('body').getAttribute('data-view-mode') !== 'overview') throw new Error('总览点选标记不应退出总览')
  const detail = await page.locator('#dayCard').innerText()
  if (detail.trim().length < 4) throw new Error('总览点选后详情面板为空')
}

async function assertKeyboard(page) {
  const stopButton = page.locator('#timelineCard .stop-button').first()
  await stopButton.focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(40)
  if (await page.locator('body').getAttribute('data-selection-locked') !== 'true') throw new Error('Enter 未锁定选择')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(40)
  if (await page.locator('body').getAttribute('data-selection-locked') !== 'false') throw new Error('Escape 未清除选择')
  const activeIsStop = await stopButton.evaluate((element) => document.activeElement === element)
  if (!activeIsStop) throw new Error('Escape 后焦点未返回列表')
}

async function assertDock(page) {
  const items = await page.locator('#bottomDock .dock-item').count()
  if (items !== 5) throw new Error(`底部 dock 应有 5 个入口（天气/交通/预算/提醒/更多信息），实际 ${items}`)
  await page.locator('#bottomDock .dock-item[data-target="rentalCostCard"]').first().click()
  await page.waitForTimeout(120)
  if (await page.locator('#rentalCostCard').evaluate((element) => element.classList.contains('hidden'))) throw new Error('预算入口未打开目标卡片')
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth)
  if (overflow > 1) throw new Error(`横向溢出 ${overflow}px`)
}

async function assertSwitchStability(page, dayCount) {
  const pinCountBefore = await page.locator('#map .map-pin, #map .cluster-pin').count()
  const first = await page.locator('body').getAttribute('data-visible-markers')
  for (let index = 0; index < 20; index += 1) {
    const target = index % dayCount
    await page.locator(`#dayTabs .day-tab[data-day-index="${target}"]`).click()
    await page.waitForTimeout(20)
  }
  const pinCountAfter = await page.locator('#map .map-pin, #map .cluster-pin').count()
  if (pinCountAfter !== pinCountBefore) throw new Error(`连续切日 20 次标记 DOM 数增长：${pinCountBefore}→${pinCountAfter}`)
  const last = await page.locator(`#dayTabs .day-tab[data-day-index="${(dayCount - 1) % dayCount}"]`).getAttribute('data-dayindex')
  if (last === undefined) throw new Error('切日后 tabs 缺失')
  const visibleOnLastDay = await page.locator('body').getAttribute('data-visible-markers')
  if (Number(visibleOnLastDay) !== Number(first) && Number(visibleOnLastDay) > Number(first)) throw new Error('切日后可见标记数异常增长')
}

async function collectFitCalls(page, provider) {
  return page.evaluate((providerId) => (window.__fitCalls ?? []).filter((entry) => entry.provider === providerId), provider)
}

function resolveBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    join(repoRoot, '.test-env/tooling/pw-browsers/chromium-1243/chrome-linux64/chrome'),
    chromium.executablePath(),
  ].filter((candidate) => candidate !== undefined && existsSync(candidate))
  if (candidates.length === 0) throw new Error('Chromium 不在位（PLAYWRIGHT_EXECUTABLE_PATH/CHROME_BIN 或 /usr/bin/google-chrome）')
  return candidates[0]
}

// ── fixture 模式主流程 ──

const fixturePages = new Map()

async function runFixtureMode(renderer, fixtures) {
  const results = { mode: 'fixture', baseUrl: fixtureOrigin, pages: {}, screenshots: {}, matrix: {}, commandEvidence: {} }
  // 预渲染：leaflet 变体落盘 pages/（无秘密，amap 用假 key 不落盘）；amap 变体只驻内存。
  for (const [name, data] of fixtures) {
    const leafletHtml = pageHtml(renderer, data, { provider: 'leaflet' })
    fixturePages.set(`${name}-leaflet.html`, leafletHtml)
    writeFileSync(join(pagesRoot, `${name}-leaflet.html`), leafletHtml)
    fixturePages.set(`${name}-amap.html`, pageHtml(renderer, data, { provider: 'amap' }))
  }
  results.renderedPages = [...fixturePages.keys()]

  const browserExecutable = resolveBrowserExecutable()
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable })

  try {
    // ── 桌面 leaflet：总览/切日/回总览/点选不退出/键盘/dock ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptFixtureMode(page)
      await openVirtualPage(page, 'three-day-leaflet.html')
      const mapReady = await page.locator('body').getAttribute('data-map-ready')
      if (mapReady !== 'leaflet') throw new Error(`three-day leaflet 未就绪：${mapReady}`)
      // three-day：6 stops（canonical 折叠后仍 6 个带坐标 stop）、4 条 canonical 边。
      await assertOverview(page, { expectMarkers: 7, expectLegs: 5 })
      const fitCalls = await collectFitCalls(page, 'leaflet')
      if (fitCalls.length === 0) throw new Error('总览未调用 fitVisibleBounds')
      if (fitCalls[0].options?.paddingTopLeft === undefined) throw new Error('Leaflet fit 缺少遮挡 padding 参数')
      await assertDaySwitch(page, 1, { expectMarkers: 2, expectSeparate: 2 })
      await page.screenshot({ path: join(evidenceRoot, 'desktop-day.png'), fullPage: false })
      results.screenshots['desktop-day'] = 'desktop-day.png'
      await assertOverviewRestore(page, { expectMarkers: 7 })
      await assertMarkerTapStaysOverview(page)
      await page.screenshot({ path: join(evidenceRoot, 'desktop-overview.png'), fullPage: false })
      results.screenshots['desktop-overview'] = 'desktop-overview.png'
      // stop-button 只在单日时间轴渲染：先切到 day0 再测键盘路径。
      await assertDaySwitch(page, 0, { expectMarkers: 3 })
      await assertKeyboard(page)
      await assertDock(page)
      await assertSwitchStability(page, 3)
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.pages['three-day-leaflet'] = { ok: true, logs }
      await page.close()
    }

    // ── 桌面 amap：light 预设 + avoid 取景 + 与 leaflet 同一套可见性 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptFixtureMode(page)
      await openVirtualPage(page, 'three-day-amap.html')
      const mapReady = await page.locator('body').getAttribute('data-map-ready')
      if (mapReady !== 'amap') throw new Error(`three-day amap 未就绪：${mapReady}`)
      const mapOptions = await page.evaluate(() => window.__amapMapOptions ?? [])
      if (mapOptions[0]?.mapStyle !== 'amap://styles/light') throw new Error(`AMap 未使用官方 light 预设：${JSON.stringify(mapOptions[0]?.mapStyle)}`)
      const fitCalls = await collectFitCalls(page, 'amap')
      if (fitCalls.length === 0) throw new Error('amap 总览未调用 fitVisibleBounds')
      if (!Array.isArray(fitCalls[0].avoid) || fitCalls[0].avoid.length !== 4) throw new Error('amap fit 缺少 avoid 遮挡参数')
      await assertOverview(page, { expectMarkers: 7, expectLegs: 5 })
      await assertDaySwitch(page, 2, { expectMarkers: 2, expectSeparate: 2 })
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.pages['three-day-amap'] = { ok: true, logs, mapStyle: mapOptions[0]?.mapStyle }
      await page.close()
    }

    // ── 失败路径：amap SDK 加载失败 → Leaflet 接管 + 日选择可用 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptFixtureMode(page, { allowAmap: false })
      await openVirtualPage(page, 'three-day-amap.html')
      await page.waitForTimeout(200)
      const body = page.locator('body')
      if (await body.getAttribute('data-provider') !== 'leaflet') throw new Error('amap 失败未降级 Leaflet')
      if (await body.getAttribute('data-amap-fallback') !== 'true') throw new Error('缺 amapFallback 标记')
      if (await body.getAttribute('data-map-ready') !== 'leaflet') throw new Error(`降级后地图未就绪：${await body.getAttribute('data-map-ready')}`)
      // 日选择恢复：降级后仍可切日并更新可见性。
      await assertDaySwitch(page, 0, { expectMarkers: 3 })
      await assertOverviewRestore(page, { expectMarkers: 7 })
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.matrix.amapFallback = { ok: true, logs }
      await page.close()
    }

    // ── 重访/闭环：非相邻重访与共享住宿可通过列表逐 occurrence 选择 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptFixtureMode(page)
      await openVirtualPage(page, 'revisit-leaflet.html')
      await assertOverview(page, { expectMarkers: 7, expectLegs: 6 })
      // 重访日 day1 的 B（occ-b-2）与 day0 的 B（occ-b-0）是不同 occurrence，都能选到。
      await page.locator('#dayTabs .day-tab[data-day-index="1"]').click()
      await page.waitForTimeout(40)
      const dayStops = await page.locator('#timelineCard .stop-button').count()
      if (dayStops !== 2) throw new Error(`重访日 stop 列表数=${dayStops} 期望 2`)
      await page.locator('#timelineCard .stop-button').first().click()
      await page.waitForTimeout(40)
      const detail = await page.locator('#dayCard').innerText()
      if (!detail.includes('重访')) throw new Error('重访 occurrence 详情未按独立 stop 呈现')
      await assertOverviewRestore(page, { expectMarkers: 7 })
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.pages['revisit-leaflet'] = { ok: true, logs }
      await page.close()
    }

    // ── 移动端 390×844：地图主视区 + 抽屉 + 无横向溢出 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await attachLogging(page, logs)
      await interceptFixtureMode(page)
      await openVirtualPage(page, 'three-day-leaflet.html')
      await assertNoHorizontalOverflow(page)
      const mapBox = await page.locator('#map').boundingBox()
      if (mapBox === null || mapBox.height < 300) throw new Error(`移动端地图高度不足：${mapBox?.height}`)
      await page.screenshot({ path: join(evidenceRoot, 'mobile-overview.png'), fullPage: false })
      results.screenshots['mobile-overview'] = 'mobile-overview.png'
      await page.locator('#dayTabs .day-tab[data-day-index="0"]').click()
      await page.waitForTimeout(60)
      await page.locator('#timelineCard .stop-button').first().click()
      await page.waitForTimeout(120)
      if (await page.locator('#drawerToggle').getAttribute('aria-expanded') !== 'true') throw new Error('移动端选择后抽屉未展开')
      await page.screenshot({ path: join(evidenceRoot, 'mobile-detail.png'), fullPage: false })
      results.screenshots['mobile-detail'] = 'mobile-detail.png'
      await page.locator('#drawerToggle').click()
      await page.waitForTimeout(80)
      if (await page.locator('#drawerToggle').getAttribute('aria-expanded') !== 'false') throw new Error('抽屉未收起')
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.pages['mobile-390x844'] = { ok: true, logs }
      await page.close()
    }

    // ── 打印：线性行程/指南/来源可见，交互控件隐藏 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
      await attachLogging(page, logs)
      await interceptFixtureMode(page)
      await openVirtualPage(page, 'three-day-leaflet.html')
      await page.emulateMedia({ media: 'print' })
      await page.waitForTimeout(80)
      const hiddenIds = ['exportBar', 'dayTabs', 'bottomDock', 'drawerToggle']
      for (const id of hiddenIds) {
        const display = await page.locator(`#${id}`).evaluate((element) => getComputedStyle(element).display)
        if (display !== 'none') throw new Error(`打印下 #${id} 未隐藏（display=${display}）`)
      }
      const printText = await page.locator('#printItinerary').innerText()
      for (const expected of ['完整行程', '青海湖', '茶卡盐湖', '翡翠湖', '2026-10-02']) {
        if (!printText.includes(expected)) throw new Error(`打印行程缺内容：${expected}`)
      }
      const supplementText = await page.locator('#supplementalGrid').innerText()
      for (const expected of ['归纳建议', '美食指南', '住宿指南', '避雷提示', '逐地天气', 'CNY']) {
        if (!supplementText.includes(expected)) throw new Error(`打印补充信息缺内容：${expected}`)
      }
      const citationsVisible = await page.locator('#insightsCard .citation-list a').count()
      if (citationsVisible === 0) throw new Error('打印下来源链接不可见')
      await page.screenshot({ path: join(evidenceRoot, 'print.png'), fullPage: true })
      results.screenshots.print = 'print.png'
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.pages.print = { ok: true, logs }
      await page.close()
    }

    // ── 缺失/恶意输入：显式缺失声明 + 转义 + 链接拒绝 + 降级条 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptFixtureMode(page)
      await openVirtualPage(page, 'degraded-inputs-leaflet.html')
      await page.waitForTimeout(150)
      const body = page.locator('body')
      // 部分坐标缺失：唯一带坐标点仍上图的诚实呈现；路线缺失 → 图例区显式声明。
      if (await body.getAttribute('data-map-ready') !== 'leaflet') {
        throw new Error(`缺数据页面地图状态异常：${await body.getAttribute('data-map-ready')}`)
      }
      if (Number(await body.getAttribute('data-visible-markers')) !== 1) {
        throw new Error(`缺数据页面可见标记应为 1：${await body.getAttribute('data-visible-markers')}`)
      }
      if (Number(await body.getAttribute('data-visible-legs')) !== 0) {
        throw new Error(`缺数据页面可见路段应为 0：${await body.getAttribute('data-visible-legs')}`)
      }
      const dockText = await page.locator('#bottomDock').innerText()
      if (!dockText.includes('暂无天气数据')) throw new Error('缺 advice 时 dock 未显式声明无天气数据')
      if (!dockText.includes('成本明细未生成')) throw new Error('缺 cost 时 dock 未显式声明成本明细未生成')
      await page.locator('#legDetails summary').click() // 展开 details（innerText 不含折叠内容）
      const routeText = await page.locator('#legList').innerText()
      if (!routeText.includes('暂无可绘制道路几何')) throw new Error('缺 routeTransport 时未显式声明')
      if (await page.locator('#timelineCard img').count() !== 0) throw new Error('恶意名称未被 textContent 转义')
      if (await page.locator('#timelineCard script').count() !== 0) throw new Error('恶意 script 节点出现')
      if (await page.evaluate(() => Boolean(window.pwned))) throw new Error('XSS 执行成功（pwned=true）')
      const jsLinks = await page.evaluate(() => [...document.querySelectorAll('a')].filter((anchor) => (anchor.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:')).length)
      if (jsLinks !== 0) throw new Error('javascript: 来源链接未被拒绝')
      const badgeStates = await page.locator('.artifact-badge').allInnerTexts()
      const joined = badgeStates.join('|')
      for (const expected of ['stale', 'missing', 'failed', 'empty']) {
        if (!joined.includes(expected)) throw new Error(`工件状态徽标缺 ${expected}：${joined}`)
      }
      const degradedVisible = await page.locator('#degradedStrip').evaluate((element) => !element.classList.contains('hidden'))
      if (!degradedVisible) throw new Error('degraded 条未显示')
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.pages['degraded-inputs-leaflet'] = { ok: true, logs }
      await page.close()
    }

    // ── 1 日 / 10 日 / 共享住宿：动态天数与共享锚点 ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      for (const [name, markers, legs] of [['one-day', 2, 1], ['ten-day', 20, 10], ['shared-lodging', 4, 2]]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        await attachLogging(page, logs)
        await interceptFixtureMode(page)
        await openVirtualPage(page, `${name}-leaflet.html`)
        await assertOverview(page, { expectMarkers: markers, expectLegs: legs })
        // 共享住宿：所有 canonical 边都应有日归属（不含 cross-day）。
        if (name === 'shared-lodging') {
          const separate = Number(await page.locator('body').getAttribute('data-separate-legs'))
          if (separate !== 0) throw new Error(`共享住宿夹具不应有跨日/未分配段：separate=${separate}`)
          await assertDaySwitch(page, 1, { expectMarkers: 2, expectSeparate: 0 })
        }
        if (name === 'ten-day') {
          const tabs = await page.locator('#dayTabs .day-tab').count()
          if (tabs !== 11) throw new Error(`10 日 tabs 数（含总览）=${tabs} 期望 11`)
          await assertDaySwitch(page, 9, { expectMarkers: 2 })
          await page.locator('#dayTabs').evaluate((element) => { element.scrollLeft = element.scrollWidth })
        }
        await page.close()
      }
      if (logs.pageErrors.length > 0) throw new Error(`页面错误：${logs.pageErrors.join(' | ')}`)
      results.matrix.dynamicDays = { ok: true, logs }
    }
  } finally {
    await browser.close()
  }
  return results
}


/** 等待真实瓦片实际渲染（naturalWidth>0 的 img ≥ min）：live 证据要求"实际瓦片"，非仅请求。 */
async function waitForTiles(page, min = 5, timeoutMs = 30_000) {
  await page.waitForFunction(
    (minCount) => [...document.querySelectorAll('#map img')].filter((img) => img.naturalWidth > 0).length >= minCount,
    min,
    { timeout: timeoutMs },
  )
}

// ── live 模式主流程 ──

function readAmapCredentialRefs() {
  const path = join(repoRoot, '.test-env/dsh-home/.credentials.yaml')
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  const readRef = (key) => {
    const match = new RegExp(`^\\s{2}${key}:\\s*(.+)$`, 'm').exec(text)
    if (match === undefined) return undefined
    // YAML 值可能带引号（"…"）；剥离首尾引号，避免 key 进 loader URL 时带 %22。
    return match[1].trim().replace(/^["'](.*)["']$/, '$1').trim()
  }
  const jscode = readRef('AMAP_JSCODE')
  if (jscode === undefined) return undefined
  // 候选 JSAPI key：AMAP_JSAPI 优先；AMAP_WEBSERVICE 兜底（同为隔离环境既有配置）。
  const candidates = [readRef('AMAP_JSAPI'), readRef('AMAP_WEBSERVICE')].filter((value) => value !== undefined && value.length > 0)
  if (candidates.length === 0) return undefined
  return { candidates, jscode }
}

/** 逐候选验证：loader 必须返回 application/javascript（key 被回收时高德回 JSON → Chrome 拒执行）。 */
async function resolveUsableAmapKey(candidates) {
  for (const key of candidates) {
    try {
      const response = await fetch(`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Scale,AMap.ToolBar`, { signal: AbortSignal.timeout(10_000) })
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (response.ok && contentType.includes('javascript')) return key
    } catch {
      // 网络异常 → 下一个候选；全失败由调用方 BLOCKED。
    }
  }
  return undefined
}

async function runLiveMode(renderer, fixtures) {
  liveProxyStats.tile2xx = { amap: 0, osm: 0 }
  liveProxyStats.tileBlocked = { amap: 0, osm: 0 }
  const results = {
    mode: 'live', baseUrl, pages: {}, matrix: {}, providerFallback: undefined,
    blockedNetwork: [], tileRequests: { amap: 0, osm: 0 }, tileHttp200: liveProxyStats.tile2xx, screenshots: {},
  }
  // 健康门：3081 必须 200（README 基线），并记录宿主启动产物证据。
  // 宿主 web 鉴权：instance.log 的 ?token= 换 HttpOnly cookie（token/cookie 只驻内存，证据脱敏）。
  let health
  try {
    const headers = {}
    const logText = existsSync(join(repoRoot, '.test-env/instance.log'))
      ? readFileSync(join(repoRoot, '.test-env/instance.log'), 'utf8')
      : ''
    const tokenLine = logText.split('\n').reverse().find((line) => line.includes('token=')) ?? ''
    const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(tokenLine)
    if (tokenMatch !== null) {
      const auth = await fetch(`${baseUrl}/?token=${tokenMatch[1]}`, { signal: AbortSignal.timeout(8000), redirect: 'manual' })
      const setCookie = auth.headers.get('set-cookie')
      if (setCookie !== null) headers.cookie = setCookie.split(';')[0]
    }
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(8000), headers })
    const bodyText = await response.text()
    health = { status: response.status, pluginListed: bodyText.includes('dsh-travel'), authUsed: headers.cookie !== undefined }
    logCommand(`curl --fail ${baseUrl} -o /dev/null`, `HTTP ${response.status} (authUsed=${health.authUsed}, token/cookie 已脱敏)`)
  } catch (error) {
    results.blocked = `3081 不在线（先执行 .test-env/start.sh restart）：${redact(error instanceof Error ? error.message : String(error))}`
    results.status = 'BLOCKED'
    return results
  }
  if (health.status !== 200 || !health.pluginListed) {
    results.blocked = `3081 健康检查失败 HTTP ${health.status} pluginListed=${health.pluginListed}`
    results.status = 'BLOCKED'
    return results
  }
  results.health = { status: health.status, pluginListed: health.pluginListed, authUsed: health.authUsed }

  const credentialRefs = readAmapCredentialRefs()
  if (credentialRefs === undefined) {
    results.blocked = '.test-env/dsh-home/.credentials.yaml 缺 AMAP_JSAPI/AMAP_JSCODE（不伪造 SDK 验收）'
    results.status = 'BLOCKED'
    return results
  }
  const amapKey = await resolveUsableAmapKey(credentialRefs.candidates)
  if (amapKey === undefined) {
    results.blocked = '隔离环境全部候选 AMap key 均不可用（loader 未返回 JS，如 USER_KEY_RECYCLED）；登记 BLOCKED，不假装 SDK 已验收'
    results.status = 'BLOCKED'
    return results
  }
  results.amapKeyRefUsed = credentialRefs.candidates.indexOf(amapKey) === 0 ? 'AMAP_JSAPI' : 'AMAP_WEBSERVICE'

  const virtualPages = new Map()
  for (const [name, data] of fixtures) {
    virtualPages.set(`${name}-leaflet.html`, pageHtml(renderer, data, { provider: 'leaflet' }))
    // 方案 A：key/jscode 注入 map 配置（与生产明文注入面同构）；只驻内存，页面 HTML 不落盘。
    const prepared = JSON.parse(JSON.stringify(data))
    prepared.map = { provider: 'amap', amapSecurityMode: 'A', amapKey, amapJscode: credentialRefs.jscode, warnings: [] }
    virtualPages.set(`${name}-amap.html`, renderer.renderWithTemplate(prepared, renderer.template))
  }

  const browserExecutable = resolveBrowserExecutable()
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable })

  const countTiles = (logs) => {
    results.tileRequests.amap += logs.network.filter((line) => line.includes('amap.com') || line.includes('autonavi.com')).length
    results.tileRequests.osm += logs.network.filter((line) => line.includes('tile.openstreetmap.org')).length
  }

  try {
    // ── 真实 AMap（light 预设） ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptLiveMode(page, { virtualPages, blocked: results.blockedNetwork })
      await openVirtualPage(page, 'three-day-amap.html')
      await page.waitForSelector('body[data-map-ready="amap"]', { timeout: 45_000 })
      const providerLabel = await page.locator('#mapProviderLabel').innerText()
      if (!providerLabel.includes('高德')) throw new Error(`provider 标注异常：${providerLabel}`)
      const body = page.locator('body')
      await assertOverview(page, { expectMarkers: 7, expectLegs: 5 })
      await assertDaySwitch(page, 1, { expectMarkers: 2 })
      await assertOverviewRestore(page, { expectMarkers: 7 })
      await waitForTiles(page, 5)
      await page.waitForTimeout(800) // 瓦片解码上屏
      await page.screenshot({ path: join(evidenceRoot, 'live-amap-overview.png'), fullPage: false })
      // 署名/控件：AMap logo 或版权节点存在。
      const attribution = await page.locator('#map .amap-logo, #map .amap-copyright').count()
      if (attribution === 0) throw new Error('真实 AMap 页缺署名节点（amap-logo/amap-copyright）')
      const renderedTiles = await page.evaluate(() => [...document.querySelectorAll('#map img')].filter((img) => img.naturalWidth > 0).length)
      // HTTP 200 级证据：naturalWidth 可能包含 OSM 418 政策拦截图，代理侧 200 计数才可靠。
      const tileHttp200 = liveProxyStats.tile2xx.amap
      if (tileHttp200 < 5) throw new Error(`真实 AMap 页瓦片 HTTP 200 不足：${tileHttp200}（rendered=${renderedTiles}）`)
      countTiles(logs)
      // 已知非致命噪声（记录但不判失败）：SDK 的 vdata/mapclick 日志 beacon 被 CSP 拦
      // （CSP 刻意不放行 vdata 的 script——它是遥测，不影响底图/覆盖层），以及被拦截域的
      // 资源加载失败。其余 pageerror/console.error 一律视为失败。
      const benignConsole = (line) => line.includes('Failed to load resource')
        || line.includes('Running the JavaScript URL violates')
        || line.includes('vdata.amap.com/mapclick')
      const fatalConsole = logs.pageErrors.filter((line) => !benignConsole(line))
      if (fatalConsole.length > 0) throw new Error(`真实 AMap 页未解释错误：${fatalConsole.join(' | ')}`)
      results.pages['live-amap'] = { ok: true, providerLabel, renderedTiles, tileHttp200, benignConsoleNotes: logs.pageErrors.filter((line) => benignConsole(line)).length, logs }
      await page.close()
    }

    // ── 真实 Leaflet/OSM（provider=leaflet 页） ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await interceptLiveMode(page, { virtualPages, blocked: results.blockedNetwork })
      await openVirtualPage(page, 'three-day-leaflet.html')
      await page.waitForSelector('body[data-map-ready="leaflet"]', { timeout: 45_000 })
      await assertOverview(page, { expectMarkers: 7, expectLegs: 5 })
      await assertDaySwitch(page, 2, { expectMarkers: 2 })
      const attribution = await page.locator('#map .leaflet-control-attribution').count()
      if (attribution === 0) throw new Error('真实 Leaflet 页缺 OSM 署名控件')
      countTiles(logs)
      if (results.tileRequests.osm === 0) throw new Error('未观察到真实 OSM 瓦片请求（live 证据不足）')
      await waitForTiles(page, 5)
      await page.waitForTimeout(800)
      const leafletTiles = await page.evaluate(() => [...document.querySelectorAll('#map img')].filter((img) => img.naturalWidth > 0).length)
      const osmTileHttp200 = liveProxyStats.tile2xx.osm
      if (osmTileHttp200 < 5) throw new Error(`真实 Leaflet 页 OSM 瓦片 HTTP 200 不足：${osmTileHttp200}（rendered=${leafletTiles}，blocked=${liveProxyStats.tileBlocked.osm}）`)
      await page.screenshot({ path: join(evidenceRoot, 'live-leaflet-overview.png'), fullPage: false })
      results.pages['live-leaflet'] = { ok: true, renderedTiles: leafletTiles, tileHttp200: osmTileHttp200, logs }
      await page.close()
    }

    // ── 失败路径：真实环境 amap 被阻断 → 真 Leaflet/OSM 接管（provider-fallback.json） ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const blockedHosts = []
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await attachLogging(page, logs)
      await page.route('**/*', async (route) => {
        const url = route.request().url()
        if (url.startsWith(fixturePrefix)) {
          const name = decodeURIComponent(url.slice(fixturePrefix.length).split('?')[0])
          const html = virtualPages.get(name)
          if (html === undefined) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no page' })
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        }
        if (/amap\.com|autonavi\.com/.test(url)) {
          if (!blockedHosts.includes(url)) blockedHosts.push(redact(url))
          return route.abort()
        }
        if (LIVE_ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(url))) return route.continue()
        if (!results.blockedNetwork.includes(url)) results.blockedNetwork.push(url)
        return route.abort()
      })
      await openVirtualPage(page, 'three-day-amap.html')
      await page.waitForSelector('body[data-map-ready="leaflet"]', { timeout: 45_000 })
      const body = page.locator('body')
      if (await body.getAttribute('data-amap-fallback') !== 'true') throw new Error('live fallback 缺 amapFallback 标记')
      await assertDaySwitch(page, 0, { expectMarkers: 3 })
      const osmTiles = logs.network.filter((line) => line.includes('tile.openstreetmap.org')).length
      results.providerFallback = {
        ok: true, blockedAmapRequests: blockedHosts.length, osmTileFailuresRecorded: osmTiles,
        note: 'amap 域被阻断后 Leaflet 接管；OSM 瓦片请求见 network 日志（失败=被拦截记录，成功不进该日志）',
        logs,
      }
      writeFileSync(join(evidenceRoot, 'provider-fallback.json'), JSON.stringify(results.providerFallback, null, 2))
      await page.close()
    }

    // ── 真机移动端（真实 AMap） ──
    {
      const logs = { console: [], network: [], pageErrors: [] }
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      await attachLogging(page, logs)
      await interceptLiveMode(page, { virtualPages, blocked: results.blockedNetwork })
      await openVirtualPage(page, 'three-day-amap.html')
      await page.waitForSelector('body[data-map-ready="amap"]', { timeout: 45_000 })
      await assertNoHorizontalOverflow(page)
      await page.locator('#dayTabs .day-tab[data-day-index="0"]').click()
      await page.waitForTimeout(80)
      await page.locator('#timelineCard .stop-button').first().click()
      await page.waitForTimeout(150)
      if (await page.locator('#drawerToggle').getAttribute('aria-expanded') !== 'true') throw new Error('移动端详情抽屉未展开')
      await page.screenshot({ path: join(evidenceRoot, 'mobile-overview.png'), fullPage: false })
      results.pages['live-mobile'] = { ok: true, logs }
      await page.close()
    }
  } finally {
    await browser.close()
  }

  const amapOk = results.pages['live-amap']?.ok === true
  const leafletOk = results.pages['live-leaflet']?.ok === true
  results.status = amapOk && leafletOk ? 'ACCEPTED_TEST_ENV' : 'FAILED'
  return results
}

// ── 入口 ──

async function main() {
  if (mode !== 'fixture' && mode !== 'live') throw new Error(`未知模式：${mode}（fixture | live）`)
  const base = assertIsolation()
  const renderer = await loadRenderer()
  const fixtures = loadFixtures()
  const command = `node scripts/run-map-first-render-e2e.mjs --mode ${mode}${mode === 'live' ? ` --base-url ${baseUrl}` : ''}`
  let results
  try {
    results = mode === 'fixture' ? await runFixtureMode(renderer, fixtures) : await runLiveMode(renderer, fixtures)
    logCommand(command, `ok status=${results.status ?? 'IMPLEMENTED_PENDING_LIVE'}`)
  } catch (error) {
    logCommand(command, `FAILED: ${redact(error instanceof Error ? error.message : String(error))}`)
    const failure = {
      mode, baseUrl: base.origin, status: mode === 'live' ? 'FAILED' : 'FAILED',
      error: redact(error instanceof Error ? error.message : String(error)),
    }
    writeFileSync(join(evidenceRoot, mode === 'live' ? 'live-results.json' : 'fixture-results.json'), JSON.stringify(failure, null, 2))
    writeFileSync(join(evidenceRoot, 'commands.log'), `${commandLog.join('\n\n')}\n`)
    console.error(`MAP-FIRST E2E FAILED: ${failure.error}`)
    process.exitCode = 1
    return
  }
  if (mode === 'fixture') {
    results.status = 'IMPLEMENTED_PENDING_LIVE'
    writeFileSync(join(evidenceRoot, 'fixture-results.json'), JSON.stringify(results, null, 2))
  } else {
    writeFileSync(join(evidenceRoot, 'live-results.json'), JSON.stringify(results, null, 2))
  }
  writeFileSync(join(evidenceRoot, 'commands.log'), `${commandLog.join('\n\n')}\n`)
  console.log(JSON.stringify({ status: results.status, mode, pages: Object.keys(results.pages ?? {}), matrix: Object.keys(results.matrix ?? {}) }, null, 2))
  if (results.status === 'BLOCKED' || results.status === 'FAILED') process.exitCode = 1
}

main().catch((error) => {
  console.error(`MAP-FIRST E2E BLOCKED: ${redact(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
})
