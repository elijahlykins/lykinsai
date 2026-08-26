/**
 * Whether the agent can tell that the page responded.
 *
 * Every test here stands for a way the old pipeline reported "no observable
 * page change" about an action that had worked, which cost a recovery step, a
 * re-decide, and a retry that clicked the control a second time — closing the
 * menu the first click opened, or unticking the box it ticked.
 *
 * Run: node --test electron/browser-agent/changeDetection.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { buildSnapshot, diffSnapshots, hasObservableChange, formatSnapshotForModel } =
  require("./browser/snapshot.cjs");
const verifier = require("./runtime/verifier.cjs");
const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");
const { waitForDomSettle } = require("../ownedBrowserAct.cjs");

// --- settling: waiting for the page to actually stop ---------------------------

/**
 * A tab whose activity is described by two functions of elapsed time, standing
 * in for the monitor the real settle installs in the page.
 */
function makeTab({ quietFor = () => 5000, pending = () => 0, installed = true, loading = false } = {}) {
  const t0 = Date.now();
  const calls = { reads: 0, installs: 0, paints: 0 };
  let isInstalled = installed;
  const webContents = {
    isDestroyed: () => false,
    isLoading: () => loading,
    async executeJavaScript(js) {
      const src = String(js);
      if (src.includes("requestAnimationFrame")) {
        calls.paints += 1;
        return undefined;
      }
      if (src.includes("MutationObserver")) {
        calls.installs += 1;
        isInstalled = true;
        return true;
      }
      if (src.includes("quietFor")) {
        calls.reads += 1;
        if (!isInstalled) return null;
        const elapsed = Date.now() - t0;
        return { quietFor: quietFor(elapsed), pending: pending(elapsed), mutations: 3, loading: false };
      }
      return null;
    },
  };
  return { webContents, calls };
}

async function timed(fn) {
  const started = Date.now();
  await fn();
  return Date.now() - started;
}

test("a page that is already idle is not waited on", async () => {
  const tab = makeTab({ quietFor: () => 5000 });
  const took = await timed(() => waitForDomSettle(tab.webContents, 3000));
  // The old implementation slept a flat 180ms here regardless.
  assert.ok(took < 150, `returned in ${took}ms`);
  assert.equal(tab.calls.paints, 1, "still waits for a paint before reading");
});

test("a page still mutating is waited out, then read", async () => {
  // Busy for 400ms — a render landing after the click — then quiet.
  const tab = makeTab({ quietFor: (ms) => (ms < 400 ? 0 : ms - 400) });
  const took = await timed(() => waitForDomSettle(tab.webContents, 3000));
  assert.ok(took >= 400, `waited for the render (${took}ms)`);
  assert.ok(took < 1400, `did not burn the budget (${took}ms)`);
});

test("a request in flight holds the snapshot back until it lands", async () => {
  // The case that broke everything: click fires a fetch, the DOM is untouched
  // until the response arrives, so nothing about the page looks busy.
  const tab = makeTab({ quietFor: () => 5000, pending: (ms) => (ms < 500 ? 1 : 0) });
  const took = await timed(() => waitForDomSettle(tab.webContents, 3000));
  assert.ok(took >= 500, `waited for the request (${took}ms)`);
  assert.ok(took < 1500, `returned once it finished (${took}ms)`);
});

test("a page that never stops animating does not cost the whole budget", async () => {
  // A carousel or a live clock mutates forever; there is nothing to wait for.
  const tab = makeTab({ quietFor: () => 0, pending: () => 0 });
  const took = await timed(() => waitForDomSettle(tab.webContents, 5000));
  assert.ok(took < 1200, `gave up on quiet (${took}ms)`);
  assert.ok(took >= 500, `but did give the page a chance (${took}ms)`);
});

test("the budget is still a hard ceiling", async () => {
  const tab = makeTab({ quietFor: () => 0, pending: () => 1 });
  const took = await timed(() => waitForDomSettle(tab.webContents, 300));
  assert.ok(took < 900, `respected the 300ms budget (${took}ms)`);
});

test("the activity monitor is installed when the document has none", async () => {
  const tab = makeTab({ installed: false, quietFor: () => 5000 });
  await waitForDomSettle(tab.webContents, 2000);
  assert.equal(tab.calls.installs, 1, "installed once");
  assert.ok(tab.calls.reads >= 2, "read again after installing");
});

test("settling a tab that has gone does not throw", async () => {
  await waitForDomSettle({ isDestroyed: () => true }, 1000);
  await waitForDomSettle(null, 1000);
});

// --- the diff: seeing change that is not a new label --------------------------

function snap(items, { url = "https://example.com/app", title = "App", text = "hello" } = {}) {
  return buildSnapshot({
    url,
    title,
    text,
    catalog: items.map((it, i) => ({
      uid: it.uid ?? i + 1,
      tag: it.tag || "button",
      role: it.role || "",
      selector: it.selector || `#el${i + 1}`,
      label: it.label || "",
      ...it,
    })),
  });
}

test("a checkbox being ticked is a change", async () => {
  // A custom checkbox reports aria-checked, which the collector now folds into
  // `checked`; the label and the page text are identical either way.
  const before = snap([{ label: "Email me updates", role: "checkbox", checked: false }]);
  const after = snap([{ label: "Email me updates", role: "checkbox", checked: true }]);
  const diff = diffSnapshots(before, after);
  assert.ok(hasObservableChange(diff), "the tick registered");
  assert.equal(diff.stateChanges.length, 1);
  assert.match(diff.stateChanges[0].text, /"Email me updates" ticked/);
  assert.match(diff.summary, /State changed/);
});

test("a menu opening is a change", async () => {
  const before = snap([{ label: "Filters", expanded: false }]);
  const after = snap([{ label: "Filters", expanded: true }]);
  const diff = diffSnapshots(before, after);
  assert.ok(hasObservableChange(diff));
  assert.match(diff.stateChanges[0].text, /"Filters" opened/);
});

test("a tab becoming selected and a toggle being switched on are changes", async () => {
  const before = snap([
    { label: "Billing", role: "tab", selected: false },
    { label: "Dark mode", pressed: false },
  ]);
  const after = snap([
    { label: "Billing", role: "tab", selected: true },
    { label: "Dark mode", pressed: true },
  ]);
  const diff = diffSnapshots(before, after);
  const text = diff.stateChanges.map((c) => c.text).join(" | ");
  assert.match(text, /"Billing" selected/);
  assert.match(text, /"Dark mode" turned on/);
});

test("a button becoming enabled is a change", async () => {
  const before = snap([{ label: "Continue", disabled: true }]);
  const after = snap([{ label: "Continue", disabled: false }]);
  const diff = diffSnapshots(before, after);
  assert.ok(hasObservableChange(diff));
  assert.match(diff.stateChanges[0].text, /"Continue" became enabled/);
});

test("a state attribute merely appearing is not treated as a change", async () => {
  // A re-render that starts declaring aria-expanded is the framework talking,
  // not the page responding — counting it would make every re-render look like
  // a successful click.
  const before = snap([{ label: "Filters" }]);
  const after = snap([{ label: "Filters", expanded: false }]);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.stateChanges.length, 0);
  assert.ok(!hasObservableChange(diff), "nothing actually happened");
});

test("removing one of several identical rows is a change", async () => {
  // The label set is untouched — "Remove" is still on the page — and the text
  // extractor de-duplicates, so neither channel could see this.
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ uid: i + 1, label: "Remove", role: "button" }));
  const diff = diffSnapshots(snap(rows(5)), snap(rows(4)));
  assert.ok(hasObservableChange(diff), "the deletion registered");
  assert.deepEqual(diff.countChanges, [{ label: "remove", was: 5, now: 4 }]);
  assert.match(diff.summary, /"remove" 5→4/);
});

test("a page that truly did not respond still reports no change", async () => {
  const items = [{ label: "Submit" }, { label: "Cancel" }];
  const diff = diffSnapshots(snap(items), snap(items));
  assert.ok(!hasObservableChange(diff));
  assert.equal(diff.summary, "No observable page change.");
});

test("state a control is holding is shown to the model", async () => {
  const text = formatSnapshotForModel(
    snap([
      { label: "Filters", expanded: false },
      { label: "Sort", expanded: true },
      { label: "Dark mode", pressed: true },
    ]),
  );
  // Without this the agent cannot tell a menu it already opened from one it
  // has not, and spends a round closing it again.
  assert.match(text, /"Filters" \(closed — click to open\)/);
  assert.match(text, /"Sort" \(open\)/);
  assert.match(text, /"Dark mode" \(on\)/);
});

// --- the verifier: state as evidence ------------------------------------------

const noModel = { async verify() { throw new Error("the verifier should not need a model here"); } };

test("a control reporting its own new state verifies the click", async () => {
  const before = snap([{ label: "Filters", expanded: false }]);
  const after = snap([{ label: "Filters", expanded: true }]);
  // The action carries the ref the model aimed with — a BEFORE-generation ref;
  // the verifier maps it to the uid to find the same node in the diff.
  const verdict = await verifier.verifyOutcome({
    model: noModel,
    decision: { action: { type: "click", target: before.elements[0].ref }, expectedOutcome: "" },
    actionResult: { ok: true },
    before,
    after,
    diff: diffSnapshots(before, after),
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.method, "deterministic");
  assert.equal(verdict.next, "continue");
  assert.match(verdict.evidence, /the control responded: "Filters" opened/);
});

test("an expectation written about state is confirmed by the state diff", async () => {
  const before = snap([{ label: "Advanced options", expanded: false }]);
  const after = snap([{ label: "Advanced options", expanded: true }]);
  const verdict = await verifier.verifyOutcome({
    model: noModel,
    decision: {
      action: { type: "select", target: before.elements[0].ref },
      expectedOutcome: "the advanced options section opened",
    },
    actionResult: { ok: true },
    before,
    after,
    diff: diffSnapshots(before, after),
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.method, "deterministic");
});

test("a genuinely dead click is still a failure", async () => {
  // The point of all of the above is fewer FALSE failures, not fewer failures.
  const items = [{ label: "Submit" }];
  const before = snap(items);
  const after = snap(items);
  const verdict = await verifier.verifyOutcome({
    model: noModel,
    decision: { action: { type: "click", target: before.elements[0].ref }, expectedOutcome: "the form submits" },
    actionResult: { ok: true },
    before,
    after,
    diff: diffSnapshots(before, after),
  });
  assert.equal(verdict.success, false);
  assert.equal(verdict.next, "recover");
  assert.match(verdict.reason, /no observable page change/);
});

// --- the loop: a second look before giving up ---------------------------------

/**
 * A page whose response to the click lands after the first read — a debounced
 * update, or a render queued behind a timer.
 *
 * @param {number} readsUntilVisible reads after the click before it shows up
 */
function makeSlowPage(readsUntilVisible) {
  let clicked = false;
  let readsSinceClick = 0;
  const page = () => ({
    title: "Reports",
    text: "Reports dashboard",
    elements: [
      {
        uid: 1,
        tag: "button",
        role: "button",
        selector: "#filters",
        label: "Filters",
        expanded: clicked && readsSinceClick >= readsUntilVisible,
      },
    ],
  });
  const actuator = {
    async navigate() {
      return { ok: true, url: "https://reports.example.com" };
    },
    async getDOMCatalog() {
      if (clicked) readsSinceClick += 1;
      return { ok: true, url: "https://reports.example.com", title: page().title, items: page().elements };
    },
    async getPageContext() {
      return { ok: true, url: "https://reports.example.com", title: page().title, text: page().text };
    },
    async runAction(_wc, action) {
      if (String(action.type) === "click") {
        clicked = true;
        readsSinceClick = 0;
      }
      return { ok: true, type: action.type };
    },
    async screenshotDataUrl() {
      return "data:image/jpeg;base64,ZmFrZQ==";
    },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://reports.example.com",
    getTitle: () => page().title,
    isLoading: () => false,
    executeJavaScript: async () => null,
  };
  return { actuator, webContents };
}

function clickFiltersTask(fake) {
  let round = 0;
  const model = {
    async plan() {
      return { plan: ["Open the filters"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide({ user }) {
      round += 1;
      const base = {
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
      };
      if (round === 1) {
        // Aim with the ref the CURRENT BROWSER STATE hands the model — refs
        // are generation-scoped now, so a hardcoded one would never resolve.
        const m = /\[(g\d+:[^\]]+)\] button "Filters"/.exec(String(user || ""));
        assert.ok(m, "the Filters button must appear in the state shown to the model");
        return { ...base, action: { type: "click", target: m[1] }, expectedOutcome: "the filters panel opens" };
      }
      return { ...base, kind: "finish", answer: "The filters panel is open." };
    },
    async verify() {
      return { success: false, evidence: "", reason: "model was asked", next: "recover" };
    },
  };
  return runBrowserAgentTask({
    goal: "Open the filters on the reports page",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 6,
    userDataPath: path.join(os.tmpdir(), "lykn-change-detection-test"),
  });
}

test("a change that arrives late is caught by a second look, not scored as a dead click", async () => {
  // Visible on the second read after the click: the first observe misses it.
  const result = await clickFiltersTask(makeSlowPage(2));
  const click = result.history.find((h) => h.action?.type === "click");
  assert.equal(click.result, "success", `click was scored ${click.result}`);
  assert.match(click.observedOutcome, /"Filters" opened/);
  assert.equal(click.retries, 0, "no recovery step was spent");
});

test("a page that never responds is not rescued by the second look", async () => {
  // Never becomes visible — the extra look must not turn every dead click into
  // a success just by looking twice.
  const result = await clickFiltersTask(makeSlowPage(Number.POSITIVE_INFINITY));
  const click = result.history.find((h) => h.action?.type === "click");
  assert.equal(click.result, "failure");
});
