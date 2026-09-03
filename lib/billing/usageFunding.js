/**
 * Usage Balance funding.
 *
 * The client may pick a preset or a custom dollar amount.
 * The server is the only authority for the Stripe charge amount.
 * The webhook grants from session.amount_total, never from metadata.
 */

import { logBillingEvent } from './billingEvents.js';
import { centsToMicros, formatUsd } from './money.js';
import { USAGE_FUNDING } from './usagePricing.js';
import { fundUsageBalance } from './usageBalance.js';

export function normalizeUsageFundRequest(body = {}) {
  const presetCents = Number(body.presetCents);
  const amountCents = Number(body.amountCents);

  let cents = null;
  if (Number.isInteger(presetCents) && USAGE_FUNDING.presetsCents.includes(presetCents)) {
    cents = presetCents;
  } else if (Number.isInteger(amountCents)) {
    cents = amountCents;
  }

  if (!Number.isInteger(cents)) {
    return { ok: false, error: 'invalid_amount', message: 'Choose a funding amount.' };
  }
  if (cents < USAGE_FUNDING.minCents) {
    return {
      ok: false,
      error: 'amount_too_small',
      message: `Minimum add-funds amount is ${formatUsd(centsToMicros(USAGE_FUNDING.minCents))}.`,
    };
  }
  if (cents > USAGE_FUNDING.maxCents) {
    return {
      ok: false,
      error: 'amount_too_large',
      message: `Maximum add-funds amount is ${formatUsd(centsToMicros(USAGE_FUNDING.maxCents))}.`,
    };
  }

  return {
    ok: true,
    cents,
    micros: centsToMicros(cents),
    currency: USAGE_FUNDING.currency,
    display: formatUsd(centsToMicros(cents)),
  };
}

export function usageFundingPresets() {
  return USAGE_FUNDING.presetsCents.map((cents) => ({
    cents,
    micros: centsToMicros(cents),
    usd: formatUsd(centsToMicros(cents)),
  }));
}

/**
 * Grant purchased Usage from a verified Checkout session.
 * Amount comes from Stripe `amount_total` (cents), not the client.
 */
export async function grantUsageFundingFromCheckoutSession(session) {
  if (String(session?.metadata?.usage_funding || '') !== '1') return null;

  const paymentStatus = session.payment_status;
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    logBillingEvent('usage_funding_failed', {
      sessionId: session.id,
      error: `payment_status_${paymentStatus}`,
    });
    return null;
  }

  const userId = String(
    session.client_reference_id || session.metadata?.supabase_user_id || '',
  ).trim();
  if (!userId) throw new Error(`usage funding session ${session.id} carries no user reference`);

  const amountCents = Number(session.amount_total);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`usage funding session ${session.id} has no authoritative amount_total`);
  }
  if (amountCents < USAGE_FUNDING.minCents || amountCents > USAGE_FUNDING.maxCents) {
    throw new Error(`usage funding session ${session.id} amount ${amountCents} is outside server limits`);
  }

  const currency = String(session.currency || 'usd').toLowerCase();
  if (currency !== 'usd') {
    throw new Error(`usage funding session ${session.id} used unsupported currency ${currency}`);
  }

  const result = await fundUsageBalance(userId, {
    amountMicros: centsToMicros(amountCents),
    stripeSessionId: session.id,
    idempotencyKey: `funding:${session.id}`,
    metadata: {
      stripe_amount_cents: amountCents,
      currency,
    },
  });

  if (result?.duplicate) {
    logBillingEvent('usage_funding_duplicate', {
      userId,
      sessionId: session.id,
      amountCents,
    });
  } else {
    logBillingEvent('usage_funding_granted', {
      userId,
      sessionId: session.id,
      amountCents,
    });
  }
  return result;
}

export function isUsageFundingSession(session) {
  return String(session?.metadata?.usage_funding || '') === '1';
}

export function classifyCheckoutPaymentSession(session) {
  if (isUsageFundingSession(session)) return 'usage_funding';
  if (String(session?.metadata?.topup_pack || '').trim()) return 'credit_pack';
  if (session?.mode === 'subscription') return 'subscription';
  return 'unknown';
}
