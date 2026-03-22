/**
 * content.js — eClass 自動播放助手
 * Core automation logic injected into eClass pages.
 *
 * Flow:
 *  1. Listen for start/stop from popup via chrome.runtime.onMessage
 *  2. mainLoop() → findAndClickNextVideo() → watchVideoAndHandleType()
 *  3. Repeat until all videos are done or user stops
 */

'use strict';

// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════
let isRunning        = false;
let PLAYBACK_SPEED   = 2.0;
let stopRequested    = false;
let activeTimers     = [];   // track all setTimeout IDs for cleanup

// The base courseware URL we return to after each video
let coursewareBaseUrl = null;

// ═══════════════════════════════════════════════════════════
//  Messaging — listen for popup commands
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'start') {
    if (isRunning) {
      sendResponse({ ok: false, error: '已在執行中' });
      return false;
    }
    PLAYBACK_SPEED   = message.speed || 2.0;
    isRunning        = true;
    coursewareBaseUrl = window.location.href;
    chrome.storage.local.set({ autoState: 'scanning', coursewareBaseUrl });
    log('info', `開始自動播放（速度 ${PLAYBACK_SPEED}x）`);
    mainLoop();
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'stop') {
    stopRequested = true;
    isRunning     = false;
    clearAllTimers();
    log('warn', '收到停止指令，正在停止...');
    sendResponse({ ok: true });
    return false;
  }
});

// ═══════════════════════════════════════════════════════════
//  Logging
// ═══════════════════════════════════════════════════════════
function log(type, text) {
  const prefix = { info: '📘', warn: '⚠️', done: '✅', error: '❌' }[type] || '📘';
  console.log(`[eClass AutoPlay] ${prefix} ${text}`);
  // Send to popup
  chrome.runtime.sendMessage({ action: 'statusUpdate', type, text }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════
//  Timer helpers (so we can clear all on stop)
// ═══════════════════════════════════════════════════════════
function safeSetTimeout(fn, ms) {
  const id = setTimeout(() => {
    activeTimers = activeTimers.filter(t => t !== id);
    fn();
  }, ms);
  activeTimers.push(id);
  return id;
}

function clearAllTimers() {
  activeTimers.forEach(id => clearTimeout(id));
  activeTimers = [];
}

function sleep(ms) {
  return new Promise(resolve => safeSetTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════
//  Wait for element helpers
// ═══════════════════════════════════════════════════════════
/**
 * Polls for an element matching selector, up to timeoutMs.
 * Returns the element or null if timeout.
 */
function waitForElement(selector, timeoutMs = 15000, rootEl = document) {
  return new Promise(resolve => {
    const existing = rootEl.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const deadline = Date.now() + timeoutMs;
    const obs = new MutationObserver(() => {
      const el = rootEl.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); return; }
      if (Date.now() > deadline) { obs.disconnect(); resolve(null); }
    });
    obs.observe(rootEl, { childList: true, subtree: true });

    // Fallback timeout
    safeSetTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
  });
}

/**
 * Polls for ALL elements matching selector to appear (at least minCount).
 */
function waitForElements(selector, minCount = 1, timeoutMs = 15000) {
  return new Promise(resolve => {
    const check = () => {
      const els = document.querySelectorAll(selector);
      if (els.length >= minCount) return Array.from(els);
      return null;
    };
    const immediate = check();
    if (immediate) { resolve(immediate); return; }

    const deadline = Date.now() + timeoutMs;
    const id = setInterval(() => {
      const result = check();
      if (result) { clearInterval(id); resolve(result); return; }
      if (Date.now() > deadline) { clearInterval(id); resolve([]); }
    }, 500);
  });
}

// ═══════════════════════════════════════════════════════════
//  Main Loop
// ═══════════════════════════════════════════════════════════
async function mainLoop() {
  while (isRunning && !stopRequested) {
    log('info', '掃描課程清單...');

    const result = await findAndClickNextVideo();

    if (result === 'clicked') {
      // If no page reload (SPA behavior), we wait and continue
      await sleep(3000);
      await watchVideoAndHandleType();

      if (stopRequested) break;

      // Navigate back to course list
      log('info', '返回課程清單...');
      chrome.storage.local.set({ autoState: 'scanning' });
      if (coursewareBaseUrl) {
        window.location.href = coursewareBaseUrl;
      } else {
        window.history.back();
      }
      await sleep(4000);

    } else if (result === 'done') {
      log('done', '🎉 所有課程已完成！');
      isRunning = false;
      break;
    } else if (result === 'error') {
      log('error', '發生錯誤，5 秒後重試...');
      await sleep(5000);
    }
  }

  if (stopRequested) {
    log('warn', '自動播放已停止。');
  }
  isRunning = false;
}

// ═══════════════════════════════════════════════════════════
//  Step 2: Find and click next unfinished video
// ═══════════════════════════════════════════════════════════
async function findAndClickNextVideo() {
  // Wait for the learning activity list
  const activities = await waitForElements('.learning-activity', 1, 15000);
  if (!activities || activities.length === 0) {
    log('warn', '找不到 .learning-activity 元素，重試中...');
    return 'error';
  }

  try {
    const allActivities = document.querySelectorAll('.learning-activity');
    for (const activity of allActivities) {
      if (stopRequested) return 'done';

      // Check completion status: must be .none or .part
      const completenessEl = activity.querySelector('.completeness');
      if (!completenessEl) continue;
      const isIncomplete =
        completenessEl.classList.contains('none') ||
        completenessEl.classList.contains('part');
      if (!isIncomplete) continue;

      // Check if locked
      const isLocked = !!activity.querySelector('.font-syllabus-lock, .font-thin-lock, .fa-lock, .locked');
      if (isLocked) {
        const titleEl = activity.querySelector('a.title, .title');
        log('warn', `跳過（鎖定）：${titleEl ? titleEl.textContent.trim() : '未知項目'}`);
        continue;
      }

      // Check if it's a video type (skip materials, homeworks, etc.)
      const isVideoType = !!activity.querySelector(
        '[ng-switch-when="online_video"], [ng-switch-when="lesson"], [ng-switch-when="lesson_replay"], ' +
        '.font-syllabus-online-video, .font-syllabus-lesson, .font-syllabus-lesson-replay'
      );
      
      if (!isVideoType) {
        const titleEl = activity.querySelector('a.title, .title');
        log('info', `跳過（非影片類型）：${titleEl ? titleEl.textContent.trim() : '未知項目'}`);
        continue;
      }

      // Found a valid video — get title and click
      const titleEl = activity.querySelector('a.title, .title');
      const title = titleEl ? titleEl.textContent.trim() : '未知影片';
      log('info', `點擊：${title}`);

      const clickable = activity.querySelector('.clickable-area, a.title');
      if (clickable) {
        chrome.storage.local.set({ autoState: 'watching' });
        clickable.click();
        return 'clicked';
      }
    }

    // No video found on this page — try next page
    log('info', '本頁無未完成影片，檢查下一頁...');
    return await goToNextPage();

  } catch (e) {
    console.error('[eClass AutoPlay] findAndClickNextVideo error:', e);
    return 'error';
  }
}

// ═══════════════════════════════════════════════════════════
//  Pagination
// ═══════════════════════════════════════════════════════════
async function goToNextPage() {
  // Selector for next-page button
  const nextPageBtn = document.querySelector(
    'li.next-page a.pager-button, li.next-page-button a.pager-button, .pager .next:not(.disabled) a, [data-action="next"]:not(.disabled)'
  );

  if (!nextPageBtn) {
    log('done', '已是最後一頁，沒有更多未完成影片。');
    return 'done';
  }

  const parentLi = nextPageBtn.closest('li');
  const isHidden = 
    (parentLi && parentLi.classList.contains('ng-hide')) || 
    nextPageBtn.classList.contains('ng-hide') ||
    (parentLi && parentLi.style.display === 'none') ||
    nextPageBtn.style.display === 'none';

  const isDisabled =
    nextPageBtn.classList.contains('disabled') ||
    (parentLi && parentLi.classList.contains('disabled')) ||
    nextPageBtn.getAttribute('aria-disabled') === 'true';

  if (isDisabled || isHidden) {
    log('done', '下一頁按鈕已無法點擊（最後一頁），沒有更多影片。');
    return 'done';
  }

  log('info', '前往下一頁...');
  nextPageBtn.click();
  await sleep(2500);  // wait for next page to render
  return 'continue';  // loop again to scan new page
}

// ═══════════════════════════════════════════════════════════
//  Step 3: Detect player type and play
// ═══════════════════════════════════════════════════════════
async function watchVideoAndHandleType() {
  log('info', '偵測播放器類型...');

  // Poll for player to appear (up to 15s)
  let playerType = null;
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (stopRequested) return;

    // 1. YouTube iframe
    const ytIframe = document.querySelector("iframe[src*='youtube.com'], iframe[src*='youtube-nocookie.com']");
    if (ytIframe) { playerType = 'youtube'; break; }

    // 2. eClass Video.js player (newer)
    const vjsBtn = document.querySelector('.vjs-big-play-button');
    if (vjsBtn) { playerType = 'eclass-vjs'; break; }

    // 3. eClass MediaElement / MVP player (older)
    const mvpBtn = document.querySelector('.mvp-toggle-play, .mejs__playpause-button');
    if (mvpBtn) { playerType = 'eclass-mvp'; break; }

    await sleep(800);
  }

  if (!playerType) {
    log('warn', '找不到已知播放器，跳過此影片。');
    return;
  }

  log('info', `播放器類型：${playerType}`);

  if (playerType === 'eclass-vjs') {
    await playEclassVideo('.vjs-big-play-button', 'video.vjs-tech, video');
  } else if (playerType === 'eclass-mvp') {
    await playEclassVideo('.mvp-toggle-play, .mejs__playpause-button', 'video');
  } else if (playerType === 'youtube') {
    await playYouTubeVideo();
  }
}

// ═══════════════════════════════════════════════════════════
//  eClass Native Video Player
// ═══════════════════════════════════════════════════════════
async function playEclassVideo(playBtnSelector, videoSelector) {
  // Wait for play button
  const playBtn = await waitForElement(playBtnSelector, 10000);
  if (!playBtn) {
    log('error', `找不到播放按鈕（${playBtnSelector}）`);
    return;
  }

  // Click play
  playBtn.click();
  log('info', '已點擊播放按鈕。');
  await sleep(1500);

  // Find video element
  const video = document.querySelector(videoSelector);
  if (!video) {
    log('error', `找不到 video 元素（${videoSelector}）`);
    return;
  }

  // Set playback speed
  try {
    video.playbackRate = PLAYBACK_SPEED;
    log('info', `播放速度設為 ${PLAYBACK_SPEED}x`);
  } catch (e) {
    log('warn', '無法設定播放速度。');
  }

  // Wait for metadata so we can get duration
  if (isNaN(video.duration) || video.duration === 0) {
    await new Promise(resolve => {
      const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); resolve(); };
      video.addEventListener('loadedmetadata', onMeta);
      safeSetTimeout(resolve, 5000);
    });
  }

  const duration = video.duration || 0;
  const estimatedMs = duration > 0
    ? Math.ceil((duration / PLAYBACK_SPEED) * 1000) + 30000
    : 300000; // 5 min fallback

  log('info', `影片長度：${formatTime(duration)}，預計 ${formatTime(duration / PLAYBACK_SPEED)} 完成。`);

  // Wait for video to end (event-driven + polling fallback)
  await new Promise(resolve => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    // Event: ended
    video.addEventListener('ended', done, { once: true });

    // Polling every 5s: log progress + re-apply speed (some players reset it)
    const pollId = setInterval(() => {
      if (stopRequested || resolved) { clearInterval(pollId); done(); return; }
      try {
        if (video.playbackRate !== PLAYBACK_SPEED) video.playbackRate = PLAYBACK_SPEED;
        if (!isNaN(video.currentTime) && !isNaN(video.duration) && video.duration > 0) {
          const remaining = video.duration - video.currentTime;
          log('info', `進度：${formatTime(video.currentTime)} / ${formatTime(video.duration)}（剩餘 ${formatTime(remaining)}）`);
          if (remaining < 3) { clearInterval(pollId); done(); }
        }
        if (video.ended) { clearInterval(pollId); done(); }
      } catch (e) { clearInterval(pollId); done(); }
    }, 5000);

    // Hard timeout
    safeSetTimeout(() => {
      clearInterval(pollId);
      log('warn', '影片等待超時，強制繼續。');
      done();
    }, estimatedMs);
  });

  log('info', '影片播放完畢。');
}

// ═══════════════════════════════════════════════════════════
//  YouTube Iframe Player
// ═══════════════════════════════════════════════════════════
async function playYouTubeVideo() {
  const iframe = document.querySelector("iframe[src*='youtube.com'], iframe[src*='youtube-nocookie.com']");
  if (!iframe) { log('error', '找不到 YouTube iframe。'); return; }

  log('info', '偵測到 YouTube 播放器，嘗試透過 postMessage 控制...');

  /**
   * YouTube iframes are cross-origin.
   * Strategy:
   *  1. Modify src to ensure ?enablejsapi=1 is present (if possible via reload).
   *  2. Use postMessage to send YT IFrame API commands.
   *  3. Listen for postMessage events from the iframe to track playback state.
   *  4. Fall back to timed wait if postMessage doesn't work.
   */

  // Ensure enablejsapi=1 in iframe src
  let src = iframe.src;
  if (!src.includes('enablejsapi=1')) {
    src += (src.includes('?') ? '&' : '?') + 'enablejsapi=1';
    iframe.src = src;
    await sleep(3000); // wait for iframe reload
  }

  const iframeOrigin = new URL(iframe.src).origin;

  // Send play command via postMessage (YT IFrame API)
  const sendYTCommand = (func, args) => {
    iframe.contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args: args || [] }),
      iframeOrigin
    );
  };

  // Listen for YT player state messages
  let videoDuration = 0;
  let currentTime   = 0;
  let isEnded       = false;

  const messageHandler = (event) => {
    if (!event.origin.includes('youtube.com')) return;
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data.event === 'infoDelivery' && data.info) {
        if (data.info.duration)     videoDuration = data.info.duration;
        if (data.info.currentTime)  currentTime   = data.info.currentTime;
        if (data.info.playerState === 0) isEnded = true; // 0 = ended
      }
      if (data.event === 'onStateChange' && data.info === 0) {
        isEnded = true;
      }
    } catch (_) {}
  };
  window.addEventListener('message', messageHandler);

  // Play
  await sleep(1000);
  sendYTCommand('playVideo');
  log('info', 'YouTube：已發送播放指令。');

  // Request info periodically
  const infoInterval = setInterval(() => {
    sendYTCommand('getVideoData');
  }, 3000);

  // Poll for completion
  const MAX_WAIT_MS = 3 * 60 * 60 * 1000; // 3 hours absolute max
  const startTime = Date.now();

  await new Promise(resolve => {
    const pollId = setInterval(() => {
      if (stopRequested || isEnded || Date.now() - startTime > MAX_WAIT_MS) {
        clearInterval(pollId);
        resolve();
        return;
      }
      if (videoDuration > 0 && currentTime > 0) {
        const remaining = videoDuration - currentTime;
        log('info', `YouTube 進度：${formatTime(currentTime)} / ${formatTime(videoDuration)}（剩餘 ${formatTime(remaining)}）`);
        if (remaining < 5) { clearInterval(pollId); resolve(); }
      }
    }, 5000);

    // Fallback: if we never get duration info within 60s, just wait estimated time
    safeSetTimeout(async () => {
      if (!isEnded) {
        // Try reading duration from DOM of the parent page (if available)
        const durationEl = document.querySelector('.ytp-time-duration');
        if (durationEl) {
          const dur = parseDurationString(durationEl.textContent.trim());
          if (dur > 0) {
            const waitMs = Math.ceil((dur / PLAYBACK_SPEED) * 1000) + 30000;
            log('info', `YouTube 影片長度（DOM）：${formatTime(dur)}，等待 ${formatTime(dur / PLAYBACK_SPEED)}...`);
            safeSetTimeout(() => { clearInterval(pollId); resolve(); }, waitMs);
            return;
          }
        }
        // No info at all — wait 5 minutes as fallback
        log('warn', 'YouTube：無法取得影片長度，等待 5 分鐘...');
        safeSetTimeout(() => { clearInterval(pollId); resolve(); }, 5 * 60 * 1000);
      }
    }, 60000);
  });

  clearInterval(infoInterval);
  window.removeEventListener('message', messageHandler);
  log('info', 'YouTube 影片播放完畢。');
}

// ═══════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function parseDurationString(str) {
  // Parses "mm:ss" or "hh:mm:ss" to seconds
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// ═══════════════════════════════════════════════════════════
//  Init: auto-resume if flag is set in storage
// ═══════════════════════════════════════════════════════════
async function resumeWatchingLoop() {
  await watchVideoAndHandleType();
  if (!isRunning || stopRequested) return;

  log('info', '影片結束，返回課程清單...');
  chrome.storage.local.set({ autoState: 'scanning' });
  if (coursewareBaseUrl) {
    window.location.href = coursewareBaseUrl;
  } else {
    window.history.back();
  }
  
  // 若返回清單只觸發了 SPA (單頁應用) 的 Hash 改變而沒有整頁重載，
  // 原有的程式需要繼續呼叫 mainLoop() 才能接續往下掃描。
  await sleep(4000);
  if (isRunning && !stopRequested) {
    mainLoop();
  }
}

chrome.storage.local.get({ isRunning: false, playbackSpeed: 2.0, autoState: 'scanning', coursewareBaseUrl: null }, (data) => {
  if (data.isRunning && !isRunning) {
    PLAYBACK_SPEED    = data.playbackSpeed;
    isRunning         = true;
    stopRequested     = false;
    coursewareBaseUrl = data.coursewareBaseUrl || window.location.href;
    
    log('info', `頁面重載後自動繼續（速度 ${PLAYBACK_SPEED}x，狀態：${data.autoState === 'watching' ? '觀看中' : '掃描中'}）...`);
    
    safeSetTimeout(() => {
      if (data.autoState === 'watching') {
        resumeWatchingLoop();
      } else {
        mainLoop();
      }
    }, 2000);
  }
});
