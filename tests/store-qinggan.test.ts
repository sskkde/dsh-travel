/**
 * W0 T2 工件基座：注册 / 原子发布 / 版本旁车 / 迟到写拒绝 / 在途锁释放
 * （草稿 F：临时写入+元数据提交发布、hash/版本校验、失败元数据、锁三路径）。
 *
 * 验收（T2 Acceptance）：
 * - 新工件路径写读；`../`/绝对路径/非法 itemId → 拒绝
 * - 跨计划 contentRef 读取拒绝
 * - 迟到写（版本过期）拒绝且旧工件标 stale 不复活
 * - 并发写串行化无损坏；取消释放锁
 * - 中途写失败 → 无半发布状态（临时残留可清理）
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore, generatePlanId, stableStringify } from '../src/store/store.js'
import {
  ARTIFACT_NAMES, researchAssessmentFilePath, researchContentFilePath,
  researchRoundFilePath, RESEARCH_ASSESSMENTS_DIR, RESEARCH_CONTENT_DIR, RESEARCH_ROUNDS_DIR,
} from '../src/store/paths.js'
import { LateWriteError } from '../src/errors.js'

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-store-qinggan-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────── ① ARTIFACT_NAMES 注册与子布局路径 ──────────────────────────

describe('T2 工件注册与 research 子布局', () => {
  it('ARTIFACT_NAMES 扩展含新工件（research-state/places/route-transport/route-coverage/lodging-quotes/artifact-meta）', () => {
    expect(ARTIFACT_NAMES).toEqual(expect.arrayContaining([
      'intel.json', 'transport.json', 'advice.json', 'itinerary.json', 'page.html',
      'research-state.json', 'places.json', 'route-transport.json',
      'route-coverage.json', 'lodging-quotes.json', 'artifact-meta.json',
    ]))
  })

  it('research 子布局路径仅由插件生成（rounds/content/assessments 三目录）', () => {
    const planId = generatePlanId()
    expect(researchRoundFilePath(root, planId, 'round-1')).toBe(
      join(root, '.dsh-travel', planId, RESEARCH_ROUNDS_DIR, 'round-1.json'),
    )
    expect(researchContentFilePath(root, planId, 'tencent-poi:1629', 'v1')).toBe(
      join(root, '.dsh-travel', planId, RESEARCH_CONTENT_DIR, 'tencent-poi:1629', 'v1.json'),
    )
    expect(researchAssessmentFilePath(root, planId, 'asmt-1')).toBe(
      join(root, '.dsh-travel', planId, RESEARCH_ASSESSMENTS_DIR, 'asmt-1.json'),
    )
  })

  it('非法 roundId/itemId/contentVersion（../ / 绝对路径 / 分隔符）→ 拒绝', () => {
    const planId = generatePlanId()
    expect(() => researchRoundFilePath(root, planId, '../evil')).toThrow(/非法 roundId/)
    expect(() => researchRoundFilePath(root, planId, 'a/b')).toThrow(/非法 roundId/)
    expect(() => researchContentFilePath(root, planId, '/etc/passwd', 'v1')).toThrow(/非法 itemId/)
    expect(() => researchContentFilePath(root, planId, '..', 'v1')).toThrow(/非法 itemId/)
    expect(() => researchContentFilePath(root, planId, 'i1', '../v1')).toThrow(/非法 contentVersion/)
    expect(() => researchAssessmentFilePath(root, planId, 'a\\b')).toThrow(/非法 assessmentId/)
  })
})

// ────────────────────────── ② research 子工件写读与跨计划拒绝 ──────────────────────────

describe('T2 research 子工件写读（rounds/content/assessments）', () => {
  it('round/content/assessment 写读往返（内容逐字一致）', async () => {
    const planId = generatePlanId()
    await store.writeResearchRound(planId, 'round-1', { round: 1, queries: ['青甘大环线'] })
    await store.writeResearchContent(planId, 'item-1', 'v1', { text: '莫高窟正文…' })
    await store.writeResearchAssessment(planId, 'asmt-1', { verdict: 'continue' })

    expect(await store.readResearchRound(planId, 'round-1')).toEqual({ round: 1, queries: ['青甘大环线'] })
    expect(await store.readResearchContent(planId, 'item-1', 'v1')).toEqual({ text: '莫高窟正文…' })
    expect(await store.readResearchAssessment(planId, 'asmt-1')).toEqual({ verdict: 'continue' })

    // 落盘位置符合子布局
    const roundPath = researchRoundFilePath(root, planId, 'round-1')
    expect(JSON.parse(readFileSync(roundPath, 'utf8'))).toEqual({ round: 1, queries: ['青甘大环线'] })
  })

  it('NOISE/STALE degraded 机器码与 count 可持久化/读取', async () => {
    const planId = generatePlanId()
    await store.recordDegraded(planId, { source: 'web', code: 'NOISE', reason: 'title_signal:download', at: '2026-09-01T00:00:00.000Z', count: 2 })
    await store.recordDegraded(planId, { source: 'web', code: 'STALE', reason: '超过 5 年', at: '2026-09-01T00:00:00.000Z', count: 1 })
    await store.recordDegraded(planId, { source: 'web', code: 'NOISE', reason: 'title_signal:download', at: '2026-09-01T00:01:00.000Z', count: 3 })
    expect(await store.loadDegraded(planId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NOISE', count: 5 }),
      expect.objectContaining({ code: 'STALE', count: 1 }),
    ]))
  })

  it('跨计划 contentRef / 非法 itemId 读取拒绝（输入不直接拼任意路径）', async () => {
    const planA = generatePlanId()
    const planB = generatePlanId()
    await store.writeResearchContent(planA, 'item-1', 'v1', { text: 'A 计划正文' })

    // 合法同计划读
    expect(await store.readResearchContent(planA, 'item-1', 'v1')).toEqual({ text: 'A 计划正文' })
    // 跨计划：把另一计划的目录编码进 itemId → 拒绝（不落任何文件）
    await expect(store.readResearchContent(planB, `../${planA}/item-1`, 'v1')).rejects.toThrow(/非法 itemId/)
    await expect(store.readResearchRound(planB, '../../secret')).rejects.toThrow(/非法 roundId/)
    await expect(store.readJson(planB, '../secret.json')).rejects.toThrow(/非法 JSON 工件路径/)
    await expect(store.readJson('..', 'request.json')).rejects.toThrow(/非法 planId/)
    await expect(store.readResearchContent(planB, 'item-1', '../v1')).rejects.toThrow(/非法 contentVersion/)
    // 同计划但不存在 → undefined（不抛）
    expect(await store.readResearchContent(planA, 'ghost', 'v9')).toBeUndefined()
  })
})

// ────────────────────────── ③ 原子发布 + 版本旁车（artifact-meta） ──────────────────────────

describe('T2 多文件原子发布与 artifact-meta', () => {
  it('同 plan 三文件原子发布：hash 一致、读回状态 current、版本账本推进', async () => {
    const planId = generatePlanId()
    await store.publishArtifacts(planId, {
      stage: 'places',
      files: [
        { name: 'places.json', data: { status: 'ready', places: [{ placeId: 'p1' }] } },
        { name: 'route-coverage.json', data: { status: 'partial' } },
        { name: 'advice.json', data: { weather: [] } },
      ],
      bump: ['places'],
    })

    const places = await store.readArtifactWithState<{ status: string }>(planId, 'places.json')
    expect(places.status).toBe('current')
    expect(places.data?.status).toBe('ready')
    const coverage = await store.readArtifactWithState<{ status: string }>(planId, 'route-coverage.json')
    expect(coverage.status).toBe('current')
    expect(await store.currentVersion(planId, 'places')).toBe(1)
    // meta 落盘且 contentHash 覆盖三个文件
    const meta = await store.readJson<Record<string, unknown>>(planId, 'artifact-meta.json')
    expect(meta).toBeDefined()
    const hashes = (meta as { contentHash: Record<string, string> }).contentHash
    expect(Object.keys(hashes).sort()).toEqual(['advice.json', 'places.json', 'route-coverage.json'])
    // 元数据旁车字段（stage/status/generatedAt/upstreamVersions）
    expect((meta as { stage: string }).stage).toBe('places')
    expect((meta as { status: string }).status).toBe('success')
    expect((meta as { generatedAt: string }).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('失败/零结果也发布失败元数据（status failed/empty）且不复活旧成功', async () => {
    const planId = generatePlanId()
    // 先成功发布 intel v1
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }], bump: ['intel'],
    })
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('current')

    // 新版本研究失败 → 发布 failed 元数据（intel.json 仍留在磁盘但不得复活为成功）
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }],
      status: 'failed', failureReason: 'RESEARCH_TIMEOUT',
    })
    const afterFailed = await store.readArtifactWithState(planId, 'intel.json')
    expect(afterFailed.status).toBe('failed')
    expect(afterFailed.meta?.failureReason).toBe('RESEARCH_TIMEOUT')
    // 版本不因失败推进
    expect(await store.currentVersion(planId, 'intel')).toBe(1)

    // 零结果 → empty 元数据
    await store.publishArtifacts(planId, {
      stage: 'research', files: [], status: 'empty',
    })
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('empty')
    expect((await store.readArtifactWithState(planId, 'intel.json')).found).toBe(true)
  })

  it('读取校验 hash 失败 → 标 stale 不复活（外部篡改）', async () => {
    const planId = generatePlanId()
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1', title: 'original' }] }], bump: ['intel'],
    })
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('current')

    // 绕过发布直接改文件（模拟外部编辑/损坏）→ hash 不符 → stale
    writeFileSync(join(root, '.dsh-travel', planId, 'intel.json'), JSON.stringify([{ id: 'i1', title: 'tampered' }], null, 2))
    const read = await store.readArtifactWithState(planId, 'intel.json')
    expect(read.status).toBe('stale')
    expect(read.staleReason).toBe('hash_mismatch')
  })

  it('publish/read 共用稳定递归键序：键序/空白不致 stale，值改动仍 stale', async () => {
    const planId = generatePlanId()
    await store.publishArtifacts(planId, {
      stage: 'research',
      files: [{ name: 'intel.json', data: { z: { b: 2, a: 1 }, a: 3 } }],
    })
    const before = await store.readJson<{ contentHash: Record<string, string> }>(planId, 'artifact-meta.json')
    const firstHash = before!.contentHash['intel.json']

    // 外部仅重排键序/改变空白：读取端用同一稳定序列化，不应误报 stale。
    writeFileSync(join(root, '.dsh-travel', planId, 'intel.json'), JSON.stringify({ a: 3, z: { a: 1, b: 2 } }, null, 4))
    const reordered = await store.readArtifactWithState(planId, 'intel.json')
    expect(reordered.status).toBe('current')
    expect(firstHash).toBe(before!.contentHash['intel.json'])

    // 任一值改变仍必须触发 hash 防篡改门。
    writeFileSync(join(root, '.dsh-travel', planId, 'intel.json'), JSON.stringify({ a: 4, z: { a: 1, b: 2 } }))
    const changed = await store.readArtifactWithState(planId, 'intel.json')
    expect(changed.status).toBe('stale')
    expect(changed.staleReason).toBe('hash_mismatch')
  })

  it('稳定 hash 覆盖 JSON 的 __proto__ 自有键，篡改仍 stale', async () => {
    const planId = generatePlanId()
    const data = JSON.parse('{"__proto__":{"value":1},"safe":2}') as Record<string, unknown>
    await store.publishArtifacts(planId, { stage: 'research', files: [{ name: 'intel.json', data }] })
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('current')
    writeFileSync(join(root, '.dsh-travel', planId, 'intel.json'), '{"__proto__":{"value":2},"safe":2}')
    expect((await store.readArtifactWithState(planId, 'intel.json')).status).toBe('stale')
  })

  it('旧 JSON hash 旁车首次读取自动迁移为 stable hash，仍保留值篡改保护', async () => {
    const planId = generatePlanId()
    const data = { z: { b: 2, a: 1 }, a: 3 }
    await store.writeJson(planId, 'intel.json', data)
    const legacyHash = createHash('sha256').update(JSON.stringify(data, null, 2)).digest('hex')
    await store.writeJson(planId, 'artifact-meta.json', {
      stage: 'research', inputFingerprint: 'legacy', upstreamVersions: {},
      contentHash: { 'intel.json': legacyHash }, status: 'success', generatedAt: '2026-09-01T00:00:00.000Z',
    })
    const current = await store.readArtifactWithState(planId, 'intel.json')
    expect(current.status).toBe('current')
    const migrated = await store.readJson<{ contentHash: Record<string, string> }>(planId, 'artifact-meta.json')
    expect(migrated!.contentHash['intel.json']).toBe(createHash('sha256').update(stableStringify(data)).digest('hex'))
  })

  it('legacy 无 envelope 工件读取兼容（旧文件不强制 artifact-meta）', async () => {
    const planId = generatePlanId()
    await store.writeJson(planId, 'intel.json', [{ id: 'legacy-1' }])
    const read = await store.readArtifactWithState(planId, 'intel.json')
    expect(read.status).toBe('current')
    expect(read.data).toEqual([{ id: 'legacy-1' }])
    expect(read.meta).toBeUndefined()
  })

  it('中途写失败 → 无半发布状态（meta 不落、tmp 清理、旧数据保持）', async () => {
    const planId = generatePlanId()
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }], bump: ['intel'],
    })
    const before = await store.readJson<unknown>(planId, 'intel.json')

    // 第三个文件含循环引用 → JSON.stringify 抛错 → 整批不发布
    const circular: Record<string, unknown> = { self: null as unknown as Record<string, unknown> }
    circular.self = circular
    await expect(store.publishArtifacts(planId, {
      stage: 'research',
      files: [
        { name: 'research-state.json', data: { ok: true } },
        { name: 'places.json', data: circular },
      ],
      bump: ['research'],
    })).rejects.toThrow()

    // 无半发布：meta 未更新、新文件未落、旧数据未动
    const meta = await store.readJson<unknown>(planId, 'artifact-meta.json')
    expect((meta as { status: string }).status).toBe('success')
    expect(await store.readJson<unknown>(planId, 'places.json')).toBeUndefined()
    expect(await store.readJson<unknown>(planId, 'intel.json')).toEqual(before)
    // 临时残留可清理：目录内无 .tmp- 文件
    const planDir = join(root, '.dsh-travel', planId)
    const names = readFileNames(planDir)
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false)
  })
})

function readFileNames(dir: string): string[] {
  return readdirSync(dir)
}

/** 从并发 round 的 payload 取 round 号（写入方保证 payload 以 round=n 开头）。 */
function parseRound(payload: string | undefined): number {
  const m = /^round=(\d+)/.exec(payload ?? '')
  return m ? Number(m[1]) : 0
}

// ────────────────────────── ④ 版本复核：迟到写拒绝 ──────────────────────────

describe('T2 提交前上游版本复核（迟到写拒绝）', () => {
  it('expectedIntelVersion 过期（当前 2 期望 1）→ LateWriteError(reasonCode=stale_version)，不落任何文件', async () => {
    const planId = generatePlanId()
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }], bump: ['intel'],
    })
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i2' }] }], bump: ['intel'],
    })
    expect(await store.currentVersion(planId, 'intel')).toBe(2)

    // 迟到写：期望 intel=1（已过期的快照）→ 拒绝
    await expect(store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'late' }] }],
      expectedVersions: { intel: 1 },
    })).rejects.toThrow(LateWriteError)
    try {
      await store.publishArtifacts(planId, {
        stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'late' }] }],
        expectedVersions: { intel: 1 },
      })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).name).toBe('LateWriteError')
      expect((error as { reasonCode?: string }).reasonCode).toBe('stale_version')
    }
    // 拒绝后磁盘不变（仍是 v2 数据），且不产生迟到写记录
    const read = await store.readArtifactWithState<{ id: string }[]>(planId, 'intel.json')
    expect(read.data?.[0].id).toBe('i2')
    expect(read.status).toBe('current')
  })

  it('期望版本与当前一致 → 放行（幂等复查）', async () => {
    const planId = generatePlanId()
    await store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1' }] }], bump: ['intel'],
    })
    await expect(store.publishArtifacts(planId, {
      stage: 'research', files: [{ name: 'intel.json', data: [{ id: 'i1-again' }] }],
      expectedVersions: { intel: 1 }, bump: ['intel'],
    })).resolves.toBeTruthy()
    expect(await store.currentVersion(planId, 'intel')).toBe(2)
  })
})

// ────────────────────────── ⑤ 并发串行化 + 在途锁释放 ──────────────────────────

describe('T2 计划级在途锁：并发串行化 / 取消释放', () => {
  it('并发 publish 串行化无损坏（meta 与磁盘一致、无 tmp 残留、版本不丢）', async () => {
    const planId = generatePlanId()
    const jobs = [1, 2, 3, 4, 5].map((n) => store.publishArtifacts(planId, {
      stage: 'concurrent',
      files: [{ name: 'research-state.json', data: { round: n, payload: `round=${n}${'x'.repeat(2000)}` } }],
      bump: ['research'],
    }))
    await Promise.all(jobs)
    // 五个版本全部记账（无覆盖丢版本）
    expect(await store.currentVersion(planId, 'research')).toBe(5)
    const meta = await store.readJson<{ contentHash: Record<string, string> }>(planId, 'artifact-meta.json')
    const read = await store.readArtifactWithState<{ round: number; payload: string }>(planId, 'research-state.json')
    expect(read.status).toBe('current')
    // 最新 round 值与 hash 自洽（最后一次提交完整可见，无撕裂）
    const finalRound = parseRound(read.data?.payload)
    expect(meta).toBeDefined()
    expect(meta!.contentHash['research-state.json']).toBeDefined()
    expect(read.data?.round).toBe(5)
    expect(finalRound).toBe(5)
    expect(read.data?.round).toBe(finalRound)
    // 无 tmp 残留
    const planDir = join(root, '.dsh-travel', planId)
    expect(readFileNames(planDir).some((n) => n.includes('.tmp-'))).toBe(false)
  })

  it('取消释放锁：acquire → 检查占用 → 取消路径 release → 锁可复用', async () => {
    const planId = generatePlanId()
    expect(store.isPlanLocked(planId)).toBe(false)
    const release = await store.acquirePlanLock(planId)
    expect(store.isPlanLocked(planId)).toBe(true)
    release() // 取消/释放路径
    expect(store.isPlanLocked(planId)).toBe(false)
    // 释放后可再次获取（复用）
    const release2 = await store.acquirePlanLock(planId)
    expect(store.isPlanLocked(planId)).toBe(true)
    release2()
    expect(store.isPlanLocked(planId)).toBe(false)
  })

  it('withPlanLock 在成功与失败两条路径均释放锁', async () => {
    const planId = generatePlanId()
    await store.withPlanLock(planId, async () => {
      expect(store.isPlanLocked(planId)).toBe(true)
      return 'ok'
    })
    expect(store.isPlanLocked(planId)).toBe(false)
    await expect(store.withPlanLock(planId, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(store.isPlanLocked(planId)).toBe(false)
  })

  it('排队等待者按序接替（第二个 acquire 等待第一个 release）', async () => {
    const planId = generatePlanId()
    const order: string[] = []
    const release1 = await store.acquirePlanLock(planId)
    const p2 = store.acquirePlanLock(planId).then((release2) => {
      order.push('acquired2')
      release2()
    })
    order.push('before-release1')
    release1()
    await p2
    expect(order).toEqual(['before-release1', 'acquired2'])
    expect(store.isPlanLocked(planId)).toBe(false)
  })

  it('同一异步链重入 withPlanLock / publishArtifacts 不自我死锁（C 期工具层接线）', async () => {
    const planId = generatePlanId()
    // 工具层 withPlanLock 内嵌 publishArtifacts（其内部也取计划锁）→ 重入放行
    await store.withPlanLock(planId, async () => {
      await store.publishArtifacts(planId, {
        stage: 'reentrant',
        files: [{ name: 'reentrant.json', data: { ok: true } }],
        bump: ['research'],
      })
      // 再嵌套一层 withPlanLock 同样放行（同一异步链）
      await store.withPlanLock(planId, async () => {
        await store.writeJson(planId, 'nested.json', { ok: true })
      })
    })
    expect(store.isPlanLocked(planId)).toBe(false)
    expect(await store.readJson<unknown>(planId, 'reentrant.json')).toEqual({ ok: true })
    expect(await store.readJson<unknown>(planId, 'nested.json')).toEqual({ ok: true })
  })
})