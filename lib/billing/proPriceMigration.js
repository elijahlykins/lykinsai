/**
 * Next-renewal Pro $25 → $20 migration.
 *
 * Stripe docs (Change the price of existing subscriptions):
 * when the change should take effect at the end of the current period,
 * use a Subscription Schedule. Immediate `subscriptions.update` without
 * `proration_behavior: 'none'` would prorate. `billing_cycle_anchor: 'now'`
 * would reset the cycle and invoice immediately. This module does neither.
 *
 * Official sequence:
 * 1. Create a schedule from the existing subscription (`from_subscription`).
 * 2. Update that schedule with two phases:
 *    - current $25 price until current_period_end
 *    - $20 price starting at current_period_end
 *    and `proration_behavior: 'none'` on the request and both phases.
 *
 * This file only classifies and builds Stripe parameters.
 * The CLI decides whether to call Stripe.
 */

export const PRO_MONTHLY_LEGACY_CENTS = 2500;
export const PRO_MONTHLY_TARGET_CENTS = 2000;
export const MAX_MONTHLY_CENTS = 10000;
export const STUDENT_MONTHLY_CENTS = 1500;
export const PRO_ANNUAL_DISPLAY_CENTS = 20400;

export const MIGRATION_META_KEY = 'lykn_pro20_migration';
export const MIGRATION_META_SCHEDULED = 'scheduled';

export const DECISIONS = Object.freeze({
  APPLY: 'apply',
  ALREADY_ON_TARGET: 'already_on_target',
  ALREADY_SCHEDULED: 'already_scheduled',
  SKIP: 'skip',
});

const PRO_PLAN_IDS = new Set(['studio', 'studio_pro']);
const MAX_PLAN_IDS = new Set(['max', 'studio_max']);
const STUDENT_PLAN_IDS = new Set(['student']);

export function subscriptionPeriodEndUnix(subscription) {
  const items = subscription?.items?.data || [];
  let maxItemEnd = 0;
  for (const item of items) {
    const end = Number(item?.current_period_end || 0);
    if (Number.isFinite(end) && end > maxItemEnd) maxItemEnd = end;
  }
  if (maxItemEnd > 0) return maxItemEnd;
  const topLevel = Number(subscription?.current_period_end || 0);
  return Number.isFinite(topLevel) && topLevel > 0 ? topLevel : null;
}

function priceObject(item) {
  const price = item?.price;
  if (!price || typeof price === 'string') return null;
  return price;
}

export function primarySubscriptionItem(subscription) {
  const items = subscription?.items?.data || [];
  return items[0] || null;
}

export function hasDiscount(subscription) {
  if (subscription?.discount) return true;
  if (Array.isArray(subscription?.discounts) && subscription.discounts.length > 0) return true;
  return false;
}

export function scheduleTargetsPrice(schedule, priceId) {
  const phases = schedule?.phases || [];
  if (!priceId || phases.length < 2) return false;
  const last = phases[phases.length - 1];
  const items = last?.items || [];
  return items.some((item) => {
    const id = typeof item.price === 'string' ? item.price : item.price?.id;
    return id === priceId;
  });
}

/**
 * Classify one Stripe subscription. No network. Conservative skips.
 */
export function classifyPro20Migration({
  subscription,
  schedule = null,
  targetPriceId,
  legacyPriceIds = [],
  billingPlan = null,
} = {}) {
  const subId = subscription?.id || null;
  const customerId = typeof subscription?.customer === 'string'
    ? subscription.customer
    : subscription?.customer?.id || null;
  const item = primarySubscriptionItem(subscription);
  const price = priceObject(item);
  const currentPriceId = price?.id || (typeof item?.price === 'string' ? item.price : null);
  const amount = Number(price?.unit_amount);
  const interval = price?.recurring?.interval || null;
  const intervalCount = Number(price?.recurring?.interval_count || 1);
  const currency = String(price?.currency || '').toLowerCase();
  const periodEnd = subscriptionPeriodEndUnix(subscription);
  const status = String(subscription?.status || '');
  const quantity = Number(item?.quantity || 1);
  const itemCount = subscription?.items?.data?.length || 0;
  const cancelAtPeriodEnd = Boolean(subscription?.cancel_at_period_end);
  const pauseCollection = Boolean(subscription?.pause_collection);
  const scheduleId = typeof subscription?.schedule === 'string'
    ? subscription.schedule
    : subscription?.schedule?.id || schedule?.id || null;

  const base = {
    subscriptionId: subId,
    customerId,
    currentPriceId,
    currentAmountCents: Number.isFinite(amount) ? amount : null,
    interval,
    intervalCount,
    periodEndUnix: periodEnd,
    periodEndIso: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    status,
    billingPlan,
    intendedPriceId: targetPriceId || null,
    scheduleId,
    itemId: item?.id || null,
    quantity,
  };

  function skip(reason) {
    return { ...base, decision: DECISIONS.SKIP, reason };
  }

  if (!targetPriceId) return skip('missing_target_price');
  if (!subscription) return skip('missing_subscription');
  if (!customerId) return skip('missing_customer');
  if (!item?.id) return skip('missing_subscription_item');
  if (!currentPriceId) return skip('missing_current_price');
  if (itemCount !== 1) return skip('multiple_subscription_items');
  if (quantity !== 1) return skip('non_default_quantity');
  if (currency && currency !== 'usd') return skip('non_usd');

  if (MAX_PLAN_IDS.has(String(billingPlan || ''))) return skip('max_plan');
  if (STUDENT_PLAN_IDS.has(String(billingPlan || ''))) return skip('student_plan');
  if (Number.isFinite(amount) && amount === MAX_MONTHLY_CENTS) return skip('max_amount');

  if (interval === 'year' || intervalCount !== 1) return skip('annual_or_non_monthly');
  if (interval && interval !== 'month') return skip('non_monthly');

  if (currentPriceId === targetPriceId || amount === PRO_MONTHLY_TARGET_CENTS) {
    return { ...base, decision: DECISIONS.ALREADY_ON_TARGET, reason: 'already_on_20' };
  }

  if (schedule && scheduleTargetsPrice(schedule, targetPriceId)) {
    return { ...base, decision: DECISIONS.ALREADY_SCHEDULED, reason: 'schedule_already_targets_20' };
  }
  if (subscription?.metadata?.[MIGRATION_META_KEY] === MIGRATION_META_SCHEDULED
    && schedule
    && scheduleTargetsPrice(schedule, targetPriceId)) {
    return { ...base, decision: DECISIONS.ALREADY_SCHEDULED, reason: 'metadata_already_scheduled' };
  }
  if (scheduleId && schedule && !scheduleTargetsPrice(schedule, targetPriceId)) {
    return skip('existing_unrelated_schedule');
  }
  if (scheduleId && !schedule) {
    return skip('schedule_present_but_unread');
  }

  if (status !== 'active') return skip(`status_${status || 'unknown'}`);
  if (cancelAtPeriodEnd) return skip('cancel_at_period_end');
  if (pauseCollection) return skip('paused');
  if (hasDiscount(subscription)) return skip('has_discount_or_coupon');
  if (!periodEnd) return skip('missing_period_end');

  const knownLegacy = new Set((legacyPriceIds || []).filter(Boolean));
  const looksLikeLegacy25 = amount === PRO_MONTHLY_LEGACY_CENTS && interval === 'month';
  const mappedPro = !billingPlan || PRO_PLAN_IDS.has(String(billingPlan));
  const priceIsKnownLegacy = knownLegacy.has(currentPriceId);

  if (!looksLikeLegacy25 && !priceIsKnownLegacy) {
    return skip('not_25_monthly_pro');
  }
  if (looksLikeLegacy25 && billingPlan && !mappedPro) {
    return skip('amount_matches_but_plan_not_pro');
  }
  if (!looksLikeLegacy25 && priceIsKnownLegacy && !mappedPro && billingPlan) {
    return skip('legacy_price_on_non_pro_plan');
  }

  return {
    ...base,
    decision: DECISIONS.APPLY,
    reason: 'eligible_25_monthly_pro',
  };
}

/**
 * Parameters for `subscriptionSchedules.update`.
 * Request-level and phase-level proration_behavior are both `none`.
 * Does not set billing_cycle_anchor.
 */
export function itemTaxRateIds(item) {
  const rates = item?.tax_rates || item?.price?.tax_rates || [];
  return (Array.isArray(rates) ? rates : [])
    .map((rate) => (typeof rate === 'string' ? rate : rate?.id))
    .filter(Boolean);
}

export function buildPro20ScheduleUpdate({
  currentPriceId,
  targetPriceId,
  quantity = 1,
  currentPhaseStartUnix,
  periodEndUnix,
  taxRateIds = [],
} = {}) {
  if (!currentPriceId || !targetPriceId || !periodEndUnix || !currentPhaseStartUnix) {
    throw new Error('buildPro20ScheduleUpdate: missing required fields');
  }
  if (currentPhaseStartUnix >= periodEndUnix) {
    throw new Error('buildPro20ScheduleUpdate: current phase start must be before period end');
  }
  return {
    proration_behavior: 'none',
    end_behavior: 'release',
    metadata: {
      [MIGRATION_META_KEY]: MIGRATION_META_SCHEDULED,
    },
    phases: [
      {
        start_date: currentPhaseStartUnix,
        end_date: periodEndUnix,
        proration_behavior: 'none',
        items: [{
          price: currentPriceId,
          quantity,
          ...(taxRateIds.length ? { tax_rates: taxRateIds } : {}),
        }],
      },
      {
        start_date: periodEndUnix,
        proration_behavior: 'none',
        items: [{
          price: targetPriceId,
          quantity,
          ...(taxRateIds.length ? { tax_rates: taxRateIds } : {}),
        }],
      },
    ],
  };
}

export function assertNoImmediateInvoice(params) {
  if (params.proration_behavior !== 'none') {
    throw new Error('migration must set proration_behavior=none');
  }
  if (params.billing_cycle_anchor) {
    throw new Error('migration must not set billing_cycle_anchor');
  }
  if (params.trial_end) {
    throw new Error('migration must not set trial_end');
  }
  for (const phase of params.phases || []) {
    if (phase.proration_behavior !== 'none') {
      throw new Error('each phase must set proration_behavior=none');
    }
  }
  return true;
}

export function summarizeDecisions(rows) {
  const counts = {
    apply: 0,
    already_on_target: 0,
    already_scheduled: 0,
    skip: 0,
  };
  for (const row of rows) {
    if (row.decision === DECISIONS.APPLY) counts.apply += 1;
    else if (row.decision === DECISIONS.ALREADY_ON_TARGET) counts.already_on_target += 1;
    else if (row.decision === DECISIONS.ALREADY_SCHEDULED) counts.already_scheduled += 1;
    else counts.skip += 1;
  }
  return counts;
}

export function migrationExecutionPlan(rows, { dryRun = true } = {}) {
  const eligible = (rows || []).filter((row) => row.decision === DECISIONS.APPLY);
  return {
    dryRun: Boolean(dryRun),
    mutations: dryRun ? [] : eligible,
    eligibleCount: eligible.length,
  };
}
