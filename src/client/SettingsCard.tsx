/**
 * dsh-travel 设置卡（design §10.1 UI 结构三分组；FR-8）。
 *
 * 注册入 `settings.plugin.item`（keyed by 命名空间 'travel'）：设置-插件页
 * 按服务命名空间 dispatch，本卡与 node 半注册的 travel 命名空间自动配对。
 * 三分组：
 *   1) 功能渠道开关矩阵（FR-3~FR-7，每项独立启停，含 Key 需求标注）
 *   2) 渠道 Key 管理（逐 Key 卡片：脱敏 write-only 输入 + 删除）
 *   3) 高级配置（枚举/数字/文本）
 * NFR-10 冗余校验为软警示（冗余不足警告条，允许强制保存；弹窗化属 v2）。
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ADVANCED_FIELDS, CHANNEL_FIELDS, CHANNEL_GROUPS, COMPANION_SERVICE_IDS, KEY_FIELDS,
  type ChannelGroup,
} from './fields'
import { UsagePanel } from './UsagePanel'
import { fetchKeyStatus, mergeKeyConfigured, type KeyStatusResult } from './key-status'
import type { TravelCardState, TravelEditPath, TravelSettingsCardFace } from './form'
import type { TravelSettingsCardKey } from './locales'

/** 渲染器绑定的 props：runtime（keyed root）+ travel 文案 + 本卡注入面。 */
export type TravelSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'travel'>
  & InjectFace<TravelSettingsCardFace>

/** 卡内 scoped 样式（--dsw-alias-* 主题变量，与官方设置面一致）。 */
const CARD_CSS = `
.dsh-travel-card{display:flex;flex-direction:column;gap:12px;padding:4px 0 8px}
.dsh-travel-group{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-travel-groupSummary,.dsh-travel-subgroupSummary{list-style:none;display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.dsh-travel-groupSummary{padding:12px 14px}
.dsh-travel-groupSummary::-webkit-details-marker,.dsh-travel-subgroupSummary::-webkit-details-marker{display:none}
.dsh-travel-groupSummary::marker,.dsh-travel-subgroupSummary::marker{content:''}
.dsh-travel-groupSummary:focus-visible,.dsh-travel-subgroupSummary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-travel-groupSummary::after,.dsh-travel-subgroupSummary::after{content:'⌄';color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:1.2;transition:transform .16s;flex:none}
.dsh-travel-group[open] > .dsh-travel-groupSummary::after,.dsh-travel-subgroup[open] > .dsh-travel-subgroupSummary::after{transform:rotate(180deg)}
.dsh-travel-groupSummaryText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-travel-subgroupTitle{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.dsh-travel-subgroup{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dsh-travel-subgroupSummary{padding:4px 0}
.dsh-travel-subgroupFieldset{border:0;min-inline-size:0;margin:0;padding:0}
.dsh-travel-visuallyHidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-travel-subgroupBody{display:flex;flex-direction:column;gap:0}
.dsh-travel-groupBody{display:flex;flex-direction:column;gap:8px;padding:0 14px 12px}
.dsh-travel-usageBody{display:flex;flex-direction:column;gap:8px;padding:0 0 4px}
details.dsh-travel-group:not([open]) > .dsh-travel-groupBody,details.dsh-travel-subgroup:not([open]) > .dsh-travel-subgroupFieldset,details.dsh-travel-subgroup:not([open]) > .dsh-travel-subgroupBody,details.dsh-travel-usage:not([open]) > .dsh-travel-usageBody{display:none}
.dsh-travel-groupTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}
.dsh-travel-groupHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dsh-travel-row{display:flex;align-items:center;gap:8px;padding:6px 0}
.dsh-travel-row + .dsh-travel-row{border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-travel-switch{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer}
.dsh-travel-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-travel-rowLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dsh-travel-rowHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.4}
.dsh-travel-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;flex:none}
.dsh-travel-badgeOk{white-space:nowrap;background:var(--dsw-alias-state-success-tint);color:var(--dsw-alias-state-success-primary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;flex:none}
.dsh-travel-badgeWarn{white-space:nowrap;background:var(--dsw-alias-state-warn-tint);color:var(--dsw-alias-state-warn-label);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;flex:none}
.dsh-travel-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;width:100%;box-sizing:border-box}
.dsh-travel-input:disabled{opacity:.6;cursor:default}
.dsh-travel-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-travel-invalid{border-color:var(--dsw-alias-label-error)}
.dsh-travel-button{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0;flex:none}
.dsh-travel-button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-travel-button:disabled{opacity:.4;cursor:default}
.dsh-travel-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-travel-banner{border:1px solid var(--dsw-alias-state-warn-border);background:var(--dsw-alias-state-warn-tint);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:4px}
.dsh-travel-bannerTitle{color:var(--dsw-alias-state-warn-label);font-size:12px;font-weight:600;line-height:1.5}
.dsh-travel-bannerBody{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}
.dsh-travel-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dsh-travel-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dsh-travel-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding-top:4px}
.dsh-travel-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dsh-travel-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border:1px solid transparent}
.dsh-travel-save:hover:not(:disabled){opacity:.9}
.dsh-travel-select{max-width:220px}
.dsh-travel-modalMask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:40}
.dsh-travel-modal{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;max-width:420px;width:calc(100% - 32px);display:flex;flex-direction:column;gap:10px}
.dsh-travel-modalTitle{color:var(--dsw-alias-state-warn-label);font-size:14px;font-weight:600;line-height:1.5}
.dsh-travel-modalBody{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.6;white-space:pre-line}
.dsh-travel-modalActions{display:flex;justify-content:flex-end;gap:8px}
`

/** 渠道组标题 locale 键。 */
function groupTitleKey(group: ChannelGroup): TravelSettingsCardKey {
  return `${group}.title` as TravelSettingsCardKey
}

/** 渠道字段 locale 键前缀。 */
function channelKey(id: string, suffix: 'label' | 'hint'): TravelSettingsCardKey {
  return (suffix === 'label' ? `ch.${id}` : `ch.${id}Hint`) as TravelSettingsCardKey
}

interface CollapsibleGroupProps {
  title: ReactNode
  hint?: ReactNode
  children: ReactNode
}

/** Native details/summary keeps each settings group independently keyboard accessible. */
function CollapsibleGroup(props: CollapsibleGroupProps): JSX.Element {
  return (
    <details className="dsh-travel-group" open>
      <summary className="dsh-travel-groupSummary">
        <span className="dsh-travel-groupSummaryText">
          <span className="dsh-travel-groupTitle">{props.title}</span>
          {props.hint !== undefined && <span className="dsh-travel-groupHint">{props.hint}</span>}
        </span>
      </summary>
      <div className="dsh-travel-groupBody">{props.children}</div>
    </details>
  )
}

/**
 * 渲染设置卡。命名空间未服务（notExposed）或未就绪时不渲染表单主体；
 * 就绪时渲染三分组 + NFR-10 软警示 + 保存/放弃。
 *
 * M3.6：挂载后拉一次 `/travel-key-status`（credentials 层回显，configured/channelEnabled
 * 双面零 secret 布尔），Key 徽章只用 configured 合并；渠道开关仍由 settings 状态单独
 * 表达，避免把「已配」误当「可用」——生产 settings 无 travel.keys 但 credentials 已配
 * refs 时也能正确显示已配置。
 */
export function SettingsCard(props: TravelSettingsCardProps) {
  const { t } = props
  const state = props.useTravelCard((snapshot) => snapshot)
  // 远程 key 状态（只布尔；失败/形状不符 → undefined → 回落 settings-only）。
  const [remoteKeys, setRemoteKeys] = useState<KeyStatusResult | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void fetchKeyStatus().then((result) => { if (alive) setRemoteKeys(result) })
    return () => { alive = false }
  }, [])
  const disabled = !state.writable || !state.exposed
  const insufficient = state.redundancy.filter((report) => report.insufficient)

  /** Key 行「已配置」合并判定（settings-only OR 远程 configured=true）。 */
  const keyConfigured = (id: string): boolean => {
    const row = state.keys.find((key) => key.id === id)
    return mergeKeyConfigured(row?.configured === true, remoteKeys?.[id])
  }

  return (
    <div className="dsh-travel-card">
      <style>{CARD_CSS}</style>
      <div>
        <div className="dsh-travel-groupTitle">{t('settings.title')}</div>
        <p className="dsh-travel-groupHint">{t('settings.description')}</p>
      </div>

      {state.dirty && (
        <div className="dsh-travel-badgeWarn" style={{ alignSelf: 'flex-start' }}>{t('settings.dirty')}</div>
      )}

      {!state.available ? null : !state.exposed ? (
        <p className="dsh-travel-hint">{t('settings.notExposed')}</p>
      ) : !state.writable ? (
        <p className="dsh-travel-hint">{t('settings.readOnly')}</p>
      ) : (
        <>
          {/* ── ① 功能渠道开关矩阵（FR-3~FR-7） ── */}
          <CollapsibleGroup title={t('group.channels')} hint={t('group.channelsHint')}>
            {CHANNEL_GROUPS.map((group) => {
              const defs = CHANNEL_FIELDS.filter((def) => def.group === group)
              const enabledCount = defs.filter((def) => state.channels[group][def.id].text === 'true').length
              return (
                <details className="dsh-travel-subgroup" key={group} open>
                  <summary className="dsh-travel-subgroupSummary">
                    <span className="dsh-travel-subgroupTitle">
                      <span className="dsh-travel-groupTitle" style={{ fontSize: 12 }}>{t(groupTitleKey(group))}</span>
                      <span className="dsh-travel-badge">{enabledCount}/{defs.length}</span>
                    </span>
                  </summary>
                  <fieldset className="dsh-travel-subgroupFieldset">
                    <legend className="dsh-travel-visuallyHidden">{t(groupTitleKey(group))}</legend>
                    <div className="dsh-travel-subgroupBody">
                      {defs.map((def) => {
                        const row = state.channels[group][def.id]
                        const on = row.text === 'true'
                        return (
                          <div className="dsh-travel-row" key={def.id}>
                            <label className="dsh-travel-switch">
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={disabled}
                                onChange={() => { props.edit(`channels.${group}.${def.id}` as TravelEditPath, !on) }}
                              />
                              <span className="dsh-travel-rowText">
                                <span className="dsh-travel-rowLabel">{t(channelKey(def.id, 'label'))}</span>
                                <span className="dsh-travel-rowHint">{t(channelKey(def.id, 'hint'))}</span>
                              </span>
                            </label>
                            {def.keyId !== undefined && (
                              <span className={keyConfigured(def.keyId) ? 'dsh-travel-badgeOk' : 'dsh-travel-badgeWarn'}>
                                {keyConfigured(def.keyId) ? t('key.configured') : t('key.unconfigured')}
                              </span>
                            )}
                            {def.keyId === undefined && (
                              <span className="dsh-travel-badgeOk">{t('key.zeroKeyBadge')}</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </fieldset>
                </details>
              )
            })}
          </CollapsibleGroup>

          {/* ── ② 渠道 Key 管理 ── */}
          <CollapsibleGroup title={t('group.keys')} hint={t('group.keysHint')}>
            {KEY_FIELDS.map((def) => {
              const row = state.keys.find((item) => item.id === def.id)
              if (row === undefined) return null
              return (
                <div className="dsh-travel-row" key={def.id}>
                  <span className="dsh-travel-rowText" style={{ flex: 1 }}>
                    <span className="dsh-travel-rowLabel">{t(`key.${def.id}` as TravelSettingsCardKey)}</span>
                    <span className="dsh-travel-rowHint">{t(`key.${def.id}Hint` as TravelSettingsCardKey)}</span>
                  </span>
                  <span className={keyConfigured(def.id) ? 'dsh-travel-badgeOk' : 'dsh-travel-badge'}>
                    {keyConfigured(def.id) ? t('key.masked') : t('key.unconfigured')}
                  </span>
                  <input
                    className="dsh-travel-input"
                    style={{ maxWidth: 240, flex: 1 }}
                    type="password"
                    value={row.draft}
                    disabled={disabled}
                    placeholder={/* @allow: DOM input attribute, not a work placeholder */ t('key.placeholder')}
                    onChange={(event) => { props.edit(`keys.${def.id}` as TravelEditPath, event.target.value) }}
                  />
                  <button
                    className={row.clearing ? 'dsh-travel-button dsh-travel-danger' : 'dsh-travel-button'}
                    disabled={disabled}
                    onClick={() => { props.clearKey(def.id, !row.clearing) }}
                  >
                    {row.clearing ? '✓' : '×'}
                  </button>
                </div>
              )
            })}
            <p className="dsh-travel-hint">{t('key.zeroKeyNote')}</p>
          </CollapsibleGroup>

          {/* ── ③ 高级配置 ── */}
          <CollapsibleGroup title={t('group.advanced')} hint={t('group.advancedHint')}>
            {ADVANCED_FIELDS.map((def) => {
              const row = state.advanced[def.id]
              return (
                <div className="dsh-travel-row" key={def.id}>
                  <span className="dsh-travel-rowText" style={{ flex: 1 }}>
                    <span className="dsh-travel-rowLabel">{t(`adv.${def.id}` as TravelSettingsCardKey)}</span>
                    <span className="dsh-travel-rowHint">{t(`adv.${def.id}Hint` as TravelSettingsCardKey)}</span>
                  </span>
                  {def.kind === 'toggle' ? (
                    <input
                      type="checkbox"
                      checked={row.text === 'true'}
                      disabled={disabled}
                      onChange={(event) => { props.edit(`advanced.${def.id}` as TravelEditPath, event.target.checked) }}
                    />
                  ) : def.kind === 'choice' ? (
                    <select
                      className={`dsh-travel-input dsh-travel-select${row.invalid ? ' dsh-travel-invalid' : ''}`}
                      value={row.text}
                      disabled={disabled}
                      onChange={(event) => { props.edit(`advanced.${def.id}` as TravelEditPath, event.target.value) }}
                    >
                      {row.text === '' && <option value="" />}
                      {def.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                    </select>
                  ) : (
                    <input
                      className={`dsh-travel-input${row.invalid ? ' dsh-travel-invalid' : ''}`}
                      style={{ maxWidth: 240, flex: 1 }}
                      type={def.kind === 'number' ? 'number' : 'text'}
                      value={row.text}
                      disabled={disabled}
                      onChange={(event) => { props.edit(`advanced.${def.id}` as TravelEditPath, event.target.value) }}
                    />
                  )}
                </div>
              )
            })}

            {/* ── M3.5 伴随服务按需拉起（默认关闭=与 M2 行为一致；开启后工具首次
                 需要某服务且不健康时由 supervisor 按需拉起 + 健康等待） ── */}
            <details className="dsh-travel-subgroup" open>
              <summary className="dsh-travel-subgroupSummary">
                <span className="dsh-travel-subgroupTitle">
                  <span className="dsh-travel-groupTitle" style={{ fontSize: 12 }}>{t('group.companion')}</span>
                </span>
              </summary>
              <div className="dsh-travel-subgroupBody">
                <div className="dsh-travel-row">
                  <label className="dsh-travel-switch">
                    <input
                      type="checkbox"
                      checked={state.companionAutostart.text === 'true'}
                      disabled={disabled}
                      onChange={(event) => { props.edit('advanced.companionAutostart', event.target.checked) }}
                    />
                    <span className="dsh-travel-rowText">
                      <span className="dsh-travel-rowLabel">{t('companion.autostart')}</span>
                      <span className="dsh-travel-rowHint">{t('companion.autostartHint')}</span>
                    </span>
                  </label>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '0 0 0 18px' }}>
                  {COMPANION_SERVICE_IDS.map((id) => {
                    const row = state.companionServices[id]
                    return (
                      <div className="dsh-travel-row" key={id}>
                        <label className="dsh-travel-switch">
                          <input
                            type="checkbox"
                            checked={row.text === 'true'}
                            disabled={disabled}
                            onChange={(event) => { props.edit(`advanced.companionServices.${id}` as TravelEditPath, event.target.checked) }}
                          />
                          <span className="dsh-travel-rowText">
                            <span className="dsh-travel-rowLabel">{t(`companion.${id}` as TravelSettingsCardKey)}</span>
                            <span className="dsh-travel-rowHint">{t(`companion.${id}Hint` as TravelSettingsCardKey)}</span>
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </div>
                <p className="dsh-travel-hint">{t('companion.note')}</p>
              </div>
            </details>

            {/* ── M3.3 用量统计面板（NFR-6 可视化；只读 /travel-metrics + cloak profile 一键清除） ── */}
            <UsagePanel title={t('group.usage')} hint={t('group.usageHint')} />
          </CollapsibleGroup>

          {/* ── NFR-10 冗余软警示 ── */}
          {insufficient.length > 0 ? (
            <div className="dsh-travel-banner">
              <div className="dsh-travel-bannerTitle">{t('redundancy.title')}</div>
              <p className="dsh-travel-bannerBody">
                {t('redundancy.body')}{' '}
                {insufficient.map((report) => `${report.group}(${report.enabled}/${report.total})`).join('、')}。
                {t('redundancy.saveAnyway')}
              </p>
            </div>
          ) : (
            <p className="dsh-travel-meta">{t('redundancy.ok')}</p>
          )}

          {/* ── 操作：保存 / 放弃 ── */}
          <div className="dsh-travel-footer">
            {state.failed && <p className="dsh-travel-failed">{t('settings.saveFailed')}{state.failedReason ? `（${state.failedReason}）` : ''}</p>}
            <button className="dsh-travel-button" disabled={disabled || !state.dirty || state.saving} onClick={props.discard}>
              {t('settings.discard')}
            </button>
            <button className="dsh-travel-button dsh-travel-save" disabled={disabled || !state.dirty || state.saving} onClick={props.save}>
              {state.saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </>
      )}

      {/* ── NFR-10 冗余不足确认弹窗（v2：拦截保存，显式强制越过） ── */}
      {state.redundancyModal && (
        <div className="dsh-travel-modalMask" role="dialog" aria-modal="true">
          <div className="dsh-travel-modal">
            <div className="dsh-travel-modalTitle">{t('modal.redundancyTitle')}</div>
            <p className="dsh-travel-modalBody">
              {t('modal.redundancyBody')}{'\n'}
              {insufficient.map((report) => `${report.group}（${report.enabled}/${report.total}）`).join('、')}
            </p>
            <div className="dsh-travel-modalActions">
              <button className="dsh-travel-button" onClick={props.cancelRedundancy}>{t('modal.goBack')}</button>
              <button className="dsh-travel-button dsh-travel-danger" onClick={props.confirmSaveAnyway}>{t('modal.saveAnyway')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}