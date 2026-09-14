import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * vitest 配置（W6 引入）：client 半单测专用别名。
 *
 * 为什么：`@deepseek-ai/dsh-client-runtime/client` 的包产物 lib/client.js 是
 * ModuleLoader 包裹的浏览器 bundle（`window.__ModuleLoader__.load(...)`），
 * vitest（node 环境）无法执行。把该 specifier 的运行时值面指到包内 TS 源
 * `src/client/contract/store.ts`（createSnapshotStore 就在那里）——
 * 类型面不受影响（tsc 走包 exports 的 .d.ts；类型导入在 esbuild 变换中被擦除）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(
        new URL('node_modules/@deepseek-ai/dsh-client-runtime/src/client/contract/store.ts', import.meta.url),
      ),
    },
  },
  test: {
    // client 单测只覆盖纯逻辑（控制器/字段），不需要 DOM 环境
    environment: 'node',
    // .test-env/ 是独立测试环境（插件 clone/伴随服务/实例资产，W3）：其自带
    // 测试不属于本仓套件（依赖/配置自成一体），排除防误扫污染基线闸门。
    exclude: ['**/node_modules/**', '.test-env/**'],
  },
})