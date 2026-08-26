/**
 * Teammates — named, always-on bots layered over the agent runtime.
 *
 * A Bot is a durable persona (name, role, working style) paired with one
 * worker agent from electron/agentRuntime.cjs. The runtime runs one turn per
 * agent at a time, so each bot carries its own task queue here: assign work
 * while the bot is busy and it dispatches automatically when the current
 * task finishes. This module is the pure model — no window.*, no IPC — so
 * the queue rules are testable on their own.
 */
import { INK_DEFAULT_ID, INKS } from "@/lib/appearance";

export type BotTaskStatus = "queued" | "running" | "done" | "failed";

export type BotTask = {
  id: string;
  /** Canonical main-process Task identity once dispatch is accepted. */
  runtimeTaskId?: string;
  runId?: string;
  text: string;
  status: BotTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Final agent reply (or error note) once the task leaves the queue. */
  result?: string;
};

export type Bot = {
  id: string;
  name: string;
  /** Job title shown under the name, e.g. "Research Analyst". */
  role: string;
  /** Working-style instructions folded into the bot's first briefing. */
  persona: string;
  /** Visual identity — an animated character: head, eyes, and a color ink. */
  face: string;
  eyes: string;
  color: string;
  /** Paired worker agent in the runtime; null until first hire/dispatch. */
  agentId: string | null;
  /** The bot's own chat board — every conversation with it lives there. */
  chatId: string;
  /**
   * When the CURRENT board became the bot's home ("" = since forever).
   * "New chat" re-homes the bot onto a fresh board and stamps this, so
   * surfaces can tell tasks on this board from ones on retired boards —
   * a bot whose current chat is empty stays out of the chat bar strip.
   */
  chatStartedAt: string;
  createdAt: string;
  tasks: BotTask[];
};

/* ── Faces — the animated characters a user builds from parts ────────────── */

// Ids only; BotAvatar draws each as procedural SVG (soft blob-shape body,
// eye style, blink/bob/scan animation) — the same token/glyph split
// CHAT_SEND_ICONS uses so this module never imports components.
export type BotPartOption = { id: string; name: string };

export const BOT_FACES: BotPartOption[] = [
  { id: "blob", name: "Blob" },
  { id: "square", name: "Square" },
  { id: "squircle", name: "Squircle" },
  { id: "circle", name: "Circle" },
  { id: "triangle", name: "Triangle" },
  { id: "hex", name: "Hex" },
  { id: "cloud", name: "Cloud" },
  { id: "drop", name: "Drop" },
  { id: "flower", name: "Flower" },
  { id: "diamond", name: "Diamond" },
  { id: "egg", name: "Egg" },
  { id: "pebble", name: "Pebble" },
  { id: "ghost", name: "Ghost" },
];

export const BOT_EYES: BotPartOption[] = [
  { id: "dot", name: "Dots" },
  { id: "bar", name: "Bars" },
  { id: "arc", name: "Happy" },
];

export function botFaceId(id: string | null | undefined): string {
  return BOT_FACES.some((f) => f.id === id) ? (id as string) : BOT_FACES[0].id;
}

export function botEyesId(id: string | null | undefined): string {
  return BOT_EYES.some((e) => e.id === id) ? (id as string) : BOT_EYES[0].id;
}

/**
 * A stable per-bot number so every face animates on its own rhythm — a
 * roster of bots must never blink in unison.
 */
export function botSeed(id: string | null | undefined): number {
  let h = 0;
  const s = String(id || "");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ── Colors — the same palette as Settings › Appearance message colors ───── */

// Everything the message-color pickers offer except Default (which means "no
// color" there; a Bot always wears one). 'accent' stays accent-derived, so a
// Bot on My accent follows the workspace accent like the chat inks do.
export const BOT_COLORS = INKS.filter((i) => i.id !== INK_DEFAULT_ID);

export const BOT_COLOR_DEFAULT = "accent";

export function botColorId(id: string | null | undefined): string {
  return BOT_COLORS.some((c) => c.id === id) ? (id as string) : BOT_COLOR_DEFAULT;
}

/** Bots saved before icons existed carried a gradient "look" — keep the hue. */
const LEGACY_LOOK_COLORS: Record<string, string> = {
  aurora: "sky",
  ember: "orange",
  meadow: "teal",
  midnight: "navy",
  gold: "yellow",
  orchid: "purple",
  forest: "forest",
  graphite: "graphite",
};

/** Finished work kept per bot, so the thread stays readable and storage flat. */
const DONE_HISTORY_LIMIT = 30;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Chat boards are UUIDs everywhere else (routes + persistence) — match that. */
function newChatBoardId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export function createBot(input: {
  name: string;
  role?: string;
  persona?: string;
  face?: string;
  eyes?: string;
  color?: string;
}): Bot {
  return {
    id: newId("bot"),
    name: clean(input.name).slice(0, 40) || "Bot",
    role: clean(input.role).slice(0, 60),
    persona: String(input.persona ?? "").trim().slice(0, 1200),
    face: botFaceId(input.face),
    eyes: botEyesId(input.eyes),
    color: botColorId(input.color),
    agentId: null,
    chatId: newChatBoardId(),
    chatStartedAt: "",
    createdAt: new Date().toISOString(),
    tasks: [],
  };
}

/** True when the bot's CURRENT chat board has conversation on it. */
export function botHasBoardActivity(bot: Bot): boolean {
  const since = bot.chatStartedAt || "";
  if (!since) return bot.tasks.length > 0;
  return bot.tasks.some((t) => t.createdAt >= since);
}

/**
 * The prompt actually sent to the runtime. The persona rides along only on a
 * bot's first task (`introduce`) — after that the agent's own history carries
 * who it is, and re-stating it every turn reads as noise in the transcript.
 *
 * Teammates ride along on EVERY dispatch (they're two short lines and the
 * roster changes over time): a bot that sees part of an ask clearly belongs
 * to a teammate hands it off with the ASK_TEAMMATE marker, and botsClient
 * relays the question and brings the answer back.
 */
export function taskBrief(
  bot: Bot,
  text: string,
  { introduce = false, teammates = [] as Bot[] } = {},
): string {
  const ask = String(text ?? "").trim();
  const team = (teammates || []).filter((t) => t && t.id !== bot.id && t.name?.trim());
  const teamLines = team.length
    ? [
        `Teammates you can ask: ${team
          .map((t) => `${t.name}${t.role ? ` (${t.role})` : ""}`)
          .join(", ")}.`,
        `If part of this is clearly a teammate's job, reply with ONLY one line — [[ask ${team[0].name}: the question]] — and I'll bring you their answer so you can finish.`,
      ]
    : [];
  // Identity rides on EVERY dispatch, not just the introduction: the model
  // only sees a recent slice of history, so "who am I?" must never depend on
  // the first briefing still being in the window.
  if (!introduce) {
    const header = `[You are ${bot.name}${bot.role ? `, my ${bot.role}` : ""}. Stay warm and friendly — you're a teammate, not a formal assistant.]`;
    return [header, ...teamLines, "", ask].join("\n");
  }
  const lines = [
    `You are ${bot.name}${bot.role ? `, my ${bot.role}` : ""} — a standing teammate, not a one-off assistant.`,
  ];
  if (bot.persona) lines.push(`Working style: ${bot.persona}`);
  lines.push(
    `Be warm, friendly, and personable — you're ${bot.name}, a teammate I enjoy working with. Refer to yourself by name when it's natural, and keep the tone upbeat without being fake.`,
    "Ask me only when something genuinely needs my decision; otherwise finish the job end to end.",
    ...teamLines,
    "",
    `First task: ${ask}`,
  );
  return lines.join("\n");
}

/* ── Bot-to-bot hand-offs ─────────────────────────────────────────────────── */

const ASK_TEAMMATE_RE = /\[\[\s*ask\s+([^:\]]{1,60}?)\s*:\s*([\s\S]{1,800}?)\s*\]\]/i;

/**
 * A reply that is really a hand-off: "[[ask Fin: what's our runway?]]".
 * Returns the teammate's name and the question, or null for ordinary replies.
 */
export function parseAskTeammate(text: string): { name: string; question: string } | null {
  const m = String(text ?? "").match(ASK_TEAMMATE_RE);
  if (!m) return null;
  const name = m[1].trim();
  const question = m[2].trim();
  return name && question ? { name, question } : null;
}

/** The reply with any hand-off marker removed (for when no teammate matches). */
export function stripAskTeammate(text: string): string {
  return String(text ?? "").replace(ASK_TEAMMATE_RE, "").trim();
}

/** True when a new assignment must wait: something is already running or parked. */
export function botHasActiveTask(bot: Bot): boolean {
  return bot.tasks.some((t) => t.status === "running");
}

export function queuedTasks(bot: Bot): BotTask[] {
  return bot.tasks.filter((t) => t.status === "queued");
}

export function runningTask(bot: Bot): BotTask | null {
  return bot.tasks.find((t) => t.status === "running") || null;
}

/** The Bot whose worker agent owns this browser tab, if any. */
export function botForAgent(
  bots: Bot[] | null | undefined,
  agentId: string | null | undefined,
): Bot | null {
  const id = String(agentId || "").trim();
  if (!id || !Array.isArray(bots)) return null;
  return bots.find((b) => b.agentId === id) || null;
}

/** Newest finished task — what the bot's status dot reports when it's idle. */
export function latestSettledTask(bot: Bot): BotTask | null {
  for (let i = bot.tasks.length - 1; i >= 0; i -= 1) {
    const t = bot.tasks[i];
    if (t.status === "done" || t.status === "failed") return t;
  }
  return null;
}

/** Oldest queued task — the one the next dispatch should pick up. */
export function nextQueuedTask(bot: Bot): BotTask | null {
  return queuedTasks(bot)[0] || null;
}

export function enqueueTask(bot: Bot, text: string): { bot: Bot; task: BotTask } {
  const task: BotTask = {
    id: newId("task"),
    text: String(text ?? "").trim(),
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  return { bot: { ...bot, tasks: [...bot.tasks, task] }, task };
}

export function startTask(bot: Bot, taskId: string): Bot {
  return {
    ...bot,
    tasks: bot.tasks.map((t) =>
      t.id === taskId
        ? { ...t, status: "running" as const, startedAt: new Date().toISOString() }
        : t,
    ),
  };
}

export function bindRuntimeTask(
  bot: Bot,
  botTaskId: string,
  { taskId, runId }: { taskId?: string; runId?: string },
): Bot {
  return {
    ...bot,
    tasks: bot.tasks.map((task) =>
      task.id === botTaskId
        ? {
            ...task,
            runtimeTaskId: String(taskId || task.runtimeTaskId || ""),
            runId: String(runId || task.runId || taskId || ""),
          }
        : task,
    ),
  };
}

export function finishTask(
  bot: Bot,
  taskId: string,
  { ok = true, result = "" }: { ok?: boolean; result?: string } = {},
): Bot {
  const target = bot.tasks.find((task) => task.id === taskId);
  if (!target || target.status === "done" || target.status === "failed") return bot;
  const now = new Date().toISOString();
  const tasks = bot.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status: (ok ? "done" : "failed") as BotTaskStatus,
          finishedAt: now,
          result: String(result ?? "").slice(0, 20000),
        }
      : task,
  );
  const settled = tasks.filter((task) => task.status === "done" || task.status === "failed");
  const overflow = settled.length - DONE_HISTORY_LIMIT;
  const trimmed =
    overflow > 0
      ? tasks.filter(
          (task) =>
            !(task.status === "done" || task.status === "failed") ||
            settled.indexOf(task) >= overflow,
        )
      : tasks;
  return { ...bot, tasks: trimmed };
}

/**
 * Legacy convenience for callers that have not yet supplied a canonical
 * task identity. Runtime events use finishTask with the exact BotTask id.
 * Finished history is trimmed so a long-lived bot doesn't grow unbounded.
 */
export function finishRunningTask(
  bot: Bot,
  { ok = true, result = "" }: { ok?: boolean; result?: string } = {},
): Bot {
  const running = runningTask(bot);
  if (!running) return bot;
  return finishTask(bot, running.id, { ok, result });
}

export function removeQueuedTask(bot: Bot, taskId: string): Bot {
  return {
    ...bot,
    tasks: bot.tasks.filter((t) => !(t.id === taskId && t.status === "queued")),
  };
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

export const BOTS_STORAGE_KEY = "lykn_bots_v1";

export function serializeBots(bots: Bot[]): string {
  return JSON.stringify({ v: 1, bots });
}

export function parseBots(raw: string | null | undefined): Bot[] {
  try {
    const data = JSON.parse(String(raw || ""));
    const list = Array.isArray(data?.bots) ? data.bots : [];
    return list
      .filter((b: unknown): b is Bot => !!b && typeof (b as Bot).id === "string")
      .map((b: Bot & { look?: string; icon?: string }) => ({
        ...b,
        name: clean(b.name) || "Bot",
        face: botFaceId(b.face),
        eyes: botEyesId(b.eyes),
        color: botColorId(b.color ?? LEGACY_LOOK_COLORS[b.look || ""]),
        // Bots saved before per-bot chats existed get their board minted here.
        chatId: typeof b.chatId === "string" && b.chatId ? b.chatId : newChatBoardId(),
        // "" = every task counts as this board's — right for older bots that
        // were never re-homed.
        chatStartedAt: typeof b.chatStartedAt === "string" ? b.chatStartedAt : "",
        tasks: (Array.isArray(b.tasks) ? b.tasks : [])
          // A task caught mid-run by a reload ends right there — no silent
          // retry on the next dispatch, no half-remembered work. The chat row
          // it belonged to catches up to this result when it re-attaches.
          .map((t) =>
            t?.status === "running"
              ? {
                  ...t,
                  status: "failed" as const,
                  finishedAt: t.finishedAt || new Date().toISOString(),
                  result:
                    String(t.result ?? "").trim() ||
                    "Stopped — the app reloaded before this finished. Send it again if you still need it.",
                }
              : t,
          )
          .filter((t) => t && typeof t.id === "string"),
      }));
  } catch {
    return [];
  }
}

/* ── Quick starts — prefill the builder, never skip it ───────────────────── */

export const BOT_TEMPLATES: Array<
  Pick<Bot, "name" | "role" | "persona" | "face" | "eyes" | "color">
> = [
  {
    name: "Scout",
    role: "Research Analyst",
    face: "triangle",
    eyes: "bar",
    color: "sky",
    persona:
      "Deep-dive researcher. Compare sources, prefer primary ones, and return findings as a short brief: headline answer first, then supporting detail with links.",
  },
  {
    name: "Concierge",
    role: "Operations Assistant",
    face: "square",
    eyes: "dot",
    color: "yellow",
    persona:
      "Handles errands across websites — forms, bookings, lookups, downloads. Confirm before anything is purchased, sent, or submitted on my behalf.",
  },
  {
    name: "Watchtower",
    role: "Monitor",
    face: "hex",
    eyes: "bar",
    color: "navy",
    persona:
      "Keeps an eye on pages and inboxes for changes I care about. Only alert me when something actually changed; stay quiet otherwise.",
  },
  {
    name: "Drafter",
    role: "Writer",
    face: "drop",
    eyes: "arc",
    color: "purple",
    persona:
      "Drafts emails, posts, and documents in my voice: direct, warm, no filler. Always show me the draft before anything is sent anywhere.",
  },
];
