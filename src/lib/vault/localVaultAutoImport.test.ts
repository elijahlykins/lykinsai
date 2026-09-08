import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  autoImportCloudVaultIfNeeded,
  resetAutoImportSessionGuard,
  type AutoImportBridge,
} from "./localVaultAutoImport";

const noSleep = () => Promise.resolve();
const noReset = () => {};

const session = async () => ({
  accessToken: "token-1",
  url: "https://cloud.example",
  apiKey: "anon-key",
});

/**
 * A scripted bridge: `stats`/`preflight` describe the account's state,
 * `statusScript` is consumed one entry per `importStatus` call (last entry
 * repeats). Records which operations ran.
 */
function fakeBridge({
  localItems = 0,
  cloudItems = 0,
  cloudChats = 0,
  statusScript = [{ running: false }],
}: {
  localItems?: number;
  cloudItems?: number;
  cloudChats?: number;
  statusScript?: Array<{ running?: boolean; cancelled?: boolean }>;
} = {}) {
  const calls: string[] = [];
  let statusIndex = 0;
  const api: AutoImportBridge = {
    stats: async () => {
      calls.push("stats");
      return { ok: true, data: { items: localItems } };
    },
    importStatus: async () => {
      calls.push("status");
      const s = statusScript[Math.min(statusIndex, statusScript.length - 1)];
      statusIndex += 1;
      return { ok: true, data: s };
    },
    importConfigure: async () => {
      calls.push("configure");
      return { ok: true, data: {} };
    },
    importPreflight: async () => {
      calls.push("preflight");
      return { ok: true, data: { ok: true, cloud: { items: cloudItems, chats: cloudChats } } };
    },
    importStart: async () => {
      calls.push("start");
      return { ok: true, data: {} };
    },
  };
  return { api, calls };
}

beforeEach(() => resetAutoImportSessionGuard());

test("cloud items + empty store: runs the import and reports both events", async () => {
  const { api, calls } = fakeBridge({
    cloudItems: 42,
    // status is checked once before starting, then polled: running, done.
    statusScript: [{ running: false }, { running: true }, { running: false }],
  });
  const events: string[] = [];
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
    onEvent: (e) => events.push(e),
  });
  assert.ok(calls.includes("start"));
  assert.deepEqual(events, ["started", "finished"]);
});

test("populated local store: never configures or starts", async () => {
  const { api, calls } = fakeBridge({ localItems: 7, cloudItems: 42 });
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
  });
  assert.deepEqual(calls, ["stats"]);
});

test("fresh account (empty cloud): preflights but never starts", async () => {
  const { api, calls } = fakeBridge({ cloudItems: 0, cloudChats: 0 });
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
  });
  assert.ok(calls.includes("preflight"));
  assert.ok(!calls.includes("start"));
});

test("an import already running (another window / settings pane) is left alone", async () => {
  const { api, calls } = fakeBridge({ cloudItems: 42, statusScript: [{ running: true }] });
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
  });
  assert.ok(!calls.includes("start"));
});

test("local vault disabled (explicit opt-out): does nothing at all", async () => {
  const { api, calls } = fakeBridge({ cloudItems: 42 });
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api,
    isEnabled: () => false,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
  });
  assert.deepEqual(calls, []);
});

test("second call for the same user in one session is a no-op", async () => {
  const first = fakeBridge({ cloudItems: 3 });
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api: first.api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
  });
  const second = fakeBridge({ cloudItems: 3 });
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api: second.api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
  });
  assert.ok(first.calls.includes("start"));
  assert.deepEqual(second.calls, []);
});

test("a cancelled import finishes silently — no false 'finished' toast", async () => {
  const { api } = fakeBridge({
    cloudItems: 42,
    statusScript: [{ running: false }, { running: true }, { running: false, cancelled: true }],
  });
  const events: string[] = [];
  await autoImportCloudVaultIfNeeded({
    userId: "user-1",
    api,
    isEnabled: () => true,
    getSession: session,
    sleepImpl: noSleep,
    resetRepository: noReset,
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(events, ["started"]);
});
