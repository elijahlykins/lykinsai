/**
 * Monthly plan usage funding.
 *
 * A successfully PAID Stripe subscription invoice creates exactly one plan
 * usage grant: the invoice amount (excluding tax) becomes plan-bucket usage
 * that expires at the end of the paid billing period.
 *
 * Deriving the grant from the invoice amount makes student pricing,
 * legitimate Stripe discounts, prorations, and upgrades come out right
 * without plan-specific arithmetic.
 *
 * Idempotent on the Stripe invoice id — webhook replay, server restart,
 * and reconciliation can never double-grant. Never grant from a Checkout
 * redirect; only from the paid invoice.
 */

import { logBillingEvent } from './billingEvents.js';
import { centsToMicros } from './money.js';
import {
  getPlan,
  isPaidPlan,
  planGrantIdempotencyKey,
  planPricingProfile,
  resolvePlanId,
} from './planCatalog.js';
import { grantUsageBalance } from './usageBalance.js';
import { TXN_TYPES, USAGE_BUCKETS } from './usageSpend.js';

const QUALIFYING_BILLING_REASONS = new Set([
  'subscription_create',
  'subscription_cycle',
  'subscription_update',
  'subscription_threshold',
]);

/** Hard sanity ceiling for a single plan grant. */
const MAX_PLAN_GRANT_CENTS = 100_000;

function invoicePeriodEnd(invoice) {
  let end = 0;
  for (const line of invoice?.lines?.data || []) {
    const lineEnd = Number(line?.period?.end || 0);
    if (Number.isFinite(lineEnd) && lineEnd > end) end = lineEnd;
  }
  if (end > 0) return end;
  const topLevel = Number(invoice?.period_end || 0);
  return Number.isFinite(topLevel) && topLevel > 0 ? topLevel : null;
}

function invoicePeriodStart(invoice) {
  let start = Number.POSITIVE_INFINITY;
  for (const line of invoice?.lines?.data || []) {
    const lineStart = Number(line?.period?.start || 0);
    if (Number.isFinite(lineStart) && lineStart > 0 && lineStart < start) start = lineStart;
  }
  if (Number.isFinite(start) && start !== Number.POSITIVE_INFINITY) return start;
  const topLevel = Number(invoice?.period_start || 0);
  return Number.isFinite(topLevel) && topLevel > 0 ? topLevel : null;
}

/**
 * Classify whether a Stripe invoice funds monthly plan usage, and how much.
 * Pure — no network, no side effects. Conservative skips.
 */
export function classifyPlanFundingInvoice({ invoice, planId } = {}) {
  const invoiceId = invoice?.id || null;
  if (!invoiceId) return { fund: false, reason: 'missing_invoice' };

  const plan = resolvePlanId(planId);
  if (!isPaidPlan(plan)) return { fund: false, reason: 'not_a_paid_plan', invoiceId };

  const status = String(invoice.status || '');
  if (status !== 'paid') return { fund: false, reason: `status_${status || 'unknown'}`, invoiceId };

  const billingReason = String(invoice.billing_reason || '');
  if (billingReason && !QUALIFYING_BILLING_REASONS.has(billingReason)) {
    return { fund: false, reason: `billing_reason_${billingReason}`, invoiceId };
  }

  const currency = String(invoice.currency || 'usd').toLowerCase();
  if (currency !== 'usd') return { fund: false, reason: `currency_${currency}`, invoiceId };

  // Excluding tax where Stripe reports it; the paid amount otherwise.
  const exTax = Number(invoice.total_excluding_tax);
  const paid = Number(invoice.amount_paid);
  const cents = Number.isInteger(exTax) && exTax > 0
    ? Math.min(exTax, Number.isInteger(paid) && paid > 0 ? paid : exTax)
    : paid;
  if (!Number.isInteger(cents) || cents <= 0) {
    return { fund: false, reason: 'zero_amount', invoiceId };
  }
  if (cents > MAX_PLAN_GRANT_CENTS) {
    return { fund: false, reason: 'amount_exceeds_ceiling', invoiceId, cents };
  }

  const periodEndUnix = invoicePeriodEnd(invoice);
  if (!periodEndUnix || periodEndUnix * 1000 <= Date.now()) {
    return { fund: false, reason: 'period_already_ended', invoiceId };
  }

  return {
    fund: true,
    invoiceId,
    planId: plan,
    cents,
    amountMicros: centsToMicros(cents),
    pricingProfile: planPricingProfile(plan),
    periodStartUnix: invoicePeriodStart(invoice),
    periodEndUnix,
    expiresAt: new Date(periodEndUnix * 1000).toISOString(),
    subscriptionId: typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id
        || invoice.parent?.subscription_details?.subscription
        || null,
  };
}

/**
 * Grant monthly plan usage from a paid invoice. Idempotent on invoice id.
 */
export async function grantPlanUsageFromInvoice({ userId, invoice, planId } = {}) {
  if (!userId) return { ok: false, error: 'missing_user' };

  const decision = classifyPlanFundingInvoice({ invoice, planId });
  if (!decision.fund) {
    logBillingEvent('plan_funding_skipped', {
      userId,
      invoiceId: decision.invoiceId,
      reason: decision.reason,
    });
    return { ok: true, skipped: true, reason: decision.reason };
  }

  const result = await grantUsageBalance(userId, {
    amountMicros: decision.amountMicros,
    bucket: USAGE_BUCKETS.PLAN,
    pricingProfile: decision.pricingProfile,
    txnType: TXN_TYPES.SUBSCRIPTION_GRANT,
    expiresAt: decision.expiresAt,
    idempotencyKey: planGrantIdempotencyKey(decision.invoiceId),
    metadata: {
      stripe_invoice_id: decision.invoiceId,
      stripe_subscription_id: decision.subscriptionId,
      plan: decision.planId,
      plan_label: getPlan(decision.planId).label,
      period_start_unix: decision.periodStartUnix,
      period_end_unix: decision.periodEndUnix,
    },
  });

  logBillingEvent(result?.duplicate ? 'plan_funding_duplicate' : 'plan_funding_granted', {
    userId,
    invoiceId: decision.invoiceId,
    plan: decision.planId,
    cents: decision.cents,
  });
  return result;
}
