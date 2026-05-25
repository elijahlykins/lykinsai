// ============================================================================
// validation.js — Zod-based request validation middleware factory
// ============================================================================
// Single source of truth for request-body / query / params validation across
// every route in server.js. Built on top of the existing `zod` dependency
// (3.24.2 in package.json) — no new third-party additions.
//
// USAGE:
//   import { z } from 'zod';
//   import { validate } from './validation.js';
//
//   const createFeedSchema = z.object({
//     url: z.string().url().max(2048),
//     initialBackfillCount: z.number().int().min(0).max(50).optional(),
//   });
//
//   app.post('/api/feeds', requireAuth, validate(createFeedSchema), handler);
//
// WHY safeParse + req.body REPLACEMENT:
//   `result.data` ONLY contains keys declared in the schema. Unknown keys
//   are stripped (Zod default `.strict()` is opt-in; we deliberately use the
//   default which strips). This is the single most important property: a
//   malicious client cannot smuggle `{ user_id: '<other>' }` past the route
//   handler, even if the handler later reads `req.body.user_id` by accident.
//
// ERROR SHAPE (4xx response):
//   { error: 'invalid_request', fields: { <field>: [<msg>, ...] } }
//   The `fields` object is a Zod flattened error map — safe to send to the
//   client because it only mentions the field names the client itself sent.
//   We never include schema internals, regex patterns, or stack data.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Optional observability hook (Agent 06)
// ---------------------------------------------------------------------------
//
// On every validation failure we WANT to emit a SecurityEvent.VALIDATION_FAILURE
// event (field names only — NEVER the submitted values, which may contain
// sensitive content the user typed by accident). But validation.js must stay
// importable from tests and standalone scripts without dragging in security-
// logger.js + a real Supabase client. The compromise: an opt-in hook that
// server.js wires at boot with `setValidationFailureHook(fn)`. If the hook
// is unset, validation behaves exactly as it did before Agent 06 — a 400
// response with the sanitized field-error map. No-op fallback is the
// intended dev / test behavior.

let _onValidationFailure = null;

/**
 * Wire an observer for validation failures. Called once at boot from
 * server.js with a fire-and-forget callback. Setting to null disables.
 *
 * Callback signature: (info) => void
 *   info.target   - 'body' | 'query' | 'params' (which middleware tripped)
 *   info.fields   - array of field names that failed (no values)
 *   info.req      - the Express request (read req.ip, req.path, req.method)
 */
export function setValidationFailureHook(fn) {
  _onValidationFailure = (typeof fn === 'function') ? fn : null;
}

function emitFailure(target, result, req) {
  if (!_onValidationFailure) return;
  let fields = [];
  try {
    fields = Object.keys(result.error?.flatten?.()?.fieldErrors || {});
  } catch {
    fields = [];
  }
  try {
    _onValidationFailure({ target, fields, req });
  } catch {
    // Hook must never break the validation response.
  }
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Build a request-body validator from a Zod schema.
 * On success: replaces req.body with the parsed (and unknown-field-stripped)
 *             data, then calls next().
 * On failure: returns 400 with a sanitized field-error map.
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      emitFailure('body', result, req);
      return res.status(400).json({
        error: 'invalid_request',
        fields: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    return next();
  };
}

/**
 * Same shape as validate(), but for req.query.
 * Express represents query as an object whose values are strings (or arrays
 * of strings); use z.coerce.* for numeric query params.
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      emitFailure('query', result, req);
      return res.status(400).json({
        error: 'invalid_request',
        fields: result.error.flatten().fieldErrors,
      });
    }
    // Express 5: req.query is a getter — assign onto req for handlers that
    // read req.query.<field> downstream.
    req.query = result.data;
    return next();
  };
}

/**
 * Same shape, for req.params. Useful for routes whose :param values must
 * match a known allowlist (e.g. connector provider id) before any handler
 * logic runs.
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      emitFailure('params', result, req);
      return res.status(400).json({
        error: 'invalid_request',
        fields: result.error.flatten().fieldErrors,
      });
    }
    req.params = result.data;
    return next();
  };
}

// ---------------------------------------------------------------------------
// Reusable primitives — keep per-route schemas short and consistent
// ---------------------------------------------------------------------------

// Trim + length-cap a string. Zod doesn't trim by default; transform does.
export const zTrimmedString = (max) =>
  z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(max));

// Optional version of the above — empty string AND missing both treated as undefined.
export const zOptionalTrimmedString = (max) =>
  z.string()
    .optional()
    .transform((s) => (typeof s === 'string' ? s.trim() : s))
    .refine(
      (s) => s === undefined || s.length <= max,
      { message: `Must be at most ${max} characters` },
    )
    .transform((s) => (s === undefined || s === '' ? undefined : s));

export const zUuid = z.string().uuid();
export const zHttpUrl = z.string().url().max(2048);
export const zEmail = z.string().email().max(320);
export const zShortString = z.string().max(500);
export const zLongString = z.string().max(10_000);

// Re-export zod itself so callers can `import { z, validate } from './validation.js'`.
export { z };
