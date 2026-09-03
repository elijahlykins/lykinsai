/**
 * Deterministic Usage Balance spend policy and an in-memory ledger.
 *
 * The SQL RPCs in migration 134 implement the same rules.
 * Tests use this store so financial behavior does not depend on a live DB.
 *
 * Money model:
 *   - Lots hold CUSTOMER dollars (micros) in buckets.
 *   - A metered action costs RAW provider micros.
 *   - Each lot carries a pricing profile; the customer charge taken from a
 *     lot is rawCovered × profile (integer rational math, ceil).
 *
 * Spending order inside Usage Balance:
 *   1. plan lots (monthly subscription usage, expires at period end)
 *   2. included lots (legacy synonym for plan grants)
 *   3. promotional lots, earliest expiry first
 *   4. purchased lots (never expire)
 *
 * Expired lots are skipped. They cannot debit purchased funds.
 *
 * Across systems (Usage vs leftover legacy credits), one action uses one
 * payer:
 *   1. included subscription usage → $0
 *   2. expiring Usage (plan + promo) if it covers the full raw cost
 *   3. leftover purchased credits if they cover the catalog credit cost
 *   4. remaining Usage (including purchased dollars) if it covers the cost
 *   5. otherwise insufficient
 */

import { randomUUID } from 'node:crypto';
import { assertMicros, formatUsd, MONEY_CURRENCY } from './money.js';
import { quoteUsageCharge } from './usagePricing.js';
import { isIncludedSubscriptionUsage } from './usageEntitlements.js';
import {
  chargeForRawMicros,
  profileForLot,
  rawCapacityMicros,
} from './pricingProfiles.js';

export const USAGE_BUCKETS = Object.freeze({
  PURCHASED: 'purchased',
  PROMOTIONAL: 'promotional',
  PLAN: 'plan',
  INCLUDED: 'included',
});

export const TXN_TYPES = Object.freeze({
  FUNDING: 'funding',
  USAGE_CHARGE: 'usage_charge',
  REFUND: 'refund',
  REVERSAL: 'reversal',
  ADJUSTMENT: 'adjustment',
  PROMOTIONAL_GRANT: 'promotional_grant',
  SUBSCRIPTION_GRANT: 'subscription_grant',
  MIGRATION: 'migration',
  RESERVATION: 'reservation',
  RESERVATION_RELEASE: 'reservation_release',
  RESERVATION_SETTLE: 'reservation_settle',
});

export const PAYERS = Object.freeze({
  INCLUDED: 'included',
  USAGE: 'usage',
  LEGACY_CREDITS: 'legacy_credits',
  INSUFFICIENT: 'insufficient',
});

export const USAGE_SPEND_POLICY = Object.freeze({
  lotOrder: Object.freeze([
    USAGE_BUCKETS.PLAN,
    USAGE_BUCKETS.INCLUDED,
    USAGE_BUCKETS.PROMOTIONAL,
    USAGE_BUCKETS.PURCHASED,
  ]),
  expirySort: 'earliest_expiry_first',
  crossSystem: 'expiring_usage_then_legacy_credits_then_purchased_usage',
  splitAcrossSystems: false,
  expiredLotsCannotDebitPurchased: true,
});

const BUCKET_RANK = {
  [USAGE_BUCKETS.PLAN]: 0,
  [USAGE_BUCKETS.INCLUDED]: 1,
  [USAGE_BUCKETS.PROMOTIONAL]: 2,
  [USAGE_BUCKETS.PURCHASED]: 3,
};

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.now();
}

export function lotIsAvailable(lot, now = Date.now()) {
  if (!lot || lot.remaining_micros <= 0) return false;
  if (!lot.expires_at) return true;
  return new Date(lot.expires_at).getTime() > nowMs(now);
}

export function sortSpendLots(lots, now = Date.now()) {
  return [...lots]
    .filter((lot) => lotIsAvailable(lot, now))
    .sort((a, b) => {
      const rank = (BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9);
      if (rank !== 0) return rank;
      const ae = a.expires_at ? new Date(a.expires_at).getTime() : Number.POSITIVE_INFINITY;
      const be = b.expires_at ? new Date(b.expires_at).getTime() : Number.POSITIVE_INFINITY;
      if (ae !== be) return ae - be;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
}

/**
 * Allocate a raw provider cost across available lots.
 *
 * Per lot: how much raw cost the lot's remaining customer value can cover
 * under its pricing profile, then the customer charge for the raw portion
 * actually taken. Rounding is deterministic and can only under-collect by
 * a sub-micro amount per lot, never over-collect.
 */
export function allocateSpendByCost(lots, rawMicros, now = Date.now()) {
  const need = assertMicros(rawMicros, 'rawCost');
  const allocations = [];
  let remainingRaw = need;
  let chargeMicros = 0;
  for (const lot of sortSpendLots(lots, now)) {
    if (remainingRaw <= 0) break;
    const profile = profileForLot(lot);
    const capacity = rawCapacityMicros(lot.remaining_micros, profile);
    if (capacity <= 0) continue;
    const takeRaw = Math.min(capacity, remainingRaw);
    const charge = Math.min(lot.remaining_micros, chargeForRawMicros(takeRaw, profile));
    if (charge <= 0 && takeRaw <= 0) continue;
    allocations.push({
      lot_id: lot.id,
      bucket: lot.bucket,
      pricing_profile: profile,
      raw_micros: takeRaw,
      micros: charge,
    });
    chargeMicros += charge;
    remainingRaw -= takeRaw;
  }
  return {
    ok: remainingRaw === 0,
    allocations,
    chargeMicros,
    rawMicros: need,
    coveredRawMicros: need - remainingRaw,
    shortfallRawMicros: remainingRaw,
  };
}

export function summarizeLots(lots, now = Date.now()) {
  const out = {
    purchased: 0,
    promotional: 0,
    plan: 0,
    included: 0,
    available: 0,
    expired: 0,
    rawCapacity: 0,
  };
  for (const lot of lots) {
    const amount = Number(lot.remaining_micros) || 0;
    if (amount <= 0) continue;
    if (lot.expires_at && new Date(lot.expires_at).getTime() <= nowMs(now)) {
      out.expired += amount;
      continue;
    }
    if (lot.bucket === USAGE_BUCKETS.PURCHASED) out.purchased += amount;
    else if (lot.bucket === USAGE_BUCKETS.PROMOTIONAL) out.promotional += amount;
    else if (lot.bucket === USAGE_BUCKETS.PLAN) out.plan += amount;
    else if (lot.bucket === USAGE_BUCKETS.INCLUDED) out.included += amount;
    out.rawCapacity += rawCapacityMicros(amount, profileForLot(lot));
  }
  out.planAvailable = out.plan + out.included;
  out.available = out.purchased + out.promotional + out.plan + out.included;
  out.expiringAvailable = out.plan + out.included + out.promotional;
  return out;
}

/**
 * Cross-system payer choice for one action. Raw cost in, one payer out.
 * Never splits a single action across legacy credits and Usage.
 */
export function choosePayer({
  rawMicros,
  creditCost = 0,
  creditBalance = 0,
  lots = [],
  included = false,
  now = Date.now(),
} = {}) {
  if (included) {
    return { payer: PAYERS.INCLUDED, chargeMicros: 0, creditCost: 0 };
  }
  const need = assertMicros(rawMicros || 0, 'rawCost');
  if (need <= 0) {
    return { payer: PAYERS.INCLUDED, chargeMicros: 0, creditCost: 0 };
  }

  const summary = summarizeLots(lots, now);
  const expiringLots = lots.filter((lot) => (
    lot.bucket === USAGE_BUCKETS.PLAN
    || lot.bucket === USAGE_BUCKETS.INCLUDED
    || lot.bucket === USAGE_BUCKETS.PROMOTIONAL
  ));
  const expiring = allocateSpendByCost(expiringLots, need, now);
  if (expiring.ok) {
    return { payer: PAYERS.USAGE, chargeMicros: expiring.chargeMicros };
  }

  const credits = Number(creditBalance || 0);
  const creditsNeeded = Math.max(0, Number(creditCost) || 0);
  if (creditsNeeded > 0 && credits >= creditsNeeded) {
    return { payer: PAYERS.LEGACY_CREDITS, chargeMicros: 0, creditCost: creditsNeeded };
  }

  const all = allocateSpendByCost(lots, need, now);
  if (all.ok) {
    return { payer: PAYERS.USAGE, chargeMicros: all.chargeMicros };
  }
  return {
    payer: PAYERS.INSUFFICIENT,
    chargeMicros: all.chargeMicros,
    availableMicros: summary.available,
    shortfallRawMicros: all.shortfallRawMicros,
    creditBalance: credits,
    creditCost: creditsNeeded,
  };
}

export function insufficientPayload({ availableMicros = 0, requiredMicros = 0 } = {}) {
  return {
    ok: false,
    error: 'insufficient_usage_balance',
    code: 'insufficient_usage_balance',
    message: 'Top up to continue with this action.',
    usage_balance_usd: formatUsd(availableMicros),
    required_usd: formatUsd(Math.max(requiredMicros, 0)),
    usage_balance_micros: availableMicros,
    required_micros: requiredMicros,
    add_funds: true,
  };
}

function emptyAccount(userId) {
  return {
    userId,
    lots: [],
    ledger: [],
    reservations: [],
    reservedMicros: 0,
  };
}

function availableOf(account, now) {
  return summarizeLots(account.lots, now);
}

function appendLedger(account, row) {
  const summary = availableOf(account, Date.now());
  const entry = {
    id: row.id || randomUUID(),
    user_id: account.userId,
    currency: MONEY_CURRENCY,
    status: row.status || 'posted',
    resulting_available_micros: summary.available,
    created_at: row.created_at || new Date().toISOString(),
    ...row,
  };
  account.ledger.push(entry);
  return entry;
}

export function createMemoryUsageStore() {
  const users = new Map();
  const locks = new Map();

  function account(userId) {
    if (!users.has(userId)) users.set(userId, emptyAccount(userId));
    return users.get(userId);
  }

  function withLock(userId, fn) {
    const prev = locks.get(userId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    locks.set(userId, run.catch(() => {}));
    return run;
  }

  function applyAllocations(acct, allocations) {
    const byId = new Map(acct.lots.map((lot) => [lot.id, lot]));
    for (const alloc of allocations) {
      const lot = byId.get(alloc.lot_id);
      if (!lot || lot.remaining_micros < alloc.micros) {
        const err = new Error('allocation_failed');
        err.code = 'allocation_failed';
        throw err;
      }
      lot.remaining_micros -= alloc.micros;
    }
  }

  function creditAllocations(acct, allocations) {
    const byId = new Map(acct.lots.map((lot) => [lot.id, lot]));
    for (const alloc of allocations) {
      const lot = byId.get(alloc.lot_id);
      if (lot) {
        lot.remaining_micros += alloc.micros;
      } else {
        acct.lots.push({
          id: randomUUID(),
          user_id: acct.userId,
          bucket: alloc.bucket,
          pricing_profile: alloc.pricing_profile || null,
          remaining_micros: alloc.micros,
          expires_at: null,
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  function chargeLedgerRow(acct, {
    allocations,
    chargeMicros,
    rawMicros,
    providerCostMicros,
    pricingVersion,
    actionType,
    model,
    provider,
    runId,
    reservationId = null,
    idempotencyKey = null,
    metadata = {},
  }) {
    return appendLedger(acct, {
      amount_micros: chargeMicros,
      direction: 'debit',
      txn_type: TXN_TYPES.USAGE_CHARGE,
      reservation_id: reservationId,
      provider_cost_micros: providerCostMicros || 0,
      customer_charge_micros: chargeMicros,
      pricing_version: pricingVersion,
      action_type: actionType,
      model,
      provider,
      run_id: runId,
      idempotency_key: idempotencyKey,
      metadata: { ...metadata, raw_cost_micros: rawMicros, allocations },
    });
  }

  return {
    async getBalance(userId, now = Date.now()) {
      const acct = account(userId);
      const summary = availableOf(acct, now);
      return {
        userId,
        currency: MONEY_CURRENCY,
        ...summary,
        reservedMicros: acct.reservedMicros,
        display: formatUsd(summary.available),
      };
    },

    async listLedger(userId, limit = 20) {
      const acct = account(userId);
      return [...acct.ledger].reverse().slice(0, Math.max(1, Math.min(limit, 50)));
    },

    async listGrants(userId) {
      const acct = account(userId);
      return [...acct.ledger].reverse().filter((row) => row.direction === 'credit').slice(0, 300);
    },

    async listLots(userId) {
      const acct = account(userId);
      return acct.lots.map((lot) => ({ ...lot }));
    },

    async fund(userId, { amountMicros, stripeSessionId, idempotencyKey, metadata } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        const key = idempotencyKey || (stripeSessionId ? `funding:${stripeSessionId}` : null);
        if (key) {
          const existing = acct.ledger.find((row) => row.idempotency_key === key);
          if (existing) {
            const summary = availableOf(acct);
            return { ok: true, duplicate: true, available: summary.available, ledgerId: existing.id };
          }
        }
        const amount = assertMicros(amountMicros, 'funding');
        acct.lots.push({
          id: randomUUID(),
          user_id: userId,
          bucket: USAGE_BUCKETS.PURCHASED,
          pricing_profile: 'topup',
          remaining_micros: amount,
          expires_at: null,
          created_at: new Date().toISOString(),
        });
        const entry = appendLedger(acct, {
          amount_micros: amount,
          direction: 'credit',
          txn_type: TXN_TYPES.FUNDING,
          bucket: USAGE_BUCKETS.PURCHASED,
          stripe_session_id: stripeSessionId || null,
          idempotency_key: key,
          metadata: metadata || {},
        });
        return { ok: true, duplicate: false, available: availableOf(acct).available, ledgerId: entry.id };
      });
    },

    async grant(userId, {
      amountMicros,
      bucket = USAGE_BUCKETS.PROMOTIONAL,
      pricingProfile = null,
      txnType = TXN_TYPES.PROMOTIONAL_GRANT,
      expiresAt = null,
      idempotencyKey = null,
      metadata = {},
    } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        if (idempotencyKey) {
          const existing = acct.ledger.find((row) => row.idempotency_key === idempotencyKey);
          if (existing) {
            return { ok: true, duplicate: true, available: availableOf(acct).available, ledgerId: existing.id };
          }
        }
        const amount = assertMicros(amountMicros, 'grant');
        acct.lots.push({
          id: randomUUID(),
          user_id: userId,
          bucket,
          pricing_profile: pricingProfile,
          remaining_micros: amount,
          expires_at: expiresAt,
          created_at: new Date().toISOString(),
        });
        const entry = appendLedger(acct, {
          amount_micros: amount,
          direction: 'credit',
          txn_type: txnType,
          bucket,
          idempotency_key: idempotencyKey,
          metadata: { ...metadata, pricing_profile: pricingProfile, expires_at: expiresAt },
        });
        return { ok: true, duplicate: false, available: availableOf(acct).available, ledgerId: entry.id };
      });
    },

    async reserve(userId, {
      rawMicros,
      actionType = null,
      pricingVersion = null,
      idempotencyKey = null,
      metadata = {},
      now = Date.now(),
    } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        if (idempotencyKey) {
          const existing = acct.reservations.find((row) => row.idempotency_key === idempotencyKey);
          if (existing) {
            return {
              ok: true,
              duplicate: true,
              reservationId: existing.id,
              chargeMicros: existing.amount_micros,
              allocations: existing.allocations,
            };
          }
        }
        const raw = assertMicros(rawMicros, 'reserve');
        const plan = allocateSpendByCost(acct.lots, raw, now);
        if (!plan.ok) {
          return {
            ok: false,
            error: 'insufficient_usage_balance',
            ...insufficientPayload({
              availableMicros: availableOf(acct, now).available,
              requiredMicros: plan.chargeMicros + plan.shortfallRawMicros,
            }),
          };
        }
        applyAllocations(acct, plan.allocations);
        acct.reservedMicros += plan.chargeMicros;
        const reservation = {
          id: randomUUID(),
          user_id: userId,
          amount_micros: plan.chargeMicros,
          raw_micros: raw,
          status: 'open',
          idempotency_key: idempotencyKey,
          allocations: plan.allocations,
          action_type: actionType,
          pricing_version: pricingVersion,
          created_at: new Date().toISOString(),
        };
        acct.reservations.push(reservation);
        appendLedger(acct, {
          amount_micros: plan.chargeMicros,
          direction: 'debit',
          txn_type: TXN_TYPES.RESERVATION,
          reservation_id: reservation.id,
          idempotency_key: idempotencyKey,
          action_type: actionType,
          metadata: { ...metadata, raw_cost_micros: raw, allocations: plan.allocations },
          status: 'reserved',
        });
        return {
          ok: true,
          duplicate: false,
          reservationId: reservation.id,
          chargeMicros: plan.chargeMicros,
          allocations: plan.allocations,
        };
      });
    },

    async settle(userId, {
      reservationId,
      actualRawMicros,
      providerCostMicros = 0,
      pricingVersion = null,
      actionType = null,
      model = null,
      provider = null,
      runId = null,
      metadata = {},
      now = Date.now(),
    } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        const reservation = acct.reservations.find((row) => row.id === reservationId);
        if (!reservation) return { ok: false, error: 'reservation_missing' };
        if (reservation.status === 'settled') {
          return { ok: true, duplicate: true, reservationId };
        }
        if (reservation.status !== 'open') return { ok: false, error: 'reservation_closed' };

        const actualRaw = assertMicros(
          actualRawMicros == null ? reservation.raw_micros : actualRawMicros,
          'settle',
        );
        if (actualRaw > reservation.raw_micros) return { ok: false, error: 'settle_exceeds_reserve' };

        // Credit the reservation back in full, then re-allocate the actual
        // raw cost. The unused remainder returns to its original lots.
        creditAllocations(acct, reservation.allocations);
        acct.reservedMicros = Math.max(0, acct.reservedMicros - reservation.amount_micros);

        let chargedMicros = 0;
        if (actualRaw > 0) {
          const plan = allocateSpendByCost(acct.lots, actualRaw, now);
          // The reservation covered a larger raw amount, so this cannot fail.
          applyAllocations(acct, plan.allocations);
          chargedMicros = plan.chargeMicros;
          chargeLedgerRow(acct, {
            allocations: plan.allocations,
            chargeMicros: plan.chargeMicros,
            rawMicros: actualRaw,
            providerCostMicros,
            pricingVersion: pricingVersion || reservation.pricing_version,
            actionType: actionType || reservation.action_type,
            model,
            provider,
            runId,
            reservationId: reservation.id,
            metadata,
          });
        }
        const releasedMicros = Math.max(0, reservation.amount_micros - chargedMicros);
        if (releasedMicros > 0) {
          appendLedger(acct, {
            amount_micros: releasedMicros,
            direction: 'credit',
            txn_type: TXN_TYPES.RESERVATION_RELEASE,
            reservation_id: reservation.id,
            metadata: { unused: true },
          });
        }
        reservation.status = 'settled';
        reservation.updated_at = new Date().toISOString();
        return { ok: true, duplicate: false, chargedMicros, releasedMicros };
      });
    },

    async release(userId, { reservationId } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        const reservation = acct.reservations.find((row) => row.id === reservationId);
        if (!reservation) return { ok: false, error: 'reservation_missing' };
        if (reservation.status === 'released') return { ok: true, duplicate: true, reservationId };
        if (reservation.status !== 'open') return { ok: false, error: 'reservation_closed' };
        creditAllocations(acct, reservation.allocations);
        acct.reservedMicros = Math.max(0, acct.reservedMicros - reservation.amount_micros);
        reservation.status = 'released';
        appendLedger(acct, {
          amount_micros: reservation.amount_micros,
          direction: 'credit',
          txn_type: TXN_TYPES.RESERVATION_RELEASE,
          reservation_id: reservation.id,
          metadata: { allocations: reservation.allocations },
        });
        return { ok: true, duplicate: false, releasedMicros: reservation.amount_micros };
      });
    },

    async charge(userId, {
      rawMicros,
      allowPartial = false,
      providerCostMicros = 0,
      pricingVersion = null,
      actionType = null,
      model = null,
      provider = null,
      runId = null,
      idempotencyKey = null,
      metadata = {},
      now = Date.now(),
    } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        if (idempotencyKey) {
          const existing = acct.ledger.find((row) => row.idempotency_key === idempotencyKey);
          if (existing) {
            return { ok: true, duplicate: true, ledgerId: existing.id, chargedMicros: existing.amount_micros };
          }
        }
        const raw = assertMicros(rawMicros, 'charge');
        const plan = allocateSpendByCost(acct.lots, raw, now);
        if (!plan.ok && !allowPartial) {
          return {
            ok: false,
            error: 'insufficient_usage_balance',
            ...insufficientPayload({
              availableMicros: availableOf(acct, now).available,
              requiredMicros: plan.chargeMicros + plan.shortfallRawMicros,
            }),
          };
        }
        if (plan.chargeMicros <= 0 && plan.coveredRawMicros <= 0) {
          return {
            ok: true,
            partial: !plan.ok,
            chargedMicros: 0,
            coveredRawMicros: 0,
            shortfallRawMicros: plan.shortfallRawMicros,
            ledgerId: null,
          };
        }
        applyAllocations(acct, plan.allocations);
        const entry = chargeLedgerRow(acct, {
          allocations: plan.allocations,
          chargeMicros: plan.chargeMicros,
          rawMicros: plan.coveredRawMicros,
          providerCostMicros,
          pricingVersion,
          actionType,
          model,
          provider,
          runId,
          idempotencyKey,
          metadata: plan.ok ? metadata : { ...metadata, partial: true, shortfall_raw_micros: plan.shortfallRawMicros },
        });
        return {
          ok: true,
          duplicate: false,
          partial: !plan.ok,
          ledgerId: entry.id,
          chargedMicros: plan.chargeMicros,
          coveredRawMicros: plan.coveredRawMicros,
          shortfallRawMicros: plan.shortfallRawMicros,
        };
      });
    },

    async reverse(userId, { ledgerId, idempotencyKey = null, metadata = {} } = {}) {
      return withLock(userId, async () => {
        const acct = account(userId);
        const key = idempotencyKey || (ledgerId ? `reversal:${ledgerId}` : null);
        if (key) {
          const existing = acct.ledger.find((row) => row.idempotency_key === key);
          if (existing) return { ok: true, duplicate: true, ledgerId: existing.id };
        }
        const original = acct.ledger.find((row) => row.id === ledgerId);
        if (!original) return { ok: false, error: 'ledger_missing' };
        if (original.direction !== 'debit' || original.txn_type !== TXN_TYPES.USAGE_CHARGE) {
          return { ok: false, error: 'not_reversible' };
        }
        const allocations = original.metadata?.allocations || [];
        creditAllocations(acct, allocations);
        const entry = appendLedger(acct, {
          amount_micros: original.amount_micros,
          direction: 'credit',
          txn_type: TXN_TYPES.REVERSAL,
          idempotency_key: key,
          metadata: { ...metadata, original_ledger_id: ledgerId, allocations },
        });
        return { ok: true, duplicate: false, ledgerId: entry.id, restoredMicros: original.amount_micros };
      });
    },
  };
}

/**
 * One decision for one action: is it included, what does it cost raw, and
 * who pays. Used by authorizeMeteredUsage.
 */
export function quoteAndChoosePayer({
  actionType,
  planId,
  usageKind,
  autonomous,
  explicitModelOverride,
  requestedModel,
  providerCostUsd = 0,
  providerCostMicros = null,
  creditCost = 0,
  creditBalance = 0,
  lots = [],
  now = Date.now(),
} = {}) {
  const included = isIncludedSubscriptionUsage({
    actionType,
    planId,
    usageKind,
    autonomous,
    explicitModelOverride,
    requestedModel,
  });
  const quote = quoteUsageCharge({ actionType, providerCostUsd, providerCostMicros });
  const decision = choosePayer({
    rawMicros: included ? 0 : quote.rawCostMicros,
    creditCost,
    creditBalance,
    lots,
    included,
    now,
  });
  return { included, quote, decision };
}
