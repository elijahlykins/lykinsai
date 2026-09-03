import test from "node:test";
import assert from "node:assert/strict";
import {
  getAttachedChatId,
  resetBrowserChatAttach,
} from "@/lib/lyknChat/browserChatAttach";
import {
  handleLyknBrowserClick,
  openArtifactInStudioBrowser,
  openInStudioBrowser,
  studioOpenChatOpts,
} from "@/lib/lyknChat/openInStudioBrowser";
import { setActiveThreadChatId } from "@/lib/chat/chatThreadRuntime";

function withLykn(lykn: Record<string, unknown>, fn: () => Promise<void>) {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    lykn,
  };
  return fn().finally(() => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
    setActiveThreadChatId(null);
    resetBrowserChatAttach();
  });
}

test("markdown-style open with explicit Chat A reaches studioOpenUrl as A", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ chatId: opts?.chatId });
        return Promise.resolve({ ok: true, id: "tab-a" });
      },
    },
    async () => {
      setActiveThreadChatId("chat-home");
      assert.equal(
        openInStudioBrowser("https://example.com/docs", "Docs", { chatId: "chat-a" }),
        true,
      );
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls[0]?.chatId, "chat-a");
      assert.equal(getAttachedChatId("tab-a"), "chat-a");
    },
  );
});

test("research source click in Chat A does not inherit Home B", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ chatId: opts?.chatId });
        return Promise.resolve({ ok: true, id: "tab-src" });
      },
    },
    async () => {
      setActiveThreadChatId("chat-b");
      const handled = handleLyknBrowserClick(
        { preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false, button: 0 },
        "https://source.example/paper",
        "Paper",
        { chatId: "chat-a" },
      );
      assert.equal(handled, true);
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls[0]?.chatId, "chat-a");
      assert.equal(getAttachedChatId("tab-src"), "chat-a");
    },
  );
});

test("LinkPreview-style options object as the title argument still binds A", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ chatId: opts?.chatId });
        return Promise.resolve({ ok: true, id: "tab-prev" });
      },
    },
    async () => {
      setActiveThreadChatId("chat-b");
      handleLyknBrowserClick(
        { preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false, button: 0 },
        "https://preview.example",
        studioOpenChatOpts("chat-a"),
      );
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls[0]?.chatId, "chat-a");
      assert.equal(getAttachedChatId("tab-prev"), "chat-a");
    },
  );
});

test("Chat A and Chat B link clicks bind independently", async () => {
  resetBrowserChatAttach();
  let n = 0;
  await withLykn(
    {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        n += 1;
        return Promise.resolve({ ok: true, id: `tab-${opts?.chatId || n}` });
      },
    },
    async () => {
      openInStudioBrowser("https://a.example", "A", { chatId: "chat-a" });
      openInStudioBrowser("https://b.example", "B", { chatId: "chat-b" });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(getAttachedChatId("tab-chat-a"), "chat-a");
      assert.equal(getAttachedChatId("tab-chat-b"), "chat-b");
    },
  );
});

test("stale Home chat cannot steal a message-owned click", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ chatId: opts?.chatId });
        return Promise.resolve({ ok: true, id: "tab-stale" });
      },
    },
    async () => {
      setActiveThreadChatId("chat-b");
      openInStudioBrowser("https://owned.example", undefined, { chatId: "chat-a" });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls[0]?.chatId, "chat-a");
      assert.notEqual(calls[0]?.chatId, "chat-b");
      assert.equal(getAttachedChatId("tab-stale"), "chat-a");
    },
  );
});

test("a non-chat open stays unbound even when Home has an active chat", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      studioOpenUrl(_url: string, _title?: string, opts?: { chatId?: string }) {
        calls.push({ chatId: opts?.chatId });
        return Promise.resolve({ ok: true, id: "tab-free" });
      },
    },
    async () => {
      setActiveThreadChatId("chat-home");
      openInStudioBrowser("https://generic.example", "Generic");
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls[0]?.chatId, undefined);
      assert.equal(getAttachedChatId("tab-free"), null);
    },
  );
});

test("chat-owned artifacts stamp chatId; vault-style artifacts stay unbound", async () => {
  resetBrowserChatAttach();
  const calls: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      studioOpenArtifact(payload: { chatId?: string }) {
        calls.push({ chatId: payload.chatId });
        return Promise.resolve({ ok: true, id: `art-${calls.length}` });
      },
    },
    async () => {
      setActiveThreadChatId("chat-home");
      openArtifactInStudioBrowser(
        { previewUrl: "https://art.example/a.html", title: "A" },
        { chatId: "chat-a" },
      );
      openArtifactInStudioBrowser({
        previewUrl: "https://art.example/vault.html",
        title: "Vault",
      });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls[0]?.chatId, "chat-a");
      assert.equal(getAttachedChatId("art-1"), "chat-a");
      assert.equal(calls[1]?.chatId, undefined);
      assert.equal(getAttachedChatId("art-2"), null);
    },
  );
});

test("openExternal fallback carries explicit chatId and never Home", async () => {
  resetBrowserChatAttach();
  const externals: Array<{ chatId?: string }> = [];
  await withLykn(
    {
      openExternal(_url: string, _title?: string, opts?: { chatId?: string }) {
        externals.push({ chatId: opts?.chatId });
      },
    },
    async () => {
      setActiveThreadChatId("chat-home");
      openInStudioBrowser("https://fallback.example", "F", { chatId: "chat-a" });
      openInStudioBrowser("https://unbound.example", "U");
      assert.equal(externals[0]?.chatId, "chat-a");
      assert.equal(externals[1]?.chatId, undefined);
    },
  );
});
