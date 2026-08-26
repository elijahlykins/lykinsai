// LYKN Activity — the one place to see what your Bots are doing right now
// and what their routines have been up to. Running tasks can be stopped
// here, routines paused/run/deleted, and the recent-run history read at a
// glance. Data comes straight from the main-process activity snapshot
// (electron/ipc/routines.cjs) so this window agrees with notifications and
// the Bot pages by construction.
import { Pause, Play, Square, Trash2, Zap } from "lucide-react";
import {
  deleteRoutine,
  routinesAvailable,
  runRoutineNow,
  setRoutineEnabled,
  stopTask,
  useActivity,
} from "@/lib/routines/routinesClient";
import { RUN_STATUS_LABEL } from "@/components/bots/BotsPage";

function timeAgo(iso) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

export default function ActivityPanel() {
  const { tasks, routines, recentRuns } = useActivity();

  if (!routinesAvailable()) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-sm font-medium text-black/70 dark:text-white/80">
            Activity lives in the LYKN desktop shell
          </p>
          <p className="mt-1 text-xs text-black/45 dark:text-white/45">
            Bot tasks and routines run in the desktop agent runtime.
          </p>
        </div>
      </div>
    );
  }

  const routineName = (routineId) => routines.find((r) => r.id === routineId)?.name || "";
  const watching = routines.filter((r) => r.watching && !r.running);
  const runningTasks = tasks;

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-6 text-black/80 dark:text-white/85">
      <div className="mx-auto max-w-lg">
        <Section
          title="Watching"
          hint={watching.length ? "" : "No monitors are watching right now."}
        >
          {watching.map((routine) => (
            <li
              key={routine.id}
              className="flex items-center gap-3 rounded-xl bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05]"
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8rem] font-medium">
                  {routine.bot?.name || "Bot"}
                  <span className="text-black/40 dark:text-white/45"> · {routine.name}</span>
                </p>
                <p className="truncate text-[0.7rem] text-black/45 dark:text-white/45">
                  {routine.watchingTarget || routine.triggerLabel}
                  {routine.lastCheckedAt ? ` · last checked ${timeAgo(routine.lastCheckedAt)}` : ""}
                </p>
                {routine.watchingCondition ? (
                  <p className="truncate text-[0.68rem] text-black/35 dark:text-white/40">
                    {routine.watchingCondition}
                    {routine.monitorStatus && routine.monitorStatus !== "watching"
                      ? ` · ${String(routine.monitorStatus).replace(/_/g, " ")}`
                      : ""}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                title="Pause this routine"
                onClick={() => setRoutineEnabled(routine.id, false)}
                className="flex items-center gap-1 rounded-full bg-black/[0.05] px-2.5 py-1 text-[0.7rem] font-medium text-black/60 transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:text-white/60"
              >
                <Pause className="h-3 w-3" /> Pause
              </button>
            </li>
          ))}
        </Section>

        <Section
          title="Running"
          hint={runningTasks.length ? "" : "Nothing is running right now."}
        >
          {runningTasks.map((task) => (
            <li
              key={task.taskId}
              className="flex items-center gap-3 rounded-xl bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05]"
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8rem] font-medium">
                  {task.botName || "Agent"}
                  {task.routineId ? (
                    <span className="text-black/40 dark:text-white/45">
                      {" "}
                      · {routineName(task.routineId) || "routine"}
                    </span>
                  ) : null}
                  {task.remoteTargetId ? (
                    <span
                      title="Running on a remote host over SSH"
                      className="ml-1.5 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[0.62rem] font-medium text-sky-600 dark:text-sky-400"
                    >
                      remote
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-[0.7rem] text-black/45 dark:text-white/45">
                  {task.step || task.objective}
                </p>
              </div>
              <button
                type="button"
                title="Stop this task — the routine keeps watching"
                onClick={() => stopTask(task.taskId)}
                className="flex items-center gap-1 rounded-full bg-black/[0.05] px-2.5 py-1 text-[0.7rem] font-medium text-black/60 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:bg-white/[0.08] dark:text-white/60"
              >
                <Square className="h-3 w-3" /> Stop
              </button>
            </li>
          ))}
        </Section>

        {/* Routines across every Bot */}
        <Section
          title="Routines"
          hint={
            routines.length
              ? ""
              : "No routines yet — ask a Bot for standing work, or add one on its page."
          }
        >
          {routines.map((routine) => (
            <li
              key={routine.id}
              className={`flex items-center gap-2 rounded-xl bg-black/[0.035] px-3 py-2 dark:bg-white/[0.05] ${
                routine.enabled ? "" : "opacity-60"
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8rem] font-medium">
                  {routine.name}
                  <span className="text-black/40 dark:text-white/45">
                    {" "}
                    · {routine.bot?.name || "Bot"}
                  </span>
                </p>
                <p className="truncate text-[0.7rem] text-black/45 dark:text-white/45">
                  {routine.watchingTarget || routine.triggerLabel}
                  {routine.running ? " · running now" : ""}
                  {routine.watching && !routine.running ? " · watching" : ""}
                  {!routine.enabled ? " · paused" : ""}
                </p>
              </div>
              <button
                type="button"
                title="Run now"
                onClick={() => runRoutineNow(routine.id)}
                className="rounded-full p-1.5 text-black/40 transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:text-white/40 dark:hover:bg-white/[0.09] dark:hover:text-white/90"
              >
                <Zap className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title={routine.enabled ? "Pause" : "Resume"}
                onClick={() => setRoutineEnabled(routine.id, !routine.enabled)}
                className="rounded-full p-1.5 text-black/40 transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:text-white/40 dark:hover:bg-white/[0.09] dark:hover:text-white/90"
              >
                {routine.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                title="Delete routine"
                onClick={() => deleteRoutine(routine.id)}
                className="rounded-full p-1.5 text-black/30 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:text-white/30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </Section>

        {/* Recent runs */}
        <Section
          title="Recent runs"
          hint={recentRuns.length ? "" : "Routine runs will show up here."}
        >
          {recentRuns.map((run) => (
            <li
              key={run.id}
              className="rounded-xl bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]"
            >
              <div className="flex items-baseline gap-2">
                <p className="min-w-0 flex-1 truncate text-[0.78rem] font-medium">
                  {routineName(run.routineId) || "Routine"}
                  <span
                    className={`ml-2 text-[0.68rem] font-semibold ${
                      run.status === "failed"
                        ? "text-red-500/90"
                        : run.status === "completed"
                          ? "text-emerald-600/90 dark:text-emerald-400/90"
                          : "text-black/45 dark:text-white/50"
                    }`}
                  >
                    {RUN_STATUS_LABEL[run.status] || run.status}
                  </span>
                </p>
                <span className="shrink-0 text-[0.68rem] text-black/35 dark:text-white/35">
                  {timeAgo(run.triggeredAt)}
                </span>
              </div>
              {run.resultSummary || run.error ? (
                <p className="mt-0.5 line-clamp-2 text-[0.7rem] text-black/45 dark:text-white/45">
                  {run.error || run.resultSummary}
                </p>
              ) : null}
            </li>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div className="mb-7">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
        {title}
      </p>
      {hint ? (
        <p className="mt-2 text-[0.78rem] text-black/40 dark:text-white/45">{hint}</p>
      ) : (
        <ul className="mt-2 space-y-2">{children}</ul>
      )}
    </div>
  );
}
