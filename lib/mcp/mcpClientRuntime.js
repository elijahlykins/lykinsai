/**
 * Standards-compliant MCP client runtime (Streamable HTTP).
 *
 * Wraps @modelcontextprotocol/sdk Client. Tool discovery is dynamic.
 * Resources and prompts are optional; missing server capabilities are
 * returned as unsupported rather than thrown as fatal.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { MCP_CLIENT_NAME, MCP_CLIENT_VERSION, MCP_TRUST_LEVELS } from './protocol.js';
import { MCP_BOUNDS as BOUNDS } from './bounds.js';
import { assertMcpUrlSafe, createGuardedFetch } from './urlPolicy.js';
import { sanitizeToolDescription, wrapUntrustedObservation, wrapUntrustedPrompt, wrapUntrustedResource } from './trust.js';

function pageLimit(items, max = BOUNDS.MAX_TOOLS_CACHED) {
  return Array.isArray(items) ? items.slice(0, max) : [];
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /aborted|abort/i.test(String(error?.message || ''));
}

function classifyConnectError(error) {
  if (error instanceof UnauthorizedError || error?.status === 401 || /401|unauthorized/i.test(String(error?.message || ''))) {
    return { code: 'authentication_required', message: 'Authentication required' };
  }
  if (error?.code === 'SSRF_BLOCKED' || String(error?.message || '').startsWith('ssrf_blocked')) {
    return { code: 'ssrf_blocked', message: String(error.reason || error.message) };
  }
  if (isAbortError(error)) return { code: 'aborted', message: 'cancelled' };
  return { code: 'connect_failed', message: String(error?.message || error) };
}

export async function createMcpClientRuntime({
  serverUrl,
  trustLevel = MCP_TRUST_LEVELS.CUSTOM,
  headers = {},
  signal,
  fetchImpl,
  authProvider,
} = {}) {
  const urlCheck = await assertMcpUrlSafe(serverUrl, { trustLevel });
  if (!urlCheck.ok) {
    const err = new Error(urlCheck.error);
    err.code = urlCheck.error;
    throw err;
  }

  const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(urlCheck.url), {
    requestInit: {
      headers: { ...headers },
    },
    fetch: fetchImpl || createGuardedFetch({ trustLevel, signal }),
    ...(authProvider ? { authProvider } : {}),
  });

  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    const classified = classifyConnectError(error);
    const err = new Error(classified.message);
    err.code = classified.code;
    err.cause = error;
    throw err;
  }

  const serverInfo = client.getServerVersion() || {};
  const capabilities = client.getServerCapabilities() || {};

  async function listAll(method, key) {
    const out = [];
    let cursor;
    for (let page = 0; page < BOUNDS.MAX_LIST_PAGES; page += 1) {
      const result = await method(cursor ? { cursor } : {});
      const items = result?.[key] || [];
      out.push(...items);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return pageLimit(out);
  }

  async function listTools() {
    if (capabilities.tools === undefined && !capabilities.tools) {
      try {
        const tools = await listAll((params) => client.listTools(params), 'tools');
        return tools.map((tool) => ({
          ...tool,
          description: sanitizeToolDescription(tool.description).text,
        }));
      } catch (error) {
        if (/not (supported|available)|method not found/i.test(String(error?.message || ''))) return [];
        throw error;
      }
    }
    const tools = await listAll((params) => client.listTools(params), 'tools');
    return tools.map((tool) => ({
      ...tool,
      description: sanitizeToolDescription(tool.description).text,
    }));
  }

  async function callTool({ name, arguments: args, taskId, runId, connectionId, signal: callSignal } = {}) {
    const s = callSignal || signal;
    if (s?.aborted) {
      const err = new Error('aborted');
      err.code = 'aborted';
      throw err;
    }
    const result = await client.callTool(
      { name, arguments: args && typeof args === 'object' ? args : {} },
      undefined,
      { timeout: BOUNDS.REQUEST_TIMEOUT_MS, signal: s },
    );
    if (s?.aborted) {
      const err = new Error('aborted');
      err.code = 'aborted';
      throw err;
    }
    return wrapUntrustedObservation(result, { connectionId, toolName: name });
  }

  async function listResources() {
    if (!capabilities.resources) return { resources: [], unsupported: true };
    try {
      const resources = await listAll((params) => client.listResources(params), 'resources');
      return { resources, unsupported: false };
    } catch (error) {
      return { resources: [], unsupported: true, error: String(error?.message || error) };
    }
  }

  async function readResource({ uri }) {
    if (!capabilities.resources) return wrapUntrustedResource({ unsupported: true });
    const result = await client.readResource({ uri: String(uri || '') });
    return wrapUntrustedResource(result);
  }

  async function listPrompts() {
    if (!capabilities.prompts) return { prompts: [], unsupported: true };
    try {
      const prompts = await listAll((params) => client.listPrompts(params), 'prompts');
      return { prompts, unsupported: false };
    } catch (error) {
      return { prompts: [], unsupported: true, error: String(error?.message || error) };
    }
  }

  async function getPrompt({ name, arguments: args } = {}) {
    if (!capabilities.prompts) return wrapUntrustedPrompt({ unsupported: true });
    const result = await client.getPrompt({
      name: String(name || ''),
      arguments: args && typeof args === 'object' ? args : undefined,
    });
    return wrapUntrustedPrompt(result);
  }

  async function close() {
    try {
      await transport.terminateSession?.();
    } catch {
      /* 405 is allowed */
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }

  return {
    client,
    transport,
    serverInfo,
    capabilities,
    protocolVersion: transport.protocolVersion || null,
    listTools,
    callTool,
    listResources,
    readResource,
    listPrompts,
    getPrompt,
    close,
  };
}

export { classifyConnectError, UnauthorizedError, createGuardedFetch };
