/**
 * Canonical LYKN plan catalog.
 *
 * One authority for: plan ids, prices, the pricing profile a plan's
 * monthly usage carries, and which Stripe env vars hold each plan's
 * Price ids.
 *
 * Display copy lives in src/lib/pricing-config.js and must agree with the
 * amounts here (billingTransition.test.mjs enforces that).
 *
 * Do not hardcode plan prices, profiles, or Stripe env names anywhere else.
 */

import { MICROS_PER_USD } from './money.js';

/** One-time promotional usage granted to a new account. $20. */
export const SIGNUP_GRANT_USD = 20;
export const SIGNUP_GRANT_MICROS = SIGNUP_GRANT_USD * MICROS_PER_USD;
export const SIGNUP_GRANT_TXN = 'promotional_grant';

export function signupGrantIdempotencyKey(userId) {
  return `signup-grant:${userId}`;
}

/**
 * planId → catalog entry.
 *
 * Every metered action — normal chat included — draws from the Usage
 * Balance at the flat rate in lib/billing/pricingProfiles.js. A paid plan
 * turns each subscription invoice into that month's plan usage; there is
 * no separately "included" chat anymore.
 *
 * `pricingProfile`: profile attached to this plan's monthly usage lots.
 * Legacy ids (`studio_pro`, `studio_max`) resolve to Pro semantics — they
 * only exist on grandfathered user_billing rows.
 */
export const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({
    id: 'free',
    label: 'Free',
    monthlyCents: 0,
    annualCents: 0,
    pricingProfile: null,
    stripeEnv: null,
  }),
  student: Object.freeze({
    id: 'student',
    label: 'Student',
    monthlyCents: 1500,
    annualCents: 14400,
    pricingProfile: 'student_monthly',
    stripeEnv: Object.freeze({
      monthly: 'STRIPE_PRICE_STUDENT_MONTHLY',
      annual: 'STRIPE_PRICE_STUDENT_ANNUAL',
    }),
  }),
  studio: Object.freeze({
    id: 'studio',
    label: 'Pro',
    monthlyCents: 2000,
    annualCents: 20400,
    pricingProfile: 'pro_monthly',
    stripeEnv: Object.freeze({
      monthly: 'STRIPE_PRICE_STUDIO_MONTHLY',
      annual: 'STRIPE_PRICE_STUDIO_ANNUAL',
    }),
  }),
  // Unlisted in marketing/pickers (`listed: false` in pricing-config.js) until
  // we turn the Pro+ SKU back on. Keep prices and Stripe env names here.
  pro_plus: Object.freeze({
    id: 'pro_plus',
    label: 'Pro+',
    monthlyCents: 6000,
    // $51/mo billed annually = $612/yr (same 15% annual discount as Pro).
    annualCents: 61200,
    pricingProfile: 'pro_plus_monthly',
    stripeEnv: Object.freeze({
      monthly: 'STRIPE_PRICE_PRO_PLUS_MONTHLY',
      annual: 'STRIPE_PRICE_PRO_PLUS_ANNUAL',
    }),
  }),
  max: Object.freeze({
    id: 'max',
    label: 'Max',
    monthlyCents: 10000,
    annualCents: 90000,
    pricingProfile: 'max_monthly',
    stripeEnv: Object.freeze({
      monthly: 'STRIPE_PRICE_MAX_MONTHLY',
      annual: 'STRIPE_PRICE_MAX_ANNUAL',
    }),
  }),
});

const LEGACY_PLAN_ALIASES = Object.freeze({
  studio_pro: 'studio',
  studio_max: 'studio',
});

export function resolvePlanId(planId) {
  const raw = String(planId || 'free').toLowerCase();
  if (PLAN_CATALOG[raw]) return raw;
  if (LEGACY_PLAN_ALIASES[raw]) return LEGACY_PLAN_ALIASES[raw];
  return 'free';
}

export function getPlan(planId) {
  return PLAN_CATALOG[resolvePlanId(planId)];
}

/** Pricing profile carried by this plan's monthly usage lots. */
export function planPricingProfile(planId) {
  return getPlan(planId).pricingProfile;
}

export function isPaidPlan(planId) {
  return resolvePlanId(planId) !== 'free';
}

export function planGrantIdempotencyKey(invoiceId) {
  return `plan-grant:${invoiceId}`;
}
