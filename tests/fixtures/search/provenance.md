# search fixtures · provenance（M1 T3 / W2a）

| fixture | 来源 | 说明 | 脱敏 |
|---|---|---|---|
| xhs-explore.html | **真实录制**：`xiaohongshu.com/explore/644b887b0000000013012f14`（带 xsec_token，桌面 UA 直抓，2026-09-02） | `window.__INITIAL_STATE__` SSR 块裁剪至 noteDetailMap 子树（真实 desc/nickname/time/互动数据）+ 带裸 `undefined` 旁支字段（验证容错解析） | xsec_token 置空；imageList 清空；无图链 |
| zhihu-zhuanlan.html | **构造**（shape fixture）：本环境直抓 zhihu.com 被 403 风控（curl/fetch 双验）；js-initialData 形态按知乎专栏公开 SSR **文档化结构** | `#js-initialData` JSON → initialState.entities.articles | 无凭据 |
| bilibili-video.html | **构造**（shape fixture）：本环境直抓 bilibili.com 412 风控；`window.__INITIAL_STATE__.videoData` 形态按平台公开 SSR **文档化结构** | title/desc/pubdate/owner/stat | 无凭据 |

工程复核（2026-09-02 live smoke）：xhs token 仍有效时实抓成功（正文 916 字/赞 40）；
zhihu 实抓 HTTP 403 → EngineError.UNAVAILABLE 登记 blocked（环境风控，非适配器缺陷）。

铁律验证锚点：去重键=URL 路径笔记 ID（非 URL 全串）；缓存键=笔记 ID（非 URL，token 时效）；
无 token explore URL → 404「页面不见了」→ UNAVAILABLE 且单次尝试不重试（见 tests/adapters-search.test.ts）。