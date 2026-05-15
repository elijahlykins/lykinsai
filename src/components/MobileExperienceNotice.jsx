import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { Monitor } from "lucide-react";

const STORAGE_KEY = "lykn_mobile_notice_v1_dismissed";

/**
 * One-time, dismissable bottom sheet shown the first time a user lands
 * on the mobile build. Sets expectation that the phone shell is a
 * slimmed-down companion to the full desktop experience (canvas grid,
 * projects, synthesis layer, etc.). Once dismissed, the localStorage
 * flag keeps it from coming back on subsequent visits.
 */
export default function MobileExperienceNotice() {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore — worst case the notice shows again next visit */
    }
    setOpen(false);
  };

  if (!open) return null;

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-end"
      role="dialog"
      aria-modal="true"
      aria-label="Mobile experience notice"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={dismiss}
      />
      <div
        className="relative w-full rounded-t-2xl bg-white dark:bg-[#1c1c1e] border-t border-black/10 dark:border-white/10 shadow-2xl"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 16px)" }}
      >
        <div className="flex justify-center pt-2 pb-1">
          <span className="block w-10 h-1 rounded-full bg-black/15 dark:bg-white/20" />
        </div>
        <div className="px-6 pt-3 pb-2 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-3">
            <Monitor className="w-7 h-7 text-blue-500" />
          </div>
          <h2 className="text-lg font-semibold text-black dark:text-white mb-2">
            You're on mobile LYKN
          </h2>
          <p className="text-sm text-black/70 dark:text-white/70 leading-relaxed mb-5 max-w-sm mx-auto">
            This is a slimmed-down companion build — chat, the vault, and a few
            essentials. For the full LYKN experience (projects, synthesis mind
            map, and the rest of the toolkit), open LYKN on your
            <span className="font-semibold text-black dark:text-white"> desktop or laptop</span>.
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="w-full h-11 rounded-xl bg-blue-500 text-white text-sm font-semibold hover:bg-blue-600 active:scale-[0.98] transition-all"
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
