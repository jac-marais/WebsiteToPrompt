document.addEventListener('DOMContentLoaded', () => {
  const toggleSelectionBtn = document.getElementById('toggleSelectionBtn');
  const popupStatus = document.getElementById('popupStatus');
  let isSelectionEnabled = false;

  function renderToggle() {
    toggleSelectionBtn.textContent = isSelectionEnabled ? 'Disable Selection' : 'Enable Selection';
  }

  function showStatus(message) {
    popupStatus.textContent = message;
    popupStatus.hidden = !message;
  }

  renderToggle();
  chrome.runtime.sendMessage({ type: 'GET_SELECTION_MODE' }, (response) => {
    isSelectionEnabled = Boolean(response && response.enabled);
    renderToggle();
  });

  toggleSelectionBtn.addEventListener('click', () => {
    const enabled = !isSelectionEnabled;
    chrome.runtime.sendMessage({ type: 'SET_SELECTION_MODE', enabled }, (response) => {
      if (!response || !response.ok) {
        showStatus('This page does not allow extensions, so content cannot be selected here.');
        return;
      }
      isSelectionEnabled = enabled;
      renderToggle();
      // Close the popup so the user can start hovering over the page right away.
      if (enabled) window.close();
    });
  });

  document.getElementById('openDashboardBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  });

  document.getElementById('githubLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://github.com/jac-marais/WebsiteToPrompt' });
  });
});
