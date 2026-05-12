/**
 * UltraBox Screenshot – Popup Controller
 * Handles UI state, settings persistence, and screenshot orchestration.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const modeBtns        = document.querySelectorAll('.mode-btn');
const dimSection      = document.getElementById('dimensions-section');
const inputWidth      = document.getElementById('input-width');
const inputHeight     = document.getElementById('input-height');
const btnResetDims    = document.getElementById('btn-reset-dims');
const formatSelect    = document.getElementById('format-select');
const qualityRow      = document.getElementById('quality-row');
const qualityRange    = document.getElementById('quality-range');
const qualityValue    = document.getElementById('quality-value');
const btnCapture      = document.getElementById('btn-capture');
const btnCopy         = document.getElementById('btn-copy');
const statusBar       = document.getElementById('status-bar');
const statusIcon      = document.getElementById('status-icon');
const statusText      = document.getElementById('status-text');

// ─── State ────────────────────────────────────────────────────────────────────

let currentMode   = 'visible';
let isCapturing   = false;
let statusTimeout = null;

// ─── Initialise ───────────────────────────────────────────────────────────────

(async function init() {
  await loadSettings();
  attachEventListeners();
  updateDimSectionVisibility();
  updateQualityVisibility();
})();

// ─── Settings Persistence ─────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (res?.success && res.settings) {
      const s = res.settings;
      currentMode           = s.mode    || 'visible';
      inputWidth.value      = s.width   || 800;
      inputHeight.value     = s.height  || 600;
      formatSelect.value    = s.format  || 'png';
      qualityRange.value    = s.quality || 92;
      qualityValue.textContent = (s.quality || 92) + '%';
    }
  } catch (e) {
    console.warn('[UltraBox] Could not load settings:', e);
  }
  activateModeBtn(currentMode);
}

async function saveSettings() {
  const settings = {
    mode:    currentMode,
    width:   parseInt(inputWidth.value, 10)  || 800,
    height:  parseInt(inputHeight.value, 10) || 600,
    format:  formatSelect.value,
    quality: parseInt(qualityRange.value, 10) || 92,
  };
  try {
    await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
  } catch (e) {
    console.warn('[UltraBox] Could not save settings:', e);
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function attachEventListeners() {
  // Mode buttons
  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMode(btn.dataset.mode);
      }
    });
  });

  // Dimension inputs – validate in real time
  [inputWidth, inputHeight].forEach((input) => {
    input.addEventListener('input', () => {
      validateDimInput(input);
      saveSettings();
    });
    input.addEventListener('blur', () => {
      if (!input.value || parseInt(input.value) < 1) {
        input.value = input === inputWidth ? 800 : 600;
        input.classList.remove('invalid');
      }
    });
  });

  // Reset dimensions
  btnResetDims.addEventListener('click', resetDimensions);

  // Format selector
  formatSelect.addEventListener('change', () => {
    updateQualityVisibility();
    saveSettings();
  });

  // Quality slider
  qualityRange.addEventListener('input', () => {
    qualityValue.textContent = qualityRange.value + '%';
    saveSettings();
  });

  // Capture button
  btnCapture.addEventListener('click', () => startCapture(false));

  // Copy button
  btnCopy.addEventListener('click', () => startCapture(true));
}

// ─── Mode Management ─────────────────────────────────────────────────────────

function selectMode(mode) {
  currentMode = mode;
  activateModeBtn(mode);
  updateDimSectionVisibility();
  saveSettings();
}

function activateModeBtn(mode) {
  modeBtns.forEach((btn) => {
    const isActive = btn.dataset.mode === mode;
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });
}

function updateDimSectionVisibility() {
  if (currentMode === 'selection') {
    dimSection.classList.remove('hidden');
  } else {
    dimSection.classList.add('hidden');
  }
}

// ─── Quality Visibility ───────────────────────────────────────────────────────

function updateQualityVisibility() {
  if (formatSelect.value === 'jpeg') {
    qualityRow.removeAttribute('hidden');
  } else {
    qualityRow.setAttribute('hidden', '');
  }
}

// ─── Dimension Reset ──────────────────────────────────────────────────────────

async function resetDimensions() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ w: window.innerWidth, h: window.innerHeight }),
      });
      const { w, h } = results[0].result;
      inputWidth.value  = w;
      inputHeight.value = h;
      inputWidth.classList.remove('invalid');
      inputHeight.classList.remove('invalid');
      saveSettings();
      showStatus('info', '↺', `Reset to ${w}×${h}`);
    }
  } catch (e) {
    showStatus('error', '✕', 'Cannot read viewport size');
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateDimInput(input) {
  const val = parseInt(input.value, 10);
  if (!val || val < 1 || val > 9999 || isNaN(val)) {
    input.classList.add('invalid');
    return false;
  }
  input.classList.remove('invalid');
  return true;
}

function getDimensions() {
  const w = parseInt(inputWidth.value, 10);
  const h = parseInt(inputHeight.value, 10);
  if (!w || !h || w < 1 || h < 1) return null;
  return { width: w, height: h };
}

// ─── Capture Orchestration ────────────────────────────────────────────────────

async function startCapture(copyToClipboard = false) {
  if (isCapturing) return;

  // Validate dimensions for selection mode
  if (currentMode === 'selection') {
    const valid = validateDimInput(inputWidth) && validateDimInput(inputHeight);
    if (!valid) {
      showStatus('error', '✕', 'Enter valid dimensions (1–9999 px)');
      return;
    }
  }

  setLoadingState(true);
  hideStatus();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');

    let dataUrl = null;

    if (currentMode === 'visible') {
      dataUrl = await captureVisible(tab);

    } else if (currentMode === 'fullpage') {
      showStatus('info', null, 'Capturing full page…', true);
      dataUrl = await captureFullPage(tab);

    } else if (currentMode === 'selection') {
      // Selection is fire-and-forget: the content script shows the overlay and
      // handles download directly, because the popup closes the moment the user
      // clicks the page to interact with the overlay (killing our response channel).
      await saveSettings(); // ensure format/quality are up-to-date in storage
      const dims = getDimensions();
      chrome.tabs.sendMessage(tab.id, {
        action: 'startSelectionDownload',
        width:  dims.width,
        height: dims.height,
        copyToClipboard,
        format:  formatSelect.value,
        quality: parseInt(qualityRange.value, 10),
      }).catch(() => {});
      showStatus('info', '↗', 'Draw selection → Enter to capture, Esc to cancel');
      setLoadingState(false);
      return; // don't proceed to download in popup
    }

    if (!dataUrl) throw new Error('Capture returned no data.');

    if (copyToClipboard) {
      await copyDataUrlToClipboard(dataUrl, formatSelect.value, parseInt(qualityRange.value, 10) / 100);
      showStatus('success', '✓', 'Copied to clipboard!');
    } else {
      await downloadCapture(dataUrl);
      showStatus('success', '✓', 'Screenshot saved!');
    }

  } catch (err) {
    console.error('[UltraBox] Capture failed:', err);
    const msg = friendlyError(err.message);
    showStatus('error', '✕', msg);
  } finally {
    setLoadingState(false);
  }
}

// ─── Capture Methods ──────────────────────────────────────────────────────────

async function captureVisible(tab) {
  const res = await chrome.runtime.sendMessage({ action: 'captureVisible' });
  if (!res?.success) throw new Error(res?.error || 'Visible capture failed.');
  return res.dataUrl;
}

async function captureFullPage(tab) {
  const res = await chrome.runtime.sendMessage({ action: 'captureFullPage' });
  if (!res?.success) throw new Error(res?.error || 'Full-page capture failed.');
  return res.dataUrl;
}

// Selection is handled entirely by the content script (see content.js startSelectionDownload).
// The popup cannot await the response because it closes when the user clicks the page.
async function captureSelection(_tab) {
  // Should never be called — fire-and-forget path in startCapture handles selection.
  throw new Error('captureSelection should not be called directly.');
}

// ─── Download & Clipboard ─────────────────────────────────────────────────────

async function convertToFormat(dataUrl, fmt, qual) {
  if (fmt === 'jpeg' && dataUrl.startsWith('data:image/png')) {
    return await convertToJpeg(dataUrl, qual);
  }
  return dataUrl;
}

async function downloadCapture(dataUrl) {
  const fmt  = formatSelect.value;
  const qual = parseInt(qualityRange.value, 10) / 100;
  const finalUrl = await convertToFormat(dataUrl, fmt, qual);

  const ts       = timestamp();
  const filename = `UltraBox_Screenshot_${ts}.${fmt}`;

  await chrome.runtime.sendMessage({
    action: 'downloadImage',
    dataUrl: finalUrl,
    format: fmt,
    filename,
  });
}

async function copyDataUrlToClipboard(dataUrl, fmt, qual) {
  const finalUrl = await convertToFormat(dataUrl, fmt, qual);
  const res  = await fetch(finalUrl);
  const blob = await res.blob();
  const mimeType = blob.type || (fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
  await navigator.clipboard.write([
    new ClipboardItem({ [mimeType]: blob }),
  ]);
}

async function convertToJpeg(pngDataUrl, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas    = document.createElement('canvas');
      canvas.width    = img.naturalWidth;
      canvas.height   = img.naturalHeight;
      const ctx       = canvas.getContext('2d');
      ctx.fillStyle   = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Failed to load image for JPEG conversion.'));
    img.src = pngDataUrl;
  });
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setLoadingState(loading) {
  isCapturing = loading;
  btnCapture.disabled = loading;
  btnCopy.disabled    = loading;
  if (loading) {
    btnCapture.classList.add('loading');
    btnCapture.innerHTML = `<span class="spinner"></span> Capturing…`;
  } else {
    btnCapture.classList.remove('loading');
    btnCapture.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
              stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="12" cy="13" r="4" stroke="currentColor" stroke-width="2"/>
      </svg>
      Capture`;
  }
}

function showStatus(type, icon, text, persist = false) {
  clearTimeout(statusTimeout);
  statusBar.removeAttribute('hidden');
  statusBar.dataset.type  = type;
  statusIcon.textContent  = icon || '';
  statusText.textContent  = text;

  if (type === 'loading' || persist) return;

  statusTimeout = setTimeout(hideStatus, 4000);
}

function hideStatus() {
  statusBar.setAttribute('hidden', '');
  delete statusBar.dataset.type;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, -5); // Remove trailing Z and milliseconds
}

function friendlyError(msg = '') {
  if (msg.includes('Cannot access') || msg.includes('activeTab'))
    return 'Cannot capture this page (browser restriction).';
  if (msg.includes('permission') || msg.includes('Permission'))
    return 'Permission denied. Reload the page and try again.';
  if (msg.includes('clipboard'))
    return 'Clipboard access denied. Check browser permissions.';
  if (msg.includes('download'))
    return 'Download failed. Check Downloads permissions.';
  if (msg.includes('dimension') || msg.includes('Invalid'))
    return 'Invalid dimensions. Use positive numbers only.';
  return msg || 'An unexpected error occurred.';
}
