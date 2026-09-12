/**
 * Browser observation: durable targets, fingerprints, conditions, no model.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSnapshot } = require("../browser-agent/browser/snapshot.cjs");
const {
  isEphemeralRef,
  sanitizeDurableTarget,
  compactObservation,
  evaluateBrowserCondition,
  urlsMatch,
  looksLoggedOut,
  originOf,
} = require("./browserObservation.cjs");
const { normalizeTrigger } = require("./triggers.cjs");

function snap(items, extra = {}) {
  return buildSnapshot({
    url: extra.url || "https://render.com/deploy/123",
    title: extra.title || "Deploy",
    catalog: items,
    text: extra.text || items.map((i) => i.label).join(" "),
    generation: extra.generation || 7,
  });
}

test("generation-scoped refs are ephemeral and refused as durable targets", () => {
  assert.equal(isEphemeralRef("g42:17"), true);
  assert.equal(isEphemeralRef("role:button|Publish"), false);
  assert.throws(() => sanitizeDurableTarget({ loc: "g42:17" }), /generation-scoped/);
  assert.throws(
    () => normalizeTrigger({ type: "browser", url: "https://x.test", target: { ref: "g9:1" } }),
    /generation-scoped/,
  );
});

test("a durable role+name target survives a new generation; the live ref changes", () => {
  const item = { uid: 4, tag: "button", role: "button", label: "Publish", disabled: true };
  const first = compactObservation(snap([item], { generation: 7 }), {
    target: { kind: "role", role: "button", name: "Publish" },
  });
  const second = compactObservation(snap([item], { generation: 8 }), {
    target: { kind: "role", role: "button", name: "Publish" },
  });
  assert.equal(first.target.found, true);
  assert.equal(second.target.found, true);
  assert.match(first.ref, /^g7:/);
  assert.match(second.ref, /^g8:/);
  assert.notEqual(first.ref, second.ref);
  assert.equal(first.target.loc, second.target.loc);
});

test("unchanged targeted state yields the same fingerprint", () => {
  const item = { uid: 1, tag: "span", role: "status", label: "Building" };
  const a = compactObservation(snap([item]), { target: { kind: "text", text: "Building" } });
  const b = compactObservation(snap([item]), { target: { kind: "text", text: "Building" } });
  assert.equal(a.fingerprint, b.fingerprint);
});

test("text change, enabled change, and URL change all alter the fingerprint", () => {
  const building = compactObservation(snap([{ uid: 1, tag: "span", role: "status", label: "Building" }]), {
    target: { kind: "text", text: "Building" },
  });
  const failed = compactObservation(snap([{ uid: 1, tag: "span", role: "status", label: "Failed" }]), {
    target: { kind: "text", text: "Failed" },
  });
  assert.notEqual(building.fingerprint, failed.fingerprint);

  const off = compactObservation(snap([{ uid: 2, tag: "button", role: "button", label: "Go", disabled: true }]), {
    target: { kind: "role", role: "button", name: "Go" },
  });
  const on = compactObservation(snap([{ uid: 2, tag: "button", role: "button", label: "Go", disabled: false }]), {
    target: { kind: "role", role: "button", name: "Go" },
  });
  assert.equal(off.target.disabled, true);
  assert.equal(on.target.disabled, false);
  assert.notEqual(off.fingerprint, on.fingerprint);

  const here = compactObservation(snap([], { url: "https://a.test/x" }), { target: { kind: "page" } });
  const there = compactObservation(snap([], { url: "https://b.test/x" }), { target: { kind: "page" } });
  assert.notEqual(here.fingerprint, there.fingerprint);
});

test("equals / enabled conditions are deterministic", () => {
  const prev = compactObservation(snap([{ uid: 1, tag: "span", role: "status", label: "Building" }]), {
    target: { kind: "text", text: "Building" },
  });
  const next = compactObservation(snap([{ uid: 1, tag: "span", role: "status", label: "Failed" }]), {
    target: { kind: "text", text: "Failed" },
  });
  const hit = evaluateBrowserCondition({
    previous: prev,
    current: next,
    condition: { event: "equals", value: "Failed" },
  });
  assert.equal(hit.decidable, true);
  assert.equal(hit.matched, true);

  const still = evaluateBrowserCondition({
    previous: next,
    current: next,
    condition: { event: "equals", value: "Failed" },
  });
  assert.equal(still.matched, false);

  const disabled = compactObservation(
    snap([{ uid: 2, tag: "button", role: "button", label: "Publish", disabled: true }]),
    { target: { kind: "role", role: "button", name: "Publish" } },
  );
  const enabled = compactObservation(
    snap([{ uid: 2, tag: "button", role: "button", label: "Publish", disabled: false }]),
    { target: { kind: "role", role: "button", name: "Publish" } },
  );
  const became = evaluateBrowserCondition({
    previous: disabled,
    current: enabled,
    condition: { event: "enabled" },
  });
  assert.equal(became.matched, true);
});

test("urlsMatch does not treat a different origin as the same page", () => {
  assert.equal(urlsMatch("https://render.com/deploy/123", "https://render.com/deploy/123", "https://render.com"), true);
  assert.equal(urlsMatch("https://evil.test/deploy/123", "https://render.com/deploy/123", "https://render.com"), false);
  assert.equal(originOf("https://render.com/deploy/123"), "https://render.com");
});

test("a login URL on another origin is logged out, not a replacement page to watch", () => {
  assert.equal(
    looksLoggedOut("https://accounts.google.com/signin", "Sign in", "https://render.com"),
    true,
  );
  assert.equal(looksLoggedOut("https://render.com/deploy/123", "Deploy", "https://render.com"), false);
});

test("persisted browser triggers never contain a generation ref", () => {
  const trigger = normalizeTrigger({
    type: "browser",
    url: "https://shop.test/price",
    target: { kind: "role", role: "status", name: "Price" },
    condition: { event: "changed" },
  });
  assert.equal(JSON.stringify(trigger).includes("g"), false || !/g\d+:/.test(JSON.stringify(trigger)));
  assert.doesNotMatch(JSON.stringify(trigger), /g\d+:/);
});
