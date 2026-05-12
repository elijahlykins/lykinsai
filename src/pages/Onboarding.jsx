import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sparkles,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Copy,
  Circle,
} from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import {
  buildCursorOauthDeeplink,
  buildClaudeWebOauthDeeplink,
  buildClaudeCodeOauthInstallCommand,
  buildGeminiCliInstallCommand,
  buildCodexCliInstallCommand,
  buildReplitOauthInstallLink,
  buildWindsurfConfigSnippet,
  buildJetBrainsConfigSnippet,
  buildCopilotInstallLink,
} from "@/lib/connectors/outboundTargets";

/**
 * Post-signup "Connect your AI tools" onboarding screen.
 *
 * Seven cards spanning the full OAuth-MCP catalog we've shipped. Two
 * tiers of friction:
 *
 *   Headliners (top, 1-click or near-1-click, free-plan-friendly):
 *
 *     1. Cursor — true 1-click via cursor:// deeplink. Cursor opens,
 *        401s on /mcp, reads `WWW-Authenticate: ... resource_metadata`,
 *        discovers our OAuth provider via /.well-known, registers via
 *        DCR, and pops /oauth/consent for the user to Approve. The
 *        user is already authed in this browser → single click.
 *
 *     2. Claude — 1-click prefilled-modal deep link to
 *        https://claude.ai/customize/connectors?modal=add-custom-connector
 *        &connectorName=LYKN&connectorUrl=<mcp>. Claude surfaces the
 *        Add Custom Connector dialog ALREADY populated; user clicks
 *        Add → approves consent. One approval syncs to web, Desktop,
 *        mobile, and Cowork — Anthropic's connector store is per-account.
 *
 *     3. ChatGPT — guided overlay (no deeplink exists). We open
 *        chatgpt.com + copy the URL, then surface the 5-step
 *        walkthrough. Plus / Pro / Team / Enterprise + Developer Mode.
 *
 *   More tools (below, mix of 1-click, CLI, and guided OAuth flows):
 *
 *     4. Replit — 1-click prefill deep link. Replit shipped custom MCP
 *        in Dec 2025 with a base64-payload `?mcp=…` install-link spec
 *        that pre-populates Add MCP Server. Hit Test & Save, approve,
 *        done. Paid plan (Replit Core+) required.
 *
 *     5. Notion AI — guided OAuth. Notion's Custom Agents support
 *        custom MCP servers (per notion.com/help/mcp-connections-for-
 *        custom-agents) but the form is buried inside each Agent's
 *        Settings → Tools & Access panel — no URL to deep link to.
 *        We open notion.so/settings (the workspace settings overlay,
 *        NOT the docs page) so users land in their actual account
 *        with the AI Connectors panel one click away.
 *        We open the help page + copy LYKN's URL; user pastes it per
 *        Agent. Business / Enterprise only + workspace admin has to
 *        first toggle Custom MCP on.
 *
 *     6. Claude Code — CLI install. We copy `claude mcp add --transport
 *        http --scope user lykn "<mcp-url>"` to the clipboard so the
 *        user can paste it in their terminal. Same OAuth dance fires
 *        once they run it.
 *
 *     7. Gemini CLI — CLI install. We copy `gemini mcp add --transport
 *        http lykn "<mcp-url>"`. Same shape as Claude Code; the
 *        gemini-cli docs confirm built-in OAuth auto-discovery on
 *        remote http MCP servers. Note: only the Gemini CLI surface
 *        supports custom MCP today — gemini.google.com / Workspace
 *        consumer have no Add Custom Connector UI.
 *
 *     8. Codex CLI — CLI install. We copy `codex mcp add lykn --url
 *        "<mcp-url>"`. Native streamable HTTP OAuth (confirmed in the
 *        codex source at codex-rs/cli/src/mcp_cmd.rs); same handshake
 *        Cursor / Claude Code / Gemini CLI use. Config persists in
 *        ~/.codex/config.toml under [mcp_servers.lykn].
 *
 *     9. Windsurf — config-file install. We copy a JSON snippet the
 *        user pastes into mcp_config.json via Cmd+Shift+P → Configure
 *        MCP Servers. Snippet wraps our /mcp endpoint in `npx
 *        mcp-remote` (the standard stdio→HTTP bridge with OAuth)
 *        because Windsurf can't natively do DCR on HTTP MCP yet. True
 *        1-click via windsurf:// is blocked on LYKN's marketplace
 *        submission; this is the next-best path today.
 *
 *    10. JetBrains AI — config-snippet install. We copy a fully-
 *        wrapped `{ "mcpServers": { … } }` JSON payload (JetBrains'
 *        New MCP Server dialog expects this shape, NOT the inner
 *        entry alone) wrapping our /mcp endpoint in `npx mcp-remote`
 *        for OAuth bridging. Pasted into Settings → Tools → AI
 *        Assistant → MCP → New, or into ~/.junie/mcp/mcp.json for
 *        Junie users. Same snippet works for both surfaces.
 *
 *    11. GitHub Copilot — true 1-click. We open VS Code's MCP install
 *        link (https://insiders.vscode.dev/redirect/mcp/install?name=
 *        lykn&config=…) which hands off to VS Code's native vscode:
 *        mcp/install handler. VS Code presents a target-selection
 *        dialog (Global / Workspace / Remote), then Copilot does the
 *        standard OAuth DCR dance on first /mcp request.
 *
 *    12. Perplexity — guided. Open
 *        https://www.perplexity.ai/account/connectors and copy the URL.
 *        Paid-only (Pro / Enterprise Pro).
 *
 *    13. Grok — guided. Open https://grok.com/manage-connectors and
 *        copy the URL. Paid (SuperGrok / Premium).
 *
 *    14. Zapier — guided. Open https://zapier.com/app/connections (MCP
 *        Client beta) and copy the URL.
 *
 * Connection detection: poll /api/v1/synthesis/tokens. Any new active
 * token with `oauth_client_id` populated = a successful OAuth
 * handshake. We snapshot the baseline the moment the page loads so we
 * only react to NEW connections.
 */
export default function Onboarding() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const mcpUrl = useMemo(() => buildAbsoluteUrl("/mcp"), []);
  const cursorDeeplink = useMemo(
    () => buildCursorOauthDeeplink({ mcpUrl }),
    [mcpUrl],
  );
  const claudeDeeplink = useMemo(
    () => buildClaudeWebOauthDeeplink({ mcpUrl }),
    [mcpUrl],
  );
  const claudeCodeCommand = useMemo(
    () => buildClaudeCodeOauthInstallCommand({ mcpUrl }),
    [mcpUrl],
  );
  const geminiCliCommand = useMemo(
    () => buildGeminiCliInstallCommand({ mcpUrl }),
    [mcpUrl],
  );
  const codexCliCommand = useMemo(
    () => buildCodexCliInstallCommand({ mcpUrl }),
    [mcpUrl],
  );
  const replitDeeplink = useMemo(
    () => buildReplitOauthInstallLink({ mcpUrl }),
    [mcpUrl],
  );
  const windsurfSnippet = useMemo(
    () => buildWindsurfConfigSnippet({ mcpUrl }),
    [mcpUrl],
  );
  const jetbrainsSnippet = useMemo(
    () => buildJetBrainsConfigSnippet({ mcpUrl }),
    [mcpUrl],
  );
  const copilotDeeplink = useMemo(
    () => buildCopilotInstallLink({ mcpUrl }),
    [mcpUrl],
  );

  // Track which clients have connected this session. Each entry is one
  // of "cursor" | "claude" | "chatgpt" | "claude-code" | "gemini" |
  // "codex-cli" | "replit" | "notion-ai" | "windsurf" | "jetbrains" |
  // "github-copilot" | "perplexity" | "grok" | "zapier"; presence in
  // the set means we've observed an OAuth bearer attributed to that
  // client.
  const [connected, setConnected] = useState(() => new Set());
  // Which client did the user most recently CLICK? Used to choose the
  // best client_kind→logical-client mapping when a new bearer appears
  // (the OAuth client_name from DCR is unreliable across hosts).
  const [pending, setPending] = useState(null);
  const [copyJustWorked, setCopyJustWorked] = useState(false);
  const baselineRef = useRef(null);

  // Establish baseline of OAuth tokens (so we only react to NEW ones).
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/v1/synthesis/tokens");
        const data = await res.json();
        if (cancelled) return;
        const oauth = (Array.isArray(data?.tokens) ? data.tokens : [])
          .filter((t) => t.status === "active" && t.oauth_client_id)
          .map((t) => t.id);
        baselineRef.current = new Set(oauth);
      } catch {
        if (!cancelled) baselineRef.current = new Set();
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Poll for new OAuth-issued bearers while at least one client is
  // pending. Stops once all 11 are connected or the user navigates
  // away. 3s cadence — tight enough to feel instant, loose enough to
  // not hammer the backend.
  useEffect(() => {
    if (!user) return undefined;
    if (!pending) return undefined;
    if (connected.size >= 14) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const res = await authedFetch("/api/v1/synthesis/tokens");
        const data = await res.json();
        if (cancelled) return;
        const baseline = baselineRef.current || new Set();
        const fresh = (Array.isArray(data?.tokens) ? data.tokens : []).filter(
          (t) => t.status === "active" && t.oauth_client_id && !baseline.has(t.id),
        );
        if (fresh.length > 0) {
          // Map each new token to one of our three logical clients.
          // client_kind is set by oauth-server.js's classifyClientKind()
          // off DCR redirect_uris + client_name — reliable enough for
          // the big three but we fall back to "the client the user
          // most recently clicked" when classification is ambiguous.
          const next = new Set(connected);
          for (const t of fresh) {
            const slot = mapClientKindToSlot(t.client_kind) || pending;
            if (slot) next.add(slot);
            // Add the token to the baseline so re-polls don't double-count.
            baseline.add(t.id);
          }
          baselineRef.current = baseline;
          setConnected(next);
          // Once we've matched the pending client, clear the spinner.
          if (pending && next.has(pending)) setPending(null);
        }
        timer = setTimeout(tick, 3000);
      } catch {
        timer = setTimeout(tick, 6000); // back off on error
      }
    };
    timer = setTimeout(tick, 2000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [user, pending, connected]);

  // ── Per-client click handlers ────────────────────────────────────
  const handleCursor = useCallback(() => {
    setPending("cursor");
    // The deeplink handler runs in the OS, not the page. window.location
    // = "cursor://..." is the canonical pattern; <a href="cursor://..."
    // also works but we want to programmatically gate it on pending=cursor
    // being set first so the polling effect kicks in immediately.
    window.location.href = cursorDeeplink;
  }, [cursorDeeplink]);

  // Claude.ai supports `?modal=add-custom-connector&connectorName=…
  // &connectorUrl=…` which opens claude.ai with the Add Custom
  // Connector dialog already populated. No clipboard step required —
  // the URL is baked into the deep link itself. Same OAuth dance
  // (Claude → /mcp 401 → discovery → DCR → consent) happens after.
  const handleClaude = useCallback(() => {
    setPending("claude");
    window.open(claudeDeeplink, "_blank", "noopener,noreferrer");
  }, [claudeDeeplink]);

  // Replit Integrations supports a base64-payload prefill URL — same
  // shape as Claude's `?modal=add-custom-connector` deep link. Open it
  // in a new tab; Replit shows Add MCP Server with displayName="LYKN"
  // and baseUrl=<our /mcp> already filled in. User clicks Test & Save
  // → Replit auto-discovers OAuth DCR on /mcp → consent screen pops in
  // the same tab → user approves → bearer is minted → our poll
  // detects it and flips the card to Connected. True 1-click flow.
  const handleReplit = useCallback(() => {
    setPending("replit");
    window.open(replitDeeplink, "_blank", "noopener,noreferrer");
  }, [replitDeeplink]);

  const handleChatGPT = useCallback(async () => {
    setPending("chatgpt");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    if (!copyOk) {
      toast({
        title: "Couldn't copy automatically",
        description: "Use the copy-URL button in the card before pasting in ChatGPT.",
        variant: "destructive",
      });
    }
    window.open("https://chatgpt.com/", "_blank", "noopener,noreferrer");
  }, [mcpUrl]);

  // Claude Code is a CLI install, NOT a tab. We copy the
  // `claude mcp add --transport http --scope user lykn "<url>"`
  // command so the user can paste it directly in their terminal.
  // No window.open — there's no web destination. Toast nudges them
  // to paste; the OAuth dance fires the first time `claude` connects
  // to /mcp, same as Cursor.
  const handleClaudeCode = useCallback(async () => {
    setPending("claude-code");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(claudeCodeCommand);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    toast({
      title: copyOk ? "Install command copied" : "Couldn't copy automatically",
      description: copyOk
        ? "Paste it in your terminal. Claude Code will pop the OAuth approval next."
        : "Use the copy button in the card to copy the install command manually.",
      variant: copyOk ? undefined : "destructive",
    });
  }, [claudeCodeCommand]);

  // Gemini CLI is structurally identical to Claude Code (terminal-only,
  // built-in OAuth on first /mcp request). We deliberately label this
  // card "Gemini CLI" rather than "Gemini" because gemini.google.com,
  // the Gemini app, and Workspace consumer have NO Add Custom Connector
  // UI today — only the CLI surface supports remote MCP. If/when Google
  // ships a consumer-side prefill or installer flow, this card can
  // grow a second connectMode and the label can drop the "CLI" suffix.
  const handleGeminiCli = useCallback(async () => {
    setPending("gemini");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(geminiCliCommand);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    toast({
      title: copyOk ? "Install command copied" : "Couldn't copy automatically",
      description: copyOk
        ? "Paste it in your terminal. Gemini CLI will pop the OAuth approval next."
        : "Use the copy button in the card to copy the install command manually.",
      variant: copyOk ? undefined : "destructive",
    });
  }, [geminiCliCommand]);

  // Codex CLI — OpenAI's paid coding CLI (symmetric with Claude Code
  // and Gemini CLI). Native OAuth on streamable HTTP MCP servers per
  // github.com/openai/codex source — so `codex mcp add lykn --url ...`
  // triggers the standard 401 → DCR → consent dance on first /mcp
  // request. Identical UX to handleClaudeCode / handleGeminiCli:
  // copy command, toast with paste instruction, Codex opens the
  // OAuth tab when the user runs the command.
  const handleCodexCli = useCallback(async () => {
    setPending("codex-cli");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(codexCliCommand);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    toast({
      title: copyOk ? "Install command copied" : "Couldn't copy automatically",
      description: copyOk
        ? "Paste it in your terminal. Codex CLI will pop the OAuth approval next."
        : "Use the copy button in the card to copy the install command manually.",
      variant: copyOk ? undefined : "destructive",
    });
  }, [codexCliCommand]);

  // Windsurf is a config-file paste (NOT a terminal command), but
  // structurally identical to the CLI handlers: copy text + toast,
  // no tab opens. The text is a JSON snippet the user drops into
  // Windsurf's mcp_config.json via Cmd+Shift+P → "Windsurf: Configure
  // MCP Servers". On save Windsurf hot-reloads, spawns mcp-remote,
  // OAuth dance fires automatically.
  // GitHub Copilot is true 1-click via VS Code's MCP install link
  // (https://insiders.vscode.dev/redirect/mcp/install?…). Open in
  // new tab so the browser's "Open in VS Code?" prompt has room and
  // we don't lose the Onboarding context. No clipboard step needed —
  // the entire config payload is URL-encoded into the deeplink. Same
  // open-link shape as handleCursor / handleClaude / handleReplit.
  const handleCopilot = useCallback(() => {
    setPending("github-copilot");
    window.open(copilotDeeplink, "_blank", "noopener,noreferrer");
  }, [copilotDeeplink]);

  const handleWindsurf = useCallback(async () => {
    setPending("windsurf");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(windsurfSnippet);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    toast({
      title: copyOk ? "Config snippet copied" : "Couldn't copy automatically",
      description: copyOk
        ? "In Windsurf: Cmd+Shift+P → Configure MCP Servers → paste inside mcpServers → Save."
        : "Use the copy button in the card to copy the snippet manually.",
      variant: copyOk ? undefined : "destructive",
    });
  }, [windsurfSnippet]);

  // JetBrains AI Assistant + Junie. Structurally identical to Windsurf
  // (copy JSON snippet, no tab opens) but different paste destination:
  // Settings → Tools → AI Assistant → MCP → New, or
  // ~/.junie/mcp/mcp.json for Junie power users. The snippet wraps
  // our /mcp endpoint in `npx mcp-remote` because JetBrains' native
  // HTTP transport doesn't do OAuth DCR auto-discovery yet — once
  // they ship that, the wrapper goes away and this becomes simpler.
  const handleJetBrains = useCallback(async () => {
    setPending("jetbrains");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(jetbrainsSnippet);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    toast({
      title: copyOk ? "Config snippet copied" : "Couldn't copy automatically",
      description: copyOk
        ? "In your JetBrains IDE: Settings → Tools → AI Assistant → MCP → New → paste the JSON → Apply."
        : "Use the copy button in the card to copy the snippet manually.",
      variant: copyOk ? undefined : "destructive",
    });
  }, [jetbrainsSnippet]);

  // Perplexity / Grok / Zapier all share the same shape: open the
  // client's connector-settings page in a new tab and pre-copy the
  // LYKN /mcp URL to the clipboard so the user just hits paste +
  // approve. Same OAuth dance triggers on first request from their
  // side and polls below pick it up.
  // Notion Custom Agents have NO prefill deep link (the Add MCP server
  // form lives inside an Agent's settings panel which has no URL of
  // its own), so we use the same guided pattern as Perplexity / Grok /
  // Zapier: copy LYKN's MCP URL to the clipboard, then drop the user
  // into THEIR Notion workspace settings (notion.so/settings — Notion's
  // SPA routes that to the settings overlay in their current
  // workspace, NOT the help docs). User follows the 5-step checklist
  // on the card: navigate to Notion AI → AI connectors (admin
  // toggle if needed) → open the target Custom Agent → Tools & Access
  // → paste URL. Ends with an OAuth approval that mints the bearer
  // our poller is waiting for.
  const handleNotionAi = useCallback(async () => {
    setPending("notion-ai");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    if (!copyOk) {
      toast({
        title: "Couldn't copy automatically",
        description: "Use the copy-URL button in the card before pasting in Notion.",
        variant: "destructive",
      });
    }
    window.open(
      "https://www.notion.so/settings",
      "_blank",
      "noopener,noreferrer",
    );
  }, [mcpUrl]);

  const handlePerplexity = useCallback(async () => {
    setPending("perplexity");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    if (!copyOk) {
      toast({
        title: "Couldn't copy automatically",
        description: "Use the copy-URL button in the card before pasting in Perplexity.",
        variant: "destructive",
      });
    }
    window.open(
      "https://www.perplexity.ai/account/connectors",
      "_blank",
      "noopener,noreferrer",
    );
  }, [mcpUrl]);

  const handleGrok = useCallback(async () => {
    setPending("grok");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    if (!copyOk) {
      toast({
        title: "Couldn't copy automatically",
        description: "Use the copy-URL button in the card before pasting in Grok.",
        variant: "destructive",
      });
    }
    window.open(
      "https://grok.com/manage-connectors",
      "_blank",
      "noopener,noreferrer",
    );
  }, [mcpUrl]);

  const handleZapier = useCallback(async () => {
    setPending("zapier");
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    setTimeout(() => setCopyJustWorked(false), 4000);
    if (!copyOk) {
      toast({
        title: "Couldn't copy automatically",
        description: "Use the copy-URL button in the card before pasting in Zapier.",
        variant: "destructive",
      });
    }
    window.open(
      "https://zapier.com/app/connections",
      "_blank",
      "noopener,noreferrer",
    );
  }, [mcpUrl]);

  const handleCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopyJustWorked(true);
      setTimeout(() => setCopyJustWorked(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the URL manually.",
        variant: "destructive",
      });
    }
  }, [mcpUrl]);

  const handleCopyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(claudeCodeCommand);
      setCopyJustWorked(true);
      setTimeout(() => setCopyJustWorked(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the command manually.",
        variant: "destructive",
      });
    }
  }, [claudeCodeCommand]);

  const handleCopyGeminiCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(geminiCliCommand);
      setCopyJustWorked(true);
      setTimeout(() => setCopyJustWorked(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the command manually.",
        variant: "destructive",
      });
    }
  }, [geminiCliCommand]);

  const handleCopyCodexCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codexCliCommand);
      setCopyJustWorked(true);
      setTimeout(() => setCopyJustWorked(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the command manually.",
        variant: "destructive",
      });
    }
  }, [codexCliCommand]);

  const handleCopyWindsurfSnippet = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(windsurfSnippet);
      setCopyJustWorked(true);
      setTimeout(() => setCopyJustWorked(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the snippet manually.",
        variant: "destructive",
      });
    }
  }, [windsurfSnippet]);

  const handleCopyJetBrainsSnippet = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(jetbrainsSnippet);
      setCopyJustWorked(true);
      setTimeout(() => setCopyJustWorked(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the snippet manually.",
        variant: "destructive",
      });
    }
  }, [jetbrainsSnippet]);

  return (
    <div className="min-h-screen w-full px-6 md:px-10 py-12">
      <div className="mx-auto max-w-3xl">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 text-[12px] font-medium text-emerald-700 dark:text-emerald-400 mb-3">
          <Sparkles className="h-3.5 w-3.5" />
          One step left
        </div>
        <h1 className="text-[28px] md:text-[34px] font-semibold tracking-tight text-black/90 dark:text-white/95 leading-tight">
          Connect your AI tools to LYKN
        </h1>
        <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-black/65 dark:text-white/65">
          LYKN works inside the AI assistants you already use. Connect at
          least one to start — you can wire up more later from{" "}
          <strong className="font-semibold text-black/85 dark:text-white/85">
            Settings → Connections
          </strong>
          .
        </p>

        {!user && (
          <p className="mt-3 text-[12px] text-amber-700 dark:text-amber-400">
            Sign in to LYKN first — the OAuth flow needs your session in this browser.
          </p>
        )}

        {/* ── Connection cards ──────────────────────────────────── */}
        <div className="mt-8 space-y-3">
          <ConnectCard
            id="cursor"
            name="Cursor"
            domain="cursor.com"
            tagline="One-click deeplink. Cursor opens, asks you to approve, done."
            badge="1-click"
            connected={connected.has("cursor")}
            pending={pending === "cursor" && !connected.has("cursor")}
            disabled={!user}
            onConnect={handleCursor}
          />
          <ConnectCard
            id="claude"
            name="Claude"
            domain="claude.ai"
            tagline="One click opens Claude with the Add Connector dialog pre-filled. Hit Add, Approve — covers web, Desktop, mobile, and Cowork."
            badge="1-click"
            connected={connected.has("claude")}
            pending={pending === "claude" && !connected.has("claude")}
            disabled={!user}
            onConnect={handleClaude}
            urlToCopy={mcpUrl}
            urlCopied={copyJustWorked && pending === "claude"}
            onCopyUrl={handleCopyUrl}
            secondaryNote={
              <>
                Available on Free, Pro, and Max. One approval syncs LYKN to
                every Claude surface signed into your account — Desktop, mobile,
                Cowork, and Claude Code all pick it up automatically.
              </>
            }
          />
          <ConnectCard
            id="chatgpt"
            name="ChatGPT"
            domain="chatgpt.com"
            tagline="Plus / Pro / Team / Enterprise + Developer Mode. We open ChatGPT and copy the URL — follow the 5 steps."
            badge="Guided"
            connected={connected.has("chatgpt")}
            pending={pending === "chatgpt" && !connected.has("chatgpt")}
            disabled={!user}
            onConnect={handleChatGPT}
            urlToCopy={mcpUrl}
            urlCopied={copyJustWorked && pending === "chatgpt"}
            onCopyUrl={handleCopyUrl}
            secondaryNote={
              <>
                Free ChatGPT can't add custom connectors — you'll need Plus
                or above. Steps inside: Settings → Apps &amp; Connectors →
                Advanced → Developer Mode on → Create → paste URL, auth =
                OAuth → Create → Approve.
              </>
            }
          />
        </div>

        {/* ── More tools ────────────────────────────────────────── */}
        <div className="mt-10 flex items-center gap-3">
          <div className="flex-1 h-px bg-black/[0.06] dark:bg-white/10" />
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-black/45 dark:text-white/45">
            More tools
          </span>
          <div className="flex-1 h-px bg-black/[0.06] dark:bg-white/10" />
        </div>

        <div className="mt-4 space-y-3">
          <ConnectCard
            id="github-copilot"
            name="GitHub Copilot"
            domain="github.com"
            tagline="One-click VS Code install. Hands a pre-filled MCP install link to VS Code — pick where to install, approve, Copilot Chat sees LYKN immediately."
            badge="1-click"
            connected={connected.has("github-copilot")}
            pending={
              pending === "github-copilot" && !connected.has("github-copilot")
            }
            disabled={!user}
            onConnect={handleCopilot}
            secondaryNote={
              <>
                VS Code 1.99+ on any paid Copilot plan (Free / Pro / Pro+ /
                Business / Enterprise). Business / Enterprise admins also
                need to enable the &ldquo;MCP servers in Copilot&rdquo; policy.
                JetBrains / Visual Studio / Xcode Copilot MCP support is
                rolling out — this card targets VS Code today.
              </>
            }
          />
          <ConnectCard
            id="replit"
            name="Replit"
            domain="replit.com"
            tagline="One-click prefill. Opens Replit's Integrations page with LYKN's MCP server already filled in — hit Test & Save, approve, done."
            badge="1-click"
            connected={connected.has("replit")}
            pending={pending === "replit" && !connected.has("replit")}
            disabled={!user}
            onConnect={handleReplit}
            secondaryNote={
              <>
                Requires a paid Replit account (Core or above — same tier
                that unlocks Replit Agent). LYKN tools then show up in
                every Repl's Agent chat.
              </>
            }
          />
          <ConnectCard
            id="notion-ai"
            name="Notion AI"
            domain="notion.so"
            tagline="We copy the URL and open your Notion settings. Go to Notion AI → AI connectors, then paste into your Custom Agent's Tools & Access panel."
            badge="Guided"
            connected={connected.has("notion-ai")}
            pending={pending === "notion-ai" && !connected.has("notion-ai")}
            disabled={!user}
            onConnect={handleNotionAi}
            urlToCopy={mcpUrl}
            urlCopied={copyJustWorked && pending === "notion-ai"}
            onCopyUrl={handleCopyUrl}
            secondaryNote={
              <>
                Business or Enterprise workspaces only — Personal / Plus
                don't expose Custom Agents. A workspace admin also has to
                toggle Custom MCP on once under Settings → Notion AI →
                AI connectors before you can add LYKN per-agent.
              </>
            }
          />
          <ConnectCard
            id="claude-code"
            name="Claude Code"
            domain="claude.com"
            tagline="CLI install. We copy the `claude mcp add` command — paste it in your terminal and Claude Code pops the OAuth approval."
            badge="CLI"
            connected={connected.has("claude-code")}
            pending={pending === "claude-code" && !connected.has("claude-code")}
            disabled={!user}
            onConnect={handleClaudeCode}
            urlToCopy={claudeCodeCommand}
            urlCopied={copyJustWorked && pending === "claude-code"}
            onCopyUrl={handleCopyCommand}
            copyLabel="command"
            secondaryNote={
              <>
                Requires Claude Code installed locally. Runs with{" "}
                <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-black/[0.06] dark:bg-white/10">
                  --scope user
                </code>{" "}
                so the connection persists across every project on your
                machine — you only do this once.
              </>
            }
          />
          <ConnectCard
            id="gemini"
            name="Gemini CLI"
            domain="gemini.google.com"
            tagline="CLI install. We copy the `gemini mcp add` command — paste it in your terminal and Gemini CLI pops the OAuth approval."
            badge="CLI"
            connected={connected.has("gemini")}
            pending={pending === "gemini" && !connected.has("gemini")}
            disabled={!user}
            onConnect={handleGeminiCli}
            urlToCopy={geminiCliCommand}
            urlCopied={copyJustWorked && pending === "gemini"}
            onCopyUrl={handleCopyGeminiCommand}
            copyLabel="command"
            secondaryNote={
              <>
                Requires Gemini CLI installed locally (
                <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-black/[0.06] dark:bg-white/10">
                  npm i -g @google/gemini-cli
                </code>
                ). Only the CLI surface supports custom MCP today —
                gemini.google.com and Workspace don't expose Add Custom
                Connector yet.
              </>
            }
          />
          <ConnectCard
            id="codex-cli"
            name="Codex CLI"
            domain="openai.com"
            tagline="CLI install. We copy the `codex mcp add` command — paste it in your terminal and Codex pops the OAuth approval. Native streamable HTTP OAuth, no proxy."
            badge="CLI"
            connected={connected.has("codex-cli")}
            pending={pending === "codex-cli" && !connected.has("codex-cli")}
            disabled={!user}
            onConnect={handleCodexCli}
            urlToCopy={codexCliCommand}
            urlCopied={copyJustWorked && pending === "codex-cli"}
            onCopyUrl={handleCopyCodexCommand}
            copyLabel="command"
            secondaryNote={
              <>
                Requires Codex CLI installed locally (
                <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-black/[0.06] dark:bg-white/10">
                  npm i -g @openai/codex
                </code>
                ). Codex CLI ships with paid ChatGPT plans (Plus / Pro /
                Business / Enterprise) — uses your ChatGPT account, no
                separate billing.
              </>
            }
          />
          <ConnectCard
            id="windsurf"
            name="Windsurf"
            domain="windsurf.com"
            tagline="Config-file install. We copy a JSON snippet — paste it into Windsurf's MCP config (Cmd+Shift+P → Configure MCP Servers), save, approve."
            badge="Snippet"
            connected={connected.has("windsurf")}
            pending={pending === "windsurf" && !connected.has("windsurf")}
            disabled={!user}
            onConnect={handleWindsurf}
            urlToCopy={windsurfSnippet}
            urlCopied={copyJustWorked && pending === "windsurf"}
            onCopyUrl={handleCopyWindsurfSnippet}
            copyLabel="snippet"
            secondaryNote={
              <>
                Requires Windsurf and Node.js installed locally. Windsurf
                doesn't natively do OAuth on HTTP MCP servers yet, so the
                snippet uses{" "}
                <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-black/[0.06] dark:bg-white/10">
                  npx mcp-remote
                </code>{" "}
                to bridge the auth. Once LYKN ships in the Windsurf MCP
                marketplace this becomes a true 1-click install.
              </>
            }
          />
          <ConnectCard
            id="jetbrains"
            name="JetBrains AI"
            domain="jetbrains.com"
            tagline="Config-snippet install for AI Assistant + Junie across IntelliJ, WebStorm, PyCharm, GoLand, RustRover (all of them). Paste into Settings → Tools → AI Assistant → MCP."
            badge="Snippet"
            connected={connected.has("jetbrains")}
            pending={pending === "jetbrains" && !connected.has("jetbrains")}
            disabled={!user}
            onConnect={handleJetBrains}
            urlToCopy={jetbrainsSnippet}
            urlCopied={copyJustWorked && pending === "jetbrains"}
            onCopyUrl={handleCopyJetBrainsSnippet}
            copyLabel="snippet"
            secondaryNote={
              <>
                JetBrains 2025.2+ with AI Assistant or Junie enabled (any
                paid AI Pro / AI Ultimate plan). Also needs Node.js
                installed — JetBrains' native HTTP MCP transport doesn't
                do OAuth DCR auto-discovery yet, so the snippet bridges
                via{" "}
                <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-black/[0.06] dark:bg-white/10">
                  npx mcp-remote
                </code>
                .
              </>
            }
          />
          <ConnectCard
            id="perplexity"
            name="Perplexity"
            domain="perplexity.ai"
            tagline="We open Perplexity's connector settings and copy the URL. Paste, approve, done."
            badge="Guided"
            connected={connected.has("perplexity")}
            pending={pending === "perplexity" && !connected.has("perplexity")}
            disabled={!user}
            onConnect={handlePerplexity}
            urlToCopy={mcpUrl}
            urlCopied={copyJustWorked && pending === "perplexity"}
            onCopyUrl={handleCopyUrl}
            secondaryNote={
              <>
                Custom connectors require Perplexity Pro or Enterprise
                Pro. On the page we open: + Add connector → paste URL →
                authenticate with LYKN.
              </>
            }
          />
          <ConnectCard
            id="grok"
            name="Grok"
            domain="grok.com"
            tagline="We open Grok's connector manager and copy the URL. Paste, approve, done."
            badge="Guided"
            connected={connected.has("grok")}
            pending={pending === "grok" && !connected.has("grok")}
            disabled={!user}
            onConnect={handleGrok}
            urlToCopy={mcpUrl}
            urlCopied={copyJustWorked && pending === "grok"}
            onCopyUrl={handleCopyUrl}
            secondaryNote={
              <>
                Remote MCP connectors require a paid Grok plan (SuperGrok
                or Premium). On the page we open: Add connector → paste
                URL → approve.
              </>
            }
          />
          <ConnectCard
            id="zapier"
            name="Zapier"
            domain="zapier.com"
            tagline="We open Zapier's MCP Client (beta) and copy the URL. Paste, approve — LYKN becomes a tool every Zap can read."
            badge="Beta"
            connected={connected.has("zapier")}
            pending={pending === "zapier" && !connected.has("zapier")}
            disabled={!user}
            onConnect={handleZapier}
            urlToCopy={mcpUrl}
            urlCopied={copyJustWorked && pending === "zapier"}
            onCopyUrl={handleCopyUrl}
            secondaryNote={
              <>
                Zapier's MCP Client is in beta and currently available on
                paid plans. On the page we open: + Add connection → MCP
                Client → paste URL → approve.
              </>
            }
          />
        </div>

        {/* ── Footer ────────────────────────────────────────────── */}
        <div className="mt-8 flex items-center justify-between gap-4 pt-4 border-t border-black/[0.06] dark:border-white/10">
          <button
            type="button"
            onClick={() => navigate("/connections")}
            className="text-[12px] font-medium text-black/60 dark:text-white/65 hover:text-black/90 dark:hover:text-white underline-offset-2 hover:underline"
          >
            Skip — wire it up later
          </button>
          <button
            type="button"
            onClick={() => navigate("/")}
            disabled={connected.size === 0}
            className="inline-flex items-center gap-2 rounded-full bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {connected.size === 0 ? "Connect one to continue" : "Done"}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="mt-4 text-[10.5px] text-black/40 dark:text-white/40 leading-relaxed">
          Each connection issues a short-lived OAuth bearer scoped to your
          LYKN account. Revoke any of them any time from{" "}
          <strong className="font-medium">Settings → Connections</strong>.
          LYKN only stores the SHA-256 hash of the token — the plaintext
          never touches our DB.
        </p>
      </div>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────

function ConnectCard({
  name,
  domain,
  tagline,
  badge,
  connected,
  pending,
  disabled,
  onConnect,
  urlToCopy,
  urlCopied,
  onCopyUrl,
  // Defaults to "URL" for the canonical case (paste-into-modal).
  // Override to "command" for CLI installs (Claude Code, Gemini CLI —
  // the clipboard holds a shell command) or "snippet" for editor-paste
  // installs (Windsurf — the clipboard holds a JSON config blob).
  copyLabel = "URL",
  secondaryNote,
}) {
  const StatusIcon = connected ? CheckCircle2 : pending ? Loader2 : Circle;
  const statusClass = connected
    ? "text-emerald-500"
    : pending
      ? "text-emerald-500 animate-spin"
      : "text-black/25 dark:text-white/30";

  return (
    <div
      className={`rounded-2xl border bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-4 transition-colors ${
        connected
          ? "border-emerald-500/40 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06]"
          : "border-black/[0.08] dark:border-white/10"
      }`}
    >
      <div className="flex items-start gap-4">
        <div className="h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
          <img
            src={`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`}
            alt={`${name} logo`}
            width={28}
            height={28}
            loading="lazy"
            decoding="async"
            className="object-contain"
            style={{ width: 28, height: 28 }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold tracking-tight text-black/90 dark:text-white/95">
              {name}
            </h3>
            <span className="inline-flex items-center gap-1 rounded-full border border-black/[0.08] dark:border-white/[0.12] bg-black/[0.04] dark:bg-white/[0.06] px-2 py-[2px] text-[10.5px] font-medium text-black/60 dark:text-white/65">
              {badge}
            </span>
            {connected && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-2 py-[2px] text-[10.5px] font-medium">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-black/60 dark:text-white/65">
            {tagline}
          </p>
        </div>

        <StatusIcon className={`mt-1.5 h-4 w-4 flex-shrink-0 ${statusClass}`} />
      </div>

      {!connected && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onConnect}
            disabled={disabled || pending}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-[12.5px] font-medium transition-colors ${
              disabled || pending
                ? "bg-black/[0.06] dark:bg-white/[0.08] text-black/45 dark:text-white/45 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-600/90 dark:bg-emerald-500 dark:hover:bg-emerald-500/90 text-white"
            }`}
          >
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Waiting for {name}…
              </>
            ) : (
              <>
                Connect {name}
                <ExternalLink className="h-3 w-3" />
              </>
            )}
          </button>
          {urlToCopy && (
            <button
              type="button"
              onClick={onCopyUrl}
              className="inline-flex items-center gap-1.5 rounded-full border border-black/10 dark:border-white/15 bg-white/70 dark:bg-zinc-900/70 px-3 py-1.5 text-[11px] font-medium text-black/70 dark:text-white/75 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
            >
              {urlCopied ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  {copyLabel === "command"
                    ? "Command copied"
                    : copyLabel === "snippet"
                      ? "Snippet copied"
                      : "URL copied"}
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  {copyLabel === "command"
                    ? "Copy command"
                    : copyLabel === "snippet"
                      ? "Copy snippet"
                      : "Copy URL"}
                </>
              )}
            </button>
          )}
        </div>
      )}

      {secondaryNote && (
        <p className="mt-2.5 text-[10.5px] leading-relaxed text-black/50 dark:text-white/50">
          {secondaryNote}
        </p>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function mapClientKindToSlot(kind) {
  switch (kind) {
    case "cursor":
      return "cursor";
    // Claude (web/desktop/mobile/cowork) is ONE merged slot — Anthropic
    // syncs custom connectors per-account so a single OAuth approval
    // covers every surface they're signed into. Legacy claude-web /
    // claude-desktop tokens from before the merge still resolve here.
    case "claude":
    case "claude-web":
    case "claude-desktop":
      return "claude";
    // Claude Code is a SEPARATE card on this screen because it's a
    // distinct install path (CLI command vs. web modal) — surface
    // tokens issued to the CLI under their own slot so the user sees
    // it light up green when they paste & run.
    case "claude-code":
      return "claude-code";
    case "chatgpt":
      return "chatgpt";
    // Gemini's only supported surface today is the CLI; classifier
    // maps every Gemini DCR registration to the same kind. If/when
    // Google ships a consumer-side connector flow we'll likely add a
    // separate "gemini-app" client_kind on the server.
    case "gemini":
      return "gemini";
    case "replit":
      return "replit";
    case "notion-ai":
      return "notion-ai";
    case "codex-cli":
      return "codex-cli";
    case "windsurf":
      return "windsurf";
    case "jetbrains":
      return "jetbrains";
    case "github-copilot":
      return "github-copilot";
    case "perplexity":
      return "perplexity";
    case "grok":
      return "grok";
    case "zapier":
      return "zapier";
    default:
      return null;
  }
}

function buildAbsoluteUrl(path) {
  const base = String(API_BASE_URL || "").trim();
  if (!base) {
    if (typeof window !== "undefined" && window.location?.origin) {
      return `${window.location.origin}${path}`;
    }
    return path;
  }
  if (/^https?:\/\//i.test(base)) {
    return `${base}${path}`;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${base}${path}`;
  }
  return `${base}${path}`;
}

async function authedFetch(path, init = {}) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token || "";
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}
