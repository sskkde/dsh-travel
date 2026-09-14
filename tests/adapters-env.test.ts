/**
 * 热读取接线单测（makeKeyEnv，ADR-12 收口；FR-8 验收②/④ + §10.2 映射表）。
 *
 * 覆盖：
 * - readSettings 路径映射（渠道路径表 / keys 别名 / 未知名安全缺省开）
 * - channelEnabled 经 readSettings 快照切换：开关 off → false（FR-8②）
 * - credentials ref 映射（§10.2 记录空间 readRecord + env 风格 resolve）
 * - env 兜底保留（base.ts resolveKey 三段链优先级）
 * - 删除某 Key → resolveKey undefined → 适配器 available()=false（FR-8④，
 *   降级路径=degraded「Key 未配置」— 记账格式由 base.ts toDegraded 负责，此处断言链路）
 */
import { describe, expect, it } from 'vitest'
import {
  channelEnabled, EngineError, isKeyConfigured, resolveKey, toDegraded,
  type KeyResolutionEnv, type ResolvedKey,
} from '../src/adapters/base.js'
import { makeKeyEnv, CREDENTIAL_REF_MAP, CHANNEL_SETTINGS_PATHS } from '../src/adapters/env.js'
import type { KeyEnvCredentials } from '../src/adapters/env.js'
import type { TravelSettings } from '../src/settings/schema.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { WendaoAdapter } from '../src/adapters/wendao.js'
import { SocialAdapter } from '../src/adapters/social.js'

/** 一份完整渠道矩阵（全部 on，除 cityDidi）。 */
function channelsAllOn(): TravelSettings['channels'] {
  return {
    fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, tencentPoi: true, platformIntel: true },
    fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
    fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
    fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
    fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
  }
}

function sampleSettings(overrides: { channels?: Partial<TravelSettings['channels']>; keys?: TravelSettings['keys']; advanced?: Partial<TravelSettings['advanced']> } = {}): TravelSettings {
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
      socialDepth: 'L1', researchTimeoutMs: 180000, rateLimitPerDomain: 10,
      routePrefix: '/travel-plans', defaultMapProvider: 'auto',
      amapPoiBudgetPerPlan: 40, amapRestBudgetPerPlan: 60, profileTtlDays: 7,
      ...overrides.advanced,
    },
  }
}

const noCtx = { get: () => undefined }

/** 记录空间凭据假体：按 §10.2 <scope>/<id> 键返回 api-key 记录。 */
function recordCredentials(records: Record<string, string>): KeyEnvCredentials {
  return {
    resolve: async () => undefined,
    readRecord: async (key) => {
      const value = records[String(key)]
      return value === undefined ? undefined : { kind: 'api-key', key: value }
    },
  }
}

/** env 风格凭据假体：按 ref 名字返回。 */
function refCredentials(values: Record<string, string>): KeyEnvCredentials {
  return {
    resolve: async (ref) => {
      const value = values[String(ref)]
      return value === undefined ? undefined : { value, source: 'file' as const }
    },
    readRecord: async () => undefined,
  }
}

describe('readSettings 路径映射（渠道路径表 / keys）', () => {
  it('channels.<name> 走映射表（wendao→fr4.railWendao、tencent-poi→fr3.tencentPoi）', () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr4: { railWendao: false }, fr3: { tencentPoi: false } } }),
    })
    expect(env.readSettings?.('channels.wendao')).toBe('false')
    expect(env.readSettings?.('channels.tencent-poi')).toBe('false')
    expect(env.readSettings?.('channels.rail12306')).toBe('true')
    expect(env.readSettings?.('channels.amap')).toBe('true') // → fr4.cityAmap
    expect(env.readSettings?.('channels.douyin')).toBe('true')
  })

  it('keys.<settingsKey> 直读；TMAP_KEY 别名 → keys.tmap', () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ keys: { amapWebservice: 'AMAP-SECRET', tmap: 'TMAP-SECRET' } }),
    })
    expect(env.readSettings?.('keys.amapWebservice')).toBe('AMAP-SECRET')
    expect(env.readSettings?.('keys.TMAP_KEY')).toBe('TMAP-SECRET')
    expect(env.readSettings?.('keys.wendao')).toBeUndefined()
    expect(env.readSettings?.('keys.amapWebservice')).not.toContain('undefined')
  })

  it('未知渠道名 / 空字符串 Key → undefined（ADR-12 缺省开安全侧）', () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ keys: { wendao: '   ' } }),
    })
    expect(env.readSettings?.('channels.not-a-channel')).toBeUndefined()
    expect(env.readSettings?.('keys.wendao')).toBeUndefined()
    expect(channelEnabled('not-a-channel', env)).toBe(true)
  })
})

describe('channelEnabled 经 readSettings 快照切换（FR-8②：开关切换下一次调用即生效）', () => {
  it('关腾讯 POI（fr3.tencentPoi=false）→ tencent-poi 渠道 off', () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr3: { tencentPoi: false } } }),
    })
    expect(channelEnabled('tencent-poi', env)).toBe(false)
    expect(channelEnabled('tencentPoi', env)).toBe(false)
  })

  it('关 railWendao → wendao 适配器渠道 off；再开 → on（热读取无缓存）', () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr4: { railWendao: false } } }),
    })
    expect(channelEnabled('wendao', env)).toBe(false)
    // 同一 env 上换快照（模拟保存后热读）：开关即时翻转
    const env2 = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr4: { railWendao: true } } }),
    })
    expect(channelEnabled('wendao', env2)).toBe(true)
  })

  it('env 变量 TRAVEL_CHANNEL_<NAME>=off 兜底（settings 未设时）', () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      env: { TRAVEL_CHANNEL_DOUYIN: 'off' },
    })
    expect(channelEnabled('douyin', env)).toBe(false)
  })
})

describe('credentials ref 映射（§10.2）', () => {
  it('标识符 → 凭据 ref 映射（AMAP_*/WENDAO_APIKEY 走 ref 空间 resolve），settings 优先', async () => {
    expect(CREDENTIAL_REF_MAP.amapWebservice).toBe('AMAP_WEBSERVICE')
    expect(CREDENTIAL_REF_MAP.amapJsapi).toBe('AMAP_JSAPI')
    expect(CREDENTIAL_REF_MAP.amapJscode).toBe('AMAP_JSCODE')
    expect(CREDENTIAL_REF_MAP.wendao).toBe('WENDAO_APIKEY')
    expect(CREDENTIAL_REF_MAP.tmap).toBe('tmap/key')
    expect(CREDENTIAL_REF_MAP.TMAP_KEY).toBe('tmap/key')
    // settings 有值 → settings 层命中（不经 credentials）
    const settingsHit = await resolveKey('amapWebservice', makeKeyEnv(noCtx, {
      settings: sampleSettings({ keys: { amapWebservice: 'FROM-SETTINGS' } }),
      credentials: refCredentials({ AMAP_WEBSERVICE: 'FROM-CREDENTIALS' }),
    }))
    expect(settingsHit?.layer).toBe('settings')
    expect(settingsHit?.value).toBe('FROM-SETTINGS')
    // settings 无该 Key → credentials ref 命中（标识符形式走 resolve）
    const credentialsHit = await resolveKey('amapWebservice', makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: refCredentials({ AMAP_WEBSERVICE: 'FROM-CREDENTIALS' }),
    }))
    expect(credentialsHit?.layer).toBe('credentials')
    expect(credentialsHit?.value).toBe('FROM-CREDENTIALS')
  })

  it('非 <scope>/<id> 标识符 → env 风格 resolve（未映射名按自身字面量）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: refCredentials({ 'SOME_OTHER_KEY': 'FROM-REF' }),
    })
    const resolved = await resolveKey('SOME_OTHER_KEY', env)
    expect(resolved?.layer).toBe('credentials')
    expect(resolved?.value).toBe('FROM-REF')
  })

  it('TMAP_KEY → tmap/key 记录；settings keys.tmap 优先', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: recordCredentials({ 'tmap/key': 'TMAP-RECORD' }),
    })
    const resolved = await resolveKey('TMAP_KEY', env)
    expect(resolved?.value).toBe('TMAP-RECORD')
  })
})

describe('env 兜底与三段链（settings → credentials → env）', () => {
  it('settings/credentials 都未配置 → env 命中（layer=env）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: refCredentials({}),
      env: { amapWebservice: 'FROM-ENV' },
    })
    const resolved = await resolveKey('amapWebservice', env)
    expect(resolved?.layer).toBe('env')
    expect(resolved?.value).toBe('FROM-ENV')
  })

  it('全链未配置 → undefined（不抛）', async () => {
    const env = makeKeyEnv(noCtx, { settings: sampleSettings(), credentials: refCredentials({}), env: {} })
    expect(await resolveKey('amapWebservice', env)).toBeUndefined()
    expect(await isKeyConfigured('amapWebservice', env)).toBe(false)
  })
})

describe('FR-8④：删除某 Key → available()=false → 降级链（渠道跳过路径）', () => {
  it('settings 删除 amapWebservice → AmapAdapter.available()=false；恢复 → true', async () => {
    const envWithout: KeyResolutionEnv = makeKeyEnv(noCtx, {
      settings: sampleSettings(), // keys 空 = 已删除
      credentials: refCredentials({}),
      env: {},
    })
    const amap = new AmapAdapter()
    expect(await amap.available(envWithout)).toBe(false)
    // 恢复 Key → 可用
    const envWith = makeKeyEnv(noCtx, {
      settings: sampleSettings({ keys: { amapWebservice: 'RESTORED' } }),
      credentials: refCredentials({}),
      env: {},
    })
    expect(await amap.available(envWith)).toBe(true)
  })

  it('wendao 删除 → WendaoAdapter.available()=false；零 Key 渠道不被 Key 缺失阻塞', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings(),
      credentials: refCredentials({}),
      env: {},
    })
    const wendao = new WendaoAdapter()
    expect(await wendao.available(env)).toBe(false)
    // 零 Key 渠道（social L0）不存在 Key 依赖：开关开 + Key 缺失不影响可用性
    const social = new SocialAdapter()
    expect(await social.available(env)).toBe(true)
  })

  it('降级记账：Key 未配置 → degraded reason（渠道跳过路径的标注口径）', () => {
    const entry = toDegraded('amap', EngineError.unavailable('Key 未配置'))
    expect(entry.code).toBe('UNAVAILABLE')
    expect(entry.reason).toBe('Key 未配置')
    expect(entry.source).toBe('amap')
  })

  it('渠道开关关闭 → available()=false（与 Key 无关）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: sampleSettings({ channels: { fr4: { cityAmap: false } }, keys: { amapWebservice: 'K' } }),
    })
    expect(await new AmapAdapter().available(env)).toBe(false)
  })
})

describe('映射表完整性（与渠道矩阵字段一一对应）', () => {
  it('CHANNEL_SETTINGS_PATHS 覆盖 fr3~fr7 全部字段（恒等映射存在）', () => {
    const ids = [
      'xhsMcp', 'xhsFallback', 'xhsCloak', 'douyin', 'tier2', 'tier3', 'tencentPoi', 'platformIntel',
      'rail12306', 'railWendao', 'railFlyai', 'flightWendao', 'flightFlyai', 'busConsult', 'cityAmap', 'cityDidi',
      'weatherAmap', 'weatherTencent', 'weatherOpenMeteo', 'adviceSearch',
      'routeCheckAmap', 'routeCheckTencent', 'travelGuideTencent',
      'mapAmap', 'mapLeaflet', 'deliveryRoute', 'deliveryFile',
    ]
    for (const id of ids) {
      expect(CHANNEL_SETTINGS_PATHS[id], `恒等映射缺 ${id}`).toBeDefined()
    }
  })

  it('sampleSettings 渠道矩阵与 schema 缺省形态一致（城建字段监测）', () => {
    expect(sampleSettings().channels.fr4.cityDidi).toBe(false)
    expect(sampleSettings({ channels: { fr4: { cityDidi: true } } }).channels.fr4.cityDidi).toBe(true)
  })
})
describe('方案 A：密钥收敛到 credentials（settings 明文移除后仍可解析）', () => {
  it('settings keys 裸标识符（zhihu/flyai）映射到合法 ref 名并解析 credentials 层', async () => {
    // 值已从 settings.yaml 迁到 .credentials.yaml 的 refs；settings 侧留空。
    expect(CREDENTIAL_REF_MAP.zhihu).toBe('ZHIHU_ACCESS_SECRET')
    expect(CREDENTIAL_REF_MAP.flyai).toBe('FLYAI_APIKEY')
    // ref 名必须是 POSIX 标识符（无斜杠）——斜杠名曾致宿主崩溃（dcd01e1 口径）
    for (const name of [CREDENTIAL_REF_MAP.zhihu, CREDENTIAL_REF_MAP.flyai]) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }

    const env = makeKeyEnv({ get: () => ({
      resolve: async (ref: string) => (ref === 'ZHIHU_ACCESS_SECRET' || ref === 'FLYAI_APIKEY'
        ? { value: `resolved-${ref}` }
        : undefined),
    }) } as never, { settings: sampleSettings(), env: {} })

    // settings 未配（方案 A 后留空）→ 走 credentials 层解析成功
    expect(await isKeyConfigured('zhihu', env)).toBe(true)
    expect(await isKeyConfigured('flyai', env)).toBe(true)
  })
})
