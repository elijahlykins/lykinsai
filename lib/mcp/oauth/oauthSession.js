/**
 * One-shot MCP OAuth sessions.
 *
 * state + PKCE verifier live here, never on Task / Bot / Routine / events.
 * Replay and expiry are rejected. Ownership is bound to userId + connectionId.
 */

import { randomBytes } from 'node:crypto';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function newOAuthState() {
  return randomBytes(24).toString('base64url');
}

export function createMemoryOAuthSessionStore() {
  const rows = new Map();

  function prune(now = Date.now()) {
    for (const [state, row] of rows) {
      if (row.used || now > row.expiresAt) rows.delete(state);
    }
  }

  return {
    async save(session) {
      prune();
      const state = String(session.state || newOAuthState());
      const row = {
        state,
        userId: String(session.userId),
        connectionId: String(session.connectionId),
        redirectUri: String(session.redirectUri),
        codeVerifier: session.codeVerifier || null,
        authorizationServerUrl: session.authorizationServerUrl || null,
        resource: session.resource || null,
        createdAt: Date.now(),
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
        used: false,
      };
      rows.set(state, row);
      return { ...row };
    },
    async update(state, patch) {
      const row = rows.get(String(state || ''));
      if (!row || row.used) return null;
      const next = { ...row, ...patch, state: row.state };
      rows.set(row.state, next);
      return { ...next };
    },
    async peek(state) {
      prune();
      const row = rows.get(String(state || ''));
      return row ? { ...row } : null;
    },
    async consume({ state, userId, connectionId } = {}) {
      const key = String(state || '');
      const row = rows.get(key);
      if (!row) {
        prune();
        const err = new Error('invalid_or_expired_state');
        err.code = 'invalid_or_expired_state';
        throw err;
      }
      if (row.used) {
        const err = new Error('state_replay');
        err.code = 'state_replay';
        throw err;
      }
      if (Date.now() > row.expiresAt) {
        rows.delete(key);
        const err = new Error('state_expired');
        err.code = 'state_expired';
        throw err;
      }
      if (userId && String(row.userId) !== String(userId)) {
        const err = new Error('state_user_mismatch');
        err.code = 'state_user_mismatch';
        throw err;
      }
      if (connectionId && String(row.connectionId) !== String(connectionId)) {
        const err = new Error('state_connection_mismatch');
        err.code = 'state_connection_mismatch';
        throw err;
      }
      row.used = true;
      rows.delete(key);
      return { ...row, used: true };
    },
  };
}

export function createSupabaseOAuthSessionStore(supabaseAdmin) {
  if (!supabaseAdmin) throw new TypeError('supabaseAdmin is required');

  function fromRow(row) {
    if (!row) return null;
    return {
      state: row.state,
      userId: row.user_id,
      connectionId: row.connection_id,
      redirectUri: row.redirect_uri,
      codeVerifier: row.code_verifier,
      authorizationServerUrl: row.authorization_server_url,
      resource: row.resource,
      createdAt: new Date(row.created_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
      used: !!row.used,
    };
  }

  return {
    async save(session) {
      const state = String(session.state || newOAuthState());
      const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_oauth_sessions')
        .insert({
          state,
          user_id: session.userId,
          connection_id: session.connectionId,
          redirect_uri: session.redirectUri,
          code_verifier: session.codeVerifier || null,
          authorization_server_url: session.authorizationServerUrl || null,
          resource: session.resource || null,
          expires_at: expiresAt,
          used: false,
        })
        .select('*')
        .single();
      if (error) throw error;
      return fromRow(data);
    },
    async update(state, patch) {
      const mapped = {};
      if (patch.codeVerifier !== undefined) mapped.code_verifier = patch.codeVerifier;
      if (patch.authorizationServerUrl !== undefined) mapped.authorization_server_url = patch.authorizationServerUrl;
      if (patch.resource !== undefined) mapped.resource = patch.resource;
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_oauth_sessions')
        .update(mapped)
        .eq('state', String(state || ''))
        .eq('used', false)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return fromRow(data);
    },
    async peek(state) {
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_oauth_sessions')
        .select('*')
        .eq('state', String(state || ''))
        .maybeSingle();
      if (error) throw error;
      return fromRow(data);
    },
    async consume({ state, userId, connectionId } = {}) {
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_oauth_sessions')
        .select('*')
        .eq('state', String(state || ''))
        .maybeSingle();
      if (error) throw error;
      const row = fromRow(data);
      if (!row) {
        const err = new Error('invalid_or_expired_state');
        err.code = 'invalid_or_expired_state';
        throw err;
      }
      if (row.used) {
        const err = new Error('state_replay');
        err.code = 'state_replay';
        throw err;
      }
      if (Date.now() > row.expiresAt) {
        await supabaseAdmin.from('lykn_mcp_oauth_sessions').delete().eq('state', row.state);
        const err = new Error('state_expired');
        err.code = 'state_expired';
        throw err;
      }
      if (userId && String(row.userId) !== String(userId)) {
        const err = new Error('state_user_mismatch');
        err.code = 'state_user_mismatch';
        throw err;
      }
      if (connectionId && String(row.connectionId) !== String(connectionId)) {
        const err = new Error('state_connection_mismatch');
        err.code = 'state_connection_mismatch';
        throw err;
      }
      const { error: delErr } = await supabaseAdmin.from('lykn_mcp_oauth_sessions').delete().eq('state', row.state);
      if (delErr) throw delErr;
      return { ...row, used: true };
    },
  };
}
