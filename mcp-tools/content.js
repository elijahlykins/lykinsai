// Shared MCP tool response helpers — isolated from index.js so individual
// tool modules can import without circular-init issues.

export function jsonContent(value) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}

export function textContent(text) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
  };
}

export function errorContent(message) {
  return {
    content: [{ type: 'text', text: `Error: ${String(message || 'unknown')}` }],
    isError: true,
  };
}

export function requireWrite(ctx) {
  if (!ctx?.mcpAuth) return null;
  const scopes = Array.isArray(ctx.mcpAuth.scopes) ? ctx.mcpAuth.scopes : [];
  if (scopes.includes('write')) return null;
  return errorContent(
    'This tool requires a write-capable token, but the bearer presented is read-only. Re-mint the token from /connections without restricting scopes (the default mint is read+write).',
  );
}
