import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsCard } from './SettingsCard.tsx'
import { TravelSettingsCardController, TRAVEL_SETTINGS_NAMESPACE } from './form.ts'
import { en, zh } from './locales.ts'

/** Service providers loaded by the 0.1.7 client composition. */
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'configForms']

export function apply(ctx: Context): void {
  const t = ctx.locale.bind('travel')
  ctx.effect(() => ctx.locale.register('travel', { zh, en }), 'dsh-travel: locale dictionaries')

  const controller = new TravelSettingsCardController(
    ctx.configForms.get(TRAVEL_SETTINGS_NAMESPACE),
    ctx.configForms.describe(),
  )
  ctx.effect(() => () => controller.dispose(), 'dsh-travel: settings form subscription')
  ctx.effect(
    () => ctx.configForms.whileServed([TRAVEL_SETTINGS_NAMESPACE], () =>
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-travel',
        order: 70,
        label: () => t('settings.title'),
        locale: 'travel',
        inject: () => controller.inject(),
      }, SettingsCard)),
    ),
    'dsh-travel: settings section',
  )
}
