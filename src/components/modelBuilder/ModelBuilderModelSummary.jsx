import {
  OPEN_SOURCE_MODEL_OPTIONS,
  STANDARD_MODEL_OPTIONS,
  TRAINING_MODES,
} from "@/lib/modelBuilder/draftDefaults";
import { sanitizeModelCapabilities } from "@/lib/modelBuilder/modelCapabilitiesCatalog";
import { resolveSystemPromptForDraft } from "@/lib/modelBuilder/syncSystemPromptBasics";

const VAULT_MODE_LABELS = {
  off: "No vault files",
  all: "Entire vault",
  tags: "By tag",
  pick: "Selected files",
};

const SYNTHESIS_MODE_LABELS = {
  all: "Full synthesis layer",
  selected: "Selected neurons",
};

function baseModelLabel(draft) {
  if (draft.baseKind === "open_source") {
    return (
      OPEN_SOURCE_MODEL_OPTIONS.find((m) => m.id === draft.openSourceModelId)?.label ||
      draft.openSourceModelId ||
      "None"
    );
  }
  const id = draft.standardModelId || draft.baseModelId;
  return STANDARD_MODEL_OPTIONS.find((m) => m.id === id)?.label || id || "None";
}

function vaultSummary(draft) {
  const mode = draft.vaultKnowledgeMode || "off";
  const label = VAULT_MODE_LABELS[mode] || mode;
  if (mode === "tags") {
    const n = (draft.vaultTags || []).length;
    return n ? `${label} (${n} tag${n === 1 ? "" : "s"})` : label;
  }
  if (mode === "pick") {
    const n = (draft.includedVaultNoteIds || []).length;
    return n ? `${label} (${n} file${n === 1 ? "" : "s"})` : label;
  }
  return label;
}

function synthesisSummary(draft) {
  const mode = draft.synthesisKnowledgeMode || "all";
  const label = SYNTHESIS_MODE_LABELS[mode] || mode;
  if (mode === "selected") {
    const n = (draft.includedSynthesisNeurons || []).length;
    return n ? `${label} (${n})` : label;
  }
  const beliefs = draft.beliefs?.length ?? 0;
  if (beliefs > 0) return `${label} (${beliefs} belief${beliefs === 1 ? "" : "s"})`;
  return label;
}

function promptPreview(draft, maxLen = 220) {
  const text = resolveSystemPromptForDraft(draft).replace(/\s+/g, " ").trim();
  if (!text) return "None";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

export default function ModelBuilderModelSummary({ draft }) {
  const capabilities = sanitizeModelCapabilities(draft.modelCapabilities || []);
  const trainingLabel =
    TRAINING_MODES.find((m) => m.id === draft.trainingMode)?.label || draft.trainingMode || "None";
  const rulesCount = draft.rules?.length ?? 0;

  return (
    <div className="rounded-xl border border-black/8 dark:border-white/10 bg-white/60 dark:bg-gray-900/40 p-4 space-y-4">
      <div className="min-w-0">
        <p className="text-[16px] font-semibold truncate">{draft.name || "Untitled model"}</p>
        {draft.description?.trim() ? (
          <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">{draft.description}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[minmax(0,7.5rem)_1fr] gap-x-3 gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">Engine</dt>
        <dd className="font-medium">{baseModelLabel(draft)}</dd>

        <dt className="text-muted-foreground">Approach</dt>
        <dd className="font-medium">{trainingLabel}</dd>

        <dt className="text-muted-foreground">Synthesis</dt>
        <dd className="font-medium">{synthesisSummary(draft)}</dd>

        <dt className="text-muted-foreground">Project</dt>
        <dd className="font-medium">
          {draft.linkedProjectId ? "Linked" : "None"}
        </dd>

        <dt className="text-muted-foreground">Vault</dt>
        <dd className="font-medium">{vaultSummary(draft)}</dd>

        <dt className="text-muted-foreground">Rules</dt>
        <dd className="font-medium">{rulesCount}</dd>

        <dt className="text-muted-foreground">Tools</dt>
        <dd className="font-medium">
          {capabilities.length
            ? `${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"}`
            : "None"}
        </dd>
      </dl>

      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">System prompt</p>
        <p className="text-[12px] leading-relaxed text-foreground/90 rounded-lg border border-black/6 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2.5">
          {promptPreview(draft)}
        </p>
      </div>
    </div>
  );
}

export function canSaveModelDraft(draft, userId) {
  const name = (draft?.name || "").trim();
  return (
    Boolean(userId) &&
    name.length > 0 &&
    !/^untitled model$/i.test(name) &&
    resolveSystemPromptForDraft(draft).trim().length >= 20
  );
}
