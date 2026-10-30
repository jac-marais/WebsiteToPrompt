document.addEventListener('DOMContentLoaded', () => {
  const toggleSelectionBtn = document.getElementById('toggleSelectionBtn');
  const selectionHelp = document.getElementById('selectionHelp');
  const popupStatus = document.getElementById('popupStatus');
  let isSelectionEnabled = false;

  function renderToggle() {
    toggleSelectionBtn.textContent = isSelectionEnabled ? 'Cancel selection' : 'Select content';
    toggleSelectionBtn.setAttribute('aria-pressed', String(isSelectionEnabled));
    selectionHelp.textContent = isSelectionEnabled
      ? 'Move over the page to choose content. Esc cancels.'
      : 'Hover to highlight. Scroll to widen or narrow. Click to save. Esc cancels.';
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
        popupStatus.textContent = enabled
          ? "Couldn't start selection on this page. Try a regular webpage, or reload and try again."
          : "Couldn't cancel selection. Return to the page and press Esc.";
        return;
      }
      popupStatus.textContent = '';
      isSelectionEnabled = enabled;
      renderToggle();
      // Close the popup so the user can start hovering over the page right away.
      if (enabled) window.close();
    });
  });

  document.getElementById('openDashboardBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  });
});
