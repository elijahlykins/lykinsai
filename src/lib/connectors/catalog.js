// ──────────────────────────────────────────────────────────────────────
// Connector catalog
//
// This is the single source of truth for "what can plug into LYKN."
// The Connections page renders cards from this list, but the same
// catalog is intended to drive provider adapters in the future
// (OAuth flows, sync workers, AI tool registrations, etc.).
//
// Status legend
//   "available"     – fully wired today (capture-only paths, RSS, etc.)
//   "beta"          – live but limited (e.g. share-target Phase 1 surfaces)
//   "soon"          – planned next, OAuth not yet built
//   "verification"  – planned but blocked on platform verification
//   "paid"          – planned but blocked on a paid API tier
//   "no-api"        – platform exposes nothing useful; capture-only path
// ──────────────────────────────────────────────────────────────────────

export const CONNECTOR_CATEGORIES = [
  {
    id: "social",
    label: "Social & Content",
    description: "Auto-pull saved posts, liked videos, bookmarks, and feeds.",
  },
  {
    id: "productivity",
    label: "Productivity & Docs",
    description: "Bring your notes, docs, calendars, and tasks into the vault.",
  },
  {
    id: "design",
    label: "Design & Media",
    description: "Reference design files, recordings, and creative assets.",
  },
  {
    id: "read",
    label: "Read-it-later & Highlights",
    description: "Articles, books, and highlights from across the web.",
  },
  {
    id: "music",
    label: "Music & Audio",
    description: "Saved tracks, albums, podcasts.",
  },
  {
    id: "health",
    label: "Health & Activity",
    description: "Workouts, sleep, recovery, and other body-level signals.",
  },
  {
    id: "capture",
    label: "Universal Capture",
    description: "Catch-all surfaces that work on any platform or device.",
  },
  {
    id: "automation",
    label: "Automation & AI",
    description: "Wire LYKN into agent ecosystems and automation tools.",
  },
];

export const CONNECTORS = [
  // ── Social & Content ─────────────────────────────────────────────
  {
    id: "twitch",
    category: "social",
    name: "Twitch",
    domain: "twitch.tv",
    color: "#9146FF",
    auth: "Twitch OAuth",
    pulls: ["Followed channels", "Saved clips"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Channels you follow and clips you save flow into your Vault. Read-only. Adapter not wired yet.",
  },
  {
    id: "threads",
    category: "social",
    name: "Threads",
    domain: "threads.net",
    color: "#000000",
    auth: "Meta OAuth",
    pulls: ["Your threads", "Bookmarks (when scope granted)"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Meta's Threads API exposes your posts and (with the right scope) bookmarks. Adapter not wired yet.",
  },
  {
    id: "tumblr",
    category: "social",
    name: "Tumblr",
    domain: "tumblr.com",
    color: "#36465D",
    auth: "Tumblr OAuth",
    pulls: ["Liked posts"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Auto-imports every post you like on Tumblr. Read-only. Adapter not wired yet.",
  },
  {
    id: "linkedin",
    category: "social",
    name: "LinkedIn",
    domain: "linkedin.com",
    color: "#0A66C2",
    auth: "LinkedIn OAuth",
    pulls: ["Profile", "Your posts", "Saved items (when scope granted)"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "LinkedIn's API exposes profile + your posts on the open tier; saved items require Marketing Developer Platform access. Adapter not wired yet.",
  },
  {
    id: "instagram",
    category: "social",
    name: "Instagram",
    domain: "instagram.com",
    color: "#E1306C",
    auth: "n/a",
    pulls: ["Capture-only via Share button"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Instagram doesn't expose Saved posts via API. Use the Save to LYKN button or share sheet.",
  },
  {
    id: "tiktok",
    category: "social",
    name: "TikTok",
    domain: "tiktok.com",
    color: "#010101",
    auth: "n/a",
    pulls: ["Capture-only via Share button"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "TikTok's API doesn't expose Favorites. Use the Save to LYKN button or share sheet.",
  },
  {
    id: "facebook",
    category: "social",
    name: "Facebook",
    domain: "facebook.com",
    color: "#1877F2",
    auth: "n/a",
    pulls: ["Capture-only via Share button"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Facebook's Graph API doesn't expose Saved items. Use the Save to LYKN button or share sheet.",
  },

  // ── Productivity & Docs ──────────────────────────────────────────
  {
    id: "notion",
    category: "productivity",
    name: "Notion",
    domain: "notion.so",
    color: "#000000",
    auth: "Notion OAuth",
    pulls: ["Pages you grant access to"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary: "Workspace pages you share with LYKN become searchable inside the Vault.",
  },
  // Google Keep has no consumer API - Google explicitly restricts the
  // Keep REST API to Workspace accounts and excludes @gmail.com users
  // (see https://developers.google.com/keep/api/reference/rest). We
  // surface the tile as `no-api` / capture-only so users still get a
  // clear story for "how do my Keep notes get into LYKN" - same shape
  // as the Instagram / Figma / Behance tiles below. Capture paths:
  // browser extension on keep.google.com, mobile share sheet from the
  // Keep Android app, and Email-to-Vault forwarding.
  {
    id: "google-keep",
    category: "productivity",
    name: "Google Keep",
    domain: "keep.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
    color: "#FFBB00",
    auth: "n/a",
    pulls: ["Capture-only via Share button or extension"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Google Keep's REST API is Workspace-only and excludes personal Gmail accounts. Save individual Keep notes via the Save to LYKN button or the mobile share sheet.",
  },
  // Google family (Drive / Docs / Sheets / Calendar / Gmail / YouTube).
  // All share one OAuth client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`).
  // Status: `verification` - adapters are live and the handshake works
  // for Google Cloud test users today; production users see Google's
  // "unverified app" warning and have to click through. Brand
  // verification submission is the unlock for a clean consent screen.
  {
    id: "youtube",
    category: "social",
    name: "YouTube",
    domain: "youtube.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
    color: "#FF0033",
    auth: "Google OAuth",
    pulls: ["Liked videos"],
    realtime: "Polling (60 min)",
    status: "verification",
    statusLabel: "Pending Google review",
    summary:
      "Auto-imports every video you Like. Pre-verification: Google Cloud test users only - others see an unverified-app warning.",
  },
  {
    id: "google-drive",
    category: "productivity",
    name: "Google Drive",
    domain: "drive.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
    color: "#1FA463",
    auth: "Google OAuth",
    pulls: ["Starred files (metadata only)"],
    realtime: "Polling (60 min)",
    status: "verification",
    statusLabel: "Pending Google review",
    summary:
      "Surfaces every starred file in your Drive. Pre-verification: Google Cloud test users only.",
  },
  // `aliasOf` tiles share the underlying OAuth handshake AND the
  // `social_connections` row of their parent connector. The user clicks
  // Connect once on any of (Drive / Docs / Sheets) and all three tiles
  // light up green, then Drive's sync routes items into per-app sources
  // (gdocs_starred, gsheets_starred) so each lands under its own
  // collapsed folder tile in the Vault.
  {
    id: "google-docs",
    category: "productivity",
    name: "Google Docs",
    domain: "docs.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
    color: "#4285F4",
    auth: "Google OAuth",
    pulls: ["Starred Google Docs"],
    realtime: "Polling (60 min)",
    status: "verification",
    statusLabel: "Pending Google review",
    summary:
      "Every Google Doc you star lands in your Vault. Shares a single Google sign-in with Drive and Sheets.",
    aliasOf: "google-drive",
  },
  {
    id: "google-sheets",
    category: "productivity",
    name: "Google Sheets",
    domain: "sheets.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
    color: "#0F9D58",
    auth: "Google OAuth",
    pulls: ["Starred Google Sheets"],
    realtime: "Polling (60 min)",
    status: "verification",
    statusLabel: "Pending Google review",
    summary:
      "Every Google Sheet you star lands in your Vault. Shares a single Google sign-in with Drive and Docs.",
    aliasOf: "google-drive",
  },
  {
    id: "google-calendar",
    category: "productivity",
    name: "Google Calendar",
    domain: "calendar.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
    color: "#4285F4",
    auth: "Google OAuth",
    pulls: ["Upcoming events (30 days)"],
    realtime: "Polling (60 min)",
    status: "verification",
    statusLabel: "Pending Google review",
    summary:
      "Imports events from your primary calendar onto your LYKN calendar (read-only) and into your Vault. Pre-verification: Google Cloud test users only.",
  },
  {
    id: "gmail",
    category: "productivity",
    name: "Gmail",
    domain: "mail.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
    color: "#EA4335",
    auth: "Google OAuth",
    pulls: ["Starred emails"],
    realtime: "Polling (60 min)",
    status: "verification",
    statusLabel: "Pending Google review (restricted scope)",
    summary:
      "Captures every starred email. Pre-verification: Google Cloud test users only.",
  },

  // Microsoft 365 family (outlook-365 parent + ms-teams / onedrive /
  // onenote aliases). Parent removed from the catalog while we hold off
  // on Azure publisher verification. Aliases below are kept as "soon"
  // placeholders so the relationship is documented for future restore;
  // the status filter on the Connections page hides them today.
  {
    id: "ms-teams",
    category: "productivity",
    name: "Microsoft Teams",
    domain: "teams.microsoft.com",
    color: "#4B53BC",
    auth: "Microsoft Graph",
    pulls: ["Saved Teams messages"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Saved messages from your Teams workspace become searchable in your Vault. Shares a single Microsoft sign-in with Outlook, OneDrive, and OneNote.",
    aliasOf: "outlook-365",
  },
  {
    id: "onedrive",
    category: "productivity",
    name: "OneDrive",
    domain: "onedrive.live.com",
    color: "#0078D4",
    auth: "Microsoft Graph",
    pulls: ["Files you mark as Favorite"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Files you favorite in OneDrive land in your Vault. Shares a single Microsoft sign-in with Outlook, Teams, and OneNote.",
    aliasOf: "outlook-365",
  },
  {
    id: "onenote",
    category: "productivity",
    name: "OneNote",
    domain: "onenote.com",
    color: "#7719AA",
    auth: "Microsoft Graph",
    pulls: ["Recent notebook pages"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Recent OneNote pages flow into your Vault. Shares a single Microsoft sign-in with Outlook, Teams, and OneDrive.",
    aliasOf: "outlook-365",
  },
  {
    id: "dropbox",
    category: "productivity",
    name: "Dropbox",
    domain: "dropbox.com",
    color: "#0061FF",
    auth: "Dropbox OAuth",
    pulls: ["Starred files and folders"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Files you star in Dropbox land in your Vault. Read-only. Adapter not wired yet.",
  },
  {
    id: "slack",
    category: "productivity",
    name: "Slack",
    domain: "slack.com",
    color: "#4A154B",
    auth: "Slack OAuth",
    pulls: ["Saved messages"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary: "Auto-imports every message you save in Slack. Read-only, single workspace per connection.",
  },
  {
    id: "github",
    category: "productivity",
    name: "GitHub",
    domain: "github.com",
    color: "#181717",
    auth: "GitHub OAuth",
    pulls: ["Starred repos"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary: "Auto-imports every repo you star into your Vault. Read-only, no posts.",
  },
  {
    id: "gitlab",
    category: "productivity",
    name: "GitLab",
    domain: "gitlab.com",
    color: "#FC6D26",
    auth: "GitLab OAuth",
    pulls: ["Starred projects", "Issues assigned to you"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Starred projects and open issues from GitLab.com (or self-hosted instances) land in your Vault. Read-only. Adapter not wired yet.",
  },
  {
    id: "stackoverflow",
    category: "productivity",
    name: "Stack Overflow",
    domain: "stackoverflow.com",
    color: "#F48024",
    auth: "Stack Exchange OAuth",
    pulls: ["Saved questions", "Your answers"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Saved Stack Overflow questions become searchable in your Vault. One sign-in covers every Stack Exchange site. Adapter not wired yet.",
  },
  {
    id: "linear",
    category: "productivity",
    name: "Linear",
    domain: "linear.app",
    color: "#5E6AD2",
    auth: "Linear OAuth",
    pulls: ["Issues assigned to you"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary: "Open issues assigned to you become actionable cards in your Vault.",
  },
  {
    id: "todoist",
    category: "productivity",
    name: "Todoist",
    domain: "todoist.com",
    color: "#E44232",
    auth: "Todoist OAuth",
    pulls: ["Active tasks"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary: "Active tasks land in your Vault alongside everything else you capture.",
  },
  {
    id: "trello",
    category: "productivity",
    name: "Trello",
    domain: "trello.com",
    color: "#0079BF",
    auth: "User token",
    pulls: ["Open cards from your starred boards"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary:
      "Auto-imports open cards from boards you've starred in Trello. Read-only, revocable from your Trello account settings.",
    authMode: "token",
    connectFields: [
      {
        name: "token",
        label: "Trello user token",
        placeholder: "Paste the token Trello shows you",
        secret: true,
        required: true,
        helpText:
          "Generated by Trello after you approve LYKN. Use the link below to start.",
      },
    ],
    // tokenHelpUrl is filled in dynamically by the server because it
    // needs to embed our app's TRELLO_API_KEY.
  },

  {
    id: "things",
    category: "productivity",
    name: "Things 3",
    domain: "culturedcode.com",
    color: "#1E62E2",
    auth: "n/a",
    pulls: ["Capture-only via Things URL scheme or share"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Things 3 has no cloud API. Capture tasks via the macOS/iOS share sheet or the things:/// URL scheme.",
  },
  {
    id: "ticktick",
    category: "productivity",
    name: "TickTick",
    domain: "ticktick.com",
    color: "#1FA463",
    auth: "TickTick OAuth",
    pulls: ["Active tasks"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Active TickTick tasks flow into your Vault. Adapter not wired yet.",
  },
  {
    id: "apple-reminders",
    category: "productivity",
    name: "Apple Reminders",
    domain: "icloud.com",
    color: "#FF9F0A",
    auth: "n/a",
    pulls: ["Capture-only via Share or Shortcuts"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Apple Reminders has no public API. Use the iOS/macOS share sheet or an Apple Shortcut to push reminders into LYKN.",
  },
  {
    id: "apple-calendar",
    category: "productivity",
    name: "Apple Calendar",
    domain: "icloud.com",
    color: "#FF3B30",
    auth: "App-specific password",
    authMode: "token",
    pulls: ["Events (−7 to +30 days)"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary:
      "Syncs your iCloud calendars onto your LYKN calendar (read-only) and into your Vault. Uses an app-specific password, never your Apple ID password.",
    accessNote:
      "Read-only over iCloud CalDAV. The app-specific password is encrypted at rest and grants only calendar access. Revoke it any time at appleid.apple.com or here.",
    connectFields: [
      {
        name: "email",
        label: "Apple ID email",
        placeholder: "you@icloud.com",
        secret: false,
        required: true,
      },
      {
        name: "password",
        label: "App-specific password",
        placeholder: "abcd-efgh-ijkl-mnop",
        secret: true,
        required: true,
        helpText:
          "Generate at appleid.apple.com → Sign-In & Security → App-Specific Passwords. This is NOT your Apple ID password.",
      },
    ],
    tokenHelpUrl: "https://appleid.apple.com/account/manage",
    tokenHelpLabel: "Create an app-specific password",
  },
  {
    id: "discord",
    category: "productivity",
    name: "Discord",
    domain: "discord.com",
    color: "#5865F2",
    auth: "n/a",
    pulls: ["Capture-only via message share"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Discord's API gates personal-message access to verified bots. Capture individual messages via the LYKN browser extension or share links.",
  },
  {
    id: "telegram",
    category: "productivity",
    name: "Telegram",
    domain: "telegram.org",
    color: "#229ED9",
    auth: "n/a",
    pulls: ["Capture-only via share or Saved Messages forwarding"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Telegram's Bot API can't read your own Saved Messages chat. Forward messages to a LYKN bot, or use the share sheet.",
  },
  {
    id: "whatsapp",
    category: "productivity",
    name: "WhatsApp",
    domain: "whatsapp.com",
    color: "#25D366",
    auth: "n/a",
    pulls: ["Capture-only via Share or Email-to-Vault"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "WhatsApp's API is business-only and personal chats aren't accessible. Use the Share sheet to send individual messages or links to LYKN.",
  },
  {
    id: "signal",
    category: "productivity",
    name: "Signal",
    domain: "signal.org",
    color: "#3A76F0",
    auth: "n/a",
    pulls: ["Capture-only via Share or Email-to-Vault"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Signal is end-to-end encrypted and has no public API by design. Use the Share sheet from inside Signal to send links to LYKN.",
  },
  {
    id: "imessage",
    category: "productivity",
    name: "iMessage",
    domain: "apple.com",
    color: "#34C759",
    auth: "n/a",
    pulls: ["Capture-only via Share or Email-to-Vault"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "iMessage has no public API. Use the iOS/macOS share sheet from a conversation to push links or text into LYKN.",
  },
  {
    id: "asana",
    category: "productivity",
    name: "Asana",
    domain: "asana.com",
    color: "#F06A6A",
    auth: "Asana OAuth",
    pulls: ["Tasks assigned to you", "Starred projects"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Task ownership and project trees teach LYKN where your week's effort is actually going. Adapter not wired yet.",
  },
  {
    id: "clickup",
    category: "productivity",
    name: "ClickUp",
    domain: "clickup.com",
    color: "#7B68EE",
    auth: "ClickUp OAuth",
    pulls: ["Tasks assigned to you"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Active tasks land in your Vault alongside everything else. Adapter not wired yet.",
  },
  {
    id: "jira",
    category: "productivity",
    name: "Jira",
    domain: "atlassian.com",
    color: "#0052CC",
    auth: "Atlassian OAuth",
    pulls: ["Issues assigned to you"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Open issues assigned to you become actionable cards. Adapter not wired yet.",
  },
  {
    id: "confluence",
    category: "productivity",
    name: "Confluence",
    domain: "atlassian.com",
    color: "#172B4D",
    auth: "Atlassian OAuth",
    pulls: ["Pages you've authored or starred"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Confluence pages flow into your Vault. Shares an Atlassian sign-in with Jira. Adapter not wired yet.",
    aliasOf: "jira",
  },
  {
    id: "airtable",
    category: "productivity",
    name: "Airtable",
    domain: "airtable.com",
    color: "#FCB400",
    auth: "Airtable OAuth",
    pulls: ["Bases and views you grant access to"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Records from bases you share with LYKN become searchable in the Vault. Adapter not wired yet.",
  },
  {
    id: "coda",
    category: "productivity",
    name: "Coda",
    domain: "coda.io",
    color: "#F46A54",
    auth: "Coda API token",
    pulls: ["Docs you grant access to"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Coda docs you share with LYKN become searchable in the Vault. Adapter not wired yet.",
  },
  {
    id: "obsidian",
    category: "productivity",
    name: "Obsidian",
    domain: "obsidian.md",
    color: "#7C3AED",
    auth: "n/a",
    pulls: ["Capture-only via browser extension or vault sync"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Obsidian vaults are local Markdown - no cloud API. Use the LYKN browser extension on Obsidian Publish pages, or paste vault file contents. Future: optional vault-folder bridge over Dropbox/iCloud.",
  },
  {
    id: "logseq",
    category: "productivity",
    name: "Logseq",
    domain: "logseq.com",
    color: "#002B36",
    auth: "n/a",
    pulls: ["Capture-only via browser extension or graph sync"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Logseq graphs are local Markdown - no cloud API. Use the LYKN browser extension or paste page contents.",
  },
  {
    id: "apple-notes",
    category: "productivity",
    name: "Apple Notes",
    domain: "icloud.com",
    color: "#FFC107",
    auth: "n/a",
    pulls: ["Capture-only via Share sheet or email"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Apple Notes has no public API. Share individual notes to LYKN via the iOS/macOS Share sheet or forward to Email-to-Vault.",
  },
  {
    id: "bear",
    category: "productivity",
    name: "Bear",
    domain: "bear.app",
    color: "#FE3F4F",
    auth: "n/a",
    pulls: ["Capture-only via x-callback-url or share sheet"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Bear has no remote API. Share individual notes via the iOS/macOS share sheet, or use x-callback-url shortcuts to push selected notes to LYKN.",
  },
  {
    id: "craft",
    category: "productivity",
    name: "Craft",
    domain: "craft.do",
    color: "#F4511E",
    auth: "n/a",
    pulls: ["Capture-only via share or public-link import"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Craft's API is limited to authoring. Share individual documents to LYKN via the Share sheet, or paste a public Craft link.",
  },
  {
    id: "roam",
    category: "productivity",
    name: "Roam Research",
    domain: "roamresearch.com",
    color: "#2E2E2E",
    auth: "n/a",
    pulls: ["Capture-only via browser extension or graph export"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Roam's API is read-only on Pro and primarily for backups. Use the LYKN browser extension or import a graph JSON export.",
  },
  {
    id: "tana",
    category: "productivity",
    name: "Tana",
    domain: "tana.inc",
    color: "#000000",
    auth: "n/a",
    pulls: ["Capture-only via browser extension or push-to-Tana mirror"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Tana's API is write-only (Tana Input). Capture individual nodes via the LYKN browser extension or paste shared Tana links.",
  },
  {
    id: "mem",
    category: "productivity",
    name: "Mem",
    domain: "mem.ai",
    color: "#5436DA",
    auth: "n/a",
    pulls: ["Capture-only via Share or shortcut"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Mem's public API is limited and gated. Save individual mems via the Share sheet or paste a shared link.",
  },
  {
    id: "capacities",
    category: "productivity",
    name: "Capacities",
    domain: "capacities.io",
    color: "#3B82F6",
    auth: "n/a",
    pulls: ["Capture-only via share or public-link import"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Capacities has no public sync API. Share individual objects via the share sheet or paste public links.",
  },
  {
    id: "evernote",
    category: "productivity",
    name: "Evernote",
    domain: "evernote.com",
    color: "#00A82D",
    auth: "Evernote OAuth",
    pulls: ["Notebooks you grant access to"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Notebooks you share with LYKN become searchable in your Vault. Read-only. Adapter not wired yet.",
  },
  {
    id: "day-one",
    category: "productivity",
    name: "Day One",
    domain: "dayoneapp.com",
    color: "#44C8F5",
    auth: "n/a",
    pulls: ["Capture-only via Share sheet or JSON export"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Day One has no public sync API. Share entries via the iOS/macOS share sheet, or import a JSON export of your journal.",
  },

  // ── Design & Media ───────────────────────────────────────────────
  {
    id: "arena",
    category: "design",
    name: "Are.na",
    domain: "are.na",
    color: "#000000",
    auth: "Are.na OAuth",
    pulls: ["Your channels", "Blocks in channels you've connected"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Channels become folders, blocks become vault items - Are.na's mental model maps 1:1 to LYKN. Adapter not wired yet.",
  },
  {
    id: "figma",
    category: "design",
    name: "Figma",
    domain: "figma.com",
    color: "#F24E1E",
    auth: "Figma OAuth",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Figma's API doesn't expose a 'list my files' endpoint, so auto-import isn't possible. Save individual Figma files via the Save to LYKN button or paste a file URL.",
  },
  {
    id: "loom",
    category: "design",
    name: "Loom",
    domain: "loom.com",
    color: "#625DF5",
    auth: "Loom OAuth",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Enterprise API only",
    summary:
      "Loom's REST API is gated to their Enterprise/SDK tier. Save individual Loom videos via the Save to LYKN button.",
  },
  {
    id: "behance",
    category: "design",
    name: "Behance",
    domain: "behance.net",
    color: "#1769FF",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "API deprecated",
    summary:
      "Adobe deprecated the public Behance API in 2020. Save individual Behance projects via the Save to LYKN button.",
  },

  {
    id: "cosmos",
    category: "design",
    name: "Cosmos",
    domain: "cosmos.so",
    color: "#000000",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Cosmos has no public API. Save individual clusters/posts via the LYKN browser extension or paste shared links.",
  },
  {
    id: "eagle",
    category: "design",
    name: "Eagle",
    domain: "eagle.cool",
    color: "#0061FF",
    auth: "Local API",
    pulls: ["Capture-only via local Eagle API"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Eagle runs locally and exposes a localhost API only. Capture items via the LYKN browser extension; a future bridge could read from Eagle's local HTTP API when both apps run on the same machine.",
  },
  {
    id: "savee",
    category: "design",
    name: "Savee.it",
    domain: "savee.it",
    color: "#000000",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Savee has no public API. Save individual posts via the LYKN browser extension or paste shared links.",
  },
  {
    id: "mymind",
    category: "design",
    name: "Mymind",
    domain: "mymind.com",
    color: "#000000",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Mymind has no public API by design. Save items in parallel via the LYKN browser extension or share sheet.",
  },
  {
    id: "anybox",
    category: "design",
    name: "Anybox",
    domain: "anybox.app",
    color: "#1D4ED8",
    auth: "n/a",
    pulls: ["Capture-only via Share sheet"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Anybox is Mac/iOS-only with no public cloud API. Use the share sheet from inside Anybox to forward links to LYKN.",
  },
  {
    id: "goodlinks",
    category: "design",
    name: "GoodLinks",
    domain: "goodlinks.app",
    color: "#1F2937",
    auth: "n/a",
    pulls: ["Capture-only via Share sheet"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "GoodLinks has no public sync API. Use the iOS/macOS share sheet to push links from GoodLinks into LYKN.",
  },

  // ── Read-it-later & Highlights ────────────────────────────────────
  {
    id: "storygraph",
    category: "read",
    name: "The StoryGraph",
    domain: "thestorygraph.com",
    color: "#E5673B",
    auth: "n/a",
    pulls: ["Capture-only via Share or CSV export"],
    realtime: "On capture",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "StoryGraph has no public API yet. Import your library via a CSV export, or save individual books via the LYKN browser extension.",
  },
  {
    id: "audible",
    category: "read",
    name: "Audible",
    domain: "audible.com",
    color: "#F8991C",
    auth: "n/a",
    pulls: ["Capture-only via share"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Audible's API is closed to third parties. Save individual audiobooks via the LYKN browser extension or share sheet.",
  },
  {
    id: "apple-books",
    category: "read",
    name: "Apple Books",
    domain: "apple.com",
    color: "#FF5E3A",
    auth: "n/a",
    pulls: ["Highlights via Readwise"],
    realtime: "Via Readwise",
    status: "no-api",
    statusLabel: "Use Readwise bridge",
    summary:
      "Apple Books has no public sync API. Connect Readwise - its Apple Books importer pulls your highlights, which then flow into LYKN.",
  },
  {
    id: "kobo",
    category: "read",
    name: "Kobo",
    domain: "kobo.com",
    color: "#D71D24",
    auth: "n/a",
    pulls: ["Highlights via Readwise"],
    realtime: "Via Readwise",
    status: "no-api",
    statusLabel: "Use Readwise bridge",
    summary:
      "Kobo has no public sync API. Connect Readwise - its Kobo importer pulls your highlights, which then flow into LYKN.",
  },
  {
    id: "raindrop",
    category: "read",
    name: "Raindrop.io",
    domain: "raindrop.io",
    color: "#0B7CFF",
    auth: "Raindrop OAuth",
    pulls: ["All bookmarks"],
    realtime: "Polling (60 min)",
    status: "available",
    statusLabel: "Live",
    summary: "Every bookmark you save in Raindrop flows into your Vault. Read-only.",
  },
  {
    id: "instapaper",
    category: "read",
    name: "Instapaper",
    domain: "instapaper.com",
    color: "#1F1F1F",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "API deprecated",
    summary:
      "Instapaper's xAuth API has been deprecated with no replacement. Save individual articles via the Save to LYKN button.",
  },
  {
    id: "matter",
    category: "read",
    name: "Matter",
    domain: "hq.getmatter.com",
    color: "#1B1B1B",
    auth: "Via Readwise",
    pulls: ["Saved articles", "Highlights"],
    realtime: "Via Readwise",
    status: "no-api",
    statusLabel: "Use Readwise bridge",
    summary:
      "Matter has no public API. Enable Matter's built-in 'Auto-export to Readwise' setting, then connect Readwise here - your Matter highlights flow in via Readwise.",
  },
  {
    id: "pocket",
    category: "read",
    name: "Pocket",
    domain: "getpocket.com",
    color: "#EF4056",
    auth: "Consumer key",
    pulls: ["Archive (one-time import only)"],
    realtime: "Import",
    status: "no-api",
    statusLabel: "Sunsetting",
    summary:
      "Mozilla is shutting Pocket down. Use the import path to bring your archive into LYKN.",
  },

  // ── Music & Audio ────────────────────────────────────────────────
  {
    id: "youtube-music",
    category: "music",
    name: "YouTube Music",
    domain: "music.youtube.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
    color: "#FF0000",
    auth: "Google OAuth",
    pulls: ["Liked songs", "Library uploads"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Auto-imports every song you Like on YouTube Music. Shares a single Google sign-in with YouTube and Drive. Adapter not wired yet.",
    aliasOf: "youtube",
  },
  {
    id: "discogs",
    category: "music",
    name: "Discogs",
    domain: "discogs.com",
    color: "#000000",
    auth: "Discogs OAuth",
    pulls: ["Your collection", "Wantlist"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Auto-imports your record collection and wantlist from Discogs. Read-only. Adapter not wired yet.",
  },
  {
    id: "snipd",
    category: "music",
    name: "Snipd",
    domain: "snipd.com",
    color: "#7C3AED",
    auth: "Via Readwise",
    pulls: ["Snips and podcast highlights"],
    realtime: "Via Readwise",
    status: "no-api",
    statusLabel: "Use Readwise bridge",
    summary:
      "Snipd has no public API yet, but ships a first-class \"Auto-export to Readwise\" integration. Enable it in Snipd, then connect Readwise here - your snips flow in via Readwise.",
  },
  {
    id: "pocket-casts",
    category: "music",
    name: "Pocket Casts",
    domain: "pocketcasts.com",
    color: "#F43E37",
    auth: "Email + password",
    pulls: ["Starred episodes", "Subscriptions"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Starred podcast episodes from Pocket Casts land in your Vault. Adapter not wired yet.",
  },
  {
    id: "apple-podcasts",
    category: "music",
    name: "Apple Podcasts",
    domain: "apple.com",
    color: "#9933CC",
    auth: "n/a",
    pulls: ["Capture-only via Share or RSS"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Apple Podcasts has no public sync API. Share individual episodes via the iOS/macOS share sheet, or subscribe to a show's RSS feed under the RSS connector.",
  },
  {
    id: "overcast",
    category: "music",
    name: "Overcast",
    domain: "overcast.fm",
    color: "#FC7E0F",
    auth: "OPML export",
    pulls: ["Subscriptions via OPML"],
    realtime: "On import",
    status: "no-api",
    statusLabel: "OPML import only",
    summary:
      "Overcast has no remote API. Export your subscriptions as OPML and import - episodes then flow into LYKN via their show RSS feeds.",
  },
  {
    id: "castro",
    category: "music",
    name: "Castro",
    domain: "castro.fm",
    color: "#553333",
    auth: "n/a",
    pulls: ["Capture-only via Share"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Castro has no public API. Share individual episodes from inside Castro to forward them to LYKN.",
  },
  {
    id: "castbox",
    category: "music",
    name: "Castbox",
    domain: "castbox.fm",
    color: "#F55B23",
    auth: "n/a",
    pulls: ["Capture-only via Share"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Castbox has no public sync API. Share individual episodes via the share sheet to push them to LYKN.",
  },
  {
    id: "apple-music",
    category: "music",
    name: "Apple Music",
    domain: "music.apple.com",
    color: "#FA243C",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Apple Music's library API is browser-only (MusicKit JS) and can't be polled server-side. Save individual tracks, albums, or playlists via the Save to LYKN button.",
  },
  {
    id: "soundcloud",
    category: "music",
    name: "SoundCloud",
    domain: "soundcloud.com",
    color: "#FF5500",
    auth: "SoundCloud OAuth",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Registrations closed",
    summary:
      "SoundCloud closed new API app registrations in 2019. Save individual tracks via the Save to LYKN button.",
  },
  {
    id: "bandcamp",
    category: "music",
    name: "Bandcamp",
    domain: "bandcamp.com",
    color: "#1DA0C3",
    auth: "n/a",
    pulls: ["Capture-only via Save to LYKN"],
    realtime: "On share",
    status: "no-api",
    statusLabel: "Capture only",
    summary:
      "Bandcamp's public API is limited to artist-side reporting. Save individual albums or tracks via the LYKN browser extension or share sheet.",
  },

  // ── Health & Activity ────────────────────────────────────────────
  {
    id: "strava",
    category: "health",
    name: "Strava",
    domain: "strava.com",
    color: "#FC4C02",
    auth: "Strava OAuth",
    pulls: ["Activities", "Starred routes"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Recorded activities and starred routes flow into your Vault. Read-only. Adapter not wired yet.",
  },
  {
    id: "oura",
    category: "health",
    name: "Oura",
    domain: "ouraring.com",
    color: "#000000",
    auth: "Oura OAuth",
    pulls: ["Daily sleep, readiness, and activity summaries"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Daily Oura ring summaries (sleep, readiness, activity) land in your Vault as daily-context items. Adapter not wired yet.",
  },
  {
    id: "whoop",
    category: "health",
    name: "WHOOP",
    domain: "whoop.com",
    color: "#000000",
    auth: "WHOOP OAuth",
    pulls: ["Recovery, sleep, and workout summaries"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Daily WHOOP summaries (recovery, strain, sleep, workouts) flow into your Vault. Adapter not wired yet.",
  },
  {
    id: "garmin",
    category: "health",
    name: "Garmin Connect",
    domain: "garmin.com",
    color: "#007CC3",
    auth: "Garmin OAuth",
    pulls: ["Activities", "Daily stats"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Activities and daily stats from Garmin Connect flow into your Vault. Adapter not wired yet - Garmin requires a registered developer program account.",
  },
  {
    id: "fitbit",
    category: "health",
    name: "Fitbit",
    domain: "fitbit.com",
    color: "#00B0B9",
    auth: "Fitbit OAuth",
    pulls: ["Activity", "Sleep", "Heart rate trends"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Activity, sleep, and heart-rate trend summaries from Fitbit flow into your Vault. Adapter not wired yet.",
  },
  {
    id: "withings",
    category: "health",
    name: "Withings",
    domain: "withings.com",
    color: "#00C7B1",
    auth: "Withings OAuth",
    pulls: ["Weight", "Sleep", "Activity"],
    realtime: "Polling (60 min)",
    status: "soon",
    statusLabel: "Coming soon",
    summary:
      "Daily Withings summaries (weight, sleep, activity) flow into your Vault. Adapter not wired yet.",
  },

  // Universal Capture surfaces (share-target / browser-extension /
  // bookmarklet) cut from the Connections page launch lineup pending a
  // user-visible polish pass. Code paths still live in extensions/ and
  // public manifests - re-adding them is a catalog copy-back when ready.
  {
    id: "email-to-vault",
    category: "capture",
    name: "Email to Vault",
    color: "#111827",
    auth: "Per-user inbound address",
    pulls: ["Anything emailed to your alias"],
    realtime: "Inbound webhook",
    status: "soon",
    summary:
      "A unique email address for your vault. Forward newsletters, share links, anything.",
  },
  // ── Automation & AI ──────────────────────────────────────────────
  // Universal bring-your-own-API-key tile. Unlike every other connector,
  // this isn't a single provider - it's an entry point to attach ANY app by
  // base URL + API key. The grid opens CustomApiDialog (customApi flag) where
  // the user manages their own list of connections. The LYKN agent then acts
  // on them via lykn_call_app.
  {
    id: "custom-api",
    category: "automation",
    name: "Custom API",
    domain: "",
    color: "#0F172A",
    auth: "API key",
    pulls: ["Let LYKN call any app you connect", "Read &/or write via your own API key"],
    realtime: "On request",
    status: "available",
    statusLabel: "Live",
    summary:
      "Connect ANY app with a base URL and an API key, and let LYKN act on it for you - read data, search, or (when you allow it) create and update. Your key is encrypted at rest and injected server-side; the agent never sees it.",
    customApi: true,
  },
  // Cursor is an ACTION connector, not a vault pull: attaching your own
  // Cursor account lets the LYKN agent hand coding tasks to a Cursor cloud
  // agent that builds on your repos and opens PRs. Token-paste (Cursor has
  // no third-party OAuth); the key is encrypted at rest like every other
  // credential and only ever runs on YOUR account.
  {
    id: "cursor",
    category: "automation",
    name: "Cursor",
    domain: "cursor.com",
    color: "#000000",
    auth: "API key",
    pulls: ["Runs coding builds on your repos", "Opens pull requests for you to review"],
    realtime: "On request",
    status: "available",
    statusLabel: "Live",
    summary:
      "Attach your own Cursor account so LYKN can hand coding tasks to a Cursor cloud agent. It builds on your repos and opens a PR for you to review, test, and deploy. Your API key is encrypted at rest and runs only on your account.",
    authMode: "token",
    accessNote:
      "LYKN uses this key to start cloud-agent builds on your account. Builds open pull requests - they never merge or deploy. Revoke any time from Cursor or here.",
    connectFields: [
      {
        name: "api_key",
        label: "Cursor API key",
        placeholder: "key_...",
        secret: true,
        required: true,
        helpText:
          "Create one at cursor.com/dashboard → Integrations (it needs Cloud Agents access). Connect your GitHub to Cursor too, so the agent can clone repos and open PRs.",
      },
      {
        name: "repo",
        label: "Default repo (optional)",
        placeholder: "https://github.com/you/your-repo",
        secret: false,
        required: false,
        helpText:
          "Used when you don't name a repo for a build. The agent can target any repo your Cursor key can reach.",
      },
    ],
  },
  {
    id: "mcp",
    category: "automation",
    name: "MCP Servers",
    color: "#0F172A",
    auth: "Remote MCP URL",
    pulls: ["Live tools from the source app"],
    realtime: "Live",
    status: "available",
    authMode: "mcp",
    // LYKN as MCP CLIENT: the user points LYKN at someone else's MCP
    // server and its tools become callable from LYKN chat. This is the
    // only MCP direction we support - LYKN is not exposed as an MCP
    // server to outside AI models.
    summary:
      "Point LYKN at any remote MCP server. Tools stay live in the source app. Vault is not used unless you explicitly save something.",
  },
  {
    id: "zapier",
    category: "automation",
    name: "Zapier",
    domain: "zapier.com",
    color: "#FF4A00",
    auth: "Zapier app",
    pulls: ["8000+ apps via triggers"],
    realtime: "On trigger",
    status: "soon",
    summary:
      "Wire LYKN into Zapier. Triggers fire when items are saved, actions create vault items.",
  },
  {
    id: "make",
    category: "automation",
    name: "Make.com",
    domain: "make.com",
    color: "#6D00CC",
    auth: "Make app",
    pulls: ["Any Make scenario"],
    realtime: "On trigger",
    status: "soon",
    summary: "Same as Zapier, for Make.com workflows.",
  },
  {
    id: "n8n",
    category: "automation",
    name: "n8n",
    domain: "n8n.io",
    color: "#EA4B71",
    auth: "n8n node",
    pulls: ["Self-hosted automations"],
    realtime: "On trigger",
    status: "soon",
    summary: "An n8n node so you can self-host LYKN automations.",
  },
];

export const CONNECTOR_STATUSES = {
  available: { label: "Available", tone: "emerald" },
  beta: { label: "Live", tone: "emerald" },
  soon: { label: "Coming soon", tone: "blue" },
  verification: { label: "In review", tone: "amber" },
  paid: { label: "Paid API only", tone: "amber" },
  "no-api": { label: "Capture only", tone: "neutral" },
};

// ──────────────────────────────────────────────────────────────────────
// Connector id → `notes.source` slugs
//
// Every adapter under `/connectors/*.js` calls `saveConnectorNote(...)`
// (or the Google/Apple equivalents) with a `source:` slug that lands on
// `notes.source`. The retrieval index keys provenance off that slug -
// `get_belief_provenance` / `get_connector_synthesis_counts` aggregate
// by `notes.source`, and the briefing / tile / graph UIs need to walk
// from a catalog connector id back to its slugs to render footer chips
// or to filter the synthesis view to a single app.
//
// Multi-slug entries handle adapters that split one connection into
// several sub-sources (Drive → Docs/Sheets/Slides via aliasOf; Gmail
// emits both starred + inbox slugs; Mastodon emits bookmarks +
// favourites). Aliased catalog tiles share their *parent* connector's
// OAuth handshake but get their own dedicated slug so the per-tile
// counts stay app-accurate (a Google Docs tile counts gdocs_starred,
// not the whole Drive pile).
//
// Catalog ids without a `notes.source` slug (capture-only / soon /
// no-api tiles, automation outbound entries) intentionally omit from
// this map - UIs gracefully render a zero-count footer for them.
export const CONNECTOR_NOTES_SOURCES = {
  // Productivity & docs
  notion: ["notion_page"],
  slack: ["slack_saved"],
  github: ["github_starred"],
  linear: ["linear_issue"],
  todoist: ["todoist_task"],
  trello: ["trello_card"],
  // Google family - each aliased tile maps to its specific slug so the
  // per-tile count reflects that app's items only.
  "google-drive": ["gdrive_starred", "gslides_starred"],
  "google-docs": ["gdocs_starred"],
  "google-sheets": ["gsheets_starred"],
  "google-calendar": ["gcal_event"],
  gmail: ["gmail_starred", "gmail_inbox"],
  "outlook-365": ["outlook_flagged"],
  // Read-it-later & highlights
  readwise: ["readwise"],
  raindrop: ["raindrop_bookmark"],
  pinboard: ["pinboard"],
  linkding: ["linkding"],
  karakeep: ["karakeep"],
  // Social & content
  x: ["x_bookmark"],
  bluesky: ["bluesky_like"],
  mastodon: ["mastodon_bookmark", "mastodon_favourite"],
  youtube: ["youtube_liked"],
  reddit: ["reddit_saved_post", "reddit_saved_comment"],
  hackernews: ["hackernews_favorite", "hackernews_submitted"],
  pinterest: ["pinterest_pin"],
  dribbble: ["dribbble_liked"],
  vimeo: ["vimeo_liked"],
  // Books & media
  goodreads: ["goodreads"],
  hardcover: ["hardcover"],
  "amazon-wishlist": ["amazon_wishlist"],
  // Music & audio
  spotify: ["spotify_liked"],
  lastfm: ["lastfm_loved"],
  // Design
  canva: ["canva_design"],
  // Apple
  "apple-reminders": [],
  "apple-calendar": ["apple_calendar_event"],
  // Health & activity - adapters aren't shipped yet but the slugs
  // they'll write are documented in src/lib/synthesis/loadInUpdates.ts.
  oura: ["oura_daily"],
  whoop: ["whoop_daily"],
  fitbit: ["fitbit_daily"],
  garmin: ["garmin_daily"],
  withings: ["withings_daily"],
  strava: ["strava_activity"],
};

/**
 * Resolve a connector id to the set of `notes.source` slugs that
 * adapter writes. Honors `aliasOf` so e.g. asking for "ms-teams" (whose
 * adapter isn't wired) does not silently fall back to the Microsoft
 * parent's slugs - only the parent's own tile aggregates those.
 *
 * @param {string} connectorId
 * @returns {string[]} list of `notes.source` slugs, possibly empty.
 */
export function getConnectorSourceSlugs(connectorId) {
  if (!connectorId) return [];
  return CONNECTOR_NOTES_SOURCES[connectorId] || [];
}
