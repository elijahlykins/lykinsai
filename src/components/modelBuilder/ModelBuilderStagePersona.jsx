import { Database, Upload } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { VAULT_SOURCE_OPTIONS } from "@/lib/modelBuilder/draftDefaults";
import ModelBuilderBeliefsSection from "@/components/modelBuilder/ModelBuilderBeliefsSection";
import ModelBuilderRulesSection from "@/components/modelBuilder/ModelBuilderRulesSection";
import ModelBuilderVaultTagsPicker from "@/components/modelBuilder/ModelBuilderVaultTagsPicker";

export default function ModelBuilderStagePersona({ draft, patch }) {
  return (
    <div className="mx-auto w-full max-w-lg space-y-6 py-2">
      <div>
        <h2 className="text-[18px] font-semibold tracking-tight">Persona & data</h2>
        <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
          Shape how your model thinks: beliefs, rules, and what vault data to ground answers in.
        </p>
      </div>

      <ModelBuilderBeliefsSection draft={draft} patch={patch} />

      <ModelBuilderRulesSection draft={draft} patch={patch} />

      <section className="space-y-3">
        <div>
          <Label className="text-[12px]">Vault data</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            What ground-truth data feeds this model.
          </p>
        </div>
        <div className="grid gap-2">
          {VAULT_SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => patch({ vaultSource: opt.id })}
              className={cn(
                "text-left rounded-xl border px-3.5 py-3 text-[12.5px] font-medium transition-colors flex items-center gap-2",
                draft.vaultSource === opt.id
                  ? "border-blue-400/50 bg-blue-500/10"
                  : "border-black/8 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
              )}
            >
              <Database className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
              {opt.label}
            </button>
          ))}
        </div>
        {draft.vaultSource === "tagged" ? (
          <ModelBuilderVaultTagsPicker draft={draft} patch={patch} />
        ) : null}
        <div className="rounded-xl border border-dashed border-black/12 dark:border-white/12 p-4 flex flex-col items-center gap-2 text-center">
          <Upload className="h-5 w-5 text-muted-foreground" />
          <p className="text-[11px] text-muted-foreground">
            Drop a .jsonl or .md export to add one-off training files (coming soon).
          </p>
        </div>
      </section>
    </div>
  );
}
