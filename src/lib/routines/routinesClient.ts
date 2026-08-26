// Bot Routines client — the renderer's one door to the main-process routine
// runtime (electron/bot-routines/*). Definitions, run history, and the
// Activity snapshot all live in main; this module is IPC plus React
// subscriptions, so every surface (BotsPage, ActivityPanel, chat) reads the
// same truth.

import { useEffect, useState } from "react";

type Lykn = {
  desktop?: boolean;
  routinesList?: (botId?: string) => Promise<{ ok: boolean; routines?: BotRoutine[] }>;
  routineCreate?: (payload: object) => Promise<{ ok: boolean; routine?: BotRoutine; error?: string }>;
  routineUpdate?: (routineId: string, patch: object) => Promise<{ ok: boolean; routine?: BotRoutine }>;
  routineSetEnabled?: (routineId: string, enabled: boolean) => Promise<{ ok: boolean }>;
  routineDelete?: (routineId: string) => Promise<{ ok: boolean }>;
  routineRunNow?: (routineId: string) => Promise<{ ok: boolean; error?: string }>;
  routineRuns?: (routineId: string, limit?: number) => Promise<{ ok: boolean; runs?: RoutineRun[] }>;
  activitySnapshot?: () => Promise<ActivitySnapshot & { ok: boolean }>;
  taskStop?: (taskId: string) => Promise<{ ok: boolean }>;
  onRoutinesChanged?: (cb: (p: { routines?: BotRoutine[] }) => void) => () => void;
  onActivityNotification?: (cb: (p: ActivityNotification) => void) => () => void;
  onActivityOpen?: (cb: (p: { botId?: string; routineId?: string; taskId?: string }) => void) => () => void;
  onTaskEvent?: (cb: (p: object) => void) => () => void;
};

export type BotRoutine = {
  id: string;
  botId: string;
  bot?: { id: string; name?: string; face?: string; eyes?: string; color?: string };
  name: string;
  instructions: string;
  trigger: { type: string; [k: string]: unknown };
  triggerLabel?: string;
  capabilities: string[];
  notificationPolicy: string;
  concurrencyPolicy: string;
  enabled: boolean;
  running?: boolean;
  watching?: boolean;
  watchingTarget?: string;
  watchingCondition?: string;
  monitorStatus?: string;
  lastCheckedAt?: string | null;
  lastChangeAt?: string | null;
  lastRunAt?: string | null;
  nextRunAt?: number | null;
};

export type RoutineRun = {
  id: string;
  routineId: string;
  taskId: string;
  triggeredAt: string;
  triggerReason: string;
  completedAt?: string | null;
  status: string;
  resultSummary?: string;
  error?: string;
};

export type ActiveTask = {
  taskId: string;
  status: string;
  objective: string;
  botId: string;
  botName: string;
  routineId?: string;
  agentId: string;
  step?: string;
  startedAt?: string;
};

export type ActivityNotification = {
  id: string;
  at: string;
  botId: string;
  routineId?: string;
  taskId?: string;
  title: string;
  body?: string;
  urgency?: string;
  deepLink?: { botId?: string; routineId?: string; taskId?: string };
};

export type ActivitySnapshot = {
  tasks: ActiveTask[];
  routines: BotRoutine[];
  recentRuns: RoutineRun[];
  notifications: ActivityNotification[];
};

const lykn = (): Lykn => (typeof window !== "undefined" ? ((window as { lykn?: Lykn }).lykn ?? {}) : {});

export function routinesAvailable(): boolean {
  const l = lykn();
  return !!l.desktop && typeof l.routinesList === "function";
}

export const listRoutines = async (botId?: string): Promise<BotRoutine[]> =>
  (await lykn().routinesList?.(botId))?.routines ?? [];

export const createRoutine = (payload: object) =>
  lykn().routineCreate?.(payload) ?? Promise.resolve({ ok: false, error: "desktop_only" });

export const setRoutineEnabled = (routineId: string, enabled: boolean) =>
  lykn().routineSetEnabled?.(routineId, enabled) ?? Promise.resolve({ ok: false });

export const deleteRoutine = (routineId: string) =>
  lykn().routineDelete?.(routineId) ?? Promise.resolve({ ok: false });

export const runRoutineNow = (routineId: string) =>
  lykn().routineRunNow?.(routineId) ?? Promise.resolve({ ok: false });

export const listRoutineRuns = async (routineId: string, limit = 10): Promise<RoutineRun[]> =>
  (await lykn().routineRuns?.(routineId, limit))?.runs ?? [];

export const stopTask = (taskId: string) =>
  lykn().taskStop?.(taskId) ?? Promise.resolve({ ok: false });

export const fetchActivitySnapshot = async (): Promise<ActivitySnapshot> => {
  const snap = await lykn().activitySnapshot?.();
  return {
    tasks: snap?.tasks ?? [],
    routines: snap?.routines ?? [],
    recentRuns: snap?.recentRuns ?? [],
    notifications: snap?.notifications ?? [],
  };
};

/** Live routine list, optionally scoped to one bot. */
export function useRoutines(botId?: string) {
  const [routines, setRoutines] = useState<BotRoutine[]>([]);
  useEffect(() => {
    if (!routinesAvailable()) return;
    let alive = true;
    const apply = (all: BotRoutine[]) => {
      if (!alive) return;
      setRoutines(botId ? all.filter((r) => r.botId === botId) : all);
    };
    void listRoutines(botId).then((r) => apply(botId ? r : r));
    const off = lykn().onRoutinesChanged?.((p) => apply(p.routines ?? []));
    return () => {
      alive = false;
      off?.();
    };
  }, [botId]);
  return routines;
}

/** The Activity surface's data: polled snapshot + push-refresh on events. */
export function useActivity() {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>({
    tasks: [],
    routines: [],
    recentRuns: [],
    notifications: [],
  });
  useEffect(() => {
    if (!routinesAvailable()) return;
    let alive = true;
    const refresh = () => {
      void fetchActivitySnapshot().then((snap) => {
        if (alive) setSnapshot(snap);
      });
    };
    refresh();
    // Task events fire on every lifecycle change; a light debounce keeps the
    // snapshot fresh without hammering IPC during bursts.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 400);
    };
    const offs = [
      lykn().onRoutinesChanged?.(nudge),
      lykn().onTaskEvent?.(nudge),
      lykn().onActivityNotification?.(nudge),
    ];
    const interval = setInterval(refresh, 15000);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      offs.forEach((off) => off?.());
    };
  }, []);
  return snapshot;
}

export const onActivityNotification = (cb: (p: ActivityNotification) => void) =>
  lykn().onActivityNotification?.(cb) ?? (() => {});

export const onActivityOpen = (cb: (p: { botId?: string; routineId?: string; taskId?: string }) => void) =>
  lykn().onActivityOpen?.(cb) ?? (() => {});
