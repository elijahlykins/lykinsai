import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { imagineDoneGallery, stepImagineGallery } from "./imagineGallery.ts";

const batches = [
  {
    id: "a",
    slots: [
      { status: "done", url: "a0" },
      { status: "loading" },
      { status: "done", url: "a2" },
      { status: "error" },
    ],
  },
  {
    id: "b",
    slots: [
      { status: "done", url: "b0" },
      { status: "done", url: "b1" },
    ],
  },
];

describe("imagineDoneGallery", () => {
  it("flattens finished images across every batch in reading order", () => {
    assert.deepEqual(imagineDoneGallery(batches), [
      { batchId: "a", index: 0 },
      { batchId: "a", index: 2 },
      { batchId: "b", index: 0 },
      { batchId: "b", index: 1 },
    ]);
  });
});

describe("stepImagineGallery", () => {
  const gallery = imagineDoneGallery(batches);

  it("walks into the next batch instead of wrapping inside the current 4-up", () => {
    assert.deepEqual(stepImagineGallery(gallery, { batchId: "a", index: 2 }, 1), {
      batchId: "b",
      index: 0,
    });
  });

  it("wraps from the last image back to the first", () => {
    assert.deepEqual(stepImagineGallery(gallery, { batchId: "b", index: 1 }, 1), {
      batchId: "a",
      index: 0,
    });
  });

  it("steps backward across batches", () => {
    assert.deepEqual(stepImagineGallery(gallery, { batchId: "b", index: 0 }, -1), {
      batchId: "a",
      index: 2,
    });
  });

  it("needs at least two finished images", () => {
    assert.equal(stepImagineGallery([{ batchId: "a", index: 0 }], { batchId: "a", index: 0 }, 1), null);
  });
});
