import crypto from 'node:crypto';

import {
  CREDENTIAL_TYPES,
  createSupabaseCredentialStore,
  decryptToken,
} from '../security/credentialStore.js';
import {
  CalendarAuthError,
  exchangeGoogleCalendarCode,
  googleCalendarAuthUrl,
  refreshGoogleCalendarToken,
  syncGoogleCalendar,
} from './googleCalendar.js';
import {
  syncAppleCalendar,
  validateAppleCalendarCredential,
} from './appleCalendar.js';

const GOOGLE = 'google';
const APPLE = 'apple';
const AUTH_PURPOSE = 'calendar_google_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;

function credentialType(provider) {
  if (provider === GOOGLE) return CREDENTIAL_TYPES.CALENDAR_GOOGLE_OAUTH;
  if (provider === APPLE) return CREDENTIAL_TYPES.CALENDAR_APPLE_CALDAV;
  throw new TypeError(`Unsupported calendar provider: ${provider}`);
}

function parseGoogleSecret(secret) {
  try {
    const parsed = JSON.parse(String(secret || ''));
    return {
      accessToken: String(parsed.accessToken || ''),
      refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : null,
    };
  } catch {
    return { accessToken: String(secret || ''), refreshToken: null };
  }
}

function publicConnection(row, provider) {
  const metadata = row.metadata || {};
  return {
    id: row.id,
    provider: provider === GOOGLE ? 'google-calendar' : 'apple-calendar',
    status: row.status,
    account_email: metadata.account_email || null,
    account_handle: metadata.account_email?.split('@')[0] || row.label,
    account_display_name: row.label,
    last_synced_at: metadata.last_synced_at || null,
    last_sync_count: metadata.last_sync_count || 0,
    metadata: {
      calendar_count: metadata.calendar_count || null,
      calendar_names: metadata.calendar_names || [],
    },
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function migrateLegacyCalendarCredentials(client, userId) {
  const store = createSupabaseCredentialStore(client);
  let rows = [];
  try {
    const result = await client
      .from('social_connections')
      .select('id, provider, access_token, refresh_token, token_expires_at, account_email, account_display_name, metadata, status, last_synced_at, last_sync_count')
      .eq('user_id', userId)
      .in('provider', ['google-calendar', 'apple-calendar']);
    if (!result.error) rows = result.data || [];
  } catch {
    return;
  }
  for (const legacy of rows) {
    const provider = legacy.provider === 'google-calendar' ? GOOGLE : APPLE;
    const type = credentialType(provider);
    const existing = await store.findActive(userId, type).catch(() => null);
    if (existing) continue;
    try {
      const accessToken = decryptToken(legacy.access_token);
      const refreshToken = legacy.refresh_token ? decryptToken(legacy.refresh_token) : null;
      const secret = provider === GOOGLE
        ? JSON.stringify({ accessToken, refreshToken })
        : accessToken;
      await store.put(userId, {
        type,
        secret,
        label: legacy.account_display_name || legacy.account_email || `${provider} calendar`,
        status: legacy.status === 'paused' ? 'paused' : 'active',
        expiresAt: legacy.token_expires_at || null,
        metadata: {
          ...(legacy.metadata || {}),
          account_email: legacy.account_email || legacy.metadata?.email || null,
          last_synced_at: legacy.last_synced_at || null,
          last_sync_count: legacy.last_sync_count || 0,
          migrated_from_social_connection_id: legacy.id,
        },
      });
    } catch (error) {
      console.warn(`[calendar] ${provider} legacy credential migration failed:`, error?.message || error);
    }
  }
}

export async function listCalendarConnections(client, userId) {
  await migrateLegacyCalendarCredentials(client, userId);
  const store = createSupabaseCredentialStore(client);
  const [google, apple] = await Promise.all([
    store.list(userId, { type: CREDENTIAL_TYPES.CALENDAR_GOOGLE_OAUTH }),
    store.list(userId, { type: CREDENTIAL_TYPES.CALENDAR_APPLE_CALDAV }),
  ]);
  return [
    ...google.map((row) => publicConnection(row, GOOGLE)),
    ...apple.map((row) => publicConnection(row, APPLE)),
  ];
}

export async function startGoogleCalendarAuthorization(
  client,
  userId,
  { redirectUri, redirectAfter = null },
) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google Calendar is not configured.');
  const state = crypto.randomBytes(24).toString('base64url');
  const { error } = await client.from('lykn_external_auth_states').insert({
    state,
    user_id: userId,
    purpose: AUTH_PURPOSE,
    redirect_after: redirectAfter,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw error;
  return {
    url: googleCalendarAuthUrl({ clientId, redirectUri, state }),
    state,
  };
}

export async function finishGoogleCalendarAuthorization(
  client,
  { state, code, redirectUri },
) {
  const { data: authState, error } = await client
    .from('lykn_external_auth_states')
    .delete()
    .eq('state', state)
    .eq('purpose', AUTH_PURPOSE)
    .select('*')
    .maybeSingle();
  if (error || !authState) throw new CalendarAuthError('Invalid or already-used calendar authorization.');
  if (new Date(authState.expires_at).getTime() <= Date.now()) {
    throw new CalendarAuthError('Calendar authorization expired. Start again.');
  }
  const exchanged = await exchangeGoogleCalendarCode({
    code,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  });
  const store = createSupabaseCredentialStore(client);
  const existing = await store.findActive(
    authState.user_id,
    CREDENTIAL_TYPES.CALENDAR_GOOGLE_OAUTH,
  );
  const input = {
    secret: JSON.stringify({
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
    }),
    label: exchanged.label,
    metadata: exchanged.metadata,
    status: 'active',
    expiresAt: exchanged.expiresAt,
  };
  const saved = existing
    ? await store.update(authState.user_id, existing.id, input)
    : await store.put(authState.user_id, {
        type: CREDENTIAL_TYPES.CALENDAR_GOOGLE_OAUTH,
        ...input,
      });
  return { userId: authState.user_id, connection: publicConnection(saved, GOOGLE) };
}

export async function connectAppleCalendar(client, userId, fields) {
  const validated = await validateAppleCalendarCredential(fields);
  const store = createSupabaseCredentialStore(client);
  const existing = await store.findActive(
    userId,
    CREDENTIAL_TYPES.CALENDAR_APPLE_CALDAV,
  );
  const input = {
    ...validated,
    status: 'active',
  };
  const saved = existing
    ? await store.update(userId, existing.id, input)
    : await store.put(userId, {
        type: CREDENTIAL_TYPES.CALENDAR_APPLE_CALDAV,
        ...input,
      });
  return publicConnection(saved, APPLE);
}

export async function syncCalendarConnection(client, userId, credentialId) {
  const store = createSupabaseCredentialStore(client);
  const credential = await store.get(userId, credentialId, { includeSecret: true });
  if (!credential) throw new Error('Calendar connection not found.');
  if (credential.status === 'paused') throw new Error('Calendar connection is paused.');

  let result;
  let nextSecret = credential.secret;
  let expiresAt = credential.expiresAt;
  try {
    if (credential.type === CREDENTIAL_TYPES.CALENDAR_GOOGLE_OAUTH) {
      let tokens = parseGoogleSecret(credential.secret);
      if (expiresAt && new Date(expiresAt).getTime() < Date.now() + 60_000) {
        if (!tokens.refreshToken) throw new CalendarAuthError('Google Calendar needs to be reconnected.');
        const refreshed = await refreshGoogleCalendarToken({
          refreshToken: tokens.refreshToken,
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        });
        tokens = { ...tokens, accessToken: refreshed.accessToken };
        nextSecret = JSON.stringify(tokens);
        expiresAt = refreshed.expiresAt;
      }
      result = await syncGoogleCalendar({
        supabaseAdmin: client,
        userId,
        accessToken: tokens.accessToken,
        metadata: credential.metadata,
      });
    } else if (credential.type === CREDENTIAL_TYPES.CALENDAR_APPLE_CALDAV) {
      result = await syncAppleCalendar({
        supabaseAdmin: client,
        userId,
        password: credential.secret,
        metadata: credential.metadata,
      });
    } else {
      throw new Error('Unsupported calendar credential.');
    }
  } catch (error) {
    if (error?.isAuthError) {
      await store.update(userId, credential.id, { status: 'reauth' });
    }
    throw error;
  }

  const metadata = {
    ...(result.metadata || credential.metadata || {}),
    last_synced_at: new Date().toISOString(),
    last_sync_count: result.saved || 0,
  };
  await store.update(userId, credential.id, {
    secret: nextSecret,
    expiresAt,
    metadata,
    status: 'active',
    lastUsedAt: new Date().toISOString(),
  });
  return { saved: result.saved || 0, skipped: result.skipped || 0, status: 'ok' };
}

export async function updateCalendarConnection(client, userId, credentialId, status) {
  return createSupabaseCredentialStore(client).update(userId, credentialId, { status });
}

export async function disconnectCalendarConnection(client, userId, credentialId) {
  return createSupabaseCredentialStore(client).remove(userId, credentialId);
}

export async function pollDueCalendarConnections(client, { limit = 10 } = {}) {
  const { data, error } = await client
    .from('lykn_credentials')
    .select('id, user_id, credential_type, metadata')
    .in('credential_type', [
      CREDENTIAL_TYPES.CALENDAR_GOOGLE_OAUTH,
      CREDENTIAL_TYPES.CALENDAR_APPLE_CALDAV,
    ])
    .eq('status', 'active')
    .order('updated_at', { ascending: true })
    .limit(limit * 2);
  if (error || !data) return { polled: 0, saved: 0 };
  const due = data.filter((row) => {
    const last = row.metadata?.last_synced_at;
    return !last || new Date(last).getTime() + 15 * 60_000 <= Date.now();
  }).slice(0, limit);
  let saved = 0;
  for (const row of due) {
    try {
      const result = await syncCalendarConnection(client, row.user_id, row.id);
      saved += result.saved || 0;
    } catch (error) {
      console.warn('[calendar] background sync failed:', error?.message || error);
    }
  }
  return { polled: due.length, saved };
}
