/**
 * W0 T1 契约与兼容读取（草稿 A/B/F：兴趣输入、版本门槛、正文追踪、天气地理归属）。
 *
 * 验收（T1 Acceptance）：
 * - legacy request（无 flowVersion）完整读写兼容；所有新字段可选
 * - validate 对非法枚举 / 超长 keywords / 超限 regionHints / 空 researchIntent.text 报错
 * - intake 三形态（显式 researchIntent / destination 映射种子 / 纯单点不强制）
 *   各命中预期 missing 与 assumptions
 * - settings 默认值（didaHotel off、三额度默认）且热读生效
 * - 类型 npm run typecheck 绿
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { FileSettingsProvider as FSP } from '@deepseek-ai/dsh-settings-file'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { makeKeyEnv } from '../src/adapters/env.js'
import {
  TRAVEL_CHANNELS_DEFAULT, TRAVEL_RESEARCH_DEFAULT, TRAVEL_SETTINGS_NS,
  travelSettingsSchema, type TravelSettings,
} from '../src/settings/schema.js'
import {
  CONTENT_STATUSES, RESEARCH_KEYWORDS_MAX, RESEARCH_KEYWORDS_MAX_CHARS,
  RESEARCH_REGION_HINTS_MAX, type ResearchIntent, type TravelRequest,
} from '../src/models/types.js'
import {
  assertValidIssues, validateAdvice, validateIntelItem, validateRequest, validateSlotsFields,
} from '../src/models/validate.js'
import { TravelValidationError } from '../src/errors.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-contract-qinggan-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function legacyRequest(planId = 'plan-legacy-1'): TravelRequest {
  return {
    planId,
    mode: 'plan',
    status: 'confirmed',
    slots: { destination: '西宁', dateStart: '2026-09-01', dateEnd: '2026-09-10', days: 10 },
    assumptions: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function fullSettings(): TravelSettings {
  return {
    channels: TRAVEL_CHANNELS_DEFAULT,
    keys: {},
    advanced: {
      socialDepth: 'L1', researchTimeoutMs: 180000, rateLimitPerDomain: 10, robotsToSCheck: true,
      routePrefix: '/travel-plans', defaultMapProvider: 'auto', amapSecurityMode: 'A',
      amapPoiBudgetPerPlan: 40, amapRestBudgetPerPlan: 60, profileTtlDays: 7,
      companionAutostart: false,
      companionServices: { rail12306: true, xhs: true, playwright: true, didi: true },
    },
    research: TRAVEL_RESEARCH_DEFAULT,
  }
}

// ────────────────────────── ① legacy 兼容读取 ──────────────────────────

describe('T1 legacy 兼容读取（草稿 F：flowVersion 缺失按 legacy）', () => {
  it('legacy request（无 flowVersion/researchIntent）validate 零 issue、store 完整往返', async () => {
    expect(validateRequest(legacyRequest())).toEqual([])
    await store.saveRequest(legacyRequest())
    const loaded = await store.loadRequest('plan-legacy-1')
    expect(loaded).toEqual(legacyRequest())
    expect(loaded?.flowVersion).toBeUndefined()
    expect(loaded?.slots.researchIntent).toBeUndefined()
  })

  it('新字段全部可选：含 flowVersion+researchIntent 的请求同样合法', async () => {
    const modern: TravelRequest = {
      ...legacyRequest('plan-modern-1'),
      flowVersion: 'qinggan-v1',
      slots: {
        ...legacyRequest().slots,
        researchIntent: { text: '青甘大环线 10 天自驾', keywords: ['青甘大环线', '敦煌'], regionHints: ['甘肃', '青海'] },
      },
    }
    expect(validateRequest(modern)).toEqual([])
    expect(validateRequest({ ...legacyRequest(), flowVersion: '' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'flowVersion' })]))
  })

  it('IntelItem 增 content 追踪字段、AdviceWeatherEntry 增 placeId/location：可选且校验', () => {
    const src = { platform: 'xhs-l0', url: 'https://example.invalid/n', fetchedAt: '2026-09-01T00:00:00.000Z' }
    const base = {
      id: 'i1', category: 'attraction', channel: 'xhs-l0', title: '莫高窟',
      summary: '5A，需预约', source: src, confidence: 'high',
    }
    // 无 content → 合法（legacy 条目）
    expect(validateIntelItem(base)).toEqual([])
    // content 追踪合法
    expect(validateIntelItem({
      ...base,
      content: { contentRef: 'i1', contentVersion: 'v1', contentStatus: 'extracted' },
    })).toEqual([])
    // 非法 contentStatus / truncated 无原因 → 报错
    expect(validateIntelItem({
      ...base,
      content: { contentRef: 'i1', contentVersion: 'v1', contentStatus: 'parsed' as never },
    })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'content.contentStatus' })]))
    expect(validateIntelItem({
      ...base,
      content: { contentRef: 'i1', contentVersion: 'v1', contentStatus: 'partial', truncated: true },
    })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'content.truncatedReason' })]))

    // advice 天气条目 placeId/location 可选
    expect(validateAdvice({
      weather: [{ date: '2026-09-02', source: src, placeId: 'pl-xining', location: '西宁' }],
      clothing: [], packingList: [], extraTips: [],
    })).toEqual([])
    expect(validateAdvice({
      weather: [{ date: '2026-09-02', source: src, placeId: '' }],
      clothing: [], packingList: [], extraTips: [],
    })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'weather[0].placeId' })]))
  })

  it('内容状态枚举与额度常量（草稿逐字：extracted|partial|unavailable|not_fetched / ≤6 / ≤20）', () => {
    expect(CONTENT_STATUSES).toEqual(['extracted', 'partial', 'unavailable', 'not_fetched'])
    expect(RESEARCH_KEYWORDS_MAX).toBe(6)
    expect(RESEARCH_KEYWORDS_MAX_CHARS).toBe(100)
    expect(RESEARCH_REGION_HINTS_MAX).toBe(20)
  })
})

// ────────────────────────── ② researchIntent 校验（草稿 A） ──────────────────────────

describe('T1 researchIntent 字段级校验（validateSlotsFields）', () => {
  it('researchIntent.text 必填非空：缺失/空白 → 确定性校验错误且不落盘', () => {
    expect(validateSlotsFields({ researchIntent: { text: '   ' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.text' })]))
    expect(validateSlotsFields({ researchIntent: { text: '' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.text' })]))
    expect(validateSlotsFields({ researchIntent: { text: '青甘大环线' } })).toEqual([])
  })

  it('keywords 超 6 条 / 单条超 100 字符 / 空串 → 报错', () => {
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(validateSlotsFields({ researchIntent: { text: 't', keywords: seven } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.keywords' })]))
    expect(validateSlotsFields({ researchIntent: { text: 't', keywords: ['x'.repeat(101)] } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.keywords[0]' })]))
    expect(validateSlotsFields({ researchIntent: { text: 't', keywords: ['   '] } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.keywords[0]' })]))
    expect(validateSlotsFields({ researchIntent: { text: 't', keywords: ['敦煌', '西宁'] } })).toEqual([])
  })

  it('regionHints 超 20 条 / 空串 → 报错；≤20 合法', () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => `r${i}`)
    expect(validateSlotsFields({ researchIntent: { text: 't', regionHints: twentyOne } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.regionHints' })]))
    expect(validateSlotsFields({ researchIntent: { text: 't', regionHints: ['' ] } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'slots.researchIntent.regionHints[0]' })]))
    expect(validateSlotsFields({ researchIntent: { text: 't', regionHints: ['甘肃', '青海'] } })).toEqual([])
  })

  it('assertValidIssues 对超限 keywords 抛 TravelValidationError', () => {
    expect(() => assertValidIssues(
      validateSlotsFields({ researchIntent: { text: 't', keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }),
    )).toThrow(TravelValidationError)
  })
})

// ────────────────────────── ③ intake 三形态 ──────────────────────────

describe('T1 intake 三形态（草稿 A：destination 可缺省 / 映射种子 / 单点不强制）', () => {
  it('形态一：plan 模式显式 researchIntent 时 destination 可缺省 → missing 空、不追问目的地', async () => {
    const intent: ResearchIntent = { text: '青甘大环线 10 天自驾', keywords: ['敦煌', '青甘大环线', '敦煌'], regionHints: ['甘肃', '青海'] }
    const result = await runIntake({
      slots: { researchIntent: intent, dateStart: '2026-09-01', dateEnd: '2026-09-10' },
    }, store)
    expect(result.status).toBe('confirmed')
    expect(result.missing).not.toContain('destination')
    expect(result.confirmedSlots.researchIntent?.text).toBe('青甘大环线 10 天自驾')
    // 关键词 trim 去重保序
    expect(result.confirmedSlots.researchIntent?.keywords).toEqual(['敦煌', '青甘大环线'])
    expect(result.confirmedSlots.researchIntent?.regionHints).toEqual(['甘肃', '青海'])
    expect(result.nextQuestions.some((q) => q.includes('目的地'))).toBe(false)
    const saved = await store.loadRequest(result.planId)
    expect(saved?.slots.destination).toBeUndefined()
    expect(saved?.slots.researchIntent?.keywords).toEqual(['敦煌', '青甘大环线'])
  })

  it('形态二：无 researchIntent 的 destination-only → 映射兼容兴趣种子并显式记录 assumption；新 plan 受串行门（flowVersion=1）', async () => {
    const result = await runIntake({
      slots: { destination: '敦煌', dateStart: '2026-09-01', dateEnd: '2026-09-05', days: 5 },
    }, store)
    expect(result.status).toBe('confirmed')
    expect(result.missing).toEqual([])
    expect(result.confirmedSlots.researchIntent?.text).toBe('敦煌')
    expect(result.assumptions.join('|')).toContain('映射为兼容兴趣种子')
    // F1c-E（决策 5）：destination-only 新 plan（mapped 种子）confirmed → 写 flowVersion='1'
    // 并记录「受串行门约束」——不再当 legacy 轻量单点，上游全文门/串行门据此生效
    expect(result.request.flowVersion).toBe('1')
    expect(result.assumptions.join('|')).toContain('受串行门约束')
    // destination 原样保留（不自动断言成城市，仅作地理提示/旧输入）
    expect(result.confirmedSlots.destination).toBe('敦煌')
    const saved = await store.loadRequest(result.planId)
    expect(saved?.slots.researchIntent?.text).toBe('敦煌')
    expect(saved?.flowVersion).toBe('1')
  })

  it('形态三：纯单点（只剩 destination、缺日期）不强制新字段，仍 legacy 读取', async () => {
    const result = await runIntake({ slots: { destination: '西宁' } }, store)
    // 缺日期 → collecting，missing 含日期但不含 destination
    expect(result.status).toBe('collecting')
    expect(result.missing).toEqual(['dateStart', 'dateEnd', 'days'])
    // 兴趣种子照常映射并记录
    expect(result.confirmedSlots.researchIntent?.text).toBe('西宁')
    expect(result.assumptions.join('|')).toContain('映射为兼容兴趣种子')
    // 不强制 flowVersion（legacy 单点不被套新信封）
    expect(result.request.flowVersion).toBeUndefined()
    expect(validateRequest(result.request)).toEqual([])
    // 旧计划（无新字段文件）可被直接读取
    await store.saveRequest(legacyRequest())
    expect((await store.loadRequest('plan-legacy-1'))?.slots.destination).toBe('西宁')
  })

  it('空 researchIntent.text 经 intake → 确定性校验错误且不落盘', async () => {
    const args = { slots: { researchIntent: { text: '' }, dateStart: '2026-09-01', dateEnd: '2026-09-10' } as never }
    await expect(runIntake(args as never, store)).rejects.toThrow(/researchIntent\.text/)
    expect(await store.findLatestPlan()).toBeUndefined()
  })
})

// ────────────────────────── ④ settings 默认与热读（草稿 9/17） ──────────────────────────

describe('T1 settings 契约：didaHotel off、研究额度默认、热读生效', () => {
  it('channel 矩阵默认：channels.fr3.didaHotel=false（其余不变）', () => {
    expect(TRAVEL_CHANNELS_DEFAULT.fr3.didaHotel).toBe(false)
    expect(TRAVEL_CHANNELS_DEFAULT.fr3.xhsMcp).toBe(true)
    expect(TRAVEL_CHANNELS_DEFAULT.fr4.cityDidi).toBe(false)
  })

  it('research.deep 三额度默认：16 / 40 / 100_000', () => {
    expect(TRAVEL_RESEARCH_DEFAULT.deep.maxRoundsPerPlan).toBe(16)
    expect(TRAVEL_RESEARCH_DEFAULT.deep.maxContentItemsPerPlan).toBe(40)
    expect(TRAVEL_RESEARCH_DEFAULT.deep.maxContentCharsPerItem).toBe(100_000)
  })

  it('schema 注册解析默认（文档缺失回落默认，与 settings-schema.test 同装配路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-travel-schema-qinggan-'))
    try {
      const path = join(dir, 'settings.json')
      writeFileSync(path, '{}')
      const ctx = new Context()
      const settings = new FSP(ctx, { path, watch: false })
      for await (const _phase of settings[Service.init]()) { /* 装载 */ }
      const resolved = settings.register(TRAVEL_SETTINGS_NS, travelSettingsSchema).get()
      expect(resolved.channels.fr3.didaHotel).toBe(false)
      expect(resolved.research.deep.maxRoundsPerPlan).toBe(16)
      expect(resolved.research.deep.maxContentItemsPerPlan).toBe(40)
      expect(resolved.research.deep.maxContentCharsPerItem).toBe(100_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('makeKeyEnv 热读：readSettings("research.deep.*") 返回当前快照字符串', () => {
    const env = makeKeyEnv({}, { settings: fullSettings() })
    expect(env.readSettings?.('research.deep.maxRoundsPerPlan')).toBe('16')
    expect(env.readSettings?.('research.deep.maxContentItemsPerPlan')).toBe('40')
    expect(env.readSettings?.('research.deep.maxContentCharsPerItem')).toBe('100000')
    // 未覆盖字段回落默认（热读跟随真实快照）
    const custom = makeKeyEnv({}, { settings: {
      ...fullSettings(),
      research: { deep: { ...TRAVEL_RESEARCH_DEFAULT.deep, maxRoundsPerPlan: 8 } },
    } })
    expect(custom.readSettings?.('research.deep.maxRoundsPerPlan')).toBe('8')
    expect(custom.readSettings?.('research.deep.maxContentItemsPerPlan')).toBe('40')
  })
})