"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { workAreaBoundsForDisplay } = require("./studioWorkArea.cjs");

const laptop = {
  workArea: { x: 0, y: 38, width: 1512, height: 909 },
};

const ultrawide = {
  workArea: { x: -1920, y: 25, width: 3440, height: 1415 },
};

test("windowed Studio fills the display work area", () => {
  assert.deepEqual(workAreaBoundsForDisplay(laptop), {
    x: 0,
    y: 38,
    width: 1512,
    height: 909,
  });
  assert.deepEqual(workAreaBoundsForDisplay(ultrawide), {
    x: -1920,
    y: 25,
    width: 3440,
    height: 1415,
  });
});

test("missing or invalid work area is ignored", () => {
  assert.equal(workAreaBoundsForDisplay(null), null);
  assert.equal(workAreaBoundsForDisplay({}), null);
  assert.equal(workAreaBoundsForDisplay({ workArea: { x: 0, y: 0, width: 0, height: 800 } }), null);
});

test("the Home shell no longer caps windowed layout at 1240px", () => {
  const studio = fs.readFileSync(path.join(__dirname, "../../src/pages/Studio.jsx"), "utf8");
  assert.doesNotMatch(studio, /max-w-\[1240px\]/);
  assert.match(studio, /lykn-studio-fs-pad/);
});
