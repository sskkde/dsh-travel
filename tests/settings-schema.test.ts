/**
 * dsh-travel Config schema tests for defaults, partial overrides, and secret metadata.
 * SettingsScope's removed register/update API is intentionally not used: loader Config
 * volatile references are now the settings source of truth.
 */
import { describe, expect, it } from 'vitest'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import {
  Config, TRAVEL_ADVANCED_DEFAULT, TRAVEL_CHANNELS_DEFAULT, TRAVEL_SETTINGS_NS,
} from '../src/settings/schema.js'

function snapshot(input: Record<string, unknown> = {}) {
  const config = Config(input)
  return {
    channels: config.channels.get(),
    keys: config.keys.get(),
    advanced: config.advanced.get(),
    research: config.research.get(),
  }
}

describe('dsh-travel Config：缺省值（§10.1 字面值）', () => {
  it('entry id 即 settings namespace，空 Config 提供完整默认值', () => {
    expect(TRAVEL_SETTINGS_NS).toBe('dsh-travel')
    for (const field of ['channels', 'keys', 'advanced', 'research']) {
      expect(Config.dict?.[field]?.meta.volatile).toBe(true)
    }
    const resolved = snapshot()
    expect(resolved.channels).toEqual(TRAVEL_CHANNELS_DEFAULT)
    expect(resolved.advanced).toEqual(TRAVEL_ADVANCED_DEFAULT)
    expect(resolved.keys).toEqual({})
  })

  it('渠道矩阵默认细节：xhsCloak/cityDidi 默认 off，其余 on', () => {
    const channels = snapshot().channels
    expect(channels.fr3.xhsCloak).toBe(false)
    expect(channels.fr4.cityDidi).toBe(false)
    expect(channels.fr3.xhsMcp).toBe(true)
    expect(channels.fr4.rail12306).toBe(true)
    expect(channels.fr5.weatherAmap).toBe(true)
    expect(channels.fr7.mapLeaflet).toBe(true)
  })

  it('advanced 默认：socialDepth L1 / routePrefix /travel-plans / 预算 / amapSecurityMode A', () => {
    const advanced = snapshot().advanced
    expect(advanced).toEqual(TRAVEL_ADVANCED_DEFAULT)
    expect(advanced.routePrefix).toBe('/travel-plans')
    expect(advanced.amapSecurityMode).toBe('A')
  })

  it('Config 覆盖 amapSecurityMode=B，其余 advanced 字段继续使用默认', () => {
    const advanced = snapshot({ advanced: { amapSecurityMode: 'B' } }).advanced
    expect(advanced.amapSecurityMode).toBe('B')
    expect(advanced.defaultMapProvider).toBe('auto')
  })

  it('部分配置覆盖保留其它组和字段的默认值', () => {
    const resolved = snapshot({
      channels: { fr3: { douyin: false } },
      keys: { wendao: 'WENDAO-TOKEN-SECRET' },
      advanced: { socialDepth: 'L2' },
    })
    expect(resolved.channels.fr3.douyin).toBe(false)
    expect(resolved.channels.fr3.xhsMcp).toBe(true)
    expect(resolved.channels.fr4.rail12306).toBe(true)
    expect(resolved.keys.wendao).toBe('WENDAO-TOKEN-SECRET')
    expect(resolved.advanced.socialDepth).toBe('L2')
  })
})

describe('secret role 元数据与 Config Key 语义', () => {
  it('keys 字典值保持 role(secret)，宿主 redaction 只返回 sidecar 不含明文', () => {
    expect(Config.dict?.keys?.inner?.meta.role).toBe('secret')
    const result = redactSecrets(Config, { keys: { amapWebservice: 'AMAP-PLAIN-SECRET' } })
    expect(JSON.stringify(result.value)).not.toContain('AMAP-PLAIN-SECRET')
    expect(JSON.stringify(result)).not.toContain('AMAP-PLAIN-SECRET')
    expect(result.secrets.some((secret) => secret.path.join('.') === 'keys.amapWebservice' && secret.set)).toBe(true)
  })

  it('未配置的 secret 字典条目不产生 sidecar entry', () => {
    const result = redactSecrets(Config, { keys: {} })
    expect(snapshot().keys.amapWebservice).toBeUndefined()
    expect(result.secrets.find((secret) => secret.path.join('.') === 'keys.wendao')).toBeUndefined()
  })

  it('新 Config 值覆盖旧快照，未提及 Key 在新快照中继续存在', () => {
    const original = Config({ keys: { wendao: 'WENDAO-PERSISTED' } })
    const updated = Config({ keys: { wendao: 'WENDAO-PERSISTED', amapWebservice: 'AMAP-NEW' } })
    expect(original.keys.get().wendao).toBe('WENDAO-PERSISTED')
    expect(updated.keys.get().wendao).toBe('WENDAO-PERSISTED')
    expect(updated.keys.get().amapWebservice).toBe('AMAP-NEW')
  })

  it('新 Config 中移除单个 Key 后，其余 Key 保留', () => {
    const updated = Config({ keys: { didi: 'DIDI-PERSISTED' } })
    expect(updated.keys.get().wendao).toBeUndefined()
    expect(updated.keys.get().didi).toBe('DIDI-PERSISTED')
  })
})
