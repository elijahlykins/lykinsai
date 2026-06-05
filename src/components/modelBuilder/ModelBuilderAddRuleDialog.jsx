import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  fetchSynthesisBeliefs,
  patchSynthesisRule,
  retireSynthesisRule,
} from "@/lib/synthesis/beliefsClient";
import ModelBuilderRuleListItem from "@/components/modelBuilder/ModelBuilderRuleListItem";

function normalizeBeliefText(text) {
  return String(text || "").trim();
}

function beliefOptionKey(beliefId, text) {
  return beliefId ? `id:${beliefId}` : `text:${normalizeBeliefText(text)}`;
}

function ruleMatchesBelief(rule, belief) {
  if (!belief || !rule) return false;
  if (belief.beliefId) {
    const rid = rule.belief_id || rule.beliefId;
    if (rid && rid === belief.beliefId) return true;
  }
  const rt = normalizeBeliefText(rule.belief_text || rule.beliefText);
  return rt === normalizeBeliefText(belief.beliefText);
}

function loadRuleIntoForm(rule, beliefOptions, setters) {
  const { setRuleIf, setRuleThen, setSelectedBeliefKey } = setters;
  setRuleIf(rule.if || "");
  setRuleThen(rule.then || "");
  const text = normalizeBeliefText(rule.belief_text || rule.beliefText);
  const id = rule.belief_id || rule.beliefId;
  const key = beliefOptionKey(id, text);
  if (beliefOptions.some((o) => o.key === key)) {
    setSelectedBeliefKey(key);
    return;
  }
  const byText = beliefOptions.find((o) => o.beliefText === text);
  if (byText) setSelectedBeliefKey(byText.key);
}

export default function ModelBuilderAddRuleDialog({
  open,
  onOpenChange,
  onSave,
  onDelete,
  editIndex = null,
  draft,
}) {
  const { user } = useAuth();
  const [ruleIf, setRuleIf] = useState("");
  const [ruleThen, setRuleThen] = useState("");
  const [selectedBeliefKey, setSelectedBeliefKey] = useState("");
  const [synthesisActive, setSynthesisActive] = useState([]);
  const [synthesisRules, setSynthesisRules] = useState([]);
  const [beliefsLoading, setBeliefsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** @type {null | { kind: 'model', index: number } | { kind: 'synthesis', ruleId: string }} */
  const [inlineEdit, setInlineEdit] = useState(null);

  const synthesisByText = useMemo(() => {
    const m = new Map();
    for (const b of synthesisActive) {
      const t = normalizeBeliefText(b.belief_text);
      if (t) m.set(t, b);
    }
    return m;
  }, [synthesisActive]);

  const beliefOptions = useMemo(() => {
    const texts = (draft?.beliefs || []).map(normalizeBeliefText).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const text of texts) {
      if (seen.has(text)) continue;
      seen.add(text);
      const syn = synthesisByText.get(text);
      const beliefId = syn?.id || null;
      out.push({
        key: beliefOptionKey(beliefId, text),
        beliefId,
        beliefText: text,
        label: text.length > 72 ? `${text.slice(0, 70)}…` : text,
      });
    }
    return out;
  }, [draft?.beliefs, synthesisByText]);

  const reset = useCallback(() => {
    setRuleIf("");
    setRuleThen("");
    setSelectedBeliefKey("");
    setInlineEdit(null);
  }, []);

  const modelEditIndex =
    editIndex != null && editIndex >= 0
      ? editIndex
      : inlineEdit?.kind === "model"
        ? inlineEdit.index
        : null;
  const synthesisEditId = inlineEdit?.kind === "synthesis" ? inlineEdit.ruleId : null;
  const isEditingModel = modelEditIndex != null && modelEditIndex >= 0;
  const isEditingSynthesis = !!synthesisEditId;
  const isEditing = isEditingModel || isEditingSynthesis;

  const handleOpenChange = useCallback(
    (next) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const startEditModelRule = useCallback(
    (index) => {
      const rule = draft?.rules?.[index];
      if (!rule) return;
      setInlineEdit({ kind: "model", index });
      loadRuleIntoForm(rule, beliefOptions, {
        setRuleIf,
        setRuleThen,
        setSelectedBeliefKey,
      });
    },
    [draft?.rules, beliefOptions],
  );

  const startEditSynthesisRule = useCallback((synRule) => {
    setInlineEdit({ kind: "synthesis", ruleId: synRule.id });
    setRuleIf(synRule.trigger_text || "");
    setRuleThen(synRule.action_text || "");
  }, []);

  useEffect(() => {
    if (!open || !isEditingModel || modelEditIndex == null || !draft?.rules?.[modelEditIndex]) return;
    if (inlineEdit?.kind === "model") return;
    loadRuleIntoForm(draft.rules[modelEditIndex], beliefOptions, {
      setRuleIf,
      setRuleThen,
      setSelectedBeliefKey,
    });
  }, [open, isEditingModel, modelEditIndex, inlineEdit, draft?.rules, beliefOptions]);

  const handleDeleteSynthesisRule = useCallback(
    async (ruleId) => {
      if (!user?.id) return;
      try {
        await retireSynthesisRule(ruleId);
        setSynthesisRules((prev) => prev.filter((r) => r.id !== ruleId));
        if (synthesisEditId === ruleId) {
          reset();
        }
      } catch {
        /* ignore */
      }
    },
    [user?.id, synthesisEditId, reset],
  );

  useEffect(() => {
    if (!open || !user?.id) {
      if (!open) {
        setSynthesisActive([]);
        setSynthesisRules([]);
      }
      return;
    }
    let cancelled = false;
    setBeliefsLoading(true);
    fetchSynthesisBeliefs()
      .then((data) => {
        if (!cancelled) {
          setSynthesisActive(data?.active || []);
          setSynthesisRules(data?.rules || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSynthesisActive([]);
          setSynthesisRules([]);
        }
      })
      .finally(() => {
        if (!cancelled) setBeliefsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user?.id]);

  useEffect(() => {
    if (!open || beliefOptions.length === 0 || isEditing) return;
    if (!selectedBeliefKey || !beliefOptions.some((o) => o.key === selectedBeliefKey)) {
      setSelectedBeliefKey(beliefOptions[0].key);
    }
  }, [open, beliefOptions, selectedBeliefKey, isEditing]);

  const selectedBelief = beliefOptions.find((o) => o.key === selectedBeliefKey);

  const { modelRulesForBelief, synthesisRulesForBelief } = useMemo(() => {
    if (!selectedBelief) {
      return { modelRulesForBelief: [], synthesisRulesForBelief: [] };
    }
    const modelRulesForBelief = (draft?.rules || [])
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => ruleMatchesBelief(rule, selectedBelief));
    const modelPairs = new Set(
      modelRulesForBelief.map(
        ({ rule }) => `${normalizeBeliefText(rule.if)}|${normalizeBeliefText(rule.then)}`,
      ),
    );
    const synthesisRulesForBelief = selectedBelief.beliefId
      ? (synthesisRules || []).filter((r) => {
          if (r.status === "retired" || r.belief_id !== selectedBelief.beliefId) return false;
          const pair = `${normalizeBeliefText(r.trigger_text)}|${normalizeBeliefText(r.action_text)}`;
          return !modelPairs.has(pair);
        })
      : [];
    return { modelRulesForBelief, synthesisRulesForBelief };
  }, [draft?.rules, selectedBelief, synthesisRules]);

  const hasExistingRules =
    modelRulesForBelief.length > 0 || synthesisRulesForBelief.length > 0;

  const handleSave = useCallback(async () => {
    const iff = ruleIf.trim();
    const then = ruleThen.trim();
    if (!iff || !then || !selectedBelief || saving) return;

    setSaving(true);
    try {
      if (isEditingSynthesis && synthesisEditId) {
        const updated = await patchSynthesisRule(synthesisEditId, {
          triggerText: iff,
          actionText: then,
        });
        setSynthesisRules((prev) =>
          prev.map((r) =>
            r.id === synthesisEditId
              ? {
                  ...r,
                  trigger_text: updated.trigger_text ?? iff,
                  action_text: updated.action_text ?? then,
                }
              : r,
          ),
        );
        reset();
        return;
      }

      onSave(
        {
          if: iff,
          then,
          ...(selectedBelief.beliefId ? { belief_id: selectedBelief.beliefId } : {}),
          belief_text: selectedBelief.beliefText,
        },
        isEditingModel ? modelEditIndex : null,
      );
      const openedFromMainList = editIndex != null && editIndex >= 0;
      reset();
      if (openedFromMainList) onOpenChange(false);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [
    ruleIf,
    ruleThen,
    selectedBelief,
    saving,
    isEditingSynthesis,
    synthesisEditId,
    isEditingModel,
    modelEditIndex,
    editIndex,
    onSave,
    onOpenChange,
    reset,
  ]);

  const canSave =
    !!ruleIf.trim() && !!ruleThen.trim() && !!selectedBelief && beliefOptions.length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,36rem)] w-[calc(100%-1.5rem)] max-w-md flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="shrink-0 space-y-1 px-5 pb-2 pt-4 text-left">
          <DialogTitle className="text-[17px] font-semibold tracking-tight">
            {isEditing ? "Edit rule" : "Add new rule"}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-snug">
            {isEditingSynthesis
              ? "Update this rule in your synthesis layer."
              : isEditingModel
                ? "Update this if-then rule on your model."
                : "Attach an if-then rule to a belief on this model."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-3">
          <div className="space-y-2">
            <label htmlFor="model-builder-rule-belief" className="text-[11px] font-medium text-foreground">
              Pick a belief to add a rule to
            </label>
            {beliefsLoading ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading beliefs…
              </div>
            ) : beliefOptions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground rounded-lg border border-dashed border-black/12 dark:border-white/12 px-3 py-2.5">
                Add beliefs to this model first. Use synthesis layer or{" "}
                <span className="font-medium text-foreground">Add new belief</span> above.
              </p>
            ) : (
              <Select value={selectedBeliefKey} onValueChange={setSelectedBeliefKey}>
                <SelectTrigger
                  id="model-builder-rule-belief"
                  className="h-10 text-[13px] rounded-xl border-black/10 dark:border-white/12"
                >
                  <SelectValue placeholder="Pick a belief to add a rule to" />
                </SelectTrigger>
                <SelectContent className="z-[110] max-h-56">
                  {beliefOptions.map((opt) => (
                    <SelectItem key={opt.key} value={opt.key} className="text-[12px]">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!user?.id && beliefOptions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
                  Sign in
                </Link>{" "}
                to link rules to synthesis beliefs.
              </p>
            ) : null}
          </div>

          {selectedBelief && beliefOptions.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-foreground">Current rules for this belief</p>
              {hasExistingRules ? (
                <ul className="max-h-28 space-y-1.5 overflow-y-auto scrollbar-hide">
                  {modelRulesForBelief.map(({ rule, index }) => (
                    <ModelBuilderRuleListItem
                      key={`model-${index}-${rule.if?.slice(0, 8)}`}
                      rule={rule}
                      variant="compact"
                      showMenu
                      onEdit={() => startEditModelRule(index)}
                      onDelete={() => onDelete?.(index)}
                    />
                  ))}
                  {synthesisRulesForBelief.map((r) => (
                    <ModelBuilderRuleListItem
                      key={`syn-${r.id}`}
                      rule={{
                        if: r.trigger_text,
                        then: r.action_text,
                        source: "Synthesis layer",
                      }}
                      variant="compact"
                      showMenu
                      onEdit={() => startEditSynthesisRule(r)}
                      onDelete={() => void handleDeleteSynthesisRule(r.id)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-muted-foreground rounded-lg border border-dashed border-black/12 dark:border-white/12 px-3 py-2.5">
                  No rules for this belief yet. Add your first one below.
                </p>
              )}
            </div>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="model-builder-rule-if" className="text-[11px] font-medium text-foreground">
              If
            </label>
            <Textarea
              id="model-builder-rule-if"
              value={ruleIf}
              onChange={(e) => setRuleIf(e.target.value)}
              rows={2}
              maxLength={280}
              disabled={beliefOptions.length === 0}
              placeholder="When this happens… e.g. “User asks about pricing”"
              className="min-h-[52px] resize-none text-[13px] leading-relaxed"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="model-builder-rule-then" className="text-[11px] font-medium text-foreground">
              Then
            </label>
            <Textarea
              id="model-builder-rule-then"
              value={ruleThen}
              onChange={(e) => setRuleThen(e.target.value)}
              rows={2}
              maxLength={400}
              disabled={beliefOptions.length === 0}
              placeholder="The model must… e.g. “Check the pricing matrix in the vault before answering.”"
              className="min-h-[52px] resize-none text-[13px] leading-relaxed"
            />
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-black/8 bg-black/[0.02] px-5 py-3 dark:border-white/10 dark:bg-white/[0.02] sm:justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Saving…
              </>
            ) : isEditing ? (
              "Save changes"
            ) : (
              "Add rule"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
