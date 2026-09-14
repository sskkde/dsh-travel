/**
 * B3 P0-C 检索恢复 · P1-4 西段覆盖 live 冒烟（仅 TRAVEL_LIVE_SMOKE=1 执行；gated）。
 *
 * 验收断言（implementation-batches §补漏 P1-4）：
 *   对青甘环线西段（敦煌/张掖/祁连）区域关键词跑 R2 → 增量>0 且 attraction/lodging 有覆盖。
 *
 * 运行口径（与 B2 live 同纪律）：
 * - 3081 实例装载新代码（link 指向工作区，npm run build 后 restart）→ boot PASS；
 * - 进程内真实网络冒烟：真实腾讯 POI（零 key 体验通道）+ 真实 L0 家族适配器；
 *   宿主搜索 seam（ctx.web.search）仅 DSH 宿主内可用，测试进程无 ctx.web →
 *   如实 degraded 记账（live-w3 同款标注），不伪造；
 * - GUI 会话内全链（含宿主搜索）驱动按 B2 先例 BLOCKED 登记，不冒充 PASS。
 *
 * R1/R2 真实执行：destination=敦煌（西段锚点，腾讯 region 可解析），
 * R1 keywords=[]（baseline），R2 keywords=['张掖','祁连']（区域增量词）。
 * 断言：R2 round 存在、增量 >0、新条目覆盖 attraction 与 lodging。
 * 若真实网络/API无法满足 → 输出如实证据 + BLOCKED，不伪造 PASS。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { TencentMapAdapter } from '../src/adapters/tencent.js'
import { SearchAdapter } from '../src/adapters/search.js'
import { SocialAdapter } from '../src/adapters/social.js'
import {
  xhsFallbackChannel, douyinChannel, tier2Channel, tier3Channel,
  tencentPoiChannel, platformIntelChannel,
} from '../src/orchestrator/channels.js'
import type { IntelItem } from '../src/models/types.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'
const run = LIVE ? describe : describe.skip

let root: string
let store: TravelStore

run('B3 P1-4 西段覆盖 live 冒烟（敦煌 R1 → 张掖/祁连 R2）', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-travel-live-b3-'))
    store = new TravelStore(root)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  let planId: string

  it('intake：destination=敦煌（西段锚点）', async () => {
    const r = await runIntake({
      slots: {
        destination: '敦煌',
        dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      },
    }, store)
    expect(r.status).toBe('confirmed')
    planId = r.planId
    console.log(`[live-b3] planId=${planId}`)
  }, 30000)

  it('R1（无区域词，baseline）→ R2（区域词 张掖/祁连）→ 增量>0 且 attraction/lodging 覆盖', async () => {
    const tencent = new TencentMapAdapter() // 真实零 key 体验通道
    const search = new SearchAdapter() // 无 hostSearch：宿主 seam 测试进程不可用
    const social = new SocialAdapter()
    const channels = [
      xhsFallbackChannel(search), douyinChannel(social), tier2Channel(search),
      tier3Channel(social), tencentPoiChannel(tencent), platformIntelChannel(search),
    ]

    // R1：baseline（无区域词）
    const r1 = await runResearchDestination(
      { planId, depth: 'quick' }, store,
      { channels, retryDelaysMs: [1000, 4000] },
    )
    const intel1 = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    console.log(`[live-b3] R1 itemCount=${r1.itemCount} intel=${intel1.length} degraded=${r1.degraded.map((d) => `${d.source}:${d.code}`).join(',')}`)

    // R2：区域词 张掖/祁连（T8 keywords 真入串；T10 短引号短语）
    const r2 = await runResearchDestination(
      { planId, depth: 'quick', keywords: ['张掖', '祁连'] }, store,
      { channels, retryDelaysMs: [1000, 4000] },
    )
    const intel2 = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    const newIds = (r2.round as { newItemIds?: string[] }).newItemIds ?? []
    console.log(`[live-b3] R2 round=${r2.round !== undefined} query.keywords=${JSON.stringify((r2.round as { query?: { keywords?: string[] } }).query?.keywords)}`)
    console.log(`[live-b3] R2 rawItemCount=${r2.itemCount} intel=${intel2.length} newItemIds=${newIds.length}`)
    console.log(`[live-b3] R2 新条目=${newIds.join(',') || '（无）'}`)
    const r2Observations = r2.round?.channels.flatMap((entry) => entry.observations ?? []) ?? []
    console.log(`[live-b3] R2 provenance样例=${r2Observations.slice(0, 3).map((observation) => observation.provenanceKey).join(',') || '（无）'}`)
    expect(r2.round).toBeDefined()
    expect(r2Observations.every((observation) => observation.provenanceKey
      === `${r2.round!.roundId}:${observation.channel}:${observation.contentId}`)).toBe(true)
    const newItems = intel2.filter((i) => newIds.includes(i.id))
    const cats = new Set(newItems.map((i) => i.category))
    console.log(`[live-b3] R2 新条目类别=${[...cats].join(',')}`)
    console.log(`[live-b3] R2 新条目来源=${[...new Set(newItems.map((i) => i.channel))].join(',')}`)
    for (const i of newItems.slice(0, 6)) {
      console.log(`[live-b3]   ${i.channel}/${i.category} ${i.title}`)
    }

    // P1-4 断言：增量>0 且 attraction/lodging 有覆盖
    expect(newIds.length).toBeGreaterThan(0)
    expect(cats.has('attraction')).toBe(true)
    expect(cats.has('lodging')).toBe(true)
  }, 180000)
})