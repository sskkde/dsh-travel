/**
 * Open-Meteo 适配器（W3 新增；FR-5 天气链渠道三，design §6 行 521）。
 *
 * 免 key（api.open-meteo.com），每日预报窗口最长 16 天：
 * - 需要目的地经纬度（GCJ-02 即可，偏差 <100m 对预报无意义；由调用方坐标解析提供）
 * - 超预报窗口（行程日期在未来 16 天外）→ 调用方以 beyondForecastWindow 标注 + 气候概况
 * - 归一化：date YYYY-MM-DD / tempRange [min,max]（摄氏）/ weathercode → 中文 dayForecast
 *
 * 零 key 通道（CAP_ZERO_KEY）；可用性只受编排层渠道开关约束
 * （channelEnabled('weatherOpenMeteo', env)，ADR-12）。
 */
import { BaseAdapter, CAP_ZERO_KEY, toDegraded, type DegradedEntry, type KeyResolutionEnv } from './base.js'
import type { AdviceWeatherEntry } from '../models/types.js'

export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
export const OPEN_METEO_FORECAST_DAYS = 16

/** weathercode（WMO）→ 中文天气描述（M1 精简映射；未知码回退「多变」）。 */
const WEATHERCODE_TEXT: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴伴冰雹',
}

export function weatherCodeText(code: number): string {
  return WEATHERCODE_TEXT[code] ?? '多变'
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export interface OpenMeteoDailyResult {
  entries: AdviceWeatherEntry[]
  degraded: DegradedEntry[]
}

export interface OpenMeteoOptions {
  /** 注入 fetch（单测/离线 fixture；缺省全局 fetch）。 */
  fetchFn?: (input: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
}

export class OpenMeteoAdapter extends BaseAdapter {
  private readonly fetchFn: (input: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  private readonly timeoutMs: number

  constructor(opts: OpenMeteoOptions = {}) {
    super('open-meteo', { supports: new Set([CAP_ZERO_KEY]) })
    this.fetchFn = opts.fetchFn ?? (async (input: string) => {
      const res = await fetch(input)
      return { ok: res.ok, status: res.status, text: async () => await res.text() }
    })
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  override async available(_env?: KeyResolutionEnv): Promise<boolean> {
    return true // 免 key；开关由编排层过滤
  }

  /**
   * 逐日预报（16 天窗口）。
   * @param lat/lng - 目的地坐标（GCJ-02 / WGS-84 均可，预报精度无差异）。
   * @param startDate/endDate - YYYY-MM-DD（请求窗口；实际请求会夹取到 today..today+15 的交集；
   *   完全在窗口外时不发起请求，由 advice 层降级为 beyondForecastWindow 的气候概况）。
   */
  async dailyForecast(
    lat: number,
    lng: number,
    startDate: string,
    endDate: string,
    env?: KeyResolutionEnv,
  ): Promise<OpenMeteoDailyResult> {
    const degraded: DegradedEntry[] = []
    // P2-B：Open-Meteo 只接受 today..today+15 的有效交集；使用真实 UTC 日期
    // 计算，完全在窗口外时不发送 start>end 请求，让调用方走既有 climate/beyond 分支。
    const today = new Date().toISOString().slice(0, 10)
    const latestForecastDate = addUtcDays(today, OPEN_METEO_FORECAST_DAYS - 1)
    const effectiveStart = startDate > today ? startDate : today
    const effectiveEnd = endDate < latestForecastDate ? endDate : latestForecastDate
    if (effectiveStart > effectiveEnd) {
      degraded.push(toDegraded(this.name, 'EMPTY', `请求日期 ${startDate}~${endDate} 在 Open-Meteo 预报窗口外（${today}~${latestForecastDate}）`))
      return { entries: [], degraded }
    }
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      daily: 'temperature_2m_max,temperature_2m_min,weathercode',
      start_date: effectiveStart,
      end_date: effectiveEnd,
      timezone: 'Asia/Shanghai',
    })
    const url = `${OPEN_METEO_ENDPOINT}?${params.toString()}`
    try {
      const { ok, status, text } = await this.withTimeout(this.fetchFn(url))
      if (!ok || status >= 400) {
        throw new Error(`Open-Meteo HTTP ${status}`)
      }
      const raw = JSON.parse(await text()) as Record<string, unknown>
      const daily = (raw.daily ?? {}) as Record<string, unknown>
      const dates = (daily.time ?? []) as string[]
      const maxTemps = (daily.temperature_2m_max ?? []) as number[]
      const minTemps = (daily.temperature_2m_min ?? []) as number[]
      const codes = (daily.weathercode ?? []) as number[]
      const entries: AdviceWeatherEntry[] = dates.map((date, i) => {
        const min = Number(minTemps[i])
        const max = Number(maxTemps[i])
        const tempRange: [number, number] | undefined =
          Number.isFinite(min) && Number.isFinite(max) ? [min, max] : undefined
        const code = Number(codes[i])
        return {
          date,
          dayForecast: Number.isFinite(code) ? weatherCodeText(code) : undefined,
          tempRange,
          source: {
            platform: 'open-meteo',
            url: OPEN_METEO_ENDPOINT,
            fetchedAt: new Date().toISOString(),
          },
        }
      })
      if (entries.length === 0) {
        degraded.push(toDegraded(this.name, 'EMPTY', '预报窗口内无数据（超出 16 天窗口）'))
      }
      void env
      return { entries, degraded }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      degraded.push(toDegraded(this.name, 'UNAVAILABLE', `Open-Meteo 请求失败：${message}`))
      return { entries: [], degraded }
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Open-Meteo 超时（${this.timeoutMs}ms）`)), this.timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}