/**
 * User-owned data access for service-role Supabase clients.
 *
 * `supabaseAdmin` bypasses RLS. Isolation then depends on every query
 * including the authenticated user id. These helpers make that filter
 * required: a caller cannot look up a user-owned row by id alone.
 *
 * Prefer this over ad hoc `.eq('user_id', req.user.id)` at the route.
 * Admin, webhook, and job paths that intentionally cross users should
 * not use these helpers.
 */

export function requireUserId(userId) {
  const id = String(userId || '').trim();
  if (!id) {
    const err = new Error('user_id_required');
    err.code = 'user_id_required';
    throw err;
  }
  return id;
}

export function requireRowId(id) {
  const rowId = String(id || '').trim();
  if (!rowId) {
    const err = new Error('id_required');
    err.code = 'id_required';
    throw err;
  }
  return rowId;
}

/**
 * Query builder that always includes `user_id = userId`.
 * Select / update / delete from this builder cannot omit the owner filter.
 */
export function userOwnedTable(client, table, userId) {
  if (!client) throw new Error('supabase_client_required');
  const uid = requireUserId(userId);
  const name = String(table || '').trim();
  if (!name) throw new Error('table_required');
  return {
    select(columns = '*') {
      return client.from(name).select(columns).eq('user_id', uid);
    },
    insert(row) {
      const body = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
      return client.from(name).insert({ ...body, user_id: uid });
    },
    update(patch) {
      const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...patch } : {};
      delete body.user_id;
      return client.from(name).update(body).eq('user_id', uid);
    },
    delete() {
      return client.from(name).delete().eq('user_id', uid);
    },
  };
}

export async function getUserRowById(client, table, userId, id, columns = '*') {
  const rowId = requireRowId(id);
  return userOwnedTable(client, table, userId).select(columns).eq('id', rowId).maybeSingle();
}

export async function updateUserRowById(client, table, userId, id, patch, columns = '*') {
  const rowId = requireRowId(id);
  return userOwnedTable(client, table, userId)
    .update(patch)
    .eq('id', rowId)
    .select(columns)
    .maybeSingle();
}

export async function deleteUserRowById(client, table, userId, id) {
  const rowId = requireRowId(id);
  const { data, error } = await userOwnedTable(client, table, userId)
    .delete()
    .eq('id', rowId)
    .select('id');
  if (error) return { data: null, error, deleted: false };
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return { data: rows, error: null, deleted: rows.length > 0 };
}

/**
 * Owner-scoped lookup by one or more equality filters (in addition to user_id).
 * Use for keys that are not the row `id`, such as Memory `path` or chat_id.
 */
export async function getUserRowWhere(client, table, userId, match, columns = '*') {
  const filters = match && typeof match === 'object' && !Array.isArray(match) ? match : {};
  const keys = Object.keys(filters);
  if (!keys.length) {
    const err = new Error('match_required');
    err.code = 'match_required';
    throw err;
  }
  let q = userOwnedTable(client, table, userId).select(columns);
  for (const key of keys) {
    q = q.eq(String(key), requireRowId(filters[key]));
  }
  return q.maybeSingle();
}
