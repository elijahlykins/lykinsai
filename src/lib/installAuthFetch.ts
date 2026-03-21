import { supabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api-config';

const _originalFetch = window.fetch.bind(window);

let cachedToken: string | null = null;
let tokenExpiresAt = 0; // ms since epoch

supabase.auth.onAuthStateChange((_event, session) => {
  cachedToken = session?.access_token ?? null;
  tokenExpiresAt = (session?.expires_at ?? 0) * 1000;
});

async function getToken(): Promise<string | null> {
  // 30s buffer before actual expiry avoids using a token that's about to die
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const { data } = await supabase.auth.getSession();
  cachedToken = data?.session?.access_token ?? null;
  tokenExpiresAt = (data?.session?.expires_at ?? 0) * 1000;
  return cachedToken;
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
