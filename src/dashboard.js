class DashboardManager {
  constructor() {
    this.state = {
      viewMode: 'url',
      prompts: [],
      selectedGroup: null,
      selectedPromptIds: new Set(),
      detailsPromptId: null,
      lastClickedPromptId: null,
      searchQuery: '',
    };

    this.elements = {
      groupsPanel: document.getElementById('groupsPanel'),
      promptsPanel: document.getElementById('promptsPanel'),
      promptsList: document.getElementById('promptsList'),
      detailsPanel: document.getElementById('detailsPanel'),
      searchInput: document.querySelector('.search-input'),
      viewButtons: document.querySelectorAll('.view-mode-btn'),
      selectionControls: document.getElementById('selectionControls'),
      selectedCount: document.querySelector('.selected-count'),
      selectAllBtn: document.querySelector('.select-all-btn'),
      exportBtn: document.querySelector('.export-btn'),
      deleteBtn: document.querySelector('.delete-btn'),
      status: document.getElementById('dashboardStatus'),
      panelResizer: document.getElementById('panelResizer'),
    };

    this.pendingPromptId = new URLSearchParams(window.location.search).get('promptId');

    this.bindEvents();
    this.initializeResizer();
    this.loadPrompts();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.wtpPrompts) {
        this.setPrompts(changes.wtpPrompts.newValue || []);
      }
    });
  }

  bindEvents() {
    this.elements.viewButtons.forEach((btn) => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    this.elements.searchInput.addEventListener(
      'input',
      this.debounce((e) => this.handleSearch(e.target.value), 300)
    );

    this.elements.promptsList.addEventListener('click', (e) => {
      const promptItem = e.target.closest('.prompt-item');
      if (!promptItem) return;
      const toggle = e.ctrlKey || e.metaKey || e.target.classList.contains('prompt-checkbox');
      this.handlePromptClick(promptItem.dataset.id, { shiftKey: e.shiftKey, toggle });
    });

    this.elements.groupsPanel.addEventListener('click', (e) => {
      const groupItem = e.target.closest('.group-item');
      if (groupItem) this.selectGroup(groupItem.dataset.group);
    });

    this.elements.selectAllBtn.addEventListener('click', () => this.selectAllInGroup());
    this.elements.exportBtn.addEventListener('click', () => this.exportSelected());
    this.elements.deleteBtn.addEventListener('click', () => this.deleteSelected());
  }

  loadPrompts() {
    chrome.storage.local.get('wtpPrompts', (res) => {
      if (chrome.runtime.lastError) {
        console.error('Error retrieving wtpPrompts from storage:', chrome.runtime.lastError);
        // An unread collection is not an empty one, so say it failed instead of showing the empty state.
        this.renderMessage("Couldn't load saved prompts", 'Your prompts are still stored on this device.', 'Try again', () =>
          this.loadPrompts()
        );
        return;
      }
      this.setPrompts((res && res.wtpPrompts) || []);
    });
  }

  setPrompts(prompts) {
    this.state.prompts = [...prompts].sort((a, b) => b.timestamp - a.timestamp);

    const existingIds = new Set(this.state.prompts.map((prompt) => prompt.id));
    this.state.selectedPromptIds = new Set([...this.state.selectedPromptIds].filter((id) => existingIds.has(id)));
    if (!existingIds.has(this.state.detailsPromptId)) this.state.detailsPromptId = null;

    if (this.pendingPromptId && existingIds.has(this.pendingPromptId)) {
      this.selectPromptById(this.pendingPromptId);
      this.pendingPromptId = null;
      return;
    }
    this.render();
  }

  switchView(newMode) {
    this.state.viewMode = newMode;
    this.state.selectedGroup = null;
    this.state.selectedPromptIds.clear();
    this.state.detailsPromptId = null;
    this.elements.viewButtons.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === newMode));
    });
    this.render();
  }

  getGroupKeyForPrompt(prompt) {
    if (this.state.viewMode === 'url') {
      try {
        return new URL(prompt.sourceUrl).hostname || 'unknown';
      } catch (error) {
        return 'unknown';
      }
    }
    if (this.state.viewMode === 'date') {
      return new Date(prompt.timestamp).toLocaleDateString();
    }
    return 'All prompts';
  }

  // Prompts are sorted newest first, so groups come out ordered by their most recent prompt.
  groupPrompts() {
    const grouped = new Map();
    this.filterPrompts(this.state.prompts).forEach((prompt) => {
      const groupKey = this.getGroupKeyForPrompt(prompt);
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(prompt);
    });
    return grouped;
  }

  handleSearch(query) {
    this.state.searchQuery = query.trim().toLowerCase();
    this.render();
  }

  filterPrompts(prompts) {
    const query = this.state.searchQuery;
    if (!query) return prompts;
    return prompts.filter((prompt) =>
      [prompt.sourceUrl, prompt.generatedPrompt, prompt.elementContent].some((field) =>
        (field || '').toLowerCase().includes(query)
      )
    );
  }

  getVisiblePrompts() {
    return this.groupPrompts().get(this.state.selectedGroup) || [];
  }

  handlePromptClick(promptId, { shiftKey, toggle }) {
    const selectedIds = this.state.selectedPromptIds;
    const visibleIds = this.getVisiblePrompts().map((prompt) => prompt.id);
    const anchorIndex = visibleIds.indexOf(this.state.lastClickedPromptId);

    if (shiftKey && anchorIndex !== -1) {
      const clickedIndex = visibleIds.indexOf(promptId);
      visibleIds
        .slice(Math.min(anchorIndex, clickedIndex), Math.max(anchorIndex, clickedIndex) + 1)
        .forEach((id) => selectedIds.add(id));
    } else if (toggle) {
      if (selectedIds.has(promptId)) {
        selectedIds.delete(promptId);
      } else {
        selectedIds.add(promptId);
      }
    } else {
      selectedIds.clear();
      selectedIds.add(promptId);
    }

    this.state.lastClickedPromptId = promptId;
    this.state.detailsPromptId = promptId;
    this.render();
  }

  selectGroup(groupKey) {
    this.state.selectedGroup = groupKey;
    this.state.selectedPromptIds.clear();
    this.state.detailsPromptId = null;
    this.state.lastClickedPromptId = null;
    this.render();
  }

  selectAllInGroup() {
    this.getVisiblePrompts().forEach((prompt) => this.state.selectedPromptIds.add(prompt.id));
    this.render();
  }

  selectPromptById(promptId) {
    const prompt = this.state.prompts.find((item) => item.id === promptId);
    if (!prompt) return;
    this.state.searchQuery = '';
    this.elements.searchInput.value = '';
    this.state.selectedGroup = this.getGroupKeyForPrompt(prompt);
    this.state.selectedPromptIds = new Set([promptId]);
    this.state.detailsPromptId = promptId;
    this.state.lastClickedPromptId = promptId;
    this.render();
  }

  render() {
    const grouped = this.groupPrompts();

    // Fall back to the newest group and prompt when the current choice was deleted or filtered out.
    if (!grouped.has(this.state.selectedGroup)) {
      this.state.selectedGroup = grouped.keys().next().value ?? null;
      this.state.selectedPromptIds.clear();
      this.state.detailsPromptId = null;
    }
    const visiblePrompts = grouped.get(this.state.selectedGroup) || [];
    // Copy and Delete must only act on prompts the user can see.
    const visibleIds = new Set(visiblePrompts.map((prompt) => prompt.id));
    this.state.selectedPromptIds = new Set([...this.state.selectedPromptIds].filter((id) => visibleIds.has(id)));
    if (!visibleIds.has(this.state.detailsPromptId)) this.state.detailsPromptId = null;
    if (!this.state.detailsPromptId && visiblePrompts.length > 0) {
      this.state.detailsPromptId = visiblePrompts[0].id;
      this.state.selectedPromptIds.add(visiblePrompts[0].id);
    }

    this.renderGroupsList(grouped);
    this.renderPromptsList(visiblePrompts);
    this.renderSelectionControls(visiblePrompts);
    this.renderDetails();
  }

  renderGroupsList(grouped) {
    this.elements.groupsPanel.replaceChildren(
      ...[...grouped].map(([groupKey, prompts]) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'group-item';
        element.classList.toggle('selected', groupKey === this.state.selectedGroup);
        element.setAttribute('aria-current', String(groupKey === this.state.selectedGroup));
        element.dataset.group = groupKey;
        element.textContent = groupKey + ' ';

        const count = document.createElement('span');
        count.className = 'group-count';
        count.textContent = `(${prompts.length})`;
        element.appendChild(count);
        return element;
      })
    );
  }

  // Rows and details show the first Markdown line as a title, because a list of timestamps tells nothing apart.
  getPromptLines(prompt) {
    return (prompt.generatedPrompt || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  getPromptTitle(prompt) {
    const [firstLine] = this.getPromptLines(prompt);
    if (!firstLine) return 'Empty capture';
    return firstLine.replace(/^(#{1,6}|[-*+>]|\d+\.)\s+/, '') || firstLine;
  }

  createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
  }

  renderMessage(heading, body, buttonLabel, onButtonClick) {
    const message = document.createElement('div');
    message.className = 'empty-state';
    message.setAttribute('role', 'status');
    message.append(this.createTextElement('h2', '', heading), this.createTextElement('p', '', body));
    if (buttonLabel) {
      const button = this.createTextElement('button', 'button', buttonLabel);
      button.type = 'button';
      button.addEventListener('click', onButtonClick);
      message.appendChild(button);
    }
    this.elements.promptsList.replaceChildren(message);
  }

  renderPromptsList(visiblePrompts) {
    if (visiblePrompts.length === 0) {
      if (this.state.searchQuery) {
        this.renderMessage('No matching prompts', 'Try a shorter phrase or a website name.', 'Clear search', () => {
          this.elements.searchInput.value = '';
          this.handleSearch('');
        });
      } else {
        this.renderMessage(
          'No saved prompts yet',
          'Open a webpage, click the WebsiteToPrompt icon in the toolbar, and choose Select content. Click a section to save its Markdown here.'
        );
      }
      return;
    }

    // Rerendering replaces the rows, so keep keyboard focus on the checkbox the user was on.
    const focusedPromptId = document.activeElement?.closest?.('.prompt-item')?.dataset.id;

    this.elements.promptsList.replaceChildren(
      ...visiblePrompts.map((prompt) => {
        const isSelected = this.state.selectedPromptIds.has(prompt.id);
        const title = this.getPromptTitle(prompt);
        const element = document.createElement('div');
        element.className = 'prompt-item';
        element.classList.toggle('selected', isSelected);
        element.classList.toggle('viewing', prompt.id === this.state.detailsPromptId);
        element.dataset.id = prompt.id;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'prompt-checkbox';
        checkbox.checked = isSelected;
        checkbox.setAttribute('aria-label', `Select ${title}`);

        const text = document.createElement('div');
        text.className = 'prompt-text';
        text.append(
          this.createTextElement('div', 'prompt-title', title),
          this.createTextElement('div', 'prompt-content', this.getPromptLines(prompt).slice(1).join(' ')),
          this.createTextElement('div', 'prompt-meta', new Date(prompt.timestamp).toLocaleString())
        );

        element.append(checkbox, text);
        return element;
      })
    );

    if (focusedPromptId) {
      const row = [...this.elements.promptsList.children].find((item) => item.dataset.id === focusedPromptId);
      row?.querySelector('.prompt-checkbox').focus();
    }
  }

  renderSelectionControls(visiblePrompts) {
    const count = this.state.selectedPromptIds.size;
    this.elements.selectionControls.classList.toggle('active', visiblePrompts.length > 0);
    this.elements.selectedCount.textContent = `${count} selected`;
    this.elements.exportBtn.textContent = `Copy as one prompt (${count})`;
    this.elements.exportBtn.disabled = count === 0;
    this.elements.deleteBtn.disabled = count === 0;
  }

  renderDetails() {
    const prompt = this.state.prompts.find((p) => p.id === this.state.detailsPromptId);
    if (!prompt) {
      this.elements.detailsPanel.replaceChildren();
      return;
    }

    const title = this.createTextElement('h2', 'details-title', this.getPromptTitle(prompt));
    const meta = this.createTextElement('p', 'details-meta', `Captured ${new Date(prompt.timestamp).toLocaleString()}`);

    // Only web addresses become links; anything else shows as plain text.
    const source = this.createTextElement('p', 'details-meta details-source', 'Source: ');
    const isWebUrl = /^https?:/i.test(prompt.sourceUrl);
    const sourceLink = this.createTextElement(isWebUrl ? 'a' : 'span', '', prompt.sourceUrl);
    if (isWebUrl) {
      sourceLink.href = prompt.sourceUrl;
      sourceLink.target = '_blank';
      sourceLink.rel = 'noopener noreferrer';
    }
    source.appendChild(sourceLink);

    const markdownHeader = document.createElement('div');
    markdownHeader.className = 'details-section-header';
    const copyBtn = this.createTextElement('button', 'button copy-prompt-btn', 'Copy Markdown');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => this.copyWithFeedback(copyBtn, prompt.generatedPrompt));
    markdownHeader.append(this.createTextElement('h3', '', 'Markdown'), copyBtn);

    const content = this.createTextElement('pre', 'details-content', prompt.generatedPrompt);
    content.dir = 'auto';

    this.elements.detailsPanel.replaceChildren(title, meta, source, markdownHeader, content);
  }

  showStatus(message, isError = false) {
    this.elements.status.textContent = message;
    this.elements.status.classList.toggle('is-error', isError);
    clearTimeout(this.statusTimeout);
    this.statusTimeout = setTimeout(() => {
      this.elements.status.textContent = '';
    }, 4000);
  }

  flashButtonText(button, text) {
    const originalText = button.dataset.label || button.textContent;
    button.dataset.label = originalText;
    button.textContent = text;
    clearTimeout(button.flashTimeout);
    button.flashTimeout = setTimeout(() => {
      button.textContent = originalText;
    }, 2000);
  }

  copyWithFeedback(button, text) {
    navigator.clipboard
      .writeText(text)
      .then(() => this.flashButtonText(button, 'Copied'))
      .catch((error) => {
        console.error('Copy failed:', error);
        this.flashButtonText(button, 'Copy failed');
      });
  }

  getSelectedPrompts() {
    return this.state.prompts.filter((p) => this.state.selectedPromptIds.has(p.id));
  }

  exportSelected() {
    const selectedPrompts = this.getSelectedPrompts();
    if (selectedPrompts.length === 0) return;

    const markdownWithXml = selectedPrompts
      .map((p) => `<website_section name="${p.sourceUrl.replace(/"/g, '&quot;')}">\n${p.generatedPrompt}\n</website_section>`)
      .join('\n\n');
    const noun = selectedPrompts.length === 1 ? 'prompt' : 'prompts';
    navigator.clipboard
      .writeText(markdownWithXml)
      .then(() => this.showStatus(`Copied ${selectedPrompts.length} saved ${noun} as one prompt.`))
      .catch((error) => {
        console.error('Copy failed:', error);
        this.showStatus("Couldn't copy. Try again.", true);
      });
  }

  deleteSelected() {
    const promptIds = [...this.state.selectedPromptIds];
    if (promptIds.length === 0) return;
    const noun = promptIds.length === 1 ? 'saved prompt' : 'saved prompts';
    if (!confirm(`Delete ${promptIds.length} ${noun}? This cannot be undone.`)) return;

    // The background worker owns all storage writes; the storage listener re-renders once it lands.
    chrome.runtime.sendMessage({ type: 'DELETE_PROMPTS', promptIds }, (response) => {
      if (!response || !response.ok) {
        console.error('Failed to delete prompts:', chrome.runtime.lastError || response);
        this.showStatus("Couldn't delete the selected prompts. Try again.", true);
      }
    });
  }

  debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  initializeResizer() {
    let isResizing = false;
    let startX;
    let startWidth;

    this.elements.panelResizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.pageX;
      startWidth = this.elements.promptsPanel.offsetWidth;
      this.elements.panelResizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(200, startWidth + e.pageX - startX);
      this.elements.promptsPanel.style.width = `${newWidth}px`;
    });

    const stopResize = () => {
      if (!isResizing) return;
      isResizing = false;
      this.elements.panelResizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('mouseleave', stopResize);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.dashboardManager = new DashboardManager();
});
