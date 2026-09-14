/**
 * CloakBrowser 增强位（M2.5 / W6）。
 *
 * 这是一个合规边界与生命周期骨架，不内置 CloakBrowser 依赖或浏览器驱动：
 * - 默认关闭，settings 开关与本次对话确认必须同时满足；
 * - profile 只落本机 `.dsh-travel/.profiles/<platform>/`，默认 7 天 TTL；
 * - 验证码/人机验证特征会立即终止当前源并返回 degraded，不做任何求解；
 * - license 只判定是否已配置，明文不进入结果、日志或 hook context；
 * - 真实增强分支通过 hook 挂接，未挂接或缺 license 的 live 明确 blocked。
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path'
import {
  BaseAdapter,
  RateLimitExceededError,
  resolveKey,
  type DegradedEntry,
  type DomainTokenBucket,
  type KeyResolutionEnv,
  type RobotsChecker,
} from './base.js'
import { resolveTravelRoot, TRAVEL_DIR_NAME } from '../store/paths.js'

export const CLOAK_BROWSER_PLATFORM = 'xiaohongshu'
/** 现有 settings channels.fr3.xhsCloak 的逻辑名。 */
export const CLOAK_CHANNEL = 'xhsCloak'
/** 现有 settings keys.cloakbrowser 的键名。 */
export const CLOAK_LICENSE_KEY = 'cloakbrowser'
export const CLOAK_LICENSE_SETTING_PATH = 'keys.cloakbrowser'
export const CLOAK_LICENSE_ENV = 'CLOAKBROWSER_LICENSE_KEY'
export const DEFAULT_CLOAK_PROFILE_TTL_DAYS = 7
export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CLOAK_PROFILE_TTL_MS = DEFAULT_CLOAK_PROFILE_TTL_DAYS * DAY_MS

/** 双闸门未满足时的统一透明文案（含用途与账号风险）。 */
export const CLOAK_AUTH_REQUIRED_REASON =
  'CloakBrowser 待授权：将以你的登录会话抓取平台内容，仅用于本次旅行规划；登录态自动化访问存在账号风控/封禁风险。必须同时满足设置开关与本次对话确认。'

/** license 缺失的 live 阻断文案；不包含 license 明文。 */
export const CLOAK_LIVE_LICENSE_BLOCKED_REASON =
  'CloakBrowser live blocked：license 未配置（settings keys.cloakbrowser / credentials / 环境变量均未命中）。'

/** 增强分支仅挂接位，未提供实际实现时的阻断文案。 */
export const CLOAK_HOOK_BLOCKED_REASON =
  'CloakBrowser live blocked：增强 hook 未挂接（当前仅保留合规与生命周期骨架）。'

/** 对 settings 结构的最小只读视图；复用现有 schema，不复制一套 schema。 */
export interface CloakSettingsView {
  channels?: {
    fr3?: {
      xhsCloak?: boolean
    }
  }
}

/** 双重授权输入。显式布尔值用于对话编排/测试；env 与 marker 是宿主接线兜底。 */
export interface CloakBrowserAuthorizationOptions {
  env?: KeyResolutionEnv
  settings?: CloakSettingsView
  /** settings 开关的直接覆盖；未提供时读取现有 channels.fr3.xhsCloak。 */
  settingEnabled?: boolean
  /** 当前调用对应的本次对话确认结果；不持久化、不从环境变量或文件推断。 */
  dialogConfirmed?: boolean
  platform?: string
}

export interface CloakAuthorizationState {
  settingEnabled: boolean
  dialogConfirmed: boolean
  enabled: boolean
  reason?: string
}

function truthyFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'no' || value === 'off' || value === '') return false
  return undefined
}

function readSettingFlag(options: CloakBrowserAuthorizationOptions): boolean {
  if (options.settingEnabled !== undefined) return options.settingEnabled
  const direct = options.settings?.channels?.fr3?.xhsCloak
  if (direct !== undefined) return direct

  const readSettings = options.env?.readSettings
  const fromSettings = readSettings?.(`channels.${CLOAK_CHANNEL}`)
    ?? readSettings?.('channels.fr3.xhsCloak')
  const settingFlag = truthyFlag(fromSettings)
  if (settingFlag !== undefined) return settingFlag

  // 既有 channel env 约定是后备设置位；与 schema 缺省不同的是本增强位安全侧默认 off。
  const fromEnv = (options.env?.env ?? process.env)[`TRAVEL_CHANNEL_${CLOAK_CHANNEL.toUpperCase()}`]
  return truthyFlag(fromEnv) ?? false
}

function readDialogConfirmation(options: CloakBrowserAuthorizationOptions): boolean {
  // 对话确认必须由当前会话调用方逐次显式传入；不接受 env/file marker，避免跨会话复用。
  return options.dialogConfirmed === true
}

/** 计算双闸门状态；任何单动作都不能启用增强位。 */
export function cloakBrowserAuthorization(
  options: CloakBrowserAuthorizationOptions = {},
): CloakAuthorizationState {
  const settingEnabled = readSettingFlag(options)
  const dialogConfirmed = readDialogConfirmation(options)
  const enabled = settingEnabled && dialogConfirmed
  if (enabled) return { settingEnabled, dialogConfirmed, enabled }
  return {
    settingEnabled,
    dialogConfirmed,
    enabled,
    reason: settingEnabled || dialogConfirmed
      ? CLOAK_AUTH_REQUIRED_REASON
      : 'CloakBrowser 默认关闭：需要设置开关 + 本次对话确认。',
  }
}

/** 公开的双重授权框架入口：true 仅代表两动作同时满足，不代表 live 已有 license。 */
export function enableCloakBrowser(
  options: CloakBrowserAuthorizationOptions = {},
): boolean {
  return cloakBrowserAuthorization(options).enabled
}

/** 仅检查第二闸；第一闸仍由 enableCloakBrowser 同时判定。 */
export function isCloakBrowserAuthorized(
  options: CloakBrowserAuthorizationOptions = {},
): boolean {
  return readDialogConfirmation(options)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function assertLocalRoot(root: string): void {
  // URL/UNC roots are not valid local workspace anchors; relative paths are resolved below.
  if (root.includes('\0') || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(root) || root.startsWith('\\\\')) {
    throw new Error('CloakBrowser profile root must be a local filesystem path')
  }
}

function canonicalLocalRoot(rawRoot: string): string {
  assertLocalRoot(rawRoot)
  const absolute = resolvePath(rawRoot)
  try {
    const entry = lstatSync(absolute)
    if (entry.isSymbolicLink()) throw new Error('CloakBrowser travel root must not be a symbolic link')
    if (!entry.isDirectory()) throw new Error('CloakBrowser travel root must be a directory')
    return realpathSync(absolute)
  } catch (error) {
    if (isMissingPathError(error)) return absolute
    throw error
  }
}

function assertSafePlatform(platform: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(platform) || platform === '.' || platform === '..') {
    throw new Error(`非法 CloakBrowser platform：${JSON.stringify(platform)}`)
  }
  return platform
}

function assertDirectoryOrMissing(path: string, label: string): void {
  try {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) throw new Error(`CloakBrowser ${label} must not be a symbolic link`)
    if (!entry.isDirectory()) throw new Error(`CloakBrowser ${label} must be a directory`)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
}

/** 逐级 no-follow 校验，避免 `.dsh-travel`/`.profiles` 祖先 symlink 越过本机根。 */
function assertProfileAncestorsSafe(travelRoot: string): string {
  const root = canonicalLocalRoot(travelRoot)
  const travelDir = join(root, TRAVEL_DIR_NAME)
  const profiles = join(travelDir, '.profiles')
  assertDirectoryOrMissing(travelDir, 'travel directory')
  assertDirectoryOrMissing(profiles, 'profiles directory')
  return profiles
}

/** `<root>/.dsh-travel/.profiles`，仅本机文件系统。 */
export function cloakProfilesRoot(travelRoot?: string): string {
  const root = canonicalLocalRoot(resolveTravelRoot(travelRoot))
  return join(root, TRAVEL_DIR_NAME, '.profiles')
}

/** `<root>/.dsh-travel/.profiles/<platform>`，platform 禁止路径穿越。 */
export function cloakProfilePath(
  platform = CLOAK_BROWSER_PLATFORM,
  travelRoot?: string,
): string {
  return join(cloakProfilesRoot(travelRoot), assertSafePlatform(platform))
}

export interface CloakProfileOptions {
  travelRoot?: string
  platform?: string
  ttlDays?: number
  now?: () => number
}

function normalizeTtlDays(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_CLOAK_PROFILE_TTL_DAYS
}

/** 热读现有 advanced.profileTtlDays；非法/缺省回到调用方提供的默认值。 */
export function cloakProfileTtlDays(
  env?: KeyResolutionEnv,
  fallback = DEFAULT_CLOAK_PROFILE_TTL_DAYS,
): number {
  const raw = env?.readSettings?.('advanced.profileTtlDays')
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return raw === undefined ? normalizeTtlDays(fallback) : normalizeTtlDays(parsed)
}

const PROFILE_CREATED_AT_FILE = '.dsh-profile-created-at'

function profileDirectoryExists(path: string): boolean {
  try {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) {
      throw new Error('CloakBrowser profile path must not be a symbolic link')
    }
    return entry.isDirectory()
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Browser profile 内部文件会持续改写目录 mtime；用本机内部的非敏感创建时间 marker 固定
 * TTL 起点，兼容没有 marker 的假 profile（回退到目录 mtime）。marker 不含账号、密码或 key。
 */
function profileCreatedAt(path: string): number {
  try {
    const value = Number(readFileSync(join(path, PROFILE_CREATED_AT_FILE), 'utf8').trim())
    if (Number.isFinite(value) && value >= 0) return value
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    // 旧 profile/测试假 profile 无 marker 时使用目录 mtime。
  }
  return statSync(path).mtimeMs
}

/**
 * 本机 profile 生命周期管理。所有入口都只操作计算出的 `.profiles/<platform>`，不会写
 * settings、credentials 或仓库；创建时间 marker 作为 TTL 起点，调用 ensure/purge 时执行 TTL。
 */
export class CloakProfileManager {
  readonly travelRoot: string
  readonly platform: string
  readonly now: () => number
  readonly ttlDays: number

  constructor(options: CloakProfileOptions = {}) {
    this.travelRoot = canonicalLocalRoot(resolveTravelRoot(options.travelRoot))
    this.platform = assertSafePlatform(options.platform ?? CLOAK_BROWSER_PLATFORM)
    this.now = options.now ?? (() => Date.now())
    this.ttlDays = normalizeTtlDays(options.ttlDays)
  }

  profilePath(platform = this.platform): string {
    return cloakProfilePath(platform, this.travelRoot)
  }

  /** 过期则删除当前 platform profile；返回是否删除。 */
  purgeExpired(platform = this.platform, ttlDays = this.ttlDays): boolean {
    assertProfileAncestorsSafe(this.travelRoot)
    const path = this.profilePath(platform)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(path)
    } catch (error) {
      if (isMissingPathError(error)) return false
      throw error
    }
    if (entry.isSymbolicLink()) {
      throw new Error('CloakBrowser profile path must not be a symbolic link')
    }
    if (!entry.isDirectory()) {
      rmSync(path, { force: true, recursive: true })
      return true
    }
    const age = this.now() - profileCreatedAt(path)
    if (age >= normalizeTtlDays(ttlDays) * DAY_MS) {
      rmSync(path, { force: true, recursive: true })
      return true
    }
    return false
  }

  /** 访问 profile 前自动清理过期目录；新目录的 TTL marker 使用注入时钟。 */
  ensureProfile(platform = this.platform, ttlDays = this.ttlDays): string {
    const profilesRoot = assertProfileAncestorsSafe(this.travelRoot)
    const path = join(profilesRoot, assertSafePlatform(platform))
    this.purgeExpired(platform, ttlDays)
    mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })
    chmodSync(dirname(profilesRoot), 0o700)
    chmodSync(profilesRoot, 0o700)
    const existed = profileDirectoryExists(path)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
    if (!existed) {
      const now = this.now()
      const stamp = new Date(now)
      const marker = join(path, PROFILE_CREATED_AT_FILE)
      writeFileSync(marker, String(now), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      chmodSync(marker, 0o600)
      utimesSync(path, stamp, stamp)
    }
    return path
  }

  /** 一键清除当前 platform profile（含 profile 内部 marker）。 */
  clearProfile(platform = this.platform): boolean {
    assertProfileAncestorsSafe(this.travelRoot)
    const path = this.profilePath(platform)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(path)
    } catch (error) {
      if (isMissingPathError(error)) return false
      throw error
    }
    if (entry.isSymbolicLink()) throw new Error('CloakBrowser profile path must not be a symbolic link')
    rmSync(path, { force: true, recursive: true })
    return true
  }

  /** 一键清除所有 CloakBrowser platform profiles。 */
  clearAllProfiles(): boolean {
    const root = assertProfileAncestorsSafe(this.travelRoot)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(root)
    } catch (error) {
      if (isMissingPathError(error)) return false
      throw error
    }
    if (entry.isSymbolicLink()) throw new Error('CloakBrowser profiles directory must not be a symbolic link')
    rmSync(root, { force: true, recursive: true })
    return true
  }
}

export function ensureCloakBrowserProfile(options: CloakProfileOptions = {}): string {
  return new CloakProfileManager(options).ensureProfile()
}

export function purgeExpiredCloakBrowserProfile(options: CloakProfileOptions = {}): boolean {
  return new CloakProfileManager(options).purgeExpired()
}

/** 支持 options 或 (platform, travelRoot) 两种清除调用形态。 */
export function clearCloakBrowserProfile(options?: CloakProfileOptions): boolean
export function clearCloakBrowserProfile(platform: string, travelRoot?: string): boolean
export function clearCloakBrowserProfile(
  optionsOrPlatform: CloakProfileOptions | string = {},
  travelRoot?: string,
): boolean {
  const options: CloakProfileOptions = typeof optionsOrPlatform === 'string'
    ? { platform: optionsOrPlatform, travelRoot }
    : optionsOrPlatform
  return new CloakProfileManager(options).clearProfile()
}

export function clearCloakBrowserProfiles(travelRoot?: string): boolean {
  return new CloakProfileManager({ travelRoot }).clearAllProfiles()
}

/** 只判定 license 是否存在；绝不把 license 值返回给调用方。 */
export async function isCloakBrowserLicenseConfigured(
  env?: KeyResolutionEnv,
): Promise<boolean> {
  if (await resolveKey(CLOAK_LICENSE_KEY, env) !== undefined) return true
  // 兼容直接传入 `keys.cloakbrowser` 的最小 settings fake；真实 makeKeyEnv 两种写法均支持。
  if (await resolveKey(CLOAK_LICENSE_SETTING_PATH, env) !== undefined) return true
  const raw = (env?.env ?? process.env)[CLOAK_LICENSE_ENV]
  return raw !== undefined && raw.trim().length > 0
}

/** 验证码/人机验证特征；命中即止，不尝试处理。 */
const CAPTCHA_FEATURE_RE =
  /captcha|re\s*captcha|h\s*captcha|turnstile|geetest|gee\s*test|arkose(?:\s+labs)?|cf[-_ ]?chl|challenge-platform|cloudflare.{0,40}challenge|verify\s+(?:you\s+are\s+)?human|security\s+check|人机验证|验证码|滑块验证|安全验证|请(?:完成|验证)身份/i

class CloakCaptchaAbort extends Error {
  constructor() {
    super('CloakBrowser source aborted on challenge feature')
    this.name = 'CloakCaptchaAbort'
  }
}

export interface CloakEnhancementContext {
  source: string
  platform: string
  /** 已通过 URL 解析与 robots/ToS 预检的目标 URL。 */
  url: string
  profilePath: string
  /** 真实 hook 应将此 signal 传给浏览器/网络操作。 */
  signal: AbortSignal
  /** 浏览器事件发现 challenge 时调用；立即 abort 并终止 hook 当前调用栈。 */
  abortOnCaptcha: (evidence?: unknown) => never
}

/** M2.5 挂接位：真实分支必须遵守 signal/abortOnCaptcha 协议；当前不引入新依赖。 */
export type CloakEnhancementHook = (
  context: CloakEnhancementContext,
) => Promise<unknown> | unknown

function unknownText(value: unknown, seen: Set<object>): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return ''
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => unknownText(entry, seen)).join('\n')
  const record = value as Record<string, unknown>
  return Object.entries(record)
    .map(([key, entry]) => `${key}: ${unknownText(entry, seen)}`)
    .join('\n')
}

export function hasCaptchaFeature(value: unknown): boolean {
  try {
    return CAPTCHA_FEATURE_RE.test(unknownText(value, new Set<object>()))
  } catch {
    return false
  }
}

export interface CloakLiveResult {
  status: 'disabled' | 'blocked' | 'ready'
  reason: string
  degraded: DegradedEntry[]
}

export interface CloakSourceOptions extends CloakBrowserAuthorizationOptions {
  source: string
  /** 真实目标 URL；缺失时 runSource fail-closed，不调用 hook。 */
  url?: string
}

export interface CloakSourceOutcome {
  status: 'ok' | 'disabled' | 'blocked' | 'degraded'
  liveStatus: CloakLiveResult['status']
  value?: unknown
  degraded: DegradedEntry[]
}

function disabledResult(reason: string, source: string): CloakLiveResult {
  return {
    status: 'disabled',
    reason,
    degraded: [{ source, code: 'UNAVAILABLE', reason, at: new Date().toISOString() }],
  }
}

function blockedResult(reason: string, source: string): CloakLiveResult {
  return {
    status: 'blocked',
    reason,
    degraded: [{ source, code: 'UNAVAILABLE', reason, at: new Date().toISOString() }],
  }
}

function sourceDegraded(source: string, reason: string): DegradedEntry {
  return { source, code: 'UNAVAILABLE', reason, at: new Date().toISOString() }
}

export interface CloakBrowserAdapterOptions extends CloakProfileOptions {
  enhancement?: CloakEnhancementHook
  /** hook 别名，便于宿主以“挂接位”命名注入；两者不同时以 enhancement 为准。 */
  hook?: CloakEnhancementHook
  /** 复用适配器层治理桶/robots 检查器，不另造治理机制。 */
  rateLimiter?: DomainTokenBucket
  robotsChecker?: RobotsChecker
}

export class CloakBrowserAdapter extends BaseAdapter {
  readonly profiles: CloakProfileManager
  private readonly enhancement?: CloakEnhancementHook
  private readonly defaultPlatform: string

  constructor(options: CloakBrowserAdapterOptions = {}) {
    super('cloakbrowser', { supports: new Set<string>() }, {
      rateLimiter: options.rateLimiter,
      robotsChecker: options.robotsChecker,
    })
    this.defaultPlatform = assertSafePlatform(options.platform ?? CLOAK_BROWSER_PLATFORM)
    this.profiles = new CloakProfileManager({
      travelRoot: options.travelRoot,
      platform: this.defaultPlatform,
      ttlDays: options.ttlDays,
      now: options.now,
    })
    this.enhancement = options.enhancement ?? options.hook
  }

  /** 授权 + license + hook 三项均就绪才报告 adapter available。 */
  override async available(env?: KeyResolutionEnv): Promise<boolean> {
    const auth = cloakBrowserAuthorization({
      env,
      platform: this.defaultPlatform,
    })
    if (!auth.enabled || this.enhancement === undefined) return false
    return isCloakBrowserLicenseConfigured(env)
  }

  /**
   * live 门：先双闸门，再 license，再增强挂接位。license 缺失时明确返回 blocked，
   * 不创建 profile、不调用 hook。
   */
  async live(options: CloakBrowserAuthorizationOptions = {}): Promise<CloakLiveResult> {
    const auth = cloakBrowserAuthorization({
      ...options,
      platform: options.platform ?? this.defaultPlatform,
    })
    const source = 'cloakbrowser'
    if (!auth.enabled) return disabledResult(auth.reason ?? CLOAK_AUTH_REQUIRED_REASON, source)
    if (!(await isCloakBrowserLicenseConfigured(options.env))) {
      return blockedResult(CLOAK_LIVE_LICENSE_BLOCKED_REASON, source)
    }
    if (this.enhancement === undefined) return blockedResult(CLOAK_HOOK_BLOCKED_REASON, source)
    return { status: 'ready', reason: 'CloakBrowser license 已配置，增强 hook 可挂接。', degraded: [] }
  }

  /** 当前 platform profile 路径；调用即执行 TTL 清理并按需创建。 */
  profilePath(env?: KeyResolutionEnv, platform = this.defaultPlatform): string {
    return this.profiles.ensureProfile(platform, cloakProfileTtlDays(env, this.profiles.ttlDays))
  }

  clearProfile(platform = this.defaultPlatform): boolean {
    return this.profiles.clearProfile(platform)
  }

  /** 执行单个源；治理预检与 challenge 事件守卫均在 hook 前置。 */
  async runSource(options: CloakSourceOptions): Promise<CloakSourceOutcome> {
    const live = await this.live(options)
    if (live.status !== 'ready') {
      return {
        status: live.status === 'disabled' ? 'disabled' : 'blocked',
        liveStatus: live.status,
        degraded: live.degraded,
      }
    }

    const rawUrl = options.url?.trim()
    if (!rawUrl) {
      const degraded = sourceDegraded(options.source, 'CloakBrowser 目标 URL 缺失，治理预检拒绝执行增强 hook。')
      return { status: 'blocked', liveStatus: live.status, degraded: [degraded] }
    }

    let targetUrl: URL
    try {
      targetUrl = new URL(rawUrl)
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') throw new Error('URL 协议不受支持')
    } catch {
      const degraded = sourceDegraded(options.source, 'CloakBrowser 目标 URL 非法，治理预检拒绝执行增强 hook。')
      return { status: 'blocked', liveStatus: live.status, degraded: [degraded] }
    }

    try {
      await this.acquireRate(targetUrl.hostname, { env: options.env })
    } catch {
      const degraded = sourceDegraded(options.source, `源 ${options.source} 触发域级频控，已降级。`)
      return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
    }

    try {
      const robots = await this.robotsCheck(targetUrl.toString(), { env: options.env })
      if (!robots.allowed) {
        return {
          status: 'degraded',
          liveStatus: live.status,
          degraded: [({ ...this.robotBlocked(targetUrl.toString(), robots), source: options.source })],
        }
      }
    } catch {
      const degraded = sourceDegraded(options.source, `源 ${options.source} 的 robots/ToS 预检失败，保守降级。`)
      return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
    }

    const enhancement = this.enhancement
    if (enhancement === undefined) {
      const blocked = blockedResult(CLOAK_HOOK_BLOCKED_REASON, 'cloakbrowser')
      return { status: 'blocked', liveStatus: blocked.status, degraded: blocked.degraded }
    }

    if (hasCaptchaFeature(rawUrl)) {
      const degraded = sourceDegraded(
        options.source,
        `源 ${options.source} 命中验证码/人机验证特征，已中止该源并降级；不处理验证码。`,
      )
      return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
    }

    const platform = options.platform ?? this.defaultPlatform
    let profilePath: string
    try {
      profilePath = this.profilePath(options.env, platform)
    } catch {
      const degraded = sourceDegraded(options.source, 'CloakBrowser profile 不可用，增强源已降级。')
      return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
    }

    const controller = new AbortController()
    let captchaAborted = false
    const abortOnCaptcha = (_evidence?: unknown): never => {
      captchaAborted = true
      controller.abort()
      throw new CloakCaptchaAbort()
    }

    try {
      const value = await enhancement({
        source: options.source,
        platform,
        url: targetUrl.toString(),
        profilePath,
        signal: controller.signal,
        abortOnCaptcha,
      })
      if (hasCaptchaFeature(value)) {
        const degraded = sourceDegraded(
          options.source,
          `源 ${options.source} 命中验证码/人机验证特征，已中止该源并降级；不处理验证码。`,
        )
        return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
      }
      // W6 骨架不把 hook 的 unknown payload 回传，避免敏感载荷外泄。
      return { status: 'ok', liveStatus: live.status, degraded: [] }
    } catch (error) {
      const errorValue = error instanceof Error ? error.message : error
      if (captchaAborted || error instanceof CloakCaptchaAbort || hasCaptchaFeature(errorValue)) {
        const degraded = sourceDegraded(
          options.source,
          `源 ${options.source} 命中验证码/人机验证特征，已中止该源并降级；不处理验证码。`,
        )
        return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
      }
      const degraded = sourceDegraded(options.source, `源 ${options.source} 增强分支失败（错误详情已省略）。`)
      return { status: 'degraded', liveStatus: live.status, degraded: [degraded] }
    }
  }
}
