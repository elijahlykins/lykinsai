"use strict";

/**
 * Bots decide tools with a model, and only ask about the browser when the
 * verdict is actually "browser".
 *
 * The old gate parked "want me to use the browser?" whenever the keyword
 * heuristics smelled a website — which they did on ordinary chat ("check
 * this", app names, "open"…), so the Bot interrupted constantly. Now the
 * heuristics only nominate; a small model call decides chat / tool /
 * browser, and when that call cannot run (offline, signed out) the Bot
 * answers conversationally instead of asking. The one exception that needs
 * no model: the user naming the browser outright.
 *
 * ONE route, not two: a "browser" verdict never parks the question itself.
 * The Bot and the browser agent are the same agent — the browser is one of
 * the Bot's tools, so the verdict only preloads that tool's doc and the
 * Bot's own harness loop decides to park the opt-in (or not). The stub
 * server below answers the harness's "decide" stage separately from the
 * router's "route" stage so these tests exercise that full path.
 *
 * Run: node --test electron/botToolRouting.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createAgentRuntime } = require("./agentRuntime.cjs");

// Chat works, the tool-router model does not: /api/ai/stream answers 200 (the
// stubbed readStreamResponse below supplies the text), while the agent-model
// endpoint fails without retrying. That IS the scenario under test — with no
// routing verdict available, a Bot must not park the browser question on a
// keyword hunch.
let server;
let apiBase = "";
// When set, the agent-model endpoint answers with this tool verdict instead
// of failing — that's how a test plays the router saying "browser".
let modelVerdict = "";
// The last request body the router sent — what the routing model was told.
let lastRouteBody = null;
// Every "decide" call the Bot harness made — proof the browser verdict runs
// the Bot's own loop instead of a separate pre-harness route.
let harnessDecides = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/desktop/agent-model")) {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        // The Bot harness's decide stage: play a bot that calls its browser
        // tool properly — the unified route ends with the harness's own
        // parked opt-in question, never a pre-harness park.
        if (body?.stage === "decide") {
          harnessDecides.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              json: {
                kind: "use_tool",
                tool: "browser",
                instruction: "carry out the user's errand on the live site",
                narration: "This needs the real browser.",
                risk: "low",
              },
            }),
          );
          return;
        }
        lastRouteBody = body;
        if (modelVerdict) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, json: { tool: modelVerdict, reason: "test" } }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

function newRuntime() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-bot-route-"));
  return createAgentRuntime({
    userDataPath,
    apiBase,
    getAuthToken: async () => "test-token",
    readStreamResponse: async () => "All set — here's your answer.",
    emit: () => {},
    ensureBrowserWindow: () => {},
    destroyBrowserWindow: () => {},
    showBrowserWindow: () => {},
    hideBrowserWindow: () => {},
    hideAllBrowserWindows: () => {},
    browserWindowExists: () => false,
    getBrowserWebContents: () => null,
    planOwnedBrowserNext: async () => ({}),
    isContentProtectionEnabled: () => false,
    openStageArtifact: () => {},
    destroyOwnedArtifactTabs: () => {},
    focusOverlayComposer: () => {},
    notifyAgentFinished: () => {},
  });
}

function newBot(runtime) {
  const res = runtime.createAgent({
    title: "Scout",
    silent: true,
    activate: false,
    headless: true,
  });
  assert.ok(res?.ok && res.agentId, "headless bot agent created");
  return res.agentId;
}

const BROWSER_ASK_RE = /need the browser for/i;

test("naming the browser outright parks the question — no model needed", async () => {
  const runtime = newRuntime();
  const id = newBot(runtime);
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher. Stay warm and friendly — you're a teammate, not a formal assistant.]\n\nuse the browser to order a pizza from dominos",
  });
  assert.ok(out?.ok);
  assert.match(String(out.text || ""), BROWSER_ASK_RE);
});

test("a browser-shaped ask with no model verdict answers in chat, not with the ask", async () => {
  const runtime = newRuntime();
  const id = newBot(runtime);
  // looksLikeBrowseActAsk-shaped — the old gate parked the question on this
  // heuristic alone. Without a model verdict it must just answer.
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\ngo to dominos.com and order me a large pepperoni pizza",
  });
  assert.ok(out?.ok);
  assert.doesNotMatch(String(out.text || ""), BROWSER_ASK_RE);
});

test("a genuine errand parks the ask when the model's verdict is browser", async (t) => {
  modelVerdict = "browser";
  t.after(() => {
    modelVerdict = "";
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  const before = harnessDecides.length;
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\ngo to my dominos account and reorder my usual pizza",
  });
  assert.ok(out?.ok);
  assert.match(String(out.text || ""), BROWSER_ASK_RE);
  // One route: the verdict handed the ask to the Bot's OWN loop, and the
  // question above is the harness's browser tool parking its opt-in — not a
  // separate pre-harness browser path.
  assert.ok(harnessDecides.length > before, "the Bot harness must make the browser decision");
});

test("a no to the parked question answers in chat — the bot must not re-ask", async (t) => {
  modelVerdict = "browser";
  t.after(() => {
    modelVerdict = "";
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  const parked = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\ngo to my dominos account and reorder my usual pizza",
  });
  assert.match(String(parked.text || ""), BROWSER_ASK_RE);
  // The decline re-runs the errand headless. The harness's browser tool sees
  // the decline and must not park the same question one round later — even
  // though the scripted decide above keeps picking the browser.
  const out = await runtime.send(id, { text: "no, just answer here" });
  assert.ok(out?.ok);
  assert.doesNotMatch(String(out.text || ""), BROWSER_ASK_RE);
});

test("a chat verdict overrides the browser-shaped heuristics", async (t) => {
  modelVerdict = "chat";
  t.after(() => {
    modelVerdict = "";
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  // Heuristics read this as a browse errand; the model knows it's a question.
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\ncheck this idea for me: is a wood-fired oven worth it at home?",
  });
  assert.ok(out?.ok);
  assert.doesNotMatch(String(out.text || ""), BROWSER_ASK_RE);
  assert.equal(out.skill, "general");
});

test("a pronoun follow-up ('send that to him') still reaches the router", async (t) => {
  modelVerdict = "browser";
  t.after(() => {
    modelVerdict = "";
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  // Set the scene: the bot drafted an email in a previous turn.
  const first = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\ndraft a funny email to elijah about the vibes",
  });
  assert.ok(first?.ok);
  // The follow-up carries no address, no app name, no URL — only the verb
  // and pronouns. The verb alone must nominate it so the model (which sees
  // the recent turns) can say "browser" and park the question, instead of
  // the bot shrugging "I can't send it from this chat".
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\nok can you actually send that to him",
  });
  assert.ok(out?.ok);
  assert.match(String(out.text || ""), BROWSER_ASK_RE);
});

test("a mail errand naming the user's own account reaches the router and parks", async (t) => {
  // Live failure this ask produced before the prompt fix: the router said
  // "chat" with the reason "I cannot access your Gmail account". No keyword
  // shortcut here — the model's verdict alone decides.
  modelVerdict = "browser";
  t.after(() => {
    modelVerdict = "";
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\ngo to my gmail and write an email to elijah@lykn.io — make it funny",
  });
  assert.ok(out?.ok);
  assert.match(String(out.text || ""), BROWSER_ASK_RE);
});

test("the router is told the teammate CAN use the browser — dispatch, never decline", async (t) => {
  // The live failure this guards against: the router prompt used to say the
  // teammate "has no browser tab open", so the small routing model answered
  // "chat" for "ok now send it to him" with reasons like "I cannot do that
  // directly" — and the Bot never offered the browser at all.
  modelVerdict = "browser";
  t.after(() => {
    modelVerdict = "";
  });
  const runtime = newRuntime();
  const id = newBot(runtime);
  lastRouteBody = null;
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\nplease send that report over to dana",
  });
  assert.ok(out?.ok);
  assert.match(String(out.text || ""), BROWSER_ASK_RE);
  const system = String(lastRouteBody?.system || "");
  assert.match(system, /can open a real browser/i);
  assert.match(system, /never answer "chat" because/i);
  assert.doesNotMatch(system, /has no browser/i);
});

test("casual chat never consults the router and never asks", async () => {
  const runtime = newRuntime();
  const id = newBot(runtime);
  const out = await runtime.send(id, {
    text: "[You are Scout, my researcher.]\n\nhey! how's it going today?",
  });
  assert.ok(out?.ok);
  assert.doesNotMatch(String(out.text || ""), BROWSER_ASK_RE);
  assert.equal(out.skill, "general");
});
