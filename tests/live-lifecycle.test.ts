/**
 * M3.5 伴随服务 lifecycle live smoke（仅 TRAVEL_LIVE_SMOKE=1 时执行；缺省 skip）。
 *
 * 覆盖（W5 任务规格；**铁律：不杀外部预存服务基线**——12306:8123 / xhs 18060 容器 /
 * playwright:8931 全程只做只读健康探测，绝不 stop/restart）：
 * - 对已运行服务 ensure → already-healthy 不 spawn（rail12306 / xhs / playwright
 *   三个内建 manifest，spawn/exec 走真实实现外包 spy 计数——误拉起即计数 >0）；
 * - Didi health-only：真实探测远程端点（mcp.didichuxing.com，URL 零 key），
 *   断言零本地动作（remote 永不 spawn）；
 * - 默认关闭（companionAutostart=false）零副作用：不健康服务 + 会落 marker 的
 *   真实命令 → ensure 后 marker 不存在（真实 spawn 未发生）；
 * - start-stop-recover（**测试自己的实例**）：测试端口拉起真实 node http 服务 →
 *   ensure 拉起 + 健康等待 → stopAll（SIGTERM 进程组 + pid/log 清理）→ 端口死 →
 *   再次 ensure 恢复 → finally 复原。全程不触碰任何外部预存端口。
 *
 * 运行方式（编排者口径）：
 *   DSH_HOME=$PWD/.test-env/dsh-home TRAVEL_LIVE_SMOKE=1 npx vitest run tests/live-lifecycle.test.ts
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as realSpawn } from 'node:child_process'
import {
  CompanionSupervisor,
  type CompanionExecFn, type CompanionSpawnFn,
} from '../src/lifecycle/companion-supervisor.js'
import { COMPANION_MANIFESTS, COMPANION_SERVICES, type CompanionServiceName } from '../src/lifecycle/manifests.js'
import { probeHealthOnce } from '../src/lifecycle/health.js'
import type { ManagedChild } from '../src/lifecycle/companion-supervisor.js'

const LIVE = process.env['TRAVEL_LIVE_SMOKE'] === '1'
const run = LIVE ? describe : describe.skip

if (LIVE) {
  console.log('[live-lifecycle] TRAVEL_LIVE_SMOKE=1：真实服务探活（外部预存基线只读，不 stop）')
}

// ────────────────────────── 测试基建 ──────────────────────────

let tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/** 真实 spawn/exec 外包 spy（计数但不改行为——误拉起即计数 >0 的真实证据）。 */
function realExecSpies(): {
  spawnFn: CompanionSpawnFn
  execFn: CompanionExecFn
  counts: { spawn: number; exec: number }
} {
  const counts = { spawn: 0, exec: 0 }
  const spawnFn: CompanionSpawnFn = (command, args, options) => {
    counts.spawn += 1
    return realSpawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      stdio: options.stdio as ('ignore' | number)[] | undefined,
      shell: false,
    }) as unknown as ManagedChild
  }
  const execFn: CompanionExecFn = async (command, args, options) => {
    counts.exec += 1
    return new Promise((resolve) => {
      const child = realSpawn(command, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
      child.on('exit', (code) => { resolve({ code, stdout: out, stderr: err }) })
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, stdout: out, stderr: err }) }, options.timeoutMs)
      timer.unref()
    })
  }
  return { spawnFn, execFn, counts }
}

/** autostart 开启的设置热读。 */
function settingsOn(): { companionAutostart: boolean; companionServices: Record<CompanionServiceName, boolean> } {
  return {
    companionAutostart: true,
    companionServices: { rail12306: true, xhs: true, playwright: true, didi: true },
  }
}

// ────────────────────────── live 用例 ──────────────────────────

run('live：已运行服务 ensure → already-healthy 不 spawn（外部预存基线只读）', () => {
  it('rail12306 :8123 / xhs 18060 容器 / playwright localhost:8931 → 零拉起', async () => {
    const spies = realExecSpies()
    const supervisor = new CompanionSupervisor({
      settings: settingsOn,
      spawn: spies.spawnFn,
      exec: spies.execFn,
      stateDir: tempDir('dsh-travel-live-'),
      pollIntervalMs: 200,
      log: (message) => { console.log(`[live-lifecycle supervisor] ${message}`) },
    })
    for (const name of ['rail12306', 'xhs', 'playwright'] as const) {
      const result = await supervisor.ensure(name)
      console.log(`[live-lifecycle] ensure(${name}) → ok=${result.ok} action=${result.action} spawned=${result.spawned}`)
      expect(result.ok).toBe(true)
      expect(result.action).toBe('already-healthy')
      expect(result.spawned).toBe(false)
    }
    // 已健康 → 不产生任何 spawn/exec（误拉起即计数 >0）
    expect(spies.counts).toEqual({ spawn: 0, exec: 0 })
    await supervisor.stopAll()
  })
})

run('live：didi remote health-only（真实远程探活，零本地动作）', () => {
  it('mcp.didichuxing.com 连通性真实探测；永不 spawn（任何设置都不改变）', async () => {
    const spies = realExecSpies()
    const supervisor = new CompanionSupervisor({
      settings: settingsOn,
      spawn: spies.spawnFn,
      exec: spies.execFn,
      stateDir: tempDir('dsh-travel-live-'),
      pollIntervalMs: 200,
      log: (message) => { console.log(`[live-lifecycle supervisor] ${message}`) },
    })
    const result = await supervisor.ensure('didi')
    console.log(`[live-lifecycle] ensure(didi) → ok=${result.ok} action=${result.action} spawned=${result.spawned}（远程端点 ${COMPANION_MANIFESTS.didi.health.url}）`)
    // 远程端点当前连通（服务态故障时此 live 断言如实失败，不伪造通过）
    expect(result.ok).toBe(true)
    expect(result.action).toBe('already-healthy')
    expect(result.spawned).toBe(false)
    expect(spies.counts).toEqual({ spawn: 0, exec: 0 })
    // manifest 口径：remote 模式 + 无 command 字段
    const status = supervisor.statusSnapshot().find((row) => row.service === 'didi')
    expect(status?.mode).toBe('remote')
    await supervisor.stopAll()
  })
})

run('live：默认关闭（companionAutostart=false）零副作用', () => {
  it('不健康服务 + 会落 marker 的真实命令 → ensure 不产生任何新进程', async () => {
    const root = tempDir('dsh-travel-live-off-')
    const marker = join(root, 'marker.txt')
    // 测试端口（动态选取，避开 8123/18060/8931/3080/3081 基线）
    const port = 18900 + (process.pid % 200)
    const spies = realExecSpies()
    const supervisor = new CompanionSupervisor({
      // 默认关闭：settings 缺省（= travelSettingsSnapshot 未注册 → undefined）
      settings: () => undefined,
      manifests: {
        rail12306: {
          ...COMPANION_MANIFESTS.rail12306,
          // 若被错误拉起，该真实命令会落 marker 文件（真实副作用证据面）
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
          health: { url: `http://127.0.0.1:${port}/health`, method: 'GET', accept: 'http-ok', timeoutMs: 2000 },
          readyTimeoutMs: 2000,
        },
      },
      allowCommands: new Set([process.execPath]),
      spawn: spies.spawnFn,
      exec: spies.execFn,
      workspaceRoot: root,
      stateDir: join(root, '.dsh-travel', 'companion'),
      pollIntervalMs: 200,
      log: (message) => { console.log(`[live-lifecycle supervisor] ${message}`) },
    })
    const result = await supervisor.ensure('rail12306')
    console.log(`[live-lifecycle] 默认关闭 ensure(rail12306) → ok=${result.ok} code=${result.code ?? '-'} spawned=${result.spawned}`)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('AUTOSTART_DISABLED')
    expect(result.spawned).toBe(false)
    expect(result.reason).toContain('默认关闭')
    // 真实零副作用：无 spawn 调用、marker 未落、目标端口仍无服务
    expect(spies.counts.spawn).toBe(0)
    expect(existsSync(marker)).toBe(false)
    const deadProbe = await probeHealthOnce({ url: `http://127.0.0.1:${port}/health`, method: 'GET', accept: 'http-ok', timeoutMs: 2000 })
    expect(deadProbe.healthy).toBe(false)
  })
})

run('live：start-stop-recover（测试自己的实例；测试端口 node http 服务）', () => {
  const PORT = 19400 + (process.pid % 300)
  const HEALTH = `http://127.0.0.1:${PORT}/health`
  // 最小 http 服务：GET /health → 200（SIGTERM 默认终止，无需处理器）
  const SERVER_SCRIPT = `const http=require('http');const s=http.createServer((q,r)=>{r.writeHead(200);r.end('ok')});s.listen(${PORT},'127.0.0.1')`

  function makeSupervisor(): { supervisor: CompanionSupervisor; counts: { spawn: number; exec: number }; stateDir: string } {
    const root = tempDir('dsh-travel-live-ss-')
    const spies = realExecSpies()
    const stateDir = join(root, '.dsh-travel', 'companion')
    const supervisor = new CompanionSupervisor({
      settings: settingsOn,
      manifests: {
        rail12306: {
          ...COMPANION_MANIFESTS.rail12306,
          command: process.execPath,
          args: ['-e', SERVER_SCRIPT],
          health: { url: HEALTH, method: 'GET', accept: 'http-ok', timeoutMs: 2000 },
          readyTimeoutMs: 15_000,
          stopGraceMs: 3_000,
          guide: '测试自管实例（测试端口；非外部预存基线）。',
        },
      },
      allowCommands: new Set([process.execPath]),
      spawn: spies.spawnFn,
      exec: spies.execFn,
      workspaceRoot: root,
      stateDir,
      pollIntervalMs: 200,
      log: (message) => { console.log(`[live-lifecycle supervisor] ${message}`) },
    })
    return { supervisor, counts: spies.counts, stateDir }
  }

  it('ensure 拉起真实进程 → 健康等待 → stopAll 进程组终止 + pid/log 清理 → 再 ensure 恢复', async () => {
    // start
    const first = makeSupervisor()
    const started = await first.supervisor.ensure('rail12306')
    console.log(`[live-lifecycle] start → ok=${started.ok} action=${started.action} spawned=${started.spawned} pid=${first.supervisor.statusSnapshot().find((s) => s.service === 'rail12306')?.pid ?? '-'}`)
    expect(started.ok).toBe(true)
    expect(started.action).toBe('started')
    expect(started.spawned).toBe(true)
    const pidFile = join(first.stateDir, 'rail12306.pid')
    const logFile = join(first.stateDir, 'rail12306.log')
    expect(existsSync(pidFile)).toBe(true)
    expect(existsSync(logFile)).toBe(true)
    expect(first.counts.spawn).toBe(1)
    // 幂等：再 ensure → already-healthy（服务真活着）
    const again = await first.supervisor.ensure('rail12306')
    expect(again).toMatchObject({ ok: true, action: 'already-healthy', spawned: false })
    expect(first.counts.spawn).toBe(1)

    // stop：SIGTERM 进程组 → 端口死 → pid/log 清理
    await first.supervisor.stopAll()
    const deadProbe = await probeHealthOnce({ url: HEALTH, method: 'GET', accept: 'http-ok', timeoutMs: 2000 })
    console.log(`[live-lifecycle] stopAll 后 /health → healthy=${deadProbe.healthy}（${deadProbe.error ?? `HTTP ${deadProbe.status}`}）`)
    expect(deadProbe.healthy).toBe(false)
    expect(existsSync(pidFile)).toBe(false)
    expect(existsSync(logFile)).toBe(false)

    // recover：新 supervisor（旧实例已 dispose）再拉起同一测试端口
    const second = makeSupervisor()
    try {
      const recovered = await second.supervisor.ensure('rail12306')
      console.log(`[live-lifecycle] recover → ok=${recovered.ok} action=${recovered.action} spawned=${recovered.spawned}`)
      expect(recovered.ok).toBe(true)
      expect(recovered.spawned).toBe(true)
      const aliveProbe = await probeHealthOnce({ url: HEALTH, method: 'GET', accept: 'http-ok', timeoutMs: 2000 })
      expect(aliveProbe.healthy).toBe(true)
    } finally {
      // finally 复原：测试实例必须清理（绝不残留监听进程）
      await second.supervisor.stopAll()
    }
    const finalProbe = await probeHealthOnce({ url: HEALTH, method: 'GET', accept: 'http-ok', timeoutMs: 2000 })
    expect(finalProbe.healthy).toBe(false)
  })

  it('四服务 registry 完整（manifest 内建面 live 校验）', () => {
    expect(COMPANION_SERVICES).toEqual(['rail12306', 'xhs', 'playwright', 'didi'])
    expect(COMPANION_MANIFESTS.rail12306.mode).toBe('local-process')
    expect(COMPANION_MANIFESTS.xhs.mode).toBe('docker')
    expect(COMPANION_MANIFESTS.playwright.mode).toBe('local-process')
    expect(COMPANION_MANIFESTS.didi.mode).toBe('remote')
    // playwright 健康端点必须 localhost 字面量（Host 校验拒 127.0.0.1）
    expect(COMPANION_MANIFESTS.playwright.health.url).toBe('http://localhost:8931/mcp')
    // didi 远程端点零 key
    expect(COMPANION_MANIFESTS.didi.health.url).not.toMatch(/[?&]key=/)
  })
})
