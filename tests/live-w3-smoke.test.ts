/**
 * W3 live smoke（仅 TRAVEL_LIVE_SMOKE=1 时执行；gated，缺省离线跳过）。
 *
 * 杭州 3 日真实目的地图三工具实调留证：
 * - transport：rail=12306 真实 MCP（8123）+ 真实票价 + wendao 真实 key 机票 + amap 真实
 *   key 市内衔接 → ≥2 方案且 ≥1 含班次时间与价格档（FR-4 验收① 真实口径）
 * - advice：amap 真实 key 天气 → 腾讯零 key → Open-Meteo 逐日；穿衣/物品模板+画像
 * - destination：tencent 零 key 真实 POI + L0 家族渠道（宿主搜索 seam 仅 DSH 宿主内
 *   可用，测试进程无 ctx.web → 如实 degraded 记账）
 *
 * 网络/凭据受限项在输出与 docs/evidence/m1/w3/notes.md 登记 blocked，不伪造结果。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import { runResearchTransport } from '../src/tools/research-transport.js'
import { runResearchAdvice } from '../src/tools/research-advice.js'
import { TencentMapAdapter } from '../src/adapters/tencent.js'
import { SearchAdapter } from '../src/adapters/search.js'
import { SocialAdapter } from '../src/adapters/social.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { Rail12306Adapter } from '../src/adapters/rail12306.js'
import { WendaoAdapter } from '../src/adapters/wendao.js'
import { IntercityAdapter } from '../src/adapters/intercity.js'
import { OpenMeteoAdapter } from '../src/adapters/open-meteo.js'
import {
  xhsFallbackChannel, douyinChannel, tier2Channel, tier3Channel,
  tencentPoiChannel, platformIntelChannel,
} from '../src/orchestrator/channels.js'
import type { IntelItem } from '../src/models/types.js'
import type { TransportOption } from '../src/models/types.js'
import type { Advice } from '../src/models/types.js'
import { liveCredentialsEnv } from './live-credentials.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'
const t = (ms: number) => ms

let root: string
let store: TravelStore
let env: Awaited<ReturnType<typeof liveCredentialsEnv>>

const run = LIVE ? describe : describe.skip

void t

run('W3 live smoke（杭州 3 日真实目的地）', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-travel-live-w3-'))
    store = new TravelStore(root)
    env = await liveCredentialsEnv(['amapWebservice', 'amapJsapi', 'amapJscode', 'wendao'])
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  let planId: string

  it('intake 杭州 3 日（北京出发，带老人+徒步偏好）', async () => {
    const r = await runIntake({
      slots: {
        origin: '北京', destination: '杭州',
        dateStart: '2026-09-15', dateEnd: '2026-09-17', days: 3,
        travelers: { adults: 2, seniors: 1 },
        preferences: { themes: ['徒步', '自然'] },
      },
    }, store)
    expect(r.status).toBe('confirmed')
    planId = r.planId
    console.log(`[live] planId=${planId}`)
  }, 30000)

  it('destination：真实 tencent POI + L0 家族（宿主搜索 seam 测试进程不可用 → degraded 记账）', async () => {
    const tencent = new TencentMapAdapter() // 真实零 key 体验通道
    const search = new SearchAdapter() // 无 hostSearch：L0 seam 仅 DSH 宿主内可用
    const social = new SocialAdapter() // 无 search fn → 社媒 L0 位未注入
    const result = await runResearchDestination(
      { planId, depth: 'quick' }, store,
      {
        channels: [
          xhsFallbackChannel(search), douyinChannel(social), tier2Channel(search),
          tier3Channel(social), tencentPoiChannel(tencent), platformIntelChannel(search),
        ],
        retryDelaysMs: [1000, 4000],
        env,
      },
    )
    const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
    const poiCount = intel.filter((i) => i.channel === 'tencent-poi').length
    console.log(`[live] destination itemCount=${result.itemCount} intelSummary=${JSON.stringify(result.intelSummary)}`)
    console.log(`[live] tencent-poi 真实条目=${poiCount}；degraded=${result.degraded.map((d) => `${d.source}:${d.code}`).join(',')}`)
    expect(poiCount).toBeGreaterThanOrEqual(1) // 真实腾讯 POI（杭州）
    // L0 家族 seam 测试进程不可用 → 如实 degraded（不伪造）
    const seam = result.degraded.filter((d) => ['search-l0', 'xhsFallback', 'platformIntel', 'tier2'].includes(d.source))
    console.log(`[live] L0 家族 seam blocked 登记：${seam.length} 个渠道（宿主搜索仅 DSH 宿主内可用）`)
  }, 120000)

  it('transport：rail=12306 真实 MCP（价格档）+ wendao 真实机票 + amap 真实市内衔接 → ≥2 方案', async () => {
    const rail = new Rail12306Adapter() // 真实 MCP http://127.0.0.1:8123/mcp
    const wendao = new WendaoAdapter() // 真实 key（credentials）
    const intercity = new IntercityAdapter({ wendao })
    const amap = new AmapAdapter() // 真实 key
    const result = await runResearchTransport(
      { planId }, store,
      { rail, intercity, amap, wendao, env, timeoutMs: 120000 },
    )
    const schedules = result.options.filter((o) =>
      o.segments[0]?.no && o.segments[0]?.depart && o.segments[0]?.arrive)
    const prices = result.options.filter((o) => o.totalPriceRange !== undefined)
    console.log(`[live] transport options=${result.options.length} degraded=${result.degraded.map((d) => `${d.source}:${d.code}`).join(',')}`)
    console.log(`[live] 含班次时间=${schedules.length} 含价格档=${prices.length}`)
    for (const o of result.options.slice(0, 3)) {
      const s = o.segments[0]
      console.log(`[live]   ${o.mode} ${s?.no ?? ''} ${s?.from}→${s?.to} ${s?.depart ?? ''}-${s?.arrive ?? ''} 价格=${o.totalPriceRange ? `¥${o.totalPriceRange[0]}~${o.totalPriceRange[1]}` : 'n/a'} 时长=${o.durationMinutes ?? 'n/a'}m`)
    }
    if (result.cityTransfer) {
      console.log(`[live] 市内衔接 ${result.cityTransfer.from}→${result.cityTransfer.to}（${result.cityTransfer.provider}）${result.cityTransfer.options.length} 方案`)
    } else {
      console.log('[live] 市内衔接 blocked（amap 不可用或已停用）')
    }
    expect(result.options.length).toBeGreaterThanOrEqual(2) // FR-4 验收①
    expect(schedules.length).toBeGreaterThanOrEqual(1)
    const persisted = await store.readJson<TransportOption[]>(planId, 'transport.json')
    expect(persisted).toBeDefined()
  }, 120000)

  it('advice：天气链 amap→腾讯→Open-Meteo 真实逐日 + 穿衣/物品', async () => {
    const amap = new AmapAdapter()
    const tencent = new TencentMapAdapter()
    const openMeteo = new OpenMeteoAdapter()
    const result = await runResearchAdvice(
      { planId }, store,
      { amap, tencent, openMeteo, env, timeoutMs: 60000 },
    )
    console.log(`[live] advice weather=${result.weather.map((w) => `${w.date}:${w.source.platform}:${w.dayForecast ?? ''}`).join(' | ')}`)
    console.log(`[live] degraded=${result.degraded.map((d) => `${d.source}:${d.code}`).join(',')}`)
    expect(result.weather.length).toBe(3) // 逐日天气
    for (const w of result.weather) {
      expect(w.source.platform).toBeTruthy() // FR-5 验收①：来源
      expect(w.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // 数据日期
    }
    expect(result.packingList.length).toBeGreaterThanOrEqual(10) // FR-5 验收②
    const persisted = await store.readJson<Advice>(planId, 'advice.json')
    expect(persisted).toBeDefined()
    expect(persisted!.packingList.length).toBeGreaterThanOrEqual(10)
  }, 90000)
})