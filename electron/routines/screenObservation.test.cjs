/**
 * Screen observation: native state first, cheap fingerprints, no vision on noise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateNativeWindowState,
  evaluateScreenFingerprints,
  fingerprintNative,
  NOISE_THRESHOLD,
} = require("./screenObservation.cjs");
const { screenDiffRatio } = require("../../lib/browserScreen.cjs");

test("same fingerprint is unchanged and below any vision threshold", () => {
  const fp = Array(64).fill("8").join(",");
  const out = evaluateScreenFingerprints(fp, fp);
  assert.equal(out.unchanged, true);
  assert.equal(out.meaningful, false);
  assert.equal(out.ratio, 0);
});

test("tiny / noisy cell drift is not a trigger", () => {
  const a = Array(64).fill("8").join(",");
  const b = ["9", ...Array(63).fill("8")].join(",");
  const out = evaluateScreenFingerprints(a, b);
  assert.ok(out.ratio < NOISE_THRESHOLD || out.unchanged === true);
  assert.equal(out.meaningful, false);
});

test("a large perceptual difference is meaningful", () => {
  const a = Array(64).fill("0").join(",");
  const b = Array(64).fill("15").join(",");
  const out = evaluateScreenFingerprints(a, b);
  assert.equal(out.unchanged, false);
  assert.equal(out.meaningful, true);
  assert.equal(screenDiffRatio(a, b), 1);
});

test("native title 'Export Complete' answers a finish condition without pixels", () => {
  const verdict = evaluateNativeWindowState({
    previous: { found: true, title: "Exporting…", appName: "Final Cut Pro" },
    current: { found: true, title: "Export Complete", appName: "Final Cut Pro" },
    condition: { event: "changed", semantic: "export finishes" },
  });
  assert.equal(verdict.decidable, true);
  assert.equal(verdict.matched, true);
});

test("a missing window is unavailable, not a match", () => {
  const verdict = evaluateNativeWindowState({
    previous: { found: true, title: "Export", appName: "Final Cut Pro" },
    current: { found: false, appRunning: false },
    condition: { event: "changed" },
  });
  assert.equal(verdict.status, "target_unavailable");
  assert.equal(verdict.matched, false);
});

test("native identity fingerprint changes when the title changes", () => {
  const a = fingerprintNative({ found: true, appName: "Xcode", title: "Building" });
  const b = fingerprintNative({ found: true, appName: "Xcode", title: "Failed" });
  assert.notEqual(a, b);
});
