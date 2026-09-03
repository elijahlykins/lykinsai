"use strict";

/**
 * Durable LYKN account session for this machine.
 *
 * Chromium localStorage already holds the Supabase session while the app is
 * using a stable origin, but welcome, login-item launches, and origin switches
 * (localhost vs lykn.io) can miss it. This file is the main-process copy:
 * encrypted with OS keychain via Electron safeStorage, mode 0600.
 */

const fs = require("node:fs");
const path = require("node:path");

const SESSION_FILE = "desktop-session";
const MAX_TOKEN_CHARS = 16_384;

function desktopSessionPath(userDataPath) {
  return path.join(String(userDataPath || ""), SESSION_FILE);
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1] || "";
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeSession(input) {
  const access_token = String(input?.access_token || "").trim();
  const refresh_token = String(input?.refresh_token || "").trim();
  if (!access_token || !refresh_token) return null;
  if (access_token.length > MAX_TOKEN_CHARS || refresh_token.length > MAX_TOKEN_CHARS) return null;
  if (!looksLikeJwt(access_token)) return null;
  const payload = decodeJwtPayload(access_token);
  const email = String(input?.email || payload?.email || payload?.user_metadata?.email || "")
    .trim()
    .slice(0, 320);
  const user_id = String(input?.user_id || payload?.sub || "").trim().slice(0, 128);
  return {
    access_token,
    refresh_token,
    ...(email ? { email } : {}),
    ...(user_id ? { user_id } : {}),
    savedAt: Date.now(),
  };
}

function sessionIdentity(session) {
  const normalized = session?.access_token && session?.refresh_token
    ? session
    : normalizeSession(session);
  if (!normalized?.access_token || !normalized?.refresh_token) {
    return { signedIn: false, email: null };
  }
  const email = String(normalized.email || "").trim() || null;
  return { signedIn: true, email };
}

function encryptionReady(opts = {}) {
  if (typeof opts.isEncryptionAvailable === "function") {
    try {
      return opts.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }
  return typeof opts.encryptString === "function" && typeof opts.decryptString === "function";
}

function saveDesktopSession(input, opts = {}) {
  const session = normalizeSession(input);
  const userDataPath = String(opts.userDataPath || "");
  if (!session || !userDataPath) return false;
  if (!encryptionReady(opts) || typeof opts.encryptString !== "function") return false;
  let blob;
  try {
    blob = opts.encryptString(JSON.stringify(session));
  } catch {
    return false;
  }
  if (!Buffer.isBuffer(blob) || blob.length === 0) {
    blob = Buffer.from(blob || []);
  }
  if (!blob.length) return false;
  const filePath = desktopSessionPath(userDataPath);
  const fsMod = opts.fs || fs;
  try {
    fsMod.mkdirSync(userDataPath, { recursive: true });
    fsMod.writeFileSync(filePath, blob, { mode: 0o600 });
    try {
      fsMod.chmodSync(filePath, 0o600);
    } catch {
      /* mode on write is enough on most volumes */
    }
    return true;
  } catch {
    return false;
  }
}

function clearDesktopSession(opts = {}) {
  const userDataPath = String(opts.userDataPath || "");
  if (!userDataPath) return;
  const fsMod = opts.fs || fs;
  try {
    fsMod.unlinkSync(desktopSessionPath(userDataPath));
  } catch {
    /* already gone */
  }
}

function loadDesktopSession(opts = {}) {
  const userDataPath = String(opts.userDataPath || "");
  if (!userDataPath) return null;
  if (!encryptionReady(opts) || typeof opts.decryptString !== "function") return null;
  const fsMod = opts.fs || fs;
  const filePath = desktopSessionPath(userDataPath);
  let raw;
  try {
    raw = fsMod.readFileSync(filePath);
  } catch {
    return null;
  }
  let parsed;
  try {
    const json = opts.decryptString(raw);
    parsed = JSON.parse(String(json || ""));
  } catch {
    clearDesktopSession(opts);
    return null;
  }
  const session = normalizeSession(parsed);
  if (!session) {
    clearDesktopSession(opts);
    return null;
  }
  return session;
}

module.exports = {
  SESSION_FILE,
  desktopSessionPath,
  decodeJwtPayload,
  looksLikeJwt,
  normalizeSession,
  sessionIdentity,
  saveDesktopSession,
  loadDesktopSession,
  clearDesktopSession,
};
