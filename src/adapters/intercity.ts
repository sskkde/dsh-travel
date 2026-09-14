/**
 * intercity 适配器（W2b → M2.3/W4 完整版）：城际三档降级链（design §5.4 行 385-395 + §2.1 FR-4 行 50）。
 *
 * 机票三档：wendao（P0 实测源，模板拼接 `查询{date}{origin}到{destination}的机票`）
 * → flyai（零 key 试用，@fly-ai/flyai-cli，flag 映射+枚举翻译）
 * → L0 搜索结构化（标签「搜索降级」）→ 三档全空 → **明示人工比价 + 官方渠道链接**。
 * 火车互备（M2.3 接通）：12306 不可用 → searchTrains（wendao 火车票模板 → flyai
 * search-train → L0 搜索结构化），rail12306.backupSources() 声明位由此兑现。
 * 汽车票：wendao 咨询级（车站/票价区间/车程，无实时班次，P1）→ L0 搜索结构化。
 * wendao/flyai 位以接口（WendaoLike/FlyaiLike）注入；搜索位以 SearchLike 注入
 * （W2a 波 search.ts / index.ts ctx.web seam），未注入则该段如实降级记账。
 * 全部输出 §5.5 TransportOption 规范形；金额统一元、时长统一分钟。
 */
import { BaseAdapter, EngineError, toDegraded, channelEnabled, isKeyConfigured, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import type { TransportOption } from '../models/types.js'
import { WendaoAdapter, buildWendaoQuery, WENDAO_KEY, type WendaoEntry, type WendaoResult, type WendaoTicketMode } from './wendao.js'
import type { SearchHit } from './social.js'

// ────────────────────────── 互备/降级链位（接口） ──────────────────────────

/** wendao 位（wendao.ts 实现；M2.3 可换实现）。 */
export interface WendaoLike {
  readonly name: string
  available(env?: KeyResolutionEnv): Promise<boolean>
  query(text: string, env?: KeyResolutionEnv): Promise<WendaoResult>
}

/** flyai 位（M2.3 填充：零 key 试用，train/flight 查询；seatClass 中文枚举经翻译表转 flag）。 */
export interface FlyaiLike {
  readonly name: string
  available(env?: KeyResolutionEnv): Promise<boolean>
  queryFlights(params: { from: string; to: string; date: string; seatClass?: string }, env?: KeyResolutionEnv): Promise<TransportOption[]>
  queryTrains(params: { from: string; to: string; date: string; seatClass?: string }, env?: KeyResolutionEnv): Promise<TransportOption[]>
}

/** 搜索位（W2a search.ts 提供；L0 结构化兜底）。 */
export interface SearchLike {
  readonly name: string
  search(query: string): Promise<SearchHit[]>
}

// ────────────────────────── 纯解析函数（可单测） ──────────────────────────

/** 三档全空时的官方购票渠道明示（§2.1 FR-4：人工比价 + 官方渠道链接）。 */
export const OFFICIAL_BOOKING_LINKS: Record<'flight' | 'rail' | 'bus', string> = {
  flight: '携程 https://www.ctrip.com · 飞猪 https://www.fliggy.com · 各航司官网',
  rail: '12306 官方 https://www.12306.cn（唯一官方售票渠道）',
  bus: '当地客运站官网/窗口 · 携程汽车票 https://m.ctrip.com/webapp/bus',
}

const FLIGHT_NO = /[A-Z]{2}\d{3,4}/
/** 列车车次（高/动/城际/直达/快/特快 + 数字）。 */
const TRAIN_NO = /([GCDZKT])\d{1,4}/
const TIME = /\b(\d{1,2}:\d{2})\b/g
const PRICE_YUAN = /[¥￥]\s*(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*元\b/
const BUS_ROUTE = /([\u4e00-\u9fa5]{2,14}(?:客运中心|汽车站|客运站|站))\s*[-—到→]\s*([\u4e00-\u9fa5]{2,14}(?:客运中心|汽车站|客运站|站))/

/** 起讫城市注入（parseFlights/parseTrains 共用；section 占位劣后）。 */
interface OptionLegs {
  from?: string
  to?: string
}

/** 火车 markdown（wendao 实测口径：车次/时刻/价格）→ TransportOption[]（互备链段）。 */
export function parseTrainsFromMarkdown(entries: WendaoEntry[], legs?: OptionLegs): TransportOption[] {
  const seen = new Set<string>()
  const options: TransportOption[] = []
  for (const entry of entries) {
    const text = `${entry.title} ${entry.summary}`
    const no = text.match(TRAIN_NO)?.[0]
    const times = [...text.matchAll(TIME)].map((m) => m[1])
    const price = text.match(PRICE_YUAN)
    if (!no && !times.length && !price) continue
    const value = price ? Number(price[1] ?? price[2]) : undefined
    const key = `${no ?? '?'}/${times[0] ?? ''}/${value ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      mode: 'rail',
      segments: [{
        no,
        from: legs?.from ?? entry.section ?? '城市',
        to: legs?.to ?? '城市',
        depart: times[0],
        arrive: times[1],
        priceRange: value !== undefined ? [value, value] : undefined,
      }],
      totalPriceRange: value !== undefined ? [value, value] : undefined,
      ...(value !== undefined ? { currency: 'CNY' } : {}),
      durationMinutes: durationFromTimes(times[0], times[1]),
      tags: ['wendao 咨询（互备段，非 12306 实时班次）'],
      bookingTips: ['班次/余票以 12306 官方为准（www.12306.cn）'],
      source: {
        platform: 'wendao',
        url: entry.deepLinks[0] ?? 'm.ctrip.com 深链未提取',
        fetchedAt: new Date().toISOString(),
      },
    })
  }
  return options
}

/** 机票 markdown → TransportOption[]（wendao 实测口径：航司/航班号/时刻/价格）。 */
export function parseFlightsFromMarkdown(entries: WendaoEntry[], legs?: OptionLegs): TransportOption[] {
  const seen = new Set<string>()
  const options: TransportOption[] = []
  for (const entry of entries) {
    const text = `${entry.title} ${entry.summary}`
    // 航班号两段提取：正文文本优先（旧形态编号行自带）；正文缺失时从深链
    // URL 参数兜底（v2 形态 dfltno 在 `##### [航司](<m.ctrip.com ...dfltno=>)` 内）。
    const no = text.match(FLIGHT_NO)?.[0]
      ?? entry.deepLinks
        .map((u) => /[?&](?:dfltno|flightNo)=([A-Z]{2}\d{3,4})/.exec(u)?.[1])
        .find((v): v is string => v !== undefined)
    const times = [...text.matchAll(TIME)].map((m) => m[1])
    const price = text.match(PRICE_YUAN)
    if (!no && !times.length && !price) continue
    const value = price ? Number(price[1] ?? price[2]) : undefined
    const key = `${no ?? '?'}/${times[0] ?? ''}/${value ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      mode: 'flight',
      segments: [{
        no,
        from: legs?.from ?? entry.section ?? '城市',
        to: legs?.to ?? '城市',
        depart: times[0],
        arrive: times[1],
        priceRange: value !== undefined ? [value, value] : undefined,
      }],
      totalPriceRange: value !== undefined ? [value, value] : undefined,
      ...(value !== undefined ? { currency: 'CNY' } : {}),
      durationMinutes: durationFromTimes(times[0], times[1]),
      tags: ['wendao 实测源'],
      source: {
        platform: 'wendao',
        url: entry.deepLinks[0] ?? 'm.ctrip.com 深链未提取',
        fetchedAt: new Date().toISOString(),
      },
    })
  }
  return options
}

/** 跨天/同日时刻 → 时长（分钟）；不可解析返回 undefined。 */
export function durationFromTimes(depart?: string, arrive?: string): number | undefined {
  if (!depart || !arrive) return undefined
  const d = depart.split(':').map(Number)
  const a = arrive.split(':').map(Number)
  if (d.length !== 2 || a.length !== 2 || d.some(Number.isNaN) || a.some(Number.isNaN)) return undefined
  let diff = (a[0] * 60 + a[1]) - (d[0] * 60 + d[1])
  if (diff < 0) diff += 24 * 60
  return diff
}

/** 汽车票 markdown（咨询级：车站/票价区间/车程）→ TransportOption[]。 */
export function parseBusesFromMarkdown(entries: WendaoEntry[]): TransportOption[] {
  const options: TransportOption[] = []
  for (const entry of entries) {
    const text = `${entry.title} ${entry.summary}`
    const route = text.match(BUS_ROUTE)
    if (!route && !text.includes('汽车')) continue
    const price = text.match(PRICE_YUAN)
    const value = price ? Number(price[1] ?? price[2]) : undefined
    options.push({
      mode: 'bus',
      segments: [{
        from: route?.[1] ?? '车站',
        to: route?.[2] ?? '车站',
        priceRange: value !== undefined ? [value, value] : undefined,
      }],
      tags: ['wendao 咨询级（P1：无实时班次）'],
      source: {
        platform: 'wendao',
        url: entry.deepLinks[0] ?? 'm.ctrip.com 深链未提取',
        fetchedAt: new Date().toISOString(),
      },
    })
  }
  return options
}

/** L0 搜索命中 → 结构化 TransportOption（降级段；尽力解析，未解析字段留空）。 */
export function optionsFromHits(hits: SearchHit[], mode: 'flight' | 'rail' | 'bus', from: string, to: string): TransportOption[] {
  const seen = new Set<string>()
  const options: TransportOption[] = []
  for (const hit of hits) {
    const text = `${hit.title} ${hit.snippet ?? ''}`
    const no = mode === 'flight' ? text.match(FLIGHT_NO)?.[0] : mode === 'rail' ? text.match(TRAIN_NO)?.[0] : undefined
    const times = [...text.matchAll(TIME)].map((m) => m[1])
    const price = text.match(PRICE_YUAN)
    const value = price ? Number(price[1] ?? price[2]) : undefined
    if (!no && !times.length && !value) continue
    const key = `${no ?? ''}/${times[0] ?? ''}/${from}${to}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      mode,
      segments: [{
        from,
        to,
        no,
        depart: times[0],
        arrive: times[1],
        priceRange: value !== undefined ? [value, value] : undefined,
      }],
      totalPriceRange: value !== undefined ? [value, value] : undefined,
      ...(value !== undefined ? { currency: 'CNY' } : {}),
      durationMinutes: mode === 'bus' ? undefined : durationFromTimes(times[0], times[1]),
      tags: ['搜索降级（L0）', '非官方实时价'],
      bookingTips: [`班次/票价以官方渠道为准（${mode === 'flight' ? '航司' : mode === 'rail' ? OFFICIAL_BOOKING_LINKS.rail : '客运站'}）`],
      source: { platform: 'web', url: hit.url, fetchedAt: new Date().toISOString() },
    })
  }
  return options
}

// ────────────────────────── 适配器 ──────────────────────────

export interface IntercityOptions {
  /** wendao 位（缺省真实 WendaoAdapter；M2.3 可替换）。 */
  wendao?: WendaoLike
  /** flyai 位（M2.3 填充；缺省未接入）。 */
  flyai?: FlyaiLike
  /** 搜索位（W2a search.ts 提供；缺省未注入）。 */
  search?: SearchLike
}

export interface IntercityOutcome {
  options: TransportOption[]
  degraded: DegradedEntry[]
}

export class IntercityAdapter extends BaseAdapter {
  private readonly wendao: WendaoLike | undefined
  private readonly flyai: FlyaiLike | undefined
  private readonly search: SearchLike | undefined

  constructor(opts: IntercityOptions = {}) {
    super('intercity')
    this.wendao = opts.wendao ?? new WendaoAdapter()
    // flyai 位 M2.3 填充：装配 IntercityAdapter({ flyai }) 即接通（index.ts 注入真实
    // FlyaiAdapter；测试注入 stub/关位）。不默认实例化——二进制探测会触发真实 CLI
    // 探测（工作区 node_modules 就位时可用性=true），单测须保持离线可注入语义。
    this.flyai = opts.flyai
    this.search = opts.search
  }

  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    // 降级链零 key 也可跑（搜索位兜底）；可用性只受渠道开关约束
    return channelEnabled('intercity', env)
  }

  /** 机票三档：wendao → flyai → L0 搜索结构化（M2.3 全接通）。 */
  async searchFlights(params: { from: string; to: string; date: string }, env?: KeyResolutionEnv): Promise<IntercityOutcome> {
    return this.chain('flight', params, env)
  }

  /** 火车互备链（12306 不可用）：wendao → flyai → L0 搜索结构化（M2.3 接通）。 */
  async searchTrains(params: { from: string; to: string; date: string }, env?: KeyResolutionEnv): Promise<IntercityOutcome> {
    return this.chain('rail', params, env)
  }

  /** 汽车票（咨询级）：wendao → L0 搜索结构化。 */
  async searchBuses(params: { from: string; to: string; date: string }, env?: KeyResolutionEnv): Promise<IntercityOutcome> {
    return this.chain('bus', params, env)
  }

  private async chain(
    mode: 'flight' | 'rail' | 'bus',
    params: { from: string; to: string; date: string },
    env?: KeyResolutionEnv,
  ): Promise<IntercityOutcome> {
    const outcome: IntercityOutcome = { options: [], degraded: [] }
    const trySource = async (label: string, fn: () => Promise<TransportOption[]>): Promise<boolean> => {
      try {
        const got = await fn()
        if (got.length) {
          outcome.options.push(...got)
          return true
        }
        outcome.degraded.push(toDegraded(label, 'EMPTY', '源返回空（无结构化结果）'))
      } catch (err) {
        if (err instanceof EngineError) outcome.degraded.push(toDegraded(label, err))
        else outcome.degraded.push(toDegraded(label, 'UNAVAILABLE', err instanceof Error ? err.message : String(err)))
      }
      return false
    }

    // 1. wendao（P0 实测源；design §5.1 行 268 模板拼接）
    // available() 是 channel + Key 的合取；单独保留两个判定，避免把「用户关闭」
    // 与「Key 未配置」折叠成同一条 degraded。intercity 与 wendao 是同一 FR-4
    // 宽门的两个历史别名，任一显式关闭都按用户停用处理。
    const wendaoChannelOn = channelEnabled('wendao', env) && channelEnabled('intercity', env)
    const wendaoReady = this.wendao && (await this.wendao.available(env))
    if (wendaoReady && this.wendao) {
      const ticketMode: WendaoTicketMode = mode === 'flight' ? 'flight' : mode === 'rail' ? 'rail' : 'bus'
      const text = buildWendaoQuery(ticketMode, params.from, params.to, params.date)
      const hit = await trySource(`${this.name}/wendao`, async () => {
        const result: WendaoResult = await this.wendao!.query(text, env)
        return mode === 'flight'
          ? parseFlightsFromMarkdown(result.entries, { from: params.from, to: params.to })
          : mode === 'rail'
            ? parseTrainsFromMarkdown(result.entries, { from: params.from, to: params.to })
            : parseBusesFromMarkdown(result.entries)
      })
      if (hit) return outcome
    } else if (this.wendao && !wendaoReady) {
      if (!wendaoChannelOn) {
        outcome.degraded.push(toDegraded(`${this.name}/wendao`, 'UNAVAILABLE', '已停用（用户配置）'))
      } else if (!(await isKeyConfigured(WENDAO_KEY, env))) {
        outcome.degraded.push(toDegraded(`${this.name}/wendao`, 'UNAVAILABLE', 'Key 未配置（休眠）'))
      } else {
        // 开关与凭据均满足但适配器仍未就绪：保留真实第三成因，不伪造缺 Key。
        outcome.degraded.push(toDegraded(`${this.name}/wendao`, 'UNAVAILABLE', 'wendao 位不可用（适配器未就绪）'))
      }
    }

    // 2. flyai（M2.3 接通：零 key 试用档；flight/rail 双命令，bus 不适用）
    if (mode !== 'bus') {
      if (this.flyai && (await this.flyai.available(env))) {
        const hit = await trySource(`${this.name}/flyai`, async () =>
          mode === 'flight'
            ? this.flyai!.queryFlights(params, env)
            : this.flyai!.queryTrains(params, env))
        if (hit) return outcome
      } else {
        outcome.degraded.push(toDegraded(`${this.name}/flyai`, 'EMPTY', `flyai 位未就位（M2.3 通道未装配/二进制缺失，${mode} 段跳过）`))
      }
    }

    // 3. L0 搜索结构化（搜索位；W2a 波/index.ts ctx.web seam 注入后即生效）
    if (this.search) {
      const hit = await trySource(`${this.name}/search`, async () => {
        const keyword = `${params.date} ${params.from}到${params.to} ${mode === 'flight' ? '机票 航班' : mode === 'rail' ? '火车票 车次 时刻' : '汽车票 客运站'}`
        const hits = await this.search!.search(keyword)
        return optionsFromHits(hits, mode, params.from, params.to)
      })
      if (hit) return outcome
    } else {
      outcome.degraded.push(toDegraded(`${this.name}/search`, 'UNAVAILABLE', '搜索位未注入（W2a 波 search.ts 提供后生效）'))
    }

    // 三档全空 → 明示人工比价 + 官方购票渠道链接（§2.1 FR-4：城际行全链不中断的最后出口）
    if (outcome.options.length === 0) {
      outcome.degraded.push(toDegraded(
        `${this.name}/manual`,
        'EMPTY',
        `三档均未产出方案：请人工比价（官方渠道：${OFFICIAL_BOOKING_LINKS[mode]}）`,
      ))
    }
    return outcome
  }
}