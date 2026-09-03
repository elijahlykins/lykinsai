import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureThreadSnapshot,
  getThreadSnapshot,
  patchThreadSnapshot,
} from "@/lib/chat/chatThreadRuntime";
import { hydrateThreadSnapshotFromLocal } from "@/lib/lyknChat/hydrateThreadSnapshot";
import { persistOffRouteThread, writeThreadChatCache } from "@/lib/lyknChat/persistThreadChat";

const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};
try {
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
  });
} catch {
  (globalThis as { localStorage: typeof localStorageMock }).localStorage = localStorageMock;
}

function unique(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

test("off-route persist writes Chat A cache and leaves Chat B untouched", async () => {
  const chatA = unique("chat-a");
  const chatB = unique("chat-b");
  patchThreadSnapshot(chatA, {
    chatMessages: [{ id: "m1", role: "user", content: "from browser", kind: "prompt", createdAt: new Date().toISOString() }],
    aiThread: [{ role: "user", content: "from browser" }],
  });
  patchThreadSnapshot(chatB, {
    chatMessages: [{ id: "m2", role: "user", content: "home only", kind: "prompt", createdAt: new Date().toISOString() }],
    aiThread: [{ role: "user", content: "home only" }],
  });
  localStorage.setItem(`lyknchat_chat_${chatB}`, JSON.stringify({
    chatMessages: [{ id: "m2", role: "user", content: "home only" }],
    aiThread: [{ role: "user", content: "home only" }],
  }));

  await persistOffRouteThread(chatA, null);
  const storedA = JSON.parse(localStorage.getItem(`lyknchat_chat_${chatA}`) || "{}");
  const storedB = JSON.parse(localStorage.getItem(`lyknchat_chat_${chatB}`) || "{}");
  assert.equal(storedA.chatMessages[0].content, "from browser");
  assert.equal(storedB.chatMessages[0].content, "home only");
  assert.equal(getThreadSnapshot(chatB)?.chatMessages[0].content, "home only");
});

test("runtime snapshot for Chat A receives the browser turn", () => {
  const chatA = unique("chat-a");
  ensureThreadSnapshot(chatA);
  patchThreadSnapshot(chatA, {
    chatMessages: [
      { id: "u1", role: "user", content: "What is this page about?", kind: "prompt", createdAt: new Date().toISOString() },
    ],
  });
  writeThreadChatCache(chatA);
  const snap = getThreadSnapshot(chatA);
  assert.equal(snap?.chatMessages[0].content, "What is this page about?");
});

test("hydrate empty snapshot from local cache before send", () => {
  const chatA = unique("chat-a");
  localStorage.setItem(`lyknchat_chat_${chatA}`, JSON.stringify({
    chatMessages: [{ id: "old", role: "user", content: "prior A turn", kind: "prompt" }],
    aiThread: [{ role: "user", content: "prior A turn" }],
  }));
  const snap = hydrateThreadSnapshotFromLocal(chatA);
  assert.equal(snap?.chatMessages[0].content, "prior A turn");
});
