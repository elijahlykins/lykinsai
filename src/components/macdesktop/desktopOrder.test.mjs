import test from "node:test";
import assert from "node:assert/strict";

import { arrangementFor, orderIcons, readDesktopIcons } from "./desktopOrder.js";
import { gridSlot, pixelsOf } from "./desktopGrid.js";

/**
 * Organising the desktop has to cover everything on it. These pin down the
 * order icons come out in, and the thing that actually went wrong before:
 * three stores tidying separately handed out the same slot, so icons landed on
 * top of each other.
 */

const LAYER = { w: 1512, h: 900 };

// Laid out the way the desktop fills — down the right-hand column first, so
// `col` counts in from the right edge and rises going left.
const icon = (id, extra = {}) => ({
  id,
  name: id,
  kind: "Text",
  date: 0,
  col: 0,
  row: 0,
  ...extra,
});

test("kind groups folders first, then media, then documents", () => {
  const order = orderIcons(
    [
      icon("notes.txt", { kind: "Text" }),
      icon("clip.mov", { kind: "Movie" }),
      icon("Projects", { kind: "Folder" }),
      icon("shot.png", { kind: "Image" }),
      icon("Mail.app", { kind: "Application" }),
    ],
    "kind",
  ).map((i) => i.id);

  assert.deepEqual(order, ["Projects", "Mail.app", "shot.png", "clip.mov", "notes.txt"]);
});

test("an unfamiliar kind sorts to the end rather than the front", () => {
  const order = orderIcons(
    [icon("thing.qqq", { kind: "QQQ file" }), icon("Projects", { kind: "Folder" })],
    "kind",
  ).map((i) => i.id);
  assert.deepEqual(order, ["Projects", "thing.qqq"]);
});

test("name sorts the way the Finder does, not the way ASCII does", () => {
  const order = orderIcons(
    [icon("shot 10.png"), icon("apple.txt"), icon("shot 2.png"), icon("Banana.txt")],
    "name",
  ).map((i) => i.id);
  // Case-insensitive, and 2 before 10.
  assert.deepEqual(order, ["apple.txt", "Banana.txt", "shot 2.png", "shot 10.png"]);
});

test("date puts the newest first and undated icons last", () => {
  const order = orderIcons(
    [
      icon("old", { date: 1000 }),
      icon("undated", { date: 0 }),
      icon("new", { date: 9000 }),
    ],
    "date",
  ).map((i) => i.id);
  assert.deepEqual(order, ["new", "old", "undated"]);
});

test("no sort key keeps the icons where they are, in reading order", () => {
  // Two columns of two. Reading order runs down the rightmost column first,
  // so the larger `col` (further in from the right) comes later.
  const order = orderIcons(
    [
      icon("second-col-bottom", { col: 100, row: 90 }),
      icon("first-col-bottom", { col: 0, row: 90 }),
      icon("second-col-top", { col: 100, row: 0 }),
      icon("first-col-top", { col: 0, row: 0 }),
    ],
    null,
  ).map((i) => i.id);

  assert.deepEqual(order, [
    "first-col-top",
    "first-col-bottom",
    "second-col-top",
    "second-col-bottom",
  ]);
});

test("every icon gets its own slot, whichever store it came from", () => {
  // The bug this feature exists to fix: mirrored files, Home folders and the
  // pinned shortcuts each used to arrange alone and reuse each other's slots.
  const icons = [
    icon("file:/Users/me/Desktop/a.txt"),
    icon("folder:abc", { kind: "Folder" }),
    icon("pinned:files", { kind: "Folder" }),
    icon("file:/Users/me/Desktop/b.png", { kind: "Image" }),
  ];
  const positions = arrangementFor(icons, "kind", LAYER);

  assert.equal(Object.keys(positions).length, icons.length);
  const seen = new Set(Object.values(positions).map((p) => `${p.x},${p.y}`));
  assert.equal(seen.size, icons.length, "two icons were given the same spot");
});

test("icons land on the grid, starting at the first slot", () => {
  const positions = arrangementFor([icon("only")], "name", LAYER);
  assert.deepEqual(positions.only, pixelsOf(gridSlot(0, LAYER), LAYER));
});

test("an icon with no id is left out rather than written as undefined", () => {
  const positions = arrangementFor([icon("real"), icon(null)], "name", LAYER);
  assert.deepEqual(Object.keys(positions), ["real"]);
});

test("reading an empty desktop is not an error", () => {
  assert.deepEqual(readDesktopIcons(null), []);
});

test("icons are read off the desktop with what they sort by", () => {
  // A stand-in for the desktop layer: enough of an element for the reader.
  const el = (attrs, box) => ({
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => box,
  });
  const root = {
    getBoundingClientRect: () => ({ top: 0, right: 1000 }),
    querySelectorAll: () => [
      el(
        {
          "data-desktop-icon": "file:/a.png",
          "data-desktop-name": "a.png",
          "data-desktop-kind": "Image",
          "data-desktop-date": "1700000000000",
        },
        { top: 40, right: 980 },
      ),
      // A folder made in Home: no date attribute at all.
      el(
        {
          "data-desktop-icon": "folder:x",
          "data-desktop-name": "Work",
          "data-desktop-kind": "Folder",
        },
        { top: 40, right: 880 },
      ),
    ],
  };

  assert.deepEqual(readDesktopIcons(root), [
    { id: "file:/a.png", name: "a.png", kind: "Image", date: 1700000000000, col: 20, row: 40 },
    { id: "folder:x", name: "Work", kind: "Folder", date: 0, col: 120, row: 40 },
  ]);
});
