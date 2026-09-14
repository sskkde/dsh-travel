import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { makeKeyEnv, type KeyEnvCredentials } from '../src/adapters/env.js'
import {
  AMAP_SECURITY_PROXY_PATH,
  makeAmapSecurityProxyHandler,
  type AmapSecurityFetch,
} from '../src/render/route-registrar.js'

class FakeResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode
    this.headers = { ...headers }
    return this
  }

  end(chunk?: string | Uint8Array): void {
    this.body = chunk === undefined
      ? ''
      : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
}

function request(url: string, method = 'GET'): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
}

function credentialEnv(): KeyEnvCredentials {
  return {
    resolve: async (ref) => String(ref) === 'AMAP_JSCODE'
      ? { value: '<MASK>', source: 'file' }
      : undefined,
    readRecord: async () => undefined,
  }
}

function responseOf(fake: FakeResponse): ServerResponse {
  return fake as unknown as ServerResponse
}

describe('AMap JSAPI 安全代理（模式 B）', () => {
  it('固定上游并覆盖客户端 jscode：/v3 → restapi，凭据 ref 只在服务端注入', async () => {
    let called: { url: string; method: string } | undefined
    const fetchImpl: AmapSecurityFetch = async (url, init) => {
      called = { url, method: String(init.method) }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const keyEnv = makeKeyEnv({ get: () => undefined }, { credentials: credentialEnv(), env: {} })
    const handler = makeAmapSecurityProxyHandler({ keyEnv, fetchImpl })
    const res = new FakeResponse()

    await handler(
      request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init?foo=bar&jscode=client-value`),
      responseOf(res),
    )

    expect(called).toEqual({
      url: 'https://restapi.amap.com/v3/log/init?foo=bar&jscode=%3CMASK%3E',
      method: 'GET',
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.body).toBe('{"ok":true}')
    expect(res.body).not.toContain('<MASK>')
  })

  it('官方样式路径 /v4/map/styles → webapi 上游，HEAD 不返回响应体', async () => {
    let calledUrl = ''
    const fetchImpl: AmapSecurityFetch = async (url) => {
      calledUrl = url
      return new Response(null, { status: 204 })
    }
    const keyEnv = makeKeyEnv({ get: () => undefined }, { credentials: credentialEnv(), env: {} })
    const handler = makeAmapSecurityProxyHandler({ keyEnv, fetchImpl })
    const res = new FakeResponse()

    await handler(
      request(`${AMAP_SECURITY_PROXY_PATH}/v4/map/styles?style=normal`, 'HEAD'),
      responseOf(res),
    )

    expect(calledUrl).toBe('https://webapi.amap.com/v4/map/styles?style=normal&jscode=%3CMASK%3E')
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })

  it('缺 jscode / 非只读路径 / 非 GET HEAD 均不触网上游', async () => {
    let calls = 0
    const fetchImpl: AmapSecurityFetch = async () => {
      calls += 1
      return new Response('unexpected', { status: 200 })
    }
    const noKeyEnv = makeKeyEnv({ get: () => undefined }, { credentials: { resolve: async () => undefined }, env: {} })
    const handler = makeAmapSecurityProxyHandler({ keyEnv: noKeyEnv, fetchImpl })

    const missing = new FakeResponse()
    await handler(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init`), responseOf(missing))
    expect(missing.statusCode).toBe(503)

    const unsupported = new FakeResponse()
    await handler(request(`${AMAP_SECURITY_PROXY_PATH}/v2/log/init`), responseOf(unsupported))
    expect(unsupported.statusCode).toBe(404)

    const method = new FakeResponse()
    await handler(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init`, 'POST'), responseOf(method))
    expect(method.statusCode).toBe(405)
    expect(calls).toBe(0)
  })

  it('capability：缺 cookie / 过期 / provider 返回 undefined → 403 不触网；有效 token 放行', async () => {
    let calls = 0
    const fetchImpl: AmapSecurityFetch = async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    }
    const keyEnv = makeKeyEnv({ get: () => undefined }, { credentials: credentialEnv(), env: {} })
    const capability = { token: 'cap-token-1', expiresAt: Date.now() + 60_000 }
    const handler = makeAmapSecurityProxyHandler({ keyEnv, fetchImpl, capability })
    const withCookie = (token: string | undefined, expiresAt = capability.expiresAt): IncomingMessage => ({
      method: 'GET',
      url: `${AMAP_SECURITY_PROXY_PATH}/v3/log/init`,
      headers: token === undefined ? {} : { cookie: `dsh-travel-amap-capability=${token}` },
    } as unknown as IncomingMessage)

    const noCookie = new FakeResponse()
    await handler(withCookie(undefined), responseOf(noCookie))
    expect(noCookie.statusCode).toBe(403)

    const wrong = new FakeResponse()
    await handler(withCookie('other-token'), responseOf(wrong))
    expect(wrong.statusCode).toBe(403)

    const expiredHandler = makeAmapSecurityProxyHandler({ keyEnv, fetchImpl, capability: { ...capability, expiresAt: Date.now() - 1 } })
    const expired = new FakeResponse()
    await expiredHandler(withCookie('cap-token-1'), responseOf(expired))
    // 过期 handler 仍要求 cookie 但 expiresAt 已过 → 403
    expect(expired.statusCode).toBe(403)

    // provider 函数形态（生产接线：每次请求动态读取）
    let provided: { token: string; expiresAt: number } | undefined = capability
    const viaProvider = makeAmapSecurityProxyHandler({ keyEnv, fetchImpl, capability: () => provided })
    const ok = new FakeResponse()
    await viaProvider(withCookie('cap-token-1'), responseOf(ok))
    expect(ok.statusCode).toBe(200)

    provided = undefined // capability 文件缺失（过期清除后）
    const gone = new FakeResponse()
    await viaProvider(withCookie('cap-token-1'), responseOf(gone))
    expect(gone.statusCode).toBe(403)
    expect(calls).toBe(1) // 仅放行那次触网
  })

  it('限流：窗口内超 maxRequestsPerMinute → 429 + Retry-After', async () => {
    const keyEnv = makeKeyEnv({ get: () => undefined }, { credentials: credentialEnv(), env: {} })
    const handler = makeAmapSecurityProxyHandler({
      keyEnv,
      fetchImpl: async () => new Response('ok', { status: 200 }),
      maxRequestsPerMinute: 2,
    })
    const codes: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const res = new FakeResponse()
      await handler(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init?i=${i}`), responseOf(res))
      codes.push(res.statusCode)
    }
    expect(codes).toEqual([200, 200, 429])
    const limited = new FakeResponse()
    await handler(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init`), responseOf(limited))
    expect(limited.headers['retry-after']).toBe('60')
  })

  it('超时：上游挂起超过 timeoutMs → 502', async () => {
    const keyEnv = makeKeyEnv({ get: () => undefined }, { credentials: credentialEnv(), env: {} })
    const handler = makeAmapSecurityProxyHandler({
      keyEnv,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      timeoutMs: 20,
    })
    const res = new FakeResponse()
    await handler(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init`), responseOf(res))
    expect(res.statusCode).toBe(502)
  })

  it('响应大小闸门：content-length 超帽与流式超帽均 → 502 不透传', async () => {
    const keyEnv = makeKeyEnv({ get: () => undefined }, { credentials: credentialEnv(), env: {} })
    const declared = makeAmapSecurityProxyHandler({
      keyEnv,
      fetchImpl: async () => new Response('x'.repeat(16), { status: 200, headers: { 'content-length': '16' } }),
      maxResponseBytes: 8,
    })
    const declaredRes = new FakeResponse()
    await declared(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init`), responseOf(declaredRes))
    expect(declaredRes.statusCode).toBe(502)

    // 流式：声明长度合规但实际 body 超帽
    const streamed = makeAmapSecurityProxyHandler({
      keyEnv,
      fetchImpl: async () => new Response('x'.repeat(16), { status: 200 }),
      maxResponseBytes: 8,
    })
    const streamedRes = new FakeResponse()
    await streamed(request(`${AMAP_SECURITY_PROXY_PATH}/v3/log/init`), responseOf(streamedRes))
    expect(streamedRes.statusCode).toBe(502)
  })
})
