const CONTENT_SCRIPT_FILES = ['libs/turndown.js', 'content-script.js'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'enableSelectionMode',
    title: 'Select content',
    contexts: ['all'],
  });
  chrome.contextMenus.create({
    id: 'openDashboard',
    title: 'Open saved prompts',
    contexts: ['all'],
  });
});

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  return tab.id;
}

/**
 * Send a message to the tab's content script, injecting it first if the tab predates the extension.
 */
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function getSelectionMode(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_SELECTION_MODE' });
    return Boolean(response && response.enabled);
  } catch (error) {
    // No content script in the tab means selection mode cannot be on.
    return false;
  }
}

function setSelectionMode(tabId, enabled) {
  return sendToContentScript(tabId, { type: 'SET_SELECTION_MODE', enabled });
}

function openDashboard(promptId) {
  let dashboardUrl = chrome.runtime.getURL('dashboard.html');
  if (promptId) {
    dashboardUrl += `?promptId=${encodeURIComponent(promptId)}`;
  }
  return chrome.tabs.create({ url: dashboardUrl });
}

// Every storage write goes through this chain so that saves and deletes from different tabs cannot overwrite each other.
let storageWriteChain = Promise.resolve();

function updateStoredPrompts(transformPrompts) {
  const write = storageWriteChain.then(async () => {
    const { wtpPrompts = [] } = await chrome.storage.local.get('wtpPrompts');
    await chrome.storage.local.set({ wtpPrompts: transformPrompts(wtpPrompts) });
  });
  storageWriteChain = write.catch(() => {});
  return write;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'enableSelectionMode' && tab?.id !== undefined) {
    setSelectionMode(tab.id, true).catch((error) => console.warn('Cannot enable selection mode:', error));
  } else if (info.menuItemId === 'openDashboard') {
    openDashboard();
  }
});

const messageHandlers = {
  async GET_SELECTION_MODE() {
    return { enabled: await getSelectionMode(await getActiveTabId()) };
  },
  async SET_SELECTION_MODE(request) {
    await setSelectionMode(await getActiveTabId(), request.enabled);
    return { enabled: request.enabled };
  },
  async OPEN_DASHBOARD(request) {
    await openDashboard(request.promptId);
    return {};
  },
  async SAVE_PROMPT(request) {
    await updateStoredPrompts((prompts) => [...prompts, request.prompt]);
    return {};
  },
  async DELETE_PROMPTS(request) {
    const idsToDelete = new Set(request.promptIds);
    await updateStoredPrompts((prompts) => prompts.filter((prompt) => !idsToDelete.has(prompt.id)));
    return {};
  },
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = messageHandlers[request.type];
  if (!handler) return false;
  handler(request)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
