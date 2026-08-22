import test from "node:test";
import assert from "node:assert/strict";

import {
  baseName,
  canDropIntoFolder,
  movablePaths,
  normalizeDir,
  parentDir,
  wouldDropIntoSelf,
} from "./filesDrag.js";

/**
 * The rules that decide where a drop is allowed to put a file. Everything else
 * about a drag is pointers and pixels; this is the part that can lose someone's
 * work, so it's the part worth pinning down.
 */

test("parentDir walks up one level and stops at the root", () => {
  assert.equal(parentDir("/Users/me/Desktop/notes.txt"), "/Users/me/Desktop");
  assert.equal(parentDir("/Users/me/Desktop/"), "/Users/me");
  assert.equal(parentDir("/Users"), "/");
  assert.equal(parentDir(""), "/");
});

test("baseName and normalizeDir ignore trailing slashes", () => {
  assert.equal(baseName("/Users/me/Desktop/"), "Desktop");
  assert.equal(baseName("/a/b/c.png"), "c.png");
  assert.equal(normalizeDir("/Users/me/Desktop///"), "/Users/me/Desktop");
});

test("a folder can't be dropped into itself or anywhere inside it", () => {
  const dragged = ["/Users/me/Projects"];
  assert.equal(wouldDropIntoSelf(dragged, "/Users/me/Projects"), true);
  assert.equal(wouldDropIntoSelf(dragged, "/Users/me/Projects/"), true);
  assert.equal(wouldDropIntoSelf(dragged, "/Users/me/Projects/lykn/src"), true);
  // A sibling that merely starts with the same characters is a different place.
  assert.equal(wouldDropIntoSelf(dragged, "/Users/me/Projects-old"), false);
  assert.equal(wouldDropIntoSelf(dragged, "/Users/me/Desktop"), false);
});

test("movablePaths skips items already sitting in the destination", () => {
  const paths = ["/Users/me/Desktop/a.png", "/Users/me/Downloads/b.png"];
  assert.deepEqual(movablePaths(paths, "/Users/me/Desktop"), [
    "/Users/me/Downloads/b.png",
  ]);
  assert.deepEqual(movablePaths(paths, "/Users/me/Desktop/"), [
    "/Users/me/Downloads/b.png",
  ]);
  assert.deepEqual(movablePaths(paths, "/Users/me/Documents"), paths);
});

test("a folder only accepts a drop that would actually move something", () => {
  const from = (paths) => ({ paths });
  assert.equal(
    canDropIntoFolder(from(["/Users/me/Downloads/b.png"]), "/Users/me/Desktop"),
    true,
  );
  // Everything is already there — the folder should let the drop fall through
  // to whatever is behind it rather than running a no-op move.
  assert.equal(
    canDropIntoFolder(from(["/Users/me/Desktop/a.png"]), "/Users/me/Desktop"),
    false,
  );
  assert.equal(
    canDropIntoFolder(from(["/Users/me/Projects"]), "/Users/me/Projects/src"),
    false,
  );
  assert.equal(canDropIntoFolder(from([]), "/Users/me/Desktop"), false);
  assert.equal(canDropIntoFolder(from(["/Users/me/a.png"]), ""), false);
});
