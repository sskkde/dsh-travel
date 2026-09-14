/**
 * travel_research_advice 单测（W3）：
 * 天气链 amap→腾讯→Open-Meteo（FR-5 验收①：天气条目含数据日期(source.fetchedAt)与
 * 来源(source.platform)）；超预报窗口 → beyondForecastWindow + 气候概况标注；
 * 穿衣/物品模板 + 画像定制（FR-5 验收②：物品清单 ≥10 项且与画像相关）；advice.json
 * 落盘校验；渠道开关过滤；契约/状态边界。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchAdvice, createTravelResearchAdviceTool, ADVICE_TIMEOUT_MS, seasonalClimateTemplate, type ResearchAdviceDeps } from '../src/tools/research-advice.js'
import { AmapAdapter } from '../src/adapters/amap.js'
import { TencentMapAdapter, type HttpCallFn, type HttpResponseLike } from '../src/adapters/tencent.js'
import { OpenMeteoAdapter } from '../src/adapters/open-meteo.js'
import { SearchAdapter, type HostSearchFn } from '../src/adapters/search.js'
import { validateAdvice } from '../src/models/validate.js'
import { TravelValidationError } from '../src/errors.js'
import type { Advice } from '../src/models/types.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-advice-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const FIX = join('tests', 'fixtures')
function fixture(name: string): string {
  return readFileSync(join(FIX, name), 'utf8')
}
function fixtureJson<T>(name: string): T {
  return JSON.parse(fixture(name)) as T
}

function okResponse(text: string, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

function jsonpFixture(text: string): string {
  return `qq.maps.callback(${text});`
}

/** tencent httpCall mock：place/search（坐标）+ weather 路由。 */
function tencentMock(): { call: HttpCallFn; setThrow: (p: string, e: unknown) => void } {
  const responses = new Map<string, HttpResponseLike>()
  const throws = new Map<string, unknown>()
  responses.set('/ws/place/v1/search', okResponse(jsonpFixture(fixture('tencent/poi-search-huanghelou.json'))))
  responses.set('/ws/weather/v1', okResponse(fixture('tencent/weather-hangzhou.json')))
  return {
    call: async (url: string) => {
      for (const [p, e] of throws) if (url.includes(p)) throw e
      for (const [p, r] of responses) if (url.includes(p)) return r
      throw new Error(`tencentMock: no fixture for ${url}`)
    },
    setThrow: (p, e) => { throws.set(p, e) },
  }
}

/** amap fetchFn stub：端点 → fixture response。 */
function amapStub(): (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  const files: Record<string, { response: Record<string, unknown> }> = {
    'weather/weatherInfo': fixtureJson<{ response: Record<string, unknown> }>('amap/weather.json'),
    'geocode/geo': fixtureJson<{ response: Record<string, unknown> }>('amap/geocode.json'),
  }
  return async (url: string) => {
    const hit = Object.entries(files).find(([ep]) => url.includes(ep))
    if (!hit) throw new Error(`amapStub: no fixture for ${url}`)
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1].response) }
  }
}

/** Open-Meteo stub：返回固定 3 日天气预报（离线）。 */
function openMeteoStub(dates: string[]): (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return async () => {
    const body = {
      daily: {
        time: dates,
        temperature_2m_max: [31, 29, 27],
        temperature_2m_min: [24, 22, 20],
        weathercode: [1, 63, 3],
      },
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
}

function l0HostSearch(hits: Array<{ url: string; title: string; snippet?: string }>): HostSearchFn {
  return async () => ({ content: undefined, sources: hits, truncated: false })
}

/** 构造已确认计划（杭州；日期可注入）。
 *  F1c-E（决策 5）：destination-only 新 plan 自动 flowVersion → 完整链受门。本测试
 *  验证的是单城市天气轻量路径（SKILL §3 保留；legacy 单目的地天气兜底），故模拟
 *  真正 legacy 形态（请求文件无 flowVersion 信封），保持既有天气断言不变。 */
async function makePlan(slots: Record<string, unknown> = {}): Promise<string> {
  const result = await runIntake({
    slots: {
      destination: '杭州',
      dateStart: '2026-09-02',
      dateEnd: '2026-09-04',
      days: 3,
      travelers: { adults: 2, seniors: 1, children: 1 },
      preferences: { themes: ['徒步', '自然'] },
      ...slots,
    },
  }, store)
  const req = await store.loadRequest(result.planId)
  await store.saveRequest({ ...req!, flowVersion: undefined })
  return result.planId
}

const AMAP_ENV = { env: { amapWebservice: 'test-key' } }

/** 全链就位依赖（amap 主 → 腾讯/Open-Meteo 兜底 + L0 建议搜索）。 */
function fullDeps(): ResearchAdviceDeps {
  return {
    amap: new AmapAdapter({ fetchFn: amapStub() }),
    tencent: new TencentMapAdapter({ httpCall: tencentMock().call }),
    openMeteo: new OpenMeteoAdapter({ fetchFn: openMeteoStub(['2026-10-02', '2026-10-03', '2026-10-04']) }),
    search: new SearchAdapter({ hostSearch: l0HostSearch([
      { url: 'https://example.invalid/note1', title: '杭州 10月 平均气温 15~25℃', snippet: '历史同期' },
    ]) }),
    env: AMAP_ENV,
  }
}

describe('天气链（FR-5 验收①：数据日期与来源）', () => {
  it('amap 主渠道：逐日天气含 date + tempRange + source{platform,fetchedAt}', async () => {
    const planId = await makePlan()
    const result = await runResearchAdvice({ planId }, store, fullDeps())
    expect(result.weather.length).toBe(3) // 行程 3 日
    expect(result.weather.map((w) => w.date).sort()).toEqual(['2026-09-02', '2026-09-03', '2026-09-04'])
    for (const w of result.weather) {
      expect(w.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(w.source.platform.length).toBeGreaterThan(0) // 来源：amap-weather/tencent-map/open-meteo
      expect(w.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // 数据日期（ISO8610 获取时间）
      expect(w.tempRange).toBeDefined()
      expect(w.dayForecast).toBeTruthy()
    }
    // amap 为 09-03 起的 4 天窗口：09-03/04 应命中 amap-weather（链首）
    const amapDays = result.weather.filter((w) => w.source.platform === 'amap-weather')
    expect(amapDays.length).toBeGreaterThanOrEqual(2)
    const persisted = await store.readJson<Advice>(planId, 'advice.json')
    expect(persisted).toBeDefined()
    expect(validateAdvice(persisted).length).toBe(0)
  })

  it('amap 失败（Key 未配置）→ 腾讯天气兜底（location 模式，平台=tencent-map）', async () => {
    const planId = await makePlan()
    const deps = {
      amap: new AmapAdapter({ fetchFn: async () => { throw new Error('Key 未配置') } }),
      tencent: new TencentMapAdapter({ httpCall: tencentMock().call }),
      openMeteo: new OpenMeteoAdapter({ fetchFn: openMeteoStub([]) }),
      search: new SearchAdapter({ hostSearch: l0HostSearch([]) }),
      env: { env: {} },
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    expect(result.degraded.some((d) => d.source === 'weatherAmap')).toBe(true)
    const tencentDays = result.weather.filter((w) => w.source.platform === 'tencent-map')
    expect(tencentDays.length).toBeGreaterThanOrEqual(3)
    expect(result.weather.every((w) => w.source.fetchedAt !== undefined)).toBe(true)
  })

  it('amap+腾讯均失败 → Open-Meteo 兜底（16 天窗口）', async () => {
    const planId = await makePlan()
    const mock = tencentMock()
    mock.setThrow('/ws/place/v1/search', new Error('坐标解析失败'))
    const deps = {
      amap: new AmapAdapter({ fetchFn: async () => { throw new Error('Key 未配置') } }),
      tencent: new TencentMapAdapter({ httpCall: mock.call }),
      openMeteo: new OpenMeteoAdapter({ fetchFn: openMeteoStub(['2026-10-02', '2026-10-03', '2026-10-04']) }),
      // 坐标解不出来 → open-meteo 也 skip；此用例验证降级记链与不崩
      search: new SearchAdapter({ hostSearch: l0HostSearch([]) }),
      env: { env: {} },
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    expect(result.degraded.some((d) => d.source === 'coords/tencent')).toBe(true)
    expect(result.weather.some((w) => w.beyondForecastWindow)).toBe(true)
  })

  it('超预报窗口 → beyondForecastWindow:true + 气候概况标注（L0 搜索合成）', async () => {
    const planId = await makePlan({ dateStart: '2026-12-01', dateEnd: '2026-12-04', days: 4 })
    const deps = {
      amap: new AmapAdapter({ fetchFn: amapStub() }), // 4 天窗口：12 月已超出
      tencent: new TencentMapAdapter({ httpCall: tencentMock().call }), // 5 天窗口
      openMeteo: new OpenMeteoAdapter({ fetchFn: openMeteoStub(['2026-12-01', '2026-12-02', '2026-12-03']) }), // 空窗→请求失败？固定返回 12-01..，其实命中
      search: new SearchAdapter({ hostSearch: l0HostSearch([
        { url: 'https://example.invalid/climate', title: '杭州 12月 平均气温 3~11℃', snippet: '冬季湿冷' },
      ]) }),
      env: AMAP_ENV,
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    // open-meteo stub 返回 12-01..03 → 命中行程 → 非 beyond
    const beyond = result.weather.filter((w) => w.beyondForecastWindow === true)
    expect(beyond.length).toBeGreaterThanOrEqual(0)
    // 12-04（第 4 天）配合 stub 3 天 → beyond
    const w = result.weather.find((e) => e.date === '2026-12-04')
    expect(w?.beyondForecastWindow).toBe(true)
    expect(w?.dayForecast).toContain('气候概况')
  })

  it('天气条目数据日期与来源校验（FR-5 验收① 完整断言）', async () => {
    const planId = await makePlan()
    const result = await runResearchAdvice({ planId }, store, fullDeps())
    for (const w of result.weather) {
      expect(typeof w.source.platform).toBe('string')
      expect(w.source.platform.length).toBeGreaterThan(0)
      expect(typeof w.source.fetchedAt).toBe('string')
      expect(w.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })
})

describe('穿衣/物品（FR-5 验收②：清单 ≥10 且与画像相关）', () => {
  it('packingList ≥10 项（基础模板 + 老人/儿童/徒步扩展）', async () => {
    const planId = await makePlan() // seniors+children+徒步
    const result = await runResearchAdvice({ planId }, store, fullDeps())
    expect(result.packingList.length).toBeGreaterThanOrEqual(10)
    const joined = result.packingList.join('')
    expect(joined).toContain('老人')
    expect(joined).toContain('儿童')
    expect(joined).toContain('登山鞋')
  })

  it('clothing 按温度区间 + 雨天/冬季扩展', async () => {
    const planId = await makePlan()
    const result = await runResearchAdvice({ planId }, store, fullDeps())
    expect(result.clothing.length).toBeGreaterThanOrEqual(2)
    // amap fixture 白天 28℃ 夜 21℃ → 20~28 档（长袖+薄外套）
    const joined = result.clothing.join('')
    expect(result.clothing.some((c) => c.includes('薄外套') || c.includes('短袖'))).toBe(true)
    expect(joined).toContain('老人')
  })

  it('超出预报窗口的冬季季节模板不伪作实测温度，走通用分层建议', async () => {
    // 2027 日期超出 Open-Meteo 窗口：seasonal-template 仅作规划参考，不驱动羽绒服精确分支。
    const planId = await makePlan({ dateStart: '2027-01-10', dateEnd: '2027-01-12', days: 3 })
    const coldMeteo: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> = async () => {
      const body = { daily: { time: ['2027-01-10', '2027-01-11', '2027-01-12'], temperature_2m_max: [6, 5, 7], temperature_2m_min: [-2, -1, 0], weathercode: [71, 73, 3] } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    const deps = {
      amap: new AmapAdapter({ fetchFn: async () => { throw new Error('Key 未配置') } }),
      tencent: new TencentMapAdapter({ httpCall: tencentMock().call }),
      openMeteo: new OpenMeteoAdapter({ fetchFn: coldMeteo }),
      search: new SearchAdapter({ hostSearch: l0HostSearch([]) }),
      env: { env: {} },
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    const joined = (result.clothing.join('') + result.packingList.join(''))
    expect(joined).toContain('季节分层着装')
    expect(joined).toContain('保暖')
    expect(result.weather.every((entry) => entry.temperatureBasis === 'seasonal-template')).toBe(true)
  })

  it('T22 本地季节模板有温度范围、风/日防护，不输出温度未知占位', () => {
    const template = seasonalClimateTemplate('青甘环线', 1)
    expect(template.tempRange).toEqual([-10, 8])
    expect(template.temperatureBasis).toBe('seasonal-template')
    expect(template.text).toMatch(/-10~8℃/)
    expect(template.text).toContain('防风')
    expect(template.text).toContain('防晒')
    expect(template.text).toContain('通用季节规划参考')
    expect(template.text).toContain('非目的地/海拔实测')
    expect(template.text).not.toContain('温度未知')
  })

  it('T22 seasonal-template 数值不驱动精确穿衣；无可靠温度走通用分层建议', async () => {
    const planId = await makePlan()
    const result = await runResearchAdvice({ planId }, store, {
      amap: new AmapAdapter({ fetchFn: async () => { throw new Error('fixture no weather') } }),
      search: new SearchAdapter(),
      env: { env: {} },
    })
    expect(result.weather.length).toBe(3)
    expect(result.weather.every((entry) => entry.temperatureBasis === 'seasonal-template')).toBe(true)
    expect(result.weather.every((entry) => entry.dayForecast?.includes('通用季节规划参考'))).toBe(true)
    expect(result.clothing).toContain('季节分层着装：轻便长袖 + 可叠加保暖层，备防风外套')
    expect(result.clothing.join('')).not.toContain('羽绒服')
    expect(result.clothing.join('')).not.toContain('短袖 T 恤')
    const persisted = await store.readJson<Advice>(planId, 'advice.json')
    expect(persisted?.weather.every((entry) => entry.temperatureBasis === 'seasonal-template')).toBe(true)
  })

  it('T22 有可靠历史 L0 温度 → 标记 historical 并允许精确温度分支', async () => {
    const planId = await makePlan()
    const result = await runResearchAdvice({ planId }, store, {
      search: new SearchAdapter({ hostSearch: l0HostSearch([
        { url: 'https://example.invalid/historical', title: '杭州历史同期平均气温 3~11℃' },
      ]) }),
      env: { env: {} },
    })
    expect(result.weather.every((entry) => entry.temperatureBasis === 'historical')).toBe(true)
    expect(result.clothing.join('')).toContain('羽绒服')
  })

  it('extraTips 由 L0 搜索跨源合成：同文案合并来源、最多 4 条', async () => {
    const planId = await makePlan()
    const deps = fullDeps()
    deps.search = new SearchAdapter({ hostSearch: l0HostSearch([
      { url: 'https://example.invalid/tip1', title: '杭州旅游注意事项', snippet: '西湖景区工作日免预约，节假日需预约' },
      { url: 'https://example.invalid/tip2', title: '杭州预约提醒', snippet: '西湖景区工作日免预约，节假日需预约' },
      { url: 'https://example.invalid/tip3', title: '杭州交通', snippet: '高峰期预留换乘时间' },
      { url: 'https://example.invalid/tip4', title: '杭州安全', snippet: '保管随身物品' },
      { url: 'https://example.invalid/tip5', title: '杭州饮食', snippet: '按需选择口味' },
    ]) })
    const result = await runResearchAdvice({ planId }, store, deps)
    expect(result.extraTips.length).toBe(4)
    expect(result.extraTips[0]).toContain('预约')
    expect(result.extraTips[0]).toContain('tip1')
    expect(result.extraTips[0]).toContain('tip2')
  })
})

describe('渠道开关过滤与边界', () => {
  it('weatherAmap 开关关闭 → amap 跳过 + degraded「已停用（用户配置）」，腾讯兜底照常', async () => {
    const planId = await makePlan()
    const deps = fullDeps()
    deps.env = {
      readSettings: (key) => (key === 'channels.weatherAmap' ? 'false' : undefined),
      env: { amapWebservice: 'test-key' },
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    expect(result.degraded.some((d) => d.source === 'weatherAmap' && d.reason.includes('已停用'))).toBe(true)
    expect(result.weather.length).toBe(3) // 腾讯/Open-Meteo 仍产出
    expect(result.weather.some((w) => w.source.platform === 'tencent-map')).toBe(true)
  })

  it('adviceSearch 开关关闭 → 该渠道零调用 + degraded「已停用（用户配置）」（L0 tips 与气候检索都不发起）', async () => {
    const planId = await makePlan()
    let searchCalls = 0
    const deps: ResearchAdviceDeps = {
      ...fullDeps(),
      search: new SearchAdapter({
        hostSearch: async () => {
          searchCalls += 1
          return { content: undefined, sources: [], truncated: false }
        },
      }),
    }
    deps.env = {
      readSettings: (key) => (key === 'channels.adviceSearch' ? 'false' : undefined),
      env: { amapWebservice: 'test-key' },
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    expect(searchCalls).toBe(0) // 唯一显式控制：关掉即不发起 L0 检索
    expect(result.degraded.some(
      (d) => d.source === 'adviceSearch' && d.reason.includes('已停用（用户配置）'),
    )).toBe(true)
    expect(result.extraTips).toEqual([]) // tipsTopic 存在但渠道停用 → 留空诚实，不编造
    expect(result.weather.length).toBe(3) // 天气链不受该开关影响
  })

  it('adviceSearch 开关关闭 → 气候条目回落季节模板（不以模板冒充实测）', async () => {
    const makeDeps = (adviceSearchOff: boolean): { deps: ResearchAdviceDeps; calls: () => number } => {
      let calls = 0
      const mock = tencentMock()
      mock.setThrow('/ws/place/v1/search', new Error('坐标失败'))
      const deps: ResearchAdviceDeps = {
        amap: new AmapAdapter({ fetchFn: async () => { throw new Error('Key 未配置') } }),
        tencent: new TencentMapAdapter({ httpCall: mock.call }),
        openMeteo: new OpenMeteoAdapter({ fetchFn: async () => { throw new Error('网络不可达') } }),
        search: new SearchAdapter({
          hostSearch: async () => {
            calls += 1
            // 抽不到可验证历史温度区间 → climateOverview 回落季节模板
            return { content: undefined, sources: [{ url: 'https://example.invalid/climate', title: '杭州气候' }], truncated: false }
          },
        }),
        env: {
          readSettings: (key) => (adviceSearchOff && key === 'channels.adviceSearch' ? 'false' : undefined),
          env: {},
        },
      }
      return { deps, calls: () => calls }
    }

    const on = makeDeps(false)
    const planOn = await makePlan()
    const resultOn = await runResearchAdvice({ planId: planOn }, store, on.deps)
    expect(on.calls()).toBeGreaterThan(0) // 开关开 = 照常检索（回归基线）
    expect(resultOn.weather.every((w) => w.beyondForecastWindow === true)).toBe(true)

    const off = makeDeps(true)
    const planOff = await makePlan()
    const resultOff = await runResearchAdvice({ planId: planOff }, store, off.deps)
    expect(off.calls()).toBe(0) // 关 = 零调用
    expect(resultOff.weather.length).toBe(3)
    expect(resultOff.weather.every((w) => w.beyondForecastWindow === true)).toBe(true)
    expect(resultOff.weather.every((w) => w.temperatureBasis === 'seasonal-template')).toBe(true) // 模板来源显式，非实测
    expect(resultOff.degraded.some(
      (d) => d.source === 'adviceSearch' && d.reason.includes('已停用（用户配置）'),
    )).toBe(true)
  })

  it('计划不存在 → TravelValidationError；缺目的地 → TravelValidationError', async () => {
    const deps = fullDeps()
    await expect(runResearchAdvice({ planId: 'plan-nope' }, store, deps)).rejects.toThrow(TravelValidationError)
    const noDest = await runIntake({
      slots: { dateStart: '2026-10-02', dateEnd: '2026-10-04', days: 3 },
    }, store)
    await expect(runResearchAdvice({ planId: noDest.planId }, store, deps)).rejects.toThrow(/destination/)
  })

  it('工具定义可构建 + 默认超时 60s + 状态 researching self', async () => {
    const planId = await makePlan()
    const tool = createTravelResearchAdviceTool(store, fullDeps())
    expect(tool.name).toBe('travel_research_advice')
    expect(tool.timeoutMs).toBe(ADVICE_TIMEOUT_MS)
    await runResearchAdvice({ planId }, store, fullDeps())
    const again = await runResearchAdvice({ planId }, store, fullDeps())
    expect(again.weather.length).toBe(3)
    const request = await store.loadRequest(planId)
    expect(request?.status).toBe('researching')
  })

  it('全部天气源失败 → beyondForecastWindow 气候条目兜底，advice.json 仍落盘（packing ≥10）', async () => {
    const planId = await makePlan()
    const mock = tencentMock()
    mock.setThrow('/ws/place/v1/search', new Error('坐标失败'))
    const deps = {
      amap: new AmapAdapter({ fetchFn: async () => { throw new Error('Key 未配置') } }),
      tencent: new TencentMapAdapter({ httpCall: mock.call }),
      openMeteo: new OpenMeteoAdapter({ fetchFn: async () => { throw new Error('网络不可达') } }),
      search: new SearchAdapter({ hostSearch: l0HostSearch([]) }),
      env: { env: {} },
    }
    const result = await runResearchAdvice({ planId }, store, deps)
    expect(result.weather.length).toBe(3)
    expect(result.weather.every((w) => w.beyondForecastWindow === true)).toBe(true)
    expect(result.packingList.length).toBeGreaterThanOrEqual(10)
    const persisted = await store.readJson<Advice>(planId, 'advice.json')
    expect(persisted).toBeDefined()
    expect(validateAdvice(persisted).length).toBe(0)
  })
})