#!/usr/bin/env node
//
// Regenerates the signed fixtures in lib/billing/__fixtures__/.
//
// Reject-path tests are easy — anything unsigned fails. Proving the ACCEPT
// path is what needs a real certificate chain, and it is the half that matters:
// a wiring mistake that made every notification fail verification would look
// identical to a healthy server right up until no customer's purchase ever
// granted anything.
//
// So this builds a throwaway CA that satisfies every rule the Apple library
// enforces — three-cert x5c chain, an intermediate marked CA:TRUE, and the two
// Apple certificate extension OIDs it insists on — then signs notifications
// with it. The fixtures are committed so the test suite needs neither openssl
// nor a network.
//
// The keys here are generated fresh on every run and are worthless: the test
// verifier trusts this root and nothing else, and the real server trusts only
// certs/apple/AppleRootCA-G3.cer.
//
//   node scripts/generate-apple-notification-fixtures.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createSign, createPrivateKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib/billing/__fixtures__',
);

// Apple's marker extensions. The library refuses a chain without them, so a
// generic test CA is not enough — see verifyCertificateChainWithoutCaching.
const LEAF_MARKER_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_MARKER_OID = '1.2.840.113635.100.6.2.1';

// With online checks off the library date-checks the chain against the
// notification's OWN signedDate, not the clock. Both the validity window and
// the signed date are therefore pinned to fixed values: defaulting notBefore
// to "now" is what made the first version of these fixtures fail verification,
// because every signedDate then sat before the certificates existed.
const SIGNED_DATE_MS = Date.UTC(2026, 0, 1);
const NOT_BEFORE = '20200101000000Z';
const NOT_AFTER = '21200101000000Z';

const work = mkdtempSync(path.join(tmpdir(), 'lykn-apple-fixtures-'));
const at = (name) => path.join(work, name);
const openssl = (...args) => execFileSync('openssl', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  writeFileSync(at('intermediate.ext'), [
    'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,keyCertSign,cRLSign',
    `${INTERMEDIATE_MARKER_OID}=ASN1:NULL`,
  ].join('\n'));
  writeFileSync(at('leaf.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature',
    `${LEAF_MARKER_OID}=ASN1:NULL`,
  ].join('\n'));

  const validity = ['-not_before', NOT_BEFORE, '-not_after', NOT_AFTER];

  // Root — self-signed.
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', at('root.key'));
  openssl('req', '-new', '-x509', '-key', at('root.key'), '-out', at('root.pem'),
    ...validity, '-subj', '/CN=LYKN Test Root CA');

  // Intermediate — signed by root.
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', at('intermediate.key'));
  openssl('req', '-new', '-key', at('intermediate.key'), '-out', at('intermediate.csr'),
    '-subj', '/CN=LYKN Test Intermediate CA');
  openssl('x509', '-req', '-in', at('intermediate.csr'), '-CA', at('root.pem'),
    '-CAkey', at('root.key'), '-CAcreateserial', '-out', at('intermediate.pem'),
    ...validity, '-extfile', at('intermediate.ext'));

  // Leaf — signed by intermediate, holds the key the JWSs are signed with.
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', at('leaf.key'));
  openssl('req', '-new', '-key', at('leaf.key'), '-out', at('leaf.csr'), '-subj', '/CN=LYKN Test Leaf');
  openssl('x509', '-req', '-in', at('leaf.csr'), '-CA', at('intermediate.pem'),
    '-CAkey', at('intermediate.key'), '-CAcreateserial', '-out', at('leaf.pem'),
    ...validity, '-extfile', at('leaf.ext'));

  const der = (pem) => openssl('x509', '-in', at(pem), '-outform', 'DER');
  const rootDer = der('root.pem');
  const x5c = [der('leaf.pem'), der('intermediate.pem'), rootDer].map((b) => b.toString('base64'));
  const leafKey = createPrivateKey(readFileSync(at('leaf.key')));

  const b64url = (buf) => Buffer.from(buf).toString('base64url');

  // ES256 signs as raw r||s, but OpenSSL/Node emit DER. Converting by hand
  // keeps this script dependency-free.
  function derToJose(sig) {
    let offset = 2;
    if (sig[1] & 0x80) offset += sig[1] & 0x7f;
    const readInt = () => {
      const len = sig[offset + 1];
      const start = offset + 2;
      offset = start + len;
      let bytes = sig.subarray(start, start + len);
      while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.subarray(1);
      return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
    };
    return Buffer.concat([readInt(), readInt()]);
  }

  function sign(payload) {
    const head = b64url(JSON.stringify({ alg: 'ES256', x5c }));
    const body = b64url(JSON.stringify(payload));
    const signer = createSign('SHA256');
    signer.update(`${head}.${body}`);
    return `${head}.${body}.${b64url(derToJose(signer.sign(leafKey)))}`;
  }

  const ORIGINAL_TRANSACTION_ID = '2000000900000001';
  const APP_ACCOUNT_TOKEN = '3f7b1e10-9c4a-4a1e-8f2b-1a2b3c4d5e6f';

  // `environment` and `bundleId` are repeated inside the nested blobs on
  // purpose: verifyAndDecodeTransaction / verifyAndDecodeRenewalInfo re-check
  // both, so a sandbox transaction smuggled into a production envelope is
  // rejected. Omitting them here is what made the first fixtures fail.
  const transaction = (environment, extra = {}) => sign({
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    transactionId: ORIGINAL_TRANSACTION_ID,
    productId: 'io.lykn.app.sub.pro.month',
    bundleId: 'io.lykn.app',
    environment,
    appAccountToken: APP_ACCOUNT_TOKEN,
    purchaseDate: SIGNED_DATE_MS,
    originalPurchaseDate: SIGNED_DATE_MS,
    expiresDate: SIGNED_DATE_MS + 30 * 86_400_000,
    type: 'Auto-Renewable Subscription',
    inAppOwnershipType: 'PURCHASED',
    signedDate: SIGNED_DATE_MS,
    quantity: 1,
    ...extra,
  });

  const renewalInfo = (environment, extra = {}) => sign({
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    autoRenewProductId: 'io.lykn.app.sub.pro.month',
    productId: 'io.lykn.app.sub.pro.month',
    environment,
    autoRenewStatus: 1,
    signedDate: SIGNED_DATE_MS,
    ...extra,
  });

  const notification = ({ notificationType, subtype, environment, bundleId = 'io.lykn.app', uuid, txn, renewal }) => sign({
    notificationType,
    ...(subtype ? { subtype } : {}),
    notificationUUID: uuid,
    version: '2.0',
    signedDate: SIGNED_DATE_MS,
    data: {
      bundleId,
      // Sandbox notifications from Apple carry NO appAppleId — verified
      // against a real captured payload, see apple-sandbox-test-notification.json.
      // The first version of these fixtures set it in both environments, which
      // made the sandbox tests pass against a payload shape Apple never sends
      // and hid a bug that rejected every real sandbox notification.
      ...(environment === 'Sandbox' ? {} : { appAppleId: 6765728365 }),
      bundleVersion: '9',
      environment,
      signedTransactionInfo: txn ?? transaction(environment),
      signedRenewalInfo: renewal ?? renewalInfo(environment),
      status: 1,
    },
  });

  const fixtures = {
    // Long-lived facts the test asserts against, so the expectations live with
    // the data that produced them rather than being retyped in the test.
    meta: {
      originalTransactionId: ORIGINAL_TRANSACTION_ID,
      appAccountToken: APP_ACCOUNT_TOKEN,
      productId: 'io.lykn.app.sub.pro.month',
      expiresDate: SIGNED_DATE_MS + 30 * 86_400_000,
      revocationDate: SIGNED_DATE_MS + 5 * 86_400_000,
    },
    rootCertificate: rootDer.toString('base64'),
    production: notification({
      notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY',
      environment: 'Production', uuid: '11111111-1111-1111-1111-111111111111',
    }),
    sandbox: notification({
      notificationType: 'DID_RENEW',
      environment: 'Sandbox', uuid: '22222222-2222-2222-2222-222222222222',
    }),
    refund: notification({
      notificationType: 'REFUND',
      environment: 'Production', uuid: '33333333-3333-3333-3333-333333333333',
      txn: transaction('Production', { revocationDate: SIGNED_DATE_MS + 5 * 86_400_000 }),
    }),
    autoRenewDisabled: notification({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED',
      environment: 'Production', uuid: '44444444-4444-4444-4444-444444444444',
      renewal: renewalInfo('Production', { autoRenewStatus: 0 }),
    }),
    // Correctly signed by a trusted chain, but for a different app. Proves the
    // bundle id is actually enforced and not just carried along.
    wrongBundleId: notification({
      notificationType: 'SUBSCRIBED', bundleId: 'com.example.other',
      environment: 'Production', uuid: '55555555-5555-5555-5555-555555555555',
    }),
    // Valid envelope, tampered nested transaction — the case that exists
    // because verifyAndDecodeNotification does NOT check the nested blobs.
    tamperedTransaction: notification({
      notificationType: 'SUBSCRIBED',
      environment: 'Production', uuid: '66666666-6666-6666-6666-666666666666',
      txn: (() => {
        const [head, , sig] = transaction('Production').split('.');
        const forged = b64url(JSON.stringify({
          originalTransactionId: ORIGINAL_TRANSACTION_ID,
          productId: 'io.lykn.app.sub.max.year',
          bundleId: 'io.lykn.app',
          environment: 'Production',
          appAccountToken: APP_ACCOUNT_TOKEN,
          expiresDate: SIGNED_DATE_MS + 3650 * 86_400_000,
          signedDate: SIGNED_DATE_MS,
        }));
        return `${head}.${forged}.${sig}`;
      })(),
    }),
    signedDate: SIGNED_DATE_MS,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, 'notifications.json'),
    `${JSON.stringify(fixtures, null, 2)}\n`,
  );
  console.log(`✅ wrote ${path.join(OUT_DIR, 'notifications.json')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
