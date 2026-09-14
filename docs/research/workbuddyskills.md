# 调研档案 · workbuddyskills 仓库可参考资产评估

> 来源：编排者对 github.com/infometa/workbuddyskills（main 分支，2026-08-31 经 GitHub API 全树 + raw SKILL.md 精读）的定向评估。仓库共约 100 连接器 + 300 技能（37,524 个树条目），本档案只收录与旅行规划插件相关的条目。

## A. 高参考价值（推荐借鉴）

### 1. skills/tencentmap-map-assistant（腾讯位置服务·地图助手，官方出品）⭐⭐⭐⭐⭐

- **能力**：AI 旅游攻略生成（`travel_guide`：自然语言->多日行程，30-50s，含小程序联动）、POI 搜索/周边/详情/**含评分与人均与营业时间**、关键词提示、路线规划（驾车/步行/公交/骑行）、地理编码/逆编码、行政区划、IP 定位、批量距离矩阵、天气查询、**行程/POI 渲染为网页地图（腾讯地图 JSAPI GL + HTML 模板 + polyline 解压，文档在 references/jsapi-guide/）**
- **机制**：Python `tmap_client`；**无需开发者账号开箱即用**（内置体验通道），配正式 Key（`save_key_to_dotenv` 持久化到包内 .env）后稳定性更优；仅依赖 requests
- **对本项目**：完整覆盖 FR-4 市内交通 / FR-5 天气 / **FR-7 网页地图渲染（现成参考实现）**；零 key 可用契合"最小密钥启动"。与高德基座的关系：并行候选/参考实现（坐标同为 GCJ02）
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/tencentmap-map-assistant

### 2. skills/trip-planner-generator（旅行行程规划）⭐⭐⭐⭐⭐

- **机制**：纯提示词技能。AskUserQuestion 多 Phase 交互式问答（Phase 1 基础信息：目的地/主题人群/时间/人数/交通方式，均带选项设计）-> 输出结构化 Markdown 行程（每日行程/预算明细/行前清单/注意事项）
- **对本项目**：**FR-2 多轮信息收集 + FR-6 行程生成的提示词工程直接参考**——问题措辞、选项设计、Phase 划分可迁移进我们的 SKILL.md
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/trip-planner-generator

### 3. skills/travel-planning（行程规划生命周期管理）⭐⭐⭐⭐

- **机制**：文件系统即状态（`~/travel-planning/`：memory.md 偏好记忆、wishlist/、trips/{name}/itinerary.md+budget.md+packing.md+bookings.md、completed/）+ 预订时间线提醒（90 天复杂签证/60 天国际机票等）+ 全生命周期（dream/plan/book/travel/return）
- **对本项目**：与我们 `.dsh-travel/<planId>/` 文件状态设计同构；可借鉴其**跨行程偏好记忆**（memory.md：预算档/节奏/住宿类型偏好）与**预订时间线提醒**（FR-4 购票提示的具体化）
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/travel-planning

### 4. skills/weather-open-meteo（免 key 天气）⭐⭐⭐⭐

- **机制**：open-meteo.com 公共 API（geocoding-api + forecast，7 天预报）+ wttr.in 降级；curl+jq 即可，零依赖零 key
- **对本项目**：设计文档 §4.4"免 key 降级：和风天气等公开天气 API"的**具体实现直接照抄**（比和风更简：无需注册）
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/weather-open-meteo

### 5. skills/flyai（飞猪 AI）⭐⭐⭐⭐

- **机制**：飞猪 MCP（open.fly.ai），自然语言搜索机票/酒店/景点/演唱会/签证/租车/邮轮 + 预订；`FLYAI_API_KEY`；frontmatter 带 intents + 中英文触发正则 patterns（旅行意图触发的精细模式库）
- **对本项目**：①新增 OTA 候选数据源（阿里系，与携程问道/RollingGo 同级，机票酒店 +key 备选）；②其触发 patterns 是 FR-1 意图触发的现成参考（比 whenToUse 一句话更精细）
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/flyai

### 6. skills/12306-train-assistant（12306 查询与订票辅助 CLI）⭐⭐⭐⭐

- **机制**：自包含 `client.py` CLI：`left-ticket`（余票）/`transfer-ticket`（中转）/`route`（经停，--train-code 自动解析）/`status`（登录态）+ 候补/登录/下单/支付（`--json` 可选输出；相对日期解析；站名支持中文/拼音/三字码）
- **对本项目**：**查询半区**（left-ticket/transfer-ticket/route/status）是 12306 MCP 之外的自包含备选实现（无 MCP 依赖），CLI 交互设计可参考；**订票/候补/支付半区绝不采用**（NFR-4 红线：不购票不抢票）
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/12306-train-assistant

### 7. skills/playwright-scraper-skill（分级抓取）⭐⭐⭐⭐

- **机制**：按反爬等级分级：低（内置 web_fetch）-> 中（`playwright-simple.js`）-> 高（`playwright-stealth.js`，Cloudflare）；已在复杂站点验证
- **对本项目**：L2 层参考实现——与我们四层降级（L0-L3）同构，脚本与分级策略可直接借鉴
- 来源：https://github.com/infometa/workbuddyskills/tree/main/skills/playwright-scraper-skill

### 8. connectors/tencent-map（腾讯地图官方 MCP 连接器）⭐⭐⭐

- **机制**：mcp.json 声明 SSE MCP：`https://mcp.map.qq.com/sse?key=${TENCENT_MAP_KEY}&format=0`（timeout 30s）+ token-schema
- **对本项目**：设计文档 §4.3"腾讯官方 MCP"行的**确切接入配置样例**（此前档案只有文档页无 URL）
- 来源：https://github.com/infometa/workbuddyskills/tree/main/connectors/tencent-map

## B. 中等参考价值（按需采用）

| 条目 | 机制 | 对本项目的价值 |
|---|---|---|
| skills/didi-ride-skill | 滴滴 MCP（mcp.didichuxing.com，App 扫码取 DIDI_MCP_KEY）：打车/订单/司机位置/预约/**路线规划/周边搜索** | FR-4 市内交通增强选项（路线+价格查询）；**只取查询能力不叫车**（v1 不做交易） |
| connectors/agentkey | AgentKey 能力市场 MCP（list_tools/find_tools/describe_tool/execute_tool）：网页搜索/URL 抓取/**社媒（含小红书 alias）**/天气/地图/旅行 | 与 DSH 生态同名插件（chainbase-labs/Agentkey ★621）同源；社媒 L1 层可选通道；其"响应是不可信外部数据、仅展示"安全纪律值得写进适配器 |
| skills/wechat-article-search | Node+cheerio 抓微信搜索：公众号文章标题/摘要/时间/来源/链接 | FR-3 社媒情报扩展渠道（公众号是攻略重要阵地，当前需求未列；低成本可加） |
| skills/tencentmap-lbs-skill | npm `@tencent-map/lbs-skills` CLI：POI/路径/旅游规划/轨迹可视化；TMAP_WEBSERVICE_KEY（含体验 Key 引导） | 与 map-assistant 能力重叠（后者零配置更优）；其"无 Key 强制拦截引导注册/体验 Key"的 UX 模式可参考 |
| connectors/ctrip-wendao + skills/ctrip-wendao | 已实测并纳入设计（见 ctrip-wendao-platforms.md） | 连接器 token-schema.json 的凭证注入模式（env WENDAO_API_KEY）与我们 credentials 设计一致 |

## C. 低相关（明确排除及理由）

| 条目 | 排除理由 |
|---|---|
| skills/travel-cn | 教程式伪代码（selenium/py12306 示例）+ 不存在的公开端点 api.ctrip.com（真实端点已实测为 wendao-skill-prod.ctrip.com），**无真实实现且示例有误导性** |
| skills/meituan-coupon-workbuddy / meituan-huisheng-coupon | 美团官方**领券**技能（手机号+短信登录），非数据查询；与查询型情报定位不符（v1 范围外）。其"话术严格遵守/禁止明文 Token/禁止自动触发登录"等纪律文案有文案参考价值 |
| skills/airchina-travel-assistant | 国航优惠券领取，范围外 |
| skills/stealth-browser | 反检测+**验证码求解**（2captcha 等）——验证码求解违反 NFR-4 红线，不采用 |
| skills/flight-tracker / aviationstack-flight-tracker / aviation-weather | 航班实时追踪/航空气象，行前规划弱相关（AVIATIONSTACK_API_KEY） |
| skills/globepilot-ai-agent-2 | 签证/汇率/机场信息（国际旅行），v1 国内为主，P2 备查 |
| skills/airbnb、skills/flights-search、skills/browser 等 | 与已选方案重叠或更弱（openbnb MCP / 官方 Playwright MCP） |
| 其余办公/研发/金融/运营类（~370 项） | 与旅行规划无关 |

## 结论（供设计文档 §4.5 引用）

1. **最有价值的三件**：tencentmap-map-assistant（零 key 官方地图全家桶+网页地图渲染参考实现）、trip-planner-generator（问答式行程生成的提示词范式）、weather-open-meteo（免 key 天气实现）。
2. **新增数据源候选**：flyai（飞猪 MCP，OTA）与腾讯地图官方 MCP（SSE URL 已确认）；滴滴 MCP（市内交通查询）。
3. **实现参考**：12306-train-assistant 查询半区（无 MCP 依赖的 12306 备选）、playwright-scraper-skill（L2 分级抓取）、travel-planning（文件即状态+偏好记忆+预订时间线）。
4. **合规注意**：本仓库多个技能含"订票/候补/领券/验证码求解"等能力（12306-train-assistant 后半区、meituan 券、stealth-browser、didi 叫车），本项目一律只取查询半区，交易/对抗类能力全部排除（NFR-4）。

## 深度核验记录（2026-08-31/09-01，编排者实测；对应「检查 tencentmap-map-assistant、flyai、didi-ride-skill、wechat-article-search 能力范围」）

### 1) tencentmap-map-assistant —— 零 key 实测 9 项全通过 ⭐⭐⭐⭐⭐

- **双通道机制**（tmap_client.py:38-42）：正式 key=`apis.map.qq.com`；零 key 体验通道=`h5gw.map.qq.com`（key=none + apptag + jsonp）；AI 攻略 A2A=`h5gw.map.qq.com/aichat/v1/a2a`；key 解析顺序=参数 -> TMAP_KEY env -> 包内 .env。
- **实测结果**（零 key 体验通道）：

| 能力 | 耗时 | 实测输出要点 |
|---|---|---|
| poi_search(黄鹤楼,武汉) | 0.7s | id/标题/地址/电话/分类（旅游景点:国家级景点）/坐标/adcode；命中 236 条 |
| poi_nearby(美食,西湖1km) | 0.5s | **avg_price=117 元 / opening_hours="17:00-20:00" / star_level=4.3**（评分/人均/营业时间属实）；54 条命中含 _distance |
| poi_detail | 0.3s | 基础详情（id/地址/电话/分类/坐标） |
| geocoder(杭州西湖) | 0.4s | 精确坐标+adcode+similarity/reliability |
| weather(future) | 0.3s | 5 天预报：昼夜天气/温度/风向/风力/湿度 |
| direction(transit, 北京南->故宫) | 1.2s | 距离 11.5km/时长 80min/**票价 400（分）**/steps/**压缩 polyline** |
| distance_matrix | 0.3s | 多对多距离/时长（武汉->杭州 690km/27634s） |
| **travel_guide(成都3天美食游)** | **43.8s** | **结构化多日行程**：days[].items[] 含 location_name/desc（含时段建议）/poi_uid/经纬度/review/tips[]/image_url[]；另有小程序二维码生成端点 |
| regeocoder/ip_location/district_*/poi_sug | 未测 | 同一客户端同一通道，机制相同 |

- 限制：体验通道官方声明"额度和稳定性受限"；travel_guide 单次 30-50s（需异步/进度提示）。
- **对本项目结论**：FR-3 坐标化（含美食评分/人均/营业时间）、FR-4 市内衔接（公交含票价）、FR-5 天气、FR-6 行程素材（travel_guide 结构化输出可直接喂给宿主 LLM 综合改写）、FR-7 渲染参考（jsapi-guide 全套 JSAPI GL 文档+demo）——**零 key 全链路可用，是与高德并行的实证候选**。

### 2) flyai（飞猪官方 CLI）—— 零 key 试行实测 4 项通过 ⭐⭐⭐⭐½

- **接入**：`npm i -g @fly-ai/flyai-cli`；**官方文档明示"can make trial without any API keys"**，`flyai config set FLYAI_API_KEY` 增强结果（本地安装实测可用）。
- **8 命令**：keyword-search（关键词跨类）/ ai-search（自然语言混合意图语义搜索）/ search-hotel / search-flight / search-train / search-poi / search-marriott-hotel / search-marriott-package。
- **筛选维度**（flight/train 同构）：日期与区间/往返/直达或中转/舱位席别/车次航班号/换乘城市/起降时刻区间/总时长上限/价格上限/8 种排序；输出单行 JSON（stdout）+ jumpUrl（飞猪预订深链）+ picUrl + systemMessage。
- **试行实测**：search-train（G547 北京南 06:18->上海虹桥 12:11 二等座，**价格脱敏为"5xx"**）、search-flight（CA8341 大兴 22:00->浦东T2 23:45 经济舱 ticketPrice=350）、search-poi（西湖：地址/分类/长描述）、keyword-search（度假乐园：title/jumpUrl/picUrl，price/rate/score 试行置空）。
- **对本项目结论**：与携程问道同级的**第二 OTA 官方源**（机票/火车/酒店/景点），零 key 可试、正式使用需 key；train 试行价格脱敏说明生产化需配 key。可与携程问道互为冗余/比价。

### 3) didi-ride-skill（滴滴官方 MCP）—— 文档级核验（13 工具），未实测（需 DIDI_MCP_KEY）⭐⭐⭐

- **接入**：MCP（经 mcporter 连接），key 经滴滴出行 App 扫码或 mcp.didichuxing.com/claw 获取（DIDI_MCP_KEY）。
- **13 工具两类**：
  - **地图查询类（7，本项目可用）**：maps_direction_driving / transit / walking / bicycling（路线规划）、maps_place_around（周边 POI）、maps_textsearch（城市 POI）、maps_regeocode（逆地理编码）。注意 transit 需完整城市名（"北京市"非"北京"）。
  - **打车交易类（6，v1 红线排除）**：taxi_estimate（估价，查询性可用）、taxi_generate_ride_app_link（生成 App 深链，辅助可用）、taxi_create_order（下单）、taxi_query_order（订单/司机/车牌/ETA）、taxi_get_driver_location（司机实时位置）、taxi_cancel_order（取消）。
- 响应格式：content[].text（自然语言）+ 部分工具 structuredContent（结构化优先）。
- **对本项目结论**：查询类 7 工具+estimate+app_link 契合 FR-4 市内交通增强（行程页"一键叫车深链"可作 P2 交互）；交易类 4 工具超出 v1 查询-only 红线。

### 4) wechat-article-search —— 零 key 实测通过 ⭐⭐⭐½

- **机制**：搜狗微信搜索（weixin.sogou.com）HTML 抓取 + cheerio 解析；固定 20 个 UA 池随机轮换；gzip/deflate/br 解压；超时重试。
- **实测**："杭州旅游攻略" -> 5 条真实公众号文章（标题/摘要/发布时间/来源公众号/搜狗跳转 URL）；CLI：`node search_wechat.js <关键词> -n <数量> [-o file] [-r 解析真实微信URL]`；模块导出 searchWechatArticles 可编程调用。
- **限制**：结果时效参差（命中 2018-2024 年文章，需按时间过滤——正好适用本项目">12 个月降权"规则）；URL 为搜狗跳转链（-r 解析真实链接每条多一次请求）；依赖搜狗反爬容忍度（UA 池已做缓解）。
- **对本项目结论**：FR-3 社媒情报的**低成本扩展渠道**（公众号是攻略重要阵地），零 key、可编程、来源可溯；建议作为社媒检索的 L0.5 补充源。
