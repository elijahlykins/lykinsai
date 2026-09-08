/**
 * Internal pricing profiles — the single place LYKN margin lives.
 *
 * A pricing profile converts raw provider cost into the customer charge
 * for money spent from a specific funding bucket. Profiles are rational
 * integers (numerator/denominator) so authoritative billing math never
 * touches floating point.
 *
 * Never expose multipliers, margin, or provider cost through customer
 * APIs or UI copy. Users see dollars of usage, nothing else.
 *
 * To change LYKN economics, edit PRICING_PROFILES here — nowhere else.
 */

import { assertMicros } from './money.js';

export const PRICING_PROFILE_VERSION = 'profiles-v1';

/**
 * profile key → { num, den }: customerCharge = ceil(rawCost * num / den).
 *
 * One flat rate everywhere: a 50% markup on raw provider cost (3/2), the
 * industry baseline for AI usage pricing. Equivalently, LYKN keeps a third
 * of every customer dollar spent (cut = 1 - den/num = 1/3), whether the
 * dollar came from a top-up, a promotion, or a monthly plan. Every profile
 * key below maps to the same 3/2 ratio; the keys stay distinct so ledger
 * rows keep recording which kind of money paid.
 */
const FLAT_FIFTY_PERCENT_MARKUP = Object.freeze({ num: 3, den: 2 });

export const PRICING_PROFILES = Object.freeze({
  topup: FLAT_FIFTY_PERCENT_MARKUP,
  promotional: FLAT_FIFTY_PERCENT_MARKUP,
  pro_monthly: FLAT_FIFTY_PERCENT_MARKUP,
  pro_plus_monthly: FLAT_FIFTY_PERCENT_MARKUP,
  student_monthly: FLAT_FIFTY_PERCENT_MARKUP,
  max_monthly: FLAT_FIFTY_PERCENT_MARKUP,
});

/** Bucket defaults for lots that carry no explicit profile. */
export const DEFAULT_PROFILE_BY_BUCKET = Object.freeze({
  purchased: 'topup',
  promotional: 'promotional',
  plan: 'pro_monthly',
  included: 'pro_monthly',
});

/**
 * Unknown profile keys fall back to the top-up profile so a bad key can
 * never undercharge. All profiles currently share the flat 20% rate, so
 * the fallback only matters if rates ever diverge again.
 */
export function resolveProfile(profileKey) {
  return PRICING_PROFILES[String(profileKey || '')] || PRICING_PROFILES.topup;
}

export function profileForLot(lot) {
  const explicit = String(lot?.pricing_profile || '');
  if (PRICING_PROFILES[explicit]) return explicit;
  return DEFAULT_PROFILE_BY_BUCKET[String(lot?.bucket || '')] || 'topup';
}

/** Customer charge (micros) for a raw provider cost paid via `profileKey`. */
export function chargeForRawMicros(rawMicros, profileKey) {
  const raw = assertMicros(rawMicros, 'rawCost');
  const { num, den } = resolveProfile(profileKey);
  return Math.ceil((raw * num) / den);
}

/**
 * How much raw provider cost `remainingMicros` of customer balance can
 * cover under `profileKey`. Ceil so a nearly-empty lot is drained instead
 * of stranding a few unusable micros (bounded sub-micro rounding in the
 * customer's favor).
 */
export function rawCapacityMicros(remainingMicros, profileKey) {
  const remaining = assertMicros(remainingMicros, 'remaining');
  if (remaining <= 0) return 0;
  const { num, den } = resolveProfile(profileKey);
  return Math.ceil((remaining * den) / num);
}

/** jsonb payload for the SQL allocation RPCs. */
export function profilesForSql() {
  const out = {};
  for (const [key, ratio] of Object.entries(PRICING_PROFILES)) {
    out[key] = { num: ratio.num, den: ratio.den };
  }
  return out;
}
