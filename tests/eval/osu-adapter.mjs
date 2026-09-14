/**
 * M3.4 / W4 —— OSU TravelPlanner 回归评测适配层（被 run-osu-eval.mjs 引用）。
 *
 * 职责：
 *  1. 数据文件解析（CSV / JSONL 两种形态；字段归一化：date/local_constraint/budget 等
 *     上游以 Python repr 形式存于 CSV，此处做确定性解析）
 *  2. 固定 seed 分层抽样（strata = days × level × visiting_city_number，比例分配 +
 *     最大余数补齐；mulberry32 PRNG，同 seed 同数据 → 同样本）
 *  3. 结构化流水线（fixture research，不联网研究）：intake → research（真实
 *     runResearchDestination + 合成渠道数据注入 store）→ build（travel_build_itinerary，
 *     直线估算动线零触网）→ render contract（page.html 内嵌 travel-data 即 RenderPageData
 *     形态校验）。执行方式：直接 import 仓库 tsdown/tsc 产物 lib/（经 `npm run build`
 *     产出；与 src/ 同构树，含 M3 并行波改动），不走 vitest/TS 加载器。
 *  4. 失败阶段分类：schema（intake 参数/校验层）｜state（状态机转换断言）｜constraint
 *     （build/render 契约：intel 缺失、无坐标、validateItinerary、RenderPageData 形态）｜
 *     render（渲染产物/页面数据）｜unexpected（任何未捕获异常=失败并记录阶段）。
 *  5. live canary 渠道（真实联网研究路径）：tencent-poi 体验通道（零 key）+ L0 真宿主
 *     搜索（cn.bing，同 tests/e2e/helpers.mjs 的请求模式自足实现）；canary 结果只记录
 *     live 状态，不并入 deterministic 成功率。
 *
 * 数据/许可纪律：OSU 数据集文件不进 git、不进生产包；上游代码仓库 MIT，数据集
 *   查询文件 CC-BY-4.0（HF osunlp/TravelPlanner 数据卡），归属与 SHA 由 runner 记录。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// ── 仓库编译产物 lib/（tsdown/tsc 产物；见文件头「执行方式」） ──
const LIB = join(import.meta.dirname, '..', '..', 'lib')
const { TravelStore } = await import(`${LIB}/store/store.js`)
const { runIntake } = await import(`${LIB}/tools/intake.js`)
const { runResearchDestination } = await import(`${LIB}/tools/research-destination.js`)
const { tencentPoiChannel, searchL0Channel } = await import(`${LIB}/orchestrator/channels.js`)
const { TencentMapAdapter } = await import(`${LIB}/adapters/tencent.js`)
const { SearchAdapter } = await import(`${LIB}/adapters/search.js`)
const { runBuildItinerary } = await import(`${LIB}/tools/build-itinerary.js`)
const { runRenderPage } = await import(`${LIB}/tools/render-page.js`)
const { validateItinerary } = await import(`${LIB}/models/validate.js`)

// ── 通用小件 ──
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** mulberry32：确定性 PRNG（正整数 seed）。 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 数据文件解析（CSV / JSONL） ──

/** 极简 CSV 解析（支持引号内逗号/换行/双引号转义——按上游 CSV 实际形态）。 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = [] }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

/** Python repr 值清洗：'x' → x，[a, b] → a|b，None → 空。 */
function reprToText(raw) {
  const s = String(raw ?? '').trim()
  if (s === '' || s === 'None' || s === 'null') return undefined
  let out = s.replace(/^\[|\]$/g, '').replace(/^'|'$/g, '')
  out = out.split("', '").map((p) => p.replace(/^'|'$/g, '').trim()).filter((p) => p.length > 0 && p !== 'None').join('|')
  return out.length > 0 ? out : undefined
}

/** 上游 `local_constraint`（Python dict repr）→ 非空约束字符串数组。 */
function parseLocalConstraint(raw) {
  const out = []
  for (const key of ['house rule', 'cuisine', 'room type', 'transportation']) {
    const m = new RegExp(`'${key}'\\s*:\\s*([^,}]+)`).exec(String(raw ?? ''))
    if (m === undefined || m === null) continue
    const value = reprToText(m[1])
    if (value !== undefined) out.push(`${key}: ${value}`)
  }
  return out
}

/** 上游 `date`（Python list repr）→ ['YYYY-MM-DD', …]。 */
function parseDates(raw) {
  return String(raw ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? []
}

/**
 * 数据文件 → 归一化任务列表（顺序保持文件行序；rowIndex 1-based 数据行号）。
 * 支持 CSV（表头含 query/org/dest/days…）与 JSONL（每行一个同字段对象）。
 */
export function parseDatasetFile(text, fileName) {
  const tasks = []
  const isJsonl = /\.jsonl$/i.test(fileName) || /^\s*\{/.test(text)
  if (isJsonl) {
    for (const [i, line] of text.split('\n').entries()) {
      const t = line.trim()
      if (t.length === 0) continue
      let obj
      try { obj = JSON.parse(t) } catch (err) {
        throw new Error(`JSONL 第 ${i + 1} 行解析失败：${err instanceof Error ? err.message : err}`)
      }
      tasks.push(normalizeTask(obj, i + 1))
    }
    return tasks
  }
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('CSV 无数据行')
  const header = rows[0].map((h) => h.trim())
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))
  for (const [i, row] of rows.slice(1).entries()) {
    if (row.every((c) => c.trim() === '')) continue
    const obj = Object.fromEntries(header.map((h) => [h, row[idx[h]]]))
    tasks.push(normalizeTask(obj, i + 1))
  }
  return tasks
}

/** 归一化一条上游任务（字段名同 HF osunlp/TravelPlanner 数据卡 Record Layout）。 */
function normalizeTask(raw, rowIndex) {
  const dates = parseDates(raw.date)
  const days = Number(raw.days)
  const people = Number(raw.people_number ?? 1)
  const budget = raw.budget === undefined || raw.budget === null || String(raw.budget).trim() === ''
    ? undefined
    : Number(String(raw.budget).replace(/[^0-9.]/g, ''))
  const vcn = raw.visiting_city_number === undefined || raw.visiting_city_number === null || String(raw.visiting_city_number).trim() === ''
    ? undefined
    : Number(raw.visiting_city_number)
  return {
    rowIndex,
    id: `osu-r${String(rowIndex).padStart(4, '0')}-${sha256(String(raw.query ?? '')).slice(0, 8)}`,
    org: String(raw.org ?? '').trim(),
    dest: String(raw.dest ?? '').trim(),
    days: Number.isFinite(days) ? days : undefined,
    visitingCityNumber: vcn,
    dates,
    dateStart: dates[0],
    dateEnd: dates[dates.length - 1],
    people: Number.isFinite(people) ? people : 1,
    budget: budget !== undefined && Number.isFinite(budget) ? budget : undefined,
    localConstraint: parseLocalConstraint(raw.local_constraint),
    level: String(raw.level ?? '').trim() || undefined,
    query: String(raw.query ?? '').trim(),
  }
}

/** 「国内单目的地」口径判定（按数据集实际字段；详见 run-osu-eval 报告说明）：
 *  - 国内（domestic）：数据集全部任务 org/dest 均为美国境内城市/地区（基准构造保证）；
 *  - 单目的地（single-destination）：`dest` 字段为单一目的地值（数据卡定义 dest=The
 *    destination city，每条任务恰一个）；`visiting_city_number` 是行程内访问城市数，
 *    作为 manifest 追溯字段记录（其 ==1 的严格单城子集单独统计）。 */
export function singleDestinationFilter(task) {
  return task.dest !== undefined && task.dest.length > 0 && task.org.length > 0
}

// ── 分层抽样（固定 seed，确定性） ──

/** strata 键：days × level × visiting_city_number（缺失值记 'na'，保持可分组）。 */
function strataKeyOf(task) {
  return `days=${task.days ?? 'na'}|level=${task.level ?? 'na'}|vcn=${task.visitingCityNumber ?? 'na'}`
}

/**
 * 比例分配 + 最大余数法补齐：同 seed 同 pool → 同 allocations。
 * 返回 Map<strataKey, count>。
 */
export function allocateByStrata(pool, sampleSize, seed) {
  const groups = new Map()
  for (const [i, task] of pool.entries()) {
    const key = strataKeyOf(task)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(i)
  }
  const keys = [...groups.keys()].sort() // 字典序固定 → 分配确定
  const total = pool.length
  const alloc = new Map()
  let assigned = 0
  const remainders = []
  for (const key of keys) {
    const n = groups.get(key).length
    const exact = (sampleSize * n) / total
    const base = Math.min(n, Math.floor(exact))
    alloc.set(key, base)
    assigned += base
    remainders.push({ key, frac: exact - Math.floor(exact), n })
  }
  // 余数按 frac 降序（平手按 key 升序）逐层 +1，直至补满；层已满则顺延
  const rest = [...remainders].sort((a, b) => (b.frac - a.frac) !== 0 ? (b.frac - a.frac) : (a.key < b.key ? -1 : 1))
  let guard = 0
  while (assigned < sampleSize && guard < sampleSize * 4) {
    for (const r of rest) {
      if (assigned >= sampleSize) break
      if ((alloc.get(r.key) ?? 0) < r.n) {
        alloc.set(r.key, (alloc.get(r.key) ?? 0) + 1)
        assigned += 1
      }
    }
    guard += 1
  }
  return { alloc, groups, keys }
}

/**
 * 分层抽样：返回 {tasks, sampling}。sampling 记录逐层分母/分配，供 manifest 审计。
 * 层内打乱用单一 PRNG 序列（层按字典序处理）→ 同 seed 同数据完全可重复。
 */
export function stratifiedSample(pool, sampleSize, seed) {
  if (sampleSize > pool.length) throw new Error(`样本数 ${sampleSize} 超过池大小 ${pool.length}`)
  const { alloc, groups, keys } = allocateByStrata(pool, sampleSize, seed)
  const rng = mulberry32(seed)
  const picked = []
  const strata = []
  for (const key of keys) {
    const indices = [...groups.get(key)]
    // Fisher-Yates（确定性 PRNG）
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp
    }
    const take = alloc.get(key) ?? 0
    picked.push(...indices.slice(0, take).map((i) => pool[i]))
    strata.push({ strataKey: key, poolCount: indices.length, sampled: take })
  }
  return { tasks: picked, sampling: { seed, strata } }
}

// ── fixture research：合成渠道数据（零联网） ──

/** 城市 → 确定性基坐标（美国本土范围；仅供结构化流水线使用，非地理事实）。 */
function baseCoordsOf(city) {
  const h = parseInt(sha256(city).slice(0, 8), 16)
  return { lng: -(122 + (h % 3200) / 100), lat: 26 + (h % 900) / 100 }
}

/** 合成腾讯 POI HTTP：任意 place/v1/search → 依 keyword 派生的确定性 POI JSONP。 */
export function syntheticTencentHttp() {
  return async (url) => {
    const parsed = new URL(url)
    const keyword = parsed.searchParams.get('keyword') ?? '景点'
    const city = keyword.replace(/[^一-龥A-Za-z ]/g, ' ').trim().split(/\s+/)[0] || 'city'
    const base = baseCoordsOf(city)
    const data = []
    for (let i = 0; i < 6; i++) {
      data.push({
        id: `eval-${sha256(`${city}:${keyword}:${i}`).slice(0, 12)}`,
        title: `${city}·评测样例${i + 1}（${keyword}）`,
        address: `${city} 评测样例街 ${i + 1} 号（OSU 回归评测合成数据，非真实 POI）`,
        tel: '000-0000-0000',
        category: keyword.includes('美食') || keyword.includes('餐') ? '美食:评测样例' : '旅游景点:评测样例',
        type: 0,
        location: { lat: base.lat + i * 0.01, lng: base.lng + i * 0.01 },
        ad_info: { adcode: '000000', province: 'eval', city, district: 'eval' },
        avg_price: 50 + i * 10,
        star_level: 4 + (i % 10) / 10,
      })
    }
    const payload = JSON.stringify({ status: 0, message: 'eval-fixture', count: data.length, data })
    return { ok: true, status: 200, text: async () => `cb(${payload});` }
  }
}

/** 合成 L0 宿主搜索（标题级命中、无坐标——同 seed-research 的 DEFAULT_L0_HITS 形态）。 */
export function syntheticHostSearch() {
  return async (query, maxResults) => {
    const h = sha256(query).slice(0, 10)
    const sources = [
      { title: `评测样例：攻略笔记 ${h}`, url: `https://www.xiaohongshu.com/explore/eval-${h}`, snippet: 'OSU 回归评测合成 L0 命中（标题级）' },
      { title: `评测样例：长文 ${h}`, url: `https://zhuanlan.zhihu.com/p/eval-${h}`, snippet: 'OSU 回归评测合成 L0 命中（标题级）' },
    ].slice(0, maxResults)
    return { content: undefined, sources, truncated: false }
  }
}

// ── 结构化流水线 ──

const RENDER_DATA_REQUIRED_KEYS = ['renderedAt', 'request', 'itinerary', 'intel', 'degraded', 'map']

/** page.html 内嵌 travel-data（RenderPageData）形态契约校验；返回 issue 列表（空=通过）。 */
export function validateRenderPageData(data, task) {
  const issues = []
  if (data === undefined || data === null || typeof data !== 'object') return ['travel-data 缺失或非对象']
  for (const key of RENDER_DATA_REQUIRED_KEYS) {
    if (data[key] === undefined) issues.push(`RenderPageData.${key} 缺失`)
  }
  if (issues.length > 0) return issues
  if (data.request?.planId === undefined) issues.push('request.planId 缺失')
  const days = data.itinerary?.days
  if (!Array.isArray(days) || days.length === 0) {
    issues.push('itinerary.days 为空（不产空行程页契约）')
    return issues
  }
  if (task.days !== undefined && days.length !== task.days) {
    issues.push(`itinerary.days=${days.length} 与任务天数 ${task.days} 不一致`)
  }
  const intelIds = new Set(Object.keys(data.intel ?? {}))
  let stopCount = 0
  for (const [di, day] of days.entries()) {
    if (!Array.isArray(day?.stops) || day.stops.length === 0) {
      issues.push(`day${di + 1} stops 为空`)
      continue
    }
    for (const stop of day.stops) {
      stopCount += 1
      if (!stop?.name) issues.push(`day${di + 1} stop 缺 name`)
      if (stop?.coords?.sys !== 'GCJ02') issues.push(`day${di + 1} stop ${stop?.name ?? '?'} coords.sys 非 GCJ02`)
      if (!Array.isArray(stop?.intelRefs) || stop.intelRefs.length === 0) {
        issues.push(`day${di + 1} stop ${stop?.name ?? '?'} intelRefs 为空（溯源契约）`)
      } else {
        for (const ref of stop.intelRefs) {
          if (!intelIds.has(ref)) issues.push(`intelRef ${ref} 不在 intel 索引内`)
        }
      }
    }
  }
  if (stopCount === 0) issues.push('全行程 0 个点位')
  if (data.map?.provider !== 'leaflet' && data.map?.provider !== 'amap') {
    issues.push(`map.provider 非法：${String(data.map?.provider)}`)
  }
  if (!Array.isArray(data.degraded)) issues.push('degraded 非数组')
  return issues
}

/** 从 page.html 提取内嵌 travel-data JSON。 */
export function extractTravelData(html) {
  const m = /<script id="travel-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (m === undefined || m === null) return undefined
  try { return JSON.parse(m[1]) } catch { return undefined }
}

/** 失败分类：state 机断言 → 'state'；其余按发生阶段归类。 */
function classifyError(err, stage) {
  const message = String(err instanceof Error ? err.message : err)
  if (/transition|转换|状态机|assertTransition/i.test(message)) return { stage: 'state', failureClass: 'state' }
  if (stage === 'intake') return { stage: 'schema', failureClass: 'schema' }
  if (stage === 'research') return { stage: 'state', failureClass: 'state' }
  return { stage, failureClass: stage === 'render' ? 'render' : 'constraint' }
}

/**
 * 单条任务执行结构化流水线（intake → fixture research → build → render contract）。
 * 零联网、零模型调用（确定性）。storeRoot 每任务独立目录（可复跑、可留痕）。
 */
export async function runDeterministicPipeline(task, storeRoot) {
  rmSync(storeRoot, { recursive: true, force: true })
  mkdirSync(storeRoot, { recursive: true })
  const store = new TravelStore(storeRoot)
  const stages = { intake: undefined, research: undefined, build: undefined, render: undefined }
  const result = { taskId: task.id, ok: false, stages, planId: undefined, error: undefined, failureClass: undefined, details: {} }

  // ── intake（travel_intake，任务结构化字段 → Slots） ──
  let planId
  try {
    const intake = await runIntake({
      mode: 'plan',
      slots: {
        origin: task.org,
        destination: task.dest,
        dateStart: task.dateStart,
        dateEnd: task.dateEnd,
        days: task.days,
        travelers: { adults: task.people },
        ...(task.budget !== undefined ? { budget: { amount: task.budget, currency: 'USD' } } : {}),
        ...(task.localConstraint.length > 0 ? { constraints: task.localConstraint } : {}),
      },
    }, store)
    planId = intake.planId
    result.planId = planId
    stages.intake = { status: intake.status, missing: intake.missing, assumptions: intake.assumptions }
    if (intake.status !== 'confirmed') {
      // 槽位不齐 = 任务构造缺必填（结构化口径下不应发生）→ schema 失败
      result.error = `intake 未确认：missing=${intake.missing.join(',')}`
      result.failureClass = 'schema'
      result.stoppedAt = 'intake'
      return result
    }
  } catch (err) {
    const cls = classifyError(err, 'intake')
    result.error = String(err instanceof Error ? err.message : err).slice(0, 300)
    result.failureClass = cls.failureClass
    result.stoppedAt = cls.stage
    return result
  }

  // ── research（真实 runResearchDestination + 合成渠道数据注入 store） ──
  try {
    const tencent = new TencentMapAdapter({ httpCall: syntheticTencentHttp() })
    const search = new SearchAdapter({ hostSearch: syntheticHostSearch() })
    const research = await runResearchDestination(
      { planId, depth: 'quick' },
      store,
      { channels: [tencentPoiChannel(tencent), searchL0Channel(search)], retryDelaysMs: [] },
    )
    stages.research = { itemCount: research.itemCount, degraded: research.degraded?.length ?? 0 }
  } catch (err) {
    const cls = classifyError(err, 'research')
    result.error = String(err instanceof Error ? err.message : err).slice(0, 300)
    result.failureClass = cls.failureClass
    result.stoppedAt = cls.stage
    return result
  }

  // ── build（travel_build_itinerary；缺省动线依赖=直线估算，零触网） ──
  try {
    const build = await runBuildItinerary({ planId }, store)
    stages.build = { built: build.built, days: build.days?.length ?? 0, routeCheckIssues: build.routeCheck?.issues?.length ?? 0 }
    if (!build.built) {
      result.error = `build 未产出：${build.reason ?? '未知原因'}`
      result.failureClass = 'constraint'
      result.stoppedAt = 'build'
      return result
    }
    const saved = await store.readJson(planId, 'itinerary.json')
    const issues = validateItinerary(saved)
    if (issues.length > 0) {
      result.error = `validateItinerary 未过：${JSON.stringify(issues).slice(0, 260)}`
      result.failureClass = 'constraint'
      result.stoppedAt = 'build'
      return result
    }
  } catch (err) {
    const cls = classifyError(err, 'build')
    result.error = String(err instanceof Error ? err.message : err).slice(0, 300)
    result.failureClass = cls.failureClass
    result.stoppedAt = cls.stage
    return result
  }

  // ── render contract（travel_render_page + RenderPageData 形态校验） ──
  try {
    const registrar = { host: '127.0.0.1', port: 0, register() { /* 评测面无 webserver；注册幂等空实现 */ } }
    const render = await runRenderPage({ planId, mapProvider: 'leaflet' }, store, registrar)
    stages.render = { rendered: render.rendered, warnings: render.warnings?.length ?? 0 }
    if (!render.rendered) {
      result.error = `render 未产出：${render.warnings?.join('; ') ?? '未知原因'}`
      result.failureClass = 'render'
      result.stoppedAt = 'render'
      return result
    }
    const html = (await import('node:fs')).readFileSync(render.filePath, 'utf8')
    const data = extractTravelData(html)
    const contractIssues = validateRenderPageData(data, task)
    stages.render.contractIssues = contractIssues.length
    if (contractIssues.length > 0) {
      result.error = `RenderPageData 契约未过：${contractIssues.slice(0, 4).join('; ')}`
      result.failureClass = 'render'
      result.stoppedAt = 'render'
      return result
    }
    result.details.days = data.itinerary.days.length
    result.details.stops = data.itinerary.days.reduce((n, d) => n + (d.stops?.length ?? 0), 0)
    result.details.intelCount = Object.keys(data.intel ?? {}).length
    result.details.degraded = data.degraded.length
  } catch (err) {
    // 未捕获异常 = 失败（裸异常口径）；按 render 段归类并保留阶段
    result.error = `裸异常：${String(err instanceof Error ? `${err.message}` : err).slice(0, 260)}`
    result.failureClass = 'unexpected'
    result.stoppedAt = 'render'
    return result
  }

  result.ok = true
  return result
}

/** live canary 渠道（真实联网研究路径；零 key：tencent 体验通道 + cn.bing L0）。 */
export function buildLiveCanaryChannels() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  let lastAt = 0
  const hostSearch = async (query, maxResults) => {
    const gap = 600 - (Date.now() - lastAt)
    if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    lastAt = Date.now()
    const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-hans`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`bing http ${res.status}`)
    const html = await res.text()
    const out = []
    for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []) {
      const href = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/)?.[1]
      if (href === undefined || !/^https?:\/\//.test(href)) continue
      const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
      out.push({ url: href, title: title !== undefined && title.length > 0 ? title : href, snippet: '' })
      if (out.length >= maxResults) break
    }
    return { content: undefined, sources: out, truncated: false }
  }
  return [
    tencentPoiChannel(new TencentMapAdapter()),
    searchL0Channel(new SearchAdapter({ hostSearch })),
  ]
}
