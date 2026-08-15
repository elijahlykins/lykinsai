import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Newspaper, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import BriefBody from "@/components/brief/BriefBody";
import { useDailyBrief } from "@/hooks/useDailyBrief";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  markStartupBriefShown,
  readStartupBriefEnabled,
  startupBriefWasShown,
  subscribeOpenBrief,
  subscribeStartupBrief,
} from "@/lib/brief";

// Where the brief lives. Two ways in:
//   • "Brief on startup" (Settings → Notifications): once per launch, a small
//     card slides in on the right with the shape of the day.
//   • Studio's top-bar button, any time, switch or no switch.
// Either way, pressing it opens the full brief — Night Shift's overnight
// handoff, today's events and tasks, and a short rundown. The model call is
// deferred until it's open, so a card that's ignored costs nothing but two
// cheap reads.

const CARD_DELAY_MS = 1200;

// Product surfaces only: never over marketing, auth, billing or onboarding.
const APP_PATHS = [
  "/studio",
  "/app",
  "/chat",
  "/vault",
  "/projects",
  "/calendar",
  "/todos",
  "/synthesis-layer",
];

function isAppSurface(pathname) {
  return APP_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function timeOfDay() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** "2 events · 3 due today · 1 overdue" — the day at a glance, unopened. */
function summaryLine(brief) {
  const parts = [];
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (brief.nightBriefs.length > 0) {
    parts.push(count(brief.nightBriefs.length, "overnight update", "overnight updates"));
  }
  const events = brief.docket?.events.length ?? 0;
  const dueToday = brief.docket?.dueToday.length ?? 0;
  const overdue = brief.docket?.overdue.length ?? 0;
  if (events > 0) parts.push(count(events, "event", "events"));
  if (dueToday > 0) parts.push(`${dueToday} due today`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  return parts.join(" · ");
}

export default function BriefSurface() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [enabled, setEnabled] = useState(readStartupBriefEnabled);
  // idle → card (notification showing) → open (popup) → done (gone)
  const [phase, setPhase] = useState("idle");

  useEffect(() => subscribeStartupBrief(setEnabled), []);

  // Asked for by name (Studio's top bar) — skips the card and the switch.
  useEffect(() => subscribeOpenBrief(() => setPhase("open")), []);

  const armed =
    enabled &&
    !loading &&
    !!user &&
    isAppSurface(location.pathname) &&
    phase === "idle" &&
    !startupBriefWasShown();

  useEffect(() => {
    if (!armed) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        // Studio's bell mutes every notification the app fires; a brief that
        // slides in anyway would be the one thing that ignores it.
        try {
          const res = await window.lykn?.getNotificationsMuted?.();
          if (res?.muted) return;
        } catch {
          /* not the desktop shell — nothing to mute */
        }
        if (cancelled) return;
        markStartupBriefShown();
        setPhase("card");
      })();
    }, CARD_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [armed]);

  const greetingName = useMemo(() => {
    const fullName = String(
      user?.user_metadata?.full_name || user?.user_metadata?.name || "",
    ).trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    return firstName || String(user?.email || "").split("@")[0].trim() || null;
  }, [user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name]);

  const showing = phase === "card" || phase === "open";
  const brief = useDailyBrief({
    active: showing,
    // The rundown streams only once the brief is actually open.
    stream: phase === "open",
    greetingName,
  });

  if (!showing) return null;

  const summary = summaryLine(brief);
  const title = `Your ${timeOfDay()} brief`;

  return (
    <>
      <AnimatePresence>
        {phase === "card" && (
          <motion.div
            initial={{ opacity: 0, x: 24, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, scale: 0.96 }}
            transition={{ duration: 0.34, ease: [0.32, 0.72, 0, 1] }}
            /* `lg-menu` is the app's one glass — it brings the wash, blur,
               hairline and shadow, so nothing here declares its own. */
            className="lg-menu group fixed right-5 top-20 z-[95] w-[16.5rem] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setPhase("open")}
              className="flex w-full items-center gap-2.5 p-2.5 text-left transition-colors hover:bg-[var(--lg-fill)]"
            >
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[0.5rem] bg-blue-500/15">
                <Newspaper className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
              </span>
              <span className="min-w-0">
                {/* Room on the title line for the dismiss button; the summary
                    underneath sits below it and can use the full width. */}
                <span className="block truncate pr-5 text-[0.78rem] font-semibold leading-tight text-black/90 dark:text-white/90">
                  {title}
                </span>
                <span className="mt-0.5 block truncate text-[0.7rem] leading-tight text-black/50 dark:text-white/55">
                  {!brief.loaded
                    ? "Putting your day together…"
                    : summary || "You're all clear today."}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setPhase("done")}
              aria-label="Dismiss brief"
              className="absolute right-1.5 top-1.5 rounded-md p-1 text-black/30 opacity-0 transition-opacity hover:text-black/70 focus-visible:opacity-100 group-hover:opacity-100 dark:text-white/35 dark:hover:text-white/80"
            >
              <X className="h-3 w-3" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={phase === "open"} onOpenChange={(open) => !open && setPhase("done")}>
        {/* overflow-x-hidden is load-bearing: the base DialogContent sets
            overflow-y-auto and leaves overflow-x visible, which CSS computes to
            auto — so anything a pixel too wide puts a scrollbar across the
            bottom. Pinning the axis keeps the brief to one dimension. */}
        <DialogContent className="max-w-xl overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <p className="text-[0.7rem] uppercase tracking-[0.14em] text-black/40 dark:text-white/40">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
          </DialogHeader>
          <BriefBody brief={brief} onNavigate={() => setPhase("done")} />
        </DialogContent>
      </Dialog>
    </>
  );
}
