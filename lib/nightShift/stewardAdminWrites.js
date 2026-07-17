/**
 * Service-role writes used by Night Shift cron.
 */

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 */
export async function createTodoAdmin(admin, {
  userId,
  projectId,
  title,
  notes = null,
  source = 'night-shift',
}) {
  const t = String(title || '').trim().slice(0, 280);
  if (!t) return null;
  const { data, error } = await admin
    .from('lykn_todos')
    .insert({
      user_id: userId,
      project_id: projectId,
      title: t,
      notes: notes ? String(notes).trim().slice(0, 4000) : null,
      status: 'open',
      priority: 'normal',
      source,
    })
    .select('id, title')
    .single();
  if (error) throw new Error(`todo insert failed: ${error.message}`);
  return data;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 */
export async function loadStaleTodos(admin, userId, projectId, staleDays = 7) {
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('lykn_todos')
    .select('title, updated_at')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .eq('status', 'open')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(10);
  if (error) throw error;
  return data || [];
}

/**
 * Lightweight vault search for cron (keyword pass only).
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 */
export async function searchVaultLite(admin, userId, query, limit = 5) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  const esc = q.replace(/[%_,()]/g, '\\$&');
  const pattern = `%${esc}%`;
  const { data, error } = await admin
    .from('vault_items')
    .select('id, title, content, ai_summary')
    .eq('user_id', userId)
    .or(`title.ilike.${pattern},content.ilike.${pattern},ai_summary.ilike.${pattern}`)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []).map((n) => ({
    title: n.title || 'Untitled',
    snippet: String(n.ai_summary || n.content || '').replace(/\s+/g, ' ').trim().slice(0, 280),
  }));
}
