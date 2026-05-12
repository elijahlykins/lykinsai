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
    id: "claude-code",
    clientKind: "claude-code",
    name: "Claude Code",
    domain: "claude.ai",
    color: "#D97757",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via `claude mcp add` (OAuth)",
    summary:
      "Anthropic's CLI coding agent. One click copies a `claude mcp add` command — paste it in your terminal and Claude Code does the OAuth handshake against LYKN automatically. No token to bake in, no JSON to edit.",
    helpUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp",
    helpLabel: "Claude Code MCP docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // ── Claude Code is a terminal-only surface; no browser deep link
    //    can pop it. Best UX is to copy one canonical install command
    //    that uses HTTP transport (so Claude Code's built-in OAuth
    //    handshake runs against /mcp → 401 → discovery → DCR → consent,
    //    same flow as Cursor). User pastes, hits Enter, browser tab
    //    opens for Approve, we auto-detect the resulting bearer.
    connectMode: "claude-code-cli",
    openUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp",
    planNote:
      "Requires Claude Code v0.4+ (which ships built-in OAuth for HTTP-transport MCP servers). No API key or token baking required.",
    installSteps: [
      "Press Connect Claude Code — we copy the install command to your clipboard.",
      "Paste it into your terminal and press Enter.",
      "Claude Code pops a browser tab to the LYKN consent screen — click Approve.",
      "Claude Code finishes the handshake silently. We auto-detect the new bearer here.",
    ],
    successHint:
      "LYKN is now registered as a Claude Code MCP server — confirm with `claude mcp list`. Run `claude` and the synthesis-layer tools are wired into your coding agent.",
  },
  {
    id: "claude",
    clientKind: "claude",
    name: "Claude",
    domain: "claude.ai",
    color: "#D97757",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Connectors (OAuth)",
    // ── ONE card covers every Claude surface. Anthropic ties custom
    //    connectors to the user account, not the app install — so
    //    adding LYKN once via claude.ai's prefilled modal auto-syncs
    //    to Claude Desktop, Claude mobile, Cowork, AND Claude Code.
    //    The old separate web / Desktop cards just confused users
    //    ("do I need to do both?"). One card, one click, all surfaces.
    summary:
      "Anthropic's assistant — web, Desktop, mobile, and Cowork all share the same connector list. One click opens claude.ai with the Add Custom Connector dialog already filled in for LYKN — you approve once and every Claude surface you sign into picks it up automatically. Available on Free, Pro, and Max.",
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
      "Press Connect Claude — we open claude.ai with the Add Custom Connector dialog already filled in.",
      "Inside Claude: click Add.",
      "Approve the LYKN consent screen when it pops — that's it.",
    ],
    // Surfaced after the connection is detected. The fact that ONE
    // approval covers every Claude surface is genuinely the headline
    // — make sure users notice they don't need to do anything in
    // Desktop, mobile, or Cowork separately.
    successHint:
      "This connection auto-syncs to every Claude surface — Desktop, mobile, Cowork, and Claude Code all pick it up automatically. Nothing to install on any of those. We're also working with Anthropic on a one-click Directory listing for future users.",
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
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Perplexity Connectors (OAuth)",
    // ── Perplexity launched custom remote MCP connectors in 2026 on
    //    Pro and Enterprise. Same OAuth handshake as Claude / Cursor
    //    once installed (our /mcp 401 → discovery → DCR → consent),
    //    but Perplexity does NOT ship a prefill deep link for the
    //    Add Custom Connector modal — closest analog would be the
    //    open issue at github.com/anthropics/claude-ai-mcp#74 asking
    //    Anthropic for the same; nothing comparable from Perplexity
    //    yet. So we fall back to the ChatGPT-style guided pattern:
    //    auto-copy LYKN's MCP URL, open the Connectors settings
    //    page in a new tab, show the 4-step checklist inside the
    //    dialog. Connection auto-detection works identically because
    //    the resulting DCR-issued bearer is what we poll for.
    summary:
      "AI search + research. Pro and Enterprise plans get custom remote MCP connectors with full OAuth. Click Connect — we copy LYKN's URL and open Perplexity's Connectors settings, you paste once, approve, and Perplexity's answers start drawing from your beliefs, rules, facts, and vault.",
    helpUrl: "https://www.perplexity.ai/help-center/en/articles/11502712-custom-connectors-on-perplexity",
    helpLabel: "Perplexity Connectors help",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // No connectMode set → falls through to the default "open-url"
    // path in OauthMcpSection.handleConnect (copy URL + open new tab).
    openUrl: "https://www.perplexity.ai/account/connectors",
    // ── Surfaced ON THE CARD (amber ribbon) and at the TOP of the
    //    dialog. Use sparingly — this is for "may not work even if
    //    you do everything right" caveats that the user needs to see
    //    BEFORE they invest time clicking through.
    //
    //    Perplexity is gating custom-connector loading behind a
    //    Cloudflare Access policy on `_restricted/restricted-feature-
    //    loader-*.js`. Even paid Pro accounts can hit `auth_status:
    //    NONE` from CF Access today, in which case the Add modal
    //    submits without ever calling our /oauth/register and 422s on
    //    Perplexity's own `/rest/sources/custom`. Their UI then shows
    //    a generic "Dynamic client registration did not return a
    //    client_id" error that blames the MCP server even though we
    //    were never contacted. Front-load the caveat so users don't
    //    file LYKN bugs for it.
    cardWarning:
      "Perplexity is rolling this out gradually — some Pro accounts can't connect yet (Cloudflare Access denies their custom-connectors bundle, surfacing as a generic “DCR didn't return a client_id” error). Max / Enterprise accounts work. Pro accounts: if it fails, it's their rollout, not LYKN.",
    // Front-loaded plan-gating: the LAST thing we want is a Free-plan
    // user clicking Connect, getting a tab to Perplexity, and discovering
    // there's no Add Custom Connector button. Surface this BEFORE the
    // click so they self-select out.
    planNote:
      "Requires Perplexity Pro, Max, or Enterprise (custom remote connectors aren't available on the Free plan). The Connectors page will just show built-in integrations if you're not paid.",
    installSteps: [
      "Open Perplexity → Settings → Connectors (we deep-linked you there).",
      "Click + Custom connector → choose Remote.",
      "Paste the URL above into the Server URL field. Authentication = OAuth.",
      "Click Connect / Save → approve the LYKN consent screen when it pops — that's it.",
    ],
    successHint:
      "Add a custom instruction to your Spaces or default profile telling Perplexity to call LYKN when it needs context about you — e.g. \"Before answering personal questions, consult my LYKN context with lykn_getContextBlock.\" Without that nudge, Perplexity won't reach for it on its own the way Claude does.",
  },
  {
    id: "gemini",
    clientKind: "gemini",
    name: "Gemini CLI",
    domain: "gemini.google.com",
    color: "#4285F4",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via `gemini mcp add` (OAuth)",
    // ── ONLY the Gemini CLI surface supports remote MCP today.
    //    gemini.google.com / Workspace / mobile have NO Add Custom
    //    Connector UI — they ship a fixed set of built-in extensions
    //    (Search, Maps, YouTube, Flights, Hotels) and there's no
    //    user-facing way to point them at an arbitrary MCP URL.
    //    Gemini Enterprise on GCP supports custom MCP data stores
    //    but it's Workspace-admin-gated and requires an org-policy
    //    override + Discovery Engine Editor role; not a 1-click flow.
    //    So this card is specifically for Gemini CLI — same shape as
    //    Claude Code (terminal install via `gemini mcp add`). When
    //    Google ships consumer-side Add Custom Connector, we'll
    //    rename this card to "Gemini" and route to whichever surface
    //    has the better install path (likely a prefill deep link).
    summary:
      "Google's CLI coding agent. One click copies a `gemini mcp add` command — paste it in your terminal and Gemini CLI runs the OAuth handshake against LYKN automatically. No API key, no JSON to edit.",
    helpUrl: "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html",
    helpLabel: "Gemini CLI MCP docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // ── Gemini CLI is terminal-only — same install pattern as Claude
    //    Code (no browser deep link can pop a terminal). The CLI's
    //    `mcp add --transport http` subcommand registers the server in
    //    ~/.gemini/settings.json; on first request Gemini hits /mcp,
    //    gets the 401, reads `WWW-Authenticate: ... resource_metadata`,
    //    auto-discovers our OAuth provider, registers via DCR, pops a
    //    browser tab to http://localhost:7777/oauth/callback for
    //    consent, and stores the resulting bearer in
    //    ~/.gemini/mcp-oauth-tokens.json. Identical security model to
    //    Cursor — no PAT in the command, lifecycle in /Connections.
    connectMode: "gemini-cli",
    openUrl: "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html",
    planNote:
      "Requires Gemini CLI installed locally (npm i -g @google/gemini-cli). Free to install; the underlying Gemini API quota covers what the CLI actually calls. No paid plan or API key needed for the LYKN connection itself — Gemini CLI's built-in OAuth handles the handshake.",
    installSteps: [
      "Press Connect Gemini CLI — we copy the install command to your clipboard.",
      "Paste it into your terminal and press Enter.",
      "Gemini CLI pops a browser tab to the LYKN consent screen — click Approve.",
      "Gemini CLI stores the token at ~/.gemini/mcp-oauth-tokens.json. We auto-detect the new bearer here.",
    ],
    successHint:
      "LYKN is now wired into Gemini CLI — confirm with `gemini mcp list`. Run `gemini` and ask it to use the LYKN tools; the synthesis layer is available everywhere `gemini` runs on this machine.",
  },
  {
    id: "grok",
    clientKind: "grok",
    name: "Grok",
    domain: "grok.com",
    color: "#000000",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Grok Connectors (OAuth)",
    // ── Grok shipped user-facing custom MCP connectors via
    //    grok.com/manage-connectors. The flow is "+ Add connector"
    //    → custom URL → OAuth approval, fully analogous to Cursor /
    //    Claude / Perplexity on the OAuth side. Streamable HTTP and
    //    SSE transports both supported (we ship Streamable HTTP).
    //    No prefill deep link exists (xAI hasn't shipped one), so
    //    this falls back to the guided open-tab + paste-URL pattern
    //    we use for Perplexity / ChatGPT. Connection auto-detection
    //    works because Grok's DCR pops a bearer that our token poll
    //    picks up like any other.
    summary:
      "xAI's Grok — deep reasoning + live web search across web, iOS, and Android. SuperGrok and SuperGrok Heavy support custom remote MCP connectors with OAuth. Click Connect — we copy LYKN's URL and open Grok's connector manager, you paste once, approve, done.",
    helpUrl: "https://docs.x.ai/developers/tools/remote-mcp",
    helpLabel: "Grok Remote MCP docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // No connectMode → default open-url path: auto-copy LYKN's MCP
    // URL + open grok.com/manage-connectors in a new tab. Same code
    // path as Perplexity and ChatGPT.
    openUrl: "https://grok.com/manage-connectors",
    // Front-loaded plan gate so Free users self-select out before
    // discovering the connectors page is paywalled.
    planNote:
      "Requires a Grok subscription — SuperGrok or SuperGrok Heavy. The Free Grok tier doesn't expose the connectors page. iOS and Android Grok apps inherit the same connector list once you connect on web.",
    installSteps: [
      "Open Grok → Manage Connectors (we deep-linked you there).",
      "Click + Add connector → choose Custom (or Add custom MCP server).",
      "Paste the URL above into the Server URL field. Transport: Streamable HTTP. Authorization: OAuth.",
      "Click Connect — approve the LYKN consent screen when it pops. That's it.",
    ],
    successHint:
      "Connector lists are shared across grok.com, iOS, and Android — no extra setup on mobile. Like Perplexity, Grok doesn't proactively call MCP tools without being told to: add a Grok custom instruction like \"Before answering personal questions, consult my LYKN context with lykn_getContextBlock\" so it actually reaches for the synthesis layer.",
  },

  // ─── Tier 2 — next wave ──────────────────────────────────────────
  {
    id: "windsurf",
    clientKind: "windsurf",
    name: "Windsurf",
    domain: "windsurf.com",
    color: "#09B6A2",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via mcp-remote proxy (OAuth)",
    // ── Windsurf has two install paths today:
    //
    //    1. windsurf:// install-link deeplink — TRUE 1-click but ONLY
    //       for servers registered in Windsurf's MCP marketplace
    //       (`windsurf://windsurf-mcp-registry?serverName=<name>`
    //       resolves serverName against the marketplace, not a URL).
    //       Marketplace requires submission + approval; tracked
    //       separately, not blocking this card.
    //
    //    2. mcp_config.json paste — works today for ANY custom remote
    //       MCP server. Windsurf's HTTP transport supports static
    //       headers but NOT OAuth DCR natively, so we use the
    //       standard `mcp-remote` stdio proxy
    //       (npmjs.com/package/mcp-remote) to wrap our /mcp endpoint
    //       with OAuth handling: Windsurf spawns
    //       `npx -y mcp-remote https://lykn.io/mcp` as a subprocess,
    //       mcp-remote does the /mcp → 401 → discovery → DCR → consent
    //       dance and proxies the resulting MCP traffic. Lifecycle
    //       still lives in /connections — bearer rotation works the
    //       same as Cursor's because it's the same OAuth handshake.
    //
    //    We ship the config-snippet flow today. When LYKN is approved
    //    in the marketplace we can flip connectMode to a true
    //    `windsurf-deeplink` and skip the JSON-paste step entirely.
    summary:
      "AI-native IDE (strong Cursor competitor). One click copies the JSON snippet you paste into Windsurf's MCP config — Windsurf spawns mcp-remote which handles the OAuth handshake against LYKN automatically. Cascade then sees your synthesis layer on every coding session.",
    helpUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
    helpLabel: "Windsurf MCP docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    connectMode: "windsurf-config",
    openUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
    planNote:
      "Requires Windsurf and Node.js installed locally (Node is needed because Windsurf doesn't natively do OAuth DCR on HTTP MCP servers — we use `npx mcp-remote` to bridge that). No paid plan required; Windsurf's MCP support ships on Free.",
    installSteps: [
      "Press Connect Windsurf — we copy the JSON snippet to your clipboard.",
      "In Windsurf: Command Palette (Shift+Cmd+P / Ctrl+Shift+P) → \"Windsurf: Configure MCP Servers\".",
      "Paste the snippet inside the `mcpServers` object (or wrap it in `{ \"mcpServers\": { … } }` if the file is empty). Save.",
      "Windsurf hot-reloads the file and spawns mcp-remote — a browser tab pops to the LYKN consent screen. Click Approve.",
      "Subsequent Cascade chats use LYKN automatically. We auto-detect the new bearer here.",
    ],
    successHint:
      "LYKN is now wired into Cascade. To get Cascade to actually reach for it, mention LYKN by name in your prompt or add a Cascade rule in Settings → Cascade → Rules telling it to consult your context first. We're also working on getting LYKN approved in Windsurf's MCP marketplace — when that lands, this will become a true 1-click `windsurf://` deeplink and the JSON-paste step goes away.",
  },
  {
    id: "replit",
    clientKind: "replit",
    name: "Replit",
    domain: "replit.com",
    color: "#F26207",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Replit Integrations (OAuth)",
    // ── Replit shipped custom MCP support in their December 2025
    //    changelog and exposed a base64-payload install-link spec at
    //    docs.replit.com/replitai/mcp/install-links. Format is:
    //
    //      https://replit.com/integrations?mcp=<base64(JSON)>
    //
    //    Where the JSON is { displayName, baseUrl, headers[] }. We pass
    //    an empty `headers` array because Replit auto-detects OAuth DCR
    //    on the baseUrl — exactly the same handshake Cursor uses (our
    //    /mcp returns 401 with WWW-Authenticate: ... resource_metadata,
    //    Replit follows the discovery URL, registers via DCR, pops the
    //    /oauth/consent screen in a new tab). True 1-click parity with
    //    Cursor and Claude — promoted to tier 1 because of this.
    summary:
      "Replit Agent (the AI app builder + deploy platform) shipped custom MCP support in Dec 2025. One click opens Replit's Integrations page with LYKN's MCP server already filled in — hit Test & Save, approve the consent screen, done. Agent then sees your synthesis layer in every Repl.",
    helpUrl: "https://docs.replit.com/replitai/mcp/overview",
    helpLabel: "Replit MCP docs",
    available: true,
    tier: 1,
    direction: "bidirectional",
    connectMode: "replit-prefill",
    openUrl: "https://replit.com/integrations",
    // Plan gating: Replit hasn't published an explicit MCP-tier matrix
    // (their custom-MCP docs read as universally available across paid
    // tiers), but custom integrations historically require Replit Core
    // or above. We surface this honestly rather than over-promise free.
    planNote:
      "Requires a paid Replit account (Core or above) — same tier that unlocks Agent itself. Replit Agent has to be enabled for your account before the Integrations page shows the MCP Servers section.",
    installSteps: [
      "Press Connect Replit — we open replit.com/integrations with LYKN's MCP server already filled in.",
      "Inside Replit: click Test & Save on the prefilled Add MCP Server form.",
      "Approve the LYKN consent screen when it pops — that's it.",
    ],
    successHint:
      "LYKN is now wired into Replit Agent. To get Agent to actually reach for it, mention it by name in your prompt (e.g. \"check my LYKN context first, then…\") or set a project-level instruction in your Repl's `.replit` agent config. Replit's security scanner will surface any LYKN tools it deems suspicious before they run.",
  },
  {
    id: "github-copilot",
    clientKind: "github-copilot",
    name: "GitHub Copilot",
    domain: "github.com",
    color: "#171515",
    installType: "oauth-mcp",
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
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Notion AI Custom Agents (OAuth)",
    // ── Notion shipped custom MCP support for AI Custom Agents in
    //    2025/2026. Reference: notion.com/help/mcp-connections-for-
    //    custom-agents. Path is: workspace admin enables custom MCP
    //    under Settings → Notion AI → AI connectors (one-time, per
    //    workspace), THEN each user can add LYKN per-agent under
    //    Custom Agent → Settings → Tools & Access → Add connection
    //    → Custom MCP server → paste URL + auth = OAuth → save.
    //    No prefill deep link exists (the form lives inside a Custom
    //    Agent's panel which has no URL of its own), so we fall back
    //    to the guided pattern: copy LYKN's MCP URL + open Notion's
    //    Custom Agents docs, then show the install checklist. Same
    //    DCR-issued bearer is what we poll for, so connection
    //    detection is identical to Perplexity / Grok / Zapier.
    summary:
      "Notion's Custom Agents — Business and Enterprise workspaces can wire LYKN into any agent. One click copies the MCP URL and opens Notion's Custom Agents docs; you paste once inside the agent's Tools & Access panel, approve, done. Agent answers + writebacks then ground in your synthesis layer.",
    helpUrl: "https://www.notion.com/help/mcp-connections-for-custom-agents",
    helpLabel: "Notion Custom Agents MCP help",
    available: true,
    tier: 1,
    direction: "bidirectional",
    // No connectMode set → defaults to "open-url" (copy URL + open new
    // tab) in UseLyknWithDialog.handleConnect.
    openUrl: "https://www.notion.com/help/mcp-connections-for-custom-agents",
    // Plan + admin gating: surface BOTH gates up front so users on
    // Personal / Plus / Free don't click in vain, and so members of
    // Business+ workspaces know to ping their admin first. Notion's
    // help doc is explicit: custom MCP servers are admin-toggled per
    // workspace under Settings → Notion AI → AI connectors before
    // members can add their own per-agent.
    planNote:
      "Requires a Notion Business or Enterprise workspace AND a workspace admin to first enable custom MCP servers under Settings → Notion AI → AI connectors. Once that's on, any member can add LYKN to their Custom Agents. Personal / Plus / Free plans don't expose Custom Agents at all.",
    installSteps: [
      "(One-time, admin only) In your workspace: Settings → Notion AI → AI connectors → toggle Custom MCP servers on.",
      "Open the Custom Agent you want LYKN wired into (or create a new one).",
      "Inside the agent: Settings → Tools & Access → Add connection → Custom MCP server.",
      "Paste the URL above into Server URL. Set Display name = LYKN. Authentication = OAuth.",
      "Click Save → approve the LYKN consent screen when it pops — that's it.",
    ],
    successHint:
      "Each Custom Agent has its own MCP connections — adding LYKN to one agent does NOT auto-add it to the others. Repeat the Tools & Access step on any other agent you want LYKN in. Workspace admins can also gate which agents members are allowed to connect LYKN to under the AI connectors panel.",
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
    id: "zapier",
    clientKind: "zapier",
    name: "Zapier",
    domain: "zapier.com",
    color: "#FF4A00",
    installType: "oauth-mcp",
    transport: "Streamable HTTP MCP via Zapier MCP Client (OAuth)",
    // ── Zapier ships TWO MCP integrations and the plan conflated them:
    //
    //   1. Zapier MCP SERVER (mcp.zapier.com) — users paste Zapier's
    //      URL into an MCP client. That bypasses LYKN entirely; not
    //      a /connections candidate.
    //
    //   2. "MCP Client by Zapier" (beta) — Zapier acts as the MCP
    //      CLIENT and subscribes to remote MCP servers like LYKN via
    //      OAuth. Once connected, LYKN's tools become triggers /
    //      actions inside any Zap. THIS is what we wire up: same
    //      OAuth handshake as Cursor / Claude / Perplexity, just
    //      with a guided overlay (Zapier doesn't ship a prefill
    //      deep link). Net effect: any Zap → LYKN's 8 synthesis
    //      tools → 9000+ apps that can read from your beliefs /
    //      rules / facts / vault. Meta-integration unlocked.
    //
    // Direction is "bidirectional" because Zaps can both read FROM
    // LYKN (lykn_getContextBlock, lykn_getBeliefs, etc.) and write
    // INTO LYKN (lykn_proposeFact, lykn_proposeBelief).
    summary:
      "Workflow automation across 9,000+ apps. Zapier's MCP Client (beta) subscribes to LYKN like Claude or Cursor — once connected, any Zap can call your LYKN tools as triggers or actions, so the automations you build can read from (and write to) your synthesis layer.",
    helpUrl: "https://help.zapier.com/hc/en-us/articles/38777069364109-Connect-remote-MCP-servers-to-Zapier-using-MCP-Client",
    helpLabel: "Zapier MCP Client docs",
    available: true,
    tier: 2,
    direction: "bidirectional",
    // No connectMode → default "open-url" path: auto-copy LYKN's MCP
    // URL + open Zapier's app-connections page in a new tab. The MCP
    // Client connection is created from inside the Zap editor (Zapier
    // doesn't expose a standalone "add MCP" page), so the steps walk
    // the user through creating a temporary Zap with an MCP Client
    // step. Once the connection exists, it's reusable across all
    // future Zaps — they only do this once.
    openUrl: "https://zapier.com/app/connections",
    planNote:
      "MCP Client by Zapier is currently in beta and available on all paid Zapier plans (Pro / Team / Company). Free Zaps may also work depending on Zapier's rollout — try it; if the MCP Client app doesn't appear in your Zap editor, you'll need to upgrade.",
    installSteps: [
      "Open Zapier (we opened the App Connections page for you) → click + Add Connection.",
      "Search for and select MCP Client by Zapier.",
      "Server URL: paste the URL we copied. Transport: Streamable HTTP. OAuth: Yes. Click Continue.",
      "Approve the LYKN consent screen when it pops — Zapier finishes the handshake silently.",
      "Back in Zapier, create or open a Zap and add MCP Client by Zapier as a step → LYKN's tools appear as triggers and actions.",
    ],
    successHint:
      "LYKN is now a callable integration inside every Zap. Try a quick test: create a Zap with a Schedule trigger + MCP Client by Zapier → Run Tool → lykn_getContextBlock. Whenever Zapier runs that Zap, it'll pull your latest synthesis context. The meta-pattern: LYKN as the synthesis layer for any automation you build.",
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
  oauth: { label: "Connect with OAuth", tone: "emerald" },
  "oauth-mcp": { label: "One-click connect (OAuth)", tone: "emerald" },
  openapi: { label: "Custom GPT Action", tone: "amber" },
  "api-key": { label: "Paste API key", tone: "blue" },
  "browser-extension": { label: "Via LYKN extension", tone: "amber" },
  raw: { label: "Raw URL + token", tone: "neutral" },
};

/**
 * Build the canonical `claude mcp add` command for Claude Code. This
 * is intentionally a CLI string with NO embedded token — Claude Code
 * v0.4+ ships built-in OAuth for HTTP-transport MCP servers, so on
 * first request it'll hit /mcp → 401 → discover our OAuth provider
 * via the WWW-Authenticate header → DCR → pop a browser tab to the
 * LYKN consent screen. Exactly the same handshake Cursor uses,
 * just triggered from a terminal paste instead of a deep link.
 *
 * Syntax (per `claude mcp add --help` on v2.1+):
 *
 *   claude mcp add [options] <name> <commandOrUrl> [args...]
 *
 * The URL is a POSITIONAL argument right after the server name. We
 * default to `--scope user` so the connection persists across all
 * the user's Claude Code projects — they almost certainly want LYKN
 * everywhere, not scoped to one repo.
 */
export function buildClaudeCodeOauthInstallCommand({ mcpUrl }) {
  const url = ensureHttpsMcpUrl(mcpUrl);
  return `claude mcp add --transport http --scope user lykn "${url}"`;
}

/**
 * Build the canonical `gemini mcp add` command for Gemini CLI. Same
 * shape as the Claude Code helper above — no embedded token, the CLI's
 * built-in OAuth discovery does the handshake on first request:
 *
 *   /mcp → 401 with WWW-Authenticate: ... resource_metadata=…
 *     → .well-known/oauth-authorization-server discovery
 *     → DCR (Gemini CLI registers itself)
 *     → http://localhost:7777/oauth/callback for the redirect
 *     → user approves on /oauth/consent
 *     → token stored in ~/.gemini/mcp-oauth-tokens.json
 *
 * Per `gemini mcp --help` (CLI v0.4+, the version that shipped the
 * `mcp` subcommand — earlier versions required hand-editing
 * settings.json). Syntax:
 *
 *   gemini mcp add --transport http <name> <url>
 *
 * We don't pass `--scope` because Gemini CLI's scope model is opt-in
 * project vs. global via the absence/presence of a project-level
 * settings.json — the default writes to ~/.gemini/settings.json which
 * is what we want (LYKN everywhere `gemini` runs).
 */
export function buildGeminiCliInstallCommand({ mcpUrl }) {
  const url = ensureHttpsMcpUrl(mcpUrl);
  return `gemini mcp add --transport http lykn "${url}"`;
}

/**
 * Build the JSON snippet a user pastes into Windsurf's mcp_config.json
 * to wire LYKN into Cascade. Windsurf doesn't natively support OAuth
 * DCR on HTTP MCP servers — its native `serverUrl` shape only supports
 * static headers — so we use the standard `mcp-remote`
 * (npmjs.com/package/mcp-remote) stdio proxy to bridge the gap:
 *
 *   Windsurf spawns `npx -y mcp-remote <url>` as a subprocess
 *     → mcp-remote opens /mcp on our server
 *     → gets 401 with WWW-Authenticate: ... resource_metadata=…
 *     → auto-discovers our OAuth provider via /.well-known
 *     → DCR (mcp-remote registers itself)
 *     → pops a browser tab for /oauth/consent
 *     → user approves
 *     → mcp-remote caches the bearer in ~/.mcp-auth
 *     → proxies all subsequent MCP traffic over stdio to Windsurf
 *
 * The snippet is intentionally JUST the inner server entry (the
 * `"lykn": { … }` object), NOT wrapped in the outer
 * `{ "mcpServers": { … } }` shell. That's because most Windsurf users
 * already have OTHER MCP servers configured — pasting a full wrapped
 * object would clobber them. The dialog UX instructs the user to add
 * the snippet inside their existing `mcpServers` object, or wrap it
 * in `{ "mcpServers": { … } }` if the file is empty.
 *
 * `npx -y` flag auto-confirms the install prompt; `mcp-remote` is
 * unscoped and tiny (~30kb), no real install delay.
 */
export function buildWindsurfConfigSnippet({ mcpUrl }) {
  const url = ensureHttpsMcpUrl(mcpUrl);
  // `--static-oauth-client-metadata` overrides what mcp-remote sends
  // during DCR. We pin `client_name: "Windsurf"` so our classifier
  // (oauth-server.js → classifyClientKind) can attribute the resulting
  // bearer to Windsurf specifically — without the override, mcp-remote
  // self-reports generically and ANY mcp-remote-wrapped client (which
  // could be Windsurf, an older Claude Desktop, a hand-rolled stdio
  // client…) would be indistinguishable in /connections. Passing JSON
  // as a CLI argument means the value has to be a single-quoted string
  // at the shell level — JSON.stringify gives us a valid double-quoted
  // payload which Windsurf's mcp_config.json then re-quotes via the
  // standard JSON-array `args` syntax.
  const inner = {
    lykn: {
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        url,
        "--static-oauth-client-metadata",
        JSON.stringify({ client_name: "Windsurf" }),
      ],
    },
  };
  return JSON.stringify(inner, null, 2);
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

/**
 * Build a Replit Integrations prefill URL. Per
 * docs.replit.com/replitai/mcp/install-links the spec is:
 *
 *   https://replit.com/integrations?mcp=<base64(JSON)>
 *
 * Where the JSON payload contains:
 *   - displayName: shown to the user during the Test & Save step
 *   - baseUrl:     our /mcp endpoint (Replit auto-discovers OAuth here)
 *   - headers:     OPTIONAL static headers; we pass an empty array so
 *                  Replit falls through to OAuth DCR auto-discovery
 *                  (the same /mcp → 401 → WWW-Authenticate → DCR →
 *                  /oauth/consent flow Cursor uses).
 *
 * Replit's docs explicitly call out base64 encoding (NOT base64url),
 * but they don't say which variant. We use base64url + padding the
 * same way Cursor's install-link spec does — it's URL-safe by default
 * and the standard JSON.parse(atob(base64url-with-padding)) decoder
 * handles both variants. If Replit ever rejects the payload, swap
 * `base64UrlEncode` for a strict-base64 helper.
 *
 * Spec: https://docs.replit.com/replitai/mcp/install-links
 */
export function buildReplitOauthInstallLink({ mcpUrl }) {
  const url = ensureHttpsMcpUrl(mcpUrl);
  const payload = {
    displayName: "LYKN",
    baseUrl: url,
    headers: [],
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `https://replit.com/integrations?mcp=${encoded}`;
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
  // Unified "claude" key — same Projects surface across web, Desktop,
  // mobile, and Cowork (Anthropic shares the user's Project list across
  // every Claude client). Used by the merged "claude" target.
  claude: {
    surfaceLabel: "Project knowledge",
    steps: [
      "In Claude (web, Desktop, mobile, or Cowork — any surface works), create or open a Project (sidebar → Projects → New project).",
      "Open Project knowledge (or Custom Instructions, depending on your version).",
      "Paste the snippet below. Save.",
      "Start chats inside this Project — Claude will follow the contract automatically on every surface signed into the same account.",
    ],
    helpUrl: "https://support.anthropic.com/en/articles/9519177-using-projects-in-claude-ai",
    helpLabel: "Claude Projects help",
  },
  // Legacy aliases — DCR-issued tokens may still arrive with these
  // client_kind values (Claude's web SDK reports "claude-web", the
  // Desktop bridge reports "claude-desktop"). Aliasing them to the
  // same Projects flow means the dialog still shows useful steps if
  // someone opens it from a "Connected as claude-desktop" row.
  "claude-desktop": {
    surfaceLabel: "Project knowledge",
    steps: [
      "Open Claude Desktop → sidebar → Projects → New project (or open an existing one).",
      "Open Project knowledge (or Custom Instructions, depending on your version).",
      "Paste the snippet below. Save.",
      "Start chats inside this Project — Claude will follow the contract automatically.",
    ],
    helpUrl: "https://support.anthropic.com/en/articles/9519177-using-projects-in-claude-ai",
    helpLabel: "Claude Projects help",
  },
  "claude-web": {
    surfaceLabel: "Project knowledge",
    steps: [
      "Open claude.ai → sidebar → Projects → New project (or open an existing one).",
      "Open Project knowledge (or Custom Instructions, depending on your version).",
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
  // Gemini CLI mirrors Claude Code's memory model — there's a global
  // ~/.gemini/GEMINI.md for system-wide instructions and an optional
  // per-project GEMINI.md at the repo root. Same paste-and-save flow.
  // (Per https://google-gemini.github.io/gemini-cli/docs/memory.html —
  // Gemini CLI's memory subsystem loads GEMINI.md files hierarchically
  // from CWD upward, then from ~/.gemini/GEMINI.md as the fallback.)
  gemini: {
    surfaceLabel: "GEMINI.md",
    steps: [
      "Create (or open) ~/.gemini/GEMINI.md for global instructions, OR a GEMINI.md in your project root for per-project rules.",
      "Paste the snippet below. Save.",
      "Run `gemini` in that directory — Gemini CLI reads GEMINI.md on startup.",
    ],
    helpUrl: "https://google-gemini.github.io/gemini-cli/docs/memory.html",
    helpLabel: "Gemini CLI memory docs",
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
  // Replit Agent reads instructions from a few places: the
  // [agent.instructions] section in .replit, the per-Repl AGENTS.md
  // convention, and the chat-level system prompt. Repl-level is the
  // most reliable (loads on every Agent session); .replit overrides
  // it for power users who want global rules across all their Repls.
  replit: {
    surfaceLabel: "AGENTS.md / .replit",
    steps: [
      "Create AGENTS.md in your Repl's root (or open .replit and add an [agent] section).",
      "Paste the snippet below. Save / commit.",
      "Restart the Agent panel — Replit reloads the instructions on each new Agent session.",
    ],
    helpUrl: "https://docs.replit.com/replitai/agent",
    helpLabel: "Replit Agent docs",
  },
  // Windsurf's Cascade reads rules from Settings → Cascade → Rules
  // (global, applies to every workspace) plus an optional per-project
  // .windsurfrules file. Global rules are the most reliable place to
  // put a "always consult LYKN first" contract.
  windsurf: {
    surfaceLabel: "Cascade Rules",
    steps: [
      "In Windsurf, open Settings → Cascade → Rules (or create .windsurfrules in your project root for per-project).",
      "Paste the snippet below. Save.",
      "Cascade applies rules automatically on the next message; LYKN tools are reachable immediately.",
    ],
    helpUrl: "https://docs.windsurf.com/windsurf/cascade/memories",
    helpLabel: "Cascade Memories docs",
  },
  // Notion Custom Agents have per-agent instructions in their settings
  // panel — that's the canonical place to drop a system-prompt-style
  // contract that tells the agent how + when to reach for LYKN.
  "notion-ai": {
    surfaceLabel: "Custom Agent instructions",
    steps: [
      "Open the Custom Agent you wired LYKN into.",
      "In its Settings → Instructions panel, paste the snippet below at the end of (or above) any existing instructions.",
      "Save the agent — Notion AI reloads instructions on the next message.",
    ],
    helpUrl: "https://www.notion.com/help/guides/custom-agents",
    helpLabel: "Notion Custom Agents help",
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
