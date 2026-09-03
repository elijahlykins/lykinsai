/**
 * LYKN (main chat) asks a desktop bot and waits for the report.
 *
 * Bots live in the renderer store and run through botsClient.assign.
 * This is the client side of local_ask_bot - the server only relays.
 */
import { assign, getBots } from "@/lib/bots/botsClient";
import { findBotByName } from "@/lib/bots/botStore";
import { presentBotInCurrentChat, waitForBotTask } from "@/lib/bots/botChatBridge";

export const ASK_BOT_WAIT_MS = 4 * 60 * 1000;

export type AskBotResult = {
  ok: boolean;
  bot?: string;
  role?: string;
  reply?: string;
  parked?: boolean;
  note?: string;
  error?: string;
};

export function formatConsultMessage(message: string): string {
  const ask = String(message || "").trim();
  return [
    "The user asked LYKN (their main assistant) to consult you. Answer completely so LYKN can report back. Do not hand this to another teammate.",
    "",
    ask,
  ].join("\n");
}

export function formatDispatchMessage(message: string): string {
  const ask = String(message || "").trim();
  return [
    "The user asked LYKN (their main assistant) to send you this work. Do it completely. Use the browser when the job is on a website. Do not hand this to another teammate unless you need one.",
    "",
    ask,
  ].join("\n");
}

function wantsWait(value: unknown): boolean {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return true;
}

export async function askBot(args: {
  name?: unknown;
  message?: unknown;
  wait?: unknown;
}): Promise<AskBotResult> {
  const name = String(args.name || "").trim();
  const message = String(args.message || "").trim();
  const wait = wantsWait(args.wait);
  if (!name) return { ok: false, error: "No bot name. Use one of the user's LYKN bots." };
  if (!message) return { ok: false, error: "No question to send the bot." };

  const bot = findBotByName(getBots(), name);
  if (!bot) {
    const names = getBots().map((b) => b.name).filter(Boolean);
    return {
      ok: false,
      error: names.length
        ? `No bot named "${name}". Available: ${names.join(", ")}.`
        : "The user has no LYKN bots yet.",
    };
  }

  const sent = assign(bot.id, wait ? formatConsultMessage(message) : formatDispatchMessage(message));
  if (!sent) {
    return { ok: false, error: `${bot.name} isn't available right now.` };
  }

  // Stream their work into THIS chat so the user can watch without hopping
  // to the bot's private board.
  presentBotInCurrentChat({
    botId: bot.id,
    taskId: sent.taskId,
    question: message,
  });

  if (!wait) {
    return {
      ok: true,
      bot: bot.name,
      role: bot.role || "",
      note:
        `${bot.name} is now working in this chat. Tell the user they're underway and can watch. ` +
        `Do not say you cannot reach ${bot.name}.`,
    };
  }

  const settled = await waitForBotTask(bot.id, sent.taskId, { timeoutMs: ASK_BOT_WAIT_MS });
  const reply = String(settled.text || "").trim();
  if (settled.timedOut) {
    return {
      ok: false,
      bot: bot.name,
      error:
        `${bot.name} is still working in this chat. Tell the user their answer is underway - ` +
        `you already asked them, so do not say you cannot reach ${bot.name}.`,
    };
  }
  if (settled.failed) {
    return { ok: false, bot: bot.name, error: reply || `${bot.name} failed.` };
  }
  return {
    ok: true,
    bot: bot.name,
    role: bot.role || "",
    reply: reply || "Done.",
    note:
      `${bot.name} answered in this chat. Summarize their view for the user. ` +
      `Do not tell the user to open ${bot.name}'s chat.`,
  };
}
