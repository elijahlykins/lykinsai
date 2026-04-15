import React, { useCallback, useEffect, useImperativeHandle, useState, forwardRef, useLayoutEffect, useRef } from "react";
import {
  Heading1, Heading2, Type, List, ListOrdered, ListChecks,
  ChevronRight, TextQuote, Table, Image, Mic,
} from "lucide-react";
import type { Editor, Range } from "@tiptap/react";

export interface SlashCommandItem {
  id: string;
  label: string;
  hint: string;
  section: "text" | "block";
  icon: React.ElementType;
  command: (editor: Editor, range: Range) => void;
}

const SLASH_ITEMS: SlashCommandItem[] = [
  {
    id: "h1", label: "Heading 1", hint: "Large heading", section: "text",
    icon: Heading1,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
    },
  },
  {
    id: "h2", label: "Heading 2", hint: "Medium heading", section: "text",
    icon: Heading2,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
    },
  },
  {
    id: "text", label: "Text", hint: "Plain paragraph", section: "text",
    icon: Type,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).setParagraph().run();
    },
  },
  {
    id: "bulleted-list", label: "Bulleted List", hint: "Unordered list", section: "text",
    icon: List,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: "numbered-list", label: "Numbered List", hint: "Ordered list", section: "text",
    icon: ListOrdered,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: "checklist", label: "Checklist", hint: "Task list", section: "text",
    icon: ListChecks,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: "toggle-list", label: "Toggle List", hint: "Collapsible section", section: "text",
    icon: ChevronRight,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
    },
  },
  {
    id: "quote", label: "Callout Quote", hint: "Block quote", section: "text",
    icon: TextQuote,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: "table", label: "Table", hint: "3x3 table", section: "block",
    icon: Table,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    },
  },
  {
    id: "media", label: "Media", hint: "Image / video / embed", section: "block",
    icon: Image,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).setParagraph().run();
    },
  },
  {
    id: "dictate", label: "Dictate", hint: "Voice to text", section: "block",
    icon: Mic,
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).setParagraph().run();
    },
  },
];

export { SLASH_ITEMS };

export interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface SlashCommandListProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}

const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useLayoutEffect(() => {
      const active = containerRef.current?.querySelector("[data-active='true']") as HTMLElement | null;
      active?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) command(item);
      },
      [items, command],
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) return null;

    let lastSection: string | null = null;

    return (
      <div
        ref={containerRef}
        className="z-[200] w-64 max-h-72 overflow-y-auto rounded-xl border border-black/8 bg-white/80 backdrop-blur-md shadow-lg p-1.5"
      >
        {items.map((item, index) => {
          const Icon = item.icon;
          const showDivider = lastSection !== null && lastSection !== item.section;
          lastSection = item.section;
          return (
            <React.Fragment key={item.id}>
              {showDivider && <div className="my-1 h-px bg-black/8" />}
              <button
                type="button"
                data-active={index === selectedIndex}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  index === selectedIndex
                    ? "bg-black/8 text-black"
                    : "text-black/70 hover:bg-black/5"
                }`}
                onClick={() => selectItem(index)}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-black/5">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-tight">{item.label}</p>
                  <p className="text-xs text-black/45 leading-tight">{item.hint}</p>
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  },
);

SlashCommandList.displayName = "SlashCommandList";
export default SlashCommandList;
