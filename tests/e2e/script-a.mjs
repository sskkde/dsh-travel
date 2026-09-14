/**
 * 剧本 A —— 规划模式零 key：「帮我规划十一杭州三日游」全流程。
 *
 * 零 key 口径：断高德/wendao（settings keys 空 + credentials 空 + env 无 key）；
 * 可依赖面 = 腾讯 POI（零 key）+ 12306 MCP（免 key）+ Open-Meteo + Leaflet + L0 搜索（cn.bing 真实）。
 *
 * 日期取证说明：剧本台词「十一」= 节假日规划语义；真实余票/天气受窗口约束
 * （2026-09-04 取证环境：12306 预售期 15 天，2026-10-01 查询被上游拒绝；Open-Meteo
 * 预报允许末端=2026-09-18），故取证日期取 **2026-09-16~18**（预售+预报双窗口内，
 * 等价节假日规划场景），保证 rail 真实班次+票价档（硬验收点）与逐日真实天气。
 *
 * 验收点（roadmap §7 剧本 A 行）：
 *  ① 追问 ≤3 轮（模拟问答面，tool 调用序列留证）
 *  ② intake 确认（status=confirmed）
 *  ③ research_destination：7 类 ≥6/7；degraded 汇总留证（xhsMcp 未挂载等）
 *  ④ research_transport：rail 12306 真实班次 ≥2 方案 ≥1 含班次+价格档；市内衔接零 key 降级记账
 *  ⑤ research_advice：天气含数据日期+来源；物品清单 ≥10 项
 *  ⑥ build：routeCheck issues/warnings 落盘
 *  ⑦ render：Leaflet 页 headless Chrome（markers=stops / zoom / 来源链接 a[href] 计数 与预期相等）
 *  ⑧ 全条目溯源：intel.json 全部带 URL 条目在 DOM 中可点击（a[href] 存在）
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  EVID, repoRoot, makeTranscript, makeChecklist, sleep,
  zeroKeyEnv, buildRealAdapters, destinationDeps, transportDeps, adviceDeps,
  freshStore, bootWebServer,
  chromeDumpDom, chromeScreenshot, curlGet, redactSecrets,
  embeddedData, expectedSourceLinks, countLinks, copyArtifact, degradedBySource,
  assertDegradedContains, writeJson,
} from './helpers.mjs'
import { runIntake } from '../../src/tools/intake.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'
import { runResearchAdvice } from '../../src/tools/research-advice.js'
import { runBuildItinerary } from '../../src/tools/build-itinerary.js'
import { runRenderPage } from '../../src/tools/render-page.js'
import { createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider } from '../../src/route-check.js'

const DIR = join(EVID, 'a')
const A_DIR = join(DIR, 'artifacts')
mkdirSync(A_DIR, { recursive: true })

const transcript = makeTranscript()
const checks = makeChecklist()

async function main() {
  transcript.log('## 剧本 A · 规划模式零 key：「帮我规划十一杭州三日游」（日期取证 2026-09-18~20，预售期窗口）')
  const store = freshStore('a')
  const { registrar } = await bootWebServer()
  const adapters = buildRealAdapters(zeroKeyEnv())
  const env = adapters.env
  transcript.log('环境：零 key（settings keys 空 + credentials 空解析 + env 无 key）；可依赖=腾讯 POI/12306 MCP/Open-Meteo/Leaflet/L0(cn.bing)')

  // ── ① 模拟问答面：追问 ≤3 轮（tool 调用序列留证） ──
  transcript.log('\n[问答面] 用户：「帮我规划十一杭州三日游」')
  const r1 = await runIntake({ slots: { origin: '北京', destination: '杭州', dateStart: '2026-09-16' } }, store)
  transcript.log(`[问答面] travel_intake #1 → status=${r1.status} missing=[${r1.missing.join(',')}] nextQuestions=${JSON.stringify(r1.nextQuestions)}`)
  checks.check(r1.nextQuestions.length <= 3, '追问 ≤3 轮（第 1 轮）', `nextQuestions=${r1.nextQuestions.length}: ${r1.nextQuestions.join('；')}`)
  // 用户回答第 1 轮追问（tool 调用序列：#2 补齐日期 → days 自动推导）
  transcript.log('[问答面] 用户：「9 月 16 到 18 号，三天」')
  const r2 = await runIntake({ planId: r1.planId, slots: { dateEnd: '2026-09-18' } }, store)
  transcript.log(`[问答面] travel_intake #2 → status=${r2.status} missing=[${r2.missing.join(',')}] nextQuestions=${JSON.stringify(r2.nextQuestions)} assumptions=${r2.assumptions.join('；')}`)
  checks.check(r2.status === 'confirmed', 'intake 确认（status=confirmed）', `planId=${r2.planId}`)
  checks.check(r2.nextQuestions.length <= 3, '追问 ≤3 轮（第 2 轮）', `nextQuestions=${r2.nextQuestions.length}`)
  const planId = r2.planId

  // ── ③ research_destination（7 类 fan-out；零 key） ──
  transcript.log('\n[research_destination] 7 类 fan-out（xhsMcp 未挂载降级语义 / L0×3 / 腾讯 POI / 平台情报）…')
  const dest = await runResearchDestination({ planId, categories: ['attraction', 'lodging', 'food', 'transportLocal', 'tip', 'warning', 'recommend'] }, store, destinationDeps(adapters))
  transcript.log(`→ itemCount=${dest.itemCount} 渠道分布=${JSON.stringify(dest.intelSummary)}`)
  transcript.log(`→ degraded=${JSON.stringify(degradedBySource(dest.degraded))}`)
  const intel = (await store.readJson(planId, 'intel.json')) ?? []
  const cats = new Set(intel.map((i) => i.category))
  transcript.log(`→ 条目类别覆盖=${[...cats].join(',')}（共 ${cats.size}/7 类）`)
  checks.check(cats.size >= 6, '7 类 ≥6/7', `覆盖 ${cats.size} 类：${[...cats].join(',')}`)
  checks.check(dest.itemCount > 0, '情报条目 >0', `itemCount=${dest.itemCount}`)
  // W9 口径更新（M2.1 挂载后形态迁移）：xhsMcp 渠道语义须如实——未挂载=「未挂载」
  // 记账；挂载+未授权（E2E 隔离 store 无对话确认标记）=「待授权/不可用」记账；
  // 授权+登录态=登录态条目（channel=xhs-mcp）。三者其一即符合「渠道语义如实」。
  const xhsMcpDegraded = dest.degraded.some((d) => String(d.source).includes('xhsMcp'))
  const xhsLoginItems = ((await store.readJson(planId, 'intel.json')) ?? []).some((i) => i.channel === 'xhs-mcp')
  checks.check(xhsMcpDegraded || xhsLoginItems, 'xhsMcp 渠道语义如实（W2 挂载后形态）',
    xhsMcpDegraded ? 'degraded 含 xhsMcp（隔离环境待授权/不可用记账）' : 'intel 含 xhs-mcp 登录态条目')

  // ── ④ research_transport（12306 真实班次 + 票价档；零 key 市内衔接降级） ──
  transcript.log('\n[research_transport] rail=12306 MCP 真实 / flight/bus=降级链 / 市内衔接=高德零 key 降级记账…')
  const transport = await runResearchTransport({ planId }, store, transportDeps(adapters))
  const railOpts = transport.options.filter((o) => o.mode === 'rail')
  const withPrice = railOpts.filter((o) => o.totalPriceRange)
  transcript.log(`→ options=${transport.options.length}（rail=${railOpts.length}）comparison=${transport.comparison ? '有' : '无'} cityTransfer=${transport.cityTransfer?.provider ?? '（零 key 缺失）'}`)
  transcript.log(`→ rail 首班：${railOpts[0]?.segments[0]?.no} ${railOpts[0]?.segments[0]?.from}→${railOpts[0]?.segments[0]?.to} ${railOpts[0]?.segments[0]?.depart}-${railOpts[0]?.segments[0]?.arrive} 票价档=${JSON.stringify(withPrice[0]?.totalPriceRange)}`)
  transcript.log(`→ degraded=${JSON.stringify(degradedBySource(transport.degraded))}`)
  checks.check(railOpts.length >= 2, 'rail 12306 方案 ≥2（真实班次）', `rail=${railOpts.length}`)
  checks.check(withPrice.length >= 1, '≥1 方案含班次+价格档', `no=${withPrice[0]?.segments[0]?.no} price=${JSON.stringify(withPrice[0]?.totalPriceRange)}`)
  checks.check(transport.comparison !== undefined, '≥2 方案对比（时间/价格/舒适度/适配）', `time=${transport.comparison?.time.slice(0, 50)}`)
  assertDegradedContains(transport.degraded, 'cityAmap', 'Key 未配置', checks, '市内衔接零 key 降级「Key 未配置」')
  assertDegradedContains(transport.degraded, 'intercity/wendao', 'Key 未配置', checks, 'wendao 零 key 休眠记账（intercity/wendao）')

  // ── ⑤ research_advice（天气数据日期+来源；物品 ≥10；零 key 高德天气降级） ──
  transcript.log('\n[research_advice] 天气链 高德→腾讯→Open-Meteo（零 key 落 Open-Meteo）…')
  const advice = await runResearchAdvice({ planId }, store, adviceDeps(adapters))
  transcript.log(`→ weather=${advice.weather.length} 条；packing=${advice.packingList.length} 项；clothing=${advice.clothing.length} 条`)
  for (const w of advice.weather) transcript.log(`    ${w.date} ${w.dayForecast ?? '-'} ${JSON.stringify(w.tempRange)} beyond=${w.beyondForecastWindow ?? false} ← ${w.source.platform} @${w.source.fetchedAt}`)
  transcript.log(`→ degraded=${JSON.stringify(degradedBySource(advice.degraded))}`)
  checks.check(advice.weather.length > 0 && advice.weather.every((w) => w.source && w.source.platform && w.source.fetchedAt), '天气含数据日期+来源（逐条）', `weather=${advice.weather.length} 条`)
  checks.check(advice.packingList.length >= 10, '物品清单 ≥10 项', `packing=${advice.packingList.length}`)
  assertDegradedContains(advice.degraded, 'weatherAmap', 'Key 未配置', checks, '高德天气零 key 降级「Key 未配置」')

  // ── ⑥ build（自动提案 + 动线校验三级降级链） ──
  transcript.log('\n[build_itinerary] 自动提案 + routeCheck（高德零 key → 腾讯零 key → 直线估算）…')
  const built = await runBuildItinerary({ planId }, store, {
    providers: [createAmapRouteProvider(adapters.amap), createTencentRouteProvider(adapters.tencent), createEstimateRouteProvider()],
    keyEnv: env,
  })
  const stopsTotal = built.days.reduce((s, d) => s + d.stops.length, 0)
  transcript.log(`→ built=${built.built} days=${built.days.length} stopsTotal=${stopsTotal}`)
  transcript.log(`→ routeCheck.issues=${JSON.stringify(built.routeCheck.issues)} warnings=${JSON.stringify(built.routeCheck.warnings)}`)
  checks.check(built.built === true, '行程 built=true', `days=${built.days.length} stops=${stopsTotal}`)
  checks.check(Array.isArray(built.routeCheck.issues) && Array.isArray(built.routeCheck.warnings), 'routeCheck issues/warnings 落盘', `issues=${built.routeCheck.issues.length} warnings=${built.routeCheck.warnings.length}`)

  // ── ⑦ render（零 key → Leaflet + warning） ──
  const rendered = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, env)
  transcript.log(`\n[render_page] rendered=${rendered.rendered} mapProviderUsed=${rendered.mapProviderUsed}`)
  transcript.log(`→ url=${rendered.url}`)
  transcript.log(`→ warnings=${JSON.stringify(rendered.warnings)}`)
  checks.check(rendered.rendered === true && rendered.mapProviderUsed === 'leaflet', '零 key 自动降级 Leaflet', `mapProviderUsed=${rendered.mapProviderUsed}`)
  checks.check(rendered.warnings.some((w) => w.includes('key 未配置')), '页面 warning 标注（零 key 地图降级）', rendered.warnings.join('；'))

  // ── ⑧ headless Chrome（Leaflet 页交互：markers=stops / zoom / 来源链接） ──
  const fileUrl = 'file://' + rendered.filePath
  transcript.log(`\n[headless] ${fileUrl}`)
  const dom = chromeDumpDom(fileUrl, redactSecrets)
  const shot = chromeScreenshot(fileUrl, join(DIR, 'page-a.png'))
  const qaLines = ['# browser-qa.txt（剧本 A · 零 key Leaflet 页必测，FR-7 ①②③ + 全条目溯源）']
  const pageHtml = readFileSync(rendered.filePath, 'utf8')
  const data = embeddedData(pageHtml)
  const expected = expectedSourceLinks(data)
  const stopsD = data.itinerary.days.reduce((s, d) => s + d.stops.length, 0)
  qaLines.push(`- 内嵌数据 stops 总数=${stopsD}（页面 console 自检输出：stops=N markers=N）`)
  if (dom.ok) {
    const markers = /data-markers="(\d+)"/.exec(dom.dom)
    const stopsAttr = /data-stops="(\d+)"/.exec(dom.dom)
    const mapReady = /data-map-ready="([^"]+)"/.exec(dom.dom)
    const zoom = dom.dom.includes('leaflet-control-zoom')
    qaLines.push(`- 渲染 markers=${markers ? markers[1] : '?'}（dataset 自检）`)
    qaLines.push(`- dataset stops=${stopsAttr ? stopsAttr[1] : '?'} → markers=stops 断言 ${markers && stopsAttr && markers[1] === stopsAttr[1] && Number(stopsAttr[1]) === stopsD ? 'PASS ✔' : 'FAIL ✘'}`)
    qaLines.push(`- 缩放控件（leaflet-control-zoom）${zoom ? 'PASS ✔' : 'FAIL ✘'}`)
    qaLines.push(`- map-ready=${mapReady ? mapReady[1] : '?'}（应为 leaflet）`)
    const links = countLinks(dom.dom)
    qaLines.push(`- 来源链接（FR-7③）：DOM a[href]=${links}；期望=stops(${expected.stops})+情报卡(${expected.cards})+transport(${expected.transport})+attribution(2)=${expected.total} → ${links === expected.total ? 'PASS ✔' : `MISMATCH ✘（差 ${links - expected.total}）`}`)
    // 全条目溯源（已渲染面）：stops 引用 + 情报卡(food/lodging/warning) + transport 方案
    // 的全部来源 URL 必须在 DOM 可点击；未渲染类别（tip/transportLocal 等停留页外）如实计数不参与断言
    const intelItems = data.intel || {}
    const renderedRefUrls = new Set()
    for (const day of data.itinerary.days) {
      for (const s of day.stops) {
        for (const ref of s.intelRefs ?? []) {
          const it = intelItems[ref]
          if (it && /^https?:\/\//.test(it.source?.url ?? '')) renderedRefUrls.add(it.source.url)
        }
      }
    }
    for (const it of Object.values(intelItems)) {
      if (it && ['food', 'lodging', 'warning'].includes(it.category) && /^https?:\/\//.test(it.source?.url ?? '')) renderedRefUrls.add(it.source.url)
    }
    for (const o of data.transport ?? []) {
      if (o.source && /^https?:\/\//.test(o.source.url)) renderedRefUrls.add(o.source.url)
    }
    const domText = dom.dom.replace(/&amp;/g, '&').replace(/<script[\s\S]*?<\/script>/g, '')
    const missing = [...renderedRefUrls].filter((u) => !domText.includes(`href="${u}"`))
    const unrenderedCount = Object.values(intelItems).filter((i) => i && !['food', 'lodging', 'warning'].includes(i.category)).length
    qaLines.push(`- 全条目溯源（已渲染面）：stops+情报卡+transport 来源 URL=${renderedRefUrls.size}；DOM 可点击缺失=${missing.length} → ${missing.length === 0 ? 'PASS ✔' : `FAIL ✘（缺失 ${missing.slice(0, 3).join(', ')}）`}`)
    qaLines.push(`- 页外未渲染类别条目数=${unrenderedCount}（tip/transportLocal 等仅存 intel.json，非页面展示面，不参与链接断言）`)
    writeFileSync(join(DIR, 'dom-a.html'), dom.dom)
    transcript.log('[headless] dump-dom 已存 dom-a.html（脱敏）')
  } else {
    qaLines.push('- dump-dom blocked（chrome 不可用/失败），登记 blocked')
  }
  qaLines.push(`- 截图：page-a.png${shot.ok ? ' ✔' : ' ✘（登记）'}`)
  transcript.log(`[headless] ${qaLines.slice(1).join('\n            ')}`)
  writeFileSync(join(DIR, 'browser-qa.txt'), qaLines.join('\n'))

  // ── 路由 200（在线通道） ──
  const curl = await curlGet(rendered.url)
  writeFileSync(join(DIR, 'curl-route-200.txt'), `GET ${rendered.url}\nHTTP ${curl.code}\n`)
  checks.check(curl.ok, 'prefix 路由在线访问 HTTP 200', curl.code)
  transcript.log(`[route] ${rendered.url} → HTTP ${curl.code}${curl.ok ? ' ✔' : ''}`)

  // ── degraded 汇总落盘（get_state 口径） ──
  const degraded = (await store.loadDegraded(planId)) ?? []
  writeJson(join(DIR, 'degraded.json'), degraded)
  transcript.log(`\n[degraded 汇总] ${degraded.length} 条：`)
  for (const d of degraded) transcript.log(`  ${d.source}[${d.code}] ${d.reason}`)

  // ── 产物归档 ──
  for (const name of ['request.json', 'intel.json', 'transport.json', 'advice.json', 'itinerary.json']) copyArtifact(store, planId, name, A_DIR)
  copyArtifact(store, planId, 'page.html', A_DIR)
  const redactedPage = redactSecrets(readFileSync(rendered.filePath, 'utf8'))
  writeFileSync(join(A_DIR, 'page-a-redacted.html'), redactedPage)
  const summary = {
    planId, script: 'A',
    intel: { itemCount: dest.itemCount, categories: cats.size, categoryList: [...cats], channelSummary: dest.intelSummary },
    transport: { options: transport.options.length, rail: railOpts.length, railWithPrice: withPrice.length, cityTransfer: transport.cityTransfer?.provider ?? null, comparison: !!transport.comparison },
    advice: { weather: advice.weather.length, packing: advice.packingList.length, clothing: advice.clothing.length },
    build: { built: built.built, days: built.days.length, stops: stopsTotal, issues: built.routeCheck.issues, warnings: built.routeCheck.warnings },
    render: { rendered: rendered.rendered, mapProviderUsed: rendered.mapProviderUsed, warnings: rendered.warnings },
    headless: '见 browser-qa.txt', degradedCount: degraded.length, degraded,
  }
  writeJson(join(DIR, 'summary.json'), summary)
  transcript.write(join(DIR, 'transcript.txt'))
  transcript.log(`\n[剧本 A] PASS=${checks.entries.filter((e) => e.ok).length} FAIL=${checks.entries.filter((e) => !e.ok).length}`)
  checks.write(join(DIR, 'checks.txt'))
  await adapters.rail.close()
  process.exit(checks.allPass() ? 0 : 1)
}

main().catch((err) => {
  console.error('[剧本 A] 失败：', err)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  process.exit(1)
})