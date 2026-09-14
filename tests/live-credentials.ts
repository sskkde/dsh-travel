/**
 * live smoke 凭据助手（仅 TRAVEL_LIVE_SMOKE=1 时使用）：
 * 进程内读取 $DSH_HOME/.credentials.yaml（version:1 refs map），把编排者约定的
 * Key 标识符（amapWebservice/amapJsapi/amapJscode/wendao）映射为 ref
 * （AMAP_WEBSERVICE · AMAP_JSAPI · AMAP_JSCODE · WENDAO_APIKEY），返回 base.ts
 * resolveKey 链的 credentials 层回调（resolveCredential）。
 *
 * 零明文纪律：本文件只含解析逻辑，不包含也绝不输出任何 key 值；
 * 解析器用最小正则（不上 YAML 依赖），未命中 ref 返回 undefined。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { KeyResolutionEnv } from '../src/adapters/base.js'

/** 编排者约定：Key 标识符 → credentials ref（design §10.2 + base resolveKey 链）。 */
export const IDENTIFIER_TO_REF: Record<string, string> = {
  amapWebservice: 'AMAP_WEBSERVICE',
  amapJsapi: 'AMAP_JSAPI',
  amapJscode: 'AMAP_JSCODE',
  wendao: 'WENDAO_APIKEY',
  didi: 'DIDI_MCPKEY',
}

function credentialsPath(): string {
  const home = process.env.DSH_HOME || homedir() || '.'
  return path.join(home === '.' ? home : home, '.credentials.yaml')
}

/**
 * 极简 version:1 refs 解析：`  <ref>: "<value>"` 或 `  <ref>: <value>` 行。
 * 返回 ref → value 映射；文件缺失/解析失败返回空对象（https 不炸 live smoke，
 * 失败由可用性降级路径暴露）。
 */
export function readCredentialsRefs(): Record<string, string> {
  let content: string
  try {
    content = readFileSync(credentialsPath(), 'utf8')
  } catch {
    return {}
  }
  const refs: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s{2}([A-Za-z0-9/._-]+):\s*"?([^"#\n]*)"?\s*$/)
    if (m && m[1] !== 'version' && m[1] !== 'refs') refs[m[1]] = m[2]
  }
  return refs
}

/**
 * 构造 resolveKey 链的 credentials 层环境：resolveCredential(标识符) → ref → 值。
 * 失败（文件缺失/映射未命中/值为空）返回 undefined 段（不会抛）。
 */
export async function liveCredentialsEnv(identifiers: string[]): Promise<KeyResolutionEnv | undefined> {
  const refs = readCredentialsRefs()
  const usable = identifiers.some((id) => {
    const ref = IDENTIFIER_TO_REF[id]
    return ref !== undefined && typeof refs[ref] === 'string' && refs[ref].length > 0
  })
  if (!usable) return undefined
  return {
    resolveCredential: async (identifier: string) => {
      const ref = IDENTIFIER_TO_REF[identifier]
      if (!ref) return undefined
      const value = refs[ref]
      return value && value.length > 0 ? value : undefined
    },
  }
}