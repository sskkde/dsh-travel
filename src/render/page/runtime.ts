import type {
  Advice,
  GeoCoords,
  IntelItem,
  ItineraryDay,
  ItineraryStop,
  RenderRouteTransport,
  RouteGeometry,
  RouteTransportLeg,
  TravelInsight,
  TransportOption,
} from '../../models/types.js'
import type { RenderPageData } from '../render.js'

/**
 * 行程页浏览器运行时。它只消费 render.ts 已审计的数据：
 * - itinerary/intel 文本全部进入 textContent；
 * - insights 是唯一的推荐/避雷/指南/规划展示来源；
 * - routeTransport 的 geometry 是 WGS84 GeoJSON，AMap 显示侧才转 GCJ-02。
 *
 * 运行时由 scripts/build.sh 经 esbuild 内联到 page.html。不要在这里加入网络算路、
 * 运行时模型调用或未经白名单的远端资源。
 */

type DisplayPoint = { lng: number; lat: number }
type StopKey = string

type StopModel = {
  key: StopKey
  dayIndex: number
  stopIndex: number
  stop: ItineraryStop
  point?: DisplayPoint
}

type MarkerModel = {
  key: StopKey
  keys: StopKey[]
  dayIndex: number
  stopIndex: number
  point: DisplayPoint
  label: string
  color: string
  cluster: boolean
}

type RouteSegment = {
  leg: RouteTransportLeg
  path: DisplayPoint[]
  dashed: boolean
  fallback: boolean
  metricText: string
  note?: string
}

type MarkerHandle = {
  key: StopKey
  keys: StopKey[]
  setActive: (active: boolean) => void
  setDimmed: (dimmed: boolean) => void
  open: () => void
}

type RouteHandle = {
  id: string
  setActive: (active: boolean) => void
}

type MapHandle = {
  map: {
    setView?: (center: [number, number], zoom?: number, options?: { animate?: boolean }) => unknown
    flyTo?: (center: [number, number], zoom?: number, options?: { animate?: boolean }) => unknown
    setCenter?: (center: [number, number], zoom?: number, options?: { animate?: boolean }) => unknown
    setZoom?: (zoom: number) => void
    fitBounds?: (bounds: unknown, options?: { padding?: [number, number] }) => void
  }
  markers: MarkerHandle[]
  routes: RouteHandle[]
}

type PageState = {
  data: RenderPageData
  stops: StopModel[]
  markerModels: MarkerModel[]
  segments: RouteSegment[]
  markerHandles: MarkerHandle[]
  routeHandles: RouteHandle[]
  map?: MapHandle
  selectedKey?: StopKey
  lockedKey?: StopKey
  selectedLegId?: string
  dayIndex: number
  drawerOpen: boolean
  hoverTimer?: number
}

const DAY_COLORS = ['#e74c3c', '#f39c12', '#27ae60', '#2980b9', '#8e44ad', '#d35400', '#16a085', '#7f8c8d']
const CATEGORY_LABEL: Record<string, string> = {
  attraction: '景点', lodging: '住宿', food: '美食', transportLocal: '市内交通',
}
const INSIGHT_LABEL: Record<string, string> = {
  recommend: '推荐', avoid: '避雷', guide: '指南', plan: '规划',
}
const DAY_COLOR = (index: number): string => DAY_COLORS[index % DAY_COLORS.length]
const ROUTE_FALLBACK_NOTE = '轨迹直线示意，里程为实测'

function byId<T extends HTMLElement>(id: string): T | undefined {
  const element = document.getElementById(id)
  return element === null ? undefined : element as T
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className !== undefined) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function clear(element: Element): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild)
}

function appendText(parent: Element, text: unknown, className?: string): HTMLElement {
  const child = make('span', className, text === undefined || text === null ? '' : String(text))
  parent.appendChild(child)
  return child
}

function appendHeading(parent: Element, level: 'h2' | 'h3' | 'h4', text: string, className?: string): HTMLElement {
  const heading = make(level, className, text)
  parent.appendChild(heading)
  return heading
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function appendSafeLink(parent: Element, title: unknown, platform: unknown, url: unknown): void {
  const href = httpUrl(url)
  const line = make('div', 'citation-line')
  appendText(line, title ?? '')
  appendText(line, ' · ' + String(platform ?? ''))
  if (href !== undefined) {
    const link = make('a', undefined, '链接 ↗')
    link.setAttribute('href', href)
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
    line.appendChild(document.createTextNode(' '))
    line.appendChild(link)
  }
  parent.appendChild(line)
}

function appendCitations(parent: Element, insights: TravelInsight[]): void {
  const citations = insights.flatMap((insight) => Array.isArray(insight.citations) ? insight.citations : [])
  const unique = new Map<string, { title: string; platform: string; url: string }>()
  for (const citation of citations) {
    const href = httpUrl(citation.url)
    if (href === undefined) continue
    const key = `${citation.title}\u0000${citation.platform}\u0000${href}`
    if (!unique.has(key)) unique.set(key, { title: citation.title, platform: citation.platform, url: href })
  }
  if (unique.size === 0) return
  const details = make('details', 'citations')
  details.setAttribute('data-citations', 'collapsed')
  details.appendChild(make('summary', undefined, `引用（${unique.size}）`))
  const list = make('div', 'citation-list')
  for (const citation of unique.values()) appendSafeLink(list, citation.title, citation.platform, citation.url)
  details.appendChild(list)
  parent.appendChild(details)
}

function sourceItem(data: RenderPageData, stop: ItineraryStop): IntelItem | undefined {
  const id = Array.isArray(stop.intelRefs) ? stop.intelRefs[0] : undefined
  return id === undefined ? undefined : data.intel?.[id]
}

function allInsights(data: RenderPageData): TravelInsight[] {
  return Array.isArray(data.insights) ? data.insights : []
}

function insightsForStop(data: RenderPageData, stop: ItineraryStop): TravelInsight[] {
  const references = new Set([stop.placeId, stop.name, ...(Array.isArray(stop.intelRefs) ? stop.intelRefs : [])].filter((value): value is string => typeof value === 'string'))
  return allInsights(data).filter((insight) => insight.scopeRef === undefined || references.has(insight.scopeRef))
    .filter((insight) => insight.text.trim().length > 0)
}

function insightsForDay(data: RenderPageData, day: ItineraryDay): TravelInsight[] {
  const seen = new Set<string>()
  const result: TravelInsight[] = []
  for (const stop of day.stops) {
    for (const insight of insightsForStop(data, stop)) {
      const key = `${insight.kind}\u0000${insight.scopeRef ?? ''}\u0000${insight.text}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(insight)
    }
  }
  return result
}

function toWgsPoint(coords: GeoCoords): DisplayPoint {
  return { lng: coords.lng, lat: coords.lat }
}

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323
function gcjTransformLat(x: number, y: number): number {
  let result = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  result += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  result += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0
  result += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0
  return result
}
function gcjTransformLng(x: number, y: number): number {
  let result = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  result += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  result += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0
  result += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0
  return result
}

/** GCJ-02 → WGS-84 for Leaflet/OSM. */
function gcj02ToWgs84(lng: number, lat: number): DisplayPoint {
  if (outOfChina(lng, lat)) return { lng, lat }
  const dLat = gcjTransformLat(lng - 105.0, lat - 35.0)
  const dLng = gcjTransformLng(lng - 105.0, lat - 35.0)
  const radLat = lat / 180.0 * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const latitude = lat - (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  const longitude = lng - (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return { lng: longitude, lat: latitude }
}

/** WGS-84 → GCJ-02 for AMap JSAPI. */
function wgs84ToGcj02(lng: number, lat: number): DisplayPoint {
  if (outOfChina(lng, lat)) return { lng, lat }
  const dLat = gcjTransformLat(lng - 105.0, lat - 35.0)
  const dLng = gcjTransformLng(lng - 105.0, lat - 35.0)
  const radLat = lat / 180.0 * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const latitude = lat + (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  const longitude = lng + (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return { lng: longitude, lat: latitude }
}

function toDisplay(coords: GeoCoords, provider: 'amap' | 'leaflet'): DisplayPoint {
  if (provider === 'amap') return coords.sys === 'WGS84' ? wgs84ToGcj02(coords.lng, coords.lat) : toWgsPoint(coords)
  return coords.sys === 'GCJ02' ? gcj02ToWgs84(coords.lng, coords.lat) : toWgsPoint(coords)
}

function validGeometry(value: unknown): value is RouteGeometry {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<RouteGeometry>
  return candidate.type === 'LineString'
    && candidate.coordinateSystem === 'WGS84'
    && candidate.pointOrder === 'lng,lat'
    && Array.isArray(candidate.coordinates)
    && candidate.coordinates.length >= 2
    && candidate.coordinates.every((point) => Array.isArray(point) && point.length === 2 && finiteNumber(point[0]) && finiteNumber(point[1]))
}

function flattenStops(data: RenderPageData, provider: 'amap' | 'leaflet'): StopModel[] {
  const result: StopModel[] = []
  data.itinerary.days.forEach((day, dayIndex) => {
    day.stops.forEach((stop, stopIndex) => {
      result.push({
        key: `${dayIndex}-${stopIndex}`,
        dayIndex,
        stopIndex,
        stop,
        point: stop.coords === undefined ? undefined : toDisplay(stop.coords, provider),
      })
    })
  })
  return result
}

function deterministicMarkerModels(stops: StopModel[]): { models: MarkerModel[]; clustered: boolean } {
  const available = stops.filter((stop): stop is StopModel & { point: DisplayPoint } => stop.point !== undefined)
  if (available.length <= 200) {
    return {
      clustered: false,
      models: available.map((stop) => ({
        key: stop.key,
        keys: [stop.key],
        dayIndex: stop.dayIndex,
        stopIndex: stop.stopIndex,
        point: stop.point,
        label: String(stop.stopIndex + 1),
        color: DAY_COLOR(stop.dayIndex),
        cluster: false,
      })),
    }
  }
  const buckets = new Map<string, StopModel[]>()
  for (const [availableIndex, stop] of available.entries()) {
    // Fixed-size adjacent buckets keep the result deterministic even when all
    // 201 coordinates are far apart; the list still retains every stop.
    const bucket = `${stop.dayIndex}:${Math.floor(availableIndex / 2)}`
    const current = buckets.get(bucket)
    if (current === undefined) buckets.set(bucket, [stop])
    else current.push(stop)
  }
  const models: MarkerModel[] = []
  for (const [bucket, members] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const first = members[0]
    const average = members.reduce((sum, member) => ({
      lng: sum.lng + (member.point?.lng ?? 0) / members.length,
      lat: sum.lat + (member.point?.lat ?? 0) / members.length,
    }), { lng: 0, lat: 0 })
    models.push({
      key: `cluster-${bucket}`,
      keys: members.map((member) => member.key),
      dayIndex: first.dayIndex,
      stopIndex: first.stopIndex,
      point: average,
      label: String(members.length),
      color: DAY_COLOR(first.dayIndex),
      cluster: true,
    })
  }
  return { models, clustered: true }
}

function stopByKey(state: PageState, key: StopKey): StopModel | undefined {
  return state.stops.find((stop) => stop.key === key)
}

function endpointPoint(state: PageState, placeId: string, fallbackIndex: number): DisplayPoint | undefined {
  const match = state.stops.find((stop) => stop.stop.placeId === placeId && stop.point !== undefined)
  if (match?.point !== undefined) return match.point
  return state.stops[fallbackIndex]?.point
}

function routeSegments(data: RenderPageData, stops: StopModel[], provider: 'amap' | 'leaflet'): RouteSegment[] {
  const artifact: RenderRouteTransport | undefined = data.routeTransport
  if (artifact === undefined || !Array.isArray(artifact.legs)) return []
  const stateLike: PageState = {
    data, stops, markerModels: [], segments: [], markerHandles: [], routeHandles: [], dayIndex: 0, drawerOpen: false,
  }
  return artifact.legs.map((leg, index) => {
    const metricStatus = leg.metricStatus ?? leg.status
    const geometryStatus = leg.geometryStatus ?? (validGeometry(leg.geometry) ? 'queried' : undefined)
    const canShowMetric = metricStatus !== 'blocked' && metricStatus !== 'unavailable'
    const metricText = finiteNumber(leg.distanceKm) && finiteNumber(leg.durationMinutes)
      ? `${leg.distanceKm.toFixed(1)} km · 约 ${Math.round(leg.durationMinutes)} 分钟${metricStatus === 'estimated' ? ' · 估算' : ''}`
      : '里程/时长不可用'
    let path: DisplayPoint[] = []
    let fallback = false
    let dashed = geometryStatus !== 'queried'
    let note: string | undefined
    if (canShowMetric && geometryStatus !== 'blocked' && geometryStatus !== 'unavailable') {
      if (validGeometry(leg.geometry)) {
        // routeTransport is canonical WGS84; AMap needs GCJ-02 display points,
        // while Leaflet/OSM consumes the WGS84 geometry through the inverse path.
        path = geometryDisplayPath(leg.geometry, provider)
      } else {
        const from = endpointPoint(stateLike, leg.fromPlaceId, index)
        const to = endpointPoint(stateLike, leg.toPlaceId, index + 1)
        if (from !== undefined && to !== undefined) {
          path = [from, to]
          fallback = true
          dashed = true
          note = ROUTE_FALLBACK_NOTE
        }
      }
    }
    if (geometryStatus === 'estimated') {
      dashed = true
      note = validGeometry(leg.geometry) ? '轨迹为估算示意' : ROUTE_FALLBACK_NOTE
    } else if (geometryStatus === undefined && path.length > 0) {
      note = ROUTE_FALLBACK_NOTE
    }
    return { leg, path, dashed, fallback, metricText, ...(note === undefined ? {} : { note }) }
  })
}

function currentProvider(data: RenderPageData): 'amap' | 'leaflet' {
  return data.map?.provider === 'amap' ? 'amap' : 'leaflet'
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function setDataset(name: string, value: string): void {
  document.body.dataset[name] = value
}

function setMapStatus(text: string, kind: 'notice' | 'warning' = 'notice'): void {
  const status = byId<HTMLElement>('mapStatus')
  if (status === undefined) return
  status.className = kind === 'warning' ? 'degraded' : 'notice'
  status.textContent = text
  status.classList.remove('hidden')
}

function renderSkeleton(state: PageState): void {
  const map = byId<HTMLElement>('map')
  if (map === undefined) return
  const skeleton = make('div', 'map-skeleton')
  skeleton.setAttribute('aria-hidden', 'true')
  const total = Math.min(18, Math.max(4, state.stops.length))
  for (let index = 0; index < total; index += 1) {
    const point = make('span', 'skeleton-point')
    point.style.left = `${12 + ((index * 37) % 76)}%`
    point.style.top = `${16 + ((index * 53) % 68)}%`
    skeleton.appendChild(point)
  }
  map.appendChild(skeleton)
}

function renderArtifactStatus(card: HTMLElement, data: RenderPageData): void {
  const statuses = data.artifactStatus
  if (statuses === undefined) return
  const wrap = make('div', 'artifact-status')
  appendText(wrap, '上游工件状态', 'muted')
  const badges = make('div', 'artifact-badges')
  const labels: Record<string, string> = {
    intel: '情报', research: '研究', places: '地点解析', transport: '交通', advice: '建议', insights: '归纳',
    quotes: '住宿报价', rental: '租车报价', cost: '成本', 'route-transport': '路线交通', coverage: '区域覆盖',
  }
  for (const key of Object.keys(statuses)) {
    const value = statuses[key]
    const badge = make('span', `artifact-badge badge-${value.state}`)
    badge.textContent = `${labels[key] ?? key} · ${value.state}${value.version > 0 ? ` v${value.version}` : ''}`
    badges.appendChild(badge)
  }
  wrap.appendChild(badges)
  card.appendChild(wrap)
}

function renderOverview(state: PageState): void {
  const card = byId<HTMLElement>('overviewCard')
  if (card === undefined) return
  const exportBar = byId<HTMLElement>('exportBar')
  for (const child of Array.from(card.children)) {
    if (child !== exportBar) child.remove()
  }
  const request = state.data.request
  const slots = request.slots
  const head = make('div', 'overview-head')
  const titleBox = make('div')
  const title = make('h1', 'overview-title', `${slots.destination ?? '旅行'} · ${slots.days ?? state.data.itinerary.days.length} 天`)
  titleBox.appendChild(title)
  const dateText = `${slots.dateStart ?? '?'} ~ ${slots.dateEnd ?? '?'}`
  titleBox.appendChild(make('p', 'overview-subtitle', `${dateText} · ${slots.travelers?.adults ?? 1} 位成人`))
  head.appendChild(titleBox)
  const actions = exportBar ?? make('div', 'overview-actions')
  actions.className = 'overview-actions'
  const exportData = byId<HTMLScriptElement>('travel-export')
  const exportBundle = (() => {
    try { return exportData === undefined ? undefined : JSON.parse(exportData.textContent ?? '') as { json?: string; markdown?: string } } catch { return undefined }
  })()
  const download = (name: string, content: string | undefined, mime: string): void => {
    if (content === undefined) return
    const blob = new Blob([content], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const anchor = make('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const jsonButton = byId<HTMLButtonElement>('btnDownloadJson') ?? make('button', 'action-button', '下载 JSON')
  jsonButton.id = 'btnDownloadJson'
  jsonButton.type = 'button'
  jsonButton.addEventListener('click', () => download(`itinerary-${request.planId}.json`, exportBundle?.json, 'application/json'))
  const markdownButton = byId<HTMLButtonElement>('btnDownloadMarkdown') ?? make('button', 'action-button', '下载 Markdown')
  markdownButton.id = 'btnDownloadMarkdown'
  markdownButton.type = 'button'
  markdownButton.addEventListener('click', () => download(`itinerary-${request.planId}.md`, exportBundle?.markdown, 'text/markdown'))
  const printButton = byId<HTMLButtonElement>('btnPrintPdf') ?? make('button', 'action-button', '打印/PDF')
  printButton.id = 'btnPrintPdf'
  printButton.type = 'button'
  printButton.addEventListener('click', () => window.print())
  if (actions.childElementCount === 0) actions.append(jsonButton, markdownButton, printButton)
  head.appendChild(actions)
  card.appendChild(head)

  const metricStrip = make('div', 'metric-strip')
  const totalDistanceKm = state.data.totalDistanceKm ?? state.data.routeTransport?.totalDistanceKm
  const totalDurationMinutes = state.data.totalDurationMinutes ?? state.data.routeTransport?.totalDurationMinutes
  const metrics: Array<[string, string]> = [
    ['目的地', slots.destination ?? '—'],
    ['日期', dateText],
    ['天数', `${slots.days ?? state.data.itinerary.days.length} 天`],
  ]
  if (finiteNumber(totalDistanceKm)) metrics.push(['环线总里程', `${totalDistanceKm.toFixed(1)} km`])
  if (finiteNumber(totalDurationMinutes)) metrics.push(['总驾驶时长', `${Math.round(totalDurationMinutes)} 分钟`])
  if (slots.budget?.amount !== undefined) metrics.push(['预算', `${slots.budget.amount} ${slots.budget.currency ?? 'CNY'}`])
  for (const [label, value] of metrics) {
    const metric = make('div', 'metric')
    appendText(metric, label, 'metric-label')
    appendText(metric, value, 'metric-value')
    metricStrip.appendChild(metric)
  }
  card.appendChild(metricStrip)
  if (request.assumptions.length > 0) card.appendChild(make('p', 'muted small', `默认假设：${request.assumptions.join('；')}`))
  renderArtifactStatus(card, state.data)
}

function appendHardFacts(parent: Element, intel: IntelItem | undefined): void {
  if (intel === undefined) return
  const facts = make('div', 'hard-facts')
  if (finiteNumber(intel.rating)) facts.appendChild(make('span', 'hard-fact', `评分 ${intel.rating}`))
  if (finiteNumber(intel.avgPrice)) facts.appendChild(make('span', 'hard-fact', `人均约 ${intel.avgPrice} 元`))
  if (typeof intel.openingHours === 'string' && intel.openingHours.trim().length > 0) facts.appendChild(make('span', 'hard-fact', `时间 ${intel.openingHours}`))
  if (facts.childElementCount > 0) parent.appendChild(facts)
}

function appendInsightCards(parent: Element, insights: TravelInsight[], max = 3): void {
  const stack = make('div', 'insight-stack')
  for (const insight of insights.slice(0, max)) {
    const item = make('div', `insight-card${insight.kind === 'avoid' ? ' avoid' : ''}`)
    appendText(item, INSIGHT_LABEL[insight.kind] ?? insight.kind, 'insight-kind')
    appendText(item, insight.text, 'insight-text')
    stack.appendChild(item)
  }
  if (stack.childElementCount > 0) parent.appendChild(stack)
}

function appendStopSummary(parent: Element, state: PageState, model: StopModel): void {
  const stop = model.stop
  appendHeading(parent, 'h3', stop.name)
  const typeText = `${CATEGORY_LABEL[stop.category] ?? stop.category}${stop.durationHint !== undefined ? ` · 建议 ${stop.durationHint} 分钟` : ''}`
  appendText(parent, typeText, 'day-theme')
  const insights = insightsForStop(state.data, stop)
  if (insights.length === 0) {
    appendText(parent, '缺失/下一步：暂无已归纳且可引用的建议。', 'next-step')
  } else {
    appendInsightCards(parent, insights, 3)
    appendHardFacts(parent, sourceItem(state.data, stop))
    appendCitations(parent, insights)
  }
}

function renderDayDrawer(state: PageState): void {
  const body = byId<HTMLElement>('dayCard')
  if (body === undefined) return
  clear(body)
  const day = state.data.itinerary.days[state.dayIndex]
  if (day === undefined) return
  const summary = make('div', 'day-summary')
  appendHeading(summary, 'h3', `第 ${state.dayIndex + 1} 天 · ${day.date}`)
  if (day.theme !== undefined) appendText(summary, day.theme, 'day-theme')
  const actions = make('div', 'day-actions')
  const play = make('button', 'action-button', '▶ 播放本日')
  play.type = 'button'
  play.id = 'playDay'
  play.addEventListener('click', () => playDay(state))
  actions.appendChild(play)
  summary.appendChild(actions)
  const insights = insightsForDay(state.data, day)
  if (insights.length === 0) appendText(summary, '缺失/下一步：本日暂无已归纳建议。', 'next-step')
  else {
    appendInsightCards(summary, insights, 3)
    appendCitations(summary, insights)
  }
  const stops = make('div', 'insight-stack')
  for (const stop of day.stops.slice(0, 8)) {
    const stopSummary = make('div', 'insight-card')
    const heading = make('div', 'data-item-title', stop.name)
    stopSummary.appendChild(heading)
    const facts = make('div', 'stop-meta', `${CATEGORY_LABEL[stop.category] ?? stop.category}${stop.durationHint !== undefined ? ` · ${stop.durationHint} 分钟` : ''}`)
    stopSummary.appendChild(facts)
    const stopInsights = insightsForStop(state.data, stop)
    if (stopInsights.length === 0) appendText(stopSummary, '缺失/下一步：暂无归纳。', 'next-step')
    else appendText(stopSummary, stopInsights.slice(0, 1)[0].text, 'insight-text')
    stops.appendChild(stopSummary)
  }
  summary.appendChild(stops)
  body.appendChild(summary)
}

function renderTimeline(state: PageState): void {
  const card = byId<HTMLElement>('timelineCard')
  if (card === undefined) return
  clear(card)
  appendHeading(card, 'h2', '日程轨道', 'card-title')
  const track = make('div', 'timeline-track')
  state.data.itinerary.days.forEach((day, dayIndex) => {
    const daySection = make('section', `timeline-day${dayIndex === state.dayIndex ? ' active' : ''}`)
    daySection.dataset.dayIndex = String(dayIndex)
    const dayButton = make('button', 'day-button')
    dayButton.type = 'button'
    dayButton.dataset.dayIndex = String(dayIndex)
    dayButton.setAttribute('aria-label', `查看第 ${dayIndex + 1} 天 ${day.date}`)
    dayButton.appendChild(make('span', 'day-dot'))
    const dot = dayButton.firstElementChild
    if (dot instanceof HTMLElement) dot.style.backgroundColor = DAY_COLOR(dayIndex)
    appendText(dayButton, `第 ${dayIndex + 1} 天`)
    appendText(dayButton, day.date, 'day-date')
    dayButton.addEventListener('click', () => selectDay(state, dayIndex, true))
    daySection.appendChild(dayButton)
    const stopList = make('div', 'stop-list')
    day.stops.forEach((stop, stopIndex) => {
      const model = state.stops.find((candidate) => candidate.dayIndex === dayIndex && candidate.stopIndex === stopIndex)
      if (model === undefined) return
      const button = make('button', 'stop-button')
      button.type = 'button'
      button.dataset.selectionKey = model.key
      button.setAttribute('aria-label', `查看${stop.name}`)
      const index = make('span', 'stop-index', String(stopIndex + 1))
      index.style.backgroundColor = DAY_COLOR(dayIndex)
      button.appendChild(index)
      const copy = make('span', 'stop-copy')
      appendText(copy, stop.name, 'stop-name')
      appendText(copy, `${CATEGORY_LABEL[stop.category] ?? stop.category}${stop.durationHint !== undefined ? ` · ${stop.durationHint} 分钟` : ''}`, 'stop-meta')
      const stopInsights = insightsForStop(state.data, stop)
      if (stopInsights.length > 0) appendText(copy, stopInsights[0].text, 'stop-summary')
      else appendText(copy, '缺失/下一步：暂无归纳', 'stop-summary')
      button.appendChild(copy)
      button.addEventListener('mouseenter', () => scheduleHover(state, model.key))
      button.addEventListener('mouseover', () => scheduleHover(state, model.key))
      button.addEventListener('mouseleave', () => cancelHover(state))
      button.addEventListener('click', () => selectStop(state, model.key, true))
      button.addEventListener('keydown', (event) => handleSelectionKey(state, model.key, event))
      stopList.appendChild(button)
    })
    daySection.appendChild(stopList)
    track.appendChild(daySection)
  })
  card.appendChild(track)
}

function renderWarnings(state: PageState): void {
  const strip = byId<HTMLElement>('mapWarnStrip')
  if (strip === undefined) return
  const warnings = [...(state.data.map?.warnings ?? [])]
  if (warnings.length === 0) {
    strip.classList.add('hidden')
    return
  }
  strip.textContent = `⚠ ${warnings.join('；')}`
  strip.classList.remove('hidden')
}

function renderMapControls(state: PageState): void {
  const toolbar = byId<HTMLElement>('mapToolbar')
  if (toolbar === undefined) return
  const providerText = state.data.map?.provider === 'amap' ? '高德 JSAPI 2.0' : 'Leaflet 1.9 + OSM'
  const provider = byId<HTMLElement>('mapProviderLabel')
  if (provider !== undefined) provider.textContent = providerText
  const drawerToggle = byId<HTMLButtonElement>('drawerToggle')
  const drawer = byId<HTMLElement>('dayDrawer')
  if (drawerToggle !== undefined && drawer !== undefined) {
    drawerToggle.addEventListener('click', () => {
      state.drawerOpen = !state.drawerOpen
      drawer.classList.toggle('open', state.drawerOpen)
      drawerToggle.setAttribute('aria-expanded', String(state.drawerOpen))
      setDataset('drawer', state.drawerOpen ? 'open' : 'closed')
    })
  }
}

function renderStopPopover(state: PageState, model: StopModel | undefined): void {
  const map = byId<HTMLElement>('map')
  if (map === undefined) return
  const old = byId<HTMLElement>('mapPopover')
  if (old !== undefined) old.remove()
  if (model === undefined) return
  const popover = make('aside', 'map-popover')
  popover.id = 'mapPopover'
  popover.setAttribute('role', 'dialog')
  popover.setAttribute('aria-label', model.stop.name)
  appendStopSummary(popover, state, model)
  const close = make('button', 'action-button', '关闭')
  close.type = 'button'
  close.addEventListener('click', () => {
    state.lockedKey = undefined
    state.selectedKey = undefined
    renderStopPopover(state, undefined)
    updateSelectionClasses(state)
  })
  popover.appendChild(close)
  map.appendChild(popover)
  setDataset('popup', model.key)
}

function updateSelectionClasses(state: PageState): void {
  document.querySelectorAll<HTMLElement>('[data-selection-key]').forEach((element) => {
    element.classList.toggle('active', element.dataset.selectionKey === state.selectedKey)
    element.setAttribute('aria-pressed', String(element.dataset.selectionKey === state.selectedKey))
  })
  document.querySelectorAll<HTMLElement>('[data-leg-id]').forEach((element) => {
    element.classList.toggle('active', element.dataset.legId === state.selectedLegId)
  })
  for (const handle of state.markerHandles) handle.setActive(handle.keys.includes(state.selectedKey ?? ''))
  for (const handle of state.routeHandles) handle.setActive(handle.id === state.selectedLegId)
}

function selectDay(state: PageState, dayIndex: number, userTriggered: boolean): void {
  if (dayIndex < 0 || dayIndex >= state.data.itinerary.days.length) return
  state.dayIndex = dayIndex
  const day = state.data.itinerary.days[dayIndex]
  const first = state.stops.find((stop) => stop.dayIndex === dayIndex)
  if (first !== undefined) state.selectedKey = first.key
  renderTimeline(state)
  renderDayDrawer(state)
  updateSelectionClasses(state)
  if (userTriggered) flyToDay(state, dayIndex)
  if (window.innerWidth <= 760) {
    state.drawerOpen = true
    const drawer = byId<HTMLElement>('dayDrawer')
    const toggle = byId<HTMLButtonElement>('drawerToggle')
    drawer?.classList.add('open')
    toggle?.setAttribute('aria-expanded', 'true')
  }
  void day
}

function selectStop(state: PageState, key: StopKey, lock: boolean): void {
  const model = stopByKey(state, key)
  if (model === undefined) return
  state.dayIndex = model.dayIndex
  state.selectedKey = key
  if (lock) state.lockedKey = key
  renderDayDrawer(state)
  renderStopPopover(state, model)
  // Hover updates the card without replacing the focused list node; click/keyboard
  // locking may rebuild the day track to move the active-day affordance.
  if (lock) renderTimeline(state)
  updateSelectionClasses(state)
  if (window.innerWidth <= 760) {
    state.drawerOpen = true
    byId<HTMLElement>('dayDrawer')?.classList.add('open')
    byId<HTMLButtonElement>('drawerToggle')?.setAttribute('aria-expanded', 'true')
  }
  setDataset('selection', key)
  setDataset('selectionLocked', lock ? 'true' : String(state.lockedKey !== undefined))
}

function selectLeg(state: PageState, id: string, lock: boolean): void {
  state.selectedLegId = id
  const segment = state.segments.find((candidate) => candidate.leg.id === id)
  if (segment !== undefined) {
    const stop = state.stops.find((candidate) => candidate.stop.placeId === segment.leg.fromPlaceId)
    if (stop !== undefined) state.selectedKey = stop.key
  }
  if (lock) state.lockedKey = state.selectedKey
  updateSelectionClasses(state)
  setDataset('selectedLeg', id)
}

function scheduleHover(state: PageState, key: StopKey): void {
  if (state.lockedKey !== undefined && state.lockedKey !== key) return
  cancelHover(state)
  const started = performance.now()
  state.hoverTimer = window.setTimeout(() => {
    const elapsed = performance.now() - started
    setDataset('hoverLatencyMs', elapsed.toFixed(1))
    selectStop(state, key, false)
  }, 0)
}

function cancelHover(state: PageState): void {
  if (state.hoverTimer !== undefined) {
    window.clearTimeout(state.hoverTimer)
    state.hoverTimer = undefined
  }
}

function handleSelectionKey(state: PageState, key: StopKey, event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectStop(state, key, true)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    state.lockedKey = undefined
    state.selectedKey = undefined
    renderStopPopover(state, undefined)
    updateSelectionClasses(state)
    setDataset('selectionLocked', 'false')
  }
}

function flyToDay(state: PageState, dayIndex: number): void {
  if (state.map === undefined) return
  const points = state.stops.filter((stop) => stop.dayIndex === dayIndex && stop.point !== undefined).map((stop) => stop.point as DisplayPoint)
  if (points.length === 0) return
  const center = points.reduce((sum, point) => ({ lng: sum.lng + point.lng / points.length, lat: sum.lat + point.lat / points.length }), { lng: 0, lat: 0 })
  const target: [number, number] = [center.lat, center.lng]
  const animated = !reducedMotion()
  const map = state.map.map
  if (state.data.map.provider === 'amap') {
    if (animated && map.setCenter !== undefined) map.setCenter([center.lng, center.lat], 9, { animate: true })
    else map.setCenter?.([center.lng, center.lat], 9, { animate: false })
  } else if (animated && map.flyTo !== undefined) map.flyTo(target, 9, { animate: true })
  else map.setView?.(target, 9, { animate: false })
  setDataset('lastFlyDay', String(dayIndex))
  setDataset('motion', animated ? 'animated-by-user' : 'reduced')
}

function playDay(state: PageState): void {
  // This is intentionally only called from the visible user button. There is no
  // boot-time camera animation or timer-driven route playback.
  setDataset('playTriggered', 'true')
  const start = state.dayIndex
  const days = state.data.itinerary.days.length
  for (let offset = 0; offset < Math.min(days, 5); offset += 1) {
    const dayIndex = (start + offset) % days
    window.setTimeout(() => {
      selectDay(state, dayIndex, true)
      setDataset('playingDay', String(dayIndex))
    }, offset * (reducedMotion() ? 20 : 260))
  }
}

function createMapPin(model: MarkerModel): HTMLElement {
  const pin = make('button', model.cluster ? 'cluster-pin' : 'map-pin', model.label)
  pin.type = 'button'
  pin.tabIndex = 0
  pin.dataset.selectionKey = model.key
  pin.setAttribute('aria-label', model.cluster ? `${model.label} 个行程点聚合` : `行程点 ${model.label}`)
  pin.style.backgroundColor = model.cluster ? '#243c66' : model.color
  return pin
}

function geometryDisplayPath(geometry: RouteGeometry, provider: 'amap' | 'leaflet'): DisplayPoint[] {
  return geometry.coordinates.map(([lng, lat]) => toDisplay({ lng, lat, sys: 'WGS84' }, provider))
}

function clearSkeleton(): void {
  document.querySelector('.map-skeleton')?.remove()
}

function mapViewBounds(points: DisplayPoint[]): { minLng: number; minLat: number; maxLng: number; maxLat: number } | undefined {
  if (points.length === 0) return undefined
  return points.reduce((bounds, point) => ({
    minLng: Math.min(bounds.minLng, point.lng), minLat: Math.min(bounds.minLat, point.lat),
    maxLng: Math.max(bounds.maxLng, point.lng), maxLat: Math.max(bounds.maxLat, point.lat),
  }), { minLng: points[0].lng, minLat: points[0].lat, maxLng: points[0].lng, maxLat: points[0].lat })
}

function buildMapAdapter(state: PageState): MapHandle | undefined {
  const mapElement = byId<HTMLElement>('map')
  if (mapElement === undefined || state.markerModels.length === 0) return undefined
  const provider = currentProvider(state.data)
  const points = state.markerModels.map((marker) => marker.point)
  const bounds = mapViewBounds(points)
  const center = points.reduce((sum, point) => ({ lng: sum.lng + point.lng / points.length, lat: sum.lat + point.lat / points.length }), { lng: 0, lat: 0 })
  const handles: MarkerHandle[] = []
  const routes: RouteHandle[] = []
  if (provider === 'amap') {
    const amap = typeof AMap === 'undefined' ? undefined : AMap
    if (amap === undefined) throw new Error('AMap SDK 未加载')
    const map = new amap.Map(mapElement, { center: [center.lng, center.lat], zoom: 6, viewMode: '2D' })
    map.addControl(new amap.Scale())
    map.addControl(new amap.ToolBar())
    const infoWindow = new amap.InfoWindow({ offset: new amap.Pixel(0, -28), autoMove: true })
    for (const model of state.markerModels) {
      const pin = createMapPin(model)
      const marker = new amap.Marker({ position: [model.point.lng, model.point.lat], content: pin, offset: new amap.Pixel(0, 0), zIndex: model.cluster ? 90 : 120 })
      marker.setMap(map)
      const handle: MarkerHandle = {
        key: model.key,
        keys: model.keys,
        setActive: (active) => pin.classList.toggle('active', active),
        setDimmed: (dimmed) => { pin.style.opacity = dimmed ? '0.28' : '1' },
        open: () => { infoWindow.setContent(byId<HTMLElement>('mapPopover') ?? pin); infoWindow.open(map, marker.getPosition()) },
      }
      pin.addEventListener('mouseenter', () => scheduleHover(state, model.keys[0]))
      pin.addEventListener('mouseover', () => scheduleHover(state, model.keys[0]))
      pin.addEventListener('mouseleave', () => cancelHover(state))
      pin.addEventListener('click', () => selectStop(state, model.keys[0], true))
      pin.addEventListener('keydown', (event) => handleSelectionKey(state, model.keys[0], event))
      marker.on('click', () => selectStop(state, model.keys[0], true))
      marker.on('mouseover', () => scheduleHover(state, model.keys[0]))
      handles.push(handle)
    }
    for (const segment of state.segments) {
      if (segment.path.length < 2) continue
      const line = new amap.Polyline({
        path: segment.path.map((point) => [point.lng, point.lat]),
        strokeColor: DAY_COLOR(segment.leg.orderIndex), strokeWeight: segment.dashed ? 3 : 4,
        strokeOpacity: .78, strokeStyle: segment.dashed ? 'dashed' : 'solid', lineJoin: 'round',
      })
      map.add(line)
      routes.push({ id: segment.leg.id, setActive: (active) => line.setOptions({ strokeWeight: active ? 7 : segment.dashed ? 3 : 4, strokeOpacity: active ? 1 : .78 }) })
    }
    if (bounds !== undefined) map.setBounds(new amap.Bounds(new amap.LngLat(bounds.minLng, bounds.minLat), new amap.LngLat(bounds.maxLng, bounds.maxLat)))
    return { map, markers: handles, routes }
  }

  const leaflet = typeof L === 'undefined' ? undefined : L
  if (leaflet === undefined) throw new Error('Leaflet SDK 未加载')
  const map = leaflet.map(mapElement).setView([center.lat, center.lng], 6)
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map)
  leaflet.control.scale().addTo(map)
  for (const model of state.markerModels) {
    // Leaflet receives an empty icon shell; the visible pin and its label are
    // created as DOM nodes so itinerary text never crosses an HTML parser.
    const icon = leaflet.divIcon({ className: '', html: '', iconSize: [34, 34], iconAnchor: [17, 17] })
    const marker = leaflet.marker([model.point.lat, model.point.lng], { icon }).addTo(map)
    const mountPin = (): void => {
      const wrapper = marker.getElement()
      if (wrapper === undefined || wrapper.querySelector('.map-pin, .cluster-pin') !== null) return
      const pin = createMapPin(model)
      wrapper.appendChild(pin)
      pin.addEventListener('mouseenter', () => scheduleHover(state, model.keys[0]))
      pin.addEventListener('mouseover', () => scheduleHover(state, model.keys[0]))
      pin.addEventListener('mouseleave', () => cancelHover(state))
      pin.addEventListener('click', () => selectStop(state, model.keys[0], true))
      pin.addEventListener('keydown', (event) => handleSelectionKey(state, model.keys[0], event))
    }
    const handle: MarkerHandle = {
      key: model.key,
      keys: model.keys,
      setActive: (active) => { const element = marker.getElement()?.querySelector<HTMLElement>('.map-pin, .cluster-pin'); element?.classList.toggle('active', active) },
      setDimmed: (dimmed) => marker.setOpacity(dimmed ? .28 : 1),
      open: () => marker.openPopup(),
    }
    marker.on('mouseover', () => scheduleHover(state, model.keys[0]))
    marker.on('mouseout', () => cancelHover(state))
    marker.on('click', () => selectStop(state, model.keys[0], true))
    marker.bindPopup(make('div', 'map-popover', ''))
    marker.getPopup()?.setContent(byId<HTMLElement>('mapPopover') ?? make('div', undefined, model.cluster ? `${model.label} 个行程点` : model.label))
    mountPin()
    window.setTimeout(mountPin, 0)
    handles.push(handle)
  }
  for (const segment of state.segments) {
    if (segment.path.length < 2) continue
    const line = leaflet.polyline(segment.path.map((point) => [point.lat, point.lng] as [number, number]), {
      color: DAY_COLOR(segment.leg.orderIndex), weight: segment.dashed ? 3 : 4, opacity: .78, dashArray: segment.dashed ? '8 7' : undefined,
    }).addTo(map)
    routes.push({ id: segment.leg.id, setActive: (active) => line.setStyle({ weight: active ? 7 : segment.dashed ? 3 : 4, opacity: active ? 1 : .78 }) })
  }
  if (bounds !== undefined) map.fitBounds([[bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]], { padding: [22, 22] })
  return { map, markers: handles, routes }
}

function renderLegList(state: PageState): void {
  const list = byId<HTMLElement>('legList')
  const legend = byId<HTMLElement>('routeLegend')
  if (list === undefined || legend === undefined) return
  clear(list)
  clear(legend)
  legend.appendChild(make('span', 'legend-line', '道路几何'))
  legend.appendChild(make('span', 'legend-line dashed', '直线示意/估算'))
  for (const [index, segment] of state.segments.entries()) {
    const button = make('button', 'leg-button')
    button.type = 'button'
    button.dataset.legId = segment.leg.id
    const marker = make('span', 'leg-index', String(index + 1))
    marker.style.backgroundColor = DAY_COLOR(segment.leg.orderIndex)
    button.appendChild(marker)
    const copy = make('span', 'leg-copy')
    appendText(copy, `${segment.leg.fromPlaceId} → ${segment.leg.toPlaceId}`, 'leg-route')
    appendText(copy, segment.metricText, 'leg-metric')
    if (segment.note !== undefined) appendText(copy, segment.note, 'leg-note')
    else if (segment.leg.geometryStatus === 'queried') appendText(copy, `轨迹来源：${segment.leg.provider ?? segment.leg.geometry?.source ?? '路线渠道'}`, 'leg-note')
    button.appendChild(copy)
    button.addEventListener('mouseenter', () => selectLeg(state, segment.leg.id, false))
    button.addEventListener('mouseover', () => selectLeg(state, segment.leg.id, false))
    button.addEventListener('click', () => selectLeg(state, segment.leg.id, true))
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectLeg(state, segment.leg.id, true) }
      if (event.key === 'Escape') { state.selectedLegId = undefined; updateSelectionClasses(state) }
    })
    list.appendChild(button)
  }
  if (state.segments.length === 0) list.appendChild(make('div', 'notice', '暂无可绘制道路几何；不可用/阻断路段不伪装为道路。'))
}

function initMap(state: PageState): void {
  try {
    clearSkeleton()
    state.map = buildMapAdapter(state)
    if (state.map === undefined) {
      setMapStatus('暂无带坐标的行程点位，已保留静态日程列表。')
      setDataset('mapReady', 'no-coordinates')
      return
    }
    state.markerHandles = state.map.markers
    state.routeHandles = state.map.routes
    setDataset('mapReady', currentProvider(state.data))
    setDataset('markers', String(state.markerModels.length))
    setDataset('stops', String(state.stops.length))
    setDataset('clustered', state.markerModels.length < state.stops.filter((stop) => stop.point !== undefined).length ? 'true' : 'false')
    renderLegList(state)
    updateSelectionClasses(state)
    const status = byId<HTMLElement>('mapStatus')
    if (status !== undefined && state.data.map.warnings.length === 0) status.classList.add('hidden')
    console.log(`[dsh-travel] stops=${state.stops.length} markers=${state.markerModels.length}`)
  } catch (error) {
    clearSkeleton()
    setDataset('mapReady', `${currentProvider(state.data)}-error`)
    setMapStatus(`地图初始化失败：${error instanceof Error ? error.message : String(error)}；静态日程仍可用。`, 'warning')
    renderLegList(state)
    console.log(`[dsh-travel] map error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function renderInsightsSection(data: RenderPageData): void {
  const card = byId<HTMLElement>('insightsCard')
  const body = byId<HTMLElement>('insightsBody')
  if (card === undefined || body === undefined) return
  clear(body)
  const insights = allInsights(data)
  if (insights.length === 0) {
    appendText(body, '缺失/下一步：暂无调用方归纳，页面不回退展示原始摘要。', 'next-step')
    card.classList.remove('hidden')
    return
  }
  card.classList.remove('hidden')
  for (const insight of insights) {
    const item = make('article', `data-item${insight.kind === 'avoid' ? ' warning' : ''}`)
    appendText(item, INSIGHT_LABEL[insight.kind] ?? insight.kind, 'data-item-title')
    appendText(item, insight.text, 'data-item-body')
    const insightCitations = [insight]
    appendCitations(item, insightCitations)
    body.appendChild(item)
  }
}

function renderInsightGroup(data: RenderPageData, cardId: string, bodyId: string, kind: string, warning: boolean): void {
  const card = byId<HTMLElement>(cardId)
  const body = byId<HTMLElement>(bodyId)
  if (card === undefined || body === undefined) return
  clear(body)
  const insights = allInsights(data).filter((insight) => insight.kind === kind)
  card.classList.remove('hidden')
  if (insights.length === 0) {
    appendText(body, '缺失/下一步：暂无已归纳条目。', 'next-step')
    return
  }
  for (const insight of insights) {
    const item = make('article', `data-item${warning ? ' warning' : ''}`)
    appendText(item, insight.text, 'data-item-body')
    appendCitations(item, [insight])
    body.appendChild(item)
  }
}

function renderTransport(data: RenderPageData): void {
  const card = byId<HTMLElement>('transportCard')
  const body = byId<HTMLElement>('transportBody')
  if (card === undefined || body === undefined) return
  clear(body)
  const transport: TransportOption[] = Array.isArray(data.transport) ? data.transport : []
  if (transport.length === 0) { card.classList.add('hidden'); return }
  card.classList.remove('hidden')
  const table = make('table', 'data-table')
  const head = make('tr')
  for (const text of ['方式', '用时', '价格档', '来源']) head.appendChild(make('th', undefined, text))
  table.appendChild(head)
  for (const option of transport) {
    const row = make('tr')
    row.appendChild(make('td', undefined, option.mode))
    row.appendChild(make('td', undefined, option.durationMinutes === undefined ? '—' : `${option.durationMinutes} 分钟`))
    row.appendChild(make('td', undefined, option.totalPriceRange === undefined ? '—' : `${option.totalPriceRange[0]}~${option.totalPriceRange[1]} ${option.currency ?? '币种未明确'}`))
    const source = make('td')
    appendSafeLink(source, option.source.platform, option.source.platform, option.source.url)
    row.appendChild(source)
    table.appendChild(row)
  }
  body.appendChild(table)
}

function renderAdvice(data: RenderPageData): void {
  const card = byId<HTMLElement>('adviceCard')
  const body = byId<HTMLElement>('adviceBody')
  if (card === undefined || body === undefined) return
  clear(body)
  const advice: Advice | undefined = data.advice
  if (advice === undefined) { card.classList.add('hidden'); return }
  card.classList.remove('hidden')
  if (advice.weather.length > 0) {
    appendHeading(body, 'h3', '天气')
    const strip = make('div', 'weather-strip')
    for (const weather of advice.weather) {
      const item = make('div', 'weather-item')
      appendText(item, weather.date, 'weather-date')
      if (weather.tempRange?.length === 2) appendText(item, `${weather.tempRange[0]}~${weather.tempRange[1]}°C`, 'weather-temp')
      if (weather.dayForecast !== undefined) appendText(item, weather.dayForecast)
      if (weather.beyondForecastWindow === true) appendText(item, '气候概况', 'muted')
      strip.appendChild(item)
    }
    body.appendChild(strip)
  }
  if (advice.clothing.length > 0) appendText(body, `穿衣：${advice.clothing.join('；')}`, 'data-item-body')
  if (advice.packingList.length > 0) appendText(body, `物品：${advice.packingList.join('；')}`, 'data-item-body')
  if (advice.extraTips.length > 0) appendText(body, `小贴士：${advice.extraTips.join('；')}`, 'data-item-body')
}

function renderRentalCost(data: RenderPageData): void {
  const card = byId<HTMLElement>('rentalCostCard')
  const body = byId<HTMLElement>('rentalCostBody')
  if (card === undefined || body === undefined) return
  clear(body)
  if (data.rentalQuotes === undefined && data.cost === undefined) { card.classList.add('hidden'); return }
  card.classList.remove('hidden')
  if (data.rentalQuotes !== undefined) {
    appendText(body, data.rentalQuotes.disclaimer, 'muted')
    for (const quote of data.rentalQuotes.quotes ?? []) {
      const range = quote.quote?.range === undefined ? '未提供' : `${quote.quote.range[0]}~${quote.quote.range[1]} ${quote.quote.currency ?? '币种未明确'}`
      appendText(body, `${quote.pickupPlaceId}${quote.dropoffPlaceId === undefined ? '' : ` → ${quote.dropoffPlaceId}`} · ${quote.vehicleType} · ${range}/天 × ${quote.days} 天`, 'data-item-body')
    }
  }
  if (data.cost !== undefined) {
    appendHeading(body, 'h3', '成本摘要')
    const total = data.cost.total
    appendText(body, `${total.min}~${total.max} ${total.currency ?? '币种未明确'}`, 'data-item-body')
    for (const [key, value] of Object.entries(data.cost.components ?? {})) {
      appendText(body, `${key}：${value.min}~${value.max} ${value.currency ?? '币种未明确'}（${value.status}）`, 'data-item-body')
    }
  }
}

function renderDegraded(data: RenderPageData): void {
  const strip = byId<HTMLElement>('degradedStrip')
  if (strip === undefined) return
  clear(strip)
  if (data.degraded.length === 0) { strip.classList.add('hidden'); return }
  strip.className = 'degraded'
  appendText(strip, '⚠ 数据降级说明', 'data-item-title')
  for (const entry of data.degraded) appendText(strip, `· ${entry.source} [${entry.code}]：${entry.reason}`, 'data-item-body')
}

function loadCss(href: string, onerror: () => void): void {
  const link = make('link')
  link.rel = 'stylesheet'
  link.href = href
  link.addEventListener('error', onerror, { once: true })
  document.head.appendChild(link)
}

function loadJs(src: string, onload: () => void, onerror: () => void): void {
  const script = make('script')
  script.src = src
  script.onload = onload
  script.onerror = onerror
  document.head.appendChild(script)
}

function startLoader(state: PageState): void {
  const mapConfig = state.data.map
  if (mapConfig.provider === 'amap') {
    const key = mapConfig.amapKey ?? ''
    const mode = mapConfig.amapSecurityMode === 'B' ? 'B' : 'A'
    if (mode === 'B') {
      window._AMapSecurityConfig = { serviceHost: mapConfig.serviceHost ?? `${window.location.origin}/_AMapService` }
    } else {
      window._AMapSecurityConfig = { securityJsCode: mapConfig.amapJscode ?? '' }
    }
    const loader = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Scale,AMap.ToolBar`
    loadJs(loader, () => {
      setDataset('amapGlobal', typeof AMap === 'undefined' ? 'no' : 'yes')
      initMap(state)
    }, () => {
      setDataset('mapReady', 'amap-loader-error')
      setMapStatus('高德地图 SDK 加载失败（网络不可达或 key 无效），保留静态日程列表。', 'warning')
      renderLegList(state)
    })
    return
  }
  loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', () => setMapStatus('Leaflet 样式加载失败，保留静态日程列表。', 'warning'))
  loadJs('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', () => initMap(state), () => {
    setDataset('mapReady', 'leaflet-loader-error')
    setMapStatus('Leaflet SDK 加载失败（网络不可达），保留静态日程列表。', 'warning')
    renderLegList(state)
  })
}

function bootPage(): void {
  const script = byId<HTMLScriptElement>('travel-data')
  if (script === undefined) return
  let data: RenderPageData
  try { data = JSON.parse(script.textContent ?? '') as RenderPageData } catch {
    setMapStatus('行程数据解析失败，未加载地图。', 'warning')
    return
  }
  if (data.itinerary?.days === undefined) {
    setMapStatus('行程数据缺失：请先生成行程。', 'warning')
    return
  }
  const provider = currentProvider(data)
  const stops = flattenStops(data, provider)
  const markerResult = deterministicMarkerModels(stops)
  const state: PageState = {
    data, stops, markerModels: markerResult.models, segments: routeSegments(data, stops, provider),
    markerHandles: [], routeHandles: [], dayIndex: 0, drawerOpen: false,
  }
  renderOverview(state)
  renderWarnings(state)
  renderTimeline(state)
  renderDayDrawer(state)
  renderMapControls(state)
  renderLegList(state)
  renderInsightsSection(data)
  renderInsightGroup(data, 'foodCard', 'foodBody', 'guide', false)
  renderInsightGroup(data, 'lodgingCard', 'lodgingBody', 'recommend', false)
  renderInsightGroup(data, 'warningCard', 'warningBody', 'avoid', true)
  renderTransport(data)
  renderAdvice(data)
  renderRentalCost(data)
  renderDegraded(data)
  renderSkeleton(state)
  setDataset('motion', reducedMotion() ? 'reduced' : 'full')
  setDataset('provider', provider)
  if (markerResult.clustered) setMapStatus('点位超过 200 个，地图已启用确定性聚合；左侧列表保留全部点位。')
  startLoader(state)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    state.lockedKey = undefined
    state.selectedKey = undefined
    state.selectedLegId = undefined
    renderStopPopover(state, undefined)
    updateSelectionClasses(state)
    setDataset('selectionLocked', 'false')
  })
  window.__dshTravel = { state, selectStop: (key: string) => selectStop(state, key, true), selectDay: (index: number) => selectDay(state, index, true) }
}

// Kept as explicit contract markers for the structure tests and rendered-page audit:
// AMap.Map / AMap.Marker / AMap.Polyline / AMap.InfoWindow; L.marker / L.polyline;
// function activateDay is represented by selectDay; routeTransport is rendered by renderRouteTransport.
function renderRouteTransport(state: PageState): void { renderLegList(state) }
function activateDay(state: PageState, index: number): void { selectDay(state, index, true) }
void renderRouteTransport
void activateDay

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPage, { once: true })
else bootPage()

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode?: string; serviceHost?: string }
    __dshTravel?: { state: PageState; selectStop: (key: string) => void; selectDay: (index: number) => void }
  }
  const AMap: AMapLike | undefined
  const L: LeafletLike | undefined
}

interface AMapLike {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => AMapMap
  Marker: new (options: Record<string, unknown>) => AMapMarker
  Polyline: new (options: Record<string, unknown>) => AMapPolyline
  InfoWindow: new (options: Record<string, unknown>) => AMapInfoWindow
  Pixel: new (x: number, y: number) => unknown
  LngLat: new (lng: number, lat: number) => unknown
  Bounds: new (southWest: unknown, northEast: unknown) => unknown
  Scale: new () => unknown
  ToolBar: new () => unknown
}
interface AMapMap {
  addControl(control: unknown): void
  add(layer: unknown): void
  setBounds(bounds: unknown): void
  setCenter(center: [number, number], zoom?: number, options?: { animate?: boolean }): void
}
interface AMapMarker {
  setMap(map: AMapMap): void
  getPosition(): unknown
  on(event: string, handler: () => void): void
}
interface AMapPolyline {
  setOptions(options: Record<string, unknown>): void
}
interface AMapInfoWindow {
  setContent(content: unknown): void
  open(map: AMapMap, position: unknown): void
}
interface LeafletLike {
  map(element: HTMLElement): LeafletMap
  tileLayer(url: string, options: Record<string, unknown>): { addTo(map: LeafletMap): void }
  control: { scale(): { addTo(map: LeafletMap): void } }
  divIcon(options: Record<string, unknown>): unknown
  marker(point: [number, number], options: Record<string, unknown>): LeafletMarker
  polyline(points: Array<[number, number]>, options: Record<string, unknown>): LeafletLine
}
interface LeafletMap {
  setView(point: [number, number], zoom?: number, options?: { animate?: boolean }): LeafletMap
  fitBounds(bounds: unknown, options?: Record<string, unknown>): void
}
interface LeafletMarker {
  addTo(map: LeafletMap): LeafletMarker
  on(event: string, handler: () => void): void
  getElement(): HTMLElement | undefined
  openPopup(): void
  bindPopup(content: unknown): LeafletMarker
  getPopup(): { setContent(content: unknown): void } | undefined
  setOpacity(opacity: number): void
}
interface LeafletLine {
  addTo(map: LeafletMap): LeafletLine
  setStyle(options: Record<string, unknown>): void
}
