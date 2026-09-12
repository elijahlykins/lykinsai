"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clampOverlayMove, overlayMoveFromCursor, unionRects } = require("./overlayMove.cjs");

const WORK = { x: 0, y: 25, width: 1440, height: 875 };

test("clamp keeps the bar inside the work area", () => {
  const next = clampOverlayMove({ x: -40, y: 900, width: 520, height: 130 }, WORK);
  assert.equal(next.x, 0);
  assert.equal(next.y, 25 + 875 - 130 - 8);
  assert.equal(next.width, 520);
  assert.equal(next.height, 130);
});

test("clamp allows free movement inside the work area", () => {
  const next = clampOverlayMove({ x: 200, y: 180, width: 520, height: 130 }, WORK);
  assert.deepEqual(next, { x: 200, y: 180, width: 520, height: 130 });
});

test("cursor follow moves the bar by the pointer delta", () => {
  const origin = { cursorX: 400, cursorY: 800, x: 100, y: 700, width: 520, height: 130 };
  const next = overlayMoveFromCursor(origin, { x: 460, y: 740 }, WORK);
  assert.equal(next.x, 160);
  assert.equal(next.y, 640);
});

test("cursor follow uses the union of work areas so the bar can change displays", () => {
  const origin = { cursorX: 1400, cursorY: 400, x: 900, y: 300, width: 520, height: 130 };
  const union = unionRects([
    WORK,
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ]);
  const next = overlayMoveFromCursor(origin, { x: 1700, y: 420 }, union);
  assert.equal(next.x, 1200);
  assert.equal(next.y, 320);
});
