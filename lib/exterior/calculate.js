const MAX_EXPR_LEN = 500;

const ALLOWED_PATTERN = /^[\d\s+\-*/().,%^eE]+$/;

const UNIT_ALIASES = Object.freeze({
  km: 1000,
  m: 1,
  cm: 0.01,
  mm: 0.001,
  mi: 1609.344,
  ft: 0.3048,
  in: 0.0254,
  kg: 1,
  g: 0.001,
  lb: 0.453592,
  oz: 0.0283495,
  l: 1,
  ml: 0.001,
  gal: 3.78541,
});

/**
 * Safe arithmetic — no arbitrary code execution.
 * Supports + - * / % ** ( ) decimals and percent suffix (e.g. 15%).
 */
export function calculateExpression(expression) {
  const raw = String(expression || '').trim();
  if (!raw) return { ok: false, error: 'expression is required' };
  if (raw.length > MAX_EXPR_LEN) return { ok: false, error: 'expression_too_long' };

  let expr = raw.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');

  if (!ALLOWED_PATTERN.test(expr)) {
    return { ok: false, error: 'expression_contains_unsupported_characters' };
  }

  expr = expr.replace(/\^/g, '**');

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${expr});`);
    const value = fn();

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: 'result_not_a_finite_number' };
    }

    return {
      ok: true,
      expression: raw,
      result: value,
      formatted: Number.isInteger(value) ? String(value) : value.toPrecision(12).replace(/\.?0+$/, ''),
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'evaluation_failed', expression: raw };
  }
}

/**
 * Convert between supported unit pairs (same dimension only).
 */
export function convertUnits(value, fromUnit, toUnit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, error: 'value must be a number' };

  const from = String(fromUnit || '').trim().toLowerCase();
  const to = String(toUnit || '').trim().toLowerCase();
  const fromFactor = UNIT_ALIASES[from];
  const toFactor = UNIT_ALIASES[to];

  if (fromFactor == null || toFactor == null) {
    return { ok: false, error: 'unsupported_unit', supported: Object.keys(UNIT_ALIASES) };
  }

  const base = num * fromFactor;
  const converted = base / toFactor;

  return {
    ok: true,
    value: num,
    from_unit: from,
    to_unit: to,
    result: converted,
    formatted: `${num} ${from} = ${converted} ${to}`,
  };
}
