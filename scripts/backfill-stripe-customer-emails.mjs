// Backfill missing email/name on Stripe customers from Supabase auth.
//
// Usage:
//   node scripts/backfill-stripe-customer-emails.mjs
//   node scripts/backfill-stripe-customer-emails.mjs --dry-run
//
// Requires STRIPE_SECRET_KEY, VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.
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

function resolveEmail(user) {
  const direct = String(user?.email || '').trim();
  if (direct) return direct;
  const meta = String(user?.user_metadata?.email || '').trim();
  if (meta) return meta;
  for (const identity of user?.identities || []) {
    const fromIdentity = String(identity?.identity_data?.email || '').trim();
    if (fromIdentity) return fromIdentity;
  }
  return null;
}

function resolveName(user) {
  const meta = user?.user_metadata || {};
  return String(meta.full_name || meta.name || '').trim() || null;
}

const { data: rows, error } = await supabase
  .from('user_billing')
  .select('user_id, stripe_customer_id')
  .not('stripe_customer_id', 'is', null);

if (error) {
  console.error('Failed to load user_billing:', error.message);
  process.exit(1);
}

let checked = 0;
let updated = 0;
let skipped = 0;
let failed = 0;

for (const row of rows || []) {
  checked += 1;
  const customerId = row.stripe_customer_id;
  let customer;
  try {
    customer = await stripe.customers.retrieve(customerId);
  } catch (err) {
    failed += 1;
    console.warn(`✗ ${customerId}: retrieve failed — ${err?.message || err}`);
    continue;
  }

  if (customer.email) {
    skipped += 1;
    continue;
  }

  const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(row.user_id);
  if (authErr || !authData?.user) {
    failed += 1;
    console.warn(`✗ ${customerId}: no auth user for ${row.user_id}`);
    continue;
  }

  const email = resolveEmail(authData.user);
  const name = resolveName(authData.user);
  if (!email) {
    failed += 1;
    console.warn(`✗ ${customerId}: auth user ${row.user_id} has no email`);
    continue;
  }

  const patch = { email };
  if (name && !customer.name) patch.name = name;

  if (dryRun) {
    console.log(`[dry-run] would update ${customerId} → ${email}${patch.name ? ` (${patch.name})` : ''}`);
    updated += 1;
    continue;
  }

  try {
    await stripe.customers.update(customerId, patch);
    console.log(`✓ ${customerId} → ${email}`);
    updated += 1;
  } catch (err) {
    failed += 1;
    console.warn(`✗ ${customerId}: update failed — ${err?.message || err}`);
  }
}

console.log('');
console.log(`Done. checked=${checked} updated=${updated} already_had_email=${skipped} failed=${failed}${dryRun ? ' (dry-run)' : ''}`);
