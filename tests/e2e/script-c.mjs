/**
 * 剧本 C —— 修订：「第二天太满，删掉一个点」。
 *
 * 验收点（roadmap §7 剧本 C 行 + FR-6 验收② + §9.2）：
 *  ① build v1（draft/自动提案）→ render → delivered
 *  ② 用户反馈 → update_request（material 变更 → delivered→revising）
 *  ③ draft 只改第二天（删 1 个 stop）→ 同 planId build v2
 *  ④ 未受影响天（day1/day3）stops/meals 结构逐项相等（JSON 全等断言）
 *  ⑤ 第二天 stops 数减少且其余 stop 相同
 *  ⑥ render_page 同 planId 幂等重渲染（url 相同 / rendered / 无重复注册）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EVID, makeTranscript, makeChecklist, zeroKeyEnv, buildRealAdapters,
  destinationDeps, transportDeps, adviceDeps, freshStore, bootWebServer,
  copyArtifact, degradedBySource, writeJson, embeddedData,
} from './helpers.mjs'
import { runIntake } from '../../src/tools/intake.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'
import { runResearchAdvice } from '../../src/tools/research-advice.js'
import { runBuildItinerary } from '../../src/tools/build-itinerary.js'
import { runRenderPage } from '../../src/tools/render-page.js'
import { runUpdate } from '../../src/tools/update.js'
import { createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider } from '../../src/route-check.js'

const DIR = join(EVID, 'c')
const ART = join(DIR, 'artifacts')
mkdirSync(ART, { recursive: true })

const transcript = makeTranscript()
const checks = makeChecklist()

/** stops/meals 判定键（FR-6 验收②：名称/顺序/时长/来源引用）。 */
function daySignature(day) {
  return JSON.stringify({
    stops: day.stops.map((s) => ({ name: s.name, category: s.category, coords: s.coords, durationHint: s.durationHint, intelRefs: s.intelRefs })),
    meals: (day.meals ?? []).map((m) => ({ name: m.name, intelRefs: m.intelRefs })),
  })
}

async function buildPipeline(store, planId, adapters, label) {
  const dest = await runResearchDestination({ planId, categories: ['attraction', 'lodging', 'food', 'transportLocal', 'tip', 'warning', 'recommend'] }, store, destinationDeps(adapters))
  const transport = await runResearchTransport({ planId }, store, transportDeps(adapters))
  const advice = await runResearchAdvice({ planId }, store, adviceDeps(adapters))
  const built = await runBuildItinerary({ planId }, store, {
    providers: [createAmapRouteProvider(adapters.amap), createTencentRouteProvider(adapters.tencent), createEstimateRouteProvider()],
    keyEnv: adapters.env,
  })
  transcript.log(`[${label}] intel=${dest.itemCount} transport=${transport.options.length} advice.w=${advice.weather.length} built=${built.built} days=${built.days.length}`)
  return { dest, transport, advice, built }
}

async function main() {
  transcript.log('## 剧本 C · 修订：「第二天太满，删掉一个点」')
  const store = freshStore('c')
  const { registrar } = await bootWebServer()
  const adapters = buildRealAdapters(zeroKeyEnv())

  // ── ① v1：intake → research ×3 → build（自动提案）→ render ──
  const intake = await runIntake({ slots: { origin: '北京', destination: '杭州', dateStart: '2026-09-16', dateEnd: '2026-09-18', days: 3, travelers: { adults: 2 } } }, store)
  const planId = intake.planId
  transcript.log(`\n[intake] planId=${planId} status=${intake.status} missing=[${intake.missing.join(',')}]`)
  const v1Pipeline = await buildPipeline(store, planId, adapters, 'v1')
  const v1 = v1Pipeline.built
  writeJson(join(ART, 'itinerary-v1.json'), await store.readJson(planId, 'itinerary.json'))
  transcript.log(`[v1] days=${v1.days.length} 每日 stops=${v1.days.map((d) => d.stops.length).join('/')} routeCheck.issues=${JSON.stringify(v1.routeCheck.issues)}`)
  checks.check(v1.built === true && v1.days.length === 3, 'v1 built 3 天', `stops=${v1.days.map((d) => d.stops.length).join('/')}`)
  checks.check(v1.days[1].stops.length >= 3, 'v1 第二天 ≥3 个点（可删 1 个）', `day2 stops=${v1.days[1].stops.length}`)

  const rendered1 = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, adapters.env)
  transcript.log(`[render v1] rendered=${rendered1.rendered} url=${rendered1.url}`)
  checks.check(rendered1.rendered === true, 'v1 render 成功', '')

  // ── ② 用户反馈 → update（material → delivered→revising） ──
  transcript.log('\n[问答面] 用户：「第二天太满，删一个点」')
  const upd = await runUpdate({ planId, patch: { slots: { constraints: ['第二天太满，删一个点'] } } }, store)
  transcript.log(`→ travel_update_request(constraints=…) → status=${upd.status} rerunHints=${JSON.stringify(upd.rerunHints)}`)
  checks.check(upd.status === 'revising', 'delivered→revising（修订态就绪）', `status=${upd.status}`)

  // ── ③ draft 只改第二天（删最后一个 stop）→ 同 planId build v2 ──
  const v1Stored = await store.readJson(planId, 'itinerary.json')
  const draftDays = JSON.parse(JSON.stringify(v1Stored.days))
  const removedStop = draftDays[1].stops.at(-1)
  draftDays[1].stops = draftDays[1].stops.slice(0, -1)
  transcript.log(`\n[draft v2] 第二天删「${removedStop?.name}」（${draftDays[1].stops.length}→${draftDays[1].stops.length} 点）；day1/day3 原样`)

  const v2 = await runBuildItinerary({ planId, draft: { days: draftDays } }, store, {
    providers: [createAmapRouteProvider(adapters.amap), createTencentRouteProvider(adapters.tencent), createEstimateRouteProvider()],
    keyEnv: adapters.env,
  })
  writeJson(join(ART, 'itinerary-v2.json'), await store.readJson(planId, 'itinerary.json'))
  transcript.log(`[build v2] built=${v2.built} days=${v2.days.length} 每日 stops=${v2.days.map((d) => d.stops.length).join('/')}`)

  // ── ④ 未受影响天逐项相等（FR-6 验收②） ──
  const sV1 = v1.days.map(daySignature)
  const sV2 = v2.days.map(daySignature)
  checks.check(sV2[0] === sV1[0], 'day1 未受影响天结构逐项相等', sV2[0] === sV1[0] ? '相等' : 'DIFF')
  checks.check(sV2[2] === sV1[2], 'day3 未受影响天结构逐项相等', sV2[2] === sV1[2] ? '相等' : 'DIFF')
  checks.check(sV2[1] !== sV1[1], 'day2 结构变化（仅受影响天）', `v1=${v1.days[1].stops.length}点 v2=${v2.days[1].stops.length}点`)
  checks.check(v2.days[1].stops.length === v1.days[1].stops.length - 1, '第二天 stops 数 = 原 -1', `${v1.days[1].stops.length}→${v2.days[1].stops.length}`)
  checks.check(v2.routeCheck.issues.length === 0 || v2.routeCheck.issues.length <= v1.routeCheck.issues.length, 'routeCheck 重算（issues 不恶化）', `issues ${JSON.stringify(v1.routeCheck.issues)} → ${JSON.stringify(v2.routeCheck.issues)}`)

  // ── ⑤ 同 planId 幂等重渲染（§9.2） ──
  const rendered2 = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, adapters.env)
  transcript.log(`[render v2] rendered=${rendered2.rendered} url 相同=${rendered2.url === rendered1.url}`)
  checks.check(rendered2.rendered === true, 'v2 render 成功', '')
  checks.check(rendered2.url === rendered1.url, '同 planId 幂等重渲染（URL 相同）', `${rendered1.url} == ${rendered2.url}`)
  const page2 = readFileSync(rendered2.filePath, 'utf8')
  const data2 = embeddedData(page2)
  const stopsInPage2 = data2.itinerary.days.reduce((s, d) => s + d.stops.length, 0)
  const day2InPage2 = data2.itinerary.days[1].stops.length
  checks.check(stopsInPage2 === v2.days.reduce((s, d) => s + d.stops.length, 0), '重渲染页面数据=v2 行程', `pageStops=${stopsInPage2} v2Stops=${v2.days.reduce((s, d) => s + d.stops.length, 0)}`)
  checks.check(day2InPage2 === v2.days[1].stops.length && day2InPage2 === v1.days[1].stops.length - 1, '重渲染页面第二天=v2（删点后）', `pageDay2=${day2InPage2}`)

  const degraded = (await store.loadDegraded(planId)) ?? []
  writeJson(join(DIR, 'degraded.json'), degraded)
  transcript.log(`\n[degraded 汇总] ${degraded.length} 条：${JSON.stringify(degradedBySource(degraded))}`)

  for (const name of ['request.json', 'intel.json', 'transport.json', 'advice.json']) copyArtifact(store, planId, name, ART)
  copyArtifact(store, planId, 'page.html', ART, 'page-v2.html')
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  writeJson(join(DIR, 'summary.json'), {
    planId, script: 'C',
    v1: { days: v1.days.length, stopsPerDay: v1.days.map((d) => d.stops.length), issues: v1.routeCheck.issues },
    v2: { days: v2.days.length, stopsPerDay: v2.days.map((d) => d.stops.length), issues: v2.routeCheck.issues, removedStop: removedStop?.name },
    preservation: { day1: sV2[0] === sV1[0], day3: sV2[2] === sV1[2], day2Changed: sV2[1] !== sV1[1] },
    renderIdempotent: rendered2.url === rendered1.url,
  })
  transcript.log(`\n[剧本 C] PASS=${checks.entries.filter((e) => e.ok).length} FAIL=${checks.entries.filter((e) => !e.ok).length}`)
  checks.write(join(DIR, 'checks.txt'))
  await adapters.rail.close()
  process.exit(checks.allPass() ? 0 : 1)
}

main().catch((err) => {
  console.error('[剧本 C] 失败：', err)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  process.exit(1)
})