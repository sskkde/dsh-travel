/**
 * 伴随服务 supervisor（M3.5 / W5）：按需 opt-in 的生命周期自动管理。
 *
 * 语义（用户决策：**默认关闭**）：
 * - companionAutostart=false（默认）→ ensure(name) 仅做健康探测：健康→直接返回；
 *   不健康→返回 AUTOSTART_DISABLED 失败 + 指引，**绝不产生任何新进程/容器启动**
 *   ——与 M2 行为完全一致（连接已手动运行的服务，服务挂→既有降级链）。
 * - companionAutostart=true → 工具首次需要某服务且该服务不健康 → ensure(name)
 *   按需 spawn/start（docker=容器已存在则 start；local=spawn 进程）→ 轮询
 *   health 到 readyTimeoutMs → 成功后调用方继续；失败→返回失败 + 安装指引，
 *   调用方降级，主流程不中断。
 *
 * 状态机要点：
 * - 幂等：已 healthy → 直接返回（already-healthy），不重复 spawn；
 * - 并发去重：同一服务并发 ensure 共享同一 in-flight Promise（只 spawn 一次）；
 * - 直接托管进程存活但暂不健康时不重复 spawn（避免进程堆积）；
 * - crash 重启上限：滑动窗口（默认 60s）内 start 次数 ≤ restartLimit（默认 3），
 *   超限返回 RESTART_LIMIT 停止重试（防 crash-loop 拖垮宿主）；
 * - remote（didi）：ensure 只做健康探测，**永不 spawn**（任何设置都改变不了）；
 * - stopAll/dispose：直接托管进程 SIGTERM 进程组 → stopGraceMs → SIGKILL；
 *   docker 只 stop **本插件本会话启动**的容器（外部预存容器不动）；daemon 化
 *   脚本（playwright-mcp.sh）走其内建 stop 路径；pid/log 文件清理。
 *
 * 安全铁律：
 * - spawn 一律 `shell:false`，command/args 只来自 manifest（内建 allowlist，
 *   isCommandAllowlisted 校验；不在 allowlist 的命令拒绝执行）；
 * - 子进程 env 采用最小白名单继承（PATH/HOME/TMPDIR/LANG + manifest.env），
 *   **不透传宿主全量 env**（DIDI_MCP_KEY 等敏感值不泄入子进程环境）；
 * - key/cookie/profile 不进 argv/日志/pid 文件；日志写经 redactText 兜底脱敏；
 * - pid/log 文件内容只有 service/pid/startedAt 与启动横幅（无 args/env）。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  COMPANION_COMMAND_ALLOWLIST, COMPANION_MANIFESTS, COMPANION_SERVICES,
  isCommandAllowlisted,
  type CompanionManifest, type CompanionServiceName,
} from './manifests.js'

export type { CompanionManifest, CompanionServiceName } from './manifests.js'
import { pollHealthUntilReady, probeHealthOnce, type HealthFetchFn, type HealthProbeResult } from './health.js'
import { travelDirectory } from '../store/paths.js'
import { travelSettingsSnapshot } from '../settings/schema.js'

// ────────────────────────── 结果类型 ──────────────────────────

/** ensure 结果动作。 */
export type CompanionEnsureAction = 'already-healthy' | 'started' | 'skipped' | 'failed'

/** ensure 失败/跳过码（调用方据此走降级链；reason 附人话指引，零 secret）。 */
export type CompanionEnsureCode =
  | 'PROBE_FAILED'
  | 'AUTOSTART_DISABLED'
  | 'SERVICE_DISABLED'
  | 'COMMAND_NOT_ALLOWLISTED'
  | 'NOT_INSTALLED'
  | 'START_FAILED'
  | 'HEALTH_TIMEOUT'
  | 'RESTART_LIMIT'
  | 'DISPOSED'

/** ensure(name) 结果。ok=false 时调用方按既有 M2 降级链处理（不中断主流程）。 */
export interface CompanionEnsureResult {
  service: CompanionServiceName
  ok: boolean
  action: CompanionEnsureAction
  /** 失败/跳过码（ok=true 时缺省）。 */
  code?: CompanionEnsureCode
  /** 人话原因 + 指引（零 secret；失败时给用户/日志）。 */
  reason?: string
  /** 本次是否由 supervisor 产生了新进程/容器启动（already-healthy/skip 恒 false）。 */
  spawned: boolean
}

/** supervisor 设置视图（热读；缺省=travelSettingsSnapshot 的 advanced 组）。 */
export interface CompanionSettingsView {
  companionAutostart: boolean
  companionServices: Record<CompanionServiceName, boolean>
}

// ────────────────────────── 进程执行注入面（测试 fake） ──────────────────────────

/** 托管子进程最小面（node ChildProcess 结构子集；测试注入 fake 实现）。 */
export interface ManagedChild {
  readonly pid?: number
  readonly killed: boolean
  readonly exitCode: number | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: string, listener: (...args: unknown[]) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
  unref(): void
}

/** spawn 选项（supervisor 传给底层 spawn 的最小面）。 */
export interface CompanionSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  detached?: boolean
  /** ['ignore', logFd, logFd]：stdout/stderr 落日志文件描述符（exec 收集形态用 'pipe'）。 */
  stdio?: readonly ('ignore' | 'pipe' | number)[]
}

/** spawn 注入（缺省 node:child_process.spawn，shell:false）。 */
export type CompanionSpawnFn = (command: string, args: readonly string[], options: CompanionSpawnOptions) => ManagedChild

/** exec 结果（docker / 停止脚本；stdout/stderr 原样返回，调用方 redact 后才入日志）。 */
export interface CompanionExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/** exec 注入（docker 检查/启停、daemon 脚本停止路径；缺省 node spawn 收集式实现）。 */
export type CompanionExecFn = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CompanionExecResult>

// ────────────────────────── supervisor 选项 ──────────────────────────

export interface CompanionSupervisorOptions {
  /** manifest 覆盖（测试/定制；缺省内建四服务；命令仍受 allowlist 约束）。 */
  manifests?: Partial<Record<CompanionServiceName, CompanionManifest>>
  /** 命令 allowlist 覆盖（缺省 COMPANION_COMMAND_ALLOWLIST；测试注入 fake 命令用）。 */
  allowCommands?: ReadonlySet<string>
  /** 设置热读覆盖（缺省 travelSettingsSnapshot().advanced；undefined=默认关闭）。 */
  settings?: () => CompanionSettingsView | undefined
  /** workspace 根（相对命令/cwd 解析基准；缺省 DSH_TRAVEL_ROOT → cwd）。 */
  workspaceRoot?: string
  /** pid/log 状态目录（缺省 `<workspaceRoot>/.dsh-travel/companion`）。 */
  stateDir?: string
  /** spawn 注入（测试 fake）。 */
  spawn?: CompanionSpawnFn
  /** exec 注入（测试 fake）。 */
  exec?: CompanionExecFn
  /** 健康探活 fetch 注入（测试 fake）。 */
  fetchFn?: HealthFetchFn
  /** 时钟注入（重启窗口测试）。 */
  now?: () => number
  /** 轮询间隔 ms（缺省 500）。 */
  pollIntervalMs?: number
  /** 滑动窗口内 start 次数上限（缺省 3）。 */
  restartLimit?: number
  /** 重启窗口宽度 ms（缺省 60_000）。 */
  restartWindowMs?: number
  /** 运行日志上报（缺省 console.warn；写入内容经 redactText 脱敏）。 */
  log?: (message: string) => void
}

// ────────────────────────── 内部状态 ──────────────────────────

interface ServiceState {
  manifest: CompanionManifest
  /** 并发 ensure 去重：同一服务的进行中 ensure 共享该 Promise。 */
  inflight?: Promise<CompanionEnsureResult>
  /** 直接托管的子进程（local-process；daemon 化脚本场景为已退出的脚本进程）。 */
  child?: ManagedChild
  childExited: boolean
  /** 本会话是否由本 supervisor spawn 过（stopAll 处置权判据）。 */
  spawned: boolean
  /** docker：本会话是否由本 supervisor start 过（外部预存容器恒 false → 不 stop）。 */
  containerStarted: boolean
  /** 滑动窗口内的 start 时刻（epoch ms；crash 重启上限判据）。 */
  starts: number[]
  logFd?: number
  pidFile?: string
  logFile?: string
}

/** 宿主 env 白名单（子进程/exec 继承的最小集；防敏感值泄入子进程环境）。 */
const CHILD_ENV_ALLOW = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'DOCKER_HOST'] as const

function buildChildEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_ALLOW) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) env[key] = value
  }
  return env
}

/**
 * 日志/原因文本脱敏兜底：任何进入 supervisor 日志与 reason 的动态文本先经此
 * ——key/token/secret/password/cookie/authorization 形态的赋值片段一律打码。
 */
export function redactText(text: string): string {
  return text
    .replace(/\b(key|token|secret|password|passwd|cookie|authorization|credential)s?\b\s*[=:]\s*[A-Za-z0-9_./+=~-]+/gi, '$1=<redacted>')
    .replace(/\b(sk|pk)-[A-Za-z0-9_-]{8,}/g, '<redacted>')
}

/** 缺省 exec：node spawn 收集式（shell:false；超时 SIGKILL）。 */
function makeDefaultExec(spawnFn: CompanionSpawnFn): CompanionExecFn {
  return (command, args, options) =>
    new Promise<CompanionExecResult>((resolve) => {
      const chunksOut: Buffer[] = []
      const chunksErr: Buffer[] = []
      const child = spawnFn(command, args, {
        env: buildChildEnv(undefined),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        resolve({
          code,
          stdout: Buffer.concat(chunksOut).toString('utf8'),
          stderr: Buffer.concat(chunksErr).toString('utf8'),
        })
      }
      // pipe 形态下 stdout/stderr 为可读流（ManagedChild 最小面外的运行时能力；
      // 仅缺省实现使用——fake exec 注入不经过此处）。
      const childWithStreams = child as ManagedChild & {
        stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
        stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
      }
      childWithStreams.stdout?.on('data', (chunk) => { chunksOut.push(chunk) })
      childWithStreams.stderr?.on('data', (chunk) => { chunksErr.push(chunk) })
      child.on('exit', (code) => { finish(code) })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null)
      }, options.timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
}

/** 缺省 spawn：node:child_process spawn（shell:false；detached 由调用方给）。 */
const defaultSpawn: CompanionSpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio as unknown as ('ignore' | number)[],
    shell: false,
  }) as unknown as ManagedChild

// ────────────────────────── CompanionSupervisor ──────────────────────────

/**
 * 伴随服务 supervisor：ensure（幂等/去重/按需拉起/健康等待）+ stopAll/dispose
 * （SIGTERM 进程组 → 宽限 → SIGKILL；docker 只停本会话启动的容器；pid/log 清理）。
 */
export class CompanionSupervisor {
  private readonly states: Map<CompanionServiceName, ServiceState>
  private readonly allowlist: ReadonlySet<string>
  private readonly readSettings: () => CompanionSettingsView | undefined
  private readonly workspaceRoot: string
  private readonly stateDir: string
  private readonly spawnFn: CompanionSpawnFn
  private readonly execFn: CompanionExecFn
  private readonly fetchFn: HealthFetchFn | undefined
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly restartLimit: number
  private readonly restartWindowMs: number
  private readonly logFn: (message: string) => void
  private disposed = false

  constructor(options: CompanionSupervisorOptions = {}) {
    this.states = new Map()
    for (const name of COMPANION_SERVICES) {
      const manifest = options.manifests?.[name] ?? COMPANION_MANIFESTS[name]
      this.states.set(name, { manifest, childExited: false, spawned: false, containerStarted: false, starts: [] })
    }
    this.allowlist = options.allowCommands ?? COMPANION_COMMAND_ALLOWLIST
    this.readSettings = options.settings ?? this.readTravelSettings
    this.workspaceRoot = options.workspaceRoot ?? process.env.DSH_TRAVEL_ROOT ?? process.cwd()
    this.stateDir = options.stateDir ?? join(travelDirectory(this.workspaceRoot), 'companion')
    this.spawnFn = options.spawn ?? defaultSpawn
    this.execFn = options.exec ?? makeDefaultExec(this.spawnFn)
    this.fetchFn = options.fetchFn
    this.now = options.now ?? (() => Date.now())
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.restartLimit = Math.max(1, options.restartLimit ?? 3)
    this.restartWindowMs = Math.max(1, options.restartWindowMs ?? 60_000)
    this.logFn = options.log ?? ((message) => { console.warn(`[dsh-travel companion] ${message}`) })
  }

  // ── ensure（幂等 + 并发去重 + 按需拉起） ──

  /**
   * 确保某伴随服务可用：健康→直接返回（幂等，不 spawn）；不健康→按设置决定
   * 是否按需拉起（spawn/start + 轮询 health）；失败/关闭→返回 ok=false + 指引
   * （调用方走既有降级链，主流程不中断）。remote 服务只探活，绝不 spawn。
   */
  ensure(name: CompanionServiceName): Promise<CompanionEnsureResult> {
    const state = this.states.get(name)
    if (state === undefined) {
      return Promise.resolve({
        service: name as CompanionServiceName, ok: false, action: 'failed',
        code: 'PROBE_FAILED', reason: `未知伴随服务：${redactText(String(name))}`, spawned: false,
      })
    }
    // 并发去重：同一服务进行中的 ensure 直接共享（只 spawn 一次）。
    // reason 统一经 redactText 出闸（fetch 层 message 等动态文本不得带出 secret）；
    // 异常路径兜底归一为失败结果（ensure 永不 reject——降级语义，主流程不中断）。
    if (state.inflight !== undefined) return state.inflight
    const run = this.ensureInner(state)
      .then((result) => (result.reason !== undefined ? { ...result, reason: redactText(result.reason) } : result))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.logFn(`${state.manifest.service}: ensure 异常（不影响主流程）——${redactText(message)}`)
        return {
          service: state.manifest.service, ok: false, action: 'failed' as const,
          code: 'START_FAILED' as const, reason: `伴随服务管理异常：${message}`, spawned: false,
        }
      })
      .finally(() => { state.inflight = undefined })
    state.inflight = run
    return run
  }

  private async ensureInner(state: ServiceState): Promise<CompanionEnsureResult> {
    const manifest = state.manifest
    const { service } = manifest
    if (this.disposed) {
      return { service, ok: false, action: 'skipped', code: 'DISPOSED', reason: 'supervisor 已停止（插件卸载/收尾）', spawned: false }
    }
    // allowlist 闸门：local/docker 的启动（与停止）命令必须在内建 allowlist 内
    if (manifest.mode !== 'remote' && !this.manifestAllowed(manifest)) {
      const reason = `命令不在内建 allowlist（拒绝执行）：${redactText(manifest.command ?? '')}`
      this.logFn(`${service}: ${reason}`)
      return { service, ok: false, action: 'failed', code: 'COMMAND_NOT_ALLOWLISTED', reason, spawned: false }
    }
    // 幂等快速路径：已健康 → 不 spawn
    const first = await probeHealthOnce(manifest.health, this.fetchFn)
    if (first.healthy) {
      return { service, ok: true, action: 'already-healthy', spawned: false }
    }
    const probeNote = this.probeDetail(first)
    // remote：health-only，永不 spawn（设置无论如何都不改变这一点）
    if (manifest.mode === 'remote') {
      const reason = `${manifest.title} 远程服务不可达（${probeNote}）。${manifest.guide}`
      this.logFn(`${service}: ${redactText(reason)}`)
      return { service, ok: false, action: 'failed', code: 'PROBE_FAILED', reason, spawned: false }
    }
    // 设置门：总开关关闭（默认）→ 零副作用，保持 M2 行为（调用方既有降级）
    const settings = this.readSettings()
    if (settings?.companionAutostart !== true) {
      return {
        service, ok: false, action: 'skipped', code: 'AUTOSTART_DISABLED',
        reason: `伴随服务自动拉起未开启（默认关闭，行为与手动部署一致）。服务不健康（${probeNote}）。`
          + `可开启：设置页 → 旅行规划插件 → 高级配置 → 「伴随服务自动拉起」。${manifest.guide}`,
        spawned: false,
      }
    }
    // per-service toggle（仅 autostart 开启时生效）
    if (settings.companionServices[service] === false) {
      return {
        service, ok: false, action: 'skipped', code: 'SERVICE_DISABLED',
        reason: `「${manifest.title}」的自动拉起已被用户关闭（advanced.companionServices.${service}）。${manifest.guide}`,
        spawned: false,
      }
    }
    // crash 重启上限（滑动窗口）
    this.pruneStarts(state)
    if (state.starts.length >= this.restartLimit) {
      const reason = `${manifest.title} 启动/重启已达上限（${this.restartLimit} 次/${Math.round(this.restartWindowMs / 1000)}s），停止重试以防 crash-loop。${manifest.guide}`
      this.logFn(`${service}: ${reason}`)
      return { service, ok: false, action: 'failed', code: 'RESTART_LIMIT', reason, spawned: false }
    }
    // 按需 spawn/start
    const started = await this.start(state)
    if (!started.ok) {
      this.logFn(`${service}: ${redactText(started.reason ?? '启动失败')}`)
      return { service, ok: false, action: 'failed', code: started.code, reason: started.reason, spawned: started.startedNow === true }
    }
    const startedNow = started.startedNow === true
    // 轮询 health 到 ready（dispose 中途取消）
    const ready = await pollHealthUntilReady(manifest.health, {
      readyTimeoutMs: manifest.readyTimeoutMs,
      intervalMs: this.pollIntervalMs,
      fetchFn: this.fetchFn,
      isAborted: () => this.disposed,
    })
    if (!ready.healthy) {
      const logHint = state.logFile !== undefined ? `日志：${state.logFile}。` : ''
      const reason = `${manifest.title} 已拉起但 ${manifest.readyTimeoutMs}ms 内未就绪（${this.probeDetail(ready)}）。${logHint}${manifest.guide}`
      this.logFn(`${service}: ${redactText(reason)}`)
      return { service, ok: false, action: 'failed', code: 'HEALTH_TIMEOUT', reason, spawned: startedNow }
    }
    this.logFn(`${service}: 已就绪（本会话启动）`)
    return { service, ok: true, action: startedNow ? 'started' : 'already-healthy', spawned: startedNow }
  }

  // ── spawn/start（按 manifest.mode 分派） ──

  private async start(state: ServiceState): Promise<{ ok: boolean; startedNow?: boolean; code?: CompanionEnsureCode; reason?: string }> {
    const manifest = state.manifest
    if (manifest.mode === 'local-process') return this.startProcess(state)
    if (manifest.mode === 'docker') return this.startContainer(state)
    // remote 不会走到这里（ensureInner 已拦）
    return { ok: false, code: 'PROBE_FAILED', reason: 'remote 服务不支持启动' }
  }

  /** local-process：spawn 固定命令（shell:false；detached 进程组；日志/pid 落盘）。 */
  private startProcess(state: ServiceState): { ok: boolean; startedNow?: boolean; code?: CompanionEnsureCode; reason?: string } {
    const manifest = state.manifest
    // 直接托管进程还活着但暂不健康 → 不重复 spawn（避免进程堆积；health 等待期自会判定）
    if (state.child !== undefined && !state.childExited && state.child.exitCode === null) {
      return { ok: true }
    }
    const resolved = this.resolveCommand(manifest.command ?? '')
    if (resolved === undefined || !existsSync(resolved)) {
      return {
        ok: false, code: 'NOT_INSTALLED',
        reason: `启动命令不存在：${redactText(manifest.command ?? '')}（workspace=${this.workspaceRoot}）。${manifest.guide}`,
      }
    }
    const cwd = this.resolvePath(manifest.cwd ?? '.')
    // 日志文件（追加写；仅启动横幅 + 子进程输出，横幅零 args/env）
    this.ensureStateDir()
    const logFile = join(this.stateDir, `${manifest.service}.log`)
    if (state.logFd === undefined) state.logFd = openSync(logFile, 'a')
    state.logFile = logFile
    writeSync(state.logFd, `[${new Date().toISOString()}] dsh-travel companion start ${manifest.service}\n`)
    const child = this.spawnFn(resolved, [...(manifest.args ?? [])], {
      cwd,
      env: buildChildEnv(manifest.env),
      detached: true,
      stdio: ['ignore', state.logFd, state.logFd],
    })
    state.child = child
    state.childExited = false
    state.spawned = true
    state.starts.push(this.now())
    child.on('exit', (code, signal) => {
      state.childExited = true
      this.logFn(`${manifest.service}: 进程退出（code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`)
      this.cleanupPidFile(state)
    })
    child.unref()
    // pid 文件：仅 service/pid/startedAt（零 args/env/secret）
    state.pidFile = join(this.stateDir, `${manifest.service}.pid`)
    try {
      writeFileSync(state.pidFile, JSON.stringify({ service: manifest.service, pid: child.pid ?? null, startedAt: new Date().toISOString() }, null, 2))
    } catch (error) {
      this.logFn(`${manifest.service}: pid 文件写入失败（不影响服务）——${redactText(error instanceof Error ? error.message : String(error))}`)
    }
    return { ok: true, startedNow: true }
  }

  /** docker：容器存在才 start（绝不 run/安装）；外部预存已运行容器零操作。 */
  private async startContainer(state: ServiceState): Promise<{ ok: boolean; startedNow?: boolean; code?: CompanionEnsureCode; reason?: string }> {
    const manifest = state.manifest
    const container = manifest.container ?? ''
    const inspect = await this.execFn(manifest.command ?? 'docker',
      ['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.ID}}\t{{.Status}}'],
      { timeoutMs: 10_000 })
    if (inspect.code !== 0) {
      return {
        ok: false, code: 'START_FAILED',
        reason: `docker 查询容器状态失败（docker 命令不可用/守护进程未运行）。${manifest.guide}`,
      }
    }
    const rows = inspect.stdout.trim()
    if (rows === '') {
      return {
        ok: false, code: 'NOT_INSTALLED',
        reason: `容器 ${container} 不存在（supervisor 只 start/stop 已安装容器，绝不联网安装）。${manifest.guide}`,
      }
    }
    // --format '{{.ID}}\t{{.Status}}'：状态在制表符后的第二列
    const firstRow = rows.split('\n')[0] ?? ''
    const statusPart = firstRow.split('\t')[1] ?? firstRow
    if (/^Up\b/i.test(statusPart)) {
      // 已在运行（health 刚失败可能是瞬时抖动）：不重复 start，交回 health 等待
      return { ok: true }
    }
    const startResult = await this.execFn(manifest.command ?? 'docker', ['start', container], { timeoutMs: manifest.readyTimeoutMs + 15_000 })
    if (startResult.code !== 0) {
      return {
        ok: false, code: 'START_FAILED',
        reason: `docker start ${container} 失败：${redactText((startResult.stderr || startResult.stdout || '').trim().slice(0, 200))}。${manifest.guide}`,
      }
    }
    state.containerStarted = true
    state.starts.push(this.now())
    return { ok: true, startedNow: true }
  }

  // ── stopAll / dispose ──

  /**
   * 停止全部**本会话由本 supervisor 启动**的资源并清理 pid/log：
   * - 直接托管进程：SIGTERM 进程组 → stopGraceMs → SIGKILL；
   * - daemon 化脚本（stopCommand）：走脚本内建 stop（仅处置本插件启动的实例）；
   * - docker：仅 stop 本会话 start 过的容器（外部预存容器不动）。
   * 未启动过的服务零操作；重复调用无害。
   */
  async stopAll(): Promise<void> {
    this.disposed = true
    const stops: Array<Promise<void>> = []
    for (const state of this.states.values()) {
      stops.push(this.stopService(state))
    }
    await Promise.all(stops)
  }

  /** dispose = stopAll（幂等；之后再 ensure 一律返回 DISPOSED）。 */
  async dispose(): Promise<void> {
    await this.stopAll()
  }

  private async stopService(state: ServiceState): Promise<void> {
    const manifest = state.manifest
    // 仅处置本会话启动的资源（外部预存服务/容器不动——M2 基线保护）
    if (state.spawned) {
      if (manifest.stopCommand !== undefined && this.manifestAllowedStop(manifest)) {
        try {
          const result = await this.execFn(this.resolveCommand(manifest.stopCommand) ?? manifest.stopCommand,
            [...(manifest.stopArgs ?? [])], { timeoutMs: manifest.stopGraceMs + 10_000 })
          if (result.code !== 0) {
            this.logFn(`${manifest.service}: 停止命令退出码 ${result.code === null ? 'null' : result.code}（${redactText((result.stderr || '').trim().slice(0, 120))}）`)
          }
        } catch (error) {
          this.logFn(`${manifest.service}: 停止命令执行失败——${redactText(error instanceof Error ? error.message : String(error))}`)
        }
      } else if (state.child !== undefined && !state.childExited) {
        await this.terminateChild(state)
      }
    }
    if (state.containerStarted) {
      try {
        const result = await this.execFn(manifest.command ?? 'docker', ['stop', manifest.container ?? ''], { timeoutMs: manifest.stopGraceMs + 15_000 })
        if (result.code !== 0) {
          this.logFn(`${manifest.service}: docker stop 退出码 ${result.code === null ? 'null' : result.code}（${redactText((result.stderr || '').trim().slice(0, 120))}）`)
        }
      } catch (error) {
        this.logFn(`${manifest.service}: docker stop 执行失败——${redactText(error instanceof Error ? error.message : String(error))}`)
      }
      state.containerStarted = false
    }
    // pid/log 文件清理（仅本会话启动过的服务）
    if (state.spawned) {
      this.cleanupPidFile(state)
      if (state.logFd !== undefined) {
        try { closeSync(state.logFd) } catch { /* 已关闭 */ }
        state.logFd = undefined
      }
      if (state.logFile !== undefined) {
        try { unlinkSync(state.logFile) } catch { /* 已清理/不存在 */ }
        state.logFile = undefined
      }
      state.spawned = false
    }
    state.child = undefined
    state.childExited = false
  }

  /** SIGTERM 进程组 → 宽限轮询 → SIGKILL（detached:true → 子进程为组长）。 */
  private async terminateChild(state: ServiceState): Promise<void> {
    const child = state.child
    if (child === undefined) return
    const pid = child.pid
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      if (pid === undefined) return child.kill(signal)
      try {
        process.kill(-pid, signal)
        return true
      } catch {
        // 组不存在/权限不足 → 退化为直杀子进程
        return child.kill(signal)
      }
    }
    signalGroup('SIGTERM')
    const exited = await this.awaitExit(state, state.manifest.stopGraceMs)
    if (!exited) {
      signalGroup('SIGKILL')
      await this.awaitExit(state, 1_000)
    }
  }

  /** 等待退出事件（宽限窗口内轮询；退出/超时返回）。 */
  private async awaitExit(state: ServiceState, graceMs: number): Promise<boolean> {
    const deadline = this.now() + graceMs
    for (;;) {
      if (state.childExited || state.child === undefined || (state.child.exitCode !== null)) return true
      if (this.now() >= deadline) return false
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50)
        if (typeof timer.unref === 'function') timer.unref()
      })
    }
  }

  private cleanupPidFile(state: ServiceState): void {
    if (state.pidFile === undefined) return
    try { unlinkSync(state.pidFile) } catch { /* 已清理/不存在 */ }
    state.pidFile = undefined
  }

  // ── 观测面 ──

  /** 各服务管理状态快照（零 secret：service/mode/managed/pid；live 证据用）。 */
  statusSnapshot(): Array<{
    service: CompanionServiceName
    mode: CompanionManifest['mode']
    managedBySession: boolean
    childAlive: boolean
    pid?: number
    startsInWindow: number
  }> {
    return COMPANION_SERVICES.map((name) => {
      const state = this.states.get(name)
      if (state === undefined) {
        return { service: name, mode: 'remote' as const, managedBySession: false, childAlive: false, startsInWindow: 0 }
      }
      const childAlive = state.child !== undefined && !state.childExited && state.child.exitCode === null
      this.pruneStarts(state)
      return {
        service: name,
        mode: state.manifest.mode,
        managedBySession: state.spawned || state.containerStarted,
        childAlive,
        ...(childAlive && state.child?.pid !== undefined ? { pid: state.child.pid } : {}),
        startsInWindow: state.starts.length,
      }
    })
  }

  // ── 内部 ──

  private manifestAllowed(manifest: CompanionManifest): boolean {
    return isCommandAllowlisted(manifest.command, this.allowlist)
      && (manifest.stopCommand === undefined || isCommandAllowlisted(manifest.stopCommand, this.allowlist))
      && this.commandShapeSafe(manifest.command)
      && (manifest.stopCommand === undefined || this.commandShapeSafe(manifest.stopCommand))
  }

  private manifestAllowedStop(manifest: CompanionManifest): boolean {
    return isCommandAllowlisted(manifest.stopCommand, this.allowlist) && this.commandShapeSafe(manifest.stopCommand)
  }

  /** 命令形态防御：无 shell 元字符、相对命令无 `..` 穿越（spawn 恒 shell:false 双保险）。 */
  private commandShapeSafe(command: string | undefined): boolean {
    if (command === undefined || command.trim() === '') return false
    if (/[;&|`$<>\n\r]/.test(command)) return false
    if (command.split(/[\\/]/).includes('..')) return false
    return true
  }

  /** 相对命令 → workspace 根解析；绝对/裸名原样（裸名走 PATH）。 */
  private resolveCommand(command: string): string {
    if (isAbsolute(command) || !command.includes('/')) return command
    return join(this.workspaceRoot, command)
  }

  /** 相对路径 → workspace 根解析（cwd 用）。 */
  private resolvePath(value: string): string {
    if (isAbsolute(value)) return value
    return join(this.workspaceRoot, value)
  }

  private pruneStarts(state: ServiceState): void {
    const cutoff = this.now() - this.restartWindowMs
    state.starts = state.starts.filter((at) => at > cutoff)
  }

  private probeDetail(result: HealthProbeResult): string {
    if (result.status !== undefined) return `${result.status}`
    return result.error ?? '未知原因'
  }

  private ensureStateDir(): void {
    if (existsSync(this.stateDir)) return
    try {
      mkdirSync(this.stateDir, { recursive: true })
    } catch (error) {
      this.logFn(`状态目录创建失败（pid/log 落盘跳过）——${redactText(error instanceof Error ? error.message : String(error))}`)
    }
  }

  /** 缺省设置热读：travel settings 快照 advanced 组；未注册 → undefined（=默认关闭）。 */
  private readTravelSettings(): CompanionSettingsView | undefined {
    const snapshot = travelSettingsSnapshot()
    if (snapshot === undefined) return undefined
    return {
      companionAutostart: snapshot.advanced.companionAutostart,
      companionServices: { ...snapshot.advanced.companionServices },
    }
  }
}
