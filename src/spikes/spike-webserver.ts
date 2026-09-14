/**
 * spike-1 · 宿主面 `ctx.webServer.register({ kind: 'prefix', ... })` 探针。
 *
 * 探明结论（W5 render_page 据此接线）：
 * - 服务名 'webServer'；WebRoute = { kind: 'exact'|'prefix', path, handler(req,res) }
 *   （node:http 风格 IncomingMessage/ServerResponse；prefix 匹配 p 与 p/<anything>）
 * - 监听在宿主 Service.init 生命周期；本 spike 以 @deepseek-ai/cordis 独立
 *   Context + 手动 `[Service.init]()` 驱动真实 WebServer（端口 0 = 系统分配）
 * - 重复注册同 (kind,path) 抛错（幂等注册需先判重或吞抛）
 * - prefix 下的子路径原样送达 handler（req.url）
 *
 * 运行：node src/spikes/spike-webserver.ts
 */
import { Context, Service } from 'cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

const PREFIX = '/spike-travel-plans'

async function main(): Promise<void> {
  const ctx = new Context()
  const server = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  await server[Service.init]()
  console.log(`[webserver] listening on http://${server.host}:${server.port}`)

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`spike ok · kind=prefix · path=${req.url}`)
  }
  const disposer = server.register({ kind: 'prefix', path: PREFIX, handler })
  console.log(`[webserver] registered prefix route "${PREFIX}" (disposer=${typeof disposer})`)

  // 1) prefix 路由可命中
  const child = await fetch(`http://127.0.0.1:${server.port}${PREFIX}/plan-abc/`)
  console.log(`[fetch]  ${child.status} ${JSON.stringify(await child.text())}`)

  // 2) 未注册路径 → 404
  const missing = await fetch(`http://127.0.0.1:${server.port}/no-such-route`)
  console.log(`[fetch]  ${missing.status} (未注册路径 → 404)`)

  // 3) 重复注册同路径 → 明确报错（幂等注册要点）
  try {
    server.register({ kind: 'prefix', path: PREFIX, handler })
    console.log('[register] 重复注册竟然成功（异常）')
  } catch (error) {
    console.log(`[register] 重复注册被拒: ${(error as Error).message}`)
  }

  // 4) disposer 后路由解除
  disposer()
  const afterDispose = await fetch(`http://127.0.0.1:${server.port}${PREFIX}/x`)
  console.log(`[fetch]  ${afterDispose.status} (disposer 后 → 404)`)

  console.log('[spike-webserver] PASS')
  process.exit(0) // 根 Context 无 scope.dispose；探针显式退出
}

void main()