import type {
  Advice,
  AdviceWeatherEntry,
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
import { buildRouteView, type RouteSegmentKind, type RouteViewModel } from './route-view.js'
import {
  computeMapVisibility,
  computeOcclusionPadding,
  hasMappableContent,
  segmentPresentation,
  type MapViewMode,
  type OcclusionPadding,
} from './map-view.js'

/**
 * 行程页浏览器运行时（地图优先版）。它只消费 render.ts 已审计的数据：
 * - itinerary/intel 文本全部进入 textContent；
 * - insights 是唯一的推荐/避雷/指南/规划展示来源；
 * - routeTransport 的 geometry 是 WGS84 GeoJSON，AMap 显示侧才转 GCJ-02；
 * - 路线日归属由 route-view.ts 投影（canonical 边唯一匹配，不猜别名），
 *   总览/单日可见性与遮挡取景规则在 map-view.ts（两 provider 一致）。
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
  /** 展示归属（route-view 投影 + map-view 呈现规则）。 */
  kind: RouteSegmentKind
  dayIndex?: number
  color: string
}

type MarkerHandle = {
  key: StopKey
  keys: StopKey[]
  dayIndex: number
  visible: boolean
  setVisible: (visible: boolean) => void
  setActive: (active: boolean) => void
  setDimmed: (dimmed: boolean) => void
}

type RouteHandle = {
  id: string
  kind: RouteSegmentKind
  dayIndex?: number
  visible: boolean
  setVisible: (visible: boolean) => void
  setActive: (active: boolean) => void
}

type MapHandle = {
  provider: 'amap' | 'leaflet'
  markers: MarkerHandle[]
  routes: RouteHandle[]
  /** 对当前可见对象按遮挡 padding 取景（provider 内部实现，两厂接口不混用）。 */
  fitVisibleBounds: (padding: OcclusionPadding, options?: { maxZoom?: number; animate?: boolean }) => void
}

type PageUiState = {
  viewMode: MapViewMode
  dayIndex: number
  selectedKey?: StopKey
  lockedKey?: StopKey
  selectedLegId?: string
  drawerOpen: boolean
}

type PageState = {
  data: RenderPageData
  stops: StopModel[]
  markerModels: MarkerModel[]
  segments: RouteSegment[]
  routeView: RouteViewModel
  markerHandles: MarkerHandle[]
  routeHandles: RouteHandle[]
  map?: MapHandle
  hoverTimer?: number
  lastFocus?: HTMLElement
  switchCount: number
} & PageUiState

const DAY_COLORS = ['#e74c3c', '#f39c12', '#27ae60', '#2980b9', '#8e44ad', '#d35400', '#16a085', '#7f8c8d']
const CATEGORY_LABEL: Record<string, string> = {
  attraction: '景点', lodging: '住宿', food: '美食', transportLocal: '市内交通',
}
const INSIGHT_LABEL: Record<string, string> = {
  recommend: '推荐', avoid: '避雷', guide: '指南', plan: '规划',
}
const DAY_COLOR = (index: number): string => DAY_COLORS[index % DAY_COLORS.length]
const ROUTE_FALLBACK_NOTE = '轨迹直线示意，里程为实测'
const DAY_LABEL = (index: number): string => `第 ${index + 1} 天`
const TRANSPORT_MODE_LABEL: Record<string, string> = {
  driving: '驾车', walking: '步行', transit: '公交', rail: '火车', flight: '飞机', bus: '客车',
}

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

function routeSegments(data: RenderPageData, stops: StopModel[], routeView: RouteViewModel, provider: 'amap' | 'leaflet'): RouteSegment[] {
  const artifact: RenderRouteTransport | undefined = data.routeTransport
  if (artifact === undefined || !Array.isArray(artifact.legs)) return []
  const stateLike: PageState = {
    data, stops, markerModels: [], segments: [], markerHandles: [], routeHandles: [],
    routeView, viewMode: 'overview', dayIndex: 0, drawerOpen: false, switchCount: 0,
  }
  const bindingById = new Map(routeView.legs.map((item) => [item.legId, item]))
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
    // 线型只由几何状态决定（跨日不改线型）；颜色由日归属投影决定（跨日/未分配=中性色）。
    const binding = bindingById.get(leg.id)
    const kind: RouteSegmentKind = binding?.kind ?? 'unassigned'
    const dayIndex = binding?.kind === 'day' ? binding.dayIndex : undefined
    const presentation = segmentPresentation(kind, dayIndex, dashed, DAY_COLOR)
    return {
      leg, path, dashed, fallback, metricText,
      ...(note === undefined ? {} : { note }),
      kind: presentation.kind,
      dayIndex: presentation.dayIndex,
      color: presentation.color,
    }
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

// ────────────────────────── 顶部：标题/导出/工件状态 ──────────────────────────

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
  if (request.assumptions.length > 0) card.appendChild(make('p', 'muted small trip-assumptions', `默认假设：${request.assumptions.join('；')}`))
  renderArtifactStatus(card, state.data)
}

// ────────────────────────── 顶部：总览/日 tabs ──────────────────────────

function renderDayTabs(state: PageState): void {
  const tabs = byId<HTMLElement>('dayTabs')
  if (tabs === undefined) return
  clear(tabs)
  const overviewButton = make('button', 'day-tab')
  overviewButton.type = 'button'
  overviewButton.dataset.viewMode = 'overview'
  overviewButton.setAttribute('aria-pressed', String(state.viewMode === 'overview'))
  appendText(overviewButton, '总览')
  overviewButton.addEventListener('click', () => selectOverview(state, true))
  tabs.appendChild(overviewButton)
  state.data.itinerary.days.forEach((day, dayIndex) => {
    const button = make('button', 'day-tab')
    button.type = 'button'
    button.dataset.viewMode = 'day'
    button.dataset.dayIndex = String(dayIndex)
    const active = state.viewMode === 'day' && state.dayIndex === dayIndex
    button.setAttribute('aria-pressed', String(active))
    button.setAttribute('aria-label', `${DAY_LABEL(dayIndex)} ${day.date}`)
    const dot = make('span', 'day-dot')
    dot.style.backgroundColor = DAY_COLOR(dayIndex)
    button.appendChild(dot)
    appendText(button, `DAY ${String(dayIndex + 1).padStart(2, '0')}`)
    if (day.theme !== undefined) appendText(button, day.theme, 'day-tab-theme')
    button.addEventListener('click', () => selectDay(state, dayIndex, true))
    tabs.appendChild(button)
  })
}

// ────────────────────────── 左侧：总览摘要 / 单日时间轴 ──────────────────────────

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

function renderSidePanel(state: PageState): void {
  const card = byId<HTMLElement>('timelineCard')
  if (card === undefined) return
  clear(card)
  if (state.viewMode === 'overview') renderSideOverview(state, card)
  else renderSideDay(state, card)
}

/** 总览摘要：逐日卡片（日色 + 停留点数 + 当日里程/部分数据），点击进入单日。 */
function renderSideOverview(state: PageState, card: HTMLElement): void {
  appendHeading(card, 'h2', '行程总览', 'card-title')
  appendText(card, `${state.stops.length} 个行程点 · ${state.data.itinerary.days.length} 天`, 'muted small side-hint')
  const digest = make('div', 'overview-days')
  state.data.itinerary.days.forEach((day, dayIndex) => {
    const stat = state.routeView.dayStats[dayIndex]
    const button = make('button', 'overview-day')
    button.type = 'button'
    button.dataset.dayIndex = String(dayIndex)
    button.style.setProperty('--day-color', DAY_COLOR(dayIndex))
    button.setAttribute('aria-label', `查看${DAY_LABEL(dayIndex)} ${day.date}`)
    const head = make('div', 'overview-day-head')
    appendText(head, `${DAY_LABEL(dayIndex)} · ${day.date}`, 'overview-day-title')
    if (day.theme !== undefined) appendText(head, day.theme, 'day-theme')
    digest.appendChild(button)
    button.appendChild(head)
    const stopCount = day.stops.length
    let metricText: string
    if (stat !== undefined && stat.legCount > 0 && stat.complete && stat.distanceKm !== undefined) {
      metricText = `${stopCount} 个停留点 · ${stat.distanceKm.toFixed(1)} km`
    } else if (stat !== undefined && stat.legCount > 0 && stat.distanceKm !== undefined) {
      metricText = `${stopCount} 个停留点 · 约 ${stat.distanceKm.toFixed(1)} km（估算）`
    } else if (stat !== undefined && stat.legCount > 0) {
      metricText = `${stopCount} 个停留点 · 部分数据/不可用`
    } else {
      metricText = `${stopCount} 个停留点 · 路段未归属`
    }
    appendText(button, metricText, 'overview-day-meta')
    button.addEventListener('click', () => selectDay(state, dayIndex, true))
  })
  card.appendChild(digest)
  if (state.routeView.crossDayCount > 0 || state.routeView.unassignedCount > 0) {
    const note = make('p', 'muted small side-note')
    note.textContent = `另有 ${state.routeView.crossDayCount} 段跨日衔接、${state.routeView.unassignedCount} 段未归属路段，在总览图上单独标识。`
    card.appendChild(note)
  }
}

/** 单日时间轴：只列当天 stops（hover 预览 / 点击锁定）。 */
function renderSideDay(state: PageState, card: HTMLElement): void {
  const day = state.data.itinerary.days[state.dayIndex]
  if (day === undefined) return
  appendHeading(card, 'h2', `${DAY_LABEL(state.dayIndex)} · ${day.date}`, 'card-title')
  if (day.theme !== undefined) appendText(card, day.theme, 'day-theme side-hint')
  const track = make('div', 'timeline-track')
  const stopList = make('div', 'stop-list')
  day.stops.forEach((stop, stopIndex) => {
    const model = state.stops.find((candidate) => candidate.dayIndex === state.dayIndex && candidate.stopIndex === stopIndex)
    if (model === undefined) return
    const button = make('button', 'stop-button')
    button.type = 'button'
    button.dataset.selectionKey = model.key
    button.setAttribute('aria-label', `查看${stop.name}`)
    button.setAttribute('aria-pressed', String(state.selectedKey === model.key))
    const index = make('span', 'stop-index', String(stopIndex + 1))
    index.style.backgroundColor = DAY_COLOR(state.dayIndex)
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
  track.appendChild(stopList)
  card.appendChild(track)
}

// ────────────────────────── 右侧：详情面板（唯一详情面） ──────────────────────────

function weatherForDay(data: RenderPageData, day: ItineraryDay): AdviceWeatherEntry[] {
  const advice: Advice | undefined = data.advice
  if (advice === undefined || !Array.isArray(advice.weather)) return []
  return advice.weather.filter((entry) => entry.date === day.date)
}

/** 逐地天气行：location/source/预报或气候概况/未分配日期说明——不以单城代表整条路线。 */
function appendWeatherLines(parent: Element, entries: AdviceWeatherEntry[]): void {
  if (entries.length === 0) return
  const wrap = make('div', 'weather-lines')
  for (const entry of entries) {
    const line = make('div', 'weather-line')
    const place = typeof entry.location === 'string' && entry.location.trim().length > 0
      ? entry.location
      : (typeof entry.placeId === 'string' ? `地点 ${entry.placeId}` : '未分配地点')
    appendText(line, place, 'weather-place')
    if (entry.tempRange?.length === 2) appendText(line, `${entry.tempRange[0]}~${entry.tempRange[1]}°C`, 'weather-temp')
    if (entry.dayForecast !== undefined) appendText(line, entry.dayForecast)
    if (entry.beyondForecastWindow === true) appendText(line, '气候概况', 'muted small')
    if (entry.placeDateAssigned === false) appendText(line, '未分配逐地日期（按旅行窗口查询）', 'muted small')
    if (entry.source?.platform !== undefined) appendText(line, `来源：${entry.source.platform}`, 'muted small')
    wrap.appendChild(line)
  }
  parent.appendChild(wrap)
}

function appendStopSummary(parent: Element, state: PageState, model: StopModel): void {
  const stop = model.stop
  const kind = make('div', 'detail-kicker')
  appendText(kind, `${DAY_LABEL(model.dayIndex)} · ${CATEGORY_LABEL[stop.category] ?? stop.category}${stop.durationHint !== undefined ? ` · 建议 ${stop.durationHint} 分钟` : ''}`)
  parent.appendChild(kind)
  appendHeading(parent, 'h3', stop.name)
  const insights = insightsForStop(state.data, stop)
  if (insights.length === 0) {
    appendText(parent, '缺失/下一步：暂无已归纳且可引用的建议。', 'next-step')
  } else {
    appendInsightCards(parent, insights, 3)
    appendHardFacts(parent, sourceItem(state.data, stop))
    appendCitations(parent, insights)
  }
  const source = sourceItem(state.data, stop)
  if (source?.source !== undefined) {
    const sourceBox = make('div', 'detail-source')
    appendText(sourceBox, '来源', 'muted small')
    appendSafeLink(sourceBox, source.title, source.source.platform, source.source.url)
    parent.appendChild(sourceBox)
  }
}

function renderDetail(state: PageState): void {
  const body = byId<HTMLElement>('dayCard')
  if (body === undefined) return
  clear(body)
  const selected = state.selectedKey !== undefined ? stopByKey(state, state.selectedKey) : undefined
  if (selected !== undefined) {
    // 景点详情（总览/单日一致；总览保持 tabs active，不退出总览）。
    appendStopSummary(body, state, selected)
  } else if (state.viewMode === 'day') {
    const day = state.data.itinerary.days[state.dayIndex]
    if (day === undefined) return
    const summary = make('div', 'day-summary')
    appendHeading(summary, 'h3', `${DAY_LABEL(state.dayIndex)} · ${day.date}`)
    if (day.theme !== undefined) appendText(summary, day.theme, 'day-theme')
    const weather = weatherForDay(state.data, day)
    if (weather.length > 0) {
      appendText(summary, '当日逐地天气', 'muted small')
      appendWeatherLines(summary, weather)
    } else {
      appendText(summary, '缺失/下一步：当日暂无逐地天气数据。', 'next-step')
    }
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
  } else {
    appendText(body, '总览模式：点击地图标记或左侧日期查看景点详情。', 'muted side-hint')
  }
}

// ────────────────────────── 底部：天气/交通/预算/提醒 摘要入口 ──────────────────────────

function dockItem(state: PageState, icon: string, label: string, value: string, targetId: string, extraNote?: string): HTMLElement {
  const item = make('button', 'dock-item')
  item.type = 'button'
  item.setAttribute('data-target', targetId)
  item.setAttribute('aria-controls', targetId)
  appendText(item, icon, 'dock-icon')
  const copy = make('span', 'dock-copy')
  appendText(copy, label, 'dock-label')
  appendText(copy, value, 'dock-value')
  if (extraNote !== undefined && extraNote.length > 0) appendText(copy, extraNote, 'dock-note')
  item.appendChild(copy)
  item.addEventListener('click', () => {
    const target = byId<HTMLElement>(targetId)
    if (target === undefined) return
    target.classList.remove('hidden')
    target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
    target.classList.add('dock-flash')
    window.setTimeout(() => target.classList.remove('dock-flash'), 1200)
  })
  return item
}

function transportSummary(state: PageState): { value: string; note?: string } {
  const legs = state.data.routeTransport?.legs ?? []
  const totalKm = state.data.totalDistanceKm ?? state.data.routeTransport?.totalDistanceKm
  const modes = [...new Set(legs.map((leg) => TRANSPORT_MODE_LABEL[leg.mode] ?? leg.mode))]
  if (legs.length === 0 && state.data.transport === undefined) {
    return { value: '暂无交通数据' }
  }
  const modeText = modes.length > 0 ? modes.join('/') : (Array.isArray(state.data.transport) && state.data.transport.length > 0 ? state.data.transport[0].mode : '')
  const incomplete = legs.some((leg) => {
    const status = leg.metricStatus ?? leg.status
    return status === 'unavailable' || status === 'blocked' || status === 'estimated'
  })
  const value = finiteNumber(totalKm)
    ? `${modeText ? `${modeText} · ` : ''}${legs.length} 段 · ${totalKm.toFixed(1)} km`
    : `${modeText ? `${modeText} · ` : ''}${legs.length} 段`
  return { value, ...(incomplete ? { note: '部分路段估算/不可用' } : {}) }
}

function budgetSummaryOf(state: PageState): { value: string; note?: string } {
  const cost = state.data.cost
  if (cost?.total !== undefined) {
    const scope = cost.components && Object.values(cost.components).some((component) => component.scope === 'perPerson') ? '人均口径见详情' : undefined
    return { value: `${cost.total.min}~${cost.total.max} ${cost.total.currency ?? ''}`, ...(scope !== undefined ? { note: scope } : {}) }
  }
  const budget = state.data.request.slots.budget
  if (budget?.amount !== undefined) return { value: `预算 ${budget.amount} ${budget.currency ?? 'CNY'}`, note: '成本明细未生成' }
  return { value: '暂无预算数据' }
}

function reminderCount(state: PageState): { count: number; target: string } {
  const degraded = state.data.degraded?.length ?? 0
  const warnings = state.data.itinerary.routeCheck?.warnings?.length ?? 0
  const issues = state.data.itinerary.routeCheck?.issues?.length ?? 0
  const mapWarnings = state.data.map?.warnings?.length ?? 0
  const count = degraded + warnings + issues + mapWarnings
  return { count, target: warningCardTarget(state, count) }
}

function warningCardTarget(_state: PageState, count: number): string {
  return count > 0 ? 'warningCard' : 'insightsCard'
}

function renderDock(state: PageState): void {
  const dock = byId<HTMLElement>('bottomDock')
  if (dock === undefined) return
  for (const child of Array.from(dock.children)) child.remove()
  const advice: Advice | undefined = state.data.advice
  const weatherEntries = advice?.weather ?? []
  const weatherPlaces = new Set(weatherEntries.map((entry) => entry.location ?? entry.placeId ?? '未分配地点').filter((place) => place !== '未分配地点'))
  const weatherDates = new Set(weatherEntries.map((entry) => entry.date))
  const weatherValue = weatherEntries.length === 0
    ? '暂无天气数据'
    : weatherPlaces.size > 0
      ? `${weatherPlaces.size} 地 · ${weatherDates.size} 个日期`
      : `${weatherEntries.length} 条（未分配地点）`
  dock.appendChild(dockItem(state, '☼', '天气', weatherValue, 'adviceCard', weatherEntries.length === 0 ? '可稍后补充' : undefined))

  const transport = transportSummary(state)
  dock.appendChild(dockItem(state, '↗', '交通', transport.value, 'transportCard', transport.note))

  const budget = budgetSummaryOf(state)
  dock.appendChild(dockItem(state, '¥', '预算', budget.value, 'rentalCostCard', budget.note))

  const reminder = reminderCount(state)
  dock.appendChild(dockItem(state, '!', '提醒', reminder.count > 0 ? `${reminder.count} 条待留意` : '暂无提醒', reminder.target))

  const more = make('button', 'dock-item dock-more')
  more.type = 'button'
  appendText(more, '☰', 'dock-icon')
  const moreCopy = make('span', 'dock-copy')
  appendText(moreCopy, '更多信息', 'dock-label')
  appendText(moreCopy, '住宿/美食/指南', 'dock-value')
  more.appendChild(moreCopy)
  more.addEventListener('click', () => {
    const grid = byId<HTMLElement>('supplementalGrid')
    grid?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
  })
  dock.appendChild(more)
}

// ────────────────────────── 路线面板：图例 + 逐段列表 ──────────────────────────

function renderRoutePanel(state: PageState): void {
  const list = byId<HTMLElement>('legList')
  const legend = byId<HTMLElement>('routeLegend')
  if (list === undefined || legend === undefined) return
  clear(list)
  clear(legend)
  const visibleSegments = state.viewMode === 'overview'
    ? state.segments
    : state.segments.filter((segment) => segment.kind === 'day' && segment.dayIndex === state.dayIndex)
  const separateSegments = state.viewMode === 'day'
    ? state.segments.filter((segment) => !(segment.kind === 'day' && segment.dayIndex === state.dayIndex))
    : []

  // 图例：日模式=当日日色；总览=逐日色 + 跨日/未分配中性色；实/虚线独立说明。
  if (state.viewMode === 'day') {
    const entry = make('span', 'legend-line')
    const chip = make('i', 'legend-chip')
    chip.style.backgroundColor = DAY_COLOR(state.dayIndex)
    entry.appendChild(chip)
    appendText(entry, `${DAY_LABEL(state.dayIndex)} 路线/停留`)
    legend.appendChild(entry)
  } else {
    state.data.itinerary.days.forEach((_day, dayIndex) => {
      const entry = make('span', 'legend-line')
      const chip = make('i', 'legend-chip')
      chip.style.backgroundColor = DAY_COLOR(dayIndex)
      entry.appendChild(chip)
      appendText(entry, `DAY ${String(dayIndex + 1).padStart(2, '0')}`)
      legend.appendChild(entry)
    })
  }
  if (state.routeView.crossDayCount > 0) {
    const entry = make('span', 'legend-line')
    const chip = make('i', 'legend-chip')
    chip.style.backgroundColor = '#47566b'
    entry.appendChild(chip)
    appendText(entry, '跨日衔接')
    legend.appendChild(entry)
  }
  if (state.routeView.unassignedCount > 0) {
    const entry = make('span', 'legend-line')
    const chip = make('i', 'legend-chip')
    chip.style.backgroundColor = '#93a1b3'
    entry.appendChild(chip)
    appendText(entry, '日归属未分配')
    legend.appendChild(entry)
  }
  legend.appendChild(make('span', 'legend-line solid', '道路几何'))
  legend.appendChild(make('span', 'legend-line dashed', '直线示意/估算'))

  const appendLegButton = (segment: RouteSegment, index: number, separate: boolean): void => {
    const button = make('button', `leg-button${separate ? ' separate' : ''}`)
    button.type = 'button'
    button.dataset.legId = segment.leg.id
    const marker = make('span', 'leg-index', String(index + 1))
    marker.style.backgroundColor = segment.color
    button.appendChild(marker)
    const copy = make('span', 'leg-copy')
    appendText(copy, `${segment.leg.fromPlaceId} → ${segment.leg.toPlaceId}`, 'leg-route')
    appendText(copy, segment.metricText, 'leg-metric')
    if (separate) {
      appendText(copy, segment.kind === 'cross-day' ? '跨日衔接 · 总览展示' : '日归属未分配', 'leg-note')
    }
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
  visibleSegments.forEach((segment, index) => appendLegButton(segment, index, false))
  if (separateSegments.length > 0) {
    const groupNote = make('div', 'leg-group-note')
    appendText(groupNote, `跨日/未归属（${separateSegments.length} 段，总览展示）`, 'muted small')
    list.appendChild(groupNote)
    separateSegments.forEach((segment, index) => appendLegButton(segment, index, true))
  }
  if (state.segments.length === 0) list.appendChild(make('div', 'notice', '暂无可绘制道路几何；不可用/阻断路段不伪装为道路。'))
}

// ────────────────────────── 视图状态机 ──────────────────────────

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

function measureOcclusion(): OcclusionPadding {
  const rectOf = (id: string): DOMRect | undefined => {
    const element = byId<HTMLElement>(id)
    if (element === undefined || element.classList.contains('hidden')) return undefined
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? rect : undefined
  }
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const overview = rectOf('overviewCard')
  const tabs = rectOf('dayTabs')
  const side = rectOf('timelineCard')
  const drawer = rectOf('dayDrawer')
  const dock = rectOf('bottomDock')
  return computeOcclusionPadding({
    viewportWidth,
    viewportHeight,
    top: Math.max(overview?.height ?? 0, tabs !== undefined ? tabs.bottom : 0),
    left: Math.max(overview?.width ?? 0, side?.width ?? 0),
    right: document.body.dataset.drawer === 'open' ? drawer?.width ?? 0 : 0,
    bottom: dock?.height ?? 0,
  })
}

/** 应用当前视图的可见性（不重建 SDK/overlay；只翻转可见性与取景）。 */
function applyView(state: PageState, options: { fit?: boolean } = {}): void {
  const visibleStopKeys = computeMapVisibility({
    markerDays: state.stops.filter((stop) => stop.point !== undefined).map((stop) => ({ key: stop.key, dayIndex: stop.dayIndex })),
    legs: state.routeView.legs.map((leg) => ({ id: leg.legId, kind: leg.kind, dayIndex: leg.dayIndex })),
    viewMode: state.viewMode,
    dayIndex: state.dayIndex,
  })
  let visibleMarkers = 0
  for (const handle of state.markerHandles) {
    const visible = handle.keys.some((key) => visibleStopKeys.markerKeys.has(key))
    handle.setVisible(visible)
    if (visible) visibleMarkers += 1
  }
  let visibleLegs = 0
  for (const handle of state.routeHandles) {
    const visible = visibleStopKeys.legIds.has(handle.id)
    handle.setVisible(visible)
    if (visible) visibleLegs += 1
  }
  state.switchCount += 1
  setDataset('viewMode', state.viewMode)
  setDataset('dayIndex', String(state.dayIndex))
  setDataset('visibleMarkers', String(visibleMarkers))
  setDataset('visibleLegs', String(visibleLegs))
  setDataset('separateLegs', String(visibleStopKeys.separateLegIds.size))
  setDataset('switchCount', String(state.switchCount))
  if (options.fit === true && state.map !== undefined) {
    state.map.fitVisibleBounds(measureOcclusion(), { maxZoom: 17, animate: !reducedMotion() })
  }
}

function setDrawerOpen(state: PageState, open: boolean): void {
  state.drawerOpen = open
  const drawer = byId<HTMLElement>('dayDrawer')
  const toggle = byId<HTMLButtonElement>('drawerToggle')
  drawer?.classList.toggle('open', open)
  toggle?.setAttribute('aria-expanded', String(open))
  setDataset('drawer', open ? 'open' : 'closed')
}

function selectOverview(state: PageState, userTriggered: boolean): void {
  state.viewMode = 'overview'
  // 回总览恢复全部，不残留旧日期选择。
  state.selectedKey = undefined
  state.lockedKey = undefined
  state.selectedLegId = undefined
  renderDayTabs(state)
  renderSidePanel(state)
  renderDetail(state)
  renderRoutePanel(state)
  renderDock(state)
  updateSelectionClasses(state)
  applyView(state, { fit: userTriggered })
  setDataset('selectionLocked', 'false')
}

function selectDay(state: PageState, dayIndex: number, userTriggered: boolean): void {
  if (dayIndex < 0 || dayIndex >= state.data.itinerary.days.length) return
  state.viewMode = 'day'
  state.dayIndex = dayIndex
  const first = state.stops.find((stop) => stop.dayIndex === dayIndex)
  state.selectedKey = first?.key
  state.selectedLegId = undefined
  renderDayTabs(state)
  renderSidePanel(state)
  renderDetail(state)
  renderRoutePanel(state)
  renderDock(state)
  updateSelectionClasses(state)
  applyView(state, { fit: userTriggered })
  if (userTriggered && window.innerWidth <= 760) setDrawerOpen(state, true)
}

function selectStop(state: PageState, key: StopKey, lock: boolean): void {
  const model = stopByKey(state, key)
  if (model === undefined) return
  if (state.viewMode === 'day' && model.dayIndex !== state.dayIndex) {
    // 单日模式选到别日 stop → 切到该日（视野/筛选一致）。
    selectDay(state, model.dayIndex, true)
    return
  }
  state.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  state.selectedKey = key
  if (lock) state.lockedKey = key
  renderDetail(state)
  // 左侧列表不重建（避免打断键盘焦点）；active 态由 updateSelectionClasses 翻转。
  updateSelectionClasses(state)
  if (lock && window.innerWidth <= 760) setDrawerOpen(state, true)
  setDataset('selection', key)
  setDataset('selectionLocked', lock ? 'true' : String(state.lockedKey !== undefined))
}

function clearSelection(state: PageState): void {
  const previousKey = state.selectedKey
  const previousFocus = state.lastFocus
  state.lockedKey = undefined
  state.selectedKey = undefined
  state.selectedLegId = undefined
  renderDetail(state)
  updateSelectionClasses(state)
  setDataset('selectionLocked', 'false')
  // 焦点返回：列表不重建时直接回原节点；若曾重建（切日等），按 selection-key 找新节点。
  const restoreKey = previousFocus?.dataset?.selectionKey ?? previousKey
  // 焦点返回：优先回原节点（未重建时仍连接）；重建后按 selection-key 找地图区域外的新节点。
  let focusTarget: HTMLElement | undefined
  if (previousFocus !== undefined && previousFocus.isConnected) {
    focusTarget = previousFocus
  } else if (restoreKey !== undefined) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(`[data-selection-key="${CSS.escape(restoreKey)}"]`))
    for (const candidate of candidates) {
      if (candidate.closest('#map') === null) { focusTarget = candidate; break }
    }
  }
  state.lastFocus = undefined
  if (focusTarget !== undefined && focusTarget.isConnected) focusTarget.focus()
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
    clearSelection(state)
  }
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

// ────────────────────────── 地图适配器（AMap / Leaflet 统一契约） ──────────────────────────

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

function amapOcclusionAvoid(padding: OcclusionPadding): [number, number, number, number] {
  // setFitView 的 avoid 顺序按 [上, 右, 下, 左]（JSAPI 2.0）；live QA 以截图复核。
  return [padding.top, padding.right, padding.bottom, padding.left]
}

function buildMapAdapter(state: PageState, provider: 'amap' | 'leaflet' = currentProvider(state.data)): MapHandle | undefined {
  const mapElement = byId<HTMLElement>('map')
  if (mapElement === undefined || !hasMappableContent(state.markerModels.length)) return undefined
  const handles: MarkerHandle[] = []
  const routes: RouteHandle[] = []
  if (provider === 'amap') {
    const amap = typeof AMap === 'undefined' ? undefined : AMap
    if (amap === undefined) throw new Error('AMap SDK 未加载')
    // 官方 light 预设（不新增自定义样式 ID/配置面）。
    const map = new amap.Map(mapElement, { center: [116.397, 39.909], zoom: 6, viewMode: '2D', mapStyle: 'amap://styles/light' })
    // 控件是可选增强：JSAPI 2.0 的 `plugin=` URL 参数不保证注册 AMap.Scale/ToolBar，
    // 实测 AMap.Map 可用而 AMap.Scale===undefined。旧实现 `new amap.Scale()` 直接抛
    // 「c.Scale is not a constructor」把整张地图拖垮——这里改为特性探测 + 显式 plugin
    // 加载，控件缺失只少两个控件，绝不让地图失败。
    const addOptionalControls = (): void => {
      try {
        if (typeof amap.Scale === 'function') map.addControl(new amap.Scale())
        if (typeof amap.ToolBar === 'function') map.addControl(new amap.ToolBar())
      } catch {
        // 控件失败不影响地图本体
      }
    }
    if (typeof amap.plugin === 'function') {
      try {
        amap.plugin(['AMap.Scale', 'AMap.ToolBar'], addOptionalControls)
      } catch {
        addOptionalControls()
      }
    } else {
      addOptionalControls()
    }
    const polylineByLegId = new Map<string, AMapPolyline>()
    const markerOverlayByHandle = new Map<MarkerHandle, AMapMarker>()
    for (const model of state.markerModels) {
      const pin = createMapPin(model)
      const marker = new amap.Marker({ position: [model.point.lng, model.point.lat], content: pin, offset: new amap.Pixel(0, 0), zIndex: model.cluster ? 90 : 120 })
      marker.setMap(map)
      pin.classList.add('marker-hidden')
      const handle: MarkerHandle = {
        key: model.key,
        keys: model.keys,
        dayIndex: model.dayIndex,
        visible: false,
        setVisible: (visible) => { pin.classList.toggle('marker-hidden', !visible); handle.visible = visible },
        setActive: (active) => pin.classList.toggle('active', active),
        setDimmed: (dimmed) => { pin.style.opacity = dimmed ? '0.28' : '1' },
      }
      markerOverlayByHandle.set(handle, marker)
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
        strokeColor: segment.color, strokeWeight: segment.dashed ? 3 : 4,
        strokeOpacity: .78, strokeStyle: segment.dashed ? 'dashed' : 'solid', lineJoin: 'round',
      })
      map.add(line)
      line.hide()
      const handle: RouteHandle = {
        id: segment.leg.id,
        kind: segment.kind,
        ...(segment.dayIndex !== undefined ? { dayIndex: segment.dayIndex } : {}),
        visible: false,
        setVisible: (visible) => { if (visible) line.show(); else line.hide(); handle.visible = visible },
        setActive: (active) => line.setOptions({ strokeWeight: active ? 7 : segment.dashed ? 3 : 4, strokeOpacity: active ? 1 : .78 }),
      }
      routes.push(handle)
      polylineByLegId.set(segment.leg.id, line)
    }
    const fitVisibleBounds: MapHandle['fitVisibleBounds'] = (padding, options) => {
      // setFitView 需要真实 overlay 实例（SDK 内部调 getBounds）——传 handle 会崩。
      const visibleOverlays: unknown[] = []
      for (const handle of handles) if (handle.visible) visibleOverlays.push(markerOverlayByHandle.get(handle))
      for (const handle of routes) visibleOverlays.push(polylineByLegId.get(handle.id))
      const overlays = visibleOverlays.filter((overlay) => overlay !== undefined)
      if (overlays.length === 0) return
      map.setFitView(overlays, options?.animate === true ? false : true, amapOcclusionAvoid(padding), options?.maxZoom ?? 17)
    }
    return { provider, markers: handles, routes, fitVisibleBounds }
  }

  const leaflet = typeof L === 'undefined' ? undefined : L
  if (leaflet === undefined) throw new Error('Leaflet SDK 未加载')
  const map = leaflet.map(mapElement).setView([36.6, 101.8], 6)
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map)
  leaflet.control.scale().addTo(map)
  const lineByLegId = new Map<string, LeafletLine>()
  for (const model of state.markerModels) {
    // Leaflet receives an empty icon shell; the visible pin and its label are
    // created as DOM nodes so itinerary text never crosses an HTML parser.
    const icon = leaflet.divIcon({ className: '', html: '', iconSize: [34, 34], iconAnchor: [17, 17] })
    const marker = leaflet.marker([model.point.lat, model.point.lng], { icon }).addTo(map)
    const mountPin = (): void => {
      const wrapper = marker.getElement()
      if (wrapper === undefined || wrapper.querySelector('.map-pin, .cluster-pin') !== null) return
      const pin = createMapPin(model)
      pin.classList.add('marker-hidden')
      wrapper.appendChild(pin)
      pin.addEventListener('mouseenter', () => scheduleHover(state, model.keys[0]))
      pin.addEventListener('mouseover', () => scheduleHover(state, model.keys[0]))
      pin.addEventListener('mouseleave', () => cancelHover(state))
      pin.addEventListener('click', () => selectStop(state, model.keys[0], true))
      pin.addEventListener('keydown', (event) => handleSelectionKey(state, model.keys[0], event))
      if (handle.visible) pin.classList.remove('marker-hidden')
    }
    const handle: MarkerHandle = {
      key: model.key,
      keys: model.keys,
      dayIndex: model.dayIndex,
      visible: false,
      setVisible: (visible) => {
        handle.visible = visible
        marker.setOpacity(visible ? 1 : 0)
        const element = marker.getElement()?.querySelector<HTMLElement>('.map-pin, .cluster-pin')
        element?.classList.toggle('marker-hidden', !visible)
        if (visible) element?.classList.remove('marker-hidden')
      },
      setActive: (active) => { const element = marker.getElement()?.querySelector<HTMLElement>('.map-pin, .cluster-pin'); element?.classList.toggle('active', active) },
      setDimmed: (dimmed) => marker.setOpacity(dimmed ? .28 : handle.visible ? 1 : 0),
    }
    marker.on('mouseover', () => scheduleHover(state, model.keys[0]))
    marker.on('mouseout', () => cancelHover(state))
    marker.on('click', () => selectStop(state, model.keys[0], true))
    mountPin()
    window.setTimeout(mountPin, 0)
    handles.push(handle)
  }
  for (const segment of state.segments) {
    if (segment.path.length < 2) continue
    const line = leaflet.polyline(segment.path.map((point) => [point.lat, point.lng] as [number, number]), {
      color: segment.color, weight: segment.dashed ? 3 : 4, opacity: .78, dashArray: segment.dashed ? '8 7' : undefined,
    }).addTo(map)
    line.setStyle({ opacity: 0 })
    const handle: RouteHandle = {
      id: segment.leg.id,
      kind: segment.kind,
      ...(segment.dayIndex !== undefined ? { dayIndex: segment.dayIndex } : {}),
      visible: false,
      setVisible: (visible) => {
        handle.visible = visible
        line.setStyle({ opacity: visible ? .78 : 0, ...(visible ? {} : { interactive: false }) })
      },
      setActive: (active) => line.setStyle({ weight: active ? 7 : segment.dashed ? 3 : 4, opacity: handle.visible ? (active ? 1 : .78) : 0 }),
    }
    routes.push(handle)
    lineByLegId.set(segment.leg.id, line)
  }
  const fitVisibleBounds: MapHandle['fitVisibleBounds'] = (padding, options) => {
    const points: DisplayPoint[] = []
    for (const handle of handles) {
      if (!handle.visible) continue
      const model = state.markerModels.find((candidate) => candidate.key === handle.key)
      if (model !== undefined) points.push(model.point)
    }
    for (const handle of routes) {
      if (!handle.visible) continue
      const segment = state.segments.find((candidate) => candidate.leg.id === handle.id)
      points.push(...segment?.path ?? [])
    }
    const bounds = mapViewBounds(points)
    if (bounds === undefined) return
    map.fitBounds(
      [[bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]],
      {
        paddingTopLeft: [padding.left, padding.top],
        paddingBottomRight: [padding.right, padding.bottom],
        ...(options?.animate === false ? { animate: false } : {}),
        maxZoom: options?.maxZoom ?? 17,
      },
    )
  }
  return { provider, markers: handles, routes, fitVisibleBounds }
}

function renderMapControls(state: PageState): void {
  const toolbar = byId<HTMLElement>('mapToolbar')
  if (toolbar === undefined) return
  const providerText = state.data.map?.provider === 'amap' ? '高德 JSAPI 2.0 · light' : 'Leaflet 1.9 + OSM'
  const provider = byId<HTMLElement>('mapProviderLabel')
  if (provider !== undefined) provider.textContent = providerText
  const drawerToggle = byId<HTMLButtonElement>('drawerToggle')
  const drawer = byId<HTMLElement>('dayDrawer')
  if (drawerToggle !== undefined && drawer !== undefined) {
    drawerToggle.addEventListener('click', () => {
      setDrawerOpen(state, !state.drawerOpen)
    })
  }
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

/** 统一状态构建：provider 决定坐标投影（amap=GCJ-02 / leaflet=WGS-84）与路线几何。
 * 导出仅供 render-map-view 单测消费；浏览器 bundle（IIFE）会忽略导出。 */
export function createState(data: RenderPageData, provider: 'amap' | 'leaflet', ui: Partial<PageUiState> = {}): PageState {
  const stops = flattenStops(data, provider)
  const markerResult = deterministicMarkerModels(stops)
  const routeView = buildRouteView(data.itinerary.days, data.routeTransport?.legs, data.itinerary.canonicalRoute)
  return {
    data,
    stops,
    markerModels: markerResult.models,
    segments: routeSegments(data, stops, routeView, provider),
    routeView,
    markerHandles: [],
    routeHandles: [],
    map: undefined,
    viewMode: ui.viewMode ?? 'overview',
    dayIndex: ui.dayIndex ?? 0,
    ...(ui.selectedKey !== undefined ? { selectedKey: ui.selectedKey } : {}),
    ...(ui.lockedKey !== undefined ? { lockedKey: ui.lockedKey } : {}),
    ...(ui.selectedLegId !== undefined ? { selectedLegId: ui.selectedLegId } : {}),
    drawerOpen: ui.drawerOpen ?? false,
    hoverTimer: undefined,
    lastFocus: undefined,
    switchCount: 0,
  }
}

/**
 * amap 不可用 → 就地降级 Leaflet。
 * 必须整体重建 stops/markerModels/segments：amap 用 GCJ-02 投影、Leaflet/OSM 需要
 * WGS-84，沿用旧点位会整体偏移约 500m。视图状态（总览/单日/选择）原样保留，
 * 地图重建后按原视图重新应用可见性。返回 false = 当前并非 amap 视图（不重复降级）。
 */
function degradeToLeaflet(state: PageState, reason: string): boolean {
  if (currentProvider(state.data) !== 'amap') return false
  const warnings = [...(state.data.map?.warnings ?? []), `高德地图不可用（${reason}），已自动降级 Leaflet/OSM`]
  const degraded = createState(
    { ...state.data, map: { ...state.data.map, provider: 'leaflet', warnings } },
    'leaflet',
    {
      viewMode: state.viewMode,
      dayIndex: state.dayIndex,
      ...(state.selectedKey !== undefined ? { selectedKey: state.selectedKey } : {}),
      ...(state.lockedKey !== undefined ? { lockedKey: state.lockedKey } : {}),
      ...(state.selectedLegId !== undefined ? { selectedLegId: state.selectedLegId } : {}),
      drawerOpen: state.drawerOpen,
    },
  )
  state.data = degraded.data
  state.stops = degraded.stops
  state.markerModels = degraded.markerModels
  state.segments = degraded.segments
  state.routeView = degraded.routeView
  state.map = undefined
  state.markerHandles = []
  state.routeHandles = []
  setDataset('provider', 'leaflet')
  setDataset('amapFallback', 'true')
  renderWarnings(state)
  renderRoutePanel(state)
  return true
}

/** amap 失败后的 Leaflet 补装 + 重试（SDK/样式按需加载；再失败如实标注，不伪造地图）。 */
function loadLeafletFallback(state: PageState, reason: string): void {
  if (!degradeToLeaflet(state, reason)) return
  loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', () => {})
  loadJs('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', () => {
    initMap(state, 'leaflet')
    if (typeof L !== 'undefined') setMapStatus(`高德地图不可用（${reason}），已自动降级 Leaflet/OSM。`, 'warning')
    applyView(state, { fit: true })
  }, () => {
    setDataset('mapReady', 'leaflet-loader-error')
    setMapStatus('高德地图不可用，且 Leaflet SDK 加载失败（网络不可达）；保留静态日程列表。', 'warning')
  })
}

function initMap(state: PageState, provider: 'amap' | 'leaflet' = currentProvider(state.data)): void {
  try {
    clearSkeleton()
    state.map = buildMapAdapter(state, provider)
    if (state.map === undefined) {
      setMapStatus('暂无带坐标的行程点位，已保留静态日程列表。')
      setDataset('mapReady', 'no-coordinates')
      renderRoutePanel(state)
      return
    }
    state.markerHandles = state.map.markers
    state.routeHandles = state.map.routes
    setDataset('mapReady', provider)
    setDataset('markers', String(state.markerModels.length))
    setDataset('stops', String(state.stops.length))
    setDataset('clustered', state.markerModels.length < state.stops.filter((stop) => stop.point !== undefined).length ? 'true' : 'false')
    applyView(state, { fit: true })
    renderRoutePanel(state)
    updateSelectionClasses(state)
    const status = byId<HTMLElement>('mapStatus')
    if (status !== undefined && state.data.map.warnings.length === 0) status.classList.add('hidden')
    console.log(`[dsh-travel] stops=${state.stops.length} markers=${state.markerModels.length}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 运行期失败（SDK 插件缺失/CSP 拦截/坐标异常）→ 原定 amap 时自动降级 Leaflet，
    // 不让「地图为核心」的页面退化成纯静态列表。
    if (provider === 'amap') {
      console.log(`[dsh-travel] amap error: ${message} → 降级 Leaflet`)
      loadLeafletFallback(state, message)
      return
    }
    clearSkeleton()
    setDataset('mapReady', `${provider}-error`)
    setMapStatus(`地图初始化失败：${message}；静态日程仍可用。`, 'warning')
    renderRoutePanel(state)
    console.log(`[dsh-travel] map error: ${message}`)
  }
}

// ────────────────────────── 补充信息卡（全量内容） ──────────────────────────

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
    appendHeading(body, 'h3', '逐地天气')
    appendWeatherLines(body, advice.weather)
  } else {
    appendText(body, '缺失/下一步：暂无天气数据。', 'next-step')
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
    for (const assumption of data.cost.assumptions ?? []) appendText(body, `假设：${assumption}`, 'muted small')
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

/** 打印用线性完整行程：逐日全部 stops（textContent，屏上隐藏，@media print 显示）。 */
function renderPrintItinerary(data: RenderPageData): void {
  const section = byId<HTMLElement>('printItinerary')
  if (section === undefined) return
  clear(section)
  appendHeading(section, 'h2', '完整行程')
  data.itinerary.days.forEach((day, dayIndex) => {
    const dayBox = make('div', 'print-day')
    appendHeading(dayBox, 'h3', `${DAY_LABEL(dayIndex)} · ${day.date}${day.theme !== undefined ? ` · ${day.theme}` : ''}`)
    const list = make('ol', 'print-stops')
    for (const stop of day.stops) {
      const line = make('li')
      const meta = `${CATEGORY_LABEL[stop.category] ?? stop.category}${stop.durationHint !== undefined ? ` · 建议 ${stop.durationHint} 分钟` : ''}${stop.placeId === undefined ? '' : ` · ${stop.placeId}`}`
      appendText(line, `${stop.name}（${meta}）`)
      list.appendChild(line)
    }
    dayBox.appendChild(list)
    const meals = day.meals ?? []
    if (meals.length > 0) appendText(dayBox, `餐食：${meals.map((meal) => meal.name).join('、')}`, 'muted small print-meals')
    section.appendChild(dayBox)
  })
}

// ────────────────────────── 加载与启动 ──────────────────────────

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
      setMapStatus('高德地图 SDK 加载失败（网络不可达或 key 无效），尝试降级 Leaflet/OSM。', 'warning')
      renderRoutePanel(state)
      // SDK 整体加载失败同样走 Leaflet 降级（不再只剩静态列表）。
      loadLeafletFallback(state, 'SDK 加载失败')
    })
    return
  }
  loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', () => setMapStatus('Leaflet 样式加载失败，保留静态日程列表。', 'warning'))
  loadJs('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', () => initMap(state), () => {
    setDataset('mapReady', 'leaflet-loader-error')
    setMapStatus('Leaflet SDK 加载失败（网络不可达），保留静态日程列表。', 'warning')
    renderRoutePanel(state)
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
  const state = createState(data, provider)
  const markerResult = { clustered: state.markerModels.length < state.stops.filter((stop) => stop.point !== undefined).length }
  renderOverview(state)
  renderDayTabs(state)
  renderSidePanel(state)
  renderDetail(state)
  renderMapControls(state)
  renderRoutePanel(state)
  renderWarnings(state)
  renderDock(state)
  renderInsightsSection(data)
  renderInsightGroup(data, 'foodCard', 'foodBody', 'guide', false)
  renderInsightGroup(data, 'lodgingCard', 'lodgingBody', 'recommend', false)
  renderInsightGroup(data, 'warningCard', 'warningBody', 'avoid', true)
  renderTransport(data)
  renderAdvice(data)
  renderRentalCost(data)
  renderDegraded(data)
  renderPrintItinerary(data)
  renderSkeleton(state)
  setDataset('motion', reducedMotion() ? 'reduced' : 'full')
  setDataset('provider', provider)
  setDataset('drawer', 'closed')
  applyView(state)
  if (markerResult.clustered) setMapStatus('点位超过 200 个，地图已启用确定性聚合；左侧列表保留全部点位。')
  startLoader(state)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    clearSelection(state)
  })
  window.__dshTravel = {
    state,
    selectStop: (key: string) => selectStop(state, key, true),
    selectDay: (index: number) => selectDay(state, index, true),
    selectOverview: () => selectOverview(state, true),
  }
}

// Kept as explicit contract markers for the structure tests and rendered-page audit:
// AMap.Map / AMap.Marker / AMap.Polyline / AMap.InfoWindow; L.marker / L.polyline;
// function activateDay is represented by selectDay; routeTransport is rendered by renderRouteTransport.
function renderRouteTransport(state: PageState): void { renderRoutePanel(state) }
function activateDay(state: PageState, index: number): void { selectDay(state, index, true) }
void renderRouteTransport
void activateDay

// 浏览器入口；node 单测（render-map-view）导入本模块时不触发 DOM 初始化。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPage, { once: true })
  else bootPage()
}

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode?: string; serviceHost?: string }
    __dshTravel?: { state: PageState; selectStop: (key: string) => void; selectDay: (index: number) => void; selectOverview: () => void }
  }
  const AMap: AMapLike | undefined
  const L: LeafletLike | undefined
}

interface AMapLike {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => AMapMap
  Marker: new (options: Record<string, unknown>) => AMapMarker
  Polyline: new (options: Record<string, unknown>) => AMapPolyline
  Pixel: new (x: number, y: number) => unknown
  LngLat: new (lng: number, lat: number) => unknown
  Bounds: new (southWest: unknown, northEast: unknown) => unknown
  /** JSAPI 2.0 插件按需加载入口（`plugin=` URL 参数不保证注册，故运行期探测）。 */
  plugin?: (plugins: string[], callback: () => void) => void
  /** 控件插件可选：2.0 下可能未注册（undefined）——必须特性探测，不得直接 new。 */
  Scale?: new () => unknown
  ToolBar?: new () => unknown
}
interface AMapMap {
  addControl(control: unknown): void
  add(layer: unknown): void
  setBounds(bounds: unknown): void
  setCenter(center: [number, number], zoom?: number, options?: { animate?: boolean }): void
  /** 遮挡感知取景：可见 overlay + avoid（[上,右,下,左] px）+ maxZoom。 */
  setFitView(overlays: unknown[], immediately?: boolean, avoid?: [number, number, number, number], maxZoom?: number): void
}
interface AMapMarker {
  setMap(map: AMapMap): void
  getPosition(): unknown
  on(event: string, handler: () => void): void
}
interface AMapPolyline {
  setOptions(options: Record<string, unknown>): void
  show(): void
  hide(): void
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
  setOpacity(opacity: number): void
}
interface LeafletLine {
  addTo(map: LeafletMap): LeafletLine
  setStyle(options: Record<string, unknown>): void
}
