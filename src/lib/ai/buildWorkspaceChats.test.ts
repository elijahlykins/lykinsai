// Run: node --import ./scripts/test-alias-loader.mjs --test src/lib/ai/buildWorkspaceChats.test.ts
//
// Workspace-chat continuity memory. The invariant that matters: once a chat
// has built in the workspace, isWorkspaceChat answers true for it across
// sends (and reloads, via localStorage), so follow-ups keep arming the
// workspace instead of falling back to the in-chat artifact pipeline.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { isWorkspaceChat, markWorkspaceChat } from "@/lib/ai/buildWorkspaceChats";

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

const globalRef = globalThis as { window?: unknown };
let hadWindow = false;
let savedWindow: unknown;

beforeEach(() => {
  hadWindow = "window" in globalRef;
  savedWindow = globalRef.window;
  globalRef.window = { localStorage: fakeLocalStorage() };
});

afterEach(() => {
  if (hadWindow) globalRef.window = savedWindow;
  else delete globalRef.window;
});

test("a marked chat is remembered; others are not", () => {
  assert.equal(isWorkspaceChat("chat-a"), false);
  markWorkspaceChat("chat-a");
  assert.equal(isWorkspaceChat("chat-a"), true);
  assert.equal(isWorkspaceChat("chat-b"), false);
});

test("marking is idempotent and blank ids are ignored", () => {
  markWorkspaceChat("chat-a");
  markWorkspaceChat("chat-a");
  markWorkspaceChat("");
  markWorkspaceChat("   ");
  assert.equal(isWorkspaceChat("chat-a"), true);
  assert.equal(isWorkspaceChat(""), false);
});

test("the memory is capped — oldest chats age out, recent ones survive", () => {
  for (let i = 0; i < 250; i++) markWorkspaceChat(`chat-${i}`);
  assert.equal(isWorkspaceChat("chat-0"), false);
  assert.equal(isWorkspaceChat("chat-249"), true);
  assert.equal(isWorkspaceChat("chat-100"), true);
});

test("no window (SSR) degrades to false without throwing", () => {
  delete globalRef.window;
  assert.equal(isWorkspaceChat("chat-a"), false);
  markWorkspaceChat("chat-a");
  assert.equal(isWorkspaceChat("chat-a"), false);
});

test("corrupted storage reads as empty", () => {
  (globalRef.window as { localStorage: ReturnType<typeof fakeLocalStorage> }).localStorage.setItem(
    "lykn_workspace_build_chats",
    "{not json",
  );
  assert.equal(isWorkspaceChat("chat-a"), false);
  markWorkspaceChat("chat-a");
  assert.equal(isWorkspaceChat("chat-a"), true);
});
