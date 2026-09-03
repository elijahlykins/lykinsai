import React from "react";
import { Check, Lock } from "lucide-react";
import { MODEL_GROUPS, LYKN_ID } from "@/lib/modelCatalog";
import { isModelAllowedForPlan } from "@/lib/modelTiers";
import lyknWordmarkBlack from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLACK-web.png";
import lyknWordmarkNeutral from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-NEUTRAL-web.png";

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
  /** Render the panel on a white/light surface (used by the light-theme
      landing chat preview) instead of the default dark glass. */
  lightMode?: boolean;
}

// Mirrors `dropdownCls` from LyknChatBarToolbar so the panel matches 1:1.
const PANEL_CLS =
  "lg-menu p-1.5";
// Light-surface variant: white panel with a subtle black hairline + soft shadow.
const PANEL_CLS_LIGHT =
  "rounded-2xl border border-black/[0.08] bg-white shadow-lg p-1.5";

export default function WakeModelMenuPreview({
  modelTier,
  selectedModel = LYKN_ID,
  lightMode = false,
}: WakeModelMenuPreviewProps) {
  const dividerCls = lightMode ? "bg-black/10" : "bg-white/10";
  const groupLabelCls = lightMode ? "text-black/50" : "text-white/50";
  const itemSelectedBg = lightMode ? "bg-black/[0.06]" : "bg-white/10";
  const itemTextCls = lightMode ? "text-black/85" : "text-white/90";
  const hintCls = lightMode ? "text-black/45" : "text-white/45";
  return (
    <div
      aria-hidden
      className={`${lightMode ? PANEL_CLS_LIGHT : PANEL_CLS} w-[15rem] max-h-[16rem] overflow-hidden ${lightMode ? "text-black" : "text-white"}`}
    >
      {MODEL_GROUPS.filter((group) => group.id === "lykn" || group.id === "frontier").map((group, gi) => (
        <React.Fragment key={group.id}>
          {gi > 0 && <div className={`-mx-1 my-1 h-px ${dividerCls}`} />}
          <div>
            {group.label ? (
              <div className={`px-2 py-1.5 text-xs font-semibold ${groupLabelCls}`}>
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
                    selected ? itemSelectedBg : ""
                  } ${allowed ? itemTextCls : `${itemTextCls} opacity-50`}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {item.value === LYKN_ID ? (
                      <img
                        src={lightMode ? lyknWordmarkBlack : lyknWordmarkNeutral}
                        alt="LYKN"
                        className="h-3.5 w-auto translate-y-[2px]"
                      />
                    ) : (
                      item.label
                    )}
                    {!allowed && <Lock className="w-3 h-3 opacity-60" />}
                  </span>
                  {item.hint ? (
                    <span className={`ml-auto pl-2 text-[0.625rem] truncate ${hintCls}`}>
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
