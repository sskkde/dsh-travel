/**
 * TravelStore：`.dsh-travel/<planId>/` 工作区读写（ADR-6 / §5.4）。
 *
 * - request.json 落盘前过 validateRequest 契约闸门（防脏数据入库）
 * - 原子写：同目录 tmp + rename（跨进程并发读不撕裂）
 * - 读取不存在 → undefined（不抛异常；「not found」由工具层结构化返回）
 *
 * W0 T2（草稿 F）叠加：
 * - 多文件原子发布：临时写入全部产物 + 末尾 artifact-meta（contentHash/
 *   upstreamVersions/status/generatedAt）提交；读取校验 hash/版本，失败标 stale
 *   不复活旧数据；失败/零结果也发布失败元数据（不把失败当成功）
 * - 计划级在途锁（acquirePlanLock/withPlanLock）：成功/失败/取消三路径均释放；
 *   并发写经锁串行化
 * - 提交前上游版本复核（expectedVersions vs 计划级版本账本）：不符 → 迟到写
 *   拒绝（LateWriteError reasonCode='stale_version'）
 * - research 子工件（research-rounds/content/assessments）写读：id 过
 *   assertSafeResearchId 安全校验（跨计划/目录穿越拒绝）
 */
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TravelRequest } from '../models/types.js'
import { assertValidIssues, validateRequest } from '../models/validate.js'
import type { DegradedEntry } from '../adapters/base.js'
import { LateWriteError } from '../errors.js'
import {
  ARTIFACT_NAMES, DEGRADED_FILE, REQUEST_FILE,
  assertSafePlanId, assertSafeResearchId,
  planDirectory, planFilePath, travelDirectory,
} from './paths.js'

/** 计划级版本账本键（草稿 F：intel/research/places/transport/advice/quotes/rental/cost）。 */
export const ARTIFACT_VERSION_KEYS = [
  'intel', 'research', 'places', 'transport', 'advice', 'quotes', 'rental', 'cost',
] as const
export type ArtifactVersionKey = (typeof ARTIFACT_VERSION_KEYS)[number]

/** artifact-meta 发布状态：success=正常提交；empty=零结果；failed=失败（均如实落旁车）。 */
export type ArtifactPublishStatus = 'success' | 'empty' | 'failed'

/** 每个工件的 manifest 条目；旧 contentHash 旁车仍保留以兼容已有消费者。 */
export interface ArtifactManifestEntry {
  name: string
  hash: string
  /** hash 的显式别名，便于人工/工具读取。 */
  contentHash: string
  commitId: string
  releaseVersion: number
  stage: string
  inputFingerprint: string
  upstreamVersions: Record<string, number>
  status: ArtifactPublishStatus
  generatedAt: string
}

/**
 * artifact-meta.json 旁车（round3 manifest）。
 * schemaVersion/commitId/artifacts/versions/releaseVersion 为新发布字段，全部
 * optional 仅为读取既有草稿 F meta；带这些字段的文件按 manifest 语义处理。
 */
export interface ArtifactMeta {
  schemaVersion?: number
  commitId?: string
  releaseVersion?: number
  /** 发布阶段（如 'research' / 'places' / 'transport'）。 */
  stage: string
  /** 研究输入指纹（操作方计算；缺省 'manual'）。 */
  inputFingerprint: string
  /** 上游版本（本次发布消费的 inputs 版本，提交前已复核）。 */
  upstreamVersions: Record<string, number>
  /** 兼容字段：各工件最近一次 hash；manifest 也保留它。 */
  contentHash: Record<string, string>
  /** round3 每个工件的独立发布记录（旧 meta 缺省）。 */
  artifacts?: Record<string, ArtifactManifestEntry>
  /** round3 提交后完整版本快照（旧 meta 缺省）。 */
  versions?: Record<string, number>
  status: ArtifactPublishStatus
  /** ISO8601。 */
  generatedAt: string
  /** status=failed 时的失败原因。 */
  failureReason?: string
}

/** 新版 manifest 的完整类型（artifact-meta.json 的写入形态）。 */
export interface ArtifactManifest extends ArtifactMeta {
  schemaVersion: number
  commitId: string
  releaseVersion: number
  artifacts: Record<string, ArtifactManifestEntry>
  versions: Record<string, number>
}

/** 带状态的工件读取结果（unknown=未入账/未知版本，只能只读解释）。 */
export interface ArtifactReadState<T> {
  found: boolean
  status: 'current' | 'stale' | 'unknown' | 'missing' | 'failed' | 'empty'
  data?: T
  meta?: ArtifactMeta
  /** stale/unknown 的具体原因。 */
  staleReason?: 'hash_mismatch' | 'not_in_commit' | 'unaccounted' | 'unknown_version' | 'dependency_version'
  compatibility?: 'current' | 'legacy' | 'unknown'
}

/** 原子发布选项。 */
export interface PublishArtifactsOptions {
  stage: string
  files: Array<{ name: string; data: unknown }>
  /** 缺省 success；empty=零结果、failed=失败（均如实落旁车，不冒充成功）。 */
  status?: ArtifactPublishStatus
  failureReason?: string
  /** 提交前上游版本复核：期望版本 ≠ 当前 → LateWriteError 迟到写拒绝。 */
  expectedVersions?: Partial<Record<ArtifactVersionKey, number>>
  /** status=success 时推进的版本键（本轮产物对应的 stage）。 */
  bump?: ArtifactVersionKey[]
  /** 研究输入指纹（缺省 'manual'）。 */
  inputFingerprint?: string
}

export const VERSIONS_FILE = 'versions.json'
export const ARTIFACT_MANIFEST_FILE = 'artifact-meta.json'
/** 兼容旧命名；新代码优先使用 ARTIFACT_MANIFEST_FILE。 */
export const ARTIFACT_META_FILE = ARTIFACT_MANIFEST_FILE

export interface TravelStoreOptions {
  /** 仅用于故障注入/平台适配；默认使用 node:fs/promises.rename。 */
  rename?: (from: string, to: string) => Promise<void>
}

const CURRENT_MANIFEST_SCHEMA_VERSION = 2

/** 工件路径安全校验（publish 支持固定 research 子目录及根级工件）。 */
function assertSafeArtifactName(name: string): void {
  const segments = typeof name === 'string' ? name.split('/') : []
  const unsafeSegment = segments.some((segment) => segment.length === 0 || segment.includes('..'))
  const rootFile = /^[A-Za-z0-9._-]+\.json$/.test(name)
  const roundOrAssessment = /^(?:research-rounds|research-assessments)\/[A-Za-z0-9._:+-]+\.json$/.test(name)
  const contentFile = /^research-content\/[A-Za-z0-9._:+-]+\/[A-Za-z0-9._:+-]+\.json$/.test(name)
  if (unsafeSegment || name.includes('\\') || (!rootFile && !roundOrAssessment && !contentFile)) {
    throw new Error(`非法工件路径（仅允许根级 .json 或 research 子工件，禁止穿越）：${JSON.stringify(name)}`)
  }
  if (name === ARTIFACT_MANIFEST_FILE || name === VERSIONS_FILE) {
    throw new Error(`工件文件名保留给 manifest 提交：${JSON.stringify(name)}`)
  }
}

function isModernManifest(meta: ArtifactMeta | undefined): meta is ArtifactManifest {
  return meta !== undefined
    && meta.schemaVersion === CURRENT_MANIFEST_SCHEMA_VERSION
    && typeof meta.commitId === 'string'
    && Number.isSafeInteger(meta.releaseVersion)
    && meta.artifacts !== undefined
    && meta.versions !== undefined
}

/** 将 legacy contentHash 视为历史条目，但不把它误认为本次 manifest 提交。 */
function legacyManifestEntries(meta: ArtifactMeta | undefined): Record<string, ArtifactManifestEntry> {
  if (meta?.artifacts !== undefined) return { ...meta.artifacts }
  const entries: Record<string, ArtifactManifestEntry> = {}
  for (const [name, hash] of Object.entries(meta?.contentHash ?? {})) {
    entries[name] = {
      name,
      hash,
      contentHash: hash,
      commitId: meta?.commitId ?? 'legacy',
      releaseVersion: meta?.releaseVersion ?? 0,
      stage: meta?.stage ?? 'legacy',
      inputFingerprint: meta?.inputFingerprint ?? 'legacy',
      upstreamVersions: { ...(meta?.upstreamVersions ?? {}) },
      status: meta?.status ?? 'success',
      generatedAt: meta?.generatedAt ?? new Date(0).toISOString(),
    }
  }
  return entries
}

function assertValidVersionKey(key: string): asserts key is ArtifactVersionKey {
  if (!(ARTIFACT_VERSION_KEYS as readonly string[]).includes(key)) throw new Error(`未知工件版本键：${key}`)
}

/** 通用 JSON 读写允许研究子目录，但拒绝绝对路径、反斜杠与目录穿越。 */
function assertSafeJsonName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('/')
    || name.includes('\\\\') || name.includes('..')
    || !/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new Error(`非法 JSON 工件路径：${JSON.stringify(name)}`)
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 递归稳定 JSON：publish 与 read hash 必须共享同一键序语义。 */
export function stableStringify(data: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry))
    if (typeof value !== 'object' || value === null) return value
    const record = value as Record<string, unknown>
    // null prototype preserves an own `__proto__` key instead of invoking the
    // Object.prototype setter; artifact hashes must cover every JSON key.
    const ordered: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(record).sort()) ordered[key] = normalize(record[key])
    return ordered
  }
  return JSON.stringify(normalize(data), null, 2)
}

function serialize(data: unknown): string {
  return stableStringify(data)
}

/** 兼容稳定 hash 引入前的旧旁车：仅用于一次性迁移未被篡改的旧文件。 */
function legacySerialize(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

/** 生成新计划 ID（plan-<uuid>；路径安全，跨修订复用）。 */
export function generatePlanId(): string {
  return `plan-${randomUUID()}`
}

function isDegradedEntry(value: unknown): value is DegradedEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return typeof e.source === 'string' && typeof e.reason === 'string'
    && (e.code === 'UNAVAILABLE' || e.code === 'EMPTY' || e.code === 'TIMEOUT' || e.code === 'NOISE' || e.code === 'STALE')
    && (e.candidateId === undefined || typeof e.candidateId === 'string')
    && (e.placeId === undefined || typeof e.placeId === 'string')
    && (e.count === undefined || (typeof e.count === 'number' && Number.isInteger(e.count) && e.count > 0))
}

export class TravelStore {
  private readonly renameFile: (from: string, to: string) => Promise<void>

  /** 构造：root = 工作区根（见 resolveTravelRoot）。 */
  constructor(readonly root: string, options: TravelStoreOptions = {}) {
    this.renameFile = options.rename ?? rename
  }

  planDir(planId: string): string {
    return planDirectory(this.root, planId)
  }

  async filePath(planId: string, name: string): Promise<string> {
    assertSafePlanId(planId)
    assertSafeJsonName(name)
    return planFilePath(this.root, planId, name)
  }

  /** 读取 request.json；缺失 → undefined。 */
  async loadRequest(planId: string): Promise<TravelRequest | undefined> {
    const raw = await this.readJson<unknown>(planId, REQUEST_FILE)
    if (raw === undefined) return undefined
    const issues = validateRequest(raw)
    if (issues.length > 0) {
      // 落盘契约被破坏（外部编辑/旧版本）——预留给恢复流程；当前按无效返回
      return undefined
    }
    return raw as TravelRequest
  }

  /** 写 request.json（validateRequest 闸门；失败抛 TravelValidationError）。 */
  async saveRequest(request: TravelRequest): Promise<void> {
    assertValidIssues(validateRequest(request))
    await this.writeJson(request.planId, REQUEST_FILE, request)
  }

  /** 通用 JSON 产物读写（W2a+ 的 intel/transport/advice/itinerary.json）。 */
  async readJson<T>(planId: string, name: string): Promise<T | undefined> {
    assertSafePlanId(planId)
    assertSafeJsonName(name)
    const path = join(this.planDir(planId), name)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return JSON.parse(text) as T
  }

  async writeJson(planId: string, name: string, data: unknown): Promise<void> {
    assertSafePlanId(planId)
    assertSafeJsonName(name)
    const dir = this.planDir(planId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, path)
  }

  /** 计划目录内产物清单（request.json + 已知 artifacts，排序）。 */
  async listArtifacts(planId: string): Promise<string[]> {
    assertSafePlanId(planId)
    const dir = this.planDir(planId)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => name === REQUEST_FILE || (ARTIFACT_NAMES as readonly string[]).includes(name))
      .sort()
  }

  /** 读取降级记账（degraded.json；W2a+ 由 research 工具写入，get_state 汇总）。 */
  async loadDegraded(planId: string): Promise<DegradedEntry[] | undefined> {
    const raw = await this.readJson<unknown>(planId, DEGRADED_FILE)
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) return undefined
    const entries = raw.filter(isDegradedEntry)
    return entries.length > 0 ? entries : undefined
  }

  /** 追加降级记账；同源同码同原因合并并累计 count，避免跨轮丢失聚合数量。 */
  async recordDegraded(planId: string, entry: DegradedEntry): Promise<void> {
    const existing = (await this.loadDegraded(planId)) ?? []
    const index = existing.findIndex(
      (e) => e.source === entry.source && e.code === entry.code && e.reason === entry.reason,
    )
    if (index < 0) {
      await this.writeJson(planId, DEGRADED_FILE, [...existing, entry])
      return
    }
    const previous = existing[index]
    // 保留旧的无 count 记账幂等语义；只有聚合计数显式出现时才累计。
    if (previous.count === undefined && entry.count === undefined) return
    const count = (previous.count ?? 1) + (entry.count ?? 1)
    const merged: DegradedEntry = {
      ...previous,
      at: entry.at,
      ...(count > 1 ? { count } : {}),
    }
    const next = existing.slice()
    next[index] = merged
    await this.writeJson(planId, DEGRADED_FILE, next)
  }

  /** 最近更新计划（get_state 无 planId 时的兜底定位）。 */
  async findLatestPlan(): Promise<{ planId: string; updatedAt: string } | undefined> {
    const travelDir = travelDirectory(this.root)
    let entries
    try {
      entries = await readdir(travelDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const plans = entries
      .filter((e) => e.isDirectory() && /^[A-Za-z0-9._-]+$/.test(e.name))
      .map((e) => e.name)
    let latest: { planId: string; updatedAt: string } | undefined
    for (const planId of plans) {
      const req = await this.loadRequest(planId)
      if (req === undefined) continue
      if (latest === undefined || req.updatedAt > latest.updatedAt) {
        latest = { planId, updatedAt: req.updatedAt }
      }
    }
    return latest
  }

  // ────────────────────────── W0 T2 计划级在途锁 ──────────────────────────

  private readonly locks = new Map<string, { locked: boolean; waiters: Array<() => void> }>()

  /**
   * 当前异步链已持有的计划锁（重入判定）。publishArtifacts 内部也会取锁，
   * 若外层 withPlanLock 已持同一计划锁，直接放行（同一逻辑任务内的重入）。
   */
  private static readonly heldLocks = new AsyncLocalStorage<Set<string>>()

  /** 当前是否被在途任务占用（T3 状态通路判定输入可改性）。 */
  isPlanLocked(planId: string): boolean {
    return this.locks.get(planId)?.locked === true
  }

  /**
   * 获取计划级在途锁（排队接替）。返回 release 函数；调用方必须在成功/失败/
   * 取消三路径上最终调用 release（withPlanLock 兜底，或裸用后手工释放）。
   * 同一异步链重入（已持该计划锁）→ 立即放行（no-op release）。
   */
  acquirePlanLock(planId: string): Promise<() => void> {
    assertSafePlanId(planId)
    const held = TravelStore.heldLocks.getStore()
    if (held !== undefined && held.has(planId)) {
      // 重入：外层已持锁，不排队、不递增引用（release 为 no-op）
      return Promise.resolve(() => undefined)
    }
    return new Promise((resolve) => {
      let state = this.locks.get(planId)
      if (state === undefined) {
        state = { locked: false, waiters: [] }
        this.locks.set(planId, state)
      }
      if (!state.locked) {
        state.locked = true
        resolve(() => this.releasePlanLock(planId))
        return
      }
      state.waiters.push(() => resolve(() => this.releasePlanLock(planId)))
    })
  }

  private releasePlanLock(planId: string): void {
    const state = this.locks.get(planId)
    if (state === undefined) return
    const next = state.waiters.shift()
    if (next !== undefined) {
      next() // 移交给排队中的下一位（锁始终由承接者持有）
    } else {
      this.locks.delete(planId)
    }
  }

  /** 锁定执行（成功与失败路径都释放；取消由调用方自行 release）。 */
  async withPlanLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquirePlanLock(planId)
    const outer = TravelStore.heldLocks.getStore()
    const held = new Set(outer ?? [])
    held.add(planId)
    try {
      return await TravelStore.heldLocks.run(held, fn)
    } finally {
      release()
    }
  }

  // ────────────────────────── W0 T2 计划级版本账本 ──────────────────────────

  /** 读取版本账本（缺省全 0）。 */
  async loadVersions(planId: string): Promise<Record<string, number>> {
    assertSafePlanId(planId)
    const raw = await this.readJson<Record<string, number>>(planId, VERSIONS_FILE)
    const manifest = await this.readJson<ArtifactMeta>(planId, ARTIFACT_MANIFEST_FILE)
    const rawSource = raw !== undefined && typeof raw === 'object' ? raw : {}
    const manifestSource = manifest?.versions !== undefined && typeof manifest.versions === 'object'
      ? manifest.versions : {}
    // Versions are monotonic evidence. A legacy/hand-written partial versions.json
    // must not erase keys already committed in a modern manifest, while an
    // explicit bumpVersion() write may still advance a key beyond that snapshot.
    const out: Record<string, number> = {}
    for (const key of ARTIFACT_VERSION_KEYS) {
      const rawValue = rawSource[key]
      const manifestValue = manifestSource[key]
      const values = [rawValue, manifestValue]
        .filter((value): value is number => Number.isSafeInteger(value) && value >= 0)
      out[key] = values.length > 0 ? Math.max(...values) : 0
    }
    return out
  }

  /** 当前版本（无账本 → 0）。 */
  async currentVersion(planId: string, key: ArtifactVersionKey): Promise<number> {
    const versions = await this.loadVersions(planId)
    return versions[key] ?? 0
  }

  /** 推进版本（+1）并返回新值。 */
  async bumpVersion(planId: string, key: ArtifactVersionKey): Promise<number> {
    const versions = await this.loadVersions(planId)
    const next = (versions[key] ?? 0) + 1
    await this.writeJson(planId, VERSIONS_FILE, { ...versions, [key]: next })
    return next
  }

  // ────────────────────────── W0 T2 多文件原子发布 ──────────────────────────

  /**
   * 多文件原子发布：全部产物临时写入 → 末尾 artifact-meta 提交（meta 为提交点，
   * 读到 meta 才有「已发布」语义；中途失败无半发布、tmp 清理）。提交前复核
   * expectedVersions（不符 → LateWriteError 迟到写拒绝）；status∈empty/failed
   * 时照常发布失败元数据（不复活旧成功）。带计划锁，成功/失败路径均释放。
   */
  async publishArtifacts(planId: string, options: PublishArtifactsOptions): Promise<ArtifactMeta> {
    assertSafePlanId(planId)
    const release = await this.acquirePlanLock(planId)
    try {
      // ① 提交前上游版本复核（迟到写拒绝）
      if (options.expectedVersions !== undefined) {
        for (const [key, expected] of Object.entries(options.expectedVersions)) {
          assertValidVersionKey(key)
          const current = await this.currentVersion(planId, key)
          if (current !== expected) throw new LateWriteError(key, expected as number, current)
        }
      }
      const dir = this.planDir(planId)
      await mkdir(dir, { recursive: true })
      const previousMeta = await this.readJson<ArtifactMeta>(planId, ARTIFACT_MANIFEST_FILE)
      const previousVersions = await this.loadVersions(planId)
      const nextVersions = { ...previousVersions }
      const status = options.status ?? 'success'
      if (status === 'success') {
        for (const key of options.bump ?? []) {
          assertValidVersionKey(key)
          nextVersions[key] = (nextVersions[key] ?? 0) + 1
        }
      }

      const commitId = randomUUID()
      const releaseVersion = (previousMeta?.releaseVersion ?? 0) + 1
      const generatedAt = new Date().toISOString()
      const contentHash: Record<string, string> = {}
      const staged: Array<{ name: string; tmp: string }> = []
      const filesSeen = new Set<string>()
      const previousEntries = legacyManifestEntries(previousMeta)
      const entries: Record<string, ArtifactManifestEntry> = { ...previousEntries }
      const tempFiles: string[] = []
      try {
        // ② 全部产物临时写入；重复名/保留名在任何 rename 前拒绝。
        for (const file of options.files) {
          assertSafeArtifactName(file.name)
          if (filesSeen.has(file.name)) throw new Error(`同一 manifest 不得重复发布工件：${file.name}`)
          filesSeen.add(file.name)
          const serialized = serialize(file.data)
          contentHash[file.name] = sha256(serialized)
          const target = join(dir, file.name)
           const targetDir = dirname(target)
           // Keep temp files beside their target. Prefixing the whole relative name
           // (e.g. `.research-rounds/x.json`) creates a different hidden directory.
           await mkdir(targetDir, { recursive: true })
           const tmp = join(targetDir, `.${basename(target)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
                                await writeFile(tmp, serialized, 'utf8')
          staged.push({ name: file.name, tmp })
          entries[file.name] = {
            name: file.name,
            hash: contentHash[file.name],
            contentHash: contentHash[file.name],
            commitId,
            releaseVersion,
            stage: options.stage,
            inputFingerprint: options.inputFingerprint ?? 'manual',
            upstreamVersions: { ...(options.expectedVersions ?? {}) },
            status,
            generatedAt,
          }
        }
        const mergedContentHash = Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.hash]))
        const meta: ArtifactManifest = {
          schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
          commitId,
          releaseVersion,
          stage: options.stage,
          inputFingerprint: options.inputFingerprint ?? 'manual',
          upstreamVersions: { ...(options.expectedVersions ?? {}) },
          contentHash: mergedContentHash,
          artifacts: entries,
          versions: nextVersions,
          status,
          generatedAt,
          ...(options.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
        }
        const metaTmp = join(dir, `.${ARTIFACT_MANIFEST_FILE}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
        const versionsTmp = join(dir, `.${VERSIONS_FILE}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
        tempFiles.push(metaTmp, versionsTmp)
        await writeFile(metaTmp, serialize(meta), 'utf8')
        await writeFile(versionsTmp, serialize(nextVersions), 'utf8')

        // ③ 先将旧最终文件移入 rollback 备份，再依次换入新文件。
        // 任一 rename 失败都恢复所有已触碰文件，避免 mid-rename 半发布污染。
        const finalNames = [...staged.map((item) => item.name), VERSIONS_FILE, ARTIFACT_MANIFEST_FILE]
        const backups: Array<{ finalPath: string; backupPath: string }> = []
        const installed: string[] = []
        try {
          for (const name of finalNames) {
            const finalPath = join(dir, name)
            await mkdir(dirname(finalPath), { recursive: true })
            if (!(await this.fileExists(planId, name))) continue
            const backupPath = join(dirname(finalPath), `.${basename(finalPath)}.rollback-${process.pid}-${randomUUID().slice(0, 8)}`)
            await this.renameFile(finalPath, backupPath)
            backups.push({ finalPath, backupPath })
          }
          for (const item of staged) {
            await this.renameFile(item.tmp, join(dir, item.name))
            installed.push(join(dir, item.name))
          }
          await this.renameFile(versionsTmp, join(dir, VERSIONS_FILE))
          installed.push(join(dir, VERSIONS_FILE))
          // manifest 最后 rename，作为读侧提交点。
          await this.renameFile(metaTmp, join(dir, ARTIFACT_MANIFEST_FILE))
          installed.push(join(dir, ARTIFACT_MANIFEST_FILE))
          await Promise.all(backups.map((backup) => rm(backup.backupPath, { force: true }).catch(() => undefined)))
          return meta
        } catch (error) {
          await Promise.all(installed.map((path) => rm(path, { force: true }).catch(() => undefined)))
          for (const backup of backups.reverse()) {
            await this.renameFile(backup.backupPath, backup.finalPath).catch(() => undefined)
          }
          throw error
        } finally {
          await Promise.all([
            rm(metaTmp, { force: true }).catch(() => undefined),
            rm(versionsTmp, { force: true }).catch(() => undefined),
            ...staged.map((item) => rm(item.tmp, { force: true }).catch(() => undefined)),
            ...backups.map((backup) => rm(backup.backupPath, { force: true }).catch(() => undefined)),
          ])
        }
      } catch (error) {
        // 序列化/临时写阶段失败时，绝不触碰旧最终文件。
        await Promise.all([
          ...staged.map((item) => rm(item.tmp, { force: true }).catch(() => undefined)),
          ...tempFiles.map((path) => rm(path, { force: true }).catch(() => undefined)),
        ])
        throw error
      }
    } finally {
      release()
    }
  }

  /** 读取当前 manifest；缺失 → undefined。 */
  async readArtifactManifest(planId: string): Promise<ArtifactManifest | undefined> {
    const meta = await this.readJson<ArtifactMeta>(planId, ARTIFACT_MANIFEST_FILE)
    return isModernManifest(meta) ? meta : undefined
  }

  /**
   * 带状态读取（草稿 F + round3 manifest）。
   * - schemaVersion=2 的未入账工件 → unknown（只读，不伪装 current/stale）
   * - schemaVersion=2 的已入账旧版本工件按自身 hash/依赖校验，可继续 current
   * - 未知 schemaVersion → unknown（只读兼容）
   * - 既有无 envelope legacy 文件仍按旧兼容语义返回 current。
   */
  async readArtifactWithState<T>(planId: string, name: string): Promise<ArtifactReadState<T>> {
    assertSafePlanId(planId)
    assertSafeJsonName(name)
    const meta = await this.readJson<ArtifactMeta>(planId, ARTIFACT_MANIFEST_FILE)
    const exists = await this.fileExists(planId, name)
    const data = exists ? await this.readJson<T>(planId, name) : undefined
    if (meta === undefined) {
      // legacy：旧文件不强制 envelope（保持既有读取兼容）。
      return exists
        ? { found: true, status: 'current', data }
        : { found: false, status: 'missing' }
    }

    if (meta.schemaVersion !== undefined && meta.schemaVersion !== CURRENT_MANIFEST_SCHEMA_VERSION) {
      return { found: exists, status: 'unknown', staleReason: 'unknown_version', data, meta, compatibility: 'unknown' }
    }
    // A declared current-version envelope that is structurally incomplete is not
    // safe to reinterpret as the legacy contentHash shape: keep it read-only unknown.
    if (meta.schemaVersion === CURRENT_MANIFEST_SCHEMA_VERSION && !isModernManifest(meta)) {
      return { found: exists, status: 'unknown', staleReason: 'unknown_version', data, meta, compatibility: 'unknown' }
    }
    if (meta.status === 'failed') return { found: exists, status: 'failed', data, meta }
    if (meta.status === 'empty') return { found: exists, status: 'empty', data, meta }
    if (!exists) return { found: false, status: 'missing', meta }

    if (isModernManifest(meta)) {
      const entry = meta.artifacts[name]
      if (entry === undefined) {
        return { found: true, status: 'unknown', staleReason: 'unaccounted', data, meta, compatibility: 'unknown' }
      }
      // manifest 按工件保留最近一次发布条目：另一领域工件后发布不应使本条
      // 自动 stale；只要自身 hash/依赖仍能核对，就继续 current。commitId 仅用于
      // 审计“最后由哪次发布更新”，未入账（entry 缺失）才是 unknown。
      const currentVersions = await this.loadVersions(planId)
      const dependencyChanged = Object.entries(entry.upstreamVersions).some(([key, expected]) => {
        if (!(ARTIFACT_VERSION_KEYS as readonly string[]).includes(key)) return true
        return (currentVersions[key] ?? 0) !== expected
      })
      if (dependencyChanged) {
        return { found: true, status: 'stale', staleReason: 'dependency_version', data, meta, compatibility: 'current' }
      }
      const expectedHash = entry.hash || entry.contentHash
      if (data === undefined) return { found: true, status: 'stale', staleReason: 'hash_mismatch', data, meta, compatibility: 'current' }
      const stableHash = sha256(serialize(data))
      if (stableHash === expectedHash) return { found: true, status: 'current', data, meta, compatibility: 'current' }
      return { found: true, status: 'stale', staleReason: 'hash_mismatch', data, meta, compatibility: 'current' }
    }

    // 草稿 F 旧 meta：contentHash 只表示最近提交，保留原 stale 语义。
    const expectedHash = meta.contentHash?.[name]
    if (expectedHash === undefined) return { found: true, status: 'stale', staleReason: 'not_in_commit', data, meta, compatibility: 'legacy' }
    if (data === undefined) return { found: true, status: 'stale', staleReason: 'hash_mismatch', data, meta, compatibility: 'legacy' }
    const stableHash = sha256(serialize(data))
    if (stableHash === expectedHash) return { found: true, status: 'current', data, meta, compatibility: 'legacy' }
    // 迁移旧版本 meta：若文件仍与旧 JSON 序列化 hash 一致，则升级旁车到稳定 hash；
    // 值被改动时两种 hash 都不匹配，仍严格 stale，不削弱篡改保护。
    if (sha256(legacySerialize(data)) === expectedHash) {
      const migratedMeta: ArtifactMeta = {
        ...meta,
        contentHash: { ...meta.contentHash, [name]: stableHash },
      }
      await this.writeJson(planId, ARTIFACT_MANIFEST_FILE, migratedMeta)
      return { found: true, status: 'current', data, meta: migratedMeta, compatibility: 'legacy' }
    }
    return { found: true, status: 'stale', staleReason: 'hash_mismatch', data, meta, compatibility: 'legacy' }
  }

  private async fileExists(planId: string, name: string): Promise<boolean> {
    try {
      await access(join(this.planDir(planId), name))
      return true
    } catch {
      return false
    }
  }

  // ────────────────────────── W0 T2 research 子工件（rounds/content/assessments） ──────────────────────────

  /** 读取研究状态（research-state.json；缺失 → undefined）。 */
  async loadResearchState<T = unknown>(planId: string): Promise<T | undefined> {
    return this.readJson<T>(planId, 'research-state.json')
  }

  /** 写研究状态（research-state.json；经 manifest 原子发布）。 */
  async saveResearchState(planId: string, data: unknown): Promise<void> {
    await this.publishArtifacts(planId, {
      stage: 'research-state',
      files: [{ name: 'research-state.json', data }],
      inputFingerprint: 'research-state',
    })
  }

  /** 写研究轮次（research-rounds/<roundId>.json；经 manifest 原子发布）。 */
  async writeResearchRound(planId: string, roundId: string, data: unknown): Promise<void> {
    assertSafePlanId(planId)
    assertSafeResearchId(roundId, 'roundId')
    await this.publishArtifacts(planId, {
      stage: 'research-round',
      files: [{ name: join('research-rounds', `${roundId}.json`), data }],
      inputFingerprint: `research-round:${roundId}`,
    })
  }

  /** 读研究轮次；缺失 → undefined。 */
  async readResearchRound<T>(planId: string, roundId: string): Promise<T | undefined> {
    assertSafeResearchId(roundId, 'roundId')
    return this.readJson<T>(planId, join('research-rounds', `${roundId}.json`))
  }

  /**
   * 写正文内容（research-content/<itemId>/<contentVersion>.json）。
   * id 全部过 assertSafeResearchId——任何输入不直接拼任意路径（含跨计划拒绝）。
   */
  async writeResearchContent(planId: string, itemId: string, contentVersion: string, data: unknown): Promise<void> {
    assertSafePlanId(planId)
    assertSafeResearchId(itemId, 'itemId')
    assertSafeResearchId(contentVersion, 'contentVersion')
    await this.publishArtifacts(planId, {
      stage: 'research-content',
      files: [{ name: join('research-content', itemId, `${contentVersion}.json`), data }],
      inputFingerprint: `research-content:${itemId}:${contentVersion}`,
    })
  }

  /** 读正文内容（固定 itemId+contentVersion，跨计划/非法 id 拒绝）；缺失 → undefined。 */
  async readResearchContent<T>(planId: string, itemId: string, contentVersion: string): Promise<T | undefined> {
    assertSafePlanId(planId)
    assertSafeResearchId(itemId, 'itemId')
    assertSafeResearchId(contentVersion, 'contentVersion')
    const path = join(this.planDir(planId), 'research-content', itemId, `${contentVersion}.json`)
    try {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** 写 assessment（research-assessments/<assessmentId>.json）。 */
  async writeResearchAssessment(planId: string, assessmentId: string, data: unknown): Promise<void> {
    assertSafePlanId(planId)
    assertSafeResearchId(assessmentId, 'assessmentId')
    await this.publishArtifacts(planId, {
      stage: 'research-assessment',
      files: [{ name: join('research-assessments', `${assessmentId}.json`), data }],
      inputFingerprint: `research-assessment:${assessmentId}`,
    })
  }

  /** 读 assessment；缺失 → undefined。 */
  async readResearchAssessment<T>(planId: string, assessmentId: string): Promise<T | undefined> {
    assertSafePlanId(planId)
    assertSafeResearchId(assessmentId, 'assessmentId')
    const path = join(this.planDir(planId), 'research-assessments', `${assessmentId}.json`)
    try {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}