/**
 * W1 DR2（T6）——指定条目正文获取、独立存档与分块读取验收：
 * - 指定原列表第 3 条可获取（不固定前 2 条）；
 * - 中文/emoji/长正文 >140 字符完整存储，固定版本分页可字节精确重组（无遗漏/重复）；
 * - 失败/截断/媒体未解析状态明确，其余条目保留；
 * - 删除页/登录限制/超时/过大正文/非法 contentRef/跨计划读取逐项独立拒绝或 partial+原因；
 * - 缓存不伪新（observedAt 回显）、固定 contentVersion 分页不串版本。
 * 全确定性 fixture 注入，零真实网络。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runResearchDestination } from '../src/tools/research-destination.js'
import {
  runFetchResearchContent, runReadResearchContent, createFetchBodyHandler, type ContentFetchResult,
} from '../src/tools/research-content.js'
import { runGetState } from '../src/tools/state.js'
import type { ResearchChannel } from '../src/orchestrator/types.js'
import type { CanonicalQuery } from '../src/adapters/base.js'
import type { IntelCategory, IntelItem, IntelChannel, ResearchState } from '../src/models/types.js'
import { SearchAdapter } from '../src/adapters/search.js'
import { TravelValidationError } from '../src/errors.js'

let root: string
let store: TravelStore
const FIX = join('tests', 'fixtures')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-content-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mkItem(id: string, title: string, category: IntelCategory = 'recommend'): IntelItem {
  return {
    id,
    category,
    channel: 'web' as IntelChannel,
    title,
    summary: `摘要 ${title}`,
    source: { platform: 'web', url: `https://example.invalid/item/${id}`, fetchedAt: '2026-09-01T00:00:00.000Z' },
    confidence: 'medium',
  }
}

function scriptedChannel(items: IntelItem[]): ResearchChannel {
  return {
    name: 'web',
    async available() {
      return true
    },
    async run(_query: CanonicalQuery) {
      return { ok: true, items }
    },
  }
}

async function makeIntelPlan(itemIds: string[]): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '西宁', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
  }, store)
  const planId = intake.planId
  const items = itemIds.map((id, i) => mkItem(id, `条目 ${i + 1}`))
  await runResearchDestination({ planId, keywords: ['西宁'], requestId: `r-${Date.now()}-${Math.random()}` }, store, {
    channels: [scriptedChannel(items)],
    retryDelaysMs: [],
  })
  return planId
}

function env(overrides: Record<string, string> = {}): { readSettings: (k: string) => string | undefined; env: Record<string, string> } {
  return { readSettings: (k) => overrides[k], env: overrides }
}

describe('DR2：指定第 3 条可获取（不固定前 2）+ 完整存档', () => {
  it('itemIds 含原列表第 3 条 → 正常获取，正文 >140 字符完整存档', async () => {
    const planId = await makeIntelPlan(['web:a', 'web:b', 'web:c'])
    const longBody = '青甘大环线攻略'.repeat(30) // >140 字符
    const fetchBody = async (item: IntelItem): Promise<ContentFetchResult> =>
      ({ ok: true, body: `${item.title}｜${longBody}｜中文正文🚀emoji` })
    const res = await runFetchResearchContent({ planId, itemIds: ['web:c'] }, store, { fetchBody, env: env() })

    expect(res.blocked).toBeUndefined()
    expect(res.items).toHaveLength(1)
    const receipt = res.items[0]
    expect(receipt.itemId).toBe('web:c')
    expect(receipt.ok).toBe(true)
    expect(receipt.contentVersion).toBeDefined()
    expect(receipt.contentStatus).toBe('extracted')
    expect(receipt.sourceUrl).toContain('web:c')

    // 完整正文可经固定版本读取并重组（字节精确、无遗漏）
    const artifact = await store.readResearchContent(planId, 'web:c', receipt.contentVersion!)
    expect(artifact).toBeDefined()
    const full = artifact as { body: string }
    const expected = `条目 3｜${longBody}｜中文正文🚀emoji`
    expect(full.body).toBe(expected)
    expect(expected.length).toBeGreaterThan(140)
  })
})

describe('DR2：分块读取字节精确重组（中文/emoji/长文，无遗漏重复）', () => {
  it('固定 contentVersion 分页 → 逐片段重组 == 原文', async () => {
    const planId = await makeIntelPlan(['web:long'])
    const body = '敦煌·莫高窟青甘大环线'.repeat(200) + '🚀🀄你好世界🧭'
    const fetchBody = async (): Promise<ContentFetchResult> => ({ ok: true, body })
    const f = await runFetchResearchContent({ planId, itemIds: ['web:long'] }, store, { fetchBody, env: env() })
    const version = f.items[0].contentVersion!

    // 固定版本分页读取，limit=1000
    const pieces: string[] = []
    let cursor: number | undefined
    let guard = 0
    for (;;) {
      const page = await runReadResearchContent({
        planId, contentRef: 'web:long', contentVersion: version, cursor: cursor ?? 0, limit: 1000,
      }, store)
      expect(page.contentVersion).toBe(version) // 固定版本不串
      pieces.push(page.fragment)
      cursor = page.nextCursor
      guard += 1
      expect(guard).toBeLessThan(50)
      if (cursor === undefined) break
    }

    expect(pieces.join('')).toBe(body) // 字节精确重组
    expect(pieces.join('').length).toBe(body.length)
  })
})

describe('DR2：失败状态逐项独立（其他条目保留）', () => {
  it('批量 3 条：删除页 + 登录限制 + 成功 → 各有独立回执，成功条目保留', async () => {
    const planId = await makeIntelPlan(['del:a', 'login:b', 'ok:c'])
    const fetchBody = async (item: IntelItem): Promise<ContentFetchResult> => {
      if (item.id === 'del:a') return { ok: false, code: 'UNAVAILABLE', reason: '页面已删除（404）' }
      if (item.id === 'login:b') return { ok: false, code: 'UNAVAILABLE', reason: '登录/验证码限制' }
      return { ok: true, body: '正常正文内容' }
    }
    const res = await runFetchResearchContent({ planId, itemIds: ['del:a', 'login:b', 'ok:c'] }, store, { fetchBody, env: env() })
    expect(res.items).toHaveLength(3)

    const del = res.items.find((i) => i.itemId === 'del:a')!
    expect(del.contentStatus).toBe('unavailable')
    expect(del.ok).toBe(false)
    expect(del.failureReason).toContain('删除')

    const login = res.items.find((i) => i.itemId === 'login:b')!
    expect(login.contentStatus).toBe('unavailable')
    expect(login.ok).toBe(false)
    expect(login.failureReason).toContain('登录')

    const ok = res.items.find((i) => i.itemId === 'ok:c')!
    expect(ok.ok).toBe(true)
    expect(ok.contentVersion).toBeDefined()
    const artifact = await store.readResearchContent(planId, 'ok:c', ok.contentVersion!)
    expect((artifact as { body: string }).body).toBe('正常正文内容')
  })

  it('超时 → unavailable 独立回执，成功条目保留', async () => {
    const planId = await makeIntelPlan(['tmo:a', 'ok:b'])
    const fetchBody = async (item: IntelItem): Promise<ContentFetchResult> =>
      item.id === 'tmo:a'
        ? { ok: false, code: 'TIMEOUT', reason: '抓取超时' }
        : { ok: true, body: 'b 正文' }
    const res = await runFetchResearchContent({ planId, itemIds: ['tmo:a', 'ok:b'] }, store, { fetchBody, env: env() })
    expect(res.items.find((i) => i.itemId === 'tmo:a')!.contentStatus).toBe('unavailable')
    expect(res.items.find((i) => i.itemId === 'ok:b')!.ok).toBe(true)
  })
})

describe('DR2：过大正文 → partial + truncated 原因（不标全文已获取）', () => {
  it('maxContentCharsPerItem 上限到达 → partial + truncatedReason，正文截断存档', async () => {
    const planId = await makeIntelPlan(['big:x'])
    const body = 'x'.repeat(10_000)
    const fetchBody = async (): Promise<ContentFetchResult> => ({ ok: true, body })
    // 注入小上限装配：强制触发截断（fixture 确定性，不改产品阈值）
    const e = env({ 'research.deep.maxContentCharsPerItem': '100' })
    const res = await runFetchResearchContent({ planId, itemIds: ['big:x'] }, store, { fetchBody, env: e })
    const receipt = res.items[0]
    expect(receipt.ok).toBe(true)
    expect(receipt.contentStatus).toBe('partial')
    expect(receipt.truncated).toBe(true)
    expect(receipt.truncatedReason).toBeTruthy()
    const artifact = await store.readResearchContent(planId, 'big:x', receipt.contentVersion!)
    const a = artifact as { body: string; contentStatus: string; truncated?: boolean }
    expect(a.body.length).toBe(100) // 截断存档
    expect(a.contentStatus).toBe('partial')
  })
})

describe('DR2：缓存不伪新（observedAt 回显）+ 跨计划/非法引用拒绝', () => {
  it('非 refresh 重复抓取 → 命中缓存，回显原 fetchedAt，不重复执行', async () => {
    const planId = await makeIntelPlan(['cache:z'])
    let calls = 0
    const fetchBody = async (): Promise<ContentFetchResult> => { calls += 1; return { ok: true, body: '缓存正文' } }
    const d = { fetchBody, env: env() }
    const f1 = await runFetchResearchContent({ planId, itemIds: ['cache:z'] }, store, d)
    const v1 = f1.items[0].contentVersion!
    const f2 = await runFetchResearchContent({ planId, itemIds: ['cache:z'] }, store, d)
    expect(calls).toBe(1) // 第二次命中缓存，零重复抓取
    expect(f2.items[0].contentVersion).toBe(v1)
    expect(f2.items[0].fetchedAt).toBe(f1.items[0].fetchedAt) // 回显原 observedAt
  })

  it('DR3：refresh 但正文 hash 未变 → 不推进 researchVersion，回显原 fetchedAt', async () => {
    const planId = await makeIntelPlan(['web:a'])
    let state = await store.loadResearchState<{ researchVersion: number }>(planId)
    expect(state!.researchVersion).toBe(1)
    const sameBody = async (): Promise<ContentFetchResult> => ({ ok: true, body: '正文 A' })
    const d = { fetchBody: sameBody, env: env() }
    const f1 = await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, d)
    const v1 = f1.items[0].contentVersion!
    state = await store.loadResearchState<{ researchVersion: number }>(planId)
    expect(state!.researchVersion).toBe(2)

    // 真变化检测（DR3）：refresh 且正文 contentHash 未变 → 版本不推进、回显原 fetchedAt
    const f2 = await runFetchResearchContent({ planId, itemIds: ['web:a'], refresh: true }, store, d)
    expect(f2.items[0].contentVersion).toBe(v1)
    expect(f2.items[0].fetchedAt).toBe(f1.items[0].fetchedAt)
    state = await store.loadResearchState<{ researchVersion: number }>(planId)
    expect(state!.researchVersion).toBe(2)

    // refresh 且正文变化 → contentHash 变 → 版本推进 + 新 fetchedAt
    const changed = { fetchBody: async (): Promise<ContentFetchResult> => ({ ok: true, body: '正文 B 更新' }), env: env() }
    const f3 = await runFetchResearchContent({ planId, itemIds: ['web:a'], refresh: true }, store, changed)
    expect(f3.items[0].contentVersion).not.toBe(v1)
    state = await store.loadResearchState<{ researchVersion: number }>(planId)
    expect(state!.researchVersion).toBe(3)
  })

  it('非法 contentRef（目录穿越）→ 拒绝，不接受任意本地路径', async () => {
    const planId = await makeIntelPlan(['ok:v'])
    await expect(
      runReadResearchContent({ planId, contentRef: '../evil', contentVersion: 'v1' }, store),
    ).rejects.toThrow(/非法 contentRef/)
  })

  it('fetch/read 锁前 planId 校验 → TravelValidationError 且不泄漏 query token', async () => {
    const unsafePlanId = 'bad?access_token=SYNTHETIC_PLAN_SECRET'
    const deps = { fetchBody: async (): Promise<ContentFetchResult> => ({ ok: true, body: '不会调用' }), env: env() }

    for (const operation of [
      () => runFetchResearchContent({ planId: unsafePlanId, itemIds: ['ok:v'] }, store, deps),
      () => runReadResearchContent({ planId: unsafePlanId, contentRef: 'ok:v', contentVersion: 'v1' }, store),
    ]) {
      try {
        await operation()
        expect.unreachable('非法 planId 应在获取计划锁前失败')
      } catch (error) {
        expect(error).toBeInstanceOf(TravelValidationError)
        expect(String(error)).not.toContain('SYNTHETIC_PLAN_SECRET')
        expect(JSON.stringify(error)).not.toContain('SYNTHETIC_PLAN_SECRET')
      }
    }
  })

  it('分页 publishedAt 兼容旧工件 → 脱敏后返回且不泄漏 token', async () => {
    const planId = await makeIntelPlan(['web:published-secret'])
    const secret = 'SYNTHETIC_PUBLISHED_SECRET'
    await store.writeResearchContent(planId, 'web:published-secret', 'v1', {
      contentRef: 'web:published-secret',
      contentVersion: 'v1',
      title: '旧正文',
      sourceUrl: 'https://example.invalid/published-secret',
      channel: 'web',
      contentStatus: 'extracted',
      publishedAt: `2026-09-01?access_token=${secret}`,
      fetchedAt: '2026-09-01T00:00:00.000Z',
      body: '旧正文内容',
      byteLength: 5,
    })
    const page = await runReadResearchContent({
      planId, contentRef: 'web:published-secret', contentVersion: 'v1',
    }, store)
    expect(JSON.stringify(page)).not.toContain(secret)
    expect(page.publishedAt).toContain('[REDACTED]')
  })

  it('跨计划读取 → 拒绝（只读本计划已保存正文）', async () => {
    const planA = await makeIntelPlan(['cross:1'])
    const f = await runFetchResearchContent(
      { planId: planA, itemIds: ['cross:1'] },
      store, { fetchBody: async () => ({ ok: true, body: 'A 正文' }), env: env() },
    )
    const version = f.items[0].contentVersion!
    // B 计划不存在该正文 → 明确拒绝
    const planB = await makeIntelPlan(['other'])
    await expect(
      runReadResearchContent({ planId: planB, contentRef: 'cross:1', contentVersion: version }, store),
    ).rejects.toThrow(/正文不存在/)
  })
})

// ────────────────────────── F1：fetchBody 内容类型闸门 ──────────────────────────

describe('F1/F4/T8：createFetchBodyHandler 生产抓取闭环', () => {
  const plausibleHtml = (withMeta = true) => `<!DOCTYPE html><html><head>${
    withMeta ? '<meta property="article:published_time" content="2026-08-15T10:00:00+08:00"/>' : ''
  }<title>青甘大环线</title></head><body><p>${'青甘大环线自驾攻略实测正文内容足够长。'.repeat(6)} 本文发布于 2026-08-15。</p></body></html>`
  const item = mkItem('web:gate', '青甘大环线', 'recommend') // source.url = https://example.invalid/item/web:gate

  it('fetch 层回传 content-type 非白名单 → UNAVAILABLE（content_type 原因）', async () => {
    const handler = createFetchBodyHandler(async () => ({
      status: 200, text: plausibleHtml(), contentType: 'application/octet-stream',
    }))
    const result = await handler(item)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('内容类型')
  })

  it('fetch 层回传白名单 content-type + 显式日期 → 提取出 publishedAt 与独立 dateEvidence', async () => {
    const handler = createFetchBodyHandler(async () => ({
      status: 200, text: plausibleHtml(true), contentType: 'text/html; charset=utf-8',
    }))
    const result = await handler(item)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body).toContain('青甘大环线')
      expect(result.publishedAt).toBe('2026-08-15') // 仅显式字段
      expect(Array.isArray(result.dateEvidence)).toBe(true)
      expect(result.dateEvidence!.some((e) => e.value === '2026-08-15')).toBe(true) // 正文 ISO 进候选
    }
  })

  it('无显式日期字段 → 无 publishedAt 但正文照常入库（缺日期不整条删除，T8 诚实）', async () => {
    const handler = createFetchBodyHandler(async () => ({
      status: 200, text: plausibleHtml(false), contentType: 'text/html; charset=utf-8',
    }))
    const result = await handler(item)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.publishedAt).toBeUndefined()
      expect(result.body.length).toBeGreaterThan(20)
    }
  })

  it('正文过短（结构噪音）→ EMPTY（四层去噪在生产路径生效）', async () => {
    const handler = createFetchBodyHandler(async () => ({
      status: 200, text: '<html><body><p>...</p></body></html>', contentType: 'text/html',
    }))
    const result = await handler(item)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EMPTY')
  })

  it('首 URL 未过安全门 → UNAVAILABLE（私网来源拒）', async () => {
    const privateItem = mkItem('web:priv', '内网', 'recommend')
    privateItem.source = { platform: 'web', url: 'http://169.254.169.254/latest', fetchedAt: '2026-09-01T00:00:00.000Z' }
    const handler = createFetchBodyHandler(async () => ({ status: 200, text: 'x', contentType: 'text/html' }))
    const result = await handler(privateItem)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('安全校验')
  })
})

describe('T15/T16：平台 SSR 路由与单条安全失败', () => {
  it('知乎/小红书 URL 优先走既有 SSR 适配器，未知 host 才走通用 extract', async () => {
    const fixtureByHost: Record<string, string> = {
      'zhuanlan.zhihu.com': 'zhihu-zhuanlan.html',
      'www.xiaohongshu.com': 'xhs-explore.html',
    }
    const ssrCalls: string[] = []
    const search = new SearchAdapter({
      hostSearch: async (query) => query === '644b887b0000000013012f14'
        ? { sources: [{ url: 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14?xsec_token=fixture-token' }], truncated: false }
        : { sources: [], truncated: false },
      fetchHtml: async (url) => {
        ssrCalls.push(url)
        const host = new URL(url).hostname
        return { status: 200, text: readFileSync(join(FIX, 'search', fixtureByHost[host]!), 'utf8') }
      },
    })
    const genericCalls: string[] = []
    const handler = createFetchBodyHandler(async (url) => {
      genericCalls.push(url)
      return { status: 200, text: '<html><body>不应走通用抓取</body></html>' }
    }, { search })
    const cases = [
      { url: 'https://zhuanlan.zhihu.com/p/670415069', id: 'web:zhihu' },
      { url: 'https://www.xiaohongshu.com/explore/644b887b0000000013012f14', id: 'web:xhs' },
    ]
    for (const entry of cases) {
      const result = await handler({ ...mkItem(entry.id, entry.id), source: { platform: 'web', url: entry.url, fetchedAt: '2026-09-01T00:00:00.000Z' } })
      expect(result.ok, entry.url).toBe(true)
      if (result.ok) expect(result.body.length).toBeGreaterThan(0)
    }
    expect(ssrCalls).toHaveLength(2)
    expect(genericCalls).toEqual([])

    const unknown = await handler({ ...mkItem('web:unknown', '未知'), source: { platform: 'web', url: 'https://example.com/a/b', fetchedAt: '2026-09-01T00:00:00.000Z' } })
    expect(unknown.ok).toBe(false) // 通用 fixture 是短噪音，证明路由可达而非伪造 SSR 成功
    expect(genericCalls).toEqual(['https://example.com/a/b'])
  })

  it('SSR 适配器失败逐条返回 failure，不回退为通用正文', async () => {
    let genericCalls = 0
    const search = new SearchAdapter({
      fetchHtml: async () => ({ status: 403, text: '<html>风控</html>' }),
    })
    const handler = createFetchBodyHandler(async () => {
      genericCalls += 1
      return { status: 200, text: '<html><body>伪成功正文足够长但不应使用</body></html>' }
    }, { search })
    const result = await handler({ ...mkItem('web:zhihu-fail', '知乎失败'), source: { platform: 'web', url: 'https://zhuanlan.zhihu.com/p/1', fetchedAt: '2026-09-01T00:00:00.000Z' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('403')
    expect(genericCalls).toBe(0)
  })

  it('fetchBody 裸异常只影响当前条目，同批其他成功仍保留', async () => {
    const planId = await makeIntelPlan(['web:throws', 'web:ok-throw'])
    const result = await runFetchResearchContent({ planId, itemIds: ['web:throws', 'web:ok-throw'] }, store, {
      fetchBody: async (item) => {
        if (item.id === 'web:throws') throw new Error('fixture timeout')
        return { ok: true, body: `正文 ${item.id}：${'内容'.repeat(80)}` }
      }, env: env(),
    })
    expect(result.items[0]).toMatchObject({ itemId: 'web:throws', ok: false, contentStatus: 'unavailable' })
    expect(result.items[1].ok).toBe(true)
  })

  it('正文 artifact 也脱敏链接 token，同时保持正文可读取', async () => {
    const planId = await makeIntelPlan(['web:body-secret'])
    const result = await runFetchResearchContent({ planId, itemIds: ['web:body-secret'] }, store, {
      fetchBody: async () => ({ ok: true, body: `攻略链接 https://example.com/a?xsec_token=BODY_SECRET_TOKEN&foo=1 ${'正文'.repeat(100)}` }), env: env(),
    })
    const version = result.items[0].contentVersion!
    const artifact = await store.readResearchContent<{ body: string }>(planId, 'web:body-secret', version)
    expect(artifact?.body).toContain('攻略链接')
    expect(artifact?.body).not.toContain('BODY_SECRET_TOKEN')
    expect(JSON.stringify(artifact)).not.toContain('BODY_SECRET_TOKEN')
  })

  it('P1：标题/摘要/URL/正文/截断日期证据/错误与 state 全链路不落 synthetic secret', async () => {
    const planId = await makeIntelPlan(['web:secret'])
    const secret = 'SYNTHETIC_SECRET'
    const rawUrl = `https://example.com/article?access_token=${secret}&foo=1`
    const rawItem = {
      ...mkItem('web:secret', `标题?refresh_token=${secret}`),
      summary: `摘要?%74oken=${secret}`,
      source: { platform: 'web', url: rawUrl, fetchedAt: '2026-09-01T00:00:00.000Z' },
    }
    await store.writeJson(planId, 'intel.json', [rawItem])
    const result = await runFetchResearchContent({ planId, itemIds: ['web:secret'] }, store, {
      fetchBody: async (): Promise<ContentFetchResult> => ({
        ok: true,
        body: `正文 https://example.com/body?credential=${secret}&keep=1`,
        truncated: true,
        truncatedReason: `截断原因 ?authorization=${secret}`,
        dateEvidence: [{ value: `候选 ?api_key=${secret}`, method: 'fixture', confidence: 'low' }],
      }),
      env: env(),
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    const receipt = result.items[0]!
    expect(receipt.title).not.toContain(secret)
    expect(receipt.sourceUrl).not.toContain(secret)
    expect(receipt.truncatedReason).not.toContain(secret)
    expect(JSON.stringify(receipt.dateEvidence)).not.toContain(secret)

    const artifact = await store.readResearchContent(planId, 'web:secret', receipt.contentVersion!)
    expect(JSON.stringify(artifact)).not.toContain(secret)
    expect((artifact as { body: string }).body).toContain('keep=1')
    const persistedIntel = await store.readJson<IntelItem[]>(planId, 'intel.json')
    expect(JSON.stringify(persistedIntel)).not.toContain(secret)
    const state = await store.loadResearchState(planId)
    expect(JSON.stringify(state)).not.toContain(secret)
    const view = await runGetState({ planId }, store)
    expect(JSON.stringify(view)).not.toContain(secret)

    const failed = await runFetchResearchContent({ planId, itemIds: ['web:secret'], refresh: true }, store, {
      fetchBody: async () => { throw new Error(`upstream failure ?secret=${secret}`) },
      env: env(),
    })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(JSON.stringify(await store.loadResearchState(planId))).not.toContain(secret)
  })

  it('恶意旧 research-state 重存 → itemIndex/fetchFailures/assessmentId 统一脱敏', async () => {
    const planId = await makeIntelPlan(['web:state-merge'])
    const secret = 'SYNTHETIC_OLD_STATE_SECRET'
    const initial = await store.loadResearchState<ResearchState>(planId)
    if (initial === undefined || initial.itemIndex[0] === undefined) throw new Error('fixture research-state 缺少 itemIndex')

    await store.saveResearchState(planId, {
      ...initial,
      itemIndex: [{
        ...initial.itemIndex[0],
        itemId: 'web:state-merge',
        title: `旧索引标题?access_token=${secret}`,
        roundId: `round-old?token=${secret}`,
        provenanceKey: `provenance?credential=${secret}`,
        contentRef: `web:state-merge?xsec_token=${secret}`,
        contentVersion: `v-old?api_key=${secret}`,
      }],
      fetchFailures: [{
        itemId: 'web:stale',
        code: 'UNAVAILABLE',
        reason: `旧失败原因?refresh_token=${secret}`,
        at: `2026-09-01T00:00:00.000Z?secret=${secret}`,
      }],
      assessment: {
        assessmentId: `assessment?access_token=${secret}`,
        status: 'continue',
        researchVersion: initial.researchVersion,
        recordedAt: `2026-09-01T00:00:00.000Z?token=${secret}`,
      },
    })

    const result = await runFetchResearchContent({ planId, itemIds: ['web:state-merge'] }, store, {
      fetchBody: async (): Promise<ContentFetchResult> => ({
        ok: false,
        code: 'UNAVAILABLE',
        reason: `新失败原因?access_token=${secret}`,
      }),
      env: env(),
    })
    expect(result.items[0]?.ok).toBe(false)

    const persisted = await store.loadResearchState<ResearchState>(planId)
    expect(JSON.stringify(persisted)).not.toContain(secret)
    expect(persisted?.itemIndex[0]?.title).toContain('[REDACTED]')
    expect(persisted?.itemIndex[0]?.contentRef).toContain('[REDACTED]')
    expect(persisted?.fetchFailures).toHaveLength(2)
    expect(persisted?.fetchFailures?.find((failure) => failure.itemId === 'web:stale')?.reason)
      .toContain('[REDACTED]')
    expect(persisted?.assessment?.assessmentId).toContain('[REDACTED]')
  })

  it('研究发现持久化同时脱敏 summary 与 source URL', async () => {
    const planId = (await runIntake({ slots: { destination: '西宁', dateStart: '2026-10-01', dateEnd: '2026-10-03', days: 3 } }, store)).planId
    const secret = 'SYNTHETIC_SECRET'
    const found: IntelItem = {
      ...mkItem('web:found-secret', `发现标题?access_token=${secret}`),
      summary: `发现摘要?refresh_token=${secret}`,
      source: { platform: 'web', url: `https://example.com/found?%74oken=${secret}`, fetchedAt: '2026-09-01T00:00:00.000Z' },
    }
    const result = await runResearchDestination({ planId, keywords: ['西宁'], requestId: 'secret-discovery' }, store, {
      channels: [scriptedChannel([found])], retryDelaysMs: [],
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(await store.readJson(planId, 'intel.json'))).not.toContain(secret)
    expect(JSON.stringify(await store.readResearchRound(planId, result.round!.roundId))).not.toContain(secret)
    expect(JSON.stringify(await store.loadResearchState(planId))).not.toContain(secret)
  })

  it('非法 research id 回执与失败索引均脱敏，不持久化 token', async () => {
    const planId = await makeIntelPlan(['web:ok-secret'])
    const unsafe = 'bad/id?xsec_token=SECRET_INVALID_ID&access_token=SYNTHETIC_SECRET&%74oken=SYNTHETIC_SECRET'
    const result = await runFetchResearchContent({ planId, itemIds: [unsafe] }, store, {
      fetchBody: async () => ({ ok: true, body: '不会调用' }), env: env(),
    })
    expect(JSON.stringify(result)).not.toContain('SECRET_INVALID_ID')
    const state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string; reason: string }> }>(planId)
    expect(JSON.stringify(state)).not.toContain('SECRET_INVALID_ID')
  })

  it('非法 research id 单条失败但同批安全条目仍能存档/分页读取', async () => {
    const planId = await makeIntelPlan(['bad/id', 'web:ok'])
    const result = await runFetchResearchContent({ planId, itemIds: ['bad/id', 'web:ok'] }, store, {
      fetchBody: async (item) => ({ ok: true, body: `正文 ${item.id}：${'内容'.repeat(80)}` }), env: env(),
    })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ itemId: 'bad/id', ok: false, contentStatus: 'unavailable' })
    expect(result.items[0].failureReason).toMatch(/非法|安全|路径/)
    expect(result.items[1].ok).toBe(true)
    const version = result.items[1].contentVersion!
    const page = await runReadResearchContent({ planId, contentRef: 'web:ok', contentVersion: version, limit: 20 }, store)
    expect(page.fragment).toContain('正文 web:ok')
    expect(page.integrity).toBe('ok')
  })
})

describe('DR2/DR3：非 2xx 不算成功 + 失败索引持久化 + 正文变化推进 researchVersion', () => {
  it('fetchBody 返回 HTTP 403 → 条目失败回执（不把风控页当正文）', async () => {
    const planId = await makeIntelPlan(['web:a'])
    // 直接经 handler 验证状态语义 + 经 runFetch 验证回执
    const handler = createFetchBodyHandler(async () => ({ status: 403, text: '<html>forbidden</html>', contentType: 'text/html' }))
    const out = await handler(mkItem('web:a', 'a'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('403')

    const res = await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, { fetchBody: handler, env: env() })
    expect(res.items[0].ok).toBe(false)
    expect(res.items[0].contentStatus).toBe('unavailable')
  })

  it('fetch 失败 → research-state.fetchFailures 持久化（幂等：同 itemId 覆盖保留最新原因）', async () => {
    const planId = await makeIntelPlan(['web:a'])
    const failBody = async (): Promise<ContentFetchResult> => ({ ok: false, code: 'UNAVAILABLE', reason: 'HTTP 403 风控' })
    await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, { fetchBody: failBody, env: env() })
    let state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string; reason: string }> }>(planId)
    expect(state?.fetchFailures).toHaveLength(1)
    expect(state?.fetchFailures![0]).toMatchObject({ itemId: 'web:a', reason: '抓取失败：HTTP 403 风控' })

    // 再次失败（不同原因）→ 同 itemId 覆盖，不重复累积
    await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, {
      fetchBody: async (): Promise<ContentFetchResult> => ({ ok: false, code: 'TIMEOUT', reason: '超时' }), env: env(),
    })
    state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string; reason: string }> }>(planId)
    expect(state?.fetchFailures).toHaveLength(1)
    expect(state?.fetchFailures![0].reason).toContain('超时')
  })

  it('DR2 恢复：同 itemId 重试成功 → 该失败记录从 fetchFailures 清除', async () => {
    const planId = await makeIntelPlan(['web:a'])
    const failBody = async (): Promise<ContentFetchResult> => ({ ok: false, code: 'UNAVAILABLE', reason: 'HTTP 403 风控' })
    await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, { fetchBody: failBody, env: env() })
    let state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string }>; researchVersion: number }>(planId)
    expect(state?.fetchFailures).toHaveLength(1)
    expect(state?.fetchFailures![0].itemId).toBe('web:a')

    // 重试成功（同 itemId）→ 失败记录清除（不留过期失败）
    const okBody = async (item: IntelItem): Promise<ContentFetchResult> => ({ ok: true, body: `正文 ${item.title}` })
    await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, { fetchBody: okBody, env: env() })
    state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string }>; researchVersion: number }>(planId)
    expect(state?.fetchFailures).toHaveLength(0)
    expect(state!.researchVersion).toBe(2) // 正文变化照常推进版本
  })

  it('fix-f1f #8：refresh 失败后同正文重试成功 → 旧失败清除（不依赖正文变化），researchVersion 不升、observedAt 回显原值', async () => {
    const planId = await makeIntelPlan(['web:samebody'])
    let failing = false
    const d = { fetchBody: async (): Promise<ContentFetchResult> =>
      failing ? { ok: false, code: 'UNAVAILABLE', reason: 'HTTP 500 临时故障' } : { ok: true, body: '正文 SAME' }, env: env() }
    // ① 首次抓取成功（正文 X 落档，版本 1→2）
    const f1 = await runFetchResearchContent({ planId, itemIds: ['web:samebody'] }, store, d)
    const v1 = f1.items[0].contentVersion!
    const fetchedAt1 = f1.items[0].fetchedAt!

    // ② refresh 抓取失败 → 失败索引持久化
    failing = true
    await runFetchResearchContent({ planId, itemIds: ['web:samebody'], refresh: true }, store, d)
    let state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string }>; researchVersion: number }>(planId)
    expect(state?.fetchFailures).toHaveLength(1)
    expect(state?.fetchFailures![0].itemId).toBe('web:samebody')

    // ③ refresh 重试成功但正文同 hash（无真变化）→ 旧失败必须清除、版本不升、回显原 observedAt
    failing = false
    const f3 = await runFetchResearchContent({ planId, itemIds: ['web:samebody'], refresh: true }, store, d)
    expect(f3.items[0].contentVersion).toBe(v1) // 同正文 → 幂等回显
    expect(f3.items[0].fetchedAt).toBe(fetchedAt1) // observedAt 回显原值
    state = await store.loadResearchState<{ fetchFailures?: Array<{ itemId: string }>; researchVersion: number }>(planId)
    expect(state!.researchVersion).toBe(2) // 正文未变 → 不升（DR3）
    expect(state?.fetchFailures).toHaveLength(0) // 旧失败清除（successIds 独立清索引，不依赖正文变化）
  })

  it('正文成功更新 → researchVersion+1，既有 sufficient 自动失效（stale 无复活）', async () => {
    const planId = await makeIntelPlan(['web:a'])
    const initial = await store.loadResearchState<{ researchVersion: number }>(planId)
    expect(initial!.researchVersion).toBe(1)
    // 记录 sufficient assessment（引用 v1）
    const { runRecordResearchAssessment } = await import('../src/tools/research-assessment.js')
    await runRecordResearchAssessment({ planId, expectedResearchVersion: 1, verdict: 'sufficient', rationale: 'v1 足够' }, store)
    // 抓取正文成功 → 版本前进
    const okBody = async (item: IntelItem): Promise<ContentFetchResult> => ({ ok: true, body: `正文 ${item.title}` })
    await runFetchResearchContent({ planId, itemIds: ['web:a'] }, store, { fetchBody: okBody, env: env() })
    const after = await store.loadResearchState<{ researchVersion: number }>(planId)
    expect(after!.researchVersion).toBe(2)
    // computeResearchStatus → stale_version（旧 sufficient 无复活路径）
    const { computeResearchStatus } = await import('../src/tools/research-assessment.js')
    const status = await computeResearchStatus(store, planId)
    expect(status.ready).toBe(false)
    expect(status.missing).toBe('stale_version')
  })
})
