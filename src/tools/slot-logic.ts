/**
 * 槽位语义逻辑（intake/update 共用，纯函数便于单测）：
 * 默认值+assumptions、状态判定、追问生成、补丁合并、rerunHints 推导。
 */
import type { RequestStatus, Slots, TravelMode } from '../models/types.js'
import { daysBetweenInclusive, isDateString, isNonEmptyString, type ValidationIssue } from '../models/validate.js'

/**
 * 合理默认值（§6 行 518 + FR-2 详 6：defaults + assumptions 明示）：
 * - 预算存在 → currency=CNY、scope=total
 * - 出行人数未给出成人数 → adults=1（travelers 对象缺省建档）
 * - 偏好存在 → pace=balanced
 * - 日期区间完整而 days 缺失 → 按区间推导
 * - W0 T1：researchIntent.keywords trim 去重保序（草稿 A：最多 6 条、1-100 字符；
 *   超限字符由 validateSlotsFields 拒绝，此处只做规范化不裁切）
 */
export function applySlotDefaults(slots: Slots): { slots: Slots; assumptions: string[] } {
  const next: Slots = { ...slots }
  const assumptions: string[] = []

  if (next.travelers === undefined) {
    next.travelers = { adults: 1 }
    assumptions.push('未提供出行人数，默认 1 名成人')
  } else if (next.travelers.adults === undefined) {
    next.travelers = { ...next.travelers, adults: 1 }
    assumptions.push('未提供成人数量，默认 1 名成人')
  }

  if (next.budget !== undefined) {
    if (next.budget.currency === undefined) {
      next.budget = { ...next.budget, currency: 'CNY' }
      assumptions.push('未指定币种，默认 CNY')
    }
    if (next.budget.scope === undefined) {
      next.budget = { ...next.budget, scope: 'total' }
      assumptions.push('未指定预算口径，默认按总预算 total 计')
    }
  }

  if (next.preferences !== undefined && next.preferences.pace === undefined) {
    next.preferences = { ...next.preferences, pace: 'balanced' }
    assumptions.push('未指定行程节奏，默认 balanced（适中）')
  }

  if (next.days === undefined && isDateString(next.dateStart) && isDateString(next.dateEnd)) {
    next.days = daysBetweenInclusive(next.dateStart, next.dateEnd)
    assumptions.push(`按日期区间推导行程 ${next.days} 天`)
  }

  if (next.researchIntent !== undefined) {
    const normalized: typeof next.researchIntent = { ...next.researchIntent }
    if (normalized.text !== undefined) normalized.text = normalized.text.trim()
    if (normalized.keywords !== undefined) {
      const seen = new Set<string>()
      const kept: string[] = []
      for (const raw of normalized.keywords) {
        const k = typeof raw === 'string' ? raw.trim() : ''
        if (k.length === 0 || seen.has(k)) continue
        seen.add(k)
        kept.push(k)
      }
      normalized.keywords = kept
    }
    next.researchIntent = normalized
  }

  return { slots: next, assumptions }
}

/**
 * W0 T1：无 researchIntent 的 destination-only 请求 → 映射为兼容兴趣种子
 * （草稿 A：destination 仍接受非空文本作为旧输入/地理提示，不再自动充当交通
 * 终点；自由文本 destination 不得自动断言成城市）。已有 researchIntent 或
 * 无 destination 时零改动。
 */
export function ensureInterestSeed(slots: Slots): { slots: Slots; assumptions: string[] } {
  if (slots.researchIntent !== undefined || !isNonEmptyString(slots.destination)) {
    return { slots, assumptions: [] }
  }
  return {
    slots: { ...slots, researchIntent: { text: slots.destination } },
    assumptions: [`destination「${slots.destination}」已映射为兼容兴趣种子（原样保留文本，不作城市断言）`],
  }
}

/** 状态判定（§5.4）：recommend 且目的地为空 → recommending；齐全 → confirmed；否则 collecting。 */
export function resolveRequestStatus(slots: Slots, mode: TravelMode, missing: readonly string[]): RequestStatus {
  if (mode === 'recommend' && !isNonEmptyString(slots.destination)) return 'recommending'
  return missing.length === 0 ? 'confirmed' : 'collecting'
}

const QUESTION_BY_MISSING: Readonly<Record<string, string>> = {
  destination: '计划去哪里？请告诉我目的地。',
  dateStart: '出发日期是哪天？（YYYY-MM-DD）',
  dateEnd: '返程日期是哪天？（YYYY-MM-DD）',
  days: '行程安排几天？',
}

/** 追问生成（§7 项 1：一次最多 2~3 问）：missing 优先 → ambiguity 兜位。 */
export function buildNextQuestions(
  missing: readonly string[],
  ambiguity: readonly ValidationIssue[],
  mode: TravelMode,
  maxQuestions = 3,
): string[] {
  const questions: string[] = []
  if (mode === 'plan' && missing.includes('destination')) {
    questions.push(QUESTION_BY_MISSING.destination ?? '')
  }
  for (const key of ['dateStart', 'dateEnd', 'days']) {
    if (missing.includes(key)) questions.push(QUESTION_BY_MISSING[key] ?? '')
  }
  const room = Math.max(0, maxQuestions - questions.length)
  for (const item of ambiguity.slice(0, room)) {
    questions.push(`请确认：${item.message}`)
  }
  return questions
}

const DEEP_KEYS = ['travelers', 'budget', 'preferences'] as const

/**
 * patch 合并（§6 行 525：patch 合并，未补字段保留原值）。
 * 顶层按 key 覆盖；travelers/budget/preferences 为一级深合并（patch 内
 * 提供的子字段覆盖原值，未提供保留）；数组（themes/diet/constraints）
 * 整组替换。researchIntent（W0 T1）同为一级深合并。
 */
export function mergeSlotPatch(base: Slots, patch: Partial<Slots>): Slots {
  const merged: Slots = { ...base }
  for (const key of DEEP_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    const current = base[key]
    merged[key] = { ...(current ?? {}), ...value }
  }
  // W0 T1：researchIntent 一级深合并（patch 内子字段覆盖，未提供保留）
  if (patch.researchIntent !== undefined) {
    merged.researchIntent = { ...(base.researchIntent ?? {}), ...patch.researchIntent }
  }
  for (const key of ['origin', 'destination', 'dateStart', 'dateEnd'] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key]
  }
  if (patch.days !== undefined) merged.days = patch.days
  if (patch.constraints !== undefined) merged.constraints = patch.constraints
  return merged
}

/** 变更维度判定（给 rerunHints 用；W0 T3 增 researchIntent）。 */
export type SlotChange = 'destination' | 'dates' | 'people' | 'budget' | 'preferences' | 'researchIntent' | 'none'

/** 比较新旧槽位，返回变更维度（重跑哪些研究项的依据，§7 项 7）。 */
export function slotsChanged(before: Slots, after: Slots): SlotChange[] {
  const changed: SlotChange[] = []
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  if (!eq(before.destination, after.destination)) changed.push('destination')
  if (!eq([before.dateStart, before.dateEnd, before.days], [after.dateStart, after.dateEnd, after.days])) {
    changed.push('dates')
  }
  if (!eq(before.travelers, after.travelers)) changed.push('people')
  if (!eq(before.budget, after.budget)) changed.push('budget')
  if (!eq(before.preferences, after.preferences) || !eq(before.constraints, after.constraints)) {
    changed.push('preferences')
  }
  if (!eq(before.researchIntent, after.researchIntent)) changed.push('researchIntent')
  return changed.length > 0 ? changed : ['none']
}

const RERUN_BY_CHANGE: Readonly<Record<Exclude<SlotChange, 'none'>, readonly string[]>> = {
  destination: ['travel_research_destination', 'travel_build_itinerary'],
  dates: ['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary'],
  people: ['travel_research_transport', 'travel_build_itinerary'],
  budget: ['travel_research_transport', 'travel_research_advice'],
  preferences: ['travel_research_destination', 'travel_build_itinerary'],
  researchIntent: ['travel_research_destination', 'travel_build_itinerary'],
}

/** 推导重跑提示（去重保序）。 */
export function rerunHintsFor(changes: readonly SlotChange[]): string[] {
  const hints: string[] = []
  for (const change of changes) {
    if (change === 'none') continue
    for (const hint of RERUN_BY_CHANGE[change]) {
      if (!hints.includes(hint)) hints.push(hint)
    }
  }
  return hints
}