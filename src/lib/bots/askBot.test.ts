import test from "node:test";
import assert from "node:assert/strict";

import { formatConsultMessage, formatDispatchMessage } from "@/lib/bots/askBot";
import {
  LYKN_CHAT_OPEN_EVENT,
  openLyknChatBoard,
  presentBotInCurrentChat,
  workingBotReply,
} from "@/lib/bots/botChatBridge";

test("consult messages tell the bot LYKN is asking and include the question", () => {
  const text = formatConsultMessage("What do you think of the agent structure?");
  assert.match(text, /LYKN \(their main assistant\) to consult you/);
  assert.match(text, /Do not hand this to another teammate/);
  assert.match(text, /What do you think of the agent structure\?$/);
});

test("dispatch messages send the bot off to work instead of consulting", () => {
  const text = formatDispatchMessage("Go to Perplexity Computer and look around.");
  assert.match(text, /send you this work/);
  assert.match(text, /Use the browser when the job is on a website/);
  assert.match(text, /Go to Perplexity Computer and look around\.$/);
});

test("presentBotInCurrentChat is a no-op without a window", () => {
  assert.equal(
    presentBotInCurrentChat({ botId: "bot_1", taskId: "task_1", question: "Thoughts?" }),
    false,
  );
});

test("openLyknChatBoard is a no-op without a window", () => {
  assert.equal(openLyknChatBoard(), undefined);
});

test("openLyknChatBoard asks the chat surface to leave a Bot board", () => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event?.type);
      return true;
    },
  };
  try {
    openLyknChatBoard();
    assert.ok(events.includes(LYKN_CHAT_OPEN_EVENT));
    assert.ok(events.includes("lykn-studio-open-chat"));
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("working bot replies drop the browse step transcript", () => {
  const log = [
    "![lykn_step:browse:Thinking — Find the official](lykn-agent-step://a1/0/live)",
    "",
    "![lykn_step:browse:Opening google.com](lykn-agent-step://a1/1/live)",
  ].join("\n");
  assert.equal(workingBotReply(log, ""), "");
  assert.equal(workingBotReply(log, "**Want me to go ahead?**"), "**Want me to go ahead?**");
  assert.equal(workingBotReply("Here is the write-up.", ""), "Here is the write-up.");
});
