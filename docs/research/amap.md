# 调研档案 · 高德地图开放平台（librarian 报告归档）

> 来源：librarian subagent 537489a7（2026-08-31）。事实=官方文档原文；推断已标注。

## 1) 官方 MCP 服务（mcp.amap.com）

- **接入**：`https://mcp.amap.com/mcp?key=<key>`，**Streamable HTTP**（官方推荐）或 Node.js I/O（`npx -y @amap/amap-maps-mcp-server` + `AMAP_MAPS_API_KEY`）；SSE 通用协议已于 2026-03-17 下线。
- **Key**：复用高德开放平台 **Web 服务** key（服务平台选「Web 服务」），MCP 不另设 key 类型。
- **工具清单（16 项）**：地理编码、逆地理编码、IP 定位、天气查询、骑行/步行/驾车/公交路径规划、距离测量、关键词搜索（POI）、周边搜索、详情搜索、生成专属地图（personal_map，高德 APP 唤端联动）、导航、打车。
- **配额**：未确认（官方未单独公布 MCP 配额页）；推断走 Web 服务 API 月配额。
- 来源：https://developer.amap.com/api/mcp-server/gettingstarted ｜ /api/mcp-server/summary ｜ /api/mcp-server/create-project-and-key ｜ /api/mcp-server/changelog

## 2) Web 服务 API 与官方 CLI

- **Web 服务 API**：地理/逆地理、路径规划、POI 搜索、天气、行政区划、静态地图等，2025-05-20 起**月配额制**。
- **官方 CLI 存在**：`npm install -g @amap-lbs/amap-gui`（高德开放平台 CLI）＝ **SKILL 技能包 + CLI 指令集 + GUI 可视化容器**，专为 AI Agent 设计（自然语言 -> Agent -> CLI -> 地图容器实时图面 -> 状态返回）。需 **Web 端（JS API）key + 安全密钥**（`AMAP_KEY` / `AMAP_SECURITY_KEY`）。核心命令：`amap-gui start/stop/status/getLastEvent`、`mapState`（center/zoom/rotation/pitch/style）、`route`（driving|walking|riding|transit，含 waypoints/policy）、`searchPOI`（keyword/city/center/radius）。SKILL 包下载：ClawHub/高德镜像。
- 来源：https://developer.amap.com/api/cli/map-cli/summary ｜ /api/cli/map-cli/reference ｜ https://www.npmjs.com/package/@amap-lbs/amap-gui
- 社区第三方高德 CLI：未确认存在有影响力的工具。

## 3) Web 端 JS API（HTML 嵌地图，本插件行程页关键）

- **Key 类型（关键区别）**：浏览器端地图需 **「Web 端 (JSAPI)」key + 安全密钥 jscode**（2021-12 后新 key 必配安全密钥；2.0 可 `securityJsCode` 或代理转发，官方建议服务端代理）；加载 `https://webapi.amap.com/maps?v=2.0&key=<key>`。**Web 服务 key 只能服务端 RESTful 调用，不能初始化浏览器端地图**；Web 端 key 可配域名白名单。
- **功能**：markers（含海量点/自定义）、polyline、InfoWindow、路线规划、POI 搜索均有官方 API。
- **月配额（2025-05-20 起，API/JS/端共享）**：
  | 类别 | 个人 | 企业 | 超限价 |
  |---|---|---|---|
  | 基础 LBS（路径/编码/静态图等） | 15 万/月 | 300 万/月 | 30 元/万次 |
  | **JS 地图图面初始化** | 150 万/月 | 3000 万/月 | 3 元/万次 |
  | **基础搜索（POI 关键词/周边等）** | **5,000/月（紧）** | 50,000/月 | 30 元/万次 |
  免费月配额自认证起 1 年有效；阶梯折扣。
- **离线/内网**：官方无纯离线方案（脚本+瓦片均走高德 CDN）；内网需自行缓存/镜像（第三方做法，非官方，批量抓瓦片有封禁风险）。
- 来源：https://developer.amap.com/api/javascript-api-v2/guide/abc/jscode ｜ https://developer.amap.com/upgrade ｜ https://lbs.amap.com/news/service_amap

## 4) 竞品对比

| 方案 | 费用 | 备注 |
|---|---|---|
| 高德 JS API 2.0 | 月配额制（见上） | 国内 POI/路线数据强；搜索配额紧 |
| 百度 JS API Lite | 官方称免费无次数限制（需 ak） | 商业使用需按使用须知评估 |
| 腾讯位置服务 | 默认 1 万次/日/接口 + 5QPS | 可申请提额（审核 3 工作日） |
| Leaflet + OSM | 免 key 免注册 | OSMF 瓦片无 SLA、禁批量抓取、须 attribution；无 POI/路数数据 |

## 5) 选型结论（librarian 推断）

- 有外网+要 POI/路线/天气 -> **高德 JS API 2.0**（注意搜索配额 5000/月，POI 查询放服务端 Web 服务 key 合并配额更优）。
- 纯可视化/离线 -> Leaflet + 自托管瓦片。
- AI Agent 场景 -> **官方 MCP（数据/规划）+ 官方 CLI amap-gui（交互地图容器）** 是高德 2026 官方标准组合。

## 未确认项

MCP 专用计费/配额页；官方纯离线 JS API 方案；有影响力的社区高德 CLI。
