import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE_URL } from "@/lib/api-config";
import type { AppliedAttribution } from "@/lib/ai/appliedTag";

/**
 * "Applied a rule" pill — the user-facing audit affordance for the
 * belief-window mechanic. Renders directly under an AI response when
 * the chat model emitted a verified `<applied rule_id="...">` tag and
 * the server confirmed the rule belongs to the user and is currently
 * active.
 *
 * Click → expands inline with the rule snapshot, the belief snapshot,
 * the "served need" chip, and a three-state feedback prompt:
 *   • Good call           — reinforces both rule + belief confidence
 *   • The rule was off    — penalizes ONLY the rule
 *   • The belief was off  — penalizes ONLY the belief
 *
 * The third state — "neither was wrong, it was a generation miss" — is
 * available on the deeper Why log in BeliefWindowPanel; the inline pill
 * keeps the choice trivial so users actually use it. The repair-loop
 * fidelity is what makes this whole layer falsifiable instead of vibes.
 *
 * Honest by default: tag-less replies render no pill. We never guess
 * "this came from belief X" — the attribution is server-validated
 * before we ever get one back to render.
 */

export type AppliedRulePillProps = {
  attribution: AppliedAttribution;
  size?: "default" | "compact";
  className?: string;
};

const SIZE_CLASSES: Record<NonNullable<AppliedRulePillProps["size"]>, string> = {
  default: "px-3 py-1.5 text-xs",
  compact: "px-2.5 py-1 text-[11px]",
};

const NEED_LABEL: Record<string, string> = {
  live: "Live",
  love: "Love",
  value: "Value",
  variety: "Variety",
};

export function AppliedRulePill({
  attribution,
  size = "default",
  className = "",
}: AppliedRulePillProps) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<
    "pending" | "submitting" | "submitted"
  >("pending");
  const [outcome, setOutcome] = useState<string | null>(null);

  const submitFeedback = async (payload: {
    action: "good" | "bad";
    ruleWasBad?: boolean;
    beliefWasBad?: boolean;
  }) => {
    if (!attribution.id) return;
    if (feedback !== "pending") return;
    setFeedback("submitting");
    try {
      await fetch(`${API_BASE_URL}/api/applied/${attribution.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFeedback("submitted");
      setOutcome(
        payload.action === "good"
          ? "Reinforced this rule and the belief behind it."
          : payload.ruleWasBad
            ? "Penalized the rule. It'll auto-retire if this keeps happening."
            : payload.beliefWasBad
              ? "Penalized the belief. We'll surface it for review."
              : "Logged as a generation miss — neither rule nor belief penalized.",
      );
    } catch {
      setFeedback("pending");
    }
  };

  const baseClass =
    "lykn-applied-rule-pill inline-flex items-center gap-1.5 rounded-full font-semibold tracking-wide transition-colors cursor-pointer";
  const palette =
    "text-blue-700 dark:text-blue-100 border border-blue-400/45 bg-blue-500/[0.10] hover:bg-blue-500/[0.20] hover:text-blue-900 dark:hover:text-white hover:border-blue-300/70";
  const pillClass = `${baseClass} ${SIZE_CLASSES[size]} ${palette}`;
  const needLabel = NEED_LABEL[attribution.servesNeed] || attribution.servesNeed || "—";

  return (
    <div className={`mt-2 ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={pillClass}
        title={
          attribution.reason ||
          "Open to see which rule shaped this reply"
        }
      >
        <span
          aria-hidden
          className="w-1.5 h-1.5 rounded-full bg-blue-300 shadow-[0_0_8px_rgba(147,197,253,1)]"
        />
        Applied a rule
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg border border-blue-400/25 bg-blue-500/[0.04] px-3 py-2.5 text-[0.7rem] leading-snug max-w-md">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[0.6rem] uppercase tracking-[0.18em] text-blue-700/70 dark:text-blue-200/70 font-semibold">
              Why this answer
            </span>
            <span className="text-[0.6rem] px-1.5 py-0.5 rounded-md bg-blue-500/15 border border-blue-400/30 text-blue-700 dark:text-blue-200">
              serves: {needLabel}
            </span>
          </div>

          {attribution.beliefSnapshot && (
            <p className="text-black/85 dark:text-white/88">{attribution.beliefSnapshot}</p>
          )}
          {attribution.ruleSnapshot && (
            <p className="mt-1 text-black/55 dark:text-white/55 italic">
              {attribution.ruleSnapshot}
            </p>
          )}
          {attribution.reason && (
            <p className="mt-1.5 text-black/65 dark:text-white/65">"{attribution.reason}"</p>
          )}

          {feedback === "pending" && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => submitFeedback({ action: "good" })}
                className="px-2 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-700 dark:text-emerald-200 text-[0.65rem] font-medium transition-colors"
              >
                Good call
              </button>
              <button
                type="button"
                onClick={() =>
                  submitFeedback({ action: "bad", ruleWasBad: true })
                }
                className="px-2 py-1 rounded-md bg-amber-500/12 hover:bg-amber-500/22 border border-amber-400/30 text-amber-700 dark:text-amber-200 text-[0.65rem] font-medium transition-colors"
              >
                Rule was off
              </button>
              <button
                type="button"
                onClick={() =>
                  submitFeedback({ action: "bad", beliefWasBad: true })
                }
                className="px-2 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-400/25 text-rose-700 dark:text-rose-200 text-[0.65rem] font-medium transition-colors"
              >
                Belief was off
              </button>
              <button
                type="button"
                onClick={() => navigate("/synthesis-layer")}
                className="ml-auto text-[0.6rem] text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/85 transition-colors"
              >
                Open Core Beliefs →
              </button>
            </div>
          )}

          {feedback === "submitting" && (
            <p className="mt-2 text-[0.62rem] text-black/55 dark:text-white/55">Saving…</p>
          )}
          {feedback === "submitted" && outcome && (
            <p className="mt-2 text-[0.62rem] text-black/65 dark:text-white/65">{outcome}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default AppliedRulePill;
