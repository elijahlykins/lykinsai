import { useNavigate } from "react-router-dom";
import { CalendarClock, CheckCircle2, ChevronRight, MapPin } from "lucide-react";
import ReactMarkdown from "react-markdown";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import MorningBriefCard from "@/components/projects/MorningBriefCard";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS } from "@/lib/chat/chatMarkdown";
import { openStudioTab } from "@/lib/studioTabs";
import type { DailyBrief } from "@/hooks/useDailyBrief";

// The brief itself: what Night Shift left overnight, the day's `lykn_events`
// and due/overdue `lykn_todos` as clickable bars, and the streamed rundown
// underneath. Shared by the "Today's briefing" expander in chat and the
// startup brief popup, so both read identically.

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
  // A stray code fence would otherwise be as wide as its longest line.
  pre: (props: any) => <pre className="whitespace-pre-wrap break-words" {...props} />,
};

const ROW_CLASS =
  "group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors text-black/85 dark:text-white/90";

export default function BriefBody({
  brief,
  onNavigate,
  className = "",
}: {
  brief: DailyBrief;
  /** Called after a click navigates away — lets a popup close itself. */
  onNavigate?: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const { docket, nightBriefs, loaded, briefing, briefingDone, hasContent } = brief;

  const projName = (id: string | null): string | null =>
    docket && id && docket.projectNames[id] ? docket.projectNames[id] : null;
  // Inside Studio these are tabs and floating windows rather than routes, so
  // ask it first and only navigate when we're somewhere else.
  const go = (id: string | null) => {
    const path = id ? `/projects/${id}` : "/projects";
    if (!openStudioTab("projects", path)) navigate(path);
    onNavigate?.();
  };
  const openCalendar = () => {
    if (!openStudioTab("calendar")) navigate("/calendar");
    onNavigate?.();
  };

  const body = () => {
    if (!loaded) return <ThinkingIndicator status="Thinking…" />;
    if (docket?.error && nightBriefs.length === 0) {
      return (
        <p className="text-black/60 dark:text-white/60">
          Couldn&apos;t load your day right now. Check back in a moment.
        </p>
      );
    }
    if (!hasContent) {
      return (
        <p className="text-black/60 dark:text-white/60">
          You&apos;re all clear today. Nothing scheduled or due.
        </p>
      );
    }

    const events = docket?.events ?? [];
    const overdue = docket?.overdue ?? [];
    const dueToday = docket?.dueToday ?? [];
    const hasDocket = events.length > 0 || overdue.length > 0 || dueToday.length > 0;

    return (
      <>
        {nightBriefs.length > 0 && (
          <div className="space-y-2 mb-3">
            {nightBriefs.map((nb) => (
              <button
                key={`nb-${nb.id}`}
                type="button"
                onClick={() => go(nb.projectId)}
                className="w-full text-left px-3 py-2.5 rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.04] dark:hover:bg-white/[0.05] transition-colors"
              >
                <MorningBriefCard brief={nb} projectName={nb.projectName} embedded />
              </button>
            ))}
          </div>
        )}

        {hasDocket && (
          <div className="space-y-1 mb-3">
            {events.slice(0, 6).map((ev) => {
              const proj = projName(ev.projectId);
              return (
                <button key={`ev-${ev.id}`} type="button" onClick={openCalendar} className={ROW_CLASS}>
                  <CalendarClock className="w-3.5 h-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.8rem] truncate">{ev.title}</div>
                    <div className="text-[0.65rem] text-black/45 dark:text-white/55 flex items-center gap-1 truncate">
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
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-black/20 dark:text-white/35 group-hover:text-black/40 dark:group-hover:text-white/60" />
                </button>
              );
            })}

            {overdue.slice(0, 5).map((t) => {
              const proj = projName(t.projectId);
              return (
                <button key={`od-${t.id}`} type="button" onClick={() => go(t.projectId)} className={ROW_CLASS}>
                  <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-red-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.8rem] truncate">{t.title}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
                      <span className="inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wide bg-red-500/15 text-red-700 dark:bg-red-400/20 dark:text-red-100">
                        Overdue
                      </span>
                      <span className="text-[0.65rem] text-black/45 dark:text-white/55 truncate">
                        {[dueLabel(t.dueAt) ? `was due ${dueLabel(t.dueAt)}` : null, proj]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-black/20 dark:text-white/35 group-hover:text-black/40 dark:group-hover:text-white/60" />
                </button>
              );
            })}

            {dueToday.slice(0, 6).map((t) => {
              const proj = projName(t.projectId);
              return (
                <button key={`dt-${t.id}`} type="button" onClick={() => go(t.projectId)} className={ROW_CLASS}>
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-black/25 dark:text-white/40" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.8rem] truncate">{t.title}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
                      <span className="inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wide bg-amber-500/15 text-amber-800 dark:bg-amber-400/20 dark:text-amber-100">
                        Due today
                      </span>
                      {(t.priority === "high" || proj) && (
                        <span className="text-[0.65rem] text-black/45 dark:text-white/55 truncate">
                          {[t.priority === "high" ? "High priority" : null, proj]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-black/20 dark:text-white/35 group-hover:text-black/40 dark:group-hover:text-white/60" />
                </button>
              );
            })}
          </div>
        )}

        {hasDocket && briefing && (
          <>
            <ReactMarkdown
              remarkPlugins={CHAT_REMARK_PLUGINS}
              rehypePlugins={CHAT_REHYPE_PLUGINS}
              components={briefingMd}
            >
              {briefing}
            </ReactMarkdown>
            {!briefingDone && (
              <span className="inline-block w-1.5 h-4 -mb-0.5 ml-0.5 bg-black/40 dark:bg-white/50 animate-pulse rounded-[1px]" />
            )}
          </>
        )}
        {/* Waiting on the rundown. A stream that fails outright just leaves the
            items above, rather than thinking forever. */}
        {hasDocket && !briefing && !briefingDone && <ThinkingIndicator status="Thinking…" />}
      </>
    );
  };

  return (
    <div
      className={`min-w-0 text-sm leading-relaxed break-words text-black/85 dark:text-white/85 ${className}`}
    >
      {body()}
    </div>
  );
}
