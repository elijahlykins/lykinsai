#!/usr/bin/env node
// Generate Windows app + tray icons from electron/resources/icon.png.
//
// Outputs:
//   electron/resources/icon.ico          multi-size (16…256)
//   electron/resources/tray-win.png      16×16 colored
//   electron/resources/tray-win@2x.png   32×32 colored
//
//   node scripts/generate-windows-icons.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = path.join(root, "electron", "resources", "icon.png");
const outDir = path.join(root, "electron", "resources");

const src = PNG.sync.read(fs.readFileSync(srcPath));

function downsample(img, size) {
  const out = new PNG({ width: size, height: size });
  const scale = img.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(img.width, Math.ceil((x + 1) * scale));
      const y0 = Math.floor(y * scale);
      const y1 = Math.min(img.height, Math.ceil((y + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3];
          r += img.data[i] * alpha;
          g += img.data[i + 1] * alpha;
          b += img.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

function pngToIco(pngBuffers) {
  // ICONDIR + ICONDIRENTRY[] + image data (PNG-in-ICO)
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const entries = [];
  for (const buf of pngBuffers) {
    const png = PNG.sync.read(buf);
    const w = png.width >= 256 ? 0 : png.width;
    const h = png.height >= 256 ? 0 : png.height;
    entries.push({ w, h, size: buf.length, offset, buf });
    offset += buf.length;
  }
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0); // reserved
  out.writeUInt16LE(1, 2); // type = icon
  out.writeUInt16LE(count, 4);
  let entryAt = 6;
  for (const e of entries) {
    out[entryAt] = e.w;
    out[entryAt + 1] = e.h;
    out[entryAt + 2] = 0; // color palette
    out[entryAt + 3] = 0;
    out.writeUInt16LE(1, entryAt + 4); // planes
    out.writeUInt16LE(32, entryAt + 6); // bit count
    out.writeUInt32LE(e.size, entryAt + 8);
    out.writeUInt32LE(e.offset, entryAt + 12);
    e.buf.copy(out, e.offset);
    entryAt += 16;
  }
  return out;
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = icoSizes.map((s) => PNG.sync.write(downsample(src, s)));
fs.writeFileSync(path.join(outDir, "icon.ico"), pngToIco(pngBuffers));
console.log(`wrote electron/resources/icon.ico (${icoSizes.join(", ")})`);

for (const [name, size] of [
  ["tray-win.png", 16],
  ["tray-win@2x.png", 32],
]) {
  const out = downsample(src, size);
  fs.writeFileSync(path.join(outDir, name), PNG.sync.write(out));
  console.log(`wrote electron/resources/${name} (${size}×${size})`);
}
