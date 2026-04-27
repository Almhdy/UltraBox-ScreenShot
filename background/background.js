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

/**
 * Scroll the tab to a given Y position and return the ACTUAL scrollY the
 * browser landed on (may differ from requested due to clamping / subpixels).
 * Also disables smooth-scroll so the page doesn't animate between positions.
 */
async function scrollToAndGetActual(tabId, y) {
  const [{ result: actualY }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetY) => {
      // Disable smooth scrolling so we snap instantly
      const saved = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      document.body.style.scrollBehavior = 'auto';           // some sites set it on body

      window.scrollTo(0, targetY);

      // Restore after the synchronous scroll
      document.documentElement.style.scrollBehavior = saved;

      // Return the true scroll position the browser settled on
      return window.scrollY;
    },
    args: [y],
  });
  return actualY;
}

/**
 * Wait for two animation frames — enough for the compositor to flush the
 * scroll position and re-paint sticky/fixed elements.
 */
async function waitForPaint(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
  });
}

// CSS injected to hide scrollbars + fixed/sticky elements during capture.
// Must be the exact same string for both insertCSS and removeCSS.
const CAPTURE_CSS = `
  /* Hide scrollbar so it doesn't appear in tiles */
  ::-webkit-scrollbar { display: none !important; }
  html { overflow: -moz-scrollbars-none; scrollbar-width: none !important; }
  /* Hide fixed/sticky elements (attributed by the injected script below) */
  [data-_ub_fixed_] { visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
`.trim();

/**
 * Full-page screenshot — scroll one viewport-height per tile, stitch on canvas.
 *
 * Key improvements over the naive approach:
 *  1. Reads back actual window.scrollY after each scroll (fixes lines/seams).
 *  2. Disables smooth-scroll before each step (prevents animation lag).
 *  3. Hides the scrollbar via CSS (prevents it appearing in tiles).
 *  4. Uses floor() instead of round() to avoid cumulative DPR drift.
 *  5. Calculates tile source rect from the *actual* scroll, not the requested one.
 *  6. Handles the last (partial) tile correctly regardless of page height.
 */
async function captureFullPage(tab) {
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab) throw new Error('No active tab found.');

  // ── 1. Measure page & viewport ───────────────────────────────────────────
  const [{ result: d }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      // Warm-up scroll: trigger lazy-load, then return to top.
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise(r => setTimeout(r, 80));
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 80));

      const doc  = document.documentElement;
      const body = document.body;
      return {
        // Page height: take the maximum of all height metrics.
        ph:  Math.max(
               doc.scrollHeight, body.scrollHeight,
               doc.offsetHeight, body.offsetHeight,
               doc.clientHeight
             ),
        vw:  window.innerWidth,
        // Viewport height: clientHeight excludes horizontal scrollbar.
        vh:  doc.clientHeight,
        dpr: window.devicePixelRatio || 1,
      };
    },
  });

  const { ph, vw, vh, dpr } = d;
  const maxScrollY = Math.max(0, ph - vh);

  // ── 2. Inject CSS (hide scrollbar + fixed elements placeholder) ──────────
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: CAPTURE_CSS });

  // Mark all fixed/sticky elements with a data-attribute so the CSS hides them.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.querySelectorAll('*').forEach(el => {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          el.setAttribute('data-_ub_fixed_', '1');
        }
      });
    },
  });

  // Wait for the DOM paint to settle after hiding fixed elements.
  await waitForPaint(tab.id);
  await sleep(60); // extra 60 ms safety margin for heavy pages

  // ── 3. Scroll & capture each tile ────────────────────────────────────────
  /**
   * Each tile stores:
   *   actualY  – the real window.scrollY when the screenshot was taken
   *   dataUrl  – the captured PNG
   */
  const tiles = [];
  let lastCaptureTime = 0;
  let requestedY = 0;

  try {
    while (true) {
      // Scroll and get back the true position (may differ from requested).
      const actualY = await scrollToAndGetActual(tab.id, requestedY);

      // Wait for layout/paint to settle.
      await waitForPaint(tab.id);

      // Throttle captures to stay within Chrome's ~2/sec limit.
      const elapsed = Date.now() - lastCaptureTime;
      if (elapsed < MIN_CAPTURE_INTERVAL) await sleep(MIN_CAPTURE_INTERVAL - elapsed);
      lastCaptureTime = Date.now();

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      tiles.push({ actualY, dataUrl });

      // Stop once we've captured the bottom of the page.
      if (actualY >= maxScrollY) break;

      // Advance by one full viewport.
      requestedY += vh;

      // If next position would overshoot, clamp to the last possible scroll
      // so we always capture the very bottom of the page.
      if (requestedY > maxScrollY) requestedY = maxScrollY;
    }
  } finally {
    // ── Cleanup: remove attributes, CSS, restore scroll ──────────────────
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelectorAll('[data-_ub_fixed_]')
                           .forEach(el => el.removeAttribute('data-_ub_fixed_')),
    });
    await chrome.scripting.removeCSS({ target: { tabId: tab.id }, css: CAPTURE_CSS });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.scrollTo(0, 0),
    });
  }

  // ── 4. Stitch tiles onto a high-DPI OffscreenCanvas ──────────────────────
  //
  // ── Stitching strategy ─────────────────────────────────────────────────────
  //
  // We draw each full captured bitmap at canvas-Y = actualY * dpr.
  // Tiles naturally overlap at scroll boundaries — later tiles simply
  // overdraw earlier ones. This is the seam-free approach used by GoFullPage
  // and FireShot: no "novel rows" math, no dependence on vh matching
  // bitmap.height (which it often doesn't, due to zoom / OS DPI scaling).
  //
  // window.scrollY always returns an integer in Chrome, so Math.round is safe.

  const canvasW = Math.round(vw * dpr);
  const canvasH = Math.round(ph * dpr);
  const canvas  = new OffscreenCanvas(canvasW, canvasH);
  const ctx     = canvas.getContext('2d');

  for (let i = 0; i < tiles.length; i++) {
    const { actualY, dataUrl } = tiles[i];

    const resp   = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await resp.blob());

    // Destination Y on the canvas in physical pixels.
    const dstY = Math.round(actualY * dpr);

    // Draw the full bitmap 1:1. Clamp so we never draw past the canvas bottom.
    const drawH = Math.min(bitmap.height, canvasH - dstY);

    if (drawH > 0 && canvasW > 0) {
      ctx.drawImage(bitmap, 0, 0, bitmap.width, drawH, 0, dstY, canvasW, drawH);
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