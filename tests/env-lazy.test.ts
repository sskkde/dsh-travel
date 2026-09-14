/**
 * N-9 惰性凭据解析单测（T1 · 2026-09-09）。
 *
 * 根因：`makeKeyEnv(ctx)` 曾在构造期把 `ctx.get('credentials')` 快照进闭包；当装配期
 * credentials 尚未注册、执行期才就绪时，同一 env 的 `resolveCredential` 恒 undefined
 * （resolveKey('amapJsapi') 永久解析失败 → render mapProvider 误判 Leaflet，与
 * key-status「每次请求现造 makeKeyEnv」口径不一致）。
 *
 * 修复：env.ts 把 credentials 位改为每次 `resolveCredential` 调用现取（惰性现造），
 * 装配 tip / render 复用同一 makeKeyEnv 结果执行期即解析成功。本文件验证：
 * 1. 构造期 credentials 缺失（mock ctx.get 先 undefined 后就绪）→ 执行期 resolveKey
 *    ('amapJsapi') 仍解析成功（settings 链之外走 credentials ref 空间 AMAP_JSAPI）。
 * 2. mapProvider 判定消耗执行期 env：同一 env 在 credentials 就绪前 auto → leaflet，
 *    就绪后 auto → amap（证明判定不缓存构造期快照）。
 * 3. 渲染链路端到端：createTravelRenderPageTool({keyEnvHost}) 每次执行现造 env——
 *    装配后 credentials 才就绪、执行 render → mapProviderUsed='amap'。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import {
  createTravelRenderPageTool, runRenderPage, selectMapProvider,
  type RouteRegistrarPort,
} from '../src/tools/render-page.js'
import { makeKeyEnv, type KeyEnvCredentials } from '../src/adapters/env.js'
import { resolveKey } from '../src/adapters/base.js'
import type { TravelSettings } from '../src/settings/schema.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedPlaces } from './helpers/seed-places.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'

/** 惰性可变 ctx 宿主：credentials 可在外界（模拟执行期注册）后注入。 */
function mutableHost(initial?: unknown): { host: { get: (n: string, l?: boolean) => unknown }; setCredentials(v: unknown): void } {
  let credentials: unknown = initial
  return {
    host: { get: (n: string) => (n === 'credentials' ? credentials : undefined) },
    setCredentials(v: unknown) { credentials = v },
  }
}

function channelsAllOn(): TravelSettings['channels'] {
  return {
    fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, tencentPoi: true, platformIntel: true },
    fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
    fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
    fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
    fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
  }
}

function sampleSettings(keys: TravelSettings['keys'] = {}): TravelSettings {
  return {
    channels: channelsAllOn(),
    keys,
    advanced: {
      socialDepth: 'L1', researchTimeoutMs: 180000, rateLimitPerDomain: 10,
      routePrefix: '/travel-plans', defaultMapProvider: 'auto', amapSecurityMode: 'A',
      amapPoiBudgetPerPlan: 40, amapRestBudgetPerPlan: 60, profileTtlDays: 7,
    },
  }
}

/** env 风格凭据假体（§10.2 AMAP_JSAPI/AMAP_JSCODE ref 交割路径）。 */
function refCredentials(values: Record<string, string>): KeyEnvCredentials {
  return {
    resolve: async (ref) => {
      const value = values[String(ref)]
      return value === undefined ? undefined : { value, source: 'file' as const }
    },
    readRecord: async () => undefined,
  }
}

describe('N-9 惰性凭据解析（装配期缺失 → 执行期 resolveKey 成功）', () => {
  it('同一 env 构造期 credentials 缺失，执行期 ctx.get("credentials") 就绪 → resolveKey("amapJsapi") 解析成功', async () => {
    const { host, setCredentials } = mutableHost() // 装配期：无 credentials 服务
    const env = makeKeyEnv(host, { settings: sampleSettings(), env: {} })

    // 装配期解析：credentials 未注册 → 走 env 兜底（恒 undefined，不是 settings 命中）
    expect(await resolveKey('amapJsapi', env)).toBeUndefined()

    // 执行期：credentials 服务注册就绪（含 AMAP_JSAPI / AMAP_JSCODE ref）
    setCredentials(refCredentials({ AMAP_JSAPI: 'EXEC-KEY', AMAP_JSCODE: 'EXEC-JSCODE' }))

    // 关键断言：同一 env（非重造）也能解析到执行期凭据 → N-9 根因修复
    const resolved = await resolveKey('amapJsapi', env)
    expect(resolved?.layer).toBe('credentials')
    expect(resolved?.value).toBe('EXEC-KEY')
  })

  it('显式 options.credentials 覆盖优先级不变（测试/定制路径不受惰性影响）', async () => {
    const env = makeKeyEnv(
      { get: () => undefined }, // ctx 无 credentials
      { settings: sampleSettings(), credentials: refCredentials({ AMAP_JSAPI: 'OVERRIDE-KEY' }), env: {} },
    )
    const resolved = await resolveKey('amapJsapi', env)
    expect(resolved?.layer).toBe('credentials')
    expect(resolved?.value).toBe('OVERRIDE-KEY')
  })

  it('构造期 credentials 快照不会冻结：先缺后有的顺序，mapProvider 判定走执行期 env', async () => {
    const { host, setCredentials } = mutableHost()
    const env = makeKeyEnv(host, { settings: sampleSettings(), env: {} })

    // credentials 未就绪：auto → leaflet（缺 key，warning 明示）
    const before = await selectMapProvider('auto', env)
    expect(before.provider).toBe('leaflet')

    // 执行期 credentials 就绪：同一 env + 同一次判定 → amap（证明判定不缓存构造态）
    setCredentials(refCredentials({ AMAP_JSAPI: 'EXEC-KEY', AMAP_JSCODE: 'EXEC-JSCODE' }))
    const after = await selectMapProvider('auto', env)
    expect(after.provider).toBe('amap')
    expect(after.amapKey).toBe('EXEC-KEY')
    expect(after.amapJscode).toBe('EXEC-JSCODE')
  })
})

// ── 端到端：createTravelRenderPageTool({keyEnvHost}) 每次执行现造，装配后凭据就绪仍命中 amap ──

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-lazy-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fakeRegistrar(): { registrar: RouteRegistrarPort; calls: () => number } {
  let registers = 0
  const registrar: RouteRegistrarPort = {
    host: '127.0.0.1',
    port: 3080,
    register() { registers += 1 },
  }
  return { registrar, calls: () => registers }
}

async function makeGeneratingPlan(): Promise<string> {
  const intake = await runIntake({ slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' } }, store)
  const planId = intake.planId
  expect(intake.status).toBe('confirmed')
  await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
  await seedSufficientAssessment(store, planId)
  await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
  const built = await runBuildItinerary({ planId }, store)
  expect(built.built).toBe(true)
  return planId
}

describe('N-9 render 每次执行现造 env（keyEnvHost 形态）', () => {
  it('装配后 credentials 才就绪：createTravelRenderPageTool({keyEnvHost}) 执行 → mapProviderUsed=amap', async () => {
    const planId = await makeGeneratingPlan({})
    const { registrar } = fakeRegistrar()

    // 装配 tip：无 credentials 服务（模拟宿主 credentials 后注册）
    const { host, setCredentials } = mutableHost()
    const tool = createTravelRenderPageTool(store, registrar, { keyEnvHost: host })

    // 执行 tips 后 credentials 就绪（含 AMAP ref）
    setCredentials(refCredentials({ AMAP_JSAPI: 'EXEC-KEY', AMAP_JSCODE: 'EXEC-JSCODE' }))

    // 直接驱动工具 execute（经 config 包装现造 env）
    const value = (await tool.execute({ planId, mapProvider: 'auto' })) as unknown as {
      rendered: boolean
      mapProviderUsed: 'leaflet' | 'amap'
      warnings: string[]
    }
    expect(value.rendered).toBe(true)
    expect(value.mapProviderUsed).toBe('amap')
    expect(value.warnings).toEqual([])
  })

  it('runRenderPage 直连 env（test 替身路径）在凭据就绪后 → amap（执行期 env 判定一致）', async () => {
    const planId = await makeGeneratingPlan({})
    const { registrar } = fakeRegistrar()
    const { host, setCredentials } = mutableHost()
    const env = makeKeyEnv(host, { settings: sampleSettings(), env: {} })
    setCredentials(refCredentials({ AMAP_JSAPI: 'EXEC-KEY', AMAP_JSCODE: 'EXEC-JSCODE' }))
    const result = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, env)
    expect(result.rendered).toBe(true)
    expect(result.mapProviderUsed).toBe('amap')
    expect(result.warnings).toEqual([])
  })
})
