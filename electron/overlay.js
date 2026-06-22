// Glass-bar overlay renderer. The user types a question; the main process
// silently captures the screen, sends it to LYKN, and streams the answer back
// here. The screenshot itself is never shown.

const askEl = document.getElementById("ask");
const sendEl = document.getElementById("send");
const threadEl = document.getElementById("thread");
const dotEl = document.getElementById("dot");

let busy = false;
// The answer element of the turn currently streaming, so deltas land in the
// right place even after older turns have been collapsed.
let currentAnswerEl = null;
// Whether the current turn has started receiving answer text (vs still showing
// the thinking/tool spinner).
let currentHasText = false;
// Lightweight conversation memory so follow-ups ("what about the error?") have
// context. Capped on the main side too.
const history = [];

const CHEVRON_SVG =
  '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 9 6 6 6-6" /></svg>';

// The LYKN icon outline used by the chat page's loading spinner.
const SPINNER_PATH =
  "M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z";

function thinkingHTML(status) {
  return (
    '<div class="thinking">' +
    '<svg class="lykn-outline-spinner" width="20" height="20" viewBox="0 0 204.29 204.29" ' +
    'fill="none" role="img" aria-label="Loading">' +
    '<path d="' + SPINNER_PATH + '" pathLength="1" fill="currentColor" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />' +
    "</svg>" +
    '<span class="thinking-text"></span>' +
    "</div>"
  );
}

let lastReportedHeight = -1;
function reportHeight() {
  // Measure the EXACT content height after layout settles, and only tell main to
  // resize when it actually changed — so the panel grows/shrinks only when needed
  // instead of creeping on every keystroke or delta.
  requestAnimationFrame(() => {
    const bar = document.querySelector(".bar");
    const title = document.querySelector(".titlebar");
    const att = document.getElementById("attachments");
    const attH = att && att.classList.contains("show") ? att.offsetHeight : 0;
    const menu = document.getElementById("menu");
    // +12 = the floating card's top (4) + bottom (8) margins, which offsetHeight
    // doesn't include but the flow layout does.
    const menuH = menu && menu.classList.contains("show") ? menu.offsetHeight + 12 : 0;
    // Use scrollHeight for the thread: it reports the true content height even
    // when flexbox has shrunk the element to fit the (still-small) window. Cap at
    // the CSS max-height so past that it scrolls internally instead of growing.
    // +1 = thread border-bottom, +2 = #wrap top/bottom borders.
    const threadH = threadEl.classList.contains("show")
      ? Math.min(threadEl.scrollHeight + 1, 420)
      : 0;
    const h = title.offsetHeight + menuH + threadH + attH + bar.offsetHeight + 2;
    if (h !== lastReportedHeight) {
      lastReportedHeight = h;
      window.lyknOverlay.resize(h);
    }
  });
}

function setBusy(on) {
  busy = on;
  dotEl.classList.toggle("busy", on);
  sendEl.classList.toggle("busy", on);
  sendEl.disabled = on;
}

// Start a new turn: collapse every prior turn, append an expanded item for this
// question, and return its answer element to stream into.
function startTurn(question) {
  threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));

  const item = document.createElement("div");
  item.className = "chat";

  const q = document.createElement("button");
  q.className = "chat-q";
  q.type = "button";
  q.innerHTML = CHEVRON_SVG;
  const qt = document.createElement("span");
  qt.className = "q-text";
  qt.textContent = question;
  q.appendChild(qt);

  const a = document.createElement("div");
  a.className = "chat-a";
  a.innerHTML = thinkingHTML();

  item.appendChild(q);
  item.appendChild(a);
  threadEl.appendChild(item);
  threadEl.classList.add("show");
  currentAnswerEl = a;
  currentHasText = false;
  setThinkingStatus("Thinking…");

  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
  return a;
}

// Update the shimmer status label while the spinner is showing (ignored once
// real answer text has begun streaming in).
function setThinkingStatus(text) {
  if (!currentAnswerEl || currentHasText) return;
  const el = currentAnswerEl.querySelector(".thinking-text");
  if (el) el.textContent = text || "Thinking…";
  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
}

function updateAnswer(text) {
  if (!currentAnswerEl) return;
  // Trim trailing blank lines/whitespace — with pre-wrap they'd render as empty
  // vertical space and make the panel look like it grew for no reason.
  const trimmed = (text || "").replace(/\s+$/, "");
  if (!trimmed && !currentHasText) return; // keep the spinner until real text
  currentHasText = true;
  currentAnswerEl.textContent = trimmed;
  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
}

function ask() {
  const q = askEl.value.trim();
  if ((!q && attachments.length === 0) || busy) return;
  askEl.value = "";
  setBusy(true);
  const sentAttachments = attachments.slice();
  const label =
    q || (sentAttachments.length ? `Sent ${sentAttachments.length} attachment(s)` : "");
  startTurn(label);
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  window.lyknOverlay.ask(q, history, sentAttachments);
  clearAttachments();
}

// Accordion: clicking a turn's header opens it and collapses every other turn,
// keeping only one answer visible at a time. Clicking the open one closes it.
threadEl.addEventListener("click", (e) => {
  const header = e.target.closest(".chat-q");
  if (!header) return;
  const item = header.closest(".chat");
  if (!item) return;
  const willOpen = item.classList.contains("collapsed");
  threadEl.querySelectorAll(".chat").forEach((c) => c.classList.add("collapsed"));
  if (willOpen) item.classList.remove("collapsed");
  reportHeight();
});

let streamingText = "";
window.lyknOverlay.onStatus((p) => {
  setThinkingStatus((p && p.status) || "Thinking…");
});
window.lyknOverlay.onDelta((p) => {
  streamingText = p && p.text ? p.text : streamingText;
  updateAnswer(streamingText);
});
window.lyknOverlay.onDone((p) => {
  const finalText = (p && p.text) || streamingText;
  if (finalText) {
    updateAnswer(finalText);
    history.push({ role: "assistant", content: finalText, at: new Date().toISOString() });
  } else if (!currentHasText && currentAnswerEl) {
    // Nothing came back — clear the spinner instead of leaving it spinning.
    currentHasText = true;
    currentAnswerEl.textContent = "No response.";
    reportHeight();
  }
  streamingText = "";
  setBusy(false);
  askEl.focus();
});
window.lyknOverlay.onError((p) => {
  updateAnswer((p && p.message) || "Something went wrong.");
  streamingText = "";
  setBusy(false);
});

window.lyknOverlay.onShown(() => {
  setTimeout(() => askEl.focus(), 40);
});

// Drag the panel around via the top-left handle. Pointer capture + screen coords
// keep the drag tracking even if the cursor briefly outruns the moving window.
const dragEl = document.getElementById("drag");
let dragging = false;
let lastX = 0;
let lastY = 0;
dragEl.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".more-btn")) return; // don't drag from the menu button
  dragging = true;
  lastX = e.screenX;
  lastY = e.screenY;
  dragEl.classList.add("dragging");
  try { dragEl.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});
dragEl.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  if (dx || dy) {
    lastX = e.screenX;
    lastY = e.screenY;
    window.lyknOverlay.moveBy(dx, dy);
  }
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  dragEl.classList.remove("dragging");
  try { dragEl.releasePointerCapture(e.pointerId); } catch (_) {}
};
dragEl.addEventListener("pointerup", endDrag);
dragEl.addEventListener("pointercancel", endDrag);

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
const DEFAULT_PLACEHOLDER = askEl.getAttribute("placeholder") || "Ask LYKN about your screen…";

function setMicState() {
  micEl.classList.toggle("recording", recording);
  micEl.classList.toggle("transcribing", transcribing);
  micEl.disabled = transcribing;
  micEl.title = recording ? "Stop recording" : transcribing ? "Transcribing…" : "Dictate";
  askEl.placeholder = recording
    ? "Listening… click the mic to stop"
    : transcribing
      ? "Transcribing…"
      : DEFAULT_PLACEHOLDER;
}

async function startDictation() {
  if (recording || transcribing || busy) return;
  const ok = await window.lyknOverlay.ensureMic();
  if (!ok) {
    startTurn("Dictation");
    currentHasText = true;
    currentAnswerEl.textContent =
      "LYKN needs Microphone access. Enable it in System Settings → Privacy & Security → Microphone, then try again.";
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
          text: `(Unsupported file type: ${file.type || "unknown"} — not included.)`,
        });
      }
    } catch (_) {
      /* skip unreadable file */
    }
  }
  renderAttachments();
  askEl.focus();
}

// ── "More" dropdown menu ───────────────────────────────────────────────────
const moreBtn = document.getElementById("more");
const menuEl = document.getElementById("menu");

function setMenuOpen(open) {
  menuEl.classList.toggle("show", open);
  moreBtn.classList.toggle("open", open);
  reportHeight();
}

moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen(!menuEl.classList.contains("show"));
});
document.addEventListener("click", (e) => {
  if (menuEl.classList.contains("show") && !e.target.closest("#menu") && !e.target.closest("#more")) {
    setMenuOpen(false);
  }
});

document.getElementById("menu-attach").addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    const items = await window.lyknOverlay.pickFiles();
    addAttachmentObjects(items);
  } catch (_) {}
});

document.getElementById("menu-open").addEventListener("click", () => {
  setMenuOpen(false);
  try {
    window.lyknOverlay.openMain();
  } catch (_) {}
});

// ── Voice mode (ElevenLabs realtime agent) ─────────────────────────────────
const voiceEl = document.getElementById("voice");
const VOICE_TOOL_NAMES = [
  "search_vault", "read_document", "display_document", "web_search", "web_fetch",
  "find_connections", "get_beliefs", "get_rules", "get_facts", "propose_fact",
  "list_projects", "get_project_state", "set_active_project", "create_project",
  "update_project_state", "get_recent_activity", "create_reminder", "list_reminders",
  "update_reminder", "create_event", "list_events", "update_event", "delete_event",
  "create_todo", "list_todos", "update_todo", "delete_todo", "list_custom_models",
  "communicate_with_model", "build_with_cursor", "check_cursor_build", "save_to_vault",
  "add_to_project",
];
let voiceConvo = null;
let voiceActive = false;
let voiceStarting = false;
let voiceConnected = false;
let voiceAwaitingAnswer = false;
let voiceSessionToken = "";
// Monotonic token: every start/stop bumps it. Any async work from an older
// generation is stale and must not mutate UI or bring a session live. This is
// what keeps the on/off state honest when the user toggles mid-connect.
let voiceGen = 0;
let voiceConnectTimer = null;

function clearVoiceTimer() {
  if (voiceConnectTimer) {
    clearTimeout(voiceConnectTimer);
    voiceConnectTimer = null;
  }
}

// Feed the current screen to the live agent as contextual text, so voice mode
// "sees" the screen like the typed chat does. Throttled (vision calls are slow)
// and non-interrupting; the agent silently absorbs it for the next user turn.
let lastScreenPushAt = 0;
let screenPushInFlight = false;

async function pushScreenContext(force) {
  if (!voiceActive || !voiceSessionToken) return;
  if (screenPushInFlight) return;
  const now = Date.now();
  if (!force && now - lastScreenPushAt < 4000) return;
  screenPushInFlight = true;
  lastScreenPushAt = now;
  try {
    // main captures + describes the screen and pushes it to the live session's
    // server-side grounding, so the custom-LLM injects it into every turn.
    await window.lyknOverlay.voiceScreen(voiceSessionToken);
  } catch (_) {
    /* ignore — screen context is best-effort */
  } finally {
    screenPushInFlight = false;
  }
}

function buildVoiceTools() {
  const tools = {};
  for (const name of VOICE_TOOL_NAMES) {
    tools[name] = async (params) => {
      try {
        const data = await window.lyknOverlay.voiceTool(name, params ?? {});
        return JSON.stringify(data);
      } catch (_) {
        return JSON.stringify({ ok: false, error: "tool_request_failed" });
      }
    };
  }
  // Local-only voice-instruction tuning isn't managed by the overlay; ack it.
  tools["update_voice_instructions"] = async () => JSON.stringify({ ok: true });
  return tools;
}

function setVoiceUi(state) {
  // state: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'off'
  const on = state !== "off";
  voiceEl.classList.toggle("voice-active", on);
  dotEl.classList.toggle("busy", on && state !== "listening");
  voiceEl.title = on ? "Stop voice mode" : "Voice mode";
  askEl.disabled = on;
  if (on) {
    askEl.placeholder =
      state === "connecting"
        ? "Connecting voice…"
        : state === "speaking"
          ? "LYKN is speaking…"
          : state === "thinking"
            ? "Thinking…"
            : "Listening… (click the waveform to stop)";
  } else {
    askEl.placeholder = DEFAULT_PLACEHOLDER;
  }
}

function voiceUserMessage(text) {
  const t = String(text || "").trim();
  if (!t) return;
  startTurn(t);
  setThinkingStatus("Thinking…");
  voiceAwaitingAnswer = true;
}

function voiceAiMessage(text) {
  const t = String(text || "").trim();
  if (!t) return;
  if (!voiceAwaitingAnswer || !currentAnswerEl) startTurn("LYKN");
  updateAnswer(t);
  history.push({ role: "assistant", content: t, at: new Date().toISOString() });
  voiceAwaitingAnswer = false;
}

function voiceError(message) {
  startTurn("Voice mode");
  currentHasText = true;
  currentAnswerEl.textContent = message;
  reportHeight();
}

async function startVoice() {
  if (voiceActive || voiceStarting) return;
  if (!window.ElevenLabsClient || !window.ElevenLabsClient.Conversation) {
    voiceError("Voice mode couldn't load. Try reopening LYKN.");
    return;
  }

  const myGen = ++voiceGen;
  // Stale if the user toggled voice off (or restarted it) while this async
  // start was still in flight. When stale we must never bring a session live.
  const cancelled = () => voiceGen !== myGen;

  voiceStarting = true;
  voiceActive = false;
  voiceConnected = false;
  setVoiceUi("connecting");

  // Watchdog: if we never reach a connected state, tear it all down instead of
  // showing "Connecting voice…" forever (e.g. WebRTC TURN resolution stalls).
  clearVoiceTimer();
  voiceConnectTimer = setTimeout(() => {
    if (cancelled() || voiceConnected) return;
    voiceGen += 1; // invalidate this attempt
    voiceStarting = false;
    voiceActive = false;
    const c = voiceConvo;
    voiceConvo = null;
    try { if (c && typeof c.endSession === "function") c.endSession(); } catch (_) {}
    setVoiceUi("off");
    voiceError("Voice connection timed out. Please try again.");
  }, 15000);

  const ok = await window.lyknOverlay.ensureMic();
  if (cancelled()) return;
  if (!ok) {
    clearVoiceTimer();
    voiceStarting = false;
    setVoiceUi("off");
    voiceError(
      "LYKN needs Microphone access. Enable it in System Settings → Privacy & Security → Microphone, then try again.",
    );
    return;
  }

  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (_) {
      return null;
    }
  })();
  const screenInstructions =
    "You are LYKN running inside an on-screen overlay on the user's Mac, and you CAN see " +
    "the user's screen. The current screen contents are continuously provided to you as " +
    "contextual updates that start with \"SCREEN CONTENTS\". Treat those as your live view " +
    "of what is on the user's screen right now and use them to answer questions about what " +
    "they are looking at. Never tell the user you are unable to see or read their screen.";
  const data = await window.lyknOverlay.voiceSignedUrl({ instructions: screenInstructions, timezone });
  if (cancelled()) return;
  if (!data || data.error || (!data.conversationToken && !data.signedUrl)) {
    clearVoiceTimer();
    voiceStarting = false;
    setVoiceUi("off");
    voiceError((data && data.error) || "Couldn't start voice session.");
    return;
  }

  // Keep the session token so we can push screen context to the server grounding.
  voiceSessionToken = data.sessionToken || "";

  const overrides = {};
  if (data.sessionToken) overrides.agent = { prompt: { prompt: `LYKN_SESSION_TOKEN=${data.sessionToken}` } };
  if (typeof data.firstMessage === "string" && data.firstMessage) {
    overrides.agent = Object.assign(overrides.agent || {}, { firstMessage: data.firstMessage });
  }

  const common = {
    clientTools: buildVoiceTools(),
    onConnect: () => {
      if (cancelled()) return;
      clearVoiceTimer();
      voiceConnected = true;
      voiceActive = true;
      voiceStarting = false;
      setVoiceUi("listening");
      // Prime the agent with the current screen right away.
      void pushScreenContext(true);
    },
    onDisconnect: () => {
      if (cancelled()) return;
      clearVoiceTimer();
      voiceActive = false;
      voiceStarting = false;
      voiceConnected = false;
      voiceConvo = null;
      voiceSessionToken = "";
      setVoiceUi("off");
    },
    onError: (e) => {
      if (cancelled()) return;
      clearVoiceTimer();
      const msg = (e && e.message) || (typeof e === "string" ? e : "Voice connection error.");
      voiceActive = false;
      voiceStarting = false;
      voiceConnected = false;
      voiceConvo = null;
      voiceSessionToken = "";
      setVoiceUi("off");
      voiceError(msg);
    },
    onModeChange: ({ mode }) => {
      if (cancelled()) return;
      setVoiceUi(mode === "speaking" ? "speaking" : "listening");
      // Returning to listening = the user is about to speak; refresh the screen
      // context (throttled) so their next question reflects what's on screen now.
      if (mode !== "speaking") void pushScreenContext(false);
    },
    onMessage: (m) => {
      if (cancelled()) return;
      const text = String((m && m.message) || "").trim();
      if (!text) return;
      if (m.source === "user") voiceUserMessage(text);
      else if (m.source === "ai") voiceAiMessage(text);
    },
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };

  let convo = null;
  try {
    // Prefer the WebSocket transport: it connects fast and reliably. WebRTC is
    // nicer for audio jitter, but in this desktop environment its TURN server
    // (turn.rtc.elevenlabs.io) frequently fails to resolve and the connection
    // hangs, so we only fall back to it when no signed URL is available.
    if (data.signedUrl) {
      try {
        convo = await window.ElevenLabsClient.Conversation.startSession({
          ...common,
          signedUrl: data.signedUrl,
          connectionType: "websocket",
        });
      } catch (wsErr) {
        if (cancelled()) return;
        if (!data.conversationToken) throw wsErr;
        convo = await window.ElevenLabsClient.Conversation.startSession({
          ...common,
          conversationToken: data.conversationToken,
          connectionType: "webrtc",
        });
      }
    } else {
      convo = await window.ElevenLabsClient.Conversation.startSession({
        ...common,
        conversationToken: data.conversationToken,
        connectionType: "webrtc",
      });
    }
  } catch (e) {
    if (cancelled()) return;
    clearVoiceTimer();
    voiceStarting = false;
    voiceActive = false;
    voiceConnected = false;
    voiceConvo = null;
    setVoiceUi("off");
    voiceError((e && e.message) || "Couldn't start the voice connection.");
    return;
  }

  // The user toggled voice off while we were connecting: the session is now
  // live but unwanted, so tear it back down immediately.
  if (cancelled()) {
    try { if (convo && typeof convo.endSession === "function") await convo.endSession(); } catch (_) {}
    return;
  }
  voiceConvo = convo;
  voiceActive = true;
  voiceStarting = false;
  // onConnect may have fired before voiceConvo was assigned (so its push was a
  // no-op); now that the handle exists, prime the agent with the screen.
  void pushScreenContext(true);
}

async function stopVoice() {
  voiceGen += 1; // invalidate any in-flight start so it can't go live
  clearVoiceTimer();
  voiceStarting = false;
  voiceActive = false;
  voiceConnected = false;
  voiceSessionToken = "";
  const c = voiceConvo;
  voiceConvo = null;
  setVoiceUi("off");
  try {
    if (c && typeof c.endSession === "function") await c.endSession();
  } catch (_) {}
}

voiceEl.addEventListener("click", () => {
  if (voiceActive || voiceStarting) void stopVoice();
  else void startVoice();
});

// Escape ends voice mode (the input is disabled while it's live, so its own
// Escape handler won't fire); otherwise the input's handler hides the overlay.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (voiceActive || voiceStarting)) {
    e.preventDefault();
    void stopVoice();
  }
});

// NOTE: In Electron, file drop/dragover events frequently won't fire unless a
// dragover listener is registered on `document` (a long-standing quirk). We bind
// to both document and window, and always preventDefault so the OS doesn't just
// open the file.
let dragDepth = 0;
const onDragEnter = (e) => {
  e.preventDefault();
  dragDepth += 1;
  wrapEl.classList.add("dropping");
};
const onDragOver = (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
};
const onDragLeave = (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) wrapEl.classList.remove("dropping");
};
const onDrop = (e) => {
  e.preventDefault();
  dragDepth = 0;
  wrapEl.classList.remove("dropping");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    void addFiles(e.dataTransfer.files);
  }
};
for (const target of [document, window]) {
  target.addEventListener("dragenter", onDragEnter);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("dragleave", onDragLeave);
  target.addEventListener("drop", onDrop);
}

sendEl.addEventListener("click", ask);
askEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    ask();
  } else if (e.key === "Escape") {
    window.lyknOverlay.hide();
  }
});

askEl.focus();
reportHeight();
