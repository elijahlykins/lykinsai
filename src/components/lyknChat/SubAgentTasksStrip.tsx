import React from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSubModelTasks } from "@/hooks/useSubModelTasks";

function truncate(text: string, max = 72) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

type SubAgentTasksStripProps = {
  chatId?: string | null;
  enabled?: boolean;
  className?: string;
};

export default function SubAgentTasksStrip({
  chatId = null,
  enabled = true,
  className,
}: SubAgentTasksStripProps) {
  const { active, recentCompleted } = useSubModelTasks({ chatId, enabled });
  const recentFailed = recentCompleted.filter((t) => t.status === "failed");
  const recentDone = recentCompleted.filter((t) => t.status === "completed");

  if (!enabled || (active.length === 0 && recentDone.length === 0 && recentFailed.length === 0)) {
    return null;
  }

  return (
    <div className={cn("space-y-1.5 mb-2", className)}>
      {active.map((task) => (
        <div
          key={task.id}
          className="flex items-start gap-2 rounded-lg border border-blue-400/30 bg-blue-500/8 px-3 py-2 text-[11px] text-black/80 dark:text-white/85"
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 mt-0.5 animate-spin text-blue-600 dark:text-blue-400" />
          <div className="min-w-0">
            <span className="font-medium">{task.sub_model_name || "Sub-agent"}</span>
            <span className="text-black/55 dark:text-white/55"> is working on </span>
            <span className="text-black/70 dark:text-white/70">{truncate(task.task_instruction)}</span>
          </div>
        </div>
      ))}
      {recentDone.map((task) => (
        <div
          key={`done-${task.id}`}
          className="flex items-start gap-2 rounded-lg border border-emerald-400/25 bg-emerald-500/8 px-3 py-2 text-[11px] text-black/80 dark:text-white/85"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <span className="font-medium">{task.sub_model_name || "Sub-agent"}</span>
            <span className="text-black/55 dark:text-white/55"> finished </span>
            <span className="text-black/70 dark:text-white/70">{truncate(task.task_instruction)}</span>
            <span className="text-black/45 dark:text-white/45"> — ask your main agent for the summary</span>
          </div>
        </div>
      ))}
      {recentFailed.map((task) => (
        <div
          key={`fail-${task.id}`}
          className="flex items-start gap-2 rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2 text-[11px] text-black/80 dark:text-white/85"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
          <div className="min-w-0">
            <span className="font-medium">{task.sub_model_name || "Sub-agent"}</span>
            <span className="text-black/55 dark:text-white/55"> could not finish </span>
            <span className="text-black/70 dark:text-white/70">{truncate(task.task_instruction)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
