/**
 * background.js — MV3 Service Worker
 * Relays messages between popup and content script,
 * and tracks the active automation tab.
 */

let activeTabId = null;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'start' || message.action === 'stop') {
    // Forward from popup to content script
    if (activeTabId !== null) {
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Tab may have navigated; ignore
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
      return true; // async response
    }
  }

  if (message.action === 'setActiveTab') {
    activeTabId = message.tabId;
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'statusUpdate') {
    // Forward status from content script → popup
    chrome.runtime.sendMessage({ action: 'statusUpdate', status: message.status }).catch(() => {
      // Popup may be closed, ignore
    });
    return false;
  }
});

// When a tab navigates within eClass, keep tracking it
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    tabId === activeTabId &&
    changeInfo.status === 'complete' &&
    tab.url &&
    tab.url.includes('eclass.yuntech.edu.tw')
  ) {
    // Notify content script that page has reloaded (it re-injects automatically)
    // Content script will pick up from storage on next load
  }
});
