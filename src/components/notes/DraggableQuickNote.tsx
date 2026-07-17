import React, { useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Loader2, Mic, Save, Square, StickyNote, Trash2 } from "lucide-react";
import { useVaultVoiceRecorder } from "@/hooks/useVaultVoiceRecorder";
import { transcribeVaultAudio, VOICE_NOTE_MIN_BYTES } from "@/lib/vault/saveVoiceNote";

type DraggableQuickNoteProps = {
  title?: string;
  content: string;
  setTitle?: (value: string) => void;
  setContent: (value: string) => void;
  isSaving: boolean;
  onSave: () => void | Promise<void>;
  onClose: () => void;
  onDiscard?: () => void;
  /** Center within a positioned parent (e.g. wake vault preview subwindow). */
  contained?: boolean;
  /** When false, hides the mic dictation control (e.g. wake preview). */
  voiceEnabled?: boolean;
  onVoiceError?: (message: string) => void;
};

export default function DraggableQuickNote({
  content,
  setContent,
  isSaving,
  onSave,
  onClose,
  onDiscard,
  contained = false,
  voiceEnabled = true,
  onVoiceError,
}: DraggableQuickNoteProps) {
  const constraintsRef = useRef<HTMLDivElement | null>(null);

  const handleVoiceBlob = useCallback(async (blob: Blob) => {
    if (blob.size < VOICE_NOTE_MIN_BYTES) {
      onVoiceError?.("Recording too short. Try speaking a bit longer.");
      return;
    }
    const hint = String(content || "").trim().split(/\s+/).slice(-12).join(" ");
    const result = await transcribeVaultAudio(blob, { promptHint: hint });
    if ("error" in result) {
      onVoiceError?.(result.error);
      return;
    }
    const current = String(content || "").trim();
    setContent(current ? `${current} ${result.transcript}` : result.transcript);
  }, [content, onVoiceError, setContent]);

  const { isRecording, isProcessing, toggleRecording } = useVaultVoiceRecorder({
    disabled: isSaving || !voiceEnabled,
    onBlobReady: handleVoiceBlob,
  });

  return (
    <div
      className={`${
        contained ? "absolute" : "fixed"
      } inset-0 pointer-events-none z-[75] flex items-center justify-center`}
      ref={constraintsRef}
    >
      <motion.div
        drag
        dragConstraints={constraintsRef}
        dragMomentum={false}
        dragElastic={0.08}
        initial={{ x: contained ? 80 : 400, y: 0, opacity: 0, scale: 0.95 }}
        animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className={`pointer-events-auto flex flex-col rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-[hsl(var(--sidebar-surface))] dark:bg-[hsl(0_0%_16%)] shadow-2xl overflow-hidden ${
          contained
            ? "w-[min(94%,300px)] min-h-[220px] max-h-[72%]"
            : "w-[380px] max-w-[92vw] min-h-[360px] max-h-[86vh]"
        }`}
      >
        {/* Drag handle pill */}
        <div className="flex-shrink-0 flex justify-center pt-2 pb-1 select-none cursor-grab active:cursor-grabbing">
          <div className="w-8 h-1 rounded-full bg-black/15 dark:bg-white/15" />
        </div>

        {/* Header — mirrors NotesPanel header */}
        <div className="flex-shrink-0 flex items-center gap-2 px-3 pb-2 border-b border-black/6 dark:border-white/6">
          <button
            type="button"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            title="Close"
            className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-black/35 dark:text-white/35 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
          <div className="flex-shrink-0 flex items-center gap-2">
            <StickyNote className="w-4 h-4 text-black/40 dark:text-white/40" />
            <h3 className="text-sm font-semibold text-black/70 dark:text-white/70">
              Quick Note
            </h3>
          </div>
        </div>

        {/* Editor area — styled like the Notes editor content */}
        <div className="flex-1 relative overflow-y-auto scrollbar-hide px-4 py-3">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder=""
            className={`block w-full h-full resize-none bg-transparent border-0 outline-none text-sm leading-relaxed text-black/85 dark:text-white/85 placeholder:text-black/40 dark:placeholder:text-white/40 ${
              contained ? "min-h-[140px]" : "min-h-[240px]"
            }`}
            onPointerDownCapture={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
            }}
            autoFocus
          />
          {!content.trim() && !isRecording && !isProcessing && (
            <div className="pointer-events-none absolute inset-x-4 top-3 text-sm text-black/35 dark:text-white/35 select-none">
              Start typing or tap the mic to dictate...
            </div>
          )}
          {(isRecording || isProcessing) && (
            <div className="pointer-events-none absolute inset-x-4 bottom-3 flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
              {isRecording ? (
                <>
                  <div className="dictation-wave"><span /><span /><span /><span /><span /></div>
                  <span className="font-medium">Recording…</span>
                </>
              ) : (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Transcribing…</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer — keyboard hint + save button */}
        <div className="flex-shrink-0 px-3 py-2 border-t border-black/6 dark:border-white/6 flex items-center justify-between gap-2">
          <span className="text-[11px] text-black/40 dark:text-white/40 flex items-center">
            <kbd className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 border border-black/8 dark:border-white/10 text-[10px] font-medium text-black/55 dark:text-white/55">
              ⌘
            </kbd>
            <span className="mx-1">+</span>
            <kbd className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 border border-black/8 dark:border-white/10 text-[10px] font-medium text-black/55 dark:text-white/55">
              Enter
            </kbd>
            <span className="ml-1.5">to save</span>
          </span>
          <div className="flex items-center gap-1">
            {voiceEnabled && (
              <button
                type="button"
                onClick={() => toggleRecording()}
                onPointerDown={(e) => e.stopPropagation()}
                disabled={isSaving || isProcessing}
                title={isRecording ? "Stop recording" : "Dictate into note"}
                aria-label={isRecording ? "Stop recording" : "Dictate into note"}
                className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  isRecording
                    ? "text-red-600 dark:text-red-400 bg-red-500/10"
                    : "text-black/40 dark:text-white/40 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-500/10"
                }`}
              >
                {isProcessing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : isRecording ? (
                  <Square className="w-3 h-3" fill="currentColor" />
                ) : (
                  <Mic className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            {onDiscard && (
              <button
                type="button"
                onClick={() => onDiscard()}
                onPointerDown={(e) => e.stopPropagation()}
                disabled={isSaving || !content.trim()}
                title="Discard draft"
                aria-label="Discard quick note draft"
                className="flex items-center justify-center w-7 h-7 rounded-md text-black/40 dark:text-white/40 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => { void onSave(); }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={isSaving || !content.trim()}
              title="Save note"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-black/85 dark:bg-white/90 text-white dark:text-black hover:bg-black dark:hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Save className="w-3 h-3" />
              )}
              <span>{isSaving ? "Saving" : "Save"}</span>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
