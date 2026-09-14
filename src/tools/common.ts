/**
 * 工具层公共件：摘要卡片渲染 + 参数/输出 schema + 边界投影助手。
 *
 * render 契约：output.schema 是 canonical 值；render(args, value) 纯投影为
 * 对话内摘要卡片（design §6 行 514）。canonical 边界按官方 dsh-tool 惯例：
 * output 对象 `additionalProperties:false` + 逐属性 `required:true`，
 * execute 返回对象字面量（展开投影，避免 any/断言污染）。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Slots } from '../models/types.js'

/** 三个状态/槽位工具统一超时（§6 表：10s）。 */
export const TOOL_TIMEOUT_MS = 10_000

/**
 * canonical JSON 投影：领域接口（Slots 等，含嵌套接口）→ plain JSON。
 * JSON 往返保证产物是普通对象（模型校验器已保证 JSON 安全）；
 * 这是受限 JSON Schema 推断（JsonValue 面）与领域接口之间的唯一适配点，
 * 不做 any 化，注释明示。
 */
export function toCanonicalJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * lossless-JSON 边界投影（工具回执闸门）：递归剔除值为 undefined 的属性
 * （JSON 往返会丢键，宿主「lossless JSON」校验据此拒收）、非有限数值
 * （NaN/±Infinity）归一为 null、BigInt 归一为 Number。所有走宿主桥接层
 * 的工具返回值都应过此闸门（§6 输出契约）。
 */
export function losslessJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null as unknown as T
    if (typeof value === 'bigint') return Number(value) as unknown as T
    return value
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(losslessJson(item))
    return out as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue
    out[key] = losslessJson(v)
  }
  return out as unknown as T
}

/** 摘要卡片（纯文本块；text 内容即对话内卡片）。 */
export function textCard(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** 键值行 → 卡片的通用拼装。 */
export function cardLines(lines: readonly (readonly [string, string])[]): string {
  return lines.map(([k, v]) => `**${k}**：${v}`).join('\n')
}

/** 把未知输入窄化为普通对象（非对象/数组 → 空对象；错误输入交给校验器）。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : undefined
}

/**
 * 从 schema 推断的松槽位输入里挑出已知字段 → 领域 Slots。
 * 未知键忽略（§5.5 为字段级契约唯一样本）；值级校验（日期/枚举/天数
 * 一致性）在 normalizeAndValidateSlots 完成。
 */
export function pickSlots(value: unknown): Slots {
  const rec = asRecord(value)
  const slots: Slots = {}
  for (const key of ['origin', 'destination', 'dateStart', 'dateEnd'] as const) {
    if (typeof rec[key] === 'string') slots[key] = rec[key] as string
  }
  if (typeof rec.days === 'number') slots.days = rec.days
  const travelers = asRecord(rec.travelers)
  if (Object.keys(travelers).length > 0) {
    const t: NonNullable<Slots['travelers']> = {}
    if (typeof travelers.adults === 'number') t.adults = travelers.adults
    if (typeof travelers.children === 'number') t.children = travelers.children
    if (typeof travelers.seniors === 'number') t.seniors = travelers.seniors
    slots.travelers = t
  }
  const budget = asRecord(rec.budget)
  if (Object.keys(budget).length > 0) {
    const b: NonNullable<Slots['budget']> = {}
    if (typeof budget.amount === 'number') b.amount = budget.amount
    if (typeof budget.currency === 'string') b.currency = budget.currency
    if (typeof budget.scope === 'string') b.scope = budget.scope as NonNullable<Slots['budget']>['scope']
    slots.budget = b
  }
  const preferences = asRecord(rec.preferences)
  if (Object.keys(preferences).length > 0) {
    const p: NonNullable<Slots['preferences']> = {}
    if (typeof preferences.pace === 'string') p.pace = preferences.pace as NonNullable<Slots['preferences']>['pace']
    const themes = asStringArray(preferences.themes)
    if (themes !== undefined) p.themes = themes
    const diet = asStringArray(preferences.diet)
    if (diet !== undefined) p.diet = diet
    slots.preferences = p
  }
  const constraints = asStringArray(rec.constraints)
  if (constraints !== undefined) slots.constraints = constraints
  // W0 T1：researchIntent（text/keywords/regionHints；值级校验在 normalizeAndValidateSlots）
  const researchIntent = asRecord(rec.researchIntent)
  if (Object.keys(researchIntent).length > 0) {
    const ri: NonNullable<Slots['researchIntent']> = { text: '' }
    if (typeof researchIntent.text === 'string') ri.text = researchIntent.text
    const keywords = asStringArray(researchIntent.keywords)
    if (keywords !== undefined) ri.keywords = keywords
    const regionHints = asStringArray(researchIntent.regionHints)
    if (regionHints !== undefined) ri.regionHints = regionHints
    slots.researchIntent = ri
  }
  return slots
}

/** 槽位摘要（卡片/日志用；输入 unknown，内部窄化，避免强转）。 */
export function summarizeSlots(slots: unknown): string {
  const rec = asRecord(slots)
  if (Object.keys(rec).length === 0) return '（空槽位）'
  const parts: string[] = []
  const pick = (key: string): void => {
    const value = rec[key]
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${String(value)}`)
  }
  for (const key of ['destination', 'origin', 'dateStart', 'dateEnd', 'days']) pick(key)
  const travelers = asRecord(rec.travelers)
  if (Object.keys(travelers).length > 0) {
    const bits = ['adults', 'children', 'seniors']
      .filter((k) => travelers[k] !== undefined)
      .map((k) => `${k}${String(travelers[k])}`)
    if (bits.length > 0) parts.push(`travelers{${bits.join(',')}}`)
  }
  const budget = asRecord(rec.budget)
  if (Object.keys(budget).length > 0) {
    const bits = ['amount', 'currency', 'scope'].filter((k) => budget[k] !== undefined).map((k) => `${k}${String(budget[k])}`)
    parts.push(`budget{${bits.join(',')}}`)
  }
  for (const key of ['preferences', 'constraints']) {
    if (rec[key] !== undefined) parts.push(`${key}=…`)
  }
  return parts.join(' ') || '（空槽位）'
}