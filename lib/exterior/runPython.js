import { spawn } from 'node:child_process';

const MAX_CODE_LEN = 12_000;
const MAX_OUTPUT_CHARS = 20_000;
const TIMEOUT_MS = 15_000;

/**
 * Server-side code execution kill switch.
 * Production is fail-closed (disabled) unless LYKN_ENABLE_CODE_EXEC=true.
 * Dev stays opt-out via LYKN_DISABLE_CODE_EXEC (historical default: enabled).
 */
export function isCodeExecDisabled() {
  const disable = process.env.LYKN_DISABLE_CODE_EXEC;
  if (disable === '1' || disable === 'true') return true;
  if (process.env.NODE_ENV === 'production') {
    const enable = process.env.LYKN_ENABLE_CODE_EXEC;
    return enable !== '1' && enable !== 'true';
  }
  return false;
}

// Reflection/introspection escapes shared by both profiles — these are how a
// denylisted name gets reached indirectly (getattr(__builtins__, 'ex'+'ec')).
const PY_REFLECTION_BLOCKED = [
  /\bgetattr\s*\(/i,
  /\bsetattr\s*\(/i,
  /\bglobals\s*\(/i,
  /\blocals\s*\(/i,
  /\bvars\s*\(/i,
  /\b__import__\b/i,
  /\bbuiltins\b/i,
  // hex/unicode escape obfuscation (e.g. "\x6f\x73" == "os")
  /\\x[0-9a-f]{2}/i,
  /\\u[0-9a-f]{4}/i,
  /\\N\{/i,
];

const STRICT_BLOCKED = [
  /\bimport\b/i,
  /\bfrom\b/i,
  /\bopen\s*\(/i,
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
  /\bcompile\s*\(/i,
  /\bos\./i,
  /\bsys\./i,
  /\bsubprocess\b/i,
  /\bsocket\b/i,
  /\brequests\b/i,
  /\burllib\b/i,
  /\bhttpx\b/i,
  /\bshutil\b/i,
  /\bpathlib\b/i,
  /\bpickle\b/i,
  /\b__\w*__\b/,
  /\binput\s*\(/i,
  /\bbreakpoint\s*\(/i,
  ...PY_REFLECTION_BLOCKED,
];

const ANALYSIS_ALLOWED_IMPORTS = new Set([
  'math',
  'json',
  'statistics',
  're',
  'datetime',
  'collections',
  'itertools',
  'fractions',
  'decimal',
  'random',
]);

const ANALYSIS_BLOCKED = [
  /\bopen\s*\(/i,
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
  /\bcompile\s*\(/i,
  /\bos\./i,
  /\bsys\./i,
  /\bsubprocess\b/i,
  /\bsocket\b/i,
  /\brequests\b/i,
  /\burllib\b/i,
  /\bhttpx\b/i,
  /\bshutil\b/i,
  /\bpathlib\b/i,
  /\bpickle\b/i,
  /\b__\w*__\b/,
  /\binput\s*\(/i,
  /\bbreakpoint\s*\(/i,
  ...PY_REFLECTION_BLOCKED,
];

function validatePythonCode(code, profile = 'strict') {
  const src = String(code || '').trim();
  if (!src) return { ok: false, error: 'code is required' };
  if (src.length > MAX_CODE_LEN) return { ok: false, error: 'code_too_long' };

  if (profile === 'analysis') {
    const importMatches = src.match(/^\s*(?:from|import)\s+([a-zA-Z0-9_]+)/gm) || [];
    for (const line of importMatches) {
      const mod = line.replace(/^\s*(?:from|import)\s+([a-zA-Z0-9_]+).*$/, '$1');
      if (!ANALYSIS_ALLOWED_IMPORTS.has(mod)) {
        return { ok: false, error: 'import_not_allowed', module: mod };
      }
    }
    for (const re of ANALYSIS_BLOCKED) {
      if (re.test(src)) return { ok: false, error: 'code_contains_blocked_construct' };
    }
    return { ok: true, code: src, profile };
  }

  for (const re of STRICT_BLOCKED) {
    if (re.test(src)) return { ok: false, error: 'code_contains_blocked_construct' };
  }
  return { ok: true, code: src, profile: 'strict' };
}

/**
 * Run short Python snippets in a subprocess (no network, timeout capped).
 */
export function runPythonSnippet(code, opts = {}) {
  if (isCodeExecDisabled()) {
    return Promise.resolve({
      ok: false,
      error: 'code_execution_disabled',
      hint: 'Server-side code execution is disabled. Return code in your reply instead.',
    });
  }
  const profile = opts.profile === 'analysis' ? 'analysis' : 'strict';
  const validation = validatePythonCode(code, profile);
  if (!validation.ok) return Promise.resolve(validation);

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(pythonBin, ['-c', validation.code], {
      env: { PYTHONDONTWRITEBYTECODE: '1', PATH: process.env.PATH || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_CHARS) stderr = stderr.slice(0, MAX_OUTPUT_CHARS);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err?.code === 'ENOENT') {
        resolve({ ok: false, error: 'python_not_available', hint: 'Install python3 or set PYTHON_BIN' });
        return;
      }
      resolve({ ok: false, error: err?.message || 'spawn_failed' });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, error: 'execution_timeout', timeout_ms: timeoutMs });
        return;
      }
      resolve({
        ok: exitCode === 0,
        exit_code: exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        truncated: stdout.length >= MAX_OUTPUT_CHARS,
        profile,
      });
    });
  });
}
