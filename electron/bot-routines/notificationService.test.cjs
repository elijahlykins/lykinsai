/**
 * The one notification service. What matters: policies filter here (a
 * routine set to on_failure stays silent on success), identical bursts
 * dedupe, deep links carry identity — never content — and a broken native
 * layer can never break a run.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createNotificationService, shouldNotify } = require("./notificationService.cjs");

function makeService({ supported = true } = {}) {
  const sent = { renderer: [], native: [], opened: [] };
  let nowMs = 1_000_000;
  const service = createNotificationService({
    now: () => nowMs,
    emitToRenderer: (record) => sent.renderer.push(record),
    onOpen: (deepLink) => sent.opened.push(deepLink),
    native: {
      isSupported: () => supported,
      create: (opts) => {
        const handlers = {};
        const n = {
          opts,
          on: (event, fn) => {
            handlers[event] = fn;
          },
          show: () => sent.native.push({ opts, click: () => handlers.click?.() }),
        };
        return n;
      },
    },
  });
  return { service, sent, tick: (ms) => (nowMs += ms) };
}

test("policy filtering lives in the service, not in callers", () => {
  assert.equal(shouldNotify("always", { status: "completed" }), true);
  assert.equal(shouldNotify("on_success", { status: "completed" }), true);
  assert.equal(shouldNotify("on_success", { status: "failed" }), false);
  assert.equal(shouldNotify("on_failure", { status: "failed" }), true);
  assert.equal(shouldNotify("on_failure", { status: "completed" }), false);
  assert.equal(shouldNotify("on_change", { status: "completed", changed: true }), true);
  assert.equal(shouldNotify("on_change", { status: "completed", changed: false }), false);
  assert.equal(shouldNotify("silent", { status: "failed" }), false);
});

test("a suppressed notification reports why and reaches no sink", () => {
  const { service, sent } = makeService();
  const result = service.notify({
    botId: "bot-1",
    title: "Scout: pricing check",
    policy: "on_failure",
    outcome: { status: "completed" },
  });
  assert.equal(result.sent, false);
  assert.equal(result.suppressed, "policy");
  assert.equal(sent.renderer.length, 0);
  assert.equal(sent.native.length, 0);
});

test("identical bursts dedupe inside the window", () => {
  const { service, sent, tick } = makeService();
  const input = { botId: "b", routineId: "r", title: "Scout: pricing" };
  assert.equal(service.notify(input).sent, true);
  assert.equal(service.notify(input).suppressed, "dedupe");
  tick(31 * 1000);
  assert.equal(service.notify(input).sent, true);
  assert.equal(sent.native.length, 2);
});

test("deep links carry identity, bodies are bounded previews", () => {
  const { service, sent } = makeService();
  service.notify({
    botId: "bot-1",
    routineId: "routine-9",
    runId: "rrun-3",
    taskId: "task-7",
    title: "Scout: pricing",
    body: "x".repeat(2000),
  });
  const record = sent.renderer[0];
  assert.deepEqual(record.deepLink, {
    botId: "bot-1",
    routineId: "routine-9",
    runId: "rrun-3",
    taskId: "task-7",
  });
  assert.ok(record.body.length <= 240);
});

test("clicking the native notification routes the deep link", () => {
  const { service, sent } = makeService();
  service.notify({ botId: "bot-1", routineId: "r-1", title: "Scout needs you" });
  sent.native[0].click();
  assert.equal(sent.opened.length, 1);
  assert.equal(sent.opened[0].routineId, "r-1");
});

test("no native support: in-app still gets the record", () => {
  const { service, sent } = makeService({ supported: false });
  service.notify({ botId: "b", title: "Hello" });
  assert.equal(sent.renderer.length, 1);
  assert.equal(sent.native.length, 0);
});

test("recent list is newest-first and bounded; markRead flips the flag", () => {
  const { service, tick } = makeService();
  for (let i = 0; i < 5; i += 1) {
    service.notify({ botId: "b", title: `n${i}` });
    tick(31 * 1000);
  }
  const recent = service.listRecent({ limit: 3 });
  assert.equal(recent.length, 3);
  assert.equal(recent[0].title, "n4");
  assert.equal(service.markRead(recent[0].id), true);
  assert.equal(service.listRecent({ limit: 1 })[0].read, true);
});
