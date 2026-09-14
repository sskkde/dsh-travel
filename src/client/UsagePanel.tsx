/**
 * 用量统计面板（M3.3 / NFR-6 可视化；设置卡高级组内嵌，不建独立导航面）。
 *
 * - 数据源：只读同源 `GET /travel-metrics`（redacted projection，零 secret）；
 *   挂载时自动拉取一次 + 手动刷新按钮。
 * - 呈现：AMap 月度配额预算条（quota/limit）、缓存命中率（分母=hit+miss）、
 *   L0/L0.5 检索量、fan-out 尝试/重试、治理拒绝/拦截、degraded 聚合、
 *   统计月份与上次重置时间。
 * - Cloak 一键清除：两段确认按钮（第一次点击仅进入确认态，第二次才发
 *   `POST /travel-metrics/cloak-clear?confirm=clear`，路由侧同样要求 POST +
 *   confirm 参数双重防误触）；**只清 profile 文件，不激活任何自动 hook**。
 *
 * 零依赖约定（与 fields.ts 同）：除 react 外不 import 任何模块——
 * 路由 path 与投影类型都在本模块内承载（投影=src/metrics/usage.ts
 * TravelMetricsProjection 的 client 面结构镜像，改动须同步；fields.ts 镜像先例）。
 * 状态机与视图模型为纯函数导出（client 单测只覆盖纯逻辑的仓库口径）。
 */
import { useCallback, useEffect, useReducer, type JSX } from 'react'

/** metrics 路由（与 src/metrics/usage.ts TRAVEL_METRICS_PATH 同字面量）。 */
export const USAGE_METRICS_PATH = '/travel-metrics'
/** cloak 清除路由（与 TRAVEL_METRICS_CLOAK_CLEAR_PATH 同字面量）。 */
export const USAGE_CLOAK_CLEAR_PATH = '/travel-metrics/cloak-clear'

// ────────────────────────── 投影结构镜像（client 面；与 node 侧 usage.ts 对齐） ──────────────────────────

/** source × plan 明细行（镜像 usage.ts UsageRecord）。 */
export interface UsageProjectionEntry {
  source: string
  planId: string
  logical: number
  quota: number
  network: number
  poi: number
  rest: number
  searchL0Queries: number
  searchL05Fetches: number
  cacheHits: number
  cacheMisses: number
  fanoutAttempts: number
  fanoutRetries: number
  rateLimitRejects: number
  robotsBlocked: number
  degraded: Record<string, number>
}

/** GET /travel-metrics 响应体（镜像 usage.ts TravelMetricsProjection；零 secret）。 */
export interface TravelMetricsProjection {
  month: string
  lastResetAt: string
  generatedAt: string
  amap: { logical: number; quota: number; network: number; poi: number; rest: number; monthlyLimit: number }
  search: { l0Queries: number; l05Fetches: number }
  cache: { hits: number; misses: number; rate: number | null }
  fanout: { attempts: number; retries: number }
  governance: { rateLimitRejects: number; robotsBlocked: number }
  degraded: Array<{ source: string; code: string; count: number }>
  entries: UsageProjectionEntry[]
}

// ────────────────────────── 状态机（纯函数，可单测） ──────────────────────────

export interface UsagePanelState {
  /** metrics 拉取状态（error 时保留上次 metrics 供展示）。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  metrics?: TravelMetricsProjection
  /** 最近一次成功刷新的本地时间文本。 */
  fetchedAt?: string
  error?: string
  /** cloak 清除按钮状态（idle → confirm 二次确认 → clearing → cleared/error）。 */
  cloak: 'idle' | 'confirm' | 'clearing' | 'cleared' | 'error'
  cloakMessage?: string
}

export type UsagePanelAction =
  | { type: 'refresh-start' }
  | { type: 'refresh-ok'; metrics: TravelMetricsProjection; fetchedAt: string }
  | { type: 'refresh-error'; message: string }
  | { type: 'cloak-arm' }
  | { type: 'cloak-disarm' }
  | { type: 'cloak-start' }
  | { type: 'cloak-ok'; cleared: boolean }
  | { type: 'cloak-error'; message: string }

export function createUsagePanelState(): UsagePanelState {
  return { status: 'idle', cloak: 'idle' }
}

export function applyUsagePanelAction(state: UsagePanelState, action: UsagePanelAction): UsagePanelState {
  switch (action.type) {
    case 'refresh-start':
      return { ...state, status: 'loading', error: undefined }
    case 'refresh-ok':
      return { ...state, status: 'ready', metrics: action.metrics, fetchedAt: action.fetchedAt, error: undefined }
    case 'refresh-error':
      return { ...state, status: 'error', error: action.message }
    case 'cloak-arm':
      return { ...state, cloak: 'confirm', cloakMessage: undefined }
    case 'cloak-disarm':
      return { ...state, cloak: 'idle', cloakMessage: undefined }
    case 'cloak-start':
      return { ...state, cloak: 'clearing', cloakMessage: undefined }
    case 'cloak-ok':
      return {
        ...state,
        cloak: 'cleared',
        cloakMessage: action.cleared ? '已清除全部 CloakBrowser profile。' : '无残留 profile（目录不存在或此前已清除）。',
      }
    case 'cloak-error':
      return { ...state, cloak: 'error', cloakMessage: `清除失败：${action.message}` }
  }
}

// ────────────────────────── 视图模型（纯函数，可单测） ──────────────────────────

export interface UsageViewModel {
  /** 预算条百分比（0~100 封顶；limit 非法 → 0）。 */
  amapPercent: number
  amapBudgetText: string
  amapDetailText: string
  cacheRateText: string
  cacheDetailText: string
  searchLine: string
  fanoutLine: string
  governanceLine: string
  degradedLines: string[]
  monthLine: string
}

/** projection → 面板展示模型（无数据时给占位形态，不抛错）。 */
export function buildUsageViewModel(metrics: TravelMetricsProjection | undefined): UsageViewModel {
  if (metrics === undefined) {
    return {
      amapPercent: 0,
      amapBudgetText: '— / —',
      amapDetailText: '暂无数据',
      cacheRateText: '—',
      cacheDetailText: '命中 — · 未命中 —',
      searchLine: '暂无数据',
      fanoutLine: '暂无数据',
      governanceLine: '暂无数据',
      degradedLines: [],
      monthLine: '暂无数据',
    }
  }
  const limit = metrics.amap.monthlyLimit
  const percent = limit > 0 ? Math.min(100, Math.round((metrics.amap.quota / limit) * 100)) : 0
  const rate = metrics.cache.rate
  return {
    amapPercent: Number.isFinite(percent) ? percent : 0,
    amapBudgetText: `${metrics.amap.quota} / ${limit}`,
    amapDetailText: `逻辑 ${metrics.amap.logical} · 网络 ${metrics.amap.network} · POI ${metrics.amap.poi} · REST ${metrics.amap.rest}`,
    cacheRateText: rate === null ? '—' : `${Math.round(rate * 100)}%`,
    cacheDetailText: `命中 ${metrics.cache.hits} · 未命中 ${metrics.cache.misses}`,
    searchLine: `L0 查询 ${metrics.search.l0Queries} · L0.5 直抓 ${metrics.search.l05Fetches}`,
    fanoutLine: `尝试 ${metrics.fanout.attempts} · 重试 ${metrics.fanout.retries}`,
    governanceLine: `频控拒绝 ${metrics.governance.rateLimitRejects} · robots 拦截 ${metrics.governance.robotsBlocked}`,
    degradedLines: metrics.degraded.map((entry) => `${entry.source} · ${entry.code} × ${entry.count}`),
    monthLine: `统计月份 ${metrics.month} · 上次重置 ${metrics.lastResetAt}`,
  }
}

// ────────────────────────── 组件 ──────────────────────────

export interface UsagePanelProps {
  /** metrics 只读路由（同源；缺省 /travel-metrics）。 */
  metricsPath?: string
  /** cloak 清除路由（同源；缺省 /travel-metrics/cloak-clear）。 */
  cloakClearPath?: string
  /** 可选的本地化折叠标题与说明；缺省保持独立使用时的既有文案。 */
  title?: string
  hint?: string
}

function formatNow(): string {
  return new Date().toLocaleTimeString()
}

/** 设置卡高级组用量面板（自拉取 + 手动刷新 + cloak profile 两段确认清除）。 */
export function UsagePanel(props: UsagePanelProps): JSX.Element {
  const metricsPath = props.metricsPath ?? USAGE_METRICS_PATH
  const cloakClearPath = props.cloakClearPath ?? USAGE_CLOAK_CLEAR_PATH
  const [state, dispatch] = useReducer(applyUsagePanelAction, undefined, createUsagePanelState)

  const refresh = useCallback(async (): Promise<void> => {
    dispatch({ type: 'refresh-start' })
    try {
      const res = await fetch(metricsPath, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const metrics = (await res.json()) as TravelMetricsProjection
      dispatch({ type: 'refresh-ok', metrics, fetchedAt: formatNow() })
    } catch (error) {
      dispatch({ type: 'refresh-error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [metricsPath])

  useEffect(() => { void refresh() }, [refresh])

  const onCloakClick = useCallback(async (): Promise<void> => {
    if (state.cloak !== 'confirm') {
      dispatch({ type: 'cloak-arm' })
      return
    }
    dispatch({ type: 'cloak-start' })
    try {
      const res = await fetch(`${cloakClearPath}?confirm=clear`, {
        method: 'POST',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const body = (await res.json().catch(() => undefined)) as { ok?: boolean; cleared?: boolean } | undefined
      if (!res.ok || body?.ok !== true) throw new Error(`HTTP ${res.status}`)
      dispatch({ type: 'cloak-ok', cleared: body.cleared === true })
    } catch (error) {
      dispatch({ type: 'cloak-error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [cloakClearPath, state.cloak])

  const view = buildUsageViewModel(state.metrics)
  const budgetTone = view.amapPercent >= 90
    ? 'var(--dsw-alias-state-error-primary)'
    : view.amapPercent >= 70
      ? 'var(--dsw-alias-state-warn-label)'
      : 'var(--dsw-alias-brand-primary)'
  const title = props.title ?? '用量统计'

  return (
    <details className="dsh-travel-subgroup dsh-travel-usage" open>
      <summary className="dsh-travel-subgroupSummary">
        <span className="dsh-travel-groupSummaryText">
          <span className="dsh-travel-groupTitle" style={{ fontSize: 12 }}>{title}</span>
          {props.hint !== undefined && <span className="dsh-travel-groupHint">{props.hint}</span>}
        </span>
      </summary>
      <div className="dsh-travel-usageBody">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {state.status === 'error' && <span className="dsh-travel-hint">加载失败：{state.error}</span>}
          <button
            type="button"
            className="dsh-travel-button"
            style={{ marginLeft: 'auto' }}
            disabled={state.status === 'loading'}
            onClick={() => { void refresh() }}
          >
            {state.status === 'loading' ? '刷新中…' : '刷新'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="dsh-travel-hint">高德配额（本月）：{view.amapBudgetText}</span>
          <div
            role="progressbar"
            aria-label="AMap 月度配额用量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.amapPercent}
            style={{ height: 6, borderRadius: 999, background: 'var(--dsw-alias-bg-module-platform)', overflow: 'hidden' }}
          >
            <div style={{ width: `${view.amapPercent}%`, height: '100%', background: budgetTone }} />
          </div>
          <span className="dsh-travel-hint">{view.amapDetailText}</span>
        </div>

        <span className="dsh-travel-hint">缓存命中率：{view.cacheRateText}（{view.cacheDetailText}）</span>
        <span className="dsh-travel-hint">检索：{view.searchLine}</span>
        <span className="dsh-travel-hint">fan-out：{view.fanoutLine}</span>
        <span className="dsh-travel-hint">治理：{view.governanceLine}</span>
        {view.degradedLines.length > 0 ? (
          <span className="dsh-travel-hint">降级聚合：{view.degradedLines.join('；')}</span>
        ) : (
          <span className="dsh-travel-hint">降级聚合：无</span>
        )}
        <span className="dsh-travel-meta">{state.fetchedAt !== undefined ? `刷新于 ${state.fetchedAt} · ` : ''}{view.monthLine}</span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={state.cloak === 'confirm' ? 'dsh-travel-button dsh-travel-danger' : 'dsh-travel-button'}
            disabled={state.cloak === 'clearing'}
            onClick={() => { void onCloakClick() }}
          >
            {state.cloak === 'confirm'
              ? '再次点击确认清除'
              : state.cloak === 'clearing'
                ? '清除中…'
                : '清除 CloakBrowser 登录态 profile'}
          </button>
          {state.cloakMessage !== undefined && <span className="dsh-travel-hint">{state.cloakMessage}</span>}
        </div>
      </div>
    </details>
  )
}
