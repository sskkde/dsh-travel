import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore<T>(initial: T) {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      set: (next: T) => { value = next; for (const listener of listeners) listener() },
      update: (mutate: (draft: T) => void) => { mutate(value) },
    }
  },
}))
import type { ConfigForm, ConfigFormSnapshot, SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { TravelSettingsCardController, TRAVEL_SETTINGS_NAMESPACE } from '../src/client/form'
import { CHANNEL_FIELDS } from '../src/client/fields'
import { COMPANION_SERVICES_DEFAULT, type TravelSettings } from '../src/client/fields'

const NS = TRAVEL_SETTINGS_NAMESPACE

function allOnMatrix(): TravelSettings['channels'] {
  return {
    fr3: { xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true, tier2: true, tier3: true, socialL1: true, tencentPoi: true, platformIntel: true },
    fr4: { rail12306: true, railWendao: true, railFlyai: true, flightWendao: true, flightFlyai: true, busConsult: true, cityAmap: true, cityDidi: false },
    fr5: { weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true },
    fr6: { routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true },
    fr7: { mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true },
  }
}

function jsonMatrix(): Record<string, Record<string, boolean>> {
  const matrix = allOnMatrix()
  return { fr3: { ...matrix.fr3 }, fr4: { ...matrix.fr4 }, fr5: { ...matrix.fr5 }, fr6: { ...matrix.fr6 }, fr7: { ...matrix.fr7 } }
}

function defaultSettings(keys: Record<string, string> = {}): TravelSettings {
  return {
    channels: allOnMatrix(),
    keys,
    advanced: {
      socialDepth: 'L0', researchTimeoutMs: 10000, rateLimitPerDomain: 10,
      robotsToSCheck: true, routePrefix: '/travel-plans', defaultMapProvider: 'auto',
      amapSecurityMode: 'A', amapPoiBudgetPerPlan: 8, amapRestBudgetPerPlan: 10,
      profileTtlDays: 30, companionAutostart: false,
      companionServices: { ...COMPANION_SERVICES_DEFAULT },
    },
  }
}

function jsonAdvanced(value: TravelSettings['advanced']): Record<string, string | number | boolean | Record<string, boolean>> {
  return {
    socialDepth: value.socialDepth, researchTimeoutMs: value.researchTimeoutMs,
    rateLimitPerDomain: value.rateLimitPerDomain, robotsToSCheck: value.robotsToSCheck,
    routePrefix: value.routePrefix, defaultMapProvider: value.defaultMapProvider,
    amapSecurityMode: value.amapSecurityMode, amapPoiBudgetPerPlan: value.amapPoiBudgetPerPlan,
    amapRestBudgetPerPlan: value.amapRestBudgetPerPlan, profileTtlDays: value.profileTtlDays,
    companionAutostart: value.companionAutostart, companionServices: { ...value.companionServices },
  }
}

function nsView(revision: number, keys: Record<string, string> = {}): SettingsNamespaceView {
  return {
    autoGenerate: true,
    ns: NS,
    schema: {},
    value: { channels: jsonMatrix(), keys, advanced: jsonAdvanced(defaultSettings(keys).advanced) },
    revision,
    applies: 'live',
    secrets: Object.keys(keys).map((id) => ({ path: ['keys', id], set: true })),
  }
}

class FakeForm implements ConfigForm<TravelSettings> {
  snapshot: ConfigFormSnapshot<TravelSettings>
  operations: Array<{ ops: readonly SettingsPathOpView[]; revision?: number }> = []
  accept = true
  private listeners = new Set<() => void>()

  constructor(keys: Record<string, string> = {}) {
    this.snapshot = {
      status: 'ready',
      value: defaultSettings(keys),
      base: {},
      user: Object.keys(keys).length > 0 ? { keys } : {},
      revision: 1,
      writable: true,
      mode: 'host',
    }
  }
  getSnapshot(): ConfigFormSnapshot<TravelSettings> { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async set(_field: string, _value: unknown): Promise<boolean> { return this.accept }
  async unset(_field: string): Promise<boolean> { return this.accept }
  async mutate(ops: readonly SettingsPathOpView[], revision?: number): Promise<boolean> {
    this.operations.push({ ops, revision })
    if (this.accept) {
      this.snapshot = { ...this.snapshot, revision: (this.snapshot.revision ?? 0) + 1 }
      for (const listener of this.listeners) listener()
    }
    return this.accept
  }
}

class FakeMirror implements SettingsDescribeFace {
  private snapshot: SettingsMirrorSnapshot
  constructor(view: SettingsNamespaceView) {
    this.snapshot = { status: 'ready', view: { namespaces: [view], writable: true, hasDocument: true }, error: null }
  }
  getSnapshot(): SettingsMirrorSnapshot { return this.snapshot }
  subscribe(_listener: () => void): () => void { return () => {} }
  async ensure(): Promise<void> {}
  acceptView(view: SettingsNamespaceView): void {
    this.snapshot = { status: 'ready', view: { namespaces: [view], writable: true, hasDocument: true }, error: null }
  }
}

function setup(keys: Record<string, string> = {}) {
  const form = new FakeForm(keys)
  const mirror = new FakeMirror(nsView(1, keys))
  const controller = new TravelSettingsCardController(form, mirror)
  return { controller, form, face: controller.inject() }
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

describe('ConfigForm settings.section 写入', () => {
  it('toggle 一个渠道 → configForms.mutate 写单条原子路径', async () => {
    const { controller, form, face } = setup()
    face.edit('channels.fr3.tencentPoi', false)
    await controller.save()
    expect(form.operations).toHaveLength(1)
    expect(form.operations[0]?.ops).toEqual([{ op: 'set', path: ['channels', 'fr3', 'tencentPoi'], value: false }])
    expect(form.operations[0]?.revision).toBe(1)
    expect(controller.inject().hooks.travelCard.getSnapshot().dirty).toBe(false)
  })

  it('多组 edit 聚合到一次原子 mutate', async () => {
    const { controller, form, face } = setup()
    face.edit('channels.fr4.cityDidi', true)
    face.edit('advanced.routePrefix', '/x')
    await controller.save()
    expect(form.operations[0]?.ops).toEqual([
      { op: 'set', path: ['channels', 'fr4', 'cityDidi'], value: true },
      { op: 'set', path: ['advanced', 'routePrefix'], value: '/x' },
    ])
  })
})

describe('Key CRUD（secret write-only）', () => {
  it('新增 Key 只提交新值 set op', async () => {
    const { controller, form, face } = setup()
    face.edit('keys.wendao', 'NEW-WENDAO-TOKEN')
    await controller.save()
    expect(form.operations[0]?.ops).toEqual([{ op: 'set', path: ['keys', 'wendao'], value: 'NEW-WENDAO-TOKEN' }])
  })

  it('新增知乎 Key 只提交新值 set op', async () => {
    const { controller, form, face } = setup()
    face.edit('keys.zhihu', 'NEW-ZHIHU-SECRET')
    await controller.save()
    expect(form.operations[0]?.ops).toEqual([{ op: 'set', path: ['keys', 'zhihu'], value: 'NEW-ZHIHU-SECRET' }])
  })

  it('删除 Key 走 unset 路径操作', async () => {
    const { controller, form, face } = setup({ wendao: 'EXISTING' })
    face.clearKey('wendao', true)
    await controller.save()
    expect(form.operations[0]?.ops).toEqual([{ op: 'unset', path: ['keys', 'wendao'] }])
  })

  it('Key 输入留空 = 不改', async () => {
    const { controller, form, face } = setup({ wendao: 'EXISTING' })
    face.edit('keys.wendao', '')
    expect(controller.inject().hooks.travelCard.getSnapshot().dirty).toBe(false)
    await controller.save()
    expect(form.operations).toHaveLength(0)
  })

  it('Key 配置状态来自 secrets 边车，secret 不落 projection', () => {
    const { face } = setup({ amapWebservice: 'SECRET' })
    const state = face.hooks.travelCard.getSnapshot()
    expect(state.keys.find((key) => key.id === 'amapWebservice')?.configured).toBe(true)
    expect(JSON.stringify(state)).not.toContain('SECRET')
    expect(state.keys.find((key) => key.id === 'wendao')?.configured).toBe(false)
  })
})

describe('discard / 写失败保留', () => {
  it('discard 清空全部草稿', () => {
    const { controller, face } = setup()
    face.edit('channels.fr3.douyin', false)
    expect(face.hooks.travelCard.getSnapshot().dirty).toBe(true)
    face.discard()
    expect(face.hooks.travelCard.getSnapshot().dirty).toBe(false)
    expect(controller.inject().hooks.travelCard.getSnapshot().channels.fr3.douyin.text).toBe('true')
  })

  it('Host 拒绝 → failed=true 且草稿保留', async () => {
    const { controller, form, face } = setup()
    form.accept = false
    face.edit('channels.fr3.douyin', false)
    await controller.save()
    const state = face.hooks.travelCard.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.failedReason).toContain('did not accept')
  })
})

describe('NFR-10 冗余状态与确认', () => {
  function reduceFr3(face: ReturnType<typeof setup>['face']) {
    for (const id of ['xhsMcp', 'xhsFallback', 'douyin', 'tier2', 'tier3', 'platformIntel', 'socialL1']) {
      face.edit(`channels.fr3.${id}` as `channels.${'fr3'}.${string}`, false)
    }
  }

  it('草稿把 fr3 减到 1 个 → 冗余不足警告', () => {
    const { face } = setup()
    reduceFr3(face)
    expect(face.hooks.travelCard.getSnapshot().redundancyWarned).toBe(true)
    expect(face.hooks.travelCard.getSnapshot().redundancy.find((entry) => entry.group === 'fr3')?.enabled).toBe(1)
  })

  it('默认矩阵 → 无警示', () => {
    const { face } = setup()
    expect(face.hooks.travelCard.getSnapshot().redundancyWarned).toBe(false)
  })

  it('boolean advanced 字段用 set op 保存', async () => {
    const { controller, form, face } = setup()
    face.edit('advanced.robotsToSCheck', false)
    await controller.save()
    expect(form.operations[0]?.ops).toEqual([{ op: 'set', path: ['advanced', 'robotsToSCheck'], value: false }])
  })

  it('choice advanced 字段保存解析后的标量', async () => {
    const { controller, form, face } = setup()
    face.edit('advanced.amapSecurityMode', 'B')
    await controller.save()
    expect(form.operations[0]?.ops).toEqual([{ op: 'set', path: ['advanced', 'amapSecurityMode'], value: 'B' }])
  })

  it('冗余不足时阻止写入；确认仍保存后写入', async () => {
    const { controller, form, face } = setup()
    reduceFr3(face)
    await controller.save()
    expect(face.hooks.travelCard.getSnapshot().redundancyModal).toBe(true)
    expect(form.operations).toHaveLength(0)
    face.confirmSaveAnyway()
    await Promise.resolve()
    await Promise.resolve()
    expect(face.hooks.travelCard.getSnapshot().redundancyModal).toBe(false)
    expect(form.operations).toHaveLength(1)
    expect(form.operations[0]?.ops).toContainEqual({ op: 'set', path: ['channels', 'fr3', 'xhsMcp'], value: false })
  })

  it('取消冗余确认 → 关闭弹窗、不写、保留草稿', async () => {
    const { controller, form, face } = setup()
    for (const id of ['weatherAmap', 'weatherTencent', 'weatherOpenMeteo', 'adviceSearch']) face.edit(`channels.fr5.${id}` as `channels.${'fr5'}.${string}`, false)
    await controller.save()
    expect(face.hooks.travelCard.getSnapshot().redundancyModal).toBe(true)
    face.cancelRedundancy()
    expect(face.hooks.travelCard.getSnapshot().redundancyModal).toBe(false)
    expect(form.operations).toHaveLength(0)
    expect(face.hooks.travelCard.getSnapshot().dirty).toBe(true)
  })
})
