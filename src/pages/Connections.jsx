import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  Brain,
  Check,
  Columns,
  Compass,
  FileSearch,
  FileText,
  Filter,
  FolderOpen,
  GitBranch,
  Globe,
  Headphones,
  Image as ImageIcon,
  Inbox,
  Languages,
  Layers,
  LayoutGrid,
  Link as LinkIcon,
  ListChecks,
  MessageCircle,
  Mic,
  MousePointerClick,
  Plug,
  Quote,
  Rss,
  Search,
  Send,
  Sparkles,
  Star,
  Table2,
  Tag,
  Telescope,
  Upload,
  Volume2,
  Wand2,
  Workflow,
  Youtube,
} from "lucide-react";
import {
  CONNECTORS,
  CONNECTOR_CATEGORIES,
  CONNECTOR_STATUSES,
} from "@/lib/connectors/catalog";
import {
  SKILLS,
  SKILL_CATEGORIES,
  SKILL_STATUSES,
} from "@/lib/skills/catalog";
import { toast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import BookmarkletDialog from "@/components/connections/BookmarkletDialog";
import RssDialog from "@/components/connections/RssDialog";
import OAuthConnectDialog from "@/components/connections/OAuthConnectDialog";
import TokenConnectDialog from "@/components/connections/TokenConnectDialog";

// Connector ids that go through the OAuth framework (one row per id in
// connectors-service.js CONNECTOR_REGISTRY on the server). Adding a new
// adapter? Add the id here and it gets the OAuth dialog automatically.
const OAUTH_PROVIDERS = new Set([
  "github", "reddit", "notion", "spotify", "pinterest",
  "linear", "todoist", "vimeo", "raindrop", "dribbble",
  "youtube", "google-drive", "google-calendar", "gmail",
  "outlook-365", "slack", "x", "canva", "mastodon",
]);

// ─── Lucide fallback icons for first-party connector surfaces ────────
const FALLBACK_ICONS = {
  "share-target": Send,
  "browser-extension": Plug,
  bookmarklet: Star,
  "email-to-vault": Inbox,
  rss: Rss,
  mcp: Sparkles,
};

// ─── Map skill catalog icon strings to actual Lucide components ──────
const SKILL_ICON_COMPONENTS = {
  Brain,
  Columns,
  FileSearch,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Headphones,
  Image: ImageIcon,
  Languages,
  Layers,
  LayoutGrid,
  Link: LinkIcon,
  ListChecks,
  MessageCircle,
  Mic,
  MousePointerClick,
  Plug,
  Quote,
  Search,
  Send,
  Sparkles,
  Table2,
  Tag,
  Telescope,
  Upload,
  Volume2,
  Wand2,
  Workflow,
  Youtube,
  Filter,
};

function faviconCandidates(domain) {
  if (!domain) return [];
  const enc = encodeURIComponent(domain);
  return [
    `https://www.google.com/s2/favicons?sz=128&domain=${enc}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://www.google.com/s2/favicons?sz=64&domain=${enc}`,
  ];
}

function BrandIcon({ connector, size = 28 }) {
  const candidates = faviconCandidates(connector.domain);
  const [attempt, setAttempt] = useState(0);
  const Fallback = FALLBACK_ICONS[connector.id] || Plug;

  if (!candidates.length || attempt >= candidates.length) {
    return (
      <Fallback
        className="text-black/70 dark:text-white/80"
        style={{ width: size, height: size }}
        strokeWidth={1.75}
      />
    );
  }

  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${connector.name} logo`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((a) => a + 1)}
      className="block object-contain"
      style={{ width: size, height: size }}
    />
  );
}

const TONE_CLASSES = {
  emerald:
    "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  blue: "bg-blue-500/12 text-blue-700 dark:text-blue-400 border-blue-500/20",
  amber:
    "bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/20",
  neutral:
    "bg-black/[0.04] text-black/55 dark:bg-white/[0.06] dark:text-white/55 border-black/[0.06] dark:border-white/[0.08]",
};

function StatusBadge({ tone, label }) {
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.neutral;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function ConnectorCard({ connector, connected, onConnect, onDisconnect }) {
  const isCaptureLive = connector.status === "beta";
  const isNoApi = connector.status === "no-api";
  const isVerification = connector.status === "verification";
  const isPaid = connector.status === "paid";

  const ctaLabel = connected
    ? "Connected"
    : isCaptureLive
    ? "Set up"
    : isNoApi
    ? "How to capture"
    : isPaid
    ? "Pay to enable"
    : isVerification
    ? "Notify me"
    : "Connect";

  const ctaDisabled = isPaid;

  const meta =
    CONNECTOR_STATUSES[connector.status] || CONNECTOR_STATUSES.soon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="group relative rounded-2xl border border-black/[0.06] dark:border-white/10 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-4 flex flex-col gap-3 hover:border-black/15 dark:hover:border-white/20 transition-colors shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
          <BrandIcon connector={connector} size={28} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[13px] font-semibold text-black/85 dark:text-white/90 truncate">
              {connector.name}
            </h3>
            <StatusBadge tone={meta.tone} label={connector.statusLabel || meta.label} />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-black/55 dark:text-white/55 line-clamp-3">
            {connector.summary}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {connector.pulls.slice(0, 4).map((tag) => (
          <span
            key={tag}
            className="text-[10px] text-black/55 dark:text-white/55 rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-[2px]"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-black/[0.05] dark:border-white/[0.06]">
        <div className="flex items-center gap-2 text-[10px] text-black/45 dark:text-white/45">
          <span>{connector.auth}</span>
          {connector.realtime && (
            <>
              <span>·</span>
              <span>{connector.realtime}</span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={connected ? onDisconnect : onConnect}
          disabled={ctaDisabled}
          className={`text-[11px] font-medium rounded-full px-3 py-1 transition-colors ${
            connected
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25"
              : ctaDisabled
              ? "bg-black/[0.04] dark:bg-white/[0.06] text-black/40 dark:text-white/40 cursor-not-allowed"
              : "bg-black text-white dark:bg-white dark:text-black hover:opacity-90"
          }`}
        >
          {connected ? (
            <span className="inline-flex items-center gap-1">
              <Check className="h-3 w-3" /> Connected
            </span>
          ) : (
            ctaLabel
          )}
        </button>
      </div>
    </motion.div>
  );
}

function SkillCard({ skill, accent, onLaunch }) {
  const Icon = SKILL_ICON_COMPONENTS[skill.icon] || Sparkles;
  const meta = SKILL_STATUSES[skill.status] || SKILL_STATUSES.soon;

  const handleKey = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onLaunch?.(skill);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      role="button"
      tabIndex={0}
      onClick={() => onLaunch?.(skill)}
      onKeyDown={handleKey}
      className="group relative rounded-2xl border border-black/[0.06] dark:border-white/10 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-4 flex flex-col gap-3 cursor-pointer transition-all duration-150 shadow-sm hover:-translate-y-[1px] hover:border-black/20 dark:hover:border-white/25 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:border-blue-500/40"
    >
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
        <ArrowUpRight className="h-3.5 w-3.5 text-black/45 dark:text-white/55" strokeWidth={2} />
      </div>

      <div className="flex items-start gap-3">
        <div
          className="h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${accent}18`, color: accent }}
        >
          <Icon className="h-[20px] w-[20px]" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1 pr-5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[13px] font-semibold text-black/85 dark:text-white/90 truncate">
              {skill.name}
            </h3>
            <StatusBadge tone={meta.tone} label={skill.statusLabel || meta.label} />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-black/55 dark:text-white/55 line-clamp-3">
            {skill.summary}
          </p>
        </div>
      </div>

      {skill.example && (
        <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.04] dark:border-white/[0.06] px-2.5 py-1.5">
          <span className="text-[10px] text-black/40 dark:text-white/40 mr-1.5">
            Try:
          </span>
          <span className="text-[11px] italic text-black/65 dark:text-white/70">
            {skill.example}
          </span>
        </div>
      )}
    </motion.div>
  );
}

export default function Connections() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [view, setView] = useState("connections"); // "connections" | "skills"
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [bookmarkletOpen, setBookmarkletOpen] = useState(false);
  const [rssOpen, setRssOpen] = useState(false);
  const [oauthConnector, setOauthConnector] = useState(null);
  const [tokenConnector, setTokenConnector] = useState(null);
  // Live connection state from /api/connections, keyed by provider id.
  // Each value is the count of accounts the user has linked for that
  // provider (0 = not connected, ≥1 = connected, possibly multi-account).
  const [liveConnections, setLiveConnections] = useState({});

  // Fetch the user's connections from the server. Called on mount, when
  // the user changes, and whenever a connect/disconnect dialog closes
  // (so the grid card pill flips immediately after a successful action).
  const refreshConnections = useCallback(async () => {
    if (!user) {
      setLiveConnections({});
      return;
    }
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token || "";
      const res = await fetch(`${API_BASE_URL}/api/connections`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const counts = {};
      for (const c of data.connections || []) {
        counts[c.provider] = (counts[c.provider] || 0) + 1;
      }
      setLiveConnections(counts);
    } catch {
      // Silent — leaving stale state is preferable to a noisy toast on
      // every page load if the API is briefly unreachable.
    }
  }, [user]);

  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

  const handleLaunchSkill = (skill) => {
    const action = skill.action || {};
    if (action.comingSoon) {
      toast({
        title: `${skill.name} is coming soon`,
        description:
          "We're actively working on this. You'll see it in your Skills as soon as it's live.",
      });
      return;
    }
    if (action.connections) {
      toast({
        title: "Connect a service first",
        description: `${skill.name} unlocks once you've connected at least one service.`,
      });
      nav("/connections");
      return;
    }
    if (action.route === "/grid/new") {
      const newId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);
      const suffix = action.chat ? "?chat=1" : "";
      nav(`/grid/${newId}${suffix}`);
      return;
    }
    if (action.route) {
      const suffix = action.chat ? "?chat=1" : "";
      nav(`${action.route}${suffix}`);
      return;
    }
    nav("/app");
  };

  // ── Connections filtering ────────────────────────────────────────
  const filteredConnections = useMemo(() => {
    const q = search.trim().toLowerCase();
    return CONNECTOR_CATEGORIES.map((cat) => {
      const items = CONNECTORS.filter((c) => c.category === cat.id).filter(
        (c) => {
          if (
            filter === "available" &&
            c.status !== "beta" &&
            c.status !== "available"
          )
            return false;
          if (filter === "soon" && c.status !== "soon") return false;
          if (filter === "no-api" && c.status !== "no-api") return false;
          if (
            q &&
            !c.name.toLowerCase().includes(q) &&
            !c.summary.toLowerCase().includes(q) &&
            !c.pulls.join(" ").toLowerCase().includes(q)
          )
            return false;
          return true;
        }
      );
      return { ...cat, items };
    }).filter((cat) => cat.items.length > 0);
  }, [search, filter]);

  // ── Skills filtering ─────────────────────────────────────────────
  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return SKILL_CATEGORIES.map((cat) => {
      const items = SKILLS.filter((s) => s.category === cat.id).filter((s) => {
        if (filter === "available" && s.status !== "live") return false;
        if (filter === "soon" && s.status !== "soon") return false;
        if (filter === "no-api") return false; // not relevant for skills
        if (
          q &&
          !s.name.toLowerCase().includes(q) &&
          !s.summary.toLowerCase().includes(q) &&
          !(s.example || "").toLowerCase().includes(q)
        )
          return false;
        return true;
      });
      return { ...cat, items };
    }).filter((cat) => cat.items.length > 0);
  }, [search, filter]);

  // ── Header counts ────────────────────────────────────────────────
  const connTotalActive = useMemo(
    () =>
      CONNECTORS.filter(
        (c) => c.status === "beta" || c.status === "available"
      ).length,
    []
  );
  const connTotalSoon = useMemo(
    () => CONNECTORS.filter((c) => c.status === "soon").length,
    []
  );
  const skillsTotalLive = useMemo(
    () => SKILLS.filter((s) => s.status === "live").length,
    []
  );
  const skillsTotalSoon = useMemo(
    () => SKILLS.filter((s) => s.status === "soon").length,
    []
  );

  const isConnections = view === "connections";

  // ── Connect / disconnect handlers (connections view only) ────────
  const handleConnect = (connector) => {
    // Token-paste providers (Readwise, Matter, Bluesky app password, ...)
    // route through the credential-paste dialog. Cheaper to detect off the
    // catalog flag than to maintain a second hardcoded set.
    if (connector.authMode === "token") {
      setTokenConnector(connector);
      return;
    }
    // OAuth-backed providers route through the generic dialog, regardless
    // of catalog status. The dialog itself surfaces "not configured" if
    // the server is missing client_id/secret.
    if (OAUTH_PROVIDERS.has(connector.id)) {
      setOauthConnector(connector);
      return;
    }
    if (connector.status === "beta") {
      if (connector.id === "bookmarklet") {
        setBookmarkletOpen(true);
        return;
      }
      if (connector.id === "rss") {
        setRssOpen(true);
        return;
      }
      if (connector.id === "share-target") {
        toast({
          title: "Install LYKN to your home screen",
          description:
            "On your phone: open LYKN in Chrome (Android) or Safari (iOS), then 'Add to Home Screen'. The Share sheet will then show LYKN.",
        });
      } else if (connector.id === "browser-extension") {
        toast({
          title: "Browser extension",
          description:
            "Load extensions/save-to-lykn unpacked in chrome://extensions for now. Chrome Web Store listing coming soon.",
        });
      }
      return;
    }
    if (connector.status === "no-api") {
      toast({
        title: `Use the Save to LYKN button for ${connector.name}`,
        description:
          "These platforms don't expose saved content via API. Tap the platform's Share button → choose LYKN.",
      });
      return;
    }
    if (connector.status === "paid") {
      toast({
        title: `${connector.name} requires a paid API tier`,
        description:
          "We'll enable this once it's economically viable. Use the Save to LYKN button in the meantime.",
      });
      return;
    }
    if (connector.status === "verification") {
      toast({
        title: `${connector.name} is pending platform review`,
        description:
          "We've submitted for verification. You'll be the first to know when it's live.",
      });
      return;
    }
    toast({
      title: `${connector.name} connector is on the way`,
      description: "OAuth flow lands in the next round.",
    });
  };

  // When a user clicks the "Connected" pill on a grid card, open the
  // same dialog they used to connect. The dialog is the right surface
  // for managing existing connections (sync now, pause, disconnect, add
  // another account). Routing here keeps the grid card a one-button
  // affordance and the dialog the source of truth for state changes.
  const handleManage = (connector) => {
    if (connector.authMode === "token") {
      setTokenConnector(connector);
      return;
    }
    if (OAUTH_PROVIDERS.has(connector.id)) {
      setOauthConnector(connector);
      return;
    }
    if (connector.id === "rss") {
      setRssOpen(true);
      return;
    }
    if (connector.id === "bookmarklet") {
      setBookmarkletOpen(true);
      return;
    }
  };

  // ── View-specific filter chip set ────────────────────────────────
  const filterOptions = isConnections
    ? [
        { id: "all", label: "All" },
        { id: "available", label: "Live" },
        { id: "soon", label: "Coming soon" },
        { id: "no-api", label: "Capture only" },
      ]
    : [
        { id: "all", label: "All" },
        { id: "available", label: "Live" },
        { id: "soon", label: "Coming soon" },
      ];

  return (
    <div className="min-h-screen w-full px-6 md:px-10 py-10">
      <div className="mx-auto max-w-6xl">
        {/* ── Top toggle ───────────────────────────────────── */}
        <div className="flex justify-center">
          <div
            role="tablist"
            className="relative inline-flex items-center gap-1 rounded-full border border-black/10 dark:border-white/15 bg-white/50 dark:bg-zinc-900/60 backdrop-blur p-1 shadow-sm"
          >
            <button
              type="button"
              role="tab"
              aria-selected={isConnections}
              onClick={() => {
                setView("connections");
                setFilter("all");
              }}
              className={`relative inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors ${
                isConnections
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "text-black/60 dark:text-white/60 hover:text-black/90 dark:hover:text-white"
              }`}
            >
              <Plug className="h-3.5 w-3.5" />
              Connections
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isConnections}
              onClick={() => {
                setView("skills");
                setFilter("all");
              }}
              className={`relative inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors ${
                !isConnections
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "text-black/60 dark:text-white/60 hover:text-black/90 dark:hover:text-white"
              }`}
            >
              <Wand2 className="h-3.5 w-3.5" />
              Skills
            </button>
          </div>
        </div>

        {/* ── Header (changes per view) ────────────────────── */}
        <div className="mt-7 flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-black/90 dark:text-white/95">
              {isConnections
                ? "Hook LYKN into the rest of your stack"
                : "Everything LYKN's AI can do"}
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-black/60 dark:text-white/60">
              {isConnections
                ? "Connect a service and the things you save, like, and bookmark there flow into your Vault automatically. Each connection is opt‑in, read‑only by default, and revocable at any time."
                : "Capture, understand, generate, summarize, and act on what's in your Vault. Each skill is available everywhere — chat, canvas, vault search, voice."}
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3 text-[11px] text-black/55 dark:text-white/55">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {isConnections ? connTotalActive : skillsTotalLive} live
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                {isConnections ? connTotalSoon : skillsTotalSoon} planned
              </span>
            </div>
            {!user && isConnections && (
              <div className="text-[11px] text-black/45 dark:text-white/45">
                Sign in to connect accounts.
              </div>
            )}
          </div>
        </div>

        {/* ── Search + filter row ──────────────────────────── */}
        <div className="mt-6 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/15 bg-white/40 dark:bg-zinc-900/50 backdrop-blur px-3 py-2 flex-1 min-w-[240px]">
            <Search className="h-3.5 w-3.5 text-black/40 dark:text-white/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                isConnections
                  ? "Search connections (Notion, YouTube, Slack…)"
                  : "Search skills (search, transcribe, summarize…)"
              }
              className="flex-1 bg-transparent outline-none text-[12.5px] text-black/80 dark:text-white/85 placeholder:text-black/35 dark:placeholder:text-white/35"
            />
          </div>

          <div className="inline-flex items-center gap-1 rounded-xl border border-black/10 dark:border-white/15 bg-white/40 dark:bg-zinc-900/50 backdrop-blur p-1">
            {filterOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFilter(opt.id)}
                className={`text-[11px] font-medium rounded-lg px-2.5 py-1 transition-colors ${
                  filter === opt.id
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "text-black/60 dark:text-white/60 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Body grid ───────────────────────────────────── */}
        <div className="mt-8 space-y-10">
          {isConnections ? (
            filteredConnections.length === 0 ? (
              <EmptyState message="No connections match that filter." />
            ) : (
              filteredConnections.map((cat) => (
                <section key={cat.id}>
                  <CategoryHeader cat={cat} count={cat.items.length} />
                  <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                    {cat.items.map((connector) => (
                      <ConnectorCard
                        key={connector.id}
                        connector={connector}
                        connected={(liveConnections[connector.id] || 0) > 0}
                        onConnect={() => handleConnect(connector)}
                        onDisconnect={() => handleManage(connector)}
                      />
                    ))}
                  </div>
                </section>
              ))
            )
          ) : filteredSkills.length === 0 ? (
            <EmptyState message="No skills match that filter." />
          ) : (
            filteredSkills.map((cat) => (
              <section key={cat.id}>
                <CategoryHeader cat={cat} count={cat.items.length} />
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {cat.items.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      accent={cat.accent}
                      onLaunch={handleLaunchSkill}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {/* ── Footer hint ─────────────────────────────────── */}
        <div className="mt-12 rounded-2xl border border-dashed border-black/10 dark:border-white/15 bg-white/30 dark:bg-zinc-900/30 p-5 flex items-start gap-3">
          <Compass className="h-4 w-4 text-black/45 dark:text-white/45 mt-[2px] flex-shrink-0" />
          <div className="text-[12px] leading-relaxed text-black/60 dark:text-white/60">
            {isConnections ? (
              <>
                Don't see something here?{" "}
                <a
                  href="mailto:hello@lykn.app?subject=Connection%20request"
                  className="underline underline-offset-2 hover:text-black/90 dark:hover:text-white"
                >
                  Request a connection
                </a>{" "}
                and we'll prioritize it.{" "}
                <span className="opacity-70">
                  We're also building Model Context Protocol (MCP) support so any
                  MCP server becomes a vault source — that's the long‑tail
                  answer.
                </span>
              </>
            ) : (
              <>
                Have a skill in mind we don't show yet?{" "}
                <a
                  href="mailto:hello@lykn.app?subject=Skill%20request"
                  className="underline underline-offset-2 hover:text-black/90 dark:hover:text-white"
                >
                  Tell us what you'd want
                </a>
                .{" "}
                <span className="opacity-70">
                  Skills run in chat, in the canvas, on vault items, and (soon)
                  as automated triggers when content changes.
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <BookmarkletDialog
        open={bookmarkletOpen}
        onOpenChange={setBookmarkletOpen}
      />
      <RssDialog open={rssOpen} onOpenChange={setRssOpen} />
      <OAuthConnectDialog
        open={!!oauthConnector}
        onOpenChange={(v) => {
          if (!v) {
            setOauthConnector(null);
            // Pull the latest server state so the grid pill reflects any
            // connect / disconnect / pause action the user took inside
            // the dialog.
            refreshConnections();
          }
        }}
        connector={oauthConnector}
      />
      <TokenConnectDialog
        open={!!tokenConnector}
        onOpenChange={(v) => {
          if (!v) {
            setTokenConnector(null);
            refreshConnections();
          }
        }}
        connector={tokenConnector}
      />
    </div>
  );
}

function CategoryHeader({ cat, count }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <div>
        <h2 className="text-[15px] font-semibold text-black/85 dark:text-white/90">
          {cat.label}
        </h2>
        <p className="text-[11.5px] text-black/50 dark:text-white/50 mt-0.5">
          {cat.description}
        </p>
      </div>
      <span className="text-[11px] text-black/40 dark:text-white/40">{count}</span>
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/15 bg-white/30 dark:bg-zinc-900/30 p-10 text-center">
      <Filter className="h-5 w-5 text-black/35 dark:text-white/35 mx-auto" />
      <p className="mt-2 text-[13px] text-black/55 dark:text-white/55">
        {message}
      </p>
    </div>
  );
}
