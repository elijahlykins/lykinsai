/**
 * Pages that load fine and lead nowhere: 404s, dead links, removed items.
 *
 * This is not a failed action, which is why the retry ladder in recovery.cjs
 * never covered it. The navigation succeeded, the URL changed, and the verifier
 * scores a changed URL as progress — so nothing objects. The agent then hunts
 * for controls on a page that has none, spends its whole recovery budget doing
 * it, and hands the dead link back to the user with "take it forward one step".
 *
 * A dead end is a routing problem, so the answer is a different address rather
 * than another click: back out to a URL that does exist and find the route from
 * there.
 */

/** How many times one task may route around a dead end before replanning. */
const MAX_DEAD_END_RECOVERIES = 3;

/** Unambiguous in a page title, where sites put the status of the page. */
const DEAD_TITLE =
  /\bpage not found\b|\bnot found\b|\bpage (?:does ?not|doesn'?t) exist\b|\bpage (?:unavailable|missing|removed)\b|\bno longer (?:available|exists)\b|\bforbidden\b|\baccess denied\b/i;

/** A bare status code, only trusted when the title is little else. */
const STATUS_CODE = /(?:^|[^\d.])(404|410|500|502|503)(?:[^\d.]|$)/;

/**
 * Said in the body copy of a dead page, near the top.
 *
 * Built from parts because real 404 copy is written by marketing, not by a spec:
 * Mailchimp's says "We lost this page … we couldn't find what you're looking
 * for" and never uses the words "not found" anywhere a reader can see. Every
 * apostrophe is optional and may be curly — that is how these pages are typeset.
 */
const APOS = "['\u2019]?";
const DEAD_TEXT = new RegExp(
  [
    "\\bpage not found\\b",
    "\\berror 404\\b",
    "\\bhttp 404\\b",
    "\\b404 error\\b",
    "\\bthe page you (?:requested|were looking for|are looking for)\\b",
    `\\bpage (?:does ?not|does${APOS}nt) exist\\b`,
    `\\bwe (?:can${APOS}t|could ?n${APOS}t|cannot) find (?:that|this|the) page\\b`,
    `\\bcould ?n${APOS}t find what you${APOS}re looking for\\b`,
    "\\bwe lost this page\\b",
    `\\blet${APOS}s find a better place\\b`,
    "\\brequested url\\b[^\\n]{0,80}\\bwas not found\\b",
    `\\bthis page (?:is not|is${APOS}nt) available\\b`,
    "\\bpage has been (?:removed|deleted|moved)\\b",
  ].join("|"),
  "i",
);

/**
 * A search that matched nothing is a working page and often the correct one —
 * the agent should read it, not flee it.
 */
const EMPTY_RESULTS =
  /\bno (?:results|matches|items|posts|products)\b|\b0 results\b|\bnothing (?:matched|found for)\b|\btry (?:a )?different (?:search|keywords?|spelling)\b/i;

function normalizeUrl(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

/**
 * @returns {{deadEnd: boolean, reason: string}} `reason` is written to be shown
 *   to the user and fed back to the model, so it quotes the page.
 */
function looksLikeDeadEnd({ title = "", visibleText = "" } = {}) {
  const t = String(title || "").trim();
  if (DEAD_TITLE.test(t)) {
    return { deadEnd: true, reason: `the page is titled "${t.slice(0, 60)}"` };
  }
  if (STATUS_CODE.test(t) && t.length <= 40) {
    return { deadEnd: true, reason: `the page is titled "${t.slice(0, 60)}"` };
  }
  // Only the top of the page: an article that discusses 404s mentions them in
  // its body, a 404 announces itself immediately.
  const head = String(visibleText || "").slice(0, 800);
  if (EMPTY_RESULTS.test(head) && !DEAD_TEXT.test(head)) {
    return { deadEnd: false, reason: "" };
  }
  const hit = DEAD_TEXT.exec(head);
  if (hit) {
    return { deadEnd: true, reason: `the page says "${String(hit[0]).slice(0, 60)}"` };
  }
  return { deadEnd: false, reason: "" };
}

/**
 * The next address worth trying after a dead end, cheapest wrong thing first:
 * drop the query, then walk up the path, then the site root. URLs already known
 * to be dead are skipped so a run cannot ping-pong between two of them.
 *
 * Deliberately structural: it only ever walks the address it was given. Landing
 * somewhere useful from here is the job of the page that loads — its own nav,
 * search and sign-in links — not of a table of known products, which would be a
 * hardcoded route into one application that rots the moment that app moves.
 *
 * @returns {{url: string, what: string}|null} null when everything up the tree
 *   has already been tried — the caller should replan instead of navigating.
 */
function backoutTarget(url, { avoid = [] } = {}) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return null;
  }
  const skip = new Set([normalizeUrl(url), ...(avoid || []).map(normalizeUrl)]);
  const candidates = [];
  if (u.search || u.hash) {
    candidates.push({ url: `${u.origin}${u.pathname}`, what: "the same page without its query string" });
  }
  const parts = u.pathname.split("/").filter(Boolean);
  for (let i = parts.length - 1; i > 0; i -= 1) {
    candidates.push({
      url: `${u.origin}/${parts.slice(0, i).join("/")}/`,
      what: `the section above it (/${parts.slice(0, i).join("/")}/)`,
    });
  }
  candidates.push({ url: `${u.origin}/`, what: `the site's front page (${u.host})` });

  for (const c of candidates) {
    if (!skip.has(normalizeUrl(c.url))) return c;
  }
  return null;
}

module.exports = {
  looksLikeDeadEnd,
  backoutTarget,
  normalizeUrl,
  MAX_DEAD_END_RECOVERIES,
};
