// ============================================================================
// lib/eval/mind2webManifest.js — screening and selection for the
//                                Online-Mind2Web login-free subset
// ============================================================================
// Pure logic only: no filesystem, no network, no argv. scripts/eval/
// mind2web-build-manifest.mjs supplies the I/O and this module decides what
// gets in. Split that way so the decisions are unit-testable, because they are
// the part that determines what the eval actually measures.
// ============================================================================

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The SHIPPING risk patterns, imported rather than restated, so the eval subset
// and the gate that protects production cannot drift apart.
const {
  goalCommitsMoney,
  DESTROYS_DATA_RE,
  DELIVERY_INTENT_RE,
} = require('../../electron/browser-agent/runtime/executor.cjs');

// ---------------------------------------------------------------------------
// Copied from electron/ownedBrowserAct.cjs (~:3547). Copied, not imported: that
// module pulls in Electron and is 11k lines, which has no business being loaded
// by a build script. mind2webManifest.test.mjs re-reads the production file and
// asserts these two literals still match it, so the copy cannot rot silently.
// ---------------------------------------------------------------------------
export const AUTH_HOST_RE = /^(?:login|log-in|signin|sign-in|accounts?|auth|oauth|sso|identity)\./i;
export const AUTH_PATH_RE = /^\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|oauth|sso|auth|session\/new)(\/|$)/i;

/**
 * Sites that cannot be exercised signed-out, or whose terms make automated
 * traffic a bad idea regardless of what the task asks for. Matched against the
 * registrable domain, so `mail.google.com` and `google.com` are separated by
 * the entries below rather than by substring luck.
 */
export const BLOCKED_DOMAINS = new Set([
  // Personal inboxes and messaging.
  'gmail.com', 'mail.com', 'outlook.com', 'proton.me', 'protonmail.com',
  // Social networks: signed-out access is degraded or blocked, and anything
  // the agent does there is outbound by construction.
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'reddit.com', 'tiktok.com', 'threads.net', 'pinterest.com', 'snapchat.com',
  // Money movement.
  'paypal.com', 'venmo.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'coinbase.com', 'robinhood.com', 'stripe.com', 'cash.app',
  // Identity providers.
  'okta.com', 'auth0.com', 'onelogin.com',
]);

/**
 * Verbs that, when the task actually COMMANDS them, commit to a transaction, a
 * submission, or an account.
 *
 * Matched only in commanding position (see commandVerbs). Matching them
 * anywhere in the goal is what a first pass does, and it is wrong: half of
 * these words are ordinary nouns in this dataset. "apartment listing for rent",
 * "the most recent job posting", "view the latest posts", and "open one with
 * the most replies" are read-only tasks that a substring match rejects.
 */
export const COMMAND_VERB_DENY = new Set([
  'checkout', 'buy', 'purchase', 'order', 'book', 'reserve', 'rent', 'lease',
  'subscribe', 'signup', 'register', 'login', 'apply', 'enroll', 'join',
  'upload', 'submit', 'post', 'publish', 'send', 'share', 'message', 'email',
  'invite', 'comment', 'rate', 'vote', 'bid', 'donate', 'pay',
  'delete', 'remove', 'cancel', 'unsubscribe', 'deactivate',
]);

/** Signing up for something, phrased as a noun rather than a verb. */
export const SIGNUP_NOUN_RE =
  /\b(newsletter subscription|(?:a|an|the) subscription\b|create (?:an? )?(?:account|profile|login)|free trial|membership sign)/i;

/**
 * Goals that only make sense against a signed-in account.
 *
 * Deliberately keeps the PLURAL account-page names ("My Trips", "My Orders" —
 * the literal labels airlines and retailers use) and not their singulars, so
 * "what identification do I need to bring on my trip" stays in.
 */
export const ACCOUNT_SCOPED_RE =
  /\b(my (?:account|orders|profile|bookings|reservations|subscriptions|watchlist|wishlist|trips)\b|order (?:number|#|\d{4,})|track (?:my|an?) (?:order|package|shipment)|order status)\b/i;

/**
 * Somebody's actual contact details sitting in the task text.
 *
 * These tasks want the agent to type a real email or phone number into a live
 * form — a newsletter signup, a gift-card recipient, an order lookup. Out of
 * scope for an unattended run whatever the verb says.
 */
export const CONTACT_DETAILS_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/;

// Multi-part public suffixes we actually encounter. Not the full PSL — this is
// only used to group tasks by site for the per-domain cap, where being slightly
// coarse costs nothing and a dependency would cost a lot.
const MULTI_TLD = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.nz', 'co.za', 'co.in',
  'com.au', 'com.br', 'com.mx', 'com.cn', 'com.tr', 'com.sg', 'com.hk',
]);

export function parseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  // Anything that DECLARES a scheme must declare http(s), and that is checked
  // before any normalisation. Prepending "https://" first would rewrite
  // "file:///etc/passwd" into "https://file///etc/passwd" — a URL we would then
  // happily accept, turning a rejected input into a navigable one. A start URL
  // is a live-web navigation target, so this is the difference between refusing
  // a local-file read and performing one.
  //
  // The host:port guard keeps a scheme-less "example.com:8080" from being read
  // as a scheme named "example.com".
  const declared = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  const looksLikeHostPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(trimmed);
  if (declared && !looksLikeHostPort && !/^https?$/i.test(declared[1])) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/** eTLD+1, best-effort. Returns '' when the URL will not parse. */
export function registrableDomain(raw) {
  const u = parseUrl(raw);
  if (!u) return '';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_TLD.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/**
 * The verbs a task actually commands, as opposed to words that appear in it.
 *
 * Splits the goal on clause boundaries and coordinators, then takes the leading
 * word of each fragment. An imperative English instruction puts its verb first
 * in the clause, so "Find X and message the owner" yields [find, message] while
 * "view the latest posts" yields [view] — the noun "posts" never reaches the
 * denylist.
 */
export function commandVerbs(goal) {
  const out = new Set();
  const clauses = String(goal ?? '').split(/[,.;:?!]+|\band then\b|\bthen\b|\band\b|\bto\b|\balso\b/i);
  for (const clause of clauses) {
    const word = clause.trim().split(/\s+/)[0];
    if (!word) continue;
    const norm = word.toLowerCase().replace(/[^a-z]/g, '');
    if (norm) out.add(norm);
  }
  return out;
}

/** Stable, seedless ordering. Same inputs, same subset, forever. */
export function selectionKey(taskId) {
  return createHash('sha256').update(String(taskId)).digest('hex');
}

// ---------------------------------------------------------------------------
// Rules. Order matters: the FIRST rule that fires is the recorded reason, so
// the most specific and most safety-relevant checks come first. Bump a rule's
// version when its behaviour changes — the manifest diff then explains itself.
//
// DELIVERY_INTENT_RE is deliberately NOT a rule. In production it answers "did
// the user ask for something to be delivered?", so being broad makes it
// PERMISSIVE. Used as an exclusion its polarity inverts and the same breadth
// over-blocks: it rejects "open the discussion with the most replies" and "view
// the latest posts" on nouns. It is recorded as an advisory on each surviving
// task instead, for the human reviewer to weigh. Actually performing a delivery
// is blocked at action time by the harness guard, which is where enforcement
// belongs.
// ---------------------------------------------------------------------------
export const RULES = [
  {
    id: 'no_goal',
    version: 1,
    why: 'Task has no instruction text. Always a join or sourcing fault rather than '
       + 'a property of the benchmark, and an empty goal silently passes every '
       + 'other rule, so it is checked first and loudly.',
    test: (t) => !String(t.goal ?? '').trim(),
  },
  {
    id: 'goal_contains_contact_details',
    version: 1,
    why: "Goal embeds a real email address or phone number, so completing it means "
       + "typing somebody's contact details into a live form.",
    test: (t) => CONTACT_DETAILS_RE.test(t.goal),
  },
  {
    id: 'goal_spends_money',
    version: 2,
    why: 'Goal commits real money. Screened with the shipping goalCommitsMoney(), '
      + 'which reads a request in prose — the label patterns the safety gate uses on '
      + 'buttons treat a price as a commitment tell, which is right on "Pay $49.00" '
      + 'and wrong on "find pajamas under $40".',
    test: (t) => goalCommitsMoney(t.goal),
  },
  {
    id: 'goal_destroys_data',
    version: 2,
    why: 'Goal deletes or cancels something. Screened with the shipping DESTROYS_DATA_RE.',
    test: (t) => DESTROYS_DATA_RE.test(t.goal),
  },
  {
    id: 'goal_command_verb',
    version: 2,
    why: 'The verb the task commands commits to a transaction, a submission, or an '
       + 'account. Checked in commanding position only, so noun uses of the same '
       + 'words do not fire.',
    test: (t) => [...commandVerbs(t.goal)].some((v) => COMMAND_VERB_DENY.has(v)),
  },
  {
    id: 'goal_creates_account',
    version: 1,
    why: 'Goal signs up for a subscription, trial, or account, phrased as a noun.',
    test: (t) => SIGNUP_NOUN_RE.test(t.goal),
  },
  {
    id: 'goal_account_scoped',
    version: 2,
    why: 'Goal targets a signed-in account page, which a login-free run cannot reach.',
    test: (t) => ACCOUNT_SCOPED_RE.test(t.goal),
  },
  {
    id: 'no_start_url',
    version: 1,
    why: 'No start URL. The benchmark records it in the HuggingFace dataset only, '
       + 'and the task text names the site too rarely to infer one honestly.',
    test: (t) => !t.startUrl,
  },
  {
    id: 'bad_start_url',
    version: 1,
    why: 'Start URL is not parseable http(s).',
    test: (t) => !!t.startUrl && !registrableDomain(t.startUrl),
  },
  {
    id: 'auth_start_url',
    version: 1,
    why: 'Start URL is an authentication host or path (AUTH_HOST_RE / AUTH_PATH_RE).',
    test: (t) => {
      const u = parseUrl(t.startUrl);
      return !!u && (AUTH_HOST_RE.test(u.hostname) || AUTH_PATH_RE.test(u.pathname));
    },
  },
  {
    id: 'blocked_domain',
    version: 1,
    why: 'Domain requires an account signed in, or is a money-movement or social host.',
    test: (t) => BLOCKED_DOMAINS.has(registrableDomain(t.startUrl)),
  },
];

export const ADVISORIES = [
  {
    id: 'delivery_intent',
    why: 'Production DELIVERY_INTENT_RE matched the goal. Advisory only — it is '
       + 'broad by design because in production it permits rather than blocks. '
       + 'Read the goal before promoting.',
  },
];

/** Rules the CLI adds after screening, documented here so the manifest is self-describing. */
export function lateRules({ perDomainCap, target }) {
  return [
    { id: 'unreachable', version: 1, why: 'Start URL returned 4xx/5xx, timed out, or redirected to an auth page.' },
    { id: 'domain_cap', version: 1, why: `More than ${perDomainCap} tasks already selected on this domain.` },
    { id: 'over_target', version: 1, why: `Eligible, but the target of ${target} was already filled.` },
  ];
}

/**
 * Run every task past the rules.
 *
 * @returns {{eligible: object[], excluded: object[]}} — eligible tasks carry an
 *   `advisories` array; excluded ones carry the rule that stopped them.
 */
export function screen(tasks) {
  const eligible = [];
  const excluded = [];
  for (const t of tasks) {
    const hit = RULES.find((r) => r.test(t));
    if (hit) {
      excluded.push({
        taskId: t.taskId, goal: t.goal, startUrl: t.startUrl ?? null,
        rule: hit.id, ruleVersion: hit.version,
      });
      continue;
    }
    eligible.push({
      ...t,
      advisories: DELIVERY_INTENT_RE.test(t.goal) ? ['delivery_intent'] : [],
    });
  }
  return { eligible, excluded };
}

/**
 * Largest-remainder apportionment: split `target` across strata in proportion
 * to their sizes, with the quotas summing to exactly `target`.
 *
 * Plain rounding does not sum correctly (three strata at 24.0 round to 72 only
 * by accident), and the leftover has to land somewhere defensible. Remainders
 * break ties by stratum key so the result does not depend on Map order.
 */
export function apportion(sizes, target) {
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const quotas = new Map();
  if (!total) return quotas;

  const remainders = [];
  let assigned = 0;
  for (const [key, n] of sizes) {
    const exact = (target * n) / total;
    const floor = Math.min(Math.floor(exact), n);
    quotas.set(key, floor);
    assigned += floor;
    remainders.push([key, exact - floor]);
  }
  remainders.sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])));

  let i = 0;
  while (assigned < target && remainders.length) {
    const [key] = remainders[i % remainders.length];
    if (quotas.get(key) < sizes.get(key)) {
      quotas.set(key, quotas.get(key) + 1);
      assigned += 1;
    } else if (remainders.every(([k]) => quotas.get(k) >= sizes.get(k))) {
      break; // every stratum exhausted
    }
    i += 1;
  }
  return quotas;
}

/**
 * Pick the subset, deterministically.
 *
 * Sorts by sha256(task_id) so the same inputs always produce the same subset,
 * byte for byte — there is no seed to lose, and a re-run after a rule change
 * yields a reviewable diff rather than a fresh random sample. Tasks dropped by
 * the domain cap or the target are recorded as exclusions like any other, so
 * the manifest accounts for every task it was given.
 *
 * `stratifyBy` names a field (in practice the benchmark's own `level`) whose
 * distribution the subset should mirror. Without it, hash order alone decides
 * the difficulty mix: a subset that drifts easy or hard moves the headline
 * success rate for every arm at once, which reads as a real effect and is not
 * one. Quotas are filled first, then any shortfall — a stratum starved by the
 * domain cap — is topped up from what remains, so `target` is still met.
 */
export function select(eligible, { target, perDomainCap, stratifyBy = null }) {
  const ordered = [...eligible].sort(
    (a, b) => selectionKey(a.taskId).localeCompare(selectionKey(b.taskId)),
  );

  const perDomain = new Map();
  const taken = new Set();
  const selected = [];

  const domainOf = (t) => registrableDomain(t.startUrl) || '(unknown)';

  /** Take the task unless its domain is full or the target is met. */
  const tryTake = (t) => {
    if (taken.has(t.taskId) || selected.length >= target) return false;
    const domain = domainOf(t);
    if ((perDomain.get(domain) ?? 0) >= perDomainCap) return false;
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    taken.add(t.taskId);
    selected.push({ ...t, domain });
    return true;
  };

  if (stratifyBy) {
    const groups = new Map();
    for (const t of ordered) {
      const key = String(t[stratifyBy] ?? '(none)');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const quotas = apportion(
      new Map([...groups].map(([k, v]) => [k, v.length])),
      target,
    );
    for (const key of [...groups.keys()].sort()) {
      let need = quotas.get(key) ?? 0;
      for (const t of groups.get(key)) {
        if (need <= 0) break;
        if (tryTake(t)) need -= 1;
      }
    }
  }

  // Unstratified selection, and the top-up for any stratum the domain cap
  // starved. Global hash order, so the fill is deterministic too.
  for (const t of ordered) {
    if (selected.length >= target) break;
    tryTake(t);
  }

  const excluded = [];
  for (const t of ordered) {
    if (taken.has(t.taskId)) continue;
    const domain = domainOf(t);
    const domainFull = (perDomain.get(domain) ?? 0) >= perDomainCap;
    excluded.push({
      taskId: t.taskId, goal: t.goal, startUrl: t.startUrl ?? null,
      ...(domainFull
        ? { rule: 'domain_cap', ruleVersion: 1, detail: `>${perDomainCap} on ${domain}` }
        : { rule: 'over_target', ruleVersion: 1, detail: `target ${target} already filled` }),
    });
  }

  selected.sort((a, b) => selectionKey(a.taskId).localeCompare(selectionKey(b.taskId)));
  return { selected, excluded, domains: perDomain };
}
