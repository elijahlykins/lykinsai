import test from "node:test";
import assert from "node:assert/strict";
import { paintPausedAnswer, pauseOverlayTurn } from "./workPause.js";

test("a thinking turn paints Paused and keeps the queue", () => {
  const calls = [];
  const currentAnswerEl = {};
  const ok = pauseOverlayTurn({
    busy: true,
    answerStillWorking: true,
    currentHasText: false,
    currentAnswerEl,
    updateAnswer: (text) => calls.push(["answer", text]),
    setBusy: (on, opts) => calls.push(["busy", on, opts]),
    stopStatusRotation: () => calls.push(["stopRotate"]),
    clearBuildingUnder: () => calls.push(["clear"]),
    thinkingTimeline: { reset: () => calls.push(["reset"]) },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ["stopRotate"],
    ["reset"],
    ["clear"],
    ["answer", "Paused."],
    ["busy", false, { keepQueue: true }],
  ]);
});

test("a partial answer is left in place", () => {
  const seen = [];
  paintPausedAnswer({
    currentHasText: true,
    currentAnswerEl: {},
    updateAnswer: (text) => seen.push(text),
  });
  assert.deepEqual(seen, []);
});

test("idle overlay does not pause", () => {
  assert.equal(
    pauseOverlayTurn({
      busy: false,
      answerStillWorking: false,
      currentHasText: false,
      currentAnswerEl: {},
      updateAnswer: () => {},
      setBusy: () => {},
    }),
    false,
  );
});
