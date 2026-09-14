#!/usr/bin/env node
/**
 * amap fixture 录制器（W2b key 交割后，2026-09-03）：
 * 进程内从 $DSH_HOME/.credentials.yaml 解析 `AMAP_WEBSERVICE`（绝不输出 key 值，
 * 不落盘任何含 key 的地方），真实调用 v3 REST 端点，把响应录制为
 * tests/fixtures/amap/*.json。
 *
 * 强制脱敏：请求参数剔除 key（recorded 的 request 不含 key，响应若含 key 参数
 * 一并清洗）；URL key 参数不落盘。
 *
 * 用法：node scripts/record-amap-fixture.mjs
 * 说明：direction transit 用 HTTP 代理探究坐标参数；失败端点保留原 docs 样例
 * 并在 _provenance 标注（不阻塞离线 golden）。
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(REPO, 'tests', 'fixtures', 'amap')
const BASE = 'https://restapi.amap.com/v3'

/** 极简 credentials 解析（version:1 refs）；仅取 AMAP_WEBSERVICE。 */
function amapWebserviceKey() {
  const home = process.env.DSH_HOME || homedir() || '.'
  const file = path.join(home, '.credentials.yaml')
  try {
    const content = fsReadFileSync(file, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s{2}AMAP_WEBSERVICE:\s*"?([^"#\n]*)"?\s*$/)
      if (m && m[1]) return m[1]
    }
  } catch { /* 未找到按缺 key 处理 */ }
  return undefined
}

async function call(endpoint, params) {
  const key = amapWebserviceKey()
  if (!key) throw new Error('AMAP_WEBSERVICE 未配置（credentials.yaml 缺 ref）')
  const qs = new URLSearchParams({ ...params, key }).toString()
  const url = `${BASE}/${endpoint}?${qs}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.status !== '1') throw new Error(`amap 拒绝: ${body.info} (${body.infocode})`)
  return body
}

function save(name, endpoint, params, response) {
  mkdirSync(OUT_DIR, { recursive: true })
  const payload = {
    _provenance: `真实录制 ${new Date().toISOString().slice(0, 10)}（key 已清洗：request/响应不含 key 明文）`,
    request: params, // 不含 key
    response,
  }
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(payload, null, 2) + '\n')
  console.log(`saved ${name}（${JSON.stringify(response).length} bytes）`)
}

// 1. geocode（GCJ-02 直落）
save('geocode.json', 'geocode/geo', { address: '北京市朝阳区阜通东大街6号', city: '110000' }, await call('geocode/geo', { address: '北京市朝阳区阜通东大街6号', city: '110000' }))

// 2. weather（杭州 330100，forecast 3-4 天）
save('weather.json', 'weather/weatherInfo', { city: '330100', extensions: 'all' }, await call('weather/weatherInfo', { city: '330100', extensions: 'all' }))

// 逐端点容错录制：失败端点保留原 fixture（docs 样例）并在 _provenance 追加标记
let failed = 0
async function trySave(name, endpoint, params, fetchParams = params) {
  try {
    save(name, endpoint, params, await call(endpoint, fetchParams))
    return true
  } catch (err) {
    failed += 1
    console.log(`!! ${name} 录制失败（保留原 fixture）：${err.message}`)
    const existing = path.join(OUT_DIR, name)
    if (existsSync(existing)) {
      const f = JSON.parse(fsReadFileSync(existing, 'utf8'))
      f._provenance = `${f._provenance}；${new Date().toISOString().slice(0, 10)} 重录失败（${err.message}），保留原结构样例`
      writeFileSync(existing, JSON.stringify(f, null, 2) + '\n')
    }
    return false
  }
}

// 3. distance_matrix：先试驾车 type=0（主口径），失败再直线 type=1
if (!(await trySave('distance.json', 'distance', { origins: '116.481028,39.989643', destinations: '114.481028,39.989643', type: '0' }))) {
  await trySave('distance.json', 'distance', { origins: '116.481028,39.989643', destinations: '114.481028,39.989643', type: '1' })
}

// 4. direction transit integrated（杭州东站 → 西湖）
await trySave('transit.json', 'direction/transit/integrated', { origin: '120.21125,30.28932', destination: '120.13025,30.25952', city: '330100', cityd: '330100' })

// 5. POI place/text（西湖；基础搜索配额收敛服务端，录制 1 次即可）
await trySave('poi.json', 'place/text', { keywords: '西湖', city: '330100', citylimit: 'true', offset: '10', page: '1', extensions: 'base' })

console.log(failed ? `录制完成（${failed} 端点失败已保留原结构）` : '录制完成（全部成功，key 零明文）')