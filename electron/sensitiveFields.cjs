/**
 * Sensitive-field / sensitive-value classification — the single source of
 * truth shared by the eval guard (which refuses to TYPE secrets) and the
 * browser snapshot builder (which refuses to SURFACE secret values to the
 * model). Kept dependency-free so either side can import it without creating a
 * require cycle.
 */

/** Fields we must never surface (or type) the value of, by label or name. */
const SENSITIVE_FIELD_RE =
  /\b(password|passwd|passcode|pin|cvv|cvc|security code|card ?number|credit ?card|debit ?card|expiry|expiration|ssn|social security|routing|account ?number|tax ?id|passport|licen[cs]e ?number)\b/i;

/** Values that are secrets regardless of what the field claims to be. */
const SENSITIVE_VALUE_RE =
  /\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b/;

/** Platform autocomplete tokens that name a secret (or a one-time code). */
const SENSITIVE_AUTOCOMPLETE_RE =
  /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(?:-month|-year)?)\b/i;

/** OTP / verification-code labels the field regex above does not already cover. */
const OTP_LABEL_RE =
  /\b(otp|one[\s-]?time(?:\s+(?:code|passcode|password))?|verification\s+code|security\s+code|auth(?:entication)?\s+code|2fa|mfa)\b/i;

/**
 * Does this DOM-catalog element accept a secret whose value must not leave the
 * page? Checks input type, the platform autocomplete hint, the field name, the
 * visible label, and — as a backstop — the value's own shape (card/SSN).
 *
 * @param {{type?: string, autocomplete?: string, name?: string, label?: string, value?: string}} item
 * @param {string} [label] the already-normalized label, if the caller has one
 */
function isSensitiveField(item, label) {
  if (!item || typeof item !== "object") return false;
  const type = String(item.type || "").toLowerCase();
  if (type === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE_RE.test(String(item.autocomplete || ""))) return true;
  const haystack = `${String(item.name || "")} ${String(label || item.label || "")}`;
  if (SENSITIVE_FIELD_RE.test(haystack)) return true;
  if (OTP_LABEL_RE.test(haystack)) return true;
  if (SENSITIVE_VALUE_RE.test(String(item.value || ""))) return true;
  return false;
}

module.exports = {
  SENSITIVE_FIELD_RE,
  SENSITIVE_VALUE_RE,
  SENSITIVE_AUTOCOMPLETE_RE,
  OTP_LABEL_RE,
  isSensitiveField,
};
