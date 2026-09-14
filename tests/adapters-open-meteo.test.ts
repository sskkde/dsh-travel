import { describe, expect, it } from 'vitest'
import { OpenMeteoAdapter } from '../src/adapters/open-meteo.js'

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

describe('T19：Open-Meteo 预报窗口 clamp', () => {
  it('请求窗口 clamp 到 [today, today+15]，不把越界请求发成 400', async () => {
    const urls: string[] = []
    const adapter = new OpenMeteoAdapter({
      fetchFn: async (url) => {
        urls.push(url)
        const parsed = new URL(url)
        const start = parsed.searchParams.get('start_date')!
        const end = parsed.searchParams.get('end_date')!
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            daily: {
              time: [start, end],
              temperature_2m_max: [20, 21],
              temperature_2m_min: [10, 11],
              weathercode: [0, 1],
            },
          }),
        }
      },
    })
    const today = todayUtc()
    const result = await adapter.dailyForecast(36.6, 101.8, addDays(today, -4), addDays(today, 30))
    expect(result.entries).toHaveLength(2)
    const request = new URL(urls[0]!)
    expect(request.searchParams.get('start_date')).toBe(today)
    expect(request.searchParams.get('end_date')).toBe(addDays(today, 15))
  })

  it('完全在窗口外时不发 start>end 请求，返回可降级空结果而非整单异常', async () => {
    let calls = 0
    const adapter = new OpenMeteoAdapter({
      fetchFn: async () => {
        calls += 1
        throw new Error('不应触网')
      },
    })
    const today = todayUtc()
    const result = await adapter.dailyForecast(36.6, 101.8, addDays(today, 20), addDays(today, 30))
    expect(calls).toBe(0)
    expect(result.entries).toEqual([])
    expect(result.degraded).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EMPTY', reason: expect.stringContaining('预报窗口') }),
    ]))
  })
})
