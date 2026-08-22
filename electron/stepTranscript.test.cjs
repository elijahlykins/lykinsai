/**
 * What the user watches while the agent works.
 *
 * Every step stays on screen: the pill for what it did, the agent's line or
 * two about it, then the next step underneath. When the run finishes, that
 * stack remains and the summary is appended after it.
 *
 * Run: node --test electron/stepTranscript.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { renderLiveStep, trimStepNote } = require("./agentRuntime.cjs");

const step = (label, over = {}) => ({ label, kind: "browse", status: "done", ...over });

test("finished steps stay on screen under the one in flight", () => {
  const out = renderLiveStep("a1", [
    step("Opened Drive"),
    step("Found the FINAL folder"),
    step("Opening the share dialog", { note: "Adding the recipient next." }),
  ]);
  assert.match(out, /Opened Drive/, "earlier work stays in the stack");
  assert.match(out, /Found the FINAL folder/);
  assert.match(out, /Opening the share dialog/);
  assert.match(out, /Adding the recipient next\./, "with its line of explanation");
  assert.match(out, /lykn-agent-step:\/\/a1\/0/);
  assert.match(out, /lykn-agent-step:\/\/a1\/1/);
  assert.match(out, /lykn-agent-step:\/\/a1\/2/);
});

test("a finished run keeps the stacked steps — the summary follows them", () => {
  const out = renderLiveStep("a1", [step("Shared the folder")], { allDone: true });
  assert.match(out, /Shared the folder/, "the work log is still the body of the turn");
});

test("the step's real index is kept so its deliverable still opens", () => {
  // Later steps stacking underneath must not renumber earlier ones: the
  // index is the click target for that step's output.
  const out = renderLiveStep("a1", [step("One"), step("Two"), step("Three")]);
  assert.match(out, /lykn-agent-step:\/\/a1\/2/);
});

test("a step still running says so, a finished one does not", () => {
  assert.match(renderLiveStep("a1", [step("Typing", { status: "live" })]), /\/0\/live/);
  assert.match(renderLiveStep("a1", [step("Typed")]), /a1\/0\)/);
});

test("the folded detail rides along with the pill", () => {
  const out = renderLiveStep("a1", [step("Clicking Send", { detail: "Expecting the invite to go out" })]);
  assert.match(out, /"Expecting the invite to go out"/);
});

test("nothing to show renders nothing", () => {
  assert.equal(renderLiveStep("a1", []), "");
  assert.equal(renderLiveStep("a1", null), "");
});

test("each step keeps its own explanation underneath", () => {
  const out = renderLiveStep("a1", [
    step("Opened Drive", { note: "Starting from the shared drive." }),
    step("Shared the folder", { note: "Sam is on the invite now." }),
  ]);
  assert.match(out, /Starting from the shared drive\./);
  assert.match(out, /Sam is on the invite now\./);
  assert.ok(
    out.indexOf("Starting from the shared drive") < out.indexOf("Shared the folder"),
    "the first explanation sits with the first step",
  );
});

// ── the note under the pill ─────────────────────────────────────────────────

test("an ordinary note is left exactly as written", () => {
  const note = "Opening the share dialog for the FINAL folder.";
  assert.equal(trimStepNote(note), note);
});

test("whitespace collapses so the pill keeps its shape", () => {
  assert.equal(trimStepNote("  Adding\n\nthe   recipient.  "), "Adding the recipient.");
});

test("a retried step's accumulated commentary is cut to what just happened", () => {
  // Each attempt appends its own line; the user is watching one step, not a
  // changelog of everything that did not work.
  const long = Array.from({ length: 8 }, (_, i) => `Attempt ${i + 1} did not take.`).join(" ");
  const out = trimStepNote(long);
  assert.ok(out.length <= 241, `kept ${out.length} characters`);
  assert.match(out, /Attempt [78]/, "what survives is the most recent commentary");
  assert.doesNotMatch(out, /Attempt 1 /);
});

test("empty and missing notes are simply absent", () => {
  assert.equal(trimStepNote(""), "");
  assert.equal(trimStepNote(null), "");
  assert.equal(trimStepNote("   "), "");
});
