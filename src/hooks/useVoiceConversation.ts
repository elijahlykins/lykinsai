/**
 * Hands-free voice conversation loop for Voice Mode.
 *
 * ChatGPT-style: while active, it continuously listens, detects when the
 * user stops speaking (energy-based VAD over the Web Audio analyser),
 * transcribes the utterance, sends it through the chat pipeline, speaks the
 * reply, then loops back to listening — no buttons required.
 *
 * The caller owns the chat pipeline via `sendTurn(text) -> replyText`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api-config";
import { preferredAudioMimeType } from "@/lib/vault/saveVoiceNote";

export type VoiceConvoState =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

interface UseVoiceConversationOptions {
  active: boolean;
  boardId?: string | null;
  sendTurn: (text: string) => Promise<string>;
}

// VAD / loop tuning. Values are deliberately forgiving so half-second pauses
// mid-sentence don't cut the user off, while a clear ~1s pause ends the turn.
const SPEECH_RMS = 0.045; // above this = the user is talking
const SILENCE_RMS = 0.03; // below this = ambient / silence
const SILENCE_HOLD_MS = 1100; // trailing silence that ends an utterance
const MAX_UTTERANCE_MS = 30_000; // hard cap so a stuck mic can't run forever
const MIN_SPEECH_MS = 350; // ignore blips (clicks, coughs)
const MIN_BLOB_BYTES = 2400;

export function useVoiceConversation({ active, boardId, sendTurn }: UseVoiceConversationOptions) {
  const [state, setState] = useState<VoiceConvoState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [errorText, setErrorText] = useState("");

  // Imperative state mirrored into refs so the long-lived RAF / recorder
  // callbacks never read stale React state.
  const stateRef = useRef<VoiceConvoState>("idle");
  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const sendTurnRef = useRef(sendTurn);
  const boardIdRef = useRef<string | null>(boardId ?? null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  // Per-utterance VAD bookkeeping.
  const utteranceStartRef = useRef(0);
  const lastVoiceTsRef = useRef(0);
  const hasSpokenRef = useRef(false);
  const speechMsRef = useRef(0);

  useEffect(() => { sendTurnRef.current = sendTurn; }, [sendTurn]);
  useEffect(() => { boardIdRef.current = boardId ?? null; }, [boardId]);

  const setVoiceState = useCallback((s: VoiceConvoState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const stopMonitor = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const stopRecorder = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try { rec.stop(); } catch { /* ignore */ }
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    try { ttsAbortRef.current?.abort(); } catch { /* ignore */ }
    ttsAbortRef.current = null;
    void import("@/lib/ai/speakText").then((m) => m.stopSpeaking()).catch(() => {});
  }, []);

  // Forward declaration so the recorder's onstop can re-arm listening.
  const beginListeningRef = useRef<() => void>(() => {});

  const transcribeBlob = useCallback(async (blob: Blob): Promise<string> => {
    const headers: Record<string, string> = {};
    try {
      const { supabase } = await import("@/lib/supabase");
      const sess = await supabase?.auth?.getSession?.();
      const token = sess?.data?.session?.access_token;
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch { /* anonymous */ }
    const formData = new FormData();
    formData.append("audio", blob, "voice-turn.webm");
    formData.append("model", "whisper-1");
    formData.append("language", "en");
    const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, { method: "POST", headers, body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return "";
    return String(data?.text || "").trim();
  }, []);

  const handleUtteranceEnd = useCallback(async () => {
    stopMonitor();
    setMicLevel(0);
    const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || preferredAudioMimeType() });
    chunksRef.current = [];

    const spokeEnough = hasSpokenRef.current && speechMsRef.current >= MIN_SPEECH_MS && blob.size >= MIN_BLOB_BYTES;
    if (!activeRef.current) return;
    // Muted mid-utterance (user tapped mute to stop): drop it, don't send.
    if (mutedRef.current) { setVoiceState("idle"); return; }
    if (!spokeEnough) {
      // Nothing meaningful captured — keep listening (unless muted/closed).
      if (!mutedRef.current) beginListeningRef.current();
      return;
    }

    setVoiceState("transcribing");
    let text = "";
    try {
      text = await transcribeBlob(blob);
    } catch { text = ""; }
    if (!activeRef.current) return;
    if (!text) {
      if (!mutedRef.current) beginListeningRef.current();
      return;
    }
    setTranscript(text);

    setVoiceState("thinking");
    let replyText = "";
    try {
      replyText = await sendTurnRef.current(text);
    } catch { replyText = ""; }
    if (!activeRef.current) return;

    if (!replyText) {
      if (!mutedRef.current) beginListeningRef.current();
      return;
    }
    setReply(replyText);

    setVoiceState("speaking");
    try {
      const abort = new AbortController();
      ttsAbortRef.current = abort;
      const { speakText } = await import("@/lib/ai/speakText");
      await speakText(replyText, { boardId: boardIdRef.current, signal: abort.signal });
    } catch { /* fall through to listening */ }
    if (ttsAbortRef.current) ttsAbortRef.current = null;
    if (!activeRef.current) return;
    if (!mutedRef.current) beginListeningRef.current();
    else setVoiceState("idle");
  }, [setVoiceState, stopMonitor, transcribeBlob]);

  const monitorFrame = useCallback(() => {
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data);
    // RMS of the centered waveform → 0..~1 loudness estimate.
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / data.length);
    setMicLevel(Math.min(1, rms * 3.2));

    const now = performance.now();
    if (rms > SPEECH_RMS) {
      if (!hasSpokenRef.current) hasSpokenRef.current = true;
      lastVoiceTsRef.current = now;
      speechMsRef.current += 16;
    }
    const sinceVoice = now - lastVoiceTsRef.current;
    const total = now - utteranceStartRef.current;
    const ended =
      (hasSpokenRef.current && rms < SILENCE_RMS && sinceVoice > SILENCE_HOLD_MS) ||
      total > MAX_UTTERANCE_MS;
    if (ended) {
      stopRecorder();
      return; // onstop drives the next step
    }
    rafRef.current = requestAnimationFrame(monitorFrame);
  }, [stopRecorder]);

  const beginListening = useCallback(() => {
    if (!activeRef.current || mutedRef.current) return;
    const stream = streamRef.current;
    if (!stream) return;
    // Reset per-utterance VAD state.
    chunksRef.current = [];
    hasSpokenRef.current = false;
    speechMsRef.current = 0;
    utteranceStartRef.current = performance.now();
    lastVoiceTsRef.current = performance.now();

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      setErrorText("Recording isn't supported in this browser.");
      setVoiceState("error");
      return;
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => { void handleUtteranceEnd(); };
    recorder.onerror = () => { void handleUtteranceEnd(); };
    recorder.start(250); // timeslice so chunks flush during long turns

    setVoiceState("listening");
    stopMonitor();
    rafRef.current = requestAnimationFrame(monitorFrame);
  }, [handleUtteranceEnd, monitorFrame, setVoiceState, stopMonitor]);

  useEffect(() => { beginListeningRef.current = beginListening; }, [beginListening]);

  const teardown = useCallback(() => {
    activeRef.current = false;
    stopMonitor();
    stopSpeaking();
    stopRecorder();
    recorderRef.current = null;
    chunksRef.current = [];
    try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    streamRef.current = null;
    try { void audioCtxRef.current?.close(); } catch { /* ignore */ }
    audioCtxRef.current = null;
    analyserRef.current = null;
    dataRef.current = null;
    setMicLevel(0);
    setVoiceState("idle");
  }, [setVoiceState, stopMonitor, stopRecorder, stopSpeaking]);

  const init = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorText("Microphone access isn't available here.");
      setVoiceState("error");
      return;
    }
    setVoiceState("connecting");
    setErrorText("");
    setTranscript("");
    setReply("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!activeRef.current) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        return;
      }
      streamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      beginListening();
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name || "";
      setErrorText(
        name === "NotAllowedError"
          ? "Microphone permission was denied. Enable it to use Voice Mode."
          : "Couldn't access your microphone.",
      );
      setVoiceState("error");
    }
  }, [beginListening, setVoiceState]);

  // Start / stop with the overlay's `active` flag.
  useEffect(() => {
    if (active) {
      activeRef.current = true;
      mutedRef.current = false;
      setMuted(false);
      void init();
      return () => { teardown(); };
    }
    teardown();
    return undefined;
    // init/teardown are stable; we only want this to fire on `active`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      // Mute: stop capturing + cut playback, park in idle.
      stopMonitor();
      stopRecorder();
      stopSpeaking();
      setMicLevel(0);
      setVoiceState("idle");
    } else if (activeRef.current) {
      beginListening();
    }
  }, [beginListening, setVoiceState, stopMonitor, stopRecorder, stopSpeaking]);

  // Tap-to-interrupt: if LYKN is speaking, stop and listen immediately.
  const interrupt = useCallback(() => {
    if (!activeRef.current) return;
    if (stateRef.current === "speaking") {
      stopSpeaking();
      if (!mutedRef.current) beginListening();
    }
  }, [beginListening, stopSpeaking]);

  return {
    state,
    micLevel,
    muted,
    transcript,
    reply,
    errorText,
    toggleMute,
    interrupt,
    retry: init,
  };
}
