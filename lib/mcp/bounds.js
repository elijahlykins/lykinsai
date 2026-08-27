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
  MAX_LIST_PAGES: 5,
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
