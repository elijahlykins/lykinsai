import { useLayoutEffect, useRef } from "react";
import { AppWindow, File as FileIcon, Folder, Lock, Sparkles } from "lucide-react";
import type { SlashPathItem } from "@/lib/chat/slashPathQuery";

export default function SlashPathMenu({
  open,
  items,
  index,
  hint,
  onHover,
  onPick,
  anchored = false,
  ariaLabel = "Link a file or folder",
  emptyHint = "Type a file or folder on this Mac",
}: {
  open: boolean;
  items: SlashPathItem[];
  index: number;
  hint: string;
  onHover: (index: number) => void;
  onPick: (item: SlashPathItem, mode: "attach" | "descend") => void;
  /** Home bar: parent already placed this as a sibling of the glass pill. */
  anchored?: boolean;
  ariaLabel?: string;
  emptyHint?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector('[data-active="true"]');
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [open, index, items]);

  if (!open) return null;

  return (
    <div
      className={`lg-menu pointer-events-auto z-40 overflow-hidden rounded-[14px] p-1.5 ${
        anchored
          ? "w-[22rem]"
          : "absolute bottom-[calc(100%+6px)] left-0 w-[min(24rem,calc(100%-0.5rem))]"
      }`}
      role="listbox"
      aria-label={ariaLabel}
    >
      {hint ? (
        <div className="px-2.5 py-1.5 text-[0.72rem] text-black/50 dark:text-white/50">{hint}</div>
      ) : null}
      {items.length === 0 && !hint ? (
        <div className="px-2.5 py-1.5 text-[0.72rem] text-black/50 dark:text-white/50">{emptyHint}</div>
      ) : null}
      <div ref={listRef} className="max-h-56 overflow-y-auto">
        {items.map((item, i) => {
          const active = i === index;
          const Icon =
            item.kind === "folder"
              ? Folder
              : item.kind === "model"
                ? Sparkles
                : item.kind === "app"
                  ? AppWindow
                  : FileIcon;
          const tag = item.tag || (item.kind === "folder" ? "folder" : "");
          return (
            <button
              key={`${item.kind}:${item.path}`}
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={item.locked || undefined}
              data-active={active || undefined}
              className={`lg-menu-row flex w-full scroll-my-1 items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left ${
                item.locked
                  ? "opacity-50"
                  : active
                    ? "font-medium text-black dark:text-white"
                    : "text-black/70 dark:text-white/75"
              }`}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(item, "attach")}
              onDoubleClick={() => onPick(item, item.kind === "folder" ? "descend" : "attach")}
            >
              {item.logoUrl ? (
                <img
                  src={item.logoUrl}
                  alt=""
                  className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-contain"
                />
              ) : (
                <Icon
                  className={`h-3.5 w-3.5 shrink-0 ${
                    item.kind === "folder"
                      ? "text-sky-500"
                      : item.kind === "app"
                        ? "text-emerald-500"
                        : "opacity-60"
                  }`}
                  strokeWidth={1.6}
                  fill={item.kind === "folder" ? "currentColor" : "none"}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.75rem]">{item.name}</span>
                {item.subtitle && item.subtitle !== item.name ? (
                  <span className="block truncate text-[0.62rem] font-normal text-black/40 dark:text-white/40">
                    {item.subtitle}
                  </span>
                ) : null}
              </span>
              {item.locked ? (
                <Lock className="h-3 w-3 shrink-0 opacity-60" aria-label="Upgrade required" />
              ) : tag ? (
                <span className="shrink-0 text-[0.62rem] text-black/35 dark:text-white/35">{tag}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
