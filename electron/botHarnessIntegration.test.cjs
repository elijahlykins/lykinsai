"use strict";

/**
 * End-to-end: a task-shaped Bot turn runs through TaskRuntime -> BotExecutor
 * -> Bot harness. The persona rides the decide call's system prompt, the
 * routed tool's doc is pre-loaded, the capability streams, and delivery
 * closes the turn. If decide cannot run, BotExecutor degrades to the
 * capability stream inside the same Task. There is no host-level kill-switch
 * path around BotExecutor.
 *
 * Run: node --test electron/botHarnessIntegration.test.cjs
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
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-bot-harness-"));
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

function newBot(runtime) {
  const res = runtime.createAgent({
    title: "Scout",
    silent: true,
    activate: false,
    headless: true,
    bot: { name: "Scout", role: "Research Analyst", persona: "Blunt, fast, loves tables." },
  });
  assert.ok(res?.ok && res.agentId, "headless bot agent created");
  return res.agentId;
}

test("a routed research task runs the harness: persona in system, doc preloaded, report becomes a document card", async (t) => {
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
  const id = newBot(runtime);
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\nresearch the best espresso machines under $500 and give me a report",
  });
  assert.ok(out?.ok);
  // The deliver close is the reply; the report itself rides the task as a card.
  assert.match(String(out.text || ""), /three machines stood out/i);
  assert.equal(decideBodies.length, 2, "report round, then the deliver close");
  const system = String(decideBodies[0].system || "");
  // The persona lives in the decide system prompt — every turn, not just the first brief.
  assert.match(system, /Your name is Scout, and you work as their Research Analyst/);
  assert.match(system, /Blunt, fast, loves tables\./);
  assert.match(system, /# Tool Index/);
  // Routing's verdict preloaded the tool's full doc into round one.
  assert.match(String(decideBodies[0].user || ""), /# Tool: research_report/);
  // The completion event carries the report as a standalone HTML document —
  // that is what the chat renders as the persistent card.
  const completed = taskEvents.find((e) => e?.type === "task_completed");
  assert.ok(completed, "task_completed event reached the renderer channel");
  assert.equal(completed.detail.deliverables?.length, 1);
  assert.equal(completed.detail.deliverables[0].kind, "html");
  assert.match(completed.detail.deliverables[0].html, /Sourced findings about espresso machines/);
});

test("bot identity passed on send() refreshes an agent that predates the profile", async (t) => {
  decideBodies = [];
  decideScript = [
    { kind: "use_tool", tool: "research_report", instruction: "report", narration: "…" },
  ];
  t.after(() => {
    decideScript = [];
  });
  const runtime = newRuntime();
  // Created WITHOUT a profile — the way every pre-existing Bot agent looks.
  const res = runtime.createAgent({ title: "Scout", silent: true, activate: false, headless: true });
  const out = await runtime.send(res.agentId, {
    text: "research the best espresso machines under $500 and give me a report",
    bot: { name: "Pepper", role: "Analyst", persona: "Cheerful." },
  });
  assert.ok(out?.ok);
  assert.match(String(decideBodies[0]?.system || ""), /Your name is Pepper/);
});

test("when the harness cannot decide at all, BotExecutor degrades inside the same Task", async (t) => {
  failDecides = true;
  t.after(() => {
    failDecides = false;
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\nresearch the best espresso machines under $500 and give me a report",
  });
  assert.ok(out?.ok, "turn still completes");
  // The in-executor fallback streams the capability directly - the report text arrives.
  assert.match(String(out.text || ""), /espresso/i);
});
