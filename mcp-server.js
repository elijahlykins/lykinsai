// ============================================================================
// mcp-server.js — Streamable HTTP MCP server for the LYKN synthesis layer
// ============================================================================
// Implements the Model Context Protocol (MCP) over Streamable HTTP so any
// MCP-aware AI client — Claude Desktop, Claude Code, Cursor, Cline, ChatGPT
// connectors, etc. — can authenticate with a per-user `lkn_live_…` bearer
// token and read/write the user's synthesis layer (beliefs, rules, facts,
// vault, attributions).
//
// Why hand-rolled instead of @modelcontextprotocol/sdk?
//   • Our tool surface is small (~8 tools) and stateless: every request is
//     a full JSON-RPC roundtrip. No streaming, no notifications back to
//     the client, no resource subscriptions.
//   • The SDK has churned its transport layer twice in the last ~12 months
//     (SSE → Streamable HTTP, separate SDK packages, etc.) and pinning is
//     painful. Our hand-rolled core is ~150 lines and covers exactly the
//     four JSON-RPC methods clients actually call against us:
//         initialize | tools/list | tools/call | ping
//   • The Streamable HTTP spec is "POST a JSON-RPC envelope, get JSON
//     back." That's it for stateless servers. We don't need the rest.
//
// Auth shape
// ----------
// /mcp is mounted in server.js wrapped in `requireAuthOrMcpToken`. By the
// time the request arrives here, `req.user.id` is the LYKN user id and
// `req.mcpAuth` (if MCP-token) carries scopes + clientKind. The handler
// builds a `ctx` object and dispatches to the matching tool from
// mcp-tools/.
//
// Logging
// -------
// Every tool call emits one `ai_usage_logs` row via the existing
// usageTracking.logAiUsage path with action_type='mcp_tool' so the admin
// dashboard surfaces MCP traffic alongside regular AI usage.

import { MCP_TOOLS, MCP_TOOLS_BY_NAME, errorContent } from './mcp-tools/index.js';
import { attributionSurfaceForClientKind } from './mcp-service.js';

// Protocol version we advertise. The Streamable HTTP transport itself is
// stable; the higher-level capability negotiation is keyed by date string.
const MCP_PROTOCOL_VERSION = '2025-03-26';

// JSON-RPC error codes (subset we use). Stick to the standard ones so
// MCP clients don't trip on weird codes.
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Server info advertised on `initialize`
// ---------------------------------------------------------------------------

const SERVER_INFO = {
  name: 'lykn-synthesis',
  title: 'LYKN — Synthesis Layer',
  version: '0.1.0',
};

// We only support tools — no resources / prompts / sampling. Keep this
// minimal so clients don't try features we haven't implemented. Tools
// listChanged=false because our tool surface is static per server start.
const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
};

// ---------------------------------------------------------------------------
// Tool descriptor shape MCP clients expect for tools/list
// ---------------------------------------------------------------------------

function toMcpToolDescriptor(tool) {
  return {
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
  };
}

const TOOL_DESCRIPTORS = MCP_TOOLS.map(toMcpToolDescriptor);

// ---------------------------------------------------------------------------
// JSON-RPC envelope helpers
// ---------------------------------------------------------------------------

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function isNotification(msg) {
  // JSON-RPC notifications have no `id`. We never need to respond.
  return msg && typeof msg === 'object' && !('id' in msg) && typeof msg.method === 'string';
}

// ---------------------------------------------------------------------------
// Per-request context — built fresh per HTTP request
// ---------------------------------------------------------------------------

function buildContext(req) {
  const userId = req.user?.id || null;
  const mcpAuth = req.mcpAuth || null;
  const clientLabel = String(req.headers['user-agent'] || req.headers['mcp-client-info'] || '').slice(0, 240);
  // attribSurface is the value `recordRuleApplication` will stamp on
  // any attribution this client writes during the request. JWT clients
  // (= the LYKN web app reaching its own /mcp route) get 'lykn-chat',
  // matching what the in-LYKN <applied> tag funnel uses, so the admin
  // surface breakdown stays single-source-of-truth.
  const attribSurface = mcpAuth
    ? attributionSurfaceForClientKind(mcpAuth.clientKind, 'mcp')
    : 'lykn-chat';
  return {
    supabaseAdmin: req.app.get('supabaseAdmin'),
    userId,
    mcpAuth,
    clientLabel,
    attribSurface,
    tokenId: mcpAuth?.tokenId || null,
  };
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

async function handleRpc(message, req, deps) {
  const id = message?.id ?? null;
  const method = message?.method;
  const params = message?.params || {};

  if (typeof method !== 'string') {
    return jsonRpcError(id, RPC_INVALID_REQUEST, 'method must be a string');
  }

  switch (method) {
    case 'initialize': {
      // Echo back the protocol version the client asked for if it's one
      // we recognise; otherwise return ours. Most clients (Claude Desktop,
      // Cursor) accept either.
      const requested = String(params?.protocolVersion || '').trim();
      const protocolVersion = requested || MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    }

    case 'ping': {
      // MCP "are you alive" probe — no payload, just an empty result.
      return jsonRpcResult(id, {});
    }

    case 'tools/list': {
      return jsonRpcResult(id, {
        tools: TOOL_DESCRIPTORS,
        // We don't paginate (8 tools, full descriptor < 5KB) so omit
        // nextCursor entirely — clients treat that as "done".
      });
    }

    case 'tools/call': {
      const name = String(params?.name || '');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const tool = MCP_TOOLS_BY_NAME[name];
      if (!tool) {
        return jsonRpcError(id, RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }

      const ctx = buildContext(req);
      if (!ctx.userId) {
        // Should never happen because requireAuthOrMcpToken gates /mcp,
        // but defense-in-depth.
        return jsonRpcError(id, RPC_INVALID_REQUEST, 'Unauthenticated');
      }

      const startedAt = Date.now();
      let result;
      let isError = false;
      let errMessage = null;
      try {
        result = await tool.handler(args, ctx);
        isError = Boolean(result?.isError);
      } catch (err) {
        const msg = err?.message || String(err);
        console.error(`[mcp:${name}] handler threw:`, msg);
        result = errorContent(msg);
        isError = true;
        errMessage = msg;
      }
      const latencyMs = Date.now() - startedAt;

      // Telemetry — fire-and-forget. logAiUsage is pre-existing
      // infrastructure that lands rows in `ai_usage_logs`, which the
      // admin /admin/usage tab already surfaces. We piggyback on it
      // rather than minting a parallel mcp-only log table.
      if (typeof deps.logUsage === 'function') {
        Promise.resolve()
          .then(() => deps.logUsage({
            userId: ctx.userId,
            actionType: 'mcp_tool',
            model: name,
            provider: 'mcp',
            inputTokens: 0,
            outputTokens: 0,
            metadata: {
              tool: name,
              client_kind: ctx.mcpAuth?.clientKind || 'lykn-chat',
              client_label: ctx.clientLabel,
              token_id: ctx.tokenId,
              latency_ms: latencyMs,
              ok: !isError,
              error: errMessage,
              transport: 'mcp',
            },
          }))
          .catch(() => { /* swallow — telemetry is non-critical */ });
      }

      return jsonRpcResult(id, result);
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      // We don't act on these — return null so the caller sees a notification
      // and skips writing a response. Real notifications never have an id.
      return null;
    }

    default: {
      return jsonRpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Express handler — POST /mcp
// ---------------------------------------------------------------------------

/**
 * Build the Express handler for the /mcp endpoint. Pass in any deps you
 * want injected per request (currently just the usage logger).
 *
 *   buildMcpHandler({ logUsage: ({ userId, ... }) => Promise<void> })
 *
 * Mount it like:
 *   app.post('/mcp', requireAuthOrMcpToken, buildMcpHandler({ logUsage }));
 *
 * GET / DELETE on /mcp aren't supported (we're stateless). 405 them with
 * an `Allow: POST` header so well-behaved clients fall back to POST.
 */
export function buildMcpHandler(deps = {}) {
  return async function mcpHandler(req, res) {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res
          .status(400)
          .json(jsonRpcError(null, RPC_PARSE_ERROR, 'Body must be a JSON-RPC envelope'));
      }

      // Batched calls: an array of envelopes. Spec says batched requests
      // are deprecated in 2025-06-18 but Cursor and a few others still
      // emit them, so handle both.
      if (Array.isArray(body)) {
        const responses = [];
        for (const msg of body) {
          if (isNotification(msg)) {
            // Notifications: handled but never reply.
            try { await handleRpc(msg, req, deps); } catch { /* ignore */ }
            continue;
          }
          let resp;
          try {
            resp = await handleRpc(msg, req, deps);
          } catch (err) {
            resp = jsonRpcError(msg?.id ?? null, RPC_INTERNAL_ERROR, err?.message || 'Internal error');
          }
          if (resp) responses.push(resp);
        }
        // Empty array = all notifications. Per spec, return 204.
        if (!responses.length) return res.status(204).end();
        return res.status(200).json(responses);
      }

      if (isNotification(body)) {
        try { await handleRpc(body, req, deps); } catch { /* ignore */ }
        return res.status(204).end();
      }

      const resp = await handleRpc(body, req, deps);
      if (!resp) return res.status(204).end();
      return res.status(200).json(resp);
    } catch (err) {
      console.error('[mcp] handler crash:', err?.message || err);
      // Never let a crash leak as HTML — MCP clients are JSON-only.
      return res
        .status(500)
        .json(jsonRpcError(null, RPC_INTERNAL_ERROR, 'Internal server error'));
    }
  };
}

/**
 * 405 handler for GET/DELETE on /mcp. Mount with:
 *   app.get('/mcp', mcpMethodNotAllowed);
 *   app.delete('/mcp', mcpMethodNotAllowed);
 */
export function mcpMethodNotAllowed(req, res) {
  res.set('Allow', 'POST');
  return res.status(405).json(
    jsonRpcError(null, RPC_INVALID_REQUEST, 'Use POST. /mcp is a stateless JSON-RPC endpoint.'),
  );
}

// ---------------------------------------------------------------------------
// Discovery descriptor — exposed at /.well-known/mcp.json (optional)
// ---------------------------------------------------------------------------

/**
 * Some MCP installer flows poll a discovery endpoint before configuring.
 * This object is the canonical "what does LYKN expose?" payload.
 */
export const MCP_DISCOVERY = {
  protocol: 'mcp',
  protocolVersion: MCP_PROTOCOL_VERSION,
  transport: 'streamable-http',
  endpoint: '/mcp',
  authentication: {
    type: 'bearer',
    tokenPrefix: 'lkn_live_',
    issueAt: '/connections',
  },
  serverInfo: SERVER_INFO,
  capabilities: SERVER_CAPABILITIES,
  tools: TOOL_DESCRIPTORS.map((t) => ({ name: t.name, title: t.title, description: t.description.split('\n')[0] })),
};
