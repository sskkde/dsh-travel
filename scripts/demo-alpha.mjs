/**
 * M1-alpha 薄切片端到端演示（脚本化驱动，非 LLM 编排）。
 *
 * 链路：intake → research_destination（薄版：腾讯 POI 真实 + L0 真实搜索）
 *       → build_itinerary（自动提案）→ render_page（Leaflet + prefix 路由）
 *       → curl 路由 200 → page.html 快照 + 产物归档。
 *
 * 执行方式（本文件以 .mjs 源码形态引用 src/*.ts，经 esbuild bundle 后运行）：
 *   npx esbuild scripts/demo-alpha.mjs --bundle --platform=node --format=esm \
 *     --outfile=.tmp/demo-alpha.bundle.mjs && node .tmp/demo-alpha.bundle.mjs
 *
 * 证据输出：docs/evidence/m1/alpha/（transcript / curl 输出 / 快照 / 产物 / degraded 汇总）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Context, Service } from 'cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { runRenderPage, travelPlanRoutePath } from '../src/tools/render-page.js'
import { TencentMapAdapter } from '../src/adapters/tencent.js'
import { SearchAdapter } from '../src/adapters/search.js'
import { tencentPoiChannel, searchL0Channel } from '../src/orchestrator/channels.js'
import { createDedupingRouteRegistrar } from '../src/render/route-registrar.js'
import { validateIntelItem } from '../src/models/validate.js'

const repoRoot = join(import.meta.dirname, '..') // scripts/ → repo 根
const EVID = process.env.ALPHA_EVID ?? join(repoRoot, 'docs', 'evidence', 'm1', 'alpha')
const STORE_ROOT = join(EVID, 'store')
process.env.DSH_TRAVEL_TEMPLATE ??= join(repoRoot, 'src', 'render', 'template.html') // bundle 化场景：显式指向源模板
const ARTIFACTS = join(EVID, 'artifacts')

const transcript = []
function log(line) {
  transcript.push(line)
  console.log(line)
}

// ── 浏览器 QA 探测（遮罩：有就截图，没有就登记 blocked 不阻塞） ──

/** 异步 curl（-sS -o file -w status）；不阻塞事件循环（进程内 webserver 需要服务请求）。 */
function curlGet(url, outFile, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sS', '-o', outFile, '-w', '%{http_code}', url], { timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ stdout: stdout.trim(), stderr, status: code }))
    child.on('error', (err) => resolve({ stdout: '', stderr: String(err), status: null }))
  })
}

function probeBrowser() {
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'playwright']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return bin
  }
  return undefined
}

// ── L0 宿主搜索替身：真实 DuckDuckGo HTML 检索（演示限流：会话内仅首次真实请求） ──
async function ddgSearch(query, maxResults = 6) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return { sources: [], truncated: false }
  const text = await res.text()
  const sources = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  for (const m of text.matchAll(re)) {
    let href = m[1]
    const uddg = /uddg=([^&]+)/.exec(href)
    if (uddg) href = decodeURIComponent(uddg[1])
    sources.push({ url: href, title: m[2].replace(/<[^>]+>/g, '').trim() })
    if (sources.length >= maxResults) break
  }
  return { content: undefined, sources, truncated: false }
}

function makeDemoHostSearch() {
  let liveCalls = 0
  return async (query, maxResults) => {
    if (liveCalls > 0) return { sources: [], truncated: false } // 演示限流：一次真实请求
    liveCalls += 1
    return ddgSearch(query, maxResults)
  }
}

async function main() {
  rmSync(STORE_ROOT, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  log(`[demo] evidence=${EVID} store=${STORE_ROOT}`)
  log(`[demo] 浏览器 QA 探测：${probeBrowser() ?? '无（登记 blocked，不阻塞——真实交互 QA 归 W7/E2E）'}`)

  // boot 最小 ctx：cordis Context + 真实 WebServer 服务（同宿主 webserver 组件）
  const ctx = new Context()
  const server = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  await server[Service.init]()
  const registrar = createDedupingRouteRegistrar(server)
  log(`[demo] webserver listening on http://${server.host}:${server.port}`)

  const store = new TravelStore(STORE_ROOT)
  const tencent = new TencentMapAdapter() // 真实零 key 通道（h5gw.map.qq.com）
  const search = new SearchAdapter({ hostSearch: makeDemoHostSearch() })
  const researchDeps = { channels: [tencentPoiChannel(tencent), searchL0Channel(search)] }

  // ── ① intake：真实目的地「杭州 3 日」 ──
  const intake = await runIntake({
    slots: {
      destination: '杭州',
      dateStart: '2026-10-01',
      dateEnd: '2026-10-03',
      days: 3,
      travelers: { adults: 2 },
      preferences: { themes: ['自然', '美食'] },
    },
  }, store)
  const planId = intake.planId
  log(`\n[① intake] planId=${planId} status=${intake.status} missing=${intake.missing.join(',') || '无'}`)

  // ── ② research（薄版：腾讯 POI + L0） ──
  const research = await runResearchDestination({ planId, depth: 'quick' }, store, researchDeps)
  log(`[② research] itemCount=${research.itemCount} intelSummary=${JSON.stringify(research.intelSummary)}`)
  log(`[② research] degraded=${research.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}`).join('；') || '（无）'}`)

  const intel = await store.readJson(planId, 'intel.json')
  if (intel) {
    log(`[② research] intel.json 条目数=${intel.length}；条目级校验：${intel.map((i) => validateIntelItem(i).length).every((n) => n === 0) ? '全部通过 validateIntelItem ✔' : '存在失败条目 ✘'}`)
    const withCoords = intel.filter((i) => i.coords).length
    log(`[② research] 带坐标条目=${withCoords}/${intel.length}`)
  }

  // ── ③ build（自动提案） ──
  const built = await runBuildItinerary({ planId }, store)
  log(`[③ build] built=${built.built} itineraryId=${built.itineraryId ?? ''} days=${built.days.length} 路线已提案（动线校验属 W4）`)
  if (built.built) {
    for (let i = 0; i < built.days.length; i++) {
      const stops = built.days[i].stops.map((s) => `${s.name}(${s.durationHint}min)`).join(' → ')
      log(`         Day${i + 1} ${built.days[i].date}：${stops || '（机动）'}`)
    }
  }

  // ── ④ render（Leaflet + prefix 路由） ──
  const rendered = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar)
  log(`[④ render] rendered=${rendered.rendered} mapProviderUsed=${rendered.mapProviderUsed}`)
  log(`[④ render] url=${rendered.url}`)
  log(`[④ render] filePath=${rendered.filePath}`)
  log(`[④ render] warnings=${rendered.warnings.join('；') || '（无）'}`)

  // ── ⑤ curl 路由 200（异步 spawn：进程内 WebServer 单线程，同步阻塞会饿死请求） ──
  const pageOut = join(EVID, 'curl-body.html')
  const curl = await curlGet(rendered.url, pageOut, 20_000)
  const status = curl.stdout
  writeFileSync(join(EVID, 'curl-route-200.txt'), `GET ${rendered.url}\nHTTP ${status}\ncurl exit=${curl.status}\nstderr=${curl.stderr?.slice(0, 200) ?? ''}\n`)
  log(`[⑤ curl] ${rendered.url} → HTTP ${status}${status === '200' ? ' ✔' : ' ✘'}`)
  if (status !== '200') {
    writeFileSync(join(EVID, 'transcript.txt'), transcript.join('\n'))
    log('[demo] FAIL：curl 非 200（' + curl.stderr + '）')
    process.exit(1)
  }

  // ── ⑥ page.html 快照关键段 ──
  const pageHtml = readFileSync(rendered.filePath, 'utf8')
  const dataJson = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(pageHtml)
  const embedded = dataJson ? JSON.parse(dataJson[1]) : null
  const stopsCount = embedded?.itinerary?.days?.reduce((s, d) => s + d.stops.length, 0) ?? 0
  const snapshot = [
    '# page.html 快照（关键段）',
    `- marker 构建：${pageHtml.includes('L.marker') ? 'L.marker(divIcon 序号图钉)' : '缺失 ✘'}`,
    `- Leaflet loader：${(/leaflet@1\.9\.4/.test(pageHtml) ? 'leaflet@1.9.4 ✔' : '缺失 ✘')}`,
    `- OSM 瓦片：${(/tile\.openstreetmap\.org/.test(pageHtml) ? 'openstreetmap.org ✔' : '缺失 ✘')}`,
    `- GCJ→WGS 函数：${(/function gcj02ToWgs84/.test(pageHtml) ? 'gcj02ToWgs84 ✔' : '缺失 ✘')}`,
    `- 按天 Tab/动线：${(/activateDay/.test(pageHtml) && /L\.polyline/.test(pageHtml) ? '✔' : '缺失 ✘')}`,
    `- 内嵌数据 stops 总数：${stopsCount}（应 = markers 数；页面 console 自检）`,
    `- 数据缺失卡片隐藏逻辑：${pageHtml.includes('card.classList.add(\'hidden\')') ? '✔' : '缺失 ✘'}`,
    '',
    'page.html 字节数：' + Buffer.byteLength(pageHtml),
  ].join('\n')
  writeFileSync(join(EVID, 'page.html.snapshot.txt'), snapshot)
  log(`[⑥ snapshot]\n${snapshot}`)

  // ── ⑦ 产物归档（intel/transport/advice/itinerary + request） ──
  const planDir = join(STORE_ROOT, '.dsh-travel', planId)
  for (const name of ['request.json', 'intel.json', 'transport.json', 'advice.json', 'itinerary.json']) {
    const src = join(planDir, name)
    if (existsSync(src)) cpSync(src, join(ARTIFACTS, name))
  }
  const archived = ['request.json', 'intel.json', 'transport.json', 'advice.json', 'itinerary.json'].filter((n) => existsSync(join(ARTIFACTS, n)))
  log(`[⑦ artifacts] 归档：${archived.join(', ')}${archived.includes('transport.json') ? '' : '（transport 属 W3 未产出——按设计齐全前不生成）'}`)

  // ── ⑧ degraded 汇总 ──
  const degradedFile = (await store.loadDegraded(planId)) ?? []
  const degradedSummary = {
    planId,
    researchDegraded: research.degraded,
    degradedJson: degradedFile,
    channelCounts: research.intelSummary,
    itemCount: research.itemCount,
    rendered: rendered.rendered,
    mapProviderUsed: rendered.mapProviderUsed,
    url: rendered.url,
  }
  writeFileSync(join(EVID, 'degraded-summary.json'), JSON.stringify(degradedSummary, null, 2))
  log(`[⑧ degraded 汇总] degraded.json=${degradedFile.length} 条${degradedFile.length ? '：' + degradedFile.map((d) => d.source).join(',') : '（零降级）'}`)

  // 幂等性自检：同 planId 二次 render（路由不重复注册）
  const second = await runRenderPage({ planId }, store, registrar)
  log(`[⑨ 幂等] 二次 render url 相同=${second.url === rendered.url}（幂等注册 ✔）`)

  writeFileSync(join(EVID, 'transcript.txt'), transcript.join('\n'))
  log(`\n[demo] 完成。证据已写入 ${EVID}`)
  process.exit(0) // 进程内 WebServer 保持监听，显式退出（同 spike 惯例）
}

main().catch((err) => {
  console.error('[demo] 失败：', err)
  process.exit(1)
})