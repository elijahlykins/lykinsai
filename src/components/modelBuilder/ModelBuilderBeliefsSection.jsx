import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import ModelBuilderAnchoredMenu from "@/components/modelBuilder/ModelBuilderAnchoredMenu";
import {
  modelBuilderMenuItemClass,
  modelBuilderMenuItemTextClass,
  modelBuilderMenuTriggerClass,
  modelBuilderMenuTriggerOpenClass,
} from "@/components/modelBuilder/modelBuilderMenuStyles";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/SupabaseAuth";
import { fetchSynthesisBeliefs } from "@/lib/synthesis/beliefsClient";
import ModelBuilderAddBeliefDialog from "@/components/modelBuilder/ModelBuilderAddBeliefDialog";

const beliefCheckboxClass =
  "h-3.5 w-3.5 shrink-0 rounded-sm border border-black/25 dark:border-white/30 accent-green-600 cursor-pointer";

function normalizeBeliefText(text) {
  return String(text || "").trim();
}

function uniqueTexts(texts) {
  const seen = new Set();
  const out = [];
  for (const raw of texts) {
    const t = normalizeBeliefText(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export default function ModelBuilderBeliefsSection({ draft, patch }) {
  const { user } = useAuth();
  const [addBeliefOpen, setAddBeliefOpen] = useState(false);
  const [synthesisActive, setSynthesisActive] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef(null);
  const applyAllCheckboxRef = useRef(null);

  const excludedSet = useMemo(
    () => new Set(draft.excludedSynthesisBeliefIds || []),
    [draft.excludedSynthesisBeliefIds],
  );

  const synthesisTextSet = useMemo(
    () => new Set(synthesisActive.map((b) => normalizeBeliefText(b.belief_text)).filter(Boolean)),
    [synthesisActive],
  );

  const customBeliefs = useMemo(
    () =>
      (draft.beliefs || []).filter((b) => {
        const t = normalizeBeliefText(b);
        return t && !synthesisTextSet.has(t);
      }),
    [draft.beliefs, synthesisTextSet],
  );

  const allSynthesisIncluded = useMemo(
    () => synthesisActive.length > 0 && excludedSet.size === 0,
    [synthesisActive.length, excludedSet.size],
  );

  const someSynthesisIncluded = useMemo(
    () =>
      synthesisActive.length > 0 &&
      excludedSet.size > 0 &&
      excludedSet.size < synthesisActive.length,
    [synthesisActive.length, excludedSet.size],
  );

  const rebuildBeliefs = useCallback(
    (excludedIds, custom) => {
      const excluded = new Set(excludedIds);
      const fromSynthesis = synthesisActive
        .filter((b) => !excluded.has(b.id))
        .map((b) => b.belief_text);
      return uniqueTexts([...fromSynthesis, ...custom]);
    },
    [synthesisActive],
  );

  const syncBeliefs = useCallback(
    (excludedIds, custom = customBeliefs) => {
      patch({
        excludedSynthesisBeliefIds: excludedIds,
        beliefs: rebuildBeliefs(excludedIds, custom),
      });
    },
    [customBeliefs, patch, rebuildBeliefs],
  );

  const loadSynthesis = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    return fetchSynthesisBeliefs()
      .then((data) => {
        if (!data) {
          setLoadFailed(true);
          setSynthesisActive([]);
          return;
        }
        setSynthesisActive(data.active || []);
      })
      .catch(() => {
        setLoadFailed(true);
        setSynthesisActive([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setSynthesisActive([]);
      setLoadFailed(false);
      return;
    }
    void loadSynthesis();
  }, [user?.id, loadSynthesis]);

  // Default: all synthesis beliefs included (main checkbox checked).
  useEffect(() => {
    if (!synthesisActive.length) return;
    const validIds = new Set(synthesisActive.map((b) => b.id));
    const prunedExcluded = (draft.excludedSynthesisBeliefIds || []).filter((id) => validIds.has(id));
    const nextBeliefs = rebuildBeliefs(prunedExcluded, customBeliefs);
    const beliefsDiffer =
      nextBeliefs.length !== (draft.beliefs || []).length ||
      nextBeliefs.some((t, i) => t !== (draft.beliefs || [])[i]);
    const excludedDiffer = prunedExcluded.length !== (draft.excludedSynthesisBeliefIds || []).length;
    if (beliefsDiffer || excludedDiffer) {
      patch({
        excludedSynthesisBeliefIds: prunedExcluded,
        beliefs: nextBeliefs,
      });
    }
  }, [synthesisActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = applyAllCheckboxRef.current;
    if (!el) return;
    el.indeterminate = someSynthesisIncluded;
  }, [someSynthesisIncluded]);

  const setBeliefIncluded = useCallback(
    (beliefId, included) => {
      const next = new Set(draft.excludedSynthesisBeliefIds || []);
      if (included) next.delete(beliefId);
      else next.add(beliefId);
      syncBeliefs([...next]);
    },
    [draft.excludedSynthesisBeliefIds, syncBeliefs],
  );

  const toggleApplyAll = useCallback(() => {
    if (allSynthesisIncluded) {
      syncBeliefs(synthesisActive.map((b) => b.id));
    } else {
      syncBeliefs([]);
    }
  }, [allSynthesisIncluded, synthesisActive, syncBeliefs]);

  const saveCustomBelief = useCallback(
    (rawText) => {
      const text = normalizeBeliefText(rawText);
      if (!text) return;
      const custom = uniqueTexts([...customBeliefs, text]);
      patch({ beliefs: rebuildBeliefs(draft.excludedSynthesisBeliefIds || [], custom) });
    },
    [customBeliefs, draft.excludedSynthesisBeliefIds, patch, rebuildBeliefs],
  );

  const removeCustomBelief = useCallback(
    (text) => {
      const custom = customBeliefs.filter((b) => normalizeBeliefText(b) !== normalizeBeliefText(text));
      patch({ beliefs: rebuildBeliefs(draft.excludedSynthesisBeliefIds || [], custom) });
    },
    [customBeliefs, draft.excludedSynthesisBeliefIds, patch, rebuildBeliefs],
  );

  return (
    <section className="space-y-4">
      <div>
        <Label className="text-[12px]">Beliefs</Label>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
          Your synthesis beliefs are included by default. Open the menu to uncheck any you do not want on
          this model.
        </p>
      </div>

      {!user?.id ? (
        <p className="text-[11px] text-muted-foreground rounded-xl border border-black/8 dark:border-white/10 px-3.5 py-2.5">
          <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
            Sign in
          </Link>{" "}
          to apply beliefs from your synthesis layer.
        </p>
      ) : loading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading synthesis beliefs…
        </div>
      ) : loadFailed ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Could not load beliefs.{" "}
          <button type="button" className="underline font-medium" onClick={() => void loadSynthesis()}>
            Retry
          </button>
        </p>
      ) : synthesisActive.length === 0 ? (
        <p className="text-[11px] text-muted-foreground rounded-xl border border-dashed border-black/12 dark:border-white/12 px-3.5 py-3">
          No active beliefs yet.{" "}
          <Link to="/synthesis-layer" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
            Add beliefs in the synthesis layer
          </Link>
          .
        </p>
      ) : (
        <div className="relative">
          <div
            ref={anchorRef}
            className={cn(
              "flex w-full overflow-hidden rounded-xl border transition-[box-shadow,border-color]",
              modelBuilderMenuTriggerClass,
              menuOpen && modelBuilderMenuTriggerOpenClass,
            )}
          >
            <label className="flex flex-1 min-w-0 items-center gap-2.5 h-10 px-3.5 cursor-pointer hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
              <input
                ref={applyAllCheckboxRef}
                type="checkbox"
                className={beliefCheckboxClass}
                checked={allSynthesisIncluded}
                onChange={toggleApplyAll}
              />
              <span className="text-[13px] leading-snug truncate">
                Apply all beliefs in your synthesis layer
              </span>
            </label>
            <button
              type="button"
              aria-label="Show beliefs"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="flex h-10 shrink-0 items-center justify-center px-3 border-l border-black/14 dark:border-white/18 text-foreground/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", menuOpen && "rotate-180")}
                strokeWidth={2.25}
              />
            </button>
          </div>

          <ModelBuilderAnchoredMenu
            open={menuOpen}
            anchorRef={anchorRef}
            onClose={() => setMenuOpen(false)}
          >
            {synthesisActive.map((b) => {
              const included = !excludedSet.has(b.id);
              return (
                <li key={b.id}>
                  <label className={modelBuilderMenuItemClass}>
                    <input
                      type="checkbox"
                      className={cn(beliefCheckboxClass, "mt-0.5")}
                      checked={included}
                      onChange={(e) => setBeliefIncluded(b.id, e.target.checked)}
                    />
                    <span
                      className={cn(
                        modelBuilderMenuItemTextClass,
                        !included && "text-muted-foreground",
                      )}
                    >
                      {b.belief_text}
                    </span>
                  </label>
                </li>
              );
            })}
          </ModelBuilderAnchoredMenu>
        </div>
      )}

      <div className="space-y-2 pt-1">
        <button
          type="button"
          onClick={() => setAddBeliefOpen(true)}
          className="flex items-center gap-2.5 text-left group"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-black/12 dark:border-white/14 bg-black/[0.02] dark:bg-white/[0.03] group-hover:bg-black/[0.05] dark:group-hover:bg-white/[0.06] transition-colors">
            <Plus className="h-4 w-4 text-foreground" strokeWidth={2} />
          </span>
          <span className="text-[13px] font-medium text-foreground group-hover:text-foreground/90">
            Add new belief
          </span>
        </button>

        <ModelBuilderAddBeliefDialog
          open={addBeliefOpen}
          onOpenChange={setAddBeliefOpen}
          onSave={saveCustomBelief}
        />

        {customBeliefs.length > 0 ? (
          <ul className="space-y-2 pt-1">
            {customBeliefs.map((b) => (
              <li
                key={b}
                className="group flex gap-2 rounded-xl border border-green-500/25 bg-green-500/8 px-3 py-2.5 text-[12px] leading-relaxed"
              >
                <span className="flex-1">{b}</span>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                  onClick={() => removeCustomBelief(b)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
