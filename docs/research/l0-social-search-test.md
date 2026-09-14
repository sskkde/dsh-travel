# 调研档案 · FR-3 检索层 L0 实测（web_search 社媒可达性验证）

> 来源：编排者实测（2026-09-01，用本会话宿主 web_search 工具——即插件将使用的 dsh-web-search-deepseek 同源能力——对四大社媒平台做隔离查询 + robots.txt 取证 + 直抓测试）。

## 一、web_search 可达性实测

| 平台 | 查询方式 | 结果 | 判定 |
|---|---|---|---|
| **抖音** | `抖音 杭州旅游攻略`（无 site:）/ `site:douyin.com 杭州旅游攻略` | `douyin.com/shipin/...`（视频页）与 `douyin.com/note/...`（图文笔记）多条返回，标题即内容线索（如"实话不好听，但这就是十二月份杭州旅游的现状…"） | ✅ **可达性超预期**（视频页+笔记页均可搜到） |
| **知乎** | `site:zhihu.com 杭州三日游 行程安排` | `zhuanlan.zhihu.com/p/...` 专栏文章返回（"2025杭州旅游全攻略…全是避坑大实话"） | ✅ 索引良好 |
| **B站** | `site:bilibili.com 杭州 旅游 vlog` | `bilibili.com/video/BV...` 返回，带完整描述性标题 | ✅ 索引良好 |
| **小红书** | `site:xiaohongshu.com 杭州旅游攻略`（隔离查询） | 返回 2 条 `xiaohongshu.com/explore/...`（"夏天的西湖就是一幅油画"、"五一畅游西湖｜手划船乘坐秘籍"，URL 带 xsec_token）；**混合查询中一条未出现** | ⚠️ **部分可达**（仅 /explore 页面，覆盖有限、不稳定） |
| 大众点评 | `杭州 美食推荐 大众点评` | 结果为头条/百家号/百科，**无 dianping.com 直达** | ❌ 不可达（符合设计预期） |

**意外收获（L0 新增目标源）**：搜索自然混出三类高价值攻略源——①**豆瓣小组**（`douban.com/group/topic/...` 攻略帖，如"杭州穷游暴走四天四晚"）；②**携程社区 moments**（`trip.com/moments/...` 大量 UGC 攻略，含多语言站）；③**今日头条**（头条号+微头条，避雷/踩坑内容密度高，如"杭州骗局揭秘！在杭州待了5天的血泪总结"）。另见夸克/神马（sm.cn）聚合攻略页。

## 二、robots.txt 取证（2026-09-01 抓取）

| 平台 | 关键规则 | 含义 |
|---|---|---|
| 小红书 | `Googlebot: Disallow /`（仅 /worldcup26 例外）；Baiduspider/bingbot/360/Sogou/Yisou：`Disallow /` 但 `Allow /explore`、`/sitemap-notes-` 等 | **对 Google 完全封锁；对国内引擎只放行 /explore 探索页**——解释了 L0 部分可达现象 |
| 抖音 | UA 名单含 Googlebot/Bingbot/Baiduspider/Sogou/PerplexityBot/OAI-SearchBot 等（Disallow 规则在其后） | 索引受限，但实测仍可搜到（搜索后端含字节系内容源） |
| 知乎 | Googlebot Allow（部分路径 Disallow） | 索引良好 |
| B站 | `User-agent: *` 仅 Disallow 少量路径 | 索引开放 |

## 三、命中 URL 直抓测试（无浏览器 curl + 桌面 UA）

| 目标 | 结果 | 含义 |
|---|---|---|
| 小红书 explore 页（带 xsec_token） | **HTTP 200，79KB HTML，含 title 与正文关键词** | ✅ **HTTP 直抓可行**（低于 L2 成本；注意 xsec_token 可能有时效，应命中即抓） |
| 抖音笔记页 | HTTP 200，72KB HTML，**无 title 标签** | ❌ JS 渲染 SPA——**必须 L2 浏览器（Playwright）抽取正文** |

## 四、对 FR-3 检索层优先级的修正结论

1. **L0→L1→L2→L3 四层顺序成立**，但各层职责按实测修正：
   - **L0（宿主 web_search）**：覆盖知乎✅/B站✅/抖音✅（视频+笔记 URL+标题）/小红书⚠️（仅 explore 页）；**目标源清单扩充**：+豆瓣小组、携程社区 moments、今日头条（均为攻略高密度源，直抓友好）。
   - **L0.5（HTTP 直抓，成本低于浏览器）**：小红书 explore（带 token 命中即抓）、知乎专栏、头条文章、豆瓣帖子——纯 curl/fetch 可得正文。
   - **L1（dsh-web-search-pro 定向）**：对小红书仍是覆盖增强层（提高 explore 页命中量）。
   - **L2（Playwright MCP）**：**抖音正文抽取的必需层**（JS 渲染）；小红书非 explore 内容。
   - **L3（CloakBrowser）**：登录墙内容（默认 off）。
2. **小红书结论**：web_search 可搜到（site: 查询触发），但 robots 限制决定了只有 explore 公开页可索引——"搜索可达≠全量内容"，L1 增强与 L0.5 及时抓取是关键。
3. **抖音结论**：可达性超预期（/shipin+/note 均可索引，搜索后端含字节系内容），但正文必须 L2。
4. **大众点评/美团**：L0 不可达，维持"不直接爬、以社媒替代"设计不变。

## 五、L1 层核验：dsh-web-search-pro 的小红书覆盖（2026-09-01 源码级核验）

> 对象：github.com/anweat/dsh-web-search-pro（master 分支，60★，MIT，2026-08-25 活跃）。方法：全仓 grep + 精读 `src/platform-search.ts`/`src/engines.ts`/`LOGIN.md`/`docs/RESEARCH.md`。

### 结论：声称覆盖，但小红书走的是"重前置条件"通道，非开箱即用

**平台搜索有两条实现路径（源码证据）**：

| 路径 | 平台 | 机制 | 前置条件 |
|---|---|---|---|
| ①内置 Playwright+storageState（`platform-search.ts` 的 PLATFORM_SEARCH_SPECS） | **知乎/微博/豆瓣/贴吧/抖音/快手**（6 个，**无小红书**） | 登录态浏览器打开各站搜索页读 DOM（"MediaCrawler 的精神、MIT 独立实现"，不碰私有 API 与签名算法） | `scripts/save-login.mjs` 一次登录保存 storageState + dsh-browser 插件 |
| ②opencli 引擎（`engines.ts:485,492-522,696`：`OPENCLI_PLATFORMS={xiaohongshu,twitter,reddit,instagram,facebook}`） | **小红书**/Twitter/Reddit/IG/FB | `browser.opencli(['xiaohongshu','search',query,'-f','yaml'])` —— **桌面 Chrome/Edge 扩展 + CDP 复用桌面浏览器已登录会话** | dsh-browser 插件（opencli bundled）+ 桌面浏览器装 opencli 扩展**并保持连接** + 桌面浏览器已登录小红书 |

**可用性判定**：
- `available()` 三重检查（enableCli && opencliEnabled && browser）；任一不满足或扩展断连 -> `ENGINE_UNAVAILABLE`（错误信息自带提示"browser session connected?"）。
- **服务器/无桌面环境（含本机 headless Linux）基本不可用**；插件作者自己的环境是 Windows 桌面（Edge 已装），其 RESEARCH.md 记录"本机 doctor 显示扩展文件存在但当前未连接"——连接脆弱性由作者自证。
- README:76 宣称的"20 平台含小红书"与实现一致，但小红书在 opencli 组（README:136 明示"由 dsh-browser 内置；扩展未连接时用 opencli doctor 诊断"）。

### 作者实测佐证（RESEARCH.md，对我们分层设计的旁证）

- 免登录公开接口全被风控：知乎 `search_v3`→40362、微博 `m.weibo.cn`→空、豆瓣 `/j/search`→403 ——**佐证 L0.5/L2 分层必要性**（直抓/浏览器为正道）。
- MediaCrawler 为 **NON-COMMERCIAL 学习许可**（签名算法不可照搬进 MIT 项目）——dsh-web-search-pro 选择"纯 Playwright 驱动搜索页"路线绕开。

### 对本项目的修正

1. **L1 对小红书的"覆盖增强"降级为"有条件可用（桌面环境）"**；小红书主路径维持 **L0（site: 搜索 explore 页）+ L0.5（explore 直抓）+ L3（登录态）**。
2. **L1 的真正价值重估**：对知乎/微博/豆瓣/贴吧/抖音/快门的 6 平台内置定向（Playwright+storageState）远超我们原设想——不只是"搜索"，而是**带登录态的搜索页 DOM 读取**，可覆盖 L2 级正文；这 6 平台可由该插件一并解决 L1+L2。
3. **L3 替代方案浮出**：dsh-web-search-pro + dsh-browser 的 storageState 方案（save-login.mjs）是 CloakBrowser 之外的登录态实现（MIT、纯 Playwright）——若用户接受"桌面浏览器登录一次"，可作为 L3 的轻量替代（同一 §5.6 合规边界）。

## 六、L0.5 深挖：小红书 explore 直抓能拿到什么级别的详细内容（2026-09-01 内容级解剖）

> 方法：对搜索命中的 2 条 explore 笔记做直抓（curl + 桌面 UA），解剖 `window.__INITIAL_STATE__` SSR 数据块（19.9~22.7KB）与 og meta 标签。

### 能拿到的（两条笔记交叉验证一致）

| 字段 | 笔记1（西湖油画） | 笔记2（手划船秘籍） | 提取方式 |
|---|---|---|---|
| **正文全文（desc）** | ✅ 全文含"避开断桥往西走"贴士+话题标签 | ✅ 全文含 8 个码头/船型挑选/消费规范（高价值攻略） | INITIAL_STATE.desc |
| **作者昵称** | 秋风紫霜 | 无忧掌上西湖（官方号） | INITIAL_STATE.nickname |
| **发布时间** | 2023-07-24 20:17 | 2023-04-29 | INITIAL_STATE.time（毫秒时间戳） |
| **互动数据** | 赞 107 / 藏 30 / 评 5 / 转 10 | 赞 40 / 评 22 | likedCount/collectedCount/commentCount/shareCount |
| 标题 | ✅ og:title + `<title>` | ✅ 同 | og meta |

**结论：正文全文+作者+时间+互动数据可结构化直取**——FR-3 需要的核心情报（真实评价/避雷/贴士）在 L0.5 即可满足，无需浏览器。

### 拿不到的（边界）

| 内容 | 现象 | 结论 |
|---|---|---|
| **评论正文** | commentCount 有数字（5/22）但评论区 content 为 UI 占位文案（"想了解些什么？"），无真实评论内容 | 评论需登录态（L3）或放弃（P2） |
| **图片直链** | imageList 数组存在但无 xhscdn URL；og:image 为 picasso-static 占位图 | 图片不可靠（对行程页非关键，放弃无碍） |
| **无 xsec_token 访问** | HTTP 200 但返回"小红书 - 你访问的页面不见了"（404 shell），无 desc | **token 必需** |

### 工程约束（对 L0.5 实现的关键要求）

1. **xsec_token 与 URL 绑定且必需**：必须从搜索结果中同步取得带 token 的完整 URL；**命中即抓**（token 可能时效过期）。
2. **缓存策略**：缓存抓取结果（解析后的结构化条目），而非 URL（URL+token 一次性，重放 404）。
3. 解析目标：`window.__INITIAL_STATE__` JSON 块（正则或 JSON5 容错解析，注意含 `undefined` 需清洗）+ og meta 兜底。

## 七、完整性审计：web_search 搜小红书笔记是否"全"（2026-09-01，12 次查询 + sitemap 规模参照）

> 审计口径（用户定义）："返回结果覆盖全部相关小红书笔记、无遗漏"为全。实验：E1 饱和度（多查询变体）、E2 稳定性（同查询重复）、E3 数量上限（工具签名与输出观察）、E4 语料规模参照（小红书 sitemap，robots 允许引擎的唯一全量通道）。

### 查询矩阵（本会话累计 12 次含小红书意图的查询）

| # | 查询 | 小红书命中 |
|---|---|---|
| 1-4 | 合并批（小红书/site:/抖音 4 query 合一） | **0** |
| 5 | `site:xiaohongshu.com 杭州旅游攻略`（隔离） | 2（笔记 A+B） |
| 6 | `小红书 杭州 三日游 攻略笔记` | 0 |
| 7 | `site:xiaohongshu.com 杭州旅游` | 1（A） |
| 8 | `site:xiaohongshu.com 杭州攻略` | 1（**A 重复**） |
| 9 | `site:xiaohongshu.com 杭州避雷` | **0（site: 被无视**，返回新浪投诉/科普中国等无关页） |
| 10 | `site:xiaohongshu.com 杭州美食` | 0（No results found） |
| 11 | `site:xiaohongshu.com 西湖` | 1（B） |
| 12 | `小红书 杭州 笔记 推荐` | 0（返回淘宝江湖营销文） |

**累计不重复笔记：2 条**（A=西湖油画 2023-07、B=手划船 2023-04）。

### 语料规模参照（sitemap 实测）

- 小红书 sitemap 索引仅含 2 个笔记文件：`sitemap-notes-0`（40,000 条）+ `sitemap-notes-1`（11,458 条）= **51,458 条**。
- 笔记 ID 首段为时间戳（MongoDB ObjectID 式）：sitemap 两个文件分别为 **2026-03-28 / 2026-07-01 起的近月滚动窗口**；**两条被搜到的笔记（2023 年）均不在 sitemap 中**（属引擎历史存量索引）。
- 即：引擎可见语料 = 51,458 条滚动窗口 + 引擎自选的历史存量抽样；平台全量语料（数亿级，单话题数万+）远超此数。

### 四个失效面逐项判定

| 失效面 | 判定 | 依据 |
|---|---|---|
| **笔记遗漏** | ❌ 严重 | 12 查询仅命中 2 条；覆盖率对引擎可见窗口 = 2/51,458 ≈ **0.004%**。遗漏三层叠加：robots 只放行 /explore（Google 全禁）→ 引擎索引本身是抽样 → web_search 再取 top-N。自然语言式查询（#6/#12）命中为 0，说明不带 site: 时小红书内容几乎不进结果 |
| **分页截断** | ❌ 结构性 | 工具无分页/offset 参数；输出明示 "Showing the first 8 sources. Refine the query for more."——每查询硬顶 ~8 条且无翻页机制，第 9 条起不可达 |
| **数量限制** | ❌ 双重 | ① 单查询 ~8 条上限；② **多查询合并惩罚**：本工具 1~4 query 合并共享一个结果集，4 查询合并批（#1-4）小红书命中直接归零 |
| **去重错误** | ⚠️ 双向 | ① **重复浪费**：笔记 A 在 3 次查询重复返回（5 次总命中中 3 次同一笔记），工具不做跨查询去重；② **假性唯一风险**：URL 携带会话相关 xsec_token，同一笔记跨会话 URL 不同——按 URL 全串去重会产出假"不同笔记"，**必须以 URL 路径中的笔记 ID（`/explore/<id>`）为去重键** |
| （附）site: 算子 | ⚠️ 尽力而为 | #9 完全被无视（0 条小红书 + 8 条无关投诉页），site: 不是硬过滤 |

### 结论：**不全**

在"覆盖全部相关笔记、无遗漏"口径下，web_search 对小红书的召回是**三层抽样后的极小子集**（平台全量 → 引擎索引抽样 → top-8 展示），覆盖率数量级 ≈ 0.004%（仅对引擎可见窗口）。**其正确语义是"种子发现层"**：每次命中 0~2 条高质量带 token 的 explore URL，供 L0.5 直抓；不可作为枚举/覆盖层使用，产品上不可承诺"全量社媒情报"。

### 设计回写

1. L0 对小红书定位明确为**种子发现**（多查询变体轮询提高种子量，预期仍为个位数）。
2. 去重键规则：笔记 ID（URL 路径段），非 URL 全串。
3. 覆盖语义：FR-3 社媒情报为**抽样聚合**（与 NFR-3"AI 汇总请以来源为准"一致），行程页标注"社媒内容为抽样，非全量"。
4. 更广覆盖的唯一现实路径 = L3 登录态（平台自有搜索）。
