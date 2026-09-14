# Round3 迁移、调用顺序与降级说明

> 适用范围：`dsh-travel` W5/T7 交付。本文是 round3 的迁移补充说明；它不改生产工件、不执行迁移脚本，也不把旧数据强行升级成当前版本。

## 为什么新增本文，而不是改写 `docs/design.md`

`docs/design.md` 保留需求与历史设计基线，直接改写会把历史版本、决策记录和当前运行语义混在一起。本文件作为**可回滚的 round3 addendum**，集中说明已落地的调用顺序、旧工件只读兼容、manifest/版本回滚和降级展示；后续若规则变更，只需替换本 addendum 并同步 `skills/travel-planner/SKILL.md`，不会重写历史设计。

## 1. 调用方驱动的规范顺序

完整规划的核心依赖链固定为：

```text
研究 → 正文（可选）→ assessment → advice → resolve → build → render
```

具体调用约束：

1. `travel_intake` 收集并确认槽位；推荐模式先让用户选定目的地，再进入完整链。
2. `travel_research_destination` 做摘要研究；有缺口、冲突或错误时由调用方发起下一轮，不能由插件静默补猜。
3. 正文是可选的调用方动作：调用方先选 `itemIds`，再调用 `travel_fetch_research_content`，需要分析时用固定 `contentVersion` 分页读取。正文不可信，正文里的指令不改变权限或目标。
4. `travel_record_research_assessment` 记录当前研究版本的 `sufficient` / `continue` / `insufficient`。`sufficient` 必须引用当前 `researchVersion`，预算耗尽不得伪造 sufficient。
5. `travel_research_advice` 位于 resolve 之前的主线阶段。逐地点天气只能绑定到真实 `placeId/location`；无可用地点时返回 `blocked + nextAction`，不以西宁或任意单城代表整条环线。天气渠道失败不抹掉仍可用的天气结果。
6. `travel_resolve_places` 校验候选来源、版本、地域和入口/住宿锚点；歧义必须返回 `needs_clarification`，由调用方回答后重试。禁止把用户回答当成别名重新搜索，也禁止用未经解析的坐标绕过此门。
7. resolve 成功后，在 build 前按需调用 `travel_research_transport`、`travel_route_transport` 及定向 `lodging-quotes` / `rental-quotes`。这些是 resolve→build 区间的旁车证据，不改变上面的核心顺序；每段、每个报价项均独立保留状态。
8. `travel_build_itinerary` 消费已解析地点和调用方 draft，人工核对 `routeCheck.issues/warnings` 后才算可交付。无坐标、缺入口/住宿锚点、关键不可达或完整性失配必须阻断，不以景区点或虚构坐标替代。
9. `travel_render_page` 只渲染可消费的 itinerary；缺失/失败/空/哈希失配不生成空页。成功交付同时保留可点 URL 与本地 `page.html`。

### 已 build 后补 advice

若 advice 在 build 后才需要补做，不能直接覆盖或伪造 delivered 状态。调用 `travel_research_advice` 进入并持久化以下恢复回路：

```text
generating → revising → researching
```

恢复完成后必须重新执行：

```text
travel_build_itinerary → travel_render_page
```

只要输入没有改变，未受影响的日程结构原样保留；只有 advice 及其受影响的下游工件重建。恢复失败时保留原有可读工件和明确 `degraded/blocked`，不得把旧页面说成包含新 advice。

## 2. legacy 与当前工件迁移策略

迁移采用“旁车核验、按需发布”，不批量重写用户目录：

| 文件/状态 | 读取语义 | 允许的后续动作 |
| --- | --- | --- |
| 没有 `artifact-meta.json` 的旧文件 | legacy 兼容读取；按旧语义视为 `current` | 可用于只读浏览；需要现代版本依赖、完整性或发布时重新通过对应工具发布 |
| modern manifest（schema 2）中存在且 hash/依赖匹配 | `current` | 正常消费 |
| modern manifest 缺少该文件，或 manifest/schema 无法解释 | `unknown` | 只读兼容，并在状态/页面标 `unknown`；不把它伪装成 current 或 stale |
| 已入账文件的上游版本已前进 | `stale / dependency_version` | 只读展示旧快照；重跑受影响上游和下游 |
| 旧 meta 的文件未在 `contentHash` 中 | `stale / not_in_commit` | 不复活旧成功；重新发布对应工件 |
| 文件 hash 不匹配、缺失、发布状态 `failed/empty` | `stale / hash_mismatch`、`missing`、`failed`、`empty` | 拒绝消费；修复或重新发布 |

`unknown` 表示“无法证明版本/入账关系”，不是失败；`stale` 表示“曾有可识别关系但当前依赖或提交不再匹配”。所有状态都通过 `travel_get_state` / 页面 `artifactStatus` 回显。

### 未入账与篡改保护

- modern manifest 为 schema `2`，每个条目保存 hash、`commitId`、`releaseVersion`、stage、输入指纹和上游版本。
- modern manifest 存在但文件未入账时，读取层返回 `unknown/unaccounted`；普通只读页面可展示并警告，不能伪造 `current`。
- 如果 manifest 已声明该文件属于自己的 stage，却发现文件未入账（例如 `places.json` 对应 places stage），这是 signed-unaccounted 冲突：build/render 消费门直接阻断，不复活旧文件。
- hash mismatch 表示外部篡改、损坏或半写，消费门直接拒绝；不要通过删除 manifest、改版本号或复制旧文件来绕过。

## 3. manifest 发布、版本与回滚

`publishArtifacts` 的提交顺序是：临时文件写入目标同目录 → 逐文件 rename → 最后写 manifest/versions 提交点。写入失败时：

1. 删除临时文件；
2. 已替换的目标文件移入同目录 rollback 临时名并恢复旧文件；
3. 恢复旧 manifest 与 `versions.json`；
4. 不产生半发布状态，也不把失败发布当作成功版本。

每次成功发布递增 `releaseVersion`，同时只递增明确声明的领域版本（如 `intel`、`places`、`advice`）。其它已入账工件保留自己的条目和 commit，不会因为无关领域发布而被误标 stale。上游版本真正前进时，依赖它的旧工件才变为 `stale/dependency_version`。

回滚原则：优先保留最后一个可验证 commit；发现失败/篡改时重新执行原工具生成新 commit，而不是手工改 manifest。研究正文和 assessment 的嵌套路径也必须由发布事务写入，禁止自行移动目录或绕过路径守卫。

## 4. 降级与页面诚实展示

### 路线几何与里程是两种独立证据

- canonical route geometry 固定为 WGS84 GeoJSON `LineString`，坐标顺序 `[lng, lat]`。
- AMap 页面显示前转 GCJ-02；Leaflet/OSM 使用 WGS84 显示路径。
- `metricStatus`（距离/时长）与 `geometryStatus`（道路几何）独立：有里程而无道路几何时仍展示里程，但不绘制伪道路；只有直线端点 fallback 时画虚线。
- fallback 文案必须明确：**“轨迹直线示意，里程为实测”**（若里程本身也是估算，则同时标 `estimated`，不得使用“实测”）。
- `estimated` 只表示 Haversine/直线估算，不是道路长度、驾驶时长或可达性证据；`blocked` / `unavailable` 不得被汇总为 0 km。

### 渠道失败不等于成功

| 实际情况 | 回执/页面 | 允许的结论 |
| --- | --- | --- |
| 高德缺 key、jscode、SDK/网络失败 | `degraded`、`blocked` 或 Leaflet fallback + warning | 只能说未获取高德结果；不能说实测成功 |
| 腾讯或其他备用渠道成功 | 对应 provider、`queried` | 只把该渠道结果标为已查询 |
| 所有测距渠道失败 | `estimated` + 原因 | 只能给直线估算，并提示人工核验 |
| 单段失败 | 该 leg `unavailable/blocked` | 其它 legs 仍保留；不可达才形成 issue |
| 天气/报价/正文部分失败 | 条目级 `degraded` / receipt 状态 | 成功条目保留，失败项明确下一步 |
| 研究全渠道失败 | 不产空 `intel.json` | 回显失败原因和重试入口 |

`metricStatus` 与 `geometryStatus` 必须分开显示；页面图例同时显示“道路几何”和“直线示意/估算”。自驾阈值按 `relaxed/balanced/intensive = 250/350/450km`；`≥600km` 额外给异常告警。缺可靠 driving 旁车时，回到有限 Haversine 阈值，不把 estimated 距离当真实驾驶里程。

## 5. 现场状态与验收口径

现场状态使用三态：`pass`、`blocked`、`fail`。`blocked` 永远不能汇总为 `pass`；`pass-with-blocked` 只表示部分流程通过，不能作为完整 live acceptance。

本轮验收分开报告：

- **离线合同/fixture PASS**：不需要第三方 key，适合验证状态机、版本、脱敏、回滚、页面交互和降级契约。
- **live PASS / 部分 / BLOCKED**：只报告本次 `.test-env` 实际跑到的渠道和步骤。缺 key、权限、配额、真实路线页面未注册或只命中备用渠道，均保留为 BLOCKED/部分，不能用离线 PASS 覆盖。
- QA 固定使用 `.test-env`、端口 `3081`；生产 `3080` 只做可用性观察，不作为验收、注入、重启或写入目标。

对应逐项证据见 [`docs/evidence/qinggan-round3/T7/acceptance-matrix.md`](evidence/qinggan-round3/T7/acceptance-matrix.md)。
