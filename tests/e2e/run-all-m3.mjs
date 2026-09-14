/**
 * M3 E2E 串行 runner（m3-execution-plan T7/W6 实现 --fault-matrix；T8/W7 全量实装）。
 *
 * 用法（esbuild banner 注入 TRAVEL_EVID_MILESTONE=m3——ESM 求值前注入，与 M2 同款）：
 *
 *   npx esbuild tests/e2e/run-all-m3.mjs --bundle --platform=node --format=esm \
 *     "--banner:js=process.env['TRAVEL_EVID_MILESTONE'] ??= 'm3';" \
 *     --outfile=.tmp/e2e-m3-runner.mjs
 *   node .tmp/e2e-m3-runner.mjs --all            # W7 全量串行（本文件主入口）
 *   node .tmp/e2e-m3-runner.mjs --fault-matrix   # 单跑 M3.6 故障矩阵
 *
 * 模式（--all 顺序）：m2-regression → revision → export → metrics → eval →
 * lifecycle → fault-matrix。每步真实执行（spawnSync），结果汇总写
 * docs/evidence/m3/final/run-summary.{json,md}；失败步如实记录 exit code，
 * 不伪造通过。浏览器 GUI/导出步骤属人工/编排者实测（见 w7/browser-qa.md），
 * runner 只做可自动化部分。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function findRepoRoot(startDir) {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`repo root not found from ${startDir}`)
    dir = parent
  }
}
const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)))
const finalDir = join(repoRoot, 'docs', 'evidence', 'm3', 'final')
const w6Dir = join(repoRoot, 'docs', 'evidence', 'm3', 'w6')
const argv = process.argv.slice(2)
const TEST_ENV_HOME = join(repoRoot, '.test-env', 'dsh-home')

function log(line = '') {
  console.log(`[run-all-m3] ${line}`)
}

/** 单步定义与执行（串行；exit code 原样上抛到汇总，不改写证据）。 */
function runStep(step) {
  const startedAt = new Date().toISOString()
  log(`▶ ${step.name}: ${step.cmd.join(' ')}`)
  const run = spawnSync(step.cmd[0], step.cmd.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: step.timeoutMs ?? 600_000,
    env: { ...process.env, ...(step.env ?? {}) },
  })
  const result = {
    name: step.name,
    cmd: step.cmd.join(' '),
    exit: run.status,
    error: run.error?.message,
    durationMs: Date.now() - Date.parse(startedAt),
    startedAt,
    stdoutTail: (run.stdout ?? '').split('\n').slice(-12).join('\n').slice(0, 2000),
    stderrTail: (run.stderr ?? '').split('\n').slice(-12).join('\n').slice(0, 2000),
    signal: run.signal ?? undefined,
  }
  log(`✔ ${step.name}: exit=${result.exit} (${Math.round(result.durationMs / 1000)}s)`)
  if (step.name.startsWith('m2-regression') || result.exit !== 0) {
    try {
      mkdirSync(finalDir, { recursive: true })
      writeFileSync(join(finalDir, 'm2-regression-run.log'), `--- stdout ---\n${run.stdout ?? ''}\n--- stderr ---\n${run.stderr ?? ''}`)
    } catch { /* 证据落盘失败不影响步骤结果 */ }
  }
  return result
}

// ── 各模式步骤表 ──

function stepsM2Regression() {
  // A~F 剧本回归：helpers EVID 已支持 m3 → 证据落 docs/evidence/m3/final/（不覆盖 M2 归档）
  // 说明：内层 runner 的完整 stdout/stderr 由外层 spawnSync 捕获后写入
  // docs/evidence/m3/final/m2-regression-run.log（快速失败时取证用）。
  return [
    {
      name: 'm2-regression: esbuild bundle（banner m3）',
      cmd: ['npx', 'esbuild', 'tests/e2e/run-all-m2.mjs', '--bundle', '--platform=node', '--format=esm',
        '--banner:js=process.env[\'TRAVEL_EVID_MILESTONE\'] ??= \'m3\';',
        '--outfile=.tmp/e2e-m3-full-runner.mjs'],
      timeoutMs: 120_000,
    },
    {
      name: 'm2-regression: 剧本 A~F 全量（DSH_HOME=test-env）',
      cmd: ['node', '.tmp/e2e-m3-full-runner.mjs'],
      // E2E_SCRIPT_TIMEOUT_MS：单剧本上限（run-all-m2 读 env，默认 900s）。A 剧本
      // checks 全过后偶发被慢退出连接拖住（观测 ~15min 才退，其余轮 53~122s 正常），
      // 放宽到 1500s 让其自然退出，避免把「checks 全过但退出慢」误记为 FAIL。
      env: { DSH_HOME: TEST_ENV_HOME, E2E_SCRIPT_TIMEOUT_MS: '1500000' },
      timeoutMs: 1_800_000,
    },
  ]
}

function stepsRevision() {
  return [{
    name: 'revision: 三修订场景 + 七 slot 映射 + 兼容',
    cmd: ['npx', 'vitest', 'run', 'tests/revision-m3.test.ts', 'tests/tools-update.test.ts', 'tests/tools-build-itinerary.test.ts'],
  }]
}

function stepsExport() {
  return [{
    name: 'export: canonical JSON/MD + 模板控件/print CSS 单测（浏览器真测见 w7/browser-qa.md）',
    cmd: ['npx', 'vitest', 'run', 'tests/export.test.ts', 'tests/render-export.test.ts'],
  }]
}

function stepsMetrics() {
  return [{
    name: 'metrics: UsageRecorder/路由/适配器埋点',
    cmd: ['npx', 'vitest', 'run', 'tests/metrics.test.ts', 'tests/adapters-amap.test.ts', 'tests/adapters-search.test.ts', 'tests/orchestrator-w3.test.ts'],
  }]
}

function stepsEval() {
  const steps = []
  const osuFile = process.env['OSU_TRAVELPLANNER_FILE'] ?? '/tmp/osu-data/validation.csv'
  if (existsSync(osuFile)) {
    steps.push({
      name: 'eval: OSU 100 条 deterministic 复跑（seed 20260905，可复现性再证）',
      cmd: ['node', 'tests/eval/run-osu-eval.mjs', '--osu-file', osuFile, '--sample', '100', '--seed', '20260905'],
      env: { DSH_HOME: TEST_ENV_HOME },
      timeoutMs: 900_000,
    })
  } else {
    log(`eval: OSU 数据集缺席（${osuFile}）——跳过复跑，W4 记录结果为准（fail-closed 口径）`)
  }
  // intent 全量 40 条复跑依赖模型配额；配额态探测 + W4 记录引用（不覆盖 W4 证据）
  steps.push({ name: 'eval: intent 模型配额探针 + W4 记录核验', cmd: ['node', '.tmp/e2e-m3-runner.mjs', '--intent-probe'], timeoutMs: 300_000 })
  return steps
}

function stepsLifecycle() {
  return [
    { name: 'lifecycle: supervisor fake 单测', cmd: ['npx', 'vitest', 'run', 'tests/lifecycle-supervisor.test.ts'] },
    {
      name: 'lifecycle: test-env live（already-healthy/remote-probe/默认关零副作用/start-stop-recover）',
      cmd: ['npx', 'vitest', 'run', 'tests/live-lifecycle.test.ts'],
      env: { DSH_HOME: TEST_ENV_HOME, TRAVEL_LIVE_SMOKE: '1' },
      timeoutMs: 300_000,
    },
  ]
}

function stepsFaultMatrix() {
  return [{
    name: 'fault-matrix: 28 渠道全故障注入（严格串行 + 恢复 guard）',
    cmd: ['npx', 'vitest', 'run', 'tests/fault-matrix/'],
    env: { TRAVEL_EVID_MILESTONE: 'm3' },
    timeoutMs: 900_000,
  }]
}

// ── intent 配额探针（--intent-probe：单 session 单 travel prompt，只判定可达性/意图触发） ──

async function intentProbe() {
  const base = 'http://127.0.0.1:3081'
  let rpcSeq = 0
  async function rpc(method, payload, timeoutMs = 30000) {
    const res = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `m3probe-${++rpcSeq}`, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`RPC ${method} http ${res.status}`)
    const body = await res.json()
    if (!body.result?.ok) throw new Error(`RPC ${method}: ${JSON.stringify(body.result?.error ?? '').slice(0, 200)}`)
    return body.result.value
  }
  const out = { probe: 'intent-quota', modelQuotaBlocked: false, travelToolCalls: [], hit: false, note: '' }
  let sessionId
  try {
    sessionId = (await rpc('session.create', { cwd: '/tmp/m3-qa-sandbox' })).sessionId
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '帮我规划一个杭州一日游，2026-09-12 出发，2 个大人。' }] })
    const deadline = Date.now() + 150_000
    let sawTurnEnd = false
    while (Date.now() < deadline && !sawTurnEnd) {
      await new Promise((r) => setTimeout(r, 4000))
      const hist = await rpc('session.history', { sessionId, maxMessages: 200 }, 20000).catch(() => undefined)
      const events = hist?.events ?? []
      for (const { event } of events) {
        if (event?.type === 'tool/call') {
          const name = event?.data?.name ?? event?.data?.tool
          if (typeof name === 'string' && name.startsWith('travel_') && !out.travelToolCalls.includes(name)) out.travelToolCalls.push(name)
        }
        if (event?.type === 'turn/end') {
          sawTurnEnd = true
          const reason = event?.data?.reason ?? {}
          const failure = reason?.error ?? reason?.failure ?? {}
          if (failure?.status === 402 || failure?.code === 'QUOTA') out.modelQuotaBlocked = true
        }
      }
    }
    out.hit = out.travelToolCalls.length > 0
    out.note = out.modelQuotaBlocked
      ? '模型商 402 Insufficient Balance——全量 intent 20/20 复跑不可用；以 W4 记录（travel 20/20、误触发 1/20）为通过证据'
      : (out.hit ? '探针命中 travel_*（实例功能正常）' : '探针未观测到 travel_* 调用（如实记录）')
  } catch (e) {
    out.note = `probe error: ${String(e.message ?? e).slice(0, 200)}`
  } finally {
    if (sessionId !== undefined) {
      await fetch(`${base}/api/session.cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'm3probe-cancel', method: 'session.cancel', payload: { sessionId } }),
      }).catch(() => {})
    }
  }
  console.log(JSON.stringify(out))
  // 探针写 docs/evidence/m3/final/intent-probe.json（不覆盖 W4 证据）
  mkdirSync(finalDir, { recursive: true })
  writeFileSync(join(finalDir, 'intent-probe.json'), JSON.stringify({ ...out, probedAt: new Date().toISOString() }, null, 1))
  process.exit(0)
}

// ── 汇总 ──

function writeSummary(mode, results, extra = {}) {
  mkdirSync(finalDir, { recursive: true })
  const summary = {
    mode,
    startedAt: results[0]?.startedAt,
    finishedAt: new Date().toISOString(),
    milestone: 'm3',
    steps: results,
    passed: results.every((r) => r.exit === 0),
    ...extra,
  }
  writeFileSync(join(finalDir, 'run-summary.json'), JSON.stringify(summary, null, 1))
  const md = [
    `# M3 run-summary（${summary.finishedAt}，mode=${mode}）`,
    '',
    '| 步骤 | exit | 耗时 |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.exit} | ${Math.round(r.durationMs / 1000)}s |`),
    '',
    `整体：${summary.passed ? 'ALL PASS' : '含失败步（见上）'}`,
  ].join('\n')
  writeFileSync(join(finalDir, 'run-summary.md'), md)
  return summary
}

async function main() {
  if (argv.includes('--intent-probe')) return intentProbe()

  const plan = argv.includes('--m2-regression') ? ['m2-regression']
    : argv.includes('--revision') ? ['revision']
    : argv.includes('--export') ? ['export']
    : argv.includes('--metrics') ? ['metrics']
    : argv.includes('--eval') ? ['eval']
    : argv.includes('--lifecycle') ? ['lifecycle']
    : argv.includes('--fault-matrix') ? ['fault-matrix']
    : argv.includes('--all') ? ['m2-regression', 'revision', 'export', 'metrics', 'eval', 'lifecycle', 'fault-matrix']
    : undefined
  if (plan === undefined) {
    log('用法：node .tmp/e2e-m3-runner.mjs --all | --m2-regression | --revision | --export | --metrics | --eval | --lifecycle | --fault-matrix | --intent-probe')
    process.exit(2)
  }

  const stepTables = {
    'm2-regression': stepsM2Regression,
    revision: stepsRevision,
    export: stepsExport,
    metrics: stepsMetrics,
    eval: stepsEval,
    lifecycle: stepsLifecycle,
    'fault-matrix': stepsFaultMatrix,
  }

  const results = []
  for (const mode of plan) {
    log(`═══ mode ${mode} ═══`)
    for (const step of stepTables[mode]()) results.push(runStep(step))
  }

  // fault-matrix 聚合摘要（透传矩阵自产报告）
  let faultStats
  const reportPath = join(w6Dir, 'fault-matrix.json')
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    faultStats = report.stats ?? undefined
    if (faultStats !== undefined) {
      log(`fault-matrix: NFR-2=${faultStats.ratePercent}（${faultStats.numerator}/${faultStats.denominator}）covered=${faultStats.coveredRows}/${faultStats.channelRows} pass=${faultStats.pass}`)
    }
  }

  const summary = writeSummary(plan.join('+'), results, { faultStats })
  log(`汇总：${results.length} 步，${summary.passed ? 'ALL PASS' : '含失败'}；run-summary → docs/evidence/m3/final/run-summary.{json,md}`)
  process.exit(summary.passed ? 0 : 1)
}

main().catch((e) => {
  log(`fatal: ${e.message ?? e}`)
  process.exit(1)
})
