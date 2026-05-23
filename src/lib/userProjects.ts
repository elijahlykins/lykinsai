// User-authored "synthesis cluster" projects — the data layer for the
// "+ → Create project" flow on the synthesis page. A project here is
// a named bag of synthesis-layer neurons the user explicitly grouped
// together, persisted into the existing `lykn_projects` table (045)
// plus a new `lykn_project_neurons` join table (063).
//
// Why we reuse `lykn_projects` instead of inventing a new container:
//   The same row in `lykn_projects` is the one the MCP server hands
//   to outside AI clients (Claude Desktop / Cursor / Claude Code /
//   ChatGPT) via `lykn_listProjects` and `lykn_getContextBlock`.
//   By writing into the same table, a project the user clusters in
//   the synthesis layer becomes immediately visible to those models
//   for free — that's the whole point of the feature ("the user can
//   see the project, the AI can see that project").
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
    return parsed.filter(
      (r): r is UserProject =>
        !!r &&
        typeof r.id === "string" &&
        typeof r.name === "string" &&
        Array.isArray((r as UserProject).members),
    );
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
      .select("id, name, description, status, created_by_client, created_at, last_active_at")
      .eq("user_id", userId)
      .order("last_active_at", { ascending: false });
    if (projErr) throw projErr;

    const ids = (projects || []).map((p) => p.id as string);
    let membersByProject = new Map<string, UserProjectMember[]>();
    if (ids.length > 0) {
      const { data: members, error: memErr } = await supabase
        .from("lykn_project_neurons")
        .select("project_id, node_id, node_label, node_kind, created_at")
        .eq("user_id", userId)
        .in("project_id", ids)
        .order("created_at", { ascending: true });
      if (memErr) throw memErr;
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

    return (projects || []).map((p) => ({
      id: p.id as string,
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      status: (p.status as "active" | "archived") || "active",
      createdByClient: (p.created_by_client as string | null) ?? null,
      createdAt: p.created_at ? new Date(p.created_at as string).getTime() : Date.now(),
      lastActiveAt: p.last_active_at ? new Date(p.last_active_at as string).getTime() : Date.now(),
      members: membersByProject.get(p.id as string) || [],
    }));
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
          created_by_client: "lykn-synthesis",
          last_active_at: new Date().toISOString(),
        })
        .select("id, name, description, status, created_by_client, created_at, last_active_at")
        .single();
      if (insErr) throw insErr;
      projectRow = inserted as typeof projectRow;
    }

    if (!projectRow) throw new Error("project upsert returned no row");

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
    // if Supabase blocked the delete.
    const local = readLocal(userId);
    const idx = local.findIndex((p) => p.id === projectId);
    if (idx === -1) return false;
    const nextMembers = local[idx].members.filter((m) => m.nodeId !== nodeId);
    local[idx] = { ...local[idx], members: nextMembers, lastActiveAt: Date.now() };
    writeLocal(userId, local);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Project state ("updates") — the AI-pushed working memory.
// ---------------------------------------------------------------------------
//
// `lykn_project_state` is the kv-store that outside AI clients
// (Claude Desktop / Cursor / Claude Code / ChatGPT) push into via
// the MCP `lykn_pushProjectState` tool. The latest non-superseded
// row at each (user_id, project_id, state_key) is the current
// value; older rows stay around for audit. The project side panel
// renders these as the "Updates" section so the user can see what
// each AI client has been telling LYKN about the project — that's
// the user-facing meaning of the project working state.

export interface ProjectStateUpdate {
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
    const { data, error } = await supabase
      .from("lykn_project_state")
      .select("state_key, state_value, set_by_client, created_at, reason")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .is("superseded_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map((r) => ({
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
