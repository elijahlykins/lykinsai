"use strict";

/**
 * IPC for Bot Routines and the global Activity surface.
 *
 * The renderer owns creation/edit UX; the MAIN process owns the durable
 * routine store, the scheduler, monitors, and execution (TaskRuntime). Every
 * handler goes through d.getRoutineRuntime() / d.initAgentRuntime() so the
 * runtimes initialize lazily and IPC registration order never matters.
 *
 * Renderer input crossing this boundary is validated in the routine store
 * (triggers re-normalized, strings bounded) — a compromised renderer can
 * create or delete routines (equivalent to the user doing it in the UI) but
 * cannot mint approval tokens or bypass consequential-action approvals,
 * which live in the main-process approval registry and task runtime.
 */

function registerRoutinesIpc(d) {
  const { ipcMain } = d;

  const runtime = () => d.getRoutineRuntime();
  const agents = () => d.initAgentRuntime();

  ipcMain.handle("lykn:routines-list", (_e, payload) => {
    try {
      return { ok: true, routines: runtime().listRoutines({ botId: payload?.botId }) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:routine-create", (_e, payload) => {
    try {
      const input = payload || {};
      // Natural-language creation from the UI: same deterministic parser the
      // Bot's create_routine tool uses — an ambiguous description returns a
      // readable error instead of a guessed trigger.
      if (input.instruction && !input.trigger) {
        return runtime().createRoutineFromInstruction(String(input.instruction), {
          bot: input.bot,
          botId: input.botId,
          notificationPolicy: input.notificationPolicy,
          browserContext: input.browserContext,
          windowContext: input.windowContext,
        });
      }
      const routine = runtime().createRoutine(input);
      return { ok: true, routine };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:routine-update", (_e, payload) => {
    try {
      const routine = runtime().updateRoutine(payload?.routineId, payload?.patch || {});
      return routine ? { ok: true, routine } : { ok: false, error: "not_found" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:routine-set-enabled", (_e, payload) => {
    try {
      const routine = runtime().setEnabled(payload?.routineId, payload?.enabled !== false);
      return routine ? { ok: true, routine } : { ok: false, error: "not_found" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:routine-delete", (_e, payload) => {
    try {
      const removed = runtime().removeRoutine(payload?.routineId);
      return { ok: removed, ...(removed ? {} : { error: "not_found" }) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:routine-run-now", (_e, payload) => {
    try {
      const rt = runtime();
      const id = String(payload?.routineId || "");
      if (!rt.listRoutines({}).some((r) => r.id === id)) return { ok: false, error: "not_found" };
      // Fire-and-return: the run's progress reaches the renderer through
      // lykn:routines-changed pushes and the run history, not this reply.
      void rt.runNow(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:routine-runs", (_e, payload) => {
    try {
      return {
        ok: true,
        runs: runtime().listRuns(payload?.routineId, { limit: Number(payload?.limit) || 20 }),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:activity-snapshot", (_e, payload) => {
    try {
      return {
        ok: true,
        tasks: agents().listActiveTasks(),
        routines: runtime().listRoutines({}),
        recentRuns: runtime().listRecentRuns({ limit: Number(payload?.limit) || 30 }),
        notifications: runtime().notifications.listRecent({ limit: 20 }),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("lykn:task-stop", (_e, payload) => {
    try {
      return agents().stopTask(payload?.taskId);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

module.exports = { registerRoutinesIpc };
