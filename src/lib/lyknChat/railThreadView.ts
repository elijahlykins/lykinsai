/**
 * Side-rail thread view rules. Streaming still lives in chatThreadRuntime /
 * the Home typewriter; this only decides what the compact rail paints.
 */

export function railShowsWaitingIndicator(opts: {
  loading: boolean;
  lastAiResponse?: string | null;
}): boolean {
  if (!opts.loading) return false;
  return !String(opts.lastAiResponse || "").trim();
}
