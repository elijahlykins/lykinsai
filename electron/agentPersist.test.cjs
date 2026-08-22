"use strict";

/**
 * Persist/load round-trip for agent status.
 *
 * A run that parks on the user sets status "waiting" + a "Waiting for your
 * go-ahead…" step (agentRuntime.cjs:1395). That state is meaningful only while
 * the run is live: load() never restores `pendingChoice`, so a restored
 * "waiting" agent can never be answered. It must therefore never survive a
 * restart — otherwise the sidebar shows a permanent pulsing "Waiting for your
 * go-ahead…" row on a cold start, for a run that no longer exists.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAgentRuntime } = require("./agentRuntime.cjs");

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-agent-persist-"));
}

function newRuntime(userDataPath) {
  return createAgentRuntime({
    userDataPath,
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

/** Seed overlay-agents.json exactly as a run parked on the user would leave it. */
function seedParkedAgent(userDataPath, overrides = {}) {
  const row = {
    id: "agent-parked-1",
    title: "Go to the BYU calendar website and tell…",
    role: "worker",
    pinned: false,
    status: "waiting",
    skill: "browse",
    url: "",
    step: "Waiting for your go-ahead…",
    history: [{ role: "user", content: "go to the calendar", at: "2026-08-19T21:00:00.000Z" }],
    createdAt: "2026-08-19T21:00:00.000Z",
    updatedAt: "2026-08-19T21:10:53.268Z",
    ...overrides,
  };
  fs.writeFileSync(
    path.join(userDataPath, "overlay-agents.json"),
    JSON.stringify({ activeAgentId: row.id, agents: [row] }, null, 2),
    "utf8",
  );
  return row;
}

test('load() does not restore an agent as waiting on the user', async () => {
  const dir = tempUserData();
  seedParkedAgent(dir);

  const runtime = newRuntime(dir);
  await runtime.load();

  const [agent] = runtime.listPublic();
  assert.ok(agent, "expected the persisted agent to be restored");
  assert.equal(
    agent.waiting,
    false,
    "a restored agent must not claim to be waiting on the user — pendingChoice is never restored, so the prompt can never be answered",
  );
  assert.notEqual(agent.status, "waiting");
});

test('load() drops a stale "waiting for your go-ahead" step', async () => {
  const dir = tempUserData();
  seedParkedAgent(dir);

  const runtime = newRuntime(dir);
  await runtime.load();

  const [agent] = runtime.listPublic();
  assert.doesNotMatch(
    String(agent.step || ""),
    /go-ahead|waiting for your approval/i,
    "the stale waiting label must not survive a restart",
  );
});

test('a restored agent is not reported as busy', async () => {
  const dir = tempUserData();
  seedParkedAgent(dir);

  const runtime = newRuntime(dir);
  await runtime.load();

  const [agent] = runtime.listPublic();
  assert.equal(agent.busy, false, "nothing is running after a cold start");
});

test('persist() never writes a waiting status back to disk', async () => {
  const dir = tempUserData();
  seedParkedAgent(dir);

  const runtime = newRuntime(dir);
  await runtime.load();
  await runtime.persist();

  const written = JSON.parse(
    fs.readFileSync(path.join(dir, "overlay-agents.json"), "utf8"),
  );
  assert.equal(written.agents.length, 1);
  assert.notEqual(
    written.agents[0].status,
    "waiting",
    "waiting is a live-run state and must be normalized on write, like running",
  );
  assert.doesNotMatch(String(written.agents[0].step || ""), /go-ahead/i);
});

test('load() preserves genuinely terminal state', async () => {
  const dir = tempUserData();
  seedParkedAgent(dir, { status: "idle", step: "Done" });

  const runtime = newRuntime(dir);
  await runtime.load();

  const [agent] = runtime.listPublic();
  assert.equal(agent.status, "idle");
  assert.equal(agent.step, "Done", "normalization must not clobber a finished run's step");
});

/**
 * A live run parked on the user sets status "waiting" AND busy true together
 * (agentRuntime.cjs:1395). The renderer derives both the send-button disabled
 * state and its send() guard from `busy`, so publishing busy during a park
 * locks the composer — and the runtime's own send() would have accepted a typed
 * "yes"/"no" (agentRuntime.cjs:9186). `busy` must mean "inferencing", never
 * "parked on you", or the user cannot answer the question they are being asked.
 */
test('a parked agent is not published as busy, so the composer stays usable', () => {
  const runtime = newRuntime(tempUserData());

  const parked = runtime.publicAgent({
    id: "a1",
    title: "t",
    status: "waiting",
    busy: true,
    step: "Waiting for your go-ahead…",
    waitingReason: "choice",
  });

  assert.equal(parked.waiting, true, "it really is parked on the user");
  assert.equal(
    parked.busy,
    false,
    "parked is not busy — publishing busy here is what greys the send button and kills the Enter key",
  );
});

test('an actually-running agent is still published as busy', () => {
  const runtime = newRuntime(tempUserData());

  const running = runtime.publicAgent({
    id: "a2",
    title: "t",
    status: "running",
    busy: true,
    step: "Reading the page",
  });

  assert.equal(running.busy, true, "a live turn must still lock the composer");
  assert.equal(running.waiting, false);
});
