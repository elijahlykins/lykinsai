// Overlay transcribe/meeting card: capture, transcript, notes, vault save.

export function attachListenMeeting(host) {
  const liveBodyEl = document.getElementById("live-body");
  const liveDotEl = document.getElementById("live-dot");
  const liveTitleEl = document.getElementById("live-title");
  const notesSummaryEl = document.getElementById("notes-summary");
  const notesTopicsEl = document.getElementById("notes-topics");
  const notesKeyWrapEl = document.getElementById("notes-key-wrap");
  const notesKeyEl = document.getElementById("notes-key");
  const notesSuggestWrapEl = document.getElementById("notes-suggest-wrap");
  const notesSuggestEl = document.getElementById("notes-suggest");
  const notesActionsWrapEl = document.getElementById("notes-actions-wrap");
  const notesActionsEl = document.getElementById("notes-actions");
  const notesQuestionsEl = document.getElementById("notes-questions");
  const notesQuestionsWrapEl = document.getElementById("notes-questions-wrap");
  let listenDisplayStream = null;
  let listenSysStream = null;
  let listenMicStream = null;
  // Per-speaker queues — mic and meeting audio transcribe in parallel.
  const listenQueues = { them: Promise.resolve(), you: Promise.resolve() };
  const listenTails = { them: "", you: "" };
  const listenInterim = { them: null, you: null };
  let listenStartedAt = 0;
  let transcriptText = "";
  // Every ASR utterance becomes a fragment so async LLM cleanup can swap the
  // polished text in place after the raw text has already been shown.
  let listenFragments = [];
  let listenFragSeq = 0;
  let notesTimer = null;
  let notesInFlight = false;
  let lastNotesLen = 0;
  let lastNotesAt = 0;
  const NOTES_INTERVAL_MS = 12000;
  const SPEAKER_LABEL = { them: "Others", you: "You" };
  const liveSaveBtn = document.getElementById("live-save");
  const liveSavedToastEl = document.getElementById("live-saved-toast");
  let meetingVaultSaved = false;
  let meetingSaving = false;
  let meetingSaveToastTimer = null;
  let livePane = "notes";

  // Push a render snapshot to the detached live notes card. The hidden #live
  // DOM in this page stays the single source of truth (all the feature code
  // below keeps writing into it); the floating window just mirrors its HTML.
  function pushLiveState() {
    if (!host.liveNotesOpen) return;
    try {
      window.lyknOverlay.pushLive({
        listening: host.listening,
        title: liveTitleEl.textContent,
        pane: livePane,
        notesHtml: document.getElementById("pane-notes").innerHTML,
        askHtml: document.getElementById("pane-ask").innerHTML,
        transcriptHtml: liveBodyEl.innerHTML,
        saveSaved: !!(liveSaveBtn && liveSaveBtn.classList.contains("saved")),
        saveDisabled: !!(liveSaveBtn && liveSaveBtn.disabled),
        toastText:
          liveSavedToastEl && !liveSavedToastEl.hidden ? liveSavedToastEl.textContent : "",
      });
    } catch (_) {}
  }

  // Remote control from the live card window — actions run HERE because this
  // renderer owns the audio streams, transcript, and notes state.
  window.__lyknLiveCmd = (name, arg) => {
    switch (name) {
      case "pane":
        switchLivePane(String(arg || "notes"));
        break;
      case "close":
        closeLive();
        break;
      case "copy":
        copyMeetingTranscript();
        break;
      case "save":
        void saveMeetingToVault({ force: true });
        break;
      case "vault":
        try {
          window.lyknOverlay.openVault?.();
        } catch (_) {}
        break;
      case "ask": {
        const q = String(arg || "").trim();
        if (q) {
          host.askEl.value = q;
          host.ask();
        }
        break;
      }
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
    }
  };

  function formatMeetingDuration() {
    const ms = Math.max(0, Date.now() - (listenStartedAt || Date.now()));
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function buildMeetingTitle() {
    const topics = host.liveNotesSnapshot.topics || [];
    if (topics[0]) return `Meeting: ${topics[0]}`.slice(0, 120);
    const summary = String(host.liveNotesSnapshot.summary || "").trim();
    if (summary) {
      const first = summary.split(/[.!?]/)[0].trim();
      if (first.length >= 8) return first.slice(0, 120);
    }
    const d = new Date(listenStartedAt || Date.now());
    return `Meeting notes · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function buildMeetingVaultContent() {
    const snap = host.liveNotesSnapshot;
    const lines = [
      `# ${buildMeetingTitle()}`,
      "",
      `**Recorded:** ${new Date(listenStartedAt || Date.now()).toLocaleString()}`,
      `**Duration:** ${formatMeetingDuration()}`,
      "",
    ];
    if (snap.summary) {
      lines.push("## Summary", "", String(snap.summary).trim(), "");
    }
    if (snap.keyPoints?.length) {
      lines.push("## Key points", "");
      for (const p of snap.keyPoints) lines.push(`- ${String(p).trim()}`);
      lines.push("");
    }
    if (snap.actionItems?.length) {
      lines.push("## Action items", "");
      for (const p of snap.actionItems) lines.push(`- [ ] ${String(p).trim()}`);
      lines.push("");
    }
    if (snap.suggestions?.length) {
      lines.push("## Talking points", "");
      for (const p of snap.suggestions) lines.push(`- ${String(p).trim()}`);
      lines.push("");
    }
    if (snap.questionsToAsk?.length) {
      lines.push("## Questions to revisit", "");
      for (const p of snap.questionsToAsk) lines.push(`- ${String(p).trim()}`);
      lines.push("");
    }
    const txt = transcriptText.trim();
    if (txt) {
      lines.push("## Transcript", "", txt);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function buildMeetingCopyText() {
    const header = [
      buildMeetingTitle(),
      `Duration: ${formatMeetingDuration()}`,
      host.liveNotesSnapshot.summary ? `\nSummary:\n${host.liveNotesSnapshot.summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const body = transcriptText.trim();
    return body ? `${header}\n\n---\n\n${body}` : header;
  }

  function showMeetingSavedToast(label = "Saved to Vault · Open in Vault →") {
    if (!liveSavedToastEl) return;
    liveSavedToastEl.textContent = label;
    liveSavedToastEl.hidden = false;
    if (liveSaveBtn) liveSaveBtn.classList.add("saved");
    if (meetingSaveToastTimer) clearTimeout(meetingSaveToastTimer);
    meetingSaveToastTimer = setTimeout(() => {
      if (liveSavedToastEl) liveSavedToastEl.hidden = true;
      pushLiveState();
    }, 12000);
    pushLiveState();
  }

  async function saveMeetingToVault({ auto = false, force = false } = {}) {
    if (meetingSaving || typeof window.lyknOverlay.saveVaultNote !== "function") return { ok: false };
    const txt = transcriptText.trim();
    if (txt.length < 40) {
      if (!auto) showMeetingSavedToast("Nothing to save yet");
      return { ok: false };
    }
    if (auto && meetingVaultSaved && !force) return { ok: false };

    meetingSaving = true;
    if (liveSaveBtn) liveSaveBtn.disabled = true;
    try {
      const content = buildMeetingVaultContent();
      const saved = await window.lyknOverlay.saveVaultNote({
        title: buildMeetingTitle(),
        content,
        tags: ["lykn-overlay", "meeting-notes"],
        folder: "Meetings",
        source: "meeting_notes",
      });
      if (saved?.ok) {
        meetingVaultSaved = true;
        showMeetingSavedToast(auto ? "Auto-saved to Vault · Open in Vault →" : "Saved to Vault · Open in Vault →");
        return { ok: true };
      }
      if (!auto) showMeetingSavedToast("Couldn't save. Sign in to LYKN");
    } catch (_) {
      if (!auto) showMeetingSavedToast("Couldn't save to Vault");
    } finally {
      meetingSaving = false;
      if (liveSaveBtn) liveSaveBtn.disabled = false;
      pushLiveState();
    }
    return { ok: false };
  }

  function copyMeetingTranscript() {
    const text = buildMeetingCopyText();
    if (!text.trim()) {
      showMeetingSavedToast("Nothing to copy yet");
      return;
    }
    try {
      window.lyknOverlay.copyText?.(text);
      showMeetingSavedToast("Transcript copied");
    } catch (_) {}
  }

  function formatListenTime(ms) {
    const sec = Math.max(0, Math.floor((ms - listenStartedAt) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setSpeakerTranscribing(speaker, active) {
    if (active) {
      if (listenInterim[speaker]) return;
      const line = document.createElement("div");
      line.className = `live-line ${speaker} host.transcribing`;
      line.dataset.speaker = speaker;
      line.dataset.interim = "1";
      const time = document.createElement("span");
      time.className = "live-time";
      time.textContent = formatListenTime(Date.now());
      const lab = document.createElement("span");
      lab.className = "live-speaker";
      lab.textContent = SPEAKER_LABEL[speaker];
      const body = document.createElement("span");
      body.className = "live-text";
      body.textContent = "…";
      line.append(time, lab, body);
      liveBodyEl.appendChild(line);
      listenInterim[speaker] = line;
      liveBodyEl.scrollTop = liveBodyEl.scrollHeight;
      pushLiveState();
    } else if (listenInterim[speaker]) {
      listenInterim[speaker].remove();
      listenInterim[speaker] = null;
      pushLiveState();
    }
  }

  // The "…" indicator shows from the moment the VAD hears speech until the last
  // in-flight utterance for that speaker has been transcribed.
  function updateSpeakerInterim(speaker) {
    setSpeakerTranscribing(speaker, !!vadActive[speaker] || listenPending[speaker] > 0);
  }

  function setListenUi() {
    host.listenEl.classList.toggle("listening", host.listening);
    host.listenEl.title = host.listening ? "Stop transcribe" : "Transcribe";
    const listenLabel = document.getElementById("listen-label");
    if (listenLabel) listenLabel.textContent = host.listening ? "Stop transcribe" : "Transcribe";
    liveDotEl.classList.toggle("live", host.listening);
    liveTitleEl.textContent = host.listening ? "Transcribe · live" : "Transcript";
    host.renderModeBadge("transcribe-state", host.listening || host.composerMode === "transcribe");
    // Keep composer mode / pill in sync when capture starts/stops outside the menu.
    if (!host.syncingTranscribeMode) {
      if (host.listening && host.composerMode !== "transcribe") {
        host.syncingTranscribeMode = true;
        try {
          host.setComposerMode("transcribe");
        } finally {
          host.syncingTranscribeMode = false;
        }
      } else if (!host.listening && host.composerMode === "transcribe") {
        host.syncingTranscribeMode = true;
        try {
          host.setComposerMode("chat");
        } finally {
          host.syncingTranscribeMode = false;
        }
      }
    }
    pushLiveState();
  }

  function switchLivePane(pane) {
    livePane = pane;
    pushLiveState();
  }

  function renderMeetingQuestion(q) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-question";
    const ico = document.createElement("span");
    ico.className = "meeting-question-ico";
    ico.innerHTML = host.ARROW_ICON_SVG;
    const span = document.createElement("span");
    span.textContent = String(q);
    btn.append(ico, span);
    btn.addEventListener("click", () => {
      host.askEl.value = String(q);
      host.ask();
    });
    li.appendChild(btn);
    return li;
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
      if (wrapEl) wrapEl.hidden = arr.length === 0;
    };
    fill(notesKeyEl, notesKeyWrapEl, notes.keyPoints);
    fill(notesSuggestEl, notesSuggestWrapEl, notes.suggestions);
    fill(notesActionsEl, notesActionsWrapEl, notes.actionItems);

    notesQuestionsEl.innerHTML = "";
    const questions = Array.isArray(notes.questionsToAsk) ? notes.questionsToAsk.filter(Boolean) : [];
    for (const q of questions) notesQuestionsEl.appendChild(renderMeetingQuestion(q));
    if (notesQuestionsWrapEl) {
      notesQuestionsWrapEl.hidden = questions.length === 0;
    }

    notesTopicsEl.innerHTML = "";
    const topics = Array.isArray(notes.topics) ? notes.topics.filter(Boolean) : [];
    for (const t of topics) {
      const chip = document.createElement("span");
      chip.className = "notes-topic";
      chip.textContent = String(t);
      notesTopicsEl.appendChild(chip);
    }
    notesTopicsEl.hidden = topics.length === 0;
    pushLiveState();

    host.liveNotesSnapshot = {
      keyPoints: Array.isArray(notes.keyPoints) ? notes.keyPoints.filter(Boolean) : [],
      actionItems: Array.isArray(notes.actionItems) ? notes.actionItems.filter(Boolean) : [],
      summary: String(notes.summary || "").trim(),
      questionsToAsk: questions,
      suggestions: Array.isArray(notes.suggestions) ? notes.suggestions.filter(Boolean) : [],
      topics,
    };
    host.refreshSidePanelFromLiveNotes();
    host.reportHeight();
  }

  async function refreshNotes(force = false) {
    if (notesInFlight) return;
    const txt = transcriptText.trim();
    if (txt.length < 40) return;
    const now = Date.now();
    const grew = txt.length - lastNotesLen >= 50;
    const due = now - lastNotesAt >= NOTES_INTERVAL_MS;
    if (!force && !grew && !due) return;
    notesInFlight = true;
    lastNotesLen = txt.length;
    lastNotesAt = now;
    try {
      const prev = host.liveNotesSnapshot.summary
        ? {
            summary: host.liveNotesSnapshot.summary,
            keyPoints: host.liveNotesSnapshot.keyPoints,
            actionItems: host.liveNotesSnapshot.actionItems,
          }
        : null;
      const notes = await window.lyknOverlay.meetingNotes(txt, prev);
      if (
        notes &&
        (notes.summary ||
          notes.keyPoints?.length ||
          notes.actionItems?.length ||
          notes.questionsToAsk?.length ||
          notes.suggestions?.length)
      ) {
        renderNotes(notes);
      }
    } catch (_) {}
    notesInFlight = false;
  }

  // Rebuild the flat transcript (used for notes / vault / copy) from fragments,
  // merging consecutive same-speaker utterances into one line.
  function rebuildTranscriptText() {
    const parts = [];
    let curSpeaker = null;
    let cur = [];
    for (const f of listenFragments) {
      if (f.speaker !== curSpeaker) {
        if (cur.length) parts.push(`${SPEAKER_LABEL[curSpeaker] || curSpeaker}: ${cur.join(" ")}`);
        curSpeaker = f.speaker;
        cur = [];
      }
      cur.push(f.text);
    }
    if (cur.length) parts.push(`${SPEAKER_LABEL[curSpeaker] || curSpeaker}: ${cur.join(" ")}`);
    transcriptText = parts.length ? `${parts.join("\n")}\n` : "";
  }

  // ── Live assist (Cluely-style in-call copilot) ──────────────────────────────
  // After each utterance settles, the rolling transcript is sent to the backend,
  // which decides whether THIS moment deserves a private help card — an answer
  // to a question the user was just asked, a quick brief on a company/term that
  // came up, a fact check, or a suggested next line — optionally composed from
  // a live web search run mid-sentence. Cards land at the top of the Notes pane
  // in the floating live window. Silence is the default; cards must feel earned.
  const assistFeedEl = document.getElementById("assist-feed");
  const ASSIST_DEBOUNCE_MS = 1200; // let the sentence settle before asking
  const ASSIST_MIN_INTERVAL_MS = 6000; // never ping the backend faster than this
  const ASSIST_MAX_CARDS = 6;
  const ASSIST_KIND_LABEL = {
    answer: "Answer",
    brief: "Brief",
    fact: "Fact check",
    suggest: "Say this",
  };
  let assistShownTitles = [];
  let assistInFlight = false;
  let assistTimer = null;
  let assistLastRanAt = 0;
  let assistLastLen = 0;

  function scheduleLiveAssist() {
    if (!host.listening) return;
    if (assistTimer) clearTimeout(assistTimer);
    const wait = Math.max(
      ASSIST_DEBOUNCE_MS,
      ASSIST_MIN_INTERVAL_MS - (Date.now() - assistLastRanAt),
    );
    assistTimer = setTimeout(() => {
      assistTimer = null;
      void runLiveAssist();
    }, wait);
  }

  async function runLiveAssist() {
    if (!host.listening || assistInFlight) return;
    const txt = transcriptText.trim();
    // Need real new content since the last look — not just a stray word.
    if (txt.length < 60 || txt.length - assistLastLen < 24) return;
    assistInFlight = true;
    assistLastRanAt = Date.now();
    assistLastLen = txt.length;
    try {
      const r = await window.lyknOverlay.liveAssist(txt.slice(-2400), assistShownTitles);
      const insight = r && r.insight;
      if (insight && insight.body && host.listening) addAssistCard(insight);
    } catch (_) {}
    assistInFlight = false;
  }

  function addAssistCard(insight) {
    const kind = ASSIST_KIND_LABEL[insight.kind] ? insight.kind : "suggest";
    const title = String(insight.title || "").trim() || "Heads up";
    assistShownTitles.push(title);
    assistShownTitles = assistShownTitles.slice(-12);

    const card = document.createElement("div");
    card.className = `assist-card kind-${kind}`;
    const head = document.createElement("div");
    head.className = "assist-head";
    const kindEl = document.createElement("span");
    kindEl.className = "assist-kind";
    kindEl.textContent = ASSIST_KIND_LABEL[kind];
    const titleEl = document.createElement("span");
    titleEl.className = "assist-title";
    titleEl.textContent = title;
    head.append(kindEl, titleEl);
    const body = document.createElement("div");
    body.className = "assist-body";
    body.textContent = String(insight.body || "").trim();
    card.append(head, body);

    const sources = Array.isArray(insight.sources) ? insight.sources.filter((s) => s && s.url) : [];
    if (sources.length) {
      const row = document.createElement("div");
      row.className = "assist-sources";
      for (const s of sources.slice(0, 3)) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "assist-src";
        link.dataset.url = s.url;
        if (s.title) link.dataset.title = s.title;
        link.addEventListener("click", () => {
          window.lyknOverlay.openUrl(s.url, s.title || undefined);
        });
        try {
          link.textContent = new URL(s.url).hostname.replace(/^www\./, "");
        } catch (_) {
          link.textContent = "source";
        }
        row.appendChild(link);
      }
      card.appendChild(row);
    }

    assistFeedEl.prepend(card);
    while (assistFeedEl.children.length > ASSIST_MAX_CARDS) assistFeedEl.lastChild.remove();
    // Surface the card: flip the live window to the Suggestions pane so the
    // help is actually seen the moment it lands.
    if (livePane !== "ask") switchLivePane("ask");
    else pushLiveState();
  }

  // ── Junk suppression ────────────────────────────────────────────────────────
  // Three classes of garbage never reach the transcript:
  //  1. ASR artifacts — stock phrases speech models emit on music/noise.
  //  2. Echo duplicates — without headphones the mic re-hears the meeting audio,
  //     so "You" would repeat what "Others" just said (and vice versa).
  //  3. Stuck repeats — the same utterance recognized twice back-to-back.
  function normalizeUtterance(t) {
    return String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Conservative list: only phrases that are near-certain hallucinations when
  // they arrive as a WHOLE standalone utterance (classic YouTube-outro junk).
  const ASR_ARTIFACTS = new Set([
    "you",
    "bye",
    "thanks for watching",
    "thank you for watching",
    "thank you so much for watching",
    "please subscribe",
    "like and subscribe",
    "don't forget to subscribe",
    "see you in the next video",
    "see you next time",
    "subtitles by the amara org community",
  ]);

  const lastUtter = { them: { norm: "", at: 0 }, you: { norm: "", at: 0 } };

  function isJunkUtterance(speaker, norm) {
    if (!norm) return true;
    if (ASR_ARTIFACTS.has(norm)) return true;
    const now = Date.now();
    // Stuck repeat from the same speaker.
    const mine = lastUtter[speaker];
    if (mine.norm && norm === mine.norm && now - mine.at < 6000) return true;
    // Speaker echo: the new utterance is (a piece of) what the other source
    // just heard. Only the CONTAINED direction is an echo — a longer utterance
    // that merely includes the other's text is new speech and must be kept.
    const other = lastUtter[speaker === "you" ? "them" : "you"];
    if (other.norm && now - other.at < 6000) {
      if (norm === other.norm) return true;
      if (norm.length > 12 && other.norm.includes(norm)) return true;
    }
    return false;
  }

  // Show the raw ASR text IMMEDIATELY (Wispr-Flow-style: never make the user
  // wait on the polish), keyed by fragment id so the async LLM cleanup below
  // can swap the corrected text in place.
  function appendUtterance(speaker, text) {
    const t = String(text || "").trim();
    if (!t) return;
    const norm = normalizeUtterance(t);
    if (isJunkUtterance(speaker, norm)) return;
    lastUtter[speaker] = { norm, at: Date.now() };
    const frag = { id: String(++listenFragSeq), speaker, text: t };
    listenFragments.push(frag);

    const span = document.createElement("span");
    span.className = "live-frag";
    span.dataset.frag = frag.id;
    span.textContent = t;

    const last = liveBodyEl.lastElementChild;
    if (last && last.dataset.speaker === speaker && !last.dataset.interim) {
      const body = last.querySelector(".live-text");
      body.append(document.createTextNode(" "), span);
    } else {
      const line = document.createElement("div");
      line.className = `live-line ${speaker}`;
      line.dataset.speaker = speaker;
      const time = document.createElement("span");
      time.className = "live-time";
      time.textContent = formatListenTime(Date.now());
      const lab = document.createElement("span");
      lab.className = "live-speaker";
      lab.textContent = SPEAKER_LABEL[speaker] || speaker;
      const body = document.createElement("span");
      body.className = "live-text";
      body.appendChild(span);
      line.append(time, lab, body);
      liveBodyEl.appendChild(line);
    }

    listenTails[speaker] = `${listenTails[speaker] ? `${listenTails[speaker]} ` : ""}${t}`
      .split(/\s+/)
      .slice(-50)
      .join(" ");
    rebuildTranscriptText();
    liveBodyEl.scrollTop = liveBodyEl.scrollHeight;
    void refreshNotes();
    scheduleLiveAssist();
    pushLiveState();
    void cleanFragment(frag);
  }

  // Drop a fragment entirely (the cleanup model judged it pure filler): remove
  // its span, and the whole line if nothing else is left on it.
  function removeFragment(frag) {
    const i = listenFragments.indexOf(frag);
    if (i >= 0) listenFragments.splice(i, 1);
    const span = liveBodyEl.querySelector(`.live-frag[data-frag="${frag.id}"]`);
    if (span) {
      const line = span.closest(".live-line");
      const body = span.closest(".live-text");
      const prev = span.previousSibling;
      if (prev && prev.nodeType === Node.TEXT_NODE) prev.remove();
      span.remove();
      if (line && body && !body.querySelector(".live-frag")) line.remove();
    }
    rebuildTranscriptText();
    pushLiveState();
  }

  // Async polish pass — strips fillers/stutters and fixes punctuation, then
  // swaps the fragment in place. Fails open: the raw text simply stays.
  async function cleanFragment(frag) {
    // Nothing worth polishing (and one less LLM round trip) on tiny fragments.
    if (frag.text.length < 14) return;
    const idx = listenFragments.indexOf(frag);
    const context = listenFragments
      .slice(Math.max(0, idx - 4), idx)
      .map((f) => f.text)
      .join(" ")
      .slice(-500);
    let cleaned = null;
    try {
      const r = await window.lyknOverlay.cleanTranscript(frag.text, context);
      cleaned = r && typeof r.text === "string" ? r.text.trim() : null;
    } catch (_) {}
    if (cleaned == null) return; // request failed — keep raw
    if (!cleaned) {
      // The model deemed it pure filler. Only trust that for very short
      // fragments — never let it blank out a real sentence.
      if (frag.text.length < 24 && listenFragments.includes(frag)) removeFragment(frag);
      return;
    }
    if (cleaned === frag.text) return;
    frag.text = cleaned;
    const span = liveBodyEl.querySelector(`.live-frag[data-frag="${frag.id}"]`);
    if (span) span.textContent = cleaned;
    rebuildTranscriptText();
    pushLiveState();
  }

  async function processUtterance(wavBuf, speaker) {
    if (!host.listening) return;
    let text = "";
    let noSpeech = 0;
    try {
      const r = await window.lyknOverlay.meetingChunk(
        wavBuf,
        "audio/wav",
        listenTails[speaker],
        listenTails[speaker],
      );
      text = r && r.text ? r.text.trim() : "";
      noSpeech = r && typeof r.noSpeech === "number" ? r.noSpeech : 0;
    } catch (_) {}
    listenPending[speaker] = Math.max(0, listenPending[speaker] - 1);
    updateSpeakerInterim(speaker);
    if (!text || noSpeech > 0.72 || !host.listening) return;
    appendUtterance(speaker, text);
  }

  // ── VAD capture — continuous PCM with energy endpointing ────────────────────
  // Instead of blind fixed-length clips (which split words mid-syllable and
  // upload silence), we tap raw PCM off each stream and cut utterances at
  // natural pauses: an adaptive noise floor decides when speech starts, a short
  // hangover decides when it ended, and a pre-roll ring keeps the first
  // syllable intact. Only actual speech ever reaches the ASR API.
  const LISTEN_SAMPLE_RATE = 16000;
  const VAD_FRAME_MS = 128; // ScriptProcessor buffer of 2048 samples @ 16k
  const VAD_HANG_MS = 450; // silence needed to close an utterance
  // A single frame of clear speech is enough to keep an utterance — RMS gating
  // undercounts soft speech, so a stricter gate silently dropped short words
  // ("No.", "Sure.") and quiet sentence starts.
  const VAD_MIN_SPEECH_MS = 150;
  const VAD_PRE_ROLL_MS = 480; // audio kept from before speech onset
  const VAD_MAX_UTTER_MS = 8000; // prefer a cut past this, at the next soft frame
  const VAD_HARD_MAX_UTTER_MS = 12000; // …but never run longer than this
  const vadActive = { them: false, you: false };
  const listenPending = { them: 0, you: 0 };
  let listenAudioCtx = null;
  let listenTaps = [];

  // 16-bit mono WAV — tiny header + PCM, cheapest reliable container for API upload.
  function encodeWav(float32, sampleRate) {
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    dv.setUint32(4, 36 + pcm.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, "data");
    dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }

  function tapStreamWithVad(stream, speaker) {
    if (!host.listening || !stream || !listenAudioCtx) return;
    let source;
    try {
      source = listenAudioCtx.createMediaStreamSource(stream);
    } catch (_) {
      return;
    }
    const proc = listenAudioCtx.createScriptProcessor(2048, 1, 1);
    // Keep the node alive without feeding audio anywhere audible.
    const sink = listenAudioCtx.createGain();
    sink.gain.value = 0;

    const framesPerMs = listenAudioCtx.sampleRate / 1000;
    const preRollFrames = Math.ceil((VAD_PRE_ROLL_MS * framesPerMs) / 2048);
    const hangFrames = Math.ceil((VAD_HANG_MS * framesPerMs) / 2048);
    const preRoll = [];
    let utterance = [];
    let speechMs = 0;
    let silentFrames = 0;
    let utterMs = 0;
    // Adaptive noise floor: EMA of frame RMS while not speaking. Seeded high so
    // the first frames don't trigger; converges within ~a second.
    let noiseFloor = 0.02;

    const finalize = (force) => {
      const hadSpeech = speechMs >= VAD_MIN_SPEECH_MS;
      const chunks = utterance;
      utterance = [];
      speechMs = 0;
      silentFrames = 0;
      utterMs = 0;
      vadActive[speaker] = false;
      if (!hadSpeech || !chunks.length) {
        updateSpeakerInterim(speaker);
        return;
      }
      let total = 0;
      for (const c of chunks) total += c.length;
      const joined = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        joined.set(c, off);
        off += c.length;
      }
      const wav = encodeWav(joined, listenAudioCtx.sampleRate);
      listenPending[speaker] += 1;
      updateSpeakerInterim(speaker);
      listenQueues[speaker] = listenQueues[speaker]
        .then(() => processUtterance(wav, speaker))
        .catch(() => {});
      if (force) {
        // Forced mid-speech cut: stay "active" so capture continues seamlessly.
        vadActive[speaker] = true;
      }
    };

    proc.onaudioprocess = (e) => {
      if (!host.listening) return;
      const data = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      // 2.0× floor (was 2.5×) with a lower absolute minimum — quiet speakers
      // and soft sentence onsets were sitting just under the old trigger.
      const threshold = Math.max(0.0045, noiseFloor * 2.0);
      const frame = new Float32Array(data); // copy — the buffer is reused

      if (!vadActive[speaker]) {
        // Idle: learn the noise floor, keep a pre-roll ring.
        noiseFloor = noiseFloor * 0.95 + rms * 0.05;
        preRoll.push(frame);
        if (preRoll.length > preRollFrames) preRoll.shift();
        if (rms > threshold) {
          vadActive[speaker] = true;
          utterance = preRoll.splice(0, preRoll.length);
          utterance.push(frame);
          speechMs = VAD_FRAME_MS;
          silentFrames = 0;
          utterMs = utterance.length * VAD_FRAME_MS;
          updateSpeakerInterim(speaker);
        }
        return;
      }

      // In an utterance: keep capturing through short pauses.
      utterance.push(frame);
      utterMs += VAD_FRAME_MS;
      if (rms > threshold) {
        speechMs += VAD_FRAME_MS;
        silentFrames = 0;
      } else {
        silentFrames += 1;
        // Silence keeps refining the floor so the threshold tracks room tone.
        noiseFloor = noiseFloor * 0.98 + rms * 0.02;
      }
      if (silentFrames >= hangFrames) {
        // Keep the full hangover tail — trailing fricatives and soft word
        // endings read as "silence" to an RMS gate, and trimming them was
        // clipping the last word. 450ms of extra audio costs nothing.
        finalize(false);
      } else if (utterMs >= VAD_MAX_UTTER_MS && silentFrames > 0) {
        // Past the soft cap: cut at the first below-threshold frame so the cut
        // lands between words instead of mid-syllable.
        finalize(true);
      } else if (utterMs >= VAD_HARD_MAX_UTTER_MS) {
        finalize(true);
      }
    };

    source.connect(proc);
    proc.connect(sink);
    sink.connect(listenAudioCtx.destination);
    listenTaps.push({ source, proc, sink });
  }

  function teardownListenTaps() {
    for (const t of listenTaps) {
      try { t.proc.onaudioprocess = null; } catch (_) {}
      try { t.source.disconnect(); } catch (_) {}
      try { t.proc.disconnect(); } catch (_) {}
      try { t.sink.disconnect(); } catch (_) {}
    }
    listenTaps = [];
    if (listenAudioCtx) {
      try { void listenAudioCtx.close(); } catch (_) {}
      listenAudioCtx = null;
    }
    vadActive.them = false;
    vadActive.you = false;
    listenPending.them = 0;
    listenPending.you = 0;
  }

  async function startListen() {
    if (host.listening) return;
    // Order matters for macOS Allow dialogs: system-audio / Screen Recording first,
    // then Microphone — never ask for both at once.
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (_) {
      host.startTurn("Transcribe");
      const isWin = window.lyknOverlay?.platform === "win32";
      host.updateAnswer(
        isWin
          ? "LYKN couldn't start system-audio capture. Make sure nothing is blocking screen capture, then try Transcribe again."
          : "LYKN needs Screen Recording permission to capture system audio. Enable it in System Settings → Privacy & Security → Screen Recording, then try again.",
      );
      host.reportHeight();
      return;
    }
    const sysTracks = display.getAudioTracks();
    if (!sysTracks.length) {
      try { display.getTracks().forEach((t) => t.stop()); } catch (_) {}
      host.startTurn("Transcribe");
      const isWin = window.lyknOverlay?.platform === "win32";
      host.updateAnswer(
        isWin
          ? "Couldn't capture system audio. On Windows this uses loopback capture — try again, or restart LYKN if it still fails."
          : "Couldn't capture system audio. This needs macOS 13 (Ventura) or newer.",
      );
      host.reportHeight();
      return;
    }
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
    listenQueues.them = Promise.resolve();
    listenQueues.you = Promise.resolve();
    listenInterim.them = null;
    listenInterim.you = null;
    listenStartedAt = Date.now();
    transcriptText = "";
    listenFragments = [];
    listenFragSeq = 0;
    lastUtter.them = { norm: "", at: 0 };
    lastUtter.you = { norm: "", at: 0 };
    assistFeedEl.innerHTML = "";
    assistShownTitles = [];
    assistLastRanAt = 0;
    assistLastLen = 0;
    lastNotesLen = 0;
    lastNotesAt = 0;
    meetingVaultSaved = false;
    meetingSaving = false;
    if (liveSaveBtn) {
      liveSaveBtn.classList.remove("saved");
      liveSaveBtn.disabled = false;
    }
    if (liveSavedToastEl) liveSavedToastEl.hidden = true;
    liveBodyEl.innerHTML = "";
    notesSummaryEl.textContent = "";
    notesTopicsEl.innerHTML = "";
    notesTopicsEl.hidden = true;
    notesKeyEl.innerHTML = "";
    notesSuggestEl.innerHTML = "";
    notesActionsEl.innerHTML = "";
    notesQuestionsEl.innerHTML = "";
    notesKeyWrapEl.hidden = true;
    notesSuggestWrapEl.hidden = true;
    notesActionsWrapEl.hidden = true;
    if (notesQuestionsWrapEl) notesQuestionsWrapEl.hidden = true;
    host.liveNotesSnapshot = {
      keyPoints: [],
      actionItems: [],
      summary: "",
      questionsToAsk: [],
      suggestions: [],
      topics: [],
    };
    host.listening = true;
    host.applyLiveNotesLayout(true);
    switchLivePane("notes");
    setListenUi();
    if (notesTimer) clearInterval(notesTimer);
    notesTimer = setInterval(() => void refreshNotes(true), NOTES_INTERVAL_MS);
    setTimeout(() => {
      if (host.listening) void refreshNotes(true);
    }, 5000);
    sysTracks[0].addEventListener("ended", () => {
      if (host.listening) stopListen();
    });
    // Continuous PCM taps with VAD endpointing — 16 kHz mono is exactly what
    // Whisper ingests, and resampling here keeps upload sizes small.
    try {
      listenAudioCtx = new AudioContext({ sampleRate: LISTEN_SAMPLE_RATE });
    } catch (_) {
      listenAudioCtx = new AudioContext();
    }
    tapStreamWithVad(listenSysStream, "them");
    if (listenMicStream) tapStreamWithVad(listenMicStream, "you");
  }

  function stopListen() {
    host.listening = false;
    teardownListenTaps();
    setSpeakerTranscribing("them", false);
    setSpeakerTranscribing("you", false);
    if (assistTimer) {
      clearTimeout(assistTimer);
      assistTimer = null;
    }
    if (notesTimer) {
      clearInterval(notesTimer);
      notesTimer = null;
    }
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
    void (async () => {
      await refreshNotes(true);
      await saveMeetingToVault({ auto: true });
    })();
  }

  function closeLive() {
    if (host.listening) stopListen();
    host.applyLiveNotesLayout(false);
  }
  return {
    pushLiveState,
    startListen,
    stopListen,
    closeLive,
  };
}
