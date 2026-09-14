/**
 * 剧本 D —— 降级全流程：断 key 真实演练（加备份/恢复 guard）+ 渠道开关关闭语义。
 *
 * 演练形态（按 T10 简报批准路径）：
 *  - Phase 1 真实演练尝试：备份 ~/.dsh/.credentials.yaml → 移除 4 个 refs 行
 *    （AMAP_WEBSERVICE · AMAP_JSAPI · AMAP_JSCODE · WENDAO_APIKEY，只按 ref 名操作）
 *    → 全流程 → 恢复备份并断言复原。本会话沙箱仅授 workspace-write（宿主主目录只读）：
 *    写操作预期被拒 → 转入 **等价演练**：KeyResolutionEnv 层抑制
 *    （resolveCredential 返回 undefined + settings keys 空 + env 无 key = 模拟删除后的
 *    解析链），与 W6 验收④「删除某 Key → available()=false → degraded Key 未配置」
 *    的删除语义等价（ADR-12 settings→credentials→env 链同一判定路径）。
 *    guard：try/finally 保证任何失败路径都恢复（真实模式校验字节级复原）。
 *  - Phase 2 等价演练全流程（A 同款）：degraded[] 含「Key 未配置」逐渠道、amap 渠道
 *    skipped、腾讯 POI/12306 MCP/Open-Meteo/Leaflet 照常、render 页 warning 标注。
 *  - Phase 3 渠道开关关闭语义：TRAVEL_CHANNEL_* off → degraded「已停用（用户配置）」。
 *  - Phase 4 refs 复原断言：四 ref 名仍存在 + 真实 env available()=true（前后对比）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  EVID, makeTranscript, makeChecklist,
  zeroKeyEnv, suppressedKeyEnv, channelOffEnv, liveKeyEnv,
  buildRealAdapters, destinationDeps, transportDeps, adviceDeps,
  freshStore, bootWebServer, degradedBySource, assertDegradedContains, writeJson,
  chromeDumpDom, redactSecrets, countLinks,
} from './helpers.mjs'
import { readCredentialsRefs } from '../../tests/live-credentials.js'
import { runIntake } from '../../src/tools/intake.js'
import { runResearchDestination } from '../../src/tools/research-destination.js'
import { runResearchTransport } from '../../src/tools/research-transport.js'
import { runResearchAdvice } from '../../src/tools/research-advice.js'
import { runBuildItinerary } from '../../src/tools/build-itinerary.js'
import { runRenderPage, selectMapProvider } from '../../src/tools/render-page.js'
import { createAmapRouteProvider, createTencentRouteProvider, createEstimateRouteProvider } from '../../src/route-check.js'
import { AmapAdapter } from '../../src/adapters/amap.js'
import { WendaoAdapter } from '../../src/adapters/wendao.js'
import { Rail12306Adapter } from '../../src/adapters/rail12306.js'

const DIR = join(EVID, 'd')
const ART = join(DIR, 'artifacts')
mkdirSync(ART, { recursive: true })

const transcript = makeTranscript()
const checks = makeChecklist()

/** 四 ref 名（只按名操作，零值打印）。 */
const BLACKLIST_REFS = ['AMAP_WEBSERVICE', 'AMAP_JSAPI', 'AMAP_JSCODE', 'WENDAO_APIKEY']

function credentialsFilePath() {
  const home = process.env.DSH_HOME || homedir() || '.'
  return join(home, '.credentials.yaml')
}

async function phase0Before(store, adapters) {
  transcript.log('\n── Phase 0（before）· 真实凭据在位基线 ──')
  const refs = readCredentialsRefs()
  const present = BLACKLIST_REFS.every((ref) => typeof refs[ref] === 'string' && refs[ref].length > 0)
  checks.check(present, '四 ref 名在位（按名断言，零值）', BLACKLIST_REFS.join(','))
  const realEnv = await liveKeyEnv()
  const amap = new AmapAdapter()
  const wendao = new WendaoAdapter()
  const rail = new Rail12306Adapter()
  const amapOk = await amap.available(realEnv)
  const wendaoOk = await wendao.available(realEnv)
  const railOk = await rail.available(realEnv)
  checks.check(amapOk === true, 'before：AmapAdapter.available(真实 env)=true', String(amapOk))
  checks.check(wendaoOk === true, 'before：WendaoAdapter.available(真实 env)=true', String(wendaoOk))
  checks.check(railOk === true, 'before：Rail12306Adapter.available(真实 env)=true（免 key）', String(railOk))
  // 真实 amap 方向查询（cost 有限）：断 key 前「高德可用」的行为留证
  try {
    const { options: transferOptions } = await amap.directionTransit('杭州东站', '杭州', { city: '杭州' }, realEnv)
    checks.check(transferOptions.length > 0, 'before：高德 directionTransit 真实方案（key 在位）', `options=${transferOptions.length}`)
    transcript.log(`  before：高德 directionTransit → ${transferOptions.length} 方案（${transferOptions[0]?.durationMinutes}min）`)
  } catch (err) {
    checks.check(false, 'before：高德 directionTransit 真实方案', err instanceof Error ? err.message : String(err))
  }
  await rail.close()
  return { refs, realEnv }
}

async function phase1RealDrill() {
  transcript.log('\n── Phase 1（真实断 key 演练尝试 + guard） ──')
  const path = credentialsFilePath()
  const original = readFileSync(path, 'utf8')
  const originalLineCount = original.split(/\r?\n/).length
  const blacklisted = BLACKLIST_REFS.filter((ref) => {
    const m = original.match(new RegExp(`^\\s{2}${ref.replace('/', '\\/')}:`, 'm'))
    return m !== null
  })
  checks.check(blacklisted.length === 4, '备份基线：四 ref 行均存在（按名）', `found=${blacklisted.join(',')}`)
  // 备份快照只归档「ref 名 + 行数」，绝不含值（零明文纪律）
  writeJson(join(DIR, 'backup-snapshot.json'), { path, originalLineCount, refNames: BLACKLIST_REFS, note: '备份内容不含 key 值（零明文）；恢复校验=字节级比对' })
  transcript.log(`  creds=${path} 原始行数=${originalLineCount} refNames=${BLACKLIST_REFS.join(',')}`)

  // guard：try/finally 任何路径都恢复；仅在我们确实改写后才写回。
  let wrote = false
  try {
    writeFileSync(path, original.replace(/(^[ \t]*)(AMAP_WEBSERVICE|AMAP_JSAPI|AMAP_JSCODE|WENDAO_APIKEY)(:.*)$/gm, ''))
    wrote = true
    transcript.log('  [真实演练] 四 ref 行已从文件移除（沙箱放行）')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    transcript.log(`  [真实演练] 写 ~/.dsh/.credentials.yaml 被拒（沙箱 workspace-write 权限）：${msg.slice(0, 120)}`)
    transcript.log('  → 按简报批准路径转入等价演练（KeyResolutionEnv 层抑制 + W6 验收④等价语义声明）')
    writeJson(join(DIR, 'real-drill.txt'), {
      attempted: true, allowed: false, error: msg.slice(0, 300),
      equivalence: 'KeyResolutionEnv 层抑制（resolveCredential→undefined + settings keys 空 + env 无 key）= ADR-12 链删 key 后状态；与 W6 验收④（删除某 Key→available()=false→degraded「Key 未配置」）同判定路径（tests/adapters-env.test.ts「FR-8④」）',
      refNames: BLACKLIST_REFS,
    })
  } finally {
    if (wrote) {
      writeFileSync(path, original)
      const restored = readFileSync(path, 'utf8')
      if (restored !== original) {
        throw new Error('恢复失败：credentials 文件与原始字节不一致（中止演练，防止真 refs 受损）')
      }
    }
  }
  checks.check(true, 'guard 执行：任何失败路径均已恢复/未改写', wrote ? '已写回并字节校验' : '未改写（等价模式）')
  return wrote
}

async function phase2EquivalentFlow(store) {
  transcript.log('\n── Phase 2（等价演练）· 断 key 全流程（A 同款：intake→三 research→build→render） ──')
  const adapters = buildRealAdapters(suppressedKeyEnv())
  const intake = await runIntake({ slots: { origin: '北京', destination: '杭州', dateStart: '2026-09-16', dateEnd: '2026-09-18', days: 3, travelers: { adults: 2 } } }, store)
  const planId = intake.planId
  transcript.log(`  intake → ${intake.status} planId=${planId}`)

  const dest = await runResearchDestination({ planId, categories: ['attraction', 'lodging', 'food', 'transportLocal', 'tip', 'warning', 'recommend'] }, store, destinationDeps(adapters))
  const intel = (await store.readJson(planId, 'intel.json')) ?? []
  const cats = new Set(intel.map((i) => i.category))
  const poiItems = intel.filter((i) => i.channel === 'tencent-poi')
  transcript.log(`  research_destination → itemCount=${dest.itemCount} categories=${[...cats].join(',')} 腾讯 POI 条目=${poiItems.length}`)
  checks.check(dest.itemCount > 0 && cats.size >= 6, '断 key 后 research_destination 照常产出（7 类 ≥6/7）', `cats=${[...cats].join(',')}`)
  checks.check(poiItems.length > 0, '腾讯 POI（零 key）不受断 key 影响', `poi=${poiItems.length}`)

  const transport = await runResearchTransport({ planId }, store, transportDeps(adapters))
  const railWithPrice = transport.options.filter((o) => o.mode === 'rail' && o.totalPriceRange)
  transcript.log(`  research_transport → options=${transport.options.length} rail 含价格档=${railWithPrice.length} cityTransfer=${transport.cityTransfer?.provider ?? '（无）'}`)
  checks.check(railWithPrice.length >= 1, '断 key 后 12306 MCP 照常（真实班次+价格档）', `rail 含价=${railWithPrice.length}`)
  checks.check(transport.cityTransfer === undefined, 'amap 市内衔接渠道 skipped（cityTransfer 缺失）', '')
  assertDegradedContains(transport.degraded, 'cityAmap', 'Key 未配置', checks, 'cityAmap degraded「Key 未配置」')
  assertDegradedContains(transport.degraded, 'intercity/wendao', 'Key 未配置', checks, 'wendao/rail 休眠记账（intercity/wendao「Key 未配置」）')

  const advice = await runResearchAdvice({ planId }, store, adviceDeps(adapters))
  transcript.log(`  research_advice → weather=${advice.weather.length}（来源：${[...new Set(advice.weather.map((w) => w.source.platform))].join(',')}）packing=${advice.packingList.length}`)
  checks.check(advice.weather.length > 0, '断 key 后天气照常（腾讯/Open-Meteo 零 key 链）', `sources=${advice.weather.map((w) => w.source.platform).join(',')}`)
  assertDegradedContains(advice.degraded, 'weatherAmap', 'Key 未配置', checks, 'weatherAmap degraded「Key 未配置」')

  const built = await runBuildItinerary({ planId }, store, {
    providers: [createAmapRouteProvider(adapters.amap), createTencentRouteProvider(adapters.tencent), createEstimateRouteProvider()],
    keyEnv: adapters.env,
  })
  checks.check(built.built === true, '断 key 后 build 照常（routeCheck 腾讯/估算链）', `days=${built.days.length} issues=${built.routeCheck.issues.length}`)

  const { registrar } = await bootWebServer()
  const rendered = await runRenderPage({ planId, mapProvider: 'auto' }, store, registrar, adapters.env)
  transcript.log(`  render → ${rendered.mapProviderUsed} warnings=${JSON.stringify(rendered.warnings)}`)
  checks.check(rendered.rendered === true && rendered.mapProviderUsed === 'leaflet', '断 key 后 render 降级 Leaflet', `provider=${rendered.mapProviderUsed}`)
  checks.check(rendered.warnings.some((w) => w.includes('key 未配置')), 'render 页 warning 标注（amap JSAPI key 未配置）', rendered.warnings.join('；'))
  const dom = chromeDumpDom('file://' + rendered.filePath, redactSecrets)
  if (dom.ok) {
    const links = countLinks(dom.dom)
    writeFileSync(join(DIR, 'dom-d.html'), dom.dom)
    checks.check(links > 0, '断 key 页面 headless DOM 有可点击链接', `a[href]=${links}`)
  } else {
    checks.check(false, '断 key 页面 headless DOM', dom.stderr)
  }
  const degraded = (await store.loadDegraded(planId)) ?? []
  writeJson(join(DIR, 'degraded-after.json'), degraded)
  transcript.log(`  degraded[] 汇总（${degraded.length} 条）：${JSON.stringify(degradedBySource(degraded))}`)
  const keyReasons = degraded.filter((d) => d.reason.includes('Key 未配置') || d.reason.includes('未配置'))
  checks.check(keyReasons.length >= 2, 'degraded[] 含「Key 未配置」逐渠道（≥2 条）', keyReasons.map((d) => `${d.source}`).join(','))
  for (const name of ['request.json', 'intel.json', 'transport.json', 'advice.json', 'itinerary.json']) {
    const src = join(store.root, '.dsh-travel', planId, name)
    if (existsSync(src)) writeFileSync(join(ART, `after-${name}`), readFileSync(src, 'utf8'))
  }
  return { planId, degraded }
}

async function phase3ChannelOff(store) {
  transcript.log('\n── Phase 3 · 渠道开关关闭语义（TRAVEL_CHANNEL_* off） ──')
  const offEnv = channelOffEnv(['tencent-poi', 'rail12306', 'weatherOpenMeteo', 'mapAmap'])
  const adapters = buildRealAdapters(offEnv)
  const intake = await runIntake({ slots: { origin: '北京', destination: '杭州', dateStart: '2026-09-16', dateEnd: '2026-09-18', days: 3 } }, store)
  const planId = intake.planId
  const dest = await runResearchDestination({ planId, categories: ['attraction', 'food', 'recommend'] }, store, destinationDeps(adapters))
  assertDegradedContains(dest.degraded, 'tencent-poi', '已停用（用户配置）', checks, 'tencent-poi 关闭 → degraded「已停用（用户配置）」')
  const intel = (await store.readJson(planId, 'intel.json')) ?? []
  checks.check(!intel.some((i) => i.channel === 'tencent-poi'), 'tencent-poi 关闭 → 无该渠道条目', `poiItems=${intel.filter((i) => i.channel === 'tencent-poi').length}`)

  const rail = new Rail12306Adapter()
  checks.check((await rail.available(offEnv)) === false, 'rail12306 开关关闭 → available()=false', '')
  await rail.close()

  const transport = await runResearchTransport({ planId, modes: ['rail'] }, store, transportDeps(adapters))
  assertDegradedContains(transport.degraded, 'rail12306', '已停用（用户配置）', checks, 'rail12306 关闭 → transport degraded「已停用（用户配置）」')

  const advice = await runResearchAdvice({ planId }, store, adviceDeps(adapters))
  assertDegradedContains(advice.degraded, 'weatherOpenMeteo', '已停用（用户配置）', checks, 'weatherOpenMeteo 关闭 → degraded「已停用（用户配置）」')

  // mapAmap 关闭 → selectMapProvider 语义（走 makeKeyEnv mock 判定）
  const sel = await selectMapProvider('auto', offEnv)
  checks.check(sel.provider === 'leaflet' && sel.warnings.some((w) => w.includes('mapAmap 已停用（用户配置）')), 'mapAmap 关闭 → Leaflet + 「已停用（用户配置）」warning', sel.warnings.join('；'))
  const degraded = (await store.loadDegraded(planId)) ?? []
  writeJson(join(DIR, 'degraded-channeloff.json'), degraded)
  return { planId, degraded }
}

async function phase4Restore() {
  transcript.log('\n── Phase 4（restore）· refs 复原断言 ──')
  const refs = readCredentialsRefs()
  const present = BLACKLIST_REFS.every((ref) => typeof refs[ref] === 'string' && refs[ref].length > 0)
  checks.check(present, 'restore：四 ref 仍齐全（按名，零值）', BLACKLIST_REFS.join(','))
  const realEnv = await liveKeyEnv()
  const amapOk = await new AmapAdapter().available(realEnv)
  const wendaoOk = await new WendaoAdapter().available(realEnv)
  checks.check(amapOk === true, 'restore：AmapAdapter.available(真实 env)=true', String(amapOk))
  checks.check(wendaoOk === true, 'restore：WendaoAdapter.available(真实 env)=true', String(wendaoOk))
  // 前后对比存档
  writeJson(join(DIR, 'before-after.json'), {
    before: { amapAvailable: 'true（真实 key）', wendaoAvailable: 'true', refsPresent: BLACKLIST_REFS },
    after: { amapAvailable: String(amapOk), wendaoAvailable: String(wendaoOk), refsPresent: present },
    note: '等价演练模式：真实 refs 全程未改写（guard 校验）；断 key 效果在 KeyResolutionEnv 解析层实现',
  })
}

async function main() {
  transcript.log('## 剧本 D · 降级全流程：断 key 真实演练（备份/恢复 guard）+ 渠道开关关闭语义')
  const store = freshStore('d')
  try {
    const { refs } = await phase0Before(store, null)
    const wrote = await phase1RealDrill()
    const after = await phase2EquivalentFlow(store)
    const off = await phase3ChannelOff(store)
    await phase4Restore()
    checks.check(after.degraded.length > 0, '断 key 全流程仍产出（degraded 汇总非空）', `degraded=${after.degraded.length} 条`)
    transcript.log('\n[剧本 D] 前后对比：')
    transcript.log('  before：高德 directionTransit 真实方案 / available()=true / 无 Key 未配置记账')
    transcript.log(`  after ：${JSON.stringify(degradedBySource(after.degraded))}`)
    transcript.log(`  channelOff：${JSON.stringify(degradedBySource(off.degraded))}`)
  } finally {
    // guard 兜底：无论何种失败路径，都再次断言 refs 未被破坏
    const refs = readCredentialsRefs()
    if (!BLACKLIST_REFS.every((ref) => typeof refs[ref] === 'string' && refs[ref].length > 0)) {
      transcript.log('[guard] 严重：refs 缺失！不得继续。')
      checks.check(false, 'guard：refs 完整性（终局校验）', '缺失')
    } else {
      checks.check(true, 'guard：refs 完整性（终局校验）', '四 ref 齐全')
    }
  }
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  writeJson(join(DIR, 'summary.json'), { script: 'D', equivalance: 'KeyResolutionEnv 层抑制（等价 W6 验收④）' })
  transcript.log(`\n[剧本 D] PASS=${checks.entries.filter((e) => e.ok).length} FAIL=${checks.entries.filter((e) => !e.ok).length}`)
  process.exit(checks.allPass() ? 0 : 1)
}

main().catch((err) => {
  console.error('[剧本 D] 失败：', err)
  transcript.write(join(DIR, 'transcript.txt'))
  checks.write(join(DIR, 'checks.txt'))
  process.exit(1)
})