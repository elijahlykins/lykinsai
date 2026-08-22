// Usage: node --test lib/vaultAttachment.test.mjs
//
// Authorization tests for resolveVaultAttachment's storage_path branch
// (SECURITY_REPORT_07 F-07-01). storage_path and storage_bucket arrive from
// tool arguments and are signed with the service-role client, which bypasses
// Storage RLS — so the assertUserPath gate is the only tenant boundary here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultAttachment } from './vaultAttachment.js';
import { assertUserPath } from './exterior/capabilityStorage.js';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VICTIM = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function ctxWithSpy() {
  const calls = [];
  return {
    calls,
    ctx: {
      userId: USER,
      supabaseAdmin: {
        storage: {
          from(bucket) {
            return {
              async createSignedUrl(path, ttl) {
                calls.push({ bucket, path, ttl });
                return { data: { signedUrl: `https://signed.example/${path}` } };
              },
            };
          },
        },
      },
    },
  };
}

test('mints a signed URL for a path under the caller’s own prefix', async () => {
  const { ctx, calls } = ctxWithSpy();
  const out = await resolveVaultAttachment(ctx, {
    storagePath: `${USER}/saved/123-abc-file.png`,
    mimeType: 'image/png',
  });
  assert.ok(out, 'own-path attachment should resolve');
  assert.equal(out.storagePath, `${USER}/saved/123-abc-file.png`);
  assert.equal(out.url, `https://signed.example/${USER}/saved/123-abc-file.png`);
  assert.equal(calls.length, 1);
});

test('refuses to sign a path under another user’s prefix', async () => {
  const { ctx, calls } = ctxWithSpy();
  const out = await resolveVaultAttachment(ctx, {
    storagePath: `${VICTIM}/saved/123-abc-secret.pdf`,
    mimeType: 'application/pdf',
  });
  assert.equal(out, null, 'foreign path must resolve to no attachment');
  assert.equal(calls.length, 0, 'no signed URL may be minted for a foreign path');
});

test('refuses a traversal path that satisfies the bare prefix test', async () => {
  const { ctx, calls } = ctxWithSpy();
  const out = await resolveVaultAttachment(ctx, {
    storagePath: `${USER}/../${VICTIM}/saved/123-abc-secret.pdf`,
  });
  assert.equal(out, null);
  assert.equal(calls.length, 0);
});

test('refuses a bucket outside the allowlist even for an own-prefix path', async () => {
  const { ctx, calls } = ctxWithSpy();
  const out = await resolveVaultAttachment(ctx, {
    storagePath: `${USER}/saved/123-abc-file.png`,
    storageBucket: 'some-other-bucket',
  });
  assert.equal(out, null);
  assert.equal(calls.length, 0);
});

test('a rejected path is not persisted into the attachment record', async () => {
  const { ctx } = ctxWithSpy();
  const out = await resolveVaultAttachment(ctx, {
    storagePath: `${VICTIM}/saved/123-abc-secret.pdf`,
    fileUrl: 'https://cdn.example/keep.pdf',
  });
  // Rejecting the whole branch (not just the mint) is what keeps the victim's
  // path out of the attacker's stored attachment row.
  assert.equal(out, null);
});

test('assertUserPath: accepts own prefix, rejects empty, foreign, and traversal', () => {
  assert.equal(assertUserPath(USER, `${USER}/x/y.png`).ok, true);
  assert.equal(assertUserPath(USER, '').ok, false);
  assert.equal(assertUserPath('', `${USER}/x.png`).ok, false);
  assert.equal(assertUserPath(USER, `${VICTIM}/x.png`).ok, false);
  assert.equal(assertUserPath(USER, `${USER}/../${VICTIM}/x.png`).ok, false);
  assert.equal(assertUserPath(USER, `${USER}/a/..b/x.png`).ok, false);
});
