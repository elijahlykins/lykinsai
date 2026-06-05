import { geminiGenerateText } from '../geminiClient.js';
import { runSymbolicMath as runSympy } from './symbolicMathCore.js';

const MODE_PROMPTS = {
  simplify: 'Simplify this expression. Return only the simplified result.',
  solve: 'Solve this equation/expression for the variable(s). Return only the solution(s).',
  integrate: 'Integrate this expression with respect to x. Return only the result.',
  differentiate: 'Differentiate this expression with respect to x. Return only the derivative.',
  expand: 'Expand this expression. Return only the expanded form.',
  factor: 'Factor this expression. Return only the factored form.',
};

/**
 * Symbolic math — SymPy when available, Gemini fallback otherwise.
 */
export async function runSymbolicMath(args = {}) {
  const expression = String(args.expression || '').trim();
  const mode = String(args.mode || 'simplify').trim().toLowerCase();
  if (!expression) return { ok: false, error: 'expression is required' };

  const sympyResult = await runSympy({ expression, mode });
  if (sympyResult.ok) {
    return { ...sympyResult, provider: 'sympy' };
  }

  if (!process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      error: sympyResult.error || 'symbolic_math_unavailable',
      hint: sympyResult.hint || 'Install python3 + sympy, or configure GOOGLE_API_KEY / OPENAI_API_KEY',
    };
  }

  const prompt = [
    MODE_PROMPTS[mode] || MODE_PROMPTS.simplify,
    `Expression: ${expression}`,
    'Use standard mathematical notation. No explanation unless the result is ambiguous.',
  ].join('\n');

  if (process.env.GOOGLE_API_KEY) {
    const gem = await geminiGenerateText({ prompt });
    if (gem.ok && gem.text) {
      return {
        ok: true,
        mode,
        expression,
        result: gem.text.trim(),
        provider: 'gemini_fallback',
        sympy_error: sympyResult.error || null,
      };
    }
  }

  return {
    ok: false,
    error: sympyResult.error || 'symbolic_math_failed',
    hint: sympyResult.hint,
    detail: sympyResult.stderr || null,
  };
}
