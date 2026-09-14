/**
 * travel_research_advice —— 出行建议：天气链 + 穿衣/物品（W3 新增；design §6 行 521）。
 *
 * 天气链（高德 → 腾讯 → Open-Meteo，逐链降级）：
 * - amap weather（需 key；4 天窗口）→ tencent weather 零 key（5 天；需目的地坐标）→
 *   Open-Meteo 免 key（16 天窗口；需目的地坐标）
 * - 行程日期超出全部预报窗口 → beyondForecastWindow:true + 气候概况标注
 *   （L0 搜索历史同期气温做气候概况；检索失败则如实说明以临近预报为准）
 * - 每条天气条目含数据日期（source.fetchedAt）与来源（source.platform）——FR-5 验收①
 *
 * W3 T13（草稿 E 段）——advice 按已解析地点归属天气：
 * - 读取 places.json 已解析地点并逐地点增加天气条目归属（placeId/location）；
 *   selectedSequence 去重保序逐地查询，不得用西宁代表整条环线。
 * - 有逐地日期（placeDates 输入）查对应日；无则按所选城市查询旅行窗口并标
 *   「未分配逐地日期」（placeDateAssigned=false 显式标注）。
 * - 不因交通失败/渠道不可用取消可用天气研究（advice 独立于 transport；
 *   transport degraded 不影响 advice 执行）。
 * - Open-Meteo 窗口 P0-1 修复保持 OUT——本任务只改地理输入与归属；若 live 实测
 *   被窗口 400 阻塞 → 如实登记独立 blocker，不擅扩修。
 *
 * 穿衣/物品（FR-5 验收②）：规则模板按温度区间 + 天气（雨/寒）生成穿衣建议；
 * 物品清单 ≥10 项并叠加用户画像（老人/儿童/徒步主题/季节）定制；extraTips 由
 * L0 搜索命中合成（注意事项/证件）。
 *
 * 统一机制：60s 预算；逐源失败 → degraded 记账继续；advice.json 落盘（§5.5）。
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  channelEnabled, toDegraded,
  type DegradedEntry, type KeyResolutionEnv,
} from '../adapters/base.js'
import { AmapAdapter } from '../adapters/amap.js'
import { TencentMapAdapter } from '../adapters/tencent.js'
import { OpenMeteoAdapter } from '../adapters/open-meteo.js'
import { redactSensitiveText, redactSensitiveUrl, SearchAdapter } from '../adapters/search.js'
import type { Advice, AdviceWeatherEntry, PlacesArtifact, ResearchState, ResolvedPlace, TemperatureBasis, TravelRequest } from '../models/types.js'
import { validateAdvice } from '../models/validate.js'
import { daysBetweenInclusive, isDateString } from '../models/validate.js'
import { TravelValidationError } from '../errors.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { assertTransitionEx } from '../store/state.js'
import { cardLines, losslessJson, textCard } from './common.js'

/** §6 行 521：research_advice 超时（120s：天气链 amap→tencent→open-meteo 顺序叠加
 * 坐标解析与 L0 搜索，60s 实测不足导致回执触顶，放宽后逐源省略链照常降级记账）。 */
export const ADVICE_TIMEOUT_MS = 120_000

/** 物品清单下限（FR-5 验收②：≥10 项）。 */
export const PACKING_MIN = 10

/** 单次 placeDates 上限（防 fanout 失控；选中序列 ≤30 的正常远小于）。 */
export const ADVICE_PLACE_DATES_MAX = 60

export interface ResearchAdviceArgs {
  planId: string
  /** T13（草稿 E）：逐地日期（placeId → 该地查询的日期列表）；缺省 → 旅行窗口 + 显式标注未分配。 */
  placeDates?: Array<{ placeId: string; dates: string[] }>
}

/** 装配依赖（index.ts 注入真实适配器；测试注入 mock/fixture）。 */
export interface ResearchAdviceDeps {
  amap?: AmapAdapter
  tencent?: TencentMapAdapter
  openMeteo?: OpenMeteoAdapter
  search?: SearchAdapter
  /** 统一超时预算（缺省 60s）。 */
  timeoutMs?: number
  /** 单次建议开始回调（P0-A R6：工具执行入口恰一次重置规划预算）。 */
  resetPlanBudget?: () => void
  /** ADR-12 热读取环境（渠道开关前置过滤）。 */
  env?: KeyResolutionEnv
}

export interface ResearchAdviceResult {
  planId: string
  weather: AdviceWeatherEntry[]
  clothing: string[]
  packingList: string[]
  extraTips: string[]
  degraded: DegradedEntry[]
  /** C4 门：完整 plan 无有效 places → 结构化 blocked + nextAction（非静默单城市兜底）。 */
  blocked?: { reason: string; nextAction: string }
}

function redactDegradedEntry(entry: DegradedEntry): DegradedEntry {
  return {
    ...entry,
    source: redactSensitiveText(entry.source),
    reason: redactSensitiveText(entry.reason),
    ...(entry.candidateId !== undefined ? { candidateId: redactSensitiveText(entry.candidateId) } : {}),
    ...(entry.placeId !== undefined ? { placeId: redactSensitiveText(entry.placeId) } : {}),
  }
}

function redactAdvice(advice: Advice): Advice {
  return {
    weather: advice.weather.map((entry) => ({
      ...entry,
      dayForecast: entry.dayForecast === undefined ? undefined : redactSensitiveText(entry.dayForecast),
      source: {
        ...entry.source,
        platform: redactSensitiveText(entry.source.platform),
        url: redactSensitiveUrl(entry.source.url),
      },
      ...(entry.placeId !== undefined ? { placeId: redactSensitiveText(entry.placeId) } : {}),
      ...(entry.location !== undefined ? { location: redactSensitiveText(entry.location) } : {}),
    })),
    clothing: advice.clothing.map((value) => redactSensitiveText(value)),
    packingList: advice.packingList.map((value) => redactSensitiveText(value)),
    extraTips: advice.extraTips.map((value) => redactSensitiveText(value)),
  }
}

const ADVICE_PARAMETERS = {
  planId: {
    type: 'string',
    required: true,
    description: '计划 ID（必填；须先 travel_intake 建立计划且状态非终态锁定）',
  } as const,
  placeDates: {
    type: 'array',
    items: { type: 'json' },
    description: 'T13 可选：逐地日期 [{placeId, dates:[YYYY-MM-DD,…]}]；缺省按旅行窗口查询该地并显式标注「未分配逐地日期」',
  } as const,
} as const

type AdviceParams = InferArgs<typeof ADVICE_PARAMETERS>

const WEATHER_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', required: true },
    dayForecast: { type: 'string' },
    tempRange: { type: 'array', items: { type: 'number' } },
    temperatureBasis: { type: 'string', enum: ['seasonal-template', 'historical', 'forecast'] },
    beyondForecastWindow: { type: 'boolean' },
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: { type: 'string', required: true },
        url: { type: 'string', required: true },
        fetchedAt: { type: 'string', required: true },
      },
      required: true,
    },
    /** T13：逐地归属（placeId/location/placeDateAssigned）。 */
    placeId: { type: 'string' },
    location: { type: 'string' },
    placeDateAssigned: { type: 'boolean' },
  },
} as const

export const ADVICE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    weather: { type: 'array', required: true, items: { ...WEATHER_ENTRY_SCHEMA } },
    clothing: { type: 'array', required: true, items: { type: 'string' } },
    packingList: { type: 'array', required: true, items: { type: 'string' } },
    extraTips: { type: 'array', required: true, items: { type: 'string' } },
    blocked: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true },
        nextAction: { type: 'string', required: true },
      },
    },
    degraded: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          code: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          at: { type: 'string', required: true },
          candidateId: { type: 'string' },
          placeId: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    },
  },
} as const

type AdviceOutput = InferValue<typeof ADVICE_OUTPUT_SCHEMA>

// ────────────────────────── 天气链 ──────────────────────────

/** 行程日期序列（含首尾）。 */
export function tripDates(dateStart: string, dateEnd: string): string[] {
  const days = daysBetweenInclusive(dateStart, dateEnd)
  const out: string[] = []
  const start = new Date(`${dateStart}T00:00:00.000Z`)
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/** 目的地坐标解析（amap 地理编码 → 腾讯 POI 首条坐标；供腾讯天气/Open-Meteo）。 */
async function resolveDestinationCoords(
  destination: string,
  deps: ResearchAdviceDeps,
  degraded: DegradedEntry[],
): Promise<{ lng: number; lat: number } | undefined> {
  if (deps.amap) {
    try {
      const { coords } = await deps.amap.geocode(destination, undefined, deps.env)
      if (coords) return { lng: coords.lng, lat: coords.lat }
    } catch {
      degraded.push(toDegraded('coords/amap', 'UNAVAILABLE', '高德地理编码失败（坐标降级）'))
    }
  }
  if (deps.tencent) {
    try {
      const result = await deps.tencent.poiSearch({ keywords: destination, region: destination, pageSize: 5 })
      const first = result.data.find((i) => i.coords !== undefined)
      if (first?.coords) return { lng: first.coords.lng, lat: first.coords.lat }
    } catch {
      degraded.push(toDegraded('coords/tencent', 'UNAVAILABLE', '腾讯 POI 坐标解析失败'))
    }
  }
  return undefined
}

/** 本地季节模板：搜索不可用/无可抽取温度时仍提供可读范围与风日防护。 */
export function seasonalClimateTemplate(
  destination: string,
  month: number,
): { text: string; tempRange: [number, number]; temperatureBasis: 'seasonal-template' } {
  const season = month === 12 || month <= 2
    ? { label: '冬季', range: [-10, 8] as [number, number] }
    : month <= 5
      ? { label: '春季', range: [5, 22] as [number, number] }
      : month <= 8
        ? { label: '夏季', range: [15, 30] as [number, number] }
        : { label: '秋季', range: [5, 23] as [number, number] }
  const [low, high] = season.range
  return {
    text: `通用季节规划参考（${destination} ${month}月${season.label}）：约 ${low}~${high}℃；这是通用季节范围，非目的地/海拔实测；风力变化时备防风外层，晴天紫外线较强请做好防晒（帽子/墨镜/防晒霜）；以临近预报为准`,
    tempRange: season.range,
    temperatureBasis: 'seasonal-template',
  }
}

/** L0 气候概况（超预报窗口时）：搜索「目的地 + 月份 平均气温」，抽取温度区间。 */
async function climateOverview(
  destination: string,
  month: number,
  search: SearchAdapter | undefined,
): Promise<{ text: string; tempRange?: [number, number]; temperatureBasis?: TemperatureBasis; url?: string }> {
  const seasonal = seasonalClimateTemplate(destination, month)
  if (!search) return seasonal
  try {
    const result = await search.searchL0({
      keywords: `${destination} ${month}月 平均气温 气候`,
      sites: [],
      maxResultsPerQuery: 4,
    })
    for (const hit of result.data.hits) {
      const m = /(\d{1,2})[~\-—至到](\d{1,2})\s*℃?度?/.exec(`${hit.title} ${hit.summary ?? ''}`)
      if (m) {
        const lo = Number(m[1])
        const hi = Number(m[2])
        if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
          const tempRange: [number, number] = [lo, hi]
          return {
            text: `气候概况（历史同期参考，来源：${hit.source.platform}）；注意防风，晴天注意防晒`,
            tempRange,
            temperatureBasis: 'historical',
            url: redactSensitiveUrl(hit.url),
          }
        }
      }
    }
    return { ...seasonal, text: `${seasonal.text}；L0 未抽取到可验证历史温度区间` }
  } catch {
    return { ...seasonal, text: `${seasonal.text}；历史同期数据检索失败` }
  }
}

/** 逐日天气组装：优先 amap → tencent → open-meteo；全部缺位 → 气候概况条目。 */
async function assembleWeather(
  destination: string,
  dates: readonly string[],
  deps: ResearchAdviceDeps,
  degraded: DegradedEntry[],
  search: SearchAdapter | undefined,
): Promise<AdviceWeatherEntry[]> {
  const env = deps.env
  const byDate = new Map<string, AdviceWeatherEntry>()

  if (deps.amap && channelEnabled('weatherAmap', env)) {
    try {
      const { entries, degraded: d } = await deps.amap.weather(destination, env)
      degraded.push(...d)
      for (const e of entries) {
        if (!byDate.has(e.date)) byDate.set(e.date, { ...e, temperatureBasis: e.temperatureBasis ?? 'forecast' })
      }
    } catch (err) {
      degraded.push(toDegraded('weatherAmap', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    }
  } else if (deps.amap) {
    degraded.push(toDegraded('weatherAmap', 'UNAVAILABLE', '已停用（用户配置）'))
  }

  const coords = await resolveDestinationCoords(destination, deps, degraded)

  if (deps.tencent && channelEnabled('weatherTencent', env)) {
    try {
      if (coords) {
        const result = await deps.tencent.weather({ location: `${coords.lat},${coords.lng}` })
        for (const e of result.data.days) {
          if (!byDate.has(e.date)) byDate.set(e.date, { ...e, temperatureBasis: e.temperatureBasis ?? 'forecast' })
        }
      } else {
        degraded.push(toDegraded('weatherTencent', 'UNAVAILABLE', '缺少目的地坐标，腾讯天气（location 模式）无法查询'))
      }
    } catch (err) {
      degraded.push(toDegraded('weatherTencent', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    }
  } else if (deps.tencent) {
    degraded.push(toDegraded('weatherTencent', 'UNAVAILABLE', '已停用（用户配置）'))
  }

  if (deps.openMeteo && channelEnabled('weatherOpenMeteo', env)) {
    try {
      if (coords) {
        const { entries, degraded: d } = await deps.openMeteo.dailyForecast(
          coords.lat, coords.lng, dates[0], dates[dates.length - 1], env,
        )
        degraded.push(...d)
        for (const e of entries) {
          if (!byDate.has(e.date)) byDate.set(e.date, { ...e, temperatureBasis: e.temperatureBasis ?? 'forecast' })
        }
      } else {
        degraded.push(toDegraded('weatherOpenMeteo', 'UNAVAILABLE', '缺少目的地坐标，Open-Meteo 无法查询'))
      }
    } catch (err) {
      degraded.push(toDegraded('weatherOpenMeteo', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    }
  } else if (deps.openMeteo) {
    degraded.push(toDegraded('weatherOpenMeteo', 'UNAVAILABLE', '已停用（用户配置）'))
  }

  const out: AdviceWeatherEntry[] = []
  for (const date of dates) {
    const entry = byDate.get(date)
    if (entry !== undefined) {
      out.push(entry)
      continue
    }
    // 超出全部预报窗口 → 气候概况条目（FR-5 详 1）
    const month = Number(date.slice(5, 7))
    const overview = await climateOverview(destination, month, search)
    out.push({
      date,
      dayForecast: overview.text,
      tempRange: overview.tempRange,
      temperatureBasis: overview.temperatureBasis,
      beyondForecastWindow: true,
      source: {
        platform: 'climate-overview',
        url: overview.url ?? 'https://example.invalid/climate',
        fetchedAt: new Date().toISOString(),
      },
    })
  }
  return out
}

/**
 * T13 逐地点天气组装（草稿 E）：一个已解析地点的一条 window 天气。
 * - amap（城市名）→ tencent/Open-Meteo（该地坐标；无坐标则如实降级不猜）
 * - 每条 entry 挂 placeId/location；assigned=false 显式标注「未分配逐地日期」
 * - 该地全渠道不可用 → 该地独立气候概况条目（不挪用他地数据冒充）
 */
async function assemblePlaceWeather(
  place: ResolvedPlace,
  dates: readonly string[],
  assigned: boolean,
  deps: ResearchAdviceDeps,
  degraded: DegradedEntry[],
  search: SearchAdapter | undefined,
): Promise<AdviceWeatherEntry[]> {
  const env = deps.env
  const label = place.name
  const byDate = new Map<string, AdviceWeatherEntry>()
  const mark = (e: AdviceWeatherEntry): AdviceWeatherEntry => ({
    ...e,
    placeId: place.placeId,
    location: label,
    placeDateAssigned: assigned,
  })
  const markDay = (date: string, e: AdviceWeatherEntry): void => {
    if (!byDate.has(date)) byDate.set(date, mark({ ...e, temperatureBasis: e.temperatureBasis ?? 'forecast' }))
  }

  if (deps.amap && channelEnabled('weatherAmap', env)) {
    try {
      // 高德按城市/行政区名查询（该地 district 优先，缺省地名）
      const { entries, degraded: d } = await deps.amap.weather(place.district ?? label, env)
      degraded.push(...d)
      for (const e of entries) markDay(e.date, e)
    } catch (err) {
      degraded.push(toDegraded('weatherAmap', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
    }
  } else if (deps.amap) {
    degraded.push(toDegraded('weatherAmap', 'UNAVAILABLE', '已停用（用户配置）'))
  }

  const coords = place.coords
  if (coords !== undefined) {
    if (deps.tencent && channelEnabled('weatherTencent', env)) {
      try {
        const result = await deps.tencent.weather({ location: `${coords.lat},${coords.lng}` })
        for (const e of result.data.days) markDay(e.date, e)
      } catch (err) {
        degraded.push(toDegraded('weatherTencent', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      }
    } else if (deps.tencent) {
      degraded.push(toDegraded('weatherTencent', 'UNAVAILABLE', '已停用（用户配置）'))
    }
    if (deps.openMeteo && channelEnabled('weatherOpenMeteo', env)) {
      try {
        const { entries, degraded: d } = await deps.openMeteo.dailyForecast(
          coords.lat, coords.lng, dates[0], dates[dates.length - 1], env,
        )
        degraded.push(...d)
        for (const e of entries) markDay(e.date, e)
      } catch (err) {
        degraded.push(toDegraded('weatherOpenMeteo', 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      }
    } else if (deps.openMeteo) {
      degraded.push(toDegraded('weatherOpenMeteo', 'UNAVAILABLE', '已停用（用户配置）'))
    }
  } else {
    degraded.push(toDegraded('coords/place', 'UNAVAILABLE', `地点「${label}」无坐标：腾讯/Open-Meteo（需坐标）不查询该地，不挪用他地数据`))
  }

  const out: AdviceWeatherEntry[] = []
  for (const date of dates) {
    const entry = byDate.get(date)
    if (entry !== undefined) {
      out.push(entry)
      continue
    }
    const month = Number(date.slice(5, 7))
    const overview = await climateOverview(label, month, search)
    out.push(mark({
      date,
      dayForecast: `${overview.text}${assigned ? '' : '（未分配逐地日期：按旅行窗口查询）'}`,
      tempRange: overview.tempRange,
      temperatureBasis: overview.temperatureBasis,
      beyondForecastWindow: true,
      source: {
        platform: 'climate-overview',
        url: overview.url ?? 'https://example.invalid/climate',
        fetchedAt: new Date().toISOString(),
      },
    }))
  }
  return out
}

/** 当前研究版本 = intel 证据版本（研究 provider 以 research-state.researchVersion 演进）。 */
async function currentIntelVersion(store: TravelStore, planId: string): Promise<number> {
  const state = await store.readArtifactWithState<ResearchState>(planId, 'research-state.json')
  return readableArtifact(state)?.researchVersion ?? 0
}

/** 是否「已可靠解析、可作逐地天气对象」的候选（C4 业务状态门）。 */
function isWeatherUsable(place: ResolvedPlace): boolean {
  // needs_clarification（待澄清）与 blocked（被排除/degraded）候选即使带坐标也不算。
  // 方案 B：这是 advice 的地点业务门，不传染 build/route 的 envelope 门。
  return place.pendingClarification === undefined && place.excludeReason === undefined
}

interface SkippedAdvicePlace {
  candidateId: string
  placeId?: string
  name: string
  reason: string
}

interface LoadedAdvicePlaces {
  places: ResolvedPlace[]
  skipped: SkippedAdvicePlace[]
  selectedCandidateIds: string[]
}

/**
 * 读取当前 places 已解析地点（T13：只消费可用数据；多发布批次下 not_in_commit
 * 不误杀——真正不可用=缺工件/发布失败/空/hash 失配）。
 *
 * T13/P1-A：业务状态过滤只排除对应地点。只要仍有一个可天气地点，就继续逐地
 * 扇出；被 pendingClarification/excludeReason 排除的候选各自写入 degraded，并带
 * candidateId/placeId，绝不以另一地点天气代替。只有过滤后 N=0 才由上层 blocked。
 */
/** unknown/未入账可读兼容；失败/空结果/hash 失配不可消费。 */
function readableArtifact<T>(state: ArtifactReadState<T>): T | undefined {
  if (!state.found || state.data === undefined || state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

function isUnaccounted<T>(state: ArtifactReadState<T>): boolean {
  return state.status === 'unknown'
    || (state.status === 'stale' && state.staleReason === 'not_in_commit')
}

async function loadResolvedPlaces(
  store: TravelStore, planId: string, degraded: DegradedEntry[], now: string,
): Promise<LoadedAdvicePlaces | undefined> {
  const state = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  if (!state.found || state.data === undefined) return undefined
  if (state.status === 'failed' || state.meta?.status === 'failed') return undefined
  if (state.status === 'empty' || state.meta?.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  if (state.status === 'unknown' && state.staleReason === 'unaccounted' && state.meta?.stage === 'places') {
    degraded.push({
      source: 'advice/places', code: 'UNAVAILABLE',
      reason: 'places 最近一次提交声明属于 places 阶段，但工件未入账，无法验证完整性：不消费旧地点', at: now,
    })
    return undefined
  }
  if (state.status === 'stale' && state.staleReason === 'not_in_commit' && state.meta?.stage === 'places') {
    degraded.push({
      source: 'advice/places', code: 'UNAVAILABLE',
      reason: 'places 最近一次提交无法验证工件完整性：不消费旧地点', at: now,
    })
    return undefined
  }
  if (isUnaccounted(state)) {
    degraded.push({
      source: 'advice/places', code: 'UNAVAILABLE',
      reason: `places.json 未入账（${state.status}/${state.staleReason ?? 'unknown'}），逐地天气仅只读兼容消费，完整性无法证明`, at: now,
    })
  }
  const artifact = state.data
  // C4：研究前进门（研究版本落后 → 不消费旧坐标）。
  const currentResearch = await currentIntelVersion(store, planId)
  if (artifact.intelVersion < currentResearch) {
    degraded.push({
      source: 'advice/places', code: 'UNAVAILABLE',
      reason: `places 消费的 intel 证据版本（${artifact.intelVersion}）落后于当前研究版本（${currentResearch}）：研究已前进，请重新 travel_resolve_places 后再求建议`,
      at: now,
    })
    return undefined
  }
  const sequence = artifact.selectedSequence ?? []
  const selectedCandidateIds = [...new Set(sequence)]
  const byCandidate = new Map(artifact.places.map((p) => [p.candidateId, p]))
  const byPlace = new Map(artifact.places.map((p) => [p.placeId, p]))
  const seen = new Set<string>()
  const out: ResolvedPlace[] = []
  const skipped: SkippedAdvicePlace[] = []
  for (const id of sequence) {
    const p = byCandidate.get(id) ?? byPlace.get(id)
    if (p === undefined) {
      const reason = `selectedSequence 引用的候选 ${id} 不在当前 places 快照中：不参与逐地天气`
      skipped.push({ candidateId: id, name: id, reason })
      degraded.push({ source: 'advice/places', code: 'UNAVAILABLE', reason, at: now, candidateId: id })
      continue
    }
    if (seen.has(p.placeId)) continue
    seen.add(p.placeId)
    if (!isWeatherUsable(p)) {
      const reason = `地点「${p.name}」${p.excludeReason !== undefined ? '未获可靠解析（blocked）' : '待澄清（needs_clarification）'}：不参与逐地天气，不挪用他地数据`
      skipped.push({ candidateId: p.candidateId, placeId: p.placeId, name: p.name, reason })
      degraded.push({
        source: 'advice/places', code: 'UNAVAILABLE', reason, at: now,
        candidateId: p.candidateId, placeId: p.placeId,
      })
      continue
    }
    out.push(p)
  }
  return { places: out, skipped, selectedCandidateIds }
}

// ────────────────────────── 穿衣/物品（模板 + 画像 + L0 合成） ──────────────────────────

/** 行程平均温度：排除通用 seasonal-template，避免模板区间驱动精确穿衣/物品。 */
function avgTripTemp(weather: readonly AdviceWeatherEntry[]): number | undefined {
  const mids: number[] = []
  for (const e of weather) {
    if (e.tempRange && e.temperatureBasis !== 'seasonal-template') {
      mids.push((e.tempRange[0] + e.tempRange[1]) / 2)
    }
  }
  if (mids.length === 0) return undefined
  return mids.reduce((a, b) => a + b, 0) / mids.length
}

function hasRain(weather: readonly AdviceWeatherEntry[]): boolean {
  return weather.some((e) => /雨|雷|雪|毛毛雨|冻雨|阵雨/.test(e.dayForecast ?? ''))
}

/** 温度区间 → 穿衣建议（模板规则，FR-5 详 2）。 */
export function clothingForTemp(
  avgTemp: number | undefined,
  weather: readonly AdviceWeatherEntry[],
  request: TravelRequest,
): string[] {
  const items: string[] = []
  const seniors = request.slots.travelers?.seniors ?? 0
  const children = request.slots.travelers?.children ?? 0
  const themes = request.slots.preferences?.themes ?? []
  // 防止调用方误把 seasonal-template 的中值作为精确决策输入；空 weather
  // 仅保留旧的纯函数兼容性，实际研究路径总会传入天气条目。
  const hasReliableTemperature = weather.length === 0
    || weather.some((entry) => entry.tempRange !== undefined && entry.temperatureBasis !== 'seasonal-template')
  const effectiveAvgTemp = hasReliableTemperature ? avgTemp : undefined

  if (effectiveAvgTemp === undefined) {
    items.push('季节分层着装：轻便长袖 + 可叠加保暖层，备防风外套')
    items.push('晴天防护：遮阳帽、墨镜与防晒霜；出行前以临近预报微调')
  } else if (effectiveAvgTemp >= 28) {
    items.push('短袖 T 恤/连衣裙、轻薄透气面料')
    items.push('遮阳帽 + 防晒衣 + 墨镜')
  } else if (effectiveAvgTemp >= 20) {
    items.push('长袖衬衫/T 恤 + 薄外套（早晚温差备用）')
    items.push('轻便长裤/裙装')
  } else if (effectiveAvgTemp >= 10) {
    items.push('毛衣/卫衣 + 厚外套或夹克')
    items.push('长裤 + 保暖袜')
  } else {
    items.push('羽绒服/厚棉服 + 保暖内衣')
    items.push('围巾、手套、帽子（防寒三件套）')
  }
  if (hasRain(weather)) {
    items.push('防水外套/雨衣 + 防滑鞋')
  }
  if (seniors > 0) {
    items.push('老人：宽松舒适层叠穿法（保暖且便于穿脱）')
  }
  if (children > 0) {
    items.push('儿童：多带一套备用衣裤（活动易汗湿）')
  }
  if (themes.includes('徒步') || themes.includes('自然')) {
    items.push('徒步/户外：速干衣 + 徒步裤 + 登山鞋')
  }
  return items
}

/** 物品清单（≥10 项基础 + 画像定制扩展；FR-5 验收②）。 */
export function buildPackingList(
  weather: readonly AdviceWeatherEntry[],
  request: TravelRequest,
): string[] {
  const seniors = request.slots.travelers?.seniors ?? 0
  const children = request.slots.travelers?.children ?? 0
  const themes = request.slots.preferences?.themes ?? []
  const rain = hasRain(weather)
  const avgTemp = avgTripTemp(weather)
  const list = [
    '身份证（及儿童户口本/老年证）',
    '手机 + 充电宝',
    '充电线 + 充电头',
    '换洗衣物（按天数 +1 套备用）',
    '洗漱用品（旅行装）',
    '常用药品（感冒药/肠胃药/创可贴）',
    '纸巾/湿巾',
    '水杯',
    '现金（少量）+ 银行卡/移动支付',
    '证件复印件或电子备份',
    '防晒霜（春夏出行）',
    '雨具（折叠伞/雨衣）',
  ]
  const dedup = (items: string[]): string[] => [...new Set(items)]
  if (rain) list.push('防雨鞋套/防水袋（保护电子设备）')
  if (avgTemp !== undefined && avgTemp < 10) list.push('暖宝宝/保温杯')
  if (avgTemp !== undefined && avgTemp >= 25) list.push('遮阳帽 + 防晒霜（SPF50）')
  if (seniors > 0) list.push('老人常备药（降压/心脏用药）+ 保温杯', '舒适防滑鞋（老人）')
  if (children > 0) list.push('儿童：奶粉/辅食/纸尿裤', '儿童玩具/绘本（安抚）')
  if (themes.includes('徒步') || themes.includes('自然')) list.push('登山鞋', '双肩背包', '护膝/登山杖')
  if (themes.includes('美食')) list.push('健胃消食片/肠胃药（美食之旅备用）')
  if (themes.includes('人文')) list.push('博物馆/景区预约 App（提前预约）')
  return dedup(list)
}

/** L0 搜索命中 → extraTips（注意事项/证件/安全，最多 4 条去重）。 */
async function searchExtraTips(
  destination: string,
  search: SearchAdapter | undefined,
  degraded: DegradedEntry[],
): Promise<string[]> {
  if (!search) return []
  try {
    const result = await search.searchL0({
      keywords: `${destination} 旅行 注意事项 证件 安全 预约`,
      sites: [],
      maxResultsPerQuery: 5,
    })
    const grouped = new Map<string, { text: string; urls: string[] }>()
    for (const hit of result.data.hits) {
      const text = (hit.summary?.trim() || hit.title.trim())
      if (text === '') continue
      const key = text.replace(/\s+/g, ' ').toLowerCase()
      const existing = grouped.get(key)
      if (existing === undefined) grouped.set(key, { text, urls: [hit.url] })
      else if (!existing.urls.includes(hit.url)) existing.urls.push(hit.url)
    }
    const tips = [...grouped.values()].slice(0, 4)
      .map(({ text, urls }) => `${text}（来源：${urls.join('、')}）`)
    if (tips.length === 0) {
      degraded.push(toDegraded('adviceSearch', 'EMPTY', 'L0 注意事项搜索无命中'))
    }
    return tips
  } catch {
    degraded.push(toDegraded('adviceSearch', 'UNAVAILABLE', 'L0 注意事项搜索失败'))
    return []
  }
}

// ────────────────────────── 域逻辑入口 ──────────────────────────

/** 外部计划锁占用时的结构化出口：不运行天气链、不写 advice.json，调用方可重试。 */
function blockedByInFlight(planId: string): ResearchAdviceResult {
  return {
    planId,
    weather: [],
    clothing: [],
    packingList: [],
    extraTips: [],
    degraded: [],
    blocked: {
      reason: 'in_flight',
      nextAction: '当前计划存在外部在途任务，待其完成或取消后重新执行 travel_research_advice',
    },
  }
}

/** 进入 researching 前持久化每一条扩展状态边；调用方锁快照不把本工具自锁算作在途。 */
async function enterResearching(
  request: TravelRequest,
  store: TravelStore,
  now: string,
  inFlightSnapshot: boolean,
): Promise<TravelRequest> {
  let current = request
  if (current.status === 'generating') {
    assertTransitionEx('generating', 'revising', inFlightSnapshot)
    current = { ...current, status: 'revising', updatedAt: now }
    await store.saveRequest(current)
    assertTransitionEx('revising', 'researching', inFlightSnapshot)
    current = { ...current, status: 'researching', updatedAt: now }
    await store.saveRequest(current)
    return current
  }

  assertTransitionEx(current.status, 'researching', inFlightSnapshot)
  if (current.status !== 'researching') {
    current = { ...current, status: 'researching', updatedAt: now }
    await store.saveRequest(current)
  }
  return current
}

/** 纯逻辑（测试直调）。 */
export async function runResearchAdvice(
  args: ResearchAdviceArgs,
  store: TravelStore,
  deps: ResearchAdviceDeps,
): Promise<ResearchAdviceResult> {
  // 计划级在途锁（C 期接线 F4-C5）：advice.json 落盘串行化。
  // 快照必须在取本工具锁前读取，故 generating→revising 的门只判断外部任务，
  // 不把本工具自己刚取得的锁误判为在途。
  const inFlightSnapshot = store.isPlanLocked(args.planId)
  return store.withPlanLock(args.planId, () => runResearchAdviceUnlocked(args, store, deps, inFlightSnapshot))
}

async function runResearchAdviceUnlocked(
  args: ResearchAdviceArgs,
  store: TravelStore,
  deps: ResearchAdviceDeps,
  inFlightSnapshot: boolean,
): Promise<ResearchAdviceResult> {
  const now = new Date().toISOString()
  const request = await store.loadRequest(args.planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
  }
  const destination = request.slots.destination
  const dateStart = request.slots.dateStart
  const dateEnd = request.slots.dateEnd
  // C4 门：完整 plan（flowVersion）按已解析地点逐地归属天气——可能目的地为空的
  // discovery-only，不强制 destination。legacy（无 flowVersion）单目的地路径强制
  // destination（保持现状单点查询行为）。
  const isFullPlan = request.flowVersion !== undefined
  if (!isFullPlan && !destination) {
    throw new TravelValidationError(['槽位缺少 destination：请先 travel_intake 补齐目的地'])
  }
  if (!dateStart || !dateEnd || !isDateString(dateStart) || !isDateString(dateEnd)) {
    throw new TravelValidationError(['槽位缺少完整日期区间（dateStart/dateEnd）：请先 travel_intake 补齐'])
  }
  if (inFlightSnapshot) return blockedByInFlight(args.planId)
  const researchingRequest = await enterResearching(request, store, now, inFlightSnapshot)

  const degraded: DegradedEntry[] = []
  const dates = tripDates(dateStart, dateEnd)

  // P1-缺口修复：`adviceSearch`（channels.fr5.adviceSearch，设置页「穿衣/物品 web_search」）
  // 是 L0 检索渠道的显式开关，此前被 schema/UI/渠道路径表登记却从未被消费 —— 用户关掉后
  // extraTips（L0 注意事项）与 climateOverview（历史同期温度）仍会发起检索，且不产生
  // 「已停用（用户配置）」回执，与设置页承诺的「被停用的渠道在检索编排中跳过」不符。
  // 关闭语义 = 该渠道零调用（不发起 L0 检索）；气候条目回落本地季节模板（T22），
  // 不以模板冒充实测（`temperatureBasis='seasonal-template'` 已由 avgTripTemp 排除）。
  const searchDisabled = deps.search !== undefined && !channelEnabled('adviceSearch', deps.env)
  const search = searchDisabled ? undefined : deps.search
  if (searchDisabled) {
    degraded.push(toDegraded('adviceSearch', 'UNAVAILABLE', '已停用（用户配置）'))
  }

  // ── T13：按已解析地点逐地归属天气（草稿 E）──
  let weather: AdviceWeatherEntry[]
  const placeDates = normalizePlaceDates(args.placeDates, degraded, now)
  const loadedPlaces = await loadResolvedPlaces(store, args.planId, degraded, now)
  if (loadedPlaces !== undefined && loadedPlaces.places.length > 0) {
    const perPlace: AdviceWeatherEntry[] = []
    for (const place of loadedPlaces.places) {
      const explicit = placeDates.get(place.placeId)
      const assigned = explicit !== undefined
      const placeDatesFor = assigned ? explicit : dates
      perPlace.push(...await assemblePlaceWeather(place, placeDatesFor, assigned, deps, degraded, search))
    }
    weather = perPlace
  } else if (isFullPlan) {
    // 完整 plan 无可用 weather 地点才 blocked。若只是部分候选待澄清/排除，
    // loadResolvedPlaces 已逐条 degraded，不能静默回退单城市，也不能把他地天气挪用过来。
    if (loadedPlaces === undefined) {
      degraded.push({
        source: 'advice/places', code: 'UNAVAILABLE',
        reason: '完整 plan 未解析出有效 places（缺/失败/为空/版本失配）：逐地归属天气无对象',
        at: now,
      })
    }
    const safeDegraded = degraded.map(redactDegradedEntry)
    for (const entry of safeDegraded) {
      await store.recordDegraded(args.planId, entry)
    }
    const candidateIds = loadedPlaces?.selectedCandidateIds ?? []
    const nextAction = candidateIds.length > 0
      ? `请先执行 travel_resolve_places 完成澄清/修复以下候选后重试 travel_research_advice：${candidateIds.map(redactSensitiveText).join(', ')}`
      : '请先执行 travel_resolve_places 完成地理解析（含入口点）后重试 travel_research_advice'
    return {
      planId: args.planId,
      weather: [], clothing: [], packingList: [], extraTips: [],
      degraded: safeDegraded,
      blocked: {
        reason: 'places_not_ready',
        nextAction,
      },
    }
  } else {
    // legacy 单目的地路径（无 places → 现状行为；交通失败不取消天气研究）。
    // 此处 destination 必非空：legacy 分支（!isFullPlan）在入口已对缺 destination 抛错。
    weather = await assembleWeather(destination!, dates, deps, degraded, search)
  }

  const avgTemp = avgTripTemp(weather)
  const clothing = clothingForTemp(avgTemp, weather, request)
  const packingList = buildPackingList(weather, request)
  // 目的地 tips 检索基于真实地理词（destination 或 researchIntent.text）；两者皆缺
  // （discovery 纯发现轮）不检索、不给编造的查询词（extraTips 留空诚实）。
  const tipsTopic = destination ?? request.slots.researchIntent?.text?.trim()
  const extraTips = tipsTopic !== undefined && search !== undefined
    ? await searchExtraTips(tipsTopic, search, degraded)
    : []

  const advice: Advice = redactAdvice({ weather, clothing, packingList, extraTips })

  // 契约闸门（validateAdvice）：失败丢弃并记账，不落脏数据
  const issues = validateAdvice(advice)
  if (issues.length > 0) {
    degraded.push({
      source: 'advice',
      code: 'UNAVAILABLE',
      reason: `advice 校验失败：${issues.map((i) => i.message).join('；')}`,
      at: now,
    })
  } else {
    const expectedVersions = isFullPlan
      ? {
          // research-state.researchVersion is the semantic evidence version used
          // above; the transaction guard must compare the version ledger value.
          // Legacy/fixture writers may have a state snapshot before accounting it.
          research: await store.currentVersion(args.planId, 'research'),
          places: await store.currentVersion(args.planId, 'places'),
        }
      : {}
    await store.publishArtifacts(args.planId, {
      stage: 'advice',
      files: [{ name: 'advice.json', data: advice }],
      expectedVersions,
      bump: ['advice'],
      inputFingerprint: `advice:${dateStart}:${dateEnd}`,
    })
  }
  const safeDegraded = degraded.map(redactDegradedEntry)
  for (const entry of safeDegraded) {
    await store.recordDegraded(args.planId, entry)
  }
  await store.saveRequest({ ...researchingRequest, status: 'researching', updatedAt: now })

  return { planId: args.planId, ...advice, degraded: safeDegraded }
}

/** placeDates 规范化：placeId → 合法日期列表（非法条目 degraded + 跳过）。 */
function normalizePlaceDates(
  raw: Array<{ placeId: string; dates: string[] }> | undefined,
  degraded: DegradedEntry[],
  now: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (raw === undefined) return out
  if (raw.length > ADVICE_PLACE_DATES_MAX) {
    degraded.push({
      source: 'advice/placeDates', code: 'UNAVAILABLE',
      reason: `placeDates 超过上限 ${ADVICE_PLACE_DATES_MAX}（超出部分忽略）`, at: now,
    })
  }
  for (const item of raw.slice(0, ADVICE_PLACE_DATES_MAX)) {
    if (typeof item?.placeId !== 'string' || item.placeId.trim() === '') {
      degraded.push({ source: 'advice/placeDates', code: 'UNAVAILABLE', reason: 'placeDates 条目缺 placeId，已跳过', at: now })
      continue
    }
    const dates = (item.dates ?? []).filter((d) => isDateString(d))
    if (dates.length === 0) {
      degraded.push({ source: 'advice/placeDates', code: 'UNAVAILABLE', reason: `place ${item.placeId} 无合法逐地日期，按旅行窗口查询并标注`, at: now })
      continue
    }
    out.set(item.placeId.trim(), [...new Set(dates)].sort())
  }
  return out
}

// ────────────────────────── 展示 ──────────────────────────

/** canonical 投影（对象字面量 + 展开，匹配 output schema；零强转）。 */
function projectAdvice(r: ResearchAdviceResult): AdviceOutput {
  return {
    planId: r.planId,
    weather: r.weather.map((w) => ({
      date: w.date,
      dayForecast: w.dayForecast,
      tempRange: w.tempRange,
      temperatureBasis: w.temperatureBasis,
      beyondForecastWindow: w.beyondForecastWindow,
      source: w.source,
      placeId: w.placeId,
      location: w.location,
      placeDateAssigned: w.placeDateAssigned,
    })),
    clothing: [...r.clothing],
    packingList: [...r.packingList],
    extraTips: [...r.extraTips],
    degraded: [...r.degraded],
    ...(r.blocked !== undefined
      ? { blocked: { reason: r.blocked.reason, nextAction: r.blocked.nextAction } }
      : {}),
  }
}

function renderAdvice(_args: AdviceParams, value: AdviceOutput): ContentBlock[] {
  if (value.blocked !== undefined) {
    const lines: [string, string][] = [
      ['planId', value.planId],
      ['blocked', value.blocked.reason],
      ['nextAction', value.blocked.nextAction],
    ]
    return textCard(`**travel_research_advice** · 门拦截（未落 advice.json）\n${cardLines(lines)}`)
  }
  const lines: [string, string][] = [
    ['planId', value.planId],
    ['天气天数', `${value.weather.length}（数据日期/来源见条目 source）`],
  ]
  // 按地点分组展示（T13：逐地归属可区分）
  const byPlace = new Map<string, AdviceOutput['weather']>()
  for (const w of value.weather) {
    const key = w.location ?? '(目的地)'
    const list = byPlace.get(key) ?? []
    list.push(w)
    byPlace.set(key, list)
  }
  const placeLines: string[] = []
  for (const [place, entries] of byPlace) {
    const assigned = entries[0]?.placeDateAssigned === true ? '' : entries[0]?.placeDateAssigned === false ? '【未分配逐地日期】' : ''
    const brief = entries.slice(0, 4).map((w) => {
      const temp = w.tempRange ? `${w.tempRange[0]}~${w.tempRange[1]}℃` : ''
      const flag = w.beyondForecastWindow ? '【气候概况】' : ''
      return `${w.date} ${w.dayForecast ?? ''} ${temp}${flag}`
    }).join('；')
    placeLines.push(`${place}${assigned}：${brief}`)
  }
  if (placeLines.length > 0) {
    lines.push(['逐地天气', placeLines.join('\n')])
  }
  if (value.clothing.length > 0) {
    lines.push(['穿衣建议', value.clothing.join('；')])
  }
  if (value.packingList.length > 0) {
    lines.push(['物品清单', `共 ${value.packingList.length} 项：${value.packingList.slice(0, 6).join('、')}…`])
  }
  if (value.degraded.length > 0) {
    lines.push(['降级记录', value.degraded.map((d) => `${d.source}[${d.code}]：${d.reason}`).join('；')])
  }
  const text = `**travel_research_advice** · 出行建议\n${cardLines(lines)}\n> 详情已写入 advice.json（对话内仅摘要）；天气条目含数据日期（source.fetchedAt）与来源（source.platform）`
  return textCard(text)
}

/** 工具定义工厂。 */
export function createTravelResearchAdviceTool(store: TravelStore, deps: ResearchAdviceDeps): ToolDefinition {
  return defineTool({
    name: 'travel_research_advice',
    description: '出行建议（天气链 高德→腾讯→Open-Meteo 逐链降级；超预报窗口标注气候概况；穿衣/物品结合人数画像≥10 项；extraTips 由 L0 搜索合成）。推荐顺序：研究→advice→build→render；若已 build 再补 advice，走 generating→revising→researching 恢复回路，随后需重新 build→render（未改输入的日程内容原样保留）。W3 T13：读取 places 已解析地点逐地归属天气（placeId/location），有逐地日期查对应日、无则旅行窗口+显式标注「未分配逐地日期」（不以西宁代表整条环线）；交通失败/渠道不可用不取消可用天气研究；Open-Meteo 窗口修复保持 OUT。详情落盘 advice.json，对话内只回摘要卡片。',
    parameters: ADVICE_PARAMETERS,
    output: {
      schema: ADVICE_OUTPUT_SCHEMA,
      render: renderAdvice,
    },
    timeoutMs: deps.timeoutMs ?? ADVICE_TIMEOUT_MS,
    presentCall() {
      return { card: 'generic', title: '正在检索出行建议（天气/穿衣/物品）', kind: 'search' }
    },
    async execute(args) {
      // P0-A R6：工具执行入口恰一次重置规划预算（amap 配额不跨链累积）。
      if (deps.resetPlanBudget !== undefined) deps.resetPlanBudget()
      const result = await runResearchAdvice({
        planId: args.planId,
        placeDates: args.placeDates as Array<{ placeId: string; dates: string[] }> | undefined,
      }, store, deps)
      // lossless-JSON 边界闸门：气候概况条目 tempRange 可能缺位（undefined）
      return losslessJson(projectAdvice(result))
    },
  })
}