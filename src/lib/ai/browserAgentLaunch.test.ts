import test from "node:test";
import assert from "node:assert/strict";
import { startBrowserAgentTask } from "@/lib/ai/browserAgentLaunch";
import {
  getAttachedChatId,
  isBrowserTabRevealed,
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

test("launching an agent never binds the tab to the launching chat", async () => {
  resetBrowserChatAttach();
  const creates: Array<Record<string, unknown>> = [];
  const sends: Array<{ id: string; opts?: Record<string, unknown> }> = [];
  await withLykn(
    {
      agentCreate(payload: Record<string, unknown>) {
        creates.push(payload);
        return Promise.resolve({ ok: true, agentId: "agent-a" });
      },
      studioAgentSend(_text: string, _atts: unknown[], id: string, opts: Record<string, unknown>) {
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
      // Separation contract: no sourceChatId lineage, no task.chatId stamp,
      // no renderer bind. The agent tab is its own conversation.
      assert.equal("sourceChatId" in (creates[0] || {}), false);
      assert.equal(sends[0]?.id, "agent-a");
      assert.deepEqual(sends[0]?.opts, {});
      assert.equal(getAttachedChatId("agent-a"), null);
      // The tab is still marked revealed so its OWN chat (minted on first
      // rail send) raises it later.
      assert.equal(isBrowserTabRevealed("agent-a"), true);
    },
  );
});

test("two chats launching agents leave both tabs unbound and independent", async () => {
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
      assert.equal(getAttachedChatId("agent-1"), null);
      assert.equal(getAttachedChatId("agent-2"), null);
    },
  );
});

test("model args.chatId cannot bind the conversation either", async () => {
  resetBrowserChatAttach();
  const creates: Array<Record<string, unknown>> = [];
  await withLykn(
    {
      agentCreate(payload: Record<string, unknown>) {
        creates.push(payload);
        return Promise.resolve({ ok: true, agentId: "agent-1" });
      },
      studioAgentSend(_t: string, _a: unknown[], _id: string, opts: Record<string, unknown>) {
        assert.deepEqual(opts, {});
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      await startBrowserAgentTask(
        { task: "browse", chatId: "chat-model" },
        { chatId: "chat-host" },
      );
      assert.equal("sourceChatId" in (creates[0] || {}), false);
      assert.equal(getAttachedChatId("agent-1"), null);
    },
  );
});

test("without host context the tab also stays unbound", async () => {
  resetBrowserChatAttach();
  await withLykn(
    {
      agentCreate() {
        return Promise.resolve({ ok: true, agentId: "agent-1" });
      },
      studioAgentSend(_t: string, _a: unknown[], _id: string, opts: Record<string, unknown>) {
        assert.deepEqual(opts, {});
        return Promise.resolve({ ok: true });
      },
    },
    async () => {
      const result = await startBrowserAgentTask({ task: "browse", chatId: "chat-model" });
      assert.equal(result.ok, true);
      assert.equal(getAttachedChatId("agent-1"), null);
    },
  );
});
