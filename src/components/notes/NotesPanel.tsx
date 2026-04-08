import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, ReactRenderer, Extension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import SlashCommandList, { SLASH_ITEMS, type SlashCommandItem, type SlashCommandListRef } from "./SlashCommandMenu";
import { StickyNote, ChevronDown } from "lucide-react";

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

const HEADER_REM = 4.2;
const MIN_HEIGHT_VH = 20;
const MAX_HEIGHT_VH = 100;

export default function NotesPanel({ open, onOpenChange, content, onContentChange, hasLeftRail }: NotesPanelProps) {
  const contentInitialised = useRef(false);
  const [heightVh, setHeightVh] = useState(50);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = heightVh;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [heightVh]);

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
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (heightVh < 12) onOpenChange(false);
  }, [heightVh, onOpenChange]);

  useEffect(() => {
    if (open) setHeightVh(50);
  }, [open]);

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
      SlashCommands,
    ],
    editorProps: {
      attributes: {
        class: "notes-editor-content outline-none min-h-[200px] px-1",
      },
    },
    onUpdate: ({ editor: ed }) => {
      onContentChange(ed.getJSON());
    },
  });

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
      {/* Small centered tab — always visible at bottom, pull to open */}
      {!open && (
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[70]">
          <div
            className="w-16 h-[0.4rem] rounded-t-md bg-black/15 hover:bg-black/25 cursor-pointer select-none touch-none transition-colors py-1 box-content"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={() => { if (!dragging.current) onOpenChange(true); }}
          />
        </div>
      )}

      {/* Sliding notes panel */}
      <div
        className={`fixed inset-x-0 bottom-0 z-[68] flex flex-col rounded-t-2xl bg-white/95 backdrop-blur-xl border-t border-black/10 shadow-2xl ${
          dragging.current ? "" : "transition-transform duration-300 ease-out"
        } ${open ? "translate-y-0" : "translate-y-full"}`}
        style={{ height: `${heightVh}svh` }}
      >
        {/* Drag handle inside panel */}
        <div className="flex-shrink-0 flex justify-center">
          <div
            className="w-12 pt-1.5 pb-1 cursor-row-resize select-none touch-none flex items-center justify-center"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div className="w-8 h-1 rounded-full bg-black/15" />
          </div>
        </div>

        {/* Header — only shown when panel is open */}
        {open && (
          <div className="flex-shrink-0 flex items-center px-6 pb-3 pt-1 border-b border-black/6 gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex items-center justify-center w-6 h-6 rounded-md text-black/35 hover:text-black/60 hover:bg-black/5 transition-colors"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-black/40" />
              <h3 className="text-sm font-semibold text-black/70">Notes</h3>
            </div>
          </div>
        )}

        {/* Editor area */}
        <div
          className="flex-1 overflow-y-auto scrollbar-hide py-4"
          style={{
            paddingLeft: hasLeftRail ? "calc(13.75rem + 1.5rem)" : "1.5rem",
            paddingRight: "1.5rem",
          }}
        >
          <div className="mx-auto max-w-2xl">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </>
  );
}
