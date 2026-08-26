// Project collaboration data layer — the member roster + email invites for a
// shared LYKN project (lykn_project_members, migration 109).
//
// Scoped sharing: a project's OWNER can invite people by email as `editor`
// (read + write the project's state / tasks / calendar) or `viewer` (read).
// Neuron clustering (lykn_project_neurons) stays personal and is NOT shared.
//
// These rows only exist for signed-in users (RLS keys off auth.uid()); there
// is no localStorage tier here. A missing userId returns empty / false.

import { supabase } from "@/lib/supabase";

export type ProjectRole = "owner" | "editor" | "viewer";

export interface ProjectMember {
  /** lykn_project_members row id. */
  id: string;
  /** auth.users id once accepted; null while an email invite is pending. */
  userId: string | null;
  /** Resolved email (auth.users.email for accepted, invited_email for pending). */
  email: string | null;
  role: ProjectRole;
  invitedEmail: string | null;
  invitedBy: string | null;
  invitedAt: number;
  /** ms timestamp once accepted; null = invite still pending. */
  acceptedAt: number | null;
  /** True when this row is the current user. */
  isSelf: boolean;
}

function mapMember(r: Record<string, unknown>): ProjectMember {
  return {
    id: r.id as string,
    userId: (r.user_id as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    role: ((r.role as string) || "viewer") as ProjectRole,
    invitedEmail: (r.invited_email as string | null) ?? null,
    invitedBy: (r.invited_by as string | null) ?? null,
    invitedAt: r.invited_at ? new Date(r.invited_at as string).getTime() : Date.now(),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at as string).getTime() : null,
    isSelf: Boolean(r.is_self),
  };
}

// ---------------------------------------------------------------------------
// Read — the full roster (accepted members + pending invites), with emails.
// ---------------------------------------------------------------------------
// Goes through the lykn_list_project_members RPC because the client can't read
// auth.users directly to resolve a collaborator's email from their user_id.
export async function listProjectMembers(
  userId: string | null | undefined,
  projectId: string,
): Promise<ProjectMember[]> {
  if (!userId || !projectId) return [];
  try {
    const { data, error } = await supabase.rpc("lykn_list_project_members", {
      p_project: projectId,
    });
    if (error) throw error;
    return (data || []).map(mapMember);
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize a free-form role string to a valid NON-owner role (default editor). */
function normalizeAssignableRole(role: string | null | undefined): "editor" | "viewer" {
  return role === "viewer" ? "viewer" : "editor";
}

export interface InviteMemberResult {
  ok: boolean;
  /**
   * What happened, for UI copy:
   *   added          — invitee already has a LYKN account; access granted NOW.
   *   invited        — no account yet; pending invite + email, claimed at sign-up.
   *   already_member — they were already on the project.
   *   already_invited — a pending invite for that email already exists.
   */
  status?: "added" | "invited" | "already_member" | "already_invited";
  /** True when the invite email actually went out. */
  emailSent?: boolean;
  /** Human-readable reason on failure, for surfacing in the UI. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Invite — owner adds a collaborator by email.
// ---------------------------------------------------------------------------
// Goes through POST /api/projects/invite, which (a) grants membership
// immediately when the email already belongs to a LYKN account (no
// sign-in-again roundtrip), and (b) sends the invitee an actual email.
// Falls back to the legacy direct insert (pending row claimed by
// lykn_accept_project_invites on login) if the API is unreachable.
export async function inviteProjectMember(
  userId: string | null | undefined,
  projectId: string,
  email: string,
  role: string = "editor",
): Promise<InviteMemberResult> {
  if (!userId || !projectId) return { ok: false, error: "Not signed in." };
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { ok: false, error: "Enter a valid email address." };

  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (token) {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/projects/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          project_id: projectId,
          email: clean,
          role: normalizeAssignableRole(role),
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        return { ok: true, status: data.status, emailSent: Boolean(data.email_sent) };
      }
      // A definitive server verdict (auth/validation) is final — only fall
      // through to the direct insert when the server itself was unreachable
      // or errored out.
      if (res.status !== 500 && data?.error) {
        return { ok: false, error: String(data.error) };
      }
    }
  } catch {
    /* network / older server — fall back to the direct insert below */
  }

  try {
    const { error } = await supabase.from("lykn_project_members").insert({
      project_id: projectId,
      invited_email: clean,
      role: normalizeAssignableRole(role),
      invited_by: userId,
    });
    if (error) {
      // 23505 = unique_violation → already invited / already a member.
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, error: "That person is already invited to this project." };
      }
      throw error;
    }
    return { ok: true, status: "invited", emailSent: false };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "Could not send the invite." };
  }
}

// ---------------------------------------------------------------------------
// Update role — owner changes a collaborator between editor / viewer.
// ---------------------------------------------------------------------------
export async function setMemberRole(
  userId: string | null | undefined,
  memberId: string,
  role: string,
): Promise<boolean> {
  if (!userId || !memberId) return false;
  try {
    const { error } = await supabase
      .from("lykn_project_members")
      .update({ role: normalizeAssignableRole(role) })
      .eq("id", memberId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Remove — owner revokes a collaborator (or a member leaves themselves).
// ---------------------------------------------------------------------------
export async function removeProjectMember(
  userId: string | null | undefined,
  memberId: string,
): Promise<boolean> {
  if (!userId || !memberId) return false;
  try {
    const { error } = await supabase
      .from("lykn_project_members")
      .delete()
      .eq("id", memberId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Accept pending invites — called once after sign-in.
// ---------------------------------------------------------------------------
// Matches the caller's verified email against any pending invites and converts
// them to membership. Returns the number of invites claimed.
export async function acceptProjectInvites(
  userId: string | null | undefined,
): Promise<number> {
  if (!userId) return 0;
  try {
    const { data, error } = await supabase.rpc("lykn_accept_project_invites");
    if (error) throw error;
    return typeof data === "number" ? data : 0;
  } catch {
    return 0;
  }
}
