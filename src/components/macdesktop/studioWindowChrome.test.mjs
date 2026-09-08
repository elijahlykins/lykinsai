import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyStudioWindowAction,
  studioFullscreenTrafficVisible,
  studioSurfaceFullscreen,
  studioWindowFillsDesktop,
} from "./studioWindowChrome.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("in-page traffic lights are only for fullscreen Home", () => {
  assert.equal(studioFullscreenTrafficVisible({ desktop: true, fullscreen: true }), true);
  assert.equal(studioFullscreenTrafficVisible({ desktop: true, fullscreen: false }), false);
  assert.equal(studioFullscreenTrafficVisible({ desktop: false, fullscreen: true }), false);
});

test("in-page traffic lights hide while a hosted surface is fullscreen", () => {
  assert.equal(
    studioFullscreenTrafficVisible({
      desktop: true,
      fullscreen: true,
      surfaceFullscreen: true,
    }),
    false,
  );
  assert.equal(
    studioFullscreenTrafficVisible({
      desktop: true,
      fullscreen: true,
      surfaceFullscreen: false,
    }),
    true,
  );
});

test("hosted fullscreen covers zoomed windows, Split View, and HTML fullscreen", () => {
  assert.equal(studioSurfaceFullscreen({}), false);
  assert.equal(studioSurfaceFullscreen({ zoomedWins: { calendar: false } }), false);
  assert.equal(studioSurfaceFullscreen({ zoomedWins: { calendar: true } }), true);
  assert.equal(studioSurfaceFullscreen({ split: { left: "chat" } }), true);
  assert.equal(studioSurfaceFullscreen({ htmlFullscreen: true }), true);
});

test("a zoomed window stops filling the desktop when it is closed, minimized, or restored", () => {
  assert.equal(studioWindowFillsDesktop({ zoomed: true }), true);
  assert.equal(studioWindowFillsDesktop({ zoomed: false }), false);
  assert.equal(studioWindowFillsDesktop({ zoomed: true, minimized: true }), false);
  assert.equal(studioWindowFillsDesktop({ zoomed: true, closing: true }), false);
  assert.equal(studioWindowFillsDesktop({ zoomed: true, peeked: true }), false);
  assert.equal(studioWindowFillsDesktop({ zoomed: true, hidden: true }), false);
});

test("close, minimize, and zoom drive the Studio window bridge", () => {
  const calls = [];
  const lykn = {
    closeStudio: () => calls.push("close"),
    minimizeStudio: () => calls.push("minimize"),
    setStudioFullscreen: (on) => calls.push(`fullscreen:${on}`),
  };
  applyStudioWindowAction(lykn, "close");
  applyStudioWindowAction(lykn, "minimize");
  applyStudioWindowAction(lykn, "zoom", { fullscreen: true });
  applyStudioWindowAction(null, "minimize");
  assert.deepEqual(calls, ["close", "minimize", "fullscreen:false"]);
});

test("Home mounts hover traffic lights for the fullscreen shell", () => {
  const studio = fs.readFileSync(path.join(here, "../../pages/Studio.jsx"), "utf8");
  const controls = fs.readFileSync(path.join(here, "StudioWindowControls.jsx"), "utf8");
  const css = fs.readFileSync(path.join(here, "../../styles/studio-shell.css"), "utf8");
  assert.match(studio, /StudioWindowControls/);
  assert.match(studio, /studioFullscreenTrafficVisible/);
  assert.match(studio, /surfaceFullscreen/);
  assert.match(controls, /lykn-studio-fs-traffic/);
  assert.match(css, /lykn-studio-fs-traffic:hover/);
});
