// Portaled so the full catalog can wheel-scroll. A native <select> inside
// this page's overflow-y-auto panel cannot.
import { Fragment } from "react";
import { Lock } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BOT_MODEL_GROUPS, isBotModelAllowed } from "@/lib/bots/botModels";

function containScroll(event) {
  event.stopPropagation();
}

export default function BotModelSelect({ value, onChange, modelTier }) {
  return (
    <Select modal={false} value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Model"
        className="mt-1 h-8 w-full rounded-[10px] border-0 bg-black/[0.04] px-2.5 text-[13px] shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 dark:bg-white/[0.06]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        side="bottom"
        align="start"
        position="popper"
        className="lg-menu w-[var(--radix-select-trigger-width)] max-h-[min(28rem,70vh)] overflow-y-auto overscroll-contain p-1.5 [&>[data-radix-select-scroll-up-button]]:hidden [&>[data-radix-select-scroll-down-button]]:hidden"
        onWheel={containScroll}
      >
        {BOT_MODEL_GROUPS.map((group, gi) => (
          <Fragment key={group.id}>
            {gi > 0 ? <SelectSeparator /> : null}
            <SelectGroup>
              {group.label ? (
                <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
                  {group.label}
                </SelectLabel>
              ) : null}
              {group.items.map((item) => {
                const allowed = isBotModelAllowed(item.value, modelTier);
                return (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={!allowed}
                    className={`text-[13px] ${allowed ? "" : "cursor-not-allowed opacity-50"}`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {item.label}
                      {allowed ? null : (
                        <Lock className="h-3 w-3 opacity-60" aria-label="Upgrade required" />
                      )}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
