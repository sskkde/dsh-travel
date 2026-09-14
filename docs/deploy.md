# dsh-travel 部署说明（M1 初稿 v0.1）

> 状态：W0 工程地基起草。`12306 MCP` 一节为部署指南初稿，待 W2b（rail12306 适配器工作包）**实测回填** CLI 细节与验证输出。
> 关联：`docs/roadmap.md` M1.0 部署 DoD · `docs/design.md` §5.4 渠道与降级 · `docs/research/reusable-opensrc-mcp.md`

## 1. 插件构建与注入（DSH dev 链路）

| 步骤 | 命令/工具 | 说明 |
|---|---|---|
| 安装依赖 | `npm install` | devDeps（typescript/vitest/tsdown）+ peerDeps（cordis 等范围声明，npm 10 自动装） |
| 类型检查 | `npm run typecheck`（`npx tsc --noEmit`） | V1 闸门，exit 0 |
| 单测 | `npm test`（`npx vitest run`） | V1 闸门，exit 0 |
| 构建 | `dev_build_plugin(dir=<包根>)` | `scripts/build.sh` 自动探测 DSH_CHECKOUT → junction link + tsc 编译 `src/` → `lib/`；有 `build:client` 则 tsdown 编 client |
| 注入 | `dev_inject_plugin(dir=<包根>)` | 运行时装载（junction + loader.create，免重启） |
| 状态 | `dev_plugin_status` | 应可见 `dsh-travel` 条目 |
| 注入器自检 | `dev_self_test` | 全链路 PASS |

- `DSH_CHECKOUT` 探测顺序：环境变量 → `$HOME/dsh-harness` / `$HOME/dsh` / `$HOME/.dsh/dsh-harness` → `/usr/lib/node_modules/@deepseek-ai/dsh`（全局 npm 安装形态）。
- 构建产物：`lib/index.js`（node 半）+ `lib/client.js`（client 半，`window.__ModuleLoader__.load` 注册）。

## 2. 12306 MCP server（HTTP 模式）部署指南

用途：`rail12306` 适配器（W2b）以 **只读** 方式查询余票/车次/票价。

### 2.1 只读红线（强制，违反即打回）

- 本 MCP 接入**仅限只读查询**（余票、车次时刻、票价档）。
- **绝不**触达购票/抢票/代付/改签/退票等任何写操作端点；工具白名单只读，代码层面不许出现写操作调用。
- 查询频率克制：默认低频（设计 NFR 频控，M2.6 落地）；不重试轰炸，失败记为 `EngineError.UNAVAILABLE` 走降级链。

### 2.2 venv 创建与安装（Python 3.10+）

```bash
# 独立 venv，避免污染系统 Python
python3 -m venv ~/.dsh-travel/venv-12306
~/.dsh-travel/venv-12306/bin/pip install --upgrade pip
~/.dsh-travel/venv-12306/bin/pip install mcp-server-12306
```

> ✅ **W2b 实测回填（2026-09-02）**：PyPI `mcp-server-12306` 实际安装版本
> `0.5.0.post20260822`（依赖链 mcp>=2.0.0/pydantic-settings/uvicorn 等自装）。实测
> CLI 入口非 `python -m mcp_server_12306`：entry points 由 `mcp_12306/` 包提供——
> **stdio 模式** = `mcp-server-12306`（`mcp_12306.stdio_server:main`）；
> **HTTP 模式** = `mcp-12306`（`mcp_12306.http_server:main`，Streamable HTTP）。
> 本环境沙箱限制 venv 至工作区内（`<包根>/.venv-12306`），生产环境照上文
> `~/.dsh-travel/venv-12306` 即可。

### 2.3 HTTP 模式启动（实测命令）

```bash
# HTTP transport（Streamable HTTP，非 stdio），供插件进程经 HTTP 接入
SERVER_HOST=127.0.0.1 SERVER_PORT=8123 LOG_LEVEL=INFO ~/.dsh-travel/venv-12306/bin/mcp-12306
```

- **实测 CLI 事实**：`mcp-12306` 无 argparse 参数（`--help` 会挂起进 stdio——错误用法）；
  配置经 pydantic-settings 读 env/`.env`：`SERVER_HOST`（**默认 0.0.0.0**，务必覆盖为
  `127.0.0.1`）、`SERVER_PORT`（**默认 8000**，覆盖为 8123）、`DEBUG`、`LOG_LEVEL`。
- 仅绑定 `127.0.0.1`（本机），不暴露公网；DSH 与插件同机部署。
- 启动形态建议：managed 后台 job / systemd user unit（随 DSH 会话托管，M3 再评估子进程自动拉起）。

### 2.3a 健康检查与端点（实测）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/mcp` | POST | MCP Streamable HTTP 端点（initialize 握手 → tools/call；`Mcp-Session-Id` 会话头） |
| `/health` | GET | `{"status":"healthy","stations":3384,"active_sessions":0}` |
| `/` | GET | 服务信息（含 7 只读工具清单 / 协议版本） |
| `/schema/tools` | GET | 工具 JSON Schema（旧版兼容） |

**实测工具清单（全部只读）**：`query-tickets`（余票/车次/时刻/座席）、
`query-ticket-price`、`search-stations`、`query-transfer`（中转）、
`get-train-route-stations`、`get-train-no-by-train-code`、`get-current-time`。
上游为官方 `kyfw.12306.cn`（实测单次查询 ~1-3s，返回 G 字头车次 55 条）。

### 2.4 端口约定

| 服务 | 端口 | 约定 |
|---|---|---|
| 12306 MCP（HTTP） | `8123` | 插件内默认值，经环境变量 `TRAVEL_RAIL_MCP_URL` 覆盖（默认 `http://127.0.0.1:8123/mcp`） |
| 行程页渲染 | `dshtravel` prefix 路由 | 不走独立端口，经 DSH webserver prefix（`/travel-plans/<planId>/`） |

端口冲突时以环境变量覆盖，不硬编码于业务代码之外。

### 2.5 接入方式（✅ W2b 已落地）

- 实测落地：`src/adapters/rail12306.ts` 内置最小 Streamable HTTP 客户端
  `McpStreamClient`（initialize 握手 → `tools/list` → `tools/call`，`Mcp-Session-Id`
  会话头），插件内直接 HTTP 调用 `/mcp`，零额外依赖（fetch）。
- 只读白名单 `READ_ONLY_TOOLS`（7 工具）+ `assertReadOnly()` 闸门：白名单外/交易类
  关键字（buy/pay/order/候补/购票/抢票…）调用一律 `EngineError.UNAVAILABLE` 拒绝。
- `available()` 判定：`/mcp` initialize 存活探测 + 渠道开关（ADR-12）双条件；
  不可达 → false → fan-out 跳过 + degraded 记账，不阻塞其他渠道。
- 互备位：`backupSources()` 声明 wendao（携程问道）/flyai 位，M2.3 填充。

## 3. 密钥与凭据（零明文）

- API key 落位 `$DSH_HOME/.credentials.yaml`（DSH credentials，version:1 refs）或环境变量；**零明文**落代码/fixture/日志。
- **Key 标识符约定**（resolveKey 首参 = env 兜底名；credentials 层 resolveCredential 回调把标识符映射为 ref 再调 `ctx.credentials.resolve(ref)`，W6 接线）：

| 标识符 | credentials ref | 用途 |
|---|---|---|
| `amapWebservice` | `amap/webservice` | 高德 Web 服务 REST（direction/weather/distance/geocode/POI） |
| `amapJsapi` | `amap/jsapi` | 高德 JS API（行程页地图；W5） |
| `amapJscode` | `amap/jscode` | JSAPI 安全码（**未交割**，W5 前可能补） |
| `wendao` | `wendao/apikey` | 携程问道 skill/query（无 key 自动休眠零调用） |

- 12306 本链路无登录口令类凭据（只读查询口）。

## 4. 验证清单（W0 状态）

- [x] `npx tsc --noEmit` exit 0
- [x] `npx vitest run` exit 0
- [x] `dev_build_plugin` exit 0；`dev_inject_plugin` 后 status 可见 dsh-travel
- [x] `dev_self_test` 全 PASS
- [x] 12306 MCP 实际部署 + 只读 query 实测（W2b 回填本节 CLI/输出；部署实录见 `docs/evidence/m1/w2b/`）

## 5. xiaohongshu-mcp（小红书登录态 MCP）部署指南（✅ W2/T3 实测 2026-09-04）

用途：`xhs` 适配器（`src/adapters/xhs.ts`，W2/T3）以**登录态只读检索**方式获取小红书旅行攻略（M2.1 关键路径）。上游 `xpzouying/xiaohongshu-mcp`（Docker 分发，内置无头浏览器 + 浏览器指纹）。

### 5.1 只读红线（强制，违反即打回）

- 上游工具面 18 个，其中**写端点 9 个**（publish_content / publish_with_video /
  post_comment_to_feed / reply_comment_in_feed / like_feed / like_notification /
  favorite_feed / reply_notification / delete_cookies）——**零注册**：适配器白名单
  `XHS_READ_ONLY_TOOLS`（search_feeds / get_feed_detail / check_login_status /
  get_login_qrcode）之外一律 `assertXhsReadOnly` 编译期拒绝（`McpStreamClient`
  `readOnlyGate` 注入）。
- 会话令牌 `xsecToken` 仅作 `get_feed_detail` 调用参数，**绝不落盘**（条目 URL 一律
  `canonicalXhsUrl` 剥 token）。
- 不做验证码求解；不请求账号密码；登录须用户扫码 + 双重授权（§5.4）。

### 5.2 Docker 部署（实测命令）

```bash
mkdir -p <工作区>/.dsh-travel/xhs-session   # 会话卷：cookies 持久化（扫码一次，重启保留）
docker run -d --name xiaohongshu-mcp \
  -p 18060:18060 \
  -v <工作区>/.dsh-travel/xhs-session:/data/cookies \
  xpzouying/xiaohongshu-mcp:latest
```

- **单会话约束**（docs/research/cloakbrowser.md:56）：一份 cookie 文件即一份登录态，
  全渠道共享；不要并行起第二个容器共用同一卷。
- 首次启动容器内自动拉起无头浏览器（镜像已含，无需宿主下载）。
- 指纹种子固定在 cookie 卷内（容器日志 `fingerprint seed pinned`），重启不变。

### 5.3 健康检查与端点（实测）

| 端点 | 方法 | 实测 |
|---|---|---|
| `/health` | GET | HTTP 200（进程存活） |
| `/mcp` | POST initialize | HTTP 200 + `Mcp-Session-Id` 会话头（Streamable HTTP） |
| `/mcp` tools/list | POST | 18 工具（§5.1 口径）；上游未标 `readOnlyHint`（实测全 undefined）——只读性由适配器白名单强制（§5.1），不依赖上游标注 |
| `/mcp` tools/call `check_login_status` | POST | 未登录 → 文本「❌ 未登录…」；已登录 →「✅ 已登录」 |

- **search_feeds 参数契约（实测 inputSchema）**：`{keyword, filters?}` 且
  `additionalProperties:false`——只传 `keyword`，条数上限客户端截取；多传 `limit`
  等未声明属性 → `-32602 invalid params`（调用面按失败计）。`get_feed_detail`
  调用契约：`{feed_id, xsec_token}`（required 二件）；**响应外层实测为
  `{feed_id, data:{note}}`**（note 内含 title/desc/time/ipLocation/interactInfo；
  响应自带 fresh xsecToken，适配器不透出）。

- **登录态语义陷阱（实测）**：未登录时 `search_feeds` **不报错、静默返回**
  `{"feeds":[],"count":0}`——适配器对空结果回查 `check_login_status`，「未登录」
  特征即会话失效 → 渠道自动降级 L0+L0.5（search.ts 既有链）。
- 插件接入默认 `http://127.0.0.1:18060/mcp`，env `TRAVEL_XHS_MCP_URL` 覆盖
  （端口约定同 §2.4 表；冲突时改 env 不改代码）。

### 5.4 授权双闸门与扫码交割（SKILL.md §6.1 同源）

1. **①闸（settings）**：渠道开关 `channels.fr3.xhsMcp`（设置页「小红书MCP」）。
2. **②闸（对话确认）**：用户明确同意后落授权标记 `.dsh-travel/xhs-session/.authorized`
   （或宿主 env `TRAVEL_XHS_AUTHORIZED=1`）；未授权 → 渠道 degraded「待授权（需对话确认）」
   + 登录会话用途 + **账号封禁风险**明示，零 MCP 调用。
3. **扫码**：用户同意后经 `get_login_qrcode`（只读）取二维码（MCP image 块 base64 PNG，
   实测有效期约 1-2 分钟——以响应文本截止时刻为准，如「请用小红书 App 在 … 前扫码登录」
   （容器内时区 UTC）；过期即重新调用取新码），由助手向用户出示；扫码成功后
   `check_login_status` 转「✅ 已登录」，会话落 cookie 卷持久化。

### 5.5 频控与降级

- 所有 MCP 调用前经 W1 令牌桶（域=`xiaohongshu.com`，默认 10 req/min 热读取）——
  MCP 只是本机代理，频控语义作用于上游站点配额。
- 容器停止/会话失效 → 渠道内自动降级 L0 种子 + L0.5 直抓（抽样语义标注 + 失效原因
  首条标注），流程不中断；降级链也无结果 → degraded 记账（fan-out 重试判定接管）。
## 6. Playwright MCP（L1 登录态定向 / L2 正文渲染）部署指南（✅ W3b 实测 2026-09-05）

dsh-travel 的社媒 L1（微博/豆瓣/贴吧/快手登录态定向搜索）与 L2（抖音详情页正文，
JS-SPA 必须 L2）共用本伴随服务（`src/adapters/social-playwright.ts`，McpStreamClient
复用 + 只读白名单六件）。`advanced.socialDepth`（默认 L1）控制启用深度；MCP 未部署
→ 渠道不可用记账 + L0 兜底，零阻塞。

### 6.1 部署（npm，node ≥ 22）

```bash
# 依赖带外部署（不进 dsh-travel 仓库树/依赖；参照 .test-env/tooling/）
mkdir -p .test-env/tooling && cd .test-env/tooling
npm install @playwright/mcp playwright
npx playwright install chromium   # 内核落 PLAYWRIGHT_BROWSERS_PATH 指定目录

# 伴随服务管理（start/stop/status/restart；幂等；照 .venv-12306 pid 模式）
.test-env/playwright-mcp.sh start
.test-env/playwright-mcp.sh status   # pid / 端口 / MCP initialize 往返 / 登录态挂载
```

- 端口默认 `8931`（Streamable HTTP，`/mcp`）；Host 校验只认 `localhost` 字面量
  （127.0.0.1 实测 403）；env `TRAVEL_PLAYWRIGHT_MCP_URL` 覆盖插件侧端点。
- `--headless --no-sandbox --isolated`；沙箱内 `~/.cache` 只读 → `XDG_CACHE_HOME`/
  `PLAYWRIGHT_BROWSERS_PATH` 都指进 `.test-env/`（脚本已处理）。

### 6.2 登录态（save-login，gated 交割）

- storageState 文件（Playwright 标准 cookies+origins）默认路径
  `.test-env/dsh-web-search-pro/login-state.json`（env `TRAVEL_LOGIN_STATE_FILE` 覆盖）；
  **存在即启动时自动 `--storage-state` 挂载**，不存在 = 无登录态启动（L1 走登录墙 →
  源级 degraded 降 L0 兜底，如实记账）。
- 交割方式一（有显示环境）：`cd .test-env/dsh-web-search-pro && node scripts/save-login.mjs
  all login-state.json`（@anweat/dsh-browser 自带 Playwright，逐平台扫码）。
- 交割方式二（无头服务器，实测本机采用）：用户本机浏览器登录四平台 → Cookie-Editor
  插件导出 → 组装 `{"cookies":[...],"origins":[]}`（每 cookie 至少 name/value/domain/path）
  → 落 login-state.json → `playwright-mcp.sh restart`。
- storageState 不入库（.gitignore）；多平台登录态可合并同一文件。

### 6.3 与 dsh-web-search-pro 的协同边界（W3a 探明）

- web-search-pro（测试环境 profile bundles 已装配）向宿主注册 ctx.web search/fetch
  provider：配置 `DSH_WEB_SEARCH_PROVIDER=web-search-pro`（或 web 行 searchProvider）
  后，dsh-travel 的 L0 宿主搜索 seam 自动经其多引擎路由——**配置驱动，零代码耦合**。
- 其 `web_platform_search` 平台定向是 LLM 工具面（router.platformSearch 未暴露 ctx
  服务），不可编程调用——dsh-travel 的 L1/L2 走本节 Playwright MCP 自有载体。

### 6.4 验证清单（W3b）

- `playwright-mcp.sh status` → running + health HTTP 200（MCP initialize 往返）。
- live smoke：`DSH_HOME=$PWD/.test-env/dsh-home TRAVEL_LIVE_SMOKE=1 npx vitest run
  tests/live-w3b-smoke.test.ts`（L2 抖音正文渲染 + 停 MCP 故障注入降级 + L1 登录态
  gated：storageState 缺席自动 skip 并明示）。
- 只读红线：工具面白名单六件（src/adapters/social-playwright.ts
  PLAYWRIGHT_READONLY_TOOLS），交互/写类一律不挂载（单测锁定）。

## 7. 滴滴 MCP（市内衔接渠道二）部署指南（✅ 2026-09-05 交割实测）

### 7.1 key 获取与配置

- **获取**：滴滴出行 App 扫码（mcp.didichuxing.com/claw）→ 取得 `DIDI_MCP_KEY`。
- **配置**：`$DSH_HOME/.credentials.yaml` 增行 `DIDI_MCPKEY: "<key>"`（合法标识符
  ref，无斜杠——dcd01e1 口径）；或 env `DIDI_MCP_KEY`。设置页 keys.didi 位亦可。
- **零明文**：key 只落凭证存储；代码/日志/证据零出现。

### 7.2 端点（实测形态，2026-09-05 交割）

- **MCP 端点（远程，无需本地桥）**：`https://mcp.didichuxing.com/mcp-servers?key=<DIDI_MCP_KEY>`
  （query key 鉴权，Streamable HTTP）。接入形态以 claw 页面「接入配置」JSON 为准。
- 插件侧经 env `TRAVEL_DIDI_MCP_URL` 覆盖缺省 `http://127.0.0.1:8124/mcp`：
  `TRAVEL_DIDI_MCP_URL="https://mcp.didichuxing.com/mcp-servers?key=<key>"`。
  URL 含 key——只经进程 env/凭证组装（live 脚本进程内拼接），不落盘不入库。
- 工具面 13 件（maps_direction_*×4 / maps_place_around / maps_regeocode /
  maps_textsearch + taxi_*×6）；适配器**只挂查询双件**（maps_direction_transit /
  taxi_estimate），交易类零挂载（readOnlyGate positive whitelist）。
- transit 的 city 参数须完整城市名（"杭州市" 非 "杭州"，适配器 ensureFullCityName
  已处理）；地名经前置地理编码链（amap→腾讯）转坐标，模型无感。

### 7.3 验证

```bash
DSH_HOME=$PWD/.test-env/dsh-home TRAVEL_LIVE_SMOKE=1 \
TRAVEL_DIDI_MCP_URL="https://mcp.didichuxing.com/mcp-servers?key=<key>" \
  npx vitest run tests/live-w5-smoke.test.ts
```

- T3 双出口：上游可用 → 双方案断言（滴滴·transit + 出租车估价 vs 高德对比）；
  滴滴服务态故障 → 真实调用失败 degraded 记账 + 高德单方案兜底（不伪造）。
- 已知服务态（2026-09-05 实测）：transit 后端偶发超时（滴滴侧），恢复后复跑即出
  双方案；适配器行为符合降级契约（w5/delivery.txt）。
