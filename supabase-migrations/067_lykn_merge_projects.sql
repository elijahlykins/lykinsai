-- ============================================
-- LYKN — atomic project merge
-- Migration: 067_lykn_merge_projects.sql
-- ============================================
-- Adds `public.lykn_merge_projects(p_source, p_target, p_dry_run, p_user_id)`,
-- the single source of truth for "fold project A into project B" semantics
-- across both UI surfaces (synthesis-page Merge button) and chat surfaces
-- (the lykn_mergeProjects MCP tool any external AI client can call).
--
-- Why a SQL function rather than a series of client-side requests:
--   A merge touches four tables (lykn_project_state, lykn_project_neurons,
--   lykn_user_model_facts, lykn_user_synthesis_profile) plus the
--   lykn_projects row itself. Running those as separate Supabase calls
--   from the JS client opens a window where a crash or network blip
--   leaves project state half-merged — rows pointing at a project that
--   no longer exists, or a focus pointer dangling at a deleted id, or
--   neuron-cluster duplicates that violate the unique constraint. A
--   single transaction inside Postgres is the only honest way.
--
-- Two-phase by default:
--   p_dry_run = true  → returns a preview (counts of what would move
--                       and what would be superseded) without writing.
--   p_dry_run = false → executes the merge.
--   The MCP tool defaults to dry_run=true and requires `confirm: true`
--   from the caller before the live path runs, so an AI agent can't
--   destroy a user's project on a hallucinated guess.
--
-- Conflict resolution:
--   • lykn_project_state — every source row's project_id is repointed
--     to target. Afterwards, for any state_key that now has multiple
--     non-superseded rows in target, the OLDER rows are stamped with
--     superseded_at = now() so the kv-store invariant ("at most one
--     current row per (project, state_key)") holds. Newer-wins matches
--     the existing pushProjectState semantics; the audit history
--     survives untouched.
--   • lykn_project_neurons — the (user_id, project_id, node_id) UNIQUE
--     constraint means we cannot blindly repoint. For each source row
--     whose node_id is ALREADY a member of target, drop the source row
--     (target's snapshot wins; user-grouped intent is preserved). For
--     source rows whose node_id is new to target, repoint.
--   • lykn_user_model_facts.project_id — repointed in bulk. Wrapped in
--     a defensive EXCEPTION block so the function still works if
--     migration 047 was rolled back or partially applied.
--   • lykn_user_synthesis_profile.active_project_id — if it pointed at
--     source, redirect to target so the user's focus survives the
--     merge. Read by lykn_getContextBlock; matters across every
--     external AI client.
--
-- Source row lifecycle:
--   The source `lykn_projects` row is HARD DELETED at the end of the
--   live path. Any FK row we forgot to repoint will be cleaned up by
--   the existing ON DELETE CASCADE / SET NULL rules from migration
--   045 — that's the safety net, not the primary cleanup path.
--
-- Identity resolution:
--   The function is SECURITY DEFINER (so service-role and JWT callers
--   share one transactional path) and verifies user ownership of BOTH
--   projects manually inside the function. p_user_id is required from
--   service-role contexts (MCP server) and ignored from JWT contexts
--   where auth.uid() resolves the caller. Mismatched ownership raises;
--   the function never writes across users.

-- ---------------------------------------------------------------------------
-- 1. Function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lykn_merge_projects(
  p_source uuid,
  p_target uuid,
  p_dry_run boolean DEFAULT true,
  p_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_source_proj record;
  v_target_proj record;
  v_state_moved int := 0;
  v_state_superseded int := 0;
  v_neurons_moved int := 0;
  v_neurons_dropped int := 0;
  v_facts_moved int := 0;
  v_active_repointed boolean := false;
BEGIN
  -- Resolve caller identity. Service-role callers (MCP server) pass
  -- p_user_id explicitly; JWT callers (frontend) get it from auth.uid().
  -- We deliberately do NOT auto-fall back to one when both are
  -- present — if a caller presents both a JWT and a p_user_id and they
  -- disagree, that's a programming error and we'd rather raise than
  -- silently write to a different account.
  v_user_id := COALESCE(p_user_id, auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'lykn_merge_projects: no user identity (pass p_user_id from service-role contexts)';
  END IF;
  IF p_user_id IS NOT NULL AND auth.uid() IS NOT NULL AND p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'lykn_merge_projects: p_user_id does not match auth.uid()';
  END IF;

  IF p_source IS NULL OR p_target IS NULL THEN
    RAISE EXCEPTION 'lykn_merge_projects: p_source and p_target are required';
  END IF;
  IF p_source = p_target THEN
    RAISE EXCEPTION 'lykn_merge_projects: source and target must be different projects';
  END IF;

  -- Verify ownership of BOTH projects. This is the only authorisation
  -- check on the live path; SECURITY DEFINER bypasses RLS so we MUST
  -- be the gate.
  SELECT id, name, description, status, last_active_at
    INTO v_source_proj
    FROM public.lykn_projects
   WHERE id = p_source AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lykn_merge_projects: source project % not found or not owned by user', p_source;
  END IF;

  SELECT id, name, description, status, last_active_at
    INTO v_target_proj
    FROM public.lykn_projects
   WHERE id = p_target AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lykn_merge_projects: target project % not found or not owned by user', p_target;
  END IF;

  -- ----------------------------------------------------------------
  -- Dry run: compute counts WITHOUT writing.
  -- ----------------------------------------------------------------
  IF p_dry_run THEN
    SELECT COUNT(*) INTO v_state_moved
      FROM public.lykn_project_state
     WHERE project_id = p_source AND user_id = v_user_id;

    -- After the move, any (target, state_key) where BOTH source and
    -- target had a non-superseded row will end up with two; the older
    -- one gets superseded. The pre-merge intersection counts that.
    SELECT COUNT(*) INTO v_state_superseded
      FROM (
        SELECT s.state_key
          FROM public.lykn_project_state s
         WHERE s.project_id = p_source AND s.user_id = v_user_id AND s.superseded_at IS NULL
        INTERSECT
        SELECT t.state_key
          FROM public.lykn_project_state t
         WHERE t.project_id = p_target AND t.user_id = v_user_id AND t.superseded_at IS NULL
      ) k;

    SELECT COUNT(*) INTO v_neurons_moved
      FROM public.lykn_project_neurons s
     WHERE s.project_id = p_source AND s.user_id = v_user_id
       AND NOT EXISTS (
         SELECT 1 FROM public.lykn_project_neurons t
          WHERE t.project_id = p_target AND t.user_id = v_user_id AND t.node_id = s.node_id
       );

    SELECT COUNT(*) INTO v_neurons_dropped
      FROM public.lykn_project_neurons s
     WHERE s.project_id = p_source AND s.user_id = v_user_id
       AND EXISTS (
         SELECT 1 FROM public.lykn_project_neurons t
          WHERE t.project_id = p_target AND t.user_id = v_user_id AND t.node_id = s.node_id
       );

    -- Facts may not exist on every deploy (047 added the column
    -- conditionally). Catch and fall through to 0 so the dry run
    -- still returns something useful.
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM public.lykn_user_model_facts WHERE project_id = $1 AND user_id = $2'
        INTO v_facts_moved
        USING p_source, v_user_id;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      v_facts_moved := 0;
    END;

    SELECT EXISTS (
      SELECT 1 FROM public.lykn_user_synthesis_profile
       WHERE user_id = v_user_id AND active_project_id = p_source
    ) INTO v_active_repointed;

    RETURN jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'source', jsonb_build_object(
        'id', v_source_proj.id,
        'name', v_source_proj.name,
        'description', v_source_proj.description,
        'status', v_source_proj.status,
        'last_active_at', v_source_proj.last_active_at
      ),
      'target', jsonb_build_object(
        'id', v_target_proj.id,
        'name', v_target_proj.name,
        'description', v_target_proj.description,
        'status', v_target_proj.status,
        'last_active_at', v_target_proj.last_active_at
      ),
      'preview', jsonb_build_object(
        'state_rows_moved', v_state_moved,
        'state_keys_superseded_in_target', v_state_superseded,
        'neurons_moved', v_neurons_moved,
        'neurons_dropped_as_duplicate', v_neurons_dropped,
        'facts_repointed', v_facts_moved,
        'active_project_pointer_repointed', v_active_repointed,
        'source_project_deleted', true
      ),
      'message', format(
        'Dry run. Re-call with p_dry_run=false to commit. Source "%s" will be deleted; %s state rows + %s neurons re-pointed to target "%s".',
        v_source_proj.name, v_state_moved, v_neurons_moved, v_target_proj.name
      )
    );
  END IF;

  -- ----------------------------------------------------------------
  -- Live merge.
  -- ----------------------------------------------------------------

  -- 1. Repoint every state row source → target. Re-run supersession
  --    on the resulting set so we never have two non-superseded rows
  --    at the same (project, state_key).
  WITH moved AS (
    UPDATE public.lykn_project_state
       SET project_id = p_target
     WHERE project_id = p_source AND user_id = v_user_id
    RETURNING id
  )
  SELECT COUNT(*) INTO v_state_moved FROM moved;

  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY state_key
             ORDER BY created_at DESC, id DESC
           ) AS rn
      FROM public.lykn_project_state
     WHERE project_id = p_target
       AND user_id = v_user_id
       AND superseded_at IS NULL
  ),
  superseded AS (
    UPDATE public.lykn_project_state
       SET superseded_at = now()
     WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING id
  )
  SELECT COUNT(*) INTO v_state_superseded FROM superseded;

  -- 2. Drop neuron rows whose node_id is already in target (dedupe);
  --    repoint the rest. Order matters — UPDATEing first would trip
  --    the (user_id, project_id, node_id) UNIQUE constraint.
  WITH dropped AS (
    DELETE FROM public.lykn_project_neurons s
     WHERE s.project_id = p_source
       AND s.user_id = v_user_id
       AND EXISTS (
         SELECT 1 FROM public.lykn_project_neurons t
          WHERE t.project_id = p_target
            AND t.user_id = v_user_id
            AND t.node_id = s.node_id
       )
    RETURNING s.id
  )
  SELECT COUNT(*) INTO v_neurons_dropped FROM dropped;

  WITH moved_neurons AS (
    UPDATE public.lykn_project_neurons
       SET project_id = p_target
     WHERE project_id = p_source AND user_id = v_user_id
    RETURNING id
  )
  SELECT COUNT(*) INTO v_neurons_moved FROM moved_neurons;

  -- 3. Repoint facts (best-effort — see dry-run comment).
  BEGIN
    EXECUTE 'UPDATE public.lykn_user_model_facts SET project_id = $1 WHERE project_id = $2 AND user_id = $3'
      USING p_target, p_source, v_user_id;
    GET DIAGNOSTICS v_facts_moved = ROW_COUNT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_facts_moved := 0;
  END;

  -- 4. Redirect the active-project pointer if it was on source.
  --    Bumps updated_at so any frontend watcher invalidates its
  --    cached "current project" the moment the merge lands.
  UPDATE public.lykn_user_synthesis_profile
     SET active_project_id = p_target,
         updated_at = now()
   WHERE user_id = v_user_id
     AND active_project_id = p_source;
  v_active_repointed := FOUND;

  -- 5. Bump target's last_active_at to the most recent of the two
  --    so the merged project floats to the top of recent-projects
  --    sorts (and to now() because the merge itself counts as activity).
  UPDATE public.lykn_projects
     SET last_active_at = GREATEST(last_active_at, v_source_proj.last_active_at, now()),
         updated_at = now()
   WHERE id = p_target AND user_id = v_user_id;

  -- 6. Hard-delete the source. Any FK rows we missed get mopped up by
  --    the existing CASCADE / SET NULL rules on migration 045.
  DELETE FROM public.lykn_projects
   WHERE id = p_source AND user_id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'merged', jsonb_build_object(
      'source_id', p_source,
      'source_name', v_source_proj.name,
      'target_id', p_target,
      'target_name', v_target_proj.name,
      'state_rows_moved', v_state_moved,
      'state_rows_superseded_in_target', v_state_superseded,
      'neurons_moved', v_neurons_moved,
      'neurons_dropped_as_duplicate', v_neurons_dropped,
      'facts_repointed', v_facts_moved,
      'active_project_pointer_repointed', v_active_repointed
    ),
    'message', format(
      'Merged "%s" into "%s". %s state rows moved (%s superseded), %s neurons moved (%s deduped).',
      v_source_proj.name, v_target_proj.name,
      v_state_moved, v_state_superseded,
      v_neurons_moved, v_neurons_dropped
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Permissions
-- ---------------------------------------------------------------------------
-- Function is SECURITY DEFINER. Authenticated end-users may call it via
-- PostgREST (.rpc('lykn_merge_projects', …) from the JS client) and the
-- service-role key may call it server-side from the MCP tool. Ownership
-- is verified inside the function; no other role gets EXECUTE.
REVOKE ALL ON FUNCTION public.lykn_merge_projects(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lykn_merge_projects(uuid, uuid, boolean, uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comment
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.lykn_merge_projects(uuid, uuid, boolean, uuid) IS
  'Atomic merge of two projects owned by the same user. Repoints lykn_project_state / lykn_project_neurons / lykn_user_model_facts.project_id from source to target, reconciles state supersession and neuron dedup, redirects active-project pointer if needed, and hard-deletes the source. Two-phase: p_dry_run=true returns a preview; p_dry_run=false commits. Caller must own both projects; service-role contexts pass p_user_id, JWT contexts rely on auth.uid().';
