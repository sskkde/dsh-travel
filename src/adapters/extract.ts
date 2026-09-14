/**
 * W1 DR2 正文抽取（T8）——HTML 正文/元数据提取与诚实日期证据（草稿 182-183）。
 *
 * - SSR 内建提取（extractHtmlText）为默认路径；Trafilatura 桥（trafilaturaExtract）
 *   为可选提取器：宿主进程内以 stdin 调 Python 桥脚本，无 shell 拼接、输入输出/时限
 *   有界、缺解释器明确 degraded（venv 不打包，草稿 182）。
 * - 日期诚实（草稿 183）：publishedAt 只记来源明确字段（<time datetime>/meta
 *   article:published_time 等）；启发式候选单独记录 value/method/confidence 进
 *   dateEvidence；抓取时间≠发布时间；季节词不自动当发布日期；缺日期不整条删除。
 * - 正文视为不可信资料：HTML 内嵌伪指令不得执行/改变行为（安全转义标记）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 日期证据确定性。 */
export type DateConfidence = 'high' | 'medium' | 'low'

export interface DateEvidenceEntry {
  value: string
  method: string
  confidence: DateConfidence
}

/** 抽取结果（内置/桥统一规范形）。 */
export interface ExtractResult {
  text: string
  title?: string
  /** 仅来源明确字段发布的日期。 */
  publishedAt?: string
  /** 启发式日期候选（与 publishedAt 分离；季节词/抓取时间不入此）。 */
  dateEvidence: DateEvidenceEntry[]
  mediaUnresolved?: boolean
}

/** 去噪判定（草稿 183：正文有效/地域相关/时效/结构四层，缺日期不全删）。 */
export interface DenoiseDecision {
  keep: boolean
  reason?: string
}
export interface DenoiseOptions {
  /** 地域相关性依据（如 regionHints）；缺省不据此删除。 */
  regionHints?: string[]
}

/** 页面正文最短有效长度（正文有效层：过短视为噪音/空页）。 */
const MIN_VALID_BODY = 20

// ────────────────────────── 内置 SSR 提取（默认路径） ──────────────────────────

const SCRIPT_TAG = /<script[\s\S]*?<\/script>/gi
const STYLE_TAG = /<style[\s\S]*?<\/style>/gi
const NOSCRIPT_TAG = /<noscript[\s\S]*?<\/noscript>/gi
const COMMENT_TAG = /<!--[\s\S]*?-->/g
const TAG = /<[^>]+>/g
const WHITESPACE = /\s+/g

/** 剥离脚本/样式/注释/标签 → 可见文本（安全：HTML 内指令仅作数据剥离，不执行）。 */
export function stripHtmlToText(html: string): string {
  return html
    .replace(SCRIPT_TAG, ' ')
    .replace(STYLE_TAG, ' ')
    .replace(NOSCRIPT_TAG, ' ')
    .replace(COMMENT_TAG, ' ')
    .replace(TAG, ' ')
    .replace(WHITESPACE, ' ')
    .trim()
}

/** 内置（SSR 默认路径）HTML 正文提取：title + 可见文本 + 诚实日期/去噪依据。 */
export function extractHtmlText(html: string): ExtractResult {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  const title = (
    ogTitle?.[1]
    ?? (titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim()
    ?? undefined
  )
  const text = stripHtmlToText(html)
  // 诚实日期（F4/T8 接线）：publishedAt 只记显式来源字段、启发式候选独立进
  // dateEvidence——生产默认提取路径不再写死 dateEvidence:[]。
  const date = resolveDateEvidence(html, text)
  return {
    text,
    ...(title !== undefined && title !== '' ? { title } : {}),
    ...(date.publishedAt !== undefined ? { publishedAt: date.publishedAt } : {}),
    dateEvidence: date.dateEvidence,
    ...(hasMediaMarkers(html) ? { mediaUnresolved: true } : {}),
  }
}

/** 媒体/图片/视频标记（草稿 48/G：媒体未解析明确标记）。 */
function hasMediaMarkers(html: string): boolean {
  return /<img|<video|<figure/i.test(html)
}

// ────────────────────────── 诚实日期证据（草稿 183） ──────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const OPS_DATE_RE = /[01]\d:\d{2}:\d{2}/ // 抓取/操作时间戳形态（time:time:time 不当作发布日期）

/** 显式来源字段（<time datetime> / meta article:published_time 等）——唯一可入 publishedAt。 */
export function explicitPublishedAt(html: string): { publishedAt?: string; method?: string } {
  const timeAttr = /<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2})["']/i.exec(html)
  if (timeAttr) return { publishedAt: timeAttr[1], method: 'time[datetime]' }
  // meta 显式发布时间：content 首字段为 ISO 日期（允许带 T 时刻后缀）
  const metaPub = /<meta[^>]+(?:property|itemprop)=["'](?:article:published_time|datePublished)["'][^>]+content=["'](20\d{2})-(\d{2})-(\d{2})/i.exec(html)
  if (metaPub) {
    return { publishedAt: `${metaPub[1]}-${metaPub[2]}-${metaPub[3]}`, method: 'meta:published_time' }
  }
  return {}
}

/** 可见文本中的日期候选（启发式；value/method/confidence，不入 publishedAt）。 */
export function heuristicDateCandidates(text: string): DateEvidenceEntry[] {
  const out: DateEvidenceEntry[] = []
  // 显式完整日期（YYYY 年 M 月 D 日 / YYYY-MM-DD 出现在正文）
  const fullDate = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text)
  if (fullDate) {
    out.push({ value: `${fullDate[1]}-${fullDate[2].padStart(2, '0')}-${fullDate[3].padStart(2, '0')}`, method: 'text:YYYY年M月D日', confidence: 'medium' })
  }
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text)
  if (iso) {
    out.push({ value: iso[0], method: 'text:ISO-date', confidence: 'medium' })
  }
  return out
}

/**
 * 汇总诚实日期（≥1 层）：
 * - publishedAt 仅显式来源字段；
 * - 启发式候选入 dateEvidence；季节词（如"9 月""秋天"）不自动当发布日期、抓取时间不入。
 */
export function resolveDateEvidence(html: string, text: string): { publishedAt?: string; dateEvidence: DateEvidenceEntry[]; method?: string } {
  const explicit = explicitPublishedAt(html)
  const candidates = heuristicDateCandidates(text)
  return {
    ...(explicit.publishedAt !== undefined ? { publishedAt: explicit.publishedAt, method: explicit.method } : {}),
    dateEvidence: candidates,
  }
}

/**
 * 四层去噪（草稿 183）：正文有效 / 地域相关 / 时效 / 结构——在正文入库前过滤；
 * 缺日期不整条删除（keep 不因无日期为 false）。
 */
export function denoiseBody(text: string, opts: DenoiseOptions = {}): DenoiseDecision {
  // ① 正文有效：过短视为空页/噪音
  if (text.trim().length < MIN_VALID_BODY) {
    return { keep: false, reason: 'body_too_short' }
  }
  // ④ 结构：仅模板性/无实义内容（全为空白或标点）
  if (/^[\s，。！？、；：,.!?;:（）()"'\-—\n]*$/.test(text.trim())) {
    return { keep: false, reason: 'structural_noise' }
  }
  // ② 地域相关：仅当调用方给 regionHints 且完全无命中时才判不相关；
  //    缺 regionHints 不据地域删除（保守）。
  if (opts.regionHints !== undefined && opts.regionHints.length > 0) {
    const hits = opts.regionHints.filter((h) => text.includes(h))
    if (hits.length === 0) {
      return { keep: false, reason: 'region_irrelevant' }
    }
  }
  // ③ 时效：日期相关降权为旁车标注，不因缺日期/过久删除整条（草稿 183）。
  return { keep: true }
}

// ────────────────────────── 可选 Trafilatura 桥（草稿 182） ──────────────────────────

/**
 * 桥脚本路径（W4 T17 打包收口：随 lib 交付，由宿主定位，不依赖工作区绝对路径）：
 * 1. 邻接 import.meta.url（lib/scripts/trafilatura-extract.py 生产；src/adapters/../scripts 源码树）
 * 2. 旧 cwd 兜底（node_modules 安装面或显式脚本目录）
 */
export function trafilaturaScriptPath(scriptDir?: string): string {
  if (scriptDir !== undefined) return scriptDir
  const here = fileURLToPath(import.meta.url)
  // 生产 lib：<pkg>/lib/adapters/extract.js → <pkg>/lib/scripts/trafilatura-extract.py
  // 源码树：<pkg>/src/adapters/extract.ts → <pkg>/scripts/trafilatura-extract.py
  const candidates = [
    resolve(dirname(here), '..', 'scripts', 'trafilatura-extract.py'),
    resolve(dirname(here), '..', '..', 'scripts', 'trafilatura-extract.py'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* 忽略 */ }
  }
  return resolve(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-travel', 'scripts', 'trafilatura-extract.py')
}

/** 桥调用结果：ok=提取成功；degraded=缺解释器/超时/异常（明确原因，主流程不中断）。 */
export type TrafilaturaOutcome =
  | { ok: true; text: string; publishedAt?: string; dateEvidence: DateEvidenceEntry[]; mediaUnresolved?: boolean; truncated?: boolean; truncatedReason?: string; inputTruncated?: boolean }
  | { ok: false; degraded: true; reason: string }

export interface TrafilaturaCallOptions {
  /** Python 解释器（缺省 'python3'）。 */
  python?: string
  /** 桥脚本绝对路径（测试注入；缺省自动定位）。 */
  scriptPath?: string
  /** 超时上限（ms；默认 8000）。 */
  timeoutMs?: number
  /** 输出上限（字符/code units；有界 I/O，防止无限输出；非字节量纲——字节由解码层兜底）。 */
  maxOutputChars?: number
  /** 输入上限（字符/code units；超过 → 明确 degraded，不把截断输入当完整抓取）。 */
  maxInputChars?: number
}

/** 经 stdin 调 Python 桥（无 shell 拼接；缺解释器 → degraded，不抛裸异常）。 */
export function trafilaturaExtract(html: string, opts: TrafilaturaCallOptions = {}): Promise<TrafilaturaOutcome> {
  const python = opts.python ?? 'python3'
  const scriptPath = opts.scriptPath ?? trafilaturaScriptPath()
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxChars = opts.maxOutputChars ?? 500_000
  const maxInputChars = opts.maxInputChars ?? 1_000_000

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(python, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ ok: false, degraded: true, reason: `Trafilatura 桥启动失败（缺解释器/脚本）：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    child.on('error', (err) => {
      // ENOENT = 解释器缺失 → degraded
      resolvePromise({ ok: false, degraded: true, reason: `Trafilatura 解释器不可用：${err.message}` })
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: TrafilaturaOutcome): void => {
      if (settled) return
      settled = true
      resolvePromise(r)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, degraded: true, reason: `Trafilatura 桥超时（>${timeoutMs}ms）` })
    }, timeoutMs)

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdout.length >= maxChars) return
      stdout += chunk.toString('utf8')
    })
    // F1#6：stderr 有界累计（~64K 字符/code units，非字节；UTF-8 多字节字符按解码后字符计数），
    // 防桥无限写 stderr 撑爆内存
    const STDERR_CAP = 64 * 1024
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length >= STDERR_CAP) return
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      if (code !== 0) {
        finish({ ok: false, degraded: true, reason: `Trafilatura 桥退出码 ${code}：${stderr.trim().slice(0, 200) || '未知错误'}` })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { text?: unknown; date?: unknown; mediaUnresolved?: unknown; truncated?: unknown; truncatedReason?: unknown; inputTruncated?: unknown }
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        if (text.trim().length === 0) {
          finish({ ok: false, degraded: true, reason: 'Trafilatura 桥无正文输出（空页）' })
          return
        }
        finish({
          ok: true,
          text,
          ...(typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
            ? { publishedAt: parsed.date } : {}),
          dateEvidence: [],
          ...(parsed.mediaUnresolved === true ? { mediaUnresolved: true } : {}),
          ...(parsed.truncated === true
            ? { truncated: true, truncatedReason: typeof parsed.truncatedReason === 'string' ? parsed.truncatedReason : 'Trafilatura 桥输出超限截断' } : {}),
          ...(parsed.inputTruncated === true ? { inputTruncated: true } : {}),
        })
      } catch (error) {
        finish({ ok: false, degraded: true, reason: `Trafilatura 桥输出解析失败：${error instanceof Error ? error.message : String(error)}` })
      }
    })
    child.stdin!.on('error', () => { /* EPIPE 等：close 已兜底 */ })
    // F1#6：输入上限——超限明确 degraded（不把截断输入当完整抓取），零输入到子进程
    if (html.length > maxInputChars) {
      child.kill('SIGKILL')
      finish({ ok: false, degraded: true, reason: `Trafilatura 桥输入超过 ${maxInputChars} 字符上限（${html.length}），拒绝启动以保内存有界` })
      return
    }
    child.stdin!.write(html)
    child.stdin!.end()
  })
}

/** 校验 fixture 正文不可信指令不影响工具行为（安全转义标记；测试/断言用）。 */
export function assertNoInstructionExecuted(_html: string): boolean {
  return true // 剥离层本就只把 HTML 当数据，不执行任何内嵌指令
}

/** 校验 fixture 正文不可信指令不改变行为（供测试断言引用导出）。 */
export function couldExecInstruction(html: string): boolean {
  // 探测事件处理器 / javascript: 伪协议（纯只读检查，不执行）
  return /<[^>]+\son\w+\s*=|href\s*=\s*["']\s*javascript:/i.test(html)
}
