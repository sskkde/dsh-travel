/**
 * M3.6 client key-status 纯模块单测（vitest node 环境；不 fetch）。
 *
 * 覆盖：
 * - parseKeyStatus 形状守卫：合法 `{keys:{id:boolean}}` 接受（全量/部分 id）；
 *   缺 keys / 非对象 / 非布尔值 / 阵列 → undefined（既不抛也不误收）；
 * - mergeKeyConfigured 合并语义：settings 已配置 OR 远程 true；remote 缺失回落
 *   settings-only；
 * - path 字面量镜像一致性：client KEY_STATUS_PATH === 宿主 TRAVEL_KEY_STATUS_PATH。
 */
import { describe, expect, it } from 'vitest'
import { KEY_STATUS_PATH, parseKeyStatus, mergeKeyConfigured } from '../src/client/key-status'
import { TRAVEL_KEY_STATUS_PATH } from '../src/metrics/key-status.js'

describe('parseKeyStatus 形状守卫（双面状态，兼容旧 boolean）', () => {
  it('合法全量响应 → keys 映射（含 false 值保留）', () => {
    const parsed = parseKeyStatus({
      ns: 'travel',
      keys: {
        amapWebservice: { configured: true, channelEnabled: true },
        amapJsapi: { configured: false, channelEnabled: true },
        amapJscode: { configured: true, channelEnabled: true },
        wendao: { configured: true, channelEnabled: true },
        flyai: { configured: false, channelEnabled: true },
        didi: { configured: true, channelEnabled: true },
        tmap: { configured: false, channelEnabled: true },
        cloakbrowser: { configured: false, channelEnabled: true },
      },
    })
    expect(parsed).toEqual({
      amapWebservice: { configured: true, channelEnabled: true },
      amapJsapi: { configured: false, channelEnabled: true },
      amapJscode: { configured: true, channelEnabled: true },
      wendao: { configured: true, channelEnabled: true },
      flyai: { configured: false, channelEnabled: true },
      didi: { configured: true, channelEnabled: true },
      tmap: { configured: false, channelEnabled: true },
      cloakbrowser: { configured: false, channelEnabled: true },
    })
  })

  it('部分 id 子集 → 原样接受（未覆盖 id 按 undefined 回落）', () => {
    expect(parseKeyStatus({ keys: { wendao: { configured: true, channelEnabled: true } } })).toEqual({
      wendao: { configured: true, channelEnabled: true },
    })
    expect(parseKeyStatus({ keys: {} })).toEqual({})
  })

  it('旧版 boolean 响应仍可兼容解析，但新双面字段优先表达可用性', () => {
    expect(parseKeyStatus({ keys: { wendao: true } })).toEqual({
      wendao: { configured: true, channelEnabled: true, available: true },
    })
    expect(parseKeyStatus({ keys: { wendao: false } })).toEqual({
      wendao: { configured: false, channelEnabled: true, available: false },
    })
  })

  it('缺 keys / 非对象响应 → undefined', () => {
    expect(parseKeyStatus({})).toBeUndefined()
    expect(parseKeyStatus({ ns: 'travel' })).toBeUndefined()
    expect(parseKeyStatus(null)).toBeUndefined()
    expect(parseKeyStatus(undefined)).toBeUndefined()
    expect(parseKeyStatus(42)).toBeUndefined()
    expect(parseKeyStatus('payload')).toBeUndefined()
  })

  it('keys 非对象（数组/字符串）→ undefined', () => {
    expect(parseKeyStatus({ keys: [] })).toBeUndefined()
    expect(parseKeyStatus({ keys: 'nope' })).toBeUndefined()
    expect(parseKeyStatus({ keys: 7 })).toBeUndefined()
  })

  it('任一值非布尔（如 e2e 桩的 metrics JSON 形态、字符串值）→ 整包拒绝', () => {
    // 既有 e2e fixture 全局 fetch 桩：任何请求都回 metrics JSON（无 keys 字段）→ 静默回落
    const metricsLike = { month: '2026-09', amap: { quota: 1 }, entries: [] }
    expect(parseKeyStatus(metricsLike)).toBeUndefined()
    expect(parseKeyStatus({ keys: { wendao: 'yes-i-am-a-secret' } })).toBeUndefined()
    expect(parseKeyStatus({ keys: { wendao: 1 } })).toBeUndefined()
    expect(parseKeyStatus({ keys: { wendao: null } })).toBeUndefined()
  })
})

describe('mergeKeyConfigured（settings 已配置 OR 远程 configured）', () => {
  it('settings true 恒保持（remote 任意/缺失）', () => {
    expect(mergeKeyConfigured(true, undefined)).toBe(true)
    expect(mergeKeyConfigured(true, { configured: false, channelEnabled: false })).toBe(true)
    expect(mergeKeyConfigured(true, { configured: true, channelEnabled: true })).toBe(true)
  })

  it('settings false：远程 configured true 补位；渠道关闭不被误当成未配置', () => {
    expect(mergeKeyConfigured(false, { configured: true, channelEnabled: false })).toBe(true)
    expect(mergeKeyConfigured(false, { configured: false, channelEnabled: true })).toBe(false)
    expect(mergeKeyConfigured(false, undefined)).toBe(false)
    // 旧版 boolean 兼容不改变已有消费者语义。
    expect(mergeKeyConfigured(false, true)).toBe(true)
    expect(mergeKeyConfigured(false, false)).toBe(false)
  })
})

describe('path 字面量镜像一致性（client/node 单字面量约定）', () => {
  it('KEY_STATUS_PATH === 宿主 TRAVEL_KEY_STATUS_PATH', () => {
    expect(KEY_STATUS_PATH).toBe(TRAVEL_KEY_STATUS_PATH)
    expect(KEY_STATUS_PATH).toBe('/travel-key-status')
  })
})