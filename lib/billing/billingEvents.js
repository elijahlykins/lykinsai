/**
 * Structured billing logs. Never include card numbers, payment methods,
 * bank accounts, or raw Stripe customer objects.
 */

const SENSITIVE_KEYS = new Set([
  'card',
  'number',
  'cvc',
  'exp_month',
  'exp_year',
  'payment_method',
  'source',
  'client_secret',
  'payment_intent',
  'bank_account',
]);

function redact(details) {
  if (!details || typeof details !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (key === 'userId' && typeof value === 'string') {
      out.userIdPrefix = value.slice(0, 8);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function logBillingEvent(event, details = {}) {
  const payload = redact(details);
  console.log(`[billing] ${event} ${JSON.stringify(payload)}`);
}
