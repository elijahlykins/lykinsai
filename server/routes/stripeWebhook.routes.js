// ============================================================================
// server/routes/stripeWebhook.routes.js — Stripe webhook (raw-body boundary)
// ============================================================================
// ORDERING-SENSITIVE (Wave 7). This registrar MUST be called from the server
// bootstrap AFTER the CORS middleware and BEFORE the global branching JSON
// parser — Stripe requires the raw request body bytes to verify the HMAC
// signature, so req.body must still be a Buffer when the handler runs. The
// bootstrap call site in server.js is the position contract; the middleware
// manifest and tests/server/serverMiddlewareOrder.test.mjs pin it.
//
// Dependencies (bootstrap-owned, passed by identity):
//   stripe            — the Stripe client (null when STRIPE_SECRET_KEY unset)
//   handleStripeEvent — the billing event processor (stays in server.js with
//                       the rest of the shared billing infrastructure)

import express from 'express';

export function registerStripeWebhook(app, { stripe, handleStripeEvent }) {
  // ============================================
  // STRIPE WEBHOOK — must be mounted BEFORE express.json()
  // ============================================
  // Stripe requires the raw request body bytes to verify the HMAC signature.
  // Registering this route before the global JSON parser keeps req.body as a
  // Buffer here while every other route still gets parsed JSON.
  app.post(
    '/api/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      if (!stripe) {
        console.warn('⚠️ Stripe webhook hit but STRIPE_SECRET_KEY is not set');
        return res.status(503).json({ error: 'Stripe not configured' });
      }
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.warn('⚠️ Stripe webhook hit but STRIPE_WEBHOOK_SECRET is not set');
        return res.status(503).json({ error: 'Webhook secret not configured' });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          webhookSecret,
        );
      } catch (err) {
        console.warn('🔒 Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      try {
        await handleStripeEvent(event);
        res.json({ received: true });
      } catch (err) {
        console.error('❌ Stripe webhook handler threw:', err);
        // Return 500 so Stripe retries.
        res.status(500).json({ error: 'handler_failed' });
      }
    },
  );
}
