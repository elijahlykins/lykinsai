// Local Mode bridge. `localToolStreams` is a process singleton shared by
// `/api/ai/stream` and `/api/ai/local-tool-result`. Do not instantiate per request.
// ---------------------------------------------------------------------------
// Local Mode — pending client-executed tool calls.
// ---------------------------------------------------------------------------
// Local tools (file / terminal) run in the user's desktop app, not here. When
// the agent loop hits a local tool call it registers a pending entry keyed by
// a per-turn streamId, emits an `awaiting_client` tool_call event, and awaits
// the result the desktop posts back to /api/ai/local-tool-result. Entries are
// scoped to the authenticated user and time out with the turn.
export const LOCAL_TOOL_WAIT_MS = 5 * 60 * 1000;
export const localToolStreams = new Map(); // streamId → { userId, pending: Map<toolCallId, resolve> }

export function registerLocalToolStream(streamId, userId) {
  localToolStreams.set(streamId, { userId, pending: new Map() });
}

export function releaseLocalToolStream(streamId) {
  const entry = localToolStreams.get(streamId);
  if (!entry) return;
  for (const resolve of entry.pending.values()) {
    try { resolve({ ok: false, error: 'Local mode stream closed before the tool finished.' }); } catch { /* noop */ }
  }
  localToolStreams.delete(streamId);
}

export function resolveLocalToolResult(streamId, userId, toolCallId, result) {
  const entry = localToolStreams.get(streamId);
  if (!entry || entry.userId !== userId) return false;
  const resolve = entry.pending.get(toolCallId);
  if (!resolve) return false;
  entry.pending.delete(toolCallId);
  try { resolve(result && typeof result === 'object' ? result : { ok: false, error: 'malformed local tool result' }); } catch { /* noop */ }
  return true;
}

/**
 * The agent-loop awaiter for one client-executed tool call: emit
 * `awaiting_client`, register the pending resolver, and settle with whatever
 * the desktop posts back (or a timeout). Lives here because it is the only
 * writer of the pending map besides the result relay above.
 */
export function makeAwaitLocalTool({ streamId, noteStreamActivity }) {
  return (call, record) =>
    new Promise((resolve) => {
      const start = Date.now();
      const finish = (payload) => {
        const result = payload && typeof payload === 'object'
          ? payload
          : { ok: false, error: 'malformed local tool result' };
        const isError = result.ok === false;
        console.log(
          `🖥️ local tool ${call.name} ← ${isError ? `ERROR: ${String(result.error || '').slice(0, 120)}` : 'ok'} (${Date.now() - start}ms)`,
        );
        record({
          id: call.id,
          name: call.name,
          args: call.args,
          status: isError ? 'error' : 'done',
          result,
          latencyMs: Date.now() - start,
        });
        resolve({ payload: result, isError, latencyMs: Date.now() - start });
      };
      const entry = localToolStreams.get(streamId);
      if (!entry) {
        finish({ ok: false, error: 'Local mode session is no longer active.' });
        return;
      }
      // Tell the desktop client to run this tool now.
      console.log(`🖥️ local tool ${call.name} → awaiting desktop client`);
      record({
        id: call.id,
        name: call.name,
        args: call.args,
        status: 'awaiting_client',
        localStreamId: streamId,
      });
      noteStreamActivity?.();
      const timer = setTimeout(() => {
        entry.pending.delete(call.id);
        finish({ ok: false, error: 'The desktop app did not return a result in time.' });
      }, LOCAL_TOOL_WAIT_MS);
      entry.pending.set(call.id, (posted) => {
        clearTimeout(timer);
        finish(posted);
      });
    });
}

/**
 * Consequential MCP tools (send email, delete, share) pause for live
 * approval. Ships the approval card over the same result channel local tools
 * use; resolves true only when the user approved in time.
 */
export function makeRequestMcpApproval({ streamId, sendToolCall, noteStreamActivity }) {
  return ({ toolName, request } = {}) =>
    new Promise((resolve) => {
      const entry = localToolStreams.get(streamId);
      if (!entry) return resolve(false);
      const approvalCallId = `mcpapproval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      console.log(`🔐 MCP approval → awaiting user (${toolName || 'tool'})`);
      sendToolCall({
        id: approvalCallId,
        name: 'mcp_approval',
        args: {},
        status: 'awaiting_approval',
        localStreamId: streamId,
        approval: request || { title: 'Allow this action in your connected app?' },
      });
      noteStreamActivity?.();
      const timer = setTimeout(() => {
        entry.pending.delete(approvalCallId);
        sendToolCall({ id: approvalCallId, name: 'mcp_approval', status: 'done', result: { approved: false, timedOut: true } });
        resolve(false);
      }, LOCAL_TOOL_WAIT_MS);
      entry.pending.set(approvalCallId, (posted) => {
        clearTimeout(timer);
        const approved = posted?.approved === true;
        console.log(`🔐 MCP approval ← ${approved ? 'approved' : 'declined'} (${toolName || 'tool'})`);
        sendToolCall({ id: approvalCallId, name: 'mcp_approval', status: 'done', result: { approved } });
        noteStreamActivity?.();
        resolve(approved);
      });
    });
}
