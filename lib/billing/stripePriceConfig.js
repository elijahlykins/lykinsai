/**
 * Startup checks for Stripe Price env vars.
 * Does not invent Price ids. Does not crash local development.
 */

const PRICE_ENV = Object.freeze({
  studioMonthly: 'STRIPE_PRICE_STUDIO_MONTHLY',
  studioMonthlyLegacy: 'STRIPE_PRICE_STUDIO_MONTHLY_LEGACY',
  studioAnnual: 'STRIPE_PRICE_STUDIO_ANNUAL',
  maxMonthly: 'STRIPE_PRICE_MAX_MONTHLY',
  maxAnnual: 'STRIPE_PRICE_MAX_ANNUAL',
  studentMonthly: 'STRIPE_PRICE_STUDENT_MONTHLY',
  studentAnnual: 'STRIPE_PRICE_STUDENT_ANNUAL',
});

const ACTIVE_PRICE_KEYS = Object.freeze([
  ['studioMonthly', 'missing_studio_monthly', 'studio_monthly_not_a_price_id'],
  ['studioAnnual', 'missing_studio_annual', 'studio_annual_not_a_price_id'],
  ['studentMonthly', 'missing_student_monthly', 'student_monthly_not_a_price_id'],
  ['studentAnnual', 'missing_student_annual', 'student_annual_not_a_price_id'],
  ['maxMonthly', 'missing_max_monthly', 'max_monthly_not_a_price_id'],
  ['maxAnnual', 'missing_max_annual', 'max_annual_not_a_price_id'],
]);

function readId(env, name) {
  return String(env?.[name] || '').trim();
}

export function inspectStripePriceConfig(env = process.env) {
  const studioMonthly = readId(env, PRICE_ENV.studioMonthly);
  const studioLegacy = readId(env, PRICE_ENV.studioMonthlyLegacy);
  const warnings = [];

  for (const [key, missingWarning, invalidWarning] of ACTIVE_PRICE_KEYS) {
    const priceId = readId(env, PRICE_ENV[key]);
    if (!priceId) warnings.push(missingWarning);
    else if (!/^price_/.test(priceId)) warnings.push(invalidWarning);
  }
  if (studioMonthly && studioLegacy && studioMonthly === studioLegacy) {
    warnings.push('monthly_equals_legacy');
  }
  if (studioLegacy && !/^price_/.test(studioLegacy)) {
    warnings.push('studio_legacy_not_a_price_id');
  }

  return {
    ok: warnings.length === 0,
    warnings,
    studioMonthlyConfigured: Boolean(studioMonthly),
    studioLegacyConfigured: Boolean(studioLegacy),
    reversed: warnings.includes('monthly_equals_legacy'),
    envNames: PRICE_ENV,
  };
}

export function logStripePriceConfig(env = process.env, { logger = console } = {}) {
  const report = inspectStripePriceConfig(env);
  if (report.ok) {
    logger.log('[billing] stripe_price_config {"ok":true,"studioMonthlyConfigured":true}');
    return report;
  }
  const payload = JSON.stringify({
    ok: false,
    warnings: report.warnings,
    studioMonthlyConfigured: report.studioMonthlyConfigured,
    studioLegacyConfigured: report.studioLegacyConfigured,
  });
  if (env.NODE_ENV === 'production' || env.LYKN_BILLING_STRICT === '1') {
    logger.error(`[billing] stripe_price_config ${payload}`);
  } else {
    logger.warn(`[billing] stripe_price_config ${payload}`);
  }
  return report;
}

export function assertProCheckoutPriceNotLegacy(priceId, env = process.env) {
  const monthly = readId(env, PRICE_ENV.studioMonthly);
  const legacy = readId(env, PRICE_ENV.studioMonthlyLegacy);
  if (!priceId || !monthly) return { ok: true };
  if (legacy && priceId === legacy && monthly !== legacy) {
    return { ok: false, error: 'pro_checkout_used_legacy_price' };
  }
  if (legacy && monthly === legacy) {
    return { ok: false, error: 'pro_monthly_equals_legacy' };
  }
  return { ok: true };
}
