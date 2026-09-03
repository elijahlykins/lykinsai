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
import {
  assign,
  getAgentStates,
  getBot,
  getLive,
  getTaskDeliverables,
  subscribeBots,
} from "@/lib/bots/botsClient";
import { parseAskTeammate } from "@/lib/bots/botStore";

// A follow-up send on the same task (answering the Bot's question) starts a
// new turn row; the old row must freeze where it is instead of continuing to
// mirror the same stream into two places. Re-attaching after a remount takes
// over the task the same way.
let turnSeq = 0;
const activeTurnByTask = new Map();

function questionBlock(waiting) {
  if (String(waiting?.kind || "") === "teammate") return "";
  const label = String(waiting?.label || waiting?.detail || "").trim();
  if (!label) return "";
  const handoff = parseAskTeammate(label);
  if (handoff) return "";
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
  const type = String(choice?.type || "");
  // Approvals use LocalToolApprovalCard, not a question in the reply body.
  if (type === "local-approval" || type === "browse-approval") return "";
  const label = String(choice?.message || "").trim() || "Want me to go ahead?";
  const options = (Array.isArray(choice?.buttons) ? choice.buttons : [])
    .map((b) => String(b?.label || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const bullets = options.map((o) => `- ${o}`).join("\n");
  return `**${label}**${bullets ? `\n\n${bullets}` : ""}`;
}

const STEP_TRANSCRIPT_RE = /lykn-agent-step:\/\//i;

/**
 * Browse work logs belong in the studio rail, not stacked above the chat
 * thinking animation. Keep real prose (and parked questions); drop the step
 * transcript the agent streams while it decides.
 */
export function workingBotReply(streamed, question) {
  const raw = String(streamed || "").trim();
  const text = STEP_TRANSCRIPT_RE.test(raw) ? "" : raw;
  return [text, String(question || "").trim()].filter(Boolean).join("\n\n");
}

/**
 * Mirror one task's life into `onUpdate` until it settles. Safe to call for
 * a task in any state — a settled task emits its final text once and closes.
 *
 * onUpdate({ text, done, failed, working, status, deliverables }) — `text`
 * replaces the row's reply each call; while `working` is true the row should
 * show the animated thinking line under whatever prose has streamed; `done`
 * means the row is final and the subscription is closed, and `deliverables`
 * (when present) are the task's structured work products for the row to
 * render as persistent cards.
 */
export function followBotTask(botId, taskId, onUpdate) {
  const mySeq = ++turnSeq;
  activeTurnByTask.set(taskId, mySeq);

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
        // Structured work products (report document, artifact, image) —
        // the row renders one persistent card per entry so the final
        // reply replacing the streamed text never loses the work.
        deliverables: getTaskDeliverables(taskId),
      });
      return;
    }
    if (task.status === "queued") {
      const running = bot.tasks.find((t) => t.status === "running");
      push("", {
        working: true,
        status: running
          ? `Queued. ${bot.name} will start as soon as its current task wraps up.`
          : "On it…",
      });
      return;
    }
    // Running: mirror the live stream, and surface a parked question or
    // approval so the thread shows what the Bot is waiting on. The next
    // targeted send answers it.
    const live = getLive()[bot.agentId] || {};
    let streamed = String(live.text || "").trim();
    const waitingKind = String(live.waiting?.kind || "");
    const parked = !!(
      (live.waiting?.waiting && waitingKind === "question") ||
      live.choice
    );
    const question = live.waiting?.waiting
      ? questionBlock(live.waiting)
      : live.choice
        ? choiceBlock(live.choice)
        : "";
    // An approval's message also arrives as the live text — don't say it twice.
    if (live.choice && streamed && streamed === String(live.choice.message || "").trim()) {
      streamed = "";
    }
    const body = workingBotReply(streamed, question);
    // The status line rides beside the text, not inside it: the row renders
    // streamed content as markdown and a single thinking animation underneath.
    // Browse plan-echo and action lines stay off this row — they used to
    // stack above the spinner. Parked (question/approval) turns stop
    // animating — it's the user's move.
    //
    // The status is the harness's live step ("Checking the work…", tool
    // narration) — a hard-coded "Thinking…" here used to make the generic
    // rotation park on "Polishing the details…" through minutes of real
    // post-report work (verify, deliver), which read as a hang.
    const step = String(getAgentStates()[bot.agentId]?.step || "").trim();
    push(body, {
      working: !parked,
      status: step || "Thinking…",
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
export const BOT_THREAD_PRESENT_EVENT = "lykn-bot-present-in-thread";
export const LYKN_CHAT_OPEN_EVENT = "lykn-lykn-chat-open";

/** Jump Home chat off a Bot board and back onto LYKN's own thread. */
export function openLyknChatBoard({ park = false } = {}) {
  if (typeof window === "undefined") return;
  const detail = { at: Date.now() };
  if (park) {
    try {
      sessionStorage.setItem("lykn_pending_lykn_open", JSON.stringify(detail));
    } catch {
      /* the event below still covers a warm chat surface */
    }
  }
  window.dispatchEvent(new CustomEvent(LYKN_CHAT_OPEN_EVENT, { detail }));
  window.dispatchEvent(new CustomEvent("lykn-studio-open-chat"));
}

/**
 * Show a bot task in whatever chat is on screen (LYKN's thread, not the
 * bot's private board). useBotChatBridge listens and inserts a live row.
 */
export function presentBotInCurrentChat({ botId, taskId, question }) {
  if (typeof window === "undefined") return false;
  return window.dispatchEvent(
    new CustomEvent(BOT_THREAD_PRESENT_EVENT, {
      bubbles: true,
      cancelable: true,
      detail: {
        botId: String(botId || ""),
        taskId: String(taskId || ""),
        question: String(question || "").trim(),
      },
    }),
  );
}

/**
 * Wait until a bot task settles. Does not take followBotTask ownership, so
 * the chat row can keep streaming the same task.
 */
export function waitForBotTask(botId, taskId, { timeoutMs = 4 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let unsub = () => {};
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsub();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ done: false, failed: true, timedOut: true, text: "" });
    }, timeoutMs);
    const check = () => {
      const bot = getBot(botId);
      const task = bot?.tasks?.find((t) => t.id === taskId);
      if (!bot || !task) {
        finish({
          done: true,
          failed: true,
          text: "This Bot was dismissed before it could finish.",
        });
        return;
      }
      if (task.status === "done" || task.status === "failed") {
        finish({
          done: true,
          failed: task.status === "failed",
          text: String(task.result || "").trim() || "Done.",
        });
      }
    };
    unsub = subscribeBots(check);
    check();
  });
}

export function sendBotChatTurn(botId, text, onUpdate, attachments = []) {
  const sent = assign(botId, text, attachments);
  if (!sent) {
    onUpdate({ text: "This Bot isn't available anymore.", done: true, failed: true });
    return null;
  }
  followBotTask(botId, sent.taskId, onUpdate);
  return sent.taskId;
}
