"use strict";

const { registerOverlayShellIpc } = require("./overlayShell.cjs");
const { registerAgentBridgeIpc } = require("./agentBridge.cjs");
const { registerLocalModeIpc } = require("./localMode.cjs");
const { registerAppsIpc } = require("./apps.cjs");
const { registerLocalFilesIpc } = require("./localFiles.cjs");
const { registerOverlayAiIpc } = require("./overlayAi.cjs");

function registerOverlayIpc(d) {
  registerOverlayShellIpc(d);
  registerAgentBridgeIpc(d);
  registerLocalModeIpc(d);
  registerAppsIpc(d);
  registerLocalFilesIpc(d);
  registerOverlayAiIpc(d);
}

module.exports = { registerOverlayIpc };
