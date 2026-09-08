import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNUP_GRANT_NOTICE,
  SIGNUP_GRANT_NOTICE_COPY,
  SIGNUP_GRANT_NOTICE_META_KEY,
  isSignupGrantNoticePending,
  isSignupGrantNoticeSeen,
  signupGrantNoticeAfterGrant,
  signupGrantNoticeDismissPatch,
  shouldShowSignupGrantNotice,
} from './signupGrantNotice.js';
import { SIGNUP_GRANT_USD } from './planCatalog.js';

test('first signup grant marks the notice pending and shows it', () => {
  const next = signupGrantNoticeAfterGrant({}, { ok: true, duplicate: false });
  assert.equal(next.notice, true);
  assert.equal(next.persistPending, true);
  assert.equal(next.metadata[SIGNUP_GRANT_NOTICE_META_KEY], SIGNUP_GRANT_NOTICE.PENDING);
  assert.equal(SIGNUP_GRANT_USD, 20);
  assert.match(SIGNUP_GRANT_NOTICE_COPY.title, /\$20 of free credits/);
});

test('replayed grant does not resurrect a seen notice', () => {
  const seen = { [SIGNUP_GRANT_NOTICE_META_KEY]: SIGNUP_GRANT_NOTICE.SEEN };
  const next = signupGrantNoticeAfterGrant(seen, { ok: true, duplicate: false });
  assert.equal(next.notice, false);
  assert.equal(next.persistPending, false);
  assert.equal(isSignupGrantNoticeSeen(seen), true);
});

test('pending notice keeps showing on later loads without rewriting', () => {
  const pending = { [SIGNUP_GRANT_NOTICE_META_KEY]: SIGNUP_GRANT_NOTICE.PENDING };
  const next = signupGrantNoticeAfterGrant(pending, { ok: true, duplicate: true });
  assert.equal(next.notice, true);
  assert.equal(next.persistPending, false);
  assert.equal(isSignupGrantNoticePending(pending), true);
});

test('existing accounts with no pending flag do not see the card', () => {
  const next = signupGrantNoticeAfterGrant({}, { ok: true, duplicate: true });
  assert.equal(next.notice, false);
  assert.equal(next.persistPending, false);
});

test('dismiss patch marks the notice seen', () => {
  const patch = signupGrantNoticeDismissPatch();
  assert.equal(isSignupGrantNoticeSeen(patch.metadata), true);
});

test('local dismiss hides the card even when the server still says pending', () => {
  assert.equal(shouldShowSignupGrantNotice({ notice: true, localSeen: false }), true);
  assert.equal(shouldShowSignupGrantNotice({ notice: true, localSeen: true }), false);
  assert.equal(shouldShowSignupGrantNotice({ notice: false, localSeen: false }), false);
});
