/**
 * Deterministic browser controller.
 *
 * The LLM decides WHAT should happen; this layer decides HOW the browser
 * operation is executed. It exposes a small, predictable action API on top of
 * the existing Electron actuators in electron/ownedBrowserAct.cjs and rejects
 * stale element references so the agent can never act on an outdated view.
 */

const { buildSnapshot, diffSnapshots } = require("./snapshot.cjs");
const { createBrowserSession } = require("./session.cjs");

/**
 * @param {object} deps
 * @param {Electron.WebContents} deps.webContents active agent tab
 * @param {object} deps.actuator ownedBrowserAct module (injected for testability)
 * @param {object} [deps.tabs] optional multi-tab adapter:
 *   { list(), open(url), close(tabId), activate(tabId) } — when absent the
 *   controller runs in single-tab mode (openTab falls back to navigate).
 * @param {object} [deps.ownership] optional ownership store (browser/ownership.cjs).
 *   When absent the controller behaves exactly as it did before ownership
 *   existed: every action is permitted and nothing is suppressed.
 * @param {boolean} [deps.autoDismissOverlays] clear cookie walls and popups
 *   before each observe. On by default, including under the eval harness — a
 *   harness that measured an agent with this switched off would be measuring
 *   something we do not ship. Off leaves every banner in the element list for
 *   the model to deal with by hand.
 * @param {object} [deps.session] BrowserSession (browser/session.cjs) — the
 *   authority for observation generations and ref lifetimes. When absent one
 *   is created here, so refs are generation-scoped and session-isolated even
 *   for callers that predate sessions.
 */
function createBrowserController({
  webContents,
  actuator,
  tabs = null,
  ownership = null,
  autoDismissOverlays = true,
  session = null,
}) {
  const refSession = session || createBrowserSession();
  let currentSnapshot = null;
  let snapshotStale = true;
  /**
   * ref -> label, for every ref this run has ever minted.
   *
   * "unknown_reference" alone tells the model its ref is gone but not whether
   * the control is gone too, so it re-observes and guesses. Naming what the
   * ref used to be turns a wasted round into a retarget.
   */
  const seenRefs = new Map();

  function wc() {
    const live = tabs?.getActiveWebContents?.() || webContents;
    if (!live || live.isDestroyed?.()) throw new Error("browser_gone");
    return live;
  }

  function invalidate() {
    snapshotStale = true;
  }

  /**
   * Actions that change the page, and so may only run while the agent holds
   * the browser. Observation is deliberately absent: the agent watching while
   * the user signs in is exactly what makes a hand-off resumable.
   */
  const MUTATING = new Set([
    "navigate", "goBack", "goForward", "click", "clickCoord", "typeAtCoord",
    "drag", "type", "replaceText", "pasteText", "select", "scroll", "pressKey",
    "openTab", "closeTab", "switchTab", "dismissOverlays",
  ]);

  /**
   * Actions aimed at a specific thing on the page. A dialog that appears right
   * after one of these is a dialog the agent asked for — the settings panel it
   * opened, the confirmation on the button it pressed — so the overlay sweeper
   * has to keep its hands off until the page moves on.
   */
  const TARGETED = new Set([
    "click", "clickCoord", "typeAtCoord", "type", "replaceText", "pasteText", "select", "drag", "pressKey",
  ]);

  /** Actions that put a different page in front of the agent. */
  const NAVIGATIONAL = new Set(["navigate", "goBack", "goForward", "openTab", "switchTab"]);

  /**
   * The page whose dialogs are the agent's own doing, or "" when none are.
   * Cleared by navigation, because nothing survives a new document.
   */
  let agentOpenedOn = "";

  /**
   * Refuse an action the agent is not entitled to perform.
   * @returns {null|{ok: false, error: "user_controlling", reason: string}}
   */
  function ownershipBlock(name) {
    if (!ownership || !MUTATING.has(name)) return null;
    if (ownership.mayAct()) return null;
    return {
      ok: false,
      error: "user_controlling",
      reason: ownership.reason() || "the user has control of the browser",
      state: ownership.state(),
    };
  }

  /**
   * Gate an action, and remember the kind of thing it was.
   *
   * Every mutating action goes through here, which is the only place that can
   * see the whole sequence — and the overlay sweeper's one safety rule is about
   * the sequence, not about any single action.
   */
  function beginAction(name) {
    const blocked = ownershipBlock(name);
    if (blocked) return blocked;
    if (TARGETED.has(name)) agentOpenedOn = currentUrl() || "-";
    else if (NAVIGATIONAL.has(name)) agentOpenedOn = "";
    return null;
  }

  /**
   * How far the live viewport may drift from the one the snapshot was measured
   * against before coordinate aims are refused. 2% absorbs scrollbar and
   * rounding noise; a layout change (the agent rail opening beside the
   * browser resizes the view by ~20%) is far past it.
   */
  const LAYOUT_DRIFT_TOLERANCE = 0.02;

  /**
   * Refuse a coordinate-aimed action when the view was resized after the page
   * was read.
   *
   * The UI can resize the browser mid-round — the agent rail opening on the
   * first progress event shrinks the docked view — and every screenshot
   * coordinate and inView flag in the current snapshot describes the old
   * layout. Ref-targeted actions survive this (they re-resolve by selector at
   * act time), so only actions that aim at a point pay this check. On drift the
   * snapshot is invalidated, which forces the loop to re-observe — the layout
   * epoch, in effect: an observation is only actionable while the geometry it
   * was taken under still holds.
   *
   * @returns {Promise<null|{ok:false, error:"layout_changed", hint:string}>}
   */
  async function layoutDriftBlock() {
    const vp = currentSnapshot?.viewport;
    if (!vp?.w || !vp?.h || typeof actuator.getViewportMetrics !== "function") return null;
    let live = null;
    try {
      live = await actuator.getViewportMetrics(wc());
    } catch {
      return null;
    }
    const liveW = Number(live?.w);
    const liveH = Number(live?.h);
    if (!Number.isFinite(liveW) || !Number.isFinite(liveH) || liveW <= 0 || liveH <= 0) return null;
    const drift = Math.max(Math.abs(liveW - vp.w) / vp.w, Math.abs(liveH - vp.h) / vp.h);
    if (drift <= LAYOUT_DRIFT_TOLERANCE) return null;
    invalidate();
    return {
      ok: false,
      error: "layout_changed",
      hint:
        `The browser viewport changed size (${vp.w}x${vp.h} -> ${liveW}x${liveH}) after the page was read, ` +
        "so positions read off the old view no longer land where they aim. The page has been marked for " +
        "re-reading — observe again and take a fresh screenshot before aiming at a point.",
    };
  }

  /**
   * Refuse a coordinate aim taken from an observation that has since been
   * invalidated.
   *
   * Ref actions tolerate this — they re-resolve by selector — but a point read
   * off a screenshot describes the page as it stood at observe time. When
   * something invalidated the snapshot between observe and act (the user
   * scrolled to peek, an overlay sweep moved the page), the point aims at
   * whatever is there now. Refusing costs one re-observe; clicking costs
   * whatever moved under the cursor.
   */
  function staleViewBlock() {
    if (currentSnapshot && !snapshotStale) return null;
    return {
      ok: false,
      error: "stale_view",
      hint:
        "The page changed after it was read — it may have been scrolled or altered while you were " +
        "deciding. Re-read the page and take a fresh screenshot before aiming at a point.",
    };
  }

  /**
   * Run an actuator call inside the suppression window.
   *
   * Electron raises `input-event` for synthetic input as well as real input,
   * so without this every click the agent makes reads as the user taking the
   * wheel — the agent would stop itself on its own first action.
   */
  async function asAgent(fn) {
    ownership?.beginAgentInput?.();
    try {
      return await fn();
    } finally {
      ownership?.endAgentInput?.();
    }
  }

  function resolveRef(ref) {
    const wanted = String(ref || "").trim();
    if (!wanted) return { error: "missing_target" };
    if (!currentSnapshot || snapshotStale) return { error: "stale_reference" };
    // A durable locator from a previous snapshot. Refs die with the document;
    // this is how the model re-aims after a reload without another observe.
    if (wanted.startsWith("loc=")) {
      const loc = wanted.slice(4).trim();
      const hit = currentSnapshot.byLoc?.get(loc);
      if (hit) return { el: hit };
      return { error: "unknown_reference", hint: `No element on this page matches ${wanted}.` };
    }
    const el = currentSnapshot.byRef.get(wanted);
    if (!el) {
      // Not on the current view. Say precisely WHY, because the recoveries
      // differ: a stale ref means "re-observe and re-aim", a foreign ref means
      // the model is reusing a handle from another task or from before a
      // restart, and a malformed ref means it invented one.
      const missing = refSession.classifyMissingRef(wanted);
      const was = seenRefs.get(wanted);
      if (missing.kind === "stale") {
        return {
          error: "stale_reference",
          hint:
            (was ? `${wanted} was "${was}" in an earlier view of this page. ` : `${wanted} came from an earlier view of this page. `) +
            "References are only valid for the snapshot they came from — the page has been re-read since. " +
            "Aim at the same control using a reference from the CURRENT element list.",
        };
      }
      if (missing.kind === "foreign") {
        return {
          error: "foreign_reference",
          hint:
            `${wanted} was not created in this task's browser session, so it cannot name anything here. ` +
            "Use only references from the CURRENT element list.",
        };
      }
      if (missing.kind === "malformed") {
        return {
          error: "malformed_reference",
          hint: `${wanted} is not an element reference. Use a reference from the element list (like "g7:12") or loc=….`,
        };
      }
      return {
        error: "unknown_reference",
        hint: was
          ? `${wanted} was "${was}" earlier in this run and is not on the page now. ` +
            `Re-read the element list and aim at what is there.`
          : `${wanted} is not on this page. Re-read the element list.`,
      };
    }
    return { el };
  }

  async function listTabs() {
    if (tabs?.list) {
      try {
        const out = await tabs.list();
        if (Array.isArray(out) && out.length) return out;
      } catch {
        /* fall through to single-tab */
      }
    }
    const w = wc();
    return [
      {
        id: "tab-1",
        url: w.getURL?.() || "",
        title: w.getTitle?.() || "",
        active: true,
      },
    ];
  }

  // --- overlays ---------------------------------------------------------------

  /** Dismissals already attempted, per page, so a stubborn wall gets one go. */
  const overlaysTried = new Map();

  /** Dismissals allowed on one page, before we accept it is fighting back. */
  const OVERLAY_CAP_PER_PAGE = 6;
  const overlaysCleared = new Map();

  /** Pages remembered for overlay bookkeeping. A long run visits many. */
  const OVERLAY_PAGE_MEMORY = 40;

  function overlayKey() {
    const url = currentUrl();
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return url || "-";
    }
  }

  /**
   * Clear the cookie walls, consent managers and promo modals in front of the
   * page.
   *
   * Nothing here judges what may be clicked — that is browserOverlays.cjs, via
   * the actuator. What this owns is the bookkeeping that keeps a sweep from
   * becoming a loop: a dismissal that leaves its overlay standing is never
   * tried twice on the same page, and a page that keeps producing walls stops
   * being swept once the cap is reached and is handed to the model instead.
   */
  async function dismissOverlays({ allowGeneric = true } = {}) {
    const empty = { ok: true, dismissed: [], remaining: [] };
    if (typeof actuator.dismissOverlays !== "function") return empty;
    const blocked = beginAction("dismissOverlays");
    if (blocked) return blocked;
    let w;
    try {
      w = wc();
    } catch {
      return { ok: false, error: "browser_gone", dismissed: [], remaining: [] };
    }
    const key = overlayKey();
    const cleared = overlaysCleared.get(key) || 0;
    if (cleared >= OVERLAY_CAP_PER_PAGE) return { ...empty, capped: true };
    if (!overlaysTried.has(key)) {
      // A long run on a big app visits hundreds of pages; the ledger only
      // exists to stop one page being swept forever, so keep it bounded.
      if (overlaysTried.size >= OVERLAY_PAGE_MEMORY) {
        const oldest = overlaysTried.keys().next().value;
        overlaysTried.delete(oldest);
        overlaysCleared.delete(oldest);
      }
      overlaysTried.set(key, new Set());
    }
    const tried = overlaysTried.get(key);
    const res = await asAgent(() =>
      actuator.dismissOverlays(w, {
        allowGeneric,
        skipSignatures: [...tried],
        maxDismissals: Math.min(3, OVERLAY_CAP_PER_PAGE - cleared),
      }),
    ).catch((e) => ({ ok: false, error: e?.message || String(e), dismissed: [], remaining: [] }));
    for (const sig of res?.tried || []) tried.add(sig);
    if (res?.dismissed?.length) {
      overlaysCleared.set(key, cleared + res.dismissed.length);
      // The page under the banner is not the page above it.
      invalidate();
    }
    return { dismissed: [], remaining: [], ...res };
  }

  /**
   * Cookie walls and promo modals arrive on their own, so they are cleared on
   * the observe that follows. A dialog the agent's own click opened is not one
   * of those — closing that would be the agent undoing its own work — so a
   * targeted interaction suppresses the sweep until the page moves on.
   */
  function shouldSweepOverlays() {
    if (!autoDismissOverlays) return false;
    if (typeof actuator.dismissOverlays !== "function") return false;
    if (!agentOpenedOn) return true;
    return (currentUrl() || "-") !== agentOpenedOn;
  }

  /**
   * Capture a fresh structured snapshot. This is the ONLY way the agent sees
   * the page; element refs are minted here and die on the next navigation.
   */
  async function getPageState() {
    const w = wc();
    // Before the catalog is read, not after: an element list that still
    // contains the banner is a page the model has to reason its way past, and
    // the point of sweeping is that it never has to.
    //
    // allowGeneric:false — the automatic sweep only clears overlays it can
    // positively name (cookie walls, consent managers, notification nags,
    // promos, surveys, app interstitials). The generic tier — "something
    // covers the page and has an X" — is indistinguishable by shape from a
    // modal the APP opened as part of its own flow: a template chooser, a
    // wizard step, a share sheet. Auto-closing one of those closed the very
    // dialog the task needed, and every click after that aimed at a ghost.
    // Generic overlays are left in the element list with [dialog] markers for
    // the model to judge; its explicit `dismiss_overlay` action still passes
    // allowGeneric:true, so a wall it decides is junk can still be cleared.
    const swept = shouldSweepOverlays()
      ? await dismissOverlays({ allowGeneric: false }).catch(() => null)
      : null;
    const [catalogRes, contextRes, tabList] = await Promise.all([
      actuator.getDOMCatalog(w),
      actuator.getPageContext(w),
      listTabs(),
    ]);
    // A collector that failed is not a page with no controls. Both look like an
    // empty element list, and the agent reasons very differently about "this
    // page has nothing on it" and "I could not read this page".
    const catalogFailed = !catalogRes || catalogRes.ok === false || !Array.isArray(catalogRes.items);
    const contextFailed = !contextRes || contextRes.ok === false;
    // A new authoritative observation begins a new generation: every ref
    // handed out below embeds it, and every ref from before this line is now
    // formally stale rather than informally risky.
    currentSnapshot = buildSnapshot({
      url: contextRes?.url || catalogRes?.url || w.getURL?.() || "",
      title: contextRes?.title || w.getTitle?.() || "",
      catalog: Array.isArray(catalogRes?.items) ? catalogRes.items : [],
      text: contextRes?.text || "",
      tabs: tabList,
      viewport: catalogRes?.viewport || null,
      generation: refSession.beginGeneration(),
    });
    currentSnapshot.collectorFailed = catalogFailed || contextFailed;
    // What was in the way, and what still is. Both matter to the model: the
    // first explains a page that changed under it without it acting, and the
    // second is the only warning it gets that its clicks may not be landing.
    currentSnapshot.overlaysDismissed = swept?.dismissed || [];
    currentSnapshot.overlaysBlocking = swept?.remaining || [];
    for (const el of currentSnapshot.elements) {
      if (el.label) seenRefs.set(el.ref, el.label);
    }
    // A long run on a big app can mint thousands of refs; the ledger only
    // exists to explain the last few, so keep it bounded.
    if (seenRefs.size > 4000) {
      for (const key of [...seenRefs.keys()].slice(0, seenRefs.size - 4000)) seenRefs.delete(key);
    }
    snapshotStale = false;
    return currentSnapshot;
  }

  function getCurrentSnapshot() {
    return snapshotStale ? null : currentSnapshot;
  }

  async function settle(timeoutMs = 8000) {
    // Settling is best-effort by design, and that has to include getting hold
    // of the tab: wc() throws when the window has gone, and the loop awaits
    // this without a guard, so a closed window rejected out of the whole run
    // instead of ending it as a task failure.
    let w;
    try {
      w = wc();
    } catch {
      return;
    }
    try {
      await actuator.waitForLoad(w, timeoutMs);
    } catch {
      /* settle is best-effort */
    }
    if (typeof actuator.waitForDomSettle === "function") {
      try {
        await actuator.waitForDomSettle(w, Math.min(timeoutMs, 3500));
      } catch {
        /* best-effort */
      }
    }
  }

  // --- deterministic actions -------------------------------------------------

  async function navigate(url) {
    const blocked = beginAction("navigate");
    if (blocked) return blocked;
    const res = await asAgent(() => actuator.navigate(wc(), url));
    invalidate();
    return res;
  }

  async function goBack() {
    const blocked = beginAction("goBack");
    if (blocked) return blocked;
    const res = await asAgent(() => actuator.runAction(wc(), { type: "back" }, []));
    invalidate();
    return res;
  }

  async function goForward() {
    const blocked = beginAction("goForward");
    if (blocked) return blocked;
    const res = await asAgent(() => actuator.runAction(wc(), { type: "forward" }, []));
    invalidate();
    return res;
  }

  async function click(ref) {
    const blocked = beginAction("click");
    if (blocked) return blocked;
    const { el, error, hint } = resolveRef(ref);
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
    const res = await asAgent(() => actuator.runAction(
      wc(),
      {
        type: "click",
        id: el.raw.id,
        selector: el.raw.selector,
        label: el.label,
        frameId: el.raw.frameId,
        clientX: el.raw.clientX,
        clientY: el.raw.clientY,
        // Never guess: fail (and re-observe) instead of fuzzy-matching a
        // similar label or clicking through an overlay.
        strictTarget: true,
        minLabelScore: 80,
      },
      catalogItems(),
    ));
    // Clicks routinely change the page (navigation, dialogs, menus) — force a
    // re-observe before the next element interaction.
    invalidate();
    return res;
  }

  async function type(ref, text, { pressEnter = false, mode = "append" } = {}) {
    const blocked = beginAction("type");
    if (blocked) return blocked;
    const { el, error, hint } = resolveRef(ref);
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
    // mode "replace": set the field's whole value deterministically (inputs /
    // textareas). Rich-text bodies should use replaceText for targeted edits
    // instead of wiping and retyping.
    if (mode === "replace") {
      const tag = String(el.raw.tag || "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const res = await asAgent(() => actuator.runAction(
          wc(),
          {
            type: "fill",
            id: el.raw.id,
            selector: el.raw.selector,
            label: el.label,
            frameId: el.raw.frameId,
            clientX: el.raw.clientX,
            clientY: el.raw.clientY,
            text: String(text ?? ""),
            strictTarget: true,
            minLabelScore: 80,
          },
          catalogItems(),
        ));
        invalidate();
        return res;
      }
      // An EMPTY rich-text field has nothing to replace — "replace" and
      // "append" are the same action, so just type instead of burning a round
      // on an error the model has to reinterpret.
      if (!String(el.raw.value || "").trim()) {
        mode = "append";
      }
      // Anything else keeps mode "replace" and falls through to the typing
      // path below, which now clears the field with real keys before typing.
      // Refusing here was a dead end on exactly the fields that most need
      // correcting — contenteditable boxes and recipient fields that commit
      // their contents into chips — and left the agent clicking at a mistake
      // it had no way to erase. `replace_text` remains the better tool for
      // editing ONE passage inside a long document; this is for putting a
      // whole field right.
    }
    const res = await asAgent(() => actuator.runAction(
      wc(),
      {
        type: "click_type",
        id: el.raw.id,
        selector: el.raw.selector,
        label: el.label,
        frameId: el.raw.frameId,
        clientX: el.raw.clientX,
        clientY: el.raw.clientY,
        text: String(text ?? ""),
        pressEnter: !!pressEnter,
        strictTarget: true,
        minLabelScore: 80,
        // Carried so the actuator empties the field before typing — this is
        // what makes correcting a value work on rich and chip-based fields.
        mode,
      },
      catalogItems(),
    ));
    // Typing changes field values that the catalog now displays — decide the
    // next step from a fresh snapshot, or the model sees pre-typing "empty"
    // fields and fills them again (duplicated email bodies).
    invalidate();
    return res;
  }

  /**
   * Put a whole body of text into the editor on this page, via the clipboard.
   *
   * Typing is how you fill a field; this is how you fill a DOCUMENT. Editors
   * accept a paste as one operation — formatting, line breaks and all — where
   * typing thousands of characters is slow, and slow typing into a live editor
   * is where autocomplete, autosave and reformatting get to interfere.
   *
   * This exists so that writing into Notion, Docs or Slides happens INSIDE the
   * agent loop. It used to be a separate pipeline: draft, paste, hope — with
   * no verification, no safety gate, no trace, and no recovery when the paste
   * silently did nothing.
   */
  async function pasteText(text, { replaceAll = false } = {}) {
    const blocked = beginAction("pasteText");
    if (blocked) return blocked;
    if (typeof actuator.pasteTextIntoPage !== "function") {
      return { ok: false, error: "paste_unsupported" };
    }
    const body = String(text ?? "");
    if (!body.trim()) return { ok: false, error: "empty_text" };
    const res = await asAgent(() =>
      actuator.pasteTextIntoPage(wc(), { text: body, replaceAll: !!replaceAll }),
    );
    invalidate();
    return res || { ok: false, error: "paste_failed" };
  }

  /**
   * Targeted in-place edit: find `findText` inside the element and replace
   * only that occurrence, preserving everything else. Works on inputs,
   * textareas and rich-text (contenteditable) fields. This is the right tool
   * for revisions — never retype a whole document to change one passage.
   */
  async function replaceText(ref, findText, replaceWith) {
    const blocked = beginAction("replaceText");
    if (blocked) return blocked;
    const { el, error, hint } = resolveRef(ref);
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
    const needle = String(findText ?? "");
    if (!needle.trim()) return { ok: false, error: "missing_find_text" };
    const evaluate = evaluatorFor(el);
    if (!evaluate) return { ok: false, error: "frame_gone" };
    try {
      const res = await asAgent(() => evaluate(
        buildReplaceTextJs({
          selector: el.raw.selector || "",
          find: needle,
          replace: String(replaceWith ?? ""),
        }),
      ));
      if (res?.ok) invalidate();
      return res || { ok: false, error: "replace_failed" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function select(ref, value) {
    const blocked = beginAction("select");
    if (blocked) return blocked;
    const { el, error, hint } = resolveRef(ref);
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
    const res = await asAgent(() => actuator.runAction(
      wc(),
      {
        type: "select",
        id: el.raw.id,
        selector: el.raw.selector,
        label: el.label,
        frameId: el.raw.frameId,
        value: String(value ?? ""),
      },
      catalogItems(),
    ));
    invalidate();
    return res;
  }

  /**
   * Run page JS where the element actually lives. Elements cataloged from an
   * embedded editor's iframe are absent from the main document, so reading or
   * editing them from there always misses.
   */
  function evaluatorFor(el) {
    const frameId = el?.raw?.frameId;
    if (frameId == null || typeof actuator.frameByRoutingId !== "function") {
      return (js) => wc().executeJavaScript(js, true);
    }
    const frame = actuator.frameByRoutingId(wc(), frameId);
    if (!frame) return null;
    return (js) => frame.executeJavaScript(js, true);
  }

  async function scroll(direction = "down", amount = 600, ref = "") {
    const blocked = beginAction("scroll");
    if (blocked) return blocked;
    const dir = direction === "up" ? "up" : "down";
    // A ref means "scroll inside this thing" — editor palettes, block lists and
    // side panels scroll internally and ignore window scrolling entirely.
    if (ref) {
      const { el, error, hint } = resolveRef(ref);
      if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
      const res = await asAgent(() => actuator.runAction(
        wc(),
        {
          type: "scroll_element",
          selector: el.raw.selector,
          frameId: el.raw.frameId,
          direction: dir,
          amount,
        },
        catalogItems(),
      ));
      invalidate();
      return res;
    }
    const res = await asAgent(() =>
      actuator.runAction(wc(), { type: "scroll", direction: dir, amount }, []));
    // Scrolling is the whole point of scrolling: what is on screen changes, and
    // every element's position changes with it. Leaving the cache warm meant the
    // agent re-read the identical pre-scroll page every round and never saw a
    // single thing it scrolled to.
    invalidate();
    return res;
  }

  /**
   * Drag one element onto another. Both ends may be element refs or 0–1000
   * screenshot coordinates, so this works on canvas editors where the drop
   * target has no DOM presence at all.
   */
  async function drag(from, to, { mode = "" } = {}) {
    const blocked = beginAction("drag");
    if (blocked) return blocked;
    // Only coordinate endpoints depend on the geometry the snapshot was
    // measured under; a ref-to-ref drag re-resolves both ends by selector.
    const usesCoords =
      (from && typeof from === "object" && from.x != null) ||
      (to && typeof to === "object" && to.x != null);
    if (usesCoords) {
      const stale = staleViewBlock();
      if (stale) return stale;
      const drifted = await layoutDriftBlock();
      if (drifted) return drifted;
    }
    const action = { type: "drag", mode };
    if (from && typeof from === "object" && from.x != null) {
      action.x = Number(from.x);
      action.y = Number(from.y);
    } else {
      const { el, error, hint } = resolveRef(from);
      if (error) return { ok: false, error: `drag source: ${error}`, ...(hint ? { hint } : {}) };
      action.selector = el.raw.selector;
      action.label = el.label;
      action.clientX = el.raw.clientX;
      action.clientY = el.raw.clientY;
      action.frameId = el.raw.frameId;
    }
    if (to && typeof to === "object" && to.x != null) {
      action.toX = Number(to.x);
      action.toY = Number(to.y);
    } else {
      const { el, error, hint } = resolveRef(to);
      if (error) return { ok: false, error: `drop target: ${error}`, ...(hint ? { hint } : {}) };
      action.toSelector = el.raw.selector;
      action.toLabel = el.label;
      action.toClientX = el.raw.clientX;
      action.toClientY = el.raw.clientY;
      action.toFrameId = el.raw.frameId;
    }
    const res = await asAgent(() => actuator.runAction(wc(), action, catalogItems()));
    invalidate();
    return res;
  }

  /**
   * Click a point read off the screenshot (0–1000 in each axis). The escape
   * hatch for anything the DOM cannot describe: canvas editors, image maps,
   * custom-drawn controls.
   */
  /**
   * Click a point in 0-1000 screenshot space.
   *
   * `snap` decides whether the actuator may nudge the click onto a nearby
   * catalog element. "label" (the default) is production behaviour. "none" is
   * for measuring a grounding model honestly: label snapping would let a
   * mediocre grounder score like a good one on DOM-describable pages, and on
   * drawn surfaces there is nothing in the catalog to snap to anyway.
   */
  async function clickCoord(x, y, label = "", { snap = "" } = {}) {
    const blocked = beginAction("clickCoord");
    if (blocked) return blocked;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return { ok: false, error: "bad_coords" };
    }
    const stale = staleViewBlock();
    if (stale) return stale;
    const drifted = await layoutDriftBlock();
    if (drifted) return drifted;
    const res = await asAgent(() => actuator.runAction(
      wc(),
      { type: "click_coord", x: nx, y: ny, label: String(label || ""), ...(snap ? { snap } : {}) },
      catalogItems(),
    ));
    invalidate();
    return res;
  }

  /**
   * Focus a field at a screenshot point and type into it.
   *
   * The ref path resolves a field to a selector and types into it directly.
   * With a described target there is no selector, so this rides the actuator's
   * click_type, which clicks to place a real mouse focus before inserting text
   * — the same reason the ref path exists at all.
   */
  async function typeAtCoord(x, y, text, { pressEnter = false, label = "", snap = "" } = {}) {
    const blocked = beginAction("typeAtCoord");
    if (blocked) return blocked;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return { ok: false, error: "bad_coords" };
    }
    const stale = staleViewBlock();
    if (stale) return stale;
    const drifted = await layoutDriftBlock();
    if (drifted) return drifted;
    const res = await asAgent(() => actuator.runAction(
      wc(),
      {
        type: "click_type",
        x: nx,
        y: ny,
        text: String(text ?? ""),
        pressEnter: !!pressEnter,
        label: String(label || ""),
        ...(snap ? { snap } : {}),
      },
      catalogItems(),
    ));
    invalidate();
    return res;
  }

  async function pressKey(key = "Enter", modifiers = null) {
    const blocked = beginAction("pressKey");
    if (blocked) return blocked;
    const mods = Array.isArray(modifiers) ? modifiers.filter(Boolean).map(String) : [];
    const res = await asAgent(() => actuator.runAction(
      wc(),
      { type: "press_key", key, modifiers: mods },
      catalogItems(),
    ));
    // Every key can change the page: Enter submits, Escape closes, Tab moves
    // focus and fires validation, arrows move through a combobox, Backspace
    // edits. Invalidating only for Enter and modifier chords meant the loop
    // diffed the pre-action snapshot against itself, so those keys were scored
    // as "no observable page change" every single time they were used.
    invalidate();
    return res;
  }

  /** Read an element's live value/text — the evidence for form verification. */
  async function extract(ref) {
    const { el, error, hint } = resolveRef(ref);
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
    const evaluate = evaluatorFor(el);
    if (!evaluate) return { ok: false, error: "frame_gone" };
    try {
      const value = await evaluate(
        `(function(){try{var el=document.querySelector(${JSON.stringify(el.raw.selector || "")});` +
          `if(!el)return null;return {value:(el.value!=null?el.value:el.innerText||'').slice(0,2000),` +
          `checked:el.checked===true};}catch(e){return null;}})()`,
      );
      if (!value) return { ok: false, error: "element_not_found" };
      return { ok: true, ref, label: el.label, ...value };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function wait(ms = 800) {
    const clamped = Math.min(Math.max(Number(ms) || 800, 100), 10000);
    await new Promise((r) => setTimeout(r, clamped));
    // Waiting exists precisely because the page is expected to change while we
    // do it. Keeping the old snapshot defeats the only reason to call this.
    invalidate();
    return { ok: true, type: "wait", ms: clamped };
  }

  async function screenshot() {
    try {
      const dataUrl = await actuator.screenshotDataUrl(wc(), {
        maxWidth: 1200,
        jpegQuality: 70,
      });
      return dataUrl ? { ok: true, dataUrl } : { ok: false, error: "screenshot_failed" };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function openTab(url) {
    const blocked = beginAction("openTab");
    if (blocked) return blocked;
    if (tabs?.open) {
      const res = await asAgent(() => tabs.open(url));
      invalidate();
      return res?.ok === false ? res : { ok: true, ...res };
    }
    // Single-tab mode: opening a tab degrades to navigation.
    return navigate(url);
  }

  async function closeTab(tabId) {
    const blocked = beginAction("closeTab");
    if (blocked) return blocked;
    if (tabs?.close) {
      const res = await asAgent(() => tabs.close(tabId));
      invalidate();
      return res?.ok === false ? res : { ok: true, ...res };
    }
    return { ok: false, error: "single_tab_mode" };
  }

  async function switchTab(tabId) {
    const blocked = beginAction("switchTab");
    if (blocked) return blocked;
    if (tabs?.activate) {
      const res = await asAgent(() => tabs.activate(tabId));
      invalidate();
      return res?.ok === false ? res : { ok: true, ...res };
    }
    return { ok: false, error: "single_tab_mode" };
  }

  function catalogItems() {
    if (!currentSnapshot) return [];
    return currentSnapshot.elements.map((e) => e.raw);
  }

  /**
   * In-page find-and-replace. Inputs/textareas: replace inside .value via the
   * prototype setter (frameworks see a real input event). Contenteditable:
   * replace within the text node containing the match. Payload travels as
   * base64 JSON (same pattern as ownedBrowserAct.buildActionJs).
   */
  function buildReplaceTextJs(payload) {
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return (
      "/*lykn-replace-text*/(function(){try{var a=JSON.parse(decodeURIComponent(escape(atob('" +
      b64 +
      "'))));" +
      "var el=null;try{el=document.querySelector(a.selector);}catch(e){}" +
      "if(!el)return {ok:false,error:'element_not_found'};" +
      "var find=a.find,rep=a.replace;" +
      "if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){" +
      "var v=el.value||'';var i=v.indexOf(find);" +
      "if(i<0)return {ok:false,error:'text_not_found'};" +
      "var nv=v.slice(0,i)+rep+v.slice(i+find.length);" +
      "var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
      "var d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,nv);else el.value=nv;" +
      "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
      "return {ok:true,replaced:true,valueLen:nv.length,preview:nv.slice(Math.max(0,i-40),i+rep.length+40)};}" +
      "var root=el.isContentEditable?el:(el.querySelector&&el.querySelector('[contenteditable=\"true\"]'))||el;" +
      "if(!root||!(root.isContentEditable||root.getAttribute&&root.getAttribute('contenteditable')==='true')){" +
      "return {ok:false,error:'not_editable'};}" +
      // Fast path: match within a single text node (preserves formatting).
      "var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n;" +
      "while((n=w.nextNode())){var idx=n.nodeValue.indexOf(find);" +
      "if(idx>-1){n.nodeValue=n.nodeValue.slice(0,idx)+rep+n.nodeValue.slice(idx+find.length);" +
      "root.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return {ok:true,replaced:true,preview:n.nodeValue.slice(Math.max(0,idx-40),idx+rep.length+40)};}}" +
      // Cross-node path: editors split lines into separate elements (Gmail's
      // body is one <div> per line), so any passage crossing a line break
      // never sits in one text node. Match with whitespace collapsed across
      // ALL text nodes (a virtual break separates adjacent nodes), then
      // delete the exact range and insert the replacement (newlines → <br>).
      "var tnodes=[];var w2=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),t;" +
      "while((t=w2.nextNode())){tnodes.push(t);}" +
      "var chars=[],raw=[];" +
      "for(var k=0;k<tnodes.length;k++){if(k){chars.push('\\n');raw.push(null);}" +
      "var v=tnodes[k].nodeValue;for(var c=0;c<v.length;c++){chars.push(v[c]);raw.push({k:k,off:c});}}" +
      "var ns='',nmap=[];" +
      "for(var i=0;i<chars.length;i++){var ch=chars[i];" +
      "if(/\\s/.test(ch)){if(ns&&ns[ns.length-1]===' ')continue;ns+=' ';nmap.push(i);}" +
      "else{ns+=ch;nmap.push(i);}}" +
      "var needle=String(find).replace(/\\s+/g,' ').trim();" +
      "if(!needle)return {ok:false,error:'text_not_found'};" +
      "var pos=ns.indexOf(needle);" +
      "if(pos<0)return {ok:false,error:'text_not_found',hint:'That exact passage is not in the field — re-read the content and copy the snippet verbatim.'};" +
      "var si=nmap[pos],ei=nmap[pos+needle.length-1];" +
      "while(si<raw.length&&raw[si]==null)si++;" +
      "while(ei>=0&&raw[ei]==null)ei--;" +
      "if(si>=raw.length||ei<0||si>ei)return {ok:false,error:'text_not_found'};" +
      "var st=raw[si],en=raw[ei];" +
      "var range=document.createRange();" +
      "range.setStart(tnodes[st.k],st.off);range.setEnd(tnodes[en.k],en.off+1);" +
      "range.deleteContents();" +
      "if(rep){var frag=document.createDocumentFragment();var parts=String(rep).split('\\n');" +
      "for(var q2=0;q2<parts.length;q2++){if(q2)frag.appendChild(document.createElement('br'));" +
      "if(parts[q2])frag.appendChild(document.createTextNode(parts[q2]));}" +
      "range.insertNode(frag);}" +
      "root.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return {ok:true,replaced:true,crossNode:true,preview:(rep||'').slice(0,80)};" +
      "}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()"
    );
  }

  function currentUrl() {
    try {
      return wc().getURL?.() || "";
    } catch {
      return "";
    }
  }

  return {
    getPageState,
    getCurrentSnapshot,
    settle,
    invalidate,
    dismissOverlays,
    navigate,
    goBack,
    goForward,
    click,
    clickCoord,
    typeAtCoord,
    drag,
    type,
    replaceText,
    pasteText,
    select,
    scroll,
    pressKey,
    extract,
    wait,
    screenshot,
    openTab,
    closeTab,
    switchTab,
    listTabs,
    currentUrl,
    diffSnapshots,
    ownership: () => ownership,
    session: () => refSession,
  };
}

module.exports = { createBrowserController };
