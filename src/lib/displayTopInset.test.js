import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_TOP_INSET_VAR,
  applyDisplayTopInset,
  readDisplayTopInset,
  syncDisplayTopInset,
} from "./displayTopInset.js";

test("readDisplayTopInset is the menu-bar overlap for this window", () => {
  assert.equal(
    readDisplayTopInset({ screen: { availTop: 38 }, screenY: 0 }),
    38,
  );
  assert.equal(
    readDisplayTopInset({ screen: { availTop: 38 }, screenY: 38 }),
    0,
  );
  assert.equal(readDisplayTopInset({ screen: {}, screenY: 0 }), 0);
});

test("applyDisplayTopInset writes the CSS variable", () => {
  const props = {};
  const root = {
    style: {
      setProperty: (name, value) => {
        props[name] = value;
      },
    },
  };
  assert.equal(applyDisplayTopInset(38.4, root), 38);
  assert.equal(props[DISPLAY_TOP_INSET_VAR], "38px");
});

test("syncDisplayTopInset prefers the host measurement", () => {
  const props = {};
  const win = {
    screen: { availTop: 0 },
    screenY: 0,
    document: {
      documentElement: {
        style: {
          setProperty: (name, value) => {
            props[name] = value;
          },
        },
      },
    },
  };
  syncDisplayTopInset({ topInset: 38 }, win);
  assert.equal(props[DISPLAY_TOP_INSET_VAR], "38px");
});
