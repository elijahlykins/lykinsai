// ============================================================================
// Model Builder wallet — user-funded balance for LoRA / provider costs
// ============================================================================

import { z } from 'zod';
import {
  getModelBuilderWallet,
  MODEL_BUILDER_WALLET_MAX_TOPUP_CENTS,
  MODEL_BUILDER_WALLET_MIN_TOPUP_CENTS,
  MODEL_BUILDER_WALLET_PRESET_CENTS,
  modelBuilderWalletEnabled,
} from './lib/modelBuilder/modelBuilderWallet.js';

const topupSchema = z.object({
  amount_cents: z.number().int().optional(),
  amount_usd: z.number().positive().optional(),
}).refine((b) => b.amount_cents != null || b.amount_usd != null, {
  message: 'amount_cents or amount_usd required',
});

function resolveTopupCents(body) {
  if (body.amount_cents != null) return Math.round(body.amount_cents);
  return Math.round(Number(body.amount_usd) * 100);
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   requireAuth: Function,
 *   supabaseAdmin: object,
 *   stripe: object | null,
 *   stripeConfigured: () => boolean,
 *   buildStripeCheckoutIdentity: (user: object, row: object) => Promise<object>,
 *   loadBillingRow: (userId: string) => Promise<object | null>,
 *   appUrlFromReq: (req: object) => string,
 *   validate: Function,
 * }} deps
 */
export function registerModelBuilderWalletRoutes(app, deps) {
  const {
    requireAuth,
    supabaseAdmin,
    stripe,
    stripeConfigured,
    buildStripeCheckoutIdentity,
    loadBillingRow,
    appUrlFromReq,
    validate,
  } = deps;

  console.log('→ Model Builder wallet: /api/v1/model-builder/wallet registered');

  app.get('/api/v1/model-builder/wallet', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      res.setHeader('Cache-Control', 'no-store');
      const wallet = await getModelBuilderWallet(supabaseAdmin, userId);

      const { data: ledger, error: ledgerErr } = await supabaseAdmin
        .from('lykn_model_builder_wallet_ledger')
        .select('id, amount_cents, kind, reference_id, metadata, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (ledgerErr) throw new Error(ledgerErr.message);

      return res.json({
        ...wallet,
        stripe_topup_available: stripeConfigured(),
        recent_ledger: ledger || [],
      });
    } catch (e) {
      console.error('❌ GET model-builder/wallet:', e?.message || e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  app.post(
    '/api/v1/model-builder/wallet/checkout',
    requireAuth,
    validate(topupSchema),
    async (req, res) => {
      try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!modelBuilderWalletEnabled()) {
          return res.status(503).json({ error: 'wallet_disabled' });
        }
        if (!stripeConfigured() || !stripe) {
          return res.status(503).json({ error: 'stripe_not_configured' });
        }

        const amountCents = resolveTopupCents(req.body);
        if (amountCents < MODEL_BUILDER_WALLET_MIN_TOPUP_CENTS) {
          return res.status(400).json({
            error: 'amount_too_low',
            min_cents: MODEL_BUILDER_WALLET_MIN_TOPUP_CENTS,
          });
        }
        if (amountCents > MODEL_BUILDER_WALLET_MAX_TOPUP_CENTS) {
          return res.status(400).json({
            error: 'amount_too_high',
            max_cents: MODEL_BUILDER_WALLET_MAX_TOPUP_CENTS,
          });
        }

        const row = await loadBillingRow(userId);
        const checkoutIdentity = await buildStripeCheckoutIdentity(req.user, row);
        const appUrl = appUrlFromReq(req);
        const amountUsd = (amountCents / 100).toFixed(2);

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          ...checkoutIdentity,
          line_items: [
            {
              price_data: {
                currency: 'usd',
                unit_amount: amountCents,
                product_data: {
                  name: 'LYKN Model Builder balance',
                  description:
                    `Prepaid balance for your custom model (LoRA training & inference). $${amountUsd} added to your wallet.`,
                },
              },
              quantity: 1,
            },
          ],
          success_url: `${appUrl}/model-builder?wallet=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/model-builder?wallet=canceled`,
          client_reference_id: userId,
          metadata: {
            purpose: 'model_builder_wallet',
            supabase_user_id: userId,
            amount_cents: String(amountCents),
          },
        });

        return res.json({
          url: session.url,
          amount_cents: amountCents,
          presets_cents: MODEL_BUILDER_WALLET_PRESET_CENTS,
        });
      } catch (e) {
        console.error('❌ POST model-builder/wallet/checkout:', e?.message || e);
        if (String(e?.message || '').includes('checkout_email_required')) {
          return res.status(400).json({ error: 'checkout_email_required' });
        }
        return res.status(500).json({ error: 'checkout_failed' });
      }
    },
  );
}

/** Stripe webhook: credit wallet after one-time checkout. */
export async function handleModelBuilderWalletCheckoutCompleted(supabaseAdmin, session) {
  if (!supabaseAdmin || !session) return false;
  if (session.mode !== 'payment') return false;
  if (session.metadata?.purpose !== 'model_builder_wallet') return false;

  const userId = String(
    session.client_reference_id || session.metadata?.supabase_user_id || '',
  ).trim();
  const amountCents = Math.round(
    Number(session.metadata?.amount_cents || session.amount_total || 0),
  );
  if (!userId || amountCents < 1) {
    console.warn('⚠️ model_builder_wallet checkout missing user or amount');
    return false;
  }

  const { creditWalletFromStripe } = await import('./lib/modelBuilder/modelBuilderWallet.js');

  const ref = String(session.id || '');
  const { data: dup } = await supabaseAdmin
    .from('lykn_model_builder_wallet_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'stripe_topup')
    .eq('reference_id', ref)
    .maybeSingle();
  if (dup) {
    console.log(`💳 Model Builder wallet top-up already applied (${ref})`);
    return true;
  }

  const result = await creditWalletFromStripe(supabaseAdmin, userId, amountCents, ref);
  if (!result.ok) {
    console.error('❌ Model Builder wallet credit failed:', result);
    return false;
  }
  console.log(
    `💳 Model Builder wallet +$${(amountCents / 100).toFixed(2)} for ${userId} (balance ${result.balance_cents}c)`,
  );
  return true;
}
