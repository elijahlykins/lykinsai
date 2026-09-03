/**
 * Progressive disclosure bridge: selected MCP tools → chat/Task tool schemas.
 * Tool names are namespaced so two Gmail accounts cannot collide.
 */

import { MCP_BOUNDS } from './bounds.js';
import { sanitizeToolDescription } from './trust.js';

const OPENAI_NAME_RE = /[^a-zA-Z0-9_-]/g;

// ─── Input-schema sanitizing ────────────────────────────────────────────────
// Third-party toolkits ship schemas with Python-isms (`type: "None"`,
// `type: "str"`). Providers hard-reject the ENTIRE request over one bad
// schema — one malformed tool must never cost the model its whole toolset.

const TYPE_ALIASES = {
  none: 'null',
  nonetype: 'null',
  null: 'null',
  str: 'string',
  string: 'string',
  text: 'string',
  int: 'integer',
  integer: 'integer',
  long: 'integer',
  float: 'number',
  double: 'number',
  number: 'number',
  bool: 'boolean',
  boolean: 'boolean',
  dict: 'object',
  object: 'object',
  list: 'array',
  tuple: 'array',
  array: 'array',
};
const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function normalizeType(type) {
  if (Array.isArray(type)) {
    const mapped = [...new Set(type.map((t) => TYPE_ALIASES[String(t).toLowerCase()]).filter((t) => VALID_TYPES.has(t)))];
    return mapped.length ? (mapped.length === 1 ? mapped[0] : mapped) : undefined;
  }
  const mapped = TYPE_ALIASES[String(type).toLowerCase()];
  return VALID_TYPES.has(mapped) ? mapped : undefined;
}

const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_NODE_KEYS = new Set(['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']);
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

function sanitizeSchemaNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return {};
  if (Array.isArray(node)) return node.map((item) => sanitizeSchemaNode(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') {
      const type = normalizeType(value);
      if (type !== undefined) out.type = type;
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, sanitizeSchemaNode(v, depth + 1)]),
        );
      }
      continue;
    }
    if (SCHEMA_NODE_KEYS.has(key)) {
      out[key] = value && typeof value === 'object' ? sanitizeSchemaNode(value, depth + 1) : value;
      continue;
    }
    if (SCHEMA_LIST_KEYS.has(key)) {
      if (Array.isArray(value)) out[key] = value.map((item) => sanitizeSchemaNode(item, depth + 1));
      continue;
    }
    if (key === 'required') {
      if (Array.isArray(value)) out.required = value.filter((item) => typeof item === 'string');
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Coerce any MCP tool input schema into a provider-safe JSON Schema whose
 *  top level is `type: "object"`. Never throws. */
export function sanitizeMcpInputSchema(schema) {
  const cleaned = sanitizeSchemaNode(
    schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {},
  );
  if (cleaned.type !== 'object') {
    return {
      type: 'object',
      properties:
        cleaned.properties && typeof cleaned.properties === 'object' ? cleaned.properties : {},
      ...(Array.isArray(cleaned.required) && cleaned.required.length ? { required: cleaned.required } : {}),
    };
  }
  if (!cleaned.properties || typeof cleaned.properties !== 'object' || Array.isArray(cleaned.properties)) {
    cleaned.properties = {};
  }
  return cleaned;
}

export function mcpChatToolName(connectionId, toolName) {
  const short = String(connectionId || '').replace(/-/g, '').slice(0, 8);
  const tool = String(toolName || 'tool').replace(OPENAI_NAME_RE, '_').slice(0, 40);
  return `mcp_${short}_${tool}`.slice(0, MCP_BOUNDS.TOOL_NAME_CHARS);
}

export function parseMcpChatToolName(name, bindings) {
  if (bindings && bindings[name]) return bindings[name];
  return null;
}

export function toChatTools(resolvedTools) {
  const bindings = {};
  const tools = [];
  for (const item of resolvedTools || []) {
    const name = mcpChatToolName(item.connectionId, item.toolName);
    bindings[name] = {
      connectionId: item.connectionId,
      toolName: item.toolName,
      consequenceHint: item.consequenceHint,
      semanticCapabilities: item.semanticCapabilities,
    };
    const description = sanitizeToolDescription(
      `${item.description || item.toolName} (external: ${item.connectionName || 'MCP'}; untrusted metadata)`,
    );
    tools.push({
      name,
      description: description.text,
      inputSchema: sanitizeMcpInputSchema(item.inputSchema),
      mcp: true,
      connectionId: item.connectionId,
      sourceToolName: item.toolName,
    });
  }
  return { tools, bindings };
}

export function estimateSchemaTokens(tools) {
  const json = JSON.stringify(
    (tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || tool.function?.description,
      parameters: tool.inputSchema || tool.function?.parameters || tool.input_schema,
    })),
  );
  return Math.ceil(Buffer.byteLength(json, 'utf8') / 4);
}
