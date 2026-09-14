/**
 * travel_research_transport —— 城际交通 + 市内衔接检索（W3 新增；design §6 行 520）。
 *
 * 覆盖（design §5.4 行 380-383 + §6）：
 * - rail：12306 MCP（MCP 8123，只读 query-tickets/query-ticket-price，真实班次+票价档）
 *   → 不可用降级 intercity 火车互备链（M2.3 接通：wendao 火车票模板 → flyai
 *   search-train 零 key → L0 搜索结构化；backupSources() 声明位兑现）
 *   → 最终标注「班次请以 12306 为准」（§9.3-3）
 * - flight：wendao（模板拼接）→ flyai（零 key 试用）→ L0 搜索结构化三档
 *   （intercity 降级链 M2.3 全接通；三档全空 → 明示人工比价+官方渠道链接）
 * - bus：wendao 咨询级 → L0 搜索（P1）
 * - **市内衔接**：高德 directionTransit 渠道一 + 滴滴 MCP 渠道二（M2.4 W5）——
 *   cityTransfer{provider:amap|didi, options[]} 双方案聚合（滴滴选项带「滴滴·」前缀），
 *   接入首个铁路方案的到达站 → 目的地城市；滴滴 Key 未配/失败 → 降级高德单方案
 * - ≥2 城际方案 → comparison 比较（时间/价格/舒适度/带娃老人适配）
 *
 * W3 T11（草稿 D 节门与入口）：
 * - **前置门**：完整 plan（flowVersion 新计划，或已解析 places.json）首查当前
 *   places.json——缺工件/版本过期/入口必需字段未解析 → 结构化 blocked+nextAction，
 *   发起下游网络请求数=0；不允许回落到 slots.destination 绕过门。
 *   判定口径（W0 T1 注）：flowVersion 缺失且无 places = legacy 读取（旧计划沿用
 *   现状行为）；intake 自动 seed 的兼容兴趣种子不单独触发门（保持单点票务轻量路径）。
 * - 查询出发地 → 经验证入口城市/站/机场（dateStart 单程）；入口映射区分城市/
 *   站名代码/机场/地点坐标；铁路站点搜索复用 searchStations（不把第一站默认当
 *   正确站——以真实到达站匹配候选）。
 * - 收到实际到达站/机场后以真实枢纽衔接入口点/明确住宿区；缺枢纽坐标 → 标衔接
 *   未知（不把出发站/城市中心错用成终点）；方案 ID（H1/H2…）保证不同到达枢纽
 *   的衔接不串用。
 * - 返程不自动新增（dateStart 单程查询只产出发腿）。
 *
 * 统一机制：120s 预算；逐源失败 → degraded 记账继续；输出过 validateTransportOption
 * 闸门后落 transport.json（§5.5）；全链路失败不产空 transport.json（§9.3-6）。
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  EngineError, channelEnabled, toDegraded,
  type DegradedEntry, type KeyResolutionEnv,
} from '../adapters/base.js'
import { AMAP_API_BASE, AmapAdapter } from '../adapters/amap.js'
import { DEFAULT_DIDI_MCP_URL, DIDI_KEY_MISSING_REASON, type DidiAdapter } from '../adapters/didi.js'
import { IntercityAdapter, parseTrainsFromMarkdown } from '../adapters/intercity.js'
import { Rail12306Adapter } from '../adapters/rail12306.js'
import { WendaoAdapter } from '../adapters/wendao.js'
import {
  TRANSPORT_MODES,
  type CityTransfer, type CityTransferProvider, type CityTransferOption,
  type GeoCoords, type PlacesArtifact, type ResolvedPlace,
  type SourceRef, type TransportMode, type TransportOption, type TravelRequest,
} from '../models/types.js'
import { isOneOf, validateTransportOption } from '../models/validate.js'
import { TravelValidationError } from '../errors.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { assertTransition } from '../store/state.js'
import { cardLines, losslessJson, textCard } from './common.js'

/** §6 行 520：research_transport 超时 120s。 */
export const TRANSPORT_TIMEOUT_MS = 120_000

/** 工具参数。 */
export interface ResearchTransportArgs {
  planId: string
  modes?: TransportMode[]
}

/** 装配依赖（index.ts 注入真实适配器；测试注入 mock/fixture）。 */
export interface ResearchTransportDeps {
  rail?: Rail12306Adapter
  intercity?: IntercityAdapter
  amap?: AmapAdapter
  wendao?: WendaoAdapter
  /** 市内衔接渠道二（滴滴 MCP；M2.4 W5）。 */
  didi?: DidiAdapter
  /** 统一超时预算（缺省 120s）。 */
  timeoutMs?: number
  /** ADR-12 热读取环境（渠道开关前置过滤）。 */
  env?: KeyResolutionEnv
}

/** 比较结果（FR-4 详 2：时间/价格/舒适度/带娃老人适配）。 */
export interface TransportComparison {
  time: string
  price: string
  comfort: string
  suitability: string
}

// ────────────────────────── W3 T11 前置门与出发入口类型 ──────────────────────────

/** 前置门回执（草稿 D：缺 places/版本过期/入口未解析 → 结构化 blocked+nextAction）。 */
export interface TransportGateBlocked {
  blocked: true
  reason: 'places_not_ready' | 'places_stale' | 'places_failed' | 'places_empty' | 'entry_not_resolved' | 'entry_place_missing'
  detail: string
  nextAction: string
}

/** 单个到达枢纽的衔接（方案 ID 保证不同到达枢纽不串用）。 */
export interface TransportArrivalHubLink {
  /** 方案 ID（H1/H2…；按到达站首次出现顺序分配，跨 options 唯一）。 */
  schemeId: string
  /** 实际到达站/机场（rail/flight option.segments[0].to）。 */
  arrivalStation: string
  /** searchStations 候选中的匹配站（真实到达站匹配，非第一站默认）。 */
  matchedStation?: string
  /** 枢纽坐标（入口枢纽自身坐标 / amap/tencent 地理编码）；缺省 undefined。 */
  coords?: GeoCoords
  /** 枢纽是否已衔接（=枢纽坐标已知）。 */
  linked: boolean
  /** 缺枢纽坐标 → 衔接未知。 */
  unknown?: boolean
  reason?: string
}

/** 出发腿回执（入口城市/站名代码/机场/地点坐标区分）。 */
export interface TransportEntryReceipt {
  /** 出发地原话（request.slots.origin，不修改）。 */
  origin: string
  entryPlaceId: string
  entryName: string
  /** 入口点种类（city|station|airport|place，来自 places.originResolution 或判定）。 */
  entryKind?: string
  /** 出行日（dateStart，单程）。 */
  date: string
  /** 真实到达枢纽衔接列表（方案 ID 隔离）。 */
  hubLinks: TransportArrivalHubLink[]
  /** 明确住宿区（entry 之后的住宿/区域候选名；无则 undefined）。 */
  lodgingArea?: string
  /** searchStations 候选站名（出发入口检索回显）。 */
  stationCandidates: string[]
}

/** 工具返回（§6 行 520 摘要；详情落 transport.json）。 */
export interface ResearchTransportResult {
  planId: string
  options: TransportOption[]
  comparison?: TransportComparison
  cityTransfer?: CityTransfer
  degraded: DegradedEntry[]
  /** T11 前置门回执（仅完整 plan 被门拦截时出现；此时 options=[] 且零网络）。 */
  gate?: TransportGateBlocked
  /** T11 出发入口回执（仅完整 plan 且过门后出现）。 */
  entry?: TransportEntryReceipt
}

const TRANSPORT_PARAMETERS = {
  planId: {
    type: 'string',
    required: true,
    description: '计划 ID（必填；须先 travel_intake 建立计划且状态非终态锁定）',
  } as const,
  modes: {
    type: 'array',
    items: { type: 'string', enum: [...TRANSPORT_MODES] },
    description: '交通模式过滤（缺省 rail/flight/bus 全查）',
  } as const,
} as const

type TransportParams = InferArgs<typeof TRANSPORT_PARAMETERS>

// ────────────────────────── 输出 schema（受限 JSON Schema 子集） ──────────────────────────

const SEGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    no: { type: 'string' },
    depart: { type: 'string' },
    arrive: { type: 'string' },
    priceRange: { type: 'array', items: { type: 'number' } },
    channel: { type: 'string' },
  },
} as const

const SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    platform: { type: 'string', required: true },
    url: { type: 'string', required: true },
    fetchedAt: { type: 'string', required: true },
  },
} as const

const CITY_TRANSFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    provider: { type: 'string', enum: ['amap', 'didi', 'search'], required: true },
    options: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          durationMinutes: { type: 'integer' },
          priceHint: { type: 'string' },
        },
      },
    },
    source: { ...SOURCE_SCHEMA, required: true },
  },
} as const

const OPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: [...TRANSPORT_MODES], required: true },
    segments: { type: 'array', required: true, items: { ...SEGMENT_SCHEMA } },
    totalPriceRange: { type: 'array', items: { type: 'number' } },
    durationMinutes: { type: 'integer' },
    cityTransfer: CITY_TRANSFER_SCHEMA,
    tags: { type: 'array', items: { type: 'string' } },
    bookingTips: { type: 'array', items: { type: 'string' } },
    source: { ...SOURCE_SCHEMA, required: true },
  },
} as const

const DEGRADED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    code: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    at: { type: 'string', required: true },
  },
} as const

/** T11 门/入口回执（可选属性；legacy 路径不出现）。 */
const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    blocked: { type: 'boolean', required: true },
    reason: { type: 'string', required: true },
    detail: { type: 'string', required: true },
    nextAction: { type: 'string', required: true },
  },
} as const

const HUB_LINK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemeId: { type: 'string', required: true },
    arrivalStation: { type: 'string', required: true },
    matchedStation: { type: 'string' },
    coords: { type: 'json' },
    linked: { type: 'boolean', required: true },
    unknown: { type: 'boolean' },
    reason: { type: 'string' },
  },
} as const

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: { type: 'string', required: true },
    entryPlaceId: { type: 'string', required: true },
    entryName: { type: 'string', required: true },
    entryKind: { type: 'string' },
    date: { type: 'string', required: true },
    hubLinks: { type: 'array', required: true, items: { ...HUB_LINK_SCHEMA } },
    lodgingArea: { type: 'string' },
    stationCandidates: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

export const TRANSPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    options: { type: 'array', required: true, items: { ...OPTION_SCHEMA } },
    comparison: {
      type: 'object',
      additionalProperties: false,
      properties: {
        time: { type: 'string', required: true },
        price: { type: 'string', required: true },
        comfort: { type: 'string', required: true },
        suitability: { type: 'string', required: true },
      },
    },
    cityTransfer: CITY_TRANSFER_SCHEMA,
    degraded: { type: 'array', required: true, items: { ...DEGRADED_SCHEMA } },
    gate: GATE_SCHEMA,
    entry: ENTRY_SCHEMA,
  },
} as const

type TransportOutput = InferValue<typeof TRANSPORT_OUTPUT_SCHEMA>

// ────────────────────────── 域逻辑 ──────────────────────────

/** 高铁/动车 → 舒适档（rail 高级座席）；普快 → 经济档。 */
function comfortLabel(opt: TransportOption): string {
  if (opt.mode === 'rail') {
    const no = opt.segments[0]?.no ?? ''
    if (/^[GD]/.test(no)) return '高铁/动车（舒适，准点率高）'
    if (/^[CZ]/.test(no)) return '城际/直达（中高舒适）'
    if (/^[KT]/.test(no)) return '普速列车（时间长，性价比高）'
    return '铁路出行'
  }
  if (opt.mode === 'flight') return '飞机（最快但含值机安检总耗时，受天气延误影响）'
  return '长途汽车（座位较窄，车程较长，票价低）'
}

/** 带娃/老人适配描述（结合人数画像 + 交通 tags）。 */
function suitabilityLabel(opt: TransportOption, request: TravelRequest): string {
  const seniors = request.slots.travelers?.seniors ?? 0
  const children = request.slots.travelers?.children ?? 0
  const parts: string[] = []
  if (opt.mode === 'rail' && /^[GD]/.test(opt.segments[0]?.no ?? '')) {
    parts.push('高铁舱内平稳，适合带娃/老人')
  } else if (opt.mode === 'rail') {
    parts.push('普速卧铺适合长途过夜，带娃/老人建议优先高铁')
  } else if (opt.mode === 'flight') {
    parts.push(seniors > 0 || children > 0 ? '飞行需提前值机，老人/儿童建议预留 2h+ 到达机场' : '适合时间敏感出行')
  } else {
    parts.push('汽车班次较少，带娃/老人不推荐长途')
  }
  if (opt.durationMinutes !== undefined && opt.durationMinutes > 360) {
    parts.push('单程超 6 小时，建议分段休息')
  }
  return parts.join('；')
}

/** 构建 ≥2 方案对比（FR-4 详 2 四维度；带娃老人适配结合真实人数画像）。 */
export function buildComparison(options: readonly TransportOption[], request: TravelRequest): TransportComparison | undefined {
  const ranked = [...options].sort((a, b) => {
    const da = a.durationMinutes ?? Number.MAX_SAFE_INTEGER
    const db = b.durationMinutes ?? Number.MAX_SAFE_INTEGER
    return da - db
  })
  const fastest = ranked[0]
  const cheapest = [...options].sort((a, b) => {
    const pa = a.totalPriceRange?.[0] ?? Number.MAX_SAFE_INTEGER
    const pb = b.totalPriceRange?.[0] ?? Number.MAX_SAFE_INTEGER
    return pa - pb
  })[0]
  const no = (o: TransportOption): string => o.segments[0]?.no ?? o.segments[0]?.from ?? o.mode
  return {
    time: `最快：${no(fastest)}（${fastest.durationMinutes !== undefined ? `${Math.floor(fastest.durationMinutes / 60)}h${fastest.durationMinutes % 60}m` : '时长未知'}）；飞机另计值机安检约 2h`,
    price: `最省：${no(cheapest)}（${cheapest.totalPriceRange !== undefined ? `¥${cheapest.totalPriceRange[0]}~${cheapest.totalPriceRange[1]}` : '参考区间未知'}）；价格为参考区间，以购票时实时价格为准`,
    comfort: options.map((o) => `${no(o)}：${comfortLabel(o)}`).join('；'),
    suitability: options.map((o) => `${no(o)}：${suitabilityLabel(o, request)}`).join('；'),
  }
}

/** 铁路价格补充（12306 query-ticket-price）：前 N 班次票价并入 option。 */
async function enrichRailPrices(
  rail: Rail12306Adapter,
  opts: readonly TransportOption[],
  from: string,
  to: string,
  date: string,
  env: KeyResolutionEnv | undefined,
  degraded: DegradedEntry[],
): Promise<TransportOption[]> {
  if (opts.length === 0) return [...opts]
  const out: TransportOption[] = [...opts]
  const top = out.slice(0, 3)
  let priceErr = false
  for (let i = 0; i < top.length; i += 1) {
    const opt = top[i]
    const trainCode = opt.segments[0]?.no
    if (!trainCode) continue
    try {
      const { trains } = await rail.queryTicketPrice({ from, to, date, trainCode }, env)
      const hit = trains.find((t) => t.trainCode === trainCode)
      if (hit?.priceRange !== undefined) {
        const idx = out.indexOf(opt)
        if (idx >= 0) {
          out[idx] = { ...opt, totalPriceRange: hit.priceRange, segments: opt.segments.map((s) => s.no === trainCode ? { ...s, priceRange: hit.priceRange } : s) }
        }
      }
    } catch {
      priceErr = true
    }
  }
  if (priceErr) {
    degraded.push(toDegraded('rail12306/price', 'UNAVAILABLE', '部分班次票价查询失败（余票/票价以 12306 官方为准）'))
  }
  return out
}

/**
 * 铁路互备执行器：每次调用只允许一次 intercity.searchTrains。
 * 12306 成功空班次与查询抛错都进入此路径；互备空/失败额外记在稳定的
 * rail12306/backup 来源，避免空数组看起来像成功。
 */
async function queryRailBackup(
  origin: string,
  destination: string,
  date: string,
  deps: ResearchTransportDeps,
  env: KeyResolutionEnv | undefined,
  options: TransportOption[],
  degraded: DegradedEntry[],
): Promise<void> {
  if (deps.intercity === undefined) {
    degraded.push(toDegraded('rail12306/backup', 'UNAVAILABLE', '12306 无结果且火车互备适配器未注入'))
    return
  }
  try {
    const backup = await deps.intercity.searchTrains({ from: origin, to: destination, date }, env)
    options.push(...backup.options)
    degraded.push(...backup.degraded)
    if (backup.options.length === 0) {
      degraded.push(toDegraded('rail12306/backup', 'EMPTY', '12306 查询无班次；火车互备也无结果'))
    }
  } catch (err) {
    degraded.push(toDegraded(
      'rail12306/backup',
      'UNAVAILABLE',
      `12306 查询无班次；火车互备失败：${err instanceof Error ? err.message : String(err)}`,
    ))
  }
}

/** 城际查询执行器（rail/flight/bus 逐模式；origin/destination 显式传入，完整/legacy 共用）。 */
async function queryIntercity(
  origin: string,
  destination: string,
  date: string,
  args: ResearchTransportArgs,
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<TransportOption[]> {
  const env = deps.env
  const modes = args.modes ?? [...TRANSPORT_MODES]
  const options: TransportOption[] = []

  if (modes.includes('rail') && deps.rail) {
    const railUp = channelEnabled('rail12306', env) && (await deps.rail.available(env))
    if (!railUp) {
      const reason = channelEnabled('rail12306', env) ? '12306 MCP 不可达' : '已停用（用户配置）'
      degraded.push(toDegraded('rail12306', 'UNAVAILABLE', reason))
      // 火车互备（M2.3 接通，§2.1 FR-4 渠道一降级链）：intercity 三段互备链
      // wendao（模板拼接）→ flyai search-train（零 key）→ L0 搜索结构化；
      // rail12306.backupSources() 声明位由此兑现。
      if (deps.intercity) {
        await queryRailBackup(origin, destination, date, deps, env, options, degraded)
      } else if (deps.wendao && channelEnabled('railWendao', env) && (await deps.wendao.available(env))) {
        // intercity 未装配时的最小兜底（纯 wendao 咨询，保留 M1 行为）
        try {
          const result = await deps.wendao.query(`${date} ${origin}到${destination} 火车票 高铁 时刻 票价`, env)
          options.push(...parseTrainsFromMarkdown(result.entries))
        } catch (err) {
          degraded.push(toDegraded('wendao/rail', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
        }
      } else if (deps.wendao) {
        degraded.push(toDegraded('wendao/rail', 'UNAVAILABLE', 'wendao 未配置或已停用（火车互备未就位）'))
      }
    } else {
      try {
        const { options: railOpts, degraded: railDegraded } = await deps.rail.queryTrains({ from: origin, to: destination, date }, env)
        degraded.push(...railDegraded)
        if (railOpts.length > 0) {
          options.push(...await enrichRailPrices(deps.rail, railOpts, origin, destination, date, env, degraded))
        } else {
          // query-tickets 成功但无班次不是成功空结果：只走一次火车互备。
          await queryRailBackup(origin, destination, date, deps, env, options, degraded)
        }
      } catch (err) {
        const engine = err instanceof EngineError ? err : new EngineError('UNAVAILABLE', err instanceof Error ? err.message : String(err), 'rail12306')
        degraded.push(toDegraded('rail12306', engine))
        degraded.push(toDegraded('rail12306', 'EMPTY', '12306 查询失败：班次请以 12306 官方为准（www.12306.cn）'))
        // W6 故障矩阵贯通（design §2.1 FR-4 渠道一降级链）：查询期故障（超时/网络/
        // 上游错）与可用性故障同走互备链——此前仅 available()=false 触发 backup，
        // 查询期失败会空手而归（矩阵 rail12306/timeout case 实测暴露）。
        await queryRailBackup(origin, destination, date, deps, env, options, degraded)
      }
    }
  } else if (modes.includes('rail')) {
    degraded.push(toDegraded('rail12306', 'UNAVAILABLE', 'rail 适配器未注入'))
  }

  if (modes.includes('flight') && deps.intercity) {
    const outcome = await deps.intercity.searchFlights({ from: origin, to: destination, date }, env)
    options.push(...outcome.options)
    degraded.push(...outcome.degraded)
  }

  if (modes.includes('bus') && deps.intercity) {
    const outcome = await deps.intercity.searchBuses({ from: origin, to: destination, date }, env)
    options.push(...outcome.options)
    degraded.push(...outcome.degraded)
  }

  return options
}

/** 市内衔接聚合（高德渠道一 + 滴滴渠道二；§2.1 双方案互为降级，均失败 → 无 cityTransfer）。
 *  2026-09 W3 T11 参数化：from/to 显式传入（legacy 传 destination；完整 plan 传真实到达枢纽→住宿区）。 */
async function queryCityTransfer(
  fromFallback: string,
  to: string,
  options: readonly TransportOption[],
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<CityTransfer | undefined> {
  if (!deps.amap && !deps.didi) return undefined
  const railArrival = options.find((o) => o.mode === 'rail')?.segments[0]?.to
  const from = railArrival ?? fromFallback

  const amapOutcome = await queryAmapCityTransfer(from, to, deps, degraded)
  // 滴滴侧沿用高德消歧后的到达站名（如「杭州东站」），提高地理编码命中率
  const didiFrom = amapOutcome?.fromLabel ?? from
  const didiOptions = await queryDidiCityTransfer(didiFrom, to, deps, degraded)

  if (amapOutcome === undefined && didiOptions.length === 0) return undefined
  const provider: CityTransferProvider = amapOutcome !== undefined ? 'amap' : 'didi'
  return {
    from: amapOutcome?.fromLabel ?? from,
    to,
    provider,
    options: [...(amapOutcome?.options ?? []), ...didiOptions],
    source: amapOutcome?.source ?? {
      platform: 'didi',
      url: deps.didi?.mcp.url ?? DEFAULT_DIDI_MCP_URL,
      fetchedAt: new Date().toISOString(),
    },
  }
}

interface AmapTransferOutcome {
  fromLabel: string
  options: CityTransferOption[]
  source: SourceRef
}

/** 高德渠道一（direction(transit)；地名消歧「站」重试保留 M1 行为）。 */
async function queryAmapCityTransfer(
  from: string,
  destination: string,
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<AmapTransferOutcome | undefined> {
  const amap = deps.amap
  if (!amap) return undefined
  if (!channelEnabled('cityAmap', deps.env)) {
    degraded.push(toDegraded('cityAmap', 'UNAVAILABLE', '已停用（用户配置）'))
    return undefined
  }
  // Key 门前置（ADR-12/W6 验收④ 口径）：无 key → 渠道 skipped + degraded「Key 未配置」，
  // 不在后续地理编码环节暴露与 key 无关的报错（与 rail12306 路径的 available() 门同款）。
  if (!(await amap.available(deps.env))) {
    degraded.push(toDegraded('cityAmap', 'UNAVAILABLE', 'Key 未配置（amapWebservice）'))
    return undefined
  }
  // 地名消歧重试：12306 到达站名（如「杭州东」）可能不含「站」，高德地理编码易失败
  // （live 实测 ENGINE_RESPONSE_DATA_ERROR）→ 追加「站」再试一次（不引入额外请求风暴）
  const attempts = [from]
  if (from !== destination && !/(站|车站|机场|码头)$/.test(from)) {
    attempts.push(`${from}站`)
  }
  for (const fromLabel of attempts) {
    try {
      const { options: transferOptions, degraded: amapDegraded } = await amap.directionTransit(
        fromLabel,
        destination,
        { city: destination },
        deps.env,
      )
      degraded.push(...amapDegraded)
      if (transferOptions.length === 0) {
        degraded.push(toDegraded('cityAmap', 'EMPTY', '高德无市内公共交通方案'))
        return undefined
      }
      return {
        fromLabel,
        options: transferOptions,
        source: {
          platform: 'amap',
          url: `${AMAP_API_BASE}/direction/transit/integrated`,
          fetchedAt: new Date().toISOString(),
        },
      }
    } catch (err) {
      // 首个写法失败且存在「站」变体 → 重试；否则记账返回
      if (fromLabel === from && attempts.length > 1) continue
      degraded.push(toDegraded('cityAmap', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      return undefined
    }
  }
  return undefined
}

/** 滴滴渠道二（Key 门控 → 查询；失败单渠道降级，不阻塞高德单方案）。 */
async function queryDidiCityTransfer(
  from: string,
  destination: string,
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<CityTransferOption[]> {
  const didi = deps.didi
  if (!didi) return []
  if (!channelEnabled('cityDidi', deps.env)) {
    degraded.push(toDegraded('cityDidi', 'UNAVAILABLE', '已停用（用户配置）'))
    return []
  }
  // Key 门（DIDI_MCP_KEY 未配）→ 渠道跳过 + degraded「Key 未配置」（静默降级态之一）
  if (!(await didi.available(deps.env))) {
    degraded.push(toDegraded('cityDidi', 'UNAVAILABLE', DIDI_KEY_MISSING_REASON))
    return []
  }
  try {
    const { options: didiOptions, degraded: didiDegraded } = await didi.queryTransfer(from, destination, destination, deps.env)
    degraded.push(...didiDegraded)
    return didiOptions
  } catch (err) {
    // 服务不可用/调用失败 → 渠道二降级记账，高德单方案不阻塞
    degraded.push(toDegraded('cityDidi', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    return []
  }
}

// ────────────────────────── W3 T11 前置门与出发入口 ──────────────────────────

/** 完整 plan 判定：flowVersion 显式声明新计划，或已解析 places（草稿 F/W0 T1 注）。
 *  F1c-E（决策 5）：destination-only 新 plan（mapped 兴趣种子）同样带 flowVersion →
 *  受完整链门；真正 legacy（请求文件无 flowVersion 信封的旧计划）才走轻量单点路径。 */
function isCompletePlan(request: TravelRequest, placesFound: boolean): boolean {
  return request.flowVersion !== undefined || placesFound
}

/**
 * 前置门（草稿 D）：完整 plan 首查当前 places——缺工件/版本过期/入口必需字段未解析
 * → 结构化 blocked+nextAction，**发起下游网络请求数=0**；不允许回落到 slots.destination。
 *
 * 版本过期判定（多发布批次下 not_in_commit 不误杀——transport/coverage 等后续发布
 * 会替换 artifact-meta；真实过期 = hash 失配 / 发布失败 / intel 证据版本领先于解析）。
 */
function isUnaccounted<T>(state: ArtifactReadState<T>): boolean {
  return state.status === 'unknown'
    || (state.status === 'stale' && state.staleReason === 'not_in_commit')
}

async function transportGate(
  placesState: ArtifactReadState<PlacesArtifact>,
  request: TravelRequest,
  store: TravelStore,
  planId: string,
): Promise<TransportGateBlocked | undefined> {
  if (!placesState.found) {
    return {
      blocked: true,
      reason: 'places_not_ready',
      detail: '缺少 places.json：交通查询需要先完成地理解析与入口点确认',
      nextAction: '请先执行 travel_resolve_places（候选+入口点解析）后重试 travel_research_transport',
    }
  }
  if (placesState.status === 'failed' || placesState.meta?.status === 'failed') {
    return {
      blocked: true,
      reason: 'places_failed',
      detail: 'places 上次发布失败（不把失败当成功消费）',
      nextAction: '请重新执行 travel_resolve_places 修复解析后重试',
    }
  }
  if (placesState.status === 'empty' || placesState.meta?.status === 'empty') {
    return {
      blocked: true,
      reason: 'places_empty',
      detail: 'places 上次发布为空（零结果不复活）',
      nextAction: '请补足候选/澄清后重新执行 travel_resolve_places',
    }
  }
  if (placesState.status === 'stale' && placesState.staleReason === 'hash_mismatch') {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: 'places 工件内容与最近提交 hash 不符（外部篡改/损坏）：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }
  if (placesState.status === 'unknown' && placesState.staleReason === 'unaccounted' && placesState.meta?.stage === 'places') {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: 'places 最近一次提交声明属于 places 阶段，但工件未入账，无法验证完整性：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }
  if (placesState.status === 'stale' && placesState.staleReason === 'not_in_commit' && placesState.meta?.stage === 'places') {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: 'places 最近一次提交无法验证工件完整性：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }

  const artifact = placesState.data
  if (artifact === undefined) {
    return {
      blocked: true,
      reason: 'places_not_ready',
      detail: 'places.json 内容缺失',
      nextAction: '请先执行 travel_resolve_places 完成地理解析',
    }
  }
  // intel 证据版本领先于解析 → 解析过期（新研究使旧入口/选点失效）
  const intelVersion = await currentIntelVersion(store, planId)
  if (artifact.intelVersion < intelVersion) {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: `places 引用的 intel 证据版本（${artifact.intelVersion}）落后于当前研究版本（${intelVersion}）：新证据已使旧解析失效`,
      nextAction: '请基于当前研究结果重新执行 travel_resolve_places 后重试',
    }
  }
  const resolved = artifact.originResolution?.resolved === true
  if (artifact.entryPlaceId === undefined || !resolved) {
    return {
      blocked: true,
      reason: 'entry_not_resolved',
      detail: `入口必需字段未解析（entryPlaceId=${artifact.entryPlaceId ?? '缺失'}，originResolution.resolved=${resolved}）`,
      nextAction: '请执行 travel_resolve_places 并指定 entryCandidateId（解析入口城市/站/机场）后重试',
    }
  }
  const entryPlace = artifact.places.find((p) => p.placeId === artifact.entryPlaceId)
  if (entryPlace === undefined) {
    return {
      blocked: true,
      reason: 'entry_place_missing',
      detail: `entryPlaceId ${artifact.entryPlaceId} 未在 places 列表中找到`,
      nextAction: '请执行 travel_resolve_places 重新发布含该入口的解析结果',
    }
  }
  void request
  return undefined
}

/** 当前研究版本（research-state.researchVersion；无状态 → 0）。 */
async function currentIntelVersion(store: TravelStore, planId: string): Promise<number> {
  const state = await store.loadResearchState<{ researchVersion?: number }>(planId)
  return state?.researchVersion ?? 0
}

/** 站名归一（比较键：去空白与尾部「站」）。 */
function normalizeStationLabel(name: string): string {
  return name.trim().replace(/站$/, '')
}

/** 入口点位种类判定（city|station|airport|place；区分站名代码/机场/地点坐标）。 */
function entryKindOf(entry: ResolvedPlace): string {
  if (entry.kind === 'hub') return 'station'
  const name = entry.name.trim()
  if (/(机场|航站楼)$/.test(name)) return 'airport'
  if (/(站|车站|码头)$/.test(name) || /^[A-Z]{2,4}$/.test(name)) return 'station'
  return entry.pointKind === 'areaCenter' ? 'city' : 'place'
}

/** 明确住宿区：entry 之后首个 lodging/area 候选（无则 undefined）。 */
function lodgingAreaOf(artifact: PlacesArtifact, entryPlace: ResolvedPlace): string | undefined {
  const order = artifact.selectedSequence ?? []
  const seqIndex = new Map(order.map((candidateId, i) => [candidateId, i]))
  let best: { index: number; place: ResolvedPlace } | undefined
  for (const p of artifact.places) {
    if (p.candidateId === entryPlace.candidateId) continue
    if (p.kind !== 'lodging' && p.kind !== 'area') continue
    const idx = seqIndex.get(p.candidateId) ?? Number.MAX_SAFE_INTEGER
    if (best === undefined || idx < best.index) best = { index: idx, place: p }
  }
  return best?.place.name
}

/** 枢纽坐标解析（入口枢纽自身坐标优先 → amap geocode → tencent POI 兜底；缺省 undefined）。 */
async function resolveHubCoords(
  arrivalStation: string,
  entryPlace: ResolvedPlace,
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<GeoCoords | undefined> {
  // 入口即枢纽（kind=hub / 站名 / 机场名）且自带坐标 → 直接复用（不重新地理编码城市中心）
  const entryName = entryPlace.name.trim()
  const entryIsHub = entryPlace.kind === 'hub'
    || /(站|车站|机场|航站楼|码头)$/.test(entryName)
    || normalizeStationLabel(arrivalStation) === normalizeStationLabel(entryName)
  if (entryIsHub && entryPlace.coords !== undefined) return entryPlace.coords
  // 否则对真实到达站地理编码（缺 → 衔接未知；不把出发站/城市中心错用成终点）
  if (deps.amap && channelEnabled('cityAmap', deps.env)) {
    try {
      if (await deps.amap.available(deps.env)) {
        const { coords } = await deps.amap.geocode(arrivalStation, undefined, deps.env)
        if (coords) return coords
      }
    } catch (err) {
      degraded.push(toDegraded('hub/amap', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    }
  }
  return undefined
}

/**
 * 真实到达枢纽衔接：rail/flight/bus 方案的到达站 → 候选站匹配 + 枢纽坐标 + 市内衔接。
 * 方案 ID（H1/H2…）按到达站首次出现顺序分配，保证不同到达枢纽的衔接不串用。
 */
async function linkArrivalHubs(
  options: readonly TransportOption[],
  entryPlace: ResolvedPlace,
  lodgingArea: string | undefined,
  stationCandidates: Array<{ name: string; code: string }>,
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<{ hubLinks: TransportArrivalHubLink[]; transferByScheme: Map<string, CityTransfer> }> {
  const hubLinks: TransportArrivalHubLink[] = []
  const transferByScheme = new Map<string, CityTransfer>()
  const byArrival = new Map<string, string>() // arrivalStation -> schemeId
  const assigned: string[] = []

  for (const opt of options) {
    const arrival = opt.segments[0]?.to?.trim()
    if (!arrival) continue
    let schemeId = byArrival.get(arrival)
    if (schemeId === undefined) {
      schemeId = `H${assigned.length + 1}`
      assigned.push(arrival)
      byArrival.set(arrival, schemeId)
      const normalized = normalizeStationLabel(arrival)
      const matched = stationCandidates.find((s) => normalizeStationLabel(s.name) === normalized)
        ?? stationCandidates.find((s) => arrival.includes(normalizeStationLabel(s.name)) || s.name.includes(arrival))
      const coords = await resolveHubCoords(arrival, entryPlace, deps, degraded)
      const link: TransportArrivalHubLink = coords !== undefined
        ? { schemeId, arrivalStation: arrival, ...(matched !== undefined ? { matchedStation: matched.name } : {}), coords, linked: true }
        : {
            schemeId,
            arrivalStation: arrival,
            ...(matched !== undefined ? { matchedStation: matched.name } : {}),
            linked: false,
            unknown: true,
            reason: `枢纽「${arrival}」缺坐标：衔接未知（不猜测坐标，不把城市中心错用成终点）`,
          }
      hubLinks.push(link)
      // 城内衔接：真实到达枢纽 → 入口点/明确住宿区（无坐标则跳过，不伪造衔接）
      const to = lodgingArea ?? entryPlace.name
      if (coords !== undefined) {
        const transfer = await queryCityTransfer(arrival, to, [opt], deps, degraded)
        if (transfer !== undefined) transferByScheme.set(schemeId, transfer)
      }
    }
  }
  return { hubLinks, transferByScheme }
}

/** 出发入口检索 + 出发腿查询（完整计划路径；dateStart 单程，返程不自动新增）。 */
async function queryEntryLeg(
  origin: string,
  entryPlace: ResolvedPlace,
  date: string,
  artifact: PlacesArtifact,
  args: ResearchTransportArgs,
  deps: ResearchTransportDeps,
  degraded: DegradedEntry[],
): Promise<{ options: TransportOption[]; entry: TransportEntryReceipt; hubLinks: TransportArrivalHubLink[]; transferByScheme: Map<string, CityTransfer> }> {
  const env = deps.env
  const entryName = entryPlace.name

  // ① 出发入口检索：searchStations 解析入口城市 → 候选站（不把第一站默认当正确站）
  const stationCandidates: Array<{ name: string; code: string }> = []
  if (deps.rail && channelEnabled('rail12306', env)) {
    try {
      const { stations, degraded: sd } = await deps.rail.searchStations(entryName, env)
      degraded.push(...sd)
      stationCandidates.push(...stations.map((s) => ({ name: s.name, code: s.code })))
    } catch (err) {
      degraded.push(toDegraded('rail12306', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    }
  }

  // ② 出发腿查询：出发地 → 经验证入口城市/站/机场（dateStart 单程）
  const options = await queryIntercity(origin, entryName, date, args, deps, degraded)

  // ③ 真实到达枢纽衔接
  const lodgingArea = lodgingAreaOf(artifact, entryPlace)
  const { hubLinks, transferByScheme } = await linkArrivalHubs(
    options, entryPlace, lodgingArea, stationCandidates, deps, degraded,
  )

  const entry: TransportEntryReceipt = {
    origin,
    entryPlaceId: entryPlace.placeId,
    entryName,
    entryKind: entryKindOf(entryPlace),
    date,
    hubLinks,
    ...(lodgingArea !== undefined ? { lodgingArea } : {}),
    stationCandidates: stationCandidates.map((s) => s.name),
  }
  return { options, entry, hubLinks, transferByScheme }
}

/** 纯逻辑入口（测试直调）。 */
export async function runResearchTransport(
  args: ResearchTransportArgs,
  store: TravelStore,
  deps: ResearchTransportDeps,
): Promise<ResearchTransportResult> {
  // 计划级在途锁（C 期接线 F4-C5）：transport.json/versions/state 写路径串行化。
  return store.withPlanLock(args.planId, () => runResearchTransportUnlocked(args, store, deps))
}

async function runResearchTransportUnlocked(
  args: ResearchTransportArgs,
  store: TravelStore,
  deps: ResearchTransportDeps,
): Promise<ResearchTransportResult> {
  const now = new Date().toISOString()
  const request = await store.loadRequest(args.planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
  }
  const origin = request.slots.origin
  const date = request.slots.dateStart
  if (!origin) {
    throw new TravelValidationError(['槽位缺少 origin：请先 travel_intake 补齐'])
  }
  if (!date) {
    throw new TravelValidationError(['槽位缺少 dateStart：请先 travel_intake 补齐出发日期'])
  }
  const modes = args.modes ?? [...TRANSPORT_MODES]
  const unknown = modes.filter((m) => !isOneOf(m, TRANSPORT_MODES))
  if (unknown.length > 0) {
    throw new TravelValidationError([`modes 含非法模式：${unknown.join(', ')}（允许 ${TRANSPORT_MODES.join('|')}）`])
  }

  // ── T11 前置门：完整 plan（flowVersion 或已解析 places）──
  const placesState = await store.readArtifactWithState<PlacesArtifact>(args.planId, 'places.json')
  if (isCompletePlan(request, placesState.found)) {
    const gate = await transportGate(placesState, request, store, args.planId)
    if (gate !== undefined) {
      // 零网络：不调用任何适配器、不写 transport.json、不改状态
      return { planId: args.planId, options: [], comparison: undefined, cityTransfer: undefined, degraded: [], gate }
    }
  }

  const degraded: DegradedEntry[] = []
  if (isUnaccounted(placesState)) {
    degraded.push({
      source: 'transport/places', code: 'UNAVAILABLE',
      reason: `places.json 未入账（${placesState.status}/${placesState.staleReason ?? 'unknown'}），交通查询仅只读兼容消费，完整性无法证明`, at: now,
    })
  }

  // ── 完整计划：出发入口 + 枢纽衔接（legacy 之外的新路径）──
  if (isCompletePlan(request, placesState.found)) {
    const artifact = placesState.data!
    const entryPlace = artifact.places.find((p) => p.placeId === artifact.entryPlaceId)!
    assertTransition(request.status, 'researching')
    const { options, entry, transferByScheme } = await queryEntryLeg(
      origin, entryPlace, date, artifact, args, deps, degraded,
    )

    // 按方案 ID 挂载各自枢纽衔接（不串用）：options[].cityTransfer ← 该 option 到达站的衔接
    const attached = options.map((opt) => {
      const arrival = opt.segments[0]?.to?.trim()
      const schemeId = [...entry.hubLinks].find((h) => h.arrivalStation === arrival)?.schemeId
      const transfer = schemeId !== undefined ? transferByScheme.get(schemeId) : undefined
      return transfer !== undefined ? { ...opt, cityTransfer: transfer } : opt
    })

    const comparison = attached.length >= 2 ? buildComparison(attached, request) : undefined
    const kept: TransportOption[] = []
    const dropped: DegradedEntry[] = []
    for (const opt of attached) {
      const issues = validateTransportOption(opt)
      if (issues.length > 0) {
        dropped.push({ source: opt.mode, code: 'UNAVAILABLE', reason: `transport 条目校验失败已丢弃：${issues.map((i) => i.message).join('；')}`, at: now })
        continue
      }
      kept.push(opt)
    }
    const allDegraded = [...degraded, ...dropped]
    if (kept.length > 0) {
      await store.publishArtifacts(args.planId, {
        stage: 'transport',
        files: [{ name: 'transport.json', data: kept }],
        expectedVersions: { places: await store.currentVersion(args.planId, 'places') },
        bump: ['transport'],
        inputFingerprint: `transport:${date}:${origin}`,
      })
    }
    for (const d of allDegraded) await store.recordDegraded(args.planId, d)
    await store.saveRequest({ ...request, status: 'researching', updatedAt: now })
    return {
      planId: args.planId,
      options: kept,
      comparison,
      cityTransfer: entry.hubLinks.length > 0 ? transferByScheme.get(entry.hubLinks[0].schemeId) : undefined,
      degraded: [...allDegraded],
      entry,
    }
  }

  // ── legacy 单点/轻量路径（保持现状；按 W0 T1 判定规则）──
  const destination = request.slots.destination
  if (!destination) {
    throw new TravelValidationError(['槽位缺少 destination：请先 travel_intake 补齐'])
  }
  // 状态机：confirmed→researching / researching self
  assertTransition(request.status, 'researching')

  const options = await queryIntercity(origin, destination, date, args, deps, degraded)
  const cityTransfer = await queryCityTransfer(destination, destination, options, deps, degraded)

  // 比较（≥2 方案；FR-4 详 2）
  const comparison = options.length >= 2 ? buildComparison(options, request) : undefined

  // 契约闸门（validateTransportOption）：失败条目丢弃并记账
  const kept: TransportOption[] = []
  const dropped: DegradedEntry[] = []
  for (const opt of options) {
    const issues = validateTransportOption(opt)
    if (issues.length > 0) {
      dropped.push({
        source: opt.mode,
        code: 'UNAVAILABLE',
        reason: `transport 条目校验失败已丢弃：${issues.map((i) => i.message).join('；')}`,
        at: now,
      })
      continue
    }
    kept.push(opt)
  }
  const cityTransferAttached = kept.length > 0 && cityTransfer !== undefined
    ? kept.map((o, i) => (i === 0 ? { ...o, cityTransfer } : o)) // 推荐方案挂市内衔接
    : kept

  const allDegraded = [...degraded, ...dropped]
  if (kept.length > 0) {
    await store.publishArtifacts(args.planId, {
      stage: 'transport',
      files: [{ name: 'transport.json', data: cityTransferAttached }],
      expectedVersions: { intel: await store.currentVersion(args.planId, 'intel') },
      bump: ['transport'],
      inputFingerprint: `transport:${date}:${origin}:${destination}`,
    })
  }
  for (const entry of allDegraded) {
    await store.recordDegraded(args.planId, entry)
  }
  await store.saveRequest({ ...request, status: 'researching', updatedAt: now })

  return {
    planId: args.planId,
    options: cityTransferAttached,
    comparison,
    cityTransfer,
    degraded: [...allDegraded],
  }
}

// ────────────────────────── 展示 ──────────────────────────

function fmtDuration(minutes: number | undefined): string {
  if (minutes === undefined) return '未知'
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectTransport(r: ResearchTransportResult): TransportOutput {
  const projectOption = (o: TransportOption): Record<string, unknown> => ({
    mode: o.mode,
    segments: o.segments.map((s) => ({
      from: s.from, to: s.to, no: s.no, depart: s.depart, arrive: s.arrive,
      priceRange: s.priceRange, channel: s.channel,
    })),
    totalPriceRange: o.totalPriceRange,
    durationMinutes: o.durationMinutes,
    cityTransfer: o.cityTransfer,
    tags: o.tags,
    bookingTips: o.bookingTips,
    source: o.source,
  })
  return {
    planId: r.planId,
    options: r.options.map(projectOption) as TransportOutput['options'],
    comparison: r.comparison,
    cityTransfer: r.cityTransfer,
    degraded: [...r.degraded],
    ...(r.gate !== undefined ? { gate: JSON.parse(JSON.stringify(r.gate)) as TransportOutput['gate'] } : {}),
    ...(r.entry !== undefined ? { entry: JSON.parse(JSON.stringify(r.entry)) as TransportOutput['entry'] } : {}),
  }
}

function renderTransport(_args: TransportParams, value: TransportOutput): ContentBlock[] {
  if (value.gate !== undefined) {
    const g = value.gate as { reason: string; detail: string; nextAction: string }
    return textCard(`**travel_research_transport** · 前置门未通过（zero network）\n${cardLines([
      ['reason', g.reason],
      ['detail', g.detail],
      ['nextAction', g.nextAction],
    ])}`)
  }
  const lines: [string, string][] = [
    ['planId', value.planId],
    ['方案数', String(value.options.length)],
  ]
  if (value.entry !== undefined) {
    const e = value.entry as { origin: string; entryName: string; entryKind?: string; lodgingArea?: string }
    lines.push(['出发入口', `${e.origin} → ${e.entryName}${e.entryKind !== undefined ? `（${e.entryKind}）` : ''}${e.lodgingArea !== undefined ? `，住宿区：${e.lodgingArea}` : ''}`])
  }
  const byMode = new Map<string, number>()
  for (const opt of value.options) {
    byMode.set(opt.mode, (byMode.get(opt.mode) ?? 0) + 1)
  }
  if (byMode.size > 0) {
    lines.push(['模式分布', [...byMode.entries()].map(([m, n]) => `${m}=${n}`).join('，')])
  }
  const quick = value.options.slice(0, 4).map((o) => {
    const seg = o.segments[0]
    const price = o.totalPriceRange ? `¥${o.totalPriceRange[0]}~${o.totalPriceRange[1]}` : '价格待查'
    return `${seg?.no ?? o.mode} ${seg?.from ?? ''}→${seg?.to ?? ''} ${seg?.depart ?? ''}-${seg?.arrive ?? ''}（${fmtDuration(o.durationMinutes)}，${price}）`
  })
  if (quick.length > 0) {
    lines.push(['方案速览', quick.join('；')])
  }
  if (value.comparison) {
    lines.push(['对比·时间', value.comparison.time])
    lines.push(['对比·价格', value.comparison.price])
  }
  if (value.cityTransfer) {
    const opts = value.cityTransfer.options.map((o) => `${o.mode}（${o.durationMinutes !== undefined ? fmtDuration(o.durationMinutes) : '时长未知'}，${o.priceHint ?? '价格未知'}）`).join('；')
    lines.push(['市内衔接', `${value.cityTransfer.from} → ${value.cityTransfer.to}（${value.cityTransfer.provider}）${opts}`])
  }
  if (value.degraded.length > 0) {
    lines.push(['降级记录', value.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}`).join('；')])
  }
  let text = `**travel_research_transport** · 交通检索\n${cardLines(lines)}\n> 详情条目已写入 transport.json（对话内仅摘要）；价格为参考区间，以购票时实时价格为准`
  if (value.options.length === 0) {
    text += '\n> ⚠ 全部交通渠道失败/无结果，未生成 transport.json（§9.3-6）。请检查网络与配置后重试。'
  }
  return textCard(text)
}

/** 工具定义工厂。 */
export function createTravelResearchTransportTool(store: TravelStore, deps: ResearchTransportDeps): ToolDefinition {
  return defineTool({
    name: 'travel_research_transport',
    description: '交通检索（rail=12306 MCP 真实班次+票价档，不可用互备 wendao/flyai→搜索结构化；flight=wendao→flyai→搜索三档降级链，全空明示人工比价+官方渠道；bus=咨询级；市内衔接=高德+滴滴双方案，滴滴 Key 未配/失败自动降级高德单方案）。W3 T11：完整 plan（flowVersion 或已解析 places）首查 places.json——缺工件/版本过期/入口未解析 → 结构化 blocked+nextAction 且零网络（不回落 destination 绕过门）；按真实到达站匹配 searchStations 候选枢纽（不默认第一站），方案 ID 隔离不同到达枢纽衔接。≥2 方案输出对比；详情落盘 transport.json，对话内只回摘要卡片。',
    parameters: TRANSPORT_PARAMETERS,
    output: {
      schema: TRANSPORT_OUTPUT_SCHEMA,
      render: renderTransport,
    },
    timeoutMs: deps.timeoutMs ?? TRANSPORT_TIMEOUT_MS,
    presentCall(args) {
      const modes = Array.isArray(args?.modes) ? (args.modes as string[]).join('/') : 'rail/flight/bus'
      return { card: 'generic', title: `正在检索交通方案（${modes}）`, kind: 'search' }
    },
    async execute(args) {
      const result = await runResearchTransport({
        planId: args.planId,
        modes: args.modes as TransportMode[] | undefined,
      }, store, deps)
      // lossless-JSON 边界闸门：可选字段（segments.no/depart/arrive/channel、comparison、
      // cityTransfer 选项等）可能为 undefined，JSON 往返丢键会被宿主拒收（§6 输出契约）
      return losslessJson(projectTransport(result))
    },
  })
}