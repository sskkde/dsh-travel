/**
 * 测试共享：为完整 plan 装配当前 sufficient 评估（C5① build 门放行件）。
 * 完整 plan build 现要求「研究版本有效 + 当前 sufficient 评估」；seedResearch 已推进
 * researchVersion，此 helper 补上 sufficient 评估使 build 门放行（零网络、纯落盘）。
 * 须在 seedResearch 之后调用（依赖 research-state 与 researching 状态）。
 */
import type { TravelStore } from '../../src/store/store.js'
import { runRecordResearchAssessment } from '../../src/tools/research-assessment.js'

export async function seedSufficientAssessment(store: TravelStore, planId: string): Promise<void> {
  await runRecordResearchAssessment({ planId, verdict: 'sufficient', rationale: '测试装配：研究已充分（供 build 门放行）' }, store)
}
