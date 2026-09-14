/**
 * 存储路径与工作区根解析（ADR-6 / §5.4）。
 *
 * 布局：<workspaceRoot>/.dsh-travel/<planId>/{request.json|intel.json|...|page.html}
 * 根解析优先级：显式 override（测试/宿主注入）→ 环境变量 DSH_TRAVEL_ROOT →
 * 进程 cwd（DSH 工作区）。
 *
 * W0 T2（草稿 F）：新增工件（research-state/places/route-transport/route-coverage/
 * lodging-quotes/artifact-meta）注册进 ARTIFACT_NAMES；research 子工件布局
 * research-rounds/<roundId>.json、research-content/<itemId>/<contentVersion>.json、
 * research-assessments/<assessmentId>.json——路径仅由插件生成，所有 id 过
 * assertSafeResearchId 安全字符校验后拼接（任何输入不直接拼任意路径，
 * 跨计划 contentRef 读取拒绝）。
 */
import { join } from 'node:path'

export const TRAVEL_DIR_NAME = '.dsh-travel'
export const REQUEST_FILE = 'request.json'
export const DEGRADED_FILE = 'degraded.json'
/** 工件全集（legacy 五项 + W0/B6 新工件八项）；消费者（listArtifacts/state/render/export）同步。 */
export const ARTIFACT_NAMES = [
  'intel.json', 'transport.json', 'advice.json', 'itinerary.json', 'page.html',
  'research-state.json', 'places.json', 'route-transport.json', 'route-coverage.json',
  'lodging-quotes.json', 'rental-quotes.json', 'cost.json', 'insights.json', 'artifact-meta.json',
] as const

/** research 子工件布局目录（T2：路径仅由插件生成）。 */
export const RESEARCH_ROUNDS_DIR = 'research-rounds'
export const RESEARCH_CONTENT_DIR = 'research-content'
export const RESEARCH_ASSESSMENTS_DIR = 'research-assessments'

/** 解析工作区根（默认 DSH 工作区 = process.cwd()）。 */
export function resolveTravelRoot(override?: string): string {
  const candidate = override?.trim() || process.env.DSH_TRAVEL_ROOT || process.cwd()
  return candidate
}

/** planId 必须为路径安全标识（防目录穿越）。 */
export function assertSafePlanId(planId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(planId) || planId.includes('..')) {
    throw new Error(`非法 planId（仅允许字母/数字/._-）：${JSON.stringify(planId)}`)
  }
}

/**
 * research 子工件 id（roundId/itemId/contentVersion/assessmentId）安全字符校验。
 * 允许字母/数字/._:+-（intel 条目 id 形如 `tencent-poi:1629…` 含冒号），显式
 * 拒绝 `..`（目录穿越）——防任何输入拼接任意路径 / 跨计划读取。
 */
export function assertSafeResearchId(id: string, label: string): void {
  if (
    typeof id !== 'string' || id.length === 0
    || !/^[A-Za-z0-9._:+-]+$/.test(id) || id.includes('..')
  ) {
    throw new Error(`非法 ${label}（仅允许字母/数字/._:+-，禁目录穿越）：${JSON.stringify(id)}`)
  }
}

/** <root>/.dsh-travel/<planId> 目录。 */
export function planDirectory(root: string, planId: string): string {
  assertSafePlanId(planId)
  return join(root, TRAVEL_DIR_NAME, planId)
}

/** <root>/.dsh-travel 根目录（计划目录集合）。 */
export function travelDirectory(root: string): string {
  return join(root, TRAVEL_DIR_NAME)
}

/** 计划目录内的文件路径（拒绝绝对路径与目录穿越）。 */
export function planFilePath(root: string, planId: string, name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('/')
    || name.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new Error(`非法计划文件路径：${JSON.stringify(name)}`)
  }
  return join(planDirectory(root, planId), name)
}

/** research 轮次工件路径（research-rounds/<roundId>.json）。 */
export function researchRoundFilePath(root: string, planId: string, roundId: string): string {
  assertSafePlanId(planId)
  assertSafeResearchId(roundId, 'roundId')
  return join(planDirectory(root, planId), RESEARCH_ROUNDS_DIR, `${roundId}.json`)
}

/** 正文内容工件路径（research-content/<itemId>/<contentVersion>.json）。 */
export function researchContentFilePath(root: string, planId: string, itemId: string, contentVersion: string): string {
  assertSafePlanId(planId)
  assertSafeResearchId(itemId, 'itemId')
  assertSafeResearchId(contentVersion, 'contentVersion')
  return join(planDirectory(root, planId), RESEARCH_CONTENT_DIR, itemId, `${contentVersion}.json`)
}

/** assessment 工件路径（research-assessments/<assessmentId>.json）。 */
export function researchAssessmentFilePath(root: string, planId: string, assessmentId: string): string {
  assertSafePlanId(planId)
  assertSafeResearchId(assessmentId, 'assessmentId')
  return join(planDirectory(root, planId), RESEARCH_ASSESSMENTS_DIR, `${assessmentId}.json`)
}