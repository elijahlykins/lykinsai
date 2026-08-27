"use strict";

function asError(error) {
  return { ok: false, error: error?.message || String(error) };
}

function registerWorkflowsIpc(d) {
  const service = () => d.getTeachService();

  d.ipcMain.handle("lykn:teach-start", (_event, payload) => {
    try {
      return { ok: true, session: service().start(payload || {}) };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:teach-finish", async (_event, payload) => {
    try {
      return { ok: true, workflow: await service().finish(payload || {}) };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:teach-cancel", () => {
    try {
      return { ok: true, session: service().cancel("user_cancelled") };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:teach-status", () => {
    try {
      return { ok: true, ...service().status() };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:teach-record-event", (_event, payload) => {
    try {
      const result = service().record({
        ...(payload || {}),
        metadata: { ...(payload?.metadata || {}), actor: "user" },
      });
      return { ok: result.accepted === true, ...result };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflows-list", (_event, payload) => {
    try {
      return { ok: true, workflows: service().listWorkflows(payload?.botId) };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflow-create", (_event, payload) => {
    try {
      return { ok: true, workflow: service().createWorkflow(payload || {}) };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflow-update", (_event, payload) => {
    try {
      return {
        ok: true,
        workflow: service().updateWorkflow(payload?.workflowId, payload?.patch || {}),
      };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflow-delete", (_event, payload) => {
    try {
      const removed = service().removeWorkflow(payload?.workflowId);
      return removed ? { ok: true } : { ok: false, error: "workflow_not_found" };
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflow-run", (_event, payload) => {
    try {
      return service().run(payload?.workflowId, payload?.input || {});
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflow-create-routine", (_event, payload) => {
    try {
      return service().createRoutineReference(payload?.workflowId, payload?.input || {});
    } catch (error) {
      return asError(error);
    }
  });

  d.ipcMain.handle("lykn:workflow-apply-recovered-update", (_event, payload) => {
    try {
      return {
        ok: true,
        workflow: service().applyRecoveredUpdate(
          payload?.workflowId,
          payload?.recoveredUpdateId,
        ),
      };
    } catch (error) {
      return asError(error);
    }
  });
}

module.exports = { registerWorkflowsIpc };
