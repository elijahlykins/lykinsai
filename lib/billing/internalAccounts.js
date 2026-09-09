/**
 * Internal team accounts that the product bills differently from customers.
 *
 * Unlimited-usage emails never consume Usage Balance: chat, images, video,
 * 3D, premium models, and autonomous compute all authorize as included.
 * Provider cost is still logged on lykn_usage_events.
 *
 * Comped Pro emails (studio access regardless of Stripe) live in
 * server/services/billingService.js. An address can be on both lists.
 *
 * Extra addresses can be added via UNLIMITED_USAGE_EMAILS (comma-separated)
 * without a redeploy. The hardcoded set is the source of truth for known
 * operator accounts.
 */

const UNLIMITED_USAGE_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED_USERS = 5_000;
const unlimitedFlags = new Map(); // userId → expiresAt

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function envEmails(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
}

export const UNLIMITED_USAGE_EMAILS = new Set([
  'admin@lykn.io',
  'jaeminw8@gmail.com',
  ...envEmails('UNLIMITED_USAGE_EMAILS'),
]);

export function isUnlimitedUsageEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return UNLIMITED_USAGE_EMAILS.has(normalized);
}

function pruneExpired() {
  if (unlimitedFlags.size <= MAX_TRACKED_USERS) return;
  const now = Date.now();
  for (const [key, expires] of unlimitedFlags) {
    if (expires <= now) unlimitedFlags.delete(key);
  }
}

/**
 * Remember that this userId is on the unlimited-usage list for the gap
 * between a request gate (which has the email) and post-hoc settlement
 * (logAiUsage / recordUsageAfterLog, which often only have userId).
 */
export function markUnlimitedUsage(userId) {
  if (!userId) return;
  unlimitedFlags.set(userId, Date.now() + UNLIMITED_USAGE_TTL_MS);
  pruneExpired();
}

export function isUnlimitedUsage(userId) {
  if (!userId) return false;
  const expires = unlimitedFlags.get(userId) || 0;
  if (expires > Date.now()) return true;
  if (expires) unlimitedFlags.delete(userId);
  return false;
}

export function clearUnlimitedUsage(userId = null) {
  if (userId) unlimitedFlags.delete(userId);
  else unlimitedFlags.clear();
}

/**
 * True when this request should skip customer Usage charges.
 * Marks the userId so later settlement in the same process also skips.
 */
export function grantUnlimitedUsage({ userId, email } = {}) {
  const unlimited = isUnlimitedUsageEmail(email) || isUnlimitedUsage(userId);
  if (unlimited && userId) markUnlimitedUsage(userId);
  return unlimited;
}
