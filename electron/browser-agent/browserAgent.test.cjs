/**
 * Simulation tests for the modular browser agent.
 *
 * A fake actuator + webContents stand in for the Electron browser, and a
 * scripted model stands in for the LLM — so these tests exercise the REAL
 * loop, controller, snapshot/ref system, verifier, recovery and safety gate
 * deterministically, offline.
 *
 * Run: node --test electron/browser-agent/browserAgent.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");

// --- fake browser environment ------------------------------------------------

function makeElement(overrides = {}) {
  return {
    id: `el${Math.floor(Math.random() * 1e6)}`,
    tag: "button",
    type: "",
    role: "",
    selector: `#${overrides.name || "el"}`,
    label: "",
    value: "",
    checked: false,
    href: "",
    clientX: 100,
    clientY: 100,
    inView: true,
    ...overrides,
  };
}

/**
 * @param {Record<string, {title:string, text:string, elements:Array, onAction?:Function}>} pages
 */
function createFakeBrowser(pages, startUrl = "about:blank") {
  const state = { url: startUrl };
  if (!pages["about:blank"]) {
    pages["about:blank"] = { title: "", text: "", elements: [] };
  }

  function page() {
    return pages[state.url] || { title: "Not found", text: "404", elements: [] };
  }

  function resolveUrl(url) {
    let href = String(url || "").trim();
    if (!/^https?:\/\//i.test(href) && href !== "about:blank") href = `https://${href}`;
    // Loose matching: exact key, else key that shares the host.
    if (pages[href]) return href;
    const host = safeHost(href);
    const match = Object.keys(pages).find((k) => safeHost(k) === host);
    return match || href;
  }

  function safeHost(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  const webContents = {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => page().title,
    isLoading: () => false,
    executeJavaScript: async (js) => {
      // The controller's replaceText() ships a base64 JSON payload.
      if (js.startsWith("/*lykn-replace-text*/")) {
        const b = js.match(/atob\('([^']+)'\)/);
        const payload = JSON.parse(Buffer.from(b[1], "base64").toString("utf8"));
        const el = page().elements.find((e) => e.selector === payload.selector);
        if (!el) return { ok: false, error: "element_not_found" };
        const v = String(el.value || "");
        const i = v.indexOf(payload.find);
        if (i < 0) return { ok: false, error: "text_not_found" };
        el.value = v.slice(0, i) + payload.replace + v.slice(i + payload.find.length);
        return { ok: true, replaced: true, preview: el.value.slice(Math.max(0, i - 40), i + payload.replace.length + 40) };
      }
      // The controller's extract() embeds the selector via JSON.stringify.
      const m = js.match(/querySelector\((".*?")\)/);
      if (m) {
        const selector = JSON.parse(m[1]);
        const el = page().elements.find((e) => e.selector === selector);
        return el ? { value: el.value || "", checked: el.checked === true } : null;
      }
      return null;
    },
  };

  const actuator = {
    async navigate(_wc, url) {
      state.url = resolveUrl(url);
      return { ok: true, url: state.url };
    },
    async getDOMCatalog() {
      // The real collector mints a uid per element in page context; these
      // fixtures predate it, so number them in catalog order.
      return { ok: true, url: state.url, title: page().title, items: page().elements.map((e, i) => ({ uid: i + 1, ...e })) };
    },
    async getPageContext() {
      return { ok: true, url: state.url, title: page().title, text: page().text };
    },
    async runAction(_wc, action) {
      const p = page();
      const type = String(action.type || "");
      if (type === "back" || type === "forward") return { ok: false, error: "no_history" };
      if (type === "scroll") return { ok: true, type: "scroll" };
      const target = p.elements.find(
        (e) => e.selector === action.selector || e.id === action.id,
      );
      if (["click", "click_type", "select", "press_key"].includes(type)) {
        if (type !== "press_key" && !target) return { ok: false, error: "Element not found" };
        if (typeof p.onAction === "function") {
          const out = p.onAction({ type, action, target, state, pages });
          if (out) return out;
        }
        if (type === "click_type" && target) {
          target.value = String(action.text || "");
          if (action.pressEnter && typeof p.onEnter === "function") {
            p.onEnter({ state, target });
          }
          return { ok: true, type: "click_type" };
        }
        return { ok: true, type };
      }
      return { ok: true, type };
    },
    async screenshotDataUrl() {
      return "data:image/jpeg;base64,ZmFrZQ==";
    },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };

  return { webContents, actuator, state, pages };
}

// --- scripted model ------------------------------------------------------------

function createScriptedModel({ plan, decisions, verify }) {
  let decideIdx = 0;
  return {
    async plan() {
      return {
        plan: plan?.plan || ["Do the task"],
        constraints: plan?.constraints || [],
        knownFacts: plan?.knownFacts || {},
        skills: plan?.skills || [],
        clarification: plan?.clarification || "",
      };
    },
    async decide(ctx) {
      const d = decisions[Math.min(decideIdx, decisions.length - 1)];
      decideIdx += 1;
      const out = typeof d === "function" ? d(ctx) : d;
      return {
        kind: "act",
        action: null,
        reason: "",
        expectedOutcome: "",
        risk: "low",
        answer: "",
        question: "",
        replanReason: "",
        planStepCompleted: false,
        factsLearned: [],
        candidateResults: [],
        ...out,
      };
    },
    async verify(ctx) {
      if (verify) return verify(ctx);
      return { success: true, evidence: "page changed", reason: "", next: "continue" };
    },
  };
}

function runTask({ fake, model, goal, maxRounds = 12, onApprovalNeeded = null }) {
  const controller = createBrowserController({
    webContents: fake.webContents,
    actuator: fake.actuator,
  });
  return runBrowserAgentTask({
    goal,
    controller,
    model,
    maxRounds,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
    onApprovalNeeded,
  });
}

// --- Test 1: navigation (Wikipedia search) ------------------------------------

test("navigation: go to Wikipedia and search for Alan Turing", async () => {
  const fake = createFakeBrowser({
    "https://www.wikipedia.org": {
      title: "Wikipedia",
      text: "Wikipedia The Free Encyclopedia",
      elements: [
        makeElement({ name: "searchInput", tag: "input", role: "searchbox", label: "Search Wikipedia" }),
        makeElement({ name: "searchButton", label: "Search" }),
      ],
      onEnter: ({ state }) => {
        state.url = "https://en.wikipedia.org/wiki/Alan_Turing";
      },
    },
    "https://en.wikipedia.org/wiki/Alan_Turing": {
      title: "Alan Turing - Wikipedia",
      text: "Alan Turing was an English mathematician and computer scientist.",
      elements: [makeElement({ name: "firstLink", tag: "a", label: "Computer science", href: "https://en.wikipedia.org/wiki/CS" })],
    },
  });

  const model = createScriptedModel({
    plan: { plan: ["Open Wikipedia", "Search for Alan Turing", "Confirm the article loaded"] },
    decisions: [
      {
        kind: "act",
        action: { type: "navigate", url: "https://www.wikipedia.org" },
        expectedOutcome: "Wikipedia home page loads",
      },
      {
        kind: "act",
        action: { type: "type", target: "e1", text: "Alan Turing", pressEnter: true },
        expectedOutcome: "Alan Turing article or search results appear",
        planStepCompleted: true,
      },
      {
        kind: "finish",
        answer: "I searched Wikipedia for Alan Turing; the article is open.",
        factsLearned: ["Alan Turing article found on Wikipedia"],
      },
    ],
  });

  const result = await runTask({ fake, model, goal: "Go to Wikipedia and search for Alan Turing" });
  assert.equal(result.status, "completed");
  assert.equal(fake.state.url, "https://en.wikipedia.org/wiki/Alan_Turing");
  // Both meaningful actions verified as successes (page-change detection worked).
  assert.deepEqual(result.history.map((h) => h.result), ["success", "success"]);
  assert.ok(result.history[1].observedOutcome.length > 0, "verification recorded evidence");
});

// --- Test 2: research (skill routing + working memory + completion) ------------

test("research: find the release year of the first iPhone", async () => {
  const fake = createFakeBrowser({
    "https://en.wikipedia.org/wiki/IPhone": {
      title: "iPhone - Wikipedia",
      text: "The first iPhone was announced by Steve Jobs and released on June 29, 2007.",
      elements: [],
    },
  });

  assert.ok(
    contextRouter.routeSkills("Find the release year of the first iPhone").includes("research"),
    "context router loads the research skill",
  );

  const model = createScriptedModel({
    plan: { plan: ["Look up the first iPhone release", "Extract the year"], skills: ["research"] },
    decisions: [
      {
        kind: "act",
        action: { type: "navigate", url: "https://en.wikipedia.org/wiki/IPhone" },
        expectedOutcome: "iPhone article loads",
        factsLearned: [],
      },
      {
        kind: "finish",
        answer: "The first iPhone was released in 2007 (June 29, 2007).",
        factsLearned: ["First iPhone released June 29, 2007 (source: Wikipedia)"],
      },
    ],
  });

  const result = await runTask({ fake, model, goal: "Find the release year of the first iPhone" });
  assert.equal(result.status, "completed");
  assert.ok(result.task.skills.includes("research"), "research skill attached to task");
  assert.ok(
    result.task.workingMemory.facts.some((f) => f.includes("2007")),
    "discovered fact stored in working memory",
  );
  assert.match(result.answer, /2007/);
});

// --- Test 3: multi-step task (constraints, extraction, stopping) ---------------

test("multi-step: find three mechanical keyboards under $100 without purchasing", async () => {
  const fake = createFakeBrowser({
    "https://www.amazon.com": {
      title: "Amazon.com",
      text: "Amazon home",
      elements: [
        makeElement({ name: "twotabsearchtextbox", tag: "input", role: "searchbox", label: "Search Amazon" }),
      ],
      onEnter: ({ state }) => {
        state.url = "https://www.amazon.com/s?k=mechanical+keyboard";
      },
    },
    "https://www.amazon.com/s?k=mechanical+keyboard": {
      title: 'Amazon.com : "mechanical keyboard" results',
      text: [
        'Results for "mechanical keyboard"',
        "Keychron C2 Full Size Wired $59.99 4.5 stars 12,001 ratings",
        "Royal Kludge RK84 $79.99 4.4 stars 8,332 ratings",
        "EPOMAKER TH80 Pro $89.99 4.6 stars 3,104 ratings",
        "SteelSeries Apex Pro $199.99 4.7 stars 20,010 ratings",
      ].join("\n"),
      elements: [
        makeElement({ name: "r1", tag: "a", label: "Keychron C2 Full Size Wired" }),
        makeElement({ name: "r2", tag: "a", label: "Royal Kludge RK84" }),
        makeElement({ name: "r3", tag: "a", label: "EPOMAKER TH80 Pro" }),
        makeElement({ name: "r4", tag: "a", label: "SteelSeries Apex Pro" }),
        makeElement({ name: "buy", label: "Buy Now" }),
      ],
    },
  });

  const model = createScriptedModel({
    plan: {
      plan: ["Search Amazon", "Gather candidates under $100", "Pick three options"],
      constraints: ["mechanical keyboard", "under $100"],
      skills: ["shopping"],
    },
    decisions: [
      {
        kind: "act",
        action: { type: "navigate", url: "https://www.amazon.com" },
        expectedOutcome: "Amazon home page with search box",
      },
      {
        kind: "act",
        action: { type: "type", target: "e1", text: "mechanical keyboard", pressEnter: true },
        expectedOutcome: "results for mechanical keyboard listed",
        planStepCompleted: true,
      },
      {
        kind: "act",
        action: { type: "scroll", direction: "down" },
        expectedOutcome: "more results visible",
        candidateResults: [
          "Keychron C2 — $59.99, 4.5 stars",
          "Royal Kludge RK84 — $79.99, 4.4 stars",
          "EPOMAKER TH80 Pro — $89.99, 4.6 stars",
        ],
        factsLearned: ["SteelSeries Apex Pro is $199.99 — over budget, excluded"],
        planStepCompleted: true,
      },
      {
        kind: "finish",
        answer:
          "Three promising mechanical keyboards under $100: Keychron C2 ($59.99), Royal Kludge RK84 ($79.99), EPOMAKER TH80 Pro ($89.99).",
      },
    ],
  });

  const result = await runTask({
    fake,
    model,
    goal: "Search Amazon for mechanical keyboards under $100 and identify three promising options",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.task.constraints, ["mechanical keyboard", "under $100"]);
  assert.equal(result.task.workingMemory.candidateResults.length, 3);
  assert.ok(
    result.task.workingMemory.facts.some((f) => /over budget/.test(f)),
    "constraint violation tracked",
  );
  // Stopping behavior: no purchase click ever happened.
  assert.ok(!result.history.some((h) => /buy/i.test(h.action?.label || "")), "never clicked Buy");
  assert.match(result.answer, /Keychron/);
});

// --- Test 4: recovery from stale/invalid references and failing actions --------

test("recovery: stale reference then flaky click — agent re-observes and continues", async () => {
  let clickAttempts = 0;
  const fake = createFakeBrowser(
    {
      "https://app.example.com": {
        title: "Example App",
        text: "Dashboard. Open your reports here.",
        elements: [makeElement({ name: "reportsBtn", label: "Open Reports" })],
        onAction: ({ type, state }) => {
          if (type !== "click") return null;
          clickAttempts += 1;
          if (clickAttempts === 1) return { ok: false, error: "Element not found" };
          state.url = "https://app.example.com/reports";
          return { ok: true, type: "click" };
        },
      },
      "https://app.example.com/reports": {
        title: "Reports — Example App",
        text: "Reports list: Q1, Q2, Q3.",
        elements: [],
      },
    },
    "https://app.example.com",
  );

  const decisions = [
    // 1. Invalid ref — never handed out by any snapshot.
    {
      kind: "act",
      action: { type: "click", target: "e999" },
      expectedOutcome: "reports open",
    },
    // 2. Correct ref after re-observe — actuator fails once (flaky page).
    {
      kind: "act",
      action: { type: "click", target: "e1" },
      expectedOutcome: "Reports page opens",
    },
    // 3. Retry after recovery hint.
    {
      kind: "act",
      action: { type: "click", target: "e1" },
      expectedOutcome: "Reports page opens",
      planStepCompleted: true,
    },
    { kind: "finish", answer: "Reports are open.", factsLearned: ["Reports page reached"] },
  ];

  const model = createScriptedModel({
    plan: { plan: ["Open the reports page"] },
    decisions,
  });

  const result = await runTask({ fake, model, goal: "Open the reports page" });
  assert.equal(result.status, "completed", `expected completion, got ${result.status}: ${result.answer}`);
  assert.equal(fake.state.url, "https://app.example.com/reports");
  // The flaky click was recorded as a failure, then the retry succeeded —
  // no hallucinated success, no crash.
  const clickResults = result.history.filter((h) => h.action?.type === "click").map((h) => h.result);
  assert.deepEqual(clickResults, ["failure", "success"]);
  assert.ok(clickAttempts === 2, "agent retried the click exactly once");
});

// --- Test 5: consequential action requires approval -----------------------------

test("consequential: agent prepares checkout but stops before Place Order", async () => {
  let purchaseClicks = 0;
  const fake = createFakeBrowser(
    {
      "https://shop.example.com/checkout": {
        title: "Checkout — Example Shop",
        text: "Order summary: 1x USB-C Cable $12.99. Shipping to saved address. Total $14.20.",
        elements: [
          makeElement({ name: "promo", tag: "input", role: "textbox", label: "Promo code" }),
          makeElement({ name: "placeOrder", label: "Place Order" }),
        ],
        onAction: ({ type, target }) => {
          if (type === "click" && /place order/i.test(target?.label || "")) {
            purchaseClicks += 1;
            return { ok: true, type: "click" };
          }
          return null;
        },
      },
    },
    "https://shop.example.com/checkout",
  );

  const model = createScriptedModel({
    plan: { plan: ["Review the order", "Complete the purchase"], skills: ["shopping"] },
    decisions: [
      // The model even under-reports risk as "low" — the deterministic
      // classifier must still catch the "Place Order" label.
      {
        kind: "act",
        action: { type: "click", target: "e2" },
        expectedOutcome: "order placed",
        risk: "low",
        factsLearned: ["Cart total is $14.20 for 1x USB-C cable"],
      },
    ],
  });

  const result = await runTask({ fake, model, goal: "Check out my cart" });
  assert.equal(result.status, "waiting_for_user");
  assert.equal(result.needsApproval, true);
  assert.equal(purchaseClicks, 0, "Place Order was never clicked");
  assert.match(result.answer, /Place Order/i);

  // Same setup with interactive approval granted — the click goes through.
  let purchaseClicks2 = 0;
  const fake2 = createFakeBrowser(
    {
      "https://shop.example.com/checkout": {
        title: "Checkout — Example Shop",
        text: "Order summary: total $14.20. Thank you page appears after ordering.",
        elements: [makeElement({ name: "placeOrder", label: "Place Order" })],
        onAction: ({ type, target, state }) => {
          if (type === "click" && /place order/i.test(target?.label || "")) {
            purchaseClicks2 += 1;
            state.url = "https://shop.example.com/thanks";
            return { ok: true, type: "click" };
          }
          return null;
        },
      },
      "https://shop.example.com/thanks": {
        title: "Order confirmed",
        text: "Thank you! Your order is confirmed.",
        elements: [],
      },
    },
    "https://shop.example.com/checkout",
  );
  const model2 = createScriptedModel({
    plan: { plan: ["Complete the purchase"] },
    decisions: [
      {
        kind: "act",
        action: { type: "click", target: "e1" },
        expectedOutcome: "order confirmed",
        risk: "consequential",
      },
      { kind: "finish", answer: "Order placed — confirmation page shown." },
    ],
  });
  const result2 = await runTask({
    fake: fake2,
    model: model2,
    goal: "Check out my cart",
    onApprovalNeeded: async () => true,
  });
  assert.equal(result2.status, "completed");
  assert.equal(purchaseClicks2, 1, "approved purchase executed exactly once");
});

// --- Test 6: email compose — fill + verify, Send gated on the user's words -----

function makeGmailFake() {
  const composeFields = () => [
    makeElement({ name: "to", tag: "input", role: "combobox", label: "To recipients" }),
    makeElement({ name: "subject", tag: "input", label: "Subject" }),
    makeElement({ name: "body", tag: "textarea", role: "textbox", label: "Message Body" }),
    makeElement({ name: "send", label: "Send" }),
  ];
  const fake = createFakeBrowser(
    {
      "https://mail.google.com/mail/u/0/": {
        title: "Inbox — Gmail",
        text: "Inbox. 3 conversations.",
        elements: [makeElement({ name: "compose", label: "Compose" })],
        onAction: ({ type, target, pages, state }) => {
          const page = pages[state.url];
          if (type === "click" && /compose/i.test(target?.label || "")) {
            if (!page.elements.some((e) => e.label === "Send")) {
              page.elements.push(...composeFields());
            }
            page.text = "Inbox. New Message compose window open.";
            return { ok: true, type: "click" };
          }
          if (type === "click" && /^send$/i.test(target?.label || "")) {
            fake.sendClicks += 1;
            page.text = "Inbox. Message sent.";
            page.elements = page.elements.filter((e) => e.label === "Compose");
            return { ok: true, type: "click" };
          }
          return null;
        },
      },
    },
    "https://mail.google.com/mail/u/0/",
  );
  fake.sendClicks = 0;
  return fake;
}

function gmailComposeDecisions() {
  return [
    {
      kind: "act",
      action: { type: "click", target: "e1" },
      expectedOutcome: "Compose window with To recipients and Subject fields appears",
    },
    {
      kind: "act",
      action: { type: "type", target: "e2", text: "sarah@example.com" },
      expectedOutcome: "To field contains sarah@example.com",
    },
    {
      kind: "act",
      action: { type: "type", target: "e3", text: "Meeting moved" },
      expectedOutcome: "Subject contains Meeting moved",
    },
    {
      kind: "act",
      action: { type: "type", target: "e4", text: "Hi Sarah, the meeting moved to 3pm Thursday." },
      expectedOutcome: "Body contains the message",
      planStepCompleted: true,
    },
    {
      kind: "act",
      action: { type: "click", target: "e5" },
      expectedOutcome: "Message sent toast appears",
      risk: "consequential",
    },
    { kind: "finish", answer: "Email to sarah@example.com sent — Gmail showed 'Message sent'." },
  ];
}

test("email: draft-only ask fills everything but stops before Send", async () => {
  const fake = makeGmailFake();
  const model = createScriptedModel({
    plan: { plan: ["Open compose", "Fill the draft", "Leave it for review"], skills: ["communication"] },
    decisions: gmailComposeDecisions(),
  });
  const controller = createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });
  const result = await runBrowserAgentTask({
    // Enriched goal mentions Send in its instructions — must NOT self-approve.
    goal:
      "Draft an email to Sarah about the meeting.\n\nEmail task context:\n- Do NOT click Send unless the user's request explicitly asks to send.",
    userAsk: "Draft an email to Sarah about the meeting",
    controller,
    model,
    maxRounds: 12,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "waiting_for_user");
  assert.equal(result.needsApproval, true);
  assert.equal(fake.sendClicks, 0, "Send was never clicked without approval");
  // Every field fill was verified against the live form values.
  const typeResults = result.history.filter((h) => h.action?.type === "type");
  assert.equal(typeResults.length, 3);
  assert.ok(typeResults.every((h) => h.result === "success"));
});

test("email: a send the user asked for still confirms before it goes out", async () => {
  const fake = makeGmailFake();
  const model = createScriptedModel({
    plan: { plan: ["Open compose", "Fill the draft", "Send it"], skills: ["communication"] },
    decisions: gmailComposeDecisions(),
  });
  const controller = createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });
  const result = await runBrowserAgentTask({
    // The wording asks for a send in as many words. It still does not
    // authorize one: the user has not seen what was written yet, and the text
    // reaching this loop is not reliably the user speaking — an instruction
    // line, or an ask left over from an earlier turn, reads identically. That
    // is not a hypothetical: a stale "Send a Gmail email to …" folded into a
    // bare "write an email to elijah@lykn.io" sent a message he never saw.
    goal:
      "Send Sarah an email telling her the meeting moved.\n\nEmail task context:\n- Fill recipient, subject, and body completely.",
    userAsk: "Send Sarah an email telling her the meeting moved",
    controller,
    model,
    maxRounds: 12,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "waiting_for_user", `expected a confirmation pause, got ${result.status}: ${result.answer}`);
  assert.equal(result.needsApproval, true);
  assert.equal(fake.sendClicks, 0, "nothing may be delivered before the user says yes");
});

test("email: a send the user has just approved goes out without asking twice", async () => {
  const fake = makeGmailFake();
  const model = createScriptedModel({
    plan: { plan: ["Open compose", "Fill the draft", "Send it"], skills: ["communication"] },
    decisions: gmailComposeDecisions(),
  });
  const controller = createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });
  const result = await runBrowserAgentTask({
    goal:
      "Send Sarah an email telling her the meeting moved.\n\nEmail task context:\n- Fill recipient, subject, and body completely.",
    // The caller recognised this turn as the user approving the send it just
    // prepared, which is the only thing that authorizes the committing click.
    userAsk: "yes, send it",
    sendPolicy: "approved",
    controller,
    model,
    maxRounds: 12,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "completed", `expected completion, got ${result.status}: ${result.answer}`);
  assert.equal(fake.sendClicks, 1, "Send clicked exactly once");
  assert.match(result.answer, /sent/i);
});

test("email: after a verified send, leftover plan steps do not restart compose", async () => {
  const fake = makeGmailFake();
  const model = createScriptedModel({
    plan: { plan: ["Open Gmail", "Click Compose", "Fill the draft", "Send it"], skills: ["communication"] },
    decisions: [
      ...gmailComposeDecisions().slice(0, -1),
      // The model "forgets" it already sent and starts the task over.
      { kind: "act", action: { type: "click", target: "e1" }, expectedOutcome: "the compose window opens" },
      { kind: "act", action: { type: "click", target: "e5" }, expectedOutcome: "the message is sent" },
      { kind: "finish", answer: "Sent it again." },
    ],
  });
  const result = await runBrowserAgentTask({
    goal: "Send Sarah an email telling her the meeting moved.",
    userAsk: "yes, send it",
    sendPolicy: "approved",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 14,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "completed", `expected completion, got ${result.status}: ${result.answer}`);
  assert.equal(fake.sendClicks, 1, "must not send a second time after the first succeeded");
});

test("email: a finish after Send is accepted even with unmarked plan steps", async () => {
  const fake = makeGmailFake();
  const model = createScriptedModel({
    plan: { plan: ["Open Gmail", "Compose", "Fill", "Send"], skills: ["communication"] },
    decisions: [
      ...gmailComposeDecisions().slice(0, -1),
      { kind: "finish", answer: "Email sent — Gmail showed Message sent." },
    ],
  });
  const result = await runBrowserAgentTask({
    goal: "Send Sarah an email telling her the meeting moved.",
    userAsk: "yes, send it",
    sendPolicy: "approved",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 12,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "completed");
  assert.equal(fake.sendClicks, 1);
});

test("email: an approval reply cannot authorize spending or deletion", async () => {
  // "approved" releases a delivery and nothing else — money and destruction
  // always take their own interactive yes.
  const executor = require("./runtime/executor.cjs");
  const snapshot = { byRef: new Map([["e1", { label: "Place your order" }]]) };
  const buy = { action: { type: "click", target: "e1" }, expectedOutcome: "the order is placed" };
  assert.equal(executor.classifyActionRisk(buy, snapshot), "consequential");
  assert.equal(executor.goalAuthorizesAction("yes, send it", buy, snapshot), false);
});

test("email: sendPolicy 'ask' pauses for review even when the ask says send", async () => {
  const fake = makeGmailFake();
  const model = createScriptedModel({
    plan: { plan: ["Open compose", "Fill the draft", "Send it"], skills: ["communication"] },
    decisions: gmailComposeDecisions(),
  });
  const controller = createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });
  const result = await runBrowserAgentTask({
    goal:
      "Send Sarah an email telling her the meeting moved.\n\nEmail task context:\n- Fill recipient, subject, and body completely.",
    userAsk: "Send Sarah an email telling her the meeting moved",
    sendPolicy: "ask",
    controller,
    model,
    maxRounds: 12,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "waiting_for_user", `expected review pause, got ${result.status}: ${result.answer}`);
  assert.equal(result.needsApproval, true);
  assert.equal(fake.sendClicks, 0, "Send was never clicked before user review");
  // The pause is presented as a yes/no question the user answers inline, not as
  // an instruction to go inspect the browser and reply with a keyword.
  assert.match(result.answer, /want me to/i);
  assert.match(result.answer, /\?$/, "it should read as a question");
});

test("email: revision edits the draft in place instead of retyping it", async () => {
  const fake = makeGmailFake();
  // Compose window already open with a filled draft (as after a compose run).
  const inbox = fake.pages["https://mail.google.com/mail/u/0/"];
  inbox.text = "Inbox. New Message compose window open.";
  inbox.elements = [
    makeElement({ name: "compose", label: "Compose" }),
    makeElement({ name: "to", tag: "input", role: "combobox", label: "To recipients", value: "sarah@example.com" }),
    makeElement({ name: "subject", tag: "input", label: "Subject", value: "Meeting moved" }),
    makeElement({
      name: "body",
      tag: "textarea",
      role: "textbox",
      label: "Message Body",
      value: "Hi Sarah, the meeting moved to 3pm Thursday. Let me know if that works. Best, Sawyer",
    }),
    makeElement({ name: "send", label: "Send" }),
  ];
  const model = createScriptedModel({
    plan: { plan: ["Edit the meeting time in the open draft"], skills: ["communication"] },
    decisions: [
      {
        kind: "act",
        action: {
          type: "replace_text",
          target: "e4",
          find: "the meeting moved to 3pm Thursday",
          text: "the meeting moved to 4pm Friday",
        },
        expectedOutcome: "Body says 4pm Friday, rest of the draft untouched",
      },
      { kind: "finish", answer: "Updated the draft — it now says 4pm Friday." },
    ],
  });
  const controller = createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });
  const result = await runBrowserAgentTask({
    goal: "Change the meeting time in the draft to 4pm Friday",
    userAsk: "actually make it 4pm friday",
    controller,
    model,
    maxRounds: 8,
    userDataPath: path.join(os.tmpdir(), "lykn-browser-agent-test"),
  });
  assert.equal(result.status, "completed", `expected completion, got ${result.status}: ${result.answer}`);
  const body = inbox.elements.find((e) => e.label === "Message Body");
  assert.ok(body.value.includes("4pm Friday"), "edit landed");
  assert.ok(body.value.startsWith("Hi Sarah,"), "greeting preserved");
  assert.ok(body.value.includes("Best, Sawyer"), "sign-off preserved — body was not retyped");
  assert.equal(fake.sendClicks, 0, "revision never touches Send");
  const edit = result.history.find((h) => h.action?.type === "replace_text");
  assert.equal(edit?.result, "success");
});

// --- unit: context router keeps irrelevant skills out ---------------------------

test("context router: progressive skill loading", () => {
  assert.deepEqual(contextRouter.routeSkills("Research the best CRM for my company"), ["research"]);
  assert.ok(contextRouter.routeSkills("Find these shoes for the cheapest price").includes("shopping"));
  assert.ok(
    contextRouter.routeSkills("Send Sarah an email telling her the meeting moved").includes("communication"),
  );
  // Irrelevant skills stay out of context.
  assert.ok(!contextRouter.routeSkills("Send Sarah an email").includes("shopping"));
});

// --- unit: the operating rules are never routed away -----------------------------
//
// Browser and safety rules used to be selected per round by a heuristic. It
// routed the navigation rules out on every round after the first click — so
// the agent kept "never substitute a different product" and lost every rule
// about when moving on is correct — and it could not reach the download rules
// under any combination of inputs at all. They are one file each now, always
// loaded, and this test exists to keep them that way.

test("context router: every operating rule reaches every decision", () => {
  const task = { goal: "anything at all", skills: [] };
  const system = contextRouter.buildDecisionSystem({ task });
  for (const heading of [
    "# Observation",
    "# Navigation",
    "## Leaving the site you are on",
    "# Interaction",
    "# Forms",
    "# Editing existing text",
    "# Builders and visual editors",
    "# Tabs",
    "# Downloads",
    "# Recovery",
    "# Permissions",
    "# Purchases",
    "# Destructive actions",
    "# Credentials",
    "# Priorities",
  ]) {
    assert.ok(system.includes(heading), `${heading} must be in every decision prompt`);
  }
  // The counterweight to the site constraint has to be there, or the agent is
  // left with restrictions and no permission.
  assert.match(system, /Going to another website is ordinary browsing/);
});

test("planning contract never manufactures a site lock", () => {
  const planning = contextRouter.buildPlanningSystem();
  assert.match(planning, /Never write a constraint that forbids visiting other sites/);
  assert.ok(
    !/every step happens THERE/i.test(planning),
    "the instruction that turned a named app into a navigation ban must be gone",
  );
});

// --- dead ends are routed around, not handed back -------------------------------

test("a 404 is routed around without asking the user", async () => {
  // The run that prompted this landed on a not-found page and stopped with
  // "take it forward one step in the browser". Nothing was broken: the
  // navigation succeeded, so the retry ladder had no failure to escalate, and
  // the agent burned its recovery budget hunting for controls on an empty page.
  // One path segment, so the only place to back out to is the site root — the
  // fake browser matches unknown paths by host, which would otherwise hand the
  // dead page straight back and hide what is being tested.
  const DEAD = "https://shop.example.com/new-campaign";
  const ROOT = "https://shop.example.com/";
  const fake = createFakeBrowser({
    [DEAD]: { title: "Page not found", text: "404 — we can't find that page.", elements: [] },
    [ROOT]: {
      title: "Shop",
      text: "Welcome to Shop. Campaigns Audience Reports",
      elements: [makeElement({ name: "campaigns", tag: "a", label: "Campaigns", href: `${ROOT}campaigns` })],
    },
  });

  const seenByModel = [];
  const model = createScriptedModel({
    plan: { plan: ["Open the campaign builder", "Create the campaign"] },
    decisions: [
      () => {
        seenByModel.push(fake.state.url);
        return {
          kind: "act",
          action: { type: "navigate", url: DEAD },
          expectedOutcome: "the campaign builder",
        };
      },
      () => {
        seenByModel.push(fake.state.url);
        return { kind: "finish", answer: "Created the campaign." };
      },
    ],
  });

  const result = await runTask({ fake, model, goal: "Create a campaign in Shop" });

  assert.equal(result.status, "completed", "a dead link must not end the run");
  // The agent got itself off the dead page on its own: after the round that
  // walked into it, every later decision was taken from a page that exists.
  assert.equal(seenByModel[0], "about:blank");
  assert.ok(seenByModel.length >= 2, "the run must continue past the dead end");
  assert.deepEqual(
    [...new Set(seenByModel.slice(1))],
    [ROOT],
    `no decision may be taken from the dead page: ${JSON.stringify(seenByModel)}`,
  );
  assert.equal(fake.state.url, ROOT);
  // And it wrote down where the wall was, so it cannot wander back in.
  assert.ok(
    result.task.workingMemory.facts.some((f) => f.includes(DEAD) && /dead end/i.test(f)),
    `the dead end should be recorded: ${JSON.stringify(result.task.workingMemory.facts)}`,
  );
});

// --- unit: type verification tolerates editor whitespace rewrites ---------------

test("verifier: typed text verifies despite contenteditable newline inflation", async () => {
  const verifier = require("./runtime/verifier.cjs");
  const typed = "Hi Elijah,\n\nQuick update: the office raccoon has reviewed our processes.";
  // Gmail's body renders "\n\n" back as "\n\n\n" — must still verify as landed,
  // otherwise the agent retypes the whole body in a loop.
  const result = await verifier.verifyOutcome({
    model: null,
    decision: { action: { type: "type", target: "e10", text: typed } },
    actionResult: { ok: true },
    before: null,
    after: null,
    diff: { urlChanged: false, titleChanged: false, textChanged: true, newLabels: [], summary: "" },
    extracted: { ok: true, label: "Message Body", value: typed.replace("\n\n", "\n\n\n") },
  });
  assert.equal(result.success, true, result.reason);
  assert.equal(result.method, "deterministic");
});

// --- unit: the task is a full brief, not a bare goal line ------------------------

test("task state renders as TASK / SUCCESS CONDITION / SCOPE / DO NOT / STOP RULE", () => {
  const taskState = require("./runtime/taskState.cjs");
  const task = taskState.createTask({ goal: "Check the user's email." });
  taskState.setPlan(task, {
    plan: ["Open the inbox", "Read the unread messages"],
    successCondition: "The inbox has been accessed and the requested email state has been observed.",
    doNot: ["Draft replies.", "Send messages.", "Organize or modify the inbox."],
  });

  const rendered = taskState.formatTaskForModel(task);
  assert.match(rendered, /^TASK:\nCheck the user's email\./);
  assert.match(rendered, /SUCCESS CONDITION:\nThe inbox has been accessed/);
  assert.match(rendered, /SCOPE:\nPerform only actions strictly necessary to satisfy the user's literal request\./);
  assert.match(rendered, /DO NOT:\n- Draft replies\.\n- Send messages\.\n- Organize or modify the inbox\./);
  // The standing wall against scope creep is always present, even with a
  // task-specific list above it.
  assert.match(rendered, /- Continue looking for additional useful work\./);
  assert.match(rendered, /STOP RULE:\nAs soon as the success condition is satisfied, finish\./);
});

test("the brief has fallbacks, survives a silent replan, and round-trips persistence", () => {
  const taskState = require("./runtime/taskState.cjs");

  // No planner output at all (plan call failed): generic but complete brief.
  const bare = taskState.createTask({ goal: "book a table" });
  taskState.setPlan(bare, { plan: ["Work toward: book a table"] });
  const fallback = taskState.formatTaskForModel(bare);
  assert.match(fallback, /SUCCESS CONDITION:\nThe user's literal request has been satisfied/);
  assert.match(fallback, /STOP RULE:/);

  // A replan that says nothing about the brief must not erase it — the route
  // changed, not what "done" means.
  const task = taskState.createTask({ goal: "g" });
  taskState.setPlan(task, {
    plan: ["a"],
    successCondition: "The table is booked and the confirmation screen shows it.",
    doNot: ["Book anything else."],
  });
  taskState.setPlan(task, { plan: ["b — different route"] });
  assert.equal(task.successCondition, "The table is booked and the confirmation screen shows it.");
  assert.deepEqual(task.doNot, ["Book anything else."]);

  // And it survives an app restart with the rest of the task.
  const restored = taskState.restoreTask(JSON.parse(JSON.stringify(taskState.serializeTask(task))));
  assert.equal(restored.successCondition, task.successCondition);
  assert.deepEqual(restored.doNot, task.doNot);
});
