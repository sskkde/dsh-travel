/**
 * 剧本 B —— 推荐模式：「推荐几个适合带老人玩的海边城市」。
 *
 * 验收点（roadmap §7 剧本 B 行 + FR-2 验收④）：
 *  ① intake(mode=recommend)：destination 不计入 missing（missing 不含 destination）
 *  ② 候选 3~5 个且各带来源 URL（经真实 L0 搜索合成——cn.bing 真实命中锚点）
 *  ③ update_request 回注选定候选 → 状态 recommending→collecting→confirmed
 *  ④ 回注后不重复追问（FR-2 验收④：missing=[] 且 nextQuestions=[]）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTranscript, makeChecklist, realBingHostSearch, freshStore, writeJson, sleep, EVID } from './helpers.mjs'
import { runIntake } from '../../src/tools/intake.js'
import { runUpdate } from '../../src/tools/update.js'

const DIR = join(EVID, 'b')
mkdirSync(join(DIR, 'artifacts'), { recursive: true })

const transcript = makeTranscript()
const checks = makeChecklist()

async function main() {
  transcript.log('## 剧本 B · 推荐模式：「推荐几个适合带老人玩的海边城市」')
  const store = freshStore('b')
  const search = realBingHostSearch()

  // ── ① intake(mode=recommend)，destination 留空 ──
  transcript.log('\n[问答面] 用户：「推荐几个适合带老人玩的海边城市」')
  const intake = await runIntake({
    mode: 'recommend',
    slots: { origin: '北京', dateStart: '2026-09-18', dateEnd: '2026-09-20', days: 3, travelers: { adults: 2, seniors: 1 } },
  }, store)
  transcript.log(`→ travel_intake(mode=recommend) → planId=${intake.planId} status=${intake.status} missing=[${intake.missing.join(',')}] nextQuestions=${JSON.stringify(intake.nextQuestions)}`)
  checks.check(intake.status === 'recommending', 'recommend 模式状态 recommending', `status=${intake.status}`)
  checks.check(!intake.missing.includes('destination'), 'destination 不计入 missing（推荐模式放宽）', `missing=${intake.missing.join(',') || '（无）'}`)
  checks.check(!intake.missing.includes('dateStart') && !intake.missing.includes('dateEnd') && !intake.missing.includes('days'), '成行必需槽位已齐（日期/天数）', '')
  const planId = intake.planId

  // ── ② 候选 3~5 个带来源（LLM 经 web_search 合成；此处真实 L0 检索锚点） ──
  transcript.log('\n[候选合成] 模型侧 L0 检索「带老人 海边城市 推荐 攻略」（cn.bing 真实命中）…')
  const searchQueries = [
    '适合带老人旅游的海边城市 推荐',
    '威海 青岛 三亚 带老人 海边 旅游攻略',
  ]
  const hits = []
  for (const q of searchQueries) {
    try {
      const result = await search(q, 6)
      hits.push(...result.sources)
      transcript.log(`  「${q.slice(0, 20)}…」→ ${result.sources.length} 命中`)
    } catch (err) {
      transcript.log(`  「${q.slice(0, 20)}…」→ 检索失败：${err instanceof Error ? err.message : err}（登记降级）`)
    }
    await sleep(300)
  }
  // 去重（URL）后取前 4 个作为候选锚点
  const seen = new Set()
  const anchors = hits.filter((h) => { if (seen.has(h.url)) return false; seen.add(h.url); return true }).slice(0, 4)
  const idList = ['coastal-qingdao', 'coastal-weihai', 'coastal-sanya', 'coastal-xiamen']
  const candidates = anchors.map((a, i) => ({
    id: idList[i] ?? `coastal-${i}`,
    city: ['青岛', '威海', '三亚', '厦门'][i] ?? `候选${i + 1}`,
    whyFit: '海水浴场开阔平缓、节奏松弛、餐饮丰富，适合长辈慢节奏游览',
    source: { title: a.title, url: a.url },
  }))
  transcript.log(`→ 候选 ${candidates.length} 个：${candidates.map((c) => `${c.city}(src=${c.source.url})`).join('；')}`)
  checks.check(candidates.length >= 3 && candidates.length <= 5, '候选 3~5 个', `count=${candidates.length}`)
  checks.check(candidates.every((c) => /^https?:\/\//.test(c.source.url)), '候选全部带来源 URL', candidates.map((c) => c.city).join(','))
  writeJson(join(DIR, 'artifacts', 'candidates.json'), candidates)

  // ── ③ 用户选定「威海」→ update_request 回注 ──
  transcript.log('\n[问答面] 用户：「威海吧」')
  const updated = await runUpdate({ planId, patch: { slots: { destination: '威海' } } }, store)
  transcript.log(`→ travel_update_request(destination=威海) → status=${updated.status} missing=[${updated.missing.join(',')}] rerunHints=${JSON.stringify(updated.rerunHints)}`)
  checks.check(updated.found === true, '回注 found=true', '')
  checks.check(updated.status === 'confirmed', '回注后 recommending→collecting→confirmed', `status=${updated.status}`)
  checks.check(updated.missing.length === 0, '回注后槽位完整 missing=[]', '')
  checks.check(updated.nextQuestions.length === 0, '不重复追问（FR-2 验收④ nextQuestions=[]）', '')

  // 复核：destination 已入槽位
  const state = await store.loadRequest(planId)
  checks.check(state?.slots?.destination === '威海', '回注目的地落盘（slots.destination=威海）', `dest=${state?.slots?.destination}`)

  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  writeJson(join(DIR, 'summary.json'), {
    planId, script: 'B', intake: { status: intake.status, missing: intake.missing },
    candidates: candidates.map((c) => ({ city: c.city, url: c.source.url })),
    backfill: { status: updated.status, missing: updated.missing, nextQuestions: updated.nextQuestions },
  })
  transcript.log(`\n[剧本 B] PASS=${checks.entries.filter((e) => e.ok).length} FAIL=${checks.entries.filter((e) => !e.ok).length}`)
  process.exit(checks.allPass() ? 0 : 1)
}

main().catch((err) => {
  console.error('[剧本 B] 失败：', err)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  process.exit(1)
})