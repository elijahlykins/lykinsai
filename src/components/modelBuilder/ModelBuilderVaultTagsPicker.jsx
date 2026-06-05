import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Loader2 } from "lucide-react";
import ModelBuilderAnchoredMenu from "@/components/modelBuilder/ModelBuilderAnchoredMenu";
import {
  modelBuilderMenuItemClass,
  modelBuilderMenuItemTextClass,
  modelBuilderMenuTriggerClass,
  modelBuilderMenuTriggerOpenClass,
} from "@/components/modelBuilder/modelBuilderMenuStyles";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/SupabaseAuth";
import { fetchVaultTags } from "@/lib/vault/fetchVaultTags";

const tagCheckboxClass =
  "h-3.5 w-3.5 shrink-0 rounded-sm border border-black/25 dark:border-white/30 accent-blue-600 cursor-pointer";

function normalizeTag(name) {
  return String(name || "").trim();
}

export default function ModelBuilderVaultTagsPicker({ draft, patch }) {
  const { user } = useAuth();
  const [allTags, setAllTags] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef(null);

  const selectedSet = useMemo(
    () => new Set((draft.vaultTags || []).map(normalizeTag).filter(Boolean)),
    [draft.vaultTags],
  );

  const loadTags = useCallback(() => {
    if (!user?.id) {
      setAllTags([]);
      return Promise.resolve();
    }
    setLoading(true);
    setLoadFailed(false);
    return fetchVaultTags(user.id)
      .then((tags) => setAllTags(tags))
      .catch(() => {
        setLoadFailed(true);
        setAllTags([]);
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  useEffect(() => {
    if (!allTags.length || !draft.vaultTags?.length) return;
    const valid = new Set(allTags.map((t) => t.name));
    const pruned = (draft.vaultTags || []).map(normalizeTag).filter((t) => valid.has(t));
    if (pruned.length !== draft.vaultTags.length) {
      patch({ vaultTags: pruned });
    }
  }, [allTags]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTag = useCallback(
    (name, checked) => {
      const tag = normalizeTag(name);
      if (!tag) return;
      const next = new Set(draft.vaultTags || []);
      if (checked) next.add(tag);
      else next.delete(tag);
      patch({ vaultTags: [...next] });
    },
    [draft.vaultTags, patch],
  );

  const summaryLabel = useMemo(() => {
    const n = selectedSet.size;
    if (n === 0) return "Select tags";
    if (n === 1) return "1 tag selected";
    return `${n} tags selected`;
  }, [selectedSet.size]);

  if (!user?.id) {
    return (
      <p className="text-[11px] text-muted-foreground rounded-xl border border-black/8 dark:border-white/10 px-3.5 py-2.5">
        <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
          Sign in
        </Link>{" "}
        to pick tags from your vault.
      </p>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading your tags…
      </div>
    );
  }

  if (loadFailed) {
    return (
      <p className="text-[11px] text-amber-700 dark:text-amber-400">
        Could not load tags.{" "}
        <button type="button" className="underline font-medium" onClick={() => void loadTags()}>
          Retry
        </button>
      </p>
    );
  }

  if (allTags.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground rounded-xl border border-dashed border-black/12 dark:border-white/12 px-3.5 py-3">
        No tags in your vault yet.{" "}
        <Link to="/vault" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
          Tag notes in the vault
        </Link>{" "}
        to use this option.
      </p>
    );
  }

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-xl border h-10 px-3.5 text-left text-[13px] font-medium transition-[box-shadow,border-color] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
          modelBuilderMenuTriggerClass,
          menuOpen && modelBuilderMenuTriggerOpenClass,
        )}
      >
        <span className={cn("text-foreground", selectedSet.size === 0 && "text-muted-foreground font-normal")}>
          {summaryLabel}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-foreground/70 transition-transform", menuOpen && "rotate-180")}
          strokeWidth={2.25}
        />
      </button>

      <ModelBuilderAnchoredMenu
        open={menuOpen}
        anchorRef={anchorRef}
        onClose={() => setMenuOpen(false)}
      >
        {allTags.map(({ name, count }) => {
          const checked = selectedSet.has(name);
          return (
            <li key={name}>
              <label className={cn(modelBuilderMenuItemClass, "items-center")}>
                <input
                  type="checkbox"
                  className={tagCheckboxClass}
                  checked={checked}
                  onChange={(e) => toggleTag(name, e.target.checked)}
                />
                <span className={cn(modelBuilderMenuItemTextClass, "truncate")}>{name}</span>
                <span className="text-[11px] font-medium text-muted-foreground tabular-nums shrink-0">
                  {count}
                </span>
              </label>
            </li>
          );
        })}
      </ModelBuilderAnchoredMenu>

      {selectedSet.size > 0 ? (
        <p className="text-[10px] text-muted-foreground mt-1.5 px-0.5">
          Training and previews use notes tagged with any of your selections.
        </p>
      ) : (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1.5 px-0.5">
          Pick at least one tag to include vault notes.
        </p>
      )}
    </div>
  );
}
