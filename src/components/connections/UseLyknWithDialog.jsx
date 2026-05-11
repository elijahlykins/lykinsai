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
  Copy,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import {
  buildClaudeDesktopSnippet,
  buildClaudeCodeCommand,
  buildCursorDeeplink,
  buildCursorMcpJsonSnippet,
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
 * Per-client install paths:
 *   • cursor          → one-button deeplink that registers LYKN inside Cursor
 *   • claude-desktop  → copy-pasteable JSON snippet for claude_desktop_config.json
 *   • claude-code     → copy-pasteable `claude mcp add` CLI command
 *   • chatgpt         → placeholder (Custom GPT Action) — read-only for now
 *   • other           → just the URL + token, the user wires it up
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
  // Exception: the OAuth-MCP install path (ChatGPT Connectors) doesn't
  // need a PAT — the OAuth flow is the proof of access — so we skip
  // minting entirely and let the OauthMcpSection render directly off
  // target.installType. This avoids issuing an orphan token the user
  // never sees on their Connected Clients list.
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

  const claudeDesktopSnippet = useMemo(
    () => buildClaudeDesktopSnippet({ token: plaintext, mcpUrl }),
    [plaintext, mcpUrl],
  );
  const claudeCodeCommand = useMemo(
    () => buildClaudeCodeCommand({ token: plaintext, mcpUrl }),
    [plaintext, mcpUrl],
  );
  const cursorDeeplink = useMemo(
    () => buildCursorDeeplink({ token: plaintext, mcpUrl }),
    [plaintext, mcpUrl],
  );
  const cursorMcpJson = useMemo(
    () => buildCursorMcpJsonSnippet({ token: plaintext, mcpUrl }),
    [plaintext, mcpUrl],
  );
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
          <OauthMcpSection target={target} mcpUrl={mcpUrl} />
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
            {installType === "deeplink" && (
              <CursorInstallSection
                clientName={target.name}
                deeplink={cursorDeeplink}
                snippet={cursorMcpJson}
                copied={copied["cursor-mcp-json"]}
                onCopy={() => copyTo("cursor-mcp-json", cursorMcpJson)}
              />
            )}

            {installType === "config-json" && (
              <ConfigJsonSection
                clientName={target.name}
                snippet={claudeDesktopSnippet}
                copyKey="claude-desktop-snippet"
                copied={copied["claude-desktop-snippet"]}
                onCopy={() => copyTo("claude-desktop-snippet", claudeDesktopSnippet)}
                helpUrl={target.helpUrl}
                helpLabel={target.helpLabel || "Where does this go?"}
              />
            )}

            {installType === "cli" && (
              <CliSection
                clientName={target.name}
                command={claudeCodeCommand}
                copyKey="claude-code-command"
                copied={copied["claude-code-command"]}
                onCopy={() => copyTo("claude-code-command", claudeCodeCommand)}
                helpUrl={target.helpUrl}
                helpLabel={target.helpLabel}
              />
            )}

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

/**
 * CursorInstallSection — a deliberately simple two-button flow.
 *
 * Why two buttons (download + deeplink) instead of one?
 *
 * The official `cursor://anysphere.cursor-deeplink/...` deeplink is the
 * "best path" on machines where Cursor is correctly registered as the
 * URI-scheme handler — one click and Cursor pops the install dialog.
 * BUT on Windows that registration is unreliable: clicking the link
 * often does nothing visible, no error, no toast, just silence. Worse,
 * the user has no way to tell the difference between "installed!" and
 * "browser swallowed the request".
 *
 * So we make the foolproof "save the file" path the PRIMARY action
 * (download mcp.json + clear instructions for where it goes), and
 * keep the deeplink as a smaller "or, shortcut" affordance for users
 * whose protocol handler does work. Worst case: download always works.
 */
function CursorInstallSection({
  clientName,
  deeplink,
  snippet,
  copied,
  onCopy,
}) {
  const downloadConfig = useCallback(() => {
    try {
      const blob = new Blob([snippet], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mcp.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({
        title: "Download failed",
        description: "Use the Copy config button below instead.",
        variant: "destructive",
      });
    }
  }, [snippet]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <SectionTitle>Install in {clientName}</SectionTitle>
        <button
          type="button"
          onClick={downloadConfig}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-[12.5px] font-medium hover:opacity-90 transition-opacity w-full"
        >
          <Download className="h-3.5 w-3.5" />
          Download mcp.json
        </button>
        <ol className="list-decimal pl-5 space-y-1 text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed marker:text-black/40 dark:marker:text-white/40">
          <li>
            Move the downloaded <code className="text-[10.5px] text-black/80 dark:text-white/85">mcp.json</code>
            {" "}to:{" "}
            <code className="text-[10.5px] text-black/80 dark:text-white/85 break-all">
              C:\Users\&lt;you&gt;\.cursor\mcp.json
            </code>
            {" "}(global, recommended) or{" "}
            <code className="text-[10.5px] text-black/80 dark:text-white/85">.cursor/mcp.json</code>
            {" "}in any project (per-project).
          </li>
          <li>
            In {clientName}: <code className="text-[10.5px]">Ctrl+Shift+P</code>{" "}
            → <strong>Reload Window</strong> (or just close + reopen Cursor).
          </li>
          <li>
            LYKN appears in <code className="text-[10.5px]">Settings → MCP</code>{" "}
            with 8 tools. Done.
          </li>
        </ol>
      </div>

      {/* Secondary: copy-paste fallback */}
      <details className="rounded-xl border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2 group">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white select-none">
          Prefer to copy-paste? Show the JSON
        </summary>
        <div className="mt-2 space-y-2">
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-black/[0.08] dark:border-white/10 bg-white/70 dark:bg-zinc-900/70 px-3 py-2 text-[11px] font-mono text-black/85 dark:text-white/85 max-h-60">
{snippet}
            </pre>
            <div className="absolute top-1.5 right-1.5">
              <CopyButton copied={copied} onClick={onCopy} label="Copy config" />
            </div>
          </div>
        </div>
      </details>

      {/* Tertiary: the deeplink — "lucky button" for users with protocol handler set up */}
      <div className="text-[10.5px] text-black/45 dark:text-white/45 leading-relaxed">
        Got the protocol handler set up?{" "}
        <a
          href={deeplink}
          className="underline underline-offset-2 text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white"
        >
          Try the one-click deeplink
        </a>
        {" "}— may not work on every machine.
      </div>
    </div>
  );
}

/**
 * ConfigJsonSection — same UX shape as Cursor + Claude Code: the actual
 * useful action (Download or Copy) is the BIG button at top, with the
 * raw config tucked behind a "Show snippet" disclosure for users who
 * want to verify or hand-edit. The token + URL on a single line easily
 * runs ~200 chars, which made the old horizontal-scroll <pre> awful.
 */
function ConfigJsonSection({
  clientName,
  snippet,
  copied,
  onCopy,
  helpUrl,
  helpLabel,
}) {
  const isClaudeDesktop = clientName === "Claude Desktop";

  const downloadSnippet = useCallback(() => {
    try {
      const blob = new Blob([snippet], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "claude_desktop_config.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({
        title: "Download failed",
        description: "Use Copy snippet instead.",
        variant: "destructive",
      });
    }
  }, [snippet]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <SectionTitle>Install in {clientName}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={downloadSnippet}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-[12.5px] font-medium hover:opacity-90 transition-opacity"
          >
            <Download className="h-3.5 w-3.5" />
            Download config
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-black/15 dark:border-white/20 bg-white/70 dark:bg-zinc-900/70 px-4 py-2 text-[12.5px] font-medium text-black/85 dark:text-white/90 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
          >
            {copied ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy snippet
              </>
            )}
          </button>
        </div>
        {isClaudeDesktop ? (
          <ol className="list-decimal pl-5 space-y-1 text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed marker:text-black/40 dark:marker:text-white/40">
            <li>
              Save / merge the snippet into:{" "}
              <code className="text-[10.5px] text-black/80 dark:text-white/85 break-all">
                %APPDATA%\Claude\claude_desktop_config.json
              </code>{" "}
              (Windows) or{" "}
              <code className="text-[10.5px] text-black/80 dark:text-white/85 break-all">
                ~/Library/Application Support/Claude/claude_desktop_config.json
              </code>{" "}
              (macOS).
            </li>
            <li>
              <strong>Quit Claude completely</strong> (system tray icon →
              Quit), then relaunch it.
            </li>
            <li>
              First launch takes ~10 extra seconds — <code className="text-[10.5px]">npx</code>{" "}
              fetches <code className="text-[10.5px]">mcp-remote</code>. After
              that LYKN's 8 tools appear under Settings → MCP.
            </li>
          </ol>
        ) : (
          <p className="text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed">
            Save the snippet into your client's MCP config file, then restart
            it. The 8 LYKN tools become available immediately.
          </p>
        )}
      </div>

      {/* Snippet hidden by default — long tokens make horizontal scroll painful. */}
      <details className="rounded-xl border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white select-none">
          Show snippet (for reference)
        </summary>
        <div className="mt-2">
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-black/[0.08] dark:border-white/10 bg-white/70 dark:bg-zinc-900/70 px-3 py-2 text-[11px] font-mono text-black/85 dark:text-white/85 max-h-72 overflow-y-auto">
{snippet}
          </pre>
        </div>
      </details>

      {helpUrl && (
        <a
          href={helpUrl}
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

/**
 * CliSection — same UX shape as CursorInstallSection: BIG primary action
 * up top, supporting context below.
 *
 * The Claude Code command is long (~150 chars with the URL + token), so
 * we let the <pre> wrap onto multiple lines instead of horizontal-scroll.
 * Horizontal scroll inside a small dialog hides the second half of the
 * command — and there's no scroll affordance on Windows trackpads when
 * the box doesn't have visible scrollbars. Wrapping is just better.
 */
function CliSection({ clientName, command, copied, onCopy, helpUrl, helpLabel }) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <SectionTitle>Install in {clientName}</SectionTitle>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-[12.5px] font-medium hover:opacity-90 transition-opacity w-full"
        >
          {copied ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              Command copied — paste it in PowerShell
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy install command
            </>
          )}
        </button>
        <ol className="list-decimal pl-5 space-y-1 text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed marker:text-black/40 dark:marker:text-white/40">
          <li>
            Open a fresh PowerShell window (
            <code className="text-[10.5px]">Win+R</code> →{" "}
            <code className="text-[10.5px]">powershell</code> → Enter).
          </li>
          <li>Paste the command (<code className="text-[10.5px]">Ctrl+V</code>) and hit Enter.</li>
          <li>
            You should see <code className="text-[10.5px]">Added MCP server lykn</code>.
            Then run <code className="text-[10.5px]">claude</code> and the
            8 LYKN tools are available.
          </li>
        </ol>
      </div>

      {/* Secondary: show the actual command for reference / manual copy. */}
      <details className="rounded-xl border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white select-none">
          Show command (for reference)
        </summary>
        <div className="mt-2">
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-black/[0.08] dark:border-white/10 bg-white/70 dark:bg-zinc-900/70 px-3 py-2 text-[11px] font-mono text-black/85 dark:text-white/85 max-h-60 overflow-y-auto">
{command}
          </pre>
        </div>
      </details>

      {helpUrl && (
        <a
          href={helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10.5px] text-black/55 dark:text-white/55 underline underline-offset-2 hover:text-black/85 dark:hover:text-white/85"
        >
          {helpLabel || "Help"} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

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
 * OauthMcpSection — install path for clients that speak BOTH MCP and
 * OAuth (ChatGPT Connectors today; native ChatGPT MCP later; Cursor's
 * MCP-OAuth flow eventually).
 *
 * The user's only job is to paste LYKN's MCP base URL into the client's
 * Add-Connector flow. The client then:
 *   1. GETs /.well-known/oauth-authorization-server (auto-discovery)
 *   2. POSTs /oauth/register (Dynamic Client Registration)
 *   3. Pops up /oauth/authorize → user approves at /oauth/consent
 *   4. POSTs /oauth/token, gets a bearer, starts hitting /mcp
 *
 * No token paste, no JSON snippet, no CLI command. The OAuth flow IS
 * the install. That's why this dialog skips the PAT mint entirely
 * for installType="oauth-mcp" — it would just produce orphan tokens.
 */
function OauthMcpSection({ target, mcpUrl }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select the URL manually.", variant: "destructive" });
    }
  }, [mcpUrl]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06] p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />
          No token to copy — {target.name} signs you in via OAuth
        </div>
        <p className="text-[12px] leading-relaxed text-black/65 dark:text-white/70">
          When {target.name} hits LYKN it auto-discovers our OAuth provider,
          registers itself, and pops up a consent screen. Approve once and
          you're done — no manual config, no PAT to leak.
        </p>
      </div>

      <div>
        <SectionTitle>LYKN's MCP URL</SectionTitle>
        <div className="mt-1.5 flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate rounded-md bg-white dark:bg-zinc-900 px-2 py-1.5 text-[11.5px] font-mono text-black/85 dark:text-white/85 border border-black/[0.06] dark:border-white/[0.08]">
            {mcpUrl}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md border border-black/15 dark:border-white/20 bg-white dark:bg-zinc-900 px-2 py-1.5 text-[11px] font-medium text-black/85 dark:text-white/90 hover:bg-black/[0.03] dark:hover:bg-white/[0.06] transition-colors"
          >
            {copied ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy URL
              </>
            )}
          </button>
        </div>
      </div>

      <div>
        <SectionTitle>Install in {target.name}</SectionTitle>
        <ol className="mt-1.5 list-decimal pl-5 space-y-1 text-[11.5px] text-black/65 dark:text-white/70 leading-relaxed marker:text-black/40 dark:marker:text-white/40">
          <li>Open ChatGPT → click your avatar → <strong>Settings</strong>.</li>
          <li>Pick <strong>Connectors</strong> in the left rail.</li>
          <li>Click <strong>Add connector</strong> → choose <strong>MCP server</strong>.</li>
          <li>Paste the URL above and click <strong>Add</strong>.</li>
          <li>
            ChatGPT pops up a LYKN sign-in / consent screen — approve it and the
            11 LYKN tools are available in any new chat.
          </li>
        </ol>
        <p className="mt-2 text-[10.5px] text-black/45 dark:text-white/45 leading-relaxed">
          Connectors require ChatGPT Pro, Team, or Enterprise. Free accounts
          can still use the personal-access-token paths above.
        </p>
      </div>

      {target.helpUrl && (
        <a
          href={target.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10.5px] text-black/55 dark:text-white/55 underline underline-offset-2 hover:text-black/85 dark:hover:text-white/85"
        >
          {target.helpLabel || "ChatGPT Connectors help"} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
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
