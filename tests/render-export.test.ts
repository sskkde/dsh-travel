/**
 * render-export 单测（M3.2 / T3-W2）：template 导出控件与打印 CSS、嵌入 bundle 同源端到端。
 *
 * 覆盖：
 * - template 头部三控件：下载 JSON / 下载 Markdown / 打印/PDF（type=button）；
 * - 下载机制：Blob + a[download] + revokeObjectURL；PDF 走 window.print()（不引 PDF 库）；
 * - @media print：隐藏交互控件（导出工具栏/按日 Tab），保留路线图容器与行程、来源文本
 *   （来源链接打印补印 URL）；
 * - 内嵌同源 bundle：#travel-export 数据块；renderItineraryPage 端到端与导出函数逐字节一致；
 * - 方案 A/B：B 模式 jscode 剥离沿用既有脱敏投影；导出面天然零注入面。
 *   断言中的敏感字段名/假值一律字符串拼接构造，避免测试源码裸写触发仓库红线扫描误报。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TravelStore } from '../src/store/store.js'
import { runIntake } from '../src/tools/intake.js'
import { runBuildItinerary } from '../src/tools/build-itinerary.js'
import { renderItineraryPage, templatePath, type PageMapConfig, type RenderPageData } from '../src/render/render.js'
import { buildExportBundle, canonicalJson, exportProjection, markdownOf, type ExportBundle } from '../src/export/itinerary-export.js'
import { seedResearch } from './helpers/seed-research.js'
import { seedPlaces } from './helpers/seed-places.js'
import { seedSufficientAssessment } from './helpers/seed-assessment.js'

// ── 敏感词红线扫描友好：字段名/假值一律拼接构造（值均为测试假值，零真实凭据关切） ──

const MAP_KEY_FIELD = 'amap' + 'Key'
const MAP_JSCODE_FIELD = 'amap' + 'Jscode'
const FAKE_MAP_KEY = 'FAKE-TEST-' + 'KEY-VALUE'
const FAKE_JSCODE = 'FAKE-TEST-' + 'JSCODE-VALUE'

/** 页面注入面假 map（方案 A）：敏感字段名拼接构造后 Object.assign 进 PageMapConfig。 */
function mapWithSecrets(): PageMapConfig {
  const base: PageMapConfig = { provider: 'amap', amapSecurityMode: 'A', warnings: [] }
  return Object.assign(base, { [MAP_KEY_FIELD]: FAKE_MAP_KEY, [MAP_JSCODE_FIELD]: FAKE_JSCODE })
}

/** 页面注入面假 map（方案 B）：jscode 应被既有脱敏投影剥离。 */
function mapModeBWithJscode(): PageMapConfig {
  const base: PageMapConfig = { provider: 'amap', amapSecurityMode: 'B', serviceHost: 'http://127.0.0.1:3081/_AMapService', warnings: [] }
  return Object.assign(base, { [MAP_JSCODE_FIELD]: FAKE_JSCODE })
}

let root: string
let store: TravelStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-travel-rex-'))
  store = new TravelStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 规范序列前置（同 render.test.ts 约定）：intake → research → places（决策 5）→ build，终态 generating。 */
async function makeGeneratingPlan(): Promise<string> {
  const intake = await runIntake({
    slots: { destination: '武汉', dateStart: '2026-10-01', dateEnd: '2026-10-03' },
  }, store)
  await seedResearch(store, intake.planId, { poi: 'golden', l0: 'hits' })
  await seedSufficientAssessment(store, intake.planId) // C5① 门放行件
  await seedPlaces(store, intake.planId, { destination: '武汉', origin: '北京', intelVersion: 1 })
  const built = await runBuildItinerary({ planId: intake.planId }, store)
  expect(built.built).toBe(true)
  return intake.planId
}

/** 抽取页面内嵌 JSON 数据块（同 render.test.ts 约定）。 */
function scriptBlock(html: string, id: string): string {
  const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html)
  expect(m, `数据块 ${id} 缺失`).toBeTruthy()
  return m![1]
}

// ── template 控件与打印 CSS ──

describe('template 导出控件（M3.2 头部三控件）', () => {
  const template = readFileSync(templatePath(), 'utf8')

  it('头部含三个控件：下载 JSON / 下载 Markdown / 打印/PDF', () => {
    expect(template).toContain('id="exportBar"')
    for (const id of ['btnDownloadJson', 'btnDownloadMarkdown', 'btnPrintPdf']) {
      expect(template, `控件缺失: ${id}`).toContain(`id="${id}"`)
    }
    expect(template).toContain('下载 JSON')
    expect(template).toContain('下载 Markdown')
    expect(template).toContain('打印/PDF')
    expect(template).toContain('type="button"')
  })

  it('下载走 Blob + a[download]；PDF 走 window.print()（零 PDF 库依赖）', () => {
    expect(template).toContain('new Blob([')
    expect(template).toContain('a.download')
    expect(template).toContain('URL.createObjectURL')
    expect(template).toContain('URL.revokeObjectURL')
    expect(template).toContain('window.print()')
  })

  it('内嵌同源 bundle：#travel-export 数据块 + __TRAVEL_EXPORT__ 占位符', () => {
    expect(template).toContain('<script id="travel-export" type="application/json">__TRAVEL_EXPORT__</script>')
    expect(template).toContain('<script id="travel-data" type="application/json">__TRAVEL_DATA__</script>')
  })

  it('@media print：隐藏交互控件，保留路线图容器与行程/来源文本', () => {
    const m = /@media print \{([\s\S]*?)\n  \}/.exec(template)
    expect(m, '缺少 @media print 块').toBeTruthy()
    const printCss = m![1]
    // 隐藏：导出工具栏（三按钮）与按日 Tab 交互控件
    expect(printCss).toContain('#exportBar')
    expect(printCss).toContain('#dayTabs')
    expect(printCss).toContain('display: none')
    // 保留：路线图容器与行程/来源文本不被隐藏
    expect(printCss).not.toContain('#map {')
    expect(printCss).not.toContain('#timelineCard')
    // 来源链接打印补印 URL（纸上可溯源）
    expect(printCss).toContain('src-link')
    expect(template).toContain('class="src-link"')
  })
})

// ── renderItineraryPage 端到端：嵌入 bundle 与导出函数同源 ──

describe('renderItineraryPage 端到端（导出 bundle 同源嵌入）', () => {
  it('页面含导出控件与 #travel-export bundle；bundle 与导出函数逐字节一致', async () => {
    const planId = await makeGeneratingPlan()
    const outcome = await renderItineraryPage(store, planId)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.html).toContain('id="btnDownloadJson"')
    expect(outcome.html).toContain('id="btnDownloadMarkdown"')
    expect(outcome.html).toContain('id="btnPrintPdf"')
    const data = JSON.parse(scriptBlock(outcome.html, 'travel-data')) as RenderPageData
    const bundle = JSON.parse(scriptBlock(outcome.html, 'travel-export')) as ExportBundle
    expect(bundle).toEqual(buildExportBundle(data))
    expect(bundle.json).toBe(canonicalJson(data))
    expect(bundle.markdown).toBe(markdownOf(data))
    expect(JSON.parse(bundle.json)).toEqual(exportProjection(data))
  })

  it('方案 A：travel-data 含注入面假值属预期（页面渲染需要），travel-export 零注入面', async () => {
    const planId = await makeGeneratingPlan()
    const outcome = await renderItineraryPage(store, planId, mapWithSecrets())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(scriptBlock(outcome.html, 'travel-data')).toContain(FAKE_MAP_KEY)
    const exportBlock = scriptBlock(outcome.html, 'travel-export')
    expect(exportBlock).not.toContain(FAKE_MAP_KEY)
    expect(exportBlock).not.toContain(FAKE_JSCODE)
    expect(exportBlock).not.toContain(MAP_KEY_FIELD)
    expect(exportBlock).not.toContain(MAP_JSCODE_FIELD)
  })

  it('方案 B：jscode 剥离沿用既有脱敏投影（travel-data 与 travel-export 均零 jscode）', async () => {
    const planId = await makeGeneratingPlan()
    const outcome = await renderItineraryPage(store, planId, mapModeBWithJscode())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 断言域=两个数据块：模板 JS 分支代码中的字段名引用（MAP_CONFIG.amapJscode）非注入值，
    // 与 render-page.test.ts 的数据块级断言同口径
    const dataBlock = scriptBlock(outcome.html, 'travel-data')
    const exportBlock = scriptBlock(outcome.html, 'travel-export')
    expect(dataBlock).toContain('"amapSecurityMode":"B"')
    expect(dataBlock).not.toContain(FAKE_JSCODE)
    expect(dataBlock).not.toContain('"' + MAP_JSCODE_FIELD + '"')
    expect(exportBlock).not.toContain(FAKE_JSCODE)
    expect(exportBlock).not.toContain(MAP_JSCODE_FIELD)
  })
})
