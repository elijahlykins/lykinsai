import { grantUnlimitedUsage } from '../../../lib/billing/internalAccounts.js';
import { isPaidPlan } from '../../../lib/billing/planCatalog.js';
import {
  CHAT_USAGE_GATE_PATHS,
  isChatActionType,
} from './chatRoutingConfig.js';
import { getUsageBalance } from '../../../lib/billing/usageBalance.js';

/**
 * Preflight for one chat turn, called after the route is resolved and before
 * any provider call. Every chat turn is metered against the Usage Balance —
 * subscriptions fund monthly plan usage, they do not include chat.
 *
 *   • Internal unlimited-usage accounts → allowed, not metered.
 *   • Paid plans → metered; requires a positive Usage Balance (the monthly
 *     plan grant normally covers this). The actual cost settles post-stream
 *     from provider usage.
 *   • Free tier → metered; requireAppAccess already verified a positive
 *     balance, so no extra read here.
 *
 * Returns { allowed: true, metered: boolean } or
 * { allowed: false, status, body } for the route to return.
 */
export async function assertChatTurnBillable({ userId, planId, email } = {}) {
  if (grantUnlimitedUsage({ userId, email })) {
    return { allowed: true, metered: false };
  }
  const plan = String(planId || 'free');
  if (!isPaidPlan(plan)) {
    return { allowed: true, metered: true };
  }
  // Local/dev without a service role has no billing backend; skip the gate.
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
      message: 'Your usage balance is empty. Top up to keep chatting, or wait for your plan to renew.',
      add_funds: true,
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
  // Paid-plan chat bills the dollar Usage Balance, never legacy credits.
  if (isChatActionType(actionType) && isPaidPlan(planId)) return 0;
  return base;
}

export function shouldSkipGlassRequestCap(planId, routePath) {
  if (!isPaidPlan(planId)) return false;
  return CHAT_USAGE_GATE_PATHS.includes(String(routePath || ''));
}
