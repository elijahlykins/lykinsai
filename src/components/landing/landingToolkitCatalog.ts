/** Popular Composio apps for the landing ticker's first paint. Live catalog from `/api/public/toolkits` replaces this once it loads. */
export type LandingToolkit = {
  slug: string;
  name: string;
  logoUrl: string;
};

const COMPOSIO_LOGO_PREFIX = "https://logos.composio.dev/";
const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

function logoUrlFor(slug: string) {
  return `${COMPOSIO_LOGO_PREFIX}api/${encodeURIComponent(slug)}`;
}

const FALLBACK_APPS: { slug: string; name: string }[] = [
  { slug: "gmail", name: "Gmail" },
  { slug: "github", name: "GitHub" },
  { slug: "googlecalendar", name: "Google Calendar" },
  { slug: "notion", name: "Notion" },
  { slug: "googlesheets", name: "Google Sheets" },
  { slug: "slack", name: "Slack" },
  { slug: "supabase", name: "Supabase" },
  { slug: "outlook", name: "Outlook" },
  { slug: "perplexityai", name: "Perplexity AI" },
  { slug: "twitter", name: "Twitter" },
  { slug: "googledrive", name: "Google Drive" },
  { slug: "googledocs", name: "Google Docs" },
  { slug: "hubspot", name: "HubSpot" },
  { slug: "linear", name: "Linear" },
  { slug: "airtable", name: "Airtable" },
  { slug: "jira", name: "Jira" },
  { slug: "youtube", name: "YouTube" },
  { slug: "bitbucket", name: "Bitbucket" },
  { slug: "googletasks", name: "Google Tasks" },
  { slug: "discord", name: "Discord" },
  { slug: "figma", name: "Figma" },
  { slug: "reddit", name: "Reddit" },
  { slug: "sentry", name: "Sentry" },
  { slug: "snowflake", name: "Snowflake" },
  { slug: "elevenlabs", name: "ElevenLabs" },
  { slug: "microsoft_teams", name: "Microsoft Teams" },
  { slug: "asana", name: "Asana" },
  { slug: "shopify", name: "Shopify" },
  { slug: "linkedin", name: "LinkedIn" },
  { slug: "google_maps", name: "Google Maps" },
  { slug: "one_drive", name: "OneDrive" },
  { slug: "docusign", name: "DocuSign" },
  { slug: "salesforce", name: "Salesforce" },
  { slug: "calendly", name: "Calendly" },
  { slug: "trello", name: "Trello" },
];

export const FALLBACK_LANDING_TOOLKITS: LandingToolkit[] = FALLBACK_APPS.map(
  (app) => ({
    ...app,
    logoUrl: logoUrlFor(app.slug),
  }),
);

export function sanitizeLandingToolkit(value: unknown): LandingToolkit | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const slug = String(row.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  const name = String(row.name || slug).trim().slice(0, 80);
  const logoUrl = String(row.logoUrl || "").trim();
  if (!name || !logoUrl.startsWith(COMPOSIO_LOGO_PREFIX)) return null;
  return { slug, name, logoUrl };
}
