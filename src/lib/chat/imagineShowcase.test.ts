import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGINE_USED_KEY,
  hasUsedImagine,
  inferImagineUsedFromHistory,
  markImagineUsed,
  shouldShowImagineShowcase,
  snapshotShowsImagineUse,
  type StorageLike,
} from "./imagineShowcase.ts";

function memoryStore(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    get length() {
      return data.size;
    },
  };
}

describe("snapshotShowsImagineUse", () => {
  it("is false for empty or unrelated snapshots", () => {
    assert.equal(snapshotShowsImagineUse(null), false);
    assert.equal(snapshotShowsImagineUse({}), false);
    assert.equal(snapshotShowsImagineUse({ studioMode: "build" }), false);
    assert.equal(snapshotShowsImagineUse({ chatMessages: [{ content: "hi" }] }), false);
  });

  it("is true when the chat is tagged Imagine or holds generated images", () => {
    assert.equal(snapshotShowsImagineUse({ studioMode: "imagine" }), true);
    assert.equal(
      snapshotShowsImagineUse({ chatMessages: [{ aiImages: [{ url: "x.png" }] }] }),
      true,
    );
    assert.equal(
      snapshotShowsImagineUse({ chatMessages: [{ imagine: { kind: "generate" } }] }),
      true,
    );
  });
});

describe("imagine showcase first-use flag", () => {
  let store: StorageLike;

  beforeEach(() => {
    store = memoryStore();
  });

  it("shows the collage until Imagine has been used", () => {
    assert.equal(shouldShowImagineShowcase(store), true);
    markImagineUsed(store);
    assert.equal(store.getItem(IMAGINE_USED_KEY), "1");
    assert.equal(hasUsedImagine(store), true);
    assert.equal(shouldShowImagineShowcase(store), false);
  });

  it("hides the collage when an older chat already used Imagine", () => {
    store.setItem(
      "lyknchat_chat_abc",
      JSON.stringify({ chatMessages: [{ aiImages: [{ url: "x.png" }] }] }),
    );
    assert.equal(inferImagineUsedFromHistory(store), true);
    assert.equal(shouldShowImagineShowcase(store), false);
    assert.equal(store.getItem(IMAGINE_USED_KEY), "1");
  });

  it("ignores chats that never generated an image", () => {
    store.setItem(
      "lyknchat_chat_abc",
      JSON.stringify({ studioMode: "research", chatMessages: [{ content: "notes" }] }),
    );
    assert.equal(inferImagineUsedFromHistory(store), false);
    assert.equal(shouldShowImagineShowcase(store), true);
  });
});
