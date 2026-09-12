"use strict";

/**
 * End-to-end: a routine occurrence runs through TaskRuntime -> AgentExecutor
 * -> agent harness. The scripted decide rounds drive the capability, the
 * capability streams, and delivery closes the run with the report riding the
 * task as a document deliverable. If decide cannot run, AgentExecutor
 * degrades to the capability stream inside the same Task. There is no
 * host-level kill-switch path around AgentExecutor.
 *
 * Run: node --test electron/agentHarnessIntegration.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createAgentRuntime } = require("./agentRuntime.cjs");

// Stage-aware model stub: route → research verdict, decide → scripted
// harness decisions, verify → pass. Bodies are kept for prompt assertions.
let server;
let apiBase = "";
let decideBodies = [];
let decideScript = [];
let routeVerdict = "research";
let failDecides = false;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/api/desktop/agent-model")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const send = (json) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, json }));
      };
      if (body.stage === "route") return send({ tool: routeVerdict, reason: "test" });
      if (body.stage === "verify") return send({ success: true, evidence: "looks done", next: "continue" });
      if (body.stage === "decide") {
        if (failDecides) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end("{}");
        }
        decideBodies.push(body);
        const next = decideScript.shift();
        if (next) return send(next);
        return send({ kind: "deliver", answer: "Out of script." });
      }
      return send({});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

function newRuntime(overrides = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-agent-harness-"));
  return createAgentRuntime({
    userDataPath,
    apiBase,
    getAuthToken: async () => "test-token",
    readStreamResponse: async () => "# Report\nSourced findings about espresso machines…",
    emit: () => {},
    ensureBrowserWindow: () => {},
    destroyBrowserWindow: () => {},
    showBrowserWindow: () => {},
    hideBrowserWindow: () => {},
    hideAllBrowserWindows: () => {},
    browserWindowExists: () => false,
    getBrowserWebContents: () => null,
    isContentProtectionEnabled: () => false,
    openStageArtifact: () => {},
    destroyOwnedArtifactTabs: () => {},
    focusOverlayComposer: () => {},
    notifyAgentFinished: () => {},
    ...overrides,
  });
}

const ROUTINE = {
  id: "routine-espresso",
  name: "Espresso research",
  instructions: "research the best espresso machines under $500 and give me a report",
  trigger: { type: "schedule", schedule: { kind: "daily", time: "08:00" } },
  capabilities: ["reply", "research_report"],
  approvalPolicy: "standing_authorization",
};

test("a routine occurrence runs the harness: doc streamed, report becomes a document card", async (t) => {
  decideBodies = [];
  decideScript = [
    {
      kind: "use_tool",
      tool: "research_report",
      instruction: "deep report on espresso machines under $500",
      narration: "Digging into the machines now.",
    },
    {
      kind: "deliver",
      answer: "Report's done — three machines stood out. It's in the document above.",
    },
  ];
  t.after(() => {
    decideScript = [];
  });
  const taskEvents = [];
  const runtime = newRuntime({
    emit: (channel, payload) => {
      if (channel === "lykn:task-event") taskEvents.push(payload);
    },
  });
  const out = await runtime.runRoutineOccurrence({ routine: ROUTINE, runId: "rrun-1" });
  assert.equal(out.status, "completed");
  // The deliver close is the outcome; the report itself rides the task as a card.
  assert.match(String(out.output || ""), /three machines stood out/i);
  assert.equal(decideBodies.length, 2, "report round, then the deliver close");
  const system = String(decideBodies[0].system || "");
  // The generalized identity lives in the decide system prompt — every round.
  assert.match(system, /You are LYKN, working a task for your user/);
  assert.match(system, /# Tool Index/);
  // The completion event carries the report as a standalone HTML document —
  // that is what the chat renders as the persistent card.
  const completed = taskEvents.find((e) => e?.type === "task_completed");
  assert.ok(completed, "task_completed event reached the renderer channel");
  assert.equal(completed.detail.deliverables?.length, 1);
  assert.equal(completed.detail.deliverables[0].kind, "html");
  assert.match(completed.detail.deliverables[0].html, /Sourced findings about espresso machines/);
});

test("when the harness cannot decide at all, the occurrence still degrades inside the same Task", async (t) => {
  failDecides = true;
  t.after(() => {
    failDecides = false;
  });
  const runtime = newRuntime();
  const out = await runtime.runRoutineOccurrence({ routine: ROUTINE, runId: "rrun-2" });
  assert.equal(out.status, "completed", "occurrence still completes");
  // The in-executor fallback streams the capability directly - the report text arrives.
  assert.match(String(out.output || ""), /espresso/i);
});
