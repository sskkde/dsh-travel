/**
 * 修订影响分类与选择性重跑计划（M3.1 / design §9.2 / roadmap M3.1）。
 *
 * 纯函数模块：零网络、零 IO、确定性（同输入必得同输出）。
 *
 * - 固定影响表（M3.1 规格）：槽位变更 → 受影响 action 集合
 *   origin→transport/build/render；destination→全 5 项；dates/people→
 *   transport/advice/build/render；budget→destination/transport/build/render；
 *   preferences→destination/advice/build/render；constraints→全 5 项
 * - draft-only（不触发 research）：lodgingArea 修改 / 删减 stops / 压缩某日
 *   → 仅 build/render；旧研究 artifact（intel/transport/advice）原样保留
 * - `travel_update_request` 消费 classifyRevision + selectiveRerunPlan 产出
 *   lossless `revisionPlan` 投影；**update 自身不发起任何网络研究**，编排层
 *   按 plan.affected 顺序执行 action，plan 外 action 一律跳过（旧 rerunHints
 *   字段保持原语义，向后兼容，见 slot-logic.ts）
 */
import type { ItineraryDay, ItineraryStop, Slots } from '../models/types.js'

// ────────────────────────── action 全集与固定影响表 ──────────────────────────

/** 修订编排 action 全集（research → build → render；数组顺序=编排层执行顺序）。 */
export const REVISION_ACTIONS = [
  'travel_research_destination',
  'travel_research_transport',
  'travel_research_advice',
  'travel_build_itinerary',
  'travel_render_page',
] as const

export type RevisionAction = (typeof REVISION_ACTIONS)[number]

/** 影响表槽位分组 key（dates=dateStart/dateEnd/days 三字段组；people=travelers）。 */
export type RevisionSlotKey =
  | 'origin' | 'destination' | 'dates' | 'people' | 'budget' | 'preferences' | 'constraints'
  | 'researchIntent'

/**
 * 固定影响表（M3.1 规格，逐格硬编码；不随运行时状态变化）。
 * 每个 slot 组都含 build/render（行程与页面必然随槽位重建）。
 * W0 T3：researchIntent（草稿 F「真正修改兴趣/选择约束」）→ 全链
 * （intel→places→下游），与 destination 同级。
 */
const IMPACT_TABLE: Readonly<Record<RevisionSlotKey, readonly RevisionAction[]>> = {
  origin: ['travel_research_transport', 'travel_build_itinerary', 'travel_render_page'],
  destination: [
    'travel_research_destination', 'travel_research_transport', 'travel_research_advice',
    'travel_build_itinerary', 'travel_render_page',
  ],
  dates: ['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'],
  people: ['travel_research_transport', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'],
  budget: ['travel_research_destination', 'travel_research_transport', 'travel_build_itinerary', 'travel_render_page'],
  preferences: ['travel_research_destination', 'travel_research_advice', 'travel_build_itinerary', 'travel_render_page'],
  constraints: [
    'travel_research_destination', 'travel_research_transport', 'travel_research_advice',
    'travel_build_itinerary', 'travel_render_page',
  ],
  researchIntent: [
    'travel_research_destination', 'travel_research_transport', 'travel_research_advice',
    'travel_build_itinerary', 'travel_render_page',
  ],
}

/** draft-only 修订固定影响（仅行程层，绝不触发 research）。 */
const DRAFT_ONLY_ACTIONS: readonly RevisionAction[] = ['travel_build_itinerary', 'travel_render_page']

// ────────────────────────── W0 T3 工件级失效 DAG（草稿 F + 计划 DAG） ──────────────────────────

/**
 * 失效类别（草稿 F 行 167）：
 * - research-input：修改兴趣/发现词/地域 → 失效 intel→places→下游
 * - selection：只改选点/入口/顺序 → 失效 places→相应交通/advice/报价/build/render（intel 保留）
 * - dates：改日期 → 失效带日期研究与日程
 * - lodging：改住宿/入住安排 → 报价失效
 * - copy：仅展示文案 → 只 render 不重查网络
 */
export type QingganChangeKind = 'research-input' | 'selection' | 'dates' | 'lodging' | 'copy'

/** 类别附加失效工件（与 action 派生集求并；selection 全链即由本表给出）。 */
const KIND_EXTRA_ARTIFACTS: Readonly<Record<QingganChangeKind, readonly string[]>> = {
  'research-input': ['intel.json', 'places.json', 'lodging-quotes.json'],
  selection: [
    'places.json', 'transport.json', 'route-transport.json',
    'advice.json', 'lodging-quotes.json', 'itinerary.json', 'page.html',
  ],
  dates: ['intel.json', 'lodging-quotes.json'],
  lodging: ['lodging-quotes.json'],
  copy: ['page.html'],
}

/** action → 工件文件（M3 五 action 的确定性投影，供失效集求并）。 */
function artifactsForActions(actions: readonly RevisionAction[]): string[] {
  const set = new Set<string>()
  for (const action of actions) {
    switch (action) {
      case 'travel_research_destination': set.add('intel.json'); break
      case 'travel_research_transport': set.add('transport.json'); set.add('route-transport.json'); break
      case 'travel_research_advice': set.add('advice.json'); break
      case 'travel_build_itinerary': set.add('itinerary.json'); break
      case 'travel_render_page': set.add('page.html'); break
      default: break
    }
  }
  return [...set]
}

/**
 * DAG 顺序（草稿 164 依赖链；前置门数据，T16 落执行）：
 * request→研究轮次/intel/正文→当前 assessment→places→transport/route-transport/advice
 * →（places+stay 条件）lodging-quotes→build→render；coverage 依赖 intel/places 不反向触发。
 */
export const QINGGAN_DAG_ORDER: readonly string[] = [
  'request.json',
  'research-state.json',
  'research-rounds',
  'intel.json',
  'research-content',
  'research-assessments',
  'places.json',
  'transport.json',
  'route-transport.json',
  'advice.json',
  'lodging-quotes.json',
  'route-coverage.json',
  'itinerary.json',
  'page.html',
]

/** 工件 → 上游依赖（`research-rounds`/`research-content`/`research-assessments` 为子目录组）。 */
export const QINGGAN_ARTIFACT_UPSTREAMS: Readonly<Record<string, readonly string[]>> = {
  'research-state.json': [],
  'research-rounds': ['research-state.json'],
  'intel.json': ['research-state.json'],
  'research-content': ['intel.json'],
  'research-assessments': ['research-state.json', 'intel.json'],
  'places.json': ['intel.json'],
  'transport.json': ['places.json'],
  'route-transport.json': ['places.json'],
  'advice.json': ['places.json'],
  'lodging-quotes.json': ['places.json'],
  'route-coverage.json': ['intel.json', 'places.json'],
  'itinerary.json': ['transport.json', 'route-transport.json', 'advice.json', 'lodging-quotes.json', 'places.json'],
  'page.html': ['itinerary.json', 'transport.json', 'advice.json'],
}

// ────────────────────────── draft-only 天级修订检出 ──────────────────────────

/**
 * draft-only 天级修订类别（design §9.2「仅行程安排」路径；M3.1 三场景 +
 * W0 T3 copyOnly：仅展示文案改动 → 只 render）。
 */
export type DraftOnlyKind = 'lodgingArea' | 'stopsTrimmed' | 'dayCompressed' | 'copyOnly'

/** 单类天级修订检出结果（dayIndexes 升序；同一天可命中多类）。 */
export interface DraftOnlyChange {
  kind: DraftOnlyKind
  dayIndexes: number[]
}

/** stops 子序列判定（按名称保序匹配；next 是 prev 删减后的真子序列 → 删减 stops）。 */
function isProperStopsSubsequence(next: readonly ItineraryStop[], prev: readonly ItineraryStop[]): boolean {
  if (next.length === 0 || next.length >= prev.length) return false
  let pi = 0
  for (const stop of next) {
    while (pi < prev.length && prev[pi].name !== stop.name) pi++
    if (pi >= prev.length) return false
    pi++
  }
  return true
}

/** stops 总建议时长（缺省按 0 计）。 */
function totalDuration(stops: readonly ItineraryStop[]): number {
  return stops.reduce((sum, s) => sum + (s.durationHint ?? 0), 0)
}

/** 压缩判定：非「纯删减 stops」的内容缩减（删 meals / 缩时长 / 停止点重排变少）。 */
function isDayCompressed(prev: ItineraryDay, next: ItineraryDay): boolean {
  const prevMeals = prev.meals ?? []
  const nextMeals = next.meals ?? []
  if (nextMeals.length < prevMeals.length) return true
  if (next.stops.length < prev.stops.length) return true
  if (next.stops.length === prev.stops.length && totalDuration(next.stops) < totalDuration(prev.stops)) return true
  return false
}

/**
 * 纯文案变更判定（W0 T3 copyOnly）：结构（stops/meals 数/时长/lodgingArea）未动，
 * 仅 day.theme / stop.note / meal.name 文字变化（不触发网络研究，只重渲染）。
 * 注意：删 meals 属 dayCompressed（else-if 链先于本判定）；新增/改名 meals 在此
 * 判为 copyOnly。
 */
function copyTextChanged(prev: ItineraryDay, next: ItineraryDay): boolean {
  if (prev.theme !== next.theme) return true
  const stopsLen = Math.min(prev.stops.length, next.stops.length)
  for (let i = 0; i < stopsLen; i++) {
    if (prev.stops[i].note !== next.stops[i].note) return true
  }
  const prevMeals = prev.meals ?? []
  const nextMeals = next.meals ?? []
  if (prevMeals.map((m) => m.name).join('\u0000') !== nextMeals.map((m) => m.name).join('\u0000')) return true
  return false
}

/**
 * 天级修订检出（prev=当前 itinerary.days，next=修订 draft.days；纯比较）。
 * 仅按下标逐日配对比较（design §9.2：修改 draft 中受影响天，其余天结构原样保留）；
 * 检出类别固定顺序 lodgingArea → stopsTrimmed → dayCompressed → copyOnly（W0 T3）。
 */
export function detectDraftOnlyChanges(
  prev: readonly ItineraryDay[],
  next: readonly ItineraryDay[],
): DraftOnlyChange[] {
  const lodging: number[] = []
  const trimmed: number[] = []
  const compressed: number[] = []
  const copy: number[] = []
  const len = Math.min(prev.length, next.length)
  for (let i = 0; i < len; i++) {
    const a = prev[i]
    const b = next[i]
    if (a.lodgingArea !== b.lodgingArea) lodging.push(i)
    if (isProperStopsSubsequence(b.stops, a.stops)) {
      trimmed.push(i)
    } else if (isDayCompressed(a, b)) {
      compressed.push(i)
    } else if (a.lodgingArea === b.lodgingArea && copyTextChanged(a, b)) {
      copy.push(i)
    }
  }
  const changes: DraftOnlyChange[] = []
  if (lodging.length > 0) changes.push({ kind: 'lodgingArea', dayIndexes: lodging })
  if (trimmed.length > 0) changes.push({ kind: 'stopsTrimmed', dayIndexes: trimmed })
  if (compressed.length > 0) changes.push({ kind: 'dayCompressed', dayIndexes: compressed })
  if (copy.length > 0) changes.push({ kind: 'copyOnly', dayIndexes: copy })
  return changes
}

// ────────────────────────── 影响分类 ──────────────────────────

/** 修订影响分类结果（classifyRevision 返回；纯派生，无 IO）。 */
export interface RevisionImpact {
  /** 实质变化的槽位分组（固定检测顺序 origin→destination→dates→people→budget→preferences→constraints→researchIntent）。 */
  changedSlots: RevisionSlotKey[]
  /** 受影响 action 全集（按 REVISION_ACTIONS 顺序去重；draft-only 时仅 build/render）。 */
  affected: RevisionAction[]
  /** true = 无槽位变化、仅 draft 天级修订（lodgingArea/删减 stops/压缩某日）→ 不触发任何 research。 */
  draftOnly: boolean
  /** draft 天级修订受影响天索引（升序去重；无天级修订 → 空）。 */
  affectedDays: number[]
  /** W0 T3：失效类别（research-input/selection/dates/lodging/copy；保序去重）。 */
  changeKinds: readonly QingganChangeKind[]
  /** W0 T3：工件级失效集（文件级断言；action 派生集 ∪ 类别附加集，DAG 顺序保序）。 */
  invalidatedArtifacts: readonly string[]
}

/** 键序不敏感的稳定 JSON 串（深比较用；同值必同串，确定性）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function slotChanged(a: unknown, b: unknown): boolean {
  return stableJson(a) !== stableJson(b)
}

/** 槽位变更 → 失效类别（草稿 F：兴趣/发现词/地域 → research-input；日期 → dates）。 */
function kindsFromSlots(changedSlots: readonly RevisionSlotKey[]): QingganChangeKind[] {
  const kinds: QingganChangeKind[] = []
  if (changedSlots.includes('researchIntent') || changedSlots.includes('destination')) kinds.push('research-input')
  if (changedSlots.includes('dates')) kinds.push('dates')
  return kinds
}

/** draft 变更 → copy 类别（纯文案只 render）。 */
function kindsFromDrafts(draftChanges: readonly DraftOnlyChange[]): QingganChangeKind[] {
  return draftChanges.some((c) => c.kind === 'copyOnly') ? ['copy'] : []
}

/** 失效工件集 = action 派生集 ∪ 类别附加集（DAG 顺序保序去重）。 */
function computeInvalidated(affected: readonly RevisionAction[], kinds: readonly QingganChangeKind[]): string[] {
  const set = new Set<string>(artifactsForActions(affected))
  for (const kind of kinds) {
    for (const name of KIND_EXTRA_ARTIFACTS[kind]) set.add(name)
  }
  return projectArtifactsByDagOrder(set)
}

/** 按 DAG 顺序投影工件集（仅已知工件名；顺序稳定供文件级断言）。 */
function projectArtifactsByDagOrder(set: Set<string>): string[] {
  const order = [
    'intel.json', 'places.json', 'transport.json', 'route-transport.json',
    'advice.json', 'lodging-quotes.json', 'itinerary.json', 'page.html',
  ]
  const out: string[] = []
  for (const name of order) {
    if (set.has(name)) out.push(name)
  }
  return out
}

/**
 * 修订影响分类：比较修订前后槽位（mergeSlotPatch + normalize 之后）+ 可选的
 * draft 天级修订检出结果 + 可选外部失效类别（selection/lodging——来自
 * resolve/住宿安排变更，W2/W3 消费)，判定受影响 action 与工件级失效集。
 *
 * - 任一槽位变化 → 按固定影响表并集（research→build→render 保序去重）
 * - 无槽位变化且有 draft 天级修订 → draft-only：结构修订仅 build/render；
 *   copyOnly 仅 render（不重查网络）
 * - 两者同时存在 → 槽位影响表为准（research 照跑），draft 天索引仍如实给出
 */
export function classifyRevision(
  before: Slots,
  after: Slots,
  draftChanges: readonly DraftOnlyChange[] = [],
  extraKinds: readonly QingganChangeKind[] = [],
): RevisionImpact {
  const checks: readonly (readonly [RevisionSlotKey, boolean])[] = [
    ['origin', slotChanged(before.origin, after.origin)],
    ['destination', slotChanged(before.destination, after.destination)],
    ['dates', slotChanged(
      [before.dateStart, before.dateEnd, before.days],
      [after.dateStart, after.dateEnd, after.days],
    )],
    ['people', slotChanged(before.travelers, after.travelers)],
    ['budget', slotChanged(before.budget, after.budget)],
    ['preferences', slotChanged(before.preferences, after.preferences)],
    ['constraints', slotChanged(before.constraints, after.constraints)],
    ['researchIntent', slotChanged(before.researchIntent, after.researchIntent)],
  ]
  const changedSlots = checks.filter(([, changed]) => changed).map(([key]) => key)

  const affectedSet = new Set<RevisionAction>()
  if (changedSlots.length > 0) {
    for (const slot of changedSlots) {
      for (const action of IMPACT_TABLE[slot]) affectedSet.add(action)
    }
  } else if (draftChanges.length > 0) {
    const hasStructuralDraft = draftChanges.some(
      (c) => c.kind === 'lodgingArea' || c.kind === 'stopsTrimmed' || c.kind === 'dayCompressed',
    )
    if (hasStructuralDraft) {
      for (const action of DRAFT_ONLY_ACTIONS) affectedSet.add(action)
    }
    if (draftChanges.some((c) => c.kind === 'copyOnly')) {
      affectedSet.add('travel_render_page')
    }
  }
  const affected = REVISION_ACTIONS.filter((a) => affectedSet.has(a))

  const daySet = new Set<number>()
  for (const change of draftChanges) {
    for (const day of change.dayIndexes) daySet.add(day)
  }

  // W0 T3 失效类别与工件级失效集（DAG 顺序保序）
  const kinds: QingganChangeKind[] = [
    ...kindsFromSlots(changedSlots),
    ...extraKinds,
    ...kindsFromDrafts(draftChanges),
  ].filter((kind, i, all) => all.indexOf(kind) === i)
  const invalidatedArtifacts = computeInvalidated(affected, kinds)

  return {
    changedSlots,
    affected,
    draftOnly: changedSlots.length === 0 && draftChanges.length > 0,
    affectedDays: [...daySet].sort((a, b) => a - b),
    changeKinds: kinds,
    invalidatedArtifacts,
  }
}

// ────────────────────────── 选择性重跑计划 ──────────────────────────

/** 按 slot 分组的受影响 action（lossless 投影节点；未变化的分组不出现）。 */
export interface RevisionSlotImpact {
  /** 分组 key：槽位组，或 'draft'=纯行程层天级修订。 */
  slot: RevisionSlotKey | 'draft'
  /** 该分组触发的 action（去重保序）。 */
  actions: RevisionAction[]
  /** 'draft' 分组的受影响天索引（0-based 升序）；槽位组不设此字段（可选字段省略，不落 undefined）。 */
  dayIndexes?: number[]
}

/**
 * 选择性重跑计划（lossless 投影，M3.1）：编排层按 affected 顺序执行 action，
 * unaffected 一律跳过（旧研究 artifact 不删除，只声明要重跑的部分）。
 */
export interface RevisionPlan {
  /** 计划 ID（跨修订复用）。 */
  planId: string
  /** 按变更分组（槽位组 + 可选 draft 组）列出的受影响 action。 */
  bySlot: RevisionSlotImpact[]
  /** true = 纯行程层修订（lodgingArea/删减 stops/压缩某日），不触发任何 research。 */
  draftOnly: boolean
  /** 编排层需执行的 action 全集（research→build→render 保序去重）。 */
  affected: RevisionAction[]
  /** 本轮不受影响、保留既有产物的 action（全集 − affected）。 */
  unaffected: RevisionAction[]
}

/**
 * 由影响分类生成计划（确定性；planId 原样透传，无 IO）。
 * bySlot 顺序=变更检测顺序（各槽位组在前，draft 组殿后）。
 */
export function selectiveRerunPlan(planId: string, impact: RevisionImpact): RevisionPlan {
  const bySlot: RevisionSlotImpact[] = impact.changedSlots.map((slot) => ({
    slot,
    actions: REVISION_ACTIONS.filter((a) => IMPACT_TABLE[slot].includes(a)),
  }))
  const hasDraftChanges = impact.affectedDays.length > 0
  if (hasDraftChanges) {
    bySlot.push({
      slot: 'draft',
      actions: [...DRAFT_ONLY_ACTIONS],
      dayIndexes: [...impact.affectedDays],
    })
  }
  const affectedSet = new Set<RevisionAction>(impact.affected)
  return {
    planId,
    bySlot,
    draftOnly: impact.draftOnly,
    affected: [...impact.affected],
    unaffected: REVISION_ACTIONS.filter((a) => !affectedSet.has(a)),
  }
}
