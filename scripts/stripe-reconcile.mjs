// Reconcile Stripe (source of truth) against the user_billing mirror.
// Answers: how many real customers/subscriptions exist, who abandoned
// checkout (customer, no sub), and — most importantly — whether any Stripe
// subscriptions are MISSING from user_billing (proof of dropped webhooks).
//
// Usage:
//   node scripts/stripe-reconcile.mjs
//
// Requires STRIPE_SECRET_KEY, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import 'dotenv/config';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!stripeKey || !url || !serviceKey) {
  console.error('Missing STRIPE_SECRET_KEY, VITE_SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const DAY = 86_400_000;
const now = Date.now();

function fmtDate(unixSec) {
  return unixSec ? new Date(unixSec * 1000).toISOString().slice(0, 10) : '—';
}

// ── 1. Pull every Stripe customer ───────────────────────────────────────────
const customers = [];
for await (const c of stripe.customers.list({ limit: 100 })) customers.push(c);

// ── 2. Pull every subscription (all statuses) ───────────────────────────────
const subs = [];
for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) subs.push(s);

// ── 3. Pull the DB mirror ────────────────────────────────────────────────────
const { data: rows, error } = await supabase
  .from('user_billing')
  .select('user_id, plan, status, stripe_subscription_id, stripe_customer_id');
if (error) {
  console.error('Failed to load user_billing:', error.message);
  process.exit(1);
}

// ── Aggregate ────────────────────────────────────────────────────────────────
const subsByStatus = {};
for (const s of subs) subsByStatus[s.status] = (subsByStatus[s.status] || 0) + 1;

const customersWithSub = new Set(subs.map((s) => (typeof s.customer === 'string' ? s.customer : s.customer?.id)));
const customersNoSub = customers.filter((c) => !customersWithSub.has(c.id));

const newLast7 = customers.filter((c) => now - c.created * 1000 <= 7 * DAY).length;
const newLast30 = customers.filter((c) => now - c.created * 1000 <= 30 * DAY).length;

const dbSubIds = new Set(rows.map((r) => r.stripe_subscription_id).filter(Boolean));
const stripeSubIds = new Set(subs.map((s) => s.id));

const missingFromDb = subs.filter((s) => !dbSubIds.has(s.id));
const staleInDb = [...dbSubIds].filter((id) => !stripeSubIds.has(id));

// ── Report ───────────────────────────────────────────────────────────────────
console.log('═══════════════ STRIPE (source of truth) ═══════════════');
console.log(`Total customers:            ${customers.length}`);
console.log(`  new in last 7 days:       ${newLast7}`);
console.log(`  new in last 30 days:      ${newLast30}`);
console.log(`Customers WITH a sub:       ${customersWithSub.size}`);
console.log(`Customers with NO sub:      ${customersNoSub.length}  (started checkout, never subscribed)`);
console.log('');
console.log(`Total subscriptions:        ${subs.length}`);
for (const [status, n] of Object.entries(subsByStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status.padEnd(22)}${n}`);
}

const trialing = subs.filter((s) => s.status === 'trialing');
if (trialing.length) {
  console.log('');
  console.log('Active trials (first charge date):');
  for (const s of trialing) {
    const periodEnd = s.items?.data?.[0]?.current_period_end || s.current_period_end;
    console.log(`  ${s.id}  charges ${fmtDate(s.trial_end || periodEnd)}  cancel_at_period_end=${s.cancel_at_period_end}`);
  }
}

console.log('');
console.log('═══════════════ DATABASE MIRROR (user_billing) ═══════════════');
console.log(`Rows:                       ${rows.length}`);
const dbByStatus = {};
for (const r of rows) dbByStatus[r.status] = (dbByStatus[r.status] || 0) + 1;
for (const [status, n] of Object.entries(dbByStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(status).padEnd(22)}${n}`);
}
console.log(`Rows with a subscription:   ${dbSubIds.size}`);

console.log('');
console.log('═══════════════ DRIFT (the part that matters) ═══════════════');
if (missingFromDb.length === 0) {
  console.log('✓ Every Stripe subscription is present in user_billing. No dropped webhooks.');
} else {
  console.log(`✗ ${missingFromDb.length} Stripe subscription(s) MISSING from user_billing (dropped/never-processed webhooks):`);
  for (const s of missingFromDb) {
    const cust = typeof s.customer === 'string' ? s.customer : s.customer?.id;
    console.log(`    ${s.id}  status=${s.status}  customer=${cust}  created=${fmtDate(s.created)}`);
  }
  console.log('  → Run scripts/backfill-stripe-period-end.mjs after linking, or re-send these events from the Stripe Dashboard.');
}
if (staleInDb.length) {
  console.log(`! ${staleInDb.length} subscription id(s) in user_billing no longer exist in Stripe: ${staleInDb.join(', ')}`);
}
console.log('');
console.log('Done.');
