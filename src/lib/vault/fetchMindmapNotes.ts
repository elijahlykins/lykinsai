import { supabase } from "@/lib/supabase";
import {
  aggregateConnectorRollupCounts,
  type ConnectorRollupSummary,
} from "@/lib/vault/connectorSources";

/** Lightweight row the 3D graph needs for vault neurons + cross-edges. */
export type MindmapNoteRow = {
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
  ai_summary?: string | null;
  ai_signals?: unknown;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type MindmapVaultGraphData = {
  /** Manual saves + perspectives — never connector-sync rows. */
  notes: MindmapNoteRow[];
  /** Accurate per-app totals for connector rollup nodes. */
  connectorRollups: ConnectorRollupSummary[];
};

const CONTENT_COLUMNS = "id, content";
const RPC_PAGE_SIZE = 200;
/** Pro vault ceiling for synthesis graph pagination. */
export const MINDMAP_MANUAL_NOTE_LIMIT = 5000;
const CONTENT_BATCH = 100;

export type HydrateMindmapNoteContentOptions = {
  /** Cap content hydration (multi-attachment fan-out). Default: all manual notes. */
  maxHydrate?: number;
};

type NotesCursor = { updatedAt: string; id: string };

function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === "PGRST116" ||
    err.code === "42P01" ||
    Boolean(err.message?.includes("placeholder"))
  );
}

function isRpcMissingError(err: { code?: string; message?: string } | null, fn: string): boolean {
  if (!err) return false;
  return (
    err.code === "PGRST202" ||
    err.code === "42883" ||
    Boolean(err.message?.includes(fn))
  );
}

async function attachContentBatch(
  userId: string,
  rows: MindmapNoteRow[],
  noteIds: string[],
): Promise<void> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { data, error } = await supabase
    .from("notes")
    .select(CONTENT_COLUMNS)
    .eq("user_id", userId)
    .in("id", noteIds);
  if (error) return;
  for (const row of data || []) {
    const target = byId.get(row.id);
    if (target) target.content = row.content;
  }
}

async function attachContentBatches(
  userId: string,
  rows: MindmapNoteRow[],
  noteIds: string[],
): Promise<void> {
  const batches: string[][] = [];
  for (let i = 0; i < noteIds.length; i += CONTENT_BATCH) {
    batches.push(noteIds.slice(i, i + CONTENT_BATCH));
  }
  await Promise.all(
    batches.map((batch) => attachContentBatch(userId, rows, batch)),
  );
}

async function fetchManualNotesRpcPage(
  cursor: NotesCursor | null,
): Promise<{ rows: MindmapNoteRow[]; error: unknown | null }> {
  const { data, error } = await supabase.rpc("vault_manual_notes_for_graph", {
    p_limit: RPC_PAGE_SIZE,
    p_cursor_updated_at: cursor?.updatedAt ?? null,
    p_cursor_id: cursor?.id ?? null,
  });
  if (error) return { rows: [], error };
  return { rows: (data || []) as MindmapNoteRow[] };
}

async function fetchManualNotesRestFallback(
  userId: string,
  cursor: NotesCursor | null,
): Promise<{ rows: MindmapNoteRow[]; error: unknown | null }> {
  let q = supabase
    .from("notes")
    .select("id, title, tags, ai_summary, ai_signals, source, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(RPC_PAGE_SIZE);

  if (cursor?.updatedAt) {
    q = q.lt("updated_at", cursor.updatedAt);
  }

  const { data, error } = await q;
  if (error) return { rows: [], error };
  const rows = ((data || []) as MindmapNoteRow[]).filter((r) => {
    const src = String(r.source || "").trim();
    return !src;
  });
  return { rows, error: null };
}

/**
 * Paginates manual + perspective notes (excludes connector sync rows).
 */
export async function fetchManualMindmapNotes(
  userId: string,
  maxNotes = MINDMAP_MANUAL_NOTE_LIMIT,
): Promise<MindmapNoteRow[]> {
  if (!userId) return [];

  const all: MindmapNoteRow[] = [];
  let cursor: NotesCursor | null = null;
  let useRpc = true;

  while (all.length < maxNotes) {
    const { rows, error } = useRpc
      ? await fetchManualNotesRpcPage(cursor)
      : await fetchManualNotesRestFallback(userId, cursor);

    if (error) {
      if (useRpc && isRpcMissingError(error as { code?: string; message?: string }, "vault_manual_notes_for_graph")) {
        console.warn(
          "[fetchMindmapNotes] vault_manual_notes_for_graph missing — apply migration 073; using REST fallback",
        );
        useRpc = false;
        continue;
      }
      if (isMissingTableError(error as { code?: string; message?: string })) return [];
      throw error;
    }

    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < RPC_PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    if (!last?.updated_at) break;
    cursor = { updatedAt: last.updated_at, id: last.id };
  }

  return all.slice(0, maxNotes);
}

export async function fetchConnectorRollupCounts(
  userId: string,
): Promise<ConnectorRollupSummary[]> {
  if (!userId) return [];

  const { data, error } = await supabase.rpc("vault_connector_source_counts");
  if (error) {
    if (isRpcMissingError(error as { code?: string; message?: string }, "vault_connector_source_counts")) {
      console.warn(
        "[fetchMindmapNotes] vault_connector_source_counts missing — apply migration 073",
      );
      return [];
    }
    throw error;
  }

  const rows = (data || []) as Array<{ source: string; count: number | string }>;
  return aggregateConnectorRollupCounts(
    rows.map((r) => ({
      source: String(r.source || ""),
      count: Number(r.count) || 0,
    })),
  );
}

/**
 * Split fetch for Synthesis: all manual/perspective notes + connector
 * rollup totals (no connector row payload on mount).
 */
export async function fetchMindmapVaultGraphData(
  userId: string,
): Promise<MindmapVaultGraphData> {
  const [notes, connectorRollups] = await Promise.all([
    fetchManualMindmapNotes(userId),
    fetchConnectorRollupCounts(userId),
  ]);
  return { notes, connectorRollups };
}

/** @deprecated Use fetchMindmapVaultGraphData. */
export async function fetchMindmapNotes(userId: string): Promise<MindmapNoteRow[]> {
  const { notes } = await fetchMindmapVaultGraphData(userId);
  return notes;
}

/**
 * Hydrates `content` on manual notes so buildGraph can emit one neuron
 * per attachment when a row backs multiple vault cards.
 */
export async function hydrateMindmapNoteContent(
  userId: string,
  rows: MindmapNoteRow[],
  options: HydrateMindmapNoteContentOptions = {},
): Promise<MindmapNoteRow[]> {
  const ids = rows.map((r) => r.id);
  const maxHydrate = options.maxHydrate ?? ids.length;
  const slice = ids.slice(0, maxHydrate);
  if (!slice.length) return rows;
  await attachContentBatches(userId, rows, slice);
  return rows;
}
