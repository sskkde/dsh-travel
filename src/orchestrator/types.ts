/**
 * fan-out 编排器契约（M1 T5 / Wα 薄切片骨架；W3 在同一骨架上加厚不重写）。
 *
 * 骨架职责（Wα 完成）：
 * - 渠道清单驱动：ResearchChannel[] 显式声明——W3 加渠道 = 向清单追加一项，
 *   不动编排器本体
 * - 并发执行：Promise.allSettled 并行，单源失败不影响其余源
 * - 单源失败 → EngineError → degraded 记账（base.ts toDegraded），不抛裸异常
 * - 统一超时预算：deadlineMs 参数化，逐渠道按剩余预算截断（超预算 → TIMEOUT 记账）
 *
 * W3 加厚点（本文件落实）：
 * - 单源重试 ≤2 次指数退避（1s/4s，等待计入总预算）→ fanout.ts withChannelBudget
 * - 渠道开关前置过滤（ADR-12：settings 热读 →「已停用（用户配置）」记账）→ fanout.ts
 * - 聚合去重（跨渠道：笔记 ID / POI ID）→ fanout.ts aggregateIntelItems
 * - 冲突标注（conflictsWith 互链）→ fanout.ts annotateConflicts
 * - 时效降权（>12 个月 → confidence 降级 + 标注）→ fanout.ts applyTimeliness
 * - presentCall 进度反馈 → 工具层 execute 包装（research-*.ts presentCall）
 */
import type { IntelCategory, IntelItem } from '../models/types.js'
import type { CanonicalQuery, KeyResolutionEnv } from '../adapters/base.js'
import type { DegradedEntry, EngineErrorCode } from '../adapters/base.js'

/** 渠道执行上下文：统一超时预算的唯一事实来源。 */
export interface ResearchChannelContext {
  /** 绝对截止时刻（epoch ms）；渠道内长调用应自行对照剩余预算（W3）。 */
  readonly deadlineMs: number
  /** 工具总预算（ms；报告/日志展示用）。 */
  readonly budgetMs: number
  /** ADR-12 热读取环境（渠道可用性/开关判定透传；缺省=无 settings 位）。 */
  readonly env?: KeyResolutionEnv
}

/** 渠道执行结果：成功携带条目；失败携带降级信息（不抛裸异常）。 */
export type ResearchChannelOutcome =
  | {
      readonly ok: true
      readonly items: readonly IntelItem[]
      /** 复合渠道的内部降级明细（如 Tencent→Amap），由 fan-out 统一记账。 */
      readonly degraded?: readonly DegradedEntry[]
    }
  | {
      readonly ok: false
      readonly code: EngineErrorCode
      readonly reason: string
      /** 复合渠道失败时保留主源与 fallback 各自的证据。 */
      readonly degraded?: readonly DegradedEntry[]
    }

/** 检索渠道描述符（fan-out 的清单项；W3 新增渠道实现本接口即可）。 */
export interface ResearchChannel {
  /** 降级记账 source 名（须与 src/adapters/env.ts CHANNEL_SETTINGS_PATHS 对齐，
   *  使「已停用（用户配置）」过滤按 settings 开关生效）。 */
  readonly name: string
  /** 前置可用性判定（Key/注入缺失时跳过并计入 degraded（fan-out 先查渠道开关）。 */
  available(): Promise<boolean>
  /** 执行一次渠道检索；失败返回 {ok:false}（EngineError 归一化在渠道内完成）。 */
  run(query: CanonicalQuery, ctx: ResearchChannelContext): Promise<ResearchChannelOutcome>
}

/** fan-out 编排参数。 */
export interface FanoutOptions {
  readonly channels: readonly ResearchChannel[]
  readonly query: CanonicalQuery
  /** 绝对截止时刻（epoch ms）；缺省 = now + budgetMs。 */
  readonly deadlineMs?: number
  /** 工具总超时预算（§6：research 180s）。 */
  readonly budgetMs: number
  /** ADR-12 热读取环境（fan-out 开关前置过滤用；缺省=不过滤）。 */
  readonly env?: KeyResolutionEnv
  /**
   * 单次规划开始回调（每 research 入口调用；缺省=不重置）。
   * 生产接线：amap.resetPlanBudget()——重置规划预算计数，消除长驻进程
   * 多次规划后 amap 配额累积熔断静默降级（CLOSURE §三-③）。
   */
  readonly resetPlanBudget?: () => void
  /** 单源失败重试延迟序列（指数退避）；等待计入总预算，耗尽即止。
   *  缺省 [1000, 4000]（§9.3-1：≤2 次，1s/4s）；测试可注入微延迟/空序列。 */
  readonly retryDelaysMs?: readonly number[]
}

/** fan-out 在聚合前的一条原始观察；channel 为稳定的 ResearchChannel.name。 */
export interface FanoutObservation {
  readonly channel: string
  readonly item: IntelItem
}

/** fan-out 汇总：聚合条目 + 原始观察 + 降级记账 + 每执行渠道计数。 */
export interface FanoutResult {
  /** 同轮 content suppression 后的聚合条目。 */
  readonly items: IntelItem[]
  /** 聚合前的成功渠道原始观察；不会被跨轮 suppression 改写。 */
  readonly observations: readonly FanoutObservation[]
  readonly degraded: readonly DegradedEntry[]
  /** 按执行渠道名（channel.name）统计原始条目数（聚合去重前）。 */
  readonly counts: Readonly<Record<string, number>>
  /** 实际执行到的渠道名序列（含可用性为 false 的跳过项）。 */
  readonly executed: readonly string[]
}

/** 类别全集（research 参数默认值）。 */
export const ALL_INTEL_CATEGORIES: readonly IntelCategory[] = [
  'attraction', 'lodging', 'food', 'transportLocal', 'tip', 'warning', 'recommend',
]