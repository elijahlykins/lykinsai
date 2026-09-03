/**
 * User model settings and named routes.
 *
 * Persistence is user-owned (RLS + userOwnedAccess). Tests inject a store.
 */

import { userOwnedTable, getUserRowById, requireUserId } from '../security/userOwnedAccess.js';
import {
  emptyUserSetup,
  normalizeSelectionMode,
  sanitizeBotModelPolicy,
  sanitizeCategoryMap,
  sanitizeFallbackIds,
  sanitizeRouteRecord,
  SELECTION_MODES,
} from './routingPolicy.js';

let supabaseAdmin = null;
const memoryRoutes = new Map();
const memorySettings = new Map();

export function bindModelSettingsClient(client) {
  supabaseAdmin = client || null;
}

export function defaultUserModelSettings() {
  return {
    mode: SELECTION_MODES.LYKN,
    categories: {},
    fallbackModelIds: [],
    favoriteModelIds: [],
  };
}

export async function getUserModelSettings(userId) {
  const uid = requireUserId(userId);
  if (supabaseAdmin) {
    try {
      const { data, error } = await userOwnedTable(supabaseAdmin, 'lykn_user_model_settings', uid)
        .select('*')
        .maybeSingle();
      if (!error && data) return rowToSettings(data);
    } catch {
      /* table may not exist until migration 133 */
    }
  }
  return memorySettings.get(uid) || defaultUserModelSettings();
}

export async function putUserModelSettings(userId, patch = {}) {
  const uid = requireUserId(userId);
  const current = await getUserModelSettings(uid);
  const next = {
    mode: normalizeSelectionMode(patch.mode ?? current.mode),
    categories: sanitizeCategoryMap(patch.categories ?? current.categories),
    fallbackModelIds: sanitizeFallbackIds(patch.fallbackModelIds ?? current.fallbackModelIds),
    favoriteModelIds: sanitizeFallbackIds(patch.favoriteModelIds ?? current.favoriteModelIds),
  };
  memorySettings.set(uid, next);
  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.from('lykn_user_model_settings').upsert({
        user_id: uid,
        mode: next.mode,
        categories: next.categories,
        fallback_model_ids: next.fallbackModelIds,
        favorite_model_ids: next.favoriteModelIds,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (error) {
        console.warn('[model-settings] persist failed', error.message || error);
      }
    } catch (err) {
      console.warn('[model-settings] persist error', err?.message || err);
    }
  }
  return next;
}

function rowToSettings(row) {
  return {
    mode: normalizeSelectionMode(row.mode),
    categories: sanitizeCategoryMap(row.categories),
    fallbackModelIds: sanitizeFallbackIds(row.fallback_model_ids),
    favoriteModelIds: sanitizeFallbackIds(row.favorite_model_ids),
  };
}

export async function listUserRoutes(userId) {
  const uid = requireUserId(userId);
  if (supabaseAdmin) {
    const { data } = await userOwnedTable(supabaseAdmin, 'lykn_model_routes', uid)
      .select('*')
      .order('created_at', { ascending: false });
    return Array.isArray(data) ? data.map(rowToRoute) : [];
  }
  return memoryRoutes.get(uid) || [];
}

export async function createUserRoute(userId, input) {
  const uid = requireUserId(userId);
  const parsed = sanitizeRouteRecord(input);
  if (!parsed.ok) return parsed;
  const now = new Date().toISOString();
  const id = input.id || `route_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    user_id: uid,
    ...parsed.route,
    createdAt: now,
    updatedAt: now,
  };
  if (supabaseAdmin) {
    const { data, error } = await userOwnedTable(supabaseAdmin, 'lykn_model_routes', uid).insert({
      id,
      name: parsed.route.name,
      purpose: parsed.route.purpose,
      primary_model_id: parsed.route.primaryModelId,
      fallback_model_ids: parsed.route.fallbackModelIds,
      configuration: parsed.route.configuration,
      enabled: parsed.route.enabled,
    });
    if (error) return { ok: false, error: error.message || 'insert_failed' };
    const created = Array.isArray(data) ? data[0] : data;
    return { ok: true, route: created ? rowToRoute(created) : row };
  }
  const list = memoryRoutes.get(uid) || [];
  list.unshift(row);
  memoryRoutes.set(uid, list);
  return { ok: true, route: row };
}

export async function updateUserRoute(userId, routeId, input) {
  const uid = requireUserId(userId);
  const existing = await getUserRoute(uid, routeId);
  if (!existing) return { ok: false, error: 'not_found' };
  const parsed = sanitizeRouteRecord({ ...existing, ...input });
  if (!parsed.ok) return parsed;
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from('lykn_model_routes')
      .update({
        name: parsed.route.name,
        purpose: parsed.route.purpose,
        primary_model_id: parsed.route.primaryModelId,
        fallback_model_ids: parsed.route.fallbackModelIds,
        configuration: parsed.route.configuration,
        enabled: parsed.route.enabled,
        updated_at: new Date().toISOString(),
      })
      .eq('id', routeId)
      .eq('user_id', uid)
      .select('*');
    if (error) return { ok: false, error: error.message || 'update_failed' };
    return { ok: true, route: rowToRoute((data || [])[0] || { ...existing, ...parsed.route, id: routeId }) };
  }
  const list = (memoryRoutes.get(uid) || []).map((row) => (
    row.id === routeId ? { ...row, ...parsed.route, updatedAt: new Date().toISOString() } : row
  ));
  memoryRoutes.set(uid, list);
  return { ok: true, route: list.find((row) => row.id === routeId) };
}

export async function deleteUserRoute(userId, routeId) {
  const uid = requireUserId(userId);
  if (supabaseAdmin) {
    await supabaseAdmin.from('lykn_model_routes').delete().eq('id', routeId).eq('user_id', uid);
    return { ok: true };
  }
  memoryRoutes.set(uid, (memoryRoutes.get(uid) || []).filter((row) => row.id !== routeId));
  return { ok: true };
}

export async function getUserRoute(userId, routeId) {
  const uid = requireUserId(userId);
  const id = String(routeId || '').trim();
  if (!id) return null;
  if (supabaseAdmin) {
    const { data } = await getUserRowById(supabaseAdmin, 'lykn_model_routes', uid, id);
    return data ? rowToRoute(data) : null;
  }
  return (memoryRoutes.get(uid) || []).find((row) => row.id === id) || null;
}

function rowToRoute(row) {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    primaryModelId: row.primary_model_id || row.primaryModelId,
    fallbackModelIds: sanitizeFallbackIds(row.fallback_model_ids || row.fallbackModelIds),
    configuration: row.configuration || {},
    enabled: row.enabled !== false,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  };
}

function mergeClientSettings(stored, raw) {
  if (!raw || typeof raw !== 'object') return stored;
  const categories = sanitizeCategoryMap({ ...raw.categories, ...stored.categories });
  const mode = normalizeSelectionMode(stored.mode !== 'lykn' ? stored.mode : raw.mode);
  return {
    ...stored,
    mode,
    categories: Object.keys(stored.categories || {}).length ? stored.categories : categories,
  };
}

export async function loadTurnModelContext({ userId, body } = {}) {
  const stored = userId ? await getUserModelSettings(userId).catch(() => defaultUserModelSettings()) : defaultUserModelSettings();
  const settings = mergeClientSettings(stored, body?.userSettings);
  const policy = sanitizeBotModelPolicy(body?.modelPolicy);
  let resolvedRoute = null;
  if (policy.mode === SELECTION_MODES.ROUTE && policy.routeId && userId) {
    resolvedRoute = await getUserRoute(userId, policy.routeId).catch(() => null);
  }
  return { settings, policy, resolvedRoute };
}

export { sanitizeBotModelPolicy, emptyUserSetup };
