/**
 * Central LYKN usage pricing.
 *
 * Everything metered resolves to RAW PROVIDER COST in micros. The customer
 * charge is derived at spend time by the pricing profile of whichever
 * funding bucket pays (lib/billing/pricingProfiles.js) — plan usage has a
 * better internal rate than top-up usage.
 *
 * Provider cost and customer charge stay separate everywhere. A ledger row
 * records `pricing_version` so later changes never rewrite what a customer
 * was charged.
 */

import {
  MICROS_PER_USD,
  formatUsd,
  roundCustomerChargeMicros,
  roundProviderCostMicros,
} from './money.js';
import { chargeForRawMicros } from './pricingProfiles.js';

export const USAGE_PRICING_VERSION = 'usage-v2';

export const USAGE_FUNDING = Object.freeze({
  currency: 'usd',
  presetsCents: Object.freeze([500, 1000, 2000, 5000]),
  minCents: 500,
  maxCents: 50_000,
});

/**
 * Canonical raw-cost assumptions (micros) for fixed-price actions where the
 * provider does not report a per-request cost. These are RAW costs, not
 * customer prices — the customer charge is raw × the paying bucket's profile.
 *
 * Derived from measured provider spend:
 *   image_gen     ≈ $0.039–0.050 → $0.045
 *   image_edit    ≈ $0.02
 *   video         ≈ $0.10
 */
export const FIXED_RAW_COST_MICROS = Object.freeze({
  image_gen: 45_000,
  image_edit: 20_000,
  video: 100_000,
  transcription: 15_000,
  tts: 9_000,
  file_large: 50_000,
  file_small: 15_000,
  image_analysis: 20_000,
});

const FIXED_ACTIONS = new Set(Object.keys(FIXED_RAW_COST_MICROS));

const VARIABLE_ACTIONS = new Set([
  'agent_run',
  'browser_run',
  'deep_research',
  'premium_model',
  'autonomous_compute',
]);

export function isFixedUsageAction(actionType) {
  return FIXED_ACTIONS.has(String(actionType || ''));
}

export function isVariableUsageAction(actionType) {
  return VARIABLE_ACTIONS.has(String(actionType || ''));
}

/**
 * Resolve the raw provider cost for an action.
 * Priority: authoritative measured cost → fixed raw-cost table → zero.
 */
export function quoteUsageCharge({
  actionType,
  providerCostUsd = 0,
  providerCostMicros = null,
  fixedOverrideMicros = null,
} = {}) {
  const action = String(actionType || '');
  const measured = Number.isInteger(providerCostMicros)
    ? providerCostMicros
    : roundProviderCostMicros(providerCostUsd || 0);

  if (Number.isInteger(fixedOverrideMicros)) {
    return {
      actionType: action,
      kind: 'fixed_override',
      pricingVersion: USAGE_PRICING_VERSION,
      providerCostMicros: measured,
      rawCostMicros: roundCustomerChargeMicros(fixedOverrideMicros),
    };
  }

  if (FIXED_ACTIONS.has(action)) {
    return {
      actionType: action,
      kind: 'fixed',
      pricingVersion: USAGE_PRICING_VERSION,
      providerCostMicros: measured > 0 ? measured : FIXED_RAW_COST_MICROS[action],
      rawCostMicros: FIXED_RAW_COST_MICROS[action],
    };
  }

  return {
    actionType: action,
    kind: measured > 0 ? 'measured' : 'none',
    pricingVersion: USAGE_PRICING_VERSION,
    providerCostMicros: measured,
    rawCostMicros: measured,
  };
}

/**
 * Worst-case (top-up profile) customer charge for a quote. Preflight
 * authorization and analytics estimates only — the settled charge comes
 * from the actual allocation across buckets.
 */
export function estimateChargeMicros(quote) {
  return chargeForRawMicros(quote?.rawCostMicros || 0, 'topup');
}

export function quoteDisplay(quote) {
  return {
    ...quote,
    providerCostUsd: formatUsd(quote.providerCostMicros || 0),
    estimatedChargeUsd: formatUsd(estimateChargeMicros(quote)),
  };
}

export function microsPerUsd() {
  return MICROS_PER_USD;
}
