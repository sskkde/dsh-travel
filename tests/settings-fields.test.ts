/**
 * 设置卡纯逻辑单测（client 半 fields.ts：字段表 + NFR-10 冗余校验）。
 * fields.ts 零运行时依赖，直接可测。
 */
import { describe, expect, it } from 'vitest'
import {
  ADVANCED_FIELDS, CHANNEL_FIELDS, CHANNEL_GROUPS, KEY_FIELDS,
  hasInsufficientRedundancy, redundancyReport,
  type TravelChannelMatrix,
} from '../src/client/fields'
import { en, zh } from '../src/client/locales'

/** 全开的渠道矩阵（用于对照；fr4.cityDidi 缺省关）。 */
function allOn(): TravelChannelMatrix {
  const matrix: TravelChannelMatrix = {
    fr3: {}, fr4: {}, fr5: {}, fr6: {}, fr7: {},
  }
  for (const def of CHANNEL_FIELDS) matrix[def.group][def.id] = true
  matrix.fr4.cityDidi = false
  matrix.fr3.xhsCloak = false
  return matrix
}

describe('字段表完整性（§10.1 三组字段）', () => {
  it('渠道矩阵 28 字段、5 组（W3a：fr3.socialL1 登录态定向）', () => {
    expect(CHANNEL_FIELDS).toHaveLength(28)
    expect(new Set(CHANNEL_FIELDS.map((def) => def.group))).toEqual(new Set(CHANNEL_GROUPS))
    expect(CHANNEL_FIELDS.filter((def) => def.group === 'fr3')).toHaveLength(9)
    expect(CHANNEL_FIELDS.filter((def) => def.group === 'fr4')).toHaveLength(8)
    expect(CHANNEL_FIELDS.filter((def) => def.group === 'fr5')).toHaveLength(4)
    expect(CHANNEL_FIELDS.filter((def) => def.group === 'fr6')).toHaveLength(3)
    expect(CHANNEL_FIELDS.filter((def) => def.group === 'fr7')).toHaveLength(4)
  })

  it('Key 字段 9 项（含知乎 OpenAPI secret 字段）', () => {
    expect(KEY_FIELDS.map((def) => def.id).sort()).toEqual([
      'amapJsapi', 'amapJscode', 'amapWebservice', 'cloakbrowser', 'didi', 'flyai', 'tmap', 'wendao', 'zhihu',
    ])
    expect(CHANNEL_FIELDS.find((def) => def.id === 'tier2')?.keyId).toBe('zhihu')
  })

  it('渠道文案同步移除退役平台并补齐知乎 OpenAPI 说明', () => {
    expect(zh['ch.tier2']).toBe('知乎')
    expect(zh['ch.tier2Hint']).toContain('OpenAPI')
    expect(zh['ch.tier2Hint']).toContain('L0')
    expect(zh['ch.tier3']).toBe('微博 / 贴吧 / 快手')
    expect(en['ch.tier2']).toBe('Zhihu')
    expect(en['ch.tier2Hint']).toContain('OpenAPI')
    expect(en['ch.tier2Hint']).toContain('L0')
    expect(en['ch.tier3']).toBe('Weibo / Tieba / Kuaishou')
    expect(zh['key.zhihu']).toBeTruthy()
    expect(en['key.zhihu']).toBeTruthy()
  })

  it('高级字段 10 项（v2：镜像补齐 robotsToSCheck/amapSecurityMode）', () => {
    expect(ADVANCED_FIELDS.map((def) => def.id)).toEqual([
      'socialDepth', 'researchTimeoutMs', 'rateLimitPerDomain', 'robotsToSCheck', 'routePrefix',
      'defaultMapProvider', 'amapSecurityMode', 'amapPoiBudgetPerPlan', 'amapRestBudgetPerPlan', 'profileTtlDays',
    ])
  })
})

describe('NFR-10 冗余校验（任一组启用渠道 <2 警示，软校验）', () => {
  it('默认矩阵（fr3/fr4 各 7 on、fr5/6/7 全 on）→ 全部 ≥2 无警示', () => {
    const report = redundancyReport(allOn())
    expect(report.every((entry) => !entry.insufficient)).toBe(true)
    expect(hasInsufficientRedundancy(allOn())).toBe(false)
    const fr4 = report.find((entry) => entry.group === 'fr4')
    expect(fr4?.enabled).toBe(7)
  })

  it('仅 1 个启用渠道的组 → insufficient（FR-8⑤ 预警条件）', () => {
    const matrix = allOn()
    matrix.fr3.xhsMcp = false
    matrix.fr3.xhsFallback = false
    matrix.fr3.douyin = false
    matrix.fr3.tier2 = false
    matrix.fr3.tier3 = false
    matrix.fr3.platformIntel = false
    matrix.fr3.socialL1 = false
    // fr3 仅 tencentPoi 为 true → 1 个
    const report = redundancyReport(matrix)
    expect(report.find((entry) => entry.group === 'fr3')).toMatchObject({ enabled: 1, total: 9, insufficient: true })
    expect(hasInsufficientRedundancy(matrix)).toBe(true)
    // 其余组不受影响
    expect(report.find((entry) => entry.group === 'fr5')?.insufficient).toBe(false)
  })

  it('全部渠道关闭的组 → insufficient 且计数为 0', () => {
    const matrix = allOn()
    for (const def of CHANNEL_FIELDS) matrix[def.group][def.id] = false
    const report = redundancyReport(matrix)
    expect(report.every((entry) => entry.insufficient && entry.enabled === 0)).toBe(true)
  })

  it('恰好 2 个启用渠道（cityDidi 开补位）→ 不警示', () => {
    const matrix = allOn()
    matrix.fr3 = { xhsMcp: true, xhsFallback: false, xhsCloak: false, douyin: true, tier2: false, tier3: false, tencentPoi: false, platformIntel: false }
    expect(redundancyReport(matrix).find((entry) => entry.group === 'fr3')?.insufficient).toBe(false)
  })
})