"use strict";

/**
 * connected_apps bot tool - act in the user's OAuth-connected apps through
 * the server's Universal MCP API (managed connections included).
 *
 * Electron never holds app tokens: every call goes through the
 * authenticated /api/mcp routes via the desktop MCP client, so the server's
 * full gate stack applies (connection status, capability check, consequence
 * approval, untrusted-result wrapping).
 *
 * Two instruction modes, taught by agent/tools/connected_apps.md:
 *   "list"                                   -> connected apps + their tools
 *   {"app": "...", "tool": "...", "args": {}} -> one tool call
 *
 * Consequential calls come back as waiting_for_approval; this module asks
 * the user through the injected requestApproval and retries once with the
 * minted approval token.
 */

const OUTPUT_CHAR_LIMIT = 6000;
const MAX_APPS_LISTED = 8;
const MAX_TOOLS_PER_APP = 40;

function parseInstruction(instruction) {
  const text = String(instruction || "").trim();
  if (!text || /^list\b/i.test(text)) return { mode: "list" };
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (parsed && typeof parsed === "object" && parsed.tool) {
        return {
          mode: "call",
          app: String(parsed.app || "").trim(),
          tool: String(parsed.tool).trim(),
          args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
        };
      }
    } catch {
      /* fall through to list */
    }
  }
  return { mode: "list" };
}

function boundOutput(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text || "");
  return text.length > OUTPUT_CHAR_LIMIT ? `${text.slice(0, OUTPUT_CHAR_LIMIT)}…` : text;
}

function matchConnection(connections, appRef) {
  const ref = String(appRef || "").trim().toLowerCase();
  if (!ref) return null;
  return (
    connections.find((c) => String(c.id || "").toLowerCase() === ref) ||
    connections.find((c) => String(c.id || "").toLowerCase().startsWith(ref)) ||
    connections.find((c) => String(c.name || "").toLowerCase() === ref) ||
    connections.find((c) => String(c.name || "").toLowerCase().includes(ref)) ||
    null
  );
}

function createConnectedAppsTool({ mcpClient, apiBase, getAuthToken, logger = console }) {
  async function listConnected() {
    const connections = await mcpClient.listConnections({ apiBase, getAuthToken });
    return connections.filter((c) => c.status === "connected");
  }

  async function runList() {
    const usable = await listConnected();
    if (!usable.length) {
      return {
        ok: true,
        output:
          "No apps are connected. The user can connect Gmail, Slack, Notion, and more in Settings → Connections. Until then, the browser tool is the only way into their accounts.",
        summary: "No connected apps.",
      };
    }
    const sections = [];
    for (const conn of usable.slice(0, MAX_APPS_LISTED)) {
      let detail = null;
      try {
        detail = await mcpClient.connectionDetail({ apiBase, getAuthToken, connectionId: conn.id });
      } catch (e) {
        logger.warn?.(`[connected-apps] detail failed connection=${conn.id}: ${e?.message || e}`);
        continue;
      }
      const tools = (detail?.tools || [])
        .slice(0, MAX_TOOLS_PER_APP)
        .map(
          (t) =>
            `  - ${t.name} (${t.consequence || "read"}) - ${String(t.description || "")
              .replace(/\s+/g, " ")
              .slice(0, 110)}`,
        );
      sections.push(`${conn.name} [app id: ${conn.id}]\n${tools.join("\n") || "  (no tools discovered)"}`);
    }
    return {
      ok: true,
      output: [
        "Connected apps and their callable tools:",
        "",
        ...sections,
        "",
        'Call one with: {"app": "<app id or name>", "tool": "<TOOL_NAME>", "args": { ... }}',
      ].join("\n"),
      summary: `${usable.length} connected app(s) listed.`,
    };
  }

  async function callTool({ connection, toolMeta, tool, args, approvalToken, signal }) {
    return mcpClient.callTool({
      apiBase,
      getAuthToken,
      connectionId: connection.id,
      toolName: tool,
      args,
      approvalToken,
      task: {
        objective: `connected_apps: ${tool}`,
        capabilities: toolMeta?.capabilities || [],
        association: { connectionIds: [connection.id] },
        cancellation: { state: signal?.aborted ? "cancelled" : "active" },
      },
    });
  }

  async function runCall({ app, tool, args, signal, requestApproval }) {
    const usable = await listConnected();
    const connection = matchConnection(usable, app);
    if (!connection) {
      return {
        ok: false,
        output: `No connected app matches "${app}". Run the tool with "list" to see what is connected.`,
        summary: "App not found.",
      };
    }
    let toolMeta = null;
    try {
      const detail = await mcpClient.connectionDetail({ apiBase, getAuthToken, connectionId: connection.id });
      toolMeta = (detail?.tools || []).find((t) => t.name === tool) || null;
    } catch {
      toolMeta = null;
    }
    if (!toolMeta) {
      return {
        ok: false,
        output: `${connection.name} has no tool named ${tool}. Run "list" for exact tool names.`,
        summary: "Tool not found.",
      };
    }

    let result = await callTool({ connection, toolMeta, tool, args, signal });
    if (result?.status === "waiting_for_approval" && result.approvalToken) {
      if (typeof requestApproval !== "function") {
        // Headless run (routine): consequential calls never auto-approve.
        return {
          ok: false,
          output: `${tool} in ${connection.name} has real effects and needs the user's approval, which is not available in this run. Skip it and report what you found instead.`,
          summary: "Approval unavailable in this run.",
        };
      }
      const summary = result.request?.summary || result.request?.title || "";
      const question =
        String(summary || "").trim() ||
        `Approve ${tool} in ${connection.name}? This action has real effects.`;
      const approved = await requestApproval({ question });
      if (!approved) {
        return {
          ok: false,
          output: `The user declined ${tool} in ${connection.name}. Do not retry it.`,
          summary: "Declined by user.",
        };
      }
      result = await callTool({
        connection,
        toolMeta,
        tool,
        args,
        approvalToken: result.approvalToken,
        signal,
      });
    }
    if (signal?.aborted) return { ok: false, output: "", summary: "cancelled" };

    if (result?.status === "waiting_for_user" || result?.condition === "connection_auth_required") {
      return {
        ok: false,
        output: `${connection.name} needs to be reconnected in Settings → Connections before its tools work.`,
        summary: "Connection needs attention.",
      };
    }
    if (result?.ok === false) {
      return {
        ok: false,
        output: boundOutput(result.reason || result),
        summary: `Call failed: ${String(result.reason || "error").slice(0, 120)}`,
      };
    }
    const observation = result?.observation ?? result;
    return {
      ok: true,
      output: boundOutput(observation),
      summary: `${tool} in ${connection.name} succeeded.`,
    };
  }

  async function execute({ instruction, signal, requestApproval } = {}) {
    if (signal?.aborted) return { ok: false, output: "", summary: "cancelled" };
    const parsed = parseInstruction(instruction);
    try {
      if (parsed.mode === "list") return await runList();
      return await runCall({ ...parsed, signal, requestApproval });
    } catch (e) {
      if (e?.code === "sign_in_required") {
        return { ok: false, output: "The user must be signed in to use connected apps.", summary: "Sign-in required." };
      }
      logger.warn?.(`[connected-apps] failed: ${e?.message || e}`);
      return {
        ok: false,
        output: `Connected apps are unavailable right now (${String(e?.message || "error").slice(0, 140)}).`,
        summary: "Connected apps unavailable.",
      };
    }
  }

  return { execute };
}

module.exports = { createConnectedAppsTool, parseInstruction, matchConnection };
