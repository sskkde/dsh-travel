/**
 * 适配器层治理（governance）barrel —— M2.6 治理开关（roadmap.md:171-178）。
 *
 * W2/W3 渠道适配器在直抓/查询前的标准前置（用法见 base.ts 治理段交接注释）：
 * ```
 *   await this.acquireRate('xiaohongshu.com', env)          // 频控：排队至预算窗
 *   const decision = await this.robotsCheck(url, env)       // robots：Disallow → 跳过直抓
 *   if (!decision.allowed) { ... 记 degraded 并降级标注 ... }
 * ```
 * 本层是**叠加治理**：不替代渠道内配额（MAX_POI_CALLS/MAX_L05）语义。
 */
export * from './token-bucket.js'
export * from './robots.js'
export * from './sources.js'
export * from './url-safety.js'
export * from './osm-policy.js'