import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findImagineTurnIndex,
  imagineReferenceAttachments,
  imagineTurnNote,
  imagineTurnUnchanged,
  imagesFromImagineCommit,
  sanitizeImagineTurnForPersist,
  type ImagineThreadCommit,
} from "./imagineThread.ts";

function pendingCommit(over: Partial<ImagineThreadCommit> = {}): ImagineThreadCommit {
  return {
    id: "batch-1",
    prompt: "a red bicycle",
    kind: "generate",
    images: [],
    pending: true,
    slots: [
      { status: "loading" },
      { status: "loading" },
      { status: "loading" },
      { status: "loading" },
    ],
    ...over,
  };
}

describe("imagesFromImagineCommit", () => {
  it("uses slot placeholders so the prompt turn can reserve a 4-up", () => {
    const images = imagesFromImagineCommit(pendingCommit());
    assert.equal(images.length, 4);
    assert.ok(images.every((img) => img.status === "loading" && img.url === ""));
  });

  it("keeps finished slots and still reserves the ones that are loading", () => {
    const images = imagesFromImagineCommit(
      pendingCommit({
        images: [{ url: "https://img/1.png" }],
        slots: [
          { status: "done", url: "https://img/1.png", storagePath: "a/1" },
          { status: "loading" },
          { status: "error", error: "Generation failed" },
          { status: "loading" },
        ],
      }),
    );
    assert.equal(images[0]?.url, "https://img/1.png");
    assert.equal(images[0]?.storagePath, "a/1");
    assert.equal(images[1]?.status, "loading");
    assert.equal(images[2]?.status, "error");
    assert.equal(images[2]?.error, "Generation failed");
  });

  it("falls back to four loading tiles when a pending commit has no slots yet", () => {
    const images = imagesFromImagineCommit({
      id: "b",
      prompt: "x",
      images: [],
      pending: true,
    });
    assert.equal(images.length, 4);
    assert.ok(images.every((img) => img.status === "loading"));
  });
});

describe("imagineTurnNote", () => {
  it("uses a generating note until the batch settles", () => {
    assert.equal(imagineTurnNote(pendingCommit()), "Generating images.");
  });

  it("summarizes a finished batch", () => {
    assert.equal(
      imagineTurnNote({
        id: "b",
        prompt: "x",
        kind: "refine",
        images: [{ url: "a" }, { url: "b" }],
      }),
      "Refined 2 images.",
    );
  });
});

describe("findImagineTurnIndex / imagineTurnUnchanged", () => {
  it("finds a turn by batch id so later slot updates do not append", () => {
    const msgs = [
      { imagine: { batchId: "other" } },
      { imagine: { batchId: "batch-1" } },
    ];
    assert.equal(findImagineTurnIndex(msgs, "batch-1"), 1);
    assert.equal(findImagineTurnIndex(msgs, ""), -1);
  });

  it("skips a no-op upsert so pending commits cannot loop setState", () => {
    const commit = pendingCommit();
    const msg = {
      content: "a red bicycle",
      aiResponse: "Generating images.",
      aiImages: imagesFromImagineCommit(commit),
      imagine: { pending: true },
    };
    assert.equal(imagineTurnUnchanged(msg, commit), true);
    assert.equal(
      imagineTurnUnchanged(msg, pendingCommit({
        slots: [
          { status: "done", url: "https://img/1.png" },
          { status: "loading" },
          { status: "loading" },
          { status: "loading" },
        ],
      })),
      false,
    );
  });
});

describe("sanitizeImagineTurnForPersist", () => {
  it("keeps the prompt but drops empty loading tiles", () => {
    const next = sanitizeImagineTurnForPersist({
      content: "a red bicycle",
      aiResponse: "Generating images.",
      aiImages: imagesFromImagineCommit(pendingCommit()),
      imagine: { pending: true, batchId: "batch-1", kind: "generate" },
    });
    assert.equal(next.imagine?.pending, undefined);
    assert.equal(next.aiImages, undefined);
    assert.equal(next.aiResponse, undefined);
    assert.equal(next.content, "a red bicycle");
  });

  it("keeps images that already landed", () => {
    const next = sanitizeImagineTurnForPersist({
      content: "a red bicycle",
      aiResponse: "Generating images.",
      aiImages: [
        { url: "https://img/1.png", status: "done" },
        { url: "", status: "loading" },
      ],
      imagine: { pending: true, batchId: "batch-1" },
    });
    assert.equal(next.aiImages?.length, 1);
    assert.equal(next.aiImages?.[0]?.url, "https://img/1.png");
    assert.equal(next.aiResponse, "Generated 1 image.");
    assert.equal(next.imagine?.pending, undefined);
  });
});

describe("imagineReferenceAttachments", () => {
  it("turns reference urls into image chips on the prompt bubble", () => {
    const atts = imagineReferenceAttachments(
      pendingCommit({ referenceUrls: ["https://ref/a.png", ""] }),
    );
    assert.equal(atts.length, 1);
    assert.equal(atts[0]?.type, "image");
    assert.equal(atts[0]?.url, "https://ref/a.png");
  });
});
