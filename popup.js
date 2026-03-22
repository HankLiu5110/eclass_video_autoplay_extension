/**
 * popup.js — Popup logic for eClass 自動播放助手
 * Handles speed setting, messaging to content script, and status updates.
 */

const speedSlider = document.getElementById('speedSlider');
const speedValue  = document.getElementById('speedValue');
const startBtn    = document.getElementById('startBtn');
const stopBtn     = document.getElementById('stopBtn');
const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const logBox      = document.getElementById('logBox');
const speedWarning= document.getElementById('speedWarning');

let isRunning = false;

// ── Load saved settings ──────────────────────────────────────────────
chrome.storage.local.get({ playbackSpeed: 2.0, isRunning: false }, (data) => {
  speedSlider.value = data.playbackSpeed;
  speedValue.textContent = `${parseFloat(data.playbackSpeed).toFixed(2).replace(/\.?0+$/, '')}x`;
  
  if (data.playbackSpeed > 2.0) {
    speedWarning.classList.remove('hidden');
  } else {
    speedWarning.classList.add('hidden');
  }

  if (data.isRunning) {
    setRunningState(true);
  }
});

// ── Speed slider ─────────────────────────────────────────────────────
speedSlider.addEventListener('input', () => {
  const val = parseFloat(speedSlider.value);
  const display = val % 1 === 0 ? `${val}.0x` : `${val}x`;
  speedValue.textContent = display;
  chrome.storage.local.set({ playbackSpeed: val });

  if (val > 2.0) {
    speedWarning.classList.remove('hidden');
  } else {
    speedWarning.classList.add('hidden');
  }
});

// ── Start button ─────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!tab.url || !tab.url.includes('eclass.yuntech.edu.tw')) {
    addLog('請先前往 eClass 課程頁面。', 'error');
    setStatus('錯誤：非 eClass 頁面', 'error');
    return;
  }

  const speed = parseFloat(speedSlider.value);
  chrome.storage.local.set({ playbackSpeed: speed, isRunning: true });

  // Notify background of active tab
  chrome.runtime.sendMessage({ action: 'setActiveTab', tabId: tab.id });

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'start', speed });
    if (response && response.ok) {
      setRunningState(true);
      addLog(`開始自動播放（速度：${speed}x）`, 'info');
      setStatus('正在執行...', 'active');
    } else {
      addLog(response?.error || '無法連接 content script。', 'error');
      setStatus('連接失敗', 'error');
    }
  } catch (e) {
    addLog('無法連接到頁面，請重新整理後再試。', 'error');
    setStatus('連接失敗', 'error');
  }
});

// ── Stop button ──────────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.storage.local.set({ isRunning: false });

  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'stop' }).catch(() => {});
  }

  setRunningState(false);
  addLog('已手動停止。', 'warn');
  setStatus('已停止', 'idle');
});

// ── Listen for status updates from content script ────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'statusUpdate') {
    const { type, text } = message;
    setStatus(text, type || 'active');
    addLog(text, type || 'info');

    if (type === 'done' || type === 'error') {
      setRunningState(false);
      chrome.storage.local.set({ isRunning: false });
    }
  }
});

// ── Helpers ──────────────────────────────────────────────────────────
function setRunningState(running) {
  isRunning = running;
  startBtn.disabled = running;
  stopBtn.disabled  = !running;
  if (!running && statusDot.classList.contains('active')) {
    statusDot.classList.remove('active');
  }
}

function setStatus(text, type = 'idle') {
  statusText.textContent = text || '';
  statusDot.className = 'status-dot';
  if (type === 'active' || type === 'info' || type === 'warn') {
    statusDot.classList.add('active'); // 保持綠燈閃爍
  }
  if (type === 'done')    statusDot.classList.add('done');
  if (type === 'error')   statusDot.classList.add('error');
}

function addLog(text, type = 'info') {
  // Remove placeholder if present
  const placeholder = logBox.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  entry.textContent = `[${timestamp}] ${text}`;
  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;
}
