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
} from "@/lib/connectors/outboundTargets";

/**
 * Post-signup "Connect your AI tools" onboarding screen.
 *
 * Three buttons, three different UX realities (per the discovery
 * pushed to project state under client_install_ux_research):
 *
 *   1. Cursor — true 1-click via cursor:// deeplink. The deeplink
 *      points Cursor at LYKN's /mcp with NO baked-in PAT; on first
 *      connect Cursor 401s, reads the `WWW-Authenticate:
 *      ... resource_metadata=…` header from /mcp, discovers our OAuth
 *      provider via /.well-known, registers itself via DCR, and pops
 *      a tab to /oauth/consent for the user to Approve. Because the
 *      user is already authed in this browser, that's a single click.
 *
 *   2. Claude.ai — 1-click prefilled-modal deep link. We open
 *      https://claude.ai/customize/connectors?modal=add-custom-connector
 *      &connectorName=LYKN&connectorUrl=<mcp> in a new tab. Claude
 *      surfaces the Add Custom Connector dialog ALREADY populated;
 *      user clicks Add inside the dialog, then approves the LYKN
 *      consent screen on the OAuth redirect. Same poll detects it.
 *
 *   3. ChatGPT — guided overlay. No deeplink / URL-prefill exists, so
 *      we open chatgpt.com + copy the URL, then show a 5-step
 *      walkthrough. Plan-gated (Plus/Pro/Team/Enterprise + Developer
 *      Mode); we surface this caveat up front.
 *
 * Connection detection: poll /api/v1/synthesis/tokens. Any new active
 * token with `oauth_client_id` populated = a successful OAuth
 * handshake from one of the three clients. We snapshot the baseline
 * the moment the page loads so we only react to NEW connections.
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

  // Track which clients have connected this session. Each entry is one
  // of "cursor" | "claude" | "chatgpt"; presence in the set means we've
  // observed an OAuth bearer attributed to that client.
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
  // pending. Stops once all three are connected or the user navigates
  // away. 3s cadence — tight enough to feel instant, loose enough to
  // not hammer the backend.
  useEffect(() => {
    if (!user) return undefined;
    if (!pending) return undefined;
    if (connected.size >= 3) return undefined;
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
            tagline="One click opens Claude with the Add Custom Connector dialog already filled in. Hit Add, Approve."
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
                Available on Free, Pro, and Max — the connection auto-syncs
                to Claude Desktop, mobile, and Claude Code with no extra setup.
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
                  URL copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy URL
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
    case "claude-web":
    case "claude-desktop":
    case "claude-code":
      return "claude";
    case "chatgpt":
      return "chatgpt";
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
