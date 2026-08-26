/**
 * Knowing when to stop and when to ask.
 *
 * Three failure modes this file pins down:
 *
 * 1. Two-delivery goals ("email Alice and text Bob") were read as one
 *    outcome, so the first send marked the whole plan done and the second
 *    delivery was refused as "restarting" — half the task silently dropped.
 * 2. Recipient questions ("Who should I send this to?") matched the
 *    permission patterns, were refused as punts, and after three refusals
 *    escalated onto Yes/No approval buttons — where a typed name was the only
 *    possible answer.
 * 3. A run whose plan was entirely done kept browsing with nothing telling it
 *    the goal was met.
 *
 * Run: node --test electron/browser-agent/finishDiscipline.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const {
  runBrowserAgentTask,
  createBrowserController,
  isSingleOutcomeGoal,
  isRecipientQuestion,
  looksLikePermissionQuestion,
  requiresHumanInput,
  shouldSkipRepeatQuestion,
} = require("./index.cjs");

const TMP = path.join(os.tmpdir(), "lykn-finish-discipline-test");

// --- What counts as one outcome -------------------------------------------

test("a plain one-delivery ask is a single outcome", () => {
  assert.equal(isSingleOutcomeGoal("send an email to sam@example.com"), true);
  assert.equal(isSingleOutcomeGoal("go to gmail and send an email to alice"), true);
  assert.equal(isSingleOutcomeGoal("share the Q3 folder with the finance team"), true);
  assert.equal(isSingleOutcomeGoal("send an email to alice@x.com and bob@y.com"), true);
});

test("a search that ends in one commitment is still a single outcome", () => {
  assert.equal(isSingleOutcomeGoal("find a flight to Denver and book it"), true);
});

test("two deliveries joined by a bare 'and' are two outcomes", () => {
  assert.equal(isSingleOutcomeGoal("email Alice the report and text Bob about the meeting"), false);
  assert.equal(isSingleOutcomeGoal("send the report to Alice and post it on Slack"), false);
  assert.equal(isSingleOutcomeGoal("buy the tickets and email me the receipt"), false);
  assert.equal(isSingleOutcomeGoal("reply to Sam's email and forward it to Jess"), false);
});

test("'and then' still marks two jobs", () => {
  assert.equal(isSingleOutcomeGoal("buy the monitor and then email the receipt to accounting"), false);
});

test("delivery nouns never count as a second job", () => {
  assert.equal(isSingleOutcomeGoal("open my email and read Sam's message"), true);
  assert.equal(isSingleOutcomeGoal("send an email to alice and bob asking them to reply"), true);
});

// --- Recipient questions are input, not permission -------------------------

test("who-should-I-send-this-to is a recipient question, not a permission ask", () => {
  for (const q of [
    "Who should I send this to?",
    "Who do you want this sent to?",
    "Whom should I email about this?",
    "What email address should the report go to?",
    "Where should I send the link?",
    "Who would you like to invite?",
  ]) {
    assert.equal(isRecipientQuestion(q), true, q);
    assert.equal(looksLikePermissionQuestion(q), false, `${q} must not be refused as a punt`);
    assert.equal(requiresHumanInput(q), true, `${q} is a fact only the user has`);
  }
});

test("permission and content questions are unaffected", () => {
  assert.equal(looksLikePermissionQuestion("Do you want me to send it?"), true);
  assert.equal(looksLikePermissionQuestion("Should I click Compose?"), true);
  assert.equal(isRecipientQuestion("What should this email say?"), false);
  assert.equal(isRecipientQuestion("Who is the CEO of Apple?"), false);
  assert.equal(isRecipientQuestion("Who won the game last night?"), false);
});

test("a recipient ask survives the one-question rule after a content answer", () => {
  const history = [
    { role: "user", content: "send a thank-you note" },
    { role: "assistant", content: "What should this note say?" },
    { role: "user", content: "Thanks for the great work on the launch" },
  ];
  assert.equal(
    shouldSkipRepeatQuestion("Who should I send this to?", history),
    false,
    "knowing what to say does not reveal who it goes to",
  );
  assert.equal(
    shouldSkipRepeatQuestion("What tone should it have?", history),
    true,
    "writing follow-ups are still suppressed",
  );
});

test("a recipient ask that was already answered is not asked again", () => {
  const history = [
    { role: "user", content: "send a thank-you note" },
    { role: "assistant", content: "Who should I send this to?" },
    { role: "user", content: "sam@example.com" },
  ];
  assert.equal(shouldSkipRepeatQuestion("Who should I send this to?", history), true);
});

// --- Loop behavior ----------------------------------------------------------

/**
 * A fake mail-ish page: two send buttons, and the visible text grows a
 * "Message sent to X" line after each is clicked, so the deterministic
 * verifier can confirm each delivery from the page.
 */
function makeTwoDeliveryFake() {
  const state = { clicks: 0, url: "https://mail.example.com/compose" };
  const textNow = () =>
    ["Compose ready", state.clicks >= 1 ? "Message sent to Alice" : "", state.clicks >= 2 ? "Message sent to Bob" : ""]
      .filter(Boolean)
      .join(". ");
  const webContents = {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => "Mail",
    executeJavaScript: async () => null,
  };
  const actuator = {
    async navigate(_wc, url) {
      state.url = String(url || state.url);
      return { ok: true };
    },
    async getDOMCatalog() {
      return {
        ok: true,
        url: state.url,
        title: "Mail",
        items: [
          { uid: 1, tag: "button", role: "button", label: "Send to Alice", inView: true },
          { uid: 2, tag: "button", role: "button", label: "Send to Bob", inView: true },
        ],
      };
    },
    async getPageContext() {
      return { ok: true, url: state.url, title: "Mail", text: textNow() };
    },
    async runAction(_wc, action) {
      if (String(action?.type || "") === "click") state.clicks += 1;
      return { ok: true, type: action?.type || "click" };
    },
    async screenshotDataUrl() {
      return "data:image/jpeg;base64,ZmFrZQ==";
    },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };
  return { webContents, actuator, state };
}

/**
 * The current-generation ref for the element carrying `label`, read off the
 * observation text the loop hands the model. Refs (`g{gen}:{uid}`) are
 * re-minted on every snapshot, so the model must re-read one each round —
 * a hardcoded ref would classify as malformed or stale.
 */
function refFor(user, label) {
  const re = new RegExp(`\\[(g\\d+:[^\\]\\s]+)\\][^\\n]*"${label}"`);
  const m = re.exec(String(user || ""));
  assert.ok(m, `the observation must list an element labeled "${label}"`);
  return m[1];
}

test("the second delivery of a two-part ask still runs instead of being finished away", async () => {
  const fake = makeTwoDeliveryFake();
  let decideN = 0;
  let approvals = 0;
  const model = {
    async plan() {
      return {
        plan: ["Send the note to Alice", "Send the note to Bob"],
        constraints: [],
        knownFacts: {},
        skills: [],
        clarification: "",
      };
    },
    async decide({ user }) {
      decideN += 1;
      if (decideN === 1) {
        return {
          kind: "act",
          action: { type: "click", target: refFor(user, "Send to Alice") },
          expectedOutcome: "the message to Alice is sent",
          planStepCompleted: true,
          risk: "consequential",
          reason: "sending the first note",
          factsLearned: [],
          candidateResults: [],
        };
      }
      if (decideN === 2) {
        return {
          kind: "act",
          action: { type: "click", target: refFor(user, "Send to Bob") },
          expectedOutcome: "the message to Bob is sent",
          planStepCompleted: true,
          risk: "consequential",
          reason: "sending the second note",
          factsLearned: [],
          candidateResults: [],
        };
      }
      return {
        kind: "finish",
        answer: "Both notes are sent — Alice and Bob each have one.",
        reason: "goal achieved",
        factsLearned: [],
        candidateResults: [],
      };
    },
    async verify() {
      return { success: true, evidence: "", reason: "", next: "continue" };
    },
    async learn() {
      return { notes: [], userNotes: [] };
    },
  };
  const result = await runBrowserAgentTask({
    goal: "email Alice the note and message Bob the same thing",
    userAsk: "email Alice the note and message Bob the same thing",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 8,
    userDataPath: TMP,
    onApprovalNeeded: async () => {
      approvals += 1;
      return true;
    },
  });
  await result.learning;
  assert.equal(result.status, "completed", result.answer);
  assert.equal(fake.state.clicks, 2, "both deliveries actually ran");
  assert.equal(approvals, 2, "each delivery was confirmed on its own");
});

test("a one-part ask still refuses to restart after the delivery", async () => {
  const fake = makeTwoDeliveryFake();
  let decideN = 0;
  let approvals = 0;
  const model = {
    async plan() {
      return {
        plan: ["Send the note to Alice"],
        constraints: [],
        knownFacts: {},
        skills: [],
        clarification: "",
      };
    },
    async decide({ user }) {
      decideN += 1;
      if (decideN === 1) {
        return {
          kind: "act",
          action: { type: "click", target: refFor(user, "Send to Alice") },
          expectedOutcome: "the message to Alice is sent",
          planStepCompleted: true,
          risk: "consequential",
          reason: "sending the note",
          factsLearned: [],
          candidateResults: [],
        };
      }
      // The model tries to send again — the loop must finish instead.
      return {
        kind: "act",
        action: { type: "click", target: refFor(user, "Send to Bob") },
        expectedOutcome: "the message is sent",
        planStepCompleted: false,
        risk: "consequential",
        reason: "sending again",
        factsLearned: [],
        candidateResults: [],
      };
    },
    async verify() {
      return { success: true, evidence: "", reason: "", next: "continue" };
    },
    async learn() {
      return { notes: [], userNotes: [] };
    },
  };
  const result = await runBrowserAgentTask({
    goal: "send the note to Alice",
    userAsk: "send the note to Alice",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 6,
    userDataPath: TMP,
    onApprovalNeeded: async () => {
      approvals += 1;
      return true;
    },
  });
  await result.learning;
  assert.equal(result.status, "completed", result.answer);
  assert.equal(fake.state.clicks, 1, "the delivery ran exactly once");
  assert.equal(approvals, 1, "no second approval was ever requested");
});

/** A fake page for a research task: navigation works, nothing else needed. */
function makeResearchFake() {
  const state = { url: "https://www.example.com" };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => "Example",
    executeJavaScript: async () => null,
  };
  const actuator = {
    async navigate(_wc, url) {
      state.url = String(url || state.url);
      return { ok: true };
    },
    async getDOMCatalog() {
      return {
        ok: true,
        url: state.url,
        title: "Example",
        items: [{ uid: 1, tag: "a", role: "link", label: "Widget", href: `${state.url}/widget`, inView: true }],
      };
    },
    async getPageContext() {
      return { ok: true, url: state.url, title: "Example", text: "The widget costs $30" };
    },
    async runAction() {
      return { ok: true };
    },
    async screenshotDataUrl() {
      return "data:image/jpeg;base64,ZmFrZQ==";
    },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };
  return { webContents, actuator, state };
}

test("a run whose plan is done is nudged to finish instead of browsing on", async () => {
  const fake = makeResearchFake();
  const decideUsers = [];
  let decideN = 0;
  const model = {
    async plan() {
      return {
        plan: ["Find the price of the widget"],
        constraints: [],
        knownFacts: {},
        skills: [],
        clarification: "",
      };
    },
    async decide({ user }) {
      decideN += 1;
      decideUsers.push(String(user || ""));
      if (decideN === 1) {
        return {
          kind: "act",
          action: { type: "navigate", url: "https://shop.example.com/widget" },
          expectedOutcome: "the widget page is shown",
          planStepCompleted: true,
          reason: "opening the product page",
          factsLearned: ["the widget costs $30"],
          candidateResults: [],
        };
      }
      if (decideN === 2) {
        // The goal is met, but the model wants to keep looking around.
        return {
          kind: "act",
          action: { type: "scroll", direction: "down" },
          expectedOutcome: "more of the page is visible",
          reason: "double-checking",
          factsLearned: [],
          candidateResults: [],
        };
      }
      return {
        kind: "finish",
        answer: "The widget costs $30.",
        reason: "goal achieved",
        factsLearned: [],
        candidateResults: [],
      };
    },
    async verify() {
      return { success: true, evidence: "", reason: "", next: "continue" };
    },
    async learn() {
      return { notes: [], userNotes: [] };
    },
  };
  const result = await runBrowserAgentTask({
    goal: "find the price of the widget",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 6,
    userDataPath: TMP,
  });
  await result.learning;
  assert.equal(result.status, "completed", result.answer);
  assert.equal(decideN, 3, "the wandering action was intercepted, not executed");
  assert.match(
    decideUsers[2],
    /Every planned step is already marked done/,
    "the third decision was told the plan is complete",
  );
});
