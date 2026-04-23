import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  Check, ChevronRight, Copy, Download, FileText, Globe,
  GripVertical, Link2, Music, Play, RefreshCw,
  Save, Share2, StickyNote, ThumbsDown, ThumbsUp,
} from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  kind?: "prompt";
  attachments?: FocusedChatAttachment[];
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
  getCollapsedPreview: (text: string) => string;

  copiedMsgId: string | null;
  onCopyMessage: (msgId: string, text: string) => void;

  addChatResponseToGrid: (text: string) => void;

  renderFocusedAttachmentPreview: (att: FocusedChatAttachment) => React.ReactNode;

  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;

  chatBarToolbar: React.ReactNode;

  chatReactions: Record<string, "like" | "dislike" | null>;
  onReaction: (msgId: string, kind: "like" | "dislike") => void;

  onRegenerate: (msgId: string, content: string) => void;
  onRegenerateNonUser: (msgId: string, idx: number) => void;
}

const OmniaFocusedChat: React.FC<OmniaFocusedChatProps> = React.memo(function OmniaFocusedChat({
  chatMessages,
  isChatLoading,
  thinkingStatus,
  chatInputRef,
  onChatInputChange,
  onSend,
  typedWelcome,
  isMobileGrid,
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
  getCollapsedPreview,
  copiedMsgId,
  onCopyMessage,
  addChatResponseToGrid,
  renderFocusedAttachmentPreview,
  onDragOver,
  onDrop,
  chatBarToolbar,
  chatReactions,
  onReaction,
  onRegenerate,
  onRegenerateNonUser,
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

  return (
    <>
      {/* Left collage panel — grid files */}
      {canvasFileBlocks.length > 0 && !isMobileGrid && (
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
          className={`fixed top-0 bottom-0 right-0 z-[65] flex items-center justify-center px-4 transition-all duration-300 ${canvasFileBlocks.length > 0 && !isMobileGrid ? "pl-[232px]" : ""}`}
          style={{ left: "var(--sidebar-offset, 0px)" }}
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
          className="fixed bottom-0 right-0 z-[65] flex flex-col items-center bg-transparent transition-all duration-300"
          style={{ top: "var(--header-height-sm, 4.2rem)", left: canvasFileBlocks.length > 0 && !isMobileGrid ? `calc(220px + var(--sidebar-offset, 0px))` : "var(--sidebar-offset, 0px)" }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div ref={chatScrollRef} className="flex-1 w-full max-w-2xl overflow-y-auto scrollbar-hide px-4 pt-6 pb-4 space-y-4">
            {chatMessages.map((msg, idx) => (
              <React.Fragment key={msg.id || idx}>
                {msg.role === "user" && (
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
                    <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed text-black/90 dark:text-white/90 border border-black/8 dark:border-white/10 bg-background shadow-[0_4px_14px_rgba(0,0,0,0.06)] [&_table]:my-2 [&_td]:px-2 [&_th]:px-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>{normalizeChecklistSyntax(msg.content || "")}</ReactMarkdown>
                    </div>
                  </div>
                )}
                {msg.role === "user" && msg.aiResponse && (() => {
                  const isFocusedExpanded = expandedAiMsgIds.has(msg.id);
                  return (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] w-full">
                      <button
                        type="button"
                        className={`w-full flex items-center gap-2 transition-all text-left ${
                          isFocusedExpanded
                            ? "px-4 py-2.5 rounded-2xl border border-white/50 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-sm hover:bg-white/50 dark:hover:bg-white/10"
                            : "px-0 py-0.5 rounded-none border border-transparent bg-transparent backdrop-blur-none hover:bg-transparent"
                        }`}
                        onClick={() => toggleAiExpanded(msg.id)}
                      >
                        <ChevronRight className={`w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${isFocusedExpanded ? "rotate-90" : ""}`} />
                        {!isFocusedExpanded && (
                          <span className="text-sm text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                            {(msg as any).aiImageUrl ? "Generated image" : getCollapsedPreview(msg.aiResponse || "")}
                          </span>
                        )}
                        {isFocusedExpanded && (
                          <span className="text-sm text-black/40 dark:text-white/40 font-medium flex-1">AI Response</span>
                        )}
                      </button>
                      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${isFocusedExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0"}`}>
                        <div className="overflow-hidden min-h-0 group/aifocused">
                      {(msg as any).aiImageUrl ? (
                        <div className="px-4 py-3">
                          <img src={(msg as any).aiImageUrl} alt="Generated image" className="max-w-full rounded-xl shadow-lg" style={{ maxHeight: "320px" }} />
                          <button type="button" className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${savedMediaUrls.has((msg as any).aiImageUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/25 bg-white/35 backdrop-blur-sm text-black/60 hover:text-black/80 hover:border-black/30 hover:shadow-sm"}`} disabled={savedMediaUrls.has((msg as any).aiImageUrl)} onClick={() => { onSaveAiImage((msg as any).aiImageUrl, msg.content); }}>
                            {savedMediaUrls.has((msg as any).aiImageUrl) ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save to Vault</>}
                          </button>
                        </div>
                      ) : (() => {
                        const chunks = splitResponseIntoChunks(msg.aiResponse || "");
                        const isSingle = chunks.length <= 1;
                        return (
                          <div className="px-4 py-3 space-y-2">
                            {chunks.map((chunk, ci) => {
                              const chunkKey = `${msg.id}-fchunk-${ci}`;
                              const isSelected = selectedChunks.has(chunkKey);
                              chunkMapRef.current.set(chunkKey, chunk);
                              return (
                              <div key={chunkKey} className="group/fchunk relative">
                                <div
                                  draggable
                                  onClick={(e) => { if (!isSingle) handleChunkClick(e, chunkKey, chunk); }}
                                  onDragStart={(e) => {
                                    const sel = window.getSelection()?.toString()?.trim();
                                    const text = sel || getSelectedText(chunkKey, chunk);
                                    e.dataTransfer.effectAllowed = "copy";
                                    e.dataTransfer.setData("application/x-omnia-chat-response", text);
                                    e.dataTransfer.setData("text/plain", text);
                                    try {
                                      const count = selectedChunks.has(chunkKey) ? selectedChunks.size : (selectedChunks.size > 0 ? selectedChunks.size + 1 : 1);
                                      const label = count > 1 ? `${count} sections` : (text.length > 80 ? text.slice(0, 77) + "…" : text);
                                      const ghost = document.createElement("div");
                                      ghost.textContent = label;
                                      ghost.style.cssText = "position:fixed;top:-9999px;padding:8px 12px;border-radius:10px;background:rgba(59,130,246,0.15);font-size:12px;max-width:260px;overflow:hidden;white-space:nowrap";
                                      document.body.appendChild(ghost);
                                      e.dataTransfer.setDragImage(ghost, 0, 0);
                                      requestAnimationFrame(() => ghost.remove());
                                    } catch {}
                                  }}
                                  className={`text-sm leading-relaxed break-words text-black/85 dark:text-white/85 cursor-grab active:cursor-grabbing transition-all rounded-xl ${isSelected ? "px-3 py-2 border border-blue-400/50 bg-blue-50/60 dark:bg-blue-500/[0.06] dark:border-blue-400/25 shadow-sm" : isSingle ? "" : "px-3 py-2 hover:bg-white/40 dark:hover:bg-white/10 hover:ring-1 hover:ring-blue-400/20"}`}
                                >
                                  <div className={`absolute -left-3 top-1/2 -translate-y-1/2 opacity-0 group-hover/fchunk:opacity-100 transition-opacity ${isSingle ? "hidden" : ""}`}>
                                    <GripVertical className="w-3.5 h-3.5 text-blue-400/60" />
                                  </div>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                                    {normalizeChecklistSyntax(chunk)}
                                  </ReactMarkdown>
                                </div>
                                {!isSingle && (
                                  <button
                                    type="button"
                                    title={selectedChunks.size > 1 ? "Add selected sections to grid" : "Add this section to grid"}
                                    className="absolute right-1.5 top-1.5 opacity-0 group-hover/fchunk:opacity-100 transition-opacity p-1 rounded-md text-blue-400/70 hover:text-blue-500 hover:bg-blue-500/10"
                                    onClick={() => addChatResponseToGrid(selectedChunks.size > 0 ? getSelectedText(chunkKey, chunk) : chunk)}
                                  >
                                    <GridIcon className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                              );
                            })}
                          </div>
                        );
                      })()}
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
                        <button type="button" title="Add to grid" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors" onClick={() => addChatResponseToGrid(msg.aiResponse || "")}>
                          <GridIcon className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" title="Share" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = msg.aiResponse || ""; if (navigator.share) { navigator.share({ text }).catch(() => {}); } else { void navigator.clipboard.writeText(text); } }}>
                          <Share2 className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" title="Download" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { const text = msg.aiResponse || ""; const blob = new Blob([text], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "response.txt"; a.click(); URL.revokeObjectURL(url); }}>
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" title="Copy" className={`p-1.5 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => { onCopyMessage(msg.id, msg.aiResponse || ""); }}>
                          {copiedMsgId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <button type="button" title="Regenerate" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { onRegenerate(msg.id, msg.content); }}>
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <div className="w-px h-3.5 bg-black/10 dark:bg-white/10 mx-1" />
                        <button type="button" title="Like" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "like" ? "text-green-600 bg-green-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "like")}>
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" title="Dislike" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "dislike" ? "text-red-500 bg-red-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "dislike")}>
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })()}
                {msg.role !== "user" && (() => {
                  const isNonUserExpanded = expandedAiMsgIds.has(msg.id);
                  return (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] w-full">
                      <button
                        type="button"
                        className="w-full flex items-center gap-2 px-4 py-2.5 rounded-2xl border border-white/50 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-sm hover:bg-white/50 dark:hover:bg-white/10 transition-all text-left"
                        onClick={() => toggleAiExpanded(msg.id)}
                      >
                        <ChevronRight className={`w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${isNonUserExpanded ? "rotate-90" : ""}`} />
                        {!isNonUserExpanded && (
                          <span className="text-sm text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                            {getCollapsedPreview(msg.content || "")}
                          </span>
                        )}
                        {isNonUserExpanded && (
                          <span className="text-sm text-black/40 dark:text-white/40 font-medium flex-1">AI Response</span>
                        )}
                      </button>
                      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${isNonUserExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0"}`}>
                      <div className="overflow-hidden min-h-0">
                      <div className="px-4 py-3 text-sm leading-relaxed break-words text-black/85 dark:text-white/85">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
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
                        <button type="button" title="Copy" className={`p-1.5 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => { onCopyMessage(msg.id, (msg as any).content || ""); }}>
                          {copiedMsgId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <button type="button" title="Regenerate" className="p-1.5 rounded-md text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors" onClick={() => { onRegenerateNonUser(msg.id, idx); }}>
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <div className="w-px h-3.5 bg-black/10 dark:bg-white/10 mx-1" />
                        <button type="button" title="Like" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "like" ? "text-green-600 bg-green-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "like")}>
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" title="Dislike" className={`p-1.5 rounded-md transition-colors ${chatReactions[msg.id] === "dislike" ? "text-red-500 bg-red-500/10" : "text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => onReaction(msg.id, "dislike")}>
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      </div>
                      </div>
                    </div>
                  </div>
                  );
                })()}
              </React.Fragment>
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
