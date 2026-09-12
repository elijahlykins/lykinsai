import test from "node:test";
import assert from "node:assert/strict";

import {
  resetRailAgentChat,
  sendRailAgentTurn,
  stopRailAgentTurn,
} from "@/lib/lyknChat/railAgentChat";
import {
  ensureThreadSnapshot,
  getThreadSnapshot,
  patchThreadSnapshot,
} from "@/lib/chat/chatThreadRuntime";

type Handler = (p: Record<string, unknown>) => void;

function makeLyknStub() {
  const calls: { send: unknown[][]; stop: string[] } = { send: [], stop: [] };
  const handlers: Record<string, Handler> = {};
  const lykn = {
    studioAgentSend: async (...args: unknown[]) => {
      calls.send.push(args);
      return { ok: true };
    },
    agentStop: async (agentId: string) => {
      calls.stop.push(agentId);
      return { ok: true };
    },
    onAgentDelta: (cb: Handler) => {
      handlers.delta = cb;
      return () => {};
    },
    onAgentProgress: (cb: Handler) => {
      handlers.progress = cb;
      return () => {};
    },
    onAgentDone: (cb: Handler) => {
      handlers.done = cb;
      return () => {};
    },
    onAgentWaiting: (cb: Handler) => {
      handlers.waiting = cb;
      return () => {};
    },
  };
  return { lykn, calls, handlers };
}

async function withWindow(lykn: unknown, run: () => Promise<void>): Promise<void> {
  const g = globalThis as { window?: unknown };
  const previous = g.window;
  g.window = {
    lykn,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  try {
    await run();
  } finally {
    if (previous === undefined) delete g.window;
    else g.window = previous;
  }
}

test("rail agent turn sends the full agentic ask and streams into the thread", async () => {
  resetRailAgentChat();
  const { lykn, calls, handlers } = makeLyknStub();
  await withWindow(lykn, async () => {
    patchThreadSnapshot("chat-rail", { chatMessages: [], isChatLoading: false });
    ensureThreadSnapshot("chat-rail").chatMessages = [];

    const sent = await sendRailAgentTurn({
      chatId: "chat-rail",
      tabId: "tab-1",
      text: "find the cheapest flight and open it",
    });
    assert.equal(sent, true);

    // Full-capability send on the rail's tab: no questionsOnly, no opts.
    assert.equal(calls.send.length, 1);
    const [text, attachments, agentId, ...rest] = calls.send[0];
    assert.equal(text, "find the cheapest flight and open it");
    assert.deepEqual(attachments, []);
    assert.equal(agentId, "tab-1");
    assert.equal(rest.length, 0);

    let snap = getThreadSnapshot("chat-rail");
    assert.equal(snap?.chatMessages.length, 1);
    assert.equal(snap?.chatMessages[0].content, "find the cheapest flight and open it");
    assert.equal(snap?.isChatLoading, true);

    // Cumulative delta text replaces the assistant body.
    handlers.delta?.({ agentId: "tab-1", text: "Searching flights…" });
    handlers.delta?.({ agentId: "tab-1", text: "Searching flights… found three." });
    snap = getThreadSnapshot("chat-rail");
    assert.equal(snap?.chatMessages[0].aiResponse, "Searching flights… found three.");
    assert.equal(snap?.isChatLoading, true);

    // Progress steps drive the status line.
    handlers.progress?.({ agentId: "tab-1", step: "Opening kayak.com…", status: "running" });
    assert.equal(getThreadSnapshot("chat-rail")?.chatStatusText, "Opening kayak.com…");

    // Other agents' streams never reach this thread.
    handlers.delta?.({ agentId: "tab-other", text: "noise" });
    assert.equal(
      getThreadSnapshot("chat-rail")?.chatMessages[0].aiResponse,
      "Searching flights… found three.",
    );

    handlers.done?.({ agentId: "tab-1", text: "Opened the cheapest flight." });
    snap = getThreadSnapshot("chat-rail");
    assert.equal(snap?.chatMessages[0].aiResponse, "Opened the cheapest flight.");
    assert.equal(snap?.isChatLoading, false);
    assert.equal(snap?.chatStatusText, "");
    assert.equal(snap?.aiThread[snap.aiThread.length - 1]?.role, "assistant");
  });
});

test("stop targets the tab's agent and finalizes the turn as Stopped", async () => {
  resetRailAgentChat();
  const { lykn, calls } = makeLyknStub();
  await withWindow(lykn, async () => {
    ensureThreadSnapshot("chat-stop").chatMessages = [];
    await sendRailAgentTurn({ chatId: "chat-stop", tabId: "tab-9", text: "do the thing" });

    assert.equal(stopRailAgentTurn("chat-unknown"), false);
    assert.equal(stopRailAgentTurn("chat-stop"), true);
    assert.deepEqual(calls.stop, ["tab-9"]);
    const snap = getThreadSnapshot("chat-stop");
    assert.equal(snap?.isChatLoading, false);
    assert.equal(snap?.chatStatusText, "Stopped");
    // A second stop is a no-op: the live turn is gone.
    assert.equal(stopRailAgentTurn("chat-stop"), false);
  });
});

test("failed runtime send paints the error instead of hanging the spinner", async () => {
  resetRailAgentChat();
  const { lykn, handlers } = makeLyknStub();
  (lykn as { studioAgentSend: unknown }).studioAgentSend = async () => ({
    ok: false,
    error: "not_found",
  });
  await withWindow(lykn, async () => {
    ensureThreadSnapshot("chat-fail").chatMessages = [];
    await sendRailAgentTurn({ chatId: "chat-fail", tabId: "tab-x", text: "hi" });
    const snap = getThreadSnapshot("chat-fail");
    assert.equal(snap?.isChatLoading, false);
    assert.match(String(snap?.chatMessages[0].aiResponse), /not_found/);
    // The failed turn is no longer live — stray deltas are ignored.
    handlers.delta?.({ agentId: "tab-x", text: "late noise" });
    assert.match(String(getThreadSnapshot("chat-fail")?.chatMessages[0].aiResponse), /not_found/);
  });
});
