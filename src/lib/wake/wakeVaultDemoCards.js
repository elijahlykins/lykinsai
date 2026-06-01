import lyknIconBlue from "@/assets/FINAL/LYKN-ICON-A-Squircle/PNGs/LYKN-Icon-A-Squircle-BLUE-master.png";
import lyknIconNeutral from "@/assets/FINAL/LYKN-ICON-A-Squircle/PNGs/LYKN-Icon-A-Squircle-NEUTRAL-master.png";
import lyknIconBlack from "@/assets/FINAL/LYKN-ICON-A-Squircle/PNGs/LYKN-Icon-A-Squircle-BLACK-master.png";
import lyknIconOpenBlue from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import lyknLogoOpenNeutral from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import lyknLogoOpenBlue from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import lyknLogoSquircleBlue from "@/assets/FINAL/LYKN-LOGO-A-Squircle/PNGs/LYKN-Logo-Primary-A-Squircle-BLUE-web.png";
import lyknWordmarkBlue from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLUE-web.png";

/** Same-origin demo PDFs — wake preview only, never written to a user's vault. */
const DEMO_PDF_URLS = {
  synthesis: "/wake-demo/lykn-synthesis-overview.pdf",
  mcp: "/wake-demo/lykn-mcp-spec.pdf",
};

function demoComment(id, text, daysAgo = 1) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    id: `wake-demo-comment-${id}`,
    text,
    created_at: d.toISOString(),
  };
}

/** Preview copy + seeded comments for wake demo cards (preview modal + grid badges). */
const WAKE_DEMO_CARD_META = {
  "wake-demo-notion-pages": {
    aiDescription:
      "Synced Notion workspace showing recent pages. Connector tiles collapse into one card so your vault stays scannable.",
    notes: [demoComment("notion-1", "Pin the synthesis spec — agents pull from it constantly.", 3)],
  },
  "wake-demo-drive-starred": {
    aiDescription:
      "Starred Google Drive folder with brand assets, decks, and tour recordings. Files stay linked without duplicating storage.",
  },
  "wake-demo-gmail-inbox": {
    aiDescription:
      "Gmail inbox snapshot with starred threads and billing alerts. Email saves land as searchable vault memories.",
    notes: [
      demoComment("gmail-1", "Investor prep thread has numbers we need for the deck.", 1),
      demoComment("gmail-2", "Follow up on agent studio feedback after the tour ships.", 4),
    ],
  },
  "wake-demo-calendar-events": {
    aiDescription:
      "This week's calendar — standups, design critiques, and community hours. Events sync as context for meeting prep agents.",
  },
  "wake-demo-lykn-icon-blue": {
    aiDescription:
      "Primary LYKN app icon in blue squircle form. PNG export at 1135×1135 for product chrome, favicons, and App Store assets.",
    notes: [
      demoComment("icon-blue-1", "Primary app icon and favicon. Use on dark backgrounds.", 2),
      demoComment("icon-blue-2", "Approved for App Store — do not recolor without brand review.", 6),
    ],
  },
  "wake-demo-quick-note": {
    aiDescription:
      "Scratchpad for vault captures this week — logos, PDFs, and planning docs to drop in before the team review.",
    comments: [demoComment("qn-1", "Add the synthesis one-pager once legal signs off.", 1)],
  },
  "wake-demo-video-pkm": {
    aiDescription:
      "Saved talk on personal knowledge systems. Key ideas: capture fast, synthesize later, let AI read your corpus instead of re-explaining context.",
    notes: [demoComment("yt-pkm-1", "Good quote at 12:40 about compounding context — clip for landing page.", 2)],
  },
  "wake-demo-roadmap-sheet": {
    aiDescription:
      "Q2 product roadmap spreadsheet tracking initiatives across onboarding, vault, agents, and billing surfaces.",
    notes: [demoComment("roadmap-1", "Wake tour polish is the gating item for launch marketing.", 0)],
  },
  "wake-demo-lykn-synthesis-pdf": {
    aiDescription:
      "One-pager explaining neurons, beliefs, rules, and how portable context travels across AI clients via MCP.",
    notes: [
      demoComment("syn-pdf-1", "One-pager on neurons, beliefs, and how context travels.", 5),
      demoComment("syn-pdf-2", "Send to design partners after they finish the walkthrough.", 1),
    ],
  },
  "wake-demo-lykn-wordmark-blue": {
    aiDescription:
      "Standalone LYKN wordmark in brand blue. Use in headers, pitch decks, social banners, and email templates.",
    notes: [demoComment("wordmark-1", "Standalone wordmark for headers, decks, and social assets.", 4)],
  },
  "wake-demo-video-basb": {
    aiDescription:
      "Saved talk on organizing what you learn — building a second brain, progressive summarization, and retrieval-friendly notes.",
  },
  "wake-demo-neuron-sheet": {
    aiDescription:
      "Live counts of synthesis neurons by category: chats, vault items, beliefs, and facts. Updates as you capture and ratify.",
  },
  "wake-demo-lykn-logo-squircle": {
    aiDescription:
      "Full logo lockup — icon and wordmark in blue squircle format for co-branded marketing and press kits.",
  },
  "wake-demo-belief-draft": {
    aiDescription:
      "Draft belief pending ratification: prefer concise AI answers with clear next steps. Test across clients before locking in synthesis.",
    comments: [
      demoComment("belief-1", "Test this for a week in ChatGPT + Claude before ratifying.", 2),
      demoComment("belief-2", "If it holds, promote to a formal belief neuron.", 0),
    ],
  },
  "wake-demo-video-notes": {
    aiDescription:
      "Product demo clip on quick capture — saving notes, files, and links into the vault from chat and connectors.",
  },
  "wake-demo-lykn-mcp-pdf": {
    aiDescription:
      "Technical spec for the MCP context block: beliefs, rules, project state, and audit trail exposed to outside LLMs.",
    notes: [demoComment("mcp-1", "Share with integration partners building on the context block.", 3)],
  },
  "wake-demo-plan-comparison-sheet": {
    aiDescription:
      "Feature matrix comparing Free, Pro, and Team tiers — vault storage, neuron caps, custom agents, and MCP access levels.",
  },
  "wake-demo-lykn-logo-open-blue": {
    aiDescription:
      "Open-frame logo lockup in blue — wordmark without the squircle container for lighter marketing layouts.",
  },
  "wake-demo-agent-ideas": {
    aiDescription:
      "Backlog of custom agents to build: vault digest, meeting prep, and inbox triage workflows powered by synthesis context.",
    comments: [demoComment("agents-1", "Weekly vault digest feels like the highest-leverage first agent.", 1)],
  },
  "wake-demo-video-workflow": {
    aiDescription:
      "Walkthrough of an AI workflow — chat, vault capture, and synthesis updating in one loop across devices.",
  },
  "wake-demo-connections-sheet": {
    aiDescription:
      "Connector status tracker — which apps are connected, need auth, or available to link from the connections grid.",
  },
  "wake-demo-lykn-icon-open-blue": {
    aiDescription:
      "Open-frame icon variant in blue for nav bars and light UI chrome where the squircle feels too heavy.",
  },
  "wake-demo-lykn-logo-open": {
    aiDescription:
      "Neutral open logo lockup for print, light backgrounds, and partner co-marketing where color is supplied separately.",
  },
  "wake-demo-video-context": {
    aiDescription:
      "Explainer on how context compounds — every chat, save, and ratified belief makes the next AI reply more personal.",
  },
  "wake-demo-lykn-icon-black": {
    aiDescription:
      "Monochrome squircle icon for print collateral, fax-dark documents, and strict black-and-white brand lockups.",
  },
  "wake-demo-lykn-icon-neutral": {
    aiDescription:
      "Neutral squircle icon for light backgrounds, slide decks, and documentation where blue would overpower the layout.",
  },
};

function applyDemoCardMeta(card) {
  const meta = WAKE_DEMO_CARD_META[card.id];
  if (!meta) return card;
  if (card.kind === "attachment") {
    return {
      ...card,
      attachment: {
        ...card.attachment,
        ...(meta.aiDescription ? { aiDescription: meta.aiDescription } : {}),
        ...(meta.notes?.length ? { notes: meta.notes } : {}),
      },
    };
  }
  if (card.kind === "quick-note") {
    return {
      ...card,
      ...(meta.aiDescription ? { aiDescription: meta.aiDescription } : {}),
      ...(meta.comments?.length ? { comments: meta.comments } : {}),
    };
  }
  return card;
}

function attachmentCard({
  id,
  type,
  title,
  attachment,
  tags = [],
  offset = 0,
}) {
  return {
    id,
    kind: "attachment",
    isDemo: true,
    attachmentIndex: 0,
    type,
    attachment: { ...attachment },
    title,
    parentTitle: title,
    noteExcerpt: "",
    dateLabel: "Recently",
    tags,
    source: "",
    lastTouchedMs: Date.now() - offset * 60_000,
  };
}

function imageCard({ id, title, url, name, tags, offset, width = 1200, height = 1200 }) {
  return attachmentCard({
    id,
    type: "image",
    title,
    attachment: {
      url,
      name,
      type: "image",
      width,
      height,
    },
    tags,
    offset,
  });
}

function pdfCard({ id, title, name, url, tags, offset }) {
  return attachmentCard({
    id,
    type: "pdf",
    title,
    attachment: { url, name, type: "pdf" },
    tags,
    offset,
  });
}

function quickNoteCard({ id, title, excerpt, tags, offset = 0 }) {
  return {
    id,
    kind: "quick-note",
    isDemo: true,
    title,
    excerpt,
    dateLabel: "Recently",
    tags,
    comments: [],
    source: "quick_note",
    lastTouchedMs: Date.now() - offset * 60_000,
  };
}

function spreadsheetCard({ id, title, name, rows, cols, cells, tags, offset = 0 }) {
  return attachmentCard({
    id,
    type: "spreadsheet",
    title,
    attachment: { name, type: "spreadsheet", rows, cols, cells },
    tags,
    offset,
  });
}

/** Wake preview only — local thumbnail, no third-party YouTube IDs or artwork. */
function mockYoutubeCard({ id, title, thumbUrl, tags, offset = 0 }) {
  return attachmentCard({
    id,
    type: "youtube",
    title,
    attachment: {
      url: "",
      name: title,
      videoId: "",
      image: thumbUrl,
      thumbnail_url: thumbUrl,
    },
    tags,
    offset,
  });
}

const DEMO_CONNECTOR_ICONS = {
  gmail: "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  notion: "https://www.notion.so/images/favicon.ico",
  calendar: "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  drive: "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
};

/** Connected-app inbox card — demo list preview only. */
function connectorListCard({ id, title, siteName, favicon, items, tags, offset = 0 }) {
  return attachmentCard({
    id,
    type: "bookmark",
    title,
    attachment: {
      type: "bookmark",
      connectorList: true,
      url: "",
      name: title,
      title,
      siteName,
      favicon,
      listItems: items,
    },
    tags,
    offset,
  });
}

/** Demo vault cards shaped like `VaultNew` grid tiles — wake-screen preview only. */
export function buildWakeVaultDemoCards() {
  const cards = [
    quickNoteCard({
      id: "wake-demo-quick-note",
      title: "Vault capture ideas",
      excerpt:
        "Things to drop into the vault this week:\n• final logo exports\n• synthesis one-pager PDF\n• roadmap spreadsheet for the team review",
      tags: ["brand", "planning"],
      offset: 0,
    }),
    mockYoutubeCard({
      id: "wake-demo-video-pkm",
      title: "Saved talk — personal knowledge systems",
      thumbUrl: "/wake-demo/video-thumb-pkm.svg",
      tags: ["pkm", "learning"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-icon-blue",
      title: "LYKN icon — blue squircle",
      url: lyknIconBlue,
      name: "LYKN-Icon-A-Squircle-BLUE.png",
      width: 1135,
      height: 1135,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    spreadsheetCard({
      id: "wake-demo-roadmap-sheet",
      title: "Q2 product roadmap",
      name: "lykn-q2-roadmap.xlsx",
      rows: 6,
      cols: 4,
      cells: {
        "0,0": "Initiative",
        "0,1": "Surface",
        "0,2": "Owner",
        "0,3": "Status",
        "1,0": "Wake tour polish",
        "1,1": "Onboarding",
        "1,2": "Product",
        "1,3": "In progress",
        "2,0": "Vault ingestion",
        "2,1": "Vault",
        "2,2": "Platform",
        "2,3": "Shipped",
        "3,0": "Agent studio",
        "3,1": "Connections",
        "3,2": "Agents",
        "3,3": "Beta",
        "4,0": "MCP context block",
        "4,1": "Synthesis",
        "4,2": "Platform",
        "4,3": "Live",
        "5,0": "Pro unlimited vault",
        "5,1": "Billing",
        "5,2": "Growth",
        "5,3": "Queued",
      },
      tags: ["planning", "work"],
      offset: 0,
    }),
    pdfCard({
      id: "wake-demo-lykn-synthesis-pdf",
      title: "Synthesis layer overview",
      name: "LYKN-synthesis-layer-overview.pdf",
      url: DEMO_PDF_URLS.synthesis,
      tags: ["product", "synthesis"],
      offset: 0,
    }),
    connectorListCard({
      id: "wake-demo-gmail-inbox",
      title: "Gmail — inbox",
      siteName: "Gmail",
      favicon: DEMO_CONNECTOR_ICONS.gmail,
      items: [
        { label: "Re: Wake tour copy review", meta: "Sarah Chen · 9:14 AM" },
        { label: "Your LYKN Pro trial ends in 3 days", meta: "LYKN Billing · Yesterday" },
        { label: "Notes from investor prep call", meta: "Alex Rivera · Mon" },
        { label: "Agent studio feedback thread", meta: "Product team · Mon" },
        { label: "Vault sync completed — 12 new items", meta: "LYKN · Sun" },
      ],
      tags: ["gmail", "email", "connections"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-wordmark-blue",
      title: "LYKN wordmark — blue",
      url: lyknWordmarkBlue,
      name: "LYKN-Wordmark-BLUE.png",
      width: 480,
      height: 195,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    mockYoutubeCard({
      id: "wake-demo-video-basb",
      title: "Saved talk — organizing what you learn",
      thumbUrl: "/wake-demo/video-thumb-synthesis.svg",
      tags: ["pkm", "productivity"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-logo-squircle",
      title: "LYKN logo — blue squircle lockup",
      url: lyknLogoSquircleBlue,
      name: "LYKN-Logo-Primary-A-Squircle-BLUE.png",
      width: 792,
      height: 272,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    quickNoteCard({
      id: "wake-demo-belief-draft",
      title: "Belief to ratify",
      excerpt:
        "Draft belief: I prefer concise AI answers with clear next steps — no filler, no hype.\n\nNeed to test this across ChatGPT + Claude for a week before ratifying in synthesis.",
      tags: ["synthesis", "beliefs"],
      offset: 0,
    }),
    connectorListCard({
      id: "wake-demo-notion-pages",
      title: "Notion — recent pages",
      siteName: "Notion",
      favicon: DEMO_CONNECTOR_ICONS.notion,
      items: [
        { label: "Q2 product roadmap", meta: "Edited today" },
        { label: "Synthesis layer spec", meta: "Edited yesterday" },
        { label: "Wake tour script v3", meta: "Edited yesterday" },
        { label: "Agent studio PRD", meta: "Edited Tue" },
        { label: "Brand voice guidelines", meta: "Edited last week" },
      ],
      tags: ["notion", "notes", "connections"],
      offset: 0,
    }),
    spreadsheetCard({
      id: "wake-demo-neuron-sheet",
      title: "Neuron inventory",
      name: "synthesis-neuron-counts.xlsx",
      rows: 5,
      cols: 3,
      cells: {
        "0,0": "Category",
        "0,1": "Count",
        "0,2": "Last updated",
        "1,0": "Chats",
        "1,1": "12",
        "1,2": "Today",
        "2,0": "Vault",
        "2,1": "48",
        "2,2": "Today",
        "3,0": "Beliefs",
        "3,1": "7",
        "3,2": "Yesterday",
        "4,0": "Facts",
        "4,1": "23",
        "4,2": "Yesterday",
      },
      tags: ["synthesis", "metrics"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-logo-open-blue",
      title: "LYKN logo — open mark (blue)",
      url: lyknLogoOpenBlue,
      name: "LYKN-Logo-Primary-B-Open-BLUE.png",
      width: 723,
      height: 272,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    pdfCard({
      id: "wake-demo-lykn-mcp-pdf",
      title: "MCP context block spec",
      name: "LYKN-mcp-context-block.pdf",
      url: DEMO_PDF_URLS.mcp,
      tags: ["product", "integrations"],
      offset: 0,
    }),
    connectorListCard({
      id: "wake-demo-calendar-events",
      title: "Google Calendar — this week",
      siteName: "Google Calendar",
      favicon: DEMO_CONNECTOR_ICONS.calendar,
      items: [
        { label: "Team standup", meta: "Today · 9:00 AM" },
        { label: "Wake tour review", meta: "Today · 2:30 PM" },
        { label: "Investor update prep", meta: "Thu · 11:00 AM" },
        { label: "Design critique — vault grid", meta: "Fri · 10:30 AM" },
        { label: "LYKN community office hours", meta: "Fri · 4:00 PM" },
      ],
      tags: ["google-calendar", "events", "connections"],
      offset: 0,
    }),
    mockYoutubeCard({
      id: "wake-demo-video-notes",
      title: "Saved demo — notes + AI capture",
      thumbUrl: "/wake-demo/video-thumb-notes.svg",
      tags: ["ai", "notes"],
      offset: 0,
    }),
    connectorListCard({
      id: "wake-demo-drive-starred",
      title: "Google Drive — starred",
      siteName: "Google Drive",
      favicon: DEMO_CONNECTOR_ICONS.drive,
      items: [
        { label: "LYKN brand assets", meta: "Folder · Starred yesterday" },
        { label: "Synthesis layer deck.pptx", meta: "Presentation · Edited Mon" },
        { label: "Q2 roadmap.xlsx", meta: "Spreadsheet · Edited Mon" },
        { label: "Investor update — May draft.docx", meta: "Document · Edited last week" },
        { label: "Wake tour screen recordings", meta: "Folder · 6 files" },
      ],
      tags: ["google-drive", "files", "connections"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-icon-open-blue",
      title: "LYKN icon — open (blue)",
      url: lyknIconOpenBlue,
      name: "LYKN-Icon-B-Open-BLUE.png",
      width: 852,
      height: 852,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    spreadsheetCard({
      id: "wake-demo-plan-comparison-sheet",
      title: "Plan comparison",
      name: "lykn-plan-comparison.xlsx",
      rows: 5,
      cols: 4,
      cells: {
        "0,0": "Feature",
        "0,1": "Free",
        "0,2": "Pro",
        "0,3": "Team",
        "1,0": "Vault storage",
        "1,1": "500 MB",
        "1,2": "Unlimited",
        "1,3": "Unlimited",
        "2,0": "Synthesis neurons",
        "2,1": "250",
        "2,2": "Unlimited",
        "2,3": "Unlimited",
        "3,0": "Custom agents",
        "3,1": "—",
        "3,2": "Yes",
        "3,3": "Yes",
        "4,0": "MCP access",
        "4,1": "Read-only",
        "4,2": "Full",
        "4,3": "Full + admin",
      },
      tags: ["billing", "product"],
      offset: 0,
    }),
    quickNoteCard({
      id: "wake-demo-agent-ideas",
      title: "Agent studio ideas",
      excerpt:
        "Custom agents to build:\n• Weekly vault digest — surfaces what changed\n• Meeting prep — pulls relevant vault + synthesis context\n• Inbox triage — tags saves for later review",
      tags: ["agents", "ideas"],
      offset: 0,
    }),
    mockYoutubeCard({
      id: "wake-demo-video-workflow",
      title: "Saved demo — AI workflow walkthrough",
      thumbUrl: "/wake-demo/video-thumb-ai-workflow.svg",
      tags: ["ai", "workflow"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-logo-open",
      title: "LYKN logo — open mark (neutral)",
      url: lyknLogoOpenNeutral,
      name: "LYKN-Logo-Primary-B-Open-NEUTRAL.png",
      width: 723,
      height: 272,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    spreadsheetCard({
      id: "wake-demo-connections-sheet",
      title: "Connected apps",
      name: "lykn-connections-status.xlsx",
      rows: 6,
      cols: 3,
      cells: {
        "0,0": "App",
        "0,1": "Status",
        "0,2": "Last sync",
        "1,0": "Google Drive",
        "1,1": "Connected",
        "1,2": "2h ago",
        "2,0": "Notion",
        "2,1": "Connected",
        "2,2": "Yesterday",
        "3,0": "Gmail",
        "3,1": "Connected",
        "3,2": "Today",
        "4,0": "Slack",
        "4,1": "Needs auth",
        "4,2": "—",
        "5,0": "Obsidian",
        "5,1": "Available",
        "5,2": "—",
      },
      tags: ["connections", "integrations"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-icon-black",
      title: "LYKN icon — black squircle",
      url: lyknIconBlack,
      name: "LYKN-Icon-A-Squircle-BLACK.png",
      width: 1135,
      height: 1135,
      tags: ["brand", "logo"],
      offset: 0,
    }),
    mockYoutubeCard({
      id: "wake-demo-video-context",
      title: "Saved explainer — how context compounds",
      thumbUrl: "/wake-demo/video-thumb-pkm.svg",
      tags: ["ai", "learning"],
      offset: 0,
    }),
    imageCard({
      id: "wake-demo-lykn-icon-neutral",
      title: "LYKN icon — neutral squircle",
      url: lyknIconNeutral,
      name: "LYKN-Icon-A-Squircle-NEUTRAL.png",
      width: 1135,
      height: 1135,
      tags: ["brand", "logo"],
      offset: 0,
    }),
  ];

  // Connected apps first, then scatter everything else across the grid.
  const scatterOrder = [
    "wake-demo-notion-pages",
    "wake-demo-drive-starred",
    "wake-demo-gmail-inbox",
    "wake-demo-calendar-events",
    "wake-demo-lykn-icon-blue",
    "wake-demo-quick-note",
    "wake-demo-video-pkm",
    "wake-demo-roadmap-sheet",
    "wake-demo-lykn-synthesis-pdf",
    "wake-demo-lykn-wordmark-blue",
    "wake-demo-video-basb",
    "wake-demo-neuron-sheet",
    "wake-demo-lykn-logo-squircle",
    "wake-demo-belief-draft",
    "wake-demo-video-notes",
    "wake-demo-lykn-mcp-pdf",
    "wake-demo-plan-comparison-sheet",
    "wake-demo-lykn-logo-open-blue",
    "wake-demo-agent-ideas",
    "wake-demo-video-workflow",
    "wake-demo-connections-sheet",
    "wake-demo-lykn-icon-open-blue",
    "wake-demo-lykn-logo-open",
    "wake-demo-video-context",
    "wake-demo-lykn-icon-black",
    "wake-demo-lykn-icon-neutral",
  ];

  const byId = new Map(cards.map((card) => [card.id, card]));
  return scatterOrder.map((id, index) => {
    const card = byId.get(id);
    if (!card) return null;
    return applyDemoCardMeta({
      ...card,
      lastTouchedMs: Date.now() - (scatterOrder.length - index) * 60_000,
    });
  }).filter(Boolean);
}

export const WAKE_DEMO_CONNECTOR_CARD_IDS = [
  "wake-demo-drive-starred",
  "wake-demo-gmail-inbox",
  "wake-demo-calendar-events",
  "wake-demo-notion-pages",
];
