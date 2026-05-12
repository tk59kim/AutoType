'use strict';

const DEFAULTS = { enabled: true, speed: 50, typos: false };

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#4CAF50' : '#9E9E9E' });
}

function init() {
  chrome.storage.local.get(Object.keys(DEFAULTS), (stored) => {
    const patch = {};
    for (const [key, def] of Object.entries(DEFAULTS)) {
      if (stored[key] === undefined) patch[key] = def;
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
    updateBadge(stored.enabled !== false);
  });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['enabled', 'speed', 'typos'], sendResponse);
    return true;
  }

  if (msg.type === 'SET_STATE') {
    const patch = {};
    if (msg.enabled !== undefined) patch.enabled = msg.enabled;
    if (msg.speed   !== undefined) patch.speed   = msg.speed;
    if (msg.typos   !== undefined) patch.typos   = msg.typos;
    chrome.storage.local.set(patch, () => {
      if (patch.enabled !== undefined) updateBadge(patch.enabled);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'TOGGLE_ENABLED') {
    chrome.storage.local.get('enabled', ({ enabled }) => {
      const next = !enabled;
      chrome.storage.local.set({ enabled: next }, () => {
        updateBadge(next);
        sendResponse({ enabled: next });
      });
    });
    return true;
  }
});
