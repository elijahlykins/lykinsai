"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  reportExecutor,
  buildExecutor,
  imageExecutor,
  reportDeliverable,
  documentDeliverable,
} = require("./botDeliverables.cjs");

test("reportExecutor remembers the report on the agent and attaches an HTML document deliverable", async () => {
  const agent = {};
  const run = async () => ({
    ok: true,
    output: "# Coffee Market 2026\n\nDemand is up.\n\n## Sources\n- example.com",
    summary: "report",
  });
  const res = await reportExecutor(agent, run)({ instruction: "coffee market" });

  assert.equal(agent.lastResearchReport, res.output);
  assert.equal(agent.lastDeliverableKind, "report");
  assert.equal(res.deliverable.kind, "html");
  assert.equal(res.deliverable.title, "Coffee Market 2026");
  assert.match(res.deliverable.html, /<!doctype html/i);
  assert.match(res.deliverable.html, /Demand is up/);
  assert.ok(res.deliverable.filename.endsWith(".html"));
});

test("reportExecutor leaves a failed run untouched", async () => {
  const agent = {};
  const res = await reportExecutor(agent, async () => ({ ok: false, output: "" }))({
    instruction: "x",
  });
  assert.equal(res.deliverable, undefined);
  assert.equal(agent.lastResearchReport, undefined);
});

test("buildExecutor captures only an artifact produced by THIS call", async () => {
  const prior = { title: "Old", code: "old", url: "http://old" };
  const agent = { lastArtifact: prior };

  // The stream host did not produce a new artifact — no deliverable.
  const unchanged = await buildExecutor(agent, async () => ({ ok: true, output: "done" }))({});
  assert.equal(unchanged.deliverable, undefined);

  // A new artifact object landed on the agent during the call.
  const run = async () => {
    agent.lastArtifact = { title: "Coffee deck", code: "export default ...", url: "http://stage/a" };
    return { ok: true, output: "built" };
  };
  const res = await buildExecutor(agent, run)({});
  assert.deepEqual(res.deliverable, {
    kind: "artifact",
    title: "Coffee deck",
    url: "http://stage/a",
    code: "export default ...",
  });
});

test("imageExecutor captures the image generated during the call", async () => {
  const agent = {};
  const run = async () => {
    agent.lastImage = { url: "http://img/1.png", title: "Logo" };
    return { ok: true, output: "![Generated image](http://img/1.png)" };
  };
  const res = await imageExecutor(agent, run)({});
  assert.deepEqual(res.deliverable, { kind: "image", title: "Logo", url: "http://img/1.png" });
});

test("reportDeliverable is null for empty content", () => {
  assert.equal(reportDeliverable(""), null);
});

test("documentDeliverable wraps a written document result", () => {
  const d = documentDeliverable({
    ok: true,
    title: "Memo",
    html: "<!doctype html><html><body>hi</body></html>",
    filename: "memo.html",
  });
  assert.equal(d.kind, "html");
  assert.equal(d.title, "Memo");
  assert.equal(d.filename, "memo.html");
  assert.equal(documentDeliverable({ ok: false }), null);
  assert.equal(documentDeliverable({ ok: true, title: "x", html: "" }), null);
});
