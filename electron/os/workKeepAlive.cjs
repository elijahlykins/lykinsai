"use strict";

/**
 * Keep in-flight LYKN work alive while the display sleeps.
 *
 * `prevent-app-suspension` (macOS NoIdleSleep) lets the screen go black
 * without freezing Chromium / Node, so a turn can finish. Full system sleep
 * and shutdown freeze or kill the process - those events mark work Paused.
 *
 * Lock-screen is not a pause: the machine is still awake.
 */

const BLOCKER_TYPE = "prevent-app-suspension";

function normalizeSource(raw) {
  const s = String(raw || "").trim().slice(0, 64);
  return s || "work";
}

function createWorkKeepAlive({
  powerSaveBlocker,
  powerMonitor,
  broadcast = () => {},
} = {}) {
  const holds = new Set();
  const pauseListeners = new Set();
  let blockerId = null;
  let paused = false;

  function blockerStarted() {
    return blockerId != null && powerSaveBlocker?.isStarted?.(blockerId);
  }

  function syncBlocker() {
    const shouldHold = holds.size > 0 && !paused;
    if (shouldHold && !blockerStarted()) {
      try {
        blockerId = powerSaveBlocker.start(BLOCKER_TYPE);
      } catch (err) {
        blockerId = null;
        console.warn("[workKeepAlive] power blocker failed:", err?.message || err);
      }
      return;
    }
    if (!shouldHold && blockerId != null) {
      try {
        if (powerSaveBlocker?.isStarted?.(blockerId)) powerSaveBlocker.stop(blockerId);
      } catch {
        /* ignore */
      }
      blockerId = null;
    }
  }

  function hold(source) {
    holds.add(normalizeSource(source));
    syncBlocker();
    return holds.size;
  }

  function release(source) {
    holds.delete(normalizeSource(source));
    syncBlocker();
    return holds.size;
  }

  function isHeld() {
    return holds.size > 0;
  }

  function sources() {
    return [...holds];
  }

  function onPause(fn) {
    if (typeof fn !== "function") return () => {};
    pauseListeners.add(fn);
    return () => pauseListeners.delete(fn);
  }

  /**
   * Full sleep / shutdown: stop keeping the machine awake and tell every
   * surface to show Paused. No-op when nothing is in flight.
   */
  function pause(reason) {
    const why = String(reason || "suspend");
    if (holds.size === 0) return false;
    const active = sources();
    holds.clear();
    paused = true;
    syncBlocker();
    for (const fn of pauseListeners) {
      try {
        fn(why, active);
      } catch (err) {
        console.warn("[workKeepAlive] pause listener failed:", err?.message || err);
      }
    }
    try {
      broadcast("lykn:work-paused", { reason: why, sources: active });
    } catch {
      /* renderer may be gone */
    }
    return true;
  }

  function resume() {
    paused = false;
    syncBlocker();
  }

  function attachPowerListeners() {
    if (!powerMonitor?.on) return () => {};
    const onSuspend = () => pause("suspend");
    const onShutdown = () => pause("shutdown");
    const onResume = () => resume();
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("shutdown", onShutdown);
    powerMonitor.on("resume", onResume);
    return () => {
      powerMonitor.off?.("suspend", onSuspend);
      powerMonitor.off?.("shutdown", onShutdown);
      powerMonitor.off?.("resume", onResume);
    };
  }

  return {
    BLOCKER_TYPE,
    hold,
    release,
    isHeld,
    sources,
    pause,
    resume,
    onPause,
    attachPowerListeners,
    syncBlocker,
  };
}

function attachWorkKeepAlive(d) {
  if (d.__attached_attachWorkKeepAlive) return;
  d.__attached_attachWorkKeepAlive = true;

  const { powerMonitor, powerSaveBlocker, ipcMain, app } = d.electron;
  const path = d.node.path;
  const { APP_ORIGIN, APP_URL } = d.env;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");
  const {
    isTrustedLyknIpcSender,
    trustedLyknIpcOpts,
  } = require("../trustedIpcSender.cjs");

  const keepAlive = createWorkKeepAlive({
    powerSaveBlocker,
    powerMonitor,
    broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  });
  keepAlive.attachPowerListeners();
  d.workKeepAlive = keepAlive;

  const trustOpts = trustedLyknIpcOpts({
    app,
    path,
    appOrigin: APP_ORIGIN,
    appUrl: APP_URL,
  });

  keepAlive.onPause(() => {
    try {
      d.cancelOverlayAsk?.();
    } catch {
      /* ask may not be attached yet */
    }
    try {
      d.initAgentRuntime?.()?.pauseForPower?.();
    } catch {
      /* runtime may not exist */
    }
  });

  ipcMain.on("lykn:work-hold", (event, source) => {
    if (!isTrustedLyknIpcSender(event, trustOpts)) return;
    keepAlive.hold(`ui:${source}`);
  });
  ipcMain.on("lykn:work-release", (event, source) => {
    if (!isTrustedLyknIpcSender(event, trustOpts)) return;
    keepAlive.release(`ui:${source}`);
  });
}

module.exports = { createWorkKeepAlive, attachWorkKeepAlive, BLOCKER_TYPE };
