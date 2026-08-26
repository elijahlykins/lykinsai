"use strict";

/**
 * Security regression tests — Agent hardening Wave 1.
 *
 * Each block ATTEMPTS the bypass the audit described and asserts it now fails
 * closed, while the legitimate path still works. Covered here:
 *
 *   Fix 1 — approval attestation in resolveChoice (agentRuntime.cjs)
 *   Fix 2 — main-issued local-tool approval tokens (localToolApproval.cjs +
 *           the lykn:local-tool-run decision it drives)
 *   Fix 3 — exact agent-home document identity (agentHomeIdentity.cjs)
 *   Fix 5 — trace-log secret sanitization (browser-agent/runtime/debugLog.cjs)
 *
 * Fix 4 (sensitive-field snapshot redaction) lives in
 * electron/browser-agent/snapshotRedaction.test.cjs so it is picked up by the
 * browser-agent test glob.
 *
 * Run: node --test electron/agentSecurityHardening.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createAgentRuntime } = require("./agentRuntime.cjs");
const {
  createLocalApprovalRegistry,
  normalizeArgsForApproval,
} = require("./localToolApproval.cjs");
const { createAgentHomeIdentity } = require("./agentHomeIdentity.cjs");
const { redactValue } = require("./browser-agent/runtime/debugLog.cjs");
const localSystem = require("./localSystem.cjs");

// ── Fix 1: approval attestation ─────────────────────────────────────────────

function runtimeForChoiceTests() {
  return createAgentRuntime({
    userDataPath: require("node:os").tmpdir(),
    apiBase: "http://localhost:0",
    getAuthToken: async () => "",
    readStreamResponse: async () => "",
    emit: () => {},
    ensureBrowserWindow: () => {},
    destroyBrowserWindow: () => {},
    showBrowserWindow: () => {},
    hideBrowserWindow: () => {},
    hideAllBrowserWindows: () => {},
    browserWindowExists: () => false,
    getBrowserWebContents: () => null,
    planOwnedBrowserNext: async () => ({}),
    isContentProtectionEnabled: () => false,
    openStageArtifact: () => {},
    destroyOwnedArtifactTabs: () => {},
    focusOverlayComposer: () => {},
    notifyAgentFinished: () => {},
  });
}

/** Seed a resolvable browse-approval on a fresh agent; return {rt, id, choiceId, seen}. */
function seedBrowseApproval(rt, choiceId) {
  const created = rt.createAgent({ title: "t", goal: "g" });
  const id = created.agentId;
  const agent = rt.__getAgentForTest(id);
  const seen = { approved: null };
  agent.pendingChoice = {
    id: choiceId,
    type: "browse-approval",
    resolve: (v) => {
      seen.approved = v;
    },
    buttons: [{ id: "approve" }, { id: "decline" }],
    at: new Date().toISOString(),
  };
  return { id, agent, seen };
}

test("Fix1: the exact current choiceId approves the pending action", async () => {
  const rt = runtimeForChoiceTests();
  const { id, seen } = seedBrowseApproval(rt, "choice-abc");
  const res = await rt.resolveChoice(id, { choiceId: "choice-abc", buttonId: "approve" });
  assert.equal(res.ok, true);
  assert.equal(res.approved, true);
  assert.equal(seen.approved, true, "the real pending promise was released");
});

test("Fix1: a missing choiceId fails closed (no approval)", async () => {
  const rt = runtimeForChoiceTests();
  const { id, seen } = seedBrowseApproval(rt, "choice-abc");
  const res = await rt.resolveChoice(id, { buttonId: "approve" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "missing_choice_id");
  assert.equal(seen.approved, null, "the pending action was never released");
});

test("Fix1: a wrong/guessed choiceId fails closed", async () => {
  const rt = runtimeForChoiceTests();
  const { id, seen } = seedBrowseApproval(rt, "choice-abc");
  const res = await rt.resolveChoice(id, { choiceId: "choice-WRONG", buttonId: "approve" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "stale_choice");
  assert.equal(seen.approved, null);
});

test("Fix1: an empty-string choiceId does not bypass the check", async () => {
  const rt = runtimeForChoiceTests();
  const { id, seen } = seedBrowseApproval(rt, "choice-abc");
  const res = await rt.resolveChoice(id, { choiceId: "   ", buttonId: "approve" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "missing_choice_id");
  assert.equal(seen.approved, null);
});

test("Fix1: a resolved approval cannot be replayed", async () => {
  const rt = runtimeForChoiceTests();
  const { id } = seedBrowseApproval(rt, "choice-abc");
  const first = await rt.resolveChoice(id, { choiceId: "choice-abc", buttonId: "approve" });
  assert.equal(first.ok, true);
  const replay = await rt.resolveChoice(id, { choiceId: "choice-abc", buttonId: "approve" });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "no_pending_choice", "the consumed choice is gone");
});

test("Fix1: agent A's choiceId cannot approve agent B's pending action", async () => {
  const rt = runtimeForChoiceTests();
  const a = seedBrowseApproval(rt, "A-choice");
  const b = seedBrowseApproval(rt, "B-choice");
  // Attacker knows agent B's id and replays agent A's (leaked) choiceId.
  const res = await rt.resolveChoice(b.id, { choiceId: "A-choice", buttonId: "approve" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "stale_choice");
  assert.equal(b.seen.approved, null, "B's action stays parked");
  assert.equal(a.seen.approved, null, "and A's is untouched");
});

// ── Fix 2: main-issued local-tool approval tokens ───────────────────────────
//
// Simulate the lykn:local-tool-run handler's approval decision exactly: the
// renderer no longer supplies a boolean; approval is only ever a token main
// consumes against this exact tool + args. Combined with localSystem.run this
// proves a forged approval cannot execute a risky action.

function makeHandler(registry, userDataPath) {
  // Mirrors electron/main.cjs lykn:local-tool-run (minus the Local Mode gate,
  // which is asserted separately by localSystem.test.cjs).
  return async ({ name, args, approvalToken }) => {
    const toolName = String(name || "");
    const toolArgs = args || {};
    const approved = registry.consume(approvalToken, toolName, toolArgs);
    const result = await localSystem.run(toolName, toolArgs, { approved, userDataPath });
    if (result && result.needsApproval === true) {
      result.approvalToken = registry.issue(toolName, toolArgs);
    }
    return result;
  };
}

// A synced-folders-any config so path allowlisting never masks the approval
// behaviour under test. localSystem defaults to syncAll when the file is absent.
const ANY_USERDATA = require("node:fs").mkdtempSync(
  path.join(require("node:os").tmpdir(), "lykn-sec-local-"),
);

// A genuinely CONSEQUENTIAL command (rm is in the consequential tier — the
// routine tier no longer stops for approval by design) so the approval gate
// must fire — but inert if it ever wrongly executed (the path never exists).
// We never expect it to run in the bypass cases.
const RISKY_INERT = "rm -rf /tmp/lykn-sec-test-never-exists";

test("Fix2: raw approved:true from a renderer cannot bypass the gate", async () => {
  const registry = createLocalApprovalRegistry();
  const handler = makeHandler(registry, ANY_USERDATA);
  // The old bypass shape — an approved boolean — is simply ignored now.
  const res = await handler({
    name: "local_run_command",
    args: { command: RISKY_INERT },
    approved: true,
  });
  assert.equal(res.needsApproval, true, "a risky command still stops for approval");
  assert.notEqual(res.ok, true);
});

test("Fix2: a fabricated/guessed token cannot approve", async () => {
  const registry = createLocalApprovalRegistry();
  const handler = makeHandler(registry, ANY_USERDATA);
  const res = await handler({
    name: "local_run_command",
    args: { command: RISKY_INERT },
    approvalToken: "deadbeef".repeat(8),
  });
  assert.equal(res.needsApproval, true);
});

test("Fix2: the legitimate mint→confirm→re-run flow works", async () => {
  const registry = createLocalApprovalRegistry();
  const handler = makeHandler(registry, ANY_USERDATA);
  const cwd = ANY_USERDATA;
  // 1) First call: no token → risky → main mints a token.
  const first = await handler({ name: "local_run_command", args: { command: "echo hi", cwd } });
  assert.equal(first.needsApproval, true);
  assert.equal(typeof first.approvalToken, "string");
  assert.ok(first.approvalToken.length >= 32);
  // 2) User approves → re-invoke with the SAME token + args → runs.
  const run = await handler({
    name: "local_run_command",
    args: { command: "echo hi", cwd },
    approvalToken: first.approvalToken,
  });
  assert.equal(run.ok, true, `expected the command to run, got ${JSON.stringify(run)}`);
});

test("Fix2: a token minted for one command cannot approve a different command", async () => {
  const registry = createLocalApprovalRegistry();
  const handler = makeHandler(registry, ANY_USERDATA);
  const minted = await handler({
    name: "local_run_command",
    args: { command: "rm -rf /tmp/lykn-sec-a-never-exists" },
  });
  assert.equal(typeof minted.approvalToken, "string");
  // Swap the command but keep the token — the token is bound to the original.
  const res = await handler({
    name: "local_run_command",
    args: { command: "rm -rf /tmp/lykn-sec-b-never-exists" },
    approvalToken: minted.approvalToken,
  });
  assert.equal(res.needsApproval, true, "the token does not authorize a different command");
});

test("Fix2: a token minted for one file op cannot approve a different file op", () => {
  const registry = createLocalApprovalRegistry();
  const token = registry.issue("local_write_file", { path: "/a.txt", content: "x" });
  assert.equal(registry.consume(token, "local_write_file", { path: "/b.txt", content: "x" }), false);
  // And a different tool name is rejected too.
  const t2 = registry.issue("local_write_file", { path: "/a.txt", content: "x" });
  assert.equal(registry.consume(t2, "local_edit_file", { path: "/a.txt" }), false);
});

test("Fix2: a token is single-use — it cannot be replayed", () => {
  const registry = createLocalApprovalRegistry();
  const args = { command: "echo hi" };
  const token = registry.issue("local_run_command", args);
  assert.equal(registry.consume(token, "local_run_command", args), true);
  assert.equal(registry.consume(token, "local_run_command", args), false, "replay rejected");
});

test("Fix2: a token expires and is invalid after its TTL", () => {
  let clock = 1_000;
  const registry = createLocalApprovalRegistry({ ttlMs: 100, now: () => clock });
  const args = { command: "echo hi" };
  const token = registry.issue("local_run_command", args);
  clock += 101; // past TTL
  assert.equal(registry.consume(token, "local_run_command", args), false, "expired token rejected");
});

test("Fix2: the approval key ignores non-security args but binds security ones", () => {
  const a = normalizeArgsForApproval("local_run_command", { command: "ls", cwd: "/x", noise: 1 });
  const b = normalizeArgsForApproval("local_run_command", { command: "ls", cwd: "/x", other: 2 });
  assert.equal(a, b, "incidental fields do not change the binding");
  const c = normalizeArgsForApproval("local_run_command", { command: "ls", cwd: "/y" });
  assert.notEqual(a, c, "cwd is security-relevant and changes the binding");
});

// ── Fix 3: exact agent-home document identity ───────────────────────────────

const ELECTRON_DIR = __dirname;
const homeIdentity = createAgentHomeIdentity(ELECTRON_DIR);

test("Fix3: the exact packaged home/welcome file URLs are trusted", () => {
  const home = pathToFileURL(path.join(ELECTRON_DIR, "agent-browser-home.html")).href;
  const welcome = pathToFileURL(path.join(ELECTRON_DIR, "agent-browser-welcome.html")).href;
  assert.equal(homeIdentity.isTrustedAgentBrowserHomeUrl(home), true);
  assert.equal(homeIdentity.isTrustedAgentBrowserHomeUrl(welcome), true);
  // Query/hash on the real document still passes (protocol + pathname match).
  assert.equal(homeIdentity.isTrustedAgentBrowserHomeUrl(`${welcome}?agentId=x`), true);
  assert.equal(homeIdentity.isTrustedAgentBrowserHomeUrl("lykn://new-tab"), true);
});

test("Fix3: attacker HTTPS URLs with trusted-looking filenames are rejected", () => {
  for (const url of [
    "https://example.com/agent-browser-home.html",
    "https://example.com/foo/agent-browser-welcome.html",
    "https://evil.example/agent-browser-home.html?x=1",
    "http://localhost/agent-browser-welcome.html",
    "https://agent-browser-home.html.evil.example/",
    "data:text/html,<script>agent-browser-home.html</script>",
    "file:///tmp/agent-browser-welcome.html",
    "file:///tmp/agent-browser-home.html",
  ]) {
    assert.equal(
      homeIdentity.isTrustedAgentBrowserHomeUrl(url),
      false,
      `must reject ${url}`,
    );
  }
});

test("Fix3: junk and empty inputs are rejected", () => {
  for (const url of ["", null, undefined, "not a url", "lykn://not-new-tab"]) {
    assert.equal(homeIdentity.isTrustedAgentBrowserHomeUrl(url), false);
  }
});

// ── Fix 5: trace-log secret sanitization ────────────────────────────────────

function serialize(obj) {
  return JSON.stringify(redactValue(obj, 0, new WeakSet()));
}

test("Fix5: values under sensitive keys are redacted", () => {
  const out = serialize({
    password: "hunter2",
    authToken: "abc.def.ghi",
    Authorization: "Bearer sometoken",
    cookie: "sid=deadbeef",
    apiKey: "sk-secretvalue",
    nested: { session_secret: "zzz", note: "keep me" },
  });
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("sometoken"));
  assert.ok(!out.includes("deadbeef"));
  assert.ok(!out.includes("secretvalue"));
  assert.ok(!out.includes("zzz"));
  assert.ok(out.includes("keep me"), "non-secret sibling metadata is preserved");
  assert.ok(out.includes("password"), "the key itself stays so the trace is still legible");
});

test("Fix5: numeric metrics under token-like keys survive (usage counts, not secrets)", () => {
  const red = redactValue({ tokens: 1234, maxTokens: 8000, authToken: "secretstr" }, 0, new WeakSet());
  assert.equal(red.tokens, 1234);
  assert.equal(red.maxTokens, 8000);
  assert.equal(red.authToken, "[redacted]");
});

test("Fix5: secret SHAPES are scrubbed even under innocuous keys", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.s5H7xY2Zq1lA9bQwvKpQhY3n0mJ8u2Xr";
  const out = serialize({
    note: `authorization: Bearer ${jwt}`,
    url: "https://x.test/cb#token=abcdef0123456789abcdef",
    detail: "card 4111 1111 1111 1111 on file",
    ssn: "not-a-key-but-value 123-45-6789",
    plain: "totally fine text",
  });
  assert.ok(!out.includes(jwt), "JWT scrubbed");
  assert.ok(!out.includes("4111 1111 1111 1111"), "card number scrubbed");
  assert.ok(!out.includes("123-45-6789"), "SSN scrubbed");
  assert.ok(out.includes("totally fine text"), "ordinary text preserved");
});

test("Fix5: long strings are still truncated and structure preserved", () => {
  const long = "a".repeat(5000);
  const red = redactValue({ blob: long, list: [1, 2, 3] }, 0, new WeakSet());
  assert.ok(red.blob.length < 5000);
  assert.ok(red.blob.endsWith("…"));
  assert.deepEqual(red.list, [1, 2, 3]);
});

test("Fix5: circular structures do not crash the sanitizer", () => {
  const a = { name: "x" };
  a.self = a;
  const red = redactValue(a, 0, new WeakSet());
  assert.equal(red.name, "x");
  assert.equal(red.self, "[circular]");
});
