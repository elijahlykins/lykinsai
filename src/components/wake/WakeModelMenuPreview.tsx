import React from "react";
import { Check, Lock } from "lucide-react";
import { MODEL_GROUPS, LYKN_ID } from "@/lib/modelCatalog";
import { isModelAllowedForPlan } from "@/lib/modelTiers";

/**
 * Static, non-interactive replica of the in-app model `<Select>` menu, shown
 * "pulled up" above the chat bar in the landing chat preview. The real menu is
 * a Radix Select that portals to document.body and positions via popper, which
 * renders unscaled and mis-anchored inside the scaled, screenshot-style preview
 * tree. This mirrors the exact panel + item styling and the canonical
 * `MODEL_GROUPS` data (free-tier gated) so it reads as the genuine UI.
 */
interface WakeModelMenuPreviewProps {
  /** Plan tier used for the lock gating. When omitted, every model renders
      unlocked (no lock icons) — used by the marketing chat preview. */
  modelTier?: string;
  /** Currently selected model id (shows the checkmark). */
  selectedModel?: string;
}

// Mirrors `dropdownCls` from OmniaChatBarToolbar so the panel matches 1:1.
const PANEL_CLS =
  "rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5";

export default function WakeModelMenuPreview({
  modelTier,
  selectedModel = LYKN_ID,
}: WakeModelMenuPreviewProps) {
  return (
    <div
      aria-hidden
      className={`${PANEL_CLS} w-[15rem] max-h-[16rem] overflow-hidden text-white`}
    >
      {MODEL_GROUPS.map((group, gi) => (
        <React.Fragment key={group.id}>
          {gi > 0 && <div className="-mx-1 my-1 h-px bg-white/10" />}
          <div>
            {group.label ? (
              <div className="px-2 py-1.5 text-xs font-semibold text-white/50">
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => {
              const allowed = modelTier
                ? isModelAllowedForPlan(item.value, modelTier)
                : true;
              const selected = item.value === selectedModel;
              return (
                <div
                  key={item.value}
                  className={`relative flex w-full items-center rounded-sm py-1.5 pl-2 pr-8 text-sm ${
                    selected ? "bg-white/10" : ""
                  } ${allowed ? "text-white/90" : "text-white/90 opacity-50"}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {item.label}
                    {!allowed && <Lock className="w-3 h-3 opacity-60" />}
                  </span>
                  {item.hint ? (
                    <span className="ml-auto pl-2 text-[0.625rem] text-white/45 truncate">
                      {item.hint}
                    </span>
                  ) : null}
                  {selected && (
                    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                      <Check className="h-4 w-4" />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
