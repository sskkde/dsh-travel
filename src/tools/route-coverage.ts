/**
 * W2 T10 route-coverage v2 与 lineage 引用链（草稿 C）。
 *
 * - 有效研究区域从明确 regionHints、情报发现地点及选中序列生成，不再依赖旧
 *   route.waypoints 字符串作为唯一输入。
 * - covered 是最低研究覆盖：attraction/lodging 均有 ≥1 条合格情报 且 attraction
 *   有可信坐标；partial 为部分满足；missing 为零合格结果。不等同于可预订、
 *   完整路线或安全承诺。未达 covered 记 reasonCodes
 *   （budget_exhausted|disabled|unavailable|no_results|filtered_quality|unresolved_geo）。
 * - 归属可验证：intel 条目只计入其候选 intelRefs 显式引用的区域（多主题游记不
 *   因摘要含某城市名而整体绑定单城市）；OSM 坐标 + OSM 查询同源不计独立互证，
 *   保留上游 attribution 与 coordinate_source。
 * - coverage 依赖 intel/places，只读不写回，绝不反向触发（不 bump 版本、不覆盖）。
 * - 旧版本文件显示 stale：下游据已发布 route-coverage 的 intelVersion/placesVersion
 *   对照当前版本账本判定（computeRouteCoverageStale）。
 */
import { createHash } from 'node:crypto'
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { TravelValidationError } from '../errors.js'
import { cardLines, losslessJson, textCard } from './common.js'
import type {
  CoverageReasonCode, CoverageRegion, CoverageStatus, IntelItem, PlacesArtifact,
  ResearchState, ResolvedPlace, RouteCoverageArtifact,
} from '../models/types.js'

/** 区域数安全上限（防失控 fanout；正常青甘 fixture 远小于）。 */
export const COVERAGE_REGION_MAX = 60

/** route-coverage 输入。 */
export interface RouteCoverageArgs {
  planId: string
  /** 显式研究区域名（草稿 C：有效区=regionHints∪情报发现地点∪选中序列派生）。 */
  regionHints?: string[]
  /** 调用方所依据 places 版本（过期 → places_stale 不计算，零网络）。 */
  expectedPlacesVersion?: number
  /** 调用方所依据 intel 版本（过期 → intel_stale 不计算，零网络）。 */
  expectedIntelVersion?: number
}

/** route-coverage 返回。 */
export interface RouteCoverageResult {
  planId: string
  /** ready | places_not_ready | places_stale | intel_stale。 */
  status: 'ready' | 'places_not_ready' | 'places_stale' | 'intel_stale'
  intelVersion: number
  placesVersion: number
  inputFingerprint: string
  regions: CoverageRegion[]
  lineage: RouteCoverageArtifact['lineage']
  /** 本次重算是否取代了已过期的旧工件（旧版本显示 stale）。 */
  replacedStale?: boolean
  /** 门回执（零网络，未计算）。 */
  placesNotReady?: { reason: 'places_not_ready' | 'places_stale' | 'intel_stale'; detail?: string }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** unknown/未入账允许只读兼容；失败/空结果/hash 失配仍禁止消费。 */
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

/** 当前研究版本 = intel 证据版本（研究 provider 以 research-state.researchVersion 演进）。 */
async function currentIntelVersion(store: TravelStore, planId: string): Promise<number> {
  const state = await store.readArtifactWithState<ResearchState>(planId, 'research-state.json')
  const data = readableArtifact(state)
  return data?.researchVersion ?? 0
}

function computeInputFingerprint(
  regions: string[], intelVersion: number, placesVersion: number,
): string {
  const payload = JSON.stringify({ regions, intelVersion, placesVersion })
  return sha256(payload).slice(0, 24)
}

/** intel 是否为 OSM 派生（OSM 查询/坐标源；草稿 C：与 OSM 坐标同源不计独立互证）。 */
function isOsmDerived(item: IntelItem | undefined): boolean {
  if (item === undefined) return false
  const platform = (item.source?.platform ?? '').toLowerCase()
  if (platform.includes('osm')) return true
  const channel = (item.channel ?? '').toLowerCase()
  return channel === 'osm' || channel.includes('osm')
}

/** 可信坐标（非 unresolved/disabled；保留 coordinate_source 原文不抹掉）。 */
function hasTrustedCoords(p: ResolvedPlace): boolean {
  if (p.coords === undefined) return false
  return p.coordinate_source !== 'unresolved' && p.coordinate_source !== 'disabled'
}

/** OSM 坐标 来源。 */
function isOsmCoords(p: ResolvedPlace): boolean {
  return p.coordinate_source === 'osm'
}

/** 合格情报：有出处（source.platform/url + title 非空）→ 未被质量过滤；否则 filtered_quality。 */
function isQualified(item: IntelItem): boolean {
  return (item.title?.trim() ?? '') !== ''
    && (item.source?.platform?.trim() ?? '') !== ''
    && (item.source?.url?.trim() ?? '') !== ''
}

/** 单个区域输入（归并候选/地点/情报）。 */
interface RegionInput {
  name: string
  candidates: Array<{ candidateId: string; intelRefs?: string[] }>
  places: ResolvedPlace[]
  /** 合格情报：category → items（仅由本区域候选 intelRefs 显式引用）。 */
  qualified: Map<string, IntelItem[]>
  /** 全部原始情报（含无出处）。 */
  raw: Map<string, IntelItem[]>
}

function classifyRegion(r: RegionInput): {
  status: CoverageStatus
  missingCategories: string[]
  reasonCodes: CoverageReasonCode[]
  coordsCount: number
  intelRefs: string[]
  categoryCounts: Record<string, number>
} {
  const gating = ['attraction', 'lodging'] as const
  const refs: string[] = []
  const categoryCounts: Record<string, number> = {}
  for (const [cat, items] of r.qualified) {
    categoryCounts[cat] = items.length
    for (const it of items) if (!refs.includes(it.id)) refs.push(it.id)
  }

  const attrQ = r.qualified.get('attraction')?.length ?? 0
  const lodgQ = r.qualified.get('lodging')?.length ?? 0
  const attrRaw = r.raw.get('attraction')?.length ?? 0
  const lodgRaw = r.raw.get('lodging')?.length ?? 0

  const coordsCount = r.places.filter(hasTrustedCoords).length
  const totalQualified = attrQ + lodgQ

  const missingCats = gating.filter((c) => (r.qualified.get(c)?.length ?? 0) === 0)

  // 独立互证的 attraction 可信坐标：非仅 OSM 单源（OSM 坐标 + OSM 查询同源不计互证）
  const indepCoordsOk = r.places.some((p) => {
    if (p.kind !== 'attraction' || !hasTrustedCoords(p)) return false
    if (!isOsmCoords(p)) return true
    // OSM 坐标 → 须有非 OSM 派生的候选情报支撑才视为独立互证
    return r.candidates.some((c) => c.candidateId === p.candidateId && (c.intelRefs ?? [])
      .some((ref) => {
        const item = r.qualified.get('attraction')?.find((i) => i.id === ref)
        return !isOsmDerived(item)
      }))
  })

  // 零合格情报（gating 类全无结果）→ missing（归因 no_results / filtered_quality）
  if (totalQualified === 0) {
    const hadRaw = attrRaw + lodgRaw > 0
    return {
      status: 'missing',
      missingCategories: [...gating],
      reasonCodes: hadRaw ? ['filtered_quality'] : ['no_results'],
      coordsCount,
      intelRefs: refs,
      categoryCounts,
    }
  }

  // covered：两类情报齐 且 独立互证可信坐标 具备
  if (attrQ >= 1 && lodgQ >= 1 && indepCoordsOk) {
    return { status: 'covered', missingCategories: [], reasonCodes: [], coordsCount, intelRefs: refs, categoryCounts }
  }

  // partial：归因原因码
  const rc: CoverageReasonCode[] = []
  if (attrQ >= 1 && lodgQ >= 1 && !indepCoordsOk) {
    rc.push('unresolved_geo')
  }
  return { status: 'partial', missingCategories: missingCats, reasonCodes: rc, coordsCount, intelRefs: refs, categoryCounts }
}

export async function runRouteCoverage(
  args: RouteCoverageArgs,
  store: TravelStore,
): Promise<RouteCoverageResult> {
  // 计划级在途锁（C 期接线 F4-C5）：coverage 落盘与 route-transport 串行化。
  return store.withPlanLock(args.planId, () => runRouteCoverageUnlocked(args, store))
}

async function runRouteCoverageUnlocked(
  args: RouteCoverageArgs,
  store: TravelStore,
): Promise<RouteCoverageResult> {
  const planId = args.planId
  const request = await store.loadRequest(planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${planId} 不存在：请先 travel_intake 创建`])
  }

  const intelVersion = await currentIntelVersion(store, planId)
  const placesVersion = await store.currentVersion(planId, 'places')

  // ── 门：依赖可读 places（unknown 只读兼容；完整性失败仍阻断） ──
  const placesState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  const placesStageOwnedUnaccounted = placesState.status === 'unknown'
    && placesState.staleReason === 'unaccounted' && placesState.meta?.stage === 'places'
  const placesStageOwnedUnverifiable = placesState.status === 'stale'
    && placesState.staleReason === 'not_in_commit' && placesState.meta?.stage === 'places'
  if (placesStageOwnedUnaccounted || placesStageOwnedUnverifiable) {
    return {
      planId,
      status: 'places_stale',
      intelVersion,
      placesVersion,
      inputFingerprint: '',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
      placesNotReady: { reason: 'places_stale', detail: 'places 最近一次提交声明属于 places 阶段，但工件未入账/无法验证完整性：不复活旧数据' },
    }
  }
  if (placesState.status === 'failed' || placesState.status === 'empty'
    || (placesState.status === 'stale' && placesState.staleReason === 'hash_mismatch')) {
    return {
      planId,
      status: 'places_stale',
      intelVersion,
      placesVersion,
      inputFingerprint: '',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
      placesNotReady: { reason: 'places_stale', detail: `places 当前不可消费（${placesState.status}/${placesState.staleReason ?? 'unavailable'}）：不复活旧数据` },
    }
  }
  const placesArtifact = readableArtifact(placesState)
  if (placesArtifact === undefined) {
    return {
      planId,
      status: 'places_not_ready',
      intelVersion,
      placesVersion,
      inputFingerprint: '',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
      placesNotReady: { reason: 'places_not_ready', detail: '缺少 places.json：请先 travel_resolve_places 完成地理解析' },
    }
  }
  if (args.expectedPlacesVersion !== undefined && args.expectedPlacesVersion !== placesVersion) {
    return {
      planId,
      status: 'places_stale',
      intelVersion,
      placesVersion,
      inputFingerprint: '',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
      placesNotReady: { reason: 'places_stale', detail: `places 版本过期（expected=${args.expectedPlacesVersion}，current=${placesVersion}）：请基于当前解析重算覆盖` },
    }
  }
  if (args.expectedIntelVersion !== undefined && args.expectedIntelVersion !== intelVersion) {
    return {
      planId,
      status: 'intel_stale',
      intelVersion,
      placesVersion,
      inputFingerprint: '',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
      placesNotReady: { reason: 'intel_stale', detail: `intel 证据版本过期（expected=${args.expectedIntelVersion}，current=${intelVersion}）` },
    }
  }

  const candidates = placesArtifact.candidates ?? []
  const places = placesArtifact.places ?? []
  const selectedSequence = placesArtifact.selectedSequence ?? []
  const intelState = await store.readArtifactWithState<IntelItem[]>(planId, 'intel.json')
  const intelData = readableArtifact(intelState)
  if (!Array.isArray(intelData)) {
    return {
      planId,
      status: 'intel_stale',
      intelVersion,
      placesVersion,
      inputFingerprint: '',
      regions: [],
      lineage: { regionHints: [], discoveredCandidates: [], selectedSequence: [] },
      placesNotReady: { reason: 'intel_stale', detail: `intel.json 当前不可消费（${intelState.status}/${intelState.staleReason ?? 'unavailable'}）` },
    }
  }
  const intelItems = intelData
  const intelById = new Map(intelItems.map((i) => [i.id, i]))

  // ── 有效研究区域：显式 regionHints ∪ 候选 regionHint（fallback 候选名）──
  const regionNames: string[] = []
  const regionNameSet = new Set<string>()
  const addRegion = (name: string) => {
    const n = name.trim()
    if (n === '' || regionNameSet.has(n)) return
    regionNameSet.add(n)
    regionNames.push(n)
  }
  for (const h of args.regionHints ?? []) addRegion(h)
  // 确定性：先按候选顺序收集 regionHint，再补无 regionHint 候选的 fallback
  const candidateRegion = new Map<string, string>()
  for (const c of candidates) {
    const name = (c.regionHint?.trim() || c.name.trim())
    candidateRegion.set(c.candidateId, name)
  }
  for (const c of candidates) addRegion(candidateRegion.get(c.candidateId) ?? c.name)
  if (regionNames.length === 0) {
    // 无任何区域线索 → 以选中序列涉及地点名派生（避免空 artifact）
    for (const seq of selectedSequence) addRegion(candidateRegion.get(seq) ?? seq)
  }
  if (regionNames.length > COVERAGE_REGION_MAX) {
    throw new TravelValidationError([`区域数 ${regionNames.length} 超过上限 ${COVERAGE_REGION_MAX}`])
  }

  // ── 区域归并（地点/候选/情报；intel 仅经候选 intelRefs 显式归属）──
  const regions: RegionInput[] = regionNames.map((name) => ({
    name,
    candidates: [],
    places: [],
    qualified: new Map(),
    raw: new Map(),
  }))
  const regionByIndex = new Map(regionNames.map((n, i) => [n, i]))
  const placeRegionIndex = (p: ResolvedPlace): number | undefined => {
    const name = candidateRegion.get(p.candidateId) ?? p.name.trim()
    const idx = regionByIndex.get(name)
    if (idx === undefined) {
      // 未在区域集的地名 → 动态补区（选中序列里的新区域）
      const i = regionNames.length
      addRegion(name)
      regions.push({ name, candidates: [], places: [], qualified: new Map(), raw: new Map() })
      regionByIndex.set(name, i)
      return i
    }
    return idx
  }

  for (const p of places) {
    const idx = placeRegionIndex(p)
    if (idx !== undefined) regions[idx].places.push(p)
  }
  for (const c of candidates) {
    const idx = regionByIndex.get(candidateRegion.get(c.candidateId) ?? c.name.trim())
    if (idx === undefined) continue
    regions[idx].candidates.push({ candidateId: c.candidateId, intelRefs: c.intelRefs })
    for (const ref of c.intelRefs ?? []) {
      const item = intelById.get(ref)
      if (item === undefined) continue
      const cat = item.category
      const rawList = regions[idx].raw.get(cat) ?? []
      if (!rawList.some((i) => i.id === item.id)) rawList.push(item)
      regions[idx].raw.set(cat, rawList)
      if (isQualified(item)) {
        const qList = regions[idx].qualified.get(cat) ?? []
        if (!qList.some((i) => i.id === item.id)) qList.push(item)
        regions[idx].qualified.set(cat, qList)
      }
    }
  }

  // ── 分类 ──
  const coverageRegions: CoverageRegion[] = regions.map((r) => {
    const cls = classifyRegion(r)
    return {
      name: r.name,
      status: cls.status,
      intelRefs: cls.intelRefs,
      categoryCounts: cls.categoryCounts,
      coordsCount: cls.coordsCount,
      missingCategories: cls.missingCategories,
      reasonCodes: cls.reasonCodes,
    }
  })

  const lineage: RouteCoverageArtifact['lineage'] = {
    regionHints: [...(args.regionHints ?? [])],
    discoveredCandidates: candidates
      .filter((c) => (c.intelRefs?.length ?? 0) > 0)
      .map((c) => c.candidateId),
    selectedSequence: [...selectedSequence],
  }
  const inputFingerprint = computeInputFingerprint(regionNames, intelVersion, placesVersion)

  const now = new Date().toISOString()
  const unknownWarnings: string[] = []
  if (isUnaccounted(placesState)) {
    unknownWarnings.push(`places.json 未入账（${placesState.status}/${placesState.staleReason ?? 'unknown'}），覆盖计算仅只读兼容消费`)
  }
  if (isUnaccounted(intelState)) {
    unknownWarnings.push(`intel.json 未入账（${intelState.status}/${intelState.staleReason ?? 'unknown'}），覆盖计算仅只读兼容消费`)
  }
  const artifact: RouteCoverageArtifact = {
    schemaVersion: 1,
    intelVersion,
    placesVersion,
    inputFingerprint,
    generatedAt: now,
    regions: coverageRegions,
    lineage,
  }

  // 旧工件是否已被取代（旧版本显示 stale）
  let replacedStale = false
  const prior = await store.readArtifactWithState<RouteCoverageArtifact>(planId, 'route-coverage.json')
  if (prior.found) {
    const staleByStore = prior.status === 'stale'
    const staleByVersion = (prior.data !== undefined)
      && (prior.data.intelVersion < intelVersion || prior.data.placesVersion < placesVersion)
    replacedStale = staleByStore || staleByVersion
  }

  const files: Array<{ name: string; data: unknown }> = [{ name: 'route-coverage.json', data: artifact }]
  // Account legacy upstream snapshots on the first publication only. Once a
  // modern manifest exists, an unaccounted file remains unknown and is not
  // adopted by this read-only coverage stage.
  if (await store.readArtifactManifest(planId) === undefined) {
    for (const name of ['intel.json', 'places.json', 'research-state.json'] as const) {
      const data = await store.readJson<unknown>(planId, name)
      if (data !== undefined) files.push({ name, data })
    }
  }
  await store.publishArtifacts(planId, {
    stage: 'coverage',
    files,
    expectedVersions: { intel: intelVersion, places: placesVersion },
    bump: [],
    inputFingerprint,
  })
  for (const reason of unknownWarnings) {
    await store.recordDegraded(planId, {
      source: 'route-coverage', code: 'UNAVAILABLE', reason, at: now,
    })
  }

  return {
    planId,
    status: 'ready',
    intelVersion,
    placesVersion,
    inputFingerprint,
    regions: coverageRegions,
    lineage,
    ...(replacedStale ? { replacedStale } : {}),
  }
}

/**
 * 旧版本显示判定：已发布 route-coverage 的 intelVersion/placesVersion 落后于当前
 * 版本账本，或内容 hash 失配/失败/空发布 → true。unknown 与 legacy 未入账
 * (`not_in_commit`) 保持未入账语义，不把它误报为 stale 或 current；缺失同样 → false。
 */
export async function computeRouteCoverageStale(store: TravelStore, planId: string): Promise<boolean> {
  const prior = await store.readArtifactWithState<RouteCoverageArtifact>(planId, 'route-coverage.json')
  if (!prior.found || prior.data === undefined) return false
  if (prior.status === 'failed' || prior.status === 'empty'
    || (prior.status === 'stale' && prior.staleReason === 'hash_mismatch')) return true
  // Legacy manifests report an unaccounted file as stale/not_in_commit. It is
  // equivalent to modern unknown for this display flag: readable, unaccounted,
  // and not evidence that the old coverage is stale or current.
  if (prior.status === 'unknown' || (prior.status === 'stale' && prior.staleReason === 'not_in_commit')) return false
  const intelVersion = await currentIntelVersion(store, planId)
  const placesVersion = await store.currentVersion(planId, 'places')
  return prior.data.intelVersion < intelVersion || prior.data.placesVersion < placesVersion
}

// ────────────────────────── 工具定义（W4 T17 单一集成者在 index.ts 注册） ──────────────────────────

const COVERAGE_PARAMETERS = {
  planId: { type: 'string', required: true, description: '计划 ID' },
  regionHints: { type: 'array', items: { type: 'string' }, description: '显式研究区域名（有效区=regionHints∪情报发现地点∪选中序列派生）' },
  expectedPlacesVersion: { type: 'integer', description: '调用方所依据 places 版本（过期 → places_stale 零网络）' },
  expectedIntelVersion: { type: 'integer', description: '调用方所依据 intel 版本（过期 → intel_stale 零网络）' },
} as const
type CoverageParams = InferArgs<typeof COVERAGE_PARAMETERS>

const COVERAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    intelVersion: { type: 'integer', required: true },
    placesVersion: { type: 'integer', required: true },
    inputFingerprint: { type: 'string', required: true },
    regions: { type: 'json', required: true },
    lineage: { type: 'json', required: true },
    replacedStale: { type: 'boolean' },
    placesNotReady: { type: 'json' },
  },
} as const
type CoverageOutput = InferValue<typeof COVERAGE_OUTPUT_SCHEMA>

type OutputRegion = { name: string; status: string; missingCategories?: string[]; reasonCodes?: string[] }
type OutputNotReady = { reason: string; detail?: string }

function render(_args: CoverageParams, value: CoverageOutput): ContentBlock[] {
  const regions = (value.regions as unknown as OutputRegion[]) ?? []
  const notReady = value.placesNotReady as unknown as OutputNotReady | undefined
  if (notReady !== undefined) {
    return textCard(`**travel_route_coverage** · 未就绪（zero network）\n${cardLines([
      ['reason', notReady.reason],
      ['detail', notReady.detail ?? ''],
    ])}`)
  }
  const lines: [string, string][] = [
    ['intelVersion', String(value.intelVersion)],
    ['placesVersion', String(value.placesVersion)],
    ['inputFingerprint', value.inputFingerprint.slice(0, 16)],
    ['区域', `${regions.length} 个`],
  ]
  for (const r of regions) {
    lines.push([r.name, `${r.status}${r.missingCategories?.length ? ` ·缺 ${r.missingCategories.join('/')}` : ''}${r.reasonCodes?.length ? ` ·${r.reasonCodes.join('/')}` : ''}`])
  }
  if (value.replacedStale === true) lines.push(['superseded', '取代了过期旧工件（旧版本显示 stale）'])
  return textCard(`**travel_route_coverage** · 路线覆盖与 lineage\n${cardLines(lines)}`)
}

/** 工具定义工厂（W4 T17 由单一集成者在 index.ts 注册）。 */
export function createTravelRouteCoverageTool(store: TravelStore): ToolDefinition {
  return defineTool({
    name: 'travel_route_coverage',
    description: `路线覆盖与 lineage（W2 T10）：有效研究区域从明确 regionHints、情报发现地点及选中序列派生（不依赖旧 route.waypoints）；记录 intelVersion/placesVersion/inputFingerprint/generatedAt；每区域 status(covered|partial|missing)/intelRefs/categoryCounts/coordsCount/missingCategories/reasonCodes（no_results|filtered_quality|unresolved_geo|…）；covered=attraction/lodging 均 ≥1 条合格情报且 attraction 有独立互证可信坐标（OSM 坐标+OSM 查询不计互证）；多主题游记不因摘要含城市名整体绑定单城；旧版本文件显示 stale；只读 intel/places，不反向触发。`,
    parameters: COVERAGE_PARAMETERS,
    output: { schema: COVERAGE_OUTPUT_SCHEMA, render },
    timeoutMs: 30_000,
    async execute(args) {
      const result = await runRouteCoverage({
        planId: args.planId,
        regionHints: args.regionHints,
        expectedPlacesVersion: args.expectedPlacesVersion,
        expectedIntelVersion: args.expectedIntelVersion,
      }, store)
      return losslessJson(projectCoverage(result))
    },
  })
}

function projectCoverage(o: RouteCoverageResult): CoverageOutput {
  return {
    planId: o.planId,
    status: o.status,
    intelVersion: o.intelVersion,
    placesVersion: o.placesVersion,
    inputFingerprint: o.inputFingerprint,
    regions: JSON.parse(JSON.stringify(o.regions)) as CoverageOutput['regions'],
    lineage: JSON.parse(JSON.stringify(o.lineage)) as CoverageOutput['lineage'],
    ...(o.replacedStale === true ? { replacedStale: true } : {}),
    ...(o.placesNotReady !== undefined
      ? { placesNotReady: JSON.parse(JSON.stringify(o.placesNotReady)) as CoverageOutput['placesNotReady'] } : {}),
  }
}
