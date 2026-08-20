/**
 * The diagnostics report must be safe to hand over.
 *
 * The traces it reads are not. A browser-agent trace carries the user's own
 * goal, text pulled off the pages they visited, the plan the agent wrote, the
 * skills it chose and the models it called — private to them, and revealing
 * about how the product works. The report exists so that a bug report can carry
 * useful signal without carrying any of that.
 *
 * The redaction test below is the point of this file: it builds a trace stuffed
 * with things that must never escape, generates a report, and asserts none of
 * them appear. It is written as an allow-list check on purpose — a redactor
 * that works by recognising secrets fails the first time a new field is logged.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  recordRuntimeFallback,
  buildDiagnosticsReport,
  summariseTrace,
  LOG_DIR_NAME,
  FALLBACK_FILE,
} = require("./diagnostics.cjs");

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-diag-"));
}

function writeTrace(userDataPath, name, entries) {
  const dir = path.join(userDataPath, LOG_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    entries.map((e) => JSON.stringify(e)).join("\n"),
  );
}

/** Everything in here is a thing that must not reach the report. */
const SECRETS = {
  goal: "email my landlord about the broken heater at 14 Ashgrove",
  planStep: "open the tenancy portal and find the maintenance form",
  skill: "communication",
  model: "gpt-5.6-luna",
  pageText: "Your rent balance is $1,842.00",
  reason: "clicking the maintenance request button in the sidebar",
};

function sensitiveTrace() {
  return [
    { at: "2026-08-19T10:00:00.000Z", event: "task_started", goal: SECRETS.goal },
    {
      at: "2026-08-19T10:00:02.000Z",
      event: "plan_created",
      plan: [SECRETS.planStep],
      skills: [SECRETS.skill],
    },
    {
      at: "2026-08-19T10:00:05.000Z",
      event: "decision",
      round: 1,
      kind: "act",
      reason: SECRETS.reason,
      action: { type: "click", target: "e4", label: "Maintenance" },
      model: SECRETS.model,
    },
    { at: "2026-08-19T10:00:07.000Z", event: "observed", text: SECRETS.pageText },
    { at: "2026-08-19T10:00:08.000Z", event: "verified", success: true },
    {
      at: "2026-08-19T10:00:20.000Z",
      event: "task_finished",
      status: "completed",
      answer: SECRETS.pageText,
    },
  ];
}

test("no trace content reaches the report", () => {
  const userDataPath = tempUserData();
  writeTrace(userDataPath, "task-abc.jsonl", sensitiveTrace());

  const report = buildDiagnosticsReport({ userDataPath, env: { appVersion: "1.0.24" } });

  for (const [field, value] of Object.entries(SECRETS)) {
    assert.ok(!report.includes(value), `report leaked ${field}: ${value}`);
  }
  // Element references are internal addressing and must not survive either.
  assert.doesNotMatch(report, /\be\d+\b/);
});

test("the report still says what happened", () => {
  const userDataPath = tempUserData();
  writeTrace(userDataPath, "task-abc.jsonl", sensitiveTrace());

  const report = buildDiagnosticsReport({ userDataPath, env: { appVersion: "1.0.24" } });

  assert.match(report, /1\.0\.24/);
  assert.match(report, /task-abc\.jsonl/);
  assert.match(report, /status=completed/);
  assert.match(report, /rounds=1/);
  assert.match(report, /act=1/);
  assert.match(report, /verified ok\/fail=1\/0/);
  assert.match(report, /duration=20s/);
});

test("a fallback is recorded with its status and nothing else", () => {
  const userDataPath = tempUserData();
  recordRuntimeFallback({
    userDataPath,
    surface: "browse",
    reason: 'agent model unavailable (404): {"error":"Cannot POST /api/desktop/agent-model"}',
    appVersion: "1.0.24",
  });

  const raw = fs.readFileSync(
    path.join(userDataPath, LOG_DIR_NAME, FALLBACK_FILE),
    "utf8",
  );
  const record = JSON.parse(raw.trim());
  assert.equal(record.surface, "browse");
  assert.equal(record.status, "404");
  assert.equal(record.appVersion, "1.0.24");
  // The message can carry an upstream response body — the status is the whole
  // diagnostic value, so the text itself is never stored.
  assert.ok(!raw.includes("Cannot POST"));
});

test("fallbacks are surfaced in the report, with the version-skew hint", () => {
  const userDataPath = tempUserData();
  recordRuntimeFallback({
    userDataPath,
    surface: "browse",
    reason: "agent model unavailable (404)",
    appVersion: "1.0.24",
  });

  const report = buildDiagnosticsReport({ userDataPath });
  assert.match(report, /Legacy fallbacks, all time:\s+1/);
  assert.match(report, /status=404/);
  assert.match(report, /newer than the server/);
});

test("no traces is reported as a finding, not as an empty section", () => {
  const report = buildDiagnosticsReport({ userDataPath: tempUserData() });
  assert.match(report, /Traces on disk: 0/);
  assert.match(report, /fell back/);
});

test("recording a fallback never throws, whatever it is handed", () => {
  assert.doesNotThrow(() => recordRuntimeFallback({}));
  assert.doesNotThrow(() => recordRuntimeFallback({ userDataPath: "/nope/not/a/dir\0bad" }));
  assert.doesNotThrow(() => recordRuntimeFallback());
});

test("a report over unreadable or absent directories still returns text", () => {
  const report = buildDiagnosticsReport({ userDataPath: path.join(os.tmpdir(), "lykn-missing-xyz") });
  assert.match(report, /LYKN diagnostics/);
});

test("trace summarising counts decisions by kind and tallies recoveries", () => {
  const summary = summariseTrace(
    [
      { at: "2026-08-19T10:00:00.000Z", event: "decision", round: 1, kind: "act" },
      { at: "2026-08-19T10:00:01.000Z", event: "decision", round: 2, kind: "act" },
      { at: "2026-08-19T10:00:02.000Z", event: "recovery" },
      { at: "2026-08-19T10:00:03.000Z", event: "replanning" },
      { at: "2026-08-19T10:00:04.000Z", event: "decision", round: 3, kind: "finish" },
      { at: "2026-08-19T10:00:05.000Z", event: "verified", success: false },
      { at: "2026-08-19T10:00:06.000Z", event: "task_finished", status: "failed" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  assert.equal(summary.decisions.act, 2);
  assert.equal(summary.decisions.finish, 1);
  assert.equal(summary.rounds, 3);
  assert.equal(summary.recoveries, 1);
  assert.equal(summary.replans, 1);
  assert.equal(summary.verifiedFail, 1);
  assert.equal(summary.status, "failed");
});

test("a corrupt trace line is skipped rather than failing the report", () => {
  const summary = summariseTrace('{"event":"recovery"}\nnot json at all\n{"event":"recovery"}');
  assert.equal(summary.recoveries, 2);
});
