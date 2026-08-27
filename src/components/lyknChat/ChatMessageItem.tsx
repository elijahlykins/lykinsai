import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check, ChevronRight, Copy, Download, FileText,
  MoreHorizontal, Pencil, Play, RefreshCw,
  Save, Share2, ThumbsDown, ThumbsUp,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS, normalizeMathDelimiters } from "@/lib/chat/chatMarkdown";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import ChatArtifactCard, { ArtifactBuildingPlaceholder } from "@/components/lyknChat/ChatArtifactCard";
import GeneratedImage from "@/components/lyknChat/GeneratedImage";
import { openFileWindow } from "@/lib/files/fileWindows";
import { isGenericBuildStatus, isLiveBuildStatus } from "@/hooks/useThinkingStatus";
import { extractChatArtifacts, sortArtifactsForDisplay, extractLeakedHtmlDocument, buildLeakedHtmlArtifact, type ChatArtifact } from "@/lib/ai/chatArtifacts";
import ChatNeuronCard from "@/components/lyknChat/ChatNeuronCard";
import SentChatAttachment, { type SentChatAttachmentData } from "@/components/lyknChat/SentChatAttachment";
import { chatAttachmentSaveKeys } from "@/lib/chat/chatAttachmentFile";
import { SiteFavicon } from "@/components/SiteFavicon";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";
import { safeExternalUrl, safeNavHref } from "@/lib/safeExternalUrl";
import { handleLyknBrowserClick } from "@/lib/lyknChat/openInStudioBrowser";
import { copyMarkdownAsRich } from "@/lib/copyRichClipboard";
import BotAvatar from "@/components/bots/BotAvatar";
import { botSeed } from "@/lib/bots/botStore";
import {
  LoadInBubble,
  LoadInUserSectionEditor,
  LoadInUserSectionsComposer,
} from "@/components/lyknChat/LoadInGreetingBlocks";

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

/** Narration that means an artifact is actually being written (vs. a clarifying question). */
function isBuildSlotStatus(status?: string): boolean {
  const t = String(status || "").trim();
  if (!t) return false;
  return isLiveBuildStatus(t) && !isGenericBuildStatus(t);
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
  savedMediaUrls: Set<string>;
  savedYouTubeIds: Set<string>;
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
  onSaveAttachment: (att: SentChatAttachmentData) => void;
  onSaveAiImage: (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => void | Promise<boolean | void>;
  onOpenGeneratedImage?: (img: {
    url: string;
    prompt?: string;
    aspect?: string;
    storagePath?: string;
    batchId?: string;
    index?: number;
  }) => void;
  onRetryImagineSlot?: (batchId: string, slotIndex: number) => void;
  onSaveLink: (link: string) => void;
  /**
   * Forwarded from `LyknChatViewProps`. The inline user-sections
   * composer calls this after any insert / update / delete so the
   * greeting bubble (and dashboard panel) pick up the new state.
   */
  onLoadInGreetingRefresh?: () => void | Promise<void>;
  /** Open an artifact in the floating preview popup. */
  onOpenArtifact?: (art: ChatArtifact) => void;
  /**
   * When set, render the thinking/building spinner under this turn's
   * streamed description — while a tool is in flight OR a build is still
   * streaming its arguments (the long wait before "running").
   */
  inlineThinkingStatus?: string;
  /** Earlier section-level build thoughts for the live spinner. */
  buildThoughtTrail?: string[];
};

const ResponseActionsMenu: React.FC<{
  isCopied: boolean;
  reaction?: "like" | "dislike" | null;
  onShare: () => void;
  onDownload: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onReaction: (reaction: "like" | "dislike") => void;
}> = ({
  isCopied,
  reaction,
  onShare,
  onDownload,
  onCopy,
  onRegenerate,
  onReaction,
}) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    return () => document.removeEventListener("pointerdown", closeIfOutside);
  }, [open]);

  const action = (callback: () => void) => () => {
    callback();
    setOpen(false);
  };
  const itemClass =
    "shrink-0 rounded-md p-1.5 text-black/40 transition-colors hover:bg-black/5 hover:text-black/70 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/70";

  return (
    <div ref={menuRef} className="flex items-center">
      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`rounded-md p-1.5 transition-colors ${
          open
            ? "bg-black/5 text-black/75 dark:bg-white/10 dark:text-white/80"
            : "text-black/40 hover:bg-black/5 hover:text-black/70 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/70"
        }`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <div
        aria-hidden={!open}
        className={`overflow-hidden transition-[max-width,opacity,margin] duration-200 ease-out ${
          open ? "ml-1 max-w-[15rem] opacity-100" : "ml-0 max-w-0 opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-0.5 whitespace-nowrap">
          <button type="button" title="Share" aria-label="Share" tabIndex={open ? 0 : -1} className={itemClass} onClick={action(onShare)}>
            <Share2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" title="Download" aria-label="Download" tabIndex={open ? 0 : -1} className={itemClass} onClick={action(onDownload)}>
            <Download className="h-3.5 w-3.5" />
          </button>
          <button type="button" title={isCopied ? "Copied" : "Copy"} aria-label={isCopied ? "Copied" : "Copy"} tabIndex={open ? 0 : -1} className={itemClass} onClick={action(onCopy)}>
            {isCopied ? <Check className="h-3.5 w-3.5 text-blue-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button type="button" title="Regenerate" aria-label="Regenerate" tabIndex={open ? 0 : -1} className={itemClass} onClick={action(onRegenerate)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-3.5 w-px shrink-0 bg-black/10 dark:bg-white/10" />
          <button type="button" title="Like" aria-label="Like" tabIndex={open ? 0 : -1} className={itemClass} onClick={action(() => onReaction("like"))}>
            <ThumbsUp className={`h-3.5 w-3.5 ${reaction === "like" ? "text-green-600" : ""}`} />
          </button>
          <button type="button" title="Dislike" aria-label="Dislike" tabIndex={open ? 0 : -1} className={itemClass} onClick={action(() => onReaction("dislike"))}>
            <ThumbsDown className={`h-3.5 w-3.5 ${reaction === "dislike" ? "text-red-500" : ""}`} />
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * An Imagine batch inside the transcript. That mode answers a prompt with a
 * set of variations rather than one image, so the turn carries them all and
 * each is saved to the Vault on its own.
 */
function AiImageBatch({
  images,
  aspect,
  prompt,
  batchId,
  savedMediaUrls,
  onSaveAiImage,
  onOpenGeneratedImage,
  onRetrySlot,
}: {
  images: { url: string; storagePath?: string; status?: "loading" | "done" | "error"; error?: string }[];
  aspect?: string;
  prompt: string;
  batchId?: string;
  savedMediaUrls: Set<string>;
  onSaveAiImage: (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => void | Promise<boolean | void>;
  onOpenGeneratedImage?: (img: {
    url: string;
    prompt?: string;
    aspect?: string;
    storagePath?: string;
    batchId?: string;
    index?: number;
  }) => void;
  onRetrySlot?: (index: number) => void;
}) {
  const ratio = /^(\d+):(\d+)$/.exec(String(aspect || ""));
  const cellRatio = { aspectRatio: ratio ? `${ratio[1]} / ${ratio[2]}` : "1 / 1" };
  return (
    <div className="px-4 py-3">
      <div className={`grid gap-2 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {images.map((img, i) => {
          const saved = !!img.url && savedMediaUrls.has(img.url);
          const errored = img.status === "error";
          const loading = !errored && (!img.url || img.status === "loading");
          return (
            <div
              key={img.url || `slot-${i}`}
              className="group/img relative overflow-hidden rounded-xl bg-black/[0.04] dark:bg-white/[0.05]"
              style={cellRatio}
            >
              {errored ? (
                <button
                  type="button"
                  onClick={() => onRetrySlot?.(i)}
                  disabled={!onRetrySlot}
                  className="flex h-full w-full flex-col items-center justify-center gap-2 text-black/45 transition-colors hover:text-black/70 disabled:hover:text-black/45 dark:text-white/45 dark:hover:text-white/75"
                  title={onRetrySlot ? "Retry" : img.error || "Generation failed"}
                >
                  <RefreshCw className="h-4 w-4" />
                  <span className="px-3 text-center text-[11px] leading-snug">
                    {img.error || "Generation failed"}
                  </span>
                </button>
              ) : loading ? (
                <div className="lykn-imagine-shimmer absolute inset-0" />
              ) : (
                <>
                  <button
                    type="button"
                    className="block w-full cursor-zoom-in"
                    onClick={() => {
                      if (onOpenGeneratedImage) {
                        onOpenGeneratedImage({
                          url: img.url,
                          prompt,
                          aspect,
                          storagePath: img.storagePath,
                          batchId,
                          index: i,
                        });
                        return;
                      }
                      openFileWindow({
                        url: img.url,
                        name: `${prompt || "Generated image"}.png`,
                        media: "image",
                        onSaveToVault: saved
                          ? null
                          : async () => {
                              await onSaveAiImage(img.url, prompt, {
                                storagePath: img.storagePath,
                              });
                            },
                      });
                    }}
                    title="Open"
                  >
                    <GeneratedImage
                      src={img.url}
                      alt={`Variation ${i + 1}`}
                      className="w-full object-cover"
                      style={cellRatio}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={saved}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSaveAiImage(img.url, prompt, { storagePath: img.storagePath });
                    }}
                    className={`absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] backdrop-blur-sm transition-all ${
                      saved
                        ? "border-blue-400/40 bg-blue-500/15 text-blue-600"
                        : "border-white/25 bg-black/40 text-white opacity-0 group-hover/img:opacity-100"
                    }`}
                  >
                    {saved ? (
                      <>
                        <Check className="h-3 w-3" /> Saved
                      </>
                    ) : (
                      <>
                        <Save className="h-3 w-3" /> Save
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ChatMessageItem = React.memo(function MessageItem({
  msg, idx,
  hideMessageSources = false,
  isAiExpanded, isUserPromptExpanded,
  reaction, isCopied,
  savedMediaUrls, savedYouTubeIds,
  buildChatMarkdownComponents,
  toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
  onCopyMessage, onReaction, onRegenerate, onEditResend, onRegenerateNonUser,
  onSaveYouTube, onSaveAttachment, onSaveAiImage, onOpenGeneratedImage, onRetryImagineSlot, onSaveLink: _onSaveLink,
  onLoadInGreetingRefresh,
  onOpenArtifact,
  inlineThinkingStatus,
  buildThoughtTrail,
}: MessageItemProps) {
  const aiResponse = msg.aiResponse || "";
  const navigate = useNavigate();
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editDraft, setEditDraft] = useState("");

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
              {msg.attachments.map((att) => (
                <SentChatAttachment
                  key={att.id}
                  att={att}
                  isSaved={
                    att.videoId
                      ? savedYouTubeIds.has(att.videoId)
                      : chatAttachmentSaveKeys(att).some((k) => savedMediaUrls.has(k))
                  }
                  onSaveToVault={onSaveAttachment}
                  onSaveYouTube={onSaveYouTube}
                />
              ))}
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
                  className="lykn-user-prompt-bubble rounded-[15px] rounded-br-[4px] px-3 py-1 text-[14px] leading-[1.25] text-black/90 dark:text-white/90 border border-black/8 dark:border-white/10 bg-background shadow-[0_2px_8px_rgba(0,0,0,0.045)] [&_table]:my-1 [&_td]:px-2 [&_th]:px-2"
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
      {msg.role === "user" && (msg.aiResponse || (msg.bot && msg.botWorking)) && (
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
                    {(msg as any).aiImageUrl
                      ? "Generated image"
                      : getCollapsedPreview(msg.aiResponse || "") ||
                        (msg.botWorking ? msg.botStatus || "Working…" : "")}
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
                {msg.bot ? (
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <BotAvatar
                      face={msg.bot.face}
                      eyes={msg.bot.eyes}
                      color={msg.bot.color}
                      size={18}
                      seed={botSeed(msg.bot.id)}
                    />
                    <span className="text-[11px] font-semibold text-black/50 dark:text-white/55">
                      {msg.bot.name}
                    </span>
                  </div>
                ) : null}
                {(msg as any).aiImages?.length ? (
                  <AiImageBatch
                    images={(msg as any).aiImages}
                    aspect={(msg as any).imagine?.aspect}
                    prompt={msg.content}
                    batchId={(msg as any).imagine?.batchId}
                    savedMediaUrls={savedMediaUrls}
                    onSaveAiImage={onSaveAiImage}
                    onOpenGeneratedImage={onOpenGeneratedImage}
                    onRetrySlot={
                      (msg as any).imagine?.batchId && onRetryImagineSlot
                        ? (index) => onRetryImagineSlot(String((msg as any).imagine.batchId), index)
                        : undefined
                    }
                  />
                ) : (msg as any).aiImageUrl ? (
                  <AiImageBatch
                    images={[{ url: (msg as any).aiImageUrl, storagePath: (msg as any).aiImageStoragePath }]}
                    prompt={msg.content}
                    savedMediaUrls={savedMediaUrls}
                    onSaveAiImage={onSaveAiImage}
                    onOpenGeneratedImage={onOpenGeneratedImage}
                  />
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
                        <div className="lykn-chat-ai-text text-[14px] leading-[1.25] break-words text-black/85 dark:text-white/85">
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
                          <ArtifactBuildingPlaceholder status={inlineThinkingStatus} trail={buildThoughtTrail} />
                        </div>
                      ) : inlineThinkingStatus && !isBuildSlotStatus(inlineThinkingStatus) ? (
                        <div className="mt-3">
                          <ThinkingIndicator status={inlineThinkingStatus} trail={buildThoughtTrail} />
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                {msg.bot && msg.botWorking ? (
                  // The Bot is still working this turn: a live animated status
                  // line (with the trail of what it just did) under whatever
                  // has streamed, instead of a static "Thinking…" string.
                  <div className={`px-4 pb-3 ${String(aiResponse || "").trim() ? "" : "-mt-1"}`}>
                    <ThinkingIndicator
                      status={msg.botStatus || "Thinking…"}
                      trail={msg.botTrail}
                    />
                  </div>
                ) : null}
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
                          // for retained LYKN product items).
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
                  <div className="px-3 pb-2 pt-0.5">
                    <ResponseActionsMenu
                      isCopied={isCopied}
                      reaction={reaction}
                      onShare={() => {
                        const text = msg.aiResponse || "";
                        if (navigator.share) navigator.share({ text }).catch(() => {});
                        else void copyMarkdownAsRich(text);
                      }}
                      onDownload={() => {
                        const text = msg.aiResponse || "";
                        const blob = new Blob([text], { type: "text/plain" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "response.txt";
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      onCopy={() => onCopyMessage(msg.id, msg.aiResponse || "")}
                      onRegenerate={() => onRegenerate(msg.id, msg.content)}
                      onReaction={(nextReaction) => onReaction(msg.id, nextReaction)}
                    />
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
                      <ArtifactBuildingPlaceholder status={inlineThinkingStatus} trail={buildThoughtTrail} />
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
                        <div className="lykn-chat-ai-text px-4 py-3 text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
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
                <div className="px-3 pb-2 pt-0.5">
                  <ResponseActionsMenu
                    isCopied={isCopied}
                    reaction={reaction}
                    onShare={() => {
                      const text = (msg as any).content || "";
                      if (navigator.share) navigator.share({ text }).catch(() => {});
                      else void copyMarkdownAsRich(text);
                    }}
                    onDownload={() => {
                      const text = (msg as any).content || "";
                      const blob = new Blob([text], { type: "text/plain" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "response.txt";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    onCopy={() => onCopyMessage(msg.id, (msg as any).content || "")}
                    onRegenerate={() => onRegenerateNonUser(msg.id, idx)}
                    onReaction={(nextReaction) => onReaction(msg.id, nextReaction)}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </React.Fragment>
  );
});

export default ChatMessageItem;
