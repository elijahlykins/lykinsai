#!/usr/bin/env node
/**
 * Manual integration check for the Composio Gmail connection foundation.
 * Requires a real COMPOSIO_API_KEY (never hardcode one). Not part of any
 * automated test run.
 *
 * Usage:
 *   node --env-file=.env scripts/verify-composio-gmail.mjs <lykn-user-id> [command]
 *
 * Commands:
 *   (none)        print the authoritative Gmail connection status
 *   --connect     create a Connect Link through the LYKN Connection Service
 *                 (callback goes to the LYKN API server, which must be running)
 *   --connect-live  create a Connect Link with Composio's default return page
 *                 (no LYKN server needed), then poll until connected
 *   --call        make one safe read-only tool call (GMAIL_GET_PROFILE,
 *                 documented at docs.composio.dev/toolkits/gmail.md) to prove
 *                 the connection end to end
 *   --disconnect  revoke (best effort) and delete the connected account
 */

import { createComposioGateway } from '../lib/connections/composioGateway.js';
import {
  createConnectionService,
  createMemoryConnectStateStore,
} from '../lib/connections/connectionService.js';

const userId = process.argv[2];
const command = process.argv[3] || '--status';

if (!process.env.COMPOSIO_API_KEY) {
  console.error('COMPOSIO_API_KEY is not set.');
  process.exit(1);
}
if (!userId || userId.startsWith('--')) {
  console.error(
    'Usage: node --env-file=.env scripts/verify-composio-gmail.mjs <lykn-user-id> [--connect|--connect-live|--call|--disconnect]',
  );
  process.exit(1);
}

const gateway = createComposioGateway();
const service = createConnectionService({
  gateway,
  stateStore: createMemoryConnectStateStore(),
  publicApiBase: process.env.PUBLIC_API_BASE_URL || 'http://localhost:3001',
});

async function printStatus() {
  const status = await service.getStatus(userId, 'gmail');
  console.log('[verify] gmail status:', JSON.stringify(status, null, 2));
  return status;
}

async function pollUntilConnected({ timeoutMs = 5 * 60 * 1000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await gateway.getToolkitConnection(userId, 'gmail');
    if (status.connected) return status;
    process.stdout.write(`[verify] waiting for authorization… (${status.status})\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for the Gmail authorization to complete.');
}

/**
 * Dev-only direct session for the proof tool call. Product execution will
 * be owned by Phase 2; production code must not copy this pattern.
 */
async function devSession() {
  const { Composio } = await import('@composio/core');
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  return composio.create(userId, {
    toolkits: ['gmail'],
    manageConnections: false,
    sandbox: { enable: false },
  });
}

const status = await printStatus();

if (command === '--connect') {
  const result = await service.connect(userId, 'gmail');
  console.log('[verify] open this Connect Link in a browser:');
  console.log(result.url);
  console.log('[verify] the callback returns to the LYKN API server; keep it running.');
} else if (command === '--connect-live') {
  if (status.connected) {
    console.log('[verify] already connected — nothing to do.');
  } else {
    const { redirectUrl } = await gateway.createConnectLink(userId, 'gmail');
    console.log('[verify] open this Connect Link and finish Google authorization:');
    console.log(redirectUrl);
    const connected = await pollUntilConnected();
    console.log(
      `[verify] connected. connectedAccountId=${connected.connectedAccountId}`,
    );
  }
} else if (command === '--call') {
  if (!status.connected) {
    console.error('[verify] Gmail is not connected — run --connect-live first.');
    process.exit(1);
  }
  const session = await devSession();
  const result = await session.execute('GMAIL_GET_PROFILE', {});
  const data = result?.data ?? result;
  const profile = data?.response_data ?? data;
  console.log('[verify] GMAIL_GET_PROFILE result:');
  console.log('  successful:', result?.successful ?? true);
  console.log('  emailAddress:', profile?.emailAddress ?? '(not present)');
  console.log('  messagesTotal:', profile?.messagesTotal ?? '(not present)');
  console.log('  threadsTotal:', profile?.threadsTotal ?? '(not present)');
  const logId = result?.log_id || result?.logId || data?.log_id || null;
  console.log('  composio log id:', logId ?? '(not present)');
} else if (command === '--disconnect') {
  const result = await service.disconnect(userId, 'gmail');
  console.log('[verify] disconnect:', JSON.stringify(result, null, 2));
}
