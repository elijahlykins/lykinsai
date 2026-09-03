"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { displayTopInsetForWindow } = require("./displayTopInset.cjs");

const notched = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 909 },
};

const plain = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 835 },
};

test("fullscreen on a notched MacBook clears the camera strip", () => {
  assert.equal(
    displayTopInsetForWindow({ x: 0, y: 0, width: 1512, height: 982 }, notched),
    38,
  );
});

test("fullscreen on a Mac without a notch uses the menu-bar height", () => {
  assert.equal(
    displayTopInsetForWindow({ x: 0, y: 0, width: 1440, height: 900 }, plain),
    25,
  );
});

test("a window already in the work area needs no extra inset", () => {
  assert.equal(
    displayTopInsetForWindow({ x: 80, y: 38, width: 1200, height: 800 }, notched),
    0,
  );
  assert.equal(
    displayTopInsetForWindow({ x: 80, y: 25, width: 1200, height: 800 }, plain),
    0,
  );
});

test("a window that only clips the strip reports the overlap", () => {
  assert.equal(
    displayTopInsetForWindow({ x: 0, y: 20, width: 800, height: 600 }, notched),
    18,
  );
});

test("missing geometry is zero", () => {
  assert.equal(displayTopInsetForWindow(null, notched), 0);
  assert.equal(displayTopInsetForWindow({ x: 0, y: 0, width: 100, height: 100 }, null), 0);
});
