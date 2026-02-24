# UltraBox Screenshot – Chrome Extension

A powerful, pixel-perfect screenshot tool for Chrome with full-page, visible-area, and custom selection capture modes.

---

## 📁 File Structure

```
UltraBox Screenshot/
├── manifest.json              # Manifest V3 config, permissions, shortcuts
├── generate-icons.js          # Icon generator script (requires sharp)
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.css              # Dark Material-inspired styles
│   └── popup.js               # Popup controller (settings, capture logic)
├── background/
│   └── background.js          # Service worker: capture, download, stitching
└── content/
    ├── content.js             # In-page selection overlay & keyboard shortcuts
    └── content.css            # Overlay, toolbar, resize handle styles
```

---

## 🚀 Installation

### 1. Generate Icons

```bash
npm install sharp --save-dev
node generate-icons.js
```

This creates `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`.

> **No Node.js?** The script also writes `.svg` files as fallback.  
> Rename `icon{N}.svg` → `icon{N}.png` for quick testing (Chrome accepts SVG in MV3 to some extent, though PNG is preferred).

### 2. Load the Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer Mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `UltraBox Screenshot` folder
5. The extension icon appears in the toolbar

---

## ✨ Features

| Feature               | Details                                                      |
| --------------------- | ------------------------------------------------------------ |
| **Visible Area**      | Captures exactly what's in the viewport                      |
| **Full Page**         | Scrolls and stitches tiles for long pages                    |
| **Selection Mode**    | Drag/resize bounding box with pixel-perfect inputs           |
| **Pixel Controls**    | Width & height number inputs update the box live             |
| **Drag & Resize**     | 8 corner/edge handles + grab-to-move                         |
| **Keyboard Nudge**    | Arrow keys (1px), Shift+Arrow (10px)                         |
| **PNG / JPEG export** | JPEG quality slider (50–100%)                                |
| **Clipboard copy**    | One-click copy without saving to disk                        |
| **Settings sync**     | Mode, dimensions, format persist via `chrome.storage.sync`   |
| **Error handling**    | User-friendly messages for permissions, invalid inputs, etc. |

---

## ⌨️ Keyboard Shortcuts

| Shortcut       | Action                           |
| -------------- | -------------------------------- |
| `Ctrl+Shift+S` | Open popup                       |
| `Ctrl+Shift+D` | Activate selection mode directly |
| `Enter`        | Capture selection                |
| `Esc`          | Cancel selection                 |
| `←↑↓→`         | Nudge box 1px                    |
| `Shift+←↑↓→`   | Nudge box 10px                   |

> Shortcuts can be customised at `chrome://extensions/shortcuts`.

---

## 🔧 Permissions Used & Why

| Permission  | Reason                                             |
| ----------- | -------------------------------------------------- |
| `activeTab` | Read the currently active tab for capture          |
| `tabs`      | Get tab window ID for `captureVisibleTab`          |
| `scripting` | Inject content script for full-page scroll/measure |
| `storage`   | Persist settings across sessions                   |
| `downloads` | Save screenshots to the Downloads folder           |

---

## 🛠 Architecture Notes

### Full Page Capture

The background service worker:

1. Injects a helper script to get `scrollWidth`, `scrollHeight`, `innerWidth`, `innerHeight`
2. Iterates through a grid of scroll positions
3. Captures each viewport tile via `captureVisibleTab`
4. Stitches tiles onto an `OffscreenCanvas` and returns the final PNG data URL

### Selection Capture

The content script shows the in-page overlay. When the user confirms:

1. The overlay is hidden for 80ms so it doesn't appear in the screenshot
2. The background captures the visible tab
3. The content script crops the screenshot using an in-page `<canvas>`
4. The cropped data URL is returned to the popup

### JPEG Conversion

PNG → JPEG conversion happens in the popup context (has access to `<canvas>`), where quality is applied according to the slider value.

---

## ⚠️ Known Limitations

- Full-page capture on pages with `position: fixed` elements (navbars) may cause repeating elements in the stitched result (a Chrome limitation – `captureVisibleTab` includes fixed elements at every scroll position).
- Clipboard copy (`ClipboardItem`) requires HTTPS or `localhost`.
- Content script cannot be injected into `chrome://`, `chrome-extension://`, or native Chrome UI pages.

---

## 📄 License

MIT – free to use, modify, and distribute.
