import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_KEY_ENV = 'CONNECTOR_TOKEN_KEY';

export const CREDENTIAL_TYPES = Object.freeze({
  CURSOR_CLOUD_API_KEY: 'cursor_cloud_api_key',
  CALENDAR_GOOGLE_OAUTH: 'calendar_google_oauth',
  CALENDAR_APPLE_CALDAV: 'calendar_apple_caldav',
});

function keyBufferFromHex(hex, source = DEFAULT_KEY_ENV) {
  if (!hex) {
    throw new Error(`${source} is not set. Generate one with: openssl rand -hex 32`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${source} must be 64 hex chars (32 bytes). Run: openssl rand -hex 32`);
  }
  return Buffer.from(hex, 'hex');
}

function keyFromEnvironment() {
  return keyBufferFromHex(process.env[DEFAULT_KEY_ENV], DEFAULT_KEY_ENV);
}

function encryptInternal(plaintext, key) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptInternal(blob, key) {
  if (!blob) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted token blob');
  const [ivB64, tagB64, ciphertextB64] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// These names intentionally retain ciphertext compatibility with the former
// connector owner. Existing iv:tag:ciphertext values require no re-encryption.
export function encryptToken(plaintext) {
  return encryptInternal(plaintext, keyFromEnvironment());
}

export function decryptToken(blob) {
  return decryptInternal(blob, keyFromEnvironment());
}

export function encryptTokenWithKey(plaintext, hexKey) {
  return encryptInternal(plaintext, keyBufferFromHex(hexKey, 'hexKey'));
}

export function decryptTokenWithKey(blob, hexKey) {
  return decryptInternal(blob, keyBufferFromHex(hexKey, 'hexKey'));
}

function cleanMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
}

function publicCredential(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    type: row.credential_type,
    label: row.label,
    status: row.status,
    metadata: cleanMetadata(row.metadata),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || null,
  };
}

export function createCredentialRef(type, credentialId) {
  const normalizedType = String(type || '').trim();
  const normalizedId = String(credentialId || '').trim();
  if (!normalizedType || !normalizedId) {
    throw new TypeError('credential type and id are required');
  }
  return Object.freeze({ type: normalizedType, credentialId: normalizedId });
}

export function createSupabaseCredentialStore(client) {
  if (!client) throw new TypeError('Supabase client is required');

  return {
    async list(userId, { type, status } = {}) {
      let query = client
        .from('lykn_credentials')
        .select('id, user_id, credential_type, label, status, metadata, expires_at, created_at, updated_at, last_used_at')
        .eq('user_id', userId);
      if (type) query = query.eq('credential_type', type);
      if (status) query = query.eq('status', status);
      query = query.order('updated_at', { ascending: false });
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(publicCredential);
    },

    async get(userId, credentialId, { includeSecret = false } = {}) {
      const columns = includeSecret
        ? '*'
        : 'id, user_id, credential_type, label, status, metadata, expires_at, created_at, updated_at, last_used_at';
      const { data, error } = await client
        .from('lykn_credentials')
        .select(columns)
        .eq('id', credentialId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        ...publicCredential(data),
        ...(includeSecret ? { secret: decryptToken(data.secret_encrypted) } : {}),
      };
    },

    async findActive(userId, type, { includeSecret = false } = {}) {
      const columns = includeSecret
        ? '*'
        : 'id, user_id, credential_type, label, status, metadata, expires_at, created_at, updated_at, last_used_at';
      const { data, error } = await client
        .from('lykn_credentials')
        .select(columns)
        .eq('user_id', userId)
        .eq('credential_type', type)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return null;
      return {
        ...publicCredential(row),
        ...(includeSecret ? { secret: decryptToken(row.secret_encrypted) } : {}),
      };
    },

    async put(userId, {
      id,
      type,
      secret,
      label = null,
      metadata = {},
      status = 'active',
      expiresAt = null,
    }) {
      if (!userId || !type || secret === null || secret === undefined) {
        throw new TypeError('userId, type, and secret are required');
      }
      const row = {
        ...(id ? { id } : {}),
        user_id: userId,
        credential_type: type,
        secret_encrypted: encryptToken(secret),
        label: label ? String(label).trim().slice(0, 120) : null,
        metadata: cleanMetadata(metadata),
        status,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await client
        .from('lykn_credentials')
        .upsert(row, { onConflict: 'id' })
        .select('*')
        .single();
      if (error) throw error;
      return publicCredential(data);
    },

    async update(userId, credentialId, patch = {}) {
      const row = { updated_at: new Date().toISOString() };
      if (patch.secret !== undefined) row.secret_encrypted = encryptToken(patch.secret);
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.metadata !== undefined) row.metadata = cleanMetadata(patch.metadata);
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.expiresAt !== undefined) row.expires_at = patch.expiresAt;
      if (patch.lastUsedAt !== undefined) row.last_used_at = patch.lastUsedAt;
      const { data, error } = await client
        .from('lykn_credentials')
        .update(row)
        .eq('id', credentialId)
        .eq('user_id', userId)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return publicCredential(data);
    },

    async remove(userId, credentialId) {
      const { error } = await client
        .from('lykn_credentials')
        .delete()
        .eq('id', credentialId)
        .eq('user_id', userId);
      if (error) throw error;
      return true;
    },
  };
}
