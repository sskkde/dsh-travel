/**
 * 字段级校验器（可复用于各工具与适配器归一化）。
 *
 * 分层：
 *  - 基础谓词（isDateString / isIsoTimestamp / 枚举成员 / 坐标）
 *  - 槽位级语义校验（validateSlotsFields / validateDaysConsistency /
 *    computeRequiredMissing / detectSlotAmbiguities）—— travel_intake /
 *    travel_update_request 复用
 *  - 模型级结构校验（validateRequest / validateIntelItem / ...）——
 *    落盘/读取的契约闸门（W2a+ 适配器归一化与 store 回读复用）
 *
 * 校验语义按 design §5.5 与 §6 表：日期格式非法 / dateEnd<dateStart /
 * days 与区间不一致 → 拒绝（TravelValidationError，由工具层抛出）；
 * 必填缺失 → missing[]（不拒绝，渐进式收集）；歧义 → ambiguity[]。
 */
import {
  BUDGET_SCOPES, CITY_TRANSFER_PROVIDERS, CONFIDENCE_LEVELS, CONTENT_STATUSES, COORD_SYS,
  INTEL_CATEGORIES, INTEL_CHANNELS, PACE_LEVELS, REQUEST_STATUSES, TEMPERATURE_BASES,
  RESEARCH_KEYWORDS_MAX, RESEARCH_KEYWORDS_MAX_CHARS, RESEARCH_REGION_HINTS_MAX,
  STOP_CATEGORIES, TRAVEL_MODES, TRANSPORT_MODES, COST_COMPONENT_KEYS, COST_COMPONENT_STATUSES,
  COST_QUANTITY_BASES, COST_SCOPES, INSIGHT_KINDS, INSIGHT_MAX_CHARS, INSIGHT_SCOPES, ITINERARY_ANCHOR_ROLES,
  ROUTE_GEOMETRY_COORDINATE_SYSTEMS, ROUTE_GEOMETRY_POINT_ORDERS, ROUTE_GEOMETRY_STATUSES,
  ROUND3_SCHEMA_VERSION, RENTAL_QUOTE_RECORD_STATUSES, RENTAL_UNITS, TAX_STATUSES, SUPPORTED_SCHEMA_VERSIONS,
  type Advice, type CostArtifact, type GeoCoords, type IntelItem, type Itinerary, type RequestStatus,
  type RentalQuotesArtifact, type Slots, type SourceRef, type RouteGeometry, type RouteTransportLeg,
  type TransportOption, type TravelMode, type TravelRequest,
} from './types.js'
import { TravelValidationError } from '../errors.js'

export interface ValidationIssue {
  /** 相对校验根的路径（如 `slots.dateStart`、`intel[0].rating`）。 */
  path: string
  message: string
}

/**
 * 只读兼容已退役的 channel 值：旧 intel 工件可继续被解释，但新产出不再使用。
 * 其它未知值仍走枚举校验，避免把 channel 校验整体放宽。
 */
const LEGACY_INTEL_CHANNELS = new Set(['bilibili', 'douban'])

// ────────────────────────── 基础谓词 ──────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** YYYY-MM-DD 且为真实日历日（含闰年）。 */
export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DATE_RE.exec(value)
  if (!m) return false
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3])
  if (month < 1 || month > 12) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day >= 1 && day <= daysInMonth
}

/** ISO8601 时间戳（T 分隔 + 可解析）。 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

/** publishedAt 的统一入库形态：接受 YYYY-MM-DD 或 ISO timestamp，归一为来源日期。 */
export function normalizePublishedAt(value: unknown): string | undefined {
  if (isDateString(value)) return value
  if (isIsoTimestamp(value)) {
    const datePart = value.slice(0, 10)
    return isDateString(datePart) ? datePart : undefined
  }
  return undefined
}

/** publishedAt 合法性（日期或 ISO timestamp）。 */
export function isPublishedAt(value: unknown): value is string {
  return normalizePublishedAt(value) !== undefined
}

/** 枚举成员判定（readonly array 常量）。 */
export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 版本化工件读取模式。legacy（缺 schemaVersion）与未知版本只能只读解释。 */
export type VersionCompatibility = 'current' | 'legacy' | 'unknown'

export interface VersionCompatibilityResult {
  compatibility: VersionCompatibility
  schemaVersion?: number
  /** false = 允许写入当前契约；true = 仅允许只读解释。 */
  readOnly: boolean
}

export function schemaVersionOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = (value as Record<string, unknown>).schemaVersion
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined
}

/**
 * 将缺失/已知/未知版本明确分类。缺失版本代表既有 legacy，而不是 current；
 * 当前 round3 版本和已支持 legacy 版本均可写入，未来版本保持只读。
 */
export function classifyVersion(value: unknown, currentVersion = ROUND3_SCHEMA_VERSION): VersionCompatibilityResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { compatibility: 'unknown', readOnly: true }
  }
  const record = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'schemaVersion')) {
    return { compatibility: 'legacy', readOnly: true }
  }
  const schemaVersion = schemaVersionOf(value)
  if (schemaVersion !== undefined
    && (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)
    && schemaVersion <= currentVersion) {
    return {
      compatibility: schemaVersion === currentVersion ? 'current' : 'legacy',
      schemaVersion,
      readOnly: schemaVersion !== currentVersion,
    }
  }
  return { compatibility: 'unknown', ...(schemaVersion !== undefined ? { schemaVersion } : {}), readOnly: true }
}

export function isKnownSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(value)
}

export function isValidLng(value: unknown): boolean {
  return isFiniteNumber(value) && value >= -180 && value <= 180
}

export function isValidLat(value: unknown): boolean {
  return isFiniteNumber(value) && value >= -90 && value <= 90
}

/** 坐标结构（{lng,lat,sys}，sys 枚举）。 */
export function isValidCoords(value: unknown): value is GeoCoords {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return isValidLng(c.lng) && isValidLat(c.lat) && isOneOf(c.sys, COORD_SYS)
}

/** canonical WGS84 GeoJSON LineString 校验（严格 [lng,lat]，拒绝 NaN/越界/倒序）。 */
export function isValidRouteGeometry(value: unknown): value is RouteGeometry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const geometry = value as Record<string, unknown>
  if (geometry.type !== 'LineString'
    || !isNonEmptyString(geometry.source)
    || !isOneOf(geometry.coordinateSystem, ROUTE_GEOMETRY_COORDINATE_SYSTEMS)
    || !isOneOf(geometry.pointOrder, ROUTE_GEOMETRY_POINT_ORDERS)
    || !Array.isArray(geometry.coordinates)
    || geometry.coordinates.length < 2) return false
  return geometry.coordinates.every((point): point is [number, number] => Array.isArray(point)
    && point.length === 2
    && isValidLng(point[0])
    && isValidLat(point[1]))
}

export function isValidSourceRef(value: unknown): value is SourceRef {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  const url = typeof s.url === 'string' ? s.url : undefined
  let safeUrl = false
  if (url !== undefined) {
    if (/^\/\//.test(url.trim())) return false
    // 既有离线 fixture 允许非 URL 占位符（如 `u`），但危险可执行 scheme 一律拒绝；
    // 可解析 URL 则只接受 http/https。
    if (/^(?:javascript|data|vbscript):/i.test(url.trim())) safeUrl = false
    else {
      try {
        const parsed = new URL(url)
        safeUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'fake:'
      } catch {
        safeUrl = true
      }
    }
  }
  return isNonEmptyString(s.platform) && safeUrl
    && (isIsoTimestamp(s.fetchedAt) || isDateString(s.fetchedAt))
}

/** 数值区间对 [lo, hi]（price / temp 用）。 */
export function isValidRangePair(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [lo, hi] = value
  return isFiniteNumber(lo) && isFiniteNumber(hi) && lo <= hi
}

function isNonNegativeRangePair(value: unknown): value is [number, number] {
  return isValidRangePair(value) && value[0] >= 0
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** 可持久化外链：拒绝可执行 scheme 与 userinfo，允许既有 fake:// 测试占位符。 */
function isSafeExternalUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  const raw = value.trim()
  if (/^\/\//.test(raw)) return false
  if (/^(?:javascript|data|vbscript):/i.test(raw)) return false
  try {
    const parsed = new URL(raw)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'fake:')
      && parsed.username === '' && parsed.password === ''
  } catch {
    // SourceRef 兼容非 URL 占位符；其中不允许凭据/可执行 scheme。真正的 URL
    // 会走上面的严格解析路径，避免把 userinfo 带入 rental artifact。
    return !/^[^\s/@]+:[^\s/@]*@/i.test(raw)
  }
}

function isSafeSourceRef(value: unknown): boolean {
  if (!isValidSourceRef(value)) return false
  const url = (value as SourceRef).url
  return isSafeExternalUrl(url)
}

// ────────────────────────── 日期与天数 ──────────────────────────

/** 含首尾的 UTC 日差（"2026-10-01"→"2026-10-03" = 3 天）。调用方须先保证两日期合法。 */
export function daysBetweenInclusive(startDate: string, endDate: string): number {
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endDate.split('-').map(Number)
  const start = Date.UTC(sy, sm - 1, sd)
  const end = Date.UTC(ey, em - 1, ed)
  return Math.round((end - start) / 86_400_000) + 1
}

// ────────────────────────── 槽位级语义校验 ──────────────────────────

/** 槽位字段级校验（结构/枚举/数值范围；不含必填缺失）。 */
export function validateSlotsFields(slots: Slots): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (slots.origin !== undefined && !isNonEmptyString(slots.origin)) {
    issues.push({ path: 'slots.origin', message: '出发地必须为非空字符串' })
  }
  if (slots.destination !== undefined && !isNonEmptyString(slots.destination)) {
    issues.push({ path: 'slots.destination', message: '目的地必须为非空字符串' })
  }
  if (slots.dateStart !== undefined && !isDateString(slots.dateStart)) {
    issues.push({ path: 'slots.dateStart', message: `日期须为 YYYY-MM-DD（收到 ${JSON.stringify(slots.dateStart)}）` })
  }
  if (slots.dateEnd !== undefined && !isDateString(slots.dateEnd)) {
    issues.push({ path: 'slots.dateEnd', message: `日期须为 YYYY-MM-DD（收到 ${JSON.stringify(slots.dateEnd)}）` })
  }
  if (slots.days !== undefined && (!Number.isInteger(slots.days) || slots.days < 1)) {
    issues.push({ path: 'slots.days', message: '天数必须为 ≥1 的整数' })
  }

  if (isDateString(slots.dateStart) && isDateString(slots.dateEnd)
    && slots.dateEnd < slots.dateStart) {
    issues.push({ path: 'slots.dateEnd', message: `dateEnd（${slots.dateEnd}）不得早于 dateStart（${slots.dateStart}）` })
  }

  if (slots.travelers !== undefined) {
    const t = slots.travelers
    if (t.adults !== undefined && (!Number.isInteger(t.adults) || t.adults < 1)) {
      issues.push({ path: 'slots.travelers.adults', message: '成人数必须为 ≥1 的整数' })
    }
    if (t.children !== undefined && (!Number.isInteger(t.children) || t.children < 0)) {
      issues.push({ path: 'slots.travelers.children', message: '儿童数必须为 ≥0 的整数' })
    }
    if (t.seniors !== undefined && (!Number.isInteger(t.seniors) || t.seniors < 0)) {
      issues.push({ path: 'slots.travelers.seniors', message: '老人数必须为 ≥0 的整数' })
    }
  }

  if (slots.budget !== undefined) {
    const b = slots.budget
    if (b.amount !== undefined && (!isFiniteNumber(b.amount) || b.amount < 0)) {
      issues.push({ path: 'slots.budget.amount', message: '预算金额必须为非负数字' })
    }
    if (b.currency !== undefined && !isNonEmptyString(b.currency)) {
      issues.push({ path: 'slots.budget.currency', message: '币种必须为非空字符串' })
    }
    if (b.scope !== undefined && !isOneOf(b.scope, BUDGET_SCOPES)) {
      issues.push({ path: 'slots.budget.scope', message: `scope 须为 ${BUDGET_SCOPES.join('|')}` })
    }
  }

  if (slots.preferences !== undefined) {
    if (slots.preferences.pace !== undefined && !isOneOf(slots.preferences.pace, PACE_LEVELS)) {
      issues.push({ path: 'slots.preferences.pace', message: `pace 须为 ${PACE_LEVELS.join('|')}` })
    }
    for (const [key, list] of [['themes', slots.preferences.themes], ['diet', slots.preferences.diet]] as const) {
      if (list !== undefined && (!Array.isArray(list) || list.some((v) => !isNonEmptyString(v)))) {
        issues.push({ path: `slots.preferences.${key}`, message: '必须为非空字符串数组' })
      }
    }
  }

  if (slots.constraints !== undefined
    && (!Array.isArray(slots.constraints) || slots.constraints.some((v) => !isNonEmptyString(v)))) {
    issues.push({ path: 'slots.constraints', message: '必须为非空字符串数组' })
  }

  // ── W0 T1 researchIntent（草稿 A：text 必填、keywords ≤6×1-100、regionHints ≤20） ──
  if (slots.researchIntent !== undefined) {
    const ri = slots.researchIntent
    if (!isNonEmptyString(ri.text)) {
      issues.push({ path: 'slots.researchIntent.text', message: '兴趣主题 text 必须为非空字符串' })
    }
    if (ri.keywords !== undefined) {
      if (!Array.isArray(ri.keywords)) {
        issues.push({ path: 'slots.researchIntent.keywords', message: 'keywords 必须为字符串数组' })
      } else if (ri.keywords.length > RESEARCH_KEYWORDS_MAX) {
        issues.push({
          path: 'slots.researchIntent.keywords',
          message: `keywords 最多 ${RESEARCH_KEYWORDS_MAX} 条（收到 ${ri.keywords.length}）`,
        })
      } else {
        ri.keywords.forEach((k, i) => {
          const trimmed = typeof k === 'string' ? k.trim() : ''
          if (trimmed.length === 0) {
            issues.push({ path: `slots.researchIntent.keywords[${i}]`, message: '关键词不能为空（trim 后）' })
          } else if (trimmed.length > RESEARCH_KEYWORDS_MAX_CHARS) {
            issues.push({
              path: `slots.researchIntent.keywords[${i}]`,
              message: `关键词须 ≤${RESEARCH_KEYWORDS_MAX_CHARS} 字符（收到 ${trimmed.length}）`,
            })
          }
        })
      }
    }
    if (ri.regionHints !== undefined) {
      if (!Array.isArray(ri.regionHints)) {
        issues.push({ path: 'slots.researchIntent.regionHints', message: 'regionHints 必须为字符串数组' })
      } else if (ri.regionHints.length > RESEARCH_REGION_HINTS_MAX) {
        issues.push({
          path: 'slots.researchIntent.regionHints',
          message: `regionHints 最多 ${RESEARCH_REGION_HINTS_MAX} 个明确地域约束（收到 ${ri.regionHints.length}）`,
        })
      } else {
        ri.regionHints.forEach((r, i) => {
          if (!isNonEmptyString(r)) {
            issues.push({ path: `slots.researchIntent.regionHints[${i}]`, message: '地域约束不能为空字符串' })
          }
        })
      }
    }
  }

  return issues
}

/**
 * days 与日期区间一致性（§6 行 518：不一致拒绝）。
 * 仅当日期区间完整且 days 同时给出才判定；区间缺一半时该缺口由
 * missing[] 负责，不算不一致。
 */
export function validateDaysConsistency(slots: Slots): ValidationIssue[] {
  if (slots.days === undefined) return []
  if (!isDateString(slots.dateStart) || !isDateString(slots.dateEnd)) return []
  const daysForRange = daysBetweenInclusive(slots.dateStart, slots.dateEnd)
  if (slots.days !== daysForRange) {
    return [{
      path: 'slots.days',
      message: `天数与日期区间不一致：${slots.dateStart}→${slots.dateEnd} 为 ${daysForRange} 天，收到 days=${slots.days}`,
    }]
  }
  return []
}

/**
 * 必填槽位缺口（§6 行 518：plan 模式 destination 必填计入 missing；
 * recommend 模式 destination 不计入——候选由宿主 web_search 生成后回注）。
 * W0 T1（草稿 A）：plan 模式存在 researchIntent.text（兴趣主题）时 destination
 * 可缺省——允许先做情报发现，下游交通按需报 missing_input；纯 destination
 * 单点（无研究意图）保持 destination 必填。
 * 日期/天数视为“成行必需”，保证 confirmed 前后槽位口径一致。
 */
export function computeRequiredMissing(slots: Slots, mode: TravelMode): string[] {
  const missing: string[] = []
  const hasResearchIntent = isNonEmptyString(slots.researchIntent?.text)
  if (mode === 'plan' && !hasResearchIntent && !isNonEmptyString(slots.destination)) missing.push('destination')
  if (!isDateString(slots.dateStart)) missing.push('dateStart')
  if (!isDateString(slots.dateEnd)) missing.push('dateEnd')
  if (slots.days === undefined) missing.push('days')
  return missing
}

/**
 * 歧义检测（进入回复前需要澄清的取值，区别于缺失）。
 * 目前仅两项：destination 含多个候选分隔符；携带儿童但未确认成人数。
 */
export function detectSlotAmbiguities(slots: Slots): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const dest = slots.destination
  if (isNonEmptyString(dest) && /[、，,;；|/]/.test(dest)) {
    issues.push({
      path: 'slots.destination',
      message: `destination（${dest}）含多个候选分隔符——请确认是单一目的地还是候选列表`,
    })
  }
  if (slots.travelers !== undefined
    && slots.travelers.children !== undefined && slots.travelers.children > 0
    && slots.travelers.adults === undefined) {
    issues.push({
      path: 'slots.travelers.adults',
      message: '已携带儿童但未确认成人数（默认值可能不准确）',
    })
  }
  return issues
}

// ────────────────────────── 模型级结构校验 ──────────────────────────

function checkEnum(prefix: string, value: unknown, allowed: readonly string[], label: string, issues: ValidationIssue[]): void {
  if (!isOneOf(value, allowed)) {
    issues.push({ path: prefix, message: `${label} 须为 ${allowed.join('|')}（收到 ${JSON.stringify(value)}）` })
  }
}

/** 状态枚举成员判定（工具返回/状态机使用的守卫）。 */
export function isRequestStatus(value: unknown): value is RequestStatus {
  return isOneOf(value, REQUEST_STATUSES)
}

/** request.json 完整性（§5.5 行 401-424）。 */
export function validateRequest(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null) {
    issues.push({ path: '', message: 'request 必须为对象' })
    return issues
  }
  const req = value as Partial<TravelRequest>
  if (!isNonEmptyString(req.planId)) issues.push({ path: 'planId', message: 'planId 必须为非空字符串' })
  if (req.mode !== undefined) checkEnum('mode', req.mode, TRAVEL_MODES, 'mode', issues)
  if (req.status !== undefined) checkEnum('status', req.status, REQUEST_STATUSES, 'status', issues)
  if (req.slots !== undefined) {
    for (const issue of validateSlotsFields(req.slots)) issues.push(issue)
    for (const issue of validateDaysConsistency(req.slots)) issues.push(issue)
  }
  if (req.assumptions !== undefined
    && (!Array.isArray(req.assumptions) || req.assumptions.some((v) => !isNonEmptyString(v)))) {
    issues.push({ path: 'assumptions', message: '必须为非空字符串数组' })
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (req[key] !== undefined && !isIsoTimestamp(req[key])) {
      issues.push({ path: key, message: `必须为 ISO8601 时间戳（收到 ${JSON.stringify(req[key])}）` })
    }
  }
  // W0 T1：flowVersion 可选；出现则必须为非空字符串（缺失=legacy 读取，草稿 F）
  if (req.flowVersion !== undefined && !isNonEmptyString(req.flowVersion)) {
    issues.push({ path: 'flowVersion', message: 'flowVersion 必须为非空字符串（缺失=legacy）' })
  }
  return issues
}

/** intel.json 条目（§5.5 行 427-444）。 */
export function validateIntelItem(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null) {
    issues.push({ path: '', message: 'intel 条目必须为对象' })
    return issues
  }
  const item = value as Partial<IntelItem>
  const rawItem = value as Record<string, unknown>
  if (!isNonEmptyString(item.id)) issues.push({ path: 'id', message: 'id 必须为非空字符串' })
  if (item.category !== undefined) checkEnum('category', item.category, INTEL_CATEGORIES, 'category', issues)
  if (item.channel !== undefined
    && !(typeof item.channel === 'string' && LEGACY_INTEL_CHANNELS.has(item.channel))) {
    checkEnum('channel', item.channel, INTEL_CHANNELS, 'channel', issues)
  }
  if (!isNonEmptyString(item.title)) issues.push({ path: 'title', message: 'title 必须为非空字符串' })
  if (!isNonEmptyString(item.summary)) issues.push({ path: 'summary', message: 'summary 必须为非空字符串' })
  if (rawItem.author !== undefined && typeof rawItem.author !== 'string') {
    issues.push({ path: 'author', message: 'author 必须为字符串' })
  }
  if (rawItem.metrics !== undefined) {
    if (typeof rawItem.metrics !== 'object' || rawItem.metrics === null || Array.isArray(rawItem.metrics)) {
      issues.push({ path: 'metrics', message: 'metrics 必须为对象' })
    } else {
      const metrics = rawItem.metrics as Record<string, unknown>
      for (const key of ['likes', 'collects', 'comments', 'shares'] as const) {
        if (metrics[key] !== undefined && (!isFiniteNumber(metrics[key]) || (metrics[key] as number) < 0)) {
          issues.push({ path: `metrics.${key}`, message: `${key} 必须为非负有限数值` })
        }
      }
    }
  }
  if (rawItem.source !== undefined && !isValidSourceRef(rawItem.source)) {
    issues.push({ path: 'source', message: 'source 须含 platform/url/fetchedAt(ISO8601)' })
  }
  if (item.coords !== undefined && !isValidCoords(item.coords)) {
    issues.push({ path: 'coords', message: 'coords 须为 {lng,lat,sys∈GCJ02|WGS84}' })
  }
  if (item.rating !== undefined && (!isFiniteNumber(item.rating) || item.rating < 0 || item.rating > 5)) {
    issues.push({ path: 'rating', message: 'rating 须为 0~5 数字' })
  }
  if (item.avgPrice !== undefined && (!isFiniteNumber(item.avgPrice) || item.avgPrice < 0)) {
    issues.push({ path: 'avgPrice', message: 'avgPrice 须为非负数字' })
  }
  if (item.openingHours !== undefined && !isNonEmptyString(item.openingHours)) {
    issues.push({ path: 'openingHours', message: 'openingHours 须为非空字符串' })
  }
  if (item.confidence !== undefined) checkEnum('confidence', item.confidence, CONFIDENCE_LEVELS, 'confidence', issues)
  if (item.conflictsWith !== undefined
    && (!Array.isArray(item.conflictsWith) || item.conflictsWith.some((v) => !isNonEmptyString(v)))) {
    issues.push({ path: 'conflictsWith', message: '必须为非空字符串数组（条目 id）' })
  }
  if (item.publishedAt !== undefined && !isPublishedAt(item.publishedAt)) {
    issues.push({ path: 'publishedAt', message: '内容发布时间须为 YYYY-MM-DD 或 ISO timestamp' })
  }
  // W0 T1：正文追踪兼容旧 ContentTrace；round3 新形态允许 content 直接是正文字符串。
  const rawContent = rawItem.content
  if (typeof rawContent === 'string') {
    // 空正文仍是合法的字符串形态；是否可用由上游 contentStatus/正文抓取语义决定。
  } else if (rawContent !== undefined) {
    if (typeof rawContent !== 'object' || rawContent === null || Array.isArray(rawContent)) {
      issues.push({ path: 'content', message: 'content 必须为正文字符串或旧 ContentTrace 对象' })
    } else {
      const c = rawContent as Record<string, unknown>
      if (!isNonEmptyString(c.contentRef)) issues.push({ path: 'content.contentRef', message: 'contentRef 必须为非空字符串' })
      if (!isNonEmptyString(c.contentVersion)) issues.push({ path: 'content.contentVersion', message: 'contentVersion 必须为非空字符串' })
      if (c.contentStatus !== undefined) {
        checkEnum('content.contentStatus', c.contentStatus, CONTENT_STATUSES, 'contentStatus', issues)
      }
      if (c.truncated !== undefined && typeof c.truncated !== 'boolean') {
        issues.push({ path: 'content.truncated', message: 'truncated 须为布尔值' })
      }
      if (c.truncated === true && !isNonEmptyString(c.truncatedReason)) {
        issues.push({ path: 'content.truncatedReason', message: 'truncated=true 时必须给出截断原因' })
      }
      if (c.mediaUnresolved !== undefined && typeof c.mediaUnresolved !== 'boolean') {
        issues.push({ path: 'content.mediaUnresolved', message: 'mediaUnresolved 须为布尔值' })
      }
    }
  }
  return issues
}

/** transport.json 条目（§5.5 行 447-463）。 */
export function validateTransportOption(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null) {
    issues.push({ path: '', message: 'transport 条目必须为对象' })
    return issues
  }
  const opt = value as Partial<TransportOption>
  if (opt.mode !== undefined) checkEnum('mode', opt.mode, TRANSPORT_MODES, 'mode', issues)
  if (opt.segments !== undefined) {
    if (!Array.isArray(opt.segments) || opt.segments.length === 0) {
      issues.push({ path: 'segments', message: '必须为非空数组' })
    } else {
      opt.segments.forEach((seg, i) => {
        const p = `segments[${i}]`
        if (!isNonEmptyString(seg.from)) issues.push({ path: `${p}.from`, message: 'from 必须为非空字符串' })
        if (!isNonEmptyString(seg.to)) issues.push({ path: `${p}.to`, message: 'to 必须为非空字符串' })
        if (seg.priceRange !== undefined && !isValidRangePair(seg.priceRange)) {
          issues.push({ path: `${p}.priceRange`, message: 'priceRange 须为 [lo,hi] 数值对' })
        }
      })
    }
  }
  if (opt.totalPriceRange !== undefined && !isValidRangePair(opt.totalPriceRange)) {
    issues.push({ path: 'totalPriceRange', message: '须为 [lo,hi] 数值对' })
  }
  if (opt.currency !== undefined && !isNonEmptyString(opt.currency)) {
    issues.push({ path: 'currency', message: '币种必须为非空字符串；缺省表示来源未明确说明' })
  }
  if (opt.durationMinutes !== undefined && (!Number.isInteger(opt.durationMinutes) || opt.durationMinutes < 0)) {
    issues.push({ path: 'durationMinutes', message: '须为 ≥0 整数（分钟）' })
  }
  if (opt.cityTransfer !== undefined) {
    const ct = opt.cityTransfer
    if (!isNonEmptyString(ct.from) || !isNonEmptyString(ct.to)) {
      issues.push({ path: 'cityTransfer', message: 'from/to 必须为非空字符串' })
    }
    if (ct.provider !== undefined) checkEnum('cityTransfer.provider', ct.provider, CITY_TRANSFER_PROVIDERS, 'provider', issues)
    if (ct.options !== undefined && !Array.isArray(ct.options)) {
      issues.push({ path: 'cityTransfer.options', message: '必须为数组' })
    }
    if (ct.source !== undefined && !isValidSourceRef(ct.source)) {
      issues.push({ path: 'cityTransfer.source', message: 'source 结构非法' })
    }
  }
  if (opt.tags !== undefined && (!Array.isArray(opt.tags) || opt.tags.some((v) => !isNonEmptyString(v)))) {
    issues.push({ path: 'tags', message: '必须为非空字符串数组' })
  }
  if (opt.bookingTips !== undefined
    && (!Array.isArray(opt.bookingTips) || opt.bookingTips.some((v) => !isNonEmptyString(v)))) {
    issues.push({ path: 'bookingTips', message: '必须为非空字符串数组' })
  }
  if (opt.source !== undefined && !isValidSourceRef(opt.source)) {
    issues.push({ path: 'source', message: 'source 须含 platform/url/fetchedAt(ISO8601)' })
  }
  return issues
}

/** advice.json（§5.5 行 466-475）。 */
export function validateAdvice(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null) {
    issues.push({ path: '', message: 'advice 必须为对象' })
    return issues
  }
  const advice = value as Advice
  if (!Array.isArray(advice.weather)) {
    issues.push({ path: 'weather', message: '必须为数组' })
  } else {
    advice.weather.forEach((w, i) => {
      const p = `weather[${i}]`
      if (!isDateString(w.date)) issues.push({ path: `${p}.date`, message: '须为 YYYY-MM-DD' })
      if (w.tempRange !== undefined && !isValidRangePair(w.tempRange)) {
        issues.push({ path: `${p}.tempRange`, message: '须为 [lo,hi] 数值对（摄氏度）' })
      }
      if (w.temperatureBasis !== undefined && !isOneOf(w.temperatureBasis, TEMPERATURE_BASES)) {
        issues.push({ path: `${p}.temperatureBasis`, message: `temperatureBasis 须为 ${TEMPERATURE_BASES.join('|')}` })
      }
      if (w.beyondForecastWindow !== undefined && typeof w.beyondForecastWindow !== 'boolean') {
        issues.push({ path: `${p}.beyondForecastWindow`, message: '须为布尔值' })
      }
      if (w.source !== undefined && !isValidSourceRef(w.source)) {
        issues.push({ path: `${p}.source`, message: 'source 结构非法' })
      }
      // W0 T1：地点归属（草稿 E：placeId/location 可选；给予则须非空）
      if (w.placeId !== undefined && !isNonEmptyString(w.placeId)) {
        issues.push({ path: `${p}.placeId`, message: 'placeId 必须为非空字符串' })
      }
      if (w.location !== undefined && !isNonEmptyString(w.location)) {
        issues.push({ path: `${p}.location`, message: 'location 必须为非空字符串' })
      }
      // T13：逐地日期归属标注（可选布尔）
      if (w.placeDateAssigned !== undefined && typeof w.placeDateAssigned !== 'boolean') {
        issues.push({ path: `${p}.placeDateAssigned`, message: 'placeDateAssigned 须为布尔值' })
      }
    })
  }
  for (const [key, list] of [
    ['clothing', advice.clothing], ['packingList', advice.packingList], ['extraTips', advice.extraTips],
  ] as const) {
    if (list !== undefined && (!Array.isArray(list) || list.some((v) => !isNonEmptyString(v)))) {
      issues.push({ path: key, message: '必须为非空字符串数组' })
    }
  }
  return issues
}

/** canonical route geometry（GeoJSON LineString + WGS84 [lng,lat]）。 */
export function validateRouteGeometry(value: unknown, path = 'geometry'): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path, message: '必须为对象' }]
  }
  const geometry = value as Record<string, unknown>
  if (geometry.type !== 'LineString') issues.push({ path: `${path}.type`, message: '必须为 LineString' })
  if (!isNonEmptyString(geometry.source)) issues.push({ path: `${path}.source`, message: 'source 必须为非空字符串' })
  if (!isOneOf(geometry.coordinateSystem, ROUTE_GEOMETRY_COORDINATE_SYSTEMS)) {
    issues.push({ path: `${path}.coordinateSystem`, message: 'coordinateSystem 必须为 WGS84' })
  }
  if (!isOneOf(geometry.pointOrder, ROUTE_GEOMETRY_POINT_ORDERS)) {
    issues.push({ path: `${path}.pointOrder`, message: 'pointOrder 必须为 lng,lat（GeoJSON [lng,lat]）' })
  }
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    issues.push({ path: `${path}.coordinates`, message: '必须为至少含两个点的 [lng,lat] 数组' })
  } else {
    geometry.coordinates.forEach((point, index) => {
      const pointPath = `${path}.coordinates[${index}]`
      if (!Array.isArray(point) || point.length !== 2) {
        issues.push({ path: pointPath, message: '必须为 [lng,lat] 二元数组' })
        return
      }
      if (!isValidLng(point[0]) || !isValidLat(point[1])) {
        issues.push({ path: pointPath, message: '坐标必须为有限且不越界的 [lng,lat]（经度 -180..180、纬度 -90..90）' })
      }
    })
  }
  return issues
}

/** route-transport 单段校验；旧 leg 只校验存在的兼容字段，schema v2 要求双状态。 */
export function validateRouteTransportLeg(value: unknown, path = 'leg', strict = false): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path, message: '必须为对象' }]
  }
  const leg = value as Partial<RouteTransportLeg> & Record<string, unknown>
  for (const key of ['id', 'fromPlaceId', 'toPlaceId', 'observedAt'] as const) {
    if (!isNonEmptyString(leg[key])) issues.push({ path: `${path}.${key}`, message: '必须为非空字符串' })
  }
  if (!Number.isSafeInteger(leg.orderIndex) || (leg.orderIndex as number) < 0) {
    issues.push({ path: `${path}.orderIndex`, message: '必须为非负安全整数' })
  }
  if (!Number.isSafeInteger(leg.placesVersion) || (leg.placesVersion as number) < 0) {
    issues.push({ path: `${path}.placesVersion`, message: '必须为非负安全整数' })
  }
  if (!isOneOf(leg.mode, ['driving', 'walking', 'transit'])) {
    issues.push({ path: `${path}.mode`, message: 'mode 枚举非法' })
  }
  if (!isOneOf(leg.status, ['queried', 'estimated', 'unavailable', 'blocked'])) {
    issues.push({ path: `${path}.status`, message: 'status 枚举非法' })
  }
  if (leg.metricStatus !== undefined && !isOneOf(leg.metricStatus, ROUTE_GEOMETRY_STATUSES)) {
    issues.push({ path: `${path}.metricStatus`, message: 'metricStatus 枚举非法' })
  }
  if (leg.geometryStatus !== undefined && !isOneOf(leg.geometryStatus, ROUTE_GEOMETRY_STATUSES)) {
    issues.push({ path: `${path}.geometryStatus`, message: 'geometryStatus 枚举非法' })
  }
  if (strict && leg.metricStatus === undefined) {
    issues.push({ path: `${path}.metricStatus`, message: 'schemaVersion=2 必须声明 metricStatus' })
  }
  if (strict && leg.geometryStatus === undefined) {
    issues.push({ path: `${path}.geometryStatus`, message: 'schemaVersion=2 必须声明 geometryStatus' })
  }
  if (leg.distanceKm !== undefined && (!isFiniteNumber(leg.distanceKm) || (leg.distanceKm as number) < 0)) {
    issues.push({ path: `${path}.distanceKm`, message: '必须为非负有限公里数' })
  }
  if (leg.durationMinutes !== undefined && (!Number.isInteger(leg.durationMinutes) || (leg.durationMinutes as number) < 0)) {
    issues.push({ path: `${path}.durationMinutes`, message: '必须为非负整数分钟数' })
  }
  if (leg.estimateReason !== undefined && !isNonEmptyString(leg.estimateReason)) {
    issues.push({ path: `${path}.estimateReason`, message: 'estimateReason 必须为非空字符串' })
  }
  if ((leg.status === 'estimated' || leg.metricStatus === 'estimated') && !isNonEmptyString(leg.estimateReason)) {
    issues.push({ path: `${path}.estimateReason`, message: 'estimated 必须说明估算原因' })
  }
  if (leg.geometry !== undefined) issues.push(...validateRouteGeometry(leg.geometry, `${path}.geometry`))
  if (leg.geometryStatus === 'queried' && leg.geometry === undefined) {
    issues.push({ path: `${path}.geometry`, message: 'geometryStatus=queried 必须提供道路几何' })
  }
  if (leg.date !== undefined && !isDateString(leg.date)) issues.push({ path: `${path}.date`, message: '须为 YYYY-MM-DD' })
  if (leg.source !== undefined && !isValidSourceRef(leg.source)) issues.push({ path: `${path}.source`, message: 'source 结构非法' })
  return issues
}

/** route-transport.json 版本化结构校验；未知版本由 Store 只读解释而非写回。 */
export function validateRouteTransportArtifact(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path: '', message: 'route-transport 必须为对象' }]
  const artifact = value as Record<string, unknown>
  const version = schemaVersionOf(value)
  if (version === undefined) issues.push({ path: 'schemaVersion', message: '必须声明 schemaVersion' })
  else if (!isKnownSchemaVersion(version)) issues.push({ path: 'schemaVersion', message: `未知 schemaVersion=${version}，仅允许只读解释` })
  if (!Number.isSafeInteger(artifact.placesVersion) || (artifact.placesVersion as number) < 0) issues.push({ path: 'placesVersion', message: '必须为非负安全整数' })
  if (!isNonEmptyString(artifact.inputFingerprint)) issues.push({ path: 'inputFingerprint', message: '必须为非空字符串' })
  if (!isIsoTimestamp(artifact.generatedAt)) issues.push({ path: 'generatedAt', message: '须为 ISO 时间戳' })
  if (!Array.isArray(artifact.legs)) issues.push({ path: 'legs', message: '必须为数组' })
  else artifact.legs.forEach((leg, index) => issues.push(...validateRouteTransportLeg(leg, `legs[${index}]`, version === ROUND3_SCHEMA_VERSION)))
  if (!Array.isArray(artifact.degraded)) issues.push({ path: 'degraded', message: '必须为数组' })
  return issues
}

/** canonical route 节点/边校验：边端点引用 occurrenceId，禁止相邻零长度边。 */
export function validateCanonicalRoute(value: unknown, path = 'canonicalRoute'): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path, message: '必须为对象' }]
  const route = value as Record<string, unknown>
  const version = schemaVersionOf(value)
  if (version === undefined || !isKnownSchemaVersion(version)) issues.push({ path: `${path}.schemaVersion`, message: 'schemaVersion 缺失或未知' })
  if (!isNonEmptyString(route.fingerprint)) issues.push({ path: `${path}.fingerprint`, message: '必须为非空字符串' })
  const nodes = route.nodes
  const occurrenceIds = new Set<string>()
  if (!Array.isArray(nodes)) {
    issues.push({ path: `${path}.nodes`, message: '必须为数组' })
  } else {
    nodes.forEach((rawNode, index) => {
      const nodePath = `${path}.nodes[${index}]`
      if (typeof rawNode !== 'object' || rawNode === null || Array.isArray(rawNode)) {
        issues.push({ path: nodePath, message: '必须为对象' })
        return
      }
      const node = rawNode as Record<string, unknown>
      if (!isNonEmptyString(node.occurrenceId)) issues.push({ path: `${nodePath}.occurrenceId`, message: '必须为非空字符串' })
      else if (occurrenceIds.has(node.occurrenceId)) issues.push({ path: `${nodePath}.occurrenceId`, message: 'occurrenceId 必须唯一' })
      else occurrenceIds.add(node.occurrenceId)
      if (!isNonEmptyString(node.placeId)) issues.push({ path: `${nodePath}.placeId`, message: '必须为非空字符串' })
      if (!Number.isSafeInteger(node.dayIndex) || (node.dayIndex as number) < 0) issues.push({ path: `${nodePath}.dayIndex`, message: '必须为非负安全整数' })
      if (!Number.isSafeInteger(node.stopIndex) || (node.stopIndex as number) < 0) issues.push({ path: `${nodePath}.stopIndex`, message: '必须为非负安全整数' })
    })
  }
  const edges = route.edges
  const edgeIds = new Set<string>()
  if (!Array.isArray(edges)) {
    issues.push({ path: `${path}.edges`, message: '必须为数组' })
  } else {
    edges.forEach((rawEdge, index) => {
      const edgePath = `${path}.edges[${index}]`
      if (typeof rawEdge !== 'object' || rawEdge === null || Array.isArray(rawEdge)) {
        issues.push({ path: edgePath, message: '必须为对象' })
        return
      }
      const edge = rawEdge as Record<string, unknown>
      if (!isNonEmptyString(edge.id)) issues.push({ path: `${edgePath}.id`, message: '必须为非空字符串' })
      else if (edgeIds.has(edge.id)) issues.push({ path: `${edgePath}.id`, message: 'edge id 必须唯一' })
      else edgeIds.add(edge.id)
      if (!isNonEmptyString(edge.fromOccurrenceId) || !occurrenceIds.has(edge.fromOccurrenceId)) issues.push({ path: `${edgePath}.fromOccurrenceId`, message: '必须引用已登记 occurrenceId' })
      if (!isNonEmptyString(edge.toOccurrenceId) || !occurrenceIds.has(edge.toOccurrenceId)) issues.push({ path: `${edgePath}.toOccurrenceId`, message: '必须引用已登记 occurrenceId' })
      if (edge.fromOccurrenceId === edge.toOccurrenceId) issues.push({ path: edgePath, message: '禁止零长度自环边' })
      if (!Number.isSafeInteger(edge.orderIndex) || (edge.orderIndex as number) < 0) issues.push({ path: `${edgePath}.orderIndex`, message: '必须为非负安全整数' })
    })
  }
  return issues
}

/** itinerary.json（§5.5 行 478-492 + round3 住宿/occurrence 锚点）。 */
export function validateItinerary(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null) {
    issues.push({ path: '', message: 'itinerary 必须为对象' })
    return issues
  }
  const it = value as Itinerary
  const version = schemaVersionOf(value)
  if (version !== undefined && !isKnownSchemaVersion(version)) {
    issues.push({ path: 'schemaVersion', message: `未知 schemaVersion=${version}，仅允许只读解释` })
  }
  const strictRound3 = version === ROUND3_SCHEMA_VERSION
  if (!isNonEmptyString(it.itineraryId)) issues.push({ path: 'itineraryId', message: '必须为非空字符串' })

  const boundaries: Array<{ first?: Itinerary['days'][number]['stops'][number]; last?: Itinerary['days'][number]['stops'][number] }> = []
  const lastPlaceOccurrence = new Map<string, { occurrenceId?: string; flatIndex: number }>()
  const occurrencePlaces = new Map<string, string>()
  let flatIndex = 0

  if (!Array.isArray(it.days) || it.days.length === 0) {
    issues.push({ path: 'days', message: '必须为非空数组' })
  } else {
    it.days.forEach((rawDay, i) => {
      const p = `days[${i}]`
      if (typeof rawDay !== 'object' || rawDay === null || Array.isArray(rawDay)) {
        issues.push({ path: p, message: '必须为对象' })
        boundaries.push({})
        return
      }
      const day = rawDay as Itinerary['days'][number]
      if (!isDateString(day.date)) issues.push({ path: `${p}.date`, message: '须为 YYYY-MM-DD' })
      if (day.theme !== undefined && !isNonEmptyString(day.theme)) {
        issues.push({ path: `${p}.theme`, message: 'theme 必须为非空字符串' })
      }
      if (!Array.isArray(day.stops)) {
        issues.push({ path: `${p}.stops`, message: '必须为数组' })
        boundaries.push({})
      } else {
        if (strictRound3 && day.stops.length === 0) issues.push({ path: `${p}.stops`, message: 'schemaVersion=2 日程必须含住宿/路线锚点' })
        day.stops.forEach((rawStop, j) => {
          const sp = `${p}.stops[${j}]`
          if (typeof rawStop !== 'object' || rawStop === null || Array.isArray(rawStop)) {
            issues.push({ path: sp, message: '必须为对象' })
            flatIndex += 1
            return
          }
          const stop = rawStop as Itinerary['days'][number]['stops'][number]
          if (!isNonEmptyString(stop.name)) issues.push({ path: `${sp}.name`, message: 'name 必须为非空字符串' })
          if (stop.category !== undefined) checkEnum(`${sp}.category`, stop.category, STOP_CATEGORIES, 'category', issues)
          if (stop.coords !== undefined && !isValidCoords(stop.coords)) {
            issues.push({ path: `${sp}.coords`, message: 'coords 结构非法（经纬度范围/经纬序或坐标系错误）' })
          }
          if (stop.placeId !== undefined && !isNonEmptyString(stop.placeId)) {
            issues.push({ path: `${sp}.placeId`, message: 'placeId 必须为非空字符串' })
          }
          if (stop.anchorRole !== undefined && !isOneOf(stop.anchorRole, ITINERARY_ANCHOR_ROLES)) {
            issues.push({ path: `${sp}.anchorRole`, message: 'anchorRole 须为 arrival|lodging|stop|departure' })
          }
          if (stop.occurrenceId !== undefined && !isNonEmptyString(stop.occurrenceId)) {
            issues.push({ path: `${sp}.occurrenceId`, message: 'occurrenceId 必须为非空字符串' })
          }
          if (strictRound3) {
            if (!isNonEmptyString(stop.placeId)) issues.push({ path: `${sp}.placeId`, message: 'schemaVersion=2 stop 必须绑定 placeId' })
            if (!isOneOf(stop.anchorRole, ITINERARY_ANCHOR_ROLES)) issues.push({ path: `${sp}.anchorRole`, message: 'schemaVersion=2 stop 必须声明 anchorRole' })
            if (!isNonEmptyString(stop.occurrenceId)) issues.push({ path: `${sp}.occurrenceId`, message: 'schemaVersion=2 stop 必须声明 occurrenceId' })
          }
          // round3 回归修复：v1 legacy stop 与行程点（anchorRole 缺省/='stop'）必须带
          // intelRefs；仅 round3 住宿/抵达/离开锚点（arrival|lodging|departure）本就没有
          // 情报引用、允许缺省。一旦提供，仍须为非空字符串数组 —— 否则下游
          // （build-itinerary 的 intelRefs 迭代）会直落 `undefined is not iterable` 的
          // 运行时 TypeError，而不是可读的 TravelValidationError。
          if (stop.intelRefs === undefined) {
            if (!isOneOf(stop.anchorRole, ['arrival', 'lodging', 'departure'])) {
              issues.push({ path: `${sp}.intelRefs`, message: '必须为非空字符串数组（intel 条目 id）' })
            }
          } else if (!Array.isArray(stop.intelRefs) || stop.intelRefs.some((v) => !isNonEmptyString(v))) {
            issues.push({ path: `${sp}.intelRefs`, message: '必须为非空字符串数组（intel 条目 id）' })
          }
          if (stop.placeId !== undefined && isNonEmptyString(stop.placeId)) {
            const previous = lastPlaceOccurrence.get(stop.placeId)
            if (previous !== undefined && flatIndex - previous.flatIndex > 1
              && previous.occurrenceId !== undefined && previous.occurrenceId === stop.occurrenceId) {
              issues.push({ path: `${sp}.occurrenceId`, message: '非相邻重访必须使用独立 occurrenceId' })
            }
            lastPlaceOccurrence.set(stop.placeId, { occurrenceId: stop.occurrenceId, flatIndex })
          }
          if (stop.occurrenceId !== undefined && isNonEmptyString(stop.occurrenceId)
            && stop.placeId !== undefined && isNonEmptyString(stop.placeId)) {
            const priorPlace = occurrencePlaces.get(stop.occurrenceId)
            if (priorPlace !== undefined && priorPlace !== stop.placeId) {
              issues.push({ path: `${sp}.occurrenceId`, message: '同一 occurrenceId 不得指向不同 placeId' })
            } else {
              occurrencePlaces.set(stop.occurrenceId, stop.placeId)
            }
          }
          flatIndex += 1
        })
        boundaries.push({ first: day.stops[0], last: day.stops.at(-1) })
        if (strictRound3 && day.stops.length > 0) {
          const first = day.stops[0]
          const last = day.stops.at(-1)
          if (!isOneOf(first?.anchorRole, ['arrival', 'lodging'])) {
            issues.push({ path: `${p}.stops[0].anchorRole`, message: '日首必须为 arrival 或 lodging 锚点' })
          }
          if (!isOneOf(last?.anchorRole, ['lodging', 'departure'])) {
            issues.push({ path: `${p}.stops[${day.stops.length - 1}].anchorRole`, message: '日尾必须为 lodging 或 departure 锚点' })
          }
        }
      }
      if (day.meals !== undefined && (!Array.isArray(day.meals))) {
        issues.push({ path: `${p}.meals`, message: '必须为数组' })
      }
    })
    if (strictRound3) {
      for (let i = 1; i < boundaries.length; i++) {
        const previous = boundaries[i - 1]?.last
        const current = boundaries[i]?.first
        if (previous === undefined || current === undefined
          || !isNonEmptyString(previous.placeId) || !isNonEmptyString(current.placeId)) continue
        if (previous.placeId !== current.placeId) {
          issues.push({ path: `days[${i}].stops[0].placeId`, message: '日界首尾必须绑定同一 placeId（住宿锚点不得断开）' })
        }
      }
    }
  }
  if (it.routeCheck !== undefined) {
    const routeCheckIssues = it.routeCheck.issues
    const routeCheckWarnings = it.routeCheck.warnings
    for (const [key, list] of [['issues', routeCheckIssues], ['warnings', routeCheckWarnings]] as const) {
      if (list !== undefined && (!Array.isArray(list) || list.some((v) => !isNonEmptyString(v)))) {
        issues.push({ path: `routeCheck.${key}`, message: '必须为非空字符串数组' })
      }
    }
  }
  if (it.canonicalRoute !== undefined) issues.push(...validateCanonicalRoute(it.canonicalRoute))
  return issues
}

/** B6 rental-quotes.json：枚举/金额/引用闸门，防下游把咨询数据当预订结果。 */
export function validateRentalQuotes(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: '', message: 'rental-quotes 必须为对象' }]
  }
  const artifact = value as Partial<RentalQuotesArtifact>
  if (artifact.schemaVersion !== 1) issues.push({ path: 'schemaVersion', message: '必须为 1' })
  if (!Number.isSafeInteger(artifact.placesVersion) || (artifact.placesVersion as number) < 0) {
    issues.push({ path: 'placesVersion', message: '必须为非负安全整数' })
  }
  if (!isNonEmptyString(artifact.inputFingerprint)) issues.push({ path: 'inputFingerprint', message: '必须为非空字符串' })
  if (!isIsoTimestamp(artifact.generatedAt)) issues.push({ path: 'generatedAt', message: '须为 ISO 时间戳' })
  if (artifact.consultationOnly !== true) issues.push({ path: 'consultationOnly', message: '必须为 true（咨询级）' })
  if (!isNonEmptyString(artifact.disclaimer)) issues.push({ path: 'disclaimer', message: '必须明示非实时/不可预订语义' })
  if (!Array.isArray(artifact.quotes)) {
    issues.push({ path: 'quotes', message: '必须为数组' })
  } else {
    artifact.quotes.forEach((entry, i) => {
      const p = `quotes[${i}]`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        issues.push({ path: p, message: '必须为对象' })
        return
      }
      if (!isNonEmptyString(entry.pickupPlaceId)) issues.push({ path: `${p}.pickupPlaceId`, message: '必须为非空字符串' })
      if (entry.dropoffPlaceId !== undefined && !isNonEmptyString(entry.dropoffPlaceId)) issues.push({ path: `${p}.dropoffPlaceId`, message: '必须为非空字符串' })
      if (!isSafePositiveInteger(entry.days)) issues.push({ path: `${p}.days`, message: '必须为正安全整数' })
      if (entry.seats !== undefined && !isSafePositiveInteger(entry.seats)) issues.push({ path: `${p}.seats`, message: '必须为正安全整数' })
      if (!isNonEmptyString(entry.vehicleType)) issues.push({ path: `${p}.vehicleType`, message: '必须为非空字符串' })
      const q = entry.quote
      if (typeof q !== 'object' || q === null || Array.isArray(q)) {
        issues.push({ path: `${p}.quote`, message: '必须为对象' })
      } else {
        if (!isNonNegativeRangePair(q.range)) issues.push({ path: `${p}.quote.range`, message: '必须为非负且 min≤max 的有限数值区间' })
        if (!isNonEmptyString(q.currency)) issues.push({ path: `${p}.quote.currency`, message: '必须为非空字符串' })
        if (!isOneOf(q.unit, RENTAL_UNITS)) issues.push({ path: `${p}.quote.unit`, message: '租车单位必须为 day' })
        if (!isOneOf(q.taxStatus, TAX_STATUSES)) issues.push({ path: `${p}.quote.taxStatus`, message: '税态枚举非法' })
        if (!isIsoTimestamp(q.observedAt)) issues.push({ path: `${p}.quote.observedAt`, message: '须为 ISO 时间戳' })
        if (q.referenceUrl !== undefined && !isSafeExternalUrl(q.referenceUrl)) {
          issues.push({ path: `${p}.quote.referenceUrl`, message: 'referenceUrl 必须为无 userinfo 的安全 http/https URL' })
        }
      }
      if (!isSafeSourceRef(entry.source)) issues.push({ path: `${p}.source`, message: 'source 结构非法或含 userinfo/危险 URL' })
    })
  }
  if (!Array.isArray(artifact.records)) {
    issues.push({ path: 'records', message: '必须为数组' })
  } else {
    artifact.records.forEach((record, i) => {
      const p = `records[${i}]`
      if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        issues.push({ path: p, message: '必须为对象' })
        return
      }
      if (record.pickupPlaceId !== undefined && !isNonEmptyString(record.pickupPlaceId)) issues.push({ path: `${p}.pickupPlaceId`, message: '必须为非空字符串' })
      if (record.dropoffPlaceId !== undefined && !isNonEmptyString(record.dropoffPlaceId)) issues.push({ path: `${p}.dropoffPlaceId`, message: '必须为非空字符串' })
      if (!isOneOf(record.status, RENTAL_QUOTE_RECORD_STATUSES)) issues.push({ path: `${p}.status`, message: 'status 枚举非法' })
      if (record.reason !== undefined && !isNonEmptyString(record.reason)) issues.push({ path: `${p}.reason`, message: 'reason 必须为非空字符串' })
    })
  }
  if (!Array.isArray(artifact.degraded)) issues.push({ path: 'degraded', message: '必须为数组' })
  return issues
}

/** round3 归纳引用：仅允许 title/platform/http(s) URL，绝不嵌正文。 */
export function validateInsight(value: unknown, path = 'insight'): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path, message: '必须为对象' }]
  const insight = value as Record<string, unknown>
  if (!isOneOf(insight.kind, INSIGHT_KINDS)) issues.push({ path: `${path}.kind`, message: 'kind 须为 recommend|avoid|guide|plan' })
  if (!isNonEmptyString(insight.text)) {
    issues.push({ path: `${path}.text`, message: 'text 必须为非空字符串' })
  } else if ([...(insight.text as string)].length > INSIGHT_MAX_CHARS) {
    issues.push({ path: `${path}.text`, message: `text 最多 ${INSIGHT_MAX_CHARS} 个 Unicode 字符` })
  }
  if (!isOneOf(insight.scope, INSIGHT_SCOPES)) issues.push({ path: `${path}.scope`, message: 'scope 须为 place|region|theme' })
  if (insight.scopeRef !== undefined && !isNonEmptyString(insight.scopeRef)) issues.push({ path: `${path}.scopeRef`, message: 'scopeRef 必须为非空字符串' })
  if (!Array.isArray(insight.citations)) {
    issues.push({ path: `${path}.citations`, message: 'citations 必须为数组' })
  } else {
    if (insight.citations.length === 0) issues.push({ path: `${path}.citations`, message: '至少需要一条证据引用' })
    insight.citations.forEach((rawCitation, index) => {
      const citationPath = `${path}.citations[${index}]`
      if (typeof rawCitation !== 'object' || rawCitation === null || Array.isArray(rawCitation)) {
        issues.push({ path: citationPath, message: '必须为对象' })
        return
      }
      const citation = rawCitation as Record<string, unknown>
      if (!isNonEmptyString(citation.title)) issues.push({ path: `${citationPath}.title`, message: 'title 必须为非空字符串' })
      if (!isNonEmptyString(citation.platform)) issues.push({ path: `${citationPath}.platform`, message: 'platform 必须为非空字符串' })
      if (!isNonEmptyString(citation.url) || !/^https?:\/\//i.test(citation.url as string)) {
        issues.push({ path: `${citationPath}.url`, message: 'url 必须为 http/https URL' })
      }
      if (Object.keys(citation).some((key) => !['title', 'platform', 'url', 'intelRef', 'contentRef', 'contentVersion', 'fragmentId'].includes(key))) {
        issues.push({ path: citationPath, message: 'citation 仅允许来源与当前证据引用字段' })
      }
      for (const key of ['intelRef', 'contentRef', 'contentVersion', 'fragmentId'] as const) {
        if (citation[key] !== undefined && !isNonEmptyString(citation[key])) {
          issues.push({ path: `${citationPath}.${key}`, message: `${key} 必须为非空字符串` })
        }
      }
      if (citation.contentRef !== undefined && citation.contentVersion === undefined) {
        issues.push({ path: `${citationPath}.contentVersion`, message: 'contentRef 必须固定 contentVersion' })
      }
    })
  }
  if (insight.attribution === undefined) {
    issues.push({ path: `${path}.attribution`, message: '必须提供 caller-supplied attribution' })
  } else {
    const attribution = insight.attribution
    const validString = typeof attribution === 'string' && attribution.trim().length > 0
    const validObject = typeof attribution === 'object' && attribution !== null && !Array.isArray(attribution)
      && (attribution as Record<string, unknown>).source === 'caller'
    if (!validString && !validObject) issues.push({ path: `${path}.attribution`, message: '归因必须明示 caller-supplied/source=caller' })
  }
  return issues
}

/** round3 归纳工件：四类 insight 原子校验，去重/冲突由调用方保留。 */
export function validateInsights(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(value)) return [{ path: 'insights', message: '必须为数组' }]
  const kinds = new Set<string>()
  value.forEach((item, index) => {
    issues.push(...validateInsight(item, `insights[${index}]`))
    if (typeof item === 'object' && item !== null && !Array.isArray(item)
      && isOneOf((item as Record<string, unknown>).kind, INSIGHT_KINDS)) {
      const kind = (item as Record<string, unknown>).kind as string
      if (kinds.has(kind)) issues.push({ path: `insights[${index}].kind`, message: `kind=${kind} 重复` })
      kinds.add(kind)
    }
  })
  if (kinds.size !== INSIGHT_KINDS.length || INSIGHT_KINDS.some((kind) => !kinds.has(kind))) {
    issues.push({ path: 'insights', message: '必须覆盖 recommend/avoid/guide/plan 四类' })
  }
  return issues
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

/** B6 cost.json：固定构成项、区间与状态枚举闸门。 */
export function validateCostArtifact(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path: '', message: 'cost 必须为对象' }]
  const artifact = value as Partial<CostArtifact>
  const version = schemaVersionOf(value)
  const strictRound3 = version === ROUND3_SCHEMA_VERSION
  if (version === undefined) issues.push({ path: 'schemaVersion', message: '必须声明 schemaVersion' })
  else if (!isKnownSchemaVersion(version)) issues.push({ path: 'schemaVersion', message: `未知 schemaVersion=${version}，仅允许只读解释` })
  if (!Number.isSafeInteger(artifact.placesVersion) || (artifact.placesVersion as number) < 0) issues.push({ path: 'placesVersion', message: '必须为非负安全整数' })
  if (!isNonEmptyString(artifact.currency)) issues.push({ path: 'currency', message: '必须为非空字符串' })
  if (!isNonEmptyString(artifact.inputFingerprint)) issues.push({ path: 'inputFingerprint', message: '必须为非空字符串' })
  if (!isIsoTimestamp(artifact.generatedAt)) issues.push({ path: 'generatedAt', message: '须为 ISO 时间戳' })

  const components = artifact.components
  const validComponentRanges: Array<[number, number]> = []
  if (components === undefined || typeof components !== 'object' || components === null || Array.isArray(components)) {
    issues.push({ path: 'components', message: '必须为对象' })
  } else {
    for (const key of COST_COMPONENT_KEYS) {
      const component = components[key]
      const p = `components.${key}`
      if (typeof component !== 'object' || component === null || Array.isArray(component)) {
        issues.push({ path: p, message: '构成项缺失' })
        continue
      }
      const c = component as unknown as Record<string, unknown>
      if (!isNonNegativeRangePair([c.min, c.max])) issues.push({ path: p, message: '必须满足 0≤min≤max 且为有限数值' })
      else if (isNonEmptyString(artifact.currency) && c.currency === artifact.currency) validComponentRanges.push([c.min as number, c.max as number])
      if (!isNonEmptyString(c.currency)) issues.push({ path: `${p}.currency`, message: '必须为非空字符串' })
      else if (isNonEmptyString(artifact.currency) && c.currency !== artifact.currency) issues.push({ path: `${p}.currency`, message: '必须与 cost.currency 一致，禁止混合币种' })
      if (!isNonEmptyString(c.source)) issues.push({ path: `${p}.source`, message: '必须为非空字符串' })
      if (!isOneOf(c.status, COST_COMPONENT_STATUSES)) issues.push({ path: `${p}.status`, message: 'status 枚举非法' })
      else if (c.status === 'unavailable' && (c.min !== 0 || c.max !== 0)) {
        issues.push({ path: p, message: 'status=unavailable 时 min/max 必须为 0，不能伪造可用金额' })
      }
      if (!Array.isArray(c.assumptions) || c.assumptions.some((item) => !isNonEmptyString(item))) {
        issues.push({ path: `${p}.assumptions`, message: '必须为字符串数组' })
      } else if (c.status === 'estimated' && c.assumptions.length === 0) {
        issues.push({ path: `${p}.assumptions`, message: 'status=estimated 时 assumptions 不得为空' })
      }
      if (c.unit !== undefined && !isNonEmptyString(c.unit)) issues.push({ path: `${p}.unit`, message: 'unit 必须为非空字符串' })
      if (c.priceRange !== undefined && !isNonNegativeRangePair(c.priceRange)) {
        issues.push({ path: `${p}.priceRange`, message: 'priceRange 必须为非负且 min≤max 的有限数值区间' })
      }
      if (c.quantity !== undefined && (!isFiniteNumber(c.quantity) || c.quantity <= 0)) {
        issues.push({ path: `${p}.quantity`, message: 'quantity 必须为正有限数值' })
      }
      if (c.quantityBasis !== undefined && !isOneOf(c.quantityBasis, COST_QUANTITY_BASES)) {
        issues.push({ path: `${p}.quantityBasis`, message: 'quantityBasis 须为 people|days|roomNights' })
      }
      if (c.scope !== undefined && !isOneOf(c.scope, COST_SCOPES)) {
        issues.push({ path: `${p}.scope`, message: 'scope 须为 total|perPerson' })
      }
      if (strictRound3) {
        if (!isNonEmptyString(c.unit)) issues.push({ path: `${p}.unit`, message: 'schemaVersion=2 必须提供 unit' })
        if (!isNonNegativeRangePair(c.priceRange)) issues.push({ path: `${p}.priceRange`, message: 'schemaVersion=2 必须提供 priceRange' })
        if (!isFiniteNumber(c.quantity) || c.quantity <= 0) issues.push({ path: `${p}.quantity`, message: 'schemaVersion=2 必须提供正 quantity' })
        if (!isOneOf(c.quantityBasis, COST_QUANTITY_BASES)) issues.push({ path: `${p}.quantityBasis`, message: 'schemaVersion=2 必须提供 quantityBasis' })
        if (!isOneOf(c.scope, COST_SCOPES)) issues.push({ path: `${p}.scope`, message: 'schemaVersion=2 必须提供 scope' })
      }
      if (c.priceRange !== undefined && isValidRangePair(c.priceRange)
        && isFiniteNumber(c.min) && isFiniteNumber(c.max)
        && (c.priceRange[0] > c.priceRange[1] || c.min > c.max)) {
        issues.push({ path: p, message: 'priceRange 与聚合 min/max 区间非法' })
      }
    }
  }

  const total = artifact.total
  if (typeof total !== 'object' || total === null || Array.isArray(total)) {
    issues.push({ path: 'total', message: '必须为对象' })
  } else {
    if (!isNonNegativeRangePair([total.min, total.max])) issues.push({ path: 'total', message: '必须满足 0≤min≤max 且为有限数值' })
    if (!isNonEmptyString(total.currency)) issues.push({ path: 'total.currency', message: '必须为非空字符串' })
    else if (isNonEmptyString(artifact.currency) && total.currency !== artifact.currency) issues.push({ path: 'total.currency', message: '必须与 cost.currency 一致' })
    if (validComponentRanges.length === COST_COMPONENT_KEYS.length && isNonNegativeRangePair([total.min, total.max])) {
      const expectedMin = roundMoney(validComponentRanges.reduce((sum, range) => sum + range[0], 0))
      const expectedMax = roundMoney(validComponentRanges.reduce((sum, range) => sum + range[1], 0))
      if (roundMoney(total.min as number) !== expectedMin || roundMoney(total.max as number) !== expectedMax) {
        issues.push({ path: 'total', message: `必须等于构成项汇总（期望 ${expectedMin}~${expectedMax}）` })
      }
    }
  }

  const budget = artifact.budget
  if (budget !== undefined) {
    if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) {
      issues.push({ path: 'budget', message: '必须为对象' })
    } else {
      if (!isFiniteNumber(budget.amount) || budget.amount < 0) issues.push({ path: 'budget.amount', message: '必须为非负有限数值' })
      if (!isOneOf(budget.scope, BUDGET_SCOPES)) issues.push({ path: 'budget.scope', message: `scope 须为 ${BUDGET_SCOPES.join('|')}` })
      if (!isNonEmptyString(budget.currency)) issues.push({ path: 'budget.currency', message: '必须为非空字符串' })
      else if (isNonEmptyString(artifact.currency) && budget.currency !== artifact.currency) issues.push({ path: 'budget.currency', message: '必须与 cost.currency 一致' })
    }
  }
  if (!Array.isArray(artifact.warnings) || artifact.warnings.some((item) => !isNonEmptyString(item))) issues.push({ path: 'warnings', message: '必须为字符串数组' })
  if (!Array.isArray(artifact.assumptions) || artifact.assumptions.some((item) => !isNonEmptyString(item))) issues.push({ path: 'assumptions', message: '必须为字符串数组' })
  return issues
}

/** 汇总校验：任一模型校验器 + 断言（不合即抛 TravelValidationError）。 */
export function assertValidIssues(issues: ValidationIssue[], prefix = ''): void {
  if (issues.length > 0) {
    throw new TravelValidationError(issues.map((i) => (i.path ? `${prefix}${i.path}: ${i.message}` : i.message)))
  }
}