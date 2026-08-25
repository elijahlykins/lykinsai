// The one live copy of the Bots state in this document.
//
// Two surfaces talk to Bots — the Bots window and the home chat bar's Bot
// dropdown — and both can be mounted at once. If each kept its own state and
// its own IPC subscriptions, a finished task would dispatch its queue twice.
// So the roster, the runtime's agent states, and the per-agent live turn all
// live here as a module singleton; components subscribe through useBots()
// and mutate through the exported actions.
import { useEffect, useState } from "react";
import {
  BOTS_STORAGE_KEY,
  botForAgent,
  createBot,
  enqueueTask,
  finishRunningTask,
  nextQueuedTask,
  parseAskTeammate,
  parseBots,
  removeQueuedTask,
  runningTask,
  serializeBots,
  startTask,
  stripAskTeammate,
  taskBrief,
} from "@/lib/bots/botStore";
import { bindBrowserTabChat } from "@/lib/lyknChat/browserChatAttach";

const lykn = () => (typeof window !== "undefined" ? window.lykn : undefined);

let bots = null; // lazy — localStorage isn't touched until someone asks
let agentStates = {}; // agentId → publicAgent, from list/progress broadcasts
let live = {}; // agentId → { text, waiting, choice } for the streaming turn
let shots = {}; // agentId → { dataUrl, url, at } — tiny browser viewport feed
const subs = new Set();

function load() {
  if (bots === null) {
    try {
      bots = parseBots(localStorage.getItem(BOTS_STORAGE_KEY));
    } catch {
      bots = [];
    }
  }
  return bots;
}

function persist() {
  try {
    localStorage.setItem(BOTS_STORAGE_KEY, serializeBots(bots));
  } catch {
    /* roster survives in memory for this session */
  }
}

function emit() {
  for (const fn of subs) {
    try {
      fn();
    } catch {
      /* one bad subscriber must not starve the rest */
    }
  }
}

function setBots(next) {
  bots = next;
  persist();
  emit();
}

function patchBot(botId, fn) {
  setBots(load().map((b) => (b.id === botId ? fn(b) : b)));
}

function setLiveFor(agentId, patch) {
  live = { ...live, [agentId]: { ...(live[agentId] || {}), ...patch } };
  emit();
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export function getBots() {
  return load();
}

export function getBot(botId) {
  return load().find((b) => b.id === botId) || null;
}

export function getBotByAgentId(agentId) {
  return botForAgent(load(), agentId);
}

export function getAgentStates() {
  return agentStates;
}

export function getLive() {
  return live;
}

export function getBotShots() {
  return shots;
}

/** Reveal the real browser tab a Bot is working in (mini viewport click). */
export function revealBotBrowser(bot) {
  if (!bot?.agentId) return;
  // Pair this tab with the Bot's own chat so the rail dropdown shows that
  // Bot — not LYKN — as the one working the screen.
  if (bot.chatId) bindBrowserTabChat(bot.agentId, bot.chatId);
  const api = lykn();
  api?.agentSwitch?.(bot.agentId)?.catch?.(() => {});
  api?.agentShowBrowser?.(bot.agentId)?.catch?.(() => {});
  api?.agentChatSet?.({ open: true, agentId: bot.agentId })?.catch?.(() => {});
}

/** True when the desktop shell (and so the agent runtime) is reachable. */
export function botsAvailable() {
  return !!lykn()?.studioAgentSend;
}

/* ── Seen tracking — powers the done/failed dots in the chat bar ─────────── */

const SEEN_KEY = "lykn_bots_seen_v1";
let seenMap = null;

function loadSeen() {
  if (seenMap === null) {
    try {
      const data = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
      seenMap = data && typeof data === "object" ? data : {};
    } catch {
      seenMap = {};
    }
  }
  return seenMap;
}

/** The user is looking at this bot's chat right now — clear its result dot. */
export function markBotSeen(botId) {
  if (!botId) return;
  loadSeen()[botId] = new Date().toISOString();
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seenMap));
  } catch {
    /* dot state survives in memory for this session */
  }
  emit();
}

/** True when the bot finished (or failed) something the user hasn't viewed. */
export function botHasUnseenResult(bot) {
  if (!bot) return false;
  let latest = null;
  for (let i = bot.tasks.length - 1; i >= 0; i -= 1) {
    const t = bot.tasks[i];
    if (t.status === "done" || t.status === "failed") {
      latest = t;
      break;
    }
  }
  if (!latest?.finishedAt) return false;
  const seen = loadSeen()[bot.id];
  return !seen || seen < latest.finishedAt;
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

export function addBot(draft) {
  const bot = createBot(draft);
  setBots([...load(), bot]);
  return bot;
}

/**
 * Point the bot at a fresh chat board — how "clear chat" works for a Bot.
 * The old thread stays in history like any other chat, but every way back
 * to the bot (dropdown, work strip, sends) lands on the new board.
 */
export function setBotChatBoard(botId, chatId) {
  const board = String(chatId || "").trim();
  if (!board) return;
  // The stamp marks earlier tasks as belonging to retired boards, so the
  // chat bar strip hides the bot until this fresh chat actually has turns.
  patchBot(botId, (b) => ({ ...b, chatId: board, chatStartedAt: new Date().toISOString() }));
}

export function removeBot(botId) {
  const bot = getBot(botId);
  // Un-park any teammate hand-offs touching this bot: questions it was going
  // to answer resume their asker; questions it asked are simply dropped.
  for (const [relayTaskId, relay] of [...relays]) {
    if (relay.fromBotId === botId) {
      relays.delete(relayTaskId);
    } else if (bot?.tasks.some((t) => t.id === relayTaskId)) {
      relays.delete(relayTaskId);
      resumeAfterRelay(relay, `${bot.name} was dismissed before answering.`);
    }
  }
  if (bot?.agentId) lykn()?.agentClose?.(bot.agentId)?.catch?.(() => {});
  setBots(load().filter((b) => b.id !== botId));
}

export function withdrawTask(botId, taskId) {
  attachmentsByTask.delete(taskId);
  patchBot(botId, (b) => removeQueuedTask(b, taskId));
}

// Queued-task attachments (runtime shape), keyed by task id. In-memory only —
// see the note in assign().
const attachmentsByTask = new Map();

/** The Bot's worker agent, created silently (no browser pop) if missing. */
async function ensureAgent(bot) {
  if (bot.agentId && agentStates[bot.agentId]) {
    // Re-assert headless on reuse: the agent may predate the flag, and a Bot's
    // agent must never raise the browser window while it works.
    lykn()?.agentSetHeadless?.(bot.agentId, true)?.catch?.(() => {});
    return { agentId: bot.agentId, fresh: false };
  }
  const res = await lykn()?.agentCreate?.({
    title: bot.name,
    silent: true,
    activate: false,
    // Bots aren't connected to the visible browser yet: the runtime keeps
    // their tab hidden and never raises the window while they work.
    headless: true,
    // Structured identity for the harness system prompt — the persona holds
    // every turn instead of decaying after the first dispatch brief.
    bot: { name: bot.name, role: bot.role, persona: bot.persona },
  });
  if (!res?.ok || !res.agentId) throw new Error(res?.error || "agent_create_failed");
  return { agentId: res.agentId, fresh: true };
}

/** Start the oldest queued task if the Bot's desk is clear. */
export async function dispatchNext(botId) {
  const bot = getBot(botId);
  if (!bot || runningTask(bot)) return;
  const task = nextQueuedTask(bot);
  if (!task) return;
  let agentId;
  let fresh;
  try {
    ({ agentId, fresh } = await ensureAgent(bot));
  } catch {
    patchBot(botId, (b) =>
      finishRunningTask(startTask(b, task.id), {
        ok: false,
        result: "Couldn't start a worker agent (agent limit reached?). Task kept in the log.",
      }),
    );
    return;
  }
  // Relayed teammate questions must be answered directly — no chained
  // hand-offs — so their brief omits the roster entirely.
  const teammates = relays.has(task.id) ? [] : load().filter((b) => b.id !== botId);
  const brief = taskBrief({ ...bot, agentId }, task.text, { introduce: fresh, teammates });
  const atts = attachmentsByTask.get(task.id) || [];
  attachmentsByTask.delete(task.id);
  patchBot(botId, (b) => startTask({ ...b, agentId }, task.id));
  setLiveFor(agentId, { text: "", waiting: null, choice: null });
  try {
    await lykn().studioAgentSend(brief, atts, agentId, {
      bot: { name: bot.name, role: bot.role, persona: bot.persona },
    });
  } catch {
    patchBot(botId, (b) =>
      finishRunningTask(b, { ok: false, result: "The send failed — try assigning it again." }),
    );
  }
}

/**
 * Give the Bot work (or an answer). A parked question takes the text as its
 * answer and resumes; otherwise the task queues and dispatches when the desk
 * is clear. Returns the task the turn belongs to, so a chat thread can
 * follow this exact piece of work to its result.
 *
 * `attachments` are runtime-shaped ({ kind: "image"|"text", name, dataUrl?,
 * text? } — see botAttachments.js) and ride the dispatch to the worker agent.
 */
export function assign(botId, text, attachments = []) {
  const bot = getBot(botId);
  const ask = String(text || "").trim();
  const atts = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!bot || !ask) return null;
  const parked =
    live[bot.agentId]?.waiting?.waiting ||
    !!live[bot.agentId]?.choice ||
    agentStates[bot.agentId]?.waiting;
  const running = runningTask(bot);
  if (parked && running) {
    // The typed reply answers whatever was parked — question or approval
    // buttons alike (the runtime maps typed yes/no onto a pending choice).
    setLiveFor(bot.agentId, { waiting: null, choice: null, text: "" });
    lykn()
      .studioAgentSend(ask, atts, bot.agentId, {
        bot: { name: bot.name, role: bot.role, persona: bot.persona },
      })
      .catch(() => {});
    return { taskId: running.id, answered: true };
  }
  let created = null;
  patchBot(botId, (b) => {
    const r = enqueueTask(b, ask);
    created = r.task;
    return r.bot;
  });
  // Attachments live beside the queue, not in it: tasks persist to
  // localStorage and image data URLs would blow past its quota. Held in
  // memory until this task dispatches; lost on reload like other pending
  // hand-offs, which just means the ask arrives without its files.
  if (created && atts.length) attachmentsByTask.set(created.id, atts);
  setTimeout(() => dispatchNext(botId), 0);
  return created ? { taskId: created.id, answered: false } : null;
}

/* ── Bot-to-bot hand-offs ────────────────────────────────────────────────── */
//
// A bot that replies with "[[ask Name: question]]" isn't answering — it wants
// its teammate's input first. Its own task stays running ("Asking Name…"),
// the question runs as a normal task on the teammate, and the answer comes
// back as a follow-up turn so the first bot can finish the original ask.

const relays = new Map(); // teammate's relay-task id → { fromBotId, fromTaskId }
const hopsByTask = new Map(); // origin task id → hand-offs already spent
const MAX_HOPS_PER_TASK = 2;

/** Reply was a hand-off and it's now in flight — the origin task stays open. */
function tryRelayHandoff(bot, task, text) {
  const ask = parseAskTeammate(text);
  if (!ask) return false;
  // A relayed question must be answered by this bot, never passed along again.
  if (relays.has(task.id)) return false;
  const spent = hopsByTask.get(task.id) || 0;
  if (spent >= MAX_HOPS_PER_TASK) return false;
  const mate = load().find(
    (b) => b.id !== bot.id && b.name.trim().toLowerCase() === ask.name.toLowerCase(),
  );
  if (!mate) return false;
  hopsByTask.set(task.id, spent + 1);
  setLiveFor(bot.agentId, { text: `Asking ${mate.name}…`, waiting: null, choice: null });
  let relayTask = null;
  patchBot(mate.id, (b) => {
    const r = enqueueTask(
      b,
      `Your teammate ${bot.name} needs an answer to finish a task — answer directly and completely, don't hand this to anyone else:\n${ask.question}`,
    );
    relayTask = r.task;
    return r.bot;
  });
  if (!relayTask) return false;
  relays.set(relayTask.id, { fromBotId: bot.id, fromTaskId: task.id });
  setTimeout(() => dispatchNext(mate.id), 0);
  return true;
}

/** The finished task was a relayed question — return the answer to its asker. */
function completeRelay(taskId, mate, answer) {
  const relay = relays.get(taskId);
  if (!relay) return;
  relays.delete(taskId);
  resumeAfterRelay(relay, `${mate.name} answered:\n${answer}`);
}

function resumeAfterRelay(relay, note) {
  const from = getBot(relay.fromBotId);
  if (!from?.agentId || runningTask(from)?.id !== relay.fromTaskId) return;
  setLiveFor(from.agentId, { text: "", waiting: null, choice: null });
  lykn()
    ?.studioAgentSend?.(
      `${note}\n\nFinish my original ask yourself now — answer me directly.`,
      [],
      from.agentId,
    )
    ?.catch?.(() => {
      patchBot(from.id, (b) =>
        finishRunningTask(b, {
          ok: false,
          result: "The teammate hand-off broke — try assigning this again.",
        }),
      );
    });
}

export function answerChoice(botId, choice, buttonId) {
  const bot = getBot(botId);
  if (!bot?.agentId || !choice?.choiceId) return;
  setLiveFor(bot.agentId, { choice: null });
  lykn()?.agentChoiceResolve?.(bot.agentId, choice.choiceId, buttonId)?.catch?.(() => {});
}

/* ── Runtime wiring — once per document ──────────────────────────────────── */

let wired = false;

function ensureWired() {
  if (wired) return;
  const api = lykn();
  if (!api?.studioAgentSend) return;
  wired = true;

  const applyList = (p) => {
    const map = {};
    for (const a of p?.agents || []) map[a.id] = a;
    agentStates = map;
    emit();
  };
  api.agentList?.()
    .then((p) => {
      applyList(p);
      // A reload ended every task that was mid-run (parseBots settles them
      // as stopped). The runtime turn behind one may still be going in the
      // main process — stop it too, so an orphaned run doesn't keep working
      // a hidden browser for a task whose chat row already says "Stopped".
      // One-shot on the fresh document only: during live operation a busy
      // agent always has its running task, so this never fires again.
      for (const a of p?.agents || []) {
        if (!(a.busy || a.status === "running" || a.status === "waiting")) continue;
        const bot = load().find((b) => b.agentId === a.id);
        if (bot && !runningTask(bot)) api.agentStop?.(a.id)?.catch?.(() => {});
      }
    })
    .catch(() => {});
  api.onAgentList?.(applyList);
  api.onAgentProgress?.((p) => {
    if (!p?.agentId || !agentStates[p.agentId]) return;
    agentStates = { ...agentStates, [p.agentId]: { ...agentStates[p.agentId], ...p } };
    // Back to running = whatever it was parked on is answered. Clear the
    // stale question/approval so the chat row stops asking.
    if (p.status === "running" && (live[p.agentId]?.waiting || live[p.agentId]?.choice)) {
      live = { ...live, [p.agentId]: { ...live[p.agentId], waiting: null, choice: null } };
    }
    // The viewport closed with the task — drop its last frame so the next
    // browser run starts fresh instead of flashing a stale page.
    if (!p.botBrowser && shots[p.agentId]) {
      const { [p.agentId]: _gone, ...rest } = shots;
      shots = rest;
    }
    emit();
  });
  api.onBotBrowserShot?.((p) => {
    if (!p?.agentId || !p.dataUrl) return;
    shots = {
      ...shots,
      [p.agentId]: { dataUrl: String(p.dataUrl), url: String(p.url || ""), at: Date.now() },
    };
    emit();
  });
  api.onAgentDelta?.((p) => {
    if (!p?.agentId) return;
    // Deltas carry the turn's full text so far — replace, don't append.
    // A parked run streams nothing, so any delta means it's moving again —
    // retire a resolved approval's buttons instead of leaving them up.
    // (The approval's own message-delta lands BEFORE its choice event, so
    // this can never wipe a question that is still open.)
    setLiveFor(p.agentId, { text: String(p.text || ""), choice: null });
  });
  api.onAgentWaiting?.((p) => {
    if (p?.agentId) setLiveFor(p.agentId, { waiting: p.waiting ? p : null });
  });
  api.onAgentChoice?.((p) => {
    if (p?.agentId) setLiveFor(p.agentId, { choice: p });
  });
  api.onAgentDone?.((p) => {
    if (!p?.agentId) return;
    const bot = load().find((b) => b.agentId === p.agentId);
    const task = bot ? runningTask(bot) : null;
    if (!bot || !task) return;
    // A parked run (question / approval / sign-in wall) also ends its turn —
    // the task isn't finished, the Bot is waiting on you.
    const parked = live[p.agentId]?.waiting?.waiting || agentStates[p.agentId]?.waiting;
    if (parked && !p.stopped) return;
    const text = String(p.text || "").trim() || live[p.agentId]?.text || "";
    // The reply is a hand-off to a teammate — the task stays open while the
    // question runs on that bot and the answer comes back.
    if (!p.stopped && tryRelayHandoff(bot, task, text)) return;
    hopsByTask.delete(task.id);
    patchBot(bot.id, (b) =>
      finishRunningTask(b, {
        ok: !p.stopped,
        // An unrelayable hand-off marker (unknown teammate / hop limit) reads
        // as noise — show the reply without it.
        result: p.stopped ? text || "Stopped." : stripAskTeammate(text) || text,
      }),
    );
    setLiveFor(p.agentId, { text: "", waiting: null, choice: null });
    // This answer may itself be a teammate's reply someone is waiting on.
    completeRelay(task.id, bot, stripAskTeammate(text) || text);
    // The Bot moves straight to whatever is next on its desk.
    setTimeout(() => dispatchNext(bot.id), 400);
  });
}

export function subscribeBots(fn) {
  ensureWired();
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Live view of the roster + runtime state; re-renders on every change. */
export function useBots() {
  const [, force] = useState(0);
  useEffect(() => subscribeBots(() => force((n) => n + 1)), []);
  return {
    bots: getBots(),
    agentStates: getAgentStates(),
    live: getLive(),
    shots: getBotShots(),
  };
}
