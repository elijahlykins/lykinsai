import { useState } from "react";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeConnectionsSubwindowProps {
  active: boolean;
  preload?: boolean;
}

interface AppDef {
  name: string;
  domain: string;
  type: string;
  connected?: boolean;
}

// Curated, recognizable lineup for the marketing preview. The real
// Connections page renders the full catalog (OUTBOUND_TARGETS + CONNECTORS);
// here we hand-pick the headliners so the grid reads cleanly at a glance.
const AI_TOOLS: AppDef[] = [
  { name: "Claude", domain: "claude.ai", type: "AI tool", connected: true },
  { name: "ChatGPT", domain: "openai.com", type: "AI tool" },
  { name: "Cursor", domain: "cursor.com", type: "AI tool", connected: true },
  { name: "Gemini", domain: "gemini.google.com", type: "AI tool" },
  { name: "GitHub Copilot", domain: "github.com", type: "AI tool" },
  { name: "Windsurf", domain: "windsurf.com", type: "AI tool" },
];

const YOUR_APPS: AppDef[] = [
  { name: "Gmail", domain: "mail.google.com", type: "Input", connected: true },
  { name: "Google Calendar", domain: "calendar.google.com", type: "Input", connected: true },
  { name: "Notion", domain: "notion.so", type: "Input" },
  { name: "Slack", domain: "slack.com", type: "Input" },
  { name: "Google Drive", domain: "drive.google.com", type: "Input" },
  { name: "Linear", domain: "linear.app", type: "Input" },
];

function AppFavicon({ domain, name }: { domain: string; name: string }) {
  const [attempt, setAttempt] = useState(0);
  const candidates = [
    `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
  if (attempt >= candidates.length) {
    return <ShieldAlert className="h-4 w-4 text-black/55" strokeWidth={1.75} />;
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${name} logo`}
      width={20}
      height={20}
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((a) => a + 1)}
      className="block object-contain"
      style={{ width: 20, height: 20 }}
    />
  );
}

function AppTile({ app }: { app: AppDef }) {
  return (
    <div className="group relative rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md p-2.5 flex flex-col gap-1.5 shadow-sm">
      <div className="flex items-start gap-2">
        <div className="h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-white ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
          <AppFavicon domain={app.domain} name={app.name} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[12px] font-semibold text-white/90 truncate">{app.name}</h3>
            {app.connected && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-500/20 bg-emerald-500/12 px-1.5 py-[1px] text-[9px] font-medium text-emerald-400">
                <CheckCircle2 className="h-2 w-2" />
                Connected
              </span>
            )}
          </div>
        </div>
        <span
          className={`flex-shrink-0 text-[10px] font-medium rounded-full px-2 py-[3px] ${
            app.connected
              ? "border border-white/15 text-white/70"
              : "bg-white text-black"
          }`}
        >
          {app.connected ? "Manage" : "Connect"}
        </span>
      </div>
      <p className="text-[10.5px] leading-snug text-white/45 pl-9">{app.type}</p>
    </div>
  );
}

function ConnectionsPreview() {
  return (
    <div className="h-full w-full overflow-hidden p-5 text-white">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold text-white/95">Connections</h1>
        <p className="mt-1 text-[13px] text-white/55">
          Sync and manage every app in one place. Your context follows you into
          every AI tool, so you never start over.
        </p>
      </div>

      <div className="mb-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/50">
          Use LYKN inside your AI tools
        </h2>
        <p className="mt-0.5 text-[11.5px] text-white/40">
          Your synthesis layer follows you into Claude, ChatGPT, Cursor and any
          MCP-aware client.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
        {AI_TOOLS.map((app) => (
          <AppTile key={app.name} app={app} />
        ))}
      </div>

      <div className="mb-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/50">
          Sync your apps
        </h2>
        <p className="mt-0.5 text-[11.5px] text-white/40">
          Connect the tools you already use and LYKN turns them into living
          memory.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {YOUR_APPS.map((app) => (
          <AppTile key={app.name} app={app} />
        ))}
      </div>
    </div>
  );
}

export default function WakeConnectionsSubwindow({
  active,
  preload = false,
}: WakeConnectionsSubwindowProps) {
  const showPreview = preload || active;

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">Connections</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? (
          <WakePreviewFit designWidth={640}>
            <ConnectionsPreview />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
