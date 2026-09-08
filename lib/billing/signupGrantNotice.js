/**
 * One-time $20 signup grant notice state.
 *
 * Grant writes stay in usageBalance.ensureSignupGrant (ledger idempotency).
 * This module decides when the "you just got $20" card should show.
 * Existing accounts that already received the grant never get the pending
 * flag, so they do not see a surprise banner.
 */

export const SIGNUP_GRANT_NOTICE_META_KEY = 'signup_grant_notice';
export const SIGNUP_GRANT_NOTICE = Object.freeze({
  PENDING: 'pending',
  SEEN: 'seen',
});

export const SIGNUP_GRANT_NOTICE_COPY = Object.freeze({
  title: 'You just got $20 of free credits',
  summary:
    'They are in your Usage Balance. Chat, images, and agents all draw from this.',
  dismissLabel: 'Got it',
});

export function isSignupGrantNoticePending(metadata) {
  return metadata?.[SIGNUP_GRANT_NOTICE_META_KEY] === SIGNUP_GRANT_NOTICE.PENDING;
}

export function isSignupGrantNoticeSeen(metadata) {
  return metadata?.[SIGNUP_GRANT_NOTICE_META_KEY] === SIGNUP_GRANT_NOTICE.SEEN;
}

export function signupGrantNoticeDismissPatch() {
  return {
    metadata: {
      [SIGNUP_GRANT_NOTICE_META_KEY]: SIGNUP_GRANT_NOTICE.SEEN,
    },
  };
}

export function shouldShowSignupGrantNotice({ notice, localSeen } = {}) {
  if (localSeen) return false;
  return Boolean(notice);
}

/**
 * Pure next-state after a grant attempt.
 * first grant → pending + show; already pending → show; seen → never show.
 */
export function signupGrantNoticeAfterGrant(metadata, grant) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  if (isSignupGrantNoticeSeen(meta)) {
    return { notice: false, persistPending: false, metadata: meta };
  }
  const firstGrant = Boolean(grant?.ok && !grant?.duplicate);
  if (firstGrant) {
    return {
      notice: true,
      persistPending: meta[SIGNUP_GRANT_NOTICE_META_KEY] !== SIGNUP_GRANT_NOTICE.PENDING,
      metadata: {
        ...meta,
        [SIGNUP_GRANT_NOTICE_META_KEY]: SIGNUP_GRANT_NOTICE.PENDING,
      },
    };
  }
  return {
    notice: isSignupGrantNoticePending(meta),
    persistPending: false,
    metadata: meta,
  };
}
