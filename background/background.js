/**
 * UltraBox Screenshot - Background Service Worker
 * Handles capture orchestration, messaging, and download management.
 */

// ─── Listeners ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[UltraBox] Extension installed / updated.');
  const existing = await chrome.storage.sync.get('ultraboxSettings');
  if (!existing.ultraboxSettings) {
    await chrome.storage.sync.set({
      ultraboxSettings: { mode: 'visible', format: 'png', quality: 92, width: 800, height: 600 },
    });
  }
});

// Handle keyboard command for starting selection mode directly
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-selection') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await injectContentIfNeeded(tab.id);
      chrome.tabs.sendMessage(tab.id, { action: 'startSelection' });
    }
  }
});

// Central message hub
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep the channel open for async responses
});

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.action) {

      case 'captureVisible': {
        const dataUrl = await captureVisibleTab();
        sendResponse({ success: true, dataUrl });
        break;
      }

      case 'captureFullPage': {
        const tab = sender.tab || (await getActiveTab());
        const dataUrl = await captureFullPage(tab);
        sendResponse({ success: true, dataUrl });
        break;
      }

      case 'captureSelection': {
        const { dataUrl } = message;
        sendResponse({ success: true, dataUrl });
        break;
      }

      case 'downloadImage': {
        const { dataUrl, format, filename } = message;
        await downloadImage(dataUrl, format, filename);
        sendResponse({ success: true });
        break;
      }

      case 'copyToClipboard': {
        sendResponse({ success: true });
        break;
      }

      case 'getSettings': {
        const result = await chrome.storage.sync.get('ultraboxSettings');
        sendResponse({ success: true, settings: result.ultraboxSettings });
        break;
      }

      case 'saveSettings': {
        await chrome.storage.sync.set({ ultraboxSettings: message.settings });
        sendResponse({ success: true });
        break;
      }

      case 'injectContent': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) await injectContentIfNeeded(tab.id);
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: 'Unknown action: ' + message.action });
    }
  } catch (err) {
    console.error('[UltraBox] Error in message handler:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Capture Helpers ──────────────────────────────────────────────────────────

/** Capture only the currently visible viewport. */
async function captureVisibleTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

// Chrome allows ~2 captureVisibleTab calls/sec.
const MIN_CAPTURE_INTERVAL = 550; // ms — safely under the hard limit

// Injected CSS that hides all fixed/sticky elements during full-page capture.
// Must be identical string for both insertCSS and removeCSS.
const HIDE_CSS = '[data-_ub_fixed_] { visibility: hidden !important; opacity: 0 !important; }';

/**
 * Full-page capture: scroll by one full viewport per tile, hide fixed elements,
 * only draw the novel rows of each tile when stitching.
 */
async function captureFullPage(tab) {
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab) throw new Error('No active tab found.');

  // 1. Page dimensions
  // vh should be clientHeight to exclude horizontal scrollbars that might be in the capture.
  // ph should be the maximum of various height metrics to ensure we cover the whole page.
  const [{ result: d }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      // Warm up: scroll a bit to trigger any lazy-loaded content
      const scrollH = document.documentElement.scrollHeight;
      window.scrollTo(0, scrollH);
      await new Promise(r => setTimeout(r, 60));
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 60));

      const doc = document.documentElement;
      const body = document.body;
      return {
        ph:  Math.max(doc.scrollHeight, body.scrollHeight, doc.offsetHeight, body.offsetHeight, doc.clientHeight),
        vw:  window.innerWidth,
        vh:  doc.clientHeight,
        dpr: window.devicePixelRatio || 1,
      };
    },
  });
  const { ph, vw, vh, dpr } = d;
  const maxScrollY = Math.max(0, ph - vh);

  // 2. Hide fixed/sticky elements so they don't stamp into every tile
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: HIDE_CSS });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.querySelectorAll('*').forEach(el => {
        const p = getComputedStyle(el).position;
        if (p === 'fixed' || p === 'sticky') el.setAttribute('data-_ub_fixed_', '');
      });
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
  });

  // 3. Capture one viewport-height tile at a time
  const tiles = [];
  let lastCapture = 0;
  try {
    let scrollY = 0;
    while (true) {
      const actualY = Math.min(scrollY, maxScrollY);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: y => new Promise(r => { window.scrollTo(0, y); requestAnimationFrame(() => requestAnimationFrame(r)); }),
        args: [actualY],
      });
      const elapsed = Date.now() - lastCapture;
      if (elapsed < MIN_CAPTURE_INTERVAL) await sleep(MIN_CAPTURE_INTERVAL - elapsed);
      lastCapture = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      tiles.push({ scrollY: actualY, dataUrl });
      if (actualY >= maxScrollY) break;
      scrollY += vh;
    }
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelectorAll('[data-_ub_fixed_]').forEach(el => el.removeAttribute('data-_ub_fixed_')),
    });
    await chrome.scripting.removeCSS({ target: { tabId: tab.id }, css: HIDE_CSS });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollTo(0, 0) });
  }

  // 4. Stitch — each tile contributes unique rows to the final high-res image.
  // We use DPR-scaled canvas for high resolution.
  const canvas = new OffscreenCanvas(Math.round(vw * dpr), Math.round(ph * dpr));
  const ctx    = canvas.getContext('2d');

  for (let i = 0; i < tiles.length; i++) {
    const { scrollY: sy, dataUrl } = tiles[i];
    const resp   = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await resp.blob());

    // outStart/outEnd are in CSS pixels
    const outStart = i === 0 ? 0 : tiles[i - 1].scrollY + vh;
    const outEnd   = Math.min(sy + vh, ph);
    const outH     = outEnd - outStart;

    if (outH > 0) {
      // Convert to physical pixels for drawImage
      const dX = 0;
      const dY = Math.round(outStart * dpr);
      const dW = Math.round(vw * dpr);
      const dH = Math.round(outH * dpr);

      const sX = 0;
      const sY = Math.round((outStart - sy) * dpr);
      const sW = bitmap.width;
      const sH = Math.min(dH, bitmap.height - sY);

      if (sH > 0 && dW > 0 && dH > 0) {
        ctx.drawImage(bitmap, sX, sY, sW, sH, dX, dY, dW, dH);
      }
    }
    bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataURL(blob);
}


/**
 * Trigger a download for the given data URL.
 *
 * NOTE: URL.createObjectURL() is NOT available in service workers.
 * chrome.downloads.download() natively accepts data: URLs (Chrome 95+).
 */
async function downloadImage(dataUrl, format, filename) {
  await chrome.downloads.download({
    url: dataUrl,
    filename: filename || `UltraBox_Screenshot_${timestamp()}.${format || 'png'}`,
    saveAs: false,
  });
}

// ─── Page-injected helpers ────────────────────────────────────────────────────

/** Returns page scroll/viewport dimensions. Serialisable — no DOM refs. */
function getPageDimensions() {
  return {
    scrollWidth:      document.documentElement.scrollWidth,
    scrollHeight:     document.documentElement.scrollHeight,
    viewportWidth:    window.innerWidth,
    viewportHeight:   window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/**
 * Measures how many CSS pixels at the top and bottom of the viewport are
 * occupied by fixed/sticky elements (navbars, banners, bottom bars, etc.).
 *
 * We use getBoundingClientRect() — it gives current visual position.
 * An element is "top-anchored" if its top edge is in the upper half of the
 * viewport (its bottom tells us how far down it reaches).
 * An element is "bottom-anchored" if its bottom edge is in the lower half.
 *
 * Returns { fixedTopH, fixedBottomH } in CSS pixels.
 */
function measureFixedAreas() {
  let fixedTopH    = 0;
  let fixedBottomH = 0;
  const vh = window.innerHeight;

  document.querySelectorAll('*').forEach((el) => {
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') return;

    const r = el.getBoundingClientRect();
    // Skip invisible elements
    if (r.width <= 0 || r.height <= 0) return;

    // Top-anchored: covers the top portion of the viewport
    if (r.top >= 0 && r.top < vh / 2) {
      fixedTopH = Math.max(fixedTopH, Math.min(r.bottom, vh));
    }
    // Bottom-anchored: covers the bottom portion
    if (r.bottom > vh / 2 && r.bottom <= vh) {
      fixedBottomH = Math.max(fixedBottomH, vh - r.top);
    }
  });

  return {
    fixedTopH:    Math.round(fixedTopH),
    fixedBottomH: Math.round(fixedBottomH),
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read blob as data URL'));
    reader.readAsDataURL(blob);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Inject content script into a tab if not already present. */
async function injectContentIfNeeded(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
  } catch (e) {
    console.warn('[UltraBox] Content injection skipped:', e.message);
  }
}
