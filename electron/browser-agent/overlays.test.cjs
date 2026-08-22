/**
 * Getting past cookie walls, consent managers and popups.
 *
 * Run: node --test electron/browser-agent/overlays.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const overlays = require("../browserOverlays.cjs");
const { createBrowserController } = require("./browser/controller.cjs");
const { verifyOutcome } = require("./runtime/verifier.cjs");
const batchPolicy = require("./runtime/batch.cjs");
const executor = require("./runtime/executor.cjs");
const { formatSnapshotForModel, buildSnapshot } = require("./browser/snapshot.cjs");

function control(label, extra = {}) {
  return { label, aria: "", tag: "button", href: "", selector: "#c", x: 100, y: 100, hit: true, ...extra };
}

function overlay(extra = {}) {
  return {
    cmp: false,
    tag: "div",
    idClass: "",
    selector: "#o",
    position: "fixed",
    zIndex: "9999",
    area: 0.3,
    coversViewport: false,
    fields: false,
    text: "",
    controls: [],
    ...extra,
  };
}

// --- classification ---------------------------------------------------------

test("a consent-manager container is a consent wall on sight", () => {
  assert.equal(overlays.classifyOverlay(overlay({ cmp: true, text: "Wir verwenden Dienste" })), "consent");
});

test("cookie vocabulary classifies as consent", () => {
  assert.equal(
    overlays.classifyOverlay(overlay({ text: "We use cookies to improve your experience." })),
    "consent",
  );
});

test("a cookie wall that also plugs the newsletter is still a cookie wall", () => {
  const kind = overlays.classifyOverlay(
    overlay({ text: "We use cookies. Also, subscribe to our newsletter for 10% off!" }),
  );
  assert.equal(kind, "consent", "only the consent branch knows to refuse rather than accept");
});

test("newsletter, app, notification and survey popups each classify", () => {
  assert.equal(overlays.classifyOverlay(overlay({ text: "Join our mailing list for 15% off" })), "promo");
  assert.equal(overlays.classifyOverlay(overlay({ text: "Open in the app for a better experience" })), "app");
  assert.equal(overlays.classifyOverlay(overlay({ text: "Allow notifications from this site?" })), "notify");
  assert.equal(overlays.classifyOverlay(overlay({ text: "Take a quick survey about your visit" })), "survey");
});

test("an ordinary application dialog classifies as nothing", () => {
  assert.equal(
    overlays.classifyOverlay(overlay({ text: "Discard changes? Your draft will not be saved." })),
    "",
  );
});

test("a full-page overlay with a form is never generic-dismissible", () => {
  assert.equal(
    overlays.isBlockingOverlay(overlay({ coversViewport: true, fields: true, text: "Share this design" })),
    false,
    "fields are how an overlay says it is part of the work",
  );
});

test("a full-page overlay with no fields and little text is generic-dismissible", () => {
  assert.equal(overlays.isBlockingOverlay(overlay({ coversViewport: true, text: "Hi there!" })), true);
});

// --- which control gets clicked --------------------------------------------

test("a consent wall is refused before it is accepted", () => {
  const wall = overlay({
    cmp: true,
    controls: [control("Accept All Cookies"), control("Reject All"), control("Manage Preferences")],
  });
  const pick = overlays.pickDismissControl(wall, "consent");
  assert.equal(pick.label, "Reject All");
});

test("only-essential counts as a refusal", () => {
  for (const label of ["Only essential", "Necessary cookies only", "Use necessary cookies only"]) {
    const pick = overlays.pickDismissControl(
      overlay({ cmp: true, controls: [control("Accept all"), control(label)] }),
      "consent",
    );
    assert.equal(pick.label, label, `${label} should be preferred over accepting`);
  }
});

test("accepting is the fallback when refusing is not one click", () => {
  const wall = overlay({
    cmp: true,
    controls: [control("Accept all"), control("Manage preferences"), control("Show purposes")],
  });
  assert.equal(overlays.pickDismissControl(wall, "consent").label, "Accept all");
});

test("a wall offering only a deeper wall is left alone", () => {
  const wall = overlay({ cmp: true, controls: [control("Manage preferences"), control("Learn more")] });
  assert.equal(overlays.pickDismissControl(wall, "consent"), null);
});

test("nothing that commits is ever clicked", () => {
  for (const label of [
    "Sign in",
    "Log in to continue",
    "Subscribe",
    "Buy now",
    "Pay $49",
    "Delete my data",
    "Send",
    "Submit",
    "Start free trial",
    "Continue with Google",
  ]) {
    const pick = overlays.pickDismissControl(overlay({ controls: [control(label)] }), "promo");
    assert.equal(pick, null, `"${label}" must never be clicked to dismiss anything`);
  }
});

test("a link with a real destination is not a dismissal", () => {
  const modal = overlay({
    controls: [control("Close", { tag: "a", href: "https://example.com/newsletter" })],
  });
  assert.equal(overlays.pickDismissControl(modal, "promo"), null);
  assert.equal(overlays.navigatesAway({ tag: "a", href: "#" }), false, "an in-page anchor navigates nowhere");
});

test("a promo modal closes on X, No thanks, or an aria label", () => {
  assert.equal(overlays.pickDismissControl(overlay({ controls: [control("\u00d7")] }), "promo").label, "\u00d7");
  assert.equal(
    overlays.pickDismissControl(overlay({ controls: [control("No thanks")] }), "promo").label,
    "No thanks",
  );
  const iconOnly = overlay({
    controls: [control("submit-email"), control("\u200b", { label: "", aria: "Close dialog" })],
  });
  assert.equal(overlays.pickDismissControl(iconOnly, "promo").aria, "Close dialog");
});

test("a promo modal is never accepted the way a consent wall is", () => {
  const modal = overlay({ controls: [control("Accept all"), control("Agree")] });
  assert.equal(
    overlays.pickDismissControl(modal, "promo"),
    null,
    "agreeing is only an exit from a consent wall",
  );
});

test("a hit-testable control wins over one something is covering", () => {
  const wall = overlay({
    cmp: true,
    controls: [control("Reject all", { hit: false, selector: "#hidden" }), control("Accept all")],
  });
  assert.equal(
    overlays.pickDismissControl(wall, "consent").label,
    "Accept all",
    "a point behind another element would click the coverer",
  );
});

test("an unreachable control is still offered when nothing else is", () => {
  const wall = overlay({ cmp: true, controls: [control("Reject all", { hit: false })] });
  assert.equal(overlays.pickDismissControl(wall, "consent").label, "Reject all");
});

test("chooseDismissal refuses generic overlays when generic dismissal is off", () => {
  const modal = overlay({ coversViewport: true, text: "Hello", controls: [control("\u00d7")] });
  assert.ok(overlays.chooseDismissal(modal, { allowGeneric: true }));
  assert.equal(overlays.chooseDismissal(modal, { allowGeneric: false }), null);
});

// --- the sweep loop ---------------------------------------------------------

function frameWith(...list) {
  return [{ frameId: null, offsetX: 0, offsetY: 0, offsetKnown: true, docKey: "d1", overlays: list }];
}

test("a sweep clicks one overlay at a time and re-scans between", async () => {
  const consent = overlay({ cmp: true, controls: [control("Reject all")] });
  const promo = overlay({ text: "Join our mailing list", controls: [control("No thanks")] });
  const scans = [frameWith(consent, promo), frameWith(promo), frameWith()];
  const clicked = [];
  const res = await overlays.sweepOverlays({
    scanFrames: async () => scans.shift() || [],
    click: async ({ control: c }) => {
      clicked.push(c.label);
      return { ok: true };
    },
  });
  assert.deepEqual(clicked, ["Reject all", "No thanks"]);
  assert.deepEqual(
    res.dismissed.map((d) => d.kind),
    ["consent", "promo"],
  );
});

test("a wall that survives its click is reported, not clicked again", async () => {
  const stubborn = overlay({ cmp: true, controls: [control("Accept all")] });
  let clicks = 0;
  const res = await overlays.sweepOverlays({
    scanFrames: async () => frameWith(stubborn),
    click: async () => {
      clicks += 1;
      return { ok: true };
    },
  });
  assert.equal(clicks, 1, "the same dismissal must not be retried in one sweep");
  assert.equal(res.remaining.length, 1);
  assert.match(res.remaining[0].what, /consent/i);
});

test("signatures already tried are skipped", async () => {
  const wall = overlay({ cmp: true, idClass: "#cmp", controls: [control("Accept all")] });
  const sig = overlays.dismissalSignature("consent", wall, control("Accept all"));
  let clicks = 0;
  const res = await overlays.sweepOverlays({
    scanFrames: async () => frameWith(wall),
    click: async () => {
      clicks += 1;
      return { ok: true };
    },
    skipSignatures: [sig],
  });
  assert.equal(clicks, 0);
  assert.deepEqual(res.dismissed, []);
  assert.equal(res.remaining.length, 1);
});

test("a click in a sub-frame is offset into page coordinates", async () => {
  const wall = overlay({ cmp: true, controls: [control("Reject all", { x: 40, y: 20 })] });
  let point = null;
  await overlays.sweepOverlays({
    scanFrames: async () => [
      { frameId: 7, offsetX: 300, offsetY: 500, offsetKnown: true, overlays: [wall] },
    ],
    click: async (req) => {
      point = req.point;
      return { ok: true };
    },
    maxDismissals: 1,
  });
  assert.deepEqual(point, { x: 340, y: 520 });
});

test("an unmeasurable frame falls back to the element itself", async () => {
  const wall = overlay({ cmp: true, controls: [control("Reject all", { selector: "#r" })] });
  let req = null;
  await overlays.sweepOverlays({
    scanFrames: async () => [
      { frameId: 7, offsetX: 0, offsetY: 0, offsetKnown: false, overlays: [wall] },
    ],
    click: async (r) => {
      req = r;
      return { ok: true };
    },
    maxDismissals: 1,
  });
  assert.equal(req.point, null, "with no known offset there is no point worth clicking");
  assert.equal(req.control.selector, "#r");
  assert.equal(req.frameId, 7);
});

test("a sweep stops at its dismissal budget", async () => {
  let n = 0;
  const res = await overlays.sweepOverlays({
    scanFrames: async () => {
      n += 1;
      return frameWith(overlay({ cmp: true, idClass: `#w${n}`, controls: [control("Accept all")] }));
    },
    click: async () => ({ ok: true }),
    maxDismissals: 2,
  });
  assert.equal(res.dismissed.length, 2);
});

test("a failed click ends the sweep and names what is still up", async () => {
  const res = await overlays.sweepOverlays({
    scanFrames: async () => frameWith(overlay({ cmp: true, controls: [control("Accept all")] })),
    click: async () => ({ ok: false, error: "no_point" }),
  });
  assert.deepEqual(res.dismissed, []);
  assert.equal(res.remaining.length, 1);
});

// --- the controller's policy on WHEN to sweep -------------------------------

function makeController({ dismissed = [], remaining = [] } = {}, opts = {}) {
  const sweeps = [];
  let url = "https://shop.test/";
  const actuator = {
    getDOMCatalog: async () => ({ ok: true, items: [], url }),
    getPageContext: async () => ({ ok: true, url, title: "Shop", text: "hi" }),
    runAction: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    waitForLoad: async () => {},
    dismissOverlays: async (_wc, o) => {
      sweeps.push(o);
      return { ok: true, dismissed, remaining, tried: dismissed.map((d) => d.signature) };
    },
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => "Shop",
  };
  const controller = createBrowserController({ webContents, actuator, ...opts });
  return { controller, sweeps, setUrl: (next) => { url = next; } };
}

test("the first observe of a page sweeps", async () => {
  const { controller, sweeps } = makeController();
  await controller.getPageState();
  assert.equal(sweeps.length, 1);
});

test("the automatic sweep never touches the generic tier; an explicit dismissal may", async () => {
  const { controller, sweeps } = makeController();
  // An app's own modal — a template chooser, a wizard step — is
  // indistinguishable by shape from a promo with an X. Auto-closing one
  // closed the very dialog a task needed, so the observe-time sweep only
  // clears overlays it can positively name…
  await controller.getPageState();
  assert.equal(sweeps[0].allowGeneric, false, "observe-time sweeps must not gamble on generic overlays");
  // …while the model's own dismiss_overlay action is a deliberate judgment
  // and keeps the generic tier available.
  await controller.dismissOverlays({ allowGeneric: true });
  assert.equal(sweeps[1].allowGeneric, true);
});

test("a dialog the agent's own click opened is left alone", async () => {
  const { controller, sweeps } = makeController();
  await controller.getPageState();
  await controller.click("e1").catch(() => {});
  controller.invalidate();
  await controller.getPageState();
  assert.equal(sweeps.length, 1, "the agent asked for whatever is on screen now");
});

test("a click that changed the page re-enables sweeping", async () => {
  const { controller, sweeps, setUrl } = makeController();
  await controller.getPageState();
  await controller.click("e1").catch(() => {});
  setUrl("https://shop.test/cart");
  controller.invalidate();
  await controller.getPageState();
  assert.equal(sweeps.length, 2, "a new page can put up its own wall");
});

test("scrolling after a click does not re-enable sweeping", async () => {
  const { controller, sweeps } = makeController();
  await controller.getPageState();
  await controller.click("e1").catch(() => {});
  await controller.scroll("down");
  await controller.getPageState();
  assert.equal(sweeps.length, 1, "scrolling does not make the agent's dialog someone else's");
});

test("navigating re-enables sweeping", async () => {
  const { controller, sweeps } = makeController();
  await controller.getPageState();
  await controller.click("e1").catch(() => {});
  await controller.navigate("https://shop.test/deals");
  await controller.getPageState();
  assert.equal(sweeps.length, 2);
});

test("auto-dismissal can be turned off", async () => {
  const { controller, sweeps } = makeController({}, { autoDismissOverlays: false });
  await controller.getPageState();
  assert.equal(sweeps.length, 0);
  await controller.dismissOverlays();
  assert.equal(sweeps.length, 1, "an explicit request still sweeps");
});

test("what was cleared and what is still up reach the snapshot", async () => {
  const { controller } = makeController({
    dismissed: [{ kind: "consent", what: "cookie/consent wall", signature: "s1" }],
    remaining: [{ kind: "promo", what: "promotional popup" }],
  });
  const snap = await controller.getPageState();
  assert.equal(snap.overlaysDismissed.length, 1);
  assert.equal(snap.overlaysBlocking.length, 1);
  const rendered = formatSnapshotForModel(snap);
  assert.match(rendered, /Cleared out of the way/);
  assert.match(rendered, /STILL COVERING THE PAGE/);
});

test("a page that keeps producing walls stops being swept", async () => {
  const { controller, sweeps } = makeController({
    dismissed: [
      { kind: "promo", what: "promotional popup", signature: "a" },
      { kind: "promo", what: "promotional popup", signature: "b" },
      { kind: "promo", what: "promotional popup", signature: "c" },
    ],
  });
  for (let i = 0; i < 4; i += 1) {
    controller.invalidate();
    await controller.getPageState();
  }
  assert.equal(sweeps.length, 2, "six dismissals on one page is the cap");
});

test("the user holding the browser suspends sweeping", async () => {
  const ownership = {
    mayAct: () => false,
    reason: () => "the user is typing",
    state: () => "user",
    beginAgentInput: () => {},
    endAgentInput: () => {},
  };
  const { controller, sweeps } = makeController({}, { ownership });
  const snap = await controller.getPageState();
  assert.equal(sweeps.length, 0, "the agent must not click while the user has the wheel");
  assert.deepEqual(snap.overlaysDismissed, []);
});

// --- how the rest of the loop treats the action -----------------------------

test("dismiss_overlay commits nothing, so it never needs approval", () => {
  const decision = { kind: "act", action: { type: "dismiss_overlay" }, expectedOutcome: "the banner is gone" };
  assert.equal(executor.classifyActionRisk(decision, buildSnapshot({})), "read");
});

test("dismiss_overlay may be planned in advance alongside a navigation", () => {
  const admitted = batchPolicy.admitBatch([
    { type: "navigate", url: "https://news.test/" },
    { type: "dismiss_overlay" },
  ]);
  assert.equal(admitted.admitted, true);
});

test("an empty sweep verifies as success, not as a failed round", async () => {
  const verdict = await verifyOutcome({
    model: { verify: async () => assert.fail("an empty sweep must not cost a model call") },
    decision: { action: { type: "dismiss_overlay" }, expectedOutcome: "the cookie banner is gone" },
    actionResult: { ok: true, dismissed: [], remaining: [] },
    before: buildSnapshot({}),
    after: buildSnapshot({}),
    diff: { urlChanged: false, titleChanged: false, textChanged: false, newLabels: [], removedLabels: [], summary: "No observable page change." },
  });
  assert.equal(verdict.success, true);
  assert.match(verdict.evidence, /nothing is covering the page/);
});

test("a sweep that cleared something cites it as evidence", async () => {
  const verdict = await verifyOutcome({
    model: { verify: async () => assert.fail("determinism should settle this") },
    decision: { action: { type: "dismiss_overlay" }, expectedOutcome: "the cookie banner is gone" },
    actionResult: { ok: true, dismissed: [{ kind: "consent", what: "cookie/consent wall" }], remaining: [] },
    before: buildSnapshot({}),
    after: buildSnapshot({}),
    diff: { urlChanged: false, titleChanged: false, textChanged: false, newLabels: [], removedLabels: [], summary: "" },
  });
  assert.equal(verdict.success, true);
  assert.match(verdict.evidence, /cookie\/consent wall/);
});

test("a sweep that could not clear the wall says so without failing", async () => {
  const verdict = await verifyOutcome({
    model: { verify: async () => assert.fail("determinism should settle this") },
    decision: { action: { type: "dismiss_overlay" } },
    actionResult: { ok: true, dismissed: [], remaining: [{ kind: "consent", what: "cookie/consent wall" }] },
    before: buildSnapshot({}),
    after: buildSnapshot({}),
    diff: { urlChanged: false, titleChanged: false, textChanged: false, newLabels: [], removedLabels: [], summary: "" },
  });
  assert.equal(verdict.success, true);
  assert.match(verdict.evidence, /still up/);
});

// --- the page-side scan compiles and is self-contained ----------------------

test("the scan script is one expression with its config baked in", () => {
  const js = overlays.buildScanJs();
  assert.match(js, /^\/\*lykn-overlay-scan\*\/\(function\(\)\{/);
  assert.doesNotMatch(js, /\n/, "the script is injected as a single line");
  // Compiles as an expression — a syntax error here would only ever surface as
  // a silently empty scan on every page.
  assert.doesNotThrow(() => new Function(`return ${js};`));
});

// ── an open dialog owns the element budget ──────────────────────────────────
//
// From a stuck run: Drive's share dialog was open, and its recipient field and
// Send button were both in the snapshot — and neither was in the list the
// model was shown, because ~150 controls on the page behind it filled the
// budget first. The agent had no reference to click, so it aimed by pixel,
// missed, reopened the dialog, and repeated until the round budget ran out.
// Everything behind a dialog is inert; its own controls come first.

test("a dialog's controls are what the model is shown", () => {
  const catalog = [];
  for (let i = 0; i < 150; i += 1) {
    catalog.push({
      uid: i + 1, tag: "button", role: "button", selector: `#b${i}`,
      label: `Page control ${i}`, clientX: 10, clientY: 10, inView: true,
    });
  }
  catalog.push({
    uid: 900, tag: "div", role: "combobox", selector: "#to",
    label: "Add people, groups, spaces, and calendar events",
    inDialog: true, frameHost: "drive", clientX: 5, clientY: 5, inView: true,
  });
  catalog.push({
    uid: 901, tag: "div", role: "button", selector: "#send", label: "Send",
    inDialog: true, frameHost: "drive", clientX: 5, clientY: 5, inView: true,
  });

  const rendered = formatSnapshotForModel(
    buildSnapshot({ url: "https://drive.google.com/drive/folders/x", catalog, text: "" }),
  );
  assert.match(rendered, /Add people, groups/, "the field it must type into");
  assert.match(rendered, /\] button "Send"/, "and the button that commits it");
  assert.match(rendered, /A dialog is open/, "with the warning that the rest is behind it");
  assert.match(rendered, /Page control/, "the page behind is still described, just not first");
});

test("with no dialog open nothing changes", () => {
  const catalog = [
    { uid: 1, tag: "a", role: "link", selector: "#a", label: "Home", clientX: 1, clientY: 1, inView: true },
    { uid: 2, tag: "button", role: "button", selector: "#b", label: "Search", clientX: 1, clientY: 1, inView: true },
  ];
  const rendered = formatSnapshotForModel(buildSnapshot({ url: "https://x.test", catalog, text: "" }));
  assert.match(rendered, /Home/);
  assert.match(rendered, /Search/);
  assert.doesNotMatch(rendered, /A dialog is open/);
});
