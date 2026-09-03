/**
 * Hard bounds for untrusted MCP payloads.
 * External servers may return megabytes. Model context must not.
 */

export const MCP_BOUNDS = Object.freeze({
  TOOL_DESCRIPTION_CHARS: 600,
  TOOL_NAME_CHARS: 64,
  TOOL_SCHEMA_BYTES: 8_000,
  TOOL_RESULT_BYTES: 32_000,
  RESOURCE_BYTES: 32_000,
  PROMPT_BYTES: 8_000,
  SERVER_INSTRUCTIONS_CHARS: 800,
  MAX_TOOLS_PER_DISCLOSURE: 10,
  // GitHub's Composio catalog is >500 tools. Five pages of ~100 used to
  // stop at GET_A_* / LIST_A_* and drop LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER.
  MAX_LIST_PAGES: 20,
  MAX_TOOLS_DISCOVERED: 2500,
  MAX_TOOLS_CACHED: 500,
  CONNECTION_NAME_CHARS: 80,
  SERVER_URL_CHARS: 2_000,
  REQUEST_TIMEOUT_MS: 20_000,
});

export function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  let out = text;
  while (utf8Bytes(out) > maxBytes && out.length) {
    out = out.slice(0, Math.max(0, out.length - 16));
  }
  return { text: `${out}\n…[truncated]`, truncated: true };
}

// ─── Structured shrinking ────────────────────────────────────────────────────
// Flat byte truncation of serialized JSON keeps whatever happened to be first
// (header fields like total counts) and destroys everything after the cut —
// a campaign list came back as "5 campaigns" with zero campaign names.
// Shrinking instead caps strings, array lengths, object keys, and depth, so
// every item keeps its identifying fields. Providers like Composio also ship
// the entire result as ONE JSON string inside content[0].text; oversized
// strings that parse as JSON are expanded into structure before capping.

const SHRINK_PASSES = [
  { maxString: 2_000, maxArray: 25, maxKeys: 60, maxDepth: 9 },
  { maxString: 800, maxArray: 10, maxKeys: 40, maxDepth: 7 },
  { maxString: 300, maxArray: 5, maxKeys: 24, maxDepth: 5 },
];

function tryParseJsonString(text) {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function shrinkNode(node, limits, depth = 0) {
  if (node == null) return node;
  if (typeof node === 'string') {
    if (node.length <= limits.maxString) return node;
    const parsed = depth < limits.maxDepth ? tryParseJsonString(node) : null;
    if (parsed) return shrinkNode(parsed, limits, depth + 1);
    return `${node.slice(0, limits.maxString)}…[truncated ${node.length - limits.maxString} chars]`;
  }
  if (typeof node !== 'object') return node;
  if (depth >= limits.maxDepth) {
    return Array.isArray(node) ? `[array of ${node.length}]` : '[object]';
  }
  if (Array.isArray(node)) {
    // Items one level from the depth cap would each render as "[object]" —
    // collapse the whole array to a single marker instead of N useless slots.
    if (depth + 1 >= limits.maxDepth && node.some((item) => item && typeof item === 'object')) {
      return `[array of ${node.length}]`;
    }
    const kept = node.slice(0, limits.maxArray).map((item) => shrinkNode(item, limits, depth + 1));
    if (node.length > limits.maxArray) kept.push(`…[${node.length - limits.maxArray} more items]`);
    return kept;
  }
  const entries = Object.entries(node);
  const out = {};
  for (let i = 0; i < entries.length; i += 1) {
    if (i >= limits.maxKeys) {
      out['…'] = `[+${entries.length - limits.maxKeys} more fields]`;
      break;
    }
    out[entries[i][0]] = shrinkNode(entries[i][1], limits, depth + 1);
  }
  return out;
}

export function boundJson(value, maxBytes) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = '"[unserializable]"';
  }
  if (utf8Bytes(json) <= maxBytes) {
    try {
      return { value: JSON.parse(json), truncated: false };
    } catch {
      return { value: null, truncated: false };
    }
  }
  for (const pass of SHRINK_PASSES) {
    let shrunkJson;
    try {
      shrunkJson = JSON.stringify(shrinkNode(value, pass));
    } catch {
      break;
    }
    if (utf8Bytes(shrunkJson) <= maxBytes) {
      return { value: JSON.parse(shrunkJson), truncated: true, shrunk: true };
    }
  }
  const { text } = truncateUtf8(json, maxBytes);
  return {
    value: {
      truncated: true,
      preview: text,
      originalBytes: utf8Bytes(json),
    },
    truncated: true,
  };
}

export function boundText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}
