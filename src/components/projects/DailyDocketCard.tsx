import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, MapPin } from "lucide-react";
import ReactMarkdown from "react-markdown";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS } from "@/lib/chat/chatMarkdown";
import { fetchTodayDocket, type TodayDocket } from "@/lib/synthesis/loadInUpdates";
import { buildDocketPrompt, streamDocketBriefing } from "@/lib/synthesis/docketBriefing";

// The "here's your day" briefing that lives in the chat. A small "Today's
// briefing" toggle is always present on every chat (so the user can pull the
// rundown up any time); it never auto-opens — only the user expands it. When
// open it shows the day's `lykn_events` + due/overdue `lykn_todos` as
// clickable bars and streams a short, typed-out rundown with first steps and
// resources. Data is fetched lazily the first time it's opened, so a chat the
// user never expands costs nothing.

function eventTime(startsAt: number, allDay: boolean): string {
  if (allDay) return "All day";
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dueLabel(dueAt: number | null): string {
  if (dueAt == null) return "";
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Placeholder tokens the model tends to invent when it doesn't actually know
// a URL ("figma.com/yourproject", "notion.so/your-workspace", etc.).
const PLACEHOLDER_RE =
  /\b(your|my|our|example|placeholder|projectname|project-name|team-?name|workspace-?id|company-?name|username|xxx+|todo|insert|link-?here)\b|[<>{}\[\]]|\.\.\./i;

/**
 * Resolve an AI-supplied resource href into something safe to open, or null
 * when it shouldn't be a link at all:
 *   • bare domains ("figma.com") are promoted to https
 *   • non-http(s) values (fragments, relative SPA paths) → null (plain text)
 *   • a placeholder in the host ("yourteam.com") → null (the domain is fake)
 *   • a placeholder in the path ("figma.com/yourproject") → collapse to the
 *     real homepage (https://figma.com) so the click lands somewhere real
 */
function safeResourceUrl(href: unknown): string | null {
  const raw = String(href || "").trim();
  if (!raw) return null;
  const looksLikeDomain = /^[^\s/]+\.[^\s/]+/.test(raw) && !/^[a-z][a-z0-9+.-]*:/i.test(raw);
  const candidate = looksLikeDomain ? `https://${raw.replace(/^\/+/, "")}` : raw;
  if (!/^https?:\/\//i.test(candidate)) return null;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (PLACEHOLDER_RE.test(u.hostname)) return null;
  const pathish = `${u.pathname}${u.search}${u.hash}`;
  if (PLACEHOLDER_RE.test(decodeURIComponent(pathish))) {
    return `${u.protocol}//${u.host}`;
  }
  return u.toString();
}

// Markdown renderers matched to a normal assistant message.
const briefingMd = {
  p: (props: any) => <p className="mb-3 last:mb-0" {...props} />,
  ul: (props: any) => <ul className="list-disc pl-5 space-y-1.5 mb-3 last:mb-0" {...props} />,
  ol: (props: any) => <ol className="list-decimal pl-5 space-y-1.5 mb-3 last:mb-0" {...props} />,
  li: (props: any) => <li className="leading-relaxed" {...props} />,
  strong: (props: any) => <strong className="font-semibold text-black/90 dark:text-white/90" {...props} />,
  a: ({ href, children }: any) => {
    const safe = safeResourceUrl(href);
    // Anything that isn't a genuine, non-placeholder external URL (fragments,
    // made-up relative paths, invented deep links like "figma.com/yourproject")
    // is shown as plain emphasized text — never a navigation that 404s.
    if (!safe) {
      return <span className="font-medium text-black/80 dark:text-white/80">{children}</span>;
    }
    return (
      <a
        href={safe}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(safe, "_blank", "noopener,noreferrer");
        }}
        className="text-blue-600 dark:text-blue-400 hover:underline"
      >
        {children}
      </a>
    );
  },
  code: (props: any) => (
    <code className="rounded bg-black/[0.05] dark:bg-white/10 px-1 py-0.5 text-[0.85em]" {...props} />
  ),
};

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
  const navigate = useNavigate();
  const [docket, setDocket] = useState<TodayDocket | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [briefing, setBriefing] = useState("");
  const [briefingDone, setBriefingDone] = useState(false);
  const wasExpandedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const hasContent =
    !!docket &&
    (docket.events.length > 0 || docket.dueToday.length > 0 || docket.overdue.length > 0);

  // (Re)build the briefing every time it's opened — a fresh fetch + typed-out
  // stream — so pulling it up mid-conversation behaves exactly like it does on
  // app open. Opening is the only trigger; toggling closed aborts any inflight
  // stream. Guarded so it fires on the closed→open transition only.
  useEffect(() => {
    if (expanded && !wasExpandedRef.current) {
      wasExpandedRef.current = true;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoaded(false);
      setBriefing("");
      setBriefingDone(false);
      setDocket(null);
      (async () => {
        const d = await fetchTodayDocket();
        if (controller.signal.aborted) return;
        setDocket(d);
        setLoaded(true);
        const prompt = buildDocketPrompt(d, greetingName);
        if (!prompt) return;
        try {
          await streamDocketBriefing(
            prompt,
            (text) => {
              if (!controller.signal.aborted) setBriefing(text);
            },
            controller.signal,
          );
        } catch {
          // Silent — the clickable bars above still stand on their own.
        } finally {
          if (!controller.signal.aborted) setBriefingDone(true);
        }
      })();
    } else if (!expanded) {
      wasExpandedRef.current = false;
      abortRef.current?.abort();
    }
  }, [expanded, greetingName]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const projName = (id: string | null): string | null =>
    docket && id && docket.projectNames[id] ? docket.projectNames[id] : null;
  const go = (id: string | null) => {
    navigate(id ? `/projects/${id}` : "/projects");
  };
  // Calendar events live in the Calendar dialog (owned by the always-mounted
  // sidebar), so open that rather than routing off to a project page.
  const openCalendar = () => {
    window.dispatchEvent(new CustomEvent("lykn_open_calendar"));
  };

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
            <div className="pt-2.5 px-1 text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
              {!loaded ? (
                <ThinkingIndicator status="Thinking…" />
              ) : docket?.error ? (
                <p className="text-black/60 dark:text-white/60">
                  Couldn&apos;t load your day right now. Check back in a moment.
                </p>
              ) : !hasContent ? (
                <p className="text-black/60 dark:text-white/60">
                  You&apos;re all clear today. Nothing scheduled or due.
                </p>
              ) : (
                <>
                  <div className="space-y-1 mb-3">
                    {docket!.events.slice(0, 6).map((ev) => {
                      const proj = projName(ev.projectId);
                      return (
                        <button
                          key={`ev-${ev.id}`}
                          type="button"
                          onClick={openCalendar}
                          className="group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                        >
                          <CalendarClock className="w-3.5 h-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[0.8rem] text-black/85 dark:text-white/88 truncate">{ev.title}</div>
                            <div className="text-[0.65rem] text-black/45 dark:text-white/45 flex items-center gap-1 truncate">
                              <span className="tabular-nums">{eventTime(ev.startsAt, ev.allDay)}</span>
                              {ev.location && (
                                <>
                                  <span>·</span>
                                  <MapPin className="w-2.5 h-2.5 shrink-0" />
                                  <span className="truncate">{ev.location}</span>
                                </>
                              )}
                              {proj && (
                                <>
                                  <span>·</span>
                                  <span className="truncate">{proj}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-black/20 dark:text-white/20 group-hover:text-black/40 dark:group-hover:text-white/40" />
                        </button>
                      );
                    })}

                    {docket!.overdue.slice(0, 5).map((t) => {
                      const proj = projName(t.projectId);
                      return (
                        <button
                          key={`od-${t.id}`}
                          type="button"
                          onClick={() => go(t.projectId)}
                          className="group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                        >
                          <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-red-500" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[0.8rem] text-black/85 dark:text-white/88 truncate">{t.title}</div>
                            <div className="text-[0.65rem] text-red-600/80 dark:text-red-400/80 truncate">
                              Overdue{dueLabel(t.dueAt) ? ` · was due ${dueLabel(t.dueAt)}` : ""}
                              {proj ? ` · ${proj}` : ""}
                            </div>
                          </div>
                          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-black/20 dark:text-white/20 group-hover:text-black/40 dark:group-hover:text-white/40" />
                        </button>
                      );
                    })}

                    {docket!.dueToday.slice(0, 6).map((t) => {
                      const proj = projName(t.projectId);
                      return (
                        <button
                          key={`dt-${t.id}`}
                          type="button"
                          onClick={() => go(t.projectId)}
                          className="group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-black/25 dark:text-white/25" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[0.8rem] text-black/85 dark:text-white/88 truncate">{t.title}</div>
                            <div className="text-[0.65rem] text-black/45 dark:text-white/45 truncate">
                              Due today
                              {t.priority === "high" ? " · High priority" : ""}
                              {proj ? ` · ${proj}` : ""}
                            </div>
                          </div>
                          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-black/20 dark:text-white/20 group-hover:text-black/40 dark:group-hover:text-white/40" />
                        </button>
                      );
                    })}
                  </div>

                  {briefing ? (
                    <>
                      <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS} components={briefingMd}>
                        {briefing}
                      </ReactMarkdown>
                      {!briefingDone && (
                        <span className="inline-block w-1.5 h-4 -mb-0.5 ml-0.5 bg-black/40 dark:bg-white/50 animate-pulse rounded-[1px]" />
                      )}
                    </>
                  ) : (
                    <ThinkingIndicator status="Thinking…" />
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
