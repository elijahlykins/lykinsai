/**
 * Deterministic natural-language routine parsing. What matters: the same
 * sentence always yields the same trigger, common schedule/watch phrasings
 * resolve correctly, structured JSON wins when the model provides it, and
 * ambiguity refuses instead of guessing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTriggerFromText,
  parseClockTime,
  resolveRoutineSpec,
  compileRoutineCapabilities,
} = require("./nlRoutine.cjs");

test("clock phrases resolve to HH:MM", () => {
  assert.equal(parseClockTime("8"), "8:00");
  assert.equal(parseClockTime("8am"), "8:00");
  assert.equal(parseClockTime("8:30 pm"), "20:30");
  assert.equal(parseClockTime("12am"), "0:00");
  assert.equal(parseClockTime("12pm"), "12:00");
  assert.equal(parseClockTime("20:15"), "20:15");
  assert.equal(parseClockTime("25:00"), null);
});

test("schedule phrasings", () => {
  assert.deepEqual(parseTriggerFromText("every weekday at 8am check pricing"), {
    type: "schedule",
    schedule: { kind: "weekdays", time: "8:00" },
  });
  assert.deepEqual(parseTriggerFromText("every day at 7:30pm"), {
    type: "schedule",
    schedule: { kind: "daily", time: "19:30" },
  });
  assert.deepEqual(parseTriggerFromText("every morning, summarize my inbox"), {
    type: "schedule",
    schedule: { kind: "daily", time: "08:00" },
  });
  assert.deepEqual(parseTriggerFromText("every monday and friday at 9"), {
    type: "schedule",
    schedule: { kind: "weekly", time: "9:00", days: [1, 5] },
  });
  assert.deepEqual(parseTriggerFromText("every 15 minutes check the queue"), {
    type: "schedule",
    schedule: { kind: "interval", everyMs: 15 * 60 * 1000 },
  });
  assert.deepEqual(parseTriggerFromText("every 2 hours"), {
    type: "schedule",
    schedule: { kind: "interval", everyMs: 2 * 60 * 60 * 1000 },
  });
});

test("watch-folder phrasings", () => {
  assert.deepEqual(parseTriggerFromText("when a new pdf appears in ~/Downloads summarize it"), {
    type: "filesystem",
    path: "~/Downloads",
    event: "created",
    pattern: "*.pdf",
  });
  assert.deepEqual(parseTriggerFromText("whenever a csv lands in my downloads folder"), {
    type: "filesystem",
    path: "~/Downloads",
    event: "created",
    pattern: "*.csv",
  });
  const changed = parseTriggerFromText("when /Users/me/data/report.csv is modified, re-run the summary");
  assert.equal(changed.type, "filesystem");
  assert.equal(changed.event, "changed");
});

test("one-time 'tomorrow' resolves to a once schedule", () => {
  const trigger = parseTriggerFromText("tomorrow at 3pm remind me about the invoice");
  assert.equal(trigger.type, "schedule");
  assert.equal(trigger.schedule.kind, "once");
  const at = new Date(trigger.schedule.at);
  assert.equal(at.getHours(), 15);
});

test("ambiguity refuses instead of guessing", () => {
  assert.equal(parseTriggerFromText("keep an eye on things"), null);
  const resolved = resolveRoutineSpec("watch stuff for me please");
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /could_not_parse_trigger/);
});

test("structured JSON from the model wins over prose parsing", () => {
  const resolved = resolveRoutineSpec(
    JSON.stringify({
      name: "Nightly tests",
      instructions: "Run the test suite and report failures.",
      trigger: { type: "schedule", schedule: { kind: "daily", time: "22:00" } },
      notificationPolicy: "on_failure",
    }),
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.spec.name, "Nightly tests");
  assert.equal(resolved.spec.trigger.schedule.time, "22:00");
  assert.equal(resolved.spec.notificationPolicy, "on_failure");
});

test("capability derivation is conservative and read-shaped by default", () => {
  const research = compileRoutineCapabilities("Check competitor pricing and summarize changes.", {
    type: "schedule",
  });
  assert.ok(research.includes("reply"));
  assert.ok(research.includes("research_report"));
  assert.ok(!research.some((c) => c.startsWith("local.shell")));

  const watcher = compileRoutineCapabilities("Summarize new PDFs.", {
    type: "filesystem",
    path: "~/Downloads",
  });
  assert.ok(watcher.includes("files.read"));
  assert.ok(!watcher.includes("local.shell.execute"));

  const fixer = compileRoutineCapabilities(
    "Run the tests after every build and fix simple failures.",
    { type: "process", name: "npm run build" },
  );
  assert.ok(fixer.includes("local.shell.execute"));
  assert.ok(fixer.includes("files.write"));

  const explicit = compileRoutineCapabilities("anything", { type: "manual" }, { explicit: ["reply"] });
  assert.deepEqual(explicit, ["reply"]);
});

test("watch this page with a bound tab becomes a browser trigger", () => {
  const trigger = parseTriggerFromText("Watch this page and tell me when the price changes.", {
    browserContext: { url: "https://shop.test/sku/1", title: "Acme — $49", appName: "LYKN" },
  });
  assert.equal(trigger.type, "browser");
  assert.equal(trigger.url, "https://shop.test/sku/1");
  assert.equal(trigger.notifyOnly, true);
  assert.equal(trigger.condition.event, "changed");
});

test("watch this page without a tab refuses instead of picking a random one", () => {
  const resolved = resolveRoutineSpec("Watch this page and tell me when the status changes.");
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /which page/i);
});

test("tell me when this button becomes enabled binds a role target", () => {
  const trigger = parseTriggerFromText("Tell me when this button becomes enabled.", {
    browserContext: { url: "https://app.test/deploy" },
  });
  assert.equal(trigger.type, "browser");
  assert.equal(trigger.condition.event, "enabled");
  assert.equal(trigger.target.role, "button");
  assert.equal(trigger.notifyOnly, true);
});

test("watch this window with an explicit app becomes a screen trigger", () => {
  const trigger = parseTriggerFromText("Watch this window and tell me when the export finishes.", {
    windowContext: { appName: "Final Cut Pro", title: "Export" },
  });
  assert.equal(trigger.type, "screen");
  assert.equal(trigger.appName, "Final Cut Pro");
  assert.equal(trigger.notifyOnly, true);
  assert.match(String(trigger.condition.semantic), /export/i);
});

test("watch this window without a target refuses instead of picking a random window", () => {
  const resolved = resolveRoutineSpec("Notify me if this screen changes.");
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /which window/i);
});

test("act-on-change browser routines gain interact caps; notify-only stays read", () => {
  const notify = compileRoutineCapabilities("Tell me when this page changes.", {
    type: "browser",
    url: "https://x.test",
    notifyOnly: true,
  });
  assert.ok(notify.includes("browser.read"));
  assert.ok(!notify.includes("browser.interact"));

  const act = compileRoutineCapabilities("Watch this deployment. If it fails, inspect it.", {
    type: "browser",
    url: "https://render.com/deploy/1",
    notifyOnly: false,
  });
  assert.ok(act.includes("browser.interact"));
});
