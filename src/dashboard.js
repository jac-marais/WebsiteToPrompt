class DashboardManager {
  constructor() {
    // State
    this.state = {
      viewMode: 'url',
      prompts: [],
      selectedGroup: null,
      selectedPrompts: new Set(),
      searchQuery: '',
    };

    // Cache DOM elements
    this.elements = {
      groupsPanel: document.getElementById('groupsPanel'),
      promptsPanel: document.getElementById('promptsPanel'),
      detailsPanel: document.getElementById('detailsPanel'),
      searchInput: document.querySelector('.search-input'),
      viewButtons: document.querySelectorAll('.view-mode-btn'),
      selectionControls: document.getElementById('selectionControls'),
      panelResizer: document.getElementById('panelResizer'),
    };

    this.pendingPromptId = new URLSearchParams(window.location.search).get('promptId');

    // Bind event handlers
    this.bindEvents();

    // Initial load
    this.loadPrompts();

    // Listen for "PROMPT_SAVED" message to reload data
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'PROMPT_SAVED') {
        this.loadPrompts();
      }
    });

    this.initializeResizer();
  }

  // Event Binding
  bindEvents() {
    // View mode switching
    this.elements.viewButtons.forEach((btn) => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    // Search
    this.elements.searchInput.addEventListener(
      'input',
      this.debounce((e) => this.handleSearch(e.target.value), 300)
    );

    // Prompt item clicks (selection, details)
    this.elements.promptsPanel.addEventListener('click', (e) => {
      const promptItem = e.target.closest('.prompt-item');
      if (promptItem) {
        this.handlePromptClick(promptItem, e);
      }
    });

    // Group selection
    this.elements.groupsPanel.addEventListener('click', (e) => {
      const groupItem = e.target.closest('.group-item');
      if (groupItem) {
        this.selectGroup(groupItem.dataset.group);
      }
    });

    // Selection controls (select all, export, delete)
    const exportBtn = this.elements.promptsPanel.querySelector('.export-btn');
    const deleteBtn = this.elements.promptsPanel.querySelector('.delete-btn');
    const selectAllBtn = this.elements.promptsPanel.querySelector('.select-all-btn');

    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => this.selectAllInGroup());
    }
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportSelected());
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.deleteSelected());
    }
  }

  // Data Loading
  async loadPrompts() {
    chrome.storage.local.get(['wtpPrompts'], (res) => {
      if (chrome.runtime.lastError) {
        console.error('Error retrieving wtpPrompts from storage:', chrome.runtime.lastError);
        this.state.prompts = [];
      } else {
        this.state.prompts = res.wtpPrompts || [];
      }

      if (this.pendingPromptId && this.selectPromptById(this.pendingPromptId)) {
        this.pendingPromptId = null;
        return;
      }

      this.renderDashboard();
    });
  }

  // View Management
  switchView(newMode) {
    this.state.viewMode = newMode;
    this.state.selectedGroup = null;
    this.state.selectedPrompts.clear();

    // Update UI
    this.elements.viewButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === newMode);
    });

    this.renderDashboard();
  }

  // Grouping Logic
  groupPrompts() {
    const grouped = {};

    if (this.state.viewMode === 'all') {
      // Sort all prompts by timestamp
      const sortedPrompts = [...this.state.prompts].sort((a, b) => b.timestamp - a.timestamp);
      grouped['all'] = sortedPrompts;
    } else if (this.state.viewMode === 'url' || this.state.viewMode === 'date') {
      this.state.prompts.forEach((prompt) => {
        const groupKey = this.getGroupKeyForPrompt(prompt);
        if (!grouped[groupKey]) grouped[groupKey] = [];
        grouped[groupKey].push(prompt);
      });
    } else {
      return {};
    }

    return grouped;
  }

  getGroupKeyForPrompt(prompt) {
    if (this.state.viewMode === 'url') {
      try {
        return new URL(prompt.sourceUrl).hostname;
      } catch (error) {
        return 'unknown';
      }
    }

    if (this.state.viewMode === 'date') {
      return new Date(prompt.timestamp).toLocaleDateString();
    }

    if (this.state.viewMode === 'all') {
      return 'all';
    }

    return null;
  }

  // Search
  handleSearch(query) {
    this.state.searchQuery = query.toLowerCase();
    this.renderDashboard();
  }

  filterPrompts(prompts) {
    if (!this.state.searchQuery) return prompts;

    return prompts.filter(
      (prompt) =>
        prompt.sourceUrl.toLowerCase().includes(this.state.searchQuery) ||
        prompt.generatedPrompt.toLowerCase().includes(this.state.searchQuery) ||
        prompt.elementContent.toLowerCase().includes(this.state.searchQuery)
    );
  }

  // Selection
  handlePromptClick(promptElement, event) {
    const promptId = promptElement.dataset.id;

    if (event.shiftKey && this.lastSelectedPrompt) {
      // Range selection
      const allItems = Array.from(this.elements.promptsPanel.querySelectorAll('.prompt-item'));
      const start = allItems.indexOf(this.lastSelectedPrompt);
      const end = allItems.indexOf(promptElement);
      const range = allItems.slice(Math.min(start, end), Math.max(start, end) + 1);

      range.forEach((item) => {
        this.state.selectedPrompts.add(item.dataset.id);
        item.classList.add('selected');
      });
    } else if (event.ctrlKey || event.metaKey) {
      // Toggle selection
      if (this.state.selectedPrompts.has(promptId)) {
        this.state.selectedPrompts.delete(promptId);
        promptElement.classList.remove('selected');
      } else {
        this.state.selectedPrompts.add(promptId);
        promptElement.classList.add('selected');
      }
    } else {
      // Single selection
      this.state.selectedPrompts.clear();
      this.elements.promptsPanel.querySelectorAll('.prompt-item').forEach((item) => {
        item.classList.remove('selected');
      });
      this.state.selectedPrompts.add(promptId);
      promptElement.classList.add('selected');
    }

    this.lastSelectedPrompt = promptElement;
    this.updateSelectionControls();
    this.showDetails(promptId);
  }

  selectGroup(groupId) {
    this.state.selectedGroup = groupId;
    this.state.selectedPrompts.clear();
    this.renderPromptsList();
  }

  // Provide a helper to select all in the current group
  selectAllInGroup() {
    if (!this.state.selectedGroup) return;
    const grouped = this.groupPrompts();
    const promptsInGroup = grouped[this.state.selectedGroup] || [];
    const filtered = this.filterPrompts(promptsInGroup);

    filtered.forEach((prompt) => {
      this.state.selectedPrompts.add(prompt.id);
    });

    this.renderPromptsList();
    this.updateSelectionControls();
  }

  // Details Display
  showDetails(promptId) {
    const prompt = this.state.prompts.find((p) => p.id === promptId);
    if (!prompt) return;

    const details = `
        <div class="details-section">
            <div>${new Date(prompt.timestamp).toLocaleString()}</div>
        </div>
  
        <div class="details-section">
            <h3>Source</h3>
            <a href="${prompt.sourceUrl}" target="_blank" rel="noopener noreferrer">${
      prompt.sourceUrl
    }</a>
        </div>
  
        <div class="details-section">
            <h3>Prompt <button class="copy-prompt-btn" style="margin-left: 10px; padding: 0px 5px;" data-prompt="${this.escapeHtml(
              prompt.generatedPrompt
            )}">Copy</button></h3>
            <div class="details-content whitespace-pre-wrap">${this.escapeHtml(
              prompt.generatedPrompt
            )}</div>
        </div>
      `;

    this.elements.detailsPanel.innerHTML = details;

    // Add click handler for the copy button
    const copyBtn = this.elements.detailsPanel.querySelector('.copy-prompt-btn');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard
        .writeText(prompt.generatedPrompt)
        .then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 2000);
        })
        .catch((err) => console.error('Failed to copy:', err));
    });
  }

  // Selection Controls
  updateSelectionControls() {
    const count = this.state.selectedPrompts.size;
    if (count > 0) {
      this.elements.selectionControls.classList.add('active');
      this.elements.selectionControls.querySelector('.selected-count').textContent = `${count} selected`;
    } else {
      this.elements.selectionControls.classList.remove('active');
    }
  }

  // Rendering
  renderDashboard() {
    const grouped = this.groupPrompts();

    // Auto-select first group if none selected
    if (!this.state.selectedGroup && Object.keys(grouped).length > 0) {
      const firstGroup = Object.keys(grouped)[0];
      this.state.selectedGroup = firstGroup;

      const firstPrompt = grouped[firstGroup][0];
      if (firstPrompt) {
        this.state.selectedPrompts.clear();
        this.state.selectedPrompts.add(firstPrompt.id);
        setTimeout(() => {
          this.showDetails(firstPrompt.id);
          this.updateSelectionControls();
        }, 50);
      }
    }

    this.renderGroupsList(grouped);
    this.renderPromptsList();
  }

  renderGroupsList(grouped) {
    const fragment = document.createDocumentFragment();

    Object.entries(grouped).forEach(([group, prompts]) => {
      // Filter prompts by search
      const filtered = this.filterPrompts(prompts);
      if (filtered.length === 0) return;

      const element = document.createElement('div');
      element.className = 'group-item';
      element.dataset.group = group;
      if (group === this.state.selectedGroup) {
        element.classList.add('selected');
      }

      element.innerHTML = `
          ${this.escapeHtml(group)}
          <span class="text-gray-500 text-sm">(${filtered.length})</span>
        `;
      fragment.appendChild(element);
    });

    this.elements.groupsPanel.innerHTML = '';
    this.elements.groupsPanel.appendChild(fragment);
  }

  renderPromptsList() {
    const fragment = document.createDocumentFragment();
    const grouped = this.groupPrompts();

    // Keep reference so we can reattach after clearing
    const selectionControls = this.elements.selectionControls;

    // Clear the prompts panel
    this.elements.promptsPanel.innerHTML = '';

    // Re-append the selection controls at the top
    this.elements.promptsPanel.appendChild(selectionControls);
    selectionControls.classList.remove('active');

    if (this.state.selectedGroup && grouped[this.state.selectedGroup]) {
      const prompts = this.filterPrompts(grouped[this.state.selectedGroup]);
      prompts.forEach((prompt) => {
        const element = document.createElement('div');
        element.className = 'prompt-item';
        element.dataset.id = prompt.id;

        if (this.state.selectedPrompts.has(prompt.id)) {
          element.classList.add('selected');
        }

        element.innerHTML = `
            <div class="prompt-meta">${new Date(prompt.timestamp).toLocaleString()}</div>
            <div class="prompt-content">${this.escapeHtml(prompt.generatedPrompt)}</div>
          `;

        fragment.appendChild(element);
      });
    }

    this.elements.promptsPanel.appendChild(fragment);
  }

  // Utility Functions
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Export selected prompts
  exportSelected() {
    try {
      const selectedPrompts = this.state.prompts.filter((p) => this.state.selectedPrompts.has(p.id));
      if (selectedPrompts.length === 0) return;

      const markdownWithXml = selectedPrompts
        .map((p) => `<website_section name="${p.sourceUrl}">\n${p.generatedPrompt}\n</website_section>`)
        .join('\n\n');

      navigator.clipboard
        .writeText(markdownWithXml)
        .then(() => {
          console.log('Exported to clipboard');
        })
        .catch((err) => {
          console.error('Export failed:', err);
        });
    } catch (error) {
      console.error('Export error:', error);
    }
  }

  // Delete selected prompts
  async deleteSelected() {
    try {
      const selectedIds = Array.from(this.state.selectedPrompts);
      this.state.prompts = this.state.prompts.filter((p) => !selectedIds.includes(p.id));

      chrome.storage.local.set({ wtpPrompts: this.state.prompts }, () => {
        if (chrome.runtime.lastError) {
          console.error('Failed to remove selected prompts:', chrome.runtime.lastError);
        }
      });

      this.state.selectedPrompts.clear();
      this.renderDashboard();
    } catch (error) {
      console.error('Delete error:', error);
    }
  }

  selectPromptById(promptId) {
    const prompt = this.state.prompts.find((item) => item.id === promptId);
    if (!prompt) return false;

    const groupKey = this.getGroupKeyForPrompt(prompt);
    if (!groupKey) return false;

    this.state.selectedGroup = groupKey;
    this.state.selectedPrompts.clear();
    this.state.selectedPrompts.add(promptId);

    this.renderDashboard();
    this.showDetails(promptId);
    this.updateSelectionControls();

    return true;
  }

  initializeResizer() {
    let isResizing = false;
    let startX;
    let startWidth;

    const startResize = (e) => {
      isResizing = true;
      startX = e.pageX;
      startWidth = this.elements.promptsPanel.offsetWidth;
      this.elements.panelResizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };

    const resize = (e) => {
      if (!isResizing) return;
      const diff = e.pageX - startX;
      const newWidth = Math.max(200, startWidth + diff); // set a min 200px
      this.elements.promptsPanel.style.width = `${newWidth}px`;
    };

    const stopResize = () => {
      isResizing = false;
      this.elements.panelResizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    this.elements.panelResizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('mouseleave', stopResize);
  }
}

// Initialize the dashboard when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  try {
    // Create and initialize the dashboard manager
    const dashboard = new DashboardManager();

    // Add error handler for unexpected errors
    window.addEventListener('error', (event) => {
      console.error('Dashboard error:', event.error);
    });

    // Export the dashboard instance for debugging
    window.dashboardManager = dashboard;
  } catch (error) {
    console.error('Dashboard initialization failed:', error);
  }
});

document.addEventListener('DOMContentLoaded', function () {
  const exportBtn = document.querySelector('.export-btn');
  const selectAllBtn = document.querySelector('.select-all-btn');
  const deleteBtn = document.querySelector('.delete-btn');

  function addFeedback(button, feedbackText, originalText) {
    button.addEventListener('click', function () {
      // Change the button text to provide feedback
      button.textContent = feedbackText;
      // Revert the text back after 2 seconds
      setTimeout(() => {
        button.textContent = originalText;
      }, 2000);
    });
  }

  addFeedback(exportBtn, 'Copied!', 'Copy');
  addFeedback(selectAllBtn, 'Selected All!', 'Select All');
  addFeedback(deleteBtn, 'Deleted!', 'Delete');
});
