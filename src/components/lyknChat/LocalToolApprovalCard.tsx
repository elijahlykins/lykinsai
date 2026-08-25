import { useEffect, useRef, useState } from "react";
import { HardDrive, TerminalSquare, FilePlus, FilePen } from "lucide-react";
import {
  subscribeLocalApprovals,
  resolveLocalApproval,
  type LocalApprovalRequest,
} from "@/lib/ai/localToolApproval";

/**
 * Inline approval card for Local Mode actions — file access, writes, and
 * terminal commands. Renders inside the chat message flow (not a modal) while
 * the agent loop is paused waiting for the user's decision. FIFO queue: if
 * parallel tool calls raise several approvals, they show one at a time so no
 * request's resolver is orphaned.
 */
export default function LocalToolApprovalCard() {
  const [queue, setQueue] = useState<LocalApprovalRequest[]>([]);
  const req = queue[0] ?? null;
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => subscribeLocalApprovals((next) => setQueue((q) => [...q, next])),
    [],
  );

  // The card appears mid-stream at the bottom of the thread — make sure the
  // user actually sees it instead of it hiding below the fold.
  useEffect(() => {
    if (req) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [req]);

  if (!req) return null;

  const decide = (approved: boolean) => {
    resolveLocalApproval(req.id, approved);
    setQueue((q) => q.slice(1));
  };

  const isCommand = req.tool === "local_run_command";
  const isRead = [
    "local_list_dir",
    "local_read_file",
    "local_search_files",
    "local_pull_file",
  ].includes(req.tool);
  const Icon = isCommand
    ? TerminalSquare
    : req.tool === "local_write_file"
      ? FilePlus
      : req.tool === "local_edit_file"
        ? FilePen
        : HardDrive;
  const title = isCommand ? "Run this command?" : isRead ? "Allow file access?" : "Allow this change?";

  return (
    <div ref={cardRef} className="flex justify-start my-3">
      <div className="w-full max-w-[min(100%,28rem)] rounded-2xl border border-blue-400/30 bg-blue-500/[0.04] dark:bg-blue-400/[0.06] shadow-sm px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-black/85 dark:text-white/90">
          <Icon className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          {title}
        </div>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/[0.05] dark:bg-white/[0.06] px-3 py-2 text-[0.8125rem] font-mono text-black/80 dark:text-white/80 max-h-40 overflow-auto">
          {req.summary}
        </pre>
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => decide(false)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium bg-black text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
          >
            Approve
          </button>
        </div>
        {queue.length > 1 && (
          <div className="mt-1.5 text-[0.6875rem] text-black/45 dark:text-white/45">
            {queue.length - 1} more waiting
          </div>
        )}
      </div>
    </div>
  );
}
