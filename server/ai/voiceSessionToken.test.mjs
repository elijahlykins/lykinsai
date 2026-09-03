import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVoiceSessionSecret,
  signLyknVoiceToken,
  verifyLyknVoiceToken,
} from './voiceSessionToken.js';

const SECRET = 'test-voice-session-secret-32chars!!';

test('sign/verify uses Node createHmac and round-trips a payload', () => {
  const token = signLyknVoiceToken({ uid: 'user-1', board: 'chat-9' }, SECRET);
  const session = verifyLyknVoiceToken(token, SECRET);
  assert.equal(session.uid, 'user-1');
  assert.equal(session.board, 'chat-9');
  assert.equal(typeof session.exp, 'number');
  assert.ok(session.exp > Date.now());
});

test('verify rejects a forged signature and an expired token', () => {
  const token = signLyknVoiceToken({ uid: 'user-1' }, SECRET);
  const [body] = token.split('.');
  assert.equal(verifyLyknVoiceToken(`${body}.AAAA`, SECRET), null);
  assert.equal(verifyLyknVoiceToken(token, 'other-secret'), null);
  const expired = signLyknVoiceToken({ uid: 'user-1' }, SECRET, -1000);
  assert.equal(verifyLyknVoiceToken(expired, SECRET), null);
});

test('dev fallback mints a random secret; production refuses to start without one', () => {
  const a = resolveVoiceSessionSecret({ NODE_ENV: 'development' });
  const b = resolveVoiceSessionSecret({ NODE_ENV: 'development' });
  assert.match(a, /^dev-ephemeral-/);
  assert.notEqual(a, b);
  assert.throws(
    () => resolveVoiceSessionSecret({ NODE_ENV: 'production' }),
    /VOICE_SESSION_SECRET is required/,
  );
  assert.equal(
    resolveVoiceSessionSecret({ NODE_ENV: 'production', VOICE_SESSION_SECRET: SECRET }),
    SECRET,
  );
});
