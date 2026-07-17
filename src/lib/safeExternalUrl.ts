// Shared allowlist for URLs that get rendered into an anchor `href` (or any
// navigable sink). Blocks the dangerous schemes — `javascript:`, `data:`,
// `vbscript:`, `file:` — that turn a click into script execution or local
// file access in the app origin. Vault/chat attachment URLs can be
// user-pasted or model-generated, so every href built from them must pass
// through here.

const SAFE_SCHEME_RE = /^(https?|mailto|tel):/i;

/**
 * Return the URL if it uses a safe scheme, otherwise null. A bare
 * scheme-less string (e.g. "example.com/x") is treated as https.
 */
export function safeExternalUrl(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  // Has an explicit scheme — only allow the safe ones. Uses the same shape as
  // a URL scheme (letter followed by letters/digits/+-.). This catches
  // obfuscations like "java\tscript:" only after the browser would strip
  // control chars, so also reject control characters outright.
  if (/[\u0000-\u001f]/.test(trimmed)) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return SAFE_SCHEME_RE.test(trimmed) ? trimmed : null;
  }

  // Scheme-less — assume https only when it looks like a host, never blindly
  // prepend a scheme to arbitrary text.
  if (
    trimmed.includes(".") ||
    /^localhost(:\d+)?(\/|$|\?|#)/i.test(trimmed) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(trimmed)
  ) {
    return `https://${trimmed}`;
  }
  return null;
}

/**
 * Like safeExternalUrl but for attachment/file anchors, which legitimately use
 * `blob:` (local object URLs) and image/pdf `data:` URIs in addition to
 * http(s). Still blocks `javascript:`, `vbscript:`, `data:text/html`, and
 * other script-capable schemes. Returns null when the URL isn't safe to
 * navigate to.
 */
export function safeAttachmentUrl(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) {
    // Scheme-less — reuse the external-URL host heuristic.
    return safeExternalUrl(trimmed);
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (["http", "https", "mailto", "tel", "blob"].includes(scheme)) return trimmed;
  if (scheme === "data") {
    return /^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf);/i.test(trimmed)
      ? trimmed
      : null;
  }
  return null;
}
