/**
 * Optional grounding stage — turn a described element into a point.
 *
 * The agent normally aims with element references minted by the snapshot
 * builder ("e12"), resolved deterministically against the live DOM. That is
 * fast, exact, and free, and it stays the default.
 *
 * This module adds a second mode for the eval harness's three-stage
 * architecture: the deciding model names its target in plain language ("the
 * blue Checkout button in the header") and a dedicated grounding model turns
 * that into an x/y point on the current screenshot. It exists to answer whether
 * splitting perception away from decision-making is worth what it costs.
 *
 * The seam is deliberately one object. In `refs` mode createGrounder returns
 * null, and that null is the loop's only mode check — every other code path is
 * byte-identical to production.
 *
 * Ordering note: grounding MUST run before the safety gate. classifyActionRisk
 * reads an element's label out of snapshot.byRef, and a semantic target has no
 * ref — so "the Send button in the compose window" would sail past an
 * outbound-action check that is anchored on the label starting with "send".
 * Grounding first, and writing the description into action.label, keeps that
 * gate fed.
 */

/** Actions whose target must become a point before the actuator sees it. */
const NEEDS_SPATIAL_TARGET = new Set(["click", "type", "drag"]);

/**
 * Actions with no coordinate equivalent. In holo mode the model has no element
 * references to give them, so they are rejected with a redirect rather than
 * silently mis-executed.
 */
const REF_ONLY_ACTIONS = new Map([
  ["select", 'Use `click` to open the dropdown, then `click` the option you want — describe each by what it looks like on screen.'],
  ["replace_text", 'Targeted text replacement is unavailable this run. Click into the field and retype its whole contents with `type`.'],
  ["extract", 'Read the value off the page text in the observation instead of extracting it.'],
]);

/**
 * Grounding mode comes from the caller and ONLY from the caller.
 *
 * This used to fall through to LYKN_BROWSER_GROUNDING, which meant a variable
 * left set in a shell or a launch profile silently switched the shipping agent
 * out of element references and into visual grounding — and when the grounding
 * endpoint is unavailable the loop deliberately hard-fails the run rather than
 * degrading, so the symptom was every task dying with "Grounding is
 * unavailable". The eval harness passes the mode explicitly from its job
 * config and never needed the fallback.
 *
 * @returns {"refs"|"holo"}
 */
function resolveGroundingMode(explicit) {
  const raw = String(explicit || "refs").trim().toLowerCase();
  return raw === "holo" ? "holo" : "refs";
}

/** @returns {"none"|"nearest"|"label"} */
function resolveSnapMode(explicit) {
  const raw = String(explicit || process.env.LYKN_BROWSER_GROUNDING_SNAP || "none").trim().toLowerCase();
  return ["none", "nearest", "label"].includes(raw) ? raw : "none";
}

/**
 * @typedef {object} GroundOutcome
 * @property {boolean} ok
 * @property {object}  [decision]      rewritten, coordinate-carrying decision
 * @property {string}  [invalidReason] caller marks the decision invalid
 * @property {boolean} [fatal]         grounding is unusable; end the run
 * @property {string}  [error]
 * @property {object}  log             what happened, for the trace
 */

/**
 * @param {object} opts
 * @param {"refs"|"holo"} opts.mode
 * @param {{ground: Function}} opts.model agent model exposing ground()
 * @param {"none"|"nearest"|"label"} [opts.snap]
 * @param {number} [opts.retries] transport retries before declaring it fatal
 * @returns {null|object} null in refs mode — the loop's only mode check
 */
function createGrounder({ mode, model, snap = "", retries = 2 } = {}) {
  if (resolveGroundingMode(mode) !== "holo") return null;
  const snapMode = resolveSnapMode(snap);

  /** Terminal decisions and passthrough actions cost nothing. */
  function needsGrounding(decision) {
    if (!decision || decision.kind !== "act") return false;
    const type = String(decision.action?.type || "");
    return NEEDS_SPATIAL_TARGET.has(type) || REF_ONLY_ACTIONS.has(type);
  }

  /** One grounding call, with a couple of retries for transport blips only. */
  async function locate({ description, imageUrl, intent, url, title, hint }) {
    let lastErr = "";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await model.ground({ description, imageUrl, intent, url, title, hint });
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
    return { transportError: lastErr || "grounding unavailable" };
  }

  /**
   * @param {{decision: object, snapshot: object, imageUrl: string}} args
   * @returns {Promise<GroundOutcome>}
   */
  async function ground({ decision, snapshot, imageUrl }) {
    const action = decision.action || {};
    const type = String(action.type || "");

    if (REF_ONLY_ACTIONS.has(type)) {
      return {
        ok: false,
        invalidReason: `\`${type}\` is not available when targets are described rather than referenced. ${REF_ONLY_ACTIONS.get(type)}`,
        log: { type, skipped: "ref_only_action" },
      };
    }

    if (!imageUrl) {
      return {
        ok: false,
        invalidReason: "No screenshot was available to locate the target on. Take a `screenshot` action first.",
        log: { type, skipped: "no_screenshot" },
      };
    }

    const url = snapshot?.url || "";
    const title = snapshot?.title || "";

    // `scroll` with a described container has no coordinate form; scrolling the
    // page is the honest fallback and is what the ref path would do anyway.
    if (type === "scroll") {
      const { target, ...rest } = action;
      return { ok: true, decision: { ...decision, action: rest }, log: { type, note: "scroll target dropped to page scroll" } };
    }

    const description = String(action.target || "").trim();
    if (!description) {
      return { ok: false, invalidReason: "No target was described.", log: { type, skipped: "empty_description" } };
    }

    const primary = await locate({
      description,
      imageUrl,
      intent: type === "type" ? "type" : type === "drag" ? "drag_from" : "click",
      url,
      title,
    });
    if (primary.transportError) {
      return { ok: false, fatal: true, error: primary.transportError, log: { type, description, error: primary.transportError } };
    }
    if (!primary.found) {
      return {
        ok: false,
        invalidReason:
          `Grounding could not find "${description.slice(0, 120)}" on the visible screen. ` +
          "It may be below the fold, inside a closed menu, or drawn differently than you described — " +
          "scroll to it, open the control that contains it, or describe it as it actually appears.",
        log: { type, description, found: false, note: primary.note || "" },
      };
    }

    const base = {
      x: primary.x,
      y: primary.y,
      // Kept even under snap:"none" — the safety gate, the progress narration,
      // the history line and the trace all read it; it just stops driving aim.
      label: description,
      snap: snapMode,
    };
    const log = {
      type, description, found: true, x: primary.x, y: primary.y,
      confidence: primary.confidence, note: primary.note || "", snap: snapMode,
    };

    if (type === "click") {
      return { ok: true, decision: { ...decision, action: { type: "click_coord", ...base } }, log };
    }

    if (type === "type") {
      return {
        ok: true,
        decision: {
          ...decision,
          action: {
            type: "type_coord",
            ...base,
            text: action.text ?? action.value ?? "",
            pressEnter: action.pressEnter === true,
          },
        },
        log,
      };
    }

    // drag needs a second point; a miss on either end is a miss.
    const toDescription = String(action.to || "").trim();
    if (!toDescription) {
      return { ok: false, invalidReason: "A drag needs a described drop target in `to`.", log };
    }
    const drop = await locate({ description: toDescription, imageUrl, intent: "drag_to", url, title });
    if (drop.transportError) {
      return { ok: false, fatal: true, error: drop.transportError, log: { ...log, dropError: drop.transportError } };
    }
    if (!drop.found) {
      return {
        ok: false,
        invalidReason: `Grounding located the drag source but not the drop target "${toDescription.slice(0, 120)}".`,
        log: { ...log, dropFound: false },
      };
    }
    return {
      ok: true,
      decision: {
        ...decision,
        action: { type: "drag", ...base, toX: drop.x, toY: drop.y, toLabel: toDescription },
      },
      log: { ...log, toX: drop.x, toY: drop.y, dropFound: true },
    };
  }

  return {
    mode: "holo",
    /** Holo reads the screen every round, so pixels are no longer conditional. */
    needsPixelsEveryRound: true,
    snap: snapMode,
    needsGrounding,
    ground,
  };
}

module.exports = {
  createGrounder,
  resolveGroundingMode,
  resolveSnapMode,
  NEEDS_SPATIAL_TARGET,
  REF_ONLY_ACTIONS,
};
