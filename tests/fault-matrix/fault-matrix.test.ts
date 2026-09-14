/**
 * 全渠道故障矩阵 runner（M3.6 / W6；m3-execution-plan T7、roadmap M3.6、NFR-2）。
 *
 * 形态：
 * - **严格串行**（无 describe.concurrent；vitest 同文件顺序执行）——评测与矩阵
 *   禁止并发改凭据/伴随服务（Must-Not-Have）；所有注入为进程内 mock（见
 *   injectors.ts/harness.ts 安全纪律），零真实服务停起、零凭据写、零
 *   process.env 改写；
 * - 每行（tests/fault-matrix/manifest.ts 派生的 28 channel rows）× applicable
 *   故障类逐一执行；不适用行由 manifest 诚实登记 notApplicableFaults；
 * - 固定成功定义：无裸异常 + degraded 含 source/code + 不生成空 artifact +
 *   fallback/人工渠道兑现（controlled-empty 返回人话原因与重试入口）；
 * - 分母只含 applicable fault cases；「全渠道空 contract」单独断言不混入比率；
 * - CloakBrowser 行：无 license → off/not-applicable 登记（不执行注入）；
 * - Didi 行：上游服务态故障（transit 无 result）与代码故障分离记录（service-state
 *   不算代码失败、不入比率分母）；
 * - 恢复 guard：进程 env 指纹前后一致 + 伴随服务基线（12306/xhs/playwright/
 *   test-env）只读探活前后一致（W5 lifecycle probeHealthOnce 同判定路径）；
 * - 报告落盘 docs/evidence/m3/w6/fault-matrix.{json,md}；运行中断时 .incomplete
 *   标记保留（finally 复原 + incomplete 语义）。
 *
 * 重跑：`npx vitest run tests/fault-matrix/`（失败行修复后可按报告中 rerun 命令
 * 局部重跑，最终全跑）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EngineError, ENGINE_ERROR_CODES, type DegradedEntry } from '../../src/adapters/base.js'
import { TravelStore } from '../../src/store/store.js'
import { runIntake } from '../../src/tools/intake.js'
import { runBuildItinerary } from '../../src/tools/build-itinerary.js'
import { runRenderPage } from '../../src/tools/render-page.js'
import { runResearchAdvice } from '../../src/tools/research-advice.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'
import { ALL_INTEL_CATEGORIES } from '../../src/orchestrator/types.js'
import type { IntelItem } from '../../src/models/types.js'
import {
  FAULT_MATRIX_ROWS, GROUP_PRIMARY_CHANNELS, cloakLicensePresent, rowsByGroup,
  type FaultKind,
} from './manifest.js'
import {
  diffBaselines, envFingerprint, probeAllBaselines,
  type FaultCaseResult, type ServiceProbeResult,
} from './injectors.js'
import {
  RENDER_FR7_OFF, ROW_DEGRADED_SOURCES,
  adviceDeps, adviceDepsAllDown,
  buildDeps, buildDepsAllDown,
  destinationDeps, destinationDepsAllDown,
  fakeRegistrar, renderEnv, tencentTravelGuideFaulted,
  transportDeps, transportDepsAllDown, transportDepsDidiServiceState,
} from './harness.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EVID_DIR = join(REPO_ROOT, 'docs', 'evidence', 'm3', 'w6')
const RERUN_CMD = 'npx vitest run tests/fault-matrix/'
const RATE_THRESHOLD = 0.95

// ────────────────────────── 运行期记账 ──────────────────────────

/** applicable fault cases（比率分子/分母面；含 FR 组「全部主渠道失败」演练）。 */
const results: FaultCaseResult[] = []
/** Didi 上游服务态 case（与代码故障分离；不入比率分母）。 */
const didiServiceStateCases: FaultCaseResult[] = []
/** 全渠道空 contract（§9.3-6 不产空产物；单列不入比率）。 */
const allEmptyContract: Array<{ scenario: string; pass: boolean; evidence: string }> = []

let envFpBefore = ''
let envFpAfter = ''
let baselineBefore: ServiceProbeResult[] = []
let baselineAfter: ServiceProbeResult[] = []
const startedAt = new Date().toISOString()

beforeAll(async () => {
  envFpBefore = envFingerprint()
  baselineBefore = await probeAllBaselines()
  // 运行中断标记：runner 正常收口（afterAll）时移除；中断残留 → incomplete 语义
  mkdirSync(EVID_DIR, { recursive: true })
  writeFileSync(join(EVID_DIR, '.incomplete'), JSON.stringify({ startedAt, note: 'runner 中断残留标记（正常完成时移除）' }))
})

// ────────────────────────── 通用 harness ──────────────────────────

/** 单 case 执行：断言失败/裸异常 → 记 fail（并让 it 红），成功 → 记 pass+证据。 */
async function executeCase(
  rowId: string, group: string, kind: FaultKind, scope: FaultCaseResult['scope'], fn: () => Promise<string>,
): Promise<void> {
  const t0 = Date.now()
  try {
    const evidence = await fn()
    results.push({ rowId, group: group as never, kind, scope, status: 'pass', evidence, rerun: RERUN_CMD, durationMs: Date.now() - t0 })
  } catch (error) {
    const rootCause = error instanceof Error ? error.message : String(error)
    results.push({ rowId, group: group as never, kind, scope, status: 'fail', evidence: '', rootCause, rerun: RERUN_CMD, durationMs: Date.now() - t0 })
  }
}

/** 断言刚执行完的 case 通过（失败时把根因带进断言消息）。 */
function expectCasePass(rowId: string, kind: FaultKind): void {
  const hit = results.find((r) => r.rowId === rowId && r.kind === kind)
  expect(hit, `case 未执行：${rowId}/${kind}`).toBeDefined()
  expect(hit?.status === 'pass', `${rowId}/${kind} ${hit?.status === 'fail' ? `失败：${hit.rootCause ?? ''}` : ''}`).toBe(true)
}

/** 每个 case 独立 tmpdir store（串行；finally 清理零残留）。 */
async function withStore<T>(fn: (store: TravelStore) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fault-matrix-'))
  const store = new TravelStore(root)
  try {
    return await fn(store)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function intakePlan(store: TravelStore): Promise<string> {
  const intake = await runIntake({
    slots: {
      origin: '北京', destination: '上海',
      dateStart: '2026-09-04', dateEnd: '2026-09-06', days: 3,
      travelers: { adults: 2, seniors: 1 },
    },
  }, store)
  // F1c-E（决策 5）：destination-only 新 plan 自动 flowVersion → 完整链受门。矩阵是
  // 渠道级故障注入 harness（通道降级/互备/记账），非门测试——按保留的 legacy 轻量
  // 路径（SKILL §3）模拟真正 legacy（无 flowVersion 信封），使故障行照常演练渠道逻辑。
  const req = await store.loadRequest(intake.planId)
  await store.saveRequest({ ...req!, flowVersion: undefined })
  return intake.planId
}

/** 构建链前置 intel（build/render 用；推进状态机至 researching 位）。 */
async function seedIntel(store: TravelStore, planId: string): Promise<void> {
  const items: IntelItem[] = [
    matrixIntel('m1', 'attraction', '外滩', 121.490, 31.240),
    matrixIntel('m2', 'attraction', '豫园', 121.492, 31.227),
    matrixIntel('m3', 'food', '城隍庙小吃', 121.489, 31.226),
    matrixIntel('m4', 'lodging', '人民广场酒店', 121.475, 31.232),
  ]
  await store.writeJson(planId, 'intel.json', items)
  const request = await store.loadRequest(planId)
  if (request !== undefined) {
    await store.saveRequest({ ...request, status: 'researching', updatedAt: new Date().toISOString() })
  }
}

function matrixIntel(id: string, category: IntelItem['category'], title: string, lng: number, lat: number): IntelItem {
  return {
    id,
    category,
    channel: 'tencent-poi',
    title,
    summary: `${title}（矩阵 fixture）`,
    source: { platform: 'tencent-map', url: `https://example.invalid/${id}`, fetchedAt: '2026-09-04T00:00:00.000Z' },
    coords: { lng, lat, sys: 'GCJ02' },
    confidence: 'high',
  }
}

/** degraded 记账查找（行 → source 名单 + EngineError code 合法性）。 */
function findDegraded(degraded: readonly DegradedEntry[], rowId: string): DegradedEntry {
  const sources = ROW_DEGRADED_SOURCES[rowId] ?? [rowId]
  const hit = degraded.find((d) => sources.includes(d.source))
  if (hit === undefined) {
    throw new Error(`degraded 缺 ${sources.join('/')} 记账（实际：${JSON.stringify(degraded.map((d) => `${d.source}[${d.code}]`))}）`)
  }
  if (!ENGINE_ERROR_CODES.includes(hit.code)) {
    throw new Error(`degraded code 非法：${hit.code}`)
  }
  return hit
}

// ────────────────────────── FR-3：travel_research_destination ──────────────────────────

async function destinationCase(row: string, kind: FaultKind): Promise<string> {
  return withStore(async (store) => {
    const planId = await intakePlan(store)
    const result = await runResearchDestination({ planId, categories: [...ALL_INTEL_CATEGORIES] }, store, destinationDeps({ row, kind }))
    // xhsMcp 限流熔断的特殊语义：RateLimitExceededError → 渠道内 ④自动降级
    // （xhsFallback L0+L0.5 承接，首条标注降级原因）→ 渠道以成功态返回，
    // degraded 无 xhsMcp 记账——降级证据在标注条目上（design §5.6/channels.ts ④）。
    const hit = (() => {
      try {
        return findDegraded(result.degraded, row)
      } catch (error) {
        if (row === 'xhsMcp') return undefined // 走下方自动降级标注断言
        throw error
      }
    })()
    let fallbackNote = ''
    if (hit === undefined) {
      const intel = (await store.readJson<IntelItem[]>(planId, 'intel.json')) ?? []
      const degradedItem = intel.find((i) => i.channel === 'xhs-l0' && i.summary.includes('登录态检索失败已自动降级'))
      if (degradedItem === undefined) {
        throw new Error(`xhsMcp 限流熔断后既无 degraded 记账也无 ④自动降级标注条目（degraded=${JSON.stringify(result.degraded)}）`)
      }
      fallbackNote = `限流熔断（RateLimitExceededError）→ ④自动降级 xhsFallback 承接（标注：「${degradedItem.summary.split('\n').find((l) => l.includes('自动降级'))?.slice(0, 60)}…」）`
    }
    if (result.itemCount <= 0) {
      throw new Error(`单行故障下其余渠道应仍产出（itemCount=${result.itemCount}）——降级链未兑现「流程不中断」`)
    }
    const intel = await store.readJson<IntelItem[]>(planId, 'intel.json')
    if (intel === undefined || intel.length === 0) {
      throw new Error('itemCount>0 但 intel.json 未落盘/为空（空 artifact 契约矛盾）')
    }
    const degradedNote = hit !== undefined ? `degraded=${hit.source}[${hit.code}]「${hit.reason.slice(0, 80)}」` : fallbackNote
    return `${degradedNote}；其余渠道条目=${result.itemCount}`
  })
}

// ────────────────────────── FR-4：travel_research_transport ──────────────────────────

async function transportCase(row: string, kind: FaultKind): Promise<string> {
  return withStore(async (store) => {
    const planId = await intakePlan(store)
    const result = await runResearchTransport({ planId }, store, transportDeps({ row, kind }))
    // 链位语义（manifest note）：flyai 段的 missing-key（零 key 试用档）照常成功——
    // 行降级记账落在上游 wendao 段（Key 未配置休眠），不要求 flyai 自身 degraded
    const flyaiMissingKey = (row === 'railFlyai' || row === 'flightFlyai') && kind === 'missing-key'
    const hit = flyaiMissingKey
      ? findDegraded(result.degraded, 'railWendao') // wendao 段休眠记账（链上游）
      : findDegraded(result.degraded, row)
    if (result.options.length <= 0) {
      throw new Error(`单行故障下其余渠道应仍产出（options=${result.options.length}）——降级链未兑现`)
    }
    const notes: string[] = [`degraded=${hit.source}[${hit.code}]「${hit.reason.slice(0, 80)}」`, `options=${result.options.length}`]
    // fallback 兑现断言（design §2.1 FR-4 渠道间互备）
    if (row === 'rail12306') {
      if (!result.options.some((o) => o.mode === 'rail')) throw new Error('rail12306 故障后互备链未产出 rail 方案')
      notes.push('rail 方案由互备链产出')
    }
    if (row === 'cityAmap') {
      if (result.cityTransfer?.provider !== 'didi') throw new Error(`cityAmap 故障后渠道二未接管（provider=${result.cityTransfer?.provider ?? '无'}）`)
      notes.push('cityTransfer 接管=didi')
    }
    if (row === 'cityDidi') {
      if (result.cityTransfer?.provider !== 'amap') throw new Error(`cityDidi 故障后渠道一未接管（provider=${result.cityTransfer?.provider ?? '无'}）`)
      notes.push('cityTransfer 接管=amap')
    }
    if ((row === 'railFlyai' || row === 'flightFlyai')) {
      if (!result.degraded.some((d) => d.source === 'intercity/wendao')) {
        throw new Error('flyai 段 case 缺上游 wendao 链位记账（链语义）')
      }
      const wantedMode = row === 'railFlyai' ? 'rail' : 'flight'
      if (kind === 'missing-key' && !result.options.some((o) => o.mode === wantedMode)) {
        throw new Error(`缺 key 时 flyai 零 key 试用档应照常产出 ${wantedMode} 方案（设计语义）`)
      }
      notes.push(`flyai 链位（上游 wendao 同故障；missing-key=零 key 试用档照常）`)
    }
    const transport = await store.readJson<unknown[]>(planId, 'transport.json')
    if (transport === undefined || transport.length === 0) throw new Error('transport.json 未落盘/为空')
    return notes.join('；')
  })
}

// ────────────────────────── FR-5：travel_research_advice ──────────────────────────

async function adviceCase(row: string, kind: FaultKind): Promise<string> {
  return withStore(async (store) => {
    const planId = await intakePlan(store)
    const result = await runResearchAdvice({ planId }, store, adviceDeps({ row, kind }))
    const hit = findDegraded(result.degraded, row)
    if (result.weather.length !== 3) throw new Error(`逐日天气应完整 3 天（实际 ${result.weather.length}——缺位日须有气候概况条目）`)
    if (result.packingList.length < 10) throw new Error(`物品清单应 ≥10 项（实际 ${result.packingList.length}）`)
    const advice = await store.readJson<unknown>(planId, 'advice.json')
    if (advice === undefined) throw new Error('advice.json 未落盘（§9.3-6 契约：天气降级不阻塞建议产出）')
    return `degraded=${hit.source}[${hit.code}]「${hit.reason.slice(0, 80)}」；weather=3 日 packing=${result.packingList.length}`
  })
}

// ────────────────────────── FR-6：travel_build_itinerary ──────────────────────────

async function buildCase(row: string, kind: FaultKind): Promise<string> {
  return withStore(async (store) => {
    const planId = await intakePlan(store)
    await seedIntel(store, planId)
    const result = await runBuildItinerary({ planId }, store, buildDeps({ row, kind }))
    if (!result.built) throw new Error(`单行故障下 build 仍应产出（built=false：${result.reason ?? ''}）`)
    const warningText = result.routeCheck.warnings.join('；')
    const tag = row === 'routeCheckAmap' ? 'amap' : 'tencent'
    const degradedHit = result.routeCheck.warnings.some((w) => w.includes(`动线渠道降级（${tag}）`))
    if (!degradedHit) {
      throw new Error(`routeCheck.warnings 缺 ${tag} 渠道降级记账（实际：${warningText.slice(0, 200)}）`)
    }
    const itinerary = await store.readJson<{ routeCheck: { warnings: string[] } }>(planId, 'itinerary.json')
    if (itinerary === undefined) throw new Error('itinerary.json 未落盘')
    return `warnings 含「动线渠道降级（${tag}）」；days=${result.days.length}`
  })
}

/** travelGuideTencent：适配器面演练（设计=可选素材位，tools 未消费）。 */
async function travelGuideAdapterCase(mode: 'throw' | 'no-plan'): Promise<string> {
  const adapter = tencentTravelGuideFaulted(mode)
  let caught: unknown
  try {
    await adapter.travelGuide({ text: '上海 3 日行程（矩阵演练）' })
  } catch (error) {
    caught = error
  }
  if (!(caught instanceof EngineError)) {
    throw new Error(`travel_guide 故障未按 EngineError 归一化（实际：${String(caught)}）`)
  }
  if (!ENGINE_ERROR_CODES.includes(caught.code)) throw new Error(`EngineError code 非法：${caught.code}`)
  return `EngineError ${caught.code}「${caught.message.slice(0, 80)}」（无裸异常；可选素材位缺失不阻塞 build）`
}

// ────────────────────────── FR-7：travel_render_page ──────────────────────────

/** 渲染链前置（intake→intel→build，status=generating）。 */
async function renderReadyPlan(store: TravelStore): Promise<string> {
  const planId = await intakePlan(store)
  await seedIntel(store, planId)
  const built = await runBuildItinerary({ planId }, store, buildDeps())
  if (!built.built) throw new Error(`渲染前置 build 失败：${built.reason ?? ''}`)
  return planId
}

async function renderCase(row: string, kind: FaultKind): Promise<string> {
  return withStore(async (store) => {
    const planId = await renderReadyPlan(store)
    let registrar = fakeRegistrar()
    let env = renderEnv()
    let mapProvider: 'auto' | 'leaflet' = 'auto'
    let chmodGuard = false
    if (row === 'mapAmap') env = renderEnv({}) // missing-key（off 形态同源 env 面）
    if (row === 'mapLeaflet') { env = renderEnv({ off: ['mapLeaflet'], amapReady: true }); mapProvider = 'leaflet' }
    if (row === 'deliveryRoute') registrar = fakeRegistrar({ throwOnRegister: true })
    const planDir = store.planDir(planId)
    try {
      if (row === 'deliveryFile') {
        // service-down 注入：计划目录只读（runner 自有 tmpdir 内真实 fs 面）
        chmodSync(planDir, 0o500)
        chmodGuard = true
      }
      const result = await runRenderPage({ planId, mapProvider }, store, registrar, env)

      if (row === 'mapAmap') {
        if (result.mapProviderUsed !== 'leaflet') throw new Error(`缺 key 未降级 Leaflet（provider=${result.mapProviderUsed}）`)
        if (!result.warnings.some((w) => w.includes('key 未配置'))) {
          throw new Error(`缺「key 未配置」降级 warning（实际：${result.warnings.join('；')}）`)
        }
        if (!result.rendered || result.filePath === '') throw new Error('渲染应成功（Leaflet 兜底必有页面产出）')
        return `warnings 含「key 未配置」；provider=leaflet；本地文件+路由双交付（routes=${registrar.registeredPaths.length}）`
      }
      if (row === 'mapLeaflet') {
        if (result.mapProviderUsed !== 'amap') throw new Error(`mapLeaflet off + amap 就绪应改用 amap（provider=${result.mapProviderUsed}）`)
        if (!result.warnings.some((w) => w.includes('mapLeaflet 已停用（用户配置）'))) {
          throw new Error(`缺「mapLeaflet 已停用」warning（实际：${result.warnings.join('；')}）`)
        }
        if (!result.rendered) throw new Error('渲染应成功')
        return `warnings 含「mapLeaflet 已停用（用户配置）」；provider=amap（off 语义双向降级兑现）`
      }
      if (row === 'deliveryRoute') {
        if (!result.rendered || result.filePath === '') throw new Error('路由注册失败后本地文件交付应仍可用（design §2.1 FR-7 降级链）')
        if (!result.warnings.some((w) => w.includes('在线路由注册失败'))) {
          throw new Error(`缺「在线路由注册失败」记账 warning（实际：${result.warnings.join('；')}）`)
        }
        if (registrar.registeredPaths.length !== 0) throw new Error('注入的 registrar 不应成功注册')
        return `warnings 含「在线路由注册失败…本地文件交付仍可用」；filePath 非空（url 通道降级）`
      }
      if (row === 'deliveryFile') {
        if (result.rendered) throw new Error('写盘失败时应返回结构化失败（rendered=false）')
        if (!result.warnings.some((w) => w.includes('页面写盘失败'))) {
          throw new Error(`缺「页面写盘失败」人话原因（实际：${result.warnings.join('；')}）`)
        }
        if (!result.warnings.some((w) => w.includes('重试'))) throw new Error('写盘失败缺重试入口提示（§9.3-6）')
        return `rendered=false + 人话原因 + 重试入口（双通道均败的 §9.3-6 出口）`
      }
      throw new Error(`未实现的 render 行：${row}`)
    } finally {
      if (chmodGuard) chmodSync(planDir, 0o700) // 恢复权限（finally 复原纪律）
    }
  })
}

// ────────────────────────── 主矩阵（28 行 × applicable fault kinds，严格串行） ──────────────────────────

describe('全渠道故障矩阵（M3.6）：单行 × 单类注入 → 降级链产出、流程不中断', () => {
  for (const group of ['fr3', 'fr4', 'fr5', 'fr6', 'fr7'] as const) {
    const rows = rowsByGroup()[group]
    describe(`${group.toUpperCase()} ${rows[0]?.owningTool ?? ''}`, () => {
      for (const row of rows) {
        // CloakBrowser：无 license → off/not-applicable 登记，不执行注入（休眠合规口径）
        if (row.special === 'cloak-off') continue
        // travelGuideTencent：无运行时消费位 → 适配器面演练（见下方专用 it），不在工具面派发
        if (row.special === 'adapter-only') continue

        for (const kind of row.applicableFaults) {
          const label = `${row.channelId} · ${kind}${row.keyId !== undefined && kind === 'missing-key' ? `（抑制 ${row.keyId}）` : ''}`
          it(label, async () => {
            switch (row.owningTool) {
              case 'travel_research_destination':
                await executeCase(row.channelId, group, kind, 'tool', () => destinationCase(row.channelId, kind))
                break
              case 'travel_research_transport':
                await executeCase(row.channelId, group, kind, 'tool', () => transportCase(row.channelId, kind))
                break
              case 'travel_research_advice':
                await executeCase(row.channelId, group, kind, 'tool', () => adviceCase(row.channelId, kind))
                break
              case 'travel_build_itinerary':
                await executeCase(row.channelId, group, kind, 'tool', () => buildCase(row.channelId, kind))
                break
              case 'travel_render_page':
                await executeCase(row.channelId, group, kind, 'tool', () => renderCase(row.channelId, kind))
                break
            }
            expectCasePass(row.channelId, kind)
          })
        }
      }
    })
  }

  // travelGuideTencent：无运行时消费位 → 适配器面演练（service-down）
  it('travelGuideTencent · service-down（adapter 面：travel_guide 端点故障 → EngineError 归一化）', async () => {
    await executeCase('travelGuideTencent', 'fr6', 'service-down', 'adapter', () => travelGuideAdapterCase('throw'))
    expectCasePass('travelGuideTencent', 'service-down')
  })
})

// ────────────────────────── FR-3~7 组「全部主渠道失败」演练 ──────────────────────────

describe('FR-3~7 组「全部主渠道失败」演练：工具仍产出结构合法结果（fallback/人工渠道/degraded 完整）', () => {
  it('FR-3 全主渠道失败 → research_destination 结构化结果 + degraded 全记账 + 不落空 intel.json', async () => {
    await executeCase('fr3-all-primary', 'fr3', 'service-down', 'tool', async () =>
      withStore(async (store) => {
        const planId = await intakePlan(store)
        const result = await runResearchDestination({ planId, categories: [...ALL_INTEL_CATEGORIES] }, store, destinationDepsAllDown())
        if (result.itemCount !== 0) throw new Error(`全渠道失败应零条目（实际 ${result.itemCount}）`)
        const intel = await store.readJson<IntelItem[]>(planId, 'intel.json')
        if (intel !== undefined) throw new Error('全渠道失败不得落盘空 intel.json（§9.3-6）')
        const primaries = GROUP_PRIMARY_CHANNELS['fr3']
        const missing = primaries.filter((p) => {
          const sources = ROW_DEGRADED_SOURCES[p] ?? [p]
          return !result.degraded.some((d) => sources.includes(d.source))
        })
        if (missing.length > 0) throw new Error(`degraded 缺主渠道记账：${missing.join(',')}`)
        return `itemCount=0 + intel.json 未落盘 + degraded 覆盖 ${primaries.length} 主渠道（人工重试入口=degraded 人话明细）`
      }))
    expectCasePass('fr3-all-primary', 'service-down')
  })

  it('FR-4 全主渠道失败 → transport 结构化结果 + 人工比价出口 + 不落空 transport.json', async () => {
    await executeCase('fr4-all-primary', 'fr4', 'service-down', 'tool', async () =>
      withStore(async (store) => {
        const planId = await intakePlan(store)
        const result = await runResearchTransport({ planId }, store, transportDepsAllDown())
        if (result.options.length !== 0) throw new Error(`全渠道失败应零方案（实际 ${result.options.length}）`)
        const transport = await store.readJson<unknown[]>(planId, 'transport.json')
        if (transport !== undefined) throw new Error('全渠道失败不得落盘空 transport.json（§9.3-6）')
        for (const source of ['rail12306', 'intercity/wendao', 'intercity/flyai', 'intercity/search', 'intercity/manual', 'cityAmap', 'cityDidi']) {
          if (!result.degraded.some((d) => d.source === source)) {
            throw new Error(`degraded 缺 ${source}（实际：${result.degraded.map((d) => d.source).join(',')}）`)
          }
        }
        const manual = result.degraded.find((d) => d.source === 'intercity/manual')
        if (manual === undefined || !manual.reason.includes('12306')) throw new Error('人工比价出口缺官方渠道链接')
        return `options=0 + transport.json 未落盘 + degraded 全链记账 + 人工比价出口（官方渠道明示）`
      }))
    expectCasePass('fr4-all-primary', 'service-down')
  })

  it('FR-5 全主渠道失败 → advice 仍产出（气候概况条目 + 模板穿衣/物品）', async () => {
    await executeCase('fr5-all-primary', 'fr5', 'service-down', 'tool', async () =>
      withStore(async (store) => {
        const planId = await intakePlan(store)
        const result = await runResearchAdvice({ planId }, store, adviceDepsAllDown())
        if (result.weather.length !== 3) throw new Error(`缺位日应由气候概况条目补齐（weather=${result.weather.length}）`)
        if (!result.weather.every((w) => w.source.platform === 'climate-overview')) {
          throw new Error('全天气源失败时条目来源应为 climate-overview（人话口径）')
        }
        if (result.packingList.length < 10) throw new Error(`模板物品清单应 ≥10 项（实际 ${result.packingList.length}）`)
        for (const source of ['weatherAmap', 'weatherTencent', 'weatherOpenMeteo', 'adviceSearch']) {
          if (!result.degraded.some((d) => d.source === source)) throw new Error(`degraded 缺 ${source}`)
        }
        return `weather=3 日（climate-overview 口径）+ packing=${result.packingList.length} + degraded 4 源全记账`
      }))
    expectCasePass('fr5-all-primary', 'service-down')
  })

  it('FR-6 全主渠道失败 → build 仍产出（直线估算兜底 + 降级记账贯通 warnings）', async () => {
    await executeCase('fr6-all-primary', 'fr6', 'service-down', 'tool', async () =>
      withStore(async (store) => {
        const planId = await intakePlan(store)
        await seedIntel(store, planId)
        const result = await runBuildItinerary({ planId }, store, buildDepsAllDown())
        if (!result.built) throw new Error(`估算兜底应保证 build 产出（${result.reason ?? ''}）`)
        for (const tag of ['动线渠道降级（amap）', '动线渠道降级（tencent）']) {
          if (!result.routeCheck.warnings.some((w) => w.includes(tag))) {
            throw new Error(`warnings 缺「${tag}」（实际：${result.routeCheck.warnings.join('；').slice(0, 200)}）`)
          }
        }
        return `built=true + 双渠道降级记账贯通 warnings + estimate 兜底`
      }))
    expectCasePass('fr6-all-primary', 'service-down')
  })

  it('FR-7 双地图通道停用 + 在线路由注册失败 → 渲染仍产出（Leaflet + 本地文件交付）', async () => {
    await executeCase('fr7-all-primary', 'fr7', 'service-down', 'tool', async () =>
      withStore(async (store) => {
        const planId = await renderReadyPlan(store)
        const registrar = fakeRegistrar({ throwOnRegister: true })
        const result = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, renderEnv({ off: [...RENDER_FR7_OFF] }))
        if (!result.rendered || result.filePath === '') throw new Error('双通道降级后渲染应仍产出（渲染必须成功兜底契约）')
        if (result.mapProviderUsed !== 'leaflet') throw new Error(`双开关停用应 Leaflet（实际 ${result.mapProviderUsed}）`)
        for (const fragment of ['mapAmap 已停用（用户配置）', '在线路由注册失败']) {
          if (!result.warnings.some((w) => w.includes(fragment))) {
            throw new Error(`warnings 缺「${fragment}」（实际：${result.warnings.join('；')}）`)
          }
        }
        return `rendered=true + provider=leaflet + 本地文件交付 + warnings 双通道降级记账`
      }))
    expectCasePass('fr7-all-primary', 'service-down')
  })
})

// ────────────────────────── 全渠道空 contract（单列，不入比率） ──────────────────────────

describe('全渠道空 contract（§9.3-6：空结果不产空 artifact，人话原因 + 重试入口）', () => {
  it('destination 全渠道空（响应成功零条目）→ 不落空 intel.json + 结构化结果', async () => {
    await withStore(async (store) => {
      const planId = await intakePlan(store)
      const result = await runResearchDestination({ planId, categories: [...ALL_INTEL_CATEGORIES] }, store, destinationDepsAllDown())
      const intel = await store.readJson<IntelItem[]>(planId, 'intel.json')
      const pass = result.itemCount === 0 && intel === undefined && result.degraded.length > 0
      allEmptyContract.push({
        scenario: 'travel_research_destination 全渠道空',
        pass,
        evidence: `itemCount=${result.itemCount} intel.json=${intel === undefined ? '未落盘' : '已落盘'} degraded=${result.degraded.length} 条（重试入口=degraded 人话明细 + 重新调用 travel_research_destination）`,
      })
      expect(pass).toBe(true)
    })
  })

  it('render 依赖缺失（无 itinerary）→ rendered=false + 人话原因（不生成空行程页）', async () => {
    await withStore(async (store) => {
      const planId = await intakePlan(store)
      const result = await runRenderPage({ planId }, store, fakeRegistrar(), renderEnv())
      const reason = result.warnings.join('；')
      const pass = result.rendered === false && reason.includes('不生成空行程页') && result.filePath === ''
      allEmptyContract.push({
        scenario: 'travel_render_page 依赖缺失（空渲染 contract）',
        pass,
        evidence: `rendered=false + reason「${reason.slice(0, 120)}」（重试入口=先 travel_build_itinerary）`,
      })
      expect(pass).toBe(true)
    })
  })
})

// ────────────────────────── Didi 上游服务态（与代码故障分离；不入比率） ──────────────────────────

describe('cityDidi 上游服务态分离（transit 无 result → service-state，不算代码失败）', () => {
  it('cityDidi · service-state：上游 transit 无 result → 高德单方案接管 + 人话记账', async () => {
    const t0 = Date.now()
    let evidence = ''
    let rootCause: string | undefined
    try {
      await withStore(async (store) => {
        const planId = await intakePlan(store)
        const result = await runResearchTransport({ planId }, store, transportDepsDidiServiceState())
        // queryTransfer 内部记账 source=适配器名 'didi'；工具层 catch 记 'cityDidi'
        const hit = result.degraded.find((d) => (d.source === 'cityDidi' || d.source === 'didi'))
        if (hit === undefined) throw new Error(`缺 cityDidi/didi 记账（实际：${result.degraded.map((d) => d.source).join(',')}）`)
        if (result.cityTransfer?.provider !== 'amap') {
          throw new Error(`上游服务态下渠道一应接管（provider=${result.cityTransfer?.provider ?? '无'}）`)
        }
        if (result.options.length <= 0) throw new Error('上游服务态不应阻塞整体交通产出')
        evidence = `cityDidi[${hit.code}]「${hit.reason}」（上游服务态口径）；cityTransfer 接管=amap；options=${result.options.length}`
      })
    } catch (error) {
      rootCause = error instanceof Error ? error.message : String(error)
    }
    didiServiceStateCases.push({
      rowId: 'cityDidi', group: 'fr4', kind: 'service-down', scope: 'registered',
      status: rootCause === undefined ? 'pass' : 'fail',
      evidence, ...(rootCause !== undefined ? { rootCause } : {}),
      rerun: RERUN_CMD, durationMs: Date.now() - t0,
    })
    expect(rootCause, rootCause ?? '').toBeUndefined()
  })
})

// ────────────────────────── CloakBrowser off/not-applicable 登记 ──────────────────────────

describe('xhsCloak（CloakBrowser）off/not-applicable 登记（不执行注入）', () => {
  it('无 license + 默认 off + 无消费方 → 登记为 off/not-applicable', () => {
    const row = FAULT_MATRIX_ROWS.find((r) => r.channelId === 'xhsCloak')
    expect(row).toBeDefined()
    expect(row?.special).toBe('cloak-off')
    expect(row?.applicableFaults).toEqual([])
    expect(cloakLicensePresent()).toBe(false)
  })
})

// ────────────────────────── manifest ↔ fields 一致性（模块加载已断言，此处复核语义面） ──────────────────────────

describe('manifest ↔ CHANNEL_FIELDS 一致性', () => {
  it('28 行 1:1（模块加载断言已在 import 期执行；此处复核分组与行数）', () => {
    expect(FAULT_MATRIX_ROWS).toHaveLength(28)
    const groups = rowsByGroup()
    expect(groups['fr3']).toHaveLength(9)
    expect(groups['fr4']).toHaveLength(8)
    expect(groups['fr5']).toHaveLength(4)
    expect(groups['fr6']).toHaveLength(3)
    expect(groups['fr7']).toHaveLength(4)
    // 每行 applicable ∪ notApplicable 必须覆盖全部四类（无未登记的注入类型）
    for (const row of FAULT_MATRIX_ROWS) {
      for (const kind of ['missing-key', 'service-down', 'timeout', 'rate-limit'] as const) {
        const covered = row.applicableFaults.includes(kind) || row.notApplicableFaults[kind] !== undefined
        expect(covered, `${row.channelId} 缺 ${kind} 适用性登记`).toBe(true)
      }
    }
  })
})

// ────────────────────────── 成功率（NFR-2 ≥95%）与恢复 guard ──────────────────────────

describe('NFR-2 整体成功率与恢复 guard', () => {
  it('applicable fault cases 成功率 ≥95%（分母只含 applicable cases）', () => {
    const denominator = results.length
    const numerator = results.filter((r) => r.status === 'pass').length
    const rate = denominator === 0 ? 0 : numerator / denominator
    expect(denominator, '分母不得为 0').toBeGreaterThan(0)
    expect(rate, `成功率 ${(rate * 100).toFixed(1)}%（${numerator}/${denominator}）< 95%；失败行：${results.filter((r) => r.status === 'fail').map((r) => `${r.rowId}/${r.kind}`).join(', ')}`).toBeGreaterThanOrEqual(RATE_THRESHOLD)
  })

  it('恢复 guard：注入态零残留（env 指纹一致 + 伴随服务基线不变 + 零真实服务停起）', async () => {
    envFpAfter = envFingerprint()
    baselineAfter = await probeAllBaselines()
    const envUnchanged = envFpBefore === envFpAfter
    const diff = diffBaselines(baselineBefore, baselineAfter)
    expect(envUnchanged, 'process.env 在 runner 前后不一致（注入泄漏）').toBe(true)
    expect(diff.unchanged, `伴随服务基线变化：${diff.changes.join('；')}`).toBe(true)
  })
})

// ────────────────────────── 报告落盘（afterAll 恒执行；中断时 .incomplete 残留） ──────────────────────────

/** 矩阵报告数据面（JSON 形状；md 由同型渲染）。 */
interface MatrixReport {
  milestone: string
  wave: string
  package: string
  generatedAt: string
  startedAt: string
  runner: string
  successDefinition: string
  injectionScope: string
  stats: {
    numerator: number
    denominator: number
    rate: number
    ratePercent: string
    threshold: number
    pass: boolean
    channelRows: number
    coveredRows: number
    notApplicableExecutedRows: number
    frDrills: number
  }
  rows: MatrixRowSummary[]
  frAllPrimaryDrills: Array<{ rowId: string; status: string; evidence: string; rootCause?: string }>
  allEmptyContract: Array<{ scenario: string; pass: boolean; evidence: string }>
  didiServiceState: {
    note: string
    cases: Array<{ status: string; evidence: string; rootCause?: string; durationMs: number }>
  }
  cloakOff: {
    channelId: string
    status: string
    licensePresent: boolean
    reason: string
  }
  recoveryGuard: {
    envFingerprintBefore: string
    envFingerprintAfter: string
    envUnchanged: boolean
    baselinesBefore: ServiceProbeResult[]
    baselinesAfter: ServiceProbeResult[]
    baselinesUnchanged: boolean
    baselineChanges: string[]
    realServiceStopStart: string
  }
}

interface MatrixRowSummary {
  channelId: string
  group: string
  keyId?: string
  owningTool: string
  fallback: string
  controlledEmpty: string
  applicableFaults: readonly FaultKind[]
  notApplicableFaults: Readonly<Partial<Record<FaultKind, string>>>
  special?: string
  note?: string
  executedCases: number
  status: string
  cases: Array<{ kind: FaultKind; scope: string; status: string; evidence: string; durationMs: number }>
  failures?: Array<{ kind: FaultKind; rootCause?: string }>
}

afterAll(async () => {
  try {
    if (baselineBefore.length === 0) baselineBefore = await probeAllBaselines()
    if (envFpAfter === '') envFpAfter = envFingerprint()
    if (baselineAfter.length === 0) baselineAfter = await probeAllBaselines()
    writeReports()
  } finally {
    try {
      rmSync(join(EVID_DIR, '.incomplete'))
    } catch { /* 标记已移除/不存在 */ }
  }
})

/** 汇总矩阵报告并写 fault-matrix.{json,md}。 */
function writeReports(): void {
  mkdirSync(EVID_DIR, { recursive: true })
  const finishedAt = new Date().toISOString()
  const denominator = results.length
  const numerator = results.filter((r) => r.status === 'pass').length
  const rate = denominator === 0 ? 0 : numerator / denominator
  const guardDiff = diffBaselines(baselineBefore, baselineAfter)

  const rowSummaries: MatrixRowSummary[] = FAULT_MATRIX_ROWS.map((row) => {
    const cases = results.filter((r) => r.rowId === row.channelId)
    const failed = cases.filter((c) => c.status === 'fail')
    const status = row.special === 'cloak-off'
      ? 'off/not-applicable'
      : failed.length > 0 ? 'fail' : cases.length > 0 ? 'pass' : 'not-applicable'
    return {
      channelId: row.channelId,
      group: row.group,
      ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
      owningTool: row.owningTool,
      fallback: row.fallback,
      controlledEmpty: row.controlledEmpty,
      applicableFaults: row.applicableFaults,
      notApplicableFaults: row.notApplicableFaults,
      ...(row.special !== undefined ? { special: row.special } : {}),
      ...(row.note !== undefined ? { note: row.note } : {}),
      executedCases: cases.length,
      status,
      cases: cases.map((c) => ({ kind: c.kind, scope: c.scope, status: c.status, evidence: c.evidence, durationMs: c.durationMs })),
      ...(failed.length > 0 ? { failures: failed.map((f) => ({ kind: f.kind, rootCause: f.rootCause })) } : {}),
    }
  })

  const report: MatrixReport = {
    milestone: 'm3',
    wave: 'w6',
    package: 'M3.6 全矩阵故障注入演练（NFR-2）',
    generatedAt: finishedAt,
    startedAt,
    runner: RERUN_CMD,
    successDefinition: '无裸异常 + degraded 含 source/code + 不生成空 artifact + fallback/人工渠道兑现（controlled-empty 返回人话原因与重试入口）',
    injectionScope: '全部为进程内 mock 注入（KeyResolutionEnv 面/适配器传输位/私有令牌桶/runner 自有 tmpdir fs 权限）；零真实服务停起、零凭据写、零 process.env 改写（W5 supervisor 仅用其只读探活面作恢复 guard）',
    stats: {
      numerator,
      denominator,
      rate: Number(rate.toFixed(4)),
      ratePercent: `${(rate * 100).toFixed(1)}%`,
      threshold: RATE_THRESHOLD,
      pass: rate >= RATE_THRESHOLD,
      channelRows: FAULT_MATRIX_ROWS.length,
      coveredRows: rowSummaries.filter((r) => r.status === 'pass' || r.status === 'off/not-applicable').length,
      notApplicableExecutedRows: rowSummaries.filter((r) => r.status === 'not-applicable').length,
      frDrills: results.filter((r) => r.rowId.endsWith('-all-primary')).length,
    },
    rows: rowSummaries,
    frAllPrimaryDrills: results.filter((r) => r.rowId.endsWith('-all-primary')).map((r) => ({
      rowId: r.rowId, status: r.status, evidence: r.evidence,
      ...(r.rootCause !== undefined ? { rootCause: r.rootCause } : {}),
    })),
    allEmptyContract,
    didiServiceState: {
      note: '上游服务态故障（maps_direction_transit 无 result）与代码故障分离记录；service-state case 不计入代码失败分母（M2 w0 复跑同口径）',
      cases: didiServiceStateCases.map((c) => ({
        status: c.status, evidence: c.evidence, durationMs: c.durationMs,
        ...(c.rootCause !== undefined ? { rootCause: c.rootCause } : {}),
      })),
    },
    cloakOff: {
      channelId: 'xhsCloak',
      status: 'off/not-applicable',
      licensePresent: cloakLicensePresent(),
      reason: '无 license（settings/credentials/env 均未命中）+ 默认 off + 无运行时消费方——M2 CLOSURE 休眠合规口径，不执行注入',
    },
    recoveryGuard: {
      envFingerprintBefore: envFpBefore,
      envFingerprintAfter: envFpAfter,
      envUnchanged: envFpBefore === envFpAfter,
      baselinesBefore: baselineBefore,
      baselinesAfter: baselineAfter,
      baselinesUnchanged: guardDiff.unchanged,
      baselineChanges: guardDiff.changes,
      realServiceStopStart: '无（全部注入为进程内 mock；backup/restore guard 因此不需要——状态面零触碰）',
    },
  }

  writeFileSync(join(EVID_DIR, 'fault-matrix.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(EVID_DIR, 'fault-matrix.md'), renderMarkdownReport(report))
}

/** Markdown 报告（人读面：逐行状态 + 失败根因/重跑 + guard + 基线）。 */
function renderMarkdownReport(report: MatrixReport): string {
  const lines: string[] = []
  const s = report.stats
  lines.push('# M3.6 全渠道故障矩阵演练报告（M3 W6）')
  lines.push('')
  lines.push(`- 生成：${report.generatedAt} · runner：\`${report.runner}\``)
  lines.push(`- 成功率（NFR-2）：**${s.ratePercent}**（${s.numerator}/${s.denominator} applicable fault cases，阈值 ≥${Math.round(s.threshold * 100)}%）→ ${s.pass ? 'PASS' : 'FAIL'}`)
  lines.push(`- 28 channel rows：covered=${s.coveredRows}/28（含 xhsCloak off/not-applicable 登记）· FR 组全主渠道失败演练=${s.frDrills}/5`)
  lines.push(`- 注入面：${report.injectionScope}`)
  lines.push(`- 成功定义：${report.successDefinition}`)
  lines.push('')
  lines.push('## 逐行状态（28 rows）')
  lines.push('')
  lines.push('| # | 行（组） | owningTool | 适用/不适用 | 状态 | 证据/根因 |')
  lines.push('|---|---|---|---|---|---|')
  report.rows.forEach((row, i) => {
    const applicable = row.applicableFaults.join('/') || '—'
    const na = Object.entries(row.notApplicableFaults).map(([k, v]) => `${k}:${String(v).slice(0, 40)}…`).join('<br>') || '—'
    const evidence = row.status === 'fail'
      ? `**FAIL** ${row.failures?.map((f) => `${f.kind}: ${f.rootCause}`).join('；').slice(0, 300)}`
      : row.status === 'off/not-applicable'
        ? 'license 缺失 + 默认 off + 无消费方（休眠登记，不执行注入）'
        : row.cases.map((c) => `${c.kind}=${c.status === 'pass' ? '✓' : '✗'} ${c.evidence}`).join('<br>').slice(0, 300) || '—（无适用注入；manifest 逐类登记原因）'
    lines.push(`| ${i + 1} | ${row.channelId}（${row.group}${row.keyId !== undefined ? `·key=${row.keyId}` : ''}） | ${row.owningTool} | ${applicable} / ${na} | ${row.status} | ${evidence} |`)
  })
  lines.push('')
  lines.push('## FR-3~7 组「全部主渠道失败」演练')
  lines.push('')
  lines.push('| 演练 | 状态 | 证据 |')
  lines.push('|---|---|---|')
  for (const drill of report.frAllPrimaryDrills) {
    lines.push(`| ${drill.rowId} | ${drill.status} | ${drill.status === 'pass' ? drill.evidence : `根因：${drill.rootCause ?? ''}`} |`)
  }
  lines.push('')
  lines.push('## 全渠道空 contract（单列，不入比率）')
  lines.push('')
  for (const c of report.allEmptyContract) lines.push(`- ${c.pass ? 'PASS' : 'FAIL'} · ${c.scenario} —— ${c.evidence}`)
  lines.push('')
  lines.push('## Didi service-state 与代码故障分离表')
  lines.push('')
  lines.push('| case | 状态 | 证据 |')
  lines.push('|---|---|---|')
  for (const c of report.didiServiceState.cases) {
    lines.push(`| cityDidi · 上游 transit 无 result（service-state） | ${c.status} | ${c.status === 'pass' ? c.evidence : `根因：${c.rootCause ?? ''}`} |`)
  }
  lines.push('')
  lines.push('> 口径：service-state（上游 maps_direction_transit 无 result）不算代码失败、不入比率分母；代码故障 case 见 cityDidi 行（missing-key/service-down/timeout）。')
  lines.push('')
  lines.push('## 恢复 guard')
  lines.push('')
  lines.push(`- process.env 指纹前后一致：${report.recoveryGuard.envUnchanged ? 'PASS' : 'FAIL'}（sha256=${report.recoveryGuard.envFingerprintAfter.slice(0, 12)}…，零明文）`)
  lines.push(`- 伴随服务基线（只读探活，W5 lifecycle probeHealthOnce 同判定路径）前后一致：${report.recoveryGuard.baselinesUnchanged ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push('| 服务 | 探活 | before | after |')
  lines.push('|---|---|---|---|')
  for (const b of report.recoveryGuard.baselinesBefore) {
    const after = report.recoveryGuard.baselinesAfter.find((x) => x.service === b.service)
    lines.push(`| ${b.service} | \`${b.url}\` | ${b.alive ? 'alive' : 'down'}（${b.detail}） | ${after?.alive ? 'alive' : 'down'}（${after?.detail ?? ''}） |`)
  }
  lines.push('')
  lines.push(`- 真实服务停起：${report.recoveryGuard.realServiceStopStart}`)
  const failedRows = report.rows.filter((r) => r.status === 'fail')
  if (failedRows.length > 0) {
    lines.push('')
    lines.push('## 失败行与重跑命令')
    lines.push('')
    for (const row of failedRows) {
      lines.push(`- **${row.channelId}**：${row.failures?.map((f) => `${f.kind} — ${f.rootCause}`).join('；')}`)
      lines.push(`  - fallback 声明：${row.fallback}`)
      lines.push(`  - 重跑：\`${report.runner}\`（修复后局部重跑该行，最终全跑）`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
