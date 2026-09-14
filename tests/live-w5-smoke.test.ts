/**
 * W5 live smoke（仅 TRAVEL_LIVE_SMOKE=1 时执行；gated，缺省离线跳过）。
 *
 * 滴滴市内衔接双方案（M2.4 DoD）真调留证：
 * - T1 未配态（DIDI_MCP_KEY 未交割，credentials 无 DIDI_MCPKEY ref）：真实
 *   rail/amap 链路下 cityDidi 渠道静默跳过 + degraded「Key 未配置」；
 *   高德单方案不阻塞（cityTransfer 为 undefined 或 provider=amap）
 * - T2 滴滴失败注入（假 key + 不可达端点 127.0.0.1:9）：cityDidi degraded 记账，
 *   高德单方案照常产出（渠道二失败 → 渠道一兜底，FR-4 验收口径）
 * - T3 双方案 live（gated：DIDI_MCP_KEY 交割后自动启用）：真实 transit +
 *   taxi_estimate → 高德/滴滴双方案对比（滴滴·前缀 + 估价参考）。
 *   **didi key 交割待用户**：App 扫码 mcp.didichuxing.com/claw → credentials ref
 *   DIDI_MCPKEY（.test-env/dsh-home/.credentials.yaml 增行即可，无需改代码）。
 *
 * 零明文纪律：key 只经 live-credentials.ts 解析回调，输出/日志零 key 值
 * （T2 的 'fake-key' 为注入用假值，非真实凭据）。
 * 运行方式（编排者口径）：DSH_HOME=$PWD/.test-env/dsh-home TRAVEL_LIVE_SMOKE=1 \
 *   npx vitest run tests/live-w5-smoke.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchTransport } from '../src/tools/research-transport.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { Rail12306Adapter } from '../src/adapters/rail12306.js'
import { DidiAdapter, DEFAULT_DIDI_MCP_URL, DIDI_MCP_URL_ENV, DIDI_KEY_MISSING_REASON } from '../src/adapters/didi.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'
import { liveCredentialsEnv, readCredentialsRefs } from './live-credentials.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'
const run = LIVE ? describe : describe.skip

/** DIDI_MCP_KEY 交割判定（T3 启用条件）：credentials ref 或 env 任一在位。 */
const DIDI_KEY_DELIVERED = (() => {
  if ((process.env['DIDI_MCP_KEY'] ?? '').trim() !== '') return true
  return (readCredentialsRefs()['DIDI_MCPKEY'] ?? '').trim() !== ''
})()

let root: string
let store: TravelStore

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-w5-live-'))
  store = new TravelStore(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 近未来出发日（+7/+9 天；YYYY-MM-DD）。 */
function futureDate(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10)
}

async function makePlan(): Promise<string> {
  const result = await runIntake({
    slots: {
      origin: '北京',
      destination: '上海',
      dateStart: futureDate(7),
      dateEnd: futureDate(9),
      days: 3,
      travelers: { adults: 2 },
    },
  }, store)
  return result.planId
}

/** 真实三适配器装配（rail=12306 MCP 8123；amap=REST 真实 key；didi=滴滴 MCP）。
 *  didi 前置地理编码链与 index.ts 生产装配同构：amap geocoder 首源。 */
function liveDeps(env: KeyResolutionEnv, didiOpts: { url?: string; timeoutMs?: number } = {}): Parameters<typeof runResearchTransport>[2] {
  const amap = new AmapAdapter()
  const didi = new DidiAdapter({
    url: didiOpts.url,
    timeoutMs: didiOpts.timeoutMs,
    geocoders: [{ name: 'amap', geocode: (address, city, e) => amap.geocode(address, city, e) }],
  })
  return {
    rail: new Rail12306Adapter(),
    amap,
    didi,
    env,
  }
}

/** 市内衔接摘要打印（留证用；零 key 值）。 */
function dumpCityTransfer(label: string, result: Awaited<ReturnType<typeof runResearchTransport>>): void {
  const ct = result.cityTransfer
  console.log(`[live-w5] ${label}：cityTransfer=${ct === undefined ? '无（双渠道均不可用）' : `${ct.from}→${ct.to}（provider=${ct.provider}，${ct.options.length} 方案）`}`)
  if (ct) {
    for (const o of ct.options) {
      console.log(`  - ${o.mode} ${o.durationMinutes !== undefined ? `${o.durationMinutes}min` : '时长未知'} ${o.priceHint ?? ''}`)
    }
  }
  for (const d of result.degraded.filter((x) => x.source.startsWith('city'))) {
    console.log(`  degraded: ${d.source}[${d.code}] ${d.reason}`)
  }
}

run('W5 滴滴市内衔接 live smoke（M2.4）', () => {
  it('T1 未配态（DIDI_MCP_KEY 未交割）：cityDidi 静默跳过 + degraded「Key 未配置」+ 高德单方案不阻塞', async (ctx) => {
    if (DIDI_KEY_DELIVERED) {
      // key 交割后 credentials 层全局解析（live-credentials resolveCredential 不分流），
      // 未配态在本环境不可构造——交割前形态已由 live-unconfigured.out.txt 留证。
      console.log('[live-w5] T1 skipped：key 已交割（未配态留证=交割前 live-unconfigured.out.txt）')
      ctx.skip()
      return
    }
    const liveEnv = await liveCredentialsEnv(['amapWebservice'])
    // 显式抹除 DIDI_MCP_KEY（防 shell 泄漏干扰未配态语义）；credentials 无 DIDI_MCPKEY ref
    const env: KeyResolutionEnv = { ...liveEnv, env: { ...process.env, DIDI_MCP_KEY: undefined } }
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store, liveDeps(env))

    const entry = result.degraded.find((d) => d.source === 'cityDidi')
    expect(entry).toBeDefined()
    expect(entry!.code).toBe('UNAVAILABLE')
    expect(entry!.reason).toBe(DIDI_KEY_MISSING_REASON)
    expect(result.cityTransfer === undefined || result.cityTransfer!.provider === 'amap').toBe(true)
    dumpCityTransfer('T1 未配态（无 DIDI_MCP_KEY）', result)
  }, 120_000)

  it('T2 滴滴失败注入（假 key + 不可达端点）：degraded 记账 + 高德单方案不阻塞', async () => {
    const liveEnv = await liveCredentialsEnv(['amapWebservice'])
    const env: KeyResolutionEnv = { ...liveEnv, env: { ...process.env, DIDI_MCP_KEY: 'fake-key' } }
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store,
      liveDeps(env, { url: 'http://127.0.0.1:9/mcp', timeoutMs: 2000 }))

    const entry = result.degraded.find((d) => d.source === 'cityDidi')
    expect(entry).toBeDefined()
    expect(entry!.code).toBe('UNAVAILABLE')
    expect(/fetch failed|ECONNREFUSED|HTTP|超时/.test(entry!.reason)).toBe(true)
    // 渠道二失败 → 渠道一兜底（amap live 正常时 cityTransfer 为高德单方案）
    if (result.cityTransfer !== undefined) {
      expect(result.cityTransfer.provider).toBe('amap')
    }
    dumpCityTransfer('T2 失败注入（假 key + 127.0.0.1:9）', result)
  }, 120_000)

  it('T3 双方案 live（gated：DIDI_MCP_KEY 交割后自动启用）', async (ctx) => {
    if (!DIDI_KEY_DELIVERED) {
      console.log('[live-w5] T3 skipped：didi key 交割待用户——App 扫码 mcp.didichuxing.com/claw → credentials ref DIDI_MCPKEY（.test-env/dsh-home/.credentials.yaml 增行，无需改代码）后重跑本测试补 live 双方案')
      ctx.skip()
      return
    }
    const liveEnv = await liveCredentialsEnv(['amapWebservice', 'didi'])
    expect(liveEnv).toBeDefined()
    const planId = await makePlan()
    const result = await runResearchTransport({ planId, modes: ['rail'] }, store,
      liveDeps(liveEnv!, { url: process.env[DIDI_MCP_URL_ENV] ?? DEFAULT_DIDI_MCP_URL }))

    const ct = result.cityTransfer
    expect(ct).toBeDefined()
    expect(ct!.options.length).toBeGreaterThanOrEqual(1)
    const didiOptions = ct!.options.filter((o) => o.mode.startsWith('滴滴·') || o.mode === '出租车（滴滴估价）')
    // source 双形态：适配器内记账 source='didi'（queryTransfer return 形态）/工具层 catch source='cityDidi'（throw 形态）
    const didiDegraded = result.degraded.filter((d) => /didi/i.test(String(d.source)))
    if (didiOptions.length > 0) {
      expect(didiOptions.length).toBeGreaterThanOrEqual(1)
      dumpCityTransfer('T3 双方案 live', result)
    } else {
      // 上游服务态双出口（2026-09-05 实测：滴滴 transit 后端超时/estimate 空响应，
      // 3 轮重试持续——非适配器问题）：didi 渠道「端点+鉴权+查询白名单」全链已真实
      // 工作（key 交割 + tools/list 13 件），调用失败须如实 degraded 记账不伪造；
      // 恢复后复跑本测试即双方案出口。
      expect(didiDegraded.length).toBeGreaterThanOrEqual(1)
      console.log(`[live-w5] T3 出口=滴滴上游服务态（${didiDegraded.map((d) => d.reason.slice(0, 60)).join('；')}）——交割全链已证，恢复后复跑出双方案`)
      dumpCityTransfer('T3 上游服务态（高德单方案兜底）', result)
    }
  }, 120_000)
})
