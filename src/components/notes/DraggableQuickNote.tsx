import React, { useRef } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";

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
    <div className="fixed inset-0 pointer-events-none z-50 flex items-center justify-center" ref={constraintsRef}>
      <motion.div
        drag
        dragConstraints={constraintsRef}
        dragMomentum={false}
        initial={{ x: 400, y: 0, opacity: 0, scale: 0.9 }}
        animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="group pointer-events-auto w-[380px] max-w-[92vw] min-h-[360px] max-h-[86vh] glass-control rounded-2xl shadow-2xl p-3 relative"
      >
        <div className="absolute top-3 right-3 z-20 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            className="h-5 w-5 text-black/70 dark:text-white/70 hover:text-red-500 flex items-center justify-center"
            onClick={onClose}
            title="Close"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        <div className="h-full relative">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder=""
            className="h-full w-full min-h-[340px] overflow-y-auto scrollbar-hide resize-none rounded-lg bg-transparent border border-white/35 px-3 py-3 text-sm text-black dark:text-white outline-none"
            onPointerDownCapture={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
            }}
          />
          {!content.trim() && (
            <div className="pointer-events-none absolute inset-0 px-3 py-3 text-sm text-black/45 select-none">
              <div>Write your quick note...</div>
              <div className="mt-2 text-[0.6875rem] text-black/50">Tip: Press Ctrl/Cmd + Enter to save.</div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

