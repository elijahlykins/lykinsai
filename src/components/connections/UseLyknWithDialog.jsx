import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import {
  AlertTriangle,
  Copy,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldAlert,
  Sparkles,
  ArrowRight,
  Circle,
} from "lucide-react";
import {
  buildCursorOauthDeeplink,
  buildClaudeWebOauthDeeplink,
  buildClaudeCodeOauthInstallCommand,
  buildGeminiCliInstallCommand,
  buildReplitOauthInstallLink,
  buildWindsurfConfigSnippet,
  buildCopilotInstallLink,
  buildRawInstallInfo,
  buildLyknProjectInstructions,
  LYKN_PROJECT_INSTRUCTIONS_TARGETS,
} from "@/lib/connectors/outboundTargets";

/**
 * UseLyknWithDialog — issues a per-client MCP token and shows install
 * instructions tailored to the chosen client kind.
 *
 * Mints the token on `open` so the dialog always shows a fresh secret —
 * this also means closing without copying it leaves an orphan token in
 * the user's account, which the Connected Clients list surfaces so they
 * can revoke it. Single-use minting + revocability is the whole UX
 * contract: tokens are cheap, plaintext is shown ONCE.
 *
 * Per-client install paths (all driven by OauthMcpSection — NO PAT
 * minting on the modern paths, just OAuth handshakes):
 *   • cursor          → cursor:// deeplink, in-app install dialog, OAuth
 *   • claude          → claude.ai `?modal=add-custom-connector` deep link.
 *                       ONE click covers Claude web, Desktop, mobile, and
 *                       Cowork — Anthropic shares the connector list
 *                       across every Claude surface signed into the same
 *                       account, so we collapsed the old separate
 *                       claude-web / claude-desktop cards into this.
 *   • claude-code     → copy `claude mcp add … --transport http` command
 *                       to clipboard; OAuth handshake fires on first run.
 *                       Separate from `claude` because the CLI has its
 *                       own MCP registry independent of the user's
 *                       claude.ai connector list.
 *   • chatgpt         → guided open-tab + paste-URL flow (no deep link)
 *   • other           → raw URL + minted PAT — the legacy escape hatch
 */
export default function UseLyknWithDialog({ open, onOpenChange, target, onMinted }) {
  const [token, setToken] = useState(null);
  const [planId, setPlanId] = useState(null);
  const [downgraded, setDowngraded] = useState(false);
  const [error, setError] = useState(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState({}); // keyed by section

  const installType = target?.installType || "raw";
  const clientKind = target?.clientKind || "other";
  const targetId = target?.id || null;
  const targetName = target?.name || "AI client";

  const mcpUrl = useMemo(() => buildAbsoluteUrl("/mcp"), []);
  const restBase = useMemo(() => buildAbsoluteUrl("/api/v1/synthesis"), []);

  // Stash onMinted in a ref so re-renders of the parent (which often
  // pass a fresh inline () => refresh()) do NOT cause our mint effect
  // to re-fire and issue a second token. The effect should depend on
  // the dialog's open/target inputs only.
  const onMintedRef = useRef(onMinted);
  useEffect(() => {
    onMintedRef.current = onMinted;
  }, [onMinted]);

  // Track which (target, openSession) we've already minted for so even
  // if the effect runs more than once for the same open we still only
  // mint a single token. A new mint requires closing+reopening (which
  // resets `mintedForKey` via the !open branch).
  const mintedForKeyRef = useRef(null);

  const reset = useCallback(() => {
    setToken(null);
    setPlanId(null);
    setDowngraded(false);
    setError(null);
    setCopied({});
  }, []);

  // Mint a fresh token whenever the dialog opens with a target.
  // Exception: the OAuth-MCP install path (ChatGPT Connectors,
  // Claude.ai Custom Connectors) doesn't need a PAT — the OAuth flow
  // is the proof of access — so we skip minting entirely and let the
  // OauthMcpSection render directly off target.installType. This
  // avoids issuing an orphan token the user never sees on their
  // Connected Clients list.
  useEffect(() => {
    if (!open || !targetId) {
      reset();
      mintedForKeyRef.current = null;
      return;
    }
    if (installType === "oauth-mcp") {
      return;
    }
    const key = `${targetId}::${clientKind}`;
    if (mintedForKeyRef.current === key) {
      return; // already minted for this open session
    }
    mintedForKeyRef.current = key;

    let cancelled = false;
    (async () => {
      setMinting(true);
      setError(null);
      try {
        const res = await authedFetch("/api/v1/synthesis/tokens", {
          method: "POST",
          body: JSON.stringify({
            label: targetName,
            clientKind,
            scopes: ["read", "write"],
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        setToken(data.token);
        setPlanId(data.planId || null);
        setDowngraded(Boolean(data.writeDowngradedToFree));
        const cb = onMintedRef.current;
        if (typeof cb === "function") {
          try { cb(data.token); } catch { /* swallow */ }
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err?.message || "Couldn't issue token";
        setError(msg);
        // If mint failed, allow the user to retry by reopening — clear
        // the de-dupe key so the next effect run can try again.
        mintedForKeyRef.current = null;
        toast({
          title: "Couldn't issue token",
          description: msg,
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setMinting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, targetId, targetName, clientKind, installType, reset]);

  const copyTo = useCallback(async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied((c) => ({ ...c, [key]: true }));
      setTimeout(() => setCopied((c) => ({ ...c, [key]: false })), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select the text manually.", variant: "destructive" });
    }
  }, []);

  const plaintext = token?.plaintext || "";

  const rawInfo = useMemo(
    () => buildRawInstallInfo({ token: plaintext, mcpUrl, restBase }),
    [plaintext, mcpUrl, restBase],
  );

  const projectInstructions = useMemo(() => buildLyknProjectInstructions(), []);
  const projectInstructionsTarget = useMemo(
    () =>
      LYKN_PROJECT_INSTRUCTIONS_TARGETS[clientKind] ||
      LYKN_PROJECT_INSTRUCTIONS_TARGETS.other,
    [clientKind],
  );
  const showProjectInstructions = clientKind !== "chatgpt"; // ChatGPT is OpenAPI-only for now

  if (!target) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl bg-white dark:bg-zinc-950 border border-black/10 dark:border-white/10">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Use LYKN with {target.name}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-black/60 dark:text-white/60">
            {target.summary}
          </DialogDescription>
        </DialogHeader>

        {/* ── OAuth-MCP path: no token mint, just URL + steps ────────── */}
        {installType === "oauth-mcp" && (
          <OauthMcpSection
            target={target}
            mcpUrl={mcpUrl}
            onConnected={(tok) => {
              // Reuse the same refresh hook PAT mint uses. The Connected
              // Clients table below the dialog will repaint immediately
              // and show ChatGPT's new bearer.
              const cb = onMintedRef.current;
              if (typeof cb === "function") {
                try { cb(tok); } catch { /* swallow */ }
              }
            }}
          />
        )}

        {/* ── Token issue state ──────────────────────────── */}
        {installType !== "oauth-mcp" && minting && (
          <div className="flex items-center gap-2 rounded-xl border border-black/[0.08] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-3 text-[12px] text-black/60 dark:text-white/65">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Issuing a fresh token for {target.name}…
          </div>
        )}

        {installType !== "oauth-mcp" && error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {installType !== "oauth-mcp" && token && (
          <>
            {/* ── Token (shown once) ─────────────────────────── */}
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                <ShieldAlert className="h-3 w-3" />
                Copy this token — it's only shown once
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded-md bg-white dark:bg-zinc-900 px-2 py-1.5 text-[11.5px] font-mono text-black/85 dark:text-white/85 border border-black/[0.06] dark:border-white/[0.08]">
                  {plaintext}
                </code>
                <CopyButton
                  copied={copied.token}
                  onClick={() => copyTo("token", plaintext)}
                  label="Copy token"
                />
              </div>
              <div className="text-[10.5px] text-black/55 dark:text-white/55 leading-relaxed">
                {downgraded
                  ? "You're on the free plan, so this token is read-only. Upgrade to mint a write-capable token (proposeBelief / proposeFact)."
                  : "This is a write-capable token. Revoke it any time from the Connected Clients list below."}
              </div>
            </div>

            {/* ── Per-client install path ────────────────────── */}
            {installType === "openapi" && (
              <OpenApiSection target={target} restBase={restBase} />
            )}

            {installType === "raw" && (
              <RawSection raw={rawInfo} copied={copied} onCopy={copyTo} />
            )}

            {/* ── Project Instructions (the "always-on" trigger) ─── */}
            {showProjectInstructions && (
              <ProjectInstructionsSection
                target={projectInstructionsTarget}
                snippet={projectInstructions}
                copied={copied["lykn-project-instructions"]}
                onCopy={() => copyTo("lykn-project-instructions", projectInstructions)}
              />
            )}

            {/* ── Plan note ─────────────────────────────────── */}
            <div className="text-[10.5px] text-black/45 dark:text-white/45 leading-relaxed">
              Plan: <span className="font-medium text-black/65 dark:text-white/70">{planId || "free"}</span>.
              Tokens are scoped to your account and respect your plan's read/write quotas.
              The token never leaves this device — LYKN only stores its SHA-256 hash.
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Per-install-type sections ────────────────────────────────────────────
//
// ConfigJsonSection and CliSection used to live here for the PAT-baking
// claude-desktop / claude-code paths. Both clients now use OauthMcpSection
// instead (Claude Desktop via the claude.ai prefill deep link, Claude Code
// via `claude mcp add … --transport http` + built-in OAuth), so this file
// jumps straight to OpenApiSection / RawSection / OauthMcpSection below.

/**
 * ProjectInstructionsSection — the "always-on" half of the LYKN install.
 *
 * The MCP config snippet (above this section) tells the AI client where
 * LYKN lives. This section tells the AI client HOW TO USE LYKN — the
 * paste-once contract that makes Claude/Cursor reflexively call
 * lykn_getContextBlock at conversation start, push project state when
 * decisions happen, and ask before promoting beliefs.
 *
 * Without this snippet, the user has to remember to prompt their AI
 * to use the tools every conversation. With it, the synthesis layer
 * is "always on" — the AI silently keeps it in sync without being asked.
 *
 * Why this is a SEPARATE section, not merged into the install snippet
 * above: install lives in a *config file* the user edits once; this
 * lives in the AI client's *prompt surface* (Project knowledge, CLAUDE.md,
 * .cursorrules) which is a different file and a different mental model.
 * Keeping them visually distinct prevents users from pasting one into
 * the wrong place.
 */
function ProjectInstructionsSection({ target, snippet, copied, onCopy }) {
  const downloadSnippet = useCallback(() => {
    try {
      const blob = new Blob([snippet], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "lykn-project-instructions.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({
        title: "Download failed",
        description: "Use Copy instructions instead.",
        variant: "destructive",
      });
    }
  }, [snippet]);

  return (
    <div className="space-y-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06] p-3">
      <div className="space-y-1">
        <SectionTitle>
          <span className="text-emerald-700 dark:text-emerald-400">
            Then: paste these instructions into {target.surfaceLabel}
          </span>
        </SectionTitle>
        <p className="text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed">
          The config above wires LYKN's tools in. <strong>This snippet teaches the
          AI when to use them</strong> — silently load context at conversation start,
          push project state on decisions, ask before promoting core beliefs.
          Without it, you'd have to prompt the AI every chat. With it, the
          synthesis layer stays in sync on its own.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-600/90 dark:bg-emerald-500 dark:hover:bg-emerald-500/90 text-white px-4 py-2 text-[12.5px] font-medium transition-colors"
        >
          {copied ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy instructions
            </>
          )}
        </button>
        <button
          type="button"
          onClick={downloadSnippet}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-white/70 dark:bg-zinc-900/70 px-4 py-2 text-[12.5px] font-medium text-black/85 dark:text-white/90 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          Download .md
        </button>
      </div>

      <ol className="list-decimal pl-5 space-y-1 text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed marker:text-black/40 dark:marker:text-white/40">
        {target.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>

      <details className="rounded-lg border border-black/[0.06] dark:border-white/10 bg-white/60 dark:bg-zinc-900/60 px-3 py-2">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white select-none">
          Preview the instructions
        </summary>
        <div className="mt-2">
          <pre className="whitespace-pre-wrap break-words rounded-md border border-black/[0.08] dark:border-white/10 bg-white/70 dark:bg-zinc-900/70 px-3 py-2 text-[11px] font-mono leading-relaxed text-black/85 dark:text-white/85 max-h-72 overflow-y-auto">
{snippet}
          </pre>
        </div>
      </details>

      {target.helpUrl && (
        <a
          href={target.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10.5px] text-black/55 dark:text-white/55 underline underline-offset-2 hover:text-black/85 dark:hover:text-white/85"
        >
          {target.helpLabel} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

/**
 * OauthMcpSection — guided "press Connect, follow the steps" UX for
 * any client that speaks both MCP and OAuth (ChatGPT Connectors and
 * Claude.ai Custom Connectors today; Cursor MCP-OAuth eventually).
 *
 * Everything client-specific (the URL we open in a new tab, the
 * step-by-step instructions, the plan-availability footnote) is read
 * from `target` — see openUrl / installSteps / planNote on the entries
 * in src/lib/connectors/outboundTargets.js. Adding a new OAuth-MCP
 * target is just three fields in that catalog; this component is
 * already generic.
 *
 * What the user actually does:
 *   1. Click "Connect {target.name}". We copy LYKN's MCP URL into
 *      their clipboard AND open the target's settings page (or
 *      homepage) in a new tab in one gesture.
 *   2. They follow target.installSteps inside the host app.
 *   3. The host auto-discovers our OAuth provider, registers itself
 *      via DCR, and pops a consent screen at lykn.io/oauth/consent.
 *   4. They approve. Done.
 *
 * What we do for them:
 *   - Auto-copy + auto-open on a single button press (no two-step).
 *   - Live polling against /api/v1/synthesis/tokens watching for any
 *     new OAuth-issued bearer to appear in their account; the moment
 *     the diff is non-empty, we flip to "Connected!" without them
 *     having to refresh. The match is deliberately generic (any new
 *     `oauth_client_id` token, regardless of `client_kind`) — different
 *     hosts name themselves differently in DCR and our classifier
 *     can't keep up with all of them; "anything new since this dialog
 *     opened" is the bulletproof signal.
 *   - The PAT mint is intentionally skipped (installType==="oauth-mcp")
 *     so a user who closes the dialog mid-flow doesn't leave behind
 *     orphan personal-access tokens.
 */
function OauthMcpSection({ target, mcpUrl, onConnected }) {
  // Step machine: 0 = "click Connect", 1 = "in {target}, paste & approve",
  // 2 = "we detected it" (terminal). The polling loop advances 1 → 2 the
  // moment it sees ANY new oauth-issued bearer in the user's list (we
  // don't filter by client_kind because DCR-registered hosts name
  // themselves inconsistently — see comment on isOauthMcpToken).
  const [step, setStep] = useState(0);
  const [copyJustWorked, setCopyJustWorked] = useState(false);

  const targetName = target?.name || "this AI tool";
  const openUrl = target?.openUrl || `https://${target?.domain || "example.com"}/`;
  const installSteps =
    Array.isArray(target?.installSteps) && target.installSteps.length > 0
      ? target.installSteps
      : [
          `Open ${targetName}.`,
          "Find the connectors / MCP settings page.",
          "Paste the URL above and approve the LYKN consent screen.",
        ];
  const planNote = target?.planNote || null;
  const cardWarning = target?.cardWarning || null;
  const successHint = target?.successHint || null;
  const helpLabel = target?.helpLabel || `${targetName} connectors help`;

  // Snapshot of OAuth-issued tokens that already existed BEFORE the user
  // pressed Connect, so we can detect the diff (= new token from this
  // connect attempt). Without the baseline we'd flash "Connected!"
  // immediately for users who already had an OAuth client linked.
  const baselineRef = useRef(null);
  const [pollingError, setPollingError] = useState(null);

  // ── Establish the baseline as soon as the user is on this section ──
  // This runs once per dialog-open. We don't poll yet; we poll once they
  // click the primary button (state moves to step >= 1).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/v1/synthesis/tokens");
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && Array.isArray(data?.tokens)) {
          baselineRef.current = new Set(
            data.tokens
              .filter((t) => isOauthMcpToken(t))
              .map((t) => t.id),
          );
        } else {
          baselineRef.current = new Set();
        }
      } catch {
        if (!cancelled) baselineRef.current = new Set();
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Poll for a new OAuth-issued token ─────────────────────────────
  // Only runs while the user is mid-flow (step 1). 3s cadence is a tight
  // enough loop that the "Connected!" flip feels instant after they hit
  // Approve, and loose enough that a stuck dialog doesn't hammer the
  // backend (≤20 req/min).
  useEffect(() => {
    if (step !== 1) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const res = await authedFetch("/api/v1/synthesis/tokens");
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && Array.isArray(data?.tokens)) {
          const baseline = baselineRef.current || new Set();
          const fresh = data.tokens.find(
            (t) => isOauthMcpToken(t) && !baseline.has(t.id),
          );
          if (fresh) {
            setStep(2);
            if (typeof onConnected === "function") {
              try { onConnected(fresh); } catch { /* swallow */ }
            }
            return; // stop scheduling
          }
        }
        timer = setTimeout(tick, 3000);
      } catch (err) {
        if (cancelled) return;
        setPollingError(err?.message || "Couldn't check for connection.");
        timer = setTimeout(tick, 6000); // back off on error
      }
    };
    timer = setTimeout(tick, 2000); // first check after 2s
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [step, onConnected]);

  const connectMode = target?.connectMode || "open-url";

  const handleConnect = useCallback(async () => {
    // ── Cursor (and any future native MCP client using a private-use
    //    URI scheme): fire the deeplink. The OS hands the URL to the
    //    registered handler, which pops the MCP install dialog. Skipping
    //    the clipboard step here — the URL is baked INTO the deeplink
    //    config, the user never needs to paste it.
    if (connectMode === "cursor-deeplink") {
      const deeplink = buildCursorOauthDeeplink({ mcpUrl });
      window.location.href = deeplink;
      setStep((s) => (s < 1 ? 1 : s));
      return;
    }

    // ── Claude.ai prefilled-modal deep link. Anthropic ships a
    //    `?modal=add-custom-connector&connectorName=…&connectorUrl=…`
    //    query string that opens claude.ai with the Add Custom
    //    Connector dialog already populated. New tab (not same-tab)
    //    so users don't lose LYKN, and no clipboard step needed —
    //    the URL is in the deep link itself. ONE click via this path
    //    covers every Claude surface (web / Desktop / mobile / Cowork)
    //    because Anthropic shares the connector list across them.
    if (connectMode === "claude-prefill") {
      const deeplink = buildClaudeWebOauthDeeplink({ mcpUrl });
      window.open(deeplink, "_blank", "noopener,noreferrer");
      setStep((s) => (s < 1 ? 1 : s));
      return;
    }

    // ── Replit Integrations prefill. Per docs.replit.com/replitai/mcp/
    //    install-links Replit accepts a base64-encoded JSON payload via
    //    ?mcp=… that pre-fills the Add MCP Server form (displayName,
    //    baseUrl, headers). We pass an empty headers array so Replit
    //    auto-discovers OAuth DCR on /mcp — same handshake Cursor and
    //    Claude use. New tab (Replit replaces the page on Test & Save,
    //    so we don't want to lose LYKN), no clipboard step.
    if (connectMode === "replit-prefill") {
      const deeplink = buildReplitOauthInstallLink({ mcpUrl });
      window.open(deeplink, "_blank", "noopener,noreferrer");
      setStep((s) => (s < 1 ? 1 : s));
      return;
    }

    // ── VS Code Copilot install link. Per github.com/microsoft/vscode-
    //    docs the spec is
    //      https://insiders.vscode.dev/redirect/mcp/install
    //        ?name=…&config=<url-encoded JSON>
    //    The web URL hands off to VS Code's native `vscode:mcp/install`
    //    URI handler if installed. New tab so the browser's
    //    "open in VS Code?" prompt has room. No clipboard step — the
    //    config payload is baked into the URL.
    if (connectMode === "copilot-install") {
      const deeplink = buildCopilotInstallLink({ mcpUrl });
      window.open(deeplink, "_blank", "noopener,noreferrer");
      setStep((s) => (s < 1 ? 1 : s));
      return;
    }

    // ── Paste-style installs (Claude Code + Gemini CLI = terminal
    //    command; Windsurf = JSON snippet pasted into mcp_config.json).
    //    No browser deep link can pop a terminal or an editor, so the
    //    primary action becomes "copy text to the clipboard, tell the
    //    user where to paste it." For CLI commands the user pastes in
    //    their shell; for Windsurf they paste into the Windsurf config
    //    file via the Command Palette. Either way the underlying MCP
    //    client (or mcp-remote, for Windsurf) does the /mcp → 401 →
    //    discovery → DCR → consent dance once the paste lands and
    //    Windsurf hot-reloads / the user hits Enter. We don't open any
    //    tab from here; the client itself opens the consent tab.
    //    Token poll detects the resulting bearer and flips the dialog
    //    to Connected.
    const cliCommand = buildCliInstallCommand(connectMode, { mcpUrl });
    if (cliCommand) {
      const artifactLabel = getCopyArtifactLabel(connectMode);
      const pasteHint =
        connectMode === "windsurf-config"
          ? "Open Windsurf → Command Palette → Configure MCP Servers → paste inside the mcpServers object → Save."
          : "Paste it in your terminal and press Enter.";
      let copyOk = false;
      try {
        await navigator.clipboard.writeText(cliCommand);
        copyOk = true;
      } catch {
        copyOk = false;
      }
      setCopyJustWorked(copyOk);
      if (!copyOk) {
        toast({
          title: "Couldn't copy automatically",
          description: `Use the Show ${artifactLabel} panel below to copy it manually.`,
          variant: "destructive",
        });
      } else {
        toast({
          title:
            artifactLabel === "config snippet"
              ? "Config snippet copied"
              : "Install command copied",
          description: pasteHint,
        });
      }
      setStep((s) => (s < 1 ? 1 : s));
      setTimeout(() => setCopyJustWorked(false), 4000);
      return;
    }

    // ── Default: copy URL + open target's settings page in a new tab.
    //    Used by ChatGPT (no deeplink available) and any other client
    //    that still needs the manual paste flow.
    //    Copy first (synchronous user-gesture path is most reliable for
    //    clipboard permissions), then open the new tab. If the copy fails
    //    we still open the host — the user can right-click the URL field.
    let copyOk = false;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      copyOk = true;
    } catch {
      copyOk = false;
    }
    setCopyJustWorked(copyOk);
    if (!copyOk) {
      toast({
        title: "Couldn't copy automatically",
        description: `Use the Copy URL button below before pasting in ${targetName}.`,
        variant: "destructive",
      });
    }
    window.open(openUrl, "_blank", "noopener,noreferrer");
    setStep((s) => (s < 1 ? 1 : s));
    setTimeout(() => setCopyJustWorked(false), 4000);
  }, [connectMode, mcpUrl, openUrl, targetName]);

  // Pull a short tagline out of installSteps[1] for the stepper's
  // step-2 row, so users don't have to look down at the detailed list
  // to know what they're doing right now. Falls back to a generic
  // string if the catalog entry only has one step.
  const stepTwoHeadline = installSteps[1] || `Configure inside ${targetName}`;

  return (
    <div className="space-y-3">
      {/* ── Card-level warning (e.g. third party is staging this feature
              and some accounts can't connect even when configured
              correctly). Shown above the hero so users see it before
              investing time in the flow. ─────────────────────────── */}
      {cardWarning && step < 2 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] dark:bg-amber-500/[0.12] p-3 flex items-start gap-2">
          <AlertTriangle
            className="h-4 w-4 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-[1px]"
            strokeWidth={2.25}
          />
          <p className="text-[11.5px] leading-relaxed text-amber-900 dark:text-amber-200">
            {cardWarning}
          </p>
        </div>
      )}

      {/* ── Hero: single primary action ─────────────────────────── */}
      {step < 2 && (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06] p-3 space-y-2.5">
          <div className="text-[12px] leading-relaxed text-black/70 dark:text-white/75">
            {connectMode === "cursor-deeplink" ? (
              <>
                One button hands a pre-filled MCP install link to {targetName}.
                Approve the LYKN consent screen when it pops — we'll auto-detect
                the connection and flip this to Connected.
              </>
            ) : connectMode === "claude-prefill" ? (
              <>
                One button opens claude.ai with the Add Custom Connector
                dialog already filled in for LYKN. Hit Add inside Claude,
                approve the consent screen — we'll auto-detect the connection
                and flip this to Connected.
              </>
            ) : connectMode === "replit-prefill" ? (
              <>
                One button opens replit.com/integrations with the Add MCP
                Server form already filled in for LYKN. Hit Test &amp; Save
                inside Replit, approve the consent screen — we'll auto-detect
                the connection and flip this to Connected.
              </>
            ) : connectMode === "copilot-install" ? (
              <>
                One button hands a VS Code install link to your browser.
                Your browser hands off to VS Code — pick where to install
                (Global recommended), approve the LYKN consent screen.
                We'll auto-detect the connection and flip this to Connected.
              </>
            ) : connectMode === "claude-code-cli" ? (
              <>
                One button copies a <code className="font-mono text-[11.5px]">claude mcp add</code> command.
                Paste it into your terminal and press Enter — Claude Code
                pops a browser tab to the LYKN consent screen, you approve,
                we auto-detect the connection.
              </>
            ) : connectMode === "gemini-cli" ? (
              <>
                One button copies a <code className="font-mono text-[11.5px]">gemini mcp add</code> command.
                Paste it into your terminal and press Enter — Gemini CLI
                pops a browser tab to the LYKN consent screen, you approve,
                we auto-detect the connection.
              </>
            ) : connectMode === "windsurf-config" ? (
              <>
                One button copies a JSON snippet. In Windsurf, open the
                Command Palette and run <code className="font-mono text-[11.5px]">Windsurf: Configure MCP Servers</code> —
                paste inside the <code className="font-mono text-[11.5px]">mcpServers</code> object,
                save, Windsurf hot-reloads and pops the LYKN consent screen.
                We auto-detect the connection.
              </>
            ) : (
              <>
                One button copies LYKN's MCP URL and opens {targetName} for you.
                Follow the {installSteps.length}-step checklist below — we'll detect
                when it's hooked up and flip this to Connected automatically.
              </>
            )}
          </div>
          <button
            type="button"
            onClick={handleConnect}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-600/90 dark:bg-emerald-500 dark:hover:bg-emerald-500/90 text-white px-4 py-2.5 text-[13px] font-semibold transition-colors"
          >
            {copyJustWorked ? (
              <>
                <CheckCircle2 className="h-4 w-4" />
                {connectMode === "windsurf-config"
                  ? `Snippet copied — paste into Windsurf's MCP config`
                  : isCliConnectMode(connectMode)
                    ? `Command copied — paste in your terminal`
                    : `URL copied — finish in ${targetName}`}
                <ArrowRight className="h-4 w-4" />
              </>
            ) : (
              <>
                Connect {targetName} <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      )}

      {/* ── Success state ─────────────────────────────────────────── */}
      {step === 2 && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 dark:bg-emerald-500/15 p-3 space-y-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            {targetName} is connected to LYKN
          </div>
          <p className="text-[12px] leading-relaxed text-black/70 dark:text-white/75">
            Open a new chat in {targetName} and try a prompt like{" "}
            <em>"Use my LYKN context — what beliefs do you have about me?"</em>{" "}
            {targetName} will call your synthesis layer directly.
          </p>
          {successHint && (
            <p className="text-[11px] leading-relaxed text-emerald-700/90 dark:text-emerald-300/90 border-t border-emerald-500/20 pt-2 mt-1">
              <strong>Heads up:</strong> {successHint}
            </p>
          )}
          <p className="text-[10.5px] text-black/45 dark:text-white/45 leading-relaxed">
            You can revoke {targetName}'s access any time from <strong>Connected Clients</strong> below.
          </p>
        </div>
      )}

      {/* ── High-level stepper (Press → Configure → Auto-detect) ── */}
      <ol className="space-y-2">
        <StepRow
          n={1}
          done={step >= 1}
          active={step === 0}
          title={
            step >= 1
              ? stepOneDoneTitle({ connectMode, targetName })
              : stepOnePromptTitle({ connectMode, targetName })
          }
        />
        <StepRow
          n={2}
          done={step >= 2}
          active={step === 1}
          title={stepTwoHeadline}
          subtitle={
            step === 1 ? (
              <span className="text-emerald-700 dark:text-emerald-400">
                {targetName} will pop up a LYKN consent screen — click Approve.
              </span>
            ) : undefined
          }
        />
        <StepRow
          n={3}
          done={step >= 2}
          active={step === 1}
          title={
            step === 2
              ? "LYKN detected the connection — you're done"
              : "We'll auto-detect the connection here"
          }
          subtitle={
            step === 1 ? (
              <span className="inline-flex items-center gap-1.5 text-black/55 dark:text-white/55">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting for {targetName} to finish the OAuth handshake…
              </span>
            ) : undefined
          }
        />
      </ol>

      {/* ── Detailed per-target instructions (always visible while
              setting up; collapses post-connect since they're done) ── */}
      {step < 2 && installSteps.length > 1 && (
        <div className="rounded-xl border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-black/55 dark:text-white/55 mb-1.5">
            Inside {targetName}
          </div>
          <ol className="space-y-1 text-[11.5px] leading-relaxed text-black/70 dark:text-white/80 list-decimal list-inside">
            {installSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {/* ── Manual fallback disclosure ───────────────────────────────
          Shows the raw artifact a user might need if the auto-copy /
          deep link didn't work. For Claude Code we surface the actual
          install command so a user with clipboard issues can select +
          paste it themselves. For everyone else, just the MCP URL. */}
      <details className="rounded-xl border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white select-none">
          {isCliConnectMode(connectMode)
            ? `Show ${getCopyArtifactLabel(connectMode)} (or copy didn't work)`
            : "Need the URL by itself? (or copy didn't work)"}
        </summary>
        <div className="mt-2 space-y-1.5">
          {isCliConnectMode(connectMode) ? (
            <CliInstallCommandFallback
              connectMode={connectMode}
              mcpUrl={mcpUrl}
            />
          ) : (
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-md bg-white dark:bg-zinc-900 px-2 py-1.5 text-[11.5px] font-mono text-black/85 dark:text-white/85 border border-black/[0.06] dark:border-white/[0.08]">
                {mcpUrl}
              </code>
              <CopyButton
                copied={copyJustWorked}
                onClick={async () => {
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
                }}
                label="Copy URL"
              />
            </div>
          )}
          {planNote && (
            <p className="text-[10.5px] text-black/55 dark:text-white/55 leading-relaxed">
              {planNote}
            </p>
          )}
        </div>
      </details>

      {/* ── Polling diagnostics + help link ───────────────────────── */}
      {pollingError && step === 1 && (
        <div className="text-[10.5px] text-amber-700 dark:text-amber-400">
          Couldn't reach LYKN to check for the new connection ({pollingError}).
          We'll keep retrying — or refresh this dialog after approving in {targetName}.
        </div>
      )}

      {target.helpUrl && (
        <a
          href={target.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10.5px] text-black/55 dark:text-white/55 underline underline-offset-2 hover:text-black/85 dark:hover:text-white/85"
        >
          {helpLabel} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

// ─── Stepper copy helpers ─────────────────────────────────────────────────
//
// Step 1's heading needs to read accurately across all four connect
// modes — the old "URL copied + opened in tab" wording only matches
// the legacy paste-flow (ChatGPT). Cursor fires a deep link with no
// copy, Claude.ai/Desktop fire a deep link in a new tab with no copy,
// Claude Code copies a CLI command with no tab. These two helpers
// pick the right wording so the stepper doesn't lie to the user.

function stepOnePromptTitle({ connectMode, targetName }) {
  if (connectMode === "cursor-deeplink") {
    return `Press Connect — we'll hand a pre-filled install link to ${targetName}`;
  }
  if (connectMode === "claude-prefill") {
    return `Press Connect — we'll open Claude with LYKN's details pre-filled`;
  }
  if (connectMode === "replit-prefill") {
    return `Press Connect — we'll open Replit with LYKN's details pre-filled`;
  }
  if (connectMode === "copilot-install") {
    return `Press Connect — we'll hand VS Code a pre-filled MCP install link`;
  }
  if (connectMode === "windsurf-config") {
    return `Press Connect — we'll copy a JSON snippet for Windsurf's MCP config`;
  }
  if (isCliConnectMode(connectMode)) {
    return `Press Connect — we'll copy a one-line ${targetName} install command`;
  }
  return `Press Connect — we'll copy the URL and open ${targetName}`;
}

function stepOneDoneTitle({ connectMode, targetName }) {
  if (connectMode === "cursor-deeplink") {
    return `${targetName} received the install link`;
  }
  if (connectMode === "claude-prefill") {
    return `Claude opened with LYKN pre-filled`;
  }
  if (connectMode === "replit-prefill") {
    return `Replit opened with LYKN pre-filled`;
  }
  if (connectMode === "copilot-install") {
    return `Install link sent to VS Code`;
  }
  if (connectMode === "windsurf-config") {
    return `Config snippet copied — paste into Windsurf's MCP config`;
  }
  if (isCliConnectMode(connectMode)) {
    return `Install command copied — paste it in your terminal`;
  }
  return `URL copied + ${targetName} opened in a new tab`;
}

// Connect-mode predicates / dispatchers. Kept tiny + colocated with
// the stepper helpers so future paste-style clients (Codex CLI, Aider,
// new IDEs needing mcp-remote bridges, etc.) only need to (a) add a
// `connectMode: "<client>-{cli,config}"` to their outboundTarget
// entry, (b) add a builder + branch here, and (c) the rest of the
// dialog UX (hero text, button label, fallback disclosure, stepper)
// routes through these predicates automatically.
//
// We treat CLI commands (Claude Code, Gemini CLI) and config-file
// snippets (Windsurf — pasted into mcp_config.json) as the same
// shape: "copy text → user pastes somewhere → MCP client takes over."
// The differentiation is only in the human-readable copy ("install
// command" vs. "config snippet") which is handled by getCopyArtifact-
// Label below.
function isCliConnectMode(connectMode) {
  return (
    connectMode === "claude-code-cli" ||
    connectMode === "gemini-cli" ||
    connectMode === "windsurf-config"
  );
}

function buildCliInstallCommand(connectMode, { mcpUrl }) {
  if (connectMode === "claude-code-cli") {
    return buildClaudeCodeOauthInstallCommand({ mcpUrl });
  }
  if (connectMode === "gemini-cli") {
    return buildGeminiCliInstallCommand({ mcpUrl });
  }
  if (connectMode === "windsurf-config") {
    return buildWindsurfConfigSnippet({ mcpUrl });
  }
  return null;
}

// "Install command" vs. "Config snippet" — keep wording honest. The
// Windsurf snippet isn't a command you run; it's JSON you paste into
// a file. This label drives every user-facing string in the dialog
// that references the clipboard contents.
function getCopyArtifactLabel(connectMode) {
  if (connectMode === "windsurf-config") return "config snippet";
  return "install command";
}

/**
 * CliInstallCommandFallback — recovery UI shown inside the manual-
 * fallback disclosure for any connectMode where `isCliConnectMode`
 * returns true (Claude Code, Gemini CLI, future terminal-only clients).
 * The auto-copy path is the happy path; this exists for users on
 * browsers/contexts where clipboard writes fail silently (older
 * Firefox, some embedded webviews, etc) or who want to verify the
 * command before pasting.
 */
function CliInstallCommandFallback({ connectMode, mcpUrl }) {
  const [copied, setCopied] = useState(false);
  const command = useMemo(
    () => buildCliInstallCommand(connectMode, { mcpUrl }) || "",
    [connectMode, mcpUrl],
  );
  const isSnippet = connectMode === "windsurf-config";
  const copyLabel = isSnippet ? "Copy snippet" : "Copy command";
  const failTitle = isSnippet ? "Select the snippet manually." : "Select the command manually.";
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: failTitle,
        variant: "destructive",
      });
    }
  }, [command, failTitle]);
  return (
    <div className="space-y-2">
      <pre className="whitespace-pre-wrap break-all rounded-md bg-white dark:bg-zinc-900 px-2 py-1.5 text-[11.5px] font-mono text-black/85 dark:text-white/85 border border-black/[0.06] dark:border-white/[0.08]">
{command}
      </pre>
      <CopyButton copied={copied} onClick={onCopy} label={copyLabel} />
    </div>
  );
}

/**
 * StepRow — one row of the stepper. Three visual states (done / active /
 * pending) drive the icon + text emphasis. Kept as a small component so
 * the OauthMcpSection body reads like the user's actual flow.
 */
function StepRow({ n, title, subtitle, done, active }) {
  const Icon = done ? CheckCircle2 : active ? Loader2 : Circle;
  const iconClass = done
    ? "text-emerald-500"
    : active
      ? "text-emerald-500 animate-spin"
      : "text-black/30 dark:text-white/30";
  const titleClass = done
    ? "text-black/55 dark:text-white/55 line-through decoration-black/30 dark:decoration-white/30"
    : active
      ? "text-black/85 dark:text-white/90 font-medium"
      : "text-black/65 dark:text-white/70";
  return (
    <li className="flex items-start gap-2.5 text-[11.5px] leading-relaxed">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${iconClass}`} />
      <div className="min-w-0 flex-1">
        <div className={titleClass}>
          <span className="text-black/35 dark:text-white/35 mr-1.5">{n}.</span>
          {title}
        </div>
        {subtitle && <div className="mt-0.5 text-[11px]">{subtitle}</div>}
      </div>
    </li>
  );
}

/**
 * isOauthMcpToken — returns true for any active token that was minted
 * via the OAuth flow (as opposed to a long-lived PAT). We deliberately
 * do NOT filter by `client_kind` here:
 *
 *   - ChatGPT registers itself via DCR with names like "ChatGPT
 *     Connector", which our classifier maps to client_kind='chatgpt'.
 *   - Claude.ai registers via DCR with names that may or may not
 *     contain the word "claude" — the classifier sometimes drops it
 *     into 'claude-desktop' or 'other'.
 *   - Cursor / future hosts will look different again.
 *
 * Combined with the per-dialog `baselineRef` (which captures the set
 * of OAuth tokens that existed *before* the user clicked Connect),
 * "any new oauth_client_id-bearing token in the user's account" is the
 * cleanest, most future-proof signal that the handshake we're watching
 * for has just completed. The dialog already knows which target the
 * user is trying to connect — we don't need the token to confirm it.
 */
function isOauthMcpToken(t) {
  if (!t) return false;
  if (t.status !== "active") return false;
  // OAuth bearers always carry an oauth_client_id + expires_at. PATs
  // never do — that's the signal that this token came from a real
  // OAuth handshake, not from someone clicking the legacy PAT path.
  if (!t.oauth_client_id) return false;
  return true;
}

function OpenApiSection({ target, restBase }) {
  return (
    <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
      <SectionTitle>Coming soon</SectionTitle>
      <p className="text-[11px] text-black/65 dark:text-white/70 leading-relaxed">
        {target.name} doesn't speak MCP yet, so we ship a REST mirror at{" "}
        <code className="text-[10.5px]">{restBase}</code>. Once OpenAI's
        Custom GPT Actions catalog re-opens we'll publish the OpenAPI schema
        and a one-click action — your token already works against the REST
        endpoints if you want to wire one up by hand.
      </p>
      {target.helpUrl && (
        <a
          href={target.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-black/65 dark:text-white/70 underline underline-offset-2 hover:text-black/90 dark:hover:text-white"
        >
          {target.helpLabel || "Help"} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function RawSection({ raw, copied, onCopy }) {
  return (
    <div className="space-y-2">
      <SectionTitle>Wire it up by hand</SectionTitle>
      <RawRow
        label="MCP endpoint"
        value={raw.mcpUrl}
        copied={copied["raw-mcp"]}
        onCopy={() => onCopy("raw-mcp", raw.mcpUrl)}
      />
      <RawRow
        label="REST base"
        value={raw.restBase}
        copied={copied["raw-rest"]}
        onCopy={() => onCopy("raw-rest", raw.restBase)}
      />
      <RawRow
        label="Header"
        value={raw.headerExample}
        copied={copied["raw-header"]}
        onCopy={() => onCopy("raw-header", raw.headerExample)}
      />
      <p className="text-[11px] text-black/55 dark:text-white/55 leading-relaxed">
        The MCP endpoint is Streamable HTTP (POST JSON-RPC). The REST mirror
        accepts the same auth and exposes one endpoint per tool — handy for
        clients that don't speak MCP yet.
      </p>
    </div>
  );
}

function RawRow({ label, value, copied, onCopy }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[88px] text-[10.5px] text-black/55 dark:text-white/55">
        {label}
      </span>
      <code className="flex-1 min-w-0 truncate rounded-md bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1 text-[10.5px] font-mono text-black/80 dark:text-white/85 border border-black/[0.06] dark:border-white/[0.08]">
        {value}
      </code>
      <CopyButton copied={copied} onClick={onCopy} label="Copy" />
    </div>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide text-black/55 dark:text-white/60">
      {children}
    </div>
  );
}

function CopyButton({ copied, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-black/10 dark:border-white/15 bg-white/70 dark:bg-zinc-900/70 px-2 py-1 text-[10.5px] font-medium text-black/75 dark:text-white/80 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
      aria-label={label}
    >
      {copied ? (
        <>
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          Copy
        </>
      )}
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildAbsoluteUrl(path) {
  // API_BASE_URL may be a relative path or absolute. The user's MCP
  // client needs an ABSOLUTE URL or it can't reach us — try to upgrade
  // a relative API_BASE_URL using the current origin.
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
