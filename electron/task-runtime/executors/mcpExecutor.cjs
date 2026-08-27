"use strict";

/**
 * McpExecutor — TaskRuntime contract for live MCP tool calls.
 *
 * Inject `callTool` from the trusted MCP runtime (server or test double).
 * Does not speak MCP protocol itself. Does not own Task lifecycle.
 */

const {
  executeMcpTool,
} = (() => {
  try {
    return require("../../lib/mcp/executeMcpTool.cjs");
  } catch {
    return { executeMcpTool: null };
  }
})();

class McpExecutor {
  /**
   * @param {object} deps
   * @param {(args: object) => Promise<object>} deps.callTool
   * @param {(args: object) => object} [deps.resolveTools]
   */
  constructor({ callTool, resolveTools, execute } = {}) {
    if (typeof callTool !== "function") throw new TypeError("McpExecutor requires callTool");
    this.name = "mcp";
    this.callTool = callTool;
    this.resolveTools = resolveTools;
    this.executeFn = execute;
  }

  async execute(task, runtime = {}) {
    if (runtime.signal?.aborted || task?.cancellation?.signal?.aborted) {
      return { ok: false, status: "cancelled", reason: "task_cancelled", executor: this.name };
    }
    const connectionId = String(runtime.connectionId || task?.association?.connectionIds?.[0] || "");
    const toolName = String(runtime.toolName || "");
    if (!connectionId || !toolName) {
      return { ok: false, status: "failed", reason: "mcp_target_missing", executor: this.name };
    }

    const resolution =
      runtime.resolution ||
      (typeof this.resolveTools === "function"
        ? this.resolveTools({ task, connectionId, toolName })
        : { tools: runtime.tools || [] });

    const run = this.executeFn || executeMcpTool;
    if (typeof run !== "function") {
      return this._fallbackExecute(task, runtime, resolution, connectionId, toolName);
    }

    const result = await run({
      task: {
        ...task,
        cancellation: {
          ...(task.cancellation || {}),
          signal: runtime.signal || task.cancellation?.signal,
        },
      },
      resolution,
      connectionId,
      toolName,
      args: runtime.args || {},
      callTool: this.callTool,
      onEvent: (event) => runtime.progress?.(event),
    });
    if (runtime.signal?.aborted) {
      return { ok: false, status: "cancelled", reason: "task_cancelled", ignored: true, executor: this.name };
    }
    return { ...result, executor: this.name };
  }

  async _fallbackExecute(task, runtime, resolution, connectionId, toolName) {
    const selected = (resolution.tools || []).find(
      (tool) => tool.connectionId === connectionId && tool.toolName === toolName,
    );
    if (!selected) {
      return { ok: false, status: "failed", reason: "tool_not_in_resolution", executor: this.name };
    }
    const caps = Array.isArray(task.capabilities) ? task.capabilities : [];
    const needed = selected.semanticCapabilities?.[0];
    if (needed && !caps.some((cap) => cap === needed || cap.startsWith(needed.split(".").slice(0, 2).join(".")))) {
      const write = /write|send|delete|create|update/i.test(String(selected.consequenceHint || needed));
      if (write) {
        return { ok: false, status: "failed", reason: "capability_missing", executor: this.name };
      }
    }
    try {
      const observation = await this.callTool({
        connectionId,
        toolName,
        args: runtime.args || {},
        signal: runtime.signal,
        taskId: task.id,
        runId: task.runId,
      });
      if (runtime.signal?.aborted) {
        return { ok: false, status: "cancelled", reason: "task_cancelled", ignored: true, executor: this.name };
      }
      return {
        ok: true,
        status: "completed",
        observation,
        output: observation,
        executor: this.name,
      };
    } catch (error) {
      if (runtime.signal?.aborted || error?.code === "aborted") {
        return { ok: false, status: "cancelled", reason: "task_cancelled", ignored: true, executor: this.name };
      }
      return { ok: false, status: "failed", reason: String(error?.message || error), executor: this.name };
    }
  }
}

module.exports = { McpExecutor };
