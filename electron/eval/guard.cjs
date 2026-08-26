/**
 * Harness-only safety wrapper around the browser controller.
 *
 * Wraps a controller and returns one with the same API, in which a small set of
 * actions cannot happen. 288 unattended runs against the live web will find
 * every gap in a benchmark's task selection, so this is the layer that assumes
 * selection already failed.
 *
 * STRICTER THAN PRODUCTION, DELIBERATELY
 * --------------------------------------
 * Production decides whether an action is consequential and then asks
 * `goalAuthorizesAction` whether the user's own request already authorised it.
 * This guard **ignores that question entirely** — in eval, nothing authorises a
 * send, ever. That is not belt-and-braces: many Online-Mind2Web goals literally
 * say "add X to cart", for which production's `DELIVERY_INTENT_RE` returns true
 * and the click goes through unattended. Here it does not.
 *
 * BLOCKS ARE FAILED ACTIONS, NOT CRASHES
 * --------------------------------------
 * A blocked call returns `{ok:false, error:"blocked_by_harness:<rule>"}`, the
 * same shape a genuinely failed action returns, so the agent's existing
 * recovery machinery handles it and the run continues. Killing the task instead
 * would turn every guard hit into a lost data point and bias the arm that
 * happened to wander somewhere risky.
 *
 * Every block is recorded. Any task with a block is flagged in the report,
 * because a run that was steered by the guard is not a clean measurement of the
 * agent.
 */

const {
  SPENDS_MONEY_RE,
  DESTROYS_DATA_RE,
} = require("../browser-agent/runtime/executor.cjs");

/**
 * Delivering content to other people. Production judges this on the control's
 * own label with an anchored pattern; we keep the anchor (a stray "share" in a
 * long label should not fire) but drop the authorisation escape hatch.
 *
 * Note what is NOT here: bare "submit". A first version included it and blocked
 * an ordinary search button on a DMV information page during the first live
 * run. Production uses "submit for review" for exactly this reason — "Submit"
 * is the commonest label for a search or filter form, and blocking it costs
 * real task progress in every arm at once while preventing nothing. The
 * qualified forms below still fire, and anything genuinely destructive is
 * already excluded at task selection.
 */
const OUTBOUND_LABEL_RE =
  /^\W*(send|share|publish|post|invite|reply|forward|blast|tweet|submit (?:for review|post|comment|review|application|entry))\b/i;

/**
 * Words a grounding model puts in FRONT of the thing it is describing.
 *
 * This is load-bearing, not tidying. In holo mode the agent never names an
 * element — it describes one — so the string reaching this guard is "the Send
 * message button", not "Send". An anchored pattern cannot match that, which
 * silently left the two holo arms with a weaker safety net than the two refs
 * arms. Caught by an end-to-end run in which refs blocked an outbound click
 * three times and holo blocked it zero times.
 *
 * Stripping the filler and then anchoring keeps the anchor's whole point: a
 * description of a read-only control ("the Show replies link") still does not
 * fire, because after stripping it begins with "Show".
 */
const LEADING_FILLER_RE =
  /^\W*(?:the|a|an|this|that|its|first|second|third|last|top|bottom|left|right|upper|lower|main|primary|small|large|big|blue|green|red|grey|gray|dark|light|orange|purple|yellow|black|white)\s+/i;

/** How a description names the text on a control: 'a button labelled Send'. */
const OUTBOUND_LABELLED_RE =
  /\b(?:labell?ed|labeled|that says|which says|reading|marked|titled)\s+["'‘“]?(send|share|publish|post|invite|reply|forward|submit|tweet)\b/i;

/** Words that say the thing being described IS a control, not page content. */
const CONTROL_NOUN_RE =
  /\b(button|link|icon|control|tab|toggle|chip|menu item|option|checkbox)\b/i;

/**
 * Outbound verbs in forms that are unambiguously verbs.
 *
 * Deliberately excludes the bare plurals — "replies", "posts", "comments",
 * "shares" — which in this benchmark are nearly always nouns ("open the one
 * with the most replies", "view the latest posts"). Their verb senses are
 * already covered by the head-word rule below, so dropping them here buys
 * precision without losing coverage.
 */
const OUTBOUND_VERB_RE =
  /\b(send|sends|sending|share|sharing|publish|publishes|publishing|submit|submits|submitting|invite|inviting|forward|forwarding|post to|reply to|respond to|message the)\b/i;

/** Peel leading articles and adjectives so the anchor sees the real head word. */
function stripLeadingFiller(text) {
  let out = String(text || "");
  // Bounded: "the small blue primary Send button" is four, and an unbounded
  // loop on adversarial input is not worth the risk.
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(LEADING_FILLER_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Outbound test that works on a real element label AND on a grounder's
 * free-text description.
 *
 * Four ways in, ordered cheapest first:
 *   1. The raw string is a control label that begins with an outbound verb.
 *      This is production's test, unchanged, and it is what a refs-mode click
 *      presents.
 *   2. After peeling articles and adjectives the string begins with an
 *      outbound verb AND the description says it is a control. The control
 *      noun is what stops "the post title at the top of the page" — whose head
 *      word after peeling is the noun "post" — from being read as an action.
 *   3. The description quotes the control's text: "a button labelled Send".
 *   4. An unambiguous verb form appears anywhere alongside a control noun,
 *      which catches "the icon that sends the message".
 */
function looksOutbound(text) {
  const raw = String(text || "");
  if (OUTBOUND_LABEL_RE.test(raw)) return true;
  if (OUTBOUND_LABELLED_RE.test(raw)) return true;
  const isControl = CONTROL_NOUN_RE.test(raw);
  if (!isControl) return false;
  if (OUTBOUND_LABEL_RE.test(stripLeadingFiller(raw))) return true;
  return OUTBOUND_VERB_RE.test(raw);
}

/** Hosts that take payment. Navigating to one at all is out of scope. */
const PAYMENT_HOST_RE =
  /(^|\.)(paypal|venmo|stripe|checkout\.stripe|braintreegateway|squareup|klarna|affirm|afterpay|adyen|worldpay|authorize|2checkout|coinbase|cash\.app)\.(com|net|me|app)$/i;

/** Hosts and paths that exist only to authenticate. Mirrors ownedBrowserAct.cjs. */
const AUTH_HOST_RE =
  /^(?:login|log-in|signin|sign-in|accounts?|auth|oauth|sso|identity)\./i;
const AUTH_PATH_RE =
  /^\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|oauth|sso|auth|session\/new)(\/|$)/i;

/**
 * Fields we must never type into / values that are always secrets. Sourced
 * from the shared leaf module so the snapshot builder redacts exactly what the
 * guard refuses to type — one definition, no require cycle.
 */
const { SENSITIVE_FIELD_RE, SENSITIVE_VALUE_RE } = require("../sensitiveFields.cjs");

const DEFAULT_MAX_HOSTS = 25;

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * @param {object} opts
 * @param {object} opts.controller the real controller to wrap
 * @param {number} [opts.maxHosts] distinct-host budget for one task
 * @param {(b: object) => void} [opts.onBlock] called with each recorded block
 */
function createEvalGuard({ controller, maxHosts = DEFAULT_MAX_HOSTS, onBlock = () => {} }) {
  const blocks = [];
  const hosts = new Set();

  const deny = (rule, detail) => {
    const block = { rule, detail: String(detail || "").slice(0, 200), at: Date.now() };
    blocks.push(block);
    try {
      onBlock(block);
    } catch {
      /* a reporting failure must not become an action failure */
    }
    return { ok: false, error: `blocked_by_harness:${rule}`, blocked: true, rule };
  };

  /** Record a host we have observed, and say whether the budget is now blown. */
  const noteHost = (url) => {
    const h = hostOf(url);
    if (h) hosts.add(h);
    return hosts.size > maxHosts;
  };

  /** The label a click will actually hit, whether aimed by ref or by point. */
  const labelForRef = (ref) => {
    try {
      const snap = controller.getCurrentSnapshot?.();
      const el = snap?.byRef?.get?.(ref);
      return String(el?.label || "");
    } catch {
      return "";
    }
  };

  /** Does this element accept a secret? Checks the input type and the label. */
  const fieldIsSensitive = (ref) => {
    try {
      const el = controller.getCurrentSnapshot?.()?.byRef?.get?.(ref);
      if (!el) return "";
      const type = String(el.raw?.type || "").toLowerCase();
      if (type === "password") return "input[type=password]";
      const label = String(el.label || "");
      return SENSITIVE_FIELD_RE.test(label) ? label : "";
    } catch {
      return "";
    }
  };

  const checkClickLabel = (label, how) => {
    const l = String(label || "");
    if (SPENDS_MONEY_RE.test(l)) return deny("spends_money", `${how}: ${l}`);
    if (DESTROYS_DATA_RE.test(l)) return deny("destroys_data", `${how}: ${l}`);
    if (looksOutbound(l)) return deny("outbound", `${how}: ${l}`);
    return null;
  };

  const checkTypedValue = (text, how) => {
    if (SENSITIVE_VALUE_RE.test(String(text || ""))) {
      // Never echo the value into the block record.
      return deny("sensitive_value", `${how}: value matched a card/SSN pattern`);
    }
    return null;
  };

  const wrapped = Object.create(null);
  for (const key of Object.keys(controller)) {
    const fn = controller[key];
    wrapped[key] = typeof fn === "function" ? fn.bind(controller) : fn;
  }

  wrapped.navigate = async (url) => {
    const raw = String(url || "");
    if (!/^https?:\/\//i.test(raw)) {
      // A file:// or data: navigation from a live page is an exfiltration path,
      // and no benchmark task needs one.
      return deny("scheme", raw.slice(0, 80));
    }
    const host = hostOf(raw);
    let pathname = "/";
    try {
      pathname = new URL(raw).pathname;
    } catch {
      /* host check still applies */
    }
    if (PAYMENT_HOST_RE.test(host)) return deny("payment_host", host);
    if (AUTH_HOST_RE.test(host) || AUTH_PATH_RE.test(pathname)) return deny("auth_host", raw.slice(0, 120));
    if (noteHost(raw)) return deny("host_budget", `${hosts.size} distinct hosts > ${maxHosts}`);
    return controller.navigate(raw);
  };

  wrapped.click = async (ref) => {
    const blocked = checkClickLabel(labelForRef(ref), `click ${ref}`);
    return blocked || controller.click(ref);
  };

  wrapped.clickCoord = async (x, y, label = "", opts) => {
    const blocked = checkClickLabel(label, `click_coord ${x},${y}`);
    return blocked || controller.clickCoord(x, y, label, opts);
  };

  wrapped.type = async (ref, text, opts) => {
    const field = fieldIsSensitive(ref);
    if (field) return deny("sensitive_field", `type ${ref}: ${field}`);
    return checkTypedValue(text, `type ${ref}`) || controller.type(ref, text, opts);
  };

  wrapped.typeAtCoord = async (x, y, text, opts) => {
    // Aimed by point, so there is no element to inspect — the label the
    // grounder described and the value itself are all we have.
    const label = String(opts?.label || "");
    if (SENSITIVE_FIELD_RE.test(label)) return deny("sensitive_field", `type_coord: ${label}`);
    return checkTypedValue(text, `type_coord ${x},${y}`) || controller.typeAtCoord(x, y, text, opts);
  };

  wrapped.replaceText = async (ref, findText, replaceWith) => {
    const field = fieldIsSensitive(ref);
    if (field) return deny("sensitive_field", `replace_text ${ref}: ${field}`);
    return checkTypedValue(replaceWith, `replace_text ${ref}`)
      || controller.replaceText(ref, findText, replaceWith);
  };

  // Not a gate — the host budget has to count pages the agent reached by
  // clicking a link, not only ones it navigated to explicitly, and getPageState
  // runs every round.
  wrapped.getPageState = async (...args) => {
    const state = await controller.getPageState(...args);
    try {
      noteHost(state?.url);
    } catch {
      /* observation only */
    }
    return state;
  };

  return {
    controller: wrapped,
    blocks,
    /** Distinct hosts this task has touched. */
    get hosts() {
      return [...hosts];
    },
    summary() {
      const byRule = {};
      for (const b of blocks) byRule[b.rule] = (byRule[b.rule] || 0) + 1;
      return { blocked: blocks.length, byRule, hosts: hosts.size };
    },
  };
}

module.exports = {
  createEvalGuard,
  looksOutbound,
  stripLeadingFiller,
  OUTBOUND_LABEL_RE,
  OUTBOUND_LABELLED_RE,
  CONTROL_NOUN_RE,
  PAYMENT_HOST_RE,
  SENSITIVE_FIELD_RE,
  SENSITIVE_VALUE_RE,
  AUTH_HOST_RE,
  AUTH_PATH_RE,
  DEFAULT_MAX_HOSTS,
};
