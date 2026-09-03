import { API_BASE_URL } from '@/lib/api-config';
import { supabase } from '@/lib/supabase';
import { readLocalModelSetup, writeLocalModelSetup } from '@/lib/models/modelSetupStore';

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || res.statusText), { status: res.status });
    throw err;
  }
  return data;
}

async function upsertViaSupabase(userId, settings) {
  const { error } = await supabase.from('lykn_user_model_settings').upsert({
    user_id: userId,
    mode: settings.mode,
    categories: settings.categories || {},
    fallback_model_ids: settings.fallbackModelIds || [],
    favorite_model_ids: settings.favoriteModelIds || [],
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function fetchModelCatalog(query = '') {
  const res = await fetch(`${API_BASE_URL}/api/models${query}`, {
    headers: await authHeaders(),
  });
  return readJson(res);
}

export async function fetchModelSettings() {
  const local = readLocalModelSetup();
  try {
    const res = await fetch(`${API_BASE_URL}/api/model-settings`, {
      headers: await authHeaders(),
    });
    const data = await readJson(res);
    if (data.settings) {
      writeLocalModelSetup(data.settings);
      return data;
    }
  } catch {
    /* use local */
  }
  return { settings: local };
}

export async function saveModelSettings(patch) {
  const current = readLocalModelSetup();
  const next = writeLocalModelSetup({
    mode: patch.mode ?? current.mode,
    categories: patch.categories ?? current.categories,
  });

  try {
    const res = await fetch(`${API_BASE_URL}/api/model-settings`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify(next),
    });
    const data = await readJson(res);
    if (data.settings) writeLocalModelSetup(data.settings);
    return { settings: data.settings || next };
  } catch {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (userId) {
      try {
        await upsertViaSupabase(userId, next);
      } catch {
        /* local copy is enough for this session */
      }
    }
    return { settings: next };
  }
}

export async function fetchModelRoutes() {
  const res = await fetch(`${API_BASE_URL}/api/model-routes`, {
    headers: await authHeaders(),
  });
  return readJson(res);
}

export async function createModelRoute(body) {
  const res = await fetch(`${API_BASE_URL}/api/model-routes`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  return readJson(res);
}

export async function fetchUsageSummary() {
  const res = await fetch(`${API_BASE_URL}/api/usage/summary`, {
    headers: await authHeaders(),
  });
  return readJson(res);
}

/**
 * Included-vs-metered chat billing per model id, from the server's canonical
 * registry. Shape: { baseline_model, states: { [modelId]: 'included'|'metered' } }.
 */
export async function fetchModelBillingStates() {
  const res = await fetch(`${API_BASE_URL}/api/models/billing-states`, {
    headers: await authHeaders(),
  });
  return readJson(res);
}

/**
 * Last-30-days daily spend for the billing chart. Category totals only
 * (chat / images / agents / other) in customer dollars.
 */
export async function fetchUsageDaily(days = 30) {
  const res = await fetch(`${API_BASE_URL}/api/usage/daily?days=${days}`, {
    headers: await authHeaders(),
  });
  return readJson(res);
}

export async function fetchUsageEvents(limit = 30) {
  const res = await fetch(`${API_BASE_URL}/api/usage/events?limit=${limit}`, {
    headers: await authHeaders(),
  });
  return readJson(res);
}
