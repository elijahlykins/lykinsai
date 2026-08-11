/**
 * Recovery system — explicit, tracked behavior when an action fails or
 * verification shows no progress. Retries are counted per action signature
 * in structured state (never by asking the model to remember); after 2
 * retries of essentially the same operation the strategy escalates.
 */

const MAX_SAME_ACTION_RETRIES = 2;
const MAX_TOTAL_RECOVERIES = 6;

function createRecoveryTracker() {
  const failuresBySignature = new Map();
  let totalRecoveries = 0;
  let usedVisual = false;

  function signatureOf(decision) {
    const a = decision?.action || {};
    const el = a.target || "";
    return [a.type || "", el, String(a.url || "").slice(0, 80), String(a.text || "").slice(0, 40)]
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

    if (count === 1) {
      return {
        mode: "retry_fresh",
        hint: staleRef
          ? "The element reference went stale. Re-observe the page and act on the equivalent element in the fresh snapshot."
          : `The action did not produce the expected result (${verification?.reason || "no progress"}). Re-observe and retry — the target may have moved, or the page may have changed unexpectedly.`,
      };
    }
    if (count === 2) {
      return {
        mode: "find_equivalent",
        hint: "The same action failed twice. Do NOT repeat it. Look for a different element or route that accomplishes the same step (same role/purpose, different target).",
      };
    }
    if (!usedVisual) {
      usedVisual = true;
      return {
        mode: "visual",
        hint: "Semantic targeting keeps failing — a screenshot of the page is attached. Use visual understanding to find the right target or realize the approach is wrong.",
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

  return { nextRecoveryStep, retriesFor, totalCount, signatureOf };
}

module.exports = { createRecoveryTracker, MAX_SAME_ACTION_RETRIES, MAX_TOTAL_RECOVERIES };
