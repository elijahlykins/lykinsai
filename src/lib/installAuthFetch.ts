import { supabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api-config';
import { isDesktopShell } from '@/lib/webAppAccess';

const _originalFetch = window.fetch.bind(window);

let cachedToken: string | null = null;
let tokenExpiresAt = 0; // ms since epoch

supabase.auth.onAuthStateChange((_event, session) => {
  cachedToken = session?.access_token ?? null;
  tokenExpiresAt = (session?.expires_at ?? 0) * 1000;
});

let refreshPromise: Promise<string | null> | null = null;

/**
 * Return a token that's good for at least ~30s, refreshing through Supabase
 * when needed. `getSession()` alone only reads storage — it does NOT
 * guarantee a refresh — so when the stored session is itself expired (long
 * background tab, resumed laptop, long-lived Electron shell) we explicitly
 * call `refreshSession()`. Callers can pass `forceRefresh` after a 401 to
 * skip straight to the refresh.
 */
async function getToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedToken;
  }

  // Deduplicate concurrent refreshes so vault's parallel fetches don't each
  // trigger their own auth round-trip at the same time.
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      let session = data?.session ?? null;
      const sessionExpiresMs = (session?.expires_at ?? 0) * 1000;
      const stillStale = !session || sessionExpiresMs <= Date.now() + 30_000;

      if (forceRefresh || stillStale) {
        const { data: refreshed, error } = await supabase.auth.refreshSession();
        if (!error && refreshed?.session) {
          session = refreshed.session;
        }
      }

      cachedToken = session?.access_token ?? null;
      tokenExpiresAt = (session?.expires_at ?? 0) * 1000;
      return cachedToken;
    } catch {
      // Network hiccup mid-refresh: only reuse the cached token if it hasn't
      // actually expired — returning a known-dead token just converts one
      // failure into a guaranteed 401.
      return cachedToken && Date.now() < tokenExpiresAt ? cachedToken : null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// Desktop shell hook: the Electron main process proxies overlay (LYKN Glass)
// requests and needs a guaranteed-fresh token. Reading localStorage from the
// main process only sees whatever access token was last written — which is
// expired after the window sits occluded/throttled for an hour. This lets the
// shell drive a real refresh through THIS Supabase client (the one that owns
// the rotating refresh token) instead of guessing from storage.
// Browser tabs must not expose this — any XSS would mint fresh JWTs via it.
if (isDesktopShell()) {
  (window as unknown as Record<string, unknown>).__lyknGetFreshToken = (force = true) =>
    getToken(Boolean(force));
}

/** True when the request can be safely re-sent (body isn't a one-shot stream). */
function isRetriable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.body && typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream) {
    return false;
  }
  // A Request object's body stream is consumed on first send.
  if (typeof Request !== 'undefined' && input instanceof Request && input.bodyUsed) return false;
  return true;
}

function withAuthHeader(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * Intercept fetch calls to our own API backend and attach
 * the Supabase JWT as a Bearer token automatically.
 */
window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  const isOurApi = url.startsWith(API_BASE_URL) || url.startsWith('/api/');
  if (!isOurApi) return _originalFetch(input, init);

  let response: Response;
  let sentToken: string | null = null;
  try {
    sentToken = await getToken();
    if (sentToken) {
      const headers = new Headers(init?.headers || {});
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${sentToken}`);
      } else {
        // Caller supplied its own Authorization header — don't second-guess it.
        sentToken = null;
      }
      response = await _originalFetch(input, { ...init, headers });
    } else {
      response = await _originalFetch(input, init);
    }
  } catch (err) {
    return _originalFetch(input, init);
  }

  // One retry on 401: the access token can be revoked or expired server-side
  // even when our local clock said it was fine (clock skew, "sign out
  // everywhere", suspended laptop). Force a refresh and re-send once.
  if (response.status === 401 && sentToken && isRetriable(input, init)) {
    const freshToken = await getToken(true);
    if (freshToken && freshToken !== sentToken) {
      try {
        response = await _originalFetch(input, withAuthHeader(init, freshToken));
      } catch {
        /* keep the original 401 response */
      }
    }
  }

  if (response.status === 429 && url.includes('/api/ai/')) {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body?.error === 'ai_limit_reached') {
        window.dispatchEvent(new CustomEvent('lykn:ai-limit-reached', { detail: body }));
      }
    } catch { /* ignore parse errors */ }
  }

  return response;
};
