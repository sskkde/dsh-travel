/**
 * amap 适配器单测：REST 四件套归一化 + Key 门控 + 配额熔断 + 30 天缓存 + 预算。
 * fixture = 高德 v3 官方结构样例（tests/fixtures/amap/，_provenance 标注；
 * error.json = 2026-09-02 无 key 真实错误信封录制）。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  AmapAdapter, AMAP_API_BASE, QuotaCounter, TtlCache, cacheKey, isCoordinateString,
  normalizeDistanceMatrix, normalizeGeocode, normalizeTransitRoute,
  normalizeWeatherCasts, toCityTransferOptions,
} from '../src/adapters/amap.js'
import { EngineError } from '../src/adapters/base.js'
import { liveCredentialsEnv } from './live-credentials.js'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'amap')
function fixture(name: string): { request: Record<string, string>; response: Record<string, unknown> } {
  return JSON.parse(readFileSync(path.join(FIX, name), 'utf8'))
}

/** 离线 stub fetch：按 URL 端点回放 fixture（无任何网络）。 */
function stubFetch(): { fetchFn: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>; urls: string[] } {
  const files: Record<string, { request: Record<string, string>; response: Record<string, unknown> }> = {
    'direction/transit/integrated': fixture('transit.json'),
    'weather/weatherInfo': fixture('weather.json'),
    'geocode/geo': fixture('geocode.json'),
    distance: fixture('distance.json'),
    'place/text': fixture('poi.json'),
  }
  const urls: string[] = []
  return {
    urls,
    fetchFn: async (url) => {
      urls.push(url.replace(/key=[^&]*/, 'key=<MASK>')) // 录制 URL 时清洗 key（零明文）
      const hit = Object.entries(files).find(([ep]) => url.includes(ep))
      if (!hit) throw new Error(`no fixture for ${url}`)
      return { ok: true, status: 200, text: async () => JSON.stringify(hit[1].response) }
    },
  }
}

const ENV_KEY = { env: { amapWebservice: 'test-key' } }

describe('配额计数器（熔断核心）', () => {
  it('POI/rest 计数 + 月度累计', () => {
    const q = new QuotaCounter({ monthlyLimit: 10, poiLimit: 2, restLimit: 3 })
    expect(q.acquire('poi')).toEqual({ ok: true })
    expect(q.acquire('poi')).toEqual({ ok: true })
    const denied = q.acquire('poi')
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain(' POI 预算 2 次已用尽')
    expect(denied.reason).toContain('停新增')
    expect(q.snapshot().alarms.some((a) => a.includes('停新增'))).toBe(true) // 告警
    expect(q.snapshot().planPoiUsed).toBe(2)
    expect(q.snapshot().monthlyUsed).toBe(2)
  })

  it('月度配额熔断（5000/月口径收敛服务端）', () => {
    const q = new QuotaCounter({ monthlyLimit: 2, restLimit: 10 })
    q.acquire('rest')
    q.acquire('rest')
    const denied = q.acquire('rest')
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('月度 2 次已用尽')
    expect(q.snapshot().alarms.some((a) => a.includes('月度'))).toBe(true)
  })

  it('月初滚动：月份变更后月度计数归零（注入时钟）', () => {
    let now = new Date('2026-09-15T00:00:00Z')
    const q = new QuotaCounter({ monthlyLimit: 1, now: () => now })
    q.acquire('rest')
    expect(q.snapshot().monthlyUsed).toBe(1)
    now = new Date('2026-10-01T00:00:00Z')
    expect(q.snapshot().month).toBe('2026-10')
    expect(q.acquire('rest').ok).toBe(true)
    expect(q.snapshot().monthlyUsed).toBe(1)
  })

  it('单次规划预算 reset（编排者/W3 每次 research 开始调用）', () => {
    const q = new QuotaCounter({ poiLimit: 1, restLimit: 1 })
    q.acquire('poi')
    expect(q.acquire('poi').ok).toBe(false)
    q.resetPlanBudget()
    expect(q.acquire('poi').ok).toBe(true)
    // 月度计数不因 reset 归零
    expect(q.snapshot().monthlyUsed).toBe(2)
  })
})

describe('TTL 缓存 + key 零明文缓存键', () => {
  it('缓存键剔除 key 参数（无明文），不同 key 同参数 → 同键', () => {
    expect(cacheKey('geocode/geo', { address: '北京', key: 'SECRET' })).toBe(
      cacheKey('geocode/geo', { address: '北京', key: 'OTHER' }),
    )
    expect(cacheKey('geocode/geo', { address: '北京', key: 'SECRET' })).not.toContain('SECRET')
  })

  it('TTL 内命中、过期失效', async () => {
    const cache = new TtlCache(20)
    cache.set('k', { ok: 1 })
    expect(cache.get('k')).toEqual({ ok: 1 })
    await new Promise((r) => setTimeout(r, 60))
    expect(cache.get('k')).toBeUndefined()
    expect(cache.size()).toBe(0)
  })

  it('同端点同参数 → 仅一次网络调用（缓存命中，30 天口径）', async () => {
    const { fetchFn, urls } = stubFetch()
    const adapter = new AmapAdapter({ fetchFn })
    await adapter.geocode('杭州市西湖区龙井路', '330100', ENV_KEY)
    await adapter.geocode('杭州市西湖区龙井路', '330100', ENV_KEY)
    expect(urls.length).toBe(1)
  })

  it('M2 遗留修复：rest() 短 TTL 生效——weather/direction 30 分钟过期重取，POI 仍旧 30 天（CLOSURE ④）', async () => {
    vi.useFakeTimers()
    try {
      const { fetchFn, urls } = stubFetch()
      const adapter = new AmapAdapter({ fetchFn })
      const weatherUrls = () => urls.filter((u) => u.includes('weather/weatherInfo'))
      const transitUrls = () => urls.filter((u) => u.includes('direction/transit/integrated'))
      const poiUrls = () => urls.filter((u) => u.includes('place/text'))

      // weather / directionTransit：同参数二次调用命中缓存（短 TTL 内）
      await adapter.weather('330100', ENV_KEY)
      await adapter.weather('330100', ENV_KEY)
      expect(weatherUrls()).toHaveLength(1)
      await adapter.directionTransit('116.301934,39.976928', '116.460395,39.911305', { city: '110000', cityd: '110000' }, ENV_KEY)
      await adapter.directionTransit('116.301934,39.976928', '116.460395,39.911305', { city: '110000', cityd: '110000' }, ENV_KEY)
      expect(transitUrls()).toHaveLength(1)

      // 短 TTL（30 分钟）过期 → 重新取数（不再与 POI 共享 30 天 TtlCache）
      vi.advanceTimersByTime(30 * 60 * 1000 + 1000)
      await adapter.weather('330100', ENV_KEY)
      await adapter.directionTransit('116.301934,39.976928', '116.460395,39.911305', { city: '110000', cityd: '110000' }, ENV_KEY)
      expect(weatherUrls()).toHaveLength(2)
      expect(transitUrls()).toHaveLength(2)

      // POI：写入晚于第一条 weather（t0+30m+1s），短 TTL 过期判定时刻（相对 POI 仅 1min）仍命中
      await adapter.poiSearch('西湖', '330100', {}, ENV_KEY)
      expect(poiUrls()).toHaveLength(1)
      vi.advanceTimersByTime(60 * 1000)
      await adapter.poiSearch('西湖', '330100', {}, ENV_KEY)
      expect(poiUrls()).toHaveLength(1) // 30 天口径：短 TTL 阈值处不失效

      // 30 天后 POI 才过期（确认 long TTL 逐条生效）
      vi.advanceTimersByTime(29 * 24 * 3600 * 1000)
      await adapter.poiSearch('西湖', '330100', {}, ENV_KEY)
      expect(poiUrls()).toHaveLength(1)
      vi.advanceTimersByTime(24 * 3600 * 1000)
      await adapter.poiSearch('西湖', '330100', {}, ENV_KEY)
      expect(poiUrls()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('归一化纯函数（§5.1 项 3 / §5.5）', () => {
  it('direction transit（真实录制）：cost 元直落、时长秒→分钟、walking 米、段（walking/bus）', () => {
    const route = normalizeTransitRoute((fixture('transit.json').response.route as Record<string, unknown>).transits[0] as Record<string, unknown>)
    expect(route.cost).toBe(4)
    expect(route.durationMinutes).toBe(49) // 真实录制 2913s → 49min
    expect(route.walkingDistance).toBe(1946)
    const modes = route.segments.map((s) => s.mode)
    expect(modes).toContain('walking')
    expect(modes).toContain('bus')
    // 实测：v3 地铁线出现在 bus.buslines（名称含「地铁」），无独立 metro 段
    const bus = route.segments.filter((s) => s.mode === 'bus')
    expect(bus.length).toBeGreaterThanOrEqual(2)
    expect(bus[0].line).toContain('地铁1号线')
  })

  it('toCityTransferOptions：§5.5 CityTransferOption（时长分钟 + 价格 hint）', () => {
    const route = normalizeTransitRoute((fixture('transit.json').response.route as Record<string, unknown>).transits[0] as Record<string, unknown>)
    const options = toCityTransferOptions([route])
    expect(options[0].durationMinutes).toBe(49)
    expect(options[0].priceHint).toBe('4 元')
    expect(options[0].mode).toContain('地铁')
  })

  it('weather casts → AdviceWeatherEntry（day/night 合并 + 温度区间）', () => {
    const forecasts = fixture('weather.json').response.forecasts as Array<Record<string, unknown>>
    const entries = normalizeWeatherCasts(forecasts[0].casts)
    expect(entries.length).toBe(4) // 真实录制 4 日预报
    expect(entries[0]).toMatchObject({ date: '2026-09-03', dayForecast: '小雨 转 小雨', tempRange: [23, 30] })
    expect(entries[0].source.platform).toBe('amap-weather')
  })

  it('geocoder → GCJ-02（高德原生坐标系直落）', () => {
    const geocodes = fixture('geocode.json').response.geocodes
    expect(normalizeGeocode(geocodes)).toEqual({ lng: 116.482086, lat: 39.990496, sys: 'GCJ02' }) // 真实录制
  })

  it('distance_matrix：米 + 秒→分钟', () => {
    const pairs = normalizeDistanceMatrix(fixture('distance.json').response.results)
    expect(pairs[0].distanceMeters).toBe(175316)
    expect(pairs[0].durationMinutes).toBe(147) // 8832s → 147min
  })
})

describe('amap Key 门控 + 渠道开关（fan-out 前置过滤）', () => {
  it('无 key → available()=false；env 有 key → true；渠道关闭 → false', async () => {
    const adapter = new AmapAdapter({ fetchFn: stubFetch().fetchFn })
    await expect(adapter.available()).resolves.toBe(false) // degraded「Key 未配置」路径
    await expect(adapter.available(ENV_KEY)).resolves.toBe(true)
    await expect(adapter.available({ env: { amapWebservice: 'k', TRAVEL_CHANNEL_AMAP: 'off' } })).resolves.toBe(false)
  })

  it('无 key 调用 → EngineError.UNAVAILABLE「Key 未配置」（零网络）', async () => {
    const { fetchFn, urls } = stubFetch()
    const adapter = new AmapAdapter({ fetchFn })
    await expect(adapter.geocode('北京')).rejects.toMatchObject({ code: 'UNAVAILABLE', source: 'amap' })
    expect(urls.length).toBe(0)
  })

  it('无 key → degraded「Key 未配置」（fan-out 跳过路径记账）', async () => {
    const { fetchFn } = stubFetch()
    const adapter = new AmapAdapter({ fetchFn })
    try {
      await adapter.weather('330100')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).message).toContain('Key 未配置')
      expect((err as EngineError).code).toBe('UNAVAILABLE')
    }
  })
})

describe('directionTransit 地名前置地理编码（live 实测 INVALID_PARAMS 修复）', () => {
  it('坐标串判定：数字 lng,lat 直传；中文地名/缺失走 geocode', () => {
    expect(isCoordinateString('120.21125,30.28932')).toBe(true)
    expect(isCoordinateString(' 116.48 , 39.99 ')).toBe(true)
    expect(isCoordinateString('杭州东站')).toBe(false)
    expect(isCoordinateString('')).toBe(false)
  })

  it('地名 → 内部 geocode + transit 双调用（transit 用解析出的坐标）', async () => {
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url.replace(/key=[^&]*/, 'key=<MASK>'))
      const ep = url.includes('geocode/geo') ? 'geocode' : url.includes('direction/transit/integrated') ? 'transit' : null
      if (!ep) throw new Error(`no fixture: ${url}`)
      return { ok: true, status: 200, text: async () => JSON.stringify(fixture(ep === 'geocode' ? 'geocode.json' : 'transit.json').response) }
    }
    const adapter = new AmapAdapter({ fetchFn })
    const { options } = await adapter.directionTransit('杭州市江干区东宁路', '西湖风景名胜区', { city: '330100', cityd: '330100' }, ENV_KEY)
    expect(urls.some((u) => u.includes('geocode/geo'))).toBe(true)
    expect(urls.some((u) => u.includes('direction/transit/integrated'))).toBe(true)
    // transit 的 origin 参数 = geocode fixture 解析出的坐标（而非地名）
    const transitUrl = decodeURIComponent(urls.find((u) => u.includes('direction/transit/integrated')) ?? '')
    expect(transitUrl).toContain('origin=116.482086,39.990496')
    expect(transitUrl).toContain('destination=116.482086,39.990496')
    expect(options.length).toBeGreaterThanOrEqual(1)
  })

  it('geocode 失败 → EngineError.UNAVAILABLE（含「地理编码」）+ 不触 transit', async () => {
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url)
      if (url.includes('geocode/geo')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }) }
      }
      throw new Error('不应触发 transit：前置地理编码失败必须短路')
    }
    const adapter = new AmapAdapter({ fetchFn })
    try {
      await adapter.directionTransit('杭州东站', '西湖', { city: '330100', cityd: '330100' }, ENV_KEY)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).code).toBe('UNAVAILABLE')
      expect((err as EngineError).message).toContain('地理编码')
    }
    expect(urls.some((u) => u.includes('direction/transit/integrated'))).toBe(false)
  })

  it('坐标串 → 直传 transit，不重复 geocode（零额外调用）', async () => {
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url)
      if (url.includes('direction/transit/integrated')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(fixture('transit.json').response) }
      }
      throw new Error('坐标串直传不应触发 geocode')
    }
    const adapter = new AmapAdapter({ fetchFn })
    const { routes } = await adapter.directionTransit('120.21125,30.28932', '120.13025,30.25952', { city: '330100', cityd: '330100' }, ENV_KEY)
    expect(urls.filter((u) => u.includes('direction/transit/integrated')).length).toBe(1)
    expect(urls.some((u) => u.includes('geocode/geo'))).toBe(false)
    expect(routes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('amap golden（官方 v3 结构 fixture，离线）', () => {
  it('geocode → GCJ-02 坐标', async () => {
    const adapter = new AmapAdapter({ fetchFn: stubFetch().fetchFn })
    const { coords, degraded } = await adapter.geocode('北京市朝阳区阜通东大街6号', '110000', ENV_KEY)
    expect(degraded).toEqual([])
    expect(coords).toEqual({ lng: 116.482086, lat: 39.990496, sys: 'GCJ02' }) // 真实录制
  })

  it('P0-A R1：geocode 暴露 geocodes[0].district；缺失 → undefined 不猜行政区', async () => {
    const geocodes = fixture('geocode.json').response.geocodes as Array<Record<string, unknown>>
    const withDistrict = new AmapAdapter({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: '1', info: 'OK', infocode: '10000', geocodes }) }),
    })
    const { coords, district } = await withDistrict.geocode('北京市朝阳区阜通东大街6号', '110000', ENV_KEY)
    expect(coords).toEqual({ lng: 116.482086, lat: 39.990496, sys: 'GCJ02' })
    expect(district).toBe('朝阳区') // geocodes[0].district 回报

    // city/区级缺失 → undefined（不猜行政区）
    const noDistrict = new AmapAdapter({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
        status: '1', info: 'OK', infocode: '10000',
        geocodes: [{ location: '116.482086,39.990496', province: '北京市', city: '北京市' }],
      }) }),
    })
    const r2 = await noDistrict.geocode('北京市朝阳区', '110000', ENV_KEY)
    expect(r2.coords).toEqual({ lng: 116.482086, lat: 39.990496, sys: 'GCJ02' })
    expect(r2.district).toBeUndefined()
  })

  it('weather → 4 日预报条目（温度区间）', async () => {
    const adapter = new AmapAdapter({ fetchFn: stubFetch().fetchFn })
    const { entries } = await adapter.weather('330100', ENV_KEY)
    expect(entries.length).toBe(4) // 真实录制
    expect(entries.every((e) => e.tempRange && e.tempRange[0] <= e.tempRange[1])).toBe(true)
  })

  it('directionTransit → routes + §5.5 options', async () => {
    const adapter = new AmapAdapter({ fetchFn: stubFetch().fetchFn })
    const { routes, options } = await adapter.directionTransit('116.301934,39.976928', '116.460395,39.911305', { city: '110000', cityd: '110000' }, ENV_KEY)
    expect(routes.length).toBeGreaterThanOrEqual(1)
    expect(routes[0].durationMinutes).toBe(49) // 真实录制 route0：2913s
    expect(options[0].mode).toContain('方案1')
  })

  it('distanceMatrix → pairs（距离米/时长分钟）', async () => {
    const adapter = new AmapAdapter({ fetchFn: stubFetch().fetchFn })
    const { pairs } = await adapter.distanceMatrix(
      [{ lng: 116.481028, lat: 39.989643, sys: 'GCJ02' }],
      [{ lng: 114.481028, lat: 39.989643, sys: 'GCJ02' }],
      {},
      ENV_KEY,
    )
    expect(pairs[0].distanceMeters).toBe(175316)
    expect(pairs[0].durationMinutes).toBe(147)
  })

  it('distanceMatrix driving=true → 请求 URL 含 type=2（官方口径 1=直线/2=驾车导航）', async () => {
    const { fetchFn, urls } = stubFetch()
    const adapter = new AmapAdapter({ fetchFn })
    const { pairs } = await adapter.distanceMatrix(
      [{ lng: 116.481028, lat: 39.989643, sys: 'GCJ02' }],
      [{ lng: 114.481028, lat: 39.989643, sys: 'GCJ02' }],
      { driving: true },
      ENV_KEY,
    )
    expect(pairs[0].distanceMeters).toBe(175316)
    const url = decodeURIComponent(urls.find((u) => u.includes('/distance')) ?? '')
    expect(url).toContain('type=2')
  })

  it('无 key 真实错误信封 → EngineError「INVALID_USER_KEY」', async () => {
    const err = fixture('error.json').response
    const adapter = new AmapAdapter({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(err) }),
    })
    await expect(adapter.geocode('北京', { env: { amapWebservice: 'invalid' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('配额熔断（超预算→停新增+告警）', () => {
  it('POI 预算用尽 → 新请求 EngineError「停新增」+ alarm 记账', async () => {
    const { fetchFn } = stubFetch()
    const adapter = new AmapAdapter({ fetchFn, quota: new QuotaCounter({ poiLimit: 1, restLimit: 10 }) })
    const first = await adapter.poiSearch('西湖', '330100', { pageSize: 3 }, ENV_KEY)
    expect(first.items.length).toBeGreaterThan(0)
    await expect(adapter.poiSearch('灵隐寺', '330100', {}, ENV_KEY)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    const snap = adapter.quotaSnapshot()
    expect(snap.planPoiUsed).toBe(1)
    expect(snap.alarms.some((a) => a.includes('POI') && a.includes('停新增'))).toBe(true)
  })

  it('resetPlanBudget 后恢复（单次规划预算语义）', async () => {
    const { fetchFn } = stubFetch()
    const adapter = new AmapAdapter({ fetchFn, quota: new QuotaCounter({ poiLimit: 1, restLimit: 10 }) })
    await adapter.poiSearch('西湖', '330100', {}, ENV_KEY)
    await expect(adapter.poiSearch('灵隐寺', '330100', {}, ENV_KEY)).rejects.toBeInstanceOf(EngineError)
    adapter.resetPlanBudget()
    const again = await adapter.poiSearch('灵隐寺', '330100', {}, ENV_KEY)
    expect(again.items.length).toBeGreaterThan(0)
  })
})

// live smoke：TRAVEL_LIVE_SMOKE=1 且 key 交割后运行（编排者已交割 AMAP_WEBSERVICE；
// AMAP_JSCODE 未交割——JSAPI 地图留 W5，本 smoke 仅 Web 服务 REST 类）
const liveEnabled = process.env.TRAVEL_LIVE_SMOKE === '1'
describe.skipIf(!liveEnabled)('amap live smoke（真实 key，REST 类）', () => {
  it('direction transit「杭州东站→西湖」地名版（QA 剧本：transit 要求经纬度，前置地理编码）', async () => {
    const liveEnv = (await liveCredentialsEnv(['amapWebservice'])) ?? { env: {} }
    const adapter = new AmapAdapter()
    expect(await adapter.available(liveEnv)).toBe(true)
    const { routes, options, degraded } = await adapter.directionTransit('杭州东站', '西湖', { city: '330100', cityd: '330100' }, liveEnv)
    expect(degraded.length).toBe(0)
    expect(routes.length).toBeGreaterThan(0)
    // 票价方案（priceHint 元）与耗时（分钟）都须在场
    expect(options[0].durationMinutes).toBeGreaterThan(0)
    expect(options[0].priceHint).toBeTruthy()
  }, 45000)

  it('geocode 真实 key → GCJ-02 坐标', async () => {
    const liveEnv = (await liveCredentialsEnv(['amapWebservice'])) ?? { env: {} }
    const adapter = new AmapAdapter()
    const { coords } = await adapter.geocode('杭州市西湖区', '330100', liveEnv)
    expect(coords).toMatchObject({ sys: 'GCJ02' })
    expect(coords!.lng).toBeGreaterThan(119.9)
    expect(coords!.lng).toBeLessThan(120.5)
  }, 30000)
})