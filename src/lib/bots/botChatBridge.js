// One Bot turn, streamed into the regular chat.
//
// Bots don't have a chat page of their own — you talk to them in LYKN chat.
// A targeted send becomes a normal turn row in the thread, and this module
// keeps that row's aiResponse honest for the life of the task: the agent's
// live text while it works, its question when it parks, the result when it
// finishes. The chat surface only supplies a callback that patches the row.
//
// Because every bot has its own chat board and the user can leave mid-task,
// following a task is separate from starting one: `followBotTask` can attach
// to a task that's already running (or already finished) after a remount and
// the row simply catches up — deltas always carry the full text.
import { assign, getAgentStates, getBot, getLive, subscribeBots } from "@/lib/bots/botsClient";

// A follow-up send on the same task (answering the Bot's question) starts a
// new turn row; the old row must freeze where it is instead of continuing to
// mirror the same stream into two places. Re-attaching after a remount takes
// over the task the same way.
let turnSeq = 0;
const activeTurnByTask = new Map();

function questionBlock(waiting) {
  const label = String(waiting?.label || waiting?.detail || "").trim();
  if (!label) return "";
  const options = (Array.isArray(waiting?.options) ? waiting.options : [])
    .map((o) => String(o || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const bullets = options.map((o) => `- ${o}`).join("\n");
  return `**${label}**${bullets ? `\n\n${bullets}` : ""}`;
}

/**
 * A run parked on Yes/No buttons (browse approval, send approval, Local Mode
 * approval…). Those buttons live on the Glass bar and the browser rail — the
 * main chat gets the same question as text, and a typed yes/no resolves it
 * (agentRuntime maps typed replies onto the pending choice).
 */
function choiceBlock(choice) {
  const label = String(choice?.message || "").trim() || "Want me to go ahead?";
  const options = (Array.isArray(choice?.buttons) ? choice.buttons : [])
    .map((b) => String(b?.label || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const bullets = options.map((o) => `- ${o}`).join("\n");
  return `**${label}**${bullets ? `\n\n${bullets}` : ""}`;
}

/**
 * Mirror one task's life into `onUpdate` until it settles. Safe to call for
 * a task in any state — a settled task emits its final text once and closes.
 *
 * onUpdate({ text, done, failed, working, status, trail }) — `text` replaces
 * the row's reply each call; while `working` is true the row should show the
 * animated `status` line (with `trail`, the recent statuses) under whatever
 * text has streamed; `done` means the row is final and the subscription is
 * closed.
 */
export function followBotTask(botId, taskId, onUpdate) {
  const mySeq = ++turnSeq;
  activeTurnByTask.set(taskId, mySeq);

  // Recent distinct status lines — the working row shows them as a faded
  // trail above the live one, the same way LYKN's own thinking runs do.
  const trail = [];
  const noteStatus = (line) => {
    const s = String(line || "").trim();
    if (!s || trail[trail.length - 1] === s) return;
    trail.push(s);
    if (trail.length > 6) trail.shift();
  };

  let last = "";
  const push = (reply, extra = {}) => {
    const t = String(reply || "");
    const key = `${t}|${extra.working ? extra.status || "" : ""}`;
    if (!extra.done && key === last) return;
    last = key;
    onUpdate({ text: t, ...extra });
  };

  let unsub = () => {};
  const check = () => {
    // A newer turn owns this task now — freeze this row where it stands.
    if (activeTurnByTask.get(taskId) !== mySeq) {
      unsub();
      return;
    }
    const bot = getBot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!bot || !task) {
      unsub();
      activeTurnByTask.delete(taskId);
      push("This Bot was dismissed before it could finish.", { done: true, failed: true });
      return;
    }
    if (task.status === "done" || task.status === "failed") {
      unsub();
      activeTurnByTask.delete(taskId);
      push(String(task.result || "").trim() || "Done.", {
        done: true,
        failed: task.status === "failed",
      });
      return;
    }
    if (task.status === "queued") {
      const running = bot.tasks.find((t) => t.status === "running");
      push("", {
        working: true,
        status: running
          ? `Queued — ${bot.name} will start as soon as its current task wraps up.`
          : "On it…",
        trail: [],
      });
      return;
    }
    // Running: mirror the live stream, and surface a parked question or
    // approval so the thread shows what the Bot is waiting on. The next
    // targeted send answers it.
    const live = getLive()[bot.agentId] || {};
    const agent = getAgentStates()[bot.agentId] || {};
    let streamed = String(live.text || "").trim();
    const parked = !!(live.waiting?.waiting || live.choice);
    const question = live.waiting?.waiting
      ? questionBlock(live.waiting)
      : live.choice
        ? choiceBlock(live.choice)
        : "";
    // An approval's message also arrives as the live text — don't say it twice.
    if (live.choice && streamed && streamed === String(live.choice.message || "").trim()) {
      streamed = "";
    }
    const body = [streamed, question].filter(Boolean).join("\n\n");
    // agent.step is only this turn's status while the agent is actually
    // mid-turn — right after dispatch it still says the LAST turn's "Done",
    // and a fresh reply must never open with that.
    const liveStep =
      agent.status === "running" || agent.status === "waiting"
        ? String(agent.step || "").trim()
        : "";
    if (!parked) noteStatus(liveStep);
    // The status line rides beside the text, not inside it: the row renders
    // streamed content as markdown and the status as a live animated
    // indicator underneath. Parked (question/approval) turns stop animating —
    // it's the user's move.
    push(body, {
      working: !parked,
      status: liveStep || "Thinking…",
      trail: trail.slice(0, -1),
    });
  };

  unsub = subscribeBots(check);
  check();
}

/**
 * Send `text` (plus any runtime-shaped attachments — image data URLs /
 * extracted text, see botAttachments.js) to the Bot and stream the turn
 * into `onUpdate`.
 * Returns the taskId carrying the turn (null if the bot is gone) so the
 * chat row can be re-attached to the task after a remount.
 */
export function sendBotChatTurn(botId, text, onUpdate, attachments = []) {
  const sent = assign(botId, text, attachments);
  if (!sent) {
    onUpdate({ text: "This Bot isn't available anymore.", done: true, failed: true });
    return null;
  }
  followBotTask(botId, sent.taskId, onUpdate);
  return sent.taskId;
}
