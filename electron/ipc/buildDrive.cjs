"use strict";

// Renderer-facing bridge for the Builds folder in AI Drive.
//
// Build projects live on disk under ~/LYKN/Builds (electron/build-workspace),
// not in the vault, so the drive lists them through this bridge instead of
// vault rows. Deliberately NOT gated on Local Mode: the Build workspace is its
// own trust domain (always-allowed, workspace-scoped), and the drive should
// show what Build Mode made whether or not Mac-wide file access is on.
// Both handlers stay read-only-plus-reveal — anything that mutates the
// workspace keeps going through the local tool pipeline and its approvals.

const { untrustedSenderResult, trustedLyknIpcOpts } = require("../trustedIpcSender.cjs");
const buildWorkspace = require("../build-workspace/workspace.cjs");

function registerBuildDriveIpc(d) {
  const { app, ipcMain, shell, path, APP_ORIGIN, APP_URL } = d;

  const senderOpts = trustedLyknIpcOpts({ app, path, appOrigin: APP_ORIGIN, appUrl: APP_URL });
  const requireTrusted = (handler) => async (e, ...args) => {
    const denied = untrustedSenderResult(e, senderOpts);
    if (denied) return denied;
    return handler(e, ...args);
  };

  /** Project folders under the workspace root, newest first. */
  ipcMain.handle("lykn:builds-list", requireTrusted(async () => {
    try {
      const projects = await buildWorkspace.listProjects();
      return { ok: true, root: buildWorkspace.workspaceRoot(), projects };
    } catch (err) {
      return { ok: false, error: err?.message || "builds list failed" };
    }
  }));

  /** Open a project folder in Finder. Only paths inside the workspace. */
  ipcMain.handle("lykn:builds-open", requireTrusted(async (_e, { path: target } = {}) => {
    const abs = buildWorkspace.canonicalPath(String(target || ""));
    if (!abs || !buildWorkspace.isWorkspacePath(abs)) {
      return { ok: false, error: "Not a Build project" };
    }
    try {
      const err = await shell.openPath(abs);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || "open failed" };
    }
  }));
}

module.exports = { registerBuildDriveIpc };
