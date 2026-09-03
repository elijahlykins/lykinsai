"use strict";

/**
 * Glass typed-chat Local Mode client.
 *
 * Studio Chat runs local_* in the renderer and posts the result back.
 * Glass consumes /api/ai/stream in the main process, so the same round-trip
 * has to happen here: awaiting_client → localSystem.run → POST result.
 * Renderer-only tools (bots, browser agent) are not executable from this
 * path; they return a clear error so the turn does not hang.
 */

const RENDERER_ONLY_LOCAL_TOOLS = new Set(["local_ask_bot", "local_browser_agent"]);

function isOverlayLocalModeOn(localSystem, userDataPath) {
  try {
    return localSystem.readLocalMode(userDataPath).enabled === true;
  } catch {
    return false;
  }
}

function overlayLocalModeBody(localSystem, userDataPath) {
  return isOverlayLocalModeOn(localSystem, userDataPath) ? { localMode: true } : {};
}

function sanitizeLocalResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, error: "malformed local tool result" };
  }
  const out = { ...result };
  if (typeof out.dataBase64 === "string") {
    delete out.dataBase64;
    out.note = [
      String(out.note || "").trim(),
      "The file was read on this Mac. Glass does not attach the raw bytes as a chat card.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return out;
}

async function confirmRiskyLocalAction({ dialog, overlayWindow, summary } = {}) {
  if (!dialog || typeof dialog.showMessageBox !== "function") return false;
  const win =
    overlayWindow && typeof overlayWindow.isDestroyed === "function" && !overlayWindow.isDestroyed()
      ? overlayWindow
      : undefined;
  const res = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Allow", "Don't allow"],
    defaultId: 1,
    cancelId: 1,
    message: "LYKN wants to run this on your Mac",
    detail: String(summary || "Run this local action?"),
  });
  return res.response === 0;
}

async function runOverlayLocalTool(opts = {}) {
  const name = String(opts.name || "");
  const args = opts.args && typeof opts.args === "object" ? opts.args : {};
  if (RENDERER_ONLY_LOCAL_TOOLS.has(name)) {
    return {
      ok: false,
      error:
        name === "local_ask_bot"
          ? "Asking a bot from Glass typed chat is not available yet. Open Studio Chat or use voice."
          : "The browser agent is not available from Glass typed chat. Open Studio or start Agent Mode there.",
    };
  }
  const localSystem = opts.localSystem;
  const userDataPath = String(opts.userDataPath || "");
  if (!localSystem || typeof localSystem.run !== "function") {
    return { ok: false, error: "Local Mode is not available in this session." };
  }
  if (!isOverlayLocalModeOn(localSystem, userDataPath)) {
    return { ok: false, error: "Local Mode is off. Enable it in the Vault first." };
  }
  let result = await localSystem.run(name, args, {
    approved: false,
    userDataPath,
  });
  if (result && result.needsApproval === true) {
    const localApprovals = opts.localApprovals;
    const token =
      localApprovals && typeof localApprovals.issue === "function"
        ? localApprovals.issue(name, args)
        : "";
    const allowed =
      typeof opts.requestApproval === "function"
        ? await opts.requestApproval(String(result.summary || "Run this local action?"))
        : await confirmRiskyLocalAction({
            dialog: opts.dialog,
            overlayWindow: opts.overlayWindow,
            summary: result.summary,
          });
    if (!allowed) return { ok: false, error: "You declined this action." };
    const approved =
      localApprovals && typeof localApprovals.consume === "function"
        ? localApprovals.consume(token, name, args)
        : false;
    result = await localSystem.run(name, args, { approved, userDataPath });
  }
  return sanitizeLocalResult(result);
}

async function postOverlayLocalToolResult({
  apiBase,
  token,
  streamId,
  toolCallId,
  result,
  fetchImpl,
} = {}) {
  const base = String(apiBase || "").replace(/\/$/, "");
  const sid = String(streamId || "");
  const cid = String(toolCallId || "");
  if (!base || !sid || !cid) return { ok: false, error: "missing local tool relay" };
  const fetchFn = typeof fetchImpl === "function" ? fetchImpl : fetch;
  await fetchFn(`${base}/api/ai/local-tool-result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ streamId: sid, toolCallId: cid, result }),
  });
  return { ok: true };
}

async function handleOverlayAwaitingClient(tc, opts = {}) {
  const streamId = String(tc?.localStreamId || "");
  const toolCallId = String(tc?.id || "");
  if (!streamId || !toolCallId) return { ok: false, error: "missing awaiting_client ids" };
  const result = await runOverlayLocalTool({
    name: tc.name,
    args: tc.args,
    localSystem: opts.localSystem,
    localApprovals: opts.localApprovals,
    userDataPath: opts.userDataPath,
    dialog: opts.dialog,
    overlayWindow: opts.overlayWindow,
    requestApproval: opts.requestApproval,
  });
  await postOverlayLocalToolResult({
    apiBase: opts.apiBase,
    token: opts.token,
    streamId,
    toolCallId,
    result,
    fetchImpl: opts.fetchImpl,
  });
  return result;
}

module.exports = {
  RENDERER_ONLY_LOCAL_TOOLS,
  isOverlayLocalModeOn,
  overlayLocalModeBody,
  sanitizeLocalResult,
  runOverlayLocalTool,
  postOverlayLocalToolResult,
  handleOverlayAwaitingClient,
};
