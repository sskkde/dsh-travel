/**
 * round3 成本估价归一与聚合：只消费调用方明确提供且带证据的金额。
 * 这里不从 avgPrice/正文自由文本猜币种或数量；缺证据/混币项留在
 * costEstimates 之外，并由调用方决定是否重试。
 */
import {
  COST_COMPONENT_KEYS,
  COST_QUANTITY_BASES,
  COST_SCOPES,
  COST_COMPONENT_STATUSES,
  type CostComponent,
  type CostComponentKey,
  type CostEstimate,
  type CostEstimateInput,
  type CostQuantityBasis,
  type CostScope,
} from '../models/types.js'
import {
  isFiniteNumber,
  isNonEmptyString,
  isValidRangePair,
  type ValidationIssue,
} from '../models/validate.js'
import { redactSensitiveText } from '../adapters/search.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))
}

function rangeFrom(value: unknown, min: unknown, max: unknown): [number, number] | undefined {
  if (isValidRangePair(value)) return [value[0], value[1]]
  if (isFiniteNumber(min) && isFiniteNumber(max) && min >= 0 && max >= min) return [min, max]
  return undefined
}

function componentOf(value: unknown): CostComponentKey | undefined {
  if (typeof value !== 'string') return undefined
  return (COST_COMPONENT_KEYS as readonly string[]).includes(value) ? value as CostComponentKey : undefined
}

function enumOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function containsMarkup(value: string): boolean {
  return /<[^>]*>|(?:javascript|data|vbscript):/i.test(value)
}

/** 将输入边界归一为严格 CostEstimate；问题集中返回，调用方可保持原文件不变。 */
export function normalizeCostEstimates(raw: readonly unknown[]): {
  estimates: CostEstimate[]
  issues: ValidationIssue[]
} {
  const estimates: CostEstimate[] = []
  const issues: ValidationIssue[] = []
  raw.forEach((value, index) => {
    const path = `costEstimates[${index}]`
    if (!isRecord(value)) {
      issues.push({ path, message: '必须为对象' })
      return
    }
    const input = value as CostEstimateInput
    const component = componentOf(input.component) ?? componentOf(input.key)
    if (component === undefined) issues.push({ path: `${path}.component`, message: '必须为固定成本构成项' })
    const priceRange = rangeFrom(input.priceRange, input.min, input.max)
    if (priceRange === undefined || priceRange[0] < 0) issues.push({ path: `${path}.priceRange`, message: '必须为 0≤min≤max 的有限数值区间' })
    const currency = typeof input.currency === 'string' ? input.currency.trim() : ''
    if (currency === '') issues.push({ path: `${path}.currency`, message: '必须提供币种；不能从 avgPrice 推断' })
    const unit = typeof input.unit === 'string' ? input.unit.trim() : ''
    if (unit === '') issues.push({ path: `${path}.unit`, message: '必须提供单价单位' })
    const quantity = input.quantity
    if (!isFiniteNumber(quantity) || quantity <= 0) issues.push({ path: `${path}.quantity`, message: '必须为正有限数值' })
    if (!enumOf(input.quantityBasis, COST_QUANTITY_BASES)) issues.push({ path: `${path}.quantityBasis`, message: '必须为 people|days|roomNights' })
    if (!enumOf(input.scope, COST_SCOPES)) issues.push({ path: `${path}.scope`, message: '必须为 total|perPerson' })
    const source = typeof input.source === 'string' ? input.source.trim() : ''
    if (source === '') issues.push({ path: `${path}.source`, message: '必须提供来源' })
    const assumptions = input.assumptions
    if (!stringArray(assumptions)) issues.push({ path: `${path}.assumptions`, message: '必须为非空字符串数组' })
    else if (assumptions.length === 0) issues.push({ path: `${path}.assumptions`, message: '估价 assumptions 不得为空' })
    const evidenceRefs = stringArray(input.evidenceRefs)
      ? [...new Set(input.evidenceRefs.map((ref) => ref.trim()))]
      : stringArray(input.citations)
        ? [...new Set(input.citations.map((ref) => ref.trim()))]
        : []
    if (evidenceRefs.length === 0) issues.push({ path: `${path}.evidenceRefs`, message: '必须引用当前 intel 或固定正文版本' })
    const status = input.status === undefined ? 'estimated' : input.status
    if (!enumOf(status, COST_COMPONENT_STATUSES.filter((entry) => entry !== 'unavailable'))) {
      issues.push({ path: `${path}.status`, message: '只能为 quoted|estimated' })
    }
    for (const [field, text] of [['currency', currency], ['unit', unit], ['source', source]] as const) {
      if (containsMarkup(text)) issues.push({ path: `${path}.${field}`, message: '禁止 HTML/可执行 scheme' })
    }
    if (stringArray(assumptions) && assumptions.some(containsMarkup)) {
      issues.push({ path: `${path}.assumptions`, message: '禁止 HTML/可执行 scheme' })
    }
    if (typeof input.consumptionKey === 'string' && input.consumptionKey.trim() === '') {
      issues.push({ path: `${path}.consumptionKey`, message: '非空时必须为非空字符串' })
    }
    const safeSource = redactSensitiveText(source)
    const safeAssumptions = stringArray(assumptions)
      ? assumptions.map((assumption) => redactSensitiveText(assumption.trim())) : []
    const safeConsumptionKey = typeof input.consumptionKey === 'string' && input.consumptionKey.trim() !== ''
      ? redactSensitiveText(input.consumptionKey.trim()) : undefined
    if (component !== undefined && priceRange !== undefined && isFiniteNumber(quantity)
      && quantity > 0 && enumOf(input.quantityBasis, COST_QUANTITY_BASES)
      && enumOf(input.scope, COST_SCOPES) && source !== '' && stringArray(assumptions)
      && assumptions.length > 0 && evidenceRefs.length > 0 && currency !== '' && unit !== ''
      && enumOf(status, COST_COMPONENT_STATUSES.filter((entry) => entry !== 'unavailable'))) {
      estimates.push({
        component,
        priceRange,
        currency: redactSensitiveText(currency),
        unit: redactSensitiveText(unit),
        quantity,
        quantityBasis: input.quantityBasis as CostQuantityBasis,
        scope: input.scope as CostScope,
        source: safeSource,
        assumptions: safeAssumptions,
        evidenceRefs,
        ...(safeConsumptionKey !== undefined ? { consumptionKey: safeConsumptionKey } : {}),
        status: status as CostEstimate['status'],
      })
    }
  })
  const currencies = new Set(estimates.map((estimate) => estimate.currency))
  if (currencies.size > 1) {
    issues.push({ path: 'costEstimates.currency', message: '估价混合币种；缺少汇率证据，整批拒绝而不加总' })
  }
  return { estimates, issues }
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function estimateKey(estimate: CostEstimate): string {
  if (estimate.consumptionKey !== undefined) return `${estimate.component}|${estimate.consumptionKey}`
  return `${estimate.component}|${estimate.evidenceRefs.slice().sort().join(',')}|${estimate.priceRange.join('-')}|${estimate.quantity}|${estimate.unit}`
}

function aggregateMetadata(estimates: readonly CostEstimate[]): Pick<CostComponent, 'unit' | 'priceRange' | 'quantity' | 'quantityBasis' | 'scope'> {
  if (estimates.length === 1) {
    const one = estimates[0]
    return {
      unit: one.unit,
      priceRange: [...one.priceRange] as [number, number],
      quantity: one.quantity,
      quantityBasis: one.quantityBasis,
      scope: one.scope,
    }
  }
  return {
    unit: 'aggregate',
    priceRange: [roundMoney(estimates.reduce((sum, item) => sum + item.priceRange[0] * item.quantity, 0)),
      roundMoney(estimates.reduce((sum, item) => sum + item.priceRange[1] * item.quantity, 0))],
    quantity: 1,
    quantityBasis: 'people',
    scope: 'total',
  }
}

/** 把估价应用于固定六项；不覆盖已有 quoted 证据，且同一消费只计一次。 */
export function applyCostEstimates(
  components: Record<CostComponentKey, CostComponent>,
  estimates: readonly CostEstimate[],
  currency: string,
  warnings: string[],
): void {
  for (const key of COST_COMPONENT_KEYS) {
    const candidate = estimates.filter((estimate) => estimate.component === key)
    if (candidate.length === 0) continue
    if (components[key].status === 'quoted') {
      warnings.push(`成本项 ${key} 已有 quoted 证据，跳过重复 estimated 估价`)
      continue
    }
    const sameCurrency = candidate.filter((estimate) => estimate.currency === currency)
    const foreign = candidate.length - sameCurrency.length
    if (foreign > 0) warnings.push(`成本项 ${key} 有 ${foreign} 条外币估价，无汇率未计入`)
    const grouped = new Map<string, CostEstimate[]>()
    for (const estimate of sameCurrency) {
      const group = grouped.get(estimateKey(estimate)) ?? []
      group.push(estimate)
      grouped.set(estimateKey(estimate), group)
    }
    const selected: CostEstimate[] = []
    for (const group of grouped.values()) {
      const quoted = group.find((entry) => entry.status === 'quoted')
      selected.push(quoted ?? group[0])
    }
    if (selected.length === 0) continue
    const min = selected.reduce((sum, item) => sum + item.priceRange[0] * item.quantity, 0)
    const max = selected.reduce((sum, item) => sum + item.priceRange[1] * item.quantity, 0)
    const metadata = aggregateMetadata(selected)
    const status: CostComponent['status'] = selected.some((item) => item.status === 'quoted') ? 'quoted' : 'estimated'
    components[key] = {
      min: roundMoney(min),
      max: roundMoney(max),
      currency,
      ...metadata,
      source: [...new Set(selected.map((item) => item.source))].join(' + '),
      status,
      assumptions: [...new Set(selected.flatMap((item) => item.assumptions))],
    }
  }
}

/** v2 unavailable 构成项也补齐字段，保证 schema 可验证且不伪造金额。 */
export function unavailableCostComponent(currency: string, assumption: string): CostComponent {
  return {
    min: 0,
    max: 0,
    currency,
    unit: 'unknown',
    priceRange: [0, 0],
    quantity: 1,
    quantityBasis: 'people',
    scope: 'total',
    source: 'none',
    status: 'unavailable',
    assumptions: [assumption],
  }
}

/** v2 quoted/estimated 聚合项的公共投影；空数组显式 unavailable。 */
export function aggregateCostComponent(
  currency: string,
  ranges: readonly [number, number][],
  source: string,
  status: CostComponent['status'],
  assumptions: string[],
  metadata: Pick<CostComponent, 'unit' | 'quantityBasis' | 'scope'> = {
    unit: 'aggregate', quantityBasis: 'people', scope: 'total',
  },
): CostComponent {
  if (ranges.length === 0) return unavailableCostComponent(currency, assumptions[0] ?? `${source} 未提供可靠金额，未计入总额`)
  return {
    min: roundMoney(Math.min(...ranges.map((range) => range[0]))),
    max: roundMoney(Math.max(...ranges.map((range) => range[1]))),
    currency,
    unit: metadata.unit,
    priceRange: [roundMoney(Math.min(...ranges.map((range) => range[0]))), roundMoney(Math.max(...ranges.map((range) => range[1])))],
    quantity: 1,
    quantityBasis: metadata.quantityBasis,
    scope: metadata.scope,
    source,
    status,
    assumptions,
  }
}

export function aggregateSummedCostComponent(
  currency: string,
  ranges: readonly [number, number][],
  source: string,
  status: CostComponent['status'],
  assumptions: string[],
  metadata: Pick<CostComponent, 'unit' | 'quantityBasis' | 'scope'> = {
    unit: 'aggregate', quantityBasis: 'people', scope: 'total',
  },
): CostComponent {
  if (ranges.length === 0) return unavailableCostComponent(currency, assumptions[0] ?? `${source} 未提供可靠金额，未计入总额`)
  const min = ranges.reduce((sum, range) => sum + range[0], 0)
  const max = ranges.reduce((sum, range) => sum + range[1], 0)
  return {
    min: roundMoney(min),
    max: roundMoney(max),
    currency,
    unit: metadata.unit,
    priceRange: [roundMoney(min), roundMoney(max)],
    quantity: 1,
    quantityBasis: metadata.quantityBasis,
    scope: metadata.scope,
    source,
    status,
    assumptions,
  }
}
