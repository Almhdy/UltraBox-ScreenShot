/**
 * generate-icons.js
 * Run with: node generate-icons.js
 * Requires: npm install sharp (or just use the pre-baked base64 approach below)
 * 
 * This script creates all required icon sizes for the extension.
 * It uses the 'sharp' library. If you don't want to install it,
 * the icons folder already contains base64-embedded fallbacks. 
 */
const fs   = require('fs');
const path = require('path');

// ── SVG source ────────────────────────────────────────────────────────────────
// A camera-cut icon on a dark indigo background
function svgIcon(size) {
  const s = size;
  const r = Math.round(s * 0.18); // corner radius ~18%
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${r}" fill="#1a1d26"/>
  <!-- Outer frame -->
  <rect x="${s*0.12}" y="${s*0.24}" width="${s*0.76}" height="${s*0.52}"
        rx="${r*0.5}" stroke="#5b7fee" stroke-width="${s*0.06}" fill="none"/>
  <!-- Lens -->
  <circle cx="${s*0.5}" cy="${s*0.5}" r="${s*0.17}"
          stroke="#7c9ef0" stroke-width="${s*0.06}" fill="none"/>
  <!-- Shutter bump -->
  <path d="M${s*0.36} ${s*0.24} L${s*0.42} ${s*0.14} L${s*0.58} ${s*0.14} L${s*0.64} ${s*0.24}"
        stroke="#5b7fee" stroke-width="${s*0.055}" fill="none"
        stroke-linejoin="round" stroke-linecap="round"/>
  <!-- Crop corners (selection icon hint) -->
  <path d="M${s*0.17} ${s*0.38} L${s*0.17} ${s*0.28} L${s*0.27} ${s*0.28}"
        stroke="#7c9ef0" stroke-width="${s*0.05}" fill="none"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
  <path d="M${s*0.83} ${s*0.38} L${s*0.83} ${s*0.28} L${s*0.73} ${s*0.28}"
        stroke="#7c9ef0" stroke-width="${s*0.05}" fill="none"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
</svg>`;
}

// ── Sizes ─────────────────────────────────────────────────────────────────────
const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

// Try using sharp if available; otherwise write SVG files (rename .svg → .png for dev)
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }

(async () => {
  for (const size of sizes) {
    const svg  = svgIcon(size);
    const dest = path.join(iconsDir, `icon${size}.png`);

    if (sharp) {
      await sharp(Buffer.from(svg))
        .png()
        .toFile(dest);
      console.log(`✓ Generated ${dest}`);
    } else {
      // Fallback: write SVG and rename
      const svgDest = path.join(iconsDir, `icon${size}.svg`);
      fs.writeFileSync(svgDest, svg, 'utf8');
      console.log(`⚠  sharp not found. Wrote ${svgDest} instead. Rename to .png or install sharp.`);
    }
  }
  console.log('\nDone! Icons are in /icons');
})();
