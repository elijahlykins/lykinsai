"use strict";

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const GLASS_FALLBACK =
  process.env.LYKN_GLASS_FALLBACK != null
    ? process.env.LYKN_GLASS_FALLBACK === "1"
    : IS_MAC && process.arch === "x64";

const APP_URL = process.env.LYKN_APP_URL || "https://lykn.io";
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return "https://lykn.io";
  }
})();

const API_BASE = process.env.LYKN_API_URL || "https://api.lykn.io";

module.exports = {
  IS_MAC,
  IS_WIN,
  GLASS_FALLBACK,
  APP_URL,
  APP_ORIGIN,
  API_BASE,
};
