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
