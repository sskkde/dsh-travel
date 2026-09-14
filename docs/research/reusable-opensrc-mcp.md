# 调研档案 · 可复用开源实现（GitHub 项目 + MCP 服务）（librarian 报告归档）

> 来源：librarian subagent e0aeb753（2026-08-31，star/时间经 GitHub API 核实，UTC 2026-08-31；★=约数）。

## 一、GitHub LLM 旅行规划项目

**结论：无高星（≥100★）完整旅行规划应用；价值在于编排模式与地图可视化路径的验证。**

| 项目 | ★ | License | 要点 |
|---|---|---|---|
| [OSU-NLP-Group/TravelPlanner](https://github.com/OSU-NLP-Group/TravelPlanner) | 542 | MIT | ICML'24 Spotlight **基准**（1,225 真实规划任务+评测工具链），可作本插件评测集，活跃 |
| [arpan65/TripAI-Multi-Agent-AI-Travel-Planner](https://github.com/arpan65/TripAI-Multi-Agent-AI-Travel-Planner) | 6 | 无 | 4 阶段串行 agent 管线（Planner→Pricer→Budget→Aggregator，Claude Haiku）；Pricer 用 **Playwright MCP** 抓实时价格（browser_navigate+browser_evaluate）；SSE+React 前端。编排+工具注入模式直接可抄 |
| [Yangjon1/trip_agent](https://github.com/Yangjon1/trip_agent) | 1 | 无 | **中文、高相关**：LangGraph 5 步多智能体（景点→天气→酒店→餐饮→生成）+ **高德地图 MCP**（maps_text_search/maps_weather）+ **高德 JS API 2.0 可视化**（按天分色标记、html2canvas+jsPDF 导出）；Vue3+AntD。**地图可视化路径已完整验证** |
| [HarimxChoi/langgraph-travel-agent](https://github.com/HarimxChoi/langgraph-travel-agent) | 18 | MIT | LangGraph 多 agent 异步并行，Amadeus/Hotelbeds 集成 |
| [GongRzhe/TRAVEL-PLANNER-MCP-Server](https://github.com/GongRzhe/TRAVEL-PLANNER-MCP-Server) | 99 | MIT | Google Maps 位置/详情/路线，**已 archived**（勿作依赖基底） |
| mengwaichan/TravelGPT（★4 MIT，2024-04 停更）、pavanbelagatti/Agentic-AI-Travel-Agent（★10）等 | ≤10 | - | 参考价值有限 |

TripoAI 拼写未找到精确匹配仓库（未确认）。

## 二、MCP 服务（按本插件需求分类）

### 地图类
| 服务 | 状态 | Key/费用 |
|---|---|---|
| **高德官方 MCP Server** | 存在（官方文档 lbs.amap.com/api/mcp-server/summary，2026-03 更新） | 需高德 Web 服务 Key，免费额度未核实 |
| 腾讯位置服务官方 MCP | 存在（lbs.qq.com + CloudBase 模板 cloudrun-mcp-tencent-map） | 需腾讯位置 Key |
| 百度官方 baidu-maps/mcp（★439 MIT） | 官方 org，10 个 API，最后推送 2025-08 偏冷 | 需百度 Key |
| Google Maps 官方 MCP 工具包 | 官方文档 developers.google.cn/maps/ai/mcp | 需 GCP key/账单 |
| 社区 amap MCP（sugarforever/zxypro1 等多个） | 活跃度低 | 均需 amap Key |
| wiseman/osm-mcp 等 | OSM 免 key | - |

### 网页抓取类
| 服务 | 状态 | Key/费用 |
|---|---|---|
| **microsoft/playwright-mcp** ★36,650 Apache-2.0 | 官方、活跃、本地无头浏览器 | **免 Key**；TripAI 已验证抓价主力 |
| Firecrawl ★174,622 **AGPL-3.0** | 官方、活跃、官方 MCP 文档 | 需 Key（付费）；**强 copyleft，嵌入插件须谨慎** |
| Jina Reader（jina-ai/MCP ★834 Apache-2.0） | 官方 | Reader API 需 Key（免费额度有限） |
| Browserbase | npm @browserbasehq/mcp | 云托管浏览器，需 Key 付费；官方 GitHub 仓库未定位（未确认） |

### 搜索类
| 服务 | 状态 | Key/费用 |
|---|---|---|
| Tavily（tavily-ai/tavily-mcp ★2,363 MIT） | 官方活跃 | 需 Key |
| Brave（brave/brave-search-mcp-server ★1,409 MIT） | 官方活跃 | 需 Key |
| 博查 Bocha（BochaAI/bocha-search-mcp ★177） | 国内中文搜索 | 需博查 Key |
| 免 Key 备选 | mcp-duckduckgo / ddg_search / searxng-mcp（自托管） | - |

### 旅行数据类
| 服务 | 状态 | Key/费用 |
|---|---|---|
| **Joooook/12306-mcp** ★1,224 MIT | 活跃（2026-07），逆向公开接口 | **免 Key**；有反爬风控风险（推断） |
| drfccv/mcp-server-12306 ★374 MIT | 活跃（2026-08） | 同上 |
| Amadeus | 官方 MCP 文档存在（docs.amadeus-discover.com）+ 社区 donghyun-chae/mcp-amadeus ★58 MIT | self-service Key 有免费测试 tier（额度未核实）；**国际行程为主** |
| Skyscanner | 无官方 MCP（未确认）；社区 mcp-skyscanner ★13 自述实验性 | - |
| Booking.com | 无官方 API/MCP（未确认） | - |
| openbnb-org/mcp-server-airbnb ★518 MIT | 活跃，尊重 robots.txt | **免 Key**（住宿） |
| Google Flights MCP | 非官方，opspawn 版已 404，salamentic 版 2025-03 停更 | - |
| 托管免鉴权 | MAQAMI Travel（mcp.maqami.co）、Gondola（mcp.gondola.ai） | 免 Key |

## 三、清单资源

- [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) ★93,555 MIT（最权威）
- [TensorBlock/awesome-mcp-servers](https://github.com/TensorBlock/awesome-mcp-servers) ★833 MIT（结构化版）：docs/travel--transportation.md、docs/location--maps.md、docs/browser-automation--web-scraping.md、docs/search.md 可直接引用

## 四、对本插件的借鉴要点（librarian 推断）

1. 编排：TripAI 串行多阶段管线+MCP 工具注入 与 DSH agent 框架天然契合；Yangjon1 五步并行贴合 daemon-loop 形态。
2. 地图可视化：后端出结构化行程 JSON（POI+经纬度），前端用高德 JS API 2.0 按天分色--已验证组合路径。
3. 数据源组合建议：高德/腾讯官方 MCP（中文 POI/路线）+ Joooook/12306-mcp（火车）+ Bocha/Tavily/Brave（搜索）+ Playwright MCP（兜底抓取）+ openbnb/Airbnb（住宿免 Key）。
4. License：Firecrawl AGPL-3.0 慎嵌入；Playwright/Tavily/Brave/百度 MCP 等官方为宽松许可证。

## 未确认项

TripoAI 精确仓库；各 API 免费额度数值；高德/腾讯/百度官方 MCP 的 Key 申请与配额细节；Skyscanner/Booking 官方 API 现状；Browserbase 官方 GitHub 仓库。
