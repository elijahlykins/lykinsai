import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

// A small time picker styled like DatePickerPopover. Values are "HH:MM"
// (24h) strings so they drop straight into existing event form state.
//
//   <TimePickerPopover
//     value={startTime}
//     onChange={setStartTime}
//     trigger={<button>…</button>}
//   />

const STEP_MINUTES = 15;

function buildSlots(step = STEP_MINUTES) {
  const out = [];
  for (let mins = 0; mins < 24 * 60; mins += step) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    out.push({ value, label: formatTimeLabel(value) });
  }
  return out;
}

const SLOTS = buildSlots();

/** Friendly label for an "HH:MM" value ("9:00 AM"). */
export function formatTimeLabel(value) {
  if (!value || typeof value !== "string") return "";
  const [hs, ms] = value.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(hs) || Number.isNaN(ms)) return value;
  const period = hs >= 12 ? "PM" : "AM";
  const hour12 = hs % 12 === 0 ? 12 : hs % 12;
  return `${hour12}:${String(ms).padStart(2, "0")} ${period}`;
}

export default function TimePickerPopover({
  value,
  onChange,
  trigger,
  align = "start",
  side = "bottom",
  allowClear = false,
  clearLabel = "Clear",
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef(null);
  const selectedRef = useRef(null);

  // Keep off-grid values (e.g. 09:07 from a synced event) visible + selectable.
  const slots = useMemo(() => {
    if (!value || SLOTS.some((s) => s.value === value)) return SLOTS;
    const extra = { value, label: formatTimeLabel(value) };
    return [...SLOTS, extra].sort((a, b) => a.value.localeCompare(b.value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    // Defer so the popover has mounted before scrolling the selected slot in.
    const id = requestAnimationFrame(() => {
      selectedRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [open, value]);

  const pick = (next) => {
    onChange(next || "");
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          onClick={(e) => e.stopPropagation()}
          className="lg-menu z-[300] w-[9.5rem] p-2 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 duration-150"
        >
          <div
            ref={listRef}
            className="max-h-[14.5rem] overflow-y-auto scrollbar-hide flex flex-col gap-0.5 px-0.5"
          >
            {slots.map((slot) => {
              const selected = slot.value === value;
              return (
                <button
                  key={slot.value}
                  type="button"
                  ref={selected ? selectedRef : undefined}
                  onClick={() => pick(slot.value)}
                  className={`w-full text-left text-[0.8125rem] px-3 py-1.5 rounded-full transition-colors tabular-nums ${
                    selected
                      ? "bg-blue-500 text-white font-medium shadow-sm"
                      : "text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                  }`}
                >
                  {slot.label}
                </button>
              );
            })}
          </div>

          {allowClear && value ? (
            <div className="mt-1.5 pt-1.5 border-t border-black/[0.06] dark:border-white/[0.08]">
              <button
                type="button"
                onClick={() => pick("")}
                className="w-full text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full text-black/45 dark:text-white/45 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                {clearLabel}
              </button>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
