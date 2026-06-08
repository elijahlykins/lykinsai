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
import VoiceTechOrb from "./VoiceTechOrb";

type VoiceUiState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

interface OmniaVoiceModeElevenProps {
  open: boolean;
  onClose: () => void;
  boardId?: string | null;
  buildInstructions?: () => string | Promise<string>;
  onUserTranscript?: (text: string) => void;
  onAssistantReply?: (text: string) => void;
}

const STATUS_COPY: Record<VoiceUiState, string> = {
  idle: "Paused",
  connecting: "Connecting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

// Full synthesis-layer surface exposed to the voice agent. Each name must
// match a tool registered on the ElevenLabs agent and a case the server's
// /api/ai/realtime/tool dispatch handles.
const TOOL_NAMES = [
  "search_vault",
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
  "update_project_state",
  "get_recent_activity",
  "create_reminder",
  "list_reminders",
  "update_reminder",
  "create_event",
  "list_events",
  "update_event",
  "delete_event",
  "list_custom_models",
  "communicate_with_model",
  "build_with_cursor",
  "check_cursor_build",
  "save_to_vault",
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

function VoiceInner({ open, onClose, boardId, buildInstructions, onUserTranscript, onAssistantReply }: OmniaVoiceModeElevenProps) {
  const [uiState, setUiState] = useState<VoiceUiState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [errorText, setErrorText] = useState("");

  const startedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const boardIdRef = useRef<string | null>(boardId ?? null);
  const buildInstructionsRef = useRef(buildInstructions);
  const onUserTranscriptRef = useRef(onUserTranscript);
  const onAssistantReplyRef = useRef(onAssistantReply);
  useEffect(() => { boardIdRef.current = boardId ?? null; }, [boardId]);
  useEffect(() => { buildInstructionsRef.current = buildInstructions; }, [buildInstructions]);
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript; }, [onUserTranscript]);
  useEffect(() => { onAssistantReplyRef.current = onAssistantReply; }, [onAssistantReply]);

  // One client-tool handler shape for all four; each forwards to the same
  // server dispatch endpoint the OpenAI Realtime path uses.
  const callTool = useCallback(async (name: string, params: unknown): Promise<string> => {
    try {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE_URL}/api/ai/realtime/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, arguments: params ?? {}, boardId: boardIdRef.current }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "bad_tool_response" }));
      return JSON.stringify(data);
    } catch {
      return JSON.stringify({ ok: false, error: "tool_request_failed" });
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

  const { startSession, endSession, status, isSpeaking, getInputVolume, getOutputVolume } = conversation;

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
    setErrorText("");
    setUiState("connecting");
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErrorText("Microphone permission was denied. Enable it to use Voice Mode.");
      setUiState("error");
      startedRef.current = false;
      return;
    }

    let instructions = "";
    try { instructions = String((await buildInstructionsRef.current?.()) || ""); } catch { instructions = ""; }

    let signedUrl = "";
    let sessionToken = "";
    let serverFirstMessage = "";
    try {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE_URL}/api/ai/elevenlabs/signed-url`, {
        method: "POST",
        headers,
        body: JSON.stringify({ instructions, boardId: boardIdRef.current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.signedUrl) {
        setErrorText(String(data?.error || "Couldn't start voice session."));
        setUiState("error");
        startedRef.current = false;
        return;
      }
      signedUrl = data.signedUrl;
      sessionToken = data.sessionToken || "";
      serverFirstMessage = typeof data.firstMessage === "string" ? data.firstMessage : "";
    } catch {
      setErrorText("Couldn't reach the voice service.");
      setUiState("error");
      startedRef.current = false;
      return;
    }

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
      const overrides = Object.keys(agentOverride).length > 0 ? { agent: agentOverride } : undefined;
      await startSession({
        signedUrl,
        // A signed URL only supports the WebSocket transport (WebRTC requires a
        // conversation token instead). Audio still streams directly to
        // ElevenLabs/LiveKit — this only changes the signaling transport.
        connectionType: "websocket",
        overrides,
      } as Parameters<typeof startSession>[0]);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || "Couldn't start the voice connection.";
      setErrorText(msg);
      setUiState("error");
      startedRef.current = false;
    }
  }, [startSession]);

  const stop = useCallback(() => {
    startedRef.current = false;
    try { void endSession(); } catch { /* ignore */ }
    setMicLevel(0);
    setUiState("idle");
  }, [endSession]);

  useEffect(() => {
    if (open) { void begin(); return () => { stop(); }; }
    stop();
    return undefined;
    // begin/stop are stable; only re-run on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const retry = useCallback(() => { startedRef.current = false; void begin(); }, [begin]);

  return (
    <button
      type="button"
      onClick={() => { if (uiState === "speaking") { try { void endSession(); } catch { /* ignore */ } } }}
      className="relative flex flex-col items-center justify-center outline-none"
      aria-label="Voice orb"
    >
      <VoiceTechOrb state={uiState} micLevel={micLevel} size={320} />
      <div className="mt-10 flex flex-col items-center gap-2 text-center max-w-xl px-6">
        <span className="text-foreground/80 text-base font-medium">
          {uiState === "error" ? (errorText || STATUS_COPY.error) : STATUS_COPY[uiState]}
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
