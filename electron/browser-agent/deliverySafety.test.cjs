/**
 * Nothing goes out to another person without the user's yes — and the agent
 * never writes the substance of it on their behalf.
 *
 * This file exists because of one run. The user typed, in full:
 *
 *     write an email to elijah@lykn.io
 *
 * and the agent composed a message about a link to google.com — the page that
 * happened to be open — and sent it, unshown and unconfirmed. Three separate
 * mechanisms had to line up for that:
 *
 *   1. A bare compose ask was read as "share the page I'm looking at", which
 *      synthesized an instruction naming both a recipient and a body.
 *   2. That synthesized instruction became the text the safety gate judged, so
 *      its word "Send" read as the user asking for a send.
 *   3. Delivery was authorized by wording at all, rather than by an answer.
 *
 * Each is pinned below. Run:
 *   node --test electron/browser-agent/deliverySafety.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const executor = require("./runtime/executor.cjs");
const { looksLikeShareCurrentPageAsk } = require("../ownedBrowserAct.cjs");
const {
  runBrowserAgentTask,
  createBrowserController,
  looksLikePermissionQuestion,
  permissionAskIsConsequential,
} = require("./index.cjs");

const TMP = path.join(os.tmpdir(), "lykn-delivery-safety");

// ── 1. a compose ask is not a share-this-page ask ───────────────────────────

test("writing an email to someone is not sharing whatever page is open", () => {
  for (const ask of [
    "write an email to elijah@lykn.io",
    "can you write out an email to elijah@lykn.io",
    "compose a message to sam@example.com",
    "draft a quick note to bob@x.com",
    "send an email to elijah@lykn.io",
  ]) {
    assert.equal(
      looksLikeShareCurrentPageAsk(ask),
      false,
      `"${ask}" asks the agent to write something, not to share the open page`,
    );
  }
});

test("an ask that does point at the page still shares it", () => {
  for (const ask of [
    "share this doc with elijah@lykn.io",
    "email this page to sam@example.com",
    "send that to bob@x.com",
    "invite sarah@example.com to this document",
  ]) {
    assert.equal(looksLikeShareCurrentPageAsk(ask), true, `"${ask}" is about what is on screen`);
  }
});

// ── 2 & 3. wording never authorizes a delivery ──────────────────────────────

/** A Gmail-ish page whose Send button is the only consequential control. */
function makeComposeFake() {
  const state = {
    url: "https://mail.google.com/compose",
    title: "Compose",
    text: "New message. To. Subject. Body.",
    sendClicks: 0,
  };
  const elements = [
    { uid: 1, id: "send", tag: "div", role: "button", selector: "#send", label: "Send ‪(⌘Enter)‬", clientX: 60, clientY: 500, inView: true },
  ];
  return {
    state,
    webContents: {
      isDestroyed: () => false,
      getURL: () => state.url,
      getTitle: () => state.title,
      executeJavaScript: async () => null,
    },
    actuator: {
      async getDOMCatalog() {
        return { ok: true, url: state.url, title: state.title, items: elements };
      },
      async getPageContext() {
        return { ok: true, url: state.url, title: state.title, text: state.text };
      },
      async runAction(_w, action) {
        if (String(action.selector || "") === "#send") {
          state.sendClicks += 1;
          state.text = "Your message has been sent.";
        }
        return { ok: true };
      },
      async screenshotDataUrl() { return "data:image/jpeg;base64,ZmFrZQ=="; },
      async waitForLoad() {},
      async waitForDomSettle() {},
    },
  };
}

function sendingModel() {
  let i = 0;
  return {
    async plan() {
      return { plan: ["Send the draft"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide() {
      i += 1;
      if (i === 1) {
        return {
          kind: "act",
          action: { type: "click", target: "e1" },
          reason: "", narration: "", expectedOutcome: "the message is sent",
          risk: "low", answer: "", question: "", replanReason: "", constraints: null,
          steps: null, planStepCompleted: true, factsLearned: [], candidateResults: [],
          questionOptions: [],
        };
      }
      return {
        kind: "finish", action: null, answer: "The email was sent.",
        reason: "", narration: "", expectedOutcome: "", risk: "low", question: "",
        replanReason: "", constraints: null, steps: null, planStepCompleted: true,
        factsLearned: ["the message was sent"], candidateResults: [], questionOptions: [],
      };
    },
    async verify() { return { success: true, evidence: "sent", reason: "", next: "continue" }; },
    async learn() { return { notes: [], userNotes: [] }; },
  };
}

async function runSend({ goal, userAsk, sendPolicy }) {
  const fake = makeComposeFake();
  const result = await runBrowserAgentTask({
    goal,
    userAsk,
    ...(sendPolicy ? { sendPolicy } : {}),
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model: sendingModel(),
    maxRounds: 6,
    userDataPath: TMP,
  });
  await result.learning;
  return { result, sends: fake.state.sendClicks };
}

test("an instruction line that says Send cannot approve its own send", async () => {
  // The exact shape of the incident: the runtime's synthesized instruction is
  // in the goal, and the user's own words asked for nothing of the kind.
  const { result, sends } = await runSend({
    goal:
      "can you write out an email to elijah@lykn.io\n" +
      "Send a Gmail email to elijah@lykn.io. The ENTIRE body is: one short friendly sentence introducing the link.",
    userAsk: "can you write out an email to elijah@lykn.io",
  });
  assert.equal(sends, 0, "the message must not go out unconfirmed");
  assert.equal(result.status, "waiting_for_user");
  assert.equal(result.needsApproval, true);
});

test("a goal with no userAsk at all is never treated as consent", async () => {
  // Nothing said the user asked for this. Silence is not approval.
  const { result, sends } = await runSend({
    goal: "Send the prepared email to elijah@lykn.io.",
    userAsk: "",
  });
  assert.equal(sends, 0);
  assert.equal(result.status, "waiting_for_user");
});

test("an explicit send request confirms once, then goes out on approval", async () => {
  const asked = await runSend({
    goal: "Send Sarah the meeting update.",
    userAsk: "send Sarah the meeting update",
  });
  assert.equal(asked.sends, 0, "even a plain send request is shown before it is sent");

  const approved = await runSend({
    goal: "Send Sarah the meeting update.",
    userAsk: "yes send it",
    sendPolicy: "approved",
  });
  assert.equal(approved.sends, 1, "once approved it goes, without a second question");
  assert.equal(approved.result.status, "completed");
});

test("the risk classifier still calls a Send button consequential", () => {
  const snapshot = { byRef: new Map([["e1", { label: "Send ‪(⌘Enter)‬" }]]) };
  const decision = { action: { type: "click", target: "e1" }, expectedOutcome: "the message is sent" };
  assert.equal(executor.classifyActionRisk(decision, snapshot), "consequential");
  assert.equal(executor.consequenceKind(decision, snapshot), "outbound");
});

// ── the gate must not cry wolf ──────────────────────────────────────────────
//
// Aiming by description puts PROSE in `action.label` — "the Add people field
// in the FINAL sharing dialog" — and the outbound patterns were written for
// short button labels, where "sharing" means this control sends something.
// Inside a sentence describing a text box it means nothing of the kind. The
// result was an approval prompt ("want me to perform click_coord?") before
// every click into an empty field, which trains the user to wave the gate
// through — the one habit that makes the real prompt worthless.

const noSnapshot = { byRef: new Map() };
const risk = (action, expectedOutcome = "") =>
  executor.classifyActionRisk({ action, expectedOutcome }, noSnapshot);

test("clicking into a field inside a Share dialog asks for nothing", () => {
  assert.equal(
    risk({ type: "click_coord", x: 1, y: 1, label: "Add people field in the FINAL sharing dialog" }),
    "low",
  );
});

test("typing into that field asks for nothing either", () => {
  assert.equal(
    risk({
      type: "type_coord",
      x: 1,
      y: 1,
      text: "sam@example.com",
      label: 'the "Add people, groups, spaces" field at the top of the Share "FINAL" dialog',
    }),
    "low",
    "putting text somewhere delivers nothing — only committing it does",
  );
});

test("the control that actually sends is still consequential, described or not", () => {
  assert.equal(risk({ type: "click_coord", x: 1, y: 1, label: "the blue Send button in the toolbar" }), "consequential");
  assert.equal(risk({ type: "click_coord", x: 1, y: 1, label: "Share" }), "consequential");
  assert.equal(
    risk({ type: "click_coord", x: 1, y: 1, label: "the round blue icon" }, "the message is sent"),
    "consequential",
    "an unlabeled control that says it sends is judged on what it says it does",
  );
});

test("opening a composer is not sending, even when the label mentions send", () => {
  assert.equal(risk({ type: "click", target: "e1", label: "Reply" }), "low");
  assert.equal(risk({ type: "click", target: "e1", label: "Forward" }), "low");
  assert.equal(
    risk({
      type: "click_coord",
      x: 1,
      y: 1,
      label: "the Compose button so I can send an email to elijah@lykn.io",
    }),
    "low",
    "send in the purpose of the click is not the click",
  );
  assert.equal(
    risk({ type: "click_coord", x: 1, y: 1, label: "Compose button to send email" }),
    "low",
  );
});

test("permission questions about mid-flow clicks are not treated as commits", () => {
  assert.equal(looksLikePermissionQuestion("Is it ok if I click Compose?"), true);
  assert.equal(permissionAskIsConsequential("Is it ok if I click Compose?"), false);
  assert.equal(permissionAskIsConsequential("Should I click Reply to start the email?"), false);
  assert.equal(permissionAskIsConsequential("Can I click the Inbox button?"), false);
  assert.equal(permissionAskIsConsequential("Is it ok if I click Send?"), true);
  assert.equal(permissionAskIsConsequential("Are you ready for me to send it?"), true);
  assert.equal(permissionAskIsConsequential("Shall I go ahead and share the folder?"), true);
});

test("Enter inside a recipient field still counts as the send it is", () => {
  assert.equal(
    risk({ type: "type_coord", x: 1, y: 1, text: "sam@example.com", label: "To recipients", pressEnter: true }),
    "consequential",
  );
});

test("clicking a composer field is never a send, whatever the model expects", () => {
  // The exact prompt the user got: the model wrote "the message is sent" as
  // the outcome of focusing Gmail's To box, and the gate asked Yes/No.
  assert.equal(
    clickRisk("To recipients", "combobox", "the message is sent"),
    "low",
    "Gmail To recipients must not ask for approval",
  );
  assert.equal(clickRisk("Subject", "textbox", "the email is sent"), "low");
  assert.equal(clickRisk("Message Body", "textbox", "the message is sent"), "low");
  assert.equal(clickRisk("To", "combobox", "the email will be sent"), "low");
  assert.equal(
    risk({ type: "click_coord", x: 1, y: 1, label: "To recipients" }, "the message is sent"),
    "low",
  );
  assert.equal(
    clickRisk("Send", "button", "the message is sent"),
    "consequential",
    "the real Send still pauses",
  );
});

// ── a menu is not a button ──────────────────────────────────────────────────
//
// A container's accessible name is the text of everything inside it, so a
// right-click menu in Drive arrived as one long "label" holding Share, Move to
// trash and Delete at once. The gate read that as a click which shares and
// deletes, and asked the user to approve — quoting the whole menu back at
// them. Opening a menu commits nothing; the item you then pick does.

const MENU_BLOB =
  "Download Rename ⌥⌘E Set up an automation Share Organize Folder information Move to trash Delete";

const withEl = (label, role) => ({ byRef: new Map([["e1", { label, role }]]) });
const clickRisk = (label, role, expectedOutcome = "") =>
  executor.classifyActionRisk(
    { action: { type: "click", target: "e1" }, expectedOutcome },
    withEl(label, role),
  );

test("clicking a menu whose contents mention Delete asks for nothing", () => {
  assert.equal(clickRisk(MENU_BLOB, "menu"), "low");
  // Role is often missing entirely; the words alone must still give it away.
  assert.equal(clickRisk(MENU_BLOB, ""), "low");
});

test("but the menu ITEM you pick is judged normally", () => {
  for (const item of ["Delete", "Move to trash", "Share", "Remove access"]) {
    assert.equal(clickRisk(item, "menuitem"), "consequential", `"${item}" commits something`);
  }
});

test("a click that says what it will do is caught whatever it was aimed at", () => {
  // The label is useless here, so the agent's own expected outcome carries it.
  assert.equal(clickRisk(MENU_BLOB, "menu", "the folder is deleted"), "consequential");
  assert.equal(clickRisk(MENU_BLOB, "menu", "the folder is shared with sam"), "consequential");
});

test("a described single control is still judged on its description", () => {
  // Long, but one action word — this is the click that must never slip past.
  assert.equal(
    executor.classifyActionRisk(
      { action: { type: "click_coord", x: 1, y: 1, label: "the blue Send button at the bottom of the compose window" } },
      { byRef: new Map() },
    ),
    "consequential",
  );
});

// ── opening the dialog is not doing the thing ───────────────────────────────
//
// Drive's "Share ⌥⌘A" menu item raises the sharing dialog. Nothing has been
// shared at that point — the control inside the dialog does that — but the
// gate asked anyway, and an approval spent on reaching a dialog is an approval
// the user learns to click through before the real one arrives.

test("reaching a dialog is free; the control inside it is not", () => {
  const opens = (label, outcome) => clickRisk(label, "menuitem", outcome);
  assert.equal(opens("Share ⌥⌘A", "The FINAL folder sharing dialog opens"), "low");
  assert.equal(opens("Share", "the share dialog appears with a recipient field"), "low");
  assert.equal(opens("Compose", "the compose window opens"), "low");
  assert.equal(opens("Invite people", "the invite panel is shown"), "low");
});

test("a control that opens AND commits is still caught", () => {
  assert.equal(
    clickRisk("Share", "menuitem", "the dialog closes and the folder is shared with sam"),
    "consequential",
  );
});

test("Send and Delete are never excused as merely opening something", () => {
  // These names leave no room for interpretation. If such a button really does
  // raise a confirmation step, one extra question is the right price.
  assert.equal(
    clickRisk("Send", "button", "a confirmation dialog opens asking to confirm the send"),
    "consequential",
  );
  assert.equal(clickRisk("Delete", "menuitem", "a confirm dialog opens"), "consequential");
});

// ── permission is never a question ──────────────────────────────────────────
//
// The agent used ask_user to ask "are you ready for me to send it?". That
// ended the run and handed the user a free-text box, where a typed "yes" then
// had to be interpreted as an instruction — and was, as a fresh copy of the
// original task. Permission has its own surface (the approval buttons the
// gate raises at the committing click); ask_user must not borrow it.

function permissionAskingModel(question) {
  return {
    async plan() {
      return { plan: ["Send it"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide() {
      return {
        kind: "ask_user", action: null, question, questionOptions: [],
        reason: "", narration: "", expectedOutcome: "", risk: "low", answer: "",
        replanReason: "", constraints: null, steps: null, planStepCompleted: false,
        factsLearned: [], candidateResults: [],
      };
    },
    async verify() { return { success: true, evidence: "", reason: "", next: "continue" }; },
    async learn() { return { notes: [], userNotes: [] }; },
  };
}

for (const question of [
  "Are you ready for me to send it?",
  "Do you want me to send the email now?",
  "Shall I go ahead and share the folder?",
  "Is it ok to send this?",
]) {
  test(`asking permission never ends the run as a question: ${question.slice(0, 34)}…`, async () => {
    const fake = makeComposeFake();
    const result = await runBrowserAgentTask({
      goal: "send the email",
      userAsk: "send the email",
      controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
      model: permissionAskingModel(question),
      maxRounds: 4,
      userDataPath: TMP,
    });
    await result.learning;
    // The agent is told to act, twice. If it will not — as this model never
    // will — the ask is escalated to the approval surface, which is a yes/no
    // with buttons. What must never happen is it arriving as an open question
    // the user has to answer in prose.
    if (result.status === "waiting_for_user") {
      assert.equal(
        result.needsApproval,
        true,
        "a permission ask reaches the user as an approval, never as a free-text question",
      );
    }
    assert.ok(
      result.task.round > 1,
      "the agent must be pushed to act before the ask is escalated",
    );
  });
}

for (const question of [
  "Is it ok if I click Compose?",
  "Can I click the Inbox button?",
  "Should I click Reply to start the email?",
]) {
  test(`mid-flow click permission never reaches the user: ${question.slice(0, 28)}…`, async () => {
    const fake = makeComposeFake();
    const result = await runBrowserAgentTask({
      goal: "send the email",
      userAsk: "send the email",
      controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
      model: permissionAskingModel(question),
      maxRounds: 5,
      userDataPath: TMP,
    });
    await result.learning;
    assert.notEqual(
      result.needsApproval,
      true,
      "Compose / Reply / Inbox are the agent's job — do not ask the user",
    );
    assert.notEqual(
      result.status,
      "waiting_for_user",
      "a mid-flow permission ask must not stop the run for a yes/no",
    );
  });
}

// ── committing a dialog goes through its own control ────────────────────────
//
// The end-of-run loop: with the recipient added, the agent aimed at the
// dialog's Send button, hit the page chrome behind it (Google's apps grid),
// and dismissed the dialog — then reopened it and did it again. A click on a
// send/share/invite control now routes through the resolver that scores the
// DIALOG's own buttons and refuses anything that dismisses.

test("a click aimed at Send is resolved inside the dialog, not by pixel", async () => {
  const ownedBrowserAct = require("../ownedBrowserAct.cjs");
  const calls = [];
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://drive.google.com/drive/folders/abc",
    getTitle: () => "FINAL - Google Drive",
    focus() {},
    sendInputEvent(e) {
      calls.push(e);
    },
    async executeJavaScript(js) {
      // The dialog resolver asks the page to find and click its own Send.
      if (/lykn|dialog|role="dialog"|role=.dialog./i.test(js) && /send/i.test(js)) {
        return { ok: true, label: "Send", x: 480, y: 500, score: 120 };
      }
      return null;
    },
  };
  const res = await ownedBrowserAct.runAction(
    webContents,
    { type: "click", label: "Send", selector: "#send" },
    [],
  );
  assert.equal(res.resolved, "dialog_commit", "the dialog's own control is what gets pressed");
  assert.equal(res.clickedLabel, "Send");
});
