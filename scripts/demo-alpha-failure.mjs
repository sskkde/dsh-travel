/**
 * M1-alpha 故障剧本：两渠道全挂 → 明确报告 + 人工重试入口，不生成空行程页（design §9.3-6）。
 *
 * 与 demo-alpha 同链（intake → research → build → render），但所有渠道 mock 为失败：
 * - tencent POI：httpCall 抛网络错误 → EngineError.UNAVAILABLE
 * - search L0：hostSearch 未注入 → 渠道不可用（前置过滤）
 * 断言（任一不满足 → exit 1）：
 *   ① research itemCount=0 + degraded 双渠道记账 + intel.json 不落盘
 *   ② build → built:false（不产空 itinerary.json）
 *   ③ render → rendered:false（不写 page.html、不注册路由）
 *
 * 证据输出：docs/evidence/m1/alpha/failure-*（transcript/degraded 汇总）
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { runRenderPage } from '../src/tools/render-page.js'
import { TencentMapAdapter } from '../src/adapters/tencent.js'
import { SearchAdapter } from '../src/adapters/search.js'
import { tencentPoiChannel, searchL0Channel } from '../src/orchestrator/channels.js'

const repoRoot = join(import.meta.dirname, '..')
const F = join(repoRoot, 'docs', 'evidence', 'm1', 'alpha')
const STORE_ROOT = join(F, 'failure-store')

const out = []
const log = (line) => { out.push(line); console.log(line) }

function failRegistrar() {
  let registers = 0
  return {
    host: '127.0.0.1', port: 0,
    register() { registers += 1 },
    count: () => registers,
  }
}

async function main() {
  rmSync(STORE_ROOT, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  const store = new TravelStore(STORE_ROOT)

  const intake = await runIntake({
    slots: { destination: '杭州', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
  }, store)
  const planId = intake.planId
  log(`[① intake] planId=${planId} status=${intake.status}`)

  // 全渠道失败 mock
  const failingTencent = new TencentMapAdapter({
    httpCall: async () => { throw new Error('模拟网络不可达 (ECONNREFUSED)') },
  })
  const noHostSearch = new SearchAdapter() // L0 不可用
  const deps = { channels: [tencentPoiChannel(failingTencent), searchL0Channel(noHostSearch)] }

  // ② research：全渠道失败
  const research = await runResearchDestination({ planId, depth: 'quick' }, store, deps)
  log(`[② research] itemCount=${research.itemCount} degraded=${research.degraded.length} 条`)
  for (const d of research.degraded) log(`           ${d.source}[${d.code}]：${d.reason}`)
  const intelMissing = (await store.readJson(planId, 'intel.json')) === undefined
  log(`[② research] intel.json 未落盘（不产空产物）=${intelMissing ? '✔' : '✘'}`)

  // ③ build：intel 缺失 → built:false
  const built = await runBuildItinerary({ planId }, store)
  log(`[③ build] built=${built.built} reason=${built.reason ?? '（无）'}`)
  log(`[③ build] itinerary.json 未落盘=${(await store.readJson(planId, 'itinerary.json')) === undefined ? '✔' : '✘'}`)

  // ④ render：itinerary 缺失 → rendered:false + 不注册路由
  const registrar = failRegistrar()
  const rendered = await runRenderPage({ planId }, store, registrar)
  log(`[④ render] rendered=${rendered.rendered} url="${rendered.url}" warnings=${rendered.warnings.join('；')}`)
  const pageAbsent = !existsSync(join(STORE_ROOT, planId, 'page.html'))
  log(`[④ render] page.html 未生成=${pageAbsent ? '✔' : '✘'}；路由注册次数=${registrar.count()}`)

  // 断言（故障剧本验收点）
  const ok = research.itemCount === 0
    && research.degraded.length >= 2
    && intelMissing
    && built.built === false
    && rendered.rendered === false
    && rendered.url === ''
    && pageAbsent
    && registrar.count() === 0
  log(`\n[failure-script] 断言：${ok ? '全部 PASS ✔（明确报告 + 人工重试入口，不产空行程页）' : '存在失败断言 ✘'}`)
  log(`[failure-script] 人工重试入口：请检查网络/配置后重跑 travel_research_destination（degraded 明细见上）`)

  const degradedFile = (await store.loadDegraded(planId)) ?? []
  writeFileSync(join(F, 'failure-degraded-summary.json'), JSON.stringify({ planId, researchDegraded: research.degraded, degradedJson: degradedFile, built: built.built, rendered: rendered.rendered }, null, 2))
  writeFileSync(join(F, 'failure-transcript.txt'), out.join('\n'))
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('[failure-script] 失败：', err)
  process.exit(1)
})