/**
 * Prepaid Model Builder wallet — user pays for their own LoRA / provider costs.
 * LYKN does not subsidize Together training; balance is topped up via Stripe.
 */

export const MODEL_BUILDER_WALLET_MIN_TOPUP_CENTS = 500; // $5
export const MODEL_BUILDER_WALLET_MAX_TOPUP_CENTS = 500_00; // $500
export const MODEL_BUILDER_WALLET_PRESET_CENTS = [1000, 2500, 5000]; // $10, $25, $50

export function modelBuilderWalletEnabled() {
  return String(process.env.MODEL_BUILDER_WALLET_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

export function loraTrainingReserveCents() {
  const n = Number(process.env.MODEL_BUILDER_LORA_RESERVE_CENTS || 1000);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1000;
}

function parseRpcResult(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'invalid_rpc_response' };
  return data;
}

export async function getModelBuilderWallet(client, userId) {
  if (!client || !userId) {
    return { balance_cents: 0, currency: 'usd', enabled: modelBuilderWalletEnabled() };
  }
  const { data, error } = await client
    .from('lykn_model_builder_wallets')
    .select('balance_cents, currency, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    balance_cents: Number(data?.balance_cents || 0),
    currency: data?.currency || 'usd',
    updated_at: data?.updated_at || null,
    enabled: modelBuilderWalletEnabled(),
    lora_reserve_cents: loraTrainingReserveCents(),
    min_topup_cents: MODEL_BUILDER_WALLET_MIN_TOPUP_CENTS,
    preset_topup_cents: MODEL_BUILDER_WALLET_PRESET_CENTS,
  };
}

export async function applyWalletDelta(
  client,
  userId,
  { deltaCents, kind, referenceId = null, metadata = {} } = {},
) {
  if (!modelBuilderWalletEnabled()) {
    return { ok: true, balance_cents: 0, skipped: true };
  }
  const delta = Math.round(Number(deltaCents) || 0);
  if (!delta) return { ok: false, error: 'zero_delta' };

  const { data, error } = await client.rpc('lykn_model_builder_wallet_apply_delta', {
    p_user_id: userId,
    p_delta_cents: delta,
    p_kind: String(kind || 'adjustment').slice(0, 64),
    p_reference_id: referenceId ? String(referenceId).slice(0, 256) : null,
    p_metadata: metadata && typeof metadata === 'object' ? metadata : {},
  });
  if (error) throw new Error(error.message);
  return parseRpcResult(data);
}

export async function creditWalletFromStripe(client, userId, amountCents, stripeSessionId) {
  const cents = Math.round(Number(amountCents) || 0);
  if (cents < MODEL_BUILDER_WALLET_MIN_TOPUP_CENTS) {
    throw new Error('topup_below_minimum');
  }
  const result = await applyWalletDelta(client, userId, {
    deltaCents: cents,
    kind: 'stripe_topup',
    referenceId: stripeSessionId,
    metadata: { source: 'stripe_checkout' },
  });
  if (!result.ok && result.error === 'duplicate') {
    return result;
  }
  return result;
}

/** Hold estimated LoRA cost before starting a Together fine-tune job. */
export async function reserveWalletForLora(client, userId, jobId, amountCents = loraTrainingReserveCents()) {
  if (!modelBuilderWalletEnabled()) return { ok: true, skipped: true };
  const reserve = Math.round(Number(amountCents) || loraTrainingReserveCents());
  const result = await applyWalletDelta(client, userId, {
    deltaCents: -reserve,
    kind: 'lora_reserve',
    referenceId: jobId,
    metadata: { reserve_cents: reserve },
  });
  if (!result.ok) {
    const err = new Error(
      result.error === 'insufficient_balance'
        ? `Add funds to your Model Builder balance (need $${(reserve / 100).toFixed(2)}, have $${((result.balance_cents || 0) / 100).toFixed(2)}).`
        : 'Could not reserve Model Builder balance.',
    );
    err.code = result.error || 'wallet_error';
    err.balance_cents = result.balance_cents;
    err.required_cents = reserve;
    throw err;
  }
  return { ...result, reserve_cents: reserve };
}

/** Refund a LoRA reserve when training fails or is cancelled. */
export async function refundLoraReserve(client, userId, jobId, reserveCents) {
  if (!modelBuilderWalletEnabled()) return { ok: true, skipped: true };
  const reserve = Math.round(Number(reserveCents) || 0);
  if (!reserve) return { ok: true, skipped: true };

  const { data: existing } = await client
    .from('lykn_model_builder_wallet_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'lora_refund')
    .eq('reference_id', jobId)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, duplicate: true };

  return applyWalletDelta(client, userId, {
    deltaCents: reserve,
    kind: 'lora_refund',
    referenceId: jobId,
    metadata: { reserve_cents: reserve },
  });
}

export function formatUsdFromCents(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
