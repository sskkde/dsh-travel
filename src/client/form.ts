/**
 * 设置卡控制器（settingsScope 读写 / save·discard / NFR-10 冗余校验软警示）。
 *
 * 数据流（与官方设置表面同构）：
 * - 读：`scope`（settingsScope.bind({namespace:'travel'})）持解析快照（channels/
 *   advanced）；Key 的「已配置」状态取自共享 describe mirror 的 secrets 边车
 *   （secret 值从不回显，只给 path+set 标志）。
 * - 写：`api.settings.update`（**merge 语义**：只带用户改动的字段，未提及的
 *   既有值——含 secret——原样保留）＋ `api.settings.mutate`（unset 路径操作，
 *   删除 Key/恢复默认）。revision 围栏逐写刷新，防陈旧写被拒。
 * - 保存：把草稿按三组聚合成 ≤2 次 wire 调用；先跑 NFR-10 冗余校验（软：
 *   任一组启用渠道 <2 只给警示，不拦截保存——弹窗化属 M2.8 v2）。
 *
 * secret 语义：`keys.*` 一律 write-only——输入框只写新值，留空=不改；
 * 删除点 `×` 即 unset 该字段。明文永不出现在任何序列化面（宿主侧
 * describe 已 redact；本控制器也无保留）。
 */
import type { SnapshotStore, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RpcResult, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-client-connection/client'
import {
  ADVANCED_FIELDS, CHANNEL_FIELDS, CHANNEL_GROUPS, COMPANION_SERVICE_IDS, KEY_FIELDS,
  COMPANION_SERVICES_DEFAULT,
  redundancyReport, hasInsufficientRedundancy,
  type ChannelGroup, type CompanionServiceId, type TravelChannelMatrix, type TravelSettings,
  type RedundancyReport,
} from './fields'

/** settings 命名空间（与 node 侧注册 + 卡 key 同值）。 */
export const TRAVEL_SETTINGS_NAMESPACE = 'travel'

/** 草稿寻址路径：channels.<group>.<field> / keys.<id> / advanced.<id>。 */
export type TravelEditPath =
  | `channels.${ChannelGroup}.${string}`
  | `keys.${string}`
  | `advanced.${string}`

/** 一个字段的渲染态。 */
export interface TravelCardFieldState {
  /** 草稿/解析值文本（布尔开关渲染成 'true'/'false'；数字/文本为原文）。 */
  text: string
  /** settings 用户层是否已覆盖该字段（供「恢复默认」标注）。 */
  overridden: boolean
  /** 草稿是否非法（数字/枚举解析失败 → 阻止保存）。 */
  invalid: boolean
}

/** 一个 Key 行的渲染态（secret，write-only）。 */
export interface TravelKeyRowState {
  id: string
  /** 当前是否已配置（来自 describe mirror secrets 边车 set 标志）。 */
  configured: boolean
  /** 草稿输入（新值）。 */
  draft: string
  /** 是否标记为删除（未配置态 + 草稿为空 → 保存即 unset）。 */
  clearing: boolean
}

/** 卡片外壳态 + 三组渲染态（注入 face 的 snapshot）。 */
export interface TravelCardState {
  /** 命名空间是否已就绪（ready）。 */
  available: boolean
  /** 命名空间是否被宿主服务（false → notExposed 文案）。 */
  exposed: boolean
  /** 宿主文档是否可写。 */
  writable: boolean
  /** 是否有未保存草稿。 */
  dirty: boolean
  /** 保存是否在途。 */
  saving: boolean
  /** 最近一次保存是否未落地。 */
  failed: boolean
  /** 宿主拒绝原因（可选）。 */
  failedReason?: string
  /** 是否触发过 NFR-10 冗余警示（软；仍允许保存）。 */
  redundancyWarned: boolean
  /** NFR-10 冗余不足确认弹窗（保存时拦截；仍要保存=显式强制）。 */
  redundancyModal: boolean
  /** NFR-10 报告（按 FR 组）。 */
  redundancy: readonly RedundancyReport[]
  /** 渠道矩阵字段（channels.<group>.<field>）。 */
  channels: Record<ChannelGroup, Record<string, TravelCardFieldState>>
  /** Key 行。 */
  keys: TravelKeyRowState[]
  /** 高级字段。 */
  advanced: Record<string, TravelCardFieldState>
  /** 伴随服务自动拉起总开关（M3.5；默认关=与 M2 行为一致）。 */
  companionAutostart: TravelCardFieldState
  /** 伴随服务 per-service 拉起开关（M3.5；autostart 关闭时无效果）。 */
  companionServices: Record<CompanionServiceId, TravelCardFieldState>
}

/** 注册侧注入 face（hooks + 动作）。 */
export interface TravelSettingsCardFace {
  hooks: {
    /** 渲染器绑定的卡片快照 selector。 */
    travelCard: SnapshotStore<TravelCardState>
  }
  /** 编辑一个字段草稿（checkbox: 传新布尔；文本/数字: 传输入串）。 */
  edit(path: TravelEditPath, value: boolean | string): void
  /** 标记/取消标记删除一个 Key。 */
  clearKey(id: string, clearing: boolean): void
  /** 保存全部草稿（组聚合 wire 写；冗余不足 → 弹窗确认而非直写）。 */
  save(): void
  /** 弹窗内「仍要保存」（强制越过 NFR-10 软警示）。 */
  confirmSaveAnyway(): void
  /** 弹窗内「返回修改」。 */
  cancelRedundancy(): void
  /** 丢弃全部草稿。 */
  discard(): void
}

/** 一组 staged 编辑的落地形态。 */
type StagedEdit = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** client 面缺省（宿主 schema 默认的镜像；未就绪时兜底渲染用）。 */
const CHANNELS_DEFAULT: TravelChannelMatrix = {
  fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, tencentPoi: true, platformIntel: true, socialL1: true },
  fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
  fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
  fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
  fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
}

/** 数字/枚举/文本字段草稿解析（非法 → undefined → invalid 阻塞保存）。 */
function parseDraft(def: (typeof ADVANCED_FIELDS)[number], text: string): unknown | undefined {
  const trimmed = text.trim()
  if (def.kind === 'toggle') return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined
  if (def.kind === 'text') return trimmed === '' ? undefined : trimmed
  if (def.kind === 'choice') return trimmed === '' ? undefined : (def.choices as readonly string[]).includes(trimmed) ? trimmed : undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return undefined
  if (def.integer && !Number.isInteger(value)) return undefined
  if (value < def.min) return undefined
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 describe mirror 的 secrets 边车读取某 Key 的配置标志。 */
function keyConfigured(viewNamespaces: readonly SettingsNamespaceView[] | undefined, id: string): boolean {
  const ns = viewNamespaces?.find((view) => String(view.ns) === TRAVEL_SETTINGS_NAMESPACE)
  return ns?.secrets?.some((secret) => secret.path.length === 2 && secret.path[0] === 'keys' && secret.path[1] === id && secret.set) === true
}

/** 从嵌套值按路径取原始用户覆盖标志（user 层 hasOwnProperty）。 */
function stored(user: unknown, path: readonly string[]): boolean {
  let node: unknown = user
  for (const segment of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return false
    node = node[segment]
  }
  return true
}

/** 字符串化布尔/数字/文本（渲染与表单复用）。 */
function textOf(value: unknown): string {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

/**
 * settings wire 写面（结构对齐 IApiClient['settings']，payload-direct——
 * dsh-client-connection fetch/client 的绑定签名；rpcId 由 carrier 层填充）。
 */
export interface TravelSettingsWire {
  update(payload: { ns: string; patch: object; expectedRevision?: number }): Promise<{ result: RpcResult<SettingsNamespaceView> }>
  mutate(payload: { ns: string; ops: readonly SettingsPathOpView[]; expectedRevision?: number }): Promise<{ result: RpcResult<SettingsNamespaceView> }>
}

/**
 * 控制器生命周期与整个卡注册同纤维：构造即订阅 scope+mirror，
 * 卡注销时（slots.inject disposer）必须调用 dispose()。
 */
export class TravelSettingsCardController {
  private readonly scope: SettingsScope<TravelSettings>
  private readonly mirror: SettingsDescribeFace
  private readonly api: TravelSettingsWire
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private readonly disposeScope: () => void
  private readonly disposeMirror: () => void
  private disposed = false
  private saving = false
  private failed = false
  private failedReason: string | undefined
  private redundancyModal = false

  constructor(scope: SettingsScope<TravelSettings>, mirror: SettingsDescribeFace, api: TravelSettingsWire) {
    this.scope = scope
    this.mirror = mirror
    this.api = api
    this.disposeScope = scope.subscribe(() => this.publish())
    this.disposeMirror = mirror.subscribe(() => this.publish())
  }

  /** 释放订阅与监听（卡注销时调用；重复调用无害）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeScope()
    this.disposeMirror()
    this.listeners.clear()
  }

  /** 注入 face：快照 store + 表单动作。 */
  inject(): TravelSettingsCardFace {
    const store = this.bind(this.projection())
    return {
      hooks: { travelCard: store },
      edit: (path, value) => {
        // Key 输入清空 = 不改（删除只能走 clearKey 显式操作）
        if (typeof value === 'string' && value.trim() === '' && path.startsWith('keys.')) {
          this.staged.delete(path)
        } else {
          this.staged.set(path, { kind: 'set', value })
        }
        this.publish()
      },
      clearKey: (id, clearing) => {
        if (clearing) this.staged.set(`keys.${id}`, { kind: 'clear' })
        else this.staged.delete(`keys.${id}`)
        this.publish()
      },
      save: () => { void this.save() },
      confirmSaveAnyway: () => {
        this.redundancyModal = false
        void this.save({ force: true })
      },
      cancelRedundancy: () => {
        this.redundancyModal = false
        this.publish()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.failedReason = undefined
        this.publish()
      },
    }
  }

  // ── 投影 ──

  private bind<S>(initial: S): SnapshotStore<S> {
    const store = createSnapshotStore(initial)
    this.listeners.add(() => { store.set(this.projection() as S) })
    return store
  }

  private snapshotOf(): { value?: TravelSettings; user?: unknown; revision?: number; status: string; writable: boolean } {
    const snapshot = this.scope.getSnapshot()
    return {
      value: snapshot.value,
      user: snapshot.user,
      revision: snapshot.revision,
      status: snapshot.status,
      writable: snapshot.writable,
    }
  }

  /** 草稿合并后的渠道矩阵（冗余校验与开关渲染共用）。 */
  private effectiveChannels(): TravelChannelMatrix {
    const current = this.snapshotOf().value?.channels ?? CHANNELS_DEFAULT
    const merged: TravelChannelMatrix = {
      fr3: { ...current.fr3 },
      fr4: { ...current.fr4 },
      fr5: { ...current.fr5 },
      fr6: { ...current.fr6 },
      fr7: { ...current.fr7 },
    }
    for (const [path, edit] of this.staged) {
      if (!path.startsWith('channels.')) continue
      const [, group, field] = path.split('.')
      const target = merged[group as ChannelGroup]
      if (edit.kind === 'set' && typeof edit.value === 'boolean') target[field] = edit.value
      else if (edit.kind === 'set' && typeof edit.value === 'string') target[field] = edit.value === 'true'
    }
    return merged
  }

  private projection(): TravelCardState {
    const { value, user, status, writable } = this.snapshotOf()
    const exposed = status === 'ready'
    const channels = this.effectiveChannels()
    const redundancy = redundancyReport(channels)
    const channelState: TravelCardState['channels'] = {} as TravelCardState['channels']
    for (const group of CHANNEL_GROUPS) {
      const rows: Record<string, TravelCardFieldState> = {}
      for (const def of CHANNEL_FIELDS.filter((item) => item.group === group)) {
        const path = `channels.${group}.${def.id}` as TravelEditPath
        const staged = this.staged.get(path)
        const effective = staged?.kind === 'set' ? staged.value : channels[group][def.id]
        const overridePath = ['channels', group, def.id]
        rows[def.id] = {
          text: textOf(effective),
          overridden: stored(user, overridePath),
          invalid: false,
        }
      }
      channelState[group] = rows
    }
    const namespaces = this.mirror.getSnapshot().view?.namespaces
    const keys: TravelKeyRowState[] = KEY_FIELDS.map((def) => {
      const staged = this.staged.get(`keys.${def.id}`)
      return {
        id: def.id,
        configured: keyConfigured(namespaces, def.id),
        draft: staged?.kind === 'set' && typeof staged.value === 'string' ? staged.value : '',
        clearing: staged?.kind === 'clear',
      }
    })
    const advanced: TravelCardState['advanced'] = {}
    for (const def of ADVANCED_FIELDS) {
      const path = `advanced.${def.id}` as TravelEditPath
      const staged = this.staged.get(path)
      const effective = staged?.kind === 'set' ? staged.value : value?.advanced?.[def.id] ?? textOf(undefined)
      advanced[def.id] = {
        text: textOf(effective),
        overridden: staged?.kind === 'set' || stored(user, ['advanced', def.id]),
        invalid: staged?.kind === 'set' && typeof staged.value === 'string' && parseDraft(def, staged.value) === undefined,
      }
    }
    // M3.5 伴随服务块（专用分支：companionAutostart 总开关 + per-service 开关，
    // 不走 ADVANCED_FIELDS 通用表——嵌套 companionServices 需要专用写面）
    const advancedValue = value?.advanced
    const companionAutostartStaged = this.staged.get('advanced.companionAutostart')
    const companionAutostartEffective = companionAutostartStaged?.kind === 'set'
      ? companionAutostartStaged.value
      : advancedValue?.companionAutostart ?? false
    const companionAutostart = {
      text: textOf(companionAutostartEffective),
      overridden: companionAutostartStaged?.kind === 'set' || stored(user, ['advanced', 'companionAutostart']),
      invalid: false,
    }
    const companionServices = {} as Record<CompanionServiceId, TravelCardFieldState>
    for (const id of COMPANION_SERVICE_IDS) {
      const path = `advanced.companionServices.${id}` as TravelEditPath
      const staged = this.staged.get(path)
      const stagedValue = staged?.kind === 'set' && typeof staged.value === 'boolean' ? staged.value : undefined
      const effective = stagedValue ?? advancedValue?.companionServices?.[id] ?? COMPANION_SERVICES_DEFAULT[id]
      companionServices[id] = {
        text: textOf(effective),
        overridden: staged?.kind === 'set' || stored(user, ['advanced', 'companionServices', id]),
        invalid: false,
      }
    }
    const dirty = this.staged.size > 0
    return {
      available: status !== 'loading',
      exposed,
      writable,
      dirty,
      saving: this.saving,
      failed: this.failed,
      failedReason: this.failedReason,
      redundancyWarned: hasInsufficientRedundancy(channels),
      redundancyModal: this.redundancyModal,
      redundancy,
      channels: channelState,
      keys,
      advanced,
      companionAutostart,
      companionServices,
    }
  }

  // ── 保存 ──

  /** 草稿 → 组聚合 patch 与 unset 操作。 */
  private planWrites(): { patch: PlannedPatch; unsets: Array<{ op: 'unset'; path: string[] }>; invalid: boolean } {
    const channelsPatch: Record<string, Record<string, unknown>> = {}
    const keysPatch: Record<string, unknown> = {}
    const advancedPatch: Record<string, unknown> = {}
    const unsets: Array<{ op: 'unset'; path: string[] }> = []
    let invalid = false
    for (const [path, edit] of this.staged) {
      if (path.startsWith('channels.')) {
        const [, group, field] = path.split('.')
        if (edit.kind === 'set' && typeof edit.value === 'boolean') {
          ;(channelsPatch[group] ??= {})[field] = edit.value
        } else {
          unsets.push({ op: 'unset', path: ['channels', group, field] })
        }
      } else if (path.startsWith('keys.')) {
        const id = path.slice('keys.'.length)
        if (edit.kind === 'clear') {
          unsets.push({ op: 'unset', path: ['keys', id] })
        } else if (typeof edit.value === 'string' && edit.value.trim() !== '') {
          // 只写非空新值；留空=不改（secret write-only）
          keysPatch[id] = edit.value.trim()
        }
      } else if (path.startsWith('advanced.')) {
        const rest = path.slice('advanced.'.length)
        // M3.5 伴随服务块（专用写面：companionAutostart 平铺布尔 + companionServices 嵌套对象）
        if (rest === 'companionAutostart') {
          if (edit.kind === 'set' && typeof edit.value === 'boolean') advancedPatch[rest] = edit.value
          else unsets.push({ op: 'unset', path: ['advanced', rest] })
        } else if (rest.startsWith('companionServices.')) {
          const serviceId = rest.slice('companionServices.'.length)
          if (edit.kind === 'set' && typeof edit.value === 'boolean') {
            const bucket = (advancedPatch.companionServices ??= {}) as Record<string, boolean>
            bucket[serviceId] = edit.value
          } else if (edit.kind === 'clear') {
            unsets.push({ op: 'unset', path: ['advanced', 'companionServices', serviceId] })
          }
        } else {
          const def = ADVANCED_FIELDS.find((item) => item.id === rest)
          if (edit.kind === 'set') {
            const parsed = typeof edit.value === 'string' && def !== undefined ? parseDraft(def, edit.value) : edit.value
            if (parsed === undefined) invalid = true
            else advancedPatch[rest] = parsed
          } else {
            unsets.push({ op: 'unset', path: ['advanced', rest] })
          }
        }
      }
    }
    const patch: PlannedPatch = {}
    if (Object.keys(channelsPatch).length > 0) patch.channels = channelsPatch
    if (Object.keys(keysPatch).length > 0) patch.keys = keysPatch
    if (Object.keys(advancedPatch).length > 0) patch.advanced = advancedPatch
    return { patch, unsets, invalid }
  }

  /**
   * 写全部草稿（组聚合 ≤2 次 wire 调用），NFR-10 只警示不拦截（软校验）。
   * 落地的字段清草稿；未落地保留供修正。UI 动作走 void 包装；测试可直接 await。
   */
  async save(opts: { force?: boolean } = {}): Promise<void> {
    const snapshot = this.snapshotOf()
    if (!snapshot.writable || this.saving || snapshot.status !== 'ready') return
    const plan = this.planWrites()
    if (this.staged.size === 0 || plan.invalid || (!hasPatch(plan.patch) && plan.unsets.length === 0)) return
    // NFR-10 弹窗化（v2）：冗余不足 → 拦截并弹确认（「仍要保存」显式强制越过）；
    // 硬校验（字段 invalid）不受 force 影响。
    if (!opts.force && hasInsufficientRedundancy(this.effectiveChannels())) {
      this.redundancyModal = true
      this.publish()
      return
    }
    this.redundancyModal = false
    this.saving = true
    this.failed = false
    this.failedReason = undefined
    this.publish()
    const landed = new Set<string>()
    try {
      let revision: number | undefined = snapshot.revision
      let failedReason: string | undefined
      if (hasPatch(plan.patch)) {
        const response = await this.api.update({
          ns: TRAVEL_SETTINGS_NAMESPACE,
          patch: plan.patch,
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
        if (!response.result.ok) {
          failedReason = response.result.error.message
        } else {
          revision = response.result.value.revision
          for (const path of this.staged.keys()) {
            if (path.startsWith('channels.') || path.startsWith('advanced.')) landed.add(path)
          }
          for (const id of Object.keys(plan.patch.keys ?? {})) landed.add(`keys.${id}`)
        }
      }
      if (plan.unsets.length > 0 && failedReason === undefined) {
        const response = await this.api.mutate({
          ns: TRAVEL_SETTINGS_NAMESPACE,
          ops: plan.unsets,
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
        if (!response.result.ok) failedReason = response.result.error.message
        else for (const op of plan.unsets) landed.add(op.path.join('.'))
      }
      if (failedReason !== undefined) this.failedReason = failedReason
    } catch (error) {
      this.failedReason = error instanceof Error ? error.message : String(error)
    }
    for (const path of [...this.staged.keys()]) {
      if (landed.has(path)) this.staged.delete(path)
    }
    this.saving = false
    this.failed = this.staged.size > 0
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 一组拟保存字段（update merge patch 的分组形状）。 */
interface PlannedPatch {
  channels?: Record<string, Record<string, unknown>>
  keys?: Record<string, unknown>
  advanced?: Record<string, unknown>
}

function hasPatch(patch: PlannedPatch): boolean {
  return patch.channels !== undefined || patch.keys !== undefined || patch.advanced !== undefined
}