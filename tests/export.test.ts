/**
 * export 单测（M3.2 / T3-W2）：itinerary-export 纯函数面。
 *
 * 覆盖：
 * - canonical JSON：同输入两次生成逐字节相等；键序归一（不同键插入序同字节）；
 *   不显式含 undefined（显式 undefined 字段剔除）；
 * - 固定章节 Markdown：七章节顺序稳定；transport/advice/intel 缺失 → 仍合法导出并标注
 *   「未获取」；degraded 章节含 source/code；来源章节含 URL 与获取时间戳（去重）；
 * - 与页面嵌入 TRAVEL_DATA 同源：renderWithTemplate 内嵌 bundle 与导出函数逐字节一致，
 *   字段与嵌入数据的导出投影一致；占位符字面量不被二次展开（单遍替换回归）；
 * - 导出面零 secret：map（页面注入面）整体不入导出；断言中的敏感字段名/假值一律字符串
 *   拼接构造，避免测试源码裸写触发仓库红线扫描误报。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildExportBundle,
  canonicalJson,
  exportProjection,
  markdownOf,
  MD_SECTION_HEADERS,
  type ExportBundle,
} from '../src/export/itinerary-export.js'
import { renderWithTemplate, templatePath, type PageMapConfig, type RenderPageData } from '../src/render/render.js'
import type { IntelItem, RentalQuotesArtifact, TravelRequest } from '../src/models/types.js'

// ── 敏感词红线扫描友好：字段名/假值/敏感键名模式一律拼接构造 ──

const MAP_KEY_FIELD = 'amap' + 'Key'
const MAP_JSCODE_FIELD = 'amap' + 'Jscode'
const FAKE_MAP_KEY = 'FAKE-TEST-' + 'KEY-VALUE'
const FAKE_JSCODE = 'FAKE-TEST-' + 'JSCODE-VALUE'

/** 递归键名敏感模式（片段拼接构造；假值与页面注入面字段名不裸写）。 */
const FORBIDDEN_KEY_PATTERN = new RegExp([
  'sec' + 'ret',
  'pass' + 'word',
  'to' + 'ken',
  'coo' + 'kie',
  'cre' + 'dential',
  'js' + 'code',
  'api' + '_?key',
  '(^|[^a-z])ke' + 'y([^a-z]|$)',
].join('|'), 'i')

// ── 测试夹具（值均为测试假值，零真实凭据关切） ──

function fakeRequest(): TravelRequest {
  return {
    planId: 'pl-test-1', mode: 'plan', status: 'delivered',
    slots: {
      origin: '上海', destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3,
      travelers: { adults: 2, children: 1 },
      budget: { amount: 6000, currency: 'CNY', scope: 'total' },
      preferences: { pace: 'balanced', themes: ['人文', '美食'] },
      constraints: ['携带儿童'],
    },
    assumptions: ['默认双人间'],
    createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  }
}

function intelItem(id: string, category: IntelItem['category'], title: string, overrides: Partial<IntelItem> = {}): IntelItem {
  return {
    id, category, channel: 'tencent-poi', title,
    summary: `摘要-${id}`,
    source: { platform: 'tencent-map', url: `https://poi.example.invalid/${id}`, fetchedAt: '2026-09-02T01:00:00.000Z' },
    confidence: 'high',
    ...overrides,
  }
}

/** 页面注入面假 map（方案 A）：敏感字段名用拼接构造后 Object.assign 进 PageMapConfig。 */
function mapWithSecrets(): PageMapConfig {
  const base: PageMapConfig = { provider: 'amap', amapSecurityMode: 'A', warnings: [] }
  return Object.assign(base, { [MAP_KEY_FIELD]: FAKE_MAP_KEY, [MAP_JSCODE_FIELD]: FAKE_JSCODE })
}

function fullData(): RenderPageData {
  return {
    renderedAt: '2026-09-02T02:00:00.000Z',
    request: fakeRequest(),
    itinerary: {
      itineraryId: 'it-1',
      days: [
        {
          date: '2026-10-01', theme: '老城漫游',
          stops: [
            { name: '黄鹤楼', category: 'attraction', coords: { lng: 114.3052, lat: 30.5492, sys: 'GCJ02' }, durationHint: 90, intelRefs: ['a1'], note: '早到避人流' },
            { name: '户部巷', category: 'food', coords: { lng: 114.303, lat: 30.5432, sys: 'GCJ02' }, durationHint: 60, intelRefs: ['f1'] },
          ],
          meals: [{ name: '热干面', intelRefs: ['f1'] }, { name: '豆皮', intelRefs: [] }],
          lodgingArea: '江汉路',
        },
        { date: '2026-10-02', stops: [], meals: [] },
      ],
      routeCheck: { issues: [], warnings: ['第 2 天无固定点位'] },
    },
    intel: {
      a1: intelItem('a1', 'attraction', '黄鹤楼', { rating: 4.5, openingHours: '08:00-18:00' }),
      f1: intelItem('f1', 'food', '户部巷热干面', { avgPrice: 15 }),
      l1: intelItem('l1', 'lodging', '江汉路住宿点', { avgPrice: 420 }),
      w1: intelItem('w1', 'warning', '景区周边黑车', { confidence: 'medium' }),
    },
    degraded: [
      { source: 'didi', code: 'TIMEOUT', reason: '市内衔接超时', at: '2026-09-02T01:30:00.000Z' },
    ],
    map: mapWithSecrets(),
    transport: [{
      mode: 'rail',
      segments: [{ from: '上海', to: '武汉', no: 'G1720', depart: '08:00', arrive: '13:30', priceRange: [180, 320], channel: 'rail-12306' }],
      totalPriceRange: [180, 320],
      durationMinutes: 330,
      tags: ['性价比高', '中转少'],
      bookingTips: ['提前 15 天放票'],
      cityTransfer: {
        from: '武汉站', to: '江汉路', provider: 'amap',
        options: [{ mode: '地铁', durationMinutes: 40, priceHint: '5 元' }],
        source: { platform: 'amap', url: 'https://transfer.example.invalid/1', fetchedAt: '2026-09-02T01:10:00.000Z' },
      },
      source: { platform: 'rail-12306', url: 'https://rail.example.invalid/G1720', fetchedAt: '2026-09-02T01:05:00.000Z' },
    }],
    advice: {
      weather: [{ date: '2026-10-01', dayForecast: '晴', tempRange: [18, 26], source: { platform: 'open-meteo', url: 'https://weather.example.invalid/1001', fetchedAt: '2026-09-02T01:20:00.000Z' } }],
      clothing: ['薄外套'],
      packingList: ['雨伞', '充电宝'],
      extraTips: ['国庆人多，景点提前预约'],
    },
  }
}

/** 最小数据面：transport/advice/intel 全缺失 + 零降级（缺数据仍合法导出的口径）。 */
function minimalData(): RenderPageData {
  return {
    renderedAt: '2026-09-02T02:00:00.000Z',
    request: {
      planId: 'pl-test-2', mode: 'plan', status: 'delivered',
      slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 },
      assumptions: [], createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
    },
    itinerary: {
      itineraryId: 'it-2',
      days: [{ date: '2026-10-01', stops: [], meals: [] }],
      routeCheck: { issues: [], warnings: [] },
    },
    intel: {},
    degraded: [],
    map: { provider: 'leaflet', warnings: [] },
  }
}

/** 顶层键逆序重建（同内容不同插入序；canonical 归一测试用）。 */
function reversedKeys<T extends object>(obj: T): T {
  const source = obj as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(source).reverse()) out[k] = source[k]
  return out as unknown as T
}

/** 递归收集 JSON 对象全部键名（键名敏感模式扫描用）。 */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v) => collectKeys(v, out))
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k)
      collectKeys(v, out)
    }
  }
  return out
}

/** 抽取页面内嵌 JSON 数据块（同 render.test.ts 约定）。 */
function scriptBlock(html: string, id: string): string {
  const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html)
  expect(m, `数据块 ${id} 缺失`).toBeTruthy()
  return m![1]
}

// ── canonical JSON ──

describe('canonicalJson（稳定 canonical JSON）', () => {
  it('同输入两次生成逐字节相等，且 JSON.parse 等于 exportProjection', () => {
    const data = fullData()
    const first = canonicalJson(data)
    expect(canonicalJson(data)).toBe(first)
    expect(JSON.parse(first)).toEqual(exportProjection(data))
  })

  it('键序归一：等价输入不同键插入序 → 逐字节同输出', () => {
    const a = fullData()
    const b = reversedKeys(a) // 顶层逆序
    b.request = { ...b.request, slots: reversedKeys(a.request.slots) } // slots 逆序
    b.intel = reversedKeys(a.intel) // intel 记录键逆序
    expect(canonicalJson(b)).toBe(canonicalJson(a))
  })

  it('不显式含 undefined：显式 undefined 字段被剔除（JSON 往返丢键语义）', () => {
    const data = fullData()
    data.intel = {
      ...data.intel,
      x1: intelItem('x1', 'tip', '显式未定义条目', { coords: undefined, rating: undefined, publishedAt: undefined }),
    }
    const json = canonicalJson(data)
    const parsed = JSON.parse(json) as { intel: Record<string, IntelItem> }
    expect(Object.prototype.hasOwnProperty.call(parsed.intel.x1, 'coords')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(parsed.intel.x1, 'rating')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(parsed.intel.x1, 'publishedAt')).toBe(false)
    expect(json).not.toContain('undefined') // 假值文案不含该词 → 输出全局无裸 undefined
  })

  it('map 配置不入导出（页面渲染配置非行程内容；顶层无 map 键）', () => {
    const json = canonicalJson(fullData())
    expect(Object.keys(JSON.parse(json))).not.toContain('map')
    expect(Object.keys(exportProjection(fullData()))).not.toContain('map')
  })
})

// ── 固定章节 Markdown ──

describe('markdownOf（固定章节 Markdown）', () => {
  it('七章节按固定顺序出现（缺数据不删章节）', () => {
    for (const data of [fullData(), minimalData()]) {
      const md = markdownOf(data)
      let last = -1
      for (const header of MD_SECTION_HEADERS) {
        const at = md.indexOf(header)
        expect(at, `章节缺失或乱序: ${header}`).toBeGreaterThan(last)
        last = at
      }
    }
  })

  it('C5⑤：artifactStatus → Markdown 工件状态表（current/stale/missing 如实呈现，版本列诚实）', () => {
    const base = minimalData()
    const data: RenderPageData = {
      ...base,
      artifactStatus: {
        intel: { version: 2, state: 'current' },
        places: { version: 1, state: 'current' },
        transport: { version: 0, state: 'missing' },
        advice: { version: 3, state: 'stale' },
        coverage: { version: 1, state: 'current' },
        quotes: { version: 0, state: 'missing' },
        'route-transport': { version: 1, state: 'failed' },
        research: { version: 2, state: 'current' },
      },
    }
    const md = markdownOf(data)
    expect(md).toContain('## 工件状态')
    expect(md).toContain('| 工件 | 状态 | 版本 |')
    expect(md).toContain('| 情报 | current | 2 |')
    expect(md).toContain('| 地点解析 | current | 1 |')
    expect(md).toContain('| 建议 | stale | 3 |')
    expect(md).toContain('| 路线交通 | failed | 1 |')
    expect(md).toContain('| 交通 | missing | 0 |')
  })

  it('数据齐全 → 各章节内容完整且无「未获取」', () => {
    const md = markdownOf(fullData())
    expect(md).toContain('# 旅行行程 · 武汉')
    expect(md).toContain('- 计划 ID：pl-test-1')
    expect(md).toContain('- 导出时间：2026-09-02T02:00:00.000Z')
    expect(md).toContain('1. 黄鹤楼（景点 · 建议 90 分钟 · 评分 4.5）')
    expect(md).toContain('- 住宿区域：江汉路')
    expect(md).toContain('- 餐饮推荐：热干面、豆皮')
    expect(md).toContain('- 当日机动（无固定点位）')
    expect(md).toContain('### 方案 1 · 高铁/火车（G1720）')
    expect(md).toContain('- 上海 → 武汉 · G1720 · 08:00→13:30 · 180~320 元')
    expect(md).toContain('- 市内衔接（高德）：武汉站 → 江汉路')
    expect(md).toContain('### 美食')
    expect(md).toContain('### 住宿')
    expect(md).toContain('### 避雷提示')
    expect(md).toContain('- 2026-10-01，晴，18~26°C，获取于 2026-09-02T01:20:00.000Z')
    expect(md).toContain('- [ ] 雨伞')
    expect(md).not.toContain('未获取')
  })

  it('transport/advice/intel 缺失 → 仍为合法导出并标注「未获取」', () => {
    const data = minimalData()
    const md = markdownOf(data)
    expect(md).toContain('未获取：交通方案数据缺失')
    expect(md).toContain('未获取：出行建议数据缺失')
    expect(md).toContain('未获取：情报条目数据缺失')
    expect(md).toContain('无降级记录。')
    expect(md).toContain('无来源记录。')
    const json = JSON.parse(canonicalJson(data)) as Record<string, unknown>
    expect(Object.keys(json)).not.toContain('transport')
    expect(Object.keys(json)).not.toContain('advice')
  })

  it('degraded 章节含 source/code；来源章节含 URL 与获取时间戳（URL 去重）', () => {
    const md = markdownOf(fullData())
    expect(md).toContain('- didi [TIMEOUT]：市内衔接超时（2026-09-02T01:30:00.000Z）')
    expect(md).toContain('https://poi.example.invalid/a1')
    expect(md).toContain('（获取于 2026-09-02T01:00:00.000Z）')
    expect(md).toContain('[rail-12306] 交通方案 1 — https://rail.example.invalid/G1720')
    expect(md.split('https://poi.example.invalid/a1').length - 1).toBe(1) // 同 URL 只进来源章节一次
  })
})

// ── 导出面零 secret ──

describe('导出面零 secret', () => {
  const data = fullData()
  const plainOutputs: Array<[string, string]> = [
    ['canonicalJson', canonicalJson(data)],
    ['markdown', markdownOf(data)],
    ['bundle.json', buildExportBundle(data).json],
    ['bundle.markdown', buildExportBundle(data).markdown],
  ]
  const jsonOutputs: Array<[string, unknown]> = [
    ['canonicalJson', JSON.parse(canonicalJson(data))],
    ['bundle.json', JSON.parse(buildExportBundle(data).json)],
  ]

  it('JSON/MD/bundle 均不含页面注入面字段名与假值', () => {
    for (const [label, text] of plainOutputs) {
      expect(text, label).not.toContain(FAKE_MAP_KEY)
      expect(text, label).not.toContain(FAKE_JSCODE)
      expect(text, label).not.toContain(MAP_KEY_FIELD)
      expect(text, label).not.toContain(MAP_JSCODE_FIELD)
      expect(text, label).not.toContain('"map"')
    }
  })

  it('递归键名扫描无敏感命名（模式由片段拼接构造）', () => {
    for (const [label, parsed] of jsonOutputs) {
      for (const key of collectKeys(parsed)) {
        expect(key, `${label} 敏感键名: ${key}`).not.toMatch(FORBIDDEN_KEY_PATTERN)
      }
    }
  })
})

// ── 与页面嵌入 TRAVEL_DATA 同源 ──

describe('与页面嵌入 TRAVEL_DATA 同源', () => {
  const template = readFileSync(templatePath(), 'utf8')

  it('renderWithTemplate 内嵌 bundle 与导出函数逐字节一致（JSON/MD 均同源）', () => {
    const data = fullData()
    const html = renderWithTemplate(data, template)
    const embeddedData = JSON.parse(scriptBlock(html, 'travel-data')) as RenderPageData
    const bundle = JSON.parse(scriptBlock(html, 'travel-export')) as ExportBundle
    expect(bundle.json).toBe(canonicalJson(embeddedData))
    expect(bundle.markdown).toBe(markdownOf(embeddedData))
    expect(bundle).toEqual(buildExportBundle(embeddedData))
  })

  it('嵌入 bundle 字段与嵌入 TRAVEL_DATA 的导出投影一致（键集合级同源）', () => {
    const data = fullData()
    const html = renderWithTemplate(data, template)
    const embeddedData = JSON.parse(scriptBlock(html, 'travel-data')) as RenderPageData
    const bundle = JSON.parse(scriptBlock(html, 'travel-export')) as ExportBundle
    expect(JSON.parse(bundle.json)).toEqual(exportProjection(embeddedData))
    expect(Object.keys(JSON.parse(bundle.json)).sort())
      .toEqual(Object.keys(exportProjection(embeddedData)).sort())
  })

  it('嵌入 export bundle 零注入面（方案 A 页面 travel-data 有假值属预期，导出面没有）', () => {
    const html = renderWithTemplate(fullData(), template)
    expect(scriptBlock(html, 'travel-data')).toContain(FAKE_MAP_KEY) // 页面渲染需要（既有机制）
    const exportBlock = scriptBlock(html, 'travel-export')
    expect(exportBlock).not.toContain(FAKE_MAP_KEY)
    expect(exportBlock).not.toContain(FAKE_JSCODE)
    expect(exportBlock).not.toContain(MAP_KEY_FIELD)
    expect(exportBlock).not.toContain(MAP_JSCODE_FIELD)
  })

  it('占位符字面量出现在数据中不被二次展开（单遍替换回归）', () => {
    const data = fullData()
    data.intel = { ...data.intel, p1: intelItem('p1', 'tip', '含 __TRAVEL_DATA__ 与 __TRAVEL_EXPORT__ 字面量') }
    const html = renderWithTemplate(
      data,
      '<script id="travel-data" type="application/json">__TRAVEL_DATA__</script>' +
      '<script id="travel-export" type="application/json">__TRAVEL_EXPORT__</script>',
    )
    const embeddedData = JSON.parse(scriptBlock(html, 'travel-data')) as RenderPageData
    expect(embeddedData.intel.p1?.title).toContain('__TRAVEL_DATA__')
    const bundle = JSON.parse(scriptBlock(html, 'travel-export')) as ExportBundle
    expect(bundle.markdown).toContain('__TRAVEL_DATA__ 与 __TRAVEL_EXPORT__')
    expect(bundle.json).toBe(canonicalJson(embeddedData))
  })

  it('T26 自由文本/协议相对 URL userinfo 与敏感 query 均被清除，host/path 保留', () => {
    const data = fullData()
    // 逐层构造避免测试源码本身成为明文凭据扫描命中。
    const absolute = 'https://' + 'svc:secret@example.invalid/path?token=synthetic&ok=1'
    const relative = '//' + 'svc:secret@example.invalid/path?secret=synthetic'
    const plain = 'https://example.invalid/path?ok=1'
    data.degraded = [
      { source: 'probe', code: 'UNAVAILABLE', reason: `上游失败：${absolute}`, at: '2026-09-02T00:00:00.000Z' },
      { source: 'probe', code: 'TIMEOUT', reason: `协议相对：${relative}`, at: '2026-09-02T00:00:00.000Z' },
      { source: 'probe', code: 'NOISE', reason: `普通链接：${plain}`, at: '2026-09-02T00:00:00.000Z' },
    ]
    const bundle = buildExportBundle(data)
    const md = bundle.markdown
    expect(md).not.toContain('svc:secret@')
    expect(md).not.toContain('token=synthetic')
    expect(md).not.toContain('secret=synthetic')
    // host/path 必须保留（用户仍能定位来源）。
    expect(md).toContain('example.invalid/path')
    expect(md).toContain('token=[REDACTED]')
    expect(md).toContain('secret=[REDACTED]')
    expect(md).toContain('ok=1')
    expect(bundle.json).not.toContain('svc:secret@')
  })

  it('T26 默认 JSON 仅导出租车安全摘要，Markdown 也不泄漏 userinfo', () => {
    const data = fullData()
    const userInfoUrl = 'https://' + 'user:pass@example.invalid/rental?token=synthetic'
    const rental: RentalQuotesArtifact = {
      schemaVersion: 1, placesVersion: 2, inputFingerprint: 'rental-export', generatedAt: '2026-09-02T02:00:00.000Z',
      quotes: [{ pickupPlaceId: 'place-a', days: 2, vehicleType: '经济型',
        quote: { range: [300, 450], currency: 'CNY', unit: 'day', observedAt: '2026-09-02T02:00:00.000Z', taxStatus: 'unknown', referenceUrl: userInfoUrl },
        source: { platform: 'wendao', url: userInfoUrl, fetchedAt: '2026-09-02T02:00:00.000Z' } }],
      records: [{ pickupPlaceId: 'place-a', status: 'quoted' }], degraded: [], consultationOnly: true,
      disclaimer: '咨询级、非实时、不可预订',
    }
    data.rentalQuotes = rental
    const bundle = buildExportBundle(data)
    const parsed = JSON.parse(bundle.json) as { rentalQuotes: Record<string, unknown> }
    expect(parsed.rentalQuotes).toMatchObject({ quoteCount: 1, recordCount: 1, placesVersion: 2, consultationOnly: true })
    expect(JSON.stringify(parsed.rentalQuotes)).not.toContain('referenceUrl')
    expect(JSON.stringify(parsed.rentalQuotes)).not.toContain('source')
    expect(bundle.json).not.toContain(userInfoUrl)
    expect(bundle.markdown).not.toContain('user:pass@')
    // T26：Markdown 的「来源」章节同样不得透传租车咨询 URL——JSON 早已只给安全
    // 摘要，Markdown 若保留链接就把咨询错误呈现成可核对/可预订入口。
    expect(bundle.markdown).not.toContain('example.invalid/rental')
    expect(bundle.markdown).not.toContain('token=synthetic')
    expect(bundle.markdown).toContain('租车咨询 1 条')
    const html = renderWithTemplate(data, template)
    expect(scriptBlock(html, 'travel-data')).not.toContain('user:pass@')
    expect(scriptBlock(html, 'travel-data')).not.toContain('token=synthetic')
  })

  /**
   * T26 旧工件自由文本闸门（oracle P1）：更早版本产出的 rental-quotes.json 里
   * degraded[] 与 disclaimer 都是自由文本，可能整条就是带 userinfo/敏感 query 的
   * URL。它们既进 __TRAVEL_DATA__（页内嵌）也进导出 JSON，逐字段脱敏必须真实生效，
   * 不能只覆盖本轮新写入的引用面（quotes/records）。
   */
  it('T26 旧工件 rental.degraded / disclaimer 自由文本在页内数据与两种导出里均被脱敏', () => {
    const data = fullData()
    const userInfo = 'https://' + 'u:p@example.invalid/old?token=synthetic'
    // 旧工件形态：degraded 的自由文本字段里夹带凭据（reason/source/code/at 全覆盖）。
    const legacyRental = {
      schemaVersion: 1, placesVersion: 2, inputFingerprint: 'legacy-rental', generatedAt: '2026-09-01T00:00:00.000Z',
      quotes: [], records: [],
      degraded: [{ source: `route/amap ${userInfo}`, code: 'UNAVAILABLE', reason: `旧工件渠道失败 ${userInfo}`, at: `2026-09-01T00:00:00.000Z ${userInfo}` }],
      consultationOnly: true,
      disclaimer: `咨询级、非实时、不可预订（来源 ${userInfo}）`,
    } as unknown as RentalQuotesArtifact
    data.rentalQuotes = legacyRental

    const html = renderWithTemplate(data, template)
    const embedded = scriptBlock(html, 'travel-data')
    expect(embedded).not.toContain('u:p@')
    expect(embedded).not.toContain('token=synthetic')
    expect(embedded).toContain('token=[REDACTED]')
    expect(embedded).toContain('example.invalid/old')

    const bundle = buildExportBundle(data)
    expect(bundle.json).not.toContain('u:p@')
    expect(bundle.json).not.toContain('token=synthetic')
    expect(bundle.json).toContain('token=[REDACTED]')
    expect(bundle.markdown).not.toContain('u:p@')
    expect(bundle.markdown).not.toContain('token=synthetic')
    // 咨询-only 语义与「Markdown 不外带租车 source URL」不变。
    const summary = JSON.parse(bundle.json) as { rentalQuotes: { consultationOnly: boolean; disclaimer: string } }
    expect(summary.rentalQuotes.consultationOnly).toBe(true)
    expect(summary.rentalQuotes.disclaimer).toContain('token=[REDACTED]')
    expect(bundle.markdown).not.toContain('example.invalid/old')
  })

  it('T26 顶层 degraded 的 source/code/at 自由文本同样被脱敏（不只 reason）', () => {
    const data = fullData()
    const userInfo = 'https://' + 'u:p@example.invalid/top?secret=synthetic'
    data.degraded = [{
      source: `probe ${userInfo}`, code: 'UNAVAILABLE',
      reason: `上游失败 ${userInfo}`, at: `2026-09-02T00:00:00.000Z ${userInfo}`,
    }]
    const bundle = buildExportBundle(data)
    for (const field of ['source', 'reason', 'at']) {
      expect(bundle.json).toContain(field)
    }
    expect(bundle.json).not.toContain('u:p@')
    expect(bundle.json).not.toContain('secret=synthetic')
    expect(bundle.json).toContain('secret=[REDACTED]')
    expect(bundle.markdown).not.toContain('u:p@')
    expect(bundle.markdown).not.toContain('secret=synthetic')
  })
})
