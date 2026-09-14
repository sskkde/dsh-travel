# 调研档案 · 携程问道与国内旅行平台数据获取（librarian 报告归档 + 编排者实测）

> 来源：librarian subagent 5d005de5（2026-08-31）。事实/推断/未确认已标注。
> **2026-08-31 编排者实测**：持真实 key 对官方 skill 端点做了 8 次调用验证（详见文末「实测记录」节；key 不入档）。

## 1) 携程问道

- **是什么**：携程 2023-07-17 发布的旅游行业垂直大模型（行前/行中/行后 AI 助手），训练数据=200 亿非结构化旅游数据+携程结构性实时数据；能力=模糊需求推荐（目的地/酒店/景点/行程）+ 明确需求复杂条件机酒查询。
- **开发者接入（事实，已探活）**：
  - API 端点 `https://externalcallback.ctrip.com`（HTTP 200）；**非 MCP 标准协议**，HTTP API 返回 JSON（`result` 字段为 Markdown 可展示内容）
  - 接入形态：Node.js v18+ CLI 脚本（`wendao_query.js`），环境变量 `WENDAO_API_KEY`
  - **有 QPS/配额限制**；无支付闭环（跳转携程 App）；返回可能含营销链接需过滤
  - Key 申请：`https://www.ctrip.com/wendao/openclaw`（HTTP 200，携程与 OpenClaw 的合作通道）
  - 来源：https://github.com/infometa/workbuddyskills （ctrip-wendao SKILL.md）、https://blog.csdn.net/ctrip_tech/article/details/161060695 、https://github.com/trips-ai/tripai-skill
- **官方 skill 端点（编排者补记，trips-ai/tripai-skill 官方仓库 README/SKILL.md 原文）**：
  `POST https://wendao-skill-prod.ctrip.com/skill/query`，`Content-Type: application/json`，payload `{"token": "<key>", "query": "<自然语言问句>", "source": "github"}`；key 同样走 openclaw 通道申请；官方宣称能力=酒店/机票/火车票/景点门票/一日游乐玩/演出展览。
- **定价**：未确认（公开渠道无价目表；推测合作制/Token 制）。
- **可行性评分 ~5/10**：数据质量 7（中文国内场景优于 Skyscanner/Amadeus）；接入 5（非标准 MCP、配额不透明）；交易 2（无闭环）。**定位：攻略/查询型数据源，非交易通道。**

## 2) 国内平台数据获取现实

| 平台 | 官方开放途径 | 现实 |
|---|---|---|
| 携程 | B2B 分销/开放平台（汽车票 API、酒店 PMS、逸龙分销） | 面向企业签约；C 端无公开 API，网页抓取有反爬 |
| 同程 | 开放平台 API（艺龙运营）；AI 侧有「程心大模型」（2025-02 接入 DeepSeek） | 程心对外开放接入方式未确认 |
| 大众点评 | open.dianping.com 已并入美团「北极星」→ developer.meituan.com/isv/daozong | 面向商户/ISV；C 端强反爬（动态字体加密） |
| 美团 | 美团技术服务合作中心 | 面向商家/合作方授权，非公共开放平台 |

**合规共性**：大平台官方数据开放均为商家/分销/合作路径；C 端抓取全部有反爬且有法律风险（爬虫刑事法律风险研究）。**美团/大众点评：除非商家/合作方身份，不建议碰。**

## 3) 机票/火车票可靠途径

- **纠错**：`ryoemu/12306-mcp` **不存在**（GitHub API 404，已证实）。
- **火车票主力**：① [Joooook/12306-mcp](https://github.com/Joooook/12306-mcp)（★1,224 MIT，`npx -y 12306-mcp` 即用，查询/过滤/过站/中转，2025-07 后未更新，作者标「仅用于学习」）；② [drfccv/mcp-server-12306](https://github.com/drfccv/mcp-server-12306)（更活跃：Python 3.10+，PyPI/Docker，MCP SDK v2，stdio+HTTP 双模式，余票/票价/3382+车站/换乘/经停/时间，协议自动协商）。均基于 12306 官方站点接口（非官方授权）。
- **合规红线**：12306 官方无开放数据 API；2026-04 国铁约谈 7 家第三方平台、禁自动化高频抢票；个人自动化抢票有刑事判例。**=> 只做查询展示，绝不做自动化购票/抢票。**
- **机票**：Skyscanner 官方 API 不对独立开发者开放（合作伙伴审批制）；Amadeus 有开发者免费档但国内航班数据由中航信 TravelSky 主导、国内段覆盖弱；RapidAPI 第三方代理（国际为主）；[RollingGo MCP](https://www.cnblogs.com/travelagetn/articles/20846332.html)（mcp.rollinggo.cn，机票/酒店、免费无配额，国内覆盖未确认）。

## 4) 推荐替代路线

1. 火车票 -> 本地部署 12306 MCP（drfccv 或 Joooook）**只读查询**
2. 机酒查询+交易闭环 -> RollingGo MCP（或携程 B2B 正式签约）
3. 中文攻略 -> 携程问道官方 API（openclaw 申请 Token）
4. 国际机票 -> Amadeus for Developers / RapidAPI 代理
5. 美团/大众点评数据 -> 不建议（无公开 API + 强反爬 + 法律风险）；以社媒内容（小红书/点评截图类游记）替代

## 5) 实测记录（2026-08-31，编排者持真实 key 验证；key 不入档）

**端点**：`POST https://wendao-skill-prod.ctrip.com/skill/query`，payload `{token, query, source:"github"}`。
**响应格式实测**：**纯 Markdown 文本**（非 workbuddyskills 文档所述 `{result:...}` JSON 包裹）；单次耗时 1~20s；8 次调用全部成功，鉴权通过。

| 能力 | 实测结果 | 质量 |
|---|---|---|
| 机票查询 | 5 个航班：航司/机型/起降时间/飞行时长/价格（¥350 起）+ m.ctrip.com 深链；"查看更多需登录" | ✅ 优（6s） |
| 火车票查询 | 按 极速直达/低价直达/夕发朝至 分组：车次/时刻/历时/票价（G25 ¥661、D11 ¥296 等）+ 开售状态提示（"目前所有车票都还未开售"） | ✅ 优（11s） |
| 酒店查询 | 具体酒店（名称/位置/评分/亮点/价格区间）+ 选区域建议 + 预订贴士 | ✅ 优（20s） |
| 景点门票 | 故宫旺/淡季门票价格 + 开放时间 + 周一闭馆提示 | ✅ 优（10s） |
| 美食推荐 | 必吃菜品 + 具体餐厅（新白鹿/外婆家/奎元馆等，含人均/招牌/排队提示） | ✅ 优（19s） |
| **行程规划** | **两种措辞均返回空壳**（"好的。已为您规划好此次行程。"，42 字节，1~2s，无任何内容） | ❌ 不可用 |
| 汽车票 | 咨询级：出发/到达车站、票价区间（60-70 元）、车程；远期日期无实时班次；明确声明"仅能提供信息建议，无法完成车票的预订操作" | ⚠️ 部分（12s） |
| 预订交易 | 多处置式声明无法预订（查询-only） | ❌（与档案结论一致） |

**对设计文档的回写结论**：①机票/火车/酒店/门票/美食为**实测可用的结构化查询源**（国内住宿由此补上结构化缺口）；②行程生成不可用（本插件设计本就由宿主 LLM 生成行程，无冲突）；③汽车票为咨询级（与 P1 降级定位相符，可作汽车票信息源）；④适配器须按纯 Markdown 解析（可从中提取 m.ctrip.com 深链作为 source.url）；⑤配额数值仍未知（连续 8 次调用无异常，未知上限）。
