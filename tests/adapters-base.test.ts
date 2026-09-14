/**
 * 适配器契约基类单测（design §5.1 归一化 / ADR-12 Key 解析链 / EngineError）。
 */
import { describe, expect, it } from 'vitest'
import {
  BaseAdapter, CAP_NATURAL_LANGUAGE, CAP_SEAT_CLASS, EngineError,
  capabilityNames, fenToYuan, isKeyConfigured, resolveKey, secondsToMinutes,
  supportsCapability, toDegraded, toEngineError, toGcj02, toIsoTimestamp,
} from '../src/adapters/base.js'

describe('归一化工具（§5.1 项 3）', () => {
  it('秒→分钟（取整）', () => {
    expect(secondsToMinutes(300)).toBe(5)
    expect(secondsToMinutes(90)).toBe(2) // 1.5 分 → 2
    expect(secondsToMinutes('3600')).toBe(60)
    expect(secondsToMinutes(0)).toBe(0)
  })

  it('分→元（两位小数）', () => {
    expect(fenToYuan(12345)).toBe(123.45)
    expect(fenToYuan('505')).toBe(5.05)
    expect(fenToYuan(0)).toBe(0)
    expect(fenToYuan(1)).toBe(0.01)
  })

  it('时间戳→ISO8601：秒/毫秒/Date/ISO 字符串直通', () => {
    const base = new Date('2026-10-01T08:30:00.000Z')
    const expected = base.toISOString()
    const ms = base.getTime()
    expect(toIsoTimestamp(ms / 1000)).toBe(expected) // 秒
    expect(toIsoTimestamp(ms)).toBe(expected) // 毫秒
    expect(toIsoTimestamp(String(ms / 1000))).toBe(expected) // 数字串（秒）
    expect(toIsoTimestamp(new Date('2026-10-01T08:30:00.000Z'))).toBe(expected)
    expect(toIsoTimestamp(expected)).toBe(expected) // ISO 直通
  })

  it('时间戳不可解析 → 抛 RangeError（响亮失败不留脏数据）', () => {
    expect(() => toIsoTimestamp('garbage')).toThrow(RangeError)
    expect(() => toIsoTimestamp('2026-13-99')).toThrow(RangeError)
  })

  it('坐标统一 GCJ-02：GCJ02 直落、WGS84 NE 偏移有界、境外透传', () => {
    // GCJ02 输入原样（sys 归一 GCJ02）
    expect(toGcj02(120.15, 30.24, 'GCJ02')).toEqual({ lng: 120.15, lat: 30.24, sys: 'GCJ02' })
    // WGS84（北京附近）→ NE 偏移在 0.001~0.01 度（约百米级，标准 wgs2gcj 变换）
    const gcj = toGcj02(116.404, 39.915, 'WGS84')
    expect(gcj.sys).toBe('GCJ02')
    expect(gcj.lng).toBeGreaterThan(116.404)
    expect(gcj.lat).toBeGreaterThan(39.915)
    expect(gcj.lng - 116.404).toBeGreaterThan(0.001)
    expect(gcj.lng - 116.404).toBeLessThan(0.01)
    expect(gcj.lat - 39.915).toBeGreaterThan(0.001)
    expect(gcj.lat - 39.915).toBeLessThan(0.01)
    // 境外（纽约）透传不偏移（偏差 <1e-6）
    const ny = toGcj02(-74.006, 40.7128, 'WGS84')
    expect(Math.abs(ny.lng + 74.006)).toBeLessThan(1e-9)
    expect(Math.abs(ny.lat - 40.7128)).toBeLessThan(1e-9)
    // 非法坐标拒绝
    expect(() => toGcj02(200, 0, 'WGS84')).toThrow(RangeError)
  })
})

describe('Key 解析链（ADR-12：settings→credentials→env）', () => {
  it('env 段立即可用（缺省 process.env）', async () => {
    process.env['TRAVEL_TEST_KEY'] = 'from-env'
    const resolved = await resolveKey('TRAVEL_TEST_KEY')
    expect(resolved).toEqual({ value: 'from-env', layer: 'env' })
    delete process.env['TRAVEL_TEST_KEY']
  })

  it('settings 优先于 credentials/env（settings 位=W6 接口）', async () => {
    const resolved = await resolveKey('K', {
      readSettings: () => 'from-settings',
      resolveCredential: async () => 'from-credentials',
      env: { K: 'from-env' },
    })
    expect(resolved).toEqual({ value: 'from-settings', layer: 'settings' })
  })

  it('settings 缺省 → credentials 命中；两者皆缺 → env', async () => {
    const viaCredentials = await resolveKey('K', {
      resolveCredential: async () => 'from-credentials',
      env: { K: 'from-env' },
    })
    expect(viaCredentials).toEqual({ value: 'from-credentials', layer: 'credentials' })
    const viaEnv = await resolveKey('K', { env: { K: 'from-env' } })
    expect(viaEnv).toEqual({ value: 'from-env', layer: 'env' })
  })

  it('空串/空白视为未配置继续下沉；全链无 → undefined', async () => {
    const empty = await resolveKey('K', {
      readSettings: () => '  ',
      resolveCredential: async () => '',
      env: { K: undefined },
    })
    expect(empty).toBeUndefined()
    await expect(isKeyConfigured('K', { env: {} })).resolves.toBe(false)
    await expect(isKeyConfigured('K', { env: { K: 'x' } })).resolves.toBe(true)
  })

  it('credentials 解析抛错按未配置处理（不中断降级链）', async () => {
    const resolved = await resolveKey('K', {
      resolveCredential: async () => { throw new Error('boom') },
      env: { K: 'from-env' },
    })
    expect(resolved?.value).toBe('from-env')
  })
})

describe('EngineError 与 degraded 记账', () => {
  it('错误统一形态与判别', () => {
    const err = EngineError.timeout('读超时', 'tencent-poi')
    expect(err.code).toBe('TIMEOUT')
    expect(err.source).toBe('tencent-poi')
    expect(toEngineError(err)).toBe(err) // 已是 EngineError 原样
    expect(toEngineError(new Error('网络错'), 'amap').code).toBe('UNAVAILABLE')
  })

  it('toDegraded：条目含 source+code+reason+at(ISO)', () => {
    const entry = toDegraded('amap', EngineError.unavailable('Key 未配置'))
    expect(entry.source).toBe('amap')
    expect(entry.code).toBe('UNAVAILABLE')
    expect(entry.reason).toBe('Key 未配置')
    expect(entry.at).toMatch(/^20\d\d-\d\d-\d\dT/)
    const bare = toDegraded('search-l0', 'EMPTY', '无结果')
    expect(bare.code).toBe('EMPTY')
  })
})

describe('能力协商骨架（§5.1 项 4）', () => {
  it('capabilities 声明 + 判定', async () => {
    const adapter = new (class extends BaseAdapter {
      async available() { return true }
    })('flyai', { supports: new Set([CAP_SEAT_CLASS, CAP_NATURAL_LANGUAGE]) })
    expect(supportsCapability(adapter.capabilities, CAP_SEAT_CLASS)).toBe(true)
    expect(supportsCapability(adapter.capabilities, 'maxPrice')).toBe(false)
    expect(capabilityNames(adapter.capabilities)).toEqual([CAP_NATURAL_LANGUAGE, CAP_SEAT_CLASS])
    expect(adapter.name).toBe('flyai')
    await expect(adapter.available()).resolves.toBe(true)
  })
})