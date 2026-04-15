import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, ReactRenderer, Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Youtube from "@tiptap/extension-youtube";
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
import { StickyNote, ChevronDown } from "lucide-react";

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
  content: any;
  onContentChange: (json: any) => void;
  hasLeftRail?: boolean;
}

const MIN_HEIGHT_VH = 20;
const MAX_HEIGHT_VH = 100;
/** Below this height (vh) on release, the sheet closes */
const DISMISS_BELOW_VH = 22;
/** When sheet is this tall or more, treat as full-screen (no left rail gutter; square top corners) */
const FULLSCREEN_FROM_VH = 94;

export default function NotesPanel({ open, onOpenChange, content, onContentChange, hasLeftRail }: NotesPanelProps) {
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
  const onContentChangeRef = useRef(onContentChange);
  useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);

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
    window.addEventListener("omnia_notes_insert_vault", onVaultInsert as EventListener);
    return () => window.removeEventListener("omnia_notes_insert_vault", onVaultInsert as EventListener);
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

    window.addEventListener("omnia_notes_ai_update", onAiUpdate as EventListener);
    return () => {
      window.removeEventListener("omnia_notes_ai_update", onAiUpdate as EventListener);
      cancelStream();
    };
  }, []);

  const isFullBleed = heightVh >= FULLSCREEN_FROM_VH;
  /** Match focused chat: editor clears the fixed left “Grid Files” column whenever the rail is shown */
  const editorPadLeft = hasLeftRail && open ? "calc(13.75rem + 1.5rem)" : "1.5rem";

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

  useEffect(() => {
    if (!editor) return;
    if (open && !contentInitialised.current) {
      if (content && typeof content === "object" && content.type) {
        editor.commands.setContent(content);
      }
      contentInitialised.current = true;
    }
    if (!open) {
      contentInitialised.current = false;
    }
  }, [editor, open, content]);

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
        data-omnia-notes-root=""
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

        {/* Header — only shown when panel is open */}
        {open && (
          <div className="flex-shrink-0 flex items-center px-6 pb-3 pt-1 border-b border-black/6 dark:border-white/6 gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex items-center justify-center w-6 h-6 rounded-md text-black/35 dark:text-white/35 hover:text-black/60 dark:hover:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-black/40 dark:text-white/40" />
              <h3 className="text-sm font-semibold text-black/70 dark:text-white/70">Notes</h3>
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
    </>
  );
}
