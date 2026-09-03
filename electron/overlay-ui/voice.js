// Overlay live-voice session: ElevenLabs transport, screen push, tool bridge.

export function attachVoice(host) {
  const voiceEl = document.getElementById("voice");
  const VOICE_TOOL_NAMES = [
    "web_search", "web_fetch",
    "memory_list", "memory_read", "memory_patch", "memory_create", "memory_forget",
    "list_projects", "get_project_state", "set_active_project", "create_project",
    "update_project", "resolve_project", "update_project_state", "delete_project",
    "merge_projects", "get_recent_activity", "create_reminder", "list_reminders",
    "update_reminder", "create_event", "list_events", "update_event", "delete_event",
    "create_todo", "list_todos", "update_todo", "delete_todo", "build_with_cursor",
    "check_cursor_build", "save_to_vault", "save_link_to_vault", "add_to_project",
    "get_current_time", "calculate", "symbolic_math", "run_python", "run_code",
    "http_request", "get_preferences", "update_preference",
    "list_steward_items", "create_steward_item", "update_steward_item",
    "write_document", "save_file_to_vault", "open_app", "open_settings",
    "generate_image", "process_image", "generate_speech", "transcribe_audio",
    "parse_document", "translate", "generate_chart", "generate_diagram",
    "build_spreadsheet", "build_template", "build_react_artifact", "render_video",
    "manage_file", "list_apps", "call_app",
    "local_list_dir", "local_read_file", "local_search_files", "local_pull_file",
    "local_write_file", "local_edit_file", "local_run_command", "local_synced_folders",
    "local_running_apps", "local_read_app", "local_open_app", "local_open_path",
    "local_organize_desktop",
  ];
  let voiceConvo = null;
  let voiceConnected = false;
  let voiceAwaitingAnswer = false;
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

  // Voice turns start with the same thinking spinner as typed chat. When voice
  // ends (or an answer lands), that spinner must be cleared — otherwise it keeps
  // animating until the thread is wiped by a new chat.
  function finalizeVoiceTurn({ removeEmpty = false } = {}) {
    voiceAwaitingAnswer = false;
    host.answerStillWorking = false;
    host.clearBuildingUnder();
    if (removeEmpty && host.currentAnswerEl && !host.currentHasText) {
      const chat = host.currentAnswerEl.closest(".chat");
      if (chat) chat.remove();
      host.currentAnswerEl = null;
      host.currentChatEl = null;
      host.currentQuestion = "";
      host.currentHasText = false;
      if (!host.threadEl.querySelector(".chat")) host.threadEl.classList.remove("show");
    }
    host.reportHeight();
  }

  // Feed the current screen to the live agent as contextual text, so voice mode
  // "sees" the screen like the typed chat does. Throttled (vision calls are slow)
  // and non-interrupting; the agent silently absorbs it for the next user turn.
  let lastScreenPushAt = 0;
  let screenPushInFlight = false;

  async function pushScreenContext(force) {
    // Only needs the session token — we deliberately allow pushes during connect
    // so a fresh screen is already in the server grounding by the user's 1st turn.
    if (!host.voiceSessionToken) return;
    if (screenPushInFlight) return;
    const now = Date.now();
    // Live Watch already maintains a rolling summary — push more often (2s) since
    // main reuses it instead of running a fresh vision call each time.
    const minGap = host.liveWatchEnabled ? 2000 : 4000;
    if (!force && now - lastScreenPushAt < minGap) return;
    screenPushInFlight = true;
    lastScreenPushAt = now;
    try {
      // main captures + describes the screen and pushes it to the live session's
      // server-side grounding, so the custom-LLM injects it into every turn.
      await window.lyknOverlay.voiceScreen(host.voiceSessionToken);
    } catch (_) {
      /* ignore — screen context is best-effort */
    } finally {
      screenPushInFlight = false;
    }
  }

  async function startOverlayBrowserAgent(params) {
    const task = String(params?.task || params?.message || "").trim();
    const url = String(params?.url || "").trim();
    if (!task) return { ok: false, error: "No task was provided for the browser agent." };
    const goal = url ? `${task}\n\nStart at: ${url}` : task;
    try {
      const created = await window.lyknOverlay.agentCreate({ goal });
      const agentId = created?.ok && created.agentId ? String(created.agentId) : "";
      void window.lyknOverlay.agentSend(agentId, goal, []).catch(() => {});
      try { await window.lyknOverlay.agentShowBrowser(agentId, true); } catch (_) { /* reveal is best-effort */ }
      if (window.lyknOverlay?.glassAgentModeEnabled === true) {
        try { await window.lyknOverlay.agentModeSet(true); } catch (_) { /* same */ }
      }
      return {
        ok: true,
        note:
          "The browser agent is now running the task in its own tab. Tell the user it's underway " +
          "and they can watch or take over. Do not describe steps as if you performed them.",
      };
    } catch (_) {
      return { ok: false, error: "Couldn't start the browser agent." };
    }
  }

  function buildVoiceTools() {
    const tools = {};
    for (const name of VOICE_TOOL_NAMES) {
      tools[name] = async (params) => {
        try {
          if (name.startsWith("local_")) {
            const run = window.lyknOverlay?.localToolRun;
            if (typeof run === "function") {
              let data = await run(name, params ?? {});
              if (data && data.needsApproval === true) {
                const ok = window.confirm(String(data.summary || "Run this on your Mac?"));
                if (!ok) return JSON.stringify({ ok: false, error: "You declined this action." });
                data = await run(name, params ?? {}, { approvalToken: data.approvalToken || "" });
              }
              return JSON.stringify(data);
            }
          }
          const data = await window.lyknOverlay.voiceTool(name, params ?? {});
          return JSON.stringify(data);
        } catch (_) {
          return JSON.stringify({ ok: false, error: "tool_request_failed" });
        }
      };
    }
    // Local-only voice-instruction tuning isn't managed by the overlay; ack it.
    tools["update_voice_instructions"] = async () => JSON.stringify({ ok: true });
    tools.browser_agent = async (params) => JSON.stringify(await startOverlayBrowserAgent(params));
    // Overlay has no bot roster. Send the same work to the browser agent so
    // "send a bot to this site" still starts the job.
    tools.ask_bot = async (params) => JSON.stringify(await startOverlayBrowserAgent(params));
    return tools;
  }

  const voicePillEl = document.getElementById("voice-pill");

  function setVoiceUi(state) {
    // state: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'off'
    const on = state !== "off";
    const pillWasHidden = !voicePillEl || voicePillEl.hidden;
    voiceEl.classList.toggle("voice-active", on);
    host.micEl.classList.toggle("voice-active", on);
    if (voicePillEl) voicePillEl.hidden = !on;
    host.dotEl.classList.toggle("busy", on && state !== "listening");
    voiceEl.title = on ? "Stop voice mode" : "Voice mode";
    const voiceLabel = document.getElementById("voice-label");
    if (voiceLabel) voiceLabel.textContent = on ? "Stop voice mode" : "Voice mode";
    // Mic doubles as a stop button while voice is live (square icon via CSS).
    if (on) {
      host.micEl.title = "Stop voice mode";
      host.micEl.setAttribute("aria-label", "Stop voice mode");
      host.micEl.disabled = false;
    } else if (!host.recording && !host.transcribing) {
      host.micEl.title = "Dictate";
      host.micEl.setAttribute("aria-label", "Dictate");
    }
    // The composer stays ENABLED during voice — typed prompts/links route into
    // the live voice session via sendTextToVoice() instead of the streamed chat.
    host.askEl.disabled = false;
    if (on) {
      host.askEl.placeholder =
        state === "connecting"
          ? "Connecting voice…"
          : state === "speaking"
            ? "LYKN is speaking… type to chime in"
            : state === "thinking"
              ? "Thinking…"
              : "Listening… speak or type (Esc stops voice)";
    } else {
      host.askEl.placeholder = host.COMPOSER_MODES[host.composerMode].placeholder;
    }
    // Resize only when the Voice chip appears/disappears.
    if (pillWasHidden === on) host.reportHeight();
  }

  if (voicePillEl) {
    voicePillEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (host.voiceActive || host.voiceStarting) void stopVoice();
    });
  }

  function voiceUserMessage(text) {
    const t = String(text || "").trim();
    if (!t) return;
    host.startTurn(t);
    host.setThinkingStatus("Thinking…");
    voiceAwaitingAnswer = true;
  }

  // ── Typed messages into the live voice session ──────────────────────────────
  // The composer stays usable during voice: host.ask() routes typed prompts here.
  // The ElevenLabs SDK's sendUserMessage() delivers the text as a normal user
  // turn, so the agent answers it out loud (and can run tools on it — fetch a
  // pasted link, save it to the vault, etc.). We render the turn locally and
  // suppress the transcript echo the server sends back for the same text.
  let lastTypedVoiceText = "";
  let lastTypedVoiceAt = 0;

  function sendTextToVoice(text, atts) {
    if (!voiceConvo || typeof voiceConvo.sendUserMessage !== "function") {
      // Still connecting — keep the draft in the composer so nothing is lost.
      host.askEl.placeholder = "Voice is still connecting. Try again in a second…";
      return false;
    }
    const q = String(text || "").trim();
    const parts = [];
    if (q) parts.push(q);
    // Text host.attachments (files/snips with extracted text) ride along inline; the
    // voice LLM is text-only, so images are named rather than sent.
    for (const a of atts || []) {
      if (!a) continue;
      if (a.kind === "text" && a.text) {
        parts.push(`[Attached file "${a.name || "file"}"]\n${String(a.text).slice(0, 6000)}`);
      } else if (a.kind === "image") {
        parts.push(
          `[The user attached an image ("${a.name || "image"}"). Its pixels are not available in voice mode — ask them to describe it or to share it in the regular chat if you need its contents.]`,
        );
      }
    }
    if (!parts.length) return false;
    const message = parts.join("\n\n");
    try {
      voiceConvo.sendUserMessage(message);
    } catch (_) {
      voiceError("Couldn't send that to the voice agent. Try again.");
      return false;
    }
    lastTypedVoiceText = message;
    lastTypedVoiceAt = Date.now();
    const label = q || (atts && atts.length ? `Sent ${atts.length} attachment(s)` : message);
    voiceUserMessage(label);
    history.push({ role: "user", content: message, at: new Date().toISOString() });
    // Keep the server's screen grounding fresh for this turn (throttled).
    void pushScreenContext(false);
    return true;
  }

  function voiceAiMessage(text) {
    const t = String(text || "").trim();
    if (!t) return;
    if (!voiceAwaitingAnswer || !host.currentAnswerEl) host.startTurn("LYKN");
    host.updateAnswer(t);
    history.push({ role: "assistant", content: t, at: new Date().toISOString() });
    void host.persistCurrentSession();
    finalizeVoiceTurn();
  }

  function voiceError(message) {
    host.startTurn("Voice mode");
    host.updateAnswer(message);
    finalizeVoiceTurn();
    host.reportHeight();
  }

  async function startVoice() {
    if (host.voiceActive || host.voiceStarting) return;
    if (!window.ElevenLabsClient || !window.ElevenLabsClient.Conversation) {
      voiceError("Voice mode couldn't load. Try reopening LYKN.");
      return;
    }

    const myGen = ++voiceGen;
    // Stale if the user toggled voice off (or restarted it) while this async
    // start was still in flight. When stale we must never bring a session live.
    const cancelled = () => voiceGen !== myGen;

    host.voiceStarting = true;
    host.voiceActive = false;
    voiceConnected = false;
    setVoiceUi("connecting");

    // Watchdog: if we never reach a connected state, tear it all down instead of
    // showing "Connecting voice…" forever (e.g. WebRTC TURN resolution stalls).
    clearVoiceTimer();
    voiceConnectTimer = setTimeout(() => {
      if (cancelled() || voiceConnected) return;
      voiceGen += 1; // invalidate this attempt
      host.voiceStarting = false;
      host.voiceActive = false;
      const c = voiceConvo;
      voiceConvo = null;
      try { if (c && typeof c.endSession === "function") c.endSession(); } catch (_) {}
      setVoiceUi("off");
      finalizeVoiceTurn({ removeEmpty: true });
      voiceError("Voice connection timed out. Please try again.");
    }, 15000);

    const ok = await window.lyknOverlay.ensureMic();
    if (cancelled()) return;
    if (!ok) {
      clearVoiceTimer();
      host.voiceStarting = false;
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
    let localModeOn = false;
    try {
      const lm = await window.lyknOverlay.localModeGet();
      localModeOn = lm && lm.enabled === true;
    } catch (_) { /* Local Mode stays off */ }
    const screenInstructions =
      "You are LYKN running inside an on-screen overlay on the user's Mac, and you CAN see " +
      "the user's screen. The current screen contents are continuously provided to you as " +
      "contextual updates that start with \"SCREEN CONTENTS\". Treat those as your live view " +
      "of what is on the user's screen right now and use them to answer questions about what " +
      "they are looking at. Never tell the user you are unable to see or read their screen.";
    const data = await window.lyknOverlay.voiceSignedUrl({
      instructions: screenInstructions,
      timezone,
      desktop: localModeOn,
      localMode: localModeOn,
    });
    if (cancelled()) return;
    if (!data || data.error || (!data.conversationToken && !data.signedUrl)) {
      clearVoiceTimer();
      host.voiceStarting = false;
      setVoiceUi("off");
      voiceError((data && data.error) || "Couldn't start voice session.");
      return;
    }

    // Keep the session token so we can push screen context to the server grounding.
    host.voiceSessionToken = data.sessionToken || "";
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
        host.voiceActive = true;
        host.voiceStarting = false;
        setVoiceUi("listening");
        // Prime the agent with the current screen right away.
        void pushScreenContext(true);
      },
      onDisconnect: () => {
        if (cancelled()) return;
        clearVoiceTimer();
        host.voiceActive = false;
        host.voiceStarting = false;
        voiceConnected = false;
        voiceConvo = null;
        host.voiceSessionToken = "";
        setVoiceUi("off");
        finalizeVoiceTurn({ removeEmpty: true });
      },
      onError: (e) => {
        if (cancelled()) return;
        clearVoiceTimer();
        const msg = (e && e.message) || (typeof e === "string" ? e : "Voice connection error.");
        host.voiceActive = false;
        host.voiceStarting = false;
        voiceConnected = false;
        voiceConvo = null;
        host.voiceSessionToken = "";
        setVoiceUi("off");
        finalizeVoiceTurn({ removeEmpty: true });
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
          // Typed messages are already rendered by sendTextToVoice(); skip the
          // transcript echo the server sends back for the same text.
          if (text === lastTypedVoiceText && Date.now() - lastTypedVoiceAt < 15000) return;
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
      host.voiceStarting = false;
      host.voiceActive = false;
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
    host.voiceActive = true;
    host.voiceStarting = false;
    // onConnect may have fired before voiceConvo was assigned (so its push was a
    // no-op); now that the handle exists, prime the agent with the screen.
    void pushScreenContext(true);
  }

  async function stopVoice() {
    voiceGen += 1; // invalidate any in-flight start so it can't go live
    clearVoiceTimer();
    host.voiceStarting = false;
    host.voiceActive = false;
    voiceConnected = false;
    host.voiceSessionToken = "";
    const c = voiceConvo;
    voiceConvo = null;
    setVoiceUi("off");
    // Drop any in-flight "Thinking…" turn so the spinner doesn't keep running
    // after the user leaves voice mode.
    finalizeVoiceTurn({ removeEmpty: true });
    try {
      if (c && typeof c.endSession === "function") await c.endSession();
    } catch (_) {}
  }

  voiceEl.addEventListener("click", () => {
    if (host.voiceActive || host.voiceStarting) void stopVoice();
    else void startVoice();
  });
  return {
    stopVoice,
    startVoice,
    sendTextToVoice,
    pushScreenContext,
  };
}
