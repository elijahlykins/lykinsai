export const USER_PREFERENCE_DEFAULTS = Object.freeze({
  memory_paused: false,
  training_opt_out: false,
  chat_retention_days: null,
  email_product_updates: true,
  night_shift_enabled: false,
  night_shift_tier: 'brief',
  metadata: {},
});

const PREFERENCE_KEYS = Object.freeze(Object.keys(USER_PREFERENCE_DEFAULTS));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sanitisePreferencesPatch(body) {
  const out = {};
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body_required' };

  if ('memory_paused' in body) {
    if (typeof body.memory_paused !== 'boolean') return { ok: false, reason: 'memory_paused_must_be_boolean' };
    out.memory_paused = body.memory_paused;
  }
  if ('training_opt_out' in body) {
    if (typeof body.training_opt_out !== 'boolean') return { ok: false, reason: 'training_opt_out_must_be_boolean' };
    out.training_opt_out = body.training_opt_out;
  }
  if ('email_product_updates' in body) {
    if (typeof body.email_product_updates !== 'boolean') {
      return { ok: false, reason: 'email_product_updates_must_be_boolean' };
    }
    out.email_product_updates = body.email_product_updates;
  }
  if ('night_shift_enabled' in body) {
    if (typeof body.night_shift_enabled !== 'boolean') {
      return { ok: false, reason: 'night_shift_enabled_must_be_boolean' };
    }
    out.night_shift_enabled = body.night_shift_enabled;
  }
  if ('night_shift_tier' in body) {
    const tier = String(body.night_shift_tier || '').trim();
    if (tier !== 'brief' && tier !== 'research' && tier !== 'delegate') {
      return { ok: false, reason: 'night_shift_tier_invalid' };
    }
    out.night_shift_tier = tier;
  }
  if ('chat_retention_days' in body) {
    const v = body.chat_retention_days;
    if (v === null) {
      out.chat_retention_days = null;
    } else if (Number.isInteger(v) && v >= 1 && v <= 3650) {
      out.chat_retention_days = v;
    } else {
      return { ok: false, reason: 'chat_retention_days_invalid' };
    }
  }
  if ('metadata' in body) {
    if (!isPlainObject(body.metadata)) {
      return { ok: false, reason: 'metadata_must_be_object' };
    }
    out.metadata = body.metadata;
  }

  if (Object.keys(out).length === 0) return { ok: false, reason: 'no_valid_fields' };
  return { ok: true, patch: out };
}

/**
 * Build the row for a preferences upsert without wiping sibling fields.
 * Metadata is shallow-merged so a product-update dismiss cannot clobber
 * other account keys.
 */
export function mergePreferenceRow(existing, patch, defaults = USER_PREFERENCE_DEFAULTS) {
  const row = {};
  for (const key of PREFERENCE_KEYS) {
    if (existing && Object.prototype.hasOwnProperty.call(existing, key) && existing[key] !== undefined) {
      row[key] = existing[key];
    } else {
      row[key] = defaults[key];
    }
  }
  const nextPatch = patch && typeof patch === 'object' ? patch : {};
  for (const key of PREFERENCE_KEYS) {
    if (key === 'metadata') continue;
    if (Object.prototype.hasOwnProperty.call(nextPatch, key)) {
      row[key] = nextPatch[key];
    }
  }
  const prevMeta = isPlainObject(row.metadata) ? row.metadata : {};
  if (isPlainObject(nextPatch.metadata)) {
    row.metadata = { ...prevMeta, ...nextPatch.metadata };
  } else {
    row.metadata = prevMeta;
  }
  return row;
}
