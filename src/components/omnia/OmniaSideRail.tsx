import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  MessageSquare, X, Check, Save, FileText, Globe, Copy,
  ChevronRight, GripVertical, MoreHorizontal,
} from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import NeuronPill from "@/components/synthesis/NeuronPill";
import AppliedRulePill from "@/components/synthesis/AppliedRulePill";
import type { AppliedAttribution } from "@/lib/ai/appliedTag";
import type { FactNeuron } from "@/lib/ai/learnedTag";

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
  /**
   * Set when the AI's reply ended with a hidden <learned>/<reason> or
   * <updated old="..."> tag pair, OR when the server-side
   * /api/learned/auto fallback classifier detected a personal disclosure
   * the chat model forgot to tag. Renders the glowing "Neuron created" /
   * "Neuron updated" pill underneath the AI response so the user sees
   * LYKN learning about them in real time.
   */
  factNeuron?: FactNeuron;
  /**
   * Set when the AI's reply applied a ratified belief-window rule. The
   * server validated the rule is owned + active before recording the
   * attribution; renders the indigo "Applied a rule" pill underneath
   * the AI response with inline good/rule-was-off/belief-was-off feedback.
   */
  appliedAttribution?: AppliedAttribution;
};

export interface OmniaSideRailProps {
  chatMessages: PromptMessage[];
  isChatLoading: boolean;
  thinkingStatus: string;

  chatInputRef: React.MutableRefObject<string>;
  onChatInputChange: (value: string) => void;
  onSend: () => void | Promise<void>;

  chatRailWidthPx: number;
  isMobileGrid: boolean;
  notesOpen: boolean;
  showVaultSidebar: boolean;
  vaultSidebarWidthPx: number;

  onClose: () => void;
  onStartResize: (e: React.PointerEvent) => void;

  buildChatMarkdownComponents: (msgId: string) => Record<string, React.ComponentType<any>>;

  isDictating: boolean;
  isTranscribing: boolean;

  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onResizeInput: (el: HTMLTextAreaElement | null) => void;

  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatPanelInputRef: React.RefObject<HTMLTextAreaElement | null>;

  savedMediaUrls: Set<string>;
  savedYouTubeIds: Set<string>;
  onSaveYouTube: (videoId: string, url: string) => void;
  onSaveAttachment: (url: string, name: string, mediaType: "image" | "video" | "audio" | "file") => void;
  onSaveAiImage: (imageUrl: string, promptText?: string) => void;
  onSaveLink: (link: string) => void;

  onReplay: (msg: PromptMessage) => void;

  expandedAiMsgIds: Set<string>;
  toggleAiExpanded: (msgId: string) => void;
  expandedUserPromptIds: Set<string>;
  toggleUserPromptExpanded: (msgId: string) => void;
  getCollapsedPreview: (text: string) => string;

  copiedMsgId: string | null;
  onCopyMessage: (msgId: string, text: string) => void;

  addChatResponseToGrid: (text: string) => void;

  chatBarToolbar: React.ReactNode;
}

const OmniaSideRail: React.FC<OmniaSideRailProps> = React.memo(function OmniaSideRail({
  chatMessages,
  isChatLoading,
  thinkingStatus,
  chatInputRef,
  onChatInputChange,
  onSend,
  chatRailWidthPx,
  isMobileGrid,
  notesOpen,
  showVaultSidebar,
  vaultSidebarWidthPx,
  onClose,
  onStartResize,
  buildChatMarkdownComponents,
  isDictating,
  isTranscribing,
  onPaste,
  onResizeInput,
  chatScrollRef,
  chatPanelInputRef,
  savedMediaUrls,
  savedYouTubeIds,
  onSaveYouTube,
  onSaveAttachment,
  onSaveAiImage,
  onSaveLink,
  onReplay,
  expandedAiMsgIds,
  toggleAiExpanded,
  expandedUserPromptIds,
  toggleUserPromptExpanded,
  getCollapsedPreview,
  copiedMsgId,
  onCopyMessage,
  addChatResponseToGrid,
  chatBarToolbar,
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
    <div
      className={`fixed bottom-0 flex flex-col bg-transparent border-l border-black/5 dark:border-white/5 transition-[right] duration-300 ${
        notesOpen ? "z-[232]" : isMobileGrid ? "z-[80] inset-x-0 border-l-0" : "z-[64]"
      } ${isMobileGrid ? "inset-x-0 border-l-0" : ""}`}
      style={{
        top: isMobileGrid ? 0 : "var(--header-height, 4.9rem)",
        right: isMobileGrid ? undefined : (showVaultSidebar ? `${vaultSidebarWidthPx}px` : "0px"),
        width: isMobileGrid ? undefined : `${chatRailWidthPx}px`,
        animation: "chatRailSlideIn 350ms cubic-bezier(0.22,1,0.36,1) both",
      }}
    >
      {!isMobileGrid && (
        <div className="absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 cursor-col-resize z-[70] pointer-events-auto" onPointerDown={onStartResize} title="Drag to resize chat" />
      )}
      {isMobileGrid && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-black/10 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-black/80 dark:text-white/80">
            <MessageSquare className="w-3.5 h-3.5" />
            Chat
          </div>
          <button type="button" onClick={onClose} className="h-6 w-6 rounded-full flex items-center justify-center text-black/40 dark:text-white/40 hover:text-red-500 hover:bg-red-500/10 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      <div ref={chatScrollRef} className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-3">
        {chatMessages.map((msg, idx) => (
          <div key={msg.id || idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
            {msg.role === "user" && msg.attachments && msg.attachments.length > 0 && (
              <div className="max-w-[94%] flex flex-wrap gap-1.5 justify-end mb-1.5">
                {msg.attachments.map((att) => {
                  const at = (att.type || "").toLowerCase();
                  const attUrl = att.url || "";
                  const attKey = att.videoId || attUrl;
                  const isSaved = att.videoId ? savedYouTubeIds.has(att.videoId) : savedMediaUrls.has(attUrl);
                  const saveBtn = attKey ? (
                    <button type="button" className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`} disabled={isSaved} onClick={(e) => { e.stopPropagation(); if (att.videoId) { onSaveYouTube(att.videoId, attUrl); } else { onSaveAttachment(attUrl, att.name || "File", at === "image" ? "image" : at === "video" ? "video" : at === "audio" ? "audio" : "file"); } }}>
                      {isSaved ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                    </button>
                  ) : null;
                  if (at === "youtube" && att.videoId) {
                    return <div key={att.id}><div className="w-full max-w-[15rem] rounded-lg overflow-hidden border border-white/30"><iframe src={`https://www.youtube.com/embed/${att.videoId}`} className="w-full aspect-video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={att.name || "YouTube"} /></div>{saveBtn}</div>;
                  }
                  if (at === "image" && att.url) return <div key={att.id}><img src={att.url} alt={att.name || "Image"} className="max-w-[11.25rem] max-h-[120px] rounded-lg border border-white/30 object-cover" />{saveBtn}</div>;
                  if (at === "video" && att.url) return <div key={att.id}><div className="w-full max-w-[15rem] rounded-lg overflow-hidden border border-white/30"><video src={att.url} controls className="w-full" preload="metadata" /></div>{saveBtn}</div>;
                  return <div key={att.id}><div className="flex items-center gap-1 rounded-lg border border-white/30 bg-white/20 px-2 py-1 text-[0.625rem]"><FileText className="w-3 h-3 opacity-60" /><span className="truncate max-w-[7.5rem]">{att.name || "File"}</span></div>{saveBtn}</div>;
                })}
              </div>
            )}
            {msg.role === "user" ? (
              <div className="relative max-w-[94%]">
                {(() => {
                  const promptText = msg.content || "";
                  // Threshold: long prompts get a "show more / show less"
                  // affordance so the bubble doesn't dominate the rail.
                  const isLongPrompt = promptText.length > 280;
                  const isPromptExpanded = msg.id ? expandedUserPromptIds.has(msg.id) : true;
                  const collapsedClampStyle = isLongPrompt && !isPromptExpanded
                    ? { display: "-webkit-box" as const, WebkitLineClamp: 4 as any, WebkitBoxOrient: "vertical" as any, overflow: "hidden" as const }
                    : undefined;
                  return (
                    <>
                      <div
                        className="w-full rounded-2xl rounded-br-md px-3 py-2 text-xs leading-relaxed text-black/90 dark:text-white/90 border border-black/8 dark:border-white/10 bg-background dark:bg-[linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] shadow-[0_4px_14px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_14px_rgba(0,0,0,0.16)] [&_table]:text-[0.6875rem] [&_td]:py-1 [&_th]:py-1 select-text cursor-text"
                        style={collapsedClampStyle}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>{normalizeChecklistSyntax(promptText)}</ReactMarkdown>
                      </div>
                      {isLongPrompt && msg.id && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleUserPromptExpanded(msg.id); }}
                          title={isPromptExpanded ? "Show less" : "Show full prompt"}
                          aria-label={isPromptExpanded ? "Show less" : "Show full prompt"}
                          className="mt-1 ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md text-[0.6875rem] text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                        >
                          {isPromptExpanded
                            ? <span className="leading-none">Show less</span>
                            : <><MoreHorizontal className="w-3.5 h-3.5" /><span className="leading-none">Show more</span></>}
                        </button>
                      )}
                    </>
                  );
                })()}
                {(msg as any).aiImageUrl && (
                  <div className="mt-1">
                    <img src={(msg as any).aiImageUrl} alt="Generated image" className="max-w-full rounded-lg shadow-md" style={{ maxHeight: "160px" }} />
                    <button type="button" className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${savedMediaUrls.has((msg as any).aiImageUrl) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`} disabled={savedMediaUrls.has((msg as any).aiImageUrl)} onClick={(e) => { e.stopPropagation(); onSaveAiImage((msg as any).aiImageUrl, msg.content); }}>
                      {savedMediaUrls.has((msg as any).aiImageUrl) ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                    </button>
                  </div>
                )}
                {(msg as any).aiYouTubeUrls && (msg as any).aiYouTubeUrls.length > 0 && (
                  <div className="mt-1.5 space-y-1.5">
                    {(msg as any).aiYouTubeUrls.map((yt: { url: string; videoId: string }) => (
                      <div key={yt.videoId}>
                        <div className="rounded-lg overflow-hidden border border-white/30 shadow-md">
                          <iframe
                            src={`https://www.youtube-nocookie.com/embed/${yt.videoId}`}
                            className="w-full aspect-video"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                            title={`YouTube ${yt.videoId}`}
                          />
                        </div>
                        <button
                          type="button"
                          className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[0.5625rem] rounded-md border transition-all ${savedYouTubeIds.has(yt.videoId) ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70 hover:border-black/20"}`}
                          disabled={savedYouTubeIds.has(yt.videoId)}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSaveYouTube(yt.videoId, yt.url);
                          }}
                        >
                          {savedYouTubeIds.has(yt.videoId) ? <><Check className="w-2.5 h-2.5" /> Saved</> : <><Save className="w-2.5 h-2.5" /> Save to Vault</>}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {(msg as any).aiWebLinks && (msg as any).aiWebLinks.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(msg as any).aiWebLinks.map((link: string) => {
                      const isSaved = savedMediaUrls.has(link);
                      let domain = "";
                      try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { domain = link; }
                      return (
                        <div key={link} className="inline-flex items-center gap-1 rounded-md border border-white/40 bg-white/50 px-1.5 py-0.5">
                          <Globe className="w-2.5 h-2.5 text-black/40 flex-shrink-0" />
                          <span className="text-[0.5625rem] text-black/60 truncate max-w-[5rem]">{domain}</span>
                          <button
                            type="button"
                            disabled={isSaved}
                            className={`inline-flex items-center gap-0.5 px-1 py-0.5 text-[0.5rem] rounded border transition-all ${isSaved ? "border-blue-400/40 bg-blue-500/10 text-blue-600" : "border-white/40 bg-white/50 text-black/50 hover:text-black/70"}`}
                            onClick={(e) => { e.stopPropagation(); onSaveLink(link); }}
                          >
                            {isSaved ? <Check className="w-2 h-2" /> : <Save className="w-2 h-2" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="max-w-[94%] rounded-2xl rounded-bl-md px-3 py-2 text-xs leading-relaxed break-words border border-transparent bg-transparent hover:bg-white/50 dark:hover:bg-white/[0.02] hover:border-blue-300/40 dark:hover:border-white/[0.03] transition-all text-black/85 dark:text-white/85">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                  {normalizeChecklistSyntax(msg.content || "")}
                </ReactMarkdown>
              </div>
            )}
            {msg.role === "user" && msg.aiResponse && (() => {
              const isExpanded = expandedAiMsgIds.has(msg.id);
              return (
              <div className="self-start max-w-[94%] mt-1.5">
                <button
                  type="button"
                  className={`w-full flex items-center gap-1.5 text-left group/collapse transition-all ${
                    isExpanded
                      ? "px-2.5 py-1.5 rounded-xl border border-white/50 dark:border-white/12 bg-white/40 dark:bg-white/5 backdrop-blur-sm hover:bg-white/60 dark:hover:bg-white/10"
                      : "px-0 py-0.5 rounded-none border border-transparent bg-transparent backdrop-blur-none hover:bg-transparent"
                  }`}
                  onClick={() => toggleAiExpanded(msg.id)}
                >
                  <ChevronRight className={`w-3 h-3 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                  {!isExpanded && (
                    <span className="text-[0.6875rem] text-black/60 dark:text-white/60 truncate leading-tight flex-1">
                      {(msg as any).aiImageUrl ? "Generated image" : getCollapsedPreview(msg.aiResponse || "")}
                    </span>
                  )}
                  {isExpanded && (
                    <span className="text-[0.6875rem] text-black/40 dark:text-white/40 font-medium flex-1">AI Response</span>
                  )}
                </button>
                <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${isExpanded ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0"}`}>
                  <div className="overflow-hidden min-h-0 space-y-1">
                {(msg as any).aiImageUrl ? (
                  <div className="rounded-2xl rounded-bl-md px-3 py-2 border border-transparent bg-transparent hover:bg-white/50 dark:hover:bg-white/[0.02] hover:border-blue-300/40 dark:hover:border-white/[0.03] transition-all">
                    <img src={(msg as any).aiImageUrl} alt="Generated" className="max-w-full rounded-lg" style={{ maxHeight: "120px" }} />
                  </div>
                ) : (() => {
                  const chunks = splitResponseIntoChunks(msg.aiResponse || "");
                  const isSingle = chunks.length <= 1;
                  return (
                    <>
                      {chunks.map((chunk, ci) => {
                        const chunkKey = `${msg.id}-chunk-${ci}`;
                        const isSelected = selectedChunks.has(chunkKey);
                        chunkMapRef.current.set(chunkKey, chunk);
                        return (
                        <div key={chunkKey} className="group/chunk relative">
                          <div
                            draggable
                            onClick={(e) => { if (!isSingle) handleChunkClick(e, chunkKey, chunk); }}
                            onDragStart={(e) => {
                              // Prefer the chunk's raw markdown so formatting (headings,
                              // bold, lists, tables, code) survives the drop. Only honor a
                              // window selection when it's actually inside the dragged
                              // chunk AND is a substring of the markdown source — otherwise
                              // a stale or partial selection of rendered text would strip
                              // markdown markers.
                              let sel = "";
                              try {
                                const s = window.getSelection();
                                if (s && s.rangeCount > 0 && !s.isCollapsed) {
                                  const range = s.getRangeAt(0);
                                  const target = e.currentTarget as Node;
                                  if (target.contains(range.commonAncestorContainer)) {
                                    const t = String(s.toString() || "").trim();
                                    if (t && chunk.includes(t)) sel = t;
                                  }
                                }
                              } catch { /* ignore */ }
                              const text = sel || getSelectedText(chunkKey, chunk);
                              e.dataTransfer.effectAllowed = "copy";
                              e.dataTransfer.setData("application/x-omnia-chat-response", text);
                              e.dataTransfer.setData("text/plain", text);
                              try {
                                const count = selectedChunks.has(chunkKey) ? selectedChunks.size : (selectedChunks.size > 0 ? selectedChunks.size + 1 : 1);
                                const label = count > 1 ? `${count} sections` : (text.length > 60 ? text.slice(0, 57) + "…" : text);
                                const ghost = document.createElement("div");
                                ghost.textContent = label;
                                ghost.style.cssText = "position:fixed;top:-9999px;padding:6px 10px;border-radius:8px;background:rgba(59,130,246,0.15);font-size:11px;max-width:200px;overflow:hidden;white-space:nowrap";
                                document.body.appendChild(ghost);
                                e.dataTransfer.setDragImage(ghost, 0, 0);
                                requestAnimationFrame(() => ghost.remove());
                              } catch {}
                            }}
                            className={`rounded-xl px-3 py-1.5 text-xs leading-relaxed break-words border text-black/85 dark:text-white/85 cursor-grab active:cursor-grabbing transition-all ${isSelected ? "border-blue-400/50 bg-blue-50/60 dark:bg-blue-500/[0.06] dark:border-blue-400/25 shadow-sm" : isSingle ? "border-transparent bg-transparent hover:bg-white/50 dark:hover:bg-white/[0.02] hover:border-blue-300/40 dark:hover:border-white/[0.03] rounded-2xl rounded-bl-md" : "border-transparent bg-transparent hover:bg-white/50 dark:hover:bg-white/[0.02] hover:border-blue-300/40 dark:hover:border-white/[0.03] hover:shadow-sm"}`}
                          >
                            <div className={`absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/chunk:opacity-100 transition-opacity ${isSingle ? "hidden" : ""}`}>
                              <GripVertical className="w-3 h-3 text-blue-400/60" />
                            </div>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildChatMarkdownComponents(msg.id)}>
                              {normalizeChecklistSyntax(chunk)}
                            </ReactMarkdown>
                          </div>
                          {!isSingle && (
                            <button
                              type="button"
                              title={selectedChunks.size > 1 ? "Add selected sections to grid" : "Add this section to grid"}
                              className="absolute right-1 top-1 opacity-0 group-hover/chunk:opacity-100 transition-opacity p-0.5 rounded text-blue-400/70 hover:text-blue-500 hover:bg-blue-500/10"
                              onClick={() => addChatResponseToGrid(selectedChunks.size > 0 ? getSelectedText(chunkKey, chunk) : chunk)}
                            >
                              <GridIcon className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </div>
                        );
                      })}
                    </>
                  );
                })()}
                <div className="flex items-center gap-0.5 px-1">
                  <button type="button" title="Add full response to grid" className="p-1 rounded-md text-black/30 dark:text-white/30 hover:text-blue-500 hover:bg-blue-500/10 transition-colors" onClick={() => addChatResponseToGrid(msg.aiResponse || "")}>
                    <GridIcon className="w-3 h-3" />
                  </button>
                  <button type="button" title="Copy" className={`p-1 rounded-md transition-colors ${copiedMsgId === msg.id ? "text-blue-500 bg-blue-500/10" : "text-black/30 dark:text-white/30 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/5 dark:hover:bg-white/5"}`} onClick={() => { onCopyMessage(msg.id, msg.aiResponse || ""); }}>
                    {copiedMsgId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
                  </div>
                </div>
                {msg.factNeuron && <NeuronPill fact={msg.factNeuron} size="compact" />}
                {msg.appliedAttribution && <AppliedRulePill attribution={msg.appliedAttribution} size="compact" />}
              </div>
              );
            })()}
          </div>
        ))}
        {isChatLoading && (
          <div className="flex flex-col items-start w-full">
            <div className="omnia-ai-thinking-glow rounded-xl max-w-[94%] bg-black/5 dark:bg-white/8 border border-black/10 dark:border-white/12 backdrop-blur-sm text-[0.6875rem] text-black/70 dark:text-white/60 px-3 py-1.5 flex items-center gap-2" aria-live="polite">
              <div className="brick-spinner" />
              {thinkingStatus}
            </div>
          </div>
        )}
      </div>
      <div className="p-3 pb-3">
        <div className="omnia-neu-chat-shell omnia-chat-border-run-once px-2.5 py-2 w-full flex flex-col gap-1.5">
          {isDictating || isTranscribing ? (
            <div className="w-full min-h-[2.75rem] omnia-neu-chat-field ring-1 ring-blue-400/35 px-2.5 py-1.5 flex items-center gap-2">
              {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-[0.6875rem] text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 12, height: 12 }} /><span className="text-[0.6875rem] text-black/60 dark:text-white/55">Transcribing...</span></>)}
            </div>
          ) : (
            <textarea
              ref={chatPanelInputRef}
              data-min-h="44"
              defaultValue={chatInputRef.current}
              onChange={(e) => { onChatInputChange(e.target.value); onResizeInput(e.currentTarget); }}
              onPaste={onPaste}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
              placeholder="Ask me anything..."
              rows={1}
              className="w-full min-h-[2.75rem] max-h-[160px] omnia-neu-chat-field px-2.5 py-1.5 text-[0.6875rem] leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none scrollbar-hide"
            />
          )}
          {chatBarToolbar}
        </div>
      </div>
    </div>
  );
});

export default OmniaSideRail;
