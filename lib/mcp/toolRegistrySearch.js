/**
 * Connected-app tool registry search.
 *
 * Every connected app's classified tools are a searchable skill index.
 * The model looks up the action it needs (list projects, send email,
 * add a page) and then calls that tool — instead of hoping a 10-slot
 * ranking guess included the right one.
 *
 * This is not app-specific. Scoring is name + description overlap
 * against the query, with a bias for tools that can run now (no missing
 * ids) and a penalty for experimental variants.
 */

const READ_INTENT_RE = /\b(read|see|show|list|view|check|what|which|get|find|look|fetch|pull|summarize|summarise)\b/i;
const WRITE_INTENT_RE = /\b(add|create|update|send|delete|remove|write|edit|set|upload|post|publish|schedule)\b/i;
const EXPERIMENTAL_NAME_RE = /\b(alpha|beta|deprecated|legacy|experimental)\b/i;
const MY_ACCOUNT_RE = /\b(my|me|mine|i)\b/i;
const AUTHENTICATED_NAME_RE = /\b(authenticated|current.?user|for_the_user|viewer|\bme\b|self)\b/i;
const CONTENTS_QUERY_RE = /\b(in|inside|contents?|files?|code|codebase|tree|readme)\b/i;
const CONTENTS_NAME_RE = /\b(content|contents|files|tree|readme)\b/i;
const PAGINATION_ARGS = new Set(['page', 'per_page', 'perpage', 'limit', 'offset', 'cursor', 'starting_after']);
// Name-shaped args any app might use to look something up. Opaque ids
// (*_id, *_ref, *_sha) are never auto-filled from leftover words.
const NAMED_RESOURCE_ARGS = [
  'query', 'q', 'name', 'title', 'slug', 'repo', 'path', 'email',
  'channel', 'space', 'org', 'owner', 'username', 'login', 'user',
  'project', 'campaign', 'spreadsheet', 'document', 'folder', 'database',
  'page', 'label', 'list', 'board', 'team', 'workspace',
];
const IDENTITY_ARG_KEYS = ['owner', 'username', 'user', 'login', 'org'];
const QUERY_STOP = new Set([
  'can', 'you', 'the', 'and', 'for', 'with', 'from', 'into', 'about', 'what',
  'which', 'how', 'see', 'show', 'list', 'read', 'get', 'find', 'look', 'view',
  'check', 'that', 'this', 'your', 'our', 'any', 'all', 'one', 'are', 'was',
  'have', 'has', 'please', 'just', 'code', 'base', 'codebase', 'app', 'apps',
  'account', 'want', 'need', 'tell', 'give', 'open', 'browse',
  'repo', 'repository', 'file', 'folder', 'directory', 'project', 'campaign',
  'email', 'mail', 'page', 'channel', 'workspace', 'issue', 'issues',
]);

function stemToken(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function tokensOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .map(stemToken);
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function prefixMatch(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function tokenHitsBucket(token, nameTokens, descTokens) {
  if (nameTokens.has(token)) return 'name';
  if (descTokens.has(token)) return 'desc';
  for (const name of nameTokens) {
    if (prefixMatch(token, name)) return 'name';
  }
  for (const desc of descTokens) {
    if (prefixMatch(token, desc)) return 'desc';
  }
  return null;
}

/**
 * Does `text` name this connection? Matches labels and a squashed form
 * so "mail chimp" still names Mailchimp.
 */
export function connectionNamedIn(conn, text) {
  if (!conn || !text) return false;
  const textLower = String(text).toLowerCase();
  const squashed = textLower.replace(/[^a-z0-9]+/g, '');
  const labels = [conn.name, conn.accountLabel, conn.accountIdentity, conn.catalogId]
    .filter(Boolean)
    .map(String);
  for (const label of labels) {
    const labelLower = label.toLowerCase().replace(/^composio:/, '');
    if (labelLower.length >= 3 && textLower.includes(labelLower)) return true;
    const labelSquashed = labelLower.replace(/[^a-z0-9]+/g, '');
    if (labelSquashed.length >= 4 && squashed.includes(labelSquashed)) return true;
    for (const token of labelLower.split(/[^a-z0-9@.]+/)) {
      if (token.length >= 4 && new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(textLower)) {
        return true;
      }
    }
  }
  return false;
}

export function matchConnectedApp(connections, appRef) {
  const ref = String(appRef || '').trim().toLowerCase();
  if (!ref) return null;
  const list = Array.isArray(connections) ? connections : [];
  return (
    list.find((c) => String(c.id || '').toLowerCase() === ref) ||
    list.find((c) => String(c.id || '').toLowerCase().startsWith(ref)) ||
    list.find((c) => String(c.name || '').toLowerCase() === ref) ||
    list.find((c) => String(c.catalogId || '').replace(/^composio:/, '') === ref) ||
    list.find((c) => String(c.name || '').toLowerCase().includes(ref)) ||
    null
  );
}

function schemaOf(tool) {
  return tool?.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {} };
}

function requiredKeys(inputSchema) {
  return Array.isArray(inputSchema?.required) ? inputSchema.required.map(String) : [];
}

/**
 * Required args that are still missing after applying `args`.
 * Pagination and schema defaults do not count. Empty `path` is valid
 * (root listing) when the caller supplied it.
 */
export function unresolvedRequiredArgs(inputSchema, args = {}) {
  const props = inputSchema?.properties && typeof inputSchema.properties === 'object'
    ? inputSchema.properties
    : {};
  const provided = args && typeof args === 'object' ? args : {};
  const missing = [];
  for (const key of requiredKeys(inputSchema)) {
    if (PAGINATION_ARGS.has(key.toLowerCase())) continue;
    if (props[key] && props[key].default !== undefined) continue;
    if (Object.prototype.hasOwnProperty.call(provided, key) && provided[key] !== undefined && provided[key] !== null) {
      continue;
    }
    missing.push(key);
  }
  return missing;
}

export function isOpaqueArgKey(key) {
  const k = String(key || '');
  if (!k || PAGINATION_ARGS.has(k.toLowerCase())) return false;
  return /(_id|_sha|_ref)$/i.test(k) || /^(id|ref|sha)$/i.test(k);
}

function namedResourceArgKeys(inputSchema) {
  const props = inputSchema?.properties && typeof inputSchema.properties === 'object'
    ? inputSchema.properties
    : {};
  return NAMED_RESOURCE_ARGS.filter((key) => props[key] && !isOpaqueArgKey(key));
}

function accountHandle(conn) {
  const identity = String(conn?.accountIdentity || '').trim();
  if (!identity || identity.includes('@') || /\s/.test(identity)) return '';
  return identity;
}

function accountEmail(conn) {
  const identity = String(conn?.accountIdentity || '').trim();
  return identity.includes('@') ? identity : '';
}

function leftoverResourceTokens(queryTokens, connections) {
  const appTokens = new Set();
  for (const conn of connections || []) {
    for (const label of [conn.name, conn.catalogId]) {
      for (const token of tokensOf(String(label || '').replace(/^composio:/, ''))) {
        appTokens.add(token);
      }
    }
  }
  return queryTokens.filter((token) => !QUERY_STOP.has(token) && !appTokens.has(token) && token.length >= 4);
}

/**
 * Fill obvious args from the query leftovers and the connection identity
 * so the model can call a get-by-name tool without asking the user.
 */
export function suggestConnectedToolArgs(inputSchema, leftoverTokens = [], conn = null) {
  const props = inputSchema?.properties && typeof inputSchema.properties === 'object'
    ? inputSchema.properties
    : {};
  const required = requiredKeys(inputSchema);
  const suggested = {};
  const handle = accountHandle(conn);
  const email = accountEmail(conn);
  if (handle) {
    for (const key of IDENTITY_ARG_KEYS) {
      if (props[key]) suggested[key] = handle;
    }
  }
  if (email && props.email) suggested.email = email;
  if (props.path && required.includes('path')) suggested.path = '';
  const leftover = leftoverTokens.filter(Boolean);
  const resourceKey = namedResourceArgKeys(inputSchema).find((key) => !IDENTITY_ARG_KEYS.includes(key) && key !== 'email' && key !== 'path');
  if (resourceKey && leftover[0]) suggested[resourceKey] = leftover[0];
  return suggested;
}

function scoreRegistryTool(tool, queryTokens, queryText, leftoverTokens) {
  const name = normalizeName(tool.toolName || tool.serverToolName);
  const nameTokens = new Set(tokensOf(name));
  const descTokens = new Set(tokensOf(tool.description || ''));
  let score = 0;
  let nameHits = 0;
  for (const token of queryTokens) {
    const bucket = tokenHitsBucket(token, nameTokens, descTokens);
    if (bucket === 'name') {
      score += 6;
      nameHits += 1;
    } else if (bucket === 'desc') {
      score += 2;
    }
  }
  const leftover = leftoverTokens || [];
  const schema = schemaOf(tool);
  const readyNow = unresolvedRequiredArgs(schema).length === 0;
  // Discovery asks ("what's in the engineering channel") often share no
  // tokens with LIST_CONVERSATIONS. A ready list/search still has to enter
  // ranking or every app will look empty.
  if (!score && READ_INTENT_RE.test(queryText) && readyNow && /\b(list|search)\b/.test(name)) {
    score += leftover.length ? 3 : 1;
  }
  if (!score) return 0;
  if (READ_INTENT_RE.test(queryText) && /\b(list|search)\b/.test(name)) {
    // Named resource ("lykinsai") already identifies the thing. A generic
    // list boost would bury get-by-name tools under list-custom-properties.
    score += leftover.length ? 2 : (queryTokens.length <= 4 ? 8 : 4);
  }
  if (WRITE_INTENT_RE.test(queryText) && /\b(send|create|add|update|delete|write)\b/.test(name)) {
    score += 3;
  }
  if (MY_ACCOUNT_RE.test(queryText) && AUTHENTICATED_NAME_RE.test(name)) {
    score += 8;
  }
  if (CONTENTS_QUERY_RE.test(queryText) && CONTENTS_NAME_RE.test(name)) {
    score += 6;
  }
  if (leftover.length && namedResourceArgKeys(schema).length) {
    score += 10;
  }
  if (EXPERIMENTAL_NAME_RE.test(name)) score -= 3;
  score += Math.min(3, nameHits);
  return score;
}

function decorateHit(conn, tool, leftoverTokens, score) {
  const inputSchema = schemaOf(tool);
  const suggestedArgs = suggestConnectedToolArgs(inputSchema, leftoverTokens, conn);
  const missing = unresolvedRequiredArgs(inputSchema, suggestedArgs);
  return {
    app: conn.name || conn.id,
    connectionId: conn.id,
    tool: tool.toolName || tool.serverToolName,
    description: String(tool.description || '').slice(0, 280),
    consequence: tool.consequenceHint || tool.consequence || null,
    inputSchema,
    required: requiredKeys(inputSchema),
    suggestedArgs,
    ready: missing.length === 0,
    missing,
    score,
  };
}

/**
 * Search classified tools across connected apps.
 *
 * @returns {{ app, connectionId, tool, description, consequence, inputSchema, required, suggestedArgs, ready, missing }[]}
 */
export function searchConnectedToolRegistry({
  connections,
  classifiedByConnectionId,
  query,
  contextText,
  app,
  limit = 8,
} = {}) {
  const queryText = [query, contextText].filter(Boolean).map(String).join(' ').trim();
  const queryTokens = [...new Set(tokensOf(queryText))];
  if (!queryTokens.length) return [];
  const all = Array.isArray(connections) ? connections : [];
  const scoped = app ? [matchConnectedApp(all, app)].filter(Boolean) : all;
  const leftoverTokens = leftoverResourceTokens(queryTokens, scoped);
  const cap = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const hits = [];
  for (const conn of scoped) {
    const tools = classifiedByConnectionId?.[conn.id] || conn.classifiedTools || [];
    for (const tool of tools) {
      const score = scoreRegistryTool(tool, queryTokens, queryText, leftoverTokens);
      if (score <= 0) continue;
      const decorated = decorateHit(conn, tool, leftoverTokens, score);
      if (decorated.ready) decorated.score += 6;
      else decorated.score -= 4;
      if (decorated.missing.some(isOpaqueArgKey)) decorated.score -= 6;
      hits.push(decorated);
    }
  }
  hits.sort((a, b) => b.score - a.score || String(a.tool).localeCompare(String(b.tool)));

  // If nothing ready landed in the window, pull the best ready
  // authenticated/list entry point from the same apps so the model has
  // something it can call without an id.
  const sliced = hits.slice(0, cap);
  if (sliced.length && !sliced.some((hit) => hit.ready)) {
    const ready = hits.find((hit) => hit.ready && AUTHENTICATED_NAME_RE.test(normalizeName(hit.tool)));
    const readyList = hits.find((hit) => hit.ready && /\b(list|search)\b/.test(normalizeName(hit.tool)));
    const inject = ready || readyList;
    if (inject && !sliced.some((hit) => hit.tool === inject.tool)) {
      sliced.splice(sliced.length - 1, 1, inject);
    }
  }

  return sliced.map(({ score, ...rest }) => rest);
}
