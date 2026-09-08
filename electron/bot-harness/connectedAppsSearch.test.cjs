// Why a Bot could not read a working Gmail inbox while regular chat could.
//
// The Bot has to FIND a connected app's tools by describing them; chat gets
// them injected into the model's tool list directly. The scorer required a
// literal word overlap between the query and a tool's name or description —
// and no Gmail tool contains the word "inbox". They are GMAIL_FETCH_EMAILS,
// GMAIL_LIST_THREADS, GMAIL_GET_MESSAGE. So "unread inbox" matched nothing,
// the search reported no way in, verify failed the round, the retry
// rephrased and missed again, and the bot told the user it could not reach
// their mail — on a connected, working account.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createConnectedAppsTool,
  rankConnectedAppTools,
} = require("./runtime/connectedAppsTool.cjs");

/** Gmail as the catalog actually returns it (publicClassifiedTool shape). */
const GMAIL_TOOLS = [
  {
    name: "GMAIL_FETCH_EMAILS",
    description: "Fetch emails with optional query filters",
    consequence: "read",
    capabilities: ["communication.email.read", "communication.email.search"],
    required: [],
  },
  {
    name: "GMAIL_LIST_THREADS",
    description: "List email threads in the user mailbox",
    consequence: "read",
    capabilities: ["communication.email.read"],
    required: [],
  },
  {
    name: "GMAIL_GET_MESSAGE",
    description: "Get a single message by id",
    consequence: "read",
    capabilities: ["communication.email.read"],
    required: ["message_id"],
  },
  {
    name: "GMAIL_SEND_EMAIL",
    description: "Send an email",
    consequence: "consequential",
    capabilities: ["communication.email.send"],
    required: ["to", "body"],
  },
];

const names = (q) =>
  rankConnectedAppTools(GMAIL_TOOLS, q, { requireQueryHit: true }).map((t) => t.name);

test("the words people use for a mailbox find the mailbox tools", () => {
  // Every one of these returned NOTHING before.
  for (const q of [
    "unread inbox",
    "inbox",
    "check my inbox",
    "read the inbox",
    "snapshot of my messages",
    "my mailbox",
  ]) {
    assert.ok(names(q).length > 0, `"${q}" found no Gmail tools`);
    assert.ok(
      names(q).some((n) => n === "GMAIL_FETCH_EMAILS" || n === "GMAIL_LIST_THREADS"),
      `"${q}" did not surface a read entry point`,
    );
  }
});

test("a read ask ranks the read tools above the send tool", () => {
  const ranked = names("unread inbox");
  const send = ranked.indexOf("GMAIL_SEND_EMAIL");
  const fetch = ranked.indexOf("GMAIL_FETCH_EMAILS");
  assert.ok(fetch !== -1);
  assert.ok(send === -1 || fetch < send, "sending must never outrank reading on a read ask");
});

test("a tool that needs an opaque id is not the first suggestion", () => {
  const ranked = names("inbox");
  const byId = ranked.indexOf("GMAIL_GET_MESSAGE");
  const ready = ranked.indexOf("GMAIL_LIST_THREADS");
  assert.ok(ready !== -1 && (byId === -1 || ready < byId));
});

test("semantic capabilities match even when the name says nothing", () => {
  // A tool named after a vendor's internal concept still classifies as email.
  const odd = [
    {
      name: "GMAIL_USERS_MESSAGES_LIST",
      description: "Lists the messages in the user's mailbox",
      consequence: "read",
      capabilities: ["communication.email.read"],
      required: [],
    },
  ];
  assert.equal(
    rankConnectedAppTools(odd, "inbox", { requireQueryHit: true }).length,
    1,
  );
});

/* ── The safety net ─────────────────────────────────────────────────────── */

function toolFor(tools) {
  return createConnectedAppsTool({
    mcpClient: {
      listConnections: async () => [{ id: "gmail_1", name: "Gmail", status: "connected" }],
      connectionDetail: async () => ({ ok: true, tools }),
    },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {} },
  });
}

test("a connected app is never reported as having no way in", async () => {
  // The point of the net: whatever words the model reaches for, an app that
  // IS connected must always come back with its real entry points, because
  // "no tool matched" reads to the model as "this app is unreachable".
  const tool = toolFor(GMAIL_TOOLS);
  for (const instruction of [
    "unread inbox",
    "quarterly widget telemetry",
    "something no catalog has ever been called",
  ]) {
    const out = await tool.execute({ instruction });
    assert.equal(out.ok, true);
    assert.match(out.output, /GMAIL_FETCH_EMAILS/, `"${instruction}" surfaced no callable tool`);
    assert.doesNotMatch(out.output, /no catalog tool matched/i);
  }
});

test("an unmatched query says so, and says not to fall back to the browser", async () => {
  const out = await toolFor(GMAIL_TOOLS).execute({ instruction: "quarterly widget telemetry" });
  assert.match(out.summary, /No name match/);
  assert.match(out.output, /do NOT switch to the browser/i);
  assert.match(out.output, /do not report the app as unreachable/i);
});

test("with nothing connected the honest answer still comes back", async () => {
  const tool = createConnectedAppsTool({
    mcpClient: { listConnections: async () => [], connectionDetail: async () => ({ ok: true, tools: [] }) },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {} },
  });
  const out = await tool.execute({ instruction: "unread inbox" });
  assert.equal(out.summary, "No connected apps.");
  assert.match(out.output, /No apps are connected/);
});

/* ── Discovery is a step, not an answer ─────────────────────────────────── */
//
// Second failure, same task: the search worked, the bot found the tools, and
// then never called one. `connected_apps` must search the catalog before it
// can call anything, but the harness verifies every tool run against the
// instruction it was given — so "here are Gmail's tools" was judged as not
// having checked the email, which burned a recovery. Two searches exhausted
// the retry budget and the bot delivered "I couldn't complete a fresh inbox
// check" without ever calling a tool it could see.

function toolWithCalls(tools, callResult, spy = {}) {
  return createConnectedAppsTool({
    mcpClient: {
      listConnections: async () => [{ id: "gmail_1", name: "Gmail", status: "connected" }],
      connectionDetail: async () => ({ ok: true, tools }),
      callTool: async (args) => {
        spy.toolName = args.toolName;
        spy.calls = (spy.calls || 0) + 1;
        return typeof callResult === "function" ? callResult(args) : callResult;
      },
    },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {}, info() {} },
  });
}

const INBOX_RESULT = { ok: true, result: { content: [{ type: "text", text: "3 unread messages" }] } };

test("a read ask gets the mail, not a menu of ways to get the mail", async () => {
  const spy = {};
  const out = await toolWithCalls(GMAIL_TOOLS, INBOX_RESULT, spy).execute({
    instruction: "unread inbox",
    goal: "check my email",
  });
  // Which read entry point wins is the ranker's call — what matters is that
  // a ready READ tool ran and the data came back.
  assert.ok(
    ["GMAIL_FETCH_EMAILS", "GMAIL_LIST_THREADS"].includes(spy.toolName),
    `auto-called ${spy.toolName}, expected a ready read tool`,
  );
  assert.notEqual(spy.toolName, "GMAIL_SEND_EMAIL");
  assert.equal(out.ok, true);
  assert.match(out.output, /3 unread messages/);
  // It is the answer, so there is nothing left to follow up.
  assert.ok(!out.needsFollowUp);
});

test("nothing consequential is ever auto-called", async () => {
  const spy = {};
  const out = await toolWithCalls(GMAIL_TOOLS, INBOX_RESULT, spy).execute({
    instruction: "send an email to dana",
    goal: "email dana about friday",
  });
  assert.equal(spy.calls, undefined, "a send must never run without the model choosing it");
  assert.equal(out.needsFollowUp, true);
});

test("a tool needing an opaque id is never auto-called", async () => {
  const spy = {};
  const onlyById = [
    {
      name: "GMAIL_GET_MESSAGE",
      description: "Get a message",
      consequence: "read",
      capabilities: ["communication.email.read"],
      required: ["message_id"],
    },
  ];
  const out = await toolWithCalls(onlyById, INBOX_RESULT, spy).execute({
    instruction: "unread inbox",
    goal: "check my email",
  });
  assert.equal(spy.calls, undefined, "auto-call must not invent an id");
  assert.equal(out.needsFollowUp, true);
});

test("a discovery result tells the model to call, not to give up", async () => {
  const out = await toolWithCalls(GMAIL_TOOLS, INBOX_RESULT, {}).execute({
    instruction: "send an email to dana",
    goal: "email dana",
  });
  assert.match(out.output, /This was discovery, not the answer/);
  assert.match(out.output, /Call one of the tools above NOW/);
});

test("a failed auto-call hands back the listing instead of failing the round", async () => {
  const spy = {};
  const out = await toolWithCalls(GMAIL_TOOLS, { ok: false, summary: "upstream 503" }, spy).execute({
    instruction: "unread inbox",
    goal: "check my email",
  });
  assert.ok(["GMAIL_FETCH_EMAILS", "GMAIL_LIST_THREADS"].includes(spy.toolName));
  assert.equal(out.ok, true, "a failed attempt must not end the task");
  assert.equal(out.needsFollowUp, true);
  assert.match(out.output, /did not return data/);
  // The listing still comes back so the model can pick something else.
  assert.match(out.output, /GMAIL_FETCH_EMAILS/);
});

test("no connected apps still reports honestly and asks for nothing", async () => {
  const out = await createConnectedAppsTool({
    mcpClient: { listConnections: async () => [], connectionDetail: async () => ({ ok: true, tools: [] }) },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {}, info() {} },
  }).execute({ instruction: "unread inbox", goal: "check my email" });
  assert.ok(!out.needsFollowUp, "there is nothing to follow up when nothing is connected");
  assert.match(out.output, /No apps are connected/);
});

/* ── The right APP, not just the right word ─────────────────────────────── */
//
// Third failure, same task: the lookup "repeatedly returned unrelated YouTube
// tools rather than a Gmail inbox". Candidates were pooled across every
// connected app and ranked on word overlap, and the synonym bridge had
// expanded "inbox" to "thread" — which matched YouTube's comment-thread
// tools. Capabilities say what a tool is FOR
// (`communication.email.read`), so the app is now chosen by what the user
// asked about and word scoring only orders the tools inside it.

const YOUTUBE_TOOLS = [
  { name: "YOUTUBE_SEARCH", description: "Search videos", consequence: "read", capabilities: ["generic.read"], required: [] },
  {
    name: "YOUTUBE_LIST_COMMENT_THREADS",
    description: "List comment threads on a video",
    consequence: "read",
    capabilities: ["generic.read"],
    required: [],
  },
];

function twoApps(callSpy = {}) {
  return createConnectedAppsTool({
    mcpClient: {
      // YouTube first, so ordering cannot be what saves the email case.
      listConnections: async () => [
        { id: "youtube_1", name: "YouTube", status: "connected" },
        { id: "gmail_1", name: "Gmail", status: "connected" },
      ],
      connectionDetail: async ({ connectionId }) => ({
        ok: true,
        tools: connectionId === "gmail_1" ? GMAIL_TOOLS : YOUTUBE_TOOLS,
      }),
      callTool: async (args) => {
        callSpy.toolName = args.toolName;
        return { ok: true, result: { content: [{ type: "text", text: "3 unread messages" }] } };
      },
    },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {}, info() {} },
  });
}

test("an email ask reaches the email app, never another one", async () => {
  for (const instruction of ["unread inbox", "check my email", "any new mail"]) {
    const spy = {};
    const out = await twoApps(spy).execute({ instruction, goal: "check my email" });
    assert.ok(String(spy.toolName || "").startsWith("GMAIL_"), `"${instruction}" called ${spy.toolName}`);
    assert.doesNotMatch(out.output || "", /YOUTUBE/, `"${instruction}" leaked YouTube tools`);
  }
});

test("an ask for a domain nothing serves calls nothing at all", async () => {
  // No Slack connected. Falling back to whatever ranked first is how an email
  // request ended up in YouTube; the honest answer is to call nothing.
  const spy = {};
  const out = await twoApps(spy).execute({ instruction: "my slack dms", goal: "check slack" });
  assert.equal(spy.toolName, undefined);
  assert.equal(out.needsFollowUp, true);
});

test("an off-domain ask still works through the ordinary ranking", async () => {
  // "video" is not in the capability grammar, so this falls through to word
  // ranking — which must still pick the sensible entry point.
  const spy = {};
  await twoApps(spy).execute({ instruction: "latest videos", goal: "check youtube" });
  assert.equal(spy.toolName, "YOUTUBE_SEARCH");
});

test("how-words never steer which tool is chosen", async () => {
  // "latest"/"snapshot" describe how to get a thing, not what. Mapping them
  // onto list/fetch/get made the query hit whichever tool had LIST in its
  // name — picking comment threads over search.
  const spy = {};
  await twoApps(spy).execute({ instruction: "snapshot of the latest videos", goal: "check youtube" });
  assert.equal(spy.toolName, "YOUTUBE_SEARCH");
});

/* ── Discovery must not stall ───────────────────────────────────────────── */
//
// Fourth failure, same task: "it stalled on reading up on my tools". Three
// compounding causes, none of which surfaced as an error —
//   • every app's tools were loaded one after another,
//   • a query that matched nothing re-ran that entire pass to build the
//     fallback listing, doubling it,
//   • and no request had a timeout, so one connector that never answered
//     hung the whole thing indefinitely.

function slowApps({ count = 6, perCallMs = 60, failing = new Set(), spy = {} }) {
  const conns = Array.from({ length: count }, (_, i) => ({
    id: `app_${i}`,
    name: `App${i}`,
    status: "connected",
  }));
  return createConnectedAppsTool({
    mcpClient: {
      listConnections: async () => conns,
      connectionDetail: async ({ connectionId }) => {
        spy.detailCalls = (spy.detailCalls || 0) + 1;
        await new Promise((r) => setTimeout(r, perCallMs));
        if (failing.has(connectionId)) throw Object.assign(new Error("no answer"), { code: "mcp_timeout" });
        return {
          ok: true,
          tools: [
            {
              name: "APP_LIST_ITEMS",
              description: "List items",
              consequence: "read",
              capabilities: ["generic.read"],
              required: [],
            },
          ],
        };
      },
      callTool: async () => ({ ok: true, result: { content: [] } }),
    },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {}, info() {} },
  });
}

test("apps are read concurrently, not one after another", async () => {
  const spy = {};
  const started = Date.now();
  await slowApps({ count: 6, perCallMs: 60, spy }).execute({
    instruction: "list",
    goal: "see what is available",
  });
  const elapsed = Date.now() - started;
  assert.equal(spy.detailCalls, 6);
  // Sequential would be ~360ms; concurrent is one call's worth plus overhead.
  assert.ok(elapsed < 250, `discovery took ${elapsed}ms — looks sequential`);
});

test("a query that matches nothing does not re-read every app", async () => {
  const spy = {};
  const out = await slowApps({ count: 6, perCallMs: 20, spy }).execute({
    instruction: "nothing in any catalog is called this",
    goal: "unrelated",
  });
  // The fallback listing must come from what was already loaded.
  assert.equal(spy.detailCalls, 6, "the fallback pass re-fetched every app");
  assert.match(out.output, /APP_LIST_ITEMS/);
});

test("one unresponsive app does not take the others down with it", async () => {
  const spy = {};
  const out = await slowApps({ count: 4, perCallMs: 20, failing: new Set(["app_1"]), spy }).execute({
    instruction: "list",
    goal: "see what is available",
  });
  assert.equal(out.ok, true);
  // The working apps still answer…
  assert.match(out.output, /APP_LIST_ITEMS/);
  // …and the broken one is named rather than silently missing.
  assert.match(out.output, /App1 \[app id: app_1\]/);
  assert.match(out.output, /did not respond/);
  assert.match(out.output, /do not switch to the browser/i);
});

test("a repeated search in the same task costs no extra network", async () => {
  const spy = {};
  const tool = slowApps({ count: 3, perCallMs: 20, spy });
  await tool.execute({ instruction: "list", goal: "x" });
  const afterFirst = spy.detailCalls;
  await tool.execute({ instruction: "list", goal: "x" });
  assert.equal(spy.detailCalls, afterFirst, "the second search re-fetched app details");
});

/* ── Reading only what the ask is about ─────────────────────────────────── */
//
// "it worked but it was super super slow": discovery read the full tool
// catalog of EVERY connected app — eight upstream round-trips to answer a
// question about one of them — and then the call that followed re-read the
// chosen app's catalog a second time, in series. The connection list already
// carries each app's semantic capabilities (`capabilitySummary.tools`, set at
// discovery), so which app serves email is answerable without reading anyone.

function manyApps({ withSummary = true, spy = {} } = {}) {
  const apps = [
    { id: "youtube", name: "YouTube", caps: ["generic.read"] },
    { id: "notion", name: "Notion", caps: ["documents.read"] },
    { id: "github", name: "GitHub", caps: ["source_control.read"] },
    { id: "gmail", name: "Gmail", caps: ["communication.email.read"] },
  ];
  return createConnectedAppsTool({
    mcpClient: {
      listConnections: async () => {
        spy.listCalls = (spy.listCalls || 0) + 1;
        return apps.map((a) => ({
          id: a.id,
          name: a.name,
          status: "connected",
          ...(withSummary ? { capabilitySummary: { tools: a.caps } } : {}),
        }));
      },
      connectionDetail: async ({ connectionId }) => {
        spy.read = spy.read || [];
        spy.read.push(connectionId);
        return {
          ok: true,
          tools:
            connectionId === "gmail"
              ? GMAIL_TOOLS
              : [
                  {
                    name: `${connectionId.toUpperCase()}_LIST`,
                    description: "List things",
                    consequence: "read",
                    capabilities: ["generic.read"],
                    required: [],
                  },
                ],
        };
      },
      callTool: async () => ({ ok: true, result: { content: [{ type: "text", text: "3 unread" }] } }),
    },
    apiBase: "https://example.invalid",
    getAuthToken: async () => "token",
    logger: { warn() {}, info() {} },
  });
}

test("an email ask reads the email app's catalog and nobody else's", async () => {
  const spy = {};
  const out = await manyApps({ spy }).execute({ instruction: "unread inbox", goal: "check my email" });
  assert.deepEqual(spy.read, ["gmail"], `read ${JSON.stringify(spy.read)}`);
  assert.match(out.output, /3 unread/);
});

test("the call after a search reuses the catalog it just read", async () => {
  const spy = {};
  await manyApps({ spy }).execute({ instruction: "unread inbox", goal: "check my email" });
  // One read total: the search's, reused by the call. It used to be two, in
  // series, on every single connected-app action.
  assert.equal(spy.read.length, 1);
  assert.equal(spy.listCalls, 1, "the connection list was fetched more than once");
});

test("an app with no capability summary is never excluded", async () => {
  // Older connections, or servers that never classified their tools, must not
  // be hidden just because we know nothing about them.
  const spy = {};
  await manyApps({ withSummary: false, spy }).execute({
    instruction: "unread inbox",
    goal: "check my email",
  });
  assert.ok(spy.read.includes("gmail"));
  assert.ok(spy.read.length > 1, "with no summaries every app should still be considered");
});

test("a successful read is not sent for a second opinion", async () => {
  const out = await manyApps({}).execute({ instruction: "unread inbox", goal: "check my email" });
  // `verified` tells the harness the data is in hand, so it skips the verify
  // round instead of spending a model call re-reading the user's own inbox.
  assert.equal(out.verified, true);
});

test("one failing app no longer hides the apps that worked", async () => {
  // An error line counted as a section, so it suppressed the no-match
  // fallback and the answer became the error and nothing else.
  const spy = {};
  const out = await slowApps({ count: 3, perCallMs: 5, failing: new Set(["app_1"]), spy }).execute({
    instruction: "list",
    goal: "see what is available",
  });
  assert.match(out.output, /APP_LIST_ITEMS/, "working apps were dropped");
  assert.match(out.output, /App1 \[app id: app_1\]/, "the failure should still be named");
});
