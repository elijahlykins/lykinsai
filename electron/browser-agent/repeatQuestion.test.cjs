/**
 * A simple email used to turn into a stack of questions — body, then tone,
 * then subject — each in a different-looking box. After the user answers
 * what the message should say, further writing questions are skipped.
 *
 * Run: node --test electron/browser-agent/repeatQuestion.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const {
  runBrowserAgentTask,
  createBrowserController,
  isContentQuestion,
  contentAlreadyAnswered,
  shouldSkipRepeatQuestion,
  questionsSimilar,
} = require("./index.cjs");

const TMP = path.join(os.tmpdir(), "lykn-repeat-question-test");

const HISTORY = [
  { role: "user", content: "send an email to sam@example.com" },
  { role: "assistant", content: "What should this email say?" },
  { role: "user", content: "Just a quick check-in about the launch" },
];

test("what-should-it-say is a content question", () => {
  assert.equal(isContentQuestion("What should this email say?"), true);
  assert.equal(isContentQuestion("What tone should they use?"), true);
  assert.equal(isContentQuestion("What subject line would you like?"), true);
  assert.equal(isContentQuestion("When should they go out?"), true);
});

test("a password ask is not a content question", () => {
  assert.equal(isContentQuestion("I need your password to sign in"), false);
});

test("a permission ask is not a content question", () => {
  assert.equal(isContentQuestion("Do you want me to send it?"), false);
});

test("the conversation has an answer once the user replies to a content ask", () => {
  assert.equal(contentAlreadyAnswered(HISTORY), true);
  assert.equal(
    contentAlreadyAnswered([
      { role: "user", content: "send an email to sam@example.com" },
    ]),
    false,
  );
  assert.equal(
    contentAlreadyAnswered([
      { role: "user", content: "email sam" },
      { role: "assistant", content: "What should this email say?" },
    ]),
    false,
    "an unanswered ask must still reach the user",
  );
});

test("a second writing question is skipped after they already answered", () => {
  assert.equal(shouldSkipRepeatQuestion("What tone should they use?", HISTORY), true);
  assert.equal(shouldSkipRepeatQuestion("What subject line would you like?", HISTORY), true);
  assert.equal(
    shouldSkipRepeatQuestion("What should this email say?", HISTORY),
    true,
    "the same ask restated is still a repeat",
  );
});

test("a credential still reaches the user after a content answer", () => {
  assert.equal(
    shouldSkipRepeatQuestion("Please enter the verification code that was just sent", HISTORY),
    false,
  );
});

test("the first content question is never skipped", () => {
  assert.equal(
    shouldSkipRepeatQuestion("What should this email say?", [
      { role: "user", content: "send an email to sam@example.com" },
    ]),
    false,
  );
});

// The host folds the user's reply onto the original ask. Real chat history
// often never recorded the question itself — only the step boxes — so the
// skip has to notice the folded line, not hunt for a "what should it say?"
// assistant message that was never stored.
const FOLDED_HISTORY = [
  { role: "user", content: "send an email to sam@example.com" },
  { role: "assistant", content: "Looking at Gmail\nOpened Inbox" },
  { role: "user", content: "Just a quick check-in about the launch" },
  {
    role: "user",
    content:
      "send an email to sam@example.com\nAdditional guidance from the user: Just a quick check-in about the launch",
  },
];

test("a folded reply counts as an answer even when history dropped the ask", () => {
  assert.equal(contentAlreadyAnswered(FOLDED_HISTORY), true);
  assert.equal(
    shouldSkipRepeatQuestion("What should this email say?", FOLDED_HISTORY),
    true,
  );
});

test("additional guidance on the current goal is enough to skip", () => {
  assert.equal(
    shouldSkipRepeatQuestion(
      "What should this email say?",
      [{ role: "user", content: "send an email to sam@example.com" }],
      "send an email to sam@example.com\nAdditional guidance from the user: just a check-in",
    ),
    true,
  );
});

test("the same ask is skipped after they replied, even when it is not a writing question", () => {
  const hist = [
    { role: "user", content: "book a table" },
    { role: "assistant", content: "Which restaurant did you have in mind?" },
    { role: "user", content: "The Italian place on Main" },
  ];
  assert.equal(
    shouldSkipRepeatQuestion("Which restaurant did you have in mind?", hist),
    true,
  );
  assert.equal(
    shouldSkipRepeatQuestion("What time should I book?", hist),
    false,
    "a different ask still reaches the user",
  );
});

test("a question buried in a step transcript still matches the next ask", () => {
  assert.equal(
    questionsSimilar(
      "What should this email say?",
      "Looking at Gmail\n\nOpened Inbox\n\n---\n\nWhat should this email say?",
    ),
    true,
  );
});

function makeComposeFake() {
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://mail.google.com/mail/u/0/#inbox",
    getTitle: () => "Inbox",
    executeJavaScript: async () => null,
  };
  const actuator = {
    async navigate() { return { ok: true }; },
    async getDOMCatalog() {
      return {
        ok: true,
        url: "https://mail.google.com/mail/u/0/#inbox",
        title: "Inbox",
        items: [
          { uid: 1, tag: "button", role: "button", label: "Compose", inView: true },
        ],
      };
    },
    async getPageContext() {
      return { ok: true, url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox", text: "Inbox" };
    },
    async runAction() { return { ok: true, type: "click" }; },
    async screenshotDataUrl() { return "data:image/jpeg;base64,ZmFrZQ=="; },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };
  return { webContents, actuator };
}

test("the loop does not park on a second content question", async () => {
  const fake = makeComposeFake();
  let decideN = 0;
  const model = {
    async plan() {
      return {
        plan: ["Write the email"],
        constraints: [],
        knownFacts: {},
        skills: [],
        clarification: "What tone should they use?",
      };
    },
    async decide() {
      decideN += 1;
      if (decideN === 1) {
        return {
          kind: "ask_user",
          question: "What tone should they use?",
          questionOptions: ["Casual", "Formal"],
          factsLearned: [],
          candidateResults: [],
        };
      }
      return {
        kind: "finish",
        answer: "I'll write a short check-in about the launch.",
        reason: "goal achieved",
        factsLearned: [],
        candidateResults: [],
      };
    },
    async verify() { return { success: true, evidence: "", reason: "", next: "continue" }; },
    async learn() { return { notes: [], userNotes: [] }; },
  };
  const result = await runBrowserAgentTask({
    goal: "send an email to sam@example.com",
    userAsk: "Just a quick check-in about the launch",
    conversationHistory: HISTORY,
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 4,
    userDataPath: TMP,
  });
  await result.learning;
  assert.notEqual(
    result.status,
    "waiting_for_user",
    "a follow-up tone/subject ask must not stop the run",
  );
  assert.ok(decideN >= 1, "the actor was told to continue rather than park");
});

test("a folded answer does not park on the same plan-time question", async () => {
  const fake = makeComposeFake();
  let decideN = 0;
  const model = {
    async plan() {
      return {
        plan: ["Write the email"],
        constraints: [],
        knownFacts: {},
        skills: [],
        clarification: "What should this email say?",
      };
    },
    async decide() {
      decideN += 1;
      return {
        kind: "finish",
        answer: "I'll write a short check-in about the launch.",
        reason: "goal achieved",
        factsLearned: [],
        candidateResults: [],
      };
    },
    async verify() { return { success: true, evidence: "", reason: "", next: "continue" }; },
    async learn() { return { notes: [], userNotes: [] }; },
  };
  const result = await runBrowserAgentTask({
    goal: "send an email to sam@example.com\nAdditional guidance from the user: Just a quick check-in about the launch",
    userAsk: "Just a quick check-in about the launch",
    conversationHistory: FOLDED_HISTORY,
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 4,
    userDataPath: TMP,
  });
  await result.learning;
  assert.notEqual(
    result.status,
    "waiting_for_user",
    "the same writing question must not stop the run after they already answered",
  );
  assert.ok(decideN >= 1, "the actor started the work instead of asking again");
});
