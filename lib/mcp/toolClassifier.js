/**
 * Conservative metadata classifier for arbitrary MCP tool names.
 *
 * Runs on connect / metadata refresh / schema version change — not per Task turn.
 * MCP annotations are SIGNALS, not authority. LYKN remains the final classifier.
 * Output describes the tool. It cannot grant Task authority.
 */

import { createHash } from 'node:crypto';
import {
  CONSEQUENCE,
  capabilityId,
  consequenceForVerb,
  parseCapability,
} from './capabilityRegistry.js';
import { sanitizeToolDescription } from './trust.js';
import { MCP_BOUNDS, boundJson } from './bounds.js';
import { CLASSIFIER_VERSION } from './protocol.js';

const EMAIL_RE = /\b(email|gmail|mail|inbox|message|smtp|imap)\b/i;
const CAL_RE = /\b(calendar|event|meeting|ics|schedule)\b/i;
const DOC_RE = /\b(document|drive|file|page|notion|doc|sheet|pdf)\b/i;
const PROJECT_RE = /\b(issue|ticket|linear|jira|task|project|board)\b/i;
const GIT_RE = /\b(git|github|gitlab|pull.?request|repo|commit)\b/i;
const CRM_RE = /\b(crm|contact|hubspot|salesforce|customer)\b/i;
const PERM_RE = /\b(permissions?|acl|share|sharing|iam|role|grant access|workspace permissions?)\b/i;
const SEARCH_RE = /\b(search|find|query|lookup|list|get|read|fetch|load)\b/i;
const WRITE_RE = /\b(write|send|create|update|edit|patch|put|post|delete|remove|compose|reply|add|insert|modify|move|set|archive|upload|rename|assign|mark|append|duplicate|copy|watch|schedule|unschedule|pause|resume|cancel|publish|revoke)\b/i;
const DELETE_RE = /\b(delete|remove|destroy|drop|erase|wipe|purge|shred|flush|empty|revoke|unshare|trash)\b/i;
const SEND_RE = /\b(send|deliver|forward|mail to)\b/i;
const SENSITIVE_RE = /\b(password|secret|ssn|credit.?card|payroll|private|permission|acl)\b/i;
const DRAFT_RE = /\b(draft)\b/i;

export function toolSchemaFingerprint(tool) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: tool?.name || '',
        inputSchema: tool?.inputSchema || {},
        annotations: tool?.annotations || {},
      }),
    )
    .digest('hex')
    .slice(0, 24);
}

function domainFromText(text) {
  if (PERM_RE.test(text) && !EMAIL_RE.test(text)) return { domain: 'permissions', resource: 'grant' };
  if (EMAIL_RE.test(text)) return { domain: 'communication', resource: 'email' };
  // Source-control tokens outrank calendar: "repository dispatch event" is a
  // git concept, not a meeting.
  if (GIT_RE.test(text)) return { domain: 'source_control', resource: 'repo' };
  if (CAL_RE.test(text)) return { domain: 'calendar', resource: 'event' };
  if (PROJECT_RE.test(text)) return { domain: 'projects', resource: 'issue' };
  if (CRM_RE.test(text)) return { domain: 'crm', resource: 'record' };
  if (DOC_RE.test(text)) return { domain: 'documents', resource: 'file' };
  return { domain: 'generic', resource: 'tool' };
}

/**
 * Extract a verb signal from one text source, or null when the text carries
 * no signal at all. Callers decide the fail-safe fallback.
 *
 * `name: true` marks the text as a tool name. Names are terse and their
 * search-looking tokens are often resource nouns ("CALENDAR_LIST_INSERT" is
 * an insert into the calendar list, not a list operation), so a write token
 * in a name always wins. Descriptions keep the leading-words guard because
 * they narrate ("Get a message and modify its labels").
 */
function verbSignal(text, { name = false } = {}) {
  if (!text) return null;
  if (DELETE_RE.test(text)) return 'delete';
  if (PERM_RE.test(text) && !/\b(read|list|get|search)\b/i.test(text)) return 'write';
  if (SEND_RE.test(text) && EMAIL_RE.test(text)) return 'send';
  // Drafting is an ordinary reversible write (unless the tool sends or
  // reads drafts, which fall through to the classifications below).
  if (DRAFT_RE.test(text) && !SEND_RE.test(text) && !SEARCH_RE.test(text)) return 'write';
  if (WRITE_RE.test(text) && (name || !SEARCH_RE.test(text.split(/\s+/).slice(0, 3).join(' ')))) {
    if (/\bcreate\b/i.test(text)) return 'create';
    if (/\b(update|patch|modify|edit)\b/i.test(text)) return 'update';
    if (/\bsend\b/i.test(text)) return 'send';
    return 'write';
  }
  if (/\b(search|find|query)\b/i.test(text)) return 'search';
  if (SEARCH_RE.test(text)) return 'read';
  return null;
}

/**
 * The tool NAME is the strongest verb authority ("GMAIL_CREATE_EMAIL_DRAFT"
 * is a create even when its description mentions deleting drafts). The
 * description blob is a fallback only.
 */
function verbFromText(nameText, blob, { schemaWrite = false } = {}) {
  const verb = verbSignal(nameText, { name: true }) || verbSignal(blob);
  if (verb) return verb;
  if (schemaWrite) return 'write';
  // Unknown tools without a read/search signal are not silently READ.
  return 'write';
}

/**
 * Tool names arrive as snake_case / camelCase identifiers. Word-boundary
 * regexes cannot see inside "GMAIL_CREATE_EMAIL_DRAFT" (underscores are word
 * characters), so expose the tokens as plain words.
 */
function normalizeToolName(name) {
  return String(name || '')
    .replace(/[_\-./]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function schemaSuggestsWrite(schema) {
  if (!schema || typeof schema !== 'object') return false;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props).join(' ');
  return /\b(body|content|to|recipient|message|text|html|payload)\b/i.test(keys);
}

/**
 * Annotations may lower our confidence in a matching signal.
 * They must never override a stronger name/schema determination.
 */
function applyAnnotationSignals(verb, annotations = {}) {
  const signals = {
    readOnlyHint: annotations.readOnlyHint === true,
    destructiveHint: annotations.destructiveHint === true,
    openWorldHint: annotations.openWorldHint === true,
    idempotentHint: annotations.idempotentHint === true,
  };
  if (signals.destructiveHint && verb !== 'delete') {
    return { verb: 'delete', annotationConflict: verb === 'read' || signals.readOnlyHint };
  }
  if (signals.readOnlyHint && ['write', 'send', 'create', 'update', 'delete'].includes(verb)) {
    return { verb, annotationConflict: true };
  }
  return { verb, annotationConflict: false, signals };
}

function failSafeConsequence(verb, { known, destructive, sensitive, annotationConflict, confidence, domain }) {
  let consequence = consequenceForVerb(verb, { destructive, sensitive: false });
  if (domain === 'permissions' && verb !== 'read' && verb !== 'search') {
    consequence = CONSEQUENCE.SENSITIVE;
  } else if (sensitive && verb !== 'read' && verb !== 'search') {
    consequence = CONSEQUENCE.SENSITIVE;
  }
  if (destructive || verb === 'delete') consequence = CONSEQUENCE.DESTRUCTIVE;
  if (!known && (consequence === CONSEQUENCE.WRITE || consequence === CONSEQUENCE.CONSEQUENTIAL)) {
    consequence = CONSEQUENCE.CONSEQUENTIAL;
  }
  if (annotationConflict && consequence === CONSEQUENCE.READ) {
    consequence = CONSEQUENCE.CONSEQUENTIAL;
  }
  if (!known && confidence < 0.4 && verb !== 'read' && verb !== 'search') {
    consequence = consequence === CONSEQUENCE.DESTRUCTIVE ? consequence : CONSEQUENCE.CONSEQUENTIAL;
  }
  return consequence;
}

export function classifyMcpTool(tool, { serverInfo, modelClassification } = {}) {
  const name = String(tool?.name || '').slice(0, MCP_BOUNDS.TOOL_NAME_CHARS);
  const description = sanitizeToolDescription(tool?.description || tool?.title || '');
  const annotations = tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const schemaBound = boundJson(tool?.inputSchema || {}, MCP_BOUNDS.TOOL_SCHEMA_BYTES);
  const nameText = normalizeToolName(name);
  const blob = `${nameText} ${description.text} ${serverInfo?.name || ''}`;
  const nameDomain = domainFromText(nameText);
  const { domain, resource } = nameDomain.domain !== 'generic' ? nameDomain : domainFromText(blob);
  const schemaWrite = schemaSuggestsWrite(schemaBound.value);
  let verb = verbFromText(nameText, blob, { schemaWrite });
  const annotated = applyAnnotationSignals(verb, annotations);
  verb = annotated.verb;
  const parsed = parseCapability(`${domain}.${resource}.${verb}`);
  // Destructive is keyed to the verb, annotations, and the tool NAME. A
  // description that merely mentions deletion ("...to delete a draft use
  // gmail_delete_draft") must not mark a create tool DESTRUCTIVE.
  const destructive = annotations.destructiveHint === true || verb === 'delete' || DELETE_RE.test(nameText);
  const sensitive = SENSITIVE_RE.test(blob) || domain === 'permissions';
  const known = domain !== 'generic';
  const confidence = known
    ? annotated.annotationConflict
      ? 0.48
      : description.text
        ? 0.78
        : 0.58
    : 0.32;
  const consequence = failSafeConsequence(verb, {
    known,
    destructive,
    sensitive,
    annotationConflict: annotated.annotationConflict,
    confidence,
    domain,
  });

  let merged = {
    connectionId: tool?.connectionId || null,
    serverToolName: name,
    toolName: name,
    semanticCapabilities: parsed ? [capabilityId(parsed)] : ['generic.read'],
    capabilities: parsed ? [capabilityId(parsed)] : ['generic.read'],
    consequenceHint: consequence,
    consequence,
    confidence,
    classifierVersion: CLASSIFIER_VERSION,
    classifier: CLASSIFIER_VERSION,
    sourceAnnotations: {
      readOnlyHint: annotations.readOnlyHint === true,
      destructiveHint: annotations.destructiveHint === true,
    },
    schemaFingerprint: toolSchemaFingerprint(tool),
    readOnlyHint: annotations.readOnlyHint === true,
    destructiveHint: destructive,
    sensitive,
    description: description.text,
    inputSchema: schemaBound.value,
    schemaTruncated: schemaBound.truncated,
    annotationConflict: !!annotated.annotationConflict,
  };

  if (modelClassification && typeof modelClassification === 'object' && confidence < 0.5) {
    merged = mergeModelClassification(merged, modelClassification);
  }
  return merged;
}

function consequenceRank(value) {
  return (
    {
      [CONSEQUENCE.READ]: 1,
      [CONSEQUENCE.WRITE]: 2,
      [CONSEQUENCE.CONSEQUENTIAL]: 3,
      [CONSEQUENCE.SENSITIVE]: 4,
      [CONSEQUENCE.DESTRUCTIVE]: 5,
    }[value] || 3
  );
}

function mergeModelClassification(deterministic, model) {
  const modelConsequence = CONSEQUENCE[model.consequence] ? model.consequence : deterministic.consequence;
  const consequence =
    consequenceRank(modelConsequence) > consequenceRank(deterministic.consequence)
      ? modelConsequence
      : deterministic.consequence;
  return {
    ...deterministic,
    consequence,
    consequenceHint: consequence,
    confidence: Math.min(0.7, Math.max(deterministic.confidence, Number(model.confidence) || 0)),
    classifier: `${CLASSIFIER_VERSION}+model`,
  };
}

export function classifyToolList(tools, serverInfo, { modelByFingerprint } = {}) {
  return (Array.isArray(tools) ? tools : []).map((tool) =>
    classifyMcpTool(tool, {
      serverInfo,
      modelClassification: modelByFingerprint?.[toolSchemaFingerprint(tool)],
    }),
  );
}

export function classificationIsStale(classified, tool) {
  if (!classified?.schemaFingerprint) return true;
  return classified.schemaFingerprint !== toolSchemaFingerprint(tool);
}

/**
 * Stored classifications are a CACHE keyed by CLASSIFIER_VERSION. Rows
 * written by an older classifier are re-derived on read (deterministic and
 * cheap) so classifier fixes take effect immediately instead of waiting for
 * the next tool discovery on every existing connection.
 */
export function freshenClassifiedTools(classifiedTools, serverInfo) {
  const list = Array.isArray(classifiedTools) ? classifiedTools : [];
  if (!list.length) return list;
  if (list.every((t) => t?.classifierVersion === CLASSIFIER_VERSION)) return list;
  return classifyToolList(
    list.map((t) => ({
      connectionId: t?.connectionId || null,
      name: t?.toolName || t?.serverToolName || '',
      description: t?.description || '',
      inputSchema: t?.inputSchema || {},
      annotations: {
        readOnlyHint: t?.sourceAnnotations?.readOnlyHint === true,
        destructiveHint: t?.sourceAnnotations?.destructiveHint === true,
      },
    })),
    serverInfo,
  );
}
