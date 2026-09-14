/**
 * 热读取接线收口（ADR-12，design §10.1/§10.2；W6 T9）。
 *
 * `makeKeyEnv(ctx)` 是 W3/W4/W5 工具的唯一真源：工具每次执行时
 * ```
 *   const env = makeKeyEnv(ctx)                       // 精确热快照
 *   await adapter.available(env)                      // 渠道可用性（Key 链 + 开关）
 *   if (channelEnabled('tencent-poi', env)) …         // fan-out 前置过滤（§10.1 生效机制）
 *   await adapter.query(params, env)                  // 适配器查询透传
 * ```
 * Key 解析分层（base.ts resolveKey）：settings（本文件接通）→ credentials →
 * process.env。渠道开关（channelEnabled）：settings 快照 → TRAVEL_CHANNEL_<NAME> env
 * → 缺省开。行为语义零改动——只把 T2 预留的接口位接上真实 settings 快照。
 *
 * 两张映射表（本文件唯一权威，改动必须同步后续波次的 fan-out 命名）：
 * - `CHANNEL_SETTINGS_PATHS`：channelEnabled(name) 的 name → settings 路径
 *   （实测各适配器 available()/channelEnabled() 调用名见注释）；非同名渠道名映射到
 *   其主用途 fr 字段，与 fr 字段同名的逻辑渠道走恒等。
 * - `CREDENTIAL_REF_MAP`：resolveKey 首参标识符 → §10.2 凭据 id（<scope>/<id> 记录
 *   空间）；未列出的标识符按自身字面量作为 env 风格 ref 兜底解析。
 */
import {
  credentialRef, isCredentialRefName, parseCredentialKey,
  type CredentialKey, type CredentialRecord, type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { KeyResolutionEnv } from './base.js'
import {
  travelSettingsSnapshot,
  type TravelChannelGroup, type TravelSettings,
} from '../settings/schema.js'

// ────────────────────────── 渠道名 → settings 路径映射表 ──────────────────────────

/**
 * base.channelEnabled(name) 的 name → settings 命名空间的 channels.<group>.<field> 路径。
 *
 * 依据（实测各适配器的 channelEnabled/available 调用名 + design §10.1 channels 组）：
 * - social.ts:    channelEnabled('social')            → fr3.xhsFallback（社交 L0/L0.5
 *   搜索摘要 = 小红书降级底，ADR-4）
 * - rail12306.ts: channelEnabled('rail12306')         → fr4.rail12306（恒等）
 * - wendao.ts:    channelEnabled('wendao')            → fr4.railWendao（问道适配器宽门，
 *   主用途=火车；机票道在 fan-out 内按 flightWendao 单独门控）
 * - amap.ts:      channelEnabled('amap')              → fr4.cityAmap（高德 REST 宽门，
 *   主用途=市内衔接；天气/动线/地图的细粒度开关在 fr5/fr6/fr7 由 fan-out 直接门控）
 * - intercity.ts: channelEnabled('intercity')         → fr4.railWendao（城际链宽门，
 *   wendao/flyai 互备，主用途=火车）
 * - 工具层 fan-out 语义名（tencent-poi/douyin/tier2/tier3/...）→ 恒等映射到对应 fr 字段
 *
 * 未在此表的 name → readSettings 返回 undefined → channelEnabled 缺省开（ADR-12
 * 安全侧：不认识的渠道不误杀）。
 */
export const CHANNEL_SETTINGS_PATHS: Record<string, readonly [TravelChannelGroup, string]> = {
  // FR-3 社媒情报
  social: ['fr3', 'xhsFallback'],
  xhsFallback: ['fr3', 'xhsFallback'],
  xhsMcp: ['fr3', 'xhsMcp'],
  xhsCloak: ['fr3', 'xhsCloak'],
  douyin: ['fr3', 'douyin'],
  tier2: ['fr3', 'tier2'],
  // 知乎开放平台主通道与 tier2 共用开关；L0 仍由 tier2 降级链保留。
  zhihu: ['fr3', 'tier2'],
  tier3: ['fr3', 'tier3'],
  'tencent-poi': ['fr3', 'tencentPoi'],
  tencentPoi: ['fr3', 'tencentPoi'],
  platformIntel: ['fr3', 'platformIntel'],
  socialL1: ['fr3', 'socialL1'],
  // W0 T4：DIDA 酒店只读报价（可选外部源，默认 off；显式开关才放行）
  didaHotel: ['fr3', 'didaHotel'],
  // FR-4 交通
  rail12306: ['fr4', 'rail12306'],
  wendao: ['fr4', 'railWendao'],
  railWendao: ['fr4', 'railWendao'],
  flyai: ['fr4', 'railFlyai'],
  railFlyai: ['fr4', 'railFlyai'],
  flightWendao: ['fr4', 'flightWendao'],
  flightFlyai: ['fr4', 'flightFlyai'],
  busConsult: ['fr4', 'busConsult'],
  intercity: ['fr4', 'railWendao'],
  amap: ['fr4', 'cityAmap'],
  cityAmap: ['fr4', 'cityAmap'],
  cityDidi: ['fr4', 'cityDidi'],
  // FR-5 出行建议
  weatherAmap: ['fr5', 'weatherAmap'],
  weatherTencent: ['fr5', 'weatherTencent'],
  weatherOpenMeteo: ['fr5', 'weatherOpenMeteo'],
  adviceSearch: ['fr5', 'adviceSearch'],
  // FR-6 动线/攻略
  routeCheckAmap: ['fr6', 'routeCheckAmap'],
  routeCheckTencent: ['fr6', 'routeCheckTencent'],
  travelGuideTencent: ['fr6', 'travelGuideTencent'],
  // FR-7 可视化
  mapAmap: ['fr7', 'mapAmap'],
  mapLeaflet: ['fr7', 'mapLeaflet'],
  deliveryRoute: ['fr7', 'deliveryRoute'],
  deliveryFile: ['fr7', 'deliveryFile'],
}

/**
 * settings 键名别名：适配器 resolveKey 首参 ≠ settings keys 组键名时的归一。
 * 现状仅 tencent 适配器 keyName 缺省 'TMAP_KEY'（settings 键为 tmap）。
 */
export const KEY_SETTINGS_ALIASES: Record<string, string> = {
  TMAP_KEY: 'tmap',
  // 知乎开放平台 secret 使用显式环境变量名，settings 侧沿用渠道短名。
  ZHIHU_ACCESS_SECRET: 'zhihu',
  // W3 T14：DIDA 酒店只读报价适配器 key（settings keys.didaHotel）
  DIDA_HOTEL_API_KEY: 'didaHotel',
}

// ────────────────────────── 标识符 → 凭据 ref 映射表（§10.2） ──────────────────────────

/**
 * resolveKey 首参标识符 → §10.2 凭据 id（`<scope>/<id>`，CredentialKey 记录空间）。
 * 「其余表项同理」= 按 §10.2 表逐行照抄；flyai 表无显式 id，按同名约定
 * `flyai/apikey`。settings 键名（amapWebservice 等）与表项同 key——同一张表
 * 同时服务「settings 键名→ref」与「env 标识符→ref」。
 *
 * 解析策略（两空间语法不相交，见 dsh-credentials types）：
 * - 标识符形式（如 AMAP_WEBSERVICE/WENDAO_APIKEY，宿主已把含 / 的非法 ref
 *   更名为合法标识符，dcd01e1 口径）→ credentials.resolve(ref)
 * - `<scope>/<id>` 形式（记录空间，如 tmap/key）→ credentials.readRecord(key) 读
 *   ApiKeyRecord.key
 * - 记录/引用都未配置 → undefined（key 链回落 env 兜底）
 */
export const CREDENTIAL_REF_MAP: Record<string, string> = {
  amapWebservice: 'AMAP_WEBSERVICE',
  amapJsapi: 'AMAP_JSAPI',
  amapJscode: 'AMAP_JSCODE',
  wendao: 'WENDAO_APIKEY',
  flyai: 'FLYAI_APIKEY', // 方案 A：值已从 settings 收敛到 credentials 的 FLYAI_APIKEY
  // 旧名 'flyai/apikey' 含斜杠，不满足 ref 名规则 ^[A-Za-z_][A-Za-z0-9_]*$（POSIX 标识符）
  didi: 'DIDI_MCPKEY', // 合法标识符 ref（无斜杠——斜杠 ref 曾致宿主崩溃，dcd01e1 同口径）
  tmap: 'tmap/key',
  TMAP_KEY: 'tmap/key', // tencent 适配器默认 keyName
  cloakbrowser: 'cloakbrowser/license',
  // W3 T14：DIDA 酒店只读报价（独立 key，合法标识符——无斜杠 ref，dcd01e1 同口径）
  DIDA_HOTEL_API_KEY: 'DIDA_HOTEL_API_KEY',
  ZHIHU_ACCESS_SECRET: 'ZHIHU_ACCESS_SECRET',
  // 方案 A（密钥收敛到 credentials）：settings keys 里的**裸标识符**（zhihu/flyai）
  // 与 ref 空间同名映射。值从 settings.yaml 迁到 .credentials.yaml 后，resolveKey
  // 的 credentials 层按此映射解析；两层同名时凭据文件成为唯一密钥位。
  zhihu: 'ZHIHU_ACCESS_SECRET',
}

// ────────────────────────── makeKeyEnv ──────────────────────────

/** credentials 服务结构面（resolve 必须；readRecord 可选——记录空间解析）。 */
export interface KeyEnvCredentials {
  resolve(ref: import('@deepseek-ai/dsh-credentials').CredentialRef): Promise<ResolvedCredential | undefined>
  readRecord?(key: CredentialKey): Promise<CredentialRecord | undefined>
}

/** makeKeyEnv 宿主结构面：只需 ctx.get 取 credentials（缺省路径）；测试可传最小对象。 */
export interface MakeKeyEnvHost {
  /** cordis Context.get 访问器（loose；结构面，满足真 Context 与测试替身）。 */
  get?: (name: string, loose?: boolean) => unknown
}

/** makeKeyEnv 选项：缺省接真实宿主（已注册 settings 快照 + ctx.credentials + process.env）。 */
export interface MakeKeyEnvOptions {
  /** 覆盖 settings 快照（测试注入；缺省用注册命名空间的解析值）。 */
  settings?: TravelSettings
  /** 覆盖 credentials（测试注入；缺省从 ctx.get('credentials') 取）。 */
  credentials?: KeyEnvCredentials
  /** 覆盖 env（测试注入；缺省 process.env——base.ts resolveKey 的 env 兜底）。 */
  env?: Readonly<Record<string, string | undefined>>
}

function isCredentialsLike(value: unknown): value is KeyEnvCredentials {
  return typeof value === 'object' && value !== null
    && typeof (value as { resolve?: unknown }).resolve === 'function'
}

function stringAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 构造 KeyResolutionEnv（ADR-12 收口）。
 *
 * N-9（render/装配期 env 快照丢凭据）：credentials **不在此构造快照**，而是每次
 * `resolveCredential` 调用时向 ctx 宿主惰性现取（`ctx.get('credentials')`）。这使装配期
 * credentials 尚未注册、执行期已就绪的部署，同一 env 对象也能在执行期解析成功
 * （对齐 key-status「每次请求 makeKeyEnv(ctx) 现造」口径——此处把「现造」下沉到
 * credentials 位本身，装配 tip/env 复用同一 makeKeyEnv 结果即可，无需每工具重造）。
 *
 * @param ctx - 插件 context（仅缺省下取 credentials 服务；每次 resolve 惰性现取；结构面）。
 * @param options - 覆盖注入（测试/定制部署）；省缺全接真实宿主。
 */
export function makeKeyEnv(ctx: MakeKeyEnvHost, options: MakeKeyEnvOptions = {}): KeyResolutionEnv {
  /** 惰性取当前 credentials 服务：显式注入覆盖优先；否则每次向 ctx 宿主现查（N-9）。 */
  const liveCredentials = (): KeyEnvCredentials | undefined => {
    if (options.credentials !== undefined) return options.credentials
    const live = ctx.get?.('credentials')
    return live !== undefined && isCredentialsLike(live) ? live : undefined
  }

  return {
    /** settings 快照位：'channels.<name>'（映射表）、'advanced.<field>'（治理/
     *  预算高级参数，M2.6 热读取）与裸/显式 keys 标识符（base.ts resolveKey
     *  传裸标识符）。 */
    readSettings(key: string): string | undefined {
      const snapshot = options.settings ?? travelSettingsSnapshot()
      if (!snapshot) return undefined
      if (key.startsWith('channels.')) {
        const logical = key.slice('channels.'.length)
        const path = CHANNEL_SETTINGS_PATHS[logical]
        if (!path) return undefined
        // 路径表保证 group ∈ fr3..fr7 且 field 为该组字段；矩阵具体类型收窄为
        // 扁平下标（限定转换，非 any）
        const channels = snapshot.channels as unknown as Record<TravelChannelGroup, Record<string, boolean>>
        const value = channels[path[0]]?.[path[1]]
        return typeof value === 'boolean' ? String(value) : undefined
      }
      if (key.startsWith('advanced.')) {
        // 治理/高级参数热读取（base.governanceConfig 消费 rateLimitPerDomain/
        // robotsToSCheck）：数字/枚举 String 化，布尔 'true'/'false'；unknown 回落
        const field = key.slice('advanced.'.length) as keyof TravelSettings['advanced']
        const value = snapshot.advanced[field]
        if (typeof value === 'boolean') return String(value)
        return value === undefined ? undefined : String(value)
      }
      if (key.startsWith('research.')) {
        // W0 T1：深度研究额度热读取（research.deep.maxRoundsPerPlan /
        // maxContentItemsPerPlan / maxContentCharsPerItem）——W1 研究预算边界消费。
        const parts = key.split('.')
        if (parts.length === 3 && parts[0] === 'research' && parts[1] === 'deep') {
          const field = parts[2] as keyof TravelSettings['research']['deep']
          const value = snapshot.research?.deep?.[field]
          return value === undefined ? undefined : String(value)
        }
        return undefined
      }
      // 裸标识符（resolveKey 首参）或显式 'keys.<id>'
      const id = key.startsWith('keys.') ? key.slice('keys.'.length) : key
      const settingsKey = KEY_SETTINGS_ALIASES[id] ?? id
      return stringAt(snapshot.keys?.[settingsKey as keyof TravelSettings['keys']])
    },

    /** credentials 位：标识符 → §10.2 ref（记录空间经 readRecord，env 风格经 resolve）。 */
    async resolveCredential(identifier: string): Promise<string | undefined> {
      // N-9：每次 resolve 向 ctx 宿主现取 credentials 服务——执行期才就绪亦解析成功。
      const service = liveCredentials()
      if (!service) return undefined
      const mapped = CREDENTIAL_REF_MAP[identifier] ?? identifier
      for (const candidate of [...new Set([mapped, identifier])]) {
        if (isCredentialRefName(candidate)) {
          try {
            const resolved = await service.resolve(credentialRef(candidate))
            const value = resolved && stringAt(resolved.value)
            if (value !== undefined) return value
          } catch {
            // 该 ref 无法解析：继续下一候选（不阻塞降级链）
          }
        } else if (service.readRecord) {
          try {
            const record = await service.readRecord(parseCredentialKey(candidate))
            if (record?.kind === 'api-key') {
              const value = stringAt(record.key)
              if (value !== undefined) return value
            }
          } catch {
            // 非法 key 段/读取失败：继续下一候选
          }
        }
      }
      return undefined
    },

    /** env 兜底保持（resolveKey 内层 fallback process.env[key]）。 */
    env: options.env ?? process.env,
  }
}