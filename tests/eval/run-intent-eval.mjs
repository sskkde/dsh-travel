/**
 * M3.4 / W4 —— 意图评测 runner（FR-1 验收①②，真实 test-env DSH 实例）。
 *
 * 用法：
 *   node tests/eval/run-intent-eval.mjs --dataset tests/eval/intent-20-20.json
 *   可选：--port 3081 --host 127.0.0.1 --budget 300 --only <id>（可重复）
 *         --label travel|non-travel --out docs/evidence/m3/w4
 *
 * 形态：Node ESM 直跑脚本（非 vitest）。对 test-env 实例（.test-env/，默认端口 3081，
 * DSH_HOME=$PWD/.test-env/dsh-home，实例须已在运行——本脚本不启动/不重启实例）逐条
 * 发送用户消息：
 *   - HTTP RPC：POST /api/<method>，信封 {type:'client-request', rpcId, method, payload}
 *     （复用 tests/e2e/ 与宿主交互的 JSON-over-HTTP 请求模式；helpers.mjs 的 fetch/curl
 *     面向页面/路由，本脚面对宿主 /api 通道，自足实现、不改 tests/e2e/）
 *   - mux WebSocket /api/events.mux：接收 server-request（question/requested → 按选项
 *     应答；approval/requested → allowed-once 应答）与 session 事件流
 *   - session.history / session.list 兜底轮询：工具调用观察与 turn 结束判定
 * 判定（口径=FR-1 验收原文）：
 *   命中   = 模型加载 travel-planner skill（skill 工具调用且参数引用 travel-planner）
 *            或调用任一 travel_* 工具；
 *   误触发 = non-travel 条目出现上述任一行为。
 *   travel 条目观测到命中即提前收束（session.cancel）——FR-1 口径只关心意图触发，
 *   不要求跑完规划全流程；提前收束同时避免对真实外部服务发起后续批量检索。
 * 输出：JSON + Markdown 至 docs/evidence/m3/w4/（intent-results.{json,md}），
 *   含模型名/温度（宿主未暴露则如实标注）/推理档位/实例端口等元数据与逐条判定依据。
 * 阈值：travel 命中 ≥18/20；non-travel 误触发 ≤1/20。未达标如实报告（inconclusive
 *   单列，不计入命中、不虚报为误触发），由编排者决策。
 *
 * 纪律：零 key/cookie/secret（本脚本不读凭据、不打印环境值）；不碰生产 3080。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dir, '..', '..')

// ── CLI 参数 ──
function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 3081, budget: 300, out: join(REPO, 'docs', 'evidence', 'm3', 'w4'), only: [], label: undefined, dataset: join(REPO, 'tests', 'eval', 'intent-20-20.json') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dataset') args.dataset = resolve(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--budget') args.budget = Number(argv[++i])
    else if (a === '--out') args.out = resolve(argv[++i])
    else if (a === '--only') args.only.push(argv[++i])
    else if (a === '--label') args.label = argv[++i]
    else throw new Error(`未知参数：${a}`)
  }
  return args
}
const args = parseArgs(process.argv.slice(2))
const BASE = `http://${args.host}:${args.port}`

// ── 宿主 RPC（/api 通道，信封同宿主 client-request/server-response 协议） ──
let rpcSeq = 0
async function rpc(method, payload, timeoutMs = 30000) {
  const rpcId = `w4intent-${++rpcSeq}-${Date.now()}`
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`RPC ${method} http ${res.status}`)
  const body = await res.json()
  if (body.type !== 'server-response') throw new Error(`RPC ${method} 非预期响应类型 ${body.type}`)
  if (!body.result?.ok) {
    const detail = body.result?.error?.message ?? JSON.stringify(body.result?.error ?? body.result)
    throw new Error(`RPC ${method} 失败：${detail}`)
  }
  return body.result.value
}

/** /api/respond：应答宿主 server-request（approval/question），信封为 client-response。 */
async function respond(serverRpcId, value) {
  const res = await fetch(`${BASE}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId: serverRpcId, result: { ok: true, value } }),
    signal: AbortSignal.timeout(15000),
  })
  const body = await res.json().catch(() => ({}))
  return body
}

// ── mux WebSocket（自动重连；重连后宿主会 replay 未应答的 pending 帧） ──
const wsFrames = [] // 本 run 收到的全部帧（截断存储，供证据回溯）
let ws = undefined
let wsSeq = 0
function connectWs() {
  return new Promise((resolveP, rejectP) => {
    const socket = new WebSocket(`ws://${args.host}:${args.port}/api/events.mux`)
    socket.onopen = () => resolveP(socket)
    socket.onerror = (e) => rejectP(new Error(`mux WS 连接失败：${e.message ?? e.type ?? 'error'}`))
    socket.onclose = () => { if (ws === socket) ws = undefined }
  })
}
async function ensureWs() {
  if (ws !== undefined && ws.readyState === 1) return ws
  ws = await connectWs()
  ws.onmessage = (m) => {
    if (typeof m.data !== 'string') return
    let frame
    try { frame = JSON.parse(m.data) } catch { return }
    if (++wsSeq <= 4000) wsFrames.push(JSON.stringify(frame).slice(0, 600))
    for (const handler of frameHandlers) handler(frame)
  }
  return ws
}
const frameHandlers = []

// ── 判定函数（口径=FR-1 验收：命中=加载 travel-planner skill 或调用任一 travel_* 工具） ──
export function isTravelHit(toolCall) {
  if (toolCall.name === undefined) return false
  if (toolCall.name.startsWith('travel_')) return true
  if (toolCall.name.includes('skill') && /travel-planner/i.test(String(toolCall.arguments ?? ''))) return true
  return false
}

/** 从 session 事件流提取工具调用观测（tool/call 事件 + assistant/message 的 tool-call 块）。 */
function collectToolCalls(events) {
  const calls = []
  for (const { event } of events) {
    if (event === undefined) continue
    if (event.type === 'tool/call') {
      calls.push({ name: event.data?.name, arguments: event.data?.arguments })
    } else if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call') calls.push({ name: block.name, arguments: block.arguments })
      }
    }
  }
  return calls
}

function snippet(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

// ── 单条评测：新会话 → 发送 → 观测 → 应答 → 收束 ──
async function evalItem(item, modelMeta) {
  const sandbox = join(REPO, '.tmp', 'eval-intent-sandbox')
  mkdirSync(sandbox, { recursive: true })
  const created = await rpc('session.create', { cwd: sandbox })
  const sessionId = created.sessionId

  // 模型元数据（首个会话取一次；同实例同 profile 各会话一致）
  if (modelMeta.model === undefined) {
    const models = await rpc('session.models', { sessionId })
    modelMeta.model = models.current?.model
    modelMeta.provider = models.current?.provider
    modelMeta.reasoningEffort = models.current?.reasoningEffort
    modelMeta.routable = models.routable
  }

  // 实时帧处理：自动应答 question / approval（保持 turn 前进直至自然结束）
  let questionsAnswered = 0
  let approvalsAllowed = 0
  const answeredRpc = new Set()
  const handler = (frame) => {
    if (frame?.type !== 'server-request') return
    const p = frame.payload
    if (p?.sessionId !== sessionId || answeredRpc.has(frame.rpcId)) return
    answeredRpc.add(frame.rpcId)
    if (p.type === 'question/requested') {
      questionsAnswered += 1
      const answers = (p.questions ?? []).map((q) => ({
        id: q.id,
        selected: q.multiSelect === true ? [(q.options?.[0]?.label)].filter(Boolean) : [q.options?.[0]?.label].filter(Boolean),
      }))
      respond(frame.rpcId, { sessionId, answer: { answers } }).catch(() => {})
    } else if (p.type === 'approval/requested') {
      approvalsAllowed += 1
      respond(frame.rpcId, { sessionId, approvalId: p.approvalId, outcome: 'allowed-once' }).catch(() => {})
    }
  }
  frameHandlers.push(handler)

  const startedAt = new Date().toISOString()
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: item.text }] })

  const deadline = Date.now() + args.budget * 1000
  let outcome = 'timeout'
  let turnEnded = false
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      // 1) history 观察：工具调用（命中判定源）+ turn/end
      let events = []
      try {
        const hist = await rpc('session.history', { sessionId, maxMessages: 400 }, 20000)
        events = hist.events ?? []
      } catch { /* 瞬时失败下轮重试 */ }
      const calls = collectToolCalls(events)
      // 模型配置元数据：实际模型调用的 request/header（provider/model/maxTokens/reasoningEffort；
      // 宿主不落温度字段——如实留空），从本评测自己的会话事件流提取
      if (modelMeta.configFromRequestHeader === undefined) {
        const header = events.find(({ event }) => event?.type === 'request/header')?.event?.data?.header?.config
        if (header !== undefined) modelMeta.configFromRequestHeader = header
      }
      const hit = calls.find((c) => isTravelHit(c))
      turnEnded = events.some(({ event }) => event?.type === 'turn/end')
      if (hit !== undefined) {
        // 命中即收束（见文件头注释）：cancel 终止后续规划动作
        outcome = 'hit'
        break
      }
      if (turnEnded) { outcome = 'completed'; break }
      // 2) running 状态兜底（history 不可用时）
      try {
        const list = await rpc('session.list', {}, 15000)
        const self = (list.items ?? []).find((s) => s.sessionId === sessionId)
        if (self !== undefined && self.running === false && turnEnded) { outcome = 'completed'; break }
      } catch { /* ignore */ }
    }
    if (Date.now() >= deadline && outcome === 'timeout') {
      // 预算耗尽：如实标 inconclusive（不猜）
      outcome = 'inconclusive-timeout'
    }
  } finally {
    const idx = frameHandlers.indexOf(handler)
    if (idx >= 0) frameHandlers.splice(idx, 1)
    // 收束会话（无论命中/超时），避免后台 turn 空转
    try { await rpc('session.cancel', { sessionId }, 10000) } catch { /* 已结束则忽略 */ }
  }

  // 终读 history 固化证据
  let finalCalls = []
  let finalReply = ''
  try {
    const hist = await rpc('session.history', { sessionId, maxMessages: 400 }, 20000)
    finalCalls = collectToolCalls(hist.events ?? [])
    const msgs = (hist.events ?? []).filter(({ event }) => event?.type === 'assistant/message')
    const last = msgs.at(-1)?.event?.data?.message?.content ?? []
    finalReply = last.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
  } catch { /* cancel 后 history 不可读则留空 */ }

  const hitCall = finalCalls.find((c) => isTravelHit(c))
  const allNames = [...new Set(finalCalls.map((c) => c.name).filter(Boolean))]
  let verdict
  if (hitCall !== undefined) {
    verdict = item.label === 'travel' ? 'hit' : 'false-trigger'
  } else if (outcome === 'inconclusive-timeout') {
    verdict = 'inconclusive'
  } else {
    verdict = item.label === 'travel' ? 'miss' : 'ok'
  }

  return {
    id: item.id,
    label: item.label,
    text: item.text,
    expectedAction: item.expectedAction,
    language: item.language,
    verdict,
    outcome,
    hit: hitCall !== undefined,
    evidence: {
      sessionId,
      startedAt,
      toolCalls: finalCalls.map((c) => ({ name: c.name, args: snippet(c.arguments, 160) })),
      matchedCall: hitCall === undefined ? undefined : { name: hitCall.name, args: snippet(hitCall.arguments, 300) },
      assistantReplySnippet: snippet(finalReply, 220),
      turnEnded,
      questionsAnswered,
      approvalsAllowed,
    },
  }
}

// ── 报告渲染 ──
function renderMarkdown(report) {
  const lines = []
  lines.push('# M3.4 意图评测结果（W4 / FR-1 验收①②）')
  lines.push('')
  lines.push(`- 运行时间：${report.meta.startedAt} ~ ${report.meta.finishedAt}`)
  lines.push(`- 实例：${report.meta.base}（test-env 3081 口径；生产 3080 未触碰）`)
  lines.push(`- 模型：${report.meta.provider}/${report.meta.model}${report.meta.reasoningEffort ? `（reasoning=${report.meta.reasoningEffort}）` : ''}，routable=${report.meta.routable}`)
  lines.push(`- 温度：${report.meta.temperature}`)
  lines.push(`- 数据集：${report.meta.dataset}（sha256 ${report.meta.datasetSha256}）`)
  lines.push(`- 判定口径：命中 = 加载 travel-planner skill 或调用任一 travel_* 工具（FR-1 验收原文）`)
  lines.push(`- 预算：每条 ${report.meta.budgetSeconds}s；travel 条目命中即提前收束（不跑完整规划流程）`)
  lines.push('')
  lines.push('## 阈值判定')
  lines.push('')
  lines.push(`| 指标 | 结果 | 阈值 | 判定 |`)
  lines.push(`|---|---|---|---|`)
  lines.push(`| travel 命中 | ${report.summary.travelHit}/20 | ≥18/20 | ${report.summary.travelHit >= 18 ? 'PASS' : 'FAIL'} |`)
  lines.push(`| non-travel 误触发 | ${report.summary.nonTravelFalseTrigger}/20 | ≤1/20 | ${report.summary.nonTravelFalseTrigger <= 1 ? 'PASS' : 'FAIL'} |`)
  if (report.summary.inconclusive > 0) {
    lines.push(`| inconclusive（超时未决） | ${report.summary.inconclusive} | — | 单列，未计入命中/误触发 |`)
  }
  lines.push('')
  lines.push('## 逐条结果')
  lines.push('')
  lines.push('| id | label | 语言 | 判定 | 依据 |')
  lines.push('|---|---|---|---|---|')
  for (const item of report.items) {
    const basis = item.hit
      ? `调用 ${item.evidence.matchedCall.name}：${item.evidence.matchedCall.args}`
      : item.verdict === 'inconclusive'
        ? `预算内未观测到判定信号（turnEnded=${item.evidence.turnEnded}，工具=${item.evidence.toolCalls.map((c) => c.name).join(',') || '无'}）`
        : `无 travel_* 调用/skill 加载；工具=${item.evidence.toolCalls.map((c) => c.name).join(',') || '无'}`
    lines.push(`| ${item.id} | ${item.label} | ${item.language} | ${item.verdict} | ${basis.replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  lines.push('## 复跑')
  lines.push('')
  lines.push('```bash')
  lines.push(`node tests/eval/run-intent-eval.mjs --dataset tests/eval/intent-20-20.json --port ${report.meta.port}`)
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

// ── 主流程 ──
async function main() {
  if (!existsSync(args.dataset)) throw new Error(`数据集不存在：${args.dataset}`)
  const dataset = JSON.parse(readFileSync(args.dataset, 'utf8'))
  let items = dataset.items ?? []
  if (args.only.length > 0) items = items.filter((it) => args.only.includes(it.id))
  if (args.label !== undefined) items = items.filter((it) => it.label === args.label)
  const travelTotal = items.filter((i) => i.label === 'travel').length
  const nonTravelTotal = items.filter((i) => i.label === 'non-travel').length
  if (items.length === 0) throw new Error('过滤后无条目')

  const datasetSha256 = createHash('sha256').update(readFileSync(args.dataset)).digest('hex')
  const startedAt = new Date().toISOString()
  await ensureWs()
  const modelMeta = {}
  const results = []
  for (const item of items) {
    process.stdout.write(`[${results.length + 1}/${items.length}] ${item.id} (${item.label}) … `)
    let record
    try {
      record = await evalItem(item, modelMeta)
    } catch (err) {
      record = {
        id: item.id, label: item.label, text: item.text, expectedAction: item.expectedAction,
        language: item.language, verdict: 'inconclusive', outcome: 'runner-error',
        hit: false, evidence: { error: snippet(err instanceof Error ? err.message : err, 300) },
      }
    }
    results.push(record)
    console.log(`${record.verdict}${record.hit ? ` ← ${record.evidence.matchedCall?.name}` : ''}`)
  }

  const travel = results.filter((r) => r.label === 'travel')
  const nonTravel = results.filter((r) => r.label === 'non-travel')
  const report = {
    meta: {
      milestone: 'm3/w4 (M3.4)',
      startedAt,
      finishedAt: new Date().toISOString(),
      base: BASE,
      port: args.port,
      host: args.host,
      dataset: args.dataset,
      datasetSha256,
      budgetSeconds: args.budget,
      nodeVersion: process.version,
      provider: modelMeta.provider ?? 'unknown',
      model: modelMeta.model ?? 'unknown',
      reasoningEffort: modelMeta.reasoningEffort ?? modelMeta.configFromRequestHeader?.reasoningEffort,
      maxTokens: modelMeta.configFromRequestHeader?.maxTokens,
      routable: modelMeta.routable,
      // 宿主 /api 与会话 request/header 均未落温度字段——如实标注，不伪造数值
      temperature: 'not-exposed-by-host（/api 与 request/header 均无温度字段；实例默认配置）',
      modelConfigFromRequestHeader: modelMeta.configFromRequestHeader,
      hitDefinition: '加载 travel-planner skill（skill 调用引用 travel-planner）或调用任一 travel_* 工具',
    },
    thresholds: { travelHitMin: 18, nonTravelFalseTriggerMax: 1, travelTotal, nonTravelTotal },
    summary: {
      travelHit: travel.filter((r) => r.verdict === 'hit').length,
      nonTravelFalseTrigger: nonTravel.filter((r) => r.verdict === 'false-trigger').length,
      inconclusive: results.filter((r) => r.verdict === 'inconclusive').length,
    },
    items: results,
  }
  report.summary.travelPass = report.summary.travelHit >= 18
  report.summary.nonTravelPass = report.summary.nonTravelFalseTrigger <= 1

  mkdirSync(args.out, { recursive: true })
  const jsonPath = join(args.out, 'intent-results.json')
  const mdPath = join(args.out, 'intent-results.md')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  writeFileSync(mdPath, renderMarkdown(report))
  console.log(`\nintent 评测完成：travel 命中 ${report.summary.travelHit}/${travelTotal}，non-travel 误触发 ${report.summary.nonTravelFalseTrigger}/${nonTravelTotal}，inconclusive ${report.summary.inconclusive}`)
  console.log(`证据：${jsonPath}\n证据：${mdPath}`)
  ws?.close()
  process.exit(report.summary.travelPass && report.summary.nonTravelPass ? 0 : 1)
}

main().catch((err) => {
  console.error('[intent-eval] 失败：', err instanceof Error ? err.message : err)
  process.exit(2)
})
