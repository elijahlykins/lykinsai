import test from "node:test";
import assert from "node:assert/strict";
import {
  bindBrowserTabChat,
  consumePendingBrowserChat,
  ensureBrowserTabChat,
  getAttachedChatId,
  getAttachedPageForChat,
  hydrateTabChatFromMain,
  isBrowserTabRevealed,
  markBrowserTabRevealed,
  markPendingBrowserChat,
  otherChatHasRevealedBrowser,
  resetBrowserChatAttach,
  resolveRailChatId,
  unbindBrowserTabChat,
} from "@/lib/lyknChat/browserChatAttach";
import {
  hideStudioBrowser,
  openInStudioBrowser,
  STUDIO_HIDE_BROWSER_EVENT,
  syncStudioBrowserToChat,
} from "@/lib/lyknChat/openInStudioBrowser";
import { setActiveThreadChatId } from "@/lib/chat/chatThreadRuntime";

test("bindBrowserTabChat pairs a tab with the chat that opened it", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("agent-1", "chat-abc", {
    url: "https://example.com/docs",
    title: "Docs",
  });
  assert.equal(getAttachedChatId("agent-1"), "chat-abc");
  const page = getAttachedPageForChat("chat-abc");
  assert.ok(page);
  assert.equal(page?.agentId, "agent-1");
  assert.equal(page?.url, "https://example.com/docs");
  assert.equal(page?.title, "Docs");
});

test("independent tabs keep their own chats when switching", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("tab-a", "chat-a");
  bindBrowserTabChat("tab-b", "chat-b");
  assert.equal(getAttachedChatId("tab-a"), "chat-a");
  assert.equal(getAttachedChatId("tab-b"), "chat-b");
  assert.equal(
    resolveRailChatId({ tabId: "tab-a", attachedChatId: getAttachedChatId("tab-a") }),
    "chat-a",
  );
  assert.equal(
    resolveRailChatId({ tabId: "tab-b", attachedChatId: getAttachedChatId("tab-b") }),
    "chat-b",
  );
  assert.equal(
    resolveRailChatId({ tabId: "tab-c", attachedChatId: getAttachedChatId("tab-c") }),
    null,
  );
  assert.equal(
    resolveRailChatId({ tabId: "tab-a", attachedChatId: getAttachedChatId("tab-a") }),
    "chat-a",
  );
});

test("the latest tab for a chat wins as the open page", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("agent-1", "chat-abc", { url: "https://a.example" });
  bindBrowserTabChat("agent-2", "chat-abc", { url: "https://b.example" });
  assert.equal(getAttachedChatId("agent-1"), "chat-abc");
  assert.equal(getAttachedChatId("agent-2"), "chat-abc");
  assert.equal(getAttachedPageForChat("chat-abc")?.agentId, "agent-2");
  assert.equal(getAttachedPageForChat("chat-abc")?.url, "https://b.example");
});

test("a pending token does not become the rail conversation without a tab id", () => {
  resetBrowserChatAttach();
  setActiveThreadChatId("chat-home");
  markPendingBrowserChat("chat-abc");
  assert.equal(getAttachedChatId(null), null);
  assert.equal(resolveRailChatId({ tabId: null, attachedChatId: getAttachedChatId(null) }), null);
  consumePendingBrowserChat("agent-9");
  assert.equal(getAttachedChatId("agent-9"), null);
  consumePendingBrowserChat("agent-9", markPendingBrowserChat("chat-abc"));
  assert.equal(getAttachedChatId("agent-9"), "chat-abc");
  setActiveThreadChatId(null);
});

test("ensureBrowserTabChat skips a no-op bind so listeners stay quiet", () => {
  resetBrowserChatAttach();
  ensureBrowserTabChat("agent-1", "chat-abc", { url: "https://a.example" });
  assert.equal(getAttachedChatId("agent-1"), "chat-abc");
  const first = getAttachedPageForChat("chat-abc");
  assert.ok(first);
  ensureBrowserTabChat("agent-1", "chat-abc", { url: "https://a.example" });
  assert.equal(getAttachedPageForChat("chat-abc")?.at, first?.at);
  ensureBrowserTabChat("agent-1", "chat-abc", { url: "https://b.example" });
  const next = getAttachedPageForChat("chat-abc");
  assert.equal(next?.url, "https://b.example");
  assert.ok((next?.at || 0) > (first?.at || 0));
});

test("unbind drops only that tab", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("agent-1", "chat-abc");
  bindBrowserTabChat("agent-2", "chat-abc");
  unbindBrowserTabChat("agent-1");
  assert.equal(getAttachedChatId("agent-1"), null);
  assert.equal(getAttachedChatId("agent-2"), "chat-abc");
});

test("closing a bound tab removes its conversation binding", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("tab-a", "chat-a");
  unbindBrowserTabChat("tab-a");
  assert.equal(getAttachedChatId("tab-a"), null);
  assert.equal(resolveRailChatId({ tabId: "tab-a", attachedChatId: getAttachedChatId("tab-a") }), null);
});

test("a pending chat does not attach to a tab that already exists", () => {
  resetBrowserChatAttach();
  const token = markPendingBrowserChat("chat-lykn");
  assert.equal(getAttachedChatId("bot-scout"), null);
  consumePendingBrowserChat("bot-scout", token);
  assert.equal(getAttachedChatId("bot-scout"), "chat-lykn");
});

test("ensureBrowserTabChat will not steal a tab already bound to another chat", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("bot-scout", "chat-scout", { url: "https://scout.example" });
  ensureBrowserTabChat("bot-scout", "chat-lykn", { url: "https://lykn.example" });
  assert.equal(getAttachedChatId("bot-scout"), "chat-scout");
  assert.equal(getAttachedPageForChat("chat-scout")?.url, "https://scout.example");
  assert.equal(getAttachedPageForChat("chat-lykn"), null);
});

test("a revealed Bot tab stays with that Bot's chat", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("bot-scout", "chat-scout");
  markBrowserTabRevealed("bot-scout");
  assert.equal(isBrowserTabRevealed("bot-scout"), true);
  assert.equal(otherChatHasRevealedBrowser("chat-lykn"), true);
  assert.equal(otherChatHasRevealedBrowser("chat-scout"), false);
});

test("syncStudioBrowserToChat parks another board's revealed preview", () => {
  resetBrowserChatAttach();
  const events = [];
  const previous = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) {
      events.push(event?.type);
      return true;
    },
    lykn: {},
  };
  try {
    bindBrowserTabChat("bot-scout", "chat-scout");
    markBrowserTabRevealed("bot-scout");
    syncStudioBrowserToChat("chat-lykn");
    assert.ok(events.includes(STUDIO_HIDE_BROWSER_EVENT));
    events.length = 0;
    syncStudioBrowserToChat("chat-scout");
    assert.ok(events.includes("lykn-studio-show-browser"));
    hideStudioBrowser();
    assert.ok(events.includes(STUDIO_HIDE_BROWSER_EVENT));
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    resetBrowserChatAttach();
  }
});

test("a Bot's worker tab keeps its own chat, not a sibling LYKN tab's", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("lykn-tab", "chat-lykn");
  bindBrowserTabChat("bot-scout", "chat-scout");
  assert.equal(getAttachedChatId("bot-scout"), "chat-scout");
  assert.equal(getAttachedChatId("lykn-tab"), "chat-lykn");
  assert.equal(getAttachedPageForChat("chat-scout")?.agentId, "bot-scout");
});

test("an unbound tab does not inherit the active Home chat", () => {
  resetBrowserChatAttach();
  setActiveThreadChatId("chat-z");
  try {
    assert.equal(getAttachedChatId("tab-c"), null);
    assert.equal(
      resolveRailChatId({
        tabId: "tab-c",
        attachedChatId: getAttachedChatId("tab-c"),
      }),
      null,
    );
    assert.notEqual(
      resolveRailChatId({
        tabId: "tab-c",
        attachedChatId: getAttachedChatId("tab-c"),
      }),
      "chat-z",
    );
  } finally {
    setActiveThreadChatId(null);
  }
});

test("a manual new tab stays unbound", () => {
  resetBrowserChatAttach();
  setActiveThreadChatId("chat-a");
  bindBrowserTabChat("tab-a", "chat-a");
  try {
    assert.equal(getAttachedChatId("fresh-tab"), null);
    assert.equal(
      resolveRailChatId({
        tabId: "fresh-tab",
        attachedChatId: getAttachedChatId("fresh-tab"),
      }),
      null,
    );
  } finally {
    setActiveThreadChatId(null);
  }
});

test("cold renderer recovers sourceChatId from trusted main projection", () => {
  resetBrowserChatAttach();
  setActiveThreadChatId("chat-z");
  try {
    hydrateTabChatFromMain("tab-a", "chat-a", { url: "https://a.example", title: "A" });
    assert.equal(getAttachedChatId("tab-a"), "chat-a");
    assert.equal(
      resolveRailChatId({
        tabId: "tab-a",
        attachedChatId: getAttachedChatId("tab-a"),
      }),
      "chat-a",
    );
    assert.notEqual(getAttachedChatId("tab-a"), "chat-z");
  } finally {
    setActiveThreadChatId(null);
  }
});

test("hydrate from main does not steal a tab already bound to another chat", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("tab-a", "chat-a");
  hydrateTabChatFromMain("tab-a", "chat-b");
  assert.equal(getAttachedChatId("tab-a"), "chat-a");
});

test("resolveRailChatId never substitutes Home or a missing tab", () => {
  assert.equal(resolveRailChatId({ tabId: "tab-a", attachedChatId: "chat-a" }), "chat-a");
  assert.equal(resolveRailChatId({ tabId: "tab-c", attachedChatId: null }), null);
  assert.equal(resolveRailChatId({ tabId: "", attachedChatId: "chat-z" }), null);
  assert.equal(resolveRailChatId({ tabId: null, attachedChatId: "chat-z" }), null);
});

// The regression that shipped an empty rail: the open flow sent the chat id
// to the main process but never registered the bind on the renderer side,
// so the rail never found the conversation.
test("opening a link from a chat binds the new tab to that conversation", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ url: string; opts?: { chatId?: string } }> = [];
  const events: Array<{ openRail?: boolean }> = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event: { detail?: { openRail?: boolean } }) {
      events.push(event?.detail || {});
      return true;
    },
    lykn: {
      studioOpenUrl(url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ url, opts });
        return Promise.resolve({ ok: true, id: "tab-7" });
      },
    },
  };
  try {
    setActiveThreadChatId("chat-other");
    const handled = openInStudioBrowser("https://example.com/pricing", "Pricing", {
      chatId: "chat-live",
    });
    assert.equal(handled, true);
    assert.equal(getAttachedChatId(null), null);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getAttachedChatId("tab-7"), "chat-live");
    assert.equal(calls[0]?.opts?.chatId, "chat-live");
    assert.ok(events.length >= 1);
    assert.ok(events.every((d) => d.openRail !== true));
  } finally {
    setActiveThreadChatId(null);
    delete (globalThis as { window?: unknown }).window;
    resetBrowserChatAttach();
  }
});

test("two rapid studio opens cannot cross-bind chats", async () => {
  resetBrowserChatAttach();
  let n = 0;
  const calls: Array<{ chatId?: string }> = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    lykn: {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ chatId: opts?.chatId });
        const id = `tab-${++n}`;
        return Promise.resolve({ ok: true, id });
      },
    },
  };
  try {
    setActiveThreadChatId("chat-home");
    assert.equal(openInStudioBrowser("https://a.example", "A", { chatId: "chat-a" }), true);
    assert.equal(openInStudioBrowser("https://b.example", "B", { chatId: "chat-b" }), true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls[0]?.chatId, "chat-a");
    assert.equal(calls[1]?.chatId, "chat-b");
    assert.equal(getAttachedChatId("tab-1"), "chat-a");
    assert.equal(getAttachedChatId("tab-2"), "chat-b");
  } finally {
    setActiveThreadChatId(null);
    delete (globalThis as { window?: unknown }).window;
    resetBrowserChatAttach();
  }
});
