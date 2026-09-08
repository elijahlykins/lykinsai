"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { resolveKey, resolveModifiers, resolveButton, NATIVE_KEYS } = require("./surface/input.cjs");

// These tests cover the pure resolvers only. They never touch the native
// binding, so they neither move the mouse nor require a permission grant.

test("resolveKey maps letters, digits and function keys", () => {
  assert.deepEqual(resolveKey("a"), { ok: true, key: "a" });
  assert.deepEqual(resolveKey("5"), { ok: true, key: "5" });
  assert.deepEqual(resolveKey("f12"), { ok: true, key: "f12" });
});

test("resolveKey is case-insensitive", () => {
  assert.deepEqual(resolveKey("F5"), { ok: true, key: "f5" });
  assert.deepEqual(resolveKey("Escape"), { ok: true, key: "escape" });
  assert.deepEqual(resolveKey("ENTER"), { ok: true, key: "enter" });
});

test("resolveKey accepts the modifier names a model actually writes", () => {
  for (const [name, native] of [
    ["cmd", "cmd"], ["command", "cmd"], ["ctrl", "control"], ["control", "control"],
    ["alt", "alt"], ["option", "alt"], ["opt", "alt"], ["shift", "shift"],
  ]) {
    assert.deepEqual(resolveKey(name), { ok: true, key: native }, name);
  }
});

test("resolveKey accepts punctuation both by name and literally", () => {
  assert.deepEqual(resolveKey("["), { ok: true, key: "[" });
  assert.deepEqual(resolveKey("leftbracket"), { ok: true, key: "[" });
  assert.deepEqual(resolveKey("period"), { ok: true, key: "." });
  assert.deepEqual(resolveKey("."), { ok: true, key: "." });
});

test("resolveKey rejects an unknown key instead of pressing nothing", () => {
  // The native layer looks the name up in a map and, on a miss, returns
  // success having pressed NOTHING. Catching it here is the whole point.
  const r = resolveKey("splungebutton");
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad_key");
  assert.match(r.hint, /not a key this system recognizes/);
});

test("resolveKey rejects keys the native table maps to null", () => {
  // "Pause" is a real entry in the upstream enum whose native string is null,
  // so it would silently do nothing.
  assert.equal(resolveKey("pause").ok, false);
});

test("resolveKey rejects empty input", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(resolveKey(v).ok, false);
});

test("resolveModifiers propagates a bad modifier rather than dropping it", () => {
  assert.deepEqual(resolveModifiers(["cmd", "shift"]), { ok: true, keys: ["cmd", "shift"] });
  const bad = resolveModifiers(["cmd", "nope"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad_key");
});

test("resolveModifiers tolerates a missing or empty list", () => {
  assert.deepEqual(resolveModifiers(undefined), { ok: true, keys: [] });
  assert.deepEqual(resolveModifiers([]), { ok: true, keys: [] });
});

test("resolveButton accepts the three buttons and rejects anything else", () => {
  assert.deepEqual(resolveButton("left"), { ok: true, button: "left" });
  assert.deepEqual(resolveButton("MIDDLE"), { ok: true, button: "middle" });
  assert.deepEqual(resolveButton("right"), { ok: true, button: "right" });
  assert.deepEqual(resolveButton(undefined), { ok: true, button: "left" });
  const bad = resolveButton("elbow");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad_button");
});

test("the key table covers the keys Blender's default map leans on", () => {
  // Blender is driven by chords and single-letter tool keys; a gap here is a
  // silent no-op at the native layer.
  const needed = [
    "g", "r", "s", "x", "y", "z", "tab", "escape", "delete", "enter",
    "numpad_0", "numpad_1", "numpad_7", "f12", "space", "shift", "ctrl", "alt", "cmd",
    "left", "right", "up", "down", ".", "/",
  ];
  for (const k of needed) assert.ok(NATIVE_KEYS.get(k), `missing key: ${k}`);
});
