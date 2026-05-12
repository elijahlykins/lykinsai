// ──────────────────────────────────────────────────────────────────────
// AI integration catalog
//
// Sourced from the integration_targets + integration_strategy keys that
// Claude pushed into LYKN project state during the "LYKN product vision
// and positioning" project. Pull with `lykn_getProjectState` to confirm
// the current spec — this file is the rendered surface of that thinking.
//
// Each entry carries three roadmap fields:
//
//   tier         — 1 = launch lineup, 2 = next wave, 3 = creative
//                  specialist, 4 = bring-your-own catch-all.
//
//   direction    — "bidirectional" = LYKN feeds the tool AND learns from
//                                    it (the AI assistant integrations).
//                  "input-only"    = LYKN learns from it, no context
//                                    injection back (creative tools that
//                                    don't accept external context).
//                  "outbound"      = LYKN → tool only (catch-all MCP).
//
//   installType  — what install flow the dialog shows.
//
// Connection-method strategy lives in project state under
// `integration_strategy`. Short version, the four-layer stack:
//   1. Remote MCP URL (power users)
//   2. OAuth "Connect LYKN" button (primary consumer onboarding)
//   3. Custom GPT in OpenAI's GPT Store (distribution)
//   4. Browser extension (ambient, platform-independent)
// ──────────────────────────────────────────────────────────────────────

export const OUTBOUND_TARGETS = [
  // ─── Tier 1 — launch lineup ───────────────────────────────────────
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
    tier: 1,
    direction: "bidirectional",
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
    tier: 1,
    direction: "bidirectional",
  },
  {
    id: "claude-web",
    clientKind: "claude-web",
    name: "Claude (web)",
    domain: "claude.ai",
    color: "#D97757",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Connectors (OAuth)",
    summary:
      "claude.ai in the browser. One click opens Claude with the Add Custom Connector dialog already filled in for LYKN — you just approve. No URL to copy, no settings to dig through. Available on Free, Pro, and Max.",
    helpUrl: "https://claude.com/docs/connectors/custom/remote-mcp",
    helpLabel: "Claude Connectors docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // ── Per-target metadata for the generic OauthMcpSection stepper.
    //    Claude.ai supports a `?modal=add-custom-connector` deep link
    //    that POPULATES the name + URL fields for the user (per
    //    claude.com/docs/connectors). One press of Connect Claude →
    //    Claude opens with the modal prefilled → user hits Add →
    //    approve consent → done. Auto-syncs to Desktop/mobile/Cowork.
    connectMode: "claude-prefill",
    // openUrl is unused when connectMode is set, but kept as a sensible
    // fallback target for tooling that wants to manually navigate.
    openUrl: "https://claude.ai/settings/connectors",
    planNote:
      "Available on Free (one custom connector), Pro, and Max — no special toggle. Team / Enterprise admins enable it from Admin → Connectors first; members then add via Settings.",
    installSteps: [
      "Press Connect Claude — we open Claude with the Add Custom Connector dialog already filled in.",
      "Inside Claude: click Add.",
      "Approve the LYKN consent screen when it pops — that's it.",
    ],
    // Surfaced after the connection is detected. Claude Connectors
    // sync across all of Anthropic's clients (web, Desktop, mobile,
    // Cowork, Claude Code) — once the user adds LYKN here it shows up
    // everywhere they use Claude with no extra config. Worth shouting
    // about because it's a meaningful UX win over the per-app config
    // dance Claude Desktop / Claude Code traditionally require.
    successHint:
      "This connection auto-syncs to Claude Desktop, mobile, Cowork, and Claude Code — no extra setup on any of those. We're also working with Anthropic on a one-click Directory listing so future users won't have to paste the URL at all.",
  },
  {
    id: "cursor",
    clientKind: "cursor",
    name: "Cursor",
    domain: "cursor.com",
    color: "#000000",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Cursor MCP-OAuth",
    summary:
      "Dominant AI-native IDE — agent-first. One click installs LYKN inside Cursor and walks you through the OAuth approval. No token to copy, no config to edit.",
    helpUrl: "https://docs.cursor.com/context/model-context-protocol",
    helpLabel: "Cursor MCP docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // ── Cursor uses a CUSTOM URL SCHEME deeplink rather than the
    //    open-tab+paste flow Claude.ai / ChatGPT use. Same OauthMcpSection
    //    underneath; connectMode just swaps the Connect button's action
    //    from window.open(openUrl) to window.location=cursorOauthDeeplink.
    //    The post-install OAuth dance (Cursor → /mcp 401 → discovery →
    //    DCR → consent → token) is identical, and the same baseline-diff
    //    polling flips the dialog to Connected.
    connectMode: "cursor-deeplink",
    openUrl: "https://docs.cursor.com/context/model-context-protocol",
    planNote:
      "Works on all Cursor plans. Cursor installs LYKN as an MCP server tied to your account; revoke any time from /Connections below.",
    installSteps: [
      "Press Connect Cursor — your OS hands the cursor:// deeplink to Cursor.",
      "In Cursor's install dialog: click Install.",
      "Cursor opens a browser tab to the LYKN consent screen — click Approve.",
      "Cursor finishes the handshake silently. We auto-detect it here.",
    ],
    successHint:
      "LYKN is now a remote MCP server in Cursor — open Settings → MCP to confirm. The Composer, chat, and the agent all see your synthesis-layer tools immediately.",
  },
  {
    id: "chatgpt",
    clientKind: "chatgpt",
    name: "ChatGPT",
    domain: "chatgpt.com",
    color: "#10A37F",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Connectors (OAuth)",
    summary:
      "OpenAI's web app. Click Connect — we open ChatGPT for you, you paste LYKN's MCP URL, approve once, and ChatGPT can read your beliefs, rules, facts, and vault on demand.",
    helpUrl: "https://help.openai.com/en/articles/11487775-connectors-in-chatgpt",
    helpLabel: "ChatGPT Connectors help",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // ── Per-target metadata for the generic OauthMcpSection stepper.
    //    `openUrl` is what we open in a new tab when the user clicks
    //    Connect (deep link if the host has a stable settings URL,
    //    homepage otherwise). `installSteps` is the per-target script
    //    inside the dialog — written to match each tool's actual UI
    //    so the user can follow it without alt-tabbing back here.
    openUrl: "https://chatgpt.com/",
    planNote:
      "Custom MCP connectors require ChatGPT Pro / Team / Enterprise + Developer Mode. Free / Plus accounts can still use the personal-access-token paths above.",
    installSteps: [
      "Open ChatGPT → click your avatar → Settings.",
      "Pick Apps & Connectors in the left rail.",
      "Scroll to the bottom → Advanced settings → toggle Developer Mode on (only needed once).",
      "Back at the top of Apps & Connectors, click Create.",
      "Paste the URL above into MCP Server URL, set Authentication = OAuth, click Create.",
      "Approve the LYKN consent screen when it pops — that's it.",
    ],
  },
  {
    id: "perplexity",
    clientKind: "perplexity",
    name: "Perplexity",
    domain: "perplexity.ai",
    color: "#20808D",
    installType: "oauth",
    transport: "OAuth Connector + browser extension",
    summary:
      "AI research and search you'll use daily. Connect LYKN to Perplexity Comet / Spaces so its answers pull from your beliefs and vault — and so your searches flow back into LYKN.",
    helpUrl: "https://docs.perplexity.ai/",
    helpLabel: "Perplexity docs",
    available: false,
    comingSoon: true,
    tier: 1,
    direction: "bidirectional",
  },
  {
    id: "gemini",
    clientKind: "gemini",
    name: "Gemini",
    domain: "gemini.google.com",
    color: "#4285F4",
    installType: "oauth",
    transport: "OAuth Connector across web + Workspace",
    summary:
      "Google's Gemini across web, Workspace, and CLI. One OAuth click and Gemini answers reference your synthesis layer wherever you're using it — docs, sheets, chat.",
    helpUrl: "https://ai.google.dev/gemini-api/docs",
    helpLabel: "Gemini docs",
    available: false,
    comingSoon: true,
    tier: 1,
    direction: "bidirectional",
  },
  {
    id: "grok",
    clientKind: "grok",
    name: "Grok",
    domain: "x.ai",
    color: "#000000",
    installType: "oauth",
    transport: "OAuth Connector + Grok Studio",
    summary:
      "xAI's Grok — deep reasoning, live web, and Grok Studio. Wire LYKN into Studio threads so research and saved artifacts both flow back into your vault.",
    helpUrl: "https://docs.x.ai/",
    helpLabel: "xAI docs",
    available: false,
    comingSoon: true,
    tier: 1,
    direction: "bidirectional",
  },

  // ─── Tier 2 — next wave ──────────────────────────────────────────
  {
    id: "windsurf",
    clientKind: "windsurf",
    name: "Windsurf",
    domain: "windsurf.com",
    color: "#09B6A2",
    installType: "config-json",
    transport: "Streamable HTTP MCP",
    summary:
      "AI-native IDE, strong Cursor competitor. Drop LYKN into Cascade's mcp_config.json and Windsurf's coding agent can query your vault, project state, and rules.",
    helpUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
    helpLabel: "Windsurf MCP docs",
    available: false,
    comingSoon: true,
    tier: 2,
    direction: "bidirectional",
  },
  {
    id: "replit",
    clientKind: "replit",
    name: "Replit",
    domain: "replit.com",
    color: "#F26207",
    installType: "config-json",
    transport: "Streamable HTTP MCP",
    summary:
      "AI app builder + deploy — natural language to running code. LYKN as an MCP source means Replit's agent inherits your stack preferences and project state.",
    helpUrl: "https://docs.replit.com/",
    helpLabel: "Replit docs",
    available: false,
    comingSoon: true,
    tier: 2,
    direction: "bidirectional",
  },
  {
    id: "github-copilot",
    clientKind: "github-copilot",
    name: "GitHub Copilot",
    domain: "github.com",
    color: "#171515",
    installType: "config-json",
    transport: "Streamable HTTP MCP",
    summary:
      "GitHub Copilot + Microsoft 365 Copilot. Add LYKN as an MCP server in your Copilot config so inline suggestions and chat both see your synthesis layer.",
    helpUrl: "https://docs.github.com/copilot",
    helpLabel: "Copilot docs",
    available: false,
    comingSoon: true,
    tier: 2,
    direction: "bidirectional",
  },
  {
    id: "notion-ai",
    clientKind: "notion-ai",
    name: "Notion AI",
    domain: "notion.so",
    color: "#000000",
    installType: "oauth",
    transport: "OAuth — Notion API",
    summary:
      "Docs, wikis, team workflows. Input-only: LYKN learns from the pages you let it see, then makes that knowledge available to your other AI tools.",
    helpUrl: "https://developers.notion.com/",
    helpLabel: "Notion API docs",
    available: false,
    comingSoon: true,
    tier: 2,
    direction: "input-only",
  },
  {
    id: "fathom",
    clientKind: "fathom",
    name: "Fathom",
    domain: "fathom.video",
    color: "#5C2EBC",
    installType: "oauth",
    transport: "OAuth — Fathom webhooks",
    summary:
      "AI meeting transcripts + summaries with CRM sync. Input-only: every meeting recap lands in LYKN so 'what did we decide last Tuesday?' actually has an answer.",
    helpUrl: "https://help.fathom.video/",
    helpLabel: "Fathom docs",
    available: false,
    comingSoon: true,
    tier: 2,
    direction: "input-only",
  },
  {
    id: "mem-ai",
    clientKind: "mem-ai",
    name: "Mem.ai",
    domain: "mem.ai",
    color: "#1F1F1F",
    installType: "oauth",
    transport: "OAuth — Mem API",
    summary:
      "AI notes with auto-organization. Input-only: your Mem corpus flows into LYKN's synthesis layer so its beliefs about you compound across tools.",
    helpUrl: "https://docs.mem.ai/",
    helpLabel: "Mem docs",
    available: false,
    comingSoon: true,
    tier: 2,
    direction: "input-only",
  },

  // ─── Tier 3 — creative + specialist ──────────────────────────────
  {
    id: "midjourney",
    clientKind: "midjourney",
    name: "Midjourney",
    domain: "midjourney.com",
    color: "#000000",
    installType: "browser-extension",
    transport: "LYKN browser extension",
    summary:
      "Image gen for creative pros and visual inspiration. Input-only: the LYKN extension observes prompts + outputs so your visual taste becomes synthesis signal.",
    helpUrl: "https://docs.midjourney.com/",
    helpLabel: "Midjourney docs",
    available: false,
    comingSoon: true,
    tier: 3,
    direction: "input-only",
  },
  {
    id: "elevenlabs",
    clientKind: "elevenlabs",
    name: "ElevenLabs",
    domain: "elevenlabs.io",
    color: "#000000",
    installType: "api-key",
    transport: "API key + browser extension",
    summary:
      "AI voice + audio for creators and podcasters. Input-only: voice projects, scripts, and audio metadata feed back into LYKN so your style is portable.",
    helpUrl: "https://elevenlabs.io/docs",
    helpLabel: "ElevenLabs docs",
    available: false,
    comingSoon: true,
    tier: 3,
    direction: "input-only",
  },
  {
    id: "sora-veo",
    clientKind: "sora-veo",
    name: "Sora / Veo 3",
    domain: "openai.com",
    color: "#10A37F",
    installType: "browser-extension",
    transport: "LYKN browser extension",
    summary:
      "OpenAI Sora + Google Veo 3 video generation. Input-only: the extension captures prompts, references, and outputs so LYKN learns the visual systems you build.",
    helpUrl: "https://openai.com/sora",
    helpLabel: "Sora docs",
    available: false,
    comingSoon: true,
    tier: 3,
    direction: "input-only",
  },
  {
    id: "figma-ai",
    clientKind: "figma-ai",
    name: "Figma AI",
    domain: "figma.com",
    color: "#F24E1E",
    installType: "oauth",
    transport: "OAuth — Figma plugin / REST",
    summary:
      "Design, auto-layout, component variants. Input-only: LYKN observes the design system you're converging on, then surfaces it inside every AI conversation.",
    helpUrl: "https://www.figma.com/developers/api",
    helpLabel: "Figma docs",
    available: false,
    comingSoon: true,
    tier: 3,
    direction: "input-only",
  },
  {
    id: "zapier-ai",
    clientKind: "zapier-ai",
    name: "Zapier AI",
    domain: "zapier.com",
    color: "#FF4A00",
    installType: "browser-extension",
    transport: "Zapier app + webhooks",
    summary:
      "Workflow automation that connects everything. Input-only: any Zap can pipe events into LYKN, so the automations you build become part of how your AIs reason about you.",
    helpUrl: "https://zapier.com/developer",
    helpLabel: "Zapier docs",
    available: false,
    comingSoon: true,
    tier: 3,
    direction: "input-only",
  },
  {
    id: "v0-lovable",
    clientKind: "v0-lovable",
    name: "v0 / Lovable",
    domain: "v0.dev",
    color: "#000000",
    installType: "browser-extension",
    transport: "Browser extension + remote MCP",
    summary:
      "UI generation and vibe-coding. Bidirectional: LYKN feeds taste + stack context into prompts, then captures the components you ship for next time.",
    helpUrl: "https://v0.dev/docs",
    helpLabel: "v0 docs",
    available: false,
    comingSoon: true,
    tier: 3,
    direction: "bidirectional",
  },

  // ─── Tier 4 — bring your own client ──────────────────────────────
  {
    id: "other-mcp",
    clientKind: "other",
    name: "Anything else (raw)",
    domain: "",
    color: "#0F172A",
    installType: "raw",
    transport: "Streamable HTTP MCP",
    summary:
      "Any other MCP-aware client (Zed, Codex CLI, Cline, Continue, Goose, Warp, Jan, etc.) — point it at /mcp with your bearer token. You're on your own for client-side config.",
    helpUrl: "https://modelcontextprotocol.io/docs",
    helpLabel: "MCP spec",
    available: true,
    tier: 4,
    direction: "outbound",
  },
];

// Tier metadata for the Connections page. The page groups cards by
// tier id and renders these labels/descriptions as subheaders.
export const OUTBOUND_TIERS = [
  {
    id: 1,
    label: "Launch lineup",
    description:
      "The AI tools we're shipping with on day one. Each is bidirectional — LYKN feeds it context AND learns from it.",
  },
  {
    id: 2,
    label: "Next wave",
    description:
      "Bidirectional code agents (Windsurf, Replit, Copilot) plus input-only knowledge tools (Notion AI, Fathom, Mem.ai) that feed LYKN with what you've already captured elsewhere.",
  },
  {
    id: 3,
    label: "Creative + specialist",
    description:
      "Image, audio, video, design, and automation. Mostly input-only — LYKN observes what you create so your taste and systems become portable across every AI session.",
  },
  {
    id: 4,
    label: "Bring your own client",
    description:
      "Any MCP-aware client we don't ship a one-click flow for. Point it at /mcp with your bearer token.",
  },
];

export const OUTBOUND_INSTALL_TYPES = {
  "config-json": { label: "Copy JSON snippet", tone: "blue" },
  cli: { label: "Copy CLI command", tone: "blue" },
  oauth: { label: "Connect with OAuth", tone: "emerald" },
  "oauth-mcp": { label: "One-click connect (OAuth)", tone: "emerald" },
  openapi: { label: "Custom GPT Action", tone: "amber" },
  "api-key": { label: "Paste API key", tone: "blue" },
  "browser-extension": { label: "Via LYKN extension", tone: "amber" },
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
 * Build a Cursor install deeplink. Per Cursor's docs the spec is:
 *
 *   cursor://anysphere.cursor-deeplink/mcp/install?name=NAME&config=BASE64
 *
 * The `config` value is base64url-encoded JSON of the *inner* server
 * config (NOT wrapped in `mcpServers`). We deliberately ship NO auth
 * inside the config — Cursor discovers OAuth on first connect via
 * the standard MCP-OAuth dance: `/mcp` 401 → `WWW-Authenticate:
 * ... resource_metadata=…` → DCR → `/oauth/authorize` consent →
 * `/oauth/token`. Means no PAT for the user to manage and the token
 * lifecycle (rotation, revoke) lives in /Connections.
 *
 * Spec: https://cursor.com/docs/mcp/install-links
 */
export function buildCursorOauthDeeplink({ mcpUrl }) {
  const config = {
    url: String(mcpUrl || "https://lykn.io/mcp"),
  };
  const encoded = base64UrlEncode(JSON.stringify(config));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=lykn&config=${encoded}`;
}

// Production LYKN MCP URL — the canonical https endpoint AI clients
// connect to. Used as the fallback any time we build a deep link for
// a client that REQUIRES https (Claude rejects non-https connector
// URLs; Cursor and ChatGPT have similar constraints in prod). Dev
// machines on http://localhost can override this via the
// VITE_PUBLIC_MCP_URL env var when they have an https tunnel
// (ngrok, cloudflared, etc) pointed at their local server.
const PUBLIC_LYKN_MCP_URL =
  (typeof import.meta !== "undefined" &&
    import.meta?.env?.VITE_PUBLIC_MCP_URL) ||
  "https://lykn.io/mcp";

/**
 * Force a connector URL to be https. Claude (and most production AI
 * hosts) reject http for custom MCP servers; Cursor is the exception
 * because its private-use URI scheme deeplink handler runs locally
 * on the user's machine. For clients that fetch the URL from their
 * cloud, http only ever works for testing — so swap to the prod LYKN
 * endpoint (or a VITE_PUBLIC_MCP_URL override) whenever we'd otherwise
 * hand them http://localhost.
 */
function ensureHttpsMcpUrl(maybeUrl) {
  const raw = String(maybeUrl || "").trim();
  if (/^https:\/\//i.test(raw)) return raw;
  if (typeof console !== "undefined" && raw) {
    // Intentional warning — not an error. The deep link still works,
    // it just routes to prod LYKN instead of the dev server. Surfaces
    // in the browser console so devs aren't confused why their local
    // OAuth flow didn't fire.
    // eslint-disable-next-line no-console
    console.warn(
      `[lykn] Claude requires https; coerced ${raw} → ${PUBLIC_LYKN_MCP_URL}. ` +
        `Set VITE_PUBLIC_MCP_URL to a tunnelled https URL to test against local.`,
    );
  }
  return PUBLIC_LYKN_MCP_URL;
}

/**
 * Build a Claude.ai install deep link that opens claude.ai with the
 * "Add custom connector" modal PRE-POPULATED with our name + MCP URL.
 * User clicks Add, approves the LYKN consent screen, done — 3 clicks
 * total instead of the 5-step "open settings, find connectors, click
 * Add custom, paste URL, hit Add" path.
 *
 * Per Claude's docs (claude.com/docs/connectors/building/directory-vs-custom):
 *
 *   https://claude.ai/customize/connectors?modal=add-custom-connector
 *     &connectorName=NAME
 *     &connectorUrl=ENCODED_URL
 *
 * connectorUrl is percent-encoded AND MUST be https — Claude refuses
 * to add http/localhost connector URLs since their cloud reaches out
 * to them server-side. We coerce via ensureHttpsMcpUrl so dev clicks
 * still produce a working deep link (pointed at prod LYKN).
 *
 * Works on Free, Pro, and Max plans. The resulting custom connector
 * auto-syncs to Claude Desktop, mobile, Cowork, and Claude Code with
 * no extra config (Anthropic ties connectors to the user, not the
 * client install).
 */
export function buildClaudeWebOauthDeeplink({ mcpUrl }) {
  const url = ensureHttpsMcpUrl(mcpUrl);
  return (
    "https://claude.ai/customize/connectors" +
    "?modal=add-custom-connector" +
    "&connectorName=LYKN" +
    "&connectorUrl=" + encodeURIComponent(url)
  );
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
