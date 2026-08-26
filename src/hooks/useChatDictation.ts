import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/use-toast";
import { micErrorMessage, requestMicStream } from "@/lib/voice/micAccess";

// ============================================================================
// useChatDictation — composer mic-button dictation lifecycle
// ============================================================================
// Owns the MediaRecorder → /api/ai/transcribe round trip that used to live
// inside useChatEngine (extracted verbatim in the Wave 3A decomposition, see
// docs/REFACTOR_LOG.md): microphone acquisition, recording start/stop, the
// Whisper transcription request, appending the transcript into the composer,
// and unmount cleanup. This is DICTATION only (press mic, talk, text lands in
// the input) — full hands-free Voice Mode lives in useChatVoiceMode.

export interface UseChatDictationDeps {
  /** Live composer text — read to seed the Whisper `prompt` context. */
  chatInputRef: React.MutableRefObject<string>;
  /** Engine composer setter — the transcript is appended through it so the
   *  textarea DOM value + has-text state stay in sync. */
  setChatInput: (valOrFn: string | ((prev: string) => string)) => void;
}

export interface UseChatDictationReturn {
  isDictating: boolean;
  isTranscribing: boolean;
  handleDictateToggle: () => void;
}

export function useChatDictation(deps: UseChatDictationDeps): UseChatDictationReturn {
  const { chatInputRef, setChatInput } = deps;

  const [isDictating, setIsDictating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const dictationTimerRef = useRef<number | null>(null);

  const handleDictateToggle = useCallback(() => {
    if (isDictating) {
      try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop(); } catch {}
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      toast({ title: "Dictation unavailable", description: "This device can't record audio.", variant: "destructive", duration: 6000 });
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    // Prompts for OS/browser mic permission first — inside the desktop shell
    // getUserMedia alone never surfaces the macOS dialog.
    requestMicStream({ audio: true }).then((stream) => {
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data?.size > 0) audioChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        try { mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
        mediaStreamRef.current = null; mediaRecorderRef.current = null; setIsDictating(false);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        if (blob.size < 2000) return;
        setIsTranscribing(true);
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const formData = new FormData();
          formData.append("audio", blob, "dictation.webm");
          formData.append("model", "whisper-1"); formData.append("language", "en");
          const cur = String(chatInputRef.current || "").trim();
          if (cur) formData.append("prompt", cur.split(/\s+/).slice(-12).join(" "));
          const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, { method: "POST", body: formData });
          const data = await res.json().catch(() => ({}));
          const transcript = String(data?.text || "").trim();
          if (res.ok && transcript) setChatInput((prev) => { const c = String(prev || "").trim(); return c ? `${c} ${transcript}` : transcript; });
        } catch {}
        setIsTranscribing(false);
      };
      recorder.onerror = () => { setIsDictating(false); setIsTranscribing(false); };
      recorder.start(); setIsDictating(true);
    }).catch((err: unknown) => {
      setIsDictating(false);
      toast({ title: "Microphone needed", description: micErrorMessage(err), variant: "destructive", duration: 8000 });
    });
  }, [isDictating, setChatInput]);

  // Dictation cleanup on unmount
  useEffect(() => () => {
    if (dictationTimerRef.current) { window.clearInterval(dictationTimerRef.current); dictationTimerRef.current = null; }
    try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop(); } catch {}
    try { mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
  }, []);

  return { isDictating, isTranscribing, handleDictateToggle };
}
