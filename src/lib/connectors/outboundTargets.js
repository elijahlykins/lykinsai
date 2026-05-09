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
