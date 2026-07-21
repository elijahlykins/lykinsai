// Sign in with Apple server-side helpers — authorization-code exchange and
// token revocation against https://appleid.apple.com.
//
// Why this exists: App Review requires that account deletion revoke the
// user's Sign in with Apple token (developer.apple.com/support/
// offering-account-deletion-in-your-app/). Revocation needs an Apple
// refresh token, which only exists server-side if we exchanged the
// authorization code the iOS app received at sign-in — Supabase's native
// signInWithIdToken flow never performs that exchange, so we do it here
// and stash the refresh token in lykn_apple_tokens (migration 114).
//
// Required environment (all absent → helpers no-op and return null so the
// delete flow degrades gracefully instead of blocking a user from leaving):
//   APPLE_TEAM_ID      10-char Apple Developer team id (B45S92XC36)
//   APPLE_KEY_ID       Key id of the SIWA .p8 private key
//   APPLE_PRIVATE_KEY  Contents of the .p8 (PEM, \n-escaped ok)
//   APPLE_CLIENT_ID    Bundle id the token was issued to (default io.lykn.app)
//
// No jsonwebtoken dependency in this repo — the client-secret JWT is small
// enough to assemble with node:crypto (ES256 = ECDSA P-256 + SHA-256, with
// the JOSE ieee-p1363 signature encoding rather than ASN.1/DER).

import crypto from 'crypto';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

function appleEnv() {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY;
  const clientId = process.env.APPLE_CLIENT_ID || 'io.lykn.app';
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey: privateKey.replace(/\\n/g, '\n'), clientId };
}

/** True when the SIWA server credentials are configured. */
export function appleAuthConfigured() {
  return appleEnv() !== null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Mint the short-lived ES256 client-secret JWT Apple requires on every
 * /auth/token and /auth/revoke call. Returns null when unconfigured.
 */
export function makeAppleClientSecret(now = Math.floor(Date.now() / 1000)) {
  const env = appleEnv();
  if (!env) return null;

  const header = b64url(JSON.stringify({ alg: 'ES256', kid: env.keyId, typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: env.teamId,
    iat: now,
    exp: now + 15 * 60,
    aud: 'https://appleid.apple.com',
    sub: env.clientId,
  }));
  const signingInput = `${header}.${claims}`;

  const key = crypto.createPrivateKey(env.privateKey);
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Exchange the authorization code from a native Sign in with Apple flow for
 * Apple's token set. Must run within ~10 minutes of the sign-in. Returns
 * { refreshToken } or null (unconfigured / exchange rejected).
 */
export async function exchangeAppleAuthorizationCode(authorizationCode) {
  const env = appleEnv();
  const clientSecret = makeAppleClientSecret();
  if (!env || !clientSecret || !authorizationCode) return null;

  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: clientSecret,
      code: authorizationCode,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[apple-auth] code exchange failed (${res.status}): ${body.slice(0, 200)}`);
    return null;
  }
  const json = await res.json();
  return json?.refresh_token ? { refreshToken: json.refresh_token } : null;
}

/**
 * Revoke a stored Apple refresh token. Apple returns 200 for both fresh and
 * already-revoked tokens, so this is idempotent. Returns true on success.
 */
export async function revokeAppleToken(refreshToken) {
  const env = appleEnv();
  const clientSecret = makeAppleClientSecret();
  if (!env || !clientSecret || !refreshToken) return false;

  const res = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: clientSecret,
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[apple-auth] revoke failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.ok;
}
