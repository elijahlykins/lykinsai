import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, ReactRenderer, Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Youtube from "@tiptap/extension-youtube";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Suggestion from "@tiptap/suggestion";
import { WebEmbed } from "./webEmbedExtension";
import type { SuggestionOptions } from "@tiptap/suggestion";
import type { Editor as TiptapEditor } from "@tiptap/core";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import SlashCommandList, { SLASH_ITEMS, type SlashCommandItem, type SlashCommandListRef } from "./SlashCommandMenu";
import {
  insertNotesDropContent,
  insertVaultPayloadIntoNotes,
  hasNotesDropHintTypes,
  hasExternalNotesDropPayload,
} from "./notesDropInsert";
import { StickyNote, ChevronDown, Plus, X, Highlighter, Type as TypeIcon, Brain, ListCollapse, Search } from "lucide-react";

export interface NotePage {
  id: string;
  title: string;
  content: any;
}

/* ── streaming helpers ── */

function countNodeWords(node: any): number {
  if (!node) return 0;
  if (node.type === "text")
    return (node.text || "").split(/\s+/).filter(Boolean).length;
  if (Array.isArray(node.content))
    return node.content.reduce((s: number, c: any) => s + countNodeWords(c), 0);
  return 0;
}

function truncateNodeAtWords(
  node: any,
  maxWords: number,
): { node: any; used: number } | null {
  if (!node || maxWords <= 0) return null;

  if (node.type === "text") {
    const parts = (node.text || "").split(/(\s+)/);
    let count = 0;
    let result = "";
    for (const part of parts) {
      if (/\S/.test(part)) {
        count++;
        if (count > maxWords) break;
      }
      result += part;
    }
    return { node: { ...node, text: result }, used: Math.min(count, maxWords) };
  }

  if (Array.isArray(node.content) && node.content.length > 0) {
    const newContent: any[] = [];
    let remaining = maxWords;
    let totalUsed = 0;
    for (const child of node.content) {
      if (remaining <= 0) break;
      const childWords = countNodeWords(child);
      if (childWords <= remaining) {
        newContent.push(child);
        remaining -= childWords;
        totalUsed += childWords;
      } else {
        const truncated = truncateNodeAtWords(child, remaining);
        if (truncated) {
          newContent.push(truncated.node);
          totalUsed += truncated.used;
        }
        remaining = 0;
      }
    }
    return { node: { ...node, content: newContent }, used: totalUsed };
  }

  return { node, used: 0 };
}

function buildPartialContent(nodes: any[], wordLimit: number): any[] {
  const result: any[] = [];
  let remaining = wordLimit;
  for (const node of nodes) {
    if (remaining <= 0) break;
    const words = countNodeWords(node);
    if (words === 0) {
      result.push(node);
      continue;
    }
    if (words <= remaining) {
      result.push(node);
      remaining -= words;
    } else {
      const t = truncateNodeAtWords(node, remaining);
      if (t) result.push(t.node);
      remaining = 0;
    }
  }
  return result;
}

const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        items: ({ query }: { query: string }) => {
          const q = query.toLowerCase();
          if (!q) return SLASH_ITEMS;
          return SLASH_ITEMS.filter(
            (item) =>
              item.label.toLowerCase().includes(q) ||
              item.id.includes(q),
          );
        },
        render: () => {
          let component: ReactRenderer<SlashCommandListRef> | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(SlashCommandList, {
                props: {
                  items: props.items,
                  command: (item: SlashCommandItem) => {
                    item.command(props.editor, props.range);
                  },
                },
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy("body", {
                getReferenceClientRect: props.clientRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                offset: [0, 4],
              });
            },
            onUpdate: (props: any) => {
              component?.updateProps({
                items: props.items,
                command: (item: SlashCommandItem) => {
                  item.command(props.editor, props.range);
                },
              });
              if (popup?.[0] && props.clientRect) {
                popup[0].setProps({ getReferenceClientRect: props.clientRect });
              }
            },
            onKeyDown: (props: any) => {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
                return true;
              }
              return (component?.ref as SlashCommandListRef)?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              popup?.[0]?.destroy();
              component?.destroy();
            },
          };
        },
      } satisfies Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

interface NotesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: NotePage[];
  activePageId: string;
  onActivePageChange: (id: string) => void;
  onPagesChange: (pages: NotePage[]) => void;
  hasLeftRail?: boolean;
}

const MIN_HEIGHT_VH = 20;
const MAX_HEIGHT_VH = 100;
const DISMISS_BELOW_VH = 22;
const FULLSCREEN_FROM_VH = 94;

export default function NotesPanel({ open, onOpenChange, pages, activePageId, onActivePageChange, onPagesChange, hasLeftRail }: NotesPanelProps) {
  const editorRef = useRef<TiptapEditor | null>(null);
  const contentInitialised = useRef(false);
  const [heightVh, setHeightVh] = useState(MAX_HEIGHT_VH);
  const heightVhRef = useRef(heightVh);
  const dragging = useRef(false);
  const [dragActive, setDragActive] = useState(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const notesStreamTimerRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const activePage = pages.find((p) => p.id === activePageId) || pages[0];
  const content = activePage?.content;

  const onContentChange = useCallback(
    (json: any) => {
      const updated = pages.map((p) =>
        p.id === activePageId ? { ...p, content: json } : p,
      );
      onPagesChange(updated);
    },
    [pages, activePageId, onPagesChange],
  );

  const onContentChangeRef = useRef(onContentChange);
  useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const addPage = useCallback(() => {
    const id = crypto.randomUUID();
    const newPage: NotePage = {
      id,
      title: `Page ${pages.length + 1}`,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    };
    onPagesChange([...pages, newPage]);
    onActivePageChange(id);
  }, [pages, onPagesChange, onActivePageChange]);

  const removePage = useCallback(
    (id: string) => {
      if (pages.length <= 1) return;
      const idx = pages.findIndex((p) => p.id === id);
      const next = pages.filter((p) => p.id !== id);
      onPagesChange(next);
      if (activePageId === id) {
        const newIdx = Math.min(idx, next.length - 1);
        onActivePageChange(next[newIdx].id);
      }
    },
    [pages, activePageId, onPagesChange, onActivePageChange],
  );

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      onPagesChange(
        pages.map((p) => (p.id === renamingId ? { ...p, title: trimmed } : p)),
      );
    }
    setRenamingId(null);
  }, [renamingId, renameValue, pages, onPagesChange]);

  useEffect(() => {
    heightVhRef.current = heightVh;
  }, [heightVh]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    setDragActive(true);
    startY.current = e.clientY;
    startH.current = heightVhRef.current;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    const dvh = (dy / window.innerHeight) * 100;
    const next = Math.min(MAX_HEIGHT_VH, Math.max(MIN_HEIGHT_VH, startH.current + dvh));
    setHeightVh(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    setDragActive(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (heightVhRef.current < DISMISS_BELOW_VH) onOpenChange(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (open) setHeightVh(MAX_HEIGHT_VH);
  }, [open]);

  useEffect(() => {
    const onVaultInsert = (e: Event) => {
      if (!open) return;
      const ce = e as CustomEvent<{ payload?: Record<string, unknown>; clientX?: number; clientY?: number }>;
      const payload = ce.detail?.payload;
      if (!payload || typeof payload !== "object") return;
      const ed = editorRef.current;
      if (!ed) return;
      void insertVaultPayloadIntoNotes(ed, payload, {
        clientX: ce.detail.clientX,
        clientY: ce.detail.clientY,
      });
    };
    window.addEventListener("lyknchat_notes_insert_vault", onVaultInsert as EventListener);
    return () => window.removeEventListener("lyknchat_notes_insert_vault", onVaultInsert as EventListener);
  }, [open]);

  useEffect(() => {
    const cancelStream = () => {
      if (notesStreamTimerRef.current) {
        clearInterval(notesStreamTimerRef.current);
        notesStreamTimerRef.current = null;
      }
      setIsStreaming(false);
    };

    const onAiUpdate = (e: Event) => {
      const ed = editorRef.current;
      if (!ed) return;
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const action = String(detail.action || "set");
      const tiptapDoc = detail.tiptapDoc;
      const shouldStream = detail.stream === true;

      cancelStream();

      if (!shouldStream) {
        if (action === "set" && tiptapDoc) {
          ed.commands.setContent(tiptapDoc);
          onContentChangeRef.current(ed.getJSON());
        } else if (action === "append" && tiptapDoc) {
          const endPos = ed.state.doc.content.size;
          const nodes = Array.isArray(tiptapDoc?.content) ? tiptapDoc.content : [];
          for (const node of nodes) {
            ed.commands.insertContentAt(endPos, node);
          }
          onContentChangeRef.current(ed.getJSON());
        }
        return;
      }

      const fullNodes = Array.isArray(tiptapDoc?.content) ? tiptapDoc.content : [];
      const totalWords = fullNodes.reduce((s: number, n: any) => s + countNodeWords(n), 0);

      if (totalWords === 0) {
        if (action === "set") ed.commands.setContent(tiptapDoc);
        onContentChangeRef.current(ed.getJSON());
        return;
      }

      const existingContent = action === "append" ? (ed.getJSON()?.content || []) : [];

      if (action === "set") {
        ed.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
      }

      setIsStreaming(true);
      ed.setEditable(false);

      let wordTarget = 0;
      const WORDS_PER_TICK = 3;
      const TICK_MS = 30;

      notesStreamTimerRef.current = window.setInterval(() => {
        if (!editorRef.current) { cancelStream(); return; }
        wordTarget += WORDS_PER_TICK;
        const partial = buildPartialContent(fullNodes, Math.min(wordTarget, totalWords));
        editorRef.current.commands.setContent({
          type: "doc",
          content: [...existingContent, ...partial],
        });

        const sc = scrollContainerRef.current;
        if (sc) sc.scrollTop = sc.scrollHeight;

        if (wordTarget >= totalWords) {
          cancelStream();
          editorRef.current.commands.setContent({
            type: "doc",
            content: [...existingContent, ...fullNodes],
          });
          editorRef.current.setEditable(true);
          onContentChangeRef.current(editorRef.current.getJSON());
        }
      }, TICK_MS);
    };

    window.addEventListener("lyknchat_notes_ai_update", onAiUpdate as EventListener);
    return () => {
      window.removeEventListener("lyknchat_notes_ai_update", onAiUpdate as EventListener);
      cancelStream();
    };
  }, []);

  const isFullBleed = heightVh >= FULLSCREEN_FROM_VH;
  /** Match focused chat: editor clears the fixed left “Grid Files” column whenever the rail is shown */
  const editorPadLeft = hasLeftRail && open ? "calc(13.75rem + 1.5rem)" : "1.5rem";

  /* ── Selection toolbar (mirrors Canvas brick toolbar) ── */
  const [selToolbar, setSelToolbar] = useState<{
    visible: boolean;
    x: number;
    y: number;
    text: string;
    highlightSub: boolean;
    textColorSub: boolean;
  }>({ visible: false, x: 0, y: 0, text: "", highlightSub: false, textColorSub: false });
  const selToolbarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        if (selToolbarRef.current?.matches(":hover")) return;
        setSelToolbar((s) => (s.visible ? { ...s, visible: false, highlightSub: false, textColorSub: false } : s));
        return;
      }
      const anchor = sel.anchorNode;
      if (!anchor) return;
      const notesRoot = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest?.("[data-lykn-chat-notes-root]") as HTMLElement | null;
      if (!notesRoot) {
        setSelToolbar((s) => (s.visible ? { ...s, visible: false, highlightSub: false, textColorSub: false } : s));
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      setSelToolbar((s) => ({
        visible: true,
        x: rect.left + rect.width / 2,
        y: rect.top - 10,
        text: sel.toString(),
        highlightSub: s.visible ? s.highlightSub : false,
        textColorSub: s.visible ? s.textColorSub : false,
      }));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [open]);

  const selToolbarHighlightColors = useMemo(() => [
    { label: "Default", value: "" },
    { label: "Blue", value: "rgba(59,130,246,0.40)" },
    { label: "Green", value: "rgba(22,163,74,0.40)" },
    { label: "Amber", value: "rgba(217,119,6,0.40)" },
    { label: "Red", value: "rgba(220,38,38,0.40)" },
    { label: "Purple", value: "rgba(124,58,237,0.40)" },
    { label: "Pink", value: "rgba(219,39,119,0.40)" },
    { label: "Teal", value: "rgba(15,118,110,0.40)" },
  ], []);

  const selToolbarTextColors = useMemo(() => [
    { label: "Default", value: "" },
    { label: "Blue", value: "#3B82F6" },
    { label: "Green", value: "#16A34A" },
    { label: "Amber", value: "#D97706" },
    { label: "Red", value: "#DC2626" },
    { label: "Purple", value: "#7C3AED" },
    { label: "Pink", value: "#DB2777" },
    { label: "Teal", value: "#0F766E" },
    { label: "White", value: "#FFFFFF" },
    { label: "Black", value: "#000000" },
  ], []);

  const applyNoteHighlight = useCallback((color: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (color) {
      ed.chain().focus().setHighlight({ color }).run();
    } else {
      ed.chain().focus().unsetHighlight().run();
    }
    setSelToolbar((s) => ({ ...s, visible: false, highlightSub: false, textColorSub: false }));
  }, []);

  const applyNoteTextColor = useCallback((color: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (color) {
      ed.chain().focus().setColor(color).run();
    } else {
      ed.chain().focus().unsetColor().run();
    }
    setSelToolbar((s) => ({ ...s, visible: false, highlightSub: false, textColorSub: false }));
  }, []);

  const dispatchNoteSelectionAiAction = useCallback((action: string, prompt: string) => {
    const text = selToolbar.text;
    if (!text.trim()) return;
    window.dispatchEvent(new CustomEvent("lyknchat_ai_brick_action", {
      detail: {
        blockId: "notes-selection",
        action,
        prompt: `${prompt}\n\nSelected text:\n"${text}"`,
      },
    }));
    window.getSelection()?.removeAllRanges();
    setSelToolbar((s) => ({ ...s, visible: false, highlightSub: false, textColorSub: false }));
  }, [selToolbar.text]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: "Start typing or press / for commands...",
        showOnlyWhenEditable: true,
        showOnlyCurrent: true,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Image.configure({ allowBase64: true }),
      Youtube.configure({
        nocookie: true,
        width: 640,
        height: 360,
        controls: true,
        allowFullscreen: true,
      }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      WebEmbed,
      SlashCommands,
    ],
    editorProps: {
      attributes: {
        class: "notes-editor-content outline-none min-h-[200px] px-1",
      },
      handleDragOver(_view, event) {
        if (hasNotesDropHintTypes(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
        return false;
      },
      handleDrop(_view, event, _slice, moved) {
        if (moved) return false;
        if (!hasExternalNotesDropPayload(event)) return false;
        const ed = editorRef.current;
        if (!ed) return false;
        void insertNotesDropContent(ed, event);
        return true;
      },
    },
    onCreate: ({ editor: created }) => {
      editorRef.current = created;
    },
    onDestroy: () => {
      editorRef.current = null;
    },
    onUpdate: ({ editor: ed }) => {
      onContentChange(ed.getJSON());
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const prevActivePageRef = useRef(activePageId);

  useEffect(() => {
    if (!editor) return;

    const pageChanged = prevActivePageRef.current !== activePageId;
    prevActivePageRef.current = activePageId;

    if (pageChanged && open) {
      if (content && typeof content === "object" && content.type) {
        editor.commands.setContent(content);
      } else {
        editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
      }
      return;
    }

    if (open && !contentInitialised.current) {
      if (content && typeof content === "object" && content.type) {
        editor.commands.setContent(content);
      }
      contentInitialised.current = true;
    }
    if (!open) {
      contentInitialised.current = false;
    }
  }, [editor, open, content, activePageId]);

  return (
    <>
      <style>{`
        .notes-editor-content [data-youtube-video] {
          max-width: 100%;
          margin: 0.75rem 0;
          border-radius: 0.75rem;
          overflow: hidden;
        }
        .notes-editor-content [data-youtube-video] iframe {
          width: 100% !important;
          max-width: 100%;
          height: auto !important;
          aspect-ratio: 16 / 9;
        }
      `}</style>
      {/* Small centered tab — always visible at bottom, pull to open */}
      {!open && (
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[210] max-md:bottom-[env(safe-area-inset-bottom,0px)]">
          <div
            className="w-16 h-[0.4rem] rounded-t-md bg-black/15 dark:bg-white/15 hover:bg-black/25 dark:hover:bg-white/25 cursor-pointer select-none touch-none transition-colors py-1 box-content"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={() => { if (!dragging.current) onOpenChange(true); }}
          />
        </div>
      )}

      {/* Sliding notes panel — opens full viewport; drag handle down to resize / dismiss */}
      <div
        data-lykn-chat-notes-root=""
        className={`fixed inset-x-0 bottom-0 flex flex-col bg-white/80 dark:bg-[#1e1e1e]/90 backdrop-blur-md border-black/8 dark:border-white/8 shadow-lg ${
          isFullBleed ? "rounded-none border-t-0" : "rounded-t-2xl border-t"
        } ${open ? "z-[220]" : "z-[68]"} ${
          dragActive ? "" : "transition-[transform,height] duration-300 ease-out"
        } ${open ? "translate-y-0" : "translate-y-full"}`}
        style={{ height: `${heightVh}svh`, maxHeight: "100svh" }}
      >
        {/* Drag handle inside panel */}
        <div className="flex-shrink-0 flex justify-center">
          <div
            className="w-12 min-h-[44px] pt-2 pb-1 cursor-row-resize select-none touch-none flex items-center justify-center touch-manipulation"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div className="w-8 h-1 rounded-full bg-black/15 dark:bg-white/15" />
          </div>
        </div>

        {/* Header — Notes label + inline page tabs */}
        {open && (
          <div
            className="flex-shrink-0 flex items-center border-b border-black/6 dark:border-white/6 gap-3 py-1"
            style={{ paddingLeft: editorPadLeft, paddingRight: "1.5rem" }}
          >
            {/* Close / title */}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-black/35 dark:text-white/35 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
            <div className="flex-shrink-0 flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-black/40 dark:text-white/40" />
              <h3 className="text-sm font-semibold text-black/70 dark:text-white/70">Notes</h3>
            </div>

            {/* Divider */}
            <div className="flex-shrink-0 w-px h-4 bg-black/8 dark:bg-white/10" />

            {/* Page tabs — scrollable row inline with header */}
            <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide min-w-0">
              {pages.map((page) => {
                const isActive = page.id === activePageId;
                const isRenaming = renamingId === page.id;
                return (
                  <div
                    key={page.id}
                    className={`group relative flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer select-none transition-colors ${
                      isActive
                        ? "bg-black/6 dark:bg-white/8 text-black/80 dark:text-white/80"
                        : "text-black/40 dark:text-white/40 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/4 dark:hover:bg-white/4"
                    }`}
                    onClick={() => {
                      if (!isRenaming) onActivePageChange(page.id);
                    }}
                    onDoubleClick={() => {
                      setRenamingId(page.id);
                      setRenameValue(page.title);
                      setTimeout(() => renameInputRef.current?.select(), 0);
                    }}
                  >
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        className="w-20 bg-transparent border-b border-black/20 dark:border-white/20 outline-none text-xs"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="truncate max-w-[8rem]">{page.title}</span>
                    )}

                    {pages.length > 1 && !isRenaming && (
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-4 h-4 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
                        onClick={(e) => {
                          e.stopPropagation();
                          removePage(page.id);
                        }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}

              {/* Add page */}
              <button
                type="button"
                onClick={addPage}
                className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-black/30 dark:text-white/30 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Editor area */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto scrollbar-hide py-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          style={{
            paddingLeft: editorPadLeft,
            paddingRight: "1.5rem",
          }}
        >
          <div className="mx-auto max-w-2xl min-h-[min(60vh,480px)]">
            <EditorContent editor={editor} />
            {isStreaming && (
              <span className="inline-block w-[2px] h-[1.1em] bg-black/50 dark:bg-white/50 ml-0.5 align-text-bottom animate-pulse" />
            )}
          </div>
        </div>
      </div>

      {/* ── Text-selection floating toolbar (same as Canvas bricks) ── */}
      {selToolbar.visible && createPortal(
        <div
          ref={selToolbarRef}
          className="fixed z-[9999] flex flex-col items-center"
          style={{
            left: `${selToolbar.x}px`,
            top: `${selToolbar.y}px`,
            transform: "translate(-50%, -100%)",
            animation: "selToolbarFadeIn 0.12s ease-out",
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-stretch rounded-lg overflow-hidden border border-white/30 dark:border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.82),rgba(245,247,255,0.78))] dark:bg-[linear-gradient(145deg,rgba(43,43,43,0.92),rgba(33,33,33,0.88))] shadow-lg backdrop-blur-md">
            {!selToolbar.highlightSub && !selToolbar.textColorSub && (
              <>
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-black/75 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
                  title="Highlight"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, highlightSub: true, textColorSub: false }))}
                >
                  <Highlighter className="w-3.5 h-3.5" />
                  <span>Highlight</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-black/75 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
                  title="Text Color"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, textColorSub: true, highlightSub: false }))}
                >
                  <TypeIcon className="w-3.5 h-3.5" />
                  <span>Color</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 dark:hover:bg-blue-400/10 transition-colors whitespace-nowrap"
                  title="AI Analyze"
                  onClick={() => dispatchNoteSelectionAiAction("ai-analyse", "Analyse this text. Strengths, weaknesses, opportunities, risks — bullet points only, max 6 bullets. No fluff.")}
                >
                  <Brain className="w-3.5 h-3.5" />
                  <span>Analyze</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 dark:hover:bg-blue-400/10 transition-colors whitespace-nowrap"
                  title="AI Summarize"
                  onClick={() => dispatchNoteSelectionAiAction("ai-summary", "Summarize this in 2-3 sentences max. Core concept, value prop, who it's for. Nothing else.")}
                >
                  <ListCollapse className="w-3.5 h-3.5" />
                  <span>Summarize</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 dark:hover:bg-blue-400/10 transition-colors whitespace-nowrap"
                  title="AI Search"
                  onClick={() => dispatchNoteSelectionAiAction("ai-search", "Search for related information, context, and insights about this topic. Provide relevant findings.")}
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Search</span>
                </button>
              </>
            )}

            {selToolbar.highlightSub && (
              <div className="flex flex-col min-w-[160px]">
                <button
                  className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-black/50 dark:text-white/60 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, highlightSub: false }))}
                >
                  <ChevronDown className="w-3 h-3 rotate-90" />
                  <span>Highlight Color</span>
                </button>
                <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                  {selToolbarHighlightColors.map((c) => (
                    <button
                      key={c.label}
                      className="w-7 h-7 rounded-lg border border-black/15 dark:border-white/15 hover:scale-110 transition-transform flex items-center justify-center"
                      style={{ background: c.value || "linear-gradient(145deg, rgba(255,255,255,0.34), rgba(255,255,255,0.18))" }}
                      title={c.label}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyNoteHighlight(c.value)}
                    >
                      {!c.value && <span className="text-[9px] text-black/40 dark:text-white/40">∅</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selToolbar.textColorSub && (
              <div className="flex flex-col min-w-[160px]">
                <button
                  className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-black/50 dark:text-white/60 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, textColorSub: false }))}
                >
                  <ChevronDown className="w-3 h-3 rotate-90" />
                  <span>Text Color</span>
                </button>
                <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                  {selToolbarTextColors.map((c) => (
                    <button
                      key={c.label}
                      className="w-7 h-7 rounded-lg border border-black/15 dark:border-white/15 hover:scale-110 transition-transform flex items-center justify-center"
                      style={{ background: c.value || "transparent" }}
                      title={c.label}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyNoteTextColor(c.value)}
                    >
                      {!c.value && <span className="text-[9px] text-black/40 dark:text-white/40">∅</span>}
                      {c.value && <span className="text-[11px] font-bold" style={{ color: c.value, textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}>A</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="w-2 h-2 rotate-45 bg-white/95 dark:bg-[rgba(35,35,42,0.95)] border-r border-b border-white/50 dark:border-white/10 -mt-1" style={{ boxShadow: "2px 2px 4px rgba(0,0,0,0.08)" }} />
        </div>,
        document.body
      )}
    </>
  );
}
