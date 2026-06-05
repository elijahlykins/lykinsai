import { spawn } from 'node:child_process';

const TIMEOUT_MS = 10_000;
const MAX_EXPR_LEN = 2000;

const WRAPPER = `
import json, sys
from sympy import *
from sympy.parsing.sympy_parser import parse_expr

expr_str = sys.argv[1]
mode = sys.argv[2]
x, y, z, t, n = symbols('x y z t n')

try:
    expr = parse_expr(expr_str, evaluate=False)
    out = {'expression': expr_str, 'parsed': str(expr)}
    if mode == 'solve':
        out['result'] = [str(s) for s in solve(expr)]
    elif mode == 'integrate':
        out['result'] = str(integrate(expr, x))
    elif mode == 'differentiate':
        out['result'] = str(diff(expr, x))
    elif mode == 'expand':
        out['result'] = str(expand(expr))
    elif mode == 'factor':
        out['result'] = str(factor(expr))
    else:
        out['result'] = str(simplify(expr))
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(1)
`;

/** SymPy execution path (internal). */
export function runSymbolicMath(args = {}) {
  const expression = String(args.expression || '').trim();
  const mode = String(args.mode || 'simplify').trim().toLowerCase();
  if (!expression) return Promise.resolve({ ok: false, error: 'expression is required' });
  if (expression.length > MAX_EXPR_LEN) return Promise.resolve({ ok: false, error: 'expression_too_long' });

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  return new Promise((resolve) => {
    const child = spawn(pythonBin, ['-c', WRAPPER, expression, mode], {
      env: { PYTHONDONTWRITEBYTECODE: '1', PATH: process.env.PATH || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err?.code === 'ENOENT') {
        resolve({ ok: false, error: 'python_not_available' });
        return;
      }
      resolve({ ok: false, error: err?.message || 'spawn_failed' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, error: 'execution_timeout' });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          error: 'symbolic_math_failed',
          stderr: stderr.trim(),
          hint: 'Install sympy: pip install sympy',
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          resolve({ ok: false, error: parsed.error });
          return;
        }
        resolve({ ok: true, mode, ...parsed });
      } catch {
        resolve({ ok: false, error: 'invalid_sympy_output', stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}
