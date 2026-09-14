/**
 * flyai（飞猪官方 CLI）适配器（M2.3，design §4.3 行 203/210 + §5.1 行 269）。
 *
 * 实测口径（research/workbuddyskills.md 行 108-114；2026-09-04 编排者复测：
 * @fly-ai/flyai-cli 1.0.16，MIT）：
 * - 接入：`@fly-ai/flyai-cli`（npm），子命令 `search-flight` / `search-train`；
 *   flag 映射 `--origin/--destination/--dep-date/--seat-class-name/--sort-type`；
 *   stdout 单行 JSON `{data:{itemList[]}, message, status, systemMessage}`，
 *   status=0 成功。机票实测：CA8341 大兴 22:00→浦东T2 23:45 经济舱 ¥370、
 *   东航 MU5100 ¥460 等真实票价 + jumpUrl（feizhu 预订深链）。
 * - **零 key 试用档**：官方声明 "can make trial without any API keys"；
 *   实测机票档零 key 即真实价格/航班号/深链；**火车档试行间歇返回空**
 *   （`status:1`「智慧交通结果为空」，与查询参数/排序无关）→ 空数据按
 *   EngineError.EMPTY 记账，交降级链走下一档（不伪造）。配 key 为生产档增强。
 * - 枚举翻译表（`--seat-class-name` 取值 = CLI --help 原文）：火车第二等座→
 *   second class / 一等座→first class / 商务座→business class / 硬卧→
 *   hard sleeper / 软卧→soft sleeper；飞机经济舱→economy / 商务舱→business /
 *   头等舱→first。
 * - 响应归一（§5.1 项 3）：ticketPrice 元→totalPriceRange；totalDuration 分→
 *   durationMinutes（整数）；depDateTime/arrDateTime 取 HH:mm 段；jumpUrl →
 *   source.url。仅归一化「直达」班次（中转组合超出 M2.3 单段归一化范围，跳过）。
 * - 二进制解析链（部署故事）：显式 binPath → env `FLYAI_CLI_BIN` → 工作区
 *   node_modules bundle（devDependency 装配）→ 模块相对 bundle（link 装配）→
 *   PATH `flyai`（npm i -g）。二进制缺失 → available()=false（渠道跳过并记账，
 *   不崩）。CLI 供给为**带外部署**（`npm i -g @fly-ai/flyai-cli@1.0.16` 或
 *   工作区 node_modules bundle），同 .venv-12306 模式——不进 devDependencies
 *   （本仓依赖树 npm/arborist reify 崩溃，声明将致 lock↔manifest 漂移破坏 npm ci）。
 * - 无 key 零调用红线不适用（本适配器本身就是零 key 通道）；key 仅用于
 *   输出标签区分「零 key 试用档 / 正式档」（resolveKey 走 ADR-12，零明文）。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BaseAdapter, CAP_MAX_PRICE, CAP_SEAT_CLASS, CAP_ZERO_KEY, EngineError,
  channelEnabled, resolveKey, type KeyResolutionEnv,
} from './base.js'
import type { TransportOption } from '../models/types.js'

/** Key 标识符（与 wendao 同约定：env 兜底名=标识符本身；credentials ref flyai/apikey）。
 * 零 key 试用档不需要它；仅用于输出标签区分档位。 */
export const FLYAI_KEY = 'flyai'

/** --seat-class-name 枚举翻译表（取值依据 CLI --help 原文，2026-09-04 实测）。 */
export const SEAT_CLASS_EN: Readonly<Record<string, string>> = {
  二等座: 'second class',
  一等座: 'first class',
  商务座: 'business class',
  硬卧: 'hard sleeper',
  软卧: 'soft sleeper',
  经济舱: 'economy',
  超级经济舱: 'economy',
  商务舱: 'business',
  头等舱: 'first',
  豪华头等舱: 'first',
}

/** 中文席别/舱位 → 飞猪 CLI 取值；未收录返回 undefined（调用方省略该 flag）。 */
export function translateSeatClass(zh: string): string | undefined {
  const normalized = zh.trim()
  return normalized.length > 0 ? SEAT_CLASS_EN[normalized] : undefined
}

// ────────────────────────── 二进制解析 ──────────────────────────

/** 解析结果：file 供 execFile 直接执行（bundle 走 node 解释器）。 */
export interface ResolvedFlyaiCommand {
  file: string
  args: string[]
}

/** 路径探测兜底：当前目录 = 插件工作区（dev 装配 node_modules bundle）。 */
export function localFlyaiBundle(): string | undefined {
  const p = join(process.cwd(), 'node_modules', '@fly-ai', 'flyai-cli', 'dist', 'flyai-bundle.cjs')
  return existsSync(p) ? p : undefined
}

/**
 * 路径探测兜底二：本模块位置（lib/adapters/ → 上两级 = 插件包根）相对的
 * node_modules bundle。长驻宿主 cwd 不在插件根（生产/测试实例），cwd 探测
 * 探不到工作区 bundle；本插件经 link 装配时 import.meta.url 即真实工作区
 * 路径，按模块定位可命中（link 装配 + workspace node_modules 场景）。
 */
export function moduleFlyaiBundle(moduleUrl: string = import.meta.url): string | undefined {
  const here = fileURLToPath(moduleUrl)
  const p = join(dirname(here), '..', '..', 'node_modules', '@fly-ai', 'flyai-cli', 'dist', 'flyai-bundle.cjs')
  return existsSync(p) ? p : undefined
}

/** PATH 探测 `flyai` 可执行（npm i -g 部署形态）。 */
export function flyaiBinOnPath(envPath: string = process.env.PATH ?? ''): string | undefined {
  for (const dir of envPath.split(':')) {
    if (!dir) continue
    for (const name of ['flyai', 'flyai.exe', 'flyai.cmd']) {
      try {
        const p = join(dir, name)
        if (existsSync(p)) return p
      } catch {
        // 目录不可读/非法段跳过（不抛）
      }
    }
  }
  return undefined
}

/**
 * 解析 flyai 可执行命令。顺序：显式（binPath → FLYAI_CLI_BIN；.cjs 走 node）→
 * 工作区 node_modules bundle（cwd）→ 模块相对 bundle（link 装配）→ PATH flyai。
 * 均不存在返回 undefined。
 */
export function resolveFlyaiCommand(binPath?: string): ResolvedFlyaiCommand | undefined {
  const explicit = (binPath ?? process.env.FLYAI_CLI_BIN ?? '').trim()
  if (explicit.length > 0) {
    if (explicit.endsWith('.cjs')) {
      return existsSync(explicit) ? { file: process.execPath, args: [explicit] } : undefined
    }
    if (existsSync(explicit)) return { file: explicit, args: [] }
    return undefined
  }
  const local = localFlyaiBundle() ?? moduleFlyaiBundle()
  if (local) return { file: process.execPath, args: [local] }
  const onPath = flyaiBinOnPath()
  if (onPath) return { file: onPath, args: [] }
  return undefined
}

// ────────────────────────── 请求变换（flag 映射 + 枚举翻译） ──────────────────────────

export type FlyaiCommand = 'search-flight' | 'search-train'

export interface FlyaiQueryParams {
  from: string
  to: string
  /** YYYY-MM-DD。 */
  date: string
  /** 中文席别/舱位（如「二等座」；不传则省略 flag）。 */
  seatClass?: string
}

/** flag 映射：--origin/--destination/--dep-date + 枚举翻译 --seat-class-name。
 * --sort-type 2 = 推荐排序（实测火车档缺省偶发「智慧交通结果为空」，显式指定规避）。 */
export function buildFlyaiArgs(command: FlyaiCommand, params: FlyaiQueryParams): string[] {
  const args = [command, '--origin', params.from, '--destination', params.to, '--dep-date', params.date]
  const seatClass = params.seatClass !== undefined ? translateSeatClass(params.seatClass) : undefined
  if (seatClass !== undefined) args.push('--seat-class-name', seatClass)
  args.push('--sort-type', '2')
  return args
}

// ────────────────────────── 响应归一化（§5.1 项 3） ──────────────────────────

export interface FlyaiSegment {
  depCityName?: string | null
  depStationName?: string | null
  arrCityName?: string | null
  arrStationName?: string | null
  depDateTime?: string | null
  arrDateTime?: string | null
  marketingTransportName?: string | null
  marketingTransportNo?: string | null
  seatClassName?: string | null
}

export interface FlyaiJourney {
  journeyType?: string | null
  segments?: FlyaiSegment[]
  totalDuration?: string | null
}

export interface FlyaiItem {
  journeys?: FlyaiJourney[]
  jumpUrl?: string | null
  ticketPrice?: string | number | null
  totalDuration?: string | number | null
}

export interface FlyaiApiResult {
  status?: number
  message?: string | null
  data?: { itemList?: FlyaiItem[] } | null
  systemMessage?: string | null
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** "2026-09-20 22:00:00" / "2026-09-06 06:08:00" → "22:00" / "06:08"。 */
export function hhmmOfDatetime(datetime: string | null | undefined): string | undefined {
  if (!datetime) return undefined
  const m = /(\d{1,2}):(\d{2})/.exec(datetime)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined
}

/** 直达班次优先（中转组合超出 M2.3 单段归一化范围）。无直达 → undefined（跳过）。 */
function directJourney(item: FlyaiItem): FlyaiJourney | undefined {
  const journeys = item.journeys ?? []
  return journeys.find((j) => (j?.journeyType ?? '') === '直达')
}

/** 单条目 → TransportOption（§5.5 规范形；解析失败的字段如实留空）。 */
export function flyaiItemToOption(
  item: FlyaiItem,
  mode: 'flight' | 'rail',
  keyed: boolean,
): TransportOption | undefined {
  const journey = directJourney(item)
  const seg = journey?.segments?.[0]
  if (!seg) return undefined
  const from = seg.depStationName ?? seg.depCityName
  const to = seg.arrStationName ?? seg.arrCityName
  if (!from || !to) return undefined
  const price = toFiniteNumber(item.ticketPrice)
  const priceRange: [number, number] | undefined = price !== undefined ? [price, price] : undefined
  const duration = toFiniteNumber(journey?.totalDuration ?? item.totalDuration)
  return {
    mode,
    segments: [{
      no: seg.marketingTransportNo ?? undefined,
      from,
      to,
      depart: hhmmOfDatetime(seg.depDateTime),
      arrive: hhmmOfDatetime(seg.arrDateTime),
      priceRange,
    }],
    totalPriceRange: priceRange,
    ...(priceRange !== undefined ? { currency: 'CNY' } : {}),
    // §5.5 契约：durationMinutes 须为 ≥0 整数（validateTransportOption 闸门）
    durationMinutes: duration !== undefined && Number.isInteger(duration) && duration >= 0 ? duration : undefined,
    tags: [
      keyed ? '飞猪 flyai（正式档）' : '飞猪 flyai（零 key 试用档）',
      seg.seatClassName ?? (mode === 'flight' ? '航班' : '火车'),
    ],
    bookingTips: ['价格为参考区间，以购票时实时价格为准；预订跳转飞猪（jumpUrl）'],
    source: {
      platform: 'flyai',
      url: item.jumpUrl ?? 'https://flyai.open.fliggy.com/',
      fetchedAt: new Date().toISOString(),
    },
  }
}

/** 飞猪响应 → TransportOption[]（直达去重；无法归一条目跳过）。 */
export function optionsFromFlyai(data: FlyaiApiResult, mode: 'flight' | 'rail', keyed: boolean): TransportOption[] {
  const items = data.data?.itemList ?? []
  const seen = new Set<string>()
  const out: TransportOption[] = []
  for (const item of items) {
    const opt = flyaiItemToOption(item, mode, keyed)
    if (!opt) continue
    const seg = opt.segments[0]
    const key = `${seg.no ?? ''}/${seg.from}${seg.to}/${seg.depart ?? ''}/${opt.totalPriceRange?.[0] ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(opt)
  }
  return out
}

// ────────────────────────── 适配器 ──────────────────────────

export interface FlyaiOptions {
  /** 显式 CLI 路径（测试注入 fake；缺省走解析链）。 */
  binPath?: string
  timeoutMs?: number
}

export class FlyaiAdapter extends BaseAdapter {
  private readonly binPath?: string
  private readonly timeoutMs: number

  constructor(opts: FlyaiOptions = {}) {
    super('flyai', {
      supports: new Set([CAP_SEAT_CLASS, CAP_MAX_PRICE, CAP_ZERO_KEY]),
    })
    this.binPath = opts.binPath
    this.timeoutMs = opts.timeoutMs ?? 45000
  }

  /** 渠道开关 + 二进制就位（零 key 试用档：无 key 也可用）。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    if (!channelEnabled('flyai', env)) return false
    return resolveFlyaiCommand(this.binPath) !== undefined
  }

  /** 机票查询（search-flight；零 key 试用）。 */
  async queryFlights(params: FlyaiQueryParams, env?: KeyResolutionEnv): Promise<TransportOption[]> {
    return this.query('search-flight', params, 'flight', env)
  }

  /** 火车查询（search-train；零 key 试用；12306 互备位）。 */
  async queryTrains(params: FlyaiQueryParams, env?: KeyResolutionEnv): Promise<TransportOption[]> {
    return this.query('search-train', params, 'rail', env)
  }

  private async query(
    command: FlyaiCommand,
    params: FlyaiQueryParams,
    mode: 'flight' | 'rail',
    env?: KeyResolutionEnv,
  ): Promise<TransportOption[]> {
    // 档位标签：key 已配置 → 正式档；否则零 key 试用档（零明文：只判存在性）
    const keyed = (await resolveKey(FLYAI_KEY, env)) !== undefined
    const resp = await this.runCli(buildFlyaiArgs(command, params))
    const options = optionsFromFlyai(resp, mode, keyed)
    if (options.length === 0) {
      throw EngineError.empty(resp.message ?? '飞猪查询无结果（体验档可能受限）', 'flyai')
    }
    return options
  }

  /** 子进程执行（stdout 单行 JSON；超时/非零退出 → EngineError）。 */
  private async runCli(args: string[]): Promise<FlyaiApiResult> {
    const cmd = resolveFlyaiCommand(this.binPath)
    if (!cmd) {
      throw EngineError.unavailable('flyai CLI 未就位（安装 @fly-ai/flyai-cli 或设 FLYAI_CLI_BIN）', 'flyai')
    }
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(cmd.file, [...cmd.args, ...args], {
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          const message = err instanceof Error ? err.message : String(err)
          if ('killed' in err && err.killed === true) {
            reject(EngineError.timeout(`flyai CLI 超时（${this.timeoutMs}ms）`, 'flyai'))
            return
          }
          reject(EngineError.unavailable(`flyai CLI 执行失败（${message.slice(0, 140)}）`, 'flyai'))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw EngineError.unavailable(`flyai 输出非 JSON（可能未安装/试用受限）：${stdout.slice(0, 120)}`, 'flyai')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw EngineError.unavailable(`flyai 输出结构异常：${stdout.slice(0, 120)}`, 'flyai')
    }
    return parsed as FlyaiApiResult
  }
}