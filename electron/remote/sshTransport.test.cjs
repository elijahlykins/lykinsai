"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createSshTransport,
  authRefToArgs,
  runProcess,
  HOST_KEY_CHANGED,
  HOST_UNTRUSTED,
} = require("./sshTransport.cjs");
const { createRemoteTarget } = require("./remoteTarget.cjs");

// A fake child process: emits scripted stdout/stderr then closes, or hangs
// until killed. Captures stdin for assertions.
function fakeChild({ stdout = "", stderr = "", code = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinData = "";
  child.stdin = {
    end: (data) => {
      child.stdinData = String(data ?? "");
    },
  };
  child.kill = () => {
    child.emit("close", null);
  };
  if (!hang) {
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
  }
  return child;
}

/** Script spawn per binary; records every call for arg assertions. */
function fakeSpawn(script) {
  const calls = [];
  const impl = (bin, args) => {
    calls.push({ bin, args });
    const make = script[bin] || (() => fakeChild({ code: 127, stderr: "not scripted" }));
    return make({ bin, args, calls });
  };
  impl.calls = calls;
  return impl;
}

const KEY_LINE = "dev.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY";
const FINGERPRINT = "SHA256:tOkEnFingerPrintBase64Value";

function scanScript({ fingerprint = FINGERPRINT, keyLine = KEY_LINE } = {}) {
  return {
    "ssh-keyscan": () => fakeChild({ stdout: `# comment\n${keyLine}\n` }),
    "ssh-keygen": () => fakeChild({ stdout: `256 ${fingerprint} dev.example.com (ED25519)\n` }),
  };
}

function target(overrides = {}) {
  return createRemoteTarget({
    name: "Dev Server",
    host: "dev.example.com",
    username: "deploy",
    environment: "development",
    ...overrides,
  });
}

// ── authRef → argv (never secrets) ──────────────────────────────────────────

test("authRef maps to identity args only; agent/default add nothing", () => {
  assert.deepEqual(authRefToArgs({ kind: "agent" }), []);
  assert.deepEqual(authRefToArgs({ kind: "default" }), []);
  assert.deepEqual(authRefToArgs({ kind: "keyFile", path: "~/.ssh/id_ed25519" }), [
    "-i",
    "~/.ssh/id_ed25519",
    "-o",
    "IdentitiesOnly=yes",
  ]);
  // A newline-carrying "path" (key body) is refused.
  assert.deepEqual(authRefToArgs({ kind: "keyFile", path: "line1\nline2" }), []);
});

// ── Host trust ───────────────────────────────────────────────────────────────

test("first use surfaces HOST_UNTRUSTED with the scanned fingerprint", async () => {
  const spawn = fakeSpawn(scanScript());
  const transport = createSshTransport({ target: target(), spawn });
  const trust = await transport.verifyHostTrust({ trustedFingerprint: "" });
  assert.equal(trust.ok, false);
  assert.equal(trust.state, HOST_UNTRUSTED);
  assert.equal(trust.fingerprint, FINGERPRINT);
  assert.equal(trust.keyLine, KEY_LINE);
});

test("a matching trusted fingerprint connects", async () => {
  const spawn = fakeSpawn(scanScript());
  const transport = createSshTransport({ target: target(), spawn });
  const trust = await transport.verifyHostTrust({ trustedFingerprint: FINGERPRINT });
  assert.equal(trust.ok, true);
});

test("a CHANGED host key is refused as HOST_KEY_CHANGED, never accepted", async () => {
  const spawn = fakeSpawn(scanScript({ fingerprint: "SHA256:DIFFERENTKEY" }));
  const transport = createSshTransport({ target: target(), spawn });
  const trust = await transport.verifyHostTrust({ trustedFingerprint: FINGERPRINT });
  assert.equal(trust.ok, false);
  assert.equal(trust.state, HOST_KEY_CHANGED);
  assert.equal(trust.fingerprint, "SHA256:DIFFERENTKEY");
  assert.equal(trust.trustedFingerprint, FINGERPRINT);
});

test("persistKnownHostLine appends once, mode 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-kh-"));
  const knownHostsFile = path.join(dir, "remote-known-hosts");
  const transport = createSshTransport({ target: target(), spawn: fakeSpawn({}), knownHostsFile });
  assert.equal(transport.persistKnownHostLine(KEY_LINE).ok, true);
  assert.equal(transport.persistKnownHostLine(KEY_LINE).ok, true);
  const lines = fs.readFileSync(knownHostsFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

// ── exec ─────────────────────────────────────────────────────────────────────

test("exec builds strict, batch-mode ssh argv with our known_hosts anchor", async () => {
  const spawn = fakeSpawn({ ssh: () => fakeChild({ stdout: "hello\n" }) });
  const transport = createSshTransport({
    target: target(),
    spawn,
    knownHostsFile: "/tmp/lykn-known-hosts",
  });
  const out = await transport.exec("echo hello");
  assert.equal(out.ok, true);
  assert.equal(out.stdout, "hello\n");
  const { bin, args } = spawn.calls[0];
  assert.equal(bin, "ssh");
  const joined = args.join(" ");
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /StrictHostKeyChecking=yes/);
  assert.match(joined, /NumberOfPasswordPrompts=0/);
  assert.match(joined, /UserKnownHostsFile=\/tmp\/lykn-known-hosts/);
  assert.match(joined, /-F \/dev\/null/);
  assert.match(joined, /HostName=dev.example.com/);
  assert.equal(joined.includes(".ssh/config"), false);
  // Destination then `--` then the remote command as ONE argv element.
  assert.equal(args[args.length - 3], "deploy@dev.example.com");
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "echo hello");
});

test("cwd is safely single-quoted into the remote command", async () => {
  const spawn = fakeSpawn({ ssh: () => fakeChild({ stdout: "" }) });
  const transport = createSshTransport({ target: target(), spawn });
  await transport.exec("ls", { cwd: "/srv/app's dir" });
  const remote = spawn.calls[0].args.at(-1);
  assert.equal(remote, "cd '/srv/app'\\''s dir' && ls");
});

test("an auth failure is surfaced as authRequired, not a generic error", async () => {
  const spawn = fakeSpawn({
    ssh: () => fakeChild({ code: 255, stderr: "deploy@dev.example.com: Permission denied (publickey)." }),
  });
  const transport = createSshTransport({ target: target(), spawn });
  const out = await transport.exec("ls");
  assert.equal(out.ok, false);
  assert.equal(out.authRequired, true);
});

test("cancellation kills the ssh process", async () => {
  const controller = new AbortController();
  const spawn = fakeSpawn({ ssh: () => fakeChild({ hang: true }) });
  const transport = createSshTransport({ target: target(), spawn });
  const pending = transport.exec("sleep 999", { signal: controller.signal });
  setImmediate(() => controller.abort());
  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.aborted, true);
});

test("output beyond the byte cap is truncated, with byte accounting", async () => {
  const big = "x".repeat(600 * 1024);
  const spawn = fakeSpawn({ ssh: () => fakeChild({ stdout: big }) });
  const transport = createSshTransport({ target: target(), spawn });
  const out = await transport.exec("cat big-file");
  assert.equal(out.truncated, true);
  assert.ok(out.stdout.length <= 256 * 1024);
  assert.equal(out.bytesOut, big.length);
});

test("LYKN does not write the user's SSH config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-ssh-home-"));
  const userConfig = path.join(dir, "config");
  const spawn = fakeSpawn({ ssh: () => fakeChild({ stdout: "ok\n" }) });
  const transport = createSshTransport({
    target: target(),
    spawn,
    knownHostsFile: path.join(dir, "lykn-known-hosts"),
  });
  await transport.exec("true");
  assert.equal(fs.existsSync(userConfig), false);
  const sshArgs = spawn.calls.find((call) => call.bin === "ssh").args.join(" ");
  assert.match(sshArgs, /-F \/dev\/null/);
});

test("runProcess reports spawn failure without throwing", async () => {
  const out = await runProcess(() => {
    throw new Error("ENOENT");
  }, "ssh", []);
  assert.equal(out.ok, false);
  assert.equal(out.error, "spawn_failed");
});
