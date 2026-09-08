"use strict";

/**
 * Desktop MCP IPC — renderer access to the local MCP host (Blender-class
 * servers that run on this machine). One op-style channel, mirroring
 * lykn:store-run. Consequential tool calls follow the Local Mode approval
 * contract: approval is NEVER a renderer-asserted boolean, only a
 * main-issued single-use token bound to this exact tool + args.
 */

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");
const { untrustedSenderResult, trustedLyknIpcOpts } = require("../trustedIpcSender.cjs");
const { createLocalMcpHost } = require("../mcp/localMcpHost.cjs");
const {
  resolveCatalogEntry,
  catalogForClient,
  searchRegistry,
} = require("../mcp/desktopMcpCatalog.cjs");

let hostSingleton = null;

function getDesktopMcpHost(app) {
  if (!hostSingleton) {
    hostSingleton = createLocalMcpHost({ userDataPath: app.getPath("userData") });
    hostSingleton.registerShutdownHooks();
  }
  return hostSingleton;
}

function approvalBinding(args = {}) {
  const tool = `desktop_mcp:${String(args.app || args.connectionId || "")}:${String(args.tool || "")}`;
  const bound = args.args && typeof args.args === "object" ? args.args : {};
  return { tool, bound };
}

/**
 * Resolve a connect request into what will actually run. Catalog id/name wins
 * and pins the command from the catalog (the model can never launder its own
 * command through a known name); a custom commandLine is the escape hatch for
 * servers we do not curate, and stands on the approval card alone.
 */
function resolveConnectTarget(a = {}) {
  const entry = resolveCatalogEntry(a.app || a.name);
  if (entry) {
    return {
      name: entry.name,
      commandLine: entry.commandLine,
      envKeys: entry.envKeys,
      setup: entry.setup,
      catalogId: entry.id,
    };
  }
  const commandLine = String(a.commandLine || a.command || "").trim();
  if (!commandLine) return null;
  const name = String(a.name || a.app || "").trim().slice(0, 60);
  return { name: name || commandLine.split(/\s+/).pop().slice(0, 60), commandLine, envKeys: [], setup: [], catalogId: null };
}

/**
 * The chat-side connect op. Behind the same single-use approval-token
 * contract as consequential tool calls: the FIRST response is
 * needsApproval + the exact command line, and only a token bound to that
 * command line lets the spawn happen.
 */
async function connectOp(host, a, approvalToken, localApprovals) {
  const target = resolveConnectTarget(a);
  if (!target) {
    return {
      ok: false,
      error: "unknown_app",
      guidance:
        "Not in the catalog. Call local_mcp_catalog to search (it also checks the MCP registry), " +
        "or pass an explicit commandLine (uvx/npx/absolute path — no shells).",
    };
  }

  // Env gate BEFORE the approval card: collecting keys after the user already
  // said yes would force a second approval for the same command.
  const envGiven = a.env && typeof a.env === "object" && !Array.isArray(a.env) ? a.env : {};
  const missing = (target.envKeys || []).filter((k) => !String(envGiven[k.name] || "").trim());
  if (missing.length) {
    return {
      ok: false,
      error: "env_required",
      needsEnv: missing.map((k) => ({ name: k.name, label: k.label, hint: k.hint })),
      app: target.name,
      guidance:
        `${target.name} needs ${missing.map((k) => k.label).join(" and ")} before it can connect. ` +
        "Ask the user for the value(s) (tell them where to find each one from the hint), then call " +
        "local_mcp_connect again with env: { NAME: value }. Keys are stored encrypted on this Mac only.",
    };
  }

  const bindingTool = `desktop_mcp:connect:${target.name.toLowerCase()}`;
  const bound = { commandLine: target.commandLine };
  const approved = localApprovals.consume(approvalToken, bindingTool, bound);
  if (!approved) {
    return {
      ok: false,
      needsApproval: true,
      summary: `Connect ${target.name} — runs: ${target.commandLine}`,
      app: target.name,
      command: target.commandLine,
      approvalToken: localApprovals.issue(bindingTool, bound),
    };
  }

  const res = await host.add({
    name: target.name,
    commandLine: target.commandLine,
    env: envGiven,
  });
  if (res.ok) {
    const tools = host.searchTools({ app: target.name });
    return {
      ...res,
      tools: tools.ok ? tools.tools : [],
      ...(target.setup?.length ? { setup: target.setup } : {}),
    };
  }
  // Most first-connect failures are app-side setup (Blender addon not
  // enabled). Ship the steps so the model walks the user through them
  // instead of shrugging.
  return {
    ...res,
    ...(target.setup?.length
      ? {
          setup: target.setup,
          guidance:
            `Connecting ${target.name} failed — usually app-side setup. Walk the user through ` +
            "these steps, then call local_mcp_connect again.",
        }
      : {}),
  };
}

function registerDesktopMcpIpc(d) {
  const { app, ipcMain, path, localApprovals, APP_URL, APP_ORIGIN } = bindOverlayIpcContext(d);
  const senderOpts = trustedLyknIpcOpts({ app, path, appOrigin: APP_ORIGIN, appUrl: APP_URL });

  ipcMain.handle("lykn:desktop-mcp", async (e, { op, args, approvalToken } = {}) => {
    const denied = untrustedSenderResult(e, senderOpts);
    if (denied) return denied;
    const host = getDesktopMcpHost(app);
    const a = args && typeof args === "object" ? args : {};
    try {
      switch (String(op || "")) {
        case "list":
          return { ok: true, connections: host.list() };
        case "detail":
          return host.detail(a.id);
        case "summary":
          return { ok: true, apps: host.summary() };
        case "add":
          return await host.add({
            name: a.name,
            commandLine: a.commandLine,
            command: a.command,
            args: a.args,
            workingDirectory: a.workingDirectory,
            env: a.env,
          });
        case "reconnect":
          return await host.reconnect(a.id);
        case "remove":
          return await host.remove(a.id);
        case "search":
          return host.searchTools({ query: a.query, app: a.app });
        case "catalog": {
          const connectedNames = host.list().map((c) => c.name);
          const entries = catalogForClient({ query: a.query, connectedNames });
          // The registry long tail only when the curated set comes up thin —
          // it is a network call and unverified entries need more scrutiny.
          if (String(a.query || "").trim() && entries.length < 3) {
            const extra = await searchRegistry(a.query);
            const seen = new Set(entries.map((x) => x.command));
            for (const r of extra) if (!seen.has(r.command)) entries.push(r);
          }
          return { ok: true, entries, connected: host.summary() };
        }
        case "connect":
          return await connectOp(host, a, approvalToken, localApprovals);
        case "call": {
          const { tool, bound } = approvalBinding(a);
          // Consuming before the run makes the token one-shot; a missing,
          // wrong, expired, or already-used token simply yields approved=false.
          const approved = localApprovals.consume(approvalToken, tool, bound);
          const result = await host.callTool({
            app: a.app,
            connectionId: a.connectionId,
            toolName: a.tool,
            args: a.args,
            approved,
          });
          if (result && result.needsApproval === true) {
            result.approvalToken = localApprovals.issue(tool, bound);
          }
          return result;
        }
        default:
          return { ok: false, error: `unknown_op:${String(op || "")}` };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 400) };
    }
  });
}

module.exports = { registerDesktopMcpIpc, getDesktopMcpHost, connectOp, resolveConnectTarget };
