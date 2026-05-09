import React from "react";
import { useNavigate } from "react-router-dom";

import type { FactNeuron } from "@/lib/ai/learnedTag";

/**
 * "Neuron created" / "Neuron updated" pill that lives directly under an
 * AI response on every authenticated chat surface. Clicking it jumps the
 * user to the synthesis layer where the freshly-minted (or refreshed)
 * neuron is highlighted.
 *
 * Two visual sizes are supported because the side-rail chat is denser than
 * the focused-chat surface — palette and click behavior are identical
 * across both, only padding / font-size shift.
 *
 * The pill is shown when a model-emitted <learned>/<updated> tag was
 * parsed AND the server confirmed the neuron is new or refined (plain
 * reinforcements of an already-existing fact intentionally do NOT show
 * the pill — there's nothing visually new in the synthesis layer to
 * point at). The fallback `/api/learned/auto` classifier path returns
 * the same shape, so the pill renders the same way for either source.
 */
export type NeuronPillProps = {
  fact: FactNeuron;
  size?: "default" | "compact";
  className?: string;
};

const SIZE_CLASSES: Record<NonNullable<NeuronPillProps["size"]>, string> = {
  default: "px-3 py-1.5 text-xs",
  compact: "px-2.5 py-1 text-[11px]",
};

export function NeuronPill({
  fact,
  size = "default",
  className = "",
}: NeuronPillProps) {
  const navigate = useNavigate();
  const isUpd = Boolean(fact.isUpdate);
  const label = isUpd ? "Neuron updated" : "Neuron created";
  const dotClass = isUpd
    ? "w-1.5 h-1.5 rounded-full bg-violet-300 shadow-[0_0_8px_rgba(196,181,253,1)]"
    : "w-1.5 h-1.5 rounded-full bg-blue-300 shadow-[0_0_8px_rgba(96,165,250,1)]";
  const baseClass =
    "lykn-wake-neuron-pill inline-flex items-center gap-1.5 rounded-full font-semibold tracking-wide transition-colors cursor-pointer";
  const palette = isUpd
    ? "text-violet-100 border border-violet-400/45 bg-violet-500/[0.10] hover:bg-violet-500/[0.20] hover:text-white hover:border-violet-300/70"
    : "text-blue-100 border border-blue-400/45 bg-blue-500/[0.10] hover:bg-blue-500/[0.20] hover:text-white hover:border-blue-300/70";
  const pillClass = `${baseClass} ${SIZE_CLASSES[size]} ${palette}`;
  const title =
    isUpd && fact.previousText
      ? `"${fact.previousText}" → "${fact.text}"${fact.reason ? ` — ${fact.reason}` : ""}`
      : fact.reason || `Open the synthesis layer to see "${fact.text}"`;

  return (
    <div className={`mt-2 lykn-wake-question-fade ${className}`}>
      <button
        type="button"
        onClick={() => navigate("/synthesis-layer")}
        className={pillClass}
        title={title}
      >
        <span aria-hidden className={dotClass} />
        {label}
      </button>
    </div>
  );
}

export default NeuronPill;
