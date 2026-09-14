/**
 * M3.5 伴随服务 supervisor 单测（fake spawn/exec/fetch，零触网、零真实进程）。
 *
 * 覆盖（执行计划 T6 Acceptance / W5 任务规格）：
 * - spawn once：重复 ensure 只 spawn 一次（幂等 already-healthy）；
 * - 并发 ensure 去重（同一服务并发调用共享 in-flight）；
 * - already-healthy 不 spawn；
 * - health timeout → 失败 + 安装指引（主流程降级不中断语义）；
 * - crash 重启上限（滑动窗口 3 次，超限 RESTART_LIMIT 不再 spawn）；
 * - remote（didi）不 spawn（任何设置都改变不了）；
 * - argv/env/日志/pid 零 secret（最小 env 白名单 + redactText 兜底）；
 * - stopAll 后进程清理（SIGTERM 信号 + 退出）+ pid/log 文件清理 + dispose 闸门；
 * - 插件 dispose 触发 supervisor.stopAll + 各 adapter close（createCompanionDisposer
 *   fake 注入 + 真实 index.apply 插件纤维 smoke）；
 * - 默认关闭（companionAutostart=false）时 ensure 零副作用（不 spawn 不 exec）；
 * - 命令不在 allowlist → 拒绝（COMMAND_NOT_ALLOWLISTED；含 `..` 穿越形态防御）；
 * - docker 模式：容器缺失 NOT_INSTALLED / 已停容器 start / stopAll 只 stop
 *   本会话启动的容器（外部预存容器不动）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  CompanionSupervisor, redactText,
  type CompanionExecFn, type CompanionExecResult, type CompanionSpawnFn,
  type ManagedChild,
} from '../src/lifecycle/companion-supervisor.js'
import { COMPANION_MANIFESTS, type CompanionManifest, type CompanionServiceName } from '../src/lifecycle/manifests.js'
import type { HealthFetchFn } from '../src/lifecycle/health.js'
import { createCompanionDisposer } from '../src/index.js'
import * as entry from '../src/index.js'
import { setDefaultUsageRecorder } from '../src/metrics/usage.js'

// ────────────────────────── 测试基建（fake spawn/exec/fetch） ──────────────────────────

let tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  setDefaultUsageRecorder(undefined)
  delete process.env.DIDI_MCP_KEY
  delete process.env.DSH_TRAVEL_ROOT
})

/** 独立临时目录。 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/** fake 托管子进程（记录信号；pid 缺省 undefined → supervisor 走 child.kill 兜底路径）。 */
class FakeChild implements ManagedChild {
  killed = false
  exitCode: number | null = null
  readonly signals: string[] = []
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  constructor(private readonly fakePid?: number) {}

  get pid(): number | undefined {
    return this.fakePid
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: string, listener: (...args: unknown[]) => void): unknown
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void)
    return this
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.signals.push(String(signal ?? 'SIGTERM'))
    this.simulateExit(null, typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }

  unref(): void { /* 测试无驻留语义 */ }

  /** 模拟进程退出（crash 场景；幂等）。 */
  simulateExit(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    for (const listener of [...this.exitListeners]) listener(code, signal)
  }
}

interface SpawnRecord {
  command: string
  args: string[]
  options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: readonly (string | number)[] }
}

interface ExecRecord {
  command: string
  args: string[]
}

/** supervisor 测试套件（fake 三件套 + 记录 + 临时目录）。 */
interface SupervisorKit {
  supervisor: CompanionSupervisor
  spawnRecords: SpawnRecord[]
  children: FakeChild[]
  execCalls: ExecRecord[]
  fetchCalls: string[]
  logs: string[]
  stateDir: string
}

interface KitOptions {
  manifests?: Partial<Record<CompanionServiceName, CompanionManifest>>
  allowCommands?: ReadonlySet<string>
  settings?: () => { companionAutostart: boolean; companionServices: Record<CompanionServiceName, boolean> } | undefined
  /** 逐次探活行为（末项重复；返回对象=HTTP 应答形态，抛错=网络失败形态）。 */
  health?: readonly FakeProbe[]
  restartLimit?: number
  restartWindowMs?: number
  pollIntervalMs?: number
}

/** fake spawn（记录 + FakeChild 收集）。 */
function makeSpawnFn(records: SpawnRecord[], children: FakeChild[]): CompanionSpawnFn {
  return (command, args, options) => {
    records.push({ command, args: [...args], options })
    const child = new FakeChild()
    children.push(child)
    return child
  }
}

/** fake exec（docker/停止脚本）：按首参分派 canned 结果。 */
function makeExecFn(canned: Partial<Record<string, CompanionExecResult>>, calls: ExecRecord[]): CompanionExecFn {
  return async (command, args) => {
    calls.push({ command, args: [...args] })
    return canned[args[0] ?? ''] ?? { code: 0, stdout: '', stderr: '' }
  }
}

/**
 * fake fetch 行为项：{status}=HTTP 应答（健康判定交回 probeHealthOnce 的 accept
 * 口径——any-response 端点任何状态码都算活）；{error}=网络失败（throw，恒不健康）。
 */
type FakeProbe = { status: number } | { error: string }

/** 网络「服务不在」形态（对 http-ok 与 any-response 两种口径都判不健康）。 */
const DOWN_NET: FakeProbe = { error: 'connect ECONNREFUSED 127.0.0.1:8123' }
/** HTTP 应答形态。 */
const UP: FakeProbe = { status: 200 }
const DOWN_HTTP: FakeProbe = { status: 503 }

/** fake fetch：按调用序返回 behavior（末项重复；不改写入参）。 */
function makeFetchFn(behavior: readonly FakeProbe[], calls: string[]): HealthFetchFn {
  return async (url) => {
    calls.push(url)
    const probe = behavior[Math.min(calls.length - 1, behavior.length - 1)]
    if (probe === undefined || 'error' in probe) {
      throw new Error(probe === undefined ? 'no behavior' : probe.error)
    }
    return { status: probe.status }
  }
}

function makeSupervisor(options: KitOptions = {}): SupervisorKit {
  const spawnRecords: SpawnRecord[] = []
  const children: FakeChild[] = []
  const execCalls: ExecRecord[] = []
  const fetchCalls: string[] = []
  const logs: string[] = []
  const behavior = [...(options.health ?? [UP])]
  const stateDir = join(tempDir('dsh-travel-sup-'), '.dsh-travel', 'companion')
  const supervisor = new CompanionSupervisor({
    manifests: options.manifests,
    allowCommands: options.allowCommands,
    settings: options.settings,
    spawn: makeSpawnFn(spawnRecords, children),
    exec: makeExecFn({}, execCalls),
    fetchFn: makeFetchFn(behavior, fetchCalls),
    now: () => Date.now(),
    pollIntervalMs: options.pollIntervalMs ?? 10,
    restartLimit: options.restartLimit,
    restartWindowMs: options.restartWindowMs,
    log: (message) => { logs.push(message) },
    stateDir,
  })
  return {
    supervisor,
    spawnRecords,
    children,
    execCalls,
    fetchCalls,
    logs,
    stateDir,
  }
}

/** autostart 开启的设置热读（全服务允许）。 */
function settingsOn(): { companionAutostart: boolean; companionServices: Record<CompanionServiceName, boolean> } {
  return {
    companionAutostart: true,
    companionServices: { rail12306: true, xhs: true, playwright: true, didi: true },
  }
}

/** rail12306 manifest 覆盖基底（local-process；command/health 测试自定）。 */
function railManifest(overrides: Partial<CompanionManifest>): CompanionManifest {
  return { ...COMPANION_MANIFESTS.rail12306, ...overrides }
}

/** 临时「命令文件」（只验证存在性；fake spawn 不真正执行）。 */
function fakeCommandFile(): string {
  const dir = tempDir('dsh-travel-cmd-')
  const file = join(dir, 'fake-mcp-server')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  return file
}


// ────────────────────────── ensure 状态机 ──────────────────────────

describe('ensure：spawn once / 幂等 / 并发去重', () => {
  it('首次 ensure 拉起 + 健康后 ok；重复 ensure → already-healthy 不再 spawn', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command, health: { ...COMPANION_MANIFESTS.rail12306.health, url: 'http://127.0.0.1:8123/health' } }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET, UP],
    })
    const first = await kit.supervisor.ensure('rail12306')
    expect(first.ok).toBe(true)
    expect(first.action).toBe('started')
    expect(first.spawned).toBe(true)
    expect(kit.spawnRecords).toHaveLength(1)
    expect(kit.spawnRecords[0]?.command).toBe(command)
    expect(kit.spawnRecords[0]?.options.detached).toBe(true)

    const second = await kit.supervisor.ensure('rail12306')
    expect(second.ok).toBe(true)
    expect(second.action).toBe('already-healthy')
    expect(second.spawned).toBe(false)
    expect(kit.spawnRecords).toHaveLength(1)
  })

  it('并发 ensure 去重：同一服务并发调用只 spawn 一次、结果共享', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET, UP],
    })
    const [a, b] = await Promise.all([kit.supervisor.ensure('rail12306'), kit.supervisor.ensure('rail12306')])
    expect(a).toEqual(b)
    expect(a.action).toBe('started')
    expect(kit.spawnRecords).toHaveLength(1)
  })

  it('already-healthy：服务健康时零 spawn/零 exec（即便 autostart 开启）', async () => {
    const kit = makeSupervisor({ settings: settingsOn, health: [UP] })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result).toMatchObject({ ok: true, action: 'already-healthy', spawned: false })
    expect(kit.spawnRecords).toHaveLength(0)
    expect(kit.execCalls).toHaveLength(0)
  })

  it('direct 托管进程存活但暂不健康 → 不重复 spawn（health timeout 判定）', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command, readyTimeoutMs: 50 }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET, DOWN_NET, DOWN_NET],
    })
    const first = await kit.supervisor.ensure('rail12306')
    expect(first.code).toBe('HEALTH_TIMEOUT')
    const second = await kit.supervisor.ensure('rail12306')
    expect(second.code).toBe('HEALTH_TIMEOUT')
    // 进程活着 → 不再 spawn（防进程堆积）
    expect(kit.spawnRecords).toHaveLength(1)
  })
})

describe('ensure：失败路径（降级不中断语义）', () => {
  it('health timeout → ok=false + HEALTH_TIMEOUT + 安装指引（reason 含 guide）', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command, readyTimeoutMs: 40 }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET, DOWN_NET],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('HEALTH_TIMEOUT')
    expect(result.spawned).toBe(true)
    expect(result.reason).toContain('手动启动')
    expect(kit.logs.some((line) => line.includes('未就绪'))).toBe(true)
  })

  it('本地命令文件不存在 → NOT_INSTALLED（不 spawn）', async () => {
    const missing = join(tempDir('dsh-travel-missing-'), 'no-such-binary')
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command: missing }) },
      allowCommands: new Set([missing]),
      settings: settingsOn,
      health: [DOWN_NET],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.code).toBe('NOT_INSTALLED')
    expect(kit.spawnRecords).toHaveLength(0)
  })

  it('per-service toggle 关闭 → SERVICE_DISABLED（autostart 开启时才生效的闸门）', async () => {
    const kit = makeSupervisor({
      settings: () => ({
        companionAutostart: true,
        companionServices: { rail12306: false, xhs: true, playwright: true, didi: true },
      }),
      health: [DOWN_NET],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.code).toBe('SERVICE_DISABLED')
    expect(kit.spawnRecords).toHaveLength(0)
  })
})

describe('crash 重启上限（滑动窗口）', () => {
  it('窗口内 3 次启动后第 4 次 → RESTART_LIMIT，不再 spawn；pid 文件随 crash 清理', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command, readyTimeoutMs: 30 }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET],
      restartLimit: 3,
      restartWindowMs: 60_000,
    })
    const codes: Array<string | undefined> = []
    for (let round = 0; round < 4; round += 1) {
      const result = await kit.supervisor.ensure('rail12306')
      codes.push(result.code)
      if (round < 3) {
        // 模拟 crash：进程退出（exit 监听 → childExited + pid 文件清理）
        kit.children[round]?.simulateExit(null, 'SIGKILL')
      }
    }
    expect(codes).toEqual(['HEALTH_TIMEOUT', 'HEALTH_TIMEOUT', 'HEALTH_TIMEOUT', 'RESTART_LIMIT'])
    expect(kit.spawnRecords).toHaveLength(3)
    const fourth = kit.logs.filter((line) => line.includes('上限'))
    expect(fourth.length).toBeGreaterThan(0)
  })
})

describe('remote 服务（didi）：health-only，绝不 spawn', () => {
  it('不可达 → PROBE_FAILED（零 spawn 零 exec，autostart 开启也不改变）', async () => {
    const kit = makeSupervisor({ settings: settingsOn, health: [DOWN_NET] })
    const result = await kit.supervisor.ensure('didi')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('PROBE_FAILED')
    expect(result.spawned).toBe(false)
    expect(kit.spawnRecords).toHaveLength(0)
    expect(kit.execCalls).toHaveLength(0)
    expect(result.reason).toContain('远程')
  })

  it('可达 → already-healthy（只探活，零本地动作）', async () => {
    const kit = makeSupervisor({ settings: settingsOn, health: [UP] })
    const result = await kit.supervisor.ensure('didi')
    expect(result).toMatchObject({ ok: true, action: 'already-healthy', spawned: false })
    expect(kit.spawnRecords).toHaveLength(0)
  })
})

// ────────────────────────── 安全面（allowlist / secret） ──────────────────────────

describe('命令 allowlist（内建固定命令；拒绝一切拼接口径）', () => {
  it('命令不在 allowlist → COMMAND_NOT_ALLOWLISTED，零 spawn/零 exec', async () => {
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command: '/bin/definitely-not-allowlisted' }) },
      settings: settingsOn,
      health: [DOWN_NET],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('COMMAND_NOT_ALLOWLISTED')
    expect(kit.spawnRecords).toHaveLength(0)
    expect(kit.execCalls).toHaveLength(0)
  })

  it('即便把 `..` 穿越命令加入 allowlist，形态防御仍拒绝（无 shell 元字符/无穿越）', async () => {
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command: '../escape/bin/tool' }) },
      allowCommands: new Set(['../escape/bin/tool']),
      settings: settingsOn,
      health: [DOWN_NET],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.code).toBe('COMMAND_NOT_ALLOWLISTED')
    expect(kit.spawnRecords).toHaveLength(0)
  })
})

describe('secret 面约束（argv/env/日志/pid 零泄漏）', () => {
  it('子进程 env 走最小白名单 + manifest.env；宿主敏感 env（DIDI_MCP_KEY）不透传', async () => {
    process.env.DIDI_MCP_KEY = 'SUPERSECRET-VALUE-123'
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET, UP],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.ok).toBe(true)
    const env = kit.spawnRecords[0]?.options.env ?? {}
    expect(env['DIDI_MCP_KEY']).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('SUPERSECRET-VALUE-123')
    expect(env['SERVER_HOST']).toBe('127.0.0.1')
    expect(env['SERVER_PORT']).toBe('8123')
    // argv = manifest 固定 args（空），无任何设置字符串拼接
    expect(kit.spawnRecords[0]?.args).toEqual([])
    expect(JSON.stringify(kit.spawnRecords)).not.toContain('SUPERSECRET-VALUE-123')
  })

  it('pid 文件只含 service/pid/startedAt；日志与 reason 经 redactText 兜底', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: {
        rail12306: railManifest({ command, readyTimeoutMs: 40, args: [] }),
      },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [{ error: 'connect ECONNREFUSED key=SECRETVAL-in-error' }],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.code).toBe('HEALTH_TIMEOUT')
    // reason（fetch 层 message 含 key= 形态）→ 出闸前已脱敏
    expect(result.reason).not.toContain('SECRETVAL-in-error')
    expect(result.reason).toContain('手动启动')
    // 日志同样脱敏
    expect(kit.logs.join('\n')).not.toContain('SECRETVAL-in-error')
    // pid 文件零 args/env/secret
    const pidFile = join(kit.stateDir, 'rail12306.pid')
    expect(existsSync(pidFile)).toBe(true)
    const pidContent = readFileSync(pidFile, 'utf8')
    const parsed = JSON.parse(pidContent) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['pid', 'service', 'startedAt'])
  })

  it('redactText 纯函数：key/token/cookie/authorization 赋值形态打码', () => {
    expect(redactText('api key=ABC123 and token: TOK-XYZ')).not.toContain('ABC123')
    expect(redactText('api key=ABC123 and token: TOK-XYZ')).not.toContain('TOK-XYZ')
    expect(redactText('cookie=SID-1; authorization Bearer sk-abcdefghijklmnop')).toBe('cookie=<redacted>; authorization Bearer <redacted>')
  })
})

// ────────────────────────── stopAll / dispose ──────────────────────────

describe('stopAll / dispose（进程清理 + pid/log 清理 + 卸载闸门）', () => {
  it('stopAll：SIGTERM → 进程退出 → pid/log 文件删除；重复调用无害；dispose 后 ensure = DISPOSED', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command, stopGraceMs: 500 }) },
      allowCommands: new Set([command]),
      settings: settingsOn,
      health: [DOWN_NET, UP],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.ok).toBe(true)
    const child = kit.children[0]
    expect(child).toBeDefined()
    const pidFile = join(kit.stateDir, 'rail12306.pid')
    const logFile = join(kit.stateDir, 'rail12306.log')
    expect(existsSync(pidFile)).toBe(true)
    expect(existsSync(logFile)).toBe(true)

    await kit.supervisor.stopAll()
    expect(child?.killed).toBe(true)
    expect(child?.signals).toContain('SIGTERM')
    expect(existsSync(pidFile)).toBe(false)
    expect(existsSync(logFile)).toBe(false)
    const status = kit.supervisor.statusSnapshot().find((s) => s.service === 'rail12306')
    expect(status?.managedBySession).toBe(false)
    expect(status?.childAlive).toBe(false)

    // 重复 stopAll 无害；dispose 后 ensure 一律 DISPOSED（不再产生任何新进程）
    await kit.supervisor.stopAll()
    const after = await kit.supervisor.ensure('rail12306')
    expect(after.code).toBe('DISPOSED')
    expect(kit.spawnRecords).toHaveLength(1)
  })

  it('daemon 化脚本（stopCommand）：stopAll 走脚本内建 stop，且仅处置本会话启动的实例', async () => {
    const script = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: {
        playwright: {
          ...COMPANION_MANIFESTS.playwright,
          command: script,
          stopCommand: script,
          args: ['start'],
          stopArgs: ['stop'],
          health: { ...COMPANION_MANIFESTS.playwright.health, url: 'http://localhost:8931/mcp' },
        },
      },
      allowCommands: new Set([script]),
      settings: settingsOn,
      health: [DOWN_NET, UP],
    })
    const result = await kit.supervisor.ensure('playwright')
    expect(result.ok).toBe(true)
    expect(kit.spawnRecords[0]?.args).toEqual(['start'])
    await kit.supervisor.stopAll()
    const stopCall = kit.execCalls.find((call) => call.args[0] === 'stop')
    expect(stopCall).toBeDefined()
    expect(stopCall?.args).toEqual(['stop'])
  })

  it('外部预存服务（非本会话启动）：stopAll 零处置（already-healthy 后直接 stopAll）', async () => {
    const kit = makeSupervisor({ settings: settingsOn, health: [UP] })
    await kit.supervisor.ensure('rail12306')
    await kit.supervisor.stopAll()
    expect(kit.spawnRecords).toHaveLength(0)
    expect(kit.execCalls).toHaveLength(0)
    expect(existsSync(join(kit.stateDir, 'rail12306.pid'))).toBe(false)
  })
})

describe('docker 模式（xhs）：只 start/stop 已安装容器，外部预存容器不动', () => {
  it('容器不存在 → NOT_INSTALLED（绝不联网安装/新建容器）', async () => {
    const execCalls: ExecRecord[] = []
    const kit = makeSupervisorWithExec({
      settings: settingsOn,
      health: [DOWN_NET, UP],
      canned: { ps: { code: 0, stdout: '', stderr: '' } },
      execCalls,
    })
    const result = await kit.supervisor.ensure('xhs')
    expect(result.code).toBe('NOT_INSTALLED')
    expect(result.reason).toContain('不存在')
    expect(execCalls.some((call) => call.args[0] === 'start')).toBe(false)
  })

  it('已安装但停止的容器 → docker start → 健康后 ok；stopAll → docker stop（本会话启动）', async () => {
    const execCalls: ExecRecord[] = []
    const kit = makeSupervisorWithExec({
      settings: settingsOn,
      health: [DOWN_NET, UP],
      canned: { ps: { code: 0, stdout: 'abc123\tExited (0) 2 hours ago', stderr: '' } },
      execCalls,
    })
    const result = await kit.supervisor.ensure('xhs')
    expect(result).toMatchObject({ ok: true, action: 'started', spawned: true })
    expect(execCalls.some((call) => call.args[0] === 'start' && call.args[1] === 'xiaohongshu-mcp')).toBe(true)
    await kit.supervisor.stopAll()
    expect(execCalls.some((call) => call.args[0] === 'stop' && call.args[1] === 'xiaohongshu-mcp')).toBe(true)
  })

  it('外部预存 Up 容器 → 不 start；health 等待失败/stopAll 均不 stop（M2 基线保护）', async () => {
    const execCalls: ExecRecord[] = []
    const kit = makeSupervisorWithExec({
      settings: settingsOn,
      health: [DOWN_NET, DOWN_NET],
      canned: { ps: { code: 0, stdout: 'abc123\tUp 32 hours', stderr: '' } },
      execCalls,
      manifests: { xhs: { ...COMPANION_MANIFESTS.xhs, readyTimeoutMs: 60 } },
    })
    const result = await kit.supervisor.ensure('xhs')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('HEALTH_TIMEOUT')
    expect(result.spawned).toBe(false)
    expect(execCalls.some((call) => call.args[0] === 'start')).toBe(false)
    await kit.supervisor.stopAll()
    expect(execCalls.some((call) => call.args[0] === 'stop')).toBe(false)
  })

  it('docker 查询失败（守护进程不可用）→ START_FAILED', async () => {
    const kit = makeSupervisorWithExec({
      settings: settingsOn,
      health: [DOWN_NET],
      canned: { ps: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } },
    })
    const result = await kit.supervisor.ensure('xhs')
    expect(result.code).toBe('START_FAILED')
  })
})

/** docker 用例专用装配（自定义 exec canned / manifest 覆盖；其余同 makeSupervisor）。 */
function makeSupervisorWithExec(options: {
  settings: () => { companionAutostart: boolean; companionServices: Record<CompanionServiceName, boolean> } | undefined
  health: readonly FakeProbe[]
  canned: Partial<Record<string, CompanionExecResult>>
  execCalls?: ExecRecord[]
  manifests?: Partial<Record<CompanionServiceName, CompanionManifest>>
}): { supervisor: CompanionSupervisor; execCalls: ExecRecord[] } {
  const execCalls = options.execCalls ?? []
  const fetchCalls: string[] = []
  const supervisor = new CompanionSupervisor({
    manifests: options.manifests,
    settings: options.settings,
    exec: makeExecFn(options.canned, execCalls),
    fetchFn: makeFetchFn([...options.health], fetchCalls),
    pollIntervalMs: 10,
    stateDir: tempDir('dsh-travel-docker-'),
    log: () => {},
  })
  return { supervisor, execCalls }
}

// ────────────────────────── 默认关闭（M2 行为保持） ──────────────────────────

describe('默认关闭（companionAutostart=false）：ensure 零副作用', () => {
  it('设置缺省（undefined=默认关闭）→ 不健康服务返回 AUTOSTART_DISABLED + 指引，零 spawn/零 exec', async () => {
    const command = fakeCommandFile()
    const kit = makeSupervisor({
      manifests: { rail12306: railManifest({ command }) },
      allowCommands: new Set([command]),
      settings: () => undefined,
      health: [DOWN_NET],
    })
    const result = await kit.supervisor.ensure('rail12306')
    expect(result.ok).toBe(false)
    expect(result.action).toBe('skipped')
    expect(result.code).toBe('AUTOSTART_DISABLED')
    expect(result.spawned).toBe(false)
    expect(result.reason).toContain('默认关闭')
    expect(result.reason).toContain('手动启动')
    expect(kit.spawnRecords).toHaveLength(0)
    expect(kit.execCalls).toHaveLength(0)
    // 只做了只读健康探测
    expect(kit.fetchCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ────────────────────────── 插件 dispose 接线 ──────────────────────────

describe('插件 dispose 触发 supervisor.stopAll + 各 adapter close', () => {
  it('createCompanionDisposer：先 stopAll 再逐 adapter close；单个 close 失败不阻塞其余', async () => {
    const order: string[] = []
    const logs: string[] = []
    const disposer = createCompanionDisposer({
      supervisor: { stopAll: async () => { order.push('stopAll') } },
      adapters: [
        { name: 'rail12306', close: async () => { order.push('rail12306') } },
        { name: 'xhs', close: () => Promise.reject(new Error('boom-session')) },
        { name: 'social-playwright', close: async () => { order.push('social-playwright') } },
        { name: 'didi', close: async () => { order.push('didi') } },
      ],
      log: (message) => { logs.push(message) },
    })
    await disposer()
    expect(order[0]).toBe('stopAll')
    expect(order.filter((step) => step !== 'stopAll')).toEqual(['rail12306', 'social-playwright', 'didi'])
    expect(logs.some((line) => line.includes('xhs 会话收尾失败'))).toBe(true)
  })

  it('真实 index.apply 插件纤维：加载/卸载全链路 smoke（默认关闭零进程副作用）', async () => {
    const root = tempDir('dsh-travel-apply-')
    process.env.DSH_TRAVEL_ROOT = root
    const ctx = new Context()
    ctx.provide('tools', { register: () => {} })
    ctx.provide('web', { search: async () => ({ content: '', sources: [], truncated: false }) })
    ctx.provide('webServer', { register: () => {} })
    const fiber = ctx.plugin(entry)
    await fiber
    await fiber.dispose()
    // 卸载后工作区零伴随服务 pid/log 残留
    expect(existsSync(join(root, '.dsh-travel', 'companion'))).toBe(false)
  })
})
