/** Client inactivity window. Must not be stricter than the server's
 *  longToolTurn stall (240s): Electron/proxy buffering can swallow SSE
 *  comment keepalives, and a 90s abort then kills a healthy build or
 *  local-tool wait. */
export const STREAM_INACTIVITY_SHORT_MS = 90_000;
export const STREAM_INACTIVITY_LONG_MS = 240_000;

export function streamInactivityMs(
  p: { composerMode?: string; buildWorkspace?: boolean },
  opts: { localToolInFlight?: boolean } = {},
): number {
  if (opts.localToolInFlight) return STREAM_INACTIVITY_LONG_MS;
  const mode = String(p.composerMode || "");
  if (
    mode === "research" ||
    mode === "image" ||
    mode.startsWith("create:") ||
    p.buildWorkspace === true
  ) {
    return STREAM_INACTIVITY_LONG_MS;
  }
  return STREAM_INACTIVITY_SHORT_MS;
}
