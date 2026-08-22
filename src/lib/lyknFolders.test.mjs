import test from "node:test";
import assert from "node:assert/strict";

/**
 * Whether a folder still reads as one LYKN made after the user moves it about.
 *
 * The record is only a list of paths, so everything that changes a path is a
 * chance for a white folder to quietly turn blue: a rename takes its children
 * with it, a batch move renames some and refuses others, and the Trash takes
 * whole trees. These pin down that the list survives all three.
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window = {
  dispatchEvent: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
}

const {
  copyLyknFolders,
  forgetLyknFolders,
  isLyknFolder,
  readLyknFolders,
  relocateLyknFolders,
  rememberLyknFolder,
  rememberLyknFolders,
  transferredPairs,
} = await import("./lyknFolders.js");

test.beforeEach(() => store.clear());

test("a folder is remembered once, trailing slash or not", () => {
  rememberLyknFolder("/Users/me/Desktop/Ideas/");
  rememberLyknFolder("/Users/me/Desktop/Ideas");
  const made = readLyknFolders();
  assert.equal(made.size, 1);
  assert.ok(isLyknFolder(made, "/Users/me/Desktop/Ideas"));
  assert.ok(!isLyknFolder(made, "/Users/me/Desktop/Photos"));
  assert.ok(!isLyknFolder(made, ""));
});

test("renaming a folder brings the ones inside it along", () => {
  rememberLyknFolders(["/Users/me/Desktop/Ideas", "/Users/me/Desktop/Ideas/2026"]);
  relocateLyknFolders([["/Users/me/Desktop/Ideas", "/Users/me/Desktop/Plans"]]);
  const made = readLyknFolders();
  assert.ok(isLyknFolder(made, "/Users/me/Desktop/Plans"));
  assert.ok(isLyknFolder(made, "/Users/me/Desktop/Plans/2026"));
  assert.ok(!isLyknFolder(made, "/Users/me/Desktop/Ideas"));
});

test("a folder that only shares a name prefix is left alone", () => {
  rememberLyknFolders(["/Users/me/Ideas", "/Users/me/Ideas Archive"]);
  relocateLyknFolders([["/Users/me/Ideas", "/Users/me/Plans"]]);
  const made = readLyknFolders();
  assert.ok(isLyknFolder(made, "/Users/me/Ideas Archive"));
  assert.ok(!isLyknFolder(made, "/Users/me/Plans Archive"));
});

test("trashing a folder forgets what it held", () => {
  rememberLyknFolders([
    "/Users/me/Desktop/Ideas",
    "/Users/me/Desktop/Ideas/2026",
    "/Users/me/Desktop/Photos",
  ]);
  forgetLyknFolders(["/Users/me/Desktop/Ideas"]);
  const made = readLyknFolders();
  assert.deepEqual([...made], ["/Users/me/Desktop/Photos"]);
});

test("a copy of a LYKN folder is one too, a copy of the Mac's is not", () => {
  rememberLyknFolder("/Users/me/Desktop/Ideas");
  copyLyknFolders([
    ["/Users/me/Desktop/Ideas", "/Users/me/Desktop/Ideas copy"],
    ["/Users/me/Documents/Taxes", "/Users/me/Desktop/Taxes"],
  ]);
  const made = readLyknFolders();
  assert.ok(isLyknFolder(made, "/Users/me/Desktop/Ideas copy"));
  assert.ok(!isLyknFolder(made, "/Users/me/Desktop/Taxes"));
});

test("a batch move pairs each source with where it actually landed", () => {
  // The shell reports what moved and what refused in source order, so the
  // failure in the middle must not shift the rest onto the wrong destinations.
  const sources = ["/a/one", "/a/two", "/a/three"];
  const result = {
    ok: false,
    paths: ["/b/one", "/b/three"],
    failed: [{ path: "/a/two", error: "into_itself" }],
  };
  assert.deepEqual(transferredPairs(sources, result), [
    ["/a/one", "/b/one"],
    ["/a/three", "/b/three"],
  ]);
});

test("a move renames the folders that made it", () => {
  rememberLyknFolders(["/a/one", "/a/two"]);
  const result = { ok: false, paths: ["/b/one"], failed: [{ path: "/a/two" }] };
  relocateLyknFolders(transferredPairs(["/a/one", "/a/two"], result));
  const made = readLyknFolders();
  assert.ok(isLyknFolder(made, "/b/one"));
  assert.ok(isLyknFolder(made, "/a/two"));
});
