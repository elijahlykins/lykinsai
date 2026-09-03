/**
 * Infer semantic capability needs from Task objective / user text.
 * Deterministic. Conservative. Used by ExternalToolResolver.
 */

import { parseCapability } from './capabilityRegistry.js';

// Naming an app or its domain nouns discloses the domain's WRITE tools too,
// not just reads. Verb lists cannot keep up with typos ("right out" for
// "write out") and paraphrases ("jot down", "throw in") — and repeatedly
// under-disclosing writes made the model tell users it "only has read
// access". Over-inferring a write need is safe: it only widens which tools
// are DISCLOSED; execution still passes the capability check, the
// consequence/approval gate (sends and deletes always confirm), and the
// multi-account ambiguity gate (never guesses which account writes).
// The verb rules remain for send/delete needs, which stay intent-gated.
const NEED_RULES = [
  {
    re: /\b(send|compose|reply to|forward)\b[\s\S]{0,60}\b(emails?|e-mails?|gmail|mail)\b|\b(emails?|e-mails?|gmail)\b[\s\S]{0,60}\b(send|compose|reply|forward)\b/i,
    needs: ['communication.email.send', 'communication.email.read'],
  },
  {
    re: /\b(emails?|e-mails?|gmail|inbox|inboxes|unread|mail from|messages? from)\b/i,
    needs: ['communication.email.search', 'communication.email.read', 'communication.email.send'],
  },
  {
    re: /\b(slack|discord|teams|chat messages?)\b/i,
    needs: ['communication.message.search', 'communication.message.read', 'communication.message.send'],
  },
  {
    re: /\b(send|post|write|reply)\b[\s\S]{0,60}\b(slack|discord|teams|channel)\b|\b(slack|discord|teams|channel)\b[\s\S]{0,60}\b(send|post|write|reply|message)\b/i,
    needs: ['communication.message.send', 'communication.message.read'],
  },
  {
    re: /\b(calendars?|meetings?|events?|appointments?|ics|availability)\b/i,
    needs: ['calendar.read', 'calendar.write'],
  },
  {
    re: /\b(create|schedule|book|add|set up|move|reschedule|update)\b[\s\S]{0,60}\b(meetings?|events?|appointments?|calendar)\b|\b(meetings?|events?|appointments?|calendar)\b[\s\S]{0,60}\b(create|schedule|book|move|reschedule|update)\b/i,
    needs: ['calendar.write', 'calendar.read'],
  },
  {
    re: /\b(cancel|delete|remove)\b[\s\S]{0,60}\b(meetings?|events?|appointments?)\b/i,
    needs: ['calendar.delete', 'calendar.write', 'calendar.read'],
  },
  {
    re: /\b(notion|drive|dropbox|documents?|docs?|google docs?|sheets?|spreadsheets?|pdfs?|files? in)\b/i,
    needs: ['documents.search', 'documents.read', 'documents.write'],
  },
  {
    re: /\b(edit|write|update|create|add|append|insert|upload|save|rename|put)\b[\s\S]{0,80}\b(documents?|pages?|docs?|notion|drive|dropbox|sheets?|spreadsheets?)\b|\b(documents?|pages?|docs?|notion|drive|dropbox|sheets?|spreadsheets?)\b[\s\S]{0,80}\b(edit|write|update|append|add|insert|upload|save|rename|put)\b/i,
    needs: ['documents.write', 'documents.read'],
  },
  {
    re: /\b(github|gitlab|pull requests?|prs?|repos?|repositor(?:y|ies)|commits?)\b/i,
    needs: ['source_control.read', 'source_control.write'],
  },
  {
    re: /\b(create|open|file|add|comment on|merge|close|update)\b[\s\S]{0,60}\b(issues?|pull requests?|prs?|repos?|branch(?:es)?|github|gitlab)\b|\b(github|gitlab)\b[\s\S]{0,60}\b(create|comment|merge|close|add|open|update)\b/i,
    needs: ['source_control.write', 'source_control.read'],
  },
  {
    re: /\b(linear|jira|tickets?|issue trackers?)\b/i,
    needs: ['projects.read', 'projects.write'],
  },
  {
    re: /\b(create|add|update|close|assign|move)\b[\s\S]{0,60}\b(tickets?|tasks?|linear|jira)\b|\b(linear|jira|tickets?)\b[\s\S]{0,60}\b(create|add|update|close|assign)\b/i,
    needs: ['projects.write', 'projects.read'],
  },
  {
    re: /\b(crm|hubspot|salesforce|contacts?|leads?|deals?)\b/i,
    needs: ['crm.read', 'crm.write'],
  },
  {
    re: /\b(add|create|update|log)\b[\s\S]{0,60}\b(contacts?|leads?|deals?|hubspot|salesforce|crm)\b|\b(hubspot|salesforce|crm)\b[\s\S]{0,60}\b(add|create|update|log)\b/i,
    needs: ['crm.write', 'crm.read'],
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
