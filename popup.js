'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const toggleEl   = document.getElementById('toggle');
  const speedEl    = document.getElementById('speed');
  const speedValEl = document.getElementById('speed-val');
  const typosEl    = document.getElementById('typos');

  // Populate controls from persisted state
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
    if (!state) return;
    toggleEl.checked = state.enabled ?? true;
    speedEl.value    = state.speed   ?? 50;
    speedValEl.textContent = speedEl.value;
    typosEl.checked  = state.typos  ?? false;
  });

  toggleEl.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_STATE', enabled: toggleEl.checked });
  });

  speedEl.addEventListener('input', () => {
    speedValEl.textContent = speedEl.value;
    chrome.runtime.sendMessage({ type: 'SET_STATE', speed: Number(speedEl.value) });
  });

  typosEl.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_STATE', typos: typosEl.checked });
  });
});
