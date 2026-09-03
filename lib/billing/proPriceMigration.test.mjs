import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISIONS,
  PRO_MONTHLY_LEGACY_CENTS,
  PRO_MONTHLY_TARGET_CENTS,
  assertNoImmediateInvoice,
  buildPro20ScheduleUpdate,
  classifyPro20Migration,
  itemTaxRateIds,
  migrationExecutionPlan,
  scheduleTargetsPrice,
  summarizeDecisions,
} from './proPriceMigration.js';

const TARGET = 'price_pro_20';
const LEGACY = 'price_pro_25';
const MAX_PRICE = 'price_max_100';
const STUDENT_PRICE = 'price_student_20';
const ANNUAL = 'price_pro_annual';

function monthlyPrice(id, cents) {
  return {
    id,
    unit_amount: cents,
    currency: 'usd',
    recurring: { interval: 'month', interval_count: 1 },
  };
}

function sub(overrides = {}) {
  const now = 1_700_000_000;
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata: {},
    items: {
      data: [{
        id: 'si_1',
        quantity: 1,
        current_period_start: now,
        current_period_end: now + 30 * 24 * 3600,
        price: monthlyPrice(LEGACY, PRO_MONTHLY_LEGACY_CENTS),
      }],
    },
    ...overrides,
  };
}

test('eligible $25 monthly Pro is applied at next renewal', () => {
  const row = classifyPro20Migration({
    subscription: sub(),
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.APPLY);
  assert.equal(row.currentAmountCents, 2500);
  assert.equal(row.intendedPriceId, TARGET);
});

test('already-$20 subscription is skipped', () => {
  const subscription = sub({
    items: {
      data: [{
        id: 'si_1',
        quantity: 1,
        current_period_end: 1_800_000_000,
        price: monthlyPrice(TARGET, PRO_MONTHLY_TARGET_CENTS),
      }],
    },
  });
  const row = classifyPro20Migration({
    subscription,
    targetPriceId: TARGET,
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.ALREADY_ON_TARGET);
});

test('already scheduled $20 is a no-op', () => {
  const schedule = {
    id: 'sub_sched_1',
    phases: [
      { items: [{ price: LEGACY }] },
      { items: [{ price: TARGET }] },
    ],
  };
  const row = classifyPro20Migration({
    subscription: sub({ schedule: 'sub_sched_1' }),
    schedule,
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.ALREADY_SCHEDULED);
  assert.equal(scheduleTargetsPrice(schedule, TARGET), true);
});

test('Max subscription is skipped', () => {
  const subscription = sub({
    items: {
      data: [{
        id: 'si_1',
        quantity: 1,
        current_period_end: 1_800_000_000,
        price: monthlyPrice(MAX_PRICE, 10000),
      }],
    },
  });
  const row = classifyPro20Migration({
    subscription,
    targetPriceId: TARGET,
    billingPlan: 'max',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'max_plan');
});

test('Student subscription is skipped', () => {
  const subscription = sub({
    items: {
      data: [{
        id: 'si_1',
        quantity: 1,
        current_period_end: 1_800_000_000,
        price: monthlyPrice(STUDENT_PRICE, 2000),
      }],
    },
  });
  const row = classifyPro20Migration({
    subscription,
    targetPriceId: TARGET,
    billingPlan: 'student',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'student_plan');
});

test('canceled-at-period-end is handled conservatively', () => {
  const row = classifyPro20Migration({
    subscription: sub({ cancel_at_period_end: true }),
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'cancel_at_period_end');
});

test('past_due, unpaid, paused, and trialing are skipped', () => {
  for (const status of ['past_due', 'unpaid', 'canceled', 'trialing', 'incomplete']) {
    const row = classifyPro20Migration({
      subscription: sub({ status }),
      targetPriceId: TARGET,
      legacyPriceIds: [LEGACY],
      billingPlan: 'studio',
    });
    assert.equal(row.decision, DECISIONS.SKIP, status);
    assert.equal(row.reason, `status_${status}`);
  }
  const paused = classifyPro20Migration({
    subscription: sub({ pause_collection: { behavior: 'keep_as_draft' } }),
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(paused.reason, 'paused');
});

test('annual subscriptions are not altered', () => {
  const subscription = sub({
    items: {
      data: [{
        id: 'si_1',
        quantity: 1,
        current_period_end: 1_800_000_000,
        price: {
          id: ANNUAL,
          unit_amount: 20400,
          currency: 'usd',
          recurring: { interval: 'year', interval_count: 1 },
        },
      }],
    },
  });
  const row = classifyPro20Migration({
    subscription,
    targetPriceId: TARGET,
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'annual_or_non_monthly');
});

test('discount/coupon is not destroyed; it is reported', () => {
  const row = classifyPro20Migration({
    subscription: sub({ discount: { coupon: 'PROMO' } }),
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'has_discount_or_coupon');
});

test('unrelated existing schedule is reported rather than changed', () => {
  const row = classifyPro20Migration({
    subscription: sub({ schedule: 'sub_sched_other' }),
    schedule: { id: 'sub_sched_other', phases: [{ items: [{ price: 'price_other' }] }] },
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.SKIP);
  assert.equal(row.reason, 'existing_unrelated_schedule');
});

test('schedule update never prorates or resets the billing cycle', () => {
  const params = buildPro20ScheduleUpdate({
    currentPriceId: LEGACY,
    targetPriceId: TARGET,
    quantity: 1,
    currentPhaseStartUnix: 1_700_000_000,
    periodEndUnix: 1_700_000_000 + 30 * 24 * 3600,
  });
  assert.equal(assertNoImmediateInvoice(params), true);
  assert.equal(params.proration_behavior, 'none');
  assert.equal(params.billing_cycle_anchor, undefined);
  assert.equal(params.phases[0].items[0].price, LEGACY);
  assert.equal(params.phases[1].items[0].price, TARGET);
  assert.equal(params.phases[0].end_date, params.phases[1].start_date);
});

test('second classification after schedule is idempotent', () => {
  const first = classifyPro20Migration({
    subscription: sub(),
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(first.decision, DECISIONS.APPLY);
  const second = classifyPro20Migration({
    subscription: sub({ schedule: 'sub_sched_1' }),
    schedule: { phases: [{ items: [{ price: LEGACY }] }, { items: [{ price: TARGET }] }] },
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(second.decision, DECISIONS.ALREADY_SCHEDULED);
  const counts = summarizeDecisions([first, second]);
  assert.equal(counts.apply, 1);
  assert.equal(counts.already_scheduled, 1);
});

test('lykn_pro20_migration schedule targeting $20 is idempotent', () => {
  const row = classifyPro20Migration({
    subscription: sub({ schedule: 'sub_sched_1' }),
    schedule: {
      id: 'sub_sched_1',
      metadata: { lykn_pro20_migration: 'scheduled' },
      phases: [{ items: [{ price: LEGACY }] }, { items: [{ price: TARGET }] }],
    },
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  assert.equal(row.decision, DECISIONS.ALREADY_SCHEDULED);
});

test('schedule update copies item tax rates and still does not prorate', () => {
  const params = buildPro20ScheduleUpdate({
    currentPriceId: LEGACY,
    targetPriceId: TARGET,
    quantity: 1,
    currentPhaseStartUnix: 1_700_000_000,
    periodEndUnix: 1_700_000_000 + 30 * 24 * 3600,
    taxRateIds: ['txr_1'],
  });
  assert.equal(assertNoImmediateInvoice(params), true);
  assert.deepEqual(params.phases[0].items[0].tax_rates, ['txr_1']);
  assert.deepEqual(params.phases[1].items[0].tax_rates, ['txr_1']);
  assert.deepEqual(itemTaxRateIds({ tax_rates: [{ id: 'txr_1' }] }), ['txr_1']);
});

test('dry run makes no Stripe mutations', () => {
  const eligible = classifyPro20Migration({
    subscription: sub(),
    targetPriceId: TARGET,
    legacyPriceIds: [LEGACY],
    billingPlan: 'studio',
  });
  const dry = migrationExecutionPlan([eligible], { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.eligibleCount, 1);
  assert.deepEqual(dry.mutations, []);
  const live = migrationExecutionPlan([eligible], { dryRun: false });
  assert.equal(live.mutations.length, 1);
});
