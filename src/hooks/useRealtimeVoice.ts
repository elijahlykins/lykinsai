/**
 * Low-latency speech-to-speech Voice Mode via the OpenAI Realtime API
 * (WebRTC). The browser opens a peer connection directly to OpenAI using a
 * short-lived ephemeral client secret minted by our server
 * (`POST /api/ai/realtime/session`) — the real API key never ships to the
 * client. Server-side VAD drives hands-free turn-taking; the model both
 * hears the mic and speaks back over the same connection.
 *
 * Grounding lives in the session `instructions`, assembled from the user's
 * LYKN context and passed through at session creation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api-config";
import { TUNE_VOICE_TOOL, applyVoiceInstructionTune } from "@/lib/voice/tuneInstructions";

export type RealtimeVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

interface UseRealtimeVoiceOptions {
  active: boolean;
  boardId?: string | null;
  voice?: string;
  /** Build the grounded system instructions for this session. */
  buildInstructions?: () => string | Promise<string>;
  /** Fired with the user's finalized speech transcript for a turn. */
  onUserTranscript?: (text: string) => void;
  /** Fired with the assistant's finalized spoken reply for a turn. */
  onAssistantReply?: (text: string) => void;
  /**
   * Fired when the voice agent pulls a saved vault item up on screen
   * (the `display_document` tool). The payload is a ChatNeuronVaultPayload
   * the UI renders in the embedded document reader.
   */
  onDisplayDocument?: (payload: unknown) => void;
}

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export function useRealtimeVoice({ active, boardId, voice, buildInstructions, onUserTranscript, onAssistantReply, onDisplayDocument }: UseRealtimeVoiceOptions) {
  const [state, setState] = useState<RealtimeVoiceState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [errorText, setErrorText] = useState("");

  const stateRef = useRef<RealtimeVoiceState>("idle");
  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const buildInstructionsRef = useRef(buildInstructions);
  const boardIdRef = useRef<string | null>(boardId ?? null);
  const voiceRef = useRef<string | undefined>(voice);
  const onUserTranscriptRef = useRef(onUserTranscript);
  const onAssistantReplyRef = useRef(onAssistantReply);
  const onDisplayDocumentRef = useRef(onDisplayDocument);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const replyRef = useRef("");
  // call_id -> tool name, captured from the function_call output item so we
  // know which tool to run when its arguments finish streaming.
  const toolNamesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => { buildInstructionsRef.current = buildInstructions; }, [buildInstructions]);
  useEffect(() => { boardIdRef.current = boardId ?? null; }, [boardId]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { onUserTranscriptRef.current = onUserTranscript; }, [onUserTranscript]);
  useEffect(() => { onAssistantReplyRef.current = onAssistantReply; }, [onAssistantReply]);
  useEffect(() => { onDisplayDocumentRef.current = onDisplayDocument; }, [onDisplayDocument]);

  const setVoiceState = useCallback((s: RealtimeVoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    try {
      const { supabase } = await import("@/lib/supabase");
      const sess = await supabase?.auth?.getSession?.();
      const token = sess?.data?.session?.access_token;
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch { /* anonymous */ }
    return headers;
  }, []);

  // Run a tool the realtime model asked for, then hand the result back over
  // the data channel and let the model continue speaking with it.
  const executeToolCall = useCallback(async (callId: string, name: string, argsJson: string) => {
    let output: unknown;
    // Self-tuning instructions persist to the user's LOCAL settings, so this
    // tool runs in the browser instead of the server dispatch endpoint.
    if (name === TUNE_VOICE_TOOL) {
      let params: unknown = {};
      try { params = JSON.parse(argsJson || "{}"); } catch { params = {}; }
      try { output = JSON.parse(await applyVoiceInstructionTune(params)); }
      catch { output = { ok: false, error: "tune_failed" }; }
    } else {
      try {
        const headers = await authHeaders();
        const res = await fetch(`${API_BASE_URL}/api/ai/realtime/tool`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name, arguments: argsJson || "{}", boardId: boardIdRef.current }),
        });
        output = await res.json().catch(() => ({ ok: false, error: "bad_tool_response" }));
      } catch {
        output = { ok: false, error: "tool_request_failed" };
      }
    }
    // The agent pulled a vault item up on screen (display_document). Hand the
    // payload to the UI so it opens the embedded reader, then strip it from
    // the model-facing result so the model doesn't try to read the raw payload.
    const display = (output as { display?: unknown })?.display;
    if (display) {
      try { onDisplayDocumentRef.current?.(display); } catch { /* ignore */ }
      try { delete (output as { display?: unknown }).display; } catch { /* ignore */ }
    }
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      }));
      // Ask the model to produce its spoken response now that it has the result.
      dc.send(JSON.stringify({ type: "response.create" }));
    } catch { /* ignore */ }
  }, [authHeaders]);

  const stopMonitor = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  const monitorFrame = useCallback(() => {
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / data.length);
    // While the assistant speaks, hold a gentle floor so the orb stays alive.
    const floor = stateRef.current === "speaking" ? 0.25 : 0;
    setMicLevel(Math.max(floor, Math.min(1, rms * 3.2)));
    rafRef.current = requestAnimationFrame(monitorFrame);
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    stopMonitor();
    try { dcRef.current?.close(); } catch { /* ignore */ }
    dcRef.current = null;
    try {
      pcRef.current?.getSenders?.().forEach((s) => { try { s.track?.stop(); } catch { /* ignore */ } });
      pcRef.current?.close();
    } catch { /* ignore */ }
    pcRef.current = null;
    try { micStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    micStreamRef.current = null;
    if (audioElRef.current) {
      try { audioElRef.current.pause(); audioElRef.current.srcObject = null; } catch { /* ignore */ }
      audioElRef.current = null;
    }
    try { void audioCtxRef.current?.close(); } catch { /* ignore */ }
    audioCtxRef.current = null;
    analyserRef.current = null;
    dataRef.current = null;
    toolNamesRef.current.clear();
    setMicLevel(0);
    setVoiceState("idle");
  }, [setVoiceState, stopMonitor]);

  const handleEvent = useCallback((evt: {
    type?: string;
    transcript?: string;
    delta?: string;
    error?: { message?: string };
    item?: { type?: string; name?: string; call_id?: string };
    call_id?: string;
    name?: string;
    arguments?: string;
  }) => {
    const type = evt?.type || "";
    switch (type) {
      case "input_audio_buffer.speech_started":
        // Barge-in / new turn: user is talking again.
        setVoiceState("listening");
        break;
      case "response.output_item.added":
      case "response.output_item.done":
        // Capture the tool name for this call_id so we can dispatch when its
        // arguments finish streaming.
        if (evt.item?.type === "function_call" && evt.item.call_id && evt.item.name) {
          toolNamesRef.current.set(evt.item.call_id, evt.item.name);
        }
        break;
      case "response.function_call_arguments.done": {
        const callId = evt.call_id || "";
        const toolName = evt.name || (callId ? toolNamesRef.current.get(callId) : "") || "";
        if (callId && toolName) {
          if (callId) toolNamesRef.current.delete(callId);
          setVoiceState("thinking");
          void executeToolCall(callId, toolName, evt.arguments || "{}");
        }
        break;
      }
      case "input_audio_buffer.speech_stopped":
        if (stateRef.current === "listening") setVoiceState("thinking");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (evt.transcript) {
          const t = String(evt.transcript).trim();
          setTranscript(t);
          if (t) { try { onUserTranscriptRef.current?.(t); } catch { /* ignore */ } }
        }
        break;
      case "response.created":
        replyRef.current = "";
        setReply("");
        setVoiceState("thinking");
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (stateRef.current !== "speaking") setVoiceState("speaking");
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        replyRef.current += evt.delta || "";
        setReply(replyRef.current);
        setVoiceState("speaking");
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const full = evt.transcript ? String(evt.transcript) : replyRef.current;
        if (evt.transcript) { replyRef.current = full; setReply(full); }
        const finalReply = String(full || "").trim();
        if (finalReply) { try { onAssistantReplyRef.current?.(finalReply); } catch { /* ignore */ } }
        break;
      }
      case "response.done":
        setVoiceState(mutedRef.current ? "idle" : "listening");
        break;
      case "error":
        // Most realtime errors are non-fatal (e.g. an empty turn). Only surface
        // if we never got connected.
        if (stateRef.current === "connecting") {
          setErrorText(evt.error?.message || "Realtime connection error.");
          setVoiceState("error");
        }
        break;
      default:
        break;
    }
  }, [setVoiceState, executeToolCall]);

  const connect = useCallback(async () => {
    setErrorText("");
    setTranscript("");
    setReply("");
    replyRef.current = "";
    setVoiceState("connecting");

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setErrorText("Voice isn't supported in this browser.");
      setVoiceState("error");
      return;
    }

    // 1) Build grounded instructions + mint ephemeral session token.
    let instructions = "";
    try { instructions = String((await buildInstructionsRef.current?.()) || ""); } catch { instructions = ""; }

    let ephemeral = "";
    let sessionModel = "gpt-realtime";
    try {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE_URL}/api/ai/realtime/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ instructions, voice: voiceRef.current, boardId: boardIdRef.current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.value) {
        setErrorText(String(data?.error || "Couldn't start voice session."));
        setVoiceState("error");
        return;
      }
      ephemeral = data.value;
      sessionModel = data.model || sessionModel;
    } catch {
      setErrorText("Couldn't reach the voice service.");
      setVoiceState("error");
      return;
    }
    if (!activeRef.current) return;

    // 2) Mic + peer connection.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!activeRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      micStreamRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio playback.
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => { if (e.streams[0]) audioEl.srcObject = e.streams[0]; };

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Mic level meter for the orb.
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      analyserRef.current = analyser;
      dataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));

      // Data channel for events.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (e) => {
        try { handleEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
      };
      dc.onopen = () => {
        if (!activeRef.current) return;
        setVoiceState("listening");
        stopMonitor();
        rafRef.current = requestAnimationFrame(monitorFrame);
      };

      // 3) SDP offer/answer with OpenAI.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch(`${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(sessionModel)}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${ephemeral}`, "Content-Type": "application/sdp" },
      });
      if (!sdpRes.ok) {
        setErrorText("Voice connection was refused.");
        setVoiceState("error");
        return;
      }
      const answerSdp = await sdpRes.text();
      if (!activeRef.current) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name || "";
      setErrorText(
        name === "NotAllowedError"
          ? "Microphone permission was denied. Enable it to use Voice Mode."
          : "Couldn't start the voice connection.",
      );
      setVoiceState("error");
    }
  }, [authHeaders, handleEvent, monitorFrame, setVoiceState, stopMonitor]);

  useEffect(() => {
    if (active) {
      activeRef.current = true;
      mutedRef.current = false;
      setMuted(false);
      void connect();
      return () => { teardown(); };
    }
    teardown();
    return undefined;
    // connect/teardown are stable; only re-run on `active`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    try { micStreamRef.current?.getAudioTracks?.().forEach((t) => { t.enabled = !next; }); } catch { /* ignore */ }
    if (next) {
      setMicLevel(0);
      if (stateRef.current === "listening") setVoiceState("idle");
    } else if (stateRef.current === "idle") {
      setVoiceState("listening");
    }
  }, [setVoiceState]);

  const interrupt = useCallback(() => {
    if (!activeRef.current) return;
    if (stateRef.current === "speaking") {
      try { dcRef.current?.send(JSON.stringify({ type: "response.cancel" })); } catch { /* ignore */ }
      setVoiceState(mutedRef.current ? "idle" : "listening");
    }
  }, [setVoiceState]);

  const retry = useCallback(() => {
    if (!activeRef.current) return;
    teardown();
    activeRef.current = true;
    void connect();
  }, [connect, teardown]);

  return { state, micLevel, muted, transcript, reply, errorText, toggleMute, interrupt, retry };
}
