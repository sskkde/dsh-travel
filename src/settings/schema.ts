/**
 * dsh-travel settings 命名空间 schema（design §10.1 三组；FR-8 设置页 / ADR-12 热读取）。
 *
 * 结构（与 §10.1 行 658-686 一一对应）：
 * - channels：功能渠道开关矩阵，按 FR-3~FR-7 五组（每项独立启停；被停渠道在编排中
 *   跳过并计入 degraded[]「已停用（用户配置）」）
 * - keys：渠道 Key 集合，全部 `role('secret')`（settings 存储层 redact 自动脱敏，
 *   任何序列化面不出现明文）
 * - advanced：原 Config 收敛的高级参数（预算/频控/routePrefix/socialDepth 等）
 *
 * 缺省值 = §10.1 表的字面值（fr4.cityDidi 与 fr3.xhsCloak 默认 off；其余默认 on）。
 * 注册为节点半 effect：`ctx.inject(['settings'], …)`（settings 服务缺省时插件照常
 * 运行，settings 位等效“未配置”，credentials→env 两段兜底——与 base.ts 契约一致）。
 *
 * 读取约定：makeKeyEnv（src/adapters/env.ts）以本文件导出的已注册命名空间快照为
 * settings 位唯一真源（W3/W4/W5 工具热读取走它）。
 */
import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'

/** 命名空间 id（client 半注册卡 key / settingsScope.bind 同用此字面量）。 */
export const TRAVEL_SETTINGS_NS: SettingsNamespace = settingsNamespace('travel')

// ────────────────────────── 类型（§10.1 三组） ──────────────────────────

/** 功能渠道开关矩阵（FR-3~FR-7）。 */
export interface TravelChannelMatrix {
  fr3: {
    xhsMcp: boolean
    xhsFallback: boolean
    xhsCloak: boolean
    douyin: boolean
    tier2: boolean
    tier3: boolean
    tencentPoi: boolean
    platformIntel: boolean
    /** W3a：L1 登录态定向（Playwright MCP 三平台搜索页）。 */
    socialL1: boolean
    /** W0 T1：DIDA 酒店只读报价渠道（可选外部源，默认 off → 零调用，草稿 E/H）。 */
    didaHotel: boolean
  }
  fr4: {
    rail12306: boolean
    railWendao: boolean
    railFlyai: boolean
    flightWendao: boolean
    flightFlyai: boolean
    busConsult: boolean
    cityAmap: boolean
    cityDidi: boolean
  }
  fr5: {
    weatherAmap: boolean
    weatherTencent: boolean
    weatherOpenMeteo: boolean
    adviceSearch: boolean
  }
  fr6: {
    routeCheckAmap: boolean
    routeCheckTencent: boolean
    travelGuideTencent: boolean
  }
  fr7: {
    mapAmap: boolean
    mapLeaflet: boolean
    deliveryRoute: boolean
    deliveryFile: boolean
  }
}

/** 渠道 Key 集合（全部 secret；可选=未配置）。 */
export interface TravelKeySet {
  amapWebservice?: string
  amapJsapi?: string
  amapJscode?: string
  wendao?: string
  flyai?: string
  didi?: string
  tmap?: string
  cloakbrowser?: string
  /** W3 T14：DIDA 酒店只读报价（settings keys.didaHotel ↔ env DIDA_HOTEL_API_KEY）。 */
  didaHotel?: string
  /** 知乎开放平台 Access Secret（settings keys.zhihu ↔ env ZHIHU_ACCESS_SECRET）。 */
  zhihu?: string
}

/**
 * 深度研究额度（W0 T1；TL;DR 默认值表，热读——settings 保存即生效）。
 * 额度语义：每计划累计上限，耗尽=暂停非完成（budget_exhausted 回执），
 * 不自动加额/重置/无限重试。
 */
export interface TravelResearchSettings {
  deep: {
    /** 每计划累计追加检索轮次硬上限（默认 16）。 */
    maxRoundsPerPlan: number
    /** 每计划累计指定正文抓取条数上限（默认 40）；单次 fetch 批量 ≤10 itemIds。 */
    maxContentItemsPerPlan: number
    /** 单条目正文大小上限（字符；超出存 partial+truncated 原因，默认 100_000）。 */
    maxContentCharsPerItem: number
  }
}

/** 伴随服务 per-service 拉起开关（M3.5；仅 companionAutostart 开启时生效）。 */
export interface TravelCompanionServices {
  rail12306: boolean
  xhs: boolean
  playwright: boolean
  didi: boolean
}

/** 高级配置（§10.1 行 682-684；M2.6 增 robotsToSCheck 治理开关位；M3.5 增伴随服务拉起开关）。 */
export interface TravelAdvancedSettings {
  socialDepth: 'L0' | 'L1' | 'L2'
  researchTimeoutMs: number
  rateLimitPerDomain: number
  /** robots/ToS 检查开关（默认开，NFR-4；advanced.robotsToSCheck）。 */
  robotsToSCheck: boolean
  routePrefix: string
  defaultMapProvider: 'auto' | 'amap' | 'leaflet'
  /** 高德 JSAPI 安全密钥模式（A=前端明文兼容；B=webserver 代理）。 */
  amapSecurityMode: 'A' | 'B'
  amapPoiBudgetPerPlan: number
  amapRestBudgetPerPlan: number
  profileTtlDays: number
  /**
   * 伴随服务按需自动拉起总开关（M3.5，用户决策：**默认关闭**）。
   * 关闭=行为与 M2 完全一致（连接已手动运行的服务，服务挂→既有降级链，零新进程）；
   * 开启=工具首次需要某服务且该服务不健康 → supervisor.ensure(name) 按需拉起。
   */
  companionAutostart: boolean
  /** 伴随服务 per-service 拉起开关（默认全部允许；autostart 关闭时无效果）。 */
  companionServices: TravelCompanionServices
}

/** settings 命名空间 travel 的完整解析值。 */
export interface TravelSettings {
  channels: TravelChannelMatrix
  keys: TravelKeySet
  advanced: TravelAdvancedSettings
  research: TravelResearchSettings
}

/** 渠道组枚举（NFR-10 冗余校验按组计数）。 */
export const TRAVEL_CHANNEL_GROUPS = ['fr3', 'fr4', 'fr5', 'fr6', 'fr7'] as const
export type TravelChannelGroup = (typeof TRAVEL_CHANNEL_GROUPS)[number]

// ────────────────────────── 缺省值（§10.1 字面值） ──────────────────────────

export const TRAVEL_CHANNELS_DEFAULT: TravelChannelMatrix = {
  fr3: {
    xhsMcp: true, xhsFallback: true, xhsCloak: false, douyin: true,
    tier2: true, tier3: true, tencentPoi: true, platformIntel: true,
    socialL1: true,
    didaHotel: false,
  },
  fr4: {
    rail12306: true, railWendao: true, railFlyai: true,
    flightWendao: true, flightFlyai: true, busConsult: true,
    cityAmap: true, cityDidi: false,
  },
  fr5: {
    weatherAmap: true, weatherTencent: true, weatherOpenMeteo: true, adviceSearch: true,
  },
  fr6: {
    routeCheckAmap: true, routeCheckTencent: true, travelGuideTencent: true,
  },
  fr7: {
    mapAmap: true, mapLeaflet: true, deliveryRoute: true, deliveryFile: true,
  },
}

/** 伴随服务 per-service 缺省（全部允许；仅 autostart 开启时生效）。 */
export const TRAVEL_COMPANION_SERVICES_DEFAULT: TravelCompanionServices = {
  rail12306: true,
  xhs: true,
  playwright: true,
  didi: true,
}

/** 深度研究额度缺省（TL;DR：16 轮 / 40 条 / 100_000 字符每条目）。 */
export const TRAVEL_RESEARCH_DEFAULT: TravelResearchSettings = {
  deep: {
    maxRoundsPerPlan: 16,
    maxContentItemsPerPlan: 40,
    maxContentCharsPerItem: 100_000,
  },
}

export const TRAVEL_ADVANCED_DEFAULT: TravelAdvancedSettings = {
  socialDepth: 'L1',
  researchTimeoutMs: 180000,
  rateLimitPerDomain: 10,
  robotsToSCheck: true,
  routePrefix: '/travel-plans',
  defaultMapProvider: 'auto',
  amapSecurityMode: 'A',
  amapPoiBudgetPerPlan: 40,
  amapRestBudgetPerPlan: 60,
  profileTtlDays: 7,
  companionAutostart: false,
  companionServices: TRAVEL_COMPANION_SERVICES_DEFAULT,
}

// ────────────────────────── schema（三组） ──────────────────────────

/** channels 组：FR × channel 开关矩阵（组缺省 + 字段级缺省：部分用户覆盖时
 *  未覆盖字段仍回落默认——与 §10.1 默认矩阵一致）。 */
export const travelChannelsSchema = z.object({
  fr3: z.object({
    xhsMcp: z.boolean().default(true),
    xhsFallback: z.boolean().default(true),
    xhsCloak: z.boolean().default(false),
    douyin: z.boolean().default(true),
    tier2: z.boolean().default(true),
    tier3: z.boolean().default(true),
    tencentPoi: z.boolean().default(true),
    platformIntel: z.boolean().default(true),
    socialL1: z.boolean().default(true),
    didaHotel: z.boolean().default(false),
  }),
  fr4: z.object({
    rail12306: z.boolean().default(true),
    railWendao: z.boolean().default(true),
    railFlyai: z.boolean().default(true),
    flightWendao: z.boolean().default(true),
    flightFlyai: z.boolean().default(true),
    busConsult: z.boolean().default(true),
    cityAmap: z.boolean().default(true),
    cityDidi: z.boolean().default(false),
  }),
  fr5: z.object({
    weatherAmap: z.boolean().default(true),
    weatherTencent: z.boolean().default(true),
    weatherOpenMeteo: z.boolean().default(true),
    adviceSearch: z.boolean().default(true),
  }),
  fr6: z.object({
    routeCheckAmap: z.boolean().default(true),
    routeCheckTencent: z.boolean().default(true),
    travelGuideTencent: z.boolean().default(true),
  }),
  fr7: z.object({
    mapAmap: z.boolean().default(true),
    mapLeaflet: z.boolean().default(true),
    deliveryRoute: z.boolean().default(true),
    deliveryFile: z.boolean().default(true),
  }),
}).default(TRAVEL_CHANNELS_DEFAULT)

/** keys 组：渠道 Key（role('secret') 自动脱敏；未配置=键缺失）。
 *  用 dict（而非固定 object）承载：secret 字段可不出现（=未配置），实体字段由
 *  TravelKeySet 聚焦声明；redact 走 dict 条目级剥离并只在有值时登记 sidecar。 */
export const travelKeysSchema = z.dict(z.string().role('secret')).default({})

/** advanced 组：高级配置（字段级缺省，部分覆盖回落默认）。 */
export const travelAdvancedSchema = z.object({
  socialDepth: z.union([z.const('L0'), z.const('L1'), z.const('L2')]).default('L1'),
  researchTimeoutMs: z.natural().default(180000),
  rateLimitPerDomain: z.natural().default(10),
  robotsToSCheck: z.boolean().default(true),
  routePrefix: z.string().default('/travel-plans'),
  defaultMapProvider: z.union([z.const('auto'), z.const('amap'), z.const('leaflet')]).default('auto'),
  amapSecurityMode: z.union([z.const('A'), z.const('B')]).default('A'),
  amapPoiBudgetPerPlan: z.natural().default(40),
  amapRestBudgetPerPlan: z.natural().default(60),
  profileTtlDays: z.natural().default(7),
  // M3.5 伴随服务按需拉起（用户决策：默认关闭；关闭=与 M2 行为一致零新进程）
  companionAutostart: z.boolean().default(false),
  companionServices: z.object({
    rail12306: z.boolean().default(true),
    xhs: z.boolean().default(true),
    playwright: z.boolean().default(true),
    didi: z.boolean().default(true),
  }).default(TRAVEL_COMPANION_SERVICES_DEFAULT),
}).default(TRAVEL_ADVANCED_DEFAULT)

/** 深度研究额度（字段级缺省：16/40/100_000，部分覆盖回落默认；热读）。 */
export const travelResearchSchema = z.object({
  deep: z.object({
    maxRoundsPerPlan: z.natural().default(16),
    maxContentItemsPerPlan: z.natural().default(40),
    maxContentCharsPerItem: z.natural().default(100_000),
  }).default(TRAVEL_RESEARCH_DEFAULT.deep),
}).default(TRAVEL_RESEARCH_DEFAULT)

/** 命名空间 travel 的完整 schema（settings.register 使用；applies='live' 即保存即生效）。 */
export const travelSettingsSchema = z.object({
  channels: travelChannelsSchema,
  keys: travelKeysSchema,
  advanced: travelAdvancedSchema,
  research: travelResearchSchema,
})

// ────────────────────────── 注册与快照（ADR-12 settings 位唯一真源） ──────────────────────────

let registeredScope: SettingsScope<TravelSettings> | undefined

/**
 * 注册 settings 命名空间 travel（节点半，apply() 调用）。
 * settings 服务缺省时静默跳过（插件其余功能照常）；服务在场时注册为插件 fiber
 * effect（插件卸载自动注销）并把 scope 交给模块级快照访问器。
 */
export function registerTravelSettings(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    registeredScope = settingsCtx.settings.register(TRAVEL_SETTINGS_NS, travelSettingsSchema, {
      // §10.1「保存后立即生效（无需重启）」：静态部署参数随保存生效
      applies: 'live',
    })
  })
}

/**
 * 已注册命名空间的解析快照（热读取）。
 * - 未注册/服务缺省 → undefined（等价「未配置」，Key 链回落 credentials→env）
 * - settings 空间本身只读拉取；写入经设置页/update 路径，本快照天然热跟随
 */
export function travelSettingsSnapshot(): TravelSettings | undefined {
  return registeredScope?.get()
}