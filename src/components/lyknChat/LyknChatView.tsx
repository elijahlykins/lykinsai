import React, { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check, ChevronRight, Copy, Download, FileText,
  GripVertical, Link2, MoreHorizontal, Music, Pencil, Play, Plus, RefreshCw,
  Save, Share2, StickyNote, ThumbsDown, ThumbsUp, Trash2, X as XIcon,
} from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import lyknIconNeutral from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknIconBlue from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import ReactMarkdown from "react-markdown";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS, normalizeMathDelimiters } from "@/lib/chat/chatMarkdown";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import LocalToolApprovalCard from "@/components/lyknChat/LocalToolApprovalCard";
import ChatArtifactCard, { ArtifactBuildingPlaceholder } from "@/components/lyknChat/ChatArtifactCard";
import LyknChatArtifactPanel from "@/components/lyknChat/LyknChatArtifactPanel";
import { isLiveBuildStatus } from "@/hooks/useThinkingStatus";

// Studio Research rail width — floats over the right edge; chat stays put.
const RESEARCH_SIDEBAR_WIDTH = "min(340px, 30vw)";
import { extractChatArtifacts, sortArtifactsForDisplay, extractLeakedHtmlDocument, buildLeakedHtmlArtifact, type ChatArtifact } from "@/lib/ai/chatArtifacts";
import ChatNeuronCard from "@/components/lyknChat/ChatNeuronCard";
import FactConfirmChip from "@/components/lyknChat/FactConfirmChip";
import LinkPreview from "@/components/LinkPreview";
import { SiteFavicon } from "@/components/SiteFavicon";
import type {
  ToolCallEvent,
  ChatNeuronAttachment,
} from "@/lib/ai/chatSendOrchestrator";
import type { FactNeuron } from "@/lib/ai/learnedTag";
import { labelForModelId } from "@/lib/ai/conversationFormat";
import { KNOWN_MODEL_IDS } from "@/lib/modelCatalog";
import { supabase } from "@/lib/supabase";
import { safeExternalUrl, safeNavHref } from "@/lib/safeExternalUrl";
import { handleLyknBrowserClick } from "@/lib/lyknChat/openInStudioBrowser";
import { copyMarkdownAsRich } from "@/lib/copyRichClipboard";

// Resolve a user-facing model name for the AI Response pill. The server
// reports the REAL resolved backend in `served_model` — but LYKN is a
// brand-alias that intentionally hides its routed backend (e.g.
// gpt-4.1-nano), so anything that isn't one of the public, user-pickable
// models collapses back to "LYKN".
const resolveModelLabel = (modelId?: string | null) => {
  const id = String(modelId || "").trim();
  if (!id) return "";
  return KNOWN_MODEL_IDS.includes(id) ? labelForModelId(id) : "LYKN";
};

// LYKN mark shown in the AI Response pill. Blue in light mode; the neutral
// (near-white) icon in dark mode so it reads on the translucent pill.
const LyknWordmark = ({ className = "" }: { className?: string }) => (
  <>
    <img src={lyknIconBlue} alt="LYKN" className={`${className} block dark:hidden`} />
    <img src={lyknIconNeutral} alt="LYKN" className={`${className} hidden dark:block`} />
  </>
);

const TASK_LINE_RE = /^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/;

const normalizeChecklistSyntax = (value: string) => {
  const checklist = String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) return line;
      const marker = String(match[1] || "").toLowerCase() === "x" ? "x" : " ";
      return `- [${marker}] ${String(match[2] || "").trim()}`;
    })
    .join("\n");
  return normalizeMathDelimiters(checklist);
};

const splitResponseIntoChunks = (text: string): string[] => {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) chunks.push(t);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^\s*#{1,6}\s/.test(line);
    const isListItem = /^\s*[-*]\s/.test(line);
    const isNumbered = /^\s*\d+[.)]\s/.test(line);
    const isCodeFence = /^\s*```/.test(line);
    const isEmpty = !line.trim();
    if (isCodeFence) {
      if (buf.length && !buf.some((l) => /^\s*```/.test(l))) flush();
      buf.push(line);
      const alreadyClosed = buf.filter((l) => /^\s*```/.test(l)).length >= 2;
      if (alreadyClosed) flush();
      continue;
    }
    if (buf.some((l) => /^\s*```/.test(l)) && buf.filter((l) => /^\s*```/.test(l)).length < 2) {
      buf.push(line);
      continue;
    }
    if (isHeading) { flush(); buf.push(line); continue; }
    if (isEmpty && buf.length > 0) {
      const lastIsListOrNum = buf.some((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+[.)]\s/.test(l));
      const nextIsListOrNum = (i + 1 < lines.length) && (/^\s*[-*]\s/.test(lines[i + 1]) || /^\s*\d+[.)]\s/.test(lines[i + 1]));
      if (lastIsListOrNum && nextIsListOrNum) { buf.push(line); continue; }
      flush();
      continue;
    }
    if ((isListItem || isNumbered) && buf.length > 0) {
      const lastLine = buf[buf.length - 1];
      const lastIsList = /^\s*[-*]\s/.test(lastLine) || /^\s*\d+[.)]\s/.test(lastLine);
      const lastIsHeading = /^\s*#{1,6}\s/.test(lastLine);
      const lastIsPlain = !lastIsList && !lastIsHeading && lastLine.trim();
      if (lastIsPlain) flush();
    }
    buf.push(line);
  }
  flush();
  if (chunks.length <= 1) return [raw];
  return chunks;
};

type FocusedChatAttachment = {
  id: string;
  type: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  videoId?: string;
  vaultTitle?: string;
  vaultContent?: string;
  transcript?: string;
  pdfText?: string;
  extractedText?: string;
  canvasBlockId?: string;
  rawFile?: File;
};

type PromptMessage = {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  aiImageUrl?: string;
  aiYouTubeUrls?: { url: string; videoId: string }[];
  aiWebLinks?: string[];
  sources?: { title: string; url: string }[];
  kind?: "prompt" | "load-in-greeting";
  attachments?: FocusedChatAttachment[];
  /**
   * Set when the AI's reply ended with a hidden <fact_confirm>,
   * <learned>/<reason>, or <updated> tag — or when /api/learned/auto
   * soft-learned as a fallback. Renders FactConfirmChip (Yes/Edit/No
   * for pending facts, or a quiet "saved" pill for soft learns).
   */
  factNeuron?: FactNeuron;
  /**
   * Tools the in-app agent loop invoked while answering this turn. One
   * ToolCallPill per entry is rendered under the assistant bubble; status
   * transitions running → done|error in place as the SSE stream delivers
   * matching `tool_call` events.
   */
  toolCalls?: ToolCallEvent[];
  /**
   * Neurons (vault items, beliefs, facts, concepts) the AI brought into
   * the chat this turn via lykn_loadNeuron. Renders one ChatNeuronCard
   * per entry directly under the assistant bubble — same row as the
   * ToolCallPill strip but laid out as a stack of full cards so the
   * user actually sees the saved item (image / link card / note body /
   * belief / etc.) without having to leave the chat. Populated by the
   * orchestrator on `tool_call` SSE events; see chatSendOrchestrator.
   */
  aiNeurons?: ChatNeuronAttachment[];
  /**
   * Action buttons rendered below the AI response bubble. Currently
   * used by the load-in greeting seeded by LyknChat — each action is
   * a route the user can jump to (synthesis layer with a focused
   * belief, a project's chat, etc.). Internal `href`s (starting with
   * `/`) route via react-router; everything else opens in a new tab.
   * Optional and ignored when absent, so other turns are unaffected.
   */
  aiResponseActions?: Array<{
    label: string;
    href: string;
    description?: string;
    tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
    /**
     * Optional remote icon (used by the "Connect <Platform>" prompts
     * in the load-in greeting). When present, replaces the default
     * ArrowRight glyph with the platform's brand mark.
     */
    iconUrl?: string;
  }>;
  /**
   * Structured load-in greeting sections. When present, the renderer
   * shows the assistant bubble as: short welcome (`aiResponse`) at the
   * top → a heading per section → each row inside the section with an
   * optional inline CTA button. Takes precedence over the flat
   * `aiResponseActions` strip for this turn.
   */
  aiResponseSections?: Array<{
    id: string;
    heading: string;
    intro?: string;
    items: Array<{
      title: string;
      subtitle?: string;
      /**
       * Optional row-leading thumbnail — used by the Project Updates
       * lane to surface the AI app that made the most recent move on
       * each project (Claude / Cursor / ChatGPT favicon).
       */
      iconUrl?: string;
      action?: {
        label: string;
        href: string;
        description?: string;
        tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
        iconUrl?: string;
      };
    }>;
    /** When set, the section renders as a prose paragraph in place of the items list. */
    summary?: string;
    /**
     * When set, the section renders as a stack of collapsible
     * "notification bubble" rows — one per source app — instead of
     * the flat `items` list. Each bubble shows the app's logo and
     * expands inline to a list of items, each linking to its
     * canonical source URL.
     */
    groups?: Array<{
      id: string;
      label: string;
      iconUrl?: string;
      domain?: string;
      count: number;
      latestTitle?: string;
      latestRelative?: string;
      items: Array<{
        id: string;
        title: string;
        subtitle?: string;
        href?: string;
        /**
         * Optional "grounded in" chips rendered under the title. Used
         * today for proposed-belief rows so the user can see (and
         * click into) the source notes / events the belief was
         * promoted from, instead of trusting the synthesis layer
         * blind. Absent on older cached briefings; renderer must
         * handle the array being missing without breaking.
         */
        provenance?: Array<{
          id: string;
          label: string;
          href?: string;
          connectorId?: string;
        }>;
      }>;
    }>;
    chips?: Array<{
      id: string;
      label: string;
      iconUrl: string;
      href: string;
      tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
    }>;
    /**
     * Marks a user-authored section (row in `lykn_load_in_user_sections`).
     * When present, the renderer attaches inline edit / delete buttons
     * next to the heading so the user can manage their own additions
     * from inside the briefing.
     */
    userSectionId?: string;
  }>;
  /**
   * Roll-up stats for the right-side dashboard panel rendered next to
   * the load-in greeting. Pre-computed by `loadInUpdates.ts` so the
   * panel never has to walk `aiResponseSections` to draw the chart.
   * Shape mirrors `LoadInUpdatesStats` and is passed through verbatim.
   */
  aiResponseStats?: import("@/lib/synthesis/loadInUpdates").LoadInUpdatesStats;
};

type CanvasFileBlock = {
  id: string;
  type: string;
  name: string;
  url: string;
  thumbUrl: string;
  videoId?: string;
  content?: string;
  isAi?: boolean;
};

export interface LyknChatViewProps {
  chatMessages: PromptMessage[];
  isChatLoading: boolean;
  thinkingStatus: string;

  chatInputRef: React.MutableRefObject<string>;
  /** When set, composer textareas are controlled (clears reliably on send). */
  chatInputValue?: string;
  onChatInputChange: (value: string) => void;
  onSend: () => void | Promise<void>;

  typedWelcome: string;
  /** Optional line under the centered welcome heading (empty-state only). */
  welcomeSubtitle?: React.ReactNode;
  isMobileGrid: boolean;
  isMobilePhone?: boolean;

  isDictating: boolean;
  isTranscribing: boolean;

  canvasFileBlocks: CanvasFileBlock[];
  focusedChatAttachments: FocusedChatAttachment[];

  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onResizeInput: (el: HTMLTextAreaElement | null) => void;

  chatPanelInputRef: React.RefObject<HTMLTextAreaElement | null>;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;

  buildChatMarkdownComponents: (msgId: string) => Record<string, React.ComponentType<any>>;

  savedMediaUrls: Set<string>;
  savedYouTubeIds: Set<string>;
  onSaveYouTube: (videoId: string, url: string) => void;
  onSaveAttachment: (url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => void;
  onSaveAiImage: (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => void | Promise<boolean | void>;
  onSaveLink: (link: string) => void;

  expandedAiMsgIds: Set<string>;
  toggleAiExpanded: (msgId: string) => void;
  expandedUserPromptIds: Set<string>;
  toggleUserPromptExpanded: (msgId: string) => void;
  getCollapsedPreview: (text: string) => string;

  copiedMsgId: string | null;
  onCopyMessage: (msgId: string, text: string) => void;

  addChatResponseToGrid: (text: string) => void;

  /**
   * When true the canvas surface is unmounted (chat-only mode). The
   * "Add to grid" / "Add this section to grid" buttons and the
   * canvas-files collage panel are hidden because they'd be no-ops the
   * user can't see. Passed through from `LyknChat`'s `GRID_DISABLED`
   * feature flag.
   */
  gridDisabled?: boolean;

  renderFocusedAttachmentPreview: (att: FocusedChatAttachment) => React.ReactNode;

  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;

  chatBarToolbar: React.ReactNode;

  /** Composer field min-height in px (the JS auto-grow floor). */
  composerMinH?: number;

  chatReactions: Record<string, "like" | "dislike" | null>;
  onReaction: (msgId: string, kind: "like" | "dislike") => void;

  onRegenerate: (msgId: string, content: string) => void;
  onRegenerateNonUser: (msgId: string, idx: number) => void;

  /**
   * Edit a previously-sent user prompt: truncates the conversation from that
   * turn onward and re-sends the edited text as a fresh turn.
   */
  onEditResend: (msgId: string, newText: string) => void;

  /**
   * Refetches the load-in greeting payload and overlays it onto the
   * currently-rendered greeting message in place. Invoked by the
   * inline user-sections composer after every CRUD so the bubble (and
   * the right-side dashboard panel) reflect the new state without a
   * full page reload. Optional — non-greeting surfaces leave it unset.
   */
  onLoadInGreetingRefresh?: () => void | Promise<void>;

  /** Walkthrough iframe preview: tighter layout, no scroll. */
  compactPreview?: boolean;

  /** Optional content rendered at the bottom of the message scroll area. */
  threadFooter?: React.ReactNode;
  /** Sub-agent task status strip above the composer (main agent orchestration). */
  composerAbove?: React.ReactNode;
  /** Optional content under the composer (active thread). */
  composerBelow?: React.ReactNode;
  /** Composer placeholder — Studio mode pages set a per-mode prompt. */
  composerPlaceholder?: string;
  /** Keep the composer pinned to the bottom even with no messages (e.g. new chat in a thread). */
  pinComposerToBottom?: boolean;

  /**
   * Artifact open in the floating preview popup. When set, the popup shows
   * it large and the next chat edit refines it in place. Owned by useChatEngine
   * so the send path can include it as edit context.
   */
  /** Studio Research page: right-hand rail with the deep-research source
   *  links + Save report. When set (desktop), the rail floats over the right
   *  edge as a fixed column — the chat column doesn't move. */
  researchSidebar?: React.ReactNode;
  /** Hide the per-message source chips under AI responses (Studio Research
   *  page shows the links in the right rail instead). */
  hideMessageSources?: boolean;
  activeArtifact?: ChatArtifact | null;
  onActiveArtifactChange?: (artifact: ChatArtifact | null) => void;
  /** Save the open artifact (deck/doc/chart/file) to the vault. */
  onSaveArtifact?: (
    artifact: ChatArtifact,
    opts?: { auto?: boolean },
  ) => Promise<boolean> | boolean | void;
  /** Identifier for the currently-shown chat — switching it closes the panel. */
  chatKey?: string;

  /** Patch / clear `factNeuron` after in-chat Yes / Edit / No. */
  onFactNeuronChange?: (msgId: string, next: FactNeuron | null) => void;

  /**
   * Build / Create sessions: keep the thinking/building spinner under the
   * streamed description for the whole turn, not only after a tool reports
   * "running". The long wait is argument streaming (the source itself),
   * which happens before that event — without this the UI goes silent
   * after "I'll build that out…".
   */
  keepThinkingWhileLoading?: boolean;
}

const IN_FLIGHT_TOOL_STATUSES = new Set([
  "running",
  "awaiting_client",
  "awaiting_approval",
]);

function messageHasInFlightTools(msg: { toolCalls?: ToolCallEvent[] } | null | undefined): boolean {
  const calls = msg?.toolCalls;
  if (!Array.isArray(calls) || !calls.length) return false;
  return calls.some((tc) => IN_FLIGHT_TOOL_STATUSES.has(tc.status));
}

/** Narration that means an artifact is actually being written (vs. a clarifying question). */
function isBuildSlotStatus(status?: string): boolean {
  const t = String(status || "").trim();
  if (!t) return false;
  if (/\(\s*[\d.]+k?\s*\)/.test(t)) {
    return /^(building |writing the |filling in |composing |rendering )/i.test(t);
  }
  return /^building\s+(?!the\s(?:app|page|artifact)\b)\S/i.test(t);
}

/* ------------------------------------------------------------------ */
/*  MessageItem — memoized per-message bubble                          */
/* ------------------------------------------------------------------ */
/*
 * Each chat message renders as its own memoized component so unchanged
 * messages skip re-render entirely while the most recent one is being
 * streamed into. Without this, every SSE token triggered a full render
 * of every message in the chat (with full markdown re-parse), which is
 * the dominant cost during streaming for any non-trivial conversation.
 */

type MessageItemProps = {
  msg: PromptMessage;
  idx: number;
  /** Studio Research page shows source links in the right rail, so the
   *  per-message chips under the response are hidden there. */
  hideMessageSources?: boolean;
  isAiExpanded: boolean;
  isUserPromptExpanded: boolean;
  reaction: "like" | "dislike" | null | undefined;
  isCopied: boolean;
  isMobilePhone: boolean;
  gridDisabled: boolean;
  savedMediaUrls: Set<string>;
  savedYouTubeIds: Set<string>;
  selectedChunks: Set<string>;
  buildChatMarkdownComponents: (msgId: string) => Record<string, React.ComponentType<any>>;
  toggleAiExpanded: (id: string) => void;
  toggleUserPromptExpanded: (id: string) => void;
  getCollapsedPreview: (text: string) => string;
  onCopyMessage: (id: string, text: string) => void;
  onReaction: (id: string, kind: "like" | "dislike") => void;
  onRegenerate: (id: string, content: string) => void;
  onEditResend: (id: string, newText: string) => void;
  onRegenerateNonUser: (id: string, idx: number) => void;
  onSaveYouTube: (videoId: string, url: string) => void;
  onSaveAttachment: (url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => void;
  onSaveAiImage: (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => void | Promise<boolean | void>;
  onSaveLink: (link: string) => void;
  addChatResponseToGrid: (text: string) => void;
  handleChunkClick: (e: React.MouseEvent, chunkKey: string, chunkText: string) => void;
  getSelectedText: (fallbackKey: string, fallbackText: string) => string;
  registerChunks: (msgId: string, entries: Array<{ key: string; text: string }>) => void;
  /**
   * Forwarded from `LyknChatViewProps`. The inline user-sections
   * composer calls this after any insert / update / delete so the
   * greeting bubble (and dashboard panel) pick up the new state.
   */
  onLoadInGreetingRefresh?: () => void | Promise<void>;
  /** Open an artifact in the floating preview popup. */
  onOpenArtifact?: (art: ChatArtifact) => void;
  /** Patch / clear `factNeuron` after in-chat ratification. */
  onFactNeuronChange?: (msgId: string, next: FactNeuron | null) => void;
  /**
   * When set, render the thinking/building spinner under this turn's
   * streamed description — while a tool is in flight OR a build is still
   * streaming its arguments (the long wait before "running").
   */
  inlineThinkingStatus?: string;
};

/**
 * Notification-style bubble for one connector source inside a
 * load-in greeting section. Collapsed: a row showing the app's
 * branded logo + label + count + preview of the latest item.
 * Expanded: a dropdown list of items, each linking out to its
 * canonical source URL (the actual Gmail email, Notion page, etc.).
 * Each bubble owns its own open/closed state — sections may stack
 * several bubbles and the user opens whichever they care about.
 */
const LoadInBubble: React.FC<{
  msgId: string;
  group: {
    id: string;
    label: string;
    iconUrl?: string;
    domain?: string;
    count: number;
    latestTitle?: string;
    latestRelative?: string;
    items: Array<{ id: string; title: string; subtitle?: string; href?: string }>;
  };
}> = ({ msgId, group }) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const iconCandidate =
    group.iconUrl ||
    (group.domain
      ? `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(group.domain)}`
      : null);
  return (
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/50 dark:bg-white/[0.04] backdrop-blur-md shadow-none overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/40 dark:hover:bg-white/[0.06] transition-colors"
      >
        {iconCandidate ? (
          <img
            src={iconCandidate}
            alt=""
            className="w-7 h-7 rounded-md object-contain flex-shrink-0 bg-white/60 dark:bg-white/10 p-0.5"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-7 h-7 rounded-md bg-white/60 dark:bg-white/10 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-black/85 dark:text-white/90 truncate">
              {group.label}
            </span>
            <span className="text-[11px] opacity-60 flex-shrink-0">
              {group.count} new
            </span>
          </div>
          <div className="text-[12px] opacity-75 truncate mt-0.5">
            {group.latestTitle
              ? `${group.latestTitle}${group.latestRelative ? ` · ${group.latestRelative}` : ""}`
              : group.latestRelative || ""}
          </div>
        </div>
        <ChevronRight
          className={`w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-2 pb-2 pt-1 space-y-1 border-t border-white/30 dark:border-white/5">
            {group.items.map((it) => {
              const navHref = typeof it.href === "string" ? safeNavHref(it.href) : null;
              const hasHref = !!navHref;
              const isInternal = navHref?.kind === "internal";
              // Optional grounding chips ("Grounded in: <Notion page>,
              // <Calendar event>, ...") rendered under the item's
              // subtitle. Older cached briefings won't carry the
              // `provenance` array, so we only render the row when at
              // least one chip is present.
              const provenance = Array.isArray((it as { provenance?: unknown }).provenance)
                ? (it as { provenance?: Array<{ id: string; label: string; href?: string; connectorId?: string }> }).provenance!
                : [];
              const inner = (
                <div className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-white/50 dark:hover:bg-white/[0.06] transition-colors">
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-[12.5px] text-black/85 dark:text-white/90 truncate">
                      {it.title}
                    </div>
                    {it.subtitle ? (
                      <div className="text-[11px] opacity-60 mt-0.5 truncate">
                        {it.subtitle}
                      </div>
                    ) : null}
                    {provenance.length > 0 ? (
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        <span className="text-[10.5px] uppercase tracking-wider opacity-50">
                          Grounded in
                        </span>
                        {provenance.slice(0, 3).map((chip) => {
                          const chipNav = typeof chip.href === "string" ? safeNavHref(chip.href) : null;
                          const chipInternal = chipNav?.kind === "internal";
                          const onChipClick = (e: React.MouseEvent) => {
                            // Stop the parent row's anchor click from
                            // double-navigating when the chip lives
                            // inside an outer <a>.
                            e.stopPropagation();
                            if (!chipNav) return;
                            if (e.metaKey || e.ctrlKey || e.shiftKey || (e as unknown as { button?: number }).button === 1) return;
                            if (chipInternal) {
                              e.preventDefault();
                              navigate(chipNav.href);
                              return;
                            }
                            handleLyknBrowserClick(e, chipNav.href, chip.label);
                          };
                          const chipFace = (
                            <span className="inline-flex max-w-[180px] items-center rounded-full border border-black/[0.08] dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04] px-1.5 py-[1px] text-[10.5px] font-medium text-black/70 dark:text-white/70 truncate">
                              {chip.label}
                            </span>
                          );
                          if (!chipNav) {
                            return (
                              <span key={chip.id}>{chipFace}</span>
                            );
                          }
                          return (
                            <a
                              key={chip.id}
                              href={chipNav.href}
                              onClick={onChipClick}
                              target={chipInternal ? undefined : "_blank"}
                              rel={chipInternal ? undefined : "noopener noreferrer"}
                              className="inline-flex max-w-[180px] hover:opacity-90"
                              title={chip.label}
                            >
                              {chipFace}
                            </a>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  {hasHref ? (
                    <ArrowRight className="w-3.5 h-3.5 opacity-40 mt-1 flex-shrink-0" />
                  ) : null}
                </div>
              );
              if (!navHref) {
                return <div key={`${msgId}-${group.id}-${it.id}`}>{inner}</div>;
              }
              // Internal hrefs route via react-router so we don't
              // hard-reload the app and lose chat state; external
              // hrefs (Gmail / Notion / Slack URLs etc.) open in the
              // LYKN in-app browser.
              const onClick = (e: React.MouseEvent) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1) return;
                if (isInternal) {
                  e.preventDefault();
                  navigate(navHref.href);
                  return;
                }
                handleLyknBrowserClick(e, navHref.href);
              };
              return (
                <a
                  key={`${msgId}-${group.id}-${it.id}`}
                  href={navHref.href}
                  onClick={onClick}
                  target={isInternal ? undefined : "_blank"}
                  rel={isInternal ? undefined : "noopener noreferrer"}
                  className="block"
                >
                  {inner}
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Inline editor / composer that lets the user add personal sections to
 * the bottom of their daily load-in briefing. Talks to
 * `lykn_load_in_user_sections` directly (RLS-scoped to the current
 * user) and asks the parent to refresh the greeting payload after
 * every CRUD so the rest of the bubble stays in sync.
 *
 * Three modes:
 *   • idle    — shows a dashed "+ Add a section" tile.
 *   • create  — heading + body inputs with Save / Cancel.
 *   • saving  — spinner-y disabled state while supabase round-trips.
 *
 * Edit and delete affordances for already-saved user sections are
 * rendered inline next to each section heading by `MessageItem`; this
 * component is only responsible for *new* sections plus the
 * "edit current section X" form when the parent passes editingId.
 */
const LoadInUserSectionsComposer: React.FC<{
  onChanged?: () => void | Promise<void>;
}> = ({ onChanged }) => {
  const [mode, setMode] = useState<"idle" | "create">("idle");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setHeading("");
    setBody("");
    setError(null);
    setMode("idle");
  };

  const save = useCallback(async () => {
    const h = heading.trim();
    if (!h) {
      setError("Add a heading so I know what to call this section.");
      return;
    }
    if (h.length > 120) {
      setError("Heading is too long. Keep it under 120 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const userId = session?.session?.user?.id;
      if (!userId) {
        setError("You need to be signed in to add a section.");
        setSaving(false);
        return;
      }
      const { error: insertErr } = await supabase
        .from("lykn_load_in_user_sections")
        .insert({
          user_id: userId,
          heading: h,
          body: body.trim(),
        });
      if (insertErr) {
        setError(insertErr.message || "Couldn't save. Try again?");
        setSaving(false);
        return;
      }
      reset();
      if (onChanged) await onChanged();
    } catch (e: any) {
      setError(String(e?.message || e || "Save failed."));
    } finally {
      setSaving(false);
    }
  }, [heading, body, onChanged]);

  if (mode === "idle") {
    return (
      <button
        type="button"
        onClick={() => setMode("create")}
        className="group/addsec w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-black/15 dark:border-white/15 bg-white/30 dark:bg-white/[0.025] hover:bg-white/55 dark:hover:bg-white/[0.05] hover:border-black/30 dark:hover:border-white/30 px-4 py-3 text-[12.5px] font-medium text-black/60 dark:text-white/60 hover:text-black/85 dark:hover:text-white/85 transition-all"
      >
        <Plus className="w-3.5 h-3.5 opacity-70 group-hover/addsec:opacity-100 transition-opacity" />
        <span>Add a section</span>
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-md shadow-none overflow-hidden">
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-black/55 dark:text-white/55">
          New section
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={saving}
          className="p-1 rounded-md text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          aria-label="Cancel"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-3 pb-3 space-y-2">
        <input
          type="text"
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          placeholder="Heading (e.g. Today's focus)"
          maxLength={120}
          disabled={saving}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[13px] font-semibold text-black/85 dark:text-white/90 placeholder:font-normal placeholder:text-black/35 dark:placeholder:text-white/30 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add notes, links, bullets. Markdown works."
          rows={4}
          maxLength={4000}
          disabled={saving}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed text-black/80 dark:text-white/85 placeholder:text-black/35 dark:placeholder:text-white/30 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors resize-y"
        />
        {error ? (
          <div className="text-[11.5px] text-rose-600 dark:text-rose-300">{error}</div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !heading.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-blue-400/40 bg-blue-500/15 hover:bg-blue-500/25 text-blue-700 dark:text-blue-200 text-[12px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            <span>{saving ? "Saving…" : "Save section"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Editable view of a single user-authored section. Renders inline in
 * place of the static heading + body when the user clicks "edit" on a
 * section they own. Supports rename, body rewrite, and delete.
 */
const LoadInUserSectionEditor: React.FC<{
  sectionId: string;
  initialHeading: string;
  initialBody: string;
  onDone: () => void;
  onChanged?: () => void | Promise<void>;
}> = ({ sectionId, initialHeading, initialBody, onDone, onChanged }) => {
  const [heading, setHeading] = useState(initialHeading);
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    const h = heading.trim();
    if (!h) {
      setError("Heading can't be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("lykn_load_in_user_sections")
        .update({ heading: h, body: body.trim() })
        .eq("id", sectionId);
      if (updErr) {
        setError(updErr.message || "Couldn't save changes.");
        setSaving(false);
        return;
      }
      if (onChanged) await onChanged();
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e || "Save failed."));
    } finally {
      setSaving(false);
    }
  }, [heading, body, sectionId, onChanged, onDone]);

  const remove = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from("lykn_load_in_user_sections")
        .delete()
        .eq("id", sectionId);
      if (delErr) {
        setError(delErr.message || "Couldn't delete.");
        setDeleting(false);
        return;
      }
      if (onChanged) await onChanged();
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e || "Delete failed."));
      setDeleting(false);
    }
  }, [sectionId, onChanged, onDone]);

  const busy = saving || deleting;

  return (
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-md shadow-none overflow-hidden">
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-black/55 dark:text-white/55">
          Editing section
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-rose-600 dark:text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
          aria-label="Delete section"
        >
          <Trash2 className="w-3 h-3" />
          <span>{deleting ? "Deleting…" : "Delete"}</span>
        </button>
      </div>
      <div className="px-3 pb-3 space-y-2">
        <input
          type="text"
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          maxLength={120}
          disabled={busy}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[13px] font-semibold text-black/85 dark:text-white/90 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={4000}
          disabled={busy}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed text-black/80 dark:text-white/85 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors resize-y"
        />
        {error ? (
          <div className="text-[11.5px] text-rose-600 dark:text-rose-300">{error}</div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onDone}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !heading.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-blue-400/40 bg-blue-500/15 hover:bg-blue-500/25 text-blue-700 dark:text-blue-200 text-[12px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            <span>{saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

const MessageItem = React.memo(function MessageItem({
  msg, idx,
  hideMessageSources = false,
  isAiExpanded, isUserPromptExpanded,
  reaction, isCopied,
  isMobilePhone, gridDisabled,
  savedMediaUrls, savedYouTubeIds, selectedChunks,
  buildChatMarkdownComponents,
  toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
  onCopyMessage, onReaction, onRegenerate, onEditResend, onRegenerateNonUser,
  onSaveYouTube, onSaveAttachment, onSaveAiImage, onSaveLink: _onSaveLink,
  addChatResponseToGrid,
  handleChunkClick, getSelectedText, registerChunks,
  onLoadInGreetingRefresh,
  onOpenArtifact,
  onFactNeuronChange,
  inlineThinkingStatus,
}: MessageItemProps) {
  const aiResponse = msg.aiResponse || "";
  const modelLabel = resolveModelLabel((msg as any).aiModel);
  const navigate = useNavigate();
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editDraft, setEditDraft] = useState("");

  // Memoize the expensive chunk-split per message. During streaming this
  // recomputes only when this specific message's aiResponse grows; every
  // other message keeps its cached chunk array.
  const chunks = useMemo(() => splitResponseIntoChunks(aiResponse), [aiResponse]);

  // Register chunk text into the parent's shared chunkMap (used by
  // cross-message multi-select drag) via an effect — never during render.
  useEffect(() => {
    if (!msg.id) return;
    const entries = chunks.map((chunk, ci) => ({ key: `${msg.id}-fchunk-${ci}`, text: chunk }));
    registerChunks(msg.id, entries);
  }, [msg.id, chunks, registerChunks]);

  // Memoize the markdown components object once per msgId so the
  // ReactMarkdown instance below never sees a fresh `components` prop
  // unless the per-msg checklist state actually changes.
  const mdComponents = useMemo(() => buildChatMarkdownComponents(msg.id), [buildChatMarkdownComponents, msg.id]);
  // Load-in greeting turns are unprompted assistant briefings — they
  // have no user prompt bubble and their body is always expanded
  // inline (no chevron/"AI Response" fold). Branched explicitly here
  // so the surrounding render logic stays untouched for real turns.
  const isLoadInGreeting = msg.kind === "load-in-greeting";

  // Which user-authored section (if any) is currently being edited
  // inside this message. Tracked per-message so opening the editor
  // on one section doesn't collapse another. Cleared on save / cancel.
  const [editingUserSectionId, setEditingUserSectionId] = useState<string | null>(null);

  return (
    <React.Fragment>
      {msg.role === "user" && !isLoadInGreeting && (
        <div className="flex flex-col items-end gap-2">
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="max-w-[80%] flex flex-wrap gap-2 justify-end">
              {msg.attachments.map((att) => {
                const at = (att.type || "").toLowerCase();
                const attUrl = att.url || "";
                const attKey = att.videoId || attUrl;
                const isSaved = att.videoId ? savedYouTubeIds.has(att.videoId) : savedMediaUrls.has(attUrl);
                const saveBtn = attKey ? (
                  <button type="button" className={`mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/25 bg-white/35 backdrop-blur-sm text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={isSaved} onClick={() => { if (att.videoId) { onSaveYouTube(att.videoId, attUrl); } else { onSaveAttachment(attUrl, att.name || "File", at === "image" ? "image" : at === "video" ? "video" : at === "audio" ? "audio" : "file"); } }}>
                    {isSaved ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                  </button>
                ) : null;
                if (at === "youtube" && att.videoId) {
                  return (
                    <div key={att.id}>
                      <div className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-none">
                        <iframe src={`https://www.youtube.com/embed/${att.videoId}`} className="w-full aspect-video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={att.name || "YouTube"} />
                      </div>
                      {saveBtn}
                    </div>
                  );
                }
                if (at === "image" && att.url) {
                  return <div key={att.id}><img src={att.url} alt={att.name || "Image"} className="max-w-[16.25rem] max-h-[200px] rounded-xl border border-white/30 object-cover shadow-none" />{saveBtn}</div>;
                }
                if (at === "video" && att.url) {
                  return (
                    <div key={att.id}>
                      <div className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-none"><video src={att.url} controls className="w-full" preload="metadata" /></div>
                      {saveBtn}
                    </div>
                  );
                }
                if (at === "audio" && att.url) {
                  return (
                    <div key={att.id}>
                      <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2"><Music className="w-4 h-4 opacity-60" /><audio src={att.url} controls className="h-8" preload="metadata" /><span className="text-[0.625rem] truncate max-w-[7.5rem]">{att.name || "Audio"}</span></div>
                      {saveBtn}
                    </div>
                  );
                }
                if (at === "pdf") {
                  return (
                    <div key={att.id}>
                      <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2"><FileText className="w-4 h-4 opacity-60" /><span className="text-xs truncate max-w-[12.5rem]">{att.name || "PDF"}</span></div>
                      {saveBtn}
                    </div>
                  );
                }
                if (at === "note" || at === "vault") {
                  return (
                    <div key={att.id} className="rounded-xl border border-white/30 bg-white/20 px-3 py-2 max-w-[16.25rem]">
                      <div className="flex items-center gap-1 mb-1"><StickyNote className="w-3.5 h-3.5 opacity-60" /><span className="text-[0.625rem] font-medium truncate">{att.name || "Note"}</span></div>
                      {att.vaultContent && <p className="text-[0.6875rem] text-black/70 line-clamp-3 whitespace-pre-wrap">{att.vaultContent.slice(0, 200)}</p>}
                    </div>
                  );
                }
                if ((at === "link" || at === "bookmark") && attUrl) {
                  return (
                    <div key={att.id} className="w-full max-w-[20rem]">
                      <LinkPreview
                        url={attUrl}
                        title={att.linkTitle || att.name || ""}
                        description={att.linkDescription || ""}
                        image={att.linkImage || ""}
                        siteName={att.linkSiteName || ""}
                        favicon={att.linkFavicon || ""}
                        authorName={att.authorName || ""}
                        authorHandle={att.authorHandle || ""}
                        oembedType={att.oembedType || ""}
                        variant="vault"
                      />
                      {saveBtn}
                    </div>
                  );
                }
                return (
                  <div key={att.id}>
                    <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2"><FileText className="w-4 h-4 opacity-60" /><span className="text-xs truncate max-w-[12.5rem]">{att.name || att.url || "File"}</span></div>
                    {saveBtn}
                  </div>
                );
              })}
            </div>
          )}
          {(() => {
            const promptText = msg.content || "";
            const isLongPrompt = promptText.length > 320;
            const isPromptExpanded = msg.id ? isUserPromptExpanded : true;
            const collapsedClampStyle = isLongPrompt && !isPromptExpanded
              ? { display: "-webkit-box" as const, WebkitLineClamp: 5 as any, WebkitBoxOrient: "vertical" as any, overflow: "hidden" as const }
              : undefined;
            if (isEditingPrompt) {
              const commitEdit = () => {
                const next = editDraft.trim();
                if (!next) return;
                setIsEditingPrompt(false);
                onEditResend(msg.id, next);
              };
              return (
                <div className="max-w-[80%] w-full flex flex-col items-end gap-2">
                  <textarea
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                      else if (e.key === "Escape") { e.preventDefault(); setIsEditingPrompt(false); }
                    }}
                    rows={Math.min(10, Math.max(2, editDraft.split("\n").length))}
                    className="w-full min-w-[260px] rounded-2xl px-4 py-3 text-sm leading-relaxed text-black/90 dark:text-white/90 bg-background border border-black/10 dark:border-white/15 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400/50"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsEditingPrompt(false)}
                      className="px-3 py-1 rounded-md text-xs text-black/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={commitEdit}
                      disabled={!editDraft.trim()}
                      className="px-3 py-1 rounded-md text-xs font-semibold bg-blue-500/15 border border-blue-400/40 text-blue-700 dark:text-blue-200 hover:bg-blue-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Send
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div className="group max-w-[80%] flex flex-col items-end">
                <div
                  className="lykn-user-prompt-bubble rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed text-black/90 dark:text-white/90 border border-black/8 dark:border-white/10 bg-background shadow-[0_4px_14px_rgba(0,0,0,0.06)] [&_table]:my-2 [&_td]:px-2 [&_th]:px-2"
                  style={collapsedClampStyle}
                >
                  <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS} components={mdComponents}>{normalizeChecklistSyntax(promptText)}</ReactMarkdown>
                </div>
                <div className="flex items-center gap-1 mt-1">
                  {msg.id && !isLoadInGreeting && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setEditDraft(promptText); setIsEditingPrompt(true); }}
                      title="Edit & resend"
                      aria-label="Edit & resend"
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/5 dark:hover:bg-white/10 transition-all"
                    >
                      <Pencil className="w-3 h-3" /><span className="leading-none">Edit</span>
                    </button>
                  )}
                  {isLongPrompt && msg.id && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleUserPromptExpanded(msg.id); }}
                      title={isPromptExpanded ? "Show less" : "Show full prompt"}
                      aria-label={isPromptExpanded ? "Show less" : "Show full prompt"}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    >
                      {isPromptExpanded
                        ? <span className="leading-none">Show less</span>
                        : <><MoreHorizontal className="w-3.5 h-3.5" /><span className="leading-none">Show more</span></>}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}
      {msg.role === "user" && msg.aiResponse && (
        <div className="flex justify-start">
          <div className="w-full">
            {/* Expanded: just a small collapse button — no header pill.
                Collapsed: slim transparent row with a one-line preview. */}
            {!isLoadInGreeting && (
              <button
                type="button"
                title={isAiExpanded ? "Collapse response" : "Expand response"}
                aria-label={isAiExpanded ? "Collapse response" : "Expand response"}
                className={`flex items-center gap-2 transition-all text-left ${
                  isAiExpanded
                    ? "h-6 w-6 justify-center rounded-md text-black/35 hover:bg-black/5 hover:text-black/70 dark:text-white/35 dark:hover:bg-white/10 dark:hover:text-white/70"
                    : "w-full px-0 py-0.5"
                }`}
                onClick={() => toggleAiExpanded(msg.id)}
              >
                <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isAiExpanded ? "rotate-90" : "text-black/40 dark:text-white/40"}`} />
                {!isAiExpanded && (
                  <span className="text-sm text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                    {(msg as any).aiImageUrl ? "Generated image" : getCollapsedPreview(msg.aiResponse || "")}
                  </span>
                )}
              </button>
            )}
            <div className={
              isLoadInGreeting
                ? "mt-0"
                : `grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${isAiExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0"}`
            }>
              <div className="overflow-hidden min-h-0 group/aifocused">
                {(msg as any).aiImageUrl ? (
                  <div className="px-4 py-3">
                    <img src={(msg as any).aiImageUrl} alt="Generated image" className="max-w-full rounded-xl shadow-none" style={{ maxHeight: "320px" }} />
                    <button type="button" className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedMediaUrls.has((msg as any).aiImageUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/25 bg-white/35 backdrop-blur-sm text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={savedMediaUrls.has((msg as any).aiImageUrl)} onClick={() => { onSaveAiImage((msg as any).aiImageUrl, msg.content, { storagePath: (msg as any).aiImageStoragePath }); }}>
                      {savedMediaUrls.has((msg as any).aiImageUrl) ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                    </button>
                  </div>
                ) : (() => {
                  // Render the AI response as a single continuous
                  // markdown block. The drag-into-grid feature has
                  // been retired, so we no longer split each reply
                  // into per-paragraph "section chunks" with their
                  // own select / drag affordances — that machinery
                  // added a lot of visual noise (hover boxes, grip
                  // handles, "add to grid" buttons) for a workflow
                  // that no longer exists.
                  //
                  // The load-in greeting still peels its opening
                  // salutation off as a hero heading so the briefing
                  // has a clear visual anchor; everything after the
                  // first blank line is rendered as ordinary
                  // markdown underneath.
                  const raw = String(aiResponse || "");
                  let heading: string | null = null;
                  let body = raw;
                  if (isLoadInGreeting) {
                    const trimmed = raw.trimStart();
                    const nl = trimmed.indexOf("\n");
                    const first =
                      nl < 0 ? trimmed : trimmed.slice(0, nl).trim();
                    const rest = nl < 0 ? "" : trimmed.slice(nl + 1).trimStart();
                    if (first && first.length < 120 && !/^[#\-*]/.test(first)) {
                      heading = first;
                      body = rest;
                    }
                  }
                  // Safety net: if the model dumped a full HTML document into
                  // the response text instead of routing it through the artifact
                  // builder, render it as a preview card (sandboxed iframe /
                  // openable in the panel) rather than leaking raw markup — and
                  // show a "building" placeholder while it's still streaming.
                  const { html: leakedHtml, rest: bodyRest, pending: htmlPending } = extractLeakedHtmlDocument(body);
                  const leakedArtifact = leakedHtml ? buildLeakedHtmlArtifact(msg.id, leakedHtml) : null;
                  return (
                    <div className="px-4 py-3">
                      {heading ? (
                        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight text-black/90 dark:text-white/90 mb-3">
                          {heading}
                        </h1>
                      ) : null}
                      {bodyRest ? (
                        <div className="text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
                          <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS} components={mdComponents}>
                            {normalizeChecklistSyntax(bodyRest)}
                          </ReactMarkdown>
                        </div>
                      ) : null}
                      {leakedArtifact ? (
                        <div className="mt-2 flex flex-col gap-2 max-w-[min(100%,42rem)] w-full">
                          <ChatArtifactCard artifact={leakedArtifact} onOpen={onOpenArtifact ? () => onOpenArtifact(leakedArtifact) : undefined} />
                        </div>
                      ) : htmlPending ? (
                        <div className="mt-2 max-w-[min(100%,42rem)] w-full">
                          <ArtifactBuildingPlaceholder status={inlineThinkingStatus} />
                        </div>
                      ) : inlineThinkingStatus && !isBuildSlotStatus(inlineThinkingStatus) ? (
                        <div className="mt-3">
                          <ThinkingIndicator status={inlineThinkingStatus} />
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                {Array.isArray(msg.aiResponseSections) && msg.aiResponseSections.length > 0 && (
                  // Structured load-in greeting: heading per topic, each
                  // update rendered as a row with an inline CTA button.
                  // Replaces the prior flat "all buttons at the bottom"
                  // layout — every row's action is co-located with the
                  // update it relates to, so a user scanning by topic
                  // never has to look elsewhere to take an action on
                  // that line. Falls back to `aiResponseActions` only
                  // when no sections were attached to the message.
                  <div className="px-4 pb-3 pt-2 space-y-4">
                    {msg.aiResponseSections.map((sec) => {
                      const isUserSection =
                        typeof sec.userSectionId === "string" &&
                        sec.userSectionId.length > 0;
                      const isEditing =
                        isUserSection && editingUserSectionId === sec.userSectionId;
                      if (isEditing) {
                        return (
                          <div key={`${msg.id}-sec-${sec.id}`}>
                            <LoadInUserSectionEditor
                              sectionId={sec.userSectionId!}
                              initialHeading={sec.heading}
                              initialBody={sec.summary || ""}
                              onDone={() => setEditingUserSectionId(null)}
                              onChanged={onLoadInGreetingRefresh}
                            />
                          </div>
                        );
                      }
                      return (
                      <div key={`${msg.id}-sec-${sec.id}`} className="space-y-2 group/usersec">
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-lg font-semibold tracking-tight text-black/90 dark:text-white/90">
                            {sec.heading}
                          </div>
                          {isUserSection ? (
                            <button
                              type="button"
                              onClick={() =>
                                setEditingUserSectionId(sec.userSectionId!)
                              }
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors opacity-0 group-hover/usersec:opacity-100 focus:opacity-100"
                              aria-label="Edit section"
                            >
                              <Pencil className="w-3 h-3" />
                              <span>Edit</span>
                            </button>
                          ) : null}
                        </div>
                        {sec.intro ? (
                          <div className="text-[13px] text-black/55 dark:text-white/55 -mt-1">
                            {sec.intro}
                          </div>
                        ) : null}
                        {sec.summary ? (
                          // Prose-summary text. Renders as a paragraph
                          // before any bubble stack so the user gets
                          // the recap, then can drill into specifics.
                          <div className="text-sm leading-relaxed text-black/85 dark:text-white/85">
                            <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS} components={mdComponents}>
                              {sec.summary}
                            </ReactMarkdown>
                          </div>
                        ) : null}
                        {Array.isArray(sec.groups) && sec.groups.length > 0 ? (
                          // Notification-bubble layout: one collapsible
                          // bubble per source / group. Click to drop
                          // down into the underlying items, each of
                          // which links out to its canonical URL
                          // (external for connector items, internal
                          // for synthesis-layer beliefs / neurons).
                          <div className="space-y-2">
                            {sec.groups.map((group) => (
                              <LoadInBubble
                                key={`${msg.id}-${sec.id}-grp-${group.id}`}
                                msgId={msg.id}
                                group={group}
                              />
                            ))}
                          </div>
                        ) : Array.isArray(sec.chips) && sec.chips.length > 0 ? (
                          // App-shelf layout: a row of brand-mark
                          // chips for the "Connect the rest" section.
                          // No labelled rows or pitch text — just the
                          // logos of recommended apps, laid out like
                          // a home-screen tray. Tapping one routes to
                          // /connections#<id> which the connections
                          // grid auto-scrolls and highlights.
                          <div className="flex flex-wrap gap-2 pt-1">
                            {sec.chips.map((chip) => {
                              const chipNav = safeNavHref(chip.href);
                              if (!chipNav) {
                                return (
                                  <div
                                    key={`${msg.id}-${sec.id}-chip-${chip.id}`}
                                    title={`Connect ${chip.label}`}
                                    aria-label={`Connect ${chip.label}`}
                                    className="group/chip flex flex-col items-center gap-1 w-[68px] py-2 px-1 rounded-xl border border-white/40 dark:border-white/10 bg-white/45 dark:bg-white/[0.04] backdrop-blur-sm"
                                  >
                                    <div className="w-10 h-10 rounded-lg bg-white dark:bg-white/95 ring-1 ring-black/[0.06] dark:ring-white/10 shadow-sm flex items-center justify-center overflow-hidden">
                                      <img
                                        src={chip.iconUrl}
                                        alt=""
                                        className="w-7 h-7 object-contain"
                                      />
                                    </div>
                                    <span className="text-[10px] font-medium text-black/70 dark:text-white/70 truncate w-full text-center">
                                      {chip.label}
                                    </span>
                                  </div>
                                );
                              }
                              const isInternal = chipNav.kind === "internal";
                              const onChipClick = (e: React.MouseEvent) => {
                                if (!isInternal) return;
                                if (
                                  e.metaKey ||
                                  e.ctrlKey ||
                                  e.shiftKey ||
                                  (e as any).button === 1
                                )
                                  return;
                                e.preventDefault();
                                navigate(chipNav.href);
                              };
                              return (
                                <a
                                  key={`${msg.id}-${sec.id}-chip-${chip.id}`}
                                  href={chipNav.href}
                                  onClick={onChipClick}
                                  target={isInternal ? undefined : "_blank"}
                                  rel={isInternal ? undefined : "noopener noreferrer"}
                                  title={`Connect ${chip.label}`}
                                  aria-label={`Connect ${chip.label}`}
                                  className="group/chip flex flex-col items-center gap-1 w-[68px] py-2 px-1 rounded-xl border border-white/40 dark:border-white/10 bg-white/45 dark:bg-white/[0.04] hover:bg-white/70 dark:hover:bg-white/[0.08] hover:border-black/15 dark:hover:border-white/20 backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)]"
                                >
                                  <div className="w-10 h-10 rounded-lg bg-white dark:bg-white/95 ring-1 ring-black/[0.06] dark:ring-white/10 shadow-sm flex items-center justify-center overflow-hidden">
                                    <img
                                      src={chip.iconUrl}
                                      alt=""
                                      className="w-7 h-7 object-contain"
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                      onError={(e) => {
                                        (e.currentTarget as HTMLImageElement).style.display = "none";
                                      }}
                                    />
                                  </div>
                                  <span className="text-[10.5px] font-medium text-black/65 dark:text-white/65 truncate max-w-full leading-tight">
                                    {chip.label}
                                  </span>
                                </a>
                              );
                            })}
                          </div>
                        ) : sec.summary ? null : (
                        <div className="space-y-1.5">
                          {sec.items.map((item, ii) => {
                            const act = item.action;
                            const tone = act?.tone || "neutral";
                            const btnToneCls = !act
                              ? ""
                              : tone === "primary"
                                ? "border-blue-400/40 bg-blue-500/10 hover:bg-blue-500/15 text-blue-700 dark:text-blue-100"
                                : tone === "amber"
                                  ? "border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/15 text-amber-800 dark:text-amber-100"
                                  : tone === "emerald"
                                    ? "border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-100"
                                    : tone === "fuchsia"
                                      ? "border-fuchsia-400/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-100"
                                      : "border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/5 hover:bg-white/55 dark:hover:bg-white/10 text-black/75 dark:text-white/90";
                            const isInternal = act?.href.startsWith("/") ?? false;
                            const onActClick = (e: React.MouseEvent) => {
                              if (!act) return;
                              if (!isInternal) return;
                              if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1) return;
                              e.preventDefault();
                              navigate(act.href);
                            };
                            const hasIcon =
                              typeof act?.iconUrl === "string" &&
                              act.iconUrl.length > 0;
                            const hasItemIcon =
                              typeof item?.iconUrl === "string" &&
                              item.iconUrl.length > 0;
                            const isOverdueSubtitle =
                              typeof item.subtitle === "string" &&
                              /^Overdue\b/i.test(item.subtitle);
                            return (
                              <div
                                key={`${msg.id}-sec-${sec.id}-row-${ii}`}
                                className="flex items-start gap-3 rounded-lg border border-white/10 dark:border-white/5 bg-white/30 dark:bg-white/[0.03] px-3 py-2 text-black/85 dark:text-white/90"
                              >
                                {hasItemIcon ? (
                                  <div className="w-7 h-7 rounded-md bg-white dark:bg-white/95 ring-1 ring-black/[0.06] dark:ring-white/10 shadow-sm overflow-hidden flex items-center justify-center flex-shrink-0 mt-0.5">
                                    <img
                                      src={item.iconUrl}
                                      alt=""
                                      className="w-5 h-5 object-contain"
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                      onError={(e) => {
                                        (e.currentTarget as HTMLImageElement).style.display = "none";
                                      }}
                                    />
                                  </div>
                                ) : null}
                                <div className="flex-1 min-w-0 leading-tight">
                                  <div className="text-[12.5px] font-medium truncate">
                                    {item.title}
                                  </div>
                                  {item.subtitle ? (
                                    isOverdueSubtitle ? (
                                      <div className="mt-1 flex items-center gap-1.5 min-w-0">
                                        <span className="inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-red-500/15 text-red-700 dark:bg-red-400/20 dark:text-red-100">
                                          Overdue
                                        </span>
                                        {item.subtitle.replace(/^Overdue\s*(?:·\s*)?/i, "").trim() ? (
                                          <span className="text-[11px] text-black/55 dark:text-white/55 truncate">
                                            {item.subtitle.replace(/^Overdue\s*(?:·\s*)?/i, "").trim()}
                                          </span>
                                        ) : null}
                                      </div>
                                    ) : (
                                      <div className="text-[11px] text-black/55 dark:text-white/55 mt-0.5 truncate">
                                        {item.subtitle}
                                      </div>
                                    )
                                  ) : null}
                                </div>
                                {act ? (
                                  <a
                                    href={act.href}
                                    onClick={onActClick}
                                    target={isInternal ? undefined : "_blank"}
                                    rel={isInternal ? undefined : "noopener noreferrer"}
                                    className={`group/lyknrow inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition-all backdrop-blur-sm flex-shrink-0 ${btnToneCls}`}
                                  >
                                    {hasIcon ? (
                                      <img
                                        src={act.iconUrl}
                                        alt=""
                                        className="w-3.5 h-3.5 flex-shrink-0 rounded-sm object-contain"
                                        loading="lazy"
                                        referrerPolicy="no-referrer"
                                        onError={(e) => {
                                          (e.currentTarget as HTMLImageElement).style.display = "none";
                                        }}
                                      />
                                    ) : null}
                                    <span>{act.label}</span>
                                    {!hasIcon ? (
                                      <ArrowRight className="w-3 h-3 opacity-70 group-hover/lyknrow:translate-x-0.5 transition-transform" />
                                    ) : null}
                                  </a>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                        )}
                      </div>
                      );
                    })}
                    {isLoadInGreeting && (
                      // User-authored sections composer. Lives at the
                      // very bottom of the briefing so the user can
                      // pin their own focus / mantras / reminders to
                      // the daily load-in alongside the auto-built
                      // lanes. CRUD round-trips to supabase, then
                      // triggers the parent to re-fetch the greeting
                      // so the new section appears in place.
                      <LoadInUserSectionsComposer
                        onChanged={onLoadInGreetingRefresh}
                      />
                    )}
                  </div>
                )}
                {isLoadInGreeting &&
                  !(Array.isArray(msg.aiResponseSections) && msg.aiResponseSections.length > 0) && (
                    // Fallback: load-in greeting with no auto-built
                    // sections still surfaces the "+ Add a section"
                    // affordance so a brand-new user can pin their
                    // own first card before anything else lands.
                    <div className="px-4 pb-3 pt-2">
                      <LoadInUserSectionsComposer
                        onChanged={onLoadInGreetingRefresh}
                      />
                    </div>
                  )}
                {Array.isArray(msg.aiResponseActions) && msg.aiResponseActions.length > 0 && !(Array.isArray(msg.aiResponseSections) && msg.aiResponseSections.length > 0) && (
                  // Legacy flat-strip layout — kept as a fallback for any
                  // turn that ships actions without the structured
                  // sections payload. Internal hrefs (`/...`) navigate
                  // via react-router so they don't trigger a full page
                  // reload; everything else opens in a new tab.
                  <div className="px-4 pb-3 pt-1 flex flex-wrap gap-2">
                    {msg.aiResponseActions.map((act, ai) => {
                      const tone = act.tone || "neutral";
                      const toneCls =
                        tone === "primary"
                          ? "border-blue-400/40 bg-blue-500/10 hover:bg-blue-500/15 text-blue-700 dark:text-blue-100"
                          : tone === "amber"
                            ? "border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/15 text-amber-800 dark:text-amber-100"
                            : tone === "emerald"
                              ? "border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-100"
                              : tone === "fuchsia"
                                ? "border-fuchsia-400/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-100"
                                : "border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/5 hover:bg-white/55 dark:hover:bg-white/10 text-black/75 dark:text-white/90";
                      const actNav = safeNavHref(act.href);
                      if (!actNav) return null;
                      const isInternal = actNav.kind === "internal";
                      const onClick = (e: React.MouseEvent) => {
                        if (!isInternal) return; // let the anchor handle external nav
                        // Allow modifier-clicks (cmd/ctrl/middle) to keep
                        // their browser-native "open in new tab" behavior.
                        if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1) return;
                        e.preventDefault();
                        navigate(actNav.href);
                      };
                      // Glyph: prefer the platform's brand favicon
                      // (used by the "Connect <Platform>" prompts) so
                      // each suggested connector is immediately
                      // recognisable. Fallback is the default arrow
                      // we ship with every other load-in action.
                      const hasIcon = typeof act.iconUrl === "string" && act.iconUrl.length > 0;
                      return (
                        <a
                          key={`${msg.id}-act-${ai}`}
                          href={actNav.href}
                          onClick={onClick}
                          target={isInternal ? undefined : "_blank"}
                          rel={isInternal ? undefined : "noopener noreferrer"}
                          className={`group/lyknact inline-flex items-start gap-2 rounded-xl border px-3 py-2 text-left transition-all backdrop-blur-sm shadow-[0_2px_8px_rgba(0,0,0,0.04)] ${toneCls}`}
                        >
                          {hasIcon ? (
                            <img
                              src={act.iconUrl}
                              alt=""
                              className="w-4 h-4 mt-[2px] flex-shrink-0 rounded-sm object-contain"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                // If the brand favicon 404s (rare,
                                // but Google's s2 service sometimes
                                // misses obscure domains), hide the
                                // broken <img> so the layout doesn't
                                // ship a blank box.
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <ArrowRight className="w-3.5 h-3.5 mt-[3px] flex-shrink-0 opacity-70 group-hover/lyknact:translate-x-0.5 transition-transform" />
                          )}
                          <span className="flex flex-col leading-tight">
                            <span className="text-xs font-semibold">{act.label}</span>
                            {act.description ? (
                              <span className="text-[10.5px] opacity-70 mt-0.5">
                                {act.description}
                              </span>
                            ) : null}
                          </span>
                        </a>
                      );
                    })}
                  </div>
                )}
                {(msg as any).aiYouTubeUrls && (msg as any).aiYouTubeUrls.length > 0 && (
                  <div className="px-4 pb-3 space-y-3">
                    {(msg as any).aiYouTubeUrls.map((yt: { url: string; videoId: string }) => (
                      <div key={yt.videoId}>
                        <div className="rounded-xl overflow-hidden border border-white/30 shadow-none">
                          <iframe
                            src={`https://www.youtube-nocookie.com/embed/${yt.videoId}`}
                            className="w-full aspect-video"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            allowFullScreen
                            referrerPolicy="strict-origin-when-cross-origin"
                            title={`YouTube ${yt.videoId}`}
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <button
                            type="button"
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedYouTubeIds.has(yt.videoId) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/25 bg-white/35 backdrop-blur-sm text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`}
                            disabled={savedYouTubeIds.has(yt.videoId)}
                            onClick={() => { onSaveYouTube(yt.videoId, yt.url); }}
                          >
                            {savedYouTubeIds.has(yt.videoId) ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                          </button>
                          <a
                            href={yt.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => handleLyknBrowserClick(e, yt.url, "YouTube")}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-white/25 bg-white/35 backdrop-blur-sm text-black/70 hover:border-black/30 hover:shadow-sm transition-all"
                          >
                            <Play className="w-3 h-3" /> Open on YouTube
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!hideMessageSources && Array.isArray((msg as any).sources) && (msg as any).sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).sources.map((src: { title: string; url: string }, i: number) => {
                      const href = safeExternalUrl(src.url) || src.url;
                      return (
                      <a
                        key={i}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => handleLyknBrowserClick(e, href, src.title)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/25 dark:border-white/8 bg-white/35 dark:bg-white/4 backdrop-blur-sm text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all"
                      >
                        <SiteFavicon url={href} className="h-3.5 w-3.5" />
                        <span className="truncate max-w-[10rem]">{src.title}</span>
                      </a>
                      );
                    })}
                  </div>
                )}
                {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).aiWebLinks.map((link: string) => {
                      let domain = "";
                      try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                      const href = safeExternalUrl(link) || link;
                      return (
                        <a
                          key={link}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => handleLyknBrowserClick(e, href, domain)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/25 dark:border-white/8 bg-white/35 dark:bg-white/4 backdrop-blur-sm text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all"
                        >
                          <SiteFavicon url={href} className="h-3.5 w-3.5" />
                          <span className="truncate max-w-[10rem]">{domain}</span>
                        </a>
                      );
                    })}
                  </div>
                )}
                {!inlineThinkingStatus && (
                <div className="flex items-center gap-0.5 px-3 pb-2 pt-0.5">
                  {!isMobilePhone && !gridDisabled && (
                    <button type="button" title="Add to grid" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors" onClick={() => addChatResponseToGrid(msg.aiResponse || "")}>
                      <GridIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = msg.aiResponse || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void copyMarkdownAsRich(text); } }}>
                    <Share2 className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Download" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = msg.aiResponse || ""; const blob = new Blob([text], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "response.txt"; a.click(); URL.revokeObjectURL(url); }}>
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Copy" className={`p-1.5 rounded-md transition-colors ${isCopied ? "text-blue-500 bg-blue-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => { onCopyMessage(msg.id, msg.aiResponse || ""); }}>
                    {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <button type="button" title="Regenerate" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { onRegenerate(msg.id, msg.content); }}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-3.5 bg-black/10 dark:bg-white/10 mx-1" />
                  <button type="button" title="Like" className={`p-1.5 rounded-md transition-colors ${reaction === "like" ? "text-green-600 bg-green-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "like")}>
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Dislike" className={`p-1.5 rounded-md transition-colors ${reaction === "dislike" ? "text-red-500 bg-red-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "dislike")}>
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                </div>
                )}
              </div>
            </div>
            {(() => {
              const artifacts = sortArtifactsForDisplay(extractChatArtifacts(msg.toolCalls));
              if (!artifacts.length) {
                // Once narration names the artifact / starts writing code,
                // occupy the slot the card will take. Don't flash this on a
                // clarifying question (those only get the under-text spinner).
                const showBuildSlot =
                  Boolean(inlineThinkingStatus) && isBuildSlotStatus(inlineThinkingStatus);
                if (showBuildSlot) {
                  return (
                    <div className="px-1 mt-1 max-w-[min(100%,42rem)] w-full">
                      <ArtifactBuildingPlaceholder status={inlineThinkingStatus} />
                    </div>
                  );
                }
                return null;
              }
              // With a popup handler, show a compact "open" chip instead of
              // the full inline preview; the artifact lives in the popup.
              // Without a handler, fall back to the card.
              if (onOpenArtifact) {
                return (
                  <div className="px-1 flex flex-col gap-2 max-w-[min(100%,30rem)] w-full">
                    {artifacts.map((art) => (
                      <button
                        key={art.id}
                        type="button"
                        onClick={() => onOpenArtifact(art)}
                        className="group flex items-center gap-3 rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] px-3.5 py-3 text-left shadow-none transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.07] w-full"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-black/80 text-white dark:bg-white/15 dark:text-white">
                          <FileText className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-foreground">{art.title}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {art.kind === "html" ? "Artifact · open preview" : (art.format || "file").toUpperCase()}
                          </span>
                        </span>
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                          Open
                        </span>
                      </button>
                    ))}
                  </div>
                );
              }
              return (
                <div className="px-1 flex flex-col gap-2 max-w-[min(100%,42rem)] w-full">
                  {artifacts.map((art) => (
                    <ChatArtifactCard key={art.id} artifact={art} />
                  ))}
                </div>
              );
            })()}
            {Array.isArray(msg.aiNeurons) && msg.aiNeurons.length > 0 && (
              <div className="px-1 flex flex-col gap-2 max-w-[32rem]">
                {msg.aiNeurons.map((att) => (
                  <ChatNeuronCard key={att.id} attachment={att} />
                ))}
              </div>
            )}
            {msg.factNeuron ? (
              <div className="px-1 max-w-[min(100%,28rem)]">
                <FactConfirmChip
                  fact={msg.factNeuron}
                  onChange={(next) => onFactNeuronChange?.(msg.id, next)}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
      {msg.role !== "user" && (
        <div className="flex justify-start">
          <div className="w-full">
            {/* Same treatment as user-turn responses: small collapse button
                when open, slim preview row when collapsed — no header pill. */}
            <button
              type="button"
              title={isAiExpanded ? "Collapse response" : "Expand response"}
              aria-label={isAiExpanded ? "Collapse response" : "Expand response"}
              className={`flex items-center gap-2 transition-all text-left ${
                isAiExpanded
                  ? "h-6 w-6 justify-center rounded-md text-black/35 hover:bg-black/5 hover:text-black/70 dark:text-white/35 dark:hover:bg-white/10 dark:hover:text-white/70"
                  : "w-full px-0 py-0.5"
              }`}
              onClick={() => toggleAiExpanded(msg.id)}
            >
              <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isAiExpanded ? "rotate-90" : "text-black/40 dark:text-white/40"}`} />
              {!isAiExpanded && (
                <span className="text-sm text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                  {getCollapsedPreview(msg.content || "")}
                </span>
              )}
            </button>
            <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${isAiExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0"}`}>
              <div className="overflow-hidden min-h-0">
                {(() => {
                  // Safety net: if the model dumped a full HTML document into
                  // the chat text instead of routing it through the artifact
                  // builder, render it as a preview card (sandboxed iframe /
                  // openable in the panel) instead of leaking raw markup.
                  const { html, rest, pending } = extractLeakedHtmlDocument(msg.content || "");
                  const leaked = html ? buildLeakedHtmlArtifact(msg.id, html) : null;
                  return (
                    <>
                      {rest ? (
                        <div className="px-4 py-3 text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
                          <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS} components={mdComponents}>
                            {normalizeChecklistSyntax(rest)}
                          </ReactMarkdown>
                        </div>
                      ) : null}
                      {leaked ? (
                        <div className="px-4 pb-3 pt-1 flex flex-col gap-2 max-w-[min(100%,42rem)] w-full">
                          <ChatArtifactCard artifact={leaked} onOpen={onOpenArtifact ? () => onOpenArtifact(leaked) : undefined} />
                        </div>
                      ) : pending ? (
                        <div className="px-4 pb-3 pt-1 max-w-[min(100%,42rem)] w-full">
                          <ArtifactBuildingPlaceholder />
                        </div>
                      ) : null}
                    </>
                  );
                })()}
                {!hideMessageSources && Array.isArray((msg as any).sources) && (msg as any).sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).sources.map((src: { title: string; url: string }, i: number) => {
                      const href = safeExternalUrl(src.url) || src.url;
                      return (
                      <a
                        key={i}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => handleLyknBrowserClick(e, href, src.title)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/25 dark:border-white/8 bg-white/35 dark:bg-white/4 backdrop-blur-sm text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all"
                      >
                        <SiteFavicon url={href} className="h-3.5 w-3.5" />
                        <span className="truncate max-w-[10rem]">{src.title}</span>
                      </a>
                      );
                    })}
                  </div>
                )}
                {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).aiWebLinks.map((link: string) => {
                      let domain = "";
                      try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                      const href = safeExternalUrl(link) || link;
                      return (
                        <a
                          key={link}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => handleLyknBrowserClick(e, href, domain)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/25 dark:border-white/8 bg-white/35 dark:bg-white/4 backdrop-blur-sm text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all"
                        >
                          <SiteFavicon url={href} className="h-3.5 w-3.5" />
                          <span className="truncate max-w-[10rem]">{domain}</span>
                        </a>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-0.5 px-3 pb-2 pt-0.5">
                  <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = (msg as any).content || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void copyMarkdownAsRich(text); } }}>
                    <Share2 className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Download" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = (msg as any).content || ""; const blob = new Blob([text], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "response.txt"; a.click(); URL.revokeObjectURL(url); }}>
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Copy" className={`p-1.5 rounded-md transition-colors ${isCopied ? "text-blue-500 bg-blue-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => { onCopyMessage(msg.id, (msg as any).content || ""); }}>
                    {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <button type="button" title="Regenerate" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { onRegenerateNonUser(msg.id, idx); }}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-3.5 bg-black/10 dark:bg-white/10 mx-1" />
                  <button type="button" title="Like" className={`p-1.5 rounded-md transition-colors ${reaction === "like" ? "text-green-600 bg-green-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "like")}>
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Dislike" className={`p-1.5 rounded-md transition-colors ${reaction === "dislike" ? "text-red-500 bg-red-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "dislike")}>
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </React.Fragment>
  );
});

const LyknChatView: React.FC<LyknChatViewProps> = React.memo(function LyknChatView({
  chatMessages,
  isChatLoading,
  thinkingStatus,
  chatInputRef,
  chatInputValue,
  onChatInputChange,
  onSend,
  typedWelcome,
  welcomeSubtitle,
  isMobileGrid,
  isMobilePhone = false,
  isDictating,
  isTranscribing,
  canvasFileBlocks,
  focusedChatAttachments,
  onPaste,
  onResizeInput,
  chatPanelInputRef,
  chatScrollRef,
  buildChatMarkdownComponents,
  savedMediaUrls,
  savedYouTubeIds,
  onSaveYouTube,
  onSaveAttachment,
  onSaveAiImage,
  onSaveLink,
  expandedAiMsgIds,
  toggleAiExpanded,
  expandedUserPromptIds,
  toggleUserPromptExpanded,
  getCollapsedPreview,
  copiedMsgId,
  onCopyMessage,
  addChatResponseToGrid,
  gridDisabled = false,
  renderFocusedAttachmentPreview,
  onDragOver,
  onDrop,
  chatBarToolbar,
  composerMinH = 52,
  chatReactions,
  onReaction,
  onRegenerate,
  onEditResend,
  onRegenerateNonUser,
  onLoadInGreetingRefresh,
  compactPreview = false,
  threadFooter = null,
  composerAbove = null,
  composerBelow = null,
  composerPlaceholder = "Ask me anything...",
  pinComposerToBottom = false,
  researchSidebar = null,
  hideMessageSources = false,
  activeArtifact = null,
  onActiveArtifactChange,
  onSaveArtifact,
  chatKey,
  onFactNeuronChange,
  keepThinkingWhileLoading = false,
}) {
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set());
  const chunkMapRef = useRef<Map<string, string>>(new Map());
  const lastSeenArtifactRef = useRef<string | null>(null);
  const artifactChatKeyRef = useRef<string | undefined>(undefined);
  const artifactSeededRef = useRef(false);
  const pendingArtifactOpenRef = useRef<ChatArtifact | null>(null);
  const dismissedArtifactKeyRef = useRef<string | null>(null);

  // Clicking a card opens the floating preview popup only. The LYKN browser
  // is a separate action — the panel's top-bar Open button.
  const onOpenArtifact = useCallback(
    (art: ChatArtifact) => {
      pendingArtifactOpenRef.current = null;
      dismissedArtifactKeyRef.current = null;
      onActiveArtifactChange?.(art);
    },
    [onActiveArtifactChange],
  );
  // Research rail (Studio Research page): fixed right column with the
  // deep-research links + Save report. The rail floats OVER the page — the
  // chat column keeps its width. The artifact is a popup, so both can show.
  const researchOpen = !!researchSidebar && !isMobilePhone;
  useEffect(() => {
    if (!onActiveArtifactChange) return;
    let newest: ChatArtifact | null = null;
    for (let i = chatMessages.length - 1; i >= 0 && !newest; i--) {
      const msg = chatMessages[i] as any;
      const arts = sortArtifactsForDisplay(extractChatArtifacts(msg?.toolCalls));
      if (arts.length) {
        newest = arts[0];
        continue;
      }
      // Preview-only HTML the model leaked into the reply (srcDoc card, no
      // tool call) — still auto-open the popup like a real artifact.
      // Prompt messages carry the assistant text on `aiResponse`.
      const reply = String(msg?.aiResponse || (msg?.role !== "user" ? msg?.content : "") || "");
      if (!reply) continue;
      const { html } = extractLeakedHtmlDocument(reply);
      if (html) newest = buildLeakedHtmlArtifact(msg.id, html);
    }
    const key = newest?.toolCallId || newest?.id || null;

    // Switched chats: re-baseline auto-open tracking. Popup open/close is
    // owned by useChatEngine (per-board snapshot) so Smash Arena in chat A
    // does not clear-and-leak into chat B — and switching back restores A.
    if (artifactChatKeyRef.current !== chatKey) {
      artifactChatKeyRef.current = chatKey;
      artifactSeededRef.current = false;
      lastSeenArtifactRef.current = null;
      pendingArtifactOpenRef.current = null;
      dismissedArtifactKeyRef.current = null;
    }

    // First time this chat's messages populate — establish a baseline without
    // opening (covers async thread hydration after a switch / on initial load).
    if (!artifactSeededRef.current) {
      if (chatMessages.length > 0) {
        artifactSeededRef.current = true;
        lastSeenArtifactRef.current = key;
      }
      return;
    }

    const openPopup = (art: ChatArtifact, artKey: string) => {
      if (dismissedArtifactKeyRef.current === artKey) return;
      pendingArtifactOpenRef.current = null;
      onActiveArtifactChange?.(art);
    };

    if (newest && key && key !== lastSeenArtifactRef.current) {
      lastSeenArtifactRef.current = key;
      // Wait until the coding turn finishes so the popup is the done build,
      // not a mid-stream preview. Vault save stays explicit (Save button or
      // the user asking the AI via lykn_saveFileToVault).
      if (isChatLoading) {
        pendingArtifactOpenRef.current = newest;
      } else {
        openPopup(newest, key);
      }
    } else if (!isChatLoading && pendingArtifactOpenRef.current) {
      const pending = pendingArtifactOpenRef.current;
      const pendingKey = pending.toolCallId || pending.id;
      openPopup(pending, pendingKey);
    }
  }, [chatMessages, chatKey, onActiveArtifactChange, isChatLoading]);

  const handleChunkClick = useCallback((e: React.MouseEvent, chunkKey: string, chunkText: string) => {
    chunkMapRef.current.set(chunkKey, chunkText);
    if (e.shiftKey) {
      setSelectedChunks((prev) => {
        const next = new Set(prev);
        if (next.has(chunkKey)) next.delete(chunkKey);
        else next.add(chunkKey);
        return next;
      });
    } else {
      setSelectedChunks(new Set());
    }
  }, []);

  const getSelectedText = useCallback((fallbackKey: string, fallbackText: string): string => {
    if (selectedChunks.size === 0) return fallbackText;
    const keys = Array.from(selectedChunks);
    if (!selectedChunks.has(fallbackKey)) keys.push(fallbackKey);
    keys.sort();
    return keys.map((k) => chunkMapRef.current.get(k) || "").filter(Boolean).join("\n\n");
  }, [selectedChunks]);

  // Stable callback used by every MessageItem to register its chunk
  // text into the shared map. Side-effect free at the parent level —
  // each message only mutates its own keys via useEffect.
  const registerChunks = useCallback((msgId: string, entries: Array<{ key: string; text: string }>) => {
    for (const e of entries) chunkMapRef.current.set(e.key, e.text);
  }, []);

  const isControlledInput = chatInputValue !== undefined;
  const handleComposerInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      chatInputRef.current = value;
      onChatInputChange(value);
      onResizeInput(e.currentTarget);
    },
    [chatInputRef, onChatInputChange, onResizeInput],
  );

  return (
    <>
      {/* Left collage panel — canvas files. Hidden in chat-only mode
          (`gridDisabled`) because the source surface isn't mounted. */}
      {canvasFileBlocks.length > 0 && !isMobileGrid && !gridDisabled && (
        <div className="fixed bottom-0 z-[66] w-[13.75rem] overflow-y-auto scrollbar-hide p-3 space-y-2 bg-transparent border-r border-black/5 dark:border-white/5 transition-all duration-300" style={{ top: "var(--header-height-sm, 4.2rem)", left: "var(--sidebar-offset, 0px)" }}>
          <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/40 dark:text-white/40 px-1 mb-1">Grid Files</p>
          <div className="flex flex-col gap-2">
            {canvasFileBlocks.map((item) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("application/x-grid-file", JSON.stringify(item));
                  e.dataTransfer.setData("text/plain", item.url);
                }}
                className="relative rounded-xl overflow-hidden bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-blue-400/50 transition-all group"
                title={`Drag to chat: ${item.name}`}
              >
                {item.type === "youtube" && item.thumbUrl ? (
                  <div className="aspect-video relative">
                    <img src={item.thumbUrl} alt={item.name} className="w-full h-full object-cover" draggable={false} />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-7 h-5 bg-red-600 rounded flex items-center justify-center"><Play className="w-2.5 h-2.5 text-white ml-px" fill="white" /></div>
                    </div>
                  </div>
                ) : item.type === "image" && item.thumbUrl ? (
                  <div className="aspect-square">
                    <img src={item.thumbUrl} alt={item.name} className="w-full h-full object-cover" draggable={false} />
                  </div>
                ) : item.type === "video" ? (
                  <div className="aspect-video bg-black flex items-center justify-center">
                    <Play className="w-5 h-5 text-white/60" />
                  </div>
                ) : item.type === "audio" ? (
                  <div className="aspect-square flex items-center justify-center bg-white/30 dark:bg-white/10">
                    <Music className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                ) : item.type === "pdf" ? (
                  <div className="aspect-square flex items-center justify-center bg-white/30 dark:bg-white/10">
                    <FileText className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                ) : item.type === "note" ? (
                  <>
                    <div className="glass-text-card relative rounded-lg p-2.5 min-h-[3rem]">
                      {item.isAi && <div className="pointer-events-none absolute inset-0 rounded-lg" style={{ background: "rgba(0,0,0,0.035)" }} />}
                      <p className="relative text-[0.6875rem] leading-relaxed text-black/80 dark:text-white/80 whitespace-pre-wrap break-words" style={{ display: "-webkit-box", WebkitLineClamp: 8, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.content || ""}</p>
                    </div>
                    <div className="px-1.5 py-1">
                      <span className="text-[9px] text-black/50 dark:text-white/50 leading-tight line-clamp-1 break-all">{item.isAi ? "AI Response" : item.name}</span>
                    </div>
                  </>
                ) : (
                  <div className="aspect-square flex items-center justify-center bg-white/30 dark:bg-white/10">
                    <Link2 className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                )}
                {item.type !== "note" && (
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3">
                    <span className="text-[9px] text-white leading-tight line-clamp-2 break-all">{item.name}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {chatMessages.length === 0 && !pinComposerToBottom ? (
        /* Empty state: identical to the canvas first-render welcome */
        <div
          // overflow-y-auto + my-auto on the column (instead of items-center)
          // so when the docket/attachments make the empty state taller than
          // the viewport it scrolls instead of clipping both ends unreachably.
          className={`lykn-chat-empty-state ${compactPreview ? "lykn-chat-focused-chat-preview absolute inset-0 z-[65]" : "fixed top-0 right-0 z-[65]"} flex justify-center overflow-y-auto px-4 py-4 transition-all duration-300 ${canvasFileBlocks.length > 0 && !isMobileGrid && !compactPreview ? "pl-[232px]" : ""}`}
          style={
            compactPreview
              ? undefined
              : {
                  left: isMobilePhone ? 0 : "var(--sidebar-offset, 0px)",
                  right: 0,
                  bottom: "var(--mobile-tabbar-clear, 0px)",
                }
          }
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div
            className={`mx-auto my-auto w-full max-w-2xl ${compactPreview ? "space-y-3 px-1" : "space-y-8 sm:space-y-10"}`}
          >
            <div className={`lykn-chat-ink pointer-events-none text-center ${compactPreview ? "space-y-1" : "space-y-2.5"}`}>
              <p
                className={`font-semibold tracking-tight text-black dark:text-white ${
                  compactPreview ? "text-sm min-h-0 line-clamp-2" : "text-xl sm:text-3xl min-h-0"
                }`}
              >
                {typedWelcome}
              </p>
              {welcomeSubtitle ? (
                <p
                  className={`text-black/55 dark:text-white/50 max-w-lg mx-auto leading-relaxed ${
                    compactPreview ? "text-[11px] line-clamp-2" : "text-[13px] sm:text-sm"
                  }`}
                >
                  {welcomeSubtitle}
                </p>
              ) : null}
            </div>
            <div className="mx-auto w-full flex flex-col gap-1">
              {composerAbove}
              <div className="lykn-chat-neu-chat-shell lykn-chat-chat-border-run-once p-2.5 sm:p-3 w-full transition-all duration-300 flex flex-col gap-1.5">
              {focusedChatAttachments.length > 0 && (
                <div className="mb-0 flex flex-wrap gap-2 items-end">
                  {focusedChatAttachments.map((att) => (
                    <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                  ))}
                </div>
              )}
              {isDictating || isTranscribing ? (
                <div className="w-full min-h-[3.25rem] lykn-chat-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
                  {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span></>)}
                </div>
              ) : (
                <textarea
                  ref={chatPanelInputRef}
                  autoFocus={isMobilePhone}
                  data-min-h={String(composerMinH)}
                  style={{ minHeight: composerMinH }}
                  {...(isControlledInput
                    ? { value: chatInputValue }
                    : { defaultValue: chatInputRef.current })}
                  onChange={handleComposerInputChange}
                  onPaste={onPaste}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
                  placeholder={composerPlaceholder}
                  rows={1}
                  className="w-full max-h-[180px] lykn-chat-neu-chat-field px-3 py-2 text-xs leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none"
                />
              )}
              {chatBarToolbar}
            </div>
            </div>
          </div>
        </div>
      ) : (
        /* Active conversation: messages scrollable, input pinned to bottom */
        <div
          className="lykn-chat-thread-stage fixed right-0 z-[65] flex flex-col items-center bg-transparent transition-all duration-300"
          style={{
            top: isMobilePhone ? "2.75rem" : "var(--header-height-sm, 4.2rem)",
            bottom: "var(--mobile-tabbar-clear, 0px)",
            right: 0,
            left: isMobilePhone
              ? 0
              : canvasFileBlocks.length > 0 && !isMobileGrid
                ? `calc(220px + var(--sidebar-offset, 0px))`
                : "var(--sidebar-offset, 0px)",
          }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {/* `lykn-chat-ink` — the transcript honors Appearance › AI chat ›
              Text color; the composer and toolbars below stay app-colored. */}
          <div ref={chatScrollRef} className="lykn-chat-ink flex-1 w-full max-w-2xl overflow-y-auto scrollbar-hide px-4 pt-6 pb-4 flex flex-col">
            {chatMessages.length > 0 ? (
              <div className="space-y-4">
                {chatMessages.map((msg, idx) => {
                  // Park the spinner under streamed description text for
                  // the rest of the turn (build: description → "Writing
                  // the code… (12k)" → artifact). The long wait is the
                  // tool's ARGUMENTS streaming — before status is
                  // "running" — so gating on in-flight tools left a
                  // silent gap after "I'll build that out…". Drop it
                  // once loading ends, or in plain chat once the model
                  // has finished talking and no tool/build status is live
                  // (avoids a stale "Responding…" under a completed reply).
                  const isInFlightUserTurn =
                    isChatLoading &&
                    idx === chatMessages.length - 1 &&
                    msg.role === "user" &&
                    msg.kind !== "load-in-greeting" &&
                    Boolean(String(msg.aiResponse || "").trim()) &&
                    (keepThinkingWhileLoading ||
                      messageHasInFlightTools(msg) ||
                      isLiveBuildStatus(thinkingStatus));
                  return (
                  <MessageItem
                    key={msg.id || idx}
                    msg={msg}
                    idx={idx}
                    hideMessageSources={hideMessageSources}
                    isAiExpanded={expandedAiMsgIds.has(msg.id)}
                    isUserPromptExpanded={expandedUserPromptIds.has(msg.id)}
                    reaction={chatReactions[msg.id]}
                    isCopied={copiedMsgId === msg.id}
                    isMobilePhone={isMobilePhone}
                    gridDisabled={gridDisabled}
                    savedMediaUrls={savedMediaUrls}
                    savedYouTubeIds={savedYouTubeIds}
                    selectedChunks={selectedChunks}
                    buildChatMarkdownComponents={buildChatMarkdownComponents}
                    toggleAiExpanded={toggleAiExpanded}
                    toggleUserPromptExpanded={toggleUserPromptExpanded}
                    getCollapsedPreview={getCollapsedPreview}
                    onCopyMessage={onCopyMessage}
                    onReaction={onReaction}
                    onRegenerate={onRegenerate}
                    onEditResend={onEditResend}
                    onRegenerateNonUser={onRegenerateNonUser}
                    onSaveYouTube={onSaveYouTube}
                    onSaveAttachment={onSaveAttachment}
                    onSaveAiImage={onSaveAiImage}
                    onSaveLink={onSaveLink}
                    addChatResponseToGrid={addChatResponseToGrid}
                    handleChunkClick={handleChunkClick}
                    getSelectedText={getSelectedText}
                    registerChunks={registerChunks}
                    onLoadInGreetingRefresh={onLoadInGreetingRefresh}
                    onOpenArtifact={onOpenArtifact}
                    onFactNeuronChange={onFactNeuronChange}
                    inlineThinkingStatus={isInFlightUserTurn ? thinkingStatus : undefined}
                  />
                  );
                })}
                {threadFooter}
              </div>
            ) : null}
            {isChatLoading &&
              !(
                chatMessages.length > 0 &&
                chatMessages[chatMessages.length - 1]?.role === "user" &&
                chatMessages[chatMessages.length - 1]?.kind !== "load-in-greeting" &&
                Boolean(String(chatMessages[chatMessages.length - 1]?.aiResponse || "").trim())
              ) && (
              <div className="flex justify-start">
                <div className="max-w-[80%] py-3 text-sm leading-relaxed text-black/70 dark:text-white/60 flex items-center gap-3">
                  <ThinkingIndicator status={thinkingStatus} />
                </div>
              </div>
            )}
            <LocalToolApprovalCard />
          </div>
          <div className="w-full max-w-2xl px-4 pb-6 pt-2">
            {composerAbove ? <div className="mb-1">{composerAbove}</div> : null}
            <div className="lykn-chat-neu-chat-shell lykn-chat-chat-border-run-once p-2.5 sm:p-3 w-full flex flex-col gap-1.5">
              {focusedChatAttachments.length > 0 && (
                <div className="mb-0 flex flex-wrap gap-2 items-end">
                  {focusedChatAttachments.map((att) => (
                    <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                  ))}
                </div>
              )}
              {isDictating || isTranscribing ? (
                <div className="w-full min-h-[3.25rem] lykn-chat-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
                  {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span></>)}
                </div>
              ) : (
                <textarea
                  ref={chatPanelInputRef}
                  autoFocus={isMobilePhone}
                  data-min-h={String(composerMinH)}
                  style={{ minHeight: composerMinH }}
                  {...(isControlledInput
                    ? { value: chatInputValue }
                    : { defaultValue: chatInputRef.current })}
                  onChange={handleComposerInputChange}
                  onPaste={onPaste}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
                  placeholder={composerPlaceholder}
                  rows={1}
                  className="w-full max-h-[180px] lykn-chat-neu-chat-field px-3 py-2 text-xs leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none"
                />
              )}
              {chatBarToolbar}
            </div>
            {composerBelow}
          </div>
        </div>
      )}
      {researchOpen ? (
        <div
          className="fixed bottom-0 right-0 top-0 z-[66]"
          style={{ width: RESEARCH_SIDEBAR_WIDTH }}
        >
          {researchSidebar}
        </div>
      ) : null}
      {onActiveArtifactChange ? (
        <LyknChatArtifactPanel
          artifact={activeArtifact}
          isUpdating={isChatLoading}
          fullWidth={isMobilePhone}
          onClose={() => {
            dismissedArtifactKeyRef.current = lastSeenArtifactRef.current;
            pendingArtifactOpenRef.current = null;
            onActiveArtifactChange(null);
          }}
          onSaveToVault={onSaveArtifact}
          onArtifactUpdate={onActiveArtifactChange}
        />
      ) : null}
    </>
  );
});

export default LyknChatView;
