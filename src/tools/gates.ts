/**
 * gates.ts —— W4 T16 共享 DAG 代码门 helper（草稿 F/165；计划 T16①）。
 *
 * 把「请求完整链所需工件缺失 / 版本过期 / 失败元数据」编码成结构化
 * `blocked + nextAction` 回执，供各阶段（resolve / transport / route-transport /
 * lodging-quotes）在**发起任何下游网络请求前**统一返回（零网络）。
 *
 * 语义（草稿 F/166-167）：
 * - 缺工件 / 版本过期 → blocked + 准确 nextAction；
 * - 失败 / 零结果（artifact-meta status=failed|empty）→ 发布失败元数据，不把旧
 *   数据当成功消费（不复活）；
 * - 新版本失败也不复活旧充分状态（research 门复用 computeResearchStatus）。
 *
 * 每个 gate 返回 `undefined` 表示依赖齐备可放行；否则返回结构化 blocked。
 * 全为纯逻辑 + 只读 store 调用（无任何适配器/网络）。
 */
import { TravelStore } from '../store/store.js'
import type { PlacesArtifact } from '../models/types.js'
import { computeResearchStatus } from './research-assessment.js'

/** 结构化 blocked 回执（各阶段的统一门失败形态）。 */
export interface GateBlocked {
  blocked: true
  /** 稳定 reason code（测试可锚定）。 */
  reason: string
  /** 人话说明（含缺失/过期的具体对象与版本）。 */
  detail: string
  /** 准确下一动作（调用方可直接据此重试/补数据）。 */
  nextAction: string
}

/**
 * 研究就绪门（resolve 前置，草稿 58-59）：当前有效 sufficient 必须引用当前
 * researchVersion 且预算未耗尽；否则 research_not_ready（零网络）。
 * 复用 research-assessment 的 computeResearchStatus 语义，统一 blocked 形态。
 */
export async function researchGate(store: TravelStore, planId: string): Promise<GateBlocked | undefined> {
  const status = await computeResearchStatus(store, planId)
  if (status.ready) return undefined
  return {
    blocked: true,
    reason: 'research_not_ready',
    detail: status.detail ?? `研究尚未就绪（${status.missing ?? 'unknown'}）`,
    nextAction: status.missing === 'budget_exhausted'
      ? '研究额度已耗尽（暂停非完成）：请补充/调整研究额度后，继续补搜再提交当前 sufficient'
      : status.missing === 'stale_version'
        ? '当前 sufficient 引用的研究版本过期：请基于最新研究重新 travel_record_research_assessment（verdict=sufficient）'
        : '请继续补搜/取正文，并提交当前 sufficient（travel_record_research_assessment）后重试',
  }
}

/**
 * places 门（transport / route-transport / lodging-quotes 前置，草稿 D/F）：
 * - 缺 places.json → blocked（请先 resolve）；
 * - artifact-meta status=failed|empty → 不把失败/空当成功消费；
 * - stale（hash 失配/内容不在最近提交）→ 不复活旧数据；
 * - intel 证据版本领先于解析 → 解析过期（新研究使旧解析失效）；
 * - 可选 expectedPlacesVersion 校验（调用方所依据版本过期 → blocked）。
 */
export async function placesGate(
  store: TravelStore,
  planId: string,
  expectedPlacesVersion?: number,
): Promise<GateBlocked | undefined> {
  const state = await store.readArtifactWithState<PlacesArtifact>(planId, 'places.json')
  if (!state.found) {
    return {
      blocked: true,
      reason: 'places_not_ready',
      detail: '缺少 places.json：地理解析未完成',
      nextAction: '请先执行 travel_resolve_places（候选+入口点解析）后重试',
    }
  }
  if (state.status === 'failed' || state.meta?.status === 'failed') {
    return {
      blocked: true,
      reason: 'places_failed',
      detail: 'places 上次发布失败（不把失败当成功消费）',
      nextAction: '请重新执行 travel_resolve_places 修复解析后重试',
    }
  }
  if (state.status === 'empty' || state.meta?.status === 'empty') {
    return {
      blocked: true,
      reason: 'places_empty',
      detail: 'places 上次发布为空（零结果不复活）',
      nextAction: '请补足候选/澄清后重新执行 travel_resolve_places',
    }
  }
  if (state.status === 'stale' && state.staleReason === 'hash_mismatch') {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: 'places 工件内容与最近提交 hash 不符（外部篡改/损坏）：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }
  // unknown/unaccounted is normally read-compatible. The exception is a
  // stage-owned integrity signature: when the manifest says the latest commit
  // was the places stage but places.json is absent from that commit, the file
  // cannot be authenticated and must not be revived as the source of truth.
  if (state.status === 'unknown' && state.staleReason === 'unaccounted' && state.meta?.stage === 'places') {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: 'places 最近一次提交声明属于 places 阶段，但工件未入账，无法验证完整性：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }
  if (state.status === 'stale' && state.staleReason === 'not_in_commit' && state.meta?.stage === 'places') {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: 'places 最近一次提交无法验证工件完整性：不复活旧数据',
      nextAction: '请重新执行 travel_resolve_places 发布新版本后重试',
    }
  }
  const artifact = state.data
  if (artifact === undefined) {
    return {
      blocked: true,
      reason: 'places_not_ready',
      detail: 'places.json 内容缺失',
      nextAction: '请先执行 travel_resolve_places 完成地理解析',
    }
  }
  // intel 证据版本领先于解析 → 解析过期（新研究使旧入口/选点失效）
  const intelVersion = await store.currentVersion(planId, 'intel')
  if (artifact.intelVersion < intelVersion) {
    return {
      blocked: true,
      reason: 'places_stale',
      detail: `places 引用的 intel 证据版本（${artifact.intelVersion}）落后于当前研究版本（${intelVersion}）：新证据已使旧解析失效`,
      nextAction: '请基于当前研究结果重新执行 travel_resolve_places 后重试',
    }
  }
  if (expectedPlacesVersion !== undefined) {
    const cur = await store.currentVersion(planId, 'places')
    if (expectedPlacesVersion !== cur) {
      return {
        blocked: true,
        reason: 'places_stale',
        detail: `places 版本过期（expected=${expectedPlacesVersion}，current=${cur}）`,
        nextAction: '请基于当前解析版本重新发起本阶段查询',
      }
    }
  }
  return undefined
}

/**
 * 汇总矩阵：给定待检查网关门，返回首块 blocked（或 undefined=全齐）。
 * 供测试一次性断言多阶段缺依赖 → blocked+nextAction+零网络。
 */
export function firstBlocked(gates: ReadonlyArray<GateBlocked | undefined>): GateBlocked | undefined {
  for (const g of gates) {
    if (g !== undefined) return g
  }
  return undefined
}
