// Backfill current_period_end / status / cancel_at_period_end on user_billing
// from the live Stripe subscription. Needed because stripe@^22 moved
// `current_period_end` off the top-level Subscription onto its items, so the
// old webhook code wrote NULL for every row. New webhooks are fixed; this
// repairs the rows that already exist.
//
// Usage:
//   node scripts/backfill-stripe-period-end.mjs
//   node scripts/backfill-stripe-period-end.mjs --dry-run
//
// Requires STRIPE_SECRET_KEY, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in env.
import 'dotenv/config';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const dryRun = process.argv.includes('--dry-run');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!stripeKey || !url || !serviceKey) {
  console.error('Missing STRIPE_SECRET_KEY, VITE_SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

// Mirror server.js subscriptionPeriodEndUnix: item-level first, top-level fallback.
function periodEndISO(subscription) {
  const items = subscription?.items?.data || [];
  let maxItemEnd = 0;
  for (const item of items) {
    const end = Number(item?.current_period_end || 0);
    if (Number.isFinite(end) && end > maxItemEnd) maxItemEnd = end;
  }
  const topLevel = Number(subscription?.current_period_end || 0);
  const unix = maxItemEnd > 0 ? maxItemEnd : (Number.isFinite(topLevel) && topLevel > 0 ? topLevel : null);
  return unix ? new Date(unix * 1000).toISOString() : null;
}

const { data: rows, error } = await supabase
  .from('user_billing')
  .select('user_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end')
  .not('stripe_subscription_id', 'is', null);

if (error) {
  console.error('Failed to load user_billing:', error.message);
  process.exit(1);
}

let checked = 0;
let updated = 0;
let unchanged = 0;
let failed = 0;

for (const row of rows || []) {
  checked += 1;
  const subId = row.stripe_subscription_id;
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    failed += 1;
    console.warn(`✗ ${subId}: retrieve failed — ${err?.message || err}`);
    continue;
  }

  const patch = {
    status: sub.status,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    current_period_end: periodEndISO(sub),
  };

  const same =
    row.status === patch.status &&
    Boolean(row.cancel_at_period_end) === patch.cancel_at_period_end &&
    (row.current_period_end || null) === patch.current_period_end;
  if (same) {
    unchanged += 1;
    continue;
  }

  if (dryRun) {
    console.log(`[dry-run] ${subId} → status=${patch.status} ends=${patch.current_period_end} cancel_at_period_end=${patch.cancel_at_period_end}`);
    updated += 1;
    continue;
  }

  const { error: upErr } = await supabase
    .from('user_billing')
    .update(patch)
    .eq('user_id', row.user_id);
  if (upErr) {
    failed += 1;
    console.warn(`✗ ${subId}: update failed — ${upErr.message}`);
    continue;
  }
  console.log(`✓ ${subId} → status=${patch.status} ends=${patch.current_period_end}`);
  updated += 1;
}

console.log('');
console.log(`Done. checked=${checked} updated=${updated} unchanged=${unchanged} failed=${failed}${dryRun ? ' (dry-run)' : ''}`);
