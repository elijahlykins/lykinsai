/**
 * Maps vault `notes.source` slugs to rollup app ids for the synthesis graph.
 * Keep in sync with `connectors/` — high-volume connector sources roll up
 * to one node per app instead of one neuron per synced row.
 */
export const CONNECTOR_SOURCE_APPS: Record<string, { app: string; label: string }> = {
  gmail_starred: { app: "gmail", label: "Gmail" },
  gmail_inbox: { app: "gmail", label: "Gmail" },
  outlook_flagged: { app: "outlook", label: "Outlook" },
  notion_page: { app: "notion", label: "Notion" },
  slack_saved: { app: "slack", label: "Slack" },
  github_starred: { app: "github", label: "GitHub" },
  linear_issue: { app: "linear", label: "Linear" },
  todoist: { app: "todoist", label: "Todoist" },
  trello_card: { app: "trello", label: "Trello" },
  readwise: { app: "readwise", label: "Readwise" },
  raindrop_bookmark: { app: "raindrop", label: "Raindrop" },
  spotify_liked: { app: "spotify", label: "Spotify" },
  vimeo_liked: { app: "vimeo", label: "Vimeo" },
  youtube_liked: { app: "youtube", label: "YouTube" },
  x_bookmark: { app: "x", label: "X" },
  bluesky_like: { app: "bluesky", label: "Bluesky" },
  pinterest_pin: { app: "pinterest", label: "Pinterest" },
  lastfm_loved: { app: "lastfm", label: "Last.fm" },
  karakeep: { app: "karakeep", label: "Karakeep" },
  linkding: { app: "linkding", label: "linkding" },
  pinboard: { app: "pinboard", label: "Pinboard" },
  goodreads: { app: "goodreads", label: "Goodreads" },
  hardcover: { app: "hardcover", label: "Hardcover" },
  gcal_event: { app: "gcal", label: "Google Calendar" },
  gdrive_starred: { app: "gdrive", label: "Google Drive" },
  gdocs_starred: { app: "gdrive", label: "Google Drive" },
  gsheets_starred: { app: "gdrive", label: "Google Drive" },
  gslides_starred: { app: "gdrive", label: "Google Drive" },
};

export const CONNECTOR_SOURCES = new Set(Object.keys(CONNECTOR_SOURCE_APPS));

export function noteSourceApp(source: string | null | undefined): { app: string; label: string } | null {
  const src = String(source || "").trim();
  if (!src) return null;
  return CONNECTOR_SOURCE_APPS[src] || null;
}

export function sourceSlugsForApp(app: string): string[] {
  return Object.entries(CONNECTOR_SOURCE_APPS)
    .filter(([, meta]) => meta.app === app)
    .map(([slug]) => slug);
}

export type ConnectorRollupSummary = {
  app: string;
  label: string;
  itemCount: number;
};

/** Aggregate `{ source, count }` RPC rows into per-app rollup totals. */
export function aggregateConnectorRollupCounts(
  rows: Array<{ source: string; count: number }>,
): ConnectorRollupSummary[] {
  const byApp = new Map<string, { label: string; itemCount: number }>();
  for (const row of rows) {
    const meta = CONNECTOR_SOURCE_APPS[row.source];
    if (!meta) continue;
    const prev = byApp.get(meta.app);
    if (prev) {
      prev.itemCount += row.count;
    } else {
      byApp.set(meta.app, { label: meta.label, itemCount: row.count });
    }
  }
  return Array.from(byApp.entries())
    .map(([app, { label, itemCount }]) => ({ app, label, itemCount }))
    .sort((a, b) => b.itemCount - a.itemCount);
}
