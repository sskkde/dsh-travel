/**
 * 剧本 E —— 轻量路径（FR-1 P1）：「查下明天北京到上海的高铁」直答，不强收槽位。
 *
 * 验收点（roadmap §7 剧本 E 行 + FR-1 详细要求 5）：
 *  ① 单意图直接查班次：不进入 intake 多轮追问（required 槽位一次给齐 → 无追问）
 *  ② rail=12306 MCP 真实查询留证（真实班次 ≥2 + ≥1 含价格档）
 *  ③ 不强收槽位：missing=[] 且 nextQuestions=[]（optional 槽位预算/偏好不追问）
 *  ④ 轻量终止：不 build / 不 render（产物仅 request + transport）
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EVID, makeTranscript, makeChecklist, zeroKeyEnv, buildRealAdapters, transportDeps, freshStore, copyArtifact, writeJson } from './helpers.mjs'
import { runIntake } from '../../src/tools/intake.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'

const DIR = join(EVID, 'e')
const ART = join(DIR, 'artifacts')
mkdirSync(ART, { recursive: true })

const transcript = makeTranscript()
const checks = makeChecklist()

/** 明日日期（取证日 +1；预售窗口内）。 */
function tomorrow() {
  const d = new Date(Date.now() + 1 * 86400e3)
  return d.toISOString().slice(0, 10)
}

async function main() {
  const date = tomorrow()
  transcript.log(`## 剧本 E · 轻量路径：「查下明天（${date}）北京到上海的高铁」`)
  const store = freshStore('e')
  const adapters = buildRealAdapters(zeroKeyEnv())

  // ── ① 单轮 intake（required 一次给齐；无追问） ──
  transcript.log('\n[问答面] 用户：「查下明天北京到上海的高铁」')
  const intake = await runIntake({ slots: { origin: '北京', destination: '上海', dateStart: date, dateEnd: date, days: 1 } }, store)
  transcript.log(`→ travel_intake → planId=${intake.planId} status=${intake.status} missing=[${intake.missing.join(',')}] nextQuestions=${JSON.stringify(intake.nextQuestions)}`)
  checks.check(intake.status === 'confirmed', 'intake 一步确认（required 齐）', `status=${intake.status}`)
  checks.check(intake.missing.length === 0, '不强收槽位：missing=[]', '')
  checks.check(intake.nextQuestions.length === 0, '不强收槽位：nextQuestions=[]（无追问）', `nextQuestions=${intake.nextQuestions.length}`)
  const planId = intake.planId

  // ── ② research_transport（rail 12306 真实） ──
  transcript.log('\n[research_transport] rail=12306 MCP 真实查询…')
  const transport = await runResearchTransport({ planId, modes: ['rail'] }, store, transportDeps(adapters))
  const rail = transport.options.filter((o) => o.mode === 'rail')
  const withPrice = rail.filter((o) => o.totalPriceRange)
  const top3 = rail.slice(0, 3).map((o) => `${o.segments[0]?.no} ${o.segments[0]?.depart}-${o.segments[0]?.arrive}（${Math.round((o.durationMinutes ?? 0) / 60)}h）¥${o.totalPriceRange ? `${o.totalPriceRange[0]}~${o.totalPriceRange[1]}` : '?'}`)
  transcript.log(`→ options=${transport.options.length}（rail=${rail.length}）`)
  for (const line of top3) transcript.log(`   ${line}`)
  transcript.log(`→ degraded=${JSON.stringify(transport.degraded.map((d) => `${d.source}[${d.code}]:${d.reason}`))}`)
  checks.check(rail.length >= 2, 'rail 12306 真实班次 ≥2 方案', `rail=${rail.length}`)
  checks.check(withPrice.length >= 1, '≥1 方案含班次+价格档', `${withPrice[0]?.segments[0]?.no} ¥${withPrice[0]?.totalPriceRange?.join('~')}`)
  checks.check(transport.comparison !== undefined, '≥2 方案对比', Boolean(transport.comparison))

  // ── ③ 轻量终止：无 build/render 产物 ──
  const plansDir = join(store.root, '.dsh-travel', planId)
  const hasItinerary = existsSync(join(plansDir, 'itinerary.json'))
  const hasPage = existsSync(join(plansDir, 'page.html'))
  checks.check(!hasItinerary && !hasPage, '轻量终止：不 build / 不 render（产物仅 request+transport）', `itinerary=${hasItinerary} page=${hasPage}`)

  for (const name of ['request.json', 'transport.json']) copyArtifact(store, planId, name, ART)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  writeJson(join(DIR, 'summary.json'), {
    planId, script: 'E', date,
    intake: { status: intake.status, missing: intake.missing, nextQuestions: intake.nextQuestions },
    transport: { options: transport.options.length, rail: rail.length, railWithPrice: withPrice.length, degraded: transport.degraded },
    top3,
  })
  transcript.log(`\n[剧本 E] PASS=${checks.entries.filter((e) => e.ok).length} FAIL=${checks.entries.filter((e) => !e.ok).length}`)
  await adapters.rail.close()
  process.exit(checks.allPass() ? 0 : 1)
}

main().catch((err) => {
  console.error('[剧本 E] 失败：', err)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  process.exit(1)
})