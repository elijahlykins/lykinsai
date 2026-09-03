import test from "node:test";
import assert from "node:assert/strict";

import { canThumbnail, previewKind } from "./preview.js";

/**
 * Two listings feed these helpers and they don't describe a file the same way:
 * the file browser's entries carry `ext`, the shell listing behind the Home
 * desktop carries only `name`. Reading one and not the other is what left
 * every photo dropped on Home drawn as a blank document.
 */

test("an entry labelled with ext is classified by it", () => {
  assert.equal(previewKind({ type: "file", name: "holiday.jpg", ext: "jpg" }), "image");
  assert.equal(previewKind({ type: "file", name: "clip.mov", ext: "mov" }), "video");
  assert.equal(previewKind({ type: "file", name: "report.pdf", ext: "pdf" }), "pdf");
  assert.equal(previewKind({ type: "file", name: "notes.txt", ext: "txt" }), "text");
  assert.equal(previewKind({ type: "file", name: "Cover-Letter.html", ext: "html" }), "html");
});

test("an entry with only a name falls back to reading the name", () => {
  assert.equal(previewKind({ type: "file", name: "holiday.JPG" }), "image");
  assert.equal(previewKind({ type: "file", name: "shot.png" }), "image");
  assert.equal(previewKind({ type: "file", name: "archive.tar.gz" }), null);
  assert.equal(previewKind({ type: "file", name: "Makefile" }), null);
});

test("a leading dot is a hidden file, not an extension", () => {
  assert.equal(previewKind({ type: "file", name: ".png" }), null);
});

test("folders and packages never claim a preview", () => {
  assert.equal(previewKind({ type: "dir", name: "Pictures" }), null);
  assert.equal(previewKind({ type: "dir", name: "Xcode.app", package: true }), null);
  assert.equal(previewKind(null), null);
});

test("canThumbnail draws photos from disk, by name alone if that's all there is", () => {
  assert.equal(canThumbnail({ type: "file", name: "holiday.jpg", size: 2048 }), true);
  // SVG is an image LYKN previews but won't draw into a tile.
  assert.equal(canThumbnail({ type: "file", name: "logo.svg", size: 2048 }), false);
  assert.equal(canThumbnail({ type: "file", name: "raw.heic", size: 2048 }), false);
  assert.equal(canThumbnail({ type: "file", name: "notes.txt", size: 2048 }), false);
});

test("a photo too big to decode keeps its kind icon", () => {
  assert.equal(canThumbnail({ type: "file", name: "huge.png", size: 64 * 1024 * 1024 }), false);
  // An unknown size is the shell's answer for anything it couldn't stat.
  assert.equal(canThumbnail({ type: "file", name: "huge.png", size: null }), true);
});
