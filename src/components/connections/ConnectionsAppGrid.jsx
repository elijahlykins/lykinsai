import { useState } from "react";
import { CalendarDays, Code2, DatabaseZap, Link2, PlugZap } from "lucide-react";
import { useNavigate } from "react-router-dom";

import CustomApiDialog from "@/components/connections/CustomApiDialog";
import CursorCredentialDialog from "@/components/connections/CursorCredentialDialog";
import McpConnectionsPanel from "@/components/connections/McpConnectionsPanel";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";

export default function ConnectionsAppGrid({
  user,
  wakePreview = false,
  onWakePreviewTabChange,
  embedded = false,
}) {
  const navigate = useNavigate();
  const [customApiOpen, setCustomApiOpen] = useState(false);
  const [cursorOpen, setCursorOpen] = useState(false);

  return (
    <section className={embedded ? "space-y-5" : "mx-auto max-w-5xl space-y-6 p-6"}>
      <div>
        <div className="flex items-center gap-2">
          <PlugZap className="h-4 w-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-black dark:text-white">
            External connections
          </h2>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-black/50 dark:text-white/50">
          Connect authoritative apps for live access. External data stays in its source
          unless you explicitly save something to Vault.
        </p>
      </div>

      {user && (
        <div id="mcp-connections">
          <McpConnectionsPanel user={user} embedded={embedded} />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <ConnectionCard
          icon={CalendarDays}
          title="Calendars"
          description="Google Calendar and Apple iCloud, imported read-only into the LYKN calendar."
          action="Manage"
          onClick={() => navigate("/calendar?sync=1")}
        />
        <ConnectionCard
          icon={Code2}
          title="Cursor Cloud"
          description="Use your encrypted Cursor API key for cloud-agent builds and pull requests."
          action="Manage"
          onClick={() => setCursorOpen(true)}
        />
        <ConnectionCard
          icon={DatabaseZap}
          title="Custom API"
          description="Call an API you control with a server-injected key and explicit write policy."
          action="Configure"
          onClick={() => setCustomApiOpen(true)}
        />
        <ConnectionCard
          icon={Link2}
          title="More apps"
          description="Add any standards-compliant MCP server by URL without provider-specific LYKN code."
          action="Add above"
          onClick={() => document.getElementById("mcp-connections")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          })}
        />
      </div>

      {wakePreview && (
        <div className="flex justify-end">
          <VaultConnectionsToggle
            active="connections"
            onPreviewTabChange={onWakePreviewTabChange}
          />
        </div>
      )}

      <CursorCredentialDialog open={cursorOpen} onOpenChange={setCursorOpen} />
      <CustomApiDialog
        open={customApiOpen}
        initialPresetId={null}
        onOpenChange={setCustomApiOpen}
      />
    </section>
  );
}

function ConnectionCard({ icon: Icon, title, description, action, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-28 items-start gap-3 rounded-2xl border border-black/[0.08] bg-black/[0.02] p-4 text-left transition hover:-translate-y-px hover:border-black/15 hover:bg-black/[0.04] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/20 dark:hover:bg-white/[0.06]"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-white text-black shadow-sm ring-1 ring-black/[0.06] dark:bg-white/10 dark:text-white dark:ring-white/10">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-black dark:text-white">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-black/48 dark:text-white/48">
          {description}
        </span>
        <span className="mt-2 block text-[11px] font-medium text-blue-600 dark:text-blue-400">
          {action}
        </span>
      </span>
    </button>
  );
}
