// ============================================================================
// server/routes/appleNotifications.routes.js — App Store Server Notifications V2
// ============================================================================
// Apple's equivalent of the Stripe webhook, and the ONLY thing that turns an
// in-app purchase into access: StoreKit takes the money on device, then tells
// this server about it out of band. Without this route a purchase completes,
// the customer is charged, and nothing changes in their account.
//
// Configure the URL in App Store Connect under App Information → App Store
// Server Notifications, for BOTH the production and sandbox environments
// (same URL is fine — the payload identifies which one it came from).
//
// Unlike the Stripe webhook this does NOT need the raw body: Apple signs the
// payload as a JWS string inside ordinary JSON (`signedPayload`), so the
// route registers with the normal JSON-parsed routes. It IS an
// unauthenticated POST, so it takes the same perimeter webhook limiter.

import {
  createAppleNotificationVerifiers,
  verifyAppleNotification,
} from '../../lib/billing/appleNotifications.js';
import { handleAppleNotification } from '../services/billingService.js';

// Both identify the one app this server bills for, are identical in every
// environment, and are not secret — so they default in code rather than
// waiting on an env var that, if forgotten, would make every production
// notification fail as INVALID_APP_IDENTIFIER with no purchase ever landing.
// The env vars remain as an override.
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'io.lykn.app';
const APPLE_APP_APPLE_ID = Number(process.env.APPLE_APP_APPLE_ID || 6765728365);

export function registerAppleNotificationRoutes(app, { webhookLimiter }) {
  const verifiers = createAppleNotificationVerifiers({
    bundleId: APPLE_BUNDLE_ID,
    appAppleId: APPLE_APP_APPLE_ID,
  });
  console.log(
    '  Apple IAP notifications:',
    verifiers
      ? `✅ ${APPLE_BUNDLE_ID} (${APPLE_APP_APPLE_ID})`
      : '❌ Disabled — no Apple root certificates in certs/apple',
  );

  app.post('/api/billing/apple/notifications', webhookLimiter, async (req, res) => {
    if (!verifiers) {
      console.error('❌ Apple notification received but verification is not configured');
      return res.status(503).json({ error: 'Apple notifications not configured' });
    }

    const signedPayload = req.body?.signedPayload;
    if (typeof signedPayload !== 'string' || !signedPayload) {
      return res.status(400).json({ error: 'Missing signedPayload' });
    }

    let verified;
    try {
      verified = await verifyAppleNotification(signedPayload, verifiers);
    } catch (err) {
      // 400, never 500: the signature is bad, so redelivering the identical
      // bytes cannot help. Apple retries on 5xx, and a forged payload must not
      // be able to make us retry a workload on demand.
      console.warn('🔒 Apple notification verification failed:', err?.message || err);
      return res.status(400).json({ error: 'verification_failed' });
    }

    try {
      await handleAppleNotification(verified);
      return res.json({ received: true });
    } catch (err) {
      console.error('❌ Apple notification handler threw:', err);
      // 500 so Apple redelivers — the notification is unrecorded, so the retry
      // runs the whole handler again.
      return res.status(500).json({ error: 'handler_failed' });
    }
  });
}
