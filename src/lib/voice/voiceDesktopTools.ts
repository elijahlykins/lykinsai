/**
 * Voice-mode desktop tools (ask_bot, browser_agent).
 *
 * Same execution as Chat's local_ask_bot / local_browser_agent: bots live in
 * the renderer store, the browser agent starts through the Electron bridge.
 * Voice intercepts these names in the client instead of POSTing
 * /api/ai/realtime/tool — the server cannot run them.
 */
import { askBot } from "@/lib/bots/askBot";
import { getBots } from "@/lib/bots/botsClient";
import { runLocalToolNow, startBrowserAgentTask } from "@/lib/ai/localToolExecutor";

export const VOICE_ASK_BOT_TOOL = "ask_bot";
export const VOICE_BROWSER_AGENT_TOOL = "browser_agent";

export function isDesktopVoiceClient(): boolean {
  try {
    const api = (globalThis as { lykn?: { studioAgentSend?: unknown } }).lykn;
    return typeof api?.studioAgentSend === "function";
  } catch {
    return false;
  }
}

export function snapshotLyknBots(): { id: string; name: string; role?: string }[] {
  try {
    return getBots()
      .slice(0, 40)
      .map((bot) => ({
        id: String(bot.id || "").trim(),
        name: String(bot.name || "").trim(),
        ...(bot.role ? { role: String(bot.role).trim() } : {}),
      }))
      .filter((bot) => bot.id && bot.name);
  } catch {
    return [];
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
  if (name === VOICE_ASK_BOT_TOOL) {
    const result = await askBot({ ...args, wait: false });
    return JSON.stringify(result);
  }
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
