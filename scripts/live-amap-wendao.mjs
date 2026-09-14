#!/usr/bin/env node
/**
 * amap/wendao live 复验（QA 剧本，真实 key，零明文输出）：
 * 1) amap.directionTransit('杭州东站','西湖') 地名 → 前置地理编码 → transit
 *    断言：routes/options 在场，options[0] 含耗时与票价 hint
 * 2) wendao.query('查询2026年10月1日北京到上海的高铁票') → 结构化条目 + 深链
 *
 * Key 纪律：进程内解析 $DSH_HOME/.credentials.yaml（identifier→ref），
 * 控制台/日志/证据只输出业务结果，绝不输出 key 值。
 * 运行：先 `npx tsc -p tsconfig.json`（产出 lib/），再 `node scripts/live-amap-wendao.mjs`
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AmapAdapter } from '../lib/adapters/amap.js'
import { WendaoAdapter } from '../lib/adapters/wendao.js'

/** 编排者约定 identifier → ref。 */
const IDENTIFIER_TO_REF = {
  amapWebservice: 'AMAP_WEBSERVICE',
  amapJsapi: 'AMAP_JSAPI',
  amapJscode: 'AMAP_JSCODE',
  wendao: 'WENDAO_APIKEY',
}

function credentialsEnv() {
  const home = process.env.DSH_HOME || homedir() || '.'
  const file = path.join(home, '.credentials.yaml')
  const refs = {}
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s{2}([A-Za-z0-9/._-]+):\s*"?([^"#\n]*)"?\s*$/)
      if (m && m[1] !== 'version' && m[1] !== 'refs') refs[m[1]] = m[2]
    }
  } catch { /* 缺文件按未配置 */ }
  return {
    resolveCredential: async (identifier) => {
      const ref = IDENTIFIER_TO_REF[identifier]
      const value = ref ? refs[ref] : undefined
      return value && value.length > 0 ? value : undefined
    },
  }
}

const env = credentialsEnv()

// 1) amap direction transit（地名前置地理编码）
const amap = new AmapAdapter()
const { routes, options, degraded } = await amap.directionTransit('杭州东站', '西湖', { city: '330100', cityd: '330100' }, env)
console.log('== amap directionTransit 杭州东站→西湖（地名）==')
console.log('routes:', routes.length, '| degraded:', degraded.length ? JSON.stringify(degraded.map((d) => d.reason)) : '无')
if (options.length) {
  console.log('options[0]:', JSON.stringify(options[0]))
  console.log('assert 耗时>0:', options[0].durationMinutes > 0 ? 'PASS' : 'FAIL')
  console.log('assert 票价 hint:', options[0].priceHint ? 'PASS' : 'FAIL')
} else {
  console.log('options: 空 —— FAIL')
}

// 2) wendao 高铁票（QA 口径）
const wendao = new WendaoAdapter()
const result = await wendao.query('查询2026年10月1日北京到上海的高铁票', env)
console.log('== wendao.query（2026-10-01 北京→上海高铁票）==')
console.log('entries:', result.entries.length, '| sections:', [...new Set(result.entries.map((e) => e.section))].slice(0, 6).join(' / '))
console.log('深链条目数:', result.entries.filter((e) => e.deepLinks.length > 0).length)
console.log('首条 title:', result.entries[0] ? result.entries[0].title.slice(0, 60) : '(空)')
if (result.entries.length === 0) {
  console.log('wendao 空结果 —— FAIL')
  process.exitCode = 1
}