import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  EXECUTION_KIND_LABELS,
  STEWARD_COLUMN_LABELS,
  createStewardItem,
  updateStewardItem,
} from "@/lib/stewardQueue";

const COLUMNS = ["backlog", "ready", "scheduled", "running", "done", "blocked"];
const EXECUTION_KINDS = ["research", "code", "agent"];

/**
 * Kanban board for Night Shift steward queue on the project detail page.
 */
export default function StewardKanban({
  userId,
  projectId,
  items,
  canEdit,
  onChanged,
  embedded = false,
}) {
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const byColumn = useMemo(() => {
    const map = {};
    for (const col of COLUMNS) map[col] = [];
    for (const item of items) {
      if (map[item.status]) map[item.status].push(item);
    }
    return map;
  }, [items]);

  const addItem = async () => {
    const title = newTitle.trim();
    if (!title || busy || !canEdit) return;
    setBusy(true);
    try {
      const created = await createStewardItem(userId, projectId, title);
      if (created) {
        setNewTitle("");
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const moveItem = async (id, status, extra) => {
    if (busy || !canEdit) return;
    setBusy(true);
    try {
      const updated = await updateStewardItem(userId, id, { status, ...extra });
      if (updated) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const setExecutionKind = async (id, executionKind) => {
    if (busy || !canEdit) return;
    setBusy(true);
    try {
      const updated = await updateStewardItem(userId, id, { executionKind });
      if (updated) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <>
      {!embedded ? (
        <>
          <h2 className="text-base font-semibold tracking-tight text-black/90 dark:text-white/90 mb-1">
            Night Shift queue
          </h2>
          <p className="text-xs text-black/50 dark:text-white/50 mb-4 leading-relaxed">
            Drop ideas in Backlog. Overnight, LYKN expands them to Ready. Approve to Schedule. In Delegate mode, items can run as research, Cursor builds, or sub-agent tasks.
          </p>
        </>
      ) : (
        <>
          <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/45 dark:text-white/45 mb-1">
            Queue
          </p>
          <p className="text-xs text-black/50 dark:text-white/50 mb-4 leading-relaxed">
            Drop ideas in Backlog. Overnight, LYKN expands them to Ready. Approve to Schedule for the next run.
          </p>
        </>
      )}

      {canEdit ? (
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addItem();
            }}
            placeholder="Queue overnight work…"
            maxLength={280}
            className="flex-1 min-w-0 text-sm px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/[0.04] outline-none focus:border-blue-500/40 placeholder:text-black/35 dark:placeholder:text-white/35"
          />
          <button
            type="button"
            disabled={busy || !newTitle.trim()}
            onClick={() => void addItem()}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85 transition-colors disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 items-start">
        {COLUMNS.map((col) => (
          <div
            key={col}
            className="min-w-0 rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-black/[0.02] dark:bg-white/[0.02] p-2"
          >
            <p className="text-[0.58rem] uppercase tracking-[0.14em] font-semibold text-black/45 dark:text-white/45 mb-2">
              {STEWARD_COLUMN_LABELS[col] || col} ({byColumn[col]?.length || 0})
            </p>
            {/* Visible scrollbar + taller cap so overflowed cards are
                discoverable (scrollbar-hide at max-h-56 hid everything past
                ~3 cards with zero affordance). */}
            <div className="space-y-2 max-h-80 overflow-y-auto pr-0.5">
              {(byColumn[col] || []).map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-white/80 dark:bg-white/[0.03] p-2"
                >
                  <div className="flex items-start justify-between gap-1">
                    <p className="text-xs font-medium text-black/85 dark:text-white/88 leading-snug">
                      {item.title}
                    </p>
                    {item.executionKind !== "research" || col === "ready" || col === "scheduled" ? (
                      <span className="shrink-0 text-[0.55rem] uppercase tracking-wide font-semibold rounded px-1 py-0.5 bg-black/[0.05] dark:bg-white/[0.08] text-black/55 dark:text-white/55">
                        {EXECUTION_KIND_LABELS[item.executionKind]}
                      </span>
                    ) : null}
                  </div>
                  {item.spec ? (
                    <p className="mt-1 text-[0.68rem] text-black/55 dark:text-white/55 line-clamp-4 whitespace-pre-wrap">
                      {item.spec}
                    </p>
                  ) : null}
                  {item.repo ? (
                    <p className="mt-1 text-[0.62rem] text-black/45 dark:text-white/45 truncate">
                      {item.repo}
                    </p>
                  ) : null}
                  {item.resultSummary && col === "done" ? (
                    <p className="mt-1 text-[0.68rem] text-black/60 dark:text-white/60 line-clamp-3 whitespace-pre-wrap">
                      {item.resultSummary}
                    </p>
                  ) : null}
                  {item.blockedReason ? (
                    <p className="mt-1 text-[0.68rem] text-amber-700 dark:text-amber-300">
                      {item.blockedReason}
                    </p>
                  ) : null}
                  {canEdit && col === "ready" ? (
                    <div className="mt-2 space-y-2">
                      <select
                        value={item.executionKind}
                        disabled={busy}
                        onChange={(e) => void setExecutionKind(item.id, e.target.value)}
                        className="w-full text-[0.62rem] rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] px-1.5 py-1 outline-none focus:border-blue-500/40"
                      >
                        {EXECUTION_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {EXECUTION_KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void moveItem(item.id, "scheduled")}
                          className="text-[0.62rem] font-semibold rounded-full px-2.5 py-1 bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85 disabled:opacity-40"
                        >
                          Schedule tonight
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void moveItem(item.id, "backlog")}
                          className="text-[0.62rem] rounded-full px-2.5 py-1 border border-black/10 dark:border-white/15 text-black/60 dark:text-white/60"
                        >
                          Back
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {canEdit && col === "scheduled" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void moveItem(item.id, "ready")}
                      className="mt-2 text-[0.62rem] rounded-full px-2.5 py-1 border border-black/10 dark:border-white/15 text-black/60 dark:text-white/60"
                    >
                      Unschedule
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );

  if (embedded) return content;

  return (
    <section className="rounded-[1.75rem] border border-black/[0.05] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_12px_32px_-16px_rgba(0,0,0,0.6)] p-4 sm:p-5">
      {content}
    </section>
  );
}
