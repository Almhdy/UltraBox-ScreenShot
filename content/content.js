/**
 * UltraBox Screenshot – Content Script
 * Injects and manages the selection overlay, handles drag/resize, keyboard shortcuts.
 */

'use strict';

// Guard against double-injection
if (window.__ultraboxInjected) {
  // Already injected – just listen for re-activation
} else {
  window.__ultraboxInjected = true;

  // ─── State ────────────────────────────────────────────────────────────────────

  const state = {
    overlay: null,
    box: null,
    handles: {},
    x: 0, y: 0,
    w: 800, h: 600,
    dragging: false,
    resizing: false,
    resizeHandle: null,
    startMouse: null,
    startBox: null,
    active: false,
    resolveCapture: null,   // set when popup is waiting for response
    rejectCapture: null,
    downloadSettings: null, // set when popup is closed (fire-and-forget mode)
  };

  // ─── Message Listener ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startSelection') {
      showOverlay(message.width || state.w, message.height || state.h, null, null);
      sendResponse({ success: true });
      return false;
    }

    // Fire-and-forget mode: popup sends this and may close immediately.
    // The content script handles capture + download without a popup response.
    if (message.action === 'startSelectionDownload') {
      state.resolveCapture = null;
      state.rejectCapture = null;
      state.downloadSettings = {
        format: message.format || 'png',
        quality: message.quality || 92,
        copyToClipboard: message.copyToClipboard || false,
      };
      showOverlay(message.width || state.w, message.height || state.h, null, null);
      sendResponse({ success: true });
      return false;
    }

    // Legacy: popup awaits the response (only works if popup stays open).
    if (message.action === 'startSelectionCapture') {
      state.downloadSettings = null;
      startSelectionCapture(message.width, message.height)
        .then((dataUrl) => sendResponse({ success: true, dataUrl }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });

  // ─── Selection Capture ────────────────────────────────────────────────────────

  function startSelectionCapture(width, height) {
    return new Promise((resolve, reject) => {
      state.resolveCapture = resolve;
      state.rejectCapture = reject;
      showOverlay(width, height, resolve, reject);
    });
  }

  // ─── Overlay Creation ─────────────────────────────────────────────────────────

  function showOverlay(width, height, resolve, reject) {
    if (state.active) destroyOverlay();

    state.w = width || 800;
    state.h = height || 600;
    // Box lives inside position:fixed overlay — use viewport (not page) coordinates
    state.x = Math.max(0, Math.round((window.innerWidth - state.w) / 2));
    state.y = Math.max(0, Math.round((window.innerHeight - state.h) / 2));
    state.active = true;

    // ── Backdrop ──────────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'ultrabox-overlay';
    overlay.setAttribute('aria-label', 'Screenshot selection area. Press Enter to capture, Escape to cancel.');
    overlay.setAttribute('role', 'dialog');
    state.overlay = overlay;

    // ── Selection Box ─────────────────────────────────────────────────────────
    const box = document.createElement('div');
    box.id = 'ultrabox-box';
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-label', 'Drag to move. Use handles to resize. Arrow keys nudge 1px, Shift+Arrow 10px.');
    state.box = box;

    // ── Label / dimensions display ─────────────────────────────────────────
    const label = document.createElement('div');
    label.id = 'ultrabox-label';
    label.textContent = `${state.w} × ${state.h}`;
    box.appendChild(label);

    // ── Toolbar ──────────────────────────────────────────────────────────────
    const toolbar = createToolbar();
    box.appendChild(toolbar);

    // ── Resize Handles ───────────────────────────────────────────────────────
    const handlePositions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    handlePositions.forEach((pos) => {
      const h = document.createElement('div');
      h.className = `ultrabox-handle ultrabox-handle-${pos}`;
      h.dataset.pos = pos;
      h.setAttribute('aria-hidden', 'true');
      box.appendChild(h);
      state.handles[pos] = h;
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    updateBoxGeometry();
    box.focus();
    bindEvents();
  }

  // ─── Toolbar ──────────────────────────────────────────────────────────────

  function createToolbar() {
    const toolbar = document.createElement('div');
    toolbar.id = 'ultrabox-toolbar';

    // Dimension inputs
    const wInput = makeInput('width', state.w, 'Width in pixels');
    const xLabel = document.createElement('span');
    xLabel.className = 'ultrabox-dim-sep';
    xLabel.textContent = '×';
    const hInput = makeInput('height', state.h, 'Height in pixels');

    wInput.addEventListener('input', () => {
      const v = parseInt(wInput.value, 10);
      if (v >= 1 && v <= 9999) { state.w = v; updateBoxGeometry(); }
    });
    hInput.addEventListener('input', () => {
      const v = parseInt(hInput.value, 10);
      if (v >= 1 && v <= 9999) { state.h = v; updateBoxGeometry(); }
    });

    state._wInput = wInput;
    state._hInput = hInput;

    // Capture button
    const captureBtn = document.createElement('button');
    captureBtn.id = 'ultrabox-capture-btn';
    captureBtn.textContent = '↓ Capture';
    captureBtn.setAttribute('aria-label', 'Capture selected area');
    captureBtn.addEventListener('click', (e) => { e.stopPropagation(); doCapture(); });

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ultrabox-cancel-btn';
    cancelBtn.textContent = '✕';
    cancelBtn.setAttribute('aria-label', 'Cancel selection');
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancelCapture(); });

    toolbar.appendChild(wInput);
    toolbar.appendChild(xLabel);
    toolbar.appendChild(hInput);
    toolbar.appendChild(captureBtn);
    toolbar.appendChild(cancelBtn);
    return toolbar;
  }

  function makeInput(name, value, ariaLabel) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'ultrabox-dim-input';
    input.value = value;
    input.min = 1;
    input.max = 9999;
    input.setAttribute('aria-label', ariaLabel);
    // Prevent keyboard events from moving the box while typing
    input.addEventListener('keydown', (e) => e.stopPropagation());
    return input;
  }

  // ─── Geometry ─────────────────────────────────────────────────────────────────

  function updateBoxGeometry() {
    if (!state.box) return;

    // Clamp to viewport (box is in fixed/viewport space)
    const maxX = Math.max(0, window.innerWidth - state.w);
    const maxY = Math.max(0, window.innerHeight - state.h);
    state.x = Math.max(0, Math.min(state.x, maxX));
    state.y = Math.max(0, Math.min(state.y, maxY));

    state.box.style.left = state.x + 'px';
    state.box.style.top = state.y + 'px';
    state.box.style.width = state.w + 'px';
    state.box.style.height = state.h + 'px';

    // Update label
    const label = state.box.querySelector('#ultrabox-label');
    if (label) label.textContent = `${state.w} × ${state.h}`;

    // Update dimension inputs in toolbar
    if (state._wInput) state._wInput.value = state.w;
    if (state._hInput) state._hInput.value = state.h;
  }

  // ─── Event Binding ────────────────────────────────────────────────────────────

  function bindEvents() {
    // Mouse drag on box to move
    state.box.addEventListener('mousedown', onBoxMouseDown);

    // Mouse drag on handles to resize
    Object.values(state.handles).forEach((h) => {
      h.addEventListener('mousedown', onHandleMouseDown);
    });

    // Keyboard shortcuts
    state.box.addEventListener('keydown', onKeyDown);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function unbindEvents() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  // ─── Drag (Move) ──────────────────────────────────────────────────────────────

  function onBoxMouseDown(e) {
    // Don't drag when clicking toolbar elements
    if (e.target.closest('#ultrabox-toolbar') || e.target.closest('.ultrabox-handle')) return;
    e.preventDefault();
    state.dragging = true;
    state.startMouse = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    state.startBox = { x: state.x, y: state.y, w: state.w, h: state.h };
    state.box.style.cursor = 'grabbing';
  }

  // ─── Resize ───────────────────────────────────────────────────────────────────

  function onHandleMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    state.resizing = true;
    state.resizeHandle = e.currentTarget.dataset.pos;
    state.startMouse = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    state.startBox = { x: state.x, y: state.y, w: state.w, h: state.h };
  }

  // ─── Mouse Move ───────────────────────────────────────────────────────────────

  function onMouseMove(e) {
    if (!state.dragging && !state.resizing) return;
    const mx = e.clientX + window.scrollX;
    const my = e.clientY + window.scrollY;
    const dx = mx - state.startMouse.x;
    const dy = my - state.startMouse.y;

    if (state.dragging) {
      state.x = state.startBox.x + dx;
      state.y = state.startBox.y + dy;

    } else if (state.resizing) {
      const { x: ox, y: oy, w: ow, h: oh } = state.startBox;
      const MIN = 20;

      switch (state.resizeHandle) {
        case 'e': state.w = Math.max(MIN, ow + dx); break;
        case 'w': state.w = Math.max(MIN, ow - dx); state.x = ox + ow - state.w; break;
        case 's': state.h = Math.max(MIN, oh + dy); break;
        case 'n': state.h = Math.max(MIN, oh - dy); state.y = oy + oh - state.h; break;
        case 'se': state.w = Math.max(MIN, ow + dx); state.h = Math.max(MIN, oh + dy); break;
        case 'sw': state.w = Math.max(MIN, ow - dx); state.x = ox + ow - state.w;
          state.h = Math.max(MIN, oh + dy); break;
        case 'ne': state.w = Math.max(MIN, ow + dx);
          state.h = Math.max(MIN, oh - dy); state.y = oy + oh - state.h; break;
        case 'nw': state.w = Math.max(MIN, ow - dx); state.x = ox + ow - state.w;
          state.h = Math.max(MIN, oh - dy); state.y = oy + oh - state.h; break;
      }
    }

    updateBoxGeometry();
  }

  // ─── Mouse Up ─────────────────────────────────────────────────────────────────

  function onMouseUp() {
    state.dragging = false;
    state.resizing = false;
    state.resizeHandle = null;
    if (state.box) state.box.style.cursor = '';
  }

  // ─── Keyboard ─────────────────────────────────────────────────────────────────

  function onKeyDown(e) {
    const step = e.shiftKey ? 10 : 1;

    switch (e.key) {
      case 'Escape': e.preventDefault(); cancelCapture(); break;
      case 'Enter': e.preventDefault(); doCapture(); break;

      case 'ArrowLeft': e.preventDefault(); state.x -= step; updateBoxGeometry(); break;
      case 'ArrowRight': e.preventDefault(); state.x += step; updateBoxGeometry(); break;
      case 'ArrowUp': e.preventDefault(); state.y -= step; updateBoxGeometry(); break;
      case 'ArrowDown': e.preventDefault(); state.y += step; updateBoxGeometry(); break;
    }
  }

  // ─── Capture & Cancel ─────────────────────────────────────────────────────────

  async function doCapture() {
    if (!state.active) return;

    try {
      state.overlay.style.visibility = 'hidden';
      await sleep(80);

      const res = await chrome.runtime.sendMessage({ action: 'captureVisible' });
      state.overlay.style.visibility = '';
      if (!res?.success) throw new Error(res?.error || 'Capture failed.');

      // state.x/y are viewport-space (box is position:fixed), crop directly
      const cropped = await cropDataUrl(res.dataUrl, state.x, state.y, state.w, state.h);

      destroyOverlay();

      if (state.resolveCapture) {
        // Popup is still open and waiting
        state.resolveCapture(cropped);
        state.resolveCapture = null;
        state.rejectCapture = null;
      } else {
        // Fire-and-forget: download directly without popup
        await downloadCaptured(cropped, state.downloadSettings);
      }
    } catch (err) {
      state.overlay.style.visibility = '';
      console.error('[UltraBox] Selection capture error:', err);
      if (state.rejectCapture) {
        state.rejectCapture(err);
        state.resolveCapture = null;
        state.rejectCapture = null;
      }
      destroyOverlay();
    }
  }

  /**
   * Download or copy a cropped screenshot without any popup involvement.
   * Used in fire-and-forget (startSelectionDownload) mode.
   */
  async function downloadCaptured(dataUrl, settings) {
    const fmt = settings?.format || 'png';
    const qual = (settings?.quality || 92) / 100;
    const copy = settings?.copyToClipboard || false;

    let finalUrl = dataUrl;
    if (fmt === 'jpeg') {
      finalUrl = await toJpeg(dataUrl, qual);
    }

    if (copy) {
      const res = await fetch(finalUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -1);
    await chrome.runtime.sendMessage({
      action: 'downloadImage',
      dataUrl: finalUrl,
      format: fmt,
      filename: `UltraBox_Screenshot_${ts}.${fmt}`,
    });
  }

  /** Convert a PNG data URL to JPEG using an in-page canvas. */
  function toJpeg(pngDataUrl, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('JPEG conversion failed.'));
      img.src = pngDataUrl;
    });
  }

  function cancelCapture() {
    if (state.rejectCapture) {
      state.rejectCapture(new Error('User cancelled.'));
    }
    state.resolveCapture = null;
    state.rejectCapture = null;
    destroyOverlay();
  }

  // ─── Image Cropping ───────────────────────────────────────────────────────────

  function cropDataUrl(dataUrl, vpX, vpY, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        // Output canvas matches the CSS-pixel selection size exactly
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        const ctx = canvas.getContext('2d');

        // Sample from the correct region of the high-DPI screenshot
        const sx = Math.max(0, vpX * dpr);
        const sy = Math.max(0, vpY * dpr);
        const sw = Math.min(width * dpr, img.naturalWidth - sx);
        const sh = Math.min(height * dpr, img.naturalHeight - sy);

        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Failed to load screenshot for cropping.'));
      img.src = dataUrl;
    });
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  function destroyOverlay() {
    unbindEvents();
    if (state.overlay && state.overlay.parentNode) {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    state.overlay = null;
    state.box = null;
    state.handles = {};
    state._wInput = null;
    state._hInput = null;
    state.active = false;
    state.dragging = false;
    state.resizing = false;
    window.__ultraboxActive = false;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
