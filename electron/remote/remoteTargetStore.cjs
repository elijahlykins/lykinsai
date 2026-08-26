"use strict";

/**
 * Durable persistence for saved RemoteTargets and their trusted host keys.
 *
 * PERSISTENCE DECISION (following the routineStore precedent): remote targets
 * are small structured records that must survive restart and must be readable
 * by the MAIN process before any renderer window exists (a scheduled Routine
 * can target a saved host at 8 AM with no UI open). This store therefore uses
 * the same convention as routineStore: one JSON file in userData, atomic
 * tmp+rename writes, debounced persistence with a synchronous persistNow for
 * pre-connect checkpoints. Not SQLite — no migration machinery, no coupling to
 * Local Mode being configured.
 *
 * What is durable:
 *   - RemoteTarget definitions (host, port, username, environment, authRef
 *     REFERENCE — never a secret, workingDirectory, defaultCapabilities)
 *   - trustedHostFingerprint per target (the anti-MITM anchor)
 *
 * What is NEVER durable here: passwords, passphrases, private-key bodies, or
 * tokens. authRef names where the OS resolves the credential; the secret lives
 * in the SSH agent / OS keychain / key file, never in this file.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  createRemoteTarget,
  parseAdHocTarget,
  publicView,
  sanitizeFingerprint,
} = require("./remoteTarget.cjs");

const STORE_FILE = "remote-targets.json";
const STORE_VERSION = 1;
const MAX_TARGETS = 100;
const PERSIST_DEBOUNCE_MS = 500;

/**
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {() => number} [opts.now]
 * @param {(targets: object[]) => void} [opts.onChange]
 */
function createRemoteTargetStore({ userDataPath, now = () => Date.now(), onChange = () => {} } = {}) {
  if (!userDataPath) throw new TypeError("remoteTargetStore requires userDataPath");
  const file = path.join(userDataPath, STORE_FILE);

  /** @type {Map<string, object>} targetId → frozen RemoteTarget */
  const targets = new Map();
  let persistTimer = null;
  let persistChain = Promise.resolve();

  function load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { ok: true, loaded: 0 };
    }
    if (!raw || typeof raw !== "object") return { ok: true, loaded: 0 };
    for (const record of Array.isArray(raw.targets) ? raw.targets : []) {
      if (!record?.id || !record?.host) continue;
      try {
        // Re-canonicalize so a stale/hostile on-disk shape cannot smuggle an
        // unsafe host, a secret-shaped authRef, or a bad port into runtime.
        const target = createRemoteTarget(record, { id: record.id, now: record.createdAt });
        targets.set(target.id, target);
      } catch {
        // A record that no longer canonicalizes is dropped, not trusted.
      }
    }
    return { ok: true, loaded: targets.size };
  }

  function serialize() {
    return JSON.stringify({ v: STORE_VERSION, targets: [...targets.values()] }, null, 0);
  }

  function persistNowSync() {
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, serialize(), "utf8");
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  function persistNow() {
    persistChain = persistChain.then(async () => {
      const tmp = `${file}.tmp`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, serialize(), "utf8");
        await fsp.rename(tmp, file);
      } catch {
        /* a failed write must never break the runtime; retried on next change */
      }
    });
    return persistChain;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  function changed({ immediate = false } = {}) {
    if (immediate) void persistNow();
    else schedulePersist();
    try {
      onChange(list());
    } catch {
      /* observers must not break the store */
    }
  }

  function list() {
    return [...targets.values()].map(publicView);
  }

  /** Full record (host address included) for host-side transport use only. */
  function getRaw(targetId) {
    const target = targets.get(String(targetId || ""));
    return target || null;
  }

  function get(targetId) {
    return publicView(getRaw(targetId));
  }

  /** Find a saved target whose address matches a parsed ad-hoc spec. */
  function findByAddress({ username, host, port }) {
    for (const target of targets.values()) {
      if (
        target.host === host &&
        target.port === port &&
        (target.username || "") === (username || "")
      ) {
        return target;
      }
    }
    return null;
  }

  /**
   * Create a saved target. Throws TypeError on an invalid/unsafe definition.
   */
  function create(input = {}) {
    if (targets.size >= MAX_TARGETS) throw new Error("remote_target_limit_reached");
    const target = createRemoteTarget(input, { now: new Date(now()).toISOString() });
    targets.set(target.id, target);
    changed({ immediate: true });
    return publicView(target);
  }

  /**
   * Resolve an ad-hoc string ("user@host") into a target. If a saved target
   * already matches the address, that trusted record is returned. Otherwise an
   * EPHEMERAL (unsaved) target is minted — it is NOT persisted; the caller
   * saves it explicitly only when the product flow offers to.
   *
   * @returns {{ target: object|null, saved: boolean, error?: string }}
   */
  function resolveAdHoc(input, { authRef, environment } = {}) {
    const parsed = parseAdHocTarget(input);
    if (!parsed) return { target: null, saved: false, error: "unparseable_target" };
    const existing = findByAddress(parsed);
    if (existing) return { target: publicView(existing), saved: true };
    try {
      const ephemeral = createRemoteTarget(
        { ...parsed, authRef, environment, saved: false },
        { now: new Date(now()).toISOString() },
      );
      // Held in the map so trust and transport can find it during this run, but
      // marked saved:false so the UI can offer to persist it and so it is not
      // treated as a permanent saved host.
      targets.set(ephemeral.id, ephemeral);
      return { target: publicView(ephemeral), saved: false };
    } catch (e) {
      return { target: null, saved: false, error: e?.message || String(e) };
    }
  }

  /** Promote an ephemeral ad-hoc target to a saved one. */
  function save(targetId, patch = {}) {
    const target = targets.get(String(targetId || ""));
    if (!target) return null;
    const next = createRemoteTarget(
      { ...target, ...patch, saved: true },
      { id: target.id, now: target.createdAt },
    );
    const withStamp = createRemoteTarget(
      { ...next, updatedAt: new Date(now()).toISOString() },
      { id: target.id, now: target.createdAt },
    );
    targets.set(target.id, withStamp);
    changed({ immediate: true });
    return publicView(withStamp);
  }

  function update(targetId, patch = {}) {
    const target = targets.get(String(targetId || ""));
    if (!target) return null;
    // Editing must never DOWNGRADE trust or environment implicitly: a patch that
    // omits trustedHostFingerprint keeps the existing one; environment can be
    // set explicitly here because this is user/host configuration, not the
    // model. Fingerprint is only cleared through forgetTrust().
    const merged = {
      ...target,
      ...patch,
      trustedHostFingerprint: target.trustedHostFingerprint,
      updatedAt: new Date(now()).toISOString(),
    };
    const next = createRemoteTarget(merged, { id: target.id, now: target.createdAt });
    targets.set(target.id, next);
    changed({ immediate: true });
    return publicView(next);
  }

  function remove(targetId) {
    const existed = targets.delete(String(targetId || ""));
    if (existed) changed({ immediate: true });
    return existed;
  }

  /**
   * Persist a newly-trusted host fingerprint. This is the anti-MITM anchor;
   * it is written synchronously (immediate) so a crash between trust and the
   * next connection cannot lose it.
   */
  function trustHostKey(targetId, fingerprint) {
    const target = targets.get(String(targetId || ""));
    if (!target) return null;
    const fp = sanitizeFingerprint(fingerprint);
    if (!fp) return null;
    const next = createRemoteTarget(
      { ...target, trustedHostFingerprint: fp, updatedAt: new Date(now()).toISOString() },
      { id: target.id, now: target.createdAt },
    );
    targets.set(target.id, next);
    changed({ immediate: true });
    return publicView(next);
  }

  function forgetTrust(targetId) {
    const target = targets.get(String(targetId || ""));
    if (!target) return null;
    const next = createRemoteTarget(
      { ...target, trustedHostFingerprint: "", updatedAt: new Date(now()).toISOString() },
      { id: target.id, now: target.createdAt },
    );
    targets.set(target.id, next);
    changed({ immediate: true });
    return publicView(next);
  }

  async function shutdown() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistNow();
  }

  return {
    file,
    load,
    list,
    get,
    getRaw,
    findByAddress,
    create,
    resolveAdHoc,
    save,
    update,
    remove,
    trustHostKey,
    forgetTrust,
    persistNow,
    persistNowSync,
    shutdown,
  };
}

module.exports = {
  createRemoteTargetStore,
  STORE_FILE,
  STORE_VERSION,
  MAX_TARGETS,
};
