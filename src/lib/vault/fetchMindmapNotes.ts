import { supabase } from "@/lib/supabase";

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

const LIGHT_COLUMNS =
  "id, title, tags, ai_summary, ai_signals, source, created_at, updated_at";
const CONTENT_COLUMNS = "id, content";

const PAGE_SIZE = 200;
/** Safety ceiling — matches Vault tag-count fallback; Pro cap is 10k. */
const MAX_NOTES = 5000;
const CONTENT_BATCH = 100;

type NotesCursor = { updatedAt: string; id: string };

function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === "PGRST116" ||
    err.code === "42P01" ||
    Boolean(err.message?.includes("placeholder"))
  );
}

async function fetchLightPage(
  userId: string,
  cursor: NotesCursor | null,
): Promise<{ rows: MindmapNoteRow[]; error: unknown | null }> {
  let q = supabase
    .from("notes")
    .select(LIGHT_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);

  if (cursor?.updatedAt) {
    if (cursor.id) {
      q = q.or(
        `updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`,
      );
    } else {
      q = q.lt("updated_at", cursor.updatedAt);
    }
  }

  const { data, error } = await q;
  if (error) return { rows: [], error };
  return { rows: (data || []) as MindmapNoteRow[] };
}

async function attachContentBatches(
  userId: string,
  rows: MindmapNoteRow[],
  noteIds: string[],
): Promise<void> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (let i = 0; i < noteIds.length; i += CONTENT_BATCH) {
    const batch = noteIds.slice(i, i + CONTENT_BATCH);
    const { data, error } = await supabase
      .from("notes")
      .select(CONTENT_COLUMNS)
      .eq("user_id", userId)
      .in("id", batch);
    if (error) continue;
    for (const row of data || []) {
      const target = byId.get(row.id);
      if (target) target.content = row.content;
    }
  }
}

/**
 * Loads every vault note for the synthesis-layer graph. Paginates through
 * the full `notes` table (Vault does the same) instead of the old single-
 * query `.limit(300)` that silently dropped older cards from the brain.
 *
 * `content` is fetched in a second pass only for non-connector notes so
 * we can split multi-attachment rows into one neuron per vault card without
 * shipping every note body on initial load.
 */
export async function fetchMindmapNotes(userId: string): Promise<MindmapNoteRow[]> {
  if (!userId) return [];

  const all: MindmapNoteRow[] = [];
  let cursor: NotesCursor | null = null;

  while (all.length < MAX_NOTES) {
    const { rows, error } = await fetchLightPage(userId, cursor);
    if (error) {
      if (isMissingTableError(error as { code?: string; message?: string })) return [];
      throw error;
    }
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    if (!last?.updated_at) break;
    cursor = { updatedAt: last.updated_at, id: last.id };
  }

  return all.slice(0, MAX_NOTES);
}

/** Connector slugs that collapse into per-app rollup nodes in buildGraph. */
const CONNECTOR_SOURCES = new Set([
  "gmail_starred",
  "gmail_inbox",
  "outlook_flagged",
  "notion_page",
  "slack_saved",
  "github_starred",
  "linear_issue",
  "todoist",
  "trello_card",
  "readwise",
  "raindrop_bookmark",
  "spotify_liked",
  "vimeo_liked",
  "youtube_liked",
  "x_bookmark",
  "bluesky_like",
  "pinterest_pin",
  "lastfm_loved",
  "karakeep",
  "linkding",
  "pinboard",
  "goodreads",
  "hardcover",
  "gcal_event",
  "gdrive_starred",
  "gdocs_starred",
  "gsheets_starred",
  "gslides_starred",
]);

function isConnectorNote(row: MindmapNoteRow): boolean {
  const src = String(row.source || "").trim();
  return src !== "" && CONNECTOR_SOURCES.has(src);
}

/**
 * Hydrates `content` on individual (non-rollup) notes so buildGraph can
 * emit one neuron per attachment when a row backs multiple vault cards.
 */
export async function hydrateMindmapNoteContent(
  userId: string,
  rows: MindmapNoteRow[],
): Promise<MindmapNoteRow[]> {
  const ids = rows.filter((r) => !isConnectorNote(r)).map((r) => r.id);
  if (!ids.length) return rows;
  await attachContentBatches(userId, rows, ids);
  return rows;
}
