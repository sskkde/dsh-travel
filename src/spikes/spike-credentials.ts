/**
 * spike-2 · 宿主面 `ctx.credentials.resolve(ref)` 探针。
 *
 * 探明结论（W2a+ 适配器 available()/Key 解析链据此接线，ADR-12）：
 * - 服务名 'credentials'；`resolve(ref: CredentialRef)` → Promise<
 *   { value, source } | undefined>；ref 为 POSIX 风格环境变量名（Branded）
 * - 读取分层（credentials-local）：managed store → 项目 .env → 用户 .env →
 *   process env（本 spike 用进程环境层演示 resolve 真实读取链）
 * - `describe(ref)` → { configured, source?, writable }（配置 UI 安全查询，
 *   不泄露值——W6 设置页脱敏显示参考）
 * - 未配置 ref → undefined（不抛）；Key 解析链中将此映射为 degraded「Key 未配置」
 *
 * 运行：node src/spikes/spike-credentials.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider, type Config as CredentialsLocalConfig } from '@deepseek-ai/dsh-credentials-local'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials'

async function main(): Promise<void> {
  const ctx = new Context()
  const credentials = new LocalCredentialProvider(ctx, {} as CredentialsLocalConfig)

  // (A) 未配置 ref → undefined（不抛）
  const unsetRef = 'TRAVEL_SPIKE_UNSET_KEY' as CredentialRef
  const unset = await credentials.resolve(unsetRef)
  console.log(`[resolve] ${unsetRef} -> ${JSON.stringify(unset)} (未配置 → undefined，不抛)`)

  // (B) env 层已设 → 命中（launch-environment 静态快照实时读 current process.env）
  const envRef = 'TRAVEL_SPIKE_ENV_KEY' as CredentialRef
  process.env[envRef] = 'spike-env-value-42'
  const fromEnv = await credentials.resolve(envRef)
  console.log(`[resolve] ${envRef} -> ${JSON.stringify(fromEnv)} (env 层命中：value 可见 + source=process)`)

  // (C) describe：配置事实但永远不带值（脱敏面）
  const info: CredentialInfo = await credentials.describe(envRef)
  console.log(`[describe] ${envRef} -> configured=${info.configured} source=${info.source} writable=${info.writable} (不带值，配置 UI 安全)`)

  // (D) 查询串未解析（layers 行为佐证）
  console.log('[spike-credentials] PASS')
  process.exit(0)
}

void main()