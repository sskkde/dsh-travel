/**
 * 适配器层治理——来源白名单 / 可选源开关 / 许可证据门（W0 T4，草稿 H）。
 *
 * - sources 白名单 = 已登记渠道集（INTEL_CHANNELS + 适配器渠道）。工具级请求的
 *   sources 不在白名单 → 明确拒绝（不借追加检索扩大登录授权；未知源不得被
 *   「同源封装/相似名」通融）。
 * - 新外部源 / 可选提取器（DIDA 酒店、Trafilatura、OSM…）一律显式开关默认 off：
 *   `optionalSourceEnabled` 与 `channelEnabled`（默认 on）的安全侧相反，须在
 *   settings 或 env 显式开启才放行。
 * - 许可证据门：5A 混合上游许可未核实 → 仅自造 fixture，不导入/分发真实数据；
 *   真实快照显式导入数据目录、不随 npm 包打包。
 */
import { INTEL_CHANNELS } from '../../models/types.js'
import type { KeyResolutionEnv } from '../base.js'
import { SourceGovernanceError } from '../../errors.js'

/** 适配器层已登记渠道（intel 渠道集之外的传输/气象/搜索适配器）。 */
export const ADAPTER_SOURCES = [
  'amap', 'rail12306', 'open-meteo', 'search-l0',
] as const

/** sources 白名单 = 已登记渠道集（唯一权威；新渠道必须同时登记进这里才可用）。 */
export const REGISTERED_SOURCES: readonly string[] = [...INTEL_CHANNELS, ...ADAPTER_SOURCES]

/** 白名单判定（未知源明确列出）。 */
export interface SourceWhitelistDecision {
  ok: boolean
  reasonCode?: 'unknown_source'
  /** 未知源清单（保序去重）。 */
  unknown?: string[]
  /** 允许集（已登记渠道）。 */
  allowed: readonly string[]
}

/**
 * sources 白名单校验：unknown 源逐项列出（不静默忽略）；undefined/空 = 放行
 * （适配器自选默认渠道，调用方未越权指定）。
 */
export function checkSourcesWhitelist(requested: readonly string[] | undefined): SourceWhitelistDecision {
  const allowed = REGISTERED_SOURCES
  if (requested === undefined || requested.length === 0) return { ok: true, allowed }
  const unknown = [...new Set(requested)].filter((source) => !allowed.includes(source))
  if (unknown.length > 0) {
    return { ok: false, reasonCode: 'unknown_source', unknown, allowed }
  }
  return { ok: true, allowed }
}

/** 白名单断言版：请求含未知源 → 抛 SourceGovernanceError(unknown_source)。 */
export function assertSourcesAllowed(sources: readonly string[] | undefined): void {
  const decision = checkSourcesWhitelist(sources)
  if (!decision.ok) {
    throw new SourceGovernanceError(
      'unknown_source',
      `来源不在白名单（已登记渠道集）：${(decision.unknown ?? []).join(', ')}；允许：${decision.allowed.join(', ')}`,
    )
  }
}

/**
 * 可选源显式开关（默认 off，安全侧与 channelEnabled 相反）：
 * settings `channels.<name>`（经 env.ts CHANNEL_SETTINGS_PATHS 映射）或
 * env `TRAVEL_CHANNEL_<NAME>` 显式开启（'on'/'true'/'1'）才放行；off 形态
 * （'off'/'false'/'0'/''/未配置）一律关闭。
 */
export function optionalSourceEnabled(name: string, env?: KeyResolutionEnv): boolean {
  const candidates: Array<string | undefined> = [
    env?.readSettings?.(`channels.${name}`),
    (env?.env ?? process.env)[`TRAVEL_CHANNEL_${name.toUpperCase()}`],
  ]
  for (const raw of candidates) {
    if (raw === undefined) continue
    const v = String(raw).trim().toLowerCase()
    if (v === 'on' || v === 'true' || v === '1') return true
    if (v === 'off' || v === 'false' || v === '0' || v === '') return false
  }
  return false // 缺省 off（与 channelEnabled 显式相反：新外部源默认关闭）
}

// ────────────────────────── 许可证据门 ──────────────────────────

/**
 * 许可未核实的数据源（5A 景区点为混合上游聚合，许可边界未核实）。
 * 这些源只允许自造 fixture / 显式导入数据目录，禁止当作已授权真实数据
 * 导入/分发（真实快照不随 npm 包打包，草稿 H）。
 */
export const UNVERIFIED_LICENSE_SOURCES = ['5a-scenic', '5a'] as const

/** 许可证据门判定。 */
export interface LicenseGateDecision {
  ok: boolean
  reasonCode?: 'unverified_license'
  reason?: string
}

/** 许可证据门：许可未核实 → 拒绝（仅 fixture 允许，不引入真实数据）。 */
export function licenseEvidenceGate(source: string): LicenseGateDecision {
  if ((UNVERIFIED_LICENSE_SOURCES as readonly string[]).includes(source)) {
    return {
      ok: false,
      reasonCode: 'unverified_license',
      reason: `上游 ${source} 许可未核实：仅自造 fixture，不导入/分发真实数据`,
    }
  }
  return { ok: true }
}

/** 许可断言版：未核实许可源 → 抛 SourceGovernanceError(unverified_license)。 */
export function assertLicenseAllowed(source: string): void {
  const decision = licenseEvidenceGate(source)
  if (!decision.ok) {
    throw new SourceGovernanceError('unverified_license', decision.reason ?? `许可证据不足：${source}`)
  }
}