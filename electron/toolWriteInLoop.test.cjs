/**
 * Every write into a tool goes through the agent loop.
 *
 * Each venue used to write its own way, straight at the page: paste a document
 * at Notion, push a TSV into Sheets, paste an outline into Slides, patch an
 * open doc. None of it was verified, none of it was gated, and none of it left
 * a trace — a run that worked and a run whose paste silently did nothing were
 * indistinguishable from the outside, which is exactly what a user reported.
 *
 * The loop does the writing now. The deterministic pastes remain, but only as
 * the fallback for when the loop cannot finish — or when there is no model
 * endpoint to run it at all, which is the case that keeps this working
 * offline.
 *
 * Run: node --test electron/toolWriteInLoop.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "agentRuntime.cjs"), "utf8");

/** The body of the shared helper, for reading its guarantees. */
const HELPER = SRC.slice(
  SRC.indexOf("async function writeIntoToolWithLoop"),
  SRC.indexOf("async function runCreateInSheets"),
);

test("the helper drives the agent loop", () => {
  assert.match(
    HELPER,
    /buildAppWorkGoal\(\{ ask, destination: where, draft \}\)/,
    "the draft goes into the goal, and the goal names the place in the user's own words",
  );
  assert.match(HELPER, /runAdaptiveBrowse\(/, "which the loop then carries out");
  assert.match(HELPER, /returnRaw: true/);
});

test("a superseded turn stops rather than writing", () => {
  assert.match(HELPER, /if \(gen !== agent\.generation\) return \{ ok: false, aborted: true \}/);
});

test("no model endpoint means the caller's own paste still runs", () => {
  // The one case where writing outside the loop is correct: there is no loop.
  assert.match(HELPER, /AgentModelUnavailableError.*return \{ ok: false \}/s);
  assert.match(HELPER, /throw e;/, "any other failure is a real error, not a silent fallback");
});

/** Every deterministic write, and whether the loop is tried first. */
function writeSites() {
  const sites = [];
  const re = /(pasteTextIntoPage|fillGoogleSheetFromText)\(/g;
  let m;
  while ((m = re.exec(SRC))) {
    // Skip the actuator's own definition and the controller seam.
    const before = SRC.slice(Math.max(0, m.index - 900), m.index);
    sites.push({ index: m.index, before });
  }
  return sites;
}

test("every write into a page tries the loop first", () => {
  const unguarded = writeSites().filter(
    (s) =>
      !/writeIntoToolWithLoop|runAdaptiveBrowse|agent_loop|focusPageEditor/.test(s.before),
  );
  assert.deepEqual(
    unguarded.map((s) => SRC.slice(0, s.index).split("\n").length),
    [],
    "these line numbers write to the page without the loop having had a go",
  );
});

test("no write path skips the loop", () => {
  // Notion/Docs was the reported failure; the other write paths had the
  // identical shape and would have failed the same way. The guarantee is not a
  // head count of call sites — those come and go — but that nothing writes into
  // a page without the loop having been given the job first. A direct paste is
  // allowed only as a fallback after the loop has already tried and failed.
  const throughLoop = (SRC.match(/writeIntoToolWithLoop\(/g) || []).length - 1;
  const directPastes = (SRC.match(/pasteTextIntoPage\(/g) || []).length;
  assert.ok(throughLoop >= 4, `expected the helper at every write site, found ${throughLoop}`);
  assert.ok(
    throughLoop >= directPastes,
    `${directPastes} direct pastes vs ${throughLoop} loop attempts — a write is skipping the loop`,
  );
});
