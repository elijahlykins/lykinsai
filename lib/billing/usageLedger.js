/**
 * Production Usage Ledger adapter.
 *
 * Talks to Supabase RPCs from migrations 131/134 with the service role.
 * Callers never write ledger rows directly. Reserve/settle/charge work in
 * RAW provider micros; pricing profiles are passed per call from
 * lib/billing/pricingProfiles.js (the single source of margin truth).
 */

import fetch from 'node-fetch';
import { formatUsd, MONEY_CURRENCY } from './money.js';
import { profilesForSql } from './pricingProfiles.js';

const getSupabaseUrl = () => process.env.VITE_SUPABASE_URL;
const getServiceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

function serviceRoleConfigured() {
  return Boolean(getSupabaseUrl() && getServiceRoleKey());
}

function adminHeaders() {
  const key = getServiceRoleKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function callRpc(fnName, args) {
  if (!serviceRoleConfigured()) {
    const err = new Error(`Service role not configured — cannot call ${fnName}`);
    err.code = 'no_service_role';
    throw err;
  }
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`RPC ${fnName} failed (${res.status}): ${body.slice(0, 240)}`);
    err.code = res.status === 404 ? 'rpc_missing' : 'rpc_error';
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function emptyBalance(userId) {
  return {
    userId,
    currency: MONEY_CURRENCY,
    purchased: 0,
    promotional: 0,
    plan: 0,
    included: 0,
    available: 0,
    expiringAvailable: 0,
    expiredPromotional: 0,
    reservedMicros: 0,
    display: formatUsd(0),
  };
}

export function createSqlUsageStore() {
  return {
    async getBalance(userId) {
      if (!userId) return emptyBalance(userId);
      if (!serviceRoleConfigured()) return emptyBalance(userId);
      try {
        const result = await callRpc('lykn_usage_balance', { p_user_id: userId });
        if (!result || result.ok === false) return emptyBalance(userId);
        const purchased = Number(result.purchased_micros || 0);
        const promotional = Number(result.promotional_micros || 0);
        const included = Number(result.included_micros || 0);
        const plan = Number(result.plan_micros || 0);
        const available = Number(result.available_micros || purchased + promotional + included + plan);
        return {
          userId,
          currency: result.currency || MONEY_CURRENCY,
          purchased,
          promotional,
          plan,
          included,
          available,
          expiringAvailable: plan + promotional + included,
          expiredPromotional: Number(result.expired_promotional_micros || 0),
          reservedMicros: Number(result.reserved_micros || 0),
          display: formatUsd(available),
        };
      } catch (err) {
        if (err?.code === 'rpc_missing' || err?.code === 'no_service_role') {
          return emptyBalance(userId);
        }
        throw err;
      }
    },

    async listLedger(userId, limit = 20) {
      if (!userId || !serviceRoleConfigured()) return [];
      const safe = Math.max(1, Math.min(Number(limit) || 20, 50));
      try {
        const url = `${getSupabaseUrl()}/rest/v1/lykn_usage_ledger`
          + `?user_id=eq.${encodeURIComponent(userId)}`
          + '&select=id,amount_micros,direction,txn_type,bucket,customer_charge_micros,action_type,created_at,status,metadata'
          + `&order=created_at.desc&limit=${safe}`;
        const res = await fetch(url, { headers: adminHeaders() });
        if (!res.ok) return [];
        const rows = await res.json().catch(() => []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    },

    async listGrants(userId) {
      if (!userId || !serviceRoleConfigured()) return [];
      try {
        const url = `${getSupabaseUrl()}/rest/v1/lykn_usage_ledger`
          + `?user_id=eq.${encodeURIComponent(userId)}`
          + '&direction=eq.credit'
          + '&select=id,amount_micros,txn_type,bucket,metadata,created_at'
          + '&order=created_at.desc&limit=300';
        const res = await fetch(url, { headers: adminHeaders() });
        if (!res.ok) return [];
        const rows = await res.json().catch(() => []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    },

    async listLots(userId) {
      if (!userId || !serviceRoleConfigured()) return [];
      try {
        const url = `${getSupabaseUrl()}/rest/v1/lykn_usage_lots`
          + `?user_id=eq.${encodeURIComponent(userId)}`
          + '&select=id,bucket,pricing_profile,remaining_micros,expires_at,created_at'
          + '&remaining_micros=gt.0&order=created_at.asc&limit=200';
        const res = await fetch(url, { headers: adminHeaders() });
        if (!res.ok) return [];
        const rows = await res.json().catch(() => []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    },

    async fund(userId, { amountMicros, stripeSessionId, idempotencyKey, metadata } = {}) {
      return callRpc('lykn_usage_fund', {
        p_user_id: userId,
        p_amount_micros: amountMicros,
        p_stripe_session_id: stripeSessionId || null,
        p_idempotency_key: idempotencyKey || null,
        p_metadata: metadata || {},
      });
    },

    async grant(userId, {
      amountMicros,
      bucket,
      pricingProfile,
      txnType,
      expiresAt,
      idempotencyKey,
      metadata,
    } = {}) {
      return callRpc('lykn_usage_grant_v2', {
        p_user_id: userId,
        p_amount_micros: amountMicros,
        p_bucket: bucket,
        p_pricing_profile: pricingProfile || null,
        p_txn_type: txnType,
        p_expires_at: expiresAt,
        p_idempotency_key: idempotencyKey || null,
        p_metadata: metadata || {},
      });
    },

    async reserve(userId, {
      rawMicros,
      actionType,
      pricingVersion,
      idempotencyKey,
      metadata,
    } = {}) {
      return callRpc('lykn_usage_reserve_cost', {
        p_user_id: userId,
        p_raw_micros: rawMicros,
        p_profiles: profilesForSql(),
        p_action_type: actionType || null,
        p_pricing_version: pricingVersion || null,
        p_idempotency_key: idempotencyKey || null,
        p_metadata: metadata || {},
      });
    },

    async settle(userId, {
      reservationId,
      actualRawMicros,
      providerCostMicros,
      pricingVersion,
      actionType,
      model,
      provider,
      runId,
      metadata,
    } = {}) {
      return callRpc('lykn_usage_settle_cost', {
        p_user_id: userId,
        p_reservation_id: reservationId,
        p_actual_raw_micros: actualRawMicros ?? null,
        p_profiles: profilesForSql(),
        p_provider_cost_micros: providerCostMicros || 0,
        p_pricing_version: pricingVersion || null,
        p_action_type: actionType || null,
        p_model: model || null,
        p_provider: provider || null,
        p_run_id: runId || null,
        p_metadata: metadata || {},
      });
    },

    async release(userId, { reservationId } = {}) {
      return callRpc('lykn_usage_release', {
        p_user_id: userId,
        p_reservation_id: reservationId,
      });
    },

    async charge(userId, {
      rawMicros,
      allowPartial = false,
      providerCostMicros,
      pricingVersion,
      actionType,
      model,
      provider,
      runId,
      idempotencyKey,
      metadata,
    } = {}) {
      return callRpc('lykn_usage_charge_cost', {
        p_user_id: userId,
        p_raw_micros: rawMicros,
        p_profiles: profilesForSql(),
        p_allow_partial: Boolean(allowPartial),
        p_provider_cost_micros: providerCostMicros || 0,
        p_pricing_version: pricingVersion || null,
        p_action_type: actionType || null,
        p_model: model || null,
        p_provider: provider || null,
        p_run_id: runId || null,
        p_idempotency_key: idempotencyKey || null,
        p_metadata: metadata || {},
      });
    },

    async reverse(userId, { ledgerId, idempotencyKey, metadata } = {}) {
      return callRpc('lykn_usage_reverse', {
        p_user_id: userId,
        p_ledger_id: ledgerId,
        p_idempotency_key: idempotencyKey || null,
        p_metadata: metadata || {},
      });
    },
  };
}

export const sqlUsageStore = createSqlUsageStore();
