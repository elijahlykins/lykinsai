/**
 * Usage Balance facade — the one authoritative billing layer.
 *
 * Provider cost, customer charge, and the customer balance stay separate.
 * Authoritative writes go through the ledger store (SQL in production,
 * in-memory in tests).
 *
 * API surface (conceptual):
 *   getUsageBalance / listUsageHistory
 *   ensureSignupGrant            — one-time $10 promotional usage
 *   authorizeMeteredUsage        — preflight + reservation
 *   recordUsageAfterLog          — post-hoc settlement for streamed work
 *   fundUsageBalance             — purchased top-ups (Stripe-authoritative)
 *   grantUsageBalance            — promotional / plan grants
 *   reverseUsageCharge           — refunds/reversals
 */

import { getCreditWallet, isTopupPayer, markTopupPayer } from './creditWallet.js';
import { logBillingEvent } from './billingEvents.js';
import { formatUsd, roundProviderCostMicros } from './money.js';
import { chargeForRawMicros } from './pricingProfiles.js';
import { quoteUsageCharge } from './usagePricing.js';
import { isIncludedSubscriptionUsage } from './usageEntitlements.js';
import {
  SIGNUP_GRANT_MICROS,
  SIGNUP_GRANT_TXN,
  signupGrantIdempotencyKey,
} from './planCatalog.js';
import {
  PAYERS,
  USAGE_BUCKETS,
  insufficientPayload,
  quoteAndChoosePayer,
} from './usageSpend.js';
import { sqlUsageStore } from './usageLedger.js';

let activeStore = sqlUsageStore;

export function setUsageBalanceStore(store) {
  activeStore = store || sqlUsageStore;
  signupGrantSeen.clear();
}

export function getUsageBalanceStore() {
  return activeStore;
}

export async function getUsageBalance(userId) {
  return activeStore.getBalance(userId);
}

export async function listUsageHistory(userId, limit = 20) {
  const rows = await activeStore.listLedger(userId, limit);
  return rows
    .filter((row) => {
      const type = row.txn_type || row.type;
      return type !== 'reservation' && type !== 'reservation_settle';
    })
    .map((row) => customerHistoryRow(row));
}

function customerHistoryRow(row) {
  const type = row.txn_type || row.type;
  const direction = row.direction;
  const amount = Number(row.customer_charge_micros || row.amount_micros || 0);
  const signed = direction === 'credit' ? amount : -amount;
  return {
    id: row.id,
    type,
    action: row.action_type || type,
    amount_micros: signed,
    amount_usd: formatUsd(Math.abs(signed)),
    signed_usd: `${signed < 0 ? '-' : '+'}${formatUsd(Math.abs(signed)).slice(1)}`,
    created_at: row.created_at,
  };
}

export async function fundUsageBalance(userId, args) {
  return activeStore.fund(userId, args);
}

export async function grantUsageBalance(userId, args) {
  return activeStore.grant(userId, args);
}

export async function reverseUsageCharge(userId, args) {
  return activeStore.reverse(userId, args);
}

// ── Signup promotional grant ────────────────────────────────────────────────
// Every account receives $10 of promotional usage exactly once. Idempotent
// on the ledger idempotency key, so OAuth reconnects, webhook replays, and
// onboarding retries can never grant twice. The in-process set only avoids
// repeat RPC round-trips.
const signupGrantSeen = new Set();
const SIGNUP_GRANT_SEEN_MAX = 20_000;

export async function ensureSignupGrant(userId) {
  if (!userId) return { ok: false, error: 'unauthenticated' };
  if (signupGrantSeen.has(userId)) return { ok: true, duplicate: true, cached: true };
  const result = await activeStore.grant(userId, {
    amountMicros: SIGNUP_GRANT_MICROS,
    bucket: USAGE_BUCKETS.PROMOTIONAL,
    pricingProfile: 'promotional',
    txnType: SIGNUP_GRANT_TXN,
    expiresAt: null,
    idempotencyKey: signupGrantIdempotencyKey(userId),
    metadata: { reason: 'signup' },
  });
  if (result?.ok) {
    if (signupGrantSeen.size >= SIGNUP_GRANT_SEEN_MAX) signupGrantSeen.clear();
    signupGrantSeen.add(userId);
    if (!result.duplicate) {
      logBillingEvent('signup_grant', { userId, amountMicros: SIGNUP_GRANT_MICROS });
    }
  }
  return result;
}

export async function withReservedUsage(reservation, work) {
  if (!reservation) return work({ settle: async () => ({ ok: true, skipped: true }) });
  let settled = false;
  try {
    return await work({
      settle: async (extra = {}) => {
        const result = await reservation.settle(extra);
        if (result?.ok) settled = true;
        return result;
      },
    });
  } finally {
    if (!settled) {
      await reservation.release().catch(() => {});
      logBillingEvent('usage_reservation_released_on_exit', {
        reservationId: reservation.id,
      });
    }
  }
}

function reservationHandle(userId, reservationId) {
  if (!reservationId) return null;
  return {
    id: reservationId,
    settle: async (extra = {}) => {
      const result = await activeStore.settle(userId, { reservationId, ...extra });
      if (!result?.ok) {
        logBillingEvent('usage_settlement_failed', {
          userId,
          reservationId,
          error: result?.error || 'unknown',
        });
      }
      return result;
    },
    release: async () => {
      const result = await activeStore.release(userId, { reservationId });
      if (!result?.ok) {
        logBillingEvent('usage_reservation_release_failed', {
          userId,
          reservationId,
          error: result?.error || 'unknown',
        });
      }
      return result;
    },
  };
}

const LEGACY_CREDIT_COSTS = Object.freeze({
  image_gen: 15,
  image_edit: 10,
  video: 35,
  transcription: 5,
  tts: 3,
  file_large: 15,
  file_small: 5,
});

export async function authorizeImageUsage(userId, planId = 'free', actionType = 'image_gen') {
  const wallet = await getCreditWallet(userId);
  return authorizeMeteredUsage({
    userId,
    planId,
    actionType,
    creditCost: LEGACY_CREDIT_COSTS[actionType] || 0,
    creditBalance: wallet?.balance || 0,
  });
}

async function loadLots(userId) {
  if (typeof activeStore.listLots === 'function') {
    return activeStore.listLots(userId);
  }
  return [];
}

export async function authorizeMeteredUsage({
  userId,
  actionType,
  planId = 'free',
  usageKind,
  autonomous = false,
  explicitModelOverride = false,
  requestedModel = null,
  providerCostUsd = 0,
  providerCostMicros = null,
  creditCost = 0,
  creditBalance = 0,
  idempotencyKey = null,
  metadata = {},
} = {}) {
  if (!userId) {
    return { ok: false, error: 'unauthenticated' };
  }

  const lots = await loadLots(userId);
  const { included, quote, decision } = quoteAndChoosePayer({
    actionType,
    planId,
    usageKind,
    autonomous,
    explicitModelOverride,
    requestedModel,
    providerCostUsd,
    providerCostMicros,
    creditCost,
    creditBalance,
    lots,
  });

  if (included || decision.payer === PAYERS.INCLUDED) {
    markTopupPayer(userId, false);
    return {
      ok: true,
      included: true,
      payer: PAYERS.INCLUDED,
      quote,
      reservation: null,
    };
  }

  if (decision.payer === PAYERS.LEGACY_CREDITS) {
    markTopupPayer(userId, true);
    logBillingEvent('legacy_credit_payer', {
      userId,
      actionType,
      creditCost: decision.creditCost || creditCost,
    });
    return {
      ok: true,
      included: false,
      payer: PAYERS.LEGACY_CREDITS,
      quote,
      reservation: null,
    };
  }

  if (decision.payer === PAYERS.INSUFFICIENT) {
    markTopupPayer(userId, false);
    const balance = await activeStore.getBalance(userId);
    logBillingEvent('usage_insufficient', {
      userId,
      actionType,
      availableMicros: balance.available,
      rawCostMicros: quote.rawCostMicros,
    });
    // Price the shortfall at the top-up profile: the payload's "required"
    // amount is what a top-up must cover, a customer-facing dollar figure.
    // Raw provider cost never leaves the server.
    return insufficientPayload({
      availableMicros: balance.available,
      requiredMicros: decision.chargeMicros
        + chargeForRawMicros(decision.shortfallRawMicros || 0, 'topup'),
    });
  }

  markTopupPayer(userId, false);
  logBillingEvent('usage_payer', {
    userId,
    actionType,
    rawCostMicros: quote.rawCostMicros,
  });

  const reserved = await activeStore.reserve(userId, {
    rawMicros: quote.rawCostMicros,
    actionType,
    pricingVersion: quote.pricingVersion,
    idempotencyKey,
    metadata: {
      ...metadata,
      provider_cost_micros: quote.providerCostMicros,
    },
  });

  if (!reserved?.ok) {
    logBillingEvent('usage_reservation_failed', {
      userId,
      actionType,
      error: reserved?.error || 'unknown',
      rawCostMicros: quote.rawCostMicros,
    });
    // Never return the store's error object directly: the SQL payload names
    // raw provider micros. Re-shape into the customer-facing payload with the
    // requirement priced at the top-up profile.
    const availableMicros = Number.isFinite(Number(reserved?.available_micros))
      ? Number(reserved.available_micros)
      : (await activeStore.getBalance(userId)).available;
    return insufficientPayload({
      availableMicros,
      requiredMicros: chargeForRawMicros(quote.rawCostMicros, 'topup'),
    });
  }

  return {
    ok: true,
    included: false,
    payer: PAYERS.USAGE,
    quote,
    reservedChargeMicros: reserved.chargeMicros,
    reservation: reservationHandle(userId, reserved.reservationId),
  };
}

/**
 * After a successful AI action. Skips if the action was included or already
 * reserved/settled. Idempotent on metadata.usage_idempotency_key.
 *
 * Charges the actual raw provider cost, draining whatever balance remains
 * if it cannot be covered in full — the balance can reach $0 but never goes
 * negative, and the gate blocks the next request.
 */
export async function recordUsageAfterLog({
  userId,
  actionType,
  planId = 'free',
  usageKind,
  autonomous = false,
  explicitModelOverride = false,
  requestedModel = null,
  model = null,
  provider = null,
  providerCostUsd = 0,
  providerCostMicros = null,
  creditCost = 0,
  usageLogId = null,
  metadata = {},
} = {}) {
  if (!userId) return { ok: true, skipped: true, reason: 'no_user' };

  if (metadata?.usage_reservation_id) {
    return { ok: true, skipped: true, reason: 'already_reserved' };
  }

  if (isTopupPayer(userId)) {
    return { ok: true, skipped: true, reason: 'legacy_credits' };
  }

  const included = isIncludedSubscriptionUsage({
    actionType,
    planId,
    usageKind: usageKind || metadata?.usage_kind,
    autonomous: autonomous || metadata?.autonomous,
    explicitModelOverride: explicitModelOverride || metadata?.explicit_model_override,
    requestedModel: requestedModel || metadata?.requested_model,
  });
  if (included) {
    return { ok: true, skipped: true, reason: 'included_chat', chargedMicros: 0 };
  }

  const quote = quoteUsageCharge({ actionType, providerCostUsd, providerCostMicros });
  if (!quote.rawCostMicros) {
    return { ok: true, skipped: true, reason: 'zero_charge' };
  }

  const idempotencyKey = metadata?.usage_idempotency_key
    || (usageLogId ? `usage-log:${usageLogId}` : null);

  return activeStore.charge(userId, {
    rawMicros: quote.rawCostMicros,
    allowPartial: true,
    providerCostMicros: quote.providerCostMicros || roundProviderCostMicros(providerCostUsd || 0),
    pricingVersion: quote.pricingVersion,
    actionType,
    model,
    provider,
    runId: metadata?.run_id || null,
    idempotencyKey,
    metadata: {
      usage_log_id: usageLogId,
      credit_cost: creditCost,
    },
  });
}

export async function monthUsageSpent(userId, rows) {
  let spent = 0;
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  for (const row of rows || []) {
    const type = row.txn_type || row.type;
    if (type !== 'usage_charge') continue;
    const at = new Date(row.created_at).getTime();
    if (Number.isFinite(at) && at >= startMs) {
      spent += Math.abs(Number(row.customer_charge_micros || row.amount_micros || 0));
    }
  }
  return {
    spentMicros: spent,
    spentUsd: formatUsd(spent),
  };
}

/**
 * Per-bucket granted/used/remaining for the billing UI's progress bars.
 * All values are customer dollars; nothing here names profiles or raw cost.
 *
 * - plan: grants for the CURRENT billing period only (metadata carries
 *   period_end_unix; grants for ended periods are excluded).
 * - promotional: active promotional grants (expired promo value excluded so
 *   the bar never shows phantom headroom).
 * - purchased: lifetime top-ups — the bar reads "used of everything added".
 */
export async function usageBucketBreakdown(userId, balance = null) {
  const [resolvedBalance, grants] = await Promise.all([
    balance ? Promise.resolve(balance) : activeStore.getBalance(userId),
    typeof activeStore.listGrants === 'function' ? activeStore.listGrants(userId) : [],
  ]);
  const now = Date.now();

  let planGranted = 0;
  let promoGranted = 0;
  let purchasedGranted = 0;
  for (const grant of grants || []) {
    const amount = Number(grant.amount_micros) || 0;
    if (amount <= 0) continue;
    const bucket = grant.bucket;
    if (bucket === USAGE_BUCKETS.PLAN || bucket === 'included') {
      const endUnix = Number(grant.metadata?.period_end_unix || 0);
      const expiresAt = grant.metadata?.expires_at ? Date.parse(grant.metadata.expires_at) : NaN;
      const stillCurrent = endUnix > 0
        ? endUnix * 1000 > now
        : (Number.isFinite(expiresAt) ? expiresAt > now : true);
      if (stillCurrent) planGranted += amount;
    } else if (bucket === USAGE_BUCKETS.PROMOTIONAL) {
      promoGranted += amount;
    } else if (bucket === USAGE_BUCKETS.PURCHASED) {
      purchasedGranted += amount;
    }
  }
  promoGranted = Math.max(0, promoGranted - Number(resolvedBalance?.expiredPromotional || 0));

  const bucketStats = (granted, remaining) => {
    // The grants list is bounded; if remaining somehow exceeds what we saw
    // granted, trust the balance and clamp so the bar never goes negative.
    const safeGranted = Math.max(granted, remaining);
    const used = Math.max(0, safeGranted - remaining);
    return {
      granted_micros: safeGranted,
      granted_usd: formatUsd(safeGranted),
      used_micros: used,
      used_usd: formatUsd(used),
      remaining_micros: remaining,
      remaining_usd: formatUsd(remaining),
      percent_used: safeGranted > 0 ? Math.round((used / safeGranted) * 100) : 0,
    };
  };

  const planRemaining = (resolvedBalance?.plan || 0) + (resolvedBalance?.included || 0);
  return {
    plan: bucketStats(planGranted, planRemaining),
    promotional: bucketStats(promoGranted, resolvedBalance?.promotional || 0),
    purchased: bucketStats(purchasedGranted, resolvedBalance?.purchased || 0),
  };
}

export function customerUsagePayload(balance, history = [], month = null) {
  const planMicros = (balance?.plan || 0) + (balance?.included || 0);
  return {
    available_micros: balance?.available || 0,
    available_usd: balance?.display || formatUsd(0),
    purchased_micros: balance?.purchased || 0,
    purchased_usd: formatUsd(balance?.purchased || 0),
    promotional_micros: balance?.promotional || 0,
    promotional_usd: formatUsd(balance?.promotional || 0),
    plan_micros: planMicros,
    plan_usd: formatUsd(planMicros),
    reserved_micros: balance?.reservedMicros || 0,
    currency: balance?.currency || 'usd',
    this_month_spent_usd: month?.spentUsd || formatUsd(0),
    this_month_spent_micros: month?.spentMicros || 0,
    recent: history,
  };
}
