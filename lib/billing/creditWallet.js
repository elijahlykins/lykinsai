/**
 * Purchased LYKN AI credits (migration 123) — LEGACY, being retired.
 *
 * Packs are no longer for sale and remaining balances convert to purchased
 * Usage Balance dollars via scripts/migrate-legacy-credits.mjs. Until a
 * wallet is migrated it stays a fallback payer: a request is charged to it
 * only when the account has no Usage Balance to cover the action. The AI
 * gates in server.js record that with `markTopupPayer`; `logAiUsage` then
 * debits the real credit cost of the action once it knows what the action
 * was.
 *
 * That split is deliberate. Debiting in the gate would mean guessing the cost
 * before the work happens (a chat message is 1 credit, an image is 15), and
 * debiting unconditionally in the logger would burn purchased credits while a
 * subscriber is still inside their plan.
 *
 * This module talks to Supabase over REST with the service-role key rather
 * than taking a supabase-js client, so usageTracking.js — which has no client —
 * can debit without server.js threading one through every logAiUsage call site.
 */

import fetch from 'node-fetch';

const getSupabaseUrl = () => process.env.VITE_SUPABASE_URL;
const getServiceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// Balance is read on the gate path, so cache it briefly. Any grant or debit
// invalidates the entry, so the window only matters for concurrent requests.
const WALLET_CACHE_MS = 15 * 1000;
const walletCache = new Map(); // userId → { wallet, expiresAt }

// How long a "this account is spending purchased credits" decision stays good.
// Comfortably longer than the gap between a gate and its logAiUsage call, short
// enough that a resubscribe or a monthly reset stops charging the wallet even
// if the next gate never runs.
const PAYER_TTL_MS = 10 * 60 * 1000;
const payerFlags = new Map(); // userId → expiresAt

const MAX_TRACKED_USERS = 5000;

function pruneExpired(map) {
  if (map.size <= MAX_TRACKED_USERS) return;
  const now = Date.now();
  for (const [key, value] of map) {
    const expires = typeof value === 'number' ? value : value?.expiresAt || 0;
    if (expires <= now) map.delete(key);
  }
}

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

/** Throws on any non-2xx so callers can decide between fail-closed and retry. */
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

const EMPTY_WALLET = { granted: 0, used: 0, balance: 0 };

function normalizeWallet(row) {
  const granted = Number(row?.credits_granted || 0);
  const used = Number(row?.credits_used || 0);
  return { granted, used, balance: Math.max(0, granted - used) };
}

/**
 * Current purchased balance. Returns null when the wallet backend is
 * unreachable so quota callers can fail closed — but returns a zero wallet
 * (not null) when there is simply no row, or when Supabase isn't configured at
 * all, so local dev without a service-role key behaves as "no credits bought".
 */
export async function getCreditWallet(userId) {
  if (!userId) return { ...EMPTY_WALLET };
  if (!serviceRoleConfigured()) return { ...EMPTY_WALLET };

  const cached = walletCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.wallet;

  try {
    const url = `${getSupabaseUrl()}/rest/v1/lykn_credit_wallets`
      + `?user_id=eq.${encodeURIComponent(userId)}`
      + '&select=credits_granted,credits_used&limit=1';
    const res = await fetch(url, { headers: adminHeaders() });
    if (!res.ok) {
      // The table is missing until migration 123 is applied. Treat that as an
      // empty wallet rather than an outage so top-ups can ship before the
      // migration runs without walling anyone out — and cache it, since this
      // sits on the AI gate path and would otherwise re-query every request.
      if (res.status === 404) {
        const empty = { ...EMPTY_WALLET };
        walletCache.set(userId, { wallet: empty, expiresAt: Date.now() + WALLET_CACHE_MS });
        return empty;
      }
      console.error(`[CreditWallet] read failed (${res.status})`);
      return null;
    }
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    const wallet = normalizeWallet(rows[0]);
    walletCache.set(userId, { wallet, expiresAt: Date.now() + WALLET_CACHE_MS });
    pruneExpired(walletCache);
    return wallet;
  } catch (e) {
    console.error('[CreditWallet] read error:', e?.message || e);
    return null;
  }
}

export function invalidateCreditWallet(userId) {
  if (userId) walletCache.delete(userId);
}

/**
 * Debit the wallet for work already done. Best-effort by design: the AI
 * response has already been delivered by the time this runs, so a failed
 * debit is logged and swallowed rather than surfaced. The RPC clamps at the
 * remaining balance, so concurrent requests can't drive it negative.
 */
export async function spendTopupCredits(userId, credits) {
  const amount = Number(credits);
  if (!userId || !Number.isFinite(amount) || amount <= 0) return null;
  if (!serviceRoleConfigured()) return null;

  try {
    const result = await callRpc('lykn_credit_wallet_spend', {
      p_user_id: userId,
      p_credits: Math.round(amount),
    });
    invalidateCreditWallet(userId);
    // Balance hit zero — stop treating the wallet as the payer so the next
    // request gets bounced by the gate instead of running for free.
    if (result?.ok && Number(result.balance || 0) <= 0) markTopupPayer(userId, false);
    return result;
  } catch (e) {
    if (e?.code !== 'rpc_missing') {
      console.error('[CreditWallet] spend error:', e?.message || e);
    }
    return null;
  }
}

/**
 * Record whether this account is currently spending purchased credits. Written
 * by the AI gates, read by logAiUsage. `requireAppAccess` always runs before
 * `checkAiUsageLimit`, so the later gate's verdict wins for routes that have
 * both.
 */
export function markTopupPayer(userId, on) {
  if (!userId) return;
  if (on) {
    payerFlags.set(userId, Date.now() + PAYER_TTL_MS);
    pruneExpired(payerFlags);
  } else {
    payerFlags.delete(userId);
  }
}

export function isTopupPayer(userId) {
  if (!userId) return false;
  const expires = payerFlags.get(userId) || 0;
  if (expires > Date.now()) return true;
  if (expires) payerFlags.delete(userId);
  return false;
}
