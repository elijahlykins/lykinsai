-- ============================================================================
-- 109 — Project collaboration: membership, roles, and email invites
-- ============================================================================
-- Until now every lykn_projects row (045) and everything hanging off it
-- (lykn_project_state, lykn_todos, lykn_events, lykn_reminders) was strictly
-- single-owner: RLS gated on `auth.uid() = user_id`, full stop. This migration
-- introduces SCOPED collaboration — multiple people on the same project,
-- sharing its working state + tasks + calendar — without touching the
-- per-user neuron clustering (lykn_project_neurons stays personal; the
-- synthesis vault/beliefs a project references are NOT cross-shared in v1).
--
-- This file adds the membership model + the access-check helper functions
-- that the RLS rewrite in 110 leans on. The owner stays `lykn_projects.user_id`
-- (we never touch it); membership is purely additive.
--
-- Roles:
--   • owner  — created the project; can manage members + delete it.
--   • editor — can read AND write shared state / tasks / events.
--   • viewer — read-only.
--
-- Invites are email-based: an owner adds a row with `invited_email` and a
-- NULL `user_id`; when that person signs in, lykn_accept_project_invites()
-- (called by the app on login) matches their verified email and stamps
-- `user_id` + `accepted_at`, turning the pending invite into membership.

-- ---------------------------------------------------------------------------
-- 1. Membership table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lykn_project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.lykn_projects(id) ON DELETE CASCADE,

  -- The collaborator. NULL while an email invite is still pending (the
  -- invitee hasn't signed in / been matched yet). Stamped on acceptance.
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The address the invite was sent to. Kept even after acceptance for an
  -- audit trail / re-display ("invited bob@x.com"). Required when user_id is
  -- NULL (a pending invite must know who it's for).
  invited_email TEXT CHECK (invited_email IS NULL OR length(invited_email) <= 320),

  role TEXT NOT NULL DEFAULT 'editor'
    CHECK (role IN ('owner', 'editor', 'viewer')),

  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = invite still pending; stamped when the invitee accepts (or, for
  -- the owner backfill, set to the project's created_at up front).
  accepted_at TIMESTAMPTZ,

  -- A row must identify its target one way or the other.
  CONSTRAINT lykn_project_members_target_present
    CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL)
);

-- One membership row per (project, user). Partial because pending invites
-- carry a NULL user_id and several of those can coexist on a project.
CREATE UNIQUE INDEX IF NOT EXISTS lykn_project_members_unique_user
  ON public.lykn_project_members (project_id, user_id)
  WHERE user_id IS NOT NULL;

-- One pending invite per (project, email). Case-insensitive so "Bob@X.com"
-- and "bob@x.com" don't double-invite.
CREATE UNIQUE INDEX IF NOT EXISTS lykn_project_members_unique_pending_email
  ON public.lykn_project_members (project_id, lower(invited_email))
  WHERE invited_email IS NOT NULL AND user_id IS NULL;

-- "All projects I'm a member of" — the read path the app uses to list shared
-- projects alongside owned ones.
CREATE INDEX IF NOT EXISTS lykn_project_members_user_idx
  ON public.lykn_project_members (user_id)
  WHERE user_id IS NOT NULL;

-- "Pending invites for this email" — the accept-on-login lookup.
CREATE INDEX IF NOT EXISTS lykn_project_members_pending_email_idx
  ON public.lykn_project_members (lower(invited_email))
  WHERE user_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Access-check helpers (the keystone for RLS in 110)
-- ---------------------------------------------------------------------------
-- These are SECURITY DEFINER so they read lykn_project_members WITHOUT
-- triggering that table's own RLS — which is what keeps the project-table
-- policies from recursing back into the membership table. Marked STABLE
-- (pure within a statement) so the planner can cache them per row-batch.

-- Is the current user an ACCEPTED member of this project? (Owners get an
-- accepted owner row via the backfill + trigger below, so this also covers
-- them — but the project policies still keep the cheap `user_id = auth.uid()`
-- branch first so an owner never depends on the membership row existing.)
CREATE OR REPLACE FUNCTION public.lykn_is_project_member(p_project UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.lykn_project_members m
    WHERE m.project_id = p_project
      AND m.user_id = auth.uid()
      AND m.accepted_at IS NOT NULL
  );
$$;

-- Can the current user WRITE shared content on this project? (owner | editor)
CREATE OR REPLACE FUNCTION public.lykn_project_can_edit(p_project UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.lykn_project_members m
    WHERE m.project_id = p_project
      AND m.user_id = auth.uid()
      AND m.accepted_at IS NOT NULL
      AND m.role IN ('owner', 'editor')
  );
$$;

-- Is the current user the project OWNER? (member-management + delete gate)
CREATE OR REPLACE FUNCTION public.lykn_is_project_owner(p_project UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.lykn_project_members m
    WHERE m.project_id = p_project
      AND m.user_id = auth.uid()
      AND m.accepted_at IS NOT NULL
      AND m.role = 'owner'
  )
  -- Belt and suspenders: the lykn_projects.user_id IS the canonical owner,
  -- even if the backfilled member row somehow went missing.
  OR EXISTS (
    SELECT 1 FROM public.lykn_projects p
    WHERE p.id = p_project
      AND p.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.lykn_is_project_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lykn_project_can_edit(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lykn_is_project_owner(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS on the membership table itself
-- ---------------------------------------------------------------------------
-- A member sees the full roster of any project they belong to; an owner is
-- the only one who can invite, change roles, or remove people. We deliberately
-- use lykn_is_project_member / lykn_is_project_owner (SECURITY DEFINER) in the
-- USING clauses so a member reading the roster doesn't recurse on this table.
ALTER TABLE public.lykn_project_members ENABLE ROW LEVEL SECURITY;

-- Read: your own row(s), or the whole roster of a project you're a member of.
DROP POLICY IF EXISTS lykn_project_members_select ON public.lykn_project_members;
CREATE POLICY lykn_project_members_select
  ON public.lykn_project_members FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.lykn_is_project_member(project_id)
  );

-- Insert (invite): owner only.
DROP POLICY IF EXISTS lykn_project_members_insert ON public.lykn_project_members;
CREATE POLICY lykn_project_members_insert
  ON public.lykn_project_members FOR INSERT TO authenticated
  WITH CHECK (public.lykn_is_project_owner(project_id));

-- Update (change role): owner only.
DROP POLICY IF EXISTS lykn_project_members_update ON public.lykn_project_members;
CREATE POLICY lykn_project_members_update
  ON public.lykn_project_members FOR UPDATE TO authenticated
  USING (public.lykn_is_project_owner(project_id))
  WITH CHECK (public.lykn_is_project_owner(project_id));

-- Delete (revoke): the owner can remove anyone; a member can remove THEMSELVES
-- (leave the project).
DROP POLICY IF EXISTS lykn_project_members_delete ON public.lykn_project_members;
CREATE POLICY lykn_project_members_delete
  ON public.lykn_project_members FOR DELETE TO authenticated
  USING (
    public.lykn_is_project_owner(project_id)
    OR user_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 4. Seed owner rows — backfill + trigger for new projects
-- ---------------------------------------------------------------------------
-- Every existing project gets an accepted 'owner' member row so the roster UI
-- shows the owner and lykn_is_project_owner() works uniformly.
INSERT INTO public.lykn_project_members (project_id, user_id, role, invited_by, invited_at, accepted_at)
SELECT p.id, p.user_id, 'owner', p.user_id, p.created_at, p.created_at
  FROM public.lykn_projects p
 WHERE NOT EXISTS (
   SELECT 1 FROM public.lykn_project_members m
   WHERE m.project_id = p.id AND m.user_id = p.user_id
 );

-- Keep it true going forward: a freshly created project auto-seeds its owner.
CREATE OR REPLACE FUNCTION public.lykn_project_seed_owner_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.lykn_project_members (project_id, user_id, role, invited_by, accepted_at)
  VALUES (NEW.id, NEW.user_id, 'owner', NEW.user_id, now())
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_project_seed_owner ON public.lykn_projects;
CREATE TRIGGER trg_lykn_project_seed_owner
  AFTER INSERT ON public.lykn_projects
  FOR EACH ROW EXECUTE FUNCTION public.lykn_project_seed_owner_member();

-- ---------------------------------------------------------------------------
-- 5. Accept pending invites on login
-- ---------------------------------------------------------------------------
-- The app calls this once after sign-in. It matches the caller's verified
-- email against any pending (user_id IS NULL) invites and converts them into
-- real membership. SECURITY DEFINER so it can read auth.users for the email
-- and write the rows; it only ever acts on the CALLER's own identity.
CREATE OR REPLACE FUNCTION public.lykn_accept_project_invites()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_count INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 0;
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  IF v_email IS NULL OR length(trim(v_email)) = 0 THEN
    RETURN 0;
  END IF;

  -- Drop any pending email invite for a project where this user is ALREADY a
  -- member, so the upgrade below can't trip the (project_id, user_id) unique.
  DELETE FROM public.lykn_project_members d
   WHERE d.user_id IS NULL
     AND lower(d.invited_email) = lower(v_email)
     AND EXISTS (
       SELECT 1 FROM public.lykn_project_members e
       WHERE e.project_id = d.project_id AND e.user_id = v_uid
     );

  UPDATE public.lykn_project_members m
     SET user_id = v_uid,
         accepted_at = COALESCE(m.accepted_at, now())
   WHERE m.user_id IS NULL
     AND lower(m.invited_email) = lower(v_email);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lykn_accept_project_invites() TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Roster read with emails
-- ---------------------------------------------------------------------------
-- The client can't read auth.users (RLS), so it can't resolve a collaborator's
-- email from their user_id. This SECURITY DEFINER function returns the full
-- roster (accepted members + pending invites) WITH each person's email, but
-- only to callers who are themselves a member of the project.
CREATE OR REPLACE FUNCTION public.lykn_list_project_members(p_project UUID)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  email TEXT,
  role TEXT,
  invited_email TEXT,
  invited_by UUID,
  invited_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  is_self BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    m.id,
    m.user_id,
    COALESCE(u.email, m.invited_email) AS email,
    m.role,
    m.invited_email,
    m.invited_by,
    m.invited_at,
    m.accepted_at,
    (m.user_id = auth.uid()) AS is_self
  FROM public.lykn_project_members m
  LEFT JOIN auth.users u ON u.id = m.user_id
  WHERE m.project_id = p_project
    AND public.lykn_is_project_member(p_project)
  ORDER BY
    CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
    m.accepted_at NULLS LAST,
    m.invited_at;
$$;

GRANT EXECUTE ON FUNCTION public.lykn_list_project_members(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.lykn_project_members IS
  'Scoped project collaboration (109). Owner stays lykn_projects.user_id; this table adds editors/viewers + pending email invites. RLS in 110 reads it via lykn_is_project_member / _can_edit / _is_owner.';
COMMENT ON COLUMN public.lykn_project_members.user_id IS
  'The collaborator. NULL while an email invite is pending; stamped by lykn_accept_project_invites() on login.';
COMMENT ON FUNCTION public.lykn_accept_project_invites() IS
  'Called by the app after sign-in: matches the caller verified email to pending invites and converts them to accepted membership. Returns the count upgraded.';
COMMENT ON FUNCTION public.lykn_list_project_members(UUID) IS
  'Roster (accepted members + pending invites) with resolved emails, for members of the project only. SECURITY DEFINER so it can read auth.users for display.';
