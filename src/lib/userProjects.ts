// User-authored "synthesis cluster" projects — the data layer for the
// "+ → Create project" flow on the synthesis page. A project here is
// a named bag of synthesis-layer neurons the user explicitly grouped
// together, persisted into the existing `lykn_projects` table (045)
// plus a new `lykn_project_neurons` join table (063).
//
// Why we reuse `lykn_projects` instead of inventing a new container:
//   The same row in `lykn_projects` is the one LYKN's own chat and
//   voice agent read through `lykn_listProjects` /
//   `lykn_getContextBlock`. By writing into the same table, a project
//   the user clusters in the synthesis layer is immediately visible to
//   the model for free — that's the whole point of the feature ("the
//   user can see the project, the AI can see that project").
//
// Persistence tiers — same shape as userLinks.ts:
//   1. Signed-in user, both tables present → Supabase, synced everywhere.
//   2. Signed-in user, table missing (063 not yet applied) → Supabase
//      writes fail silently; we fall back to localStorage so the UX
//      keeps working in-session.
//   3. Guest visitor → localStorage only, namespaced by user id.

import { supabase } from "@/lib/supabase";

export interface UserProjectMember {
  nodeId: string;
  label: string | null;
  kind: string | null;
}

export interface UserProject {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  createdByClient: string | null;
  createdAt: number;
  lastActiveAt: number;
  members: UserProjectMember[];
  // Total number of `lykn_pushProjectState` calls ever made against
  // this project — counts EVERY row in `lykn_project_state` for the
  // project, including superseded ones. Each row represents one push
  // event from the agent, so this is the user-facing answer to
  // "how much working memory has been written here?" The
  // "By Project" dropdown surfaces this next to the member count so
  // the user can tell at a glance which projects the AI is actively
  // pushing into vs. which ones are dormant. Defaults to 0 on the
  // localStorage / guest path (no server-side push log available).
  pushCount: number;
  // Collaboration (109/110). For projects you own these default to
  // role:'owner', isShared:false, ownerId:<you>. For a project shared WITH
  // you, role is your membership role ('editor' | 'viewer'), isShared is true,
  // and ownerId is the creator's user id. The Projects UI uses these to gate
  // owner-only controls (rename / archive / delete / manage members) and to
  // badge shared projects.
  role: "owner" | "editor" | "viewer";
  isShared: boolean;
  ownerId: string | null;
}

// ---------------------------------------------------------------------------
// localStorage tier — used for guests and signed-in fallbacks.
// ---------------------------------------------------------------------------

const LS_PREFIX = "lykn_user_projects";
function lsKey(userId: string | null | undefined): string {
  return `${LS_PREFIX}:${userId || "guest"}`;
}

function readLocal(userId: string | null | undefined): UserProject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(lsKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is UserProject =>
          !!r &&
          typeof r.id === "string" &&
          typeof r.name === "string" &&
          Array.isArray((r as UserProject).members),
      )
      .map((r) => ({
        // Backfill pushCount on rows persisted before the field
        // existed so the "By Project" dropdown can always render
        // "N pushes" without a runtime undefined check.
        ...r,
        pushCount: typeof (r as UserProject).pushCount === "number"
          ? (r as UserProject).pushCount
          : 0,
        // Collaboration fields are server-only; the local/guest tier is always
        // your own, owned project.
        role: (r as UserProject).role || "owner",
        isShared: Boolean((r as UserProject).isShared),
        ownerId: (r as UserProject).ownerId ?? null,
      }));
  } catch {
    return [];
  }
}

function writeLocal(userId: string | null | undefined, rows: UserProject[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(userId), JSON.stringify(rows));
  } catch {
    /* quota / private mode — ignore */
  }
}

function localId(prefix = "lp"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normaliseNameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

/** User-created synthesis projects only — excludes legacy AI-inferred rows. */
function isUserCreatedProjectRow(row: {
  created_by?: string | null;
  created_by_client?: string | null;
}): boolean {
  if (row.created_by === "user") return true;
  if (row.created_by === "agent") return false;
  const client = row.created_by_client;
  return !client || client === "lykn-synthesis" || client === "user";
}

// ---------------------------------------------------------------------------
// Read — every project (with members) belonging to this user.
// ---------------------------------------------------------------------------
//
// For signed-in users we first try Supabase. We deliberately fetch the
// projects + members in two queries instead of relying on a nested
// select; the join can blow up if the user has dozens of projects and
// hundreds of members, and the two-query path keeps the membership
// payload bounded by a single index hit.
export async function listUserProjects(userId: string | null | undefined): Promise<UserProject[]> {
  if (!userId) return readLocal(userId);
  try {
    const { data: projects, error: projErr } = await supabase
      .from("lykn_projects")
      .select("id, name, description, status, created_by, created_by_client, created_at, last_active_at, user_id")
      .eq("user_id", userId)
      .order("last_active_at", { ascending: false });
    if (projErr) throw projErr;

    // Collaboration (109/110): pull the projects shared WITH this user — the
    // accepted membership rows whose project they don't own — and fold them in
    // alongside the owned ones. Role drives the owner-only UI gates.
    const roleByProject = new Map<string, "owner" | "editor" | "viewer">();
    let sharedProjects: Record<string, unknown>[] = [];
    try {
      const ownedIdSet = new Set((projects || []).map((p) => p.id as string));
      const { data: memberRows } = await supabase
        .from("lykn_project_members")
        .select("project_id, role")
        .eq("user_id", userId)
        .not("accepted_at", "is", null);
      const sharedIds: string[] = [];
      for (const m of memberRows || []) {
        const pid = m.project_id as string;
        roleByProject.set(pid, (m.role as "owner" | "editor" | "viewer") || "viewer");
        if (!ownedIdSet.has(pid)) sharedIds.push(pid);
      }
      if (sharedIds.length > 0) {
        const { data: shared } = await supabase
          .from("lykn_projects")
          .select("id, name, description, status, created_by, created_by_client, created_at, last_active_at, user_id")
          .in("id", sharedIds);
        sharedProjects = shared || [];
      }
    } catch {
      /* membership tables missing (109 not applied) — owned projects only */
    }

    const userProjects = [...(projects || []), ...sharedProjects].filter(isUserCreatedProjectRow);
    const ids = userProjects.map((p) => p.id as string);
    let membersByProject = new Map<string, UserProjectMember[]>();
    let pushCountByProject = new Map<string, number>();
    if (ids.length > 0) {
      // Don't let a members/state lookup failure hide the project rows
      // themselves (AI-created projects would vanish behind localStorage).
      const { data: members, error: memErr } = await supabase
        .from("lykn_project_neurons")
        .select("project_id, node_id, node_label, node_kind, created_at")
        .eq("user_id", userId)
        .in("project_id", ids)
        .order("created_at", { ascending: true });
      if (!memErr) {
        for (const m of members || []) {
          const pid = m.project_id as string;
          const arr = membersByProject.get(pid) || [];
          arr.push({
            nodeId: m.node_id as string,
            label: (m.node_label as string | null) ?? null,
            kind: (m.node_kind as string | null) ?? null,
          });
          membersByProject.set(pid, arr);
        }
      }

      // Push counts — one row per `lykn_pushProjectState` call, ever.
      // We deliberately count ALL rows (superseded + current) because
      // a push is an event, not a value: a project with 1 stable key
      // that's been updated 12 times still represents 12 pushes worth
      // of AI working memory. Supabase-js doesn't have a group-by, so
      // we pull just the `project_id` column for every push row and
      // tally client-side. The payload is bounded by total pushes
      // across all projects, which for any single user is realistically
      // in the hundreds at most — cheap. If the table is missing
      // (045/048 not applied) we swallow and leave counts at 0; the
      // outer try/catch already handles harder failures by falling
      // back to localStorage.
      try {
        // No user_id filter: a project's push count is the project's total
        // (every member's pushes), and RLS already scopes the rows we can see
        // to our own + the shared projects we belong to.
        const { data: pushRows, error: pushErr } = await supabase
          .from("lykn_project_state")
          .select("project_id")
          .in("project_id", ids);
        if (!pushErr) {
          for (const r of pushRows || []) {
            const pid = r.project_id as string;
            pushCountByProject.set(pid, (pushCountByProject.get(pid) || 0) + 1);
          }
        }
      } catch {
        /* push log unavailable — leave counts at 0 */
      }
    }

    return userProjects.map((p) => {
      const pid = p.id as string;
      const ownerId = (p.user_id as string | null) ?? null;
      const isShared = !!ownerId && ownerId !== userId;
      const role = roleByProject.get(pid) || (isShared ? "viewer" : "owner");
      return {
        id: pid,
        name: p.name as string,
        description: (p.description as string | null) ?? null,
        status: (p.status as "active" | "archived") || "active",
        createdByClient: (p.created_by_client as string | null) ?? null,
        createdAt: p.created_at ? new Date(p.created_at as string).getTime() : Date.now(),
        lastActiveAt: p.last_active_at ? new Date(p.last_active_at as string).getTime() : Date.now(),
        members: membersByProject.get(pid) || [],
        pushCount: pushCountByProject.get(pid) || 0,
        role,
        isShared,
        ownerId,
      };
    });
  } catch {
    return readLocal(userId);
  }
}

// ---------------------------------------------------------------------------
// Write — create a project from a cluster of neurons.
// ---------------------------------------------------------------------------
//
// Two-step on the Supabase path: insert the project row, then bulk
// insert the membership rows. If the project insert hits a name_key
// collision we silently merge into the existing project instead of
// erroring — clustering the same name twice is the user saying "add
// these to my LYKN MCP project," not "make a duplicate."
//
// Empty member lists are still allowed; the project gets created with
// zero clustered neurons and the user can add them later. (Same way
// the AI-driven `setActiveProject` MCP tool works.)
export async function createUserProject(
  userId: string | null | undefined,
  args: {
    name: string;
    description?: string | null;
    members: UserProjectMember[];
    /** When set, creates a branch under this main project (GitHub-style). */
    parentProjectId?: string | null;
  },
): Promise<UserProject | null> {
  const name = args.name.trim().slice(0, 120);
  if (!name) return null;
  const description = args.description ? args.description.trim().slice(0, 320) : null;

  // Dedup the incoming members so the unique constraint doesn't fight
  // us on accidental double-clicks.
  const seen = new Set<string>();
  const cleanMembers: UserProjectMember[] = [];
  for (const m of args.members) {
    if (!m?.nodeId || seen.has(m.nodeId)) continue;
    seen.add(m.nodeId);
    cleanMembers.push({
      nodeId: m.nodeId,
      label: m.label ?? null,
      kind: m.kind ?? null,
    });
  }

  // Guest path → localStorage only.
  if (!userId) {
    const existing = readLocal(userId);
    const fresh: UserProject = {
      id: localId(),
      name,
      description,
      status: "active",
      createdByClient: "lykn-synthesis",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      members: cleanMembers,
      pushCount: 0,
      role: "owner",
      isShared: false,
      ownerId: null,
    };
    writeLocal(userId, [fresh, ...existing]);
    return fresh;
  }

  // Signed-in path: try Supabase, fall back to local on any failure
  // (table missing, RLS, network, …) so the UX never silently breaks.
  try {
    const nameKey = normaliseNameKey(name);

    // First pass: maybe a project with this name already exists. The
    // same upsert/match flow `setActiveProject` uses MCP-side, so the
    // user clustering "LYKN MCP" twice merges into one project.
    const { data: existingRow } = await supabase
      .from("lykn_projects")
      .select("id, name, description, status, created_by_client, created_at, last_active_at")
      .eq("user_id", userId)
      .eq("name_key", nameKey)
      .maybeSingle();

    let projectRow = existingRow as
      | {
          id: string;
          name: string;
          description: string | null;
          status: string;
          created_by_client: string | null;
          created_at: string;
          last_active_at: string;
        }
      | null;

    if (projectRow) {
      const patch: Record<string, unknown> = {
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (description) patch.description = description;
      if (projectRow.status === "archived") patch.status = "active";
      const { data: updated, error: updErr } = await supabase
        .from("lykn_projects")
        .update(patch)
        .eq("id", projectRow.id)
        .eq("user_id", userId)
        .select("id, name, description, status, created_by_client, created_at, last_active_at")
        .single();
      if (updErr) throw updErr;
      projectRow = updated as typeof projectRow;
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from("lykn_projects")
        .insert({
          user_id: userId,
          name,
          name_key: nameKey,
          description,
          status: "active",
          created_by: "user",
          created_by_client: "lykn-synthesis",
          parent_project_id: args.parentProjectId || null,
          last_active_at: new Date().toISOString(),
        })
        .select("id, name, description, status, created_by_client, created_at, last_active_at")
        .single();
      if (insErr) throw insErr;
      projectRow = inserted as typeof projectRow;
    }

    if (!projectRow) throw new Error("project upsert returned no row");

    // User-created projects become the synthesis focus so agents pick up
    // context immediately (like checking out the repo you just made).
    await supabase
      .from("lykn_user_synthesis_profile")
      .upsert(
        {
          user_id: userId,
          active_project_id: projectRow.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    // Membership upsert: ON CONFLICT do nothing so re-clustering with
    // the same set is idempotent. We use `upsert` with
    // `ignoreDuplicates` for the same effect on the supabase-js side.
    if (cleanMembers.length > 0) {
      const { error: memErr } = await supabase
        .from("lykn_project_neurons")
        .upsert(
          cleanMembers.map((m) => ({
            user_id: userId,
            project_id: projectRow!.id,
            node_id: m.nodeId,
            node_label: m.label,
            node_kind: m.kind,
          })),
          { onConflict: "user_id,project_id,node_id", ignoreDuplicates: true },
        );
      if (memErr) throw memErr;
    }

    // Re-read full membership so the caller gets the merged set
    // (existing rows + the ones we just upserted). Cheap — bounded
    // by the project's member count.
    const { data: members } = await supabase
      .from("lykn_project_neurons")
      .select("node_id, node_label, node_kind, created_at")
      .eq("user_id", userId)
      .eq("project_id", projectRow.id)
      .order("created_at", { ascending: true });

    // Push count — accurate on the merge path (existing project may
    // already have history). Same head-count trick `listUserProjects`
    // uses; we don't need to pull the value column for this.
    let pushCount = 0;
    try {
      const { count } = await supabase
        .from("lykn_project_state")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("project_id", projectRow.id);
      pushCount = typeof count === "number" ? count : 0;
    } catch {
      /* push log unavailable — leave at 0 */
    }

    return {
      id: projectRow.id,
      name: projectRow.name,
      description: projectRow.description,
      status: (projectRow.status as "active" | "archived") || "active",
      createdByClient: projectRow.created_by_client,
      createdAt: projectRow.created_at ? new Date(projectRow.created_at).getTime() : Date.now(),
      lastActiveAt: projectRow.last_active_at
        ? new Date(projectRow.last_active_at).getTime()
        : Date.now(),
      members: (members || []).map((m) => ({
        nodeId: m.node_id as string,
        label: (m.node_label as string | null) ?? null,
        kind: (m.node_kind as string | null) ?? null,
      })),
      pushCount,
      role: "owner",
      isShared: false,
      ownerId: userId,
    };
  } catch {
    // Fall back to local cache so the user still sees their cluster
    // even if the migration hasn't shipped or RLS blocked the write.
    const existing = readLocal(userId);
    const fresh: UserProject = {
      id: localId(),
      name,
      description,
      status: "active",
      createdByClient: "lykn-synthesis",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      members: cleanMembers,
      pushCount: 0,
      role: "owner",
      isShared: false,
      ownerId: userId,
    };
    writeLocal(userId, [fresh, ...existing]);
    return fresh;
  }
}

// ---------------------------------------------------------------------------
// Append — add neurons to an EXISTING project.
// ---------------------------------------------------------------------------
//
// The "+" → Create project flow uses `createUserProject` to either
// spawn a fresh project or merge into an existing one by name. The
// project-side-panel "Add neurons" button takes a known project_id
// and just appends membership rows. We split the call paths because:
//   • `createUserProject` is name-driven (and can re-activate an
//     archived project, write a new description, etc.). Reusing it
//     would force us to re-pass the project name from the panel,
//     which would silently rename the project if the user had
//     edited it elsewhere.
//   • Membership-only writes don't need the upsert/match dance, so
//     this path stays cheap (1 round-trip + 1 read instead of 3).
//
// Returns the full updated member list so the caller's local state
// can update without a separate re-fetch. Same localStorage fallback
// shape as `createUserProject`.
export async function addNeuronsToProject(
  userId: string | null | undefined,
  projectId: string,
  members: UserProjectMember[],
): Promise<UserProjectMember[]> {
  if (!projectId) return [];

  const seen = new Set<string>();
  const cleanMembers: UserProjectMember[] = [];
  for (const m of members) {
    if (!m?.nodeId || seen.has(m.nodeId)) continue;
    seen.add(m.nodeId);
    cleanMembers.push({
      nodeId: m.nodeId,
      label: m.label ?? null,
      kind: m.kind ?? null,
    });
  }

  // Guest path → mutate localStorage directly.
  if (!userId) {
    const local = readLocal(userId);
    const idx = local.findIndex((p) => p.id === projectId);
    if (idx === -1) return [];
    const existing = new Set(local[idx].members.map((m) => m.nodeId));
    const merged = [
      ...local[idx].members,
      ...cleanMembers.filter((m) => !existing.has(m.nodeId)),
    ];
    local[idx] = { ...local[idx], members: merged, lastActiveAt: Date.now() };
    writeLocal(userId, local);
    return merged;
  }

  try {
    if (cleanMembers.length > 0) {
      const { error: memErr } = await supabase
        .from("lykn_project_neurons")
        .upsert(
          cleanMembers.map((m) => ({
            user_id: userId,
            project_id: projectId,
            node_id: m.nodeId,
            node_label: m.label,
            node_kind: m.kind,
          })),
          { onConflict: "user_id,project_id,node_id", ignoreDuplicates: true },
        );
      if (memErr) throw memErr;

      // Bump the project's last_active_at so the "By Project" filter
      // dropdown lists this project at the top after the user adds
      // members — same heuristic the MCP listProjects tool uses.
      await supabase
        .from("lykn_projects")
        .update({
          last_active_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", projectId)
        .eq("user_id", userId);
    }

    const { data: rows } = await supabase
      .from("lykn_project_neurons")
      .select("node_id, node_label, node_kind, created_at")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    return (rows || []).map((r) => ({
      nodeId: r.node_id as string,
      label: (r.node_label as string | null) ?? null,
      kind: (r.node_kind as string | null) ?? null,
    }));
  } catch {
    // Fall back to localStorage so the user still sees the new
    // members in-session.
    const local = readLocal(userId);
    const idx = local.findIndex((p) => p.id === projectId);
    if (idx === -1) return [];
    const existing = new Set(local[idx].members.map((m) => m.nodeId));
    const merged = [
      ...local[idx].members,
      ...cleanMembers.filter((m) => !existing.has(m.nodeId)),
    ];
    local[idx] = { ...local[idx], members: merged, lastActiveAt: Date.now() };
    writeLocal(userId, local);
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Remove — drop a single neuron from a project's membership.
// ---------------------------------------------------------------------------
//
// The synthesis-layer NeuronPanel renders one "Remove from <project>"
// chip per project the focused neuron belongs to. Tapping it calls
// this function which deletes the one (project_id, node_id) row from
// `lykn_project_neurons` and bumps the project's `last_active_at` so
// it stays sorted correctly in the "By Project" dropdown.
//
// Returns `true` on success (server delete or local-storage drop) and
// `false` only when we couldn't find the membership at all — useful
// for a single retry path in the UI, even though we still self-fall-
// back to local storage on Supabase errors the same way the other
// writes here do.
export async function removeNeuronFromProject(
  userId: string | null | undefined,
  projectId: string,
  nodeId: string,
): Promise<boolean> {
  if (!projectId || !nodeId) return false;

  // Guest path → strip the entry from the localStorage row.
  if (!userId) {
    const local = readLocal(userId);
    const idx = local.findIndex((p) => p.id === projectId);
    if (idx === -1) return false;
    const before = local[idx].members.length;
    const nextMembers = local[idx].members.filter((m) => m.nodeId !== nodeId);
    if (nextMembers.length === before) return false;
    local[idx] = { ...local[idx], members: nextMembers, lastActiveAt: Date.now() };
    writeLocal(userId, local);
    return true;
  }

  try {
    const { error: delErr } = await supabase
      .from("lykn_project_neurons")
      .delete()
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("node_id", nodeId);
    if (delErr) throw delErr;

    // Mirror the bump `addNeuronsToProject` does — the project just
    // had a membership change, so it counts as "active" and should
    // float up in the project dropdown.
    await supabase
      .from("lykn_projects")
      .update({
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)
      .eq("user_id", userId);

    return true;
  } catch {
    // Best-effort localStorage parity so the panel still updates
    // if Supabase blocked the delete — but report FAILURE: the server
    // row still exists, so any refetch will resurrect the neuron and
    // a `true` here would tell the caller the remove worked.
    const local = readLocal(userId);
    const idx = local.findIndex((p) => p.id === projectId);
    if (idx !== -1) {
      const nextMembers = local[idx].members.filter((m) => m.nodeId !== nodeId);
      local[idx] = { ...local[idx], members: nextMembers, lastActiveAt: Date.now() };
      writeLocal(userId, local);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Project state ("updates") — the AI-pushed working memory.
// ---------------------------------------------------------------------------
//
// `lykn_project_state` is the kv-store the agent pushes into via the
// `lykn_pushProjectState` tool. The latest non-superseded row at each
// (user_id, project_id, state_key) is the current value; older rows
// stay around for audit. The project side panel renders these as the
// "Updates" section so the user can see what the agent has been
// telling LYKN about the project — that's the user-facing meaning of
// the project working state.
//
// `set_by_client` is historical: rows written before LYKN stopped
// exposing an MCP server can still carry an outside client's slug
// ('claude-desktop', 'cursor', …), so the UI keeps its label map for
// those. New rows are always 'LYKN'.

export interface ProjectStateUpdate {
  /** Row id in `lykn_project_state` — needed to supersede on user edit. */
  id: string;
  stateKey: string;
  value: string;
  setByClient: string | null;
  setAt: number;
  reason: string | null;
}

export async function listProjectStateUpdates(
  userId: string | null | undefined,
  projectId: string,
  limit = 24,
): Promise<ProjectStateUpdate[]> {
  if (!userId || !projectId) return [];
  try {
    // Latest current value per state_key. We sort by created_at
    // desc so the most recent decisions float to the top of the
    // panel; older context is still reachable by scrolling. The
    // LIMIT is loose — projects rarely accumulate more than a
    // dozen distinct keys, but the cap stops a runaway script
    // (which can push as many keys as it wants) from making the
    // panel scroll forever.
    // No user_id filter — membership-aware RLS (migration 110) already
    // scopes rows to projects the caller can read, and shared-project
    // collaborators must see state pushed by the owner and other members.
    // Filtering to the current user hid everyone else's updates.
    const { data, error } = await supabase
      .from("lykn_project_state")
      .select("id, state_key, state_value, set_by_client, created_at, reason")
      .eq("project_id", projectId)
      .is("superseded_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id as string,
      stateKey: r.state_key as string,
      value: r.state_value as string,
      setByClient: (r.set_by_client as string | null) ?? null,
      setAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
      reason: (r.reason as string | null) ?? null,
    }));
  } catch {
    // Table missing / RLS / network — return empty rather than
    // surfacing an error in the panel; "no updates yet" is the
    // correct UX for a brand-new project anyway.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Edit — user correction of an AI-pushed state value.
// ---------------------------------------------------------------------------
//
// Follows the table's supersession contract instead of mutating in
// place: insert a fresh row at the same state_key with
// set_by_client='user', then stamp `superseded_at` on the row being
// edited. The audit trail keeps what the AI originally said AND the
// user's correction — same shape as a contradictory push from another
// client, which is exactly what a manual edit is.
export async function editProjectStateUpdate(
  userId: string | null | undefined,
  projectId: string,
  update: { id: string; stateKey: string },
  newValue: string,
): Promise<boolean> {
  const value = newValue.trim().slice(0, 2000);
  if (!userId || !projectId || !update?.id || !value) return false;
  try {
    const { error: insErr } = await supabase.from("lykn_project_state").insert({
      user_id: userId,
      project_id: projectId,
      state_key: update.stateKey,
      state_value: value,
      set_by_client: "user",
      reason: "Edited by the user on the Projects page.",
    });
    if (insErr) throw insErr;

    const { error: supErr } = await supabase
      .from("lykn_project_state")
      .update({ superseded_at: new Date().toISOString() })
      .eq("id", update.id)
      .eq("user_id", userId);
    if (supErr) throw supErr;

    // The project was just touched by the user — float it up.
    await supabase
      .from("lykn_projects")
      .update({
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)
      .eq("user_id", userId);

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Status + focus — activate / deactivate projects, and the AI focus pointer.
// ---------------------------------------------------------------------------
//
// "Active vs archived" is the `lykn_projects.status` column: archived
// projects stop shipping in getContextBlock but keep their history.
// Separately, `lykn_user_synthesis_profile.active_project_id` is the ONE
// project the agent treats as the current focus. The Projects page
// exposes both.

export async function setUserProjectStatus(
  userId: string | null | undefined,
  projectId: string,
  status: "active" | "archived",
): Promise<boolean> {
  if (!projectId) return false;

  // Mirror into localStorage so the guest/fallback tier stays coherent.
  const local = readLocal(userId);
  const idx = local.findIndex((p) => p.id === projectId);
  if (idx !== -1) {
    local[idx] = { ...local[idx], status, lastActiveAt: Date.now() };
    writeLocal(userId, local);
  }

  if (!userId) return idx !== -1;
  try {
    const { error } = await supabase
      .from("lykn_projects")
      .update({
        status,
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)
      .eq("user_id", userId);
    if (error) throw error;
    return true;
  } catch {
    return idx !== -1;
  }
}

export async function getActiveProjectId(
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data, error } = await supabase
      .from("lykn_user_synthesis_profile")
      .select("active_project_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data?.active_project_id as string | null) ?? null;
  } catch {
    return null;
  }
}

/** Point the AI focus at `projectId`, or clear it with null. */
export async function setActiveProjectId(
  userId: string | null | undefined,
  projectId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  try {
    const { error } = await supabase
      .from("lykn_user_synthesis_profile")
      .upsert(
        {
          user_id: userId,
          active_project_id: projectId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Push events — raw timestamps for the activity chart.
// ---------------------------------------------------------------------------
//
// Unlike `listProjectStateUpdates` (latest value per key), this pulls
// EVERY push row's created_at — superseded included — because each row
// is one "an AI worked on this project" event. The Projects page bins
// these into a per-week usage chart.
export async function listProjectPushEvents(
  userId: string | null | undefined,
  projectId: string,
  limit = 500,
): Promise<number[]> {
  if (!userId || !projectId) return [];
  try {
    // Like listProjectStateUpdates: rely on RLS instead of a user_id
    // filter so a shared project's chart counts every member's pushes.
    const { data, error } = await supabase
      .from("lykn_project_state")
      .select("created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || [])
      .map((r) => (r.created_at ? new Date(r.created_at as string).getTime() : 0))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Delete — purge a project and its membership.
// ---------------------------------------------------------------------------
//
// `lykn_project_neurons` cascades on `lykn_projects.id`, so a single
// delete on the project row clears membership too. We still purge
// localStorage for the same id so the guest fallback path isn't left
// holding stale rows.
export async function deleteUserProject(
  userId: string | null | undefined,
  projectId: string,
): Promise<void> {
  const local = readLocal(userId);
  const filtered = local.filter((p) => p.id !== projectId);
  if (filtered.length !== local.length) writeLocal(userId, filtered);

  if (!userId) return;
  try {
    await supabase.from("lykn_projects").delete().eq("id", projectId).eq("user_id", userId);
  } catch {
    /* table missing / network — local already cleaned */
  }
}

// ---------------------------------------------------------------------------
// Merge — fold one project into another, atomically.
// ---------------------------------------------------------------------------
//
// Wraps the `public.lykn_merge_projects` SQL function (migration 067).
// Both phases (dry-run preview + live commit) go through the same
// PostgREST RPC; the function is SECURITY DEFINER and verifies that
// the caller owns BOTH projects before touching anything. The RPC
// also returns identical-shape JSON in both phases so the panel can
// render a "here's what will happen" preview, then re-call with the
// same arguments + `dryRun: false` to commit.
//
// Conflict resolution mirrors the migration's contract:
//   • Project state — every source row's project_id repoints to
//     target. Newer-wins supersession reconciles any state_key that
//     ends up with two non-superseded rows in target.
//   • Clustered neurons — node_ids unique to source move; node_ids
//     already in target are dropped from source (target wins).
//   • Identity facts — project_id repointed where applicable.
//   • Active focus pointer — redirected to target if it pointed at
//     source so the user's "current project" survives the merge.
//   • Source row hard-deleted at the end (cascades clean stragglers).
//
// We deliberately do NOT shadow the merge into localStorage. Guest
// users (no userId) can't merge — projects are server-side rows by
// the time merging makes sense (you need at least two real projects
// to consolidate, and guests are capped before they get there).

export interface ProjectMergePreview {
  /** True when this response was a dry-run; false when it was a commit. */
  dryRun: boolean;
  /** Source project's pre-merge identity (only present on dry-run). */
  source: {
    id: string;
    name: string | null;
    description: string | null;
  } | null;
  /** Target project's pre-merge identity (only present on dry-run). */
  target: {
    id: string;
    name: string | null;
    description: string | null;
  } | null;
  stateRowsMoved: number;
  stateKeysSupersededInTarget: number;
  neuronsMoved: number;
  neuronsDroppedAsDuplicate: number;
  factsRepointed: number;
  activeProjectPointerRepointed: boolean;
  /** Always true on commit — the source project is hard-deleted at
   *  the end of the live path. Surfaced so the UI can mirror the
   *  intent in the confirm copy ("This will delete \"X\".") */
  sourceProjectDeleted: boolean;
  /** Free-form server message — useful for showing the user the
   *  "Merged X into Y. N rows moved." summary verbatim. */
  message: string | null;
}

function readPreviewFromRpc(payload: unknown, dryRun: boolean): ProjectMergePreview {
  const obj = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const previewBlock = (
    dryRun
      ? (obj.preview as Record<string, unknown> | undefined)
      : (obj.merged as Record<string, unknown> | undefined)
  ) || {};
  const sourceBlock = (obj.source as Record<string, unknown> | undefined) || null;
  const targetBlock = (obj.target as Record<string, unknown> | undefined) || null;

  const num = (k: string): number => {
    const v = previewBlock[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const bool = (k: string): boolean => previewBlock[k] === true;

  return {
    dryRun,
    source: sourceBlock
      ? {
          id: String(sourceBlock.id ?? ""),
          name: (sourceBlock.name as string | null) ?? null,
          description: (sourceBlock.description as string | null) ?? null,
        }
      : null,
    target: targetBlock
      ? {
          id: String(targetBlock.id ?? ""),
          name: (targetBlock.name as string | null) ?? null,
          description: (targetBlock.description as string | null) ?? null,
        }
      : null,
    stateRowsMoved: num("state_rows_moved"),
    stateKeysSupersededInTarget: num(
      dryRun ? "state_keys_superseded_in_target" : "state_rows_superseded_in_target",
    ),
    neuronsMoved: num("neurons_moved"),
    neuronsDroppedAsDuplicate: num("neurons_dropped_as_duplicate"),
    factsRepointed: num("facts_repointed"),
    activeProjectPointerRepointed: bool("active_project_pointer_repointed"),
    sourceProjectDeleted: !dryRun ? true : bool("source_project_deleted"),
    message: typeof obj.message === "string" ? (obj.message as string) : null,
  };
}

export interface MergeUserProjectsOptions {
  /** When true (default) the call is a preview — counts are returned
   *  but nothing is written. Pass false to commit the merge. */
  dryRun?: boolean;
}

/**
 * Atomically fold `sourceProjectId` into `targetProjectId`. Returns
 * the count of rows moved + superseded + deduped. The first call from
 * the UI should be a dry run (default); the panel renders the preview
 * and only re-calls with `{ dryRun: false }` once the user confirms.
 *
 * Throws on any RPC error — including ownership mismatch, missing
 * source/target, or sourceProjectId === targetProjectId. The caller
 * should surface the message verbatim; the SQL function's RAISE
 * EXCEPTION strings are written to be human-readable.
 */
export async function mergeUserProjects(
  userId: string | null | undefined,
  sourceProjectId: string,
  targetProjectId: string,
  opts: MergeUserProjectsOptions = {},
): Promise<ProjectMergePreview> {
  if (!userId) {
    throw new Error("Sign in required to merge projects.");
  }
  if (!sourceProjectId || !targetProjectId) {
    throw new Error("Both source and target project ids are required.");
  }
  if (sourceProjectId === targetProjectId) {
    throw new Error("Source and target must be different projects.");
  }

  const dryRun = opts.dryRun !== false;

  // Collaboration guard (110): the merge RPC assumes single ownership, so
  // refuse to merge a project that has collaborators until merge is redesigned
  // for shared projects. Best-effort — if the helper is missing (109 not
  // applied) we fall through to the original single-owner behaviour.
  try {
    for (const id of [sourceProjectId, targetProjectId]) {
      const { data: shared } = await supabase.rpc("lykn_project_has_collaborators", {
        p_project: id,
      });
      if (shared === true) {
        throw new Error(
          "This project is shared with other people. Merging shared projects isn't supported yet. Remove collaborators first.",
        );
      }
    }
  } catch (e) {
    // Re-throw our own guard message; swallow "function does not exist" so the
    // pre-collaboration merge path keeps working.
    if (e instanceof Error && e.message.startsWith("This project is shared")) throw e;
  }

  const { data, error } = await supabase.rpc("lykn_merge_projects", {
    p_source: sourceProjectId,
    p_target: targetProjectId,
    p_dry_run: dryRun,
    // Frontend uses JWT auth, so the function resolves the caller via
    // auth.uid(). Passing p_user_id explicitly would be redundant —
    // and the function rejects mismatched p_user_id vs auth.uid() to
    // catch programming errors that try to write across accounts.
    p_user_id: null,
  });

  if (error) {
    throw new Error(error.message || "Merge failed.");
  }

  return readPreviewFromRpc(data, dryRun);
}
