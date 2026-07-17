import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { CONNECTORS } from "@/lib/connectors/catalog";
import { OUTBOUND_TARGETS } from "@/lib/connectors/outboundTargets";
// Same LYKN squircle the app dock renders — used as the brand mark
// on synthesis-layer notification bubbles (proposed beliefs, new
// neurons, etc.) so those groups read as "from LYKN" instead of
// borrowing a generic favicon.
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-A-Squircle/PNGs/LYKN-Icon-A-Squircle-BLUE-master.png";

/**
 * loadInUpdates — builds the "what's been happening" chat greeting LYKN
 * uses to open a fresh chat every time the user loads into `/app`.
 *
 * Replaces the retired right-side SynthesisUpdatesPanel — the
 * canonical "here's what changed" surface is now the chat itself,
 * and individual updates deep-link from the chat into their own
 * dedicated detail panels (per-belief, per-project, per-vault-note).
 * The synthesis layer no longer hosts a generic "what's new" pullout.
 *
 * Pulls from two sources and stitches them together:
 *   1. `/api/v1/synthesis/activity` — beliefs, facts, projects, rule
 *      attributions (your synthesis layer's heartbeat)
 *   2. `notes` table via Supabase — items synced in by your connector
 *      adapters (calendar events, social bookmarks, productivity tools,
 *      reading lists, etc.) keyed by their connector `source` slug
 *
 * The connector sources are bucketed into user-facing categories
 * (Calendar, Social, Productivity, Reading, Media) so the chat shows
 * a balanced cross-section of *everywhere* their day is currently
 * coming from — not just the synthesis layer.
 */

const ACTIVITY_LIMIT = 100;

type EventType =
  | "project_state"
  | "project_created"
  | "belief_active"
  | "belief_proposed"
  | "belief_other"
  | "fact_added"
  | "rule_applied";

interface ActivityEvent {
  id: string;
  type: EventType;
  when: string;
  by_client: string | null;
  summary: string;
  detail?: string | null;
  target_id?: string | null;
  target_label?: string | null;
  proposed_by_clients?: string[];
  ratified_by?: string | null;
  state_key?: string;
  serves_need?: string;
  status?: string;
}

interface ActivityResponse {
  ok: boolean;
  events: ActivityEvent[];
  count: number;
  total_seen: number;
}

const CLIENT_LABEL: Record<string, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  "claude-web": "Claude (web)",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  replit: "Replit",
  lovable: "Lovable",
  "notion-ai": "Notion AI",
  "codex-cli": "Codex CLI",
  windsurf: "Windsurf",
  jetbrains: "JetBrains AI",
  "github-copilot": "GitHub Copilot",
  perplexity: "Perplexity",
  grok: "Grok",
  zapier: "Zapier",
  elevenlabs: "ElevenLabs",
  "lykn-chat": "LYKN",
  "lykn-promotion": "LYKN synthesis",
  manual: "you",
  chatgpt: "ChatGPT",
  other: "an external AI",
};

function clientDisplay(slug: string | null | undefined): string {
  if (!slug) return "an AI";
  return CLIENT_LABEL[slug] || slug;
}

// --------------------------------------------------------------------------
// Connector source → user-facing category map
// --------------------------------------------------------------------------
// Source slugs are written by each adapter in `connectors/<name>.js` when
// it calls `saveNote(..., { source: '<slug>' })`. Grouping them into a
// handful of broad categories here lets the chat surface present
// "calendar", "social", "productivity" sections instead of one long
// flat list of connector-specific bullets that would read like a
// changelog.
//
// Keep this in sync with new adapters; sources missing from the map
// will fall through into the catch-all "other" bucket which we don't
// render — better to be silent than to leak raw slugs into the message.

type ConnectorCategory =
  | "calendar"
  | "social"
  | "productivity"
  | "reading"
  | "media"
  | "health";

const SOURCE_CATEGORY: Record<string, ConnectorCategory> = {
  // Calendar
  gcal_event: "calendar",

  // Social & content
  x_bookmark: "social",
  mastodon_bookmark: "social",
  mastodon_favourite: "social",
  bluesky_like: "social",
  youtube_liked: "social",
  dribbble_liked: "social",

  // Productivity & docs
  notion_page: "productivity",
  linear_issue: "productivity",
  trello_card: "productivity",
  todoist_task: "productivity",
  slack_saved: "productivity",
  outlook_flagged: "productivity",
  gmail_starred: "productivity",
  gmail_inbox: "productivity",
  github_starred: "productivity",
  gdocs_starred: "productivity",
  gsheets_starred: "productivity",
  gslides_starred: "productivity",
  gdrive_starred: "productivity",

  // Reading & highlights
  readwise: "reading",
  raindrop_bookmark: "reading",

  // Music, media, design
  canva_design: "media",

  // Health & activity — daily summaries from wearables and trackers
  // (sleep, recovery, workouts). Adapters write one note per daily
  // summary or recorded activity; we group by source in the bubble.
  oura_daily: "health",
  whoop_daily: "health",
  fitbit_daily: "health",
  garmin_daily: "health",
  withings_daily: "health",
  strava_activity: "health",
  apple_health: "health",
};

const SOURCE_LABEL: Record<string, string> = {
  gcal_event: "Google Calendar",
  x_bookmark: "X",
  mastodon_bookmark: "Mastodon",
  mastodon_favourite: "Mastodon",
  bluesky_like: "Bluesky",
  youtube_liked: "YouTube",
  dribbble_liked: "Dribbble",
  notion_page: "Notion",
  linear_issue: "Linear",
  trello_card: "Trello",
  todoist_task: "Todoist",
  slack_saved: "Slack",
  outlook_flagged: "Outlook",
  gmail_starred: "Gmail",
  gmail_inbox: "Gmail",
  github_starred: "GitHub",
  gdocs_starred: "Google Docs",
  gsheets_starred: "Google Sheets",
  gslides_starred: "Google Slides",
  gdrive_starred: "Google Drive",
  readwise: "Readwise",
  raindrop_bookmark: "Raindrop",
  canva_design: "Canva",
  oura_daily: "Oura",
  whoop_daily: "WHOOP",
  fitbit_daily: "Fitbit",
  garmin_daily: "Garmin",
  withings_daily: "Withings",
  strava_activity: "Strava",
  apple_health: "Apple Health",
};

function sourceLabel(source: string | null | undefined): string {
  if (!source) return "your connectors";
  return SOURCE_LABEL[source] || source;
}

// Maps a note `source` slug to the corresponding connector `id` in
// CONNECTORS catalog. Used to look up branded `iconUrl`s for the
// notification-style bubbles in connector sections so each app
// (Notion, Gmail, Slack, etc.) shows its actual brand mark.
const SOURCE_TO_CONNECTOR_ID: Record<string, string> = {
  notion_page: "notion",
  gmail_starred: "gmail",
  gmail_inbox: "gmail",
  outlook_flagged: "outlook-365",
  gdrive_starred: "google-drive",
  gdocs_starred: "google-docs",
  gsheets_starred: "google-sheets",
  gslides_starred: "google-drive",
  gcal_event: "google-calendar",
  slack_saved: "slack",
  linear_issue: "linear",
  trello_card: "trello",
  todoist_task: "todoist",
  github_starred: "github",
  x_bookmark: "x",
  mastodon_bookmark: "mastodon",
  mastodon_favourite: "mastodon",
  bluesky_like: "bluesky",
  youtube_liked: "youtube",
  dribbble_liked: "dribbble",
  readwise: "readwise",
  raindrop_bookmark: "raindrop",
  canva_design: "canva",
  oura_daily: "oura",
  whoop_daily: "whoop",
  fitbit_daily: "fitbit",
  garmin_daily: "garmin",
  withings_daily: "withings",
  strava_activity: "strava",
};

function sourceConnector(source: string) {
  const id = SOURCE_TO_CONNECTOR_ID[source];
  if (!id) return null;
  return CONNECTORS.find((c) => c.id === id) || null;
}

function sourceIconUrl(source: string): string | undefined {
  const conn = sourceConnector(source);
  if (!conn) return undefined;
  if (conn.iconUrl) return conn.iconUrl;
  if (conn.domain) {
    return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(conn.domain)}`;
  }
  return undefined;
}

// Pulls the first attachment URL out of a note's `content` field.
// Every connector adapter wraps its canonical source URL inside a
// `[ATTACHMENTS_JSON:[{...}]]` marker (see connectors/google/gmail.js,
// connectors/notion.js, etc.). We scan for that marker, decode the
// JSON, and return the first `url`. Falls back to a bare-URL regex
// so connectors that store the link as plain text still light up.
function extractItemUrl(content: string | null | undefined): string | null {
  const raw = String(content || "");
  if (!raw) return null;
  const marker = "[ATTACHMENTS_JSON:";
  const start = raw.indexOf(marker);
  if (start >= 0) {
    // Find the matching `]` that closes the JSON array. Naive but
    // safe enough — attachment payloads don't embed unbalanced
    // brackets in URL strings, and we only need the first attachment.
    const jsonStart = start + marker.length;
    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < raw.length; i++) {
      const c = raw[i];
      if (c === "[") depth += 1;
      else if (c === "]") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth -= 1;
      }
    }
    if (end > jsonStart) {
      try {
        const arr = JSON.parse(raw.slice(jsonStart, end + 1)) as Array<{
          url?: string;
        }>;
        const first = Array.isArray(arr) ? arr[0] : null;
        if (first && typeof first.url === "string" && first.url) {
          return first.url;
        }
      } catch {
        // fall through to the bare-URL fallback
      }
    }
  }
  const m = raw.match(/https?:\/\/[^\s<>")]+/);
  return m ? m[0] : null;
}

function joinClients(slugs: string[]): string {
  const labels = slugs.map(clientDisplay);
  if (labels.length <= 1) return labels[0] || "an AI";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function relativeTime(when: string): string {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

async function fetchActivity(): Promise<ActivityResponse | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || "";
    if (!token) return null;
    const res = await fetch(
      `${API_BASE_URL}/api/v1/synthesis/activity?limit=${ACTIVITY_LIMIT}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ActivityResponse;
    if (!body?.ok) return null;
    return body;
  } catch {
    return null;
  }
}

// One provenance entry per (belief, fact, source) triple as returned
// by the `get_belief_provenance` Postgres RPC. Used to render the
// "Grounded in <X>, <Y>" chip row under each proposed-belief item in
// the daily briefing. Only the fields the briefing actually consumes
// are typed here; the RPC returns a few more (fact_text, observed_at)
// that the synthesis-layer 3D graph uses but the briefing ignores.
export interface BeliefProvenanceRow {
  belief_id: string;
  fact_id: string;
  source_type: string;
  source_id: string;
  source_label: string | null;
  source_connector: string | null;
}

// One row from the concepts_moved_since RPC (058). Drives the
// "Your '<concept>' moved this week" section in the briefing. The
// RPC returns concepts that gained at least one link in the window,
// with a jsonb deltas payload counting how much landed where.
export interface ConceptsMovedRow {
  concept_id: string;
  label: string;
  kind: string;
  status: string;
  source: string;
  deltas: {
    notes?: number;
    facts?: number;
    beliefs?: number;
    chats?: number;
    latest_at?: string | null;
  } | null;
  latest_at: string | null;
}

/**
 * Pull the concepts that gained links in the last `windowHours`
 * hours via the `concepts_moved_since` RPC. Returns [] on any
 * failure path (RPC missing, RLS denial, offline) so the briefing
 * just omits the section rather than blowing up.
 */
async function fetchConceptsMovedRecently(
  windowHours = 168, // 7d default
): Promise<ConceptsMovedRow[]> {
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.rpc("concepts_moved_since", { since });
    if (error || !Array.isArray(data)) return [];
    return data as ConceptsMovedRow[];
  } catch {
    return [];
  }
}

/**
 * Resolve belief_id -> short list of "grounded in" entries for the
 * briefing chips. Returns an empty map when no belief ids are passed
 * or when the RPC fails for any reason (offline, RLS denial, the
 * migration hasn't been applied yet) — callers should treat the
 * provenance row as optional.
 */
async function fetchBeliefProvenance(
  beliefIds: string[],
): Promise<Map<string, BeliefProvenanceRow[]>> {
  const empty = new Map<string, BeliefProvenanceRow[]>();
  if (!Array.isArray(beliefIds) || beliefIds.length === 0) return empty;
  try {
    const { data, error } = await supabase.rpc("get_belief_provenance", {
      belief_ids: beliefIds,
    });
    if (error || !Array.isArray(data)) return empty;
    const m = new Map<string, BeliefProvenanceRow[]>();
    for (const raw of data as BeliefProvenanceRow[]) {
      if (!raw?.belief_id) continue;
      const arr = m.get(raw.belief_id) || [];
      arr.push(raw);
      m.set(raw.belief_id, arr);
    }
    return m;
  } catch {
    return empty;
  }
}

// --------------------------------------------------------------------------
// Connector activity fetching
// --------------------------------------------------------------------------
// Two parallel Supabase queries against the `notes` table:
//   • Upcoming calendar events — `source=gcal_event` whose `created_at`
//     (which the calendar adapter sets to the event's start time) is
//     in the next 7 days. This gives the user a real "what's on your
//     calendar" view rather than a list of historical events.
//   • Everything else recently synced — items with a source slug we
//     recognise in SOURCE_CATEGORY, ordered by `updated_at` desc.
//     `updated_at` tracks when LYKN last touched the row, so it
//     captures genuine sync activity even when the source content
//     itself is old (a 2-year-old liked YouTube video synced today
//     still surfaces as "just synced").
//
// We deliberately do NOT call the server here — RLS protects per-user
// scoping and this keeps the load-in greeting parallelisable with the
// synthesis-activity fetch (both run via Promise.all).

interface ConnectorNote {
  id: string;
  title: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  /**
   * The note body. Connector adapters embed an
   * `[ATTACHMENTS_JSON:[{...,url:"..."}]]` marker in here for every
   * synced item, which is how we recover the canonical source URL
   * (the link back to the actual Gmail email, Notion page, Slack
   * message, etc.) for the notification-bubble drop-down.
   */
  content?: string | null;
}

interface ConnectorActivity {
  /** Next ~7 days of calendar events, oldest-soonest first. */
  upcomingCalendar: ConnectorNote[];
  /** Recently-synced items bucketed by category (non-calendar). */
  byCategory: Record<ConnectorCategory, ConnectorNote[]>;
}

const CONNECTOR_LOOKBACK_HOURS = 168; // 7 days
const CALENDAR_LOOKAHEAD_DAYS = 7;
const PER_CATEGORY_FETCH_LIMIT = 60;

async function fetchConnectorActivity(): Promise<ConnectorActivity | null> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) return null;

    const nowIso = new Date().toISOString();
    const lookaheadIso = new Date(
      Date.now() + CALENDAR_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentCutoffIso = new Date(
      Date.now() - CONNECTOR_LOOKBACK_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const recognisedSources = Object.keys(SOURCE_CATEGORY).filter(
      (s) => SOURCE_CATEGORY[s] !== "calendar",
    );

    const [calendarRes, recentRes] = await Promise.allSettled([
      supabase
        .from("vault_items")
        .select("id, title, source, created_at, updated_at, content")
        .eq("user_id", userId)
        .eq("source", "gcal_event")
        .gte("created_at", nowIso)
        .lte("created_at", lookaheadIso)
        .order("created_at", { ascending: true })
        .limit(8),
      supabase
        .from("vault_items")
        .select("id, title, source, created_at, updated_at, content")
        .eq("user_id", userId)
        .in("source", recognisedSources)
        .gte("updated_at", recentCutoffIso)
        .order("updated_at", { ascending: false })
        .limit(PER_CATEGORY_FETCH_LIMIT),
    ]);

    const upcomingCalendar: ConnectorNote[] =
      calendarRes.status === "fulfilled" && Array.isArray(calendarRes.value.data)
        ? (calendarRes.value.data as ConnectorNote[])
        : [];

    const byCategory: Record<ConnectorCategory, ConnectorNote[]> = {
      calendar: [],
      social: [],
      productivity: [],
      reading: [],
      media: [],
      health: [],
    };

    if (recentRes.status === "fulfilled" && Array.isArray(recentRes.value.data)) {
      for (const row of recentRes.value.data as ConnectorNote[]) {
        const cat = SOURCE_CATEGORY[row.source];
        if (!cat) continue;
        if (cat === "calendar") continue; // handled via the upcoming query
        byCategory[cat].push(row);
      }
    }

    return { upcomingCalendar, byCategory };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Connected-providers lookup + per-category "Connect X" suggestions
// --------------------------------------------------------------------------
// When a category has nothing to show, we want to know *why*: either
// the user has the connector wired up and is just having a quiet day,
// or they've never connected anything in that lane. In the second
// case we use the empty slot to nudge them toward the connections
// page with the brand icon of a sensible default platform.
//
// `social_connections` is RLS-scoped to the user so we can query it
// directly from the client. We also infer "Google Calendar is wired
// up" from the presence of *any* `gcal_event` note (past or future),
// since GCal uses Google OAuth which doesn't always land a row in
// `social_connections` — the calendar adapter is keyed off the
// google-sso session, not the per-provider connection table.

interface ConnectorStatusMap {
  /** Set of category IDs (calendar/social/...) that have ≥1 wired connector. */
  configured: Set<ConnectorCategory>;
}

const PROVIDER_TO_CATEGORY: Record<string, ConnectorCategory> = {
  // social
  x: "social",
  twitter: "social",
  bluesky: "social",
  mastodon: "social",
  youtube: "social",
  // productivity
  notion: "productivity",
  linear: "productivity",
  trello: "productivity",
  todoist: "productivity",
  slack: "productivity",
  github: "productivity",
  gmail: "productivity",
  outlook: "productivity",
  "outlook-365": "productivity",
  "google-drive": "productivity",
  "google-docs": "productivity",
  "google-sheets": "productivity",
  // reading
  readwise: "reading",
  raindrop: "reading",
  // media
  canva: "media",
  dribbble: "media",
  // health & activity
  oura: "health",
  whoop: "health",
  fitbit: "health",
  garmin: "health",
  withings: "health",
  strava: "health",
  // calendar — Google Calendar uses google-sso so a `google-calendar`
  // provider row may or may not exist, but if it does we honour it.
  "google-calendar": "calendar",
  gcal: "calendar",
};

async function fetchConnectorStatus(): Promise<ConnectorStatusMap> {
  const configured = new Set<ConnectorCategory>();
  try {
    const { data: session } = await supabase.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) return { configured };

    const [connectionsRes, calendarProbeRes] = await Promise.allSettled([
      // Active providers in `social_connections` — RLS scopes this to
      // the current user. We treat "active" as the only status that
      // counts as "configured"; paused/errored rows still show empty
      // prompts so the user is nudged to re-auth.
      supabase
        .from("social_connections")
        .select("provider, status")
        .eq("user_id", userId)
        .eq("status", "active"),
      // Calendar inference fallback — any historical gcal_event row
      // means the GCal pipeline has run at least once, which we read
      // as "calendar is connected" even if the social_connections row
      // is missing (Google Calendar piggybacks on the SSO session).
      supabase
        .from("vault_items")
        .select("id")
        .eq("user_id", userId)
        .eq("source", "gcal_event")
        .limit(1),
    ]);

    if (
      connectionsRes.status === "fulfilled" &&
      Array.isArray(connectionsRes.value.data)
    ) {
      for (const row of connectionsRes.value.data as Array<{
        provider: string;
      }>) {
        const cat = PROVIDER_TO_CATEGORY[row.provider];
        if (cat) configured.add(cat);
      }
    }
    if (
      calendarProbeRes.status === "fulfilled" &&
      Array.isArray(calendarProbeRes.value.data) &&
      calendarProbeRes.value.data.length > 0
    ) {
      configured.add("calendar");
    }
  } catch {
    // Swallow — an empty configured set just means we'll show every
    // "Connect X" prompt, which is the safer fallback when we can't
    // tell what's already wired up.
  }
  return { configured };
}

// Per-category brand suggestion used for the empty-state "Connect X"
// prompts. We pick one "headline" platform per lane (the easiest /
// most popular one to onboard with) and use its favicon as the
// button glyph. Users can pick something different on /connections;
// the suggestion is just a starting point with a recognisable mark.

interface CategorySuggestion {
  /** Display label used in the message body and on the button. */
  platform: string;
  /** Sentence fragment used after "so LYKN can ..." */
  benefit: string;
  /** Deep-link to the connections page (anchor scrolls to card if matched). */
  href: string;
  /** Icon URL — usually a Google s2 favicon keyed off the brand domain. */
  iconUrl: string;
  /** Optional alternative platforms mentioned in prose. */
  alternates?: string[];
  /** Tone for the action button. */
  tone: NonNullable<LoadInUpdatesAction["tone"]>;
}

function faviconFor(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`;
}

const CATEGORY_SUGGESTION: Record<ConnectorCategory, CategorySuggestion> = {
  calendar: {
    platform: "Google Calendar",
    benefit: "see your schedule and plan your day with you",
    href: "/connections#google-calendar",
    iconUrl:
      "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
    tone: "emerald",
  },
  social: {
    platform: "YouTube",
    benefit: "track the videos you're liking and saving",
    href: "/connections#youtube",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
    alternates: [],
    tone: "fuchsia",
  },
  productivity: {
    platform: "Notion",
    benefit: "see what you're working on across your tools",
    href: "/connections#notion",
    iconUrl: faviconFor("notion.so"),
    alternates: ["Linear", "Slack", "Todoist"],
    tone: "primary",
  },
  reading: {
    platform: "Raindrop",
    benefit: "pick up the articles and links you're collecting",
    href: "/connections#raindrop",
    iconUrl: faviconFor("raindrop.io"),
    alternates: [],
    tone: "neutral",
  },
  media: {
    platform: "Canva",
    benefit: "fold your design picks into your daily context",
    href: "/connections#canva",
    iconUrl: faviconFor("canva.com"),
    alternates: ["Dribbble"],
    tone: "neutral",
  },
  health: {
    platform: "Oura",
    benefit: "factor your sleep, recovery, and activity into how I plan with you",
    href: "/connections#oura",
    iconUrl: faviconFor("ouraring.com"),
    alternates: ["WHOOP", "Fitbit", "Garmin", "Strava"],
    tone: "emerald",
  },
};

// --------------------------------------------------------------------------
// Connector section builders
// --------------------------------------------------------------------------

const PER_SECTION_BULLETS = 4;

function formatCalendarWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (isToday) return `Today · ${time}`;
  if (isTomorrow) return `Tomorrow · ${time}`;
  const day = d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day} · ${time}`;
}

function buildCalendarSection(events: ConnectorNote[]): string[] {
  if (events.length === 0) return [];
  return events
    .slice(0, PER_SECTION_BULLETS + 1)
    .map((e) => {
      const title = String(e.title || "(untitled event)").trim();
      return `- **${title}**: ${formatCalendarWhen(e.created_at)}`;
    });
}

// Partition the next-7-days calendar window into "today's plan" (what
// the user wants up top, conversationally) and "this week" (a softer
// roll-forward we tuck below). Returns arrays of bullet strings ready
// for splicing into the message body. Today's bullets render with a
// terser time-only format (no redundant "Today · " prefix) because the
// surrounding narrative already establishes the day.
function buildTodayAndWeekSections(events: ConnectorNote[]): {
  today: string[];
  week: string[];
} {
  const today: string[] = [];
  const week: string[] = [];
  if (events.length === 0) return { today, week };
  const now = new Date();
  const todayDateStr = now.toDateString();
  for (const e of events) {
    const t = Date.parse(e.created_at);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const title = String(e.title || "(untitled event)").trim();
    if (d.toDateString() === todayDateStr) {
      const time = d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      today.push(`- **${time}**: ${title}`);
    } else {
      week.push(`- **${title}**: ${formatCalendarWhen(e.created_at)}`);
    }
  }
  return {
    today: today.slice(0, PER_SECTION_BULLETS + 2),
    week: week.slice(0, PER_SECTION_BULLETS),
  };
}

// Time-of-day-aware salutation. Picked locally on the user's device so
// the greeting matches their wall clock regardless of which side of
// midnight UTC they happen to be on.
function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Working late";
}

function buildConnectorSection(items: ConnectorNote[]): string[] {
  if (items.length === 0) return [];
  // Group by source so we say "3 from Notion" instead of three
  // separate Notion bullets when the user has a busy connector.
  const bySource = new Map<string, ConnectorNote[]>();
  for (const item of items) {
    const arr = bySource.get(item.source) || [];
    arr.push(item);
    bySource.set(item.source, arr);
  }

  const bullets: string[] = [];
  for (const [source, group] of bySource) {
    const label = sourceLabel(source);
    if (group.length === 1) {
      const title = String(group[0].title || "(untitled)").trim();
      bullets.push(
        `- **${label}**: “${truncate(title, 64)}” · ${relativeTime(group[0].updated_at)}`,
      );
    } else {
      const newest = group[0];
      const sample = group
        .slice(0, 3)
        .map((g) => `“${truncate(String(g.title || "untitled"), 32)}”`)
        .join(", ");
      bullets.push(
        `- **${label}**: ${group.length} new items (${sample}) · ${relativeTime(newest.updated_at)}`,
      );
    }
    if (bullets.length >= PER_SECTION_BULLETS) break;
  }
  return bullets;
}

// --------------------------------------------------------------------------
// Formatter — turn activity events into a markdown chat greeting
// --------------------------------------------------------------------------
//
// Three sections, mirroring the user's request:
//   1. "Here's what's been happening"  → recent neuron / fact activity
//   2. "Awaiting your approval"        → beliefs still pending review
//   3. "Project updates"               → project_state events grouped by project
//
// Each list is capped so the bubble stays readable. If a section is
// empty we omit it; if everything is empty we return a soft fallback so
// the chat doesn't open silently with a wall of nothing.

const MAX_RECENT = 6;
const MAX_PROPOSED = 6;
const MAX_PROJECT_BULLETS = 6;
const RECENT_WINDOW_HOURS = 72;

function buildRecentSection(events: ActivityEvent[]): string[] {
  const lines: string[] = [];
  const cutoff = Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const recent = events.filter((e) => {
    const t = Date.parse(e.when);
    return Number.isFinite(t) && t >= cutoff;
  });
  const factEvents = recent.filter((e) => e.type === "fact_added").slice(0, 3);
  const beliefActive = recent
    .filter((e) => e.type === "belief_active")
    .slice(0, 3);
  const newProjects = recent
    .filter((e) => e.type === "project_created")
    .slice(0, 2);

  for (const e of newProjects) {
    const who = clientDisplay(e.by_client);
    lines.push(
      `- **New project** “${e.target_label || "Untitled"}”, created by ${who} · ${relativeTime(e.when)}`,
    );
  }
  for (const e of beliefActive) {
    const who = clientDisplay(e.by_client);
    lines.push(
      `- **New belief active**: “${e.target_label || "a new belief"}” (from ${who}) · ${relativeTime(e.when)}`,
    );
  }
  for (const e of factEvents) {
    const who = clientDisplay(e.by_client);
    lines.push(
      `- ${who === "you" ? "You added" : `${who} learned`} a new fact: “${e.target_label || "about you"}” · ${relativeTime(e.when)}`,
    );
  }
  return lines.slice(0, MAX_RECENT);
}

function buildApprovalsSection(events: ActivityEvent[]): string[] {
  const proposed = events.filter((e) => e.type === "belief_proposed");
  // Group by target so multiple clients converging on the same belief
  // get a single bullet calling out the convergence — that's the bit
  // the user most wants to know about for an approval decision.
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const e of proposed) {
    if (!e.target_id || seen.has(e.target_id)) continue;
    seen.add(e.target_id);
    const clients = Array.isArray(e.proposed_by_clients) ? e.proposed_by_clients : [];
    const text = e.target_label || "a new belief";
    if (clients.length >= 2) {
      bullets.push(
        `- **“${text}”**: ${joinClients(clients)} independently surfaced this · ${relativeTime(e.when)}`,
      );
    } else {
      const who = clientDisplay(e.by_client);
      bullets.push(
        `- **“${text}”**, proposed by ${who} · ${relativeTime(e.when)}`,
      );
    }
    if (bullets.length >= MAX_PROPOSED) break;
  }
  return bullets;
}

function buildProjectsSection(events: ActivityEvent[]): string[] {
  const byProject = new Map<
    string,
    { name: string; updates: ActivityEvent[]; created?: ActivityEvent }
  >();

  for (const e of events) {
    if (!e.target_id) continue;
    if (e.type !== "project_state" && e.type !== "project_created") continue;
    const entry = byProject.get(e.target_id) || {
      name: e.target_label || "a project",
      updates: [],
    };
    if (e.target_label) entry.name = e.target_label;
    if (e.type === "project_created") {
      entry.created = e;
    } else {
      entry.updates.push(e);
    }
    byProject.set(e.target_id, entry);
  }

  const projects = Array.from(byProject.values())
    .filter((p) => p.updates.length > 0 || p.created)
    .sort((a, b) => {
      const aNewest = a.updates[0]?.when || a.created?.when || "";
      const bNewest = b.updates[0]?.when || b.created?.when || "";
      return Date.parse(bNewest) - Date.parse(aNewest);
    })
    .slice(0, MAX_PROJECT_BULLETS);

  const lines: string[] = [];
  for (const p of projects) {
    if (p.created && p.updates.length === 0) {
      const who = clientDisplay(p.created.by_client);
      lines.push(
        `- **${p.name}**, newly created by ${who} · ${relativeTime(p.created.when)}`,
      );
      continue;
    }
    const newest = p.updates[0];
    const who = clientDisplay(newest?.by_client);
    const count = p.updates.length;
    const verb = count === 1 ? "update" : "updates";
    lines.push(
      `- **${p.name}**: ${count} ${verb} (latest from ${who}) · ${relativeTime(newest.when)}`,
    );
  }
  return lines;
}

interface BuildOptions {
  /** Optional display name for the greeting line ("Welcome back, Eli."). */
  greetingName?: string | null;
}

export interface LoadInUpdatesAction {
  /** Short button label, e.g. "Open Synthesis Layer". */
  label: string;
  /** Internal route (starts with `/`) or absolute URL. */
  href: string;
  /** Optional one-line subtext rendered under the label. */
  description?: string;
  /** Tone hint for the chat renderer. */
  tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
  /**
   * Optional remote icon to render in place of the default arrow glyph.
   * Used by the "Connect <Platform>" prompts so each suggested
   * connector shows its actual brand mark (Google Calendar, Notion,
   * Bluesky, etc.) — same favicon strategy as the ConnectionsAppGrid.
   */
  iconUrl?: string;
}

/**
 * A single row inside a load-in section. The renderer lays each item
 * out as a flex row: title (+ subtitle) on the left, optional CTA
 * button on the right. When `action` is absent the row is read-only.
 */
export interface LoadInUpdatesItem {
  title: string;
  subtitle?: string;
  action?: LoadInUpdatesAction;
  /**
   * Optional leading thumbnail URL (rendered as a small square to
   * the left of the title) — used by the Project Updates section to
   * surface the AI app that made the latest move (Claude, Cursor,
   * ChatGPT, etc.) so the user can see at a glance "this was the
   * Claude thread I had open last night".
   */
  iconUrl?: string;
}

/**
 * A logical group of updates rendered with a heading and (optional)
 * intro line. The renderer iterates `items` underneath. Sections
 * with zero items are filtered out before being returned to the
 * caller so the chat never shows an empty heading.
 */
/**
 * A "notification bubble" for a single connector source within a
 * section. Renders collapsed as a row showing the app's branded logo
 * + label + count + latest update; on click it expands inline to
 * reveal the underlying items, each linking out to its canonical
 * source URL (the actual Gmail email, Notion page, etc.).
 */
/**
 * One row inside a notification bubble (LoadInUpdatesGroup.items).
 *
 * `provenance` is a small ordered list of "grounded in <X>" chips the
 * renderer shows under the title so the user can see, at a glance, the
 * source notes/boards/chats this row traces back to — and click straight
 * into them. Today it's populated only for proposed-belief rows
 * (powered by the `get_belief_provenance` RPC), but the field is shape-
 * compatible with any future row that wants to surface receipts
 * (newly-learned facts, activated rules, etc.).
 *
 * Older cached briefings won't carry `provenance`; the renderer must
 * handle the field being absent without breaking.
 */
export interface LoadInUpdatesGroupItem {
  id: string;
  title: string;
  subtitle?: string;
  href?: string;
  /**
   * Up to ~3 grounding chips. Each chip should deep-link into the
   * source surface (vault note, calendar event, external URL) so the
   * "this came from these things you saw this week" promise is one
   * click away.
   */
  provenance?: Array<{
    /** Stable id used as React key — usually the source row id. */
    id: string;
    /** Short, branded label, e.g. "Notion: Sprint plan" or "Gmail: Re: launch". */
    label: string;
    /** Internal route (starts with `/`) or absolute URL the chip navigates to. */
    href?: string;
    /**
     * Catalog connector id (`notion`, `gmail`, …) when we recognize the
     * source's `notes.source` slug. Lets the renderer attach the right
     * brand mark / favicon instead of a generic chip face.
     */
    connectorId?: string;
  }>;
}

export interface LoadInUpdatesGroup {
  /** Stable id, typically the source slug. */
  id: string;
  /** Display label for the source — "Gmail", "Notion", etc. */
  label: string;
  /** Brand-mark URL, when known. */
  iconUrl?: string;
  /** Fallback domain for favicon lookup when `iconUrl` isn't set. */
  domain?: string;
  /** Number of items in this group. */
  count: number;
  /** Title of the most-recently-synced item, shown as the bubble preview. */
  latestTitle?: string;
  /** Relative time for the most-recently-synced item ("2h ago"). */
  latestRelative?: string;
  /** Individual items revealed when the bubble expands. */
  items: LoadInUpdatesGroupItem[];
}

export interface LoadInUpdatesSection {
  /** Stable id used as a React key. */
  id: string;
  /** Heading row text, e.g. "On your calendar today". */
  heading: string;
  /** Optional one-line lead-in rendered under the heading. */
  intro?: string;
  /** Rows under this section. */
  items: LoadInUpdatesItem[];
  /**
   * When set, the section is rendered as a prose paragraph instead of
   * a list of `items` rows. Used for narrative recaps like
   * "What we've been working on" where individual clickable rows
   * would feel like clutter — the user just wants a brief written
   * summary of recent activity.
   */
  summary?: string;
  /**
   * When set, the section renders as a stack of iPhone-style
   * notification bubbles — one per source app. Each bubble shows
   * the app's logo + a brief "what just landed" line and expands to
   * a list of the underlying items, each linking back to its
   * canonical source URL. Used by the connector-category sections
   * (productivity, social, reading, media).
   */
  groups?: LoadInUpdatesGroup[];
  /**
   * When set, the section renders as a compact grid of icon-only
   * brand chips — one per recommended app. Tapping a chip routes to
   * the connect page anchored to that platform's tile. Used by the
   * "Connect the rest" lane where the user just needs to see *which
   * apps* are available and pick one, not a verbose pitch per row.
   */
  chips?: LoadInUpdatesChip[];
  /**
   * Flags a user-authored section (rows from `lykn_load_in_user_sections`)
   * so the renderer can attach edit / delete affordances. Auto-built
   * sections leave this undefined.
   */
  userSectionId?: string;
}

/**
 * Compact icon-only recommendation chip rendered inside a section's
 * `chips` grid. Carries the app's brand mark and a one-word label so
 * the user can scan a row of suggested integrations the way they'd
 * scan their phone's home screen.
 */
export interface LoadInUpdatesChip {
  /** Stable id used as React key + the `#anchor` on the connect page. */
  id: string;
  /** Short app name shown under the icon, e.g. "Notion" or "Slack". */
  label: string;
  /** Brand favicon / logo URL for the chip face. */
  iconUrl: string;
  /** Deep-link to the connections page (anchor scrolls to that tile). */
  href: string;
  /** Optional accent colour for the chip frame on hover. */
  tone?: NonNullable<LoadInUpdatesAction["tone"]>;
}

/**
 * Aggregated counts and series rolled up across every lane in the
 * briefing — fed into the at-a-glance dashboard panel that renders to
 * the right of the welcome bubble. We pre-compute on the server-side
 * fetch path so the renderer never has to walk the (potentially
 * large) sections tree just to draw a sparkline.
 */
export interface LoadInUpdatesStats {
  /** Calendar events scheduled for today. */
  calendarToday: number;
  /** Calendar events scheduled for the rest of this week. */
  calendarWeek: number;
  /** Per-lane item counts driving the distribution bar / donut. */
  byCategory: {
    social: number;
    productivity: number;
    reading: number;
    media: number;
    health: number;
  };
  /** Synthesis approvals broken down so the panel can colour them. */
  approvals: {
    proposedBeliefs: number;
    activeBeliefs: number;
    newFacts: number;
  };
  /** Number of distinct projects with new activity in the recap. */
  projects: number;
  /** Total synthesis-layer changes in the recap window. */
  synthesisChanges: number;
  /**
   * Daily activity series for the past 7 days — one bucket per day,
   * oldest first, with the count of *anything* that landed (notes,
   * synthesis events, calendar events authored today). Drives the
   * sparkline in the side panel.
   */
  series: Array<{
    /** ISO date (YYYY-MM-DD) for the bucket — used as React key. */
    date: string;
    /** Total event count in that day's bucket. */
    count: number;
  }>;
  /** Convenience total — sum of every lane plus approvals + synthesis. */
  totalUpdates: number;
}

export interface LoadInUpdatesPayload {
  /** Short welcome line for the top of the assistant bubble. */
  message: string;
  /**
   * Structured sections: a heading per topic, with each update
   * appearing as a row beneath alongside an optional CTA button
   * that deep-links into the relevant surface ("Open", "Review",
   * "Connect"). This is the canonical shape consumed by the chat
   * renderer.
   */
  sections: LoadInUpdatesSection[];
  /**
   * Legacy flat action list (kept for backwards compatibility with
   * any caller that still reads `actions` directly). Mirrors the
   * per-item actions in `sections` plus any section-level CTAs.
   */
  actions: LoadInUpdatesAction[];
  /** Counts so the caller can decide whether to skip seeding if empty. */
  hasContent: boolean;
  /**
   * Roll-up counts and a 7-day activity series, rendered as a small
   * dashboard panel ("Today's briefing") to the right of the welcome
   * bubble. Always present so the panel can render even when the
   * briefing itself is mostly empty (it doubles as a "you're caught
   * up" affirmation when everything is at zero).
   */
  stats: LoadInUpdatesStats;
}

// Collect the IDs and labels we need to wire up action buttons, so the
// formatter and the action builder don't have to recompute the same
// groupings twice.
interface SectionData {
  recent: string[];
  approvals: string[];
  projects: string[];
  topApprovalIds: Array<{ id: string; label: string }>;
  topProjects: Array<{ id: string; name: string }>;
}

function collectSections(events: ActivityEvent[]): SectionData {
  const recent = buildRecentSection(events);
  const approvals = buildApprovalsSection(events);
  const projects = buildProjectsSection(events);

  const proposedSeen = new Set<string>();
  const topApprovalIds: Array<{ id: string; label: string }> = [];
  for (const e of events) {
    if (e.type !== "belief_proposed") continue;
    if (!e.target_id || proposedSeen.has(e.target_id)) continue;
    proposedSeen.add(e.target_id);
    topApprovalIds.push({ id: e.target_id, label: e.target_label || "a new belief" });
    if (topApprovalIds.length >= 3) break;
  }

  const projectSeen = new Set<string>();
  const topProjects: Array<{ id: string; name: string }> = [];
  // Order: most-recently-touched project_state / project_created.
  const projectEvents = events.filter(
    (e) => e.type === "project_state" || e.type === "project_created",
  );
  for (const e of projectEvents) {
    if (!e.target_id || projectSeen.has(e.target_id)) continue;
    projectSeen.add(e.target_id);
    topProjects.push({ id: e.target_id, name: e.target_label || "a project" });
    if (topProjects.length >= 3) break;
  }

  return { recent, approvals, projects, topApprovalIds, topProjects };
}

function buildActions(
  sections: SectionData,
  connector: ConnectorActivity | null,
  unconfigured: ConnectorCategory[] = [],
): LoadInUpdatesAction[] {
  const actions: LoadInUpdatesAction[] = [];

  // Approvals — one button per pending belief (capped at 2 here so we
  // don't crowd out the category buttons below). Routes to the
  // synthesis layer with `?focus=belief_<id>`, which selects the
  // node and opens its dedicated DetailPanel — the panel specific to
  // that one belief, not the generic "what's new" pullout.
  for (const a of sections.topApprovalIds.slice(0, 2)) {
    actions.push({
      label: `Review “${truncate(a.label, 40)}”`,
      href: `/synthesis-layer?focus=belief_${encodeURIComponent(a.id)}`,
      description: "Approve or dismiss this belief",
      tone: "amber",
    });
  }

  // Projects — one button per recently-touched project (capped at 2).
  // The dedicated /project/:id route isn't wired into the router yet,
  // so we deep-link into the synthesis layer with the project node
  // focused. From there the user can jump into the project's grids /
  // notes / chats via the detail panel's "Open project →" affordance.
  for (const p of sections.topProjects.slice(0, 2)) {
    actions.push({
      label: `Open ${truncate(p.name, 32)}`,
      href: `/synthesis-layer?focus=project_${encodeURIComponent(p.id)}`,
      description: "Jump to this project",
      tone: "fuchsia",
    });
  }

  // Category buttons — one per connector category that has either
  // upcoming-calendar content or recently-synced content. These deep-
  // link into the vault since the vault is where the synced items live
  // (calendar events, X bookmarks, Notion pages, etc. all become
  // notes). The category routing happens via the `?category=` query
  // param so the vault can pre-filter on mount.
  if (connector) {
    if (connector.upcomingCalendar.length > 0) {
      const count = connector.upcomingCalendar.length;
      actions.push({
        label: "Open your calendar",
        href: "/vault?category=calendar",
        description: `${count} upcoming event${count === 1 ? "" : "s"}`,
        tone: "emerald",
      });
    }
    const socialCount = connector.byCategory.social.length;
    if (socialCount > 0) {
      actions.push({
        label: "Open social",
        href: "/vault?category=social",
        description: `${socialCount} new social item${socialCount === 1 ? "" : "s"}`,
        tone: "fuchsia",
      });
    }
    const productivityCount = connector.byCategory.productivity.length;
    if (productivityCount > 0) {
      actions.push({
        label: "Open productivity",
        href: "/vault?category=productivity",
        description: `${productivityCount} new item${productivityCount === 1 ? "" : "s"} from your tools`,
        tone: "primary",
      });
    }
    const readingCount = connector.byCategory.reading.length;
    if (readingCount > 0) {
      actions.push({
        label: "Open reading",
        href: "/vault?category=reading",
        description: `${readingCount} new article${readingCount === 1 ? "" : "s"} or highlight${readingCount === 1 ? "" : "s"}`,
        tone: "neutral",
      });
    }
    const mediaCount = connector.byCategory.media.length;
    if (mediaCount > 0) {
      actions.push({
        label: "Open media",
        href: "/vault?category=media",
        description: `${mediaCount} new music / design item${mediaCount === 1 ? "" : "s"}`,
        tone: "neutral",
      });
    }
  }

  // "Connect <Platform>" prompts — one button per category the user
  // has neither populated nor configured. The button glyph is the
  // platform's brand favicon (rendered as <img>) instead of the
  // default arrow, so the chat surfaces a recognisable mark for each
  // suggestion. We cap at 4 to keep the button strip from sprawling
  // when a brand-new user lands with nothing wired up at all.
  for (const cat of unconfigured.slice(0, 4)) {
    const sug = CATEGORY_SUGGESTION[cat];
    actions.push({
      label: `Connect ${sug.platform}`,
      href: sug.href,
      description: `So LYKN can ${sug.benefit}`,
      tone: sug.tone,
      iconUrl: sug.iconUrl,
    });
  }

  // Catch-all fallback — synthesis layer if nothing else above
  // anchored a destination. We deep-link straight to the layer
  // itself; there is no longer a "what's new" panel to pop open
  // (the chat *is* the what's-new surface, and individual updates
  // route to their own dedicated detail panels via `?focus=<id>`).
  if (actions.length === 0) {
    actions.push({
      label: "Open Synthesis Layer",
      href: "/synthesis-layer",
      description: "See every recent update and neuron",
      tone: "primary",
    });
  }

  return actions;
}

function truncate(s: string, max: number): string {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

// ----------------------------------------------------------------------
// Structured section builder
// ----------------------------------------------------------------------
// The chat opening is rendered as a short welcome line + a list of
// topic sections, each with its own heading and a row per update.
// Every row that has a sensible destination carries a CTA button
// inline — "Open" for vault folders / project nodes, "Review" for
// pending approvals, "Connect" for unconfigured platforms — so the
// user can act on any individual update without scanning to a
// separate strip of buttons at the bottom of the bubble.
//
// Section order — modeled on how a personal assistant would lay out
// your day:
//   1. On your calendar today
//   2. This week ahead
//   3. What we've been working on (projects + synthesis activity)
//   4. From social / productivity / reading / media (one section
//      each, only when populated)
//   5. Awaiting your approval
//   6. Connect the rest (unconfigured lanes)
function formatTimeOnly(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ----------------------------------------------------------------------
// Today's docket — the user's OWN in-app schedule + task list for today,
// pulled straight from `lykn_events` and `lykn_todos` (the rows the
// Projects/Tasks workspace and the AI todo/calendar tools write). This is
// distinct from the connector "On your calendar" lane above (which mirrors
// Google Calendar): the docket is what LYKN itself is tracking for you,
// so it's the first thing the load-in greeting shows.
// ----------------------------------------------------------------------
interface DocketEvent {
  id: string;
  title: string;
  startsAt: number;
  allDay: boolean;
  location: string | null;
  projectId: string | null;
}
interface DocketTask {
  id: string;
  title: string;
  dueAt: number | null;
  priority: string;
  projectId: string | null;
}
export interface TodayDocket {
  events: DocketEvent[];
  dueToday: DocketTask[];
  overdue: DocketTask[];
  projectNames: Record<string, string>;
  /**
   * True when the fetch failed (network / RLS / outage). Lets consumers
   * distinguish "nothing scheduled today" from "we couldn't load your day"
   * — showing "all clear" during an outage hides overdue work.
   */
  error?: boolean;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Pull the user's own events + tasks that matter TODAY. RLS on both
 * tables scopes the result to rows the signed-in user can read, so no
 * explicit user filter is needed. Best-effort: any failure returns an
 * empty docket so the greeting still renders.
 */
export async function fetchTodayDocket(): Promise<TodayDocket> {
  const empty: TodayDocket = { events: [], dueToday: [], overdue: [], projectNames: {} };
  try {
    const start = startOfToday();
    const end = endOfToday();
    const [eventsRes, tasksRes] = await Promise.all([
      supabase
        .from("lykn_events")
        .select("id, title, starts_at, all_day, location, project_id, status")
        .neq("status", "cancelled")
        .gte("starts_at", new Date(start).toISOString())
        .lte("starts_at", new Date(end).toISOString())
        .order("starts_at", { ascending: true })
        .limit(20),
      supabase
        .from("lykn_todos")
        .select("id, title, due_at, priority, project_id, status")
        .eq("status", "open")
        .not("due_at", "is", null)
        .lte("due_at", new Date(end).toISOString())
        .order("due_at", { ascending: true })
        .limit(30),
    ]);

    // Supabase surfaces failures on the result object rather than
    // throwing — treat either query erroring as a failed docket load.
    if (eventsRes.error || tasksRes.error) {
      return { ...empty, error: true };
    }

    const events: DocketEvent[] = (eventsRes.data || []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      title: ((r.title as string) || "").trim() || "(untitled event)",
      startsAt: r.starts_at ? new Date(r.starts_at as string).getTime() : start,
      allDay: Boolean(r.all_day),
      location: (r.location as string | null) ?? null,
      projectId: (r.project_id as string | null) ?? null,
    }));

    const dueToday: DocketTask[] = [];
    const overdue: DocketTask[] = [];
    for (const r of (tasksRes.data || []) as Record<string, unknown>[]) {
      const dueAt = r.due_at ? new Date(r.due_at as string).getTime() : null;
      const task: DocketTask = {
        id: r.id as string,
        title: ((r.title as string) || "").trim() || "(untitled task)",
        dueAt,
        priority: (r.priority as string) || "normal",
        projectId: (r.project_id as string | null) ?? null,
      };
      if (dueAt != null && dueAt < start) overdue.push(task);
      else dueToday.push(task);
    }

    // Resolve project names for any referenced projects so rows read
    // "Ship v2 · Launch" rather than a bare uuid.
    const projectIds = Array.from(
      new Set(
        [...events, ...dueToday, ...overdue]
          .map((x) => x.projectId)
          .filter((id): id is string => !!id),
      ),
    );
    const projectNames: Record<string, string> = {};
    if (projectIds.length > 0) {
      const { data: projRows } = await supabase
        .from("lykn_projects")
        .select("id, name")
        .in("id", projectIds);
      for (const p of (projRows || []) as Record<string, unknown>[]) {
        projectNames[p.id as string] = ((p.name as string) || "").trim() || "Project";
      }
    }

    return { events, dueToday, overdue, projectNames };
  } catch {
    return { ...empty, error: true };
  }
}

function docketWhen(task: DocketTask): string {
  if (task.dueAt == null) return "";
  const d = new Date(task.dueAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function eventWhen(ev: DocketEvent): string {
  if (ev.allDay) return "All day";
  const d = new Date(ev.startsAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The "Today's docket" section — the user's own events + tasks for the
 * day, each row deep-linking into its project (or the projects index).
 * Returns null when there's nothing on the plate so the greeting can
 * skip an empty heading.
 */
function buildTodayDocketSection(docket: TodayDocket | null): LoadInUpdatesSection | null {
  if (!docket) return null;
  const { events, dueToday, overdue, projectNames } = docket;
  if (events.length === 0 && dueToday.length === 0 && overdue.length === 0) {
    return null;
  }

  const projectSub = (projectId: string | null): string | undefined =>
    projectId && projectNames[projectId] ? projectNames[projectId] : undefined;
  const openAction = (projectId: string | null): LoadInUpdatesAction => ({
    label: "Open",
    href: projectId ? `/projects/${projectId}` : "/projects",
    tone: "primary",
  });

  const items: LoadInUpdatesItem[] = [];

  // Events first, in start-time order.
  for (const ev of events.slice(0, 6)) {
    const parts = [eventWhen(ev)];
    if (ev.location) parts.push(ev.location);
    const proj = projectSub(ev.projectId);
    if (proj) parts.push(proj);
    items.push({
      title: ev.title,
      subtitle: parts.filter(Boolean).join(" · "),
      action: openAction(ev.projectId),
    });
  }

  // Overdue tasks next (they need attention most), then due-today.
  for (const t of overdue.slice(0, 5)) {
    const proj = projectSub(t.projectId);
    items.push({
      title: t.title,
      subtitle: `Overdue${docketWhen(t) ? ` · was due ${docketWhen(t)}` : ""}${proj ? ` · ${proj}` : ""}`,
      action: { ...openAction(t.projectId), tone: "amber" },
    });
  }
  for (const t of dueToday.slice(0, 6)) {
    const proj = projectSub(t.projectId);
    const bits = ["Due today"];
    if (t.priority === "high") bits.push("High priority");
    if (proj) bits.push(proj);
    items.push({
      title: t.title,
      subtitle: bits.join(" · "),
      action: openAction(t.projectId),
    });
  }

  // One-line summary of the whole plate.
  const summaryParts: string[] = [];
  if (events.length > 0) summaryParts.push(`${events.length} event${events.length === 1 ? "" : "s"}`);
  const taskTotal = dueToday.length + overdue.length;
  if (taskTotal > 0) summaryParts.push(`${taskTotal} task${taskTotal === 1 ? "" : "s"}`);
  if (overdue.length > 0) summaryParts.push(`${overdue.length} overdue`);

  return {
    id: "today-docket",
    heading: "On your plate today",
    intro: summaryParts.length ? `${summaryParts.join(" · ")}.` : undefined,
    items,
  };
}

function buildTodaySection(
  events: ConnectorNote[],
  calendarConfigured: boolean,
): LoadInUpdatesSection | null {
  const todayStr = new Date().toDateString();
  const today = events.filter((e) => {
    const t = Date.parse(e.created_at);
    if (!Number.isFinite(t)) return false;
    return new Date(t).toDateString() === todayStr;
  });

  // The calendar lane is a permanent fixture at the top of the
  // briefing — it should never disappear from the chat, even when
  // the user has a clear schedule or hasn't wired Google Calendar
  // up yet. We render one of three states:
  //
  //   1. Not connected → "Connect Google Calendar" prompt with
  //      the GCal brand mark on the action button.
  //   2. Connected, empty schedule → a quiet "nothing on the books"
  //      state so the user knows the lane is healthy and just
  //      idle today.
  //   3. Connected, has events → up to six rows linking into the
  //      calendar view in the vault.
  const GCAL_ICON =
    "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png";

  if (!calendarConfigured) {
    const sug = CATEGORY_SUGGESTION.calendar;
    return {
      id: "calendar",
      heading: "On your calendar",
      intro:
        "I can't see your calendar yet. Connect Google Calendar and I'll fold today's schedule in here.",
      items: [
        {
          title: sug.platform,
          subtitle: `So LYKN can ${sug.benefit}.`,
          iconUrl: sug.iconUrl,
          action: {
            label: `Connect ${sug.platform}`,
            href: sug.href,
            tone: sug.tone,
            iconUrl: sug.iconUrl,
          },
        },
      ],
    };
  }

  // Compose the full upcoming-events list (today + later this week)
  // into a single time-sorted feed for the bubble's drop-down. Each
  // row is one calendar event with its title, when, and a link
  // straight into Google Calendar so the user can pop the event open
  // in one click.
  const upcoming = [...events].sort(
    (a, b) => Date.parse(a.created_at || "") - Date.parse(b.created_at || ""),
  );
  if (upcoming.length === 0) {
    return {
      id: "calendar",
      heading: "On your calendar",
      intro: "Nothing on the books. Your day is clear.",
      items: [
        {
          title: "Open Calendar",
          subtitle: "Look ahead at the rest of the week.",
          iconUrl: GCAL_ICON,
          action: {
            label: "Open",
            href: "https://calendar.google.com/",
            tone: "emerald",
            iconUrl: GCAL_ICON,
          },
        },
      ],
    };
  }

  const todayCount = today.length;
  const latest = upcoming[0];
  // Latest preview text picks the soonest event so the bubble reads
  // like "Standup with team — Today · 9:00 AM" even before the
  // drop-down opens. The relative-time slot reuses the smarter
  // formatter so "Today · 2pm" and "Tomorrow · 9am" both come out
  // right.
  const groupItems = upcoming.slice(0, 12).map((e) => ({
    id: e.id,
    title: String(e.title || "(untitled event)").trim() || "(untitled event)",
    subtitle: formatCalendarWhen(e.created_at),
    href: extractItemUrl(e.content) || "https://calendar.google.com/",
  }));

  const weekCount = upcoming.length - todayCount;
  const introParts: string[] = [];
  if (todayCount === 0) {
    introParts.push("Nothing today");
  } else if (todayCount === 1) {
    introParts.push("1 thing on your schedule today");
  } else {
    introParts.push(`${todayCount} things on your schedule today`);
  }
  if (weekCount > 0) {
    introParts.push(
      weekCount === 1
        ? "1 more later this week"
        : `${weekCount} more later this week`,
    );
  }

  return {
    id: "calendar",
    heading: "On your calendar",
    intro: `${introParts.join(" · ")}.`,
    items: [],
    groups: [
      {
        id: "google-calendar",
        label: "Google Calendar",
        iconUrl: GCAL_ICON,
        count: upcoming.length,
        latestTitle: String(latest.title || "(untitled event)").trim() || undefined,
        latestRelative: formatCalendarWhen(latest.created_at),
        items: groupItems,
      },
    ],
  };
}

// Per-client jump-back URL. Each AI tool gets its main web entry
// point, not the connectors page — the goal is to deliver the user
// straight into a fresh conversation in that app so they can pick up
// where they left off. Slugs unknown here fall back to a LYKN-internal
// link (the project page is the closest "where the work lives").
const CLIENT_OPEN_URL: Record<string, string> = {
  claude: "https://claude.ai/new",
  "claude-desktop": "https://claude.ai/new",
  "claude-web": "https://claude.ai/new",
  "claude-code": "https://docs.anthropic.com/en/docs/claude-code",
  chatgpt: "https://chatgpt.com/",
  cursor: "https://cursor.com/",
  gemini: "https://gemini.google.com/app",
  perplexity: "https://www.perplexity.ai/",
  grok: "https://grok.com/",
  "notion-ai": "https://www.notion.so/",
  "codex-cli": "https://openai.com/index/introducing-codex/",
  windsurf: "https://codeium.com/windsurf",
  jetbrains: "https://www.jetbrains.com/ai/",
  "github-copilot": "https://github.com/copilot",
  replit: "https://replit.com/",
  lovable: "https://lovable.dev/",
  zapier: "https://zapier.com/",
  elevenlabs: "https://elevenlabs.io/",
};

// Branded glyph for the per-project "jump back in" CTA. We prefer the
// outbound-target's catalog domain (already used for the connectors
// page tiles) so the icon matches what the user sees in /connections.
// Fallback domain map covers AI clients that aren't in the outbound
// catalog yet (the events table can carry any slug the MCP write
// pipeline assigns, even ones we haven't shipped an OUTBOUND_TARGETS
// row for).
const CLIENT_FALLBACK_DOMAIN: Record<string, string> = {
  chatgpt: "chatgpt.com",
  claude: "claude.ai",
  "claude-code": "claude.ai",
  "claude-desktop": "claude.ai",
  "claude-web": "claude.ai",
  cursor: "cursor.com",
  gemini: "gemini.google.com",
  perplexity: "perplexity.ai",
  grok: "grok.com",
  "notion-ai": "notion.so",
  "codex-cli": "openai.com",
  windsurf: "codeium.com",
  jetbrains: "jetbrains.com",
  "github-copilot": "github.com",
  replit: "replit.com",
  lovable: "lovable.dev",
  zapier: "zapier.com",
  elevenlabs: "elevenlabs.io",
};

function clientIconUrl(slug: string | null | undefined): string | undefined {
  if (!slug) return undefined;
  // LYKN-authored updates are surfaced under the LYKN icon — keeps the
  // brand consistent for the user's own keyboard activity.
  if (slug === "manual" || slug === "lykn-chat" || slug === "lykn-promotion") {
    return lyknIconUrl;
  }
  const target = OUTBOUND_TARGETS.find(
    (t: { clientKind?: string; id?: string; domain?: string }) =>
      t.clientKind === slug || t.id === slug,
  );
  const domain = target?.domain || CLIENT_FALLBACK_DOMAIN[slug];
  if (!domain) return undefined;
  return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`;
}

// Tiny helper to pick the verb that best describes the most recent
// activity on a project. The MCP pipeline doesn't expose a structured
// "what kind of work" type yet, so we read it out of the event's
// `summary` / `detail` payload and fall back to a generic "Working on"
// — never silent.
function inferProjectVerb(e: ActivityEvent | undefined): string {
  if (!e) return "Working on";
  const text = `${e.summary || ""} ${e.detail || ""}`.toLowerCase();
  if (/brainstorm/.test(text)) return "Brainstorming";
  if (/draft|writing|wrote/.test(text)) return "Drafting";
  if (/research|gather/.test(text)) return "Researching";
  if (/refactor|implement|debug|build|code|engineer/.test(text)) return "Building";
  if (/plan|outline|spec/.test(text)) return "Planning";
  if (/review|edit|polish/.test(text)) return "Reviewing";
  return "Working on";
}

function buildProjectUpdatesSection(
  events: ActivityEvent[],
): LoadInUpdatesSection | null {
  // Each project becomes one notification-style bubble (just like the
  // productivity lane's Gmail / Notion / Slack bubbles). Collapsed it
  // shows the AI app's logo on the left, the project name + a "Last
  // touch with <AI> · 2h ago" preview, and an updates count on the
  // right. Expanded it reveals every recent update event — each one
  // a clickable row that jumps the user back into whichever AI tool
  // made that specific update so they can continue the thread.
  const byProject = new Map<
    string,
    { name: string; updates: ActivityEvent[]; created?: ActivityEvent }
  >();
  for (const e of events) {
    if (!e.target_id) continue;
    if (e.type !== "project_state" && e.type !== "project_created") continue;
    const entry = byProject.get(e.target_id) || {
      name: e.target_label || "a project",
      updates: [],
    };
    if (e.target_label) entry.name = e.target_label;
    if (e.type === "project_created") entry.created = e;
    else entry.updates.push(e);
    byProject.set(e.target_id, entry);
  }
  const projects = Array.from(byProject.entries())
    .map(([id, p]) => ({ id, ...p }))
    .filter((p) => p.updates.length > 0 || p.created)
    .sort((a, b) => {
      const aNewest = a.updates[0]?.when || a.created?.when || "";
      const bNewest = b.updates[0]?.when || b.created?.when || "";
      return Date.parse(bNewest) - Date.parse(aNewest);
    });
  if (projects.length === 0) return null;

  const groups: LoadInUpdatesGroup[] = projects.slice(0, 8).map((p) => {
    // Build a flat, time-sorted list of every event on this project
    // — both `project_state` updates and the originating
    // `project_created` event. The latest entry drives the bubble's
    // collapsed preview (icon + verb + AI) and the rest fill the
    // expanded drop-down.
    const allEvents: ActivityEvent[] = [...p.updates];
    if (p.created) allEvents.push(p.created);
    allEvents.sort(
      (a, b) => Date.parse(b.when || "") - Date.parse(a.when || ""),
    );
    const latest = allEvents[0];
    const latestSlug = latest?.by_client || null;
    const latestWho = clientDisplay(latestSlug);
    const latestVerb = inferProjectVerb(latest);
    const iconUrl = clientIconUrl(latestSlug);

    // Each row in the drop-down is one update event. We label it
    // with the originating AI's name + a short description, and
    // route the click to that AI's main entry point (Claude, Cursor,
    // …) so the user can continue the conversation there. Events
    // authored manually or by LYKN itself route to the in-app
    // project page instead.
    const groupItems = allEvents.slice(0, 8).map((ev, ix) => {
      const evSlug = ev.by_client || null;
      const evWho = clientDisplay(evSlug);
      const evVerb = inferProjectVerb(ev);
      const evHref =
        (evSlug && CLIENT_OPEN_URL[evSlug]) ||
        `/project/${p.id}`;
      const descRaw = String(ev.summary || ev.detail || "").trim();
      const desc = descRaw.length > 120 ? `${descRaw.slice(0, 117)}…` : descRaw;
      return {
        id: `${p.id}-evt-${ix}`,
        title: desc
          ? `${evVerb} with ${evWho}: ${desc}`
          : `${evVerb} with ${evWho}`,
        subtitle: relativeTime(ev.when || ""),
        href: evHref,
      };
    });

    return {
      id: `project-${p.id}`,
      label: p.name,
      iconUrl,
      count: allEvents.length,
      latestTitle: latest
        ? `${latestVerb} with ${latestWho}`
        : undefined,
      latestRelative: latest?.when ? relativeTime(latest.when) : undefined,
      items: groupItems,
    };
  });

  return {
    id: "project-updates",
    heading: "Project updates",
    items: [],
    groups,
  };
}

const CATEGORY_HEADING: Record<ConnectorCategory, string> = {
  calendar: "Calendar",
  social: "From social",
  productivity: "From your productivity tools",
  reading: "From your reading list",
  media: "From your media",
  health: "Health & activity",
};

// Per-lane copy used by the "not connected yet" empty-state branch.
// Mirrors the tone of the calendar / health empty states — short
// reassuring intro + a single "Connect <Platform>" CTA row carrying
// the suggested platform's brand mark.
const CATEGORY_EMPTY_INTRO: Record<
  Exclude<ConnectorCategory, "calendar" | "health">,
  string
> = {
  social: "I'm not reading from any social account yet. Connect one and I'll surface what you're bookmarking and reacting to.",
  productivity:
    "I'm not seeing your projects yet. Connect a productivity app and I'll fold what you're working on into your daily briefing.",
  reading:
    "I'm not tracking what you read yet. Connect a reading app and I'll roll articles and highlights into your context.",
  media:
    "I'm not seeing your music or design picks yet. Connect a media app and I'll fold them into your daily context.",
};

function buildConnectorCategorySection(
  category: ConnectorCategory,
  items: ConnectorNote[],
  _tone: NonNullable<LoadInUpdatesAction["tone"]>,
  configured: boolean = false,
): LoadInUpdatesSection | null {
  // Lane is unconnected AND has no data → render the "Connect X"
  // prompt with the suggested platform's brand mark. Mirrors the
  // empty states for calendar + health so every lane in the briefing
  // is always discoverable, never silently missing.
  if (items.length === 0 && !configured) {
    if (category === "calendar" || category === "health") return null;
    const sug = CATEGORY_SUGGESTION[category];
    if (!sug) return null;
    return {
      id: `category-${category}`,
      heading: CATEGORY_HEADING[category],
      intro: CATEGORY_EMPTY_INTRO[category as keyof typeof CATEGORY_EMPTY_INTRO],
      items: [
        {
          title: sug.platform,
          subtitle: `Connect to ${sug.benefit}.`,
          iconUrl: sug.iconUrl,
          action: {
            label: `Connect ${sug.platform}`,
            href: sug.href,
            tone: sug.tone,
            iconUrl: sug.iconUrl,
          },
        },
      ],
    };
  }
  // Lane is wired up but quiet today → render a soft "nothing recent"
  // status so the user knows the lane is healthy and just idle, not
  // broken or unconfigured.
  if (items.length === 0 && configured) {
    return {
      id: `category-${category}`,
      heading: CATEGORY_HEADING[category],
      intro: "Nothing new since your last briefing.",
      items: [],
    };
  }
  // Group by source — one notification bubble per app (Gmail, Notion,
  // Slack, etc.). Each bubble carries the app's branded logo, a
  // preview line for the most-recent item, and the underlying items
  // for the drop-down. Individual items link to their canonical
  // source URL extracted from the note's `content` payload.
  const bySource = new Map<string, ConnectorNote[]>();
  for (const item of items) {
    const arr = bySource.get(item.source) || [];
    arr.push(item);
    bySource.set(item.source, arr);
  }
  const groups: LoadInUpdatesGroup[] = [];
  for (const [source, sourceItems] of bySource) {
    // `sourceItems` is already sorted desc by updated_at (the query
    // pulled them that way), so item[0] is the newest.
    const newest = sourceItems[0];
    const conn = sourceConnector(source);
    const groupItems = sourceItems.slice(0, 8).map((n) => ({
      id: n.id,
      title: String(n.title || "(untitled)").trim() || "(untitled)",
      subtitle: relativeTime(n.updated_at),
      href: extractItemUrl(n.content) || undefined,
    }));
    groups.push({
      id: source,
      label: sourceLabel(source),
      iconUrl: sourceIconUrl(source),
      domain: conn?.domain,
      count: sourceItems.length,
      latestTitle: String(newest.title || "(untitled)").trim() || undefined,
      latestRelative: relativeTime(newest.updated_at),
      items: groupItems,
    });
  }
  if (groups.length === 0) return null;
  return {
    id: `category-${category}`,
    heading: CATEGORY_HEADING[category],
    items: [],
    groups,
  };
}

// Health & activity lane — modeled on `buildTodaySection`. We want
// the section to always render in the briefing so the user is gently
// nudged to wire up a wearable, then graduates into a real
// notification-bubble per source (Oura, WHOOP, Fitbit, etc.) once
// daily summaries start flowing in. Three states:
//
//   1. Not connected → "Connect a wearable" prompt with the Oura
//      brand mark as the headline (alternates listed in the intro).
//   2. Connected but quiet → a "no new readings today" status row so
//      the user knows the lane is healthy and not broken.
//   3. Connected with data → bubble per source, expanding to the
//      individual daily summaries / recorded activities.
function buildHealthSection(
  items: ConnectorNote[],
  healthConfigured: boolean,
): LoadInUpdatesSection | null {
  if (!healthConfigured && items.length === 0) {
    const sug = CATEGORY_SUGGESTION.health;
    return {
      id: "health",
      heading: "Health & activity",
      intro:
        "I'm not reading from a wearable yet. Connect Oura, WHOOP, Fitbit, or Strava and I'll fold sleep, recovery, and activity into how I plan with you.",
      items: [
        {
          title: sug.platform,
          subtitle: `Connect to ${sug.benefit}`,
          iconUrl: sug.iconUrl,
          action: {
            label: `Connect ${sug.platform}`,
            href: sug.href,
            tone: sug.tone,
            iconUrl: sug.iconUrl,
          },
        },
      ],
    };
  }

  if (items.length === 0) {
    return {
      id: "health",
      heading: "Health & activity",
      intro: "No new readings since your last briefing. Your trackers are quiet.",
      items: [],
    };
  }

  // Group by source (Oura, WHOOP, Fitbit, ...) into notification
  // bubbles. Same shape as `buildConnectorCategorySection` so the
  // renderer treats the bubbles identically across lanes.
  const bySource = new Map<string, ConnectorNote[]>();
  for (const item of items) {
    const arr = bySource.get(item.source) || [];
    arr.push(item);
    bySource.set(item.source, arr);
  }
  const groups: LoadInUpdatesGroup[] = [];
  for (const [source, sourceItems] of bySource) {
    const newest = sourceItems[0];
    const conn = sourceConnector(source);
    const groupItems = sourceItems.slice(0, 8).map((n) => ({
      id: n.id,
      title: String(n.title || "(untitled reading)").trim() || "(untitled reading)",
      subtitle: relativeTime(n.updated_at),
      href: extractItemUrl(n.content) || undefined,
    }));
    groups.push({
      id: source,
      label: sourceLabel(source),
      iconUrl: sourceIconUrl(source),
      domain: conn?.domain,
      count: sourceItems.length,
      latestTitle: String(newest.title || "").trim() || undefined,
      latestRelative: relativeTime(newest.updated_at),
      items: groupItems,
    });
  }
  if (groups.length === 0) return null;
  return {
    id: "health",
    heading: "Health & activity",
    items: [],
    groups,
  };
}

// --------------------------------------------------------------------------
// Concepts-moved section — "your <X> concept moved this week"
// --------------------------------------------------------------------------
// Renders one bubble per concept that gained links in the briefing
// window, with a single item per bubble summarising what landed
// (notes / facts / beliefs / chats) and a deep link to the concept
// node on the 3D synthesis layer page. Capped at 5 concepts so the
// briefing doesn't blow up for power users with a wide topic
// surface — the rest still live in /synthesis-layer.
function buildConceptsMovedSection(
  rows: ConceptsMovedRow[],
): LoadInUpdatesSection | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Drop dismissed-status rows defensively (the RPC already filters
  // them, but a stale cached briefing could carry one through).
  const live = rows.filter((r) => r.status !== "dismissed");
  if (live.length === 0) return null;

  // Sort by total movement desc; the RPC already orders this way but
  // we re-sort here so the section is order-stable across cached
  // payloads that may have been written before the ordering was
  // tightened.
  const sumDeltas = (r: ConceptsMovedRow) => {
    const d = r.deltas || {};
    return (d.notes || 0) + (d.facts || 0) + (d.beliefs || 0) + (d.chats || 0);
  };
  live.sort((a, b) => sumDeltas(b) - sumDeltas(a));

  // Filter: a concept only earns a bubble if it moved by at least 1
  // link in any category. Zero-movement rows shouldn't reach us, but
  // the guard keeps the section honest.
  const filtered = live.filter((r) => sumDeltas(r) > 0).slice(0, 5);
  if (filtered.length === 0) return null;

  const partLabel = (n: number, sing: string): string =>
    `${n} ${n === 1 ? sing : `${sing}s`}`;

  const groups: LoadInUpdatesGroup[] = filtered.map((r) => {
    const d = r.deltas || {};
    const parts: string[] = [];
    if (d.notes) parts.push(partLabel(d.notes, "note"));
    if (d.facts) parts.push(partLabel(d.facts, "neuron"));
    if (d.beliefs) parts.push(partLabel(d.beliefs, "belief"));
    if (d.chats) parts.push(partLabel(d.chats, "chat"));
    const subtitle = parts.join(" · ");
    const total = sumDeltas(r);
    return {
      id: `concept-${r.concept_id}`,
      label: r.label,
      count: total,
      latestTitle: subtitle,
      latestRelative: r.latest_at ? relativeTime(r.latest_at) : undefined,
      items: [
        {
          id: `concept-item-${r.concept_id}`,
          title: `Your "${r.label}" concept moved`,
          subtitle,
          href: `/synthesis-layer?focus=concept_${r.concept_id}`,
        },
      ],
    };
  });

  return {
    id: "concepts-moved",
    heading: "Concepts that moved this week",
    intro: filtered.length === 1
      ? "One topic across your notes, chats, and learning pulled in new signals."
      : `${filtered.length} topics across your notes, chats, and learning pulled in new signals.`,
    items: [],
    groups,
  };
}

function buildApprovalsSectionStructured(
  events: ActivityEvent[],
  provenanceByBelief: Map<string, BeliefProvenanceRow[]> = new Map(),
): LoadInUpdatesSection | null {
  // Roll everything the synthesis layer has surfaced recently into
  // notification bubbles — proposed beliefs, freshly-activated
  // beliefs, and newly-learned facts. Each bubble opens to a list of
  // items; clicking an item routes to the synthesis layer focused on
  // that node where the user can read the description and approve /
  // dismiss inline.
  const cutoff = Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const recent = events.filter((e) => {
    const t = Date.parse(e.when);
    return Number.isFinite(t) && t >= cutoff;
  });

  // Proposed beliefs (the canonical "awaiting approval" bucket).
  // Dedupe on target_id so multi-client converging proposals collapse
  // into a single bubble row.
  const proposedSeen = new Set<string>();
  const proposedItems: LoadInUpdatesGroup["items"] = [];
  for (const e of recent.filter((e) => e.type === "belief_proposed")) {
    if (!e.target_id || proposedSeen.has(e.target_id)) continue;
    proposedSeen.add(e.target_id);
    const clients = Array.isArray(e.proposed_by_clients)
      ? e.proposed_by_clients
      : [];
    const subtitle =
      clients.length >= 2
        ? `${joinClients(clients)} surfaced this · ${relativeTime(e.when)}`
        : `Proposed by ${clientDisplay(e.by_client)} · ${relativeTime(e.when)}`;
    // "Grounded in" chips. Walk the per-belief provenance rows the
    // RPC returned, dedupe by source_id (the same vault note can show
    // up under multiple facts), and cap at 3 entries so the row stays
    // scannable. Each chip deep-links to the underlying vault note
    // so the user can verify the receipts in one click.
    const provenance: NonNullable<LoadInUpdatesGroupItem["provenance"]> = [];
    const seenSources = new Set<string>();
    const rows = provenanceByBelief.get(e.target_id) || [];
    for (const row of rows) {
      const sid = row.source_id || "";
      if (!sid || seenSources.has(sid)) continue;
      seenSources.add(sid);
      // Brand-aware chip label. When we know the connector (Notion,
      // Gmail, ...) prefix the note title with its display name —
      // "Notion: Sprint plan" reads instantly while a bare note
      // title in a chip can feel orphaned.
      const connector = row.source_connector || "";
      const connectorLabel = connector ? SOURCE_LABEL[connector] : "";
      const rawLabel = row.source_label || "Source";
      const label = connectorLabel
        ? `${connectorLabel}: ${rawLabel}`
        : rawLabel;
      const connectorId = connector ? SOURCE_TO_CONNECTOR_ID[connector] : undefined;
      // Internal deep link for vault notes; non-vault sources (board,
      // conversation, intake) route to the synthesis layer focused on
      // the underlying fact so the user can still trace the chain.
      const href =
        row.source_type === "vault_note"
          ? `/vault?note=${encodeURIComponent(sid)}`
          : `/synthesis-layer?focus=fact_${encodeURIComponent(row.fact_id)}`;
      provenance.push({
        id: sid,
        label: label.length > 60 ? `${label.slice(0, 58)}…` : label,
        href,
        connectorId: connectorId || undefined,
      });
      if (provenance.length >= 3) break;
    }
    proposedItems.push({
      id: e.target_id,
      title: e.target_label || "a new belief",
      subtitle,
      href: `/synthesis-layer?focus=belief_${encodeURIComponent(e.target_id)}`,
      ...(provenance.length > 0 ? { provenance } : {}),
    });
    if (proposedItems.length >= 8) break;
  }

  // Recently-activated beliefs — these were promoted to "active"
  // automatically (rule-driven). The user can still revisit and
  // approve / refine them in the synthesis layer; we surface them so
  // the user has visibility into what their system decided on its
  // own.
  const activeSeen = new Set<string>();
  const activeItems: LoadInUpdatesGroup["items"] = [];
  for (const e of recent.filter((e) => e.type === "belief_active")) {
    if (!e.target_id || activeSeen.has(e.target_id)) continue;
    activeSeen.add(e.target_id);
    activeItems.push({
      id: e.target_id,
      title: e.target_label || "a new belief",
      subtitle: `Activated · from ${clientDisplay(e.by_client)} · ${relativeTime(e.when)}`,
      href: `/synthesis-layer?focus=belief_${encodeURIComponent(e.target_id)}`,
    });
    if (activeItems.length >= 8) break;
  }

  // New neurons (facts learned). These don't need explicit approval
  // but the user wants visibility into what was learned about them
  // recently, with the option to jump in and edit / dismiss.
  const factSeen = new Set<string>();
  const factItems: LoadInUpdatesGroup["items"] = [];
  for (const e of recent.filter((e) => e.type === "fact_added")) {
    if (!e.target_id || factSeen.has(e.target_id)) continue;
    factSeen.add(e.target_id);
    const who = clientDisplay(e.by_client);
    factItems.push({
      id: e.target_id,
      title: e.target_label || "about you",
      subtitle: `${who === "you" ? "You added" : `${who} learned`} this · ${relativeTime(e.when)}`,
      href: `/synthesis-layer?focus=fact_${encodeURIComponent(e.target_id)}`,
    });
    if (factItems.length >= 8) break;
  }

  if (
    proposedItems.length === 0 &&
    activeItems.length === 0 &&
    factItems.length === 0
  ) {
    return null;
  }

  const groups: LoadInUpdatesGroup[] = [];
  if (proposedItems.length > 0) {
    const newest = proposedItems[0];
    groups.push({
      id: "beliefs-proposed",
      label: "New beliefs",
      iconUrl: lyknIconUrl,
      count: proposedItems.length,
      latestTitle: newest.title,
      latestRelative: newest.subtitle?.split(" · ").pop() || undefined,
      items: proposedItems,
    });
  }
  if (activeItems.length > 0) {
    const newest = activeItems[0];
    groups.push({
      id: "beliefs-active",
      label: "Beliefs activated",
      iconUrl: lyknIconUrl,
      count: activeItems.length,
      latestTitle: newest.title,
      latestRelative: newest.subtitle?.split(" · ").pop() || undefined,
      items: activeItems,
    });
  }
  if (factItems.length > 0) {
    const newest = factItems[0];
    groups.push({
      id: "neurons-new",
      label: "New neurons",
      iconUrl: lyknIconUrl,
      count: factItems.length,
      latestTitle: newest.title,
      latestRelative: newest.subtitle?.split(" · ").pop() || undefined,
      items: factItems,
    });
  }

  // Prose summary at the top of the section — the brief written
  // recap the user reads before deciding which bubble to expand.
  const bits: string[] = [];
  if (factItems.length > 0) {
    bits.push(`${factItems.length} new neuron${factItems.length === 1 ? "" : "s"}`);
  }
  if (activeItems.length > 0) {
    bits.push(
      `${activeItems.length} belief${activeItems.length === 1 ? "" : "s"} promoted to active`,
    );
  }
  if (proposedItems.length > 0) {
    bits.push(
      `${proposedItems.length} new belief${proposedItems.length === 1 ? "" : "s"} waiting on your call`,
    );
  }
  const summary =
    bits.length > 0
      ? `Your synthesis layer minted ${bits.length === 1 ? bits[0] : bits.length === 2 ? `${bits[0]} and ${bits[1]}` : `${bits.slice(0, -1).join(", ")}, and ${bits[bits.length - 1]}`} in the last few days. Tap any of them to open the synthesis layer with the full description and an approve button.`
      : "";

  return {
    id: "approvals",
    heading: "Awaiting your approval",
    summary,
    items: [],
    groups,
  };
}

// Per-category brand grid for the "Connect the rest" section. Each
// lane recommends a handful of concrete connectors — the headline
// platform plus its closest alternates — so the user can browse the
// row of icons like an app-store shelf and tap whichever one they
// already use. Keep in sync with the connector catalog; missing
// connector ids just get dropped silently.
const CONNECT_LANE_CHIPS: Record<
  Exclude<ConnectorCategory, "calendar">,
  Array<{ connectorId: string; label: string }>
> = {
  productivity: [
    { connectorId: "notion", label: "Notion" },
    { connectorId: "slack", label: "Slack" },
    { connectorId: "linear", label: "Linear" },
    { connectorId: "todoist", label: "Todoist" },
    { connectorId: "github", label: "GitHub" },
    { connectorId: "trello", label: "Trello" },
    { connectorId: "gmail", label: "Gmail" },
    { connectorId: "google-drive", label: "Google Drive" },
    { connectorId: "google-calendar", label: "Google Calendar" },
  ],
  social: [
    { connectorId: "youtube", label: "YouTube" },
  ],
  reading: [
    { connectorId: "raindrop", label: "Raindrop" },
  ],
  media: [
    { connectorId: "youtube", label: "YouTube" },
  ],
  health: [
    { connectorId: "oura", label: "Oura" },
    { connectorId: "whoop", label: "WHOOP" },
    { connectorId: "fitbit", label: "Fitbit" },
    { connectorId: "garmin", label: "Garmin" },
    { connectorId: "strava", label: "Strava" },
  ],
};

function buildConnectPromptsSection(
  unconfigured: ConnectorCategory[],
): LoadInUpdatesSection | null {
  // Calendar gets its own dedicated slot at the very top of the
  // briefing (`buildTodaySection` renders a "Connect Google Calendar"
  // prompt when the user has no GCal wired up). Drop it here so we
  // don't double up the same prompt in "Connect the rest".
  const remaining = unconfigured.filter(
    (c): c is Exclude<ConnectorCategory, "calendar"> => c !== "calendar",
  );
  if (remaining.length === 0) return null;

  // Roll every unconfigured lane's recommended connectors into a
  // single flat chip grid — that way the user just sees "here are
  // some apps you could plug in" instead of one labelled subsection
  // per lane (which read like five tiny lists stacked vertically).
  const seen = new Set<string>();
  const chips: LoadInUpdatesChip[] = [];
  for (const cat of remaining) {
    const recs = CONNECT_LANE_CHIPS[cat] || [];
    const tone = CATEGORY_SUGGESTION[cat]?.tone || "neutral";
    for (const rec of recs) {
      if (seen.has(rec.connectorId)) continue;
      const conn = CONNECTORS.find((c) => c.id === rec.connectorId);
      if (!conn) continue;
      const iconUrl =
        conn.iconUrl ||
        (conn.domain ? faviconFor(conn.domain) : undefined) ||
        "";
      if (!iconUrl) continue;
      seen.add(rec.connectorId);
      chips.push({
        id: rec.connectorId,
        label: rec.label,
        iconUrl,
        href: `/connections#${rec.connectorId}`,
        tone,
      });
      if (chips.length >= 12) break;
    }
    if (chips.length >= 12) break;
  }

  if (chips.length === 0) return null;
  return {
    id: "connect",
    heading: "Connect the rest",
    intro:
      "A few apps I can't see into yet. Tap any to wire it up and I'll fold it into your daily briefing.",
    items: [],
    chips,
  };
}

// --------------------------------------------------------------------------
// User-authored briefing sections
// --------------------------------------------------------------------------
// Pulled from `lykn_load_in_user_sections` (RLS-scoped to the current
// user via the supabase client). Each row becomes a structured section
// at the end of the briefing, carrying its uuid as `userSectionId` so
// the renderer can show edit / delete controls inline. Body is plain
// markdown so users can paste bullets, links, etc.; the chat surface
// already renders markdown for every other section's intro / summary.

interface UserAuthoredSectionRow {
  id: string;
  heading: string;
  body: string | null;
  sort_order: number;
}

async function fetchUserAuthoredSections(): Promise<LoadInUpdatesSection[]> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const userId = session?.session?.user?.id;
    if (!userId) return [];
    const { data, error } = await supabase
      .from("lykn_load_in_user_sections")
      .select("id, heading, body, sort_order")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return (data as UserAuthoredSectionRow[]).map((row) => ({
      id: `user-section-${row.id}`,
      userSectionId: row.id,
      heading: String(row.heading || "").trim() || "Untitled section",
      // Body lives in `summary` so the renderer drops it through
      // ReactMarkdown — same path the other prose sections take.
      summary: String(row.body || "").trim(),
      items: [],
    }));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------
// Legacy markdown formatter (kept for fallback callers that still read
// `payload.message`). Builds the prior narrative paragraph by paragraph;
// the new structured `sections` array is the canonical shape consumed
// by the chat renderer.
// ----------------------------------------------------------------------
function formatMessage(
  events: ActivityEvent[],
  connector: ConnectorActivity | null,
  status: ConnectorStatusMap,
  opts: BuildOptions,
  userSections: LoadInUpdatesSection[] = [],
  provenanceByBelief: Map<string, BeliefProvenanceRow[]> = new Map(),
  conceptsMoved: ConceptsMovedRow[] = [],
  docket: TodayDocket | null = null,
): LoadInUpdatesPayload {
  const sections = collectSections(events);
  const { recent, approvals, projects } = sections;

  // The user's own events + tasks for today (from lykn_events / lykn_todos).
  // Built up front so it can drive both the recap bullets and be pinned to
  // the top of the structured sections.
  const docketSection = buildTodayDocketSection(docket);
  const docketEventCount = docket?.events.length ?? 0;
  const docketTaskCount = (docket?.dueToday.length ?? 0) + (docket?.overdue.length ?? 0);
  const docketOverdueCount = docket?.overdue.length ?? 0;

  const { today: todayLines, week: weekLines } = connector
    ? buildTodayAndWeekSections(connector.upcomingCalendar)
    : { today: [], week: [] };
  const socialLines = connector ? buildConnectorSection(connector.byCategory.social) : [];
  const productivityLines = connector
    ? buildConnectorSection(connector.byCategory.productivity)
    : [];
  const readingLines = connector
    ? buildConnectorSection(connector.byCategory.reading)
    : [];
  const mediaLines = connector ? buildConnectorSection(connector.byCategory.media) : [];
  const healthLines = connector ? buildConnectorSection(connector.byCategory.health) : [];

  // For each lane: did we render anything? If not, is there a wired
  // connector that's just quiet today? If neither, the lane is
  // "unconfigured" and we emit a "Connect X" nudge instead of
  // pretending it doesn't exist.
  const hasUpcoming =
    todayLines.length > 0 || weekLines.length > 0 || (connector?.upcomingCalendar?.length ?? 0) > 0;
  const unconfigured: ConnectorCategory[] = [];
  const considerLane = (
    cat: ConnectorCategory,
    populated: boolean,
  ) => {
    if (populated) return;
    if (status.configured.has(cat)) return;
    unconfigured.push(cat);
  };
  considerLane("calendar", hasUpcoming);
  considerLane("social", socialLines.length > 0);
  considerLane("productivity", productivityLines.length > 0);
  considerLane("reading", readingLines.length > 0);
  considerLane("media", mediaLines.length > 0);
  considerLane("health", healthLines.length > 0);

  const hasContent =
    docketSection != null ||
    recent.length > 0 ||
    approvals.length > 0 ||
    projects.length > 0 ||
    todayLines.length > 0 ||
    weekLines.length > 0 ||
    socialLines.length > 0 ||
    productivityLines.length > 0 ||
    readingLines.length > 0 ||
    mediaLines.length > 0 ||
    healthLines.length > 0 ||
    unconfigured.length > 0 ||
    userSections.length > 0;

  const salute = timeOfDayGreeting();
  const name = opts.greetingName ? `, ${opts.greetingName}` : "";

  // Bulleted recap — a one-line scan of every lane that has updates
  // today, rendered above the structured sections so the user can
  // skim the whole briefing in two seconds before deciding what to
  // drill into. Each bullet maps 1:1 to a section heading below.
  const calendarConfiguredForBullets = status.configured.has("calendar");
  const todayCount = todayLines.length;
  const weekCount = weekLines.length;
  const socialCount = socialLines.length;
  const productivityCount = productivityLines.length;
  const readingCount = readingLines.length;
  const mediaCount = mediaLines.length;
  const healthCount = healthLines.length;
  const healthConfiguredForBullets = status.configured.has("health");
  const approvalsCount = approvals.length;
  const projectCount = projects.length;
  const recentSynthesisCount = recent.length;

  const pluralize = (n: number, sing: string, plural?: string): string =>
    `${n} ${n === 1 ? sing : (plural || `${sing}s`)}`;

  const bullets: string[] = [];
  // Lead the recap with the user's own plate for today — the most
  // actionable line in the whole briefing.
  if (docketEventCount > 0 || docketTaskCount > 0) {
    const parts: string[] = [];
    if (docketEventCount > 0) parts.push(pluralize(docketEventCount, "event"));
    if (docketTaskCount > 0) parts.push(pluralize(docketTaskCount, "task"));
    let line = `${parts.join(" · ")} on your plate today`;
    if (docketOverdueCount > 0) {
      line += ` (${docketOverdueCount} overdue)`;
    }
    bullets.push(line);
  }
  if (!calendarConfiguredForBullets) {
    bullets.push("Calendar isn't connected yet");
  } else if (todayCount > 0) {
    bullets.push(`${pluralize(todayCount, "event")} on your calendar today`);
  } else if (weekCount > 0) {
    bullets.push("Nothing on the books today");
  } else {
    bullets.push("Your day is clear");
  }
  if (weekCount > 0) {
    bullets.push(`${pluralize(weekCount, "event")} later this week`);
  }
  if (projectCount > 0 || recentSynthesisCount > 0) {
    const parts: string[] = [];
    if (projectCount > 0) parts.push(`${pluralize(projectCount, "project update")}`);
    if (recentSynthesisCount > 0) parts.push(`${pluralize(recentSynthesisCount, "synthesis change")}`);
    bullets.push(parts.join(" · "));
  }
  // Social, reading, and media bullet lines retired alongside their
  // briefing sections — those lanes now live only in the dashboard
  // panel's distribution bars, which is enough surface area without
  // also calling them out as recap bullets.
  if (productivityCount > 0) {
    bullets.push(
      `${pluralize(productivityCount, "new item")} from your productivity tools`,
    );
  }
  if (approvalsCount > 0) {
    bullets.push(
      `${pluralize(approvalsCount, "thing awaiting your approval", "things awaiting your approval")}`,
    );
  }
  const remainingUnconfigured = unconfigured.filter((c) => c !== "calendar");
  if (remainingUnconfigured.length > 0) {
    bullets.push(
      `${pluralize(remainingUnconfigured.length, "lane")} I can't see into yet (wire them up below)`,
    );
  }

  // Header line is rendered as a standalone big heading by the chat
  // surface (see `isLoadInGreeting` branch in LyknChatView). We
  // separate it from the bullets with a blank line so the markdown
  // pass treats the bullets as a clean list, and we drop the
  // "Here's where things stand:" filler — the bulleted recap reads
  // for itself.
  const headerLine = `${salute}${name}.`;
  const opener = hasContent
    ? `${headerLine}\n\n${bullets.map((b) => `- ${b}`).join("\n")}`
    : headerLine;

  // Build the structured sections that the chat renderer consumes.
  // Each section is a heading + a list of rows; rows carry their own
  // CTA button inline so the user can act on any individual update
  // without scanning to a separate strip at the bottom of the bubble.
  const structuredSections: LoadInUpdatesSection[] = [];
  // A section is "non-empty" when it has either items to list, a
  // prose summary to render, or groups to render as notification
  // bubbles. Summary- and groups-only sections legitimately ship
  // `items: []`.
  const pushIfSome = (s: LoadInUpdatesSection | null) => {
    if (!s) return;
    const hasItems = s.items.length > 0;
    const hasSummary = !!s.summary && s.summary.trim().length > 0;
    const hasGroups = !!s.groups && s.groups.length > 0;
    const hasChips = !!s.chips && s.chips.length > 0;
    if (hasItems || hasSummary || hasGroups || hasChips) {
      structuredSections.push(s);
    }
  };
  // Today's docket leads the briefing — the user's own schedule + task
  // list for the day, ahead of everything connector-driven.
  pushIfSome(docketSection);
  const calendarConfigured = status.configured.has("calendar");
  // The calendar slot is always rendered: events when connected, a
  // "Connect Google Calendar" prompt when not. We pass an empty list
  // when the connector fetch failed entirely so the prompt still
  // shows up for users who don't have GCal wired up.
  pushIfSome(
    buildTodaySection(connector?.upcomingCalendar ?? [], calendarConfigured),
  );
  // Productivity is the only connector lane we render in the briefing
  // body — social, reading, and media were dropped because the
  // briefing was becoming a wall of section headings the user had to
  // scroll past. Those lanes are still tracked in the dashboard panel
  // (the per-source distribution bars) so the user can see at a
  // glance whether they're flowing without crowding the chat surface.
  pushIfSome(
    buildConnectorCategorySection(
      "productivity",
      connector?.byCategory.productivity ?? [],
      "primary",
      status.configured.has("productivity"),
    ),
  );
  pushIfSome(buildApprovalsSectionStructured(events, provenanceByBelief));
  // Concepts that moved this week — first-class topic layer (stage 2).
  // Inserted just under the approvals section because conceptually
  // it's the same "what's happening in your synthesis layer" beat:
  // approvals say what the AI wants to add, concepts-moved says
  // what's already growing across everything you've touched.
  pushIfSome(buildConceptsMovedSection(conceptsMoved));
  // Project updates are intentionally near the bottom — the user
  // skims the bulleted opener for "what changed today" then drills
  // into the conversational lanes (calendar, connectors, approvals)
  // before deciding which long-running project to step back into.
  pushIfSome(buildProjectUpdatesSection(events));
  // User-authored sections land last, just above the inline "+ Add a
  // section" composer at the bottom of the bubble. We push them
  // through pushIfSome so empty rows (no heading + no body) still get
  // filtered, but the renderer accepts a section with just a heading
  // and no body since the heading itself is the user's content.
  for (const section of userSections) {
    const hasHeading = !!section.heading && section.heading.trim().length > 0;
    const hasBody = !!section.summary && section.summary.trim().length > 0;
    if (hasHeading || hasBody) structuredSections.push(section);
  }
  // "Connect the rest" chip grid intentionally retired — each lane
  // now carries its own inline "Connect <Platform>" CTA when no
  // connector is wired up, so this section was double-prompting the
  // same suggestions in a denser form. Keep the helper available in
  // case a future caller wants the compact grid.

  // The new UI uses a short welcome line at the top of the bubble and
  // pushes the rest of the recap into structured sections below. The
  // longer narrative version is intentionally dropped now that each
  // section has its own heading + inline action button.
  const welcomeMessage = hasContent
    ? opener
    : `${opener} Nothing new on the wire: calendar's clear, no pending approvals, your synthesis layer is quiet.`;

  // Roll-up stats for the right-side dashboard panel. Computed here
  // because every input (events, connector buckets, approvals
  // breakdown) is already in-scope and pre-filtered.
  const stats = buildStats({
    events,
    connector,
    approvalsBreakdown: collectApprovalsBreakdown(events),
    projectCount,
    socialCount,
    productivityCount,
    readingCount,
    mediaCount,
    healthCount,
    todayCount,
    weekCount,
    recentSynthesisCount,
  });

  return {
    message: welcomeMessage,
    sections: structuredSections,
    actions: hasContent ? buildActions(sections, connector, unconfigured) : [],
    hasContent,
    stats,
  };
}

// Tally proposed beliefs, freshly-activated beliefs, and new facts
// separately so the side panel can colour each bucket distinctly. We
// dedupe on target_id to mirror the same collapse logic the structured
// approvals section uses, so the dashboard count matches the bubble
// count the user sees in the bubble list (no off-by-one weirdness).
function collectApprovalsBreakdown(events: ActivityEvent[]): {
  proposedBeliefs: number;
  activeBeliefs: number;
  newFacts: number;
} {
  const cutoff = Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const recent = events.filter((e) => {
    const t = Date.parse(e.when);
    return Number.isFinite(t) && t >= cutoff;
  });
  const proposed = new Set<string>();
  const active = new Set<string>();
  const facts = new Set<string>();
  for (const e of recent) {
    if (!e.target_id) continue;
    if (e.type === "belief_proposed") proposed.add(e.target_id);
    else if (e.type === "belief_active") active.add(e.target_id);
    else if (e.type === "fact_added") facts.add(e.target_id);
  }
  return {
    proposedBeliefs: proposed.size,
    activeBeliefs: active.size,
    newFacts: facts.size,
  };
}

// Build the 7-day activity sparkline + roll-up counts consumed by the
// right-side dashboard panel. We intentionally keep this pure — every
// input is already in scope when `formatMessage` runs, so the side
// panel never has to refetch anything.
function buildStats(args: {
  events: ActivityEvent[];
  connector: ConnectorActivity | null;
  approvalsBreakdown: {
    proposedBeliefs: number;
    activeBeliefs: number;
    newFacts: number;
  };
  projectCount: number;
  socialCount: number;
  productivityCount: number;
  readingCount: number;
  mediaCount: number;
  healthCount: number;
  todayCount: number;
  weekCount: number;
  recentSynthesisCount: number;
}): LoadInUpdatesStats {
  const {
    events,
    connector,
    approvalsBreakdown,
    projectCount,
    socialCount,
    productivityCount,
    readingCount,
    mediaCount,
    healthCount,
    todayCount,
    weekCount,
    recentSynthesisCount,
  } = args;

  // Build a YYYY-MM-DD bucket for each of the last 7 days, oldest
  // first. Using local-time `toDateString` rather than UTC so a user
  // who lands at 11pm sees "today" lined up with their wall clock.
  const now = new Date();
  const buckets: Array<{ date: string; key: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    buckets.push({
      date: `${yyyy}-${mm}-${dd}`,
      key: d.toDateString(),
      count: 0,
    });
  }
  const bucketByKey = new Map(buckets.map((b) => [b.key, b]));

  const bump = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return;
    const k = new Date(t).toDateString();
    const b = bucketByKey.get(k);
    if (b) b.count += 1;
  };

  // Synthesis activity events
  for (const e of events) bump(e.when);
  // Connector-driven notes — past lookback. Calendar events are skipped
  // because their `created_at` is the *event start*, which is future
  // for upcoming events and would muddle the past-activity signal.
  if (connector) {
    for (const lane of [
      connector.byCategory.social,
      connector.byCategory.productivity,
      connector.byCategory.reading,
      connector.byCategory.media,
      connector.byCategory.health,
    ]) {
      for (const n of lane) bump(n.updated_at);
    }
  }

  const totalUpdates =
    socialCount +
    productivityCount +
    readingCount +
    mediaCount +
    healthCount +
    todayCount +
    weekCount +
    approvalsBreakdown.proposedBeliefs +
    approvalsBreakdown.activeBeliefs +
    approvalsBreakdown.newFacts +
    recentSynthesisCount;

  return {
    calendarToday: todayCount,
    calendarWeek: weekCount,
    byCategory: {
      social: socialCount,
      productivity: productivityCount,
      reading: readingCount,
      media: mediaCount,
      health: healthCount,
    },
    approvals: approvalsBreakdown,
    projects: projectCount,
    synthesisChanges: recentSynthesisCount,
    series: buckets.map((b) => ({ date: b.date, count: b.count })),
    totalUpdates,
  };
}

/**
 * Fetch the user's most recent activity across the synthesis layer AND
 * their connected sources (calendar, social, productivity, reading,
 * media), and shape it into the markdown greeting LYKN posts at the
 * top of every fresh chat opened on `/app` load-in. Returns `null`
 * when the user isn't authenticated.
 *
 * Both fetches run in parallel and tolerate partial failure: if the
 * synthesis endpoint times out but the connector query succeeds we
 * still render the connector sections (and vice versa). Only when
 * BOTH fail do we return null and let the caller skip the seed.
 */
// On-demand connector resync. The background poller runs once per
// minute, so a user who just added a calendar event (or any other
// connector item) would have to wait up to 60s before the welcome
// briefing reflected it. Calling this from the load-in flow kicks
// the relevant adapters immediately so the very next /notes read
// includes anything the user did in the last few seconds. The call
// is awaited (with a hard timeout) so the welcome message renders
// against fresh data, not the previous polling cycle's snapshot.
async function kickConnectorSync(
  providers: string[],
  timeoutMs = 6000,
): Promise<void> {
  try {
    // First fetch the user's wired-up connections so we can map
    // each desired `provider` to its row id (the sync endpoint
    // takes a connection id, not a provider slug). Auth header is
    // attached automatically by the fetch interceptor.
    const listRes = await fetch(`${API_BASE_URL}/api/connections`, {
      method: "GET",
    });
    if (!listRes.ok) return;
    const body = await listRes.json().catch(() => null);
    const conns: Array<{ id: string; provider: string; status: string }> =
      Array.isArray(body?.connections) ? body.connections : [];
    const targets = conns.filter(
      (c) => providers.includes(c.provider) && c.status === "active",
    );
    if (targets.length === 0) return;
    // Fire every relevant connection's sync in parallel; race the
    // group against a hard timeout so the welcome message never
    // sits forever waiting on a slow provider.
    const work = Promise.allSettled(
      targets.map((t) =>
        fetch(`${API_BASE_URL}/api/connections/${t.id}/sync`, {
          method: "POST",
        }).catch(() => null),
      ),
    );
    await Promise.race([
      work,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Swallow — a failed sync just means the welcome bubble might
    // be one polling cycle behind. Not worth surfacing.
  }
}

export async function fetchLoadInUpdatesMessage(
  opts: BuildOptions = {},
): Promise<LoadInUpdatesPayload | null> {
  // Kick a fresh pull from the providers whose data dominates the
  // briefing (calendar + the inboxes / wikis the user actually wires
  // up). The 6s timeout caps the worst-case latency added to the
  // welcome bubble — anything that hasn't responded by then will
  // still land in time for the *next* refresh.
  await kickConnectorSync(
    [
      "notion",
      "slack",
      "github",
      "linear",
      "todoist",
      "trello",
      "raindrop",
      "gmail",
      "google-drive",
      "google-calendar",
      "youtube",
    ],
    6000,
  );
  const [synthesisResp, connectorResp, statusResp, userSections, docket] =
    await Promise.all([
      fetchActivity(),
      fetchConnectorActivity(),
      fetchConnectorStatus(),
      fetchUserAuthoredSections(),
      fetchTodayDocket(),
    ]);
  // Pull provenance for the small list of beliefs that will actually
  // get rendered as approval items (deduped, capped at 8 inside
  // buildApprovalsSectionStructured). We mirror that dedup here so
  // the RPC payload stays tiny — there's no point fetching provenance
  // for a 9th proposed belief we'll never show.
  const events = synthesisResp?.events || [];
  const proposedIds: string[] = [];
  const seenProposedIds = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "belief_proposed") continue;
    if (!ev.target_id || seenProposedIds.has(ev.target_id)) continue;
    seenProposedIds.add(ev.target_id);
    proposedIds.push(ev.target_id);
    if (proposedIds.length >= 8) break;
  }
  // Best-effort: an RPC failure leaves provenanceByBelief empty so
  // the briefing still renders with the prior shape (no chip row).
  // Same shape for the concepts_moved fetch — RPC may not be deployed
  // yet on older environments, so we tolerate an empty array.
  const [provenanceByBelief, conceptsMoved] = await Promise.all([
    fetchBeliefProvenance(proposedIds),
    fetchConceptsMovedRecently(),
  ]);
  // We deliberately fall through to formatMessage even when both
  // activity fetches fail — `statusResp` (always returns at minimum
  // an empty configured-set) is enough to drive the "Connect X"
  // prompts, which is the most important onboarding affordance for
  // a freshly-signed-up user who literally has nothing else to show.
  return formatMessage(
    events,
    connectorResp,
    statusResp,
    opts,
    userSections,
    provenanceByBelief,
    conceptsMoved,
    docket,
  );
}
