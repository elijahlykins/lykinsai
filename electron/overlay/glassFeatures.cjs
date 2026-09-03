"use strict";

/**
 * Soft-unplug Glass-only surfaces. Tools and UI stay in the repo;
 * product paths skip them while these are false. Flip to restore.
 *
 * Agent Mode stays available in Studio; this flag only covers ⌘L Glass.
 */
const GLASS_LIVE_WATCH_ENABLED = false;
const GLASS_AGENT_MODE_ENABLED = false;

module.exports = {
  GLASS_LIVE_WATCH_ENABLED,
  GLASS_AGENT_MODE_ENABLED,
};
