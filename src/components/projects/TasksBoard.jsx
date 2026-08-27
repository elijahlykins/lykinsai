import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, Circle, Trash2 } from "lucide-react";

// A Kanban view over the project's tasks (lykn_todos) that maps onto the
// existing schema — no new status value. Columns are the three priority
// swimlanes plus Done:
//   • Dragging a card between High / Normal / Low updates its priority.
//   • Dragging a card into Done completes it; dragging it back out reopens it
//     (landing in whichever priority column it was dropped on).
//   • Reordering within a column persists to the unused `position` field so
//     the manual order survives reloads and is shared with the todo pop-up.
//
// Uses native HTML5 drag-and-drop so it stays dependency-free.

const COLUMNS = [
  { key: "high", label: "High", accent: "text-red-500", dot: "bg-red-500" },
  { key: "normal", label: "Normal", accent: "text-blue-500 dark:text-blue-400", dot: "bg-blue-500 dark:bg-blue-400" },
  { key: "low", label: "Low", accent: "text-black/40 dark:text-white/40", dot: "bg-black/25 dark:bg-white/30" },
  { key: "done", label: "Done", accent: "text-emerald-500 dark:text-emerald-400", dot: "bg-emerald-500" },
];

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// The column a task currently lives in: completed tasks are always in Done,
// everything else falls into its priority swimlane.
function columnOf(todo) {
  if (todo.status === "completed") return "done";
  return todo.priority === "high" || todo.priority === "low" ? todo.priority : "normal";
}

// Fractional index for a card dropped at `index` within an ordered list, so a
// single move doesn't require renumbering siblings. Sorted list is passed in.
function positionForDrop(sorted, index) {
  const posAt = (i) => {
    const t = sorted[i];
    if (!t) return null;
    return typeof t.position === "number" ? t.position : null;
  };
  const before = posAt(index - 1);
  const after = posAt(index);
  if (before == null && after == null) return Date.now();
  if (before == null) return after - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

export default function TasksBoard({
  todos,
  canEdit = true,
  onSetPriority,
  onSetStatus,
  onSetPosition,
  onDelete,
}) {
  const now = Date.now();
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);

  // Bucket + sort each column: manual position first (nulls last), then
  // due date, then newest — matching the list view's intent.
  const byColumn = useMemo(() => {
    const map = { high: [], normal: [], low: [], done: [] };
    for (const t of todos) {
      const col = columnOf(t);
      if (map[col]) map[col].push(t);
    }
    const sortOpen = (a, b) => {
      const pa = a.position == null ? Infinity : a.position;
      const pb = b.position == null ? Infinity : b.position;
      if (pa !== pb) return pa - pb;
      const da = a.dueAt ?? Infinity;
      const db = b.dueAt ?? Infinity;
      if (da !== db) return da - db;
      return b.createdAt - a.createdAt;
    };
    for (const key of ["high", "normal", "low"]) map[key].sort(sortOpen);
    map.done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return map;
  }, [todos]);

  const handleDrop = (colKey) => {
    setOverCol(null);
    const id = dragId;
    setDragId(null);
    if (!id || !canEdit) return;
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    const from = columnOf(todo);

    if (colKey === "done") {
      if (todo.status !== "completed") void onSetStatus(todo, "completed");
      return;
    }

    // Landed in a priority column: reopen if it was done, and/or re-prioritise.
    if (todo.status === "completed") void onSetStatus(todo, "open");
    if (todo.priority !== colKey) void onSetPriority(todo, colKey);

    // Same-column drop: leave the card where it is. Drops target the whole
    // column (no per-card slots yet), so appending here made a card dragged
    // two slots up jump to the bottom instead.
    if (from === colKey && todo.status !== "completed") return;

    // Append to the end of the destination column (drop-on-column).
    const dest = byColumn[colKey].filter((t) => t.id !== id);
    const pos = positionForDrop(dest, dest.length);
    void onSetPosition(todo, pos);
  };

  const renderCard = (todo) => {
    const done = todo.status === "completed";
    const overdue = !done && todo.dueAt != null && todo.dueAt <= now;
    const dueDate = todo.dueAt != null ? new Date(todo.dueAt) : null;
    const hasDue = dueDate && !Number.isNaN(dueDate.getTime());
    return (
      <div
        key={todo.id}
        draggable={canEdit}
        onDragStart={(e) => {
          setDragId(todo.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          setDragId(null);
          setOverCol(null);
        }}
        className={`group rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-white/85 dark:bg-white/[0.03] p-2.5 transition-shadow ${
          canEdit ? "cursor-grab active:cursor-grabbing hover:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.12)]" : ""
        } ${dragId === todo.id ? "opacity-40" : ""}`}
      >
        <div className="flex items-start gap-2">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => onSetStatus(todo, done ? "open" : "completed")}
            className="mt-0.5 shrink-0 text-black/30 dark:text-white/30 hover:text-emerald-500 transition-colors disabled:opacity-50"
            title={done ? "Reopen" : "Mark done"}
          >
            {done ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <Circle className="w-4 h-4" />
            )}
          </button>
          <p
            className={`min-w-0 flex-1 text-xs leading-snug break-words ${
              done ? "line-through text-black/35 dark:text-white/35" : "text-black/85 dark:text-white/90"
            }`}
          >
            {todo.title}
          </p>
          {canEdit && (
            <button
              type="button"
              onClick={() => onDelete(todo)}
              className="shrink-0 p-0.5 rounded text-black/30 dark:text-white/30 hover:text-red-500 hover-reveal transition-all"
              title="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        {hasDue && (
          <div className="mt-1.5 pl-6">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide tabular-nums ${
                overdue
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-500"
              }`}
            >
              <CalendarClock className="w-2.5 h-2.5" />
              {`${MONTH_ABBR[dueDate.getMonth()]} ${String(dueDate.getDate()).padStart(2, "0")}`}
            </span>
          </div>
        )}
      </div>
    );
  };

  // The board lives inside the half-width "Todo list" card (the page puts it
  // beside Messages & AI updates on lg+), so four side-by-side columns get
  // crushed to ~120px each — viewport breakpoints can't see the container.
  // A 2×2 grid (High/Normal over Low/Done) keeps every column wide enough
  // for real card text at any size; phones stack to a single column.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-start">
      {COLUMNS.map((col) => {
        const cards = byColumn[col.key] || [];
        const isOver = overCol === col.key;
        return (
          <div
            key={col.key}
            onDragOver={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overCol !== col.key) setOverCol(col.key);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget)) return;
              if (overCol === col.key) setOverCol(null);
            }}
            onDrop={() => handleDrop(col.key)}
            className={`min-w-0 rounded-2xl border p-2 transition-colors ${
              isOver
                ? "border-blue-500/40 bg-blue-500/[0.06]"
                : "border-black/[0.06] dark:border-white/[0.07] bg-black/[0.02] dark:bg-white/[0.02]"
            }`}
          >
            <div className="flex items-center gap-1.5 px-1 mb-2">
              <span className={`w-1.5 h-1.5 rounded-full ${col.dot}`} />
              <p className={`text-[0.6rem] uppercase tracking-[0.14em] font-semibold ${col.accent}`}>
                {col.label}
              </p>
              <span className="text-[0.6rem] text-black/35 dark:text-white/35">{cards.length}</span>
            </div>
            <div className="space-y-2 min-h-[3rem] max-h-[26rem] overflow-y-auto scrollbar-hide">
              {cards.length === 0 ? (
                <p className="text-[0.65rem] text-black/25 dark:text-white/25 text-center py-4">
                  {canEdit ? "Drop here" : "Empty"}
                </p>
              ) : (
                cards.map(renderCard)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
