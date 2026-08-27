/**
 * Human-readable MCP approval copy.
 * Identifies the connection and the semantic action. Not a schema dump.
 */

import { CONSEQUENCE } from './capabilityRegistry.js';
import { redactToolArgs } from './sensitiveArgs.js';

function actionPhrase(classified) {
  const cap = String(classified?.semanticCapabilities?.[0] || classified?.capabilities?.[0] || '');
  if (cap.includes('email.send') || classified?.toolName === 'send_email') return 'send an email';
  if (cap.includes('email.') && classified?.consequence === CONSEQUENCE.WRITE) return 'write an email draft';
  if (cap.includes('documents.delete') || classified?.consequence === CONSEQUENCE.DESTRUCTIVE) {
    return 'delete a document';
  }
  if (cap.startsWith('permissions.')) return 'change permissions';
  if (cap.includes('documents.write')) return 'write a document';
  if (classified?.consequence === CONSEQUENCE.CONSEQUENTIAL) return 'perform a consequential action';
  return 'make a change';
}

function targetFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const candidate = args.to || args.recipient || args.email || args.path || args.name || args.id;
  const text = String(candidate || '').trim();
  if (!text || text.length > 80) return '';
  if (/token|secret|bearer/i.test(text)) return '';
  return text;
}

export function summarizeMcpApproval({ connection, classified, args } = {}) {
  const identity =
    connection?.accountLabel ||
    connection?.name ||
    connection?.accountIdentity ||
    'this connection';
  const account = connection?.accountIdentity ? ` (${connection.accountIdentity})` : '';
  const action = actionPhrase(classified);
  const target = targetFromArgs(args);
  const title = target
    ? `LYKN is ready to ${action} from ${identity} to ${target}.`
    : `LYKN is ready to ${action} from ${identity}${account}.`;
  const approveLabel =
    classified?.consequence === CONSEQUENCE.DESTRUCTIVE
      ? 'Delete'
      : classified?.consequence === CONSEQUENCE.SENSITIVE
        ? 'Continue'
        : /send/.test(action)
          ? 'Send'
          : 'Allow';
  return {
    kind: 'mcp_tool',
    title,
    connectionId: connection?.id || classified?.connectionId || null,
    connectionName: connection?.name || null,
    accountIdentity: connection?.accountIdentity || null,
    accountLabel: connection?.accountLabel || null,
    semanticAction: action,
    consequence: classified?.consequence || classified?.consequenceHint || null,
    toolName: classified?.toolName || classified?.serverToolName || null,
    arguments: redactToolArgs(args || {}),
    actions: [
      { id: 'approve', label: approveLabel },
      { id: 'cancel', label: 'Cancel' },
    ],
  };
}
