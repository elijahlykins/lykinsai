/**
 * Normalized usage events.
 *
 * One internal representation regardless of gateway/provider.
 * Provider cost, markup, and customer charge stay separate.
 * Writes are additive and never the authority for wallet mutations —
 * Usage Balance still goes through lib/billing RPCs.
 */

import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import { formatUsd, assertMicros, roundProviderCostMicros } from '../billing/money.js';
import { estimateChargeMicros, quoteUsageCharge } from '../billing/usagePricing.js';

export const BILLING_SOURCES = Object.freeze({
  LYKN: 'lykn',
  OPENROUTER_BYOK: 'openrouter_byok',
  DIRECT_BYOK: 'direct_byok',
  LOCAL: 'local',
});

export const COST_SOURCES = Object.freeze({
  UPSTREAM: 'upstream',
  ESTIMATE: 'estimate',
  MISSING: 'missing',
});

function serviceRoleConfigured() {
  return Boolean(process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function adminHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

export function normalizeUsageEvent(input = {}) {
  const tokens = {
    input: Math.max(0, Number(input.inputTokens) || 0),
    output: Math.max(0, Number(input.outputTokens) || 0),
    reasoning: Math.max(0, Number(input.reasoningTokens) || 0),
    cachedInput: Math.max(0, Number(input.cachedInputTokens) || 0),
    cacheWrite: Math.max(0, Number(input.cacheWriteTokens) || 0),
  };

  let providerCostMicros = 0;
  let costSource = COST_SOURCES.MISSING;
  if (Number.isInteger(input.providerCostMicros)) {
    providerCostMicros = assertMicros(input.providerCostMicros, 'providerCost');
    costSource = input.costSource || COST_SOURCES.UPSTREAM;
  } else if (input.providerCostUsd != null && Number.isFinite(Number(input.providerCostUsd))) {
    providerCostMicros = roundProviderCostMicros(input.providerCostUsd);
    costSource = input.costSource || COST_SOURCES.UPSTREAM;
  } else if (input.estimatedCostUsd != null && Number.isFinite(Number(input.estimatedCostUsd))) {
    providerCostMicros = roundProviderCostMicros(input.estimatedCostUsd);
    costSource = COST_SOURCES.ESTIMATE;
  }

  const quote = quoteUsageCharge({
    actionType: input.actionType || 'chat_short',
    providerCostMicros,
  });

  const billingSource = BILLING_SOURCES[String(input.billingSource || '').toUpperCase()]
    || (Object.values(BILLING_SOURCES).includes(input.billingSource) ? input.billingSource : BILLING_SOURCES.LYKN);

  const byok = billingSource !== BILLING_SOURCES.LYKN;
  const includedUsage = input.includedUsage === true;
  // Actual settled charge when the caller knows it; the worst-case estimate
  // otherwise. Included subscription usage records $0 customer charge while
  // still tracking the underlying provider cost.
  let customerChargeMicros = 0;
  if (!byok && !includedUsage) {
    customerChargeMicros = Number.isInteger(input.customerChargeMicros)
      ? assertMicros(input.customerChargeMicros, 'customerCharge')
      : estimateChargeMicros(quote);
  }
  const markupAmountMicros = byok ? 0 : Math.max(0, customerChargeMicros - providerCostMicros);

  return {
    id: String(input.id || randomUUID()),
    user_id: input.userId || null,
    chat_id: input.chatId || null,
    bot_id: input.botId || null,
    request_id: input.requestId || input.idempotencyKey || null,
    route_id: input.routeId || null,
    gateway: input.gateway || 'direct',
    upstream_provider: input.upstreamProvider || input.provider || null,
    model_id: input.modelId || input.model || null,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    reasoning_tokens: tokens.reasoning,
    cached_input_tokens: tokens.cachedInput,
    cache_write_tokens: tokens.cacheWrite,
    upstream_cost_micros: providerCostMicros,
    markup_amount_micros: markupAmountMicros,
    customer_charge_micros: customerChargeMicros,
    estimated_cost_micros: input.estimatedCostMicros != null
      ? Number(input.estimatedCostMicros) || 0
      : (costSource === COST_SOURCES.ESTIMATE ? providerCostMicros : 0),
    cost_source: costSource,
    payer_type: input.payerType || null,
    billing_source: billingSource,
    pricing_version: quote.pricingVersion,
    action_type: quote.actionType,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

export function publicUsageEvent(row) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    bot_id: row.bot_id,
    route_id: row.route_id,
    model_id: row.model_id,
    action: row.action_type,
    tokens: (row.input_tokens || 0) + (row.output_tokens || 0),
    amount_usd: formatUsd(row.customer_charge_micros || 0),
    amount_micros: row.customer_charge_micros || 0,
    payer: row.payer_type,
    created_at: row.created_at,
  };
}

export async function persistUsageEvent(event) {
  if (!event?.user_id || !serviceRoleConfigured()) {
    return { ok: true, skipped: true };
  }
  try {
    const res = await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/lykn_usage_events`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        id: event.id,
        user_id: event.user_id,
        chat_id: event.chat_id,
        bot_id: event.bot_id,
        request_id: event.request_id,
        route_id: event.route_id,
        gateway: event.gateway,
        upstream_provider: event.upstream_provider,
        model_id: event.model_id,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        reasoning_tokens: event.reasoning_tokens,
        cached_input_tokens: event.cached_input_tokens,
        cache_write_tokens: event.cache_write_tokens,
        upstream_cost_micros: event.upstream_cost_micros,
        markup_amount_micros: event.markup_amount_micros,
        customer_charge_micros: event.customer_charge_micros,
        estimated_cost_micros: event.estimated_cost_micros,
        cost_source: event.cost_source,
        payer_type: event.payer_type,
        billing_source: event.billing_source,
        pricing_version: event.pricing_version,
        action_type: event.action_type,
        metadata: event.metadata,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 409) return { ok: true, duplicate: true };
      console.warn('[usage-events] persist failed', res.status, body.slice(0, 180));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[usage-events] persist error', err?.message || err);
    return { ok: false, error: 'network' };
  }
}

export async function listUsageEvents(userId, { limit = 30 } = {}) {
  if (!userId || !serviceRoleConfigured()) return [];
  const safe = Math.max(1, Math.min(Number(limit) || 30, 100));
  const url = `${process.env.VITE_SUPABASE_URL}/rest/v1/lykn_usage_events`
    + `?user_id=eq.${encodeURIComponent(userId)}`
    + '&select=id,chat_id,bot_id,route_id,model_id,action_type,customer_charge_micros,payer_type,created_at,input_tokens,output_tokens'
    + `&order=created_at.desc&limit=${safe}`;
  const res = await fetch(url, { headers: adminHeaders() });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map(publicUsageEvent) : [];
}

export async function summarizeUsageEvents(userId) {
  const rows = await listUsageEvents(userId, { limit: 100 });
  const byBot = new Map();
  const byModel = new Map();
  let total = 0;
  for (const row of rows) {
    const amount = Number(row.amount_micros) || 0;
    total += amount;
    const botKey = row.bot_id || 'chat';
    byBot.set(botKey, (byBot.get(botKey) || 0) + amount);
    const modelKey = row.model_id || 'unknown';
    byModel.set(modelKey, (byModel.get(modelKey) || 0) + amount);
  }
  return {
    total_usd: formatUsd(total),
    total_micros: total,
    by_bot: [...byBot.entries()].map(([id, micros]) => ({ id, amount_usd: formatUsd(micros) })),
    by_model: [...byModel.entries()].map(([id, micros]) => ({ id, amount_usd: formatUsd(micros) })),
    recent: rows.slice(0, 20),
  };
}

// ── Daily spend series (customer charge only) ────────────────────────────────
// Category-level rollup for the billing page's chart. Deliberately coarse:
// no model ids, no providers, no raw cost — just what the customer was
// charged, per day, bucketed into a handful of product categories.

export const SPEND_CATEGORIES = Object.freeze(['chat', 'images', 'agents', 'other']);

export const SPEND_CATEGORY_LABELS = Object.freeze({
  chat: 'Chat',
  images: 'Images',
  agents: 'Agents & tools',
  other: 'Other',
});

export function spendCategory(actionType) {
  const a = String(actionType || '').toLowerCase();
  if (a.includes('image') || a.includes('vision')) return 'images';
  if (a.includes('agent') || a.includes('browser') || a.includes('task')
    || a.includes('build') || a.includes('tool') || a.includes('research')) return 'agents';
  if (a.includes('chat') || a.includes('glass') || a.includes('voice') || a.includes('stream')) return 'chat';
  return 'other';
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Last-N-days daily spend, grouped by product category. Empty days are
 * filled so the chart always renders a full window.
 */
export async function dailyUsageSpend(userId, { days = 30 } = {}) {
  const windowDays = Math.max(7, Math.min(Number(days) || 30, 90));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  // Pre-fill the window so missing days chart as zero.
  const byDay = new Map();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    byDay.set(dayKey(d), {
      date: dayKey(d),
      total_micros: 0,
      categories: { chat: 0, images: 0, agents: 0, other: 0 },
    });
  }

  if (userId && serviceRoleConfigured()) {
    const url = `${process.env.VITE_SUPABASE_URL}/rest/v1/lykn_usage_events`
      + `?user_id=eq.${encodeURIComponent(userId)}`
      + `&created_at=gte.${start.toISOString()}`
      + '&customer_charge_micros=gt.0'
      + '&select=action_type,customer_charge_micros,created_at'
      + '&order=created_at.desc&limit=5000';
    try {
      const res = await fetch(url, { headers: adminHeaders() });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        for (const row of Array.isArray(rows) ? rows : []) {
          const key = String(row.created_at || '').slice(0, 10);
          const day = byDay.get(key);
          if (!day) continue;
          const amount = Number(row.customer_charge_micros) || 0;
          day.total_micros += amount;
          day.categories[spendCategory(row.action_type)] += amount;
        }
      }
    } catch (err) {
      console.warn('[usage-events] daily spend query failed', err?.message || err);
    }
  }

  const series = [...byDay.values()];
  const totalMicros = series.reduce((sum, day) => sum + day.total_micros, 0);
  const categoryTotals = { chat: 0, images: 0, agents: 0, other: 0 };
  for (const day of series) {
    for (const cat of SPEND_CATEGORIES) categoryTotals[cat] += day.categories[cat];
  }
  const topCategory = SPEND_CATEGORIES
    .filter((cat) => categoryTotals[cat] > 0)
    .sort((a, b) => categoryTotals[b] - categoryTotals[a])[0] || null;

  return {
    days: series.map((day) => ({
      ...day,
      total_usd: formatUsd(day.total_micros),
    })),
    window_days: windowDays,
    total_micros: totalMicros,
    total_usd: formatUsd(totalMicros),
    daily_average_micros: Math.round(totalMicros / windowDays),
    daily_average_usd: formatUsd(Math.round(totalMicros / windowDays)),
    top_category: topCategory,
    top_category_label: topCategory ? SPEND_CATEGORY_LABELS[topCategory] : null,
    category_labels: SPEND_CATEGORY_LABELS,
  };
}

export async function recordNormalizedUsage(input) {
  const event = normalizeUsageEvent(input);
  const persist = persistUsageEvent(event);
  return { event, persist };
}
