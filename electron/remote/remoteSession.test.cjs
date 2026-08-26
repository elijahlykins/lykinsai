"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRemoteSession, boundOutput } = require("./remoteSession.cjs");
const { connectRemoteSession } = require("./remoteConnect.cjs");
const { createRemoteTarget } = require("./remoteTarget.cjs");
const { HOST_KEY_CHANGED, HOST_UNTRUSTED } = require("./sshTransport.cjs");

const FINGERPRINT = "SHA256:testFingerprint";
const KEY_LINE = "dev.example.com ssh-ed25519 AAAATEST";

function target(overrides = {}) {
  return createRemoteTarget({
    name: "Dev Server",
    host: "dev.example.com",
    username: "deploy",
    environment: "development",
    workingDirectory: "/srv/app",
    ...overrides,
  });
}

/** A fake transport: scripted trust + recorded exec calls. */
function fakeTransport({ trusted = true, changed = false, execResult } = {}) {
  const calls = [];
  return {
    calls,
    async verifyHostTrust({ trustedFingerprint }) {
      if (changed) {
        return { ok: false, state: HOST_KEY_CHANGED, fingerprint: "SHA256:new", trustedFingerprint };
      }
      if (!trustedFingerprint) {
        return { ok: false, state: HOST_UNTRUSTED, fingerprint: FINGERPRINT, keyLine: KEY_LINE };
      }
      if (trustedFingerprint !== FINGERPRINT) {
        return { ok: false, state: HOST_KEY_CHANGED, fingerprint: FINGERPRINT, trustedFingerprint };
      }
      return trusted
        ? { ok: true, fingerprint: FINGERPRINT, keyLine: KEY_LINE }
        : { ok: false, error: "scan_failed" };
    },
    persistKnownHostLine(line) {
      calls.push({ persist: line });
      return { ok: true };
    },
    async exec(command, opts = {}) {
      calls.push({ command, cwd: opts.cwd });
      if (typeof execResult === "function") return execResult(command, opts);
      return { ok: true, code: 0, stdout: `ran: ${command}`, stderr: "" };
    },
  };
}

// ── Output bounding ──────────────────────────────────────────────────────────

test("boundOutput keeps head and tail and marks the cut", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const out = boundOutput(lines, { maxLines: 100 });
  assert.equal(out.truncated, true);
  assert.match(out.text, /line 0\n/);
  assert.match(out.text, /line 999$/);
  assert.match(out.text, /lines omitted/);
  assert.equal(out.totalLines, 1000);
});

test("boundOutput caps bytes as well as lines", () => {
  const big = "a".repeat(100 * 1024);
  const out = boundOutput(big, { maxBytes: 8 * 1024 });
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.text) < 10 * 1024);
});

// ── Session ──────────────────────────────────────────────────────────────────

test("session connects, execs in the target working directory, and records history", async () => {
  const transport = fakeTransport();
  const session = createRemoteSession({
    target: target(),
    transport,
    taskId: "task_1",
    runId: "run_1",
    trustedFingerprint: FINGERPRINT,
  });
  const trust = await session.connect();
  assert.equal(trust.ok, true);
  assert.equal(session.state.connected, true);

  const out = await session.exec("systemctl status api");
  assert.equal(out.ok, true);
  assert.match(out.output, /ran: systemctl status api/);
  // The target's workingDirectory becomes the default cwd.
  assert.equal(transport.calls.at(-1).cwd, "/srv/app");

  const summary = session.summary();
  assert.equal(summary.taskId, "task_1");
  assert.equal(summary.remoteTargetId, session.state.remoteTargetId);
  assert.equal(summary.commandCount, 1);
  assert.equal(summary.recentCommands[0].command, "systemctl status api");
});

test("session output is bounded before it reaches the caller", async () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `log ${i}`).join("\n");
  const transport = fakeTransport({ execResult: () => ({ ok: true, code: 0, stdout: huge, stderr: "" }) });
  const session = createRemoteSession({ target: target(), transport, taskId: "t", runId: "r" });
  const out = await session.exec("cat huge.log");
  assert.equal(out.truncated, true);
  assert.ok(out.output.length < huge.length);
  assert.match(out.output, /lines omitted/);
});

test("remote write travels as base64 so content cannot break quoting", async () => {
  const transport = fakeTransport();
  const session = createRemoteSession({ target: target(), transport, taskId: "t", runId: "r" });
  const content = `evil'; rm -rf / #\nsecond line`;
  await session.writeFile("/srv/app/config.js", content);
  const command = transport.calls.at(-1).command;
  assert.match(command, /^printf %s '/);
  assert.match(command, /\| base64 -d > '\/srv\/app\/config\.js'$/);
  assert.equal(command.includes("rm -rf"), false);
  const b64 = command.match(/printf %s '([^']+)'/)[1];
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), content);
});

test("read/list/search quote hostile paths safely", async () => {
  const transport = fakeTransport();
  const session = createRemoteSession({ target: target(), transport, taskId: "t", runId: "r" });
  await session.listDir("/tmp/$(rm -rf /)");
  assert.equal(transport.calls.at(-1).command, "ls -la '/tmp/$(rm -rf /)'");
  await session.search("/srv", "needle'; reboot;'");
  assert.match(transport.calls.at(-1).command, /^grep -rnF -- 'needle'\\''; reboot;'\\'''/);
});

test("an aborted signal short-circuits exec without touching the transport", async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = fakeTransport();
  const session = createRemoteSession({
    target: target(),
    transport,
    taskId: "t",
    runId: "r",
    signal: controller.signal,
  });
  const out = await session.exec("ls");
  assert.equal(out.aborted, true);
  assert.equal(transport.calls.length, 0);
});

// ── connectRemoteSession: trust orchestration ────────────────────────────────

test("an untrusted first-use host pauses until trust is explicitly established", async () => {
  const transport = fakeTransport();
  const out = await connectRemoteSession({
    target: target(),
    taskId: "t",
    runId: "r",
    trustedFingerprint: "",
    createTransport: () => transport,
    onTrustEstablish: null, // no approval channel: must pause, never proceed
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, "waiting_for_approval");
  assert.equal(out.waitingKind, "host_untrusted");
  assert.equal(out.fingerprint, FINGERPRINT);
  assert.match(out.answer, /fingerprint SHA256:/);
});

test("approving first-use trust persists the fingerprint and connects", async () => {
  const transport = fakeTransport();
  const persisted = [];
  const out = await connectRemoteSession({
    target: target(),
    taskId: "t",
    runId: "r",
    trustedFingerprint: "",
    createTransport: () => transport,
    onTrustEstablish: async ({ fingerprint }) => fingerprint === FINGERPRINT,
    onTrusted: (info) => persisted.push(info),
  });
  assert.equal(out.ok, true);
  assert.ok(out.session);
  assert.equal(out.session.state.connected, true);
  assert.deepEqual(persisted, [{ fingerprint: FINGERPRINT, keyLine: KEY_LINE }]);
  // The known_hosts anchor was written.
  assert.ok(transport.calls.some((c) => c.persist === KEY_LINE));
});

test("a changed host key pauses as HOST_KEY_CHANGED and is NEVER auto-accepted", async () => {
  const transport = fakeTransport({ changed: true });
  let trustPromptCalled = false;
  const out = await connectRemoteSession({
    target: target({ name: "Production API" }),
    taskId: "t",
    runId: "r",
    trustedFingerprint: FINGERPRINT,
    createTransport: () => transport,
    onTrustEstablish: async () => {
      trustPromptCalled = true;
      return true; // even an approving handler must not be consulted
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, "waiting_for_user");
  assert.equal(out.waitingKind, "host_key_changed");
  assert.equal(out.reason, HOST_KEY_CHANGED);
  assert.equal(trustPromptCalled, false);
  assert.match(out.answer, /CHANGED/);
  assert.match(out.answer, /intercepted/);
});

test("cancellation during trust returns cancelled", async () => {
  const controller = new AbortController();
  const transport = {
    async verifyHostTrust() {
      controller.abort();
      return { ok: false, state: HOST_UNTRUSTED, fingerprint: FINGERPRINT, keyLine: KEY_LINE };
    },
  };
  const out = await connectRemoteSession({
    target: target(),
    taskId: "t",
    runId: "r",
    signal: controller.signal,
    createTransport: () => transport,
  });
  assert.equal(out.status, "cancelled");
});
