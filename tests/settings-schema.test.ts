/**
 * settings 命名空间 travel schema 单测（design §10.1 三组 / FR-8 绑定与持久化）。
 *
 * 用真实 dsh-settings-file provider（临时文档）验证：文档缺失回落 schema 默认、
 * 用户文档热读合并、secret role('secret') 脱敏（describe redact 面无明文）、
 * update 合并写保留未提及的 secret、mutate unset 删单个 Key。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { FileSettingsProvider as FSP } from '@deepseek-ai/dsh-settings-file'
import {
  TRAVEL_ADVANCED_DEFAULT, TRAVEL_CHANNELS_DEFAULT, TRAVEL_SETTINGS_NS,
  travelSettingsSchema,
} from '../src/settings/schema.js'

const NS = TRAVEL_SETTINGS_NS

interface Scratch {
  dir: string
  path: string
}

/** 临时 settings 文档（每用例独立目录）。 */
function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-travel-schema-'))
  return { dir, path: join(dir, 'settings.json') }
}

/** 建 provider（可选预写文档）并完成装载。 */
async function boot(doc: Record<string, unknown> | undefined): Promise<{ ctx: Context; scratch: Scratch }> {
  const sc = scratch()
  if (doc !== undefined) writeFileSync(sc.path, JSON.stringify(doc))
  const ctx = new Context()
  const settings = new FSP(ctx, { path: sc.path, watch: false })
  for await (const _phase of settings[Service.init]()) { /* 装载 */ }
  return { ctx, scratch: sc }
}

/** 用例清理：删临时目录（provider watch=false 无驻留句柄；cordis4 根 ctx 无公开 dispose）。 */
async function teardown(_ctx: Context, sc: Scratch): Promise<void> {
  rmSync(sc.dir, { recursive: true, force: true })
}

describe('travel settings schema：缺省值（§10.1 字面值）', () => {
  it('文档缺失 → channels/advanced 全文默认，keys 空', async () => {
    const { ctx, scratch: sc } = await boot(undefined)
    try {
      const settings = ctx.get('settings')
      const scope = settings.register(NS, travelSettingsSchema)
      const resolved = scope.get()
      expect(resolved.channels).toEqual(TRAVEL_CHANNELS_DEFAULT)
      expect(resolved.advanced).toEqual(TRAVEL_ADVANCED_DEFAULT)
      expect(resolved.keys).toEqual({})
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('渠道矩阵默认细节：xhsCloak/cityDidi 默认 off，其余 on', async () => {
    const { ctx, scratch: sc } = await boot(undefined)
    try {
      const settings = ctx.get('settings')
      const channels = settings.register(NS, travelSettingsSchema).get().channels
      expect(channels.fr3.xhsCloak).toBe(false)
      expect(channels.fr4.cityDidi).toBe(false)
      expect(channels.fr3.xhsMcp).toBe(true)
      expect(channels.fr4.rail12306).toBe(true)
      expect(channels.fr5.weatherAmap).toBe(true)
      expect(channels.fr7.mapLeaflet).toBe(true)
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('advanced 默认：socialDepth L1 / routePrefix /travel-plans / 预算 / amapSecurityMode A', async () => {
    const { ctx, scratch: sc } = await boot(undefined)
    try {
      const settings = ctx.get('settings')
      const advanced = settings.register(NS, travelSettingsSchema).get().advanced
      expect(advanced).toEqual(TRAVEL_ADVANCED_DEFAULT)
      expect(advanced.routePrefix).toBe('/travel-plans')
      expect(advanced.amapSecurityMode).toBe('A')
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('amapSecurityMode=B 可由 settings 热读取且不改变其它 advanced 默认', async () => {
    const { ctx, scratch: sc } = await boot({ travel: { advanced: { amapSecurityMode: 'B' } } })
    try {
      const settings = ctx.get('settings')
      const resolved = settings.register(NS, travelSettingsSchema).get()
      expect(resolved.advanced.amapSecurityMode).toBe('B')
      expect(resolved.advanced.defaultMapProvider).toBe('auto')
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('用户文档 → 部分覆盖保留其余默认（热读合并）', async () => {
    const { ctx, scratch: sc } = await boot({
      travel: {
        channels: { fr3: { douyin: false } },
        keys: { wendao: 'WENDAO-TOKEN-SECRET' },
        advanced: { socialDepth: 'L2' },
      },
    })
    try {
      const settings = ctx.get('settings')
      const resolved = settings.register(NS, travelSettingsSchema).get()
      expect(resolved.channels.fr3.douyin).toBe(false)
      expect(resolved.channels.fr3.xhsMcp).toBe(true) // 未覆盖字段保留默认
      expect(resolved.channels.fr4.rail12306).toBe(true)
      expect(resolved.keys.wendao).toBe('WENDAO-TOKEN-SECRET')
      expect(resolved.advanced.socialDepth).toBe('L2')
    } finally {
      await teardown(ctx, sc)
    }
  })
})

describe('secret role 脱敏（FR-8③：Key 持久化且无明文序列化面）', () => {
  it('describe(redactSecrets) 的值面与序列化面不含明文', async () => {
    const { ctx, scratch: sc } = await boot({ travel: { keys: { amapWebservice: 'AMAP-PLAIN-SECRET' } } })
    try {
      const settings = ctx.get('settings')
      settings.register(NS, travelSettingsSchema)
      const described = settings.describe({ redactSecrets: true })
      const serialized = JSON.stringify(described)
      expect(serialized).not.toContain('AMAP-PLAIN-SECRET')
      const travel = described.find((entry) => String(entry.ns) === 'travel')
      expect(travel).toBeDefined()
      expect(JSON.stringify(travel?.value)).not.toContain('AMAP-PLAIN-SECRET')
      expect(travel?.secrets?.some((s) => s.path.join('.') === 'keys.amapWebservice' && s.set)).toBe(true)
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('未配置的 secret（dict 条目缺省）无 sidecar 条目：表单据此渲染「未配置」', async () => {
    const { ctx, scratch: sc } = await boot({ travel: { keys: { amapWebservice: 'AMAP-PLAIN-SECRET' } } })
    try {
      const settings = ctx.get('settings')
      settings.register(NS, travelSettingsSchema)
      const travel = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === 'travel')
      // dict 只枚举有值的条目：wendao 未配置 → 无 sidecar 记录（客户端静态 KEY_FIELDS
      // 行 + 无记录 = 未配置）
      expect(travel?.secrets?.find((s) => s.path.join('.') === 'keys.wendao')).toBeUndefined()
      expect(travel?.secrets?.find((s) => s.path.join('.') === 'keys.amapWebservice')?.set).toBe(true)
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('update 合并写保留未提及的既有 secret（write-only 方向）', async () => {
    const { ctx, scratch: sc } = await boot({ travel: { keys: { wendao: 'WENDAO-PERSISTED' } } })
    try {
      const settings = ctx.get('settings')
      const scope = settings.register(NS, travelSettingsSchema)
      await scope.update({ keys: { amapWebservice: 'AMAP-NEW' } })
      expect(scope.get().keys.wendao).toBe('WENDAO-PERSISTED')
      expect(scope.get().keys.amapWebservice).toBe('AMAP-NEW')
      const after = JSON.stringify(settings.describe({ redactSecrets: true }))
      expect(after).not.toContain('WENDAO-PERSISTED')
      expect(after).not.toContain('AMAP-NEW')
    } finally {
      await teardown(ctx, sc)
    }
  })

  it('mutate unset 删除单个 Key → resolved keys 失去该键、其余保留', async () => {
    const { ctx, scratch: sc } = await boot({ travel: { keys: { wendao: 'WENDAO-PERSISTED', didi: 'DIDI-PERSISTED' } } })
    try {
      const settings = ctx.get('settings')
      const scope = settings.register(NS, travelSettingsSchema)
      await settings.mutate(NS, [{ op: 'unset', path: ['keys', 'wendao'] }])
      expect(scope.get().keys.wendao).toBeUndefined()
      expect(scope.get().keys.didi).toBe('DIDI-PERSISTED')
    } finally {
      await teardown(ctx, sc)
    }
  })
})