import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOME_CHAT_BAR_SELECTOR,
  HOME_CHAT_HOST_SELECTOR,
  homeChatBarOwnsQueuedFiles,
} from "./homeChatFiles.js";

function docWith(hits) {
  const set = new Set(hits);
  return {
    querySelector(selector) {
      return set.has(selector) ? { selector } : null;
    },
  };
}

describe("homeChatBarOwnsQueuedFiles", () => {
  it("leaves the queue for a visible Home chat bar", () => {
    assert.equal(homeChatBarOwnsQueuedFiles(docWith([HOME_CHAT_BAR_SELECTOR])), true);
  });

  it("leaves the queue when Home is hosting chat even if the bar is covered", () => {
    // Zoomed image/doc windows unmount or cover the rounded bar. The hosted
    // composer is CSS-hidden, so claiming there would attach without a chip.
    assert.equal(homeChatBarOwnsQueuedFiles(docWith([HOME_CHAT_HOST_SELECTOR])), true);
  });

  it("lets a standalone chat page claim files when Home is not in play", () => {
    assert.equal(homeChatBarOwnsQueuedFiles(docWith([])), false);
    assert.equal(homeChatBarOwnsQueuedFiles(null), false);
  });
});
