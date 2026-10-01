/**
 * FR-3~FR-7 渠道三层状态路由单测。
 * 所有网络面均为注入 fake；测试不会触碰生产 3080 或真实配额。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  makeTravelChannelStatusHandler,
  TRAVEL_CHANNEL_STATUS_PATH,
  TRAVEL_CHANNEL_STATUS_IDS,
  type TravelChannelStatusProjection,
} from '../src/metrics/channel-status.js'
import type { KeyEnvCredentials } from '../src/adapters/env.js'
import type { TravelSettings } from '../src/settings/schema.js'

class FakeResponse {
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

function request(url: string, method = 'GET', headers: Record<string, string | undefined> = { host: '127.0.0.1:3081' }): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage
}

function responseOf(fake: FakeResponse): import('node:http').ServerResponse {
  return fake as unknown as import('node:http').ServerResponse
}

function hostOf(credentials: KeyEnvCredentials | undefined): { get: (name: string) => unknown } {
  return { get: (name) => (name === 'credentials' ? credentials : undefined) }
}

function resolvingCredentials(refs: Record<string, string>): KeyEnvCredentials {
  return {
    resolve: async (ref) => (refs[ref] === undefined ? undefined : { value: refs[ref], source: 'test' }),
    readRecord: async () => undefined,
  }
}

function settings(overrides: Partial<TravelSettings['channels']['fr4']> = {}): TravelSettings {
  return {
    channels: {
      fr3: {
        xhsMcp: true, xhsFallback: true, xhsCloak: true, douyin: true, tier2: true,
        tier3: true, tencentPoi: true, platformIntel: true, socialL1: true, didaHotel: true,
      },
      fr4: {
        rail12306: true, railWendao: true, railFlyai: true, flightWendao: true,
        flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: true, ...overrides,
      },
      fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
      fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
      fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
    },
    keys: {},
    advanced: {} as TravelSettings['advanced'],
    research: { deep: { maxRoundsPerPlan: 16, maxContentItemsPerPlan: 40, maxContentCharsPerItem: 100_000 } },
  }
}

const SECRET_AMAP = 'FAKE-AMAP-SECRET-1'
const SECRET_WENDAO = 'FAKE-WENDAO-SECRET-2'
const SECRET_DIDI = 'FAKE-DIDI-SECRET-3'

function parse(res: FakeResponse): TravelChannelStatusProjection {
  return JSON.parse(res.body) as TravelChannelStatusProjection
}

function adapters(counters: { amap: number; wendao: number }): {
  amap: { directionTransit: (...args: unknown[]) => Promise<unknown> }
  wendao: { query: (...args: unknown[]) => Promise<unknown> }
} {
  return {
    amap: {
      directionTransit: async () => {
        counters.amap += 1
        return { routes: [], options: [], degraded: [] }
      },
    },
    wendao: {
      query: async () => {
        counters.wendao += 1
        return { entries: [], raw: '# ok', degraded: [] }
      },
    },
  }
}

describe('GET /travel-channel-status 三层投影', () => {
  it('覆盖所有 FR-4 八个渠道，并在缺省 probe 时不发起任何 fetch', async () => {
    let fetches = 0
    const counters = { amap: 0, wendao: 0 }
    const handler = makeTravelChannelStatusHandler(hostOf(undefined), {
      settings: settings({ cityDidi: false }),
      env: { TRAVEL_CHANNEL_RAIL12306: 'off' },
      fetchFn: async () => {
        fetches += 1
        return { status: 200 }
      },
      adapters: adapters(counters),
      supervisor: { statusSnapshot: () => [] },
    })
    const res = new FakeResponse()
    await handler(request(TRAVEL_CHANNEL_STATUS_PATH), responseOf(res))
    expect(res.statusCode).toBe(200)
    const body = parse(res)
    expect(body.ns).toBe('dsh-travel')
    expect(body.probe).toBe('none')
    expect(body.runtime).toBeUndefined()
    expect(body.config.rail12306.enabled).toBe(false)
    expect(body.config.cityDidi.enabled).toBe(false)
    expect(TRAVEL_CHANNEL_STATUS_IDS.filter((id) => id.startsWith('rail') || id.startsWith('flight') || id === 'busConsult' || id.startsWith('city')).every((id) => body.config[id] !== undefined)).toBe(true)
    expect(body.readiness.rail12306.endpoint).toBe('http://127.0.0.1:8123/mcp')
    expect(body.readiness.rail12306.endpointSource).toBe('default')
    expect(fetches).toBe(0)
    expect(counters).toEqual({ amap: 0, wendao: 0 })
  })

  it('settings/credentials/env 三层就绪判定、端点覆盖来源与零 secret', async () => {
    const handler = makeTravelChannelStatusHandler(hostOf(resolvingCredentials({
      AMAP_WEBSERVICE: SECRET_AMAP,
      WENDAO_APIKEY: SECRET_WENDAO,
      DIDI_MCPKEY: SECRET_DIDI,
    })), {
      settings: settings({}),
      env: {
        TRAVEL_RAIL_MCP_URL: 'http://127.0.0.1:9999/mcp',
        TRAVEL_DIDI_MCP_URL: `https://mcp.didichuxing.com/mcp-servers?key=${SECRET_DIDI}`,
        TRAVEL_WENDAO_ENDPOINT: 'https://wendao.example.invalid/query',
      },
      flyaiBinaryReady: false,
      adapters: adapters({ amap: 0, wendao: 0 }),
    })
    const res = new FakeResponse()
    await handler(request(TRAVEL_CHANNEL_STATUS_PATH), responseOf(res))
    const body = parse(res)
    expect(body.readiness.rail12306.endpoint).toBe('http://127.0.0.1:9999/mcp')
    expect(body.readiness.rail12306.endpointSource).toBe('env-override')
    expect(body.readiness.rail12306.envVar).toBe('TRAVEL_RAIL_MCP_URL')
    expect(body.readiness.railWendao.state).toBe('ready')
    expect(body.readiness.railWendao.endpointSource).toBe('env-override')
    expect(body.readiness.railFlyai.state).toBe('missing-binary')
    expect(body.readiness.railFlyai.keyConfigured).toBe(false)
    expect(body.readiness.cityDidi.state).toBe('ready')
    expect(body.readiness.mapAmap.state).toBe('missing-key')
    expect(res.body).not.toContain(SECRET_AMAP)
    expect(res.body).not.toContain(SECRET_WENDAO)
    expect(res.body).not.toContain(SECRET_DIDI)
  })

  it('probe=health 只探 cheap-health；AMap/Wendao 返回 quota_guarded', async () => {
    const urls: string[] = []
    const counters = { amap: 0, wendao: 0 }
    const handler = makeTravelChannelStatusHandler(hostOf(resolvingCredentials({
      AMAP_WEBSERVICE: SECRET_AMAP,
      WENDAO_APIKEY: SECRET_WENDAO,
    })), {
      settings: settings(),
      fetchFn: async (url) => {
        urls.push(url)
        return { status: url.includes('8123') ? 503 : 405 }
      },
      adapters: adapters(counters),
    })
    const res = new FakeResponse()
    await handler(request(`${TRAVEL_CHANNEL_STATUS_PATH}?probe=health`), responseOf(res))
    const body = parse(res)
    expect(body.probe).toBe('health')
    expect(body.runtime?.rail12306.state).toBe('unreachable')
    expect(body.runtime?.railFlyai.state).toBe('not-applicable')
    expect(body.runtime?.xhsMcp.state).toBe('reachable')
    expect(body.runtime?.socialL1.state).toBe('reachable')
    expect(body.runtime?.cityDidi.state).toBe('reachable')
    expect(body.runtime?.railWendao).toMatchObject({ state: 'not-probed', reason: 'quota_guarded', cost: 'metered' })
    expect(body.runtime?.cityAmap).toMatchObject({ state: 'not-probed', reason: 'quota_guarded' })
    expect(body.runtime?.railWendao.costLabel).toContain('30/日')
    expect(body.runtime?.cityAmap.costLabel).toContain('5000/月')
    expect(counters).toEqual({ amap: 0, wendao: 0 })
    // 探活必须打**适配器真实端点**（含 TRAVEL_*_MCP_URL 覆盖），而不是 companion
    // manifest 的固定 URL：didi manifest 是远程基址，适配器缺省却连 8124。
    // rail12306 例外：适配器连 /mcp，健康口径是 origin + /health（descriptor.healthPath）。
    expect(urls).toEqual(expect.arrayContaining([
      'http://127.0.0.1:8123/health',
      'http://127.0.0.1:18060/mcp',
      'http://localhost:8931/mcp',
      'http://127.0.0.1:8124/mcp',
    ]))
    expect(urls).not.toContain('https://mcp.didichuxing.com/mcp-servers')
  })

  it('探活 URL 随端点覆盖变化：env 覆盖时打覆盖后的端点（rail 保留 /health 子路径）', async () => {
    const urls: string[] = []
    const handler = makeTravelChannelStatusHandler(hostOf(resolvingCredentials({})), {
      settings: settings({}),
      env: {
        TRAVEL_RAIL_MCP_URL: 'http://127.0.0.1:9998/mcp',
        TRAVEL_DIDI_MCP_URL: 'http://127.0.0.1:8888/mcp',
      },
      fetchFn: async (url) => {
        urls.push(url)
        return { status: 200 }
      },
      adapters: adapters({ amap: 0, wendao: 0 }),
    })
    const res = new FakeResponse()
    await handler(request(`${TRAVEL_CHANNEL_STATUS_PATH}?probe=health`), responseOf(res))
    const body = parse(res)
    expect(body.readiness.rail12306.endpointSource).toBe('env-override')
    expect(urls).toContain('http://127.0.0.1:9998/health')
    expect(urls).toContain('http://127.0.0.1:8888/mcp')
  })

  it('probe=full 才探 metered，AMap/Wendao 各只调用一次并投影到共享渠道', async () => {
    const counters = { amap: 0, wendao: 0 }
    const handler = makeTravelChannelStatusHandler(hostOf(resolvingCredentials({
      AMAP_WEBSERVICE: SECRET_AMAP,
      WENDAO_APIKEY: SECRET_WENDAO,
    })), {
      settings: settings(),
      fetchFn: async () => ({ status: 200 }),
      adapters: adapters(counters),
    })
    const res = new FakeResponse()
    await handler(request(`${TRAVEL_CHANNEL_STATUS_PATH}?probe=full`), responseOf(res))
    const body = parse(res)
    expect(body.probe).toBe('full')
    expect(body.runtime?.cityAmap.state).toBe('reachable')
    expect(body.runtime?.weatherAmap.state).toBe('reachable')
    expect(body.runtime?.routeCheckAmap.state).toBe('reachable')
    expect(body.runtime?.railWendao.state).toBe('reachable')
    expect(body.runtime?.flightWendao.state).toBe('reachable')
    expect(body.runtime?.platformIntel.state).toBe('reachable')
    expect(counters).toEqual({ amap: 1, wendao: 1 })
  })

  it('非法 probe → 400；非 GET → 405；非白名单来源 → 403', async () => {
    const handler = makeTravelChannelStatusHandler(hostOf(undefined), { settings: settings() })
    const badProbe = new FakeResponse()
    await handler(request(`${TRAVEL_CHANNEL_STATUS_PATH}?probe=wat`), responseOf(badProbe))
    expect(badProbe.statusCode).toBe(400)

    const post = new FakeResponse()
    await handler(request(TRAVEL_CHANNEL_STATUS_PATH, 'POST'), responseOf(post))
    expect(post.statusCode).toBe(405)
    expect(post.headers.allow).toBe('GET')

    const forbidden = new FakeResponse()
    await handler(request(TRAVEL_CHANNEL_STATUS_PATH, 'GET', { host: 'travel.example:3081', origin: 'https://evil.example' }), responseOf(forbidden))
    expect(forbidden.statusCode).toBe(403)
  })
})
