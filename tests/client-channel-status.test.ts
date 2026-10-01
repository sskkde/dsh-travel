/** 渠道三层状态 client 纯模块单测（不触网）。 */
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_STATUS_PATH,
  buildChannelStatusRows,
  fetchChannelStatus,
  mergeChannelStatus,
  parseChannelStatus,
} from '../src/client/channel-status'
import { TRAVEL_CHANNEL_STATUS_PATH } from '../src/metrics/channel-status.js'

const readiness = {
  state: 'ready' as const,
  keyId: 'wendao',
  keyConfigured: true,
  envVar: 'TRAVEL_WENDAO_ENDPOINT',
  endpoint: 'https://wendao-skill-prod.ctrip.com/skill/query',
  endpointSource: 'default' as const,
}

const valid = {
  ns: 'dsh-travel' as const,
  generatedAt: '2026-09-10T00:00:00.000Z',
  probe: 'health' as const,
  config: { railWendao: { enabled: true }, rail12306: { enabled: false } },
  readiness: { railWendao: readiness },
  runtime: {
    railWendao: { state: 'not-probed' as const, cost: 'metered' as const, reason: 'quota_guarded' as const, costLabel: '消耗 1 次问道日额度（30/日）' },
    rail12306: { state: 'reachable' as const, cost: 'free' as const, latencyMs: 11 },
  },
  companions: [{ service: 'rail12306', mode: 'local-process' as const, managedBySession: true, childAlive: true, pid: 123, startsInWindow: 1 }],
  notes: ['静态'],
}

describe('parseChannelStatus 形状守卫', () => {
  it('接受完整三层响应，并保留 false/未探配额保护', () => {
    expect(parseChannelStatus(valid)).toEqual(valid)
  })

  it('兼容旧 config boolean；缺少 runtime 时保持合法静态响应', () => {
    const parsed = parseChannelStatus({
      ns: 'dsh-travel', generatedAt: 'now', probe: 'none',
      config: { rail12306: true },
      readiness: { rail12306: { state: 'no-key-required', endpoint: 'http://127.0.0.1:8123/mcp', endpointSource: 'default' } },
      notes: [],
    })
    expect(parsed?.config.rail12306).toEqual({ enabled: true })
    expect(parsed?.runtime).toBeUndefined()
  })

  it('拒绝旧 key-status 响应、错误 ns、缺 readiness 与畸形嵌套值', () => {
    expect(parseChannelStatus({ ns: 'dsh-travel', keys: {} })).toBeUndefined()
    expect(parseChannelStatus({ ...valid, ns: 'other' })).toBeUndefined()
    expect(parseChannelStatus({ ...valid, readiness: undefined })).toBeUndefined()
    expect(parseChannelStatus({ ...valid, config: { railWendao: 'yes' } })).toBeUndefined()
    expect(parseChannelStatus({ ...valid, readiness: { railWendao: { ...readiness, endpointSource: 'bad' } } })).toBeUndefined()
    expect(parseChannelStatus({ ...valid, runtime: { railWendao: { state: 'not-probed', cost: 'metered', reason: 'wrong' } } })).toBeUndefined()
    expect(parseChannelStatus({ ...valid, companions: [{ service: 'rail12306', mode: 'local-process', managedBySession: true, childAlive: true, startsInWindow: '1' }] })).toBeUndefined()
  })
})

describe('mergeChannelStatus 三层→行视图', () => {
  it('按完整响应合并，并把 runtime 缺失明确映射为未检测', () => {
    const rows = buildChannelStatusRows(parseChannelStatus(valid), ['railWendao', 'missing'])
    expect(rows.railWendao).toMatchObject({
      id: 'railWendao', enabled: true, readinessState: 'ready', keyConfigured: true,
      runtimeState: 'not-probed', runtimeCost: 'metered', runtimeReason: 'quota_guarded',
    })
    expect(rows.missing).toMatchObject({ id: 'missing', runtimeState: 'not-probed' })
    expect(mergeChannelStatus(undefined, 'unknown')).toMatchObject({ id: 'unknown', runtimeState: 'not-probed' })
  })

  it('也可直接合并三个分量', () => {
    expect(mergeChannelStatus('cityDidi', { enabled: false }, {
      state: 'missing-key', endpoint: 'http://127.0.0.1:8124/mcp', endpointSource: 'default',
    }, { state: 'unreachable', cost: 'free', detail: 'HTTP 401' })).toMatchObject({
      id: 'cityDidi', enabled: false, readinessState: 'missing-key', runtimeState: 'unreachable',
    })
  })
})

describe('fetchChannelStatus 请求面', () => {
  it('none 不带 probe；health/full 显式带 probe，HTTP/JSON 失败静默', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => ({ ...valid, probe: url.includes('probe=health') ? 'health' : 'none' }) }
    }))
    const none = await fetchChannelStatus('none', '/status')
    const health = await fetchChannelStatus('health', '/status')
    expect(none?.probe).toBe('none')
    expect(health?.probe).toBe('health')
    expect(calls).toEqual(['/status', '/status?probe=health'])

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => valid })))
    expect(await fetchChannelStatus('full', '/status')).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('path 字面量镜像一致性', () => {
  it('CHANNEL_STATUS_PATH === TRAVEL_CHANNEL_STATUS_PATH', () => {
    expect(CHANNEL_STATUS_PATH).toBe(TRAVEL_CHANNEL_STATUS_PATH)
    expect(CHANNEL_STATUS_PATH).toBe('/travel-channel-status')
  })
})
