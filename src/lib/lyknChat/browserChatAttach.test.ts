import test from "node:test";
import assert from "node:assert/strict";
import {
  bindBrowserTabChat,
  consumePendingBrowserChat,
  getAttachedChatId,
  getAttachedPageForChat,
  markPendingBrowserChat,
  resetBrowserChatAttach,
  unbindBrowserTabChat,
} from "@/lib/lyknChat/browserChatAttach";
import { openInStudioBrowser } from "@/lib/lyknChat/openInStudioBrowser";
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

test("the latest tab for a chat wins as the open page", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("agent-1", "chat-abc", { url: "https://a.example" });
  bindBrowserTabChat("agent-2", "chat-abc", { url: "https://b.example" });
  assert.equal(getAttachedChatId("agent-1"), "chat-abc");
  assert.equal(getAttachedChatId("agent-2"), "chat-abc");
  assert.equal(getAttachedPageForChat("chat-abc")?.agentId, "agent-2");
  assert.equal(getAttachedPageForChat("chat-abc")?.url, "https://b.example");
});

test("a pending chat shows in the rail before the tab id arrives", () => {
  resetBrowserChatAttach();
  markPendingBrowserChat("chat-abc");
  assert.equal(getAttachedChatId(null), "chat-abc");
  consumePendingBrowserChat("agent-9");
  assert.equal(getAttachedChatId("agent-9"), "chat-abc");
  assert.equal(getAttachedChatId(null), null);
});

test("unbind drops only that tab", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("agent-1", "chat-abc");
  bindBrowserTabChat("agent-2", "chat-abc");
  unbindBrowserTabChat("agent-1");
  assert.equal(getAttachedChatId("agent-1"), null);
  assert.equal(getAttachedChatId("agent-2"), "chat-abc");
});

test("a Bot's worker tab keeps its own chat, not a sibling LYKN tab's", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("lykn-tab", "chat-lykn");
  bindBrowserTabChat("bot-scout", "chat-scout");
  assert.equal(getAttachedChatId("bot-scout"), "chat-scout");
  assert.equal(getAttachedChatId("lykn-tab"), "chat-lykn");
  assert.equal(getAttachedPageForChat("chat-scout")?.agentId, "bot-scout");
});

// The regression that shipped an empty rail: the open flow sent the chat id
// to the main process but never registered the bind on the renderer side,
// so the rail never found the conversation.
test("opening a link from a chat binds the new tab to that conversation", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ url: string; opts?: { chatId?: string } }> = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
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
    setActiveThreadChatId("chat-live");
    const handled = openInStudioBrowser("https://example.com/pricing", "Pricing");
    assert.equal(handled, true);
    // Marked pending immediately — a rail that mounts before the open
    // resolves still finds the conversation.
    assert.equal(getAttachedChatId(null), "chat-live");
    await new Promise((r) => setTimeout(r, 0));
    // Resolved: the real tab id is bound, and the chat id traveled to main.
    assert.equal(getAttachedChatId("tab-7"), "chat-live");
    assert.equal(calls[0]?.opts?.chatId, "chat-live");
  } finally {
    setActiveThreadChatId(null);
    delete (globalThis as { window?: unknown }).window;
    resetBrowserChatAttach();
  }
});
