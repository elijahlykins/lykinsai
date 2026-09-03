#!/usr/bin/env node
// Schedule existing $25 monthly Pro subscriptions onto $20 at NEXT renewal.
//
// Usage:
//   npm run billing:migrate-pro-20 -- --dry-run
//   npm run billing:migrate-pro-20 -- --execute
//
// Dry-run is the default. --execute calls Stripe.
// Never sets billing_cycle_anchor or proration other than `none`.
//
// Requires STRIPE_SECRET_KEY and STRIPE_PRICE_STUDIO_MONTHLY (the $20 Price).
// Optional STRIPE_PRICE_STUDIO_MONTHLY_LEGACY names the old $25 Price.

import 'dotenv/config';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import {
  MIGRATION_META_KEY,
  MIGRATION_META_SCHEDULED,
  assertNoImmediateInvoice,
  buildPro20ScheduleUpdate,
  classifyPro20Migration,
  itemTaxRateIds,
  migrationExecutionPlan,
  summarizeDecisions,
  subscriptionPeriodEndUnix,
} from '../lib/billing/proPriceMigration.js';
import { logBillingEvent } from '../lib/billing/billingEvents.js';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const dryRun = !execute;

const stripeKey = process.env.STRIPE_SECRET_KEY;
const targetPriceId = String(process.env.STRIPE_PRICE_STUDIO_MONTHLY || '').trim();
const legacyPriceIds = [
  process.env.STRIPE_PRICE_STUDIO_MONTHLY_LEGACY,
  process.env.STRIPE_PRICE_STUDIO_PRO_MONTHLY,
].map((value) => String(value || '').trim()).filter(Boolean);

if (!stripeKey) {
  console.error('Missing STRIPE_SECRET_KEY');
  process.exit(1);
}
if (!targetPriceId) {
  console.error('Missing STRIPE_PRICE_STUDIO_MONTHLY (the new $20 monthly Price id)');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const supabase = process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  : null;

function periodStartUnix(subscription) {
  const item = subscription?.items?.data?.[0];
  const itemStart = Number(item?.current_period_start || 0);
  if (itemStart > 0) return itemStart;
  const top = Number(subscription?.current_period_start || 0);
  return top > 0 ? top : null;
}

async function loadBillingByCustomer() {
  const map = new Map();
  if (!supabase) return map;
  const { data, error } = await supabase
    .from('user_billing')
    .select('user_id, plan, status, stripe_customer_id, stripe_subscription_id');
  if (error) {
    console.warn('user_billing read failed:', error.message);
    return map;
  }
  for (const row of data || []) {
    if (row.stripe_customer_id) map.set(row.stripe_customer_id, row);
    if (row.stripe_subscription_id) map.set(row.stripe_subscription_id, row);
  }
  return map;
}

async function retrieveSchedule(subscription) {
  const id = typeof subscription.schedule === 'string'
    ? subscription.schedule
    : subscription.schedule?.id;
  if (!id) return null;
  return stripe.subscriptionSchedules.retrieve(id);
}

async function applySchedule(subscription, classification) {
  const start = periodStartUnix(subscription);
  const end = classification.periodEndUnix || subscriptionPeriodEndUnix(subscription);
  const params = buildPro20ScheduleUpdate({
    currentPriceId: classification.currentPriceId,
    targetPriceId,
    quantity: classification.quantity || 1,
    currentPhaseStartUnix: start,
    periodEndUnix: end,
    taxRateIds: itemTaxRateIds(subscription?.items?.data?.[0]),
  });
  assertNoImmediateInvoice(params);

  let scheduleId = classification.scheduleId;
  if (!scheduleId) {
    const created = await stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    });
    scheduleId = created.id;
  }

  const updated = await stripe.subscriptionSchedules.update(scheduleId, params);
  await stripe.subscriptions.update(subscription.id, {
    metadata: {
      ...(subscription.metadata || {}),
      [MIGRATION_META_KEY]: MIGRATION_META_SCHEDULED,
    },
  });
  return updated.id;
}

const targetPrice = await stripe.prices.retrieve(targetPriceId);
if (Number(targetPrice.unit_amount) !== 2000 || targetPrice.recurring?.interval !== 'month') {
  console.error(
    `STRIPE_PRICE_STUDIO_MONTHLY ${targetPriceId} is ${targetPrice.unit_amount}/${targetPrice.recurring?.interval}, expected 2000/month`,
  );
  process.exit(1);
}

const billing = await loadBillingByCustomer();
const rows = [];

for await (const subscription of stripe.subscriptions.list({
  status: 'all',
  limit: 100,
  expand: ['data.items.data.price', 'data.discount'],
})) {
  let schedule = null;
  if (subscription.schedule) {
    try {
      schedule = await retrieveSchedule(subscription);
    } catch (err) {
      console.warn(`schedule read failed for ${subscription.id}:`, err?.message || err);
    }
  }
  const mirror = billing.get(subscription.id)
    || billing.get(typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id)
    || null;
  const classification = classifyPro20Migration({
    subscription,
    schedule,
    targetPriceId,
    legacyPriceIds,
    billingPlan: mirror?.plan || null,
  });
  rows.push({
    ...classification,
    userId: mirror?.user_id || null,
  });
}

const counts = summarizeDecisions(rows);
console.log(dryRun ? '══ DRY RUN (no Stripe mutations) ══' : '══ EXECUTE ══');
console.log(`target price: ${targetPriceId} ($20/month)`);
console.log(counts);
console.log('');
console.log([
  'decision',
  'reason',
  'subscription',
  'customer',
  'current_price',
  'amount',
  'period_end',
  'intended_price',
].join('\t'));

for (const row of rows) {
  console.log([
    row.decision,
    row.reason,
    row.subscriptionId,
    row.customerId,
    row.currentPriceId,
    row.currentAmountCents,
    row.periodEndIso || '',
    row.intendedPriceId,
  ].join('\t'));
}

const plan = migrationExecutionPlan(rows, { dryRun });
if (plan.dryRun) {
  console.log('\nDry run complete. Re-run with --execute to schedule eligible subscriptions.');
  process.exit(0);
}

let applied = 0;
let failed = 0;
for (const row of plan.mutations) {
  const subscription = await stripe.subscriptions.retrieve(row.subscriptionId, {
    expand: ['items.data.price', 'discount'],
  });
  try {
    const scheduleId = await applySchedule(subscription, row);
    applied += 1;
    logBillingEvent('pro20_migration_scheduled', {
      subscriptionId: row.subscriptionId,
      scheduleId,
    });
    console.log(`scheduled ${row.subscriptionId} → ${scheduleId}`);
  } catch (err) {
    failed += 1;
    logBillingEvent('pro20_migration_failed', {
      subscriptionId: row.subscriptionId,
      error: err?.message || String(err),
    });
  }
}

console.log(`\nApplied ${applied}. Failed ${failed}.`);
process.exit(failed ? 1 : 0);
