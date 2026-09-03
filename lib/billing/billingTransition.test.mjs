import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREDIT_PACKS,
  CREDIT_PACKS_FOR_SALE,
  PLANS,
  creditPackById,
  creditPacksForSale,
} from '../../src/lib/pricing-config.js';
import {
  classifyCheckoutPaymentSession,
  grantUsageFundingFromCheckoutSession,
  isUsageFundingSession,
  normalizeUsageFundRequest,
} from './usageFunding.js';
import {
  DECISIONS,
  MAX_MONTHLY_CENTS,
  PRO_ANNUAL_DISPLAY_CENTS,
  PRO_MONTHLY_TARGET_CENTS,
  classifyPro20Migration,
} from './proPriceMigration.js';
import {
  assertProCheckoutPriceNotLegacy,
  inspectStripePriceConfig,
} from './stripePriceConfig.js';
import { setUsageBalanceStore } from './usageBalance.js';
import { createMemoryUsageStore } from './usageSpend.js';
import {
  fallbackMicrosPerCredit,
  legacyMigrationIdempotencyKey,
  topupPaidMicros,
  valueLegacyWallet,
} from './legacyCreditMigration.js';

test('new credit-pack checkout cannot be created', () => {
  assert.equal(CREDIT_PACKS_FOR_SALE, false);
  assert.deepEqual(creditPacksForSale(), []);
});

test('historical credit pack records remain readable', () => {
  assert.equal(CREDIT_PACKS.length, 3);
  assert.equal(creditPackById('topup_1000')?.credits, 1000);
  assert.equal(creditPackById('topup_5000')?.credits, 5000);
  assert.equal(creditPackById('topup_15000')?.credits, 15000);
  assert.equal(creditPackById('topup_1000')?.priceUsd, 5);
});

test('legacy wallet valuation preserves the blended paid rate', () => {
  // $5 for 1,000 + $20 for 5,000 = $25 / 6,000 credits.
  const topups = [
    { pack_id: 'topup_1000', credits: 1000, amount_cents: 500 },
    { pack_id: 'topup_5000', credits: 5000, amount_cents: 2000 },
  ];
  const plan = valueLegacyWallet({ granted: 6000, used: 3000 }, topups);
  assert.equal(plan.remainingCredits, 3000);
  // 3,000 × ($25 / 6,000) = $12.50.
  assert.equal(plan.grantMicros, 12_500_000);
});

test('legacy valuation falls back to catalog price and best rate', () => {
  // Missing amount_cents → catalog $5 for topup_1000.
  assert.equal(topupPaidMicros({ pack_id: 'topup_1000', credits: 1000 }), 5_000_000);
  // No top-up history at all → the most generous catalog rate ($5 / 1,000).
  assert.equal(fallbackMicrosPerCredit(), 5_000);
  const plan = valueLegacyWallet({ granted: 2000, used: 0 }, []);
  assert.equal(plan.grantMicros, 10_000_000);
  // Empty wallet migrates nothing.
  assert.equal(valueLegacyWallet({ granted: 1000, used: 1000 }, []).grantMicros, 0);
  assert.equal(legacyMigrationIdempotencyKey('u1'), 'legacy-credit-migration:u1');
});

test('new Pro checkout uses $20 configuration and Max stays $100', () => {
  const pro = PLANS.find((plan) => plan.id === 'studio');
  const max = PLANS.find((plan) => plan.id === 'max');
  const student = PLANS.find((plan) => plan.id === 'student');
  const free = PLANS.find((plan) => plan.id === 'free');
  assert.equal(pro.monthlyPrice, 20);
  assert.equal(pro.annualPrice, 204);
  assert.equal(max.monthlyPrice, 100);
  assert.equal(student.monthlyPrice, 15);
  assert.equal(free.monthlyPrice, 0);
  assert.equal(free.checkout, false);
  assert.equal(PRO_MONTHLY_TARGET_CENTS, 2000);
  assert.equal(MAX_MONTHLY_CENTS, 10000);
  assert.equal(PRO_ANNUAL_DISPLAY_CENTS, 20400);
});

test('webhook metadata cannot confuse Usage funding with a historical credit pack', () => {
  const funding = { mode: 'payment', metadata: { usage_funding: '1' } };
  const pack = { mode: 'payment', metadata: { topup_pack: 'topup_1000' } };
  const both = { mode: 'payment', metadata: { usage_funding: '1', topup_pack: 'topup_1000' } };
  const sub = { mode: 'subscription', metadata: {} };
  assert.equal(isUsageFundingSession(funding), true);
  assert.equal(classifyCheckoutPaymentSession(funding), 'usage_funding');
  assert.equal(classifyCheckoutPaymentSession(pack), 'credit_pack');
  assert.equal(classifyCheckoutPaymentSession(both), 'usage_funding');
  assert.equal(classifyCheckoutPaymentSession(sub), 'subscription');
});

test('ambiguous non-Pro $25 is reported rather than changed', () => {
  const row = classifyPro20Migration({
    subscription: {
      id: 'sub_manual',
      customer: 'cus_1',
      status: 'active',
      items: {
        data: [{
          id: 'si_1',
          quantity: 1,
          current_period_end: 1_800_000_000,
          price: {
            id: 'price_custom',
            unit_amount: 1900,
            currency: 'usd',
            recurring: { interval: 'month', interval_count: 1 },
          },
        }],
      },
    },
    targetPriceId: 'price_pro_20',
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'not_25_monthly_pro');
});

test('invalid funding amounts are rejected before Stripe', () => {
  assert.equal(normalizeUsageFundRequest({ amountCents: 0 }).ok, false);
  assert.equal(normalizeUsageFundRequest({ amountCents: -500 }).ok, false);
  assert.equal(normalizeUsageFundRequest({ amountCents: 499 }).error, 'amount_too_small');
  assert.equal(normalizeUsageFundRequest({ amountCents: 50001 }).error, 'amount_too_large');
  assert.equal(normalizeUsageFundRequest({ amountCents: '13' }).ok, false);
  assert.equal(normalizeUsageFundRequest({ presetCents: 500 }).ok, true);
  assert.equal(normalizeUsageFundRequest({ amountCents: 1300 }).ok, true);
});

test('unpaid and metadata-only funding sessions do not grant', async () => {
  const store = createMemoryUsageStore();
  setUsageBalanceStore(store);
  try {
    const unpaid = await grantUsageFundingFromCheckoutSession({
      id: 'cs_unpaid',
      amount_total: 500,
      currency: 'usd',
      payment_status: 'unpaid',
      metadata: { usage_funding: '1', supabase_user_id: '11111111-1111-1111-1111-111111111111' },
    });
    assert.equal(unpaid, null);

    await assert.rejects(() => grantUsageFundingFromCheckoutSession({
      id: 'cs_eur',
      amount_total: 500,
      currency: 'eur',
      payment_status: 'paid',
      metadata: { usage_funding: '1', supabase_user_id: '11111111-1111-1111-1111-111111111111' },
    }));

    const granted = await grantUsageFundingFromCheckoutSession({
      id: 'cs_paid',
      amount_total: 500,
      currency: 'usd',
      payment_status: 'paid',
      metadata: {
        usage_funding: '1',
        supabase_user_id: '11111111-1111-1111-1111-111111111111',
        amount_cents: 50000,
      },
    });
    assert.equal(granted.ok, true);
    const bal = await store.getBalance('11111111-1111-1111-1111-111111111111');
    assert.equal(bal.available, 5_000_000);
  } finally {
    setUsageBalanceStore(null);
  }
});

test('subscription checkout sessions are not Usage funding', () => {
  assert.equal(classifyCheckoutPaymentSession({
    mode: 'subscription',
    metadata: { plan: 'studio', usage_funding: undefined },
  }), 'subscription');
  assert.equal(isUsageFundingSession({
    mode: 'subscription',
    metadata: { plan: 'studio' },
  }), false);
});

test('Pro monthly env cannot silently stay on the $25 Price', () => {
  const missing = inspectStripePriceConfig({});
  assert.equal(missing.ok, false);
  assert.ok(missing.warnings.includes('missing_studio_monthly'));

  const reversed = inspectStripePriceConfig({
    STRIPE_PRICE_STUDIO_MONTHLY: 'price_same',
    STRIPE_PRICE_STUDIO_MONTHLY_LEGACY: 'price_same',
  });
  assert.equal(reversed.reversed, true);
  assert.equal(
    assertProCheckoutPriceNotLegacy('price_same', {
      STRIPE_PRICE_STUDIO_MONTHLY: 'price_same',
      STRIPE_PRICE_STUDIO_MONTHLY_LEGACY: 'price_same',
    }).ok,
    false,
  );
  assert.equal(
    assertProCheckoutPriceNotLegacy('price_20', {
      STRIPE_PRICE_STUDIO_MONTHLY: 'price_20',
      STRIPE_PRICE_STUDIO_MONTHLY_LEGACY: 'price_25',
    }).ok,
    true,
  );
});
