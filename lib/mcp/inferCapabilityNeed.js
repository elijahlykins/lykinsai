/**
 * Infer semantic capability needs from Task objective / user text.
 * Deterministic. Conservative. Used by ExternalToolResolver.
 */

import { parseCapability } from './capabilityRegistry.js';

const NEED_RULES = [
  {
    re: /\b(send|compose|reply to|forward)\b.{0,40}\b(email|e-mail|gmail|mail)\b|\b(email|e-mail|gmail)\b.{0,40}\b(send|compose|reply)\b/i,
    needs: ['communication.email.send', 'communication.email.read'],
  },
  {
    re: /\b(email|e-mail|gmail|inbox|mail from|message from)\b/i,
    needs: ['communication.email.search', 'communication.email.read'],
  },
  {
    re: /\b(slack|discord|teams|chat message)\b/i,
    needs: ['communication.message.search', 'communication.message.read'],
  },
  {
    re: /\b(calendar|meeting|event|ics|availability)\b/i,
    needs: ['calendar.read'],
  },
  {
    re: /\b(create|schedule|book)\b.{0,30}\b(meeting|event|calendar)\b/i,
    needs: ['calendar.write', 'calendar.read'],
  },
  {
    re: /\b(notion|drive|dropbox|document|google doc|sheet|pdf|file in)\b/i,
    needs: ['documents.read'],
  },
  {
    re: /\b(edit|write|update|create)\b.{0,30}\b(document|page|doc|notion)\b/i,
    needs: ['documents.write', 'documents.read'],
  },
  {
    re: /\b(github|gitlab|pull request|\bpr\b|repo|repository|commit)\b/i,
    needs: ['source_control.read'],
  },
  {
    re: /\b(linear|jira|ticket|issue tracker)\b/i,
    needs: ['projects.read'],
  },
  {
    re: /\b(crm|hubspot|salesforce|contact)\b/i,
    needs: ['crm.read'],
  },
];

export function inferCapabilityNeeds(text, { explicit = [] } = {}) {
  const fromExplicit = (Array.isArray(explicit) ? explicit : [])
    .map((item) => parseCapability(item))
    .filter(Boolean)
    .map((parsed) => parsed.id);
  const blob = String(text || '');
  const fromText = [];
  for (const rule of NEED_RULES) {
    if (rule.re.test(blob)) fromText.push(...rule.needs);
  }
  return [...new Set([...fromExplicit, ...fromText])];
}
