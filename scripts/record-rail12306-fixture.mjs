#!/usr/bin/env node
/**
 * rail12306 fixture 录制器（真实 MCP 只读查询 → tests/fixtures/rail12306/）
 * 用法：node scripts/record-rail12306-fixture.mjs [date]
 * 只调用只读白名单工具；输出 fixture JSON：{tool, arguments, recordedAt, result}
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:8123/mcp'
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'rail12306')
const date = process.argv[2] ?? new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10)
let sessionId

async function post(payload) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    return text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)) } catch { return null } }).filter(Boolean)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function callTool(tool, args) {
  const resp = await post({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } })
  const msg = Array.isArray(resp) ? resp[0] : resp
  const text = msg?.result?.content?.[0]?.text
  if (!text) throw new Error(`tools/call ${tool} 无文本结果: ${JSON.stringify(msg).slice(0, 300)}`)
  return JSON.parse(text)
}

function save(name, tool, args, result) {
  const payload = { tool, arguments: args, recordedAt: new Date().toISOString(), result }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(payload, null, 2) + '\n')
  console.log(`saved ${name} (${JSON.stringify(result).length} bytes)`)
}

// 握手
await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-travel-recorder', version: '0.0.1' } } })
await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

// 只读工具录制（白名单：query-tickets / query-ticket-price / search-stations / get-current-time）
const tickets = await callTool('query-tickets', { from_station: '北京', to_station: '上海', train_date: date })
save('query-tickets.json', 'query-tickets', { from_station: '北京', to_station: '上海', train_date: date }, tickets)

const price = await callTool('query-ticket-price', { from_station: '北京', to_station: '上海', train_date: date, train_code: tickets.trains?.[0]?.train_no })
save('query-ticket-price.json', 'query-ticket-price', { from_station: '北京', to_station: '上海', train_date: date, train_code: tickets.trains?.[0]?.train_no }, price)

const stations = await callTool('search-stations', { query: '杭州东', limit: 5 })
save('search-stations.json', 'search-stations', { query: '杭州东', limit: 5 }, stations)

const now = await callTool('get-current-time', {})
save('get-current-time.json', 'get-current-time', {}, now)
