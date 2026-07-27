import { Loader2, Mic, PenLine, Square, StickyNote, X } from "lucide-react";
import { useCallback } from "react";
import { useVaultVoiceRecorder } from "@/hooks/useVaultVoiceRecorder";
import {
  saveVoiceNoteToVault,
  transcribeVaultAudio,
  VOICE_NOTE_MIN_BYTES,
} from "@/lib/vault/saveVoiceNote";

type VaultNewNoteChooserProps = {
  open: boolean;
  userId: string | null | undefined;
  onClose: () => void;
  onChooseWritten: () => void;
  onRequireSignIn?: () => void;
  beforeSave?: () => Promise<boolean>;
  onNoteSaved?: (note: Record<string, unknown>) => void;
  onError?: (message: string) => void;
};

export default function VaultNewNoteChooser({
  open,
  userId,
  onClose,
  onChooseWritten,
  onRequireSignIn,
  beforeSave,
  onNoteSaved,
  onError,
}: VaultNewNoteChooserProps) {
  const handleBlob = useCallback(async (blob: Blob, mimeType: string) => {
    if (!userId) {
      onRequireSignIn?.();
      onClose();
      return;
    }
    if (beforeSave && !(await beforeSave())) {
      onClose();
      return;
    }
    if (blob.size < VOICE_NOTE_MIN_BYTES) {
      onError?.("Recording too short. Try speaking a bit longer.");
      onClose();
      return;
    }

    const transcribed = await transcribeVaultAudio(blob, { fileName: "voice-note.webm" });
    if ("error" in transcribed) {
      onError?.(transcribed.error);
      onClose();
      return;
    }

    const saved = await saveVoiceNoteToVault({
      userId,
      transcript: transcribed.transcript,
      audioBlob: blob,
      mimeType,
    });
    if (!saved.ok) {
      onError?.(saved.error);
      onClose();
      return;
    }
    onNoteSaved?.(saved.note);
    onClose();
  }, [beforeSave, onClose, onError, onNoteSaved, onRequireSignIn, userId]);

  const { isRecording, isProcessing, startRecording, stopRecording, cancelRecording } = useVaultVoiceRecorder({
    disabled: !open,
    onBlobReady: handleBlob,
  });

  const handleDismiss = () => {
    if (isProcessing) return;
    if (isRecording) cancelRecording();
    onClose();
  };

  const handleChooseWritten = () => {
    handleDismiss();
    onChooseWritten();
  };

  const handleChooseVoice = async () => {
    if (!userId) {
      onRequireSignIn?.();
      onClose();
      return;
    }
    const started = await startRecording();
    if (!started) {
      onError?.("Microphone access is unavailable in this browser.");
      onClose();
    }
  };

  if (!open) return null;

  const showRecording = isRecording || isProcessing;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/20 backdrop-blur-sm p-4"
      onClick={() => {
        if (!showRecording) handleDismiss();
      }}
    >
      <div
        className="w-[380px] max-w-[92vw] rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-panel text-black/80 dark:text-white/90 shadow-lg p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-black/85 dark:text-white/85 flex items-center gap-2">
            <StickyNote className="w-4 h-4" />
            {showRecording ? "Voice note" : "New note"}
          </h2>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isProcessing}
            className="text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {showRecording ? (
          <div className="py-6 flex flex-col items-center gap-4 text-center">
            {isRecording ? (
              <>
                <div className="dictation-wave"><span /><span /><span /><span /><span /></div>
                <p className="text-sm text-black/75 dark:text-white/80">Recording… tap stop when you&apos;re done.</p>
                <button
                  type="button"
                  onClick={() => stopRecording()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/15 transition-colors text-sm font-medium"
                >
                  <Square className="w-3.5 h-3.5" fill="currentColor" />
                  Stop and save
                </button>
              </>
            ) : (
              <>
                <Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" />
                <p className="text-sm text-black/75 dark:text-white/80">Transcribing and saving to your Vault…</p>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-black/55 dark:text-white/55">
              How would you like to capture this note?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { void handleChooseVoice(); }}
                className="flex flex-col items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/5 hover:bg-black/5 dark:hover:bg-white/10 px-4 py-5 transition-colors text-left sm:items-start"
              >
                <Mic className="w-5 h-5 text-black/70 dark:text-white" />
                <span className="text-sm font-semibold text-black/85 dark:text-white/85">Voice note</span>
                <span className="text-[11px] text-black/55 dark:text-white/55 leading-snug">
                  Speak and we&apos;ll transcribe it into your Vault.
                </span>
              </button>
              <button
                type="button"
                onClick={handleChooseWritten}
                className="flex flex-col items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/5 hover:bg-black/5 dark:hover:bg-white/10 px-4 py-5 transition-colors text-left sm:items-start"
              >
                <PenLine className="w-5 h-5 text-black/70 dark:text-white/75" />
                <span className="text-sm font-semibold text-black/85 dark:text-white/85">Written note</span>
                <span className="text-[11px] text-black/55 dark:text-white/55 leading-snug">
                  Type a quick note in the composer.
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
