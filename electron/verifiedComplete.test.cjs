/**
 * A finished task is finished.
 *
 * From a real run: the agent shared the folder, Drive confirmed it with
 * "Access updated", and the modular loop reported the task complete with that
 * evidence. A legacy gap-checker then read the page text, could not find the
 * recipient's address on it — the dialog it was typed into had closed — and
 * concluded the sharing had not happened. It started a whole new run titled
 * "ONLY do what is still unfinished", so the user watched the agent carry on
 * working on a task it had already done, and never got a summary.
 *
 * The rule: when the browser agent verifies a completion, that is the answer.
 * The page-text heuristics do not get to overrule it.
 *
 * Run: node --test electron/verifiedComplete.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "agentRuntime.cjs"), "utf8");

test("a completed modular run marks the turn verified", () => {
  assert.match(
    SRC,
    /if \(result\.status === "completed"\) \{[\s\S]{0,900}?agent\.verifiedComplete = true;/,
    "completion has to be recorded, or nothing downstream can respect it",
  );
});

test("the finishing gap-check stands down on a verified completion", () => {
  // The block that spawns "ONLY do what is still unfinished".
  const start = SRC.indexOf("// Finish only what is still unmet");
  assert.ok(start > 0, "the finishing check must still be there");
  const guard = SRC.slice(start, start + 700);
  assert.match(guard, /!agent\.verifiedComplete/, "it must not re-drive a finished task");
});

test("the mid-plan retry stands down too", () => {
  const start = SRC.indexOf("// A verified completion is not a step that needs finishing.");
  assert.ok(start > 0, "the between-steps retry needs the same guard");
  assert.match(SRC.slice(start, start + 200), /!agent\.verifiedComplete/);
});

test("the flag is cleared when a new turn begins", () => {
  // Otherwise one finished task would silence the checks for every task after
  // it in the same agent.
  assert.match(
    SRC,
    /agent\.verifiedComplete = false;[\s\S]{0,200}?emitAgentWaiting\(agent\.id, \{ waiting: false \}\)/,
    "each turn starts with no claim of completion",
  );
});

test("an unfinished run still gets the finishing pass", () => {
  // waiting_for_user and failed runs must NOT set the flag — they are exactly
  // the cases the gap-check exists for.
  const completedBlock = SRC.slice(
    SRC.indexOf('if (result.status === "completed")'),
    SRC.indexOf('if (result.status === "waiting_for_user")'),
  );
  assert.match(completedBlock, /verifiedComplete/);
  const waitingBlock = SRC.slice(
    SRC.indexOf('if (result.status === "waiting_for_user")'),
    SRC.indexOf('if (result.error === "aborted")'),
  );
  assert.doesNotMatch(
    waitingBlock,
    /verifiedComplete = true/,
    "a run parked on the user has not completed anything",
  );
});
