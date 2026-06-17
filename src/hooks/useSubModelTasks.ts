import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type SubModelTask = {
  id: string;
  sub_model_name: string;
  task_instruction: string;
  status: "pending" | "running" | "completed" | "failed";
  report?: string | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type UseSubModelTasksOptions = {
  chatId?: string | null;
  enabled?: boolean;
};

export function useSubModelTasks({ chatId = null, enabled = true }: UseSubModelTasksOptions = {}) {
  const [tasks, setTasks] = useState<SubModelTask[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  const loadTasks = useCallback(async (uid: string) => {
    let q = supabase
      .from("lykn_sub_model_tasks")
      .select(
        "id, sub_model_name, task_instruction, status, report, error_message, created_at, completed_at, chat_id",
      )
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(24);

    if (chatId) q = q.eq("chat_id", chatId);

    const { data, error } = await q;
    if (error) {
      if (import.meta.env.DEV) console.warn("[sub-model-tasks] load failed:", error.message);
      return;
    }
    setTasks((data || []) as SubModelTask[]);
  }, [chatId]);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      return;
    }

    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id || null;
      if (cancelled || !uid) return;
      setUserId(uid);
      await loadTasks(uid);

      channel = supabase
        .channel(`sub-model-tasks:${uid}:${chatId || "all"}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "lykn_sub_model_tasks", filter: `user_id=eq.${uid}` },
          () => {
            void loadTasks(uid);
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled, chatId, loadTasks]);

  const active = tasks.filter((t) => t.status === "pending" || t.status === "running");
  const recentCompleted = tasks.filter((t) => {
    if (t.status !== "completed" && t.status !== "failed") return false;
    if (!t.completed_at) return true;
    const age = Date.now() - new Date(t.completed_at).getTime();
    return age < 15 * 60 * 1000;
  });

  return { tasks, active, recentCompleted, userId };
}
