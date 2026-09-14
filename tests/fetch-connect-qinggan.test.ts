/**
 * W4 fix-f1e A/B：secureConnectFetch 生产建连层（node:http/https 直连）路径与
 * abort 监听时序测试。
 *
 * 为什么单列文件：secureConnectFetch 是模块私有（仅 manualRedirectFetch 缺省
 * fetchImpl 走它），要捕获它传给 http.request 的 opts（含 path）必须 mock
 * node:http/node:https——vi.mock 是文件级生效的，单列文件隔离该 mock 不波及其
 * 他 qinggan 测试（后者一律注入 fetchImpl stub，不触碰 node:http）。
 *
 * A：commonOpts 必须保留原 URL 的 pathname+search（修复前 http.request 缺 path
 *     → 默认请求 `/`，正文来源错配 /articles/42?q=qinggan → /）。
 * B2：abort 监听不得在收到 headers 时移除——读体期 abort 仍须驱动 req.destroy
 *     （挂起 body 不再泄漏）；修复前收到 headers 即 removeEventListener，读体期
 *     abort 不 destroy → 本测试 destroyCalls=0（红）→ 修复后 ≥1（绿）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => ({
  httpOpts: [] as Array<Record<string, unknown>>,
  httpsOpts: [] as Array<Record<string, unknown>>,
  destroyCalls: 0,
  /** 'end' = 响应体立即推完（path 断言用）；'hang' = 永不结束（abort/类型闸门时序用）。 */
  mode: 'end' as 'end' | 'hang',
  /** 响应 content-type 头（null = 缺头 → content_type_missing 场景）。 */
  contentType: 'text/html; charset=utf-8' as string | null,
}))

vi.mock('node:http', async () => {
  const { Readable } = await import('node:stream')
  function fakeRequest(opts: Record<string, unknown>, cb?: (res: unknown) => void) {
    mockState.httpOpts.push(opts)
    const res = Object.assign(new Readable({ read() {} }), {
      statusCode: 200,
      headers: mockState.contentType === null ? {} : { 'content-type': mockState.contentType },
    })
    if (mockState.mode === 'end') {
      process.nextTick(() => {
        res.push(Buffer.from('<html>ok</html>'))
        res.push(null)
      })
    }
    cb?.(res)
    return {
      once: () => {},
      end: () => {},
      destroy: () => { mockState.destroyCalls += 1 },
    }
  }
  return { request: fakeRequest }
})

vi.mock('node:https', async () => {
  const { Readable } = await import('node:stream')
  function fakeRequest(opts: Record<string, unknown>, cb?: (res: unknown) => void) {
    mockState.httpsOpts.push(opts)
    const res = Object.assign(new Readable({ read() {} }), {
      statusCode: 200,
      headers: mockState.contentType === null ? {} : { 'content-type': mockState.contentType },
    })
    if (mockState.mode === 'end') {
      process.nextTick(() => {
        res.push(Buffer.from('<html>ok</html>'))
        res.push(null)
      })
    }
    cb?.(res)
    return {
      once: () => {},
      end: () => {},
      destroy: () => { mockState.destroyCalls += 1 },
    }
  }
  return { request: fakeRequest }
})

import { manualRedirectFetch, SAFE_FETCH_REASON } from '../src/adapters/safe-fetch.js'

const pubResolver = async () => ['93.184.216.34']

beforeEach(() => {
  mockState.httpOpts.length = 0
  mockState.httpsOpts.length = 0
  mockState.destroyCalls = 0
  mockState.mode = 'end'
  mockState.contentType = 'text/html; charset=utf-8'
})

describe('A：secureConnectFetch 保留原 URL path/search（正文来源不错配）', () => {
  it('https + query：path = pathname + search 完整传递（/articles/42?q=qinggan）', async () => {
    const res = await manualRedirectFetch('https://site.example/articles/42?q=qinggan', { resolver: pubResolver })
    expect(res.status).toBe(200)
    expect(res.text).toContain('ok')
    expect(mockState.httpsOpts).toHaveLength(1)
    expect(mockState.httpsOpts[0].path).toBe('/articles/42?q=qinggan')
  })

  it('https 无 query：path = pathname（不带尾 ?）', async () => {
    await manualRedirectFetch('https://site.example/articles/42', { resolver: pubResolver })
    expect(mockState.httpsOpts).toHaveLength(1)
    expect(mockState.httpsOpts[0].path).toBe('/articles/42')
  })

  it('http 同样保留 path（非 https 专有问题）', async () => {
    await manualRedirectFetch('http://site.example/page?a=1&b=2', { resolver: pubResolver })
    expect(mockState.httpOpts).toHaveLength(1)
    expect(mockState.httpOpts[0].path).toBe('/page?a=1&b=2')
  })
})

describe('B2：读体期 abort 仍驱动 req.destroy（abort 监听不在收到 headers 时移除）', () => {
  it('挂起响应体 + timeoutMs=5 → TimeoutError 且 req.destroy 被调用（释放挂起连接）', async () => {
    mockState.mode = 'hang'
    await expect(
      manualRedirectFetch('https://hang.example/x', { resolver: pubResolver, timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    // 修复前：收到 headers 即移除 abort 监听 → 读体期 abort 不 destroy（0）
    // 修复后：读体期 abort → abortHandler → req.destroy（≥1）
    expect(mockState.destroyCalls).toBeGreaterThanOrEqual(1)
  })
})

/**
 * F1g（oracle 四审 F1 High 收官）：类型拒绝/早期退出路径释放底层连接——
 * 不等待调用方未来 abort，也绝不 abort 调用方外部 signal。
 *
 * 修复前：settledRead 类型闸门拒绝直接 throwGate，response.body（Readable.toWeb
 * 包装的挂起流）与底层 req/socket 均未释放；且外部 signal 时自建 controller 为
 * undefined，finally 的 abort 不触发 → 连接泄漏。修复后：类型拒绝路径主动
 * cancel body + destroy 底层连接（destroyCalls≥1），调用方 signal 原样保留。
 */
describe('F1g：外部 signal + 类型拒绝（无 content-type/白名单外）→ 主动销毁底层连接且不中止调用方', () => {
  it('外部 signal + 挂起 body + 无 content-type → content_type_missing 且 req.destroy（destroyCalls≥1）、调用方未被中止', async () => {
    mockState.mode = 'hang'
    mockState.contentType = null
    const caller = new AbortController()
    const p = manualRedirectFetch('https://hang.example/x', { resolver: pubResolver, signal: caller.signal })
    await expect(p).rejects.toMatchObject({ reasonCode: SAFE_FETCH_REASON.CONTENT_TYPE_MISSING })
    // 类型拒绝：主动释放挂起 body 的底层连接，不依赖调用方未来 abort
    expect(mockState.destroyCalls).toBeGreaterThanOrEqual(1)
    // 绝不中止调用方外部 controller
    expect(caller.signal.aborted).toBe(false)
  })

  it('外部 signal + 挂起 body + 白名单外 content-type（octet-stream）→ content_type 且 req.destroy、调用方未被中止', async () => {
    mockState.mode = 'hang'
    mockState.contentType = 'application/octet-stream'
    const caller = new AbortController()
    const p = manualRedirectFetch('https://hang.example/x', { resolver: pubResolver, signal: caller.signal })
    await expect(p).rejects.toMatchObject({ reasonCode: SAFE_FETCH_REASON.CONTENT_TYPE })
    expect(mockState.destroyCalls).toBeGreaterThanOrEqual(1)
    expect(caller.signal.aborted).toBe(false)
  })

  it('外部 signal + 正常成功 → 不主动销毁连接（destroyCalls=0）、调用方未被中止', async () => {
    mockState.mode = 'end'
    const caller = new AbortController()
    const res = await manualRedirectFetch('https://ok.example/x', { resolver: pubResolver, signal: caller.signal })
    expect(res.status).toBe(200)
    expect(res.text).toContain('ok')
    // 成功路径不得主动 destroy（已完成的连接不需强制释放；destroy 仅拒绝路径调用）
    expect(mockState.destroyCalls).toBe(0)
    expect(caller.signal.aborted).toBe(false)
  })
})