import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Flag,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";

// ────────────────────────────────────────────────────────────────────────
// LyknTodosPanel — the to-do list body (add form + list + footer), with NO
// Dialog wrapper. It owns its own data: reads/writes the user's lykn_todos
// rows through the RLS-protected Supabase client and subscribes to realtime
// so tasks the AI adds / completes in text or voice appear live. Hosted by
// both the standalone LyknTodosDialog and the combined LyknCalendarDialog
// (under its Calendar / To-dos toggle). Loads only while `active`.
// ────────────────────────────────────────────────────────────────────────

const PRIORITY_META = {
  high: { label: "High", dot: "bg-red-500", text: "text-red-500" },
  normal: { label: "Normal", dot: "bg-blue-400", text: "text-blue-400" },
  low: { label: "Low", dot: "bg-white/30", text: "text-white/40" },
};
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

// A YYYY-MM-DD date-input value → an ISO instant at end of that local day, so
// "due Friday" means any time on Friday still counts as on-time.
function dateInputToIso(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function dueLabel(todo) {
  if (todo.due_at_text) return todo.due_at_text;
  if (!todo.due_at) return "";
  const d = new Date(todo.due_at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function LyknTodosPanel({ active = true }) {
  const { user } = useAuth();
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Add-form state.
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPriority, setDraftPriority] = useState("normal");
  const [draftDue, setDraftDue] = useState("");
  const [adding, setAdding] = useState(false);
  const titleRef = useRef(null);

  const loadTodos = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    const statuses = showDone
      ? ["open", "completed"]
      : ["open"];
    const { data, error } = await supabase
      .from("lykn_todos")
      .select("id, title, notes, status, priority, due_at, due_at_text, position, created_at, completed_at")
      .eq("user_id", user.id)
      .in("status", statuses)
      .order("created_at", { ascending: false });
    if (!error) setTodos(data || []);
    setLoading(false);
  }, [user?.id, showDone]);

  useEffect(() => {
    if (active) void loadTodos();
  }, [active, loadTodos]);

  // Realtime: reflect tasks the AI adds/completes in text/voice without a refresh.
  useEffect(() => {
    if (!active || !user?.id) return undefined;
    const channel = supabase
      .channel(`lykn-todos:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_todos", filter: `user_id=eq.${user.id}` },
        () => { void loadTodos(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [active, user?.id, loadTodos]);

  const now = Date.now();

  const { openTodos, doneTodos } = useMemo(() => {
    const openList = [];
    const doneList = [];
    for (const t of todos) {
      if (t.status === "completed") doneList.push(t);
      else openList.push(t);
    }
    openList.sort((a, b) => {
      const pa = a.position == null ? Infinity : a.position;
      const pb = b.position == null ? Infinity : b.position;
      if (pa !== pb) return pa - pb;
      const ra = PRIORITY_RANK[a.priority] ?? 1;
      const rb = PRIORITY_RANK[b.priority] ?? 1;
      if (ra !== rb) return ra - rb;
      const da = a.due_at ? Date.parse(a.due_at) : Infinity;
      const db = b.due_at ? Date.parse(b.due_at) : Infinity;
      if (da !== db) return da - db;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
    doneList.sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
    return { openTodos: openList, doneTodos: doneList };
  }, [todos]);

  const addTodo = useCallback(async () => {
    const title = draftTitle.trim();
    if (!title || !user?.id) return;
    setAdding(true);
    const dueIso = dateInputToIso(draftDue);
    const dueText = draftDue
      ? new Date(`${draftDue}T23:59:59`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : null;
    const { error } = await supabase.from("lykn_todos").insert({
      user_id: user.id,
      title: title.slice(0, 280),
      priority: draftPriority,
      due_at: dueIso,
      due_at_text: dueText,
      source: "todos-ui",
    });
    setAdding(false);
    if (error) {
      toast({ title: "Couldn't add task", description: error.message, variant: "destructive" });
      return;
    }
    setDraftTitle("");
    setDraftPriority("normal");
    setDraftDue("");
    titleRef.current?.focus();
    void loadTodos();
  }, [draftTitle, draftPriority, draftDue, user?.id, loadTodos]);

  const setStatus = useCallback(async (todo, status) => {
    setBusyId(todo.id);
    const patch = {
      status,
      completed_at: status === "completed" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    // Optimistic: drop completed/cancelled from the open view immediately.
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, ...patch } : t)));
    const { error } = await supabase
      .from("lykn_todos")
      .update(patch)
      .eq("id", todo.id)
      .eq("user_id", user.id);
    setBusyId(null);
    if (error) {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
      void loadTodos();
    } else if (status !== "open" && !showDone) {
      setTodos((prev) => prev.filter((t) => t.id !== todo.id));
    } else {
      void loadTodos();
    }
  }, [user?.id, loadTodos, showDone]);

  const removeTodo = useCallback(async (todo) => {
    setBusyId(todo.id);
    setTodos((prev) => prev.filter((t) => t.id !== todo.id));
    const { error } = await supabase
      .from("lykn_todos")
      .delete()
      .eq("id", todo.id)
      .eq("user_id", user.id);
    setBusyId(null);
    if (error) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      void loadTodos();
    }
  }, [user?.id, loadTodos]);

  const cyclePriority = useCallback(async (todo) => {
    const order = ["normal", "high", "low"];
    const next = order[(order.indexOf(todo.priority) + 1) % order.length] || "normal";
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, priority: next } : t)));
    const { error } = await supabase
      .from("lykn_todos")
      .update({ priority: next, updated_at: new Date().toISOString() })
      .eq("id", todo.id)
      .eq("user_id", user.id);
    if (error) void loadTodos();
  }, [user?.id, loadTodos]);

  const renderRow = (todo) => {
    const done = todo.status === "completed";
    const overdue = !done && todo.due_at != null && Date.parse(todo.due_at) <= now;
    const pri = PRIORITY_META[todo.priority] || PRIORITY_META.normal;
    const due = dueLabel(todo);
    const isBusy = busyId === todo.id;
    return (
      <div
        key={todo.id}
        className="group flex items-start gap-2.5 px-3 py-2.5 rounded-lg hover:bg-white/[0.03] transition-colors"
      >
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setStatus(todo, done ? "open" : "completed")}
          className="mt-0.5 shrink-0 text-white/40 hover:text-emerald-400 transition-colors disabled:opacity-50"
          title={done ? "Mark as not done" : "Mark done"}
        >
          {done ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          ) : (
            <Circle className="w-5 h-5" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className={`text-[0.875rem] leading-snug break-words ${done ? "line-through text-white/35" : "text-white/90"}`}>
            {todo.title}
          </div>
          {todo.notes ? (
            <div className={`text-[0.75rem] mt-0.5 break-words ${done ? "text-white/25" : "text-white/45"}`}>
              {todo.notes}
            </div>
          ) : null}
          <div className="flex items-center gap-2 mt-1">
            {due ? (
              <span className={`text-[0.6875rem] ${overdue ? "text-red-400 font-medium" : "text-white/40"}`}>
                {overdue ? "Overdue · " : "Due "}{due}
              </span>
            ) : null}
            {!done && todo.priority !== "normal" ? (
              <span className={`inline-flex items-center gap-1 text-[0.6875rem] ${pri.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${pri.dot}`} />
                {pri.label}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!done ? (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => cyclePriority(todo)}
              className="p-1 rounded-md text-white/35 hover:text-white/80 hover:bg-white/10 transition-colors disabled:opacity-50"
              title={`Priority: ${pri.label} (click to change)`}
            >
              <Flag className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setStatus(todo, "open")}
              className="p-1 rounded-md text-white/35 hover:text-white/80 hover:bg-white/10 transition-colors disabled:opacity-50"
              title="Reopen"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            disabled={isBusy}
            onClick={() => removeTodo(todo)}
            className="p-1 rounded-md text-white/35 hover:text-red-400 hover:bg-white/10 transition-colors disabled:opacity-50"
            title="Delete"
          >
            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col [color-scheme:dark]">
      {/* Add form */}
      <div className="flex flex-col gap-2 pb-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <input
            ref={titleRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void addTodo();
              }
            }}
            placeholder="Add a task…"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[0.875rem] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <button
            type="button"
            disabled={!draftTitle.trim() || adding}
            onClick={() => addTodo()}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-blue-500/90 hover:bg-blue-500 text-white text-[0.8125rem] font-medium transition-colors disabled:opacity-40"
          >
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add
          </button>
        </div>
        <div className="flex items-center gap-2 text-[0.75rem]">
          <select
            value={draftPriority}
            onChange={(e) => setDraftPriority(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-white/80 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            title="Priority"
          >
            <option value="low">Low priority</option>
            <option value="normal">Normal priority</option>
            <option value="high">High priority</option>
          </select>
          <input
            type="date"
            value={draftDue}
            onChange={(e) => setDraftDue(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-white/80 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            title="Optional due date"
          />
        </div>
      </div>

      {/* List */}
      <div className="overflow-y-auto -mx-2 px-2 py-1 min-h-[8rem] max-h-[55vh]">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-white/40">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : openTodos.length === 0 && doneTodos.length === 0 ? (
          <div className="text-center py-10 text-white/40 text-[0.8125rem]">
            Nothing on your list yet. Add a task above, or ask LYKN to.
          </div>
        ) : (
          <>
            {openTodos.length === 0 ? (
              <div className="text-center py-6 text-white/35 text-[0.8125rem]">
                All caught up — nothing open.
              </div>
            ) : (
              openTodos.map(renderRow)
            )}
            {showDone && doneTodos.length > 0 ? (
              <div className="mt-3 pt-2 border-t border-white/10">
                <div className="px-3 pb-1 text-[0.6875rem] uppercase tracking-wide text-white/30">
                  Completed
                </div>
                {doneTodos.map(renderRow)}
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-white/10 text-[0.75rem] text-white/40">
        <span>
          {openTodos.length} open{openTodos.length === 1 ? " task" : " tasks"}
        </span>
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          className="hover:text-white/80 transition-colors"
        >
          {showDone ? "Hide completed" : "Show completed"}
        </button>
      </div>
    </div>
  );
}
