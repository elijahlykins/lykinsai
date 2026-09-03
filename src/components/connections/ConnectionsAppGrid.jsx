import { useState } from "react";
import { CalendarDays, Link2, Plug, PlugZap } from "lucide-react";
import { useNavigate } from "react-router-dom";

import ManagedConnectionsSection from "@/components/connections/ManagedConnectionsSection";
import McpConnectionsPanel from "@/components/connections/McpConnectionsPanel";
import RemoteTargetsSection from "@/components/connections/RemoteTargetsSection";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EXTERNAL_CALENDAR_SYNC_ENABLED } from "@/lib/calendar/calendarConfig";
import { remoteTargetsAvailable } from "@/lib/remote/remoteTargetsClient";

export default function ConnectionsAppGrid({
  user,
  wakePreview = false,
  onWakePreviewTabChange,
  embedded = false,
}) {
  const navigate = useNavigate();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);

  return (
    <section className={embedded ? "space-y-5" : "mx-auto max-w-5xl space-y-6 p-6"}>
      <div>
        <div className="flex items-center gap-2">
          <PlugZap className="h-4 w-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-black dark:text-white">
            Connections
          </h2>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-black/50 dark:text-white/50">
          Connect the apps LYKN can work with. External data stays in its source
          unless you explicitly save it.
        </p>
      </div>

      <ManagedConnectionsSection user={user} />

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
          Specialized
        </h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <ConnectionCard
            icon={Plug}
            title="MCP servers"
            description="Connect any MCP server by URL. Remote servers use HTTPS; sign-in runs through the server's own OAuth."
            action="Manage"
            onClick={() => setMcpOpen(true)}
          />
          {EXTERNAL_CALENDAR_SYNC_ENABLED && (
            <ConnectionCard
              icon={CalendarDays}
              title="Calendars"
              description="Google Calendar and Apple iCloud, imported read-only into the LYKN calendar."
              action="Manage"
              onClick={() => navigate("/calendar?sync=1")}
            />
          )}
          {remoteTargetsAvailable() && (
            <ConnectionCard
              icon={Link2}
              title="Remote targets"
              description="Saved SSH hosts LYKN can operate on. Auth uses your system SSH agent and keys - no credentials stored."
              action="Manage"
              onClick={() => setRemoteOpen(true)}
            />
          )}
        </div>
      </div>

      {wakePreview && (
        <div className="flex justify-end">
          <VaultConnectionsToggle
            active="connections"
            onPreviewTabChange={onWakePreviewTabChange}
          />
        </div>
      )}

      <Dialog open={mcpOpen} onOpenChange={setMcpOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogTitle className="sr-only">MCP servers</DialogTitle>
          <div id="mcp-connections">
            <McpConnectionsPanel user={user} embedded />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogTitle className="sr-only">Remote targets</DialogTitle>
          <RemoteTargetsSection />
        </DialogContent>
      </Dialog>
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
