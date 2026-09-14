/**
 * W2 T9 travel_resolve_places —— 候选校验与多源地理解析（草稿 B）。
 *
 * - 模型/调用方读当前 intel 后提出候选，工具校验候选出处与上游版本，绝不允许
 *   模型「无证据直接提交坐标」绕过解析（候选自带 coords 字段 → 拒绝）。
 * - 解析优先级：优先复用 intel 条目已验证坐标 → amap geocode → tencent poiSearch
 *   → 可选 OSM（默认 off，经 optionalSourceEnabled）。渠道经可注入 resolver 链
 *   （零真实网络测试 fixture）；不同坐标系保留原 sys，转换仅发生在渠道边界。
 * - 可靠唯一且地域一致的匹配自动采用；同名/地域冲突/低置信/必去点无法定位 →
 *   询问（每轮 ≤3，先必去点与关键冲突；disambiguationAnswers 回填）。
 * - 网络失败/缺 Key → degraded + excludeReason，绝不「要求用户确认猜测坐标」。
 * - 住宿/区域中心仅可做「至区域参考点」估算并标记 areaReferenceEstimate，
 *   市区中心不当景区入口；入口城市/origin 独立解析，不回写覆盖用户原主题。
 * - 非交易 resolve 不依赖 itinerary/transport（零循环）。
 *
 * resolve 门（草稿 58 / F 节）：intel 版本过期或 assessment 非当前有效 sufficient
 * → research_not_ready 零网络（接 W1 computeResearchStatus）。
 */
import { createHash } from 'node:crypto'
import { defineTool, type InferArgs, type InferValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { KeyResolutionEnv } from '../adapters/base.js'
import { TravelStore, type ArtifactReadState } from '../store/store.js'
import { TravelValidationError } from '../errors.js'
import { computeResearchStatus } from './research-assessment.js'
import { cardLines, losslessJson, textCard } from './common.js'
import type {
  GeoCoords, IntelItem, PlacesArtifact, ResolveCandidate, ResolveClarification,
  ResolveConfidence, ResolvedPlace, ResolveKind, PointKind, ResearchState,
} from '../models/types.js'

/** 候选上限（草稿 B：60）与选中序列上限（草稿 B：30）。 */
export const RESOLVE_CANDIDATES_MAX = 60
export const RESOLVE_SELECTION_MAX = 30
/** 每轮待澄清问题上限（草稿 B：每轮 ≤3）。 */
export const RESOLVE_CLARIFICATION_MAX = 3

/** geocoder 单匹配（渠道解析产出或 intel 复用）。 */
export interface GeocoderMatch {
  coords: GeoCoords
  confidence: ResolveConfidence
  district?: string
  /** 渠道明确回报的入口点位（仅当真有入口时才为 entrance，不硬设）。 */
  pointKind?: PointKind
  /** 是否仅为区域/市区中心参考点（住宿/区域候选默认如此）。 */
  areaReference?: boolean
}

/** 可注入 geocoder provider（fixture mock amap/tencent/OSM；零真实网络）。 */
export interface GeocoderProvider {
  name: string
  /** 渠道可用性（缺 Key → false，走 disabled 而非猜测）。 */
  available(env: KeyResolutionEnv): boolean | Promise<boolean>
  /** 返回可能多个匹配（同名/地域冲突 → 询问非自动采用）；undefined/空 = 无结果。 */
  geocode(candidate: ResolveCandidate, env: KeyResolutionEnv): Promise<GeocoderMatch[] | undefined> | GeocoderMatch[] | undefined
}

/** 工具依赖（可注入 resolver 链 + env）。 */
export interface ResolveDeps {
  resolvers: GeocoderProvider[]
  env: KeyResolutionEnv
  /** 单次解析开始回调（P0-A R6：每次工具调用重置 planId 预算/计数语义，与 fan-out 对齐）。 */
  resetPlanBudget?: () => void
}

/** travel_resolve_places 输入。 */
export interface ResolvePlacesArgs {
  planId: string
  /** 调用方所依据 intel 版本（过期 → research_not_ready 零网络）。 */
  expectedIntelVersion?: number
  candidates: ResolveCandidate[]
  /** 选中候选 id 序列（≤30；可重复表达闭环/重访，禁止相邻重复零长度边）。 */
  selectionOrder: string[]
  /** 入口点候选 id。 */
  entryCandidateId?: string
  /** 住宿安排（placeId + 入住条件；供优先解析住宿候选，缺省忽略）。 */
  lodgingStays?: Array<{ candidateId: string; checkIn?: string; checkOut?: string }>
  /** 澄清回答：{clarificationId: {candidateId, answer, regionHint?}}。 */
  disambiguationAnswers?: Record<string, { candidateId: string; answer: string; regionHint?: string }>
}

/** travel_resolve_places 返回。 */
export interface ResolvePlacesResult {
  planId: string
  status: PlacesArtifact['status']
  intelVersion: number
  inputFingerprint: string
  places: ResolvedPlace[]
  selectedSequence: string[]
  pendingClarifications: ResolveClarification[]
  entryPlaceId?: string
  /** 缺省为 computeResearchStatus 的 research 门回执（零网络）。 */
  researchNotReady?: { reason: 'research_not_ready'; missing?: string; detail?: string }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 稳定 placeId：kind:name:region 规范化派生（多次解析不变）。 */
function placeIdOf(candidate: ResolveCandidate): string {
  const seed = `${candidate.kind}:${candidate.name.trim()}:${candidate.regionHint?.trim() ?? ''}`
  return `place-${sha256(seed).slice(0, 16)}`
}

function hasProvenance(candidate: ResolveCandidate): boolean {
  const refs = candidate.intelRefs?.filter((r) => r.trim() !== '')
  return (refs !== undefined && refs.length > 0) || (candidate.userRef?.trim() ?? '') !== ''
}

/** 点位种类（草稿 B）：住宿/区域中心仅做参考点估算；市区中心不当景区入口。 */
function pointKindFor(kind: ResolveKind, match: GeocoderMatch | undefined): PointKind {
  if (kind === 'hub') return 'hub'
  if (kind === 'lodging' || kind === 'area') return 'areaCenter'
  // attraction
  return match?.pointKind === 'entrance' ? 'entrance' : 'poi'
}

function isAreaKind(kind: ResolveKind): boolean {
  return kind === 'lodging' || kind === 'area'
}

/** 行政区名正常化：去除 省/市/区/县/镇/乡/街道/盟/旗/自治州 等行政区后缀。 */
function normalizeRegion(s: string): string {
  return s.trim().replace(/(省|市|区|县|镇|乡|街道|盟|旗|自治州|地区|自治县)$/, '').trim()
}

/** 省级行政区名（无后缀）。省级是宽泛范围：其下任何地市/区县都属一致。 */
const PROVINCE_NAMES = new Set([
  '北京', '上海', '天津', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建',
  '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州',
  '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
  '香港', '澳门',
])

/** 行政区名分隔符：发现用的组合地域词（`青海/甘肃`、`西宁、敦煌`）按此拆成 token。 */
const REGION_SEPARATORS = /[/、,，;；\s]+/

/** 组合地域词的 token 表（去空、去重、保序）。 */
function regionTokens(regionHint: string | undefined): string[] {
  const raw = (regionHint ?? '').trim()
  if (raw === '') return []
  const out: string[] = []
  for (const part of raw.split(REGION_SEPARATORS)) {
    const token = part.trim()
    if (token !== '' && !out.includes(token)) out.push(token)
  }
  return out
}

/**
 * 交给 geocoder 的**单一**地域 token（2026-09-12 复跑实测缺陷修复）。
 *
 * 实测：`poiSearch('张掖', region='青海/甘肃')` → 0 条；`region='甘肃'` → 3 条带正确
 * district 的真实 POI。即「组合地域词」被原样当作渠道 region 参数时会让整条渠道检索失败。
 * 此处只取**首个** token 作提示性 region（无 token → undefined 让渠道自行召回）。
 * 首个 token 未必是正确省份也没关系：地域正确性由 regionConsistent 三态复核裁决，
 * 这里只是让渠道的召回面不被污染。
 */
export function primaryRegionForGeocoder(regionHint: string | undefined): string | undefined {
  return regionTokens(regionHint)[0]
}

/**
 * 「可靠唯一且地域一致」判定（C2；fix-f1e D 收紧省名分支；2026-09-12 复跑修复三态化）。
 *
 * 返回**三态**而非布尔——「冲突」与「无法验证」必须分开处理：
 * - `'consistent'`：可证明地域一致（或本无地域约束）→ 自动采用。
 * - `'conflict'`：可证明地域冲突（如 hint 甘肃省、district 四川成都市）→ 澄清，绝不采用。
 * - `'unverified'`：证据不足以证明一致**也不足以证明冲突**（源未回报行政区、或行政区
 *   层级比 hint 细到看不出归属）→ 采用但降档为 medium + degraded 标注。
 *
 * 三态化的动因（复跑实测 N-REPLAY-1）：`regionHint` 是**发现用的粗粒度词**
 * （用户给 `青海/甘肃`），旧实现把它与**细粒度行政区值**做字面比较，
 * 「青海省海西蒙古族藏族自治州乌兰县」永远不可能等于「青海/甘肃」→ 必然判「不一致」
 * → 产出**无法回答的澄清**（选项就是 hint 回显）→ resolve 首轮即 needs_clarification
 * → advice 地点业务门剔除全部地点（与 2026-09-09 N-1 13 轮不收敛同源）。
 *
 * 规则：
 * - 无 hint / hint 无有效 token → `'consistent'`（无约束）。
 * - 组合 hint 的**任一** token 与 district 一致 → `'consistent'`（多地区任一命中即满足）。
 * - district 缺省 → `'unverified'`（旧为 false=澄清）。
 * - 省级 token：district **原文**含该省名即一致（先剥后缀再比会误杀
 *   「甘肃省酒泉市敦煌市」——`normalizeRegion` 只剥末位后缀）；hint 含省级 token
 *   但 district 自证属**别的**省 → `'conflict'`；district 未自证 → `'unverified'`。
 * - 非省级 token 与 district 双向包含比较；无重叠 → `'conflict'`（真同名异地等）。
 */
export type RegionVerdict = 'consistent' | 'conflict' | 'unverified'

function regionConsistent(regionHint: string | undefined, district: string | undefined): RegionVerdict {
  const tokens = regionTokens(regionHint)
  if (tokens.length === 0) return 'consistent'
  if (district === undefined || district.trim() === '') return 'unverified'
  const rawDistrict = district.trim()
  const d = normalizeRegion(rawDistrict)
  if (d === '') return 'unverified'
  const districtProvince = PROVINCE_NAMES.has(d) ? d : undefined

  // 1) 省级 token：district **原文**自证省辖即一致（顺序敏感，必须先于后缀剥离比较：
  //    normalizeRegion 只剥末位后缀，「甘肃省酒泉市敦煌市」→「甘肃省酒泉市敦煌」不含「甘肃」）
  const hintProvinces = tokens.filter((t) => PROVINCE_NAMES.has(normalizeRegion(t)))
  for (const province of hintProvinces) {
    if (rawDistrict.includes(province)) return 'consistent'
  }
  if (districtProvince !== undefined) {
    // district 自身是省名：hint 含同名省级 token 才一致（已在上面命中），否则可证明冲突
    return 'conflict'
  }

  // 2) 非省级 token 双向包含
  for (const token of tokens) {
    const t = normalizeRegion(token)
    if (t === '' || PROVINCE_NAMES.has(t)) continue
    if (t.includes(d) || d.includes(t)) return 'consistent'
  }

  // 3) 其余 → 可证明冲突（如省级 hint「青海」+ 异省城市 district「成都市」）。
  //    注意：此处**不**采用"证据不足即放行"的宽松分支——放行会静默采用异省坐标，
  //    抵消既有的"宁澄清勿错放"防线（本轮实现过程中曾被 3 条既有测试拦下，已纠正）。
  //    真正要消灭的不可回答澄清只发生在 district **完全缺失**（上面 :195 的 unverified
  //    分支）：那时问题文案只有「未回报行政区」+ 选项=regionHint 回显，用户无从回答。
  return 'conflict'
}

/** 历年 intel 坐标复用：候选 intelRefs 命中带坐标条目 → 最高优先。 */
function reuseVerifiedCoords(candidate: ResolveCandidate, intel: Map<string, IntelItem>): GeocoderMatch | undefined {
  for (const ref of candidate.intelRefs ?? []) {
    const item = intel.get(ref)
    if (item?.coords !== undefined) {
      return { coords: item.coords, confidence: 'high', pointKind: 'poi' }
    }
  }
  return undefined
}

/** 单个候选解析：返回该次解析的 ResolvedPlace 或未解析（exclude）。
 *
 * 解析器链上的 provider 可选匹配，因此无法把一个"第二遍 re-resolve"直接改写为
 * 精确选中多匹配的解决方案。故以 `scopePicker`（由澄清回答派生的 picker）在
 * provider 自己的 matches 集内选中目标，单遍收敛（P0-A R3：district/coords 精确命中）。
 */
async function resolveCandidate(
  candidate: ResolveCandidate,
  deps: ResolveDeps,
  intel: Map<string, IntelItem>,
  scopePicker?: (matches: GeocoderMatch[]) => GeocoderMatch | undefined,
): Promise<{ place: ResolvedPlace; clarification?: ResolveClarification }> {
  const base: ResolvedPlace = {
    placeId: placeIdOf(candidate),
    candidateId: candidate.candidateId,
    name: candidate.name.trim(),
    kind: candidate.kind,
    pointKind: pointKindFor(candidate.kind, undefined),
    source: '',
    coordinate_source: 'unresolved',
    resolveConfidence: 'low',
    selectionReason: candidate.selectionReason,
  }

  // ① 优先复用已有经验证坐标（最高优先，零网络）
  const verified = reuseVerifiedCoords(candidate, intel)
  if (verified !== undefined) {
    return {
      place: {
        ...base,
        pointKind: pointKindFor(candidate.kind, verified),
        coords: verified.coords,
        source: 'intel',
        coordinate_source: 'intel',
        resolveConfidence: 'high',
        district: verified.district,
      },
    }
  }

  // ② 渠道链解析（amap → tencent → osm）
  const tried: string[] = []
  // 地域判定非 consistent 的单匹配兜底（全渠道后按 verdict 分流：conflict 优先澄清；
  // 仅当从未出现过可证明冲突时，unverified 才采用但降档 medium + 标注）
  let regionUnverified: (GeocoderMatch & { regionVerdict: Exclude<RegionVerdict, 'consistent'> }) | undefined
  let regionConflict: (GeocoderMatch & { regionVerdict: 'conflict' }) | undefined
  for (const provider of deps.resolvers) {
    const providerOk = await provider.available(deps.env)
    if (!providerOk) {
      tried.push(provider.name)
      continue
    }
    const matches = await provider.geocode(candidate, deps.env)
    if (matches === undefined || matches.length === 0) {
      tried.push(provider.name)
      continue
    }
    // 低置信 → 待澄清（不宣称 ready）；place 同步写 pendingClarification（fix-f1f #4a：
    // 顶层 pendingClarifications 与 place 字段契约一致，advice 天气门据此拒澄清候选）
    if (matches[0].confidence === 'low') {
      const q: ResolveClarification = {
        clarificationId: `clar-${placeIdOf(candidate).slice(7)}-conf`,
        candidateId: candidate.candidateId,
        kind: 'confidence',
        question: `「${candidate.name}」仅低置信匹配，请确认具体地点（区域/别名/入口）`,
        options: matches.map((m) => m.district ?? `${m.coords.lng},${m.coords.lat}`),
      }
      return {
        place: {
          ...base,
          pointKind: pointKindFor(candidate.kind, matches[0]),
          coords: matches[0].coords,
          source: provider.name,
          coordinate_source: provider.name as ResolvedPlace['coordinate_source'],
          resolveConfidence: 'low',
          district: matches[0].district,
          pendingClarification: q.question,
        },
        clarification: q,
      }
    }
    // 多匹配（同名/地域冲突/多子 POI）→ 询问，不自动采用。
    // P0-A R3：若澄清回答精确命中其中某一匹配（district 或坐标串）→ 单遍直接采用，
    // 不再把 answer 当搜索词重查（收敛 13 轮不澄清）。
    if (matches.length > 1) {
      const picked = scopePicker?.(matches)
      if (picked !== undefined) {
        const isArea = isAreaKind(candidate.kind)
        return {
          place: {
            ...base,
            pointKind: pointKindFor(candidate.kind, picked),
            coords: picked.coords,
            source: provider.name,
            coordinate_source: provider.name as ResolvedPlace['coordinate_source'],
            resolveConfidence: picked.confidence === 'low' ? 'low' : 'high',
            ...(picked.district !== undefined ? { district: picked.district } : {}),
            ...(isArea ? { areaReferenceEstimate: true } : {}),
          },
        }
      }
      const q: ResolveClarification = {
        clarificationId: `clar-${placeIdOf(candidate).slice(7)}-scope`,
        candidateId: candidate.candidateId,
        kind: 'scope',
        question: `「${candidate.name}」解析到多个区域（${matches.map((m) => m.district ?? '？').join(' / ')}），请选择实际所属`,
        options: matches.map((m) => m.district ?? `${m.coords.lng},${m.coords.lat}`),
      }
      return {
        place: {
          ...base,
          pointKind: pointKindFor(candidate.kind, matches[0]),
          coords: matches[0].coords,
          source: provider.name,
          coordinate_source: provider.name as ResolvedPlace['coordinate_source'],
          resolveConfidence: 'low',
          district: matches[0].district,
          pendingClarification: q.question,
        },
        clarification: q,
      }
    }
    // 单匹配 → 需「可靠唯一且地域一致」方可自动采用，否则按三态分别兜底：
    // - `conflict`（可证明不一致，如省级 hint「青海」+ 异省 city「成都市」）→ 记入
    //   regionConflict，继续下一条渠道（可能由能回报行政区且一致的源救回）；
    // - `unverified`（源未回报行政区）→ 记入 regionUnverified 兜底，继续下一条渠道；
    // - 全渠道走完按「冲突优先」分流（见 ③）——一旦出现过可证明冲突，绝不再采用
    //   后续"不可验证"的匹配（宁澄清勿错放）。
    const verdict = matches.length === 1 ? regionConsistent(candidate.regionHint, matches[0].district) : 'consistent'
    if (matches.length === 1 && verdict !== 'consistent') {
      // 单匹配地域冲突/不可验证也可由澄清回答精确确认。消费 scopePicker 后
      // 原位采用唯一匹配，保持候选 name/placeId 身份，不把 answer 当别名重查。
      const picked = scopePicker?.(matches)
      if (picked !== undefined) {
        const isArea = isAreaKind(candidate.kind)
        return {
          place: {
            ...base,
            pointKind: pointKindFor(candidate.kind, picked),
            coords: picked.coords,
            source: provider.name,
            coordinate_source: provider.name as ResolvedPlace['coordinate_source'],
            resolveConfidence: picked.confidence,
            ...(picked.district !== undefined ? { district: picked.district } : {}),
            regionVerification: 'verified',
            ...(isArea ? { areaReferenceEstimate: true } : {}),
          },
        }
      }
      if (verdict === 'conflict') regionConflict = { ...matches[0], regionVerdict: verdict }
      else regionUnverified = { ...matches[0], regionVerdict: verdict }
      tried.push(provider.name)
      continue
    }
    // 单一唯一且地域一致的匹配 → 自动采用（按渠道声明的置信度落档；渠道单点不唯一 →
    // 自身应给 medium，而非冒充 high。见 createAmapResolver/createTencentResolver 唯一性裁定）
    const m = matches[0]
    const isArea = isAreaKind(candidate.kind)
    return {
      place: {
        ...base,
        pointKind: isArea ? 'areaCenter' : (m.pointKind === 'entrance' ? 'entrance' : 'poi'),
        coords: m.coords,
        source: provider.name,
        coordinate_source: provider.name as ResolvedPlace['coordinate_source'],
        resolveConfidence: m.confidence,
        district: m.district,
        ...(regionTokens(candidate.regionHint).length > 0 ? { regionVerification: 'verified' as const } : {}),
        ...(isArea ? { areaReferenceEstimate: true } : {}),
      },
    }
  }

  // ③ 全渠道都未给出地域一致的唯一匹配，但有兜底单匹配 —— 按「冲突优先」分流：
  //    只要**曾**出现可证明冲突（regionConflict），一律澄清，绝不采用后续"不可验证"匹配
  //    （宁澄清勿错放；选项是真实冲突行政区，用户可回答）。
  //    仅当从未出现可证明冲突、只是"源未回报行政区"（regionUnverified）时，才**采用**该
  //    匹配并降档 medium + regionVerificationNote 标注——消灭"选项=hint 回显"的
  //    无法回答澄清（2026-09-12 N-REPLAY-1 修复）。
  const fallback = regionConflict ?? regionUnverified
  if (fallback !== undefined) {
    const d = fallback.district
    if (fallback.regionVerdict === 'unverified') {
      const note = `地域无法验证：${'源未回报行政区'}，与候选地域「${candidate.regionHint ?? '（无）'}」`
        + '无法比对归属；已采用该唯一匹配但降档 medium（不再产出无法回答的澄清）'
      return {
        place: {
          ...base,
          pointKind: pointKindFor(candidate.kind, fallback),
          coords: fallback.coords,
          source: 'candidate',
          coordinate_source: 'candidate' as ResolvedPlace['coordinate_source'],
          resolveConfidence: 'medium',
          district: d,
          regionVerification: 'unverified',
          regionVerificationNote: note,
        },
      }
    }
    const q: ResolveClarification = {
      clarificationId: `clar-${placeIdOf(candidate).slice(7)}-region`,
      candidateId: candidate.candidateId,
      kind: 'scope',
      question: `「${candidate.name}」的解析地域（${d ?? '未回报行政区'}）与候选地域（${candidate.regionHint}）不一致，请确认实际所属`,
      options: d !== undefined ? [d] : [candidate.regionHint ?? ''],
    }
    return {
      place: {
        ...base,
        pointKind: pointKindFor(candidate.kind, fallback),
        coords: fallback.coords,
        source: 'candidate',
        coordinate_source: 'candidate' as ResolvedPlace['coordinate_source'],
        resolveConfidence: 'low',
        district: d,
        regionVerification: 'conflict',
        pendingClarification: q.question,
      },
      clarification: q,
    }
  }

  // ④ 全渠道不可用（缺 Key）或全源无结果 → degraded，不猜坐标
  const allDisabled = tried.length === deps.resolvers.length && deps.resolvers.length > 0
  const q: ResolveClarification = {
    clarificationId: `clar-${placeIdOf(candidate).slice(7)}-unres`,
    candidateId: candidate.candidateId,
    kind: 'unresolved',
    question: `必去点「${candidate.name}」无法定位（${allDisabled ? '渠道不可用' : '无结果'}），请补充具体地点/坐标线索`,
  }
  return {
    place: {
      ...base,
      source: allDisabled ? 'disabled' : 'unresolved',
      coordinate_source: allDisabled ? 'disabled' : 'unresolved',
      excludeReason: allDisabled
        ? '解析渠道未启用/缺 Key（degraded）：不提供猜测坐标'
        : '全部解析源无结果（unresolved_geo）：无法定位该候选',
      // fix-f1f #4a：excludeReason（blocked/degraded）与 pendingClarification（待澄清）
      // 为两个独立门并存——该候选已排除且仍需用户补充线索（互不覆盖）
      pendingClarification: q.question,
    },
    clarification: q,
  }
}

/** unknown/未入账是可读但未入账；失败/空结果/hash 失配仍禁止消费。 */
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
  return readableArtifact(state)?.researchVersion ?? 0
}

function computeInputFingerprint(
  candidates: ResolveCandidate[], selectedSequence: string[],
  entryCandidateId: string | undefined, answers: Record<string, unknown> | undefined,
): string {
  const payload = JSON.stringify({
    candidates: candidates.map((c) => ({
      candidateId: c.candidateId, name: c.name, kind: c.kind,
      intelRefs: c.intelRefs, userRef: c.userRef, regionHint: c.regionHint,
    })),
    selectedSequence,
    entryCandidateId,
    answers,
  })
  return sha256(payload).slice(0, 24)
}

export async function runResolvePlaces(
  args: ResolvePlacesArgs,
  store: TravelStore,
  deps: ResolveDeps,
): Promise<ResolvePlacesResult> {
  // 计划级在途锁（C 期接线 F4-C5）：places.json/versions 写路径串行化。
  return store.withPlanLock(args.planId, () => runResolvePlacesUnlocked(args, store, deps))
}

async function runResolvePlacesUnlocked(
  args: ResolvePlacesArgs,
  store: TravelStore,
  deps: ResolveDeps,
): Promise<ResolvePlacesResult> {
  const planId = args.planId
  const request = await store.loadRequest(planId)
  if (request === undefined) {
    throw new TravelValidationError([`计划 ${planId} 不存在：请先 travel_intake 创建`])
  }

  // ── resolve 门（草稿 58/F）：assessment 非当前有效 sufficient → research_not_ready 零网络 ──
  const researchStatus = await computeResearchStatus(store, planId)
  if (!researchStatus.ready) {
    return {
      planId,
      status: 'needs_clarification',
      intelVersion: researchStatus.currentResearchVersion,
      inputFingerprint: '',
      places: [],
      selectedSequence: [],
      pendingClarifications: [],
      researchNotReady: {
        reason: 'research_not_ready',
        missing: researchStatus.missing,
        detail: researchStatus.detail,
      },
    }
  }
  // intel 版本过期 → research_not_ready 零网络
  const version = await currentIntelVersion(store, planId)
  if (args.expectedIntelVersion !== undefined && args.expectedIntelVersion !== version) {
    return {
      planId,
      status: 'needs_clarification',
      intelVersion: version,
      inputFingerprint: '',
      places: [],
      selectedSequence: [],
      pendingClarifications: [],
      researchNotReady: {
        reason: 'research_not_ready',
        missing: 'stale_version',
        detail: `intel 证据版本过期（expected=${args.expectedIntelVersion}，current=${version}）：请基于当前 intel 重新提出候选`,
      },
    }
  }

  // ── 输入校验 ──
  if (args.candidates.length > RESOLVE_CANDIDATES_MAX) {
    throw new TravelValidationError([`候选数 ${args.candidates.length} 超过上限 ${RESOLVE_CANDIDATES_MAX}`])
  }
  if (args.selectionOrder.length > RESOLVE_SELECTION_MAX) {
    throw new TravelValidationError([`选中序列 ${args.selectionOrder.length} 超过上限 ${RESOLVE_SELECTION_MAX}`])
  }
  for (const c of args.candidates) {
    if (!/^[A-Za-z0-9._:+-]+$/.test(c.candidateId) || c.candidateId.includes('..')) {
      throw new TravelValidationError([`candidateId 非法（仅允许字母/数字/._:+-，禁目录穿越）：${c.candidateId}`])
    }
    if ((c.name ?? '').trim() === '') throw new TravelValidationError([`候选 ${c.candidateId} name 必填`])
    if (!hasProvenance(c)) {
      throw new TravelValidationError([`候选 ${c.candidateId}「${c.name}」无出处：须提供 intelRefs 或 userRef（模型不得无证据提交）`])
    }
    // 模型不得无证据直接提交坐标绕过解析
    const raw = c as unknown as Record<string, unknown>
    if (raw.coords !== undefined) {
      throw new TravelValidationError([`候选 ${c.candidateId}「${c.name}」直接携带坐标：禁止无证据坐标绕过地理解析`])
    }
  }

  // selectionOrder 校验：引用合法 + 相邻重复（零长度边）拒绝
  const ids = new Set(args.candidates.map((c) => c.candidateId))
  for (let i = 0; i < args.selectionOrder.length; i++) {
    const id = args.selectionOrder[i]
    if (!ids.has(id)) {
      throw new TravelValidationError([`选中序列引用未知候选：${id}`])
    }
    if (i > 0 && id === args.selectionOrder[i - 1]) {
      throw new TravelValidationError([`选中序列相邻重复（${id}）→ 零长度边，拒绝`])
    }
  }
  if (args.entryCandidateId !== undefined && !ids.has(args.entryCandidateId)) {
    throw new TravelValidationError([`entryCandidateId 引用未知候选：${args.entryCandidateId}`])
  }

  // 已有 places 快照（resolve 幂等：已解析候选复用，不重复 resolve）。
  // 仅当证据版本未前进（intelVersion == 当前）且候选身份（name/kind/region → placeId）
  // 仍一致时才可复用——候选名/地域约束/上游证据任一变化 → 重新解析，杜绝用旧坐标
  // 答新问题（C2 先验复用门）。
  const priorState = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  const priorIsStageOwnedUnaccounted = priorState.status === 'unknown'
    && priorState.staleReason === 'unaccounted' && priorState.meta?.stage === 'places'
  const priorIsStageOwnedUnverifiable = priorState.status === 'stale'
    && priorState.staleReason === 'not_in_commit' && priorState.meta?.stage === 'places'
  const prior = !priorIsStageOwnedUnaccounted && !priorIsStageOwnedUnverifiable
    ? readableArtifact(priorState) : undefined
  const priorUsable = prior !== undefined && prior.intelVersion === version ? prior : undefined
  const priorByCandidate = new Map((priorUsable?.places ?? []).map((p) => [p.candidateId, p]))

  // 载入 intel 供坐标复用；unknown 是只读兼容，不伪装成 current。
  const intelState = await store.readArtifactWithState<IntelItem[]>(planId, 'intel.json')
  const intelData = readableArtifact(intelState)
  const intelItems = Array.isArray(intelData) ? intelData : []
  const intelMap = new Map(intelItems.map((i) => [i.id, i]))

  const now = new Date().toISOString()
  const unknownWarnings: string[] = []
  if (isUnaccounted(intelState)) {
    unknownWarnings.push(`intel.json 未入账（${intelState.status}/${intelState.staleReason ?? 'unknown'}），本次仅只读兼容复用`)
  }
  if (isUnaccounted(priorState) && prior !== undefined) {
    unknownWarnings.push(`places.json 未入账（${priorState.status}/${priorState.staleReason ?? 'unknown'}），本次仅只读兼容复用先验`)
  }
  const places: ResolvedPlace[] = []
  const pendings: { candidateId: string; q: ResolveClarification }[] = []
  const answers = new Map(Object.entries(args.disambiguationAnswers ?? {}))
  const consumedAnswers = new Set<string>()

  for (const candidate of args.candidates) {
    const priorPlace = priorByCandidate.get(candidate.candidateId)
    // 澄清回答优先消费当前候选身份对应的旧快照。若回答精确命中旧快照已回报的
    // district/coords，说明用户是在确认同一解析结果；原地确认并禁止再次调用 resolver。
    // placeId 身份门仍保留，避免候选名/地域变化时误用旧坐标回答新候选。
    const answer = findAnswer(answers, candidate.candidateId, consumedAnswers)
    if (priorPlace !== undefined
      && priorPlace.placeId === placeIdOf(candidate)
      && answer !== undefined
      && answerMatchesPlace(answer.answer, priorPlace)) {
      places.push({
        ...priorPlace,
        regionVerification: 'verified',
        pendingClarification: undefined,
        regionVerificationNote: undefined,
      })
      continue
    }

    // 幂等：非待澄清候选且已有成功解析 → 复用（不重复 resolve/geocode）。
    // 复用前提 ≥2：①快照与该候选身份一致（placeId=name+kind+region 派生，候选名/地域
    //   约束变化 → placeId 变化 → 不复用）；②证据版本未前进（priorUsable 已过滤）。
    const needsRetry = priorPlace === undefined || priorPlace.excludeReason !== undefined
      || priorPlace.resolveConfidence === 'low'
      || priorPlace.pendingClarification !== undefined
      || priorPlace.placeId !== placeIdOf(candidate)
    if (!needsRetry && priorPlace !== undefined && priorPlace.coords !== undefined && priorPlace.excludeReason === undefined) {
      places.push(priorPlace)
      continue
    }

    // 澄清回答回填该候选（仅解析时重试该候选）
    const picker = answer !== undefined ? scopePickerFor(answer.answer) : undefined
    let resolution = await resolveCandidate(candidate, deps, intelMap, picker)
    // P0-A R4（unresolved 分支）：用户回答为坐标串 → user-provided 直接采用
    // （source=user，标注 user-provided），不把坐标当搜索词/不再重复澄清。
    if (answer !== undefined
      && resolution.clarification !== undefined
      && parseCoordString(answer.answer) !== undefined
      && resolution.place.coords === undefined) {
      const isArea = isAreaKind(candidate.kind)
      const userPlace: ResolvedPlace = {
        ...resolution.place,
        pointKind: pointKindFor(candidate.kind, undefined),
        coords: parseCoordString(answer.answer),
        source: 'user',
        coordinate_source: 'user',
        resolveConfidence: 'low', // 用户手填坐标：诚实标识低置信但已定位
        attribution: 'user-provided',
        excludeReason: undefined,
        ...(isArea ? { areaReferenceEstimate: true } : {}),
      }
      resolution = { place: userPlace }
    } else if (answer !== undefined && resolution.clarification !== undefined && parseCoordString(answer.answer) === undefined) {
      const answerText = answer.answer.trim()
      const isCandidateName = answerText !== '' && answerText === candidate.name.trim()
      const isReportedDistrict = answerText !== '' && answerText === resolution.place.district?.trim()
      if (!isCandidateName && !isReportedDistrict) {
        // 既有别名/区域线索路径：用提供区域/坐标线索重新解析（同候选只此一次；
        // 纯区域名归 regionHint 重查，即使 answer 不含候选名也仅一次、不无限澄清）。
        // 回源仍未命中时恢复候选身份并明确引导重答，不能静默把未知回答写成 name。
        const directed: ResolveCandidate = {
          ...candidate,
          name: answerText !== '' ? answerText : candidate.name,
          regionHint: answer.regionHint ?? candidate.regionHint,
        }
        const directedResolution = await resolveCandidate(directed, deps, intelMap)
        const noAliasMatch = directedResolution.clarification?.kind === 'unresolved'
          && directedResolution.place.coords === undefined
        resolution = noAliasMatch
          ? markUnmatchedAnswer(candidate, answerText, directedResolution)
          : directedResolution
      }
    }
    places.push(resolution.place)
    if (resolution.clarification !== undefined) {
      pendings.push({ candidateId: candidate.candidateId, q: resolution.clarification })
    }
  }

  // 待澄清每轮 ≤3（先必去点/关键冲突 = unresolved 与 scope 优先）
  const ordered = pendings.sort((a, b) => {
    const rank = { unresolved: 0, scope: 1, confidence: 2 } as const
    return rank[a.q.kind] - rank[b.q.kind]
  }).slice(0, RESOLVE_CLARIFICATION_MAX)
  const pendingClarifications = ordered.map((p) => p.q)

  // 状态判定
  const unresolvedCount = places.filter((p) => p.coords === undefined).length
  const hasPending = pendingClarifications.length > 0
  const status: PlacesArtifact['status'] = hasPending
    ? 'needs_clarification'
    : (unresolvedCount > 0 ? 'partial' : 'ready')

  const selectedSequence = [...args.selectionOrder]
  const entryPlace = args.entryCandidateId !== undefined
    ? places.find((p) => p.candidateId === args.entryCandidateId)
    : undefined
  const inputFingerprint = computeInputFingerprint(
    args.candidates, args.selectionOrder, args.entryCandidateId, args.disambiguationAnswers,
  )

  const artifact: PlacesArtifact = {
    schemaVersion: 1,
    intelVersion: version,
    inputFingerprint,
    generatedAt: now,
    candidates: args.candidates,
    places,
    selectedSequence,
    ...(entryPlace !== undefined ? { entryPlaceId: entryPlace.placeId } : {}),
    originResolution: {
      origin: request.slots.origin,
      resolved: entryPlace !== undefined,
      ...(entryPlace?.coords !== undefined ? { coords: entryPlace.coords } : {}),
      ...(entryPlace !== undefined ? { entryKind: entryPlace.kind === 'hub' ? 'city' as const : 'place' as const } : {}),
    },
    pendingClarifications,
    status,
  }

  const files: Array<{ name: string; data: unknown }> = [{ name: 'places.json', data: artifact }]
  // First publication of a legacy plan also accounts its existing evidence
  // snapshots; a modern manifest is never repaired by adopting unknown files.
  if (await store.readArtifactManifest(planId) === undefined) {
    for (const name of ['intel.json', 'research-state.json'] as const) {
      const data = await store.readJson<unknown>(planId, name)
      if (data !== undefined) files.push({ name, data })
    }
  }
  await store.publishArtifacts(planId, {
    stage: 'places',
    files,
    bump: ['places'],
    inputFingerprint,
  })
  for (const reason of unknownWarnings) {
    await store.recordDegraded(planId, {
      source: 'resolve-places', code: 'UNAVAILABLE', reason, at: now,
    })
  }

  return {
    planId,
    status,
    intelVersion: version,
    inputFingerprint,
    places,
    selectedSequence,
    pendingClarifications,
    ...(entryPlace !== undefined ? { entryPlaceId: entryPlace.placeId } : {}),
  }
}

/** 找命中该候选（且未消费过）的澄清回答；每个 clarificationId 只消费一次。
 *
 * P0-A R5 键语义统一：先按候选 candidateId 精确匹配；再从澄清问题回执 key
 * （disambiguationAnswers 键）反查命中该候选的条目兜底（兼容旧调用）。二者命中
 * 均视作有效回答，未知键/未知候选 → 明确不可命中（不静默）。
 */
function findAnswer(
  answers: Map<string, { candidateId: string; answer: string; regionHint?: string }>,
  candidateId: string,
  consumed: Set<string>,
): { candidateId: string; answer: string; regionHint?: string } | undefined {
  // ① 回执的 candidateId 命中该候选（最确定）
  for (const [id, a] of answers) {
    if (!consumed.has(id) && a.candidateId === candidateId) {
      consumed.add(id)
      return a
    }
  }
  // ② key/candidateId 兜底（R5 兼容旧调用）：澄清键即候选 id，但未填候选身份
  for (const [id, a] of answers) {
    if (!consumed.has(id) && candidateId !== '' && id === candidateId) {
      consumed.add(id)
      return a
    }
  }
  return undefined
}

/** 由澄清回答派生的 scope picker：answer 精确命中候选（district 或坐标串）→ 采用。
 * answer 非选项命中（区域名/别名等不在此选）→ 返回 undefined 交由既有别名重查路径。 */
function scopePickerFor(
  answer: string,
): (matches: GeocoderMatch[]) => GeocoderMatch | undefined {
  const a = answer.trim()
  const parsed = parseCoordString(a)
  return (matches) => {
    for (const m of matches) {
      if (a !== '' && m.district?.trim() === a) return m
      if (parsed !== undefined && m.coords && coordClose(m.coords, parsed)) return m
    }
    return undefined
  }
}

/** 旧澄清快照确认：回答精确命中 district 或坐标即确认原地点身份。 */
function answerMatchesPlace(answer: string, place: ResolvedPlace): boolean {
  const a = answer.trim()
  if (a !== '' && place.district?.trim() === a) return true
  const parsed = parseCoordString(a)
  return parsed !== undefined && place.coords !== undefined && coordClose(place.coords, parsed)
}

/** 别名/区域线索重查仍未命中时，保留候选身份并给出明确重答指引。 */
function markUnmatchedAnswer(
  candidate: ResolveCandidate,
  answer: string,
  resolution: { place: ResolvedPlace; clarification?: ResolveClarification },
): { place: ResolvedPlace; clarification?: ResolveClarification } {
  if (resolution.clarification === undefined) return resolution
  const shown = answer === '' ? '（空）' : answer
  const question = `澄清回答「${shown}」未命中候选「${candidate.name.trim()}」，请重新回答已列区域/别名/入口或坐标`
  return {
    place: {
      ...resolution.place,
      placeId: placeIdOf(candidate),
      candidateId: candidate.candidateId,
      name: candidate.name.trim(),
      pendingClarification: question,
    },
    clarification: {
      ...resolution.clarification,
      candidateId: candidate.candidateId,
      question,
    },
  }
}

/** unicode 坐标 str 容差判定（"lng,lat"，容忍空格）。 */
function coordClose(a: GeoCoords, b: GeoCoords): boolean {
  return Math.abs(a.lng - b.lng) < 1e-4 && Math.abs(a.lat - b.lat) < 1e-4
}

/** "lng,lat" 字符串 → GeoCoords（容忍空格/两段取前两位）；非数字返回 undefined。 */
function parseCoordString(value: string): GeoCoords | undefined {
  const parts = value.trim().split(',').map((p) => Number(p.trim()))
  if (parts.length < 2) return undefined
  const lng = parts[0]
  const lat = parts[1]
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined
  return { lng, lat, sys: 'GCJ02' }
}

// ────────────────────────── 工具定义（W4 T17 单一集成者在 index.ts 注册） ──────────────────────────

const RESOLVE_PARAMETERS = {
  planId: { type: 'string', required: true, description: '计划 ID' },
  expectedIntelVersion: { type: 'integer', description: '调用方所依据的 intel 证据版本（过期 → research_not_ready 零网络）' },
  candidates: {
    type: 'array', required: true, description: `候选（≤${RESOLVE_CANDIDATES_MAX}）：candidateId/name/kind(attraction|lodging|area|hub)/intelRefs 或 userRef/regionHint/selectionReason；禁止直接携带坐标`,
    items: { type: 'json' },
  },
  selectionOrder: { type: 'array', items: { type: 'string' }, required: true, description: `选中候选 id 序列（≤${RESOLVE_SELECTION_MAX}；可重复表达闭环/重访，禁止相邻重复零长度边）` },
  entryCandidateId: { type: 'string', description: '入口点候选 id' },
  lodgingStays: { type: 'json', description: '住宿安排（placeId+入住条件；供住宿/区域参考估算）' },
  disambiguationAnswers: { type: 'json', description: `澄清回答：{clarificationId 或 candidateId:{candidateId,answer,regionHint?}}（键优先按回执 key，均按候选 candidateId 命中）；answer 命中规则 = 选项精确命中（scope 的 district/坐标串）＞ candidateId/key ＞ 坐标串(user-provided 直用)／区域名(regionHint 单次重查)；未知 key/回答 → 明确未命中引导重答` },
} as const
type ResolveParams = InferArgs<typeof RESOLVE_PARAMETERS>

const RESOLVE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    intelVersion: { type: 'integer', required: true },
    inputFingerprint: { type: 'string', required: true },
    places: { type: 'json', required: true },
    selectedSequence: { type: 'array', required: true, items: { type: 'string' } },
    pendingClarifications: { type: 'json', required: true },
    entryPlaceId: { type: 'string' },
    researchNotReady: { type: 'json' },
  },
} as const
type ResolveOutput = InferValue<typeof RESOLVE_OUTPUT_SCHEMA>

type OutputPlace = { candidateId: string; name: string; coords?: unknown; coordinate_source: string }
type OutputClarification = { candidateId: string; question: string; kind: string }
type OutputNotReady = { reason: string; missing?: string; detail?: string }

function render(_args: ResolveParams, value: ResolveOutput): ContentBlock[] {
  const places = (value.places as unknown as OutputPlace[]) ?? []
  const clarifications = (value.pendingClarifications as unknown as OutputClarification[]) ?? []
  const lines: [string, string][] = [
    ['status', value.status],
    ['intelVersion', String(value.intelVersion)],
    ['inputFingerprint', value.inputFingerprint.slice(0, 16)],
    ['已解析地点', String(places.filter((p) => p.coords !== undefined).length)],
    ['选中序列', (value.selectedSequence as string[]).join(' → ')],
  ]
  if (value.researchNotReady !== undefined) {
    const nr = value.researchNotReady as unknown as OutputNotReady
    return textCard(`**travel_resolve_places** · 研究未就绪（zero network）\n${cardLines([
      ['reason', nr.reason],
      ['detail', nr.detail ?? ''],
    ])}`)
  }
  if (clarifications.length > 0) {
    lines.push(['待澄清', clarifications.map((q) => q.question).join('；')])
  }
  return textCard(`**travel_resolve_places** · 地理解析\n${cardLines(lines)}`)
}

/** 工具定义工厂（W4 T17 由单一集成者在 index.ts 注册并注入生产 resolver 链）。 */
export function createTravelResolvePlacesTool(store: TravelStore, deps: ResolveDeps): ToolDefinition {
  return defineTool({
    name: 'travel_resolve_places',
    description: `候选校验与多源地理解析（W2 T9）：校验候选出处与上游版本（过期 → research_not_ready 零网络）；优先复用已验证坐标 → amap → tencent → 可选 OSM。渠道回报 district 供地域一致性判定（缺少则该约束下不自动采用）；多子 POI（售票处/正门/停车场）自动收敛父 POI，仅真同名异地（区县互异）澄清；理解歧义/低置信/必去点无法定位 → 询问（每轮 ≤3）；answer 命中规则：选项精确命中（district/坐标串）＞candidateId/key ＞坐标串(user-provided 直用 source=user)／区域名(regionHint 单次重查)；未知回答回执引导不循环。缺 Key/网络失败 → degraded 不猜坐标。产 places.json（稳定 placeId/source/coordinate_source/resolveConfidence/attribution/status）。`,
    parameters: RESOLVE_PARAMETERS,
    output: { schema: RESOLVE_OUTPUT_SCHEMA, render },
    timeoutMs: 60_000,
    async execute(args) {
      // P0-A R6：单次规划预算重置在工具执行入口恰一次（amap QuotaCounter 进程级单例
      // 不重构；每调用重置使多轮 resolve 不把 REST 配额反复拱到熔断）。
      if (deps.resetPlanBudget !== undefined) deps.resetPlanBudget()
      const result = await runResolvePlaces({
        planId: args.planId,
        expectedIntelVersion: args.expectedIntelVersion,
        candidates: args.candidates as unknown as ResolveCandidate[],
        selectionOrder: args.selectionOrder,
        entryCandidateId: args.entryCandidateId,
        lodgingStays: args.lodgingStays as undefined,
        disambiguationAnswers: args.disambiguationAnswers as undefined,
      }, store, deps)
      return losslessJson(project(result))
    },
  })
}

function project(o: ResolvePlacesResult): ResolveOutput {
  return {
    planId: o.planId,
    status: o.status,
    intelVersion: o.intelVersion,
    inputFingerprint: o.inputFingerprint,
    places: JSON.parse(JSON.stringify(o.places)) as ResolveOutput['places'],
    selectedSequence: [...o.selectedSequence],
    pendingClarifications: JSON.parse(JSON.stringify(o.pendingClarifications)) as ResolveOutput['pendingClarifications'],
    ...(o.entryPlaceId !== undefined ? { entryPlaceId: o.entryPlaceId } : {}),
    ...(o.researchNotReady !== undefined
      ? { researchNotReady: JSON.parse(JSON.stringify(o.researchNotReady)) as ResolveOutput['researchNotReady'] } : {}),
  }
}

/**
 * 生产 amap geocoder resolver（W4 T17 接线；草稿 B：amap → tencent → 可选 OSM）。
 * 单匹配 → GeocoderMatch；regionHint 作 city 提示；住宿/区域中心标 areaReference。
 *
 * C2 置信直裁：amap geocode 只回一个 best 解、无唯一性证据 → 一律 medium（绝不因
 * 提供了 regionHint 就标 high）。地域一致性由 resolveCandidate 以 source 回报的
 * 行政区核对；amap 回报 district（P0-A R1）时可验证，缺失 → 带 regionHint 的候选
 * 自然转交下一渠道（tencent 回报 district 可验证）或被澄清，绝不把「带 regionHint
 * 的单 best」冒充唯一高置信。
 */
export function createAmapResolver(adapter: import('../adapters/amap.js').AmapAdapter): GeocoderProvider {
  return {
    name: 'amap',
    async available(env) {
      return adapter.available(env)
    },
    async geocode(candidate, env) {
      // env 透传：amap geocode 的 Key 解析链依赖调用方环境（settings/credentials/env 热读）。
      // 缺 env 时 resolveKey 只能落到 process.env —— 在 credentials 层持有 AMAP 键的环境
      // 会误报「Key 未配置」，与「缺 Key 记 degraded 不猜坐标」契约冲突。
      // P0-A R6：amap 配额熔断/网络异常不再 throw 中断整链——适配器内部已记账 degraded，
      // 此处捕获转 undefined（=本渠道无结果），由 resolve 继续下一渠道/澄清（与 tencent 一致）。
      let resolved: { coords?: import('../models/types.js').GeoCoords; district?: string } | undefined
      try {
        resolved = await adapter.geocode(candidate.name, primaryRegionForGeocoder(candidate.regionHint), env)
      } catch {
        return undefined
      }
      const { coords } = resolved
      if (coords === undefined) return undefined
      const isArea = candidate.kind === 'lodging' || candidate.kind === 'area'
      // 唯一性诚实：无唯一性/行政区验证证据 → medium（regionHint 不作 high 依据）。
      // district 报回则交 regionConsistent 验证地域（P0-A R1 自动采用路径随 amap 报回行政区开放）
      const confidence: ResolveConfidence = 'medium'
      const match: GeocoderMatch = { coords, confidence, ...(isArea ? { areaReference: true } : {}) }
      return resolved?.district !== undefined ? [{ ...match, district: resolved.district }] : [match]
    },
  }
}

/**
 * 生产 tencent poiSearch resolver（零 key 兜底；regionHint 作 region）。
 *
 * C2 唯一性直裁：取多候选（pageSize=5），按坐标去重——恰好一个唯一命中 → high；
 * 多个不同候选（同名/地域冲突）→ 原样返回多匹配，交由 resolveCandidate 走澄清
 * （scope），不再盲目取 first 冒充唯一。零命中/渠道抛空 → undefined。
 */
export function createTencentResolver(adapter: import('../adapters/tencent.js').TencentMapAdapter): GeocoderProvider {
  return {
    name: 'tencent',
    async available(env) {
      return adapter.available(env)
    },
    async geocode(candidate) {
      let items: Array<{ coords?: GeoCoords; title?: string; district?: string }>
      try {
        const result = await adapter.poiSearch({
          keywords: candidate.name,
          region: primaryRegionForGeocoder(candidate.regionHint),
          pageSize: 5,
        })
        items = result.data
      } catch {
        // poiSearch 空结果抛 EngineError.empty → 视为无结果（非 degraded 猜测）
        return undefined
      }
      const matches = items.filter((it): it is { coords: GeoCoords; title?: string; district?: string } => it.coords !== undefined)
      if (matches.length === 0) return undefined
      const isArea = candidate.kind === 'lodging' || candidate.kind === 'area'
      // 按坐标判唯一：去重后 >1 不同点 = 同名/地域冲突/子 POI 集
      const distinct: Array<{ coords: GeoCoords; title?: string; district?: string }> = []
      for (const m of matches) {
        const dup = distinct.some((d) => d.coords.lng === m.coords.lng && d.coords.lat === m.coords.lat)
        if (!dup) distinct.push(m)
      }
      const toMatch = (m: { coords: GeoCoords; district?: string }): GeocoderMatch => ({
        coords: m.coords,
        confidence: 'high',
        ...(m.district !== undefined ? { district: m.district } : {}),
        ...(isArea ? { areaReference: true } : {}),
      })
      if (distinct.length === 1) return [toMatch(distinct[0])]

      // P0-A R2：多子 POI（售票处/正门/停车场…）自动收敛到父 POI，不再各占澄清位——
      // ① 前缀候选名且非「子服务站」标记的命中视为父 POI；唯一则直接采用；
      // ② 全部命中同行政区（确非地域冲突）→ 取最贴候选名的命中（子 POI 都属同一地点）。
      // 仅「title 均含候选名但分属不同区县（真同名异地）」才保留多匹配走 resolve scope 澄清。
      const candidateName = candidate.name.trim()
      const parentCandidates = distinct.filter((m) => {
        const title = m.title?.trim() ?? ''
        if (title === '') return false
        if (title === candidateName) return true
        const idx = title.indexOf(candidateName)
        if (idx < 0) return false
        // 候选名之后的段落出现「子服务站」标记 → 判定为售票处/大门/停车场类子 POI，非常父 POI
        return !SUB_POI_MARKER.test(title.slice(idx + candidateName.length))
      })
      if (parentCandidates.length === 1) return [toMatch(parentCandidates[0])]

      const districtGroups = new Map<string, Array<{ coords: GeoCoords; title?: string; district?: string }>>()
      for (const m of distinct) {
        const key = m.district?.trim() || ''
        const arr = districtGroups.get(key)
        if (arr) arr.push(m)
        else districtGroups.set(key, [m])
      }
      // 全部命中同一"非空"行政区 → 属同一地点不同子 POI：取距候选名最近命中，不澄清。
      // 区县全缺（key === ''）不在此归并（保底走 resolve 既有多匹配澄清语义）。
      if (districtGroups.size === 1 && Array.from(districtGroups.keys())[0] !== '') {
        const sole = chooseClosestTitle(Array.from(districtGroups.values())[0], candidateName)
        return [toMatch(sole)]
      }

      // 真同名异地（不同区县均有命中）→ 保留多匹配，交由 resolveCandidate 走 scope 澄清
      return distinct.map(toMatch)
    },
  }
}

/** 售票处/售票厅/大门|正门/出入口/停车场/游客中心/导服/管理处… —— 子服务站标记（P0-A R2）。 */
const SUB_POI_MARKER = /(售票|大门|正门|侧门|出入口|检票|停车场|游客中心|服务站|服务区|管理处|景区入口|门区|栈道)/

/** 多命中中选 title 与候选名最接近的一条（候选名全包含 + 长度差最小；ties 取首）。 */
function chooseClosestTitle(
  set: Array<{ title?: string; district?: string; coords: GeoCoords }>,
  candidateName: string,
): { title?: string; district?: string; coords: GeoCoords } {
  let bestIndex = 0
  let bestDiff = Number.POSITIVE_INFINITY
  set.forEach((m, i) => {
    const title = m.title?.trim() ?? ''
    const diff = title.startsWith(candidateName) ? title.length - candidateName.length : Math.abs(title.length - candidateName.length)
    if (title !== '' && diff < bestDiff) {
      bestDiff = diff
      bestIndex = i
    }
  })
  return set[bestIndex]
}
