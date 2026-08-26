"use strict";

/**
 * IPC for saved Remote Targets (SSH hosts).
 *
 * The renderer owns the management UX (Settings → Connections → Remote
 * Targets); the MAIN process owns the durable store, host trust, and every
 * SSH connection. Everything returned across this boundary is the store's
 * publicView — address and environment for the user to recognize the host,
 * never authRef details or raw fingerprints.
 *
 * A compromised renderer can add or remove targets (equivalent to the user
 * doing it in the UI) but cannot read credentials (none are stored), cannot
 * mint host trust for a NEW key silently (trust set here writes the same
 * store the transport re-verifies against on every connection), and cannot
 * bypass consequential-action approvals, which live in the main-process
 * choice registry and task runtime.
 */

function registerRemoteTargetsIpc(d) {
  const { ipcMain } = d;
  const store = () => d.initAgentRuntime().remoteTargets();

  ipcMain.handle("lykn:remote-targets-list", () => {
    try {
      return { ok: true, targets: store().list() };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:remote-target-create", (_e, payload) => {
    try {
      const target = store().create(payload || {});
      return { ok: true, target };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:remote-target-update", (_e, payload) => {
    try {
      const target = store().update(payload?.targetId, payload?.patch || {});
      return target ? { ok: true, target } : { ok: false, error: "not_found" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:remote-target-delete", (_e, payload) => {
    try {
      const removed = store().remove(payload?.targetId);
      return { ok: removed, ...(removed ? {} : { error: "not_found" }) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Forget a host's trusted fingerprint (e.g. after a legitimate server
  // rebuild). The next connection re-runs first-use trust establishment with
  // an explicit fingerprint approval — trust is never re-minted silently.
  ipcMain.handle("lykn:remote-target-forget-trust", (_e, payload) => {
    try {
      const target = store().forgetTrust(payload?.targetId);
      return target ? { ok: true, target } : { ok: false, error: "not_found" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

module.exports = { registerRemoteTargetsIpc };
