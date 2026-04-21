import React, { useRef } from "react";
import { motion } from "framer-motion";
import { ChevronDown, StickyNote, Loader2, Save } from "lucide-react";

type DraggableQuickNoteProps = {
  title?: string;
  content: string;
  setTitle?: (value: string) => void;
  setContent: (value: string) => void;
  isSaving: boolean;
  onSave: () => void | Promise<void>;
  onClose: () => void;
};

export default function DraggableQuickNote({
  content,
  setContent,
  isSaving,
  onSave,
  onClose,
}: DraggableQuickNoteProps) {
  const constraintsRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[75] flex items-center justify-center"
      ref={constraintsRef}
    >
      <motion.div
        drag
        dragConstraints={constraintsRef}
        dragMomentum={false}
        dragElastic={0.08}
        initial={{ x: 400, y: 0, opacity: 0, scale: 0.95 }}
        animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className="pointer-events-auto w-[380px] max-w-[92vw] min-h-[360px] max-h-[86vh] flex flex-col rounded-2xl border border-black/8 dark:border-white/8 bg-white/80 dark:bg-[#1e1e1e]/90 backdrop-blur-md shadow-2xl overflow-hidden"
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
            className="block w-full h-full min-h-[240px] resize-none bg-transparent border-0 outline-none text-sm leading-relaxed text-black/85 dark:text-white/85 placeholder:text-black/40 dark:placeholder:text-white/40"
            onPointerDownCapture={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
            }}
            autoFocus
          />
          {!content.trim() && (
            <div className="pointer-events-none absolute inset-x-4 top-3 text-sm text-black/35 dark:text-white/35 select-none">
              Start typing a quick note...
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
      </motion.div>
    </div>
  );
}
