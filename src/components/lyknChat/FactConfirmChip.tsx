import React, { useState } from "react";
import { Check, Pencil, X, Loader2, ArrowRight } from "lucide-react";
import type { FactNeuron } from "@/lib/ai/learnedTag";
import {
  confirmUserFactRequest,
  dismissUserFactRequest,
} from "@/lib/ai/learnedTag";
import { API_BASE_URL } from "@/lib/api-config";

type Props = {
  fact: FactNeuron;
  onChange?: (next: FactNeuron | null) => void;
};

/**
 * In-chat ratification for Synthesis v2 User Facts.
 * Shown when the model emits <fact_confirm> (or a replace via <updated>)
 * and the server creates a pending fact.
 */
export default function FactConfirmChip({ fact, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [done, setDone] = useState<"confirmed" | "dismissed" | null>(
    fact.needsConfirm ? null : fact.status === "confirmed" ? "confirmed" : null,
  );
  const isReplace = Boolean(fact.previousText) || fact.isUpdate;

  if (!fact.needsConfirm && !done) {
    return (
      <div className="mt-2 inline-flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/12 bg-panel px-3 py-2 text-[12px] text-black/70 dark:text-white/75">
        <span className="font-medium text-black/85 dark:text-white/90">
          {isReplace ? "User fact updated" : "User fact saved"}
        </span>
        <span className="truncate max-w-[16rem]">{fact.text}</span>
      </div>
    );
  }

  if (done === "dismissed") return null;
  if (done === "confirmed") {
    return (
      <div className="mt-2 inline-flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-800 dark:text-emerald-100">
        <Check size={12} />
        <span className="font-medium">{isReplace ? "Updated about you" : "Saved about you"}</span>
        <span className="truncate max-w-[16rem]">{fact.text}</span>
      </div>
    );
  }

  const runConfirm = async (text?: string) => {
    if (!fact.id || busy) return;
    setBusy("yes");
    const next = await confirmUserFactRequest(API_BASE_URL, fact.id, text);
    setBusy(null);
    if (!next) return;
    setDone("confirmed");
    onChange?.({ ...next, needsConfirm: false, previousText: fact.previousText });
  };

  const runDismiss = async () => {
    if (!fact.id || busy) return;
    setBusy("no");
    const ok = await dismissUserFactRequest(API_BASE_URL, fact.id);
    setBusy(null);
    if (!ok) return;
    setDone("dismissed");
    onChange?.(null);
  };

  return (
    <div className="mt-2 max-w-[min(100%,28rem)] rounded-2xl border border-black/10 dark:border-white/12 bg-panel px-3.5 py-3 shadow-sm">
      <p className="text-[11px] uppercase tracking-[0.14em] text-black/45 dark:text-white/45 font-semibold mb-1">
        {isReplace ? "Update what we know?" : "Save this about you?"}
      </p>
      {isReplace && fact.previousText && !editing ? (
        <div className="mb-2 flex items-start gap-1.5 text-[12.5px] leading-snug">
          <span className="line-through text-black/40 dark:text-white/40 truncate max-w-[42%]">
            {fact.previousText}
          </span>
          <ArrowRight size={12} className="shrink-0 mt-0.5 text-black/35 dark:text-white/35" />
          <span className="font-medium text-black/90 dark:text-white/90 truncate">
            {fact.text}
          </span>
        </div>
      ) : editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full mb-2 rounded-lg border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-1.5 text-[13px] text-black/90 dark:text-white/90 focus:outline-none focus:border-blue-500/40"
          autoFocus
          maxLength={120}
        />
      ) : (
        <p className="text-[13px] font-medium text-black/90 dark:text-white/90 leading-snug mb-1">
          {fact.text}
        </p>
      )}
      {fact.reason ? (
        <p className="text-[11.5px] text-black/50 dark:text-white/50 leading-snug mb-2.5">
          {fact.reason}
        </p>
      ) : (
        <div className="mb-2.5" />
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void runConfirm(editing ? draft.trim() : undefined)}
          className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-800 dark:text-emerald-100 transition-colors disabled:opacity-50"
        >
          {busy === "yes" ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Yes
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => {
            if (editing) void runConfirm(draft.trim());
            else {
              setDraft(fact.text);
              setEditing(true);
            }
          }}
          className="inline-flex items-center gap-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] border border-black/10 dark:border-white/12 px-2.5 py-1.5 text-[11.5px] font-medium text-black/70 dark:text-white/80 transition-colors disabled:opacity-50"
        >
          <Pencil size={11} />
          {editing ? "Save edit" : "Edit"}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void runDismiss()}
          className="inline-flex items-center gap-1 rounded-lg hover:bg-rose-500/10 border border-transparent hover:border-rose-400/30 px-2.5 py-1.5 text-[11.5px] font-medium text-black/45 dark:text-white/50 hover:text-rose-700 dark:hover:text-rose-200 transition-colors disabled:opacity-50"
        >
          {busy === "no" ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
          No
        </button>
      </div>
    </div>
  );
}
