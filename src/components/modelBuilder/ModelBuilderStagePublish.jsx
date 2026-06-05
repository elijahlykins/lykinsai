import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { OPEN_SOURCE_MODEL_OPTIONS, TRAINING_MODES } from "@/lib/modelBuilder/draftDefaults";

export default function ModelBuilderStagePublish({
  draft,
  progress,
  canPublish,
  publishing,
  modelLoadDone,
  onDeploy,
  trainingJob,
  loraJob,
}) {
  const baseLabel = OPEN_SOURCE_MODEL_OPTIONS.find((m) => m.id === draft.openSourceModelId)?.label;

  const trainingLabel = TRAINING_MODES.find((m) => m.id === draft.trainingMode)?.label || draft.trainingMode;

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 py-2">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">Review & deploy</h1>
        <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
          Saves your model, publishes it to your account, and selects it in main chat (/app). Only you can
          use this model. You can return and edit the draft later.
        </p>
      </div>

      <div className="rounded-xl border border-black/8 dark:border-white/10 bg-white/60 dark:bg-gray-900/40 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold truncate">{draft.name || "Untitled model"}</p>
            {draft.description?.trim() ? (
              <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">{draft.description}</p>
            ) : null}
          </div>
          <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded shrink-0 bg-gray-500/15 text-muted-foreground">
            {draft.status === "published" ? "Deployed" : "Draft"}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
          <dt className="text-muted-foreground">Base</dt>
          <dd className="font-medium truncate">{baseLabel || "None"}</dd>
          <dt className="text-muted-foreground">Approach</dt>
          <dd className="font-medium">{trainingLabel}</dd>
          <dt className="text-muted-foreground">Beliefs</dt>
          <dd className="font-medium">{draft.beliefs?.length ?? 0}</dd>
          <dt className="text-muted-foreground">Rules</dt>
          <dd className="font-medium">{draft.rules?.length ?? 0}</dd>
          <dt className="text-muted-foreground">JSONL pairs</dt>
          <dd className="font-medium">
            {trainingJob?.status === "ready" ? trainingJob.metadata?.total_pairs ?? "None" : "None"}
          </dd>
          <dt className="text-muted-foreground">LoRA</dt>
          <dd className="font-medium">
            {loraJob?.status === "ready" ? "Ready" : draft.trainingMode === "lora" ? "Not started" : "N/A"}
          </dd>
        </dl>
        <div className="pt-1">
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>Builder progress</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} className="h-1.5 bg-gray-200 dark:bg-gray-700 [&>div]:bg-blue-600" />
        </div>
      </div>

      {!canPublish ? (
        <p className="text-[12px] text-muted-foreground rounded-lg border border-dashed border-black/12 dark:border-white/12 px-3 py-2.5">
          To deploy: sign in, set a real name, and write at least 20 characters in your system prompt (Persona
          step).
        </p>
      ) : null}

      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          type="button"
          className="flex-1"
          onClick={onDeploy}
          disabled={publishing || !canPublish || !modelLoadDone}
        >
          <Sparkles className="h-4 w-4" />
          {publishing ? "Deploying…" : draft.status === "published" ? "Deploy again" : "Deploy to chat"}
        </Button>
        {draft.status === "published" ? (
          <Button type="button" variant="outline" className="flex-1" asChild>
            <Link to="/app">Open chat</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
