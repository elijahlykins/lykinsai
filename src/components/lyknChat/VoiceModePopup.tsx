import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

interface VoiceModePopupProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Compact glass Voice Mode card, portaled to <body> so its backdrop-filter
 * blurs the real desktop (an in-tree ancestor with transform/filter would
 * flatten the glass). Sits bottom-right; the page underneath stays usable.
 */
export default function VoiceModePopup({ open, onClose, children }: VoiceModePopupProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="voice-mode-popup"
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.96 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="lykn-voice-overlay lg-window"
          role="dialog"
          aria-modal="false"
          aria-label="Voice Mode"
        >
          <div className="lykn-voice-popup-chrome">
            <span className="lykn-voice-popup-title">Voice</span>
            <button
              type="button"
              onClick={onClose}
              className="lykn-voice-popup-close"
              aria-label="Close Voice Mode"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
