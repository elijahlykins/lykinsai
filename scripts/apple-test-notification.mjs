#!/usr/bin/env node
//
// Asks Apple to deliver a TEST App Store Server Notification to our endpoint,
// then reads back what Apple observed when it tried.
//
// That readback is the whole point. Our own logs only show requests that
// arrived; this shows Apple's side — whether the delivery attempt succeeded,
// and if not, what it saw instead. It is the only way to tell "Apple never
// called us" apart from "Apple called us and we rejected it", which look
// identical from the database.
//
// Requires an In-App Purchase key (App Store Connect → Users and Access →
// Integrations → In-App Purchase). The .p8 is a private key that can sign
// requests against the App Store account, so it is read from outside the repo
// and never committed.
//
//   APPLE_IAP_KEY_PATH=~/.lykn/SubscriptionKey_XXXXXXXXXX.p8 \
//   APPLE_IAP_KEY_ID=XXXXXXXXXX \
//   APPLE_IAP_ISSUER_ID=... \
//   node scripts/apple-test-notification.mjs [--sandbox]
//
// Values are read from .env (already gitignored) when present.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';
import {
  AppStoreServerAPIClient,
  Environment,
  APIException,
} from '@apple/app-store-server-library';

dotenv.config();

const sandbox = process.argv.includes('--sandbox');
const environment = sandbox ? Environment.SANDBOX : Environment.PRODUCTION;

const bundleId = process.env.APPLE_BUNDLE_ID || 'io.lykn.app';
const keyId = process.env.APPLE_IAP_KEY_ID;
const issuerId = process.env.APPLE_IAP_ISSUER_ID;
const rawKeyPath = process.env.APPLE_IAP_KEY_PATH;

if (!keyId || !issuerId || !rawKeyPath) {
  console.error('❌ Set APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID and APPLE_IAP_KEY_PATH (in .env or the environment).');
  process.exit(1);
}

// Shells expand ~, dotenv does not.
const keyPath = rawKeyPath.startsWith('~')
  ? path.join(os.homedir(), rawKeyPath.slice(1))
  : rawKeyPath;

let signingKey;
try {
  signingKey = readFileSync(keyPath, 'utf8');
} catch (err) {
  console.error(`❌ Could not read the signing key at ${keyPath}: ${err.message}`);
  process.exit(1);
}

const client = new AppStoreServerAPIClient(signingKey, keyId, issuerId, bundleId, environment);

console.log(`🍎 Requesting a TEST notification — ${environment}, ${bundleId}`);

let token;
try {
  ({ testNotificationToken: token } = await client.requestTestNotification());
} catch (err) {
  if (err instanceof APIException) {
    console.error(`❌ Apple refused the request: HTTP ${err.httpStatusCode}, apiError ${err.apiError} ${err.errorMessage || ''}`);
  } else {
    console.error('❌ Request failed:', err?.message || err);
  }
  process.exit(1);
}

console.log(`   token ${token}`);
console.log('   waiting for Apple to attempt delivery…');

// Apple queues the send, so the status is briefly unavailable (apiError
// 4040008, TestNotificationNotFound). Poll rather than treating the first
// miss as a failure.
let status = null;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  await new Promise((resolve) => { setTimeout(resolve, 5_000); });
  try {
    status = await client.getTestNotificationStatus(token);
    if (status?.sendAttempts?.length) break;
  } catch (err) {
    if (!(err instanceof APIException)) throw err;
    // Not ready yet — keep waiting.
  }
  process.stdout.write(`   …${attempt * 5}s\n`);
}

if (!status?.sendAttempts?.length) {
  console.error('❌ Apple never reported a delivery attempt. The token was issued, so the request was accepted — check the URL in App Store Connect.');
  process.exit(1);
}

console.log('\n📬 Apple’s view of the delivery:');
let ok = false;
for (const attempt of status.sendAttempts) {
  const when = attempt.attemptDate ? new Date(attempt.attemptDate).toISOString() : 'unknown time';
  const result = attempt.sendAttemptResult ?? 'unknown';
  const good = String(result).toUpperCase() === 'SUCCESS';
  if (good) ok = true;
  console.log(`   ${good ? '✅' : '❌'} ${when} — ${result}`);
}

if (status.signedPayload) {
  const body = JSON.parse(Buffer.from(status.signedPayload.split('.')[1], 'base64url').toString());
  console.log(`\n   notificationUUID ${body.notificationUUID}`);
  console.log(`   type ${body.notificationType}, environment ${body.data?.environment}`);
  console.log('\n   Verify it landed:');
  console.log(`     select * from apple_notifications where notification_uuid = '${body.notificationUUID}';`);
}

process.exit(ok ? 0 : 1);
