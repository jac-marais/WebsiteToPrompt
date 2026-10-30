(function () {
  // This content script handles selection highlighting and element transformations.
  let selectionMode = false;
  let highlightOverlay = null;
  let elementStack = [];
  let currentDepthIndex = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let breadcrumbBar = null;
  let stackLocked = false;
  let lockOriginX = 0;
  let lockOriginY = 0;
  let accumulatedDelta = 0;
  let pickerHost = null;

  // Original elements are kept so Restore puts back the live node with its event listeners.
  const originalElementByContainer = new WeakMap();
  const chosenImageSrc = new WeakMap();

  const SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'BR', 'BODY']);

  // Page rules still reach the shadow host, and only !important host rules beat the page's !important.
  const IN_PAGE_CSS = `
    :host {
      all: initial !important;
      display: block !important;
      margin: 12px 0 !important;
    }
    :host([popover]) {
      position: fixed !important;
      inset: 0 !important;
      margin: 0 !important;
      pointer-events: none !important;
    }
    :host([popover])::backdrop {
      background: transparent !important;
    }
    * {
      box-sizing: border-box;
    }

    #websiteToPrompt_highlightOverlay {
      position: fixed;
      display: none;
      border: 2px solid #FFD60A;
      border-radius: 2px;
      background: rgba(255, 214, 10, 0.16);
      box-shadow: 0 0 0 1px #16181D, inset 0 0 0 1px #16181D;
    }
    #websiteToPrompt_breadcrumbBar {
      position: fixed;
      left: 50%;
      bottom: 12px;
      transform: translateX(-50%);
      display: none;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 24px);
      padding: 6px 10px 6px 6px;
      border: 1px solid #2A2E37;
      border-radius: 10px;
      background: rgba(22, 24, 29, 0.96);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      color: #ECEEF1;
      font: 400 12px/18px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      white-space: nowrap;
    }
    .wtp-depth {
      padding: 0 6px;
      border-radius: 4px;
      background: #2A2E37;
      color: #FFD60A;
      font: 600 11px/18px ui-monospace, 'SF Mono', Menlo, monospace;
    }
    .wtp-ancestors,
    .wtp-current {
      font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    }
    .wtp-ancestors {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #A2A9B5;
    }
    .wtp-current {
      flex: none;
      color: #FFD60A;
      font-weight: 600;
    }
    .wtp-hints {
      flex: none;
      padding-left: 10px;
      border-left: 1px solid #2A2E37;
      color: #A2A9B5;
    }
    @media (max-width: 720px) {
      .wtp-hints {
        display: none;
      }
    }

    .wtp-card {
      overflow: hidden;
      border: 1px solid #2A2E37;
      border-top: 3px solid #FFD60A;
      border-radius: 10px;
      background: #16181D;
      color: #ECEEF1;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      font: 400 12px/16px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      text-align: start;
    }
    .wtp-card-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px 8px 8px 12px;
      border-bottom: 1px solid #2A2E37;
    }
    .wtp-card-title {
      font-weight: 600;
    }
    .wtp-card-status {
      color: #A2A9B5;
    }
    .wtp-card-status.is-saved {
      color: #5BD69A;
    }
    .wtp-card-status.is-failed {
      color: #FF8A80;
    }
    .website-to-prompt-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-inline-start: auto;
    }
    .wtp-button {
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid #8A93A3;
      border-radius: 6px;
      background: #2A2E37;
      color: #ECEEF1;
      font: 600 12px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      cursor: pointer;
    }
    .wtp-button:hover {
      background: #343944;
    }
    .wtp-button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .wtp-button:focus-visible {
      outline: 2px solid #FFD60A;
      outline-offset: 2px;
    }
    .wtp-button-primary {
      border-color: #FFD60A;
      background: #FFD60A;
      color: #16181D;
    }
    .wtp-button-primary:hover {
      background: #FFE04D;
    }
    .wtp-button.is-done {
      border-color: #5BD69A;
      background: #5BD69A;
      color: #16181D;
    }
    .wtp-button.is-error {
      border-color: #FF8A80;
      background: #2A2E37;
      color: #FF8A80;
    }
    .website-to-prompt-markdown {
      max-height: min(60vh, 560px);
      margin: 0;
      padding: 12px 14px;
      overflow: auto;
      color: #ECEEF1;
      font: 400 13px/20px ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      tab-size: 2;
    }

    @media (forced-colors: active) {
      #websiteToPrompt_highlightOverlay {
        border-color: Highlight;
      }
    }
  `;

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
    preformattedCode: true
  });

  turndownService.remove(['script', 'style', 'noscript', 'template']);


  // Turndown pads markers to four columns ("-   item"); use one space and indent continuation lines to match.
  turndownService.addRule('listItem', {
    filter: 'li',
    replacement: function (content, node, options) {
      var prefix = options.bulletListMarker + ' ';
      var parent = node.parentNode;
      if (parent.nodeName === 'OL') {
        prefix = parent.start + Array.prototype.indexOf.call(parent.children, node) + '. ';
      }
      var indent = ' '.repeat(prefix.length);
      content = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .split('\n')
        .map(function (line, index) { return index > 0 && line ? indent + line : line; })
        .join('\n');
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    }
  });

  // --- Table conversion rules ---

  function isComplexTable(tableEl) {
    var cells = tableEl.querySelectorAll('td, th');
    for (var i = 0; i < cells.length; i++) {
      if (parseInt(cells[i].getAttribute('colspan') || 1, 10) > 1 ||
          parseInt(cells[i].getAttribute('rowspan') || 1, 10) > 1) {
        return true;
      }
    }
    return tableEl.querySelectorAll('table').length > 0;
  }

  function getCellContent(cellEl) {
    var content = turndownService.turndown(cellEl.innerHTML);
    content = content.replace(/\n/g, ' ').trim();
    content = content.replace(/\|/g, '\\|');
    return content || ' ';
  }

  // Complex tables stay as HTML, so keep only the attributes a table needs and clean every URL.
  var TABLE_ATTRIBUTES = { TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'], A: ['href', 'title'], IMG: ['src', 'alt'] };

  function sanitizeTableHtml(tableEl) {
    var clean = tableEl.cloneNode(true);
    clean.querySelectorAll('script, style, noscript, template, source, button, input, select, textarea').forEach(function (node) { node.remove(); });
    [clean].concat(Array.from(clean.querySelectorAll('*'))).forEach(function (node) {
      var allowed = TABLE_ATTRIBUTES[node.nodeName] || [];
      Array.from(node.attributes).forEach(function (attribute) {
        if (allowed.indexOf(attribute.name) === -1) node.removeAttribute(attribute.name);
      });
      var urlAttribute = node.nodeName === 'A' ? 'href' : node.nodeName === 'IMG' ? 'src' : null;
      if (!urlAttribute || !node.hasAttribute(urlAttribute)) return;
      var url = parseUrl(node.getAttribute(urlAttribute));
      if (!url || url.protocol === 'javascript:' || url.protocol === 'data:') {
        node.removeAttribute(urlAttribute);
      } else {
        node.setAttribute(urlAttribute, url.href);
      }
    });
    return clean.outerHTML;
  }

  // Suppress child elements — the table rule walks the DOM directly
  turndownService.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: function () { return ''; }
  });
  turndownService.addRule('tableRow', {
    filter: 'tr',
    replacement: function () { return ''; }
  });
  turndownService.addRule('tableCell', {
    filter: ['td', 'th'],
    replacement: function () { return ''; }
  });

  turndownService.addRule('table', {
    filter: 'table',
    replacement: function (content, node) {
      var tableEl = node.element || node;

      if (isComplexTable(tableEl)) {
        return '\n\n' + sanitizeTableHtml(tableEl) + '\n\n';
      }

      var rows = Array.from(tableEl.querySelectorAll('tr'));
      if (rows.length === 0) return '';

      var colCount = 0;
      rows.forEach(function (row) {
        colCount = Math.max(colCount, row.children.length);
      });
      if (colCount === 0) return '';

      var rowData = rows.map(function (row) {
        var cells = Array.from(row.children);
        var cellTexts = cells.map(function (cell) {
          return getCellContent(cell);
        });
        while (cellTexts.length < colCount) cellTexts.push(' ');
        return cellTexts;
      });

      var header = '| ' + rowData[0].join(' | ') + ' |';
      var separator = '| ' + rowData[0].map(function () { return '---'; }).join(' | ') + ' |';
      var bodyRows = rowData.slice(1).map(function (row) {
        return '| ' + row.join(' | ') + ' |';
      });

      return '\n\n' + header + '\n' + separator + '\n' + bodyRows.join('\n') + '\n\n';
    }
  });

  // --- Link rule ---

  // Card-style links wrap headings and paragraphs, so flatten their Markdown onto one line.
  function flattenLinkText(markdown) {
    return markdown
      .split('\n')
      .map(function (line) { return line.replace(/^#{1,6}\s+/, '').trim(); })
      .filter(Boolean)
      .join(' ');
  }

  // Parse before checking the scheme, because the URL parser strips tabs and newlines (java&#9;script:).
  function parseUrl(rawUrl) {
    try {
      return new URL(rawUrl.trim(), document.baseURI);
    } catch (error) {
      return null;
    }
  }

  function markdownUrl(url) {
    return url.href.replace(/([()])/g, '\\$1');
  }

  turndownService.addRule('inlineLink', {
    filter: function (node) {
      return node.nodeName === 'A' && node.getAttribute('href');
    },
    replacement: function (content, node) {
      var text = flattenLinkText(content);
      if (!text) return '';
      var url = parseUrl(node.getAttribute('href'));
      if (!url || url.protocol === 'javascript:') return text;
      var title = (node.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      var titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
      return '[' + text + '](' + markdownUrl(url) + titlePart + ')';
    }
  });

  turndownService.addRule('image', {
    filter: 'img',
    replacement: function (content, node) {
      var url = parseUrl(node.getAttribute('src') || '');
      var alt = turndownService.escape((node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim());
      // Inline data URIs can be megabytes of base64, which would swamp the prompt.
      if (!url || !node.getAttribute('src') || url.protocol === 'data:' || url.protocol === 'javascript:') return alt;
      return '![' + alt + '](' + markdownUrl(url) + ')';
    }
  });

  /**
   * Copy the element into an inert document, so the copy runs no page code and fetches nothing.
   * Earlier captures are swapped back for their original elements, so a wider capture converts the real content.
   * An explicit stack instead of recursion, because pages can nest thousands of levels deep.
   */
  function snapshotForConversion(root, inertDocument) {
    const copyNode = (source) => {
      const copy = inertDocument.importNode(source, false);
      if (source.nodeName === 'IMG') {
        // A detached image forgets which srcset or <picture> source it chose, so remember it from the first capture.
        const chosenSrc = chosenImageSrc.get(source) || source.currentSrc;
        if (chosenSrc) {
          chosenImageSrc.set(source, chosenSrc);
          copy.setAttribute('src', chosenSrc);
        }
      }
      return copy;
    };
    const resolve = (node) => originalElementByContainer.get(node) || node;

    const rootSource = resolve(root);
    const rootCopy = copyNode(rootSource);
    const pending = [[rootSource, rootCopy]];
    while (pending.length > 0) {
      const [source, copy] = pending.pop();
      const children = source.nodeName === 'TEMPLATE' ? source.content.childNodes : source.childNodes;
      const target = copy.nodeName === 'TEMPLATE' ? copy.content : copy;
      children.forEach((child) => {
        const childSource = resolve(child);
        const childCopy = copyNode(childSource);
        target.appendChild(childCopy);
        pending.push([childSource, childCopy]);
      });
    }
    return rootCopy;
  }



  function handleRuntimeMessage(request, sender, sendResponse) {
    if (request.type === 'GET_SELECTION_MODE') {
      sendResponse({ enabled: selectionMode });
    } else if (request.type === 'SET_SELECTION_MODE') {
      if (request.enabled) {
        enableSelectionMode();
      } else {
        disableSelectionMode();
      }
      sendResponse({ enabled: selectionMode });
    }
  }

  // After an extension reload the background injects a fresh copy, so the stale copy must let go of the page.
  document.dispatchEvent(new Event('website-to-prompt:dispose'));
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  document.addEventListener('website-to-prompt:dispose', () => {
    disableSelectionMode();
    // Only this copy knows the originals behind its cards, so it puts them back before the new copy takes over.
    // Restoring an outer card can bring back inner cards, so repeat until none are left.
    const findOwnCards = () => [...document.querySelectorAll('.website-to-prompt-container')]
      .filter((container) => originalElementByContainer.has(container));
    for (let cards = findOwnCards(); cards.length > 0; cards = findOwnCards()) cards.forEach(restoreElement);
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch (error) {
      // The old runtime is already gone after a reload, which is the case being cleaned up.
    }
  }, { once: true });

  // --- Element stack helpers ---

  function isExtensionElement(el) {
    if (el.getAttribute && el.getAttribute('data-wtp-internal') === 'true') return true;
    return Boolean(el.closest && el.closest('.website-to-prompt-container'));
  }

  function filterElementStack(rawElements) {
    return rawElements.filter(function (el) {
      if (isExtensionElement(el)) return false;
      if (SKIP_TAGS.has(el.tagName)) return false;
      // An HTML card cannot render inside SVG, so the picker skips to the surrounding HTML element.
      if (el instanceof SVGElement) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return true;
    });
  }

  function rebuildElementStack(x, y) {
    elementStack = filterElementStack(document.elementsFromPoint(x, y));
  }

  function getShortDescriptor(el) {
    var desc = el.tagName.toLowerCase();
    if (el.id) {
      desc += '#' + el.id;
    } else if (el.classList && el.classList.length > 0) {
      desc += '.' + Array.from(el.classList).slice(0, 2).join('.');
    }
    return desc;
  }

  function updateHighlight() {
    var el = elementStack[currentDepthIndex];
    if (!el) {
      highlightOverlay.style.display = 'none';
      breadcrumbBar.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();

    highlightOverlay.style.display = 'block';
    highlightOverlay.style.width = rect.width + 'px';
    highlightOverlay.style.height = rect.height + 'px';
    highlightOverlay.style.top = rect.top + 'px';
    highlightOverlay.style.left = rect.left + 'px';

    updateBreadcrumb(el);
  }

  function appendText(parent, text, className) {
    var span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
  }

  function updateBreadcrumb(el) {
    var ancestors = [];
    var current = el.parentElement;
    while (current && current !== document.documentElement && ancestors.length < 4) {
      ancestors.unshift(getShortDescriptor(current));
      current = current.parentElement;
    }

    // Built with textContent because ids and class names come from the page.
    breadcrumbBar.replaceChildren();
    appendText(breadcrumbBar, currentDepthIndex + 1 + '/' + elementStack.length, 'wtp-depth');
    appendText(breadcrumbBar, ancestors.map(function (ancestor) { return ancestor + ' › '; }).join(''), 'wtp-ancestors');
    appendText(breadcrumbBar, getShortDescriptor(el), 'wtp-current');
    appendText(breadcrumbBar, 'Scroll to widen or narrow · Click to save · Esc to cancel', 'wtp-hints');
    breadcrumbBar.style.display = 'flex';
  }

  // --- Selection Mode helpers ---

  function enableSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    createPicker();
  }

  function disableSelectionMode() {
    if (!selectionMode) return;
    selectionMode = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('wheel', handleWheel, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    removePicker();
    elementStack = [];
    currentDepthIndex = 0;
    stackLocked = false;
    accumulatedDelta = 0;
  }

  function handleMouseMove(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    if (stackLocked) {
      var dx = lastMouseX - lockOriginX;
      var dy = lastMouseY - lockOriginY;
      if (Math.sqrt(dx * dx + dy * dy) < 5) return;
      stackLocked = false;
      accumulatedDelta = 0;
    }

    rebuildElementStack(lastMouseX, lastMouseY);
    currentDepthIndex = 0;
    updateHighlight();
  }

  function handleWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (elementStack.length === 0) return;

    if (!stackLocked) {
      stackLocked = true;
      lockOriginX = lastMouseX;
      lockOriginY = lastMouseY;
    }

    accumulatedDelta += e.deltaY;

    if (Math.abs(accumulatedDelta) >= 50) {
      var steps = Math.sign(accumulatedDelta);
      currentDepthIndex = Math.max(0, Math.min(elementStack.length - 1, currentDepthIndex + steps));
      accumulatedDelta = 0;
      updateHighlight();
    }
  }

  function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();

    var selectedElement = elementStack[currentDepthIndex];
    try {
      if (selectedElement && selectedElement.isConnected) {
        transformElement(selectedElement);
      }
    } finally {
      disableSelectionMode();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      disableSelectionMode();
    }
  }

  function flashButton(button, label, className) {
    button.textContent = label;
    button.classList.remove('is-done', 'is-error');
    button.classList.add(className);
    clearTimeout(button.flashTimeout);
    button.flashTimeout = setTimeout(() => {
      button.textContent = button.dataset.label;
      button.classList.remove(className);
    }, 1500);
  }

  async function writeClipboard(text) {
    if (navigator.clipboard) return navigator.clipboard.writeText(text);
    // Plain http pages have no Clipboard API, so copy through a one-off copy event the page cannot overwrite.
    let wroteClipboard = false;
    const onCopy = (event) => {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      event.stopImmediatePropagation();
      wroteClipboard = true;
    };
    document.addEventListener('copy', onCopy, true);
    try {
      if (!document.execCommand('copy') || !wroteClipboard) {
        throw new Error('The browser or page blocked the copy.');
      }
    } finally {
      document.removeEventListener('copy', onCopy, true);
    }
  }

  function createControlButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wtp-button';
    button.textContent = label;
    button.dataset.label = label;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(button);
    });
    return button;
  }

  function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
  }

  /**
   * Convert the clicked element to Markdown, save it as a prompt, and show the Markdown in its place.
   */
  function transformElement(element) {
    const snapshotHtml = snapshotForConversion(element, document.implementation.createHTMLDocument('')).outerHTML;
    const markdown = turndownService.turndown(snapshotHtml).trim();
    const prompt = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      sourceUrl: window.location.href,
      elementPath: getElementSelectorPath(element),
      elementContent: snapshotHtml,
      generatedPrompt: markdown,
      tags: [],
    };

    const container = document.createElement('div');
    container.className = 'website-to-prompt-container';
    const shadowRoot = createShadowRoot(container);

    const status = createTextElement('span', 'wtp-card-status', 'Saving…');
    status.setAttribute('role', 'status');

    const controls = document.createElement('div');
    controls.className = 'website-to-prompt-controls';
    const copyButton = createControlButton('Copy Markdown', (button) => {
      writeClipboard(markdown)
        .then(() => flashButton(button, 'Copied', 'is-done'))
        .catch((error) => {
          console.warn('WebsiteToPrompt: copy failed', error);
          flashButton(button, 'Copy failed', 'is-error');
        });
    });
    copyButton.classList.add('wtp-button-primary');
    const restoreButton = createControlButton('Restore', () => restoreElement(container));
    restoreButton.title = 'Put the original page section back. The saved prompt stays saved.';
    let savedPromptId;
    const openButton = createControlButton('Open in Saved prompts', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', promptId: savedPromptId });
    });
    openButton.disabled = true;
    controls.append(copyButton, restoreButton, openButton);

    const header = document.createElement('div');
    header.className = 'wtp-card-header';
    header.append(createTextElement('span', 'wtp-card-title', 'Markdown'), status, controls);

    const markdownText = createTextElement('pre', 'website-to-prompt-markdown', markdown);
    markdownText.dir = 'auto';

    const card = document.createElement('div');
    card.className = 'wtp-card';
    card.append(header, markdownText);
    shadowRoot.appendChild(card);

    originalElementByContainer.set(container, element);
    element.replaceWith(container);

    savePrompt(prompt, (saved) => {
      status.textContent = saved ? '✓ Saved' : 'Not saved. Copy it now.';
      status.classList.add(saved ? 'is-saved' : 'is-failed');
      // The deep link names the prompt only after the background confirms it exists.
      if (saved) savedPromptId = prompt.id;
      openButton.disabled = !saved;
    });
  }

  function savePrompt(prompt, onResult) {
    try {
      chrome.runtime.sendMessage({ type: 'SAVE_PROMPT', prompt }, (response) => {
        const saved = Boolean(response && response.ok);
        if (!saved) console.error('WebsiteToPrompt: failed to save prompt', chrome.runtime.lastError || response);
        onResult(saved);
      });
    } catch (error) {
      // sendMessage throws when the extension was reloaded after this page loaded.
      console.error('WebsiteToPrompt: failed to save prompt', error);
      onResult(false);
    }
  }

  function restoreElement(container) {
    const originalElement = originalElementByContainer.get(container);
    if (originalElement) {
      container.replaceWith(originalElement);
    } else {
      container.remove();
    }
  }

  /**
   * Build a (somewhat) unique selector path for the element.
   */
  function getElementSelectorPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let subSelector = current.tagName.toLowerCase();

      if (current.id) {
        subSelector += `#${current.id}`;
      } else if (current.classList.length) {
        subSelector += '.' + Array.from(current.classList).join('.');
      }

      if (current.parentElement) {
        const index = Array.from(current.parentElement.children).indexOf(current) + 1;
        subSelector += `:nth-child(${index})`;
      }

      parts.unshift(subSelector);
      current = current.parentElement;
    }
    return parts.join('>');
  }

  function createShadowRoot(host) {
    host.setAttribute('data-wtp-internal', 'true');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = IN_PAGE_CSS;
    shadowRoot.appendChild(style);
    return shadowRoot;
  }

  function createPicker() {
    pickerHost = document.createElement('div');
    pickerHost.popover = 'manual';
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'websiteToPrompt_highlightOverlay';
    breadcrumbBar = document.createElement('div');
    breadcrumbBar.id = 'websiteToPrompt_breadcrumbBar';
    createShadowRoot(pickerHost).append(highlightOverlay, breadcrumbBar);
    document.documentElement.appendChild(pickerHost);
    // The top layer keeps the picker above every z-index and above an open modal dialog.
    pickerHost.showPopover();
  }

  function removePicker() {
    if (pickerHost) {
      pickerHost.remove();
      pickerHost = null;
      highlightOverlay = null;
      breadcrumbBar = null;
    }
  }
})();
