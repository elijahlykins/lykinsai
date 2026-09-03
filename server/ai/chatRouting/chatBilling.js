import { planHasUnlimitedNormalChat } from '../../../src/lib/pricing-config.js';
import {
  CHAT_USAGE_GATE_PATHS,
  ROUTING_SOURCES,
  isChatActionType,
} from './chatRoutingConfig.js';
import { isModelIncludedForPaidChat } from '../../../lib/billing/usageEntitlements.js';
import { getUsageBalance } from '../../../lib/billing/usageBalance.js';

export { planHasUnlimitedNormalChat };

/**
 * Preflight for one chat turn, called after the route is resolved and before
 * any provider call. Decides whether this turn is included chat or metered,
 * and blocks metered turns at $0 balance.
 *
 *   • Included plan chat (Auto routing, or a manual model priced at or below
 *     the Auto advanced tier) → always allowed, $0.
 *   • Premium manual model on a paid plan → metered; requires a positive
 *     Usage Balance. The actual cost settles post-stream from provider usage.
 *   • Free-tier chat → metered; requireAppAccess already verified a positive
 *     balance, so no extra read here.
 *
 * Returns { allowed: true, metered: boolean } or
 * { allowed: false, status, body } for the route to return.
 */
export async function assertChatTurnBillable({ userId, planId, chatRoute } = {}) {
  const plan = String(planId || 'free');
  if (!planHasUnlimitedNormalChat(plan)) {
    return { allowed: true, metered: true };
  }
  const explicitOverride = chatRoute?.routingSource === ROUTING_SOURCES.OVERRIDE;
  if (!explicitOverride || isModelIncludedForPaidChat(chatRoute?.modelId)) {
    return { allowed: true, metered: false };
  }
  // Premium manual model: metered even on a paid plan.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { allowed: true, metered: true };
  const usage = await getUsageBalance(userId);
  if ((usage?.available || 0) > 0) {
    return { allowed: true, metered: true };
  }
  return {
    allowed: false,
    status: 402,
    body: {
      error: 'insufficient_usage_balance',
      code: 'insufficient_usage_balance',
      message: 'This model uses your usage balance, and your balance is empty. Top up to use it, or switch to an included model.',
      add_funds: true,
      requested_model: chatRoute?.modelId || null,
    },
  };
}

export function resolveBillableCredits({
  actionType,
  catalogCredits,
  planId = 'free',
  hasBillableToolAction = false,
} = {}) {
  const catalog = Number(catalogCredits);
  const base = Number.isFinite(catalog) ? catalog : 1;
  if (hasBillableToolAction && isChatActionType(actionType)) return 0;
  if (isChatActionType(actionType) && planHasUnlimitedNormalChat(planId)) return 0;
  return base;
}

export function shouldSkipGlassRequestCap(planId, routePath) {
  if (!planHasUnlimitedNormalChat(planId)) return false;
  return CHAT_USAGE_GATE_PATHS.includes(String(routePath || ''));
}

export function planAllowsUnlimitedNormalChat(planId) {
  return planHasUnlimitedNormalChat(planId);
}
