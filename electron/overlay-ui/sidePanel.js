// Overlay side panel: sources, tasks, follow-ups, notes, live-watch feed.

export function attachSidePanel(host) {
  const LINK_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>';

  const ARROW_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>';

  // Hidden state store for the detached side-panel card (see panel.html).
  const sideInnerEl = document.getElementById("side-inner");
  const sidePickerBtnEl = document.getElementById("side-picker-btn");
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

  let lastAnswerText = "";
  // Live watch feed — rendered in the side panel, not the chat thread.
  let watchConnPollTimer = null;

  function startWatchConnPoll() {
    if (watchConnPollTimer) return;
    watchConnPollTimer = setInterval(async () => {
      if (!host.liveWatchEnabled) return;
      try {
        const status = await window.lyknOverlay.getLiveWatch();
        const next = !!status?.extensionConnected;
        if (next !== host.watchExtensionConnected) {
          host.watchExtensionConnected = next;
          if (host.sidePanelView === "watch") renderWatchSidePanel();
        }
      } catch (_) {}
    }, 2000);
  }

  function stopWatchConnPoll() {
    if (watchConnPollTimer) clearInterval(watchConnPollTimer);
    watchConnPollTimer = null;
  }

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
      ...(host.liveNotesSnapshot.actionItems || []),
    ]);
    const notes = dedupeStrings([
      ...(host.liveNotesSnapshot.keyPoints || []),
      ...(host.liveNotesSnapshot.suggestions || []),
      ...extractNotesFromAnswer(lastAnswerText),
    ]);
    const followups = dedupeStrings([
      ...((host.sideContext && host.sideContext.followups) || []),
      ...(host.liveNotesSnapshot.questionsToAsk || []),
    ]);
    return {
      pageSource: host.sideContext && host.sideContext.pageSource ? host.sideContext.pageSource : null,
      links: (host.sideContext && host.sideContext.links) || [],
      followups,
      tasks,
      notes,
      summary: String(host.liveNotesSnapshot.summary || "").trim(),
    };
  }

  function sideViewCount(viewId, data) {
    if (!data) return 0;
    switch (viewId) {
      case "watch":
        return host.watchFeedItems.filter((i) => !i.system).length;
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
    const opt = SIDE_VIEW_OPTIONS.find((o) => o.id === host.sidePanelView);
    sidePickerLabelEl.textContent = opt ? opt.label : "None";
  }

  // The view picker lives in its OWN little vibrancy window next to the bar
  // (see picker.html / main.cjs), exactly like the three-dot menu. This just
  // asks main to show/hide it; main echoes the actual visibility back via
  // onPickerVisible so `host.panelPickerOpen` never drifts.
  function setPanelPickerOpen(open) {
    try {
      window.lyknOverlay.setPicker(!!open);
    } catch (_) {}
  }

  function closeSidePickerMenu() {
    setPanelPickerOpen(false);
    // Drop focus so the trigger doesn't keep the open/active tint after selection.
    sidePickerBtnEl.blur();
  }

  window.lyknOverlay.onPickerVisible((visible) => {
    host.panelPickerOpen = !!visible;
    sidePickerBtnEl.classList.toggle("active", host.panelPickerOpen);
    sidePickerBtnEl.setAttribute("aria-expanded", host.panelPickerOpen ? "true" : "false");
    if (!host.panelPickerOpen) sidePickerBtnEl.blur();
  });

  // Remote control from the picker window — the pick is applied HERE because
  // this renderer owns the side-panel state and rendering.
  window.__lyknPickerSelect = (id) => {
    setSidePanelView(id);
  };

  // Options snapshot (labels, counts, active view) for the picker card.
  window.__lyknPickerState = () => {
    const data = buildSideData();
    const options = [];
    for (const opt of SIDE_VIEW_OPTIONS) {
      if (opt.id === "watch" && !host.liveWatchEnabled) continue;
      options.push({
        id: opt.id,
        label: opt.label,
        count: opt.id ? sideViewCount(opt.id, data) : 0,
      });
    }
    return { options, active: host.sidePanelView };
  };

  function syncSidePickerState() {
    updateSidePickerLabel();
  }

  // The side-panel content lives in its OWN vibrancy window floating next to
  // the bar (see panel.html / main.cjs), like the three-dot menu and the live
  // notes card — so it reads as a separate glass card instead of widening the
  // chat bar. The hidden #side-inner DOM here stays the source of truth; we
  // push HTML snapshots over and receive user actions back (__lyknPanelCmd).
  function showSide(open) {
    if (open && !host.sidePanelView) return;
    try {
      window.lyknOverlay.setPanel(!!open);
    } catch (_) {}
    if (open) pushPanelState();
  }

  function sidePanelTitle() {
    const opt = SIDE_VIEW_OPTIONS.find((o) => o.id === host.sidePanelView);
    return opt && opt.id ? opt.label : "Panel";
  }

  function pushPanelState() {
    if (!host.sidePanelView) return;
    try {
      window.lyknOverlay.pushPanel({
        title: sidePanelTitle(),
        html: sideInnerEl.innerHTML,
        width: host.sidePanelView === "watch" ? WATCH_SIDE_WIDTH : SIDE_WIDTH,
        scrollBottom: host.sidePanelView === "watch",
      });
    } catch (_) {}
  }

  // Remote control from the panel card — actions run HERE because this
  // renderer owns the side-panel data (and the composer for follow-ups).
  window.__lyknPanelCmd = (name, arg) => {
    switch (name) {
      case "close":
        setSidePanelView("");
        break;
      case "url":
        try {
          const raw = arg;
          if (raw && typeof raw === "object") {
            window.lyknOverlay.openUrl(String(raw.url || ""), raw.title || undefined);
          } else {
            window.lyknOverlay.openUrl(String(raw || ""));
          }
        } catch (_) {}
        break;
      case "ask":
        host.askEl.value = String(arg || "");
        host.ask();
        break;
      case "install":
        try {
          window.lyknOverlay.openExtensionInstall?.().catch(() => {});
        } catch (_) {}
        break;
      default:
        break;
    }
  };

  function clearSide() {
    sideInnerEl.innerHTML = "";
    host.sideContext = null;
    lastAnswerText = "";
    host.researchSources = [];
    host.sidePanelView = "";
    closeSidePickerMenu();
    updateSidePickerLabel();
    showSide(false);
    syncSidePickerState();
  }

  // Reset per-turn research state for a new chat turn. The panel card stays
  // OPEN on whatever view the user picked (it only closes from its X or the
  // picker) — prior sources remain in host.sideContext until the new answer
  // delivers its own (onSources / requestSuggestions) or the user starts a
  // new chat (clearSide).

  function resetSideForNewTurn() {
    lastAnswerText = "";
    host.researchSources = [];
    if (host.liveWatchEnabled && !host.sidePanelView) setSidePanelView("watch");
  }

  function mergeSourceLinks(base, extra) {
    const out = [];
    const seen = new Set();
    for (const raw of [...(base || []), ...(extra || [])]) {
      if (!raw || !raw.url) continue;
      const url = String(raw.url).trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        title: String(raw.title || url).trim().slice(0, 160) || url,
        url,
      });
    }
    return out;
  }

  function setSidePanelView(viewId) {
    host.sidePanelView = viewId || "";
    updateSidePickerLabel();
    if (!host.sidePanelView) {
      showSide(false);
      return;
    }
    renderSidePanel();
    showSide(true);
  }

  sidePickerBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    setPanelPickerOpen(!host.panelPickerOpen);
  });

  document.addEventListener("click", (e) => {
    if (host.panelPickerOpen && !e.target.closest("#composer")) closeSidePickerMenu();
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
      // Show every collected source (stream/deep-research caps upstream).
      for (const l of data.links) list.appendChild(sourceCard(l));
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
          host.askEl.value = f;
          host.ask();
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
    if (host.watchContextSource === "extension") return "via extension (text)";
    if (host.watchContextSource === "scrape") return "via browser text";
    return "via screen";
  }

  function appendWatchSuggestionsSection(target) {
    const followups = (host.watchSuggestions.followups || []).filter(Boolean);
    const links = (host.watchSuggestions.links || []).filter((l) => l && l.url);
    let added = false;
    if (followups.length) {
      const { sec, list } = sideSection("Suggestions");
      for (const f of followups.slice(0, 4)) {
        list.appendChild(
          optionButton(f, ARROW_ICON_SVG, () => {
            host.askEl.value = f;
            host.ask();
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
    if (!host.watchFeedActive && !host.watchFeedItems.length) return false;
    const { sec, list } = sideSection("Live feedback");
    if (!host.watchExtensionConnected && host.watchFeedActive) {
      const installBtn = document.createElement("button");
      installBtn.type = "button";
      installBtn.className = "watch-install-btn";
      installBtn.textContent = "Add Chrome Live Feed";
      installBtn.addEventListener("click", () => {
        window.lyknOverlay.openExtensionInstall?.().catch(() => {});
      });
      list.appendChild(installBtn);
    }
    if (host.watchActiveRules.length) {
      const rulesEl = document.createElement("div");
      rulesEl.className = "watch-side-rules";
      rulesEl.textContent = `Alerts: ${host.watchActiveRules.join(" · ")}`;
      list.appendChild(rulesEl);
    }
    if (!host.watchFeedItems.length) {
      list.appendChild(sideTextItem("Analyzing screen…"));
    } else {
      for (const item of host.watchFeedItems.slice(-24)) {
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
    if (host.watchExtensionConnected && host.watchFeedActive) {
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
    pushPanelState();
  }

  function renderSidePanel() {
    if (host.sidePanelView === "watch") {
      renderWatchSidePanel();
      return;
    }
    const data = buildSideData();
    sideInnerEl.innerHTML = "";
    const views =
      host.sidePanelView === "all"
        ? ["watch", "sources", "tasks", "followups", "notes"]
        : [host.sidePanelView];
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
    pushPanelState();
  }

  function refreshSidePanelFromLiveNotes() {
    syncSidePickerState();
    if (host.sidePanelView) renderSidePanel();
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
    // The detached panel card renders this markup via innerHTML snapshots, so
    // it needs the URL as data (its click delegation can't see this listener).
    a.dataset.url = link.url;
    if (link.title) a.dataset.title = link.title;

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
    a.addEventListener("click", () =>
      window.lyknOverlay.openUrl(link.url, link.title || host || undefined),
    );
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
    const suggested = (data && Array.isArray(data.links) ? data.links : []).filter((l) => l && l.url);
    const priorLinks = (host.sideContext && host.sideContext.links) || [];
    const stepOnly = /lykn-agent-step:\/\//i.test(String(answer || ""));
    // This turn's deep-research sources replace the list; otherwise keep prior
    // sources so a follow-up prompt doesn't wipe the Sources panel.
    // Step-box transcripts are not a source list — don't invent links from them.
    const links = stepOnly
      ? []
      : host.researchSources.length
        ? mergeSourceLinks(host.researchSources, suggested)
        : mergeSourceLinks(priorLinks, suggested);
    const followups = (data && Array.isArray(data.followups) ? data.followups : []).filter(Boolean);

    lastAnswerText = answer;
    host.sideContext = {
      pageSource:
        (host.currentPageSource && host.currentPageSource.url && host.currentPageSource) ||
        (host.sideContext && host.sideContext.pageSource) ||
        null,
      links,
      followups: followups.length ? followups : (host.sideContext && host.sideContext.followups) || [],
    };

    syncSidePickerState();
    // Keep Sources data ready, but never auto-open the panel — user picks it.
    if (host.sidePanelView && host.sidePanelView !== "watch") renderSidePanel();
  }
  function applyLiveWatchLayout(on) {
    if (on) {
      if (host.sidePanelView !== "watch") setSidePanelView("watch");
      else {
        renderWatchSidePanel();
        showSide(true);
      }
    }
  }

  // The live meeting notes card lives in its OWN vibrancy window floating next
  // to the bar (see live.html / main.cjs), like the three-dot menu — so it never
  // stretches the chat bar or bleeds into the composer. This renderer keeps the
  // hidden #live DOM as the state store and pushes render snapshots to the card.
  function applyLiveNotesLayout(on) {
    host.liveNotesOpen = !!on;
    try {
      window.lyknOverlay.setLive(host.liveNotesOpen);
    } catch (_) {}
    if (host.liveNotesOpen) host.pushLiveState();
  }
  return {
    ARROW_ICON_SVG,
    showSide,
    clearSide,
    resetSideForNewTurn,
    setSidePanelView,
    renderSidePanel,
    renderWatchSidePanel,
    refreshSidePanelFromLiveNotes,
    requestSuggestions,
    mergeSourceLinks,
    setPanelPickerOpen,
    syncSidePickerState,
    updateSidePickerLabel,
    applyLiveWatchLayout,
    applyLiveNotesLayout,
    startWatchConnPoll,
    stopWatchConnPoll,
  };
}
