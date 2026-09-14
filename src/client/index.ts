/**
 * dsh-travel client 半（exports["./client"]，design §10.1 行 654 注册机制）。
 *
 * 注册流程（先例 dsh-web-search-pro / live-stats SettingsCard）：
 * 1. `inject = ['slots','locale','connection','settingsScope']`（服务注入声明）
 * 2. `ctx.locale.register('travel', {zh, en})` 双语字典（'travel' 命名空间 + 键域
 *    已并入 LocaleNamespaceMap）
 * 3. `ctx.slots.inject('settings.plugin.item', …)`：keyed 槽，key = 设置命名空间
 *    'travel'——设置-插件页按命名空间 dispatch，与 node 半注册的 travel 命名空间
 *    自动配对（registrant 无需知道宿主的配对逻辑）
 * 4. 控制器接 `ctx.settingsScope.bind({namespace:'travel'})` + 共享 describe mirror
 *    + `ctx.connection.api.settings`（组合聚合写面），卡注销时 dispose
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// type-only：载入各服务的 Context 模块增强（ctx.locale / ctx.settingsScope / 槽声明）
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// 'connection' 服务客户端 Context 增强缺失（该 rc 未合并），此处补结构声明——
// 运行时服务由 dsh-client-connection 注入（官方 bundle 普遍 ctx.get('connection')）
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SettingsCard } from './SettingsCard.tsx'
import { TravelSettingsCardController } from './form.ts'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-client-connection 客户端 wire handle（结构复用其 ConnectionHandle 类型）。 */
    connection: ConnectionHandle
  }
}

/** 设置命名空间（= 注册 key = settingsScope.bind 目标，三处同字面量）。 */
export const TRAVEL_NS = 'travel'

/** 服务注入声明：slots（注册槽）/ locale（双语）/ connection（settings 写面）/ settingsScope（命名空间绑定）。 */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(TRAVEL_NS, { zh, en }), 'dsh-travel: locale dictionaries')

  const controller = new TravelSettingsCardController(
    ctx.settingsScope.bind({ namespace: TRAVEL_NS }),
    ctx.settingsScope.describe(),
    ctx.connection.api.settings,
  )

  // 设置-插件页卡片（'settings.plugin.item' 为 keyed 槽；key=命名空间）
  ctx.slots.inject('settings.plugin.item', () => {
    const unregister = ctx.slots.register({
      name: 'settings.plugin.item',
      key: TRAVEL_NS,
      locale: TRAVEL_NS,
      inject: () => controller.inject(),
    }, SettingsCard)
    return () => {
      controller.dispose()
      unregister()
    }
  })
}