"use strict";

const { registerOverlayIpc } = require("./overlayIpc.cjs");
const { registerWelcomeIpc } = require("./welcome.cjs");
const { registerOnboardingIpc } = require("./onboarding.cjs");
const { registerExtensionInstallIpc } = require("./extensionInstall.cjs");
const { registerRoutinesIpc } = require("./routines.cjs");
const { registerRemoteTargetsIpc } = require("./remoteTargets.cjs");
const { registerWorkflowsIpc } = require("./workflows.cjs");

function registerAllIpc(d) {
  registerOverlayIpc(d);
  registerWelcomeIpc(d);
  registerOnboardingIpc(d);
  registerExtensionInstallIpc(d);
  registerRoutinesIpc(d);
  registerRemoteTargetsIpc(d);
  registerWorkflowsIpc(d);
}

module.exports = {
  registerAllIpc,
  registerOverlayIpc,
  registerWelcomeIpc,
  registerOnboardingIpc,
  registerExtensionInstallIpc,
  registerRoutinesIpc,
  registerRemoteTargetsIpc,
  registerWorkflowsIpc,
};
