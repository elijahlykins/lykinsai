"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_SIDEBAR_WIDTH,
  MENU_GAP,
  LIVE_WIDTH,
} = require("../windows/overlayConstants.cjs");
const {
  AGENT_SIDEBAR_MAX_HEIGHT,
  sidebarTargetBounds,
} = require("./sidebarLayout.cjs");

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const overlayBounds = { x: 100, y: 800, width: 520, height: 82 };

test("sidebar sits to the right of the overlay by MENU_GAP", () => {
  const bounds = sidebarTargetBounds({
    overlayBounds,
    workArea,
    sidebarHeight: 360,
    liveVisible: false,
    panelVisible: false,
    panelWidth: 300,
  });
  assert.deepEqual(bounds, {
    x: overlayBounds.x + overlayBounds.width + MENU_GAP,
    y: overlayBounds.y + overlayBounds.height - 360,
    width: AGENT_SIDEBAR_WIDTH,
    height: 360,
  });
});

test("sidebar steps past open live and panel windows", () => {
  const bounds = sidebarTargetBounds({
    overlayBounds,
    workArea,
    sidebarHeight: 360,
    liveVisible: true,
    panelVisible: true,
    panelWidth: 300,
  });
  assert.equal(
    bounds.x,
    overlayBounds.x +
      overlayBounds.width +
      MENU_GAP +
      LIVE_WIDTH +
      MENU_GAP +
      300 +
      MENU_GAP,
  );
});

test("sidebar flips left when the right flank overflows the work area", () => {
  const bounds = sidebarTargetBounds({
    overlayBounds: { x: 400, y: 800, width: 520, height: 82 },
    workArea: { x: 0, y: 0, width: 1500, height: 1080 },
    sidebarHeight: 360,
    liveVisible: true,
    panelVisible: false,
    panelWidth: 300,
  });
  assert.equal(bounds.x, 400 - MENU_GAP - AGENT_SIDEBAR_WIDTH);
});

test("sidebar clamps into the work area and height range", () => {
  const bounds = sidebarTargetBounds({
    overlayBounds: { x: 8, y: 40, width: 520, height: 82 },
    workArea: { x: 0, y: 0, width: 600, height: 200 },
    sidebarHeight: 900,
    liveVisible: false,
    panelVisible: false,
    panelWidth: 300,
  });
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
  assert.equal(bounds.height, Math.min(AGENT_SIDEBAR_MAX_HEIGHT, 200 - 16));
});
