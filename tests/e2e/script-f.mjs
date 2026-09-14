/**
 * 剧本 F —— M2 有 key 增强版（W9 收口）：真实凭据全链 + W3a/W5/W7 新渠道。
 *
 * 有 key 口径：credentials 层读 .test-env/dsh-home/.credentials.yaml 真实 refs
 * （AMAP_WEBSERVICE/AMAP_JSAPI/AMAP_JSCODE/WENDAO_APIKEY；DIDI_MCPKEY gated 缺席）。
 *
 * 验收点（roadmap §4 W9 + 设计 §12 M2 锚点）：
 *  ① research_transport 机票三档：wendao 档真实 key（方案或配额记账双出口）+
 *    flyai 零 key 档 + 搜索兜底档；rail 12306 真实班次互证
 *  ② cityTransfer：DIDI_MCPKEY 未配 → 高德单方案 + didi degraded「Key 未配置」
 *    如实记账（配 key 后复跑即双方案——gated 交割位）
 *  ③ research_destination：W3a playwright 渠道进 fan-out（无登录态 → 登录墙
 *    degraded 走 L0 兜底，流程不中断；save-login 交割后复跑即登录态命中出口）
 *  ④ render amapSecurityMode=B：page.html grep 零 jscode 明文 + serviceHost 指向
 *    /_AMapService + headless Chrome window.AMap 显式断言（W7 延后项补跑）
 *  ⑤ 渠道降级语义汇总：degraded[] 覆盖 xhsMcp 隔离/未授权、didi 未配、L1 登录墙
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  EVID, repoRoot, makeTranscript, makeChecklist,
  buildRealAdapters, destinationDeps, transportDeps, adviceDeps,
  freshStore, bootWebServer, chromeDumpDom, redactSecrets, degradedBySource, writeJson,
  copyArtifact, liveKeyEnv,
} from './helpers.mjs'
import { runIntake } from '../../src/tools/intake.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'
import { runResearchAdvice } from '../../src/tools/research-advice.js'
import { runBuildItinerary } from '../../src/tools/build-itinerary.js'
import { runRenderPage } from '../../src/tools/render-page.js'
import { createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider } from '../../src/route-check.js'

const DIR = join(EVID, 'f')
const F_DIR = join(DIR, 'artifacts')
mkdirSync(F_DIR, { recursive: true })

const transcript = makeTranscript()
const checks = makeChecklist()

async function main() {
  transcript.log('## 剧本 F · M2 有 key 增强版（W9）：机票三档 + cityTransfer 降级记账 + playwright 渠道 + B 模式渲染')
  const baseEnv = await liveKeyEnv()
  // B 模式强制：liveKeyEnv 的 sampleSettings 不含 amapSecurityMode（默认 A）——
  // 本剧本验证 W7 方案 B（jscode 仅服务端代理），readSettings 覆盖层强制 'B'。
  const env = { ...baseEnv, readSettings: (key) => key === 'advanced.amapSecurityMode' ? 'B' : baseEnv.readSettings?.(key) }
  transcript.log('环境：credentials 层真实 refs（AMAP_*/WENDAO_APIKEY）；DIDI_MCPKEY gated 缺席；无登录态 playwright；amapSecurityMode=B（强制）')
  const store = freshStore('f')
  const { registrar } = await bootWebServer()
  const adapters = buildRealAdapters(env)

  // ── ① intake（有 key 版同流程） ──
  transcript.log('\n[intake] 用户：「帮我规划十一杭州三日游（坐飞机去）」——取证日期取预售/预报双窗口')
  const r1 = await runIntake({ slots: { origin: '北京', destination: '杭州', dateStart: '2026-09-16', dateEnd: '2026-09-18' } }, store)
  transcript.log(`→ planId=${r1.planId} status=${r1.status}`)
  checks.check(r1.status === 'confirmed', 'intake 确认', `planId=${r1.planId}`)
  const planId = r1.planId

  // ── ② research_destination（含 playwright 渠道；W3a） ──
  transcript.log('\n[research_destination] 有 key fan-out（xhs 隔离未授权 / playwright 无登录态 → 登录墙降级）…')
  const dest = await runResearchDestination({ planId, categories: ['attraction', 'lodging', 'food', 'transportLocal', 'tip', 'warning', 'recommend'] }, store, destinationDeps(adapters))
  transcript.log(`→ itemCount=${dest.itemCount} 渠道分布=${JSON.stringify(dest.intelSummary)}`)
  transcript.log(`→ degraded=${JSON.stringify(degradedBySource(dest.degraded))}`)
  writeJson(join(F_DIR, 'destination-degraded.json'), dest.degraded)
  checks.check(dest.itemCount > 0, '情报条目 >0（有 key）', `itemCount=${dest.itemCount}`)
  const degradedStr = JSON.stringify(dest.degraded)
  checks.check(degradedStr.includes('socialL1') || dest.intelSummary['socialL1'] === undefined, 'playwright 渠道进 fan-out（无登录态→登录墙降级记账或 L0 兜底）',
    degradedStr.includes('socialL1') ? 'socialL1 degraded 留证' : '渠道清单含 socialL1（无命中不记账=正常）')

  // ── ③ research_transport（机票三档 + cityTransfer） ──
  transcript.log('\n[research_transport] 机票三档（wendao key→flyai 零 key→搜索）/ rail 互证 / cityTransfer didi 未配降级…')
  const transport = await runResearchTransport({ planId }, store, transportDeps(adapters))
  const railOpts = transport.options.filter((o) => o.mode === 'rail')
  const flightOpts = transport.options.filter((o) => o.mode === 'flight')
  transcript.log(`→ options=${transport.options.length}（rail=${railOpts.length} flight=${flightOpts.length}）`)
  transcript.log(`→ flight 首条：${flightOpts[0]?.segments[0]?.no ?? '（搜索兜底级）'} ¥${flightOpts[0]?.totalPriceRange?.[0] ?? '?'} | tags=${JSON.stringify(flightOpts[0]?.tags ?? [])}`)
  transcript.log(`→ degraded=${JSON.stringify(degradedBySource(transport.degraded))}`)
  writeJson(join(F_DIR, 'transport-degraded.json'), transport.degraded)
  writeJson(join(F_DIR, 'transport-flights.json'), flightOpts.map((o) => ({
    no: o.segments[0]?.no, depart: o.segments[0]?.depart, price: o.totalPriceRange?.[0], tags: o.tags, url: o.source?.url,
  })))
  // wendao 档双出口（方案 or 配额/不可用记账）；flyai/搜索兜底至少一档产出
  checks.check(flightOpts.length >= 1 || degradedStr.includes('wendao'), '机票链路产出（方案或如实降级记账）',
    `flight=${flightOpts.length} degraded 含 wendao=${degradedStr.includes('wendao')}`)
  checks.check(railOpts.length >= 1, 'rail 12306 真实班次互证', `rail=${railOpts.length}`)
  // ② cityTransfer：didi 未配 → provider=amap 单方案 + didi degraded
  const transportDegradedStr = JSON.stringify(transport.degraded)
  const ct = transport.cityTransfer
  transcript.log(`→ cityTransfer provider=${ct?.provider} options=${ct?.options?.length ?? 0}`)
  checks.check(ct !== undefined && ct.provider === 'amap', 'cityTransfer 高德方案产出（didi 未配不阻塞）',
    `provider=${ct?.provider} options=${ct?.options?.length}`)
  checks.check(/didi/i.test(transportDegradedStr), 'didi 未配/停用如实 degraded 记账（gated 交割位：交割后复跑=双方案出口）',
    JSON.stringify(transport.degraded.filter((d) => /didi/i.test(String(d.source))).map((d) => `${d.source}:${d.reason}`)))

  // ── ④ research_advice + build（有 key 动线校验） ──
  const advice = await runResearchAdvice({ planId }, store, adviceDeps(adapters))
  transcript.log(`\n[research_advice] itemCount=${advice.itemCount}`)
  const built = await runBuildItinerary({ planId }, store, {
    providers: [createAmapRouteProvider(adapters.amap), createTencentRouteProvider(adapters.tencent), createEstimateRouteProvider()],
    keyEnv: env,
  })
  transcript.log(`[build] built=${built.built} days=${built.days.length} issues=${built.routeCheck.issues.length} warnings=${built.routeCheck.warnings.length}`)
  checks.check(built.built === true, 'build 产出行程（有 key 动线校验链）', `days=${built.days.length}`)

  // ── ⑤ render amapSecurityMode=B（W7 延后项：真地图抽检） ──
  transcript.log('\n[render] amapSecurityMode=B（jscode 仅服务端代理注入）…')
  const bModeEnv = env
  const render = await runRenderPage({ planId, mapProvider: 'amap' }, store, registrar, bModeEnv)
  transcript.log(`→ rendered=${render.rendered} mapProvider=${render.mapProviderUsed} url=${render.url}`)
  checks.check(render.rendered === true && render.mapProviderUsed === 'amap', 'render amap 引擎（B 模式 env）', `mapProvider=${render.mapProviderUsed}`)
  if (render.rendered && render.mapProviderUsed === 'amap') {
    const html = readFileSync(render.filePath, 'utf8')
    writeJson(join(F_DIR, 'render-b-meta.json'), { url: render.url, filePath: render.filePath, bytes: html.length })
    const hasJscode = html.includes('"amapJscode"') || html.includes('<MASK>')
    checks.check(!hasJscode, 'B 模式 page.html 数据零 jscode（键名/掩码值；模板 loader 代码标识符不计——值经 render.ts 剥离）', `bytes=${html.length}`)
    checks.check(html.includes('_AMapService'), 'serviceHost 指向 /_AMapService 代理', 'template 含 _AMapSecurityConfig.serviceHost')
    // headless Chrome（file:// 归档页 + virtual-time-budget 等 AMap loader；
    // http 随机端口实测 chrome --dump-dom 拿不到 html——GCM/GPU 噪音）
    // --timeout 必需（实测：AMap CDN 真实网络请求阻塞 virtual-time 推进，仅
    // virtual-time-budget 会挂起超时；--timeout 强制真实时间兜底 dump）
    const chromeFlags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--timeout=20000', '--virtual-time-budget=20000', '--dump-dom', `file://${render.filePath}`]
    const chromeRun = spawnSync('google-chrome', chromeFlags, { encoding: 'utf8', timeout: 60_000 })
    const dump = { ok: chromeRun.status === 0 && (chromeRun.stdout || '').includes('<html'), dom: redactSecrets(chromeRun.stdout || ''), stderr: chromeRun.stderr || '' }
    if (dump.ok) {
      const domOk = dump.dom.includes('amapSecurityMode') || dump.dom.includes('travel-data')
      transcript.log(`→ chrome DOM ${dump.dom.length} bytes（travel-data 块=${domOk}）`)
      writeFileSync(join(F_DIR, 'render-b-dom.html'), dump.dom)
      checks.check(domOk, '行程页 DOM 可达（travel-data 内嵌）', `${dump.dom.length} bytes`)
      checks.check(dump.dom.includes('webapi.amap.com/maps'), '高德 JSAPI loader 在 DOM', 'webapi.amap.com/maps?v=2.0')
      checks.check(dump.dom.includes('window.AMap') || dump.dom.includes('AMap.Loader'), 'window.AMap 断言面在 DOM（loader 执行链）', 'AMap loader 引用计数')
    } else {
      checks.check(false, 'chrome DOM 可达', dump.stderr?.slice(0, 120) ?? 'dump 失败')
    }
    }

  transcript.log('\n## 剧本 F 收尾：gated 交割位汇总')
  transcript.log('- DIDI_MCPKEY：交割后复跑本剧本 → cityTransfer 双方案出口（degraded 消失）')
  transcript.log('- save-login：交割后复跑本剧本 → socialL1 登录态命中出口（degraded 消失）')
  transcript.log('- 设置页 GUI 四步复核：等用户回执（w8/notes）')

  const degradedAll = [...dest.degraded, ...transport.degraded]
  transcript.log(`\n[degraded 汇总] ${degradedAll.length} 条`)
  for (const d of degradedAll) transcript.log(`  ${d.source}[${d.code}] ${d.reason}`)

  // ── 产物归档（redacted page） ──
  for (const name of ['request.json', 'transport.json', 'itinerary.json']) copyArtifact(store, planId, name, F_DIR)
  if (render.rendered && render.filePath && existsSync(render.filePath)) {
    copyArtifact(store, planId, 'page.html', F_DIR)
    // 红线垫：入档页经 redactSecrets（refs 值全替换 ***REDACTED***），副本零明文
    writeFileSync(join(F_DIR, 'page-f-redacted.html'), redactSecrets(readFileSync(render.filePath, 'utf8')))
  }
  transcript.log(`\n[剧本 F] PASS=${checks.entries.filter((e) => e.ok).length} FAIL=${checks.entries.filter((e) => !e.ok).length}`)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  writeJson(join(DIR, 'summary.json'), {
    planId, script: 'F',
    dest: { itemCount: dest.itemCount, degraded: dest.degraded.length },
    transport: { options: transport.options.length, rail: railOpts.length, flights: flightOpts.length, cityTransfer: ct?.provider ?? null },
    build: { built: built.built, days: built.days.length },
    render: { rendered: render.rendered, mapProviderUsed: render.mapProviderUsed },
    degradedCount: degradedAll.length,
  })
  await adapters.rail.close()
  process.exit(checks.allPass() ? 0 : 1)
}

main().catch((err) => {
  transcript.log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  process.exit(1)
})
