import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MICROS_PER_USD,
  centsToMicros,
  formatUsd,
  usdToMicros,
  roundCustomerChargeMicros,
  roundProviderCostMicros,
  MoneyError,
} from './money.js';
import {
  USAGE_PRICING_VERSION,
  FIXED_RAW_COST_MICROS,
  estimateChargeMicros,
  quoteUsageCharge,
} from './usagePricing.js';
import {
  PRICING_PROFILES,
  chargeForRawMicros,
  profileForLot,
  rawCapacityMicros,
  resolveProfile,
} from './pricingProfiles.js';
import {
  PLAN_CATALOG,
  SIGNUP_GRANT_MICROS,
  planIncludesChat,
  planPricingProfile,
  resolvePlanId,
} from './planCatalog.js';
import {
  includedChatBaseline,
  isIncludedSubscriptionUsage,
  isModelIncludedForPaidChat,
  modelBillingStateForPaidChat,
} from './usageEntitlements.js';
import {
  PAYERS,
  USAGE_BUCKETS,
  USAGE_SPEND_POLICY,
  allocateSpendByCost,
  choosePayer,
  createMemoryUsageStore,
  quoteAndChoosePayer,
  summarizeLots,
} from './usageSpend.js';
import {
  authorizeMeteredUsage,
  ensureSignupGrant,
  fundUsageBalance,
  getUsageBalance,
  grantUsageBalance,
  listUsageHistory,
  recordUsageAfterLog,
  reverseUsageCharge,
  setUsageBalanceStore,
  usageBucketBreakdown,
  withReservedUsage,
} from './usageBalance.js';
import { classifyPlanFundingInvoice, grantPlanUsageFromInvoice } from './planFunding.js';
import { isTopupPayer, markTopupPayer } from './creditWallet.js';
import {
  grantUsageFundingFromCheckoutSession,
  normalizeUsageFundRequest,
} from './usageFunding.js';

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';

function withStore(fn) {
  return async () => {
    const store = createMemoryUsageStore();
    setUsageBalanceStore(store);
    try {
      await fn(store);
    } finally {
      setUsageBalanceStore(null);
    }
  };
}

// ── Money ────────────────────────────────────────────────────────────────────

test('money uses integer micros, never floats in storage helpers', () => {
  assert.equal(usdToMicros('1.00'), 1_000_000);
  assert.equal(usdToMicros(0.07), 70_000);
  assert.equal(centsToMicros(2000), 20_000_000);
  assert.equal(formatUsd(18_420_000), '$18.42');
  assert.ok(Number.isInteger(usdToMicros('18.42')));
  assert.throws(() => usdToMicros(-1), MoneyError);
});

test('rounding is deterministic: customer ceil, provider nearest', () => {
  assert.equal(roundCustomerChargeMicros('0.0000001'), 1);
  assert.equal(roundProviderCostMicros(0.0000004), 0);
  assert.equal(roundProviderCostMicros(0.0000006), 1);
});

// ── Pricing profiles ─────────────────────────────────────────────────────────

test('pricing profiles: 30% cut on top-ups (10/7), 25% cut on plan dollars (4/3)', () => {
  // ceil(100_000 * 10 / 7) = 142_858; ceil(100_000 * 4 / 3) = 133_334.
  assert.equal(chargeForRawMicros(100_000, 'topup'), 142_858);
  assert.equal(chargeForRawMicros(100_000, 'promotional'), 142_858);
  assert.equal(chargeForRawMicros(100_000, 'pro_monthly'), 133_334);
  assert.equal(chargeForRawMicros(100_000, 'student_monthly'), 133_334);
  assert.equal(chargeForRawMicros(100_000, 'max_monthly'), 133_334);
  assert.ok(Number.isInteger(chargeForRawMicros(1, 'topup')));
  // The cut is measured on customer dollars: spending $1.00 of top-up
  // balance covers $0.70 of provider cost (30%); plan covers $0.75 (25%).
  assert.equal(rawCapacityMicros(1_000_000, 'topup'), 700_000);
  assert.equal(rawCapacityMicros(1_000_000, 'pro_monthly'), 750_000);
});

test('unknown profile keys fall back to the least favorable rate', () => {
  assert.equal(resolveProfile('nonsense'), PRICING_PROFILES.topup);
  assert.equal(chargeForRawMicros(100_000, 'nonsense'), 142_858);
});

test('lot capacity round-trips without stranding value', () => {
  for (const profile of Object.keys(PRICING_PROFILES)) {
    for (const remaining of [1, 7, 999, 70_000, 1_000_000, 999_999]) {
      const capacity = rawCapacityMicros(remaining, profile);
      assert.ok(capacity > 0, `${profile} strands ${remaining}`);
      const charge = Math.min(remaining, chargeForRawMicros(capacity, profile));
      assert.ok(charge <= remaining);
      // Draining the full capacity consumes the lot to within a micro.
      assert.ok(remaining - charge <= 1, `${profile}/${remaining} leaves ${remaining - charge}`);
    }
  }
});

test('profileForLot: explicit profile wins, bucket default otherwise', () => {
  assert.equal(profileForLot({ bucket: 'plan', pricing_profile: 'max_monthly' }), 'max_monthly');
  assert.equal(profileForLot({ bucket: 'purchased' }), 'topup');
  assert.equal(profileForLot({ bucket: 'promotional' }), 'promotional');
});

// ── Plan catalog ─────────────────────────────────────────────────────────────

test('plan catalog: prices, included chat, and profiles are canonical', () => {
  assert.equal(PLAN_CATALOG.studio.monthlyCents, 2000);
  assert.equal(PLAN_CATALOG.max.monthlyCents, 10000);
  assert.equal(PLAN_CATALOG.student.monthlyCents, 1500);
  assert.equal(planIncludesChat('studio'), true);
  assert.equal(planIncludesChat('student'), true);
  assert.equal(planIncludesChat('max'), true);
  assert.equal(planIncludesChat('free'), false);
  assert.equal(planPricingProfile('studio'), 'pro_monthly');
  assert.equal(planPricingProfile('max'), 'max_monthly');
  assert.equal(resolvePlanId('studio_pro'), 'studio');
  assert.equal(SIGNUP_GRANT_MICROS, 10 * MICROS_PER_USD);
});

// ── Quotes: raw provider cost, never a customer price ────────────────────────

test('quotes resolve to raw provider cost; charge depends on the paying bucket', () => {
  const quote = quoteUsageCharge({ actionType: 'image_gen', providerCostUsd: 0.045 });
  assert.equal(quote.rawCostMicros, FIXED_RAW_COST_MICROS.image_gen);
  assert.equal(quote.providerCostMicros, 45_000);
  assert.equal(quote.pricingVersion, USAGE_PRICING_VERSION);
  assert.equal(estimateChargeMicros(quote), 64_286);
});

test('variable work uses measured provider cost as the raw basis', () => {
  const quote = quoteUsageCharge({ actionType: 'agent_run', providerCostUsd: 0.052 });
  assert.equal(quote.kind, 'measured');
  assert.equal(quote.rawCostMicros, 52_000);
  assert.equal(quote.providerCostMicros, 52_000);
});

// ── Included chat entitlements ───────────────────────────────────────────────

test('Pro, Student, and Max Auto chat are included; images and Free are not', () => {
  assert.equal(isIncludedSubscriptionUsage({ actionType: 'chat_short', planId: 'studio' }), true);
  assert.equal(isIncludedSubscriptionUsage({ actionType: 'chat_complex', planId: 'max' }), true);
  assert.equal(isIncludedSubscriptionUsage({ actionType: 'chat_long', planId: 'student' }), true);
  assert.equal(isIncludedSubscriptionUsage({ actionType: 'chat_short', planId: 'studio', autonomous: true }), false);
  assert.equal(isIncludedSubscriptionUsage({ actionType: 'image_gen', planId: 'studio' }), false);
  assert.equal(isIncludedSubscriptionUsage({ actionType: 'chat_short', planId: 'free' }), false);
});

test('manual models are included by metadata price, not name keywords', () => {
  const baseline = includedChatBaseline();
  assert.equal(baseline.modelId, 'gpt-5.6-sol');
  assert.ok(baseline.inputPer1k > 0 && baseline.outputPer1k > 0);

  // At or below the Auto advanced tier → included.
  assert.equal(isModelIncludedForPaidChat('gpt-5.6-sol'), true);
  assert.equal(isModelIncludedForPaidChat('claude-sonnet-5'), true);
  assert.equal(isModelIncludedForPaidChat('claude-opus-5'), true);
  // More expensive than the Auto tier → metered.
  assert.equal(isModelIncludedForPaidChat('claude-fable-5'), false);
  assert.equal(isModelIncludedForPaidChat('o3'), false);
  // Unknown models fail closed to metered.
  assert.equal(isModelIncludedForPaidChat('mystery-model-9000'), false);
  assert.equal(modelBillingStateForPaidChat('claude-fable-5'), 'metered');
});

test('explicit premium override on a paid plan meters usage', () => {
  assert.equal(isIncludedSubscriptionUsage({
    actionType: 'chat_short',
    planId: 'studio',
    explicitModelOverride: true,
    requestedModel: 'gpt-5.6-sol',
  }), true);
  assert.equal(isIncludedSubscriptionUsage({
    actionType: 'chat_short',
    planId: 'studio',
    explicitModelOverride: true,
    requestedModel: 'claude-fable-5',
  }), false);
});

// ── Spend order and allocation ───────────────────────────────────────────────

test('spending order is plan, then promotional, then purchased', () => {
  const lots = [
    { id: 'buy', bucket: 'purchased', pricing_profile: 'topup', remaining_micros: 5_000_000, created_at: '2026-01-01' },
    { id: 'promo', bucket: 'promotional', pricing_profile: 'promotional', remaining_micros: 100, created_at: '2026-01-01' },
    { id: 'plan', bucket: 'plan', pricing_profile: 'pro_monthly', remaining_micros: 400, expires_at: '2027-01-01', created_at: '2026-01-01' },
  ];
  // plan lot covers 300 raw (400µ at 4/3), promo covers 70 raw (100µ at
  // 10/7); the remaining 80 raw spills into purchased.
  const plan = allocateSpendByCost(lots, 450);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.allocations.map((a) => a.lot_id), ['plan', 'promo', 'buy']);
  assert.equal(USAGE_SPEND_POLICY.lotOrder[0], 'plan');
});

test('plan usage is charged at the plan rate, top-ups at the top-up rate', () => {
  const raw = 100_000;
  const fromPlan = allocateSpendByCost([
    { id: 'p', bucket: 'plan', pricing_profile: 'max_monthly', remaining_micros: 1_000_000, expires_at: '2027-01-01', created_at: '2026-01-01' },
  ], raw);
  const fromTopup = allocateSpendByCost([
    { id: 't', bucket: 'purchased', pricing_profile: 'topup', remaining_micros: 1_000_000, created_at: '2026-01-01' },
  ], raw);
  assert.equal(fromPlan.chargeMicros, 133_334);
  assert.equal(fromTopup.chargeMicros, 142_858);
  assert.ok(fromPlan.chargeMicros < fromTopup.chargeMicros);
});

test('expired lots cannot pay and cannot debit purchased funds', () => {
  const lots = [
    { id: 'expired', bucket: 'plan', pricing_profile: 'pro_monthly', remaining_micros: 5_000_000, expires_at: '2020-01-01', created_at: '2020-01-01' },
    { id: 'buy', bucket: 'purchased', pricing_profile: 'topup', remaining_micros: 160_000, created_at: '2026-01-01' },
  ];
  const plan = allocateSpendByCost(lots, 100_000, Date.parse('2026-08-28'));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.allocations.map((a) => a.lot_id), ['buy']);
  const summary = summarizeLots(lots, Date.parse('2026-08-28'));
  assert.equal(summary.available, 160_000);
  assert.equal(summary.expired, 5_000_000);
});

test('cross-system payer prefers expiring Usage, then leftover credits, then purchased Usage', () => {
  const planLot = { id: 'plan', bucket: 'plan', pricing_profile: 'pro_monthly', remaining_micros: 200_000, expires_at: '2027-01-01', created_at: '2026-01-01' };
  const purchasedLot = { id: 'buy', bucket: 'purchased', pricing_profile: 'topup', remaining_micros: 10_000_000, created_at: '2026-01-01' };

  const expiring = choosePayer({ rawMicros: 45_000, creditCost: 15, creditBalance: 100, lots: [planLot, purchasedLot] });
  assert.equal(expiring.payer, PAYERS.USAGE);

  const credits = choosePayer({ rawMicros: 45_000, creditCost: 15, creditBalance: 15, lots: [purchasedLot] });
  assert.equal(credits.payer, PAYERS.LEGACY_CREDITS);

  const purchased = choosePayer({ rawMicros: 45_000, creditCost: 15, creditBalance: 0, lots: [purchasedLot] });
  assert.equal(purchased.payer, PAYERS.USAGE);

  const broke = choosePayer({ rawMicros: 45_000, creditCost: 15, creditBalance: 3, lots: [] });
  assert.equal(broke.payer, PAYERS.INSUFFICIENT);
});

// ── Included chat through the facade ─────────────────────────────────────────

test('Pro Auto chat quotes $0 Usage even at $0 balance', withStore(async () => {
  const { included, decision } = quoteAndChoosePayer({
    actionType: 'chat_complex',
    planId: 'studio',
    providerCostUsd: 0.03,
    lots: [],
  });
  assert.equal(included, true);
  assert.equal(decision.payer, PAYERS.INCLUDED);
  assert.equal(decision.chargeMicros, 0);

  const auth = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'chat_short',
    planId: 'max',
    providerCostUsd: 0.01,
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.included, true);
  assert.equal((await getUsageBalance(userA)).available, 0);
}));

// ── Reservations and settlement ──────────────────────────────────────────────

test('image generation reserves raw cost and charges the bucket rate', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: centsToMicros(1000) });
  const auth = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'image_gen',
    planId: 'studio',
    creditBalance: 0,
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.quote.rawCostMicros, FIXED_RAW_COST_MICROS.image_gen);
  // Purchased top-up dollars pay at 10/7: 45_000 raw → 64_286 charge.
  assert.equal(auth.reservedChargeMicros, 64_286);
  await auth.reservation.settle({});
  const bal = await getUsageBalance(userA);
  assert.equal(bal.available, centsToMicros(1000) - 64_286);
}));

test('the same image costs less from monthly plan usage than from a top-up', withStore(async () => {
  await grantUsageBalance(userA, {
    amountMicros: centsToMicros(1000),
    bucket: USAGE_BUCKETS.PLAN,
    pricingProfile: 'max_monthly',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const auth = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'image_gen',
    planId: 'max',
    creditBalance: 0,
  });
  assert.equal(auth.ok, true);
  // Max plan dollars pay at 4/3: 45_000 raw → 60_000 charge.
  assert.equal(auth.reservedChargeMicros, 60_000);
  await auth.reservation.settle({});
  assert.equal((await getUsageBalance(userA)).available, centsToMicros(1000) - 60_000);
}));

test('reservation unused remainder is released on partial settle', withStore(async (store) => {
  await store.fund(userA, { amountMicros: 1_000_000 });
  const reserved = await store.reserve(userA, { rawMicros: 100_000, actionType: 'agent_run' });
  assert.equal(reserved.chargeMicros, 142_858);
  const settled = await store.settle(userA, {
    reservationId: reserved.reservationId,
    actualRawMicros: 40_000,
    providerCostMicros: 40_000,
  });
  assert.equal(settled.chargedMicros, 57_143);
  assert.equal(settled.releasedMicros, 85_715);
  assert.equal((await store.getBalance(userA)).available, 1_000_000 - 57_143);
}));

test('abandoned reservation releases safely', withStore(async (store) => {
  await store.fund(userA, { amountMicros: 100_000 });
  const reserved = await store.reserve(userA, { rawMicros: 50_000 });
  await store.release(userA, { reservationId: reserved.reservationId });
  assert.equal((await store.getBalance(userA)).available, 100_000);
}));

test('failed work after reserve releases the reservation', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: 100_000 });
  const auth = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'image_gen',
    planId: 'free',
    creditBalance: 0,
  });
  assert.equal(auth.ok, true);
  await assert.rejects(() => withReservedUsage(auth.reservation, async () => {
    throw new Error('provider_failed');
  }));
  assert.equal((await getUsageBalance(userA)).available, 100_000);
}));

// ── Insufficient balance ─────────────────────────────────────────────────────

test('insufficient balance blocks metered action and does not block included chat', withStore(async () => {
  const image = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'image_gen',
    planId: 'studio',
    creditBalance: 0,
  });
  assert.equal(image.ok, false);
  assert.equal(image.error, 'insufficient_usage_balance');
  assert.match(image.message, /Top up/);
  assert.equal(image.add_funds, true);

  const chat = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'chat_short',
    planId: 'studio',
  });
  assert.equal(chat.ok, true);
  assert.equal(chat.included, true);
}));

// ── Idempotency ──────────────────────────────────────────────────────────────

test('duplicate charge and duplicate funding do not double apply', withStore(async () => {
  await fundUsageBalance(userA, {
    amountMicros: centsToMicros(2000),
    stripeSessionId: 'cs_test_1',
    idempotencyKey: 'funding:cs_test_1',
  });
  const again = await fundUsageBalance(userA, {
    amountMicros: centsToMicros(2000),
    stripeSessionId: 'cs_test_1',
    idempotencyKey: 'funding:cs_test_1',
  });
  assert.equal(again.duplicate, true);
  assert.equal((await getUsageBalance(userA)).available, centsToMicros(2000));

  const first = await recordUsageAfterLog({
    userId: userA,
    actionType: 'image_gen',
    planId: 'studio',
    providerCostUsd: 0.04,
    metadata: { usage_idempotency_key: 'img-1' },
  });
  const second = await recordUsageAfterLog({
    userId: userA,
    actionType: 'image_gen',
    planId: 'studio',
    providerCostUsd: 0.04,
    metadata: { usage_idempotency_key: 'img-1' },
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal((await getUsageBalance(userA)).available, centsToMicros(2000) - 64_286);
}));

test('duplicate Stripe funding webhook does not double fund', withStore(async () => {
  const session = {
    id: 'cs_test_dup',
    amount_total: 2000,
    currency: 'usd',
    payment_status: 'paid',
    client_reference_id: userA,
    metadata: { usage_funding: '1', supabase_user_id: userA },
  };
  const a = await grantUsageFundingFromCheckoutSession(session);
  const b = await grantUsageFundingFromCheckoutSession(session);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal((await getUsageBalance(userA)).available, centsToMicros(2000));
}));

// ── Signup grant ─────────────────────────────────────────────────────────────

test('signup grant is $10 promotional, exactly once, replay-safe', withStore(async () => {
  const first = await ensureSignupGrant(userA);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  const again = await ensureSignupGrant(userA);
  assert.equal(again.duplicate, true);
  const bal = await getUsageBalance(userA);
  assert.equal(bal.available, SIGNUP_GRANT_MICROS);
  assert.equal(bal.promotional, SIGNUP_GRANT_MICROS);
  assert.equal((await getUsageBalance(userB)).available, 0);
}));

// ── Monthly plan funding from invoices ───────────────────────────────────────

function paidInvoice(overrides = {}) {
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  return {
    id: 'in_test_1',
    status: 'paid',
    billing_reason: 'subscription_cycle',
    currency: 'usd',
    amount_paid: 2000,
    total_excluding_tax: 2000,
    subscription: 'sub_1',
    lines: { data: [{ period: { start: Math.floor(Date.now() / 1000), end: periodEnd } }] },
    ...overrides,
  };
}

test('a paid subscription invoice funds plan usage that expires at period end', withStore(async () => {
  const result = await grantPlanUsageFromInvoice({ userId: userA, invoice: paidInvoice(), planId: 'studio' });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  const bal = await getUsageBalance(userA);
  assert.equal(bal.plan, centsToMicros(2000));

  const dup = await grantPlanUsageFromInvoice({ userId: userA, invoice: paidInvoice(), planId: 'studio' });
  assert.equal(dup.duplicate, true);
  assert.equal((await getUsageBalance(userA)).plan, centsToMicros(2000));
}));

test('plan funding classification skips unpaid, $0, foreign-currency, and free invoices', () => {
  assert.equal(classifyPlanFundingInvoice({ invoice: paidInvoice(), planId: 'studio' }).fund, true);
  assert.equal(classifyPlanFundingInvoice({ invoice: paidInvoice({ status: 'open' }), planId: 'studio' }).fund, false);
  assert.equal(classifyPlanFundingInvoice({
    invoice: paidInvoice({ amount_paid: 0, total_excluding_tax: 0 }),
    planId: 'studio',
  }).fund, false);
  assert.equal(classifyPlanFundingInvoice({ invoice: paidInvoice({ currency: 'eur' }), planId: 'studio' }).fund, false);
  assert.equal(classifyPlanFundingInvoice({ invoice: paidInvoice(), planId: 'free' }).fund, false);
});

test('student invoice funds the student amount at the Pro-value profile', () => {
  const decision = classifyPlanFundingInvoice({
    invoice: paidInvoice({ amount_paid: 1500, total_excluding_tax: 1500 }),
    planId: 'student',
  });
  assert.equal(decision.fund, true);
  assert.equal(decision.cents, 1500);
  assert.equal(decision.pricingProfile, 'student_monthly');
});

test('plan usage grant excludes tax from the funded amount', () => {
  const decision = classifyPlanFundingInvoice({
    invoice: paidInvoice({ amount_paid: 2180, total_excluding_tax: 2000 }),
    planId: 'studio',
  });
  assert.equal(decision.cents, 2000);
});

// ── Concurrency and drain semantics ──────────────────────────────────────────

test('simultaneous charges cannot overspend the same balance', withStore(async (store) => {
  await store.fund(userA, { amountMicros: 100_000 });
  const [a, b] = await Promise.all([
    store.charge(userA, { rawMicros: 45_000, actionType: 'image_gen' }),
    store.charge(userA, { rawMicros: 45_000, actionType: 'image_gen' }),
  ]);
  const outcomes = [a, b].sort((x, y) => Number(y.ok) - Number(x.ok));
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[1].ok, false);
  assert.equal((await store.getBalance(userA)).available, 100_000 - 64_286);
}));

test('post-hoc streamed cost drains to exactly $0, never negative', withStore(async (store) => {
  await store.fund(userA, { amountMicros: 50_000 });
  const result = await store.charge(userA, {
    rawMicros: 45_000,
    allowPartial: true,
    actionType: 'chat_long',
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.chargedMicros, 50_000);
  assert.ok(result.shortfallRawMicros > 0);
  assert.equal((await store.getBalance(userA)).available, 0);
}));

test('recordUsageAfterLog charges free-user chat from actual provider cost', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: 1_000_000 });
  const result = await recordUsageAfterLog({
    userId: userA,
    actionType: 'chat_short',
    planId: 'free',
    providerCostUsd: 0.01,
  });
  assert.equal(result.ok, true);
  // 10_000 raw × 10/7 top-up profile = 14_286 charge.
  assert.equal(result.chargedMicros, 14_286);
  assert.equal((await getUsageBalance(userA)).available, 1_000_000 - 14_286);
}));

test('recordUsageAfterLog does not charge included Pro chat', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: centsToMicros(1000) });
  const result = await recordUsageAfterLog({
    userId: userA,
    actionType: 'chat_short',
    planId: 'studio',
    providerCostUsd: 0.009,
  });
  assert.equal(result.skipped, true);
  assert.equal((await getUsageBalance(userA)).available, centsToMicros(1000));
}));

test('recordUsageAfterLog meters premium manual models for paid plans', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: 1_000_000 });
  const premium = await recordUsageAfterLog({
    userId: userA,
    actionType: 'chat_complex',
    planId: 'studio',
    providerCostUsd: 0.05,
    explicitModelOverride: true,
    requestedModel: 'claude-fable-5',
  });
  assert.equal(premium.ok, true);
  // 50_000 raw × 10/7 (paid from purchased balance) = 71_429.
  assert.equal(premium.chargedMicros, 71_429);

  const withinBaseline = await recordUsageAfterLog({
    userId: userA,
    actionType: 'chat_complex',
    planId: 'studio',
    providerCostUsd: 0.05,
    explicitModelOverride: true,
    requestedModel: 'claude-sonnet-5',
  });
  assert.equal(withinBaseline.skipped, true);
  assert.equal(withinBaseline.reason, 'included_chat');
}));

// ── Reversal, history, isolation ─────────────────────────────────────────────

test('refund/reversal restores funds and keeps the original row', withStore(async (store) => {
  await store.fund(userA, { amountMicros: centsToMicros(1000) });
  const charged = await store.charge(userA, { rawMicros: 45_000, actionType: 'image_gen' });
  const reversed = await reverseUsageCharge(userA, { ledgerId: charged.ledgerId });
  assert.equal(reversed.ok, true);
  assert.equal((await getUsageBalance(userA)).available, centsToMicros(1000));
  const history = await store.listLedger(userA, 20);
  assert.ok(history.some((row) => row.txn_type === 'usage_charge'));
  assert.ok(history.some((row) => row.txn_type === 'reversal'));
  assert.ok(history.some((row) => row.id === charged.ledgerId));
}));

test('purchased, promotional, and plan balances stay distinguishable', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: 80_000 });
  await grantUsageBalance(userA, { amountMicros: 20_000, bucket: 'promotional', pricingProfile: 'promotional' });
  await grantUsageBalance(userA, {
    amountMicros: 30_000,
    bucket: 'plan',
    pricingProfile: 'pro_monthly',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const bal = await getUsageBalance(userA);
  assert.equal(bal.purchased, 80_000);
  assert.equal(bal.promotional, 20_000);
  assert.equal(bal.plan, 30_000);
  assert.equal(bal.available, 130_000);
}));

test('unauthorized user cannot read another balance from the store API', withStore(async () => {
  await fundUsageBalance(userA, { amountMicros: centsToMicros(2000) });
  const other = await getUsageBalance(userB);
  assert.equal(other.available, 0);
  const history = await listUsageHistory(userB, 10);
  assert.equal(history.length, 0);
}));

test('history never exposes provider cost or margin fields', withStore(async (store) => {
  await store.fund(userA, { amountMicros: centsToMicros(1000) });
  await store.charge(userA, {
    rawMicros: 45_000,
    providerCostMicros: 45_000,
    actionType: 'image_gen',
  });
  const history = await listUsageHistory(userA, 10);
  const charge = history.find((row) => row.type === 'usage_charge');
  assert.ok(charge);
  // 45_000 raw × 10/7 = 64_286 → $0.06 displayed.
  assert.equal(charge.amount_usd, '$0.06');
  for (const row of history) {
    assert.equal('provider_cost_micros' in row, false);
    assert.equal('providerCost' in row, false);
    assert.equal('pricing_profile' in row, false);
    assert.equal('metadata' in row, false);
  }
}));

// ── Funding validation ───────────────────────────────────────────────────────

test('client cannot choose its own price; funding amount is server-normalized', () => {
  const tooSmall = normalizeUsageFundRequest({ amountCents: 100 });
  assert.equal(tooSmall.ok, false);
  const custom = normalizeUsageFundRequest({ amountCents: 1234 });
  assert.equal(custom.ok, true);
  assert.equal(custom.cents, 1234);
  const spoofedPreset = normalizeUsageFundRequest({ presetCents: 9999 });
  assert.equal(spoofedPreset.ok, false);
});

test('webhook funding rejects client-supplied amount by reading Stripe amount_total', withStore(async () => {
  await assert.rejects(
    () => grantUsageFundingFromCheckoutSession({
      id: 'cs_bad',
      amount_total: 9,
      currency: 'usd',
      payment_status: 'paid',
      metadata: { usage_funding: '1', supabase_user_id: userA },
    }),
    /outside server limits/,
  );
  assert.equal((await getUsageBalance(userA)).available, 0);
}));

// ── Legacy credits coexistence (until migration) ─────────────────────────────

test('leftover credits pay whole actions; Usage never splits with credits', withStore(async () => {
  markTopupPayer(userA, true);
  await fundUsageBalance(userA, { amountMicros: 5_000_000 });
  const auth = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'image_gen',
    planId: 'free',
    creditCost: 15,
    creditBalance: 10,
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.payer, PAYERS.USAGE);
  assert.equal(isTopupPayer(userA), false);
  await auth.reservation.settle({});
  assert.equal((await getUsageBalance(userA)).available, 5_000_000 - 64_286);

  const creditsPay = await authorizeMeteredUsage({
    userId: userA,
    actionType: 'image_gen',
    planId: 'free',
    creditCost: 15,
    creditBalance: 50,
  });
  assert.equal(creditsPay.payer, PAYERS.LEGACY_CREDITS);
  assert.equal(creditsPay.reservation, null);
  assert.equal(isTopupPayer(userA), true);
  const afterCredits = await recordUsageAfterLog({
    userId: userA,
    actionType: 'image_gen',
    planId: 'free',
    providerCostUsd: 0.045,
    creditCost: 15,
  });
  assert.equal(afterCredits.skipped, true);
  assert.equal(afterCredits.reason, 'legacy_credits');
  assert.equal((await getUsageBalance(userA)).available, 5_000_000 - 64_286);
}));

// ── Bucket breakdown for the billing UI ──────────────────────────────────────

test('bucket breakdown: current-period plan grants only, customer dollars only', withStore(async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  // Ended-period plan grant must not inflate the "granted" denominator.
  await grantUsageBalance(userA, {
    amountMicros: 20_000_000,
    bucket: 'plan',
    txnType: 'subscription_grant',
    idempotencyKey: 'grant:old-period',
    metadata: { period_end_unix: nowSec - 3600 },
  });
  await grantUsageBalance(userA, {
    amountMicros: 20_000_000,
    bucket: 'plan',
    txnType: 'subscription_grant',
    idempotencyKey: 'grant:current-period',
    metadata: { period_end_unix: nowSec + 30 * 86_400 },
  });
  await ensureSignupGrant(userA);
  await fundUsageBalance(userA, { amountMicros: centsToMicros(500) });

  const breakdown = await usageBucketBreakdown(userA);

  // Current period plan grant only ($20). Remaining includes the stale lot's
  // value too, so the helper clamps granted up rather than reporting >100%.
  assert.equal(breakdown.plan.granted_micros >= 20_000_000, true);
  assert.equal(breakdown.plan.percent_used >= 0 && breakdown.plan.percent_used <= 100, true);
  assert.equal(breakdown.promotional.granted_micros, 10_000_000);
  assert.equal(breakdown.promotional.used_micros, 0);
  assert.equal(breakdown.promotional.percent_used, 0);
  assert.equal(breakdown.purchased.granted_micros, 5_000_000);
  assert.equal(breakdown.purchased.remaining_usd, '$5.00');

  // Payload is customer-facing only: no profile names, no raw-cost fields.
  const flat = JSON.stringify(breakdown);
  assert.equal(/profile|raw|provider|markup/i.test(flat), false);
}));
