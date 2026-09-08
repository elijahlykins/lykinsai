/**
 * What a subscription covers versus what Usage Balance pays for.
 *
 * Since usage-v3 the answer is simple: everything metered — normal chat
 * included — draws from the Usage Balance at the flat rate in
 * lib/billing/pricingProfiles.js. A subscription's value is the monthly
 * usage grant it funds (lib/billing/planFunding.js), not a separate
 * included-chat entitlement.
 *
 * The only exemption is internal unlimited-usage accounts
 * (`unlimitedUsage: true`, lib/billing/internalAccounts.js).
 */

const CHAT_ACTIONS = new Set(['chat_short', 'chat_long', 'chat_complex']);

export function isChatUsageAction(actionType) {
  return CHAT_ACTIONS.has(String(actionType || ''));
}

export const USAGE_KIND = Object.freeze({
  HUMAN_CHAT: 'human_chat',
  AUTONOMOUS: 'autonomous',
});

export function resolveUsageKind({ usageKind, autonomous = false } = {}) {
  if (autonomous || usageKind === USAGE_KIND.AUTONOMOUS) return USAGE_KIND.AUTONOMOUS;
  return usageKind || USAGE_KIND.HUMAN_CHAT;
}

/**
 * Does the account cover this usage at $0 customer charge?
 * Only internal unlimited-usage accounts qualify; every plan's chat and
 * compute meters the Usage Balance. Underlying provider cost is still
 * recorded via lykn_usage_events.
 */
export function isIncludedSubscriptionUsage({ unlimitedUsage = false } = {}) {
  return Boolean(unlimitedUsage);
}
