/**
 * Conservative metadata classifier for arbitrary MCP tool names.
 *
 * Runs on connect / metadata refresh / schema version change — not per Task turn.
 * Output describes the tool. It cannot grant Task authority.
 */

import {
  CONSEQUENCE,
  capabilityId,
  consequenceForVerb,
  parseCapability,
} from './capabilityRegistry.js';
import { sanitizeToolDescription } from './trust.js';
import { MCP_BOUNDS, boundJson } from './bounds.js';

const EMAIL_RE = /\b(email|gmail|mail|inbox|message|smtp|imap)\b/i;
const CAL_RE = /\b(calendar|event|meeting|ics|schedule)\b/i;
const DOC_RE = /\b(document|drive|file|page|notion|doc|sheet|pdf)\b/i;
const PROJECT_RE = /\b(issue|ticket|linear|jira|task|project|board)\b/i;
const GIT_RE = /\b(git|github|gitlab|pull.?request|repo|commit)\b/i;
const CRM_RE = /\b(crm|contact|hubspot|salesforce|customer)\b/i;
const SEARCH_RE = /\b(search|find|query|lookup|list|get|read|fetch|load)\b/i;
const WRITE_RE = /\b(write|send|create|update|patch|put|post|delete|remove|compose|reply)\b/i;
const DELETE_RE = /\b(delete|remove|destroy|drop|erase)\b/i;
const SEND_RE = /\b(send|deliver|mail to|compose)\b/i;
const SENSITIVE_RE = /\b(password|secret|ssn|credit.?card|payroll|private)\b/i;

function domainFromText(text) {
  if (EMAIL_RE.test(text)) return { domain: 'communication', resource: 'email' };
  if (CAL_RE.test(text)) return { domain: 'calendar', resource: 'event' };
  if (GIT_RE.test(text)) return { domain: 'source_control', resource: 'repo' };
  if (PROJECT_RE.test(text)) return { domain: 'projects', resource: 'issue' };
  if (CRM_RE.test(text)) return { domain: 'crm', resource: 'record' };
  if (DOC_RE.test(text)) return { domain: 'documents', resource: 'file' };
  return { domain: 'generic', resource: 'tool' };
}

function verbFromText(text, annotations = {}) {
  if (annotations.destructiveHint === true || DELETE_RE.test(text)) return 'delete';
  if (SEND_RE.test(text) && EMAIL_RE.test(text)) return 'send';
  if (annotations.readOnlyHint === true) {
    return SEARCH_RE.test(text) && /\bsearch|find|query\b/i.test(text) ? 'search' : 'read';
  }
  if (WRITE_RE.test(text) && !SEARCH_RE.test(text.split(/\s+/).slice(0, 3).join(' '))) {
    if (/\bcreate\b/i.test(text)) return 'create';
    if (/\bupdate|patch\b/i.test(text)) return 'update';
    if (/\bsend\b/i.test(text)) return 'send';
    return 'write';
  }
  if (/\bsearch|find|query\b/i.test(text)) return 'search';
  if (SEARCH_RE.test(text)) return 'read';
  if (WRITE_RE.test(text)) return 'write';
  return annotations.readOnlyHint === false ? 'write' : 'read';
}

function schemaSuggestsWrite(schema) {
  if (!schema || typeof schema !== 'object') return false;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props).join(' ');
  return /\b(body|content|to|recipient|message|text|html|payload)\b/i.test(keys);
}

export function classifyMcpTool(tool, { serverInfo } = {}) {
  const name = String(tool?.name || '').slice(0, MCP_BOUNDS.TOOL_NAME_CHARS);
  const description = sanitizeToolDescription(tool?.description || tool?.title || '');
  const annotations = tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const schemaBound = boundJson(tool?.inputSchema || {}, MCP_BOUNDS.TOOL_SCHEMA_BYTES);
  const blob = `${name} ${description.text} ${serverInfo?.name || ''}`;
  const { domain, resource } = domainFromText(blob);
  let verb = verbFromText(blob, annotations);
  if (verb === 'read' && schemaSuggestsWrite(schemaBound.value) && annotations.readOnlyHint !== true) {
    verb = 'write';
  }
  const parsed = parseCapability(`${domain}.${resource}.${verb}`);
  const destructive = annotations.destructiveHint === true || verb === 'delete';
  const sensitive = SENSITIVE_RE.test(blob);
  const known = domain !== 'generic';
  const consequence = consequenceForVerb(verb, { destructive, sensitive });
  const hardened =
    !known && (consequence === CONSEQUENCE.WRITE || consequence === CONSEQUENCE.CONSEQUENTIAL)
      ? CONSEQUENCE.CONSEQUENTIAL
      : consequence;

  return {
    toolName: name,
    semanticCapabilities: parsed ? [capabilityId(parsed)] : ['generic.read'],
    consequenceHint: hardened,
    confidence: known ? (description.text ? 0.72 : 0.55) : 0.35,
    readOnlyHint: annotations.readOnlyHint === true,
    destructiveHint: destructive,
    sensitive,
    description: description.text,
    inputSchema: schemaBound.value,
    schemaTruncated: schemaBound.truncated,
    classifier: 'deterministic_v1',
  };
}

export function classifyToolList(tools, serverInfo) {
  return (Array.isArray(tools) ? tools : []).map((tool) => classifyMcpTool(tool, { serverInfo }));
}
