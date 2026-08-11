const tabsEl = document.getElementById("tabs");
const favsEl = document.getElementById("favs");
const favsScrollEl = document.getElementById("favs-scroll");
const favsMoreBtn = document.getElementById("favs-more");
const urlEl = document.getElementById("url");
const urlSuggestEl = document.getElementById("url-suggest");
const emptyEl = document.getElementById("empty");
const toastEl = document.getElementById("toast");
const useLyknBtn = document.getElementById("use-lykn");
const incognitoBtn = document.getElementById("incognito");
const syncBtn = document.getElementById("sync-btn");
const syncMenu = document.getElementById("sync-menu");

let state = {
  tabs: [],
  activeAgentId: null,
  url: "",
  title: "",
  incognito: false,
  chatOpen: false,
  recents: [],
};
let toastTimer = null;
let toastAgentId = "";
let syncMenuOpen = false;
let syncLoaded = false;
let historyItems = [];
let urlSuggestOpen = false;
let urlSuggestItems = [];
let urlSuggestIndex = -1;
let renderedTabIds = new Set();
let pendingNewTabAnimation = false;

const COMMON_SITES = [
  { name: "Google", url: "https://www.google.com/" },
  { name: "YouTube", url: "https://www.youtube.com/" },
  { name: "Gmail", url: "https://mail.google.com/" },
  { name: "Google Docs", url: "https://docs.google.com/" },
  { name: "Google Drive", url: "https://drive.google.com/" },
  { name: "Wikipedia", url: "https://www.wikipedia.org/" },
  { name: "GitHub", url: "https://github.com/" },
  { name: "X", url: "https://x.com/" },
  { name: "Reddit", url: "https://www.reddit.com/" },
  { name: "LinkedIn", url: "https://www.linkedin.com/" },
];

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

/** Product icons for Google hosts — S2 returns the same "G" for every *.google.com. */
const BRAND_ICON_BY_HOST = {
  "mail.google.com":
    "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  "calendar.google.com":
    "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  "drive.google.com":
    "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  "docs.google.com":
    "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "sheets.google.com":
    "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "slides.google.com":
    "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  "keep.google.com":
    "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
  "youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
  "music.youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
};

function brandIconFor(url) {
  const u = String(url || "");
  const host = hostLabel(u);
  if (!host) return "";
  if (host === "docs.google.com") {
    if (u.includes("/document/")) return BRAND_ICON_BY_HOST["docs.google.com"];
    if (u.includes("/spreadsheets/")) return BRAND_ICON_BY_HOST["sheets.google.com"];
    if (u.includes("/presentation/")) return BRAND_ICON_BY_HOST["slides.google.com"];
  }
  if (host === "google.com" && u.includes("/calendar/")) {
    return BRAND_ICON_BY_HOST["calendar.google.com"];
  }
  return BRAND_ICON_BY_HOST[host] || "";
}

function faviconUrlFor(url, explicit) {
  // Brand icons win over page/S2 favicons — otherwise Gmail/Docs/Drive all show the Google G.
  const brand = brandIconFor(url);
  if (brand) return brand;
  if (typeof explicit === "string" && explicit) return explicit;
  const host = hostLabel(url);
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}

const GLOBE_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" stroke-linecap="round"/></svg>`;
const LYKN_ICON_SVG =
  `<svg viewBox="0 0 204.29 204.29" fill="currentColor" aria-hidden="true"><path d="M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z"/></svg>`;
const SEARCH_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5" stroke-linecap="round"/></svg>`;
const CLOCK_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Empty / welcome agent browser tab (no navigated https page yet). */
function isEmptyBrowserTab(t) {
  if (!t || t.kind === "artifact") return false;
  if (t.kind === "welcome") return true;
  const u = String(t.url || "").trim();
  if (!u) return true;
  if (/^lykn:\/\/new-tab\b/i.test(u)) return true;
  if (/agent-browser-welcome\.html(?:[?#]|$)/i.test(u)) return true;
  return false;
}

function refreshHistoryCache() {
  if (typeof window.lyknAgentStage?.listHistory !== "function") return;
  void window.lyknAgentStage.listHistory().then((res) => {
    historyItems = Array.isArray(res?.items) ? res.items : [];
    if (urlSuggestOpen) renderUrlSuggest();
  }).catch(() => {});
}

/** Bare brand/host token? e.g. "nike" — not a search phrase, not already a URL. */
function isDomainTyped(query) {
  const q = String(query || "").trim();
  if (!q || /\s/.test(q)) return false;
  if (/^https?:\/\//i.test(q)) return false;
  // "nike", "nike.", "nike.c", "nike.com", "nike.com/shoes"
  return /^[a-z0-9][a-z0-9.-]*$/i.test(q);
}

function stripUrlDecor(url) {
  return String(url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/**
 * Google-style inline completion target for what the user typed.
 * Prefers a known host/path from history; otherwise guesses `{token}.com`.
 */
function bestLinkCompletion(query, candidates) {
  const raw = String(query || "");
  const q = raw.trim();
  if (!q || !isDomainTyped(q)) return null;
  const ql = q.toLowerCase();

  // 1) Known links whose host/path starts with the typed prefix.
  let best = null;
  for (const it of candidates || []) {
    const completes = [it.complete, stripUrlDecor(it.url), hostLabel(it.url)].filter(Boolean);
    for (const c of completes) {
      const cl = String(c).toLowerCase();
      if (!cl.startsWith(ql) || cl.length <= ql.length) continue;
      const score = cl.length + (it.kind === "Recent" ? 0 : 2);
      if (!best || score < best.score) {
        best = {
          score,
          complete: q + String(c).slice(q.length),
          url: it.url || `https://${String(c).replace(/^www\./i, "")}`,
          name: it.name || hostLabel(it.url) || c,
          kind: it.kind || "Link",
        };
      }
    }
  }
  if (best) {
    return {
      name: best.name,
      url: /^https?:\/\//i.test(best.url) ? best.url : `https://${best.url}`,
      kind: best.kind,
      complete: best.complete,
    };
  }

  // 2) No history hit — guess the .com (Chrome does this constantly).
  if (/^[a-z0-9-]+$/i.test(q)) {
    const host = `${q}.com`;
    return {
      name: host,
      url: `https://${host.toLowerCase().replace(/^www\./, "")}/`,
      kind: "Link",
      complete: `${q}.com`,
    };
  }
  // Typed "nike." / "nike.c" → finish ".com"
  const m = q.match(/^([a-z0-9-]+)\.(com?)?$/i);
  if (m && (!m[2] || m[2].toLowerCase() !== "com")) {
    const base = m[1];
    return {
      name: `${base}.com`,
      url: `https://${base.toLowerCase()}.com/`,
      kind: "Link",
      complete: `${base}.com`,
    };
  }
  return null;
}

function buildUrlSuggestions(query) {
  const raw = String(query || "");
  const q = raw.trim().toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const url = String(item.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const host = hostLabel(url);
    out.push({
      name: item.name || item.title || host || url,
      url,
      kind: item.kind || "Link",
      // Prefer bare host for inline fill ("nike" → "nike.com")
      complete: item.complete || host || stripUrlDecor(url),
      favicon: item.favicon || "",
    });
  };

  for (const t of state.tabs || []) {
    if (t.url) {
      push({
        name: t.pageTitle || t.title || hostLabel(t.url),
        url: t.url,
        kind: "Tab",
        favicon: t.favicon || "",
      });
    }
  }
  for (const h of historyItems || []) {
    if (h.url) {
      push({
        name: h.pageTitle || h.title || hostLabel(h.url),
        url: h.url,
        kind: "Recent",
      });
    }
  }
  for (const c of COMMON_SITES) {
    push({
      name: c.name,
      url: c.url,
      kind: "Popular",
      complete: hostLabel(c.url) || stripUrlDecor(c.url),
    });
  }

  if (!q) return out.slice(0, 8);

  const filtered = out.filter((it) => {
    const host = hostLabel(it.url).toLowerCase();
    const hay = `${it.name} ${it.url} ${it.complete} ${host}`.toLowerCase();
    return (
      host.startsWith(q) ||
      String(it.complete || "").toLowerCase().startsWith(q) ||
      hay.includes(q)
    );
  });

  // Prefer link completions in the list (e.g. nike → nike.com).
  const linkGuess = bestLinkCompletion(raw, out);
  if (linkGuess) {
    const key = linkGuess.url.replace(/\/$/, "").toLowerCase();
    if (!seen.has(key)) {
      filtered.unshift(linkGuess);
      seen.add(key);
    } else {
      const idx = filtered.findIndex(
        (it) => it.url.replace(/\/$/, "").toLowerCase() === key,
      );
      if (idx > 0) {
        const [hit] = filtered.splice(idx, 1);
        hit.complete = linkGuess.complete;
        filtered.unshift(hit);
      } else if (idx === 0) {
        filtered[0].complete = linkGuess.complete;
      }
    }
  }

  // Search row after link guesses.
  if (q && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(q) && !/^https?:\/\//i.test(q)) {
    filtered.push({
      name: `Search Google for “${raw.trim()}”`,
      url: `https://www.google.com/search?q=${encodeURIComponent(raw.trim())}`,
      kind: "Search",
      complete: raw.trim(),
    });
  }
  return filtered.slice(0, 8);
}

/** Query used for suggestions — empty when the whole field is selected (focus). */
function omniboxSuggestQuery() {
  if (!urlEl) return "";
  const v = urlEl.value || "";
  try {
    if (
      v &&
      urlEl.selectionStart === 0 &&
      urlEl.selectionEnd === v.length
    ) {
      return "";
    }
  } catch (_) {}
  return v;
}

function renderUrlSuggest() {
  if (!urlSuggestEl || !urlEl) return;
  const q = omniboxSuggestQuery();
  urlSuggestItems = buildUrlSuggestions(q);
  urlSuggestIndex = -1;

  if (!urlSuggestOpen || !urlSuggestItems.length) {
    urlSuggestEl.hidden = true;
    urlSuggestEl.innerHTML = "";
    return;
  }

  const iconFor = (it) => {
    if (it.kind === "Search") return SEARCH_SVG;
    const fav = faviconUrlFor(it.url, it.favicon);
    if (fav) {
      return `<img src="${escapeHtml(fav)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="globe" />`;
    }
    if (it.kind === "Recent" || it.kind === "Tab") return CLOCK_SVG;
    return GLOBE_SVG;
  };

  urlSuggestEl.innerHTML = urlSuggestItems
    .map((it, i) => {
      const host =
        it.kind === "Search"
          ? "Google Search"
          : stripUrlDecor(it.url) || hostLabel(it.url) || it.url;
      const title =
        it.kind === "Search"
          ? it.name.replace(/^Search Google for\s+[“"](.+)[”"]$/i, "$1")
          : it.name || host;
      return `<button type="button" class="suggest-item" role="option" data-idx="${i}">
          <span class="suggest-ico" aria-hidden="true">${iconFor(it)}</span>
          <div class="meta">
            <div class="name">${escapeHtml(title)}</div>
            <div class="host">${escapeHtml(host)}</div>
          </div>
        </button>`;
    })
    .join("");
  urlSuggestEl.querySelectorAll("img[data-fallback]").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        const wrap = document.createElement("span");
        wrap.innerHTML = GLOBE_SVG;
        img.replaceWith(wrap.firstChild || wrap);
      },
      { once: true },
    );
  });
  urlSuggestEl.hidden = false;
}

function setUrlSuggestOpen(open) {
  urlSuggestOpen = !!open;
  if (urlSuggestOpen) {
    if (syncMenuOpen) setSyncMenuOpen(false);
    refreshHistoryCache();
    renderUrlSuggest();
  } else if (urlSuggestEl) {
    urlSuggestEl.hidden = true;
    urlSuggestEl.innerHTML = "";
  }
  updateMenuOverlay();
}

function navigateFromOmnibox(raw) {
  const value = String(raw || "").trim();
  if (!value) return;
  setUrlSuggestOpen(false);
  void window.lyknAgentStage.navigate(value);
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

// Any open dropdown lives inside this chrome document, which sits BEHIND the
// native page view — so main.cjs must raise/expand the chrome over the page
// and go transparent around the menu. Keep that in sync with every menu.
function updateMenuOverlay() {
  const anyOpen = syncMenuOpen || urlSuggestOpen;
  document.documentElement.classList.toggle("menu-overlay", anyOpen);
  window.lyknAgentStage.setMenuOverlay?.(anyOpen);
}

function setSyncMenuOpen(open) {
  syncMenuOpen = !!open;
  if (syncMenu) syncMenu.hidden = !syncMenuOpen;
  if (syncBtn) {
    syncBtn.classList.toggle("active", syncMenuOpen);
    syncBtn.setAttribute("aria-expanded", syncMenuOpen ? "true" : "false");
  }
  if (syncMenuOpen) {
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
  const priorTabIds = renderedTabIds;
  const openingTabId = pendingNewTabAnimation
    ? String(tabs.find((t) => t.id && !priorTabIds.has(String(t.id)))?.id || "")
    : "";
  if (openingTabId) pendingNewTabAnimation = false;
  renderedTabIds = new Set(tabs.map((t) => String(t.id || "")));
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
      const empty = isEmptyBrowserTab(t);
      const fav = !isArtifact && !empty ? faviconUrlFor(t.url, t.favicon) : "";
      const ico = fav
        ? `<img class="tab-favicon" src="${escapeHtml(fav)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="1" />`
        : `<span class="tab-favicon tab-favicon-fallback${empty ? " lykn" : ""}" aria-hidden="true">${empty ? LYKN_ICON_SVG : GLOBE_SVG}</span>`;
      return `<button type="button" class="${cls}" data-id="${escapeHtml(t.id)}" title="${escapeHtml(tip)}">
        ${ico}
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
  if (openingTabId) {
    // Apply this directly to the final rendered button. State updates rebuild
    // the strip, so putting the class in the template caused the animation to
    // restart and visibly double-play.
    requestAnimationFrame(() => {
      const tab = [...tabsEl.querySelectorAll(".tab")].find(
        (el) => el.getAttribute("data-id") === openingTabId,
      );
      tab?.classList.add("opening");
    });
  }
  tabsEl.querySelectorAll("img.tab-favicon[data-fallback]").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        const span = document.createElement("span");
        span.className = "tab-favicon tab-favicon-fallback";
        span.setAttribute("aria-hidden", "true");
        span.innerHTML = GLOBE_SVG;
        img.replaceWith(span);
      },
      { once: true },
    );
  });
}

function applyState(p) {
  state = {
    tabs: Array.isArray(p.tabs) ? p.tabs : state.tabs,
    activeAgentId: p.activeAgentId != null ? p.activeAgentId : state.activeAgentId,
    url: typeof p.url === "string" ? p.url : state.url,
    title: typeof p.title === "string" ? p.title : state.title,
    incognito: typeof p.incognito === "boolean" ? p.incognito : state.incognito,
    chatOpen: typeof p.chatOpen === "boolean" ? p.chatOpen : state.chatOpen,
    recents: Array.isArray(p.recents) ? p.recents : state.recents,
  };
  if (typeof p.url === "string") urlEl.value = p.url;
  applyTheme(state.incognito);
  renderTabs();
  renderFavs();
  renderUseLykn();
}

/* Favorites bar — recently visited sites as favicon chips (bookmarks-bar
   style). Clicking one navigates the active tab; the bar reports its height
   change so the native page view re-lays-out under the taller chrome. */
let lastFavsHidden = null;
function renderFavs() {
  if (!favsEl || !favsScrollEl) return;
  const items = (state.recents || []).slice(0, 14);
  const hide = !items.length;
  favsEl.hidden = hide;
  if (hide) {
    favsScrollEl.innerHTML = "";
  } else {
    favsScrollEl.innerHTML = items
      .map((it, i) => {
        const fav = faviconUrlFor(it.url, it.favicon);
        const ico = fav
          ? `<img src="${escapeHtml(fav)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="1" />`
          : `<span class="fav-fallback" aria-hidden="true">${GLOBE_SVG}</span>`;
        const label = it.label || hostLabel(it.url) || "Site";
        return `<button type="button" class="fav" data-idx="${i}" title="${escapeHtml(it.title || it.url || label)}">
            ${ico}
            <span class="fav-label">${escapeHtml(label)}</span>
          </button>`;
      })
      .join("");
    favsScrollEl.querySelectorAll("img[data-fallback]").forEach((img) => {
      img.addEventListener(
        "error",
        () => {
          const span = document.createElement("span");
          span.className = "fav-fallback";
          span.setAttribute("aria-hidden", "true");
          span.innerHTML = GLOBE_SVG;
          img.replaceWith(span);
        },
        { once: true },
      );
    });
  }
  if (lastFavsHidden !== hide) {
    lastFavsHidden = hide;
    requestAnimationFrame(reportChrome);
  }
}

function renderUseLykn() {
  if (!useLyknBtn) return;
  const on = !!state.chatOpen;
  useLyknBtn.classList.toggle("active", on);
  useLyknBtn.setAttribute("aria-pressed", on ? "true" : "false");
  useLyknBtn.title = on ? "Hide LYKN chat" : "Use LYKN";
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
    pendingNewTabAnimation = true;
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

if (favsScrollEl) {
  favsScrollEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".fav");
    if (!chip) return;
    const hit = (state.recents || [])[Number(chip.getAttribute("data-idx"))];
    if (hit?.url) void window.lyknAgentStage.navigate(hit.url);
  });
}
if (favsMoreBtn && favsScrollEl) {
  favsMoreBtn.addEventListener("click", () => {
    const nearEnd =
      favsScrollEl.scrollLeft + favsScrollEl.clientWidth >=
      favsScrollEl.scrollWidth - 8;
    favsScrollEl.scrollTo({
      left: nearEnd ? 0 : favsScrollEl.scrollLeft + favsScrollEl.clientWidth * 0.8,
      behavior: "smooth",
    });
  });
}

urlEl.addEventListener("input", () => {
  if (!urlSuggestOpen) setUrlSuggestOpen(true);
  else renderUrlSuggest();
});

urlEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setUrlSuggestOpen(false);
    urlEl.blur();
    return;
  }
  if (e.key === "ArrowDown" && urlSuggestOpen && urlSuggestItems.length) {
    e.preventDefault();
    urlSuggestIndex = Math.min(urlSuggestItems.length - 1, urlSuggestIndex + 1);
    [...urlSuggestEl.querySelectorAll(".suggest-item")].forEach((el, i) => {
      el.classList.toggle("active", i === urlSuggestIndex);
    });
    return;
  }
  if (e.key === "ArrowUp" && urlSuggestOpen && urlSuggestItems.length) {
    e.preventDefault();
    urlSuggestIndex = Math.max(0, urlSuggestIndex - 1);
    [...urlSuggestEl.querySelectorAll(".suggest-item")].forEach((el, i) => {
      el.classList.toggle("active", i === urlSuggestIndex);
    });
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (urlSuggestIndex >= 0 && urlSuggestItems[urlSuggestIndex]) {
      navigateFromOmnibox(urlSuggestItems[urlSuggestIndex].url);
      return;
    }
    navigateFromOmnibox(urlEl.value.trim());
  }
});

// Chrome-style: focusing the omnibox selects the whole URL and opens suggestions.
urlEl.addEventListener("focus", () => {
  requestAnimationFrame(() => {
    try {
      urlEl.select();
    } catch (_) {}
    setUrlSuggestOpen(true);
  });
});

// After selection changes / typing, refresh the suggestion list.
urlEl.addEventListener("keyup", () => {
  if (urlSuggestOpen) renderUrlSuggest();
});
urlEl.addEventListener("click", () => {
  if (document.activeElement === urlEl) setUrlSuggestOpen(true);
});

urlEl.addEventListener("blur", () => {
  setTimeout(() => {
    if (document.activeElement === urlEl) return;
    if (urlSuggestEl?.contains(document.activeElement)) return;
    setUrlSuggestOpen(false);
  }, 140);
});

if (urlSuggestEl) {
  urlSuggestEl.addEventListener("mousedown", (e) => {
    // Keep focus so blur doesn't close before click lands.
    e.preventDefault();
  });
  urlSuggestEl.addEventListener("click", (e) => {
    const item = e.target.closest(".suggest-item");
    if (!item) return;
    const idx = Number(item.getAttribute("data-idx"));
    const hit = urlSuggestItems[idx];
    if (hit?.url) navigateFromOmnibox(hit.url);
  });
}

document.getElementById("back").addEventListener("click", () => void window.lyknAgentStage.back());
document
  .getElementById("forward")
  .addEventListener("click", () => void window.lyknAgentStage.forward());
document
  .getElementById("reload")
  .addEventListener("click", () => void window.lyknAgentStage.reload());

const downloadBtn = document.getElementById("download");
if (downloadBtn) {
  downloadBtn.addEventListener("click", async () => {
    downloadBtn.classList.add("active");
    try {
      await window.lyknAgentStage.downloadPage?.();
    } finally {
      setTimeout(() => downloadBtn.classList.remove("active"), 600);
    }
  });
}

if (incognitoBtn) {
  incognitoBtn.addEventListener("click", () => {
    void window.lyknAgentStage.toggleIncognito?.();
  });
}

if (useLyknBtn) {
  useLyknBtn.addEventListener("click", () => {
    void window.lyknAgentStage.toggleAgentChat?.();
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

function reportChrome() {
  const favs = document.getElementById("favs");
  const h = Math.ceil(
    (document.getElementById("tabs")?.offsetHeight || 0) +
      (document.getElementById("chrome")?.offsetHeight || 0) +
      (favs && !favs.hidden ? favs.offsetHeight : 0),
  );
  window.lyknAgentStage.resizeChrome(h || 82);
}
window.addEventListener("resize", reportChrome);
applyTheme(false);
renderTabs();
requestAnimationFrame(reportChrome);
