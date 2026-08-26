// Signed-URL cache helpers shared by the Vault page and useVaultSignedUrls.
// Extracted verbatim from src/pages/Vault.jsx (Vault decomposition phase, see
// docs/REFACTOR_LOG.md). Pure functions over a caller-owned Map — the cache
// itself lives in a ref so its identity and lifetime are unchanged.

// Signed-URL freshness ----------------------------------------------------
// Supabase signed URLs embed a JWT in the `?token=` query param whose `exp`
// claim is the absolute UNIX expiry. The previous implementation cached
// these URLs forever (effectively for 7 days, which was the requested TTL),
// so a long-open tab eventually served URLs that 403'd on every request.
// The retry budget would then exhaust and the user was stuck on a "Try
// again" button that re-used the same expired URL.
//
// We now (a) request short-lived URLs (1h), (b) decode the JWT to learn
// the real expiry, and (c) refetch any cached URL within 5 minutes of
// expiry so a refetch happens proactively rather than waiting for the
// browser to surface a 403.
export const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
const SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min early

function parseSignedUrlExpiry(url) {
  try {
    const u = new URL(url);
    // Supabase signed URLs embed a JWT in `?token=`.
    const token = u.searchParams.get("token");
    if (token) {
      const parts = token.split(".");
      if (parts.length >= 2) {
        let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = payload.length % 4;
        if (pad) payload += "=".repeat(4 - pad);
        const json = JSON.parse(atob(payload));
        if (typeof json.exp === "number") return json.exp * 1000;
      }
    }
    // Branded file-proxy links: `/f/<payloadB64>.<sig>` with unix `e` in payload.
    const proxyMatch = u.pathname.match(/^\/f\/([A-Za-z0-9_-]+)\./);
    if (proxyMatch) {
      let payload = proxyMatch[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = payload.length % 4;
      if (pad) payload += "=".repeat(4 - pad);
      const json = JSON.parse(atob(payload));
      if (typeof json.e === "number") return json.e * 1000;
    }
  } catch {
    // Malformed token / non-JWT URL — caller falls back to a default TTL.
  }
  return null;
}

// Read a cached signed URL, returning null if the entry is missing OR
// within `SIGNED_URL_REFRESH_BUFFER_MS` of expiry. Stale entries are
// evicted as a side effect so subsequent reads don't re-trigger the
// expensive expiry check on every render.
export function readCachedSignedUrl(cache, cacheKey) {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  // Back-compat: older code paths stored a bare string. Treat as
  // unknown-expiry and refetch on next miss; for now return it so we
  // don't break in-flight renders during the upgrade.
  if (typeof entry === "string") return entry;
  if (entry.expiresAt && entry.expiresAt - Date.now() <= SIGNED_URL_REFRESH_BUFFER_MS) {
    cache.delete(cacheKey);
    return null;
  }
  return entry.url;
}

export function writeCachedSignedUrl(cache, cacheKey, url) {
  if (!url) return;
  const exp = parseSignedUrlExpiry(url);
  // If the JWT has no usable exp claim, assume the URL lives for the
  // configured TTL minus the refresh buffer so we still rotate it.
  const expiresAt = exp || Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
  cache.set(cacheKey, { url, expiresAt });
}
