// Cross-user access regressions for the user-owned query helpers.
// These tests substitute User B's identity onto User A's object ids and
// assert the helper cannot return, update, delete, or sign A's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUserPath } from '../exterior/capabilityStorage.js';
import {
  requireUserId,
  getUserRowById,
  updateUserRowById,
  deleteUserRowById,
  userOwnedTable,
} from './userOwnedAccess.js';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const SEED = {
  vault_items: { id: 'vault-a', user_id: USER_A, title: 'A secret note' },
  lykn_chats: { id: 'chat-a', user_id: USER_A, title: 'A private chat' },
  lykn_memory_documents: { id: 'mem-a', user_id: USER_A, path: 'profile.md', markdown: 'A memory' },
  lykn_projects: { id: 'proj-a', user_id: USER_A, name: 'A project' },
  file_upload: { id: 'file-a', user_id: USER_A, storage_path: `${USER_A}/file-a/original.png` },
};

function matches(row, filters) {
  return filters.every((f) => {
    if (f.op === 'in') return (f.val || []).includes(row[f.col]);
    return String(row[f.col]) === String(f.val);
  });
}

function createFakeClient(rows) {
  const store = rows.map((r) => ({ ...r }));
  const signed = [];
  return {
    signed,
    from(table) {
      const filters = [];
      let mode = 'select';
      let patch = null;
      const api = {
        select() {
          return api;
        },
        insert(row) {
          mode = 'insert';
          patch = row;
          return api;
        },
        update(row) {
          mode = 'update';
          patch = row;
          return api;
        },
        delete() {
          mode = 'delete';
          return api;
        },
        eq(col, val) {
          filters.push({ col, val });
          return api;
        },
        in(col, val) {
          filters.push({ col, op: 'in', val });
          return api;
        },
        maybeSingle() {
          return execute('one');
        },
        single() {
          return execute('one');
        },
        then(resolve, reject) {
          return execute('many').then(resolve, reject);
        },
      };
      async function execute(shape) {
        if (mode === 'insert') {
          const row = { table, ...patch };
          store.push(row);
          return { data: row, error: null };
        }
        const hit = store.filter((r) => r.table === table && matches(r, filters));
        if (mode === 'update') {
          for (const row of hit) Object.assign(row, patch);
        }
        if (mode === 'delete') {
          for (const row of hit) {
            const idx = store.indexOf(row);
            if (idx >= 0) store.splice(idx, 1);
          }
        }
        const data = mode === 'delete' || mode === 'update' || mode === 'select' ? hit : hit;
        if (shape === 'one') {
          return { data: data[0] || null, error: null };
        }
        return { data, error: null };
      }
      return api;
    },
    storage: {
      from() {
        return {
          async createSignedUrl(path) {
            signed.push(path);
            return { data: { signedUrl: `https://signed.example/${path}` } };
          },
        };
      },
    },
  };
}

function seedClient() {
  return createFakeClient(Object.entries(SEED).map(([table, row]) => ({ table, ...row })));
}

test('requireUserId refuses an empty owner', () => {
  assert.throws(() => requireUserId(''), /user_id_required/);
  assert.throws(() => requireUserId(null), /user_id_required/);
  assert.equal(requireUserId(USER_A), USER_A);
});

test('User B cannot read User A vault / chat / memory / project / file by id', async () => {
  const client = seedClient();
  for (const [table, row] of Object.entries(SEED)) {
    const { data } = await getUserRowById(client, table, USER_B, row.id);
    assert.equal(data, null, `${table}: User B must not read User A's row`);
  }
});

test('User A can read their own high-value rows by id', async () => {
  const client = seedClient();
  for (const [table, row] of Object.entries(SEED)) {
    const { data } = await getUserRowById(client, table, USER_A, row.id);
    assert.ok(data, `${table}: owner must read their row`);
    assert.equal(data.user_id, USER_A);
    assert.equal(data.id, row.id);
  }
});

test('User B cannot update User A rows by id substitution', async () => {
  const client = seedClient();
  for (const [table, row] of Object.entries(SEED)) {
    const { data } = await updateUserRowById(client, table, USER_B, row.id, { title: 'hijacked' });
    assert.equal(data, null, `${table}: User B must not update User A's row`);
  }
  const { data: stillA } = await getUserRowById(client, 'vault_items', USER_A, SEED.vault_items.id);
  assert.equal(stillA.title, 'A secret note');
});

test('User B cannot delete User A rows by id substitution', async () => {
  const client = seedClient();
  for (const [table, row] of Object.entries(SEED)) {
    const result = await deleteUserRowById(client, table, USER_B, row.id);
    assert.equal(result.deleted, false, `${table}: User B must not delete User A's row`);
  }
  const { data } = await getUserRowById(client, 'lykn_chats', USER_A, SEED.lykn_chats.id);
  assert.equal(data.id, 'chat-a');
});

test('owner delete removes only the owned row', async () => {
  const client = seedClient();
  const result = await deleteUserRowById(client, 'vault_items', USER_A, SEED.vault_items.id);
  assert.equal(result.deleted, true);
  const { data } = await getUserRowById(client, 'vault_items', USER_A, SEED.vault_items.id);
  assert.equal(data, null);
});

test('userOwnedTable insert stamps the caller user_id even if a foreign id is supplied', async () => {
  const client = seedClient();
  const { data } = await userOwnedTable(client, 'vault_items', USER_B)
    .insert({ id: 'vault-b', user_id: USER_A, title: 'spoof' })
    .single();
  assert.equal(data.user_id, USER_B);
});

test('signed URL generation cannot escape the caller namespace', () => {
  const own = assertUserPath(USER_B, `${USER_B}/docs/file.txt`);
  assert.equal(own.ok, true);
  const foreign = assertUserPath(USER_B, `${USER_A}/docs/file.txt`);
  assert.equal(foreign.ok, false);
  const traversal = assertUserPath(USER_B, `${USER_B}/../${USER_A}/docs/file.txt`);
  assert.equal(traversal.ok, false);
});

test('update helper cannot reassign user_id via the patch', async () => {
  const client = seedClient();
  await updateUserRowById(client, 'vault_items', USER_A, SEED.vault_items.id, {
    user_id: USER_B,
    title: 'still A',
  });
  const { data } = await getUserRowById(client, 'vault_items', USER_A, SEED.vault_items.id);
  assert.equal(data.user_id, USER_A);
  assert.equal(data.title, 'still A');
});
