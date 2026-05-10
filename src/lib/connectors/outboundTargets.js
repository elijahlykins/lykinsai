// ──────────────────────────────────────────────────────────────────────
// Outbound targets catalog — "Use LYKN WITH your AI tools"
//
// The mirror image of catalog.js. catalog.js answers:
//   "what services pull data INTO LYKN?"
// This file answers:
//   "what AI clients can connect TO LYKN's synthesis layer (via MCP)?"
//
// One row per AI client we publish install instructions for. The
// Connections page renders these as cards in a separate "Use LYKN with..."
// section so the directionality is obvious to the user — outbound here,
// inbound in catalog.js.
//
// `installType` controls which install path the dialog shows:
//   "deeplink"       — single-button install via a custom URL scheme
//                      (Cursor: cursor://anysphere.cursor-deeplink/mcp/install)
//   "config-json"    — copy-paste JSON snippet for a config file
//                      (Claude Desktop: claude_desktop_config.json)
//   "cli"            — copy-paste shell command
//                      (Claude Code: `claude mcp add lykn …`)
//   "openapi"        — pointer at the REST mirror's OpenAPI spec
//                      (ChatGPT custom GPT Action — placeholder for v1.5)
//   "raw"            — just show the URL + token. The user knows what they're doing.
//
// `clientKind` matches lykn_mcp_tokens.client_kind so the issued token
// gets stamped with the right kind and can be filtered/labeled in the
// Connected Clients list.
// ──────────────────────────────────────────────────────────────────────

export const OUTBOUND_TARGETS = [
  {
    id: "claude-desktop",
    clientKind: "claude-desktop",
    name: "Claude Desktop",
    domain: "claude.ai",
    color: "#D97757",
    installType: "config-json",
    transport: "Streamable HTTP MCP",
    summary:
      "Anthropic's desktop app. Paste a JSON snippet into claude_desktop_config.json and Claude can read your beliefs, rules, facts, and vault on demand.",
    helpUrl: "https://docs.anthropic.com/claude/docs/mcp",
    helpLabel: "Claude MCP docs",
    available: true,
  },
  {
    id: "claude-code",
    clientKind: "claude-code",
    name: "Claude Code",
    domain: "claude.ai",
    color: "#D97757",
    installType: "cli",
    transport: "Streamable HTTP MCP",
    summary:
      "Anthropic's CLI coding agent. One `claude mcp add lykn …` and the synthesis layer is available wherever you run it — terminal, CI, scripts.",
    helpUrl: "https://docs.anthropic.com/claude/docs/claude-code",
    helpLabel: "Claude Code docs",
    available: true,
  },
  {
    id: "cursor",
    clientKind: "cursor",
    name: "Cursor",
    domain: "cursor.com",
    color: "#000000",
    installType: "deeplink",
    transport: "Streamable HTTP MCP",
    summary:
      "Click once. The Cursor deeplink registers LYKN as an MCP server inside Cursor with your token pre-filled — no JSON editing.",
    helpUrl: "https://docs.cursor.com/context/model-context-protocol",
    helpLabel: "Cursor MCP docs",
    available: true,
  },
  {
    id: "chatgpt",
    clientKind: "chatgpt",
    name: "ChatGPT",
    domain: "chatgpt.com",
    color: "#10A37F",
    installType: "openapi",
    transport: "REST (OpenAPI Action)",
    summary:
      "Use LYKN inside a custom GPT via Actions. Read-only in v1; ChatGPT MCP support arrives later.",
    helpUrl: "https://platform.openai.com/docs/actions",
    helpLabel: "OpenAI Actions docs",
    available: false,
    comingSoon: true,
  },
  {
    id: "other-mcp",
    clientKind: "other",
    name: "Anything else (raw)",
    domain: "",
    color: "#0F172A",
    installType: "raw",
    transport: "Streamable HTTP MCP",
    summary:
      "Any MCP-aware client (Cline, Continue, Windsurf, Goose, Zed) — point it at /mcp with your bearer token. You're on your own for client-side config.",
    helpUrl: "https://modelcontextprotocol.io/docs",
    helpLabel: "MCP spec",
    available: true,
  },
];

export const OUTBOUND_INSTALL_TYPES = {
  deeplink: { label: "One-click install", tone: "emerald" },
  "config-json": { label: "Copy JSON snippet", tone: "blue" },
  cli: { label: "Copy CLI command", tone: "blue" },
  openapi: { label: "Custom GPT Action", tone: "amber" },
  raw: { label: "Raw URL + token", tone: "neutral" },
};

/**
 * Build the JSON config snippet a user pastes into their
 * claude_desktop_config.json. The token + base URL are injected so the
 * snippet works without further editing. Returns a STRING (already
 * pretty-printed) for direct render in a <pre> + clipboard copy.
 *
 *   buildClaudeDesktopSnippet({ token, mcpUrl })
 *
 * NOTE on transport: Claude Desktop (as of late 2025/early 2026) does
 * NOT support remote-HTTP MCP servers via a `transport: "http"` field
 * in claude_desktop_config.json — it only spawns stdio subprocesses
 * via `command`. We bridge that with `mcp-remote`, a small npm stdio
 * adapter that proxies stdio<->HTTP. Users get one-click install via
 * `npx -y mcp-remote …` and we don't have to ship a binary.
 */
export function buildClaudeDesktopSnippet({ token, mcpUrl }) {
  const url = String(mcpUrl || "https://lykn.io/mcp");
  const t = String(token || "<paste-your-lykn-token-here>");
  const snippet = {
    mcpServers: {
      lykn: {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          url,
          "--header",
          `Authorization: Bearer ${t}`,
        ],
      },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

/**
 * Build the `claude mcp add` command for Claude Code. Single-line CLI
 * command with the token + URL embedded.
 *
 * Syntax (per `claude mcp add --help` on v2.1+):
 *
 *   claude mcp add [options] <name> <commandOrUrl> [args...]
 *
 * The URL is a POSITIONAL argument right after the server name — earlier
 * docs / older versions accepted `--url <url>` but that flag is no
 * longer recognized and produces "error: unknown option '--url'".
 */
export function buildClaudeCodeCommand({ token, mcpUrl }) {
  const url = String(mcpUrl || "https://lykn.io/mcp");
  const t = String(token || "<paste-your-lykn-token-here>");
  return `claude mcp add --transport http lykn "${url}" --header "Authorization: Bearer ${t}"`;
}

/**
 * Build the Cursor install deeplink. Per Cursor's docs the spec is:
 *
 *   cursor://anysphere.cursor-deeplink/mcp/install?name=NAME&config=BASE64
 *
 * The `config` value is base64-encoded JSON of the *inner* server config
 * (NOT wrapped in `mcpServers`). Clicking the link opens Cursor with an
 * install confirmation pre-filled with the token.
 *
 * NOTE: On Windows the protocol handler can fail silently if Cursor
 * isn't registered as the default for `cursor://` — the user clicks
 * and nothing visible happens. We therefore ALWAYS pair this with a
 * downloadable `mcp.json` fallback in the dialog (see below).
 *
 * Spec: https://cursor.com/docs/mcp/install-links
 */
export function buildCursorDeeplink({ token, mcpUrl }) {
  const config = {
    url: String(mcpUrl || "https://lykn.io/mcp"),
    headers: {
      Authorization: `Bearer ${String(token || "")}`,
    },
  };
  const encoded = base64UrlEncode(JSON.stringify(config));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=lykn&config=${encoded}`;
}

/**
 * The exact JSON a user would paste into `.cursor/mcp.json` (per-project)
 * or `~/.cursor/mcp.json` (global). Used by the Cursor install dialog as
 * a fallback when the HTTPS install button doesn't work for whatever
 * reason — the user can always copy this and paste it into the file.
 */
export function buildCursorMcpJsonSnippet({ token, mcpUrl }) {
  const url = String(mcpUrl || "https://lykn.io/mcp");
  const t = String(token || "<paste-your-lykn-token-here>");
  const snippet = {
    mcpServers: {
      lykn: {
        url,
        headers: {
          Authorization: `Bearer ${t}`,
        },
      },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

function base64UrlEncode(str) {
  if (typeof window === "undefined") {
    // Node fallback — we mostly call this in the browser but stub for SSR.
    return Buffer.from(String(str), "utf8").toString("base64url");
  }
  const b64 = window.btoa(unescape(encodeURIComponent(String(str))));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generic "what URL + token does this client need?" descriptor — the
 * "raw" install type renders this verbatim and lets the user wire it up
 * however their client expects.
 */
export function buildRawInstallInfo({ token, mcpUrl, restBase }) {
  return {
    mcpUrl: String(mcpUrl || "https://lykn.io/mcp"),
    restBase: String(restBase || "https://lykn.io/api/v1/synthesis"),
    token: String(token || ""),
    headerExample: `Authorization: Bearer ${String(token || "<your-token>")}`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Project Instructions — the paste-once contract that turns a connected
// client into a "LYKN-aware" one.
//
// The MCP tools are powerful but useless if the model doesn't choose to
// call them. Tool descriptions are read by the model when it picks a
// tool, but they don't tell it WHEN to call (or NOT call) something
// proactively. That's what this snippet does. Pasted into:
//   • Claude Projects → "Project knowledge" or Custom Instructions
//   • Claude Code → ~/.claude/CLAUDE.md or per-project CLAUDE.md
//   • Cursor → .cursorrules or Settings → Rules
//   • Anything else with a system-prompt-or-equivalent field
// it converts the 11 LYKN tools from "available if asked" into "Claude
// reflexively calls getContextBlock at conversation start, pushes
// project state when decisions happen, asks before promoting beliefs."
//
// The snippet is the SAME content for every client — only the paste
// instructions differ — so we generate one canonical body and the
// dialog wraps per-client guidance around it.
// ──────────────────────────────────────────────────────────────────────

/**
 * The canonical Project Instructions body. Returns a string ready to
 * paste into any AI client's system-prompt-equivalent surface.
 *
 *   buildLyknProjectInstructions()
 *
 * No personalisation — the same string works for every user, because
 * personalisation lives in the synthesis layer the tools read, not in
 * the instructions themselves.
 */
export function buildLyknProjectInstructions() {
  return [
    "# LYKN synthesis layer — your operating contract",
    "",
    "You are connected to my LYKN synthesis layer via MCP. LYKN is the",
    "shared, persistent working memory across all my AI clients (you,",
    "Claude Desktop, Cursor, Claude Code). Use it.",
    "",
    "## At the start of any conversation",
    "",
    "Call `lykn_getContextBlock` once. Treat the returned block as ground",
    "truth:",
    "  • [BELIEFS_AND_RULES] — durable principles + if-then rules I've",
    "    ratified. PREFER answering through these over generic best-",
    "    practice.",
    "  • [CURRENT_PROJECT] — what I'm working on right now and what's",
    "    been decided so far. Pick up from there. Do not re-litigate",
    "    decisions another AI client already pushed unless I explicitly",
    "    revisit them.",
    "",
    "If the block says I have no active project and this conversation",
    "clearly produces work on a nameable project, call",
    "`lykn_setActiveProject({ name: \"3–8 words\", description: \"…\" })`",
    "without asking me to name it. Pick a short descriptive name from",
    "context. I can rename it in LYKN later.",
    "",
    "## During the conversation",
    "",
    "When we make a meaningful project decision (tech choice, milestone",
    "hit, blocker found or cleared, scope change, design decision), call:",
    "  `lykn_pushProjectState({ state_key: \"<slug>\", state_value: \"<≤2000 chars>\" })`",
    "",
    "Reuse keys across pushes — `current_blocker` should be the SAME key",
    "every time, not `current_blocker_v2`. The server tracks history; you",
    "just push the latest. Suggested key vocabulary:",
    "  tech_stack | architecture | current_blocker | next_milestone |",
    "  open_questions | recent_decisions | scope | constraints |",
    "  collaborators | progress_summary",
    "",
    "When a reply is materially shaped by one of my rules from",
    "[BELIEFS_AND_RULES], call:",
    "  `lykn_recordRuleApplication({ rule_id, message_id, reason })`",
    "Use rule_ids from the block verbatim. Don't invent.",
    "",
    "When I disclose a durable identity fact (role, preference,",
    "constraint, focus, goal — not casual / transient state), call",
    "`lykn_proposeFact`. Facts are observation; they don't need my",
    "approval first.",
    "",
    "## Core beliefs — ASK ME FIRST",
    "",
    "Beliefs govern how every connected AI responds. They have higher",
    "blast radius than facts. So:",
    "",
    "If you notice I've expressed a clear durable principle that should",
    "shape future AI replies, ASK ME FIRST in the chat:",
    "",
    "  > \"I noticed you might hold the principle ‘<X>’ as a core belief",
    "  > that should shape how all your AIs respond. Want me to add it",
    "  > to your synthesis layer?\"",
    "",
    "If I say yes in my next message, call:",
    "  `lykn_proposeBelief({ text, serves_need, rationale, user_confirmed: true })`",
    "and the belief lands active immediately.",
    "",
    "If I say no or you didn't ask, EITHER skip it OR call without",
    "user_confirmed — that lands the belief in my ratification queue for",
    "later review. Default to skipping over routing-to-queue; queue noise",
    "is more annoying than missed signal.",
    "",
    "## Honesty over attribution — non-negotiable",
    "",
    "  • Don't fake-attribute. Most replies aren't rule-driven — that's",
    "    fine and expected. No tag-call is honest.",
    "  • Don't propose beliefs from heat-of-the-moment statements.",
    "  • Don't push project state for casual conversation that didn't",
    "    produce a decision.",
    "  • If unsure whether to write to LYKN, lean toward NOT calling the",
    "    tool. I'd rather miss real signal than swallow noise.",
    "",
    "## When you're confused about my context",
    "",
    "Call `lykn_searchVault({ query })` for past saved notes/articles,",
    "`lykn_getFacts({ query })` for atomic facts, or",
    "`lykn_getProjectState({ include_history: true })` to see how a",
    "decision evolved over time. These are cheap; use them before guessing.",
  ].join("\n");
}

/**
 * Per-client paste guidance — where the user puts the snippet, what
 * the surface is called in that client, and a stable key the dialog
 * can switch on.
 *
 * Keep this aligned with the OUTBOUND_TARGETS catalog — clientKind
 * matches lykn_mcp_tokens.client_kind.
 */
export const LYKN_PROJECT_INSTRUCTIONS_TARGETS = {
  "claude-desktop": {
    surfaceLabel: "Project knowledge",
    steps: [
      "In Claude Desktop, create or open a Project (sidebar → Projects → New project).",
      'Open Project knowledge (or Custom Instructions, depending on your version).',
      "Paste the snippet below. Save.",
      "Start chats inside this Project — Claude will follow the contract automatically.",
    ],
    helpUrl: "https://support.anthropic.com/en/articles/9519177-using-projects-in-claude-ai",
    helpLabel: "Claude Projects help",
  },
  "claude-code": {
    surfaceLabel: "CLAUDE.md",
    steps: [
      "Create (or open) ~/.claude/CLAUDE.md for global instructions, OR a CLAUDE.md in your project root for per-project rules.",
      "Paste the snippet below. Save.",
      "Run `claude` in that directory — Claude Code reads CLAUDE.md on startup.",
    ],
    helpUrl: "https://docs.claude.com/en/docs/claude-code/memory",
    helpLabel: "Claude Code memory docs",
  },
  cursor: {
    surfaceLabel: ".cursorrules / Rules",
    steps: [
      "In Cursor, open Settings → Rules (or create .cursorrules in your project root for per-project).",
      "Paste the snippet below as a new rule. Save.",
      "Cursor's chat + Composer apply rules automatically; LYKN tools light up immediately.",
    ],
    helpUrl: "https://docs.cursor.com/context/rules",
    helpLabel: "Cursor Rules docs",
  },
  other: {
    surfaceLabel: "system prompt / rules surface",
    steps: [
      "Locate your AI client's system-prompt-equivalent surface (custom instructions, system message, rules, persona, etc.).",
      "Paste the snippet below. Save.",
      "Restart or reload the client so it picks up the new instructions.",
    ],
    helpUrl: "https://modelcontextprotocol.io/docs",
    helpLabel: "MCP spec",
  },
};
