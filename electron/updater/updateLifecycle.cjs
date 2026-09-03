"use strict";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const ERROR_RETRY_MS = 5 * 60 * 1000;

function updateSnapshot({
  currentVersion = "",
  pendingVersion = "",
  downloading = false,
  packaged = true,
} = {}) {
  const pending = String(pendingVersion || "").trim();
  const ready = Boolean(pending);
  return {
    currentVersion: String(currentVersion || ""),
    pendingVersion: pending,
    downloading: Boolean(downloading) && !ready,
    ready,
    packaged: Boolean(packaged),
  };
}

function shouldReprompt({
  lastAt = 0,
  now = Date.now(),
  intervalMs = CHECK_INTERVAL_MS,
  force = false,
} = {}) {
  if (force) return true;
  if (!lastAt) return true;
  return now - Number(lastAt) >= Number(intervalMs || 0);
}

module.exports = {
  CHECK_INTERVAL_MS,
  ERROR_RETRY_MS,
  updateSnapshot,
  shouldReprompt,
};
