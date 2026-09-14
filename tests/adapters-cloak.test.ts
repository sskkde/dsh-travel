/**
 * CloakBrowser 增强位单测（M2.5/W6）：默认 off、双重授权、profile TTL/clear、
 * 验证码中止降级、license 缺失 live blocked；真实增强分支只经 hook 挂接。
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLOAK_LICENSE_ENV,
  CLOAK_LICENSE_SETTING_PATH,
  CLOAK_LIVE_LICENSE_BLOCKED_REASON,
  DEFAULT_CLOAK_PROFILE_TTL_MS,
  CloakBrowserAdapter,
  CloakProfileManager,
  cloakProfilePath,
  enableCloakBrowser,
  hasCaptchaFeature,
  isCloakBrowserLicenseConfigured,
} from '../src/adapters/cloak.js'
import { RobotsChecker } from '../src/adapters/base.js'
import type { KeyResolutionEnv } from '../src/adapters/base.js'

function allowRobots(): RobotsChecker {
  return new RobotsChecker({ fetch: async () => ({ status: 404, text: async () => '' }) })
}

function denyRobots(): RobotsChecker {
  return new RobotsChecker({ fetch: async () => ({ status: 200, text: async () => 'User-agent: *\nDisallow: /' }) })
}

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-travel-cloak-'))
}

function emptyEnv(): KeyResolutionEnv {
  return { env: {} }
}

function licensedEnv(): KeyResolutionEnv {
  return { env: { [CLOAK_LICENSE_ENV]: 'configured' } }
}

describe('CloakBrowser 双重授权（默认 off；设置 + 对话确认）', () => {
  it('默认关闭：没有任何动作时拒绝', () => {
    expect(enableCloakBrowser({ env: emptyEnv() })).toBe(false)
  })

  it('仅设置开关 → 拒绝；仅对话确认 → 也拒绝', () => {
    expect(enableCloakBrowser({ env: emptyEnv(), settingEnabled: true, dialogConfirmed: false })).toBe(false)
    expect(enableCloakBrowser({ env: emptyEnv(), settingEnabled: false, dialogConfirmed: true })).toBe(false)
  })

  it('设置开关 + 对话确认同时满足 → 允许授权框架通过', () => {
    expect(enableCloakBrowser({ env: emptyEnv(), settingEnabled: true, dialogConfirmed: true })).toBe(true)
  })

  it('从现有 settings 路径读取开关与 license 键名，不复制 schema', async () => {
    const env: KeyResolutionEnv = {
      readSettings: (key) => {
        if (key === 'channels.xhsCloak') return 'true'
        if (key === CLOAK_LICENSE_SETTING_PATH) return 'configured'
        return undefined
      },
      env: {},
    }
    expect(enableCloakBrowser({ env, dialogConfirmed: true })).toBe(true)
    expect(await isCloakBrowserLicenseConfigured(env)).toBe(true)
  })

  it('环境变量不能伪造本次对话确认，必须显式传入当前确认结果', () => {
    const env: KeyResolutionEnv = { env: { TRAVEL_CLOAK_AUTHORIZED: '1' } }
    expect(enableCloakBrowser({ env, settingEnabled: true })).toBe(false)
    expect(enableCloakBrowser({ env, settingEnabled: true, dialogConfirmed: true })).toBe(true)
  })
})

const liveEnabled = process.env['TRAVEL_LIVE_SMOKE'] === '1'
describe.skipIf(!liveEnabled)('CloakBrowser live smoke：license gate（不启动浏览器，不求解验证码）', () => {
  it('真实运行入口在无 license 时保持 blocked', async () => {
    const adapter = new CloakBrowserAdapter({ enhancement: async () => 'unreachable' })
    const live = await adapter.live({
      env: { env: {} },
      settingEnabled: true,
      dialogConfirmed: true,
    })
    console.log(`[live-cloak] status=${live.status} reason=${live.reason}`)
    expect(live.status).toBe('blocked')
    expect(live.reason).toBe(CLOAK_LIVE_LICENSE_BLOCKED_REASON)
  })
})

describe('CloakBrowser profile：本机路径、7 天 TTL 与一键清除', () => {
  let root: string

  beforeEach(() => {
    root = scratchRoot()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('profile 只在 .dsh-travel/.profiles/<platform>，推进 7 天后自动删除旧目录', () => {
    const manager = new CloakProfileManager({ travelRoot: root, now: () => Date.now() })
    const profile = manager.ensureProfile()
    const marker = join(profile, 'local-profile-data')
    writeFileSync(marker, 'local-only')
    expect(profile).toBe(cloakProfilePath('xiaohongshu', root))
    expect(profile).toBe(join(root, '.dsh-travel', '.profiles', 'xiaohongshu'))
    expect(existsSync(marker)).toBe(true)

    vi.advanceTimersByTime(DEFAULT_CLOAK_PROFILE_TTL_MS + 1)
    expect(manager.purgeExpired()).toBe(true)
    expect(existsSync(profile)).toBe(false)
  })

  it('ensureProfile 在访问时执行 TTL 清理并建立新 profile', () => {
    const manager = new CloakProfileManager({ travelRoot: root, now: () => Date.now() })
    const first = manager.ensureProfile()
    writeFileSync(join(first, 'stale-entry'), 'stale')
    vi.advanceTimersByTime(DEFAULT_CLOAK_PROFILE_TTL_MS + 1)
    const second = manager.ensureProfile()
    expect(second).toBe(first)
    expect(existsSync(join(second, 'stale-entry'))).toBe(false)
    expect(existsSync(second)).toBe(true)
  })

  it('一键 clear 删除 profile（含内部 marker）且不影响 root 外文件', () => {
    const manager = new CloakProfileManager({ travelRoot: root, now: () => Date.now() })
    const profile = manager.ensureProfile()
    writeFileSync(join(profile, '.local-marker'), 'local-only')
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep')
    expect(manager.clearProfile()).toBe(true)
    expect(existsSync(profile)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    expect(manager.clearProfile()).toBe(false)
  })

  it('adapter 构造 ttlDays 在 settings 缺省时生效', () => {
    const adapter = new CloakBrowserAdapter({ travelRoot: root, ttlDays: 1, now: () => Date.now() })
    const profile = adapter.profilePath(emptyEnv())
    writeFileSync(join(profile, 'stale-entry'), 'stale')
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1)
    const refreshed = adapter.profilePath(emptyEnv())
    expect(refreshed).toBe(profile)
    expect(existsSync(join(refreshed, 'stale-entry'))).toBe(false)
  })

  it('拒绝 .dsh-travel 或 .profiles 祖先 symlink，外部目录不被写入/删除', () => {
    const outside = scratchRoot()
    const travelDir = join(root, '.dsh-travel')
    try {
      symlinkSync(outside, travelDir, 'dir')
      const manager = new CloakProfileManager({ travelRoot: root, now: () => Date.now() })
      expect(() => manager.ensureProfile()).toThrow(/symbolic link/)
      expect(() => manager.clearProfile()).toThrow(/symbolic link/)
      expect(existsSync(join(outside, '.profiles'))).toBe(false)
      unlinkSync(travelDir)

      mkdirSync(travelDir)
      const profiles = join(travelDir, '.profiles')
      symlinkSync(outside, profiles, 'dir')
      expect(() => manager.ensureProfile()).toThrow(/symbolic link/)
      expect(() => manager.clearAllProfiles()).toThrow(/symbolic link/)
      expect(existsSync(join(outside, 'xiaohongshu'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('CloakBrowser live hook：license gate 与验证码降级', () => {
  it('license 缺失时 live 明确 blocked，且不创建 profile/调用增强 hook', async () => {
    const root = scratchRoot()
    let hookCalls = 0
    try {
      const adapter = new CloakBrowserAdapter({
        travelRoot: root,
        enhancement: async () => {
          hookCalls += 1
          return 'should-not-run'
        },
      })
      const live = await adapter.live({
        env: emptyEnv(),
        settingEnabled: true,
        dialogConfirmed: true,
      })
      expect(live.status).toBe('blocked')
      expect(live.reason).toBe(CLOAK_LIVE_LICENSE_BLOCKED_REASON)
      expect(live.degraded[0]?.reason).toBe(CLOAK_LIVE_LICENSE_BLOCKED_REASON)
      expect(hookCalls).toBe(0)
      expect(existsSync(cloakProfilePath('xiaohongshu', root))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('验证码特征 → 立即中止当前源并返回 degraded，不求解验证码', async () => {
    const root = scratchRoot()
    let hookCalls = 0
    try {
      const adapter = new CloakBrowserAdapter({
        travelRoot: root,
        robotsChecker: allowRobots(),
        enhancement: async () => {
          hookCalls += 1
          return { text: '请完成验证码后继续' }
        },
      })
      const outcome = await adapter.runSource({
        source: 'xiaohongshu',
        url: 'https://example.invalid/source',
        env: licensedEnv(),
        settingEnabled: true,
        dialogConfirmed: true,
      })
      expect(outcome.status).toBe('degraded')
      expect(outcome.liveStatus).toBe('ready')
      expect(outcome.value).toBeUndefined()
      expect(outcome.degraded).toHaveLength(1)
      expect(outcome.degraded[0]?.code).toBe('UNAVAILABLE')
      expect(outcome.degraded[0]?.reason).toContain('验证码')
      expect(outcome.degraded[0]?.reason).toContain('中止该源')
      expect(outcome.degraded[0]?.reason).toContain('不处理验证码')
      expect(hookCalls).toBe(1)
      expect(hasCaptchaFeature({ html: 'Cloudflare challenge' })).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hook 事件调用 abortOnCaptcha → 立即抛出并终止当前源，不继续执行后续逻辑', async () => {
    const root = scratchRoot()
    let continued = false
    try {
      const adapter = new CloakBrowserAdapter({
        travelRoot: root,
        robotsChecker: allowRobots(),
        enhancement: async ({ abortOnCaptcha, signal }) => {
          expect(signal.aborted).toBe(false)
          abortOnCaptcha({ provider: 'turnstile' })
          continued = true
          return 'unreachable'
        },
      })
      const outcome = await adapter.runSource({
        source: 'xiaohongshu',
        url: 'https://example.invalid/source',
        env: licensedEnv(),
        settingEnabled: true,
        dialogConfirmed: true,
      })
      expect(outcome.status).toBe('degraded')
      expect(outcome.degraded[0]?.source).toBe('xiaohongshu')
      expect(outcome.degraded[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(continued).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺目标 URL 或 robots 禁抓时不调用 hook，治理边界 fail-closed', async () => {
    const root = scratchRoot()
    let hookCalls = 0
    try {
      const adapter = new CloakBrowserAdapter({
        travelRoot: root,
        robotsChecker: denyRobots(),
        enhancement: async () => {
          hookCalls += 1
          return 'unreachable'
        },
      })
      const missingUrl = await adapter.runSource({
        source: 'xiaohongshu',
        env: licensedEnv(),
        settingEnabled: true,
        dialogConfirmed: true,
      })
      expect(missingUrl.status).toBe('blocked')
      expect(hookCalls).toBe(0)

      const robotsBlocked = await adapter.runSource({
        source: 'xiaohongshu',
        url: 'https://example.invalid/source',
        env: licensedEnv(),
        settingEnabled: true,
        dialogConfirmed: true,
      })
      expect(robotsBlocked.status).toBe('degraded')
      expect(robotsBlocked.degraded[0]?.reason).toContain('robots.txt')
      expect(hookCalls).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无验证码的 hook 结果通过骨架但不向结果回传 unknown payload', async () => {
    const root = scratchRoot()
    try {
      const adapter = new CloakBrowserAdapter({
        travelRoot: root,
        robotsChecker: allowRobots(),
        enhancement: async (context) => {
          expect(context.profilePath).toContain(join('.dsh-travel', '.profiles', 'xiaohongshu'))
          expect(context.source).toBe('xiaohongshu')
          expect(context.url).toBe('https://example.invalid/source')
          expect(context.signal.aborted).toBe(false)
          expect('license' in context).toBe(false)
          return { title: 'safe result', sensitiveField: 'must-not-return' }
        },
      })
      const outcome = await adapter.runSource({
        source: 'xiaohongshu',
        url: 'https://example.invalid/source',
        env: licensedEnv(),
        settingEnabled: true,
        dialogConfirmed: true,
      })
      expect(outcome.status).toBe('ok')
      expect(outcome.value).toBeUndefined()
      expect(outcome.degraded).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
