/**
 * W1 DR3（T7）——调用方 assessment 与充分性版本门（草稿 27-30,56-60）。
 *
 * travel_record_research_assessment：
 * - 只做 schema/版本/evidenceRefs 存在性与资源/授权校验，不内置模型语义判定（草稿 28）。
 * - 写 research-assessments/<assessmentId>.json 快照，更新 research-state 当前 assessment；
 *   新 assessment 使旧的当前 assessment 撤销当前有效性（superseded 保留历史，不静默删反证）。
 * - 当前有效 sufficient 必须引用当前 researchVersion（草稿 56/58）；版本过期 → 迟到写拒绝。
 * - 预算耗尽不产生 sufficient（草稿 60）。
 *
 * computeResearchStatus / researchNotReady（下游 resolve/完整规划的门）：
 * - 无当前 sufficient / 版本过期 / 预算耗尽 → research_not_ready（零网络，草稿 58-59）。
 */
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  IntelItem, ResearchAssessment, ResearchFinding, ResearchGap, ResearchConflict,
  ResearchState, ResearchVerdict,
} from '../models/types.js'
import { RESEARCH_VERDICTS } from '../models/types.js'
import { assertSafeResearchId } from '../store/paths.js'
import { TravelValidationError } from '../errors.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { assertTransition } from '../store/state.js'
import { cardLines, losslessJson, textCard } from './common.js'

/** unknown/未入账是可读但未入账；只有完整性失败/失败/空结果才禁止消费。 */
function readableArtifact<T>(state: ArtifactReadState<T>): T | undefined {
  if (!state.found || state.data === undefined) return undefined
  if (state.status === 'failed' || state.status === 'empty') return undefined
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') return undefined
  return state.data
}

function isUnaccounted<T>(state: ArtifactReadState<T>): boolean {
  return state.status === 'unknown'
    || (state.status === 'stale' && state.staleReason === 'not_in_commit')
}

/** 领域参数。 */
export interface RecordAssessmentArgs {
  planId: string
  expectedResearchVersion?: number
  verdict: ResearchVerdict
  rationale: string
  requirements?: string[]
  findings?: ResearchFinding[]
  gaps?: ResearchGap[]
  conflicts?: ResearchConflict[]
  evidenceRefs?: string[]
}

/** 工具返回。 */
export interface RecordAssessmentResult {
  planId: string
  assessmentId: string
  researchVersion: number
  verdict: ResearchVerdict
  recordedAt: string
  /** 被本次取代的旧当前 assessment（保留历史）。 */
  supersededAssessmentId?: string
}

/** 研究就绪判定（下游 resolve/完整规划的版本门；草稿 58-60）。 */
export interface ResearchStatus {
  ready: boolean
  reason?: 'research_not_ready' | 'ready'
  missing?: 'no_sufficient_assessment' | 'stale_version' | 'budget_exhausted'
  currentResearchVersion: number
  currentAssessmentId?: string
  detail?: string
}

const ASSESSMENT_PARAMETERS = {
  planId: { type: 'string', required: true, description: '计划 ID' },
  expectedResearchVersion: { type: 'integer', description: '调用方所依据研究版本（过期拒绝）' },
  verdict: { type: 'string', enum: [...RESEARCH_VERDICTS], required: true, description: '充分性判定：sufficient|continue|insufficient' },
  rationale: { type: 'string', required: true, description: '判定理由（调用方陈述）' },
  requirements: { type: 'array', items: { type: 'string' }, description: '需求/目标清单' },
  findings: { type: 'json', description: '发现项（claimId/陈述/证据引用/状态）' },
  gaps: { type: 'json', description: '缺口项（需求项 + 缺口）' },
  conflicts: { type: 'json', description: '冲突项（矛盾双方引用 + 结论/未决）' },
  evidenceRefs: { type: 'array', items: { type: 'string' }, description: '引用的证据（intel 条目 id / contentRef）' },
} as const
type AssessmentParams = InferArgs<typeof ASSESSMENT_PARAMETERS>

const ASSESSMENT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    assessmentId: { type: 'string', required: true },
    researchVersion: { type: 'integer', required: true },
    verdict: { type: 'string', required: true },
    recordedAt: { type: 'string', required: true },
    supersededAssessmentId: { type: 'string' },
  },
} as const
type AssessmentOutput = InferValue<typeof ASSESSMENT_OUTPUT_SCHEMA>

/** 取当前研究版本（无状态 → 0）。 */
export async function currentResearchVersion(store: TravelStore, planId: string): Promise<number> {
  const state = await store.readArtifactWithState<ResearchState>(planId, 'research-state.json')
  const data = readableArtifact(state)
  return data?.researchVersion ?? 0
}

/**
 * 版本门：当前有效 sufficient 是否就绪（草稿 58-59）。
 * - 无当前 sufficient assessment → research_not_ready（no_sufficient_assessment）
 * - 当前 sufficient 引用的 researchVersion ≠ 当前版本 → stale_version（新轮次/正文使其失效，不复活）
 * - 预算耗尽且当前 sufficient → 不视作充分（budget_exhausted）
 */
export async function computeResearchStatus(store: TravelStore, planId: string): Promise<ResearchStatus> {
  const stateRead = await store.readArtifactWithState<ResearchState>(planId, 'research-state.json')
  const state = readableArtifact(stateRead)
  const version = state?.researchVersion ?? 0
  const cur = state?.assessment
  const base = { currentResearchVersion: version, currentAssessmentId: cur?.assessmentId }

  if (cur === undefined) {
    return {
      ...base,
      ready: false,
      reason: 'research_not_ready',
      missing: 'no_sufficient_assessment',
      detail: '尚未提交 sufficient 评估：请先 travel_record_research_assessment（verdict=sufficient）',
    }
  }
  if (cur.status !== 'sufficient') {
    return {
      ...base,
      ready: false,
      reason: 'research_not_ready',
      missing: 'no_sufficient_assessment',
      detail: `当前 assessment（${cur.assessmentId}）verdict=${cur.status}，非 sufficient`,
    }
  }
  if (cur.researchVersion !== version) {
    return {
      ...base,
      ready: false,
      reason: 'research_not_ready',
      missing: 'stale_version',
      detail: `当前 sufficient 引用版本 ${cur.researchVersion}，现研究版本 ${version}（新证据已使旧判断失效）`,
    }
  }
  if (state?.budget.exhausted === true) {
    return {
      ...base,
      ready: false,
      reason: 'research_not_ready',
      missing: 'budget_exhausted',
      detail: '研究额度已耗尽（暂停非完成），不视为充分',
    }
  }
  return { ...base, ready: true, reason: 'ready' }
}

/** 判断提醒：研究是否就绪（供下游 resolve 断言用；零网络）。 */
export async function assertResearchReady(store: TravelStore, planId: string): Promise<ResearchStatus> {
  return computeResearchStatus(store, planId)
}

function normalizeEvidenceRefs(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return []
  return [...new Set(raw.map((r) => r.trim()).filter((r) => r !== ''))]
}

export async function runRecordResearchAssessment(
  args: RecordAssessmentArgs,
  store: TravelStore,
): Promise<RecordAssessmentResult> {
  // 计划级在途锁（C 期接线 F4-C5）：assessment 写 + 状态推进串行化。
  return store.withPlanLock(args.planId, () => runRecordResearchAssessmentUnlocked(args, store))
}

async function runRecordResearchAssessmentUnlocked(
  args: RecordAssessmentArgs,
  store: TravelStore,
): Promise<RecordAssessmentResult> {
  const planId = args.planId
  const request = await store.loadRequest(planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${planId} 不存在：请先 travel_intake 创建`])
  }
  assertTransition(request.status, 'researching')

  // 判定枚举 + 理由非空
  if (!RESEARCH_VERDICTS.includes(args.verdict)) {
    throw new TravelValidationError([`verdict 非法：${String(args.verdict)}（允许 ${RESEARCH_VERDICTS.join('|')}）`])
  }
  if ((args.rationale ?? '').trim() === '') {
    throw new TravelValidationError(['rationale 必须为非空字符串'])
  }

  const stateRead = await store.readArtifactWithState<ResearchState>(planId, 'research-state.json')
  const state = readableArtifact(stateRead)
  const unknownWarnings: string[] = []
  if (isUnaccounted(stateRead)) {
    unknownWarnings.push(`research-state.json 未入账（${stateRead.status}/${stateRead.staleReason ?? 'unknown'}），本次仅只读兼容消费`)
  }
  if (state === undefined) {
    throw new TravelValidationError([`研究状态当前不可消费（${stateRead.status}/${stateRead.staleReason ?? 'missing'}）：请先执行 travel_research_destination 再提交 assessment`])
  }
  const version = state.researchVersion

  // 版本门：expectedResearchVersion 必须等于当前版本（迟到写拒绝，草稿 56）
  if (args.expectedResearchVersion !== undefined && args.expectedResearchVersion !== version) {
    throw new TravelValidationError([
      `研究版本过期（expected=${args.expectedResearchVersion}，current=${version}）；`
      + '请基于当前 researchVersion 重新评估',
    ])
  }

  // 预算耗尽不产生 sufficient（草稿 60）
  if (args.verdict === 'sufficient' && state.budget.exhausted === true) {
    throw new TravelValidationError([
      '研究额度已耗尽（暂停非完成），不能提交 sufficient；请先补充/调整研究额度',
    ])
  }

  // evidenceRefs 存在性校验：每引用须为当前 intel 条目 id（或已存档 contentRef）
  const evidenceRefs = normalizeEvidenceRefs(args.evidenceRefs)
  if (evidenceRefs.length > 0) {
    const intelState = await store.readArtifactWithState<IntelItem[]>(planId, 'intel.json')
    const intel = readableArtifact(intelState)
    if (isUnaccounted(intelState)) {
      unknownWarnings.push(`intel.json 未入账（${intelState.status}/${intelState.staleReason ?? 'unknown'}），evidenceRefs 仅按盘上数据只读校验`)
    }
    if (intel === undefined && intelState.status !== 'missing') {
      throw new TravelValidationError([
        `intel.json 当前不可消费（${intelState.status}/${intelState.staleReason ?? 'unavailable'}）：无法验证 evidenceRefs`,
      ])
    }
    const intelItems = Array.isArray(intel) ? intel : []
    const intelIds = new Set(intelItems.map((i) => i.id))
    const missing = evidenceRefs.filter((r) => !intelIds.has(r))
    if (missing.length > 0) {
      throw new TravelValidationError([
        `evidenceRefs 引用不存在的证据：${missing.join(', ')}（须为当前 intel 条目 id）`,
      ])
    }
  }

  // 结构校验（findings/gaps/conflicts/requirements 形状）
  validateShape(args)

  const assessmentId = `assess-${Math.floor(Math.random() * 1e12).toString(36)}`
  const now = new Date().toISOString()
  const findings = args.findings ?? []
  const gaps = args.gaps ?? []
  const conflicts = args.conflicts ?? []
  const assessment: ResearchAssessment = {
    assessmentId,
    planId,
    researchVersion: version,
    verdict: args.verdict,
    rationale: args.rationale.trim(),
    requirements: args.requirements ?? [],
    findings,
    gaps,
    conflicts,
    evidenceRefs,
    recordedAt: now,
  }
  await store.writeResearchAssessment(planId, assessmentId, assessment)

  // 取代旧的当前 assessment（保留历史 + superseded 旁车标记）
  let supersededAssessmentId: string | undefined
  if (state.assessment !== undefined) {
    supersededAssessmentId = state.assessment.assessmentId
    const prior = await store.readResearchAssessment<ResearchAssessment>(planId, state.assessment.assessmentId)
    if (prior !== undefined) {
      await store.writeResearchAssessment(planId, prior.assessmentId, {
        ...prior,
        supersededBy: assessmentId,
        supersededAt: now,
      })
    }
  }

  // 更新 research-state 当前 assessment；经 manifest 提交，避免把状态文件
  // 写在版本账本之外而让下游误判为 unknown/stale。
  const nextState: ResearchState = {
    ...state,
    assessment: {
      assessmentId,
      status: args.verdict,
      researchVersion: version,
      recordedAt: now,
    },
    updatedAt: now,
  }
  // A clean legacy plan may still be assembled by older callers that write its
  // fixture artifacts after assessment. Keep that first state write compatible;
  // once any modern manifest exists, assessment is published atomically like all
  // later production state transitions.
  const existingMeta = await store.readJson<unknown>(planId, 'artifact-meta.json')
  if (existingMeta === undefined) {
    await store.saveResearchState(planId, nextState)
  } else {
    await store.publishArtifacts(planId, {
      stage: 'assessment',
      files: [{ name: 'research-state.json', data: nextState }],
      expectedVersions: { research: await store.currentVersion(planId, 'research') },
      bump: [],
      inputFingerprint: `assessment:${assessmentId}`,
    })
  }
  for (const reason of unknownWarnings) {
    await store.recordDegraded(planId, {
      source: 'research-assessment', code: 'UNAVAILABLE', reason, at: now,
    })
  }

  return {
    planId,
    assessmentId,
    researchVersion: version,
    verdict: args.verdict,
    recordedAt: now,
    ...(supersededAssessmentId !== undefined ? { supersededAssessmentId } : {}),
  }
}

function validateShape(args: RecordAssessmentArgs): void {
  for (const f of args.findings ?? []) {
    if (typeof f?.claimId !== 'string' || (f.claimId ?? '').trim() === '' || typeof f?.statement !== 'string') {
      throw new TravelValidationError(['findings 每项须含非空 claimId 与 statement'])
    }
    if (f.status !== undefined && !['confirmed', 'refuted', 'uncertain'].includes(f.status)) {
      throw new TravelValidationError([`findings[${f.claimId}].status 非法：${String(f.status)}`])
    }
  }
  for (const g of args.gaps ?? []) {
    if (typeof g?.requirement !== 'string' || typeof g?.gap !== 'string') {
      throw new TravelValidationError(['gaps 每项须含 requirement 与 gap'])
    }
  }
  for (const c of args.conflicts ?? []) {
    if (typeof c?.aRef !== 'string' || typeof c?.bRef !== 'string') {
      throw new TravelValidationError(['conflicts 每项须含 aRef/bRef'])
    }
  }
  for (const req of args.requirements ?? []) {
    if (typeof req !== 'string' || req.trim() === '') {
      throw new TravelValidationError(['requirements 须为非空字符串数组'])
    }
  }
  for (const ref of args.evidenceRefs ?? []) {
    assertSafeResearchId(ref, 'evidenceRef')
  }
}

function project(o: RecordAssessmentResult): AssessmentOutput {
  return {
    planId: o.planId,
    assessmentId: o.assessmentId,
    researchVersion: o.researchVersion,
    verdict: o.verdict,
    recordedAt: o.recordedAt,
    ...(o.supersededAssessmentId !== undefined ? { supersededAssessmentId: o.supersededAssessmentId } : {}),
  }
}

function render(_args: AssessmentParams, value: AssessmentOutput): ContentBlock[] {
  const lines: [string, string][] = [
    ['assessmentId', value.assessmentId],
    ['researchVersion', String(value.researchVersion)],
    ['verdict', value.verdict],
    ['记录时间', value.recordedAt],
  ]
  if (value.supersededAssessmentId !== undefined) {
    lines.push(['取代', value.supersededAssessmentId])
  }
  return textCard(`**travel_record_research_assessment** · 调用方评估已存\n${cardLines(lines)}`)
}

/** 工具定义工厂。 */
export function createTravelRecordResearchAssessmentTool(store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_record_research_assessment',
    description: '记录调用方研究充分性判断（DR3）：只校验 schema/版本/evidenceRefs 存在性与权限，不内置模型语义判定；当前有效 sufficient 必须引用当前 researchVersion；新证据使旧判断 supersede 保留历史；预算耗尽不产生 sufficient。',
    parameters: ASSESSMENT_PARAMETERS,
    output: { schema: ASSESSMENT_OUTPUT_SCHEMA, render },
    timeoutMs: 30_000,
    async execute(args) {
      const result = await runRecordResearchAssessment({
        planId: args.planId,
        expectedResearchVersion: args.expectedResearchVersion,
        verdict: args.verdict,
        rationale: args.rationale,
        requirements: args.requirements,
        findings: args.findings as ResearchFinding[] | undefined,
        gaps: args.gaps as ResearchGap[] | undefined,
        conflicts: args.conflicts as ResearchConflict[] | undefined,
        evidenceRefs: args.evidenceRefs,
      }, store)
      return losslessJson(project(result))
    },
  })
}

// ────────────────────────── DR4：assessment 读取工具 ──────────────────────────

/** 读取工具输入。 */
export interface ReadAssessmentArgs {
  planId: string
  /** 缺省用当前 assessment（research-state 指向）；显式给 assessmentId 读历史快照。 */
  assessmentId?: string
}

/** 读取工具返回（结构化摘要 + 计数；不含 intel 正文全文）。 */
export interface ReadAssessmentResult {
  planId: string
  found: boolean
  assessment?: ResearchAssessment
  stale: boolean
}

const READ_ASSESSMENT_PARAMETERS = {
  planId: { type: 'string', required: true, description: '计划 ID' },
  assessmentId: { type: 'string', description: 'assessment 快照 id；缺省用当前' },
} as const
type ReadAssessmentParams = InferArgs<typeof READ_ASSESSMENT_PARAMETERS>

const READ_ASSESSMENT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    found: { type: 'boolean', required: true },
    stale: { type: 'boolean', required: true },
    assessment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessmentId: { type: 'string', required: true },
        researchVersion: { type: 'integer', required: true },
        verdict: { type: 'string', required: true },
        rationale: { type: 'string', required: true },
        requirements: { type: 'array', items: { type: 'string' }, required: true },
        findings: { type: 'array', items: { type: 'json' }, required: true },
        gaps: { type: 'array', items: { type: 'json' }, required: true },
        conflicts: { type: 'array', items: { type: 'json' }, required: true },
        evidenceRefs: { type: 'array', items: { type: 'string' }, required: true },
        recordedAt: { type: 'string', required: true },
        supersededBy: { type: 'string' },
        supersededAt: { type: 'string' },
      },
    },
  },
} as const
type ReadAssessmentOutput = InferValue<typeof READ_ASSESSMENT_OUTPUT_SCHEMA>

/** 纯逻辑（测试直调）。 */
export async function runReadResearchAssessment(
  args: ReadAssessmentArgs,
  store: TravelStore,
): Promise<ReadAssessmentResult> {
  const planId = args.planId
  const request = await store.loadRequest(planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${planId} 不存在：请先 travel_intake 创建`])
  }
  const stateRead = await store.readArtifactWithState<ResearchState>(planId, 'research-state.json')
  const state = readableArtifact(stateRead)
  let assessmentId = args.assessmentId
  if (assessmentId === undefined) {
    assessmentId = state?.assessment?.assessmentId
    if (assessmentId === undefined) {
      return { planId, found: false, stale: false }
    }
  }
  assertSafeResearchId(assessmentId, 'assessmentId')
  const assessment = await store.readResearchAssessment<ResearchAssessment>(planId, assessmentId)
  if (assessment === undefined) {
    return { planId, found: false, stale: false }
  }
  const currentVersion = state?.researchVersion ?? 0
  const stale = assessment.researchVersion !== currentVersion
  return { planId, found: true, stale, assessment }
}

function projectRead(o: ReadAssessmentResult): ReadAssessmentOutput {
  if (o.assessment === undefined) {
    return { planId: o.planId, found: false, stale: false }
  }
  const a = o.assessment
  return {
    planId: o.planId,
    found: true,
    stale: o.stale,
    assessment: {
      assessmentId: a.assessmentId,
      researchVersion: a.researchVersion,
      verdict: a.verdict,
      rationale: a.rationale,
      requirements: [...a.requirements],
      findings: JSON.parse(JSON.stringify(a.findings)) as NonNullable<ReadAssessmentOutput['assessment']>['findings'],
      gaps: JSON.parse(JSON.stringify(a.gaps)) as NonNullable<ReadAssessmentOutput['assessment']>['gaps'],
      conflicts: JSON.parse(JSON.stringify(a.conflicts)) as NonNullable<ReadAssessmentOutput['assessment']>['conflicts'],
      evidenceRefs: [...a.evidenceRefs],
      recordedAt: a.recordedAt,
      ...(a.supersededBy !== undefined ? { supersededBy: a.supersededBy } : {}),
      ...(a.supersededAt !== undefined ? { supersededAt: a.supersededAt } : {}),
    },
  }
}

function renderRead(args: ReadAssessmentParams, value: ReadAssessmentOutput): ContentBlock[] {
  if (!value.found || value.assessment === undefined) {
    return textCard(`**travel_read_research_assessment** · 无 assessment\n${cardLines([
      ['planId', args.planId],
      ['found', 'false'],
      ['说明', args.assessmentId !== undefined ? '指定 assessment 不存在' : '计划尚无 assessment（请先 travel_record_research_assessment）'],
    ])}`)
  }
  const a = value.assessment
  const lines: [string, string][] = [
    ['planId', value.planId],
    ['assessmentId', a.assessmentId],
    ['researchVersion', String(a.researchVersion)],
    ['verdict', a.verdict],
    ['stale', String(value.stale)],
    ['记录时间', a.recordedAt],
    ['发现项', String(a.findings.length)],
    ['缺口项', String(a.gaps.length)],
    ['冲突项', String(a.conflicts.length)],
    ['需求项', String(a.requirements.length)],
    ['证据引用', a.evidenceRefs.join(', ') || '（无）'],
  ]
  if (a.supersededBy !== undefined) lines.push(['被取代', a.supersededBy])
  return textCard(`**travel_read_research_assessment** · assessment 快照\n${cardLines(lines)}`)
}

/** 工具定义工厂。 */
export function createTravelReadResearchAssessmentTool(store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_read_research_assessment',
    description: '读取研究充分性 assessment 快照（DR4）：缺省当前或按 assessmentId 读历史；返回 verdict/rationale/requirements/findings/gaps/conflicts/evidenceRefs 结构化摘要与 stale（引用版本 vs 当前研究版本）。不返回 intel 正文全文。',
    parameters: READ_ASSESSMENT_PARAMETERS,
    output: { schema: READ_ASSESSMENT_OUTPUT_SCHEMA, render: renderRead },
    timeoutMs: 10_000,
    async execute(args) {
      const result = await runReadResearchAssessment({ planId: args.planId, assessmentId: args.assessmentId }, store)
      return losslessJson(projectRead(result))
    },
  })
}
