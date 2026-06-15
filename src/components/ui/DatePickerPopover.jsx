import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

// A small, modern single-date picker: a Radix popover wrapping react-day-picker,
// styled with Tailwind so it matches LYKN's glassy light/dark surfaces. Values
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

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          side={side}
          sideOffset={6}
          onClick={(e) => e.stopPropagation()}
          className="z-[300] rounded-2xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-[rgba(24,24,28,0.97)] backdrop-blur-xl shadow-xl p-3 text-black dark:text-white animate-in fade-in-0 zoom-in-95 duration-150"
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
            onSelect={(date) => {
              onChange(date ? toYmd(date) : "");
              setOpen(false);
            }}
            classNames={{
              months: "flex flex-col",
              month: "flex flex-col gap-3",
              caption: "flex justify-center pt-1 relative items-center",
              caption_label: "text-sm font-medium",
              nav: "flex items-center gap-1",
              nav_button:
                "h-7 w-7 inline-flex items-center justify-center rounded-md text-black/60 dark:text-white/60 opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors",
              nav_button_previous: "absolute left-1",
              nav_button_next: "absolute right-1",
              table: "w-full border-collapse",
              head_row: "flex",
              head_cell:
                "text-black/40 dark:text-white/40 rounded-md w-9 font-normal text-[0.7rem]",
              row: "flex w-full mt-1",
              cell: "relative p-0 text-center text-sm",
              day: "h-9 w-9 p-0 font-normal rounded-lg inline-flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition-colors aria-selected:opacity-100",
              day_selected:
                "bg-blue-500 text-white hover:bg-blue-500 hover:text-white focus:bg-blue-500",
              day_today: "border border-blue-500/50 font-semibold",
              day_outside: "text-black/25 dark:text-white/20",
              day_disabled: "opacity-40",
              day_hidden: "invisible",
            }}
          />
          {value ? (
            <div className="mt-1 pt-2 border-t border-black/10 dark:border-white/10 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md text-black/55 dark:text-white/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                <X className="w-3 h-3" /> Clear deadline
              </button>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
