(function () {
  // This content script handles selection highlighting and element transformations.
  console.log('WebsiteToPrompt content script loaded.');

  let selectionMode = false;
  let highlightOverlay = null;

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

  // Selection Mode helpers
  function enableSelectionMode() {
    console.log('Enabling selection mode...');
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('click', handleClick, true);
    createOverlayElement();
  }

  function disableSelectionMode() {
    console.log('Disabling selection mode...');
    document.removeEventListener('mouseover', handleMouseOver, true);
    document.removeEventListener('mouseout', handleMouseOut, true);
    document.removeEventListener('click', handleClick, true);
    removeOverlayElement();
  }

  function handleMouseOver(e) {
    if (!highlightOverlay) return;
    const target = e.target;
    const rect = target.getBoundingClientRect();

    highlightOverlay.style.display = 'block';
    highlightOverlay.style.width = rect.width + 'px';
    highlightOverlay.style.height = rect.height + 'px';
    highlightOverlay.style.top = rect.top + window.scrollY + 'px';
    highlightOverlay.style.left = rect.left + window.scrollX + 'px';
  }

  function handleMouseOut() {
    if (!highlightOverlay) return;
    highlightOverlay.style.display = 'none';
  }

  function handleClick(e) {
    if (!selectionMode) return;

    // Prevent normal page interactions
    e.preventDefault();
    e.stopPropagation();

    // Convert + replace the clicked element
    transformElement(e.target);

    // OPTIONAL: If you want to disable auto after one selection, uncomment:
    disableSelectionMode();
    selectionMode = false;
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
    highlightOverlay.style.position = 'absolute';
    highlightOverlay.style.zIndex = '999999';
    highlightOverlay.style.backgroundColor = 'rgba(135,206,235, 0.3)';
    highlightOverlay.style.pointerEvents = 'none';
    highlightOverlay.style.border = '2px solid #00f';
    highlightOverlay.style.display = 'none';
    document.body.appendChild(highlightOverlay);
  }

  function removeOverlayElement() {
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
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
