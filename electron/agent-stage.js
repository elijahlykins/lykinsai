const tabsEl = document.getElementById("tabs");
const urlEl = document.getElementById("url");
const emptyEl = document.getElementById("empty");
const toastEl = document.getElementById("toast");
const incognitoBtn = document.getElementById("incognito");
const starBtn = document.getElementById("star");
const savedBtn = document.getElementById("saved-btn");
const savedMenu = document.getElementById("saved-menu");
const syncBtn = document.getElementById("sync-btn");
const syncMenu = document.getElementById("sync-menu");

let state = {
  tabs: [],
  activeAgentId: null,
  url: "",
  title: "",
  incognito: false,
  bookmarks: [],
  bookmarked: false,
};
let toastTimer = null;
let toastAgentId = "";
let savedMenuOpen = false;
let syncMenuOpen = false;
let syncLoaded = false;

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function canStarUrl(url) {
  const u = String(url || "").trim();
  if (!u) return false;
  if (/^(about:|lykn:|lykn-artifact:|data:|chrome:|devtools:)/i.test(u)) return false;
  try {
    const parsed = new URL(u);
    return /^https?:$/i.test(parsed.protocol);
  } catch {
    return false;
  }
}

function applyTheme(incognito) {
  const on = !!incognito;
  document.documentElement.setAttribute("data-theme", on ? "incognito" : "light");
  // Stamp is CSS-debossed (fill = page color); theme vars swap highlight/shadow.
  if (incognitoBtn) {
    incognitoBtn.classList.toggle("active", on);
    incognitoBtn.setAttribute("aria-pressed", on ? "true" : "false");
    incognitoBtn.title = on
      ? "Exit incognito — back to shared signed-in browser"
      : "Incognito (dark, private — won't keep site logins)";
  }
}

function renderStar() {
  if (!starBtn) return;
  const ok = canStarUrl(state.url);
  starBtn.disabled = !ok;
  const saved = !!(ok && state.bookmarked);
  starBtn.classList.toggle("saved", saved);
  starBtn.setAttribute("aria-pressed", saved ? "true" : "false");
  starBtn.title = !ok
    ? "Open a page to save it"
    : saved
      ? "Saved — LYKN can open this with “open …”"
      : "Save link — LYKN can pull this up faster";
}

function renderSavedMenu() {
  if (!savedMenu) return;
  const items = Array.isArray(state.bookmarks) ? state.bookmarks : [];
  if (!items.length) {
    savedMenu.innerHTML = `
      <div class="saved-head"><span>Saved</span></div>
      <div class="saved-empty">Star a page to save it here.<br/>Then say “open …” and LYKN will pull it up.</div>
    `;
    return;
  }
  savedMenu.innerHTML =
    `<div class="saved-head"><span>Saved</span><span>${items.length}</span></div>` +
    items
      .map((it) => {
        const name = it.name || it.title || hostLabel(it.url) || "Saved link";
        const host = hostLabel(it.url) || it.url || "";
        return `<div class="saved-item" role="menuitem" data-open="${escapeHtml(it.url)}" title="${escapeHtml(it.url)}">
          <div class="meta">
            <div class="name">${escapeHtml(name)}</div>
            <div class="host">${escapeHtml(host)}</div>
          </div>
          <button type="button" class="saved-star" data-remove="${escapeHtml(it.id)}" title="Remove saved link" aria-label="Remove saved link">
            <svg viewBox="0 0 24 24" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
              <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.2 1 5.8L12 16.8 6.8 19.7l1-5.8L3.5 9.7l5.9-.9L12 3.5z"/>
            </svg>
          </button>
        </div>`;
      })
      .join("");
}

// Any open dropdown lives inside this chrome document, which sits BEHIND the
// native page view — so main.cjs must raise/expand the chrome over the page
// and go transparent around the menu. Keep that in sync with either menu.
function updateMenuOverlay() {
  const anyOpen = savedMenuOpen || syncMenuOpen;
  document.documentElement.classList.toggle("menu-overlay", anyOpen);
  window.lyknAgentStage.setMenuOverlay?.(anyOpen);
}

function setSavedMenuOpen(open) {
  savedMenuOpen = !!open;
  if (savedMenu) savedMenu.hidden = !savedMenuOpen;
  if (savedBtn) {
    savedBtn.classList.toggle("active", savedMenuOpen);
    savedBtn.setAttribute("aria-expanded", savedMenuOpen ? "true" : "false");
  }
  if (savedMenuOpen) setSyncMenuOpen(false);
  updateMenuOverlay();
  if (savedMenuOpen) renderSavedMenu();
}

function setSyncMenuOpen(open) {
  syncMenuOpen = !!open;
  if (syncMenu) syncMenu.hidden = !syncMenuOpen;
  if (syncBtn) {
    syncBtn.classList.toggle("active", syncMenuOpen);
    syncBtn.setAttribute("aria-expanded", syncMenuOpen ? "true" : "false");
  }
  if (syncMenuOpen) {
    savedMenuOpen = false;
    if (savedMenu) savedMenu.hidden = true;
    if (savedBtn) savedBtn.classList.remove("active");
    void loadSyncProfiles();
  }
  updateMenuOverlay();
}

async function loadSyncProfiles() {
  if (syncLoaded) return;
  const select = document.getElementById("sync-profile");
  const runBtn = document.getElementById("sync-run");
  if (!select) return;
  select.innerHTML = "<option>Loading…</option>";
  try {
    const res = await window.lyknAgentStage.chromeSyncStatus?.();
    if (!res?.supported) {
      select.innerHTML = "<option>Not available on this OS</option>";
      if (runBtn) runBtn.disabled = true;
      return;
    }
    const opts = [];
    for (const b of res.browsers || []) {
      for (const p of b.profiles || []) {
        opts.push({ value: `${b.id}::${p.dir}`, label: `${b.name} — ${p.name}` });
      }
    }
    if (!opts.length) {
      select.innerHTML = "<option>No Chrome profiles found</option>";
      if (runBtn) runBtn.disabled = true;
      return;
    }
    select.innerHTML = opts
      .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
      .join("");
    if (runBtn) runBtn.disabled = false;
    syncLoaded = true;
  } catch {
    select.innerHTML = "<option>Couldn't read browsers</option>";
    if (runBtn) runBtn.disabled = true;
  }
}

function syncStatusText(msg, kind) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

const SYNC_WARN_TEXT = {
  keychain_denied: "Keychain access was denied — logins weren't imported.",
  automation_denied: "Allow LYKN to control your browser in System Settings › Privacy › Automation to import open tabs.",
  db_read_failed: "Couldn't read the cookie database.",
  cookie_read_failed: "Couldn't read logins.",
  tab_read_failed: "Couldn't read open tabs (is the browser running?).",
  history_read_failed: "Couldn't read your history.",
  history_empty: "No history found to learn from.",
  cookies_kept_existing_login:
    "Some logins couldn't be read safely — your existing sign-ins were kept as they are.",
};

function humaniseSyncWarning(w) {
  const key = String(w || "").split(":")[0].trim();
  if (SYNC_WARN_TEXT[key]) return SYNC_WARN_TEXT[key];
  if (key.startsWith("tab_cap_")) return "Reached the 20-tab limit — some tabs weren't opened.";
  return "";
}

async function runSync() {
  const select = document.getElementById("sync-profile");
  const runBtn = document.getElementById("sync-run");
  const wantLogins = !!document.getElementById("sync-logins")?.checked;
  const wantTabs = !!document.getElementById("sync-tabs")?.checked;
  const wantHistory = !!document.getElementById("sync-history")?.checked;
  const val = select?.value || "";
  const [browserId, profileDir] = val.split("::");
  if (!browserId) return;
  if (!wantLogins && !wantTabs && !wantHistory) {
    syncStatusText("Pick at least one thing to import.", "error");
    return;
  }
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = "Syncing…";
  }
  syncStatusText("Approve any macOS prompts to continue…");
  try {
    const res = await window.lyknAgentStage.chromeSyncRun?.({
      browserId,
      profileDir,
      importCookies: wantLogins,
      importTabs: wantTabs,
      importHistory: wantHistory,
    });
    if (!res?.ok) {
      syncStatusText("Sync failed. Please try again.", "error");
    } else {
      const parts = [];
      if (wantLogins) parts.push(`${res.cookies?.imported || 0} logins`);
      if (wantTabs) parts.push(`${res.tabs?.opened || 0} tabs`);
      if (wantHistory && res.habits?.learned) parts.push("your habits");
      const warns = [...new Set((res.warnings || []).map(humaniseSyncWarning).filter(Boolean))];
      const done = parts.length ? "Imported " + parts.join(", ") + ". " : "";
      if (warns.length) {
        syncStatusText(`${done}${warns.join(" ")}`, parts.length ? "ok" : "error");
      } else {
        syncStatusText(`${done}You're all set.`, "ok");
      }
    }
  } catch {
    syncStatusText("Sync failed. Please try again.", "error");
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = "Sync now";
    }
  }
}

function renderTabs() {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  emptyEl.hidden = tabs.length > 0;
  const tabsHtml = tabs
    .map((t) => {
      const active = t.id === state.activeAgentId ? " active" : "";
      const isArtifact = t.kind === "artifact";
      const isSub = !!t.isSub;
      const label = isArtifact
        ? t.title || t.pageTitle || "Artifact"
        : t.pageTitle || hostLabel(t.url) || t.title || "Tab";
      const tip = isArtifact
        ? `${t.title || "Artifact"}${t.url ? ` — ${t.url}` : ""}`
        : t.url || t.title || "";
      const cls = `tab${active}${isArtifact ? " artifact" : ""}${isSub ? " subtab" : ""}`;
      return `<button type="button" class="${cls}" data-id="${escapeHtml(t.id)}" title="${escapeHtml(tip)}">
        <span class="tab-label">${escapeHtml(label)}</span>
        <span class="tab-x" data-close="${escapeHtml(t.id)}" title="Close tab" aria-label="Close tab">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </span>
      </button>`;
    })
    .join("");
  tabsEl.innerHTML =
    tabsHtml +
    `<button type="button" class="tab-new" id="new-tab" title="New agent chat" aria-label="New agent chat">+</button>`;
}

function applyState(p) {
  state = {
    tabs: Array.isArray(p.tabs) ? p.tabs : state.tabs,
    activeAgentId: p.activeAgentId != null ? p.activeAgentId : state.activeAgentId,
    url: typeof p.url === "string" ? p.url : state.url,
    title: typeof p.title === "string" ? p.title : state.title,
    incognito: typeof p.incognito === "boolean" ? p.incognito : state.incognito,
    bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : state.bookmarks,
    bookmarked: typeof p.bookmarked === "boolean" ? p.bookmarked : state.bookmarked,
  };
  if (typeof p.url === "string") urlEl.value = p.url;
  applyTheme(state.incognito);
  renderTabs();
  renderStar();
  if (savedMenuOpen) renderSavedMenu();
}

window.lyknAgentStage.onState((p) => applyState(p || {}));

function showToast(_p) {
  /* Finish notices use the floating glass chip in main — avoid duplicates. */
}

if (typeof window.lyknAgentStage.onToast === "function") {
  window.lyknAgentStage.onToast((p) => showToast(p || {}));
}

tabsEl.addEventListener("click", (e) => {
  const newTab = e.target.closest("#new-tab, .tab-new");
  if (newTab) {
    e.preventDefault();
    e.stopPropagation();
    void window.lyknAgentStage.newTab?.();
    return;
  }
  const close = e.target.closest("[data-close]");
  if (close) {
    e.preventDefault();
    e.stopPropagation();
    void window.lyknAgentStage.closeTab(close.getAttribute("data-close"));
    return;
  }
  const tab = e.target.closest(".tab");
  if (!tab) return;
  const id = tab.getAttribute("data-id");
  if (id) void window.lyknAgentStage.selectTab(id);
});

urlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void window.lyknAgentStage.navigate(urlEl.value.trim());
  }
});

// Chrome-style: focusing the omnibox selects the whole URL so the user can
// just type a search or new address over it.
urlEl.addEventListener("focus", () => {
  requestAnimationFrame(() => urlEl.select());
});

document.getElementById("back").addEventListener("click", () => void window.lyknAgentStage.back());
document
  .getElementById("forward")
  .addEventListener("click", () => void window.lyknAgentStage.forward());
document
  .getElementById("reload")
  .addEventListener("click", () => void window.lyknAgentStage.reload());

if (incognitoBtn) {
  incognitoBtn.addEventListener("click", () => {
    void window.lyknAgentStage.toggleIncognito?.();
  });
}

if (starBtn) {
  starBtn.addEventListener("click", async () => {
    if (starBtn.disabled) return;
    const res = await window.lyknAgentStage.toggleBookmark?.({
      url: state.url || urlEl.value.trim(),
      title: state.title || "",
    });
    if (res?.ok) {
      state.bookmarked = !!res.saved;
      state.bookmarks = Array.isArray(res.items) ? res.items : state.bookmarks;
      renderStar();
      if (savedMenuOpen) renderSavedMenu();
    }
  });
}

if (savedBtn && savedMenu) {
  savedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSavedMenuOpen(!savedMenuOpen);
  });
  savedMenu.addEventListener("click", async (e) => {
    const remove = e.target.closest("[data-remove]");
    if (remove) {
      e.preventDefault();
      e.stopPropagation();
      const id = remove.getAttribute("data-remove");
      const res = await window.lyknAgentStage.removeBookmark?.({ id });
      if (res?.ok) {
        state.bookmarks = Array.isArray(res.items) ? res.items : state.bookmarks;
        state.bookmarked = Array.isArray(state.bookmarks)
          ? state.bookmarks.some((it) => it.url === state.url)
          : state.bookmarked;
        renderStar();
        renderSavedMenu();
      }
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      e.preventDefault();
      const url = open.getAttribute("data-open");
      setSavedMenuOpen(false);
      if (url) void window.lyknAgentStage.navigate(url);
    }
  });
  document.addEventListener("click", (e) => {
    if (!savedMenuOpen) return;
    if (e.target.closest("#saved-menu") || e.target.closest("#saved-btn")) return;
    setSavedMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && savedMenuOpen) setSavedMenuOpen(false);
  });
}

if (syncBtn && syncMenu) {
  syncBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSyncMenuOpen(!syncMenuOpen);
  });
  document.getElementById("sync-run")?.addEventListener("click", () => void runSync());
  document.addEventListener("click", (e) => {
    if (!syncMenuOpen) return;
    if (e.target.closest("#sync-menu") || e.target.closest("#sync-btn")) return;
    setSyncMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && syncMenuOpen) setSyncMenuOpen(false);
  });
}

// Tell main the chrome height so BrowserViews sit under the tab strip.
function reportChrome() {
  const h = Math.ceil(
    (document.getElementById("tabs")?.offsetHeight || 0) +
      (document.getElementById("chrome")?.offsetHeight || 0),
  );
  window.lyknAgentStage.resizeChrome(h || 82);
}
window.addEventListener("resize", reportChrome);
applyTheme(false);
renderTabs();
renderStar();
requestAnimationFrame(reportChrome);
