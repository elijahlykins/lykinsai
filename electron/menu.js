// Renderer for the detached three-dot menu window. It's a thin remote control:
// every action is forwarded to the overlay renderer (which owns the real
// logic + state); this page only renders the list and the state badges.

const menuEl = document.getElementById("menu");
const historyListEl = document.getElementById("history-list");

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ── Sizing — tell main how tall the card wants to be ──────────────────── */

const HISTORY_HEIGHT = 400;

function reportSize() {
  const inHistory = document.body.classList.contains("history");
  // Card padding (6 top + 6 bottom) + 2px border around the content.
  const h = inHistory ? HISTORY_HEIGHT : menuEl.scrollHeight + 14;
  window.lyknMenu.resize(h);
}

/* ── State badges — mirrored from the overlay's (hidden) drawer DOM ─────── */

let currentSessionId = null;

async function refreshState() {
  let s;
  try {
    s = await window.lyknMenu.getState();
  } catch (_) {
    return;
  }
  if (!s) return;
  currentSessionId = s.currentSessionId || null;
  const voice = document.getElementById("mi-voice");
  voice.classList.toggle("voice-active", !!s.voiceActive);
  document.getElementById("voice-label").textContent = s.voiceLabel || "Voice mode";
  const listen = document.getElementById("mi-listen");
  listen.classList.toggle("listening", !!s.listening);
  document.getElementById("listen-label").textContent = s.listenLabel || "Live meeting notes";
  const watchState = document.getElementById("watch-state");
  watchState.textContent = s.watchState || (s.watchOn ? "On" : "Off");
  watchState.classList.toggle("on", !!s.watchOn);
  const stealthState = document.getElementById("stealth-state");
  stealthState.textContent = s.stealthState || (s.stealthOn ? "On" : "Off");
  stealthState.classList.toggle("on", !!s.stealthOn);
  const imageState = document.getElementById("image-gen-state");
  if (imageState) {
    imageState.textContent = s.imageModeOn ? "On" : "Off";
    imageState.classList.toggle("on", !!s.imageModeOn);
  }
  const buildState = document.getElementById("build-state");
  if (buildState) {
    buildState.textContent = s.buildModeOn ? "On" : "Off";
    buildState.classList.toggle("on", !!s.buildModeOn);
  }
}

/* ── Menu commands ──────────────────────────────────────────────────────── */

for (const btn of document.querySelectorAll(".menu-item[data-cmd]")) {
  btn.addEventListener("click", () => {
    window.lyknMenu.cmd(btn.dataset.cmd);
    if (btn.dataset.close) {
      window.lyknMenu.close();
    } else {
      // Toggle items (live watch, stealth) stay open so the badge flips in
      // place — the overlay needs a beat to apply the change.
      setTimeout(() => void refreshState(), 350);
      setTimeout(() => void refreshState(), 1200);
    }
  });
}

/* ── Past chats sub-view ────────────────────────────────────────────────── */

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

function historyBucket(time, now) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const start = startOfToday.getTime();
  const day = 86400000;
  if (time >= start) return "today";
  if (time >= start - day) return "yesterday";
  if (time >= start - 7 * day) return "last7";
  if (time >= start - 30 * day) return "last30";
  return "older";
}

function renderHistoryList(data) {
  historyListEl.innerHTML = "";
  const overlay = ((data && data.overlay) || []).map((i) => ({ ...i, source: "overlay" }));
  const app = ((data && data.app) || []).map((i) => ({ ...i, source: "app" }));
  const all = [...overlay, ...app].sort((a, b) => historyTime(b.updatedAt) - historyTime(a.updatedAt));

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
        window.lyknMenu.cmd("menu-open");
        window.lyknMenu.close();
      });
      sign.appendChild(openBtn);
      historyListEl.appendChild(sign);
    }
    return;
  }

  const now = Date.now();
  const buckets = new Map(HISTORY_TIME_GROUPS.map((g) => [g.key, []]));
  for (const item of all) buckets.get(historyBucket(historyTime(item.updatedAt), now)).push(item);

  for (const group of HISTORY_TIME_GROUPS) {
    const items = buckets.get(group.key);
    if (!items.length) continue;
    const g = document.createElement("div");
    g.className = "history-group";
    g.textContent = group.label;
    historyListEl.appendChild(g);
    for (const item of items) {
      const active = item.source === "overlay" && item.id === currentSessionId;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item" + (active ? " active" : "");
      btn.innerHTML =
        '<span class="hi-dot" aria-hidden="true"></span>' +
        `<span class="hi-title">${escapeHtml(item.title || "New Chat")}</span>`;
      btn.addEventListener("click", () => {
        if (item.source === "overlay") window.lyknMenu.cmd("open-overlay-session", item.id);
        else window.lyknMenu.openAppChat(item.id);
        window.lyknMenu.close();
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

function setHistoryView(open) {
  document.body.classList.toggle("history", open);
  reportSize();
}

document.getElementById("past-chats").addEventListener("click", async () => {
  setHistoryView(true);
  historyListEl.innerHTML = '<div class="history-empty">Loading…</div>';
  try {
    renderHistoryList(await window.lyknMenu.listChats());
  } catch (_) {
    historyListEl.innerHTML = '<div class="history-empty">Could not load chats.</div>';
  }
});

document.getElementById("history-back").addEventListener("click", () => setHistoryView(false));

document.getElementById("history-new").addEventListener("click", () => {
  window.lyknMenu.cmd("menu-new");
  window.lyknMenu.close();
});

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

// Every time main shows the window, reset to the top-level menu view with
// fresh state so it never reopens on a stale sub-view.
window.lyknMenu.onShown(() => {
  setHistoryView(false);
  void refreshState();
});

setHistoryView(false);
void refreshState();
