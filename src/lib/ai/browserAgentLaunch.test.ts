import test from "node:test";
import assert from "node:assert/strict";
import { startBrowserAgentTask } from "@/lib/ai/browserAgentLaunch";
import {
  getAttachedChatId,
  resetBrowserChatAttach,
} from "@/lib/lyknChat/browserChatAttach";

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
    resetBrowserChatAttach();
  });
}

test("Chat A launching local_browser_agent stamps sourceChatId A", async () => {
  resetBrowserChatAttach();
  const creates: Array<{ sourceChatId?: string }> = [];
  const sends: Array<{ id: string; opts?: { task?: { chatId?: string } } }> = [];
  await withLykn(
    {
      agentCreate(payload: { sourceChatId?: string }) {
        creates.push(payload);
        return Promise.resolve({ ok: true, agentId: "agent-a" });
      },
      studioAgentSend(_text: string, _atts: unknown[], id: string, opts: { task?: { chatId?: string } }) {
        sends.push({ id, opts });
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      const result = await startBrowserAgentTask(
        { task: "Research X", url: "https://example.com" },
        { chatId: "chat-a" },
      );
      assert.equal(result.ok, true);
      assert.equal(creates[0]?.sourceChatId, "chat-a");
      assert.equal(sends[0]?.id, "agent-a");
      assert.equal(sends[0]?.opts?.task?.chatId, "chat-a");
      assert.equal(getAttachedChatId("agent-a"), "chat-a");
    },
  );
});

test("Chat B launching a second agent stamps sourceChatId B", async () => {
  resetBrowserChatAttach();
  let n = 0;
  await withLykn(
    {
      agentCreate() {
        n += 1;
        return Promise.resolve({ ok: true, agentId: `agent-${n}` });
      },
      studioAgentSend() {
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      await startBrowserAgentTask({ task: "A work" }, { chatId: "chat-a" });
      await startBrowserAgentTask({ task: "B work" }, { chatId: "chat-b" });
      assert.equal(getAttachedChatId("agent-1"), "chat-a");
      assert.equal(getAttachedChatId("agent-2"), "chat-b");
    },
  );
});

test("simultaneous launches cannot cross-bind chats", async () => {
  resetBrowserChatAttach();
  let n = 0;
  const creates: string[] = [];
  await withLykn(
    {
      agentCreate(payload: { sourceChatId?: string }) {
        const id = `agent-${++n}`;
        creates.push(String(payload.sourceChatId || ""));
        return Promise.resolve({ ok: true, agentId: id });
      },
      studioAgentSend() {
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      await Promise.all([
        startBrowserAgentTask({ task: "A" }, { chatId: "chat-a" }),
        startBrowserAgentTask({ task: "B" }, { chatId: "chat-b" }),
      ]);
      assert.deepEqual(creates.sort(), ["chat-a", "chat-b"]);
      const a = getAttachedChatId("agent-1");
      const b = getAttachedChatId("agent-2");
      assert.ok(a === "chat-a" || a === "chat-b");
      assert.ok(b === "chat-a" || b === "chat-b");
      assert.notEqual(a, b);
    },
  );
});

test("model args.chatId cannot choose the conversation", async () => {
  resetBrowserChatAttach();
  const creates: Array<{ sourceChatId?: string }> = [];
  await withLykn(
    {
      agentCreate(payload: { sourceChatId?: string }) {
        creates.push(payload);
        return Promise.resolve({ ok: true, agentId: "agent-1" });
      },
      studioAgentSend() {
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      await startBrowserAgentTask(
        { task: "browse", chatId: "chat-model" },
        { chatId: "chat-host" },
      );
      assert.equal(creates[0]?.sourceChatId, "chat-host");
      assert.notEqual(creates[0]?.sourceChatId, "chat-model");
      assert.equal(getAttachedChatId("agent-1"), "chat-host");
    },
  );
});

test("without host context, model chatId is still ignored and the tab stays unbound", async () => {
  resetBrowserChatAttach();
  const creates: Array<{ sourceChatId?: string }> = [];
  await withLykn(
    {
      agentCreate(payload: { sourceChatId?: string }) {
        creates.push(payload);
        return Promise.resolve({ ok: true, agentId: "agent-1" });
      },
      studioAgentSend(_t: string, _a: unknown[], _id: string, opts: { task?: { chatId?: string } }) {
        assert.equal(opts?.task?.chatId, undefined);
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      await startBrowserAgentTask({ task: "browse", chatId: "chat-model" });
      assert.equal(creates[0]?.sourceChatId, undefined);
      assert.equal(getAttachedChatId("agent-1"), null);
    },
  );
});
