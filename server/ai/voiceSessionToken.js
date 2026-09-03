// HMAC session tokens that bind an ElevenLabs (or overlay) voice call to a
// LYKN user. Routes keep the in-memory grounding Maps; this module owns only
// the Node-crypto sign/verify so ESM never accidentally hits Web Crypto's
// global `crypto` (which has no createHmac).
import crypto from 'crypto';

export const VOICE_SESSION_TTL_MS = 60 * 60 * 1000; // 1h — covers a long voice call.

export function resolveVoiceSessionSecret(env = process.env) {
  if (env.VOICE_SESSION_SECRET) return env.VOICE_SESSION_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('VOICE_SESSION_SECRET is required in production');
  }
  return `dev-ephemeral-${crypto.randomBytes(24).toString('hex')}`;
}

export function signLyknVoiceToken(payload, secret, ttlMs = VOICE_SESSION_TTL_MS) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyLyknVoiceToken(token, secret) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data?.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}
