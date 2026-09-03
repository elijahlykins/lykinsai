#!/usr/bin/env node
// Create a recurring $20 monthly Stripe Price on the existing Pro product.
//
// Usage:
//   node scripts/create-pro-20-price.mjs
//   node scripts/create-pro-20-price.mjs --execute
//
// Dry-run is the default. This never invents a Price id.
// After a real create, set STRIPE_PRICE_STUDIO_MONTHLY to the printed id
// and keep the old $25 id in STRIPE_PRICE_STUDIO_MONTHLY_LEGACY.

import 'dotenv/config';
import Stripe from 'stripe';

const execute = process.argv.includes('--execute');
const stripeKey = process.env.STRIPE_SECRET_KEY;
const currentId = String(process.env.STRIPE_PRICE_STUDIO_MONTHLY || '').trim();

if (!stripeKey) {
  console.error('Missing STRIPE_SECRET_KEY');
  process.exit(1);
}
if (!currentId) {
  console.error('Missing STRIPE_PRICE_STUDIO_MONTHLY. Need the current Pro monthly Price to copy product settings.');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const current = await stripe.prices.retrieve(currentId);

console.log(`Current STRIPE_PRICE_STUDIO_MONTHLY: ${current.id}`);
console.log(`  product: ${current.product}`);
console.log(`  amount:  ${current.unit_amount} ${current.currency}`);
console.log(`  recur:   ${current.recurring?.interval}/${current.recurring?.interval_count}`);

if (current.unit_amount === 2000 && current.recurring?.interval === 'month') {
  console.log('Already a $20 monthly Price. No create needed.');
  process.exit(0);
}

const payload = {
  product: typeof current.product === 'string' ? current.product : current.product?.id,
  currency: current.currency || 'usd',
  unit_amount: 2000,
  recurring: {
    interval: 'month',
    interval_count: 1,
  },
  nickname: current.nickname ? `${current.nickname} $20` : 'LYKN Pro monthly $20',
  metadata: {
    lykn_plan: 'studio',
    lykn_period: 'monthly',
    lykn_list_price: '20',
  },
  tax_behavior: current.tax_behavior || undefined,
};

console.log('\nWould create:');
console.log(JSON.stringify(payload, null, 2));

if (!execute) {
  console.log('\nDry run. Re-run with --execute to create the Price, then set:');
  console.log('  STRIPE_PRICE_STUDIO_MONTHLY=<new_price_id>');
  console.log(`  STRIPE_PRICE_STUDIO_MONTHLY_LEGACY=${current.id}`);
  process.exit(0);
}

const created = await stripe.prices.create(payload);
console.log(`\nCreated ${created.id} ($20/month).`);
console.log('Set these env vars. Do not point existing $25 subscriptions at this id until migrate-pro-20 runs.');
console.log(`  STRIPE_PRICE_STUDIO_MONTHLY=${created.id}`);
console.log(`  STRIPE_PRICE_STUDIO_MONTHLY_LEGACY=${current.id}`);
