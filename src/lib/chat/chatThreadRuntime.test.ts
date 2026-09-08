import test from "node:test";
import assert from "node:assert/strict";
import {
  getThreadSnapshot,
  pauseInFlightWork,
  patchThreadSnapshot,
} from "./chatThreadRuntime";
import { enqueuePrompt, listQueuedPrompts, runNextQueuedPrompt } from "./promptQueue";

test("pauseInFlightWork stops the turn as Paused and keeps the queue", () => {
  const chatId = `pause-work-${Date.now()}`;
  const ac = new AbortController();
  patchThreadSnapshot(chatId, {
    isChatLoading: true,
    chatStatusText: "Thinking…",
    abortController: ac,
    chatMessages: [{ id: "m1", role: "user", content: "hi", aiResponse: "" }],
  });
  enqueuePrompt({ chatId, text: "next please", attachments: [], kind: "chat" });

  pauseInFlightWork();

  const snap = getThreadSnapshot(chatId);
  assert.equal(ac.signal.aborted, true);
  assert.equal(snap?.isChatLoading, false);
  assert.equal(snap?.chatStatusText, "Paused");
  assert.equal(snap?.chatMessages[0]?.aiResponse, "Paused.");
  assert.equal(listQueuedPrompts(chatId).length, 1);
  let sent = 0;
  assert.equal(runNextQueuedPrompt(chatId, () => { sent += 1; }), false);
  assert.equal(sent, 0);
});
