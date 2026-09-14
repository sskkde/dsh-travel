#!/usr/bin/env node
/**
 * SettingsCard native details/summary browser smoke test.
 *
 * This test does not use the production DSH server for its fixture. It bundles
 * the current SettingsCard/UsagePanel sources with real React 18 and
 * ReactDOM/client, mounts them into a file:// fixture, and drives the resulting
 * DOM in Chromium. The fixture exercises a real React state update and parent
 * reconciliation; all details/summary markup and event handlers come from the
 * production components themselves.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '../../.test-env/tooling/node_modules/playwright/index.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const workDir = mkdtempSync(join(tmpdir(), 'dsh-travel-settings-collapse-'))
const bundlePath = join(workDir, 'settings-collapse.bundle.js')
const fixturePath = join(workDir, 'settings-collapse.html')

const entry = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsCard } from './src/client/SettingsCard.tsx'
import {
  ADVANCED_FIELDS,
  CHANNEL_FIELDS,
  CHANNEL_GROUPS,
  COMPANION_SERVICE_IDS,
  COMPANION_SERVICES_DEFAULT,
  KEY_FIELDS,
} from './src/client/fields.ts'

const calls = {
  edit: [],
  renders: 0,
  save: 0,
  discard: 0,
  confirmSaveAnyway: 0,
  cancelRedundancy: 0,
  fetch: [],
}

const field = (text) => ({ text, overridden: false, invalid: false })
const channels = Object.fromEntries(CHANNEL_GROUPS.map((group) => [
  group,
  Object.fromEntries(CHANNEL_FIELDS
    .filter((definition) => definition.group === group)
    .map((definition) => [
      definition.id,
      field(definition.id === 'xhsCloak' ? 'false' : definition.id === 'cityDidi' ? 'false' : 'true'),
    ])),
]))
const keys = KEY_FIELDS.map((definition) => ({ id: definition.id, configured: false, draft: '', clearing: false }))
const advanced = Object.fromEntries(ADVANCED_FIELDS.map((definition) => [
  definition.id,
  field(definition.kind === 'toggle' ? 'true' : definition.kind === 'choice' ? definition.choices[0] : definition.kind === 'text' ? '/travel-plans' : '1'),
]))
const companionServices = Object.fromEntries(COMPANION_SERVICE_IDS.map((id) => [id, field(String(COMPANION_SERVICES_DEFAULT[id]))]))
const initialState = {
  available: true,
  exposed: true,
  writable: true,
  dirty: false,
  saving: false,
  failed: false,
  redundancyWarned: false,
  redundancyModal: false,
  redundancy: [],
  channels,
  keys,
  advanced,
  companionAutostart: field('false'),
  companionServices,
}

function updateState(previous, path, value) {
  const [scope, group, id] = path.split('.')
  if (scope === 'channels') {
    return {
      ...previous,
      channels: {
        ...previous.channels,
        [group]: {
          ...previous.channels[group],
          [id]: { ...previous.channels[group][id], text: String(value) },
        },
      },
    }
  }
  if (scope === 'keys') {
    return {
      ...previous,
      keys: previous.keys.map((row) => row.id === group ? { ...row, draft: String(value) } : row),
    }
  }
  if (scope === 'advanced' && group === 'companionServices') {
    return {
      ...previous,
      companionServices: {
        ...previous.companionServices,
        [id]: { ...previous.companionServices[id], text: String(value) },
      },
    }
  }
  if (scope === 'advanced') {
    return {
      ...previous,
      advanced: {
        ...previous.advanced,
        [group]: { ...previous.advanced[group], text: String(value) },
      },
    }
  }
  return previous
}

const metrics = {
  month: '2026-09',
  lastResetAt: '2026-09-01T00:00:00.000Z',
  generatedAt: '2026-09-07T00:00:00.000Z',
  amap: { logical: 1, quota: 2, network: 1, poi: 1, rest: 0, monthlyLimit: 100 },
  search: { l0Queries: 1, l05Fetches: 0 },
  cache: { hits: 1, misses: 0, rate: 1 },
  fanout: { attempts: 1, retries: 0 },
  governance: { rateLimitRejects: 0, robotsBlocked: 0 },
  degraded: [],
  entries: [],
}
globalThis.fetch = async (input, init = {}) => {
  calls.fetch.push({ url: String(input), method: init.method ?? 'GET' })
  return { ok: true, status: 200, json: async () => metrics }
}

function SettingsFixture() {
  const [state, setState] = useState(initialState)
  calls.renders += 1
  const face = {
    useTravelCard: (selector) => selector(state),
    t: (key) => key,
    edit: (path, value) => {
      calls.edit.push({ path, value })
      setState((previous) => updateState(previous, path, value))
    },
    clearKey: () => {},
    save: () => { calls.save += 1 },
    confirmSaveAnyway: () => { calls.confirmSaveAnyway += 1 },
    cancelRedundancy: () => { calls.cancelRedundancy += 1 },
    discard: () => { calls.discard += 1 },
  }
  return <SettingsCard {...face} />
}

const root = createRoot(document.getElementById('root'))
globalThis.__settingsCollapse = { calls }
root.render(<SettingsFixture />)
`

function pass(label, detail = '') {
  console.log(`PASS|${label}${detail ? `|${detail}` : ''}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function assertCollapsed(details, body, label) {
  assert(await details.evaluate((element) => element.open) === false, `${label} did not collapse`)
  const layout = await body.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      display: getComputedStyle(element).display,
      width: rect.width,
      height: rect.height,
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
      offsetParent: element.offsetParent !== null,
    }
  })
  assert(layout.display === 'none'
    && layout.width === 0
    && layout.height === 0
    && layout.offsetWidth === 0
    && layout.offsetHeight === 0
    && layout.offsetParent === false,
  `${label} body remained visible or had layout: ${JSON.stringify(layout)}`)
}

async function assertZeroLayout(body, label) {
  const layout = await body.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
    }
  })
  assert(layout.width === 0 && layout.height === 0 && layout.offsetWidth === 0 && layout.offsetHeight === 0,
    `${label} nested body had layout: ${JSON.stringify(layout)}`)
}

async function assertExpanded(details, body, label) {
  assert(await details.evaluate((element) => element.open) === true, `${label} did not expand`)
  const layout = await body.evaluate((element) => ({
    display: getComputedStyle(element).display,
    height: element.getBoundingClientRect().height,
  }))
  assert(layout.display !== 'none' && layout.height > 0, `${label} body remained hidden: ${JSON.stringify(layout)}`)
}

async function verifyIsolated3081(page, pageErrors) {
  const baseUrl = process.env.SETTINGS_COLLAPSE_URL ?? 'http://127.0.0.1:3081/'
  const errorStart = pageErrors.length
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const card = page.locator('.dsh-travel-card')
  await card.waitFor({ state: 'visible', timeout: 30000 })
  assert(pageErrors.length === errorStart, `3081 browser page errors: ${pageErrors.slice(errorStart).join('; ')}`)

  const topGroups = card.locator('details.dsh-travel-group')
  const topSummaries = card.locator('details.dsh-travel-group > summary')
  assert(await topGroups.count() === 3, '3081 expected three top-level groups')
  for (let index = 0; index < 3; index += 1) {
    const group = topGroups.nth(index)
    const summary = topSummaries.nth(index)
    const body = group.locator(':scope > .dsh-travel-groupBody')
    await summary.click()
    await assertCollapsed(group, body, `3081 top group ${index}`)
    await summary.click()
    await assertExpanded(group, body, `3081 top group ${index}`)
  }

  // Real DSH client reconciliation: close channels, edit a sibling field in
  // advanced, and ensure the closed details survives the parent re-render.
  const closedTopGroup = topGroups.nth(0)
  const closedTopSummary = topSummaries.nth(0)
  const closedTopBody = closedTopGroup.locator(':scope > .dsh-travel-groupBody')
  const siblingCheckbox = topGroups.nth(2).locator('input[type="checkbox"]').first()
  await closedTopSummary.click()
  await assertCollapsed(closedTopGroup, closedTopBody, '3081 channels before sibling edit')
  const siblingBefore = await siblingCheckbox.isChecked()
  await siblingCheckbox.click()
  await page.waitForTimeout(50)
  assert(await siblingCheckbox.isChecked() !== siblingBefore, '3081 sibling edit did not update through React client')
  await assertCollapsed(closedTopGroup, closedTopBody, '3081 channels after sibling edit re-render')
  await siblingCheckbox.click()
  await page.waitForTimeout(50)
  await assertCollapsed(closedTopGroup, closedTopBody, '3081 channels after sibling revert re-render')
  await closedTopSummary.click()
  await assertExpanded(closedTopGroup, closedTopBody, '3081 channels restored after reconciliation check')
  pass('3081 React reconciliation preserves closed group after sibling edit')

  const channelGroups = card.locator('details.dsh-travel-subgroup').filter({ has: page.locator('fieldset') })
  assert(await channelGroups.count() === 5, '3081 expected five FR fieldset groups')
  for (let index = 0; index < 5; index += 1) {
    const subgroup = channelGroups.nth(index)
    const summary = subgroup.locator('summary')
    const body = subgroup.locator(':scope > .dsh-travel-subgroupFieldset')
    const nestedBody = subgroup.locator(':scope > .dsh-travel-subgroupFieldset > .dsh-travel-subgroupBody')
    assert(await subgroup.locator('fieldset > legend').count() === 1, `3081 FR subgroup ${index} lacks fieldset/legend`)
    await summary.click()
    await assertCollapsed(subgroup, body, `3081 FR subgroup ${index}`)
    await assertZeroLayout(nestedBody, `3081 FR subgroup ${index}`)
    await summary.click()
    await assertExpanded(subgroup, body, `3081 FR subgroup ${index}`)
  }

  const companion = card.locator('details.dsh-travel-subgroup').filter({ hasText: 'Companion' })
  assert(await companion.count() === 1, '3081 companion subgroup missing')
  const companionBody = companion.locator(':scope > .dsh-travel-subgroupBody')
  await companion.locator('summary').click()
  await assertCollapsed(companion, companionBody, '3081 companion subgroup')
  await companion.locator('summary').click()
  await assertExpanded(companion, companionBody, '3081 companion subgroup')

  const usage = card.locator('details.dsh-travel-usage')
  assert(await usage.count() === 1, '3081 UsagePanel details missing')
  const usageBody = usage.locator(':scope > .dsh-travel-usageBody')
  await usage.locator('summary').click()
  await assertCollapsed(usage, usageBody, '3081 UsagePanel')
  await usage.locator('summary').click()
  await assertExpanded(usage, usageBody, '3081 UsagePanel')

  // M3.6：credentials 层已配 Key 必须显示「已配置」（locale 无关：只认 badgeOk
  // class）。测试环境 .credentials.yaml 含 AMAP_WEBSERVICE/AMAP_JSAPI/AMAP_JSCODE/
  // WENDAO_APIKEY/DIDI_MCPKEY → 对应 Key 行经 /travel-key-status 合并后 badgeOk。
  const keysGroup = topGroups.nth(1)
  const keysGroupSummary = topSummaries.nth(1)
  assert(await keysGroup.locator('input[type="password"]').count() > 0, '3081 keys group has no password inputs')
  if (await keysGroup.evaluate((element) => element.open) === false) {
    await keysGroupSummary.click()
  }
  const keysBody = keysGroup.locator(':scope > .dsh-travel-groupBody')
  await keysBody.waitFor({ state: 'visible', timeout: 2000 })
  await page.waitForFunction(() => {
    const groups = document.querySelectorAll('details.dsh-travel-group')
    const keysGroupEl = groups[1]
    return keysGroupEl !== undefined && keysGroupEl.querySelectorAll('.dsh-travel-badgeOk').length > 0
  }, undefined, { timeout: 3000 })
  const badgeOkCount = await keysGroup.locator('.dsh-travel-badgeOk').count()
  assert(badgeOkCount > 0, `3081 keys group showed no configured badges (credentials-layer keys must display configured): badgeOk=${badgeOkCount}`)
  pass('3081 credentials-layer keys display as configured', `badgeOk=${badgeOkCount}`)
  pass('3081 Chromium closed direct bodies display:none/zero-layout', 'top×3 / FR×5 / companion / UsagePanel')
}

async function main() {
  let browser
  try {
    await build({
      stdin: {
        contents: entry,
        loader: 'tsx',
        resolveDir: repoRoot,
        sourcefile: 'settings-collapse-entry.tsx',
      },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      target: 'es2020',
      outfile: bundlePath,
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'error',
    })
    writeFileSync(fixturePath, `<!doctype html><html><head><meta charset="utf-8"><title>Settings collapse test</title></head><body><main id="root"></main><script src="${bundlePath}"></script></body></html>`)

    browser = await chromium.launch({
      executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(pathToFileURL(fixturePath).href, { waitUntil: 'load' })
    try {
      await page.waitForFunction(() => globalThis.__settingsCollapse !== undefined, undefined, { timeout: 10000 })
    } catch (error) {
      throw new Error(`settings fixture did not render: ${pageErrors.join('; ') || (error instanceof Error ? error.message : String(error))}`)
    }
    assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join('; ')}`)

    const topGroups = page.locator('details.dsh-travel-group')
    const topSummaries = page.locator('details.dsh-travel-group > summary')
    const allDetails = page.locator('details')
    const summaries = page.locator('details > summary')
    assert(await topGroups.count() === 3, 'expected three top-level groups')
    assert(await allDetails.count() === 10, `expected ten details nodes, got ${await allDetails.count()}`)
    assert(await summaries.count() === 10, 'every details node must have a direct summary')
    pass('top-level groups and summaries', '3 groups / 10 details')

    const topSummaryTexts = await page.locator('details.dsh-travel-group > summary').allTextContents()
    assert(topSummaryTexts.map((text) => text.replace(/\s+/g, '')).join('|') === 'group.channelsgroup.channelsHint|group.keysgroup.keysHint|group.advancedgroup.advancedHint', `top-level summary labels changed: ${JSON.stringify(topSummaryTexts)}`)
    for (let index = 0; index < 3; index += 1) {
      const group = topGroups.nth(index)
      const summary = topSummaries.nth(index)
      const body = group.locator(':scope > .dsh-travel-groupBody')
      await summary.click()
      await assertCollapsed(group, body, `top group ${index}`)
      await summary.click()
      await assertExpanded(group, body, `top group ${index}`)
    }
    pass('top-level click collapse/expand')

    const channelGroups = page.locator('details.dsh-travel-subgroup').filter({ has: page.locator('fieldset') })
    assert(await channelGroups.count() === 5, `expected five FR fieldset groups, got ${await channelGroups.count()}`)
    const expectedFrLabels = ['fr3.title8/9', 'fr4.title7/8', 'fr5.title4/4', 'fr6.title3/3', 'fr7.title4/4']
    for (let index = 0; index < expectedFrLabels.length; index += 1) {
      const subgroup = channelGroups.nth(index)
      const summaryText = (await subgroup.locator('summary').textContent() ?? '').replace(/\s+/g, '')
      const legendText = (await subgroup.locator('legend').textContent() ?? '').trim()
      assert(summaryText.includes(expectedFrLabels[index]), `FR subgroup ${index} count/label mismatch: ${summaryText}`)
      assert(legendText === `fr${index + 3}.title`, `FR subgroup ${index} legend missing: ${legendText}`)
      assert(await subgroup.locator('fieldset > legend').count() === 1, `FR subgroup ${index} lacks fieldset/legend semantics`)
    }
    pass('FR subgroups retain fieldset/legend semantics', '5 groups / 5 legends')
    for (let index = 0; index < 5; index += 1) {
      const subgroup = channelGroups.nth(index)
      const summary = subgroup.locator('summary')
      const body = subgroup.locator(':scope > .dsh-travel-subgroupFieldset')
      const nestedBody = subgroup.locator(':scope > .dsh-travel-subgroupFieldset > .dsh-travel-subgroupBody')
      await summary.click()
      await assertCollapsed(subgroup, body, `FR subgroup ${index}`)
      await assertZeroLayout(nestedBody, `FR subgroup ${index}`)
      await summary.click()
      await assertExpanded(subgroup, body, `FR subgroup ${index}`)
    }
    pass('all FR subgroup click collapse/expand', '5 groups')

    const fr3Summary = channelGroups.nth(0).locator('summary')
    const fr3Body = channelGroups.nth(0).locator(':scope > .dsh-travel-subgroupFieldset')
    await fr3Summary.focus()
    await fr3Summary.press('Enter')
    await assertCollapsed(channelGroups.nth(0), fr3Body, 'FR-3')
    await fr3Summary.press('Space')
    await assertExpanded(channelGroups.nth(0), fr3Body, 'FR-3')
    pass('FR subgroup Enter/Space collapse/expand')

    const companion = page.locator('details.dsh-travel-subgroup').filter({ hasText: 'group.companion' })
    assert(await companion.count() === 1, 'companion subgroup missing')
    const companionBody = companion.locator(':scope > .dsh-travel-subgroupBody')
    await companion.locator('summary').click()
    await assertCollapsed(companion, companionBody, 'companion subgroup')
    await companion.locator('summary').click()
    await assertExpanded(companion, companionBody, 'companion subgroup')
    pass('companion service click collapse/expand')

    const usage = page.locator('details.dsh-travel-usage')
    assert(await usage.count() === 1, 'UsagePanel details missing')
    assert(await usage.locator('summary').count() === 1, 'UsagePanel summary missing')
    const usageBody = usage.locator(':scope > .dsh-travel-usageBody')
    await usage.locator('summary').focus()
    await usage.locator('summary').press('Enter')
    await assertCollapsed(usage, usageBody, 'UsagePanel')
    await usage.locator('summary').press('Space')
    await assertExpanded(usage, usageBody, 'UsagePanel')
    pass('UsagePanel Enter/Space collapse/expand')
    pass('closed direct bodies display:none and zero-layout', 'top×3 / FR×5 / companion / UsagePanel')

    const rendersBeforeReconciliation = await page.evaluate(() => globalThis.__settingsCollapse.calls.renders)
    const closedGroup = topGroups.nth(0)
    const closedBody = closedGroup.locator(':scope > .dsh-travel-groupBody')
    const siblingKeyInput = topGroups.nth(1).locator('input[type="password"]').first()
    await topSummaries.nth(0).click()
    await assertCollapsed(closedGroup, closedBody, 'channels before real React sibling edit')
    await siblingKeyInput.fill('react-state-token')
    await page.waitForFunction((expectedRenders) => {
      const groups = document.querySelectorAll('details.dsh-travel-group')
      const input = groups[1]?.querySelector('input[type="password"]')
      return globalThis.__settingsCollapse.calls.renders > expectedRenders
        && groups[0]?.open === false
        && input?.value === 'react-state-token'
    }, rendersBeforeReconciliation)
    await assertCollapsed(closedGroup, closedBody, 'channels after real React sibling edit re-render')
    assert(await siblingKeyInput.inputValue() === 'react-state-token', 'real React state update did not preserve edited value')
    const actionsAfterReconciliation = await page.evaluate(() => ({
      save: globalThis.__settingsCollapse.calls.save,
      discard: globalThis.__settingsCollapse.calls.discard,
      confirmSaveAnyway: globalThis.__settingsCollapse.calls.confirmSaveAnyway,
      cancelRedundancy: globalThis.__settingsCollapse.calls.cancelRedundancy,
      post: globalThis.__settingsCollapse.calls.fetch.filter((call) => call.method === 'POST').length,
      renders: globalThis.__settingsCollapse.calls.renders,
    }))
    assert(actionsAfterReconciliation.save === 0, 'real React re-render triggered save callback')
    assert(actionsAfterReconciliation.discard === 0, 'real React re-render triggered discard callback')
    assert(actionsAfterReconciliation.confirmSaveAnyway === 0, 'real React re-render triggered confirm-save callback')
    assert(actionsAfterReconciliation.cancelRedundancy === 0, 'real React re-render triggered redundancy-cancel callback')
    assert(actionsAfterReconciliation.post === 0, 'real React re-render triggered Cloak POST callback')
    pass('real React state update preserves closed sibling and edited value', `${actionsAfterReconciliation.renders} renders / 0 save / 0 discard / 0 Cloak POST`)
    await topSummaries.nth(0).click()
    await assertExpanded(closedGroup, closedBody, 'channels restored after real React reconciliation')

    const callsBeforeControls = await page.evaluate(() => ({
      edit: globalThis.__settingsCollapse.calls.edit.length,
      save: globalThis.__settingsCollapse.calls.save,
      discard: globalThis.__settingsCollapse.calls.discard,
      confirmSaveAnyway: globalThis.__settingsCollapse.calls.confirmSaveAnyway,
      cancelRedundancy: globalThis.__settingsCollapse.calls.cancelRedundancy,
      post: globalThis.__settingsCollapse.calls.fetch.filter((call) => call.method === 'POST').length,
    }))

    await topSummaries.nth(0).click()
    assert(await topGroups.nth(0).evaluate((element) => element.open) === false, 'channels group failed final collapse')
    await topSummaries.nth(0).click()
    await channelGroups.nth(0).locator('input[type="checkbox"]').first().click()

    await topSummaries.nth(1).click()
    assert(await topGroups.nth(1).evaluate((element) => element.open) === false, 'keys group failed final collapse')
    await topSummaries.nth(1).click()
    await topGroups.nth(1).locator('input[type="password"]').first().fill('browser-test-token')

    await topSummaries.nth(2).click()
    assert(await topGroups.nth(2).evaluate((element) => element.open) === false, 'advanced group failed final collapse')
    await topSummaries.nth(2).click()
    await topGroups.nth(2).locator('input[type="text"]').first().fill('/browser-test')
    await companion.locator('summary').click()
    assert(await companion.evaluate((element) => element.open) === false, 'companion failed final collapse')
    await companion.locator('summary').click()
    await companion.locator('input[type="checkbox"]').first().click()

    const callsAfterControls = await page.evaluate(() => ({
      edit: globalThis.__settingsCollapse.calls.edit.length,
      save: globalThis.__settingsCollapse.calls.save,
      discard: globalThis.__settingsCollapse.calls.discard,
      confirmSaveAnyway: globalThis.__settingsCollapse.calls.confirmSaveAnyway,
      cancelRedundancy: globalThis.__settingsCollapse.calls.cancelRedundancy,
      post: globalThis.__settingsCollapse.calls.fetch.filter((call) => call.method === 'POST').length,
    }))
    assert(callsAfterControls.edit >= callsBeforeControls.edit + 4, 'controls did not remain editable after collapse/expand')
    assert(callsAfterControls.save === 0, 'collapse interaction triggered save callback')
    assert(callsAfterControls.discard === 0, 'collapse interaction triggered discard callback')
    assert(callsAfterControls.confirmSaveAnyway === 0, 'collapse interaction triggered confirm-save callback')
    assert(callsAfterControls.cancelRedundancy === 0, 'collapse interaction triggered redundancy-cancel callback')
    assert(callsAfterControls.post === 0, 'collapse interaction triggered Cloak POST callback')
    pass('collapsed controls remain editable without action callbacks', `${callsAfterControls.edit} edits / 0 save / 0 discard / 0 Cloak POST`)

    await verifyIsolated3081(page, pageErrors)
    console.log('SETTINGS_COLLAPSE_PASS')
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
    rmSync(workDir, { recursive: true, force: true })
  }
}

await main()
