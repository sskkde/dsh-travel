const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/ubuntu/.dsh/profiles/web/node_modules/playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(__dirname, 'map-first.html')).href);
    assert.equal(await page.locator('.day-tab').first().textContent().then(t => t.trim()), '总览');
    assert.equal(await page.locator('.route-path').count(), 3);
    assert.equal(await page.locator('.marker').count(), 12);
    assert.equal(await page.locator('.route-path').evaluateAll(es => new Set(es.map(e => getComputedStyle(e).stroke)).size), 3);
    assert.equal(await page.locator('.marker').evaluateAll(es => new Set(es.map(e => getComputedStyle(e.querySelector('circle:not(.outer)')).fill)).size), 3);
    assert.equal(await page.locator('.overview-day').count(), 3);
    for (const [day, stop, name] of [[1, 2, '龙井村'], [2, 3, '吴山广场']]) {
      const marker = page.locator(`.marker[data-day="${day}"][data-stop="${stop}"]`);
      await marker.click();
      assert.equal(await page.locator('#spotName').textContent(), name);
      assert.match(await page.locator('#spotIndex').textContent(), new RegExp(`DAY 0${day + 1}`));
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.locator('.day-tab').first().click();
      assert.equal(await page.locator('.route-path:visible').count(), 3);
      assert.equal(await page.locator('.marker:visible').count(), 12);
      assert.equal(await page.locator('.legend.overview span').count(), 4);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overview overflow at ${width}`);
      await page.screenshot({ path: path.join(__dirname, width === 1440 ? 'map-first-overview.png' : 'map-first-overview-mobile.png'), fullPage: true });
      const paths = [];
      for (let day = 0; day < 3; day++) {
        await page.locator('.day-tab').nth(day + 1).click();
        assert.equal(await page.locator('.route-path:visible').count(), 1);
        assert.equal(await page.locator('.marker:visible').count(), 4);
        paths.push(await page.locator('.route-path:visible').getAttribute('d'));
        for (let i = 0; i < 4; i++) {
          const marker = page.locator('.marker:visible').nth(i);
          await marker.click();
          assert.equal(await page.locator('#spotName').textContent(), await marker.getAttribute('aria-label').then(a => a.replace(/^DAY 0\d /, '')));
        }
        await page.locator('#collapseBtn').click();
        assert(await page.locator('#expandBtn').isVisible());
        await page.locator('#expandBtn').click();
        assert(await page.locator('#spotCard').isVisible());
        await page.locator('.stop').nth(2).focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.stop').nth(2).getAttribute('aria-pressed'), 'true');
        await page.locator('.day-tab').first().click();
        assert.equal(await page.locator('.marker:visible').count(), 12);
      }
      assert.equal(new Set(paths).size, 3);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `day overflow at ${width}`);
    }
    await page.locator('#zoomIn').click();
    assert.equal(await page.locator('#zoomLabel').textContent(), '110%');
    await page.locator('#resetMap').click();
    assert.equal(await page.locator('#zoomLabel').textContent(), '100%');
    await page.locator('#tipsBtn').click();
    assert.match(await page.locator('#toast').textContent(), /开放时间/);
    assert.deepEqual(errors, []);
    console.log('PASS: overview default, 3 routes/12 markers, unique day colors, cross-day detail; 2 viewports overview/day roundtrip, 3x4 marker clicks, keyboard, collapse/expand, no overflow; zoom/reset/tips; pageerrors=[]; screenshots=map-first-overview.png,map-first-overview-mobile.png');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
