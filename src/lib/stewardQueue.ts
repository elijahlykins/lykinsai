import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

export type StewardStatus =
  | "backlog"
  | "ready"
  | "scheduled"
  | "running"
  | "done"
  | "blocked"
  | "cancelled";

export type StewardExecutionKind = "research" | "code" | "agent";

export interface StewardItem {
  id: string;
  title: string;
  spec: string | null;
  status: StewardStatus;
  executionKind: StewardExecutionKind;
  repo: string | null;
  subModelId: string | null;
  resultSummary: string | null;
  blockedReason: string | null;
  approvedAt: number | null;
  source: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export const STEWARD_COLUMN_LABELS: Record<string, string> = {
  backlog: "Backlog",
  ready: "Ready",
  scheduled: "Scheduled",
  running: "Running",
  done: "Done",
  blocked: "Blocked",
};

export const EXECUTION_KIND_LABELS: Record<StewardExecutionKind, string> = {
  research: "Research",
  code: "Cursor build",
  agent: "Sub-agent",
};

function parseExecutionKind(raw: unknown): StewardExecutionKind {
  const k = String(raw || "").trim();
  if (k === "code" || k === "agent") return k;
  return "research";
}

function mapItem(r: Record<string, unknown>): StewardItem {
  return {
    id: r.id as string,
    title: (r.title as string) || "",
    spec: (r.spec as string | null) ?? null,
    status: (r.status as StewardStatus) || "backlog",
    executionKind: parseExecutionKind(r.execution_kind),
    repo: (r.repo as string | null) ?? null,
    subModelId: (r.sub_model_id as string | null) ?? null,
    resultSummary: (r.result_summary as string | null) ?? null,
    blockedReason: (r.blocked_reason as string | null) ?? null,
    approvedAt: r.approved_at ? new Date(r.approved_at as string).getTime() : null,
    source: (r.source as string | null) ?? null,
    createdAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
    updatedAt: r.updated_at ? new Date(r.updated_at as string).getTime() : Date.now(),
    completedAt: r.completed_at ? new Date(r.completed_at as string).getTime() : null,
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const sess = await supabase.auth.getSession();
  const token = sess?.data?.session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

export async function listStewardItems(
  userId: string | null | undefined,
  projectId: string,
): Promise<StewardItem[]> {
  if (!userId || !projectId) return [];
  try {
    const headers = await authHeaders();
    const res = await fetch(
      `${API_BASE_URL}/api/steward/items?project_id=${encodeURIComponent(projectId)}`,
      { headers },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.items)) return [];
    return data.items.map((r: Record<string, unknown>) => mapItem(r));
  } catch {
    return [];
  }
}

export async function createStewardItem(
  userId: string | null | undefined,
  projectId: string,
  title: string,
): Promise<StewardItem | null> {
  if (!userId || !projectId || !title.trim()) return null;
  try {
    const headers = await authHeaders();
    const res = await fetch(`${API_BASE_URL}/api/steward/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: projectId, title: title.trim().slice(0, 280) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.item) return null;
    return mapItem(data.item as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function updateStewardItem(
  userId: string | null | undefined,
  id: string,
  patch: {
    status?: StewardStatus;
    spec?: string;
    executionKind?: StewardExecutionKind;
    repo?: string | null;
    subModelId?: string | null;
  },
): Promise<StewardItem | null> {
  if (!userId || !id) return null;
  try {
    const body: Record<string, string | null> = {};
    if (patch.status) body.status = patch.status;
    if (patch.spec != null) body.spec = patch.spec;
    if (patch.executionKind) body.execution_kind = patch.executionKind;
    if (patch.repo !== undefined) body.repo = patch.repo;
    if (patch.subModelId !== undefined) body.sub_model_id = patch.subModelId;

    const headers = await authHeaders();
    const res = await fetch(`${API_BASE_URL}/api/steward/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.item) return null;
    return mapItem(data.item as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type NightShiftTier = "brief" | "research" | "delegate";

export function parseNightShiftTier(raw: unknown): NightShiftTier {
  const t = String(raw || "").trim();
  if (t === "research" || t === "delegate") return t;
  return "brief";
}
