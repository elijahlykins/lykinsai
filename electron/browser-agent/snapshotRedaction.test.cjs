"use strict";

/**
 * Security regression — Fix 4: sensitive-field value redaction.
 *
 * The DOM catalog collects `el.value` for every input, including password,
 * OTP and card fields. This asserts that when that catalog becomes the
 * model-facing snapshot, the FIELD is still described (so the agent knows it
 * exists) but its VALUE never appears — not in the formatted snapshot text and
 * not on the retained `raw` copy.
 *
 * Run: node --test electron/browser-agent/snapshotRedaction.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSnapshot,
  formatSnapshotForModel,
} = require("./browser/snapshot.cjs");

const SECRETS = {
  password: "hunter2SuperSecret",
  otp: "483920",
  card: "4111 1111 1111 1111",
  cvv: "319",
  newPass: "N3wP@ssw0rd!",
};

// A catalog shaped exactly like ownedBrowserAct's COLLECT_INTERACTABLES_JS
// output, mixing sensitive fields with an ordinary one.
function sensitiveCatalog() {
  return [
    { uid: "1", tag: "input", type: "password", label: "Password", value: SECRETS.password },
    { uid: "2", tag: "input", type: "text", autocomplete: "one-time-code", label: "Enter code", value: SECRETS.otp },
    { uid: "3", tag: "input", type: "text", name: "cardnumber", label: "Card number", value: SECRETS.card },
    { uid: "4", tag: "input", type: "text", label: "CVV", value: SECRETS.cvv },
    { uid: "5", tag: "input", type: "password", autocomplete: "new-password", label: "New password", value: SECRETS.newPass },
    { uid: "6", tag: "input", type: "text", label: "Search", value: "kittens" },
  ];
}

test("Fix4: secret field values never reach the model-facing snapshot text", () => {
  const snap = buildSnapshot({ url: "https://bank.test/login", title: "Login", catalog: sensitiveCatalog() });
  const text = formatSnapshotForModel(snap);
  for (const [k, v] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(v), `secret ${k} ("${v}") must not appear in snapshot text`);
  }
  // The ordinary field's value is still surfaced — redaction is targeted.
  assert.ok(text.includes("kittens"), "non-sensitive values remain visible");
});

test("Fix4: the model still learns the sensitive fields EXIST", () => {
  const snap = buildSnapshot({ url: "https://bank.test/login", title: "Login", catalog: sensitiveCatalog() });
  const text = formatSnapshotForModel(snap);
  assert.ok(text.includes("Password"), "password field is still listed by label");
  assert.ok(text.includes("Card number"), "card field is still listed");
  assert.ok(/sensitive — value hidden/i.test(text), "redaction is shown explicitly");
});

test("Fix4: the retained raw element carries no secret value either", () => {
  const snap = buildSnapshot({ url: "https://bank.test/login", title: "Login", catalog: sensitiveCatalog() });
  for (const el of snap.elements) {
    if (el.sensitive) {
      assert.equal(el.value, "", "el.value is cleared for sensitive fields");
      assert.equal(el.raw?.value, "", "raw.value is scrubbed so downstream logs cannot recover it");
    }
  }
  const serialized = JSON.stringify(snap.elements);
  for (const v of Object.values(SECRETS)) {
    assert.ok(!serialized.includes(v), "no secret survives anywhere on the snapshot elements");
  }
});

test("Fix4: a card-shaped value is redacted even without a sensitive label", () => {
  const snap = buildSnapshot({
    url: "https://x.test",
    title: "x",
    catalog: [{ uid: "9", tag: "input", type: "text", label: "Reference", value: "4111 1111 1111 1111" }],
  });
  const text = formatSnapshotForModel(snap);
  assert.ok(!text.includes("4111 1111 1111 1111"), "value-shape detection catches card numbers");
});

test("Fix4: ordinary fields are unaffected (no false positives)", () => {
  const snap = buildSnapshot({
    url: "https://x.test",
    title: "x",
    catalog: [
      { uid: "a", tag: "input", type: "text", label: "First name", value: "Ada" },
      { uid: "b", tag: "input", type: "email", label: "Email", value: "ada@example.com" },
    ],
  });
  const text = formatSnapshotForModel(snap);
  assert.ok(text.includes("Ada"));
  assert.ok(text.includes("ada@example.com"));
  assert.ok(!/sensitive — value hidden/i.test(text));
});
