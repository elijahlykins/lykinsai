// App Store Server Notifications V2 — verification and decoding.
//
// Apple POSTs `{ signedPayload }` where signedPayload is a JWS. Unlike the
// Stripe webhook there is no shared secret: authenticity comes from an X.509
// certificate chain embedded in the JWS header, which has to be validated up
// to an Apple root before a single field of the payload may be believed. An
// unverified payload is attacker-controlled JSON that grants subscriptions,
// so this module never exposes a decode-without-verify path.
//
// The chain walking, OCSP checks and payload shape validation all come from
// Apple's own `@apple/app-store-server-library`. Hand-rolling any of it was
// considered and rejected: signature verification that is subtly wrong still
// looks like it works.
//
// The `data` object nests two FURTHER JWS blobs (signedTransactionInfo,
// signedRenewalInfo). verifyAndDecodeNotification does NOT verify those — it
// hands them back as opaque strings — so they get their own verification pass
// here. Trusting them because the envelope verified would defeat the point.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SignedDataVerifier,
  Environment,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// DER-encoded Apple roots, committed to the repo rather than fetched at boot:
// a network hiccup on startup must not silently turn signature verification
// off, and a root CA is exactly the kind of thing you want pinned by review
// rather than by whatever apple.com served that morning.
export const APPLE_ROOT_CERT_DIR = path.resolve(HERE, '../../certs/apple');

/**
 * Reads every DER certificate in `dir`. The whole directory is loaded rather
 * than a hardcoded filename so adding a root during an Apple CA rotation is a
 * file drop, not a code change.
 *
 * @returns {Buffer[]} DER buffers, empty if the directory is missing.
 */
export function loadAppleRootCertificates(dir = APPLE_ROOT_CERT_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.cer') || name.endsWith('.der'))
    .sort()
    .map((name) => readFileSync(path.join(dir, name)));
}

/**
 * Builds one verifier per App Store environment.
 *
 * Two are needed because SignedDataVerifier pins its environment and rejects a
 * notification from the other one outright — and both environments are real
 * traffic. Sandbox is not just developer noise: App Review runs its purchase
 * test in sandbox, and every TestFlight build transacts there too.
 *
 * `appAppleId` is only consulted for production (the library skips the check
 * in sandbox), but it must be right, or every production notification fails
 * as INVALID_APP_IDENTIFIER.
 *
 * @param {object} opts
 * @param {string}   opts.bundleId
 * @param {number}   [opts.appAppleId]
 * @param {Buffer[]} [opts.rootCertificates]
 * @param {boolean}  [opts.enableOnlineChecks] OCSP revocation + expiry against now
 * @returns {{production: SignedDataVerifier, sandbox: SignedDataVerifier}|null}
 *          null when the roots or bundle id are missing, i.e. not configured.
 */
export function createAppleNotificationVerifiers({
  bundleId,
  appAppleId,
  rootCertificates = loadAppleRootCertificates(),
  enableOnlineChecks = true,
} = {}) {
  if (!bundleId || !rootCertificates.length) return null;
  return {
    production: new SignedDataVerifier(
      rootCertificates, enableOnlineChecks, Environment.PRODUCTION, bundleId, appAppleId,
    ),
    sandbox: new SignedDataVerifier(
      rootCertificates, enableOnlineChecks, Environment.SANDBOX, bundleId,
    ),
  };
}

/**
 * Verifies a signedPayload and both of its nested JWS blobs.
 *
 * Production is attempted first and sandbox only on an explicit
 * INVALID_ENVIRONMENT — never as a blanket catch. Falling back on *any*
 * failure would mean a payload that failed its signature check in production
 * gets a second chance against a different verifier, which is the one thing
 * this function exists to prevent.
 *
 * @throws {VerificationException} if the payload cannot be trusted.
 * @returns {Promise<{environment: string, payload: object, transaction: object|null, renewalInfo: object|null}>}
 */
export async function verifyAppleNotification(signedPayload, verifiers) {
  let environment = Environment.PRODUCTION;
  let verifier = verifiers.production;
  let payload;
  try {
    payload = await verifier.verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    const wrongEnvironment = err instanceof VerificationException
      && err.status === VerificationStatus.INVALID_ENVIRONMENT;
    if (!wrongEnvironment) throw err;
    environment = Environment.SANDBOX;
    verifier = verifiers.sandbox;
    payload = await verifier.verifyAndDecodeNotification(signedPayload);
  }

  // TEST notifications and the summary/externalPurchaseToken shapes carry no
  // transaction, so absent is normal here — but present-and-unverifiable is
  // not, and throws.
  const signedTransaction = payload?.data?.signedTransactionInfo;
  const signedRenewal = payload?.data?.signedRenewalInfo;

  return {
    environment,
    payload,
    transaction: signedTransaction
      ? await verifier.verifyAndDecodeTransaction(signedTransaction)
      : null,
    renewalInfo: signedRenewal
      ? await verifier.verifyAndDecodeRenewalInfo(signedRenewal)
      : null,
  };
}

/**
 * Normalises a notification type onto the Stripe status vocabulary that
 * `user_billing.status` already speaks, so every downstream consumer
 * (hasAppAccessRow, the plan cache, /api/billing/me, the iOS client) stays
 * channel-blind. Returns null for notifications that say nothing about
 * entitlement — the caller records those and does not touch billing.
 */
export function appleStatusFor(notificationType, subtype) {
  const type = String(notificationType || '').toUpperCase();
  const sub = String(subtype || '').toUpperCase();

  switch (type) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
    case 'OFFER_REDEEMED':
      return 'active';

    // A plan change. The signed transaction always describes the CURRENTLY
    // paid-for product — an upgrade issues a new transaction immediately, a
    // downgrade keeps the old one until the period ends — so reading the plan
    // off the transaction is right for both directions with no special case.
    case 'DID_CHANGE_RENEWAL_PREF':
      return 'active';

    // Apple's "cancel at period end". Access continues to expiresDate, so the
    // subscription is still active; autoRenewOff carries the flag through and
    // EXPIRED closes it out later.
    case 'DID_CHANGE_RENEWAL_STATUS':
      return 'active';

    // Billing retry, with or without a grace period. Mapped to past_due either
    // way, deliberately: LYKN already keeps Stripe subscribers through dunning
    // rather than cutting them off the moment a card fails, and diverging by
    // channel would make the same customer's experience depend on where they
    // bought. Apple always follows up with EXPIRED or GRACE_PERIOD_EXPIRED, so
    // the window closes on its own.
    case 'DID_FAIL_TO_RENEW':
      return 'past_due';

    case 'GRACE_PERIOD_EXPIRED':
    case 'EXPIRED':
      return 'canceled';

    // Money returned. REFUND and REVOKE both carry a revocationDate, which
    // appleSyncInputFrom writes as the period end so access stops now rather
    // than running to the date the customer paid through.
    case 'REFUND':
    case 'REVOKE':
      return 'canceled';

    // The refund was undone — the customer is a subscriber again.
    case 'REFUND_REVERSED':
      return 'active';

    // Apple granted extra time (customer service gesture or a developer
    // extension request). Only the FAILURE subtype means nothing changed.
    case 'RENEWAL_EXTENDED':
      return sub === 'FAILURE' ? null : 'active';

    // Everything else — TEST, CONSUMPTION_REQUEST, REFUND_DECLINED,
    // PRICE_INCREASE, METADATA_UPDATE, ONE_TIME_CHARGE, EXTERNAL_PURCHASE_TOKEN
    // — reports something real but says nothing about entitlement.
    default:
      return null;
  }
}

/**
 * Turns a verified notification into the argument
 * `syncAppleSubscriptionToBilling` expects, or null when the notification is
 * not about a subscription's entitlement.
 *
 * Pure: no I/O, no clock, no Apple types. Everything above it is signature
 * checking; this is the only place notification semantics turn into billing
 * facts, which is what makes those semantics testable.
 */
export function appleSyncInputFrom({ payload, transaction, renewalInfo }) {
  const status = appleStatusFor(payload?.notificationType, payload?.subtype);
  if (!status || !transaction?.originalTransactionId) return null;

  // A refunded or revoked transaction carries revocationDate. Preferring it
  // over expiresDate is what stops a refunded customer keeping access for the
  // remainder of the period they were paid back for.
  const expiresDateMs = transaction.revocationDate ?? transaction.expiresDate ?? null;

  return {
    originalTransactionId: String(transaction.originalTransactionId),
    productId: transaction.productId || null,
    expiresDateMs,
    // Set by the iOS client at purchase time as `.appAccountToken`; it is the
    // Supabase user id and the only thing that can bootstrap the account link.
    // Renewal info repeats it, and later notifications in a subscription's life
    // sometimes carry it only there.
    appAccountToken: transaction.appAccountToken || renewalInfo?.appAccountToken || null,
    status,
    autoRenewOff: renewalInfo?.autoRenewStatus === 0,
  };
}
