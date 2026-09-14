/**
 * render-page 双 loader 单测（M1 T8 / W5）。
 *
 * selectMapProvider：makeKeyEnv 热读判定（ADR-12）——auto=有 amap key+jscode→amap
 * 否则 leaflet；settings mapAmap/mapLeaflet 开关走 channelEnabled 语义；缺 key/jscode
 * → 自动降级 Leaflet + warning（§2.1 FR-7 零 key 行；design §8 双 loader 方案 A）。
 *
 * 端到端：runRenderPage 双 provider 各渲染一次（状态机 generating→delivered 规范序列），
 * 断言 mapProviderUsed/页面内嵌 map 配置（amap 明文注入面=方案 A；key 值为测试假值零明文关切）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { runRenderPage, selectAmapSecurityMode, selectMapProvider, travelPlanRoutePath, type RouteRegistrarPort } from '../src/tools/render-page.js'
import { AMAP_SECURITY_PROXY_PATH, createDedupingRouteRegistrar } from '../src/render/route-registrar.js'
import { makeKeyEnv, type KeyEnvCredentials } from '../src/adapters/env.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'
import type { TravelSettings } from '../src/settings/schema.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedPlaces } from './helpers/seed-places.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'

let root: string
let store: TravelStore

/** 最小 ServerResponse 替身（路由 handler 直调断言用）。 */
class FakeServerResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''
  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode
    this.headers = { ...headers }
    return this
  }
  end(chunk?: string | Uint8Array): void {
    this.body = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-rp-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

// ── 测试替身：完整渠道矩阵 + sample settings（与 adapters-env.test 同构） ──

type ChannelOverrides = { [K in keyof TravelSettings['channels']]?: Partial<TravelSettings['channels'][K]> }

function channelsAllOn(): TravelSettings['channels'] {
  return {
    fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, tencentPoi: true, platformIntel: true, socialL1: true, didaHotel: true },
    fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
    fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
    fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
    fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
  }
}

function sampleSettings(overrides: { channels?: ChannelOverrides; keys?: TravelSettings['keys']; advanced?: Partial<TravelSettings['advanced']> } = {}): TravelSettings {
  const base = channelsAllOn()
  return {
    channels: {
      fr3: { ...base.fr3, ...overrides.channels?.fr3 },
      fr4: { ...base.fr4, ...overrides.channels?.fr4 },
      fr5: { ...base.fr5, ...overrides.channels?.fr5 },
      fr6: { ...base.fr6, ...overrides.channels?.fr6 },
      fr7: { ...base.fr7, ...overrides.channels?.fr7 },
    },
    keys: overrides.keys ?? {},
    advanced: {
      socialDepth: 'L1', researchTimeoutMs: 180000, rateLimitPerDomain: 10, robotsToSCheck: true,
      routePrefix: '/travel-plans', defaultMapProvider: 'auto', amapSecurityMode: 'A',
      amapPoiBudgetPerPlan: 40, amapRestBudgetPerPlan: 60, profileTtlDays: 7,
      ...overrides.advanced,
    },
  }
}

const noCtx = { get: () => undefined }

function refCredentials(values: Record<string, string>): KeyEnvCredentials {
  return {
    resolve: async (ref) => {
      const value = values[String(ref)]
      return value === undefined ? undefined : { value, source: 'file' as const }
    },
    readRecord: async () => undefined,
  }
}

/** 零 key 环境（settings keys 空 + credentials 空 + env 空）。 */
function zeroKeyEnv(options: { keys?: TravelSettings['keys']; channels?: ChannelOverrides; advanced?: Partial<TravelSettings['advanced']> } = {}): KeyResolutionEnv {
  return makeKeyEnv(noCtx, {
    settings: sampleSettings({ keys: options.keys, channels: options.channels, advanced: options.advanced }),
    credentials: refCredentials({}),
    env: {},
  })
}

/** 规范序列前置（同 render.test.ts 约定）：intake → research → places（决策 5）→ build，终态 generating。 */
async function makeGeneratingPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
  }, store)
  const planId = intake.planId
  expect(intake.status).toBe('confirmed')
  await seedResearch(store, planId, { poi: 'golden', l0: 'hits' })
  await seedSufficientAssessment(store, planId) // C5① 门放行件
  await seedPlaces(store, planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
  // 真实流水线使用 publishArtifacts；直写 helper 后显式补一次现代 manifest 账目。
  const places = await store.readJson(planId, 'places.json')
  await store.publishArtifacts(planId, {
    stage: 'places', files: [{ name: 'places.json', data: places }],
    expectedVersions: { intel: 1 }, bump: [], inputFingerprint: 'render-page-test-places',
  })
  const built = await runBuildItinerary({ planId }, store)
  expect(built.built).toBe(true)
  expect((await store.loadRequest(planId))?.status).toBe('generating')
  return planId
}

function fakeRegistrar(): { registrar: RouteRegistrarPort; calls: () => number } {
  let registers = 0
  const registrar: RouteRegistrarPort = {
    host: '127.0.0.1',
    port: 3080,
    register() { registers += 1 },
  }
  return { registrar, calls: () => registers }
}

// ── selectMapProvider 判定矩阵 ──

describe('selectMapProvider（双 loader 判定，design §8 / §2.1 FR-7 零 key 行）', () => {
  it('amapSecurityMode 缺省 A，settings advanced.amapSecurityMode 热读取 B', async () => {
    let mode: 'A' | 'B' = 'A'
    const env: KeyResolutionEnv = {
      readSettings: (key) => key === 'advanced.amapSecurityMode' ? mode : undefined,
    }
    expect(selectAmapSecurityMode(env)).toBe('A')
    mode = 'B'
    expect(selectAmapSecurityMode(env)).toBe('B')
    const selection = await selectMapProvider('auto', env)
    expect(selection.amapSecurityMode).toBe('B')
  })

  it('auto + 零 key → leaflet + warning「amap JSAPI key 未配置」', async () => {
    const s = await selectMapProvider('auto', zeroKeyEnv())
    expect(s.provider).toBe('leaflet')
    expect(s.warnings.some((w) => w.includes('amap JSAPI key 未配置'))).toBe(true)
  })

  it('auto + 有 key 无 jscode → leaflet + warning「jscode 未配置」', async () => {
    const s = await selectMapProvider('auto', zeroKeyEnv({ keys: { amapJsapi: 'TEST-KEY' } }))
    expect(s.provider).toBe('leaflet')
    expect(s.amapKey).toBeUndefined()
    expect(s.warnings.some((w) => w.includes('jscode'))).toBe(true)
  })

  it('auto + key+jscode → amap（amapKey/amapJscode 带出，进页面=方案 A 明文注入面）', async () => {
    const s = await selectMapProvider('auto', zeroKeyEnv({ keys: { amapJsapi: 'TEST-KEY', amapJscode: '<MASK>' } }))
    expect(s.provider).toBe('amap')
    expect(s.amapKey).toBe('TEST-KEY')
    expect(s.amapJscode).toBe('<MASK>')
    expect(s.warnings).toEqual([])
  })

  it('auto + key+jscode 但 mapAmap 开关 off → leaflet + warning「mapAmap 已停用」', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr7: { mapAmap: false } }, keys: { amapJsapi: 'K', amapJscode: '<MASK>' } }),
      credentials: refCredentials({}),
      env: {},
    })
    const s = await selectMapProvider('auto', env)
    expect(s.provider).toBe('leaflet')
    expect(s.warnings.some((w) => w.includes('mapAmap 已停用'))).toBe(true)
  })

  it('显式 amap + 无 key → leaflet + warning（回归：Wα 旧行为升级为结构化降级）', async () => {
    const s = await selectMapProvider('amap', zeroKeyEnv())
    expect(s.provider).toBe('leaflet')
    expect(s.warnings.some((w) => w.includes('amap'))).toBe(true)
  })

  it('显式 amap + key+jscode → amap，零 warning', async () => {
    const s = await selectMapProvider('amap', zeroKeyEnv({ keys: { amapJsapi: 'K', amapJscode: '<MASK>' } }))
    expect(s.provider).toBe('amap')
    expect(s.warnings).toEqual([])
  })

  it('显式 leaflet + mapLeaflet off + amap 就绪 → 改用 amap + warning', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr7: { mapLeaflet: false } }, keys: { amapJsapi: 'K', amapJscode: '<MASK>' } }),
      credentials: refCredentials({}),
      env: {},
    })
    const s = await selectMapProvider('leaflet', env)
    expect(s.provider).toBe('amap')
    expect(s.warnings.some((w) => w.includes('mapLeaflet 已停用'))).toBe(true)
  })

  it('显式 leaflet + mapLeaflet off + amap 未就绪 → 仍 leaflet + warning（渲染必须成功兜底）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr7: { mapLeaflet: false } } }),
      credentials: refCredentials({}),
      env: {},
    })
    const s = await selectMapProvider('leaflet', env)
    expect(s.provider).toBe('leaflet')
    expect(s.warnings.some((w) => w.includes('mapLeaflet 已停用'))).toBe(true)
  })

  it('env 兜底：process.env 注入 amapJsapi/amapJscode → amap（resolveKey 三段链 env 位）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: refCredentials({}),
      env: { amapJsapi: 'ENV-KEY', amapJscode: '<MASK>' },
    })
    const s = await selectMapProvider('auto', env)
    expect(s.provider).toBe('amap')
    expect(s.amapKey).toBe('ENV-KEY')
  })

  it('credentials ref 位：AMAP_JSAPI + AMAP_JSCODE ref → amap（§10.2 registry 交割路径）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: refCredentials({ AMAP_JSAPI: 'CRED-KEY', AMAP_JSCODE: '<MASK>' }),
      env: {},
    })
    const s = await selectMapProvider('auto', env)
    expect(s.provider).toBe('amap')
    expect(s.amapKey).toBe('CRED-KEY')
    expect(s.amapJscode).toBe('<MASK>')
  })
})

// ── travel_render_page 端到端（双 provider 各渲染一次；页面内嵌 map 配置断言） ──

describe('travel_render_page 双 loader 端到端', () => {
  it('零 key auto → mapProviderUsed=leaflet + 页面 map.provider=leaflet + 无 amap 明文', async () => {
    const planId = await makeGeneratingPlan()
    const { registrar, calls } = fakeRegistrar()
    const result = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, zeroKeyEnv())
    expect(result.rendered).toBe(true)
    expect(result.mapProviderUsed).toBe('leaflet')
    expect(result.warnings.some((w) => w.includes('amap'))).toBe(true) // 降级明示
    expect(calls()).toBe(1)
    const html = readFileSync(result.filePath, 'utf8')
    expect(html).toContain('"provider":"leaflet"')
    // §5.4 新页面结构：地图主面、左轨道、移动抽屉、逐段路线清单均落在单文件。
    for (const id of ['mainGrid', 'mapCard', 'timelineCard', 'dayDrawer', 'legList', 'insightsCard']) {
      expect(html, `页面结构缺 ${id}`).toContain(`id="${id}"`)
    }
    expect(html).toContain('sha256-')
    expect(html).not.toContain('unsafe-inline')
    expect(html).not.toContain('unsafe-eval')
    // 零 key 页内嵌数据不含 amap 明文（模板代码引用 amapKey 属分支代码，非注入值）
    const dataBlock = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
    expect(dataBlock, 'travel-data 数据块缺失').toBeTruthy()
    expect(dataBlock![1]).not.toContain('"amapKey"')
    expect(dataBlock![1]).not.toContain('"amapJscode"')
  })

  it('有 key+jscode auto → mapProviderUsed=amap + 页面注入 key/jscode（方案 A）+ 路由幂等', async () => {
    const planId = await makeGeneratingPlan()
    const server = { host: '127.0.0.1', port: 3080, register: vi.fn(() => () => {}) }
    const registrar = createDedupingRouteRegistrar(server)
    const env = zeroKeyEnv({ keys: { amapJsapi: 'TEST-KEY', amapJscode: '<MASK>' } })

    const first = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, env)
    expect(first.rendered).toBe(true)
    expect(first.mapProviderUsed).toBe('amap')
    expect(first.warnings).toEqual([])
    expect(server.register).toHaveBeenCalledTimes(1)

    const html = readFileSync(first.filePath, 'utf8')
    expect(html).toContain('"provider":"amap"')
    expect(html).toContain('"amapKey":"TEST-KEY"')
    expect(html).toContain('"amapJscode":"\\u003cMASK>"')
    expect(html).toContain('webapi.amap.com/maps?v=2.0') // loader 分支就绪
    // 路线几何以 routeTransport 数据面进入 bundle；页面渲染层仅消费，不重算道路。
    expect(html).toContain('routeTransport')
    expect(html).toContain('geometryStatus')
    const csp = /<meta id="page-csp"[^>]+content="([^"]+)"/.exec(html)
    expect(csp?.[1]).toContain('https://webapi.amap.com')
    expect(csp?.[1]).toContain('https://unpkg.com')
    const dataBlock = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
    expect(dataBlock, 'travel-data 数据块缺失').toBeTruthy()
    expect(dataBlock![1]).not.toContain('</script') // 数据 JSON 转义防闭合

    // 同 planId 二次 render：delivered self 幂等，路由不重复注册，引擎不变
    const second = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, env)
    expect(second.rendered).toBe(true)
    expect(second.mapProviderUsed).toBe('amap')
    expect(second.url).toBe(`http://127.0.0.1:3080${travelPlanRoutePath(planId)}/`)
    expect(server.register).toHaveBeenCalledTimes(1)
  })

  it('B 模式 → 注册 _AMapService 代理且 page.html 零 jscode 明文', async () => {
    const planId = await makeGeneratingPlan()
    const registered: Array<Parameters<RouteRegistrarPort['register']>[0]> = []
    const inner: RouteRegistrarPort = {
      host: '127.0.0.1',
      port: 3081,
      register(route) { registered.push(route) },
    }
    // 幂等语义与生产一致（createDedupingRouteRegistrar 包装；§9.2 同 planId 重渲染）
    const registrar = createDedupingRouteRegistrar(inner as unknown as Parameters<typeof createDedupingRouteRegistrar>[0])
    const env = zeroKeyEnv({
      keys: { amapJsapi: 'TEST-KEY', amapJscode: '<MASK>' },
      advanced: { amapSecurityMode: 'B' },
    })

    const result = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, env)
    expect(result.rendered).toBe(true)
    expect(result.mapProviderUsed).toBe('amap')
    expect(registered.map((route) => route.path)).toEqual([AMAP_SECURITY_PROXY_PATH, travelPlanRoutePath(planId)])

    const html = readFileSync(result.filePath, 'utf8')
    expect(html).toContain('"amapSecurityMode":"B"')
    expect(html).toContain('"serviceHost":"http://127.0.0.1:3081/_AMapService"')
    expect(html).not.toContain('<MASK>')
    expect(html).not.toContain('"amapJscode"')

    // capability 接线：落盘 store 根、页面响应下发 HttpOnly cookie、重渲染复用同 token
    const capabilityPath = `${store.root}/.amap-capability.json`
    const first = JSON.parse(readFileSync(capabilityPath, 'utf8')) as { token: string; expiresAt: number }
    expect(first.token).toMatch(/^[0-9a-f]{48}$/)

    const [proxyRoute, pageRoute] = registered
    const pageRes = new FakeServerResponse()
    await pageRoute.handler({ method: 'GET' } as IncomingMessage, pageRes as unknown as ServerResponse)
    const setCookie = pageRes.headers['set-cookie'] ?? ''
    expect(setCookie).toContain(`dsh-travel-amap-capability=${first.token}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Path=/_AMapService')

    // 代理校验页面下发的 token（provider 动态读盘）→ 200（上游 fetch stub 离线）
    vi.stubGlobal('fetch', async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const proxyRes = new FakeServerResponse()
    await proxyRoute.handler({
      method: 'GET',
      url: '/_AMapService/v3/log/init',
      headers: { cookie: `dsh-travel-amap-capability=${first.token}` },
    } as unknown as IncomingMessage, proxyRes as unknown as ServerResponse)
    expect(proxyRes.statusCode).toBe(200)

    // 重渲染：registrar 幂等不重复注册；capability 未过期复用（旧页面 cookie 仍有效）
    const again = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, env)
    expect(again.rendered).toBe(true)
    expect(registered.length).toBe(2)
    const reused = JSON.parse(readFileSync(capabilityPath, 'utf8')) as { token: string }
    expect(reused.token).toBe(first.token)
  })

  it('缺 jscode 显式 amap → 降级 leaflet + warning（FR-7 降级行）', async () => {
    const planId = await makeGeneratingPlan()
    const { registrar } = fakeRegistrar()
    const result = await runRenderPage({ planId, mapProvider: 'amap' }, store, registrar, zeroKeyEnv({ keys: { amapJsapi: 'KEY-ONLY' } }))
    expect(result.rendered).toBe(true)
    expect(result.mapProviderUsed).toBe('leaflet')
    expect(result.warnings.some((w) => w.includes('jscode'))).toBe(true)
  })
})