// ──────────────────────────────────────────────────────────────────────
// Skills catalog
//
// What the LYKN AI can do, end-to-end. Mirrors the connector catalog
// shape so the Skills view can render identically structured cards.
//
// Status legend
//   "live"        – wired up today (verified against server.js endpoints)
//   "soon"        – designed, not yet implemented
//   "experimental" – partially shipped, behind a plan or feature flag
//
// Action shape
//   action.route       – relative path to navigate to. Special value
//                        "/grid/new" creates a fresh grid UUID.
//   action.chat        – true → append ?chat=1 so the grid mounts in
//                        chat-focused mode. Pairs with route /grid/new.
//   action.comingSoon  – true → click shows a "coming soon" toast.
//   action.connections – true → click routes to /connections.
// ──────────────────────────────────────────────────────────────────────

export const SKILL_CATEGORIES = [
  {
    id: "understand",
    label: "Understand",
    description:
      "Answer questions across everything you've captured — chats, files, links, transcripts.",
    accent: "#2563EB", // blue
  },
  {
    id: "capture",
    label: "Capture & Extract",
    description:
      "Pull text, transcripts, and structure out of links, files, audio, and video.",
    accent: "#10B981", // emerald
  },
  {
    id: "create",
    label: "Create & Generate",
    description:
      "Produce text, mind maps, and visual workspaces from a prompt.",
    accent: "#8B5CF6", // violet
  },
  {
    id: "synthesize",
    label: "Summarize & Synthesize",
    description:
      "Compress, compare, and connect what you've collected into something useful.",
    accent: "#F59E0B", // amber
  },
  {
    id: "voice",
    label: "Voice & Audio",
    description: "Read things aloud, dictate notes, transcribe recordings.",
    accent: "#EC4899", // pink
  },
  {
    id: "organize",
    label: "Organize",
    description:
      "Auto-name, auto-tag, group by project, and surface what matters.",
    accent: "#0EA5E9", // sky
  },
  {
    id: "agentic",
    label: "Agentic & Tool Use",
    description:
      "Multi-step actions: search the web, call other tools, run workflows.",
    accent: "#6366F1", // indigo
  },
];

export const SKILLS = [
  // ── Understand ────────────────────────────────────────────────────
  {
    id: "vault-chat",
    category: "understand",
    icon: "MessageCircle",
    name: "Chat with your Vault",
    summary:
      "Ask anything across everything you've saved — notes, files, links, transcripts.",
    example: "What did I save about 1031 exchanges last month?",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },
  {
    id: "vault-search",
    category: "understand",
    icon: "Search",
    name: "Semantic Vault search",
    summary:
      "Find items by meaning, not keywords. Returns the actual snippet that matched.",
    example: "the property in Austin with the rental yield numbers",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "youtube-qa",
    category: "understand",
    icon: "Youtube",
    name: "YouTube Q&A",
    summary:
      "Ask questions about any YouTube video. Pulls the transcript, jumps to the moment.",
    example: "what does he say about pricing strategy at 12:30?",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },
  {
    id: "doc-qa",
    category: "understand",
    icon: "FileText",
    name: "Q&A over a single document",
    summary: "Drop a PDF or doc into chat and ask questions just about it.",
    example: "summarize the limited partner agreement on page 14",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },
  {
    id: "memory",
    category: "understand",
    icon: "Brain",
    name: "Conversation memory",
    summary:
      "Remembers what you talked about across chats so you don't have to re-explain.",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },

  // ── Capture & Extract ─────────────────────────────────────────────
  {
    id: "save-link",
    category: "capture",
    icon: "Link",
    name: "Save any link to Vault",
    summary:
      "Drop a URL — we fetch the page, build a rich preview, and store it as a card.",
    example: "https://www.youtube.com/watch?v=…",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "save-file",
    category: "capture",
    icon: "Upload",
    name: "Upload files",
    summary:
      "PDFs, docs, sheets, slides, audio, video, images. Stored in your Vault and indexed.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "extract-text",
    category: "capture",
    icon: "FileSearch",
    name: "Extract text from documents",
    summary:
      "PDF, Word, Excel, PowerPoint — text, tables, and structure pulled out automatically.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "describe-image",
    category: "capture",
    icon: "Image",
    name: "Describe images",
    summary:
      "Auto-generates captions and descriptions for any image so it's searchable later.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "transcribe-audio",
    category: "capture",
    icon: "Mic",
    name: "Transcribe audio",
    summary:
      "Voice memos, meetings, lectures — get a full transcript in your Vault.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "extract-spreadsheet",
    category: "capture",
    icon: "Table2",
    name: "Read spreadsheets",
    summary:
      "Excel, Sheets, CSV — every cell becomes searchable structured data.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "web-extract",
    category: "capture",
    icon: "Globe",
    name: "Webpage unfurl",
    summary:
      "Pulls title, description, hero image, and article text from any URL.",
    status: "live",
    action: { route: "/vault" },
  },

  // ── Create & Generate ────────────────────────────────────────────
  {
    id: "canvas-build",
    category: "create",
    icon: "LayoutGrid",
    name: "Build visual canvases",
    summary:
      "Drop text, tables, embeds, and link previews directly on a grid.",
    status: "live",
    action: { route: "/grid/new" },
  },
  {
    id: "table-gen",
    category: "create",
    icon: "Table2",
    name: "Generate tables from a prompt",
    summary:
      "Comparison matrices, schedules, plans — described in words, returned as a table.",
    example: "compare the three lenders side-by-side with rates and APRs",
    status: "live",
    action: { route: "/grid/new" },
  },
  {
    id: "mindmap",
    category: "create",
    icon: "GitBranch",
    name: "Synthesis Layer (mind map)",
    summary:
      "Visualize how every grid, project, and vault item connects in one live map.",
    status: "experimental",
    statusLabel: "Pro plan",
    action: { route: "/synthesis-layer" },
  },
  {
    id: "checklist",
    category: "create",
    icon: "ListChecks",
    name: "Generate checklists",
    summary: "Turn a goal or process description into a working checklist.",
    example: "everything I need to close on the duplex",
    status: "live",
    action: { route: "/grid/new" },
  },

  // ── Summarize & Synthesize ────────────────────────────────────────
  {
    id: "summarize-thread",
    category: "synthesize",
    icon: "Quote",
    name: "Summarize a conversation",
    summary:
      "Compress a long chat into the key points, decisions, and follow-ups.",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },
  {
    id: "summarize-doc",
    category: "synthesize",
    icon: "FileText",
    name: "Summarize a document",
    summary: "Long PDF or doc → tight executive summary in one shot.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "compare-items",
    category: "synthesize",
    icon: "Columns",
    name: "Compare two or more items",
    summary:
      "Pick any items from your Vault and get a side-by-side comparison.",
    status: "soon",
    action: { comingSoon: true },
  },
  {
    id: "deep-research",
    category: "synthesize",
    icon: "Telescope",
    name: "Deep Research",
    summary:
      "Multi-step research: search the web, your Vault, and connected sources to produce a brief.",
    status: "soon",
    action: { comingSoon: true },
  },
  {
    id: "translate",
    category: "synthesize",
    icon: "Languages",
    name: "Translate",
    summary: "Translate any vault item or conversation into another language.",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },

  // ── Voice & Audio ─────────────────────────────────────────────────
  {
    id: "tts",
    category: "voice",
    icon: "Volume2",
    name: "Read aloud (TTS)",
    summary:
      "Have anything in the Vault — articles, summaries, notes — read aloud.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "voice-input",
    category: "voice",
    icon: "Mic",
    name: "Voice notes",
    summary:
      "Tap the mic, talk, get a transcribed note added to your Vault automatically.",
    status: "live",
    action: { route: "/grid/new", chat: true },
  },
  {
    id: "podcastify",
    category: "voice",
    icon: "Headphones",
    name: "Podcastify a topic",
    summary:
      "Turn a vault item or summary into a short narrated audio briefing.",
    status: "soon",
    action: { comingSoon: true },
  },

  // ── Organize ──────────────────────────────────────────────────────
  {
    id: "auto-name-grid",
    category: "organize",
    icon: "Wand2",
    name: "Auto-name grids and notes",
    summary: "We name new grids, projects, and notes based on what's in them.",
    status: "live",
    action: { route: "/grid/new" },
  },
  {
    id: "auto-tag",
    category: "organize",
    icon: "Tag",
    name: "Auto-tag vault items",
    summary:
      "Every saved item gets tags inferred from its content — searchable instantly.",
    status: "live",
    action: { route: "/vault" },
  },
  {
    id: "group-into-projects",
    category: "organize",
    icon: "FolderOpen",
    name: "Group into projects",
    summary:
      "Suggest which vault items belong together as a project, with a rationale.",
    status: "soon",
    action: { comingSoon: true },
  },
  {
    id: "source-filter",
    category: "organize",
    icon: "Filter",
    name: "Filter by source",
    summary:
      "Slice the Vault by where things came from — Instagram, YouTube, files, links.",
    status: "soon",
    action: { route: "/vault" }, // routes to vault now; tabs ship later
  },
  {
    id: "dedup",
    category: "organize",
    icon: "Layers",
    name: "Dedup duplicates",
    summary:
      "Detects near-duplicates across saves and offers to merge them.",
    status: "soon",
    action: { comingSoon: true },
  },

  // ── Agentic & Tool Use ────────────────────────────────────────────
  {
    id: "web-search",
    category: "agentic",
    icon: "Globe",
    name: "Web search inside chat",
    summary:
      "Ask anything; if the answer isn't in your Vault, search the web and cite sources.",
    status: "soon",
    action: { comingSoon: true },
  },
  {
    id: "tool-calls",
    category: "agentic",
    icon: "Plug",
    name: "Tool-calling",
    summary:
      "AI can call connected services on your behalf — pull a Notion page, post to Slack, add to Calendar.",
    status: "soon",
    action: { connections: true },
  },
  {
    id: "mcp-bridge",
    category: "agentic",
    icon: "Sparkles",
    name: "MCP server support",
    summary:
      "Bring any Model Context Protocol server in as a vault source — Anthropic's open standard.",
    status: "soon",
    action: { connections: true },
  },
  {
    id: "outbound-actions",
    category: "agentic",
    icon: "Send",
    name: "Send to … actions",
    summary:
      "From any vault item: send to Slack, create a Notion page, add to Calendar, draft an email.",
    status: "soon",
    action: { connections: true },
  },
  {
    id: "automations",
    category: "agentic",
    icon: "Workflow",
    name: "Automations & triggers",
    summary:
      "When X happens in the Vault, do Y — tag, route, summarize, notify.",
    status: "soon",
    action: { comingSoon: true },
  },
  {
    id: "computer-use",
    category: "agentic",
    icon: "MousePointerClick",
    name: "Computer use (browser)",
    summary:
      "Drive a real browser to fetch what no API exposes — Instagram saves, TikTok favorites.",
    status: "soon",
    action: { comingSoon: true },
  },
];

export const SKILL_STATUSES = {
  live: { label: "Live", tone: "emerald" },
  experimental: { label: "Beta", tone: "blue" },
  soon: { label: "Coming soon", tone: "blue" },
};
