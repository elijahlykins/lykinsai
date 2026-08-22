/**
 * Read-only reader for the user's Supabase data.
 *
 * The migration runs against the production project, because that is where the
 * user's data is. So this module is physically incapable of writing: every
 * request goes through `send()`, which throws on any method other than GET or
 * HEAD. That is enforced rather than documented, and there is a test for it.
 * The worst outcome of a bug in the importer should be an incomplete local
 * copy, never a damaged cloud one.
 *
 * Auth is the user's own access token, forwarded from the renderer, so reads
 * are bounded by the same row-level security policies the app already runs
 * under. The service-role key is never involved.
 *
 * PostgREST specifics worth knowing:
 *   - Pagination is keyset on (created_at, id). Offsets would skip or repeat
 *     rows if anything changes mid-import, and an import can take a while.
 *   - Exact counts come from the Content-Range header with Prefer: count=exact.
 */

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

const DEFAULT_PAGE_SIZE = 500;
const MAX_RETRIES = 5;

let config = { url: null, accessToken: null, apiKey: null, userId: null };

/**
 * @param {object} options
 * @param {string} options.url          Supabase project URL.
 * @param {string} options.accessToken  The signed-in user's access token.
 * @param {string} [options.apiKey]     Anon key, sent as apikey when present.
 * @param {string} options.userId
 */
function configure(options = {}) {
  config = {
    url: String(options.url || "").replace(/\/+$/, ""),
    accessToken: options.accessToken || null,
    apiKey: options.apiKey || options.accessToken || null,
    userId: options.userId || null,
  };
  return { ok: true, configured: isConfigured() };
}

function isConfigured() {
  return Boolean(config.url && config.accessToken && config.userId);
}

function requireConfig() {
  if (!isConfigured()) {
    throw new Error("cloud source is not configured (need url, accessToken, userId)");
  }
  return config;
}

function reset() {
  config = { url: null, accessToken: null, apiKey: null, userId: null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Issue one read. Retries on rate limits and transient server errors, honoring
 * Retry-After when the server sends one.
 */
async function send(path, { method = "GET", headers = {}, signal } = {}) {
  const { url, accessToken, apiKey } = requireConfig();

  const upper = String(method).toUpperCase();
  if (!READ_ONLY_METHODS.has(upper)) {
    throw new Error(`cloud source is read-only; refusing ${upper}`);
  }

  const target = path.startsWith("http") ? path : `${url}${path}`;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      const res = await fetch(target, {
        method: upper,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(apiKey ? { apikey: apiKey } : {}),
          ...headers,
        },
        signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500, 8000);
        lastError = new Error(`HTTP ${res.status} from ${path}`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} from ${path}: ${body.slice(0, 200)}`);
      }

      return res;
    } catch (err) {
      if (err?.name === "AbortError" || err?.message === "cancelled") throw err;
      lastError = err;
      // A network blip during a long migration should not lose the whole run.
      if (attempt < MAX_RETRIES - 1) await sleep(Math.min(2 ** attempt * 500, 8000));
    }
  }

  throw lastError || new Error(`request failed: ${path}`);
}

function restPath(table, params = {}) {
  const search = new URLSearchParams(params);
  return `/rest/v1/${table}?${search.toString()}`;
}

/** Exact row count for a table, scoped to the user. */
async function count(table, extra = {}) {
  const { userId } = requireConfig();
  const res = await send(restPath(table, { select: "id", user_id: `eq.${userId}`, ...extra }), {
    method: "HEAD",
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  // Content-Range looks like "0-0/1234"; the total is what we want.
  const range = res.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

/**
 * One keyset page ordered by (created_at, id).
 *
 * @param {string} table
 * @param {object} [opts]
 * @param {{created_at: string, id: string}} [opts.after] Last row of the previous page.
 */
async function page(table, { after, limit = DEFAULT_PAGE_SIZE, select = "*", signal } = {}) {
  const { userId } = requireConfig();
  const params = {
    select,
    user_id: `eq.${userId}`,
    order: "created_at.asc,id.asc",
    limit: String(Math.max(1, Math.min(Number(limit) || DEFAULT_PAGE_SIZE, 1000))),
  };

  if (after?.created_at && after?.id) {
    // Strictly "after" the cursor in the same order as the sort, so rows that
    // share a timestamp are still walked exactly once.
    params.or = `(created_at.gt.${after.created_at},and(created_at.eq.${after.created_at},id.gt.${after.id}))`;
  }

  const res = await send(restPath(table, params), { signal });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Walk an entire table, a page at a time.
 * @returns {AsyncGenerator<object[]>}
 */
async function* pages(table, opts = {}) {
  let after = opts.after || null;
  for (;;) {
    const rows = await page(table, { ...opts, after });
    if (!rows.length) return;
    yield rows;
    const last = rows[rows.length - 1];
    if (!last?.created_at || !last?.id) return;
    after = { created_at: last.created_at, id: last.id };
    if (rows.length < (opts.limit || DEFAULT_PAGE_SIZE)) return;
  }
}

/** Fetch rows by an `in` filter — used to pull chat states for a page of chats. */
async function byIds(table, column, ids, { select = "*", signal } = {}) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) return [];

  const out = [];
  // URLs have limits; chunk rather than build one enormous in() list.
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await send(
      restPath(table, { select, [column]: `in.(${chunk.join(",")})` }),
      { signal },
    );
    const rows = await res.json();
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

/**
 * Download one object from Storage.
 *
 * Uses the `authenticated` endpoint with the user's token rather than minting
 * signed URLs: signing is an extra round trip per file, and the tokens expire
 * mid-migration for large vaults.
 *
 * @returns {Promise<Buffer|null>} null when the object is missing (404), which
 *   is common — rows outlive their files after a failed upload.
 */
async function downloadObject(bucket, objectPath, { signal } = {}) {
  const { url, accessToken, apiKey } = requireConfig();
  const encoded = String(objectPath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const target = `${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encoded}`;

  const res = await fetch(target, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(apiKey ? { apikey: apiKey } : {}),
    },
    signal,
  });

  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`storage HTTP ${res.status} for ${objectPath}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Confirm the token works and belongs to the user we were told about. */
async function checkAccess() {
  const { userId } = requireConfig();
  const res = await send("/auth/v1/user");
  const user = await res.json();
  const matches = String(user?.id || "") === String(userId);
  return {
    ok: matches,
    userId: user?.id || null,
    email: user?.email || null,
    reason: matches ? null : "access token belongs to a different user",
  };
}

module.exports = {
  configure,
  reset,
  isConfigured,
  send,
  count,
  page,
  pages,
  byIds,
  downloadObject,
  checkAccess,
  READ_ONLY_METHODS,
  DEFAULT_PAGE_SIZE,
};
