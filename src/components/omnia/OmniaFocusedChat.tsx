import React, { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check, ChevronRight, Copy, Download, FileText, Globe,
  GripVertical, Link2, MoreHorizontal, Music, Pencil, Play, Plus, RefreshCw,
  Save, Share2, StickyNote, ThumbsDown, ThumbsUp, Trash2, X as XIcon,
} from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import NeuronPill from "@/components/synthesis/NeuronPill";
import AppliedRulePill from "@/components/synthesis/AppliedRulePill";
import type { FactNeuron } from "@/lib/ai/learnedTag";
import { supabase } from "@/lib/supabase";

const TASK_LINE_RE = /^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/;

const normalizeChecklistSyntax = (value: string) =>
  String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) return line;
      const marker = String(match[1] || "").toLowerCase() === "x" ? "x" : " ";
      return `- [${marker}] ${String(match[2] || "").trim()}`;
    })
    .join("\n");

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
   * Set when the AI's reply ended with a hidden <learned>/<reason> or
   * <updated old="..."> tag pair — meaning a neuron was either minted OR
   * refined in the synthesis layer during this exact turn. Also set when
   * the model forgot to tag but the server-side /api/learned/auto
   * classifier detected a personal disclosure as a fallback. Renders the
   * glowing "Neuron created" / "Neuron updated" pill underneath the AI
   * response so the user sees LYKN learning about them in real time.
   */
  factNeuron?: FactNeuron;
  /**
   * Action buttons rendered below the AI response bubble. Currently
   * used by the load-in greeting seeded by OmniaGrid — each action is
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

export interface OmniaFocusedChatProps {
  chatMessages: PromptMessage[];
  isChatLoading: boolean;
  thinkingStatus: string;

  chatInputRef: React.MutableRefObject<string>;
  onChatInputChange: (value: string) => void;
  onSend: () => void | Promise<void>;

  typedWelcome: string;
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
  onSaveAiImage: (imageUrl: string, promptText?: string) => void;
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
   * user can't see. Passed through from `OmniaGrid`'s `GRID_DISABLED`
   * feature flag.
   */
  gridDisabled?: boolean;

  renderFocusedAttachmentPreview: (att: FocusedChatAttachment) => React.ReactNode;

  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;

  chatBarToolbar: React.ReactNode;

  chatReactions: Record<string, "like" | "dislike" | null>;
  onReaction: (msgId: string, kind: "like" | "dislike") => void;

  onRegenerate: (msgId: string, content: string) => void;
  onRegenerateNonUser: (msgId: string, idx: number) => void;

  /**
   * Refetches the load-in greeting payload and overlays it onto the
   * currently-rendered greeting message in place. Invoked by the
   * inline user-sections composer after every CRUD so the bubble (and
   * the right-side dashboard panel) reflect the new state without a
   * full page reload. Optional — non-greeting surfaces leave it unset.
   */
  onLoadInGreetingRefresh?: () => void | Promise<void>;
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
  onRegenerateNonUser: (id: string, idx: number) => void;
  onSaveYouTube: (videoId: string, url: string) => void;
  onSaveAttachment: (url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => void;
  onSaveAiImage: (imageUrl: string, promptText?: string) => void;
  onSaveLink: (link: string) => void;
  addChatResponseToGrid: (text: string) => void;
  handleChunkClick: (e: React.MouseEvent, chunkKey: string, chunkText: string) => void;
  getSelectedText: (fallbackKey: string, fallbackText: string) => string;
  registerChunks: (msgId: string, entries: Array<{ key: string; text: string }>) => void;
  /**
   * Forwarded from `OmniaFocusedChatProps`. The inline user-sections
   * composer calls this after any insert / update / delete so the
   * greeting bubble (and dashboard panel) pick up the new state.
   */
  onLoadInGreetingRefresh?: () => void | Promise<void>;
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
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/50 dark:bg-white/[0.04] backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.06)] overflow-hidden">
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
              const hasHref = typeof it.href === "string" && it.href.length > 0;
              const isInternal = hasHref && it.href!.startsWith("/");
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
                  </div>
                  {hasHref ? (
                    <ArrowRight className="w-3.5 h-3.5 opacity-40 mt-1 flex-shrink-0" />
                  ) : null}
                </div>
              );
              if (!hasHref) {
                return <div key={`${msgId}-${group.id}-${it.id}`}>{inner}</div>;
              }
              // Internal hrefs route via react-router so we don't
              // hard-reload the app and lose chat state; external
              // hrefs (Gmail / Notion / Slack URLs etc.) open in a
              // new tab.
              const onClick = (e: React.MouseEvent) => {
                if (!isInternal) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1) return;
                e.preventDefault();
                navigate(it.href!);
              };
              return (
                <a
                  key={`${msgId}-${group.id}-${it.id}`}
                  href={it.href}
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
      setError("Heading is too long — keep it under 120 characters.");
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
        setError(insertErr.message || "Couldn't save — try again?");
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
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.06)] overflow-hidden">
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
          placeholder="Add notes, links, bullets — markdown works."
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
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.06)] overflow-hidden">
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
  isAiExpanded, isUserPromptExpanded,
  reaction, isCopied,
  isMobilePhone, gridDisabled,
  savedMediaUrls, savedYouTubeIds, selectedChunks,
  buildChatMarkdownComponents,
  toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
  onCopyMessage, onReaction, onRegenerate, onRegenerateNonUser,
  onSaveYouTube, onSaveAttachment, onSaveAiImage, onSaveLink,
  addChatResponseToGrid,
  handleChunkClick, getSelectedText, registerChunks,
  onLoadInGreetingRefresh,
}: MessageItemProps) {
  const aiResponse = msg.aiResponse || "";
  const navigate = useNavigate();

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
                      <div className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-sm">
                        <iframe src={`https://www.youtube.com/embed/${att.videoId}`} className="w-full aspect-video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={att.name || "YouTube"} />
                      </div>
                      {saveBtn}
                    </div>
                  );
                }
                if (at === "image" && att.url) {
                  return <div key={att.id}><img src={att.url} alt={att.name || "Image"} className="max-w-[16.25rem] max-h-[200px] rounded-xl border border-white/30 object-cover shadow-sm" />{saveBtn}</div>;
                }
                if (at === "video" && att.url) {
                  return (
                    <div key={att.id}>
                      <div className="w-full max-w-[20rem] rounded-xl overflow-hidden border border-white/30 shadow-sm"><video src={att.url} controls className="w-full" preload="metadata" /></div>
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
            return (
              <div className="max-w-[80%] flex flex-col items-end">
                <div
                  className="rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed text-black/90 dark:text-white/90 border border-black/8 dark:border-white/10 bg-background shadow-[0_4px_14px_rgba(0,0,0,0.06)] [&_table]:my-2 [&_td]:px-2 [&_th]:px-2"
                  style={collapsedClampStyle}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{normalizeChecklistSyntax(promptText)}</ReactMarkdown>
                </div>
                {isLongPrompt && msg.id && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleUserPromptExpanded(msg.id); }}
                    title={isPromptExpanded ? "Show less" : "Show full prompt"}
                    aria-label={isPromptExpanded ? "Show less" : "Show full prompt"}
                    className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  >
                    {isPromptExpanded
                      ? <span className="leading-none">Show less</span>
                      : <><MoreHorizontal className="w-3.5 h-3.5" /><span className="leading-none">Show more</span></>}
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      )}
      {msg.role === "user" && msg.aiResponse && (
        <div className="flex justify-start">
          <div className="max-w-[80%] w-full">
            {!isLoadInGreeting && (
              <button
                type="button"
                className={`w-full flex items-center gap-2 transition-all text-left ${
                  isAiExpanded
                    ? "px-4 py-2.5 rounded-2xl border border-white/50 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-sm hover:bg-white/50 dark:hover:bg-white/10"
                    : "px-0 py-0.5 rounded-none border border-transparent bg-transparent backdrop-blur-none hover:bg-transparent"
                }`}
                onClick={() => toggleAiExpanded(msg.id)}
              >
                <ChevronRight className={`w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${isAiExpanded ? "rotate-90" : ""}`} />
                {!isAiExpanded && (
                  <span className="text-sm text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                    {(msg as any).aiImageUrl ? "Generated image" : getCollapsedPreview(msg.aiResponse || "")}
                  </span>
                )}
                {isAiExpanded && (
                  <span className="text-sm text-black/40 dark:text-white/40 font-medium flex-1">AI Response</span>
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
                    <img src={(msg as any).aiImageUrl} alt="Generated image" className="max-w-full rounded-xl shadow-lg" style={{ maxHeight: "320px" }} />
                    <button type="button" className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedMediaUrls.has((msg as any).aiImageUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/25 bg-white/35 backdrop-blur-sm text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={savedMediaUrls.has((msg as any).aiImageUrl)} onClick={() => { onSaveAiImage((msg as any).aiImageUrl, msg.content); }}>
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
                  return (
                    <div className="px-4 py-3">
                      {heading ? (
                        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight text-black/90 dark:text-white/90 mb-3">
                          {heading}
                        </h1>
                      ) : null}
                      {body ? (
                        <div className="text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                            {normalizeChecklistSyntax(body)}
                          </ReactMarkdown>
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
                          <div className="text-[13px] opacity-70 -mt-1">
                            {sec.intro}
                          </div>
                        ) : null}
                        {sec.summary ? (
                          // Prose-summary text. Renders as a paragraph
                          // before any bubble stack so the user gets
                          // the recap, then can drill into specifics.
                          <div className="text-sm leading-relaxed text-black/85 dark:text-white/85">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
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
                              const isInternal = chip.href.startsWith("/");
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
                                navigate(chip.href);
                              };
                              return (
                                <a
                                  key={`${msg.id}-${sec.id}-chip-${chip.id}`}
                                  href={chip.href}
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
                                ? "border-blue-400/40 bg-blue-500/10 hover:bg-blue-500/15 text-blue-700 dark:text-blue-200"
                                : tone === "amber"
                                  ? "border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/15 text-amber-700 dark:text-amber-200"
                                  : tone === "emerald"
                                    ? "border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                                    : tone === "fuchsia"
                                      ? "border-fuchsia-400/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-200"
                                      : "border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/5 hover:bg-white/55 dark:hover:bg-white/10 text-black/75 dark:text-white/80";
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
                            return (
                              <div
                                key={`${msg.id}-sec-${sec.id}-row-${ii}`}
                                className="flex items-start gap-3 rounded-lg border border-white/10 dark:border-white/5 bg-white/30 dark:bg-white/[0.03] px-3 py-2"
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
                                  <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">
                                    {item.title}
                                  </div>
                                  {item.subtitle ? (
                                    <div className="text-[11px] opacity-70 mt-0.5 truncate">
                                      {item.subtitle}
                                    </div>
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
                          ? "border-blue-400/40 bg-blue-500/10 hover:bg-blue-500/15 text-blue-700 dark:text-blue-200"
                          : tone === "amber"
                            ? "border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/15 text-amber-700 dark:text-amber-200"
                            : tone === "emerald"
                              ? "border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                              : tone === "fuchsia"
                                ? "border-fuchsia-400/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-200"
                                : "border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/5 hover:bg-white/55 dark:hover:bg-white/10 text-black/75 dark:text-white/80";
                      const isInternal = act.href.startsWith("/");
                      const onClick = (e: React.MouseEvent) => {
                        if (!isInternal) return; // let the anchor handle external nav
                        // Allow modifier-clicks (cmd/ctrl/middle) to keep
                        // their browser-native "open in new tab" behavior.
                        if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1) return;
                        e.preventDefault();
                        navigate(act.href);
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
                          href={act.href}
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
                        <div className="rounded-xl overflow-hidden border border-white/30 shadow-lg">
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
                          <a href={yt.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-white/25 bg-white/35 backdrop-blur-sm text-black/70 hover:border-black/30 hover:shadow-sm transition-all">
                            <Play className="w-3 h-3" /> Open on YouTube
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {Array.isArray((msg as any).sources) && (msg as any).sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).sources.map((src: { title: string; url: string }, i: number) => (
                      <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/25 dark:border-white/8 bg-white/35 dark:bg-white/4 backdrop-blur-sm text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all">
                        <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6h6m0 0v6m0-6L9.75 14.25" /></svg>
                        <span className="truncate max-w-[10rem]">{src.title}</span>
                      </a>
                    ))}
                  </div>
                )}
                {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).aiWebLinks.map((link: string) => {
                      const isSaved = savedMediaUrls.has(link);
                      let domain = "";
                      try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                      return (
                        <div key={link} className="inline-flex items-center gap-1 rounded-lg border border-white/25 bg-white/30 backdrop-blur-sm px-2 py-1">
                          <Globe className="w-3 h-3 text-black/40 flex-shrink-0" />
                          <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs text-black/70 hover:text-black truncate max-w-[8rem]">{domain}</a>
                          <button
                            type="button"
                            disabled={isSaved}
                            className={`ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.5625rem] rounded-md border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`}
                            onClick={() => { onSaveLink(link); }}
                          >
                            {isSaved ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save</>}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-0.5 px-3 pb-2 pt-0.5">
                  {!isMobilePhone && !gridDisabled && (
                    <button type="button" title="Add to grid" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors" onClick={() => addChatResponseToGrid(msg.aiResponse || "")}>
                      <GridIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = msg.aiResponse || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void navigator.clipboard.writeText(text); } }}>
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
              </div>
            </div>
            {msg.factNeuron && <NeuronPill fact={msg.factNeuron} className="px-1" />}
            {(msg as any).appliedAttribution && <AppliedRulePill attribution={(msg as any).appliedAttribution} className="px-1" />}
          </div>
        </div>
      )}
      {msg.role !== "user" && (
        <div className="flex justify-start">
          <div className="max-w-[80%] w-full">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-2xl border border-white/50 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-sm hover:bg-white/50 dark:hover:bg-white/10 transition-all text-left"
              onClick={() => toggleAiExpanded(msg.id)}
            >
              <ChevronRight className={`w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${isAiExpanded ? "rotate-90" : ""}`} />
              {!isAiExpanded && (
                <span className="text-sm text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                  {getCollapsedPreview(msg.content || "")}
                </span>
              )}
              {isAiExpanded && (
                <span className="text-sm text-black/40 dark:text-white/40 font-medium flex-1">AI Response</span>
              )}
            </button>
            <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${isAiExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0"}`}>
              <div className="overflow-hidden min-h-0">
                <div className="px-4 py-3 text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {normalizeChecklistSyntax(msg.content || "")}
                  </ReactMarkdown>
                </div>
                {Array.isArray((msg as any).sources) && (msg as any).sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).sources.map((src: { title: string; url: string }, i: number) => (
                      <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-white/25 dark:border-white/8 bg-white/35 dark:bg-white/4 backdrop-blur-sm text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30 hover:shadow-sm transition-all">
                        <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6h6m0 0v6m0-6L9.75 14.25" /></svg>
                        <span className="truncate max-w-[10rem]">{src.title}</span>
                      </a>
                    ))}
                  </div>
                )}
                {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {(msg as any).aiWebLinks.map((link: string) => {
                      const isSaved = savedMediaUrls.has(link);
                      let domain = "";
                      try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                      return (
                        <div key={link} className="inline-flex items-center gap-1 rounded-lg border border-white/25 bg-white/30 backdrop-blur-sm px-2 py-1">
                          <Globe className="w-3 h-3 text-black/40 flex-shrink-0" />
                          <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs text-black/70 hover:text-black truncate max-w-[8rem]">{domain}</a>
                          <button
                            type="button"
                            disabled={isSaved}
                            className={`ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.5625rem] rounded-md border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`}
                            onClick={() => { onSaveLink(link); }}
                          >
                            {isSaved ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save</>}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-0.5 px-3 pb-2 pt-0.5">
                  <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = (msg as any).content || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void navigator.clipboard.writeText(text); } }}>
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

const OmniaFocusedChat: React.FC<OmniaFocusedChatProps> = React.memo(function OmniaFocusedChat({
  chatMessages,
  isChatLoading,
  thinkingStatus,
  chatInputRef,
  onChatInputChange,
  onSend,
  typedWelcome,
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
  chatReactions,
  onReaction,
  onRegenerate,
  onRegenerateNonUser,
  onLoadInGreetingRefresh,
}) {
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set());
  const chunkMapRef = useRef<Map<string, string>>(new Map());

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

      {chatMessages.length === 0 ? (
        /* Empty state: identical to the canvas first-render welcome */
        <div
          className={`fixed top-0 right-0 z-[65] flex items-center justify-center px-4 transition-all duration-300 ${canvasFileBlocks.length > 0 && !isMobileGrid ? "pl-[232px]" : ""}`}
          style={{
            left: isMobilePhone ? 0 : "var(--sidebar-offset, 0px)",
            bottom: "var(--mobile-tabbar-clear, 0px)",
          }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div className="w-full max-w-2xl space-y-10 sm:space-y-12">
            <p className="text-center text-xl sm:text-3xl font-semibold tracking-tight min-h-[44px] text-black dark:text-white pointer-events-none">
              {typedWelcome}
            </p>
            <div className="omnia-neu-chat-shell omnia-chat-border-run-once p-2.5 sm:p-3 w-full transition-all duration-300 flex flex-col gap-1.5">
              {focusedChatAttachments.length > 0 && (
                <div className="mb-0 flex flex-wrap gap-2 items-end">
                  {focusedChatAttachments.map((att) => (
                    <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                  ))}
                </div>
              )}
              {isDictating || isTranscribing ? (
                <div className="w-full min-h-[3.25rem] omnia-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
                  {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span></>)}
                </div>
              ) : (
                <textarea
                  ref={chatPanelInputRef}
                  data-min-h="52"
                  defaultValue={chatInputRef.current}
                  onChange={(e) => { onChatInputChange(e.target.value); onResizeInput(e.currentTarget); }}
                  onPaste={onPaste}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
                  placeholder="Ask me anything..."
                  rows={1}
                  className="w-full min-h-[3.25rem] max-h-[180px] omnia-neu-chat-field px-3 py-2 text-xs leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none scrollbar-hide"
                />
              )}
              {chatBarToolbar}
            </div>
          </div>
        </div>
      ) : (
        /* Active conversation: messages scrollable, input pinned to bottom */
        <div
          className="fixed right-0 z-[65] flex flex-col items-center bg-transparent transition-all duration-300"
          style={{
            top: isMobilePhone ? "2.75rem" : "var(--header-height-sm, 4.2rem)",
            bottom: "var(--mobile-tabbar-clear, 0px)",
            left: isMobilePhone
              ? 0
              : canvasFileBlocks.length > 0 && !isMobileGrid
                ? `calc(220px + var(--sidebar-offset, 0px))`
                : "var(--sidebar-offset, 0px)",
          }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div ref={chatScrollRef} className="flex-1 w-full max-w-2xl overflow-y-auto scrollbar-hide px-4 pt-6 pb-4 space-y-4">
            {chatMessages.map((msg, idx) => (
              <MessageItem
                key={msg.id || idx}
                msg={msg}
                idx={idx}
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
              />
            ))}
            {isChatLoading && (
              <div className="flex justify-start">
                <div className="omnia-ai-thinking-glow rounded-2xl rounded-bl-md max-w-[80%] px-4 py-3 text-sm leading-relaxed border bg-black/5 dark:bg-white/8 border-black/10 dark:border-white/10 text-black/70 dark:text-white/60 backdrop-blur-sm flex items-center gap-3">
                  <div className="brick-spinner" />
                  {thinkingStatus}
                </div>
              </div>
            )}
          </div>
          <div className="w-full max-w-2xl px-4 pb-6 pt-2">
            <div className="omnia-neu-chat-shell omnia-chat-border-run-once p-2.5 sm:p-3 w-full flex flex-col gap-1.5">
              {focusedChatAttachments.length > 0 && (
                <div className="mb-0 flex flex-wrap gap-2 items-end">
                  {focusedChatAttachments.map((att) => (
                    <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                  ))}
                </div>
              )}
              {isDictating || isTranscribing ? (
                <div className="w-full min-h-[3.25rem] omnia-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
                  {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span></>)}
                </div>
              ) : (
                <textarea
                  ref={chatPanelInputRef}
                  data-min-h="52"
                  defaultValue={chatInputRef.current}
                  onChange={(e) => { onChatInputChange(e.target.value); onResizeInput(e.currentTarget); }}
                  onPaste={onPaste}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
                  placeholder="Ask me anything..."
                  rows={1}
                  className="w-full min-h-[3.25rem] max-h-[180px] omnia-neu-chat-field px-3 py-2 text-xs leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none scrollbar-hide"
                />
              )}
              {chatBarToolbar}
            </div>
          </div>
        </div>
      )}
    </>
  );
});

export default OmniaFocusedChat;
