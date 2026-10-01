/**
 * 渠道三层状态 client 面（零依赖）。
 *
 * 除浏览器 fetch 外不依赖 host/client 包：path 字面量与
 * src/metrics/channel-status.ts 保持镜像，响应先过严格形状守卫；网络失败或
 * 旧/畸形响应一律返回 undefined，设置卡继续显示已有 settings/key 状态。
 */

/** 与 host TRAVEL_CHANNEL_STATUS_PATH 同字面量。 */
export const CHANNEL_STATUS_PATH = '/travel-channel-status'

export type ChannelProbe = 'none' | 'health' | 'full'
export type ChannelReadinessState = 'ready' | 'missing-key' | 'missing-binary' | 'no-key-required'
export type ChannelRuntimeState = 'reachable' | 'unreachable' | 'not-probed' | 'not-applicable'

export interface ChannelStatusConfigEntry {
  enabled: boolean
}

export interface ChannelStatusReadinessEntry {
  state: ChannelReadinessState
  keyId?: string
  keyConfigured?: boolean
  envVar?: string
  keyEnvVar?: string
  endpoint: string
  endpointSource: 'env-override' | 'default'
}

export interface ChannelStatusRuntimeEntry {
  state: ChannelRuntimeState
  detail?: string
  latencyMs?: number
  cost: 'free' | 'metered'
  reason?: 'quota_guarded'
  costLabel?: string
}

export interface ChannelStatusCompanionEntry {
  service: string
  mode: 'local-process' | 'docker' | 'remote'
  managedBySession: boolean
  childAlive: boolean
  pid?: number
  startsInWindow?: number
}

export interface ChannelStatusResult {
  ns: 'dsh-travel'
  generatedAt: string
  probe: ChannelProbe
  config: Readonly<Record<string, ChannelStatusConfigEntry>>
  readiness: Readonly<Record<string, ChannelStatusReadinessEntry>>
  runtime?: Readonly<Record<string, ChannelStatusRuntimeEntry>>
  companions?: readonly ChannelStatusCompanionEntry[]
  notes: readonly string[]
}

export interface ChannelStatusRowView {
  id: string
  enabled?: boolean
  readinessState?: ChannelReadinessState
  keyId?: string
  keyConfigured?: boolean
  envVar?: string
  keyEnvVar?: string
  endpoint?: string
  endpointSource?: 'env-override' | 'default'
  /** 缺少 runtime（初始/none probe）明确映射为 not-probed，而非故障。 */
  runtimeState: ChannelRuntimeState
  runtimeDetail?: string
  latencyMs?: number
  runtimeCost: 'free' | 'metered'
  runtimeReason?: 'quota_guarded'
  costLabel?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validProbe(value: unknown): value is ChannelProbe {
  return value === 'none' || value === 'health' || value === 'full'
}

function validReadiness(value: unknown): value is ChannelReadinessState {
  return value === 'ready' || value === 'missing-key' || value === 'missing-binary' || value === 'no-key-required'
}

function validRuntime(value: unknown): value is ChannelRuntimeState {
  return value === 'reachable' || value === 'unreachable' || value === 'not-probed' || value === 'not-applicable'
}

function isConfigEntry(value: unknown): value is ChannelStatusConfigEntry {
  return isPlainObject(value) && typeof value.enabled === 'boolean'
}

function parseConfigEntry(value: unknown): ChannelStatusConfigEntry | undefined {
  if (typeof value === 'boolean') return { enabled: value }
  return isConfigEntry(value) ? { enabled: value.enabled } : undefined
}

function parseReadinessEntry(value: unknown): ChannelStatusReadinessEntry | undefined {
  if (!isPlainObject(value) || !validReadiness(value.state) || typeof value.endpoint !== 'string') return undefined
  if (value.keyId !== undefined && typeof value.keyId !== 'string') return undefined
  if (value.keyConfigured !== undefined && typeof value.keyConfigured !== 'boolean') return undefined
  if (value.envVar !== undefined && typeof value.envVar !== 'string') return undefined
  if (value.keyEnvVar !== undefined && typeof value.keyEnvVar !== 'string') return undefined
  if (value.endpointSource !== 'env-override' && value.endpointSource !== 'default') return undefined
  return {
    state: value.state,
    ...(value.keyId === undefined ? {} : { keyId: value.keyId }),
    ...(value.keyConfigured === undefined ? {} : { keyConfigured: value.keyConfigured }),
    ...(value.envVar === undefined ? {} : { envVar: value.envVar }),
    ...(value.keyEnvVar === undefined ? {} : { keyEnvVar: value.keyEnvVar }),
    endpoint: value.endpoint,
    endpointSource: value.endpointSource,
  }
}

function parseRuntimeEntry(value: unknown): ChannelStatusRuntimeEntry | undefined {
  if (!isPlainObject(value) || !validRuntime(value.state)) return undefined
  if (value.cost !== 'free' && value.cost !== 'metered') return undefined
  if (value.detail !== undefined && typeof value.detail !== 'string') return undefined
  if (value.latencyMs !== undefined && !isFiniteNumber(value.latencyMs)) return undefined
  if (value.reason !== undefined && value.reason !== 'quota_guarded') return undefined
  if (value.costLabel !== undefined && typeof value.costLabel !== 'string') return undefined
  return {
    state: value.state,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.latencyMs === undefined ? {} : { latencyMs: value.latencyMs }),
    cost: value.cost,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.costLabel === undefined ? {} : { costLabel: value.costLabel }),
  }
}

function parseRecord<T>(value: unknown, parseEntry: (entry: unknown) => T | undefined): Record<string, T> | undefined {
  if (!isPlainObject(value)) return undefined
  const out: Record<string, T> = {}
  for (const [id, entry] of Object.entries(value)) {
    const parsed = parseEntry(entry)
    if (parsed === undefined) return undefined
    out[id] = parsed
  }
  return out
}

function parseCompanions(value: unknown): ChannelStatusCompanionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ChannelStatusCompanionEntry[] = []
  for (const item of value) {
    if (!isPlainObject(item)
      || typeof item.service !== 'string'
      || (item.mode !== 'local-process' && item.mode !== 'docker' && item.mode !== 'remote')
      || typeof item.managedBySession !== 'boolean'
      || typeof item.childAlive !== 'boolean'
      || (item.startsInWindow !== undefined && !isFiniteNumber(item.startsInWindow))
      || (item.pid !== undefined && !isFiniteNumber(item.pid))) return undefined
    out.push({
      service: item.service,
      mode: item.mode,
      managedBySession: item.managedBySession,
      childAlive: item.childAlive,
      ...(item.pid === undefined ? {} : { pid: item.pid }),
      startsInWindow: item.startsInWindow ?? 0,
    })
  }
  return out
}

/**
 * 新响应形状守卫：config/readiness 为必需对象；兼容 config.<id>=boolean 的旧投影，
 * 其余未知字段忽略。缺字段、枚举/类型不符、runtime 半合法均整包拒绝。
 */
export function parseChannelStatus(raw: unknown): ChannelStatusResult | undefined {
  if (!isPlainObject(raw) || raw.ns !== 'dsh-travel') return undefined
  if (typeof raw.generatedAt !== 'string' || !validProbe(raw.probe)) return undefined
  const config = parseRecord(raw.config, parseConfigEntry)
  const readiness = parseRecord(raw.readiness, parseReadinessEntry)
  if (config === undefined || readiness === undefined) return undefined

  let runtime: Record<string, ChannelStatusRuntimeEntry> | undefined
  if (raw.runtime !== undefined) {
    runtime = parseRecord(raw.runtime, parseRuntimeEntry)
    if (runtime === undefined) return undefined
  }
  let companions: ChannelStatusCompanionEntry[] | undefined
  if (raw.companions !== undefined) {
    companions = parseCompanions(raw.companions)
    if (companions === undefined) return undefined
  }
  const notes = raw.notes
  if (notes !== undefined && (!Array.isArray(notes) || notes.some((note) => typeof note !== 'string'))) return undefined

  return {
    ns: 'dsh-travel',
    generatedAt: raw.generatedAt,
    probe: raw.probe,
    config,
    readiness,
    ...(runtime === undefined ? {} : { runtime }),
    ...(companions === undefined ? {} : { companions }),
    notes: notes === undefined ? [] : notes.filter((note): note is string => typeof note === 'string'),
  }
}

function pathAndProbe(probeOrPath: ChannelProbe | string, path: string | undefined): { probe: ChannelProbe; path: string } {
  if (probeOrPath.startsWith('/')) return { probe: 'none', path: probeOrPath }
  return { probe: validProbe(probeOrPath) ? probeOrPath : 'none', path: path ?? CHANNEL_STATUS_PATH }
}

/**
 * 拉取状态；仅 health/full 会把 probe 参数带到 host，默认 none 不探活。
 * 网络/HTTP/形状任一失败 → undefined 静默回落。
 */
export function fetchChannelStatus(path?: string): Promise<ChannelStatusResult | undefined>
export function fetchChannelStatus(probe: ChannelProbe, path?: string): Promise<ChannelStatusResult | undefined>
export async function fetchChannelStatus(probeOrPath: ChannelProbe | string = 'none', path = CHANNEL_STATUS_PATH): Promise<ChannelStatusResult | undefined> {
  const request = pathAndProbe(probeOrPath, path)
  try {
    const url = request.probe === 'none'
      ? request.path
      : `${request.path}${request.path.includes('?') ? '&' : '?'}probe=${encodeURIComponent(request.probe)}`
    const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!response.ok) return undefined
    const raw: unknown = await response.json().catch(() => undefined)
    return parseChannelStatus(raw)
  } catch {
    return undefined
  }
}

function rowFromParts(
  id: string,
  config: ChannelStatusConfigEntry | undefined,
  readiness: ChannelStatusReadinessEntry | undefined,
  runtime: ChannelStatusRuntimeEntry | undefined,
): ChannelStatusRowView {
  return {
    id,
    ...(config === undefined ? {} : { enabled: config.enabled }),
    ...(readiness === undefined ? {} : {
      readinessState: readiness.state,
      ...(readiness.keyId === undefined ? {} : { keyId: readiness.keyId }),
      ...(readiness.keyConfigured === undefined ? {} : { keyConfigured: readiness.keyConfigured }),
      ...(readiness.envVar === undefined ? {} : { envVar: readiness.envVar }),
      ...(readiness.keyEnvVar === undefined ? {} : { keyEnvVar: readiness.keyEnvVar }),
      endpoint: readiness.endpoint,
      endpointSource: readiness.endpointSource,
    }),
    runtimeState: runtime?.state ?? 'not-probed',
    ...(runtime?.detail === undefined ? {} : { runtimeDetail: runtime.detail }),
    ...(runtime?.latencyMs === undefined ? {} : { latencyMs: runtime.latencyMs }),
    runtimeCost: runtime?.cost ?? 'free',
    ...(runtime?.reason === undefined ? {} : { runtimeReason: runtime.reason }),
    ...(runtime?.costLabel === undefined ? {} : { costLabel: runtime.costLabel }),
  }
}

/** 从完整响应合并一个渠道行（缺 runtime 明确是 not-probed）。 */
export function mergeChannelStatus(status: ChannelStatusResult | undefined, id: string): ChannelStatusRowView
/** 从三层分量合并一个渠道行。 */
export function mergeChannelStatus(
  id: string,
  config?: ChannelStatusConfigEntry,
  readiness?: ChannelStatusReadinessEntry,
  runtime?: ChannelStatusRuntimeEntry,
): ChannelStatusRowView
export function mergeChannelStatus(
  first: ChannelStatusResult | string | undefined,
  second?: string | ChannelStatusConfigEntry,
  third?: ChannelStatusReadinessEntry,
  fourth?: ChannelStatusRuntimeEntry,
): ChannelStatusRowView {
  if (typeof first === 'string') {
    return rowFromParts(first, isConfigEntry(second) ? second : undefined, third, fourth)
  }
  const id = typeof second === 'string' ? second : ''
  return rowFromParts(id, first?.config[id], first?.readiness[id], first?.runtime?.[id])
}

/** 批量把完整响应合并为 id→展示行；ids 缺省取 config/readiness 并集。 */
export function mergeChannelStatusRows(status: ChannelStatusResult | undefined, ids?: readonly string[]): Record<string, ChannelStatusRowView> {
  const keys = ids === undefined
    ? [...new Set([...Object.keys(status?.config ?? {}), ...Object.keys(status?.readiness ?? {})])]
    : [...ids]
  const out: Record<string, ChannelStatusRowView> = {}
  for (const id of keys) out[id] = mergeChannelStatus(status, id)
  return out
}

/** 语义别名，便于设置卡/调用方按“视图模型”命名。 */
export const buildChannelStatusRows = mergeChannelStatusRows
