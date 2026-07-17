#!/usr/bin/env node
// Generate the macOS menu-bar (tray) template icon from the app icon.
//
// macOS template images are monochrome: the system renders them from the
// ALPHA channel only (black in light menu bars, white in dark). The app icon
// is a white glyph on a blue rounded square, so its alpha silhouette is a
// useless solid blob — instead we lift the WHITE GLYPH out of the artwork
// (whiteness → alpha), crop to it, and downsample to menu-bar sizes.
//
// Outputs (Electron auto-pairs the @2x for Retina):
//   electron/resources/trayTemplate.png      18×18
//   electron/resources/trayTemplate@2x.png   36×36
//
//   node scripts/generate-tray-icon.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'electron', 'resources', 'icon.png');
const outDir = path.join(root, 'electron', 'resources');

const src = PNG.sync.read(fs.readFileSync(srcPath));

// 1. Whiteness → alpha. The glyph is white (min channel ≈ 255); the blue
//    field's min channel sits far lower, so a ramp between them keeps the
//    anti-aliased glyph edges smooth.
const LO = 120, HI = 235;
const mask = new PNG({ width: src.width, height: src.height });
for (let i = 0; i < src.data.length; i += 4) {
  const minc = Math.min(src.data[i], src.data[i + 1], src.data[i + 2]);
  const whiteness = Math.max(0, Math.min(1, (minc - LO) / (HI - LO)));
  const alpha = Math.round(whiteness * (src.data[i + 3] / 255) * 255);
  mask.data[i] = 0;
  mask.data[i + 1] = 0;
  mask.data[i + 2] = 0;
  mask.data[i + 3] = alpha;
}

// 2. Crop to the glyph's bounding box.
let minX = mask.width, minY = mask.height, maxX = 0, maxY = 0;
for (let y = 0; y < mask.height; y++) {
  for (let x = 0; x < mask.width; x++) {
    if (mask.data[(y * mask.width + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const bw = maxX - minX + 1;
const bh = maxY - minY + 1;
// Square canvas with a small margin so the glyph doesn't touch the edges.
const side = Math.ceil(Math.max(bw, bh) * 1.08);
const cropped = new PNG({ width: side, height: side });
const offX = Math.floor((side - bw) / 2);
const offY = Math.floor((side - bh) / 2);
for (let y = 0; y < bh; y++) {
  for (let x = 0; x < bw; x++) {
    const from = ((minY + y) * mask.width + (minX + x)) * 4;
    const to = ((offY + y) * side + (offX + x)) * 4;
    mask.data.copy(cropped.data, to, from, from + 4);
  }
}

// 3. Box-filter downsample (alpha only — rgb stays black).
function downsample(img, size) {
  const out = new PNG({ width: size, height: size });
  const scale = img.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.min(img.width, Math.ceil((x + 1) * scale));
      const y0 = Math.floor(y * scale), y1 = Math.min(img.height, Math.ceil((y + 1) * scale));
      let sum = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += img.data[(sy * img.width + sx) * 4 + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out.data[o] = 0;
      out.data[o + 1] = 0;
      out.data[o + 2] = 0;
      out.data[o + 3] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

for (const [name, size] of [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]]) {
  const out = downsample(cropped, size);
  fs.writeFileSync(path.join(outDir, name), PNG.sync.write(out));
  console.log(`wrote electron/resources/${name} (${size}×${size})`);
}
