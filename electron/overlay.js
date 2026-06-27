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

// ── Minimal, safe Markdown → HTML for answers ──────────────────────────────
// The model replies in Markdown (## headers, **bold**, - bullets, 1. lists,
// `code`). We escape first so model output can't inject HTML, then build a small
// set of block/inline elements. Good enough for chat answers without a library.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let listType = null;
  let para = [];
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      html += `<p>${renderInline(para.join(" "))}</p>`;
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      closeList();
      html += `<div class="md-h">${renderInline(m[2])}</div>`;
      continue;
    }
    m = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${renderInline(m[1])}</li>`;
      continue;
    }
    m = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${renderInline(m[1])}</li>`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html;
}

const LINK_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>';

const ARROW_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>';

const sideEl = document.getElementById("side");
const sideInnerEl = document.getElementById("side-inner");
const sidePickerBtnEl = document.getElementById("side-picker-btn");
const panelMenuEl = document.getElementById("panel-menu");
const sidePickerLabelEl = document.getElementById("side-picker-label");

const SIDE_VIEW_OPTIONS = [
  { id: "", label: "None" },
  { id: "watch", label: "Live feedback" },
  { id: "all", label: "All" },
  { id: "sources", label: "Sources" },
  { id: "tasks", label: "Tasks" },
  { id: "followups", label: "Follow-ups" },
  { id: "notes", label: "Notes" },
];

let sideContext = null;
let lastAnswerText = "";
let liveNotesSnapshot = { keyPoints: [], actionItems: [], summary: "" };
let sidePanelView = "";
let panelPickerOpen = false;
// Live watch feed — rendered in the side panel, not the chat thread.
let watchFeedItems = [];
let watchActiveRules = [];
let watchContextSource = "vision";
let watchExtensionConnected = false;
let watchPageTitle = "";
let watchPageUrl = "";
let watchConnPollTimer = null;

function startWatchConnPoll() {
  if (watchConnPollTimer) return;
  watchConnPollTimer = setInterval(async () => {
    if (!liveWatchEnabled) return;
    try {
      const status = await window.lyknOverlay.getLiveWatch();
      const next = !!status?.extensionConnected;
      if (next !== watchExtensionConnected) {
        watchExtensionConnected = next;
        if (sidePanelView === "watch") renderWatchSidePanel();
      }
    } catch (_) {}
  }, 2000);
}

function stopWatchConnPoll() {
  if (watchConnPollTimer) clearInterval(watchConnPollTimer);
  watchConnPollTimer = null;
}
let liveWatchEnabled = false;
let lastWatchCommentaryPosted = "";
let watchFeedActive = false;
let watchSuggestions = { followups: [], links: [] };
let watchSuggestTimer = null;
let lastWatchSuggestKey = "";

function dedupeStrings(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function extractTasksFromAnswer(text) {
  const lines = String(text || "").split("\n");
  const tasks = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#+\s*(action|task|todo)/i.test(t) || /^action items?:/i.test(t)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^#+\s/.test(t) && !/^#+\s*(action|task|todo)/i.test(t)) inBlock = false;
    const box = t.match(/^[-*]\s*\[[ xX]?\]\s*(.+)/);
    if (box) {
      tasks.push(box[1].trim());
      continue;
    }
    if (inBlock) {
      const bullet = t.match(/^[-*•]\s+(.+)/);
      if (bullet) tasks.push(bullet[1].trim());
    }
  }
  return tasks;
}

function extractNotesFromAnswer(text) {
  const lines = String(text || "").split("\n");
  const notes = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#+\s*(key point|summary|note|highlight)/i.test(t) || /^key points?:/i.test(t)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^#+\s/.test(t) && !/^#+\s*(key point|summary|note|highlight)/i.test(t)) inBlock = false;
    const bullet = t.match(/^[-*•]\s+(?!\[[ xX]?\])(.+)/);
    if (inBlock && bullet) notes.push(bullet[1].trim());
  }
  return notes;
}

function buildSideData() {
  const tasks = dedupeStrings([
    ...extractTasksFromAnswer(lastAnswerText),
    ...(liveNotesSnapshot.actionItems || []),
  ]);
  const notes = dedupeStrings([
    ...(liveNotesSnapshot.keyPoints || []),
    ...extractNotesFromAnswer(lastAnswerText),
  ]);
  return {
    pageSource: sideContext && sideContext.pageSource ? sideContext.pageSource : null,
    links: (sideContext && sideContext.links) || [],
    followups: (sideContext && sideContext.followups) || [],
    tasks,
    notes,
    summary: String(liveNotesSnapshot.summary || "").trim(),
  };
}

function sideViewCount(viewId, data) {
  if (!data) return 0;
  switch (viewId) {
    case "watch":
      return watchFeedItems.filter((i) => !i.system).length;
    case "sources":
      return (data.pageSource && data.pageSource.url ? 1 : 0) + data.links.length;
    case "tasks":
      return data.tasks.length;
    case "followups":
      return data.followups.length;
    case "notes":
      return data.notes.length + (data.summary ? 1 : 0);
    case "all":
      return (
        sideViewCount("watch", data) +
        sideViewCount("sources", data) +
        sideViewCount("tasks", data) +
        sideViewCount("followups", data) +
        sideViewCount("notes", data)
      );
    default:
      return 0;
  }
}

function updateSidePickerLabel() {
  const opt = SIDE_VIEW_OPTIONS.find((o) => o.id === sidePanelView);
  sidePickerLabelEl.textContent = opt ? opt.label : "None";
}

function setPanelPickerOpen(open) {
  panelPickerOpen = open;
  sidePickerBtnEl.classList.toggle("active", open);
  sidePickerBtnEl.setAttribute("aria-expanded", open ? "true" : "false");
  composerEl.classList.toggle("panel-open", open);
  if (open) {
    if (moreUserOpen) setMenuOpen(false);
    renderPanelMenu();
  }
  reportHeight();
}

function closeSidePickerMenu() {
  setPanelPickerOpen(false);
}

function renderPanelMenu() {
  const data = buildSideData();
  panelMenuEl.innerHTML = "";
  for (const opt of SIDE_VIEW_OPTIONS) {
    if (opt.id === "watch" && !liveWatchEnabled) continue;
    const count = opt.id ? sideViewCount(opt.id, data) : 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "panel-menu-item" +
      (opt.id === sidePanelView ? " active" : "") +
      (opt.id && !count ? " empty" : "");
    btn.setAttribute("role", "option");
    btn.innerHTML = `<span>${escapeHtml(opt.label)}</span>` +
      (opt.id && opt.id !== "all" ? `<span class="count">${count || "—"}</span>` : "");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setSidePanelView(opt.id);
      setPanelPickerOpen(false);
    });
    panelMenuEl.appendChild(btn);
  }
}

function syncSidePickerState() {
  updateSidePickerLabel();
}

let sideCloseTimer = null;
function showSide(open) {
  if (open && !sidePanelView) return;
  if (sideCloseTimer) {
    clearTimeout(sideCloseTimer);
    sideCloseTimer = null;
  }
  if (open) {
    sideEl.classList.add("show");
    reportHeight();
  } else {
    sideEl.classList.remove("show");
    sideCloseTimer = setTimeout(() => {
      sideCloseTimer = null;
      reportHeight();
    }, 160);
  }
}

function clearSide() {
  sideInnerEl.innerHTML = "";
  sideContext = null;
  lastAnswerText = "";
  sidePanelView = "";
  closeSidePickerMenu();
  updateSidePickerLabel();
  showSide(false);
  syncSidePickerState();
}

// Reset sources/tasks side data for a new chat turn without closing live watch.
function resetSideForNewTurn() {
  sideContext = null;
  lastAnswerText = "";
  if (liveWatchEnabled) {
    if (!sidePanelView) setSidePanelView("watch");
    else if (sidePanelView === "watch") renderWatchSidePanel();
    else renderSidePanel();
    return;
  }
  sidePanelView = "";
  closeSidePickerMenu();
  updateSidePickerLabel();
  showSide(false);
}

function setSidePanelView(viewId) {
  sidePanelView = viewId || "";
  updateSidePickerLabel();
  if (!sidePanelView) {
    showSide(false);
    return;
  }
  renderSidePanel();
  showSide(true);
}

sidePickerBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  setPanelPickerOpen(!panelPickerOpen);
});

document.addEventListener("click", (e) => {
  if (panelPickerOpen && !e.target.closest("#composer")) setPanelPickerOpen(false);
});

function sideTextItem(text) {
  const el = document.createElement("div");
  el.className = "side-text-item";
  el.textContent = text;
  return el;
}

function appendSourcesSection(data, target) {
  let added = false;
  if (data.pageSource && data.pageSource.url) {
    const { sec, list } = sideSection("Read this page");
    list.appendChild(sourceCard(data.pageSource));
    target.appendChild(sec);
    added = true;
  }
  if (data.links.length) {
    const { sec, list } = sideSection("Sources");
    for (const l of data.links.slice(0, 5)) list.appendChild(sourceCard(l));
    target.appendChild(sec);
    added = true;
  }
  return added;
}

function appendTasksSection(data, target) {
  if (!data.tasks.length) return false;
  const { sec, list } = sideSection("Tasks");
  for (const t of data.tasks.slice(0, 8)) list.appendChild(sideTextItem(t));
  target.appendChild(sec);
  return true;
}

function appendFollowupsSection(data, target) {
  if (!data.followups.length) return false;
  const { sec, list } = sideSection("Follow-ups");
  for (const f of data.followups.slice(0, 4)) {
    list.appendChild(
      optionButton(f, ARROW_ICON_SVG, () => {
        askEl.value = f;
        ask();
      }),
    );
  }
  target.appendChild(sec);
  return true;
}

function appendNotesSection(data, target) {
  let added = false;
  if (data.summary) {
    const { sec, list } = sideSection("Summary");
    const el = document.createElement("div");
    el.className = "side-summary";
    el.textContent = data.summary;
    list.appendChild(el);
    target.appendChild(sec);
    added = true;
  }
  if (data.notes.length) {
    const { sec, list } = sideSection("Notes");
    for (const n of data.notes.slice(0, 8)) list.appendChild(sideTextItem(n));
    target.appendChild(sec);
    added = true;
  }
  return added;
}

function watchSourceLabel() {
  if (watchContextSource === "extension") return "via extension (text)";
  if (watchContextSource === "scrape") return "via browser text";
  return "via screen";
}

function appendWatchSuggestionsSection(target) {
  const followups = (watchSuggestions.followups || []).filter(Boolean);
  const links = (watchSuggestions.links || []).filter((l) => l && l.url);
  let added = false;
  if (followups.length) {
    const { sec, list } = sideSection("Suggestions");
    for (const f of followups.slice(0, 4)) {
      list.appendChild(
        optionButton(f, ARROW_ICON_SVG, () => {
          askEl.value = f;
          ask();
        }),
      );
    }
    target.appendChild(sec);
    added = true;
  }
  if (links.length) {
    const { sec, list } = sideSection("Sources");
    for (const l of links.slice(0, 4)) list.appendChild(sourceCard(l));
    target.appendChild(sec);
    added = true;
  }
  return added;
}

function appendWatchSideSection(target) {
  if (!watchFeedActive && !watchFeedItems.length) return false;
  const { sec, list } = sideSection("Live feedback");
  if (!watchExtensionConnected && watchFeedActive) {
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "watch-install-btn";
    installBtn.textContent = "Add Chrome Live Feed";
    installBtn.addEventListener("click", () => {
      window.lyknOverlay.openExtensionInstall?.().catch(() => {});
    });
    list.appendChild(installBtn);
  }
  if (watchActiveRules.length) {
    const rulesEl = document.createElement("div");
    rulesEl.className = "watch-side-rules";
    rulesEl.textContent = `Alerts: ${watchActiveRules.join(" · ")}`;
    list.appendChild(rulesEl);
  }
  if (!watchFeedItems.length) {
    list.appendChild(sideTextItem("Analyzing screen…"));
  } else {
    for (const item of watchFeedItems.slice(-24)) {
      const row = document.createElement("div");
      row.className =
        "watch-side-item" +
        (item.system ? " system" : "") +
        (item.alert ? " alert" : "");
      const body = document.createElement("div");
      body.className = "watch-side-text";
      body.textContent = item.text;
      if (item.alert || item.system) {
        const meta = document.createElement("div");
        meta.className = "watch-side-meta";
        meta.textContent = item.alert ? "Alert" : "Live feedback";
        row.appendChild(meta);
      }
      row.appendChild(body);
      list.appendChild(row);
    }
  }
  target.appendChild(sec);
  appendWatchSuggestionsSection(target);
  return true;
}

function renderWatchSidePanel() {
  sideInnerEl.innerHTML = "";
  if (watchExtensionConnected && watchFeedActive) {
    const banner = document.createElement("div");
    banner.className = "watch-connected-banner";
    banner.textContent = "Chrome Live Feed connected";
    sideInnerEl.appendChild(banner);
  }
  if (!appendWatchSideSection(sideInnerEl)) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = "Live feedback is off.";
    sideInnerEl.appendChild(empty);
  }
  sideInnerEl.scrollTop = sideInnerEl.scrollHeight;
  reportHeight();
}

function renderSidePanel() {
  if (sidePanelView === "watch") {
    renderWatchSidePanel();
    return;
  }
  const data = buildSideData();
  sideInnerEl.innerHTML = "";
  const views =
    sidePanelView === "all"
      ? ["watch", "sources", "tasks", "followups", "notes"]
      : [sidePanelView];
  let added = false;
  for (const view of views) {
    switch (view) {
      case "watch":
        added = appendWatchSideSection(sideInnerEl) || added;
        break;
      case "sources":
        added = appendSourcesSection(data, sideInnerEl) || added;
        break;
      case "tasks":
        added = appendTasksSection(data, sideInnerEl) || added;
        break;
      case "followups":
        added = appendFollowupsSection(data, sideInnerEl) || added;
        break;
      case "notes":
        added = appendNotesSection(data, sideInnerEl) || added;
        break;
      default:
        break;
    }
  }
  if (!added) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = "Nothing here yet.";
    sideInnerEl.appendChild(empty);
  }
  reportHeight();
}

function refreshSidePanelFromLiveNotes() {
  syncSidePickerState();
  if (sidePanelView) renderSidePanel();
}

// Build a labeled section with a vertical list of items.
function sideSection(title) {
  const sec = document.createElement("div");
  sec.className = "side-sec";
  const lab = document.createElement("div");
  lab.className = "side-title";
  lab.textContent = title;
  const list = document.createElement("div");
  list.className = "side-list";
  sec.append(lab, list);
  return { sec, list };
}

function sourceCard(link) {
  let host = "";
  try {
    host = new URL(link.url).hostname.replace(/^www\./, "");
  } catch (_) {
    host = "";
  }
  const a = document.createElement("button");
  a.className = "suggest-link";
  a.type = "button";
  a.title = link.url;

  const fav = document.createElement("span");
  fav.className = "suggest-fav";
  if (host) {
    const img = document.createElement("img");
    img.className = "suggest-fav-img";
    img.loading = "lazy";
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    img.addEventListener("error", () => {
      fav.classList.add("fallback");
      fav.innerHTML = LINK_ICON_SVG;
    });
    fav.appendChild(img);
  } else {
    fav.classList.add("fallback");
    fav.innerHTML = LINK_ICON_SVG;
  }

  const txt = document.createElement("span");
  txt.className = "suggest-link-col";
  const title = document.createElement("span");
  title.className = "suggest-link-title";
  title.textContent = link.title || host || link.url;
  const dom = document.createElement("span");
  dom.className = "suggest-link-domain";
  dom.textContent = host;
  txt.append(title, dom);

  a.append(fav, txt);
  a.addEventListener("click", () => window.lyknOverlay.openUrl(link.url));
  return a;
}

function optionButton(label, iconSvg, onClick) {
  const b = document.createElement("button");
  b.className = "suggest-chip";
  b.type = "button";
  const span = document.createElement("span");
  span.textContent = label;
  const ico = document.createElement("span");
  ico.className = "suggest-chip-ico";
  ico.innerHTML = iconSvg;
  b.append(span, ico);
  b.addEventListener("click", onClick);
  return b;
}

// After an answer, cache panel data; the user picks a view from the dropdown.
async function requestSuggestions(question, answer) {
  if (!answer || answer.trim().length < 20) return;
  let data = null;
  try {
    data = await window.lyknOverlay.suggest(question, answer);
  } catch (_) {
    data = null;
  }
  const links = (data && Array.isArray(data.links) ? data.links : []).filter((l) => l && l.url);
  const followups = (data && Array.isArray(data.followups) ? data.followups : []).filter(Boolean);

  lastAnswerText = answer;
  sideContext = {
    pageSource: currentPageSource && currentPageSource.url ? currentPageSource : null,
    links,
    followups,
  };

  syncSidePickerState();
  if (sidePanelView && sidePanelView !== "watch") renderSidePanel();
}

// Widths must match the main process constants (OVERLAY_WIDTH / side widths).
const CHAT_WIDTH = 520;
const SIDE_WIDTH = 300;
const WATCH_SIDE_WIDTH = 360;
const LIVE_WATCH_MIN_HEIGHT = 440;
const LIVE_WATCH_THREAD_MAX = 320;
let lastReportedHeight = -1;
let lastReportedWidth = -1;

function sidePanelWidth() {
  const side = document.getElementById("side");
  if (!side || !side.classList.contains("show")) return 0;
  if (liveWatchEnabled && sidePanelView === "watch") return WATCH_SIDE_WIDTH;
  return SIDE_WIDTH;
}

function applyLiveWatchLayout(on) {
  const shell = document.getElementById("shell");
  if (shell) shell.classList.toggle("live-watch-mode", !!on);
  lastReportedHeight = -1;
  lastReportedWidth = -1;
  if (on) {
    if (sidePanelView !== "watch") setSidePanelView("watch");
    else {
      renderWatchSidePanel();
      showSide(true);
    }
    requestAnimationFrame(() => {
      window.lyknOverlay.resize(CHAT_WIDTH + WATCH_SIDE_WIDTH, LIVE_WATCH_MIN_HEIGHT);
      reportHeight();
    });
  } else {
    reportHeight();
  }
}

function reportHeight() {
  // Measure the EXACT content size after layout settles, and only tell main to
  // resize when it actually changed — so the panel grows/shrinks only when needed
  // instead of creeping on every keystroke or delta.
  requestAnimationFrame(() => {
    const bar = document.querySelector(".composer");
    const title = document.querySelector(".titlebar");
    const att = document.getElementById("attachments");
    const attH = att && att.classList.contains("show") ? att.offsetHeight : 0;
    const threadMax = liveWatchEnabled ? LIVE_WATCH_THREAD_MAX : 420;
    const threadH = threadEl.classList.contains("show")
      ? Math.min(threadEl.scrollHeight + 1, threadMax)
      : 0;
    const live = document.getElementById("live");
    const liveH = live && live.classList.contains("show") ? live.offsetHeight : 0;
    let chatH = title.offsetHeight + threadH + liveH + attH + bar.offsetHeight + 2;
    if (liveWatchEnabled) chatH = Math.max(chatH, LIVE_WATCH_MIN_HEIGHT);

    const sideW = sidePanelWidth();
    let w = CHAT_WIDTH + sideW;
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

// Start a new turn: collapse every prior turn, append an expanded item for this
// question, and return its answer element to stream into.
function startTurn(question) {
  // A new question is pending — reset sources side data but keep live watch panel open.
  currentPageSource = null;
  resetSideForNewTurn();
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
  currentChatEl = item;
  currentQuestion = question || "";
  currentHasText = false;
  setThinkingStatus("Thinking…");

  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
  return a;
}

function renderHistoricTurn(question, answer, collapsed) {
  const item = document.createElement("div");
  item.className = "chat" + (collapsed ? " collapsed" : "");

  const q = document.createElement("button");
  q.className = "chat-q";
  q.type = "button";
  q.innerHTML = CHEVRON_SVG;
  const qt = document.createElement("span");
  qt.className = "q-text";
  qt.textContent = question;
  q.appendChild(qt);

  const a = document.createElement("div");
  a.className = "chat-a has-md";
  a.innerHTML = renderMarkdown(answer || "");

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
  askEl.focus();
}

async function startNewOverlayChat() {
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
  liveNotesSnapshot = { keyPoints: [], actionItems: [], summary: "" };
  clearSide();
  setHistoryOpen(false);
  askEl.focus();
  reportHeight();
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
  currentAnswerEl.classList.add("has-md");
  currentAnswerEl.innerHTML = renderMarkdown(trimmed);
  threadEl.scrollTop = threadEl.scrollHeight;
  reportHeight();
}

const DEFAULT_ASK_PLACEHOLDER = "Ask LYKN about your screen…";
let browserActArmed = false;
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
  if (code === "new_tab") {
    return (
      plan?.message ||
      "Navigate to a real website first (e.g. youtube.com) — blank new-tab pages can't be controlled."
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
  askEl.placeholder = DEFAULT_ASK_PLACEHOLDER;
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
          "\n\n⚠️ This is a significant action — **click Run to confirm**, or refine your request.",
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
    updateAnswer("No planned steps to run — try Control this page again.");
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
      ? result?.message || result?.explanation || "Done — completed the task in your browser."
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
async function saveBrowserTaskToVault({ intent, summary, result, pageUrl }) {
  if (typeof window.lyknOverlay.saveVaultNote !== "function") return;
  try {
    const steps = Array.isArray(result?.results)
      ? result.results
          .filter((r) => r && (r.label || r.type))
          .map((r) => `- ${r.ok ? "✓" : "✗"} ${String(r.label || r.type).slice(0, 120)}`)
      : [];
    const content = [
      `Task: ${intent}`,
      "",
      summary,
      steps.length ? `\nSteps:\n${steps.join("\n")}` : "",
      pageUrl ? `\nPage: ${pageUrl}` : "",
      `\nCompleted: ${new Date().toLocaleString()}`,
    ]
      .filter(Boolean)
      .join("\n");
    const saved = await window.lyknOverlay.saveVaultNote({
      title: `Browser task: ${intent}`.slice(0, 120),
      content,
      tags: ["lykn-overlay", "browser-task"],
    });
    if (saved?.ok) {
      updateAnswer(`${summary}\n\n_Saved a summary to your vault._`);
    }
  } catch (_) {
    /* vault save is best-effort */
  }
}

// Heuristic: does this message ask LYKN to save/screenshot something on screen?
// "save the image of the dune buggy", "screenshot the chart", "save that part of
// my screen", "can you grab a picture of this", etc. We bail only on clearly
// informational questions ("how do I save a screenshot?") so those reach chat.
function looksLikeSaveScreen(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  // Informational "how/what/why…" questions — let those go to normal chat.
  if (/^(how|what|why|where|when|who|which)\b/.test(t)) return false;
  // Must express a capture/save action.
  const hasAction = /\b(save|screenshot|screen ?shot|screen ?grab|capture|grab|snip|clip|take)\b/.test(t);
  if (!hasAction) return false;
  // Any screen/screenshot wording → definitely this flow.
  if (/\b(screenshot|screen ?shot|screen ?grab|on(-| )?screen|my screen|the screen|this screen)\b/.test(t))
    return true;
  // A visual noun being saved → it's on screen ("save the image/picture/chart…").
  if (/\b(image|picture|photo|pic|screenshot|graphic|logo|diagram|chart|icon|thumbnail|gif|meme)\b/.test(t))
    return true;
  // Bare "save this / that part / that region" inside the screen-centric overlay.
  if (/\bsave (this|that)\b/.test(t)) return true;
  if (/\b(this|that)\b[\s\S]*\b(part|region|area|section|portion)\b/.test(t)) return true;
  return false;
}

// Capture + AI-crop + save flow, rendered as its own turn in the thread.
async function runSaveScreen(q) {
  setBusy(true);
  startTurn(q || "Save my screen");
  setThinkingStatus("Capturing your screen…");
  history.push({ role: "user", content: q, at: new Date().toISOString() });
  let msg;
  try {
    const res = await window.lyknOverlay.saveScreenRegion(q);
    if (res && res.ok) {
      const what = res.full ? "your full screen" : "that part of your screen";
      const places = [];
      if (res.savedToVault) places.push("your **Vault**");
      if (res.fileName) places.push(`**Downloads** (\`${res.fileName}\`)`);
      places.push("your clipboard");
      // Join with commas + "and" before the last destination.
      const dest =
        places.length > 1
          ? `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}`
          : places[0];
      msg = `Saved ${what} to ${dest}.`;
    } else if (res && res.error === "no_permission") {
      msg =
        "LYKN needs Screen Recording permission to do that. Enable it in System Settings → Privacy & Security → Screen Recording, then try again.";
    } else {
      msg = `Couldn't save the screen${res && res.error ? ` (${res.error})` : ""}. Try again in a moment.`;
    }
  } catch (_) {
    msg = "Couldn't save the screen. Try again in a moment.";
  }
  updateAnswer(msg);
  history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
  void persistCurrentSession();
  setBusy(false);
  askEl.focus();
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
          : "Couldn't add that watch rule — try rephrasing.";
      updateAnswer(msg);
      history.push({ role: "assistant", content: msg, at: new Date().toISOString() });
      setBusy(false);
      askEl.focus();
      return;
    }
    const rule = res.rule || q;
    if (Array.isArray(res.rules)) watchActiveRules = res.rules.slice();
    const msg = `Got it — I'll alert you when **${rule}**.`;
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
  const q = askEl.value.trim();
  if (browserActArmed) {
    if (!q || busy || executingBrowser) return;
    void runBrowserAct(q);
    return;
  }
  if ((!q && attachments.length === 0) || busy) return;
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
  // "Save that part of my screen" → capture + AI-crop + save, no round-trip ask.
  if (q && attachments.length === 0 && looksLikeSaveScreen(q)) {
    askEl.value = "";
    askEl.style.height = "52px";
    void runSaveScreen(q);
    return;
  }
  askEl.value = "";
  askEl.style.height = "52px";
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
  // Markdown links in answers open in the default browser, never in the overlay.
  const link = e.target.closest("a[href]");
  if (link) {
    e.preventDefault();
    window.lyknOverlay.openUrl(link.getAttribute("href"));
    return;
  }
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
    void persistCurrentSession();
    // Populate the left panel with sources, follow-ups, and options.
    void requestSuggestions(currentQuestion, finalText);
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
// LYKN scraped the page the user is viewing — remember it so requestSuggestions
// can show it as a source (visible proof the scrape happened).
window.lyknOverlay.onPageSource((p) => {
  if (p && p.url) currentPageSource = { url: p.url, title: p.title || "" };
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
  if (e.target.closest(".bar-btn")) return;
  if (e.target.closest(".side-picker-btn")) return;
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

// The bubble can be dragged to reposition, or clicked (no drag) to expand.
let bubbleDragging = false;
let bubbleMoved = false;
let bubbleLastX = 0;
let bubbleLastY = 0;
bubbleEl.addEventListener("pointerdown", (e) => {
  bubbleDragging = true;
  bubbleMoved = false;
  bubbleLastX = e.screenX;
  bubbleLastY = e.screenY;
  try { bubbleEl.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});
bubbleEl.addEventListener("pointermove", (e) => {
  if (!bubbleDragging) return;
  const dx = e.screenX - bubbleLastX;
  const dy = e.screenY - bubbleLastY;
  if (Math.abs(dx) + Math.abs(dy) > 2) {
    bubbleMoved = true;
    bubbleLastX = e.screenX;
    bubbleLastY = e.screenY;
    window.lyknOverlay.moveBy(dx, dy);
  }
});
const endBubble = (e) => {
  if (!bubbleDragging) return;
  bubbleDragging = false;
  try { bubbleEl.releasePointerCapture(e.pointerId); } catch (_) {}
  if (!bubbleMoved) expandOverlay();
};
bubbleEl.addEventListener("pointerup", endBubble);
bubbleEl.addEventListener("pointercancel", endBubble);

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

// ── "More" inline drawer (inside composer) ─────────────────────────────────
const composerEl = document.getElementById("composer");
const moreBtn = document.getElementById("more");
const menuEl = document.getElementById("menu");
const historyPanelEl = document.getElementById("history-panel");
const historyListEl = document.getElementById("history-list");
let historyOpen = false;
let moreUserOpen = false;

function setMenuOpen(open) {
  moreUserOpen = open;
  moreBtn.classList.toggle("active", open);
  composerEl.classList.toggle("more-open", open);
  if (open) setPanelPickerOpen(false);
  if (!open) {
    historyOpen = false;
    historyPanelEl.classList.remove("show");
    menuEl.style.display = "";
  }
  reportHeight();
}

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

document.getElementById("menu-attach").addEventListener("click", async () => {
  setMenuOpen(false);
  await openFilePicker();
});

document.getElementById("menu-snip").addEventListener("click", async () => {
  setMenuOpen(false);
  await snipFromScreen();
});

// Toolbar attach button — the reliable way to add files to the bar. (macOS
// blocks OS file drops onto this non-activating panel window, so the picker is
// the dependable path; drag-and-drop still works where the OS allows it.)
const attachBtn = document.getElementById("attach");
if (attachBtn) attachBtn.addEventListener("click", () => void openFilePicker());

// Toolbar snip button — capture a screen region straight into the bar.
const snipBtn = document.getElementById("snip");
if (snipBtn) snipBtn.addEventListener("click", () => void snipFromScreen());

document.getElementById("menu-browser-act").addEventListener("click", () => {
  setMenuOpen(false);
  const q = askEl.value.trim();
  if (q) {
    void runBrowserAct(q);
    return;
  }
  browserActArmed = true;
  askEl.placeholder = "Describe what to do on this page, then Send…";
  askEl.focus();
});

browserActCancelEl.addEventListener("click", () => hideBrowserActPanel());
browserActRunEl.addEventListener("click", () => {
  if (executingBrowser || busy) return;
  void executeBrowserAct();
});

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
  const shell = document.getElementById("shell");
  if (shell) shell.classList.remove("live-watch-mode");
  if (sidePanelView === "watch") {
    sidePanelView = "";
    showSide(false);
    updateSidePickerLabel();
  }
  lastReportedHeight = -1;
  lastReportedWidth = -1;
  reportHeight();
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
        askEl.placeholder = "Enable Screen Recording in System Settings first";
        setTimeout(() => {
          if (askEl.placeholder === "Enable Screen Recording in System Settings first") {
            askEl.placeholder = DEFAULT_PLACEHOLDER;
          }
        }, 4000);
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
  // Only needs the session token — we deliberately allow pushes during connect
  // so a fresh screen is already in the server grounding by the user's 1st turn.
  if (!voiceSessionToken) return;
  if (screenPushInFlight) return;
  const now = Date.now();
  // Live Watch already maintains a rolling summary — push more often (2s) since
  // main reuses it instead of running a fresh vision call each time.
  const minGap = liveWatchEnabled ? 2000 : 4000;
  if (!force && now - lastScreenPushAt < minGap) return;
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
  const voiceLabel = document.getElementById("voice-label");
  if (voiceLabel) voiceLabel.textContent = on ? "Stop voice mode" : "Voice mode";
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
  void persistCurrentSession();
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
  // Kick off the first screen push NOW (in parallel with the WebSocket connect +
  // the agent greeting) so the description — which takes ~2-3s — is already in
  // the server grounding by the time the user asks their first question.
  void pushScreenContext(true);

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
      if (m.source === "user") {
        voiceUserMessage(text);
        // Keep the server's screen grounding fresh for the next turn (throttled).
        void pushScreenContext(false);
      } else if (m.source === "ai") {
        voiceAiMessage(text);
      }
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

// ── Live listen: capture system (meeting) audio → rolling transcript ────────
// Uses getDisplayMedia with loopback audio (ScreenCaptureKit on macOS 13+, wired
// up in main via setDisplayMediaRequestHandler). We record short back-to-back
// clips and transcribe each with Whisper so a live transcript builds up.
const listenEl = document.getElementById("listen");
const liveEl = document.getElementById("live");
const liveBodyEl = document.getElementById("live-body");
const liveDotEl = document.getElementById("live-dot");
const liveTitleEl = document.getElementById("live-title");
const liveCloseEl = document.getElementById("live-close");
const notesSummaryEl = document.getElementById("notes-summary");
const notesKeyWrapEl = document.getElementById("notes-key-wrap");
const notesKeyEl = document.getElementById("notes-key");
const notesActionsWrapEl = document.getElementById("notes-actions-wrap");
const notesActionsEl = document.getElementById("notes-actions");
let listening = false;
let listenDisplayStream = null; // full getDisplayMedia stream (we keep it to stop tracks)
let listenSysStream = null; // loopback audio only = "Them" (the video/other person)
let listenMicStream = null; // microphone = "You" (the user)
let listenRecorders = []; // active per-source MediaRecorders
let listenQueue = Promise.resolve();
// Separate rolling context per speaker so cleanup never bleeds one into the other.
const listenTails = { them: "", you: "" };
// Full speaker-labeled transcript, fed to the meeting-notes summarizer.
let transcriptText = "";
let notesTimer = null;
let notesInFlight = false;
let lastNotesLen = 0;
const LISTEN_CHUNK_MS = 6000;
const NOTES_INTERVAL_MS = 25000;
const SPEAKER_LABEL = { them: "Them", you: "You" };

function setListenUi() {
  listenEl.classList.toggle("listening", listening);
  listenEl.title = listening ? "Stop listening" : "Live meeting notes";
  const listenLabel = document.getElementById("listen-label");
  if (listenLabel) listenLabel.textContent = listening ? "Stop live notes" : "Live meeting notes";
  liveDotEl.classList.toggle("live", listening);
  liveTitleEl.textContent = listening ? "Listening…" : "Stopped";
  reportHeight();
}

function switchLivePane(pane) {
  document.getElementById("tab-notes").classList.toggle("active", pane === "notes");
  document.getElementById("tab-transcript").classList.toggle("active", pane === "transcript");
  document.getElementById("pane-notes").hidden = pane !== "notes";
  document.getElementById("pane-transcript").hidden = pane !== "transcript";
  reportHeight();
}

function renderNotes(notes) {
  if (!notes) return;
  notesSummaryEl.textContent = String(notes.summary || "");
  const fill = (listEl, wrapEl, items) => {
    listEl.innerHTML = "";
    const arr = Array.isArray(items) ? items.filter(Boolean) : [];
    for (const it of arr) {
      const li = document.createElement("li");
      li.textContent = String(it);
      listEl.appendChild(li);
    }
    wrapEl.hidden = arr.length === 0;
  };
  fill(notesKeyEl, notesKeyWrapEl, notes.keyPoints);
  fill(notesActionsEl, notesActionsWrapEl, notes.actionItems);
  liveNotesSnapshot = {
    keyPoints: Array.isArray(notes.keyPoints) ? notes.keyPoints.filter(Boolean) : [],
    actionItems: Array.isArray(notes.actionItems) ? notes.actionItems.filter(Boolean) : [],
    summary: String(notes.summary || "").trim(),
  };
  refreshSidePanelFromLiveNotes();
  reportHeight();
}

// Pull fresh meeting notes from the transcript (throttled; skips if nothing new
// was said since the last pull). Best-effort — failures leave existing notes.
async function refreshNotes() {
  if (notesInFlight) return;
  const txt = transcriptText.trim();
  if (txt.length < 40 || txt.length === lastNotesLen) return;
  notesInFlight = true;
  lastNotesLen = txt.length;
  try {
    const notes = await window.lyknOverlay.meetingNotes(txt);
    if (notes && (notes.summary || notes.keyPoints?.length || notes.actionItems?.length)) {
      renderNotes(notes);
    }
  } catch (_) {}
  notesInFlight = false;
}

// Append cleaned text under a speaker. Consecutive lines from the same speaker
// merge into one block so the transcript reads as a conversation.
function appendLiveText(speaker, text) {
  const t = String(text || "").trim();
  if (!t) return;
  const last = liveBodyEl.lastElementChild;
  if (last && last.dataset.speaker === speaker) {
    const body = last.querySelector(".live-text");
    body.textContent = `${body.textContent} ${t}`;
  } else {
    const line = document.createElement("div");
    line.className = `live-line ${speaker}`;
    line.dataset.speaker = speaker;
    const lab = document.createElement("span");
    lab.className = "live-speaker";
    lab.textContent = SPEAKER_LABEL[speaker] || speaker;
    const body = document.createElement("span");
    body.className = "live-text";
    body.textContent = t;
    line.append(lab, body);
    liveBodyEl.appendChild(line);
  }
  listenTails[speaker] = `${listenTails[speaker] ? `${listenTails[speaker]} ` : ""}${t}`
    .split(/\s+/)
    .slice(-30)
    .join(" ");
  transcriptText += `${SPEAKER_LABEL[speaker] || speaker}: ${t}\n`;
  liveBodyEl.scrollTop = liveBodyEl.scrollHeight;
  reportHeight();
}

// Transcribe one chunk for a given speaker, drop it if it's silence/noise, then
// run a Wispr-Flow-style cleanup pass before showing it. Fails open to raw text.
async function processListenChunk(buf, speaker) {
  if (!listening) return;
  let raw = "";
  let noSpeech = 0;
  try {
    const r = await window.lyknOverlay.transcribe(buf, RECORD_MIME, listenTails[speaker]);
    raw = r && r.text ? r.text.trim() : "";
    noSpeech = r && typeof r.noSpeech === "number" ? r.noSpeech : 0;
  } catch (_) {}
  // High no-speech probability = silence; Whisper tends to hallucinate ("Thank
  // you.", "Bye.") on quiet clips, so skip those outright.
  if (!raw || noSpeech > 0.7 || !listening) return;
  let clean = raw;
  try {
    const c = await window.lyknOverlay.cleanTranscript(raw, listenTails[speaker]);
    if (c && typeof c.text === "string") clean = c.text.trim();
  } catch (_) {}
  if (clean) appendLiveText(speaker, clean);
}

// Record one short clip from a source stream, then loop. Each source (system
// audio = "them", mic = "you") runs its own independent loop.
function recordSourceChunk(stream, speaker) {
  if (!listening || !stream) return;
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: RECORD_MIME });
  } catch (_) {
    return;
  }
  listenRecorders.push(rec);
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = async () => {
    listenRecorders = listenRecorders.filter((r) => r !== rec);
    // Start the next clip immediately so capture stays continuous.
    if (listening) recordSourceChunk(stream, speaker);
    const blob = new Blob(chunks, { type: RECORD_MIME });
    if (blob.size < 2000) return;
    let buf;
    try {
      buf = await blob.arrayBuffer();
    } catch (_) {
      return;
    }
    // Single shared queue keeps both speakers' lines in completion order.
    listenQueue = listenQueue.then(() => processListenChunk(buf, speaker)).catch(() => {});
  };
  try {
    rec.start();
  } catch (_) {
    return;
  }
  setTimeout(() => {
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch (_) {}
  }, LISTEN_CHUNK_MS);
}

async function startListen() {
  if (listening) return;
  // 1) System (loopback) audio = the video / person on the other end ("Them").
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (_) {
    startTurn("Live notes");
    currentHasText = true;
    currentAnswerEl.textContent =
      "LYKN needs Screen Recording permission to capture audio. Enable it in System Settings → Privacy & Security → Screen Recording, then try again.";
    reportHeight();
    return;
  }
  const sysTracks = display.getAudioTracks();
  if (!sysTracks.length) {
    try { display.getTracks().forEach((t) => t.stop()); } catch (_) {}
    startTurn("Live notes");
    currentHasText = true;
    currentAnswerEl.textContent =
      "Couldn't capture system audio. This needs macOS 13 (Ventura) or newer.";
    reportHeight();
    return;
  }
  // 2) Microphone = the user ("You"). Best-effort: if mic is denied we still
  // capture the other side. Echo cancellation keeps the speakers' audio from
  // bleeding into the mic and being double-counted as "You".
  let micStream = null;
  try {
    const ok = await window.lyknOverlay.ensureMic();
    if (ok) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
  } catch (_) {
    micStream = null;
  }

  listenDisplayStream = display;
  listenSysStream = new MediaStream(sysTracks);
  listenMicStream = micStream;
  listenTails.them = "";
  listenTails.you = "";
  listenQueue = Promise.resolve();
  transcriptText = "";
  lastNotesLen = 0;
  liveBodyEl.innerHTML = "";
  notesSummaryEl.textContent = "";
  notesKeyEl.innerHTML = "";
  notesActionsEl.innerHTML = "";
  notesKeyWrapEl.hidden = true;
  notesActionsWrapEl.hidden = true;
  listening = true;
  liveEl.classList.add("show");
  switchLivePane("notes");
  setListenUi();
  // Build notes on a steady cadence while listening, plus an earlier first pass
  // so the user sees something well before the full interval elapses.
  if (notesTimer) clearInterval(notesTimer);
  notesTimer = setInterval(() => void refreshNotes(), NOTES_INTERVAL_MS);
  setTimeout(() => {
    if (listening) void refreshNotes();
  }, 12000);
  // If the OS ends the capture (or the user revokes it), stop cleanly.
  sysTracks[0].addEventListener("ended", () => {
    if (listening) stopListen();
  });
  recordSourceChunk(listenSysStream, "them");
  if (listenMicStream) recordSourceChunk(listenMicStream, "you");
}

function stopListen() {
  listening = false;
  if (notesTimer) {
    clearInterval(notesTimer);
    notesTimer = null;
  }
  for (const r of listenRecorders) {
    try {
      if (r.state !== "inactive") r.stop();
    } catch (_) {}
  }
  listenRecorders = [];
  try {
    listenDisplayStream && listenDisplayStream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  try {
    listenMicStream && listenMicStream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  listenDisplayStream = null;
  listenSysStream = null;
  listenMicStream = null;
  setListenUi();
  // One last notes pass so the final words make it in. The panel stays open so
  // the user can review the notes after the meeting ends.
  void refreshNotes();
}

function closeLive() {
  if (listening) stopListen();
  liveEl.classList.remove("show");
  reportHeight();
}

listenEl.addEventListener("click", () => {
  if (listening) stopListen();
  else void startListen();
});
liveCloseEl.addEventListener("click", closeLive);
document.getElementById("tab-notes").addEventListener("click", () => switchLivePane("notes"));
document.getElementById("tab-transcript").addEventListener("click", () => switchLivePane("transcript"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && listening) {
    e.preventDefault();
    stopListen();
  }
});

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
  } else if (e.key === "Escape") {
    window.lyknOverlay.hide();
  }
});

askEl.focus();
syncSidePickerState();
reportHeight();

void (async () => {
  try {
    const res = await window.lyknOverlay.ensureOverlaySession();
    if (res && res.sessionId) currentSessionId = res.sessionId;
  } catch (_) {}
})();
