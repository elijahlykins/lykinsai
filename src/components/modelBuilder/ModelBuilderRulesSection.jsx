import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { Label } from "@/components/ui/label";
import ModelBuilderAddRuleDialog from "@/components/modelBuilder/ModelBuilderAddRuleDialog";
import ModelBuilderRuleListItem from "@/components/modelBuilder/ModelBuilderRuleListItem";

export default function ModelBuilderRulesSection({ draft, patch }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editIndex, setEditIndex] = useState(null);

  const openAddDialog = useCallback(() => {
    setEditIndex(null);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((index) => {
    setEditIndex(index);
    setDialogOpen(true);
  }, []);

  const handleDialogOpenChange = useCallback((open) => {
    setDialogOpen(open);
    if (!open) setEditIndex(null);
  }, []);

  const saveRule = useCallback(
    (rule, index) => {
      const rules = [...(draft.rules || [])];
      if (index != null && index >= 0 && index < rules.length) {
        rules[index] = rule;
        patch({ rules });
      } else {
        patch({ rules: [...rules, rule] });
      }
    },
    [draft.rules, patch],
  );

  const deleteRule = useCallback(
    (index) => {
      patch({ rules: (draft.rules || []).filter((_, j) => j !== index) });
      if (editIndex === index) {
        setDialogOpen(false);
        setEditIndex(null);
      } else if (editIndex != null && editIndex > index) {
        setEditIndex(editIndex - 1);
      }
    },
    [draft.rules, editIndex, patch],
  );

  return (
    <section className="space-y-4">
      <div>
        <Label className="text-[12px]">Rules</Label>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
          If-then governance without retraining, same style as your synthesis layer.
        </p>
      </div>

      <button
        type="button"
        onClick={openAddDialog}
        className="flex items-center gap-2.5 text-left group"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-black/12 dark:border-white/14 bg-black/[0.02] dark:bg-white/[0.03] group-hover:bg-black/[0.05] dark:group-hover:bg-white/[0.06] transition-colors">
          <Plus className="h-4 w-4 text-foreground" strokeWidth={2} />
        </span>
        <span className="text-[13px] font-medium text-foreground group-hover:text-foreground/90">
          Add new rule
        </span>
      </button>

      <ModelBuilderAddRuleDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        editIndex={editIndex}
        onSave={saveRule}
        onDelete={deleteRule}
        draft={draft}
      />

      {(draft.rules || []).length > 0 ? (
        <ul className="space-y-2">
          {(draft.rules || []).map((r, i) => (
            <ModelBuilderRuleListItem
              key={`${i}-${r.if?.slice(0, 12)}`}
              rule={r}
              showMenu
              onEdit={() => openEditDialog(i)}
              onDelete={() => deleteRule(i)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
