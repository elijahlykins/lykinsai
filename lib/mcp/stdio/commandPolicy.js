/**
 * Local MCP launch policy. Spawn argv directly. Never shell=true.
 */

import path from 'node:path';
import os from 'node:os';
import { isWrapperCommand, hasShellMetacharacters, WRAPPERS } from './parseLocalCommand.js';

const FORBIDDEN_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
  'eval',
  'open',
]);

const DANGEROUS_FLAGS = new Set(['-c', '/c', '-Command', '-EncodedCommand']);

export function assertLocalCommandSafe({ command, args = [], confirmInstall = false } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'missing_command' };
  if (cmd.length > 240) return { ok: false, error: 'command_too_long' };
  if (hasShellMetacharacters(cmd) && !cmd.includes(path.sep) === false) {
    /* path separators are allowed; metacharacters are not */
  }
  if (/[|&;<>$`\n\r]/.test(cmd)) return { ok: false, error: 'unsafe_command' };

  const base = path.basename(cmd).toLowerCase();
  if (FORBIDDEN_COMMANDS.has(base)) return { ok: false, error: 'forbidden_command' };

  const argv = Array.isArray(args) ? args.map((part) => String(part)) : [];
  if (argv.length > 32) return { ok: false, error: 'too_many_args' };
  for (const arg of argv) {
    if (arg.length > 400) return { ok: false, error: 'arg_too_long' };
    if (arg.includes('\0')) return { ok: false, error: 'unsafe_arg' };
  }

  if (FORBIDDEN_COMMANDS.has(base) || argv.some((arg) => DANGEROUS_FLAGS.has(arg))) {
    if (DANGEROUS_FLAGS.has(argv[0]) || argv.some((arg, i) => DANGEROUS_FLAGS.has(arg) && i === 0)) {
      return { ok: false, error: 'shell_invocation_rejected' };
    }
    if (argv.some((arg) => DANGEROUS_FLAGS.has(arg))) {
      return { ok: false, error: 'shell_invocation_rejected' };
    }
  }

  const wrapper = isWrapperCommand(cmd);
  if (!wrapper && !path.isAbsolute(cmd) && cmd.includes(path.sep)) {
    return { ok: false, error: 'relative_path_rejected' };
  }
  if (!wrapper && !path.isAbsolute(cmd) && !WRAPPERS.has(base)) {
    return { ok: false, error: 'unknown_command' };
  }

  const needsInstall = wrapper && /^(npx|uvx|bunx)$/i.test(base);
  if (needsInstall && !confirmInstall) {
    return { ok: false, error: 'install_confirmation_required', command: cmd, args: argv };
  }

  return {
    ok: true,
    command: cmd,
    args: canonicalizeWrapperArgs(base, argv, confirmInstall),
    wrapper,
  };
}

function canonicalizeWrapperArgs(base, args, confirmInstall) {
  if (base === 'npx' && confirmInstall && !args.includes('-y') && !args.includes('--yes')) {
    return ['-y', ...args];
  }
  return args;
}

export function assertWorkingDirectorySafe(cwd) {
  if (!cwd) return { ok: true, cwd: null };
  const text = String(cwd).trim();
  if (!text) return { ok: true, cwd: null };
  if (!path.isAbsolute(text)) return { ok: false, error: 'cwd_must_be_absolute' };
  if (/[|&;<>$`\n\r]/.test(text)) return { ok: false, error: 'unsafe_cwd' };
  const resolved = path.resolve(text);
  const home = os.homedir();
  const allowedRoots = [home, '/tmp', os.tmpdir(), process.cwd()].filter(Boolean);
  const ok = allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!ok) return { ok: false, error: 'cwd_outside_allowed_roots' };
  return { ok: true, cwd: resolved };
}
