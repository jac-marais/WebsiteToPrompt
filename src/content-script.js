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
  let stylesInjected = false;

  // Original elements are kept so Revert restores the live node with its event listeners.
  const originalElementByContainer = new WeakMap();

  const SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'BR', 'BODY']);

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
    preformattedCode: true,
  });

  turndownService.remove(['script', 'style', 'noscript', 'template']);

  // A selection that contains an earlier capture must not include that capture's buttons.
  turndownService.remove(function (node) {
    return node.classList && node.classList.contains('website-to-prompt-controls');
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
        return '\n\n' + tableEl.outerHTML + '\n\n';
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

  function toAbsoluteUrl(href) {
    try {
      return new URL(href, document.baseURI).href;
    } catch (error) {
      return href;
    }
  }

  turndownService.addRule('inlineLink', {
    filter: function (node) {
      return node.nodeName === 'A' && node.getAttribute('href');
    },
    replacement: function (content, node) {
      var text = flattenLinkText(content);
      var href = node.getAttribute('href').trim();
      if (!text) return '';
      if (/^javascript:/i.test(href)) return text;
      var url = toAbsoluteUrl(href).replace(/([()])/g, '\\$1');
      var title = (node.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      var titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
      return '[' + text + '](' + url + titlePart + ')';
    }
  });

  turndownService.addRule('image', {
    filter: 'img',
    replacement: function (content, node) {
      var src = (node.getAttribute('src') || '').trim();
      var alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      // Inline data URIs can be megabytes of base64, which would swamp the prompt.
      if (!src || /^data:/i.test(src)) return alt;
      return '![' + alt + '](' + toAbsoluteUrl(src).replace(/([()])/g, '\\$1') + ')';
    }
  });

  function htmlToMarkdown(element) {
    // The HTML string keeps the element's own tag and parses in an inert document.
    return turndownService.turndown(element.outerHTML).replace(/\n{3,}/g, '\n\n').trim();
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
  });

  // --- Element stack helpers ---

  function isExtensionElement(el) {
    if (el.getAttribute && el.getAttribute('data-wtp-internal') === 'true') return true;
    return Boolean(el.closest && el.closest('.website-to-prompt-container'));
  }

  function filterElementStack(rawElements) {
    return rawElements.filter(function (el) {
      if (isExtensionElement(el)) return false;
      if (SKIP_TAGS.has(el.tagName)) return false;
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

  function appendStyledText(parent, text, cssText) {
    var span = document.createElement('span');
    span.style.cssText = cssText;
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
    appendStyledText(breadcrumbBar, '[' + (currentDepthIndex + 1) + '/' + elementStack.length + ']', 'color:#ffd700;margin-right:12px');
    ancestors.forEach(function (ancestor) {
      appendStyledText(breadcrumbBar, ancestor, 'color:#aaa');
      appendStyledText(breadcrumbBar, ' › ', 'color:#555');
    });
    appendStyledText(breadcrumbBar, getShortDescriptor(el), 'color:#87CEEB;font-weight:bold');
    appendStyledText(breadcrumbBar, 'scroll to pick a parent · click to capture · Esc to cancel', 'color:#888;margin-left:12px;font-size:11px');
    breadcrumbBar.style.display = 'block';
  }

  // --- Selection Mode helpers ---

  function enableSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    createOverlayElement();
    createBreadcrumbBar();
  }

  function disableSelectionMode() {
    if (!selectionMode) return;
    selectionMode = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('wheel', handleWheel, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    removeOverlayElement();
    removeBreadcrumbBar();
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

  function flashButton(button, label, backgroundColor) {
    button.textContent = label;
    button.style.backgroundColor = backgroundColor;
    setTimeout(() => {
      button.textContent = button.dataset.label;
      button.style.backgroundColor = '#fff';
    }, 1500);
  }

  function createControlButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.label = label;
    styleButton(button);
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(button);
    });
    return button;
  }

  /**
   * Convert the clicked element to Markdown, save it as a prompt, and show the Markdown in its place.
   */
  function transformElement(element) {
    const markdown = htmlToMarkdown(element);
    const promptId = Date.now() + '_' + Math.random().toString(36).slice(2);

    savePrompt({
      id: promptId,
      timestamp: Date.now(),
      sourceUrl: window.location.href,
      elementPath: getElementSelectorPath(element),
      elementContent: element.outerHTML,
      generatedPrompt: markdown,
      tags: [],
    });

    injectStyles();
    const container = document.createElement('div');
    container.className = 'website-to-prompt-container';

    const markdownText = document.createElement('div');
    markdownText.className = 'website-to-prompt-markdown';
    markdownText.textContent = markdown;

    const controls = document.createElement('div');
    controls.className = 'website-to-prompt-controls';
    controls.appendChild(createControlButton('Copy', (button) => {
      navigator.clipboard
        .writeText(markdown)
        .then(() => flashButton(button, 'Copied!', '#e6ffe6'))
        .catch((error) => {
          console.warn('WebsiteToPrompt: copy failed', error);
          flashButton(button, 'Copy failed', '#ffe6e6');
        });
    }));
    controls.appendChild(createControlButton('Revert', () => revertElement(container)));
    controls.appendChild(createControlButton('Open Dashboard', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', promptId });
    }));

    container.appendChild(controls);
    container.appendChild(markdownText);

    originalElementByContainer.set(container, element);
    element.replaceWith(container);
  }

  function savePrompt(prompt) {
    chrome.runtime.sendMessage({ type: 'SAVE_PROMPT', prompt }, (response) => {
      if (!response || !response.ok) {
        console.error('WebsiteToPrompt: failed to save prompt', chrome.runtime.lastError || response);
      }
    });
  }

  function revertElement(container) {
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

  // Create the highlight overlay (semi-transparent rectangle).
  function createOverlayElement() {
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'websiteToPrompt_highlightOverlay';
    highlightOverlay.setAttribute('data-wtp-internal', 'true');
    highlightOverlay.style.cssText = [
      'position: fixed',
      'z-index: 2147483646',
      'background-color: rgba(135, 206, 235, 0.3)',
      'pointer-events: none',
      'border: 2px solid #00f',
      'box-sizing: border-box',
      'display: none',
      'transition: top 0.1s ease-out, left 0.1s ease-out, width 0.1s ease-out, height 0.1s ease-out',
    ].join('; ');
    document.documentElement.appendChild(highlightOverlay);
  }

  function removeOverlayElement() {
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
  }

  function createBreadcrumbBar() {
    breadcrumbBar = document.createElement('div');
    breadcrumbBar.id = 'websiteToPrompt_breadcrumbBar';
    breadcrumbBar.setAttribute('data-wtp-internal', 'true');
    breadcrumbBar.style.cssText = [
      'position: fixed',
      'bottom: 0',
      'left: 0',
      'right: 0',
      'z-index: 2147483647',
      'background: rgba(0, 0, 0, 0.85)',
      'color: #fff',
      "font-family: 'SF Mono', Monaco, Menlo, monospace",
      'font-size: 13px',
      'padding: 8px 16px',
      'pointer-events: none',
      'display: none',
      'border-top: 1px solid rgba(255, 255, 255, 0.1)',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
    ].join('; ');
    document.documentElement.appendChild(breadcrumbBar);
  }

  function removeBreadcrumbBar() {
    if (breadcrumbBar) {
      breadcrumbBar.remove();
      breadcrumbBar = null;
    }
  }

  /**
   * Inject the CSS for the Markdown container the first time something is captured on this page.
   */
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .website-to-prompt-container {
        all: initial;
        display: block;
        position: relative;
        margin: 0.5em 0;
        padding: 1em;
        border: 1px dashed #87CEEB;
        border-radius: 6px;
        background: #fff;
        color: #1a202c;
      }
      .website-to-prompt-controls {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 0.5em;
      }
      .website-to-prompt-markdown {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: #1a202c;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function styleButton(btn) {
    btn.style.cssText = `
      all: initial;
      padding: 4px 8px;
      margin: 0 4px;
      cursor: pointer;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #fff;
      color: #000;
      font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;
  }
})();
