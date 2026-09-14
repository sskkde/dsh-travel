/**
 * M3.6 渠道 Key 配置状态路由单测（/travel-key-status）。
 *
 * 覆盖（requirements 验收口径）：
 * - 每 id 按 resolveKey 全链（settings→credentials→env）判定：假 credentials
 *   resolve 命中（AMAP 系列 / WENDAO / DIDI env 风格 ref）/ settings 层命中 / env 兜底命中；
 * - 空态（三层全空）→ 全 false；credentials 解析抛错 → 按未配置处理（不 500）；
 * - 响应零 secret：结构与内容只含布尔；明文值不出现在任何响应面；
 * - 防护同 /travel-metrics：非 GET → 405（allow: GET）、非本机来源 → 403。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  makeTravelKeyStatusHandler,
  TRAVEL_KEY_STATUS_PATH, TRAVEL_KEY_STATUS_NS, TRAVEL_KEY_STATUS_IDS,
  type TravelKeyStatusProjection,
} from '../src/metrics/key-status.js'
import type { KeyEnvCredentials } from '../src/adapters/env.js'
import type { TravelSettings } from '../src/settings/schema.js'

// ────────────────────────── 测试基建（metrics.test.ts 同款） ──────────────────────────

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

function request(url: string, method = 'GET', headers: Record<string, string | undefined> = {}): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage
}

function responseOf(fake: FakeResponse): import('node:http').ServerResponse {
  return fake as unknown as import('node:http').ServerResponse
}

/** 假 host：只有 credentials 位（GetKeyEnvHost.get；makeKeyEnv 只取 'credentials'）。 */
function hostOf(credentials: KeyEnvCredentials | undefined): { get: (name: string) => unknown } {
  return { get: (name) => (name === 'credentials' ? credentials : undefined) }
}

/** env 风格 ref 解析（AMAP 系列 / WENDAO_APIKEY / DIDI_MCPKEY 等合法标识符）。 */
function resolvingCredentials(refs: Record<string, string>): KeyEnvCredentials {
  return {
    resolve: async (ref) => (refs[ref] !== undefined ? { value: refs[ref], source: 'test' } : undefined),
    readRecord: async () => undefined,
  }
}

function emptySettings(): TravelSettings {
  return {
    channels: {
      fr3: {
        xhsMcp: true, xhsFallback: true, xhsCloak: true, douyin: true, tier2: true,
        tier3: true, tencentPoi: true, platformIntel: true, socialL1: true, didaHotel: true,
      },
      fr4: {
        rail12306: true, railWendao: true, railFlyai: true, flightWendao: true,
        flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: true,
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

function sampleSettingsWithKeys(keys: Record<string, string>): TravelSettings {
  return { ...emptySettings(), keys }
}

const SECRETS = {
  AMAP_WEBSERVICE: 'SECRET-AMAP-WEBSERVICE-1',
  AMAP_JSAPI: 'SECRET-AMAP-JSAPI-2',
  AMAP_JSCODE: 'SECRET-AMAP-JSCODE-3',
  WENDAO_APIKEY: 'SECRET-WENDAO-4',
  DIDI_MCPKEY: 'SECRET-DIDI-5',
}

// ────────────────────────── 全链判定（settings→credentials→env） ──────────────────────────

describe('GET /travel-key-status：resolveKey 全链判定', () => {
  it('credentials 层命中（env 风格 refs）→ 对应 id true，其余 false；响应零明文', async () => {
    const handler = makeTravelKeyStatusHandler(
      hostOf(resolvingCredentials(SECRETS)),
      { env: {} },
    )
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body) as TravelKeyStatusProjection
    expect(body.ns).toBe(TRAVEL_KEY_STATUS_NS)
    expect(Object.keys(body.keys).sort()).toEqual([...TRAVEL_KEY_STATUS_IDS].sort())
    expect(body.keys).toEqual({
      amapWebservice: { configured: true, channelEnabled: true },
      amapJsapi: { configured: true, channelEnabled: true },
      amapJscode: { configured: true, channelEnabled: true },
      wendao: { configured: true, channelEnabled: true },
      flyai: { configured: false, channelEnabled: true },
      didi: { configured: true, channelEnabled: true },
      tmap: { configured: false, channelEnabled: true },
      zhihu: { configured: false, channelEnabled: true },
      cloakbrowser: { configured: false, channelEnabled: true },
    })
    // 只双布尔 + 零明文（结构与内容双证明）
    expect(Object.values(body.keys).every((value) =>
      typeof value.configured === 'boolean' && typeof value.channelEnabled === 'boolean')).toBe(true)
    expect(res.body).not.toContain('SECRET')
    for (const secret of Object.values(SECRETS)) expect(res.body).not.toContain(secret)
  })

  it('settings 层命中（快照 keys 覆盖；credentials/env 空）→ 该 id true', async () => {
    const handler = makeTravelKeyStatusHandler(
      hostOf(undefined),
      { settings: sampleSettingsWithKeys({ wendao: 'SETTINGS-WENDAO-TOKEN' }), env: {} },
    )
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))
    const body = JSON.parse(res.body) as TravelKeyStatusProjection
    expect(body.keys.wendao).toEqual({ configured: true, channelEnabled: true })
    expect(body.keys.amapWebservice).toEqual({ configured: false, channelEnabled: true })
    expect(res.body).not.toContain('SETTINGS-WENDAO-TOKEN') // settings 值也不回显
  })

  it('渠道关闭但凭据已配置 → configured=true/channelEnabled=false；开关开启但无 Key → false/true', async () => {
    const disabledSettings = sampleSettingsWithKeys({})
    disabledSettings.channels.fr4.railWendao = false
    const disabled = makeTravelKeyStatusHandler(
      hostOf(resolvingCredentials({ WENDAO_APIKEY: 'OFF-WENDAO-VALUE' })),
      { settings: disabledSettings, env: {}, ids: ['wendao'] },
    )
    const disabledRes = new FakeResponse()
    await disabled(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(disabledRes))
    expect(JSON.parse(disabledRes.body).keys.wendao).toEqual({ configured: true, channelEnabled: false })
    expect(disabledRes.body).not.toContain('OFF-WENDAO-VALUE')

    const missing = makeTravelKeyStatusHandler(hostOf(undefined), { env: {}, ids: ['wendao'] })
    const missingRes = new FakeResponse()
    await missing(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(missingRes))
    expect(JSON.parse(missingRes.body).keys.wendao).toEqual({ configured: false, channelEnabled: true })
  })

  it('env 兜底命中（process.env 层；settings/credentials 空）→ 该 id true', async () => {
    const handler = makeTravelKeyStatusHandler(
      hostOf(undefined),
      { env: { tmap: 'ENV-TMAP-KEY' } },
    )
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))
    const body = JSON.parse(res.body) as TravelKeyStatusProjection
    expect(body.keys.tmap).toEqual({ configured: true, channelEnabled: true })
    expect(body.keys.amapWebservice).toEqual({ configured: false, channelEnabled: true })
    expect(res.body).not.toContain('ENV-TMAP-KEY')
  })

  it('空态（三层全空）→ 全部 false', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { env: {} })
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))
    expect(JSON.parse(res.body)?.keys).toEqual({
      amapWebservice: { configured: false, channelEnabled: true },
      amapJsapi: { configured: false, channelEnabled: true },
      amapJscode: { configured: false, channelEnabled: true },
      wendao: { configured: false, channelEnabled: true },
      flyai: { configured: false, channelEnabled: true },
      didi: { configured: false, channelEnabled: true },
      tmap: { configured: false, channelEnabled: true },
      zhihu: { configured: false, channelEnabled: true },
      cloakbrowser: { configured: false, channelEnabled: true },
    })
  })

  it('credentials 解析抛错 → 按未配置处理（不 500，其余 id 照常判定）', async () => {
    const handler = makeTravelKeyStatusHandler(
      hostOf({
        resolve: async () => { throw new Error('credentials 瞬时不可用') },
        readRecord: async () => undefined,
      }),
      { env: {} },
    )
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as TravelKeyStatusProjection
    expect(Object.values(body.keys).every((value) => value.configured === false && value.channelEnabled === true)).toBe(true)
    expect(res.body).not.toContain('瞬时不可用')
  })

  it('自定义 id 集合（测试注入）→ 只判定该子集', async () => {
    const handler = makeTravelKeyStatusHandler(
      hostOf(resolvingCredentials({ AMAP_WEBSERVICE: 'SECRET-X' })),
      { env: {}, ids: ['amapWebservice', 'tmap'] },
    )
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081' }), responseOf(res))
    const body = JSON.parse(res.body) as TravelKeyStatusProjection
    expect(body.keys).toEqual({
      amapWebservice: { configured: true, channelEnabled: true },
      tmap: { configured: false, channelEnabled: true },
    })
  })
})

// ────────────────────────── 防护（同 /travel-metrics 形态） ──────────────────────────

describe('GET /travel-key-status：防护', () => {
  it('非 GET → 405（allow: GET）', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { env: {} })
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'POST', { host: '127.0.0.1:3081' }), responseOf(res))
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('GET')
  })

  it('未授权来源 → 403：非回环 Host / 外站 Origin / 缺 Host', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { env: {} })
    for (const headers of [
      { host: 'evil.example.com:3081' },
      { host: '127.0.0.1:3081', origin: 'https://evil.example.com' },
      { host: '127.0.0.1:3081', referer: 'https://evil.example.com/x' },
      {},
    ]) {
      const res = new FakeResponse()
      await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', headers), responseOf(res))
      expect(res.statusCode).toBe(403)
    }
  })

  it('本机 UI 跨端口 fetch（回环 Origin）→ 200', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { env: {} })
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: '127.0.0.1:3081', origin: 'http://localhost:3000' }), responseOf(res))
    expect(res.statusCode).toBe(200)
  })
})

// ────────────────────────── allowSelfOrigin（只读路由：部署域名 GUI 同源 fetch） ──────────────────────────

describe('GET /travel-key-status：allowSelfOrigin 同源自洽', () => {
  const allowSelf = { allowSelfOrigin: true, env: {} } as const

  it('部署域名 Host + 同源 Origin → 200（dsh.example.com GUI 页 fetch）', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { ...allowSelf, ids: ['amapWebservice'] })
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', {
      host: 'dsh.example.com:3080',
      origin: 'http://dsh.example.com:3080',
    }), responseOf(res))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as TravelKeyStatusProjection
    expect(body.keys).toEqual({ amapWebservice: { configured: false, channelEnabled: true } })
  })

  it('部署域名 Host + 同源 Referer → 200', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { ...allowSelf, ids: ['amapWebservice'] })
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', {
      host: 'dsh.example.com:3080',
      referer: 'http://dsh.example.com:3080/settings',
    }), responseOf(res))
    expect(res.statusCode).toBe(200)
  })

  it('非回环 Host 但无 Origin/Referer（curl/外部服务端）→ 仍 403', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), allowSelf)
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', { host: 'dsh.example.com:3080' }), responseOf(res))
    expect(res.statusCode).toBe(403)
  })

  it('非回环 Host + 异源 Origin/Referer（外站页面 fetch）→ 403', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), allowSelf)
    for (const headers of [
      { host: 'dsh.example.com:3080', origin: 'https://evil.example.com' },
      { host: 'dsh.example.com:3080', referer: 'https://evil.example.com/x' },
    ]) {
      const res = new FakeResponse()
      await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', headers), responseOf(res))
      expect(res.statusCode).toBe(403)
    }
  })

  it('缺省（无 allowSelfOrigin）域名 Host + 同源 Origin → 仍 403（默认严格不变）', async () => {
    const handler = makeTravelKeyStatusHandler(hostOf(undefined), { env: {} })
    const res = new FakeResponse()
    await handler(request(TRAVEL_KEY_STATUS_PATH, 'GET', {
      host: 'dsh.example.com:3080',
      origin: 'http://dsh.example.com:3080',
    }), responseOf(res))
    expect(res.statusCode).toBe(403)
  })
})