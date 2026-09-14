/**
 * 适配器层治理——OSM（Nominatim/Overpass）公共政策（W0 T4，草稿 H：185）。
 *
 * Nominatim 公共政策（https://operations.osmfoundation.org/policies/nominatim/）：
 * - 请求必须携带可识别的 User-Agent（含应用名/版本/可联系标识），不得匿名批量
 * - 响应应做缓存（同查询命中缓存，不重复请求同一数据）
 * - 频率限制约 1 次/秒（OSM_MIN_REQUEST_INTERVAL_MS=1000）；绝不批量穷举
 * - 本机的 OSM 访问统一走本节流器（跨代码路径共享同一时钟窗口）
 *
 * Overpass 纪律（注释约束，W2 实现时落实）：仅小区域查询；有界队列/冷却/总
 * 预算；不靠无限镜像规避限流。
 */
/** 可识别 UA（应用名 + 版本 + 政策链接；不得匿名批量请求）。 */
export const OSM_NOMINATIM_UA =
  'dsh-travel/0.0.1 (travel research; https://operations.osmfoundation.org/policies/nominatim/)'

/** 最小请求间隔（≤1 req/s；关于 1 秒：Nominatim 政策建议 ~1 req/s）。 */
export const OSM_MIN_REQUEST_INTERVAL_MS = 1000

/** 节流判定（allowed=false 时 waitMs = 还需等待毫秒数）。 */
export interface OsmAcquireResult {
  allowed: boolean
  /** 还需等待的毫秒数（0 = 立即可发）。 */
  waitMs: number
}

/** OSM 请求节流器（进程内单窗口；测试注入时钟）。 */
export interface OsmRateLimiter {
  /** 最近一次请求时间（-Infinity = 尚未请求）。 */
  lastCallAt(): number
  /** 预检：距离上一请求 <1000ms → 需等待；否则 allowed。 */
  acquire(): OsmAcquireResult
  /** 请求实际发出后记录（at 缺省 now）。 */
  noteCall(at?: number): void
}

/** 创建 OSM 节流器（now 注入供 fake-timer 测试）。 */
export function createOsmRateLimiter(now: () => number = () => Date.now()): OsmRateLimiter {
  let last = Number.NEGATIVE_INFINITY
  return {
    lastCallAt: () => last,
    acquire() {
      const at = now()
      const waitMs = last === Number.NEGATIVE_INFINITY
        ? 0
        : Math.max(0, last + OSM_MIN_REQUEST_INTERVAL_MS - at)
      return { allowed: waitMs === 0, waitMs }
    },
    noteCall(at?: number) {
      last = at ?? now()
    },
  }
}

/** Overpass 有界队列（W2 实现占位注释）：小区域、有界队列/冷却/总预算，
 * 不靠无限镜像规避限流——常量挂名供未来接线，不新增行为。 */
export const OVERPASS_MAX_BUDGET_QUERIES_PER_PLAN = 20