/**
 * 七态状态机（design §5.4 行 349-371 mermaid）。
 *
 * 合法转换（表驱动）：
 *   collecting → recommending / confirmed
 *   recommending → collecting（回注槽位）
 *   confirmed → researching
 *   researching → generating
 *   generating → delivered
 *   delivered → revising（用户反馈修订；同时是 M1 休止态/可交付终态）
 *   revising → generating（重建并重渲染）
 * 同态停留（self）全部允许（update/intake 渐进收集的幂等语义）。
 *
 * W0 T3 通路修补（草稿 F）：必要时在既有表之外允许 revising 回路——
 * researching/generating → revising、revising → researching，仅在「无在途任务」
 * 时可达（inFlight 判定由 T2 计划级在途锁驱动；travel_update_request 的状态
 * 门保持既有语义，回路供编排层/W1+ 工具经 canTransitionEx 消费）。
 *
 * 终态语义：delivered 为「可交付终态」——除 →revising 外不可转出
 * （delivered→researching 等被拒）；用户不再修订即结束。
 */
import { ARTIFACT_STATES, REQUEST_STATUSES, type ArtifactState, type RequestStatus } from '../models/types.js'
import { InvalidTransitionError } from '../errors.js'

/** 工件状态枚举（与请求七态分离；unknown 表示未入账/未知版本，只读）。 */
export { ARTIFACT_STATES }
export type { ArtifactState }
export const ARTIFACT_STATUS_STATES = ARTIFACT_STATES
export type ArtifactStatus = ArtifactState

/** 休止/可交付终态。 */
export const TERMINAL_STATUS: RequestStatus = 'delivered'

/** 状态机转换表：仅收录 §5.4 mermaid 的边（不含 self，self 单独放行）。 */
export const TRANSITION_TABLE: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  collecting: ['recommending', 'confirmed'],
  recommending: ['collecting'],
  confirmed: ['researching'],
  researching: ['generating'],
  generating: ['delivered'],
  delivered: ['revising'],
  revising: ['generating'],
}

/**
 * W0 T3 修订回路（草稿 F）：无在途任务时允许的额外边。
 * - researching/generating → revising（研究/生成中可回修订，但不得边跑边改输入）
 * - revising → researching（修订中改研究输入 → 回研究阶段）
 */
export const REVISE_LOOP: ReadonlyArray<readonly [RequestStatus, RequestStatus]> = [
  ['researching', 'revising'],
  ['generating', 'revising'],
  ['revising', 'researching'],
]

const ALL_STATES: readonly RequestStatus[] = REQUEST_STATUSES

/** 从某状态可到达的下一状态（含 self）。 */
export function nextStatuses(from: RequestStatus): readonly RequestStatus[] {
  return [from, ...TRANSITION_TABLE[from]]
}

/** 转换合法性（self 恒合法）。 */
export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return from === to || TRANSITION_TABLE[from].includes(to)
}

/** 断言转换合法；非法抛 InvalidTransitionError（含允许清单）。 */
export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (canTransition(from, to)) return
  const allowed = nextStatuses(from).map((s) => (s === TERMINAL_STATUS ? `${s}(终态)` : s)).join(' / ')
  throw new InvalidTransitionError(from, to, `允许的下一状态：${allowed}；非法转换：${from}→${to}`)
}

/**
 * W0 T3 扩展转换合法性（含修订回路）：有在途任务（inFlight=true）时 revising
 * 回路边一律不可达（不边跑边改输入）；无在途任务时 research 阶段允许回修订。
 */
export function canTransitionEx(from: RequestStatus, to: RequestStatus, inFlight: boolean): boolean {
  if (from === to) return true
  if (TRANSITION_TABLE[from].includes(to)) return true
  if (!inFlight) {
    for (const [f, t] of REVISE_LOOP) {
      if (f === from && t === to) return true
    }
  }
  return false
}

/** 断言扩展转换合法；在有在途任务时给出明确指引（待取消/完成后可改）。 */
export function assertTransitionEx(from: RequestStatus, to: RequestStatus, inFlight: boolean): void {
  if (canTransitionEx(from, to, inFlight)) return
  const detail = inFlight
    ? '在途任务占用，拒绝修改输入；请等待完成或取消后再改'
    : `允许的下一状态：${nextStatusesEx(from, false).join(' / ')}；非法转换：${from}→${to}`
  throw new InvalidTransitionError(from, to, detail)
}

/** 扩展可达集（inFlight=false 时含修订回路）。 */
export function nextStatusesEx(from: RequestStatus, inFlight: boolean): readonly RequestStatus[] {
  const states = [from, ...TRANSITION_TABLE[from]]
  if (!inFlight) {
    for (const [f, t] of REVISE_LOOP) {
      if (f === from && !states.includes(t)) states.push(t)
    }
  }
  return states
}

/** 是否可交付终态（delivered；除 revising 外不可转出）。 */
export function isTerminal(status: RequestStatus): boolean {
  return status === TERMINAL_STATUS
}

/** 状态机完整性守卫（供测试断言表覆盖全部七态）。 */
export function registeredStates(): readonly RequestStatus[] {
  return ALL_STATES
}