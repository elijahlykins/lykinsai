/**
 * One-time MCP approval tokens.
 *
 * HTTP and Chat callers must not attest approval by sending
 * task.approval.state = "approved". The server mints a token bound to
 * user + connection + tool + args when it pauses, and consumes that
 * token on the next call.
 */

import { createHash, randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS = 200;
const rows = new Map();

function prune(now = Date.now()) {
  for (const [token, row] of rows) {
    if (row.used || now > row.expiresAt) rows.delete(token);
  }
  if (rows.size <= MAX_TOKENS) return;
  const overflow = [...rows.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, rows.size - MAX_TOKENS);
  for (const [token] of overflow) rows.delete(token);
}

export function hashMcpApprovalArgs(args) {
  return createHash('sha256')
    .update(JSON.stringify(args && typeof args === 'object' ? args : {}))
    .digest('hex')
    .slice(0, 32);
}

export function mintMcpApprovalToken({ userId, connectionId, toolName, args, consequence, taskId } = {}) {
  prune();
  const token = randomBytes(24).toString('base64url');
  rows.set(token, {
    userId: String(userId || ''),
    connectionId: String(connectionId || ''),
    toolName: String(toolName || ''),
    taskId: String(taskId || ''),
    argsHash: hashMcpApprovalArgs(args),
    consequence: consequence || null,
    expiresAt: Date.now() + TTL_MS,
    used: false,
  });
  return token;
}

export function consumeMcpApprovalToken(token, { userId, connectionId, toolName, args, taskId } = {}) {
  prune();
  const key = String(token || '');
  const row = rows.get(key);
  if (!row || row.used || Date.now() > row.expiresAt) return false;
  if (!userId || String(row.userId) !== String(userId)) return false;
  if (String(row.connectionId) !== String(connectionId || '')) return false;
  if (String(row.toolName) !== String(toolName || '')) return false;
  if (String(row.taskId || '') !== String(taskId || '')) return false;
  if (row.argsHash !== hashMcpApprovalArgs(args)) return false;
  row.used = true;
  rows.delete(key);
  return true;
}

export function mcpApprovalTokenCountForTests() {
  prune();
  return rows.size;
}

export function resetMcpApprovalTokensForTests() {
  rows.clear();
}
