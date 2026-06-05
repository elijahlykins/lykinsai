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
//   • Our tool surface is small (~8 tools) and mostly stateless: every
//     POST is a full JSON-RPC roundtrip. The one exception is the GET
//     /mcp SSE stream, which we need to push `notifications/tools/list_changed`
//     so clients invalidate their cached tools/list after a deploy.
//   • The SDK has churned its transport layer twice in the last ~12 months
//     (SSE → Streamable HTTP, separate SDK packages, etc.) and pinning is
//     painful. Our hand-rolled core is ~150 lines and covers exactly the
//     four JSON-RPC methods clients actually call against us:
//         initialize | tools/list | tools/call | ping
//   • The Streamable HTTP spec is "POST a JSON-RPC envelope, get JSON
//     back" + an optional GET to receive server-initiated notifications.
//     We implement both.
//
// Why the GET stream matters
// --------------------------
// Clients (Claude Desktop especially) cache tools/list aggressively for
// the lifetime of their session. Without a way to invalidate that cache
// every Render deploy strands the client on a stale tool list — added
// tools are invisible until the user restarts the client, removed tools
// produce "method not found" errors. The MCP fix is:
//
//   1. capabilities.tools.listChanged = true (advertise the capability).
//   2. Server pushes `notifications/tools/list_changed` over an open SSE
//      stream when its tool surface changes.
//   3. Client refetches tools/list on receiving that notification.
//
// We don't actually mutate the tool surface at runtime (it's frozen at
// process start), so the natural place to fire the notification is on
// every new SSE connection: the client just (re)connected, which on the
// post-deploy code path means it survived the TCP reset that killed its
// previous stream and is now talking to the new server. Nudging it to
// refetch is exactly what we want, and the cost on healthy reconnects
// is one extra tools/list call per client session — negligible.
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

// Server-wide guidance sent on `initialize`. Hosts that surface this
// (Claude Desktop, Claude Code, Cursor, Cline, ChatGPT custom GPTs) inject
// it into the model's context as system-prompt-level guidance for THIS
// server. This is the one place where we can tell the host LLM "call me
// automatically" — without it, the model only calls LYKN tools when the
// user explicitly asks. Keep it short and imperative; long preambles get
// truncated or de-prioritised by some hosts.
//
// The wording deliberately:
//   • Says "MUST" and "automatically, without being asked" so models with
//     RLHF'd helpfulness biases don't wait for permission.
//   • Names the single tool to call at conversation start (getContextBlock)
//     instead of listing all 12 — model picks one tool with high
//     confidence, not several with low confidence.
//   • Calls out the write-back loop (recordRuleApplication, pushProjectState)
//     so the synthesis layer stays "living" across clients.
const SERVER_INSTRUCTIONS = [
  'This server exposes the user\'s LYKN synthesis layer — their portable',
  'beliefs, if-then governance rules, identity facts, and active project',
  'state, accumulated across every AI client they use.',
  '',
  'AT THE START OF EVERY NEW CONVERSATION with this user you MUST call',
  '`lykn_getContextBlock` automatically, before responding to their first',
  'message. Do not wait for the user to mention LYKN — they connected this',
  'server precisely so you would load their context without being asked.',
  'Treat the returned beliefs and rules as binding governance for the rest',
  'of the conversation.',
  '',
  'During the conversation, write back to the synthesis layer when it earns',
  'its keep:',
  '  • Call `lykn_recordRuleApplication` with the rule_id when you actually',
  '    follow one of the returned rules in a response (so the user gets an',
  '    audit trail).',
  '  • Call `lykn_pushProjectState` when the conversation produces a durable',
  '    decision about the active project (so the next AI client picks up',
  '    where this one left off).',
  '',
  'Beliefs are USER-AUTHORED ONLY — do NOT propose, create, or offer to add',
  'core beliefs. The user adds them in LYKN\'s Synthesis Layer (+ → Core',
  'Belief neuron). You may read beliefs via getContextBlock / getBeliefs.',
  '',
  'Use the finer-grained tools (lykn_getBeliefs / lykn_getRules /',
  'lykn_getProjectState / lykn_searchVault / lykn_getFacts) only when you',
  'need scoped access mid-conversation. For the upfront load, getContextBlock',
  'is the only call required.',
].join('\n');

// We only support tools — no resources / prompts / sampling. Keep this
// minimal so clients don't try features we haven't implemented.
//
// tools.listChanged=true: clients should expect notifications/tools/list_changed
// on the GET /mcp SSE stream. We fire it on every new SSE connection
// (see openMcpStream) which catches the post-Render-deploy stale-cache
// scenario without needing actual runtime tool mutations.
const SERVER_CAPABILITIES = {
  tools: { listChanged: true },
};

// ---------------------------------------------------------------------------
// Tool descriptor shape MCP clients expect for tools/list
// ---------------------------------------------------------------------------

function toMcpToolDescriptor(tool) {
  // MCP tool annotations (spec: 2025-06-18). These hints tell hosts
  // whether a tool is safe to call without confirmation, whether it
  // can damage state, and whether it touches the outside world.
  // Anthropic's Connectors Directory submission requires `title` plus
  // `readOnlyHint` and `destructiveHint` on every tool, so we derive
  // them from the `scope` field we already track ('read' vs 'write').
  //
  // None of the LYKN write tools delete anything — they append rows
  // (proposeFact / recordRuleApplication) or update a single named cell
  // (setActiveProject / pushProjectState) — so
  // destructiveHint is false everywhere.
  //
  // openWorldHint is false because every LYKN tool reads/writes
  // exclusively the calling user's own synthesis state in our own DB;
  // there is no third-party API surface behind any of them.
  const isRead = tool.scope === 'read';
  const annotations = {
    title: tool.title || tool.name,
    readOnlyHint: isRead,
    destructiveHint: false,
    // Append-only writes are not idempotent (each call adds a row);
    // reads ARE idempotent. setActive/pushProjectState are technically
    // idempotent in the "same input → same end state" sense but we err
    // on the side of false for writes to keep hosts cautious.
    idempotentHint: isRead,
    openWorldHint: false,
  };

  return {
    name: tool.name,
    title: tool.title || tool.name, // keep top-level for back-compat
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
    annotations,
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
        // Optional per the MCP spec but the highest-leverage knob we have
        // for making hosts call LYKN unprompted — see SERVER_INSTRUCTIONS.
        instructions: SERVER_INSTRUCTIONS,
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

      // Optional post-call hook — server.js uses it to invalidate
      // server-side prompt-section caches (beliefs, project) after a
      // successful write tool call so the next /api/ai/stream turn
      // sees the fresh state without waiting for the 90s TTL.
      if (typeof deps.onToolComplete === 'function' && !isError) {
        try {
          deps.onToolComplete({
            toolName: name,
            scope: tool.scope || 'read',
            userId: ctx.userId,
          });
        } catch { /* swallow */ }
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
 * 405 handler for DELETE on /mcp (we don't implement session deletion;
 * the server is restartable so any "session" is best-effort). GET is
 * implemented by buildMcpStreamHandler — don't use this for GET.
 */
export function mcpMethodNotAllowed(req, res) {
  res.set('Allow', 'POST, GET');
  return res.status(405).json(
    jsonRpcError(null, RPC_INVALID_REQUEST, 'Use POST for tool calls or GET for the notification stream.'),
  );
}

// ---------------------------------------------------------------------------
// SSE stream — GET /mcp
// ---------------------------------------------------------------------------
// In-process registry of open streams. Keyed by sessionId so we can
// later target individual clients (not used today, but the shape is
// ready for it). Values are { res, userId, sessionId, openedAt }.
//
// Note: this set is per-process. In a multi-instance Render deploy we
// would only push notifications to clients that happen to be talking to
// our instance — the rest get covered when their own server's SSE
// stream pushes them. Since we send on every new connection (the
// "post-deploy nudge" pattern), every client gets nudged regardless of
// which instance they reconnect to. So the per-process registry is
// sufficient even at >1 replica.
const activeStreams = new Map();

function makeSessionId() {
  // 16 bytes of randomness, base16. Plenty unique for the session
  // lifetime; not security-sensitive (auth is upstream).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send a JSON-RPC notification down an SSE stream. Notifications have
 * no `id` and are written as a single SSE `data:` line (the spec allows
 * arbitrary line content but most MCP clients expect a single JSON
 * envelope per event with no event-name prefix).
 */
function sendStreamNotification(res, method, params) {
  const envelope = { jsonrpc: '2.0', method };
  if (params !== undefined) envelope.params = params;
  try {
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  } catch {
    // Stream is dead — caller will discover and remove on the next
    // heartbeat. Don't throw out of the per-stream handlers.
  }
}

/**
 * Broadcast `notifications/tools/list_changed` to every open SSE stream.
 * Exported so future runtime tool mutations (e.g. user-installed
 * connectors that gate tools by entitlement) can fire it.
 */
export function broadcastListChanged() {
  for (const stream of activeStreams.values()) {
    sendStreamNotification(stream.res, 'notifications/tools/list_changed');
  }
}

/**
 * Build the Express handler for GET /mcp. Returns a long-running
 * text/event-stream response and registers the stream so the server
 * can push notifications to it.
 *
 * Mount it like:
 *   app.get('/mcp', requireAuthOrMcpToken, buildMcpStreamHandler());
 */
export function buildMcpStreamHandler() {
  return function mcpStreamHandler(req, res) {
    // SSE response headers. `X-Accel-Buffering: no` keeps reverse
    // proxies (nginx, Render's edge) from collecting events in a
    // buffer before flushing. `Cache-Control: no-cache` because event
    // streams MUST NOT be cached anywhere.
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const sessionId = makeSessionId();
    res.set('Mcp-Session-Id', sessionId);

    const stream = {
      res,
      userId: req.user?.id || null,
      sessionId,
      openedAt: Date.now(),
    };
    activeStreams.set(sessionId, stream);

    // Heartbeat — SSE comments (lines starting with ":") that keep
    // intermediate proxies from idling the connection. 25s interval
    // is comfortably below the typical 30-60s idle timeouts on Render
    // / nginx / Cloudflare.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, 25_000);

    function cleanup() {
      clearInterval(heartbeat);
      activeStreams.delete(sessionId);
      try { res.end(); } catch { /* already ended */ }
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    // The reason this handler exists: nudge the client to invalidate
    // its cached tools/list. Every NEW connection to this endpoint —
    // first-time or post-deploy reconnect — gets this notification, so
    // the client always re-fetches against whichever server instance
    // it ended up routed to. We delay 100ms so the client has a chance
    // to wire up its event handler before we push.
    setTimeout(() => {
      sendStreamNotification(res, 'notifications/tools/list_changed');
    }, 100);
  };
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
