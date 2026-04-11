import { supabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api-config';

const _originalFetch = window.fetch.bind(window);

let cachedToken: string | null = null;
let tokenExpiresAt = 0; // ms since epoch

supabase.auth.onAuthStateChange((_event, session) => {
  cachedToken = session?.access_token ?? null;
  tokenExpiresAt = (session?.expires_at ?? 0) * 1000;
});

let refreshPromise: Promise<string | null> | null = null;

async function getToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  // Deduplicate concurrent getSession calls so vault's parallel fetches
  // don't each trigger their own auth refresh at the same time.
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      cachedToken = data?.session?.access_token ?? null;
      tokenExpiresAt = (data?.session?.expires_at ?? 0) * 1000;
      return cachedToken;
    } catch {
      return cachedToken;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
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
  try {
    const token = await getToken();
    if (token) {
      const headers = new Headers(init?.headers || {});
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      response = await _originalFetch(input, { ...init, headers });
    } else {
      response = await _originalFetch(input, init);
    }
  } catch (err) {
    return _originalFetch(input, init);
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
