"use strict";

/**
 * Desktop → server MCP client. Electron never holds tokens itself;
 * it calls the authenticated /api/mcp routes with the user's session.
 */

/**
 * Per-call ceilings. Enumerating connections and their tools is metadata and
 * should be quick; running someone else's tool legitimately is not.
 *
 * There was no ceiling at all, so a connector that never answered hung the
 * whole call forever — an agent asked to check email would sit "reading up on
 * your tools" until the task timed out, with nothing to show for it.
 */
const LIST_TIMEOUT_MS = 12_000;
const CALL_TIMEOUT_MS = 60_000;

async function authorizedFetch(apiBase, getAuthToken, path, init = {}, timeoutMs = LIST_TIMEOUT_MS) {
  const token = typeof getAuthToken === "function" ? await getAuthToken() : "";
  if (!token) {
    const err = new Error("sign_in_required");
    err.code = "sign_in_required";
    throw err;
  }
  const url = `${String(apiBase || "").replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  let res;
  try {
    res = await fetch(url, {
      ...init,
      signal: init.signal
        ? anySignal([init.signal, controller.signal])
        : controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      const err = new Error(`mcp_timeout after ${timeoutMs}ms`);
      err.code = "mcp_timeout";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `mcp_http_${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
  }
}

/** Abort when any of the given signals aborts. */
function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

async function listConnections({ apiBase, getAuthToken }) {
  const data = await authorizedFetch(apiBase, getAuthToken, "/api/mcp/connections");
  return Array.isArray(data.connections) ? data.connections : [];
}

async function connectionDetail({ apiBase, getAuthToken, connectionId }) {
  return authorizedFetch(
    apiBase,
    getAuthToken,
    `/api/mcp/connections/${encodeURIComponent(connectionId)}/detail`,
  );
}

async function callTool({
  apiBase,
  getAuthToken,
  connectionId,
  toolName,
  args = {},
  task = null,
  approvalToken = null,
}) {
  return authorizedFetch(
    apiBase,
    getAuthToken,
    `/api/mcp/connections/${encodeURIComponent(connectionId)}/tools/call`,
    {
      method: "POST",
      body: JSON.stringify({
        toolName,
        arguments: args && typeof args === "object" ? args : {},
        ...(task ? { task } : {}),
        ...(approvalToken ? { approvalToken } : {}),
      }),
    },
    // Running someone else's tool can legitimately take a while; enumerating
    // metadata cannot. Different ceilings for different jobs.
    CALL_TIMEOUT_MS,
  );
}

module.exports = {
  listConnections,
  connectionDetail,
  callTool,
};
