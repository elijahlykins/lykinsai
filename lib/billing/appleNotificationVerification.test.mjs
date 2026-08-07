import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SignedDataVerifier, Environment } from '@apple/app-store-server-library';
import {
  verifyAppleNotification,
  appleSyncInputFrom,
  loadAppleRootCertificates,
} from './appleNotifications.js';

// End-to-end verification against a real certificate chain.
//
// appleNotifications.test.mjs covers the decode logic with plain objects; this
// file covers the part that stands between an attacker and a free Max plan.
// The fixtures are signed by a throwaway CA (scripts/generate-apple-
// notification-fixtures.mjs) that satisfies every rule Apple's library
// enforces, so the ACCEPT path is exercised for real rather than assumed —
// wiring that rejected everything would otherwise pass a reject-only suite.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(path.join(HERE, '__fixtures__/notifications.json'), 'utf8'),
);
const testRoot = Buffer.from(fixtures.rootCertificate, 'base64');

// Online checks off: OCSP would need the network and would date-check against
// now rather than the notification's signedDate.
function verifiers({ bundleId = 'io.lykn.app', appAppleId = 6765728365 } = {}) {
  return {
    production: new SignedDataVerifier([testRoot], false, Environment.PRODUCTION, bundleId, appAppleId),
    sandbox: new SignedDataVerifier([testRoot], false, Environment.SANDBOX, bundleId),
  };
}

async function refuses(signedPayload, opts) {
  await assert.rejects(() => verifyAppleNotification(signedPayload, verifiers(opts)));
}

// ── accepts genuinely signed notifications ──────────────────────────────────

test('a properly signed production notification verifies end to end', async () => {
  const result = await verifyAppleNotification(fixtures.production, verifiers());

  assert.equal(result.environment, 'Production');
  assert.equal(result.payload.notificationType, 'SUBSCRIBED');
  assert.equal(result.payload.subtype, 'INITIAL_BUY');
  // Both nested JWS blobs were verified and decoded, not passed through.
  assert.equal(result.transaction.originalTransactionId, fixtures.meta.originalTransactionId);
  assert.equal(result.renewalInfo.autoRenewStatus, 1);
});

test('a verified purchase produces the exact billing write we expect', async () => {
  const result = await verifyAppleNotification(fixtures.production, verifiers());
  assert.deepEqual(appleSyncInputFrom(result), {
    originalTransactionId: fixtures.meta.originalTransactionId,
    productId: fixtures.meta.productId,
    expiresDateMs: fixtures.meta.expiresDate,
    appAccountToken: fixtures.meta.appAccountToken,
    status: 'active',
    autoRenewOff: false,
  });
});

test('a sandbox notification verifies via the environment fallback', async () => {
  // App Review and TestFlight both transact in sandbox. A production-only
  // verifier would reject them and fail review.
  const result = await verifyAppleNotification(fixtures.sandbox, verifiers());
  assert.equal(result.environment, 'Sandbox');
  assert.equal(result.payload.notificationType, 'DID_RENEW');
});

test('a refund cancels and ends access at the revocation date', async () => {
  const sync = appleSyncInputFrom(await verifyAppleNotification(fixtures.refund, verifiers()));
  assert.equal(sync.status, 'canceled');
  assert.equal(sync.expiresDateMs, fixtures.meta.revocationDate);
});

test('turning off auto-renew stays active and sets cancel at period end', async () => {
  const sync = appleSyncInputFrom(
    await verifyAppleNotification(fixtures.autoRenewDisabled, verifiers()),
  );
  assert.equal(sync.status, 'active');
  assert.equal(sync.autoRenewOff, true);
  assert.equal(sync.expiresDateMs, fixtures.meta.expiresDate);
});

// ── refuses everything else ─────────────────────────────────────────────────

test('the real Apple root refuses these fixtures', async () => {
  // The whole security model in one assertion. This chain is structurally
  // perfect — right length, right Apple extension OIDs, CA:TRUE intermediate,
  // valid signatures throughout — and the ONLY thing that stops it granting a
  // subscription is that it does not chain to Apple. Which is to say: the
  // production server, whose roots are exactly these, would reject it.
  const appleRoots = loadAppleRootCertificates();
  const real = {
    production: new SignedDataVerifier(appleRoots, false, Environment.PRODUCTION, 'io.lykn.app', 6765728365),
    sandbox: new SignedDataVerifier(appleRoots, false, Environment.SANDBOX, 'io.lykn.app'),
  };
  await assert.rejects(() => verifyAppleNotification(fixtures.production, real));
  await assert.rejects(() => verifyAppleNotification(fixtures.sandbox, real));
});

test('a notification for another app is refused', async () => {
  await refuses(fixtures.wrongBundleId);
});

test('the wrong appAppleId is refused in production', async () => {
  // Checked only in production by the library — which is exactly where a
  // mismatch would silently drop every real customer's purchase.
  await refuses(fixtures.production, { appAppleId: 1234567890 });
});

test('a tampered nested transaction is refused', async () => {
  // The envelope signature is valid here; only signedTransactionInfo was
  // swapped, upgrading the product to Max annual with a ten-year expiry.
  // Nothing catches this unless the nested blobs are verified separately.
  await refuses(fixtures.tamperedTransaction);
});

test('a tampered envelope payload is refused', async () => {
  const [head, , sig] = fixtures.production.split('.');
  const forged = Buffer.from(JSON.stringify({
    notificationType: 'SUBSCRIBED',
    notificationUUID: 'forged',
    signedDate: fixtures.signedDate,
    data: { bundleId: 'io.lykn.app', appAppleId: 6765728365, environment: 'Production' },
  })).toString('base64url');
  await refuses(`${head}.${forged}.${sig}`);
});

test('an unsigned payload is refused', async () => {
  await refuses('not.a.jws');
  await refuses('');
});

test('the sandbox fallback fires only on INVALID_ENVIRONMENT', async () => {
  // The sandbox verifier below would accept this payload — the test above
  // proves it. It is never reached, because production failed for a different
  // reason. A blanket catch would hand a payload that flunked its identity
  // check a second chance at a verifier that skips the appAppleId check.
  const good = verifiers();
  const wrongApp = new SignedDataVerifier(
    [testRoot], false, Environment.PRODUCTION, 'com.example.other', 6765728365,
  );
  await assert.rejects(
    () => verifyAppleNotification(fixtures.sandbox, {
      production: wrongApp,
      sandbox: good.sandbox,
    }),
  );
});
