// BILLING ROUTES — extracted verbatim from server.js (Wave 6).
//
// 9 routes: GET /api/billing/me, POST checkout, GET credits, POST topup,
// GET stripe-config (public — DEFERRED BILLING FINDING, keep public),
// POST trial-checkout, POST portal, GET+POST waitlist.
//
// The Stripe WEBHOOK is NOT here: it registers before the global JSON
// parser in bootstrap (raw-body position is load-bearing) and stays there.
//
// Dependency notes — everything billing-shared stays in server.js and is
// passed via deps, because the webhook handler (handleStripeEvent →
// syncSubscriptionToBilling), requireAppAccess, and checkAiUsageLimit use
// the same helpers/caches (userPlanCache, appAccessGrace never moved):
// - stripe / supabaseAdmin / requireAuth are bootstrap singletons.
// - PLAN_LIMITS / creditPackById come from src/lib/pricing-config.js —
//   passed via deps so the frontend-config import edge stays in server.js
//   only (cross-boundary config ownership is a later phase, not this Wave).
// - getCreditWallet (lib/billing/creditWallet.js) is a stateless module
//   function; ESM module cache preserves identity, direct import.
// - isCompedProEmail / COMPED_PRO_PLAN_ID implement the comped-email
//   shortcut — DEFERRED BILLING FINDING, behavior preserved exactly.
import { z, validate } from '../../validation.js';
import { getCreditWallet } from '../../lib/billing/creditWallet.js';
import {
  customerUsagePayload,
  ensureSignupGrant,
  getUsageBalance,
  listUsageHistory,
  monthUsageSpent,
  usageBucketBreakdown,
} from '../../lib/billing/usageBalance.js';
import { normalizeUsageFundRequest, usageFundingPresets } from '../../lib/billing/usageFunding.js';
import { assertProCheckoutPriceNotLegacy } from '../../lib/billing/stripePriceConfig.js';
import { USAGE_FUNDING } from '../../lib/billing/usagePricing.js';
export function registerBillingRoutes(app, deps) {
  const {
    requireAuth,
    stripe,
    supabaseAdmin,
    stripeConfigured,
    loadBillingRow,
    appUrlFromReq,
    billingMePayload,
    hasSubscriptionAccess,
    channelConflict,
    hasEstablishedStripeCustomer,
    resolveUserPlan,
    buildStripeCheckoutIdentity,
    rejectIneligibleStudentCheckout,
    isCompedProEmail,
    COMPED_PRO_PLAN_ID,
    PLAN_IDS,
    BILLING_PERIODS,
    PLAN_LIMITS,
    creditPackById,
    availableCreditPacks,
    STRIPE_PRICE_MAP,
    STRIPE_TOPUP_PRICE_MAP,
    STRIPE_TRIAL_DAYS,
    trialCheckoutCustomText,
  } = deps;

  // ── /api/billing/me ─────────────────────────────────────────────────────────
  app.get('/api/billing/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      // Comped team accounts are reported as active Studio Pro to the client so
      // useUserPlan / PlanGate / model picker all unlock the same as a paying
      // sub. We still surface the underlying Stripe customer (if any) so the
      // billing portal link keeps working for them.
      if (isCompedProEmail(req.user?.email)) {
        const row = await loadBillingRow(userId);
        return res.json(
          billingMePayload(row || { plan: COMPED_PRO_PLAN_ID, status: 'active' }, {
            plan: COMPED_PRO_PLAN_ID,
            billing_period: null,
            status: 'active',
            current_period_end: null,
            cancel_at_period_end: false,
            has_active_subscription: true,
            needs_trial_checkout: false,
            comped: true,
          }),
        );
      }

      const row = await loadBillingRow(userId);
      const payload = billingMePayload(row);
      // Free accounts run on the dollar Usage Balance. Make sure the one-time
      // $10 signup grant exists (idempotent no-op afterwards), then let a
      // positive balance satisfy the client gate — no forced card wall.
      if (payload.needs_trial_checkout) {
        await ensureSignupGrant(userId).catch(() => {});
        const usage = await getUsageBalance(userId);
        payload.usage_balance = {
          available_micros: usage?.available || 0,
          available_usd: usage?.display || '$0.00',
        };
        if ((usage?.available || 0) > 0) {
          payload.needs_trial_checkout = false;
        }
      }
      // Leftover purchased legacy credits keep access until the migration
      // converts them to Usage dollars.
      if (payload.needs_trial_checkout) {
        const wallet = await getCreditWallet(userId);
        if (wallet && wallet.balance > 0) {
          payload.needs_trial_checkout = false;
        }
      }
      payload.out_of_usage = payload.needs_trial_checkout;
      payload.needs_trial_checkout = false;
      if (payload.out_of_usage) payload.add_funds = true;
      return res.json(payload);
    } catch (err) {
      console.error('❌ /api/billing/me error:', err);
      return res.status(500).json({ error: 'Failed to load billing' });
    }
  });

  // ── /api/billing/iap-eligibility ────────────────────────────────────────────
  // The Apple-side half of the one-channel rule. The iOS app calls this BEFORE
  // presenting the StoreKit purchase sheet: once Apple has taken the money the
  // only remedies are a refund or a double-billed user, so the block has to
  // happen before the sheet, not after the transaction.
  //
  // Deliberately a plain GET with no side effects — it is safe to call on every
  // presentation of the upgrade sheet.
  app.get('/api/billing/iap-eligibility', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      // Comped accounts have no subscription to conflict with, but also nothing
      // to sell — report ineligible so the app doesn't offer a pointless purchase.
      if (isCompedProEmail(req.user?.email)) {
        return res.json({
          eligible: false,
          reason: 'comped_account',
          message: 'Your account already has full access.',
        });
      }

      const row = await loadBillingRow(userId);
      const conflict = channelConflict(row, 'apple');
      if (conflict) {
        return res.json({ eligible: false, reason: conflict.code, message: conflict.message });
      }
      return res.json({ eligible: true, reason: null, message: null });
    } catch (err) {
      console.error('❌ /api/billing/iap-eligibility error:', err);
      return res.status(500).json({ error: 'Failed to check eligibility' });
    }
  });

  // ── /api/billing/checkout (subscription) ────────────────────────────────────
  // SECURITY (Agent 04): Zod-narrow planId + period to the declared sets BEFORE
  // the handler runs. PLAN_IDS / BILLING_PERIODS are still consulted below as
  // DiD; the schema is the perimeter check.
  const billingCheckoutSchema = z.object({
    planId: z.string().min(1).max(64),
    period: z.string().min(1).max(64),
    source: z.enum(['ios', 'web']).optional(),
  });

  app.post('/api/billing/checkout', requireAuth, validate(billingCheckoutSchema), async (req, res) => {
    try {
      if (!stripeConfigured()) return res.status(503).json({ error: 'Stripe not configured' });
      const user = req.user;
      const { planId, period } = req.body;
      if (!PLAN_IDS.has(planId)) return res.status(400).json({ error: 'invalid_plan' });
      if (!BILLING_PERIODS.has(period)) return res.status(400).json({ error: 'invalid_period' });
      if (await rejectIneligibleStudentCheckout(req, res, planId)) return;

      const priceId = STRIPE_PRICE_MAP[planId]?.[period];
      if (!priceId) {
        return res.status(500).json({
          error: 'price_not_configured',
          message: `Missing env var for ${planId}/${period} price id`,
        });
      }
      if ((planId === 'studio' || planId === 'studio_pro') && period === 'monthly') {
        const priceGuard = assertProCheckoutPriceNotLegacy(priceId);
        if (!priceGuard.ok) {
          return res.status(500).json({
            error: 'price_misconfigured',
            message: 'Pro monthly checkout is pointed at the legacy $25 Price. Set STRIPE_PRICE_STUDIO_MONTHLY to the $20 Price.',
          });
        }
      }

      const row = await loadBillingRow(user.id);

      // Cross-channel guard FIRST. An App Store subscriber also trips the
      // already_subscribed branch below, but that reply tells them to open the
      // Stripe billing portal — which cannot manage an Apple subscription and
      // would strand them. Answer with the channel-correct instruction instead.
      const conflict = channelConflict(row, 'stripe');
      if (conflict) {
        return res.status(409).json({
          error: conflict.code,
          use_portal: false,
          message: conflict.message,
        });
      }

      // A user with a live subscription must change plans through the Stripe
      // billing portal (prorated update on the EXISTING subscription). Letting
      // them through Checkout would create a second, parallel subscription and
      // double-charge them. 409 + use_portal tells the client to open the
      // portal instead.
      if (hasSubscriptionAccess(row)) {
        return res.status(409).json({
          error: 'already_subscribed',
          use_portal: true,
          message: 'You already have an active subscription. Manage your plan from the billing portal.',
        });
      }

      const checkoutIdentity = await buildStripeCheckoutIdentity(user, row);
      const appUrl = appUrlFromReq(req);

      // iOS-initiated checkouts (Safari, arriving from the app's external
      // purchase link) return to the AASA-whitelisted /billing/success and
      // /billing/cancel paths, whose pages offer a "Return to LYKN" hand-off
      // back into the app. Web checkouts keep the query-param round-trip that
      // Billing.jsx already handles.
      const fromIOS = req.body.source === 'ios';
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        ...checkoutIdentity,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: fromIOS
          ? `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`
          : `${appUrl}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: fromIOS
          ? `${appUrl}/billing/cancel`
          : `${appUrl}/billing?checkout=canceled`,
        client_reference_id: user.id,
        allow_promotion_codes: true,
        metadata: { supabase_user_id: user.id, plan: planId, period },
        subscription_data: {
          metadata: { supabase_user_id: user.id, plan: planId, period },
        },
      });

      return res.json({ url: session.url });
    } catch (err) {
      console.error('❌ /api/billing/checkout error:', err);
      if (String(err?.message || '').includes('checkout_email_required')) {
        return res.status(400).json({ error: 'checkout_email_required' });
      }
      return res.status(500).json({ error: 'checkout_failed' });
    }
  });


  // ── /api/billing/credits ────────────────────────────────────────────────────
  // Everything the billing settings screen needs: plan, dollar Usage Balance
  // with its bucket breakdown, recent activity, and the top-up options. Kept
  // off /api/billing/me because that route runs on every app load.
  //
  // The path keeps its historical name for client compatibility; the payload
  // is Usage Balance, not credits. Legacy wallet balances only appear while a
  // pre-migration remainder exists.
  app.get('/api/billing/credits', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { planId } = await resolveUserPlan(userId, req.user?.email);
      const includedChat = Boolean(PLAN_LIMITS[planId]?.unlimitedNormalChat);

      const [wallet, usage, history] = await Promise.all([
        getCreditWallet(userId),
        getUsageBalance(userId),
        listUsageHistory(userId, 20),
      ]);
      const [month, breakdown] = await Promise.all([
        monthUsageSpent(userId, history),
        usageBucketBreakdown(userId, usage),
      ]);

      return res.json({
        plan: planId,
        included_chat: includedChat,
        usage: customerUsagePayload(usage, history, month),
        bucket_breakdown: breakdown,
        funding: {
          presets: usageFundingPresets(),
          min_cents: USAGE_FUNDING.minCents,
          max_cents: USAGE_FUNDING.maxCents,
          custom: true,
        },
        // Pre-migration leftovers only; the UI shows a conversion notice.
        legacy_credits: wallet && wallet.balance > 0 ? { balance: wallet.balance } : null,
      });
    } catch (err) {
      console.error('❌ /api/billing/credits error:', err);
      return res.status(500).json({ error: 'Failed to load usage balance' });
    }
  });

  // ── /api/billing/topup (one-time credit purchase) ───────────────────────────
  const billingTopupSchema = z.object({
    packId: z.string().min(1).max(64),
  });

  app.post('/api/billing/topup', requireAuth, validate(billingTopupSchema), async (req, res) => {
    try {
      if (availableCreditPacks().length === 0) {
        return res.status(410).json({
          error: 'credit_packs_retired',
          message: 'Credit packs are no longer for sale. Add funds to your Usage Balance instead.',
          add_funds: true,
        });
      }
      if (!stripeConfigured()) return res.status(503).json({ error: 'Stripe not configured' });
      const user = req.user;
      const pack = creditPackById(req.body.packId);
      if (!pack) return res.status(400).json({ error: 'invalid_pack' });

      const priceId = STRIPE_TOPUP_PRICE_MAP[pack.id];
      if (!priceId) {
        return res.status(503).json({
          error: 'topup_not_configured',
          message: `Missing env var ${pack.envVar} (one-time Stripe price id for ${pack.name})`,
        });
      }

      const row = await loadBillingRow(user.id);
      const checkoutIdentity = await buildStripeCheckoutIdentity(user, row);
      const appUrl = appUrlFromReq(req);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        ...checkoutIdentity,
        // Keep a customer on file for a first-time buyer so a later subscription
        // reuses it instead of creating a second Stripe customer.
        ...(checkoutIdentity.customer ? {} : { customer_creation: 'always' }),
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/billing?topup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/billing?topup=canceled`,
        client_reference_id: user.id,
        // The webhook re-derives the credit amount from pack_id rather than
        // trusting a number in metadata.
        metadata: { supabase_user_id: user.id, topup_pack: pack.id },
        payment_intent_data: {
          metadata: { supabase_user_id: user.id, topup_pack: pack.id },
        },
      });

      return res.json({ url: session.url });
    } catch (err) {
      console.error('❌ /api/billing/topup error:', err);
      if (String(err?.message || '').includes('checkout_email_required')) {
        return res.status(400).json({ error: 'checkout_email_required' });
      }
      return res.status(500).json({ error: 'topup_failed' });
    }
  });

  const usageFundSchema = z.object({
    presetCents: z.number().int().optional(),
    amountCents: z.number().int().optional(),
  });

  app.post('/api/billing/usage/fund', requireAuth, validate(usageFundSchema), async (req, res) => {
    try {
      if (!stripeConfigured()) return res.status(503).json({ error: 'Stripe not configured' });
      const parsed = normalizeUsageFundRequest(req.body || {});
      if (!parsed.ok) {
        console.log(`[billing] usage_funding_rejected ${JSON.stringify({ error: parsed.error })}`);
        return res.status(400).json({ error: parsed.error, message: parsed.message });
      }

      const user = req.user;
      const row = await loadBillingRow(user.id);
      const checkoutIdentity = await buildStripeCheckoutIdentity(user, row);
      const appUrl = appUrlFromReq(req);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        ...checkoutIdentity,
        ...(checkoutIdentity.customer ? {} : { customer_creation: 'always' }),
        line_items: [{
          price_data: {
            currency: parsed.currency,
            unit_amount: parsed.cents,
            product_data: {
              name: 'LYKN Usage Balance',
              description: `Add ${parsed.display} to your Usage Balance`,
            },
          },
          quantity: 1,
        }],
        success_url: `${appUrl}/billing?usage_fund=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/billing?usage_fund=canceled`,
        client_reference_id: user.id,
        metadata: {
          supabase_user_id: user.id,
          usage_funding: '1',
        },
        payment_intent_data: {
          metadata: {
            supabase_user_id: user.id,
            usage_funding: '1',
          },
        },
      });

      return res.json({ url: session.url, amount_cents: parsed.cents, display: parsed.display });
    } catch (err) {
      console.error('❌ /api/billing/usage/fund error:', err);
      if (String(err?.message || '').includes('checkout_email_required')) {
        return res.status(400).json({ error: 'checkout_email_required' });
      }
      return res.status(500).json({ error: 'usage_fund_failed' });
    }
  });


  function stripePublishableKey() {
    return (
      process.env.STRIPE_PUBLISHABLE_KEY ||
      process.env.VITE_STRIPE_PUBLISHABLE_KEY ||
      ''
    ).trim();
  }

  // ── /api/billing/stripe-config (public publishable key for embedded checkout) ─
  app.get('/api/billing/stripe-config', (_req, res) => {
    const publishableKey = stripePublishableKey();
    if (!publishableKey) {
      return res.status(503).json({ error: 'stripe_not_configured' });
    }
    return res.json({ publishableKey });
  });

  // ── /api/billing/trial-checkout (free trial, card required; length = STRIPE_TRIAL_DAYS) ──
  app.post('/api/billing/trial-checkout', requireAuth, async (req, res) => {
    try {
      if (!stripeConfigured()) {
        return res.status(503).json({ error: 'stripe_not_configured' });
      }
      const user = req.user;
      if (isCompedProEmail(user?.email)) {
        return res.status(400).json({ error: 'already_subscribed' });
      }

      const row = await loadBillingRow(user.id);
      const trialConflict = channelConflict(row, 'stripe');
      if (trialConflict) {
        return res.status(409).json({
          error: trialConflict.code,
          message: trialConflict.message,
        });
      }
      if (hasSubscriptionAccess(row)) {
        return res.status(400).json({ error: 'already_subscribed' });
      }

      // Plan + period are chosen on the trial screen (the billing-style plan
      // picker). Default to Pro/annual (the $17/mo headline rate).
      const requestedPlan = String(req.body?.plan || 'studio').toLowerCase();
      const planId = PLAN_IDS.has(requestedPlan) ? requestedPlan : 'studio';
      if (await rejectIneligibleStudentCheckout(req, res, planId)) return;
      const requestedPeriod = String(req.body?.period || 'annual').toLowerCase();
      const period = BILLING_PERIODS.has(requestedPeriod) ? requestedPeriod : 'annual';
      const priceId = STRIPE_PRICE_MAP[planId]?.[period];
      if (!priceId) {
        return res.status(503).json({
          error: 'price_not_configured',
          message: `Missing env var for ${planId}/${period} price id`,
        });
      }

      const checkoutIdentity = await buildStripeCheckoutIdentity(user, row);
      const appUrl = appUrlFromReq(req);
      const mode = String(req.body?.mode || 'embedded').toLowerCase() === 'hosted'
        ? 'hosted'
        : 'embedded';

      const sessionParams = {
        mode: 'subscription',
        ...checkoutIdentity,
        line_items: [{ price: priceId, quantity: 1 }],
        payment_method_collection: 'always',
        client_reference_id: user.id,
        allow_promotion_codes: true,
        custom_text: trialCheckoutCustomText(STRIPE_TRIAL_DAYS),
        metadata: {
          supabase_user_id: user.id,
          plan: planId,
          period,
          trial: 'true',
        },
        subscription_data: {
          trial_period_days: STRIPE_TRIAL_DAYS,
          metadata: {
            supabase_user_id: user.id,
            plan: planId,
            period,
            trial: 'true',
          },
        },
      };

      if (mode === 'hosted') {
        sessionParams.success_url = `${appUrl}/start-trial?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
        sessionParams.cancel_url = `${appUrl}/start-trial?checkout=canceled`;
      } else {
        sessionParams.ui_mode = 'embedded';
        sessionParams.return_url = `${appUrl}/start-trial?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      return res.json({
        mode,
        client_secret: session.client_secret || null,
        url: session.url || null,
        trial_days: STRIPE_TRIAL_DAYS,
      });
    } catch (err) {
      console.error('❌ /api/billing/trial-checkout error:', err);
      if (String(err?.message || '').includes('checkout_email_required')) {
        return res.status(400).json({ error: 'checkout_email_required' });
      }
      return res.status(500).json({ error: 'checkout_failed' });
    }
  });

  // ── /api/billing/portal (manage subscription / cards / invoices) ────────────
  // Optional body.flow:
  //   • 'cancel' — deep-link into Stripe's subscription_cancel portal flow so
  //     Settings / Billing "Cancel subscription" lands on the cancel confirm
  //     screen instead of the generic portal home.
  app.post('/api/billing/portal', requireAuth, async (req, res) => {
    try {
      if (!stripeConfigured()) return res.status(503).json({ error: 'Stripe not configured' });
      const row = await loadBillingRow(req.user.id);
      if (!hasEstablishedStripeCustomer(row)) {
        return res.status(400).json({ error: 'no_customer', message: 'No Stripe customer yet.' });
      }
      const appUrl = appUrlFromReq(req);
      const flow = String(req.body?.flow || '').toLowerCase();
      const sessionParams = {
        customer: row.stripe_customer_id,
        return_url: `${appUrl}/billing`,
      };
      if (flow === 'cancel') {
        if (!row.stripe_subscription_id || !hasSubscriptionAccess(row)) {
          return res.status(400).json({
            error: 'no_active_subscription',
            message: 'No active subscription to cancel.',
          });
        }
        sessionParams.flow_data = {
          type: 'subscription_cancel',
          subscription_cancel: {
            subscription: row.stripe_subscription_id,
          },
        };
      }
      const portal = await stripe.billingPortal.sessions.create(sessionParams);
      return res.json({ url: portal.url });
    } catch (err) {
      console.error('❌ /api/billing/portal error:', err);
      return res.status(500).json({ error: 'portal_failed' });
    }
  });

  // ── /api/billing/waitlist (Studio Max sign-ups) ─────────────────────────────
  // Writes to `public.studio_max_waitlist` via the service role so clients can't
  // tamper with rows. GET returns whether the current user is already on the
  // list so the pricing card can render a "You're on the list" confirmed state.

  const WAITLIST_NOTE_MAX = 2000;

  app.get('/api/billing/waitlist', requireAuth, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'db_not_configured' });
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      const { data, error } = await supabaseAdmin
        .from('studio_max_waitlist')
        .select('email, note, created_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        console.error('❌ waitlist get error:', error.message);
        return res.status(500).json({ error: 'waitlist_get_failed' });
      }
      return res.json({
        joined: Boolean(data),
        entry: data
          ? { email: data.email, note: data.note, created_at: data.created_at }
          : null,
      });
    } catch (err) {
      console.error('❌ /api/billing/waitlist GET error:', err);
      return res.status(500).json({ error: 'waitlist_get_failed' });
    }
  });

  // SECURITY (Agent 04): Zod schema length-caps both fields and strips unknown
  // keys (so a misshapen body can't smuggle metadata or user_id past).
  const waitlistSchema = z.object({
    email: z.string().email().max(320).optional(),
    note: z.string().max(WAITLIST_NOTE_MAX).optional(),
  });

  app.post('/api/billing/waitlist', requireAuth, validate(waitlistSchema), async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'db_not_configured' });
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const rawEmail = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      // Fall back to the auth email if the client didn't send one.
      const email = (rawEmail || req.user?.email || '').trim().toLowerCase();
      if (!email || !email.includes('@') || email.length > 320) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      const note = typeof req.body.note === 'string' ? req.body.note.trim() : null;

      const metadata = {
        ua: String(req.headers['user-agent'] || '').slice(0, 500),
        ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
      };

      // Upsert on user_id so double-clicks and re-edits don't create dupes.
      const { data, error } = await supabaseAdmin
        .from('studio_max_waitlist')
        .upsert(
          { user_id: userId, email, note, metadata },
          { onConflict: 'user_id' },
        )
        .select('email, note, created_at')
        .single();

      if (error) {
        console.error('❌ waitlist upsert error:', error.message);
        return res.status(500).json({ error: 'waitlist_save_failed' });
      }

      return res.json({
        ok: true,
        joined: true,
        entry: { email: data.email, note: data.note, created_at: data.created_at },
      });
    } catch (err) {
      console.error('❌ /api/billing/waitlist POST error:', err);
      return res.status(500).json({ error: 'waitlist_save_failed' });
    }
  });
}
