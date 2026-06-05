import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/SupabaseAuth";
import { fetchSynthesisNeuronsForPicker } from "@/lib/synthesis/fetchSynthesisNeuronsForPicker";
import { neuronKey } from "@/lib/modelBuilder/knowledgeSelection";

const checkboxClass =
  "h-3.5 w-3.5 shrink-0 rounded-sm border border-black/25 dark:border-white/30 accent-green-600 cursor-pointer";

const GROUPS = [
  { kind: "belief", label: "Beliefs", hint: "Principles from your synthesis layer" },
  { kind: "fact", label: "Facts", hint: "Identity and context the model should know" },
  { kind: "rule", label: "Rules", hint: "If-then governance edges" },
  { kind: "concept", label: "Concepts", hint: "Themes linking notes, facts, and beliefs" },
];

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

function rebuildBeliefsFromSelection(includedNeurons, beliefRows, customBeliefs) {
  const selectedBeliefIds = new Set(
    (includedNeurons || []).filter((n) => n.kind === "belief").map((n) => n.id),
  );
  const synthesisTextSet = new Set(beliefRows.map((b) => normalizeBeliefText(b.label)).filter(Boolean));
  const fromSynthesis = beliefRows
    .filter((b) => selectedBeliefIds.has(b.id))
    .map((b) => b.label);
  const custom = (customBeliefs || []).filter((b) => {
    const t = normalizeBeliefText(b);
    return t && !synthesisTextSet.has(t);
  });
  return uniqueTexts([...fromSynthesis, ...custom]);
}

export default function ModelBuilderSynthesisNeuronsPicker({ draft, patch }) {
  const { user } = useAuth();
  const [groups, setGroups] = useState({ beliefs: [], facts: [], rules: [], concepts: [] });
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKind, setActiveKind] = useState("belief");

  const selectedKeys = useMemo(() => {
    const set = new Set();
    for (const n of draft.includedSynthesisNeurons || []) {
      set.add(neuronKey(n.kind, n.id));
    }
    return set;
  }, [draft.includedSynthesisNeurons]);

  const loadNeurons = useCallback(() => {
    if (!user?.id) {
      setGroups({ beliefs: [], facts: [], rules: [], concepts: [] });
      return Promise.resolve();
    }
    setLoading(true);
    setLoadFailed(false);
    return fetchSynthesisNeuronsForPicker(user.id)
      .then((data) => setGroups(data))
      .catch(() => {
        setLoadFailed(true);
        setGroups({ beliefs: [], facts: [], rules: [], concepts: [] });
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => {
    void loadNeurons();
  }, [loadNeurons]);

  const rowsForKind = useMemo(() => {
    if (activeKind === "belief") return groups.beliefs;
    if (activeKind === "fact") return groups.facts;
    if (activeKind === "rule") return groups.rules;
    return groups.concepts;
  }, [activeKind, groups]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rowsForKind;
    return rowsForKind.filter((row) => String(row.label || "").toLowerCase().includes(q));
  }, [query, rowsForKind]);

  const customBeliefs = useMemo(() => {
    const synthesisTextSet = new Set(groups.beliefs.map((b) => normalizeBeliefText(b.label)).filter(Boolean));
    return (draft.beliefs || []).filter((b) => {
      const t = normalizeBeliefText(b);
      return t && !synthesisTextSet.has(t);
    });
  }, [draft.beliefs, groups.beliefs]);

  const syncSelection = useCallback(
    (nextNeurons) => {
      patch({
        includedSynthesisNeurons: nextNeurons,
        beliefs: rebuildBeliefsFromSelection(nextNeurons, groups.beliefs, customBeliefs),
        excludedSynthesisBeliefIds: [],
      });
    },
    [customBeliefs, groups.beliefs, patch],
  );

  useEffect(() => {
    if (draft.synthesisKnowledgeMode !== "selected") return;
    if (!groups.beliefs.length && !groups.facts.length && !groups.rules.length && !groups.concepts.length) {
      return;
    }
    const validKeys = new Set();
    for (const row of [...groups.beliefs, ...groups.facts, ...groups.rules, ...groups.concepts]) {
      validKeys.add(neuronKey(row.kind, row.id));
    }
    const pruned = (draft.includedSynthesisNeurons || []).filter((n) =>
      validKeys.has(neuronKey(n.kind, n.id)),
    );
    if (pruned.length !== (draft.includedSynthesisNeurons || []).length) {
      syncSelection(pruned);
    }
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (draft.synthesisKnowledgeMode !== "selected") return;
    if (!groups.beliefs.length) return;
    const rebuilt = rebuildBeliefsFromSelection(
      draft.includedSynthesisNeurons,
      groups.beliefs,
      customBeliefs,
    );
    const currentKey = (draft.beliefs || []).join("\0");
    const rebuiltKey = rebuilt.join("\0");
    if (currentKey !== rebuiltKey) {
      patch({ beliefs: rebuilt });
    }
  }, [
    customBeliefs,
    draft.beliefs,
    draft.includedSynthesisNeurons,
    draft.synthesisKnowledgeMode,
    groups.beliefs,
    patch,
  ]);

  const toggleRow = useCallback(
    (row, checked) => {
      const key = neuronKey(row.kind, row.id);
      const current = draft.includedSynthesisNeurons || [];
      let next;
      if (checked) {
        if (current.some((n) => neuronKey(n.kind, n.id) === key)) next = current;
        else next = [...current, { kind: row.kind, id: row.id, label: row.label }];
      } else {
        next = current.filter((n) => neuronKey(n.kind, n.id) !== key);
      }
      syncSelection(next);
    },
    [draft.includedSynthesisNeurons, syncSelection],
  );

  const selectAllVisible = useCallback(() => {
    const current = new Map(
      (draft.includedSynthesisNeurons || []).map((n) => [neuronKey(n.kind, n.id), n]),
    );
    for (const row of filteredRows) {
      current.set(neuronKey(row.kind, row.id), { kind: row.kind, id: row.id, label: row.label });
    }
    syncSelection([...current.values()]);
  }, [draft.includedSynthesisNeurons, filteredRows, syncSelection]);

  const clearKind = useCallback(() => {
    const next = (draft.includedSynthesisNeurons || []).filter((n) => n.kind !== activeKind);
    syncSelection(next);
  }, [activeKind, draft.includedSynthesisNeurons, syncSelection]);

  const totalAvailable =
    groups.beliefs.length + groups.facts.length + groups.rules.length + groups.concepts.length;

  if (!user?.id) {
    return (
      <p className="text-[11px] text-muted-foreground rounded-xl border border-black/8 dark:border-white/10 px-3.5 py-2.5">
        <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
          Sign in
        </Link>{" "}
        to connect synthesis neurons.
      </p>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading synthesis neurons…
      </div>
    );
  }

  if (loadFailed) {
    return (
      <p className="text-[11px] text-amber-700 dark:text-amber-400">
        Could not load synthesis neurons.{" "}
        <button type="button" className="underline font-medium" onClick={() => void loadNeurons()}>
          Retry
        </button>
      </p>
    );
  }

  if (totalAvailable === 0) {
    return (
      <p className="text-[11px] text-muted-foreground rounded-xl border border-dashed border-black/12 dark:border-white/12 px-3.5 py-3">
        No synthesis neurons yet.{" "}
        <Link
          to="/synthesis-layer"
          className="text-blue-600 dark:text-blue-400 font-medium hover:underline"
        >
          Build your synthesis layer
        </Link>{" "}
        first.
      </p>
    );
  }

  const activeGroup = GROUPS.find((g) => g.kind === activeKind) || GROUPS[0];
  const selectedCount = (draft.includedSynthesisNeurons || []).length;
  const linkedProjectId = draft.linkedProjectId || null;

  const counts = {
    belief: groups.beliefs.length,
    fact: groups.facts.length,
    rule: groups.rules.length,
    concept: groups.concepts.length,
  };

  return (
    <div className="space-y-3">
      {linkedProjectId && selectedCount > 0 ? (
        <p className="text-[10px] text-green-800 dark:text-green-300 rounded-lg border border-green-500/25 bg-green-500/10 px-3 py-2 leading-relaxed">
          Synthesis neurons from your connected project are selected below. Vault files from the same
          project appear in the vault section.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {GROUPS.map((g) => (
          <button
            key={g.kind}
            type="button"
            onClick={() => setActiveKind(g.kind)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors",
              activeKind === g.kind
                ? "border-green-500/40 bg-green-500/10 text-foreground"
                : "border-black/10 dark:border-white/12 text-muted-foreground hover:text-foreground",
            )}
          >
            {g.label} ({counts[g.kind]})
          </button>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground">{activeGroup.hint}</p>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${activeGroup.label.toLowerCase()}…`}
          className="w-full h-9 rounded-xl border border-black/10 dark:border-white/12 bg-black/[0.02] dark:bg-white/[0.03] pl-9 pr-3 text-[12px] outline-none focus:border-green-400/50"
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-0.5">
        <p className="text-[10px] text-muted-foreground">{selectedCount} neurons connected</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-[10px] font-medium text-green-700 dark:text-green-400 hover:underline"
            onClick={selectAllVisible}
          >
            Select visible
          </button>
          <button
            type="button"
            className="text-[10px] font-medium text-muted-foreground hover:underline"
            onClick={clearKind}
          >
            Clear {activeGroup.label.toLowerCase()}
          </button>
        </div>
      </div>

      <ul className="max-h-52 overflow-y-auto rounded-xl border border-black/10 dark:border-white/12 divide-y divide-black/6 dark:divide-white/8">
        {filteredRows.length === 0 ? (
          <li className="px-3.5 py-3 text-[11px] text-muted-foreground">
            No {activeGroup.label.toLowerCase()} match your search.
          </li>
        ) : (
          filteredRows.map((row) => {
            const checked = selectedKeys.has(neuronKey(row.kind, row.id));
            return (
              <li key={row.id}>
                <label
                  className={cn(
                    "flex items-start gap-2.5 px-3.5 py-2.5 cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                    !checked && "opacity-80",
                  )}
                >
                  <input
                    type="checkbox"
                    className={cn(checkboxClass, "mt-0.5")}
                    checked={checked}
                    onChange={(e) => toggleRow(row, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1 text-[12px] leading-snug">{row.label}</span>
                </label>
              </li>
            );
          })
        )}
      </ul>

      {selectedCount === 0 ? (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 px-0.5">
          Select at least one neuron, or switch to the full synthesis layer.
        </p>
      ) : null}
    </div>
  );
}
