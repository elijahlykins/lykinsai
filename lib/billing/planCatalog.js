/**
 * Canonical LYKN plan catalog.
 *
 * One authority for: plan ids, prices, included-chat entitlement, the
 * pricing profile a plan's monthly usage carries, and which Stripe env
 * vars hold each plan's Price ids.
 *
 * Display copy lives in src/lib/pricing-config.js and must agree with the
 * amounts here (billingTransition.test.mjs enforces that).
 *
 * Do not hardcode plan prices, profiles, or Stripe env names anywhere else.
 */

import { MICROS_PER_USD } from './money.js';

/** One-time promotional usage granted to a new account. $10. */
export const SIGNUP_GRANT_MICROS = 10 * MICROS_PER_USD;
export const SIGNUP_GRANT_TXN = 'promotional_grant';

export function signupGrantIdempotencyKey(userId) {
  return `signup-grant:${userId}`;
}

/**
 * planId → catalog entry.
 *
 * `includedChat`: normal LYKN chat does not consume Usage.
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
    includedChat: false,
    pricingProfile: null,
    stripeEnv: null,
  }),
  student: Object.freeze({
    id: 'student',
    label: 'Student',
    monthlyCents: 1500,
    annualCents: 14400,
    includedChat: true,
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
    includedChat: true,
    pricingProfile: 'pro_monthly',
    stripeEnv: Object.freeze({
      monthly: 'STRIPE_PRICE_STUDIO_MONTHLY',
      annual: 'STRIPE_PRICE_STUDIO_ANNUAL',
    }),
  }),
  max: Object.freeze({
    id: 'max',
    label: 'Max',
    monthlyCents: 10000,
    annualCents: 90000,
    includedChat: true,
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

/** Does normal (non-autonomous, non-premium) LYKN chat cost the user $0? */
export function planIncludesChat(planId) {
  return getPlan(planId).includedChat;
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
