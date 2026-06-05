import { spawn } from 'node:child_process';
import { runPythonSnippet } from '../runPython.js';

const MAX_CODE_LEN = 12_000;
const MAX_OUTPUT_CHARS = 16_000;
const TIMEOUT_MS = 15_000;

const NODE_BLOCKED = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\bchild_process\b/,
  /\bfs\b/,
  /\bnet\b/,
  /\bdgram\b/,
  /\bcluster\b/,
  /\bworker_threads\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
];

function validateNodeCode(code) {
  const src = String(code || '').trim();
  if (!src) return { ok: false, error: 'code is required' };
  if (src.length > MAX_CODE_LEN) return { ok: false, error: 'code_too_long' };
  for (const re of NODE_BLOCKED) {
    if (re.test(src)) return { ok: false, error: 'code_contains_blocked_construct' };
  }
  return { ok: true, code: src };
}

function runNodeSnippet(code) {
  const validation = validateNodeCode(code);
  if (!validation.ok) return Promise.resolve(validation);

  const nodeBin = process.env.NODE_BIN || 'node';
  return new Promise((resolve) => {
    const child = spawn(nodeBin, ['-e', validation.code], {
      env: { NODE_NO_WARNINGS: '1', PATH: process.env.PATH || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err?.message || 'spawn_failed' });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, error: 'execution_timeout', timeout_ms: TIMEOUT_MS });
        return;
      }
      resolve({
        ok: exitCode === 0,
        language: 'javascript',
        exit_code: exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

const ANALYSIS_MODES = new Set(['debug', 'review']);

/**
 * Run code snippets — Python analysis profile for debug/review/data workflows.
 */
export async function runCode(args = {}) {
  const language = String(args.language || 'python').trim().toLowerCase();
  const mode = String(args.mode || 'write').trim().toLowerCase();
  const code = String(args.code || '');
  const profile =
    args.profile === 'analysis' || ANALYSIS_MODES.has(mode) ? 'analysis' : 'strict';

  if (language === 'python' || language === 'py') {
    const result = await runPythonSnippet(code, { profile });
    return { ...result, language: 'python', mode, profile };
  }
  if (language === 'javascript' || language === 'js' || language === 'node') {
    const result = await runNodeSnippet(code);
    return { ...result, mode, profile: 'strict' };
  }
  return {
    ok: false,
    error: 'unsupported_language',
    supported: ['python', 'javascript'],
    hint: 'For other languages, return code in your reply text instead of calling this tool.',
  };
}
