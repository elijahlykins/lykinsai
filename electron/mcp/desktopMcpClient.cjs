"use strict";

/**
 * Desktop → server MCP client. Electron never holds tokens itself;
 * it calls the authenticated /api/mcp routes with the user's session.
 */

async function authorizedFetch(apiBase, getAuthToken, path, init = {}) {
  const token = typeof getAuthToken === "function" ? await getAuthToken() : "";
  if (!token) {
    const err = new Error("sign_in_required");
    err.code = "sign_in_required";
    throw err;
  }
  const url = `${String(apiBase || "").replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `mcp_http_${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
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
  );
}

module.exports = {
  listConnections,
  connectionDetail,
  callTool,
};
