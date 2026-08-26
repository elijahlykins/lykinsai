/**
 * Canonicalize a local MCP launch into { command, args[] }.
 * Never stores or executes a raw shell string.
 */

const WRAPPERS = new Set(['npx', 'npm', 'node', 'nodejs', 'python', 'python3', 'uvx', 'uv', 'bunx', 'bun', 'deno']);

const SHELL_META = /[|&;<>$`\n\r]|&&|\|\|/;

export function tokenizeCommandLine(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'missing_command' };
  if (text.length > 500) return { ok: false, error: 'command_too_long' };
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) return { ok: false, error: 'unbalanced_quotes' };
  if (current) parts.push(current);
  if (!parts.length) return { ok: false, error: 'missing_command' };
  return { ok: true, parts };
}

export function parseLocalCommand(input) {
  if (input && typeof input === 'object' && (input.command || Array.isArray(input.args))) {
    const command = String(input.command || '').trim();
    const args = Array.isArray(input.args) ? input.args.map((part) => String(part)) : [];
    if (!command) return { ok: false, error: 'missing_command' };
    return { ok: true, command, args, confirmInstall: !!input.confirmInstall };
  }
  const parsed = tokenizeCommandLine(input);
  if (!parsed.ok) return parsed;
  const [command, ...args] = parsed.parts;
  return { ok: true, command, args, confirmInstall: false };
}

export function isWrapperCommand(command) {
  const base = String(command || '').split(/[/\\]/).pop() || '';
  return WRAPPERS.has(base.toLowerCase());
}

export function hasShellMetacharacters(value) {
  return SHELL_META.test(String(value || ''));
}

export { WRAPPERS };
