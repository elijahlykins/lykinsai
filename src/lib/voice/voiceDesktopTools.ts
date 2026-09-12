/**
 * Voice-mode desktop tools (browser_agent, local_*).
 *
 * Same execution as Chat's local_browser_agent: the browser agent starts
 * through the Electron bridge. Voice intercepts these names in the client
 * instead of POSTing /api/ai/realtime/tool — the server cannot run them.
 */
import { runLocalToolNow, startBrowserAgentTask } from "@/lib/ai/localToolExecutor";

export const VOICE_BROWSER_AGENT_TOOL = "browser_agent";

export function isDesktopVoiceClient(): boolean {
  try {
    const api = (globalThis as { lykn?: { studioAgentSend?: unknown } }).lykn;
    return typeof api?.studioAgentSend === "function";
  } catch {
    return false;
  }
}

export function isVoiceLocalTool(name: string): boolean {
  return name.startsWith("local_");
}

export async function runVoiceDesktopTool(
  name: string,
  params: unknown,
  host?: { chatId?: string | null },
): Promise<string | null> {
  const args = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  if (name === VOICE_BROWSER_AGENT_TOOL) {
    const result = await startBrowserAgentTask(args, host);
    return JSON.stringify(result);
  }
  if (isVoiceLocalTool(name)) {
    const result = await runLocalToolNow(name, args, host);
    return JSON.stringify(result);
  }
  return null;
}
