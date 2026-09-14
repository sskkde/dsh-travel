/**
 * spike-3 · 宿主面 settings 命名空间读取探针（settingsNamespace('/settings')）。
 *
 * 探明结论（W6 设置页与 Key 解析链 settings 位据此接线，ADR-12）：
 * - 服务名 'settings'；`ctx.settings` 为 SettingsProvider（dsh-settings）
 * - `settingsNamespace('travel')` 声明命名空间；`register(ns, z-schema, opts)`
 *   → SettingsScope{ get(), watch(), update(patch), replace(section) }
 * - 存储端 dsh-settings-file：一个 YAML/JSON 文档（path 可显式指定）；
 *   register 时按 schema+基线合成 resolved 值；update 落盘用户层（热读取）
 * - 文档缺失 → 各命名空间回落 schema 默认；外部编辑由 publish 热发布
 *
 * 运行：node src/spikes/spike-settings.ts
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider, type Config as SettingsFileConfig } from '@deepseek-ai/dsh-settings-file'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

// 运行期文档：workspace 内 scratch 目录（W6 前不触碰真实 $DSH_HOME/settings.yaml）
const FILE = join(process.cwd(), '.dsh-spike-settings', 'settings.json')

async function main(): Promise<void> {
  const TravelSchema = z.object({
    channels: z.object({
      tencentPoi: z.boolean(),
      amap: z.boolean(),
      social: z.boolean(),
    }),
    keys: z.object({
      amapWebservice: z.string(),
    }),
    advanced: z.object({
      maxConcurrentSources: z.natural(),
    }),
  })

  // (A) 无文档 → 命名空间回落 schema 默认（构造最小文档前先验默认面）
  const ctxA = new Context()
  const settingsA = new FileSettingsProvider(ctxA, { path: FILE, watch: false } satisfies SettingsFileConfig)
  for await (const _phase of settingsA[Service.init]()) { /* 装载 */ }
  const scopeA = settingsA.register(settingsNamespace('travel'), TravelSchema)
  console.log(`[get] 无文档默认 -> ${JSON.stringify(scopeA.get())}`)

  // (B) 用户文档 → 命名空间读用户值
  mkdirSync(join(process.cwd(), '.dsh-spike-settings'), { recursive: true })
  writeFileSync(FILE, JSON.stringify({
    travel: {
      channels: { tencentPoi: true, amap: false, social: true },
      keys: { amapWebservice: 'REMOVED-SPIKE-NOT-REAL' },
      advanced: { maxConcurrentSources: 5 },
    },
  }))
  const ctxB = new Context()
  const settingsB = new FileSettingsProvider(ctxB, { path: FILE, watch: false } satisfies SettingsFileConfig)
  for await (const _phase of settingsB[Service.init]()) { /* 装载 */ }
  const scopeB = settingsB.register(settingsNamespace('travel'), TravelSchema)
  const resolved = scopeB.get()
  console.log(`[get] 用户文档 -> ${JSON.stringify(resolved)}`)
  console.log(`[get] 读取单个键 channels.tencentPoi=${resolved.channels.tencentPoi} keys.amapWebservice=${JSON.stringify(resolved.keys.amapWebservice)}`)

  // (C) update 落盘（settings→credentials→env 链的 settings 位演示：写即热生效）
  await scopeB.update({ channels: { tencentPoi: false } })
  const after = scopeB.get()
  console.log(`[update] tencentPoi=false -> ${JSON.stringify(after.channels)} (未补字段 amap/social 保留)`)

  console.log('[spike-settings] PASS')
  process.exit(0)
}

void main()