import test from "node:test";
import assert from "node:assert/strict";

import {
  desktopMetrics,
  desktopScale,
  gridSlot,
  pixelsOf,
  placementOf,
  savedPlacement,
} from "./desktopGrid.js";

/**
 * The desktop is dragged between displays, so an icon's stored position has to
 * mean the same thing on a laptop panel and on a 32" monitor. These pin down
 * the two halves of that: icons scale with the desktop, and a placement lands
 * in the same *place* on any of them rather than at the same pixel.
 */

const LAPTOP = { w: 1512, h: 900 };
const BIG = { w: 2560, h: 1400 };
const SMALL = { w: 1180, h: 700 };

test("icons scale with the desktop, within reason", () => {
  assert.equal(desktopScale(LAPTOP), 1);
  assert.ok(desktopScale(BIG) > 1);
  assert.ok(desktopScale(SMALL) < 1);
  // A wall-sized display doesn't get wall-sized icons, and a small window
  // doesn't shrink them past reading.
  assert.ok(desktopScale({ w: 8000, h: 5000 }) <= 1.55);
  assert.ok(desktopScale({ w: 500, h: 300 }) >= 0.9);
});

test("a short, wide desktop scales by its height", () => {
  // Otherwise the width would inflate the icons and push the bottom row off.
  const wide = { w: 3400, h: 900 };
  assert.equal(desktopScale(wide), desktopScale({ w: 1512, h: 900 }));
});

test("an unmeasured desktop falls back to the reference size", () => {
  assert.deepEqual(desktopMetrics({ w: 0, h: 0 }), desktopMetrics(LAPTOP));
});

test("a placement round-trips through pixels on the same desktop", () => {
  for (const layer of [LAPTOP, BIG, SMALL]) {
    const start = { col: 1.5, row: 2.25 };
    const back = placementOf(pixelsOf(start, layer), layer);
    assert.ok(Math.abs(back.col - start.col) < 0.01, `col on ${layer.w}`);
    assert.ok(Math.abs(back.row - start.row) < 0.01, `row on ${layer.w}`);
  }
});

test("an icon on the right edge stays on the right edge on every display", () => {
  const rightmost = gridSlot(0, LAPTOP);
  for (const layer of [LAPTOP, BIG, SMALL]) {
    const m = desktopMetrics(layer);
    const { x } = pixelsOf(rightmost, layer);
    // The gap from the icon's right edge to the wallpaper's is the padding,
    // whatever the display is.
    assert.equal(layer.w - (x + m.cellW), m.pad, `right gap on ${layer.w}`);
  }
});

test("icons a column apart stay a column apart", () => {
  for (const layer of [LAPTOP, BIG, SMALL]) {
    const m = desktopMetrics(layer);
    const first = pixelsOf({ col: 0, row: 0 }, layer);
    const second = pixelsOf({ col: 1, row: 0 }, layer);
    assert.equal(first.x - second.x, m.cellW, `column gap on ${layer.w}`);
  }
});

test("this is the bug: a pixel position does not survive the move", () => {
  // Parked against the right edge of the big display, then read literally on
  // the laptop — which is how icons ended up stranded mid-wallpaper.
  const parked = pixelsOf(gridSlot(0, BIG), BIG);
  assert.ok(parked.x > LAPTOP.w, "the saved pixel is off the smaller desktop");
  // The same spot as a placement lands where it belongs on both.
  const asPlacement = placementOf(parked, BIG);
  assert.ok(pixelsOf(asPlacement, LAPTOP).x < LAPTOP.w - 100);
});

test("a placement is pulled back onto a desktop too small to hold it", () => {
  const far = { col: 40, row: 40 };
  const m = desktopMetrics(SMALL);
  const { x, y } = pixelsOf(far, SMALL);
  assert.ok(x >= m.pad && x <= SMALL.w - m.cellW);
  assert.ok(y >= m.pad && y <= SMALL.h - m.cellH);
});

test("grid slots fill columns from the top-right", () => {
  assert.deepEqual(gridSlot(0, LAPTOP), { col: 0, row: 0 });
  // Down the rightmost column before starting the next one in.
  assert.deepEqual(gridSlot(1, LAPTOP), { col: 0, row: 1 });
  assert.ok(gridSlot(50, LAPTOP).col > 0, "a long list wraps into the next column");
});

test("positions saved as raw pixels are still readable", () => {
  const legacy = { x: 1300, y: 120 };
  const placement = savedPlacement(legacy, LAPTOP);
  const { x, y } = pixelsOf(placement, LAPTOP);
  assert.ok(Math.abs(x - legacy.x) <= 1);
  assert.ok(Math.abs(y - legacy.y) <= 1);
  assert.equal(savedPlacement(null, LAPTOP), null);
  assert.equal(savedPlacement({ nope: 1 }, LAPTOP), null);
});
