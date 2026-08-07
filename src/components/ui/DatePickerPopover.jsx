import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";

// A small, modern single-date picker: a Radix popover wrapping react-day-picker,
// styled to match LYKN's panel surfaces and the project month calendar. Values
// are plain "YYYY-MM-DD" strings (local), so callers don't deal with Date math.
//
//   <DatePickerPopover
//     value={due}
//     onChange={setDue}
//     trigger={<button>…</button>}
//   />

function parseYmd(value) {
  if (!value || typeof value !== "string") return undefined;
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return undefined;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toYmd(date) {
  if (!date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export default function DatePickerPopover({
  value,
  onChange,
  trigger,
  align = "start",
  side = "bottom",
}) {
  const [open, setOpen] = useState(false);
  const selected = parseYmd(value);

  const pick = (date) => {
    onChange(date ? toYmd(date) : "");
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
          className="z-[300] w-[17.5rem] rounded-[1.25rem] border border-black/[0.08] dark:border-white/[0.1] bg-panel shadow-[0_8px_30px_-12px_rgba(0,0,0,0.18),0_2px_8px_-4px_rgba(0,0,0,0.08)] dark:shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65),0_1px_0_rgba(255,255,255,0.04)_inset] p-3.5 text-black dark:text-white data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 duration-150"
        >
          <DayPicker
            mode="single"
            selected={selected}
            defaultMonth={selected}
            showOutsideDays
            weekStartsOn={0}
            components={{
              IconLeft: () => <ChevronLeft className="w-4 h-4" />,
              IconRight: () => <ChevronRight className="w-4 h-4" />,
            }}
            onSelect={(date) => pick(date)}
            classNames={{
              months: "flex flex-col",
              month: "flex flex-col gap-3",
              caption: "flex justify-center items-center relative px-8 pb-0.5",
              caption_label:
                "text-[0.8125rem] font-semibold tracking-tight text-black/90 dark:text-white/90",
              nav: "flex items-center",
              nav_button:
                "h-7 w-7 inline-flex items-center justify-center rounded-full text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors",
              nav_button_previous: "absolute left-0",
              nav_button_next: "absolute right-0",
              table: "w-full border-collapse",
              head_row: "flex w-full",
              head_cell:
                "flex-1 text-center text-[0.625rem] font-medium tracking-wide text-black/35 dark:text-white/35 pb-0.5",
              row: "flex w-full mt-0.5",
              cell: "relative flex-1 p-0 text-center text-sm flex items-center justify-center",
              day: "h-9 w-9 p-0 font-normal rounded-full inline-flex items-center justify-center text-[0.8125rem] text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors aria-selected:opacity-100",
              day_selected:
                "bg-blue-500 text-white font-medium shadow-sm hover:bg-blue-500 hover:text-white focus:bg-blue-500 focus:text-white",
              day_today:
                "font-semibold text-black dark:text-white ring-1 ring-inset ring-black/15 dark:ring-white/20 aria-selected:ring-0",
              day_outside:
                "text-black/25 dark:text-white/20 aria-selected:text-white/80",
              day_disabled: "opacity-35 pointer-events-none",
              day_hidden: "invisible",
            }}
          />

          <div className="mt-2.5 pt-2.5 border-t border-black/[0.06] dark:border-white/[0.08] flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => pick(new Date())}
              className="flex-1 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full text-black/60 dark:text-white/60 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
            >
              Today
            </button>
            {value ? (
              <button
                type="button"
                onClick={() => pick(null)}
                className="flex-1 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full text-black/45 dark:text-white/45 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Clear
              </button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
