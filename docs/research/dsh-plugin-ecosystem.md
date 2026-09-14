# 调研档案 · DSH 插件生态（编排者实测归档）

> 来源：编排者经 find_dsh_plugin 工具对 GitHub `dsh-plugin` topic 的实时检索（2026-08-31，按 star 排序；star 为工具返回的当时值）。此档案为 design.md §4.1 的证据基座。

## 检索一：travel planning / 旅行 / 规划

**无匹配插件**（旅行/地图类为生态空白区）。

## 检索二：web search

| 插件 | ★ | 描述（工具返回原文要点） | 安装 |
|---|---|---|---|
| Agentkey | 621 | Connect your AI agent to the world - Web search, Social media, Crypto & On-chain data. One plugin, zero extra config. | `dsh plugin --profile web add github:chainbase-labs/Agentkey` |
| anysearch-dsh | 383 | AnySearch-powered real-time web and vertical search provider for DeepSeek Harness. | `dsh plugin --profile web add github:anysearch-team/anysearch-dsh` |
| modsearch | 326 | Web search bridge for text-only agents: ask the web or X, get structured JSON evidence (search, fetch, citations). | `dsh plugin --profile web add github:liustack/modsearch` |
| dsh-free-search | 93 | Free, keyless web search for DSH: 7 engines (DuckDuckGo/Bing/SearXNG free + Exa/Perplexity/DeepSeek paid), auto-failover, settings-page UI, web_fetch, engine test tool. | `dsh plugin --profile web add github:DDDMUC/dsh-free-search` |
| **dsh-web-search-pro** | 58 | Persistent enhanced web search: multi-engine routing (DeepSeek/Exa/DDG/Bing/Jina + **GitHub/Bilibili/Xiaohongshu**/YouTube/V2EX/Twitter/Reddit/RSS), SQLite+LRU cache, userscript-style extraction, **Playwright rendering**. | `dsh plugin --profile web add github:anweat/dsh-web-search-pro` |
| dsh-web-tools | 23 | Unified multi-provider web search and fetch: BYOK key pools, health monitoring, deterministic fallback. | `dsh plugin --profile web add github:A3Boy/dsh-web-tools` |
| dsh-web-search-exa | 6 | Zero-config Exa web search provider for the ctx.web seam. | `dsh plugin --profile web add github:TonyDua/dsh-web-search-exa` |
| dsh-web-search-brave | 5 | Brave Search-backed WebSearchProvider for DeepSeek Harness (ctx.web). | `dsh plugin --profile web add github:cnChenKai/dsh-web-search-brave` |

## 检索三：toolkit（采样生态全貌）

| 插件 | ★ | 描述要点 |
|---|---|---|
| agent-vision-toolkit | 1127 | 纯文本模型视觉工具箱（多图理解/OCR/UI 还原/GUI 自动化） |
| CloudBase-AI-Toolkit | 1087 | CloudBase 后端 for AI coding agents（数据库/函数经 Plugin/Skills/MCP） |
| dsh-vision-toolkit | 847 | Vision for text-only models（免费额度） |
| claude-paper | 332 | 跨 agent 论文工具箱（含本地 web viewer） |
| **awesome-deepseek-harness** | 224 | DSH 终极指南：快速入门、资源、精选插件（配套站点 awesome-dsh-plugin.com） |
| dsh-toolkit | 28 | 零依赖工具包：time/encoding/json/calculator 等 10 个确定性工具 |
| ff-toolkit | 9 | FFmpeg toolkit with CLI, MCP server, AI tool schemas |
| dsh-trading-toolkit | 2 | A 股/美股行情工具包（EastMoney，只读） |

## 检索四：map / 地图 / amap

**无匹配插件**。

## 检索五：browser automation / scraping / 爬虫 / 抓取

**无匹配插件**。

## 结论（供 design.md §4.1 引用）

1. 旅行/地图/浏览器自动化三类在 DSH 公开插件生态中均为空白 -> 本插件为空白区新作，无直接可装前驱。
2. 搜索类生态成熟：**dsh-web-search-pro**（★58）为最贴合 FR-3 的候选（小红书/B 站定向搜索 + Playwright 渲染 + 缓存）；免 key 兜底选 dsh-free-search（★93）；结构化证据选 modsearch（★326）。
3. 通用清单站 awesome-dsh-plugin.com / awesome-deepseek-harness（★224）。
4. 注意：以上为 find_dsh_plugin 实时检索快照（2026-08-31），star 与能力描述均来自该工具返回的仓库 README 摘要；**均为第三方代码，安装前须审计源码并固定 commit**。
