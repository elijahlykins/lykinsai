"use strict";

const { BrowserWindow } = require("electron");

function broadcastToAllWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    } catch (_) {}
  }
}

function initializeElectronServices({ app, session, localStore, localSystem, macFiles }) {
  localSystem.configure(app.getPath("userData"));
  macFiles.configure({
    userDataPath: app.getPath("userData"),
    onChange: (dirPath) => broadcastToAllWindows("lykn:files-changed", { path: dirPath }),
  });
  require("../appBridge.cjs").configure({
    onFilesList: async (dirPath) => {
      const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
      if (!enabled) throw new Error("Local mode is off. Enable it in the Vault first.");
      const res = await localSystem.run(
        "local_list_dir",
        { path: dirPath || "~" },
        { userDataPath: app.getPath("userData") },
      );
      if (!res?.ok) throw new Error(res?.error || "could not list that folder");
      return { path: res.path, entries: res.entries };
    },
    onFilesRead: async (filePath) => {
      const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
      if (!enabled) throw new Error("Local mode is off. Enable it in the Vault first.");
      const res = await localSystem.run(
        "local_read_file",
        { path: filePath },
        { userDataPath: app.getPath("userData") },
      );
      if (!res?.ok) throw new Error(res?.error || "could not read that file");
      return { path: res.path, content: res.content, truncated: res.truncated };
    },
  });

  require("../macFileProtocol.cjs").bind(session.defaultSession);

  try {
    const opened = localStore.configure(app.getPath("userData"));
    console.log(`[LYKN] local store ready (schema v${opened.version ?? "?"})`);
    require("../localStore/blobProtocol.cjs").bind(session.defaultSession);
    require("../appProtocol.cjs").bind(session.defaultSession);
    require("../appBridge.cjs").bind();
    setTimeout(() => {
      try {
        const pending = localStore.indexer.pendingCount();
        const total = pending.items + pending.threads;
        if (!total) return;
        console.log(`[LYKN] embedding backfill: ${total} source(s) outstanding`);
        localStore.indexer.backfill().catch((err) => {
          console.error("[LYKN] backfill failed to start:", err?.message);
        });
      } catch (err) {
        console.error("[LYKN] backfill check failed:", err?.message);
      }
    }, 30_000).unref?.();
  } catch (err) {
    console.error("[LYKN] local store failed to open:", err?.message);
  }
}

module.exports = { initializeElectronServices, broadcastToAllWindows };
