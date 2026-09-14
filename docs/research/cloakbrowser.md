# 调研档案 · CloakBrowser（librarian 报告归档）

> 来源：librarian subagent 1f08859c（2026-08-31），全部结论附来源 URL；「未确认」项为如实标注。

## 结论摘要

CloakBrowser = 源码级（C++）反指纹 Chromium 二进制 + Playwright/Puppeteer 无缝替代库，官方仓库 `CloakHQ/CloakBrowser`（约 31k stars / MIT 徽章 / 2026-02 创建，活跃维护）。已从纯开源转为 **freemium**：最新二进制免费试用（单并发会话，GitHub 登录领 key），多会话/千级并发需 Pro 订阅。官方无 REST API / MCP / 托管云服务，全是本地库；中文平台有实际使用案例（小红书/抖音相关的 MCP 与项目），但无官方背书文档。

## 评估卡片（相对本插件需求）

| 维度 | 结论 |
|---|---|
| 是什么 | 反指纹 Chromium（73 个 C++ 源码级补丁：canvas/WebGL/audio/fonts/GPU/screen/WebRTC/TLS 等）+ Playwright 兼容 API |
| 接入方式 | Python `cloakbrowser` / npm `cloakbrowser` / Puppeteer / .NET；API 与 Playwright 完全兼容（一行 import 切换）；`cloakserve` CDP 多路复用 CLI；Docker 免安装试用；**官方无 MCP/REST**，社区 MCP 包装存在：isklv/cloakbrowser-mcp（Docker wrapper/CDP server）、swimmwatch/cloakbrowser-mcp（Playwright-powered，multi-session HTTP transport）、overtimepog/CloakMCP、npm `@devinwangd/cloak-browser-mcp` |
| key/付费 | 免费=最新二进制+单并发（GitHub OAuth 领 key）；Pro=多会话/千级并发（`CLOAKBROWSER_LICENSE_KEY`）；Pro 价格未公示（聚合站称 $19/mo 起，非一手） |
| 登录态/代理 | `launch_persistent_context()` 持久 cookies/localStorage；`storage_state` 导入导出；fingerprint seed 固化虚拟身份；原生 SOCKS5/HTTP 代理、`geoip=True` 时区对齐、WebRTC IP 欺骗；不自带代理轮换与 CAPTCHA 解决 |
| 中文平台案例 | xhs-mcp（小红书 MCP 重写）、social-auto-upload-web-ui（小红书发布）、douyin-music-publish（抖音）、js-reverse-mcp `--cloak`（Patchright+CloakBrowser 双层，中文文档）；MediaCrawler 未确认官方集成 |
| 可靠性 | dev.to 实测 14/20（第二），唯一通过真实 Cloudflare challenge 的被测浏览器；社区安全审计项目存在（patch 闭源，信任风险自评） |
| 局限 | ⚠️ 补丁源码未公开（README 的 MIT 仅覆盖 wrapper）；无官方 MCP/REST；需自带代理；合规风险（反爬对抗）由使用方承担 |

## 对比定位

- vs JS 注入系（playwright-stealth/undetected-chromedriver）：配置层补丁易随 Chrome 更新失效且可被检测；CloakBrowser 编译进二进制。
- vs Patchright（协议层，实测 18/20 第一）：js-reverse-mcp 采用 Patchright+CloakBrowser 双层路线。
- vs Camoufox（Firefox 系源码级）：同思路不同内核。
- vs Browserbase/Browserless（托管云端浏览器 REST 服务）：不同赛道；需要 REST API 形态时应选后者。

## 关键来源

- https://github.com/CloakHQ/CloakBrowser （README：73 patches、freemium、代理、humanize）
- https://cloakbrowser.dev （平台矩阵、/free 领 key、/pricing 404）
- https://github.com/CloakHQ/CloakBrowser/discussions/154 （patch 不公开的社区确认）
- https://dev.to/adityamitra （反检测浏览器实测排名）
- https://github.com/zhizhuodemao/js-reverse-mcp （--cloak 双层反检测中文文档）
- https://github.com/mafanding/xhs-mcp （CloakBrowser 重写的小红书 MCP）
- https://pypi.org/project/cloakbrowser 、https://www.npmjs.com/package/cloakbrowser

## 未尽确认项

Pro 具体价格与计费条款；是否有企业托管版；MediaCrawler 是否官方支持换内核；闭源补丁的 MIT 声明法律边界。

## 备选方案对比：小红书登录态搜索的 CloakBrowser 替代（2026-09-01 调研核查）

| # | 方案 | 机制 | 许可/热度 | 优点 | 缺点 |
|---|---|---|---|---|---|
| 1 | **xpzouying/xiaohongshu-mcp** | Playwright 无头浏览器 + 扫码登录（会话持久化），MCP 标准（`search_feeds` 搜索/读 feed/读评论） | **Apache-2.0，★15.6k**，2026-08-31 仍活跃 | **专用小红书的事实标准**：完全开源、Docker 分发、宿主 dsh-mcp-client 可直接挂载；作者自述"原项目稳定运行一年多无封号（仅 cookies 过期需重登）"；另有 x-mcp 浏览器插件版（会话留在用户自己浏览器，合规姿态更优） | 普通无头浏览器无源码级反指纹；同一账号仅允许单网页端会话；自带发布/评论工具需收敛为只读 |
| 2 | Agent-Reach | 聚合路由层：小红书路由 = OpenCLI ▸ **xiaohongshu-mcp** ▸ xhs-cli 自动切换 | MIT，★77k | 一揽子多平台登录态渠道（Twitter/Reddit/YouTube/小红书），装好后自动选路+体检；合规卫生好（不注入 Cookie、只用用户既有会话） | 本身非新机制（后端即 xiaohongshu-mcp）；为 OpenClaw 生态设计需 exec 权限 |
| 3 | dsh-web-search-pro + dsh-browser | 内置 Playwright + storageState（AuthProfile 域名授权）读搜索页 DOM | MIT，★58 | DSH 原生生态；AuthProfile 安全模型（allowedDomains/persistState） | **内置平台清单无小红书**（仅知乎/微博/豆瓣/贴吧/抖音/快手）——需借其 BrowserService 机制自写小红书 spec |
| 4 | Patchright + 自研 spec | 协议层反检测的 Playwright 分支（dev.to 实测 18/20 **第一**，高于 CloakBrowser 14/20） | MIT | 反检测能力最强且开源；API 与 Playwright 兼容 | 需自写小红书搜索页驱动与解析（工程量大于直接用 xiaohongshu-mcp） |
| 5 | opencli（经 dsh-web-search-pro） | 桌面 Chrome/Edge 扩展 + CDP 复用桌面浏览器会话 | 随 dsh-browser | 会话留在用户自己浏览器（合规姿态最好）、零 Cookie 导出 | **需桌面环境+扩展常连接**（服务器环境不可用；作者本机亦常断连） |
| 6 | MediaCrawler | Playwright + 登录 + JS 表达式算签名（x-s） | **NON-COMMERCIAL 学习许可** | 覆盖 7 平台的成熟参考实现 | 禁商用 + 逆向签名法律风险——仅作学习参考，不采用 |
| 7 | 商业数据平台（千瓜数据/新红等） | 付费数据服务 API/报表 | 商业订阅 | 完全规避封号/合规风险，数据稳定 | 付费；API 面向营销分析而非通用笔记检索；需商务接入 |

**结论**：首选备选 = **xpzouying/xiaohongshu-mcp**（开源/专用/生态验证/MCP 标准，四项全占），生态佐证：Agent-Reach（★77k）将其列为小红书路由后端之一。推荐组合：xiaohongshu-mcp（主）+ Patchright 自研（风控升级预案）+ opencli/商业平台（按需）。

来源：https://github.com/xpzouying/xiaohongshu-mcp （README：search_feeds/登录/单会话约束/一年无封号自述）；https://github.com/Panniantong/Agent-Reach （README 平台矩阵与 xiaohongshu.py 路由）；GitHub API 检索（2026-09-01，star/许可/活跃度）；本档案既有对比段（Patchright/dev.to 排名）。
