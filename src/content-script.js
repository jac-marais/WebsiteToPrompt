(function () {
  // This content script handles selection highlighting and element transformations.
  console.log('WebsiteToPrompt content script loaded.');

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

  const SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'BR']);

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

  function htmlToMarkdown(html) {
    // remove script tags
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // remove style tags
    html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    const markdown = turndownService.turndown(html).trim();
    return markdown.replace(/\n{3,}/g, '\n\n').trim();
  }

  // Inject minimal CSS for highlighting
  injectStyles();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 1) Toggle selection mode
    if (request.type === 'TOGGLE_SELECTION_MODE') {
      selectionMode = request.enabled;
      if (selectionMode) {
        enableSelectionMode();
      } else {
        disableSelectionMode();
      }
      sendResponse({ status: 'selectionModeUpdated', enabled: selectionMode });
    }
  });

  // --- Element stack helpers ---

  function filterElementStack(rawElements) {
    return rawElements.filter(function (el) {
      if (el.getAttribute && el.getAttribute('data-wtp-internal') === 'true') return false;
      if (el.id && el.id.startsWith('websiteToPrompt_')) return false;
      if (el.classList && el.classList.contains('website-to-prompt-container')) return false;
      if (SKIP_TAGS.has(el.tagName)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return true;
    });
  }

  function rebuildElementStack(x, y) {
    var raw = document.elementsFromPoint(x, y);
    elementStack = filterElementStack(raw);
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
    if (elementStack.length === 0 || !elementStack[currentDepthIndex]) {
      if (highlightOverlay) highlightOverlay.style.display = 'none';
      if (breadcrumbBar) breadcrumbBar.style.display = 'none';
      return;
    }
    var el = elementStack[currentDepthIndex];
    var rect = el.getBoundingClientRect();

    highlightOverlay.style.display = 'block';
    highlightOverlay.style.width = rect.width + 'px';
    highlightOverlay.style.height = rect.height + 'px';
    highlightOverlay.style.top = (rect.top + window.scrollY) + 'px';
    highlightOverlay.style.left = (rect.left + window.scrollX) + 'px';

    updateBreadcrumb();
  }

  function updateBreadcrumb() {
    if (!breadcrumbBar) return;
    var el = elementStack[currentDepthIndex];
    if (!el) return;

    var descriptor = getShortDescriptor(el);
    var ancestors = [];
    var current = el.parentElement;
    var depth = 0;
    while (current && current !== document.documentElement && depth < 4) {
      ancestors.unshift(getShortDescriptor(current));
      current = current.parentElement;
      depth++;
    }

    var path = ancestors
      .map(function (a) { return '<span style="color:#aaa">' + a + '</span>'; })
      .concat(['<span style="color:#87CEEB;font-weight:bold">' + descriptor + '</span>'])
      .join(' <span style="color:#555"> &rsaquo; </span> ');

    var counter = '<span style="color:#ffd700;margin-right:12px">[' +
      (currentDepthIndex + 1) + '/' + elementStack.length + ']</span>';

    var hint = currentDepthIndex === 0
      ? '<span style="color:#666;margin-left:12px;font-size:11px">scroll to cycle layers</span>'
      : '';

    breadcrumbBar.innerHTML = counter + path + hint;
    breadcrumbBar.style.display = 'block';
  }

  // --- Selection Mode helpers ---

  function enableSelectionMode() {
    console.log('Enabling selection mode...');
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    createOverlayElement();
    createBreadcrumbBar();
  }

  function disableSelectionMode() {
    console.log('Disabling selection mode...');
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
    if (!selectionMode) return;

    e.preventDefault();
    e.stopPropagation();

    var selectedElement = elementStack[currentDepthIndex];
    if (selectedElement && selectedElement.isConnected) {
      transformElement(selectedElement);
    }

    disableSelectionMode();
    selectionMode = false;
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      disableSelectionMode();
      selectionMode = false;
    }
  }

  /**
   * Convert the clicked element to Markdown, store original HTML, and replace in DOM.
   * Also auto-save the data to local storage.
   */
  function transformElement(element) {
    const originalHTML = element.outerHTML;
    const selectorPath = getElementSelectorPath(element);
    const uniqueId = window.location.pathname + '//' + selectorPath;

    // Convert using Turndown
    const markdown = htmlToMarkdown(originalHTML);

    // Save originalHTML in localStorage for revert functionality
    localStorage.setItem(uniqueId, originalHTML);

    // NEW: auto-save prompt data to chrome.storage.local
    autoSavePrompt({
      url: window.location.href,
      elementPath: selectorPath,
      elementHtml: originalHTML,
      generatedPrompt: markdown,
    });

    // Create container to display the Markdown
    const container = document.createElement('div');
    container.className = 'website-to-prompt-container';
    container.setAttribute('data-wtp-id', uniqueId);
    // container.setAttribute('contenteditable', 'true');
    container.textContent = markdown;

    // Add the control buttons (Copy, Revert, Open Dashboard)
    const controls = document.createElement('div');
    controls.className = 'website-to-prompt-controls';
    // controls.setAttribute('contenteditable', 'false');
    controls.style.cursor = 'default';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    styleButton(copyBtn);
    copyBtn.addEventListener('click', () => {
      navigator.clipboard
        .writeText(markdown)
        .then(() => {
          const originalText = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          copyBtn.style.backgroundColor = '#e6ffe6';
          setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.backgroundColor = '#fff';
          }, 1500);
        })
        .catch((err) => {
          console.warn('Copy failed', err);
          copyBtn.textContent = 'Copy failed';
          copyBtn.style.backgroundColor = '#ffe6e6';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.style.backgroundColor = '#fff';
          }, 1500);
        });
    });

    const revertBtn = document.createElement('button');
    revertBtn.textContent = 'Revert';
    styleButton(revertBtn);
    revertBtn.addEventListener('click', () => {
      revertBtn.textContent = 'Reverting...';
      revertBtn.style.backgroundColor = '#fff3e6';
      setTimeout(() => {
        revertElement(container);
      }, 300);
    });

    // Add new Dashboard button
    const dashboardBtn = document.createElement('button');
    dashboardBtn.textContent = 'Open Dashboard';
    styleButton(dashboardBtn);
    dashboardBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'openDashboard' });
    });

    controls.appendChild(copyBtn);
    controls.appendChild(revertBtn);
    controls.appendChild(dashboardBtn);
    container.appendChild(controls);

    // Replace original element with the new container
    element.parentNode.replaceChild(container, element);
  }

  /**
   * Auto-save the selected element data to chrome.storage.local,
   * using an enhanced data model. After saving, notify the Dashboard.
   */
  function autoSavePrompt({ url, elementPath, elementHtml, generatedPrompt }) {
    const record = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      sourceUrl: url,
      elementPath,
      elementContent: elementHtml,
      generatedPrompt,
      tags: [],
    };

    chrome.storage.local.get(['wtpPrompts'], (res) => {
      let allPrompts = res.wtpPrompts || [];
      allPrompts.push(record);
      chrome.storage.local.set({ wtpPrompts: allPrompts }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error saving prompt data:', chrome.runtime.lastError);
        } else {
          console.log('Prompt auto-saved:', record);
          // Notify the dashboard so it can reload immediately
          chrome.runtime.sendMessage({ type: 'PROMPT_SAVED' });
        }
      });
    });
  }

  /**
   * Restore the original HTML from localStorage, removing the Markdown container.
   */
  function revertElement(container) {
    const uniqueId = container.getAttribute('data-wtp-id');
    const originalHTML = localStorage.getItem(uniqueId);
    if (originalHTML) {
      container.insertAdjacentHTML('beforebegin', originalHTML);
      container.remove();
      localStorage.removeItem(uniqueId);
    } else {
      // If we have no localStorage, just remove the container
      container.remove();
    }
  }

  /**
   * Build a (somewhat) unique selector path for the element.
   */
  function getElementSelectorPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.tagName.toLowerCase() === 'html') return 'html';

    let path = '';
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let subSelector = current.tagName.toLowerCase();

      // If it has an ID, use #id
      if (current.id) {
        subSelector += `#${current.id}`;
      }
      // Else, if it has classes, use .class1.class2...
      else if (current.className) {
        const classes = current.className.trim().split(/\s+/).join('.');
        if (classes.length) {
          subSelector += `.${classes}`;
        }
      }

      // :nth-child
      if (current.parentNode) {
        const siblings = Array.from(current.parentNode.children);
        const index = siblings.indexOf(current) + 1;
        subSelector += `:nth-child(${index})`;
      }

      path = path ? subSelector + '>' + path : subSelector;
      current = current.parentElement;
    }

    return path;
  }

  // Create the highlight overlay (semi-transparent rectangle).
  function createOverlayElement() {
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'websiteToPrompt_highlightOverlay';
    highlightOverlay.setAttribute('data-wtp-internal', 'true');
    highlightOverlay.style.position = 'absolute';
    highlightOverlay.style.zIndex = '999999';
    highlightOverlay.style.backgroundColor = 'rgba(135,206,235, 0.3)';
    highlightOverlay.style.pointerEvents = 'none';
    highlightOverlay.style.border = '2px solid #00f';
    highlightOverlay.style.display = 'none';
    highlightOverlay.style.transition = 'top 0.1s ease-out, left 0.1s ease-out, width 0.1s ease-out, height 0.1s ease-out';
    document.body.appendChild(highlightOverlay);
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
      'z-index: 1000000',
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
    document.body.appendChild(breadcrumbBar);
  }

  function removeBreadcrumbBar() {
    if (breadcrumbBar) {
      breadcrumbBar.remove();
      breadcrumbBar = null;
    }
  }

  /**
   * Inject the basic CSS for the Markdown container and controls.
   */
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .website-to-prompt-container {
        position: relative;
        font-family: monospace;
        white-space: pre-wrap;
        padding: 1em;
      }
      .website-to-prompt-controls {
        position: absolute;
        top: 5px;
        right: 5px;
      }
    `;
    document.head.appendChild(style);
  }

  function styleButton(btn) {
    btn.style.cssText = `
      padding: 4px 8px;
      margin: 0 4px;
      cursor: pointer;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #fff;
      color: black !important;
    `;
  }
})();
