console.log('WebsiteToPrompt background script running...');

// Track whether Selection Mode is enabled
let inspectModeEnabled = false;

// Create the context menus when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  // 1) Selection Mode menu
  chrome.contextMenus.create({
    id: 'toggleSelectionMode',
    title: 'Selection Mode',
    contexts: ['all'],
  });

  // 2) New menu item: Open the WebsiteToPrompt Dashboard
  chrome.contextMenus.create({
    id: 'openDashboard',
    title: 'Open Dashboard',
    contexts: ['all'],
  });
});

/**
 * Toggle Selection Mode and notify content scripts + popup.
 */
function toggleSelectionMode(tabId, newState) {
  inspectModeEnabled = newState;

  // Notify the content script in the current tab (if available)
  if (tabId === undefined || tabId < 0) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'TOGGLE_SELECTION_MODE',
          enabled: inspectModeEnabled,
        });
      }
    });
  } else {
    chrome.tabs.sendMessage(tabId, {
      type: 'TOGGLE_SELECTION_MODE',
      enabled: inspectModeEnabled,
    });
  }

  // Notify the popup (if it's open)
  chrome.runtime.sendMessage({
    type: 'INSPECT_MODE_STATUS',
    enabled: inspectModeEnabled,
  });
}

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggleSelectionMode') {
    toggleSelectionMode(tab?.id, true);
  } else if (info.menuItemId === 'openDashboard') {
    // Open the new dashboard page in a new tab
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});

// Listen for messages from popup or any other script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TOGGLE_SELECTION_MODE') {
    toggleSelectionMode(sender.tab?.id, request.enabled);
    sendResponse({ status: 'ok' });
  } else if (request.type === 'REQUEST_INSPECT_MODE_STATUS') {
    // Popup asking for the current Selection Mode status
    sendResponse({ enabled: inspectModeEnabled });
  } else if (request.type === 'openDashboard') {
    let dashboardUrl = chrome.runtime.getURL('dashboard.html');
    if (request.promptId) {
      dashboardUrl += `?promptId=${encodeURIComponent(request.promptId)}`;
    }
    chrome.tabs.create({ url: dashboardUrl });
    sendResponse({ status: 'openedDashboard' });
  } else {
    // Currently unused/no-op
    sendResponse({ status: 'no-op' });
  }
});
