import {
  SPINNER_PATH,
  escapeHtml,
  renderMarkdown,
  expandedAgentSteps,
} from "./overlay-ui/markdown.js";
import {
  GENERIC_THINK_RE,
  GENERIC_BUILD_RE,
  attachStatusRotation,
} from "./overlay-ui/statusRotation.js";
import { attachSidePanel } from "./overlay-ui/sidePanel.js";
import { attachVoice } from "./overlay-ui/voice.js";
import { attachListenMeeting } from "./overlay-ui/listenMeeting.js";

// Glass-bar overlay renderer. The user types a question; the main process
// silently captures the screen, sends it to LYKN, and streams the answer back
// here. The screenshot itself is never shown.

// Windows/Linux lack native vibrancy — denser glass CSS (see overlay.html).
if (window.lyknOverlay?.platform && window.lyknOverlay.platform !== "darwin") {
  document.documentElement.classList.add("no-vibrancy");
}

const askEl = document.getElementById("ask");
const sendEl = document.getElementById("send");
const threadEl = document.getElementById("thread");
const dotEl = document.getElementById("dot");

let busy = false;
// The answer element of the turn currently streaming, so deltas land in the
// right place even after older turns have been collapsed.
let currentAnswerEl = null;
// The turn's container + question text, used to attach suggestions on done.
let currentChatEl = null;
let currentQuestion = "";
let currentPageSource = null;
// Whether the current turn has started receiving answer text (vs still showing
// the thinking/tool spinner).
let currentHasText = false;
// Lightweight conversation memory so follow-ups ("what about the error?") have
// context. Capped on the main side too. Persisted locally as ⌘L sessions.
const history = [];
let currentSessionId = null;

const CHEVRON_SVG =
  '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 9 6 6 6-6" /></svg>';


function thinkingHTML(status) {
  return (
    '<div class="thinking">' +
    '<svg class="lykn-outline-spinner" width="24" height="24" viewBox="0 0 204.29 204.29" ' +
    'fill="none" role="img" aria-label="Loading">' +
    '<path d="' + SPINNER_PATH + '" pathLength="1" fill="currentColor" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />' +
    "</svg>" +
    '<span class="thinking-text"></span>' +
    "</div>"
  );
}

let stopStatusRotation, maybeRotateFromStatus, shouldKeepBuildingUnder, applyRotatedStatus, startStatusRotation;
let showSide, clearSide, resetSideForNewTurn, setSidePanelView, renderSidePanel, renderWatchSidePanel, refreshSidePanelFromLiveNotes, requestSuggestions, mergeSourceLinks, setPanelPickerOpen, syncSidePickerState, updateSidePickerLabel, applyLiveWatchLayout, applyLiveNotesLayout, startWatchConnPoll, stopWatchConnPoll, ARROW_ICON_SVG;
let stopVoice, startVoice, sendTextToVoice, pushScreenContext;
let pushLiveState, startListen, stopListen, closeLive;

let statusRotateLane = "think";
let statusRotateActive = false;

let sideContext = null;
let liveNotesSnapshot = {
  keyPoints: [],
  actionItems: [],
  summary: "",
  questionsToAsk: [],
  suggestions: [],
  topics: [],
};
let sidePanelView = "";
let panelPickerOpen = false;
let watchFeedItems = [];
let watchActiveRules = [];
let watchContextSource = "vision";
let watchExtensionConnected = false;
let watchPageTitle = "";
let watchPageUrl = "";
let liveWatchEnabled = false;
let lastWatchCommentaryPosted = "";
let watchFeedActive = false;
let watchSuggestions = { followups: [], links: [] };
let watchSuggestTimer = null;
let lastWatchSuggestKey = "";
let researchSources = [];
let liveNotesOpen = false;
let voiceActive = false;
let voiceStarting = false;
let voiceSessionToken = "";


// Width must match the main process constant (OVERLAY_WIDTH); the panel card
// widths match the detached panel window (see panel.html / main.cjs).
const CHAT_WIDTH = 520;
const SIDE_WIDTH = 300;
const WATCH_SIDE_WIDTH = 360;
let lastReportedHeight = -1;
let lastReportedWidth = -1;

// The live watch feed renders in the detached panel card now, so the chat
// bar itself never stretches — just open the watch view.

// Clean-bar toggle: ON hides every previous turn ENTIRELY so only the newest
// prompt + answer shows (the turns stay in the DOM and `history` is untouched,
// so the AI keeps full context); OFF brings the older prompts back as the
// usual collapsed headers. While ON the button stays visible and tinted so it
// can be toggled back off even with nothing expanded.
const collapseAllBtn = document.getElementById("collapse-all");
function refreshCollapseAllBtn() {
  if (!collapseAllBtn) return;
  const clean = threadEl.classList.contains("clean");
  const chatCount = threadEl.querySelectorAll(".chat").length;
  // Visible whenever there's history worth hiding (2+ turns), regardless of
  // whether anything is expanded — and always while clean mode is on, so it
  // can be toggled back off.
  const show = threadEl.classList.contains("show") && (clean || chatCount >= 2);
  collapseAllBtn.classList.toggle("show", show);
  collapseAllBtn.classList.toggle("active", clean);
}
if (collapseAllBtn) {
  collapseAllBtn.addEventListener("click", () => {
    const on = !threadEl.classList.contains("clean");
    threadEl.classList.toggle("clean", on);
    const label = on ? "Show previous chats" : "Hide previous chats";
    collapseAllBtn.title = label;
    collapseAllBtn.setAttribute("aria-label", label);
    if (on) {
      // Fold everything, then open just the newest turn — the clean bar shows
      // exactly one prompt + its response.
      threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));
      const last = threadEl.querySelector(".chat:last-child");
      if (last) last.classList.remove("collapsed");
    }
    refreshCollapseAllBtn();
    reportHeight();
  });
}

function reportHeight() {
  // Measure the EXACT content size after layout settles, and only tell main to
  // resize when it actually changed — so the panel grows/shrinks only when needed
  // instead of creeping on every keystroke or delta.
  refreshCollapseAllBtn();
  requestAnimationFrame(() => {
    const bar = document.querySelector(".composer");
    const title = document.querySelector(".titlebar");
    const att = document.getElementById("attachments");
    const attH = att && att.classList.contains("show") ? att.offsetHeight : 0;
    const threadH = threadEl.classList.contains("show")
      ? Math.min(threadEl.scrollHeight + 1, 420)
      : 0;
    // The live meeting notes and side-panel cards are their own floating
    // windows now, so they never contribute to the chat column size.
    const chatH = title.offsetHeight + threadH + attH + bar.offsetHeight + 2;

    const w = CHAT_WIDTH;
    const h = chatH;
    if (h !== lastReportedHeight || w !== lastReportedWidth) {
      lastReportedHeight = h;
      lastReportedWidth = w;
      window.lyknOverlay.resize(w, h);
    }
  });
}

function setBusy(on) {
  busy = on;
  dotEl.classList.toggle("busy", on);
  sendEl.classList.toggle("busy", on);
  sendEl.disabled = on;
}

// Type the newest step explanation instead of flashing the whole paragraph.
let stepNoteType = { timer: null, key: "", shown: "", target: "" };

function stopStepNoteTyping() {
  if (stepNoteType.timer) {
    clearTimeout(stepNoteType.timer);
    stepNoteType.timer = null;
  }
}

// Start a new turn: collapse every prior turn, append an expanded item for this
// question, and return its answer element to stream into.
function startTurn(question) {
  // A new question is pending — reset sources side data but keep live watch panel open.
  stopStatusRotation();
  stopStepNoteTyping();
  stepNoteType = { timer: null, key: "", shown: "", target: "" };
  // A new turn supersedes any parked wait from the previous one.
  pendingAgentWaiting = null;
  currentPageSource = null;
  resetSideForNewTurn();
  threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));

  const item = document.createElement("div");
  item.className = "chat";

  const q = document.createElement("div");
  q.className = "chat-q";
  q.setAttribute("role", "button");
  q.tabIndex = 0;
  q.innerHTML = CHEVRON_SVG;
  const qt = document.createElement("span");
  qt.className = "q-text";
  qt.textContent = question;
  q.appendChild(qt);

  const a = document.createElement("div");
  a.className = "chat-a";
  const body = document.createElement("div");
  body.className = "chat-a-body";
  body.innerHTML = thinkingHTML();
  a.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "chat-a-actions";
  actions.hidden = true;
  actions.innerHTML = CHAT_COPY_BTN_HTML;
  a.appendChild(actions);

  item.appendChild(q);
  item.appendChild(a);
  threadEl.appendChild(item);
  threadEl.classList.add("show");
  currentAnswerEl = a;
  currentChatEl = item;
  currentQuestion = question || "";
  currentHasText = false;
  answerStillWorking = true;
  lastThinkingStatus = "Thinking…";
  setThinkingStatus("Thinking…");

  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
  return a;
}

function renderHistoricTurn(question, answer, collapsed) {
  const item = document.createElement("div");
  item.className = "chat" + (collapsed ? " collapsed" : "");

  const q = document.createElement("div");
  q.className = "chat-q";
  q.setAttribute("role", "button");
  q.tabIndex = 0;
  q.innerHTML = CHEVRON_SVG;
  const qt = document.createElement("span");
  qt.className = "q-text";
  qt.textContent = question;
  q.appendChild(qt);

  const a = document.createElement("div");
  a.className = "chat-a has-md";
  a.dataset.raw = String(answer || "");
  const body = document.createElement("div");
  body.className = "chat-a-body";
  body.innerHTML = renderMarkdown(answer || "");
  a.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "chat-a-actions";
  actions.hidden = !String(answer || "").trim();
  actions.innerHTML = CHAT_COPY_BTN_HTML;
  a.appendChild(actions);

  item.appendChild(q);
  item.appendChild(a);
  threadEl.appendChild(item);
  return item;
}

async function persistCurrentSession() {
  if (!history.length) return;
  try {
    const firstUser = history.find((m) => m.role === "user" && String(m.content || "").trim());
    const res = await window.lyknOverlay.saveOverlaySession({
      sessionId: currentSessionId,
      messages: history,
      title: firstUser ? String(firstUser.content).trim().slice(0, 72) : undefined,
      pageSource: currentPageSource && currentPageSource.url ? currentPageSource : null,
    });
    if (res && res.sessionId) currentSessionId = res.sessionId;
  } catch (_) {}
}

function rebuildThreadFromHistory(openLast) {
  threadEl.innerHTML = "";
  let pendingQ = null;
  const pairs = [];
  for (const m of history) {
    if (m.role === "user") pendingQ = m.content;
    else if (m.role === "assistant" && pendingQ != null) {
      pairs.push({ q: pendingQ, a: m.content });
      pendingQ = null;
    }
  }
  pairs.forEach((p, i) => {
    const isLast = i === pairs.length - 1;
    renderHistoricTurn(p.q, p.a, openLast ? !isLast : true);
  });
  threadEl.classList.toggle("show", pairs.length > 0);
  reportHeight();
  // Unpaired trailing user message (in-flight agent turn) — caller may resume it.
  return pendingQ;
}

async function loadOverlaySession(session) {
  if (!session || !Array.isArray(session.messages)) return;
  history.length = 0;
  history.push(...session.messages);
  currentSessionId = session.id;
  rebuildThreadFromHistory(true);
  clearSide();
  setHistoryOpen(false);
  setMenuOpen(false);
  // Opening a chat always lands in plain chat mode — image/build stickiness
  // belongs to the session the user armed it in, not the one they open.
  setComposerMode("chat");
  // Past chats don't carry project scope today — clear so we don't leak
  // a previous project's context into an unrelated thread.
  setScopedProject(null);
  askEl.focus();
}

async function startNewMainAgentChat() {
  if (!window.lyknOverlay?.agentResetMain) return false;
  try {
    const res = await window.lyknOverlay.agentResetMain();
    if (!res?.ok) return false;
    activeAgentId = res.agentId || activeAgentId;
    applyAgentTranscript(res.history || [], res.agent || null);
    clearSide();
    setHistoryOpen(false);
    setMenuOpen(false);
    askEl.focus();
    reportHeight();
    return true;
  } catch (_) {
    return false;
  }
}

async function startNewOverlayChat() {
  // In Agent Mode, New chat resets Main (orchestrator thread) — stay armed.
  if (agentModeArmed || composerMode === "agent") {
    const ok = await startNewMainAgentChat();
    if (ok) return;
  }
  await persistCurrentSession();
  try {
    const res = await window.lyknOverlay.newOverlaySession();
    currentSessionId = (res && res.sessionId) || null;
  } catch (_) {
    currentSessionId = null;
  }
  history.length = 0;
  threadEl.innerHTML = "";
  threadEl.classList.remove("show");
  liveNotesSnapshot = {
    keyPoints: [],
    actionItems: [],
    summary: "",
    questionsToAsk: [],
    suggestions: [],
    topics: [],
  };
  clearSide();
  setHistoryOpen(false);
  // New chats always start in plain chat mode (project scope cleared unless
  // the caller re-scopes immediately after — see select-project).
  setComposerMode("chat");
  setScopedProject(null);
  askEl.focus();
  // Only place we intentionally shrink — new chat resets the bar height.
  reportHeight();
}

// Keep the last status so we can re-attach the building spinner under the
// description after each markdown rewrite (updateAnswer replaces innerHTML).
let lastThinkingStatus = "Thinking…";
let answerStillWorking = false;

function ensureBuildingUnder(status) {
  if (!currentAnswerEl || !currentHasText) return;
  const body = ensureAnswerChrome(currentAnswerEl) || currentAnswerEl;
  let wrap = body.querySelector(".building-under");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "building-under";
    wrap.innerHTML = thinkingHTML();
    body.appendChild(wrap);
  }
  const el = wrap.querySelector(".thinking-text");
  if (el) el.textContent = status || lastThinkingStatus || "Building…";
}

function clearBuildingUnder() {
  stopStatusRotation();
  const wrap = currentAnswerEl && currentAnswerEl.querySelector(".building-under");
  if (wrap) wrap.remove();
}

// Update the shimmer status label. Before any answer text arrives this drives
// the initial spinner; once the model has written a description (common in
// build mode), keep showing the same animation UNDER that description so the
// user can see LYKN is still building.
function setThinkingStatus(text) {
  if (!currentAnswerEl) return;
  const next = text || "Thinking…";
  lastThinkingStatus = next;
  maybeRotateFromStatus(next);
  // If rotation claimed this status, it already painted via applyRotatedStatus.
  if (statusRotateActive && (GENERIC_BUILD_RE.test(next) || GENERIC_THINK_RE.test(next))) {
    threadEl.scrollTop = threadEl.scrollHeight;
    return;
  }
  if (!currentHasText) {
    const el = currentAnswerEl.querySelector(".thinking-text");
    if (el) el.textContent = lastThinkingStatus;
  } else if (shouldKeepBuildingUnder()) {
    ensureBuildingUnder(lastThinkingStatus);
  }
  threadEl.scrollTop = threadEl.scrollHeight;
  // Don't resize on status text swaps — height rarely changes and it adds noise.
}

// Earlier notes stay as rendered; only the latest one writes out.
function newestStepNoteNodes(bodyEl) {
  const steps = [...bodyEl.querySelectorAll(".md-step")];
  const last = steps[steps.length - 1];
  if (!last) return null;
  const nodes = [];
  let n = last.nextElementSibling;
  while (n && !n.classList.contains("md-step") && n.tagName !== "HR") {
    nodes.push(n);
    n = n.nextElementSibling;
  }
  if (!nodes.length) return null;
  const key = `${last.getAttribute("data-agent-id") || ""}/${last.getAttribute("data-step-index") || steps.length - 1}`;
  const target = nodes
    .map((el) => el.textContent)
    .join("\n\n")
    .replace(/\s+$/, "")
    .trim();
  if (!target) return null;
  return { key, nodes, target };
}

function typeNewestStepNote(bodyEl) {
  const found = newestStepNoteNodes(bodyEl);
  if (!found) {
    stopStepNoteTyping();
    return;
  }
  const { key, nodes, target } = found;
  const htmls = nodes.map((el) => el.innerHTML);
  if (stepNoteType.key !== key || !target.startsWith(stepNoteType.shown)) {
    stopStepNoteTyping();
    stepNoteType.key = key;
    stepNoteType.shown = "";
  }
  stepNoteType.target = target;
  nodes.forEach((el, i) => {
    if (i === 0) {
      el.classList.add("md-step-note");
      el.textContent = stepNoteType.shown;
    } else {
      el.hidden = true;
    }
  });
  const finish = () => {
    nodes.forEach((el, i) => {
      el.hidden = false;
      if (htmls[i] != null) el.innerHTML = htmls[i];
      el.classList.add("md-step-note");
    });
    stepNoteType.shown = target;
    stepNoteType.timer = null;
    threadEl.scrollTop = threadEl.scrollHeight;
    reportHeight();
  };
  if (stepNoteType.shown === target) {
    finish();
    return;
  }
  const stepMs = target.length > 220 ? 12 : target.length > 80 ? 16 : 22;
  const tick = () => {
    if (stepNoteType.shown === stepNoteType.target) {
      finish();
      return;
    }
    const rest = stepNoteType.target.startsWith(stepNoteType.shown)
      ? stepNoteType.target.slice(stepNoteType.shown.length)
      : stepNoteType.target;
    const m = rest.match(/^(\s+|\S+)/);
    stepNoteType.shown =
      (stepNoteType.target.startsWith(stepNoteType.shown) ? stepNoteType.shown : "") +
      (m ? m[1] : rest);
    if (nodes[0]) nodes[0].textContent = stepNoteType.shown;
    threadEl.scrollTop = threadEl.scrollHeight;
    reportHeight();
    stepNoteType.timer = setTimeout(tick, stepMs);
  };
  stopStepNoteTyping();
  stepNoteType.timer = setTimeout(tick, stepMs);
}

function updateAnswer(text) {
  if (!currentAnswerEl) return;
  const bodyEl = ensureAnswerChrome(currentAnswerEl);
  if (!bodyEl) return;
  // Trim trailing blank lines/whitespace — with pre-wrap they'd render as empty
  // vertical space and make the panel look like it grew for no reason.
  const trimmed = (text || "").replace(/\s+$/, "");
  if (!trimmed && !currentHasText) return; // keep the spinner until real text
  currentHasText = true;
  currentAnswerEl.classList.add("has-md");
  currentAnswerEl.dataset.raw = trimmed;
  bodyEl.innerHTML = renderMarkdown(trimmed);
  const hasLiveStep = /lykn-agent-step:\/\/[^)\s]+\/live\b/i.test(trimmed);
  const shouldTypeNotes =
    /lykn-agent-step:\/\//i.test(trimmed) && (answerStillWorking || hasLiveStep);
  if (shouldTypeNotes) typeNewestStepNote(bodyEl);
  else stopStepNoteTyping();
  const actions = currentAnswerEl.querySelector(":scope > .chat-a-actions");
  if (actions) actions.hidden = !trimmed;
  // Build mode: description lands first, then the tool runs for a while with
  // no more text — put the thinking animation under the description so it's
  // obvious LYKN is still working. Regular chat drops the spinner as soon as
  // the reply text is on screen so it doesn't keep looping after the model
  // has finished saying what it was going to say.
  if (shouldKeepBuildingUnder()) ensureBuildingUnder(lastThinkingStatus);
  else if (statusRotateLane !== "build") stopStatusRotation();
  // Generated images / artifact iframes load async — resize once they settle,
  // or the bubble stays sized for text only and the preview gets clipped.
  const onMediaReady = () => {
    threadEl.scrollTop = threadEl.scrollHeight;
    reportHeight();
  };
  bodyEl.querySelectorAll(".md-img img").forEach((img) => {
    if (img.complete) return;
    img.addEventListener("load", onMediaReady, { once: true });
  });
  bodyEl.querySelectorAll(".md-artifact iframe").forEach((frame) => {
    frame.addEventListener("load", onMediaReady, { once: true });
  });
  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
}

/**
 * "Paused, waiting on you" indicator. The agent parks on sign-in walls and
 * manual steps while still watching the tab, but the turn itself finishes — so
 * the busy spinner goes away. This row keeps the same mark drawing, under a
 * label saying what it is waiting for, until the runtime says the wall cleared,
 * so a parked run never looks like a done run.
 */
let pendingAgentWaiting = null;

function clearAgentWaitingRow(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return;
  el.querySelectorAll(":scope > .agent-waiting-row").forEach((n) => n.remove());
}

function renderAgentWaitingRow(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return;
  clearAgentWaitingRow(el);
  if (!pendingAgentWaiting) return;
  const row = document.createElement("div");
  row.className = "agent-waiting-row";
  // Same mark and shimmer as the thinking state, just saying something else.
  row.innerHTML = thinkingHTML();
  const label = row.querySelector(".thinking-text");
  if (label) label.textContent = pendingAgentWaiting.label;
  if (pendingAgentWaiting.detail) {
    const detail = document.createElement("div");
    detail.className = "agent-waiting-detail";
    detail.textContent = pendingAgentWaiting.detail;
    row.appendChild(detail);
  }
  const actions = el.querySelector(":scope > .chat-a-actions");
  if (actions) el.insertBefore(row, actions);
  else el.appendChild(row);
  reportHeight();
}

function setAgentWaiting(p) {
  if (!p?.waiting) {
    pendingAgentWaiting = null;
    clearAgentWaitingRow();
    reportHeight();
    return;
  }
  const kind = String(p.kind || "");
  const host = String(p.host || "").trim();
  const fallback =
    kind === "signin"
      ? `Waiting for you to sign in${host ? ` to ${host}` : ""}`
      : kind === "approval"
        ? "Waiting for your go-ahead"
        : "Waiting for you";
  pendingAgentWaiting = {
    label: String(p.label || "").trim() || fallback,
    detail: String(p.detail || "").trim(),
  };
  renderAgentWaitingRow();
}

/** Choice buttons under an agent answer (e.g. complex software → artifact vs stop). */
let pendingAgentChoice = null;

function clearAgentChoiceButtons(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return;
  el.querySelectorAll(":scope > .agent-choice-row").forEach((n) => n.remove());
}

function showAgentChoiceButtons(choice, answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el || !choice || !Array.isArray(choice.buttons) || !choice.buttons.length) return;
  clearAgentChoiceButtons(el);
  pendingAgentChoice = {
    agentId: choice.agentId || activeAgentId,
    choiceId: choice.choiceId || choice.id || "",
    buttons: choice.buttons,
  };
  const row = document.createElement("div");
  row.className = "agent-choice-row";
  for (const btn of choice.buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "agent-choice-btn " + (btn.primary ? "primary" : "secondary");
    b.textContent = String(btn.label || btn.id || "Choose");
    b.dataset.choiceId = String(pendingAgentChoice.choiceId || "");
    b.dataset.buttonId = String(btn.id || "");
    b.addEventListener("click", () => {
      void resolveAgentChoiceClick(b.dataset.choiceId, b.dataset.buttonId, row);
    });
    row.appendChild(b);
  }
  const actions = el.querySelector(":scope > .chat-a-actions");
  if (actions) el.insertBefore(row, actions);
  else el.appendChild(row);
  reportHeight();
}

async function resolveAgentChoiceClick(choiceId, buttonId, rowEl) {
  const agentId = pendingAgentChoice?.agentId || activeAgentId;
  if (!agentId || !buttonId) return;
  if (rowEl) {
    rowEl.querySelectorAll("button").forEach((b) => {
      b.disabled = true;
    });
  }
  setBusy(true);
  setThinkingStatus(
    buttonId === "use-artifact"
      ? "Building custom artifact…"
      : buttonId === "send"
        ? "Sending…"
        : buttonId === "approve"
          ? "Continuing…"
          : buttonId === "decline"
            ? "Skipping that step…"
            : "Stopping…",
  );
  // The send run streams progress into the current turn while we await it.
  if (buttonId === "send") answerStillWorking = true;
  // Local Mode approval: the paused local task resumes (or safely skips the
  // step) and keeps streaming into this same turn.
  if (buttonId === "approve" || buttonId === "decline") answerStillWorking = true;
  try {
    const res = await window.lyknOverlay.agentChoiceResolve(
      agentId,
      choiceId,
      buttonId,
    );
    pendingAgentChoice = null;
    clearAgentChoiceButtons();
    if (res?.ok && res?.spawned && res?.agentId) {
      activeAgentId = res.agentId;
      setBusy(true);
      reportHeight();
      return;
    }
    if (res?.ok && res?.text) {
      if (!currentAnswerEl) {
        startTurn("Choice");
      }
      updateAnswer(res.text);
      const last = history[history.length - 1];
      if (!(last && last.role === "assistant" && last.content === res.text)) {
        history.push({
          role: "assistant",
          content: res.text,
          at: new Date().toISOString(),
        });
      }
    } else if (!res?.ok) {
      updateAnswer(res?.error || "Couldn't apply that choice.");
    }
    // use-artifact starts a build — stream handlers finish the turn.
    if (res?.ok && buttonId === "use-artifact" && !res?.stopped) {
      setBusy(true);
      answerStillWorking = true;
      reportHeight();
      return;
    }
    // Local Mode approval resolved — the paused task is still running; its
    // delta/done events finish the turn.
    if (res?.ok && (buttonId === "approve" || buttonId === "decline")) {
      setBusy(true);
      answerStillWorking = true;
      reportHeight();
      return;
    }
  } catch (e) {
    updateAnswer(e?.message || "Couldn't apply that choice.");
  }
  answerStillWorking = false;
  clearBuildingUnder();
  setBusy(false);
  reportHeight();
  askEl.focus();
}

const DEFAULT_ASK_PLACEHOLDER = "Ask LYKN about your screen…";
let browserActArmed = false;
// Image generation is explicit-opt-in (menu → "Create an image"), mirroring
// the web app's "+" → Generate image mode. STICKY: once armed, every send is
// an image prompt (forceImage rides along to the server, which forces GPT
// Image 2) until the user switches back to chat mode — via the composer's
// mode pill ✕, the menu toggle, or starting a new chat.
let imageGenArmed = false;
// Build mode (menu → "Build mode"): sends ask LYKN to CODE the thing out — a
// live React artifact (landing page, dashboard, mini-tool…) rendered inline,
// same pipeline as the web app's Claude-style artifacts. Sticky like image
// mode.
let buildModeArmed = false;
let researchModeArmed = false;
let translateModeArmed = false;
let transcribeModeArmed = false;
let agentModeArmed = false;
/** Active Glass Agent Mode agent id (main owns the registry). */
let activeAgentId = null;
/** Partial stream text for the active agent turn. */
let agentStreamingText = "";
/** Live system+mic capture for Transcribe mode (declared early for mode sync). */
let listening = false;
/** Prevent setComposerMode ↔ start/stopListen feedback loops. */
let syncingTranscribeMode = false;

// ── Composer mode (chat / image / build / agent / research / translate / transcribe)
// One switch owns the armed flags, the placeholder, the composer pill, and
// the drawer badges, so every entry point (menu toggle, pill ✕, new chat,
// Escape) stays consistent.
const MODE_ICON_SVG = {
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  build:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  agent:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
  research:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  translate:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  transcribe:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>',
};
const COMPOSER_MODES = {
  chat: { placeholder: DEFAULT_ASK_PLACEHOLDER, title: "" },
  image: {
    placeholder: "Describe the image to create, then Send…",
    title: "Image mode — click to exit",
  },
  build: {
    placeholder: "Describe what to build, then Send…",
    title: "Build mode — click to exit",
  },
  agent: {
    placeholder: "Agent goal — research, build, browse, or monitor…",
    title: "Agent mode — click to exit",
  },
  research: {
    placeholder: "Deep research a topic — multi-source analysis…",
    title: "Deep research — click to exit",
  },
  translate: {
    placeholder: "Translate your screen, or type text…",
    title: "Translate mode — click to exit",
  },
  transcribe: {
    placeholder: "Listening to system + mic — ask about what's being said…",
    title: "Transcribe — click to exit",
  },
};
let composerMode = "chat";
const modeBadgeEl = document.getElementById("mode-badge");
const modeBadgeIconEl = document.getElementById("mode-badge-icon");
const projectPillEl = document.getElementById("project-pill");
const projectPillLabelEl = document.getElementById("project-pill-label");
const translateLangPillEl = document.getElementById("translate-lang-pill");
const translateLangBtnEl = document.getElementById("translate-lang-btn");
const translateLangMenuEl = document.getElementById("translate-lang-menu");
const translateLangLabelEl = document.getElementById("translate-lang-label");
const TRANSLATE_LANG_KEY = "lykn.glass.translateLang";
const TRANSLATE_LANGS = [
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Japanese",
  "Korean",
  "Arabic",
  "Hindi",
  "Russian",
  "Polish",
  "Turkish",
  "Vietnamese",
  "Thai",
  "Swedish",
  "Norwegian",
  "Danish",
  "Finnish",
  "Greek",
  "Hebrew",
  "English",
];
let translateTargetLang = "Spanish";
/** Explicit Glass project scope from the menu Projects picker (null = general). */
let scopedProject = null; // { id, name } | null

function getTranslateTargetLang() {
  return translateTargetLang || "Spanish";
}

function setTranslateLangMenuOpen(open) {
  if (!translateLangPillEl || !translateLangBtnEl) return;
  translateLangPillEl.classList.toggle("open", !!open);
  translateLangBtnEl.setAttribute("aria-expanded", open ? "true" : "false");
  // In-window list stays hidden — the real list is a detached vibrancy card
  // (same pattern as the three-dot menu), so the chat bar never grows/moves.
  if (translateLangMenuEl) translateLangMenuEl.hidden = true;
  try {
    if (open && translateLangPillEl) {
      const r = translateLangPillEl.getBoundingClientRect();
      window.lyknOverlay.setLangPicker(true, {
        left: r.left,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    } else {
      window.lyknOverlay.setLangPicker(false);
    }
  } catch (_) {}
}

window.__lyknLangPickerState = () => ({
  languages: TRANSLATE_LANGS.slice(),
  active: getTranslateTargetLang(),
});

if (window.lyknOverlay?.onLangPickerSelect) {
  window.lyknOverlay.onLangPickerSelect((p) => {
    const lang = String(p?.lang || "").trim();
    if (lang) setTranslateTargetLang(lang);
    setTranslateLangMenuOpen(false);
    askEl.focus();
  });
}
if (window.lyknOverlay?.onLangPickerVisible) {
  window.lyknOverlay.onLangPickerVisible((visible) => {
    if (!translateLangPillEl || !translateLangBtnEl) return;
    translateLangPillEl.classList.toggle("open", !!visible);
    translateLangBtnEl.setAttribute("aria-expanded", visible ? "true" : "false");
  });
}

function renderTranslateLangMenu() {
  if (!translateLangMenuEl) return;
  const cur = getTranslateTargetLang();
  translateLangMenuEl.innerHTML = TRANSLATE_LANGS.map(
    (lang) =>
      `<button type="button" class="lang-option" role="option" data-lang="${lang.replace(/"/g, "&quot;")}" aria-selected="${lang === cur ? "true" : "false"}">${lang}</button>`,
  ).join("");
}

function setTranslateTargetLang(lang) {
  const next = TRANSLATE_LANGS.includes(lang) ? lang : "Spanish";
  translateTargetLang = next;
  if (translateLangLabelEl) translateLangLabelEl.textContent = next;
  try {
    localStorage.setItem(TRANSLATE_LANG_KEY, next);
  } catch (_) {}
  renderTranslateLangMenu();
  if (composerMode === "translate") {
    askEl.placeholder = `Translate screen to ${next}, or type text…`;
  }
}

function loadTranslateTargetLang() {
  try {
    const saved = String(localStorage.getItem(TRANSLATE_LANG_KEY) || "").trim();
    if (TRANSLATE_LANGS.includes(saved)) translateTargetLang = saved;
  } catch (_) {}
  if (translateLangLabelEl) translateLangLabelEl.textContent = translateTargetLang;
  renderTranslateLangMenu();
}

loadTranslateTargetLang();
if (translateLangBtnEl) {
  translateLangBtnEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = !translateLangPillEl?.classList.contains("open");
    setTranslateLangMenuOpen(open);
  });
}
if (translateLangMenuEl) {
  translateLangMenuEl.addEventListener("click", (e) => {
    const opt = e.target.closest(".lang-option");
    if (!opt) return;
    e.preventDefault();
    e.stopPropagation();
    setTranslateTargetLang(opt.getAttribute("data-lang") || "Spanish");
    setTranslateLangMenuOpen(false);
    askEl.focus();
  });
}
document.addEventListener("click", (e) => {
  if (!translateLangPillEl || translateLangPillEl.hidden) return;
  if (translateLangPillEl.contains(e.target)) return;
  setTranslateLangMenuOpen(false);
});

const COPY_BTN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16V4a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_BTN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CHAT_COPY_BTN_HTML =
  `<button type="button" class="chat-copy" title="Copy answer" aria-label="Copy answer">${COPY_BTN_SVG}</button>`;

function renderModeBadge(id, on) {
  const el = document.getElementById(id);
  if (el) el.textContent = on ? "On" : "Off";
}

function renderProjectPill() {
  if (!projectPillEl) return;
  const name = scopedProject?.name ? String(scopedProject.name).trim() : "";
  projectPillEl.hidden = !name;
  if (projectPillLabelEl) {
    projectPillLabelEl.textContent = name ? name.slice(0, 28) : "Project";
  }
  projectPillEl.title = name ? `Scoped to ${name} — click to clear` : "Clear project scope";
  reportHeight();
}

function setScopedProject(next) {
  if (next && next.id) {
    scopedProject = {
      id: String(next.id).trim(),
      name: String(next.name || "Project").trim().slice(0, 120) || "Project",
    };
  } else {
    scopedProject = null;
  }
  renderProjectPill();
}

function setComposerMode(mode) {
  const prev = composerMode;
  composerMode = COMPOSER_MODES[mode] ? mode : "chat";
  imageGenArmed = composerMode === "image";
  buildModeArmed = composerMode === "build";
  agentModeArmed = composerMode === "agent";
  researchModeArmed = composerMode === "research";
  translateModeArmed = composerMode === "translate";
  transcribeModeArmed = composerMode === "transcribe";
  askEl.placeholder =
    composerMode === "translate"
      ? `Translate screen to ${getTranslateTargetLang()}, or type text…`
      : COMPOSER_MODES[composerMode].placeholder;
  if (modeBadgeEl) {
    const active = composerMode !== "chat";
    modeBadgeEl.hidden = !active;
    if (active) {
      const meta = COMPOSER_MODES[composerMode] || {};
      modeBadgeEl.title = meta.title || "Back to chat";
      modeBadgeEl.setAttribute("aria-label", meta.title || "Back to chat");
      if (modeBadgeIconEl) {
        modeBadgeIconEl.innerHTML = MODE_ICON_SVG[composerMode] || "";
      }
    }
  }
  if (translateLangPillEl) {
    translateLangPillEl.hidden = composerMode !== "translate";
    if (composerMode !== "translate") {
      try {
        window.lyknOverlay.setLangPicker(false);
      } catch (_) {}
      translateLangPillEl.classList.remove("open");
      if (translateLangBtnEl) translateLangBtnEl.setAttribute("aria-expanded", "false");
    }
  }
  renderModeBadge("image-gen-state", composerMode === "image");
  renderModeBadge("build-state", composerMode === "build");
  renderModeBadge("agent-state", composerMode === "agent");
  renderModeBadge("research-state", composerMode === "research");
  renderModeBadge("translate-state", composerMode === "translate");
  renderModeBadge("transcribe-state", composerMode === "transcribe" || listening);
  reportHeight();

  // Agent Mode: open Cursor-style agent sidebar + browser stage; leave → hide.
  if (composerMode === "agent" && prev !== "agent") {
    void enterAgentMode();
  } else if (prev === "agent" && composerMode !== "agent") {
    void leaveAgentMode();
  } else {
  }

  // Transcribe mode = live system+mic capture (same pipeline as former
  // "Live meeting notes"). Arm → start listening; leave → stop.
  if (!syncingTranscribeMode) {
    if (composerMode === "transcribe" && prev !== "transcribe") {
      void ensureTranscribeListening();
    } else if (prev === "transcribe" && composerMode !== "transcribe") {
      if (listening) stopListen();
    }
  }
}

async function enterAgentMode() {
  try {
    const res = await window.lyknOverlay.agentModeSet(true);
    if (res?.activeAgentId) activeAgentId = res.activeAgentId;
    const snap = await window.lyknOverlay.agentHistory(activeAgentId);
    applyAgentTranscript(snap?.history || [], snap?.agent || snap || null);
  } catch (_) {}
}

async function leaveAgentMode() {
  try {
    await window.lyknOverlay.agentModeSet(false);
  } catch (_) {}
}

/**
 * Paint an agent's transcript in Glass. If the agent is mid-run, reopen the
 * pending user turn with spinner / partial stream text (history alone drops
 * unpaired user messages).
 */
function applyAgentTranscript(nextHistory, agentMeta) {
  history.length = 0;
  if (Array.isArray(nextHistory)) history.push(...nextHistory);
  const pendingQ = rebuildThreadFromHistory(true);
  currentAnswerEl = null;
  currentChatEl = null;
  streamingText = "";
  agentStreamingText = "";

  const busy = !!(agentMeta && (agentMeta.busy || agentMeta.status === "running"));
  const partial = String(
    (agentMeta && (agentMeta.partialText || agentMeta.partial_text)) || "",
  ).trim();
  const step = String((agentMeta && agentMeta.step) || "").trim() || "Thinking…";

  if (busy || pendingQ) {
    const q =
      pendingQ ||
      String((agentMeta && agentMeta.title) || "").trim() ||
      "Working…";
    startTurn(q);
    // history already contains the user message from the registry — don't push again
    setBusy(true);
    answerStillWorking = true;
    if (partial) {
      agentStreamingText = partial;
      updateAnswer(partial);
      if (answerStillWorking) setThinkingStatus(step);
    } else {
      setThinkingStatus(step);
    }
  } else {
    setBusy(false);
    answerStillWorking = false;
  }
}

async function ensureTranscribeListening() {
  if (listening) {
    renderModeBadge("transcribe-state", true);
    return;
  }
  await startListen();
  if (!listening) {
    // Permission / capture failed — drop back to chat.
    syncingTranscribeMode = true;
    try {
      setComposerMode("chat");
    } finally {
      syncingTranscribeMode = false;
    }
  }
}

/** Ensure answer DOM has a stable body + Copy footer (survives markdown rewrites). */
function ensureAnswerChrome(answerEl) {
  const el = answerEl || currentAnswerEl;
  if (!el) return null;
  let body = el.querySelector(":scope > .chat-a-body");
  let actions = el.querySelector(":scope > .chat-a-actions");
  if (!body) {
    body = document.createElement("div");
    body.className = "chat-a-body";
    const keep = [];
    while (el.firstChild) keep.push(el.removeChild(el.firstChild));
    for (const node of keep) {
      if (node.classList && node.classList.contains("chat-a-actions")) {
        actions = node;
      } else {
        body.appendChild(node);
      }
    }
    el.appendChild(body);
  }
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "chat-a-actions";
    actions.hidden = true;
    actions.innerHTML = CHAT_COPY_BTN_HTML;
    el.appendChild(actions);
  }
  return body;
}

/** Strip Glass UI chrome and map display-only markdown nodes to semantic tags. */
function htmlForClipboardFromBody(body) {
  if (!body) return "";
  try {
    const clone = body.cloneNode(true);
    clone
      .querySelectorAll(
        "button, iframe, script, style, .md-artifact-actions, .md-artifact-code, .md-step-chevron, .md-step-kind, .md-vault-open",
      )
      .forEach((n) => n.remove());
    clone.querySelectorAll(".md-h").forEach((el) => {
      const h = document.createElement("h2");
      h.innerHTML = el.innerHTML;
      el.replaceWith(h);
    });
    return clone.innerHTML || "";
  } catch (_) {
    return String(body.innerHTML || "");
  }
}

async function copyAnswerText(btn) {
  const answerEl = btn?.closest?.(".chat-a");
  if (!answerEl) return;
  const body = answerEl.querySelector(":scope > .chat-a-body");
  // Prefer rendered body so paste targets get real headings/bold, not ## / **.
  // Fall back to converting dataset.raw markdown when the body isn't ready.
  let plain = String(body?.innerText || body?.textContent || "").trim();
  let html = "";
  const fromBody = htmlForClipboardFromBody(body);
  if (fromBody.trim()) {
    html = wrapClipboardHtml(fromBody);
  } else {
    const raw = String(answerEl.dataset.raw || "").trim();
    if (raw) {
      const rendered = renderMarkdown(raw);
      const tmp = document.createElement("div");
      tmp.innerHTML = rendered;
      html = wrapClipboardHtml(htmlForClipboardFromBody(tmp) || rendered);
      if (!plain) {
        plain = String(tmp.innerText || tmp.textContent || "").trim() || raw;
      }
    }
  }
  if (!plain && !html) return;
  const ok = await writeRichClipboard(plain, html);
  if (!ok) return;
  btn.classList.add("copied");
  btn.innerHTML = CHECK_BTN_SVG;
  btn.title = "Copied";
  btn.setAttribute("aria-label", "Copied");
}

/** Selected text from the dark glass UI — paste targets get black, not white. */
function selectionPlainText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return String(sel.toString());
}

/** Clone the current selection as HTML so bold/headings survive paste. */
function selectionRichHtml() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  try {
    const container = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    container
      .querySelectorAll(
        "button, iframe, script, style, .md-artifact-actions, .md-artifact-code, .md-step-chevron, .md-step-kind, .md-vault-open",
      )
      .forEach((n) => n.remove());
    container.querySelectorAll(".md-h").forEach((el) => {
      const h = document.createElement("h2");
      h.innerHTML = el.innerHTML;
      el.replaceWith(h);
    });
    return container.innerHTML || "";
  } catch (_) {
    return "";
  }
}

function wrapClipboardHtml(fragmentHtml) {
  const inner = String(fragmentHtml || "").trim();
  if (!inner) return "";
  return (
    `<meta charset="utf-8">` +
    `<div style="color:#000000; -webkit-text-fill-color:#000000;">${inner}</div>`
  );
}

function blackHtmlFromPlain(text) {
  const escaped = escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");
  return wrapClipboardHtml(escaped);
}

async function writeRichClipboard(plain, html) {
  const text = String(plain || "").trim();
  const rich = String(html || "").trim();
  if (!text && !rich) return false;
  if (rich && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text || ""], { type: "text/plain" }),
          "text/html": new Blob([rich], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch (_) {
      /* fall through */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (_) {
      return false;
    }
  }
}

function writeBlackTransferData(transfer, text, htmlFragment) {
  if (!transfer || !text) return false;
  transfer.setData("text/plain", text);
  const rich = htmlFragment
    ? wrapClipboardHtml(htmlFragment)
    : blackHtmlFromPlain(text);
  transfer.setData("text/html", rich);
  return true;
}

// Select-to-copy / drag-copy keeps the overlay's light text color in HTML
// clipboard data, so paste into Docs/Word/email looks invisible. Rewrite with
// black text while preserving semantic tags (strong, headings, lists).
document.addEventListener("copy", (e) => {
  const text = selectionPlainText();
  if (!text || !e.clipboardData) return;
  e.preventDefault();
  writeBlackTransferData(e.clipboardData, text, selectionRichHtml());
});

document.addEventListener("dragstart", (e) => {
  const text = selectionPlainText();
  if (!text || !e.dataTransfer) return;
  writeBlackTransferData(e.dataTransfer, text, selectionRichHtml());
});

// Mode icon in the titlebar — click exits back to chat.
if (modeBadgeEl) {
  modeBadgeEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setComposerMode("chat");
    askEl.focus();
  });
}
if (projectPillEl) {
  projectPillEl.addEventListener("click", () => {
    setScopedProject(null);
    askEl.focus();
  });
}
let pendingBrowserPlan = null;
let executingBrowser = false;

const browserActEl = document.getElementById("browser-act");
const browserActStepsEl = document.getElementById("browser-act-steps");
const browserActRunEl = document.getElementById("browser-act-run");
const browserActCancelEl = document.getElementById("browser-act-cancel");

function formatBrowserStep(action) {
  const label = action.label || action.selector || "element";
  if (action.type === "click") return `Click “${label}”`;
  if (action.type === "type") {
    const v = String(action.value || "").slice(0, 48);
    return `Type “${v}” into “${label}”`;
  }
  if (action.type === "press") {
    const base = String(label).replace(/ — submit$/i, "");
    return `Press Enter to submit “${base}”`;
  }
  if (action.type === "scroll") {
    const d = Number(action.delta) || 400;
    return d >= 0 ? "Scroll down" : "Scroll up";
  }
  return label;
}

function browserActErrorMessage(plan) {
  const code = plan && plan.error;
  const msg = (plan && plan.message) || "";
  if (code === "apple_events_disabled") {
    return (
      "Browser control needs **Allow JavaScript from Apple Events** enabled in your browser " +
      "(Chrome: View → Developer). Then try again."
    );
  }
  if (code === "needs_extension") {
    return (
      plan?.message ||
      "Install **Chrome Live Feed** so LYKN can read your active tab. Browser click-control is macOS-only for now — ask about what's on screen instead."
    );
  }
  if (code === "control_mac_only") {
    return (
      plan?.message ||
      "Clicking and typing in the browser is macOS-only for now. LYKN can still read your tab via Chrome Live Feed — ask about the page or what's on screen."
    );
  }
  if (code === "new_tab") {
    return (
      plan?.message ||
      "Navigate to a real website first (e.g. youtube.com). Blank new-tab pages can't be controlled."
    );
  }
  if (code === "no_browser") {
    return (
      plan?.message ||
      "No browser tab found. Open an https:// page in Chrome (not a blank new-tab page), then try again."
    );
  }
  if (code === "no_auth") return "Sign in to LYKN in the main app to use browser control.";
  if (code === "no_actions") {
    return (plan && plan.explanation) || "Could not plan any safe actions for this page.";
  }
  return msg || "Could not plan browser actions.";
}

function hideBrowserActPanel() {
  pendingBrowserPlan = null;
  if (browserActEl) browserActEl.hidden = true;
  composerEl.classList.remove("browser-act-open");
  reportHeight();
}

function showBrowserActPanel(plan) {
  if (!browserActEl || !browserActStepsEl || !plan) return;
  browserActStepsEl.innerHTML = "";
  const actions = plan.actions || [];
  const adaptive =
    plan.adaptivePreview || (!actions.length && plan.intent);
  if (adaptive) {
    const steps = String(plan.taskPlan || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (steps.length) {
      for (const step of steps) {
        const li = document.createElement("li");
        li.textContent = step.replace(/^\d+\.\s*/, "");
        browserActStepsEl.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "Reads your screen, plans steps like chat, then executes one at a time";
      browserActStepsEl.appendChild(li);
    }
  } else if (actions.length) {
    for (const action of actions) {
      const li = document.createElement("li");
      li.textContent = formatBrowserStep(action);
      browserActStepsEl.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    li.textContent =
      "Reads your screen, picks one step, clicks, waits for the page to change, then re-reads";
    browserActStepsEl.appendChild(li);
  }
  browserActEl.hidden = false;
  composerEl.classList.add("browser-act-open");
  if (browserActRunEl) {
    browserActRunEl.disabled = false;
    browserActRunEl.textContent = "Run";
  }
  reportHeight();
}

function setBrowserActRunning(running) {
  if (!browserActEl || !browserActRunEl) return;
  browserActEl.hidden = false;
  composerEl.classList.add("browser-act-open");
  browserActRunEl.disabled = !!running;
  browserActRunEl.textContent = running ? "Running…" : "Run";
  reportHeight();
}

// Significant / irreversible actions that warrant an explicit confirmation
// before LYKN acts (money, deletion, sending/posting, account changes). Normal
// tasks run proactively without a preview gate.
function browserTaskIsSerious(goal, plan) {
  const hay = `${String(goal || "")}\n${String(plan?.taskPlan || "")}`.toLowerCase();
  return /\b(buy|purchase|order|checkout|check out|pay|payment|add to cart|place (an? )?order|subscribe|unsubscribe|delete|remove|erase|wipe|send (an? )?(email|message|dm|text|invite)|post|publish|tweet|submit (the |an? )?(application|form|payment|order|request)|transfer|withdraw|deposit|book (a |the )?(flight|hotel|ticket|room)|reserve|sign (a |the )?(contract|document|lease|up)|confirm (order|purchase|payment|booking)|delete (my )?account|log ?out|sign out|change (my )?(password|email|address|settings|plan)|apply for|cancel (my |the )?(order|subscription|account|booking|plan))\b/.test(
    hay,
  );
}

async function runBrowserAct(intent) {
  const goal = String(intent || "").trim();
  if (!goal || busy || executingBrowser) return;
  browserActArmed = false;
  // Restore the placeholder for whatever composer mode is armed (image/build
  // stay sticky through a browser-act detour).
  askEl.placeholder = COMPOSER_MODES[composerMode].placeholder;
  askEl.value = "";
  askEl.style.height = "48px";
  setBusy(true);
  startTurn(goal);
  hideBrowserActPanel();
  history.push({ role: "user", content: goal, at: new Date().toISOString() });
  setThinkingStatus("Scanning page…");
  try {
    const plan = await window.lyknOverlay.browserPlan(goal, history.slice(-8));
    if (!plan || !plan.ok) {
      currentHasText = true;
      updateAnswer(browserActErrorMessage(plan || {}));
      setBusy(false);
      askEl.focus();
      return;
    }
    pendingBrowserPlan = {
      ...plan,
      appName: plan.appName || plan.browser || "",
      intent: goal,
      taskPlan: plan.taskPlan || "",
      plannedAnswer: plan.plannedAnswer || "",
    };
    currentHasText = true;

    // Only gate on confirmation for significant/irreversible actions. Otherwise
    // be proactive and execute right away — no plan preview, no Run button.
    if (browserTaskIsSerious(goal, plan)) {
      showBrowserActPanel({ ...plan, intent: goal });
      updateAnswer(
        (plan.explanation || "Here's what I'll do.") +
          (plan.taskPlan ? `\n\n**Plan:**\n${plan.taskPlan}` : "") +
          "\n\n⚠️ This is a significant action. **Click Run to confirm**, or refine your request.",
      );
      setBusy(false);
      askEl.focus();
      return;
    }

    await executeBrowserAct({ auto: true });
  } catch (_) {
    currentHasText = true;
    updateAnswer("Could not plan browser actions.");
    setBusy(false);
    askEl.focus();
  }
}

async function executeBrowserAct({ auto = false } = {}) {
  const plan = pendingBrowserPlan;
  if (!plan || executingBrowser) return;
  executingBrowser = true;
  const actions = Array.isArray(plan.actions) ? plan.actions.slice() : [];
  const appName = plan.appName || plan.browser || "";
  const pageUrl = plan.url;
  const intent = plan.intent || "";
  if (!actions.length && !intent) {
    currentHasText = true;
    updateAnswer("No planned steps to run. Try Control this page again.");
    executingBrowser = false;
    setBusy(false);
    return;
  }
  // In auto mode we don't show the plan/Run panel — just stream progress inline.
  if (!auto) setBrowserActRunning(true);
  setBusy(true);
  setThinkingStatus(intent ? "Working on it…" : "Running in browser…");
  currentHasText = true;
  updateAnswer(intent ? "Working on it… (clicks pass through to Chrome)" : "Running browser actions…");
  const stopProgress =
    typeof window.lyknOverlay.onBrowserProgress === "function"
      ? window.lyknOverlay.onBrowserProgress(({ status }) => {
          if (!status) return;
          setThinkingStatus(status);
          updateAnswer(`**${status}**`);
        })
      : null;
  try {
    const result = await window.lyknOverlay.browserExecute({
      actions,
      appName,
      url: pageUrl,
      intent,
      taskPlan: plan.taskPlan || "",
      plannedAnswer: plan.plannedAnswer || "",
      conversationHistory: history.slice(-8),
      holoMessages: plan.holoMessages || null,
    });
    const summary = result?.ok
      ? result?.message || result?.explanation || "Done. Completed the task in your browser."
      : result?.message ||
        (result?.error === "no_actions"
          ? "No actions reached the browser."
          : result?.error === "no_browser"
            ? "Could not find the browser to control."
            : "Some actions failed.");
    updateAnswer(summary);
    history.push({
      role: "assistant",
      content: summary,
      at: new Date().toISOString(),
    });
    void persistCurrentSession();
    // Proactively save a summary of what was done to the user's vault.
    if (result?.ok && intent) {
      void saveBrowserTaskToVault({ intent, summary, result, pageUrl });
    }
  } catch (_) {
    updateAnswer("Failed to run browser actions.");
  } finally {
    if (typeof stopProgress === "function") stopProgress();
    executingBrowser = false;
    pendingBrowserPlan = null;
  }
  hideBrowserActPanel();
  setBusy(false);
  askEl.focus();
}

// Save a concise record of a finished browser task to the user's vault, then
// append a small confirmation line to the on-screen summary. Best-effort.
// Saved as a formatted task note (source=browser_task) — not a Quick Note.
async function saveBrowserTaskToVault({ intent, summary, result, pageUrl }) {
  if (typeof window.lyknOverlay.saveVaultNote !== "function") return;
  try {
    const steps = Array.isArray(result?.results)
      ? result.results
          .filter((r) => r && (r.label || r.type))
          .map((r) => `- ${r.ok ? "✓" : "✗"} ${String(r.label || r.type).slice(0, 120)}`)
      : [];
    const title = String(intent || "Browser task").trim().slice(0, 120) || "Browser task";
    const content = [
      `# ${title}`,
      "",
      summary ? String(summary).trim() : "",
      steps.length ? ["", "## Steps", "", ...steps].join("\n") : "",
      pageUrl ? ["", "## Page", "", pageUrl].join("\n") : "",
      "",
      `Completed: ${new Date().toLocaleString()}`,
    ]
      .filter((line) => line !== "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const saved = await window.lyknOverlay.saveVaultNote({
      title: title.slice(0, 120),
      content,
      tags: ["lykn-overlay", "browser-task"],
      folder: "Tasks",
      source: "browser_task",
    });
    if (saved?.ok) {
      updateAnswer(`${summary}\n\n_Saved a summary to your vault._`);
    }
  } catch (_) {
    /* vault save is best-effort */
  }
}

function looksLikeWatchRule(text) {
  const t = String(text || "").trim();
  return (
    /^(tell me|let me know|notify me|alert me|warn me|ping me)\s+when\s+/i.test(t) ||
    /^watch\s+(for|out for)\s+/i.test(t) ||
    /^(alert|notify)\s+(me\s+)?when\s+/i.test(t) ||
    /^let me know if\s+/i.test(t)
  );
}

function looksLikeClearWatchRules(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    /\b(clear|stop|cancel|remove|delete)\b.*\b(watch rules?|alerts?|notifications?)\b/.test(t) ||
    /^stop watching for\b/.test(t) ||
    /^clear watch\b/.test(t)
  );
}

async function registerWatchRule(q) {
  setBusy(true);
  startTurn(q);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  try {
    const res = await window.lyknOverlay.addLiveWatchRule(q);
    if (!res?.ok) {
      const msg =
        res?.error === "watch_off"
          ? "Turn on **Live screen watch** first (menu), then set alerts."
          : "Couldn't add that watch rule. Try rephrasing.";
      updateAnswer(msg);
      history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
      setBusy(false);
      askEl.focus();
      return;
    }
    const rule = res.rule || q;
    if (Array.isArray(res.rules)) watchActiveRules = res.rules.slice();
    const msg = `Got it. I'll alert you when **${rule}**.`;
    updateAnswer(msg);
    history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
    appendWatchCommentary(`Alert set: ${rule}`, { system: true });
    void persistCurrentSession();
  } catch (_) {
    updateAnswer("Couldn't set that watch alert.");
    history.push({
      role: "assistant",
      content: "Couldn't set that watch alert.",
      at: new Date().toISOString(),
    });
  }
  setBusy(false);
  askEl.focus();
}

async function clearWatchRules(q) {
  setBusy(true);
  startTurn(q || "Clear watch alerts");
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  try {
    await window.lyknOverlay.clearLiveWatchRules();
    watchActiveRules = [];
    const msg = "Cleared all watch alerts.";
    updateAnswer(msg);
    history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
    appendWatchCommentary("All watch alerts cleared.", { system: true });
    void persistCurrentSession();
  } catch (_) {
    updateAnswer("Couldn't clear watch alerts.");
  }
  setBusy(false);
  askEl.focus();
}

function ask() {
  const qRaw = askEl.value.trim();
  if (browserActArmed) {
    if (!qRaw || busy || executingBrowser) return;
    void runBrowserAct(qRaw);
    return;
  }
  // Agent Mode: per-agent streams (parallel) — never share lykn:ask abort.
  if (agentModeArmed) {
    if (!qRaw && attachments.length === 0) return;
    if (busy) return;
    void askAgent(qRaw);
    return;
  }
  if (busy) return;
  // Image mode armed (menu → "Create an image"): this send is an image
  // prompt — skip the watch/save/voice shortcut heuristics and route it to
  // the streamed chat with forceImage so the server forces GPT Image 2.
  // Attachment-only sends count too ("remix this picture" with no caption).
  const imageAsk = imageGenArmed && (!!qRaw || attachments.length > 0);
  // Build mode armed (menu → "Build mode"): this send is a build brief —
  // route it straight to the streamed chat with buildMode so the server
  // forces the React artifact builder (Claude-style coded artifact).
  const buildAsk = !imageAsk && buildModeArmed && (!!qRaw || attachments.length > 0);
  const researchAsk = !imageAsk && !buildAsk && researchModeArmed && !!qRaw;
  // Translate mode: empty send = translate what's on screen into the target lang.
  const translateAsk = !imageAsk && !buildAsk && !researchAsk && translateModeArmed;
  if (!qRaw && attachments.length === 0 && !translateAsk) return;
  const q =
    qRaw ||
    (translateAsk && attachments.length === 0
      ? `Translate what's on my screen into ${getTranslateTargetLang()}`
      : "");
  // Modes are STICKY — they stay armed across sends (follow-up edits are the
  // normal flow: "same but darker", "now add a header…"). The user leaves a
  // mode via the composer pill's ✕, the menu toggle, or a new chat.
  if (!imageAsk && !buildAsk && !researchAsk && !translateAsk) {
    // Live watch alerts — "tell me when an enemy is near", "watch for stock drop", etc.
    if (q && attachments.length === 0 && looksLikeClearWatchRules(q)) {
      askEl.value = "";
      askEl.style.height = "52px";
      void clearWatchRules(q);
      return;
    }
    if (q && attachments.length === 0 && looksLikeWatchRule(q)) {
      askEl.value = "";
      askEl.style.height = "52px";
      void registerWatchRule(q);
      return;
    }
    // Voice mode: route typed prompts/links into the LIVE voice session instead
    // of the streamed chat, so the user can talk to the voice agent by text too
    // (paste a link for it to fetch/save, type a question while muted, etc.).
    if (voiceActive || voiceStarting) {
      if (sendTextToVoice(q, attachments.slice())) {
        askEl.value = "";
        askEl.style.height = "52px";
        clearAttachments();
      }
      return;
    }
  }
  askEl.value = "";
  askEl.style.height = "52px";
  setBusy(true);
  const sentAttachments = attachments.slice();
  // Clear chips before startTurn so the forced shrink after collapse doesn't
  // leave attachment-row height as empty space above the bar.
  attachments.length = 0;
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.remove("show");
  const label =
    q || (sentAttachments.length ? `Sent ${sentAttachments.length} attachment(s)` : "");
  startTurn(label);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  const askOpts = {
    ...(imageAsk ? { forceImage: true } : {}),
    ...(buildAsk ? { buildMode: true } : {}),
    ...(researchAsk ? { deepResearch: true } : {}),
    ...(translateAsk
      ? { translateMode: true, translateTargetLang: getTranslateTargetLang() }
      : {}),
    ...(scopedProject?.id
      ? { scopedProjectId: scopedProject.id, scopedProjectName: scopedProject.name }
      : {}),
  };
  window.lyknOverlay.ask(
    q,
    history,
    sentAttachments,
    Object.keys(askOpts).length ? askOpts : undefined,
  );
}

async function ensureActiveAgentId(goal) {
  try {
    const list = await window.lyknOverlay.agentList();
    const agents = Array.isArray(list?.agents) ? list.agents : [];
    const ids = new Set(agents.map((a) => a.id));
    if (activeAgentId && ids.has(activeAgentId)) return activeAgentId;
    if (list?.activeAgentId && ids.has(list.activeAgentId)) {
      activeAgentId = list.activeAgentId;
      return activeAgentId;
    }
    if (agents[0]?.id) {
      activeAgentId = agents[0].id;
      return activeAgentId;
    }
  } catch (_) {}
  try {
    const created = await window.lyknOverlay.agentCreate({ goal: goal || "New agent" });
    if (created?.agentId) {
      activeAgentId = created.agentId;
      return activeAgentId;
    }
  } catch (_) {}
  return null;
}

async function askAgent(qRaw) {
  const q = String(qRaw || "").trim();
  const sentAttachments = attachments.slice();
  askEl.value = "";
  askEl.style.height = "52px";
  attachments.length = 0;
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.remove("show");
  setBusy(true);
  const label = q || (sentAttachments.length ? `Sent ${sentAttachments.length} attachment(s)` : "");
  startTurn(label);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  // Pin the agent id for this send — user may switch agents while we await.
  let sendAgentId = null;
  try {
    sendAgentId = await ensureActiveAgentId(q);
    let res = await window.lyknOverlay.agentSend(sendAgentId, q, sentAttachments);
    // Stale id after restart/close — recreate once and retry.
    if (!res?.ok && res?.error === "not_found") {
      activeAgentId = null;
      sendAgentId = await ensureActiveAgentId(q);
      res = await window.lyknOverlay.agentSend(sendAgentId, q, sentAttachments);
    }
    if (res?.agentId) sendAgentId = res.agentId;
    if (res?.ok && res?.spawned && res?.agentId) {
      // Main spawned a worker and switched Glass to it — stream handlers take over.
      activeAgentId = res.agentId;
      setBusy(true);
      reportHeight();
      return;
    }
    // Background finish must not clobber whichever agent is now active in Glass.
    if (activeAgentId && sendAgentId && activeAgentId !== sendAgentId) {
      // Still clear THIS send's composer busy if we left the spinner armed locally.
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      return;
    }
    if (res?.agentId) activeAgentId = res.agentId;
    if (!res?.ok && res?.error && res.error !== "superseded") {
      updateAnswer(res.error === "not_found" ? "No agent available — try Agent mode again." : res.error);
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
    } else if (res?.ok && res?.skill === "delegate" && res?.text) {
      // Main kickoff report — always surface even if stream events raced.
      updateAnswer(res.text);
      const last = history[history.length - 1];
      if (!(last && last.role === "assistant" && last.content === res.text)) {
        history.push({
          role: "assistant",
          content: res.text,
          at: new Date().toISOString(),
        });
      }
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      reportHeight();
      askEl.focus();
    } else if (res?.ok) {
      // Invoke returns after the run finishes; clear spinner even if agent-done
      // IPC is delayed or was filtered (agent switch / race).
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      if (res.text && !currentHasText) updateAnswer(res.text);
      if (res.waitingChoice && res.choice?.buttons?.length) {
        showAgentChoiceButtons({
          ...res.choice,
          agentId: res.agentId || sendAgentId || activeAgentId,
        });
      }
      reportHeight();
      askEl.focus();
    }
    // Stream handlers (onAgentDelta/Done) also finish the turn for the active agent.
  } catch (e) {
    if (activeAgentId && sendAgentId && activeAgentId !== sendAgentId) {
      answerStillWorking = false;
      clearBuildingUnder();
      setBusy(false);
      return;
    }
    updateAnswer(e?.message || "Agent failed.");
    answerStillWorking = false;
    clearBuildingUnder();
    setBusy(false);
  }
}

// Accordion: clicking a turn's header opens it and collapses every other turn,
// keeping only one answer visible at a time. Clicking the open one closes it.
threadEl.addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".chat-copy");
  if (copyBtn) {
    e.preventDefault();
    e.stopPropagation();
    void copyAnswerText(copyBtn);
    return;
  }
  // "Code" toggle on Build-mode artifact cards: swap the live preview for the
  // raw JSX the AI wrote (fetched once from the runner HTML's embedded source
  // block via main, then cached on the card). Copy button sits above it.
  const codeCopyBtn = e.target.closest(".md-code-copy");
  if (codeCopyBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (codeCopyBtn.disabled) return;
    const codeEl = codeCopyBtn.closest(".md-artifact-code");
    const card = codeCopyBtn.closest(".md-artifact");
    const pre = codeEl?.querySelector("pre");
    const url =
      codeCopyBtn.getAttribute("data-url") ||
      card?.querySelector(".md-code")?.getAttribute("data-url") ||
      "";
    const markCopied = () => {
      codeCopyBtn.classList.add("copied");
      codeCopyBtn.innerHTML =
        `<span style="display:inline-flex;align-items:center;gap:4px">` +
        `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>` +
        `Copied</span>`;
      clearTimeout(codeCopyBtn._copiedTimer);
      codeCopyBtn._copiedTimer = setTimeout(() => {
        codeCopyBtn.classList.remove("copied");
        codeCopyBtn.textContent = "Copy";
      }, 1800);
    };
    void (async () => {
      let text = (pre && pre.textContent) || "";
      if (!text.trim() && url && window.lyknOverlay?.artifactCode) {
        codeCopyBtn.disabled = true;
        codeCopyBtn.textContent = "…";
        try {
          const res = await window.lyknOverlay.artifactCode(url);
          if (res && res.ok && res.code) {
            text = res.code;
            if (pre) pre.textContent = text;
          }
        } catch (_) {}
        codeCopyBtn.disabled = false;
        codeCopyBtn.textContent = "Copy";
      }
      if (!text.trim()) return;
      try {
        const ok = window.lyknOverlay?.copyText?.(text);
        if (ok === false) throw new Error("copy_failed");
        markCopied();
      } catch (_) {
        try {
          await navigator.clipboard.writeText(text);
          markCopied();
        } catch (_) {
          codeCopyBtn.textContent = "Failed";
          setTimeout(() => { codeCopyBtn.textContent = "Copy"; }, 1400);
        }
      }
    })();
    return;
  }
  const codeBtn = e.target.closest(".md-code");
  if (codeBtn) {
    e.preventDefault();
    const card = codeBtn.closest(".md-artifact");
    const frame = card?.querySelector("iframe");
    const codeEl = card?.querySelector(".md-artifact-code");
    if (!card || !frame || !codeEl) return;
    const showingCode = !codeEl.hidden;
    if (showingCode) {
      codeEl.hidden = true;
      frame.style.display = "";
      codeBtn.textContent = "Code";
      reportHeight();
      return;
    }
    const pre = codeEl.querySelector("pre");
    const reveal = () => {
      frame.style.display = "none";
      codeEl.hidden = false;
      codeBtn.textContent = "Preview";
      reportHeight();
    };
    if (pre.textContent) {
      reveal();
      return;
    }
    codeBtn.disabled = true;
    codeBtn.textContent = "Loading…";
    void (async () => {
      let res = null;
      try {
        res = await window.lyknOverlay.artifactCode(codeBtn.getAttribute("data-url") || "");
      } catch (_) {}
      codeBtn.disabled = false;
      if (res && res.ok && res.code) {
        pre.textContent = res.code;
        reveal();
      } else {
        codeBtn.textContent = "Code";
        pre.textContent = "";
      }
    })();
    return;
  }
  // Vault pull-up card: open the item in the main app.
  const vaultCard = e.target.closest(".md-vault");
  if (vaultCard) {
    e.preventDefault();
    e.stopPropagation();
    const noteId = vaultCard.getAttribute("data-note-id") || "";
    try {
      window.lyknOverlay.openVault?.(noteId);
    } catch (_) {}
    return;
  }
  const stepEl = e.target.closest(".md-step");
  if (stepEl) {
    const stepStatus = stepEl.getAttribute("data-status") || "done";
    if (stepStatus === "pending") return;
    const stepAgentId = stepEl.getAttribute("data-agent-id") || activeAgentId || "";
    const stepIndex = stepEl.getAttribute("data-step-index");
    if (stepIndex == null || stepIndex === "") return;
    const openBtn = e.target.closest(".md-step-open");
    // A step that can explain itself expands on click; going to the browser is
    // the button inside it. Otherwise clicking the row still jumps to the page.
    if (stepEl.getAttribute("data-expandable") === "1" && !openBtn) {
      // The native toggle happens after this handler, so `open` is still the
      // state we're leaving.
      const stepKey = `${stepAgentId}/${stepIndex}`;
      if (stepEl.open) expandedAgentSteps.delete(stepKey);
      else expandedAgentSteps.add(stepKey);
      // Growing the box mid-thread changes how much room the overlay needs.
      setTimeout(reportHeight, 0);
      return;
    }
    if (openBtn) {
      e.preventDefault();
      e.stopPropagation();
    }
    void window.lyknOverlay.agentShowStep?.(stepAgentId, Number(stepIndex));
    return;
  }
  // Edit on a vault/generated artifact → Build mode (source already seeded
  // in main when the artifact was built or loaded via loadNeuron).
  const editBuildBtn = e.target.closest(".md-edit-build");
  if (editBuildBtn) {
    e.preventDefault();
    e.stopPropagation();
    const url = editBuildBtn.getAttribute("data-url") || "";
    const title = editBuildBtn.getAttribute("data-title") || "Artifact";
    editBuildBtn.disabled = true;
    const orig = editBuildBtn.textContent;
    editBuildBtn.textContent = "…";
    void (async () => {
      try {
        if (url && window.lyknOverlay?.seedArtifactFromUrl) {
          await window.lyknOverlay.seedArtifactFromUrl(url, title);
        }
      } catch (_) {}
      setComposerMode("build");
      askEl.focus();
      editBuildBtn.textContent = orig;
      editBuildBtn.disabled = false;
      reportHeight();
    })();
    return;
  }
  // Edit on an image → Image mode with that image attached as the reference.
  const editImgBtn = e.target.closest(".md-edit-image");
  if (editImgBtn) {
    e.preventDefault();
    e.stopPropagation();
    const url = editImgBtn.getAttribute("data-url") || "";
    const title = editImgBtn.getAttribute("data-title") || "Image";
    if (!url) return;
    editImgBtn.disabled = true;
    const orig = editImgBtn.textContent;
    editImgBtn.textContent = "…";
    void (async () => {
      let dataUrl = "";
      try {
        const res = await window.lyknOverlay.fetchAsDataUrl?.(url);
        if (res && res.ok && res.dataUrl) dataUrl = res.dataUrl;
      } catch (_) {}
      if (dataUrl) {
        clearAttachments();
        addAttachmentObjects([
          {
            kind: "image",
            name: `${String(title).replace(/[^\w.-]+/g, "-").slice(0, 40) || "image"}.png`,
            dataUrl,
          },
        ]);
      }
      setComposerMode("image");
      askEl.focus();
      editImgBtn.textContent = orig;
      editImgBtn.disabled = false;
      reportHeight();
    })();
    return;
  }
  // Download buttons on generated images / Build-mode artifacts: save the
  // file into ~/Downloads via the main process (revealed in Finder) AND into
  // the user's Vault as a rich card.
  const dlBtn = e.target.closest(".md-dl");
  if (dlBtn) {
    e.preventDefault();
    if (dlBtn.disabled) return;
    const url = dlBtn.getAttribute("data-url") || "";
    const name = dlBtn.getAttribute("data-name") || "";
    const title = dlBtn.getAttribute("data-title") || "";
    const origLabel = dlBtn.textContent;
    dlBtn.disabled = true;
    dlBtn.textContent = "Saving…";
    void (async () => {
      let ok = false;
      let vaulted = false;
      try {
        const res = await window.lyknOverlay.downloadFile(url, name, title);
        ok = !!(res && res.ok);
        vaulted = !!(res && res.savedToVault);
      } catch (_) {
        ok = false;
      }
      dlBtn.textContent = ok ? (vaulted ? "Saved + Vault ✓" : "Saved ✓") : "Failed";
      setTimeout(() => {
        dlBtn.textContent = origLabel;
        dlBtn.disabled = false;
      }, 2200);
    })();
    return;
  }
  // Markdown links / sources / artifacts: always a new LYKN agent browser tab.
  const link = e.target.closest("a[href]");
  if (link) {
    e.preventDefault();
    const href = link.getAttribute("href");
    const label =
      (link.getAttribute("title") || link.textContent || "").trim().slice(0, 48) ||
      undefined;
    window.lyknOverlay.openUrl(href, label);
    return;
  }
  // Generated images open full-size in the LYKN browser.
  const genImg = e.target.closest(".md-img img");
  if (genImg && genImg.src) {
    e.preventDefault();
    window.lyknOverlay.openUrl(genImg.src);
    return;
  }
  const header = e.target.closest(".chat-q");
  if (!header) return;
  // Don't collapse/expand when the user just drag-highlighted the prompt.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && String(sel.toString() || "").trim()) return;
  const item = header.closest(".chat");
  if (!item) return;
  const willOpen = item.classList.contains("collapsed");
  threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));
  if (willOpen) item.classList.remove("collapsed");
  reportHeight();
});

threadEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const header = e.target.closest?.(".chat-q");
  if (!header || e.target !== header) return;
  e.preventDefault();
  header.click();
});

let streamingText = "";
window.lyknOverlay.onStatus((p) => {
  if (agentModeArmed) return;
  setThinkingStatus((p && p.status) || "Thinking…");
});
window.lyknOverlay.onSources((p) => {
  const list = Array.isArray(p?.sources) ? p.sources : [];
  researchSources = list.filter((s) => s && s.url).slice(0, 40);
  if (!researchSources.length) return;
  // New research results replace the Sources list for this turn.
  sideContext = {
    pageSource:
      (currentPageSource && currentPageSource.url && currentPageSource) ||
      (sideContext && sideContext.pageSource) ||
      null,
    links: mergeSourceLinks(researchSources, []),
    followups: (sideContext && sideContext.followups) || [],
  };
  syncSidePickerState();
  if (sidePanelView === "sources" || sidePanelView === "all") renderSidePanel();
});
window.lyknOverlay.onDelta((p) => {
  if (agentModeArmed) return;
  streamingText = p && p.text ? p.text : streamingText;
  updateAnswer(streamingText);
});
window.lyknOverlay.onDone((p) => {
  if (agentModeArmed) return;
  answerStillWorking = false;
  const finalText = (p && p.text) || streamingText;
  if (finalText) {
    updateAnswer(finalText);
    clearBuildingUnder();
    history.push({ role: "assistant", content: finalText, at: new Date().toISOString() });
    void persistCurrentSession();
    // Populate the left panel with sources, follow-ups, and options.
    void requestSuggestions(currentQuestion, finalText);
  } else if (!currentHasText && currentAnswerEl) {
    // Nothing came back — clear the spinner instead of leaving it spinning.
    currentHasText = true;
    updateAnswer("No response.");
  } else {
    clearBuildingUnder();
  }
  streamingText = "";
  setBusy(false);
  reportHeight();
  askEl.focus();
});
window.lyknOverlay.onError((p) => {
  if (agentModeArmed) return;
  answerStillWorking = false;
  updateAnswer((p && p.message) || "Something went wrong.");
  clearBuildingUnder();
  streamingText = "";
  setBusy(false);
  reportHeight();
});

// Agent Mode streams — scoped by agentId; only the active agent paints Glass.
window.lyknOverlay.onAgentSwitched((p) => {
  activeAgentId = p?.agentId || null;
  if (!agentModeArmed) return;
  const meta = {
    ...(p?.agent || {}),
    busy: p?.busy != null ? p.busy : p?.agent?.busy,
    partialText: p?.partialText != null ? p.partialText : p?.agent?.partialText,
    step: p?.step || p?.agent?.step,
    status: p?.agent?.status,
  };
  applyAgentTranscript(p?.history || [], meta);
  askEl.focus();
});
window.lyknOverlay.onAgentStatus((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  // Late status after the turn finished must not reopen a thinking spinner.
  if (!answerStillWorking && !busy) return;
  // Ensure an in-flight turn exists (e.g. switched back before first status).
  if (!currentAnswerEl && p?.agentId === activeAgentId) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Working…");
    setBusy(true);
  }
  setThinkingStatus((p && p.status) || "Working…");
});
window.lyknOverlay.onAgentDelta((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  if (!currentAnswerEl) {
    // Don't invent a new turn from a stray delta after the run already finished.
    if (!answerStillWorking && !busy) return;
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Working…");
    setBusy(true);
  }
  const status = String(p?.status || "").trim();
  const text = String(p?.text || "").trim();
  // Always paint the body when we have real text — working-through narrative,
  // streamed wrap-up, or final summary. Status/writing only drive the spinner.
  if (text) {
    agentStreamingText = text;
    updateAnswer(text);
    // Final when marked, or when the transcript is only finished step boxes.
    const looksFinal =
      !!p?.final ||
      (/!\[[^\]]*\]\(lykn-agent-step:/i.test(text) &&
        !/lykn-agent-step:\/\/[^)\s]+\/(?:live|pending)\b/i.test(text));
    const hasLiveStep = /lykn-agent-step:\/\/[^)\s]+\/live\b/i.test(text);
    if (looksFinal) {
      answerStillWorking = false;
      clearBuildingUnder();
    } else if (hasLiveStep) {
      // Spinner lives in the current step box — don't stack a second one.
      clearBuildingUnder();
    } else if (answerStillWorking && (p?.writing || status)) {
      const n = Number(p.chars) || text.length;
      const under =
        status ||
        (p?.writing
          ? n > 0
            ? `Writing output… (${n.toLocaleString()} chars)`
            : "Writing output…"
          : lastThinkingStatus || "Working…");
      ensureBuildingUnder(under);
    } else if (answerStillWorking) {
      // Text is on screen and nothing is still writing/working — don't
      // leave the thinking animation looping under a finished reply.
      clearBuildingUnder();
    }
    return;
  }
  if (status) {
    setThinkingStatus(status);
    return;
  }
  if (p?.writing) {
    const n = Number(p.chars) || 0;
    setThinkingStatus(n > 0 ? `Writing output… (${n.toLocaleString()} chars)` : "Writing output…");
  }
});
window.lyknOverlay.onAgentSources((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  const list = Array.isArray(p?.sources) ? p.sources : [];
  researchSources = list.filter((s) => s && s.url).slice(0, 40);
  if (!researchSources.length) return;
  sideContext = {
    pageSource: (sideContext && sideContext.pageSource) || null,
    links: mergeSourceLinks(researchSources, []),
    followups: (sideContext && sideContext.followups) || [],
  };
  syncSidePickerState();
  if (sidePanelView === "sources" || sidePanelView === "all") renderSidePanel();
});
window.lyknOverlay.onAgentWaiting?.((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  setAgentWaiting(p);
});
window.lyknOverlay.onAgentDone((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  answerStillWorking = false;
  const finalText = (p && p.text) || agentStreamingText;
  if (!currentAnswerEl && finalText) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Done");
  }
  if (finalText) {
    updateAnswer(finalText);
    clearBuildingUnder();
    // History is owned by main agent registry; keep local transcript in sync.
    const last = history[history.length - 1];
    if (!(last && last.role === "assistant" && last.content === finalText)) {
      history.push({ role: "assistant", content: finalText, at: new Date().toISOString() });
    }
    if (p?.choice?.buttons?.length) {
      showAgentChoiceButtons({ ...p.choice, agentId: p.agentId || activeAgentId });
    } else if (!p?.monitoring) {
      // Prefer runtime tips for this finished turn; LLM upgrades below.
      const runtimeTips = Array.isArray(p?.suggestions)
        ? p.suggestions
            .map((s) => (typeof s === "string" ? s : s?.prompt || s?.label || ""))
            .map((s) => String(s || "").trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];
      if (runtimeTips.length) {
        sideContext = {
          ...(sideContext || {}),
          pageSource: (sideContext && sideContext.pageSource) || null,
          links: (sideContext && sideContext.links) || [],
          followups: runtimeTips,
        };
        syncSidePickerState();
        if (sidePanelView && sidePanelView !== "watch") renderSidePanel();
      }
      void requestSuggestions(currentQuestion, finalText);
    }
  } else if (!currentHasText && currentAnswerEl && !p?.stopped) {
    currentHasText = true;
    updateAnswer("No response.");
  } else {
    clearBuildingUnder();
  }
  agentStreamingText = "";
  setBusy(false);
  // Parked runs finish the turn but keep watching — keep the pulse on screen.
  // The done payload says so too, which covers a pause that never sent a
  // separate waiting event: without this the spinner just stops and a run
  // that is still waiting on the user reads as finished.
  if (!pendingAgentWaiting && (p?.waitingSignIn || p?.waitingChoice)) {
    setAgentWaiting({
      waiting: true,
      kind: p.waitingChoice ? "choice" : "signin",
      label: p.waitingChoice ? "Waiting for your choice" : "",
    });
  } else if (pendingAgentWaiting) renderAgentWaitingRow();
  reportHeight();
  askEl.focus();
});
window.lyknOverlay.onAgentChoice((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  if (!p?.buttons?.length) return;
  if (!currentAnswerEl && p?.message) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Choice");
    updateAnswer(p.message);
  }
  showAgentChoiceButtons(p);
  answerStillWorking = false;
  clearBuildingUnder();
  setBusy(false);
  reportHeight();
});
window.lyknOverlay.onAgentError((p) => {
  if (!agentModeArmed || (p?.agentId && p.agentId !== activeAgentId)) return;
  answerStillWorking = false;
  if (!currentAnswerEl) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    startTurn(lastUser?.content || "Error");
  }
  updateAnswer((p && p.message) || "Agent error.");
  clearBuildingUnder();
  agentStreamingText = "";
  setBusy(false);
  reportHeight();
});
// LYKN scraped the page the user is viewing — remember it so requestSuggestions
// can show it as a source (visible proof the scrape happened).
window.lyknOverlay.onPageSource((p) => {
  if (p && p.url) currentPageSource = { url: p.url, title: p.title || "" };
});

const nightBriefEl = document.getElementById("night-brief");
const nightBriefProjectEl = document.getElementById("night-brief-project");
const nightBriefBodyEl = document.getElementById("night-brief-body");
const nightBriefCloseEl = document.getElementById("night-brief-close");
const NIGHT_BRIEF_DISMISS_KEY = "lykn_night_brief_dismissed";

function nightBriefDismissToken(briefs) {
  if (!Array.isArray(briefs) || !briefs.length) return "";
  return briefs
    .map((b) => `${b.id || ""}:${b.setAt || ""}`)
    .sort()
    .join("|");
}

function hideNightBriefBanner() {
  if (!nightBriefEl) return;
  nightBriefEl.classList.remove("show");
  nightBriefEl.hidden = true;
}

function showNightBriefBanner(briefs) {
  if (!nightBriefEl || !nightBriefBodyEl || !nightBriefProjectEl) return;
  const token = nightBriefDismissToken(briefs);
  if (!token) {
    hideNightBriefBanner();
    return;
  }
  try {
    if (localStorage.getItem(NIGHT_BRIEF_DISMISS_KEY) === token) {
      hideNightBriefBanner();
      return;
    }
  } catch (_) {}

  const primary = briefs[0];
  const extra = briefs.length > 1 ? ` (+${briefs.length - 1} more project${briefs.length > 2 ? "s" : ""})` : "";
  nightBriefProjectEl.textContent = `${primary.projectName || "Project"}${extra}`;
  nightBriefBodyEl.innerHTML = renderMarkdown(String(primary.value || ""));
  nightBriefEl.hidden = false;
  nightBriefEl.classList.add("show");
  nightBriefEl.dataset.dismissToken = token;
}

async function refreshNightBriefBanner() {
  if (!window.lyknOverlay?.getNightBriefs) return;
  try {
    const data = await window.lyknOverlay.getNightBriefs();
    if (data?.ok && data.briefs?.length) showNightBriefBanner(data.briefs);
    else hideNightBriefBanner();
  } catch (_) {
    hideNightBriefBanner();
  }
}

if (nightBriefCloseEl) {
  nightBriefCloseEl.addEventListener("click", () => {
    const token = nightBriefEl?.dataset?.dismissToken || "";
    if (token) {
      try {
        localStorage.setItem(NIGHT_BRIEF_DISMISS_KEY, token);
      } catch (_) {}
    }
    hideNightBriefBanner();
  });
}

window.lyknOverlay.onShown(() => {
  // Remeasure after show — a stale height leaves the composer buttons clipped.
  lastReportedHeight = -1;
  lastReportedWidth = -1;
  reportHeight();
  setTimeout(() => {
    lastReportedHeight = -1;
    reportHeight();
    askEl.focus();
  }, 40);
  setTimeout(() => {
    lastReportedHeight = -1;
    reportHeight();
  }, 220);
  void refreshNightBriefBanner();
});

// Clicking back into the bar after Cursor/another app often leaves the macOS
// panel non-key — caret looks focused but keys go nowhere. Re-key via main.
function ensureComposerKeyboard() {
  try {
    window.lyknOverlay.focusComposer?.();
  } catch (_) {}
  try {
    askEl.focus({ preventScroll: true });
  } catch (_) {
    askEl.focus();
  }
}
if (typeof window.lyknOverlay.onFocusComposer === "function") {
  window.lyknOverlay.onFocusComposer(() => {
    try {
      askEl.focus({ preventScroll: true });
    } catch (_) {
      askEl.focus();
    }
  });
}
askEl.addEventListener("pointerdown", () => {
  ensureComposerKeyboard();
});
window.addEventListener("focus", () => {
  // Returning to the overlay window — restore caret without fighting menus.
  if (document.activeElement === askEl || !document.activeElement || document.activeElement === document.body) {
    setTimeout(() => {
      try {
        askEl.focus({ preventScroll: true });
      } catch (_) {
        askEl.focus();
      }
    }, 0);
  }
});

// Drag the panel via the titlebar handle (or the collapsed bubble). Electron
// panel windows sometimes drop pointerup while setBounds is racing the cursor
// — without a buttons check / lostpointercapture handler the bar stays glued
// to the mouse and every move floods IPC (which stalls the cursor badly).
// True while any overlay drag handle is mid-gesture (Esc cancels drag first).
let overlayDragActive = false;
const overlayDragEnders = new Set();

function bindOverlayDrag(el, { ignoreTarget, onClick, dragClass } = {}) {
  if (!el) return;
  let dragging = false;
  let moved = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  let raf = 0;

  const flush = () => {
    raf = 0;
    if (!pendingDx && !pendingDy) return;
    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;
    window.lyknOverlay.moveBy(dx, dy);
  };

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    overlayDragActive = false;
    const id = e && e.pointerId != null ? e.pointerId : pointerId;
    pointerId = null;
    if (dragClass) el.classList.remove(dragClass);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (pendingDx || pendingDy) flush();
    try {
      if (id != null) el.releasePointerCapture(id);
    } catch (_) {
      /* already released */
    }
    try {
      window.lyknOverlay.moveEnd();
    } catch (_) {
      /* older preload */
    }
    if (onClick && !moved) onClick();
    moved = false;
  };

  overlayDragEnders.add(end);

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (ignoreTarget && ignoreTarget(e.target)) return;
    dragging = true;
    overlayDragActive = true;
    moved = false;
    pointerId = e.pointerId;
    lastX = e.screenX;
    lastY = e.screenY;
    pendingDx = 0;
    pendingDy = 0;
    if (dragClass) el.classList.add(dragClass);
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {
      /* capture optional */
    }
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // Primary button no longer down — pointerup was lost (common on macOS
    // panel windows while the HWND is being moved under the cursor).
    if ((e.buttons & 1) === 0) {
      end(e);
      return;
    }
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (!dx && !dy) return;
    // Ignore tiny jitter so a click doesn't start a "drag".
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    lastX = e.screenX;
    lastY = e.screenY;
    pendingDx += dx;
    pendingDy += dy;
    if (!raf) raf = requestAnimationFrame(flush);
  });

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
  window.addEventListener("blur", () => end());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) end();
  });
}

const dragEl = document.getElementById("drag");
bindOverlayDrag(dragEl, {
  dragClass: "dragging",
  ignoreTarget: (t) =>
    !!(t && t.closest && t.closest(".bar-btn, .side-picker-btn, .mode-badge")),
});

// ── Collapse to a single LYKN icon bubble ──────────────────────────────────
const bubbleEl = document.getElementById("bubble");

function collapseOverlay() {
  setMenuOpen(false);
  setPanelPickerOpen(false);
  document.body.classList.add("collapsed");
  window.lyknOverlay.collapse(true);
}

function expandOverlay() {
  document.body.classList.remove("collapsed");
  window.lyknOverlay.collapse(false);
  // Force a fresh size report now that the panel is visible again.
  lastReportedHeight = -1;
  lastReportedWidth = -1;
  reportHeight();
  askEl.focus();
}

// Click the glowing LYKN mark in the bar to collapse everything.
dotEl.addEventListener("click", collapseOverlay);

// Bubble: drag to reposition, or click (no drag) to expand.
bindOverlayDrag(bubbleEl, { onClick: expandOverlay });

// ── Dictation ────────────────────────────────────────────────────────────
// Record mic audio with MediaRecorder, then hand the bytes to the main process
// to transcribe (whisper) and append the text to the input — same flow as the
// app's chat-bar mic button.
const micEl = document.getElementById("mic");
let recorder = null;
let mediaStream = null;
let audioChunks = [];
let recording = false;
let transcribing = false;
const RECORD_MIME = (() => {
  try {
    return MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
  } catch (_) {
    return "audio/webm";
  }
})();
function setMicState() {
  micEl.classList.toggle("recording", recording);
  micEl.classList.toggle("transcribing", transcribing);
  // Voice mode owns the mic button (stop control) — don't overwrite its title
  // or the composer placeholder while a session is live / connecting.
  if (voiceActive || voiceStarting) {
    micEl.disabled = false;
    micEl.title = "Stop voice mode";
    micEl.setAttribute("aria-label", "Stop voice mode");
    return;
  }
  micEl.disabled = transcribing;
  micEl.title = recording ? "Stop recording" : transcribing ? "Transcribing…" : "Dictate";
  micEl.setAttribute("aria-label", micEl.title);
  askEl.placeholder = recording
    ? "Listening… click the mic to stop"
    : transcribing
      ? "Transcribing…"
      : COMPOSER_MODES[composerMode].placeholder;
}

async function startDictation() {
  if (recording || transcribing || busy) return;
  const ok = await window.lyknOverlay.ensureMic();
  if (!ok) {
    startTurn("Dictation");
    updateAnswer(
      "LYKN needs Microphone access. Enable it in System Settings → Privacy & Security → Microphone, then try again.",
    );
    reportHeight();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    return;
  }
  mediaStream = stream;
  audioChunks = [];
  recorder = new MediaRecorder(stream, { mimeType: RECORD_MIME });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  recorder.onstop = async () => {
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    mediaStream = null;
    recorder = null;
    recording = false;
    const blob = new Blob(audioChunks, { type: RECORD_MIME });
    audioChunks = [];
    if (blob.size < 2000) { setMicState(); return; }
    transcribing = true;
    setMicState();
    try {
      const buf = await blob.arrayBuffer();
      const res = await window.lyknOverlay.transcribe(buf, RECORD_MIME, askEl.value);
      const text = res && res.text ? res.text.trim() : "";
      if (text) {
        const cur = askEl.value.trim();
        askEl.value = cur ? `${cur} ${text}` : text;
        autoGrowAsk();
      }
    } catch (_) {}
    transcribing = false;
    setMicState();
    askEl.focus();
  };
  recorder.onerror = () => {
    recording = false;
    transcribing = false;
    setMicState();
  };
  recorder.start();
  recording = true;
  setMicState();
}

function stopDictation() {
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch (_) {}
}

micEl.addEventListener("click", () => {
  // During voice, the mic is a one-click stop — no need to open More.
  if (voiceActive || voiceStarting) {
    void stopVoice();
    return;
  }
  if (recording) stopDictation();
  else startDictation();
});

// ── Drag & drop attachments ────────────────────────────────────────────────
const attachmentsEl = document.getElementById("attachments");
const wrapEl = document.getElementById("wrap");
const attachments = [];
let attachSeq = 0;

const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />' +
  '<path d="M14 2v5h5" /></svg>';
const X_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.toggle("show", attachments.length > 0);
  for (const a of attachments) {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (a.kind === "image" && a.dataUrl) {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name || "image";
      chip.appendChild(img);
    } else {
      const ico = document.createElement("span");
      ico.className = "chip-ico";
      ico.innerHTML = FILE_ICON_SVG;
      chip.appendChild(ico);
    }
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = a.name || (a.kind === "image" ? "image" : "file");
    chip.appendChild(name);

    const x = document.createElement("span");
    x.className = "chip-x";
    x.title = "Remove";
    x.innerHTML = X_SVG;
    x.addEventListener("click", () => {
      const i = attachments.findIndex((it) => it.id === a.id);
      if (i >= 0) attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    attachmentsEl.appendChild(chip);
  }
  reportHeight();
}

function clearAttachments() {
  attachments.length = 0;
  renderAttachments();
}

function isTextFile(file) {
  if (file.type.startsWith("text/")) return true;
  if (["application/json", "application/xml"].includes(file.type)) return true;
  return /\.(txt|md|markdown|csv|json|xml|ya?ml|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|css|html?|sh|sql|log)$/i.test(
    file.name || "",
  );
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsText(file);
  });
}

// Push pre-built attachment objects (from the native picker) onto the list.
function addAttachmentObjects(list) {
  for (const a of list || []) {
    if (attachments.length >= 6) break;
    if (!a || (a.kind === "image" && !a.dataUrl) || (a.kind === "text" && !a.text)) continue;
    attachments.push({ id: ++attachSeq, kind: a.kind, name: a.name, dataUrl: a.dataUrl, text: a.text });
  }
  renderAttachments();
  askEl.focus();
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (attachments.length >= 6) break; // keep payloads sane
    try {
      if (file.type.startsWith("image/")) {
        const dataUrl = await readAsDataURL(file);
        attachments.push({ id: ++attachSeq, kind: "image", name: file.name, dataUrl });
      } else if (isTextFile(file)) {
        const text = await readAsText(file);
        attachments.push({ id: ++attachSeq, kind: "text", name: file.name, text });
      } else {
        // Unsupported binary — note it so the user knows it wasn't attached.
        attachments.push({
          id: ++attachSeq,
          kind: "text",
          name: file.name,
          text: `(Unsupported file type: ${file.type || "unknown"}, not included.)`,
        });
      }
    } catch (_) {
      /* skip unreadable file */
    }
  }
  renderAttachments();
  askEl.focus();
}

// ── "More" inline drawer (inside composer) ─────────────────────────────────
const composerEl = document.getElementById("composer");
const moreBtn = document.getElementById("more");
const menuEl = document.getElementById("menu");
const historyPanelEl = document.getElementById("history-panel");
const historyListEl = document.getElementById("history-list");
let historyOpen = false;
let moreUserOpen = false;

// The three-dot menu lives in its OWN little vibrancy window next to the bar
// (see menu.html / main.cjs) so the gap between it and the chat stays truly
// transparent. This just asks main to show/hide it; main echoes the actual
// visibility back via onMenuVisible so `moreUserOpen` never drifts.
// (Main hides the picker card when the menu opens, and vice versa — only one
// floating card sits next to the bar at a time.)
function setMenuOpen(open) {
  try {
    window.lyknOverlay.setMenu(!!open);
  } catch (_) {}
}

window.lyknOverlay.onMenuVisible((visible) => {
  moreUserOpen = !!visible;
  moreBtn.classList.toggle("active", moreUserOpen);
});

// Remote control from the menu window — actions run HERE because this
// renderer owns voice/listen/watch/stealth/attachment/session state. Most
// commands just click the existing (now hidden) drawer buttons.
window.__lyknMenuCmd = (name, arg) => {
  switch (name) {
    case "menu-new":
      void startNewOverlayChat();
      break;
    case "voice":
      document.getElementById("voice").click();
      break;
    case "listen":
    case "menu-transcribe": {
      const b = document.getElementById("menu-transcribe");
      if (b) b.click();
      break;
    }
    case "menu-live-watch": {
      const b = document.getElementById("menu-live-watch");
      if (b) b.click();
      break;
    }
    case "menu-image-gen": {
      // Clicks the hidden drawer button, which arms image mode — see its
      // listener below. (Never auto-sends; the user presses Send.)
      const b = document.getElementById("menu-image-gen");
      if (b) b.click();
      break;
    }
    case "menu-build": {
      const b = document.getElementById("menu-build");
      if (b) b.click();
      break;
    }
    case "menu-agent": {
      const b = document.getElementById("menu-agent");
      if (b) b.click();
      break;
    }
    case "menu-research": {
      const b = document.getElementById("menu-research");
      if (b) b.click();
      break;
    }
    case "menu-translate": {
      const b = document.getElementById("menu-translate");
      if (b) b.click();
      break;
    }
    case "menu-stealth": {
      const b = document.getElementById("menu-stealth");
      if (b) b.click();
      break;
    }
    case "menu-open":
      try {
        window.lyknOverlay.openMain();
      } catch (_) {}
      break;
    case "open-overlay-session":
      void (async () => {
        try {
          const session = await window.lyknOverlay.getOverlaySession(arg);
          if (session) await loadOverlaySession(session);
        } catch (_) {}
      })();
      break;
    case "select-project":
      void (async () => {
        // Fresh thread scoped to the chosen project (or clear → general chat).
        await startNewOverlayChat();
        if (arg && arg.id) {
          setScopedProject({ id: arg.id, name: arg.name || "Project" });
          askEl.placeholder = `Ask about ${String(arg.name || "this project").slice(0, 40)}…`;
        } else {
          setScopedProject(null);
        }
        askEl.focus();
      })();
      break;
  }
};

// Toggle-state snapshot for the menu window's badges, read off the hidden
// drawer DOM that the feature code already keeps up to date.
window.__lyknMenuState = () => {
  const voiceEl2 = document.getElementById("voice");
  const listenEl2 = document.getElementById("listen");
  const watchBtn = document.getElementById("menu-live-watch");
  const stealthBtn2 = document.getElementById("menu-stealth");
  const text = (id) => {
    const el = document.getElementById(id);
    return el ? el.textContent : "";
  };
  return {
    currentSessionId,
    voiceActive: !!(voiceEl2 && voiceEl2.classList.contains("voice-active")),
    voiceLabel: text("voice-label"),
    listening: !!(listenEl2 && listenEl2.classList.contains("listening")),
    listenLabel: text("listen-label"),
    watchOn: !!(watchBtn && watchBtn.getAttribute("aria-pressed") === "true"),
    watchState: text("live-watch-state"),
    stealthOn: !!(stealthBtn2 && stealthBtn2.getAttribute("aria-pressed") === "true"),
    stealthState: text("stealth-state"),
    imageModeOn: composerMode === "image",
    buildModeOn: composerMode === "build",
    agentModeOn: composerMode === "agent",
    researchModeOn: composerMode === "research",
    translateModeOn: composerMode === "translate",
    transcribeModeOn: composerMode === "transcribe" || listening,
    scopedProjectId: scopedProject?.id || null,
    scopedProjectName: scopedProject?.name || null,
  };
};

function setHistoryOpen(open) {
  historyOpen = open;
  historyPanelEl.classList.toggle("show", open);
  menuEl.style.display = open ? "none" : "";
  if (open && !moreUserOpen) setMenuOpen(true);
  reportHeight();
}

const HISTORY_TIME_GROUPS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 Days" },
  { key: "last30", label: "Last 30 Days" },
  { key: "older", label: "Older" },
];

function historyTime(iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function historyBucketForTime(time, now) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const dayMs = 86400000;
  if (time >= startOfTodayMs) return "today";
  if (time >= startOfTodayMs - dayMs) return "yesterday";
  if (time >= startOfTodayMs - 7 * dayMs) return "last7";
  if (time >= startOfTodayMs - 30 * dayMs) return "last30";
  return "older";
}

function groupHistoryItems(items) {
  const now = Date.now();
  const buckets = new Map(HISTORY_TIME_GROUPS.map((g) => [g.key, []]));
  for (const item of items) {
    buckets.get(historyBucketForTime(historyTime(item.updatedAt), now)).push(item);
  }
  return HISTORY_TIME_GROUPS.map((g) => ({ ...g, items: buckets.get(g.key) })).filter(
    (g) => g.items.length,
  );
}

function historyItemButton(item, active) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-item" + (active ? " active" : "");
  btn.innerHTML =
    '<span class="hi-dot" aria-hidden="true"></span>' +
    `<span class="hi-title">${escapeHtml(item.title || "New Chat")}</span>`;
  return btn;
}

async function refreshHistoryList() {
  historyListEl.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    const data = await window.lyknOverlay.listChats();
    renderHistoryList(data);
  } catch (_) {
    historyListEl.innerHTML = '<div class="history-empty">Could not load chats.</div>';
  }
}

function renderHistoryList(data) {
  historyListEl.innerHTML = "";
  const overlay = ((data && data.overlay) || []).map((item) => ({ ...item, source: "overlay" }));
  const app = ((data && data.app) || []).map((item) => ({ ...item, source: "app" }));
  const all = [...overlay, ...app].sort(
    (a, b) => historyTime(b.updatedAt) - historyTime(a.updatedAt),
  );

  if (!all.length) {
    historyListEl.innerHTML = '<div class="history-empty">No chats yet.</div>';
    if (data && data.error === "not_signed_in") {
      const sign = document.createElement("div");
      sign.className = "history-signin";
      sign.innerHTML = "Sign in to LYKN to see app chats.<br>";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "Open LYKN to sign in";
      openBtn.addEventListener("click", () => {
        setHistoryOpen(false);
        setMenuOpen(false);
        window.lyknOverlay.openMain();
      });
      sign.appendChild(openBtn);
      historyListEl.appendChild(sign);
    }
    return;
  }

  for (const group of groupHistoryItems(all)) {
    const g = document.createElement("div");
    g.className = "history-group";
    g.textContent = group.label;
    historyListEl.appendChild(g);
    for (const item of group.items) {
      const active = item.source === "overlay" && item.id === currentSessionId;
      const btn = historyItemButton(item, active);
      btn.addEventListener("click", async () => {
        if (item.source === "overlay") {
          const session = await window.lyknOverlay.getOverlaySession(item.id);
          if (session) await loadOverlaySession(session);
        } else {
          setHistoryOpen(false);
          setMenuOpen(false);
          window.lyknOverlay.openAppChat(item.id);
        }
      });
      historyListEl.appendChild(btn);
    }
  }

  if (data && data.error === "not_signed_in" && overlay.length) {
    const sign = document.createElement("div");
    sign.className = "history-signin";
    sign.textContent = "Sign in to see app chats too.";
    historyListEl.appendChild(sign);
  }
}

moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (moreUserOpen) {
    setMenuOpen(false);
  } else {
    setHistoryOpen(false);
    setMenuOpen(true);
  }
});

document.addEventListener("click", (e) => {
  if (!moreUserOpen) return;
  if (e.target.closest("#composer")) return;
  setMenuOpen(false);
});

document.getElementById("menu-new").addEventListener("click", () => {
  void startNewOverlayChat();
});

document.getElementById("new-chat").addEventListener("click", () => {
  void startNewOverlayChat();
});

document.getElementById("menu-history").addEventListener("click", () => {
  setHistoryOpen(true);
  void refreshHistoryList();
});

document.getElementById("history-back").addEventListener("click", () => {
  setHistoryOpen(false);
  menuEl.style.display = "";
});

document.getElementById("history-new").addEventListener("click", () => {
  void startNewOverlayChat();
});

async function openFilePicker() {
  try {
    const items = await window.lyknOverlay.pickFiles();
    addAttachmentObjects(items);
  } catch (_) {}
}

// Drag-select a region of the screen and attach it as an image — lets the user
// grab whatever is on screen without downloading a file (the panel window can't
// receive OS drags, so this is the "drag straight from the screen" path).
let snipping = false;
async function snipFromScreen() {
  if (snipping) return;
  snipping = true;
  try {
    const item = await window.lyknOverlay.snipScreen();
    if (item && item.dataUrl) addAttachmentObjects([item]);
  } catch (_) {
  } finally {
    snipping = false;
  }
}

// Toolbar attach button — the reliable way to add files to the bar. (macOS
// blocks OS file drops onto this non-activating panel window, so the picker is
// the dependable path; drag-and-drop still works where the OS allows it.)
const attachBtn = document.getElementById("attach");
if (attachBtn) attachBtn.addEventListener("click", () => void openFilePicker());

// Toolbar snip button — capture a screen region straight into the bar.
const snipBtn = document.getElementById("snip");
if (snipBtn) snipBtn.addEventListener("click", () => void snipFromScreen());

// Menu → "Create an image": switch the composer into image mode — every send
// generates a picture (GPT Image 2) until the user switches back to chat.
// Clicking it again while already in image mode toggles back to chat. Never
// auto-send on switch — the user may still be mid-prompt; they press Send.
const menuImageGenEl = document.getElementById("menu-image-gen");
if (menuImageGenEl) {
  menuImageGenEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "image" ? "chat" : "image");
    askEl.focus();
  });
}

// Menu → "Build mode": switch the composer into build mode — sends have LYKN
// code the thing out as a live React artifact ("make me a landing page",
// "build a budget tracker"…) until the user switches back to chat. Clicking
// it again toggles back. Never auto-send on switch — the user may still be
// mid-prompt; the brief goes out when they press Send.
const menuBuildEl = document.getElementById("menu-build");
if (menuBuildEl) {
  menuBuildEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "build" ? "chat" : "build");
    askEl.focus();
  });
}

const menuAgentEl = document.getElementById("menu-agent");
if (menuAgentEl) {
  menuAgentEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "agent" ? "chat" : "agent");
    askEl.focus();
  });
}

const menuResearchEl = document.getElementById("menu-research");
if (menuResearchEl) {
  menuResearchEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "research" ? "chat" : "research");
    askEl.focus();
  });
}

const menuTranslateEl = document.getElementById("menu-translate");
if (menuTranslateEl) {
  menuTranslateEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "translate" ? "chat" : "translate");
    askEl.focus();
  });
}

const menuTranscribeEl = document.getElementById("menu-transcribe");
if (menuTranscribeEl) {
  menuTranscribeEl.addEventListener("click", () => {
    setMenuOpen(false);
    setComposerMode(composerMode === "transcribe" || listening ? "chat" : "transcribe");
    askEl.focus();
  });
}

// Never fire immediately off whatever is typed — the prompt may be unfinished.
// Arm the mode and let the user press Send when they're ready.
const menuBrowserActEl = document.getElementById("menu-browser-act");
if (menuBrowserActEl) {
  menuBrowserActEl.addEventListener("click", () => {
    setMenuOpen(false);
    browserActArmed = true;
    askEl.placeholder = "Describe what to do on this page, then Send…";
    askEl.focus();
  });
}

if (browserActCancelEl) browserActCancelEl.addEventListener("click", () => hideBrowserActPanel());
if (browserActRunEl) {
  browserActRunEl.addEventListener("click", () => {
    if (executingBrowser || busy) return;
    void executeBrowserAct();
  });
}

document.getElementById("menu-open").addEventListener("click", () => {
  setMenuOpen(false);
  try {
    window.lyknOverlay.openMain();
  } catch (_) {}
});

// Content protection toggle — hide the overlay from screen recordings/shares.
// Keeps the menu open so the user sees the On/Off state flip in place.
const stealthBtn = document.getElementById("menu-stealth");
const stealthStateEl = document.getElementById("stealth-state");
function renderStealthState(on) {
  if (!stealthBtn) return;
  stealthBtn.setAttribute("aria-pressed", on ? "true" : "false");
  if (stealthStateEl) stealthStateEl.textContent = on ? "On" : "Off";
}
(async () => {
  try {
    renderStealthState(await window.lyknOverlay.getContentProtection());
  } catch (_) {}
})();
if (stealthBtn) {
  stealthBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = stealthBtn.getAttribute("aria-pressed") === "true";
    try {
      const next = await window.lyknOverlay.setContentProtection(!current);
      renderStealthState(!!next);
    } catch (_) {}
  });
}

// Live Watch — feed lives in the side panel; chat thread stays for user prompts.
const liveWatchBtn = document.getElementById("menu-live-watch");
const liveWatchStateEl = document.getElementById("live-watch-state");

function appendWatchCommentary(text, { system = false, alert = false } = {}) {
  const t = String(text || "").trim();
  if (!t) return;
  watchFeedItems.push({ text: t, system: !!system, alert: !!alert, at: Date.now() });
  if (watchFeedItems.length > 40) watchFeedItems = watchFeedItems.slice(-40);
  if (liveWatchEnabled) {
    if (sidePanelView !== "watch") setSidePanelView("watch");
    else renderWatchSidePanel();
    reportHeight();
  }
}

function startWatchFeed() {
  watchFeedActive = true;
  lastWatchCommentaryPosted = "";
  watchFeedItems = [];
  watchActiveRules = [];
  watchSuggestions = { followups: [], links: [] };
  lastWatchSuggestKey = "";
  watchPageTitle = "";
  watchPageUrl = "";
  appendWatchCommentary("Live feedback is on.", { system: true });
  applyLiveWatchLayout(true);
  startWatchConnPoll();
}

function stopWatchFeed() {
  if (!watchFeedActive) return;
  stopWatchConnPoll();
  watchFeedActive = false;
  appendWatchCommentary("Live feedback stopped.", { system: true });
  lastWatchCommentaryPosted = "";
  watchActiveRules = [];
  watchSuggestions = { followups: [], links: [] };
  lastWatchSuggestKey = "";
  if (watchSuggestTimer) clearTimeout(watchSuggestTimer);
  watchSuggestTimer = null;
  if (sidePanelView === "watch") {
    sidePanelView = "";
    showSide(false);
    updateSidePickerLabel();
  }
}

async function requestWatchSuggestions(status) {
  const commentary = String(status?.commentary || status?.summary || "").trim();
  if (commentary.length < 8) return;
  const pageTitle = String(status?.pageTitle || watchPageTitle || "").trim();
  const pageUrl = String(status?.pageUrl || watchPageUrl || "").trim();
  const summary = String(status?.summary || "").trim();
  const contextSource = status?.contextSource || watchContextSource;
  const suggestKey = [pageUrl, pageTitle, commentary].filter(Boolean).join("|");
  if (suggestKey === lastWatchSuggestKey) return;
  lastWatchSuggestKey = suggestKey;

  const contextLines = [];
  if (pageTitle) contextLines.push(`Page: ${pageTitle}`);
  if (pageUrl) contextLines.push(`URL: ${pageUrl}`);
  if (contextSource === "vision") {
    contextLines.push("View: screen capture (app or game — may not be a browser page)");
  } else if (contextSource === "extension") {
    contextLines.push("View: live browser page via Chrome Live Feed");
  }
  contextLines.push(`What they're doing now: ${commentary}`);
  if (summary && summary !== commentary) {
    contextLines.push(`Recent activity: ${summary.slice(0, 600)}`);
  }

  let data = null;
  try {
    data = await window.lyknOverlay.suggest(
      "Suggest follow-ups about what the user is doing, the page they are on, and sensible next actions.",
      contextLines.join("\n"),
      { mode: "live_watch" },
    );
  } catch (_) {
    data = null;
  }
  watchSuggestions = {
    followups: (data && Array.isArray(data.followups) ? data.followups : []).filter(Boolean),
    links: (data && Array.isArray(data.links) ? data.links : []).filter((l) => l && l.url),
  };
  if (sidePanelView === "watch" || sidePanelView === "all") renderSidePanel();
}

function handleLiveWatchCommentary(status) {
  if (!status?.enabled) return;
  if (Array.isArray(status.rules)) watchActiveRules = status.rules.slice();
  const commentary = String(status?.commentary || status?.summary || "").trim();
  if (!commentary || !status?.isNewCommentary) return;
  if (commentary === lastWatchCommentaryPosted) return;
  lastWatchCommentaryPosted = commentary;
  const isAlert = status.commentaryKind === "alert";
  appendWatchCommentary(commentary, { alert: isAlert });
  if (!isAlert) {
    if (watchSuggestTimer) clearTimeout(watchSuggestTimer);
    watchSuggestTimer = setTimeout(() => {
      watchSuggestTimer = null;
      void requestWatchSuggestions(status);
    }, 400);
  }
}

function renderLiveWatchState(status) {
  const on = !!(status && status.enabled);
  const wasOn = liveWatchEnabled;
  liveWatchEnabled = on;
  if (status?.contextSource) watchContextSource = status.contextSource;
  if (typeof status?.pageTitle === "string") watchPageTitle = status.pageTitle;
  if (typeof status?.pageUrl === "string") watchPageUrl = status.pageUrl;
  if (typeof status?.extensionConnected === "boolean") {
    watchExtensionConnected = status.extensionConnected;
  }
  if (liveWatchBtn) {
    liveWatchBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (liveWatchStateEl) liveWatchStateEl.textContent = on ? "On" : "Off";
  if (Array.isArray(status?.rules)) watchActiveRules = status.rules.slice();
  if (on && !wasOn) startWatchFeed();
  if (!on && wasOn) stopWatchFeed();
  if (on && sidePanelView === "watch") renderWatchSidePanel();
  else if (on && wasOn) reportHeight();
}

(async () => {
  try {
    renderLiveWatchState(await window.lyknOverlay.getLiveWatch());
  } catch (_) {}
})();

if (liveWatchBtn) {
  liveWatchBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = liveWatchBtn.getAttribute("aria-pressed") === "true";
    try {
      const next = await window.lyknOverlay.setLiveWatch(!current);
      if (next?.error === "no_permission") {
        askEl.placeholder = next.needsSettings
          ? "Enable Screen Recording in System Settings, then reopen LYKN"
          : "Click Allow on the macOS Screen Recording dialog, then try again";
        const ph = askEl.placeholder;
        setTimeout(() => {
          if (askEl.placeholder === ph) {
            askEl.placeholder = COMPOSER_MODES[composerMode].placeholder;
          }
        }, 5000);
      }
      renderLiveWatchState(next);
    } catch (_) {}
  });
}

window.lyknOverlay.onLiveWatchUpdate((status) => {
  const prevRules = JSON.stringify(watchActiveRules);
  const prevSource = watchContextSource;
  const prevExt = watchExtensionConnected;
  handleLiveWatchCommentary(status);
  if (Array.isArray(status?.rules)) watchActiveRules = status.rules.slice();
  const rulesChanged = JSON.stringify(watchActiveRules) !== prevRules;
  const sourceChanged =
    (status?.contextSource && status.contextSource !== prevSource) ||
    (typeof status?.extensionConnected === "boolean" && status.extensionConnected !== prevExt);
  // Re-render when feed/rules/source change — not on every capture tick.
  if (status?.isNewCommentary || status?.enabled === false || rulesChanged || sourceChanged) {
    renderLiveWatchState(status);
  }
  if (liveWatchEnabled && voiceActive && voiceSessionToken && status?.summary) {
    void pushScreenContext(true);
  }
});

// ── Voice mode (ElevenLabs realtime agent) ─────────────────────────────────

// ── Shared Escape handling ─────────────────────────────────────────────────
// Priority: cancel drag → stop voice → close floating menus → stop listen →
// hide overlay. askEl used to "defer" voice-stop to a document listener and
// often did nothing; main also forwards Escape via before-input-event for
// macOS panel key-window quirks.
let escapeHandledAt = 0;

function isEscapeEvent(e) {
  return !!(e && (e.key === "Escape" || e.code === "Escape" || e.keyCode === 27));
}

function handleOverlayEscape(e) {
  const now = Date.now();
  // keydown + before-input IPC can both arrive for one keypress — run once so
  // we don't stop voice and then immediately hide the bar.
  if (now - escapeHandledAt < 300) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    return true;
  }

  if (overlayDragActive) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    for (const end of overlayDragEnders) {
      try {
        end();
      } catch (_) {}
    }
    return true;
  }

  if (voiceActive || voiceStarting) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    void stopVoice();
    return true;
  }

  if (moreUserOpen) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setMenuOpen(false);
    return true;
  }

  if (panelPickerOpen) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setPanelPickerOpen(false);
    return true;
  }

  if (translateLangPillEl && translateLangPillEl.classList.contains("open")) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      window.lyknOverlay.setLangPicker(false);
    } catch (_) {}
    translateLangPillEl.classList.remove("open");
    if (translateLangBtnEl) translateLangBtnEl.setAttribute("aria-expanded", "false");
    return true;
  }

  if (listening) {
    escapeHandledAt = now;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    stopListen();
    return true;
  }

  escapeHandledAt = now;
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  try {
    window.lyknOverlay.hide();
  } catch (_) {}
  return true;
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!isEscapeEvent(e)) return;
    handleOverlayEscape(e);
  },
  true,
);

if (typeof window.lyknOverlay.onEscape === "function") {
  window.lyknOverlay.onEscape(() => handleOverlayEscape(null));
}

// ── Live listen: capture system (meeting) audio → rolling transcript ────────
// Uses getDisplayMedia with loopback audio (ScreenCaptureKit on macOS 13+, wired
// up in main via setDisplayMediaRequestHandler).
//
// Wispr-Flow-style pipeline: instead of fixed-length clips, a lightweight VAD
// (energy endpointing with an adaptive noise floor) cuts each recording at
// natural pauses — so words are never split mid-syllable and silence is never
// uploaded (no more hallucinated fragments, far fewer API calls). The raw ASR
// text is displayed the moment it arrives; LLM cleanup runs asynchronously and
// swaps the polished text in place, so cleanup latency never delays the
// transcript.
const listenEl = document.getElementById("listen");

const overlayHost = {
  get SPINNER_PATH() { return SPINNER_PATH; },
  get GENERIC_THINK_RE() { return GENERIC_THINK_RE; },
  get GENERIC_BUILD_RE() { return GENERIC_BUILD_RE; },
  get askEl() { return askEl; },
  get sendEl() { return sendEl; },
  get threadEl() { return threadEl; },
  get dotEl() { return dotEl; },
  get wrapEl() { return wrapEl; },
  get micEl() { return micEl; },
  get listenEl() { return listenEl; },
  get COMPOSER_MODES() { return COMPOSER_MODES; },
  get ARROW_ICON_SVG() { return ARROW_ICON_SVG; },
  get ask() { return ask; },
  get startTurn() { return startTurn; },
  get updateAnswer() { return updateAnswer; },
  get reportHeight() { return reportHeight; },
  get persistCurrentSession() { return persistCurrentSession; },
  get setThinkingStatus() { return setThinkingStatus; },
  get clearBuildingUnder() { return clearBuildingUnder; },
  get ensureBuildingUnder() { return ensureBuildingUnder; },
  get renderModeBadge() { return renderModeBadge; },
  get setComposerMode() { return setComposerMode; },
  get applyLiveNotesLayout() { return applyLiveNotesLayout; },
  get refreshSidePanelFromLiveNotes() { return refreshSidePanelFromLiveNotes; },
  get pushLiveState() { return pushLiveState; },
  get history() { return history; },
  get attachments() { return attachments; },
  get busy() { return busy; },
  set busy(v) { busy = v; },
  get currentAnswerEl() { return currentAnswerEl; },
  set currentAnswerEl(v) { currentAnswerEl = v; },
  get currentChatEl() { return currentChatEl; },
  set currentChatEl(v) { currentChatEl = v; },
  get currentQuestion() { return currentQuestion; },
  set currentQuestion(v) { currentQuestion = v; },
  get currentPageSource() { return currentPageSource; },
  set currentPageSource(v) { currentPageSource = v; },
  get currentHasText() { return currentHasText; },
  set currentHasText(v) { currentHasText = v; },
  get answerStillWorking() { return answerStillWorking; },
  set answerStillWorking(v) { answerStillWorking = v; },
  get lastThinkingStatus() { return lastThinkingStatus; },
  set lastThinkingStatus(v) { lastThinkingStatus = v; },
  get statusRotateLane() { return statusRotateLane; },
  set statusRotateLane(v) { statusRotateLane = v; },
  get statusRotateActive() { return statusRotateActive; },
  set statusRotateActive(v) { statusRotateActive = v; },
  get listening() { return listening; },
  set listening(v) { listening = v; },
  get composerMode() { return composerMode; },
  set composerMode(v) { composerMode = v; },
  get syncingTranscribeMode() { return syncingTranscribeMode; },
  set syncingTranscribeMode(v) { syncingTranscribeMode = v; },
  get transcribing() { return transcribing; },
  set transcribing(v) { transcribing = v; },
  get recording() { return recording; },
  set recording(v) { recording = v; },
  get sideContext() { return sideContext; },
  set sideContext(v) { sideContext = v; },
  get liveNotesSnapshot() { return liveNotesSnapshot; },
  set liveNotesSnapshot(v) { liveNotesSnapshot = v; },
  get sidePanelView() { return sidePanelView; },
  set sidePanelView(v) { sidePanelView = v; },
  get panelPickerOpen() { return panelPickerOpen; },
  set panelPickerOpen(v) { panelPickerOpen = v; },
  get watchFeedItems() { return watchFeedItems; },
  set watchFeedItems(v) { watchFeedItems = v; },
  get watchActiveRules() { return watchActiveRules; },
  set watchActiveRules(v) { watchActiveRules = v; },
  get watchContextSource() { return watchContextSource; },
  set watchContextSource(v) { watchContextSource = v; },
  get watchExtensionConnected() { return watchExtensionConnected; },
  set watchExtensionConnected(v) { watchExtensionConnected = v; },
  get watchPageTitle() { return watchPageTitle; },
  set watchPageTitle(v) { watchPageTitle = v; },
  get watchPageUrl() { return watchPageUrl; },
  set watchPageUrl(v) { watchPageUrl = v; },
  get liveWatchEnabled() { return liveWatchEnabled; },
  set liveWatchEnabled(v) { liveWatchEnabled = v; },
  get lastWatchCommentaryPosted() { return lastWatchCommentaryPosted; },
  set lastWatchCommentaryPosted(v) { lastWatchCommentaryPosted = v; },
  get watchFeedActive() { return watchFeedActive; },
  set watchFeedActive(v) { watchFeedActive = v; },
  get watchSuggestions() { return watchSuggestions; },
  set watchSuggestions(v) { watchSuggestions = v; },
  get watchSuggestTimer() { return watchSuggestTimer; },
  set watchSuggestTimer(v) { watchSuggestTimer = v; },
  get lastWatchSuggestKey() { return lastWatchSuggestKey; },
  set lastWatchSuggestKey(v) { lastWatchSuggestKey = v; },
  get researchSources() { return researchSources; },
  set researchSources(v) { researchSources = v; },
  get liveNotesOpen() { return liveNotesOpen; },
  set liveNotesOpen(v) { liveNotesOpen = v; },
  get voiceActive() { return voiceActive; },
  set voiceActive(v) { voiceActive = v; },
  get voiceStarting() { return voiceStarting; },
  set voiceStarting(v) { voiceStarting = v; },
  get voiceSessionToken() { return voiceSessionToken; },
  set voiceSessionToken(v) { voiceSessionToken = v; },
};

function bindOverlayModules() {
  Object.assign(overlayHost, attachStatusRotation(overlayHost));
  stopStatusRotation = overlayHost.stopStatusRotation;
  maybeRotateFromStatus = overlayHost.maybeRotateFromStatus;
  shouldKeepBuildingUnder = overlayHost.shouldKeepBuildingUnder;
  applyRotatedStatus = overlayHost.applyRotatedStatus;
  startStatusRotation = overlayHost.startStatusRotation;

  const side = attachSidePanel(overlayHost);
  ARROW_ICON_SVG = side.ARROW_ICON_SVG;
  showSide = side.showSide;
  clearSide = side.clearSide;
  resetSideForNewTurn = side.resetSideForNewTurn;
  setSidePanelView = side.setSidePanelView;
  renderSidePanel = side.renderSidePanel;
  renderWatchSidePanel = side.renderWatchSidePanel;
  refreshSidePanelFromLiveNotes = side.refreshSidePanelFromLiveNotes;
  requestSuggestions = side.requestSuggestions;
  mergeSourceLinks = side.mergeSourceLinks;
  setPanelPickerOpen = side.setPanelPickerOpen;
  syncSidePickerState = side.syncSidePickerState;
  updateSidePickerLabel = side.updateSidePickerLabel;
  applyLiveWatchLayout = side.applyLiveWatchLayout;
  applyLiveNotesLayout = side.applyLiveNotesLayout;
  startWatchConnPoll = side.startWatchConnPoll;
  stopWatchConnPoll = side.stopWatchConnPoll;

  const voice = attachVoice(overlayHost);
  stopVoice = voice.stopVoice;
  startVoice = voice.startVoice;
  sendTextToVoice = voice.sendTextToVoice;
  pushScreenContext = voice.pushScreenContext;

  const listen = attachListenMeeting(overlayHost);
  pushLiveState = listen.pushLiveState;
  startListen = listen.startListen;
  stopListen = listen.stopListen;
  closeLive = listen.closeLive;
}


listenEl.addEventListener("click", () => {
  // Hidden drawer control — same toggle as Transcribe mode.
  if (listening || composerMode === "transcribe") setComposerMode("chat");
  else setComposerMode("transcribe");
});
// The card's own controls (tabs, close, copy, save, toast) live in the
// detached window and arrive as commands via window.__lyknLiveCmd above.

// NOTE: In Electron, file drop/dragover events frequently won't fire unless a
// dragover listener is registered on `document` (a long-standing quirk). We bind
// to document, window, and body, and always preventDefault so the OS doesn't just
// open the file. On macOS the overlay is a non-activating `panel` window, which
// the OS won't route external file drops to — there the in-bar attach button is
// the reliable path. These handlers still serve platforms where drops work.
let dragDepth = 0;
const onDragEnter = (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth += 1;
  wrapEl.classList.add("dropping");
};
const onDragOver = (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
};
const onDragLeave = (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) wrapEl.classList.remove("dropping");
};
const onDrop = (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  wrapEl.classList.remove("dropping");
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length) {
    void addFiles(dt.files);
    return;
  }
  // Fallback: some platforms populate items but not files until accessed.
  if (dt && dt.items && dt.items.length) {
    const files = [];
    for (const item of dt.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) void addFiles(files);
  }
};
for (const target of [document, window, document.body]) {
  if (!target) continue;
  target.addEventListener("dragenter", onDragEnter);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("dragleave", onDragLeave);
  target.addEventListener("drop", onDrop);
}

sendEl.addEventListener("click", ask);
// Grow the prompt field to fit its content (capped by CSS max-height, after
// which it scrolls), then report the new size so the window grows with it.
function autoGrowAsk() {
  askEl.style.height = "auto";
  askEl.style.height = Math.min(askEl.scrollHeight, 180) + "px";
  reportHeight();
}

askEl.addEventListener("input", autoGrowAsk);

askEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    // Enter sends; Shift+Enter inserts a newline (handled by default).
    e.preventDefault();
    ask();
  } else if (isEscapeEvent(e)) {
    // Capture-phase handler also runs; this keeps Esc reliable when focus is
    // in the composer (the common case during voice).
    handleOverlayEscape(e);
  }
});

bindOverlayModules();
askEl.focus();
syncSidePickerState();
reportHeight();

void (async () => {
  try {
    const res = await window.lyknOverlay.ensureOverlaySession();
    if (res && res.sessionId) currentSessionId = res.sessionId;
  } catch (_) {}
})();
