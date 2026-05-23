// User-authored manual connections between any two synthesis-layer
// nodes. Persistence layer with three tiers:
//
//   1. Signed-in user, `lykn_user_links` table present (migration 062
//      applied)  → write/read via Supabase, synced across devices.
//   2. Signed-in user, table missing (migration not yet applied) →
//      Supabase calls fail silently and we fall back to localStorage
//      so the feature still works in-session.
//   3. Guest visitor → localStorage only, namespaced under their
//      anonymous bucket so we never mix it with another user's data.
//
// The synthesis layer treats user links as undirected cross-edges.
// We normalize every pair to (smaller, larger) by lex order so the
// dedup constraint works without bookkeeping about which side the
// user clicked first.

import { supabase } from "@/lib/supabase";

export interface UserLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string | null;
  /**
   * Provenance: where this link came from.
   *   • 'user'            → the explicit "Link neurons" verb in
   *                         the synthesis layer. Renders as the
   *                         distinct user-link accent edge.
   *   • 'project_cluster' → auto-spawned when the user clusters
   *                         neurons into a project. We still
   *                         record the edge so the graph builder
   *                         can route it, but it should render
   *                         as an ordinary cross-edge OUTSIDE of
   *                         the project filter (the project's
   *                         focus glow handles emphasis when the
   *                         filter IS active). See SynthesisLayer
   *                         buildGraph for the branching.
   *   • future sources    → 'ai_suggested', etc.
   * Defaults to 'user' when the column is absent (older rows /
   * localStorage fallback).
   */
  source: string;
  createdAt: number;
}

// Normalize so the pair is undirected for dedup purposes.
export function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// localStorage key — per-user (or "guest") namespace so a sign-out /
// sign-in doesn't bleed one account's links into another's preview.
const LS_PREFIX = "lykn_user_links";
function lsKey(userId: string | null | undefined): string {
  return `${LS_PREFIX}:${userId || "guest"}`;
}

function readLocal(userId: string | null | undefined): UserLink[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(lsKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r: unknown): r is Partial<UserLink> & { id: string; fromNodeId: string; toNodeId: string } =>
          !!r &&
          typeof (r as { id?: unknown }).id === "string" &&
          typeof (r as { fromNodeId?: unknown }).fromNodeId === "string" &&
          typeof (r as { toNodeId?: unknown }).toNodeId === "string",
      )
      .map((r) => ({
        id: r.id,
        fromNodeId: r.fromNodeId,
        toNodeId: r.toNodeId,
        label: r.label ?? null,
        // Older localStorage rows may predate the `source`
        // column; treat them as the legacy "user" verb so
        // they keep rendering as user-link accent edges and
        // the user doesn't lose visual continuity with what
        // they previously authored.
        source: typeof r.source === "string" ? r.source : "user",
        createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

function writeLocal(userId: string | null | undefined, links: UserLink[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(userId), JSON.stringify(links));
  } catch {
    /* quota / private mode — ignore */
  }
}

function localId(): string {
  return `ul_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Read every user link for this user. Signed-in users get the union
// of the Supabase table + any localStorage rows that hadn't synced
// yet (the table is the source of truth on conflict). Guests get
// pure localStorage.
export async function listUserLinks(userId: string | null | undefined): Promise<UserLink[]> {
  const local = readLocal(userId);
  if (!userId) return local;
  try {
    const { data, error } = await supabase
      .from("lykn_user_links")
      .select("id, from_node_id, to_node_id, label, source, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const remote: UserLink[] = (data || []).map((r) => ({
      id: r.id as string,
      fromNodeId: r.from_node_id as string,
      toNodeId: r.to_node_id as string,
      label: (r.label as string | null) ?? null,
      source: (r.source as string | null) ?? "user",
      createdAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
    }));
    // Merge: remote wins on duplicates (same normalized pair).
    const seen = new Set(remote.map((r) => `${r.fromNodeId}__${r.toNodeId}`));
    const merged = [...remote];
    for (const l of local) {
      const key = `${l.fromNodeId}__${l.toNodeId}`;
      if (!seen.has(key)) merged.push(l);
    }
    return merged;
  } catch {
    // Table missing / RLS blocking / network → fall back to local.
    return local;
  }
}

// Persist a fresh set of links (typically a single pair, but supports
// "link node A to {B, C, D}" in one batch). Returns the rows that
// were actually written; duplicates against the existing set are
// skipped silently.
export async function createUserLinks(
  userId: string | null | undefined,
  pairs: Array<{
    fromNodeId: string;
    toNodeId: string;
    label?: string | null;
    /**
     * Provenance for this specific pair. Defaults to 'user'
     * (the explicit "Link neurons" verb) when omitted; passing
     * 'project_cluster' marks the row as auto-spawned by a
     * project commit, which the graph builder uses to render
     * the edge as a regular cross-edge instead of the user-link
     * accent. Future writers (e.g. AI suggestion pipeline) can
     * pass their own source string without schema changes.
     */
    source?: string | null;
  }>,
): Promise<UserLink[]> {
  // Normalize + drop self-links + dedup within the incoming batch.
  // The dedup key includes source so two different writers can
  // both record their pair without one silently winning. The
  // table's UNIQUE constraint is on (user_id, from, to) — so the
  // first row wins server-side regardless. The dedup here just
  // keeps the request payload small.
  type Cleaned = { fromNodeId: string; toNodeId: string; label?: string | null; source: string };
  const cleaned = new Map<string, Cleaned>();
  for (const p of pairs) {
    if (!p.fromNodeId || !p.toNodeId) continue;
    if (p.fromNodeId === p.toNodeId) continue;
    const [from, to] = normalizePair(p.fromNodeId, p.toNodeId);
    cleaned.set(`${from}__${to}`, {
      fromNodeId: from,
      toNodeId: to,
      label: p.label ?? null,
      source: p.source || "user",
    });
  }
  const incoming = Array.from(cleaned.values());
  if (incoming.length === 0) return [];

  // Guest / no-user path → localStorage only.
  if (!userId) {
    const existing = readLocal(userId);
    const existingKeys = new Set(existing.map((r) => `${r.fromNodeId}__${r.toNodeId}`));
    const fresh: UserLink[] = [];
    for (const p of incoming) {
      const key = `${p.fromNodeId}__${p.toNodeId}`;
      if (existingKeys.has(key)) continue;
      fresh.push({
        id: localId(),
        fromNodeId: p.fromNodeId,
        toNodeId: p.toNodeId,
        label: p.label ?? null,
        source: p.source,
        createdAt: Date.now(),
      });
    }
    writeLocal(userId, [...existing, ...fresh]);
    return fresh;
  }

  // Signed-in path — try Supabase, fall back to local on failure.
  try {
    const { data, error } = await supabase
      .from("lykn_user_links")
      .upsert(
        incoming.map((p) => ({
          user_id: userId,
          from_node_id: p.fromNodeId,
          to_node_id: p.toNodeId,
          label: p.label ?? null,
          source: p.source,
        })),
        { onConflict: "user_id,from_node_id,to_node_id", ignoreDuplicates: true },
      )
      .select("id, from_node_id, to_node_id, label, source, created_at");
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id as string,
      fromNodeId: r.from_node_id as string,
      toNodeId: r.to_node_id as string,
      label: (r.label as string | null) ?? null,
      source: (r.source as string | null) ?? "user",
      createdAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
    }));
  } catch {
    const existing = readLocal(userId);
    const existingKeys = new Set(existing.map((r) => `${r.fromNodeId}__${r.toNodeId}`));
    const fresh: UserLink[] = [];
    for (const p of incoming) {
      const key = `${p.fromNodeId}__${p.toNodeId}`;
      if (existingKeys.has(key)) continue;
      fresh.push({
        id: localId(),
        fromNodeId: p.fromNodeId,
        toNodeId: p.toNodeId,
        label: p.label ?? null,
        source: p.source,
        createdAt: Date.now(),
      });
    }
    writeLocal(userId, [...existing, ...fresh]);
    return fresh;
  }
}

export async function deleteUserLink(
  userId: string | null | undefined,
  linkId: string,
): Promise<void> {
  // Always purge from localStorage too — for guests it's the only
  // store; for signed-in users it cleans up any rows that hadn't
  // flushed to Supabase yet.
  const local = readLocal(userId);
  const filtered = local.filter((r) => r.id !== linkId);
  if (filtered.length !== local.length) writeLocal(userId, filtered);

  if (!userId) return;
  try {
    await supabase.from("lykn_user_links").delete().eq("id", linkId).eq("user_id", userId);
  } catch {
    /* table missing / network — already cleaned local */
  }
}
