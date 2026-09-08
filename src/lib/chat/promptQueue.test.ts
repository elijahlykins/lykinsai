import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_QUEUED_PROMPTS,
  clearQueuedPrompts,
  consumeSkipQueueDrain,
  enqueuePrompt,
  listQueuedPrompts,
  queuedPromptPreview,
  removeQueuedPrompt,
  runNextQueuedPrompt,
  skipNextQueueDrain,
  takeNextQueuedPrompt,
} from "./promptQueue";

const CHAT = "chat-queue-test";

test("prompt queue is FIFO per chat and skips empty items", () => {
  clearQueuedPrompts(CHAT);
  assert.equal(enqueuePrompt({ chatId: CHAT, text: "", attachments: [], kind: "chat" }), null);
  enqueuePrompt({ chatId: CHAT, text: "first", attachments: [], kind: "chat" });
  enqueuePrompt({ chatId: CHAT, text: "second", attachments: [], kind: "imagine" });
  const listed = listQueuedPrompts(CHAT);
  assert.equal(listed.length, 2);
  assert.equal(takeNextQueuedPrompt(CHAT)?.text, "first");
  assert.equal(takeNextQueuedPrompt(CHAT)?.kind, "imagine");
  assert.equal(takeNextQueuedPrompt(CHAT), null);
});

test("prompt queue can drop one item or clear the chat", () => {
  clearQueuedPrompts(CHAT);
  const a = enqueuePrompt({ chatId: CHAT, text: "keep", attachments: [], kind: "chat" });
  const b = enqueuePrompt({ chatId: CHAT, text: "drop", attachments: [], kind: "chat" });
  assert.ok(a && b);
  assert.equal(removeQueuedPrompt(CHAT, b.id), true);
  assert.deepEqual(
    listQueuedPrompts(CHAT).map((item) => item.text),
    ["keep"],
  );
  clearQueuedPrompts(CHAT);
  assert.equal(listQueuedPrompts(CHAT).length, 0);
});

test("prompt queue caps length and previews attachment-only items", () => {
  clearQueuedPrompts(CHAT);
  for (let i = 0; i < MAX_QUEUED_PROMPTS + 3; i += 1) {
    enqueuePrompt({ chatId: CHAT, text: `p${i}`, attachments: [], kind: "chat" });
  }
  assert.equal(listQueuedPrompts(CHAT).length, MAX_QUEUED_PROMPTS);
  assert.equal(
    queuedPromptPreview({
      text: "",
      attachments: [{ id: "1", type: "file", url: "", name: "notes.pdf", mime: "", size: 1 }],
    }),
    "notes.pdf",
  );
  clearQueuedPrompts(CHAT);
});

test("a power pause skips the next drain so queued prompts stay put", () => {
  clearQueuedPrompts(CHAT);
  enqueuePrompt({ chatId: CHAT, text: "next", attachments: [], kind: "chat" });
  skipNextQueueDrain(CHAT);
  let sent = 0;
  assert.equal(runNextQueuedPrompt(CHAT, () => { sent += 1; }), false);
  assert.equal(sent, 0);
  assert.equal(listQueuedPrompts(CHAT).length, 1);
  assert.equal(consumeSkipQueueDrain(CHAT), false);
  assert.equal(runNextQueuedPrompt(CHAT, () => { sent += 1; }), true);
  assert.equal(sent, 1);
  clearQueuedPrompts(CHAT);
});
