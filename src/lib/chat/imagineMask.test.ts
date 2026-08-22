import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRUSH_SIZE_DEFAULT,
  BRUSH_SIZE_MAX,
  BRUSH_SIZE_MIN,
  brushPx,
  buildEditPrompt,
  classifyStroke,
  clampBrushSize,
  finalizeClickPath,
  hasMaskInk,
  isClosedLasso,
  isNearPoint,
  pathLength,
  snapThreshold,
  type MaskStroke,
} from "./imagineMask.ts";

describe("pathLength", () => {
  it("sums segment lengths", () => {
    assert.equal(pathLength([{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.4 }]), 0.7);
  });
});

describe("isClosedLasso", () => {
  it("fills a loop that returns to its start", () => {
    const box: { x: number; y: number }[] = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
      { x: 0.21, y: 0.22 },
    ];
    assert.equal(isClosedLasso(box), true);
  });

  it("does not fill a short open scribble", () => {
    assert.equal(
      isClosedLasso([
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.12 },
        { x: 0.3, y: 0.11 },
      ]),
      false,
    );
  });
});

describe("classifyStroke", () => {
  it("drops a tap", () => {
    assert.equal(classifyStroke([{ x: 0.5, y: 0.5 }]), null);
    assert.equal(
      classifyStroke([
        { x: 0.5, y: 0.5 },
        { x: 0.501, y: 0.5 },
      ]),
      null,
    );
  });

  it("keeps an open brush stroke", () => {
    const stroke = classifyStroke([
      { x: 0.1, y: 0.5 },
      { x: 0.3, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.7, y: 0.5 },
    ]);
    assert.deepEqual(stroke, { closed: false });
  });
});

describe("hasMaskInk", () => {
  it("is false until a real stroke lands", () => {
    assert.equal(hasMaskInk([]), false);
  });

  it("counts a placed dot as ink", () => {
    const stroke: MaskStroke = {
      id: "a",
      points: [{ x: 0.4, y: 0.4 }],
      closed: false,
      width: BRUSH_SIZE_DEFAULT,
    };
    assert.equal(hasMaskInk([stroke]), true);
  });
});

describe("brush size", () => {
  it("clamps to the slider range", () => {
    assert.equal(clampBrushSize(0), BRUSH_SIZE_MIN);
    assert.equal(clampBrushSize(1), BRUSH_SIZE_MAX);
    assert.equal(clampBrushSize(Number.NaN), BRUSH_SIZE_DEFAULT);
  });

  it("scales pixel width with the image", () => {
    assert.equal(brushPx(0.05, 1000, 800), 40);
  });
});

describe("finalizeClickPath", () => {
  it("keeps a single dot as an open stamp", () => {
    assert.deepEqual(finalizeClickPath([{ x: 0.5, y: 0.5 }], BRUSH_SIZE_DEFAULT), { closed: false });
  });

  it("closes when the last click snaps back to the first", () => {
    const pts = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.21, y: 0.21 },
    ];
    assert.equal(finalizeClickPath(pts, BRUSH_SIZE_DEFAULT)?.closed, true);
    assert.equal(isNearPoint(pts[0], pts[3], snapThreshold(BRUSH_SIZE_DEFAULT)), true);
  });
});

describe("buildEditPrompt", () => {
  it("leads with the edit instruction and the user's notes", () => {
    const out = buildEditPrompt({
      concept: "a red bicycle in a meadow",
      notes: "make the frame chrome",
      hasMask: true,
    });
    assert.match(out, /^EDIT THE REFERENCE IMAGE/);
    assert.match(out, /WHITE pixels mark the region/);
    assert.match(out, /User direction \(highest priority\):\nmake the frame chrome/);
    assert.match(out, /Original concept[\s\S]*a red bicycle in a meadow/);
  });

  it("omits the mask clause when the user did not outline anything", () => {
    const out = buildEditPrompt({
      concept: "portrait",
      notes: "warmer light",
      hasMask: false,
    });
    assert.doesNotMatch(out, /mask image/);
    assert.match(out, /warmer light/);
  });
});
