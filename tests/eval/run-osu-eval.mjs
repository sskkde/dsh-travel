/**
 * M3.4 / W4 —— OSU TravelPlanner 回归评测 runner（结构化流水线 + 分离 live canary）。
 *
 * 用法（Verification strategy M3.4 OSU 行）：
 *   node tests/eval/run-osu-eval.mjs --osu-file "$OSU_TRAVELPLANNER_FILE" --sample 100 --seed 20260905
 *   可选：--out docs/evidence/m3/w4 --canary 3 --skip-live --limit <n>（调试抽前 n 条）
 *
 * 数据获取（优先级，规格同 T5）：
 *   a) --osu-file / 环境变量 OSU_TRAVELPLANNER_FILE 指向的本地文件（CSV/JSONL）；
 *   b) 固定 revision 下载到 /tmp/（数据集不进 git、不进生产包）。
 *      上游事实（已核验 2026-09-05）：1,225 条查询由上游代码经
 *      `load_dataset('osunlp/TravelPlanner')` 从 **HuggingFace** 装载；GitHub 仓库
 *      （OSU-NLP-Group/TravelPlanner，MIT）hosting 的是环境数据库（ref_info/jsonl）
 *      与评测工具链，任意 commit 均不含查询数据。故固定源为 HF 数据集 pinned
 *      revision（validation split，180 条全结构化字段），URL/revision/SHA256 全记录。
 *      —— 此为对「GitHub raw 下载」字面路径的诚实偏离，理由与归属在报告中说明。
 *   c) 均失败 → fail closed：写 osu-blocked.md（明确 blocked + 获取指引），不伪造结果。
 *
 * 抽样：固定 seed 分层抽样（分层维度 days × level × visiting_city_number，比例分配
 *   + 最大余数补齐）；「国内单目的地」口径见 osu-adapter.mjs singleDestinationFilter
 *   与报告说明（数据集全部任务为美国国内单 dest 值任务；严格单城子集 vcn==1 单列）。
 * 流水线：intake → fixture research（合成渠道数据注入 store）→ build → render
 *   contract；每条记录成功/失败与失败阶段（schema/state/constraint/render）+ 裸异常。
 * live canary：分离的 3 条真实联网研究路径（tencent-poi 体验通道 + cn.bing L0），
 *   失败只记录 live 状态，不并入 deterministic 成功率。
 * 输出：osu-manifest.json（运行前固化 100 条 ID）、osu-results.{json,md} → docs/evidence/m3/w4/。
 *
 * 纪律：零 key（全流程零凭据读取、零打印）；生产 3080 与 test-env 实例均不触碰
 *   （纯本地流水线，不经宿主）；OSU 原始数据不进 git。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildLiveCanaryChannels, parseDatasetFile, runDeterministicPipeline,
  sha256, singleDestinationFilter, stratifiedSample,
} from './osu-adapter.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dir, '..', '..')

// ── 上游固定源（pinned；变更需评审并更新 manifest） ──
const UPSTREAM = {
  codeRepo: 'https://github.com/OSU-NLP-Group/TravelPlanner',
  codeLicense: 'MIT',
  codeCommit: 'e52c87f4ac348a3410c46dc3553c519db5ec5e23', // main @ 2026-05-24（核验日最新）
  datasetRepo: 'https://huggingface.co/datasets/osunlp/TravelPlanner',
  datasetRevision: '8736504ecfc31b7f8b7e40122873c337e83fff7c', // HF dataset pinned revision（2024-07-14）
  datasetLicense: 'CC-BY-4.0',
  file: 'validation.csv', // 180 条全结构化字段（org/dest/days/vcn/date/people/budget/local_constraint/level/query）
  note: '1,225 条查询由上游代码从 HF 装载（agents/greedy_search.py load_dataset）；GitHub 仓库不含查询数据，仅环境数据库与评测工具链。',
}

const DEFAULT_SOURCES = [
  {
    name: `${UPSTREAM.datasetRepo}/resolve/${UPSTREAM.datasetRevision}/${UPSTREAM.file}`,
    url: `${UPSTREAM.datasetRepo}/resolve/${UPSTREAM.datasetRevision}/${UPSTREAM.file}`,
  },
]

// ── CLI ──
function parseArgs(argv) {
  const args = { osuFile: process.env.OSU_TRAVELPLANNER_FILE, sample: 100, seed: 20260905, canary: 3, skipLive: false, limit: undefined, out: join(REPO, 'docs', 'evidence', 'm3', 'w4') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--osu-file') {
      const value = argv[++i]
      // 空串（常见于未导出的 "$VAR" shell 展开）视为未提供，回落 env/固定源
      if (value !== undefined && value.trim() !== '') args.osuFile = resolve(value)
    } else if (a === '--sample') args.sample = Number(argv[++i])
    else if (a === '--seed') args.seed = Number(argv[++i])
    else if (a === '--canary') args.canary = Number(argv[++i])
    else if (a === '--skip-live') args.skipLive = true
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--out') args.out = resolve(argv[++i])
    else throw new Error(`未知参数：${a}`)
  }
  return args
}
const args = parseArgs(process.argv.slice(2))

const DOWNLOAD_DIR = '/tmp/dsh-osu-eval'

async function downloadPinned() {
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  const dest = join(DOWNLOAD_DIR, `travelplanner-${UPSTREAM.datasetRevision.slice(0, 10)}-${UPSTREAM.file}`)
  for (const source of DEFAULT_SOURCES) {
    try {
      const res = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const text = await res.text()
      if (!/query/.test(text.slice(0, 2000))) throw new Error('响应首屏不含 query 字段（非数据文件？）')
      writeFileSync(dest, text)
      console.log(`[osu] 下载成功：${source.url} → ${dest}（${text.length} bytes）`)
      return { file: dest, url: source.url }
    } catch (err) {
      console.error(`[osu] 下载失败 ${source.name}：${err instanceof Error ? err.message : err}`)
    }
  }
  return undefined
}

/** fail closed：blocked 报告 + 非零退出；intent 部分不受影响（独立 runner）。 */
function failClosed(reason) {
  mkdirSync(args.out, { recursive: true })
  const md = [
    '# M3.4 OSU 回归评测 —— BLOCKED（fail closed）',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 原因：${reason}`,
    '',
    '## 获取指引（复跑前置）',
    '',
    '1. 本地文件路径（优先）:',
    '   ```bash',
    '   export OSU_TRAVELPLANNER_FILE=/path/to/validation.csv   # 或任意 TravelPlanner 查询 CSV/JSONL',
    '   node tests/eval/run-osu-eval.mjs --osu-file "$OSU_TRAVELPLANNER_FILE" --sample 100 --seed 20260905',
    '   ```',
    `2. 自动下载源（本 runner 固定 revision）: ${DEFAULT_SOURCES[0].url}`,
    `   （HF 数据集 osunlp/TravelPlanner @ ${UPSTREAM.datasetRevision}；查询数据由上游代码 load_dataset 装载，`,
    `   GitHub ${UPSTREAM.codeRepo} @ ${UPSTREAM.codeCommit} 仅含环境数据库与工具链，不含查询文件。）`,
    '3. 未取得数据前不产出任何成功率数字（不伪造结果）；intent 评测（run-intent-eval.mjs）独立运行、不受本阻塞影响。',
    '',
    `许可：代码 ${UPSTREAM.codeLicense}；数据集查询文件 ${UPSTREAM.datasetLicense}（归属见 manifest/results 报告）。`,
    '',
  ].join('\n')
  writeFileSync(join(args.out, 'osu-blocked.md'), md)
  console.error(`[osu] BLOCKED：${reason}`)
  console.error(`[osu] blocked 报告：${join(args.out, 'osu-blocked.md')}`)
}

async function main() {
  const startedAt = new Date().toISOString()
  // ── 数据解析 ──
  let file = args.osuFile !== undefined && args.osuFile !== '' ? resolve(args.osuFile) : undefined
  let sourceUrl = `local file: ${file}`
  if (file === undefined || !existsSync(file) || !statSync(file).isFile()) {
    if (file !== undefined) console.error(`[osu] 指定文件不存在或非普通文件：${file}，转固定源下载`)
    const got = await downloadPinned()
    if (got === undefined) {
      failClosed('本地 OSU_TRAVELPLANNER_FILE 未提供/不存在，且固定源下载失败（网络或上游不可达）。')
      process.exit(2)
    }
    file = got.file
    sourceUrl = got.url
  }
  const rawText = readFileSync(file, 'utf8')
  const fileSha256 = sha256(rawText)
  const pool = parseDatasetFile(rawText, file)
  const eligible = pool.filter(singleDestinationFilter)
  console.log(`[osu] 数据文件：${file}`)
  console.log(`[osu] sha256=${fileSha256} 行数=${pool.length} 国内单目的地口径=${eligible.length}（严格单城 vcn==1 子集=${eligible.filter((t) => t.visitingCityNumber === 1).length}）`)
  if (eligible.length < args.sample) {
    failClosed(`口径内任务 ${eligible.length} 条 < 样本要求 ${args.sample} 条。`)
    process.exit(2)
  }

  // ── 分层抽样 + manifest（运行流水线前固化 ID 列表） ──
  const { tasks: sampled, sampling } = stratifiedSample(eligible, args.sample, args.seed)
  const manifest = {
    milestone: 'm3/w4 (M3.4)',
    generatedAt: new Date().toISOString(),
    sampling: {
      seed: args.seed,
      sampleSize: args.sample,
      poolSize: eligible.length,
      strataDimensions: 'days × level × visiting_city_number（比例分配 + 最大余数补齐；层内 Fisher-Yates，单一 PRNG 序列）',
      strata: sampling.strata,
      determinism: '同 seed + 同数据文件（sha256 相同）→ 同 100 条',
    },
    scope: {
      domestic口径: '数据集全部任务 org/dest 均为美国境内城市/地区（TravelPlanner 基准构造保证）——「国内」映射为「同一国境内（美国）」',
      singleDest口径: '按数据集字段：dest 为单一目的地值（数据卡定义 dest=The destination city）；visiting_city_number 为行程访问城市数，manifest 逐条记录以供严格单城（vcn==1）子集追溯',
      strictSingleCitySubset: sampled.filter((t) => t.visitingCityNumber === 1).length,
    },
    upstream: UPSTREAM,
    source: { file, url: sourceUrl, sha256: fileSha256, bytes: Buffer.byteLength(rawText, 'utf8'), rows: pool.length },
    licenseAttribution: `上游代码 ${UPSTREAM.codeRepo}（${UPSTREAM.codeLicense}，commit ${UPSTREAM.codeCommit}）；查询数据 ${UPSTREAM.datasetRepo}（${UPSTREAM.datasetLicense}，revision ${UPSTREAM.datasetRevision}）。原始数据不进 git/生产包，本 manifest 只含任务 ID 与结构化摘要（不含查询原文）。`,
    taskIds: sampled.map((t) => t.id),
    tasks: sampled.map((t) => ({
      id: t.id, rowIndex: t.rowIndex, org: t.org, dest: t.dest, days: t.days,
      visitingCityNumber: t.visitingCityNumber, level: t.level, people: t.people,
      budget: t.budget, dateStart: t.dateStart, dateEnd: t.dateEnd,
      querySha256: sha256(t.query).slice(0, 16),
    })),
  }
  mkdirSync(args.out, { recursive: true })
  const manifestPath = join(args.out, 'osu-manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`[osu] manifest（${manifest.taskIds.length} 条）：${manifestPath}`)

  // ── 确定性流水线 ──
  const runTasks = args.limit !== undefined ? sampled.slice(0, args.limit) : sampled
  const runRoot = join(DOWNLOAD_DIR, `run-${startedAt.replace(/[:.]/g, '-')}`)
  mkdirSync(join(runRoot, 'stores'), { recursive: true })
  const results = []
  for (const [i, task] of runTasks.entries()) {
    const storeRoot = join(runRoot, 'stores', task.id)
    let record
    try {
      record = await runDeterministicPipeline(task, storeRoot)
    } catch (err) {
      // runner 自身异常 = 裸异常（失败并记录阶段）
      record = {
        taskId: task.id, ok: false, planId: undefined, stages: {}, error: `裸异常：${String(err instanceof Error ? err.message : err).slice(0, 260)}`,
        failureClass: 'unexpected', stoppedAt: 'unexpected', details: {},
      }
    }
    results.push(record)
    process.stdout.write(`[${i + 1}/${runTasks.length}] ${task.id} ${record.ok ? 'OK' : `FAIL(${record.failureClass}@${record.stoppedAt})`}\n`)
  }

  const byClass = { schema: 0, state: 0, constraint: 0, render: 0, unexpected: 0 }
  for (const r of results) if (!r.ok) byClass[r.failureClass] = (byClass[r.failureClass] ?? 0) + 1
  const success = results.filter((r) => r.ok).length
  const bareExceptions = byClass.unexpected
  const threshold = Math.ceil(0.95 * runTasks.length)

  // ── 分离的 live canary（真实联网研究路径；失败只记录 live 状态） ──
  const live = { skipped: args.skipLive, canary: args.canary, results: [] }
  if (!args.skipLive && args.canary > 0) {
    console.log(`[osu] live canary（${args.canary} 条，真实联网研究路径；结果独立于 deterministic 口径）…`)
    for (const task of sampled.slice(0, args.canary)) {
      const entry = { taskId: task.id, ok: false, stages: {}, degraded: [], note: '' }
      try {
        const { runIntake, runResearchDestination, runBuildItinerary, runRenderPage, TravelStore } = await importLibPipeline()
        const storeRoot = join(runRoot, 'live', task.id)
        mkdirSync(storeRoot, { recursive: true })
        const store = new TravelStore(storeRoot)
        const intake = await runIntake({ mode: 'plan', slots: liveSlots(task) }, store)
        entry.stages.intake = intake.status
        entry.planId = intake.planId
        const research = await runResearchDestination(
          { planId: intake.planId, depth: 'quick' },
          store,
          { channels: buildLiveCanaryChannels(), retryDelaysMs: [] },
        )
        entry.stages.research = { itemCount: research.itemCount, degraded: (research.degraded ?? []).map((d) => `${d.source}[${d.code}]`).slice(0, 8) }
        const build = await runBuildItinerary({ planId: intake.planId }, store)
        entry.stages.build = { built: build.built, reason: build.reason }
        if (build.built) {
          const render = await runRenderPage({ planId: intake.planId, mapProvider: 'leaflet' }, store, { host: '127.0.0.1', port: 0, register() {} })
          entry.stages.render = { rendered: render.rendered }
        }
        entry.ok = build.built === true
        entry.note = entry.ok ? 'live 路径全链产出' : 'live 研究无带坐标情报（如实记录，不影响 deterministic 口径）'
      } catch (err) {
        entry.note = `live 异常（如实记录）：${String(err instanceof Error ? err.message : err).slice(0, 200)}`
      }
      live.results.push(entry)
      console.log(`[osu] live ${task.id}: ${entry.ok ? 'OK' : 'FAIL'} ${entry.note}`)
    }
  }

  // ── 结果输出 ──
  const report = {
    meta: {
      milestone: 'm3/w4 (M3.4)',
      startedAt,
      finishedAt: new Date().toISOString(),
      command: `node tests/eval/run-osu-eval.mjs --osu-file "${file}" --sample ${args.sample} --seed ${args.seed}`,
      seed: args.seed,
      sampleSize: args.sample,
      executed: runTasks.length,
      source: manifest.source,
      upstream: UPSTREAM,
      modelPreset: 'none（deterministic 结构化流水线：真实工具链 lib/ + 合成 research 数据，零模型调用、零联网）',
      nodeVersion: process.version,
      runRoot,
    },
    deterministic: {
      success,
      total: runTasks.length,
      rate: `${success}/${runTasks.length}`,
      target: `≥${threshold}/${runTasks.length}`,
      pass: success >= threshold,
      noBareException: bareExceptions === 0,
      bareExceptionCount: bareExceptions,
      failureStages: byClass,
      failures: results.filter((r) => !r.ok).map((r) => ({ taskId: r.taskId, stoppedAt: r.stoppedAt, failureClass: r.failureClass, error: r.error, stages: r.stages })),
      // 逐条结果（成功含阶段明细；失败含阶段+错误摘要）
      tasks: results,
    },
    live,
    attribution: manifest.licenseAttribution,
    scope: manifest.scope,
  }
  const jsonPath = join(args.out, 'osu-results.json')
  const mdPath = join(args.out, 'osu-results.md')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  writeFileSync(mdPath, renderMarkdown(report))
  console.log(`\n[osu] deterministic 成功 ${success}/${runTasks.length}（阈值 ≥${threshold}），裸异常 ${bareExceptions}；失败分布 ${JSON.stringify(byClass)}`)
  console.log(`[osu] 证据：${jsonPath}`)
  console.log(`[osu] 证据：${mdPath}`)
  process.exit(report.deterministic.pass && bareExceptions === 0 ? 0 : 1)
}

/** live canary 的 intake 槽位（结构化字段 → Slots；无预算币种假设为 USD）。 */
function liveSlots(task) {
  return {
    origin: task.org,
    destination: task.dest,
    dateStart: task.dateStart,
    dateEnd: task.dateEnd,
    days: task.days,
    travelers: { adults: task.people },
    ...(task.budget !== undefined ? { budget: { amount: task.budget, currency: 'USD' } } : {}),
  }
}

/** canary 用运行时导入（懒加载，便于 --skip-live 时零网络依赖面）。 */
async function importLibPipeline() {
  const LIB = join(REPO, 'lib')
  const TravelStore = (await import(`${LIB}/store/store.js`)).TravelStore
  const runIntake = (await import(`${LIB}/tools/intake.js`)).runIntake
  const runResearchDestination = (await import(`${LIB}/tools/research-destination.js`)).runResearchDestination
  const runBuildItinerary = (await import(`${LIB}/tools/build-itinerary.js`)).runBuildItinerary
  const runRenderPage = (await import(`${LIB}/tools/render-page.js`)).runRenderPage
  return { TravelStore, runIntake, runResearchDestination, runBuildItinerary, runRenderPage }
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# M3.4 OSU TravelPlanner 回归评测结果（W4）')
  lines.push('')
  lines.push(`- 运行时间：${report.meta.startedAt} ~ ${report.meta.finishedAt}`)
  lines.push(`- 命令：\`${report.meta.command}\``)
  lines.push(`- 数据源：${report.meta.source.url}`)
  lines.push(`  - 文件 sha256：${report.meta.source.sha256}（bytes=${report.meta.source.bytes}，rows=${report.meta.source.rows}）`)
  lines.push(`  - 上游代码：${report.meta.upstream.codeRepo}（${report.meta.upstream.codeLicense}，commit ${report.meta.upstream.codeCommit}）`)
  lines.push(`  - 查询数据：${report.meta.upstream.datasetRepo}（${report.meta.upstream.datasetLicense}，revision ${report.meta.upstream.datasetRevision}）`)
  lines.push(`- 执行方式：${report.meta.modelPreset}`)
  lines.push(`- 口径：${report.scope.domestic口径}；${report.scope.singleDest口径}（严格单城子集 ${report.scope.strictSingleCitySubset}/${report.meta.sampleSize}）`)
  lines.push('')
  lines.push('## 阈值判定（deterministic）')
  lines.push('')
  lines.push(`| 指标 | 结果 | 目标 | 判定 |`)
  lines.push(`|---|---|---|---|`)
  lines.push(`| 结构化流水线成功 | ${report.deterministic.rate} | ${report.deterministic.target} | ${report.deterministic.pass ? 'PASS' : 'FAIL'} |`)
  lines.push(`| 裸异常（未捕获异常=失败） | ${report.deterministic.bareExceptionCount} | 0 | ${report.deterministic.noBareException ? 'PASS' : 'FAIL'} |`)
  lines.push('')
  const fs = report.deterministic.failureStages
  lines.push(`失败阶段分布：schema=${fs.schema ?? 0}，state=${fs.state ?? 0}，constraint=${fs.constraint ?? 0}，render=${fs.render ?? 0}，unexpected=${fs.unexpected ?? 0}`)
  lines.push('')
  if (report.deterministic.failures.length > 0) {
    lines.push('## 失败任务清单')
    lines.push('')
    lines.push('| taskId | 停止阶段 | 类别 | 错误摘要 |')
    lines.push('|---|---|---|---|')
    for (const f of report.deterministic.failures) {
      lines.push(`| ${f.taskId} | ${f.stoppedAt} | ${f.failureClass} | ${String(f.error ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`)
    }
    lines.push('')
  }
  lines.push('## live canary（分离口径，不并入成功率）')
  lines.push('')
  if (report.live.skipped) {
    lines.push('（--skip-live：未执行）')
  } else {
    for (const c of report.live.results) {
      lines.push(`- ${c.taskId}: ${c.ok ? 'OK' : 'FAIL'} — ${c.note}（stages=${JSON.stringify(c.stages)}）`)
    }
  }
  lines.push('')
  lines.push('## 复跑')
  lines.push('')
  lines.push('```bash')
  lines.push(`node tests/eval/run-osu-eval.mjs --osu-file "$OSU_TRAVELPLANNER_FILE" --sample ${report.meta.sampleSize} --seed ${report.meta.seed}`)
  lines.push('```')
  lines.push('')
  lines.push(`> 许可归属：${report.attribution}`)
  lines.push('')
  return lines.join('\n')
}

main().catch((err) => {
  console.error('[osu] runner 失败：', err instanceof Error ? err.message : err)
  process.exit(2)
})
