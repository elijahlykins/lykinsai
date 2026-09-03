"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dockedPageBoundsForOverlay } = require("./menuOverlayLayout.cjs");

test("docked Sync overlay parks the page so the menu is hittable", () => {
  const open = dockedPageBoundsForOverlay({
    overlay: true,
    x: 40,
    y: 12,
    chromeH: 82,
    width: 900,
    pageH: 640,
  });
  assert.deepEqual(open, { x: 40, y: 94, width: 0, height: 0 });
});

test("docked page keeps its panel rect when Sync is closed", () => {
  const closed = dockedPageBoundsForOverlay({
    overlay: false,
    x: 40,
    y: 12,
    chromeH: 82,
    width: 900,
    pageH: 640,
  });
  assert.deepEqual(closed, { x: 40, y: 94, width: 900, height: 640 });
});

test("menu overlay IPC writes the host overlay flag used by layout", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const host = fs.readFileSync(path.join(__dirname, "host.cjs"), "utf8");
  const bridge = fs.readFileSync(path.join(__dirname, "../ipc/agentBridge.cjs"), "utf8");
  assert.match(host, /bindLet\("agentStageMenuOverlay"/);
  assert.match(bridge, /d\.agentStageMenuOverlay = next/);
  assert.match(bridge, /lykn:agent-stage-menu-overlay/);
  assert.match(host, /if \(agentStageMenuOverlay\)/);
});
