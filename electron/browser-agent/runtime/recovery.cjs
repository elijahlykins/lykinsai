/**
 * Recovery system — explicit, tracked behavior when an action fails or
 * verification shows no progress. Retries are counted per action signature
 * in structured state (never by asking the model to remember); after 2
 * retries of essentially the same operation the strategy escalates.
 */

const { parseRef } = require("../browser/session.cjs");

const MAX_SAME_ACTION_RETRIES = 2;
const MAX_TOTAL_RECOVERIES = 6;

/**
 * Visual inspection is worth repeating. A single screenshot for the whole task
 * meant that once it was spent, later failures on a completely different screen
 * had no way to look at what was actually there.
 */
const MAX_VISUAL_RECOVERIES = 3;

function createRecoveryTracker() {
  const failuresBySignature = new Map();
  let totalRecoveries = 0;
  let visualUses = 0;

  /**
   * Verified progress earns recovery budget back.
   *
   * The total used to be a lifetime cap, which punished exactly the runs that
   * were working: a long task that hit — and got past — a few scattered snags
   * arrived at its last step with nothing left, and died on the first
   * two-failure wobble there while its ladder still had rungs to try. Each
   * verified success decays the total by one, so the cap only ever ends runs
   * whose failures are outpacing their progress.
   */
  function noteProgress() {
    totalRecoveries = Math.max(0, totalRecoveries - 1);
  }

  /**
   * What counts as "the same action again".
   *
   * Coordinates, key names and select values all used to be missing, so every
   * `click_coord` on a page shared one budget however far apart the points
   * were, every `press_key` shared one whatever the key, and every `select` on
   * a field shared one whatever the value. Two unrelated attempts read as one
   * action failing twice, and the ladder answered with "do NOT repeat it" —
   * on the canvas editors where coordinate clicking is the only method
   * available, that spent the escalation path on the agent's second try.
   */
  function signatureOf(decision) {
    const a = decision?.action || {};
    // Coordinates get bucketed: a retry never lands on the exact same pixel,
    // and a 20-unit bucket (2% of the frame) is close enough to be the same
    // attempt while a different control is a different signature.
    const bucket = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) / 20) : "");
    // References embed the observation generation and are re-minted on every
    // snapshot, so two retries of the same element never share a raw ref. The
    // uid is the document-lifetime identity — that is what "the same action
    // again" means here. Without this the ladder could never get past its
    // first rung for ref-targeted actions: every retry re-observes, and the
    // fresh ref read as a brand-new action.
    const stableTarget = (t) => {
      const parsed = parseRef(t);
      return parsed ? parsed.uid : String(t || "");
    };
    return [
      a.type || "",
      stableTarget(a.target),
      String(a.url || "").slice(0, 80),
      String(a.text || "").slice(0, 40),
      String(a.value ?? "").slice(0, 40),
      String(a.key || ""),
      (Array.isArray(a.modifiers) ? a.modifiers : []).join("+"),
      bucket(a.x),
      bucket(a.y),
      stableTarget(a.to),
      bucket(a.toX),
      bucket(a.toY),
    ]
      .join("|")
      .toLowerCase();
  }

  /**
   * Decide the next recovery step for a failed action.
   * Ladder: refresh snapshot & retry → find equivalent target → visual
   * inspection → replan → give up.
   */
  function nextRecoveryStep({ decision, verification }) {
    totalRecoveries += 1;
    if (totalRecoveries > MAX_TOTAL_RECOVERIES) {
      return { mode: "fail", hint: "recovery budget exhausted" };
    }
    if (verification?.next === "replan") {
      return { mode: "replan", hint: verification.reason || "verifier requested replan" };
    }
    const sig = signatureOf(decision);
    const count = (failuresBySignature.get(sig) || 0) + 1;
    failuresBySignature.set(sig, count);

    const staleRef =
      /stale_reference|unknown_reference|element not found|element_not_found/i.test(
        String(verification?.reason || ""),
      );
    // The view was resized or changed between reading the page and acting on
    // it — the aim was refused before anything ran, so this is not a failed
    // approach.
    const staleLayout = /layout_changed|stale_screenshot|stale_view/i.test(
      String(verification?.reason || ""),
    );

    if (count === 1) {
      return {
        mode: "retry_fresh",
        hint: staleLayout
          ? "The view you aimed with was out of date — the page was resized, scrolled or changed after it was read — so nothing actually ran. Re-observe, take a fresh screenshot if you were aiming at a point, and do the same step again."
          : staleRef
            ? "The element reference went stale. Re-observe the page and act on the equivalent element in the fresh snapshot."
            : `The action did not produce the expected result (${verification?.reason || "no progress"}). Re-observe and retry — the target may have moved, or the page may have changed unexpectedly.`,
      };
    }
    if (count === 2) {
      return {
        mode: "find_equivalent",
        // Named this bluntly because the model's favorite move here was to
        // click the exact same reference a third time. Big apps also routinely
        // render the same control twice (a header "Create" and an in-content
        // "Create"), and when one is dead to clicks the twin usually is not.
        hint:
          "The same action failed twice. Do NOT act on that same element reference again — not once more. " +
          "Pick a DIFFERENT control: an identically-labeled one elsewhere on the page counts, and is often " +
          "the fix when a header button ignores clicks. If no alternative exists, take a `screenshot` and " +
          "act on what you can see with click_coord.",
      };
    }
    if (visualUses < MAX_VISUAL_RECOVERIES) {
      visualUses += 1;
      return {
        mode: "visual",
        hint:
          "Semantic targeting keeps failing — a screenshot of the page is attached. " +
          "Find the target in the image. If it is visible there but missing from the " +
          "element list, act on it directly with click_coord (or drag) using 0-1000 " +
          "coordinates read off the image. If the image shows the approach itself is " +
          "wrong, say so and replan.",
      };
    }
    return {
      mode: "replan",
      hint: `Repeated failures on "${decision?.action?.type || "action"}" — the current approach appears invalid. Replan the remaining work.`,
    };
  }

  function retriesFor(decision) {
    return failuresBySignature.get(signatureOf(decision)) || 0;
  }

  function totalCount() {
    return totalRecoveries;
  }

  /**
   * The environment changed underneath us in a way that invalidates the failure
   * history — the user signed in, cleared a wall, or advanced the page by hand.
   * Past failures describe a page that no longer exists, so the agent gets a
   * fresh budget rather than inheriting a spent one.
   */
  function reset() {
    failuresBySignature.clear();
    totalRecoveries = 0;
    visualUses = 0;
  }

  return { nextRecoveryStep, retriesFor, totalCount, signatureOf, reset, noteProgress };
}

module.exports = {
  createRecoveryTracker,
  MAX_SAME_ACTION_RETRIES,
  MAX_TOTAL_RECOVERIES,
  MAX_VISUAL_RECOVERIES,
};
