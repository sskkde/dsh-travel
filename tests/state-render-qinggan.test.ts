/**
 * W4 T16 —— 代码门/state 研究视图/页面与导出分级（state-render-qinggan）。
 *
 * 覆盖（计划 T16 Acceptance / QA）：
 * - ① 门 helper 矩阵：每阶段缺依赖 → blocked+nextAction+零网络（resolve 的
 *   research_not_ready、交通/路由的 places 门）；失败/零结果发布失败元数据
 *   不复活旧数据（stale/failed/empty 逐项）。
 * - ② travel_get_state 研究视图：researchVersion/轮次/候选与正文索引/当前
 *   assessment（含过期）/失败与预算（used/remaining）/恢复动作；不返回正文全文。
 * - ③ 页面/导出分级：正文含 HTML/伪指令 fixture → 按文本渲染（esc）；导出默认
 *   零全文正文（buildExportBundle 不含 research-content body）；legacy 计划
 *   浏览/导出回归绿。
 *
 * 全确定性 fixture（零真实网络）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runGetState } from '../src/tools/state.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { runFetchResearchContent } from '../src/tools/research-content.js'
import { runRecordResearchAssessment, runReadResearchAssessment } from '../src/tools/research-assessment.js'
import { runRouteTransport } from '../src/tools/route-transport.js'
import { researchGate, placesGate, firstBlocked, type GateBlocked } from '../src/tools/gates.js'
import { renderWithTemplate, templatePath, buildRenderData, type RenderPageData, type PageMapConfig } from '../src/render/render.js'
import { buildExportBundle, canonicalJson, markdownOf } from '../src/export/itinerary-export.js'
import type { ResearchChannel } from '../src/orchestrator/types.js'
import type { CanonicalQuery } from '../src/adapters/base.js'
import type { IntelCategory, IntelItem, IntelChannel, ResearchState } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-sr-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────── fixtures ──────────────────────────

let seq = 0
function mkItem(id: string, channel: IntelChannel, title: string, category: IntelCategory = 'recommend'): IntelItem {
  seq += 1
  return {
    id,
    category,
    channel,
    title,
    summary: `摘要 ${title}`,
    source: { platform: 'scripted', url: `https://example.invalid/item/${id}`, fetchedAt: `2026-09-0${(seq % 9) + 1}T00:00:00.000Z` },
    confidence: 'medium',
  }
}

function scriptedChannel(run: (query: CanonicalQuery) => IntelItem[] | undefined): ResearchChannel {
  return {
    name: 'web',
    async available() {
      return true
    },
    async run(query) {
      const items = await run(query)
      if (items === undefined || items.length === 0) {
        return { ok: false, code: 'EMPTY' as const, reason: 'scripted no hits' }
      }
      return { ok: true, items }
    },
  }
}

async function makePlan(opts: { destination?: string; researchIntent?: { text: string; keywords?: string[] } } = {}): Promise<string> {
  const slots: Record<string, unknown> = { dateStart: '2026-10-01', dateEnd: '2026-10-03', origin: '武汉' }
  if (opts.destination) slots.destination = opts.destination
  if (opts.researchIntent) slots.researchIntent = opts.researchIntent
  const result = await runIntake({ slots }, store)
  return result.planId
}

function readSettingsStub(env: Record<string, string> = {}) {
  return { readSettings: (k: string): string | undefined => env[k], env }
}

/** 规范研究序列：intake → research（一轮） → 取正文 → 提交 sufficient。 */
async function makeResearchDonePlan(): Promise<string> {
  const planId = await makePlan({ destination: '西宁', researchIntent: { text: '青甘大环线攻略' } })
  const sc = scriptedChannel(() => [mkItem('web:a', 'web', '西宁 攻略 A'), mkItem('web:b', 'web', '敦煌 鸣沙山 B')])
  await runResearchDestination({ planId, keywords: ['青甘大环线'] }, store, { channels: [sc], env: readSettingsStub() })
  // 直写 research-content 工件（模拟 T6 抓取结果；正文含伪指令 fixture）
  const SCRIPT_OPEN = '<' + 'script>'
  await store.writeResearchContent(planId, 'web:a', 'v1', {
    contentRef: 'web:a',
    contentVersion: 'v1',
    title: '西宁 攻略 A',
    sourceUrl: 'https://example.invalid/item/web:a',
    channel: 'web',
    contentStatus: 'extracted',
    fetchedAt: '2026-09-06T00:00:00.000Z',
    body: `正文 ${SCRIPT_OPEN}alert(1)${'</'}script> 指令不应执行`,
  } as never)
  // 更新 research-state 索引（把 a 标上 contentRef/contentVersion）
  const state = await store.loadResearchState<ResearchState>(planId)
  await store.saveResearchState(planId, {
    ...state,
    itemIndex: [
      { itemId: 'web:a', roundId: state!.rounds[0], channel: 'web', title: '西宁 攻略 A', contentRef: 'web:a', contentVersion: 'v1' },
      { itemId: 'web:b', roundId: state!.rounds[0], channel: 'web', title: '敦煌 鸣沙山 B' },
    ],
  } as ResearchState)
  await runRecordResearchAssessment({
    planId,
    verdict: 'sufficient',
    rationale: 'fixture 充分',
    evidenceRefs: ['web:a'],
  }, store)
  return planId
}

// ────────────────────────── ① 门 helper 矩阵 ──────────────────────────

describe('T16① DAG 代码门（researchGate/placesGate 矩阵）', () => {
  it('research 门：无 assessment → blocked research_not_ready + nextAction（零网络）', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const gate = await researchGate(store, planId)
    expect(gate).toBeDefined()
    expect(gate!.reason).toBe('research_not_ready')
    expect(gate!.nextAction.length).toBeGreaterThan(0)
    expect(gate!.blocked).toBe(true)
  })

  it('research 门：预算耗尽（即使已 sufficient 且为当前版本）→ 仍 blocked（暂停非完成）', async () => {
    const planId = await makePlan({ destination: '西宁' })
    await store.saveResearchState(planId, {
      schemaVersion: 1,
      researchVersion: 1,
      updatedAt: '2026-09-06T00:00:00.000Z',
      rounds: ['r1'],
      budget: { usedRounds: 16, maxRoundsPerPlan: 16, exhausted: true },
      sources: [],
      itemIndex: [],
      assessment: { assessmentId: 'a1', status: 'sufficient', researchVersion: 1, recordedAt: '2026-09-06T00:00:00.000Z' },
    } as ResearchState)
    const gate = await researchGate(store, planId)
    expect(gate).toBeDefined()
    expect(gate!.reason).toBe('research_not_ready')
    expect(gate!.detail).toContain('耗尽')
    expect(gate!.nextAction).toContain('额度')
  })

  it('places 门矩阵：缺工件 / failed / empty / stale-hash / intel 领先 / 版本过期 → 逐项 blocked+nextAction', async () => {
    const planId = await makePlan({ destination: '西宁' })

    // 缺工件 → places_not_ready
    const g1 = await placesGate(store, planId)
    expect(g1).toBeDefined()
    expect(g1!.reason).toBe('places_not_ready')
    expect(g1!.nextAction).toContain('travel_resolve_places')

    // failed 发布元数据 → places_failed（不把失败当成功消费）
    await store.writeJson(planId, 'places.json', {
      schemaVersion: 1, intelVersion: 0, inputFingerprint: 'f', status: 'failed', candidates: [], selectedSequence: [],
    })
    await store.publishArtifacts(planId, {
      stage: 'places', files: [{ name: 'places.json', data: { status: 'failed' } }], status: 'failed', failureReason: 'fixture fail',
    })
    const g2 = await placesGate(store, planId)
    expect(g2).toBeDefined()
    expect(g2!.reason).toBe('places_failed')

    // empty 零结果 → places_empty（不复活）
    await store.publishArtifacts(planId, {
      stage: 'places', files: [{ name: 'places.json', data: { status: 'empty' } }], status: 'empty',
    })
    const g3 = await placesGate(store, planId)
    expect(g3).toBeDefined()
    expect(g3!.reason).toBe('places_empty')

    // stale hash（改写文件使 hash 失配）→ places_stale
    await store.publishArtifacts(planId, {
      stage: 'places', files: [{ name: 'places.json', data: { schemaVersion: 1, intelVersion: 0, inputFingerprint: 'f', status: 'ready', candidates: [], selectedSequence: [], places: [], entryPlaceId: 'p1', originResolution: { resolved: true } } }], status: 'success', bump: ['places'],
    })
    // 用未发布文件覆盖（旧数据只能 stale）
    await store.writeJson(planId, 'places.json', { tampered: true })
    const g4 = await placesGate(store, planId)
    expect(g4).toBeDefined()
    expect(g4!.reason).toBe('places_stale')

    // 版本过期（expected 不匹配）→ places_stale（需在干净发布态，避开上方 stale-hash 提前命中）
    const validPlaces = { schemaVersion: 1, intelVersion: 0, inputFingerprint: 'f', status: 'ready', candidates: [], selectedSequence: [], places: [], entryPlaceId: 'p1', originResolution: { resolved: true } }
    const planId2 = await makePlan({ destination: '兰州' })
    await store.publishArtifacts(planId2, {
      stage: 'places', files: [{ name: 'places.json', data: validPlaces }], status: 'success', bump: ['places'],
    })
    const g5 = await placesGate(store, planId2, 999)
    expect(g5).toBeDefined()
    expect(g5!.reason).toBe('places_stale')
    expect(g5!.detail).toContain('版本过期')
  })

  it('firstBlocked：多个门并发只返回首个 blocked', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const gates: Array<GateBlocked | undefined> = [
      await researchGate(store, planId),
      await placesGate(store, planId),
    ]
    const first = firstBlocked(gates)
    expect(first).toBeDefined()
    expect(first!.reason).toBe('research_not_ready')
  })

  it('工具级零网络：route-transport 无 places → places_not_ready，不调用 provider', async () => {
    const planId = await makePlan({ destination: '西宁' })
    const providerCalls: string[] = []
    const result = await runRouteTransport({ planId }, store, {
      providers: [{
        name: 'probe',
        label: 'probe',
        modes: ['driving'],
        available: async () => { providerCalls.push('available'); return { ok: true } },
        measure: async () => { providerCalls.push('measure'); return [] },
      }],
    })
    expect(result.status).toBe('places_not_ready')
    expect(providerCalls).toHaveLength(0)
    expect(result.placesNotReady?.detail).toContain('places')
  })
})

// ────────────────────────── ② state 研究视图 ──────────────────────────

describe('T16② travel_get_state 研究视图', () => {
  it('研究计划：字段齐全（版本/轮次/索引/assessment/预算/恢复动作）且无正文全文', async () => {
    const planId = await makeResearchDonePlan()
    const st = await runGetState({ planId }, store)
    expect(st.found).toBe(true)
    expect(st.research).toBeDefined()
    const r = st.research!
    expect(r.researchVersion).toBeGreaterThanOrEqual(1)
    expect(r.rounds.length).toBeGreaterThanOrEqual(1)
    expect(r.items.length).toBeGreaterThanOrEqual(2)
    expect(r.budget.usedRounds + r.budget.remainingRounds).toBe(r.budget.maxRoundsPerPlan)
    expect(r.nextAction).toBeUndefined() // sufficient 且当前版本 → 就绪无恢复动作
    expect(r.ready).toBe(true)
    // assessment 状态
    expect(r.assessment).toBeDefined()
    expect(r.assessment!.status).toBe('sufficient')
    expect(r.assessment!.stale).toBe(false)
    // 分级：a 已取正文 → fetched；b 未取正文 → title
    const byId = Object.fromEntries(r.items.map((i) => [i.itemId, i]))
    expect(byId['web:a'].grade).toBe('fetched')
    expect(byId['web:b'].grade).toBe('title')
    // 无正文全文：任何字段不含 body 内容（不一次返回全部原文）
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain('正文')
    expect(serialized).not.toContain('alert(1)')
  })

  it('研究中断：budget 耗尽 → notReadyReason=budget_exhausted + 恢复动作', async () => {
    const planId = await makePlan({ destination: '西宁' })
    await store.saveResearchState(planId, {
      schemaVersion: 1,
      researchVersion: 2,
      updatedAt: '2026-09-06T00:00:00.000Z',
      rounds: ['r1'],
      budget: { usedRounds: 16, maxRoundsPerPlan: 16, exhausted: true },
      sources: [],
      itemIndex: [],
      assessment: { assessmentId: 'a1', status: 'sufficient', researchVersion: 2, recordedAt: '2026-09-06T00:00:00.000Z' },
    } as ResearchState)
    const st = await runGetState({ planId }, store)
    const r = st.research!
    expect(r.ready).toBe(false)
    expect(r.notReadyReason).toBe('budget_exhausted')
    expect(r.nextAction).toContain('额度')
  })

  it('研究状态：版本过期（新证据使旧 sufficient 失效）→ stale + ready=false + 恢复动作', async () => {
    const planId = await makeResearchDonePlan()
    // 新轮次提升 researchVersion（旧 sufficient 引用旧版本 → stale），再覆盖 state 使版本领先
    const state = await store.loadResearchState<ResearchState>(planId)
    await store.saveResearchState(planId, { ...state, researchVersion: state!.researchVersion + 1 } as ResearchState)
    const st = await runGetState({ planId }, store)
    const r = st.research!
    expect(r.ready).toBe(false)
    expect(r.notReadyReason).toBe('stale_version')
    expect(r.assessment!.stale).toBe(true)
    expect(r.nextAction).toContain('assessment')
  })

  it('legacy 计划（无 research-state）：浏览不强制重新研究、无研究视图、不抛错', async () => {
    const planId = await makePlan({ destination: '武汉' })
    const st = await runGetState({ planId }, store)
    expect(st.found).toBe(true)
    expect(st.research).toBeUndefined()
    expect(st.artifacts).not.toContain('research-state.json')
  })

  it('DR4：研究视图 assessment 含 gaps/findings/conflicts 计数摘要（不返回全文/正文）', async () => {
    const planId = await makePlan({ destination: '西宁', researchIntent: { text: '青甘大环线攻略' } })
    const sc = scriptedChannel(() => [mkItem('web:a', 'web', '西宁 攻略 A')])
    await runResearchDestination({ planId, keywords: ['青甘大环线'] }, store, { channels: [sc], env: readSettingsStub() })
    await runRecordResearchAssessment({
      planId,
      verdict: 'continue',
      rationale: '尚缺敦煌段情报',
      findings: [{ claimId: 'c1', statement: '莫高窟需预约', status: 'confirmed' }],
      gaps: [{ requirement: '敦煌交通', gap: '缺火车/大巴班次' }],
      conflicts: [{ aRef: 'web:a', bRef: 'web:b', note: '两源门票价矛盾' }],
      requirements: ['敦煌段交通', '门票预约'],
    }, store)
    const st = await runGetState({ planId }, store)
    const a = st.research!.assessment!
    expect(a.status).toBe('continue')
    expect(a.findingsCount).toBe(1)
    expect(a.gapsCount).toBe(1)
    expect(a.conflictsCount).toBe(1)
    expect(a.requirementsCount).toBe(2)
    // 不返回正文全文（用正文特征 marker 断言；研究视图允许出现「取正文」等指令词）
    expect(JSON.stringify(st.research)).not.toContain('alert(1)')
    expect(JSON.stringify(st.research)).not.toContain('BODY-FULL')
  })

  it('DR4：travel_read_research_assessment 读当前与按 id 读历史（stale 如实）', async () => {
    const planId = await makePlan({ destination: '西宁', researchIntent: { text: '青甘大环线攻略' } })
    const sc = scriptedChannel(() => [mkItem('web:a', 'web', '西宁 攻略 A')])
    await runResearchDestination({ planId, keywords: ['青甘大环线'] }, store, { channels: [sc], env: readSettingsStub() })
    const rec = await runRecordResearchAssessment({
      planId, verdict: 'sufficient', rationale: 'fixture 充分',
      findings: [{ claimId: 'c1', statement: '莫高窟需预约', status: 'confirmed' }],
      gaps: [{ requirement: '敦煌交通', gap: '缺班次' }],
      conflicts: [],
      evidenceRefs: ['web:a'],
    }, store)
    // 读当前（缺省）
    const cur = await runReadResearchAssessment({ planId }, store)
    expect(cur.found).toBe(true)
    expect(cur.assessment?.assessmentId).toBe(rec.assessmentId)
    expect(cur.stale).toBe(false)
    expect(cur.assessment?.findings).toHaveLength(1)
    expect(cur.assessment?.gaps).toHaveLength(1)

    // 新轮次前进版本 → 读当前变 stale（无复活），历史快照仍可经 id 读
    const state = await store.loadResearchState<ResearchState>(planId)
    await store.saveResearchState(planId, { ...state!, researchVersion: state!.researchVersion + 1 } as ResearchState)
    const after = await runReadResearchAssessment({ planId }, store)
    expect(after.found).toBe(true)
    expect(after.stale).toBe(true)
    const hist = await runReadResearchAssessment({ planId, assessmentId: rec.assessmentId }, store)
    expect(hist.found).toBe(true)
    expect(hist.assessment?.verdict).toBe('sufficient')

    // 不存在 → found:false
    const missing = await runReadResearchAssessment({ planId, assessmentId: 'assess-nope' }, store)
    expect(missing.found).toBe(false)
  })
})

// ────────────────────────── ③ 页面/导出分级 ──────────────────────────

describe('T16③ 页面与导出分级（正文转义 + 导出默认零全文）', () => {
  function minimalRenderData(over: Partial<RenderPageData> = {}): RenderPageData {
    const map: PageMapConfig = { provider: 'leaflet', warnings: [] }
    return {
      renderedAt: '2026-09-06T00:00:00.000Z',
      request: {
        planId: 'plan-x', status: 'delivered', updatedAt: '2026-09-06T00:00:00.000Z',
        slots: { destination: '西宁', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
        assumptions: [],
      },
      itinerary: {
        days: [{ date: '2026-10-01', theme: '', stops: [], meals: [] }],
        routeCheck: { issues: [], warnings: [] },
      },
      intel: {},
      degraded: [],
      map,
      ...over,
    }
  }

  it('正文含 HTML/伪指令 fixture → 按文本渲染（esc），不执行/不注入', async () => {
    const payload = '<img src=x onerror=' + 'alert(1)>' + '<' + 'script>' + 'window.pwned=1<' + '/script> & 伪指令 "j:alert"'
    const data = minimalRenderData({
      intel: {
        'x1': {
          id: 'x1', category: 'warning', channel: 'web', title: '恶意标题 <b>bold</b>', summary: payload,
          source: { platform: 'web', url: `https://example.invalid/x1`, fetchedAt: '2026-09-06T00:00:00.000Z' },
          confidence: 'low',
        },
      },
      research: { grades: { x1: 'fetched' }, researchVersion: 1 },
    })
    const template = readFileSync(templatePath(), 'utf8')
    const html = renderWithTemplate(data, template)
    // 原文 `<img ...>` 不应原样出现在可执行位置：已转义
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;')
    expect(html).toContain('&amp;')
    // 分级徽标存在
    expect(html).toContain('已取正文')
    expect(html).toContain('content-grade')
  })

  it('导出默认零全文正文：buildExportBundle JSON/Markdown 均不含 research-content body（BODY-MARKER 注入为真实）', async () => {
    const planId = await makeResearchDonePlan()
    // 真实注入：把 marker 写进 research-content 工件正文（正控：若导出面意外含正文，
    // 该断言必被 marker 击穿；空测试不再存在）
    const MARKER = 'BODY-MARKER-7 完整正文泄漏哨兵'
    const art = await store.readResearchContent<{ body: string }>(planId, 'web:a', 'v1')
    expect(art).toBeDefined()
    await store.writeResearchContent(planId, 'web:a', 'v1', { ...art, body: `${art!.body}｜${MARKER}` })
    // 正控：marker 确实在工件里（注入非空转）
    const injected = await store.readResearchContent<{ body: string }>(planId, 'web:a', 'v1')
    expect(injected!.body).toContain(MARKER)

    // 提供 itinerary（buildRenderData 以 itinerary.json 为前置）
    await store.writeJson(planId, 'itinerary.json', {
      itineraryId: `itinerary-${planId}`,
      days: [{
        date: '2026-10-01',
        stops: [{ name: '西宁 攻略 A', category: 'attraction', coords: { lng: 101.8, lat: 36.6, sys: 'GCJ02' }, durationHint: 120, intelRefs: ['web:a'] }],
        meals: [],
      }],
      routeCheck: { issues: [], warnings: [] },
    })

    // 经真实装配路径组装页面数据（buildRenderData 只带分级，不读正文全文）
    const { data } = await buildRenderData(store, planId)
    expect(data).toBeDefined()
    const bundle = buildExportBundle(data!)
    expect(bundle.json).not.toContain(MARKER)
    expect(bundle.markdown).not.toContain(MARKER)
    // 导出含选定摘要 + 引用
    expect(bundle.markdown).toContain('来源')
    expect(bundle.json).toContain('web:a')
    // canonicalJson 同源（零全文）
    expect(canonicalJson(data!)).not.toContain(MARKER)
    expect(markdownOf(data!)).not.toContain(MARKER)
    // 页面内嵌数据同样零全文（分级徽标在，正文不在）
    const html = renderWithTemplate(data!, readFileSync(templatePath(), 'utf8'))
    expect(html).not.toContain(MARKER)
    expect(html).toContain('已取正文')
  })

  it('legacy 导出回归：旧计划（无研究视图）导出不强制重新研究、bundle 合法', () => {
    const data = minimalRenderData({})
    const bundle = buildExportBundle(data)
    expect(bundle.json.length).toBeGreaterThan(0)
    expect(bundle.markdown).toContain('## 总览')
    expect(bundle.markdown).toContain('## 来源')
  })
})