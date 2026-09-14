/**
 * 腾讯 map-assistant 适配器单测（M1 T3 / W2a）。
 * golden fixture 默认离线跑（tests/fixtures/tencent/ 真实录制，2026-09-02 实抓）；
 * `TRAVEL_LIVE_SMOKE=1` 时走真实网络（QA 行：poi_search("西湖") 返回含 coords 条目）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EngineError, toDegraded,
} from '../src/adapters/base.js'
import {
  TencentMapAdapter, normalizeWeatherUpdateTime, toPoiIntel, unwrapJsonp,
  type HttpCallFn, type HttpResponseLike,
} from '../src/adapters/tencent.js'
import { makeKeyEnv } from '../src/adapters/env.js'
import { TRAVEL_ADVANCED_DEFAULT, TRAVEL_CHANNELS_DEFAULT, type TravelSettings } from '../src/settings/schema.js'
import { validateIntelItem } from '../src/models/validate.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/tencent/${name}`, import.meta.url), 'utf8')
}

/** 真实响应（已脱敏）注入：返回 JSONP 包裹的 fixture 正文。 */
function jsonpFixture(text: string): string {
  return `qq.maps.callback(${text});`
}

/** 构造 httpCall mock：按 URL 子串路由到 fixture；可注入异常/超时/状态。 */
interface MockHttp {
  call: HttpCallFn
  urls: string[]
  setResponse: (urlPart: string, response: HttpResponseLike) => void
  setThrow: (urlPart: string, err: unknown) => void
}

function mockHttp(): MockHttp {
  const responses = new Map<string, HttpResponseLike>()
  const throws = new Map<string, unknown>()
  const urls: string[] = []
  const call: HttpCallFn = async (url) => {
    urls.push(url)
    for (const [part, err] of throws) {
      if (url.includes(part)) throw err
    }
    for (const [part, response] of responses) {
      if (url.includes(part)) return response
    }
    throw new Error(`mockHttp: no fixture for ${url}`)
  }
  return {
    call,
    urls,
    setResponse: (part, response) => { responses.set(part, response) },
    setThrow: (part, err) => { throws.set(part, err) },
  }
}

function okResponse(text: string, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

describe('tencent 归一化纯函数', () => {
  it('unwrapJsonp：纯 JSON 直通（含中文括号地址不误裁）', () => {
    const json = '{"status":0,"data":[{"address":"武昌区蛇山(地铁口)"}]}'
    expect(unwrapJsonp(json)).toBe(json)
    expect(unwrapJsonp('cb({"status":0});')).toBe('{"status":0}')
    expect(unwrapJsonp('qq.maps.callback({"ok":1});')).toBe('{"ok":1}')
    expect(unwrapJsonp('name&&callback({"ok":1});')).toBe('{"ok":1}')
  })

  it('天气 update_time（东八区本地）→ UTC ISO8601', () => {
    expect(normalizeWeatherUpdateTime('2026-09-02 23:05')).toBe('2026-09-02T15:05:00.000Z')
    expect(normalizeWeatherUpdateTime('2026-09-02T23:05:00')).toBe('2026-09-02T15:05:00.000Z')
  })

  it('toPoiIntel：字段映射/空值清洗/坐标系统', () => {
    const item = toPoiIntel({
      id: '123', title: '楼外楼', address: '西湖孤山路30号', category: '美食:中餐厅:浙江菜',
      location: { lat: 30.250263, lng: 120.140935 }, avg_price: 155,
      opening_hours: '10:30-14:30,16:00-20:30', star_level: 4.3,
      // P0-A R1：ad_info 的 province/city/district 拼成 district 串随条目返回
      ad_info: { adcode: 330106, province: '浙江省', city: '杭州市', district: '西湖区' },
    }, 'tencent-map')
    expect(item).toMatchObject({
      id: 'tencent-poi:123', category: 'food', channel: 'tencent-poi', rating: 4.3,
      avgPrice: 155, openingHours: '10:30-14:30,16:00-20:30', confidence: 'high',
      district: '浙江省杭州市西湖区', // R1 district 拼接正确
      coords: { lng: 120.140935, lat: 30.250263, sys: 'GCJ02' },
    })
    expect(validateIntelItem(item)).toEqual([])
    // -1 人均 / null 营业时间 → 按缺失丢弃
    const dirty = toPoiIntel({ id: '9', title: '夜上黄鹤楼', location: { lat: 30.5, lng: 114.3 }, avg_price: -1, opening_hours: null }, 'tencent-map')
    expect(dirty?.avgPrice).toBeUndefined()
    expect(dirty?.openingHours).toBeUndefined()
    // 垃圾条目 → undefined
    expect(toPoiIntel(null, 'tencent-map')).toBeUndefined()
    expect(toPoiIntel({}, 'tencent-map')).toBeUndefined()
  })

  it('P0-A R1：ad_info 组装 district；三级区级/全缺时报空 undefined 不抛、不猜', () => {
    // 有 province/city 无第三级区 → 报「省+市」串（与 weather region 拼接同构，非猜测行政区）
    const twoLevel = toPoiIntel({
      id: '8', title: '楼外楼', location: { lat: 30.25, lng: 120.14 },
      ad_info: { adcode: 330106, province: '浙江省', city: '杭州市' },
    }, 'tencent-map')
    expect(twoLevel?.district).toBe('浙江省杭州市')
    // ad_info 全缺 → district=undefined（不拼接猜测行政区）
    const empty = toPoiIntel({
      id: '7', title: '楼外楼', location: { lat: 30.25, lng: 120.14 },
      ad_info: { adcode: 330106 },
    }, 'tencent-map')
    expect(empty?.district).toBeUndefined()
    const noAd = toPoiIntel({ id: '6', title: '楼外楼', location: { lat: 30.25, lng: 120.14 } }, 'tencent-map')
    expect(noAd?.district).toBeUndefined()
    expect(validateIntelItem(twoLevel!)).toEqual([]) // district 可选向后兼容
    expect(validateIntelItem(empty!)).toEqual([])
  })
})

describe('tencent golden（fixture 离线）', () => {
  it('poi_search 黄鹤楼 → IntelItem（rating/avgPrice/openingHours/coords GCJ02）', async () => {
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    const result = await adapter.poiSearch({ keywords: '黄鹤楼', region: '武汉' })
    const items = result.data
    expect(items.length).toBeGreaterThanOrEqual(3)
    const first = items[0]
    expect(first.title).toBe('黄鹤楼')
    expect(first.rating).toBe(4.8)
    expect(first.avgPrice).toBe(120)
    expect(first.openingHours).toContain('08:30')
    expect(first.coords).toEqual({ lng: 114.302539, lat: 30.544624, sys: 'GCJ02' })
    expect(first.category).toBe('attraction')
    expect(first.channel).toBe('tencent-poi')
    expect(first.confidence).toBe('high')
    expect(first.district).toBe('湖北省武汉市武昌区') // P0-A R1：fixture ad_info 三层拼接
    expect(first.summary).toContain('评分')
    expect(first.summary).toContain('人均')
    expect(validateIntelItem(first)).toEqual([])
    // 请求参数形态（depth 核验样本：boundary=region + 富信息字段；中文已 URL 编码）
    const url = mock.urls[0]
    expect(decodeURIComponent(url)).toContain('boundary=region(武汉,0)')
    expect(url).toContain('added_fields=star_level%2Cavg_price%2Copening_hours')
    expect(url).toContain('get_rich=1')
    expect(url).toContain('key=none')
    expect(mock.urls.length).toBe(1)
  })

  it('poi_nearby 西湖美食 → 周边搜索参数与分类', async () => {
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-nearby-xihu-food.json'))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    const result = await adapter.poiNearby({ keywords: '美食', location: '30.246943,120.149373', radiusMeters: 1000 })
    expect(mock.urls[0]).toContain('nearby%2830.246943%2C120.149373%2C1000%2C1%29')
    const first = result.data[0]
    expect(first.category).toBe('food')
    expect(first.avgPrice).toBe(155)
    expect(first.rating).toBe(4.3)
    expect(first.openingHours).toBe('10:30-14:30,16:00-20:30')
    // 西湖家宴（opening_hours:null）→ 缺失
    const noHours = result.data.find((i) => i.title === '西湖家宴杭帮菜')
    expect(noHours?.openingHours).toBeUndefined()
  })

  it('weather future → 逐日 AdviceWeatherEntry（日期/昼夜文案/温度区间/来源）', async () => {
    const mock = mockHttp()
    mock.setResponse('weather/v1', okResponse(jsonpFixture(fixture('weather-hangzhou.json'))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    const result = await adapter.weather({ adcode: '330106' })
    expect(result.data.region).toBe('浙江省杭州市西湖区')
    expect(result.data.updateTime).toBe('2026-09-02T15:05:00.000Z')
    const days = result.data.days
    expect(days.length).toBeGreaterThanOrEqual(3)
    const day0 = days[0]
    expect(day0.date).toBe('2026-09-02')
    expect(day0.dayForecast).toContain('白天')
    expect(day0.dayForecast).toContain('夜间')
    expect(day0.tempRange).toEqual([24, 28])
    expect(day0.source.fetchedAt).toMatch(/^20\d\d-\d\d-\d\dT/)
    expect(day0.source.url).toContain('weather')
    // 全部日期合法
    for (const day of days) expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('weather 空预报 → EngineError.EMPTY', async () => {
    const mock = mockHttp()
    mock.setResponse('weather/v1', okResponse(jsonpFixture(JSON.stringify({ status: 0, message: 'Success', result: { forecast: [{ infos: [] }] } }))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    await expect(adapter.weather({ adcode: '330106' })).rejects.toMatchObject({ code: 'EMPTY' })
  })

  it('distance_matrix → 行元素（秒→分钟归一化）', async () => {
    const mock = mockHttp()
    mock.setResponse('distance/v1/matrix', okResponse(jsonpFixture(fixture('distance-matrix.json'))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    const result = await adapter.distanceMatrix({
      from: ['30.544624,114.302539', '30.2741,120.1551'],
      to: ['30.2741,120.1551', '30.544624,114.302539'],
    })
    expect(result.data.mode).toBe('driving')
    expect(result.data.from).toEqual(['30.544624,114.302539', '30.2741,120.1551'])
    expect(result.data.rows.length).toBe(2)
    const el = result.data.rows[0].elements[0]
    expect(el.toIndex).toBe(0)
    expect(el.distanceMeters).toBe(686295)
    expect(el.durationMinutes).toBe(476) // 28562s → Math.round(476.03)
    expect(result.data.rows[0].elements[1].durationMinutes).toBe(6) // 349s → 6min
    expect(result.data.rows[1].elements[0].distanceMeters).toBe(0)
  })

  it('travel_guide → A2A SSE 真实事件流解析为多日行程（tips/坐标/poi_uid）', async () => {
    const mock = mockHttp()
    mock.setResponse('aichat/v1/a2a', okResponse(fixture('travel-guide-a2a.sse.txt')))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    const result = await adapter.travelGuide({ text: '杭州一日游攻略，西湖断桥白堤为主' })
    expect(result.data.summaryTitle).toBe('杭州1日旅行攻略')
    expect(result.data.days.length).toBeGreaterThanOrEqual(1)
    const day0 = result.data.days[0]
    expect(day0.day).toBe(1)
    expect(day0.items.length).toBeGreaterThanOrEqual(5)
    const first = day0.items[0]
    expect(first.name).toBe('断桥残雪')
    expect(first.coords).toEqual({ lng: 120.151682, lat: 30.25861, sys: 'GCJ02' })
    expect(first.poiId).toBe('10190497566017839284')
    expect(first.tips.length).toBeGreaterThanOrEqual(1)
    expect(first.desc.length).toBeGreaterThan(10)
  })
})

describe('tencent EngineError → degraded 记账（MUST DO 2）', () => {
  it('mock 超时 → TIMEOUT → degraded[] 记账不抛裸异常', async () => {
    const mock = mockHttp()
    mock.setThrow('place/v1/search', Object.assign(new Error('fetch aborted'), { name: 'TimeoutError' }))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    try {
      await adapter.poiSearch({ keywords: '西湖', region: '杭州' })
      expect.unreachable('应当抛出 EngineError')
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError)
      const engine = err as EngineError
      expect(engine.code).toBe('TIMEOUT')
      expect(engine.source).toBe('tencent-map')
      const entry = toDegraded(adapter.name, engine)
      expect(entry).toMatchObject({ source: 'tencent-map', code: 'TIMEOUT' })
      expect(entry.at).toMatch(/^20\d\d-\d\d-\d\dT/)
      expect(entry.reason).toContain('超时')
    }
  })

  it('status≠0（参数错误 700）→ UNAVAILABLE → degraded', async () => {
    const mock = mockHttp()
    mock.setResponse('weather/v1', okResponse(jsonpFixture(JSON.stringify({ status: 700, message: '参数错误' }))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    try {
      await adapter.weather({ adcode: 'bad' })
      expect.unreachable('应当抛出 EngineError')
    } catch (err) {
      const engine = err as EngineError
      expect(engine.code).toBe('UNAVAILABLE')
      expect(engine.message).toContain('status=700')
      expect(engine.message).toContain('参数错误')
      expect(toDegraded('tencent-map', 'UNAVAILABLE', engine.message).code).toBe('UNAVAILABLE')
    }
  })

  it('非 JSON 响应（网关页）→ UNAVAILABLE', async () => {
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse('<html>waf</html>', 200))
    const adapter = new TencentMapAdapter({ httpCall: mock.call })
    await expect(adapter.poiSearch({ keywords: '西湖' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('tencent 正式 key 切换位（resolveKey 链）', () => {
  it('env 命中 TMAP_KEY → 走 apis.map.qq.com 正式通道（key=已解析值）', async () => {
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const adapter = new TencentMapAdapter({
      httpCall: mock.call,
      keyEnv: { env: { TMAP_KEY: 'TEST-KEY-ABC' } },
    })
    await adapter.poiSearch({ keywords: '黄鹤楼', region: '武汉' })
    const url = mock.urls[0]
    expect(url).toContain('https://apis.map.qq.com')
    expect(url).toContain('key=TEST-KEY-ABC')
    expect(url).not.toContain('apptag')
    // 无明文落盘：key 只出现在运行时 URL
    const resolved = await adapter.resolveKeyOnce()
    expect(resolved).toEqual({ value: 'TEST-KEY-ABC', layer: 'env' })
  })

  it('无 key → 体验通道（h5gw + key=none + apptag + jsonp）', async () => {
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call, keyEnv: { env: {} } })
    expect(await adapter.resolveKeyOnce()).toBeUndefined()
    await adapter.poiSearch({ keywords: '黄鹤楼', region: '武汉' })
    const url = mock.urls[0]
    expect(url).toContain('https://h5gw.map.qq.com')
    expect(url).toContain('key=none')
    expect(url).toContain('apptag=h5mutipos_place_search')
    expect(url).toContain('output=jsonp')
  })

  it('available() 零 key 常开；POI 参数校验错误抛 UNAVAILABLE', async () => {
    const adapter = new TencentMapAdapter({ httpCall: mockHttp().call })
    await expect(adapter.available()).resolves.toBe(true)
    await expect(adapter.poiSearch({ keywords: '' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(adapter.poiNearby({ keywords: '美食' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(adapter.distanceMatrix({ from: [], to: [] })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('M2 遗留修复：TMAP key 链接线三态 + 热读（CLOSURE ⑥ / ADR-12 行 698）', () => {
  function tmapSettings(keys: TravelSettings['keys']): TravelSettings {
    return { channels: TRAVEL_CHANNELS_DEFAULT, keys, advanced: TRAVEL_ADVANCED_DEFAULT }
  }

  /** env 风格凭据假体（可改值模拟热更新）。 */
  function mutableRefCredentials(getValue: () => string): { resolve: () => Promise<{ value: string; source: 'file' } | undefined>; readRecord: () => Promise<undefined> } {
    return {
      resolve: async () => (getValue() === '' ? undefined : { value: getValue(), source: 'file' as const }),
      readRecord: async () => undefined,
    }
  }

  const noCtx = { get: () => undefined }

  it('态1 有 tencent 侧配置（settings keys.tmap）无 tmap credentials ref → 映射生效（TMAP_KEY→keys.tmap）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: tmapSettings({ tmap: 'SETTINGS-TMAP' }),
      credentials: mutableRefCredentials(() => ''), // 无 tmap ref
      env: {},
    })
    const adapter = new TencentMapAdapter({ keyEnv: env })
    const resolved = await adapter.resolveKeyOnce()
    expect(resolved).toEqual({ value: 'SETTINGS-TMAP', layer: 'settings' })
    // 链接线生效：poiSearch 走 apis.map.qq.com 正式通道，key=settings 值
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const adapter2 = new TencentMapAdapter({ httpCall: mock.call, keyEnv: env })
    await adapter2.poiSearch({ keywords: '黄鹤楼', region: '武汉' })
    expect(mock.urls[0]).toContain('https://apis.map.qq.com')
    expect(mock.urls[0]).toContain('key=SETTINGS-TMAP')
  })

  it('态2 无 tencent 无 tmap → 无 key（resolveKeyOnce=undefined → 体验通道）', async () => {
    const env = makeKeyEnv(noCtx, {
      settings: tmapSettings({}),
      credentials: mutableRefCredentials(() => ''),
      env: {},
    })
    const adapter = new TencentMapAdapter({ keyEnv: env })
    expect(await adapter.resolveKeyOnce()).toBeUndefined()
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const adapter2 = new TencentMapAdapter({ httpCall: mock.call, keyEnv: env })
    await adapter2.poiSearch({ keywords: '黄鹤楼', region: '武汉' })
    expect(mock.urls[0]).toContain('https://h5gw.map.qq.com')
    expect(mock.urls[0]).toContain('key=none')
  })

  it('态3 热读：改 ref 后下次调用立刻生效（resolveKeyOnce 无跨调用缓存）', async () => {
    let refValue = 'TMAP-V1'
    const env = makeKeyEnv(noCtx, {
      settings: tmapSettings({}),
      credentials: mutableRefCredentials(() => refValue),
      env: {},
    })
    const mock = mockHttp()
    mock.setResponse('place/v1/search', okResponse(jsonpFixture(fixture('poi-search-huanghelou.json'))))
    const adapter = new TencentMapAdapter({ httpCall: mock.call, keyEnv: env })
    expect((await adapter.resolveKeyOnce())?.value).toBe('TMAP-V1')
    // 改 ref（credentials 热更新）→ 同一实例下一次调用即新值（per-invocation，无缓存）
    refValue = 'TMAP-V2'
    expect((await adapter.resolveKeyOnce())?.value).toBe('TMAP-V2')
    await adapter.poiSearch({ keywords: '黄鹤楼', region: '武汉' })
    expect(mock.urls[0]).toContain('key=TMAP-V2')
    expect(mock.urls[0]).not.toContain('key=TMAP-V1')
  })
})

const live = LIVE ? describe : describe.skip

live('tencent live smoke（TRAVEL_LIVE_SMOKE=1）', () => {
  it('poi_search("西湖") 返回含 coords 条目（QA happy 剧本）', async () => {
    const adapter = new TencentMapAdapter()
    const result = await adapter.poiSearch({ keywords: '西湖', region: '杭州', pageSize: 5 })
    expect(result.data.length).toBeGreaterThan(0)
    const withCoords = result.data.find((i) => i.coords !== undefined)
    expect(withCoords).toBeDefined()
    expect(withCoords?.coords?.sys).toBe('GCJ02')
    console.log(`[live] poi_search 西湖：${result.data.length} 条；首条 ${result.data[0].title} @ ${JSON.stringify(result.data[0].coords)}`)
  }, 30_000)

  it('weather future 真实 5 天预报', async () => {
    const adapter = new TencentMapAdapter()
    const result = await adapter.weather({ adcode: '330106' })
    expect(result.data.days.length).toBeGreaterThanOrEqual(1)
    console.log(`[live] weather 杭州西湖区：${result.data.days.length} 天，首日 ${result.data.days[0].dayForecast}`)
  }, 30_000)

  it('distance_matrix 真实往返', async () => {
    const adapter = new TencentMapAdapter()
    const result = await adapter.distanceMatrix({
      from: ['30.250263,120.140935'], // 楼外楼
      to: ['30.239935,120.210661'],   // 杭州东站
    })
    expect(result.data.rows[0].elements[0].distanceMeters).toBeGreaterThan(0)
    console.log(`[live] distance_matrix 楼外楼→杭州东：${result.data.rows[0].elements[0].distanceMeters}m / ${result.data.rows[0].elements[0].durationMinutes}min`)
  }, 30_000)
})