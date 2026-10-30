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

// The hostile page also wraps #inner, so a blank wrapper around an earlier capture is covered too.
const HOSTILE_CSS = 'button { all: unset !important; background: hotpink !important } div { display: block !important } * { font-family: fantasy !important } [popover]::backdrop { background: black !important }';
// A page copy handler must not overwrite or fake the extension's http copy.
const HOSTILE_SCRIPT = `<script>document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'PAGE TEXT'); e.preventDefault(); });</script>`;
const cardPage = (css, wrapInner) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div id="outer" style="width:400px">${wrapInner ? '<div id="innerWrap">' : ''}<div id="inner"><h2 id="innerTitle">Inner title</h2></div>${wrapInner ? '</div>' : ''}<p id="outerTail">Tail</p></div>
<p id="rtl" dir="rtl" style="width:400px">שלום עולם</p>
<dialog id="modal"><p id="dialogText">Dialog text</p></dialog>
${css ? HOSTILE_SCRIPT : ''}</body></html>`;
const CONVERT_PAGE = `<!doctype html><html><body>
<script>window.customElementConstructions = 0; customElements.define('x-counter', class extends HTMLElement { constructor() { super(); window.customElementConstructions++; } });</script>
<div id="convert" style="width:500px;padding:20px">
<x-counter>Custom</x-counter>
<p><a href="java&#9;script:alert(1)">tabbed</a> <img src="da&#9;ta:image/png;base64,AAAA" alt="data *alt*"> <img src="/x.png" alt="closing ] bracket"> <img srcset="/selected.png 1x" alt="Chosen"></p>
<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>
<ol start="3"><li>Three</li><li>Four</li></ol>
<ol start="0"><li>Zero</li></ol>
<pre><code>first


last</code></pre>
<table><tr><td colspan="2" onclick="window.cellClicked = true"><a href="/rel">rel</a><script>window.tableScriptRan = true</script><img src="data:image/png;base64,AA" srcset="data:image/png;base64,AAAA 1x, /relative.png 2x" onerror="window.liveImageFailed = true"></td></tr></table>
</div>
<p id="failTarget" style="width:300px">Fail target</p>
<section id="nested" style="width:500px;padding:20px"><ul><li><p id="nestedItem">Item</p></li></ul><blockquote><p id="nestedQuote">Quoted</p></blockquote></section></body></html>`;
const CONVERT_EXPECTED = [
  'Custom',
  '',
  'tabbed data \\*alt\\* ![closing \\] bracket](http://test.local/x.png) ![Chosen](http://test.local/selected.png)',
  '',
  '- One',
  '- Two',
  '  - Nested',
  '',
  '3. Three',
  '4. Four',
  '',
  '0. Zero',
  '',
  '```',
  'first',
  '',
  '',
  'last',
  '```',
  '',
  '<table><tbody><tr><td colspan="2"><a href="http://test.local/rel">rel</a><img></td></tr></tbody></table>',
].join('\n');
const PAGES = { '/plain.html': cardPage('', false), '/hostile.html': cardPage(HOSTILE_CSS, true), '/convert.html': CONVERT_PAGE };

async function center(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
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

  await context.route(/^https?:\/\/test\.local\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGES[new URL(route.request().url()).pathname] || TEST_PAGE }));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

  // 4. Restore keeps the live element, so page listeners still work.
  await capture(page, sw, '#count', 2);
  prompts = await storedPrompts(sw);
  assert.ok(prompts[1].generatedPrompt.includes('Counter: 0') && !prompts[1].generatedPrompt.includes('Copy'), 'widget prompt: ' + prompts[1].generatedPrompt);
  await page.locator('.website-to-prompt-container', { hasText: 'Counter' }).getByRole('button', { name: 'Restore' }).click();
  await page.locator('#inc').click();
  assert.strictEqual(await page.locator('#count').textContent(), '1', 'listener survives restore');

  // 5. Clicking an SVG shape captures the surrounding HTML element, because a card cannot render inside SVG.
  await capture(page, sw, '#iconRect');
  assert.strictEqual((await sw.evaluate(() => messageHandlers.GET_SELECTION_MODE())).enabled, false, 'svg click ends selection mode');
  prompts = await storedPrompts(sw);
  assert.strictEqual(prompts.length, 3, 'svg capture saved');
  assert.ok(prompts[2].elementPath.endsWith('div#iconBox:nth-child(5)'), 'svg path: ' + prompts[2].elementPath);
  assert.strictEqual(prompts[2].generatedPrompt, 'icon text', 'svg capture markdown');

  // 6. Capturing a parent of an earlier capture leaves out its buttons.
  await capture(page, sw, '#title', 1);
  prompts = await storedPrompts(sw);
  const bodyPrompt = prompts[3].generatedPrompt;
  assert.ok(!/Copy Markdown|Restore|Open in Saved prompts/.test(bodyPrompt), 'no control labels in nested capture');
  await page.locator('.website-to-prompt-container').first().getByRole('button', { name: 'Restore' }).click();

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

  // 10. Keyboard activation of a group keeps focus on that group after the rerender.
  await dashboard.locator('.group-item', { hasText: 'bulk.example.com' }).focus();
  await dashboard.keyboard.press('Enter');
  assert.strictEqual(await dashboard.evaluate(() => document.activeElement.dataset.group), 'bulk.example.com', 'group keeps focus');

  // Shift range select, then delete with confirm; the view falls back cleanly.
  const items = dashboard.locator('.prompt-item');
  assert.strictEqual(await items.first().locator('.prompt-title').textContent(), 'bulk 19', 'newest prompt first');
  // A checkbox adds to the selection instead of replacing it.
  await items.nth(6).locator('.prompt-checkbox').click();
  assert.strictEqual(await dashboard.locator('.selected-count').textContent(), '2 selected', 'checkbox adds to selection');
  await items.nth(6).locator('.prompt-checkbox').click();
  assert.strictEqual(await dashboard.locator('.selected-count').textContent(), '1 selected', 'checkbox removes from selection');
  await items.nth(0).click();
  await items.nth(4).click({ modifiers: ['Shift'] });
  assert.strictEqual(await dashboard.locator('.selected-count').textContent(), '5 selected');
  assert.strictEqual(await dashboard.locator('.export-btn').textContent(), 'Copy as one prompt (5)');
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
  await dashboard.waitForSelector('.empty-state h2:text("No matching prompts")');
  await dashboard.getByRole('button', { name: 'Clear search' }).click();
  await dashboard.waitForSelector('.prompt-item');
  await sw.evaluate(() => chrome.storage.local.set({ wtpPrompts: [] }));
  await dashboard.waitForSelector('.empty-state h2:text("No saved prompts yet")');

  // 12. Popup reads the real tab state.
  await page.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.waitForTimeout(300);
  assert.strictEqual(await popup.locator('#toggleSelectionBtn').textContent(), 'Select content');
  assert.strictEqual(await popup.locator('#toggleSelectionBtn').getAttribute('aria-pressed'), 'false');
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  // The popup asks about the active tab when it loads, so the page must be in front first.
  await page.bringToFront();
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById('toggleSelectionBtn').textContent === 'Cancel selection');
  await page.keyboard.press('Escape');
  await popup.close();

  // 14. Conversion edge cases from review: parsed schemes, escaped alt, list markers, code blank lines, table cleanup, srcset.
  const convertTab = await context.newPage();
  convertTab.on('pageerror', (e) => errors.push('convert: ' + e.message));
  await convertTab.goto('http://test.local/convert.html');
  await convertTab.bringToFront();
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  const convertBox = await convertTab.locator('#convert').boundingBox();
  await convertTab.mouse.move(convertBox.x + 4, convertBox.y + 4);
  await convertTab.mouse.click(convertBox.x + 5, convertBox.y + 5);
  await convertTab.locator('.wtp-card-status:text("✓ Saved")').waitFor();
  const converted = (await storedPrompts(sw)).at(-1).generatedPrompt;
  assert.strictEqual(converted, CONVERT_EXPECTED, 'conversion edge cases: ' + JSON.stringify(converted));
  assert.strictEqual(await convertTab.evaluate(() => window.customElementConstructions), 1, 'conversion does not rerun page code');

  // Wider captures keep list and quote markers around earlier captures.
  await capture(convertTab, sw, '#nestedItem');
  await capture(convertTab, sw, '#nestedQuote');
  await convertTab.locator('.wtp-card-status:text("✓ Saved")').nth(2).waitFor();
  const savedBeforeNested = (await storedPrompts(sw)).length;
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  const nestedBox = await convertTab.locator('#nested').boundingBox();
  await convertTab.mouse.move(nestedBox.x + 4, nestedBox.y + 4);
  await convertTab.mouse.click(nestedBox.x + 5, nestedBox.y + 5);
  // The wider card replaces the section, and the earlier cards go with it.
  for (let i = 0; i < 50 && (await storedPrompts(sw)).length === savedBeforeNested; i++) await convertTab.waitForTimeout(100);
  const nestedMarkdown = (await storedPrompts(sw)).at(-1).generatedPrompt;
  assert.strictEqual(nestedMarkdown, '- Item\n\n> Quoted', 'nested structure: ' + JSON.stringify(nestedMarkdown));

  // 16. A failed save says so and keeps the Open button off, because the prompt does not exist.
  await sw.evaluate(() => {
    self.realSavePrompt = messageHandlers.SAVE_PROMPT;
    messageHandlers.SAVE_PROMPT = async () => { throw new Error('quota'); };
  });
  await capture(convertTab, sw, '#failTarget');
  const failedCard = convertTab.locator('.website-to-prompt-container', { hasText: 'Fail target' });
  await failedCard.locator('.wtp-card-status:text("Not saved. Copy it now.")').waitFor();
  assert.ok(await failedCard.getByRole('button', { name: 'Open in Saved prompts' }).isDisabled(), 'open stays disabled after failed save');
  await sw.evaluate(() => { messageHandlers.SAVE_PROMPT = self.realSavePrompt; });

  // 15. A newer injected copy disposes the older one, so stale listeners cannot keep intercepting clicks.
  await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
  await convertTab.evaluate(() => document.dispatchEvent(new Event('website-to-prompt:dispose')));
  assert.strictEqual(await convertTab.locator('#websiteToPrompt_highlightOverlay').count(), 0, 'dispose removes the picker');
  assert.strictEqual((await sw.evaluate(() => messageHandlers.GET_SELECTION_MODE())).enabled, false, 'disposed copy stops answering');
  await convertTab.close();

  // 13. The capture card and picker work the same on a plain page and on hostile CSS with a modal dialog.
  // The plain page is https, which has the Clipboard API; http pages copy through the fallback.
  for (const pageUrl of ['https://test.local/plain.html', 'http://test.local/hostile.html']) {
    const cardTab = await context.newPage();
    cardTab.on('pageerror', (e) => errors.push(pageUrl + ': ' + e.message));
    await cardTab.goto(pageUrl);
    await cardTab.bringToFront();
    const where = ' on ' + pageUrl;

    // The picker draws, aligns, and ignores the page's fonts.
    await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
    const titleCenter = await center(cardTab, '#innerTitle');
    await cardTab.mouse.move(titleCenter.x, titleCenter.y);
    const overlay = cardTab.locator('#websiteToPrompt_highlightOverlay');
    await overlay.waitFor({ state: 'visible' });
    const titleBox = await cardTab.locator('#innerTitle').boundingBox();
    const box = await overlay.boundingBox();
    assert.ok(Math.abs(box.x - titleBox.x) < 2 && Math.abs(box.width - titleBox.width) < 2, 'overlay aligned' + where);
    assert.ok(await cardTab.locator('#websiteToPrompt_breadcrumbBar').isVisible(), 'path bar visible' + where);
    const barFont = await cardTab.locator('#websiteToPrompt_breadcrumbBar').evaluate((el) => getComputedStyle(el).fontFamily);
    assert.ok(!barFont.includes('fantasy'), 'path bar font isolated' + where);
    const backdrop = await overlay.evaluate((el) => getComputedStyle(el.getRootNode().host, '::backdrop').backgroundColor);
    assert.strictEqual(backdrop, 'rgba(0, 0, 0, 0)', 'picker backdrop transparent' + where);
    await cardTab.keyboard.press('Escape');
    assert.strictEqual(await overlay.count(), 0, 'Esc removes the picker' + where);

    // Capture #inner: the card shows its Markdown, reports the save, and copies.
    let before = (await storedPrompts(sw)).length;
    await capture(cardTab, sw, '#innerTitle', 1);
    const innerCard = cardTab.locator('.website-to-prompt-container', { hasText: 'Inner title' });
    assert.strictEqual(await innerCard.locator('.website-to-prompt-markdown').textContent(), '## Inner title', 'inner markdown' + where);
    await innerCard.locator('.wtp-card-status:text("✓ Saved")').waitFor();
    assert.strictEqual((await storedPrompts(sw)).length, before + 1, 'inner saved' + where);
    assert.ok(await innerCard.getByRole('button', { name: 'Open in Saved prompts' }).isEnabled(), 'open enabled after save' + where);
    const copyButton = innerCard.getByRole('button', { name: 'Copy Markdown' });
    assert.strictEqual(await copyButton.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 214, 10)', 'copy button styled' + where);
    await copyButton.click();
    await innerCard.getByRole('button', { name: 'Copied' }).waitFor();
    const clipboardReader = pageUrl.startsWith('https:') ? cardTab : await context.newPage();
    if (clipboardReader !== cardTab) await clipboardReader.goto('https://test.local/plain.html');
    assert.strictEqual(await clipboardReader.evaluate(() => navigator.clipboard.readText()), '## Inner title', 'clipboard holds markdown' + where);
    if (clipboardReader !== cardTab) await clipboardReader.close();
    await cardTab.bringToFront();

    // A wider capture keeps the earlier Markdown unescaped and leaves out the card's buttons.
    await capture(cardTab, sw, '#outerTail', 1);
    const outerPrompt = (await storedPrompts(sw)).at(-1).generatedPrompt;
    assert.strictEqual(outerPrompt, '## Inner title\n\nTail', 'nested recapture' + where + ': ' + JSON.stringify(outerPrompt));

    // Restoring both cards brings back the original elements.
    await cardTab.locator('.website-to-prompt-container', { hasText: 'Tail' }).getByRole('button', { name: 'Restore' }).click();
    await cardTab.locator('.website-to-prompt-container', { hasText: 'Inner title' }).getByRole('button', { name: 'Restore' }).click();
    assert.strictEqual(await cardTab.locator('#innerTitle').textContent(), 'Inner title', 'restored' + where);
    assert.strictEqual(await cardTab.locator('.website-to-prompt-container').count(), 0, 'no cards left' + where);

    // Right-to-left text reads right to left in the card.
    await capture(cardTab, sw, '#rtl');
    assert.ok(await cardTab.locator('.website-to-prompt-markdown').evaluate((el) => el.matches(':dir(rtl)')), 'rtl markdown' + where);

    // The top-layer picker still shows when the page has a modal dialog open.
    await cardTab.evaluate(() => document.getElementById('modal').showModal());
    await sw.evaluate(() => messageHandlers.SET_SELECTION_MODE({ enabled: true }));
    const dialogCenter = await center(cardTab, '#dialogText');
    await cardTab.mouse.move(dialogCenter.x, dialogCenter.y);
    await overlay.waitFor({ state: 'visible' });
    const dialogTextBox = await cardTab.locator('#dialogText').boundingBox();
    const dialogOverlayBox = await overlay.boundingBox();
    assert.ok(Math.abs(dialogOverlayBox.y - dialogTextBox.y) < 2, 'overlay aligned in dialog' + where);
    assert.ok(await overlay.evaluate((el) => el.getRootNode().host.matches(':popover-open')), 'picker in top layer' + where);
    before = (await storedPrompts(sw)).length;
    await cardTab.mouse.click(dialogCenter.x, dialogCenter.y);
    await cardTab.locator('#modal .website-to-prompt-container .wtp-card-status:text("✓ Saved")').waitFor();
    assert.strictEqual((await storedPrompts(sw)).at(-1).generatedPrompt, 'Dialog text', 'dialog capture' + where);
    await cardTab.close();
  }

  assert.deepStrictEqual(errors, [], 'no page or extension errors');
  console.log('ALL E2E CHECKS PASSED');
  await context.close();
})().catch((e) => { console.error('E2E FAILED:', e.stack); process.exit(1); });
