import test from "node:test";
import assert from "node:assert/strict";
import { attachPromptQueue } from "./promptQueue.js";

test("overlay prompt queue is FIFO and ignores empty captures", () => {
  const el = {
    innerHTML: "",
    hidden: true,
    childNodes: [],
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
  };
  const orig = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === "prompt-queue" ? el : null),
    createElement: (tag) => {
      const node = {
        tagName: String(tag).toUpperCase(),
        className: "",
        title: "",
        hidden: false,
        textContent: "",
        innerHTML: "",
        childNodes: [],
        appendChild(child) {
          this.childNodes.push(child);
          return child;
        },
        addEventListener() {},
        setAttribute() {},
      };
      return node;
    },
  };
  try {
    const submitted = [];
    const queue = attachPromptQueue({
      busy: false,
      reportHeight() {},
      submitQueued(item) {
        submitted.push(item.q);
      },
    });
    assert.equal(queue.enqueue({ q: "", attachments: [] }), false);
    assert.equal(queue.enqueue({ q: "first", attachments: [] }), true);
    assert.equal(queue.enqueue({ q: "second", attachments: [] }), true);
    assert.equal(queue.takeNext().q, "first");
    queue.drain();
    assert.deepEqual(submitted, ["second"]);
    assert.equal(queue.length, 0);
  } finally {
    globalThis.document = orig;
  }
});
