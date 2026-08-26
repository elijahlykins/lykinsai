"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ELECTRON_ROOT = path.resolve(__dirname, "..", "..", "electron");

const SKIP_DIR_NAMES = new Set([
  "browser-agent",
  "bot-harness",
  "eval",
  "appRuntime",
  "vendor",
  "resources",
  "localStore",
]);

const CHANNEL_RE = /ipcMain\.(handle|on)\(\s*(['"])(lykn:[^'"]+)\2/g;

function listCjsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name) || ent.name === "node_modules") continue;
      listCjsFiles(full, out);
      continue;
    }
    if (!ent.name.endsWith(".cjs") || ent.name.endsWith(".test.cjs")) continue;
    out.push(full);
  }
  return out;
}

function collectFromFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(ELECTRON_ROOT, filePath).split(path.sep).join("/");
  const entries = [];
  CHANNEL_RE.lastIndex = 0;
  let m;
  while ((m = CHANNEL_RE.exec(src))) {
    entries.push({ mode: m[1], channel: m[3], file: rel });
  }
  return entries;
}

function findDuplicates(entries) {
  const seen = new Map();
  const dups = [];
  for (const e of entries) {
    if (seen.has(e.channel)) {
      dups.push({
        channel: e.channel,
        first: seen.get(e.channel),
        second: { mode: e.mode, file: e.file },
      });
    } else {
      seen.set(e.channel, { mode: e.mode, file: e.file });
    }
  }
  return dups;
}

function buildManifest() {
  const files = listCjsFiles(ELECTRON_ROOT).sort();
  const entries = files.flatMap(collectFromFile);
  const unique = [...entries].sort((a, b) =>
    a.channel === b.channel ? a.mode.localeCompare(b.mode) : a.channel.localeCompare(b.channel),
  );
  return {
    generatedBy: "tests/electron/ipcSurface.cjs",
    channelCount: entries.length,
    uniqueChannelCount: new Set(entries.map((e) => e.channel)).size,
    handleCount: entries.filter((e) => e.mode === "handle").length,
    onCount: entries.filter((e) => e.mode === "on").length,
    duplicateCount: findDuplicates(entries).length,
    entries: unique,
  };
}

module.exports = { ELECTRON_ROOT, buildManifest, findDuplicates, collectFromFile };
