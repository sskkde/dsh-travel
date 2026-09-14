/**
 * 设置卡字段定义（design §10.1 三组字段表）＋ NFR-10 冗余校验纯逻辑。
 *
 * 本文件零运行时依赖（不 import 宿主/运行时包）：字段表与冗余校验可被
 * vitest 直接单测，也被 form.ts/SettingsCard.tsx 共用。
 *
 * 结构类型是 src/settings/schema.ts 的 client 面镜像（client 半不得依赖
 * 宿主包；命名空间 travel 的契约双方各自持有，改动须同步）。
 */

/** FR × channel 开关矩阵（结构镜像 node 侧 TravelChannelMatrix；
 *  组内以 Record<string,boolean> 承载——按渠道 id 读写的扁平面，客户端无需
 *  逐字段判别联合）。 */
export interface TravelChannelMatrix {
  fr3: Record<string, boolean>
  fr4: Record<string, boolean>
  fr5: Record<string, boolean>
  fr6: Record<string, boolean>
  fr7: Record<string, boolean>
}

/** 渠道 Key 集合（结构镜像）。 */
export interface TravelKeySet {
  amapWebservice?: string
  amapJsapi?: string
  amapJscode?: string
  wendao?: string
  flyai?: string
  zhihu?: string
  didi?: string
  tmap?: string
  cloakbrowser?: string
}

/** 伴随服务 id（M3.5；与 node 侧 TravelCompanionServices 键一一对应）。 */
export const COMPANION_SERVICE_IDS = ['rail12306', 'xhs', 'playwright', 'didi'] as const
export type CompanionServiceId = (typeof COMPANION_SERVICE_IDS)[number]

/** 伴随服务 per-service 开关缺省（与 node 侧 TRAVEL_COMPANION_SERVICES_DEFAULT 同值）。 */
export const COMPANION_SERVICES_DEFAULT: Record<CompanionServiceId, boolean> = {
  rail12306: true,
  xhs: true,
  playwright: true,
  didi: true,
}

/** 高级配置（结构镜像；M3.5 增伴随服务拉起开关）。 */
export interface TravelAdvancedSettings {
  socialDepth: 'L0' | 'L1' | 'L2'
  researchTimeoutMs: number
  rateLimitPerDomain: number
  /** robots/ToS 检查开关（W1 node schema 已有；v2 镜像补齐）。 */
  robotsToSCheck: boolean
  routePrefix: string
  defaultMapProvider: 'auto' | 'amap' | 'leaflet'
  /** 高德安全密钥模式 A/B（W7 node schema 已有；v2 镜像补齐）。 */
  amapSecurityMode: 'A' | 'B'
  amapPoiBudgetPerPlan: number
  amapRestBudgetPerPlan: number
  profileTtlDays: number
  /**
   * 伴随服务按需自动拉起总开关（M3.5，默认关闭=与 M2 行为一致）。
   * 不入 ADVANCED_FIELDS 通用表：与 companionServices 一起在设置卡 companion
   * 专用块渲染（form.ts 同款专用分支）。
   */
  companionAutostart: boolean
  /** per-service 拉起开关（默认全允许；autostart 关闭时无效果）。 */
  companionServices: Record<CompanionServiceId, boolean>
}

/** settings 命名空间 travel 解析值（client 面镜像）。 */
export interface TravelSettings {
  channels: TravelChannelMatrix
  keys: TravelKeySet
  advanced: TravelAdvancedSettings
}

// ────────────────────────── 渠道矩阵字段表（FR-3~FR-7） ──────────────────────────

/** 渠道组 id（NFR-10 按组计数；渲染分组标题也用）。 */
export const CHANNEL_GROUPS = ['fr3', 'fr4', 'fr5', 'fr6', 'fr7'] as const
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number]

/** 一个渠道开关的描述。 */
export interface ChannelFieldDef {
  /** settings 路径末段（channels.frX.<id>）。 */
  id: string
  /** 所属组。 */
  group: ChannelGroup
  /** 需要 Key 渠道标注的 Key 字段 id（无则零 Key 渠道）。 */
  keyId?: string
}

/** FR-3~FR-7 渠道矩阵字段（顺序=渲染顺序；与 node 侧 channels 组一一对应）。 */
export const CHANNEL_FIELDS: readonly ChannelFieldDef[] = [
  // FR-3 社媒情报
  { id: 'xhsMcp', group: 'fr3' },
  { id: 'xhsFallback', group: 'fr3' },
  { id: 'xhsCloak', group: 'fr3', keyId: 'cloakbrowser' },
  { id: 'douyin', group: 'fr3' },
  { id: 'tier2', group: 'fr3', keyId: 'zhihu' },
  { id: 'tier3', group: 'fr3' },
  { id: 'socialL1', group: 'fr3' },
  { id: 'tencentPoi', group: 'fr3' },
  { id: 'platformIntel', group: 'fr3', keyId: 'wendao' },
  // FR-4 交通
  { id: 'rail12306', group: 'fr4' },
  { id: 'railWendao', group: 'fr4', keyId: 'wendao' },
  { id: 'railFlyai', group: 'fr4', keyId: 'flyai' },
  { id: 'flightWendao', group: 'fr4', keyId: 'wendao' },
  { id: 'flightFlyai', group: 'fr4', keyId: 'flyai' },
  { id: 'busConsult', group: 'fr4' },
  { id: 'cityAmap', group: 'fr4', keyId: 'amapWebservice' },
  { id: 'cityDidi', group: 'fr4', keyId: 'didi' },
  // FR-5 出行建议
  { id: 'weatherAmap', group: 'fr5', keyId: 'amapWebservice' },
  { id: 'weatherTencent', group: 'fr5' },
  { id: 'weatherOpenMeteo', group: 'fr5' },
  { id: 'adviceSearch', group: 'fr5' },
  // FR-6 动线/攻略
  { id: 'routeCheckAmap', group: 'fr6', keyId: 'amapWebservice' },
  { id: 'routeCheckTencent', group: 'fr6' },
  { id: 'travelGuideTencent', group: 'fr6' },
  // FR-7 可视化
  { id: 'mapAmap', group: 'fr7', keyId: 'amapJsapi' },
  { id: 'mapLeaflet', group: 'fr7' },
  { id: 'deliveryRoute', group: 'fr7' },
  { id: 'deliveryFile', group: 'fr7' },
]

// ────────────────────────── Key 字段表（§10.1 keys 组） ──────────────────────────

/** 一个 Key 字段的描述。 */
export interface KeyFieldDef {
  /** settings 路径末段（keys.<id>）。 */
  id: string
  /** 是否需要 Key（§10.1 渠道 Key 标注；CLOAK 类默认 off）。 */
  optional?: boolean
}

/** 渠道 Key 字段（按渠道维度绑定；全部 secret）。 */
export const KEY_FIELDS: readonly KeyFieldDef[] = [
  { id: 'amapWebservice' },
  { id: 'amapJsapi' },
  { id: 'amapJscode' },
  { id: 'wendao' },
  { id: 'flyai' },
  { id: 'zhihu' },
  { id: 'didi' },
  { id: 'tmap' },
  { id: 'cloakbrowser', optional: true },
]

// ────────────────────────── Advanced 字段表（§10.1 advanced 组） ──────────────────────────

/** 高级字段类型。 */
export type AdvancedFieldDef =
  | { id: 'socialDepth'; kind: 'choice'; choices: readonly ['L0', 'L1', 'L2'] }
  | { id: 'researchTimeoutMs'; kind: 'number'; integer: true; min: 0 }
  | { id: 'rateLimitPerDomain'; kind: 'number'; integer: true; min: 1 }
  | { id: 'robotsToSCheck'; kind: 'toggle' }
  | { id: 'routePrefix'; kind: 'text' }
  | { id: 'defaultMapProvider'; kind: 'choice'; choices: readonly ['auto', 'amap', 'leaflet'] }
  | { id: 'amapSecurityMode'; kind: 'choice'; choices: readonly ['A', 'B'] }
  | { id: 'amapPoiBudgetPerPlan'; kind: 'number'; integer: true; min: 0 }
  | { id: 'amapRestBudgetPerPlan'; kind: 'number'; integer: true; min: 0 }
  | { id: 'profileTtlDays'; kind: 'number'; integer: true; min: 1 }

/** 高级字段（渲染顺序）。 */
export const ADVANCED_FIELDS: readonly AdvancedFieldDef[] = [
  { id: 'socialDepth', kind: 'choice', choices: ['L0', 'L1', 'L2'] },
  { id: 'researchTimeoutMs', kind: 'number', integer: true, min: 0 },
  { id: 'rateLimitPerDomain', kind: 'number', integer: true, min: 1 },
  { id: 'robotsToSCheck', kind: 'toggle' },
  { id: 'routePrefix', kind: 'text' },
  { id: 'defaultMapProvider', kind: 'choice', choices: ['auto', 'amap', 'leaflet'] },
  { id: 'amapSecurityMode', kind: 'choice', choices: ['A', 'B'] },
  { id: 'amapPoiBudgetPerPlan', kind: 'number', integer: true, min: 0 },
  { id: 'amapRestBudgetPerPlan', kind: 'number', integer: true, min: 0 },
  { id: 'profileTtlDays', kind: 'number', integer: true, min: 1 },
]

// ────────────────────────── NFR-10 冗余校验（纯逻辑） ──────────────────────────

/** 一组（FR）的冗余报告。 */
export interface RedundancyReport {
  group: ChannelGroup
  /** 该组启用渠道数。 */
  enabled: number
  /** 该组渠道总数。 */
  total: number
  /** 启用渠道 < 2（NFR-10 警示条件）。 */
  insufficient: boolean
}

/**
 * 任一 FR 启用渠道 < 2 时警示（FR-8 验收⑤ / NFR-10；v1 为软校验——警告但
 * 允许强制保存，弹窗化属 M2.8 设置页 v2）。
 * 组内计数口径：FR-3~FR-7 channel 矩阵该组所有开关为 true 的个数。
 * @param channels - 拟保存的渠道矩阵（可由 staged 草稿或当前值传入）。
 */
export function redundancyReport(channels: TravelChannelMatrix): RedundancyReport[] {
  return CHANNEL_GROUPS.map((group) => {
    const defs = CHANNEL_FIELDS.filter((def) => def.group === group)
    const enabled = defs.filter((def) => channels[group][def.id] === true).length
    return { group, enabled, total: defs.length, insufficient: enabled < 2 }
  })
}

/** 是否有任一组冗余不足（外壳警示条开关）。 */
export function hasInsufficientRedundancy(channels: TravelChannelMatrix): boolean {
  return redundancyReport(channels).some((report) => report.insufficient)
}