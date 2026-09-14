/**
 * 伴随服务 manifest（M3.5 / W5；roadmap.md:222-224「子进程自动拉起」）。
 *
 * 四个伴随服务的**内建安全描述**——命令/参数/环境全部写死在本文件（allowlist），
 * supervisor spawn 一律 `shell:false`，**不接收任何设置字符串拼进命令**：
 * key/cookie/profile 路径不得进 argv、日志、进程标题（执行计划 Must-Not-Have）。
 *
 * 固定字段：service / url / mode(local-process|docker|remote) / command+args /
 * cwd / env（envRefs，仅固定非敏感键值）/ health（探活）/ readyTimeoutMs（就绪
 * 超时）/ stopGraceMs（停止宽限）。可选 stopCommand 供 daemon 化脚本
 * （playwright-mcp.sh start 自行 setsid 后台化）走其内建停止路径。
 *
 * 服务映射（M2 CLOSURE §四 运维事实）：
 * - rail12306：local-process，`.venv-12306/bin/mcp-12306`（相对 workspace；
 *   env SERVER_HOST=127.0.0.1 SERVER_PORT=8123），health GET /health；
 * - xhs：docker（已安装容器 xiaohongshu-mcp，端口 18060），health GET /mcp
 *   （POST-only 端点用连通性判定——405/4xx 也算活，accept='any-response'）；
 * - playwright：local-process，`.test-env/playwright-mcp.sh start`，health
 *   GET http://localhost:8931/mcp（**localhost 字面量**——服务端 Host 校验
 *   拒绝 127.0.0.1，实测 403）；
 * - didi：remote，health-only（mcp.didichuxing.com 端点连通性，URL 零 key），
 *   **永不 spawn**。
 */

/** 伴随服务名（= per-service toggle 键 = supervisor ensure 参数）。 */
export type CompanionServiceName = 'rail12306' | 'xhs' | 'playwright' | 'didi'

/** 固定服务清单（遍历稳定顺序）。 */
export const COMPANION_SERVICES: readonly CompanionServiceName[] = ['rail12306', 'xhs', 'playwright', 'didi']

/** 管理模式：本地进程（直接托管）/ docker 容器（已安装，只 start/stop）/ remote（纯探活）。 */
export type CompanionMode = 'local-process' | 'docker' | 'remote'

/** 健康探活定义（零 secret：URL 一律不含 key/token）。 */
export interface CompanionHealthProbe {
  /** 探活 URL（GET）。 */
  url: string
  /** 探活动词（均为 GET；POST-only 端点用 accept='any-response' 连通性判定）。 */
  method: 'GET'
  /**
   * 健康判定口径：
   * - 'http-ok'：仅 2xx 视为健康（如 12306 /health）；
   * - 'any-response'：任何 HTTP 应答（含 400/405/403）都视为服务在位——
   *   适用于 MCP Streamable HTTP 端点（无会话 GET 常态 4xx）与远程连通性探测。
   */
  accept: 'http-ok' | 'any-response'
  /** 单次探测超时 ms。 */
  timeoutMs: number
}

/** 一个伴随服务的内建 manifest（命令面全部固定；禁止运行时拼接）。 */
export interface CompanionManifest {
  service: CompanionServiceName
  /** 人话名称（日志/指引用）。 */
  title: string
  mode: CompanionMode
  /** 业务端点（与各 adapter DEFAULT_*_URL 同值；适配器实际连接处）。 */
  url: string
  /**
   * 启动命令（local-process=程序路径；docker=可执行名）。相对路径以 workspace
   * 根解析；裸名走 PATH。必须在 COMPANION_COMMAND_ALLOWLIST 内。
   */
  command?: string
  /** 固定参数（逐字 spawn，不拼接任何设置字符串）。 */
  args?: readonly string[]
  /**
   * 可选停止命令（daemon 化脚本场景：spawn 的脚本进程即退，真实服务由脚本
   * setsid 后台化——stopAll 走脚本内建 stop 路径，仅对本插件启动的实例生效）。
   * 同样受 allowlist 约束。
   */
  stopCommand?: string
  stopArgs?: readonly string[]
  /** docker 容器名（mode=docker；仅 start/stop 已安装容器，绝不 run/安装）。 */
  container?: string
  /** spawn 工作目录（相对 workspace 根；缺省=workspace 根）。 */
  cwd?: string
  /**
   * envRefs：注入子进程的**固定非敏感**键值（如 SERVER_HOST/SERVER_PORT）。
   * 零 key/cookie/profile 路径；子进程 env 采用最小白名单继承（见 supervisor），
   * 不透传宿主全量 env（防 DIDI_MCP_KEY 等敏感值泄入子进程环境）。
   */
  env?: Readonly<Record<string, string>>
  health: CompanionHealthProbe
  /** 就绪超时：spawn/start 后轮询 health 的总预算。 */
  readyTimeoutMs: number
  /** 停止宽限：SIGTERM → 等待 → SIGKILL 的宽限窗口。 */
  stopGraceMs: number
  /** 安装/手动启动指引（ensure 失败时的人话文案；零 secret）。 */
  guide: string
}

/** rail12306 业务端点（rail12306.ts DEFAULT_RAIL_MCP_URL 同值）。 */
export const RAIL12306_MCP_URL = 'http://127.0.0.1:8123/mcp'
/** xhs 业务端点（xhs.ts DEFAULT_XHS_MCP_URL 同值）。 */
export const XHS_MCP_URL = 'http://127.0.0.1:18060/mcp'
/** playwright 业务端点（social-playwright.ts DEFAULT_PLAYWRIGHT_MCP_URL 同值；localhost 字面量）。 */
export const PLAYWRIGHT_MCP_URL = 'http://localhost:8931/mcp'
/** didi 远程端点（**不含 key** 的 base URL；真实调用 URL 由适配器经 env 组装，零落盘）。 */
export const DIDI_REMOTE_URL = 'https://mcp.didichuxing.com/mcp-servers'

/** 四个伴随服务的内建 manifest（只读；supervisor 缺省注册表）。 */
export const COMPANION_MANIFESTS: Readonly<Record<CompanionServiceName, CompanionManifest>> = {
  rail12306: {
    service: 'rail12306',
    title: '12306 MCP（drfccv/mcp-server-12306，只读）',
    mode: 'local-process',
    url: RAIL12306_MCP_URL,
    command: '.venv-12306/bin/mcp-12306',
    args: [],
    cwd: '.',
    env: { SERVER_HOST: '127.0.0.1', SERVER_PORT: '8123' },
    health: { url: 'http://127.0.0.1:8123/health', method: 'GET', accept: 'http-ok', timeoutMs: 2000 },
    readyTimeoutMs: 30_000,
    stopGraceMs: 5_000,
    guide: '手动启动：SERVER_HOST=127.0.0.1 SERVER_PORT=8123 .venv-12306/bin/mcp-12306（后台）；部署见 docs/deploy.md §2.1。',
  },
  xhs: {
    service: 'xhs',
    title: 'xiaohongshu-mcp（Docker，登录态主路径）',
    mode: 'docker',
    url: XHS_MCP_URL,
    command: 'docker',
    container: 'xiaohongshu-mcp',
    health: { url: XHS_MCP_URL, method: 'GET', accept: 'any-response', timeoutMs: 2000 },
    readyTimeoutMs: 30_000,
    stopGraceMs: 10_000,
    guide: 'xiaohongshu-mcp 为已安装 Docker 容器（xiaohongshu-mcp，端口 18060）：容器缺失时按 docs/deploy.md §xiaohongshu-mcp 装载（supervisor 只 start/stop 已安装容器，绝不联网安装）。',
  },
  playwright: {
    service: 'playwright',
    title: 'Playwright MCP（L1 登录态定向 / L2 正文渲染）',
    mode: 'local-process',
    url: PLAYWRIGHT_MCP_URL,
    command: '.test-env/playwright-mcp.sh',
    args: ['start'],
    stopCommand: '.test-env/playwright-mcp.sh',
    stopArgs: ['stop'],
    cwd: '.',
    health: { url: PLAYWRIGHT_MCP_URL, method: 'GET', accept: 'any-response', timeoutMs: 2000 },
    readyTimeoutMs: 45_000,
    stopGraceMs: 10_000,
    guide: '手动启动：.test-env/playwright-mcp.sh start（依赖 .test-env/tooling 内 @playwright/mcp 部署；探活必须 localhost 字面量——Host 校验拒 127.0.0.1）。部署见 docs/deploy.md。',
  },
  didi: {
    service: 'didi',
    title: '滴滴 MCP（远程托管）',
    mode: 'remote',
    url: DIDI_REMOTE_URL,
    health: { url: DIDI_REMOTE_URL, method: 'GET', accept: 'any-response', timeoutMs: 5000 },
    readyTimeoutMs: 5_000,
    stopGraceMs: 0,
    guide: '滴滴 MCP 为远程托管服务（mcp.didichuxing.com），无需本地启动：不可达=网络/上游故障（鉴权 key 经进程 env 组装，零落盘）。',
  },
}

/**
 * 内建 spawn 命令 allowlist（固定字符串；只覆盖本文件 manifest 声明的命令）。
 * supervisor 只允许 spawn/start 该集合内的 command/stopCommand——任何不在
 * allowlist 的命令（含设置字符串拼接出的路径）一律拒绝执行。
 */
export const COMPANION_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  COMPANION_MANIFESTS.rail12306.command ?? '',
  COMPANION_MANIFESTS.playwright.command ?? '',
  COMPANION_MANIFESTS.xhs.command ?? '',
])

/** 命令是否在 allowlist（undefined/空 = 不在）。 */
export function isCommandAllowlisted(command: string | undefined, allowlist: ReadonlySet<string> = COMPANION_COMMAND_ALLOWLIST): boolean {
  if (command === undefined || command.trim() === '') return false
  return allowlist.has(command)
}
