#!/usr/bin/env node
/**
 * Admin grant: add usage balance to an account without a Stripe payment.
 *
 * For comped accounts, support credits, and dev/testing — production
 * subscribers get their monthly usage from `invoice.paid` webhooks, never
 * from this script.
 *
 * Usage:
 *   node --env-file=.env scripts/grant-usage.mjs --user <uuid> --amount 100
 *     [--bucket plan|promotional|purchased]   default: plan
 *     [--days <n>]                            plan-bucket expiry, default 30
 *
 * The grant is idempotent per user+bucket+day, so re-running the same
 * command on the same day is a no-op instead of a double grant.
 */

import { grantUsageBalance, getUsageBalance } from '../lib/billing/usageBalance.js';
import { USAGE_BUCKETS, TXN_TYPES } from '../lib/billing/usageSpend.js';
import { DEFAULT_PROFILE_BY_BUCKET } from '../lib/billing/pricingProfiles.js';
import { usdToMicros, formatUsd } from '../lib/billing/money.js';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const userId = arg('user');
const amountUsd = Number(arg('amount'));
const bucket = arg('bucket', USAGE_BUCKETS.PLAN);
const days = Number(arg('days', '30'));

if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error('Missing or invalid --user <uuid>');
  process.exit(1);
}
if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1000) {
  console.error('Missing or invalid --amount <usd> (0 < amount <= 1000)');
  process.exit(1);
}
if (!Object.values(USAGE_BUCKETS).includes(bucket) || bucket === USAGE_BUCKETS.INCLUDED) {
  console.error(`Invalid --bucket. One of: plan, promotional, purchased`);
  process.exit(1);
}
if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (use --env-file=.env)');
  process.exit(1);
}

const amountMicros = usdToMicros(amountUsd);
// Plan grants expire like a billing period; promotional/purchased do not.
const expiresAt = bucket === USAGE_BUCKETS.PLAN
  ? new Date(Date.now() + days * 86_400_000).toISOString()
  : null;
const txnType = bucket === USAGE_BUCKETS.PLAN
  ? TXN_TYPES.SUBSCRIPTION_GRANT
  : bucket === USAGE_BUCKETS.PURCHASED
    ? TXN_TYPES.FUNDING
    : TXN_TYPES.PROMOTIONAL_GRANT;
const today = new Date().toISOString().slice(0, 10);

const result = await grantUsageBalance(userId, {
  amountMicros,
  bucket,
  pricingProfile: DEFAULT_PROFILE_BY_BUCKET[bucket],
  txnType,
  expiresAt,
  idempotencyKey: `manual-grant:${userId}:${bucket}:${today}`,
  metadata: {
    source: 'scripts/grant-usage.mjs',
    granted_by: 'admin',
    ...(expiresAt ? { expires_at: expiresAt, period_end_unix: Math.floor(Date.parse(expiresAt) / 1000) } : {}),
  },
});

if (!result?.ok) {
  console.error('Grant failed:', JSON.stringify(result));
  process.exit(1);
}
if (result.duplicate) {
  console.log(`Already granted today (idempotent no-op).`);
} else {
  console.log(`Granted ${formatUsd(amountMicros)} to ${userId} [${bucket}]${expiresAt ? ` expires ${expiresAt.slice(0, 10)}` : ''}.`);
}
const balance = await getUsageBalance(userId);
console.log(`Balance now: ${balance.display} (plan ${formatUsd(balance.plan + balance.included)}, promo ${formatUsd(balance.promotional)}, purchased ${formatUsd(balance.purchased)})`);
