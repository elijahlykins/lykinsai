import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ModelBuilderRuleRowMenu({ onEdit, onDelete, className }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const showEdit = typeof onEdit === "function";
  const showDelete = typeof onDelete === "function";

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!showEdit && !showDelete) return null;

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        type="button"
        aria-label="Rule options"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08] transition-colors"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-[200] mt-1 min-w-[7.5rem] rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md p-1.5 shadow-md"
        >
          {showEdit ? (
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-lg px-3 py-1.5 text-left text-[12px] hover:bg-black/[0.06] dark:hover:bg-white/10"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              Edit
            </button>
          ) : null}
          {showDelete ? (
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-lg px-3 py-1.5 text-left text-[12px] text-red-600 dark:text-red-400 hover:bg-red-500/10"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
