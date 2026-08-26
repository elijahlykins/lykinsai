import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { buildManifest } = require(path.join(root, "tests/electron/ipcSurface.cjs"));

const out = path.join(root, "tests/electron/ipcManifest.json");
const manifest = buildManifest();
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `wrote ${path.relative(root, out)} (${manifest.channelCount} channels, ${manifest.handleCount} handle, ${manifest.onCount} on)`,
);
