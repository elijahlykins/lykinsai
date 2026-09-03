import { useEffect, useRef, useState } from "react";
import { AppWindow, HardDrive, TerminalSquare, FilePlus, FilePen } from "lucide-react";
import {
  subscribeLocalApprovals,
  resolveLocalApproval,
  type LocalApprovalRequest,
  type McpApprovalDetail,
} from "@/lib/ai/localToolApproval";

const READ_TOOLS = new Set([
  "local_list_dir",
  "local_read_file",
  "local_search_files",
  "local_pull_file",
]);

function approvalTitle(tool: string): string {
  if (tool === "local_run_command") return "Run this command?";
  if (tool === "browser") return "Go ahead?";
  if (tool === "mcp_approval") return "Approve this app action?";
  if (READ_TOOLS.has(tool)) return "Allow file access?";
  return "Allow this change?";
}

function ApprovalIcon({ tool }: { tool: string }) {
  const Icon =
    tool === "local_run_command"
      ? TerminalSquare
      : tool === "local_write_file"
        ? FilePlus
        : tool === "local_edit_file"
          ? FilePen
          : tool === "mcp_approval"
            ? AppWindow
            : HardDrive;
  return <Icon className="w-4 h-4 text-blue-600 dark:text-blue-400" />;
}

/** Shared Approve / Decline card used by LYKN and bot agents. */
export function LocalApprovalPanel({
  tool,
  summary,
  extra = "",
  onDecide,
}: {
  tool: string;
  summary: string;
  extra?: string;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="w-full max-w-[min(100%,28rem)] rounded-2xl border border-blue-400/30 bg-blue-500/[0.04] dark:bg-blue-400/[0.06] shadow-sm px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-black/85 dark:text-white/90">
        <ApprovalIcon tool={tool} />
        {approvalTitle(tool)}
      </div>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/[0.05] dark:bg-white/[0.06] px-3 py-2 text-[0.8125rem] font-mono text-black/80 dark:text-white/80 max-h-40 overflow-auto">
        {summary}
      </pre>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onDecide(false)}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
        >
          Decline
        </button>
        <button
          type="button"
          onClick={() => onDecide(true)}
          className="rounded-lg px-3 py-1.5 text-sm font-medium bg-black text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
        >
          Approve
        </button>
      </div>
      {extra ? (
        <div className="mt-1.5 text-[0.6875rem] text-black/45 dark:text-white/45">{extra}</div>
      ) : null}
    </div>
  );
}

// ─── Connected-app (MCP) approval: show WHAT will be sent, one confirm ──────

/** Keys whose value is the outgoing message body — written out in full. */
const BODY_KEYS = new Set([
  "body",
  "message",
  "text",
  "content",
  "message_body",
  "description",
  "html_body",
]);
/** Keys skipped in the preview (transport flags, not user content). */
const HIDDEN_KEYS = new Set(["is_html", "user_id", "thread_id", "format"]);

/** Raw API arg names → natural labels. */
const LABEL_MAP: Record<string, string> = {
  to: "To",
  recipient: "To",
  recipient_email: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  title: "Title",
  event_title: "Title",
  summary: "Title",
  start_time: "Starts",
  end_time: "Ends",
  channel: "Channel",
  attendees: "Attendees",
};

function fieldLabel(key: string): string {
  const mapped = LABEL_MAP[key.toLowerCase()];
  if (mapped) return mapped;
  const cleaned = key.replace(/[_-]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function fieldValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Best-effort readable text when the model composed an HTML body. */
function stripHtml(text: string): string {
  if (!/<[a-z][^>]*>/i.test(text)) return text;
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Compact confirm card for a consequential connected-app action. The outgoing
 * content (recipient, subject, message) is written out in full so the user
 * confirms the actual thing being sent, with one primary button.
 */
function McpApprovalPanel({
  detail,
  extra = "",
  onDecide,
}: {
  detail: McpApprovalDetail;
  extra?: string;
  onDecide: (approved: boolean) => void;
}) {
  const args =
    detail.arguments && typeof detail.arguments === "object"
      ? (detail.arguments as Record<string, unknown>)
      : {};
  const fields: Array<{ label: string; value: string }> = [];
  let bodyText = "";
  for (const [key, raw] of Object.entries(args)) {
    const k = key.toLowerCase();
    if (HIDDEN_KEYS.has(k) || typeof raw === "boolean") continue;
    const value = fieldValue(raw).trim();
    if (!value || value === "[redacted]") continue;
    if (BODY_KEYS.has(k)) {
      if (!bodyText) bodyText = stripHtml(value);
      continue;
    }
    fields.push({ label: fieldLabel(key), value });
  }
  const app = String(detail.connectionName || "Connected app");
  const account = String(detail.accountIdentity || detail.accountLabel || "");
  const confirmLabel =
    (Array.isArray(detail.actions) &&
      detail.actions.find((a) => a.id === "approve")?.label) ||
    "Confirm";

  return (
    <div className="w-full max-w-[min(100%,26rem)] rounded-xl border border-black/10 dark:border-white/12 bg-white dark:bg-neutral-900 shadow-sm overflow-hidden">
      <div className="px-4 pt-3 text-xs font-medium text-black/45 dark:text-white/45">
        {app}
        {account ? ` · ${account}` : ""}
      </div>
      <div className="px-4 pt-1.5 pb-3">
        {fields.map(({ label, value }) => (
          <div key={label} className="flex gap-2 py-0.5 text-sm">
            <span className="shrink-0 w-16 text-black/45 dark:text-white/45">{label}</span>
            <span className="min-w-0 break-words text-black/85 dark:text-white/90">{value}</span>
          </div>
        ))}
        {bodyText ? (
          <div
            className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-black/80 dark:text-white/85 max-h-56 overflow-auto${fields.length ? " mt-2 pt-2 border-t border-black/[0.06] dark:border-white/[0.08]" : ""}`}
          >
            {bodyText}
          </div>
        ) : null}
        {!fields.length && !bodyText ? (
          <div className="text-sm text-black/70 dark:text-white/75">
            {detail.title || "Confirm this action?"}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03]">
        {extra ? (
          <span className="mr-auto text-[0.6875rem] text-black/40 dark:text-white/40">{extra}</span>
        ) : null}
        <button
          type="button"
          onClick={() => onDecide(false)}
          className="rounded-lg px-2.5 py-1 text-[0.8125rem] text-black/50 dark:text-white/50 hover:text-black/75 dark:hover:text-white/80 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onDecide(true)}
          className="rounded-lg px-4 py-1.5 text-[0.8125rem] font-semibold bg-black text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

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

  const extra = queue.length > 1 ? `${queue.length - 1} more waiting` : "";
  return (
    <div ref={cardRef} className="flex justify-start my-3">
      {req.detail ? (
        <McpApprovalPanel detail={req.detail} extra={extra} onDecide={decide} />
      ) : (
        <LocalApprovalPanel
          tool={req.tool}
          summary={req.summary}
          extra={extra}
          onDecide={decide}
        />
      )}
    </div>
  );
}
