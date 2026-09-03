/**
 * Integer money for Usage Balance.
 *
 * Internal unit: microdollars (micros).
 * 1 USD = 1_000_000 micros.
 *
 * Cents are not precise enough for provider inference (often $0.002–$0.009).
 * Model Builder still uses cents for its separate LoRA wallet. Do not mix.
 *
 * All monetary math in the Usage Balance subsystem must go through this file.
 * Do not scatter `/ 100`, `* 1e6`, or ad-hoc rounding elsewhere.
 */

export const MONEY_UNIT = 'microdollar';
export const MICROS_PER_USD = 1_000_000;
export const MICROS_PER_CENT = 10_000;
export const MONEY_CURRENCY = 'usd';

/** Hard ceiling so a bad payload cannot overflow JS or bigint-adjacent SQL. $1,000,000. */
export const MAX_MICROS = 1_000_000 * MICROS_PER_USD;

export class MoneyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MoneyError';
    this.code = code;
  }
}

export function assertMicros(value, label = 'amount') {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError('invalid_micros', `${label} must be an integer number of microdollars`);
  }
  if (value < 0) {
    throw new MoneyError('negative_micros', `${label} cannot be negative`);
  }
  if (value > MAX_MICROS) {
    throw new MoneyError('micros_overflow', `${label} exceeds the allowed maximum`);
  }
  return value;
}

export function assertCents(value, label = 'amount') {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError('invalid_cents', `${label} must be an integer number of cents`);
  }
  if (value < 0) {
    throw new MoneyError('negative_cents', `${label} cannot be negative`);
  }
  return value;
}

function parseUsdParts(usd) {
  if (typeof usd === 'number') {
    if (!Number.isFinite(usd)) throw new MoneyError('invalid_usd', 'usd must be a finite number');
    const sign = usd < 0 ? -1 : 1;
    const abs = Math.abs(usd);
    const text = abs.toFixed(8);
    return { sign, text };
  }
  const raw = String(usd ?? '').trim();
  if (!raw) throw new MoneyError('invalid_usd', 'usd is required');
  const sign = raw.startsWith('-') ? -1 : 1;
  const text = raw.replace(/^[+-]/, '');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new MoneyError('invalid_usd', 'usd must be a decimal string');
  return { sign, text };
}

/**
 * Convert a USD amount to micros.
 * `nearest` is for measured provider cost.
 * `ceil` is for customer charges so we never under-charge a fraction of a micro.
 * `floor` is for display-only conversions that must not invent money.
 */
export function usdToMicros(usd, { mode = 'nearest' } = {}) {
  const { sign, text } = parseUsdParts(usd);
  const [wholeRaw, fracRaw = ''] = text.split('.');
  const whole = Number(wholeRaw);
  const frac = (fracRaw + '000000').slice(0, 6);
  const extra = fracRaw.slice(6);
  let micros = whole * MICROS_PER_USD + Number(frac);
  if (extra) {
    const leftover = Number(`0.${extra}`);
    if (mode === 'ceil' && leftover > 0) micros += 1;
    else if (mode === 'nearest' && leftover >= 0.5) micros += 1;
  }
  const signed = sign * micros;
  if (signed < 0) throw new MoneyError('negative_micros', 'usd converted to a negative amount');
  return assertMicros(signed, 'usd');
}

export function centsToMicros(cents) {
  return assertMicros(assertCents(cents, 'cents') * MICROS_PER_CENT, 'cents');
}

export function microsToCents(micros, { mode = 'floor' } = {}) {
  const value = assertMicros(micros, 'micros');
  if (mode === 'ceil') return Math.ceil(value / MICROS_PER_CENT);
  if (mode === 'nearest') return Math.round(value / MICROS_PER_CENT);
  return Math.floor(value / MICROS_PER_CENT);
}

/** Display-only. Never persist the result. */
export function microsToUsdNumber(micros) {
  return assertMicros(micros, 'micros') / MICROS_PER_USD;
}

/**
 * Customer-facing dollars and cents.
 * $18.42 — never expose micros or provider cost through this helper.
 */
export function formatUsd(micros) {
  const sign = micros < 0 ? '-' : '';
  const abs = assertMicros(Math.abs(micros), 'micros');
  const dollars = Math.floor(abs / MICROS_PER_USD);
  const cents = Math.floor((abs % MICROS_PER_USD) / MICROS_PER_CENT);
  return `${sign}$${dollars}.${String(cents).padStart(2, '0')}`;
}

export function addMicros(a, b) {
  return assertMicros(assertMicros(a) + assertMicros(b), 'sum');
}

export function subMicros(a, b) {
  const next = assertMicros(a) - assertMicros(b);
  if (next < 0) throw new MoneyError('negative_balance', 'subtraction would go negative');
  return next;
}

/** Customer charge: never round down a fractional micro. */
export function roundCustomerChargeMicros(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return assertMicros(value);
  return usdToMicros(value, { mode: 'ceil' });
}

/** Provider cost: nearest micro from a measured USD figure. */
export function roundProviderCostMicros(usd) {
  return usdToMicros(usd, { mode: 'nearest' });
}
