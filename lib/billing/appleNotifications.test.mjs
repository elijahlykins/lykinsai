import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appleStatusFor,
  appleSyncInputFrom,
  loadAppleRootCertificates,
  createAppleNotificationVerifiers,
} from './appleNotifications.js';

// Signature verification itself is Apple's library and is tested there; what
// is ours — and what silently costs a customer their access if it is wrong —
// is the mapping from a verified notification to a billing fact. That mapping
// is pure, so it is tested directly rather than mirrored.

const ACCESS_GRANTING = ['trialing', 'active', 'past_due'];

function notification(notificationType, subtype = null) {
  return { notificationType, subtype };
}

function transaction(overrides = {}) {
  return {
    originalTransactionId: '2000000900000001',
    productId: 'io.lykn.app.sub.pro.month',
    appAccountToken: '3f7b1e10-9c4a-4a1e-8f2b-1a2b3c4d5e6f',
    expiresDate: 1_800_000_000_000,
    ...overrides,
  };
}

// ── appleStatusFor ──────────────────────────────────────────────────────────

test('a new subscription and every renewal grant access', () => {
  for (const type of ['SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED']) {
    assert.ok(ACCESS_GRANTING.includes(appleStatusFor(type)), `${type} should grant`);
  }
});

test('turning off auto-renew keeps access — it is cancel at period end', () => {
  // Apple's AUTO_RENEW_DISABLED is not a cancellation. Mapping it to canceled
  // would cut off a customer who has already paid through the period.
  assert.equal(appleStatusFor('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED'), 'active');
  assert.equal(appleStatusFor('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED'), 'active');
});

test('a plan change stays active in both directions', () => {
  assert.equal(appleStatusFor('DID_CHANGE_RENEWAL_PREF', 'UPGRADE'), 'active');
  assert.equal(appleStatusFor('DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE'), 'active');
});

test('billing retry is past_due whether or not Apple granted a grace period', () => {
  // Deliberate: LYKN carries Stripe subscribers through dunning, and the same
  // customer should not get a different answer for having bought on iOS.
  assert.equal(appleStatusFor('DID_FAIL_TO_RENEW', 'GRACE_PERIOD'), 'past_due');
  assert.equal(appleStatusFor('DID_FAIL_TO_RENEW', 'BILLING_RETRY'), 'past_due');
  assert.equal(appleStatusFor('DID_FAIL_TO_RENEW'), 'past_due');
});

test('past_due still grants access, so dunning does not lock anyone out', () => {
  assert.ok(ACCESS_GRANTING.includes(appleStatusFor('DID_FAIL_TO_RENEW', 'GRACE_PERIOD')));
});

test('lapses, refunds and revocations all cancel', () => {
  for (const type of ['EXPIRED', 'GRACE_PERIOD_EXPIRED', 'REFUND', 'REVOKE']) {
    assert.equal(appleStatusFor(type), 'canceled', `${type} should cancel`);
  }
});

test('a reversed refund restores the subscriber', () => {
  assert.equal(appleStatusFor('REFUND_REVERSED'), 'active');
});

test('a renewal extension grants, except when it failed', () => {
  assert.equal(appleStatusFor('RENEWAL_EXTENDED'), 'active');
  assert.equal(appleStatusFor('RENEWAL_EXTENDED', 'FAILURE'), null);
});

test('notifications that say nothing about entitlement map to null', () => {
  // null is the signal for "record it, do not touch billing". A stray status
  // here would let a refund request or a price-increase notice move a plan.
  for (const type of [
    'TEST', 'CONSUMPTION_REQUEST', 'REFUND_DECLINED', 'PRICE_INCREASE',
    'METADATA_UPDATE', 'EXTERNAL_PURCHASE_TOKEN', 'ONE_TIME_CHARGE', 'MIGRATION',
  ]) {
    assert.equal(appleStatusFor(type), null, `${type} should not touch billing`);
  }
  assert.equal(appleStatusFor(undefined), null);
  assert.equal(appleStatusFor(''), null);
});

test('unknown future notification types are ignored, not guessed at', () => {
  assert.equal(appleStatusFor('SOME_TYPE_APPLE_ADDS_IN_2027'), null);
});

// ── appleSyncInputFrom ──────────────────────────────────────────────────────

test('a purchase carries the account token that links it to a LYKN user', () => {
  const sync = appleSyncInputFrom({
    payload: notification('SUBSCRIBED', 'INITIAL_BUY'),
    transaction: transaction(),
    renewalInfo: { autoRenewStatus: 1 },
  });
  assert.equal(sync.appAccountToken, '3f7b1e10-9c4a-4a1e-8f2b-1a2b3c4d5e6f');
  assert.equal(sync.originalTransactionId, '2000000900000001');
  assert.equal(sync.productId, 'io.lykn.app.sub.pro.month');
  assert.equal(sync.status, 'active');
  assert.equal(sync.autoRenewOff, false);
});

test('the account token falls back to renewal info', () => {
  // Later notifications in a subscription's life sometimes carry it only there,
  // and without it an unlinked subscription can never be attributed.
  const sync = appleSyncInputFrom({
    payload: notification('DID_RENEW'),
    transaction: transaction({ appAccountToken: undefined }),
    renewalInfo: { appAccountToken: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', autoRenewStatus: 1 },
  });
  assert.equal(sync.appAccountToken, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('auto-renew off is carried through as cancel at period end', () => {
  const sync = appleSyncInputFrom({
    payload: notification('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED'),
    transaction: transaction(),
    renewalInfo: { autoRenewStatus: 0 },
  });
  assert.equal(sync.status, 'active');
  assert.equal(sync.autoRenewOff, true);
  assert.equal(sync.expiresDateMs, 1_800_000_000_000);
});

test('a refund ends access at the revocation date, not the paid-through date', () => {
  // The customer has their money back. Using expiresDate here would leave them
  // with a fully paid plan for the rest of the period they were refunded for.
  const revokedAt = 1_700_000_000_000;
  const sync = appleSyncInputFrom({
    payload: notification('REFUND'),
    transaction: transaction({ revocationDate: revokedAt, expiresDate: 1_800_000_000_000 }),
    renewalInfo: null,
  });
  assert.equal(sync.status, 'canceled');
  assert.equal(sync.expiresDateMs, revokedAt);
});

test('a family-sharing revoke behaves the same as a refund', () => {
  const sync = appleSyncInputFrom({
    payload: notification('REVOKE'),
    transaction: transaction({ revocationDate: 1_700_000_000_000 }),
    renewalInfo: null,
  });
  assert.equal(sync.expiresDateMs, 1_700_000_000_000);
});

test('a revocation date of 0 is still honoured', () => {
  // ?? not ||: epoch 0 is falsy, and coalescing it away would silently fall
  // through to expiresDate and keep a revoked subscription alive.
  const sync = appleSyncInputFrom({
    payload: notification('REFUND'),
    transaction: transaction({ revocationDate: 0, expiresDate: 1_800_000_000_000 }),
    renewalInfo: null,
  });
  assert.equal(sync.expiresDateMs, 0);
});

test('a notification with no entitlement meaning produces no billing write', () => {
  assert.equal(
    appleSyncInputFrom({ payload: notification('TEST'), transaction: null, renewalInfo: null }),
    null,
  );
  assert.equal(
    appleSyncInputFrom({
      payload: notification('CONSUMPTION_REQUEST'),
      transaction: transaction(),
      renewalInfo: null,
    }),
    null,
  );
});

test('a subscription-shaped notification with no transaction produces no write', () => {
  // originalTransactionId is the row key; without it there is nothing to
  // write against and syncAppleSubscriptionToBilling would no-op anyway.
  assert.equal(
    appleSyncInputFrom({
      payload: notification('SUBSCRIBED'),
      transaction: { productId: 'io.lykn.app.sub.pro.month' },
      renewalInfo: null,
    }),
    null,
  );
});

test('a numeric originalTransactionId is stringified for the text column', () => {
  const sync = appleSyncInputFrom({
    payload: notification('SUBSCRIBED'),
    transaction: transaction({ originalTransactionId: 2000000900000001 }),
    renewalInfo: null,
  });
  assert.equal(typeof sync.originalTransactionId, 'string');
});

// ── configuration ───────────────────────────────────────────────────────────

test('the Apple root certificates ship with the repo', () => {
  // Verification cannot run without them, and a missing root fails closed —
  // every notification 503s and no purchase ever grants anything.
  const roots = loadAppleRootCertificates();
  assert.ok(roots.length >= 1, 'expected at least one DER root in certs/apple');
  assert.ok(Buffer.isBuffer(roots[0]));
});

test('both environment verifiers are built', () => {
  // App Review and TestFlight transact in sandbox; live customers in
  // production. A verifier pins one environment and rejects the other.
  const verifiers = createAppleNotificationVerifiers({
    bundleId: 'io.lykn.app',
    appAppleId: 6765728365,
  });
  assert.ok(verifiers?.production);
  assert.ok(verifiers?.sandbox);
});

test('verification is disabled rather than bypassed when roots are missing', () => {
  assert.equal(
    createAppleNotificationVerifiers({ bundleId: 'io.lykn.app', rootCertificates: [] }),
    null,
  );
});
