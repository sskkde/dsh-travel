# 调研档案 · DSH 插件框架扩展点 API（explore 报告归档）

> 来源：explore subagent e0357482（2026-08-31，只读调查 /usr/lib/node_modules/@deepseek-ai/dsh/ 及 node_modules/@deepseek-ai/*，全部结论带文件路径+行号锚定）。

## Q1 工具注册（框架包 dsh-tools）

- `defineTool(options)`：`node_modules/@deepseek-ai/dsh-tools/lib/index.js:836`；options：`{ name, description, parameters, output:{schema, render(args,value), presentationMeta?}, execute(args, exec), timeoutMs?, finalizeContent?, presentCall?, presentResult?, isConcurrencySafe? }`（:863-917）
- 参数 schema：per-property spec -> 编译为 **受限 JSON Schema 子集**（支持 type/oneOf/properties/required/additionalProperties/items/enum/const + description/title/default/examples；越界关键字直接抛错，:24-34）
- 注册：`ctx.tools.register(definition)`（:2762），重复注册抛错；inject 服务名 `"tools"`
- 官方最小样例：`dsh-tool-ask-user/lib/index.js`（116 行）：`import { defineTool }` -> `const name/inject/description` -> `apply(ctx){ ctx.tools.register(defineTool({...})) }` -> `export { apply, inject, name }`（cordis 插件三件套）

## Q2 技能（skill）机制

- 扫描：dsh-skill-filesystem，布局 `<root>/<name>/SKILL.md`；frontmatter **必需 name+description**，可选 `whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`
- 注入：dsh-tool-skill 经 `agent/pre-step` 钩子注入 `<available_skills>` **目录消息**（name+description+whenToUse 摘要行，digest 变化才更新）-> 模型调 `skill` 工具取全文；用户点名技能名也可触发注入
- **关键事实：DSH 无独立意图匹配引擎**--机制是「目录展示 + 模型自选」

## Q3 HTTP 路由与 UI

- webserver：dsh-host-webserver 提供 `webServer` 服务；`register({kind:"exact"|"prefix", path, handler(req,res)})`（:128-135，node:http 风格 handler）-> **serve 自建 HTML 行程页 = 注册 prefix 路由**；`registerUpgrade`（WebSocket）、`registerFallback`（SPA 兜底）
- ui-panel 形态：node 半（可空 apply）+ 浏览器半（package.json `exports["./client"]` 声明，`window.__ModuleLoader__.load({id, factory})` 入口，React + dsh-client-ui-primitives）
- 运行时动态插件：`cordis_define/run/stop/undefine` 工具（dsh-tool-cordis :7081-7424）

## Q4 意图触发与动态加载

**「识别意图->自动挂载插件工具」的专用机制不存在。** 动态性三条路径：
1. cordis_define 运行时插件（沙箱只暴露 ctx.tools.register/ctx.on/ctx.provide/timer）
2. MCP：dsh-mcp-client 连接 MCP server 并把其工具注册到 ctx.tools
3. skill 目录按会话快照注入、正文按需加载

agent-presets（启动时按 preset 组合插件）/ persona（prompt 段）/ commands（`/命令` 注册表）均非意图触发机制。

## Q5 配置与密钥

- `ctx.credentials.resolve("<scope>/<id>")`（dsh-credentials-local :473）；落地 `$DSH_HOME/.credentials.yaml`；读取分层：process env -> `<cwd>/.env` -> `$DSH_HOME/.env` -> 托管 store
- `ctx.settings` + `settingsNamespace("x")`（role('secret') 字段自动脱敏）
- 插件 Config：schemastery `z.object({...})` + `apply(ctx, config)`

## Q6 官方包清单（约 150 个 @deepseek-ai/* 包）

- toolkit：dsh-tool-ask-user（样例）、dsh-tool-bash、dsh-tool-web、dsh-tool-skill、dsh-tool-todo、dsh-tool-fs 等 20+
- skill：dsh-skill（注册表）、dsh-skill-filesystem（provider）、dsh-tool-skill（调用侧）
- ui-panel：dsh-client-ui-* 25+
- loop：dsh-agent-loop、dsh-goal + dsh-goal-round-driver、dsh-agent-presets、dsh-persona
- 基础设施：dsh-cordis-host-runner、dsh-host-webserver、dsh-mcp-client、dsh-tools

## 对旅行插件设计的关键结论

1. 工具：`defineTool + ctx.tools.register + export {apply, inject:["tools"], name}`；参数 schema 用受限子集
2. 行程页：`ctx.webServer.register({kind:"prefix", path, handler})` 直接 serve 自建 HTML（最简可靠路径）
3. 技能：随插件 bundle 放 skill 目录自动发现；FR-1「意图触发」以「技能目录+模型自选」+ 工具描述约束实现
4. API key：`ctx.credentials.resolve()` 或 z.object Config
5. MCP 依赖：可由宿主 dsh-mcp-client 装配（本机已有 mcp-lexiang 先例），也可插件内直接 HTTP 调用
