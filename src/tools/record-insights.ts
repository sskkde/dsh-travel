/**
 * travel_record_insights —— 调用方归纳层的唯一写入口。
 *
 * 输入先过结构/长度/HTML/引用/版本全部闸门，再以一次 publishArtifacts
 * 原子提交 insights.json（以及可选的 cost.json）。插件不生成推荐，不把正文
 * 或社媒元信息复制到页面；冲突文本保留，只有完全相同的归纳才去重。
 */
import { defineTool, type InferArgs, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  INSIGHT_KINDS,
  INSIGHT_SCOPES,
  type CallerAttribution,
  type CostArtifact,
  type CostEstimate,
  type InsightAttribution,
  type InsightCitation,
  type InsightKind,
  type InsightScope,
  type TravelInsight,
  type IntelItem,
  type PlacesArtifact,
  type ResearchContentArtifact,
  type ResearchState,
  type RentalQuotesArtifact,
} from '../models/types.js'
import {
  isNonEmptyString,
  validateCostArtifact,
  validateInsight,
  type ValidationIssue,
} from '../models/validate.js'
import { TravelValidationError } from '../errors.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { assertTransition } from '../store/state.js'
import { cardLines, losslessJson, textCard } from './common.js'
import { redactSensitiveText, redactSensitiveUrl } from '../adapters/search.js'
import { normalizeCostEstimates } from './cost.js'

export interface RecordInsightsArgs {
  planId: string
  expectedResearchVersion: number
  expectedIntelVersion: number
  expectedPlacesVersion: number
  insights: readonly unknown[]
  costEstimates?: readonly unknown[]
}

export interface RecordInsightsResult {
  planId: string
  researchVersion: number
  intelVersion: number
  placesVersion: number
  insightCount: number
  dedupedCount: number
  costEstimateCount: number
  published: true
  insights: TravelInsight[]
  cost?: CostArtifact
}

const INSIGHTS_PARAMETERS = {
  planId: { type: 'string', required: true, description: '计划 ID' },
  expectedResearchVersion: { type: 'integer', required: true, description: '调用方依据的当前 researchVersion' },
  expectedIntelVersion: { type: 'integer', required: true, description: '调用方依据的当前 intel 版本' },
  expectedPlacesVersion: { type: 'integer', required: true, description: '调用方依据的当前 places 版本' },
  insights: {
    type: 'array', required: true, description: '调用方归纳条目（recommend/avoid/guide/plan）',
    items: { type: 'object', additionalProperties: true },
  },
  costEstimates: {
    type: 'array', description: '可选、有证据的成本估价；缺币种/口径/证据不接受',
    items: { type: 'object', additionalProperties: true },
  },
} as const

type RecordInsightsParams = InferArgs<typeof INSIGHTS_PARAMETERS>

const INSIGHTS_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    researchVersion: { type: 'integer', required: true },
    intelVersion: { type: 'integer', required: true },
    placesVersion: { type: 'integer', required: true },
    insightCount: { type: 'integer', required: true },
    dedupedCount: { type: 'integer', required: true },
    costEstimateCount: { type: 'integer', required: true },
    published: { type: 'boolean', required: true },
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasMarkup(value: string): boolean {
  return /<[^>]*>|(?:javascript|data|vbscript):/i.test(value)
}

function safeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

function nonEmptyString(value: unknown): value is string {
  return isNonEmptyString(value) && !hasMarkup(value)
}

function issueText(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`)
}

function normalizeCitation(
  value: unknown,
  path: string,
  intelIds: ReadonlySet<string>,
  store: TravelStore,
  planId: string,
): Promise<{ citation?: InsightCitation; issues: ValidationIssue[] }> {
  return (async () => {
    const issues: ValidationIssue[] = []
    if (!isRecord(value)) return { issues: [{ path, message: '必须为对象' }] }
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    const platform = typeof value.platform === 'string' ? value.platform.trim() : ''
    const url = typeof value.url === 'string' ? value.url.trim() : ''
    if (!nonEmptyString(title)) issues.push({ path: `${path}.title`, message: 'title 不得为空或包含 HTML' })
    if (!nonEmptyString(platform)) issues.push({ path: `${path}.platform`, message: 'platform 不得为空或包含 HTML' })
    if (!safeHttpUrl(url) || hasMarkup(url)) issues.push({ path: `${path}.url`, message: 'url 必须为无 userinfo 的 http/https URL' })
    const intelRef = typeof value.intelRef === 'string' ? value.intelRef.trim() : undefined
    const contentRef = typeof value.contentRef === 'string' ? value.contentRef.trim() : undefined
    const contentVersion = typeof value.contentVersion === 'string' ? value.contentVersion.trim() : undefined
    const fragmentId = typeof value.fragmentId === 'string' ? value.fragmentId.trim() : undefined
    if (intelRef !== undefined && contentRef !== undefined) {
      issues.push({ path, message: '一条引用不得同时使用 intelRef 与 contentRef' })
    }
    if (intelRef === undefined && contentRef === undefined) {
      issues.push({ path, message: '引用必须指向当前 intel 条目或固定正文版本' })
    }
    if (intelRef !== undefined && !intelIds.has(intelRef)) {
      issues.push({ path: `${path}.intelRef`, message: `不存在于当前 intel：${intelRef}` })
    }
    if (contentRef !== undefined) {
      if (!intelIds.has(contentRef)) issues.push({ path: `${path}.contentRef`, message: `正文所属 intel 条目不存在：${contentRef}` })
      if (contentVersion === undefined || contentVersion === '') {
        issues.push({ path: `${path}.contentVersion`, message: 'contentRef 必须固定 contentVersion' })
      } else {
        try {
          const artifact = await store.readResearchContent<ResearchContentArtifact>(planId, contentRef, contentVersion)
          if (artifact === undefined) {
            issues.push({ path: `${path}.contentVersion`, message: '固定正文版本不存在' })
          } else {
            if (artifact.contentRef !== contentRef || artifact.contentVersion !== contentVersion) {
              issues.push({ path: `${path}.contentVersion`, message: '正文版本引用与存档不一致' })
            }
            if (artifact.contentStatus !== 'extracted' && artifact.contentStatus !== 'partial') {
              issues.push({ path: `${path}.contentVersion`, message: '正文不是可引用的 extracted/partial 版本' })
            }
          }
        } catch {
          issues.push({ path: `${path}.contentVersion`, message: '固定正文版本路径非法或不可读' })
        }
      }
    }
    if (fragmentId !== undefined && !nonEmptyString(fragmentId)) {
      issues.push({ path: `${path}.fragmentId`, message: 'fragmentId 不得为空或包含 HTML' })
    }
    if (value.contentVersion !== undefined && contentRef === undefined) {
      issues.push({ path: `${path}.contentVersion`, message: 'contentVersion 只能随 contentRef 使用' })
    }
    if (value.fragmentId !== undefined && contentRef === undefined) {
      issues.push({ path: `${path}.fragmentId`, message: 'fragmentId 只能随 contentRef 使用' })
    }
    if (issues.length > 0 || !nonEmptyString(title) || !nonEmptyString(platform) || !safeHttpUrl(url)) return { issues }
    return {
      citation: {
        title: redactSensitiveText(title),
        platform: redactSensitiveText(platform),
        url: redactSensitiveUrl(url),
        ...(intelRef !== undefined ? { intelRef } : {}),
        ...(contentRef !== undefined ? { contentRef } : {}),
        ...(contentVersion !== undefined ? { contentVersion } : {}),
        ...(fragmentId !== undefined ? { fragmentId } : {}),
      },
      issues,
    }
  })()
}

async function normalizeInsight(
  value: unknown,
  index: number,
  intelIds: ReadonlySet<string>,
  store: TravelStore,
  planId: string,
): Promise<{ insight?: TravelInsight; issues: ValidationIssue[] }> {
  const path = `insights[${index}]`
  const issues = validateInsight(value, path)
  if (!isRecord(value)) return { issues }
  const kind = value.kind
  const scope = value.scope
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (typeof text === 'string' && hasMarkup(text)) issues.push({ path: `${path}.text`, message: '禁止 HTML/可执行 scheme' })
  if (typeof kind !== 'string' || !(INSIGHT_KINDS as readonly string[]).includes(kind)) return { issues }
  if (typeof scope !== 'string' || !(INSIGHT_SCOPES as readonly string[]).includes(scope)) return { issues }
  const rawCitations = Array.isArray(value.citations) ? value.citations : []
  const citations: InsightCitation[] = []
  for (let citationIndex = 0; citationIndex < rawCitations.length; citationIndex += 1) {
    const normalized = await normalizeCitation(rawCitations[citationIndex], `${path}.citations[${citationIndex}]`, intelIds, store, planId)
    issues.push(...normalized.issues)
    if (normalized.citation !== undefined) citations.push(normalized.citation)
  }
  const attributionValue = value.attribution
  let attribution: InsightAttribution | undefined
  if (typeof attributionValue === 'string') {
    if (nonEmptyString(attributionValue)) attribution = redactSensitiveText(attributionValue.trim())
    else issues.push({ path: `${path}.attribution`, message: '归因不得为空或包含 HTML' })
  } else if (isRecord(attributionValue) && attributionValue.source === 'caller') {
    const label = attributionValue.label
    const note = attributionValue.note
    if (label !== undefined && !nonEmptyString(label)) issues.push({ path: `${path}.attribution.label`, message: 'label 不得为空或包含 HTML' })
    if (note !== undefined && !nonEmptyString(note)) issues.push({ path: `${path}.attribution.note`, message: 'note 不得为空或包含 HTML' })
    const caller: CallerAttribution = {
      source: 'caller',
      ...(typeof label === 'string' && label.trim() !== '' ? { label: redactSensitiveText(label.trim()) } : {}),
      ...(typeof note === 'string' && note.trim() !== '' ? { note: redactSensitiveText(note.trim()) } : {}),
    }
    attribution = caller
  }
  const id = typeof value.id === 'string' && nonEmptyString(value.id) ? redactSensitiveText(value.id.trim()) : undefined
  if (value.id !== undefined && id === undefined) issues.push({ path: `${path}.id`, message: 'id 不得为空或包含 HTML' })
  const scopeRef = value.scopeRef === undefined ? undefined : typeof value.scopeRef === 'string' && nonEmptyString(value.scopeRef) ? redactSensitiveText(value.scopeRef.trim()) : undefined
  if (value.scopeRef !== undefined && scopeRef === undefined) issues.push({ path: `${path}.scopeRef`, message: 'scopeRef 不得为空或包含 HTML' })
  if (issues.length > 0 || attribution === undefined || !nonEmptyString(text)) return { issues }
  const insight: TravelInsight = {
    ...(id !== undefined ? { id } : {}),
    kind: kind as InsightKind,
    text: redactSensitiveText(text),
    scope: scope as InsightScope,
    ...(scopeRef !== undefined ? { scopeRef } : {}),
    citations,
    attribution,
  }
  return { insight, issues: [] }
}

function insightKey(insight: TravelInsight): string {
  return JSON.stringify({
    kind: insight.kind,
    text: insight.text,
    scope: insight.scope,
    scopeRef: insight.scopeRef,
    citations: insight.citations,
    attribution: insight.attribution,
  })
}

function readyEvidenceState<T>(state: ArtifactReadState<T>, label: string): T {
  if (!state.found || state.data === undefined || state.status === 'failed' || state.status === 'empty'
    || (state.status === 'stale' && state.staleReason === 'hash_mismatch')) {
    throw new TravelValidationError([`${label} 当前不可用（${state.status}/${state.staleReason ?? 'unavailable'}）；拒绝消费失败或完整性失配工件`])
  }
  return state.data
}

function isUnaccounted<T>(state: ArtifactReadState<T>): boolean {
  return state.status === 'unknown'
    || (state.status === 'stale' && state.staleReason === 'not_in_commit')
}

function assertNonNegativeVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TravelValidationError([`${label} 必须为非负安全整数`])
}

async function runRecordInsightsUnlocked(args: RecordInsightsArgs, store: TravelStore): Promise<RecordInsightsResult> {
  const request = await store.loadRequest(args.planId)
  if (request === undefined) throw new TravelValidationError([`计划 ${args.planId} 不存在：请先 travel_intake 创建`])
  assertTransition(request.status, 'researching')
  assertNonNegativeVersion(args.expectedResearchVersion, 'expectedResearchVersion')
  assertNonNegativeVersion(args.expectedIntelVersion, 'expectedIntelVersion')
  assertNonNegativeVersion(args.expectedPlacesVersion, 'expectedPlacesVersion')
  const researchStateRead = await store.readArtifactWithState<ResearchState>(args.planId, 'research-state.json')
  const researchState = researchStateRead.found && researchStateRead.data !== undefined
    && researchStateRead.status !== 'failed' && researchStateRead.status !== 'empty'
    && !(researchStateRead.status === 'stale' && researchStateRead.staleReason === 'hash_mismatch')
    ? researchStateRead.data : undefined
  const unknownWarnings: string[] = []
  if (isUnaccounted(researchStateRead)) {
    unknownWarnings.push(`research-state.json 未入账（${researchStateRead.status}/${researchStateRead.staleReason ?? 'unknown'}），归纳仅只读兼容消费`)
  }
  const currentResearchVersion = researchState?.researchVersion ?? 0
  const currentIntelVersion = await store.currentVersion(args.planId, 'intel')
  const currentPlacesVersion = await store.currentVersion(args.planId, 'places')
  const versionIssues: string[] = []
  if (currentResearchVersion !== args.expectedResearchVersion) versionIssues.push(`researchVersion expected=${args.expectedResearchVersion} current=${currentResearchVersion}`)
  if (currentIntelVersion !== args.expectedIntelVersion) versionIssues.push(`intelVersion expected=${args.expectedIntelVersion} current=${currentIntelVersion}`)
  if (currentPlacesVersion !== args.expectedPlacesVersion) versionIssues.push(`placesVersion expected=${args.expectedPlacesVersion} current=${currentPlacesVersion}`)
  if (versionIssues.length > 0) throw new TravelValidationError([`版本过期：${versionIssues.join('；')}`])
  if (researchState === undefined) throw new TravelValidationError(['缺少 research-state.json：无法证明归纳依据的研究版本'])

  const intelState = await store.readArtifactWithState<IntelItem[]>(args.planId, 'intel.json')
  const placesState = await store.readArtifactWithState<PlacesArtifact>(args.planId, 'places.json')
  const intelStageOwnedUnaccounted = isUnaccounted(intelState) && intelState.meta?.stage === 'research'
  const placesStageOwnedUnaccounted = isUnaccounted(placesState) && placesState.meta?.stage === 'places'
  if (intelStageOwnedUnaccounted || placesStageOwnedUnaccounted) {
    const artifact = intelStageOwnedUnaccounted ? 'intel.json' : 'places.json'
    throw new TravelValidationError([`${artifact} 最近一次所属阶段未入账，无法验证完整性；拒绝生成归纳`])
  }
  const intel = readyEvidenceState(intelState, 'intel.json')
  const places = readyEvidenceState(placesState, 'places.json')
  if (isUnaccounted(intelState)) {
    unknownWarnings.push(`intel.json 未入账（${intelState.status}/${intelState.staleReason ?? 'unknown'}），归纳仅只读兼容消费`)
  }
  if (isUnaccounted(placesState)) {
    unknownWarnings.push(`places.json 未入账（${placesState.status}/${placesState.staleReason ?? 'unknown'}），归纳仅只读兼容消费`)
  }
  if (!Array.isArray(intel)) throw new TravelValidationError(['intel.json 当前不是可引用的条目数组'])
  if (!isRecord(places) || !Number.isSafeInteger(places.intelVersion) || places.intelVersion < 0) {
    throw new TravelValidationError(['places.json 当前缺少可验证的 intelVersion'])
  }
  if (places.intelVersion !== currentIntelVersion) {
    throw new TravelValidationError([`places.intelVersion=${places.intelVersion} 未对齐当前 intel=${currentIntelVersion}；请先重新解析地点`])
  }
  const intelIds = new Set(intel
    .filter((item): item is IntelItem => isRecord(item) && typeof item.id === 'string' && item.id.trim() !== '')
    .map((item) => item.id))
  if (!Array.isArray(args.insights) || args.insights.length === 0) throw new TravelValidationError(['insights 必须为非空数组'])
  const normalized: TravelInsight[] = []
  const issues: ValidationIssue[] = []
  for (let index = 0; index < args.insights.length; index += 1) {
    const result = await normalizeInsight(args.insights[index], index, intelIds, store, args.planId)
    issues.push(...result.issues)
    if (result.insight !== undefined) normalized.push(result.insight)
  }
  const deduped: TravelInsight[] = []
  const seen = new Set<string>()
  for (const insight of normalized) {
    const key = insightKey(insight)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(insight)
  }
  const kinds = new Set(deduped.map((insight) => insight.kind))
  for (const kind of INSIGHT_KINDS) {
    if (!kinds.has(kind)) issues.push({ path: 'insights', message: `缺少 ${kind} 类归纳` })
  }

  let costEstimates: CostEstimate[] = []
  if (args.costEstimates !== undefined) {
    if (!Array.isArray(args.costEstimates)) issues.push({ path: 'costEstimates', message: '必须为数组' })
    else {
      const parsed = normalizeCostEstimates(args.costEstimates)
      issues.push(...parsed.issues)
      for (const estimate of parsed.estimates) {
        for (const ref of estimate.evidenceRefs) {
          if (!intelIds.has(ref)) {
            // A cost estimate may use a content citation; fixed-version existence
            // is checked below. Bare unknown IDs never become a price.
            let contentFound = false
            const separator = ref.lastIndexOf('@')
            if (separator > 0) {
              const contentRef = ref.slice(0, separator)
              const contentVersion = ref.slice(separator + 1)
              if (intelIds.has(contentRef)) {
                try {
                  const content = await store.readResearchContent<ResearchContentArtifact>(args.planId, contentRef, contentVersion)
                  contentFound = content?.contentVersion === contentVersion
                    && (content.contentStatus === 'extracted' || content.contentStatus === 'partial')
                } catch { contentFound = false }
              }
            }
            if (!contentFound) issues.push({ path: 'costEstimates.evidenceRefs', message: `证据不存在于当前 intel/正文版本：${ref}` })
          }
        }
      }
      costEstimates = parsed.estimates
    }
  }
  if (issues.length > 0) throw new TravelValidationError(issueText(issues))

  const now = new Date().toISOString()
  const files: Array<{ name: string; data: unknown }> = [{ name: 'insights.json', data: deduped }]
  let cost: CostArtifact | undefined
  if (costEstimates.length > 0) {
    // Cost assembly is imported lazily to keep the insight validator free of
    // research-channel side effects; the implementation is deterministic.
    const module = await import('./research-destination.js')
    const rentalState = await store.readArtifactWithState<RentalQuotesArtifact>(args.planId, 'rental-quotes.json')
    const rentalStageOwnedUnaccounted = isUnaccounted(rentalState) && rentalState.meta?.stage === 'rental-quotes'
    const rental = !rentalStageOwnedUnaccounted && rentalState.found && rentalState.data !== undefined
      && rentalState.status !== 'failed' && rentalState.status !== 'empty'
      && !(rentalState.status === 'stale' && rentalState.staleReason === 'hash_mismatch')
      ? rentalState.data : undefined
    if (isUnaccounted(rentalState) && rentalState.data !== undefined) {
      unknownWarnings.push(rentalStageOwnedUnaccounted
        ? `rental-quotes.json 未入账（${rentalState.status}/${rentalState.staleReason ?? 'unknown'}），最近一次为 rental-quotes 阶段，无法验证完整性，成本汇总不消费`
        : `rental-quotes.json 未入账（${rentalState.status}/${rentalState.staleReason ?? 'unknown'}），成本汇总仅只读兼容消费`)
    }
    cost = await module.buildCostArtifact(
      args.planId, request, store, currentPlacesVersion, rental, now, costEstimates,
    )
    const costIssues = validateCostArtifact(cost)
    if (costIssues.length > 0) throw new TravelValidationError(issueText(costIssues))
    files.push({ name: 'cost.json', data: cost })
  }
  await store.publishArtifacts(args.planId, {
    stage: 'insights',
    files,
    expectedVersions: {
      research: currentResearchVersion,
      intel: currentIntelVersion,
      places: currentPlacesVersion,
    },
    bump: cost === undefined ? [] : ['cost'],
    inputFingerprint: `insights:${currentResearchVersion}:${currentIntelVersion}:${currentPlacesVersion}`,
  })
  for (const reason of unknownWarnings) {
    await store.recordDegraded(args.planId, {
      source: 'record-insights', code: 'UNAVAILABLE', reason, at: now,
    })
  }
  if (request.status === 'confirmed') await store.saveRequest({ ...request, status: 'researching', updatedAt: now })
  return {
    planId: args.planId,
    researchVersion: currentResearchVersion,
    intelVersion: currentIntelVersion,
    placesVersion: currentPlacesVersion,
    insightCount: args.insights.length,
    dedupedCount: deduped.length,
    costEstimateCount: costEstimates.length,
    published: true,
    insights: deduped,
    ...(cost !== undefined ? { cost } : {}),
  }
}

export async function runRecordInsights(args: RecordInsightsArgs, store: TravelStore): Promise<RecordInsightsResult> {
  return store.withPlanLock(args.planId, () => runRecordInsightsUnlocked(args, store))
}

function projectRecord(result: RecordInsightsResult): {
  planId: string
  researchVersion: number
  intelVersion: number
  placesVersion: number
  insightCount: number
  dedupedCount: number
  costEstimateCount: number
  published: true
} {
  return {
    planId: result.planId,
    researchVersion: result.researchVersion,
    intelVersion: result.intelVersion,
    placesVersion: result.placesVersion,
    insightCount: result.insightCount,
    dedupedCount: result.dedupedCount,
    costEstimateCount: result.costEstimateCount,
    published: true,
  }
}

function renderRecord(args: RecordInsightsParams, value: ReturnType<typeof projectRecord>): ContentBlock[] {
  return textCard(`**travel_record_insights** · 已原子发布\n${cardLines([
    ['planId', args.planId],
    ['归纳', `${value.dedupedCount}/${value.insightCount} 条（完全重复已去重，冲突文本保留）`],
    ['成本估价', `${value.costEstimateCount} 条`],
    ['依据版本', `research ${value.researchVersion} / intel ${value.intelVersion} / places ${value.placesVersion}`],
  ])}`)
}

export function createTravelRecordInsightsTool(_store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_record_insights',
    description: '记录调用方归纳（recommend/avoid/guide/plan）：校验 ≤60 Unicode 字符、caller attribution、http/https 引用、当前 intel/固定正文版本，全部通过后原子发布 insights.json；可选 costEstimates 仅接受带币种/数量/口径/assumptions/证据者并重算 cost.json，不生成或补猜原文结论。',
    parameters: INSIGHTS_PARAMETERS,
    output: { schema: INSIGHTS_OUTPUT_SCHEMA, render: renderRecord },
    timeoutMs: 30_000,
    async execute(args) {
      const result = await runRecordInsights({
        planId: args.planId,
        expectedResearchVersion: args.expectedResearchVersion,
        expectedIntelVersion: args.expectedIntelVersion,
        expectedPlacesVersion: args.expectedPlacesVersion,
        insights: args.insights as readonly unknown[],
        costEstimates: args.costEstimates as readonly unknown[] | undefined,
      }, _store)
      return losslessJson(projectRecord(result))
    },
  })
}
