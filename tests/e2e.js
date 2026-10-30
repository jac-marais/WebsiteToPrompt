// End-to-end check of the unpacked extension in Playwright's Chromium.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const extensionPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));

const TEST_PAGE = `<!doctype html><html><body style="margin:40px; position:relative; top:30px">
<h1 id="title">Test page</h1>
<div id="card" style="width:400px"><a id="cardLink" href="/post/1"><h3 id="cardHeading">Post title</h3><p>Short summary.</p></a></div>
<section id="widget" style="width:400px;padding:10px"><p>Counter: <span id="count">0</span></p><button id="inc">Increment</button></section>
<div id="links" style="width:400px"><p>Read the <a href="docs" title="The
  docs">docs</a>, skip <a href="javascript:void(0)">this</a>, ignore <a href="#top"></a>and see <a href="/big.png"><img src="/small.png" alt="Diagram"></a>.</p></div>
<div id="iconBox" style="width:400px"><svg id="icon" class="icon" width="60" height="60"><rect id="iconRect" class="r" width="60" height="60" fill="red"/></svg> icon text</div>
<script>document.getElementById('inc').addEventListener('click', () => { const c = document.getElementById('count'); c.textContent = String(Number(c.textContent) + 1); });</script>
</body></html>`;

async function center(page, selector) {
  const box = await page.locator(selector).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function capture(page, sw, selector, scrollSteps = 0) {
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  const { x, y } = await center(page, selector);
  await page.mouse.move(x - 1, y - 1);
  await page.mouse.move(x, y);
  for (let i = 0; i < scrollSteps; i++) await page.mouse.wheel(0, 60);
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
}

const storedPrompts = (sw) => sw.evaluate(async () => (await chrome.storage.local.get('wtpPrompts')).wtpPrompts || []);

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  await context.route('http://test.local/**', (route) => route.fulfill({ contentType: 'text/html', body: TEST_PAGE }));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://test.local/articles/index.html');
  await page.bringToFront();

  // 1. Enabling twice leaves one overlay, and GET reports the state.
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  assert.strictEqual(await page.locator('#websiteToPrompt_highlightOverlay').count(), 1, 'one overlay');
  assert.strictEqual((await sw.evaluate(() => messageHandlers.GET_SELECTION_MODE())).enabled, true);
  await page.keyboard.press('Escape');
  assert.strictEqual((await sw.evaluate(() => messageHandlers.GET_SELECTION_MODE())).enabled, false, 'Esc disables');

  // 2. Overlay lines up with the hovered element even though the body is offset.
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  const headingCenter = await center(page, '#cardHeading');
  await page.mouse.move(headingCenter.x, headingCenter.y);
  await page.waitForTimeout(200);
  const overlayBox = await page.locator('#websiteToPrompt_highlightOverlay').boundingBox();
  const headingBox = await page.locator('#cardHeading').boundingBox();
  assert.ok(Math.abs(overlayBox.y - headingBox.y) < 2 && Math.abs(overlayBox.x - headingBox.x) < 2, `overlay aligned ${JSON.stringify([overlayBox, headingBox])}`);
  const breadcrumb = await page.locator('#websiteToPrompt_breadcrumbBar').textContent();
  assert.ok(breadcrumb.includes('h3#cardHeading'), 'breadcrumb names element: ' + breadcrumb);
  await page.keyboard.press('Escape');

  // 3. Capture the card (scroll one layer up from the heading to the <a>) and check the link Markdown.
  await capture(page, sw, '#cardHeading', 1);
  let prompts = await storedPrompts(sw);
  assert.strictEqual(prompts.length, 1, 'saved one prompt');
  assert.strictEqual(prompts[0].generatedPrompt, '[Post title Short summary.](http://test.local/post/1)', 'card link markdown: ' + prompts[0].generatedPrompt);
  const shown = await page.locator('.website-to-prompt-markdown').textContent();
  assert.strictEqual(shown, prompts[0].generatedPrompt, 'page shows markdown');
  assert.strictEqual((await sw.evaluate(() => messageHandlers.GET_SELECTION_MODE())).enabled, false, 'click ends selection mode');

  // 4. Revert keeps the live element, so page listeners still work.
  await capture(page, sw, '#count', 2);
  prompts = await storedPrompts(sw);
  assert.ok(prompts[1].generatedPrompt.includes('Counter: 0') && !prompts[1].generatedPrompt.includes('Copy'), 'widget prompt: ' + prompts[1].generatedPrompt);
  await page.locator('.website-to-prompt-container', { hasText: 'Counter' }).getByRole('button', { name: 'Revert' }).click();
  await page.locator('#inc').click();
  assert.strictEqual(await page.locator('#count').textContent(), '1', 'listener survives revert');

  // 5. Clicking an SVG shape no longer crashes and still ends selection mode.
  await capture(page, sw, '#iconRect');
  assert.strictEqual((await sw.evaluate(() => messageHandlers.GET_SELECTION_MODE())).enabled, false, 'svg click ends selection mode');
  prompts = await storedPrompts(sw);
  assert.strictEqual(prompts.length, 3, 'svg capture saved');
  assert.ok(prompts[2].elementPath.includes('rect#iconRect'), 'svg path: ' + prompts[2].elementPath);

  // 6. Capturing a parent of an earlier capture leaves out its buttons.
  await capture(page, sw, '#title', 1);
  prompts = await storedPrompts(sw);
  const bodyPrompt = prompts[3].generatedPrompt;
  assert.ok(!/Revert|Open Dashboard/.test(bodyPrompt), 'no control labels in nested capture');
  await page.locator('.website-to-prompt-container').first().getByRole('button', { name: 'Revert' }).click();

  // 7. Inline links stay on one line with absolute URLs; script links and empty anchors are dropped.
  await capture(page, sw, '#links p');
  prompts = await storedPrompts(sw);
  assert.strictEqual(prompts[4].generatedPrompt,
    'Read the [docs](http://test.local/articles/docs "The docs"), skip this, ignore and see [![Diagram](http://test.local/small.png)](http://test.local/big.png).',
    'inline links: ' + prompts[4].generatedPrompt);

  // 8. Parallel saves are not lost.
  await sw.evaluate(() => Promise.all(Array.from({ length: 20 }, (_, i) =>
    messageHandlers.SAVE_PROMPT({ prompt: { id: 'bulk' + i, timestamp: Date.now() + i, sourceUrl: 'https://bulk.example.com/x', generatedPrompt: 'bulk ' + i, elementContent: '', tags: [] } }))));
  prompts = await storedPrompts(sw);
  assert.strictEqual(prompts.length, 25, 'parallel saves kept: ' + prompts.length);

  // 9. Dashboard opens on the requested prompt, newest first, and escapes page data.
  const firstId = prompts[0].id;
  const dashboard = await context.newPage();
  dashboard.on('pageerror', (e) => errors.push('dashboard: ' + e.message));
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html?promptId=${encodeURIComponent(firstId)}`);
  await dashboard.waitForSelector('.details-content');
  assert.strictEqual(await dashboard.locator('.details-content').textContent(), prompts[0].generatedPrompt, 'deep link shows prompt');
  assert.strictEqual(await dashboard.locator('.group-item.selected').textContent(), 'test.local (5)');
  const groupOrder = await dashboard.locator('.group-item').allTextContents();
  assert.deepStrictEqual(groupOrder, ['bulk.example.com (20)', 'test.local (5)'], 'groups newest first: ' + groupOrder);

  // 10. Shift range select, then delete with confirm; the view falls back cleanly.
  await dashboard.locator('.group-item', { hasText: 'bulk.example.com' }).click();
  const items = dashboard.locator('.prompt-item');
  assert.strictEqual(await items.first().locator('.prompt-content').textContent(), 'bulk 19', 'newest prompt first');
  await items.nth(0).click();
  await items.nth(4).click({ modifiers: ['Shift'] });
  assert.strictEqual(await dashboard.locator('.selected-count').textContent(), '5 selected');
  dashboard.once('dialog', (d) => d.accept());
  await dashboard.locator('.delete-btn').click();
  await dashboard.waitForFunction(() => document.querySelector('.selected-count').textContent === '1 selected');
  assert.strictEqual((await storedPrompts(sw)).length, 20, 'deleted 5');
  await dashboard.locator('.select-all-btn').click();
  dashboard.once('dialog', (d) => d.accept());
  await dashboard.locator('.delete-btn').click();
  await dashboard.waitForFunction(() => document.querySelector('.group-item.selected')?.textContent === 'test.local (5)');
  assert.strictEqual(await dashboard.locator('.group-item').count(), 1, 'emptied group disappears');
  assert.ok((await dashboard.locator('.details-content').textContent()).length > 0, 'details fall back to a remaining prompt');

  // 11. Dismissing the confirm deletes nothing; search with no match shows the empty state.
  dashboard.once('dialog', (d) => d.dismiss());
  await dashboard.locator('.delete-btn').click();
  await dashboard.waitForTimeout(200);
  assert.strictEqual((await storedPrompts(sw)).length, 5, 'dismiss keeps prompts');
  await dashboard.fill('.search-input', 'zzz-no-match');
  await dashboard.waitForSelector('.empty-state');

  // 12. Popup reads the real tab state.
  await page.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.waitForTimeout(300);
  assert.strictEqual(await popup.locator('#toggleSelectionBtn').textContent(), 'Enable Selection');

  assert.deepStrictEqual(errors, [], 'no page or extension errors');
  console.log('ALL E2E CHECKS PASSED');
  await context.close();
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
