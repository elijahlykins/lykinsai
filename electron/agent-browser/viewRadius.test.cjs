"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyViewRadius,
  fallbackUniformRadius,
  normalizeViewRadius,
  pageClipRadius,
  viewRadiiEqual,
  viewRadiusMax,
} = require("./viewRadius.cjs");

test("normalizeViewRadius accepts a uniform integer and per-corner object", () => {
  assert.equal(normalizeViewRadius(14), 14);
  assert.equal(normalizeViewRadius("14"), 14);
  assert.deepEqual(normalizeViewRadius({ topLeft: 14, topRight: 0, bottomRight: 0, bottomLeft: 14 }), {
    topLeft: 14,
    topRight: 0,
    bottomRight: 0,
    bottomLeft: 14,
  });
  assert.equal(normalizeViewRadius(null), null);
  assert.equal(normalizeViewRadius(undefined), null);
});

test("viewRadiusMax is the chrome-notch fill used when extending the chrome view", () => {
  assert.equal(viewRadiusMax(14), 14);
  assert.equal(
    viewRadiusMax({ topLeft: 14, topRight: 0, bottomRight: 0, bottomLeft: 14 }),
    14,
  );
});

test("join radii compare equal after rounding and mixed number/object forms do not", () => {
  assert.equal(
    viewRadiiEqual(
      { topLeft: 14.2, topRight: 0, bottomRight: 0, bottomLeft: 14 },
      { topLeft: 14, topRight: 0, bottomRight: 0, bottomLeft: 14 },
    ),
    true,
  );
  assert.equal(
    viewRadiiEqual(14, { topLeft: 14, topRight: 0, bottomRight: 0, bottomLeft: 14 }),
    false,
  );
  assert.equal(viewRadiiEqual(14, 14), true);
});

test("join specs clip with the container curve, never a silent 0", () => {
  assert.equal(
    fallbackUniformRadius({ topLeft: 14, topRight: 0, bottomRight: 0, bottomLeft: 14 }),
    14,
  );
  assert.equal(fallbackUniformRadius(14), 14);
});

test("applyViewRadius only passes the integer Electron clips with", () => {
  const calls = [];
  applyViewRadius(
    { setBorderRadius(value) { calls.push(value); } },
    { topLeft: 14, topRight: 0, bottomRight: 0, bottomLeft: 14 },
  );
  applyViewRadius({ setBorderRadius(value) { calls.push(value); } }, 14);
  assert.deepEqual(calls, [14, 14]);
});

test("page clip is square so the live site meets the tab strip flush", () => {
  assert.equal(pageClipRadius(), 0);
});

test("docked host stores the renderer radius spec and lays out with it", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const host = fs.readFileSync(path.join(__dirname, "host.cjs"), "utf8");
  assert.match(host, /require\("\.\/viewRadius\.cjs"\)/);
  assert.match(host, /normalizeViewRadius\(radius\)/);
  assert.match(host, /viewRadiusMax\(studioStageRadius\)/);
  assert.match(host, /pageClipRadius\(\)/);
  assert.match(host, /\{ radius: pageClipRadius\(\) \}/);
  assert.match(host, /\{ radius: studioStageRadius \}/);
});
