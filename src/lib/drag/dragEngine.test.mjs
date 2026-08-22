import test from "node:test";
import assert from "node:assert/strict";

import { pickZone } from "./dragEngine.js";

/**
 * Which zone a release lands in.
 *
 * The stakes are lopsided: landing on the desktop moves an icon a few pixels,
 * landing on a folder moves real files on disk. So the rule these pin down is
 * that the folder has to be earned — a drag that merely passes over one leaves
 * the drop to the surface behind it.
 */

const folder = (dwell = 500) => ({ dwell: () => dwell });
const surface = () => ({ dwell: () => 0 });

test("a zone that asks for no dwell takes the drop immediately", () => {
  const desktop = surface();
  assert.equal(pickZone([desktop], 0, 0), desktop);
  assert.equal(pickZone([], 0, 0), null);
});

test("a folder swept over mid-drag doesn't take the drop", () => {
  const archive = folder();
  const desktop = surface();
  // 120ms in: the pointer is over the folder, but only in passing.
  assert.equal(pickZone([archive, desktop], 1000, 1120), desktop);
});

test("a folder settled on takes the drop", () => {
  const archive = folder();
  const desktop = surface();
  assert.equal(pickZone([archive, desktop], 1000, 1500), archive);
  assert.equal(pickZone([archive, desktop], 1000, 9000), archive);
});

test("with nothing behind it, an unearned folder drops nowhere", () => {
  const archive = folder();
  assert.equal(pickZone([archive], 1000, 1120), null);
  assert.equal(pickZone([archive], 1000, 1500), archive);
});

test("only the innermost zone can be waited out", () => {
  // A folder tile nested inside another folder's zone: the dwell the pointer
  // spent on the tile is the tile's, and doesn't hand the outer folder a drop.
  const tile = folder();
  const outer = folder();
  const desktop = surface();
  assert.equal(pickZone([tile, outer, desktop], 1000, 1500), tile);
  assert.equal(pickZone([tile, outer, desktop], 1000, 1120), desktop);
});
