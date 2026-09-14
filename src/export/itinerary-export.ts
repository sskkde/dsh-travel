/**
 * itinerary-export.ts —— 行程导出（M3.2 / FR-7 详细要求 4：页面提供行程数据导出入口）。
 *
 * 以 render.ts 的 RenderPageData 为**唯一真源**，生成：
 * - canonical JSON：对象键递归按字典序排序、显式跳过 undefined 值（不落 `"k":undefined`）、
 *   数组保序 → 同输入逐字节同输出；
 * - 固定章节 Markdown：总览 / 每日行程 / 交通 / 住宿美食避雷 / 建议 / 数据降级说明（degraded）
 *   / 来源，章节顺序稳定；某数据缺失（transport/advice/intel 未获取）时仍产出合法导出并
 *   明确标注「未获取」；degraded 章节含 source/code；来源章节含 URL 与获取时间戳。
 *
 * 字段映射决策（同源一致性）：
 * - 导出投影 = RenderPageData 剔除 map 后的同源投影（exportProjection，字段名与页面内嵌
 *   TRAVEL_DATA 完全一致，不新增第二套 tool/route 序列化）；map 是页面渲染配置
 *   （provider / 双 loader / 降级 warning），非行程内容；
 * - map.amapKey / map.amapJscode 属页面注入面（方案 A 明文注入载体），随 map 整体排除在
 *   导出之外 → 导出零 secret（不含 settings/credentials/凭据字段）；
 * - B 模式 jscode 剥离沿用 render.ts 既有脱敏投影；导出面本就无 map，天然零明文。
 *
 * 嵌入方式：render.ts 渲染时调用 buildExportBundle，把 {json, markdown} 逐字节内嵌到
 * `<script id="travel-export" type="application/json">`；页面「下载 JSON / 下载 Markdown」
 * 按钮用 Blob + a[download] 直接下载该字符串（不经二次序列化，与导出函数逐字节一致）。
 */
import { redactSensitiveText, redactSensitiveUrl } from '../adapters/search.js'
import type { CostArtifact, IntelItem, RentalQuoteRecordStatus, RentalQuotesArtifact, TransportOption } from '../models/types.js'
import type { RenderPageData } from '../render/render.js'

/** 导出 bundle：两个字符串即下载文件的逐字节内容。 */
export interface ExportBundle {
  /** canonical JSON 字符串（下载 .json 的逐字节内容）。 */
  json: string
  /** Markdown 字符串（下载 .md 的逐字节内容）。 */
  markdown: string
}

/** 导出投影：RenderPageData 剔除 map 后的同源结构（字段名与内嵌数据一致）。 */
/** JSON 导出的租车安全摘要：不透传 referenceUrl/source.url 等完整咨询记录。 */
export interface RentalQuotesExportSummary {
  quoteCount: number
  recordCount: number
  statusCounts: Record<RentalQuoteRecordStatus, number>
  placesVersion: number
  consultationOnly: true
  disclaimer: string
}

export interface ExportPayload {
  renderedAt: string
  request: RenderPageData['request']
  itinerary: RenderPageData['itinerary']
  intel: RenderPageData['intel']
  degraded: RenderPageData['degraded']
  transport?: RenderPageData['transport']
  advice?: RenderPageData['advice']
  rentalQuotes?: RentalQuotesExportSummary
  cost?: CostArtifact
  artifactStatus?: RenderPageData['artifactStatus']
}

/** Markdown 固定章节标题（顺序即导出顺序；测试与上游可作锚点引用）。 */
export const MD_SECTION_HEADERS = [
  '## 总览',
  '## 每日行程',
  '## 交通',
  '## 住宿美食避雷',
  '## 建议',
  '## 数据降级说明（degraded）',
  '## 来源',
  '## 工件状态',
] as const

/** 数据缺失标注用词（QA 口径：缺失仍合法导出并明确标注）。 */
const NOT_FETCHED = '未获取'

const STOP_CATEGORY_LABEL: Record<string, string> = {
  attraction: '景点', lodging: '住宿', food: '美食', transportLocal: '市内交通',
}
const MODE_LABEL: Record<string, string> = { rail: '高铁/火车', flight: '飞机', bus: '大巴' }
const CITY_PROVIDER_LABEL: Record<string, string> = { amap: '高德', didi: '滴滴', search: '搜索' }

/** 租车导出摘要：保留可解释计数/版本/咨询语义，丢弃 URL、来源与凭据载体。 */
function rentalQuotesSummary(artifact: RentalQuotesArtifact): RentalQuotesExportSummary {
  const statusCounts: Record<RentalQuoteRecordStatus, number> = {
    quoted: 0,
    skipped_missing_stay_context: 0,
    blocked: 0,
    rejected: 0,
  }
  for (const record of artifact.records ?? []) {
    if (record.status in statusCounts) statusCounts[record.status] += 1
  }
  return {
    quoteCount: Array.isArray(artifact.quotes) ? artifact.quotes.length : 0,
    recordCount: Array.isArray(artifact.records) ? artifact.records.length : 0,
    statusCounts,
    placesVersion: artifact.placesVersion,
    consultationOnly: true,
    // 旧工件（更早版本产出的 rental-quotes.json，或非 GUI 写入）的 disclaimer 是
    // 自由文本，可能整条就是一个带 userinfo/敏感 query 的 URL；它既进 JSON 导出也
    // 进页面内嵌 bundle，必须先过脱敏，而不是信任「上游已经清过」。
    disclaimer: safeDisclaimer(artifact.disclaimer),
  }
}

/**
 * 同源导出投影：剔除 map（页面渲染配置，含 amapKey/amapJscode 注入面），
 * 其余字段与 RenderPageData 一致；租车改为无 URL 的安全摘要；可选字段条件展开。
 */
export function exportProjection(data: RenderPageData): ExportPayload {
  return {
    renderedAt: data.renderedAt,
    request: data.request,
    itinerary: data.itinerary,
    intel: data.intel,
    // degraded 与 Markdown 同口径脱敏：reason 是上游错误消息的自由文本，
    // 最可能夹带带 userinfo/敏感 query 的 URL；JSON 不是「安全通道」。
    degraded: (data.degraded ?? []).map((entry) => redactDegradedEntry(entry)),
    ...(data.transport !== undefined ? { transport: data.transport } : {}),
    ...(data.advice !== undefined ? { advice: data.advice } : {}),
    ...(data.rentalQuotes !== undefined ? { rentalQuotes: rentalQuotesSummary(data.rentalQuotes) } : {}),
    ...(data.cost !== undefined ? { cost: data.cost } : {}),
    ...(data.artifactStatus !== undefined ? { artifactStatus: data.artifactStatus } : {}),
  }
}

/**
 * canonical 化：对象键递归按字典序排序（Object.keys().sort()，UTF-16 码元序，确定性）；
 * 对象属性位 undefined 剔除（不显式含 undefined）；数组元素 undefined → null
 * （与 JSON.stringify 语义对齐）；数组保序；原始值原样交 JSON.stringify 序列化。
 */
function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const v = source[key]
      if (v === undefined) continue
      out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

/**
 * rental 导出摘要的 disclaimer 脱敏：旧工件的 disclaimer 是自由文本，可能整条就是
 * 带 userinfo/敏感 query 的 URL（形如 https://<user>:<pass>@host?token=<...>）；
 * 它既进 JSON 导出也
 * 进页面内嵌 bundle，一律先过 redactSensitiveText，不信任上游已清。
 */
function safeDisclaimer(raw: string): string {
  return redactSensitiveText(raw)
}

/**
 * degraded 条目脱敏（source/code/reason/at 逐字段过 redactSensitiveText）。
 *
 * code 是闭合枚举（DegradedCode），脱敏只会改写其中的凭据形态文本，不改变枚举
 * 语义，故按原值回写以保住类型（不把它放宽成 string）。
 */
function redactDegradedEntry(entry: RenderPageData['degraded'][number]): RenderPageData['degraded'][number] {
  return {
    ...entry,
    source: redactSensitiveText(entry.source),
    code: redactSensitiveText(entry.code) as RenderPageData['degraded'][number]['code'],
    reason: redactSensitiveText(entry.reason),
    ...(typeof entry.at === 'string' ? { at: redactSensitiveText(entry.at) } : {}),
  }
}

/** 稳定 canonical JSON：同输入（含键序不同的等价输入）→ 逐字节同输出。 */
export function canonicalJson(data: RenderPageData): string {
  return JSON.stringify(canonicalize(exportProjection(data)))
}

/** 单行化：换行折叠为空格（防 Markdown 行结构注入），其余内容原样。 */
/**
 * 单行化 + 凭据脱敏：导出面（含 JSON 摘要之外的 Markdown 全部自由文本字段，
 * 如 degraded.reason）都经此投影。任何字段写进导出前都先清 URL userinfo 与敏感
 * query——degrated.reason 这类来自上游错误消息的自由文本最可能夹带带凭据 URL。
 */
function oneLine(v: unknown): string {
  return redactSensitiveText(String(v ?? '').replace(/\r/g, '').replace(/\n+/g, ' ').trim())
}

function priceRangeText(range?: [number, number]): string {
  return Array.isArray(range) && range.length === 2 ? `${range[0]}~${range[1]} 元` : ''
}

/** 标题块（导出时间沿用 renderedAt，不另生成时间戳 → 同输入同输出）。 */
function titleBlock(data: RenderPageData): string[] {
  const slots = data.request.slots
  return [
    `# 旅行行程 · ${oneLine(slots.destination) || '未指定目的地'}`,
    '',
    `- 计划 ID：${oneLine(data.request.planId)}`,
    `- 导出时间：${oneLine(data.renderedAt)}`,
    '- 来源说明：由 dsh-travel 行程页内嵌数据同源导出；地图引擎配置不入导出',
  ]
}

function overviewBlock(data: RenderPageData): string[] {
  const slots = data.request.slots
  const ls: string[] = [MD_SECTION_HEADERS[0], '']
  ls.push(`- 目的地：${oneLine(slots.destination) || '未指定'}`)
  if (slots.origin) ls.push(`- 出发地：${oneLine(slots.origin)}`)
  if (slots.dateStart || slots.dateEnd) {
    ls.push(`- 日期：${oneLine(slots.dateStart) || '?'} ~ ${oneLine(slots.dateEnd) || '?'}${slots.days != null ? `（共 ${slots.days} 天）` : ''}`)
  } else if (slots.days != null) {
    ls.push(`- 天数：${slots.days} 天`)
  }
  const travelerBits: string[] = []
  if (slots.travelers?.adults) travelerBits.push(`成人 ${slots.travelers.adults}`)
  if (slots.travelers?.children) travelerBits.push(`儿童 ${slots.travelers.children}`)
  if (slots.travelers?.seniors) travelerBits.push(`老人 ${slots.travelers.seniors}`)
  if (travelerBits.length > 0) ls.push(`- 出行人数：${travelerBits.join(' · ')}`)
  if (slots.budget?.amount != null) {
    ls.push(`- 预算：${slots.budget.amount} ${slots.budget.currency ?? 'CNY'}（${slots.budget.scope === 'perPerson' ? '每人' : '总计'}）`)
  }
  if (data.rentalQuotes !== undefined) {
    ls.push(`- 租车咨询：${data.rentalQuotes.quotes.length} 条（咨询级、非实时、不可预订）`)
  }
  if (data.cost !== undefined) {
    ls.push(`- 成本摘要：${data.cost.total.min}~${data.cost.total.max} ${oneLine(data.cost.total.currency)}`)
    for (const warning of data.cost.warnings) ls.push(`  - 成本提示：${oneLine(warning)}`)
  }
  if (slots.preferences?.themes?.length) ls.push(`- 主题偏好：${slots.preferences.themes.map(oneLine).join('、')}`)
  if (slots.preferences?.diet?.length) ls.push(`- 饮食偏好：${slots.preferences.diet.map(oneLine).join('、')}`)
  if (slots.preferences?.pace) ls.push(`- 节奏：${oneLine(slots.preferences.pace)}`)
  if (slots.constraints?.length) ls.push(`- 特殊约束：${slots.constraints.map(oneLine).join('；')}`)
  if (data.request.assumptions.length > 0) ls.push(`- 默认假设：${data.request.assumptions.map(oneLine).join('；')}`)
  return ls
}

function dailyBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[1], '']
  const days = data.itinerary.days
  if (days.length === 0) {
    ls.push(`${NOT_FETCHED}：行程天数据缺失。`)
    return ls
  }
  days.forEach((day, di) => {
    const head = [`第 ${di + 1} 天`, oneLine(day.date), oneLine(day.theme)].filter((p) => p.length > 0)
    ls.push(`### ${head.join(' · ')}`, '')
    if (day.lodgingArea) ls.push(`- 住宿区域：${oneLine(day.lodgingArea)}`, '')
    if (day.stops.length === 0) ls.push('- 当日机动（无固定点位）')
    day.stops.forEach((stop, si) => {
      const ref = stop.intelRefs.length > 0 ? data.intel[stop.intelRefs[0]] : undefined
      const meta: string[] = [STOP_CATEGORY_LABEL[stop.category] ?? stop.category]
      if (stop.durationHint != null) meta.push(`建议 ${stop.durationHint} 分钟`)
      if (ref?.rating != null) meta.push(`评分 ${ref.rating}`)
      if (ref?.avgPrice != null) meta.push(`人均 ${ref.avgPrice} 元`)
      ls.push(`${si + 1}. ${oneLine(stop.name)}（${meta.join(' · ')}）`)
      if (ref?.summary) ls.push(`   ${oneLine(ref.summary)}`)
      if (stop.note) ls.push(`   备注：${oneLine(stop.note)}`)
    })
    if (day.meals.length > 0) ls.push(`- 餐饮推荐：${day.meals.map((m) => oneLine(m.name)).join('、')}`)
    ls.push('')
  })
  while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop()
  return ls
}

function transportOptionLines(option: TransportOption, index: number): string[] {
  const ls: string[] = []
  const firstNo = option.segments?.[0]?.no
  ls.push(`### 方案 ${index + 1} · ${MODE_LABEL[option.mode] ?? option.mode}${firstNo ? `（${oneLine(firstNo)}）` : ''}`, '')
  for (const seg of option.segments ?? []) {
    const bits = [`${oneLine(seg.from)} → ${oneLine(seg.to)}`]
    if (seg.no) bits.push(oneLine(seg.no))
    if (seg.depart || seg.arrive) bits.push(`${oneLine(seg.depart)}→${oneLine(seg.arrive)}`)
    if (seg.priceRange && seg.priceRange.length === 2) bits.push(priceRangeText(seg.priceRange))
    ls.push(`- ${bits.join(' · ')}`)
  }
  if (option.durationMinutes != null) ls.push(`- 用时：约 ${option.durationMinutes} 分钟`)
  if (option.totalPriceRange) ls.push(`- 全程参考价：${priceRangeText(option.totalPriceRange)}`)
  if (option.tags?.length) ls.push(`- 特点：${option.tags.map(oneLine).join('、')}`)
  if (option.cityTransfer) {
    const ct = option.cityTransfer
    ls.push(`- 市内衔接（${CITY_PROVIDER_LABEL[ct.provider] ?? ct.provider}）：${oneLine(ct.from)} → ${oneLine(ct.to)}`)
    for (const opt of ct.options ?? []) {
      const bits = [oneLine(opt.mode)]
      if (opt.durationMinutes != null) bits.push(`约 ${opt.durationMinutes} 分钟`)
      if (opt.priceHint) bits.push(oneLine(opt.priceHint))
      ls.push(`  - ${bits.join(' · ')}`)
    }
  }
  if (option.bookingTips?.length) ls.push(`- 购票提示：${option.bookingTips.map(oneLine).join('；')}`)
  if (option.source?.url) {
    ls.push(`- 来源：${oneLine(option.source.platform)}（获取于 ${oneLine(option.source.fetchedAt)}）`)
  }
  return ls
}

function transportBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[2], '']
  const transport = data.transport
  if (!transport || transport.length === 0) {
    ls.push(`${NOT_FETCHED}：交通方案数据缺失（未执行交通研究或 transport.json 未生成/为空）。`)
    return ls
  }
  transport.forEach((option, i) => ls.push(...transportOptionLines(option, i), ''))
  while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop()
  return ls
}

function lodgingFoodBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[3], '']
  const items: IntelItem[] = Object.keys(data.intel).map((id) => data.intel[id])
  const groups: Array<{ label: string; items: IntelItem[] }> = [
    { label: '美食', items: items.filter((it) => it.category === 'food') },
    { label: '住宿', items: items.filter((it) => it.category === 'lodging') },
    { label: '避雷提示', items: items.filter((it) => it.category === 'warning') },
  ]
  let any = false
  for (const group of groups) {
    if (group.items.length === 0) continue
    any = true
    ls.push(`### ${group.label}`, '')
    for (const it of group.items) {
      const bits: string[] = []
      if (it.rating != null) bits.push(`评分 ${it.rating}`)
      if (it.avgPrice != null) bits.push(`人均 ${it.avgPrice} 元`)
      if (it.openingHours) bits.push(`营业 ${oneLine(it.openingHours)}`)
      const head = bits.length > 0 ? `${oneLine(it.title)}（${bits.join(' · ')}）` : oneLine(it.title)
      ls.push(`- ${head}${it.summary ? `：${oneLine(it.summary)}` : ''}`)
      if (it.source?.url) ls.push(`  - 来源：${oneLine(it.source.platform)}（获取于 ${oneLine(it.source.fetchedAt)}）`)
      if (it.conflictsWith?.length) ls.push(`  - 冲突条目：${it.conflictsWith.map(oneLine).join('、')}`)
    }
    ls.push('')
  }
  if (!any) ls.push(`${NOT_FETCHED}：情报条目数据缺失（美食/住宿/避雷暂无）。`)
  else while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop()
  return ls
}

function adviceBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[4], '']
  const advice = data.advice
  const entryCount = advice
    ? (advice.weather?.length ?? 0) + (advice.clothing?.length ?? 0)
      + (advice.packingList?.length ?? 0) + (advice.extraTips?.length ?? 0)
    : 0
  if (!advice || entryCount === 0) {
    ls.push(`${NOT_FETCHED}：出行建议数据缺失（未执行建议研究或 advice.json 未生成/为空）。`)
    return ls
  }
  if (advice.weather?.length) {
    ls.push('### 天气', '')
    for (const w of advice.weather) {
      const bits = [oneLine(w.date)]
      if (w.dayForecast) bits.push(oneLine(w.dayForecast))
      if (w.tempRange && w.tempRange.length === 2) bits.push(`${w.tempRange[0]}~${w.tempRange[1]}°C`)
      if (w.beyondForecastWindow) bits.push('超预报窗口（气候概况）')
      if (w.source?.fetchedAt) bits.push(`获取于 ${oneLine(w.source.fetchedAt)}`)
      ls.push(`- ${bits.join('，')}`)
    }
    ls.push('')
  }
  if (advice.clothing?.length) {
    ls.push('### 穿衣', '')
    for (const c of advice.clothing) ls.push(`- ${oneLine(c)}`)
    ls.push('')
  }
  if (advice.packingList?.length) {
    ls.push('### 物品清单', '')
    for (const p of advice.packingList) ls.push(`- [ ] ${oneLine(p)}`)
    ls.push('')
  }
  if (advice.extraTips?.length) {
    ls.push('### 小贴士', '')
    for (const t of advice.extraTips) ls.push(`- ${oneLine(t)}`)
    ls.push('')
  }
  while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop()
  return ls
}

function degradedBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[5], '']
  const degraded = data.degraded ?? []
  if (degraded.length === 0) {
    ls.push('无降级记录。')
    return ls
  }
  for (const d of degraded) {
    ls.push(`- ${oneLine(d.source)} [${oneLine(d.code)}]：${oneLine(d.reason)}（${oneLine(d.at)}）`)
  }
  return ls
}

/** 来源章节：URL 去重（首个出现保留），每条含平台/条目标签/URL/获取时间戳。 */
function sourcesBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[6], '']
  const seen = new Set<string>()
  const rows: string[] = []
  const add = (platform: string | undefined, label: string, url: string | undefined, fetchedAt: string | undefined): void => {
    if (!url) return
    const safeUrl = redactSensitiveUrl(url)
    if (seen.has(safeUrl)) return
    seen.add(safeUrl)
    rows.push(`- [${oneLine(platform) || '未知来源'}] ${label} — ${safeUrl}${fetchedAt ? `（获取于 ${oneLine(fetchedAt)}）` : ''}`)
  }
  for (const id of Object.keys(data.intel)) {
    const it = data.intel[id]
    add(it.source?.platform, oneLine(it.title), it.source?.url, it.source?.fetchedAt)
  }
  ;(data.transport ?? []).forEach((option, i) => {
    add(option.source?.platform, `交通方案 ${i + 1}`, option.source?.url, option.source?.fetchedAt)
    if (option.cityTransfer) {
      add(option.cityTransfer.source?.platform, `交通方案 ${i + 1} 市内衔接`, option.cityTransfer.source?.url, option.cityTransfer.source?.fetchedAt)
    }
  })
  for (const w of data.advice?.weather ?? []) {
    add(w.source?.platform, `天气 ${oneLine(w.date)}`, w.source?.url, w.source?.fetchedAt)
  }
  // 租车咨询：来源章节保留可解释的计数/平台/获取时间，但**不透传**其 URL——
  // 咨询深链常带渠道会话参数，任何形式的透传（含脱敏后）都会把咨询错误地呈现成
  // 可核对/可预订入口。JSON 侧同样只有 rentalQuotesSummary（无 URL/source）。
  const rentalQuotes = data.rentalQuotes?.quotes ?? []
  if (rentalQuotes.length > 0) {
    const platforms = Array.from(new Set(rentalQuotes.map((q) => oneLine(q.source?.platform)).filter((p) => p !== '')))
    const fetchedAt = rentalQuotes.map((q) => q.source?.fetchedAt).filter((t): t is string => typeof t === 'string' && t !== '').sort()[0]
    rows.push(`- [${platforms.join('/') || '未知来源'}] 租车咨询 ${rentalQuotes.length} 条（咨询级、非实时、不可预订；URL 不外带）${fetchedAt !== undefined ? `（获取于 ${oneLine(fetchedAt)}）` : ''}`)
  }
  if (rows.length === 0) {
    ls.push('无来源记录。')
    return ls
  }
  ls.push(...rows)
  return ls
}

/** 工件状态章节（C5⑤）：各阶段工件版本/健康度表格（current/stale/failed/empty/missing）；无记录 → 明确标注。 */
function artifactStatusBlock(data: RenderPageData): string[] {
  const ls: string[] = [MD_SECTION_HEADERS[7], '']
  const st = data.artifactStatus
  const keys = st !== undefined ? Object.keys(st) : []
  if (keys.length === 0) {
    ls.push('无工件状态记录。')
    return ls
  }
  const LABEL: Record<string, string> = {
    intel: '情报', research: '研究', places: '地点解析', transport: '交通',
    advice: '建议', quotes: '住宿报价', rental: '租车报价', cost: '成本汇总', 'route-transport': '路线交通', coverage: '区域覆盖',
  }
  ls.push('| 工件 | 状态 | 版本 |')
  ls.push('| --- | --- | --- |')
  for (const k of keys) {
    const s = (st ?? {})[k]
    const state = oneLine(s?.state ?? 'missing')
    const version = s !== undefined && typeof s.version === 'number' ? String(s.version) : '—'
    ls.push(`| ${LABEL[k] ?? k} | ${state} | ${version} |`)
  }
  return ls
}

/** 固定章节 Markdown：章节集合与顺序恒定（缺数据 → 章节内标注「未获取」，不删章节）。 */
export function markdownOf(data: RenderPageData): string {
  const blocks = [
    titleBlock(data),
    overviewBlock(data),
    dailyBlock(data),
    transportBlock(data),
    lodgingFoodBlock(data),
    adviceBlock(data),
    degradedBlock(data),
    sourcesBlock(data),
    artifactStatusBlock(data),
  ]
  return blocks.map((ls) => ls.join('\n')).join('\n\n') + '\n'
}

/** 导出 bundle：render.ts 渲染时调用并内嵌页面；下载按钮逐字节取用。 */
export function buildExportBundle(data: RenderPageData): ExportBundle {
  return { json: canonicalJson(data), markdown: markdownOf(data) }
}
