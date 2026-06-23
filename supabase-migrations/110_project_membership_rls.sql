-- ============================================================================
-- 110 — Membership-aware RLS for shared projects
-- ============================================================================
-- 109 added lykn_project_members + the lykn_is_project_member /
-- lykn_project_can_edit / lykn_is_project_owner helpers. This migration
-- rewrites the row-level security on the SCOPED set of project tables so a
-- collaborator can see (and, with the editor role, write) a project's shared
-- working state, tasks, and calendar — while everything else stays personal.
--
-- Scope (v1): lykn_projects, lykn_project_state, lykn_todos, lykn_events,
-- lykn_reminders. Deliberately NOT in scope: lykn_project_neurons and the
-- synthesis vault/beliefs they point at (neuron clustering stays per-user).
--
-- Permission model:
--   • PROJECT METADATA (rename / archive / focus / delete) → OWNER only.
--     (Editors get content access, not the ability to rename or delete the
--     project. Keeping metadata owner-only also means an editor can never
--     touch lykn_projects.user_id, so there's no ownership-escalation path.)
--   • PROJECT CONTENT (state pushes, todos, events, reminders) → OWNER + EDITOR
--     can write; any MEMBER (incl. viewer) can read.
--   • PERSONAL rows (a todo/event/reminder with no project_id) → unchanged,
--     strictly the owning user. The `user_id = auth.uid()` branch is always
--     allowed first so personal data is never affected by membership.
--
-- Safe to re-run: every policy is DROP IF EXISTS + CREATE.

-- ---------------------------------------------------------------------------
-- 1. lykn_projects — read for members, write/delete for owner
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users read own projects"   ON public.lykn_projects;
DROP POLICY IF EXISTS "Users insert own projects" ON public.lykn_projects;
DROP POLICY IF EXISTS "Users update own projects" ON public.lykn_projects;
DROP POLICY IF EXISTS "Users delete own projects" ON public.lykn_projects;

CREATE POLICY "Users read own projects"
  ON public.lykn_projects FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.lykn_is_project_member(id));

-- You can only create projects you own. (Sharing happens via invites, not by
-- inserting a row owned by someone else.)
CREATE POLICY "Users insert own projects"
  ON public.lykn_projects FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Metadata edits (name/description/status/parent) are owner-only. WITH CHECK
-- keeps user_id pinned to the owner so an editor could never re-home the row.
CREATE POLICY "Users update own projects"
  ON public.lykn_projects FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id OR public.lykn_is_project_owner(id))
  WITH CHECK  (auth.uid() = user_id OR public.lykn_is_project_owner(id));

CREATE POLICY "Users delete own projects"
  ON public.lykn_projects FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id OR public.lykn_is_project_owner(id));

-- ---------------------------------------------------------------------------
-- 2. lykn_project_state — shared AI working memory
-- ---------------------------------------------------------------------------
-- Members read all of a project's state; editors can push (insert), correct
-- (update / supersede), and delete. Each row keeps its author in `user_id`.
DROP POLICY IF EXISTS "Users read own project state"   ON public.lykn_project_state;
DROP POLICY IF EXISTS "Users insert own project state" ON public.lykn_project_state;
DROP POLICY IF EXISTS "Users update own project state" ON public.lykn_project_state;
DROP POLICY IF EXISTS "Users delete own project state" ON public.lykn_project_state;

CREATE POLICY "Users read own project state"
  ON public.lykn_project_state FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.lykn_is_project_member(project_id));

-- The author is always the inserting user; they must be an editor (or owner)
-- of the target project.
CREATE POLICY "Users insert own project state"
  ON public.lykn_project_state FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.lykn_project_can_edit(project_id));

-- Editors can supersede any row in the project (incl. another member's push).
CREATE POLICY "Users update own project state"
  ON public.lykn_project_state FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id OR public.lykn_project_can_edit(project_id))
  WITH CHECK  (auth.uid() = user_id OR public.lykn_project_can_edit(project_id));

CREATE POLICY "Users delete own project state"
  ON public.lykn_project_state FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id OR public.lykn_project_can_edit(project_id));

-- ---------------------------------------------------------------------------
-- 3. lykn_todos — personal tasks + shared project tasks
-- ---------------------------------------------------------------------------
-- A todo with no project_id is strictly personal (unchanged behaviour). A
-- todo attached to a shared project is visible to every member and editable
-- by editors.
DROP POLICY IF EXISTS lykn_todos_select_own ON public.lykn_todos;
DROP POLICY IF EXISTS lykn_todos_insert_own ON public.lykn_todos;
DROP POLICY IF EXISTS lykn_todos_update_own ON public.lykn_todos;
DROP POLICY IF EXISTS lykn_todos_delete_own ON public.lykn_todos;

CREATE POLICY lykn_todos_select_own
  ON public.lykn_todos FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_is_project_member(project_id))
  );

-- Insert your own row; if you attach it to a project you must be able to edit
-- that project.
CREATE POLICY lykn_todos_insert_own
  ON public.lykn_todos FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (project_id IS NULL OR public.lykn_project_can_edit(project_id))
  );

CREATE POLICY lykn_todos_update_own
  ON public.lykn_todos FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  );

CREATE POLICY lykn_todos_delete_own
  ON public.lykn_todos FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  );

-- ---------------------------------------------------------------------------
-- 4. lykn_events — personal calendar + shared project calendar
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS lykn_events_select_own ON public.lykn_events;
DROP POLICY IF EXISTS lykn_events_insert_own ON public.lykn_events;
DROP POLICY IF EXISTS lykn_events_update_own ON public.lykn_events;
DROP POLICY IF EXISTS lykn_events_delete_own ON public.lykn_events;

CREATE POLICY lykn_events_select_own
  ON public.lykn_events FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_is_project_member(project_id))
  );

CREATE POLICY lykn_events_insert_own
  ON public.lykn_events FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (project_id IS NULL OR public.lykn_project_can_edit(project_id))
  );

CREATE POLICY lykn_events_update_own
  ON public.lykn_events FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  );

CREATE POLICY lykn_events_delete_own
  ON public.lykn_events FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  );

-- ---------------------------------------------------------------------------
-- 5. lykn_reminders — personal reminders + shared project reminders
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS lykn_reminders_select_own ON public.lykn_reminders;
DROP POLICY IF EXISTS lykn_reminders_insert_own ON public.lykn_reminders;
DROP POLICY IF EXISTS lykn_reminders_update_own ON public.lykn_reminders;
DROP POLICY IF EXISTS lykn_reminders_delete_own ON public.lykn_reminders;

CREATE POLICY lykn_reminders_select_own
  ON public.lykn_reminders FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_is_project_member(project_id))
  );

CREATE POLICY lykn_reminders_insert_own
  ON public.lykn_reminders FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (project_id IS NULL OR public.lykn_project_can_edit(project_id))
  );

CREATE POLICY lykn_reminders_update_own
  ON public.lykn_reminders FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  );

CREATE POLICY lykn_reminders_delete_own
  ON public.lykn_reminders FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (project_id IS NOT NULL AND public.lykn_project_can_edit(project_id))
  );

-- ---------------------------------------------------------------------------
-- 6. Guard helper for shared projects (used by merge / destructive paths)
-- ---------------------------------------------------------------------------
-- The merge RPC (067) assumes single ownership and repoints rows across two
-- projects owned by the same user. Merging a SHARED project would quietly move
-- collaborators' state under a project they may not belong to. This helper
-- lets the app (and a future merge-RPC rewrite) detect a shared project and
-- refuse the operation. NOTE: not yet wired into lykn_merge_projects itself —
-- the frontend merge UI should call this and block when it returns true until
-- merge is redesigned for collaboration.
CREATE OR REPLACE FUNCTION public.lykn_project_has_collaborators(p_project UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.lykn_project_members m
    WHERE m.project_id = p_project
      AND m.role <> 'owner'
  );
$$;

GRANT EXECUTE ON FUNCTION public.lykn_project_has_collaborators(UUID) TO authenticated;

COMMENT ON FUNCTION public.lykn_project_has_collaborators(UUID) IS
  'True if a project has any non-owner member or pending invite. Used to block merge/destructive single-owner operations on shared projects (110).';
