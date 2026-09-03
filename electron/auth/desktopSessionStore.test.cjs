"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SESSION_FILE,
  desktopSessionPath,
  looksLikeJwt,
  normalizeSession,
  sessionIdentity,
  saveDesktopSession,
  loadDesktopSession,
  clearDesktopSession,
} = require("./desktopSessionStore.cjs");

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function fakeEncrypt(text) {
  return Buffer.from(`enc:${Buffer.from(String(text), "utf8").toString("base64")}`);
}

function fakeDecrypt(buf) {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  if (!raw.startsWith("enc:")) throw new Error("not encrypted");
  return Buffer.from(raw.slice(4), "base64").toString("utf8");
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-desktop-session-"));
}

function storeOpts(dir, extra = {}) {
  return {
    userDataPath: dir,
    fs,
    encryptString: fakeEncrypt,
    decryptString: fakeDecrypt,
    isEncryptionAvailable: () => true,
    ...extra,
  };
}

const ACCESS = fakeJwt({ email: "ada@lykn.io", sub: "user-1" });
const REFRESH = fakeJwt({ typ: "refresh" });

test("normalizeSession requires both tokens and a JWT access token", () => {
  assert.equal(normalizeSession({}), null);
  assert.equal(normalizeSession({ access_token: ACCESS }), null);
  assert.equal(normalizeSession({ access_token: "not-a-jwt", refresh_token: REFRESH }), null);
  const session = normalizeSession({ access_token: ACCESS, refresh_token: REFRESH });
  assert.equal(session.email, "ada@lykn.io");
  assert.equal(session.user_id, "user-1");
  assert.equal(looksLikeJwt(session.access_token), true);
});

test("save writes an encrypted file that does not contain the refresh token in plaintext", () => {
  const dir = tmpDir();
  try {
    assert.equal(
      saveDesktopSession({ access_token: ACCESS, refresh_token: REFRESH, email: "ada@lykn.io" }, storeOpts(dir)),
      true,
    );
    const filePath = desktopSessionPath(dir);
    assert.equal(path.basename(filePath), SESSION_FILE);
    const raw = fs.readFileSync(filePath);
    assert.equal(raw.includes(REFRESH), false);
    assert.equal(raw.toString("utf8").includes("ada@lykn.io"), false);
    const loaded = loadDesktopSession(storeOpts(dir));
    assert.equal(loaded.access_token, ACCESS);
    assert.equal(loaded.refresh_token, REFRESH);
    assert.equal(loaded.email, "ada@lykn.io");
    assert.deepEqual(sessionIdentity(loaded), { signedIn: true, email: "ada@lykn.io" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save is a no-op when OS encryption is unavailable", () => {
  const dir = tmpDir();
  try {
    const ok = saveDesktopSession(
      { access_token: ACCESS, refresh_token: REFRESH },
      storeOpts(dir, { isEncryptionAvailable: () => false }),
    );
    assert.equal(ok, false);
    assert.equal(fs.existsSync(desktopSessionPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt files are deleted and load returns null", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(desktopSessionPath(dir), Buffer.from("not-encrypted"), { mode: 0o600 });
    assert.equal(loadDesktopSession(storeOpts(dir)), null);
    assert.equal(fs.existsSync(desktopSessionPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDesktopSession removes the file", () => {
  const dir = tmpDir();
  try {
    saveDesktopSession({ access_token: ACCESS, refresh_token: REFRESH }, storeOpts(dir));
    clearDesktopSession(storeOpts(dir));
    assert.equal(fs.existsSync(desktopSessionPath(dir)), false);
    assert.deepEqual(sessionIdentity(null), { signedIn: false, email: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
