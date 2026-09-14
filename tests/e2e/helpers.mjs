/**
 * M1 W7（T10）收口验收公共助手（tests/e2e/）。
 *
 * 剧本 A~E 共用的构建块：
 * - 真实适配器装配（对照 src/index.ts apply() 的接线，env 可注入）
 * - 零 key / 断 key（KeyResolutionEnv 层抑制）/ 渠道关闭 / 真实凭据 env 工厂
 * - L0 宿主搜索真实后端：cn.bing.com（零 key，中文结果；节流 600ms）
 * - headless Chrome dump-dom / 截图（同 W5 browser-qa 方法）
 * - 来源链接计数 / 嵌入数据提取 / 凭据脱敏 / degraded 断言
 *
 * 纪律：*任何归档产物零 key 明文*（页面/DOM 副本经 redactSecrets）；
 * 凭据只按 ref 名处理，绝不打印值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Context, Service } from 'cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { TravelStore } from '../../src/store/store.js'
import { makeKeyEnv } from '../../src/adapters/env.js'
import { TencentMapAdapter } from '../../src/adapters/tencent.js'
import { SearchAdapter } from '../../src/adapters/search.js'
import { SocialAdapter } from '../../src/adapters/social.js'
import { AmapAdapter } from '../../src/adapters/amap.js'
import { Rail12306Adapter } from '../../src/adapters/rail12306.js'
import { WendaoAdapter } from '../../src/adapters/wendao.js'
import { IntercityAdapter } from '../../src/adapters/intercity.js'
import { OpenMeteoAdapter } from '../../src/adapters/open-meteo.js'
import { PlaywrightSocialAdapter } from '../../src/adapters/social-playwright.js'
import { DidiAdapter } from '../../src/adapters/didi.js'
import { buildDestinationChannels } from '../../src/orchestrator/channels.js'
import { createDedupingRouteRegistrar } from '../../src/render/route-registrar.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'
import { runResearchAdvice } from '../../src/tools/research-advice.js'
import { runBuildItinerary } from '../../src/tools/build-itinerary.js'
import { runRenderPage } from '../../src/tools/render-page.js'
import { runUpdate } from '../../src/tools/update.js'
import { readCredentialsRefs } from '../../tests/live-credentials.js'

// ── 路径 ──

const __dir = import.meta.dirname
/** bundle（.tmp/）或源树（tests/e2e/）两种运行形态的仓库根。 */
export const repoRoot = __dir.endsWith('tests/e2e') ? join(__dir, '..', '..') : join(__dir, '..')
// W9 收口：TRAVEL_EVID_MILESTONE=m2 → docs/evidence/m2/final/；M3 起支持 m3（缺省 m1 兼容）
const EVID_MILESTONE = process.env['TRAVEL_EVID_MILESTONE']
export const EVID = join(repoRoot, 'docs', 'evidence',
  EVID_MILESTONE === 'm2' || EVID_MILESTONE === 'm3' ? EVID_MILESTONE : 'm1', 'final')

// bundle 化运行：render.ts 的模板邻接 import.meta.url 会指向 .tmp/ → 显式指向源模板
// （W5 demo-w5.mjs 同款约定；runResearchDestination 等工具热读此 env）
process.env.DSH_TRAVEL_TEMPLATE ??= join(repoRoot, 'src', 'render', 'template.html')

// ── 转录日志 ──

export function makeTranscript() {
  const lines = []
  return {
    lines,
    log(line = '') {
      lines.push(line)
      console.log(line)
    },
    write(file) {
      writeFileSync(file, lines.join('\n') + '\n')
    },
  }
}

// ── 断言收集（PASS/FAIL 逐条留证） ──

export function makeChecklist() {
  const entries = []
  return {
    entries,
    check(ok, label, detail = '') {
      entries.push({ ok: Boolean(ok), label, detail })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    },
    write(file) {
      const lines = entries.map((e) => `${e.ok ? 'PASS' : 'FAIL'}|${e.label}|${e.detail}`)
      writeFileSync(file, lines.join('\n') + '\n')
    },
    allPass() {
      return entries.every((e) => e.ok)
    },
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 真实适配器装配（对照 index.ts；env 注入，缺省零 key） ──

export function buildRealAdapters(env) {
  const search = new SearchAdapter({ hostSearch: realBingHostSearch() })
  const social = new SocialAdapter({ search: realSocialSearch() })
  const wendao = new WendaoAdapter()
  // W3a/W5：Playwright 社媒（L1/L2）与滴滴（前置地理编码链对照 index.ts）
  const amap = new AmapAdapter()
  const tencent = new TencentMapAdapter()
  const didi = new DidiAdapter({
    geocoders: [
      { name: 'amap', geocode: (address, city, e) => amap.geocode(address, city, e) },
      {
        name: 'tencent-map',
        geocode: async (address, city) => {
          const result = await tencent.poiSearch({ keywords: address, region: city ?? undefined, pageSize: 1 })
          return { coords: result.data[0]?.coords, degraded: [] }
        },
      },
    ],
  })
  return {
    tencent,
    search,
    social,
    amap,
    rail: new Rail12306Adapter(),
    wendao,
    intercity: new IntercityAdapter({ wendao }),
    openMeteo: new OpenMeteoAdapter(),
    playwright: new PlaywrightSocialAdapter(),
    didi,
    env,
  }
}

/** research_destination 依赖（对照 index.ts：buildDestinationChannels）。 */
export function destinationDeps(adapters) {
  return {
    channels: buildDestinationChannels({ search: adapters.search, social: adapters.social, tencent: adapters.tencent, xhs: adapters.xhs, playwright: adapters.playwright }),
    env: adapters.env,
  }
}

/** research_transport 依赖（对照 index.ts）。 */
export function transportDeps(adapters) {
  return {
    rail: adapters.rail,
    intercity: adapters.intercity,
    amap: adapters.amap,
    wendao: adapters.wendao,
    didi: adapters.didi,
    env: adapters.env,
  }
}

/** research_advice 依赖（对照 index.ts）。 */
export function adviceDeps(adapters) {
  return {
    amap: adapters.amap,
    tencent: adapters.tencent,
    openMeteo: adapters.openMeteo,
    search: adapters.search,
    env: adapters.env,
  }
}

// ── env 工厂（ADR-12：settings → credentials → env；全部热读取） ──

export function channelsAllOn() {
  return {
    fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, tencentPoi: true, platformIntel: true, socialL1: true },
    fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
    fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
    fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
    fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
  }
}

export function sampleSettings(keys = {}) {
  return {
    channels: channelsAllOn(),
    keys,
    advanced: {
      socialDepth: 'L1', researchTimeoutMs: 180000, rateLimitPerDomain: 10,
      routePrefix: '/travel-plans', defaultMapProvider: 'auto',
      amapPoiBudgetPerPlan: 40, amapRestBudgetPerPlan: 60, profileTtlDays: 7,
    },
  }
}

const noCtx = { get: () => undefined }
const voidCredentials = { resolve: async () => undefined, readRecord: async () => undefined }

/** 零 key 口径（剧本 A/D）：settings keys 空 + credentials 空解析 + env 无 key。 */
export function zeroKeyEnv() {
  return makeKeyEnv(noCtx, { settings: sampleSettings(), credentials: voidCredentials, env: {} })
}

/** 断 key 等价演练 env（KeyResolutionEnv 层抑制 = 模拟删除四 refs 后的解析链）。 */
export function suppressedKeyEnv() {
  return makeKeyEnv(noCtx, { settings: sampleSettings(), credentials: voidCredentials, env: {} })
}

/** 渠道关闭 env：env 层 TRAVEL_CHANNEL_<NAME>=off（naming 同 base.channelEnabled）。 */
export function channelOffEnv(offNames) {
  const env = {}
  for (const name of offNames) env[`TRAVEL_CHANNEL_${name.toUpperCase()}`] = 'off'
  return makeKeyEnv(noCtx, { settings: sampleSettings(), credentials: voidCredentials, env })
}

/** 真实凭据 env（settings keys 空 → 链落 credentials 层真实 refs；仅供 available() 断言）。
 * 注意：env.ts resolveCredential 对 `<scope>/<id>` 记录空间走 readRecord（isCredentialRefName
 * 只认 env 风格大写名），故 stub 必须实现 readRecord 返回 ApiKeyRecord。 */
export async function liveKeyEnv() {
  const refs = readCredentialsRefs()
  return makeKeyEnv(noCtx, {
    settings: sampleSettings(),
    credentials: {
      resolve: async (r) => (refs[r] ? { value: refs[r] } : undefined),
      readRecord: async (key) => {
        const v = refs[key]
        return v ? { kind: 'api-key', key: v } : undefined
      },
    },
    env: {},
  })
}

// ── 存储 / WebServer / 路由 ──

export function freshStore(subdir) {
  const root = join(EVID, 'store', subdir)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(EVID, 'store'), { recursive: true })
  return new TravelStore(root)
}

export async function bootWebServer() {
  const ctx = new Context()
  const server = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  await server[Service.init]()
  const registrar = createDedupingRouteRegistrar(server)
  return { ctx, server, registrar, base: `http://${server.host}:${server.port}` }
}

// ── L0 真实搜索后端（cn.bing.com，零 key） ──

const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BLOCKED_HOSTS = new Set(['cn.bing.com', 'www.bing.com', 'global.bing.com', 'microsoft.com', 'www.microsoft.com', 'go.microsoft.com', 'support.microsoft.com', 'schema.org', 'www.msn.com', 'msn.com', 'www.w3.org'])
let lastBingAt = 0

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, (m) => String.fromCharCode(Number(m.slice(2, -1))))
}

function parseBingResults(html) {
  const out = []
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []
  for (const block of blocks) {
    const hrefM = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!hrefM) continue
    let href = decodeEntities(hrefM[1])
    if (!/^https?:\/\//.test(href)) continue
    let host = ''
    try { host = new URL(href).hostname.replace(/^www\./, '') } catch { continue }
    if ([...BLOCKED_HOSTS].some((h) => host === h || host.endsWith('.' + h))) continue
    if (/\/ck\/a\?/.test(href)) continue
    const title = decodeEntities(hrefM[2].replace(/<[^>]+>/g, '')).trim()
    const snipM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = snipM ? decodeEntities(snipM[1].replace(/<[^>]+>/g, '')).trim() : ''
    if (title) out.push({ title, url: href, snippet })
  }
  return out
}

/** 真实 L0 宿主搜索：cn.bing（节流 600ms；失败抛错 → 上游 degraded 记账，不伪造）。 */
export function realBingHostSearch() {
  return async (query, maxResults) => {
    const gap = 600 - (Date.now() - lastBingAt)
    if (gap > 0) await sleep(gap)
    lastBingAt = Date.now()
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-hans`
    const res = await fetch(url, {
      headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`bing http ${res.status}`)
    const html = await res.text()
    const hits = parseBingResults(html).slice(0, maxResults)
    if (hits.length > 0) return { content: undefined, sources: hits, truncated: false }
    // W9 实测（2026-09-05）：cn.bing 对连续批量查询软限流（HTTP 200 + 0 结果块）。
    // 兜底链：www.bing.com（国际版同解析器，实测未被同限流）→ DDG html lite
    // （live-w4 T3 同款；本轮实测 UND_ERR_CONNECT_TIMEOUT IP 级阻断，失败不阻塞）。
    const intl = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-hans`, {
      headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    }).catch(() => undefined)
    if (intl !== undefined && intl.ok) {
      const intlHits = parseBingResults(await intl.text()).slice(0, maxResults)
      if (intlHits.length > 0) return { content: undefined, sources: intlHits, truncated: false }
    }
    const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': BING_UA }, redirect: 'follow', signal: AbortSignal.timeout(15000),
    }).catch(() => undefined)
    if (ddgRes === undefined || !ddgRes.ok) return { content: undefined, sources: hits, truncated: false }
    const ddgHtml = await ddgRes.text()
    const sources = []
    const snippets = []
    for (const m of ddgHtml.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) snippets.push(m[1].replace(/<[^>]+>/g, '').trim())
    let i = 0
    for (const m of ddgHtml.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      let url = m[1]
      const uddg = /[?&]uddg=([^&]+)/.exec(url)
      if (uddg) url = decodeURIComponent(uddg[1])
      sources.push({ url, title: m[2].replace(/<[^>]+>/g, '').trim(), snippet: snippets[i] })
      i += 1
      if (sources.length >= maxResults) break
    }
    return { content: undefined, sources, truncated: false }
  }
}

/** SocialAdapter 搜索位：同一 Bing 后端 → {title,url,snippet}[]。 */
export function realSocialSearch() {
  const hostSearch = realBingHostSearch()
  return async (query) => {
    const result = await hostSearch(query, 6)
    return result.sources
  }
}

// ── headless Chrome（同 W5 方法） ──

function chromeArgs(extra = []) {
  return ['--headless=new', '--disable-dev-shm-usage', '--no-sandbox', '--virtual-time-budget=15000', '--hide-scrollbars', ...extra]
}

/** dump-dom（重试 3 次；可脱敏；可抓 console 错误）。 */
export function chromeDumpDom(url, redact = (x) => x, wantConsole = false) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const flags = [...chromeArgs(), '--dump-dom', url]
    if (wantConsole) flags.push('--enable-logging=stderr', '--log-level=0')
    const r = spawnSync('google-chrome', flags, { encoding: 'utf8', timeout: 60_000 })
    const out = r.stdout || ''
    if (r.status === 0 && out.trim().length > 0 && out.includes('<html')) {
      return { ok: true, dom: redact(out), attempts: attempt, stderr: r.stderr || '' }
    }
    const err = (r.stderr || '').slice(0, 300)
    if (attempt < 3) spawnSync('sleep', ['2'])
    if (attempt === 3) return { ok: false, stderr: err + ' | dump-dom 空输出（重试3次后）', dom: '', stderrRaw: r.stderr || '' }
  }
  return { ok: false, stderr: 'chrome 不可用', dom: '' }
}

export function chromeScreenshot(url, outFile) {
  const r = spawnSync('google-chrome', [...chromeArgs(), '--window-size=1400,2400', `--screenshot=${outFile}`, url], { encoding: 'utf8', timeout: 60_000 })
  return { ok: r.status === 0 && existsSync(outFile), stderr: (r.stderr || '').slice(0, 300) }
}

export async function curlGet(url, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', url], { timeout: timeoutMs })
    let stdout = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.on('close', () => resolve({ code: stdout.trim(), ok: stdout.trim() === '200' }))
    child.on('error', () => resolve({ code: 'ERR', ok: false }))
  })
}

// ── 凭据零明文（页面/DOM 副本脱敏） ──

export function redactSecrets(text) {
  const refs = readCredentialsRefs()
  let out = text
  for (const ref of ['AMAP_JSAPI', 'AMAP_JSCODE', 'AMAP_WEBSERVICE', 'WENDAO_APIKEY']) {
    const value = refs[ref]
    if (value && value.length > 0) out = out.split(value).join('***REDACTED***')
  }
  return out
}

// ── 行程页数据与链接断言 ──

export function embeddedData(html) {
  const m = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('travel-data 数据块缺失')
  return JSON.parse(m[1])
}

/** 期望来源链接数（模板渲染规则镜像：stops+情报卡+transport+attribution）。 */
export function expectedSourceLinks(data) {
  const intel = data.intel || {}
  let stops = 0
  for (const day of data.itinerary?.days ?? []) {
    for (const s of day.stops) {
      const ref = s.intelRefs && s.intelRefs[0] ? intel[s.intelRefs[0]] : null
      if (ref && ref.source && ref.source.url) stops += 1
    }
  }
  const cards = Object.values(intel).filter((i) => i && ['food', 'lodging', 'warning'].includes(i.category) && i.source && i.source.url).length
  const transport = (data.transport || []).filter((o) => o.source && o.source.url).length
  const attribution = 2
  return { stops, cards, transport, total: stops + cards + transport + attribution }
}

/** DOM 真实锚点计数（剥离 script 文本防字面量污染）。 */
export function countLinks(dom) {
  const withoutScripts = dom.replace(/<script[\s\S]*?<\/script>/g, '')
  const m = withoutScripts.match(/<a\s[^>]*href="http[^"]*"/g)
  return m ? m.length : 0
}

// ── 产物复制到证据区 ──

export function copyArtifact(store, planId, name, destDir, destName = name) {
  const src = join(store.root, '.dsh-travel', planId, name)
  if (existsSync(src)) cpSync(src, join(destDir, destName))
  return existsSync(src)
}

// ── degraded 汇总 ──

export function degradedBySource(degraded) {
  const map = {}
  for (const d of degraded ?? []) {
    (map[d.source] ??= []).push(`${d.code}:${d.reason}`)
  }
  return map
}

export function assertDegradedContains(degraded, source, reasonKeyword, checklist, label) {
  const entry = (degraded ?? []).find((d) => d.source === source && d.reason.includes(reasonKeyword))
  checklist.check(entry !== undefined, label, entry ? `found: ${entry.reason.slice(0, 90)}` : `NOT found in ${JSON.stringify(degradedBySource(degraded))}`)
}

export function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}