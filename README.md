# dsh-travel

旅行规划插件（hybrid：node 工具 + client 设置页预留）。

一句话旅行需求 → 追问 ≤3 轮 → 调用方驱动的串行主链：研究 → 正文（可选）→ assessment → advice → resolve →（交通/报价旁车）→ build → render 可交互行程页（全条目溯源、降级透明）。旧版三 research 轻量查询仍保留；完整链路、build 后补 advice 恢复回路和工件迁移语义详见 `docs/round3-migration.md` 与 `skills/travel-planner/SKILL.md`。doc：`docs/`（requirements v1.5 / design v2.2 / roadmap v1.0）。

## 工程地基（W0）

- 包根 = 工作区根；`src/`（node 半 + client 半），`scripts/build.sh`（DSH_CHECKOUT 自动探测）
- 构建：`bash scripts/build.sh`（或 `dev_build_plugin`）；注入：`dev_inject_plugin`
- 验证：`npm run typecheck`（tsc --noEmit）· `npm test`（vitest run）· `dev_self_test`
- 部署说明：`docs/deploy.md`（含 12306 MCP HTTP 模式指南）

## 构建与注入

```bash
npm install
bash scripts/build.sh          # 或 dev_build_plugin <本目录>
# 注入器环境内：dev_inject_plugin <本目录> → dev_plugin_status 可见 dsh-travel
```

## W3 resolve 后交通与旁车研究（T11-T14）

> 完整规划的核心顺序为 `研究 → 正文（可选）→ assessment → advice → resolve → build → render`；本节的交通与报价属于 resolve 后、build 前的可选旁车，不把 advice 移到 resolve 后。

- 完整 plan（flowVersion 或已解析 places）下 `travel_research_transport` 首查当前 places.json——
  缺工件/版本过期/入口未解析 → 结构化 blocked+nextAction 且零网络；出发入口/枢纽衔接见 transport 回执 entry。
- `travel_route_transport` 按选中序列相邻地点逐段查询 route-transport.json（queried/estimated/unavailable/blocked 逐段独立）。
- `travel_research_advice` 属 assessment 后的主线阶段；若已有已解析地点则按 placeId/location 逐地归属天气（无逐地日期显式标注），不以西宁代表整条环线；完整 plan 无可用地点时返回 blocked+nextAction。
- `travel_research_destination phase='lodging-quotes'` 定向酒店报价（独立 lodging-quotes.json；不使 intel/places 失效）。
- `phase='rental-quotes'` 租车咨询报价（Wendao → 既有 Search/DDG fallback；独立 rental-quotes.json + cost.json；非实时、不可预订、缺金额不填假价）。
- DIDA 酒店只读报价渠道（`searchHotels/getHotelDetail/getHotelSearchTags` 三只读件，严禁价确/订单/支付）默认关闭
  （`channels.fr3.didaHotel=off` → 零调用），Key 独立 `DIDA_HOTEL_API_KEY`（settings keys.didaHotel）。**实时/免费价格为
  非已验证承诺**：报价仅为渠道快照，非最终确认价，一切以预订时官方确认为准。DIDA 不依赖滴滴服务；缺 Key/
  未装配 → blocked 零调用。**许可边界**：5A 混合上游许可未核实时仅自造 fixture，不导入/分发真实数据；OSM 遵守
  公共政策（User-Agent/缓存/≤1req/s）；真实快照显式导入数据目录，不随 npm 包分发。

## W5 研究质量与边界（T13-T23）

- 目的地 fan-out 在聚合前运行 L1 噪声门：默认 deny-list 为 `linkedin.com`、`naver.com`、`*.moe.edu`，并拦截强下载/注册/推广/Excel 转换标题信号；规则入口是 `src/orchestrator/fanout.ts` 导出的 `INTEL_NOISE_HOST_DENYLIST` 与 `filterIntelNoise(items, denylist)`，传入空列表即可撤回默认域名过滤。
- 噪声不会进入 `intel.json` 条目；`degraded[]` 按 `item.channel + reason` 聚合并带 `count`。普通旅游标题不命中强信号，单渠道失败仍不阻塞其他渠道。
- publishedAt 接受日期或 ISO timestamp，落库前统一为 `YYYY-MM-DD`；时效降权/过滤使用统一 UTC now，缺日期只降权不删除。

## W4 产品集成与分发（T15-T17）

- **skill**：`skills/travel-planner/SKILL.md` 主线改为调用方驱动串行链（见文件头）。「调用方」= 外部模型 /
  Agent / 用户本人，插件内部不新增模型、不启动自主研究 agent 循环；skill 文本与已实现工具参数同波。
- **新增工具注册（全部经 `makeKeyEnv(ctx)` 热读注入 settings/env）**：
  `travel_fetch_research_content`（SSR 内建提取，URL 安全门）· `travel_read_research_content`（分块读取）·
  `travel_record_research_assessment` · `travel_resolve_places`（amap→tencent 解析链）·
  `travel_route_transport`（高德→腾讯→直线估算三级 provider）· `travel_route_coverage`（纯派生）·
  `travel_research_destination phase='lodging-quotes'`（DIDA 默认关）。
- **DAG 代码门**：`src/tools/gates.ts` 共享门 helper（research/places 前置；缺工件/版本过期/失败元数据 →
  结构化 blocked+nextAction，调用前零网络；失败/零结果不复活旧数据）。
- **state 研究视图**：`travel_get_state` 返回 researchVersion/轮次/候选与正文索引分级（标题级/已取正文/
  部分正文/失败）/当前 assessment（含过期状态）/预算 used+remaining/失败与恢复动作；**不返回正文全文**
  （正文经 `travel_read_research_content` 分页）。
- **页面/导出正文分级**：行程页显示正文分级徽标、正文按文本渲染（HTML 转义，不可信资料不执行）；
  导出（JSON/Markdown）默认只含选定摘要、分析与引用，**不含整篇正文**（避免未授权再分发）；旧计划
  浏览/导出不强制重新研究。
- **打包**：Python 桥 `scripts/trafilatura-extract.py` 经 build.sh 随 `lib/scripts/` 交付（npm files 仅 lib；
  venv/.test-env/真实数据/evidence 不入包）；解释器缺失 → degraded 如实，主流程不中断。
- **桥 I/O 量纲**：Trafilatura 桥的 stdin/stdout/stderr 限值均为**字符（code units）**量纲而非
  字节——Python 侧按 str 字符计数（多字节 UTF-8 不劈字），宿主侧按解码后字符累计（stdout 上限 /
  stderr ~64K 字符）；字节级总量界由宿主解码层与 spawn 前拒绝超限输入兜底；输入分块累计在
  阈值判定后 append，返回体最多超出上限一个分块（有界近似，不作 O(n) 精裁）。