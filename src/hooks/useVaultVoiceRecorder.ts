import { useCallback, useEffect, useRef, useState } from "react";
import { preferredAudioMimeType } from "@/lib/vault/saveVoiceNote";

type RecorderPhase = "idle" | "recording" | "processing";

type UseVaultVoiceRecorderOptions = {
  onBlobReady?: (blob: Blob, mimeType: string) => void | Promise<void>;
  disabled?: boolean;
};

export function useVaultVoiceRecorder(opts: UseVaultVoiceRecorderOptions = {}) {
  const { onBlobReady, disabled = false } = opts;
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef(preferredAudioMimeType());
  const onBlobReadyRef = useRef(onBlobReady);
  const discardRef = useRef(false);

  useEffect(() => {
    onBlobReadyRef.current = onBlobReady;
  }, [onBlobReady]);

  const cleanupStream = useCallback(() => {
    try {
      mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    } catch {
      /* ignore */
    }
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  useEffect(() => () => {
    try {
      if (mediaRecorderRef.current?.state !== "inactive") {
        mediaRecorderRef.current?.stop();
      }
    } catch {
      /* ignore */
    }
    cleanupStream();
  }, [cleanupStream]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      setPhase("idle");
      cleanupStream();
    }
  }, [cleanupStream]);

  const startRecording = useCallback(async () => {
    if (disabled || phase !== "idle") return false;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return false;
    }

    const mimeType = preferredAudioMimeType();
    mimeTypeRef.current = mimeType;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        cleanupStream();
        const blob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current });
        audioChunksRef.current = [];
        if (discardRef.current) {
          discardRef.current = false;
          setPhase("idle");
          return;
        }
        setPhase("processing");
        try {
          await onBlobReadyRef.current?.(blob, mimeTypeRef.current);
        } finally {
          setPhase("idle");
        }
      };

      recorder.onerror = () => {
        setPhase("idle");
        cleanupStream();
      };

      recorder.start();
      setPhase("recording");
      return true;
    } catch {
      cleanupStream();
      setPhase("idle");
      return false;
    }
  }, [cleanupStream, disabled, phase]);

  const cancelRecording = useCallback(() => {
    discardRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      cleanupStream();
      setPhase("idle");
      discardRef.current = false;
      return;
    }
    try {
      recorder.stop();
    } catch {
      discardRef.current = false;
      setPhase("idle");
      cleanupStream();
    }
  }, [cleanupStream]);

  const toggleRecording = useCallback(() => {
    if (phase === "recording") {
      stopRecording();
      return;
    }
    void startRecording();
  }, [phase, startRecording, stopRecording]);

  return {
    phase,
    isRecording: phase === "recording",
    isProcessing: phase === "processing",
    isIdle: phase === "idle",
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
  };
}
