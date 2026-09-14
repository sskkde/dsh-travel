/**
 * 渠道 Key 配置状态远程判定（M3.6：设置页「已配置」徽章补 credentials 层）。
 *
 * 宿主侧新增只读同源 `GET /travel-key-status`（src/metrics/key-status.ts）返回
 * `{ ns:'travel', keys:{ id:{configured:boolean,channelEnabled:boolean} } }`——每 id 按
 * 运行时 resolveKey 全链（settings→credentials→env）判定，并单独投影渠道开关。
 * 本模块把该判定带进设置卡：
 * - 类型 + 形状守卫 fetch（新响应要求双面布尔；旧 `{keys:{id:boolean}}` 仍兼容，其他响应/失败静默
 *   undefined——既有 e2e fixture 的全局 fetch 桩（任何请求都回 metrics JSON、
 *   无 keys 字段）因此自然回落 settings-only）；
 * - 纯合并函数：settings 已配置 OR 远程 `configured=true`（渠道关闭不抹除凭据事实；
 *   remote 缺失/未覆盖 → settings-only）。
 *
 * 零依赖约定（与 fields.ts / UsagePanel 同）：除浏览器 fetch 外不 import 任何
 * 模块；path 字面量 `/travel-key-status` 镜像宿主 TRAVEL_KEY_STATUS_PATH（单测
 * 断言一致）。响应零 secret（只布尔），本模块也不携带任何 key 值。
 */

/** key-status 路由（与 src/metrics/key-status.ts TRAVEL_KEY_STATUS_PATH 同字面量）。 */
export const KEY_STATUS_PATH = '/travel-key-status'

/** 远程判定结果：Key id → 凭据配置面 + 主渠道开关面。 */
export interface KeyStatusEntry {
  configured: boolean
  channelEnabled: boolean
  /** 旧版 boolean 响应兼容投影；新宿主响应不依赖该字段。 */
  available?: boolean
}
export type KeyStatusResult = Readonly<Record<string, KeyStatusEntry>>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 单键形状守卫：新面要求 configured/channelEnabled 双布尔；旧版 boolean 只作为
 * 兼容输入，映射为 configured=value、channelEnabled=true、available=value。
 */
function parseKeyStatusEntry(value: unknown): KeyStatusEntry | undefined {
  if (typeof value === 'boolean') {
    return { configured: value, channelEnabled: true, available: value }
  }
  if (!isPlainObject(value)) return undefined
  if (typeof value.configured !== 'boolean' || typeof value.channelEnabled !== 'boolean') return undefined
  if (value.available !== undefined && typeof value.available !== 'boolean') return undefined
  return {
    configured: value.configured,
    channelEnabled: value.channelEnabled,
    ...(value.available !== undefined ? { available: value.available } : {}),
  }
}

/**
 * 形状守卫：接受新 `{keys: {id:{configured:boolean,channelEnabled:boolean}}}`，并兼容
 * 旧 `{keys:{id:boolean}}`；keys 为普通对象且每个值合法，部分/全部 id 均可；
 * 多余字段如 ns 忽略。形状不符（含缺 keys / 非布尔值 / 非对象响应）→ undefined。
 */
export function parseKeyStatus(raw: unknown): KeyStatusResult | undefined {
  if (!isPlainObject(raw)) return undefined
  const keys = raw.keys
  if (!isPlainObject(keys)) return undefined
  const out: Record<string, KeyStatusEntry> = {}
  for (const [id, value] of Object.entries(keys)) {
    const entry = parseKeyStatusEntry(value)
    if (entry === undefined) return undefined
    out[id] = entry
  }
  return out
}

/**
 * 拉取远程 key 状态（挂载后一次；cache:'no-store' 与 UsagePanel 同款）。
 * 网络/HTTP/形状任一失败 → 静默 undefined（回落 settings-only，不打扰设置页）。
 * @param path - 同源路由（缺省 /travel-key-status；测试/定制注入）。
 */
export async function fetchKeyStatus(path = KEY_STATUS_PATH): Promise<KeyStatusResult | undefined> {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) return undefined
    const raw: unknown = await res.json().catch(() => undefined)
    return parseKeyStatus(raw)
  } catch {
    return undefined
  }
}

/**
 * 合并「已配置」判定：settings-only 已配置 OR 远程 `configured=true`。
 * `channelEnabled=false` 不会伪造为未配置；UI 的开关面由渠道状态单独表达。
 * remote 未获取/缺该 id → 回落 settings-only；旧版 boolean 仍按原语义兼容。
 */
export function mergeKeyConfigured(
  settingsConfigured: boolean,
  remote: KeyStatusEntry | boolean | undefined,
): boolean {
  if (settingsConfigured) return true
  return typeof remote === 'boolean' ? remote : remote?.configured === true
}
