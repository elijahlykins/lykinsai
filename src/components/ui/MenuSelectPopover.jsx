import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

/**
 * Compact option picker styled like DatePickerPopover / LYKN panel menus.
 * Replaces native <select> so dark mode and panel chrome stay consistent.
 *
 *   <MenuSelectPopover
 *     value={priority}
 *     onChange={setPriority}
 *     options={[{ value: "high", label: "High priority" }, …]}
 *     triggerLabel="Normal priority"
 *     icon={<Flag />}
 *   />
 */
export default function MenuSelectPopover({
  value,
  onChange,
  options = [],
  triggerLabel,
  icon = null,
  title,
  align = "start",
  side = "bottom",
  disabled = false,
  className = "",
  contentClassName = "",
  /** When set, controls blue “selected” trigger styling. Defaults to non-empty / non-default. */
  active: activeProp,
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef(null);
  const selected = options.find((o) => String(o.value) === String(value));
  const label = triggerLabel ?? selected?.label ?? "Select";
  const active =
    typeof activeProp === "boolean"
      ? activeProp
      : value !== "" && value != null && String(value) !== "normal";

  // Dialog RemoveScroll often swallows wheel on portaled popovers — drive
  // scrollTop ourselves so long lists (e.g. projects) stay scrollable.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (el.scrollHeight <= el.clientHeight + 1) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, options.length]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={title || label}
          className={`inline-flex items-center gap-1.5 max-w-[11rem] px-2.5 py-1.5 rounded-lg border text-[0.75rem] transition-colors disabled:opacity-50 ${
            open || active
              ? "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
              : "border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/5 text-black/60 dark:text-white/60 hover:border-blue-500/40 hover:text-black/80 dark:hover:text-white/80"
          } ${className}`}
        >
          {icon ? <span className="shrink-0 opacity-80">{icon}</span> : null}
          <span className="truncate">{label}</span>
          <ChevronDown
            className={`w-3 h-3 shrink-0 opacity-50 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          className={`lg-menu z-[300] min-w-[11rem] max-w-[16rem] p-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 duration-150 ${contentClassName}`}
        >
          <div
            ref={listRef}
            className="max-h-56 overflow-y-auto overscroll-contain space-y-0.5 pr-0.5 scrollbar-hide"
          >
            {options.map((opt) => {
              const isSelected = String(opt.value) === String(value);
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[0.8125rem] transition-colors ${
                    isSelected
                      ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                      : "text-black/75 dark:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                  }`}
                >
                  {opt.dot ? (
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.dot}`} />
                  ) : opt.icon ? (
                    <span className="shrink-0 opacity-70">{opt.icon}</span>
                  ) : null}
                  <span className="flex-1 min-w-0 truncate">{opt.label}</span>
                  {isSelected ? <Check className="w-3.5 h-3.5 shrink-0 opacity-70" /> : null}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
