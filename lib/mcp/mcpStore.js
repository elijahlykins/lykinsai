/**
 * Persistence for McpConnection rows.
 * Public rows never include secret_encrypted, oauth_encrypted, or raw tokens.
 */

import { randomUUID } from 'node:crypto';
import { MCP_AUTH_MODES, MCP_STATUSES, MCP_TRANSPORTS, MCP_TRUST_LEVELS } from './protocol.js';
import { createCredentialRef, publicCredentialRef, CREDENTIAL_REF_TYPES } from './credentialRef.js';
import { MCP_BOUNDS, boundText } from './bounds.js';
import { publicIdentity } from './serverIdentity.js';
import { publicEnvCredentialRefs } from './stdio/envRefs.js';
import { freshenClassifiedTools } from './toolClassifier.js';

const PUBLIC_FIELDS = [
  'id',
  'userId',
  'name',
  'serverUrl',
  'transport',
  'authMode',
  'credentialRef',
  'trustLevel',
  'serverInfo',
  'capabilitySummary',
  'status',
  'lastError',
  'createdAt',
  'updatedAt',
  'lastConnectedAt',
  'accountLabel',
  'accountIdentity',
  'origin',
  'identity',
  'command',
  'args',
  'workingDirectory',
  'envCredentialRefs',
  'catalogId',
  'catalogSource',
  'providedThrough',
];

export function toPublicConnection(row) {
  if (!row) return null;
  const out = {};
  for (const key of PUBLIC_FIELDS) out[key] = row[key];
  out.credentialRef = publicCredentialRef(row.credentialRef);
  out.identity = publicIdentity(row.identity);
  out.envCredentialRefs = publicEnvCredentialRefs(row.envCredentialRefs);
  out.toolCount = Number(row.capabilitySummary?.toolCount || 0);
  if (out.transport === MCP_TRANSPORTS.STDIO) {
    out.serverUrl = '';
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanName(name, fallback = 'MCP server') {
  return boundText(name || fallback, MCP_BOUNDS.CONNECTION_NAME_CHARS).text.trim() || fallback;
}

function credentialRefFor(row) {
  if (row.authMode === MCP_AUTH_MODES.OAUTH) {
    return createCredentialRef({ type: CREDENTIAL_REF_TYPES.MCP_OAUTH, connectionId: row.id });
  }
  if (row.authMode === MCP_AUTH_MODES.BEARER) {
    return createCredentialRef({ type: CREDENTIAL_REF_TYPES.MCP_SECRET, connectionId: row.id });
  }
  return createCredentialRef({ type: CREDENTIAL_REF_TYPES.NONE });
}

function baseRow(userId, input, id) {
  const at = nowIso();
  const transport = input.transport || MCP_TRANSPORTS.STREAMABLE_HTTP;
  return {
    id,
    userId,
    name: cleanName(input.name),
    serverUrl: transport === MCP_TRANSPORTS.STDIO ? String(input.serverUrl || '') : String(input.serverUrl || ''),
    transport,
    authMode: input.authMode || MCP_AUTH_MODES.NONE,
    credentialRef: credentialRefFor({ id, authMode: input.authMode || MCP_AUTH_MODES.NONE }),
    secretEncrypted: input.secretEncrypted || null,
    oauthEncrypted: input.oauthEncrypted || null,
    trustLevel: input.trustLevel || MCP_TRUST_LEVELS.CUSTOM,
    serverInfo: input.serverInfo || {},
    capabilitySummary: input.capabilitySummary || {},
    classifiedTools: input.classifiedTools || [],
    schemaHash: input.schemaHash || null,
    status: input.status || MCP_STATUSES.DISCONNECTED,
    lastError: input.lastError || null,
    createdAt: at,
    updatedAt: at,
    lastConnectedAt: input.lastConnectedAt || null,
    accountLabel: input.accountLabel || null,
    accountIdentity: input.accountIdentity || null,
    origin: input.origin || null,
    identity: input.identity || {},
    sessionEpoch: input.sessionEpoch || 0,
    command: input.command || null,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    workingDirectory: input.workingDirectory || null,
    envCredentialRefs: publicEnvCredentialRefs(input.envCredentialRefs),
    catalogId: input.catalogId || null,
    catalogSource: input.catalogSource && typeof input.catalogSource === 'object' ? input.catalogSource : {},
    providedThrough: input.providedThrough || null,
  };
}

export function createMemoryMcpStore() {
  const rows = new Map();

  return {
    async list(userId) {
      return [...rows.values()]
        .filter((row) => row.userId === userId)
        .map((row) => ({ ...row, classifiedTools: freshenClassifiedTools(row.classifiedTools, row.serverInfo) }));
    },
    async get(userId, id) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return null;
      return { ...row, classifiedTools: freshenClassifiedTools(row.classifiedTools, row.serverInfo) };
    },
    async insert(userId, input) {
      const id = String(input.id || randomUUID());
      const row = baseRow(userId, input, id);
      rows.set(id, row);
      return { ...row };
    },
    async update(userId, id, patch) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return null;
      const next = { ...row, ...patch, id, userId, updatedAt: nowIso() };
      if (patch.secretEncrypted === undefined) next.secretEncrypted = row.secretEncrypted;
      if (patch.oauthEncrypted === undefined) next.oauthEncrypted = row.oauthEncrypted;
      if (patch.authMode) next.credentialRef = credentialRefFor(next);
      rows.set(id, next);
      return { ...next };
    },
    async remove(userId, id) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return false;
      rows.delete(id);
      return true;
    },
  };
}

export function createSupabaseMcpStore(supabaseAdmin, { encrypt, decrypt } = {}) {
  if (!supabaseAdmin) throw new TypeError('supabaseAdmin is required');

  function fromRow(row) {
    if (!row) return null;
    const mapped = {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      serverUrl: row.server_url,
      transport: row.transport,
      authMode: row.auth_mode,
      secretEncrypted: row.secret_encrypted,
      oauthEncrypted: row.oauth_encrypted,
      trustLevel: row.trust_level,
      serverInfo: row.server_info || {},
      capabilitySummary: row.capability_summary || {},
      classifiedTools: freshenClassifiedTools(row.classified_tools, row.server_info),
      schemaHash: row.schema_hash,
      status: row.status,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastConnectedAt: row.last_connected_at,
      accountLabel: row.account_label,
      accountIdentity: row.account_identity,
      origin: row.origin,
      identity: row.identity || {},
      sessionEpoch: row.session_epoch || 0,
      command: row.command || null,
      args: Array.isArray(row.args) ? row.args : [],
      workingDirectory: row.working_directory || null,
      envCredentialRefs: publicEnvCredentialRefs(row.env_credential_refs),
      catalogId: row.catalog_id || null,
      catalogSource: row.catalog_source || {},
      providedThrough: row.provided_through || null,
    };
    mapped.credentialRef = credentialRefFor(mapped);
    return mapped;
  }

  function toRow(input) {
    return {
      name: input.name,
      server_url: input.serverUrl,
      transport: input.transport,
      auth_mode: input.authMode,
      secret_encrypted: input.secretEncrypted ?? null,
      oauth_encrypted: input.oauthEncrypted ?? null,
      trust_level: input.trustLevel,
      server_info: input.serverInfo || {},
      capability_summary: input.capabilitySummary || {},
      classified_tools: input.classifiedTools || [],
      schema_hash: input.schemaHash || null,
      status: input.status,
      last_error: input.lastError || null,
      last_connected_at: input.lastConnectedAt || null,
      account_label: input.accountLabel || null,
      account_identity: input.accountIdentity || null,
      origin: input.origin || null,
      identity: input.identity || {},
      session_epoch: input.sessionEpoch || 0,
      command: input.command || null,
      args: Array.isArray(input.args) ? input.args : [],
      working_directory: input.workingDirectory || null,
      env_credential_refs: publicEnvCredentialRefs(input.envCredentialRefs),
      catalog_id: input.catalogId || null,
      catalog_source: input.catalogSource || {},
      provided_through: input.providedThrough || null,
    };
  }

  return {
    encrypt,
    decrypt,
    async list(userId) {
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_connections')
        .select(
          'id, user_id, name, server_url, transport, auth_mode, trust_level, server_info, capability_summary, classified_tools, schema_hash, status, last_error, created_at, updated_at, last_connected_at, account_label, account_identity, origin, identity, session_epoch, command, args, working_directory, env_credential_refs, catalog_id, catalog_source, provided_through',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(fromRow);
    },
    async get(userId, id) {
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_connections')
        .select('*')
        .eq('user_id', userId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return fromRow(data);
    },
    async insert(userId, input) {
      const id = String(input.id || randomUUID());
      const row = {
        id,
        user_id: userId,
        ...toRow({
          ...input,
          name: cleanName(input.name),
          transport: input.transport || MCP_TRANSPORTS.STREAMABLE_HTTP,
          authMode: input.authMode || MCP_AUTH_MODES.NONE,
          trustLevel: input.trustLevel || MCP_TRUST_LEVELS.CUSTOM,
          status: input.status || MCP_STATUSES.DISCONNECTED,
        }),
      };
      const { data, error } = await supabaseAdmin.from('lykn_mcp_connections').insert(row).select('*').single();
      if (error) throw error;
      return fromRow(data);
    },
    async update(userId, id, patch) {
      const mapped = {};
      if (patch.name !== undefined) mapped.name = cleanName(patch.name);
      if (patch.serverUrl !== undefined) mapped.server_url = patch.serverUrl;
      if (patch.transport !== undefined) mapped.transport = patch.transport;
      if (patch.authMode !== undefined) mapped.auth_mode = patch.authMode;
      if (patch.secretEncrypted !== undefined) mapped.secret_encrypted = patch.secretEncrypted;
      if (patch.oauthEncrypted !== undefined) mapped.oauth_encrypted = patch.oauthEncrypted;
      if (patch.trustLevel !== undefined) mapped.trust_level = patch.trustLevel;
      if (patch.serverInfo !== undefined) mapped.server_info = patch.serverInfo;
      if (patch.capabilitySummary !== undefined) mapped.capability_summary = patch.capabilitySummary;
      if (patch.classifiedTools !== undefined) mapped.classified_tools = patch.classifiedTools;
      if (patch.schemaHash !== undefined) mapped.schema_hash = patch.schemaHash;
      if (patch.status !== undefined) mapped.status = patch.status;
      if (patch.lastError !== undefined) mapped.last_error = patch.lastError;
      if (patch.lastConnectedAt !== undefined) mapped.last_connected_at = patch.lastConnectedAt;
      if (patch.accountLabel !== undefined) mapped.account_label = patch.accountLabel;
      if (patch.accountIdentity !== undefined) mapped.account_identity = patch.accountIdentity;
      if (patch.origin !== undefined) mapped.origin = patch.origin;
      if (patch.identity !== undefined) mapped.identity = patch.identity;
      if (patch.sessionEpoch !== undefined) mapped.session_epoch = patch.sessionEpoch;
      if (patch.command !== undefined) mapped.command = patch.command;
      if (patch.args !== undefined) mapped.args = patch.args;
      if (patch.workingDirectory !== undefined) mapped.working_directory = patch.workingDirectory;
      if (patch.envCredentialRefs !== undefined) mapped.env_credential_refs = publicEnvCredentialRefs(patch.envCredentialRefs);
      if (patch.catalogId !== undefined) mapped.catalog_id = patch.catalogId;
      if (patch.catalogSource !== undefined) mapped.catalog_source = patch.catalogSource;
      if (patch.providedThrough !== undefined) mapped.provided_through = patch.providedThrough;
      mapped.updated_at = nowIso();
      const { data, error } = await supabaseAdmin
        .from('lykn_mcp_connections')
        .update(mapped)
        .eq('user_id', userId)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return fromRow(data);
    },
    async remove(userId, id) {
      const { error, count } = await supabaseAdmin
        .from('lykn_mcp_connections')
        .delete({ count: 'exact' })
        .eq('user_id', userId)
        .eq('id', id);
      if (error) throw error;
      return (count || 0) > 0;
    },
  };
}
