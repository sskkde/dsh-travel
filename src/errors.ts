/**
 * dsh-travel 共享错误类型。
 *
 * 工具层把「参数语义校验失败」与「状态机非法转换」作为明确错误抛出（LLM
 * 在 tool-result 中看到原因并修正，符合设计 §6 规格与 M1 QA 剧本）；「计划
 * 不存在」类查询不抛错、返回结构化 not-found（design §6 行 524）。
 */

/** 语义校验失败（必填缺失之外的不合法值：日期格式/区间倒置/天数不一致等）。 */
export class TravelValidationError extends Error {
  /** 路径限定（如 `slots.dateStart`）的违规清单；至少一项。 */
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(issues.join('；'))
    this.name = 'TravelValidationError'
    this.issues = issues
  }
}

/**
 * 状态机非法转换（design §5.4 mermaid 之外的边，如 delivered→researching、
 * confirmed→collecting）。携带 from/to 便于调用方生成 rerunHints 或引导语。
 */
export class InvalidTransitionError extends Error {
  readonly from: string
  readonly to: string

  constructor(from: string, to: string, detail?: string) {
    const allowed = detail ? `（${detail}）` : ''
    super(`状态机非法转换：${from} → ${to}${allowed}`)
    this.name = 'InvalidTransitionError'
    this.from = from
    this.to = to
  }
}

/**
 * W0 T2 迟到写拒绝（草稿 F：提交前上游版本复核，版本不符 → 迟到写拒绝）。
 * 携带 reasonCode='stale_version' 供调用方（工具/编排层）作确定性错误码。
 */
export class LateWriteError extends Error {
  /** 版本键（intel/research/places/transport/advice/quotes）。 */
  readonly key: string
  /** 期望（提交方持有的上游版本）。 */
  readonly expected: number
  /** 当前（计划级账本现值）。 */
  readonly current: number
  readonly reasonCode: 'stale_version'

  constructor(key: string, expected: number, current: number) {
    super(`迟到写拒绝：${key} 版本期望 ${expected} 但当前为 ${current}（旧快照不得覆盖新数据）`)
    this.name = 'LateWriteError'
    this.key = key
    this.expected = expected
    this.current = current
    this.reasonCode = 'stale_version'
  }
}

/**
 * W0 T4 来源治理拒绝（草稿 H：sources 白名单 + 许可证据门）。
 * - unknown_source：请求未知源（工具不得借追加检索扩大登录授权）
 * - unverified_license：上游许可未核实（如 5A 混合数据）→ 仅自造 fixture
 */
export class SourceGovernanceError extends Error {
  readonly reasonCode: 'unknown_source' | 'unverified_license'

  constructor(reasonCode: 'unknown_source' | 'unverified_license', detail: string) {
    super(detail)
    this.name = 'SourceGovernanceError'
    this.reasonCode = reasonCode
  }
}