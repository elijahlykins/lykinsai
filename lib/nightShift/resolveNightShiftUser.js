/**
 * Resolve which auth user to run Night Shift for in manual/dev runs.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {string} targetEmail
 */
export async function findUserIdByEmail(admin, targetEmail) {
  const email = String(targetEmail || '').trim().toLowerCase();
  if (!email) return null;

  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find(
      (u) => String(u.email || '').trim().toLowerCase() === email,
    );
    if (match?.id) return match.id;
    if (data.users.length < perPage) return null;
    page += 1;
    if (page > 50) return null;
  }
}

const RESOLVE_HELP = [
  'Set one of these in .env (recommended):',
  '  NIGHT_SHIFT_USER_EMAIL=you@example.com',
  '  NIGHT_SHIFT_USER_ID=<uuid>',
  '',
  'Or pass:',
  '  npm run night-shift:brief -- --user=you@example.com',
  '  npm run night-shift:brief -- --user=me   (uses .env)',
  '  npm run night-shift:brief -- --all       (every opted-in user)',
].join('\n');

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {{ userArg?: string|null, manual?: boolean }} opts
 * @returns {Promise<{ userId: string, source: string, email?: string|null }>}
 */
export async function resolveNightShiftUserId(admin, { userArg = null, manual = false } = {}) {
  if (!admin) throw new Error('resolveNightShiftUserId: admin client required');

  const raw = String(userArg || '').trim();

  if (raw && isUuid(raw)) {
    return { userId: raw, source: '--user uuid' };
  }

  if (raw && raw.includes('@')) {
    const userId = await findUserIdByEmail(admin, raw);
    if (!userId) {
      throw new Error(`No auth user found for email "${raw}".\n\n${RESOLVE_HELP}`);
    }
    return { userId, source: '--user email', email: raw.toLowerCase() };
  }

  const useEnv = !raw || raw === 'me';
  if (useEnv) {
    const envId = String(process.env.NIGHT_SHIFT_USER_ID || '').trim();
    if (envId) {
      if (!isUuid(envId)) {
        throw new Error(`NIGHT_SHIFT_USER_ID is not a valid UUID: "${envId}"`);
      }
      return { userId: envId, source: 'NIGHT_SHIFT_USER_ID' };
    }

    const envEmail = String(process.env.NIGHT_SHIFT_USER_EMAIL || '').trim();
    if (envEmail) {
      const userId = await findUserIdByEmail(admin, envEmail);
      if (!userId) {
        throw new Error(`No auth user for NIGHT_SHIFT_USER_EMAIL="${envEmail}".\n\n${RESOLVE_HELP}`);
      }
      return { userId, source: 'NIGHT_SHIFT_USER_EMAIL', email: envEmail.toLowerCase() };
    }
  }

  if (manual && !raw) {
    const { data, error } = await admin
      .from('lykn_user_preferences')
      .select('user_id')
      .eq('night_shift_enabled', true)
      .eq('memory_paused', false);
    if (error) throw error;
    const ids = [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
    if (ids.length === 1) {
      return { userId: ids[0], source: 'sole night_shift_enabled user' };
    }
  }

  throw new Error(
    raw && raw !== 'me'
      ? `Could not resolve Night Shift user "${raw}".\n\n${RESOLVE_HELP}`
      : `No Night Shift user configured for manual runs.\n\n${RESOLVE_HELP}`,
  );
}
