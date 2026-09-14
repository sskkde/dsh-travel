/**
 * 伴随服务健康探活（M3.5 / W5）：fetch + 超时 + 重试轮询到 ready timeout。
 *
 * 设计：
 * - probeHealthOnce：单次 GET 探测。网络失败/超时 = 不健康；HTTP 应答按
 *   manifest 的 accept 口径判定（'http-ok'=仅 2xx；'any-response'=任何状态码
 *   都算在位——MCP Streamable HTTP 端点无会话 GET 常态 4xx、POST-only 端点
 *   GET 405，均属「服务活着」）。
 * - pollHealthUntilReady：按间隔轮询直到就绪超时；supervisor dispose 中途
 *   取消（isAborted）。
 * - 零 secret：探活 URL 来自 manifest 固定字段（不含 key/token）；错误信息
 *   只含 fetch 层 message（连接拒绝/超时），不含任何凭据。
 */
import type { CompanionHealthProbe } from './manifests.js'

/** 健康探测 fetch 面（node fetch 最小子集；测试注入 fake）。 */
export type HealthFetchFn = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ status: number }>

/** 单次探活结果（healthy=false 时 error 为 fetch 层人话原因，零 secret）。 */
export interface HealthProbeResult {
  healthy: boolean
  /** HTTP 状态码（拿到应答时）。 */
  status?: number
  /** 失败原因（网络层 message；未拿到应答时缺省 status）。 */
  error?: string
}

/** 缺省 fetch（globalThis.fetch；signal 超时由调用方注入）。 */
const defaultHealthFetch: HealthFetchFn = (url, init) =>
  globalThis.fetch(url, init) as Promise<{ status: number }>

/**
 * 单次健康探测：GET probe.url（AbortSignal.timeout 超时）。
 * 永不抛错——失败一律归一为 { healthy:false, error }（探活失败不阻塞降级链）。
 */
export async function probeHealthOnce(
  probe: CompanionHealthProbe,
  fetchFn: HealthFetchFn = defaultHealthFetch,
): Promise<HealthProbeResult> {
  try {
    const response = await fetchFn(probe.url, {
      method: probe.method,
      signal: AbortSignal.timeout(probe.timeoutMs),
    })
    const status = response.status
    const healthy = probe.accept === 'any-response' ? true : status >= 200 && status < 300
    return healthy ? { healthy, status } : { healthy, status, error: `HTTP ${status}` }
  } catch (error) {
    return { healthy: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 轮询选项。 */
export interface HealthPollOptions {
  /** 就绪总预算 ms（manifest.readyTimeoutMs）。 */
  readyTimeoutMs: number
  /** 轮询间隔 ms（缺省 500）。 */
  intervalMs?: number
  /** fetch 注入（测试 fake）。 */
  fetchFn?: HealthFetchFn
  /** 中止判定（supervisor dispose 时取消轮询；返回 true 即退出）。 */
  isAborted?: () => boolean
}

/**
 * 轮询探活直到健康 / 就绪超时 / 中止。
 * 首探立即执行；间隔 sleep 可被超时边界截断；返回最后一次探测结果。
 */
export async function pollHealthUntilReady(
  probe: CompanionHealthProbe,
  options: HealthPollOptions,
): Promise<HealthProbeResult> {
  const intervalMs = Math.max(1, options.intervalMs ?? 500)
  const deadline = Date.now() + options.readyTimeoutMs
  let last: HealthProbeResult = { healthy: false, error: '未执行探测' }
  for (;;) {
    last = await probeHealthOnce(probe, options.fetchFn)
    if (last.healthy) return last
    if (options.isAborted?.()) {
      return { healthy: false, error: '探活轮询已中止（supervisor 停止）' }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return last
    await sleep(Math.min(intervalMs, remaining))
  }
}

/** 可截断 sleep（定时器 unref，不阻塞进程退出）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}
