"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Resolve the current macOS wallpaper to a still image LYKN can copy.
 *
 * Apple's default and dynamic wallpapers often have no file:// image in the
 * wallpaper store - they are a Provider of "default", a .madesktop stub, or a
 * .mov. Custom photos do have a real path, which is why only downloaded images
 * used to sync. This module maps those built-in choices onto the stills macOS
 * already ships (Tahoe light/dark, DefaultDesktop, Sonoma, sibling HEICs).
 */

const SYSTEM_PICTURES = "/System/Library/Desktop Pictures";
const TAHOE_APPEX =
  "/System/Library/ExtensionKit/Extensions/NeptuneOneWallpaper.appex/Contents/Resources";
const TAHOE_LIGHT = path.join(TAHOE_APPEX, "TahoeLight.heic");
const TAHOE_DARK = path.join(TAHOE_APPEX, "TahoeDark.heic");
const DEFAULT_DESKTOP = "/System/Library/CoreServices/DefaultDesktop.heic";
const DEFAULT_AERIAL_HEIC = "/System/Library/Wallpapers/.default/DefaultAerial.heic";
const DEFAULT_AERIAL_JPG = "/System/Library/Wallpapers/.default/DefaultAerial.jpg";
const SONOMA_HEIC = path.join(SYSTEM_PICTURES, "Sonoma.heic");

const IMAGE_EXT_RE = /\.(heic|heif|jpe?g|png|tiff?|gif|bmp|webp)$/i;
const STUB_EXT_RE = /\.(madesktop|mov|mp4|m4v)$/i;

const DEFAULT_PROVIDERS = new Set([
  "default",
  "com.apple.NeptuneOneExtension",
]);
const SONOMA_PROVIDERS = new Set([
  "com.apple.wallpaper.choice.sonoma",
  "com.apple.wallpaper.extension.sonoma",
]);

function defaultExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function posixFromFileUrl(url) {
  try {
    return decodeURIComponent(String(url || "").replace(/^file:\/\//, "")).replace(/\/$/, "");
  } catch {
    return "";
  }
}

function fileUrlsFromWallpaperXml(xml) {
  const text = String(xml || "");
  const candidates = [...text.matchAll(/file:\/\/[^<"]+/g)].map((m) => m[0]);
  for (const blob of text.matchAll(/<data>([\s\S]*?)<\/data>/g)) {
    try {
      const decoded = Buffer.from(blob[1].replace(/\s+/g, ""), "base64").toString("latin1");
      for (const m of decoded.matchAll(/file:\/\/[\x20-\x7e]+/g)) candidates.push(m[0]);
    } catch {
      /* ignore malformed bookmark blobs */
    }
  }
  return candidates;
}

function firstProvider(xml) {
  const m = String(xml || "").match(/<key>Provider<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? m[1].trim() : "";
}

function parseWallpaperStore(xml) {
  const paths = [];
  const seen = new Set();
  for (const url of fileUrlsFromWallpaperXml(xml)) {
    const filePath = posixFromFileUrl(url);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return { provider: firstProvider(xml), paths };
}

function tahoeStills(appearance) {
  return appearance === "dark" ? [TAHOE_DARK, TAHOE_LIGHT] : [TAHOE_LIGHT, TAHOE_DARK];
}

function defaultStillCandidates(appearance) {
  return [...tahoeStills(appearance), DEFAULT_DESKTOP, DEFAULT_AERIAL_HEIC, DEFAULT_AERIAL_JPG];
}

function stillsForProvider(provider, appearance) {
  if (!provider || DEFAULT_PROVIDERS.has(provider)) return defaultStillCandidates(appearance);
  if (SONOMA_PROVIDERS.has(provider)) {
    return [SONOMA_HEIC, ...defaultStillCandidates(appearance)];
  }
  return [];
}

function siblingStillCandidates(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  const exts = [".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff"];
  const out = [];
  for (const ext of exts) out.push(path.join(dir, base + ext));
  for (const ext of exts) {
    out.push(path.join(SYSTEM_PICTURES, ".wallpapers", base, base + ext));
    out.push(path.join(SYSTEM_PICTURES, base + ext));
  }
  return out;
}

function firstExisting(paths, exists) {
  for (const filePath of paths) {
    if (filePath && exists(filePath)) return filePath;
  }
  return "";
}

/**
 * @param {string} xml wallpaper store Index.plist as XML
 * @param {{ appearance?: "light" | "dark", exists?: (p: string) => boolean }} [opts]
 * @returns {string} absolute path to a still image, or ""
 */
function resolveMacWallpaperStill(xml, opts = {}) {
  const exists = typeof opts.exists === "function" ? opts.exists : defaultExists;
  const appearance = opts.appearance === "dark" ? "dark" : "light";
  const store = parseWallpaperStore(xml);

  const images = store.paths.filter((p) => IMAGE_EXT_RE.test(p));
  const hit = firstExisting(images, exists);
  if (hit) return hit;

  for (const stub of store.paths.filter((p) => STUB_EXT_RE.test(p))) {
    const sibling = firstExisting(
      siblingStillCandidates(stub).filter((p) => p !== stub),
      exists,
    );
    if (sibling) return sibling;
  }

  const fromProvider = firstExisting(stillsForProvider(store.provider, appearance), exists);
  if (fromProvider) return fromProvider;

  // Empty store (or an unreadable provider) still has a system default still
  // on modern macOS. Only use it when nothing else was named.
  if (!store.paths.length) {
    return firstExisting(defaultStillCandidates(appearance), exists);
  }
  return "";
}

/**
 * Built-in Apple stills to offer in the wallpaper picker. These ship on disk,
 * so they do not need Apple's on-demand download the way .madesktop stubs do.
 */
function osDefaultWallpaperItems(opts = {}) {
  const exists = typeof opts.exists === "function" ? opts.exists : defaultExists;
  const appearance = opts.appearance === "dark" ? "dark" : "light";
  const items = [];
  const tahoe = firstExisting(tahoeStills(appearance), exists);
  if (tahoe) {
    items.push({
      name: "Tahoe",
      group: "pictures",
      source: tahoe,
      thumbSource: tahoe,
      thumbMax: 480,
      pin: true,
    });
  }
  const aerial = firstExisting([DEFAULT_AERIAL_JPG, DEFAULT_AERIAL_HEIC, DEFAULT_DESKTOP], exists);
  if (aerial) {
    items.push({
      name: "Aerial",
      group: "pictures",
      source: aerial,
      thumbSource: aerial,
      thumbMax: 480,
      pin: true,
    });
  }
  return items;
}

module.exports = {
  DEFAULT_AERIAL_HEIC,
  DEFAULT_AERIAL_JPG,
  DEFAULT_DESKTOP,
  IMAGE_EXT_RE,
  SONOMA_HEIC,
  TAHOE_DARK,
  TAHOE_LIGHT,
  osDefaultWallpaperItems,
  parseWallpaperStore,
  resolveMacWallpaperStill,
};
