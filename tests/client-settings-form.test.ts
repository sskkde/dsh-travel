/**
 * 设置卡控制器单测（client 半 form.ts，假 scope/mirror/wire）。
 *
 * 验证控制器契约（与上一级 settings 语义测试串联）：
 * - 草稿 → 组聚合保存：channels 整组 merge patch、keys patch write-only、
 *   unset 走 mutate 路径操作（删除 Key）
 * - secret 值只出现在 update patch keys（write-only 方向），不进 projection
 * - NFR-10 冗余警示状态（基于草稿合并矩阵，软校验）
 * - discard 清空草稿；failed 状态保留草稿
 */
import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RpcResult, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-client-connection/client'
import { TravelSettingsCardController, TRAVEL_SETTINGS_NAMESPACE, type TravelSettingsWire } from '../src/client/form'
import { CHANNEL_FIELDS } from '../src/client/fields'
import type { TravelSettings } from '../src/client/fields'

const NS = TRAVEL_SETTINGS_NAMESPACE

/** 一个就绪的命名空间 wire view。 */
function nsView(revision: number, keys = {}): SettingsNamespaceView {
  return {
    ns: NS,
    schema: {},
    value: { channels: allOnMatrix(), keys, advanced: {} },
    revision,
    applies: 'live',
    secrets: Object.entries(keys).map(([id]) => ({ path: ['keys', id], set: true })),
  }
}

function allOnMatrix(): TravelSettings['channels'] {
  return {
    fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, socialL1: true, tencentPoi: true, platformIntel: true },
    fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
    fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
    fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
    fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
  }
}

describe('设置页折叠 fixture', () => {
  it('fr3.socialL1 默认开启，FR-3 显示 8/9（xhsCloak 默认关闭）', () => {
    const matrix = allOnMatrix()
    const fr3 = CHANNEL_FIELDS.filter((definition) => definition.group === 'fr3')
    expect(matrix.fr3.socialL1).toBe(true)
    expect(fr3).toHaveLength(9)
    expect(fr3.filter((definition) => matrix.fr3[definition.id])).toHaveLength(8)
  })
})

/** 假 settings scope（写记录不落地；revision 固定 1）。 */
class FakeScope implements SettingsScope<TravelSettings> {
  constructor(private snapshot: SettingsScopeSnapshot<TravelSettings>) {}
  getSnapshot(): SettingsScopeSnapshot<TravelSettings> {
    return this.snapshot
  }
  subscribe(_listener: () => void): () => void {
    return () => {}
  }
  async set(_field: string, _value: unknown): Promise<void> {}
  async unset(_field: string): Promise<void> {}
}

/** 假 describe mirror（带 travel 命名空间的 secrets 边车）。 */
class FakeMirror implements SettingsDescribeFace {
  private snapshot: SettingsMirrorSnapshot
  constructor(view: SettingsNamespaceView) {
    this.snapshot = { status: 'ready', view: { namespaces: [view], writable: true, hasDocument: true }, error: null }
  }
  getSnapshot(): SettingsMirrorSnapshot {
    return this.snapshot
  }
  subscribe(_listener: () => void): () => void {
    return () => {}
  }
  async ensure(): Promise<void> {}
  acceptView(view: SettingsNamespaceView): void {
    this.snapshot = { status: 'ready', view: { namespaces: [view], writable: true, hasDocument: true }, error: null }
  }
}

/** 假 wire：记录所有写调用并按序应答 revision。 */
class FakeWire implements TravelSettingsWire {
  updates: Array<{ ns: string; patch: object; expectedRevision?: number }> = []
  mutates: Array<{ ns: string; ops: readonly SettingsPathOpView[]; expectedRevision?: number }> = []
  revision = 1

  async update(payload: { ns: string; patch: object; expectedRevision?: number }): Promise<{ result: RpcResult<SettingsNamespaceView> }> {
    this.updates.push(payload)
    this.revision += 1
    return { result: { ok: true, value: nsView(this.revision) } }
  }
  async mutate(payload: { ns: string; ops: readonly SettingsPathOpView[]; expectedRevision?: number }): Promise<{ result: RpcResult<SettingsNamespaceView> }> {
    this.mutates.push(payload)
    this.revision += 1
    return { result: { ok: true, value: nsView(this.revision) } }
  }
}

function setup(keys: Record<string, string> = {}) {
  const scope = new FakeScope({
    status: 'ready',
    value: { channels: allOnMatrix(), keys, advanced: {} },
    base: {},
    user: Object.keys(keys).length > 0 ? { keys } : {},
    revision: 1,
    writable: true,
    mode: 'host',
  })
  const mirror = new FakeMirror(nsView(1, keys))
  const wire = new FakeWire()
  const controller = new TravelSettingsCardController(scope, mirror, wire)
  return { controller, wire, face: controller.inject() }
}

describe('渠道开关草稿 → 组聚合保存（FR-8② 保存即生效的写面）', () => {
  it('toggle 一个渠道 → save 走一次 update，patch.channels 精确到组', async () => {
    const { controller, wire, face } = setup()
    face.edit('channels.fr3.tencentPoi', false)
    await controller.save()
    expect(wire.updates).toHaveLength(1)
    expect(wire.updates[0]?.ns).toBe(NS)
    expect(wire.updates[0]?.patch).toEqual({ channels: { fr3: { tencentPoi: false } } })
    expect(wire.mutates).toHaveLength(0)
    // 草稿落地 → 不再 dirty
    expect(controller.inject().hooks.travelCard.getSnapshot().dirty).toBe(false)
  })

  it('多组 edit → 单次 update 聚合三组 patch（channels/advanced）', async () => {
    const { controller, wire, face } = setup()
    face.edit('channels.fr4.cityDidi', true)
    face.edit('advanced.routePrefix', '/x')
    await controller.save()
    expect(wire.updates).toHaveLength(1)
    expect(wire.updates[0]?.patch).toEqual({
      channels: { fr4: { cityDidi: true } },
      advanced: { routePrefix: '/x' },
    })
  })
})

describe('Key CRUD（FR-8③：新增/删除；secret write-only）', () => {
  it('新增 Key：edit(keys.wendao, token) → save 写入 keys patch（write-only 方向）', async () => {
    const { controller, wire, face } = setup()
    face.edit('keys.wendao', 'NEW-WENDAO-TOKEN')
    await controller.save()
    expect(wire.updates[0]?.patch).toEqual({ keys: { wendao: 'NEW-WENDAO-TOKEN' } })
  })

  it('新增知乎 Key：edit(keys.zhihu, secret) → save 写入 keys patch（write-only 方向）', async () => {
    const { controller, wire, face } = setup()
    face.edit('keys.zhihu', 'NEW-ZHIHU-SECRET')
    await controller.save()
    expect(wire.updates[0]?.patch).toEqual({ keys: { zhihu: 'NEW-ZHIHU-SECRET' } })
  })

  it('删除 Key：clearKey → save 走 mutate unset 路径操作（不重写 keys 组）', async () => {
    const { controller, wire, face } = setup({ wendao: 'EXISTING' })
    face.clearKey('wendao', true)
    await controller.save()
    expect(wire.updates).toHaveLength(0)
    expect(wire.mutates).toHaveLength(1)
    expect(wire.mutates[0]?.ops).toEqual([{ op: 'unset', path: ['keys', 'wendao'] }])
  })

  it('Key 输入留空 = 不改（空草稿不入写、不 unset）', async () => {
    const { controller, wire, face } = setup({ wendao: 'EXISTING' })
    face.edit('keys.wendao', '')
    expect(controller.inject().hooks.travelCard.getSnapshot().dirty).toBe(false)
    await controller.save()
    expect(wire.updates).toHaveLength(0)
    expect(wire.mutates).toHaveLength(0)
  })

  it('Key 配置状态来自 describe secrets 边车（值不落 projection）', () => {
    const { face } = setup({ amapWebservice: 'SECRET' })
    const state = face.hooks.travelCard.getSnapshot()
    const row = state.keys.find((key) => key.id === 'amapWebservice')
    expect(row?.configured).toBe(true)
    expect(JSON.stringify(state)).not.toContain('SECRET')
    const unset = state.keys.find((key) => key.id === 'wendao')
    expect(unset?.configured).toBe(false)
  })
})

describe('discard / 失败保留', () => {
  it('discard 清空全部草稿', () => {
    const { controller, face } = setup()
    face.edit('channels.fr3.douyin', false)
    expect(face.hooks.travelCard.getSnapshot().dirty).toBe(true)
    face.discard()
    expect(face.hooks.travelCard.getSnapshot().dirty).toBe(false)
    expect(controller.inject().hooks.travelCard.getSnapshot().channels.fr3.douyin.text).toBe('true')
  })

  it('wire 拒绝 → failed=true 且草稿保留', async () => {
    const scope = new FakeScope({
      status: 'ready', value: { channels: allOnMatrix(), keys: {}, advanced: {} }, base: {},
      user: {}, revision: 1, writable: true, mode: 'host',
    })
    const mirror = new FakeMirror(nsView(1))
    const wire = {
      updates: [],
      mutates: [],
      revision: 1,
      async update(): Promise<{ result: RpcResult<SettingsNamespaceView> }> {
        return { result: { ok: false, error: { code: 'settings-rejected', message: 'schema rejected', details: { ns: NS } } } }
      },
      async mutate(): Promise<{ result: RpcResult<SettingsNamespaceView> }> {
        return { result: { ok: false, error: { code: 'settings-rejected', message: 'schema rejected', details: { ns: NS } } } }
      },
    }
    const controller = new TravelSettingsCardController(scope, mirror, wire)
    const face = controller.inject()
    face.edit('channels.fr3.douyin', false)
    await controller.save()
    const state = face.hooks.travelCard.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true) // 草稿保留供修正
    expect(state.failedReason).toBe('schema rejected')
  })
})

describe('NFR-10 冗余状态（软校验口）', () => {
  it('草稿把 fr3 减到 1 个 → redundancyWarned=true（但保存不拦截）', async () => {
    const { face } = setup()
    face.edit('channels.fr3.xhsMcp', false)
    face.edit('channels.fr3.xhsFallback', false)
    face.edit('channels.fr3.douyin', false)
    face.edit('channels.fr3.tier2', false)
    face.edit('channels.fr3.tier3', false)
    face.edit('channels.fr3.platformIntel', false)
    face.edit('channels.fr3.socialL1', false)
    const state = face.hooks.travelCard.getSnapshot()
    expect(state.redundancyWarned).toBe(true)
    expect(state.redundancy.find((entry) => entry.group === 'fr3')?.enabled).toBe(1)
  })

  it('默认矩阵 → 无警示', () => {
    const { face } = setup()
    expect(face.hooks.travelCard.getSnapshot().redundancyWarned).toBe(false)
  })
})
describe('W8 设置页 v2（advanced 镜像补齐 + NFR-10 弹窗化）', () => {
  it('toggle 字段：robotsToSCheck checkbox → save 写布尔（镜像补齐位）', async () => {
    const { controller, wire, face } = setup()
    face.edit('advanced.robotsToSCheck', false)
    await controller.save()
    expect(wire.updates[0]?.patch).toEqual({ advanced: { robotsToSCheck: false } })
  })

  it('choice 字段：amapSecurityMode=A/B（镜像补齐位）', async () => {
    const { controller, wire, face } = setup()
    face.edit('advanced.amapSecurityMode', 'B')
    await controller.save()
    expect(wire.updates[0]?.patch).toEqual({ advanced: { amapSecurityMode: 'B' } })
  })

  it('NFR-10 弹窗：冗余不足 save → 拦截弹窗不写；confirmSaveAnyway → 强制写入', async () => {
    const { controller, wire, face } = setup()
    face.edit('channels.fr3.xhsMcp', false)
    face.edit('channels.fr3.xhsFallback', false)
    face.edit('channels.fr3.douyin', false)
    face.edit('channels.fr3.tier2', false)
    face.edit('channels.fr3.tier3', false)
    face.edit('channels.fr3.platformIntel', false)
    face.edit('channels.fr3.socialL1', false)
    await controller.save()
    let state = face.hooks.travelCard.getSnapshot()
    expect(state.redundancyModal).toBe(true)
    expect(wire.updates).toHaveLength(0)
    face.confirmSaveAnyway()
    await Promise.resolve()
    await Promise.resolve()
    state = face.hooks.travelCard.getSnapshot()
    expect(state.redundancyModal).toBe(false)
    expect(wire.updates).toHaveLength(1)
    expect((wire.updates[0]?.patch as { channels: { fr3: Record<string, boolean> } }).channels.fr3.xhsMcp).toBe(false)
  })

  it('NFR-10 弹窗：cancelRedundancy → 关弹窗、不写、草稿保留', async () => {
    const { controller, wire, face } = setup()
    face.edit('channels.fr5.weatherAmap', false)
    face.edit('channels.fr5.weatherTencent', false)
    face.edit('channels.fr5.weatherOpenMeteo', false)
    face.edit('channels.fr5.adviceSearch', false)
    // fr5 只剩 0 个 <2 → 弹窗
    await controller.save()
    expect(face.hooks.travelCard.getSnapshot().redundancyModal).toBe(true)
    face.cancelRedundancy()
    const state = face.hooks.travelCard.getSnapshot()
    expect(state.redundancyModal).toBe(false)
    expect(wire.updates).toHaveLength(0)
    expect(state.dirty).toBe(true)
  })
})
