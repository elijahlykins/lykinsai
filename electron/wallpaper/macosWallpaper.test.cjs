"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TAHOE_DARK,
  TAHOE_LIGHT,
  DEFAULT_DESKTOP,
  DEFAULT_AERIAL_JPG,
  SONOMA_HEIC,
  parseWallpaperStore,
  resolveMacWallpaperStill,
  osDefaultWallpaperItems,
} = require("./macosWallpaper.cjs");

const DEFAULT_STORE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>AllSpacesAndDisplays</key>
  <dict>
    <key>Linked</key>
    <dict>
      <key>Content</key>
      <dict>
        <key>Choices</key>
        <array>
          <dict>
            <key>Configuration</key>
            <data></data>
            <key>Files</key>
            <array/>
            <key>Provider</key>
            <string>default</string>
          </dict>
        </array>
      </dict>
    </dict>
  </dict>
</dict>
</plist>`;

const IMAGE_STORE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>AllSpacesAndDisplays</key>
  <dict>
    <key>Linked</key>
    <dict>
      <key>Content</key>
      <dict>
        <key>Choices</key>
        <array>
          <dict>
            <key>Files</key>
            <array/>
            <key>Provider</key>
            <string>com.apple.wallpaper.choice.image</string>
          </dict>
        </array>
      </dict>
    </dict>
  </dict>
</dict>
</plist>`;

function existsSet(paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

test("default Apple wallpaper store has a provider and no files", () => {
  const store = parseWallpaperStore(DEFAULT_STORE);
  assert.equal(store.provider, "default");
  assert.deepEqual(store.paths, []);
});

test("built-in default wallpaper resolves to the Tahoe still, not a missing file", () => {
  const exists = existsSet([TAHOE_LIGHT, TAHOE_DARK, DEFAULT_DESKTOP]);
  assert.equal(
    resolveMacWallpaperStill(DEFAULT_STORE, { appearance: "light", exists }),
    TAHOE_LIGHT,
  );
  assert.equal(
    resolveMacWallpaperStill(DEFAULT_STORE, { appearance: "dark", exists }),
    TAHOE_DARK,
  );
});

test("default wallpaper falls back to DefaultDesktop when Tahoe stills are absent", () => {
  const exists = existsSet([DEFAULT_DESKTOP, DEFAULT_AERIAL_JPG]);
  assert.equal(
    resolveMacWallpaperStill(DEFAULT_STORE, { appearance: "light", exists }),
    DEFAULT_DESKTOP,
  );
});

test("a downloaded custom photo wins over the built-in default still", () => {
  const photo = "/Users/ada/Pictures/wallpaper.jpg";
  const xml = DEFAULT_STORE.replace(
    "<array/>",
    `<array><string>file://${photo}</string></array>`,
  ).replace("<string>default</string>", "<string>com.apple.wallpaper.choice.image</string>");
  const exists = existsSet([photo, TAHOE_LIGHT]);
  assert.equal(resolveMacWallpaperStill(xml, { exists }), photo);
});

test("a .madesktop stub uses a sibling still when Apple has not downloaded a master", () => {
  const stub = "/System/Library/Desktop Pictures/Ventura Graphic.madesktop";
  const still = "/System/Library/Desktop Pictures/Ventura Graphic.heic";
  const xml = `<?xml version="1.0"?><plist><dict>
    <key>Provider</key><string>com.apple.wallpaper.choice.dynamic</string>
    <string>file://${encodeURI(stub)}</string>
  </dict></plist>`;
  const exists = existsSet([still, TAHOE_LIGHT]);
  assert.equal(resolveMacWallpaperStill(xml, { exists }), still);
});

test("Sonoma provider uses the on-disk Sonoma still", () => {
  const xml = DEFAULT_STORE.replace(
    "<string>default</string>",
    "<string>com.apple.wallpaper.choice.sonoma</string>",
  );
  const exists = existsSet([SONOMA_HEIC, TAHOE_LIGHT]);
  assert.equal(resolveMacWallpaperStill(xml, { exists }), SONOMA_HEIC);
});

test("a missing custom image does not silently become Tahoe", () => {
  const photo = "/Users/ada/Pictures/gone.jpg";
  const xml = IMAGE_STORE.replace(
    "<array/>",
    `<array><string>file://${photo}</string></array>`,
  );
  const exists = existsSet([TAHOE_LIGHT]);
  assert.equal(resolveMacWallpaperStill(xml, { exists }), "");
});

test("picker stills include Tahoe and Aerial when those files exist", () => {
  const exists = existsSet([TAHOE_LIGHT, DEFAULT_AERIAL_JPG]);
  const items = osDefaultWallpaperItems({ appearance: "light", exists });
  assert.deepEqual(
    items.map((item) => item.name),
    ["Tahoe", "Aerial"],
  );
  assert.equal(items[0].source, TAHOE_LIGHT);
  assert.equal(items[0].pin, true);
  assert.equal(items[1].source, DEFAULT_AERIAL_JPG);
});

test("bookmark data blobs still surface custom file:// wallpapers", () => {
  const photo = "/Users/ada/Pictures/from-bookmark.jpg";
  const blob = Buffer.from(`xxxxfile://${photo}\0yyyy`).toString("base64");
  const xml = `<plist><dict><key>Provider</key><string>com.apple.wallpaper.choice.image</string>
    <data>${blob}</data></dict></plist>`;
  const exists = existsSet([photo]);
  assert.equal(resolveMacWallpaperStill(xml, { exists }), photo);
});
