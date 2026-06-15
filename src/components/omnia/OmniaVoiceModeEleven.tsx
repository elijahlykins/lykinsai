/**
 * ElevenLabs Conversational AI variant of Voice Mode.
 *
 * Mirrors the OpenAI Realtime overlay (same orb + minimal chrome) but drives
 * the conversation through ElevenLabs' Agents SDK. The agent uses a custom LLM
 * that points back at our server, so LYKN grounding + the same four tools are
 * reused. Per-user identity travels in the session token, which we inject into
 * the agent prompt via `overrides.agent.prompt.prompt` (the custom-LLM endpoint
 * reads `LYKN_SESSION_TOKEN=` back out of the system message).
 *
 * Kept as a separate component so the working OpenAI path in `OmniaVoiceMode`
 * is untouched; the provider switch happens in `OmniaVoiceMode`.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { API_BASE_URL } from "@/lib/api-config";
import { VOICE_FIRST_MESSAGE_OVERRIDE } from "@/lib/voice/voiceConfig";
import { getVoiceId } from "@/lib/ai-prefs";
import { TUNE_VOICE_TOOL, applyVoiceInstructionTune } from "@/lib/voice/tuneInstructions";
import VoiceTechOrb from "./VoiceTechOrb";

type VoiceUiState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

interface OmniaVoiceModeElevenProps {
  open: boolean;
  onClose: () => void;
  boardId?: string | null;
  buildInstructions?: () => string | Promise<string>;
  onUserTranscript?: (text: string) => void;
  onAssistantReply?: (text: string) => void;
  /**
   * Pull a saved vault item up on screen — fired when the agent calls the
   * `display_document` tool. Payload is a ChatNeuronVaultPayload the host
   * renders in the embedded document reader.
   */
  onDisplayDocument?: (payload: unknown) => void;
  /**
   * Handle a paste / file / link from the in-session paste bar. The host
   * mirrors it into the written chat and returns a text summary, which we
   * inject into the live session as a contextual update so the agent can
   * "see" what the user shared. Returns "" when nothing usable was pasted.
   */
  onAttach?: (input: { files?: File[]; text?: string }) => Promise<string>;
}

const STATUS_COPY: Record<VoiceUiState, string> = {
  idle: "Paused",
  connecting: "Connecting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

// What to show under the orb WHILE a tool is running, so the user sees what the
// agent is actually doing ("Searching your vault…") instead of a stale
// "Listening…". Keyed by the same tool names registered on the agent; anything
// unmapped falls back to a generic "Working on it…".
const TOOL_STATUS_COPY: Record<string, string> = {
  search_vault: "Searching your vault…",
  read_document: "Reading the document…",
  display_document: "Pulling that up…",
  web_search: "Searching the web…",
  web_fetch: "Reading the page…",
  find_connections: "Finding connections…",
  get_beliefs: "Reviewing your beliefs…",
  get_rules: "Checking your rules…",
  get_facts: "Recalling what it knows…",
  propose_fact: "Making a note of that…",
  list_projects: "Looking through your projects…",
  get_project_state: "Checking the project…",
  set_active_project: "Switching projects…",
  create_project: "Starting a new project…",
  update_project_state: "Updating the project…",
  get_recent_activity: "Catching up on recent activity…",
  create_reminder: "Setting a reminder…",
  list_reminders: "Checking your reminders…",
  update_reminder: "Updating the reminder…",
  create_event: "Adding to your calendar…",
  list_events: "Checking your calendar…",
  update_event: "Updating the event…",
  delete_event: "Removing the event…",
  create_todo: "Adding a to-do…",
  list_todos: "Checking your to-dos…",
  update_todo: "Updating the to-do…",
  delete_todo: "Removing the to-do…",
  list_custom_models: "Looking at your models…",
  communicate_with_model: "Consulting your model…",
  build_with_cursor: "Kicking off the build…",
  check_cursor_build: "Checking the build…",
  save_to_vault: "Saving to your vault…",
  add_to_project: "Adding it to the project…",
  [TUNE_VOICE_TOOL]: "Adjusting how it sounds…",
};

// Full synthesis-layer surface exposed to the voice agent. Each name must
// match a tool registered on the ElevenLabs agent and a case the server's
// /api/ai/realtime/tool dispatch handles.
const TOOL_NAMES = [
  "search_vault",
  "read_document",
  "display_document",
  "web_search",
  "web_fetch",
  "find_connections",
  "get_beliefs",
  "get_rules",
  "get_facts",
  "propose_fact",
  "list_projects",
  "get_project_state",
  "set_active_project",
  "create_project",
  "update_project_state",
  "get_recent_activity",
  "create_reminder",
  "list_reminders",
  "update_reminder",
  "create_event",
  "list_events",
  "update_event",
  "delete_event",
  "create_todo",
  "list_todos",
  "update_todo",
  "delete_todo",
  "list_custom_models",
  "communicate_with_model",
  "build_with_cursor",
  "check_cursor_build",
  "save_to_vault",
  // Add the file the user just shared in this session to a project ("add this
  // to my <project>"). Dispatched server-side; see /api/ai/realtime/tool.
  "add_to_project",
  // Handled client-side (rewrites the user's saved voice instructions); see
  // callTool's interception below — never forwarded to the server dispatch.
  TUNE_VOICE_TOOL,
] as const;

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { supabase } = await import("@/lib/supabase");
    const sess = await supabase?.auth?.getSession?.();
    const token = sess?.data?.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* anonymous */ }
  return headers;
}

function VoiceInner({ open, onClose, boardId, buildInstructions, onUserTranscript, onAssistantReply, onDisplayDocument, onAttach }: OmniaVoiceModeElevenProps) {
  const [uiState, setUiState] = useState<VoiceUiState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [errorText, setErrorText] = useState("");
  // Live "what the agent is doing right now" label, driven by tool calls.
  // activeToolsRef counts concurrent tools so the label only clears once they
  // ALL finish (multiple tools can run for a single turn).
  const [toolLabel, setToolLabel] = useState("");
  const activeToolsRef = useRef(0);

  // Paste-bar state: lets the user share links/images/PDFs/docs into the live
  // voice session. Each share is mirrored into the written chat and injected
  // into the conversation as a contextual update so the agent can see it.
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachToast, setAttachToast] = useState("");
  const [attachError, setAttachError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pasteInputRef = useRef<HTMLInputElement | null>(null);
  const attachToastTimerRef = useRef<number | null>(null);

  const startedRef = useRef(false);
  // Monotonic token: bumped whenever we (re)start or tear down a session, so an
  // in-flight async begin() can detect it was cancelled and abort/clean up.
  const beginGenRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const boardIdRef = useRef<string | null>(boardId ?? null);
  const buildInstructionsRef = useRef(buildInstructions);
  const onUserTranscriptRef = useRef(onUserTranscript);
  const onAssistantReplyRef = useRef(onAssistantReply);
  const onDisplayDocumentRef = useRef(onDisplayDocument);
  const onAttachRef = useRef(onAttach);
  useEffect(() => { boardIdRef.current = boardId ?? null; }, [boardId]);
  useEffect(() => { buildInstructionsRef.current = buildInstructions; }, [buildInstructions]);
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript; }, [onUserTranscript]);
  useEffect(() => { onAssistantReplyRef.current = onAssistantReply; }, [onAssistantReply]);
  useEffect(() => { onDisplayDocumentRef.current = onDisplayDocument; }, [onDisplayDocument]);
  useEffect(() => { onAttachRef.current = onAttach; }, [onAttach]);

  // One client-tool handler shape for all four; each forwards to the same
  // server dispatch endpoint the OpenAI Realtime path uses.
  const callTool = useCallback(async (name: string, params: unknown): Promise<string> => {
    // Surface what the agent is doing under the orb for the duration of the
    // call, then clear it once every concurrent tool for this turn has settled.
    activeToolsRef.current += 1;
    setToolLabel(TOOL_STATUS_COPY[name] || "Working on it…");
    try {
      // Self-tuning instructions are persisted in the user's LOCAL settings, so
      // this tool is handled in the browser instead of the server dispatch.
      if (name === TUNE_VOICE_TOOL) return await applyVoiceInstructionTune(params);
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE_URL}/api/ai/realtime/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, arguments: params ?? {}, boardId: boardIdRef.current }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "bad_tool_response" }));
      // The agent pulled a vault item up on screen (display_document). Open the
      // embedded reader, then strip the payload from the model-facing result so
      // the model speaks its short confirmation instead of the raw note JSON.
      const display = (data as { display?: unknown })?.display;
      if (display) {
        try { onDisplayDocumentRef.current?.(display); } catch { /* ignore */ }
        try { delete (data as { display?: unknown }).display; } catch { /* ignore */ }
      }
      return JSON.stringify(data);
    } catch {
      return JSON.stringify({ ok: false, error: "tool_request_failed" });
    } finally {
      activeToolsRef.current = Math.max(0, activeToolsRef.current - 1);
      if (activeToolsRef.current === 0) setToolLabel("");
    }
  }, []);

  const clientTools = React.useMemo(() => {
    const tools: Record<string, (params: unknown) => Promise<string>> = {};
    for (const name of TOOL_NAMES) tools[name] = (params: unknown) => callTool(name, params);
    return tools;
  }, [callTool]);

  const conversation = useConversation({
    clientTools,
    onConnect: () => { setErrorText(""); setUiState("listening"); },
    onDisconnect: () => setUiState("idle"),
    onError: (e: unknown) => {
      const msg = (e as { message?: string })?.message || (typeof e === "string" ? e : "Voice connection error.");
      setErrorText(msg);
      setUiState("error");
    },
    onModeChange: ({ mode }: { mode: "speaking" | "listening" }) =>
      setUiState(mode === "speaking" ? "speaking" : "listening"),
    onMessage: (m: { source?: string; message?: string }) => {
      const text = String(m?.message || "").trim();
      if (!text) return;
      if (m?.source === "user") { try { onUserTranscriptRef.current?.(text); } catch { /* ignore */ } }
      else if (m?.source === "ai") { try { onAssistantReplyRef.current?.(text); } catch { /* ignore */ } }
    },
  });

  const { startSession, endSession, status, isSpeaking, getInputVolume, getOutputVolume, sendContextualUpdate } =
    conversation as typeof conversation & { sendContextualUpdate?: (text: string) => void };

  // Keep the latest endSession in a ref so teardown always ends the CURRENT
  // session, even if the effect cleanup captured an earlier render's closure.
  const endSessionRef = useRef(endSession);
  useEffect(() => { endSessionRef.current = endSession; }, [endSession]);

  // Orb meter: agent output level while speaking, mic input level otherwise.
  useEffect(() => {
    if (!open) return undefined;
    const tick = () => {
      try {
        const v = isSpeaking ? getOutputVolume?.() : getInputVolume?.();
        const floor = isSpeaking ? 0.25 : 0;
        setMicLevel(Math.max(floor, Math.min(1, (Number(v) || 0) * 1.4)));
      } catch { /* ignore */ }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [open, isSpeaking, getInputVolume, getOutputVolume]);

  // Keep a coarse UI state in sync with the connection status.
  useEffect(() => {
    if (status === "connecting") setUiState((s) => (s === "error" ? s : "connecting"));
    else if (status === "disconnected") setUiState((s) => (s === "error" ? s : "idle"));
  }, [status]);

  const begin = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    const gen = ++beginGenRef.current;
    // True once the user has left Voice Mode (or restarted) while this async
    // begin() was still in flight. When that happens we must NOT bring up a
    // live session — otherwise the agent keeps listening/talking with no UI.
    const cancelled = () => beginGenRef.current !== gen;
    setErrorText("");
    setUiState("connecting");
    try {
      // Prompt for permission only; the SDK opens its own mic stream, so stop
      // these throwaway tracks immediately or the mic stays "live" after exit.
      const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try { permStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    } catch {
      if (cancelled()) return;
      setErrorText("Microphone permission was denied. Enable it to use Voice Mode.");
      setUiState("error");
      startedRef.current = false;
      return;
    }
    if (cancelled()) return;

    let instructions = "";
    try { instructions = String((await buildInstructionsRef.current?.()) || ""); } catch { instructions = ""; }
    if (cancelled()) return;

    let conversationToken = "";
    let signedUrl = "";
    let sessionToken = "";
    let serverFirstMessage = "";
    try {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE_URL}/api/ai/elevenlabs/signed-url`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          instructions,
          boardId: boardIdRef.current,
          // Browser IANA timezone so the voice model resolves clock times
          // ("3pm") to the user's local instant instead of UTC.
          timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (cancelled()) return;
      if (!res.ok || (!data?.conversationToken && !data?.signedUrl)) {
        setErrorText(String(data?.error || "Couldn't start voice session."));
        setUiState("error");
        startedRef.current = false;
        return;
      }
      conversationToken = data.conversationToken || "";
      signedUrl = data.signedUrl || "";
      sessionToken = data.sessionToken || "";
      serverFirstMessage = typeof data.firstMessage === "string" ? data.firstMessage : "";
    } catch {
      if (cancelled()) return;
      setErrorText("Couldn't reach the voice service.");
      setUiState("error");
      startedRef.current = false;
      return;
    }
    if (cancelled()) return;

    try {
      // The session token rides in the agent prompt so the custom-LLM endpoint
      // can bind this conversation to the LYKN user and inject grounding.
      //
      // Opening line precedence (the agent allows the first-message override):
      //   1. VITE_VOICE_FIRST_MESSAGE env override, when set (incl. "" to mute)
      //   2. the server's personalised, rotating greeting for this user
      // If neither yields a line, the agent's baked-in default plays.
      const firstMessage =
        VOICE_FIRST_MESSAGE_OVERRIDE !== null ? VOICE_FIRST_MESSAGE_OVERRIDE : serverFirstMessage;
      const agentOverride: Record<string, unknown> = {};
      if (sessionToken) agentOverride.prompt = { prompt: `LYKN_SESSION_TOKEN=${sessionToken}` };
      if (firstMessage) agentOverride.firstMessage = firstMessage;
      // The user's chosen voice (Settings → Display → Voice) overrides the
      // agent's baked-in default per session. Empty → keep the default voice.
      const chosenVoiceId = (() => { try { return getVoiceId(); } catch { return ""; } })();
      const overridesObj: Record<string, unknown> = {};
      if (Object.keys(agentOverride).length > 0) overridesObj.agent = agentOverride;
      if (chosenVoiceId) overridesObj.tts = { voiceId: chosenVoiceId };
      const overrides = Object.keys(overridesObj).length > 0 ? overridesObj : undefined;

      // Prefer the WebRTC (LiveKit) transport: its jitter buffer + packet-loss
      // concealment keep playback at a steady pitch/speed, fixing the random
      // "chipmunk" wobble the raw-PCM WebSocket transport produced under network
      // jitter. Overrides + dynamic variables travel the same on both, so
      // grounding / session-token injection are unaffected. We keep the signed
      // URL as a WebSocket fallback if WebRTC can't be established.
      const startWebRtc = () => startSession({
        conversationToken,
        connectionType: "webrtc",
        overrides,
      } as Parameters<typeof startSession>[0]);
      const startWebSocket = () => startSession({
        signedUrl,
        connectionType: "websocket",
        overrides,
      } as Parameters<typeof startSession>[0]);

      if (conversationToken) {
        try {
          await startWebRtc();
        } catch (rtcErr) {
          if (cancelled()) return;
          if (!signedUrl) throw rtcErr;
          await startWebSocket();
        }
      } else {
        await startWebSocket();
      }
      // The user left Voice Mode while we were connecting: the session is now
      // live but unwanted, so tear it right back down (otherwise it keeps
      // capturing the mic and talking with no UI to stop it).
      if (cancelled()) {
        try { void endSessionRef.current?.(); } catch { /* ignore */ }
        return;
      }
    } catch (e: unknown) {
      if (cancelled()) return;
      const msg = (e as { message?: string })?.message || "Couldn't start the voice connection.";
      setErrorText(msg);
      setUiState("error");
      startedRef.current = false;
    }
  }, [startSession]);

  const stop = useCallback(() => {
    startedRef.current = false;
    // Invalidate any begin() still in flight so it aborts before going live.
    beginGenRef.current++;
    try { void endSessionRef.current?.(); } catch { /* ignore */ }
    setMicLevel(0);
    setUiState("idle");
  }, []);

  useEffect(() => {
    if (open) { void begin(); return () => { stop(); }; }
    stop();
    return undefined;
    // begin/stop are stable; only re-run on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const retry = useCallback(() => { startedRef.current = false; void begin(); }, [begin]);

  // Cleanup the toast timer on unmount.
  useEffect(() => () => { if (attachToastTimerRef.current != null) window.clearTimeout(attachToastTimerRef.current); }, []);

  const flashToast = useCallback((msg: string) => {
    setAttachToast(msg);
    if (attachToastTimerRef.current != null) window.clearTimeout(attachToastTimerRef.current);
    attachToastTimerRef.current = window.setTimeout(() => setAttachToast(""), 2600);
  }, []);

  // Core share path: hand the raw paste to the host (mirrors it into the
  // written chat + builds a summary), then inject that summary into the live
  // session as a contextual update so the agent can reference it. Silent and
  // non-interrupting — the user can ask about the shared item by voice.
  const processAttach = useCallback(async (input: { files?: File[]; text?: string }) => {
    const files = (input.files || []).filter(Boolean);
    const text = String(input.text || "").trim();
    if (!files.length && !text) return;
    setAttachError("");
    setAttachBusy(true);
    try {
      const summary = await onAttachRef.current?.({ files, text });
      if (summary) {
        try { sendContextualUpdate?.(summary); } catch { /* not connected yet */ }
      }
      const label = files.length
        ? (files.length === 1 ? "Shared with LYKN" : `Shared ${files.length} files`)
        : "Shared with LYKN";
      flashToast(label);
    } catch {
      setAttachError("Couldn't share that. Try again.");
    } finally {
      setAttachBusy(false);
    }
  }, [sendContextualUpdate, flashToast]);

  const handlePasteBarPaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const files = e.clipboardData?.files ? Array.from(e.clipboardData.files) : [];
    const text = e.clipboardData?.getData("text/plain") || "";
    if (!files.length && !text.trim()) return;
    e.preventDefault();
    if (pasteInputRef.current) pasteInputRef.current.value = "";
    void processAttach({ files, text });
  }, [processAttach]);

  const handlePasteBarKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = e.currentTarget.value;
    if (pasteInputRef.current) pasteInputRef.current.value = "";
    void processAttach({ text: value });
  }, [processAttach]);

  const handleFilesPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    void processAttach({ files });
  }, [processAttach]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    const text = e.dataTransfer?.getData("text/plain") || "";
    void processAttach({ files, text });
  }, [processAttach]);

  return (
    <div
      className="relative flex flex-col items-center justify-center w-full"
      onDragOver={(e) => { if (onAttach) { e.preventDefault(); setDragActive(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragActive(false); }}
      onDrop={onAttach ? handleDrop : undefined}
    >
      <button
        type="button"
        onClick={() => { if (uiState === "speaking") { try { void endSession(); } catch { /* ignore */ } } }}
        className="relative flex flex-col items-center justify-center outline-none"
        aria-label="Voice orb"
      >
        <VoiceTechOrb state={uiState} micLevel={micLevel} size={320} />
        <div className="mt-10 flex flex-col items-center gap-2 text-center max-w-xl px-6">
          <span className="text-foreground/80 text-base font-medium">
            {uiState === "error"
              ? (errorText || STATUS_COPY.error)
              : (toolLabel || STATUS_COPY[uiState])}
          </span>
          {uiState === "error" && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); retry(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); retry(); } }}
              className="mt-1 px-4 py-1.5 rounded-full bg-foreground/10 hover:bg-foreground/15 text-foreground/80 text-sm transition-colors cursor-pointer"
            >
              Try again
            </span>
          )}
        </div>
      </button>

      {onAttach && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[68] w-full max-w-lg px-6 flex flex-col items-center gap-2">
          {(attachToast || attachError) && (
            <span
              className={`text-xs font-medium px-3 py-1 rounded-full ${
                attachError ? "bg-red-500/15 text-red-400" : "bg-emerald-500/15 text-emerald-400"
              }`}
            >
              {attachError || attachToast}
            </span>
          )}
          <div
            className={`flex items-center gap-2 w-full rounded-2xl border bg-foreground/[0.04] backdrop-blur px-3 py-2 transition-colors ${
              dragActive ? "border-primary/60 bg-primary/5" : "border-foreground/10"
            }`}
          >
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachBusy}
              className="shrink-0 grid place-items-center w-8 h-8 rounded-full text-foreground/60 hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-40"
              aria-label="Attach a file"
              title="Attach a file"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={pasteInputRef}
              type="text"
              inputMode="url"
              onPaste={handlePasteBarPaste}
              onKeyDown={handlePasteBarKeyDown}
              disabled={attachBusy}
              placeholder={attachBusy ? "Sharing…" : "Paste a link, image, PDF, doc — or drag & drop"}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground/40 outline-none disabled:opacity-50"
              aria-label="Paste links or files to share with the voice agent"
            />
            {attachBusy && (
              <span className="shrink-0 w-4 h-4 rounded-full border-2 border-foreground/20 border-t-foreground/70 animate-spin" />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.md,.rtf,.odt,audio/*,video/*"
            className="hidden"
            onChange={handleFilesPicked}
          />
        </div>
      )}
    </div>
  );
}

export default function OmniaVoiceModeEleven(props: OmniaVoiceModeElevenProps) {
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="voice-mode-eleven"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[67] flex flex-col items-center justify-center bg-background"
          role="dialog"
          aria-modal="false"
          aria-label="Voice Mode"
        >
          <ConversationProvider>
            <VoiceInner {...props} />
          </ConversationProvider>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
