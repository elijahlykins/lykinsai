import { Database } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  vaultModeToVaultSource,
} from "@/lib/modelBuilder/knowledgeSelection";
import ModelBuilderBeliefsSection from "@/components/modelBuilder/ModelBuilderBeliefsSection";
import ModelBuilderVaultTagsPicker from "@/components/modelBuilder/ModelBuilderVaultTagsPicker";
import ModelBuilderVaultNotesPicker from "@/components/modelBuilder/ModelBuilderVaultNotesPicker";
import ModelBuilderSynthesisNeuronsPicker from "@/components/modelBuilder/ModelBuilderSynthesisNeuronsPicker";
import ModelBuilderProjectSelect from "@/components/modelBuilder/ModelBuilderProjectSelect";

const VAULT_MODES = [
  { id: "off", label: "No vault files", hint: "Synthesis layer only" },
  { id: "all", label: "Entire vault", hint: "All saved notes and files" },
  { id: "tags", label: "By tag", hint: "Notes matching selected tags" },
  { id: "pick", label: "Pick files", hint: "Choose specific vault notes" },
];

const SYNTHESIS_MODES = [
  { id: "all", label: "Full synthesis layer", hint: "Beliefs, facts, rules, and concepts" },
  { id: "selected", label: "Pick neurons", hint: "Choose specific synthesis items" },
];

function modeButtonClass(active) {
  return cn(
    "text-left rounded-xl border px-3.5 py-3 text-[12.5px] transition-colors",
    active
      ? "border-blue-400/50 bg-blue-500/10 font-medium"
      : "border-black/8 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] font-medium",
  );
}

export default function ModelBuilderStageKnowledge({ draft, patch, errors = [], showHeader = true }) {
  const patchKnowledge = (partial) => {
    const next = { ...partial };
    if ("vaultKnowledgeMode" in partial) {
      next.vaultSource = vaultModeToVaultSource(partial.vaultKnowledgeMode);
      if (partial.vaultKnowledgeMode !== "tags") {
        next.vaultTags = [];
      }
      if (partial.vaultKnowledgeMode !== "pick") {
        next.includedVaultNoteIds = [];
      }
    }
    if ("synthesisKnowledgeMode" in partial && partial.synthesisKnowledgeMode === "all") {
      next.includedSynthesisNeurons = [];
    }
    patch(next);
  };

  const vaultMode = draft.vaultKnowledgeMode || "off";
  const synthesisMode = draft.synthesisKnowledgeMode || "all";

  return (
    <div className={showHeader ? "mx-auto w-full max-w-lg space-y-6 py-2" : "space-y-5"}>
      {showHeader ? (
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight">Knowledge base</h2>
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
            Connect a LYKN project, vault files, and synthesis neurons this model should know about.
          </p>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <ul
          className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-900 dark:text-amber-200 space-y-1"
          role="alert"
        >
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      ) : null}

      <ModelBuilderProjectSelect draft={draft} patch={patch} />

      <section className="space-y-3">
        <div>
          <Label className="text-[12px]">Synthesis layer</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            Beliefs, facts, rules, and concepts from your portable memory graph.
          </p>
        </div>
        <div className="grid gap-2">
          {SYNTHESIS_MODES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => patchKnowledge({ synthesisKnowledgeMode: opt.id })}
              className={modeButtonClass(synthesisMode === opt.id)}
            >
              <span className="block">{opt.label}</span>
              <span className="block text-[10px] font-normal text-muted-foreground mt-0.5">
                {opt.hint}
              </span>
            </button>
          ))}
        </div>
        {synthesisMode === "all" ? (
          <ModelBuilderBeliefsSection draft={draft} patch={patch} />
        ) : (
          <ModelBuilderSynthesisNeuronsPicker draft={draft} patch={patch} />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-start gap-2">
          <Database className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <div>
            <Label className="text-[12px]">Vault files</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              Notes, uploads, and saved links that ground answers in your work.
            </p>
          </div>
        </div>
        <div className="grid gap-2">
          {VAULT_MODES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => patchKnowledge({ vaultKnowledgeMode: opt.id })}
              className={modeButtonClass(vaultMode === opt.id)}
            >
              <span className="block">{opt.label}</span>
              <span className="block text-[10px] font-normal text-muted-foreground mt-0.5">
                {opt.hint}
              </span>
            </button>
          ))}
        </div>
        {vaultMode === "tags" ? (
          <ModelBuilderVaultTagsPicker draft={draft} patch={patch} />
        ) : null}
        {vaultMode === "pick" ? (
          <ModelBuilderVaultNotesPicker draft={draft} patch={patch} />
        ) : null}
      </section>
    </div>
  );
}
