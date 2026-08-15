import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import BriefBody from "@/components/brief/BriefBody";
import { useDailyBrief } from "@/hooks/useDailyBrief";

// The "here's your day" briefing that lives in the chat. A small "Today's
// briefing" toggle is always present on every chat (so the user can pull the
// rundown up any time); it never auto-opens — only the user expands it. The
// brief itself is rendered by BriefBody, the same one the startup brief popup
// uses. Data is fetched lazily the first time it's opened, so a chat the user
// never expands costs nothing.

export default function DailyDocketCard({
  greetingName,
  expanded,
  onToggle,
}: {
  greetingName?: string | null;
  /** Whether the briefing body is open. The toggle chip is always shown. */
  expanded: boolean;
  onToggle: () => void;
}) {
  // Rebuilt every time it's opened — a fresh fetch plus a typed-out stream —
  // so pulling it up mid-conversation behaves exactly like it does on app open.
  const brief = useDailyBrief({ active: expanded, stream: expanded, greetingName });

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 text-[0.78rem] font-medium text-black/60 dark:text-white/60 hover:text-black/80 dark:hover:text-white/80 transition-colors"
      >
        <span>Today&apos;s briefing</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="briefing-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <BriefBody brief={brief} className="pt-2.5 px-1" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
