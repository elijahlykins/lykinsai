/**
 * Deciding where an ask should run, by meaning rather than by keywords.
 *
 * The runtime classifies every turn with ~200 lines of regexes. They carry a
 * lot of hard-won lessons and they stay — but their catch-all is "general",
 * answered by a model with no browser, and that is where every misroute in
 * testing landed: "check who my folder is shared with" reads as a question,
 * so the user got "I'm checking now…" and nothing happened.
 *
 * Keywords cannot separate an errand phrased as a question from a question
 * about the open page; the words are nearly the same and the difference is
 * meaning. So the ambiguous cases now get a small model call — and, because it
 * runs in front of the user before a turn starts, it must be impossible for it
 * to make things worse.
 *
 * Run: node --test electron/routeStage.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { createAgentModel, ROUTE_SCHEMA } = require("./browser-agent/runtime/model.cjs");

/** A model whose reply is canned, capturing what it was asked. */
function scriptedModel(json, { capture = {}, fail = null } = {}) {
  return createAgentModel({
    apiBase: "https://api.test",
    getAuthToken: async () => "t",
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.body = JSON.parse(init.body);
      if (fail) throw new Error(fail);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "0" },
        json: async () => ({ ok: true, json }),
      };
    },
  });
}

test("the schema offers exactly two answers", () => {
  assert.deepEqual(ROUTE_SCHEMA.properties.route.enum, ["browser", "chat"]);
  assert.deepEqual(ROUTE_SCHEMA.required, ["route"]);
});

test("an errand routes to the browser", async () => {
  const capture = {};
  const out = await scriptedModel(
    { route: "browser", reason: "Sharing lives behind a dialog." },
    { capture },
  ).route({
    ask: "check who my final folder is shared with",
    liveUrl: "https://drive.google.com/drive/my-drive",
    pageTitle: "My Drive",
  });
  assert.equal(out.route, "browser");
  assert.match(out.reason, /dialog/);
  // The judgement needs the page it is judging against.
  assert.match(capture.body.user, /check who my final folder is shared with/);
  assert.match(capture.body.user, /drive\.google\.com/);
  assert.equal(capture.body.stage, "route");
});

test("a question about the open page stays in chat", async () => {
  const out = await scriptedModel({ route: "chat", reason: "Answerable from the page." }).route({
    ask: "summarize this page",
    liveUrl: "https://example.com/article",
  });
  assert.equal(out.route, "chat");
});

test("an unexpected answer is read as chat, never as browser", async () => {
  // A malformed reply must not start a browser run on the user's behalf.
  for (const json of [{ route: "BROWSER-ish" }, { route: "" }, {}, { route: 42 }]) {
    const out = await scriptedModel(json).route({ ask: "anything" });
    assert.equal(out.route, "chat", `${JSON.stringify(json)} must not route to the browser`);
  }
});

test("the call carries no tab when none is open", async () => {
  const capture = {};
  await scriptedModel({ route: "chat" }, { capture }).route({ ask: "hello" });
  assert.match(capture.body.user, /No tab is open/);
});

test("a failure is the caller's to absorb", async () => {
  // The runtime keeps its own answer when this throws; what matters here is
  // that it throws rather than inventing a route.
  await assert.rejects(
    () => scriptedModel({ route: "browser" }, { fail: "offline" }).route({ ask: "x" }),
    /offline|unavailable/i,
  );
});

test("it stays a small call — this runs before the user sees anything", () => {
  const capture = {};
  return scriptedModel({ route: "chat" }, { capture })
    .route({ ask: "x", recent: "y".repeat(5000) })
    .then(() => {
      assert.ok(capture.body.maxTokens <= 200, `asked for ${capture.body.maxTokens} tokens`);
      assert.ok(capture.body.user.length < 2000, "the prompt is capped");
    });
});
