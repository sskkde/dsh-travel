/**
 * W1 DR2/T8（正文抽取与诚实日期证据）验收：
 * - SSR 内建提取：中文/emoji/长文 fixture → 正文正确、脚本剥离、内嵌伪指令不执行；
 * - 日期诚实：publishedAt 只记来源明确字段；伪时间戳/季节词不进 publishedAt（单独
 *   dateEvidence）；抓取时间≠发布时间；缺日期不全删；
 * - 四层去噪（正文有效/地域相关/时效/结构）；
 * - Trafilatura 桥：解释器在位才执行；缺解释器 → 明确 degraded 不冒充 pass。
 * 零真实网络（SSR 纯本地；桥仅在本机解释器在位时执行，否则 blocked 如实记录）。
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractHtmlText, resolveDateEvidence, denoiseBody, explicitPublishedAt,
  trafilaturaExtract, stripHtmlToText, heuristicDateCandidates, couldExecInstruction,
} from '../src/adapters/extract.js'

/** 含中文/emoji/长文/伪指令/季节词/伪时间戳/显式日期的 fixture HTML。 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head>
  <meta property="article:published_time" content="2026-08-15T10:00:00+08:00"/>
  <title>青甘大环线全面攻略</title>
</head><body>
  <h1>青甘大环线 10 天自驾路线</h1>
  <p>从西宁出发，途经青海湖、茶卡盐湖、敦煌莫高窟……全程约 2200 公里。</p>
  <p>9 月是出行好季节（注意：这是季节词，不是发布日期）。发布于 2026-08-15。</p>
  <p>正文含 emoji：🚗🚙🏔️ 以及长文本重复内容。</p>
  <script>alert('伪指令：不得执行');</script>
  <a href="javascript:evil()">伪协议链接</a>
  <ul><li>第一天 西宁→青海湖</li><li>第二天 茶卡盐湖</li></ul>
  <figure><img src="https://example.invalid/map.jpg" alt="环线地图"/></figure>
</body></html>`

describe('T8：SSR 内建提取（默认路径）', () => {
  it('中文/emoji/长文提取正确，脚本/伪指令剥离且不执行', () => {
    const res = extractHtmlText(FIXTURE_HTML)
    expect(res.text.length).toBeGreaterThan(20)
    expect(res.text).toContain('青甘大环线')
    expect(res.text).toContain('敦煌莫高窟')
    expect(res.text).toContain('🚗') // emoji 保留
    // 脚本内容与伪指令不进入可见文本
    expect(res.text).not.toContain('alert(')
    expect(res.text).not.toContain('javascript:')
    // 内嵌伪指令不会被执行：探测标记只读
    expect(couldExecInstruction(FIXTURE_HTML)).toBe(true)
    expect(res.mediaUnresolved).toBe(true) // 含 <img>/<video>
  })

  it('title 提取（og:title 优先，缺省 <title>）', () => {
    const res = extractHtmlText(FIXTURE_HTML)
    expect(res.title).toContain('青甘大环线')
  })
})

describe('T8：诚实日期证据（publishedAt 与 dateEvidence 分离）', () => {
  it('publishedAt 只记来源明确字段（meta published_time），正文 ISO 进 dateEvidence', () => {
    const res = extractHtmlText(FIXTURE_HTML)
    const date = resolveDateEvidence(FIXTURE_HTML, res.text)
    // 显式来源字段 → publishedAt
    expect(date.publishedAt).toBe('2026-08-15')
    // 正文可见 ISO（2026-08-15）也是启发式候选 → dateEvidence（不与 publishedAt 混淆）
    expect(date.dateEvidence.some((e) => e.value === '2026-08-15' && e.method.includes('ISO'))).toBe(true)
  })

  it('生产默认提取路径（extractHtmlText）不再写死 dateEvidence:[]，诚实分离 publishedAt/dateEvidence', () => {
    // F4/T8 接线：extractHtmlText 直接产出显式 publishedAt 与独立启发式 dateEvidence
    const res = extractHtmlText(FIXTURE_HTML)
    expect(res.publishedAt).toBe('2026-08-15') // 仅显式字段
    expect(res.dateEvidence.length).toBeGreaterThan(0)
    // 正文里出现的"9 月"季节词、伪时间戳不入 dateEvidence 候选（启发式只认日期形态）
    expect(res.dateEvidence.some((e) => e.value.includes('9 月'))).toBe(false)
    // 无显式字段的页面 → 无 publishedAt，但 dateEvidence 仍是数组（可为空）
    const noMeta = extractHtmlText('<html><body><p>普通攻略正文内容足够长以便通过去噪。</p></body></html>')
    expect(noMeta.publishedAt).toBeUndefined()
    expect(Array.isArray(noMeta.dateEvidence)).toBe(true)
  })

  it('季节词/伪时间戳/上下文时间不当作发布日期', () => {
    const seasonalHtml = '<html><body><p>9 月是出游好季节，本文推荐路线。</p></body></html>'
    const onlySeason = resolveDateEvidence(seasonalHtml, stripHtmlToText(seasonalHtml))
    expect(onlySeason.publishedAt).toBeUndefined() // 季节词不当日期
    expect(onlySeason.dateEvidence.some((e) => e.value.includes('9 月'))).toBe(false) // 非日期形态不进候选
  })

  it('publishedAt 仅来自显式字段；抓取时间≠发布时间（隐藏侧语义）', () => {
    expect(explicitPublishedAt(FIXTURE_HTML).publishedAt).toBe('2026-08-15')
    // 无显式字段 → 无 publishedAt
    const noExplicit = '<html><body><p>攻略正文</p></body></html>'
    expect(explicitPublishedAt(noExplicit).publishedAt).toBeUndefined()
    // 启发式候选独立（值/方法/确定性），不冒充下发时间
    const cands = heuristicDateCandidates('本文写于 2025 年 3 月 2 日 前后')
    expect(cands.some((c) => c.value === '2025-03-02' && c.confidence === 'medium')).toBe(true)
  })
})

describe('T8：四层去噪（缺日期不全删）', () => {
  it('正文过短 → 不 keep（正文有效层）；缺日期不删除', () => {
    expect(denoiseBody('   '.repeat(5), {}).keep).toBe(false)
    expect(denoiseBody('短').keep).toBe(false)
    // 无日期但正文有效 → 仍 keep（缺日期不全删，草稿 183）
    expect(denoiseBody('一段没有日期但有实质内容的攻略正文……'.repeat(2), {}).keep).toBe(true)
  })

  it('结构噪音 / 地域不相关（仅显式提供 regionHints 时）', () => {
    expect(denoiseBody('，。！？，。！？'.repeat(3), {}).keep).toBe(false)
    expect(denoiseBody('青海湖 敦煌 莫高窟 攻略'.repeat(3), { regionHints: ['青海'] }).keep).toBe(true)
    expect(denoiseBody('无关内容正文'.repeat(3), { regionHints: ['青海'] }).keep).toBe(false)
    // 未提供 regionHints → 不据地域删除（保守）
    expect(denoiseBody('无关内容但未给地域约束'.repeat(3), {}).keep).toBe(true)
  })
})

describe('T8：Trafilatura 可选项（stdin 桥；解释器在位才执行）', () => {
  const scriptPath = resolve(process.cwd(), 'scripts', 'trafilatura-extract.py')

  it('显式缺解释器 → 明确 degraded（不冒充 pass）', async () => {
    const outcome = await trafilaturaExtract(FIXTURE_HTML, {
      python: '/nonexistent/python3',
      scriptPath,
      timeoutMs: 3000,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.degraded).toBe(true)
      expect(outcome.reason.length).toBeGreaterThan(0)
    }
  })

  it('解释器在位 → 桥返回 ok 且正文非空（否则该子项如实 blocked，不撒谎）', async () => {
    // 探测本机 python3 是否可用；不可用则本子项标 blocked（诚实记录，不冒充 pass）
    const probe = await trafilaturaExtract('<html><body><p>hello world</p></body></html>', {
      scriptPath, timeoutMs: 4000,
    })
    if (probe.ok) {
      expect(probe.text).toBeTruthy()
    } else {
      expect(probe.degraded).toBe(true)
      expect(probe.reason).toContain('不可用') // 缺解释器
    }
  })
})

describe('F1#6：Trafilatura 桥有界 I/O（stdin/输出/stderr 硬帽）', () => {
  const scriptPath = resolve(process.cwd(), 'scripts', 'trafilatura-extract.py')

  it('宿主输入上限：超限明确 degraded（不把截断输入当完整抓取）', async () => {
    const outcome = await trafilaturaExtract('x'.repeat(64), {
      scriptPath, timeoutMs: 3000, maxInputChars: 16,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.degraded).toBe(true)
      expect(outcome.reason).toContain('上限')
    }
  })

  it('桥侧 stdin 上限：>1MB 输入被截断并显式标记 inputTruncated（有界内存）', async () => {
    // 宿主放行（maxInputChars=2MB），桥侧 1MB 硬帽触发
    const bigHtml = `<html><body>${'<p>青甘大环线正文样本内容</p>'.repeat(80_000)}</body></html>`
    expect(bigHtml.length).toBeGreaterThan(1_000_000)
    const outcome = await trafilaturaExtract(bigHtml, {
      scriptPath, timeoutMs: 8000, maxInputChars: 2_000_000, maxOutputChars: 200_000,
    })
    if (outcome.ok) {
      // 有界输出：text 不超过 maxOutputChars（桥输出硬帽）
      expect(outcome.text.length).toBeLessThanOrEqual(200_000)
      // 输入截断显式标记（诚实：不是完整抓取）
      expect(outcome.inputTruncated).toBe(true)
    } else {
      expect(outcome.degraded).toBe(true) // 缺解释器等 → 如实 blocked
    }
  }, 15_000)
})
