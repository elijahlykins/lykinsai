"use strict";

const {
  AGENT_SIDEBAR_WIDTH,
  MENU_GAP,
  LIVE_WIDTH,
} = require("../windows/overlayConstants.cjs");

const AGENT_SIDEBAR_MIN_HEIGHT = 180;
const AGENT_SIDEBAR_MAX_HEIGHT = 560;

function sidebarTargetBounds({
  overlayBounds,
  workArea,
  sidebarHeight,
  liveVisible,
  panelVisible,
  panelWidth,
}) {
  const h = Math.max(
    AGENT_SIDEBAR_MIN_HEIGHT,
    Math.min(sidebarHeight, AGENT_SIDEBAR_MAX_HEIGHT, workArea.height - 16),
  );
  const rightInset =
    (liveVisible ? LIVE_WIDTH + MENU_GAP : 0) +
    (panelVisible ? Number(panelWidth) + MENU_GAP : 0);
  let x = overlayBounds.x + overlayBounds.width + MENU_GAP + rightInset;
  if (x + AGENT_SIDEBAR_WIDTH > workArea.x + workArea.width) {
    x = overlayBounds.x - MENU_GAP - AGENT_SIDEBAR_WIDTH;
  }
  x = Math.max(workArea.x, x);
  let y = overlayBounds.y + overlayBounds.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: AGENT_SIDEBAR_WIDTH,
    height: h,
  };
}

module.exports = {
  AGENT_SIDEBAR_MIN_HEIGHT,
  AGENT_SIDEBAR_MAX_HEIGHT,
  sidebarTargetBounds,
};
