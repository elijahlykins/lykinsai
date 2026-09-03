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
 * Rates are set as LYKN's cut of each customer dollar spent:
 * cut = 1 - den/num, so a 25% cut is 4/3 and a 30% cut is 10/7.
 *
 *   topup / promotional  10/7 (~1.4286x)  LYKN keeps 30% of every dollar
 *   pro_monthly          4/3  (~1.3333x)  LYKN keeps 25% of plan dollars
 *   student_monthly      4/3             same value as Pro
 *   max_monthly          4/3             same value as Pro
 */
export const PRICING_PROFILES = Object.freeze({
  topup: Object.freeze({ num: 10, den: 7 }),
  promotional: Object.freeze({ num: 10, den: 7 }),
  pro_monthly: Object.freeze({ num: 4, den: 3 }),
  student_monthly: Object.freeze({ num: 4, den: 3 }),
  max_monthly: Object.freeze({ num: 4, den: 3 }),
});

/** Bucket defaults for lots that carry no explicit profile. */
export const DEFAULT_PROFILE_BY_BUCKET = Object.freeze({
  purchased: 'topup',
  promotional: 'promotional',
  plan: 'pro_monthly',
  included: 'pro_monthly',
});

/**
 * Unknown profile keys fall back to the top-up profile: the least
 * favorable customer rate, so a bad key can never undercharge.
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
