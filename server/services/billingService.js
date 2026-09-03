// Billing service: plan caches, requireAppAccess, Stripe event sync.
// Caches (`userPlanCache`, `appAccessGrace`) are process singletons. Stripe
// client is constructed in the composition root and bound.
import { PLAN_LIMITS, CREDIT_PACKS, CREDIT_PACKS_FOR_SALE, creditPackById } from '../../src/lib/pricing-config.js';
import { getCreditWallet, markTopupPayer } from '../../lib/billing/creditWallet.js';
import { ensureSignupGrant, fundUsageBalance, getUsageBalance } from '../../lib/billing/usageBalance.js';
import { grantPlanUsageFromInvoice } from '../../lib/billing/planFunding.js';
import { classifyCheckoutPaymentSession, grantUsageFundingFromCheckoutSession, isUsageFundingSession } from '../../lib/billing/usageFunding.js';
import { logBillingEvent } from '../../lib/billing/billingEvents.js';
import { appleSyncInputFrom } from '../../lib/billing/appleNotifications.js';

let stripe = null;
let supabaseAdmin = null;
let STRIPE_PRICE_MAP = {};
let STRIPE_TOPUP_PRICE_MAP = {};
let STRIPE_TRIAL_DAYS = 7;

export function bindBillingService(deps) {
  stripe = deps.stripe;
  supabaseAdmin = deps.supabaseAdmin;
  STRIPE_PRICE_MAP = deps.STRIPE_PRICE_MAP;
  STRIPE_TOPUP_PRICE_MAP = deps.STRIPE_TOPUP_PRICE_MAP;
  STRIPE_TRIAL_DAYS = deps.STRIPE_TRIAL_DAYS;
}

export function availableCreditPacks() {
  if (!CREDIT_PACKS_FOR_SALE) return [];
  return CREDIT_PACKS.filter((pack) => Boolean(STRIPE_TOPUP_PRICE_MAP[pack.id]));
}

// ============================================
// COMPED ACCOUNTS — internal team / friends-of-house
// ============================================
// Emails listed here get free Pro access regardless of their
// `user_billing` row or Stripe state. Both server enforcement
// (`resolveUserPlan`) and the `/api/billing/me` endpoint that powers the
// frontend `useUserPlan` hook short-circuit through here, so these accounts
// look identical to a paying Pro subscriber to the rest of the app.
// Stripe webhooks can't override this — even if the row says `free`, comp
// users still resolve to studio.
//
// Add overrides via `COMPED_PRO_EMAILS` env (comma-separated) without a
// redeploy; the hardcoded list is the source of truth for known team members.
export const COMPED_PRO_PLAN_ID = 'studio';
export const COMPED_PRO_EMAILS = new Set(
  [
    'aj@intertwine.tv',
    'jaeminw8@gmail.com',
    'nyuballer18@gmail.com',
    'easton.redford13@gmail.com',
    'rowan@lykn.io',
    'dlexeffect@gmail.com',
    ...String(process.env.COMPED_PRO_EMAILS || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  ].map((e) => e.toLowerCase()),
);

export function isCompedProEmail(email) {
  if (!email) return false;
  return COMPED_PRO_EMAILS.has(String(email).trim().toLowerCase());
}

// ============================================
// STRIPE BILLING — customer + checkout + portal + webhook handler
// ============================================

// Student (`student`), Pro (`studio`), and Max (`max`) are offered at
// checkout. Legacy price ids for studio_pro / studio_max still map via
// STRIPE_PRICE_MAP for existing subs.
export const PLAN_IDS = new Set(['student', 'studio', 'max']);
export const BILLING_PERIODS = new Set(['monthly', 'annual']);

// Plan-tier write rules live in syncSubscriptionToBilling: while a
// subscription is active/trialing/past_due, the billed Stripe price is the
// plan (both directions, so portal upgrades AND downgrades sync). On
// canceled/unpaid subs the plan is never written down — refunds, chargebacks,
// and expired cards must not phantom-downgrade the tier. The only explicit
// downgrade path is scripts/set-user-plan.mjs.

export function stripeConfigured() {
  return Boolean(stripe && supabaseAdmin);
}

export function appUrlFromReq(req) {
  const explicit = process.env.APP_URL || process.env.FRONTEND_URL || process.env.FRONTEND_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  // Do NOT fall back to a caller-supplied Origin in production: it flows into
  // Stripe `success_url` / portal `return_url`, so a crafted Origin would point
  // the post-checkout redirect at an attacker host (phishing / token capture).
  // Require an explicit APP_URL in prod; only trust Origin in local dev.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_URL (or FRONTEND_URL) must be set in production for Stripe return URLs');
  }
  const origin = req.headers.origin;
  if (origin) return origin.replace(/\/$/, '');
  return 'http://localhost:5173';
}

export function planFromPriceId(priceId) {
  if (!priceId) return null;
  for (const [plan, periods] of Object.entries(STRIPE_PRICE_MAP)) {
    for (const [period, id] of Object.entries(periods)) {
      if (id && id === priceId) return { plan, period };
    }
  }
  return null;
}

// App Store product ids -> plan tier. The Apple analogue of STRIPE_PRICE_MAP.
//
// Hardcoded rather than env-driven on purpose: unlike Stripe price ids these
// are identical in every environment, and they must match the iOS client
// byte-for-byte (StaticPlanPricing.swift in LYKN-iOS documents the same
// table). An env indirection here would only give the two sides a way to
// drift apart silently.
//
// No `studio_pro` / `studio_max` entries: those are legacy Stripe billing
// rows that were never sold through the App Store.
export const APPLE_PRODUCT_MAP = {
  'io.lykn.app.sub.student.month': { plan: 'student', period: 'monthly' },
  'io.lykn.app.sub.student.year': { plan: 'student', period: 'annual' },
  'io.lykn.app.sub.pro.month': { plan: 'studio', period: 'monthly' },
  'io.lykn.app.sub.pro.year': { plan: 'studio', period: 'annual' },
  'io.lykn.app.sub.max.month': { plan: 'max', period: 'monthly' },
  'io.lykn.app.sub.max.year': { plan: 'max', period: 'annual' },
};

export function planFromAppleProductId(productId) {
  if (!productId) return null;
  return APPLE_PRODUCT_MAP[productId] || null;
}

export async function loadBillingRow(userId) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('user_billing')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('❌ loadBillingRow failed:', error.message);
    return null;
  }
  return data || null;
}

// ── User plan / model tier resolver ─────────────────────────────────────────
// Small in-memory TTL cache so every AI request doesn't re-hit user_billing.
// Keyed by userId; cleared when billing changes via webhook (see
// syncSubscriptionToBilling) — if that proves not enough, drop TTL to ~5s.
const USER_PLAN_CACHE_TTL_MS = 5_000;
const userPlanCache = new Map(); // userId → { tier, planId, expiresAt }

export function invalidateUserPlanCache(userId) {
  if (!userId) return;
  userPlanCache.delete(userId);
}

export async function resolveUserPlan(userId, email = null) {
  if (!userId) return { planId: 'free', modelTier: 'basic' };

  // Comped team accounts always resolve to Pro. Bypass the cache *and*
  // the user_billing read so a stray `free` row or canceled Stripe sub can't
  // accidentally lock them out.
  if (isCompedProEmail(email)) {
    const compTier = (PLAN_LIMITS[COMPED_PRO_PLAN_ID] || PLAN_LIMITS.free).modelTier || 'basic';
    return { planId: COMPED_PRO_PLAN_ID, modelTier: compTier };
  }

  const cached = userPlanCache.get(userId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return { planId: cached.planId, modelTier: cached.tier };

  const row = await loadBillingRow(userId);
  const rawPlan = String(row?.plan || 'free').toLowerCase();
  const planConf = PLAN_LIMITS[rawPlan];
  // Monotone-up rule (read side): if the user has ever reached a paid
  // tier, honor it forever. We deliberately do NOT gate on `status`
  // here — a canceled / past_due / unpaid Stripe sub still keeps
  // access. Payment collection is Stripe's job; access control is
  // ours, and product-side we promised "once upgraded, always
  // upgraded." Admin-only manual flips via scripts/set-user-plan.mjs
  // are the single supported downgrade path; those write rawPlan
  // directly to 'free' so they fall through naturally below.
  const effectivePlan = planConf ? rawPlan : 'free';
  const tier = (PLAN_LIMITS[effectivePlan] || PLAN_LIMITS.free).modelTier || 'basic';

  userPlanCache.set(userId, {
    planId: effectivePlan,
    tier,
    expiresAt: now + USER_PLAN_CACHE_TTL_MS,
  });
  return { planId: effectivePlan, modelTier: tier };
}

// Statuses that mean "this subscription is currently granting access". Apple
// notifications are normalised onto the same Stripe vocabulary by
// syncAppleSubscriptionToBilling so every consumer below stays channel-blind.
export const ACCESS_GRANTING_STATUSES = ['trialing', 'active', 'past_due'];

// Which channel currently holds an access-granting subscription, or null.
//
// A user may hold an active subscription on exactly ONE channel — the checkout
// paths refuse to open a second one (see channelConflict) — so this never has
// to arbitrate a tie.
export function activeSubscriptionChannel(row) {
  if (!row) return null;
  const status = String(row.status || '').toLowerCase();
  if (!ACCESS_GRANTING_STATUSES.includes(status)) return null;
  if (row.provider === 'apple' && row.apple_original_transaction_id) return 'apple';
  if (row.stripe_subscription_id) return 'stripe';
  return null;
}

// Cross-channel guard. A user may hold an active subscription on exactly one
// channel (product decision, 2026-08-05): stacking Stripe and Apple would
// double-bill, and the two webhook writers would fight over one `user_billing`
// row with the sticky-plan rule leaving the loser's tier behind.
//
// Returns null when `channel` may proceed, or a { code, message } to refuse
// with. Callers turn that into a 409.
export function channelConflict(row, channel) {
  const active = activeSubscriptionChannel(row);
  if (!active || active === channel) return null;
  if (active === 'apple') {
    return {
      code: 'apple_subscription_active',
      message: 'You already subscribe through the App Store. Manage or cancel that subscription in iOS Settings before subscribing on the web.',
    };
  }
  return {
    code: 'stripe_subscription_active',
    message: 'You already subscribe on lykn.io. Cancel that subscription before subscribing through the App Store.',
  };
}

export function hasSubscriptionAccess(row) {
  return activeSubscriptionChannel(row) !== null;
}

// Authoritative "may this user use the app?" check (revoke-on-period-end).
// Replaces the old "paid once = access forever" rule for real Stripe subs:
//   • Active states (trialing / active / past_due) → access.
//   • Canceled/ended BUT still inside the paid period → access until it lapses
//     (so a "cancel at period end" user keeps what they paid for, then loses it).
//   • Manual / comped grants (a paid plan on file with NO Stripe subscription)
//     stay admin-controlled and keep access — set-user-plan.mjs is the only
//     supported way in/out of those.
// Comped-by-email accounts are handled upstream via isCompedProEmail and never
// reach here for the gate.
export function subscriptionPeriodStillActive(row) {
  if (!row?.current_period_end) return false;
  const end = new Date(row.current_period_end).getTime();
  return Number.isFinite(end) && end > Date.now();
}

// Every account must pass trial checkout (card on file) before using the app:
//   • Active states (trialing / active / past_due) → access.
//   • Canceled/ended BUT still inside the paid period → access until it lapses
//     (so a "cancel at period end" user keeps what they paid for, then loses it).
//   • Manual / comped grants (a paid plan on file with NO Stripe subscription)
//     stay admin-controlled and keep access — set-user-plan.mjs is the only
//     supported way in/out of those.
export function hasAppAccessRow(row) {
  if (!row) return false;
  const status = String(row.status || '').toLowerCase();

  // Apple subscriptions revoke on period end exactly like Stripe ones. This
  // branch must come FIRST: an Apple row has no stripe_subscription_id, so it
  // would otherwise fall into the manual-grant branch below and be treated as
  // a comped account with access forever, surviving cancellation and refund.
  if (row.provider === 'apple' && row.apple_original_transaction_id) {
    if (ACCESS_GRANTING_STATUSES.includes(status)) return true;
    return subscriptionPeriodStillActive(row);
  }

  if (!row.stripe_subscription_id) {
    const plan = String(row.plan || 'free').toLowerCase();
    return plan !== 'free' && Boolean(PLAN_LIMITS[plan]);
  }
  if (ACCESS_GRANTING_STATUSES.includes(status)) return true;
  return subscriptionPeriodStillActive(row);
}

// Server-side gate for metered/generative endpoints so a user without an
// active subscription can't bypass the frontend route gate and burn spend by
// calling the API directly. Returns 402 with needs_trial_checkout so the
// client can route them to /start-trial.
//
// Last-known-good grace: every successful check records a short-lived grant so a
// transient Supabase hiccup doesn't 503 a user we just validated. On an infra
// error we FAIL CLOSED (503) unless that grace is still valid — we never fall
// through to the handler, because the frontend gate is not a security control
// and these routes cost real provider spend.
const APP_ACCESS_GRACE_MS = 10 * 60 * 1000;
const appAccessGrace = new Map(); // userId → expiresAt (last-known-good)

// ── Signup usage grant ───────────────────────────────────────────────────────
// Every account receives $10 of promotional usage exactly once (ledger-level
// idempotency in lib/billing). The old FREE_PLAN_CREDITS soft allowance is
// retired: the free tier runs on the same dollar Usage Balance as everything
// else.

export async function requireAppAccess(req, res, next) {
  const uid = req.user?.id;
  try {
    if (isCompedProEmail(req.user?.email)) return next();
    if (!supabaseAdmin) throw new Error('billing_backend_unavailable');
    // Query inline (not loadBillingRow, which swallows errors and returns null)
    // so a real DB error throws into the catch and is treated as infra failure
    // rather than as "no subscription".
    const { data, error } = await supabaseAdmin
      .from('user_billing')
      .select('*')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw new Error(error.message || 'billing_query_failed');
    if (hasAppAccessRow(data || null)) {
      if (uid) appAccessGrace.set(uid, Date.now() + APP_ACCESS_GRACE_MS);
      // The plan covers included chat; metered actions authorize per action
      // against the Usage Balance, never against legacy credits.
      markTopupPayer(uid, false);
      return next();
    }

    // Free account: make sure the one-time $10 signup grant exists (idempotent,
    // so this is a no-op after the first call), then gate on usable balance.
    await ensureSignupGrant(uid).catch((err) => {
      console.warn('⚠️ ensureSignupGrant failed:', err?.message || err);
    });
    const usage = await getUsageBalance(uid);
    if ((usage?.available || 0) > 0) {
      markTopupPayer(uid, false);
      appAccessGrace.set(uid, Date.now() + APP_ACCESS_GRACE_MS);
      return next();
    }

    // Leftover purchased legacy credits still spend until the credit
    // migration converts them; logAiUsage debits the real cost.
    const wallet = await getCreditWallet(uid);
    if (wallet === null) throw new Error('credit_wallet_unavailable');
    if (wallet.balance > 0) {
      markTopupPayer(uid, true);
      appAccessGrace.set(uid, Date.now() + APP_ACCESS_GRACE_MS);
      return next();
    }

    markTopupPayer(uid, false);
    if (uid) appAccessGrace.delete(uid);
    return res.status(402).json({
      error: "You're out of usage. Top up your balance or upgrade to keep going.",
      code: 'insufficient_usage_balance',
      needs_trial_checkout: false,
      add_funds: true,
      upgrade_available: true,
    });
  } catch (err) {
    console.error('❌ requireAppAccess failed:', err?.message || err);
    const graceUntil = uid ? appAccessGrace.get(uid) || 0 : 0;
    if (graceUntil > Date.now()) return next();
    return res.status(503).json({
      error: 'Could not verify your subscription right now. Please try again.',
      code: 'access_check_unavailable',
    });
  }
}

/** True when we already have a Stripe customer tied to a real subscription history. */
export function hasEstablishedStripeCustomer(row) {
  if (!row?.stripe_customer_id) return false;
  return hasSubscriptionAccess(row) || Boolean(row.stripe_subscription_id);
}

export function billingMePayload(row, extra = {}) {
  const hasActive = hasSubscriptionAccess(row);
  const hasStripeCustomer = hasEstablishedStripeCustomer(row);
  // App access now follows revoke-on-period-end (hasAppAccessRow): a canceled
  // sub keeps access only until current_period_end passes. needs_trial_checkout
  // is the single source of truth the client gate trusts.
  const hasAccess = hasAppAccessRow(row);
  return {
    plan: row?.plan || 'free',
    billing_period: row?.billing_period || null,
    status: row?.status || 'inactive',
    current_period_end: row?.current_period_end || null,
    cancel_at_period_end: Boolean(row?.cancel_at_period_end),
    has_stripe_customer: hasStripeCustomer,
    stripe_subscription_id: row?.stripe_subscription_id || null,
    has_active_subscription: hasActive,
    // Which channel owns the subscription: 'stripe' | 'apple' | null.
    // Clients MUST branch on this to route "manage subscription" — Apple
    // requires IAP subscriptions be managed through the App Store, so sending
    // an Apple subscriber to the Stripe portal is both broken and a review
    // risk. `null` means nothing to manage.
    provider: row?.provider || null,
    needs_trial_checkout: !hasAccess,
    trial_days: STRIPE_TRIAL_DAYS,
    // Must stay LAST: the comped-account path passes needs_trial_checkout /
    // status overrides through `extra` and relies on them winning.
    ...extra,
  };
}

export function resolveAuthUserEmail(user) {
  const direct = String(user?.email || '').trim();
  if (direct) return direct;
  const meta = String(
    user?.user_metadata?.email || user?.raw_user_meta_data?.email || '',
  ).trim();
  if (meta) return meta;
  for (const identity of user?.identities || []) {
    const fromIdentity = String(identity?.identity_data?.email || '').trim();
    if (fromIdentity) return fromIdentity;
  }
  return null;
}

export function resolveAuthUserDisplayName(user) {
  const meta = user?.user_metadata || user?.raw_user_meta_data || {};
  const name = String(meta.full_name || meta.name || '').trim();
  return name || null;
}

export async function resolveAuthUserEmailFromDb(userId) {
  if (!supabaseAdmin || !userId) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    return resolveAuthUserEmail(data.user);
  } catch (err) {
    console.warn('⚠️ resolveAuthUserEmailFromDb failed:', err?.message || err);
    return null;
  }
}

export async function backfillStripeCustomerContact(customerId, { email, name } = {}) {
  if (!stripe || !customerId) return;
  const patch = {};
  if (email) patch.email = email;
  if (name) patch.name = name;
  if (!Object.keys(patch).length) return;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const updates = {};
    if (patch.email && !customer.email) updates.email = patch.email;
    if (patch.name && !customer.name) updates.name = patch.name;
    if (Object.keys(updates).length) {
      await stripe.customers.update(customerId, updates);
    }
  } catch (err) {
    console.warn('⚠️ backfillStripeCustomerContact failed:', err?.message || err);
  }
}

export async function resolveUserEmailForStripe(user) {
  return resolveAuthUserEmail(user) || await resolveAuthUserEmailFromDb(user.id);
}

// ── Student-plan eligibility ────────────────────────────────────────────────
// The ACCOUNT email must be a school address: .edu, .edu.<cc> (unimelb.edu.au),
// or .ac.<cc> (ox.ac.uk). Because the email is the user's login (confirmed
// inbox or Google account), this proves control of the school address without
// a third-party verifier. Mirrors isStudentEmail in src/lib/pricing-config.js
// — the client copy only drives UI gating; THIS check is the enforcement.
//
// STUDENT_EMAIL_DOMAINS (env, comma-separated) allowlists schools on
// non-academic domains, e.g. "students.myschool.org,k12.ca.us". Subdomains of
// an allowlisted domain match too.
const STUDENT_EMAIL_EXTRA_DOMAINS = String(process.env.STUDENT_EMAIL_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function isStudentEmail(email) {
  const addr = String(email || '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 1 || at === addr.length - 1) return false;
  const domain = addr.slice(at + 1);

  for (const allowed of STUDENT_EMAIL_EXTRA_DOMAINS) {
    if (domain === allowed || domain.endsWith('.' + allowed)) return true;
  }

  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return false;
  if (labels[labels.length - 1] === 'edu') return true;
  if (labels.length >= 3) {
    const secondLevel = labels[labels.length - 2];
    if (secondLevel === 'edu' || secondLevel === 'ac') return true;
  }
  return false;
}

const STUDENT_EMAIL_REQUIRED_MESSAGE =
  'The Student plan requires a school account email (like name@university.edu). '
  + 'Sign up with your school email to unlock the student price, or pick another plan. '
  + "If your school uses a different domain, contact support@lykn.io and we'll add it.";

/**
 * 403s student-plan checkouts unless the account email is a school address.
 * Returns true when the response was already sent (caller must bail).
 */
export async function rejectIneligibleStudentCheckout(req, res, planId) {
  if (planId !== 'student') return false;
  const email = await resolveUserEmailForStripe(req.user);
  if (isStudentEmail(email)) return false;
  res.status(403).json({
    error: 'student_email_required',
    message: STUDENT_EMAIL_REQUIRED_MESSAGE,
  });
  return true;
}

/**
 * Checkout identity params. Reuse an existing Stripe customer only after a
 * subscription has actually been created; otherwise pass customer_email so
 * Stripe creates the Customer only when card entry completes.
 */
export async function buildStripeCheckoutIdentity(user, billingRow) {
  const email = await resolveUserEmailForStripe(user);
  const name = resolveAuthUserDisplayName(user);

  if (hasEstablishedStripeCustomer(billingRow)) {
    await backfillStripeCustomerContact(billingRow.stripe_customer_id, { email, name });
    return {
      customer: billingRow.stripe_customer_id,
      customer_update: { email: 'auto', name: 'auto' },
    };
  }

  if (!email) {
    throw new Error('checkout_email_required');
  }

  return { customer_email: email };
}

export async function linkBillingRowFromCheckoutSession(session, subscription) {
  if (!supabaseAdmin) return false;

  const userId = String(
    session.client_reference_id
    || session.metadata?.supabase_user_id
    || subscription?.metadata?.supabase_user_id
    || '',
  ).trim();
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id;
  if (!userId || !customerId) return false;

  const sessionEmail = String(
    session.customer_details?.email || session.customer_email || '',
  ).trim();
  const name = String(session.customer_details?.name || '').trim();

  try {
    await stripe.customers.update(customerId, {
      ...(sessionEmail ? { email: sessionEmail } : {}),
      ...(name ? { name } : {}),
      metadata: { supabase_user_id: userId },
    });
  } catch (err) {
    console.warn('⚠️ linkBillingRowFromCheckoutSession customer update failed:', err?.message || err);
  }

  const existing = await loadBillingRow(userId);
  const { error } = await supabaseAdmin
    .from('user_billing')
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: customerId,
        plan: existing?.plan || 'free',
        status: existing?.status || 'inactive',
      },
      { onConflict: 'user_id' },
    );
  if (error) {
    // Propagate so the webhook 500s and Stripe redelivers — acknowledging a
    // checkout we failed to record strands the subscription.
    throw new Error(`linkBillingRowFromCheckoutSession upsert failed: ${error.message}`);
  }
  return true;
}

// Stripe ≥2025 (this repo runs stripe@^22) removed the top-level
// `current_period_end` / `current_period_start` from the Subscription
// object — they now live on each subscription ITEM. Older API versions
// still send the top-level field. Read item-level first (take the latest
// item's end so a multi-item sub doesn't under-report), fall back to the
// legacy top-level, and return a unix-seconds number or null.
export function subscriptionPeriodEndUnix(subscription) {
  const items = subscription?.items?.data || [];
  let maxItemEnd = 0;
  for (const item of items) {
    const end = Number(item?.current_period_end || 0);
    if (Number.isFinite(end) && end > maxItemEnd) maxItemEnd = end;
  }
  if (maxItemEnd > 0) return maxItemEnd;
  const topLevel = Number(subscription?.current_period_end || 0);
  return Number.isFinite(topLevel) && topLevel > 0 ? topLevel : null;
}

export function subscriptionPeriodEndISO(subscription) {
  const unix = subscriptionPeriodEndUnix(subscription);
  return unix ? new Date(unix * 1000).toISOString() : null;
}

export async function syncSubscriptionToBilling(subscription) {
  if (!supabaseAdmin) return;
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  if (!customerId) return;

  // Pull the existing row(s) for this customer. A Stripe customer normally
  // maps 1:1 to a user_billing row; we read whatever rows match the customer
  // id and write per-row so multi-row edge cases (e.g. account-merge
  // accidents) each get a correct update.
  const { data: existingRows } = await supabaseAdmin
    .from('user_billing')
    .select('user_id, plan')
    .eq('stripe_customer_id', customerId);

  let rowsToWrite = existingRows && existingRows.length > 0
    ? existingRows
    : [];

  if (!rowsToWrite.length) {
    // Checkout writes supabase_user_id onto the SUBSCRIPTION metadata at
    // session-creation time, but only writes it onto the CUSTOMER after
    // checkout.session.completed. customer.subscription.created/updated can
    // arrive first, so check subscription metadata before falling back to a
    // customer lookup — otherwise those early events can't link the user and
    // the activation is dropped.
    let linkedUserId = String(subscription.metadata?.supabase_user_id || '').trim();
    if (!linkedUserId && stripe) {
      try {
        const customer = await stripe.customers.retrieve(customerId);
        linkedUserId = String(customer.metadata?.supabase_user_id || '').trim();
      } catch (err) {
        console.warn('⚠️ syncSubscriptionToBilling customer lookup failed:', err?.message || err);
      }
    }
    if (linkedUserId) {
      const existing = await loadBillingRow(linkedUserId);
      const { error: upsertErr } = await supabaseAdmin
        .from('user_billing')
        .upsert(
          {
            user_id: linkedUserId,
            stripe_customer_id: customerId,
            plan: existing?.plan || 'free',
            status: existing?.status || 'inactive',
          },
          { onConflict: 'user_id' },
        );
      if (upsertErr) {
        throw new Error(`syncSubscriptionToBilling link upsert failed: ${upsertErr.message}`);
      }
      rowsToWrite = [{ user_id: linkedUserId, plan: existing?.plan || 'free' }];
    }
  }

  if (!rowsToWrite.length) {
    // No user_billing row and no metadata linking this subscription to a
    // Supabase user. For an access-granting status, throw so the webhook
    // 500s and Stripe retries — by the next attempt checkout.session.completed
    // has usually landed and linked the customer. Swallowing this silently is
    // how activations get dropped. For ended subs (canceled/expired) there is
    // nothing to revoke on an untracked customer, so just log and move on.
    const grantsAccess = ['active', 'trialing', 'past_due'].includes(subscription.status);
    if (grantsAccess) {
      throw new Error(
        `syncSubscriptionToBilling: no user linked for customer ${customerId} (subscription ${subscription.id})`,
      );
    }
    console.warn(
      `⚠️ syncSubscriptionToBilling: unlinked ${subscription.status} subscription ${subscription.id} for customer ${customerId} — skipping`,
    );
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const match = planFromPriceId(priceId);
  const isActive = ['active', 'trialing', 'past_due'].includes(subscription.status);

  // Status / cycle / period_end / cancel-flag ALWAYS update so the
  // billing UI ("Renews on X", "Past due", "Canceling Y") stays
  // accurate. Only the plan tier is sticky.
  const baseUpdates = {
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    current_period_end: subscriptionPeriodEndISO(subscription),
  };
  // billing_period mirrors the matched price's monthly/annual cycle.
  // Always update when we know it so the cycle display stays right.
  // Intentionally NOT cleared on cancellation — same reason as plan.
  if (match) baseUpdates.billing_period = match.period;

  let lastError = null;
  const touched = [];
  for (const existing of rowsToWrite) {
    if (!existing.user_id) continue;
    const updates = { ...baseUpdates };

    // Plan sync rule: while the subscription is active / trialing / past_due
    // and Stripe billed a price we recognise, the billed price IS the plan —
    // in both directions. This keeps portal plan changes (Max→Pro, Pro↔
    // Student) honest instead of leaving stale elevated entitlements behind.
    //
    // What deliberately does NOT change the plan:
    //   • canceled / unpaid / incomplete_expired subs (no else-branch writing
    //     plan='free') — status alone signals collection problems; refunds,
    //     chargebacks, and expired cards must never phantom-downgrade the
    //     tier. Admin can force-down via scripts/set-user-plan.mjs.
    //   • unrecognised price ids (match === null) — a misrouted or unknown
    //     price keeps the plan on file rather than guessing.
    if (match && isActive) {
      updates.plan = match.plan;
    }

    const writeRes = await supabaseAdmin
      .from('user_billing')
      .update(updates)
      .eq('user_id', existing.user_id)
      .select('user_id');

    if (writeRes.error) {
      lastError = writeRes.error;
      console.error('❌ syncSubscriptionToBilling row update failed:', writeRes.error.message);
      continue;
    }
    for (const r of writeRes.data || []) touched.push(r.user_id);
  }

  for (const userId of touched) invalidateUserPlanCache(userId);

  // Fail loudly if nothing was written: the caller (handleStripeEvent) lets
  // this propagate so the webhook returns 500 and Stripe redelivers. Marking
  // a failed sync as processed is how users end up charged-but-not-activated.
  if (lastError && touched.length === 0) {
    throw new Error(`syncSubscriptionToBilling: all row updates failed: ${lastError.message}`);
  }
}

/**
 * A historical credit-pack checkout completed (packs are retired from sale,
 * but Stripe can still redeliver old sessions). Credits are never granted
 * anymore: the paid amount funds the purchased Usage Balance instead, at the
 * authoritative session amount (catalog price as fallback). Idempotent on the
 * session id, so a retry can never double-fund — and can't double-apply even
 * if the same session was previously granted as wallet credits, because the
 * funding idempotency key is namespaced to usage funding.
 */
// ============================================
// APPLE IN-APP PURCHASE — second billing channel
// ============================================

/**
 * Writes a verified Apple subscription into `user_billing`.
 *
 * Deliberately mirrors syncSubscriptionToBilling's disciplines, because every
 * one of them exists to prevent a real failure mode we have already hit on the
 * Stripe side (see migration 119 — users charged in Stripe but 'free' in the
 * app):
 *
 *   • the plan is STICKY — only written while the subscription is
 *     access-granting and the product is one we recognise. There is no branch
 *     writing plan='free', so a refund or an expiry can never phantom-downgrade
 *     a tier that admin set by hand;
 *   • an unlinkable but access-granting subscription THROWS, so the route
 *     500s and Apple redelivers rather than the activation being dropped;
 *   • status / period end / cancel flag always update so the billing UI stays
 *     honest even when the plan doesn't move.
 *
 * @param {object} apple Verified, decoded notification payload:
 *   {string}  originalTransactionId  stable subscription identity
 *   {string}  productId              maps through APPLE_PRODUCT_MAP
 *   {number}  expiresDateMs          epoch ms, may be null
 *   {string}  appAccountToken        the Supabase user id set at purchase time
 *   {string}  status                 from appleStatusFor()
 *   {boolean} autoRenewOff           true when the user turned off renewal
 *   {string}  environment            'Production' | 'Sandbox'
 */
export async function syncAppleSubscriptionToBilling(apple) {
  if (!supabaseAdmin) return;

  const originalTransactionId = String(apple?.originalTransactionId || '').trim();
  if (!originalTransactionId) return;

  const status = String(apple?.status || '').toLowerCase();
  const isActive = ACCESS_GRANTING_STATUSES.includes(status);
  const match = planFromAppleProductId(apple?.productId);

  // Resolve the user. `apple_original_transaction_id` is the durable link
  // (set on the first notification); `appAccountToken` is the Apple analogue
  // of Stripe's metadata.supabase_user_id and is what bootstraps it. StoreKit
  // requires appAccountToken to be a UUID, which Supabase user ids already are.
  const { data: existingRows } = await supabaseAdmin
    .from('user_billing')
    .select('user_id, plan, provider, status, stripe_subscription_id')
    .eq('apple_original_transaction_id', originalTransactionId);

  let rows = existingRows || [];

  if (!rows.length) {
    const linkedUserId = String(apple?.appAccountToken || '').trim();
    if (linkedUserId) {
      const existing = await loadBillingRow(linkedUserId);
      const { error: upsertErr } = await supabaseAdmin
        .from('user_billing')
        .upsert(
          {
            user_id: linkedUserId,
            plan: existing?.plan || 'free',
            status: existing?.status || 'inactive',
          },
          { onConflict: 'user_id' },
        );
      if (upsertErr) {
        throw new Error(`syncAppleSubscriptionToBilling link upsert failed: ${upsertErr.message}`);
      }
      rows = [{
        user_id: linkedUserId,
        plan: existing?.plan || 'free',
        provider: existing?.provider || null,
        status: existing?.status || 'inactive',
        stripe_subscription_id: existing?.stripe_subscription_id || null,
      }];
    }
  }

  if (!rows.length) {
    // Same rule as the Stripe path: swallowing an access-granting event is how
    // activations get dropped, so throw and let Apple retry.
    if (isActive) {
      throw new Error(
        `syncAppleSubscriptionToBilling: no user linked for originalTransactionId ${originalTransactionId}`,
      );
    }
    console.warn(
      `⚠️ syncAppleSubscriptionToBilling: unlinked ${status} subscription ${originalTransactionId} — skipping`,
    );
    return;
  }

  const baseUpdates = {
    provider: 'apple',
    apple_original_transaction_id: originalTransactionId,
    apple_product_id: apple?.productId || null,
    // Recorded so a sandbox-granted subscription stays identifiable forever.
    // Sandbox purchases cost nothing, so if one ever has to be clawed back
    // this column is the only way to find them without replaying every
    // notification.
    apple_environment: apple?.environment || null,
    status,
    cancel_at_period_end: Boolean(apple?.autoRenewOff),
    current_period_end: apple?.expiresDateMs
      ? new Date(apple.expiresDateMs).toISOString()
      : null,
  };
  if (match) baseUpdates.billing_period = match.period;

  let lastError = null;
  const touched = [];
  for (const existing of rows) {
    if (!existing.user_id) continue;

    // Channel exclusivity is enforced BEFORE purchase (channelConflict on the
    // Stripe side, /api/billing/iap-eligibility on the Apple side), so
    // reaching here with a live Stripe subscription means a genuine race —
    // two purchases in flight at once. Apple has already taken the money, so
    // refusing the write would recreate charged-but-not-activated. Record it
    // and shout, so the double-billed user can be refunded on one channel.
    if (existing.provider === 'stripe'
      && existing.stripe_subscription_id
      && ACCESS_GRANTING_STATUSES.includes(String(existing.status || '').toLowerCase())
      && isActive) {
      console.error(
        `🚨 DUAL-CHANNEL SUBSCRIPTION for user ${existing.user_id}: Apple ${originalTransactionId} `
        + `activated while Stripe ${existing.stripe_subscription_id} is still live. `
        + 'Honouring Apple; one channel needs a manual refund.',
      );
    }

    const updates = { ...baseUpdates };
    if (match && isActive) updates.plan = match.plan;

    const writeRes = await supabaseAdmin
      .from('user_billing')
      .update(updates)
      .eq('user_id', existing.user_id)
      .select('user_id');

    if (writeRes.error) {
      lastError = writeRes.error;
      console.error('❌ syncAppleSubscriptionToBilling row update failed:', writeRes.error.message);
      continue;
    }
    for (const r of writeRes.data || []) touched.push(r.user_id);
  }

  for (const userId of touched) invalidateUserPlanCache(userId);

  if (lastError && touched.length === 0) {
    throw new Error(`syncAppleSubscriptionToBilling: all row updates failed: ${lastError.message}`);
  }
}

// Sandbox notifications are accepted by default because App Review runs its
// purchase test there — refusing them is a rejection under Guideline 3.1.1,
// the exact rejection this whole channel exists to clear. TestFlight builds
// also transact in sandbox, so anyone with a build can grant themselves a
// paid plan for free; that is bounded (TestFlight is invite-only, sandbox
// testers can only be created inside our own App Store Connect account) and
// every grant is logged and stamped with apple_environment. Set
// APPLE_ALLOW_SANDBOX_NOTIFICATIONS=false once the app is live to close it.
export const APPLE_ALLOW_SANDBOX = process.env.APPLE_ALLOW_SANDBOX_NOTIFICATIONS !== 'false';

/**
 * Applies one VERIFIED notification. Callers must not invoke this with
 * anything that has not been through verifyAppleNotification.
 *
 * Idempotency and retry semantics mirror handleStripeEvent exactly:
 * `apple_notifications` is checked first and written LAST, so any throw
 * between the two leaves the notification unrecorded, returns a 500, and
 * Apple redelivers it. Apple retries for up to three days.
 */
export async function handleAppleNotification({ environment, payload, transaction, renewalInfo }) {
  if (!supabaseAdmin) {
    console.warn('⚠️ Apple notification received but supabaseAdmin unavailable — skipping');
    return;
  }

  const uuid = payload?.notificationUUID;
  const type = payload?.notificationType || 'UNKNOWN';
  const subtype = payload?.subtype || null;

  // A notification with no UUID can't be deduplicated, and Apple always sends
  // one. Treat its absence as malformed rather than processing it repeatedly.
  if (!uuid) throw new Error('Apple notification missing notificationUUID');

  const { data: seen } = await supabaseAdmin
    .from('apple_notifications')
    .select('notification_uuid')
    .eq('notification_uuid', uuid)
    .maybeSingle();
  if (seen) return;

  console.log(`🍎 Apple notification: ${type}${subtype ? `/${subtype}` : ''} (${uuid}) [${environment}]`);

  const sync = appleSyncInputFrom({ payload, transaction, renewalInfo });

  if (!sync) {
    // TEST, CONSUMPTION_REQUEST, PRICE_INCREASE and friends: real events that
    // say nothing about entitlement. Recorded below, billing untouched.
    console.log(`   ↳ no entitlement change for ${type}`);
  } else if (environment === 'Sandbox' && !APPLE_ALLOW_SANDBOX) {
    console.warn('   ↳ sandbox notification ignored (APPLE_ALLOW_SANDBOX_NOTIFICATIONS=false)');
  } else {
    if (environment === 'Sandbox') {
      console.warn(
        `   ↳ ⚠️ SANDBOX grant: ${sync.status} ${sync.productId} for appAccountToken `
        + `${sync.appAccountToken || 'none'} — no money changed hands`,
      );
    }
    // Throws on an access-granting subscription it cannot attribute, which is
    // what makes Apple retry instead of the activation being dropped.
    await syncAppleSubscriptionToBilling({ ...sync, environment });
  }

  // Written only after the billing work succeeded — see the retry note above.
  // The payload column keeps the decoded notification for audit; the signed
  // original is not stored because it is unreadable without re-verification
  // and the decoded form is what every question gets asked of.
  const { error: logErr } = await supabaseAdmin
    .from('apple_notifications')
    .insert({
      notification_uuid: uuid,
      notification_type: type,
      subtype,
      environment,
      payload: { ...payload, decodedTransaction: transaction, decodedRenewalInfo: renewalInfo },
    });
  if (logErr && !String(logErr.message).includes('duplicate')) {
    console.error('⚠️ apple_notifications insert failed:', logErr.message);
  }
}

export async function grantTopupFromCheckoutSession(session) {
  const packId = String(session.metadata?.topup_pack || '').trim();
  // Some other one-time payment (Model Builder wallet, etc.) — not ours.
  if (!packId) return;

  const paymentStatus = session.payment_status;
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    console.warn(`⚠️ Top-up session ${session.id} is ${paymentStatus} — nothing granted`);
    return;
  }

  const pack = creditPackById(packId);
  if (!pack) throw new Error(`unknown credit pack "${packId}" on session ${session.id}`);

  const userId = String(
    session.client_reference_id || session.metadata?.supabase_user_id || '',
  ).trim();
  if (!userId) throw new Error(`top-up session ${session.id} carries no user reference`);

  const cents = Number.isInteger(session.amount_total) && session.amount_total > 0
    ? session.amount_total
    : Math.round(pack.priceUsd * 100);

  const result = await fundUsageBalance(userId, {
    amountMicros: cents * 10_000,
    stripeSessionId: session.id,
    idempotencyKey: `funding:${session.id}`,
    metadata: { legacy_pack: pack.id, converted_from: 'credit_pack' },
  });

  logBillingEvent(result?.duplicate ? 'legacy_pack_funding_duplicate' : 'legacy_pack_funded_usage', {
    userId,
    sessionId: session.id,
    packId: pack.id,
    cents,
  });
}

/**
 * Fund monthly plan usage from a paid subscription invoice. Resolves which
 * user(s) the invoice's customer maps to via user_billing (sync runs first,
 * so the row exists by the time this is called) and which plan Stripe billed
 * from the subscription's price. Grant idempotency is on the invoice id.
 */
export async function fundPlanUsageFromInvoice(invoice, subscription) {
  if (!supabaseAdmin) return;
  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id;
  if (!customerId) return;

  const priceId = subscription?.items?.data?.[0]?.price?.id;
  const match = planFromPriceId(priceId);
  if (!match) {
    logBillingEvent('plan_funding_unmatched_price', { invoiceId: invoice.id, priceId });
    return;
  }

  const { data: rows, error } = await supabaseAdmin
    .from('user_billing')
    .select('user_id')
    .eq('stripe_customer_id', customerId);
  if (error) throw new Error(`fundPlanUsageFromInvoice lookup failed: ${error.message}`);
  if (!rows?.length) {
    // Sync links the customer before we get here; if it still isn't linked,
    // throw so the webhook 500s and Stripe redelivers after linking lands.
    throw new Error(`fundPlanUsageFromInvoice: no user linked for customer ${customerId} (invoice ${invoice.id})`);
  }

  for (const row of rows) {
    if (!row.user_id) continue;
    const result = await grantPlanUsageFromInvoice({
      userId: row.user_id,
      invoice,
      planId: match.plan,
    });
    if (result && result.ok === false) {
      throw new Error(`plan usage grant failed for invoice ${invoice.id}: ${result.error || 'unknown'}`);
    }
  }
}

export async function handleStripeEvent(event) {
  if (!supabaseAdmin) {
    console.warn('⚠️ Stripe event received but supabaseAdmin unavailable — skipping');
    return;
  }

  // Idempotency: ignore events we've already processed.
  const { data: seen } = await supabaseAdmin
    .from('stripe_events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle();
  if (seen) return;

  console.log(`💳 Stripe event: ${event.type} (${event.id})`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        // linkBillingRowFromCheckoutSession throws on DB write failure (so
        // Stripe retries) and returns false only when the session carries no
        // user reference at all — in that case syncSubscriptionToBilling
        // still throws if the subscription is access-granting and unlinkable.
        await linkBillingRowFromCheckoutSession(session, subscription);
        await syncSubscriptionToBilling(subscription);
      } else if (session.mode === 'payment') {
        const kind = classifyCheckoutPaymentSession(session);
        if (kind === 'usage_funding' || isUsageFundingSession(session)) {
          await grantUsageFundingFromCheckoutSession(session);
        } else if (kind === 'credit_pack') {
          await grantTopupFromCheckoutSession(session);
        } else {
          logBillingEvent('checkout_payment_unclassified', { sessionId: session.id });
        }
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await syncSubscriptionToBilling(event.data.object);
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      // Re-sync so past_due → active recovery (invoice.paid) and dunning
      // (payment_failed) both reflect in user_billing.status. stripe@22 API
      // versions moved the subscription ref onto invoice.parent.
      const invoice = event.data.object;
      const subId = invoice.subscription
        || invoice.parent?.subscription_details?.subscription
        || null;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(
          typeof subId === 'string' ? subId : subId.id,
        );
        await syncSubscriptionToBilling(sub);
        // A PAID invoice is the one and only source of monthly plan usage:
        // the invoice amount becomes plan-bucket Usage that expires at the
        // end of the paid period. Idempotent on the invoice id.
        if (event.type === 'invoice.paid') {
          await fundPlanUsageFromInvoice(invoice, sub);
        }
      }
      break;
    }
    default:
      // Silently accept other events so Stripe marks them delivered.
      break;
  }

  // Only record the event AFTER the handlers above succeeded — any throw
  // skips this insert, the route returns 500, and Stripe redelivers with the
  // idempotency check still open.
  const { error: logErr } = await supabaseAdmin
    .from('stripe_events')
    .insert({ id: event.id, type: event.type, payload: event });
  if (logErr && !String(logErr.message).includes('duplicate')) {
    console.error('⚠️ stripe_events insert failed:', logErr.message);
  }
}

// ── Billing — extracted to server/routes/billing.routes.js (Wave 6).
// 9 routes (billing/me, checkout, credits, topup, stripe-config,
// trial-checkout, portal, waitlist GET+POST) register here, in their
// original order. The Stripe webhook is NOT part of this module — it
// stays above the JSON parser in bootstrap. All shared billing helpers
// and caches stay in this file (the webhook + requireAppAccess +
