// Studio chat chrome: everything that turns the plain chat page into the
// Studio glass experience — the StudioView mode model (Chat / Build / Imagine
// / Research) with its per-mode system prompts, headlines and composer
// placeholders, the floating mode pill, the quick-start chip strip, and the
// Research sources sidebar. Extracted verbatim from src/pages/LyknChat.tsx
// (LyknChat decomposition phase, see docs/REFACTOR_LOG.md).
import React from "react";
import {
  Code,
  ImagePlus,
  MessageCircle,
  Save,
  SquarePen,
  Telescope,
} from "lucide-react";
import { SiteFavicon } from "@/components/SiteFavicon";
import { openInStudioBrowser, studioOpenChatOpts } from "@/lib/lyknChat/openInStudioBrowser";
import type { ComposerMode } from "@/hooks/useChatEngine";

// Studio glass mode selector — Chat / Build / Imagine / Research. Floats at
// the top of the glass chat page (inside LYKN Studio). Each mode segment is
// its own page view: a fresh centered composer with a mode headline, the
// composer mode armed silently (no blue chip). The mode rides through the
// same pipeline as the "+" menu (Build = live React artifact, Imagine =
// image gen, Research = deep-research report).
export type StudioView = "chat" | "build" | "imagine" | "research";

export const STUDIO_VIEW_MODES: Record<Exclude<StudioView, "chat">, ComposerMode> = {
  build: "create:webapp",
  imagine: "image",
  research: "research",
};

export const STUDIO_VIEW_HEADLINES: Record<Exclude<StudioView, "chat">, string> = {
  build: "What would you like to build?",
  imagine: "Generate any image",
  research: "What should LYKN research?",
};

export const STUDIO_VIEW_SUBTITLES: Record<Exclude<StudioView, "chat">, string> = {
  build:
    "Pitch decks, presentations, and polished visual docs. Describe what you need and LYKN builds it live.",
  imagine: "Describe any image and LYKN generates a set of variations you can refine.",
  research:
    "Give a topic or question and LYKN digs into current sources, then writes a structured research report.",
};

// Per-mode system prompt, injected server-side into the stream system prompt
// ([ACTIVE_MODE] section) on every turn while the mode page is active. The
// pages are sticky sessions: the whole conversation stays in-lane.
// Every mode prompt ends with the same out-of-lane rule: if the ask belongs
// to a different mode, do NOT produce this mode's deliverable — point the
// user at the mode pills at the top of the page (never the "+" menu).
const STUDIO_MODE_SWITCH_RULE =
  " Ordinary questions are always in-lane: answer them directly without telling the user to " +
  "switch to Chat. If the user explicitly asks for a deliverable this mode can't create (e.g. an image in Build/Research, a " +
  "research report in Build/Imagine, or an app/deck in Imagine/Research), do NOT produce this " +
  "mode's deliverable as a substitute. Instead reply briefly telling them to switch modes using " +
  "the pills at the top of the page (Chat / Build / Imagine / Research) and resend their " +
  "request there. Never tell them to use the \"+\" menu for this.";

const STUDIO_VIEW_SYSTEM_PROMPTS: Record<StudioView, string> = {
  chat:
    "The user is in Chat mode. Plan, discuss, and answer here. Chat cannot produce the live " +
    "deliverable. If they ask you to actually make the thing you have been planning (build the app, " +
    "generate the image, write the research report), that is not another planning turn. Do not " +
    "repeat the plan, dump a spec, or paste a code/HTML sketch. Reply briefly telling them to switch " +
    "using the pills at the top of the page, then resend: Build for apps/pages/dashboards/decks/" +
    "docs/charts/diagrams/interactive tools; Imagine for images; Research for a deep sourced " +
    "report. Never fake those outputs in Chat.",
  build:
    "The user is in Build mode — a dedicated session for designing and building artifacts " +
    "(interactive pages, apps, tools, games, decks, documents, charts, diagrams). Act as their " +
    "build partner: answer ordinary questions normally, help shape ideas, and propose concrete " +
    "directions without building unless the user clearly asks you to create, change, fix, or " +
    "refine an artifact. If they ask you to build but name no kind and no topic " +
    "(\"can you build me something\", \"just make something\", \"surprise me\"), ask ONE short " +
    "question with 2–4 concrete options (a playable mini-game, a landing page, a dashboard, a " +
    "small utility) — do not invent a deliverable. A question about an idea or an open artifact is not an edit request. When " +
    "an artifact is already open in the panel and they ask to add, change, fix, or extend it, " +
    "ALWAYS patch that artifact in place with targeted `edits` — never rebuild from scratch " +
    "unless they clearly ask to redesign, start over, or build something entirely new. If a " +
    "tool call returns a compile_error or edits_required, fix it silently and retry before " +
    "telling the user you're done. COLOR DEFAULT: stay in a quiet earthy-neutral palette — black, " +
    "white, gray, muted dark/sage greens, dark/slate blues, beige, and browns. Do not invent " +
    "bright candy accents (orange, rose, cyan, neon, purple) unless the user explicitly asks " +
    "for vivid color / a chromatic style, OR they show you a reference idea (attached image, " +
    "screenshot, mood board) — then match that idea." +
    STUDIO_MODE_SWITCH_RULE,
  imagine:
    "The user is in Imagine mode — a session for image creation and visual exploration. Answer " +
    "ordinary questions normally and discuss ideas, styles, composition, or an existing image " +
    "without generating anything unless the user clearly asks you to create or modify an image. " +
    "When they do ask to create or refine one, turn the request into a vivid, detailed image " +
    "prompt, generate it, and iterate on style, composition, lighting, and details as they react." +
    STUDIO_MODE_SWITCH_RULE,
  research:
    "The user is in Research mode — a dedicated session for producing deep research reports. " +
    "Treat each request as a research brief: investigate thoroughly using current sources and " +
    "deliver a structured, well-organized report. Ask a short clarifying question first only " +
    "when the scope is genuinely unclear; otherwise research and write. Follow-up messages " +
    "refine or extend the report — keep the session focused on the research topic." +
    STUDIO_MODE_SWITCH_RULE,
};

function openPageInstruction(page?: { url?: string; title?: string } | null) {
  const url = String(page?.url || "").trim();
  if (!url) return "";
  const label = String(page?.title || "").trim();
  const named = label ? `${label} (${url})` : url;
  return (
    ` The user opened ${named} in the LYKN browser and is looking at that page ` +
    `while continuing this conversation. Treat it as the open page they are viewing.`
  );
}

export function studioInstructionsFor(
  view: StudioView,
  page?: { url?: string; title?: string } | null,
) {
  return (STUDIO_VIEW_SYSTEM_PROMPTS[view] || "") + openPageInstruction(page);
}

const STUDIO_MODE_OPTIONS: {
  id: StudioView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "build", label: "Build", icon: Code },
  { id: "imagine", label: "Imagine", icon: ImagePlus },
  { id: "research", label: "Research", icon: Telescope },
];

export const StudioModePill = React.memo(function StudioModePill({
  activeView,
  onSelect,
  onNewChat,
}: {
  activeView: StudioView;
  onSelect: (view: StudioView) => void;
  onNewChat?: () => void;
}) {
  return (
    <div className="lykn-studio-mode-pill pointer-events-none absolute inset-x-0 z-[70] flex items-center justify-center gap-2">
      {onNewChat && (
        <button
          type="button"
          onClick={onNewChat}
          title="New chat"
          aria-label="New chat"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-black/10 bg-white/55 text-black/60 shadow-lg backdrop-blur-2xl transition-colors hover:text-black dark:border-white/15 dark:bg-black/35 dark:text-white/65 dark:hover:text-white"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      )}
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-black/10 bg-white/55 p-1 shadow-lg backdrop-blur-2xl dark:border-white/15 dark:bg-black/35">
        {STUDIO_MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
          const active = id === activeView;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] font-medium transition-all ${
                active
                  ? "bg-black/85 text-white shadow dark:bg-white dark:text-black"
                  : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

// Per-mode composer identity: each Studio page gets its own placeholder and
// a strip of quick-start chips above the chat bar, so the bar itself signals
// which page you're on. (Imagine has its own dedicated bar and skips this.)
export const STUDIO_COMPOSER_PLACEHOLDERS: Record<StudioView, string> = {
  chat: "Ask me anything...",
  build: "Describe what you want to build...",
  imagine: "Describe the image you want...",
  research: "What should LYKN research?",
};

const STUDIO_COMPOSER_CHIPS: Record<
  Exclude<StudioView, "imagine" | "chat">,
  { label: string; insert: string }[]
> = {
  build: [
    { label: "Pitch deck", insert: "Make a pitch deck about " },
    { label: "Slide deck", insert: "Create a slide deck that covers " },
    { label: "One-pager", insert: "Design a one-pager for " },
    { label: "Investor deck", insert: "Build an investor deck for " },
    { label: "App", insert: "Build me an app that " },
    { label: "Game", insert: "Create an interactive game where " },
    { label: "Study guide", insert: "Make a study guide for " },
    { label: "Dashboard", insert: "Design a dashboard for " },
  ],
  research: [
    {
      label: "Tesla stock performance",
      insert: "Research Tesla stock: recent performance, valuation, and analyst outlook",
    },
    {
      label: "AI chip market",
      insert: "Give me a market overview of the AI semiconductor industry in 2026",
    },
    {
      label: "Sleep and memory",
      insert: "Do an academic research report on how sleep affects memory consolidation, citing recent studies",
    },
    {
      label: "Global EV trends",
      insert: "Write a trend report on the global electric vehicle market",
    },
    {
      label: "CRISPR research",
      insert: "Research the latest advances and debates in CRISPR gene editing",
    },
  ],
};

export const StudioComposerStrip = React.memo(function StudioComposerStrip({
  view,
  onInsert,
}: {
  view: Exclude<StudioView, "imagine" | "chat">;
  onInsert: (text: string) => void;
}) {
  return (
    <div className="lykn-studio-chips mb-1 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-1">
      {STUDIO_COMPOSER_CHIPS[view].map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={() => onInsert(chip.insert)}
          className="shrink-0 whitespace-nowrap rounded-full border border-black/10 bg-white/40 px-2.5 py-1 text-[11px] font-medium text-black/55 backdrop-blur-sm transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:border-white/12 dark:bg-white/[0.05] dark:text-white/55 dark:hover:bg-white/[0.1] dark:hover:text-white/85"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
});

// Studio Research page: right rail listing every link the deep-research
// pipeline searched/read (streamed from the server before the report text),
// plus a Save report action that writes the finished report into the vault.
function researchLinkHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const StudioResearchSidebar = React.memo(function StudioResearchSidebar({
  sources,
  chatId,
  canSave,
  saving,
  onSave,
}: {
  sources: { title: string; url: string }[];
  /** Owning conversation for in-chat research. Omit for marketing/demo rails. */
  chatId?: string | null;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const openLink = (url: string) => {
    if (openInStudioBrowser(url, undefined, studioOpenChatOpts(chatId))) return;
    const lykn = (window as any).lykn;
    if (lykn?.openExternal) lykn.openExternal(url, undefined, studioOpenChatOpts(chatId));
    else window.open(url, "_blank", "noopener");
  };
  // Shared blur glass so the report underneath is frosted, not readable.
  return (
    <div className="lykn-studio-research-rail lg-desktop-surface flex h-full flex-col rounded-none">
      <div className="flex items-center justify-between px-4 pb-2.5">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-black/55 dark:text-white/60">
          Research links
        </p>
        {sources.length > 0 && (
          <span className="rounded-full border border-black/10 bg-black/[0.05] px-2 py-0.5 text-[0.62rem] font-medium text-black/65 dark:border-white/10 dark:bg-white/[0.07] dark:text-white/70">
            {sources.length}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 scrollbar-hide">
        {sources.length === 0 ? (
          <p className="px-3 py-8 text-center text-[0.7rem] leading-relaxed text-black/40 dark:text-white/40">
            No sources were captured for this report.
          </p>
        ) : (
          sources.map((s, i) => (
            <button
              key={`${s.url}-${i}`}
              type="button"
              onClick={() => openLink(s.url)}
              title={s.url}
              className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            >
              <SiteFavicon url={s.url} className="mt-0.5 h-3.5 w-3.5" />
              <span className="min-w-0">
                <span className="block truncate text-[0.74rem] text-black/85 dark:text-white/85">
                  {s.title || "Source"}
                </span>
                <span className="block truncate text-[0.62rem] text-black/40 dark:text-white/40">
                  {researchLinkHostname(s.url)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      <div className="p-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave || saving}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-black/85 py-2 text-[0.75rem] font-semibold text-white shadow transition-opacity hover:bg-black/75 dark:bg-white dark:text-black dark:hover:bg-white/90 disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save report"}
        </button>
      </div>
    </div>
  );
});
