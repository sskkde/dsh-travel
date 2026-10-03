# 青甘大环线行程规划实测问题清单（2026-10-01 · 规划阶段）

> **触发**：用户指示「规划一次 10 月 5 日到 10 月 15 日的青甘大环线旅行计划」。
> **被测计划**：`plan-5010f93b-6ad9-4c8b-8dad-e06c950e46f8`（2026-10-05 ~ 10-15，11 天，西宁进出，1 名成人）。
> **规划链**：intake → research(2 轮) → 正文抓取/读取 → assessment → advice → resolve(5 轮) → 交通(城际 + 逐段) → build → render。
> **交付物**：行程页 <http://127.0.0.1:3080/travel-plans/plan-5010f93b-6ad9-4c8b-8dad-e06c950e46f8/>（HTTP 200）。
> **范围声明**：本文**只记录规划阶段**（`travel_*` 规划工具链）暴露的问题。
> 插件部署、行程页地图渲染（AMap CSP `'unsafe-eval'`）等**非规划阶段**问题，见
> `.agent-notes/notes/handoff-2026-10-01-map-csp.md`，不在本文范围。
> **记录纪律**：每条带「现象 / 证据 / 根因 / 修复方向或规避 / 验收口径」；并标注类别
> （**插件缺陷** / **外部降级** / **设计约束**）。

---

## 1. 优先级总表

| 优先级 | 编号 | 问题 | 阶段 | 类别 | 处理 |
|---|---|---|---|---|---|
| **P1** | P1-1 | 城际交通无法交付（缺 `origin` 门控 + 全渠道失败） | 交通 | 门控 + 外部降级 | blocked（如实标注） |
| **P1** | P1-2 | resolve 澄清 **5 轮**才收敛（21 地点） | 解析 | 设计约束 | 规避（一次性提交） |
| **P1** | P1-3 | 检索渠道大面积降级（tier3 / socialL1 / zhihu） | 检索 | 外部降级 | 如实记账 |
| **P1** | P1-4 | build draft 缺坐标时抛 `TypeError`（未结构化拦截） | build | 插件缺陷 | 规避（draft 带 placeId） |
| **P1** | P1-5 | `travel_get_state` 对已渲染计划抛崩 | 状态查询 | 插件缺陷 | 已修复并实测 |
| **P2** | P2-1 | 版本门控连锁：`expected*Version` 必须回传当前值 | 跨阶段 | 契约 | 规避（重取版本再调） |
| **P2** | P2-2 | assessment `findings[].status` 枚举不符（`supported` 非法） | assessment | 契约 | 规避（用合法枚举） |
| **P2** | P2-3 | 逐地天气全部标注「未分配逐地日期」+ amap 天气全空 | advice | 设计 / 外部降级 | 规避（传 placeDates） |
| **P2** | P2-4 | 动线校验告警：首日 A→B→A 折返 + 多日跨度超阈值 | build | 数据质量 | 人工核对回显 |
| **P2** | P2-5 | 归纳（insights）必须在 render 前调用 | 状态机 | 设计约束 | 规避（先 insights） |
| **P3** | P3-1 | 降级文案冗长（含外部 API 原文）进入页面 | 全链 | 体验 | 记录 |

---

## 2. P1 详述

### P1-1 城际交通无法交付（缺 `origin` 门控 + 全渠道失败）

**现象**
调用 `travel_research_transport` 查出发地→西宁的城际班次时，被结构化拒绝：
`槽位缺少 origin：请先 travel_intake 补齐`。本次未提供出发城市，故城际段（机票/火车票）
无法给出，最终卡在「需人工比价」。

**证据**
- intake 槽位仅 `destination=西宁`，无 `origin`；`travel_research_transport` 返回
  `Error: 槽位缺少 origin：请先 travel_intake 补齐`。
- 即便补 `origin`，本次城际渠道也多为降级态：`rail12306` MCP 未起、
  `wendao` 休眠、`flyai` 未装配（详见 §4 降级记录）。

**根因**
（a）**设计门控**：城际查询前置要求 `origin` 槽位，缺则零网络拒绝（正确行为，非缺陷）；
（b）**外部依赖**：城际三档（12306/wendao/flyai）均不可用 → 无候选可比。

**修复方向 / 规避**
- 规划启动时**先收集 `origin`**（与 destination/dates 同级必填）。
- 城际链路按 deploy.md 口径部署伴随服务（12306 MCP `:8123` 等）后复验。

**验收口径**
给出 `origin` 后 `travel_research_transport` 返回 ≥1 真实班次/票价档；全渠道失败时如实
标注「未核实」。

---

### P1-2 resolve 澄清 5 轮才收敛

**现象**
21 个地点经 **5 轮** `needs_clarification` 才到 `ready`。每轮最多回显 3 条待澄清，且
**澄清答案不跨调用持久化**——必须用 `candidateId` 键一次性把当前批次全部提交，否则下一轮
又从头出现。

**证据（5 轮待澄清批次）**
1. 德令哈市 / 察尔汗盐湖 / 格尔木市（解析地域与候选地域不一致）
2. 大柴旦翡翠湖 / 大柴旦镇 / 乌素特水上雅丹（同上，大柴旦行政委员会 vs 海西州大柴旦）
3. 黑独山（多区域：茫崖市 ×4 / 德令哈市）/ 敦煌莫高窟 / 祁连县
4. 德令哈市 / 察尔汗盐湖 / 格尔木市（上一轮同组再次出现——见根因）
5. `status=ready`

**根因**
- **设计约束**：澄清每轮 ≤3 条（先问必去点与关键冲突），且回答不持久化；
- **触发原因**：geocoder 回报的地域（含上级行政区全称，如「海西蒙古族藏族自治州德令哈市」）
  与候选 `regionHint`（简写「海西州」）字面不一致 → 判为 region 冲突 → 需澄清；
  多子 POI 场景（黑独山）→ 多区域候选 → 需 scope 选择。

**修复方向 / 规避**
- 调用方应**一轮内提交全部 3 个 `clarificationId`（或 `candidateId` 键）**，减少往返。
- 产品侧建议：地域一致性判定做「行政区包含关系」归一（全称 ⊇ 简写即视为一致），
  可显著减少澄清轮次（属插件改进项，非本次改动）。

**验收口径**
澄清提交后 `status` 收敛为 `ready`，`places` 全部带 `coordinate_source` 与
`resolveConfidence`。

---

### P1-3 检索渠道大面积降级

**现象**
两轮检索的降级面很宽，影响情报覆盖（尤其知乎正文与社媒）。

**证据（degraded 回执）**
- **r1**：`socialL1[UNAVAILABLE]（渠道未挂载）`；`web[NOISE]×17`；`zhihu[NOISE]×3`；
  `douyin[NOISE]×5`；小红书登录态检索失败自动降级（MCP `search_feeds` 返回
  `context deadline exceeded`）。
- **r2**：`tier3[EMPTY]` **三条 HTTP 402 `Insufficient Balance`**（DeepSeek 搜索端点）；
  `xhsFallback[EMPTY]`；`douyin[EMPTY]`；`platformIntel[EMPTY]`；`xhs-mcp[NOISE]×2`。

**根因**
- **外部**：DeepSeek 搜索账户余额不足（402）；Playwright 社媒渠道未装配；
  小红书 MCP 登录态检索超时。
- **质量过滤**：`NOISE`（`irrelevant:no_region_or_poi`）为地域相关性过滤，属正常剔除。

**修复方向 / 规避**
- tier3 需用户充值或改搜索端点（`DEEPSEEK_SEARCH_BASE_URL` / 设置页 Web search）。
- 社媒渠道按 deploy.md 装配后复验。

**验收口径**
`degraded[]` 逐条可解释；关键 FR 渠道（小红书/抖音）至少在抽样语义下有条目产出。

---

### P1-4 build draft 缺坐标时抛 `TypeError`

**现象**
提交含停靠点的 draft 时，若某 stop **缺 `coords` 且无 `placeId`**，工具抛
`Cannot read properties of undefined (reading 'lng')`，而非结构化 `blocked`。

**证据**
`Error: Cannot read properties of undefined (reading 'lng')`；源码定位
`src/tools/build-itinerary.ts`（坐标比较直接读 `.lng`，未先判空）。

**根因**
`resolveDraftPlace` / 坐标近似比较路径未对「无坐标且无 placeId」的 stop 做守卫，
直接解引用。

**修复方向 / 规避**
- **本次规避**：draft 的每个 stop 显式带 `placeId`（或与 places.json 可匹配的
  `name+coords`）。
- **插件改进**：返回结构化 `blocked + nextAction`（与既有门控一致），不抛裸异常。

**验收口径**
缺坐标 draft 返回 `built:false` + `blocked`，不抛 `TypeError`。

---

### P1-5 `travel_get_state` 对已渲染计划抛崩

**现象**
对已 `render` 过的计划查询进度，抛
`Unexpected token '<', "<!doctype " is not valid JSON`；渲染过的计划**再也查不到状态**
（恢复入口失效）。

**证据**
`listArtifacts()` 返回含 `page.html` → `readArtifactWithState()` 对**非 JSON 工件**无差别
调 `JSON.parse` → 解析 HTML 抛错。

**根因**
状态投影把「工件存在性」与「工件是 JSON」混为一谈，未区分非 JSON 工件。

**修复方向**
`src/store/store.ts` 新增 `isJsonArtifact()`；非 JSON 工件只判存在，返回
`unknown / non_json_artifact`，不做 `JSON.parse`。

**验收口径**
`tests/tools-state.test.ts` 新增用例；实测 `travel_get_state(plan-5010f93b…)` 返回完整状态。

---

## 3. P2 / P3 详述

### P2-1 版本门控连锁：`expected*Version` 必须回传当前值
- **现象**：多次遇到 `研究版本过期（expected=1，current=2）`、
  `places_stale（expected=1，current=6）`、研究正文抓取后使旧 assessment 失效。
- **根因**：**设计使然**——写类工具用乐观并发控制，调用方必须带「当前版本」。
- **规避**：每轮先读 `travel_get_state` / 上一步回执取当前 `researchVersion` /
  `placesVersion` 再调用；正文成功抓取会推进 `researchVersion`，需重提 assessment。

### P2-2 assessment `findings[].status` 枚举不符
- **现象**：首次提交 assessment 被拒：`findings[route-shape].status 非法：supported`。
- **根因**：合法枚举是 `confirmed | refuted | uncertain`；`supported` 不在其中。
- **规避**：用合法枚举重提。

### P2-3 逐地天气「未分配逐地日期」+ amap 天气全空
- **现象**：21 地点逐地天气全部标注「【未分配逐地日期】」；amap 天气 14 条 `EMPTY`，
  腾讯天气 `status=701 调用频率超限`，`adviceSearch` 不可用。
- **根因**：调用方未传 `placeDates`（逐地日期）→ 按旅行窗口查询并显式标注；
  天气主渠道配额/频控降级 → 走 Open-Meteo 兜底。
- **规避**：调用方按 `placeId` 传逐地日期；接受兜底并如实标注来源。

### P2-4 动线校验告警：首日折返 + 多日跨度超阈值
- **现象**：`routeCheck.issues` 报「第 1 天 A→B→A 跨城折返」「同日跨城往返·单日折返」；
  `warnings` 报第 2/3/4/5/6/7/9/11 天跨度超阈值（100km）。
- **根因**：首日「机场→塔尔寺→市区」在直线估算下构成折返；环线连日长跨度属常态告警。
- **处理**：**人工核对**并将告警回显给用户；非自动阻断（设计如此）。

### P2-5 归纳（insights）必须在 render 前调用
- **现象**：页面「归纳/成本」区块为空。
- **根因**：`delivered` 是终态，空 patch 不触发 `revising`，事后补归纳不可行。
- **规避**：**正确顺序 = insights → build → render**。

### P3-1 降级文案冗长入页面
- **现象**：页面降级区出现含外部 API 原文的长文案（如 DeepSeek 402 的端点配置提示全文）。
- **根因**：降级 `reason` 原样透出。
- **建议**：页面/工具回执对降级原因做短化 + 折叠详情（体验改进项）。

---

## 4. 本次规划降级记录（如实，逐渠道）

| 渠道 / 阶段 | 状态 | 说明 |
|---|---|---|
| web（宿主搜索） | 部分降级 | 有效条目若干；`NOISE` 17 条（`irrelevant:no_region_or_poi`） |
| tier3（DeepSeek 搜索） | **不可用** | HTTP 402 `Insufficient Balance`（需充值或改端点） |
| socialL1（Playwright 社媒） | 不可用 | 渠道未挂载 |
| xhs-mcp（小红书） | 部分成功 | r1 登录态检索超时降级；r2 产出 8 条；1 条 `token_unusable` |
| zhihu 正文抓取 | 部分失败 | 403 风控（3 条） |
| tieba 正文抓取 | 失败 | HTTP 403 |
| amap 天气 | 降级 | `EMPTY`（无预报数据）×14 → Open-Meteo 兜底 |
| weatherTencent | 降级 | `status=701` 调用频率超限 |
| amap 路线测距 | 部分熔断 | `CUQPS_HAS_EXCEEDED_THE_LIMIT`（2 段）→ 腾讯/直线估算 |
| tencent 距离矩阵 | 降级 | `status=120` 每秒请求量超上限 |
| 城际交通（12306/wendao/flyai） | 不可交付 | 缺 `origin` + 三档渠道均不可用 |

---

## 5. 方法论沉淀（可复用）

1. **带版本号调用**：所有写类工具用乐观并发控制，调用前先取当前版本，避免整轮白跑。
2. **澄清要批量提交**：resolve 澄清每轮 ≤3 且不持久化，一轮内用 `candidateId` 键全量提交。
3. **draft 必须落 `placeId`**：缺坐标且无 placeId 的 stop 会触发裸异常（P1-4）。
4. **顺序敏感**：insights **必须在 render 前**（delivered 终态不可回退）。
5. **降级要可解释**：`degraded[]` 每条能对应「渠道 + 码 + 原因」，全渠道失败不伪造产物。
6. **告警人工核对**：routeCheck 的折返/跨度告警是提示不是阻断，需向用户回显。

---

## 6. 待办（规划阶段改进项）

1. **[产品]** 地域一致性判定做行政区包含归一，减少 resolve 澄清轮次（P1-2）。
2. **[产品]** build draft 缺坐标改为结构化 `blocked`，不抛裸异常（P1-4）。
3. **[产品]** 降级原因短化 + 折叠详情（P3-1）。
4. **[流程]** 规划启动即收集 `origin`，城际链路先部署伴随服务（P1-1）。
5. **[外部]** tier3 搜索额度/端点、社媒渠道装配（P1-3）。
